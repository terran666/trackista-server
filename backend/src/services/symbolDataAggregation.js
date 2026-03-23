'use strict';

/**
 * symbolDataAggregation — pure bar-aggregation functions.
 * Input: pre-parsed, sorted-asc-by-ts 1m bar objects from bars:1m:<SYM>.
 * No I/O; no side effects.
 *
 * Bar fields used:
 *   open, close, volumeUsdt, tradeCount, volatility, volumeSpikeRatio, ts
 */

function sumField(bars, field) {
  let s = 0;
  for (const b of bars) if (b[field] != null) s += b[field];
  return s;
}

function avgField(bars, field) {
  if (!bars.length) return null;
  let s = 0, n = 0;
  for (const b of bars) { if (b[field] != null) { s += b[field]; n++; } }
  return n > 0 ? s / n : null;
}

/**
 * Price change % from open of first bar to close of last bar.
 * Returns null if < 2 bars or missing OHLC.
 */
function deltaPercent(bars) {
  if (bars.length < 2) return null;
  const open  = bars[0].open;
  const close = bars[bars.length - 1].close;
  if (!open || !close) return null;
  return ((close - open) / open) * 100;
}

/**
 * Find the earliest bar in the current contiguous run (scanning backwards)
 * where `field` >= threshold. Returns that bar's ts, or null if not found.
 */
function findRunStartTs(bars, field, threshold) {
  if (!bars || bars.length === 0) return null;
  let startTs = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const val = bars[i][field];
    if (val != null && val >= threshold) {
      startTs = bars[i].ts;
    } else {
      break;
    }
  }
  return startTs;
}

/**
 * Aggregates last N bars for all required metrics.
 *
 * @param {object[]} bars - sorted asc by ts, up to 60 bars
 * @returns {object|null}
 */
function aggregateBars(bars) {
  if (!bars || bars.length === 0) return null;

  const last60 = bars.slice(-60);
  const last15 = bars.slice(-15);
  const last5  = bars.slice(-5);

  // ── Price deltas ─────────────────────────────────────────────────
  const delta5m  = last5.length  >= 2 ? deltaPercent(last5)  : null;
  const delta15m = last15.length >= 2 ? deltaPercent(last15) : null;

  // ── Volume ───────────────────────────────────────────────────────
  const volume5m   = sumField(last5,  'volumeUsdt');
  const volume15m  = sumField(last15, 'volumeUsdt');
  const avgVolume1m = avgField(last60, 'volumeUsdt');
  // avgVolume5m: average of non-overlapping 5-bar windows across last 60 bars
  // Equivalent and simpler: avgVolume1m * 5
  const avgVolume5m = avgVolume1m != null ? avgVolume1m * 5 : null;

  // ── Trades ───────────────────────────────────────────────────────
  const trades5m   = sumField(last5,  'tradeCount');
  const trades15m  = sumField(last15, 'tradeCount');
  const avgTrades1m = avgField(last60, 'tradeCount');
  const avgTrades5m = avgTrades1m != null ? avgTrades1m * 5 : null;

  // ── Relative ratios ─────────────────────────────────────────────
  const relativeVolume5m  = (avgVolume5m  && avgVolume5m  > 0) ? volume5m  / avgVolume5m  : null;
  const relativeTrades5m  = (avgTrades5m  && avgTrades5m  > 0) ? trades5m  / avgTrades5m  : null;

  // ── Volatility (avg bar-level volatility across window) ──────────
  const volatility5m  = avgField(last5,  'volatility');
  const volatility15m = avgField(last15, 'volatility');

  // ── Volume spike run start ────────────────────────────────────────
  // Find when the current elevated-volume run began (for volumeStartedAt)
  const VOLUME_ELEVATED_THRESHOLD = 1.1;
  const volumeRunStartTs = findRunStartTs(last60, 'volumeSpikeRatio', VOLUME_ELEVATED_THRESHOLD);

  return {
    delta5m,
    delta15m,
    volume5m,
    volume15m,
    trades5m,
    trades15m,
    avgVolume1m,
    avgVolume5m,
    avgTrades1m,
    avgTrades5m,
    relativeVolume5m,
    relativeTrades5m,
    volatility5m,
    volatility15m,
    volumeRunStartTs,
  };
}

module.exports = { aggregateBars };
