'use strict';

// ─── GET /api/walls ───────────────────────────────────────────────
//
// Query params (required): symbol
//
// Reads the walls payload written by wallDetector (via orderbookCollector
// flush) from Redis key  walls:${symbol}
//
// Response 200:
// {
//   success:   true,
//   symbol:    "BTCUSDT",
//   walls: {
//     symbol:        string,
//     marketType:    "spot",
//     updatedAt:     number (ms),
//     bestBid:       number | null,
//     bestAsk:       number | null,
//     midPrice:      number | null,
//     wallThreshold: number,   // USD threshold used for this symbol (volume-tier based)
//     walls: [
//       {
//         side:              "bid" | "ask",
//         price:             number,
//         rawPrice:          number,   // same as price — confirms no rounding/bucketing
//         size:              number,
//         usdValue:          number,
//         distancePct:       number,
//         strength:          number | null,
//         source:            "orderbook",
//         sourceUpdatedAt:   number (ms),
//         exactLevelMatched: true,
//         firstSeenTs:       number (ms),
//         lastSeenTs:        number (ms),
//         lifetimeMs:        number,
//       },
//       ...                           // sorted by usdValue desc
//     ]
//   }
// }
//
// Response 404 if symbol not tracked or detector not yet flushed.
//
function createWallsHandler(redis) {
  return async function wallsHandler(req, res) {
    const symbol = (req.query.symbol || '').toUpperCase().trim();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }

    try {
      const raw = await redis.get(`walls:${symbol}`);

      if (raw === null) {
        return res.status(404).json({
          success: false,
          error:   'Walls data not available — symbol may not be tracked or detector is still initialising',
          symbol,
        });
      }

      console.log(`[walls] GET /api/walls symbol=${symbol}`);
      return res.json({ success: true, symbol, walls: JSON.parse(raw) });
    } catch (err) {
      console.error(`[walls] GET /api/walls error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallsHandler };
