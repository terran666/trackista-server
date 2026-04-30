'use strict';

// ─── GET /api/orderbook ───────────────────────────────────────────
//
// Query params:
//   symbol     (required)  e.g. SOLUSDT
//   marketType (optional)  "spot" (default) | "futures"
//
// Redis keys:
//   spot:    orderbook:${symbol}
//   futures: futures:orderbook:${symbol}
//
// ═══════════════════════════════════════════════════════════════════
// RAW ORDERBOOK CONTRACT  (do NOT break this for frontend consumers)
// ═══════════════════════════════════════════════════════════════════
//
// Response 200:
// {
//   success:   true,
//   symbol:    "SOLUSDT",
//   marketType: "spot" | "futures",
//   orderbook: {
//     symbol:     string,
//     marketType: "spot" | "futures",
//     ladderMode: "raw",
//     updatedAt:  number (unix ms),
//     bestBid:    number | null,
//     bestAsk:    number | null,
//     midPrice:   number | null,
//
//     bids: [   // top 200 bid levels, sorted descending by price
//       { price, rawPrice, size, usdValue },
//       ...
//     ],
//     asks: [   // top 200 ask levels, sorted ascending by price
//       { price, rawPrice, size, usdValue },
//       ...
//     ],
//   }
// }
//
// CONTRACT GUARANTEES:
//   1. Each bids[i] / asks[i] = exactly ONE Binance price level. No aggregation.
//   2. usdValue = parseFloat((price * size).toFixed(2)) — per-level only.
//   3. Bids descending, asks ascending by price.
//   4. Wall prices correspond to exact price levels in this list.
//   5. /api/density-view ladder uses the same raw data — never aggregated.
//
// Response 404 if symbol is not tracked or collector is still syncing.
//
function createOrderbookHandler(redis) {
  return async function orderbookHandler(req, res) {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    const marketType = (req.query.marketType || 'spot').toLowerCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }
    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success: false,
        error:   'Query param "marketType" must be "spot" or "futures"',
      });
    }

    const redisKey = marketType === 'futures'
      ? `futures:orderbook:${symbol}`
      : `orderbook:${symbol}`;

    try {
      let raw = await redis.get(redisKey);
      let resolvedMarketType = marketType;

      // Spot collector only tracks a handful of symbols; when spot data is absent
      // OR stale (>10s old), fall back to the futures orderbook so the
      // density-page стакан always has fresh data to display.
      if (marketType === 'spot') {
        let spotIsStale = false;
        if (raw !== null) {
          try {
            const spotAge = Date.now() - Number(JSON.parse(raw).updatedAt ?? 0);
            if (spotAge > 10_000) spotIsStale = true;
          } catch (_) { /* corrupt json — will fail later */ }
        }
        if (raw === null || spotIsStale) {
          const futuresRaw = await redis.get(`futures:orderbook:${symbol}`);
          if (futuresRaw !== null) {
            raw = futuresRaw;
            resolvedMarketType = 'futures';
            console.log(`[orderbook] spot ${spotIsStale ? 'stale' : 'absent'} for ${symbol}, serving futures fallback`);
          }
        }
      }

      if (raw === null) {
        return res.status(404).json({
          success: false,
          error:   `Orderbook not available — symbol may not be tracked or ${marketType} collector is still syncing`,
          symbol,
          marketType,
        });
      }

      let orderbook;
      try {
        orderbook = JSON.parse(raw);
      } catch (_) {
        console.error(`[orderbook] corrupt JSON in Redis key ${redisKey} symbol=${symbol}`);
        return res.status(502).json({
          success: false,
          error:   'Cached orderbook data is corrupt',
          symbol,
          marketType,
        });
      }

      if (!orderbook || typeof orderbook !== 'object' ||
          !Array.isArray(orderbook.bids) || !Array.isArray(orderbook.asks)) {
        console.error(`[orderbook] malformed orderbook structure symbol=${symbol} marketType=${marketType}`);
        return res.status(502).json({
          success: false,
          error:   'Cached orderbook data is malformed',
          symbol,
          marketType,
        });
      }

      console.log(`[orderbook] GET /api/orderbook symbol=${symbol} marketType=${resolvedMarketType}${resolvedMarketType !== marketType ? ` (requested ${marketType})` : ''}`);
      return res.json({ success: true, symbol, marketType: resolvedMarketType, orderbook });
    } catch (err) {
      console.error(`[orderbook] GET /api/orderbook error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createOrderbookHandler };
