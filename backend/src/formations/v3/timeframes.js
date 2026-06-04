'use strict';

/**
 * v3/timeframes.js — aggregate Redis 1m bars into higher timeframes.
 *
 * Redis only stores `bars:1m:<SYM>` (48h, ~2880 bars). Every higher tf used by
 * the V3 engine is folded up from these 1m bars. Timeframes that cannot be
 * assembled from the available history (e.g. 1d with < 3 buckets) are skipped
 * and rely on stored-tool levels instead.
 */

const TF_MINUTES = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

function tfToMinutes(tf) {
  return TF_MINUTES[tf] || null;
}

/**
 * Fold an ascending array of 1m bars into `tf` candles.
 * Bar shape in/out: { ts, open, high, low, close, volumeUsdt?, deltaUsdt?, ... }
 * Buckets align to epoch (ts is ms). Partial trailing bucket is included so the
 * latest forming candle is visible to structure analysis.
 */
function aggregate(bars1m, tf, { maxBars = 120 } = {}) {
  const mins = tfToMinutes(tf);
  if (!mins) return [];
  if (mins === 1) return bars1m.slice(-maxBars);
  if (!Array.isArray(bars1m) || bars1m.length === 0) return [];

  const bucketMs = mins * 60_000;
  const out = [];
  let cur = null;

  for (const b of bars1m) {
    const ts = Number(b.ts);
    if (!Number.isFinite(ts)) continue;
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;

    if (!cur || cur.ts !== bucketStart) {
      if (cur) out.push(cur);
      cur = {
        ts:         bucketStart,
        open:       Number(b.open),
        high:       Number(b.high),
        low:        Number(b.low),
        close:      Number(b.close),
        volumeUsdt: Number(b.volumeUsdt) || 0,
        deltaUsdt:  Number(b.deltaUsdt)  || 0,
      };
    } else {
      cur.high       = Math.max(cur.high, Number(b.high));
      cur.low        = Math.min(cur.low,  Number(b.low));
      cur.close      = Number(b.close);
      cur.volumeUsdt += Number(b.volumeUsdt) || 0;
      cur.deltaUsdt  += Number(b.deltaUsdt)  || 0;
    }
  }
  if (cur) out.push(cur);
  return out.slice(-maxBars);
}

module.exports = { aggregate, tfToMinutes, TF_MINUTES };
