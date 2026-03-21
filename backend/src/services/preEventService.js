'use strict';

/**
 * preEventService — runs every 5s, computes pre-event readiness signals
 * for all tracked symbols and writes them to Redis.
 *
 * Depends on price histories maintained by moveDetectionService.
 */

const { WINDOW_CONFIGS } = require('../engines/moves/moveDetectionEngine');
const { computePreSignalV2 } = require('../engines/moves/preEventEngine');

const PRE_EVENT_INTERVAL_MS   = parseInt(process.env.PRE_EVENT_INTERVAL_MS   || '5000', 10);
const PRESIGNAL_LEADERS_MAX   = parseInt(process.env.PRESIGNAL_LEADERS_MAX   || '50',   10);
const PRESIGNAL_TTL_SEC       = parseInt(process.env.PRESIGNAL_TTL_SEC       || '30',   10);
const WALL_REFRESH_SEC        = parseInt(process.env.PRE_WALL_REFRESH_SEC    || '15',   10);
const ENABLED                 = process.env.PRE_EVENT_ENABLED !== 'false';

/**
 * @param {import('ioredis').Redis} redis
 * @param {{ getPriceHistory(sym:string): Array<{ts:number,price:number}>|null }} moveService
 */
function createPreEventService(redis, moveService) {
  /** @type {Map<string, object>} spot wall cache */
  const wallCache       = new Map();
  /** @type {Map<string, {score:number, sinceMs:number}>} persistence state */
  const persistenceState = new Map();
  let wallCacheTs    = 0;
  let intervalHandle = null;
  let isRunning      = false;
  let startedAt      = null;
  let runCount       = 0;
  let errorsCount    = 0;
  let lastErrorMsg   = null;
  let totalLoopMs    = 0;
  let maxLoopMs      = 0;
  let lastSuccessTs  = null;
  let staleInputsCount = 0;
  let missingMetricsCount = 0;
  let missingDerivativesCount = 0;

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

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

  async function tick() {
    if (!isRunning) return;
    const nowMs  = Date.now();
    const tickTs = nowMs;
    runCount++;
    let loopStaleInputs = 0;
    let loopMissingMetrics = 0;
    let loopMissingDeriv = 0;

    try {
      const symbolsRaw = await redis.get('symbols:active:usdt');
      if (!symbolsRaw) return;
      const symbols = tryParse(symbolsRaw) || [];

      await refreshWalls(symbols, nowMs);

      // Batch read: price + metrics + signal + derivatives
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`price:${sym}`);
        pipeline.get(`metrics:${sym}`);
        pipeline.get(`signal:${sym}`);
        pipeline.get(`derivatives:${sym}`);
      }
      const results = await pipeline.exec();

      const preSignals    = [];
      const writePipeline = redis.pipeline();

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];

        const priceStr     = results[i * 4    ][1];
        const currentPrice = priceStr ? parseFloat(priceStr) : NaN;
        if (!currentPrice || isNaN(currentPrice)) {
          writePipeline.del(`presignal:${sym}`);
          persistenceState.delete(sym);
          continue;
        }

        const metrics     = tryParse(results[i * 4 + 1][1]);
        const signal      = tryParse(results[i * 4 + 2][1]);
        const derivatives = tryParse(results[i * 4 + 3][1]);
        if (!derivatives) loopMissingDeriv++;

        if (!signal?.baselineReady || !metrics) {
          loopMissingMetrics++;
          writePipeline.del(`presignal:${sym}`);
          persistenceState.delete(sym);
          continue;
        }

        // Borrow price history from moveDetectionService
        const priceHistory = moveService?.getPriceHistory(sym) ?? null;
        if (!priceHistory || priceHistory.length < 60) {
          loopStaleInputs++;
          writePipeline.del(`presignal:${sym}`);
          persistenceState.delete(sym);
          continue;
        }

        const walls = wallCache.get(sym) || null;

        // Persistence tracking
        const prevState    = persistenceState.get(sym);
        const prevScore    = prevState?.score ?? null;
        const persistenceMs = prevState?.sinceMs != null ? (nowMs - prevState.sinceMs) : 0;

        const preSignal = computePreSignalV2({
          symbol       : sym,
          priceHistory,
          currentPrice,
          metrics,
          signal,
          walls,
          windowConfigs: WINDOW_CONFIGS,
          nowMs,
          derivatives,
          persistenceMs,
          prevScore,
        });

        if (preSignal) {
          preSignals.push(preSignal);
          writePipeline.set(`presignal:${sym}`, JSON.stringify(preSignal), 'EX', PRESIGNAL_TTL_SEC);
          // Update persistence: track how long the signal has been active
          if (!prevState) {
            persistenceState.set(sym, { score: preSignal.readinessScore, sinceMs: nowMs });
          } else {
            persistenceState.set(sym, { ...prevState, score: preSignal.readinessScore });
          }
        } else {
          writePipeline.del(`presignal:${sym}`);
          persistenceState.delete(sym);
        }
      }

      // Leaders list — sorted by readiness desc
      preSignals.sort((a, b) => b.readinessScore - a.readinessScore);
      writePipeline.set('presignal:leaders', JSON.stringify(preSignals.slice(0, PRESIGNAL_LEADERS_MAX)));

      // ── Service debug state ───────────────────────────────────
      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs = Date.now();
      staleInputsCount        += loopStaleInputs;
      missingMetricsCount     += loopMissingMetrics;
      missingDerivativesCount += loopMissingDeriv;
      writePipeline.set('debug:presignal-service:state', JSON.stringify({
        serviceName             : 'preEventService',
        startedAt,
        lastRunTs               : nowMs,
        lastSuccessTs,
        runCount,
        symbolsProcessed        : symbols.length,
        presignalsEmitted       : preSignals.length,
        avgLoopMs               : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        staleInputsCount,
        missingMetricsCount,
        missingDerivativesCount,
        errorsCount,
        lastErrorMessage        : lastErrorMsg,
        status                  : errorsCount > 20 ? 'warning' : 'ok',
      }), 'EX', 120);

      await writePipeline.exec();

    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[preEventService] tick error:', err.message);
      await redis.set('debug:presignal-service:state', JSON.stringify({
        serviceName     : 'preEventService',
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

  function start() {
    if (!ENABLED) {
      console.log('[preEventService] Disabled (PRE_EVENT_ENABLED=false)');
      return;
    }
    if (isRunning) return;
    isRunning      = true;
    startedAt      = Date.now();
    intervalHandle = setInterval(tick, PRE_EVENT_INTERVAL_MS);
    console.log(`[preEventService] Started (interval=${PRE_EVENT_INTERVAL_MS}ms)`);
  }

  function stop() {
    isRunning = false;
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    console.log('[preEventService] Stopped');
  }

  return { start, stop };
}

module.exports = { createPreEventService };
