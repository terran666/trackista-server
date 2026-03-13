'use strict';

// ─── Configuration ────────────────────────────────────────────────
//
// Read from env so thresholds can be tuned without a code change.
// ENV variables are re-read each call so a future hot-config manager
// can update them at runtime without restarting the collector.

function cfg() {
  return {
    minWallSizeUSD:    parseFloat(process.env.MIN_WALL_SIZE_USD    || '100000'),
    maxDistancePct:    parseFloat(process.env.MAX_WALL_DISTANCE_PCT || '0.5'),
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
//   usdValue >= minWallSizeUSD
//   distancePct <= maxDistancePct
//
// distancePct:
//   ask: ((price - midPrice) / midPrice) * 100
//   bid: ((midPrice - price) / midPrice) * 100
//
// Returns walls sorted by usdValue descending.
//
function detectWalls(snapshot) {
  if (!snapshot || snapshot.midPrice === null || snapshot.midPrice <= 0) {
    return [];
  }

  const { minWallSizeUSD, maxDistancePct } = cfg();
  const mid = snapshot.midPrice;
  const walls = [];

  for (const level of snapshot.asks) {
    if (level.usdValue < minWallSizeUSD) continue;
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
    if (level.usdValue < minWallSizeUSD) continue;
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
//
function buildWallsPayload(snapshot) {
  const walls = detectWalls(snapshot);
  return {
    symbol:    snapshot.symbol,
    updatedAt: snapshot.updatedAt,
    bestBid:   snapshot.bestBid,
    bestAsk:   snapshot.bestAsk,
    midPrice:  snapshot.midPrice,
    walls,
  };
}

module.exports = { detectWalls, buildWallsPayload };
