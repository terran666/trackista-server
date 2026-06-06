'use strict';

/**
 * bearFlagDetector.js (Phase 2 — disabled by default)
 * SHORT: sharp move down (pole) → consolidation above support.
 */

const { findTouches, computeVolumeGrowth } = require('./detectorHelpers');
const { computePatternScore } = require('../formationPatternScorer');

function detect({ candles, extremes, config, effectiveTolPct, debugLog }) {
  if (!config.enabledPatterns?.BEAR_FLAG) return [];

  const candidates = [];
  const supportLevels = extremes.filter(e => e.side === 'support' && e.source === 'extremes');

  for (const level of supportLevels) {
    const levelPrice = level.price;
    if (!levelPrice) continue;

    const tolAbs = levelPrice * effectiveTolPct / 100;
    const levelTs = level.points?.[0]?.timestamp ?? 0;
    const patternBars = levelTs > 0 ? candles.filter(b => b.ts >= levelTs) : candles;

    if (patternBars.length < 15) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_BARS', level: levelPrice, bars: patternBars.length });
      continue;
    }

    const polePart = patternBars.slice(0, Math.floor(patternBars.length * 0.3));
    const flagPart = patternBars.slice(Math.floor(patternBars.length * 0.3));
    const poleMove = polePart.length > 1 ? (polePart[0].open - polePart[polePart.length - 1].close) / polePart[0].open * 100 : 0;

    if (poleMove < 2) {
      debugLog?.({ rejectReason: 'NO_POLE', level: levelPrice, poleMove });
      continue;
    }

    const touches = findTouches(flagPart, levelPrice, tolAbs, 'support');
    if (touches.length < (config.filters?.minTouches ?? 2)) {
      debugLog?.({ rejectReason: 'NOT_ENOUGH_TOUCHES', level: levelPrice, touches: touches.length });
      continue;
    }

    const lastBar = candles[candles.length - 1];
    const currentPrice = lastBar?.close ?? 0;
    const distancePct = levelPrice > 0 ? Math.abs((currentPrice - levelPrice) / levelPrice) * 100 : 999;

    if (distancePct > (config.filters?.maxDistanceToExtremePct ?? 3.0)) {
      debugLog?.({ rejectReason: 'TOO_FAR_FROM_LEVEL', level: levelPrice, distancePct });
      continue;
    }

    const volumeGrowth = computeVolumeGrowth(flagPart);
    const barsInside = flagPart.length;

    const score = computePatternScore({
      distancePct, effectiveTolPct,
      touches: touches.length, barsInside,
      compressionPct: 30, volumeGrowthPct: volumeGrowth,
      structureAligned: poleMove > 3,
    });

    if (score < (config.filters?.minScore ?? 30)) {
      debugLog?.({ rejectReason: 'LOW_SCORE', level: levelPrice, score });
      continue;
    }

    const hi = flagPart.reduce((m, b) => Math.max(m, b.high), -Infinity);
    const lo = flagPart.reduce((m, b) => Math.min(m, b.low), Infinity);

    candidates.push({
      formationType: 'BEAR_FLAG',
      direction: 'SHORT',
      levelPrice,
      level: { price: levelPrice, side: 'support', source: 'sharp-extremes', startTimestamp: level.points?.[0]?.timestamp ?? null },
      pattern: {
        touches: touches.length, barsInside,
        upperBoundary: hi, lowerBoundary: lo,
        compressionPct: 30,
        touchPoints: touches.slice(0, 8).map(t => ({ timestamp: t.timestamp, price: t.price })),
        poleMoveRatio: +poleMove.toFixed(2),
      },
      signals: { multipleTouches: touches.length >= 2, flagPattern: true, volumeRising: volumeGrowth > 10 },
      score,
      distancePct: +distancePct.toFixed(3),
      effectiveTolerancePct: +effectiveTolPct.toFixed(3),
    });
  }

  return candidates;
}

module.exports = { detect };
