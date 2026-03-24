'use strict';

/**
 * levelWatchEngine.js
 * ─────────────────────────────────────────────────────────────────
 * Level Watch Engine — Phase 1
 *
 * Monitors watch-enabled levels from all sources (MySQL + file-based adapters).
 * On each 1-second tick:
 *   1. Load watchable levels (cached 5s)
 *   2. Group by (symbol, market)
 *   3. Read market data from Redis (price, signal, metrics)
 *   4. Compute per-level watch state (phase, distance, speed, etc.)
 *   5. Evaluate simple events: approaching, touched, crossed
 *   6. Evaluate early warnings (if alertOptions configured)
 *   7. Apply cooldown / fingerprint anti-duplicate
 *   8. Persist events to MySQL level_events
 *   9. Write per-level watch state to Redis
 *  10. Push events to alerts:recent feed
 *  11. Dispatch Telegram if telegram_enabled
 *
 * Phase 2 (future): tactic events, bar-close confirmation, sloped levels
 */

const { createUnifiedWatchLevelsLoader } = require('./unifiedWatchLevelsLoader');

// ─── Constants ────────────────────────────────────────────────────
const ENGINE_INTERVAL_MS     = 1000;
const SUMMARY_LOG_INTERVAL   = 30; // ticks
const WATCHSTATE_TTL_SEC     = 90; // Redis key TTL for levelwatchstate:
const ALERT_RECENT_LIMIT     = 500;
const ALERT_EVENT_TTL_SEC    = 7 * 24 * 60 * 60;

// Cooldowns (seconds) per event type
const COOLDOWNS = {
  approaching_entered:          60,
  precontact_entered:           30,
  contact_hit:                  60,
  crossed_up:                   60,
  crossed_down:                 60,
  early_warning:                90,
  nearby_volume_spike:          90,
  nearby_trades_spike:          90,
  nearby_wall_appeared:         120,
  nearby_wall_strengthened:     120,
  nearby_approach_accelerated:  90,
};

// ── Phase State Machine ───────────────────────────────────────────
// Centralized thresholds — single source of truth for all phase boundaries
const PHASE_APPROACHING_PCT  = 0.5;    // % distance: entering approach zone
const PHASE_PRECONTACT_PCT   = 0.15;   // % distance: close approach
const PHASE_CONTACT_PCT      = 0.05;   // % distance: touching level

// Allowed transitions (state machine guard table)
// Only listed transitions are permitted; others keep current phase
const ALLOWED_TRANSITIONS = {
  watching:    new Set(['approaching']),
  approaching: new Set(['watching', 'precontact']),
  precontact:  new Set(['approaching', 'contact']),
  contact:     new Set(['precontact', 'watching', 'crossed']),
  crossed:     new Set(['watching']),
};

// Which transition key produces a user-facing event type
// contact->crossed is resolved to crossed_up / crossed_down based on price side
const TRANSITION_EVENT = {
  'watching->approaching':   'approaching_entered',
  'approaching->precontact': 'precontact_entered',
  'precontact->contact':     'contact_hit',
};

// Epsilon for speed calculation
const SPEED_EPSILON = 1e-10;

// ─── Sound mapping by event type ─────────────────────────────────
const DEFAULT_SOUND_BY_TYPE = {
  approaching_entered:         'soft_ping',
  precontact_entered:          'soft_ping',
  contact_hit:                 'default_alert',
  crossed_up:                  'breakout_high',
  crossed_down:                'default_alert',
  early_warning:               'soft_ping',
  nearby_volume_spike:         'soft_ping',
  nearby_trades_spike:         'soft_ping',
  nearby_wall_appeared:        'wall_alert',
  nearby_wall_strengthened:    'wall_alert',
  nearby_approach_accelerated: 'soft_ping',
};

const POPUP_PRIORITY_BY_TYPE = {
  approaching_entered:         'normal',
  precontact_entered:          'normal',
  contact_hit:                 'high',
  crossed_up:                  'high',
  crossed_down:                'high',
  early_warning:               'normal',
  nearby_volume_spike:         'low',
  nearby_trades_spike:         'low',
  nearby_wall_appeared:        'normal',
  nearby_wall_strengthened:    'normal',
  nearby_approach_accelerated: 'normal',
};

// ─── Severity ─────────────────────────────────────────────────────
function getSeverity(eventType, distancePct, signalCtx) {
  const { signalConfidence = 0, inPlayScore = 0 } = signalCtx || {};
  switch (eventType) {
    case 'approaching_entered':
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'precontact_entered':
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'contact_hit':
      if (inPlayScore >= 120) return 'high';
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'crossed_up':
    case 'crossed_down':
      return signalConfidence >= 80 ? 'high' : 'medium';
    case 'early_warning':
      return 'medium';
    default:
      return 'low';
  }
}

// ─── Side relative to level ───────────────────────────────────────
function computeSide(currentPrice, levelPrice) {
  const toleranceAbs = levelPrice * (PHASE_CONTACT_PCT / 100);
  if (Math.abs(currentPrice - levelPrice) <= toleranceAbs) return 'at';
  return currentPrice > levelPrice ? 'above' : 'below';
}

// ─── Phase state machine ──────────────────────────────────────────
/**
 * Resolve next phase using strict allowed-transitions table.
 * Prevents chaotic phase jumps — only valid transitions occur.
 * Crossed is only reachable from contact/precontact when price flips side.
 */
function resolvePhase(prevPhase, absDistancePct, sideNow, sidePrev) {
  // Compute candidate phase from distance alone
  let candidate;
  if      (absDistancePct <= PHASE_CONTACT_PCT)      candidate = 'contact';
  else if (absDistancePct <= PHASE_PRECONTACT_PCT)   candidate = 'precontact';
  else if (absDistancePct <= PHASE_APPROACHING_PCT)  candidate = 'approaching';
  else                                                candidate = 'watching';

  // Crossed condition: price flipped side while in contact or precontact
  const sideFlipped = (
    sidePrev != null &&
    sidePrev !== 'at' &&
    sideNow  !== 'at' &&
    sidePrev !== sideNow
  );
  if (sideFlipped && (prevPhase === 'contact' || prevPhase === 'precontact')) {
    candidate = 'crossed';
  }

  if (candidate === prevPhase) return prevPhase;

  const allowed = ALLOWED_TRANSITIONS[prevPhase] ?? new Set(['approaching']);
  return allowed.has(candidate) ? candidate : prevPhase;
}

/**
 * Build a structured transition result.
 * eventType is null for transitions without a user-facing alert.
 */
function buildTransitionResult(prevPhase, nextPhase, sideRelativeToLevel) {
  const changed       = prevPhase !== nextPhase;
  const transitionKey = changed ? `${prevPhase}->${nextPhase}` : null;
  let eventType = null;
  if (changed) {
    if (transitionKey === 'contact->crossed') {
      eventType = sideRelativeToLevel === 'above' ? 'crossed_up' : 'crossed_down';
    } else {
      eventType = TRANSITION_EVENT[transitionKey] ?? null;
    }
  }
  return { prevPhase, nextPhase, changed, transitionKey, eventType, sideRelativeToLevel };
}

// ─── ETA to level ─────────────────────────────────────────────────
function estimateEtaSec(distanceAbs, approachSpeed) {
  if (!approachSpeed || Math.abs(approachSpeed) < SPEED_EPSILON) return null;
  const speed = Math.abs(approachSpeed);
  // approachSpeed is in price/tick (1 tick = 1 second)
  // distanceAbs is in price units
  const etaSec = distanceAbs / speed;
  return Math.round(etaSec);
}

// ─── Fingerprint for anti-duplicate ─────────────────────────────
function buildFingerprint(symbol, market, internalId, eventType, nowMs) {
  const minuteBucket = Math.floor(nowMs / 60000);
  return `${symbol}:${market}:${internalId}:${eventType}:${minuteBucket}`;
}

// ─── Build watch event payload ────────────────────────────────────
function buildWatchEvent(eventType, level, state, opts = {}) {
  const {
    nowMs,
    distancePct,
    currentPrice,
    levelPrice,
    signalContext,
    approachSpeed,
    approachAcceleration,
    volumeDeltaPct,
    tradesDeltaPct,
    wallContext,
    earlyWarning,
    delivery,
    phase,
    severity,
  } = opts;

  const idSuffix = level.levelId !== null ? `L${level.levelId}` : level.externalLevelId || 'ext';
  const id       = `${level.symbol}-${eventType}-${nowMs}-${idSuffix}`;

  const event = {
    id,
    type:                eventType,
    symbol:              level.symbol,
    market:              level.market,
    severity:            severity || getSeverity(eventType, distancePct, signalContext),
    title:               buildTitle(eventType, level.symbol, levelPrice),
    message:             buildMessage(eventType, level.symbol, levelPrice, distancePct),
    createdAt:           nowMs,
    levelId:             level.levelId ?? (level.externalLevelId != null ? parseInt(level.externalLevelId, 10) : null),
    externalLevelId:     level.externalLevelId,
    geometryType:        level.geometryType,
    watchMode:           level.watchMode,
    phase:               phase || null,
    phaseFrom:           opts.phaseFrom || null,
    phaseTo:             opts.phaseTo   || null,
    sideRelativeToLevel: opts.sideRelativeToLevel || null,
    levelPrice:          levelPrice,
    currentPrice:    currentPrice,
    distancePct:     distancePct != null ? parseFloat(distancePct.toFixed(4)) : null,
    approachSpeed:   approachSpeed != null ? parseFloat(approachSpeed.toFixed(8)) : null,
    approachAcceleration: approachAcceleration != null ? parseFloat(approachAcceleration.toFixed(8)) : null,
    signalContext:   signalContext || null,
    wallContext:     wallContext  || null,
    delivery:        delivery || null,
    confirmed:       false,
  };

  if (earlyWarning) event.earlyWarning = earlyWarning;
  if (volumeDeltaPct != null) event.volumeDeltaPct  = parseFloat(volumeDeltaPct.toFixed(4));
  if (tradesDeltaPct != null) event.tradesDeltaPct  = parseFloat(tradesDeltaPct.toFixed(4));

  return event;
}

function buildTitle(eventType, symbol, levelPrice) {
  switch (eventType) {
    case 'approaching_entered':         return `${symbol} approaching level ${levelPrice}`;
    case 'precontact_entered':          return `${symbol} close approach to level ${levelPrice}`;
    case 'contact_hit':                 return `${symbol} touched level ${levelPrice}`;
    case 'crossed_up':                  return `${symbol} crossed level ${levelPrice} upward`;
    case 'crossed_down':                return `${symbol} crossed level ${levelPrice} downward`;
    case 'early_warning':               return `${symbol} early warning near ${levelPrice}`;
    case 'nearby_volume_spike':         return `${symbol} volume spike near level ${levelPrice}`;
    case 'nearby_trades_spike':         return `${symbol} trades spike near level ${levelPrice}`;
    case 'nearby_wall_appeared':        return `${symbol} wall appeared near level ${levelPrice}`;
    case 'nearby_wall_strengthened':    return `${symbol} wall strengthened near level ${levelPrice}`;
    case 'nearby_approach_accelerated': return `${symbol} approach accelerating to level ${levelPrice}`;
    default:                            return `${symbol} ${eventType}`;
  }
}

function buildMessage(eventType, symbol, levelPrice, distancePct) {
  const dist = distancePct != null ? `${Math.abs(distancePct).toFixed(2)}%` : '';
  switch (eventType) {
    case 'approaching_entered': return `${symbol} is approaching level ${levelPrice} (${dist} away).`;
    case 'precontact_entered':  return `${symbol} is in close approach to level ${levelPrice} (${dist} away).`;
    case 'contact_hit':         return `${symbol} touched level ${levelPrice}.`;
    case 'crossed_up':          return `${symbol} crossed level ${levelPrice} upward.`;
    case 'crossed_down':        return `${symbol} crossed level ${levelPrice} downward.`;
    case 'early_warning':       return `Early warning: ${symbol} approaching level ${levelPrice} (${dist} away).`;
    default:                    return `${symbol} triggered ${eventType} near level ${levelPrice}.`;
  }
}

// ─── Delivery config builder ──────────────────────────────────────
function buildDeliveryConfig(eventType, alertOptions, severityOverride) {
  const soundId = alertOptions.soundId || DEFAULT_SOUND_BY_TYPE[eventType] || 'default_alert';
  const popupPriority = alertOptions.popupPriority || POPUP_PRIORITY_BY_TYPE[eventType] || 'normal';
  return {
    popup:         alertOptions.popupEnabled    ?? true,
    telegram:      alertOptions.telegramEnabled ?? false,
    sound:         alertOptions.soundEnabled    ?? true,
    soundId,
    popupPriority,
  };
}

// ─── Engine factory ───────────────────────────────────────────────
function createLevelWatchEngine(redis, db, deliveryService = null) {
  const loader = createUnifiedWatchLevelsLoader(db);

  // In-memory previous prices per (symbol, market)
  const previousPrices = new Map(); // key: `${market}:${symbol}` => price

  // In-memory previous watch states per internalId (for speed/accel/change detection)
  const previousStates = new Map(); // key: internalId => { distancePct, approachSpeed, wallNearby, wallStrength, volumeDeltaPct, tradesDeltaPct, ts }

  let tickCount    = 0;
  let tickRunning  = false;

  // ── Cooldown helpers ────────────────────────────────────────────
  async function isCooldownActive(eventType, market, symbol, internalId) {
    const key = `watchcooldown:${eventType}:${market}:${symbol}:${internalId}`;
    return (await redis.get(key)) !== null;
  }

  async function setCooldown(eventType, market, symbol, internalId, ttlSec) {
    const key = `watchcooldown:${eventType}:${market}:${symbol}:${internalId}`;
    await redis.set(key, '1', 'EX', ttlSec);
  }

  // Check/set anti-duplicate fingerprint (per minute bucket)
  async function checkAndSetFingerprint(symbol, market, internalId, eventType, nowMs) {
    const fp  = buildFingerprint(symbol, market, internalId, eventType, nowMs);
    const key = `watcheventfp:${fp}`;
    const exists = await redis.get(key);
    if (exists) return false; // duplicate
    await redis.set(key, '1', 'EX', 70); // expire slightly after 1 minute window
    return true;
  }

  // ── Persist event to MySQL level_events ─────────────────────────
  async function persistEvent(event, level, state) {
    try {
      const sc = event.signalContext || {};
      const wc = event.wallContext   || {};
      const payload = {
        deliverySnapshot: event.delivery,
        alertOptionsSnapshot: level.alertOptions ? {
          warnBeforeSeconds:     level.alertOptions.warnBeforeSeconds,
          warnBeforeDistancePct: level.alertOptions.warnBeforeDistancePct,
          warnOnVolumeChange:    level.alertOptions.warnOnVolumeChange,
          warnOnWallChange:      level.alertOptions.warnOnWallChange,
        } : null,
        watchMode:   level.watchMode,
        phase:       state.phase,
        volumeDeltaPct:  event.volumeDeltaPct  ?? null,
        tradesDeltaPct:  event.tradesDeltaPct  ?? null,
        earlyWarning:    event.earlyWarning     ?? null,
      };

      // Skip MySQL persist for file-based levels (no levelId)
      if (!level.levelId) return;

      await db.query(`
        INSERT INTO level_events
          (level_id, external_level_id, symbol, market, timeframe, source, geometry_type,
           event_type, phase, level_price, current_price, distance_pct,
           approach_speed, approach_acceleration,
           volume_delta_pct, trades_delta_pct,
           impulse_score, in_play_score, confidence_score,
           wall_nearby, wall_strength, wall_change,
           confirmed, severity, message, payload_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        level.levelId,
        level.externalLevelId,
        event.symbol,
        event.market,
        level.timeframe,
        level.source,
        level.geometryType,
        event.type,
        state.phase  || null,
        event.levelPrice     != null ? event.levelPrice     : null,
        event.currentPrice   != null ? event.currentPrice   : null,
        event.distancePct    != null ? event.distancePct    : null,
        event.approachSpeed  != null ? event.approachSpeed  : null,
        event.approachAcceleration != null ? event.approachAcceleration : null,
        event.volumeDeltaPct != null ? event.volumeDeltaPct : null,
        event.tradesDeltaPct != null ? event.tradesDeltaPct : null,
        sc.impulseScore         ?? null,
        sc.inPlayScore          ?? null,
        sc.signalConfidence     ?? null,
        wc.wallNearby           ? 1 : 0,
        wc.wallStrength         ?? null,
        wc.wallChange           ?? null,
        0, // confirmed=false for Phase 1
        event.severity,
        event.message,
        JSON.stringify(payload),
        event.createdAt,
      ]);
    } catch (err) {
      console.error('[watch-engine] persistEvent error:', err.message);
    }
  }

  // ── Update trigger stats on levels table ─────────────────────────
  async function updateLevelTriggerStats(levelId, nowMs) {
    if (!levelId) return;
    try {
      await db.query(
        'UPDATE levels SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?',
        [nowMs, levelId],
      );
    } catch (_) {}
  }

  // ── Publish event to Redis recent feed ───────────────────────────
  async function publishToRecentFeed(event) {
    const json = JSON.stringify(event);
    const p    = redis.pipeline();
    p.set(`alert:${event.id}`, json, 'EX', ALERT_EVENT_TTL_SEC);
    p.lpush('alerts:recent', json);
    p.ltrim('alerts:recent', 0, ALERT_RECENT_LIMIT - 1);
    await p.exec();
  }

  // ── Evaluate phase transition events ─────────────────────────────
  // Fires at most one event per tick, only on valid phase transitions.
  async function evaluateTransitionEvents(level, state, transition, nowMs) {
    const events = [];
    if (!transition.changed || !transition.eventType) return events;

    const { eventType, prevPhase, nextPhase, sideRelativeToLevel } = transition;
    const ao  = level.alertOptions;
    const { distancePct, currentPrice, wallContext } = state;
    const levelPrice = level.price;

    const signalContext = state.impulseScore != null ? {
      impulseScore:     state.impulseScore,
      impulseDirection: state.impulseDirection ?? 'mixed',
      inPlayScore:      state.inPlayScore      ?? 0,
      signalConfidence: state.signalConfidence ?? 0,
    } : null;

    const onCD  = await isCooldownActive(eventType, level.market, level.symbol, level.internalId);
    const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, eventType, nowMs);
    if (onCD || !notFP) return events;

    const delivery = buildDeliveryConfig(eventType, ao);
    const sev      = getSeverity(eventType, distancePct, signalContext);

    events.push(buildWatchEvent(eventType, level, state, {
      nowMs, distancePct, currentPrice, levelPrice, signalContext,
      approachSpeed:        state.approachSpeed,
      approachAcceleration: state.approachAcceleration,
      wallContext,
      delivery,
      phase:               nextPhase,
      phaseFrom:           prevPhase,
      phaseTo:             nextPhase,
      sideRelativeToLevel,
      severity:            sev,
    }));

    await setCooldown(eventType, level.market, level.symbol, level.internalId, COOLDOWNS[eventType] ?? 60);

    console.log(
      `[watch-engine] transition ${level.symbol} ${level.internalId}` +
      ` ${prevPhase}->${nextPhase} evt=${eventType}` +
      ` price=${currentPrice} level=${levelPrice} dist=${distancePct?.toFixed(3)}%` +
      ` side=${sideRelativeToLevel}`,
    );

    return events;
  }

  // ── Evaluate early warnings ──────────────────────────────────────
  async function evaluateEarlyWarnings(level, state, prevState, signal, metrics, nowMs) {
    const events = [];
    const ao     = level.alertOptions;
    if (!ao || !ao.earlyWarningEnabled) return events;

    const { distancePct, absDistancePct, currentPrice, approaching, approachSpeed, approachAcceleration } = state;
    const levelPrice = level.price;

    // Only evaluate if price is moving toward the level
    if (!approaching && !state.isNearby) return events;

    const signalContext = signal ? {
      impulseScore:     signal.impulseScore     ?? 0,
      impulseDirection: signal.impulseDirection ?? 'mixed',
      inPlayScore:      signal.inPlayScore       ?? 0,
      signalConfidence: signal.signalConfidence  ?? 0,
    } : null;

    // ── ETA-based early warning ──────────────────────────────────
    const warnBefore   = ao.warnBeforeSeconds;
    const warnBeforePct = ao.warnBeforeDistancePct;

    let etaWarningFired = false;

    if (warnBefore || warnBeforePct) {
      let triggerByETA     = false;
      let triggerByDist    = false;
      let etaSec           = null;
      let triggerReason    = null;

      if (warnBefore && approachSpeed && Math.abs(approachSpeed) > SPEED_EPSILON) {
        const distanceAbs = Math.abs(levelPrice - currentPrice);
        etaSec = estimateEtaSec(distanceAbs, approachSpeed);
        if (etaSec !== null && etaSec <= warnBefore && state.movingToward) {
          triggerByETA  = true;
          triggerReason = 'eta_threshold';
        }
      }

      if (warnBeforePct && absDistancePct <= warnBeforePct) {
        triggerByDist = true;
        if (!triggerReason) triggerReason = 'distance_threshold';
      }

      if (triggerByETA || triggerByDist) {
        const onCD  = await isCooldownActive('early_warning', level.market, level.symbol, level.internalId);
        const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'early_warning', nowMs);
        if (!onCD && notFP) {
          const delivery = buildDeliveryConfig('early_warning', ao);
          const earlyWarning = {
            warnBeforeSeconds:      warnBefore    ?? null,
            estimatedTimeToLevelSec: etaSec       ?? null,
            warnBeforeDistancePct:  warnBeforePct ?? null,
            triggerReason,
          };
          events.push(buildWatchEvent('early_warning', level, state, {
            nowMs, distancePct, currentPrice, levelPrice, signalContext,
            approachSpeed, approachAcceleration,
            wallContext: state.wallContext, delivery,
            phase: state.phase, severity: 'medium',
            earlyWarning,
          }));
          await setCooldown('early_warning', level.market, level.symbol, level.internalId, COOLDOWNS.early_warning);
          etaWarningFired = true;
        }
      }
    }

    // ── Change-based events near level ────────────────────────────
    if (!state.isNearby) return events; // rest only within zone

    // Volume spike
    if (ao.warnOnVolumeChange && state.volumeDeltaPct != null) {
      const threshold = ao.minVolumeDeltaPct ?? 20;
      if (state.volumeDeltaPct >= threshold) {
        const onCD  = await isCooldownActive('nearby_volume_spike', level.market, level.symbol, level.internalId);
        const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'nearby_volume_spike', nowMs);
        if (!onCD && notFP) {
          const delivery = buildDeliveryConfig('nearby_volume_spike', ao);
          events.push(buildWatchEvent('nearby_volume_spike', level, state, {
            nowMs, distancePct, currentPrice, levelPrice, signalContext,
            volumeDeltaPct: state.volumeDeltaPct,
            delivery, phase: state.phase, severity: 'low',
          }));
          await setCooldown('nearby_volume_spike', level.market, level.symbol, level.internalId, COOLDOWNS.nearby_volume_spike);
        }
      }
    }

    // Trades spike
    if (ao.warnOnTradesChange && state.tradesDeltaPct != null) {
      const threshold = ao.minTradesDeltaPct ?? 30;
      if (state.tradesDeltaPct >= threshold) {
        const onCD  = await isCooldownActive('nearby_trades_spike', level.market, level.symbol, level.internalId);
        const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'nearby_trades_spike', nowMs);
        if (!onCD && notFP) {
          const delivery = buildDeliveryConfig('nearby_trades_spike', ao);
          events.push(buildWatchEvent('nearby_trades_spike', level, state, {
            nowMs, distancePct, currentPrice, levelPrice, signalContext,
            tradesDeltaPct: state.tradesDeltaPct,
            delivery, phase: state.phase, severity: 'low',
          }));
          await setCooldown('nearby_trades_spike', level.market, level.symbol, level.internalId, COOLDOWNS.nearby_trades_spike);
        }
      }
    }

    // Wall appeared
    if (ao.warnOnWallChange && prevState) {
      const wallNowNearby  = state.wallContext && state.wallContext.wallNearby;
      const wallWasnearby  = prevState.wallNearby;

      if (wallNowNearby && !wallWasnearby) {
        const wallStr = state.wallContext.wallStrength;
        const minWall = ao.minWallStrength ?? 0;
        if (!minWall || (wallStr && wallStr >= minWall)) {
          const onCD  = await isCooldownActive('nearby_wall_appeared', level.market, level.symbol, level.internalId);
          const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'nearby_wall_appeared', nowMs);
          if (!onCD && notFP) {
            const delivery = buildDeliveryConfig('nearby_wall_appeared', ao);
            events.push(buildWatchEvent('nearby_wall_appeared', level, state, {
              nowMs, distancePct, currentPrice, levelPrice, signalContext,
              wallContext: state.wallContext, delivery, phase: state.phase, severity: 'low',
            }));
            await setCooldown('nearby_wall_appeared', level.market, level.symbol, level.internalId, COOLDOWNS.nearby_wall_appeared);
          }
        }
      }

      // Wall strengthened (existing wall grew significantly)
      if (wallNowNearby && wallWasnearby &&
          state.wallContext.wallChange === 'increasing' &&
          state.wallContext.wallStrength > (prevState.wallStrength ?? 0) * 1.2) {
        const onCD  = await isCooldownActive('nearby_wall_strengthened', level.market, level.symbol, level.internalId);
        const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'nearby_wall_strengthened', nowMs);
        if (!onCD && notFP) {
          const delivery = buildDeliveryConfig('nearby_wall_strengthened', ao);
          events.push(buildWatchEvent('nearby_wall_strengthened', level, state, {
            nowMs, distancePct, currentPrice, levelPrice, signalContext,
            wallContext: state.wallContext, delivery, phase: state.phase, severity: 'low',
          }));
          await setCooldown('nearby_wall_strengthened', level.market, level.symbol, level.internalId, COOLDOWNS.nearby_wall_strengthened);
        }
      }
    }

    // Approach acceleration
    if (ao.warnOnApproachSpeedChange && approachAcceleration != null && state.movingToward) {
      const threshold = ao.minApproachSpeed ?? 0;
      if (approachAcceleration > 0.0001 && Math.abs(approachSpeed ?? 0) > threshold) {
        const onCD  = await isCooldownActive('nearby_approach_accelerated', level.market, level.symbol, level.internalId);
        const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'nearby_approach_accelerated', nowMs);
        if (!onCD && notFP) {
          const delivery = buildDeliveryConfig('nearby_approach_accelerated', ao);
          events.push(buildWatchEvent('nearby_approach_accelerated', level, state, {
            nowMs, distancePct, currentPrice, levelPrice, signalContext,
            approachSpeed, approachAcceleration,
            delivery, phase: state.phase, severity: 'low',
          }));
          await setCooldown('nearby_approach_accelerated', level.market, level.symbol, level.internalId, COOLDOWNS.nearby_approach_accelerated);
        }
      }
    }

    return events;
  }

  // ── Compute watch state for one level (state machine) ────────────────
  function computeWatchState(level, currentPrice, prevPrice, signal, metrics, prevState) {
    const levelPrice = level.price;
    if (isNaN(levelPrice) || levelPrice <= 0) return null;

    const distancePct    = ((currentPrice - levelPrice) / levelPrice) * 100;
    const absDistancePct = Math.abs(distancePct);
    const distanceAbs    = Math.abs(currentPrice - levelPrice);

    // Side relative to level (above / below / at)
    const sideNow  = computeSide(currentPrice, levelPrice);
    const sidePrev = prevState?.sideRelativeToLevel ?? null;

    // State machine: resolve next phase from previous phase + distance + side
    const prevPhase = prevState?.phase ?? 'watching';
    const nextPhase = resolvePhase(prevPhase, absDistancePct, sideNow, sidePrev);

    // Phase timing
    const nowTs         = Date.now();
    const phaseChanged  = nextPhase !== prevPhase;
    const phaseEnteredAt  = phaseChanged ? nowTs : (prevState?.phaseEnteredAt ?? nowTs);
    const ticksInPhase    = phaseChanged ? 0 : ((prevState?.ticksInPhase ?? 0) + 1);
    const phaseDurationMs = nowTs - phaseEnteredAt;

    // Build transition result (consumed by evaluateTransitionEvents)
    const transition = buildTransitionResult(prevPhase, nextPhase, sideNow);

    // Derived boolean flags (backward compat for earlyWarnings and external checks)
    const isNearby    = nextPhase === 'approaching' || nextPhase === 'precontact' || nextPhase === 'contact';
    const approaching = isNearby;
    const touched     = nextPhase === 'contact';
    const crossed     = nextPhase === 'crossed';

    // approachSpeed: change in distancePct per second (positive = moving toward level)
    let approachSpeed        = null;
    let approachAcceleration = null;
    let movingToward         = false;

    if (prevState) {
      const prevDistancePct = prevState.distancePct;
      approachSpeed = prevDistancePct - distancePct;
      const prevAbsDist = Math.abs(prevDistancePct);
      if (prevAbsDist > absDistancePct) {
        movingToward  = true;
        approachSpeed = Math.abs(approachSpeed);
      } else {
        approachSpeed = -Math.abs(approachSpeed);
      }
      if (prevState.approachSpeed != null) {
        approachAcceleration = approachSpeed - prevState.approachSpeed;
      }
    }

    // Volume / trades delta from metrics
    let volumeDeltaPct  = null;
    let tradesDeltaPct  = null;
    let volumeNow       = null;
    let tradesNow       = null;

    if (metrics) {
      volumeNow  = metrics.volumeUsdt60s ?? metrics.volume60s ?? null;
      tradesNow  = metrics.tradeCount60s ?? null;
      if (prevState && prevState.volumeNow && volumeNow) {
        volumeDeltaPct = ((volumeNow - prevState.volumeNow) / prevState.volumeNow) * 100;
      }
      if (prevState && prevState.tradesNow && tradesNow) {
        tradesDeltaPct = ((tradesNow - prevState.tradesNow) / prevState.tradesNow) * 100;
      }
    }

    // Signal context
    const signalCtx = signal ? {
      impulseScore:     signal.impulseScore     ?? null,
      impulseDirection: signal.impulseDirection ?? null,
      inPlayScore:      signal.inPlayScore       ?? null,
      signalConfidence: signal.signalConfidence  ?? null,
    } : null;

    const state = {
      internalId:          level.internalId,
      symbol:              level.symbol,
      market:              level.market,
      phase:               nextPhase,
      prevPhase,
      phaseEnteredAt,
      phaseDurationMs,
      ticksInPhase,
      levelPrice,
      currentPrice,
      distancePct:         parseFloat(distancePct.toFixed(6)),
      signedDistancePct:   parseFloat(distancePct.toFixed(6)),
      absDistancePct:      parseFloat(absDistancePct.toFixed(6)),
      distanceAbs,
      sideRelativeToLevel: sideNow,
      priceSide:           sideNow,
      approaching,
      touched,
      crossed,
      isNearby,
      movingToward,
      approachSpeed:       approachSpeed        != null ? parseFloat(approachSpeed.toFixed(8))        : null,
      approachAcceleration: approachAcceleration != null ? parseFloat(approachAcceleration.toFixed(8)) : null,
      volumeNow,
      tradesNow,
      volumeDeltaPct:      volumeDeltaPct != null ? parseFloat(volumeDeltaPct.toFixed(4)) : null,
      tradesDeltaPct:      tradesDeltaPct != null ? parseFloat(tradesDeltaPct.toFixed(4)) : null,
      impulseScore:        signalCtx?.impulseScore      ?? null,
      inPlayScore:         signalCtx?.inPlayScore       ?? null,
      signalConfidence:    signalCtx?.signalConfidence  ?? null,
      impulseDirection:    signalCtx?.impulseDirection  ?? null,
      wallContext: {
        wallNearby:      false,
        wallStrength:    null,
        wallDistancePct: null,
        wallChange:      'unknown',
      },
      breakoutCandidate: false,
      breakoutConfirmed: false,
      bounceCandidate:   false,
      bounceConfirmed:   false,
      fakeoutCandidate:  false,
      fakeoutConfirmed:  false,
      wallBounceCandidate:   false,
      wallBreakoutCandidate: false,
      lastEventType: prevState?.lastEventType ?? null,
      lastEventAt:   prevState?.lastEventAt   ?? null,
      updatedAt:     nowTs,
    };

    return { state, transition };
  }

  // ── Persist watch state to Redis ─────────────────────────────────
  async function persistWatchState(level, state, writePipeline) {
    const key = `levelwatchstate:${level.market}:${level.symbol}:${level.internalId}`;
    writePipeline.setex(key, WATCHSTATE_TTL_SEC, JSON.stringify(state));
  }

  // ── Main tick ─────────────────────────────────────────────────────
  async function tick() {
    tickCount++;
    const logSummary = (tickCount % SUMMARY_LOG_INTERVAL === 0);

    try {
      const levels = await loader.load();
      if (levels.length === 0) {
        if (logSummary) console.log('[watch-engine] No watch-enabled levels');
        return;
      }

      // Group by (symbol, market) to minimize Redis reads
      const groups = new Map(); // key: `${market}:${symbol}` => NormalizedWatchLevel[]
      for (const lvl of levels) {
        const k = `${lvl.market}:${lvl.symbol}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(lvl);
      }

      // Pipeline read: price + signal + metrics per (symbol, market)
      const groupKeys  = [...groups.keys()];
      const pipeline   = redis.pipeline();
      for (const gk of groupKeys) {
        const [market, symbol] = gk.split(':');
        const pfx = market === 'spot' ? 'spot:' : '';
        pipeline.get(`${pfx}price:${symbol}`);
        pipeline.get(`${pfx}signal:${symbol}`);
        pipeline.get(`${pfx}metrics:${symbol}`);
      }
      const results = await pipeline.exec();

      const writePipeline = redis.pipeline();

      let totalEvents    = 0;
      let simpleEvents   = 0;
      let earlyEvents    = 0;
      let storedDB       = 0;
      let telegramSent   = 0;
      let filteredCD     = 0;
      let monitoredLevels = 0;
      let monitoredSymbols = 0;

      const nowMs = Date.now();

      for (let gi = 0; gi < groupKeys.length; gi++) {
        const gk     = groupKeys[gi];
        const lvlArr = groups.get(gk);
        const [market, symbol] = gk.split(':');

        const [, rawPrice]   = results[gi * 3];
        const [, rawSignal]  = results[gi * 3 + 1];
        const [, rawMetrics] = results[gi * 3 + 2];

        if (!rawPrice) {
          previousPrices.delete(gk);
          continue;
        }

        const currentPrice = parseFloat(rawPrice);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        let signal  = null;
        let metrics = null;
        try { if (rawSignal)  signal  = JSON.parse(rawSignal);  } catch (_) {}
        try { if (rawMetrics) metrics = JSON.parse(rawMetrics); } catch (_) {}

        const prevPrice = previousPrices.get(gk) ?? null;
        previousPrices.set(gk, currentPrice);

        monitoredSymbols++;
        monitoredLevels += lvlArr.length;

        for (const level of lvlArr) {
          const prevState = previousStates.get(level.internalId) ?? null;

          // Compute current watch state via state machine
          const computed = computeWatchState(level, currentPrice, prevPrice, signal, metrics, prevState);
          if (!computed) continue;
          const { state, transition } = computed;

          // Store state snapshot for next tick (includes phase for state machine)
          previousStates.set(level.internalId, {
            phase:               state.phase,
            sideRelativeToLevel: state.sideRelativeToLevel,
            phaseEnteredAt:      state.phaseEnteredAt,
            ticksInPhase:        state.ticksInPhase,
            distancePct:         state.distancePct,
            approachSpeed:       state.approachSpeed,
            wallNearby:          state.wallContext.wallNearby,
            wallStrength:        state.wallContext.wallStrength,
            volumeNow:           state.volumeNow,
            tradesNow:           state.tradesNow,
            lastEventType:       state.lastEventType,
            lastEventAt:         state.lastEventAt,
            ts:                  nowMs,
          });

          // Always persist watch state to Redis
          await persistWatchState(level, state, writePipeline);

          // Evaluate events
          const transEvts = await evaluateTransitionEvents(level, state, transition, nowMs);
          const earlyEvts = await evaluateEarlyWarnings(level, state, prevState, signal, metrics, nowMs);
          const allEvents = [...transEvts, ...earlyEvts];

          simpleEvents += transEvts.length;
          earlyEvents  += earlyEvts.length;
          totalEvents  += allEvents.length;

          for (const ev of allEvents) {
            // Persist to MySQL
            await persistEvent(ev, level, state);
            storedDB++;

            // Update level trigger stats (only for MySQL-sourced levels)
            if (level.levelId && transEvts.includes(ev)) {
              await updateLevelTriggerStats(level.levelId, nowMs);
            }

            // Publish to recent feed
            await publishToRecentFeed(ev);

            // Telegram delivery
            const ao = level.alertOptions;
            if (ao && ao.telegramEnabled && deliveryService) {
              const sendTypes = new Set([
                'contact_hit', 'crossed_up', 'crossed_down',
                'early_warning',
              ]);
              if (sendTypes.has(ev.type)) {
                deliveryService.handleAlert(ev).catch(err =>
                  console.error('[watch-engine] telegram delivery error:', err.message),
                );
                telegramSent++;
              }
            }
          }
        }
      }

      await writePipeline.exec();

      if (logSummary) {
        console.log(
          `[watch-engine] activeLevels=${monitoredLevels} symbols=${monitoredSymbols}` +
          ` simple=${simpleEvents} early=${earlyEvents}` +
          ` total=${totalEvents} stored=${storedDB}` +
          ` telegram=${telegramSent} filteredCD=${filteredCD}`,
        );
      }
    } catch (err) {
      console.error('[watch-engine] tick error:', err.message);
    }
  }

  function start() {
    console.log('[watch-engine] Level Watch Engine started (1s interval)');
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try { await tick(); } finally { running = false; }
    }, ENGINE_INTERVAL_MS);
  }

  return { start, loader };
}

module.exports = { createLevelWatchEngine };
