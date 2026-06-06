'use strict';

/**
 * descendingTriangleDetector.js
 * SHORT pattern: flat support bottom + falling highs (lower-highs).
 */

const {
  findTouches, findSwingHighs, hasLowerHighs, computeCompression, computeVolumeGrowth,
} = require('./detectorHelpers');
const { computePatternScore } = require('../formationPatternScorer');

function detect({ symbol, marketType, timeframe, candles, extremes, config, effectiveTolPct, debugLog }) {
  const candidates = [];

  const supportLevels = extremes.filter(e => e.side === 'support' && e.source === 'extremes');

  for (const level of supportLevels) {
    const levelPrice = level.price;
    if (!levelPrice) continue;

    const tolAbs = levelPrice * effectiveTolPct / 100;
    const levelTs = level.points?.[0]?.timestamp ?? 0;
    const patternBars = levelTs > 0 ? candles.filter(b => b.ts >= levelTs) : candles;

    if (patternBars.length < (config.filters?.minBarsInsidePattern ?? 8)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_BARS', level: levelPrice, bars: patternBars.length });
      continue;
    }

    const lastBar = candles[candles.length - 1];
    const currentPrice = lastBar?.close ?? 0;
    const distancePct = levelPrice > 0 ? Math.abs((currentPrice - levelPrice) / levelPrice) * 100 : 999;

    if (distancePct > (config.filters?.maxDistanceToExtremePct ?? 3.0)) {
      debugLog?.({ rejectReason: 'TOO_FAR_FROM_LEVEL', level: levelPrice, distancePct });
      continue;
    }

    const touches = findTouches(patternBars, levelPrice, tolAbs, 'support');
    if (touches.length < (config.filters?.minTouches ?? 2)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_TOUCHES', level: levelPrice, touches: touches.length });
      continue;
    }

    const swingHighs = findSwingHighs(patternBars, 3);
    const highPrices = swingHighs.map(p => p.price);
    const structureAligned = hasLowerHighs(highPrices);

    const compression = computeCompression(patternBars);
    const volumeGrowth = computeVolumeGrowth(patternBars);

    const lowerBoundary = levelPrice;
    const upperBoundary = swingHighs.length > 0 ? Math.max(...swingHighs.map(p => p.price)) : patternBars.reduce((m, b) => Math.max(m, b.high), -Infinity);
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
      formationType: 'DESCENDING_TRIANGLE',
      direction: 'SHORT',
      levelPrice,
      level: {
        price: levelPrice,
        side: 'support',
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
        lowerHighs: structureAligned,
        swingHighCount: swingHighs.length,
      },
      signals: {
        multipleTouches: touches.length >= 2,
        lowerHighs: structureAligned,
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
