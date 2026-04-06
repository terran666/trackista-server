'use strict';

/**
 * klineStatsRoute — GET /api/screener/kline-stats
 *
 * Delegates to klineStatsService for both single-period and multi-period modes.
 *
 * ── Single-period mode (backwards-compatible) ─────────────────────────────
 * GET /api/screener/kline-stats?period=15m
 *   period   1m|5m|15m|30m|1h|2h|4h|6h|12h|24h  (default 15m)
 *   market   futures|spot                          (default futures)
 *   symbols  comma-separated list                  (optional; omit = all active)
 * Response: { ts, period, barsRequested, market, count, rows: PeriodStatsRow[] }
 *
 * ── Multi-period mode ─────────────────────────────────────────────────────
 * GET /api/screener/kline-stats?periods=5m,15m
 *   periods  comma-separated list of up to 6 periods  (required for this mode)
 *   market   futures|spot                              (default futures)
 *   symbols  comma-separated list                      (optional)
 *   sortBy   period name to sort rows by               (default = first period)
 * Response:
 * {
 *   ts, market, periods: ['5m','15m'], sortedBy: '15m', count: N,
 *   rows: [
 *     { symbol: 'BTCUSDT', '5m': { priceChangePercent, volume, ... },
 *                          '15m': { priceChangePercent, volume, ... } }
 *   ]
 * }
 *
 * In multi-period mode a single pipeline read fetches max(bars_needed) bars
 * per symbol and then slices the array for each requested period — no
 * repeated Redis reads.
 */

const {
  PERIOD_TO_BARS,
  getSinglePeriodStats,
  getMultiPeriodStats,
} = require('../services/klineStatsService');

function createKlineStatsRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const market   = (req.query.market  || 'futures').toLowerCase();
      const symList  = req.query.symbols;
      const symbols  = symList
        ? symList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
        : undefined;

      // ── Multi-period mode ─────────────────────────────────────
      if (req.query.periods) {
        const periods = req.query.periods.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const sortBy  = req.query.sortBy ? req.query.sortBy.toLowerCase() : undefined;

        const result = await getMultiPeriodStats(redis, {
          periods,
          market,
          symbols,
          sortBy,
        });
        return res.json(result);
      }

      // ── Single-period mode (backwards-compat) ─────────────────
      const period     = (req.query.period || '15m').toLowerCase();
      const barsNeeded = PERIOD_TO_BARS[period];
      if (!barsNeeded) {
        return res.status(400).json({
          success: false,
          error  : `Unsupported period '${period}'. Supported: ${Object.keys(PERIOD_TO_BARS).join(', ')}`,
        });
      }

      const result = await getSinglePeriodStats(redis, { period, market, symbols });
      return res.json(result);
    } catch (err) {
      console.error('[klineStatsRoute] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createKlineStatsRouter };
