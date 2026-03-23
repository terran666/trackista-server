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
  level_approaching:          60,
  level_touched:              60,
  level_crossed:              60,
  early_warning:              90,
  nearby_volume_spike:        90,
  nearby_trades_spike:        90,
  nearby_wall_appeared:       120,
  nearby_wall_strengthened:   120,
  nearby_approach_accelerated: 90,
};

// Epsilon for speed calculation
const SPEED_EPSILON = 1e-10;

// ─── Sound mapping by event type ─────────────────────────────────
const DEFAULT_SOUND_BY_TYPE = {
  level_approaching:           'soft_ping',
  level_touched:               'default_alert',
  level_crossed:               'default_alert',
  early_warning:               'soft_ping',
  nearby_volume_spike:         'soft_ping',
  nearby_trades_spike:         'soft_ping',
  nearby_wall_appeared:        'wall_alert',
  nearby_wall_strengthened:    'wall_alert',
  nearby_approach_accelerated: 'soft_ping',
};

const POPUP_PRIORITY_BY_TYPE = {
  level_approaching:           'normal',
  level_touched:               'high',
  level_crossed:               'high',
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
    case 'level_approaching':
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'level_touched':
      if (inPlayScore >= 120) return 'high';
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'level_crossed':
      return signalConfidence >= 80 ? 'high' : 'medium';
    case 'early_warning':
      return 'medium';
    default:
      return 'low';
  }
}

// ─── Phase calculation ────────────────────────────────────────────
function calcPhase(state) {
  if (state.touched || state.crossed)   return 'contact';
  if (state.approaching) {
    if (state.absDistancePct < 0.15)    return 'precontact';
    return 'approaching';
  }
  return 'watching';
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
    deliveryConfig,
    phase,
    severity,
  } = opts;

  const idSuffix = level.levelId !== null ? `L${level.levelId}` : level.externalLevelId || 'ext';
  const id       = `${level.symbol}-${eventType}-${nowMs}-${idSuffix}`;

  const event = {
    id,
    type:            eventType,
    symbol:          level.symbol,
    market:          level.market,
    severity:        severity || getSeverity(eventType, distancePct, signalContext),
    title:           buildTitle(eventType, level.symbol, levelPrice),
    message:         buildMessage(eventType, level.symbol, levelPrice, distancePct),
    createdAt:       nowMs,
    levelId:         level.levelId,
    externalLevelId: level.externalLevelId,
    geometryType:    level.geometryType,
    watchMode:       level.watchMode,
    phase:           phase || null,
    levelPrice:      levelPrice,
    currentPrice:    currentPrice,
    distancePct:     distancePct != null ? parseFloat(distancePct.toFixed(4)) : null,
    approachSpeed:   approachSpeed != null ? parseFloat(approachSpeed.toFixed(8)) : null,
    approachAcceleration: approachAcceleration != null ? parseFloat(approachAcceleration.toFixed(8)) : null,
    signalContext:   signalContext || null,
    wallContext:     wallContext  || null,
    delivery:        deliveryConfig || null,
    confirmed:       false,
  };

  if (earlyWarning) event.earlyWarning = earlyWarning;
  if (volumeDeltaPct != null) event.volumeDeltaPct  = parseFloat(volumeDeltaPct.toFixed(4));
  if (tradesDeltaPct != null) event.tradesDeltaPct  = parseFloat(tradesDeltaPct.toFixed(4));

  return event;
}

function buildTitle(eventType, symbol, levelPrice) {
  switch (eventType) {
    case 'level_approaching':           return `${symbol} approaching level ${levelPrice}`;
    case 'level_touched':               return `${symbol} touched level ${levelPrice}`;
    case 'level_crossed':               return `${symbol} crossed level ${levelPrice}`;
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
    case 'level_approaching':  return `${symbol} is approaching level ${levelPrice} (${dist} away).`;
    case 'level_touched':      return `${symbol} touched level ${levelPrice}.`;
    case 'level_crossed':      return `${symbol} crossed level ${levelPrice}.`;
    case 'early_warning':      return `Early warning: ${symbol} approaching level ${levelPrice} (${dist} away).`;
    default:                   return `${symbol} triggered ${eventType} near level ${levelPrice}.`;
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

  // ── Evaluate simple watch events for one level ───────────────────
  async function evaluateSimpleEvents(level, state, prevState, signal, metrics, nowMs) {
    const events = [];

    const { touched, crossed, approaching, distancePct, absDistancePct } = state;
    const { proximityZonePct, touchZonePct, cooldownSec } = level.config;
    const ao  = level.alertOptions;

    const signalContext = signal ? {
      impulseScore:     signal.impulseScore     ?? 0,
      impulseDirection: signal.impulseDirection ?? 'mixed',
      inPlayScore:      signal.inPlayScore      ?? 0,
      signalConfidence: signal.signalConfidence ?? 0,
    } : null;

    const levelPrice   = level.price;
    const currentPrice = state.currentPrice;

    // ── approaching ─────────────────────────────────────────────
    if (approaching) {
      const onCD  = await isCooldownActive('level_approaching', level.market, level.symbol, level.internalId);
      const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'level_approaching', nowMs);
      if (!onCD && notFP) {
        const delivery = buildDeliveryConfig('level_approaching', ao);
        const sev = getSeverity('level_approaching', distancePct, signalContext);
        events.push(buildWatchEvent('level_approaching', level, state, {
          nowMs, distancePct, currentPrice, levelPrice, signalContext,
          approachSpeed: state.approachSpeed, approachAcceleration: state.approachAcceleration,
          wallContext: state.wallContext, delivery, phase: state.phase, severity: sev,
        }));
        await setCooldown('level_approaching', level.market, level.symbol, level.internalId, cooldownSec);
      }
    }

    // ── touched ──────────────────────────────────────────────────
    if (touched) {
      const onCD  = await isCooldownActive('level_touched', level.market, level.symbol, level.internalId);
      const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'level_touched', nowMs);
      if (!onCD && notFP) {
        const delivery = buildDeliveryConfig('level_touched', ao);
        const sev = getSeverity('level_touched', distancePct, signalContext);
        events.push(buildWatchEvent('level_touched', level, state, {
          nowMs, distancePct, currentPrice, levelPrice, signalContext,
          approachSpeed: state.approachSpeed,
          wallContext: state.wallContext, delivery, phase: state.phase, severity: sev,
        }));
        await setCooldown('level_touched', level.market, level.symbol, level.internalId, COOLDOWNS.level_touched);
      }
    }

    // ── crossed ──────────────────────────────────────────────────
    if (crossed) {
      const onCD  = await isCooldownActive('level_crossed', level.market, level.symbol, level.internalId);
      const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'level_crossed', nowMs);
      if (!onCD && notFP) {
        const delivery = buildDeliveryConfig('level_crossed', { ...ao, popupPriority: 'high' });
        const sev = getSeverity('level_crossed', distancePct, signalContext);
        events.push(buildWatchEvent('level_crossed', level, state, {
          nowMs, distancePct, currentPrice, levelPrice, signalContext,
          approachSpeed: state.approachSpeed,
          wallContext: state.wallContext, delivery, phase: state.phase, severity: sev,
        }));
        await setCooldown('level_crossed', level.market, level.symbol, level.internalId, COOLDOWNS.level_crossed);
      }
    }

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

  // ── Compute watch state for one level ────────────────────────────
  function computeWatchState(level, currentPrice, prevPrice, signal, metrics, prevState) {
    const levelPrice = level.price;
    if (isNaN(levelPrice) || levelPrice <= 0) return null;

    const { proximityZonePct, touchZonePct } = level.config;

    const distancePct    = ((currentPrice - levelPrice) / levelPrice) * 100;
    const absDistancePct = Math.abs(distancePct);
    const distanceAbs    = Math.abs(currentPrice - levelPrice);

    let priceSide;
    if      (currentPrice > levelPrice) priceSide = 'above';
    else if (currentPrice < levelPrice) priceSide = 'below';
    else                                priceSide = 'at';

    const approaching  = absDistancePct <= proximityZonePct;
    const touched      = absDistancePct <= touchZonePct;
    const isNearby     = approaching; // nearby = same as approaching zone for now

    // crossed detection
    let crossed = false;
    if (prevPrice !== null && prevPrice !== currentPrice) {
      const prevAbove = prevPrice > levelPrice;
      const currAbove = currentPrice > levelPrice;
      if (prevAbove !== currAbove) crossed = true;
    }

    // approachSpeed: change in distancePct per second (positive = moving toward level)
    let approachSpeed        = null;
    let approachAcceleration = null;
    let movingToward         = false;

    if (prevState) {
      const prevDistancePct = prevState.distancePct;
      // Speed = how much closer we got (positive = approaching)
      approachSpeed = prevDistancePct - distancePct;
      // If level is above current price, moving toward = distancePct trending toward 0 from negative side
      // In absolute terms: moving toward = absDistancePct decreased
      const prevAbsDist = Math.abs(prevDistancePct);
      if (prevAbsDist > absDistancePct) {
        movingToward  = true;
        approachSpeed = Math.abs(approachSpeed); // positive = heading toward level
      } else {
        approachSpeed = -Math.abs(approachSpeed); // negative = moving away
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

    const phase = calcPhase({ approaching, touched, crossed, absDistancePct });

    const state = {
      internalId:          level.internalId,
      symbol:              level.symbol,
      market:              level.market,
      phase,
      levelPrice,
      currentPrice,
      distancePct:         parseFloat(distancePct.toFixed(6)),
      absDistancePct:      parseFloat(absDistancePct.toFixed(6)),
      distanceAbs,
      priceSide,
      approaching,
      touched,
      crossed,
      isNearby,
      movingToward,
      approachSpeed:       approachSpeed != null ? parseFloat(approachSpeed.toFixed(8)) : null,
      approachAcceleration: approachAcceleration != null ? parseFloat(approachAcceleration.toFixed(8)) : null,
      volumeNow,
      tradesNow,
      volumeDeltaPct:      volumeDeltaPct != null ? parseFloat(volumeDeltaPct.toFixed(4)) : null,
      tradesDeltaPct:      tradesDeltaPct != null ? parseFloat(tradesDeltaPct.toFixed(4)) : null,
      impulseScore:        signalCtx?.impulseScore      ?? null,
      inPlayScore:         signalCtx?.inPlayScore       ?? null,
      signalConfidence:    signalCtx?.signalConfidence  ?? null,
      impulseDirection:    signalCtx?.impulseDirection  ?? null,
      // Wall context populated from walls data (Phase 3 placeholder)
      wallContext: {
        wallNearby:     false,
        wallStrength:   null,
        wallDistancePct: null,
        wallChange:     'unknown',
      },
      breakoutCandidate: false,
      breakoutConfirmed: false,
      bounceCandidate:   false,
      bounceConfirmed:   false,
      fakeoutCandidate:  false,
      fakeoutConfirmed:  false,
      wallBounceCandidate:   false,
      wallBreakoutCandidate: false,
      lastEventType: null,
      lastEventAt:   null,
      updatedAt:     Date.now(),
    };

    return state;
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

          // Compute current watch state
          const state = computeWatchState(level, currentPrice, prevPrice, signal, metrics, prevState);
          if (!state) continue;

          // Store partial state snapshot for next tick
          previousStates.set(level.internalId, {
            distancePct:  state.distancePct,
            approachSpeed: state.approachSpeed,
            wallNearby:   state.wallContext.wallNearby,
            wallStrength: state.wallContext.wallStrength,
            volumeNow:    state.volumeNow,
            tradesNow:    state.tradesNow,
            ts:           nowMs,
          });

          // Persist watch state to Redis (only when approaching/active to save writes)
          if (state.approaching || state.touched || state.crossed) {
            await persistWatchState(level, state, writePipeline);
          }

          // Evaluate events
          const simpleEvts  = await evaluateSimpleEvents(level, state, prevState, signal, metrics, nowMs);
          const earlyEvts   = await evaluateEarlyWarnings(level, state, prevState, signal, metrics, nowMs);
          const allEvents   = [...simpleEvts, ...earlyEvts];

          simpleEvents += simpleEvts.length;
          earlyEvents  += earlyEvts.length;
          totalEvents  += allEvents.length;

          for (const ev of allEvents) {
            // Persist to MySQL
            await persistEvent(ev, level, state);
            storedDB++;

            // Update level trigger stats (only for MySQL-sourced levels)
            if (level.levelId && simpleEvts.includes(ev)) {
              await updateLevelTriggerStats(level.levelId, nowMs);
            }

            // Publish to recent feed
            await publishToRecentFeed(ev);

            // Telegram delivery
            const ao = level.alertOptions;
            if (ao && ao.telegramEnabled && deliveryService) {
              const sendTypes = new Set([
                'level_touched', 'level_crossed',
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
