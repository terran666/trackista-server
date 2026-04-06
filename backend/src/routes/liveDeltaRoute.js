'use strict';
/**
 * liveDeltaRoute.js — GET /api/live/delta
 *
 * Production-ready delta endpoint with:
 *   - cursor staleness check  → fullResyncRequired when cursor > 2 min old
 *   - no-change heartbeat     → { heartbeat: true } when nothing changed
 *   - changed payload         → changes keyed by symbol, scope-projected fields
 *   - adaptive pollingHints   → nextPollMs grows when idle, shrinks when active
 *   - per-client rate guard   → tooFrequentPolling: true + maxPollMs hint
 *   - metrics recording
 *
 * Query params: scope, since (cursor ms), sortBy, sortDir, limit, priceDir,
 *   priceMinPct, priceMaxPct, volumeGrowthMin, tradesMin, turnoverMin,
 *   vol24hMin, minImpulse, minInPlay, minReadiness, minFundingPct,
 *   hasMoves, hasAlerts, symbolSearch
 */
const express = require('express');
const { getDelta } = require('../services/screenerAggregationService');

// ─── Scope definitions ─────────────────────────────────────────────────────

/**
 * Field projection per scope.
 * null = all fields (no projection).
 * A Set = only those keys are included in each delta row.
 */
const SCOPE_FIELDS = {
  screener : null,   // full row
  testpage : null,   // full row (testpage needs everything)
  monitor  : new Set([
    'symbol', 'market', 'lastPrice', 'price',
    'priceChangePct', 'priceChangePct5m', 'priceChangePct15m',
    'volumeUsdt60s', 'volumeUsdt1m',
    'impulseScore', 'inPlayScore',
    'hasRecentAlert', 'alertCount', 'recentAlertType',
    'moveEventState', 'moveState',
    'dataStatus', 'updatedAt', 'ts',
  ]),
};

const BASE_HINTS = {
  screener : { minPollMs: 1000, maxPollMs: 10000, recommendedMode: 'normal'  },
  testpage : { minPollMs:  500, maxPollMs:  5000, recommendedMode: 'fast'    },
  monitor  : { minPollMs: 3000, maxPollMs: 30000, recommendedMode: 'relaxed' },
};
const DEFAULT_BASE = BASE_HINTS.screener;
const VALID_SCOPES = new Set(Object.keys(BASE_HINTS));

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Adaptive next-poll recommendation.
 *   too frequent → use maxPollMs (slow them down)
 *   no changes   → 3× minPollMs, capped at maxPollMs
 *   many changes → minPollMs
 *   some changes → 2× minPollMs
 */
function calcNextPollMs(scope, changedCount, tooFrequent) {
  const { minPollMs, maxPollMs } = BASE_HINTS[scope] || DEFAULT_BASE;
  if (tooFrequent)    return maxPollMs;
  if (changedCount === 0) return Math.min(minPollMs * 3, maxPollMs);
  if (changedCount > 50)  return minPollMs;
  return minPollMs * 2;
}

/**
 * Project a full row down to only the fields the scope needs.
 * @param {object}    row
 * @param {Set|null}  fieldSet  — null = return row as-is
 */
function projectRow(row, fieldSet) {
  if (!fieldSet) return row;
  const out = {};
  for (const key of fieldSet) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

// ─── Factory ───────────────────────────────────────────────────────────────

function createLiveDeltaRouter(redis, metrics) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const t0    = Date.now();
    const scope = VALID_SCOPES.has(req.query.scope) ? req.query.scope : 'screener';

    // Per-client rate guard (signals only — request is still processed)
    const tooFrequent = metrics.checkRateGuard(`${req.ip}:${scope}`);

    // Parse cursor
    const sinceRaw = req.query.since;
    const since    = sinceRaw ? parseInt(sinceRaw, 10) : NaN;

    const {
      sortBy, sortDir, limit,
      priceDir, priceMinPct, priceMaxPct,
      volumeGrowthMin, tradesMin, turnoverMin, vol24hMin,
      minImpulse, minInPlay, minReadiness, minFundingPct,
      hasMoves, hasAlerts, symbolSearch,
    } = req.query;

    const opts = {
      sortBy,
      sortDir,
      limit           : limit           ? parseInt(limit,           10) : undefined,
      priceDir,
      priceMinPct     : priceMinPct     ? parseFloat(priceMinPct)       : undefined,
      priceMaxPct     : priceMaxPct     ? parseFloat(priceMaxPct)       : undefined,
      volumeGrowthMin : volumeGrowthMin ? parseFloat(volumeGrowthMin)   : undefined,
      tradesMin       : tradesMin       ? parseInt(tradesMin,       10) : undefined,
      turnoverMin     : turnoverMin     ? parseFloat(turnoverMin)       : undefined,
      vol24hMin       : vol24hMin       ? parseFloat(vol24hMin)        : undefined,
      minImpulse      : minImpulse      ? parseFloat(minImpulse)       : undefined,
      minInPlay       : minInPlay       ? parseFloat(minInPlay)        : undefined,
      minReadiness    : minReadiness    ? parseFloat(minReadiness)     : undefined,
      minFundingPct   : minFundingPct   ? parseFloat(minFundingPct)    : undefined,
      hasMoves        : hasMoves  === 'true' ? true : undefined,
      hasAlerts       : hasAlerts === 'true' ? true : undefined,
      symbolSearch,
    };

    try {
      const result    = await getDelta(redis, since, opts);
      const latencyMs = Date.now() - t0;
      const base      = BASE_HINTS[scope] || DEFAULT_BASE;

      // ── fullResyncRequired path ─────────────────────────────────────────
      if (result.fullResyncRequired) {
        metrics.recordDelta({ latencyMs, changed: false, fullResync: true, scope });
        return res.json({
          fullResyncRequired  : true,
          reason              : result.reason,
          serverTs            : result.serverTs,
          nextCursor          : result.nextCursor,
          tooFrequentPolling  : tooFrequent || undefined,
          pollingHints        : {
            nextPollMs      : base.minPollMs,
            minPollMs       : base.minPollMs,
            maxPollMs       : base.maxPollMs,
            recommendedMode : base.recommendedMode,
          },
        });
      }

      const fieldSet     = SCOPE_FIELDS[scope];
      const changedRows  = result.changedRows || [];
      const newAlerts    = result.newAlerts   || [];
      const changedCount = changedRows.length;
      const nextPollMs   = calcNextPollMs(scope, changedCount, tooFrequent);
      const mode         = tooFrequent ? 'throttled' : base.recommendedMode;

      // ── No-change heartbeat path ────────────────────────────────────────
      if (changedCount === 0 && newAlerts.length === 0) {
        metrics.recordDelta({ latencyMs, changed: false, payloadBytes: 0, fullResync: false, scope });
        return res.json({
          heartbeat          : true,
          changedCount       : 0,
          nextCursor         : result.nextCursor,
          serverTs           : result.serverTs,
          tooFrequentPolling : tooFrequent || undefined,
          pollingHints       : { nextPollMs, minPollMs: base.minPollMs, maxPollMs: base.maxPollMs, recommendedMode: mode },
        });
      }

      // ── Has-changes path ───────────────────────────────────────────────
      const changes = {};
      for (const row of changedRows) {
        changes[row.symbol] = projectRow(row, fieldSet);
      }

      const payload = {
        heartbeat          : false,
        changedCount,
        cursor             : result.nextCursor,
        nextCursor         : result.nextCursor,
        serverTs           : result.serverTs,
        changes,
        newAlerts,
        totalChanged       : result.totalChanged,
        pipelineMs         : result.pipelineMs,
        latencyMs,
        tooFrequentPolling : tooFrequent || undefined,
        pollingHints       : { nextPollMs, minPollMs: base.minPollMs, maxPollMs: base.maxPollMs, recommendedMode: mode },
      };

      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      metrics.recordDelta({ latencyMs, changed: true, payloadBytes, fullResync: false, scope });

      return res.json(payload);

    } catch (err) {
      console.error('[liveDeltaRoute] error:', err.message);
      res.status(500).json({ error: 'delta_failed', message: err.message });
    }
  });

  return router;
}

module.exports = { createLiveDeltaRouter };
