'use strict';

/**
 * wallEta.js — estimated time-of-arrival (ETA) to a wall price.
 *
 * ETA = |wallPrice - midPrice| / priceVelocity
 *
 * where priceVelocity is the mean absolute close-to-close move per second,
 * measured over the last N 1m bars:
 *
 *   velocity = sum(|close[i] - close[i-1]|) / N / 60   (price units / second)
 *
 * Rules (per spec):
 *   - velocity below a minimum threshold → price is "standing" → etaSec = null
 *   - etaSec > ETA_MAX_SEC (24h) → null (not meaningful)
 *   - returns an integer number of seconds otherwise
 */

// Number of 1m bars used to estimate velocity.
const ETA_BARS_N = Math.max(2, parseInt(process.env.WALL_ETA_BARS_N || '15', 10) || 15);

// Upper cap — ETA beyond 24h is meaningless.
const ETA_MAX_SEC = parseInt(process.env.WALL_ETA_MAX_SEC || '86400', 10) || 86400;

// Minimum velocity, expressed as a fraction of midPrice per second. Below this
// the price is considered effectively stationary and ETA is not reported.
// Default 5e-7/s ≈ 0.003%/min — anything slower is treated as "standing".
const ETA_MIN_VELOCITY_FRACTION = parseFloat(process.env.WALL_ETA_MIN_VELOCITY_FRACTION || '0.0000005');

/**
 * Compute mean absolute price velocity (price units per second) from a list of
 * close prices ordered oldest → newest.
 *
 * @param {number[]} closes
 * @returns {number} velocity in price units per second (0 if insufficient data)
 */
function computePriceVelocity(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  let sum = 0;
  let n   = 0;
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur  = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    sum += Math.abs(cur - prev);
    n++;
  }
  if (n === 0) return 0;
  return (sum / n) / 60;
}

/**
 * Extract close prices (oldest → newest) from raw bar JSON strings as returned
 * by `ZRANGE bars:1m:<sym> -N -1`.
 *
 * @param {string[]} rawBars
 * @returns {number[]}
 */
function parseCloses(rawBars) {
  if (!Array.isArray(rawBars)) return [];
  const closes = [];
  for (const raw of rawBars) {
    try {
      const bar = JSON.parse(raw);
      const c   = parseFloat(bar.close);
      if (Number.isFinite(c)) closes.push(c);
    } catch (_) { /* skip corrupt bar */ }
  }
  return closes;
}

/**
 * Compute etaSec for a single wall price.
 *
 * @param {number} wallPrice
 * @param {number} midPrice
 * @param {number} velocity   price units per second
 * @returns {number|null} integer seconds, or null when not applicable
 */
function computeEtaSec(wallPrice, midPrice, velocity) {
  if (!Number.isFinite(wallPrice) || !Number.isFinite(midPrice)) return null;
  if (!Number.isFinite(velocity) || velocity <= 0) return null;

  // Standing-price guard: velocity below a tiny fraction of price → no ETA.
  const minVelocity = Math.abs(midPrice) * ETA_MIN_VELOCITY_FRACTION;
  if (velocity < minVelocity) return null;

  const eta = Math.abs(wallPrice - midPrice) / velocity;
  if (!Number.isFinite(eta) || eta <= 0) return null;
  if (eta > ETA_MAX_SEC) return null;
  return Math.round(eta);
}

/**
 * Read the last N 1m bars for a symbol and return the computed price velocity.
 * Returns 0 when bars are unavailable.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} symbol
 * @param {'spot'|'futures'} [marketType]
 * @returns {Promise<number>} velocity (price units / second)
 */
async function getPriceVelocity(redis, symbol, marketType = 'futures') {
  const key = marketType === 'spot'
    ? `bars:1m:spot:${symbol}`
    : `bars:1m:${symbol}`;
  try {
    const raw = await redis.zrange(key, -ETA_BARS_N, -1);
    return computePriceVelocity(parseCloses(raw));
  } catch (_) {
    return 0;
  }
}

module.exports = {
  ETA_BARS_N,
  ETA_MAX_SEC,
  computePriceVelocity,
  parseCloses,
  computeEtaSec,
  getPriceVelocity,
};
