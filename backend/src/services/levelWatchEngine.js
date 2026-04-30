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

// ── Verbose debug mode ────────────────────────────────────────────
// Enable:  WATCH_DEBUG_VERBOSE=1
// Filter:  WATCH_DEBUG_SYMBOL=BTCUSDT   (optional)
//          WATCH_DEBUG_LEVEL_ID=manual-81  (optional)
const WATCH_DEBUG_VERBOSE  = process.env.WATCH_DEBUG_VERBOSE  === '1';
const WATCH_DEBUG_SYMBOL   = process.env.WATCH_DEBUG_SYMBOL   || null;
const WATCH_DEBUG_LEVEL_ID = process.env.WATCH_DEBUG_LEVEL_ID || null;

/**
 * Returns true when verbose debug logging is enabled AND
 * (if filters are set) the symbol/levelId matches.
 */
function isDebugLevel(symbol, internalId) {
  if (!WATCH_DEBUG_VERBOSE) return false;
  if (WATCH_DEBUG_SYMBOL   && symbol     !== WATCH_DEBUG_SYMBOL)   return false;
  if (WATCH_DEBUG_LEVEL_ID && internalId !== WATCH_DEBUG_LEVEL_ID) return false;
  return true;
}

// ─── Constants ────────────────────────────────────────────────────
const ENGINE_INTERVAL_MS     = 1000;
const SUMMARY_LOG_INTERVAL   = 30; // ticks
const WATCHSTATE_TTL_SEC     = 90; // Redis key TTL for levelwatchstate:
const ALERT_RECENT_LIMIT     = 500;
const ALERT_EVENT_TTL_SEC    = 7 * 24 * 60 * 60;

// Cooldowns (seconds) per event type
const COOLDOWNS = {
  approaching_entered:          20,   // ↓ was 60 — allow re-fire after fast rollback cycles
  precontact_entered:           15,   // ↓ was 30
  contact_hit:                  30,   // ↓ was 60
  crossed_up:                   60,
  crossed_down:                 60,
  early_warning:                90,
  nearby_volume_spike:          90,
  nearby_trades_spike:          90,
  nearby_wall_appeared:         120,
  nearby_wall_strengthened:     120,
  nearby_approach_accelerated:  90,
};

// ── Phase State Machine (Step 4: Hysteresis + Hold Time) ──────────────────────
//
// Each boundary has two thresholds creating a dead zone (enter < exit):
//   enter = price must come this close to enter a deeper phase
//   exit  = price must move this far away to return to shallower phase
// This prevents jitter when price oscillates near a boundary.
const WATCH_ENTER_APPROACHING_PCT = 2.00;   // enter approaching from watching
const WATCH_EXIT_APPROACHING_PCT  = 2.50;   // exit approaching back to watching

const WATCH_ENTER_PRECONTACT_PCT  = 0.15;   // enter precontact from approaching
const WATCH_EXIT_PRECONTACT_PCT   = 0.22;   // exit precontact back to approaching

const WATCH_ENTER_CONTACT_PCT     = 0.05;   // enter contact candidate zone
const WATCH_EXIT_CONTACT_PCT      = 0.10;   // exit contact back to precontact

// Contact confirmation: must stay in contact zone this many consecutive ticks
// 1 tick = contact fires in 1 s; raw layer (rawContactDetected) already fires instantly on tick-0
const WATCH_CONTACT_HOLD_TICKS    = 1;

// Cross confirmation: price must hold past level N ticks at min distance
const WATCH_CROSS_HOLD_TICKS      = 1;
const WATCH_CROSS_CONFIRM_PCT     = 0.03;   // min absDistancePct past level

// ETA smoothing config
const WATCH_ETA_EMA_ALPHA   = 0.10;  // EMA factor: 0.10 = smooth (was 0.30 — too reactive, caused ETA jumps)
const WATCH_MIN_ETA_SPEED   = 0.001; // min smoothed %/tick to compute ETA
const WATCH_MAX_ETA_SECONDS = 900;   // discard ETAs > 15 minutes (was 5 min — too short for slow approaches)
const WATCH_ETA_WINDOW_SIZE = 20;    // rolling median window size for etaSmoothed (20 ticks = 20 s)

// ── Popup lifecycle constants ─────────────────────────────────────
const BLINK_TTL_MS              =  8_000;   // blink active for 8 s after strong event
const POPUP_RECENT_COMPLETED_MS = 300_000;  // 5 min: show 'completed' after crossed/rollback clears
// After price touches a level and pulls back, keep showing 'level_touched' for this long.
// Without this, the popup reverts to 'approaching'/'very_close' and the touch context is lost.
const RECENT_TOUCH_PULLBACK_MS  =  60_000;  // 60 s
const POPUP_PRIORITY_SCORES = {
  crossed:     1000,
  contact:      800,
  pulling_back: 600,
  very_close:   400,
  approaching:  200,
  completed:     50,
  inactive:      10,
};

// Allowed transitions (state machine guard)
// approaching->crossed allowed for fast moves that bypass precontact
// precontact->crossed allowed for fast moves that skip contact confirmation
// watching->crossed allowed for very fast moves that skip the approaching zone entirely
const ALLOWED_TRANSITIONS = {
  watching:    new Set(['approaching', 'crossed']),
  approaching: new Set(['watching', 'precontact', 'crossed']),
  precontact:  new Set(['approaching', 'contact', 'crossed']),
  contact:     new Set(['precontact', 'watching', 'crossed']),
  crossed:     new Set(['watching']),
};

// Transition key → user-facing event type (crossed_up/down resolved separately)
const TRANSITION_EVENT = {
  'watching->approaching':   'approaching_entered',
  'approaching->precontact': 'precontact_entered',
  'precontact->contact':     'contact_hit',
};

// Epsilon for speed calculation
const SPEED_EPSILON = 1e-10;

// ─── Geometry helpers ─────────────────────────────────────────────

/**
 * Hard ceiling on forward extrapolation regardless of drawn span.
 * Prevents arbitrarily long levels from extrapolating indefinitely.
 */
const MAX_SLOPED_FORWARD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days absolute max

/**
 * Linear extrapolation of a sloped level's price at a given timestamp.
 * Forward extrapolation beyond p2 is capped to min(drawnSpan, 7 days).
 * This mirrors what the chart visually displays at the current bar position
 * and prevents stale levels from drifting far from their anchor positions.
 */
function getSlopedLevelValueAtTimestamp(points, nowTs) {
  // Sort ascending by timestamp so p1 is always the earlier anchor
  const [p1, p2] = points[0].timestamp <= points[1].timestamp
    ? [points[0], points[1]]
    : [points[1], points[0]];
  const drawnSpanMs = p2.timestamp - p1.timestamp;
  // Cap forward extrapolation to the drawn span (mirrored past p2), hard-capped at 7 days
  const forwardCapMs = Math.min(drawnSpanMs, MAX_SLOPED_FORWARD_MS);
  const effectiveTs  = Math.min(nowTs, p2.timestamp + forwardCapMs);
  const slope = (p2.value - p1.value) / drawnSpanMs;
  return p1.value + slope * (effectiveTs - p1.timestamp);
}

/**
 * Returns the effective price reference for a level at the current moment.
 * For horizontal levels: level.price.
 * For sloped levels:     linear extrapolation from level.points at nowTs.
 * Returns null if geometry is invalid.
 */
function getLevelPriceRef(level, nowTs) {
  if (level.geometryType === 'sloped') {
    if (!Array.isArray(level.points) || level.points.length < 2) return null;
    const [p1, p2] = level.points;
    if (p1.timestamp === p2.timestamp) return null;
    const price = getSlopedLevelValueAtTimestamp(level.points, nowTs);
    return (price > 0 && isFinite(price)) ? price : null;
  }
  // horizontal (default) — use level.price
  return (level.price != null && !isNaN(level.price) && level.price > 0) ? level.price : null;
}

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

// ─── Popup lifecycle helpers ─────────────────────────────────────

// Compute popup status from phase + rollback + raw signals + completed detection.
// Raw signals (rawContactDetected, crossDetectedRaw) take priority over phase hold confirmation
// so the UI updates immediately on first contact/cross tick, not after HOLD_TICKS delay.
// wickRecent: a wick/probe was detected within BLINK_TTL — keep popup active briefly.
// recentTouchPullback: level was touched within RECENT_TOUCH_PULLBACK_MS but price moved back out.
function computePopupStatus(phase, rollbackAfterAlert, lastStrongEventAt, nowTs, wickRecent, rawContactDetected, crossDetectedRaw, recentTouchPullback) {
  if (rollbackAfterAlert)                                                             return 'pulling_back';
  if (phase === 'crossed')                                                            return 'crossed';
  if (phase === 'contact' || rawContactDetected || wickRecent || recentTouchPullback)  return 'contact';
  if (phase === 'precontact')                                  return 'very_close';
  if (phase === 'approaching')                                 return 'approaching';
  // 'watching' — check if we recently had a strong event
  if (lastStrongEventAt != null && (nowTs - lastStrongEventAt) < POPUP_RECENT_COMPLETED_MS) {
    return 'completed';
  }
  return 'inactive';
}

// Priority score for cross-level ranking (higher = more urgent)
function computePopupPriorityScore(popupStatus, etaSeconds, scenarioLeading) {
  const base       = POPUP_PRIORITY_SCORES[popupStatus] ?? 10;
  const etaBoost   = (etaSeconds != null && etaSeconds > 0) ? Math.max(0, 300 - etaSeconds) : 0;
  const scBoost    = (scenarioLeading === 'breakout' || scenarioLeading === 'bounce') ? 15 : 0;
  return base + etaBoost + scBoost;
}

// Normalize a delta-pct value to [0,100] with 50 = neutral
function normDeltaToPct(deltaPct, range) {
  if (deltaPct == null) return null;
  return Math.max(0, Math.min(100, Math.round(50 + (deltaPct / range) * 50)));
}

// Derive rising/falling/stable trend from delta pct
function deltaTrend(deltaPct, threshold) {
  if (deltaPct == null) return 'stable';
  return deltaPct > threshold ? 'rising' : deltaPct < -threshold ? 'falling' : 'stable';
}

// Map level.source → ТЗ levelSource
const LEVEL_SOURCE_MAP = {
  manual:            'manual',
  extreme:           'extreme',
  vertical_extreme:  'vertical_extreme',
  levels:            'levels',
  sloped:            'sloped',
  auto:              'levels',
  tracked:           'levels',
};

// ─── Side relative to level ───────────────────────────────────────
function computeSide(currentPrice, levelPrice) {
  const toleranceAbs = levelPrice * (WATCH_ENTER_CONTACT_PCT / 100);
  if (Math.abs(currentPrice - levelPrice) <= toleranceAbs) return 'at';
  return currentPrice > levelPrice ? 'above' : 'below';
}

// ─── Phase state machine (Step 4: Hysteresis + Hold Time) ────────
/**
 * Resolve next phase with hysteresis dead zones and hold-time confirmation.
 *
 * Hysteresis: each boundary uses separate enter/exit thresholds.
 * Contact hold: precontact→contact requires WATCH_CONTACT_HOLD_TICKS in zone.
 * Cross hold:   contact/precontact→crossed requires WATCH_CROSS_HOLD_TICKS + confirm distance.
 *
 * ctx fields:
 *   prevPhase, absDistancePct, sideNow, lastNonAtSide,
 *   pendingContactTicks, pendingCrossTicks, pendingCrossDirection
 *
 * Returns:
 *   { nextPhase, prevPhase, changed, transitionKey, eventType, reason,
 *     sideRelativeToLevel, pending: { contactTicks, crossTicks, crossDirection } }
 */
function resolvePhase(ctx) {
  const {
    prevPhase,
    absDistancePct,
    sideNow,
    lastNonAtSide,
    pendingContactTicks   = 0,
    pendingCrossTicks     = 0,
    pendingCrossDirection = null,
  } = ctx;

  let nextPhase = prevPhase;
  let reason    = 'no_change';

  // ── 1. Hysteresis: apply enter/exit thresholds per phase ──────────────────
  if (prevPhase === 'watching') {
    if (absDistancePct <= WATCH_ENTER_APPROACHING_PCT) {
      nextPhase = 'approaching';
      reason    = 'enter_threshold_met';
    }
  } else if (prevPhase === 'approaching') {
    if (absDistancePct <= WATCH_ENTER_PRECONTACT_PCT) {
      nextPhase = 'precontact';
      reason    = 'enter_threshold_met';
    } else if (absDistancePct > WATCH_EXIT_APPROACHING_PCT) {
      nextPhase = 'watching';
      reason    = 'exit_threshold_met';
    }
  } else if (prevPhase === 'precontact') {
    if (absDistancePct > WATCH_EXIT_PRECONTACT_PCT) {
      nextPhase = 'approaching';
      reason    = 'exit_threshold_met';
    }
    // contact entry via hold confirmation below
  } else if (prevPhase === 'contact') {
    if (absDistancePct > WATCH_EXIT_APPROACHING_PCT) {
      nextPhase = 'watching';           // price jumped far away
      reason    = 'exit_threshold_met';
    } else if (absDistancePct > WATCH_EXIT_CONTACT_PCT) {
      nextPhase = 'precontact';
      reason    = 'exit_threshold_met';
    }
    // crossed via hold confirmation below
  } else if (prevPhase === 'crossed') {
    if (absDistancePct > WATCH_EXIT_APPROACHING_PCT) {
      nextPhase = 'watching';
      reason    = 'exit_threshold_met';
    }
  }

  // ── 2. Contact hold confirmation (precontact → contact) ──────────────────
  let newPendingContactTicks = 0;
  if (prevPhase === 'precontact' && absDistancePct <= WATCH_ENTER_CONTACT_PCT) {
    newPendingContactTicks = pendingContactTicks + 1;
    if (newPendingContactTicks >= WATCH_CONTACT_HOLD_TICKS) {
      nextPhase  = 'contact';
      reason     = 'contact_hold_confirmed';
      newPendingContactTicks = 0;       // reset after confirmation
    }
  }

  // ── 3. Cross hold confirmation (approaching / contact / precontact → crossed) ────
  //
  // BUG FIX: lastNonAtSide is updated every tick, so on tick-2 of a pending cross
  // crossedToSide becomes false. We must also continue when price is still on the
  // crossed side (sideNow === pendingCrossDirection) even without a fresh side flip.
  let newPendingCrossTicks    = 0;
  let newPendingCrossDirection = null;
  // Allow cross detection from approaching too (fast moves that skip precontact)
  // Also allow from watching — handles very fast moves that skip the approaching zone entirely
  // (e.g. sloped level sweeping through price, or sudden large candle)
  const canCross       = prevPhase === 'contact' || prevPhase === 'precontact' || prevPhase === 'approaching' || prevPhase === 'watching';
  const crossedToSide  = sideNow !== 'at' && lastNonAtSide != null && sideNow !== lastNonAtSide;
  const crossDistance  = absDistancePct >= WATCH_CROSS_CONFIRM_PCT;

  if (canCross && crossDistance) {
    if (crossedToSide) {
      // First tick: side just flipped → start or restart pending cross
      if (pendingCrossDirection === sideNow) {
        // Same direction as existing pending — accumulate
        newPendingCrossTicks = pendingCrossTicks + 1;
      } else {
        // New direction or fresh start
        newPendingCrossTicks = 1;
      }
      newPendingCrossDirection = sideNow;
    } else if (pendingCrossTicks > 0 && sideNow !== 'at') {
      if (pendingCrossDirection === sideNow) {
        // Continuation: price still on the crossed side (lastNonAtSide already updated)
        // This is the KEY FIX — keep accumulating without requiring crossedToSide again
        newPendingCrossTicks     = pendingCrossTicks + 1;
        newPendingCrossDirection = sideNow;
      }
      // else: price reversed to original side during hold — implicit cancel (stays 0)
    }

    if (newPendingCrossTicks >= WATCH_CROSS_HOLD_TICKS) {
      nextPhase  = 'crossed';
      reason     = 'cross_hold_confirmed';
      newPendingCrossTicks     = 0;
      newPendingCrossDirection = null;
    }
  }

  // ── 4. ALLOWED_TRANSITIONS guard ─────────────────────────────────────────
  if (nextPhase !== prevPhase) {
    const allowed = ALLOWED_TRANSITIONS[prevPhase] ?? new Set();
    if (!allowed.has(nextPhase)) {
      nextPhase = prevPhase;
      reason    = 'transition_not_allowed';
    }
  }

  // ── 5. Build event type for confirmed transition ──────────────────────────
  const changed       = nextPhase !== prevPhase;
  const transitionKey = changed ? `${prevPhase}->${nextPhase}` : null;
  let eventType = null;
  if (changed && transitionKey) {
    if (nextPhase === 'crossed') {
      eventType = sideNow === 'above' ? 'crossed_up' : 'crossed_down';
    } else {
      eventType = TRANSITION_EVENT[transitionKey] ?? null;
    }
  }

  return {
    nextPhase,
    prevPhase,
    changed,
    transitionKey,
    eventType,
    reason,
    sideRelativeToLevel: sideNow,
    crossDetectedRaw:    canCross && crossedToSide,  // raw side flip this tick (no hold required, gated on canCross)
    pending: {
      contactCandidate: newPendingContactTicks > 0,
      contactTicks:     newPendingContactTicks,
      crossCandidate:   newPendingCrossTicks > 0,
      crossTicks:       newPendingCrossTicks,
      crossDirection:   newPendingCrossDirection,
    },
  };
}

// ─── Display context ─────────────────────────────────────────────
// Returns setupDirection / levelRole / distancePctAbs / distancePriceAbs / relativePositionLabel.
// Price above level → level is support (long setup).
// Price below level → level is resistance (short setup).
function computeDisplayContext(sideNow, distancePct, distanceAbs) {
  let relativePositionLabel;
  if      (sideNow === 'above') relativePositionLabel = 'price_above_level';
  else if (sideNow === 'below') relativePositionLabel = 'price_below_level';
  else                          relativePositionLabel = 'at_level';

  let setupDirection;
  let levelRole;
  if (sideNow === 'above') {
    setupDirection = 'long';
    levelRole      = 'support';
  } else if (sideNow === 'below') {
    setupDirection = 'short';
    levelRole      = 'resistance';
  } else {
    setupDirection = 'neutral';
    levelRole      = 'unknown';
  }

  return {
    setupDirection,
    levelRole,
    distancePctAbs:   parseFloat(Math.abs(distancePct).toFixed(6)),
    distancePriceAbs: parseFloat(distanceAbs.toFixed(8)),
    relativePositionLabel,
  };
}

// ─── ETA to level ─────────────────────────────────────────────────
function formatEtaLabel(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

/**
 * Compute ETA using EMA-smoothed approach speed.
 * No phase gate — ETA is computed in any phase as long as speed is sufficient.
 * movingToward is NO LONGER a hard gate — smoothedSpeed already decays naturally
 * when price moves away (EMA α=0.30 → drops below WATCH_MIN_ETA_SPEED in ~4 ticks).
 */
function computeEta(absDistancePct, smoothedSpeed, phase, movingToward) {
  if (!smoothedSpeed || smoothedSpeed < WATCH_MIN_ETA_SPEED) {
    return { etaSeconds: null, etaLabel: '—', etaReason: 'eta_not_available_speed_too_low' };
  }
  const etaSeconds = Math.round(absDistancePct / smoothedSpeed);
  // No upper cap — WATCH_MIN_ETA_SPEED already filters out near-stationary levels.
  // A large ETA (e.g. ~2h) is still useful to show vs a blank "—".
  return { etaSeconds, etaLabel: formatEtaLabel(etaSeconds), etaReason: 'eta_from_approach_speed' };
}

// ─── Approach velocity label ──────────────────────────────────────
function computeApproachVelocityLabel(approachAcceleration) {
  if (approachAcceleration == null)          return 'stable';
  if (approachAcceleration >  0.0001) return 'accelerating';
  if (approachAcceleration < -0.0001) return 'slowing';
  return 'stable';
}

// ─── Scenario score engine ────────────────────────────────────────
/**
 * Score three scenarios: breakout / wick / bounce (0..100 each).
 * Inputs are raw per-level signals — never shared across levels.
 */
function computeScenarioScores(ctx) {
  const {
    phase                = 'watching',
    approachSpeed        = null,
    approachAcceleration = null,
    movingToward         = false,
    impulseScore         = null,
    inPlayScore          = null,
    pendingCross         = false,
    pendingCrossTicks    = 0,
    crossCancelled       = false,  // prev tick had pendingCross, now cancelled
    prevPhaseWasCrossed  = false,  // was crossed last tick, now not → fast return
    wallNearby           = false,  // from prevState (one-tick lag is acceptable)
    wallStrength         = null,
  } = ctx;

  const isNear        = phase === 'approaching' || phase === 'precontact' || phase === 'contact';
  const crossFraction = WATCH_CROSS_HOLD_TICKS > 0
    ? Math.min(1, pendingCrossTicks / WATCH_CROSS_HOLD_TICKS)
    : 0;

  let breakout = 0;
  let wick     = 0;
  let bounce   = 0;
  const rB = [];
  const rW = [];
  const rO = [];

  // ── BREAKOUT signals ────────────────────────────────────────────
  if (approachAcceleration != null && approachAcceleration > 0.0001 && movingToward) {
    breakout += 20; rB.push('approach_accelerating');
  }
  if (impulseScore != null && impulseScore >= 120) {
    breakout += 20; rB.push('high_impulse');
  }
  if (inPlayScore != null && inPlayScore >= 120) {
    breakout += 15; rB.push('high_in_play');
  }
  if (pendingCross && crossFraction >= 0.4) {
    breakout += Math.round(20 * crossFraction);
    rB.push('pending_cross_started');
    if (crossFraction >= 0.8) rB.push('pending_cross_accumulating');
  }
  if (phase === 'crossed') {
    breakout += 30; rB.push('holding_past_level');
  }
  if (wallNearby && wallStrength != null && wallStrength < 0.3) {
    breakout += 10; rB.push('weak_wall');
  }

  // ── WICK signals ────────────────────────────────────────────────
  if (crossCancelled) {
    wick += 35; rW.push('pending_cross_cancelled');
  }
  if (prevPhaseWasCrossed) {
    wick += 40; rW.push('fast_return_after_probe');
  }
  if (pendingCross && crossFraction < 0.4) {
    wick += 15; rW.push('pending_cross_started');
  }
  if ((phase === 'contact' || phase === 'precontact')
      && !movingToward
      && approachAcceleration != null && approachAcceleration < -0.0001) {
    wick += 15; rW.push('strong_reaction_from_level');
  }

  // ── BOUNCE signals ──────────────────────────────────────────────
  if (approachAcceleration != null && approachAcceleration < -0.0001 && movingToward) {
    bounce += 25; rO.push('slowing_into_level');
  }
  if ((phase === 'contact' || phase === 'precontact') && !movingToward) {
    bounce += 25; rO.push('strong_reaction_from_level');
  }
  if (wallNearby && wallStrength != null && wallStrength >= 0.4) {
    bounce += 20; rO.push('nearby_wall_supports_bounce');
  }
  if (!pendingCross && isNear) {
    bounce += 10; rO.push('no_breakout_momentum');
  }
  if (impulseScore != null && impulseScore < 80) {
    bounce += 15; rO.push('low_impulse');
  }
  if (movingToward && approachSpeed != null && Math.abs(approachSpeed) < 0.01) {
    bounce += 10; rO.push('slow_approach');
  }

  // Clamp
  breakout = Math.min(100, Math.max(0, breakout));
  wick     = Math.min(100, Math.max(0, wick));
  bounce   = Math.min(100, Math.max(0, bounce));

  // Leading scenario
  const maxScore = Math.max(breakout, wick, bounce);
  let scenarioLeading;
  if (maxScore < 20) {
    scenarioLeading = 'insufficient_confidence';
  } else {
    const threshold = maxScore * 0.85;
    const leaders   = [];
    if (breakout >= threshold) leaders.push('breakout');
    if (wick     >= threshold) leaders.push('wick');
    if (bounce   >= threshold) leaders.push('bounce');
    scenarioLeading = leaders.length === 1 ? leaders[0] : 'mixed';
  }

  const confidenceLabel =
    scenarioLeading === 'breakout' ? 'breakout_favored' :
    scenarioLeading === 'wick'     ? 'wick_favored'     :
    scenarioLeading === 'bounce'   ? 'bounce_favored'   : 'mixed';

  return {
    scenarioScores:          { breakout, wick, bounce },
    scenarioLeading,
    confidenceLabel,
    scenarioReasonsBreakout: rB,
    scenarioReasonsWick:     rW,
    scenarioReasonsBounce:   rO,
  };
}

// ─── Priority model (low / medium / high / critical) ────────────
function buildPriority(eventType, signalCtx) {
  const { signalConfidence = 0, inPlayScore = 0 } = signalCtx || {};
  switch (eventType) {
    case 'crossed_up':
    case 'crossed_down':
      return signalConfidence >= 80 ? 'critical' : 'high';
    case 'contact_hit':
      if (inPlayScore >= 120) return 'high';
      return signalConfidence >= 80 ? 'medium' : 'low';
    case 'precontact_entered':
    case 'nearby_wall_strengthened':
    case 'early_warning':
      return 'medium';
    default:
      return 'low';
  }
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
    priority,
  } = opts;

  const idSuffix = level.levelId !== null ? `L${level.levelId}` : level.externalLevelId || 'ext';
  const id       = `${level.symbol}-${eventType}-${nowMs}-${idSuffix}`;

  const event = {
    id,
    type:                eventType,
    symbol:              level.symbol,
    market:              level.market,
    timeframe:           level.timeframe || null,
    severity:            severity || getSeverity(eventType, distancePct, signalContext),
    priority:            priority || buildPriority(eventType, signalContext),
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
    distancePct:     distancePct != null ? parseFloat(Math.abs(distancePct).toFixed(4)) : null,
    approachSpeed:   approachSpeed != null ? parseFloat(approachSpeed.toFixed(8)) : null,
    approachAcceleration: approachAcceleration != null ? parseFloat(approachAcceleration.toFixed(8)) : null,
    signalContext:   signalContext || null,
    wallContext:     wallContext  || null,
    delivery:        delivery || null,
    confirmed:       false,
    // Popup lifecycle + sound snapshot
    popupTitleKey:           state.popupTitleKey          ?? 'default_tracking',
    soundPreset:             state.soundPreset             ?? 'standard',
    // Display / scenario snapshot (state at the moment the event fires)
    setupDirection:          state.setupDirection         ?? null,
    levelRole:               state.levelRole              ?? null,
    distancePctAbs:          state.distancePctAbs         ?? null,
    distancePriceAbs:        state.distancePriceAbs       ?? null,
    relativePositionLabel:   state.relativePositionLabel  ?? null,
    etaSeconds:              state.etaSeconds             ?? null,
    etaLabel:                state.etaLabel               ?? '—',
    etaSmoothed:             state.etaSmoothed            ?? null,
    etaSmoothedLabel:        state.etaSmoothedLabel       ?? '—',
    etaProgressPct:          state.etaProgressPct         ?? null,
    approachVelocityLabel:   state.approachVelocityLabel  ?? 'stable',
    distanceProgressPct:     state.distanceProgressPct    ?? 0,
    // Volume / trades snapshot (always present — null when no data)
    volumeDeltaPct:          state.volumeDeltaPct         ?? null,
    volumeValue:             state.volumeValue            ?? null,
    volumePct:               state.volumePct              ?? null,
    volumeTrend:             state.volumeTrend            ?? 'stable',
    // Multi-timeframe volume (null until collector minute buckets warm up)
    volumeUsdt5m:            state.volumeUsdt5m           ?? null,
    volumeUsdt15m:           state.volumeUsdt15m          ?? null,
    volumeUsdt30m:           state.volumeUsdt30m          ?? null,
    volumeUsdt60m:           state.volumeUsdt60m          ?? null,
    volumeByPeriod:          state.volumeByPeriod         ?? {},
    tradesDeltaPct:          state.tradesDeltaPct         ?? null,
    tradeSpeedValue:         state.tradeSpeedValue        ?? null,
    tradeSpeedPct:           state.tradeSpeedPct          ?? null,
    tradeSpeedTrend:         state.tradeSpeedTrend        ?? 'stable',
    // Scenario
    scenarioMode:            state.scenarioMode           ?? 'all_in',
    scenarioScores:          state.scenarioScores         ?? null,
    scenarioLeading:         state.scenarioLeading        ?? null,
    confidenceLabel:         state.confidenceLabel        ?? null,
    // Touch / wick / cross state snapshot
    rollbackAfterAlert:      state.rollbackAfterAlert     ?? false,
    crossStatus:             state.crossStatus            ?? 'none',
    crossDirection:          state.crossDirection         ?? null,
    touchDetected:           state.touchDetected          ?? false,
    touchType:               state.touchType              ?? null,
    lastTouchAt:             state.lastTouchAt            ?? null,
    rawContactDetected:      state.rawContactDetected     ?? false,
    crossDetectedRaw:        state.crossDetectedRaw       ?? false,
    wickDetected:            state.wickDetected           ?? false,
    // Full popup block snapshot (priority/isPrimary filled post-computation — zero at event time)
    popup:                   state.popup                  ?? null,
  };

  if (earlyWarning) event.earlyWarning = earlyWarning;

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
    notification:  alertOptions.notificationEnabled ?? false,
  };
}

// ─── Engine factory ───────────────────────────────────────────────
function createLevelWatchEngine(redis, db, deliveryService = null) {
  const loader = createUnifiedWatchLevelsLoader(db);

  // In-memory previous prices per (symbol, market)
  const previousPrices = new Map(); // key: `${market}:${symbol}` => price

  // In-memory previous watch states per internalId (for speed/accel/change detection)
  const previousStates    = new Map(); // key: internalId => { distancePct, approachSpeed, wallNearby, wallStrength, volumeDeltaPct, tradesDeltaPct, ts }
  // Tracks last event suppression reason per level (cooldown / dedup_fingerprint)
  const suppressedStateMap = new Map(); // key: internalId => { reason, eventType, suppressedAt }

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
    // Sorted set for efficient since-based polling (GET /api/alerts/live?since=<ts>)
    p.zadd('alerts:live', event.createdAt, json);
    p.zremrangebyrank('alerts:live', 0, -(ALERT_RECENT_LIMIT + 1));
    await p.exec();
    console.log(`[alert.published] id=${event.id} type=${event.type} symbol=${event.symbol} priority=${event.priority}`);
  }

  // ── Evaluate phase transition events ─────────────────────────────
  // Fires at most one event per tick, only on valid phase transitions.
  async function evaluateTransitionEvents(level, state, transition, nowMs) {
    const events = [];
    if (!transition.changed || !transition.eventType) return events;

    const { eventType, prevPhase, nextPhase, sideRelativeToLevel, reason } = transition;
    const ao  = level.alertOptions;
    const { distancePct, currentPrice, wallContext } = state;
    const levelPrice = getLevelPriceRef(level, nowMs) ?? level.price;

    const signalContext = state.impulseScore != null ? {
      impulseScore:     state.impulseScore,
      impulseDirection: state.impulseDirection ?? 'mixed',
      inPlayScore:      state.inPlayScore      ?? 0,
      signalConfidence: state.signalConfidence ?? 0,
    } : null;

    // Suppress approach/contact transition alerts during rollback (after level was broken).
    // Still allow crossed_up/crossed_down to fire if price re-crosses.
    if (state.rollbackAfterAlert && eventType !== 'crossed_up' && eventType !== 'crossed_down') {
      console.log(`[watch-engine] event suppressed ${level.symbol} ${level.internalId} evt=${eventType} reason=rollback_after_alert`);
      return events;
    }

    // Batch cooldown check and fingerprint check into a single pipeline read
    const cdKey = `watchcooldown:${eventType}:${level.market}:${level.symbol}:${level.internalId}`;
    const fp    = buildFingerprint(level.symbol, level.market, level.internalId, eventType, nowMs);
    const fpKey = `watcheventfp:${fp}`;
    const [[, cdVal]] = await redis.pipeline().get(cdKey).exec();
    const onCD  = cdVal !== null;
    if (onCD) {
      const suppressReason = 'cooldown';
      suppressedStateMap.set(level.internalId, { reason: suppressReason, eventType, suppressedAt: nowMs });
      console.log(`[watch-engine] event suppressed ${level.symbol} ${level.internalId} evt=${eventType} reason=${suppressReason}`);
      return events;
    }
    // Atomically claim the fingerprint slot — only one concurrent call can win
    const fpSet = await redis.set(fpKey, '1', 'EX', 70, 'NX');
    if (fpSet !== 'OK') {
      // Another concurrent invocation already set this fingerprint this minute
      const suppressReason = 'dedup_fingerprint';
      suppressedStateMap.set(level.internalId, { reason: suppressReason, eventType, suppressedAt: nowMs });
      console.log(`[watch-engine] event suppressed ${level.symbol} ${level.internalId} evt=${eventType} reason=${suppressReason}`);
      return events;
    }

    // Clear previous suppression record — this event will fire cleanly
    suppressedStateMap.delete(level.internalId);

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

    // After a confirmed cross, clear approach/precontact/contact cooldowns AND fingerprints
    // so the NEXT approach cycle (after rollback) fires fresh alerts immediately.
    // Without clearing fingerprints, re-approach within the same clock-minute would be silently
    // blocked even after cooldowns are cleared (fingerprint TTL = 70s, same minuteBucket key).
    if (eventType === 'crossed_up' || eventType === 'crossed_down') {
      const minuteBucket = Math.floor(nowMs / 60000);
      await redis.del(
        `watchcooldown:approaching_entered:${level.market}:${level.symbol}:${level.internalId}`,
        `watchcooldown:precontact_entered:${level.market}:${level.symbol}:${level.internalId}`,
        `watchcooldown:contact_hit:${level.market}:${level.symbol}:${level.internalId}`,
        // Also clear per-minute fingerprints so they don't block same-minute re-approach
        `watcheventfp:${level.symbol}:${level.market}:${level.internalId}:approaching_entered:${minuteBucket}`,
        `watcheventfp:${level.symbol}:${level.market}:${level.internalId}:precontact_entered:${minuteBucket}`,
        `watcheventfp:${level.symbol}:${level.market}:${level.internalId}:contact_hit:${minuteBucket}`,
      );
      console.log(
        `[watch-engine] cooldowns_reset_after_cross ${level.symbol} ${level.internalId}` +
        ` evt=${eventType} minuteBucket=${minuteBucket}`,
      );
    }

    console.log(
      `[watch-engine] transition ${level.symbol} ${level.internalId}` +
      ` ${prevPhase}->${nextPhase} evt=${eventType} reason=${reason}` +
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
    const levelPrice = getLevelPriceRef(level, nowMs) ?? level.price;

    // Only evaluate if price is moving toward the level
    if (!approaching && !state.isNearby) return events;
    // Suppress all early warnings during rollback (level was already broken)
    if (state.rollbackAfterAlert) return events;

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
        // For trigger decision: use the HIGHER of raw speed vs EMA-smoothed speed.
        // EMA can lag badly after periods of sideways/away movement, making the computed
        // ETA artificially large → warning fires only when price is already 5s from level
        // instead of at the configured warnBeforeSeconds.
        const rawSpeed = Math.abs(approachSpeed);
        const smoothedSpeed = state.smoothedApproachSpeed ?? rawSpeed;
        const effectiveSpeed = Math.max(rawSpeed, smoothedSpeed);
        const rawEta = Math.round(absDistancePct / effectiveSpeed);
        etaSec = (isFinite(rawEta) && rawEta >= 0 && rawEta <= WATCH_MAX_ETA_SECONDS) ? rawEta : null;
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

    // ── Periodic "still-in-zone" reminder ────────────────────────
    // Fires when price is in the approaching zone but NOT actively moving toward level
    // (consolidating sideways). Without this, alerts go silent after the initial burst
    // when movingToward=false and warnBeforeDistancePct=null (the default).
    if (!etaWarningFired && state.isNearby) {
      const onCD  = await isCooldownActive('early_warning', level.market, level.symbol, level.internalId);
      const notFP = await checkAndSetFingerprint(level.symbol, level.market, level.internalId, 'early_warning', nowMs);
      if (!onCD && notFP) {
        const delivery = buildDeliveryConfig('early_warning', ao);
        events.push(buildWatchEvent('early_warning', level, state, {
          nowMs, distancePct, currentPrice, levelPrice, signalContext,
          approachSpeed, approachAcceleration,
          wallContext: state.wallContext, delivery,
          phase: state.phase, severity: 'low',
          earlyWarning: {
            warnBeforeSeconds:           null,
            estimatedTimeToLevelSec:     null,
            warnBeforeDistancePct:       null,
            triggerReason:               'still_in_zone',
          },
        }));
        await setCooldown('early_warning', level.market, level.symbol, level.internalId, COOLDOWNS.early_warning);
      }
    }

    // ── Change-based events near level ────────────────────────────
    if (!state.isNearby) return events; // rest only within zone

    // Volume spike
    // volumeDeltaPct = (spikeRatio - 1) * 100, where spikeRatio = currentVol60s / historicalAvg.
    // Default threshold 80 = volume is 80% above average (1.8x). Override via minVolumeDeltaPct.
    if (ao.warnOnVolumeChange && state.volumeDeltaPct != null) {
      const threshold = ao.minVolumeDeltaPct ?? 80;
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
    const nowTs      = Date.now();
    const levelPrice = getLevelPriceRef(level, nowTs);
    if (levelPrice == null) return null;

    const distancePct    = ((currentPrice - levelPrice) / levelPrice) * 100;
    const absDistancePct = Math.abs(distancePct);
    const distanceAbs    = Math.abs(currentPrice - levelPrice);

    // Side relative to level (above / below / at)
    const sideNow = computeSide(currentPrice, levelPrice);
    // lastNonAtSide: last confirmed side that was not 'at' — needed for cross direction detection
    const lastNonAtSide = sideNow !== 'at' ? sideNow : (prevState?.lastNonAtSide ?? null);

    // State machine: resolve next phase with hysteresis + hold confirmation
    const prevPhase  = prevState?.phase ?? 'watching';
    const transition = resolvePhase({
      prevPhase,
      absDistancePct,
      sideNow,
      // FIX: must pass PREVIOUS tick's lastNonAtSide so crossedToSide can detect side flip.
      // Passing current-tick value (sideNow) made crossedToSide always false.
      lastNonAtSide: prevState?.lastNonAtSide ?? null,
      pendingContactTicks:   prevState?.pendingContactTicks   ?? 0,
      pendingCrossTicks:     prevState?.pendingCrossTicks     ?? 0,
      pendingCrossDirection: prevState?.pendingCrossDirection ?? null,
    });
    const nextPhase = transition.nextPhase;

    // ── Raw touch / cross detection (no hold required — for UI / live-card layer) ────────
    // crossDetectedRaw: price flipped sides this tick regardless of phase or hold time.
    // With fixed lastNonAtSide above, resolvePhase.crossDetectedRaw is now correct.
    const crossDetectedRaw  = transition.crossDetectedRaw;
    const lastRawCrossAt    = crossDetectedRaw ? nowTs : (prevState?.lastRawCrossAt ?? null);
    // rawContactDetected: price is within contact zone (sideNow === 'at') — no hold required
    const rawContactDetected = (sideNow === 'at');
    const prevRawContact     = prevState?.rawContactDetected ?? false;
    const rawContactEntered  = rawContactDetected && !prevRawContact;
    const lastRawContactAt   = rawContactEntered  ? nowTs
                             : rawContactDetected ? (prevState?.lastRawContactAt ?? nowTs) : null;
    const crossConfirmed     = nextPhase === 'crossed';

    // Phase timing
    const phaseChanged    = transition.changed;
    const phaseEnteredAt  = phaseChanged ? nowTs : (prevState?.phaseEnteredAt ?? nowTs);
    const ticksInPhase    = phaseChanged ? 0 : ((prevState?.ticksInPhase ?? 0) + 1);
    const phaseDurationMs = nowTs - phaseEnteredAt;

    // Verbose per-tick debug log (only when WATCH_DEBUG_VERBOSE=1 and filter matches)
    const dbgEnabled = isDebugLevel(level.symbol, level.internalId);
    if (dbgEnabled) {
      console.log(
        `[watch-engine:v] ${level.symbol} ${level.internalId}` +
        ` phase=${prevPhase}->${nextPhase} dist=${distancePct.toFixed(4)}%` +
        ` abs=${absDistancePct.toFixed(4)}% side=${sideNow} lastNonAt=${lastNonAtSide}` +
        ` pendingC=${transition.pending.contactTicks}/${WATCH_CONTACT_HOLD_TICKS}` +
        ` pendingX=${transition.pending.crossTicks}/${WATCH_CROSS_HOLD_TICKS}` +
        ` dir=${transition.pending.crossDirection ?? '-'}` +
        ` reason=${transition.reason}`,
      );
    }

    // Pending contact lifecycle logs
    const prevPending = prevState?.pending ?? {};
    if (transition.reason === 'contact_hold_confirmed') {
      console.log(`[watch-engine] contact confirmed ${level.symbol} ${level.internalId} dist=${absDistancePct.toFixed(3)}%`);
    } else if (transition.pending.contactCandidate && !prevPending.contactCandidate) {
      console.log(`[watch-engine] pending contact started ${level.symbol} ${level.internalId} dist=${absDistancePct.toFixed(3)}%`);
    } else if (prevPending.contactCandidate && !transition.pending.contactCandidate) {
      console.log(`[watch-engine] pending contact cancelled ${level.symbol} ${level.internalId}`);
    }

    // Pending cross lifecycle logs
    if (transition.reason === 'cross_hold_confirmed') {
      console.log(`[watch-engine] cross confirmed ${level.symbol} ${level.internalId} dir=${sideNow} dist=${absDistancePct.toFixed(3)}%`);
    } else if (transition.pending.crossCandidate && !prevPending.crossCandidate) {
      console.log(`[watch-engine] pending cross started ${level.symbol} ${level.internalId} dir=${transition.pending.crossDirection} dist=${absDistancePct.toFixed(3)}%`);
    } else if (prevPending.crossCandidate && !transition.pending.crossCandidate) {
      console.log(`[watch-engine] pending cross cancelled ${level.symbol} ${level.internalId}`);
    }

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

    // EMA-smoothed approach speed for stable ETA (EMA-decays toward 0 when moving away)
    const rawSpeedForEma    = (movingToward && approachSpeed != null) ? Math.abs(approachSpeed) : 0;
    const prevSmoothed      = prevState?.smoothedApproachSpeed ?? rawSpeedForEma;
    const smoothedApproachSpeed = movingToward
      ? parseFloat((WATCH_ETA_EMA_ALPHA * rawSpeedForEma + (1 - WATCH_ETA_EMA_ALPHA) * prevSmoothed).toFixed(8))
      : parseFloat(((1 - WATCH_ETA_EMA_ALPHA) * prevSmoothed).toFixed(8)); // EMA decay, not hard-reset

    // Volume / trades delta from metrics
    let volumeDeltaPct  = null;
    let tradesDeltaPct  = null;
    let volumeNow       = null;
    let tradesNow       = null;

    if (metrics) {
      volumeNow  = metrics.volumeUsdt60s ?? metrics.volume60s ?? null;
      tradesNow  = metrics.tradeCount60s ?? null;
      if (prevState && prevState.tradesNow && tradesNow) {
        tradesDeltaPct = ((tradesNow - prevState.tradesNow) / prevState.tradesNow) * 100;
      }
    }

    // Volume spike: use signal's spike ratio (current vs historical avg) for
    // meaningful spike detection. spikeRatio 2.0 = double average = +100%.
    // Falls back to tick-over-tick delta if signal isn't warmed yet.
    if (signal && signal.baselineReady && signal.volumeSpikeRatio60s != null) {
      volumeDeltaPct = parseFloat(((signal.volumeSpikeRatio60s - 1) * 100).toFixed(2));
    } else if (metrics && prevState?.volumeNow && volumeNow) {
      volumeDeltaPct = ((volumeNow - prevState.volumeNow) / prevState.volumeNow) * 100;
    }

    // Signal context
    const signalCtx = signal ? {
      impulseScore:     signal.impulseScore     ?? null,
      impulseDirection: signal.impulseDirection ?? null,
      inPlayScore:      signal.inPlayScore       ?? null,
      signalConfidence: signal.signalConfidence  ?? null,
    } : null;

    // ── Display context ────────────────────────────────────────────
    const displayCtx = computeDisplayContext(sideNow, distancePct, distanceAbs);

    // ── ETA to level ───────────────────────────────────────────────
    // Prefer smoothed EMA speed for stable ETA. However when EMA hasn't built up
    // yet (e.g. after a period of moving away, EMA decays near 0) but price IS
    // actively approaching, use raw * 0.5 as a floor so ETA appears immediately.
    // raw * 0.5 dampens single-tick spikes enough to avoid wild jumps, while
    // still providing a meaningful estimate before the EMA catches up.
    const etaSpeedForDisplay = (
      movingToward &&
      smoothedApproachSpeed < WATCH_MIN_ETA_SPEED &&
      rawSpeedForEma >= WATCH_MIN_ETA_SPEED
    ) ? rawSpeedForEma * 0.5 : smoothedApproachSpeed;
    const etaResult = computeEta(absDistancePct, etaSpeedForDisplay, nextPhase, movingToward);

    // ── Rolling-median ETA for popup display ──────────────────────
    // Build a sliding window of the last WATCH_ETA_WINDOW_SIZE valid etaSeconds values.
    // When ETA is unavailable (—) the window is unchanged — we don't decay it,
    // since the level might still be approaching but speed is momentarily low.
    const prevEtaWindow = prevState?.etaWindow ?? [];
    const etaWindow = etaResult.etaSeconds != null
      ? [...prevEtaWindow.slice(-(WATCH_ETA_WINDOW_SIZE - 1)), etaResult.etaSeconds]
      : prevEtaWindow.slice(-WATCH_ETA_WINDOW_SIZE);
    let etaSmoothed = null;
    let etaSmoothedLabel = '—';
    if (etaWindow.length >= 3) {
      const sorted = [...etaWindow].sort((a, b) => a - b);
      etaSmoothed = sorted[Math.floor(sorted.length / 2)];
      etaSmoothedLabel = formatEtaLabel(etaSmoothed);
    }

    if (isDebugLevel(level.symbol, level.internalId) && etaResult.etaReason === 'eta_from_approach_speed') {
      console.log(
        `[watch-engine:eta] ${level.symbol} ${level.internalId}` +
        ` smoothedSpeed=${smoothedApproachSpeed.toFixed(5)} dist=${absDistancePct.toFixed(4)}%` +
        ` eta=${etaResult.etaSeconds}s (${etaResult.etaLabel})`,
      );
    }
    // Log ETA transitions: available ↔ unavailable (not gated by debug mode)
    const prevEtaAvail = prevState ? (prevState.etaSeconds != null) : null;
    const currEtaAvail = etaResult.etaSeconds != null;
    if (prevState && prevEtaAvail !== currEtaAvail) {
      if (currEtaAvail) {
        console.log(
          `[watch-engine] eta_available ${level.symbol} ${level.internalId}` +
          ` eta=${etaResult.etaSeconds}s dist=${absDistancePct.toFixed(3)}%`,
        );
      } else {
        console.log(
          `[watch-engine] eta_unavailable ${level.symbol} ${level.internalId}` +
          ` reason=${etaResult.etaReason} phase=${nextPhase}`,
        );
      }
    }

    // ── Approach velocity label ────────────────────────────────────
    const approachVelocityLabel = computeApproachVelocityLabel(approachAcceleration);

    // ── Scenario scores (level-specific, never shared) ─────────────
    const prevCrossActive     = prevState?.pending?.crossCandidate ?? false;
    const crossCancelled      = prevCrossActive && !transition.pending.crossCandidate;
    const prevPhaseWasCrossed = (prevState?.phase === 'crossed') && (nextPhase !== 'crossed');
    const scenarioResult = computeScenarioScores({
      phase:               nextPhase,
      approachSpeed,
      approachAcceleration,
      movingToward,
      impulseScore:        signalCtx?.impulseScore  ?? null,
      inPlayScore:         signalCtx?.inPlayScore   ?? null,
      pendingCross:        transition.pending.crossTicks > 0,
      pendingCrossTicks:   transition.pending.crossTicks,
      crossCancelled,
      prevPhaseWasCrossed,
      wallNearby:          prevState?.wallNearby   ?? false,
      wallStrength:        prevState?.wallStrength ?? null,
    });
    if (isDebugLevel(level.symbol, level.internalId)) {
      const sc = scenarioResult.scenarioScores;
      console.log(
        `[watch-engine:scenario] ${level.symbol} ${level.internalId}` +
        ` breakout=${sc.breakout} wick=${sc.wick} bounce=${sc.bounce}` +
        ` leading=${scenarioResult.scenarioLeading} eta=${etaResult.etaLabel}` +
        ` dir=${displayCtx.setupDirection} role=${displayCtx.levelRole}`,
      );
    }

    // ── Popup lifecycle ────────────────────────────────────────────
    // lastStrongEventType: raw signals fire FIRST (before confirmed hold)
    let newStrongEventType = null;
    if (crossDetectedRaw) {
      // Raw side flip → strongest immediate signal, don't wait for hold
      newStrongEventType = sideNow === 'below' ? 'crossed_down' : 'crossed_up';
    } else if (nextPhase === 'crossed' && prevPhase !== 'crossed') {
      // Confirmed held cross (may follow raw cross by 1-2 ticks)
      newStrongEventType = sideNow === 'below' ? 'crossed_down' : 'crossed_up';
    } else if (rawContactEntered && prevPhase !== 'crossed') {
      // First tick entering contact zone (raw, no hold required)
      // Guard: don't overwrite crossed_up/crossed_down with contact_hit while already in crossed phase
      newStrongEventType = 'contact_hit';
    } else if (nextPhase === 'contact' && prevPhase !== 'contact' && prevPhase !== 'crossed') {
      // Confirmed held contact — don't fire if coming from crossed phase
      newStrongEventType = 'contact_hit';
    }
    const lastStrongEventType = newStrongEventType ?? (prevState?.lastStrongEventType ?? null);
    const lastStrongEventAt   = newStrongEventType   ? nowTs : (prevState?.lastStrongEventAt ?? null);

    // rollbackAfterAlert: crossed phase exited — suppress re-approach alerts until a NEW cross fires.
    // Only clears when nextPhase === 'crossed' (price actually re-crosses in either direction).
    // Previously cleared on dist > 2.5%, but that caused re-approach alerts after a break.
    const wasJustCrossed     = prevState?.phase === 'crossed';
    const retractedFromCross = wasJustCrossed && nextPhase !== 'crossed';
    const rollbackAfterAlert =
      retractedFromCross ||
      (prevState?.rollbackAfterAlert === true && nextPhase !== 'crossed');

    // ── Touch / wick / probe detection ───────────────────────────────────────
    // contactEntered: first tick in contact zone (raw or confirmed phase)
    const contactEntered = (nextPhase === 'contact') && (prevPhase !== 'contact');
    const lastTouchAt    = (contactEntered || rawContactEntered) ? nowTs : (prevState?.lastTouchAt ?? null);

    // wickDetected: a pending cross was started last tick but cancelled this tick
    // (price probed/wicked through level without holding)
    const wickDetected   = crossCancelled;
    const lastWickAt     = wickDetected ? nowTs : (prevState?.lastWickAt ?? null);
    // Direction the attempted cross was heading (from previous tick's pendingCrossDirection)
    const probeDirection = wickDetected
      ? (prevState?.pendingCrossDirection ?? null)
      : (prevState?.probeDirection ?? null);
    // wickRecent: wick happened within BLINK_TTL — keeps popup alive and visible briefly
    const wickRecent     = (lastWickAt != null) && (nowTs - lastWickAt) < BLINK_TTL_MS;

    // crossStatus / crossDirection — full lifecycle of cross attempt
    // Priority: confirmed > raw > pending > cancelled > rollback
    let crossStatus    = 'none';
    let crossDirection = null;
    if (nextPhase === 'crossed') {
      crossStatus    = 'confirmed';
      crossDirection = sideNow === 'below' ? 'down' : 'up';
    } else if (crossDetectedRaw) {
      crossStatus    = 'raw';   // side flip detected, hold confirmation not yet met
      crossDirection = sideNow === 'below' ? 'down' : 'up';
    } else if (transition.pending.crossTicks > 0) {
      crossStatus    = 'pending';
      crossDirection = transition.pending.crossDirection === 'below' ? 'down'
                     : transition.pending.crossDirection === 'above' ? 'up' : null;
    } else if (crossCancelled) {
      crossStatus    = 'cancelled';
      crossDirection = probeDirection === 'below' ? 'down'
                     : probeDirection === 'above' ? 'up' : null;
    } else if (rollbackAfterAlert) {
      crossStatus    = 'confirmed'; // was confirmed, now pulling back
      crossDirection = lastStrongEventType === 'crossed_down' ? 'down'
                     : lastStrongEventType === 'crossed_up'   ? 'up' : null;
    }

    // recentTouchPullback: level was touched within RECENT_TOUCH_PULLBACK_MS but price has pulled back.
    // Prevents popupTitleKey / popup.status reverting to 'approaching'/'very_close' after a touch,
    // which made the live-card silently lose the 'level_touched' state.
    const recentTouchPullback =
      !rollbackAfterAlert && !crossDetectedRaw && !rawContactDetected && !wickRecent &&
      nextPhase !== 'contact' && nextPhase !== 'crossed' &&
      lastStrongEventType === 'contact_hit' &&
      lastStrongEventAt != null &&
      (nowTs - lastStrongEventAt) < RECENT_TOUCH_PULLBACK_MS;

    // touchType / touchDetected — raw signals take priority over confirmed phase
    let touchType = null;
    if (nextPhase === 'crossed' || crossDetectedRaw || rollbackAfterAlert) {
      touchType = 'cross';
    } else if (nextPhase === 'contact' || rawContactDetected || recentTouchPullback) {
      touchType = 'contact';
    } else if (wickRecent) {
      touchType = 'wick';
    }
    const touchDetected = touchType !== null;

    // scenarioTrend: compare current leading to previous
    const prevScenarioLeading = prevState?.scenarioLeading ?? null;
    const prevScenarioScores  = prevState?.scenarioScores  ?? null;
    let scenarioTrend = 'stable';
    if (prevScenarioLeading && prevScenarioLeading !== scenarioResult.scenarioLeading) {
      scenarioTrend = 'changed';
    } else if (prevScenarioScores) {
      const bDiff = scenarioResult.scenarioScores.breakout - (prevScenarioScores.breakout ?? 0);
      const boBncDiff = Math.max(
        scenarioResult.scenarioScores.bounce   - (prevScenarioScores.bounce   ?? 0),
        scenarioResult.scenarioScores.wick     - (prevScenarioScores.wick     ?? 0),
      );
      if      (bDiff   >  5) scenarioTrend = 'rising';
      else if (boBncDiff > 5) scenarioTrend = 'falling';
    }

    // popupTitleKey — raw signals take priority over confirmed phase (UI should not wait for hold)
    let popupTitleKey = 'default_tracking';
    if (rollbackAfterAlert) {
      popupTitleKey = 'level_pulling_back';
    } else if (crossDetectedRaw || nextPhase === 'crossed') {
      popupTitleKey = 'level_broken';
    } else if (rawContactDetected || nextPhase === 'contact' || wickRecent || recentTouchPullback) {
      popupTitleKey = 'level_touched';
    } else if (nextPhase === 'precontact') {
      popupTitleKey = 'very_close';
    } else if (nextPhase === 'approaching') {
      popupTitleKey = 'approaching';
    }

    // Popup lifecycle debug logs
    const prevPopupTitleKey = prevState?.popupTitleKey ?? 'default_tracking';
    if (popupTitleKey !== prevPopupTitleKey) {
      console.log(
        `[watch-engine] popup_title_changed ${level.symbol} ${level.internalId}` +
        ` ${prevPopupTitleKey}->${popupTitleKey} phase=${nextPhase}` +
        ` scenario=${scenarioResult.scenarioLeading}`,
      );
    }
    if (rollbackAfterAlert && !prevState?.rollbackAfterAlert) {
      console.log(
        `[watch-engine] rollback_after_alert_detected ${level.symbol} ${level.internalId}` +
        ` lastStrong=${lastStrongEventType} scenario=${scenarioResult.scenarioLeading}`,
      );
    }
    if (prevState && rollbackAfterAlert === false && prevState.rollbackAfterAlert === true) {
      console.log(
        `[watch-engine] rollback_cleared ${level.symbol} ${level.internalId}` +
        ` phase=${nextPhase} dist=${absDistancePct.toFixed(3)}%`,
      );
    }

    // Touch / wick / cross detection logs
    if (contactEntered) {
      console.log(
        `[watch-engine] level_touch_detected ${level.symbol} ${level.internalId}` +
        ` price=${currentPrice} level=${levelPrice} dist=${absDistancePct.toFixed(3)}%`,
      );
    }
    if (wickDetected) {
      console.log(
        `[watch-engine] level_probe_detected ${level.symbol} ${level.internalId}` +
        ` dir=${crossDirection ?? probeDirection ?? 'unknown'} phase=${nextPhase}` +
        ` dist=${absDistancePct.toFixed(3)}%`,
      );
    }
    if (nextPhase === 'crossed' && prevPhase !== 'crossed') {
      console.log(
        `[watch-engine] level_cross_detected ${level.symbol} ${level.internalId}` +
        ` dir=${crossDirection} price=${currentPrice} level=${levelPrice}` +
        ` dist=${absDistancePct.toFixed(3)}%`,
      );
    }
    // Raw touch / raw cross logs (fires before hold confirmation)
    if (crossDetectedRaw) {
      console.log(
        `[watch-engine] level_raw_cross_detected ${level.symbol} ${level.internalId}` +
        ` dir=${sideNow === 'below' ? 'down' : 'up'} phase=${prevPhase}->${nextPhase}` +
        ` price=${currentPrice} level=${levelPrice} dist=${absDistancePct.toFixed(3)}%`,
      );
    }
    if (rawContactEntered && prevPhase !== 'crossed' && nextPhase !== 'crossed') {
      console.log(
        `[watch-engine] level_raw_contact_detected ${level.symbol} ${level.internalId}` +
        ` price=${currentPrice} level=${levelPrice} dist=${absDistancePct.toFixed(4)}%`,
      );
    }

    // scenarioLeading change log
    if (prevScenarioLeading && scenarioResult.scenarioLeading !== prevScenarioLeading) {
      console.log(
        `[watch-engine] scenario_leading_changed ${level.symbol} ${level.internalId}` +
        ` ${prevScenarioLeading}->${scenarioResult.scenarioLeading}` +
        ` phase=${nextPhase} scores=${JSON.stringify(scenarioResult.scenarioScores)}`,
      );
    }

    // scenarioTrend change log
    if (prevState && scenarioTrend !== 'stable') {
      console.log(
        `[watch-engine] scenario_trend ${level.symbol} ${level.internalId}` +
        ` trend=${scenarioTrend} leading=${scenarioResult.scenarioLeading}` +
        ` breakout=${scenarioResult.scenarioScores.breakout}` +
        ` bounce=${scenarioResult.scenarioScores.bounce}` +
        ` wick=${scenarioResult.scenarioScores.wick}`,
      );
    }

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
      transitionReason:       transition.reason,
      lastNonAtSide,
      pendingContact:         transition.pending.contactTicks > 0,
      pendingContactTicks:    transition.pending.contactTicks,
      pendingCross:           transition.pending.crossTicks   > 0,
      pendingCrossTicks:      transition.pending.crossTicks,
      pendingCrossDirection:  transition.pending.crossDirection,
      // Touch / wick / probe / cross state
      touchDetected,
      touchType,
      lastTouchAt,
      rawContactDetected,
      lastRawContactAt,
      crossDetectedRaw,
      crossConfirmed,
      lastRawCrossAt,
      wickDetected,
      lastWickAt,
      probeDirection,
      crossStatus,
      crossDirection,
      // One-tick delay: reads suppression from previous tick's outcome
      lastEventSuppressedReason: prevState?.lastEventSuppressedReason ?? null,
      // ── Display model ─────────────────────────────────────────────
      setupDirection:        displayCtx.setupDirection,
      levelRole:             displayCtx.levelRole,
      distancePctAbs:        displayCtx.distancePctAbs,
      distancePriceAbs:      displayCtx.distancePriceAbs,
      relativePositionLabel: displayCtx.relativePositionLabel,
      // ── ETA ────────────────────────────────────────────────────────
      etaSeconds:            etaResult.etaSeconds,
      etaLabel:              etaResult.etaLabel,
      etaSmoothed,
      etaSmoothedLabel,
      etaWindow,
      smoothedApproachSpeed,
      approachVelocityLabel,
      // ── Popup lifecycle fields ───────────────────────────────────────────
      popupTitleKey,
      rollbackAfterAlert,
      lastStrongEventType,
      lastStrongEventAt,
      scenarioTrend,
      // Sound config (from level alertOptions, read-only here)
      soundPreset:             level.alertOptions?.soundPreset ?? 'standard',
      soundEnabled:            level.alertOptions?.soundEnabled ?? true,
      popupEnabled:            level.alertOptions?.popupEnabled ?? true,
      badgeEnabled:            level.alertOptions?.badgeEnabled ?? true,
      // ── Scenario engine ────────────────────────────────────────────
      scenarioMode:            level.scenarioMode    ?? 'all_in',
      scenarioScores:          scenarioResult.scenarioScores,
      scenarioLeading:         scenarioResult.scenarioLeading,
      confidenceLabel:         scenarioResult.confidenceLabel,
      scenarioReasonsBreakout: scenarioResult.scenarioReasonsBreakout,
      scenarioReasonsWick:     scenarioResult.scenarioReasonsWick,
      scenarioReasonsBounce:   scenarioResult.scenarioReasonsBounce,
      updatedAt:               nowTs,
    };

    // ── Popup block ────────────────────────────────────────────────
    // Priority/isPrimary/isSecondary are filled by assignPopupPriorities() in the tick loop.
    const popupStatus = computePopupStatus(nextPhase, rollbackAfterAlert, lastStrongEventAt, nowTs, wickRecent, rawContactDetected, crossDetectedRaw, recentTouchPullback);
    const popupActive = popupStatus !== 'inactive';
    state.popup = {
      active:       popupActive,
      status:       popupStatus,
      titleKey:     popupTitleKey,
      priority:     0,       // filled post-computation
      isPrimary:    false,   // filled post-computation
      isSecondary:  false,   // filled post-computation
      isCompleted:  popupStatus === 'completed',
      // blink: fires on raw contact/cross entry and lasts BLINK_TTL_MS
      blink:        ((lastStrongEventAt != null) && (nowTs - lastStrongEventAt) < BLINK_TTL_MS) ||
                    ((lastRawContactAt  != null) && (nowTs - lastRawContactAt)  < BLINK_TTL_MS) ||
                    ((lastRawCrossAt    != null) && (nowTs - lastRawCrossAt)    < BLINK_TTL_MS) ||
                    wickRecent,
      levelSource:  LEVEL_SOURCE_MAP[level.source] || 'manual',
      displayScope: level.alertOptions?.displayScope || 'tab',
      // Touch / wick / cross state (all layers)
      touchDetected,
      touchType,
      lastTouchAt,
      rawContactDetected,
      lastRawContactAt,
      crossDetectedRaw,
      crossConfirmed,
      lastRawCrossAt,
      wickDetected,
      lastWickAt,
      probeDirection,
      crossStatus,
      crossDirection,
      lastSuppressedReason: prevState?.lastEventSuppressedReason ?? null,
    };

    // ── Extended metrics for progress bars ────────────────────────
    // Distance progress: 100 = at level, 0 = far away
    const distanceProgressPct = absDistancePct >= WATCH_EXIT_APPROACHING_PCT
      ? 0
      : Math.round((1 - absDistancePct / WATCH_EXIT_APPROACHING_PCT) * 100);

    // ETA progress: 100 = imminent (0 s), 0 = far away (300+ s)
    const etaProgressPct = (etaResult.etaSeconds != null && etaResult.etaSeconds > 0)
      ? Math.max(0, Math.min(100, Math.round((1 - etaResult.etaSeconds / WATCH_MAX_ETA_SECONDS) * 100)))
      : null;

    state.distanceProgressPct = distanceProgressPct;
    state.etaProgressPct      = etaProgressPct;

    // Volume / trades normalised to [0,100] centred at 50 (neutral delta)
    // Range ±30% delta maps to 0/100
    state.volumeValue   = volumeNow;
    state.volumePct     = normDeltaToPct(state.volumeDeltaPct, 30);
    state.volumeTrend   = deltaTrend(state.volumeDeltaPct, 3);

    // Multi-timeframe volume (from minute buckets in collector — null until warmed up)
    state.volumeUsdt5m  = metrics?.volumeUsdt5m  ?? null;
    state.volumeUsdt15m = metrics?.volumeUsdt15m ?? null;
    state.volumeUsdt30m = metrics?.volumeUsdt30m ?? null;
    state.volumeUsdt60m = metrics?.volumeUsdt60m ?? null;
    // volumeByPeriod — ready-made object expected by frontend period switcher
    state.volumeByPeriod = {
      '1m':  volumeNow,
      '5m':  state.volumeUsdt5m,
      '15m': state.volumeUsdt15m,
      '30m': state.volumeUsdt30m,
      '1h':  state.volumeUsdt60m,
    };

    state.tradeSpeedValue = tradesNow;
    state.tradeSpeedPct   = normDeltaToPct(state.tradesDeltaPct, 30);
    state.tradeSpeedTrend = deltaTrend(state.tradesDeltaPct, 3);

    // ── Sloped-level debug fields ─────────────────────────────────
    // rayPriceAtBar = levelPrice рассчитанный по линейной формуле на текущем тике.
    // barTimestamp  = nowTs (real-time engine, не привязан к открытию бара).
    if (level.geometryType === 'sloped') {
      state.rayPriceAtBar = levelPrice;
      state.barTimestamp  = nowTs;
    }

    return { state, transition };
  }

  // ── Assign popup priorities across levels in the same (symbol, market) group ─
  function assignPopupPriorities(groupComputed) {
    if (groupComputed.length === 0) return;

    // Sort by priority score descending
    const scored = groupComputed.map(({ level, state, transition }) => ({
      level, state, transition,
      score: computePopupPriorityScore(
        state.popup.status,
        state.etaSeconds,
        state.scenarioLeading,
      ),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Assign priority rank + primary/secondary flags
    for (let i = 0; i < scored.length; i++) {
      const popup  = scored[i].state.popup;
      popup.priority    = i + 1;
      popup.isPrimary   = (i === 0) && popup.active;
      popup.isSecondary = (i  >  0) && popup.active;
    }

    // Log primary change vs previous tick
    for (const { state } of scored) {
      if (state.popup.isPrimary) {
        console.log(
          `[watch-engine] popup_primary ${state.symbol} ${state.internalId}` +
          ` status=${state.popup.status} priority=${state.popup.priority}` +
          ` source=${state.popup.levelSource} scope=${state.popup.displayScope}`,
        );
        break; // only log the primary
      }
    }
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

        let [, rawPrice]     = results[gi * 3];
        const [, rawSignal]  = results[gi * 3 + 1];
        const [, rawMetrics] = results[gi * 3 + 2];

        if (!rawPrice && market !== 'spot') {
          // Fallback 1: use spot price when futures price key is missing
          rawPrice = await redis.get(`spot:price:${symbol}`);
        }
        if (!rawPrice && market !== 'spot') {
          // Fallback 2: use 1m kline close price (populated by REST fallback poller)
          try {
            const rawK = await redis.get(`kline:futures:${symbol}:1m:last`);
            if (rawK) {
              const kd = JSON.parse(rawK);
              const age = Date.now() - (kd.E || 0);
              if (age < 240_000 && kd.k?.c) {
                rawPrice = String(kd.k.c);
              }
            }
          } catch (_) {}
        }
        if (!rawPrice && market !== 'spot') {
          // Fallback 3: use futures orderbook mid-price (accepts up to 5min stale)
          try {
            const rawOb = await redis.get(`futures:orderbook:${symbol}`);
            if (rawOb) {
              const ob = JSON.parse(rawOb);
              const age = Date.now() - (ob.updatedAt || 0);
              if (age < 300_000 && ob.midPrice > 0) {
                rawPrice = String(ob.midPrice);
              }
            }
          } catch (_) {}
        }
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

        // ── Phase 1: compute all states for the group ──────────────
        const groupComputed = [];
        for (const level of lvlArr) {
          const prevState = previousStates.get(level.internalId) ?? null;
          const computed  = computeWatchState(level, currentPrice, prevPrice, signal, metrics, prevState);
          if (!computed) continue;
          const { state, transition } = computed;

          // Store state snapshot for next tick
          previousStates.set(level.internalId, {
            phase:                 state.phase,
            sideRelativeToLevel:   state.sideRelativeToLevel,
            lastNonAtSide:         state.lastNonAtSide,
            phaseEnteredAt:        state.phaseEnteredAt,
            ticksInPhase:          state.ticksInPhase,
            distancePct:           state.distancePct,
            approachSpeed:         state.approachSpeed,
            smoothedApproachSpeed: state.smoothedApproachSpeed,
            etaWindow:             state.etaWindow,
            wallNearby:            state.wallContext.wallNearby,
            wallStrength:          state.wallContext.wallStrength,
            volumeNow:             state.volumeNow,
            tradesNow:             state.tradesNow,
            lastEventType:         state.lastEventType,
            lastEventAt:           state.lastEventAt,
            pendingContactTicks:   state.pendingContactTicks,
            pendingCrossTicks:     state.pendingCrossTicks,
            pendingCrossDirection: state.pendingCrossDirection,
            pending:               transition.pending,
            lastStrongEventType:   state.lastStrongEventType,
            lastStrongEventAt:     state.lastStrongEventAt,
            rollbackAfterAlert:    state.rollbackAfterAlert,
            popupTitleKey:         state.popupTitleKey,
            scenarioLeading:       state.scenarioLeading,
            scenarioScores:        state.scenarioScores,
            lastEventSuppressedReason: suppressedStateMap.get(level.internalId)?.reason ?? null,
            lastTouchAt:           state.lastTouchAt,
            wickDetected:          state.wickDetected,
            lastWickAt:            state.lastWickAt,
            probeDirection:        state.probeDirection,
            crossStatus:           state.crossStatus,
            crossDirection:        state.crossDirection,
            rawContactDetected:    state.rawContactDetected,
            lastRawContactAt:      state.lastRawContactAt,
            lastRawCrossAt:        state.lastRawCrossAt,
            ts:                    nowMs,
          });

          groupComputed.push({ level, state, transition, prevState });
        }

        // ── Phase 2: assign cross-level popup priorities ───────────
        assignPopupPriorities(groupComputed);

        // ── Phase 3: persist states and fire events ────────────────
        for (const { level, state, transition, prevState } of groupComputed) {
          // Always persist watch state to Redis
          await persistWatchState(level, state, writePipeline);

          // Evaluate events
          const transEvts = await evaluateTransitionEvents(level, state, transition, nowMs);
          const earlyEvts = await evaluateEarlyWarnings(level, state, prevState, signal, metrics, nowMs);
          const allEvents = [...transEvts, ...earlyEvts];

          // Count events suppressed by cooldown or fingerprint dedup
          if (transition.changed && transition.eventType && transEvts.length === 0) filteredCD++;

          simpleEvents += transEvts.length;
          earlyEvents  += earlyEvts.length;
          totalEvents  += allEvents.length;

          for (const ev of allEvents) {
            // Persist to MySQL — fire-and-forget (non-blocking) to avoid stalling the tick
            persistEvent(ev, level, state).then(() => { storedDB++; }).catch(err =>
              console.error('[watch-engine] persistEvent error (async):', err.message),
            );

            // Update level trigger stats (only for MySQL-sourced levels)
            if (level.levelId && transEvts.includes(ev)) {
              updateLevelTriggerStats(level.levelId, nowMs).catch(() => {});
            }

            // Publish to recent feed
            await publishToRecentFeed(ev);
            console.log(
              `[watch-engine] event published ${level.symbol} ${level.internalId}` +
              ` id=${ev.id} evt=${ev.type}`,
            );

            // Alert delivery (Telegram + Web Push).
            // NOT gated on telegramEnabled — handleAlert() checks ev.delivery.telegram
            // internally and sends web push regardless of telegram flag.
            if (deliveryService) {
              const deliveryTypes = new Set([
                'approaching_entered', 'precontact_entered',
                'contact_hit', 'crossed_up', 'crossed_down',
                'early_warning',
              ]);
              if (deliveryTypes.has(ev.type)) {
                deliveryService.handleAlert(ev).catch(err =>
                  console.error('[watch-engine] delivery error:', err.message),
                );
                if (ev.delivery?.telegram) telegramSent++;
              }
            }
          }
        }
      }

      await writePipeline.exec();

      // GC: remove state for levels that are no longer in the active watch list.
      // Prevents unbounded growth of previousStates and suppressedStateMap when
      // levels are deleted or watch is disabled.
      const activeIds = new Set(levels.map(l => l.internalId));
      for (const id of previousStates.keys())     { if (!activeIds.has(id)) previousStates.delete(id); }
      for (const id of suppressedStateMap.keys()) { if (!activeIds.has(id)) suppressedStateMap.delete(id); }

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

// Exported ONLY for unit tests — do not use in production code.
module.exports._testing = {
  computeSide,
  resolvePhase,
  computePopupStatus,
  computeScenarioScores,
  normDeltaToPct,
  deltaTrend,
  // Geometry helpers
  getSlopedLevelValueAtTimestamp,
  getLevelPriceRef,
  // Constants
  WATCH_ENTER_APPROACHING_PCT,
  WATCH_EXIT_APPROACHING_PCT,
  WATCH_ENTER_PRECONTACT_PCT,
  WATCH_EXIT_PRECONTACT_PCT,
  WATCH_ENTER_CONTACT_PCT,
  WATCH_EXIT_CONTACT_PCT,
  WATCH_CONTACT_HOLD_TICKS,
  WATCH_CROSS_HOLD_TICKS,
  WATCH_CROSS_CONFIRM_PCT,
  POPUP_RECENT_COMPLETED_MS,
  BLINK_TTL_MS,
  RECENT_TOUCH_PULLBACK_MS,
};
