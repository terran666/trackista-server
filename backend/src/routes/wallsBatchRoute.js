'use strict';

// ─── GET /api/walls-batch ─────────────────────────────────────────────────────
//
// Batch variant of /api/walls — reads multiple symbols in one Redis pipeline.
//
// Query params:
//   symbols    (required)  comma-separated, e.g. BTCUSDT,ETHUSDT,SOLUSDT
//   marketType (optional)  "spot" (default) | "futures"
//
// Limits:
//   MAX_BATCH_SYMBOLS = 50  — requests > 50 symbols get a 400 response.
//
// Redis keys (same as wallsRoute.js):
//   spot:    walls:${symbol}
//   futures: futures:walls:${symbol}
//
// Response 200:
// {
//   success:    true,
//   marketType: "spot" | "futures",
//   count:      3,
//   items: [
//     { symbol: "BTCUSDT", tracked: true,  walls: { ...full payload... } },
//     { symbol: "SOLUSDT", tracked: false, walls: { symbol, marketType, updatedAt:null, bestBid:null, ... walls:[] } }
//   ]
// }
//

const MAX_BATCH_SYMBOLS = 50;

function _emptyWalls(symbol, marketType) {
  return {
    symbol,
    marketType,
    updatedAt:     null,
    bestBid:       null,
    bestAsk:       null,
    midPrice:      null,
    wallThreshold: null,
    walls:         [],
  };
}

function createWallsBatchHandler(redis) {
  return async function wallsBatchHandler(req, res) {
    const rawSymbols = (req.query.symbols || '').trim();
    const marketType = (req.query.marketType || 'spot').toLowerCase();

    if (!rawSymbols) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbols" is required (e.g. ?symbols=BTCUSDT,ETHUSDT)',
      });
    }
    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({
        success:    false,
        error:      'Query param "marketType" must be "spot" or "futures"',
        marketType,
      });
    }

    const symbols = rawSymbols
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (symbols.length === 0) {
      return res.status(400).json({
        success: false,
        error:   '"symbols" must contain at least one valid symbol',
      });
    }

    if (symbols.length > MAX_BATCH_SYMBOLS) {
      return res.status(400).json({
        success: false,
        error:   `Too many symbols — maximum is ${MAX_BATCH_SYMBOLS}, got ${symbols.length}`,
        limit:   MAX_BATCH_SYMBOLS,
      });
    }

    try {
      // Single Redis pipeline — one round-trip for all symbols
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        const key = marketType === 'futures'
          ? `futures:walls:${sym}`
          : `walls:${sym}`;
        pipeline.get(key);
      }
      const results = await pipeline.exec();

      const items = symbols.map((sym, i) => {
        const [err, raw] = results[i];
        if (err || raw === null) {
          return { symbol: sym, tracked: false, walls: _emptyWalls(sym, marketType) };
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          return { symbol: sym, tracked: false, walls: _emptyWalls(sym, marketType) };
        }
        return { symbol: sym, tracked: true, walls: parsed };
      });

      return res.json({
        success:    true,
        marketType,
        count:      items.length,
        items,
      });
    } catch (err) {
      console.error(`[walls-batch] error marketType=${marketType} symbols=${symbols.join(',')}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createWallsBatchHandler };
