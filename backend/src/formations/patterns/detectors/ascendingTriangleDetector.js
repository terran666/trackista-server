'use strict';

/**
 * ascendingTriangleDetector.js
 * LONG pattern: flat resistance top + rising lows (higher-lows).
 *
 * Logic:
 *   1. Resistance level is the Sharp Extreme.
 *   2. Price has touched the resistance >= minTouches.
 *   3. Swing lows are progressively higher (higher-lows).
 *   4. Current price is within adaptive tolerance of the resistance.
 */

const {
  findTouches, findSwingLows, hasHigherLows, computeCompression, computeVolumeGrowth,
} = require('./detectorHelpers');
const { computePatternScore } = require('../formationPatternScorer');

function detect({ symbol, marketType, timeframe, candles, extremes, config, effectiveTolPct, debugLog }) {
  const candidates = [];

  // Only resistance levels for LONG ascending triangle
  const resistanceLevels = extremes.filter(e => e.side === 'resistance' && e.source === 'extremes');

  for (const level of resistanceLevels) {
    const levelPrice = level.price;
    if (!levelPrice) continue;

    const tolAbs = levelPrice * effectiveTolPct / 100;

    // Find candles that start from after the level bar
    const levelTs = level.points?.[0]?.timestamp ?? 0;
    const patternBars = levelTs > 0 ? candles.filter(b => b.ts >= levelTs) : candles;

    if (patternBars.length < (config.filters?.minBarsInsidePattern ?? 8)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_BARS', level: levelPrice, bars: patternBars.length });
      continue;
    }

    // Distance from current price to level
    const lastBar = candles[candles.length - 1];
    const currentPrice = lastBar?.close ?? 0;
    const distancePct = levelPrice > 0 ? Math.abs((currentPrice - levelPrice) / levelPrice) * 100 : 999;

    if (distancePct > (config.filters?.maxDistanceToExtremePct ?? 3.0)) {
      debugLog?.({ rejectReason: 'TOO_FAR_FROM_LEVEL', level: levelPrice, distancePct });
      continue;
    }

    // Count touches at resistance
    const touches = findTouches(patternBars, levelPrice, tolAbs, 'resistance');
    if (touches.length < (config.filters?.minTouches ?? 2)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_TOUCHES', level: levelPrice, touches: touches.length });
      continue;
    }

    // Find swing lows — need higher-lows for ascending triangle
    const swingLows = findSwingLows(patternBars, 3);
    const lowPrices = swingLows.map(p => p.price);
    const structureAligned = hasHigherLows(lowPrices);

    const compression = computeCompression(patternBars);
    const volumeGrowth = computeVolumeGrowth(patternBars);

    // Upper/lower boundaries
    const upperBoundary = levelPrice;
    const lowerBoundary = swingLows.length > 0 ? Math.min(...swingLows.map(p => p.price)) : patternBars.reduce((m, b) => Math.min(m, b.low), Infinity);

    const barsInside = patternBars.length;

    const score = computePatternScore({
      distancePct,
      effectiveTolPct,
      touches: touches.length,
      barsInside,
      compressionPct: compression,
      volumeGrowthPct: volumeGrowth,
      structureAligned,
    });

    if (score < (config.filters?.minScore ?? 30)) {
      debugLog?.({ rejectReason: 'LOW_SCORE', level: levelPrice, score });
      continue;
    }

    candidates.push({
      formationType: 'ASCENDING_TRIANGLE',
      direction: 'LONG',
      levelPrice,
      level: {
        price: levelPrice,
        side: 'resistance',
        source: 'sharp-extremes',
        startTimestamp: level.points?.[0]?.timestamp ?? null,
        startBarIndex: level.startBarIndex ?? null,
        strength: level.strength ?? 1,
        touches: level.touches ?? 1,
      },
      pattern: {
        touches: touches.length,
        barsInside,
        upperBoundary,
        lowerBoundary,
        compressionPct: Math.round(compression),
        touchPoints: touches.slice(0, 8).map(t => ({ timestamp: t.timestamp, price: t.price })),
        higherLows: structureAligned,
        swingLowCount: swingLows.length,
      },
      signals: {
        multipleTouches: touches.length >= 2,
        higherLows: structureAligned,
        compression: compression > 20,
        compressionRatio: +(compression / 100).toFixed(3),
        volumeRising: volumeGrowth > 10,
        structureAligned,
      },
      score,
      distancePct: +distancePct.toFixed(3),
      effectiveTolerancePct: +effectiveTolPct.toFixed(3),
    });
  }

  return candidates;
}

module.exports = { detect };
