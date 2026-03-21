'use strict';
/**
 * testtestRoute.js — Phase 2
 *
 * Debug / diagnostic API for the TESTTEST page.
 * Aggregates all context layers for a single symbol in one response.
 *
 * Routes:
 *   GET /api/testtest/symbol/:symbol         — full live context
 *   GET /api/testtest/symbol/:symbol/history — move + presignal history
 *   GET /api/testtest/symbol/:symbol/snapshots/:eventId — event snapshots
 *   GET /api/testtest/symbol/:symbol/redis   — raw Redis keys
 *   GET /api/testtest/leaders                — all leader lists
 *   GET /api/testtest/system                 — service health & stats
 */
const express = require('express');
const { explainHappenedEvent, explainPreSignal } = require('../engines/moves/debugExplainEngine');
const { computeHappenedRank, computeBuildingRank } = require('../engines/moves/rankingEngine');

function createTestTestRouter(redis, db, services) {
  const { moveDetectionSvc, derivativesSvc, rankingSvc } = services || {};
  const router = express.Router();

  // ── helpers ────────────────────────────────────────────────────────
  async function rget(key) {
    const raw = await redis.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  // ── GET /api/testtest/ping-testtest ───────────────────────────────
  router.get('/ping-testtest', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), message: 'testtestRoute is mounted and reachable' });
  });

  // ── GET /api/testtest/symbol/:symbol ─────────────────────────────
  router.get('/symbol/:symbol', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      const [price, metrics, signal, walls, futWalls, orderbook, moveLive, presignal, derivatives] =
        await Promise.all([
          rget(`price:${sym}`),
          rget(`metrics:${sym}`),
          rget(`signal:${sym}`),
          rget(`walls:${sym}`),
          rget(`futures:walls:${sym}`),
          rget(`orderbook:${sym}`),
          rget(`move:live:${sym}`),
          rget(`presignal:${sym}`),
          rget(`derivatives:${sym}`),
        ]);

      const happenedRank = moveLive
        ? computeHappenedRank(moveLive, metrics, signal, derivatives)
        : null;
      const buildingRank = presignal
        ? computeBuildingRank(presignal, derivatives)
        : null;

      const happenedExplain = moveLive
        ? explainHappenedEvent(moveLive, metrics, signal, walls ?? futWalls, derivatives)
        : null;
      const buildingExplain = presignal
        ? explainPreSignal(presignal, derivatives)
        : null;

      res.json({
        symbol: sym,
        ts: Date.now(),
        layers: {
          price,
          metrics,
          signal,
          walls:       walls ?? futWalls,
          orderbook,
          moveLive,
          presignal,
          derivatives,
        },
        ranking: { happened: happenedRank, building: buildingRank },
        explain: { happened: happenedExplain, building: buildingExplain },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/symbol/:symbol/history ──────────────────────
  router.get('/symbol/:symbol/history', async (req, res) => {
    const sym   = req.params.symbol.toUpperCase();
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    try {
      const [eventsRaw, presignalsRaw, outcomesRaw] = await Promise.all([
        db ? db.execute(
          `SELECT * FROM move_events WHERE symbol=? ORDER BY start_ts DESC LIMIT ?`,
          [sym, limit],
        ) : Promise.resolve([[],[]]),
        db ? db.execute(
          `SELECT * FROM pre_signals_history WHERE symbol=? ORDER BY ts DESC LIMIT ?`,
          [sym, limit],
        ) : Promise.resolve([[],[]]),
        db ? db.execute(
          `SELECT * FROM pre_signal_outcomes WHERE symbol=? ORDER BY signal_ts DESC LIMIT 50`,
          [sym],
        ) : Promise.resolve([[],[]]),
      ]);
      res.json({
        symbol   : sym,
        events   : eventsRaw[0],
        presignals: presignalsRaw[0],
        outcomes : outcomesRaw[0],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/symbol/:symbol/snapshots/:eventId ───────────
  router.get('/symbol/:symbol/snapshots/:eventId', async (req, res) => {
    const { symbol, eventId } = req.params;
    const sym = symbol.toUpperCase();
    try {
      if (!db) return res.json({ snapshots: null });
      const [[row]] = await db.execute(
        `SELECT snapshot_a_json, snapshot_b_json, snapshot_c_json, snapshot_d_json
         FROM move_events WHERE event_id=? AND symbol=?`,
        [eventId, sym],
      );
      if (!row) return res.status(404).json({ error: 'Event not found' });
      const parse = s => { try { return JSON.parse(s); } catch { return null; } };
      res.json({
        snapshotA: parse(row.snapshot_a_json),
        snapshotB: parse(row.snapshot_b_json),
        snapshotC: parse(row.snapshot_c_json),
        snapshotD: parse(row.snapshot_d_json),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/symbol/:symbol/redis ────────────────────────
  router.get('/symbol/:symbol/redis', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      const keys = [
        `price:${sym}`, `metrics:${sym}`, `signal:${sym}`,
        `walls:${sym}`, `futures:walls:${sym}`,
        `orderbook:${sym}`, `futures:orderbook:${sym}`,
        `move:live:${sym}`, `presignal:${sym}`,
        `derivatives:${sym}`, `funding:${sym}`, `oi:${sym}`,
      ];
      const values = await Promise.all(keys.map(k => redis.get(k)));
      const result = {};
      keys.forEach((k, i) => {
        try { result[k] = JSON.parse(values[i]); }
        catch { result[k] = values[i]; }
      });
      res.json({ symbol: sym, keys: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/leaders ─────────────────────────────────────
  router.get('/leaders', async (_req, res) => {
    try {
      const keys = [
        'presignal:leaders', 'events:recent',
        'screener:rank:happened', 'screener:rank:building',
        'move:leaders:1m:up', 'move:leaders:1m:down',
        'move:leaders:5m:up', 'move:leaders:5m:down',
        'move:leaders:15m:up','move:leaders:15m:down',
      ];
      const values = await Promise.all(keys.map(k => redis.get(k)));
      const result = {};
      keys.forEach((k, i) => {
        try { result[k] = JSON.parse(values[i]); }
        catch { result[k] = values[i]; }
      });
      res.json({ ts: Date.now(), leaders: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/system ──────────────────────────────────────
  router.get('/system', async (_req, res) => {
    try {
      const [derivState, outcomeStats, tracked, trackedFut] = await Promise.all([
        rget('debug:derivatives-service:state'),
        rget('outcome:stats'),
        rget('tracked:symbols'),
        rget('tracked:futures:symbols'),
      ]);

      // Counts in Redis
      const presignalLeaders  = await rget('presignal:leaders');
      const rankedHappened    = await rget('screener:rank:happened');
      const rankedBuilding    = await rget('screener:rank:building');

      res.json({
        ts: Date.now(),
        services: {
          moveDetection  : typeof moveDetectionSvc?.getAllActiveEvents === 'function'
            ? { activeEvents: Object.keys(moveDetectionSvc.getAllActiveEvents() || {}).length }
            : null,
          derivatives    : derivState,
          ranking        : {
            happenedCount : Array.isArray(rankedHappened) ? rankedHappened.length : 0,
            buildingCount : Array.isArray(rankedBuilding)  ? rankedBuilding.length  : 0,
          },
        },
        presignalLeadersCount: Array.isArray(presignalLeaders) ? presignalLeaders.length : 0,
        outcomeStats,
        trackedSymbols       : tracked,
        trackedFuturesSymbols: trackedFut,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/testtest/futures-table ───────────────────────────────
  // Full table of all tracked futures symbols with current live data + latest bar
  router.get('/futures-table', async (_req, res) => {
    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      const _parsedSym = (() => { try { return JSON.parse(rawSymbols); } catch { return null; } })();
      const symbols    = Array.isArray(_parsedSym) ? _parsedSym : (_parsedSym?.symbols ?? []);

      if (!symbols.length) {
        return res.json({ ts: Date.now(), count: 0, rows: [] });
      }

      // Batch-read all live Redis keys
      const rPipe = redis.pipeline();
      for (const sym of symbols) {
        rPipe.get(`metrics:${sym}`);
        rPipe.get(`signal:${sym}`);
        rPipe.get(`derivatives:${sym}`);
        rPipe.get(`futures:walls:${sym}`);
        rPipe.get(`move:live:${sym}`);
        rPipe.get(`presignal:${sym}`);
      }
      const pResults = await rPipe.exec();

      // Fetch latest 1m bar per symbol from MySQL (one query, not N queries)
      const latestBars = {};
      if (db && symbols.length > 0) {
        try {
          const placeholders = symbols.map(() => '?').join(',');
          const [rows] = await db.execute(
            `SELECT b1.* FROM symbol_bars_1m b1
             INNER JOIN (
               SELECT symbol, MAX(ts) AS max_ts
               FROM symbol_bars_1m
               WHERE market = 'futures' AND symbol IN (${placeholders})
               GROUP BY symbol
             ) b2 ON b1.symbol = b2.symbol AND b1.ts = b2.max_ts`,
            symbols,
          );
          for (const row of rows) latestBars[row.symbol] = row;
        } catch (err) {
          console.warn('[testtest/futures-table] MySQL bars fetch error:', err.message);
        }
      }

      const nowMs = Date.now();
      const tableRows = [];

      for (let i = 0; i < symbols.length; i++) {
        const sym  = symbols[i];
        const base = i * 6;
        const p    = (offset) => {
          const v = pResults[base + offset]?.[1];
          try { return JSON.parse(v); } catch { return null; }
        };

        const metrics     = p(0);
        const signal      = p(1);
        const derivatives = p(2);
        const walls       = p(3);
        const moveLive    = p(4);
        const presignal   = p(5);
        const latestBar   = latestBars[sym] || null;

        const hasMetrics     = !!metrics;
        const hasSignal      = !!signal;
        const hasDerivatives = !!derivatives;
        const hasWalls       = !!walls;
        const hasLatestBar   = !!latestBar;

        const missingFieldsCount = [
          !hasMetrics, !hasSignal, !hasDerivatives, !hasWalls, !hasLatestBar,
        ].filter(Boolean).length;

        let dataStatus = 'ok';
        if (!hasLatestBar || !hasMetrics) dataStatus = 'fail';
        else if (missingFieldsCount >= 2)  dataStatus = 'warning';

        tableRows.push({
          // A. Common
          symbol     : sym,
          market     : 'futures',
          ts         : metrics?.updatedAt     || null,
          freshnessMs: metrics?.updatedAt ? nowMs - metrics.updatedAt : null,

          // B. Latest 1m Bar
          open1m           : latestBar?.open              ?? null,
          high1m           : latestBar?.high              ?? null,
          low1m            : latestBar?.low               ?? null,
          close1m          : latestBar?.close             ?? null,
          priceChangePct1m : latestBar?.price_change_pct  ?? null,
          volatility1m     : latestBar?.volatility        ?? null,

          // C. Volume / Trades
          volumeUsdt      : metrics?.volumeUsdt60s      ?? null,
          buyVolumeUsdt   : metrics?.buyVolumeUsdt60s   ?? null,
          sellVolumeUsdt  : metrics?.sellVolumeUsdt60s  ?? null,
          deltaUsdt       : metrics?.deltaUsdt60s       ?? null,
          tradeCount      : metrics?.tradeCount60s      ?? null,
          volumeSpikeRatio: signal?.volumeSpikeRatio60s ?? null,

          // D. Signal
          impulseScore    : signal?.impulseScore     ?? null,
          inPlayScore     : signal?.inPlayScore      ?? null,
          impulseDirection: signal?.impulseDirection ?? null,
          activityScore   : metrics?.activityScore   ?? null,

          // E. Derivatives
          fundingRate    : derivatives?.fundingRate              ?? null,
          oiValue        : derivatives?.oiValue                  ?? null,
          oiDelta        : latestBar?.oi_delta                   ?? null,
          liqLongUsd     : derivatives?.liquidationLongUsd1m     ?? null,
          liqShortUsd    : derivatives?.liquidationShortUsd1m    ?? null,
          derivativesBias: derivatives?.derivativesBias          ?? null,
          squeezeRisk    : derivatives?.squeezeRisk              ?? null,

          // F. Walls
          nearestBidWallPrice: walls?.bidWalls?.[0]?.price    ?? null,
          nearestBidWallUsd  : walls?.bidWalls?.[0]?.usdValue ?? null,
          nearestAskWallPrice: walls?.askWalls?.[0]?.price    ?? null,
          nearestAskWallUsd  : walls?.askWalls?.[0]?.usdValue ?? null,
          wallBias           : walls?.bias                    ?? null,
          wallBounceChance   : walls?.bounceChance            ?? null,
          wallBreakRisk      : walls?.breakRisk               ?? null,

          // G. Move / PreSignal
          moveEventState          : moveLive?.eventState              ?? null,
          currentMovePct          : moveLive?.currentMovePct          ?? null,
          dominantTimeframe       : moveLive?.dominantTimeframe       ?? null,
          adjustedReadinessScore  : presignal?.adjustedReadinessScore ?? null,
          confidenceScore         : presignal?.confidenceScore        ?? null,
          readinessLabel          : presignal?.readinessLabel         ?? null,
          buildingRankScore       : presignal?.score                  ?? null,
          happenedRankScore       : moveLive?.score                   ?? null,

          // H. Data status
          hasLatestBar,
          hasMetrics,
          hasSignal,
          hasDerivatives,
          hasWalls,
          dataStatus,
          missingFieldsCount,
        });
      }

      res.json({ ts: nowMs, count: tableRows.length, rows: tableRows });
    } catch (err) {
      console.error('[testtest/futures-table] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createTestTestRouter };
