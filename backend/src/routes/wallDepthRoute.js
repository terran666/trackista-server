'use strict';
/**
 * wallDepthRoute.js — Depth-to-wall visualization endpoint.
 *
 * GET  /api/density/wall-depth?symbol=ETHUSDT
 * GET  /api/density/wall-depth-debug?symbol=ETHUSDT
 *
 * Returns orderbook levels from mid-price to the nearest significant BID/ASK
 * wall, with precomputed visual scoring fields ready for frontend rendering.
 *
 * Data is also cached in density:wallDepth:{symbol} (5s TTL) for WS delivery
 * via the density flush loop in liveWsGateway.js.
 */

// ─── Config ────────────────────────────────────────────────────────────────────

const WALL_DEPTH_MIN_WALL_POWER        = parseFloat(process.env.WALL_DEPTH_MIN_WALL_POWER        || '0.65');
const WALL_DEPTH_MAX_DISTANCE_PCT      = parseFloat(process.env.WALL_DEPTH_MAX_DISTANCE_PCT      || '5');
const WALL_DEPTH_EXTREME_MAX_DIST_PCT  = parseFloat(process.env.WALL_DEPTH_EXTREME_MAX_DIST_PCT  || '10');
const WALL_DEPTH_MAX_LEVELS_PER_SIDE   = parseInt  (process.env.WALL_DEPTH_MAX_LEVELS_PER_SIDE   || '40', 10);
const WALL_DEPTH_BUCKET_BPS            = parseFloat(process.env.WALL_DEPTH_BUCKET_BPS            || '2');
const WALL_DEPTH_CACHE_TTL_S           = parseInt  (process.env.WALL_DEPTH_CACHE_TTL_S           || '5', 10);

// Per-symbol minimum level USD (filters out orderbook noise)
const MIN_LEVEL_USD = {
  BTCUSDT : 500_000,
  ETHUSDT : 250_000,
  _default:  50_000,
};
function _minLevelUsd(symbol) {
  return MIN_LEVEL_USD[symbol] ?? MIN_LEVEL_USD._default;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compute all four visual scoring fields for a level.
 * wallPower = null  → ordinary level (not a wall).
 */
function _visualScores(sizeUsd, wallUsd, wallPower = null) {
  const relativeToWall    = wallUsd > 0 ? sizeUsd / wallUsd : 0;
  const visualLengthScore = _clamp(Math.sqrt(relativeToWall), 0.05, 1.0);

  let visualWidthScore, visualOpacityScore;
  if (wallPower !== null) {
    // Wall level — scale with wallPower
    visualWidthScore   = _clamp(0.4  + wallPower * 0.6,  0.4,  1.0);
    visualOpacityScore = _clamp(0.55 + wallPower * 0.45, 0.55, 1.0);
  } else {
    // Ordinary level
    visualWidthScore   = _clamp(0.15 + visualLengthScore * 0.35, 0.15, 0.5);
    visualOpacityScore = _clamp(0.12 + visualLengthScore * 0.28, 0.12, 0.4);
  }

  return {
    relativeToWall    : parseFloat(relativeToWall.toFixed(4)),
    visualLengthScore : parseFloat(visualLengthScore.toFixed(4)),
    visualWidthScore  : parseFloat(visualWidthScore.toFixed(4)),
    visualOpacityScore: parseFloat(visualOpacityScore.toFixed(4)),
  };
}

// ─── Target wall selection ────────────────────────────────────────────────────

/**
 * Pick the nearest significant wall on the given side.
 * Returns { wall: object|null, rejects: [{wallId, reason, ...}] }
 */
function _selectTargetWall(walls, side, midPrice) {
  const rejects = [];
  let best      = null;
  let bestDist  = Infinity;

  for (const w of walls) {
    if (w.side !== side) continue;

    // wallPower gate
    if ((w.wallPower ?? 0) < WALL_DEPTH_MIN_WALL_POWER) {
      rejects.push({ wallId: w.wallId, price: w.price, wallPower: w.wallPower, reason: 'below_min_wall_power' });
      continue;
    }

    // Category gate — only STRONG_WALL / EXTREME_WALL
    const cat = w.wallCategory ?? '';
    if (cat !== 'STRONG_WALL' && cat !== 'EXTREME_WALL') {
      rejects.push({ wallId: w.wallId, price: w.price, wallCategory: cat, reason: 'category_not_strong_or_extreme' });
      continue;
    }

    // Side position gate
    if (side === 'bid' && w.price >= midPrice) {
      rejects.push({ wallId: w.wallId, price: w.price, reason: 'bid_not_below_mid' });
      continue;
    }
    if (side === 'ask' && w.price <= midPrice) {
      rejects.push({ wallId: w.wallId, price: w.price, reason: 'ask_not_above_mid' });
      continue;
    }

    // Distance gate — EXTREME walls get wider window
    const maxDist = cat === 'EXTREME_WALL' ? WALL_DEPTH_EXTREME_MAX_DIST_PCT : WALL_DEPTH_MAX_DISTANCE_PCT;
    const dist    = Math.abs((w.price - midPrice) / midPrice) * 100;
    if (dist > maxDist) {
      rejects.push({ wallId: w.wallId, price: w.price, distancePct: parseFloat(dist.toFixed(3)), maxDist, reason: 'too_far' });
      continue;
    }

    if (dist < bestDist) {
      bestDist = dist;
      best     = w;
    }
  }

  return { wall: best, rejects };
}

// ─── Level collection, bucketing, limiting ────────────────────────────────────

/**
 * From raw orderbook levels `[[priceStr, sizeStr], ...]`, collect all levels
 * between midPrice and targetWall.price, bucket nearby prices together,
 * apply the level count limit, and return annotated level objects.
 */
function _buildLevelsToWall(obLevels, side, midPrice, targetWall, symbol) {
  const wallPrice  = targetWall.price;
  const wallUsd    = targetWall.usdValue ?? targetWall.sizeUsd;
  const minUsd     = _minLevelUsd(symbol);
  // 2 bps expressed as a price fraction
  const bucketFrac = WALL_DEPTH_BUCKET_BPS / 10_000;
  const bucketSize = midPrice * bucketFrac;

  // ── Step 1: parse + range filter ────────────────────────────────
  const raw = [];
  for (const entry of obLevels) {
    const price   = parseFloat(entry[0]);
    const qty     = parseFloat(entry[1]);
    const sizeUsd = price * qty;

    if (side === 'bid') {
      if (price > midPrice)  continue;
      if (price < wallPrice) continue;
    } else {
      if (price < midPrice)  continue;
      if (price > wallPrice) continue;
    }

    // Drop tiny levels — always keep targetWall price bucket
    const isWallLevel = Math.abs(price - wallPrice) <= bucketSize * 0.5;
    if (sizeUsd < minUsd && !isWallLevel) continue;

    raw.push({ price, qty, sizeUsd });
  }

  // ── Step 2: bucket by BPS ────────────────────────────────────────
  const buckets    = new Map(); // bucketKey → aggregated data
  const wallBucket = Math.floor(wallPrice / bucketSize);

  for (const lvl of raw) {
    const key = Math.floor(lvl.price / bucketSize);
    if (!buckets.has(key)) {
      buckets.set(key, { priceWeightedSum: 0, sizeUsdSum: 0, qtySum: 0, count: 0 });
    }
    const b = buckets.get(key);
    b.priceWeightedSum += lvl.price * lvl.sizeUsd;
    b.sizeUsdSum       += lvl.sizeUsd;
    b.qtySum           += lvl.qty;
    b.count++;
  }

  const aggregated = [];
  for (const [key, b] of buckets) {
    aggregated.push({
      bucketKey : key,
      price     : b.sizeUsdSum > 0 ? b.priceWeightedSum / b.sizeUsdSum : wallPrice,
      sizeUsd   : b.sizeUsdSum,
      qty       : b.qtySum,
      count     : b.count,
    });
  }

  // ── Step 3: apply level limit ────────────────────────────────────
  const MAX         = WALL_DEPTH_MAX_LEVELS_PER_SIDE;
  const wallEntries = aggregated.filter(l => l.bucketKey === wallBucket);
  const nonWall     = aggregated.filter(l => l.bucketKey !== wallBucket);

  let kept = nonWall;
  if (kept.length > MAX - wallEntries.length) {
    const TOP_BY_SIZE  = 30;
    const TOP_BY_DIST  = MAX - wallEntries.length - TOP_BY_SIZE;
    const sortedBySize = [...nonWall].sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, TOP_BY_SIZE);
    const sizeKeys     = new Set(sortedBySize.map(l => l.bucketKey));
    const closestToMid = [...nonWall]
      .sort((a, b) => Math.abs(a.price - midPrice) - Math.abs(b.price - midPrice))
      .slice(0, Math.max(0, TOP_BY_DIST))
      .filter(l => !sizeKeys.has(l.bucketKey));
    kept = [...sortedBySize, ...closestToMid];
  }

  // Always include wall bucket(s)
  kept.push(...wallEntries);

  // ── Step 4: sort by price ────────────────────────────────────────
  if (side === 'bid') {
    kept.sort((a, b) => b.price - a.price); // nearest to mid first
  } else {
    kept.sort((a, b) => a.price - b.price); // nearest to mid first
  }

  // ── Step 5: annotate with visual fields ─────────────────────────
  return kept.map(lvl => {
    const isWall = lvl.bucketKey === wallBucket;
    const wp     = isWall ? (targetWall.wallPower ?? null) : null;
    const scores = _visualScores(lvl.sizeUsd, wallUsd, wp);

    const out = {
      side,
      price  : parseFloat(lvl.price.toFixed(8)),
      sizeUsd: Math.round(lvl.sizeUsd),
      qty    : parseFloat(lvl.qty.toFixed(6)),
      isWall,
      ...scores,
    };
    if (lvl.count > 1) out.levelCount = lvl.count;
    if (isWall) {
      out.wallPower = targetWall.wallPower;
      out.category  = targetWall.wallCategory;
    }
    return out;
  });
}

// ─── Wall formatter ───────────────────────────────────────────────────────────

function _formatWall(w) {
  const cat       = w.wallCategory ?? w.category ?? '';\n  const isMajor   = cat === 'STRONG_WALL' || cat === 'EXTREME_WALL'
                 || (w.wallPower != null && w.wallPower >= 0.65);
  const now       = Date.now();
  const createdAt = w.firstSeenAt  ?? w.firstSeenTs  ?? null;
  const updatedAt = w.lastSeenAt   ?? w.lastSeenTs   ?? w.lastUpdatedAt ?? now;
  const ageSec    = createdAt !== null
    ? parseFloat(((now - createdAt) / 1000).toFixed(1))
    : null;

  return {
    wallId     : w.wallId,
    side       : w.side,
    price      : w.price,
    sizeUsd    : w.usdValue ?? w.sizeUsd,
    qty        : w.qty ?? w.size,
    isMajor,
    createdAt,
    updatedAt,
    ageSec,
    distancePct: w.distancePct,
    strength   : w.strength   ?? null,
    wallPower  : w.wallPower,
    category   : w.wallCategory,
    p95Ratio   : w.p95Ratio,
    localRatio : w.localRatio,
    lifetimeMs : w.lifetimeMs,
  };
}

// ─── Core builder ─────────────────────────────────────────────────────────────

/**
 * Build the wall-depth payload for a symbol.
 * @param {import('ioredis').Redis} redis
 * @param {string}  symbol
 * @param {boolean} [debug=false]  include debug fields
 * @returns {object|null}
 */
async function _buildWallDepth(redis, symbol, debug = false) {
  const now = Date.now();

  // ── Read walls ──────────────────────────────────────────────────
  const wallsRaw = await redis.get(`futures:walls:${symbol}`);
  if (!wallsRaw) return null;
  const wallsData = JSON.parse(wallsRaw);
  const walls     = Array.isArray(wallsData) ? wallsData : (wallsData.walls || []);
  const midPrice  = wallsData.midPrice ?? 0;
  if (!midPrice || walls.length === 0) return null;

  // ── Read orderbook ──────────────────────────────────────────────
  const obRaw = await redis.get(`futures:orderbook:${symbol}`);
  if (!obRaw) return null;
  const ob = JSON.parse(obRaw);

  // ── Select target walls ─────────────────────────────────────────
  const bidResult = _selectTargetWall(walls, 'bid', midPrice);
  const askResult = _selectTargetWall(walls, 'ask', midPrice);

  // ── Build levels per side ───────────────────────────────────────
  const bidLevels = bidResult.wall
    ? _buildLevelsToWall(ob.bids || [], 'bid', midPrice, bidResult.wall, symbol)
    : [];
  const askLevels = askResult.wall
    ? _buildLevelsToWall(ob.asks || [], 'ask', midPrice, askResult.wall, symbol)
    : [];

  const payload = {
    symbol,
    midPrice,
    updatedAt : now,
    bid : {
      targetWall  : bidResult.wall ? _formatWall(bidResult.wall) : null,
      levelsToWall: bidLevels,
    },
    ask : {
      targetWall  : askResult.wall ? _formatWall(askResult.wall) : null,
      levelsToWall: askLevels,
    },
  };

  if (debug) {
    // Count raw ob levels in range for debug
    const rawBidCount = (ob.bids || []).filter(([p]) => {
      const price = parseFloat(p);
      return price <= midPrice && (!bidResult.wall || price >= bidResult.wall.price);
    }).length;
    const rawAskCount = (ob.asks || []).filter(([p]) => {
      const price = parseFloat(p);
      return price >= midPrice && (!askResult.wall || price <= askResult.wall.price);
    }).length;

    payload.bid._debug = {
      targetWallFound    : !!bidResult.wall,
      targetWallRejects  : bidResult.rejects,
      levelsRawCount     : rawBidCount,
      levelsFilteredCount: bidLevels.length,
    };
    payload.ask._debug = {
      targetWallFound    : !!askResult.wall,
      targetWallRejects  : askResult.rejects,
      levelsRawCount     : rawAskCount,
      levelsFilteredCount: askLevels.length,
    };
    payload._config = {
      WALL_DEPTH_MIN_WALL_POWER,
      WALL_DEPTH_MAX_DISTANCE_PCT,
      WALL_DEPTH_EXTREME_MAX_DIST_PCT,
      WALL_DEPTH_MAX_LEVELS_PER_SIDE,
      WALL_DEPTH_BUCKET_BPS,
      minLevelUsd: _minLevelUsd(symbol),
    };
  }

  return payload;
}

// ─── Cache refresh (called from liveWsGateway flush loop) ────────────────────

/**
 * Build wallDepth for a symbol and write to Redis cache.
 * Returns the payload or null if data is unavailable.
 * @param {import('ioredis').Redis} redis
 * @param {string}  symbol
 */
async function buildAndCacheWallDepth(redis, symbol) {
  try {
    const data = await _buildWallDepth(redis, symbol, false);
    if (!data) return null;
    await redis.set(`density:wallDepth:${symbol}`, JSON.stringify(data), 'EX', WALL_DEPTH_CACHE_TTL_S);
    return data;
  } catch (err) {
    console.error(`[wallDepthRoute] buildAndCache ${symbol}:`, err.message);
    return null;
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * @param {import('ioredis').Redis} redis
 * @returns {{ main: Function, debug: Function }}
 */
function createWallDepthHandlers(redis) {
  const main = async (req, res) => {
    try {
      const symbol = (req.query.symbol || '').trim().toUpperCase();
      if (!symbol) return res.status(400).json({ success: false, error: 'symbol is required' });

      // Try Redis cache first
      const cached = await redis.get(`density:wallDepth:${symbol}`);
      if (cached) return res.json(JSON.parse(cached));

      // Build fresh and cache
      const data = await _buildWallDepth(redis, symbol, false);
      if (!data) {
        return res.status(404).json({
          success: false,
          error  : `No wall or orderbook data for ${symbol}`,
          symbol,
        });
      }

      await redis.set(`density:wallDepth:${symbol}`, JSON.stringify(data), 'EX', WALL_DEPTH_CACHE_TTL_S);
      return res.json(data);
    } catch (err) {
      console.error('[wallDepthRoute] main error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };

  const debug = async (req, res) => {
    try {
      const symbol = (req.query.symbol || '').trim().toUpperCase();
      if (!symbol) return res.status(400).json({ success: false, error: 'symbol is required' });

      // Debug always builds fresh (no cache) so rejects are visible
      const data = await _buildWallDepth(redis, symbol, true);
      if (!data) {
        return res.status(404).json({
          success: false,
          error  : `No wall or orderbook data for ${symbol}`,
          symbol,
        });
      }
      return res.json(data);
    } catch (err) {
      console.error('[wallDepthRoute] debug error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };

  return { main, debug };
}

module.exports = { createWallDepthHandlers, buildAndCacheWallDepth };
