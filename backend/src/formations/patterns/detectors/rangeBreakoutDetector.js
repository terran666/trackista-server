'use strict';

/**
 * rangeBreakoutDetector.js
 * Two variants:
 *   RANGE_RESISTANCE_BREAKOUT (LONG): price ranging below resistance
 *   RANGE_SUPPORT_BREAKDOWN   (SHORT): price ranging above support
 *
 * Logic: price has been in a relatively flat range (low volatility relative to
 * the level), with multiple touches, but no sustained breakout yet.
 */

const {
  findTouches, computeCompression, computeVolumeGrowth,
} = require('./detectorHelpers');
const { computePatternScore } = require('../formationPatternScorer');

function detectRange({ candles, extremes, config, effectiveTolPct, side, formationType, direction, debugLog }) {
  const candidates = [];

  const levels = extremes.filter(e => e.side === side && e.source === 'extremes');

  for (const level of levels) {
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

    const touches = findTouches(patternBars, levelPrice, tolAbs, side);
    if (touches.length < (config.filters?.minTouches ?? 2)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_TOUCHES', level: levelPrice, touches: touches.length });
      continue;
    }

    // Range check: price should stay mostly on the correct side
    const wrongSideCount = side === 'resistance'
      ? patternBars.filter(b => b.close > levelPrice + tolAbs).length
      : patternBars.filter(b => b.close < levelPrice - tolAbs).length;
    const wrongSideRatio = wrongSideCount / patternBars.length;

    // If more than 30% of bars closed on the wrong side, this is not a clean range
    if (wrongSideRatio > 0.3) {
      debugLog?.({ rejectReason: 'LEVEL_ALREADY_BROKEN', level: levelPrice, wrongSideRatio });
      continue;
    }

    const compression = computeCompression(patternBars);
    const volumeGrowth = computeVolumeGrowth(patternBars);

    const hi = patternBars.reduce((m, b) => Math.max(m, b.high), -Infinity);
    const lo = patternBars.reduce((m, b) => Math.min(m, b.low), Infinity);
    const barsInside = patternBars.length;

    const score = computePatternScore({
      distancePct,
      effectiveTolPct,
      touches: touches.length,
      barsInside,
      compressionPct: compression,
      volumeGrowthPct: volumeGrowth,
      structureAligned: touches.length >= 3,
    });

    if (score < (config.filters?.minScore ?? 30)) {
      debugLog?.({ rejectReason: 'LOW_SCORE', level: levelPrice, score });
      continue;
    }

    candidates.push({
      formationType,
      direction,
      levelPrice,
      level: {
        price: levelPrice,
        side,
        source: 'sharp-extremes',
        startTimestamp: level.points?.[0]?.timestamp ?? null,
        startBarIndex: level.startBarIndex ?? null,
        strength: level.strength ?? 1,
        touches: level.touches ?? 1,
      },
      pattern: {
        touches: touches.length,
        barsInside,
        upperBoundary: hi,
        lowerBoundary: lo,
        compressionPct: Math.round(compression),
        touchPoints: touches.slice(0, 8).map(t => ({ timestamp: t.timestamp, price: t.price })),
        flatLevel: true,
      },
      signals: {
        multipleTouches: touches.length >= 2,
        flatLevel: true,
        compression: compression > 15,
        compressionRatio: +(compression / 100).toFixed(3),
        volumeRising: volumeGrowth > 10,
        structureAligned: touches.length >= 3,
      },
      score,
      distancePct: +distancePct.toFixed(3),
      effectiveTolerancePct: +effectiveTolPct.toFixed(3),
    });
  }

  return candidates;
}

function detect({ candles, extremes, config, effectiveTolPct, debugLog }) {
  return [
    ...detectRange({ candles, extremes, config, effectiveTolPct, side: 'resistance', formationType: 'RANGE_RESISTANCE_BREAKOUT', direction: 'LONG', debugLog }),
    ...detectRange({ candles, extremes, config, effectiveTolPct, side: 'support',    formationType: 'RANGE_SUPPORT_BREAKDOWN',   direction: 'SHORT', debugLog }),
  ];
}

module.exports = { detect };
