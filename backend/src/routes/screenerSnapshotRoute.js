'use strict';

/**
 * screenerSnapshotRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/screener/snapshot
 *
 * Returns the complete current screener state as an array of
 * ScreenerRowDTO objects, already filtered, sorted, and normalised.
 *
 * The frontend does NOT need to merge data from multiple endpoints —
 * every row already contains:
 *   - live 60s price / volume / trade metrics
 *   - 5m and 15m bar aggregates
 *   - impulse / inPlay scores
 *   - derivatives (funding, OI)
 *   - move event state
 *   - pre-event readiness signal
 *   - alert presence flag
 *   - 24h context
 *
 * Query params (all optional, AND-logic):
 *   sortBy           priceChange|priceChange5m|volume|volume5m|trades|
 *                    spike|impulse|inPlay|readiness|vol24h|funding|freshness
 *   sortDir          desc|asc
 *   limit            1–500  (default 200)
 *   priceDir         up|down|any
 *   priceMinPct      number
 *   priceMaxPct      number
 *   volumeGrowthMin  number  (% above baseline; e.g. 200 → spike ≥ 3×)
 *   tradesMin        number
 *   turnoverMin      number  (min volumeUsdt60s in USDT)
 *   vol24hMin        number
 *   minImpulse       number
 *   minInPlay        number
 *   minReadiness     number
 *   minFundingPct    number  (min |fundingRate| × 100)
 *   hasMoves         1|true  (only symbols with active move event)
 *   hasAlerts        1|true  (only symbols with recent alert)
 *   symbolSearch     string  (substring match on symbol name)
 *
 * Response:
 * {
 *   ts         : number,        server timestamp ms
 *   snapshotTs : number,        same as ts (alias used by live route cursor)
 *   nextCursor : number,        pass as `since` to /api/screener/live
 *   count      : number,        rows returned
 *   totalScanned: number,       total active symbols
 *   totalMatched: number,       symbols matching filters
 *   pipelineMs : number,        Redis round-trip time
 *   buildMs    : number,        aggregation time
 *   rows       : ScreenerRowDTO[]
 * }
 */

const { getSnapshot } = require('../services/screenerAggregationService');

function parseBool(v) {
  return v === '1' || v === 'true';
}

function createScreenerSnapshotRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const q = req.query;

      const opts = {
        sortBy          : q.sortBy          || 'priceChange',
        sortDir         : q.sortDir         || 'desc',
        limit           : q.limit           || 200,
        priceDir        : q.priceDir        || 'any',
        priceMinPct     : q.priceMinPct     != null ? parseFloat(q.priceMinPct)      : undefined,
        priceMaxPct     : q.priceMaxPct     != null ? parseFloat(q.priceMaxPct)      : undefined,
        volumeGrowthMin : q.volumeGrowthMin != null ? parseFloat(q.volumeGrowthMin)  : undefined,
        tradesMin       : q.tradesMin       != null ? parseInt(q.tradesMin, 10)      : undefined,
        turnoverMin     : q.turnoverMin     != null ? parseFloat(q.turnoverMin)      : undefined,
        vol24hMin       : q.vol24hMin       != null ? parseFloat(q.vol24hMin)        : undefined,
        minImpulse      : q.minImpulse      != null ? parseFloat(q.minImpulse)       : undefined,
        minInPlay       : q.minInPlay       != null ? parseFloat(q.minInPlay)        : undefined,
        minReadiness    : q.minReadiness    != null ? parseFloat(q.minReadiness)     : undefined,
        minFundingPct   : q.minFundingPct   != null ? parseFloat(q.minFundingPct)    : undefined,
        hasMoves        : q.hasMoves        != null ? parseBool(q.hasMoves)          : undefined,
        hasAlerts       : q.hasAlerts       != null ? parseBool(q.hasAlerts)         : undefined,
        symbolSearch    : q.symbolSearch    || undefined,
      };

      // Drop undefined keys to keep passesFilters clean
      for (const k of Object.keys(opts)) {
        if (opts[k] === undefined) delete opts[k];
      }

      const result = await getSnapshot(redis, opts);

      return res.json({
        ts           : result.snapshotTs,
        snapshotTs   : result.snapshotTs,
        nextCursor   : result.nextCursor,
        count        : result.rows.length,
        totalScanned : result.totalScanned,
        totalMatched : result.totalMatched,
        pipelineMs   : result.pipelineMs,
        buildMs      : result.buildMs,
        rows         : result.rows,
      });
    } catch (err) {
      console.error('[screenerSnapshot] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerSnapshotRouter };
