'use strict';

/**
 * screenerAlertSettingsRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET  /api/screener/alert-settings   — fetch user settings
 * PATCH /api/screener/alert-settings  — update user settings
 *
 * All routes require authRequired middleware (applied in server.js).
 */

const settingsService = require('../services/screenerAlertSettingsService');

function createScreenerAlertSettingsRouter(db, engineRef = null) {
  const express = require('express');
  const router  = express.Router();

  // GET /api/screener/alert-settings
  router.get('/', async (req, res) => {
    try {
      const settings = await settingsService.getSettings(db, req.user.id);
      return res.json({ success: true, settings });
    } catch (err) {
      console.error('[screenerAlertSettings] GET error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // PATCH /api/screener/alert-settings
  router.patch('/', async (req, res) => {
    const patch = req.body || {};
    if (typeof patch !== 'object') {
      return res.status(400).json({ success: false, error: 'Request body must be an object' });
    }

    try {
      const result = await settingsService.upsertSettings(db, req.user.id, patch);
      if (!result.success) {
        return res.status(400).json({ success: false, errors: result.errors });
      }

      // Bust the engine's settings cache so the next tick picks up changes immediately
      if (engineRef && typeof engineRef.invalidateSettingsCache === 'function') {
        engineRef.invalidateSettingsCache();
      }

      return res.json({ success: true, settings: result.settings });
    } catch (err) {
      console.error('[screenerAlertSettings] PATCH error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerAlertSettingsRouter };
