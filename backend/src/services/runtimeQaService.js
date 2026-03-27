'use strict';
/**
 * runtimeQaService.js — Phase 2 Runtime QA
 *
 * Runs every RUNTIME_QA_INTERVAL_MS (default 30s).
 * Checks service states, Redis keys, and symbol-level data completeness.
 *
 * Writes results to:
 *   debug:runtime-qa:summary          — overall status
 *   debug:runtime-qa:services         — all service states
 *   debug:runtime-qa:symbol:BTCUSDT   — per-symbol
 *   debug:runtime-qa:symbol:ETHUSDT
 *   debug:runtime-qa:symbol:SOLUSDT
 *   debug:runtime-qa:last-report      — latest full report
 */

const {
  validateServiceState,
  validateRedisPayload,
  validateTesttestSymbolPayload,
  buildQaSummary,
  getRulesFor,
} = require('../engines/moves/runtimeQaEngine');

const INTERVAL_MS    = parseInt(process.env.RUNTIME_QA_INTERVAL_MS    || '30000', 10);
const REPORT_TTL_SEC = parseInt(process.env.RUNTIME_QA_REPORT_TTL_SEC || '120',   10);
const LOG_EVERY_N    = parseInt(process.env.RUNTIME_QA_LOG_EVERY_N    || '5',     10);

const CORE_SYMBOLS   = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SERVICE_KEYS   = [
  'debug:move-service:state',
  'debug:presignal-service:state',
  'debug:ranking-service:state',
  'debug:derivatives-service:state',
  'debug:outcome-service:state',
];

function createRuntimeQaService(redis) {
  let timer     = null;
  let active    = false;
  let runCount  = 0;
  let startedAt = null;
  let lastStatus = null;

  // ── helpers ────────────────────────────────────────────────────
  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function rget(key) {
    return tryParse(await redis.get(key));
  }

  // ─────────────────────────────────────────────────────────────
  // Main tick
  // ─────────────────────────────────────────────────────────────
  async function tick() {
    if (!active) return;
    const nowMs = Date.now();
    runCount++;

    try {
      const [servicesReport, symbolReports, globalRedisReport] = await Promise.all([
        checkServices(),
        checkSymbols(),
        checkGlobalRedisKeys(),
      ]);

      const allItems = [
        ...Object.values(servicesReport).map(r => ({ status: r.status })),
        ...symbolReports.map(r => ({ status: r.status })),
        ...globalRedisReport.map(r => ({ status: r.status })),
      ];

      const summary = buildQaSummary(allItems);
      const topProblems = collectTopProblems(servicesReport, symbolReports, globalRedisReport);

      const summaryPayload = {
        ts             : nowMs,
        status         : summary.summaryStatus,
        totalChecks    : summary.totalChecks,
        okCount        : summary.okCount,
        warningCount   : summary.warningCount,
        failCount      : summary.failCount,
        servicesStatus : Object.fromEntries(Object.entries(servicesReport).map(([k, v]) => [k, v.status])),
        symbolsStatus  : Object.fromEntries(symbolReports.map(r => [r.symbol, r.status])),
        topProblems    : topProblems.slice(0, 10),
      };

      const pipeline = redis.pipeline();
      pipeline.set('debug:runtime-qa:summary',     JSON.stringify(summaryPayload),   'EX', REPORT_TTL_SEC);
      pipeline.set('debug:runtime-qa:services',    JSON.stringify(servicesReport),   'EX', REPORT_TTL_SEC);
      pipeline.set('debug:runtime-qa:last-report', JSON.stringify({
        ts: nowMs,
        services  : servicesReport,
        symbols   : symbolReports,
        globalKeys: globalRedisReport,
        summary   : summaryPayload,
      }), 'EX', REPORT_TTL_SEC);

      for (const sr of symbolReports) {
        pipeline.set(`debug:runtime-qa:symbol:${sr.symbol}`, JSON.stringify(sr), 'EX', REPORT_TTL_SEC);
      }
      await pipeline.exec();

      maybeLog(summary, topProblems);
      lastStatus = summary.summaryStatus;

    } catch (err) {
      console.error('[runtime-qa] tick error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // A. Check all service states
  // ─────────────────────────────────────────────────────────────
  async function checkServices() {
    const results = {};
    const raws = await Promise.all(SERVICE_KEYS.map(k => redis.get(k)));
    for (let i = 0; i < SERVICE_KEYS.length; i++) {
      const key   = SERVICE_KEYS[i];
      const state = tryParse(raws[i]);
      results[key] = validateServiceState(state);
      results[key].rawState = state;
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // B. Per-symbol checks
  // ─────────────────────────────────────────────────────────────
  async function checkSymbols() {
    // Pick 1 extra futures + 1 extra spot symbol randomly
    const [futRaw, spotRaw] = await Promise.all([
      redis.get('tracked:futures:symbols'),
      redis.get('tracked:symbols'),
    ]);
    const futSyms  = tryParse(futRaw)  || [];
    const spotSyms = tryParse(spotRaw) || [];

    const extras = new Set();
    if (futSyms.length > 3)  extras.add(futSyms [Math.floor(Math.random() * futSyms.length)]);
    if (spotSyms.length > 3) extras.add(spotSyms[Math.floor(Math.random() * spotSyms.length)]);

    const symbols = [...new Set([...CORE_SYMBOLS, ...extras])];
    return Promise.all(symbols.map(sym => checkSymbol(sym)));
  }

  async function checkSymbol(symbol) {
    const nowMs = Date.now();
    const [
      priceRaw, metricsRaw, signalRaw,
      moveLiveRaw, presignalRaw, derivativesRaw,
    ] = await Promise.all([
      redis.get(`price:${symbol}`),
      redis.get(`metrics:${symbol}`),
      redis.get(`signal:${symbol}`),
      redis.get(`move:live:${symbol}`),
      redis.get(`presignal:${symbol}`),
      redis.get(`derivatives:${symbol}`),
    ]);

    const price       = priceRaw ? parseFloat(priceRaw) : null;
    const metrics     = tryParse(metricsRaw);
    const signal      = tryParse(signalRaw);
    const moveLive    = tryParse(moveLiveRaw);
    const presignal   = tryParse(presignalRaw);
    const derivatives = tryParse(derivativesRaw);

    const redisChecks = [
      validateRedisPayload(`metrics:${symbol}`,  metrics,     getRulesFor('metrics')),
      validateRedisPayload(`signal:${symbol}`,   signal,      getRulesFor('signal')),
      validateRedisPayload(`presignal:${symbol}`,presignal,   getRulesFor('presignal')),
      validateRedisPayload(`derivatives:${symbol}`, derivatives, getRulesFor('derivatives')),
    ];

    const freshness = {
      price      : price != null ? 'present' : 'missing',
      metrics    : metrics?.ts   ? `${Date.now() - metrics.ts}ms` : 'missing',
      signal     : signal?.ts    ? `${Date.now() - signal.ts}ms`  : 'missing',
      moveLive   : moveLive?.ts  ? `${Date.now() - moveLive.ts}ms`: 'no_active',
      presignal  : presignal?.ts ? `${Date.now() - presignal.ts}ms`: 'none',
      derivatives: derivatives?.ts? `${Date.now() - derivatives.ts}ms`: 'missing',
    };

    const completeness = {
      price      : price != null,
      metrics    : metrics != null,
      signal     : signal  != null,
      moveLive   : moveLive != null,
      presignal  : presignal != null,
      derivatives: derivatives != null,
    };

    // Validate testtest-style mock payload
    const mockPayload = {
      symbol,
      layers: { price, metrics, signal, moveLive, presignal, derivatives },
      ranking: null,
      explain: null,
    };
    const testValidation = validateTesttestSymbolPayload(mockPayload);

    const checkStatuses = redisChecks.map(r => r.status);
    const statusRank = (s) => s === 'fail' ? 2 : s === 'warning' ? 1 : 0;
    const worst = checkStatuses.reduce((a, s) => Math.max(a, statusRank(s)), 0);
    const status = worst === 2 ? 'fail' : worst === 1 ? 'warning' : 'ok';

    return {
      symbol,
      ts         : nowMs,
      status,
      freshness,
      completeness,
      redisChecks,
      completenessScore: testValidation.completenessScore,
      problems   : testValidation.problems,
      notes      : [],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // C. Global Redis key checks
  // ─────────────────────────────────────────────────────────────
  async function checkGlobalRedisKeys() {
    const [happenedRaw, buildingRaw, eventsRecentItems, outcomeStatsRaw] = await Promise.all([
      redis.get('screener:rank:happened'),
      redis.get('screener:rank:building'),
      redis.lrange('events:recent', 0, 99),
      redis.get('outcome:stats'),
    ]);

    const happened     = tryParse(happenedRaw);
    const building     = tryParse(buildingRaw);
    // events:recent is a Redis list — parse each item individually
    const eventsRecent = Array.isArray(eventsRecentItems) && eventsRecentItems.length
      ? eventsRecentItems.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean)
      : null;
    const outcomeStats = tryParse(outcomeStatsRaw);

    const results = [
      validateRedisPayload('screener:rank:happened', happened, {
        ...getRulesFor('screener:rank:happened'),
        // array check: validate it's an array (may be empty)
      }),
      validateRedisPayload('screener:rank:building', building, getRulesFor('screener:rank:building')),
      validateRedisPayload('events:recent', eventsRecent, getRulesFor('events:recent')),
      validateRedisPayload('outcome:stats', outcomeStats, getRulesFor('outcome:stats')),
    ];

    // Override ts check for list payloads (they have no native ts field)
    for (const r of results) {
      if (Array.isArray(happened) && r.keyName === 'screener:rank:happened') {
        r.stale = false; r.ageMs = 0; r.notes = r.notes.filter(n => !n.includes('stale'));
        if (r.status === 'warning' && r.notes.length === 0) r.status = 'ok';
      }
      if (Array.isArray(eventsRecent) && r.keyName === 'events:recent') {
        r.stale = false; r.ageMs = 0; r.notes = r.notes.filter(n => !n.includes('stale'));
        if (r.status === 'warning' && r.notes.length === 0) r.status = 'ok';
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collect problems
  // ─────────────────────────────────────────────────────────────────────────
  function collectTopProblems(servicesReport, symbolReports, globalRedisReport) {
    const problems = [];
    for (const [key, r] of Object.entries(servicesReport)) {
      for (const p of (r.problems || [])) problems.push(`[service:${key}] ${p}`);
    }
    for (const sr of symbolReports) {
      for (const p of (sr.problems || [])) problems.push(`[symbol:${sr.symbol}] ${p}`);
    }
    for (const r of globalRedisReport) {
      for (const n of (r.notes || [])) {
        if (n.includes('stale') || n.includes('missing')) problems.push(`[redis:${r.keyName}] ${n}`);
      }
    }
    return problems;
  }

  // ─────────────────────────────────────────────────────────────
  // Logging (throttled)
  // ─────────────────────────────────────────────────────────────
  function maybeLog(summary, topProblems) {
    const statusChanged = summary.summaryStatus !== lastStatus;
    const isSummaryRun  = runCount % LOG_EVERY_N === 0;
    const hasFail       = summary.failCount > 0;

    if (statusChanged || isSummaryRun || hasFail) {
      console.log(`[runtime-qa] summary ok=${summary.okCount} warn=${summary.warningCount} fail=${summary.failCount} status=${summary.summaryStatus}`);
      if (hasFail || statusChanged) {
        for (const p of topProblems.slice(0, 3)) console.warn(`[runtime-qa] ${p}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  function start() {
    if (active) return;
    active    = true;
    startedAt = Date.now();
    // Initial check after 10s to let everything start up
    setTimeout(tick, 10000);
    timer = setInterval(tick, INTERVAL_MS);
    console.log(`[runtime-qa] started (interval=${INTERVAL_MS}ms)`);
  }

  function stop() {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** Force an immediate check (useful for test/debug) */
  function runNow() { return tick(); }

  return { start, stop, runNow };
}

module.exports = { createRuntimeQaService };
