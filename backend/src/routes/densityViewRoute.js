'use strict';

const { buildDensityView } = require('../services/density/densityViewBuilder');

// ─── GET /api/density-view ────────────────────────────────────────
//
// Query params:
//   symbol  (required)  e.g. BTCUSDT
//   scale   (optional)  x1 | x2 | x5 | x10 | x25  (default: x5)
//
// Response 200:
// {
//   "success":    true,
//   "symbol":     "BTCUSDT",
//   "updatedAt":  <ms>,
//   "bestBid":    <number|null>,
//   "bestAsk":    <number|null>,
//   "midPrice":   <number|null>,
//   "scale":      "x5",
//   "rangePct":   0.005,
//   "rangeLow":   <number|null>,
//   "rangeHigh":  <number|null>,
//   "ladder":     { "bids": [...], "asks": [...] },
//   "visibleWalls": [ { side, price, size, usdValue, distancePct, isNearPrice } ],
//   "depth":      { "bids": [ { price, cumUsd } ], "asks": [ { price, cumUsd } ] },
//   "stats":      null   // TODO: 24h metrics
// }
//
// Response 404 if orderbook data is not yet available in Redis.
//
function createDensityViewHandler(redis) {
  return async function densityViewHandler(req, res) {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    const scale  = (req.query.scale  || '').trim();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }

    try {
      const payload = await buildDensityView(redis, symbol, scale || undefined);

      if (payload === null) {
        return res.status(404).json({
          success: false,
          error:   'Orderbook data not available — symbol may not be tracked or collector is still initialising',
          symbol,
        });
      }

      console.log(`[density-view] GET /api/density-view symbol=${symbol} scale=${payload.scale}`);
      return res.json({ success: true, ...payload });
    } catch (err) {
      console.error(`[density-view] GET /api/density-view error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDensityViewHandler };
