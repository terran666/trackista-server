'use strict';

/**
 * moveDetectionEngine — pure functions for detecting price moves.
 * No side-effects, no I/O. Consumed by moveDetectionService.
 */

// Per-timeframe thresholds for declaring a move event (env-overridable %)
const WINDOW_CONFIGS = [
  { label: '1m',  secs: 60,   threshold: parseFloat(process.env.MOVE_THRESHOLD_1M  || '1.5')  },
  { label: '3m',  secs: 180,  threshold: parseFloat(process.env.MOVE_THRESHOLD_3M  || '2.0')  },
  { label: '5m',  secs: 300,  threshold: parseFloat(process.env.MOVE_THRESHOLD_5M  || '2.5')  },
  { label: '15m', secs: 900,  threshold: parseFloat(process.env.MOVE_THRESHOLD_15M || '4.0')  },
  { label: '30m', secs: 1800, threshold: parseFloat(process.env.MOVE_THRESHOLD_30M || '5.0')  },
  { label: '1h',  secs: 3600, threshold: parseFloat(process.env.MOVE_THRESHOLD_1H  || '7.0')  },
];

const MAX_PRICE_HISTORY_MS        = 65 * 60 * 1000; // 65 min ring buffer
const MIN_HISTORY_FILL_RATIO      = 0.80;           // need 80% of window covered
const EVENT_CLOSE_NO_EXTREME_MS   = parseInt(process.env.EVENT_CLOSE_NO_EXTREME_MS   || '600000', 10); // 10 min
const RETRACEMENT_REVERSED_PCT    = parseFloat(process.env.RETRACEMENT_REVERSED_PCT  || '50');  // 50%
const RETRACEMENT_CLOSED_PCT      = parseFloat(process.env.RETRACEMENT_CLOSED_PCT    || '75');  // 75%
const EVENT_COOLDOWN_MS           = parseInt(process.env.EVENT_COOLDOWN_MS            || '120000', 10); // 2 min after close

/**
 * Binary-search the price history for the entry whose ts is nearest to
 * (and at or before) targetTs. Returns null if not found or too stale.
 *
 * @param {Array<{ts:number,price:number}>} history  — sorted ascending by ts
 * @param {number} targetTs
 * @param {number} toleranceMs  — max age gap allowed beyond targetTs
 */
function getPriceAtTarget(history, targetTs, toleranceMs) {
  let lo = 0, hi = history.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].ts <= targetTs) {
      best = history[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) return null;
  // Must be within tolerance of target
  if ((targetTs - best.ts) > toleranceMs) return null;
  return best;
}

/**
 * Compute price change percentage for a given window.
 *
 * @param {Array<{ts:number,price:number}>} history
 * @param {number} windowSecs
 * @param {number} currentPrice
 * @param {number} nowMs
 * @returns {{ movePct:number, startPrice:number, startTs:number } | null}
 */
function computePriceChange(history, windowSecs, currentPrice, nowMs) {
  if (!history || history.length < 2) return null;

  const windowMs  = windowSecs * 1000;
  const neededMs  = windowMs * MIN_HISTORY_FILL_RATIO;

  // Oldest entry must be old enough to cover the required window
  if (nowMs - history[0].ts < neededMs) return null;

  const targetTs     = nowMs - windowMs;
  const toleranceMs  = windowMs * 0.15; // allow 15% slack on age
  const past         = getPriceAtTarget(history, targetTs, toleranceMs);
  if (!past || past.price <= 0) return null;

  const movePct = (currentPrice - past.price) / past.price * 100;
  return { movePct, startPrice: past.price, startTs: past.ts };
}

/**
 * Update an existing active event with the current price.
 * Mutates `event` in-place; returns change flags.
 *
 * @param {object} event
 * @param {number} currentPrice
 * @param {number} nowMs
 * @returns {{ statusChanged:boolean, needsDbUpdate:boolean }}
 */
function updateExistingEvent(event, currentPrice, nowMs) {
  const prevStatus = event.status;
  let needsDbUpdate = false;

  // Incremental move from the original start price
  const currentMovePct = event.direction === 'up'
    ? (currentPrice - event.startPrice) / event.startPrice * 100
    : (event.startPrice - currentPrice) / event.startPrice * 100;

  event.currentPrice   = currentPrice;
  event.currentMovePct = currentMovePct;
  event.lastUpdateTs   = nowMs;

  // New extreme?
  if (currentMovePct > event.extremeMovePct) {
    event.extremeMovePct    = currentMovePct;
    event.extremePrice      = currentPrice;
    event.extremeTs         = nowMs;
    event.lastExtremeMoveTs = nowMs;
    // Upgrade to 'extended' once move exceeds 1.2× the alert threshold
    if (event.status === 'active' && currentMovePct > event.alertThresholdPct * 1.2) {
      event.status = 'extended';
    }
    needsDbUpdate = true;
  }

  // Retracement from peak
  const retracementPct = event.extremeMovePct > 0
    ? (event.extremeMovePct - currentMovePct) / event.extremeMovePct * 100
    : 0;
  event.retracementPct = retracementPct;

  // Reversal?
  if (retracementPct >= RETRACEMENT_REVERSED_PCT && event.status !== 'reversed' && event.status !== 'closed') {
    event.status = 'reversed';
    needsDbUpdate = true;
  }

  // Closure?
  const msSinceExtreme = nowMs - event.lastExtremeMoveTs;
  if (
    (event.status === 'reversed' && retracementPct >= RETRACEMENT_CLOSED_PCT) ||
    msSinceExtreme >= EVENT_CLOSE_NO_EXTREME_MS
  ) {
    event.status    = 'closed';
    event.endTs     = nowMs;
    event.endPrice  = currentPrice;
    needsDbUpdate   = true;
  }

  return { statusChanged: prevStatus !== event.status, needsDbUpdate };
}

/**
 * Trim a price history array to MAX_PRICE_HISTORY_MS, in-place.
 */
function trimPriceHistory(history, nowMs) {
  const cutoff = nowMs - MAX_PRICE_HISTORY_MS;
  let i = 0;
  while (i < history.length && history[i].ts < cutoff) i++;
  if (i > 0) history.splice(0, i);
}

module.exports = {
  WINDOW_CONFIGS,
  MAX_PRICE_HISTORY_MS,
  EVENT_COOLDOWN_MS,
  computePriceChange,
  updateExistingEvent,
  trimPriceHistory,
};
