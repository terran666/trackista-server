'use strict';

// ─── Constants ────────────────────────────────────────────────────
// Scale used for visible-range bias computation in summary view (±0.5%)
const BIAS_RANGE_PCT = 0.005;

const MAX_LIMIT = 500;

// ─── Liquidity score reference baselines ─────────────────────────
// Used to normalise raw metric values into a 0–100 score.
// These are approximate "very active" benchmarks; values above them
// simply clamp the contribution to 100%.
const LSCORE_VOL_REF    = 5_000_000;  // volumeUsdt60s considered "high"
const LSCORE_COUNT_REF  = 5_000;      // tradeCount60s considered "high"
const LSCORE_SPREAD_REF = 0.001;      // spreadPct above this is "wide" (penalised)
const LSCORE_ACT_REF    = 500_000;    // activityScore considered "high"

/**
 * Compute a 0–100 liquidity score from available per-symbol metrics.
 * Higher = more liquid.
 *
 * Weights:
 *   40% volumeUsdt60s     (normalised vs LSCORE_VOL_REF)
 *   25% tradeCount60s     (normalised vs LSCORE_COUNT_REF)
 *   20% activityScore     (normalised vs LSCORE_ACT_REF)
 *   15% spreadPct         (penalised — higher spread → lower score)
 *
 * @param {object|null} metrics
 * @param {object|null} ob
 * @returns {number}  integer 0–100
 */
function computeLiquidityScore(metrics, ob) {
  const vol60s    = metrics?.volumeUsdt60s  ?? 0;
  const count60s  = metrics?.tradeCount60s  ?? 0;
  const actScore  = metrics?.activityScore  ?? 0;
  const bestBid   = ob?.bestBid             ?? null;
  const bestAsk   = ob?.bestAsk             ?? null;
  const midPrice  = ob?.midPrice            ?? null;

  const spread = (bestBid != null && bestAsk != null && midPrice)
    ? (bestAsk - bestBid) / midPrice
    : LSCORE_SPREAD_REF; // treat missing spread as "wide"

  const vScore  = Math.min(vol60s   / LSCORE_VOL_REF,   1) * 40;
  const cScore  = Math.min(count60s / LSCORE_COUNT_REF, 1) * 25;
  const aScore  = Math.min(actScore / LSCORE_ACT_REF,   1) * 20;
  // Spread: 0 spread → full 15 pts; at or above ref → 0 pts
  const sScore  = Math.max(1 - (spread / LSCORE_SPREAD_REF), 0) * 15;

  return Math.round(vScore + cScore + aScore + sScore);
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Derive a bias label from bid vs ask USD value within the visible range.
 *
 * @param {Array<{side:string,price:number,usdValue:number}>} walls
 * @param {number} rangeLow
 * @param {number} rangeHigh
 * @returns {'LONG'|'SHORT'|'NEUTRAL'}
 */
function computeBias(walls, rangeLow, rangeHigh) {
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
 * Safe JSON parse — returns null on any error.
 * @param {string|null} raw
 * @returns {object|null}
 */
function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ─── Symbol resolution ────────────────────────────────────────────

/**
 * Resolve the target symbol list:
 *   - If `symbolsParam` is provided, split and sanitise it.
 *   - Otherwise load symbols:active:usdt from Redis.
 *   - Apply optional limit.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string|undefined} symbolsParam  raw query param value
 * @param {number|undefined} limit
 * @returns {Promise<string[]>}
 */
async function resolveSymbols(redis, symbolsParam, limit, marketType) {
  let symbols;

  if (symbolsParam) {
    // Explicit list from caller — uppercase + dedup
    symbols = [...new Set(
      symbolsParam
        .split(',')
        .map(s => s.toUpperCase().trim())
        .filter(Boolean),
    )];
  } else if (marketType === 'futures') {
    // Use the futures-specific tracked list (written by dynamicTrackedSymbolsManager),
    // not the full spot universe — futures symbols are a filtered subset.
    const raw = await redis.get('density:symbols:tracked:futures');
    const data = safeParse(raw);
    symbols = Array.isArray(data?.symbols) && data.symbols.length > 0 ? data.symbols : [];
  } else {
    // Use the spot-specific tracked list (written by dynamicTrackedSymbolsManager).
    // Falls back to empty when spot density is disabled.
    const raw = await redis.get('density:symbols:tracked:spot');
    const data = safeParse(raw);
    symbols = Array.isArray(data?.symbols) ? data.symbols : [];
  }

  if (limit && limit > 0) {
    symbols = symbols.slice(0, Math.min(limit, MAX_LIMIT));
  }

  return symbols;
}

// ─── Per-symbol item builder ──────────────────────────────────────

/**
 * Assemble one summary item from parsed Redis payloads.
 *
 * @param {string} symbol
 * @param {object|null} ob       parsed orderbook
 * @param {object|null} wallsDoc parsed walls document
 * @param {object|null} metrics  parsed metrics
 * @param {object|null} signal   parsed signal
 * @returns {object}
 */
function buildItem(symbol, ob, wallsDoc, metrics, signal) {
  const rawWalls = wallsDoc?.walls;
  const walls = Array.isArray(rawWalls) ? rawWalls : [];

  // ── Price fields ────────────────────────────────────────────────
  const bestBid = ob?.bestBid  ?? null;
  const bestAsk = ob?.bestAsk  ?? null;
  const midPrice = ob?.midPrice ?? (
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null
  );

  const spreadPct = (bestBid !== null && bestAsk !== null && midPrice)
    ? (bestAsk - bestBid) / midPrice
    : null;

  // ── Wall fields ─────────────────────────────────────────────────
  const wallsCount    = walls.length;
  const bidWallsCount = walls.filter(w => w.side === 'bid').length;
  const askWallsCount = walls.filter(w => w.side === 'ask').length;

  let nearestWallDistancePct  = null;
  let nearestWallLifetimeMs   = null;
  let topWallStrength         = null;

  if (walls.length > 0) {
    // Nearest wall by absolute distancePct
    let nearestWall = null;
    let minDist = Infinity;
    for (const w of walls) {
      const d = Math.abs(w.distancePct ?? Infinity);
      if (d < minDist) { minDist = d; nearestWall = w; }
    }
    if (isFinite(minDist)) {
      nearestWallDistancePct = minDist;
      nearestWallLifetimeMs  = nearestWall?.lifetimeMs ?? null;
    }

    // Top strength across all walls
    for (const w of walls) {
      if (w.strength != null && (topWallStrength === null || w.strength > topWallStrength)) {
        topWallStrength = w.strength;
      }
    }
  }

  // ── Bias ────────────────────────────────────────────────────────
  let bias = 'NEUTRAL';
  if (midPrice !== null && walls.length > 0) {
    const rangeLow  = midPrice * (1 - BIAS_RANGE_PCT);
    const rangeHigh = midPrice * (1 + BIAS_RANGE_PCT);
    bias = computeBias(walls, rangeLow, rangeHigh);
  }

  // ── Liquidity score ─────────────────────────────────────────────
  const liquidityScore = computeLiquidityScore(metrics, ob);

  // ── Metrics fields ──────────────────────────────────────────────
  const volumeUsdt60s  = metrics?.volumeUsdt60s  ?? null;
  const tradeCount60s  = metrics?.tradeCount60s  ?? null;
  const activityScore  = metrics?.activityScore  ?? null;

  // ── Signal fields ───────────────────────────────────────────────
  const deltaImbalancePct60s = signal?.deltaImbalancePct60s ?? null;
  const impulseScore         = signal?.impulseScore         ?? null;
  const impulseDirection     = signal?.impulseDirection     ?? null;

  // ── updatedAt: prefer orderbook timestamp ───────────────────────
  const updatedAt = ob?.updatedAt ?? wallsDoc?.updatedAt ?? metrics?.updatedAt ?? null;

  return {
    symbol,
    midPrice,
    bestBid,
    bestAsk,
    spreadPct,
    wallsCount,
    bidWallsCount,
    askWallsCount,
    nearestWallDistancePct,
    nearestWallLifetimeMs,
    topWallStrength,
    liquidityScore,
    volumeUsdt60s,
    tradeCount60s,
    deltaImbalancePct60s,
    activityScore,
    impulseScore,
    impulseDirection,
    bias,
    updatedAt,
  };
}

// ─── Main builder ─────────────────────────────────────────────────

/**
 * Build a density summary for the requested symbol list.
 *
 * For spot:    orderbook:${sym}         walls:${sym}
 *             metrics:${sym}            signal:${sym}
 *
 * For futures: futures:orderbook:${sym} futures:walls:${sym}
 *             metrics:${sym}            signal:${sym}  (spot metrics reused)
 *
 * Returns items sorted by activityScore DESC (nulls last).
 *
 * @param {import('ioredis').Redis} redis
 * @param {{
 *   symbolsParam?: string,
 *   limit?:        number,
 *   marketType?:   'spot' | 'futures',
 * }} opts
 * @returns {Promise<{ symbols: string[], items: object[], marketType: string }>}
 */
async function buildDensitySummary(redis, { symbolsParam, limit, marketType = 'spot' } = {}) {
  const mt      = marketType === 'futures' ? 'futures' : 'spot';
  const symbols = await resolveSymbols(redis, symbolsParam, limit, mt);

  if (symbols.length === 0) {
    return { symbols: [], items: [], marketType: mt };
  }

  // ── One pipeline for all symbols, 4 keys each ──────────────────
  // futures:orderbook / futures:walls for futures; spot keys otherwise.
  // metrics and signal are always spot keys (spot collector only).
  const pipeline = redis.pipeline();
  for (const sym of symbols) {
    pipeline.get(mt === 'futures' ? `futures:orderbook:${sym}` : `orderbook:${sym}`);
    pipeline.get(mt === 'futures' ? `futures:walls:${sym}`     : `walls:${sym}`);
    pipeline.get(`metrics:${sym}`);
    pipeline.get(`signal:${sym}`);
  }
  const results = await pipeline.exec();

  const items = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const base   = i * 4;
    try {
      const row = results[base];
      if (!row) continue; // defensive: pipeline result missing

      const ob       = safeParse(results[base][1]);
      const wallsDoc = safeParse(results[base + 1][1]);
      const metrics  = safeParse(results[base + 2][1]);
      const signal   = safeParse(results[base + 3][1]);

      const item = buildItem(symbol, ob, wallsDoc, metrics, signal);
      item.marketType = mt;
      items.push(item);
    } catch (err) {
      console.warn(`[density-summary] skipping ${symbol} — processing error: ${err.message}`);
    }
  }

  // Sort by activityScore DESC, nulls at the end
  items.sort((a, b) => {
    if (a.activityScore === null && b.activityScore === null) return 0;
    if (a.activityScore === null) return 1;
    if (b.activityScore === null) return -1;
    return b.activityScore - a.activityScore;
  });

  return { symbols, items, marketType: mt };
}

module.exports = { buildDensitySummary };
