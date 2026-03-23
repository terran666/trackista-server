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

function createSymbolDataRouter(redis) {
  const router = express.Router();

  router.get('/:symbol/data', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();

    if (!SYMBOL_RE.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }

    try {
      const payload = await buildSymbolData(redis, symbol);
      return res.json(payload);
    } catch (err) {
      console.error(`[symbolDataRoute] ${symbol}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createSymbolDataRouter };
