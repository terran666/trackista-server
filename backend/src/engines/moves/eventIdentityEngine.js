'use strict';

/**
 * eventIdentityEngine — pure functions for determining event identity,
 * dominant timeframe, continuation detection, and cross-TF overlap.
 *
 * Consumed by moveDetectionService to enrich events with identity metadata.
 * Does NOT replace moveDetectionEngine — it wraps around it.
 */

const TF_PRIORITY = (process.env.EVENT_DOMINANT_TF_PRIORITY || '1m,3m,5m,15m,30m,1h').split(',');

const CONTINUATION_RETRACEMENT_PCT  = parseFloat(process.env.EVENT_CONTINUATION_RETRACEMENT_PCT || '35');
const REVERSAL_RETRACEMENT_PCT      = parseFloat(process.env.EVENT_REVERSAL_RETRACEMENT_PCT     || '50');
const REARM_COOLDOWN_MS             = parseInt(process.env.EVENT_REARM_COOLDOWN_MS              || '180000', 10);

/**
 * Determine the dominant timeframe given a set of active (non-closed) event timeframes.
 * Dominant = the shortest (fastest) confirmed timeframe where move is still active.
 *
 * @param {string[]} activeTimeframes  — e.g. ['1m','3m','5m']
 * @returns {string}
 */
function getDominantTimeframe(activeTimeframes) {
  if (!activeTimeframes || activeTimeframes.length === 0) return '5m';
  for (const tf of TF_PRIORITY) {
    if (activeTimeframes.includes(tf)) return tf;
  }
  return activeTimeframes[0];
}

/**
 * Determine covered timeframes — a superset of the current move's direction confirmed by
 * multiple TF windows.
 *
 * @param {Map<string, object>} symEvents   — tf → event map for a symbol
 * @param {string}              direction   — 'up' | 'down'
 * @returns {string[]}
 */
function getCoveredTimeframes(symEvents, direction) {
  const covered = [];
  for (const [tf, ev] of symEvents) {
    if (ev.direction === direction && ev.status !== 'closed') covered.push(tf);
  }
  return covered.sort((a, b) =>
    TF_PRIORITY.indexOf(a) - TF_PRIORITY.indexOf(b),
  );
}

/**
 * Determine event identity action for a given new move detection:
 * - 'continuation': update existing event
 * - 'new': start a fresh event
 * - 'reversal': this is a reversal of the existing event
 * - 'skip': signal is too weak / cooldown active
 *
 * @param {object|null} existingEvent
 * @param {number}      currentMovePct   — current absolute move from start price, same direction
 * @param {number}      nowMs
 * @returns {{ action: string, reason: string }}
 */
function resolveEventIdentity(existingEvent, currentMovePct, nowMs) {
  if (!existingEvent) {
    return { action: 'new', reason: 'no_existing_event' };
  }

  const retractPct = existingEvent.extremeMovePct > 0
    ? (existingEvent.extremeMovePct - currentMovePct) / existingEvent.extremeMovePct * 100
    : 0;

  const msSinceClose = existingEvent.endTs ? (nowMs - existingEvent.endTs) : Infinity;

  // Still in cooldown?
  if (existingEvent.status === 'closed' && msSinceClose < REARM_COOLDOWN_MS) {
    return { action: 'skip', reason: 'cooldown_active' };
  }

  if (existingEvent.status === 'closed') {
    return { action: 'new', reason: 'cooldown_expired' };
  }

  if (retractPct < CONTINUATION_RETRACEMENT_PCT) {
    return { action: 'continuation', reason: `retracement_${retractPct.toFixed(1)}pct_below_continuation_threshold` };
  }

  if (retractPct >= REVERSAL_RETRACEMENT_PCT) {
    return { action: 'reversal', reason: `retracement_${retractPct.toFixed(1)}pct_above_reversal_threshold` };
  }

  // Between continuation and reversal thresholds
  return { action: 'continuation', reason: `retracement_${retractPct.toFixed(1)}pct_moderate` };
}

/**
 * Build identity metadata for inclusion in an event object.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.symEvents    — all events for this symbol
 * @param {string}              opts.direction
 * @param {string}              opts.timeframe    — this event's timeframe
 * @param {string}              opts.identityAction
 * @param {string}              opts.identityReason
 * @param {object|null}         opts.parentEvent
 * @returns {object}  — identity fields to merge into the event
 */
function buildEventIdentityMeta({ symEvents, direction, timeframe, identityAction, identityReason, parentEvent }) {
  const covered = getCoveredTimeframes(symEvents, direction);
  const dominant = getDominantTimeframe(covered.length ? covered : [timeframe]);

  return {
    dominantTimeframe   : dominant,
    coveredTimeframes   : covered,
    parentEventId       : parentEvent?.eventId ?? null,
    continuationCount   : identityAction === 'continuation' ? ((parentEvent?.continuationCount ?? 0) + 1) : 0,
    directionFlipCount  : identityAction === 'reversal'     ? ((parentEvent?.directionFlipCount ?? 0) + 1) : 0,
    identityReason      : identityReason,
    rearmAllowedAt      : null, // set when event closes
  };
}

/**
 * Compute identity reason string for display purposes.
 */
function buildIdentityLabel(event) {
  const covered = event.coveredTimeframes || [event.timeframe];
  const dominant = event.dominantTimeframe || event.timeframe;
  if (covered.length > 1) {
    return `multi-tf(${covered.join(',')}) dominant:${dominant}`;
  }
  return `single-tf(${dominant})`;
}

module.exports = {
  getDominantTimeframe,
  getCoveredTimeframes,
  resolveEventIdentity,
  buildEventIdentityMeta,
  buildIdentityLabel,
  CONTINUATION_RETRACEMENT_PCT,
  REVERSAL_RETRACEMENT_PCT,
};
