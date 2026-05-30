'use strict';

const { buildWallWatchlist } = require('../services/density/wallWatchlistBuilder');

// ─── GET /api/wall-watchlist ──────────────────────────────────────
//
// Query params:
//   symbols    (optional)  comma-separated, e.g. BTCUSDT,ETHUSDT
//                          if omitted → uses symbols:active:usdt (same as TestPage)
//   marketType (optional)  "spot" (default) | "futures"
//   limit      (optional)  max symbols to process (default: all, cap: 500)
//
// Response 200:
// {
//   "success":    true,
//   "marketType": "spot" | "futures",
//   "count":      N,
//   "items": [
//     {
//       "symbol":       "BTCUSDT",
//       "side":         "bid" | "ask",
//       "wallUsd":      3200000,
//       "price":        70620,
//       "distancePct":  0.08,
//       "lifetimeMs":   12600,
//       "strength":     18.4,
//       "etaSec":       null,
//       "bias":         "LONG" | "SHORT" | "NEUTRAL",
//       "midPrice":     70779.77,
//       "updatedAt":    1773490018515,
//       "marketType":   "spot"
//     }
//   ]
// }
//
// Only tracked symbols (those with walls data in Redis) appear in items.
// Rows sorted: nearest distancePct → longest lifetime → strongest → largest USD.
//
function createWallWatchlistHandler(redis) {
  return async function wallWatchlistHandler(req, res) {
    const symbolsParam = (req.query.symbols    || '').trim() || undefined;
    const marketType   = (req.query.marketType || 'spot').toLowerCase();
    const limitRaw     = parseInt(req.query.limit || '0', 10);
    // Cap user-supplied limit so a malicious client can't pin us to a huge
    // pipeline. The builder still defaults to "all tracked" when omitted.
    const limit        = limitRaw > 0 ? Math.min(limitRaw, 500) : undefined;

    // Reject pathologically long `symbols` lists outright \u2014 they would force
    // us to allocate state for thousands of pairs even before the limit
    // intersection runs.
    if (symbolsParam && symbolsParam.split(',').length > 500) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbols" must contain no more than 500 entries',
      });
    }

    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success: false,
        error:   'Query param "marketType" must be "spot" or "futures"',
      });
    }

    try {
      const { items, marketType: mt, updatedAt } = await buildWallWatchlist(redis, {
        symbolsParam,
        limit,
        marketType,
      });

      console.log(`[wall-watchlist] GET /api/wall-watchlist marketType=${mt} count=${items.length}`);
      return res.json({
        success:    true,
        marketType: mt,
        count:      items.length,
        updatedAt,
        items,
      });
    } catch (err) {
      console.error('[wall-watchlist] GET /api/wall-watchlist error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallWatchlistHandler };
