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
// Response 200 { tracked: false, ladder: { bids:[], asks:[] }, ... } when orderbook data is
// not available (symbol not tracked or collector still initialising).
// This prevents the frontend from treating a missing-data state as a route error.
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
        console.log(`[density-view] GET /api/density-view symbol=${symbol} scale=${scale || 'x5'} → not tracked, returning empty 200`);
        return res.json({
          success:      true,
          symbol,
          tracked:      false,
          updatedAt:    null,
          bestBid:      null,
          bestAsk:      null,
          midPrice:     null,
          scale:        scale || 'x5',
          rangePct:     null,
          rangeLow:     null,
          rangeHigh:    null,
          ladder:       { bids: [], asks: [] },
          visibleWalls: [],
          depth:        { bids: [], asks: [] },
          stats:        null,
        });
      }

      console.log(`[density-view] GET /api/density-view symbol=${symbol} scale=${payload.scale}`);
      return res.json({ success: true, tracked: true, ...payload });
    } catch (err) {
      console.error(`[density-view] GET /api/density-view error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDensityViewHandler };
