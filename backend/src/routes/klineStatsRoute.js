'use strict';

/**
 * klineStatsRoute — GET /api/screener/kline-stats
 *
 * Aggregates N last 1m bars from Redis (`bars:1m:<SYM>`) to produce
 * per-symbol stats for arbitrary periods without hitting Binance.
 *
 * Why: Binance FAPI /fapi/v1/ticker/24hr ignores windowSize — always returns
 * 24h data. Spot /api/v3/ticker supports windowSize, futures does not.
 * This endpoint serves futures kline-period stats from already-collected bars.
 *
 * GET /api/screener/kline-stats
 *
 * Query params:
 *   period   5m|15m|30m|1h|2h|4h|6h|12h|24h   (default: 15m)
 *   market   futures|spot                        (default: futures; spot not yet supported)
 *   symbols  comma-separated list               (optional; omit = all active symbols)
 *
 * Response:
 * {
 *   ts: number,
 *   period: "15m",
 *   barsRequested: 15,
 *   market: "futures",
 *   count: 443,
 *   rows: [
 *     {
 *       symbol: "BTCUSDT",
 *       tradeCount: 12400,
 *       volume: 45832910.5,       // quote USDT
 *       buyVolume: 24000000,
 *       sellVolume: 21832910,
 *       delta: 2167090,
 *       priceChangePercent: 0.42, // (lastClose - firstOpen) / firstOpen * 100
 *       high: 65500,
 *       low: 64800,
 *       barsAvailable: 15,        // actual bars found (may be < barsRequested)
 *     }
 *   ]
 * }
 */

const PERIOD_TO_BARS = {
  '5m' : 5,
  '15m': 15,
  '30m': 30,
  '1h' : 60,
  '2h' : 120,
  '4h' : 240,
  '6h' : 360,
  '12h': 720,
  '24h': 1440,
};

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Aggregate an array of 1m bars (sorted ASC by ts) into a single period row.
 */
function aggregateBars(symbol, bars) {
  if (!bars.length) return null;

  // Sort ascending to get correct open/close
  bars.sort((a, b) => a.ts - b.ts);

  const firstBar = bars[0];
  const lastBar  = bars[bars.length - 1];

  const open  = firstBar.open  ?? firstBar.close;
  const close = lastBar.close;
  const priceChangePercent = (open && open !== 0)
    ? ((close - open) / open) * 100
    : 0;

  let high  = -Infinity;
  let low   = Infinity;
  let volume     = 0;
  let buyVolume  = 0;
  let sellVolume = 0;
  let delta      = 0;
  let tradeCount = 0;

  for (const b of bars) {
    if (b.high != null && b.high > high) high = b.high;
    if (b.low  != null && b.low  < low)  low  = b.low;
    volume     += b.volumeUsdt    ?? 0;
    buyVolume  += b.buyVolumeUsdt ?? 0;
    sellVolume += b.sellVolumeUsdt ?? 0;
    delta      += b.deltaUsdt     ?? 0;
    tradeCount += b.tradeCount    ?? 0;
  }

  if (high === -Infinity) high = close;
  if (low  === Infinity)  low  = close;

  return {
    symbol,
    tradeCount         : Math.round(tradeCount),
    volume             : parseFloat(volume.toFixed(2)),
    buyVolume          : parseFloat(buyVolume.toFixed(2)),
    sellVolume         : parseFloat(sellVolume.toFixed(2)),
    delta              : parseFloat(delta.toFixed(2)),
    priceChangePercent : parseFloat(priceChangePercent.toFixed(4)),
    high               : parseFloat(high.toFixed(8)),
    low                : parseFloat(low.toFixed(8)),
    open               : parseFloat((open ?? 0).toFixed(8)),
    close              : parseFloat((close ?? 0).toFixed(8)),
    barsAvailable      : bars.length,
  };
}

function createKlineStatsRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const period  = (req.query.period  || '15m').toLowerCase();
      const market  = (req.query.market  || 'futures').toLowerCase();
      const symList = req.query.symbols;

      const barsNeeded = PERIOD_TO_BARS[period];
      if (!barsNeeded) {
        return res.status(400).json({
          success: false,
          error  : `Unsupported period '${period}'. Supported: ${Object.keys(PERIOD_TO_BARS).join(', ')}`,
        });
      }

      // ── Symbol list ───────────────────────────────────────────────
      let symbols;
      if (symList) {
        symbols = symList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      } else {
        const raw = await redis.get('symbols:active:usdt');
        symbols   = tryParse(raw) || [];
      }

      if (!symbols.length) {
        return res.json({ ts: Date.now(), period, barsRequested: barsNeeded, market, count: 0, rows: [] });
      }

      // ── 24h: берём готовые данные из Binance тикеров ─────────────
      if (period === '24h') {
        const rawTickers = await redis.get('futures:tickers:all');
        const tickers    = tryParse(rawTickers) || [];

        // Фильтруем по запрошенным символам (если задан symList)
        const symSet = symList ? new Set(symbols) : null;
        const rows   = [];

        for (const t of tickers) {
          if (symSet && !symSet.has(t.symbol)) continue;
          if (!t.symbol || !t.symbol.endsWith('USDT')) continue;

          rows.push({
            symbol             : t.symbol,
            tradeCount         : parseInt(t.count, 10)         || 0,
            volume             : parseFloat(t.quoteVolume)     || 0,
            buyVolume          : null,
            sellVolume         : null,
            delta              : null,
            priceChangePercent : parseFloat(t.priceChangePercent) || 0,
            high               : parseFloat(t.highPrice)       || 0,
            low                : parseFloat(t.lowPrice)        || 0,
            open               : parseFloat(t.openPrice)       || 0,
            close              : parseFloat(t.lastPrice)       || 0,
            barsAvailable      : null,
            source             : 'binance_24h',
          });
        }

        rows.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

        return res.json({
          ts           : Date.now(),
          period,
          barsRequested: barsNeeded,
          market,
          count        : rows.length,
          rows,
        });
      }

      // ── <24h: агрегируем из 1m баров ─────────────────────────────
      const pipe = redis.pipeline();
      for (const sym of symbols) {
        pipe.zrange(`bars:1m:${sym}`, -barsNeeded, -1);
      }
      const results = await pipe.exec();

      const rows = [];
      for (let i = 0; i < symbols.length; i++) {
        const sym     = symbols[i];
        const rawArr  = results[i]?.[1];
        if (!Array.isArray(rawArr) || rawArr.length === 0) continue;

        const bars = rawArr.map(r => tryParse(r)).filter(Boolean);
        if (!bars.length) continue;

        const row = aggregateBars(sym, bars);
        if (row) rows.push(row);
      }

      // Sort by |priceChangePercent| desc by default
      rows.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

      return res.json({
        ts           : Date.now(),
        period,
        barsRequested: barsNeeded,
        market,
        count        : rows.length,
        rows,
      });
    } catch (err) {
      console.error('[klineStatsRoute] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createKlineStatsRouter };
