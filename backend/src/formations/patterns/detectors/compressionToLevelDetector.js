'use strict';

/**
 * compressionToLevelDetector.js
 * Two variants:
 *   COMPRESSION_TO_RESISTANCE (LONG): range is squeezing toward resistance
 *   COMPRESSION_TO_SUPPORT    (SHORT): range is squeezing toward support
 *
 * Logic: recent bars show a shrinking range AND price is approaching the level.
 * Unlike ascending/descending triangle, structure alignment is not required.
 */

const {
  findTouches, computeCompression, computeVolumeGrowth,
} = require('./detectorHelpers');
const { computePatternScore } = require('../formationPatternScorer');

function detectCompression({ candles, extremes, config, effectiveTolPct, side, formationType, direction, debugLog }) {
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

    const compression = computeCompression(patternBars);

    // Compression is the PRIMARY signal for this detector — require at least 25%
    if (compression < 25) {
      debugLog?.({ rejectReason: 'LOW_COMPRESSION', level: levelPrice, compression });
      continue;
    }

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
      structureAligned: compression > 40,
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
        compression: true,
      },
      signals: {
        multipleTouches: touches.length >= 2,
        compression: true,
        compressionRatio: +(compression / 100).toFixed(3),
        volumeRising: volumeGrowth > 10,
        structureAligned: compression > 40,
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
    ...detectCompression({ candles, extremes, config, effectiveTolPct, side: 'resistance', formationType: 'COMPRESSION_TO_RESISTANCE', direction: 'LONG', debugLog }),
    ...detectCompression({ candles, extremes, config, effectiveTolPct, side: 'support',    formationType: 'COMPRESSION_TO_SUPPORT',    direction: 'SHORT', debugLog }),
  ];
}

module.exports = { detect };
