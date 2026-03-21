'use strict';
/**
 * outcomeTrackingService.js — Phase 2
 *
 * Every 10 s scan active pre-signals and check if a move event
 * has appeared for the same symbol.  When it does, write a row to
 * `pre_signal_outcomes` so we can measure prediction quality over time.
 *
 * Also writes aggregate conversion stats to Redis key:
 *   outcome:stats  — { total, converted, conversionRate, last24hRate }
 */

const INTERVAL_MS       = parseInt(process.env.OUTCOME_INTERVAL_MS        || '10000', 10);
const MAX_WATCH_MS      = parseInt(process.env.OUTCOME_MAX_WATCH_MS        || '300000', 10); // 5 min
const CONVERSION_WIN_MS = parseInt(process.env.OUTCOME_CONVERSION_WIN_MS   || '120000', 10); // 2 min

function createOutcomeTrackingService(redis, db) {
  const watching  = new Map();
  let timer       = null;
  let active      = false;
  let startedAt   = null;
  let runCount    = 0;
  let errorsCount = 0;
  let lastErrorMsg= null;
  let totalLoopMs = 0;
  let maxLoopMs   = 0;
  let lastSuccessTs = null;

  async function tick() {
    if (!active) return;
    const tickTs = Date.now();
    runCount++;
    try {
      await updateWatchList();
      await checkConversions();
      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs = Date.now();
      await redis.set('debug:outcome-service:state', JSON.stringify({
        serviceName     : 'outcomeTrackingService',
        startedAt,
        lastRunTs       : tickTs,
        lastSuccessTs,
        runCount,
        symbolsProcessed: watching.size,
        avgLoopMs       : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        errorsCount,
        lastErrorMessage: lastErrorMsg,
        status          : errorsCount > 20 ? 'warning' : 'ok',
      }), 'EX', 120);
    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[outcomeTrackingService] tick error:', err.message);
      await redis.set('debug:outcome-service:state', JSON.stringify({
        serviceName     : 'outcomeTrackingService',
        startedAt,
        lastRunTs       : tickTs,
        lastSuccessTs,
        runCount,
        errorsCount,
        lastErrorMessage: err.message,
        status          : 'warning',
      }), 'EX', 120).catch(() => {});
    }
  }

  async function updateWatchList() {
    const raw = await redis.get('presignal:leaders');
    if (!raw) return;
    let leaders;
    try { leaders = JSON.parse(raw); } catch { return; }

    const now = Date.now();
    for (const ps of leaders) {
      if (!watching.has(ps.symbol)) {
        watching.set(ps.symbol, {
          signalTs      : ps.ts || now,
          readinessScore: ps.readinessScore,
          readinessLabel: ps.readinessLabel || null,
          directionBias : ps.directionBias,
        });
      }
    }

    // Expire stale watches
    for (const [sym, entry] of watching.entries()) {
      if (now - entry.signalTs > MAX_WATCH_MS) watching.delete(sym);
    }
  }

  async function checkConversions() {
    if (!db) return;
    const now = Date.now();

    for (const [sym, entry] of watching.entries()) {
      // Check if a move event appeared within the conversion window
      const evRaw = await redis.get(`move:live:${sym}`);
      if (!evRaw) continue;
      let ev;
      try { ev = JSON.parse(evRaw); } catch { continue; }

      const evTs = ev.startTs || ev.ts || 0;
      if (evTs < entry.signalTs) continue; // event predates signal
      if (evTs - entry.signalTs > CONVERSION_WIN_MS) continue;

      // Converted! Record outcome
      watching.delete(sym);
      try {
        await db.execute(
          `INSERT IGNORE INTO pre_signal_outcomes
           (symbol, signal_ts, event_id, readiness_score, readiness_label,
            direction_bias, converted, conversion_lag_ms, event_move_pct)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            sym,
            new Date(entry.signalTs),
            ev.eventId || ev.id || null,
            entry.readinessScore,
            entry.readinessLabel,
            entry.directionBias,
            evTs - entry.signalTs,
            ev.movePct || null,
          ],
        );
      } catch (dbErr) {
        console.error('[outcomeTrackingService] DB write error:', dbErr.message);
      }
    }

    // Flush expired and mark non-converted
    const nowTs = Date.now();
    for (const [sym, entry] of watching.entries()) {
      if (nowTs - entry.signalTs > MAX_WATCH_MS) {
        watching.delete(sym);
        try {
          await db.execute(
            `INSERT IGNORE INTO pre_signal_outcomes
             (symbol, signal_ts, readiness_score, readiness_label,
              direction_bias, converted)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [sym, new Date(entry.signalTs), entry.readinessScore, entry.readinessLabel, entry.directionBias],
          );
        } catch { /* non-critical */ }
      }
    }

    // Compute and store aggregate stats
    await writeStats();
  }

  async function writeStats() {
    if (!db) return;
    try {
      const [[r1]] = await db.execute(
        `SELECT COUNT(*) AS total,
                SUM(converted) AS converted
         FROM pre_signal_outcomes`,
      );
      const [[r2]] = await db.execute(
        `SELECT COUNT(*) AS total24,
                SUM(converted) AS conv24
         FROM pre_signal_outcomes
         WHERE signal_ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      );
      const stats = {
        total          : r1.total          || 0,
        converted      : r1.converted      || 0,
        conversionRate : r1.total > 0 ? +(r1.converted / r1.total * 100).toFixed(1) : null,
        last24hTotal   : r2.total24        || 0,
        last24hRate    : r2.total24 > 0 ? +(r2.conv24 / r2.total24 * 100).toFixed(1) : null,
        watchingCount  : watching.size,
        updatedAt      : Date.now(),
      };
      await redis.set('outcome:stats', JSON.stringify(stats), 'EX', 120);
    } catch { /* non-critical */ }
  }

  function start() {
    if (active) return;
    active    = true;
    startedAt = Date.now();
    tick();
    timer = setInterval(tick, INTERVAL_MS);
    console.log('[outcomeTrackingService] started');
  }

  function stop() {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop };
}

module.exports = { createOutcomeTrackingService };
