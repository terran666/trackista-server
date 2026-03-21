'use strict';

/**
 * moveDetectionService — orchestrates rolling price history maintenance,
 * move event detection/lifecycle, Redis writes, and MySQL persistence.
 *
 * Interval: 1s (configurable via MOVE_DETECTION_INTERVAL_MS)
 */

const {
  WINDOW_CONFIGS,
  MAX_PRICE_HISTORY_MS,
  EVENT_COOLDOWN_MS,
  computePriceChange,
  updateExistingEvent,
  trimPriceHistory,
} = require('../engines/moves/moveDetectionEngine');

const { buildFeatureSnapshot } = require('../engines/moves/featureSnapshotEngine');

const SERVICE_INTERVAL_MS  = parseInt(process.env.MOVE_DETECTION_INTERVAL_MS || '1000',  10);
const WALL_REFRESH_SEC     = parseInt(process.env.MOVE_WALL_REFRESH_SEC       || '10',    10);
const LEADERS_REFRESH_SEC  = parseInt(process.env.MOVE_LEADERS_REFRESH_SEC    || '5',     10);
const EVENTS_RECENT_MAX    = parseInt(process.env.MOVE_EVENTS_RECENT_MAX      || '200',   10);
const MAX_TRACKED_SYMBOLS  = parseInt(process.env.MOVE_MAX_TRACKED_SYMBOLS    || '500',   10);
const ENABLED              = process.env.MOVE_DETECTION_ENABLED !== 'false';

function createMoveDetectionService(redis, db) {
  // ── In-memory state ─────────────────────────────────────────────
  /** @type {Map<string, Array<{ts:number,price:number}>>} */
  const priceHistories = new Map();

  /** @type {Map<string, Map<string, object>>} symbol → (tf → event) */
  const activeEvents = new Map();

  /** @type {Map<string, number>} cooldown key → expiresTs */
  const cooldowns = new Map();

  /** @type {Map<string, object>} spot wall cache */
  const wallCache = new Map();
  let wallCacheTs = 0;

  let intervalHandle = null;
  let tickCount      = 0;
  let isRunning      = false;
  let startedAt      = null;
  let runCount       = 0;
  let errorsCount    = 0;
  let lastErrorMsg   = null;
  let totalLoopMs    = 0;
  let maxLoopMs      = 0;
  let lastSuccessTs  = null;
  let symbolsProcessed = 0;

  // ── Helpers ──────────────────────────────────────────────────────
  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function cooldownKey(sym, tf) { return `${sym}:${tf}`; }

  function isOnCooldown(sym, tf, nowMs) {
    const exp = cooldowns.get(cooldownKey(sym, tf));
    return exp ? nowMs < exp : false;
  }

  function setCooldown(sym, tf, nowMs) {
    cooldowns.set(cooldownKey(sym, tf), nowMs + EVENT_COOLDOWN_MS);
    // Clean up very old cooldowns periodically
    if (cooldowns.size > 10_000) {
      for (const [k, v] of cooldowns) if (v < nowMs) cooldowns.delete(k);
    }
  }

  function generateEventId() {
    return `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function eventType(direction) {
    return direction === 'up' ? 'PUMP_EVENT' : 'DUMP_EVENT';
  }

  // ── Wall cache refresh ────────────────────────────────────────────
  async function refreshWalls(symbols, nowMs) {
    if (nowMs - wallCacheTs < WALL_REFRESH_SEC * 1000) return;
    wallCacheTs = nowMs;

    const pipeline = redis.pipeline();
    for (const sym of symbols) pipeline.get(`walls:${sym}`);
    const results = await pipeline.exec();
    for (let i = 0; i < symbols.length; i++) {
      const parsed = tryParse(results[i][1]);
      if (parsed) wallCache.set(symbols[i], parsed);
    }
  }

  // ── Leaders refresh ───────────────────────────────────────────────
  async function refreshLeaders() {
    const pipeline = redis.pipeline();
    const leaderMap = {};
    for (const win of WINDOW_CONFIGS) {
      leaderMap[win.label] = { up: [], down: [] };
    }

    for (const [sym, symEvents] of activeEvents) {
      for (const [tf, event] of symEvents) {
        if (event.status === 'closed') continue;
        const entry = {
          symbol       : sym,
          movePct      : event.currentMovePct,
          extremeMovePct: event.extremeMovePct,
          status       : event.status,
          alertTs      : event.alertTs,
          timeframe    : tf,
          direction    : event.direction,
        };
        if (event.direction === 'up') leaderMap[tf].up.push(entry);
        else leaderMap[tf].down.push(entry);
      }
    }

    for (const [tf, { up, down }] of Object.entries(leaderMap)) {
      up.sort((a, b)   => b.movePct - a.movePct);
      down.sort((a, b) => b.movePct - a.movePct);
      pipeline.set(`move:leaders:${tf}:up`,   JSON.stringify(up.slice(0, 50)));
      pipeline.set(`move:leaders:${tf}:down`, JSON.stringify(down.slice(0, 50)));
    }
    await pipeline.exec();
  }

  // ── MySQL writes ──────────────────────────────────────────────────
  async function insertEvent(ev) {
    if (!db) return;
    try {
      const [result] = await db.query(
        `INSERT INTO move_events (
           symbol, market_type, event_type, direction, timeframe, threshold_percent,
           start_ts, alert_ts, extreme_ts, end_ts,
           start_price, alert_price, extreme_price, end_price,
           move_pct_at_alert, move_pct_at_extreme,
           total_duration_ms, time_to_alert_ms, time_to_extreme_ms,
           retracement_pct, confidence_score, cause_tags_json,
           snapshot_before_json, snapshot_alert_json, snapshot_extreme_json, snapshot_close_json,
           status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          ev.symbol,
          ev.marketType || 'spot',
          eventType(ev.direction),
          ev.direction,
          ev.timeframe,
          ev.alertThresholdPct,
          new Date(ev.startTs),
          new Date(ev.alertTs),
          new Date(ev.extremeTs),
          ev.endTs     ? new Date(ev.endTs) : null,
          ev.startPrice,
          ev.alertPrice,
          ev.extremePrice,
          ev.endPrice  || null,
          round(ev.alertMovePct,   4),
          round(ev.extremeMovePct, 4),
          ev.endTs     ? (ev.endTs  - ev.startTs)  : null,
          ev.alertTs   -  ev.startTs,
          ev.extremeTs -  ev.startTs,
          round(ev.retracementPct || 0, 4),
          null,   // confidence_score — filled later
          JSON.stringify([]),
          ev.snapshotBefore    ? JSON.stringify(ev.snapshotBefore)    : null,
          ev.snapshotAtAlert   ? JSON.stringify(ev.snapshotAtAlert)   : null,
          null,   // snapshot_extreme_json
          null,   // snapshot_close_json
          ev.status,
        ],
      );
      ev.mysqlId = result.insertId;
    } catch (err) {
      console.error('[moveDetectionService] insertEvent error:', err.message);
    }
  }

  async function updateEvent(ev) {
    if (!db || !ev.mysqlId) return;
    try {
      await db.query(
        `UPDATE move_events SET
           extreme_ts = ?, extreme_price = ?, end_ts = ?, end_price = ?,
           move_pct_at_extreme = ?, total_duration_ms = ?, time_to_extreme_ms = ?,
           retracement_pct = ?, status = ?,
           snapshot_extreme_json = ?, snapshot_close_json = ?
         WHERE id = ?`,
        [
          new Date(ev.extremeTs),
          ev.extremePrice,
          ev.endTs    ? new Date(ev.endTs) : null,
          ev.endPrice || null,
          round(ev.extremeMovePct, 4),
          ev.endTs    ? (ev.endTs - ev.startTs)  : null,
          ev.extremeTs - ev.startTs,
          round(ev.retracementPct || 0, 4),
          ev.status,
          ev.snapshotAtExtreme ? JSON.stringify(ev.snapshotAtExtreme) : null,
          ev.snapshotAtClose   ? JSON.stringify(ev.snapshotAtClose)   : null,
          ev.mysqlId,
        ],
      );
    } catch (err) {
      console.error('[moveDetectionService] updateEvent error:', err.message);
    }
  }

  // ── Main tick ─────────────────────────────────────────────────────
  async function tick() {
    if (!isRunning) return;
    const nowMs  = Date.now();
    const tickTs = nowMs;
    tickCount++;
    runCount++;

    try {
      const symbolsRaw = await redis.get('symbols:active:usdt');
      if (!symbolsRaw) return;
      let symbols = tryParse(symbolsRaw) || [];
      if (symbols.length > MAX_TRACKED_SYMBOLS) symbols = symbols.slice(0, MAX_TRACKED_SYMBOLS);

      // Batch read: price + metrics + signal
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`price:${sym}`);
        pipeline.get(`metrics:${sym}`);
        pipeline.get(`signal:${sym}`);
      }
      const results = await pipeline.exec();

      await refreshWalls(symbols, nowMs);

      const liveBatch      = redis.pipeline();
      const eventsToInsert = [];
      const eventsToUpdate = [];

      for (let i = 0; i < symbols.length; i++) {
        const sym          = symbols[i];
        const priceStr     = results[i * 3    ][1];
        const currentPrice = priceStr ? parseFloat(priceStr) : NaN;
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) continue;

        const metrics = tryParse(results[i * 3 + 1][1]);
        const signal  = tryParse(results[i * 3 + 2][1]);
        const walls   = wallCache.get(sym) || null;

        // ── Update price history ───────────────────────────────────
        if (!priceHistories.has(sym)) priceHistories.set(sym, []);
        const history = priceHistories.get(sym);
        history.push({ ts: nowMs, price: currentPrice });
        trimPriceHistory(history, nowMs);

        // ── Per-symbol event map ───────────────────────────────────
        if (!activeEvents.has(sym)) activeEvents.set(sym, new Map());
        const symEvents  = activeEvents.get(sym);
        const activeSummary = [];

        for (const winCfg of WINDOW_CONFIGS) {
          const existing = symEvents.get(winCfg.label);

          if (existing && existing.status !== 'closed') {
            // ── Update existing event ──────────────────────────────
            const { needsDbUpdate } = updateExistingEvent(existing, currentPrice, nowMs);

            if (existing.status === 'closed') {
              existing.snapshotAtClose = buildFeatureSnapshot({ price: currentPrice, metrics, signal, walls, priceHistory: history, nowMs });
              eventsToUpdate.push(existing);
              setCooldown(sym, winCfg.label, nowMs);
            } else if (needsDbUpdate) {
              // Update extreme snapshot periodically
              if (existing.extremeTs === nowMs) { // just found new extreme
                existing.snapshotAtExtreme = buildFeatureSnapshot({ price: currentPrice, metrics, signal, walls, priceHistory: history, nowMs });
              }
              eventsToUpdate.push(existing);
            }

            if (existing.status !== 'closed') {
              activeSummary.push(buildEventSummary(existing, signal));
            }
          } else {
            // ── Check for new event ────────────────────────────────
            if (isOnCooldown(sym, winCfg.label, nowMs)) continue;

            const change = computePriceChange(history, winCfg.secs, currentPrice, nowMs);
            if (!change) continue;

            const direction = change.movePct >= winCfg.threshold  ? 'up'
                            : change.movePct <= -winCfg.threshold ? 'down'
                            : null;
            if (!direction) continue;

            const snapshotAtAlert = buildFeatureSnapshot({ price: currentPrice, metrics, signal, walls, priceHistory: history, nowMs });
            // Best-effort "before" snapshot: use data from window start
            const historyAtStart  = history.filter(p => p.ts <= change.startTs + 3000);
            const snapshotBefore  = buildFeatureSnapshot({
              price        : change.startPrice,
              metrics      : null,
              signal       : null,
              walls,
              priceHistory : historyAtStart,
              nowMs        : change.startTs,
            });

            const newEvent = {
              eventId           : generateEventId(),
              symbol            : sym,
              marketType        : 'spot',
              direction,
              timeframe         : winCfg.label,
              alertThresholdPct : winCfg.threshold,
              startTs           : change.startTs,
              startPrice        : change.startPrice,
              alertTs           : nowMs,
              alertPrice        : currentPrice,
              alertMovePct      : Math.abs(change.movePct),
              extremeTs         : nowMs,
              extremePrice      : currentPrice,
              extremeMovePct    : Math.abs(change.movePct),
              currentPrice,
              currentMovePct    : Math.abs(change.movePct),
              retracementPct    : 0,
              status            : 'active',
              lastUpdateTs      : nowMs,
              lastExtremeMoveTs : nowMs,
              endTs             : null,
              endPrice          : null,
              snapshotBefore,
              snapshotAtAlert,
              snapshotAtExtreme : null,
              snapshotAtClose   : null,
              mysqlId           : null,
            };

            symEvents.set(winCfg.label, newEvent);
            eventsToInsert.push(newEvent);
            activeSummary.push(buildEventSummary(newEvent, signal));
          }
        }

        // ── Write move:live:<SYM> ──────────────────────────────────
        if (activeSummary.length > 0) {
          const best = activeSummary.reduce((a, b) =>
            Math.abs(b.currentMovePct) > Math.abs(a.currentMovePct) ? b : a,
          );
          liveBatch.set(`move:live:${sym}`, JSON.stringify({
            symbol       : sym,
            ts           : nowMs,
            currentPrice,
            events       : activeSummary,
            bestDirection: best.direction,
            bestTimeframe: best.timeframe,
            bestMovePct  : best.currentMovePct,
            bestStatus   : best.status,
            impulseScore : signal?.impulseScore ?? null,
            inPlayScore  : signal?.inPlayScore  ?? null,
          }));
        }
      }

      // ── Publish new events to events:recent ─────────────────────
      for (const ev of eventsToInsert) {
        liveBatch.lpush('events:recent', JSON.stringify({
          eventId    : ev.eventId,
          symbol     : ev.symbol,
          direction  : ev.direction,
          timeframe  : ev.timeframe,
          alertMovePct: ev.alertMovePct,
          alertTs    : ev.alertTs,
          alertPrice : ev.alertPrice,
          status     : ev.status,
        }));
      }
      if (eventsToInsert.length > 0) {
        liveBatch.ltrim('events:recent', 0, EVENTS_RECENT_MAX - 1);
      }

      await liveBatch.exec();

      // ── MySQL persistence ────────────────────────────────────────
      if (db) {
        for (const ev of eventsToInsert) await insertEvent(ev);
        // Batch updates: only persist closed events and new-extreme updates every 3s
        if (tickCount % 3 === 0) {
          for (const ev of eventsToUpdate) await updateEvent(ev);
        }
      }

      // ── Refresh leaders every N seconds ─────────────────────────
      const leaderEvery = Math.max(1, Math.round(LEADERS_REFRESH_SEC * 1000 / SERVICE_INTERVAL_MS));
      if (tickCount % leaderEvery === 0) {
        await refreshLeaders();
      }

      // ── Service debug state ───────────────────────────────────
      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs    = Date.now();
      symbolsProcessed = symbols ? symbols.length : 0;
      await redis.set('debug:move-service:state', JSON.stringify({
        serviceName          : 'moveDetectionService',
        startedAt,
        lastRunTs            : nowMs,
        lastSuccessTs,
        runCount,
        symbolsProcessed,
        avgLoopMs            : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        activeEventsCount    : getAllActiveEvents().length,
        priceHistoriesCount  : priceHistories.size,
        errorsCount,
        lastErrorMessage     : lastErrorMsg,
        status               : errorsCount > 50 ? 'warning' : 'ok',
      }), 'EX', 120);
    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[moveDetectionService] tick error:', err.message);
      await redis.set('debug:move-service:state', JSON.stringify({
        serviceName     : 'moveDetectionService',
        startedAt,
        lastRunTs       : nowMs,
        lastSuccessTs,
        runCount,
        errorsCount,
        lastErrorMessage: err.message,
        status          : 'warning',
      }), 'EX', 120).catch(() => {});
    }
  }

  function buildEventSummary(event, signal) {
    return {
      direction        : event.direction,
      timeframe        : event.timeframe,
      startTs          : event.startTs,
      startPrice       : event.startPrice,
      alertTs          : event.alertTs,
      alertPrice       : event.alertPrice,
      alertThresholdPct: event.alertThresholdPct,
      currentMovePct   : event.currentMovePct,
      extremeMovePct   : event.extremeMovePct,
      retracementPct   : event.retracementPct,
      status           : event.status,
      impulseScore     : signal?.impulseScore ?? null,
      inPlayScore      : signal?.inPlayScore  ?? null,
    };
  }

  function round(v, dec) {
    const m = 10 ** dec;
    return Math.round(v * m) / m;
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Returns price history for a symbol (used by preEventService) */
  function getPriceHistory(sym) {
    return priceHistories.get(sym) || null;
  }

  /** Returns all currently non-closed events */
  function getAllActiveEvents() {
    const out = [];
    for (const [, symEvents] of activeEvents) {
      for (const [, ev] of symEvents) {
        if (ev.status !== 'closed') out.push(ev);
      }
    }
    return out;
  }

  function start() {
    if (!ENABLED) {
      console.log('[moveDetectionService] Disabled (MOVE_DETECTION_ENABLED=false)');
      return;
    }
    if (isRunning) return;
    isRunning      = true;
    startedAt      = Date.now();
    intervalHandle = setInterval(tick, SERVICE_INTERVAL_MS);
    console.log(`[moveDetectionService] Started (interval=${SERVICE_INTERVAL_MS}ms)`);
  }

  function stop() {
    isRunning = false;
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    console.log('[moveDetectionService] Stopped');
  }

  return { start, stop, getPriceHistory, getAllActiveEvents };
}

module.exports = { createMoveDetectionService };
