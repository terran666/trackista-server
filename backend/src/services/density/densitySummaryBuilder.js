'use strict';

// ─── Constants ────────────────────────────────────────────────────
// Scale used for visible-range bias computation in summary view (±0.5%)
const BIAS_RANGE_PCT = 0.005;

const MAX_LIMIT = 500;

// ─── Liquidity score reference baselines ─────────────────────────
const LSCORE_VOL_REF    = 5_000_000;
const LSCORE_COUNT_REF  = 5_000;
const LSCORE_SPREAD_REF = 0.001;
const LSCORE_ACT_REF    = 500_000;

// ─── Badge thresholds ─────────────────────────────────────────────
// Keep in sync with densityFuturesConfig.js; duplicated here to avoid
// cross-service import (backend vs collector package).
const BADGE_HIGH_WALL_POWER  = parseFloat(process.env.BADGE_HIGH_WALL_POWER  || '0.80');
const BADGE_NEAR_DIST_PCT    = parseFloat(process.env.BADGE_NEAR_DIST_PCT    || '0.5');
const BADGE_WHALE_MULTIPLIER = parseFloat(process.env.BADGE_WHALE_MULTIPLIER || '8');
const BADGE_NEW_LIFETIME_MS  = parseInt(process.env.BADGE_NEW_LIFETIME_MS    || '90000', 10);

// ─── Smart density score weights (must sum to 100) ────────────────
const SMART_SCORE_WALL_POWER_W  = parseFloat(process.env.SMART_SCORE_WALL_POWER_W  || '40');
const SMART_SCORE_NEAR_WALL_W   = parseFloat(process.env.SMART_SCORE_NEAR_WALL_W   || '25');
const SMART_SCORE_VOL_SPIKE_W   = parseFloat(process.env.SMART_SCORE_VOL_SPIKE_W   || '20');
const SMART_SCORE_TRADE_SPIKE_W = parseFloat(process.env.SMART_SCORE_TRADE_SPIKE_W || '10');
const SMART_SCORE_AGE_W         = parseFloat(process.env.SMART_SCORE_AGE_W         || '5');

// Max spike ratio normalised to 1 (10× spike = full points)
const SPIKE_NORM_MAX = 10;
// Max nearest-wall distance used for proximity score (3% → score=0)
const NEAR_DIST_MAX_PCT = 3;
// Max wall age for age score (5 min = full points)
const WALL_AGE_MAX_MS = 5 * 60 * 1000;

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

// ─── Badge computation ────────────────────────────────────────────

/**
 * Compute badge labels for a symbol.
 *
 * Badges: HOT, HIGH, WHALE, NEAR, NEW
 *
 *   HOT   — symbol is in the hot-candidates registry (spike event in last 15 min)
 *   HIGH  — bestWallPower >= BADGE_HIGH_WALL_POWER  (exceptionally strong relative strength)
 *   WHALE — any wall has sizeUsd >= normalWallUsd * BADGE_WHALE_MULTIPLIER
 *   NEAR  — nearest wall distance <= BADGE_NEAR_DIST_PCT % from mid
 *   NEW   — any wall has lifetime < BADGE_NEW_LIFETIME_MS (freshly appeared)
 *
 * @param {object} opts
 * @returns {string[]}
 */
function _computeBadges({ isHot, walls, relativeWallStrength, nearestWallDistancePct, nearestWallLifetimeMs, normalWallUsd }) {
  const badges = [];

  if (isHot) badges.push('HOT');

  if (relativeWallStrength >= BADGE_HIGH_WALL_POWER) badges.push('HIGH');

  if (nearestWallDistancePct !== null && nearestWallDistancePct <= BADGE_NEAR_DIST_PCT) {
    badges.push('NEAR');
  }

  const now = Date.now();

  if (Array.isArray(walls)) {
    // WHALE: absolute wall size anomaly
    if (normalWallUsd > 0) {
      const whaleThreshold = normalWallUsd * BADGE_WHALE_MULTIPLIER;
      for (const w of walls) {
        const sz = w.sizeUsd ?? w.usdValue ?? 0;
        if (sz >= whaleThreshold) { badges.push('WHALE'); break; }
      }
    }

    // NEW: freshly appeared wall
    for (const w of walls) {
      const firstSeen = w.firstSeenAt ?? w.createdAt ?? null;
      if (firstSeen !== null && (now - firstSeen) < BADGE_NEW_LIFETIME_MS) {
        badges.push('NEW');
        break;
      }
    }
  }

  return badges;
}

// ─── Smart density score ──────────────────────────────────────────

/**
 * Compute a 0–100 smart density score for left-panel sort order.
 *
 * smartDensityScore =
 *   SMART_SCORE_WALL_POWER_W  × relativeWallStrength        (0-1 → 0-40 pts)
 *   SMART_SCORE_NEAR_WALL_W   × nearestWallProximityScore   (0-1 → 0-25 pts)
 *   SMART_SCORE_VOL_SPIKE_W   × volumeSpikeScore            (0-1 → 0-20 pts)
 *   SMART_SCORE_TRADE_SPIKE_W × tradeSpikeScore             (0-1 → 0-10 pts)
 *   SMART_SCORE_AGE_W         × wallAgeScore                (0-1 → 0-5 pts)
 *
 * @param {object} opts
 * @returns {number}  rounded integer 0-100
 */
function _computeSmartDensityScore({ relativeWallStrength, nearestWallDistancePct, nearestWallLifetimeMs, volumeSpike, tradeSpike }) {
  // Component 1: relative wall strength (already 0-1)
  const wallPowerScore = Math.min(Math.max(relativeWallStrength, 0), 1);

  // Component 2: nearest wall proximity (closer = higher score)
  // 0% distance → 1.0; NEAR_DIST_MAX_PCT% or more → 0.0
  const nearScore = nearestWallDistancePct !== null
    ? Math.max(1 - nearestWallDistancePct / NEAR_DIST_MAX_PCT, 0)
    : 0;

  // Component 3: volume spike (capped at SPIKE_NORM_MAX×)
  const volScore = volumeSpike !== null
    ? Math.min(volumeSpike / SPIKE_NORM_MAX, 1)
    : 0;

  // Component 4: trade spike
  const tradeScore = tradeSpike !== null
    ? Math.min(tradeSpike / SPIKE_NORM_MAX, 1)
    : 0;

  // Component 5: wall age (older confirmed wall = higher confidence)
  const ageScore = nearestWallLifetimeMs !== null
    ? Math.min(nearestWallLifetimeMs / WALL_AGE_MAX_MS, 1)
    : 0;

  return Math.round(
    SMART_SCORE_WALL_POWER_W  * wallPowerScore +
    SMART_SCORE_NEAR_WALL_W   * nearScore      +
    SMART_SCORE_VOL_SPIKE_W   * volScore       +
    SMART_SCORE_TRADE_SPIKE_W * tradeScore     +
    SMART_SCORE_AGE_W         * ageScore,
  );
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
 * @param {object|null} score    parsed density:score:{symbol}
 * @param {boolean}     isHot    whether symbol is in hot-candidates map
 * @returns {object}
 */
function buildItem(symbol, ob, wallsDoc, metrics, signal, score, isHot) {
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

  // ── Relative wall strength (bestWallPower = 0-1 from v3 algorithm) ─
  const relativeWallStrength = wallsDoc?.bestWallPower ?? score?.bestWallPower ?? 0;

  // ── Tier from universe score ─────────────────────────────────────
  const tier = score?.tier ?? 3;

  // ── Badges ───────────────────────────────────────────────────────
  const badges = _computeBadges({
    isHot,
    walls,
    relativeWallStrength,
    nearestWallDistancePct,
    nearestWallLifetimeMs,
    normalWallUsd: score?.normalWallUsd ?? 0,
  });

  // ── Smart density score ──────────────────────────────────────────
  const smartDensityScore = _computeSmartDensityScore({
    relativeWallStrength,
    nearestWallDistancePct,
    nearestWallLifetimeMs,
    volumeSpike:  score?.volumeSpike    ?? null,
    tradeSpike:   score?.tradeCountSpike ?? null,
  });

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
    relativeWallStrength,
    tier,
    badges,
    smartDensityScore,
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

  // ── Fetch hot candidates once (single key lookup) ──────────────
  const hotRaw  = await redis.get('density:hot-candidates');
  const hotMap  = safeParse(hotRaw) ?? {};  // { symbol: hotSince }

  // ── One pipeline for all symbols, 5 keys each ──────────────────
  // [0] futures:orderbook or orderbook
  // [1] futures:walls or walls
  // [2] metrics
  // [3] signal
  // [4] density:score:{symbol}
  const pipeline = redis.pipeline();
  for (const sym of symbols) {
    pipeline.get(mt === 'futures' ? `futures:orderbook:${sym}` : `orderbook:${sym}`);
    pipeline.get(mt === 'futures' ? `futures:walls:${sym}`     : `walls:${sym}`);
    pipeline.get(`metrics:${sym}`);
    pipeline.get(`signal:${sym}`);
    pipeline.get(`density:score:${sym}`);
  }
  const results = await pipeline.exec();

  const items = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const base   = i * 5;
    try {
      const row = results[base];
      if (!row) continue;

      const ob       = safeParse(results[base][1]);
      const wallsDoc = safeParse(results[base + 1][1]);
      const metrics  = safeParse(results[base + 2][1]);
      const signal   = safeParse(results[base + 3][1]);
      const score    = safeParse(results[base + 4][1]);
      const isHot    = Object.prototype.hasOwnProperty.call(hotMap, symbol);

      const item = buildItem(symbol, ob, wallsDoc, metrics, signal, score, isHot);
      item.marketType = mt;
      items.push(item);
    } catch (err) {
      console.warn(`[density-summary] skipping ${symbol} — processing error: ${err.message}`);
    }
  }

  // Sort by smartDensityScore DESC, then tier ASC as tiebreaker, nulls last
  items.sort((a, b) => {
    // Tier 1 always first regardless of score
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.smartDensityScore - a.smartDensityScore;
  });

  return { symbols, items, marketType: mt };
}

module.exports = { buildDensitySummary };
