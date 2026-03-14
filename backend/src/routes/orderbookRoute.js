'use strict';

// ─── GET /api/orderbook ───────────────────────────────────────────
//
// Query params (required): symbol
//
// Reads the normalised orderbook snapshot written by orderbookCollector
// from Redis key  orderbook:${symbol}
//
// ═══════════════════════════════════════════════════════════════════
// RAW ORDERBOOK CONTRACT  (do NOT break this for frontend consumers)
// ═══════════════════════════════════════════════════════════════════
//
// Response 200:
// {
//   success:   true,
//   symbol:    "SOLUSDT",
//   orderbook: {
//     symbol:     string,
//     marketType: "spot",
//     ladderMode: "raw",
//     updatedAt:  number (unix ms),
//     bestBid:    number | null,   // highest bid price
//     bestAsk:    number | null,   // lowest  ask price
//     midPrice:   number | null,   // (bestBid + bestAsk) / 2
//
//     bids: [                      // top 200 bid levels, sorted descending by price
//       {
//         price:    number,        // EXACT Binance price level — no rounding, no bucketing
//         rawPrice: number,        // identical to price — confirms no transformation applied
//         size:     number,        // EXACT quantity at that price
//         usdValue: number,        // parseFloat((price * size).toFixed(2))
//       },
//       ...
//     ],
//
//     asks: [                      // top 200 ask levels, sorted ascending by price
//       { price, rawPrice, size, usdValue },
//       ...
//     ],
//   }
// }
//
// CONTRACT GUARANTEES:
//   1. Each bids[i] / asks[i] entry corresponds to exactly ONE Binance price level.
//      There is NO aggregation, NO bucketing, NO merging of adjacent levels.
//   2. usdValue = parseFloat((price * size).toFixed(2))  — per-level only.
//      Adjacent levels are never summed.
//   3. Bids are monotonically descending: bids[i].price > bids[i+1].price
//      Asks are monotonically ascending:  asks[i].price < asks[i+1].price
//   4. Wall prices (GET /api/walls) correspond to exact price levels in this list.
//      A wall at price=87.00 matches bids[*].price === 87.00 exactly.
//   5. /api/density-view ladder uses the same raw data — backend never aggregates.
//
// Response 404 if symbol is not tracked or collector is still syncing.
//
function createOrderbookHandler(redis) {
  return async function orderbookHandler(req, res) {
    const symbol = (req.query.symbol || '').toUpperCase().trim();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }

    try {
      const raw = await redis.get(`orderbook:${symbol}`);

      if (raw === null) {
        return res.status(404).json({
          success: false,
          error:   'Orderbook not available — symbol may not be tracked or collector is still syncing',
          symbol,
        });
      }

      console.log(`[orderbook] GET /api/orderbook symbol=${symbol}`);
      return res.json({ success: true, symbol, orderbook: JSON.parse(raw) });
    } catch (err) {
      console.error(`[orderbook] GET /api/orderbook error symbol=${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createOrderbookHandler };
