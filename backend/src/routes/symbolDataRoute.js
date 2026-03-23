'use strict';

/**
 * symbolDataRoute — GET /api/symbol/:symbol/data
 *
 * Unified data endpoint for the "Данные" block on TestPage.
 * Returns a fully assembled payload — no business logic needed on the frontend.
 */

const express             = require('express');
const { buildSymbolData } = require('../services/symbolDataService');

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const VALID_MARKETS = new Set(['futures', 'spot']);

function createSymbolDataRouter(redis) {
  const router = express.Router();

  router.get('/:symbol/data', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const market = (req.query.market || 'futures').toLowerCase();

    if (!SYMBOL_RE.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }
    if (!VALID_MARKETS.has(market)) {
      return res.status(400).json({ success: false, error: 'Invalid market: use futures or spot' });
    }

    try {
      const payload = await buildSymbolData(redis, symbol, market);
      return res.json(payload);
    } catch (err) {
      console.error(`[symbolDataRoute] ${symbol} market=${market}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createSymbolDataRouter };
