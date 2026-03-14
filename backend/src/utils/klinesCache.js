'use strict';

// ─── Shared klines cache ───────────────────────────────────────────
//
// Single in-process cache for Binance klines bars, shared between
// autoLevelsRoute and levelsEngineRoute so that the SAME
// symbol+interval+marketType+limit combination is never fetched from
// Binance twice within the TTL window, even when both routes are called
// by the frontend within the same request burst.
//
// Cache key (used by callers):
//   `${symbol.toUpperCase()}:${interval}:${marketType}:${limit}`
//
// TTL is read from KLINES_CACHE_TTL_MS env (default 15 000 ms).

const KLINES_CACHE_TTL_MS = parseInt(process.env.KLINES_CACHE_TTL_MS || '15000', 10);
const klinesCache = new Map(); // key → { bars, expiresAt }

function getCachedBars(key) {
  const entry = klinesCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    klinesCache.delete(key);
    return null;
  }
  return entry.bars;
}

function setCachedBars(key, bars) {
  klinesCache.set(key, { bars, expiresAt: Date.now() + KLINES_CACHE_TTL_MS });
  // Simple expired-entry GC when the cache grows large
  if (klinesCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of klinesCache) {
      if (now > v.expiresAt) klinesCache.delete(k);
    }
  }
}

module.exports = { getCachedBars, setCachedBars, KLINES_CACHE_TTL_MS };
