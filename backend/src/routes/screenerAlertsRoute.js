'use strict';

/**
 * screenerAlertsRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/screener/alerts/recent  — fetch user's recent screener alerts
 *
 * All routes require authRequired middleware (applied in server.js).
 */

const recentAlertsStore = require('../services/screenerRecentAlertsStore');

function createScreenerAlertsRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  // GET /api/screener/alerts/recent?limit=50
  router.get('/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({ success: false, error: 'Invalid limit parameter' });
    }

    try {
      const alerts = await recentAlertsStore.getRecent(redis, req.user.id, limit);
      return res.json({ success: true, count: alerts.length, alerts });
    } catch (err) {
      console.error('[screenerAlerts] GET /recent error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerAlertsRouter };
