'use strict';

const express = require('express');

function createMarketDataHealthRouter(redis) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const raw = await redis.get('health:market-data');
      const parsed = raw ? JSON.parse(raw) : null;
      const now = Date.now();

      const lastTradeAt = Number(parsed?.lastTradeAt || 0) || null;
      const staleSeconds = lastTradeAt ? Math.max(0, Math.floor((now - lastTradeAt) / 1000)) : null;

      const response = {
        status: parsed?.status || 'OFFLINE',
        lastTradeAt,
        offlineSince: parsed?.offlineSince ?? null,
        recoveredAt: parsed?.recoveredAt ?? null,
        staleSeconds,
        wsConnected: Boolean(parsed?.wsConnected),
      };

      return res.json(response);
    } catch (err) {
      console.error('[marketDataHealthRoute] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createMarketDataHealthRouter };
