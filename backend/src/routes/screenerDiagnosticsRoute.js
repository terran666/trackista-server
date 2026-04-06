'use strict';

/**
 * screenerDiagnosticsRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/screener/debug/diagnostics
 *
 * Returns operational health information for the Screener domain:
 *   - Universe size and data availability per Redis key type
 *   - Snapshot build timing
 *   - Cache / cursor status
 *   - Stale data detection
 *   - Redis pipeline batch count
 *
 * Intended for dev / ops dashboards.  No sensitive data is exposed.
 */

const { getSnapshot, getDiagnostics, getCacheStats, KEYS_PER_SYM, MAX_SINCE_AGE_MS } = require('../services/screenerAggregationService');

function createScreenerDiagnosticsRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  async function handler(req, res) {
    try {
      const t0 = Date.now();

      // Collect cache stats BEFORE triggering snapshot (snapshot may use cache)
      const cacheStats = getCacheStats();

      // Parallel: run diagnostics scan + a minimal snapshot to measure build time
      const [diag, snap] = await Promise.all([
        getDiagnostics(redis),
        getSnapshot(redis, { limit: 500 }),
      ]);

      const totalMs = Date.now() - t0;

      // Estimate alert cursor health
      const alertCount = await redis.zcard('alerts:live');

      // Estimate payload size for a typical screener response
      const samplePayload = JSON.stringify(snap.rows.slice(0, 5));
      const avgRowBytes   = samplePayload.length / Math.max(snap.rows.length, 1);
      const payloadEstBytes = Math.round(avgRowBytes * snap.rows.length);

      // Use stale-symbol % not max age: a single legacy symbol with a very old
      // updatedAt (e.g. pre-migration data) skews maxMetricsFreshnessMs but
      // does NOT break live polling because stale rows are never included in
      // any delta (their updatedAt < every cursor).
      const stalePct       = diag.symbolsTotal > 0
        ? (diag.staleCount / diag.symbolsTotal) * 100
        : 0;
      const deltaReadiness = stalePct > 50 ? 'critical'
                           : stalePct > 20 ? 'warning'
                           :                 'ok';

      return res.json({
        ts                  : Date.now(),
        // ── Futures symbol universe ──────────────────────────────────
        symbolsTotal        : diag.symbolsTotal,
        symbolsWithMetrics  : diag.metricsAvailable,
        symbolsWithSignal   : diag.signalAvailable,
        symbolsWithDerivs   : diag.derivativesAvailable,
        symbolsStale        : diag.staleCount,
        // ── Spot symbol universe ───────────────────────────────────
        symbolsSpotTotal    : diag.symbolsSpotTotal,
        spotMetricsAvailable: diag.spotMetricsAvailable,
        // ── Data freshness / cursor lag ─────────────────────────────
        avgMetricsFreshnessMs : diag.avgMetricsFreshnessMs,
        maxMetricsFreshnessMs : diag.maxMetricsFreshnessMs,
        deltaReadiness,            // ok | warning | critical
        maxSinceAgeMs         : MAX_SINCE_AGE_MS,
        // ── Snapshot quality ───────────────────────────────────────
        snapshotRowCount    : snap.rows.length,
        totalScanned        : snap.totalScanned,
        totalMatched        : snap.totalMatched,
        snapshotTs          : snap.snapshotTs,
        nextCursor          : snap.nextCursor,
        // ── Cache layer ───────────────────────────────────────────────
        cacheHits           : cacheStats.hits,
        cacheMisses         : cacheStats.misses,
        cacheHitRate        : cacheStats.hitRate,      // % e.g. 95.2
        cacheAgeMs          : cacheStats.cacheAgeMs,
        cacheValid          : cacheStats.cacheValid,
        cacheBuilding       : cacheStats.building,
        cacheTtlMs          : cacheStats.ttlMs,
        cacheRowCount       : cacheStats.rowCount,
        // ── Timing ───────────────────────────────────────────────
        diagMs              : diag.diagMs,
        snapshotPipelineMs  : snap.pipelineMs,
        snapshotBuildMs     : snap.buildMs,
        totalDiagMs         : totalMs,
        // ── Redis key stats ────────────────────────────────────────
        redisPipelineBatches: 1,
        redisKeysPerSymbol  : KEYS_PER_SYM,
        redisKeysTotal      : diag.symbolsTotal * KEYS_PER_SYM,
        alertsLiveCount     : alertCount,
        // ── Payload estimate ──────────────────────────────────────
        avgRowBytes         : Math.round(avgRowBytes),
        payloadEstBytes,
        // ── Warnings ─────────────────────────────────────────────
        warnings            : buildWarnings(diag, snap, deltaReadiness),
      });
    } catch (err) {
      console.error('[screenerDiagnostics] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  router.get('/',            handler);
  router.get('/diagnostics', handler);

  return router;
}

function buildWarnings(diag, snap, deltaReadiness) {
  const w = [];
  if (diag.staleCount > 0) {
    w.push(`${diag.staleCount} symbol(s) have stale metrics (>5 min since last update)`);
  }
  const missingMetrics = diag.symbolsTotal - diag.metricsAvailable;
  if (missingMetrics > 0) {
    w.push(`${missingMetrics} symbol(s) have no metrics key in Redis — collector may be warming up`);
  }
  const missingSignal = diag.symbolsTotal - diag.signalAvailable;
  if (missingSignal > 5) {
    w.push(`${missingSignal} symbol(s) missing signal key — MarketImpulseService may be lagging`);
  }
  if (snap.pipelineMs > 200) {
    w.push(`Redis pipeline latency high: ${snap.pipelineMs} ms — check Redis load`);
  }
  if (deltaReadiness === 'critical') {
    w.push(`Data freshness critical: max metrics age ${diag.maxMetricsFreshnessMs} ms exceeds delta window (${MAX_SINCE_AGE_MS} ms) — live polling will trigger constant fullResync`);
  } else if (deltaReadiness === 'warning') {
    w.push(`Data freshness warning: max metrics age ${diag.maxMetricsFreshnessMs} ms — approaching delta resync threshold`);
  }
  if (diag.symbolsSpotTotal > 0 && diag.spotMetricsAvailable < diag.symbolsSpotTotal * 0.5) {
    w.push(`Spot market data: only ~${diag.spotMetricsAvailable}/${diag.symbolsSpotTotal} symbols have metrics — spot collector may be down`);
  }
  return w;
}

module.exports = { createScreenerDiagnosticsRouter };
