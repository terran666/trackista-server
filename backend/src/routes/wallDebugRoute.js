'use strict';

const { safeSymbol } = require('../utils/parseClamp');

// ─── GET /api/density/wall-debug ──────────────────────────────────────────────
//
// Debug endpoint for the v3 adaptive wall algorithm.
// Shows per-level pass/fail analysis for the current orderbook snapshot.
//
// Query params:
//   symbol  (required)  e.g. BTCUSDT
//
// Response 200:
// {
//   "symbol":     "BTCUSDT",
//   "midPrice":   108000,
//   "bidStats":   { medianOrderUsd, p75OrderUsd, p90OrderUsd, p95OrderUsd, maxOrderUsd, levelCount, adaptiveThreshold },
//   "askStats":   { ... },
//   "avgDepthNear1PctUsd": 12000000,
//   "confirmedWalls": [ { side, price, usdValue, distancePct, wallPower, wallCategory, ... } ],
//   "candidateLevels": [
//     {
//       side, price, usdValue, distancePct,
//       passed: true|false,
//       failReason: null | 'below_adaptive_threshold' | 'below_local_ratio',
//       checks: {
//         adaptiveThreshold:       7500000,
//         passesAdaptive:          true,
//         localMedianUsd:          1200000,
//         localRatio:              12.5,
//         requiredLocalRatio:      3,
//         passesLocal:             true,
//         p95Usd:                  5000000,
//         p95Ratio:                3.0,
//         similarLevelsCount:      1,
//       }
//     },
//     ...
//   ],
//   "updatedAt": 1234567890123
// }
//
// The heavy analysis is done inline from the snapshot stored in futures:orderbook:{symbol}
// and the pre-computed stats in density:wallStats:{symbol}.
//

// ── Pure helpers (mirror of futuresWallDetector internals, no state) ──────────

function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}

function _computeSideStats(levels) {
  if (!levels.length) return { p50: 0, p75: 0, p90: 0, p95: 0, avg: 0, max: 0, levelCount: 0 };
  const sorted = levels.map(l => l.usdValue).sort((a, b) => a - b);
  const sum    = sorted.reduce((s, v) => s + v, 0);
  return {
    p50:        _percentile(sorted, 0.50),
    p75:        _percentile(sorted, 0.75),
    p90:        _percentile(sorted, 0.90),
    p95:        _percentile(sorted, 0.95),
    avg:        sum / sorted.length,
    max:        sorted[sorted.length - 1],
    levelCount: sorted.length,
  };
}

function _computeLocalMedian(sideArray, idx, window) {
  const start     = Math.max(0, idx - window);
  const end       = Math.min(sideArray.length - 1, idx + window);
  const neighbors = [];
  for (let i = start; i <= end; i++) {
    if (i !== idx) neighbors.push(sideArray[i].usdValue);
  }
  if (!neighbors.length) return 0;
  neighbors.sort((a, b) => a - b);
  return _percentile(neighbors, 0.50);
}

function _computeSimilarLevelsCount(sideArray, candidateUsd) {
  const lo = candidateUsd * 0.65;
  const hi = candidateUsd * 1.35;
  return sideArray.filter(l => l.usdValue >= lo && l.usdValue <= hi).length;
}

// Config defaults (mirrored — no import since backend can't import collector)
const SCAN_DISTANCE_PCT   = parseFloat(process.env.WALL_SCAN_DISTANCE_PCT   || '5');
const P95_MULTIPLIER      = parseFloat(process.env.WALL_P95_MULTIPLIER      || '1.5');
const MEDIAN_MULTIPLIER   = parseFloat(process.env.WALL_MEDIAN_MULTIPLIER   || '4');
const DEPTH_RATIO         = parseFloat(process.env.WALL_DEPTH_RATIO         || '0.03');
const LOCAL_WINDOW        = parseInt(process.env.WALL_LOCAL_WINDOW_LEVELS  || '5', 10);
const LOCAL_MULTIPLIER    = parseFloat(process.env.WALL_LOCAL_MULTIPLIER    || '3');
const SIMILAR_LEVELS_LIMIT = parseInt(process.env.WALL_SIMILAR_LEVELS_LIMIT || '5', 10);

// Static per-symbol minimums (mirrors collector/src/densityFuturesConfig.js)
const STATIC_THRESHOLDS = {
  BTCUSDT: 5_000_000, ETHUSDT: 3_000_000, SOLUSDT: 2_000_000,
  BNBUSDT: 1_000_000, XRPUSDT: 1_000_000, TRXUSDT: 2_000_000,
  _default:   400_000,
};
function _staticMin(symbol) {
  return STATIC_THRESHOLDS[symbol] ?? STATIC_THRESHOLDS._default;
}

function createWallDebugHandler(redis) {
  return async function wallDebugHandler(req, res) {
    const symbol = safeSymbol(req.query.symbol);
    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required and must match /^[A-Z0-9]{3,20}$/',
      });
    }

    try {
      const [obRaw, statsRaw, wallsRaw] = await Promise.all([
        redis.get(`futures:orderbook:${symbol}`),
        redis.get(`density:wallStats:${symbol}`),
        redis.get(`futures:walls:${symbol}`),
      ]);

      if (!obRaw) {
        return res.status(404).json({ success: false, error: `No orderbook snapshot for ${symbol}` });
      }

      const ob          = JSON.parse(obRaw);
      const statsStored = statsRaw ? JSON.parse(statsRaw) : null;
      const wallsData   = wallsRaw ? JSON.parse(wallsRaw) : null;

      const midPrice      = ob.midPrice ?? 0;
      const staticMin     = _staticMin(symbol);
      const confirmedWalls = wallsData?.walls ?? [];

      // Build confirmed-wall lookup (by price string for fast match)
      const confirmedSet = new Set(confirmedWalls.map(w => `${w.side}:${w.price}`));

      // ── Re-run level analysis on the stored snapshot ─────────────────────
      const bidLevels = [];
      const askLevels = [];
      let   depth1Pct = 0;

      // ob.bids / ob.asks may be stored as [{price, usdValue}] or [[price, size]]
      const _normLevels = (arr, side) => {
        if (!Array.isArray(arr)) return [];
        return arr.map(entry => {
          if (Array.isArray(entry)) {
            const price    = parseFloat(entry[0]);
            const size     = parseFloat(entry[1]);
            return { price, size, usdValue: price * size };
          }
          const price    = entry.price ?? 0;
          const usdValue = entry.usdValue ?? (price * (entry.size ?? 0));
          return { price, size: entry.size ?? 0, usdValue };
        });
      };

      for (const lvl of _normLevels(ob.bids, 'bid')) {
        if (lvl.usdValue <= 0 || !lvl.price) continue;
        const dist = ((midPrice - lvl.price) / midPrice) * 100;
        if (dist < 0 || dist > SCAN_DISTANCE_PCT) continue;
        bidLevels.push({ ...lvl, dist });
        if (dist <= 1.0) depth1Pct += lvl.usdValue;
      }
      for (const lvl of _normLevels(ob.asks, 'ask')) {
        if (lvl.usdValue <= 0 || !lvl.price) continue;
        const dist = ((lvl.price - midPrice) / midPrice) * 100;
        if (dist < 0 || dist > SCAN_DISTANCE_PCT) continue;
        askLevels.push({ ...lvl, dist });
        if (dist <= 1.0) depth1Pct += lvl.usdValue;
      }

      bidLevels.sort((a, b) => b.price - a.price);
      askLevels.sort((a, b) => a.price - b.price);

      const avgDepthNear1Pct = depth1Pct / 2;
      const bidStats         = _computeSideStats(bidLevels);
      const askStats         = _computeSideStats(askLevels);
      const bidAdaptiveThresh = Math.max(staticMin, bidStats.p95 * P95_MULTIPLIER, bidStats.p50 * MEDIAN_MULTIPLIER, avgDepthNear1Pct * DEPTH_RATIO);
      const askAdaptiveThresh = Math.max(staticMin, askStats.p95 * P95_MULTIPLIER, askStats.p50 * MEDIAN_MULTIPLIER, avgDepthNear1Pct * DEPTH_RATIO);

      // Annotate each level with pass/fail detail
      const _analyzeOneSide = (sideArray, side, adaptiveThresh, sideStats) => {
        return sideArray.map((lvl, i) => {
          const { price, usdValue, dist } = lvl;
          const localMedianUsd      = _computeLocalMedian(sideArray, i, LOCAL_WINDOW);
          const similarLevelsCount  = _computeSimilarLevelsCount(sideArray, usdValue);
          const localRatio          = localMedianUsd > 0 ? usdValue / localMedianUsd : null;
          const p95Ratio            = sideStats.p95 > 0  ? usdValue / sideStats.p95  : 0;

          const passesAdaptive  = usdValue >= adaptiveThresh;
          const passesLocal     = !passesAdaptive
            ? false
            : (localMedianUsd <= 0 || usdValue >= localMedianUsd * LOCAL_MULTIPLIER);
          const passesIsolation = similarLevelsCount <= SIMILAR_LEVELS_LIMIT;
          const passed          = passesAdaptive && passesLocal && passesIsolation;
          const isConfirmed     = confirmedSet.has(`${side}:${price}`);

          let failReason = null;
          if (!passesAdaptive)      failReason = 'below_adaptive_threshold';
          else if (!passesLocal)    failReason = 'below_local_ratio';
          else if (!passesIsolation) failReason = 'cluster_not_anomalous';

          return {
            side, price, usdValue, distancePct: parseFloat(dist.toFixed(4)),
            passed, failReason, isConfirmed,
            checks: {
              adaptiveThreshold:   Math.round(adaptiveThresh),
              passesAdaptive,
              localMedianUsd:      Math.round(localMedianUsd),
              localRatio:          localRatio !== null ? parseFloat(localRatio.toFixed(3)) : null,
              requiredLocalRatio:  LOCAL_MULTIPLIER,
              passesLocal,
              p95Usd:              Math.round(sideStats.p95),
              p95Ratio:            parseFloat(p95Ratio.toFixed(3)),
              similarLevelsCount,
              similarLevelsLimit:  SIMILAR_LEVELS_LIMIT,
              passesIsolation,
            },
          };
        });
      };

      const bidAnalysis = _analyzeOneSide(bidLevels, 'bid', bidAdaptiveThresh, bidStats);
      const askAnalysis = _analyzeOneSide(askLevels, 'ask', askAdaptiveThresh, askStats);
      const candidateLevels = [...bidAnalysis, ...askAnalysis]
        .sort((a, b) => b.usdValue - a.usdValue);

      const passCount       = candidateLevels.filter(l => l.passed).length;
      const failAdaptive    = candidateLevels.filter(l => l.failReason === 'below_adaptive_threshold').length;
      const failLocal       = candidateLevels.filter(l => l.failReason === 'below_local_ratio').length;
      const failIsolation   = candidateLevels.filter(l => l.failReason === 'cluster_not_anomalous').length;
      const totalConfirmedCount  = confirmedWalls.length;
      const significantWallCount = confirmedWalls.filter(w => (w.wallPower ?? 0) >= 0.65).length;
      const visibleWalls         = confirmedWalls.filter(w => (w.wallPower ?? 0) >= 0.45);

      return res.json({
        success: true,
        symbol,
        midPrice,
        // Wall count summary
        totalConfirmedCount,
        significantWallCount,
        visibleWallCount:     visibleWalls.length,
        passCount,
        failAdaptive,
        failLocal,
        failIsolation,
        // Use pre-computed stats from collector if available (fresher), else inline
        bidStats: statsStored?.bid ?? {
          medianOrderUsd:    Math.round(bidStats.p50),
          p75OrderUsd:       Math.round(bidStats.p75),
          p90OrderUsd:       Math.round(bidStats.p90),
          p95OrderUsd:       Math.round(bidStats.p95),
          maxOrderUsd:       Math.round(bidStats.max),
          levelCount:        bidStats.levelCount,
          adaptiveThreshold: Math.round(bidAdaptiveThresh),
        },
        askStats: statsStored?.ask ?? {
          medianOrderUsd:    Math.round(askStats.p50),
          p75OrderUsd:       Math.round(askStats.p75),
          p90OrderUsd:       Math.round(askStats.p90),
          p95OrderUsd:       Math.round(askStats.p95),
          maxOrderUsd:       Math.round(askStats.max),
          levelCount:        askStats.levelCount,
          adaptiveThreshold: Math.round(askAdaptiveThresh),
        },
        avgDepthNear1PctUsd:  Math.round(avgDepthNear1Pct),
        staticMinWallUsd:     staticMin,
        similarLevelsLimit:   SIMILAR_LEVELS_LIMIT,
        confirmedWalls:       visibleWalls,       // filtered by wallPower >= WALL_POWER_SOFT_MIN
        allConfirmedWalls:    confirmedWalls,      // all confirmed walls (for debug)
        candidateLevels,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[wallDebugRoute] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallDebugHandler };
