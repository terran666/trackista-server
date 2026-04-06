'use strict';
/**
 * liveHealthRoute.js — GET /api/runtime/live-health
 *
 * Exposes aggregated runtime metrics for the live polling subsystem.
 * Combines livePollingMetrics counters with the screener aggregation cache stats.
 *
 * Response shape:
 *   ts, currentLiveCursor, deltaWindowSize,
 *   snapshotRps, deltaRps, snapshotRequests, deltaRequests,
 *   noChangeRate, noChangeDeltaResponses, changedDeltaResponses,
 *   avgDeltaLatencyMs, avgSnapshotLatencyMs, avgDeltaPayloadSize,
 *   tooFrequentPollingCount, fullResyncCount,
 *   trackedSymbolsCount, hotScopes, cacheStats
 */
const express = require('express');
const { getCacheStats } = require('../services/screenerAggregationService');

function createLiveHealthRouter(metrics) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    try {
      const cacheStats = getCacheStats();
      res.json(metrics.getSummary(cacheStats));
    } catch (err) {
      console.error('[liveHealthRoute] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLiveHealthRouter };
