'use strict';

// ─── Scale → rangePct mapping ──────────────────────────────────────
// Each scale key maps to the ± percentage (decimal) applied to midPrice.
const SCALE_MAP = {
  x1:  0.0010,   // ±0.10%
  x2:  0.0020,   // ±0.20%
  x5:  0.0050,   // ±0.50%
  x10: 0.0100,   // ±1.00%
  x25: 0.0250,   // ±2.50%
};

const DEFAULT_SCALE = 'x5';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Normalise the user-supplied scale string.
 * Accepts: "x1", "x2", "x5", "x10", "x25", "1", "2", "5", "10", "25"
 * Falls back to DEFAULT_SCALE on unknown input.
 *
 * @param {string|undefined} raw
 * @returns {{ key: string, rangePct: number }}
 */
function resolveScale(raw) {
  if (!raw) return { key: DEFAULT_SCALE, rangePct: SCALE_MAP[DEFAULT_SCALE] };

  // Allow both "x5" and "5"
  const normalised = String(raw).trim().toLowerCase();
  const key = normalised.startsWith('x') ? normalised : `x${normalised}`;

  if (SCALE_MAP[key] !== undefined) {
    return { key, rangePct: SCALE_MAP[key] };
  }

  return { key: DEFAULT_SCALE, rangePct: SCALE_MAP[DEFAULT_SCALE] };
}

/**
 * Build the cumulative depth arrays for bids and asks.
 *
 * @param {Array<{price:number,size:number,usdValue:number}>} bids   descending by price
 * @param {Array<{price:number,size:number,usdValue:number}>} asks   ascending  by price
 * @param {number} rangeLow
 * @param {number} rangeHigh
 * @returns {{ bids: Array<{price:number,cumUsd:number}>, asks: Array<{price:number,cumUsd:number}> }}
 */
function buildDepth(bids, asks, rangeLow, rangeHigh) {
  let cumUsd = 0;
  const depthBids = [];
  for (const entry of bids) {
    if (entry.price < rangeLow) break;
    cumUsd += entry.usdValue || 0;
    depthBids.push({ price: entry.price, cumUsd });
  }

  cumUsd = 0;
  const depthAsks = [];
  for (const entry of asks) {
    if (entry.price > rangeHigh) break;
    cumUsd += entry.usdValue || 0;
    depthAsks.push({ price: entry.price, cumUsd });
  }

  return { bids: depthBids, asks: depthAsks };
}

// ─── Main builder ─────────────────────────────────────────────────

/**
 * Build the full density-view payload for a single symbol + scale.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} symbol      e.g. "BTCUSDT"
 * @param {string} scaleRaw    e.g. "x5" | "5"
 * @param {string} [marketType] 'futures' | 'spot' (default: 'futures')
 * @returns {Promise<object|null>}  null when orderbook data is missing
 */
async function buildDensityView(redis, symbol, scaleRaw, marketType = 'futures') {
  const isFutures = marketType === 'futures';
  const obKey    = isFutures ? `futures:orderbook:${symbol}` : `orderbook:${symbol}`;
  const wallsKey = isFutures ? `futures:walls:${symbol}`    : `walls:${symbol}`;

  const [rawOrderbook, rawWalls] = await Promise.all([
    redis.get(obKey),
    redis.get(wallsKey),
  ]);

  if (rawOrderbook === null) return null;

  let ob;
  try {
    ob = JSON.parse(rawOrderbook);
  } catch (_) {
    return null; // corrupt JSON in Redis — treat as missing
  }
  if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks)) return null;

  let walls = [];
  if (rawWalls) {
    try {
      const wallsDoc = JSON.parse(rawWalls);
      walls = Array.isArray(wallsDoc?.walls) ? wallsDoc.walls : [];
    } catch (_) { /* corrupt walls JSON — skip, walls optional */ }
  }

  const { key: scaleKey, rangePct } = resolveScale(scaleRaw);

  const midPrice  = ob.midPrice  ?? null;
  const bestBid   = ob.bestBid   ?? null;
  const bestAsk   = ob.bestAsk   ?? null;
  const updatedAt = ob.updatedAt ?? null;

  // If midPrice is unavailable fall back to average of best bid/ask
  const mid = midPrice ?? (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null);

  if (mid === null) {
    // No price reference — return minimal payload
    return {
      symbol,
      updatedAt,
      bestBid,
      bestAsk,
      midPrice: null,
      scale:    scaleKey,
      rangePct,
      rangeLow:     null,
      rangeHigh:    null,
      ladder:       { bids: [], asks: [] },
      visibleWalls: [],
      depth:        { bids: [], asks: [] },
      stats:        null, // TODO: extend with 24h metrics when available
    };
  }

  const rangeLow  = mid * (1 - rangePct);
  const rangeHigh = mid * (1 + rangePct);

  // ── Ladder ────────────────────────────────────────────────────
  // bids: from bestBid downward, filtered to [rangeLow, mid]
  const ladderBids = (ob.bids || []).filter(e => e.price >= rangeLow && e.price <= mid);
  // asks: from bestAsk upward,  filtered to [mid, rangeHigh]
  const ladderAsks = (ob.asks || []).filter(e => e.price >= mid && e.price <= rangeHigh);

  // ── Visible walls ─────────────────────────────────────────────
  const visibleWalls = walls
    .filter(w => w.price >= rangeLow && w.price <= rangeHigh)
    .map(w => ({
      ...w,
      isNearPrice: Math.abs(w.distancePct || 0) < 0.1, // within 0.1% of mid
    }));

  // ── Depth ─────────────────────────────────────────────────────
  const depth = buildDepth(ob.bids || [], ob.asks || [], rangeLow, rangeHigh);

  return {
    symbol,
    updatedAt,
    bestBid,
    bestAsk,
    midPrice: mid,
    scale:    scaleKey,
    rangePct,
    rangeLow,
    rangeHigh,
    ladder:       { bids: ladderBids, asks: ladderAsks },
    visibleWalls,
    depth,
    stats: null, // TODO: populate from metrics:${symbol} when needed
  };
}

module.exports = { buildDensityView };
