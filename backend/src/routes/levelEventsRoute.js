'use strict';

/**
 * levelEventsRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/level-events  — paginated global level event history
 *
 * Query params:
 *   symbol       filter by symbol (optional)
 *   market       filter by market: futures|spot (optional)
 *   eventType    filter by event_type (optional)
 *   from         start epoch ms (optional)
 *   to           end epoch ms (optional)
 *   limit        max results (default 50, max 500)
 *   cursor       last seen id for keyset pagination (optional)
 */

const { rowToEvent } = require('./levelWatchRoute');

function createLevelEventsRouter(db) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    const symbol    = req.query.symbol    ? req.query.symbol.toUpperCase()   : null;
    const market    = req.query.market    || null;
    const eventType = req.query.eventType || null;
    const from      = req.query.from      ? parseInt(req.query.from, 10)     : null;
    const to        = req.query.to        ? parseInt(req.query.to, 10)       : null;
    const limit     = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const cursor    = req.query.cursor   ? parseInt(req.query.cursor, 10)    : null;

    if (market && !['futures', 'spot'].includes(market)) {
      return res.status(400).json({ success: false, error: 'market must be futures or spot' });
    }

    const conditions = [];
    const params     = [];

    if (symbol) {
      conditions.push('symbol = ?');
      params.push(symbol);
    }
    if (market) {
      conditions.push('market = ?');
      params.push(market);
    }
    if (eventType) {
      conditions.push('event_type = ?');
      params.push(eventType);
    }
    if (from) {
      conditions.push('occurred_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('occurred_at <= ?');
      params.push(to);
    }
    if (cursor) {
      conditions.push('id < ?');
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    try {
      const [rows] = await db.query(
        `SELECT * FROM level_events ${where} ORDER BY id DESC LIMIT ?`,
        params,
      );

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;

      return res.json({
        success:    true,
        count:      rows.length,
        nextCursor,
        items:      rows.map(rowToEvent),
      });
    } catch (err) {
      console.error('[levelEvents] GET error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createLevelEventsRouter };
