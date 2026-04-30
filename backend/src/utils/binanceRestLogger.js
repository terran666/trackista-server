'use strict';

// ─── Binance REST Logger (backend process) ─────────────────────────
//
// Same design as collector/src/binanceRestLogger.js — single module-level
// instance shared across all backend route files in this process.
//
// Usage:
//   const { binanceFetch } = require('../utils/binanceRestLogger');
//   const res = await binanceFetch(url, opts, service, symbol, reason);

const REPORT_INTERVAL_MS = 60_000;

// ─── In-process IP-level backoff ─────────────────────────────────────────────
//
// Mirrors the collector's global backoff logic so that backend klines calls
// (levelsEngineRoute, autoLevelsRoute) don't keep hammering Binance while
// the IP is banned, which would extend the ban duration.
//
// Synced from Redis key "debug:binance-rate-limit-state" on startup via
// syncBackoffFromRedis(redis) called from server.js after Redis is ready.
//
const backoff = { spot: 0, futures: 0 };

function _marketKey(url) {
  return url.includes('fapi.binance.com') ? 'futures' : 'spot';
}

function isGloballyBanned(url) {
  return Date.now() < backoff[_marketKey(url)];
}

function setBackoff(durationMs, url) {
  const key      = _marketKey(url);
  const newUntil = Date.now() + durationMs;
  if (newUntil > backoff[key]) {
    backoff[key] = newUntil;
    console.error(
      `[binance-rest/backend] ${key} IP BACKOFF set — calls paused for ${Math.ceil(durationMs / 1000)}s` +
      ` (until ${new Date(newUntil).toISOString()})`,
    );
  }
}

// Call once after Redis is ready so backoff survives server restarts.
async function syncBackoffFromRedis(redis) {
  try {
    const raw = await redis.get('debug:binance-rate-limit-state');
    if (!raw) return;
    const saved = JSON.parse(raw);
    const now   = Date.now();
    for (const market of ['spot', 'futures']) {
      const until = saved[market]?.backoffUntilTs;
      if (until && until > now && until > backoff[market]) {
        backoff[market] = until;
        console.log(
          `[binance-rest/backend] restored ${market} IP ban from Redis — ${Math.ceil((until - now) / 1000)}s remaining`,
        );
      }
    }
  } catch (err) {
    console.error('[binance-rest/backend] syncBackoffFromRedis failed:', err.message);
  }
}

const rollingLog = [];

function evictOld() {
  const cutoff = Date.now() - 60_000;
  while (rollingLog.length > 0 && rollingLog[0].ts < cutoff) rollingLog.shift();
}

function buildSummary() {
  evictOld();
  const byService  = {};
  const byEndpoint = {};
  for (const r of rollingLog) {
    byService[r.service]   = (byService[r.service]  || 0) + 1;
    byEndpoint[r.endpoint] = (byEndpoint[r.endpoint] || 0) + 1;
  }
  return { total: rollingLog.length, byService, byEndpoint };
}

setInterval(() => {
  const s = buildSummary();
  if (s.total === 0) return;
  const sep = '='.repeat(48);
  console.log(`[binance-rest] ${sep}`);
  console.log(`[binance-rest]  Requests/min summary (backend) — total: ${s.total}`);
  for (const [svc, n] of Object.entries(s.byService).sort((a, b) => b[1] - a[1])) {
    console.log(`[binance-rest]    service  ${svc}: ${n} req/min`);
  }
  for (const [ep, n] of Object.entries(s.byEndpoint).sort((a, b) => b[1] - a[1])) {
    console.log(`[binance-rest]    endpoint ${ep}: ${n} req/min`);
  }
  console.log(`[binance-rest] ${sep}`);
}, REPORT_INTERVAL_MS);

function extractEndpoint(url) {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return url.split('?')[0];
  }
}

/**
 * Drop-in replacement for fetch() for all Binance REST calls.
 *
 * @param {string}        url
 * @param {RequestInit}   [opts]
 * @param {string}        service   e.g. "autoLevelsRoute"
 * @param {string}        [symbol]
 * @param {string}        [reason]
 * @returns {Promise<Response>}
 */
async function binanceFetch(url, opts, service, symbol = '*', reason = '') {
  // ── Per-market IP-level backoff guard ────────────────────────────────────────────
  // Spot and futures track separate bans — a futures IP ban never blocks spot.
  if (isGloballyBanned(url)) {
    const key         = _marketKey(url);
    const remainingMs = backoff[key] - Date.now();
    const err = new Error(
      `Binance ${key} IP ban active — skipping ${service} call for ${Math.ceil(remainingMs / 1000)}s`,
    );
    err.status = 418;
    err.retryAfterMs = remainingMs;
    throw err;
  }

  const startTs = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, opts);
    status = res.status;

    // Track 429/418 in-process so subsequent calls bail immediately
    if (res.status === 429 || res.status === 418) {
      const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
      const durationMs    = retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000;
      setBackoff(durationMs, url);
    }

    // ── Track rate-limit weight usage from response headers ────────────────
    // Preemptively pause backend calls if futures weight >= 83% of 2400 limit.
    const isFutures = url.includes('fapi.binance.com');
    const usedWeight = parseInt(res.headers.get('x-mbx-used-weight-1m') || '0', 10);
    const weightLimit = isFutures ? 2400 : 6000;
    if (usedWeight >= Math.floor(weightLimit * 0.83)) {
      setBackoff(15_000, url);
      console.error(
        `[binance-rest/backend] ${isFutures ? 'futures' : 'spot'} weight CRITICAL ` +
        `${usedWeight}/${weightLimit} — preemptive 15s pause`,
      );
    } else if (usedWeight >= Math.floor(weightLimit * 0.60)) {
      console.warn(
        `[binance-rest/backend] ${isFutures ? 'futures' : 'spot'} weight HIGH ${usedWeight}/${weightLimit}`,
      );
    }

    return res;
  } catch (err) {
    status = -1;
    throw err;
  } finally {
    const endpoint = extractEndpoint(url);
    rollingLog.push({ ts: startTs, service, endpoint, symbol, reason, status });
    console.log(
      `[binance-rest] ts=${startTs}` +
      ` service=${service}` +
      ` endpoint=${endpoint}` +
      ` symbol=${symbol}` +
      ` reason=${reason}` +
      ` status=${status}`,
    );
  }
}

function getBackoffState() {
  const now = Date.now();
  return {
    spot: {
      active:      now < backoff.spot,
      until:       backoff.spot || null,
      remainingMs: Math.max(0, backoff.spot - now),
    },
    futures: {
      active:      now < backoff.futures,
      until:       backoff.futures || null,
      remainingMs: Math.max(0, backoff.futures - now),
    },
  };
}

module.exports = { binanceFetch, buildSummary, syncBackoffFromRedis, getBackoffState };
