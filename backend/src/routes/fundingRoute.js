'use strict';

/**
 * fundingRoute — GET /api/funding/*
 *
 * Serves funding rate data for futures symbols from Redis.
 * Data is written every 60s by derivativesContextService (REST /fapi/v1/premiumIndex).
 *
 * Keys read:
 *   funding:current:<SYM>  — full snapshot (fundingRateCurrent, direction, revision, etc.)
 *   funding:changes        — Redis list of recent funding change events (LPUSH, max 500)
 *
 * Endpoints:
 *   GET /api/funding/current?symbols=BTCUSDT,ETHUSDT   — batch current funding
 *   GET /api/funding/current/:symbol                   — single symbol funding
 *   GET /api/funding/changes?limit=100                 — recent change events
 */

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function markStale(obj) {
  if (!obj) return obj;
  obj.staleFlag = (Date.now() - (obj.updatedAt || 0)) > STALE_THRESHOLD_MS;
  return obj;
}

function createFundingRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  // GET /api/funding/current?symbols=BTCUSDT,ETHUSDT
  // Omit symbols → returns all active futures symbols
  router.get('/current', async (req, res) => {
    try {
      const symList = req.query.symbols;
      let symbols;

      if (symList) {
        symbols = symList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      } else {
        const raw = await redis.get('symbols:active:usdt');
        symbols   = tryParse(raw) || [];
      }

      if (!symbols.length) {
        return res.json({ ts: Date.now(), count: 0, rows: [] });
      }

      const pipe = redis.pipeline();
      for (const sym of symbols) pipe.get(`funding:current:${sym}`);
      const results = await pipe.exec();

      const rows = [];
      for (const [err, raw] of results) {
        if (err || !raw) continue;
        const obj = tryParse(raw);
        if (obj) rows.push(markStale(obj));
      }

      // Sort by fundingAbs desc (highest funding first)
      rows.sort((a, b) => (b.fundingAbs ?? 0) - (a.fundingAbs ?? 0));

      return res.json({ ts: Date.now(), count: rows.length, rows });
    } catch (err) {
      console.error('[fundingRoute] GET /current error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/funding/current/:symbol
  router.get('/current/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const raw = await redis.get(`funding:current:${symbol}`);
      if (!raw) {
        return res.status(404).json({
          success: false,
          error  : 'Funding data not found — symbol may be inactive or service warming up',
          symbol,
        });
      }
      return res.json({ ts: Date.now(), symbol, funding: markStale(tryParse(raw)) });
    } catch (err) {
      console.error(`[fundingRoute] GET /current/${symbol} error:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/funding/changes?limit=100
  // Returns last N funding change events (sorted newest first)
  router.get('/changes', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    try {
      const raws   = await redis.lrange('funding:changes', 0, limit - 1);
      const changes = raws.map(r => tryParse(r)).filter(Boolean);
      return res.json({ ts: Date.now(), count: changes.length, changes });
    } catch (err) {
      console.error('[fundingRoute] GET /changes error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createFundingRouter };
