'use strict';

/**
 * movesRoute — move event API endpoints.
 *
 * GET /api/moves/live           — active moves for all symbols (from Redis)
 * GET /api/moves/leaders        — top movers per timeframe
 * GET /api/moves/history        — move events from MySQL with filters
 * GET /api/events/:symbol       — move events for a specific symbol
 * GET /api/events/:symbol/live  — live move state for a symbol
 */

const WINDOW_LABELS = ['1m', '3m', '5m', '15m', '30m', '1h'];

function createMovesRouter(redis, db) {
  const express = require('express');
  const router  = express.Router();

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── GET /api/moves/live ──────────────────────────────────────────
  // Returns all symbols that currently have active move events.
  // Query: ?direction=up|down|all&timeframe=5m&limit=100&minMovePct=2
  router.get('/live', async (req, res) => {
    try {
      const { direction = 'all', timeframe, limit = 100, minMovePct = 0 } = req.query;
      const limitNum    = Math.min(parseInt(limit, 10) || 100, 500);
      const minMovePctN = parseFloat(minMovePct) || 0;

      const symbolsRaw = await redis.get('symbols:active:usdt');
      if (!symbolsRaw) return res.json({ success: true, items: [] });
      const symbols = tryParse(symbolsRaw) || [];

      // Batch-read move:live:<SYM>
      const pipeline = redis.pipeline();
      for (const sym of symbols) pipeline.get(`move:live:${sym}`);
      const results = await pipeline.exec();

      const items = [];
      for (let i = 0; i < symbols.length; i++) {
        const raw = results[i][1];
        if (!raw) continue;
        const data = tryParse(raw);
        if (!data?.events?.length) continue;

        // Filter events by direction / timeframe / minMovePct
        const filteredEvents = data.events.filter(ev => {
          if (direction !== 'all' && ev.direction !== direction) return false;
          if (timeframe && ev.timeframe !== timeframe) return false;
          if (ev.currentMovePct < minMovePctN) return false;
          return true;
        });
        if (!filteredEvents.length) continue;

        items.push({ ...data, events: filteredEvents });
      }

      // Sort by bestMovePct desc
      items.sort((a, b) => Math.abs(b.bestMovePct) - Math.abs(a.bestMovePct));

      return res.json({
        success : true,
        count   : items.length,
        items   : items.slice(0, limitNum),
      });
    } catch (err) {
      console.error('[movesRoute] /live error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/moves/leaders ───────────────────────────────────────
  // Returns top movers per timeframe from Redis leaders keys.
  // Query: ?timeframe=5m&direction=up|down&limit=20
  router.get('/leaders', async (req, res) => {
    try {
      const { timeframe, direction = 'up', limit = 20 } = req.query;
      const limitNum = Math.min(parseInt(limit, 10) || 20, 100);

      if (timeframe) {
        // Single timeframe
        const key = `move:leaders:${timeframe}:${direction === 'down' ? 'down' : 'up'}`;
        const raw = await redis.get(key);
        const items = tryParse(raw) || [];
        return res.json({ success: true, timeframe, direction, items: items.slice(0, limitNum) });
      }

      // All timeframes
      const pipeline = redis.pipeline();
      for (const tf of WINDOW_LABELS) {
        pipeline.get(`move:leaders:${tf}:up`);
        pipeline.get(`move:leaders:${tf}:down`);
      }
      const results = await pipeline.exec();
      const leaders = {};
      for (let i = 0; i < WINDOW_LABELS.length; i++) {
        const tf = WINDOW_LABELS[i];
        leaders[tf] = {
          up  : (tryParse(results[i * 2    ][1]) || []).slice(0, limitNum),
          down: (tryParse(results[i * 2 + 1][1]) || []).slice(0, limitNum),
        };
      }
      return res.json({ success: true, leaders });
    } catch (err) {
      console.error('[movesRoute] /leaders error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/moves/history ───────────────────────────────────────
  // MySQL query with filters.
  // Query: ?symbol=&direction=&timeframe=&eventType=&status=&limit=50&offset=0
  //        &since=<ISO>&until=<ISO>&minMovePct=&minConfidence=
  router.get('/history', async (req, res) => {
    if (!db) return res.json({ success: true, items: [], total: 0 });
    try {
      const {
        symbol, direction, timeframe, eventType, status,
        limit = 50, offset = 0,
        since, until,
        minMovePct, minConfidence,
      } = req.query;

      const limitNum  = Math.min(parseInt(limit, 10)  || 50,  200);
      const offsetNum = Math.max(parseInt(offset, 10) || 0,   0);

      const where = [];
      const params = [];

      if (symbol)      { where.push('symbol = ?');         params.push(symbol.toUpperCase()); }
      if (direction)   { where.push('direction = ?');      params.push(direction); }
      if (timeframe)   { where.push('timeframe = ?');      params.push(timeframe); }
      if (eventType)   { where.push('event_type = ?');     params.push(eventType); }
      if (status)      { where.push('status = ?');         params.push(status); }
      if (since) {
        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) return res.status(400).json({ success: false, error: 'invalid since date' });
        where.push('created_at >= ?'); params.push(sinceDate);
      }
      if (until) {
        const untilDate = new Date(until);
        if (isNaN(untilDate.getTime())) return res.status(400).json({ success: false, error: 'invalid until date' });
        where.push('created_at <= ?'); params.push(untilDate);
      }
      if (minMovePct != null && minMovePct !== '')  { where.push('move_pct_at_alert >= ?'); params.push(parseFloat(minMovePct)); }
      if (minConfidence != null && minConfidence !== '') { where.push('confidence_score >= ?'); params.push(parseInt(minConfidence, 10)); }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) AS total FROM move_events ${whereClause}`,
        params,
      );

      const [rows] = await db.query(
        `SELECT id, symbol, market_type, event_type, direction, timeframe, threshold_percent,
                start_ts, alert_ts, extreme_ts, end_ts,
                start_price, alert_price, extreme_price, end_price,
                move_pct_at_alert, move_pct_at_extreme,
                total_duration_ms, time_to_alert_ms, time_to_extreme_ms,
                retracement_pct, confidence_score, cause_tags_json, status, created_at
         FROM move_events ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limitNum, offsetNum],
      );

      return res.json({
        success: true,
        total,
        limit  : limitNum,
        offset : offsetNum,
        items  : rows,
      });
    } catch (err) {
      console.error('[movesRoute] /history error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/events/:symbol/live ─────────────────────────────────
  router.get('/:symbol/live', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const raw    = await redis.get(`move:live:${symbol}`);
      if (!raw) return res.json({ success: true, symbol, data: null });
      return res.json({ success: true, symbol, data: tryParse(raw) });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/events/:symbol ──────────────────────────────────────
  router.get('/:symbol', async (req, res) => {
    if (!db) return res.json({ success: true, items: [] });
    try {
      const symbol  = req.params.symbol.toUpperCase();
      const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const [rows]  = await db.query(
        `SELECT id, event_type, direction, timeframe, threshold_percent,
                start_ts, alert_ts, extreme_ts, end_ts,
                start_price, alert_price, extreme_price,
                move_pct_at_alert, move_pct_at_extreme,
                time_to_alert_ms, retracement_pct, status, confidence_score, cause_tags_json, created_at
         FROM move_events WHERE symbol = ?
         ORDER BY created_at DESC LIMIT ?`,
        [symbol, limit],
      );
      return res.json({ success: true, symbol, items: rows });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/events/:symbol/context ─────────────────────────────
  router.get('/:symbol/context/:id', async (req, res) => {
    if (!db) return res.json({ success: true, data: null });
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });

      const [[row]] = await db.query(
        `SELECT * FROM move_events WHERE id = ? AND symbol = ?`,
        [id, req.params.symbol.toUpperCase()],
      );
      if (!row) return res.status(404).json({ success: false, error: 'Event not found' });
      return res.json({ success: true, data: row });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createMovesRouter };
