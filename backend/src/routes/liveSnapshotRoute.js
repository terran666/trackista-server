'use strict';
/**
 * liveSnapshotRoute.js — GET /api/live/snapshot
 *
 * Production-ready snapshot endpoint with:
 *   - scope-aware pollingHints (screener / testpage / monitor)
 *   - per-client rate guard (signals tooFrequentPolling, does NOT block)
 *   - latency reporting + metrics recording
 *
 * Query params: scope, sortBy, sortDir, limit, priceDir, priceMinPct,
 *   priceMaxPct, volumeGrowthMin, tradesMin, turnoverMin, vol24hMin,
 *   minImpulse, minInPlay, minReadiness, minFundingPct, hasMoves,
 *   hasAlerts, symbolSearch
 */
const express = require('express');
const { getSnapshot } = require('../services/screenerAggregationService');

// ─── Scope-based polling hints ─────────────────────────────────────────────

const SCOPE_HINTS = {
  screener : { nextPollMs: 2000, minPollMs: 1000, maxPollMs: 10000, recommendedMode: 'normal'  },
  testpage : { nextPollMs: 1500, minPollMs:  500, maxPollMs:  5000, recommendedMode: 'fast'    },
  monitor  : { nextPollMs: 5000, minPollMs: 3000, maxPollMs: 30000, recommendedMode: 'relaxed' },
};
const VALID_SCOPES   = new Set(Object.keys(SCOPE_HINTS));
const DEFAULT_HINTS  = SCOPE_HINTS.screener;

// ─── Factory ───────────────────────────────────────────────────────────────

function createLiveSnapshotRouter(redis, metrics) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const t0    = Date.now();
    const scope = VALID_SCOPES.has(req.query.scope) ? req.query.scope : 'screener';

    // Per-client rate guard (signals only — request is still processed)
    const tooFrequent = metrics.checkRateGuard(`${req.ip}:${scope}`);

    const {
      sortBy, sortDir, limit,
      priceDir, priceMinPct, priceMaxPct,
      volumeGrowthMin, tradesMin, turnoverMin, vol24hMin,
      minImpulse, minInPlay, minReadiness, minFundingPct,
      hasMoves, hasAlerts, symbolSearch,
    } = req.query;

    const opts = {
      sortBy,
      sortDir,
      limit           : limit           ? parseInt(limit,           10) : undefined,
      priceDir,
      priceMinPct     : priceMinPct     ? parseFloat(priceMinPct)       : undefined,
      priceMaxPct     : priceMaxPct     ? parseFloat(priceMaxPct)       : undefined,
      volumeGrowthMin : volumeGrowthMin ? parseFloat(volumeGrowthMin)   : undefined,
      tradesMin       : tradesMin       ? parseInt(tradesMin,       10) : undefined,
      turnoverMin     : turnoverMin     ? parseFloat(turnoverMin)       : undefined,
      vol24hMin       : vol24hMin       ? parseFloat(vol24hMin)        : undefined,
      minImpulse      : minImpulse      ? parseFloat(minImpulse)       : undefined,
      minInPlay       : minInPlay       ? parseFloat(minInPlay)        : undefined,
      minReadiness    : minReadiness    ? parseFloat(minReadiness)     : undefined,
      minFundingPct   : minFundingPct   ? parseFloat(minFundingPct)    : undefined,
      hasMoves        : hasMoves  === 'true' ? true : undefined,
      hasAlerts       : hasAlerts === 'true' ? true : undefined,
      symbolSearch,
    };

    try {
      const result    = await getSnapshot(redis, opts);
      const latencyMs = Date.now() - t0;

      metrics.recordSnapshot(latencyMs, scope);

      const baseHints = SCOPE_HINTS[scope] || DEFAULT_HINTS;
      const hints     = tooFrequent
        ? { ...baseHints, nextPollMs: baseHints.maxPollMs, recommendedMode: 'throttled' }
        : baseHints;

      return res.json({
        cursor             : result.nextCursor,
        serverTime         : result.snapshotTs,
        scope,
        rows               : result.rows,
        totalScanned       : result.totalScanned,
        totalMatched       : result.totalMatched,
        pipelineMs         : result.pipelineMs,
        buildMs            : result.buildMs,
        latencyMs,
        tooFrequentPolling : tooFrequent || undefined,
        pollingHints       : hints,
      });
    } catch (err) {
      console.error('[liveSnapshotRoute] error:', err.message);
      res.status(500).json({ error: 'snapshot_failed', message: err.message });
    }
  });

  return router;
}

module.exports = { createLiveSnapshotRouter };
