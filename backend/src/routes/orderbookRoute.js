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
      const raw = await redis.get(redisKey);

      if (raw === null) {
        return res.status(404).json({
          success: false,
          error:   `Orderbook not available — symbol may not be tracked or ${marketType} collector is still syncing`,
          symbol,
          marketType,
        });
      }

      console.log(`[orderbook] GET /api/orderbook symbol=${symbol} marketType=${marketType}`);
      return res.json({ success: true, symbol, marketType, orderbook: JSON.parse(raw) });
    } catch (err) {
      console.error(`[orderbook] GET /api/orderbook error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createOrderbookHandler };
