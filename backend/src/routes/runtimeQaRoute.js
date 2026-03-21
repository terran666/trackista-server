'use strict';
/**
 * runtimeQaRoute.js — Phase 2 Runtime QA
 *
 * Exposes QA data collected by runtimeQaService and performs
 * on-demand checks via the runtimeQaEngine.
 *
 * Routes:
 *   GET /api/runtime-qa/summary
 *   GET /api/runtime-qa/services
 *   GET /api/runtime-qa/symbol/:symbol
 *   GET /api/runtime-qa/keys/:symbol
 *   GET /api/runtime-qa/check/testtest/:symbol
 *   GET /api/runtime-qa/system
 */
const express = require('express');
const {
  validateServiceState,
  validateRedisPayload,
  validateTesttestSymbolPayload,
  buildQaSummary,
  getRulesFor,
} = require('../engines/moves/runtimeQaEngine');

const SERVICE_KEYS = [
  'debug:move-service:state',
  'debug:presignal-service:state',
  'debug:ranking-service:state',
  'debug:derivatives-service:state',
  'debug:outcome-service:state',
];

function createRuntimeQaRouter(redis, qaService) {
  const router = express.Router();

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function rget(key) { return tryParse(await redis.get(key)); }

  // ── GET /api/runtime-qa/summary ───────────────────────────────
  router.get('/summary', async (_req, res) => {
    try {
      const summary = await rget('debug:runtime-qa:summary');
      if (summary) return res.json(summary);
      // Fallback: build basic summary on the fly
      const raws   = await Promise.all(SERVICE_KEYS.map(k => redis.get(k)));
      const states = raws.map(r => tryParse(r));
      const items  = states.map(s => validateServiceState(s));
      const sq     = buildQaSummary(items);
      res.json({
        ts         : Date.now(),
        status     : sq.summaryStatus,
        totalChecks: sq.totalChecks,
        okCount    : sq.okCount,
        warningCount: sq.warningCount,
        failCount  : sq.failCount,
        note       : 'live-computed (runtimeQaService not run yet)',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/services ─────────────────────────────
  router.get('/services', async (_req, res) => {
    try {
      const cached = await rget('debug:runtime-qa:services');
      if (cached) return res.json(cached);

      // Live fallback
      const raws = await Promise.all(SERVICE_KEYS.map(k => redis.get(k)));
      const result = {};
      for (let i = 0; i < SERVICE_KEYS.length; i++) {
        const state = tryParse(raws[i]);
        result[SERVICE_KEYS[i]] = {
          ...validateServiceState(state),
          rawState: state,
        };
      }
      res.json({ ts: Date.now(), services: result, note: 'live-computed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/symbol/:symbol ────────────────────────
  router.get('/symbol/:symbol', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      const cached = await rget(`debug:runtime-qa:symbol:${sym}`);
      if (cached) return res.json(cached);

      // Live fallback
      const [
        priceRaw, metricsRaw, signalRaw,
        moveLiveRaw, presignalRaw, derivativesRaw,
      ] = await Promise.all([
        redis.get(`price:${sym}`),
        redis.get(`metrics:${sym}`),
        redis.get(`signal:${sym}`),
        redis.get(`move:live:${sym}`),
        redis.get(`presignal:${sym}`),
        redis.get(`derivatives:${sym}`),
      ]);

      const price       = priceRaw ? parseFloat(priceRaw) : null;
      const metrics     = tryParse(metricsRaw);
      const signal      = tryParse(signalRaw);
      const moveLive    = tryParse(moveLiveRaw);
      const presignal   = tryParse(presignalRaw);
      const derivatives = tryParse(derivativesRaw);

      const redisChecks = [
        validateRedisPayload(`metrics:${sym}`,     metrics,     getRulesFor('metrics')),
        validateRedisPayload(`signal:${sym}`,      signal,      getRulesFor('signal')),
        validateRedisPayload(`presignal:${sym}`,   presignal,   getRulesFor('presignal')),
        validateRedisPayload(`derivatives:${sym}`, derivatives, getRulesFor('derivatives')),
      ];

      const testValidation = validateTesttestSymbolPayload({
        symbol: sym,
        layers: { price, metrics, signal, moveLive, presignal, derivatives },
        ranking: null,
        explain: null,
      });

      const worstStatus = redisChecks.reduce((w, r) => {
        const rank = (s) => s === 'fail' ? 2 : s === 'warning' ? 1 : 0;
        return Math.max(w, rank(r.status));
      }, 0);

      res.json({
        symbol   : sym,
        ts       : Date.now(),
        status   : worstStatus === 2 ? 'fail' : worstStatus === 1 ? 'warning' : 'ok',
        completeness: {
          price: price != null, metrics: metrics != null, signal: signal != null,
          moveLive: moveLive != null, presignal: presignal != null, derivatives: derivatives != null,
        },
        freshness: {
          metrics    : metrics?.ts    ? `${Date.now()-metrics.ts}ms`    : 'missing',
          signal     : signal?.ts     ? `${Date.now()-signal.ts}ms`     : 'missing',
          presignal  : presignal?.ts  ? `${Date.now()-presignal.ts}ms`  : 'none',
          derivatives: derivatives?.ts? `${Date.now()-derivatives.ts}ms`: 'missing',
        },
        redisChecks,
        testValidation,
        note: 'live-computed',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/keys/:symbol ──────────────────────────
  router.get('/keys/:symbol', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      const keys = [
        `move:live:${sym}`,
        `presignal:${sym}`,
        `derivatives:${sym}`,
        `metrics:${sym}`,
        `signal:${sym}`,
        `funding:${sym}`,
        `oi:${sym}`,
      ];
      const raws   = await Promise.all(keys.map(k => redis.get(k)));
      const result = {};
      keys.forEach((k, i) => { result[k] = tryParse(raws[i]); });

      // Add ranking entries if present
      const [happened, building] = await Promise.all([
        rget('screener:rank:happened'),
        rget('screener:rank:building'),
      ]);
      result['rank:happened'] = Array.isArray(happened) ? happened.find(e => e.symbol === sym) || null : null;
      result['rank:building'] = Array.isArray(building)  ? building.find(e => e.symbol === sym)  || null : null;

      res.json({ symbol: sym, ts: Date.now(), keys: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/check/testtest/:symbol ───────────────
  router.get('/check/testtest/:symbol', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      // Simulate what /api/testtest/symbol/:symbol would return
      const [
        priceRaw, metricsRaw, signalRaw, wallsRaw,
        futWallsRaw, moveLiveRaw, presignalRaw, derivativesRaw,
      ] = await Promise.all([
        redis.get(`price:${sym}`),
        redis.get(`metrics:${sym}`),
        redis.get(`signal:${sym}`),
        redis.get(`walls:${sym}`),
        redis.get(`futures:walls:${sym}`),
        redis.get(`move:live:${sym}`),
        redis.get(`presignal:${sym}`),
        redis.get(`derivatives:${sym}`),
      ]);

      const price       = priceRaw ? parseFloat(priceRaw) : null;
      const metrics     = tryParse(metricsRaw);
      const signal      = tryParse(signalRaw);
      const walls       = tryParse(wallsRaw) ?? tryParse(futWallsRaw);
      const moveLive    = tryParse(moveLiveRaw);
      const presignal   = tryParse(presignalRaw);
      const derivatives = tryParse(derivativesRaw);

      const payload = {
        symbol: sym,
        layers: { price, metrics, signal, walls, moveLive, presignal, derivatives },
        ranking: null,
        explain: null,
      };

      const validation = validateTesttestSymbolPayload(payload);

      // Freshness checks on each section
      const staleSections = [];
      const now = Date.now();
      if (metrics?.ts     && now - metrics.ts     > 15000) staleSections.push('metrics stale');
      if (signal?.ts      && now - signal.ts      > 15000) staleSections.push('signal stale');
      if (presignal?.ts   && now - presignal.ts   > 20000) staleSections.push('presignal stale');
      if (derivatives?.ts && now - derivatives.ts > 120000) staleSections.push('derivatives stale');

      const missingSections = Object.entries(validation.sections)
        .filter(([, v]) => v.status !== 'ok')
        .map(([k, v]) => ({ section: k, status: v.status, notes: v.notes || v.error }));

      res.json({
        symbol          : sym,
        ts              : now,
        overallStatus   : validation.status,
        completenessScore: validation.completenessScore,
        missingSections,
        staleSections,
        problems        : validation.problems,
        sections        : validation.sections,
        canRenderTesttest: validation.completenessScore >= 60,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/system ────────────────────────────────
  router.get('/system', async (_req, res) => {
    try {
      const [summary, lastReport, ...serviceStates] = await Promise.all([
        rget('debug:runtime-qa:summary'),
        rget('debug:runtime-qa:last-report'),
        ...SERVICE_KEYS.map(k => rget(k)),
      ]);

      const serviceValidations = {};
      for (let i = 0; i < SERVICE_KEYS.length; i++) {
        serviceValidations[SERVICE_KEYS[i]] = validateServiceState(serviceStates[i]);
      }

      const staleServicesCount = Object.values(serviceValidations).filter(v => v.stale).length;
      const failingServicesCount = Object.values(serviceValidations).filter(v => v.status === 'fail').length;

      res.json({
        ts                  : Date.now(),
        qaSummary           : summary,
        lastReportTs        : lastReport?.ts || null,
        staleServicesCount,
        failingServicesCount,
        services            : serviceValidations,
        qaServiceActive     : typeof qaService?.runNow === 'function',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/runtime-qa/run (trigger immediate check) ─────────
  router.get('/run', async (_req, res) => {
    try {
      if (qaService?.runNow) {
        await qaService.runNow();
        const summary = await rget('debug:runtime-qa:summary');
        return res.json({ triggered: true, summary });
      }
      res.json({ triggered: false, reason: 'qaService not available' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRuntimeQaRouter };
