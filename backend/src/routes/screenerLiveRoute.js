'use strict';

/**
 * screenerLiveRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/screener/live?since=<cursor>
 *
 * Delta endpoint — returns ONLY the rows that changed since the
 * cursor that was returned by the previous /snapshot or /live call.
 *
 * Use this for frequent polling (every 1–3 s) instead of re-fetching
 * the full snapshot on every tick.
 *
 * A row is included in the delta when:
 *   metrics.updatedAt > since   (new 60s tick received)
 *   OR moveLive.lastEventTs > since
 *
 * Cursor model:
 *   - Initial load: GET /api/screener/snapshot → use `nextCursor` as `since`
 *   - Polling:      GET /api/screener/live?since=<nextCursor> → use new `nextCursor`
 *   - Cursor too old (> 2 min): response contains `fullResyncRequired: true`
 *                               → reload from /snapshot
 *
 * Query params:
 *   since            number   REQUIRED  ms cursor from previous response
 *   + all filter/sort params accepted by /snapshot (optional; filters apply
 *     to changed rows the same way as for the snapshot)
 *
 * Response (normal delta):
 * {
 *   fullResyncRequired : false,
 *   serverTs           : number,
 *   nextCursor         : number,
 *   totalChanged       : number,
 *   count              : number,
 *   changedRows        : ScreenerRowDTO[],
 *   newAlerts          : AlertEvent[],
 *   pipelineMs         : number
 * }
 *
 * Response (resync required):
 * {
 *   fullResyncRequired : true,
 *   reason             : 'cursor_too_old' | 'no_cursor',
 *   serverTs           : number,
 *   nextCursor         : number
 * }
 */

const { getDelta } = require('../services/screenerAggregationService');

function parseBool(v) {
  return v === '1' || v === 'true';
}

function createScreenerLiveRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const q     = req.query;
      const since = q.since != null ? parseInt(q.since, 10) : null;

      const opts = {
        sortBy          : q.sortBy          || 'priceChange',
        sortDir         : q.sortDir         || 'desc',
        limit           : q.limit           || 200,
        priceDir        : q.priceDir        || 'any',
        priceMinPct     : q.priceMinPct     != null ? parseFloat(q.priceMinPct)     : undefined,
        priceMaxPct     : q.priceMaxPct     != null ? parseFloat(q.priceMaxPct)     : undefined,
        volumeGrowthMin : q.volumeGrowthMin != null ? parseFloat(q.volumeGrowthMin) : undefined,
        tradesMin       : q.tradesMin       != null ? parseInt(q.tradesMin, 10)     : undefined,
        turnoverMin     : q.turnoverMin     != null ? parseFloat(q.turnoverMin)     : undefined,
        vol24hMin       : q.vol24hMin       != null ? parseFloat(q.vol24hMin)       : undefined,
        minImpulse      : q.minImpulse      != null ? parseFloat(q.minImpulse)      : undefined,
        minInPlay       : q.minInPlay       != null ? parseFloat(q.minInPlay)       : undefined,
        minReadiness    : q.minReadiness    != null ? parseFloat(q.minReadiness)    : undefined,
        minFundingPct   : q.minFundingPct   != null ? parseFloat(q.minFundingPct)   : undefined,
        hasMoves        : q.hasMoves        != null ? parseBool(q.hasMoves)         : undefined,
        hasAlerts       : q.hasAlerts       != null ? parseBool(q.hasAlerts)        : undefined,
        symbolSearch    : q.symbolSearch    || undefined,
      };

      for (const k of Object.keys(opts)) {
        if (opts[k] === undefined) delete opts[k];
      }

      const result = await getDelta(redis, since, opts);

      if (result.fullResyncRequired) {
        return res.json({
          fullResyncRequired : true,
          reason             : result.reason,
          serverTs           : result.serverTs,
          nextCursor         : result.nextCursor,
        });
      }

      return res.json({
        fullResyncRequired : false,
        serverTs           : result.serverTs,
        nextCursor         : result.nextCursor,
        totalChanged       : result.totalChanged,
        count              : result.changedRows.length,
        changedRows        : result.changedRows,
        newAlerts          : result.newAlerts,
        pipelineMs         : result.pipelineMs,
      });
    } catch (err) {
      console.error('[screenerLive] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerLiveRouter };
