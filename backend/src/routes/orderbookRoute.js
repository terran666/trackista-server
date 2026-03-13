'use strict';

// ─── GET /api/orderbook ───────────────────────────────────────────
//
// Query params (required): symbol
//
// Reads the normalised orderbook snapshot written by orderbookCollector
// from Redis key  orderbook:${symbol}
//
// Response 200:
// {
//   success:    true,
//   symbol:     "BTCUSDT",
//   orderbook:  {
//     symbol:    string,
//     updatedAt: number (ms),
//     bestBid:   number | null,
//     bestAsk:   number | null,
//     midPrice:  number | null,
//     bids: [{ price, size, usdValue }, ...],  // top 50, descending
//     asks: [{ price, size, usdValue }, ...],  // top 50, ascending
//   }
// }
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
