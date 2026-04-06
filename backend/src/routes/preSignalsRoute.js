'use strict';

/**
 * preSignalsRoute — pre-event readiness signal endpoints.
 *
 * GET /api/pre-signals             — all active pre-signals (from Redis)
 * GET /api/pre-signals/leaders     — sorted by readiness desc
 * GET /api/pre-signals/:symbol     — pre-signal for a specific symbol
 */

const { getPreMoveScan } = require('../services/screenerAggregationService');

function createPreSignalsRouter(redis, db) {
  const express = require('express');
  const router  = express.Router();

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── GET /api/pre-signals/leaders ────────────────────────────────
  // Returns the cached leaders list (top-N by readiness score).
  // Query: ?limit=20&signalType=PRE_PUMP_SIGNAL&directionBias=up|down|neutral
  router.get('/leaders', async (req, res) => {
    try {
      const { limit = 20, signalType, directionBias } = req.query;
      const limitNum = Math.min(parseInt(limit, 10) || 20, 100);

      const raw    = await redis.get('presignal:leaders');
      let leaders  = tryParse(raw) || [];

      if (signalType)   leaders = leaders.filter(s => s.signalType    === signalType);
      if (directionBias) leaders = leaders.filter(s => s.directionBias === directionBias);

      return res.json({
        success : true,
        count   : leaders.length,
        items   : leaders.slice(0, limitNum),
      });
    } catch (err) {
      console.error('[preSignalsRoute] /leaders error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/pre-signals ─────────────────────────────────────────
  // Scan all presignal:<SYM> keys via the active symbol list.
  // Query: ?limit=50&minReadiness=25&signalType=&directionBias=
  router.get('/', async (req, res) => {
    try {
      const { limit = 50, minReadiness = 0, signalType, directionBias } = req.query;

      const items = await getPreMoveScan(redis, {
        limit,
        minReadiness,
        signalType,
        directionBias,
      });

      return res.json({ success: true, count: items.length, items });
    } catch (err) {
      console.error('[preSignalsRoute] / error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/pre-signals/:symbol ─────────────────────────────────
  router.get('/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const raw    = await redis.get(`presignal:${symbol}`);
      if (!raw) return res.json({ success: true, symbol, signal: null });
      return res.json({ success: true, symbol, signal: tryParse(raw) });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createPreSignalsRouter };
