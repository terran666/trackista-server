'use strict';
/**
 * densityDomRoute.js — REST API for the Density / Footprint page.
 *
 * Endpoints:
 *   GET  /api/density/dom-snapshot?symbol=&tf=&bars=
 *   GET  /api/density/snapshot?symbol=&tf=&above=&below=
 *   POST /api/density/activate   { symbol }
 *   GET  /api/density/footprint?symbol=&tf=&bars=
 *   GET  /api/density/last-trade?symbol=
 */

const express = require('express');

const VALID_TFS = new Set(['1m', '5m', '15m', '30m', '1h']);

function createDensityDomRouter(redis, densityService) {
  const router = express.Router();

  // ─── GET /api/density/dom-snapshot ───────────────────────────
  // Full combined snapshot: orderbook + footprint bars + priceLevels + walls.
  // Called once on page load / symbol switch. WS scope=density handles live updates.
  router.get('/dom-snapshot', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const tf     = VALID_TFS.has(req.query.tf) ? req.query.tf : '1m';
    const bars   = Math.min(parseInt(req.query.bars || '20', 10), 60);

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }

    try {
      const snapshot = await densityService.getDomSnapshot(symbol, tf, bars);
      if (!snapshot) {
        return res.status(202).json({
          success: false,
          error:   'orderbook_not_ready',
          symbol,
          hint:    'Collector orderbook not yet available for this symbol',
        });
      }
      return res.json({ success: true, ...snapshot });
    } catch (err) {
      console.error(`[densityRoute] dom-snapshot error (${symbol}):`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/density/snapshot ───────────────────────────────
  // Unified single-source snapshot: priceLevels[] combining DOM + clusters + POC.
  router.get('/snapshot', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const tf     = VALID_TFS.has(req.query.tf) ? req.query.tf : '1m';
    const above  = Math.min(Math.max(parseInt(req.query.above || '40', 10), 1), 200);
    const below  = Math.min(Math.max(parseInt(req.query.below || '40', 10), 1), 200);

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }

    try {
      // Auto-activate if not yet streaming (cluster data needs aggTrade WS)
      if (!densityService.isSymbolActive(symbol)) {
        densityService.activateSymbol(symbol);
      }
      const snap = await densityService.getUnifiedSnapshot(symbol, tf, above, below);
      if (!snap) {
        return res.status(202).json({
          success: false,
          error:   'orderbook_not_ready',
          symbol,
          hint:    'Collector orderbook not yet available for this symbol',
        });
      }
      return res.json({ success: true, ...snap });
    } catch (err) {
      console.error(`[densityRoute] snapshot error (${symbol}):`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/density/footprint ──────────────────────────────
  // Returns footprint bars for a symbol + timeframe (in-memory or Redis fallback).
  router.get('/footprint', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const tf     = VALID_TFS.has(req.query.tf) ? req.query.tf : '1m';
    const bars   = Math.min(parseInt(req.query.bars || '20', 10), 60);

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }

    try {
      // Prefer in-memory data; fallback to Redis for inactive symbols
      let footprintBars = [];
      if (densityService.isSymbolActive(symbol)) {
        footprintBars = densityService.getFootprintBars(symbol, tf, bars);
      } else {
        const TF_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };
        const tfMs     = TF_MS[tf] ?? 60_000;
        const latestBt = Math.floor(Date.now() / tfMs) * tfMs;
        const pipeline = redis.pipeline();
        for (let i = 0; i < bars; i++) pipeline.get(`footprint:${symbol}:${tf}:${latestBt - i * tfMs}`);
        const results = await pipeline.exec();
        for (const [, v] of results) {
          if (!v) continue;
          try { footprintBars.push(JSON.parse(v)); } catch (_) {}
        }
        footprintBars.sort((a, b) => a.barTime - b.barTime);
      }

      return res.json({
        success:       true,
        symbol,
        timeframe:     tf,
        count:         footprintBars.length,
        footprintBars: footprintBars.slice(-bars),
      });
    } catch (err) {
      console.error(`[densityRoute] footprint error (${symbol}):`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/density/last-trade ─────────────────────────────
  router.get('/last-trade', (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol is required' });

    const trade = densityService.getLastTrade(symbol);
    if (!trade) {
      return res.status(404).json({ success: false, error: 'no_trade_data', symbol });
    }
    return res.json({ success: true, trade });
  });

  // ─── POST /api/density/activate ──────────────────────────────
  // Activates aggTrade collection for a symbol on demand (max MAX_SYMBOLS).
  router.post('/activate', (req, res) => {
    const symbol = ((req.body?.symbol || req.query.symbol || '') + '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol is required' });

    // Validate: alphanumeric only, 3–20 chars
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }

    const result = densityService.activateSymbol(symbol);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error, message: result.message });
    }
    return res.json({ success: true, symbol, alreadyActive: result.alreadyActive ?? false });
  });

  return router;
}

module.exports = { createDensityDomRouter };
