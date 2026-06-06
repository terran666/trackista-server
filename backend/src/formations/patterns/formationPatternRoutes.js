'use strict';

/**
 * formationPatternRoutes.js
 * REST surface for the Extreme Pattern Formations.
 *
 *   GET /api/formations/patterns          — list active formations
 *   GET /api/formations/patterns/:symbol  — formations for one symbol
 *   GET /api/formations/patterns/debug    — debug info
 */

const express = require('express');

const VISIBLE_STATUSES = new Set(['FORMING', 'READY', 'BREAKOUT', 'RETEST', 'FAILED']);

function parseBool(v) {
  return v === 'true' || v === '1' || v === true;
}

function parseInt10(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function createFormationPatternRoutes({ service, store }) {
  const router = express.Router();

  // ── GET /api/formations/patterns ──────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const q = req.query;

      // Filters
      const filterSymbol        = q.symbol     ? String(q.symbol).toUpperCase().trim()  : null;
      const filterTf            = q.tf          ? String(q.tf).trim()                   : null;
      const filterDirection     = q.direction   ? String(q.direction).toUpperCase().trim(): null;
      const filterFormationType = q.formationType? String(q.formationType).toUpperCase().trim(): null;
      const filterStatus        = q.status      ? String(q.status).toUpperCase().trim() : null;
      const filterMarket        = q.market      ? String(q.market).toLowerCase().trim() : null;
      const filterMinScore      = parseInt10(q.minScore, 0);
      const uniqueSymbol        = parseBool(q.uniqueSymbol);
      const limit               = parseInt10(q.limit, 500);

      const all = await store.getActive();

      let items = all.filter(f => {
        if (!VISIBLE_STATUSES.has(f.status ?? '')) return false;
        if (filterSymbol        && f.symbol        !== filterSymbol)        return false;
        if (filterTf            && f.mainTf         !== filterTf)           return false;
        if (filterDirection     && f.direction       !== filterDirection)    return false;
        if (filterFormationType && f.formationType   !== filterFormationType) return false;
        if (filterStatus        && f.status          !== filterStatus)       return false;
        if (filterMarket        && f.marketType       !== filterMarket)      return false;
        if ((f.score ?? 0)       < filterMinScore) return false;
        return true;
      });

      // uniqueSymbol: keep only highest-scored per symbol
      if (uniqueSymbol) {
        const best = new Map();
        for (const f of items) {
          const existing = best.get(f.symbol);
          if (!existing || (f.score ?? 0) > (existing.score ?? 0)) best.set(f.symbol, f);
        }
        items = [...best.values()];
      }

      // Sort: score DESC, then createdAt ASC (stable cards)
      items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
      items = items.slice(0, limit);

      res.json({
        success: true,
        count: items.length,
        items,
        // legacy field aliases
        formations: items,
        data: items,
      });
    } catch (e) {
      console.error('[patternRoutes] GET / error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /api/formations/patterns/debug ────────────────────────────────────
  router.get('/debug', async (req, res) => {
    try {
      const symbol    = req.query.symbol    ? String(req.query.symbol).toUpperCase().trim()  : null;
      const tf        = req.query.tf        ? String(req.query.tf).trim()                   : null;
      const marketType = req.query.marketType || req.query.market || 'futures';

      const svcStats = service.getStats();
      const logs     = service.getDebugLogs(symbol, tf);

      // Split logs into reject reasons and accepted scans
      const rejected = logs.filter(e => e.rejectReason);
      const accepted = logs.filter(e => e.event === 'SCAN_COMPLETE' && e.candidatesFound > 0);

      // Active formations for this symbol
      let formations = [];
      if (symbol) {
        formations = await store.getBySymbol(symbol);
        if (tf) formations = formations.filter(f => f.mainTf === tf);
      }

      res.json({
        success: true,
        symbol,
        tf,
        marketType,
        serviceStats: svcStats,
        binanceRestCount: svcStats.binanceRestCount,
        binanceRateLimited: svcStats.binanceRateLimited,
        formationsActive: formations.length,
        formations,
        rejected,
        accepted,
        debugLogs: logs,
      });
    } catch (e) {
      console.error('[patternRoutes] GET /debug error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /api/formations/patterns/:symbol ──────────────────────────────────
  router.get('/:symbol', async (req, res) => {
    try {
      const symbol = String(req.params.symbol).toUpperCase().trim();
      const tf     = req.query.tf ? String(req.query.tf).trim() : null;

      let items = await store.getBySymbol(symbol);
      if (tf) items = items.filter(f => f.mainTf === tf);
      items = items.filter(f => VISIBLE_STATUSES.has(f.status ?? ''));
      items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      res.json({ success: true, symbol, count: items.length, items });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createFormationPatternRoutes };
