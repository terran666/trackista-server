'use strict';

/**
 * alertSoundsRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/alert-sounds  — reference list of available alert sound ids.
 * Backend does not store audio files — only the allowed id list.
 */

const SOUNDS = [
  { id: 'default_alert',   label: 'Default Alert',   group: 'standard' },
  { id: 'soft_ping',       label: 'Soft Ping',        group: 'standard' },
  { id: 'breakout_high',   label: 'Breakout High',    group: 'intense'  },
  { id: 'bounce_soft',     label: 'Bounce Soft',      group: 'standard' },
  { id: 'fakeout_warning', label: 'Fakeout Warning',  group: 'standard' },
  { id: 'wall_alert',      label: 'Wall Alert',       group: 'standard' },
  { id: 'urgent_alarm',    label: 'Urgent Alarm',     group: 'intense'  },
];

function createAlertSoundsRouter() {
  const express = require('express');
  const router  = express.Router();

  router.get('/', (_req, res) => {
    return res.json({ success: true, count: SOUNDS.length, items: SOUNDS });
  });

  return router;
}

module.exports = { createAlertSoundsRouter, SOUNDS };
