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
    maxDistancePct: parseFloat(process.env.MAX_WALL_DISTANCE_PCT || '10'),
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
// strength  = wallUsdValue / wallThreshold
//   A wall exactly at threshold -> 1.0; a 3x-threshold wall -> 3.0.
//
// Returns walls sorted by usdValue descending.

/**
 * Compute the median of an array of numbers.
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

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

  // Strength = usdValue / threshold, i.e. "how many times larger than the
  // minimum detection threshold is this wall?"
  // A wall exactly at threshold -> strength 1.0; a 3x threshold wall -> 3.0.
  // This is stable, volume-tier-aware and immediately readable.
  // (Previous approach used median of the 20 nearest price levels, which are
  // tiny near the spread and produced absurdly inflated values like 85,000.)

  for (const level of snapshot.asks) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((level.price - mid) / mid) * 100).toFixed(4));
    if (distancePct > maxDistancePct) continue;
    const strength = parseFloat((level.usdValue / threshold).toFixed(2));
    walls.push({
      side:               'ask',
      price:              level.price,
      rawPrice:           level.price,
      size:               level.size,
      usdValue:           level.usdValue,
      distancePct,
      strength,
      source:             'orderbook',
      sourceUpdatedAt:    snapshot.updatedAt,
      exactLevelMatched:  true,
    });
  }

  for (const level of snapshot.bids) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((mid - level.price) / mid) * 100).toFixed(4));
    if (distancePct > maxDistancePct) continue;
    const strength = parseFloat((level.usdValue / threshold).toFixed(2));
    walls.push({
      side:               'bid',
      price:              level.price,
      rawPrice:           level.price,
      size:               level.size,
      usdValue:           level.usdValue,
      distancePct,
      strength,
      source:             'orderbook',
      sourceUpdatedAt:    snapshot.updatedAt,
      exactLevelMatched:  true,
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
    symbol:        snapshot.symbol,
    marketType:    'spot',
    updatedAt:     snapshot.updatedAt,
    bestBid:       snapshot.bestBid,
    bestAsk:       snapshot.bestAsk,
    midPrice:      snapshot.midPrice,
    wallThreshold: minWallSizeUSD ?? getWallThreshold(null),
    walls,
  };
}

// ─── detectWallsFromBook ─────────────────────────────────────────
//
// Variant of detectWalls that operates directly on the raw in-memory
// Maps (Map<priceStr, sizeNum>) maintained by orderbookCollector.
// This bypasses the TOP_LEVELS=200 snapshot limit so walls at large
// distances (e.g. 10%) are found even in deep books.
//
// bids: Map<priceStr, sizeNum>   — all bid levels in the local book
// asks: Map<priceStr, sizeNum>   — all ask levels in the local book
// midPrice: number               — (bestBid + bestAsk) / 2
// minWallSizeUSD: number         — from getWallThreshold()
//
// Returns walls sorted by usdValue descending.
//
function detectWallsFromBook(bids, asks, midPrice, minWallSizeUSD) {
  if (!midPrice || midPrice <= 0) return [];

  const threshold = (minWallSizeUSD != null && isFinite(minWallSizeUSD))
    ? minWallSizeUSD
    : getWallThreshold(null);

  const { maxDistancePct } = cfg();
  const now = Date.now();

  // Build sorted arrays for distance filtering and strength baseline.
  const bidLevels = [...bids.entries()]
    .map(([p, s]) => ({
      price:    parseFloat(p),
      size:     s,
      usdValue: parseFloat((parseFloat(p) * s).toFixed(2)),
    }))
    .sort((a, b) => b.price - a.price); // highest first

  const askLevels = [...asks.entries()]
    .map(([p, s]) => ({
      price:    parseFloat(p),
      size:     s,
      usdValue: parseFloat((parseFloat(p) * s).toFixed(2)),
    }))
    .sort((a, b) => a.price - b.price); // lowest first

  const walls = [];

  for (const level of askLevels) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((level.price - midPrice) / midPrice) * 100).toFixed(4));
    if (distancePct > maxDistancePct) break; // sorted ascending — safe early exit
    const strength = parseFloat((level.usdValue / threshold).toFixed(2));
    walls.push({
      side:              'ask',
      price:             level.price,
      rawPrice:          level.price,
      size:              level.size,
      usdValue:          level.usdValue,
      distancePct,
      strength,
      source:            'orderbook',
      sourceUpdatedAt:   now,
      exactLevelMatched: true,
    });
  }

  for (const level of bidLevels) {
    if (level.usdValue < threshold) continue;
    const distancePct = parseFloat((((midPrice - level.price) / midPrice) * 100).toFixed(4));
    if (distancePct > maxDistancePct) break; // sorted descending — safe early exit
    const strength = parseFloat((level.usdValue / threshold).toFixed(2));
    walls.push({
      side:              'bid',
      price:             level.price,
      rawPrice:          level.price,
      size:              level.size,
      usdValue:          level.usdValue,
      distancePct,
      strength,
      source:            'orderbook',
      sourceUpdatedAt:   now,
      exactLevelMatched: true,
    });
  }

  walls.sort((a, b) => b.usdValue - a.usdValue);
  return walls;
}

module.exports = { detectWalls, buildWallsPayload, getWallThreshold, detectWallsFromBook };
