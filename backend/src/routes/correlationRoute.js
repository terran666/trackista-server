'use strict';

/**
 * correlationRoute — GET /api/correlation/*
 *
 * Serves pre-computed correlation data from Redis.
 * Data is written every 60s by correlationService.
 *
 * Keys read:
 *   correlation:btc:current:<SYM>:<TF>:<WINDOW>
 *
 * Endpoints:
 *   GET /api/correlation/btc/current/:symbol           — all configs for one symbol
 *   GET /api/correlation/btc/list?symbols=X,Y&tf=5m&window=20  — batch for screener
 *   GET /api/correlation/btc/summary?tf=5m&window=20   — aggregate stats
 */

const STALE_THRESHOLDS = {
  '1m' :  3 * 60 * 1000,
  '5m' : 10 * 60 * 1000,
  '15m': 30 * 60 * 1000,
  '1h' :  2 * 60 * 60 * 1000,
  '4h' :  8 * 60 * 60 * 1000,
  '6h' : 12 * 60 * 60 * 1000,
  '12h': 24 * 60 * 60 * 1000,
  '24h': 48 * 60 * 60 * 1000,
};

// Must match correlationService CONFIGS
const CONFIGS = [
  { tf: '1m',  window: 20 },
  { tf: '1m',  window: 50 },
  { tf: '5m',  window: 20 },
  { tf: '5m',  window: 50 },
  { tf: '15m', window: 20 },
  { tf: '1h',  window: 20 },
  { tf: '4h',  window:  5 },
  { tf: '6h',  window:  3 },
  { tf: '12h', window: 12 },
  { tf: '24h', window: 24 },
];

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function markStale(obj) {
  if (!obj) return obj;
  const threshold = STALE_THRESHOLDS[obj.timeframe] || 10 * 60 * 1000;
  obj.staleFlag = (Date.now() - (obj.updatedAt || 0)) > threshold;
  return obj;
}

function createCorrelationRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  // GET /api/correlation/btc/current/:symbol
  // Returns all correlation configs for one symbol
  router.get('/btc/current/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const pipe = redis.pipeline();
      for (const { tf, window } of CONFIGS) {
        pipe.get(`correlation:btc:current:${symbol}:${tf}:${window}`);
      }
      const results = await pipe.exec();

      const items = [];
      for (const [err, raw] of results) {
        if (err || !raw) continue;
        const obj = tryParse(raw);
        if (obj) items.push(markStale(obj));
      }

      if (!items.length) {
        return res.status(404).json({
          success: false,
          error  : 'No correlation data — service may still be warming up (first run in ~15s)',
          symbol,
        });
      }

      return res.json({ ts: Date.now(), symbol, btcSymbol: 'BTCUSDT', items });
    } catch (err) {
      console.error(`[correlationRoute] /btc/current/${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/correlation/btc/list?symbols=ETHUSDT,SOLUSDT&tf=5m&window=20
  // Omit symbols → all active futures
  router.get('/btc/list', async (req, res) => {
    try {
      const tf     = (req.query.tf     || '5m').toLowerCase();
      const window = parseInt(req.query.window || '20', 10);
      const symList = req.query.symbols;

      let symbols;
      if (symList) {
        symbols = symList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      } else {
        const raw = await redis.get('symbols:active:usdt');
        symbols   = tryParse(raw) || [];
      }

      if (!symbols.length) {
        return res.json({ ts: Date.now(), timeframe: tf, window, count: 0, rows: [] });
      }

      const pipe = redis.pipeline();
      for (const sym of symbols) {
        pipe.get(`correlation:btc:current:${sym}:${tf}:${window}`);
      }
      const results = await pipe.exec();

      const rows = [];
      for (let i = 0; i < symbols.length; i++) {
        const raw = results[i]?.[1];
        if (!raw) continue;
        const obj = tryParse(raw);
        if (obj) rows.push(markStale(obj));
      }

      // Sort by correlationToBtc desc (highest positive first)
      rows.sort((a, b) => (b.correlationToBtc ?? -2) - (a.correlationToBtc ?? -2));

      return res.json({ ts: Date.now(), timeframe: tf, window, count: rows.length, rows });
    } catch (err) {
      console.error('[correlationRoute] /btc/list:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/correlation/btc/summary?tf=5m&window=20
  router.get('/btc/summary', async (req, res) => {
    try {
      const tf     = (req.query.tf     || '5m').toLowerCase();
      const window = parseInt(req.query.window || '20', 10);

      const rawSyms = await redis.get('symbols:active:usdt');
      const symbols = tryParse(rawSyms) || [];

      const pipe = redis.pipeline();
      for (const sym of symbols) {
        pipe.get(`correlation:btc:current:${sym}:${tf}:${window}`);
      }
      const results = await pipe.exec();

      const stateCounts  = {};
      const biasCounts   = {};
      let totalCount = 0;
      let sumCorr    = 0;

      for (const [err, raw] of results) {
        if (err || !raw) continue;
        const obj = tryParse(raw);
        if (!obj || obj.correlationToBtc == null) continue;
        totalCount++;
        sumCorr += obj.correlationToBtc;
        if (obj.correlationState) stateCounts[obj.correlationState] = (stateCounts[obj.correlationState] || 0) + 1;
        if (obj.correlationBias)  biasCounts[obj.correlationBias]   = (biasCounts[obj.correlationBias]   || 0) + 1;
      }

      return res.json({
        ts            : Date.now(),
        timeframe     : tf,
        window,
        totalSymbols  : totalCount,
        avgCorrelation: totalCount > 0 ? parseFloat((sumCorr / totalCount).toFixed(4)) : null,
        stateCounts,
        biasCounts,
      });
    } catch (err) {
      console.error('[correlationRoute] /btc/summary:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createCorrelationRouter };
