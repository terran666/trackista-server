'use strict';

/**
 * Binance REST API proxy route.
 *
 * Routes (registered as /api/binance/*):
 *   GET /api/binance/spot/*    → https://api.binance.com/api/*
 *   GET /api/binance/futures/* → https://fapi.binance.com/fapi/*
 *   GET /api/binance/debug     → proxy diagnostics (cache, backoff, errors)
 *
 * Path assembly note: Express 4 wildcard req.params[0] does NOT include
 * a leading slash (e.g. /spot/v3/klines → params[0] = 'v3/klines').
 * We always normalise the suffix to start with '/' before concatenating.
 *
 * Safe endpoints (exchangeInfo, ticker/24hr):
 *   - Bypass the in-process IP-ban guard (raw fetch, not binanceFetch).
 *   - Cached in-memory with short TTLs so the UI bootstraps quickly.
 *   - Stale cache is served if Binance is unreachable (x-proxy-cache: stale).
 *   - Critical: UI needs these even when collector triggered a backoff.
 *
 * Non-safe endpoints (klines, depth, etc.):
 *   - Routed through binanceFetch — backoff-aware and rate-limit logged.
 *   - All Binance 4xx/5xx → structured JSON with machine-readable reason code.
 *
 * Error reason codes:
 *   upstream_http_error     — Binance returned a non-OK HTTP status
 *   upstream_rate_limit     — Binance returned 429/418 directly
 *   upstream_network_error  — network-level failure (ECONNREFUSED, timeout, …)
 *   market_backoff_active   — in-process IP-ban guard blocked the call
 */

const { binanceFetch, buildSummary, getBackoffState } = require('../utils/binanceRestLogger');
const { authRequired } = require('../middleware/authRequired');

const SPOT_BASE     = 'https://api.binance.com/api';
const FUTURES_BASE  = 'https://fapi.binance.com/fapi';
const DELIVERY_BASE = 'https://dapi.binance.com';  // COIN-M delivery futures

// ── Safe endpoints ────────────────────────────────────────────────────────────
// Read-only, near-zero weight, critical for Screener bootstrap.
// Matched against pathKey (path without query string).
const SAFE_ENDPOINTS = new Set([
  '/v3/exchangeInfo',
  '/v1/exchangeInfo',
  '/dapi/v1/exchangeInfo',  // COIN-M delivery futures
  '/v3/ticker/24hr',
  '/v1/ticker/24hr',
]);

// Cache TTL per pathKey for safe endpoints
const CACHE_TTL_MS = {
  '/v3/exchangeInfo':    5 * 60 * 1000,  // 5 min — large payload, rarely changes
  '/v1/exchangeInfo':    5 * 60 * 1000,
  '/dapi/v1/exchangeInfo': 5 * 60 * 1000,  // COIN-M delivery futures
  '/v3/ticker/24hr':  30 * 1000,       // 30 s — prices update frequently
  '/v1/ticker/24hr':  30 * 1000,
  '/v3/klines':       60 * 1000,       // 60 s — chart history, changes slowly
  '/v1/klines':       60 * 1000,
  '/v1/aggTrades':     1_500,           // 1.5 s — dedup identical fromId polls
  '/v3/aggTrades':     1_500,
};
const DEFAULT_CACHE_TTL_MS = 30 * 1000;

// ── aggTrades per-symbol throttle ────────────────────────────────────────────
// /fapi/v1/aggTrades costs weight=20 per call. At 2 req/s × 60s = 2400 weight/min
// which saturates the entire budget. Throttle to 1 real upstream call per
// AGGTRADES_MIN_INTERVAL_MS per symbol; respond with 429 to fast retries.
const AGGTRADES_MIN_INTERVAL_MS = 2_000; // 1 req / 2s per symbol = 30 req/min = 600 weight/min
const aggTradesLastTs = new Map(); // symbol → last upstream call ts

// ── In-memory response cache ──────────────────────────────────────────────────
// Map<cacheKey, { body, status, headers, cachedAt, expiresAt }>
// Stale entries are NOT deleted immediately — kept for fallback during outages.
const responseCache = new Map();

// ── In-flight request deduplication ───────────────────────────────────────────
// Map<cacheKey, Promise> — multiple simultaneous identical requests share one upstream call.
// Critical for Screener: prevents 50 parallel exchangeInfo requests on page load.
const inflightRequests = new Map();

function getCachedFresh(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  return Date.now() <= entry.expiresAt ? entry : null;
}

function setCached(key, body, status, headers, ttlMs) {
  responseCache.set(key, {
    body,
    status,
    headers,
    cachedAt:  Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
}

// ── Proxy stats ───────────────────────────────────────────────────────────────
const proxyStats = {
  cacheHits:     0,
  cacheMisses:   0,
  dedupeHits:    0,  // number of requests served by in-flight deduplication
  requestCounts: {},  // `${market}:${pathKey}` → number
  errors:        [],  // ring buffer of last 50 errors
  // Screener-specific metrics
  screener: {
    exchangeInfoNormalized:    0,  // number of ?symbol= requests served from full cache
    exchangeInfoFullRequests:  0,  // number of full exchangeInfo upstream requests
    klinesPreviewCacheHits:    0,  // klines cache hits (preview charts)
  },
};

function recordError(market, path, reason, status) {
  proxyStats.errors.push({ ts: Date.now(), market, path, reason, status });
  if (proxyStats.errors.length > 50) proxyStats.errors.shift();
}

function recordRequest(key) {
  proxyStats.requestCounts[key] = (proxyStats.requestCounts[key] || 0) + 1;
}

// ── Smart cache key normalization ─────────────────────────────────────────────
// exchangeInfo requests with ?symbol= parameter are normalized to full exchangeInfo key.
// This prevents creating hundreds of identical 828KB cache entries.
function normalizedCacheKey(market, upstreamUrl, pathKey) {
  // For exchangeInfo, strip ?symbol= parameter from cache key — use full response
  if (pathKey === '/v3/exchangeInfo' || pathKey === '/v1/exchangeInfo' || pathKey === '/dapi/v1/exchangeInfo') {
    const base = upstreamUrl.split('?')[0];
    return `${market}:${base}`;
  }
  // For other endpoints, use full URL (including query string)
  return `${market}:${upstreamUrl}`;
}

// ── Server-side symbol filtering ──────────────────────────────────────────────
// If client requests exchangeInfo?symbol=XXX, we fetch full exchangeInfo and filter locally.
// This reuses the cached full response instead of creating a new upstream request.
function filterExchangeInfoBySymbol(fullBody, requestedSymbol) {
  try {
    const data = JSON.parse(fullBody);
    if (!data.symbols || !Array.isArray(data.symbols)) return fullBody;
    
    const filtered = data.symbols.filter(s => s.symbol === requestedSymbol);
    if (filtered.length === 0) return fullBody; // return full if not found
    
    return JSON.stringify({ ...data, symbols: filtered });
  } catch (err) {
    console.warn('[binance-proxy] failed to filter exchangeInfo by symbol:', err.message);
    return fullBody; // return full response on error
  }
}

// ── Header helpers ────────────────────────────────────────────────────────────
const FORWARD_HEADERS = [
  'content-type',
  'x-mbx-used-weight-1m',
  'x-mbx-used-weight',
  'retry-after',
];

function extractHeaders(upstreamRes) {
  const out = {};
  for (const h of FORWARD_HEADERS) {
    const v = upstreamRes.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

function applyHeaders(headers, res) {
  for (const [h, v] of Object.entries(headers)) res.setHeader(h, v);
}

// ── Proxy factory ─────────────────────────────────────────────────────────────
function makeProxy(targetBase, market) {
  return async (req, res) => {
    // Express 4 wildcard params[0] has no leading slash — normalise it.
    const rawSuffix   = req.params[0] || '';
    const pathSuffix  = rawSuffix.startsWith('/') ? rawSuffix : `/${rawSuffix}`;
    const qs          = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstreamUrl = `${targetBase}${pathSuffix}${qs}`;
    const pathKey     = pathSuffix.split('?')[0];     // path without QS, for classification
    const isSafe      = SAFE_ENDPOINTS.has(pathKey);
    const symbol      = (req.query.symbol || '*').toString().toUpperCase();
    
    // ── Smart cache key normalization ──────────────────────────────────────────
    // exchangeInfo with ?symbol= is normalized to full exchangeInfo key.
    // This prevents 400+ identical cache entries.
    const cacheKey = normalizedCacheKey(market, upstreamUrl, pathKey);
    const isExchangeInfo = (pathKey === '/v3/exchangeInfo' || pathKey === '/v1/exchangeInfo' || pathKey === '/dapi/v1/exchangeInfo');
    const requestedSymbol = isExchangeInfo && req.query.symbol ? req.query.symbol.toString().toUpperCase() : null;

    recordRequest(`${market}:${pathKey}`);

    console.log(
      `[binance-proxy] ${market} ${req.method} ${pathSuffix}${qs}` +
      ` → ${upstreamUrl} (safe=${isSafe}${requestedSymbol ? ` symbol=${requestedSymbol}` : ''})`,
    );

    // ── SAFE ENDPOINT PATH ─────────────────────────────────────────────────────
    // 1. Serve from fresh cache if available (with server-side symbol filtering).
    // 2. Check for in-flight request — dedupe simultaneous identical requests.
    // 3. Otherwise fetch via raw fetch (bypasses in-process ban guard).
    // 4. On upstream error or network failure, serve stale cache as fallback.
    // 5. If no cache at all, return structured JSON error.
    if (isSafe) {
      const cached = getCachedFresh(cacheKey);
      if (cached) {
        proxyStats.cacheHits++;
        const ageMs = Date.now() - cached.cachedAt;
        
        // Server-side symbol filtering for exchangeInfo
        let body = cached.body;
        if (requestedSymbol) {
          body = filterExchangeInfoBySymbol(cached.body, requestedSymbol);
          proxyStats.screener.exchangeInfoNormalized++;
          console.log(`[binance-proxy] ${market} ${pathKey} cache-hit + server-filter symbol=${requestedSymbol} (age=${Math.round(ageMs / 1000)}s)`);
        } else {
          console.log(`[binance-proxy] ${market} ${pathKey} cache-hit (age=${Math.round(ageMs / 1000)}s)`);
        }
        
        res.status(cached.status);
        applyHeaders(cached.headers, res);
        res.setHeader('x-proxy-cache', 'hit');
        return res.send(body);
      }
      
      // ── In-flight deduplication ─────────────────────────────────────────────
      // Multiple simultaneous identical requests share one upstream fetch.
      // Critical for Screener: prevents 50 parallel exchangeInfo on page load.
      const existingPromise = inflightRequests.get(cacheKey);
      if (existingPromise) {
        proxyStats.dedupeHits++;
        console.log(`[binance-proxy] ${market} ${pathKey} in-flight dedupe — waiting for existing request`);
        try {
          const result = await existingPromise;
          
          // Server-side symbol filtering
          let body = result.body;
          if (requestedSymbol) {
            body = filterExchangeInfoBySymbol(result.body, requestedSymbol);
            proxyStats.screener.exchangeInfoNormalized++;
          }
          
          res.status(result.status);
          applyHeaders(result.headers, res);
          res.setHeader('x-proxy-cache', 'dedupe');
          return res.send(body);
        } catch (err) {
          // Fallback to stale cache or error
          const stale = responseCache.get(cacheKey);
          if (stale) {
            console.warn(`[binance-proxy] ${market} ${pathKey} dedupe failed, serving stale`);
            res.status(200);
            applyHeaders(stale.headers, res);
            res.setHeader('x-proxy-cache', 'stale');
            return res.send(stale.body);
          }
          recordError(market, pathKey, 'dedupe_failed', -1);
          return res.status(502).json({
            success: false,
            error:   'Dedupe request failed and no cache available',
            market,
            reason:  'dedupe_failed',
          });
        }
      }
      
      proxyStats.cacheMisses++;
      
      // Track exchangeInfo full requests
      if (isExchangeInfo) {
        proxyStats.screener.exchangeInfoFullRequests++;
      }

      // Create and track in-flight promise
      const fetchPromise = (async () => {
        try {
          const upstreamRes = await fetch(targetBase + pathSuffix, {  // NO query string — fetch full
            method:  'GET',
            headers: { 'User-Agent': 'Trackista/2.0 binance-proxy' },
            signal:  AbortSignal.timeout(10_000),
          });
          const body    = await upstreamRes.text();
          const headers = extractHeaders(upstreamRes);

          if (upstreamRes.ok) {
            const ttlMs = CACHE_TTL_MS[pathKey] ?? DEFAULT_CACHE_TTL_MS;
            setCached(cacheKey, body, upstreamRes.status, headers, ttlMs);
            return { body, status: upstreamRes.status, headers, ok: true };
          }

          // Upstream error
          return { body, status: upstreamRes.status, headers, ok: false };
        } catch (err) {
          throw err;
        } finally {
          inflightRequests.delete(cacheKey);
        }
      })();
      
      inflightRequests.set(cacheKey, fetchPromise);

      try {
        const result = await fetchPromise;
        
        if (result.ok) {
          // Server-side symbol filtering
          let body = result.body;
          if (requestedSymbol) {
            body = filterExchangeInfoBySymbol(result.body, requestedSymbol);
            proxyStats.screener.exchangeInfoNormalized++;
          }
          
          res.status(result.status);
          applyHeaders(result.headers, res);
          res.setHeader('x-proxy-cache', 'miss');
          console.log(`[binance-proxy] ${market} ${pathKey} safe-bypass → status=${result.status}`);
          return res.send(body);
        }

        // Upstream returned an error — serve stale cache if available
        const stale = responseCache.get(cacheKey);
        if (stale) {
          console.warn(
            `[binance-proxy] ${market} ${pathKey} upstream HTTP ${result.status},` +
            ` serving stale cache (age=${Math.round((Date.now() - stale.cachedAt) / 1000)}s)`,
          );
          res.status(200);
          applyHeaders(stale.headers, res);
          res.setHeader('x-proxy-cache', 'stale');
          return res.send(stale.body);
        }

        recordError(market, pathKey, 'upstream_http_error', result.status);
        return res.status(result.status).json({
          success: false,
          error:   `Binance returned HTTP ${result.status}`,
          market,
          reason:  'upstream_http_error',
          path:    pathKey,
        });
      } catch (err) {
        // Network error — serve stale cache if available
        const stale = responseCache.get(cacheKey);
        if (stale) {
          console.warn(`[binance-proxy] ${market} ${pathKey} network error, serving stale cache`);
          res.status(200);
          applyHeaders(stale.headers, res);
          res.setHeader('x-proxy-cache', 'stale');
          return res.send(stale.body);
        }
        recordError(market, pathKey, 'upstream_network_error', -1);
        console.error(`[binance-proxy] ${market} ${pathKey} safe-bypass error: ${err.message}`);
        if (!res.headersSent) {
          return res.status(502).json({
            success: false,
            error:   'Binance proxy network error',
            market,
            reason:  'upstream_network_error',
            detail:  err.message,
          });
        }
      }
      return;
    }

    // ── NORMAL ENDPOINT PATH ───────────────────────────────────────────────────
    // Goes through binanceFetch — backoff-aware + rate-limit logged.
    // Cache klines for preview charts (short TTL).
    // All non-OK upstream responses are intercepted and returned as structured JSON.
    
    // Check cache for klines and aggTrades (dedup rapid identical polls)
    const isKlines    = (pathKey === '/v3/klines'    || pathKey === '/v1/klines');
    const isAggTrades = (pathKey === '/v3/aggTrades' || pathKey === '/v1/aggTrades');
    if (isKlines || isAggTrades) {
      const cached = getCachedFresh(cacheKey);
      if (cached) {
        proxyStats.cacheHits++;
        if (isKlines) proxyStats.screener.klinesPreviewCacheHits++;
        const ageMs = Date.now() - cached.cachedAt;
        console.log(`[binance-proxy] ${market} ${pathKey} cache-hit (age=${ageMs}ms)`);
        res.status(cached.status);
        applyHeaders(cached.headers, res);
        res.setHeader('x-proxy-cache', 'hit');
        return res.send(cached.body);
      }

      // Per-symbol throttle for aggTrades — prevent weight exhaustion
      if (isAggTrades) {
        const throttleKey = `${market}:${symbol}`;
        const lastTs = aggTradesLastTs.get(throttleKey) || 0;
        const elapsed = Date.now() - lastTs;
        if (elapsed < AGGTRADES_MIN_INTERVAL_MS) {
          const retryAfter = Math.ceil((AGGTRADES_MIN_INTERVAL_MS - elapsed) / 1000);
          return res.status(429).json({
            success: false,
            error:   'aggTrades throttled — too many requests for this symbol',
            market,
            reason:  'aggtrades_throttled',
            retryAfterMs: AGGTRADES_MIN_INTERVAL_MS - elapsed,
          });
        }
        aggTradesLastTs.set(throttleKey, Date.now());
      }

      // In-flight dedupe
      const existingPromise = inflightRequests.get(cacheKey);
      if (existingPromise) {
        proxyStats.dedupeHits++;
        try {
          const result = await existingPromise;
          res.status(result.status);
          applyHeaders(result.headers, res);
          res.setHeader('x-proxy-cache', 'dedupe');
          return res.send(result.body);
        } catch (err) {
          console.warn(`[binance-proxy] ${market} ${pathKey} dedupe failed, continuing to fetch`);
        }
      }
    }
    
    try {
      // Create in-flight promise for klines / aggTrades
      const fetchPromise = (isKlines || isAggTrades) ? (async () => {
        try {
          const upstreamRes = await binanceFetch(
            upstreamUrl,
            {
              method:  'GET',
              headers: { 'User-Agent': 'Trackista/2.0 binance-proxy' },
              signal:  AbortSignal.timeout(10_000),
            },
            'binanceProxy',
            symbol,
            pathKey,
          );
          
          const body = await upstreamRes.text();
          const headers = extractHeaders(upstreamRes);
          
          if (upstreamRes.ok) {
            const ttlMs = CACHE_TTL_MS[pathKey] ?? DEFAULT_CACHE_TTL_MS;
            setCached(cacheKey, body, upstreamRes.status, headers, ttlMs);
          }
          
          return { body, status: upstreamRes.status, headers, res: upstreamRes };
        } finally {
          inflightRequests.delete(cacheKey);
        }
      })() : null;
      
      if (fetchPromise) {
        inflightRequests.set(cacheKey, fetchPromise);
      }
      
      const upstreamRes = fetchPromise ? (await fetchPromise).res : await binanceFetch(
        upstreamUrl,
        {
          method:  'GET',
          headers: { 'User-Agent': 'Trackista/2.0 binance-proxy' },
          signal:  AbortSignal.timeout(10_000),
        },
        'binanceProxy',
        symbol,
        pathKey,
      );

      // Intercept upstream rate-limit responses
      if (upstreamRes.status === 429 || upstreamRes.status === 418) {
        const retryAfterSec = parseInt(upstreamRes.headers.get('retry-after') || '0', 10);
        const remainingMs   = retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000;
        recordError(market, pathKey, 'upstream_rate_limit', upstreamRes.status);
        console.warn(
          `[binance-proxy] ${market} ${pathKey} upstream rate-limit HTTP ${upstreamRes.status}` +
          ` remainingMs=${remainingMs}`,
        );
        return res.status(503).json({
          success:     false,
          error:       `Binance rate limit — HTTP ${upstreamRes.status}`,
          market,
          reason:      'upstream_rate_limit',
          remainingMs,
        });
      }

      // Intercept other upstream errors — never pass raw Binance error text silently
      if (!upstreamRes.ok) {
        const body = fetchPromise ? (await fetchPromise).body : await upstreamRes.text();
        recordError(market, pathKey, 'upstream_http_error', upstreamRes.status);
        console.warn(`[binance-proxy] ${market} ${pathKey} upstream HTTP ${upstreamRes.status}: ${body.slice(0, 200)}`);
        return res.status(upstreamRes.status).json({
          success: false,
          error:   `Binance returned HTTP ${upstreamRes.status}`,
          market,
          reason:  'upstream_http_error',
          path:    pathKey,
        });
      }

      res.status(upstreamRes.status);
      applyHeaders(extractHeaders(upstreamRes), res);
      const body = fetchPromise ? (await fetchPromise).body : await upstreamRes.text();
      console.log(`[binance-proxy] ${market} ${pathKey} → status=${upstreamRes.status}`);
      res.send(body);
    } catch (err) {
      // binanceFetch throws err.status=418 when in-process IP-ban guard fires
      if (err.status === 418) {
        const remainingMs = Math.round(err.retryAfterMs || 60_000);
        recordError(market, pathKey, 'market_backoff_active', 418);
        console.warn(
          `[binance-proxy] ${market} ${pathKey} blocked by IP ban guard` +
          ` remainingMs=${remainingMs} reason=market_backoff_active`,
        );
        return res.status(503).json({
          success:     false,
          error:       'Proxy temporarily blocked by rate-limit guard',
          market,
          reason:      'market_backoff_active',
          remainingMs,
        });
      }
      recordError(market, pathKey, 'upstream_network_error', -1);
      console.error(`[binance-proxy] ${market} ${pathKey} error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error:   'Binance proxy error',
          market,
          reason:  'upstream_network_error',
          detail:  err.message,
        });
      }
    }
  };
}

// ── Router factory ────────────────────────────────────────────────────────────
function createBinanceProxyRouter() {
  const { Router } = require('express');
  const router = Router();

  // /api/binance/spot/v3/...         → https://api.binance.com/api/v3/...
  // /api/binance/futures/v1/...      → https://fapi.binance.com/fapi/v1/...
  // /api/binance/delivery/dapi/v1/... → https://dapi.binance.com/dapi/v1/... (COIN-M)
  router.get('/spot/*',     makeProxy(SPOT_BASE,     'spot'));
  router.get('/futures/*',  makeProxy(FUTURES_BASE,  'futures'));
  router.get('/delivery/*', makeProxy(DELIVERY_BASE, 'delivery'));

  // /api/binance/debug — proxy diagnostics
  // Shows backoff state, cache entries, recent errors, per-endpoint request counts.
  // Enhanced with Screener-specific metrics.
  router.get('/debug', authRequired, (_req, res) => {
    const now = Date.now();
    const cacheEntries = [];
    let totalCacheSize = 0;
    for (const [key, entry] of responseCache.entries()) {
      const sizeBytes = entry.body.length;
      totalCacheSize += sizeBytes;
      cacheEntries.push({
        key,
        cachedAt:    new Date(entry.cachedAt).toISOString(),
        expiresAt:   new Date(entry.expiresAt).toISOString(),
        ageMs:       now - entry.cachedAt,
        remainingMs: Math.max(0, entry.expiresAt - now),
        status:      entry.status,
        sizeBytes,
        stale:       now > entry.expiresAt,
      });
    }
    
    // In-flight requests count
    const inflightCount = inflightRequests.size;
    const inflightKeys = Array.from(inflightRequests.keys());
    
    // Cache efficiency metrics
    const totalRequests = proxyStats.cacheHits + proxyStats.cacheMisses;
    const cacheHitRate = totalRequests > 0 
      ? ((proxyStats.cacheHits / totalRequests) * 100).toFixed(1) + '%'
      : 'N/A';
      
    return res.json({
      success: true,
      now:     new Date(now).toISOString(),
      backoff: getBackoffState(),
      cache: {
        hits:         proxyStats.cacheHits,
        misses:       proxyStats.cacheMisses,
        hitRate:      cacheHitRate,
        dedupeHits:   proxyStats.dedupeHits,
        totalEntries: cacheEntries.length,
        totalSize:    totalCacheSize,
        totalSizeMB:  (totalCacheSize / (1024 * 1024)).toFixed(2),
        entries:      cacheEntries,
      },
      inflight: {
        active: inflightCount,
        keys:   inflightKeys,
      },
      screenerMetrics: {
        exchangeInfoNormalized:    proxyStats.screener.exchangeInfoNormalized,
        exchangeInfoFullRequests:  proxyStats.screener.exchangeInfoFullRequests,
        klinesPreviewCacheHits:    proxyStats.screener.klinesPreviewCacheHits,
        description: {
          exchangeInfoNormalized:   'Number of ?symbol= requests served from full exchangeInfo cache',
          exchangeInfoFullRequests: 'Number of full exchangeInfo upstream requests to Binance',
          klinesPreviewCacheHits:   'Cache hits for preview chart klines',
        },
      },
      recentErrors:       proxyStats.errors.slice(-20),
      requestCounts:      proxyStats.requestCounts,
      binanceRestSummary: buildSummary(),
    });
  });

  return router;
}

module.exports = { createBinanceProxyRouter };
