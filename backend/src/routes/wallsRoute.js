'use strict';

// ─── GET /api/walls ───────────────────────────────────────────────
//
// Query params:
//   symbol          (required)  e.g. BTCUSDT
//   marketType      (optional)  "spot" (default) | "futures" | "all"
//   state           (optional)  "confirmed" | "persistent" | "all" (default: all)
//   minQualityScore (optional)  number 0–100 (default: 0)
//   hideSpoof       (optional)  "true" | "false" (default: false)
//   sourceUniverse  (optional)  "testpage" | any — future filter, currently informational
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
// Response 200 { tracked: false, walls: { walls: [] } } when symbol is not in the
// tracked watchlist or wall detector has not yet flushed for this symbol.
// This prevents the frontend from treating a missing-data state as a route error.
//
function createWallsHandler(redis) {
  return async function wallsHandler(req, res) {
    const symbol          = (req.query.symbol     || '').toUpperCase().trim();
    const marketType      = (req.query.marketType || 'spot').toLowerCase();
    const stateFilter     = (req.query.state      || 'all').toLowerCase();
    const minQuality      = parseInt(req.query.minQualityScore || '0', 10);
    const hideSpoof       = req.query.hideSpoof === 'true';

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
        console.log(`[walls] GET /api/walls symbol=${symbol} marketType=${marketType} key=${redisKey} found=false → returning empty 200`);
        return res.json({
          success:    true,
          symbol,
          marketType,
          tracked:    false,
          walls: {
            symbol,
            marketType,
            updatedAt:      null,
            bestBid:        null,
            bestAsk:        null,
            midPrice:       null,
            wallThreshold:  null,
            walls:          [],
          },
        });
      }

      const parsed = JSON.parse(raw);

      // Apply optional filters to walls array
      if (parsed.walls && Array.isArray(parsed.walls)) {
        let walls = parsed.walls;
        if (stateFilter !== 'all') {
          walls = walls.filter(w => w.status === stateFilter);
        }
        if (minQuality > 0) {
          walls = walls.filter(w => (w.qualityScore ?? 0) >= minQuality);
        }
        if (hideSpoof) {
          walls = walls.filter(w => !(w.isSuspiciousSpoof ?? false));
        }
        parsed.walls = walls;
      }

      return res.json({ success: true, symbol, marketType, tracked: true, walls: parsed });
    } catch (err) {
      console.error(`[walls] GET /api/walls error symbol=${symbol} marketType=${marketType}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallsHandler };
