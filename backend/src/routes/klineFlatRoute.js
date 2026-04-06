'use strict';

/**
 * klineFlatRoute.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/screener/kline-flat
 *
 * Batch volatility / flat-range check for a list of symbols.
 * Replaces per-symbol Binance REST calls that previously ran on the frontend.
 *
 * All data is read from Redis bars:1m:{SYM} (or bars:1m:spot:{SYM} for spot)
 * in a single pipeline — no Binance REST, no N+1.
 *
 * ── Request body ──────────────────────────────────────────────────────────
 * {
 *   symbols      : string[]   REQUIRED  e.g. ["BTCUSDT", "ETHUSDT"]
 *   marketType   : string     "futures" (default) | "spot"
 *   timeframe    : string     "5m" | "15m" | "30m" | "1h" | ...  (default "15m")
 *   flatThreshold: number     max rangePct to be considered flat    (default 0.5)
 * }
 *
 * ── Response ──────────────────────────────────────────────────────────────
 * {
 *   ts           : number,
 *   marketType   : "futures",
 *   timeframe    : "15m",
 *   barsUsed     : 15,
 *   flatThreshold: 0.5,
 *   count        : N,
 *   rows: [
 *     {
 *       symbol         : "BTCUSDT",
 *       open           : 65000,
 *       close          : 65100,
 *       high           : 65280,
 *       low            : 64980,
 *       rangePct       : 0.46,      // (high - low) / open * 100
 *       priceChangePct : 0.15,      // (close - open) / open * 100
 *       avgBarVolatility: 0.09,     // mean of per-bar (high-low)/open*100
 *       isFlat         : true,      // rangePct <= flatThreshold
 *       barsAvailable  : 15
 *     }
 *   ]
 * }
 *
 * Missing-data symbols return { symbol, isFlat: null, barsAvailable: 0,
 *   rangePct: null, ... } so the frontend can distinguish missing vs. flat.
 */

const { PERIOD_TO_BARS } = require('../services/klineStatsService');

const MAX_SYMBOLS        = 500;
const DEFAULT_TIMEFRAME  = '15m';
const DEFAULT_FLAT_THRESHOLD_PCT = 0.5;

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function fp(v, d = 4) {
  if (v == null || !isFinite(v)) return null;
  return parseFloat(v.toFixed(d));
}

function createKlineFlatRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.post('/', async (req, res) => {
    try {
      const body = req.body || {};

      // ── Validate input ──────────────────────────────────────────
      if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
        return res.status(400).json({ success: false, error: '`symbols` must be a non-empty array' });
      }
      if (body.symbols.length > MAX_SYMBOLS) {
        return res.status(400).json({ success: false, error: `Max ${MAX_SYMBOLS} symbols per request` });
      }

      const marketType  = (typeof body.marketType === 'string' ? body.marketType : 'futures').toLowerCase();
      if (marketType !== 'futures' && marketType !== 'spot') {
        return res.status(400).json({ success: false, error: '`marketType` must be futures or spot' });
      }

      const timeframe = (typeof body.timeframe === 'string' ? body.timeframe : DEFAULT_TIMEFRAME).toLowerCase();
      const barsNeeded = PERIOD_TO_BARS[timeframe];
      if (!barsNeeded) {
        return res.status(400).json({
          success: false,
          error: `Unsupported timeframe '${timeframe}'. Supported: ${Object.keys(PERIOD_TO_BARS).filter(p => p !== '24h').join(', ')}`,
        });
      }
      if (timeframe === '24h') {
        return res.status(400).json({ success: false, error: 'kline-flat does not support 24h timeframe' });
      }

      const flatThreshold = typeof body.flatThreshold === 'number'
        ? Math.max(0, Math.min(body.flatThreshold, 100))
        : DEFAULT_FLAT_THRESHOLD_PCT;

      // Sanitize and deduplicate symbol list
      const symbols = [...new Set(
        body.symbols
          .map(s => (typeof s === 'string' ? s.trim().toUpperCase() : null))
          .filter(s => s && SYMBOL_RE.test(s)),
      )];

      if (!symbols.length) {
        return res.status(400).json({ success: false, error: 'No valid symbols in request' });
      }

      // ── Batch read from Redis ────────────────────────────────────
      const barsKeyFn = marketType === 'spot'
        ? (sym) => `bars:1m:spot:${sym}`
        : (sym) => `bars:1m:${sym}`;

      const pipe = redis.pipeline();
      for (const sym of symbols) {
        pipe.zrange(barsKeyFn(sym), -barsNeeded, -1);
      }
      const results = await pipe.exec();

      // ── Compute per-symbol stats ─────────────────────────────────
      const rows = [];

      for (let i = 0; i < symbols.length; i++) {
        const sym    = symbols[i];
        const rawArr = results[i]?.[1];

        if (!Array.isArray(rawArr) || rawArr.length === 0) {
          rows.push({ symbol: sym, open: null, close: null, high: null, low: null,
            rangePct: null, priceChangePct: null, avgBarVolatility: null,
            isFlat: null, barsAvailable: 0 });
          continue;
        }

        const bars = rawArr.map(r => tryParse(r)).filter(Boolean);
        bars.sort((a, b) => a.ts - b.ts);

        if (!bars.length) {
          rows.push({ symbol: sym, open: null, close: null, high: null, low: null,
            rangePct: null, priceChangePct: null, avgBarVolatility: null,
            isFlat: null, barsAvailable: 0 });
          continue;
        }

        const open  = bars[0].open  ?? bars[0].close ?? 0;
        const close = bars[bars.length - 1].close ?? 0;

        let high = -Infinity, low = Infinity;
        let volatilitySum = 0, volatilityCount = 0;

        for (const b of bars) {
          if (b.high != null && b.high > high) high = b.high;
          if (b.low  != null && b.low  < low)  low  = b.low;

          // Per-bar volatility: (high-low)/open*100
          const barOpen = b.open ?? b.close ?? 0;
          if (barOpen > 0 && b.high != null && b.low != null) {
            volatilitySum   += ((b.high - b.low) / barOpen) * 100;
            volatilityCount++;
          }
        }

        if (high === -Infinity) high = close;
        if (low  === Infinity)  low  = close;

        const rangePct          = open > 0 ? ((high - low)  / open) * 100 : 0;
        const priceChangePct    = open > 0 ? ((close - open) / open) * 100 : 0;
        const avgBarVolatility  = volatilityCount > 0 ? volatilitySum / volatilityCount : null;

        rows.push({
          symbol           : sym,
          open             : fp(open,  8),
          close            : fp(close, 8),
          high             : fp(high,  8),
          low              : fp(low,   8),
          rangePct         : fp(rangePct,         4),
          priceChangePct   : fp(priceChangePct,   4),
          avgBarVolatility : fp(avgBarVolatility, 4),
          isFlat           : rangePct <= flatThreshold,
          barsAvailable    : bars.length,
        });
      }

      return res.json({
        ts           : Date.now(),
        marketType,
        timeframe,
        barsUsed     : barsNeeded,
        flatThreshold,
        count        : rows.length,
        rows,
      });
    } catch (err) {
      console.error('[klineFlatRoute] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createKlineFlatRouter };
