'use strict';

// ─── Wall Watchlist Builder v2 ────────────────────────────────────
//
// Returns ONE ROW PER WALL (not one per symbol).
// All confirmed walls from all tracked symbols are collected, sorted and
// returned as a flat ranked list:
//   1. strength desc   (biggest multiple of threshold = most significant)
//   2. distancePct asc (closer to price = more actionable)
//   3. lifetimeMs desc (persistent = more reliable)
//   4. usdValue desc   (bigger = more relevant)
//
// This means a symbol with 5 walls contributes 5 rows; the frontend can
// group by symbol or show the flat list.

const MAX_LIMIT = 1000;
const BIAS_RANGE_PCT = 0.005;

// ─── Helpers ──────────────────────────────────────────────────────

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Compute bias from walls within ±BIAS_RANGE_PCT of midPrice.
 */
function computeBias(walls, midPrice) {
  if (!midPrice || !walls.length) return 'NEUTRAL';
  const rangeLow  = midPrice * (1 - BIAS_RANGE_PCT);
  const rangeHigh = midPrice * (1 + BIAS_RANGE_PCT);
  let bidUsd = 0;
  let askUsd = 0;
  for (const w of walls) {
    if (w.price < rangeLow || w.price > rangeHigh) continue;
    if (w.side === 'bid') bidUsd += w.usdValue || 0;
    else                  askUsd += w.usdValue || 0;
  }
  const total = bidUsd + askUsd;
  if (total === 0) return 'NEUTRAL';
  const bidRatio = bidUsd / total;
  if (bidRatio > 0.6) return 'LONG';
  if (bidRatio < 0.4) return 'SHORT';
  return 'NEUTRAL';
}

/**
 * Rank comparator for individual walls.
 * Primary: strength desc (most significant first)
 * Secondary: distancePct asc (closer = more actionable)
 * Tertiary: lifetimeMs desc (persistent = more reliable)
 * Quaternary: usdValue desc (bigger = more relevant)
 */
function compareWalls(a, b) {
  const strA = a.strength ?? 0;
  const strB = b.strength ?? 0;
  if (strA !== strB) return strB - strA;

  const distA = Math.abs(a.distancePct ?? Infinity);
  const distB = Math.abs(b.distancePct ?? Infinity);
  if (distA !== distB) return distA - distB;

  const lifeA = a.lifetimeMs ?? 0;
  const lifeB = b.lifetimeMs ?? 0;
  if (lifeA !== lifeB) return lifeB - lifeA;

  return (b.usdValue ?? 0) - (a.usdValue ?? 0);
}

// ─── Symbol resolution ────────────────────────────────────────────

/**
 * Resolve the list of symbols to scan.
 * For futures: reads density:symbols:tracked:futures (the managed list).
 * For spot:    reads density:symbols:tracked:spot, falls back to symbols:active:usdt.
 * If symbolsParam is provided, it always overrides the Redis lookup.
 */
async function resolveSymbols(redis, symbolsParam, marketType) {
  if (symbolsParam) {
    return [...new Set(
      symbolsParam
        .split(',')
        .map(s => s.toUpperCase().trim())
        .filter(Boolean),
    )];
  }

  if (marketType === 'futures') {
    const raw  = await redis.get('density:symbols:tracked:futures');
    const data = safeParse(raw);
    const syms = Array.isArray(data?.symbols) ? data.symbols : [];
    return syms;
  }

  // spot: prefer managed list, fall back to full active list
  const raw  = await redis.get('density:symbols:tracked:spot');
  const data = safeParse(raw);
  if (Array.isArray(data?.symbols) && data.symbols.length > 0) {
    return data.symbols;
  }
  const fallback = await redis.get('symbols:active:usdt');
  const syms = safeParse(fallback);
  return Array.isArray(syms) ? syms : [];
}

// ─── Main builder ─────────────────────────────────────────────────

/**
 * Build a wall watchlist: one row per wall across all tracked symbols.
 *
 * Redis keys used:
 *  spot:    orderbook:${sym}         walls:${sym}         signal:${sym}
 *  futures: futures:orderbook:${sym} futures:walls:${sym} signal:${sym}
 *
 * @param {import('ioredis').Redis} redis
 * @param {{
 *   symbolsParam?: string,
 *   limit?:        number,
 *   marketType?:   'spot' | 'futures',
 * }} opts
 * @returns {Promise<{ items: object[], marketType: string, updatedAt: number }>}
 */
async function buildWallWatchlist(redis, { symbolsParam, limit, marketType = 'spot' } = {}) {
  const mt      = marketType === 'futures' ? 'futures' : 'spot';
  const symbols = await resolveSymbols(redis, symbolsParam, mt);

  if (symbols.length === 0) {
    return { items: [], marketType: mt, updatedAt: Date.now() };
  }

  // Fetch 3 keys per symbol in one pipeline
  const pipeline = redis.pipeline();
  for (const sym of symbols) {
    pipeline.get(mt === 'futures' ? `futures:orderbook:${sym}` : `orderbook:${sym}`);
    pipeline.get(mt === 'futures' ? `futures:walls:${sym}`     : `walls:${sym}`);
    pipeline.get(`signal:${sym}`);
  }
  const results = await pipeline.exec();

  const items = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const base   = i * 3;

    const ob       = safeParse(results[base][1]);
    const wallsDoc = safeParse(results[base + 1][1]);
    const signal   = safeParse(results[base + 2][1]);

    // Skip symbols with no walls data
    if (!wallsDoc || !Array.isArray(wallsDoc.walls) || wallsDoc.walls.length === 0) continue;

    const walls    = wallsDoc.walls;
    const midPrice = ob?.midPrice ?? wallsDoc.midPrice ?? null;
    const updatedAt = ob?.updatedAt ?? wallsDoc.updatedAt ?? null;
    const bias     = signal?.bias ?? computeBias(walls, midPrice);

    // Emit one row per wall (all confirmed walls, not just the best one)
    for (const w of walls) {
      items.push({
        symbol,
        side:        w.side,
        wallUsd:     w.usdValue     ?? null,
        price:       w.price        ?? null,
        distancePct: w.distancePct  != null ? Math.abs(w.distancePct) : null,
        lifetimeMs:  w.lifetimeMs   ?? null,
        strength:    w.strength     ?? null,
        deepWall:    w.deepWall     ?? false,
        bias,
        midPrice,
        updatedAt,
        marketType:  mt,
      });
    }
  }

  // Sort: strongest → nearest → oldest → biggest
  items.sort(compareWalls);

  // Apply limit
  const cappedLimit = limit && limit > 0 ? Math.min(limit, MAX_LIMIT) : MAX_LIMIT;
  return { items: items.slice(0, cappedLimit), marketType: mt, updatedAt: Date.now() };
}

module.exports = { buildWallWatchlist };

