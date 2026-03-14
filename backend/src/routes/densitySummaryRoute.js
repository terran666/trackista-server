'use strict';

const { buildDensitySummary } = require('../services/density/densitySummaryBuilder');

// ─── GET /api/density-summary ─────────────────────────────────────
//
// Query params (all optional):
//   symbols  Comma-separated list, e.g. BTCUSDT,ETHUSDT
//            If omitted, the full active universe (symbols:active:usdt) is used.
//   limit    Max number of symbols to return (default: all, cap: 500)
//            Applied after symbol resolution, before sorting.
//
// Response 200:
// {
//   "success": true,
//   "count": N,
//   "items": [
//     {
//       "symbol":                "BTCUSDT",
//       "midPrice":              70653.79,
//       "bestBid":               70653.78,
//       "bestAsk":               70653.80,
//       "spreadPct":             0.000000283,
//       "wallsCount":            6,
//       "bidWallsCount":         2,
//       "askWallsCount":         4,
//       "nearestWallDistancePct": 0.08,
//       "volumeUsdt60s":         4200000,
//       "tradeCount60s":         1840,
//       "deltaImbalancePct60s":  0.32,
//       "activityScore":         0.78,
//       "impulseScore":          0.61,
//       "impulseDirection":      "up",
//       "bias":                  "LONG",
//       "updatedAt":             1773473060217
//     },
//     ...
//   ]
// }
//
// Items are sorted by activityScore DESC (nulls last).
// Symbols with no orderbook data are included with null numeric fields.
//
function createDensitySummaryHandler(redis) {
  return async function densitySummaryHandler(req, res) {
    const symbolsParam = (req.query.symbols    || '').trim() || undefined;
    const limitRaw     = parseInt(req.query.limit || '0', 10);
    const limit        = limitRaw > 0 ? limitRaw : undefined;
    const marketType   = (req.query.marketType || 'spot').toLowerCase();

    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success: false,
        error:   'Query param "marketType" must be "spot" or "futures"',
      });
    }

    try {
      const { items, marketType: mt } = await buildDensitySummary(redis, { symbolsParam, limit, marketType });

      console.log(`[density-summary] GET /api/density-summary marketType=${mt} count=${items.length}`);
      return res.json({
        success:    true,
        marketType: mt,
        count:      items.length,
        items,
      });
    } catch (err) {
      console.error('[density-summary] GET /api/density-summary error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDensitySummaryHandler };
