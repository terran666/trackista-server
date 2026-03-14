'use strict';

// ─── Wall Watchlist Builder ───────────────────────────────────────
//
// For each symbol in the resolved list:
//   - Load walls + orderbook + signal from Redis via pipeline
//   - Skip symbols with no walls data (untracked)
//   - Pick the single best wall per symbol by ranking:
//       1. smaller distancePct  (closer to mid = more interesting)
//       2. larger lifetimeMs    (persistent = more reliable)
//       3. larger strength      (stronger = more relevant)
//       4. larger usdValue      (bigger = more relevant)
//   - Assemble one watchlist row per symbol
//   - Sort rows by same ranking (best setup first)

const MAX_LIMIT = 500;
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
 * Rank comparator: lower = better candidate for "best wall".
 * Returns negative if a is better, positive if b is better.
 */
function compareWalls(a, b) {
  const distA = Math.abs(a.distancePct ?? Infinity);
  const distB = Math.abs(b.distancePct ?? Infinity);
  if (distA !== distB) return distA - distB;

  const lifeA = a.lifetimeMs ?? 0;
  const lifeB = b.lifetimeMs ?? 0;
  if (lifeA !== lifeB) return lifeB - lifeA;  // larger = better

  const strA = a.strength ?? 0;
  const strB = b.strength ?? 0;
  if (strA !== strB) return strB - strA;  // larger = better

  const usdA = a.usdValue ?? 0;
  const usdB = b.usdValue ?? 0;
  return usdB - usdA;  // larger = better
}

// ─── Symbol resolution ────────────────────────────────────────────

async function resolveSymbols(redis, symbolsParam, limit) {
  let symbols;

  if (symbolsParam) {
    symbols = [...new Set(
      symbolsParam
        .split(',')
        .map(s => s.toUpperCase().trim())
        .filter(Boolean),
    )];
  } else {
    const raw = await redis.get('symbols:active:usdt');
    symbols = raw ? safeParse(raw) : [];
    if (!Array.isArray(symbols)) symbols = [];
  }

  if (limit && limit > 0) {
    symbols = symbols.slice(0, Math.min(limit, MAX_LIMIT));
  }

  return symbols;
}

// ─── Main builder ─────────────────────────────────────────────────

/**
 * Build a wall watchlist: one best-wall row per tracked symbol.
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
 * @returns {Promise<{ items: object[], marketType: string }>}
 */
async function buildWallWatchlist(redis, { symbolsParam, limit, marketType = 'spot' } = {}) {
  const mt      = marketType === 'futures' ? 'futures' : 'spot';
  const symbols = await resolveSymbols(redis, symbolsParam, limit);

  if (symbols.length === 0) {
    return { items: [], marketType: mt };
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

    // Skip untracked symbols (no walls data at all)
    if (!wallsDoc || !Array.isArray(wallsDoc.walls) || wallsDoc.walls.length === 0) {
      continue;
    }

    const walls    = wallsDoc.walls;
    const midPrice = ob?.midPrice ?? wallsDoc.midPrice ?? null;
    const updatedAt = ob?.updatedAt ?? wallsDoc.updatedAt ?? null;

    // Pick best wall
    const bestWall = [...walls].sort(compareWalls)[0];

    const bias     = signal?.bias ?? computeBias(walls, midPrice);

    items.push({
      symbol,
      side:         bestWall.side,
      wallUsd:      bestWall.usdValue       ?? null,
      price:        bestWall.price          ?? null,
      distancePct:  bestWall.distancePct    != null ? Math.abs(bestWall.distancePct) : null,
      lifetimeMs:   bestWall.lifetimeMs     ?? null,
      strength:     bestWall.strength       ?? null,
      etaSec:       null,  // reserved for future velocity-based ETA
      bias,
      midPrice,
      updatedAt,
      marketType:   mt,
    });
  }

  // Sort rows: same ranking as wall selection (best setup first)
  items.sort((a, b) => {
    const distA = a.distancePct ?? Infinity;
    const distB = b.distancePct ?? Infinity;
    if (distA !== distB) return distA - distB;

    const lifeA = a.lifetimeMs ?? 0;
    const lifeB = b.lifetimeMs ?? 0;
    if (lifeA !== lifeB) return lifeB - lifeA;

    const strA = a.strength ?? 0;
    const strB = b.strength ?? 0;
    if (strA !== strB) return strB - strA;

    return (b.wallUsd ?? 0) - (a.wallUsd ?? 0);
  });

  return { items, marketType: mt };
}

module.exports = { buildWallWatchlist };
