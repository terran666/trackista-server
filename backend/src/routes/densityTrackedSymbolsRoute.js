'use strict';

// ─── GET /api/density-tracked-symbols   (legacy / backward compat) ───────────
// ─── GET /api/density/tracked-symbols   (new — includes score/reason data) ───
//
// Debug endpoint to inspect the dynamic tracked symbols list.
//
// Query params:
//   marketType  (optional)  "spot" (default) | "futures"
//
// Legacy response 200:
// {
//   "success":    true,
//   "marketType": "futures",
//   "ready":      true,
//   "updatedAt":  1773490018515,
//   "count":      105,
//   "symbols":    ["BTCUSDT", ...],
//   "items":      [...],              ← from density:symbols:tracked:futures
// }
//
// New response 200 (also includes ranked):
// {
//   ...same as legacy...,
//   "ranked": {
//     "updatedAt":   ...,
//     "categories":  { CORE: 5, WALL_ANOMALY: 40, MOMENTUM: 28, LIQUIDITY: 18 },
//     "symbols": [
//       { symbol, reason, densityScore, wallRankScore, momentumScore, maxWallUsd, ... },
//       ...
//     ]
//   }
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
      // Fetch legacy key and new ranked key in parallel
      const [raw, rankedRaw] = await Promise.all([
        redis.get(redisKey),
        marketType === 'futures' ? redis.get('density:symbols:ranked') : Promise.resolve(null),
      ]);

      if (!raw) {
        return res.json({
          success:    true,
          marketType,
          ready:      false,
          message:    'Manager has not yet run — wait a few seconds and retry',
          symbols:    [],
          items:      [],
          ranked:     null,
        });
      }

      const data   = JSON.parse(raw);
      const ranked = rankedRaw ? JSON.parse(rankedRaw) : null;

      // Prefer symbol list from density:symbols:ranked (more up-to-date category logic)
      // but fall back to legacy list for backward compat
      const symbols = (ranked?.symbols?.map(s => s.symbol)) || data.symbols || [];

      console.log(
        `[density-tracked] GET marketType=${marketType} count=${symbols.length}` +
        (ranked ? ` ranked_categories=${JSON.stringify(ranked.categories)}` : ''),
      );
      return res.json({
        success:    true,
        marketType,
        ready:      true,
        updatedAt:  data.updatedAt,
        limit:      data.limit,
        count:      symbols.length,
        symbols,
        items:      data.scored  || [],
        ranked:     ranked ?? null,
      });
    } catch (err) {
      console.error('[density-tracked] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDensityTrackedSymbolsHandler };
