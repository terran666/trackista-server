'use strict';
/**
 * rankingService.js — Phase 2
 *
 * Runs every 10 s.  For every active move event and active pre-signal,
 * computes ranking scores and writes enriched sorted lists to Redis:
 *
 *   screener:rank:happened   — JSON array, best-first
 *   screener:rank:building   — JSON array, best-first
 */
const { computeHappenedRank, computeBuildingRank } = require('../engines/moves/rankingEngine');

const INTERVAL_MS = parseInt(process.env.RANKING_INTERVAL_MS || '10000', 10);

function createRankingService(redis, moveDetectionSvc) {
  let timer      = null;
  let active     = false;
  let startedAt  = null;
  let runCount   = 0;
  let errorsCount = 0;
  let lastErrorMsg = null;
  let totalLoopMs  = 0;
  let maxLoopMs    = 0;
  let lastSuccessTs= null;

  async function tick() {
    if (!active) return;
    const tickTs = Date.now();
    runCount++;
    try {
      await Promise.all([rankHappened(), rankBuilding()]);
      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs = Date.now();
      await redis.set('debug:ranking-service:state', JSON.stringify({
        serviceName     : 'rankingService',
        startedAt,
        lastRunTs       : tickTs,
        lastSuccessTs,
        runCount,
        avgLoopMs       : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        errorsCount,
        lastErrorMessage: lastErrorMsg,
        status          : errorsCount > 20 ? 'warning' : 'ok',
      }), 'EX', 120);
    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[rankingService] tick error:', err.message);
      await redis.set('debug:ranking-service:state', JSON.stringify({
        serviceName     : 'rankingService',
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

  // ── Happened rank ───────────────────────────────────────────────
  async function rankHappened() {
    const raw = await redis.get('events:recent');
    if (!raw) return;
    let events;
    try { events = JSON.parse(raw); } catch { return; }

    const ranked = [];
    for (const ev of events) {
      const [metricsRaw, signalRaw, derivRaw] = await Promise.all([
        redis.get(`metrics:${ev.symbol}`),
        redis.get(`signal:${ev.symbol}`),
        redis.get(`derivatives:${ev.symbol}`),
      ]);
      let metrics, signal, derivatives;
      try { metrics     = JSON.parse(metricsRaw); }     catch { metrics     = null; }
      try { signal      = JSON.parse(signalRaw); }      catch { signal      = null; }
      try { derivatives = JSON.parse(derivRaw); }       catch { derivatives = null; }

      const ranking = computeHappenedRank(ev, metrics, signal, derivatives);
      ranked.push({ ...ev, ...ranking });
    }

    ranked.sort((a, b) => b.happenedRankScore - a.happenedRankScore);
    await redis.set(
      'screener:rank:happened',
      JSON.stringify(ranked.slice(0, 100)),
      'EX', 60,
    );
  }

  // ── Building rank ───────────────────────────────────────────────
  async function rankBuilding() {
    const raw = await redis.get('presignal:leaders');
    if (!raw) return;
    let presignals;
    try { presignals = JSON.parse(raw); } catch { return; }

    const ranked = [];
    for (const ps of presignals) {
      const derivRaw = await redis.get(`derivatives:${ps.symbol}`);
      let derivatives;
      try { derivatives = JSON.parse(derivRaw); } catch { derivatives = null; }

      const ranking = computeBuildingRank(ps, derivatives);
      ranked.push({ ...ps, ...ranking });
    }

    ranked.sort((a, b) => b.buildingRankScore - a.buildingRankScore);
    await redis.set(
      'screener:rank:building',
      JSON.stringify(ranked.slice(0, 100)),
      'EX', 30,
    );
  }

  function start() {
    if (active) return;
    active    = true;
    startedAt = Date.now();
    tick();
    timer = setInterval(tick, INTERVAL_MS);
    console.log('[rankingService] started');
  }

  function stop() {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop };
}

module.exports = { createRankingService };
