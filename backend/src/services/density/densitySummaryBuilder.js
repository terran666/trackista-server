'use strict';

// ─── Constants ────────────────────────────────────────────────────
// Scale used for visible-range bias computation in summary view (±0.5%)
const BIAS_RANGE_PCT = 0.005;

const MAX_LIMIT = 500;

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
async function resolveSymbols(redis, symbolsParam, limit) {
  let symbols;

  if (symbolsParam) {
    // Explicit list from caller — uppercase + dedup
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
  const walls = wallsDoc?.walls ?? [];

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

  let nearestWallDistancePct = null;
  if (walls.length > 0) {
    nearestWallDistancePct = Math.min(...walls.map(w => Math.abs(w.distancePct ?? Infinity)));
    if (!isFinite(nearestWallDistancePct)) nearestWallDistancePct = null;
  }

  // ── Bias ────────────────────────────────────────────────────────
  let bias = 'NEUTRAL';
  if (midPrice !== null && walls.length > 0) {
    const rangeLow  = midPrice * (1 - BIAS_RANGE_PCT);
    const rangeHigh = midPrice * (1 + BIAS_RANGE_PCT);
    bias = computeBias(walls, rangeLow, rangeHigh);
  }

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
 * Reads (per symbol) via a single Redis pipeline:
 *   orderbook:${sym}  walls:${sym}  metrics:${sym}  signal:${sym}
 *
 * Returns items sorted by activityScore DESC (nulls last).
 *
 * @param {import('ioredis').Redis} redis
 * @param {{
 *   symbolsParam?: string,
 *   limit?:        number,
 * }} opts
 * @returns {Promise<{ symbols: string[], items: object[] }>}
 */
async function buildDensitySummary(redis, { symbolsParam, limit } = {}) {
  const symbols = await resolveSymbols(redis, symbolsParam, limit);

  if (symbols.length === 0) {
    return { symbols: [], items: [] };
  }

  // ── One pipeline for all symbols, 4 keys each ──────────────────
  const pipeline = redis.pipeline();
  for (const sym of symbols) {
    pipeline.get(`orderbook:${sym}`);
    pipeline.get(`walls:${sym}`);
    pipeline.get(`metrics:${sym}`);
    pipeline.get(`signal:${sym}`);
  }
  const results = await pipeline.exec();

  const items = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const base   = i * 4;

    const ob       = safeParse(results[base][1]);
    const wallsDoc = safeParse(results[base + 1][1]);
    const metrics  = safeParse(results[base + 2][1]);
    const signal   = safeParse(results[base + 3][1]);

    items.push(buildItem(symbol, ob, wallsDoc, metrics, signal));
  }

  // Sort by activityScore DESC, nulls at the end
  items.sort((a, b) => {
    if (a.activityScore === null && b.activityScore === null) return 0;
    if (a.activityScore === null) return 1;
    if (b.activityScore === null) return -1;
    return b.activityScore - a.activityScore;
  });

  return { symbols, items };
}

module.exports = { buildDensitySummary };
