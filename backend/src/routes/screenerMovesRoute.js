'use strict';

/**
 * screenerMovesRoute — screener endpoints for the Move Intelligence module.
 *
 * GET /api/screener/moves      — "Happened" tab: symbols that made a move
 * GET /api/screener/pre-moves  — "Building" tab: symbols with readiness signal
 * GET /api/screener/symbols    — Full live symbol list with enriched metrics
 */

const { getPreMoveScan } = require('../services/screenerAggregationService');

function createScreenerMovesRouter(redis, db) {
  const express = require('express');
  const router  = express.Router();

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── GET /api/screener/moves ──────────────────────────────────────
  // "Happened" — symbols that currently have an active move event.
  //
  // Filters (query params):
  //   timeframe        string    e.g. '5m'
  //   direction        up|down|all
  //   minMovePct       number    minimum current move %
  //   minVolume60s     number    minimum 60s USD volume
  //   minTradeCount60s number
  //   minImpulseScore  number
  //   hasWallInteraction  bool   1|true
  //   status           active|extended|reversed|all
  //   limit            number    default 50
  router.get('/moves', async (req, res) => {
    try {
      const {
        timeframe,
        direction   = 'all',
        minMovePct  = 0,
        minVolume60s,
        minTradeCount60s,
        minImpulseScore,
        hasWallInteraction,
        status      = 'all',
        limit       = 50,
      } = req.query;

      const limitNum       = Math.min(parseInt(limit, 10) || 50, 200);
      const minMovePctN    = parseFloat(minMovePct)     || 0;
      const minVolN        = parseFloat(minVolume60s)   || 0;
      const minTradeN      = parseInt(minTradeCount60s, 10) || 0;
      const minImpulseN    = parseFloat(minImpulseScore) || 0;
      const wallFilter     = hasWallInteraction === '1' || hasWallInteraction === 'true';

      const symbolsRaw = await redis.get('symbols:active:usdt');
      if (!symbolsRaw) return res.json({ success: true, items: [] });
      const symbols = tryParse(symbolsRaw) || [];

      // Batch read move:live + signal
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`move:live:${sym}`);
        pipeline.get(`signal:${sym}`);
        pipeline.get(`metrics:${sym}`);
      }
      const results = await pipeline.exec();

      const items = [];

      for (let i = 0; i < symbols.length; i++) {
        const sym     = symbols[i];
        const liveRaw = results[i * 3    ][1];
        if (!liveRaw) continue;

        const live    = tryParse(liveRaw);
        if (!live?.events?.length) continue;

        const signal  = tryParse(results[i * 3 + 1][1]);
        const metrics = tryParse(results[i * 3 + 2][1]);

        // Filter events
        const matchingEvents = live.events.filter(ev => {
          if (direction !== 'all' && ev.direction !== direction)  return false;
          if (timeframe  && ev.timeframe !== timeframe)           return false;
          if (ev.currentMovePct < minMovePctN)                    return false;
          if (status !== 'all' && ev.status !== status)           return false;
          return true;
        });
        if (!matchingEvents.length) continue;

        // Volume / trade count filter
        const vol60s   = metrics?.volumeUsdt60s  || 0;
        const count60s = metrics?.tradeCount60s  || 0;
        if (minVolN   > 0 && vol60s   < minVolN)   continue;
        if (minTradeN > 0 && count60s < minTradeN)  continue;

        // Impulse filter
        const impulseScore = signal?.impulseScore || 0;
        if (minImpulseN > 0 && impulseScore < minImpulseN) continue;

        // Wall interaction filter — check if snapshot has wall proximity
        if (wallFilter) {
          const best = matchingEvents[0];
          // Rough check: wall interaction implied by wall distances in snapshot
          // For now filter on events at 'extended' or 'reversed' status which means price moved far
          if (best.status === 'active') continue;
        }

        // Best event by movePct
        const bestEvent = matchingEvents.reduce((a, b) =>
          Math.abs(b.currentMovePct) > Math.abs(a.currentMovePct) ? b : a,
        );

        items.push({
          symbol          : sym,
          currentPrice    : live.currentPrice,
          direction       : bestEvent.direction,
          timeframe       : bestEvent.timeframe,
          currentMovePct  : bestEvent.currentMovePct,
          extremeMovePct  : bestEvent.extremeMovePct,
          retracementPct  : bestEvent.retracementPct,
          status          : bestEvent.status,
          alertTs         : bestEvent.alertTs,
          startTs         : bestEvent.startTs,
          timeToAlertMs   : bestEvent.alertTs - bestEvent.startTs,
          volumeUsdt60s   : metrics?.volumeUsdt60s   ?? null,
          tradeCount60s   : metrics?.tradeCount60s   ?? null,
          deltaUsdt60s    : metrics?.deltaUsdt60s    ?? null,
          buyVolumeUsdt60s: metrics?.buyVolumeUsdt60s ?? null,
          sellVolumeUsdt60s: metrics?.sellVolumeUsdt60s ?? null,
          impulseScore    : signal?.impulseScore     ?? null,
          inPlayScore     : signal?.inPlayScore      ?? null,
          impulseDirection: signal?.impulseDirection ?? null,
          volumeSpikeRatio15s: signal?.volumeSpikeRatio15s ?? null,
          allEvents       : matchingEvents,
        });
      }

      // Sort by |currentMovePct| desc
      items.sort((a, b) => Math.abs(b.currentMovePct) - Math.abs(a.currentMovePct));

      return res.json({
        success : true,
        count   : items.length,
        items   : items.slice(0, limitNum),
      });
    } catch (err) {
      console.error('[screenerMovesRoute] /moves error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/screener/pre-moves ──────────────────────────────────
  // "Building" — symbols with active pre-event readiness signal.
  //
  // Filters (query params):
  //   signalType       PRE_PUMP_SIGNAL | PRE_DUMP_SIGNAL | PRE_BREAKOUT_SIGNAL | PRE_BOUNCE_SIGNAL
  //   directionBias    up|down|neutral
  //   minReadiness     number   default 25
  //   minConfidence    number
  //   maxDistancePct   number   max distance to condition %
  //   wallBias         bid-heavy|ask-heavy|neutral
  //   accelerationState  accelerating|building|neutral|decelerating
  //   limit            number   default 50
  router.get('/pre-moves', async (req, res) => {
    try {
      const {
        signalType,
        directionBias,
        minReadiness   = 25,
        minConfidence  = 0,
        maxDistancePct,
        wallBias,
        accelerationState,
        limit          = 50,
      } = req.query;

      const items = await getPreMoveScan(redis, {
        minReadiness,
        minConfidence,
        signalType,
        directionBias,
        wallBias,
        accelerationState,
        maxDistancePct,
        limit,
      });

      return res.json({ success: true, count: items.length, items });
    } catch (err) {
      console.error('[screenerMovesRoute] /pre-moves error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerMovesRouter };
