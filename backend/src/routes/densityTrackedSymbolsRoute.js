'use strict';

// ─── GET /api/density-tracked-symbols ────────────────────────────
//
// Debug endpoint to inspect the dynamic tracked symbols list.
//
// Query params:
//   marketType  (optional)  "spot" (default) | "futures"
//
// Response 200:
// {
//   "success":    true,
//   "marketType": "spot",
//   "ready":      true,
//   "updatedAt":  1773490018515,
//   "limit":      20,
//   "count":      18,
//   "symbols":    ["BTCUSDT", "ETHUSDT", ...],
//   "items": [
//     {
//       "symbol":        "BTCUSDT",
//       "trackingScore": 72.4,
//       "activityScore": 312000,
//       "impulseScore":  0.84,
//       "inPlayScore":   0.71,
//       "volumeUsdt60s": 4200000,
//       "tradeCount60s": 1840
//     },
//     ...   (top 50 by score)
//   ]
// }
//
// Response 200 { ready: false } if manager has not yet run.
//
function createDensityTrackedSymbolsHandler(redis) {
  return async function densityTrackedSymbolsHandler(req, res) {
    const marketType = (req.query.marketType || 'spot').toLowerCase();

    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success: false,
        error:   'Query param "marketType" must be "spot" or "futures"',
      });
    }

    const redisKey = marketType === 'futures'
      ? 'density:symbols:tracked:futures'
      : 'density:symbols:tracked:spot';

    try {
      const raw = await redis.get(redisKey);

      if (!raw) {
        return res.json({
          success:    true,
          marketType,
          ready:      false,
          message:    'Manager has not yet run — wait a few seconds and retry',
          symbols:    [],
          items:      [],
        });
      }

      const data = JSON.parse(raw);

      console.log(`[density-tracked] GET /api/density-tracked-symbols marketType=${marketType} count=${data.symbols?.length ?? 0}`);
      return res.json({
        success:    true,
        marketType,
        ready:      true,
        updatedAt:  data.updatedAt,
        limit:      data.limit,
        count:      (data.symbols || []).length,
        symbols:    data.symbols || [],
        items:      data.scored  || [],
      });
    } catch (err) {
      console.error('[density-tracked] GET /api/density-tracked-symbols error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDensityTrackedSymbolsHandler };
