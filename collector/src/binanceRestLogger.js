'use strict';

// ─── Binance REST Logger ───────────────────────────────────────────
//
// Single module instance (Node.js require-cache), shared across ALL files in
// the collector process (orderbookCollector, futuresOrderbookCollector, collector).
//
// Usage:
//   const { binanceFetch } = require('./binanceRestLogger');
//   const res = await binanceFetch(url, fetchOpts, service, symbol, reason);
//
// Every call is logged immediately:
//   [binance-rest] ts=... service=orderbookCollector endpoint=/api/v3/depth symbol=BTCUSDT reason=initialSync status=200
//
// Every 60 s a requests/min summary is printed per service + endpoint.
//
// IP-ban guard: checks rateLimitStateStore (hydrated by orderbookCollectors via
// initAndRestore) before every outbound call.  URL-based market detection routes
// fapi.binance.com calls to the futures ban state and all others to spot.
// Falls back safely (no block) if the store has not yet been initialised.

const rateLimitStateStore = require('./shared/binanceRateLimitStateStore');

const REPORT_INTERVAL_MS = 60_000;

// Rolling log: each entry is kept for 60 s then evicted.
// Stored as { ts, service, endpoint, symbol, reason, status }
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
  console.log(`[binance-rest]  Requests/min summary — total: ${s.total}`);
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
 * @param {string}        url       Full Binance REST URL
 * @param {RequestInit}   [opts]    fetch options (optional)
 * @param {string}        service   Caller label, e.g. "orderbookCollector"
 * @param {string}        [symbol]  e.g. "BTCUSDT" or "*" for all-symbols calls
 * @param {string}        [reason]  e.g. "initialSync" | "resync" | "volumeRefresh"
 * @returns {Promise<Response>}
 */
async function binanceFetch(url, opts, service, symbol = '*', reason = '') {
  // ── Centralised IP ban guard ───────────────────────────────────────────────
  // Determines market from URL (fapi.binance.com → futures, everything else → spot)
  // and rejects the call immediately if a ban is still active.
  // rateLimitStateStore is populated by orderbookCollector / futuresOrderbookCollector
  // after their initAndRestore() calls; before that, backoffUntilTs is null so
  // this guard is a no-op (safe fallback at collector startup).
  const market = url.includes('fapi.binance.com') ? 'futures' : 'spot';
  const ms = rateLimitStateStore.getMarketState(market);
  if (ms.backoffUntilTs !== null && Date.now() < ms.backoffUntilTs) {
    const remaining = Math.ceil((ms.backoffUntilTs - Date.now()) / 1000);
    const err = new Error(
      `[binanceFetch] ${market} IP ban active — skipping ${service} call (${remaining}s remaining)`,
    );
    err.status = 418;
    throw err;
  }

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
