'use strict';

// ─── Volume tiers → minimum wall USD threshold ────────────────────
//
// Walls should be sized relative to a symbol's liquidity.
// A $100k wall is noise on BTC but significant on a small-cap coin.
//
// quoteVolume24h (USDT)  → minWallSizeUSD
//  ≥ 1,000,000,000       → 3,000,000
//  ≥   500,000,000       → 1,000,000
//  ≥   300,000,000       →   500,000
//  ≥   100,000,000       →   200,000
//  <   100,000,000       →   100,000   (also used as fallback)
//
const VOLUME_TIERS = [
  { minVolume: 1_000_000_000, threshold: 3_000_000 },
  { minVolume:   500_000_000, threshold: 1_000_000 },
  { minVolume:   300_000_000, threshold:   500_000 },
  { minVolume:   100_000_000, threshold:   200_000 },
];
const FALLBACK_THRESHOLD = 100_000;

/**
 * Return the appropriate wall USD threshold for a given 24h quote volume.
 *
 * @param {number|null|undefined} volume24h  24h USDT quoteVolume for the symbol
 * @returns {number}
 */
function getWallThreshold(volume24h) {
  if (volume24h != null && isFinite(volume24h)) {
    for (const tier of VOLUME_TIERS) {
      if (volume24h >= tier.minVolume) return tier.threshold;
    }
  }
  // Fall back to env override or fixed default
  return parseFloat(process.env.MIN_WALL_SIZE_USD || String(FALLBACK_THRESHOLD));
}

// ─── Configuration ────────────────────────────────────────────────
//
// maxDistancePct is still read from env so it can be tuned without
// a code change.  minWallSizeUSD is now driven by volume tier logic
// (see getWallThreshold above) but can be globally overridden via
// MIN_WALL_SIZE_USD env var when volume24h is not available.

function cfg() {
  return {
    maxDistancePct: parseFloat(process.env.MAX_WALL_DISTANCE_PCT || '0.5'),
  };
}

// ─── detectWalls ─────────────────────────────────────────────────
//
// Pure function: takes an orderbook snapshot (already built by
// orderbookCollector.buildSnapshot) and returns a sorted walls array.
//
// snapshot shape:
//   { symbol, updatedAt, bestBid, bestAsk, midPrice, bids[], asks[] }
//   Each level: { price, size, usdValue }
//
// Wall criteria per level:
//   usdValue >= minWallSizeUSD  (volume-tier based, passed by caller)
//   distancePct <= maxDistancePct
//
// distancePct:
//   ask: ((price - midPrice) / midPrice) * 100
//   bid: ((midPrice - price) / midPrice) * 100
//
// Returns walls sorted by usdValue descending.
//
function detectWalls(snapshot, minWallSizeUSD) {
  if (!snapshot || snapshot.midPrice === null || snapshot.midPrice <= 0) {
    return [];
  }

  // Allow caller to provide the threshold; fall back to env/tier default.
  const threshold = (minWallSizeUSD != null && isFinite(minWallSizeUSD))
    ? minWallSizeUSD
    : getWallThreshold(null);

  const { maxDistancePct } = cfg();
  const mid = snapshot.midPrice;
  const walls = [];

  for (const level of snapshot.asks) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((level.price - mid) / mid) * 100).toFixed(4));
    if (distancePct > maxDistancePct) continue;
    walls.push({
      side:        'ask',
      price:       level.price,
      size:        level.size,
      usdValue:    level.usdValue,
      distancePct,
    });
  }

  for (const level of snapshot.bids) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((mid - level.price) / mid) * 100).toFixed(4));
    if (distancePct > maxDistancePct) continue;
    walls.push({
      side:        'bid',
      price:       level.price,
      size:        level.size,
      usdValue:    level.usdValue,
      distancePct,
    });
  }

  // Strongest walls first
  walls.sort((a, b) => b.usdValue - a.usdValue);

  return walls;
}

// ─── buildWallsPayload ────────────────────────────────────────────
//
// Wraps detectWalls result into the full payload written to Redis.
// minWallSizeUSD is computed by the caller from the symbol's 24h volume
// via getWallThreshold() and passed here so detectWalls stays pure.
//
function buildWallsPayload(snapshot, minWallSizeUSD) {
  const walls = detectWalls(snapshot, minWallSizeUSD);
  return {
    symbol:       snapshot.symbol,
    updatedAt:    snapshot.updatedAt,
    bestBid:      snapshot.bestBid,
    bestAsk:      snapshot.bestAsk,
    midPrice:     snapshot.midPrice,
    wallThreshold: minWallSizeUSD ?? getWallThreshold(null),
    walls,
  };
}

module.exports = { detectWalls, buildWallsPayload, getWallThreshold };
