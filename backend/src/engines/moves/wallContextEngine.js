'use strict';

/**
 * wallContextEngine — pure functions for computing wall-proximity context.
 * Works with both spot walls (walls:<SYM>) and futures walls (futures:walls:<SYM>).
 */

const WALL_ZONE_PCT = 2.0; // Consider walls within ±2% as "near"

/**
 * Compute wall context from a walls Redis payload and the current price.
 *
 * @param {object|null} wallsData  — parsed JSON from walls:<SYM> or futures:walls:<SYM>
 * @param {number}      currentPrice
 * @returns {WallContext}
 */
function computeWallContext(wallsData, currentPrice) {
  const EMPTY = {
    nearestBidWallDistancePct : null,
    nearestAskWallDistancePct : null,
    nearestBidWallUsd         : 0,
    nearestAskWallUsd         : 0,
    wallPressureBid           : 0,
    wallPressureAsk           : 0,
    wallBias                  : 'neutral',
    wallBreakRisk             : 0,
    wallBounceChance          : 0,
  };

  if (!wallsData || !Array.isArray(wallsData.walls) || !currentPrice || currentPrice <= 0) {
    return EMPTY;
  }

  const walls     = wallsData.walls;
  const threshold = wallsData.wallThreshold || 100_000;

  // Separate and sort — bids descending (highest first), asks ascending (lowest first)
  const bidWalls = walls
    .filter(w => w.side === 'bid' || w.side === 'buy')
    .sort((a, b) => b.price - a.price);
  const askWalls = walls
    .filter(w => w.side === 'ask' || w.side === 'sell')
    .sort((a, b) => a.price - b.price);

  const nearestBid = bidWalls[0] || null;
  const nearestAsk = askWalls[0] || null;

  const nearestBidDistPct = nearestBid
    ? (currentPrice - nearestBid.price) / currentPrice * 100
    : null;
  const nearestAskDistPct = nearestAsk
    ? (nearestAsk.price - currentPrice) / currentPrice * 100
    : null;

  // Aggregate USD pressure within ±WALL_ZONE_PCT of current price
  let bidPressureUsd = 0;
  let askPressureUsd = 0;

  for (const w of bidWalls) {
    const dist = (currentPrice - w.price) / currentPrice * 100;
    if (dist <= WALL_ZONE_PCT) bidPressureUsd += (w.usdValue || 0);
  }
  for (const w of askWalls) {
    const dist = (w.price - currentPrice) / currentPrice * 100;
    if (dist <= WALL_ZONE_PCT) askPressureUsd += (w.usdValue || 0);
  }

  // Normalize to multiples of threshold
  const bidPressure = threshold > 0 ? bidPressureUsd / threshold : 0;
  const askPressure = threshold > 0 ? askPressureUsd / threshold : 0;

  // Wall bias
  let wallBias = 'neutral';
  const pressureRatio = bidPressure / Math.max(askPressure, 0.01);
  if (pressureRatio > 2.0)       wallBias = 'bid-heavy'; // strong support below price
  else if (pressureRatio < 0.5)  wallBias = 'ask-heavy'; // strong resistance above price

  // Wall bounce chance: price close to a significant bid wall
  let wallBounceChance = 0;
  if (nearestBid && nearestBidDistPct !== null && nearestBidDistPct >= 0 && nearestBidDistPct < 1.5) {
    const strength = nearestBid.strength ?? (nearestBid.usdValue / threshold);
    const proximity = Math.max(0, 1 - nearestBidDistPct / 1.5);
    wallBounceChance = Math.min(100, proximity * Math.min(strength, 5) * 20);
  }

  // Wall break risk: price close to a significant ask wall (upside pressure)
  let wallBreakRisk = 0;
  if (nearestAsk && nearestAskDistPct !== null && nearestAskDistPct >= 0 && nearestAskDistPct < 1.5) {
    const strength = nearestAsk.strength ?? (nearestAsk.usdValue / threshold);
    const proximity = Math.max(0, 1 - nearestAskDistPct / 1.5);
    wallBreakRisk = Math.min(100, proximity * Math.min(strength, 5) * 15);
  }

  return {
    nearestBidWallDistancePct : nearestBidDistPct !== null ? round(nearestBidDistPct, 4) : null,
    nearestAskWallDistancePct : nearestAskDistPct !== null ? round(nearestAskDistPct, 4) : null,
    nearestBidWallUsd         : nearestBid ? (nearestBid.usdValue || 0) : 0,
    nearestAskWallUsd         : nearestAsk ? (nearestAsk.usdValue || 0) : 0,
    wallPressureBid           : round(bidPressure,      2),
    wallPressureAsk           : round(askPressure,      2),
    wallBias,
    wallBreakRisk             : round(wallBreakRisk,    1),
    wallBounceChance          : round(wallBounceChance, 1),
  };
}

function round(v, dec) {
  const m = 10 ** dec;
  return Math.round(v * m) / m;
}

module.exports = { computeWallContext };
