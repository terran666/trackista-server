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
  const startTs = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, opts);
    status = res.status;
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

module.exports = { binanceFetch, buildSummary };
