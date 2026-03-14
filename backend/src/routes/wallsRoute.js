'use strict';

// ─── GET /api/walls ───────────────────────────────────────────────
//
// Query params:
//   symbol     (required)  e.g. BTCUSDT
//   marketType (optional)  "spot" (default) | "futures"
//
// Redis keys:
//   spot:    walls:${symbol}
//   futures: futures:walls:${symbol}
//
// Response 200:
// {
//   success:    true,
//   symbol:     "BTCUSDT",
//   marketType: "spot" | "futures",
//   walls: {
//     symbol:        string,
//     marketType:    "spot" | "futures",
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
//         source:            "orderbook" | "futures:orderbook",
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
// Does NOT silently fall back to spot when futures key is absent.
//
function createWallsHandler(redis) {
  return async function wallsHandler(req, res) {
    const symbol     = (req.query.symbol     || '').toUpperCase().trim();
    const marketType = (req.query.marketType || 'spot').toLowerCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }
    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success:    false,
        error:      'Query param "marketType" must be "spot" or "futures"',
        marketType,
      });
    }

    const redisKey = marketType === 'futures'
      ? `futures:walls:${symbol}`
      : `walls:${symbol}`;

    try {
      const raw = await redis.get(redisKey);

      console.log(`[walls] GET /api/walls symbol=${symbol} marketType=${marketType} key=${redisKey} found=${raw !== null}`);

      if (raw === null) {
        return res.status(404).json({
          success:    false,
          error:      `Walls data not available — symbol may not be tracked or ${marketType} detector is still initialising`,
          symbol,
          marketType,
          redisKey,
        });
      }

      return res.json({ success: true, symbol, marketType, walls: JSON.parse(raw) });
    } catch (err) {
      console.error(`[walls] GET /api/walls error symbol=${symbol} marketType=${marketType}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallsHandler };
