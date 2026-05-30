'use strict';

// ─── Futures Wall Detector v2 — Lifecycle State Machine ──────────────────────
//
// Implements the candidate → confirmed → dropped lifecycle for futures walls.
//
// A wall becomes "confirmed" only after it has been continuously (or near-
// continuously) present in the orderbook for at least FUTURES_MIN_WALL_LIFETIME_MS
// (default 60 seconds).
//
// Public API:
//   setTickSize(symbol, tickSize)
//   scanAndUpdate(symbol, bids, asks, midPrice, now?)
//   getConfirmedWalls(symbol)
//   getCandidates(symbol)
//   getDroppedRecent(symbol)
//   buildPublicWallsPayload(symbol, midPrice, now?, metadata?)
//   buildInternalWallsPayload(symbol, midPrice, now?)
//   clearSymbol(symbol)
//   getFuturesWallThreshold(symbol)

const {
  FUTURES_WALL_THRESHOLDS,
  FUTURES_MAX_WALL_DISTANCE_PCT,
  FUTURES_DIST_SCALE_PER_MULTIPLIER,
  FUTURES_DEEP_WALL_MAX_DISTANCE_PCT,
  FUTURES_DEEP_WALL_MULTIPLIER_FLAG,
  FUTURES_MIN_WALL_LIFETIME_MS,
  FUTURES_WALL_PERSISTENT_MS,
  FUTURES_WALL_MIN_QUALITY_SCORE,
  FUTURES_WALL_ABSENCE_GRACE_MS,
  FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS,
  FUTURES_WALL_SCAN_MS,
  // v3 adaptive wall algorithm
  WALL_SCAN_DISTANCE_PCT,
  WALL_P95_MULTIPLIER,
  WALL_LOCAL_WINDOW_LEVELS,
  WALL_LOCAL_MULTIPLIER,
  WALL_MEDIAN_MULTIPLIER,
  WALL_DEPTH_RATIO,
  WALL_SIMILAR_LEVELS_LIMIT,
  WALL_POWER_SOFT_MIN,
  WALL_POWER_STRONG_MIN,
  WALL_POWER_EXTREME_MIN,
} = require('./densityFuturesConfig');

// ─── Threshold lookup ──────────────────────────────────────────────

/**
 * Return the fixed USD wall threshold for a given futures symbol.
 *
 * @param {string} symbol  e.g. 'BTCUSDT'
 * @returns {number}
 */
function getFuturesWallThreshold(symbol) {
  return FUTURES_WALL_THRESHOLDS[symbol] ?? FUTURES_WALL_THRESHOLDS._default;
}

// ─── TickSize cache ────────────────────────────────────────────────
// Map<symbol, tickSize:number>
const tickSizeCache = new Map();

/**
 * Store the tick size for a symbol so normalizePrice can produce canonical keys.
 */
function setTickSize(symbol, tickSize) {
  if (typeof tickSize === 'number' && isFinite(tickSize) && tickSize > 0) {
    tickSizeCache.set(symbol, tickSize);
  }
}

/**
 * Round a price to the symbol's tick size and return a canonical string key.
 * Falls back to 8-decimal string if tick size is unknown.
 *
 * @param {number} price
 * @param {string} symbol
 * @returns {string}
 */
function normalizePrice(price, symbol) {
  const tickSize = tickSizeCache.get(symbol);
  if (!tickSize || tickSize <= 0) {
    return price.toFixed(8);
  }
  // Number of decimal places implied by tickSize (e.g. 0.01 → 2, 1.0 → 0)
  const precision = Math.max(0, Math.round(-Math.log10(tickSize)));
  const normalized = Math.round(price / tickSize) * tickSize;
  return normalized.toFixed(precision);
}

// ─── State maps ────────────────────────────────────────────────────
// Map<symbol, Map<wallKey, candidate>>
const candidateMap   = new Map();
// Map<symbol, Array<droppedCandidate>>  — rolling history per symbol
const droppedHistory = new Map();
// Map<symbol, Map<wallKey, { accMs, maxUsdValue, droppedAt }>>  — presence memory
// When a candidate drops it saves its accumulated presence here so if the same
// wall reappears within PRESENCE_MEMORY_TTL_MS it can resume instead of starting over.
const presenceMemoryMap = new Map();
const PRESENCE_MEMORY_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Map<symbol, { bid, ask, bidAdaptiveThresh, askAdaptiveThresh, avgDepthNear1PctUsd, midPrice, updatedAt }>
// Written every scanAndUpdate() tick; read by buildWallStatsPayload / buildBestWallPayload.
const wallStatsMap = new Map();

const MAX_DROPPED_HISTORY = 20;

// ─── Wall event queue ─────────────────────────────────────────────
// Map<symbol, Array<wallEvent>>
// Events are accumulated between flush ticks and drained by the collector
// via getAndClearPendingEvents().
const pendingEventsMap = new Map();
const MAX_PENDING_EVENTS = 200; // per symbol — hard cap to avoid unbounded growth

/**
 * Emit a wall lifecycle event for a symbol.
 * @param {string} symbol
 * @param {string} status  new|confirmed|persistent|dropped|increased|decreased|suspicious_spoof
 * @param {object} cand    candidate/dropped object
 * @param {number} [now]
 */
function _emitWallEvent(symbol, status, cand, now = Date.now()) {
  let arr = pendingEventsMap.get(symbol);
  if (!arr) { arr = []; pendingEventsMap.set(symbol, arr); }
  if (arr.length >= MAX_PENDING_EVENTS) return; // safety cap
  const threshold = getFuturesWallThreshold(symbol);
  arr.push({
    id:          `${symbol}:${cand.side}:${cand.price}:${now}`,
    ts:          now,
    marketType:  'futures',
    symbol,
    side:        cand.side,
    price:       cand.price,
    sizeUsdt:    cand.currentUsdValue ?? cand.usdValue ?? 0,
    type:        'limit',
    status,
    strength:    parseFloat(((cand.currentUsdValue ?? cand.usdValue ?? 0) / Math.max(threshold, 1)).toFixed(2)),
    distancePct: parseFloat((cand.distancePct ?? 0).toFixed(4)),
    lifetimeMs:  cand.firstSeenTs ? now - cand.firstSeenTs : 0,
  });
}

/**
 * Return and clear all pending wall events for a symbol.
 * Called by the collector's flush timer to write events to Redis.
 * @param {string} symbol
 * @returns {Array}
 */
function getAndClearPendingEvents(symbol) {
  const arr = pendingEventsMap.get(symbol);
  if (!arr || arr.length === 0) return [];
  pendingEventsMap.set(symbol, []);
  return arr;
}

// ─── Candidate constructor ─────────────────────────────────────────

function makeCandidate(symbol, side, price, normPrice, usdValue, size, distancePct, deepWall, now) {
  return {
    symbol,
    side,
    price,
    normPrice,
    firstSeenTs:           now,
    lastSeenTs:            now,
    _prevScanTs:           now,   // tracks previous scan time for interval accumulation
    maxUsdValue:           usdValue,
    currentUsdValue:       usdValue,
    currentSize:           size,
    accumulatedPresenceMs: 0,     // total ms the wall was visible AND above threshold
    hitCount:              1,
    missingSinceTs:        null,  // timestamp when absence started (null = present)
    distancePct,
    deepWall,                     // true when usdValue >= threshold × FUTURES_DEEP_WALL_MULTIPLIER
    status:                'candidate',
    // v2 scores (kept for backward compat)
    qualityScore:          0,
    bounceScore:           0,
    breakoutScore:         0,
    spoofScore:            0,
    // v3 adaptive wall analytics (updated each tick from current orderbook stats)
    wallPower:             0,
    wallCategory:          null,
    lastP95Usd:            0,
    lastLocalMedianUsd:    0,
    lastSimilarLevelsCount: 0,
    lastAdaptiveThreshold: 0,
    // Behaviour tracking
    refillCount:           0,
    touchCount:            0,
    absorptionUsd:         0,
    isSuspiciousSpoof:     false,
    sourceUniverse:        'futures',
  };
}

// ─── Drop helper ───────────────────────────────────────────────────

function dropCandidate(symbol, wallKey, candidate, reason, now) {
  const hist = droppedHistory.get(symbol) || [];
  hist.unshift({
    symbol:         candidate.symbol,
    side:           candidate.side,
    price:          candidate.price,
    usdValue:       candidate.currentUsdValue,
    firstSeenTs:    candidate.firstSeenTs,
    droppedAt:      now,
    droppedReason:  reason,
    accPresenceMs:  candidate.accumulatedPresenceMs,
    lifetimeMs:     now - candidate.firstSeenTs,
    status:         'dropped',
  });
  if (hist.length > MAX_DROPPED_HISTORY) hist.length = MAX_DROPPED_HISTORY;
  droppedHistory.set(symbol, hist);

  // Save presence memory so a reappearing wall inherits its progress
  if (candidate.accumulatedPresenceMs > 0) {
    let pmSym = presenceMemoryMap.get(symbol);
    if (!pmSym) { pmSym = new Map(); presenceMemoryMap.set(symbol, pmSym); }
    pmSym.set(wallKey, { accMs: candidate.accumulatedPresenceMs, maxUsdValue: candidate.maxUsdValue, droppedAt: now });
  }

  _emitWallEvent(symbol, 'dropped', { ...candidate, lifetimeMs: now - candidate.firstSeenTs }, now);

  const map = candidateMap.get(symbol);
  if (map) map.delete(wallKey);

  console.log(
    `[futures-walls] ${symbol}: dropped (${reason}) — ${candidate.side} @ ${candidate.price}` +
    ` accPresence=${Math.round(candidate.accumulatedPresenceMs / 1000)}s`,
  );
}

// ─── v3 Statistical helpers ────────────────────────────────────────────────

/**
 * Return the p-th percentile (0–1) from a pre-sorted ascending array.
 * e.g. p=0.95 → 95th percentile.
 */
function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}

/**
 * Compute order-size statistics for one orderbook side.
 * @param {{ usdValue: number }[]} levels  All levels for this side (any order).
 * @returns {{ p50, p75, p90, p95, avg, max, levelCount }}
 */
function _computeSideStats(levels) {
  if (!levels.length) return { p50: 0, p75: 0, p90: 0, p95: 0, avg: 0, max: 0, levelCount: 0 };
  const sorted = levels.map(l => l.usdValue).sort((a, b) => a - b);
  const sum    = sorted.reduce((s, v) => s + v, 0);
  return {
    p50:        _percentile(sorted, 0.50),
    p75:        _percentile(sorted, 0.75),
    p90:        _percentile(sorted, 0.90),
    p95:        _percentile(sorted, 0.95),
    avg:        sum / sorted.length,
    max:        sorted[sorted.length - 1],
    levelCount: sorted.length,
  };
}

/**
 * Compute the adaptive wall threshold for one orderbook side.
 *
 *   adaptiveThreshold = max(
 *     staticMinWallUsd,
 *     p95OrderUsd   × WALL_P95_MULTIPLIER,
 *     medianOrderUsd × WALL_MEDIAN_MULTIPLIER,
 *     avgDepthNear1Pct × WALL_DEPTH_RATIO,
 *   )
 *
 * @param {number} staticMin         Per-symbol static floor (getFuturesWallThreshold)
 * @param {{ p50, p95 }} sideStats
 * @param {number} avgDepthNear1Pct  (bid_depth_within_1pct + ask_depth_within_1pct) / 2
 * @returns {number}
 */
function _computeAdaptiveThreshold(staticMin, sideStats, avgDepthNear1Pct) {
  return Math.max(
    staticMin,
    sideStats.p95  * WALL_P95_MULTIPLIER,
    sideStats.p50  * WALL_MEDIAN_MULTIPLIER,
    avgDepthNear1Pct * WALL_DEPTH_RATIO,
  );
}

/**
 * Compute the median usdValue of the ±window neighbors of a level at `idx`
 * in the price-sorted `sideArray`.  The candidate itself is excluded.
 *
 * @param {{ usdValue: number }[]} sideArray  Sorted by price (any direction).
 * @param {number} idx
 * @param {number} window  Number of levels each side to include.
 * @returns {number}
 */
function _computeLocalMedian(sideArray, idx, window) {
  const start     = Math.max(0, idx - window);
  const end       = Math.min(sideArray.length - 1, idx + window);
  const neighbors = [];
  for (let i = start; i <= end; i++) {
    if (i !== idx) neighbors.push(sideArray[i].usdValue);
  }
  if (!neighbors.length) return 0;
  neighbors.sort((a, b) => a - b);
  return _percentile(neighbors, 0.50);
}

/**
 * Count how many levels on this side have a usdValue "similar" to candidateUsd
 * (within ±35%).  A high count means the candidate is part of a cluster and
 * should not be treated as a unique wall.
 *
 * @param {{ usdValue: number }[]} sideArray
 * @param {number} candidateUsd
 * @returns {number}
 */
function _computeSimilarLevelsCount(sideArray, candidateUsd) {
  const lo = candidateUsd * 0.65;
  const hi = candidateUsd * 1.35;
  return sideArray.filter(l => l.usdValue >= lo && l.usdValue <= hi).length;
}

/**
 * Compute wallPower ∈ [0, 1] for a confirmed/persistent wall.
 *
 *   wallPower =
 *     0.35 × p95RatioScore
 *   + 0.30 × localRatioScore
 *   + 0.15 × distanceScore
 *   + 0.10 × lifetimeScore
 *   + 0.10 × isolationScore
 *
 * @param {{
 *   usdValue: number,
 *   p95Usd: number,
 *   localMedianUsd: number,
 *   distancePct: number,
 *   lifetimeMs: number,
 *   similarLevelsCount: number,
 * }} params
 * @returns {number}
 */
function _computeWallPower({ usdValue, p95Usd, localMedianUsd, distancePct, lifetimeMs, similarLevelsCount }) {
  // p95RatioScore: p95Ratio = usdValue / p95Usd;  3× p95 = 1.0
  const p95Ratio       = p95Usd > 0 ? usdValue / p95Usd : 0;
  const p95RatioScore  = Math.min(p95Ratio / 3, 1);

  // localRatioScore: 5× local median = 1.0
  const localRatio      = localMedianUsd > 0 ? usdValue / localMedianUsd : 0;
  const localRatioScore = Math.min(localRatio / 5, 1);

  // distanceScore (step function per ТЗ)
  let distanceScore;
  if      (distancePct <= 0.5) distanceScore = 1.0;
  else if (distancePct <= 1.0) distanceScore = 0.8;
  else if (distancePct <= 2.0) distanceScore = 0.6;
  else if (distancePct <= 5.0) distanceScore = 0.3;
  else                         distanceScore = 0;

  // lifetimeScore: 0s→0, 20s→0.4, 60s→0.7, 180s→1.0
  const lifeSec = lifetimeMs / 1000;
  let lifetimeScore;
  if      (lifeSec >= 180) lifetimeScore = 1.0;
  else if (lifeSec >= 60)  lifetimeScore = 0.7 + (lifeSec - 60)  / 120 * 0.3;
  else if (lifeSec >= 20)  lifetimeScore = 0.4 + (lifeSec - 20)  / 40  * 0.3;
  else                     lifetimeScore = (lifeSec / 20)         * 0.4;

  // isolationScore: 1 similar → 1.0; WALL_SIMILAR_LEVELS_LIMIT → 0.0
  const denom         = Math.max(WALL_SIMILAR_LEVELS_LIMIT - 1, 1);
  const isolationScore = Math.max(0, 1 - (similarLevelsCount - 1) / denom);

  const wallPower = Math.min(
    0.35 * p95RatioScore  +
    0.30 * localRatioScore +
    0.15 * distanceScore   +
    0.10 * lifetimeScore   +
    0.10 * isolationScore,
    1,
  );
  return parseFloat(wallPower.toFixed(4));
}

/**
 * Return the wall category string for a given wallPower value.
 * Returns null when the wall is below SOFT_WALL threshold.
 *
 * @param {number} wallPower
 * @returns {'EXTREME_WALL'|'STRONG_WALL'|'SOFT_WALL'|null}
 */
function _getWallCategory(wallPower) {
  if (wallPower >= WALL_POWER_EXTREME_MIN) return 'EXTREME_WALL';
  if (wallPower >= WALL_POWER_STRONG_MIN)  return 'STRONG_WALL';
  if (wallPower >= WALL_POWER_SOFT_MIN)    return 'SOFT_WALL';
  return null;
}

// ─── Main scan & update ────────────────────────────────────────────

/**
 * Process one scan tick for a symbol.
 *
 * Walks all bid/ask levels, identifies levels that qualify as wall candidates
 * (usdValue >= threshold, distance <= maxDistPct), updates the lifecycle state
 * machine, and promotes long-lived candidates to "confirmed".
 *
 * Must be called once per FUTURES_WALL_SCAN_MS interval.
 *
 * @param {string}             symbol
 * @param {Map<string,number>} bids     Map<priceStr, sizeNum>
 * @param {Map<string,number>} asks     Map<priceStr, sizeNum>
 * @param {number}             midPrice
 * @param {number}             [now]    defaults to Date.now()
 */
function scanAndUpdate(symbol, bids, asks, midPrice, now = Date.now()) {
  if (!midPrice || midPrice <= 0) return;

  // ── Prune expired presence-memory entries for this symbol ────────────────
  const _pmCleanup = presenceMemoryMap.get(symbol);
  if (_pmCleanup) {
    for (const [key, mem] of _pmCleanup) {
      if (now - mem.droppedAt >= PRESENCE_MEMORY_TTL_MS) _pmCleanup.delete(key);
    }
  }

  const staticThreshold = getFuturesWallThreshold(symbol);

  // ── v3 Pre-pass: collect all levels within WALL_SCAN_DISTANCE_PCT ─────────
  // Build price-sorted arrays (closest-to-mid first) so local statistics can
  // use array index as a proxy for price adjacency.
  //
  //  bidLevels: sorted highest-price first (closest bid = best bid = index 0)
  //  askLevels: sorted lowest-price  first (closest ask = best ask = index 0)
  //
  const bidLevels = [];  // { price, size, usdValue, dist }
  const askLevels = [];
  let   depthNear1PctTotal = 0;   // total USD for both sides within 1% of mid

  for (const [priceStr, size] of bids) {
    if (size <= 0) continue;
    const price    = parseFloat(priceStr);
    const dist     = ((midPrice - price) / midPrice) * 100;
    if (dist < 0 || dist > WALL_SCAN_DISTANCE_PCT) continue;
    const usdValue = price * size;
    bidLevels.push({ price, size, usdValue, dist });
    if (dist <= 1.0) depthNear1PctTotal += usdValue;
  }
  for (const [priceStr, size] of asks) {
    if (size <= 0) continue;
    const price    = parseFloat(priceStr);
    const dist     = ((price - midPrice) / midPrice) * 100;
    if (dist < 0 || dist > WALL_SCAN_DISTANCE_PCT) continue;
    const usdValue = price * size;
    askLevels.push({ price, size, usdValue, dist });
    if (dist <= 1.0) depthNear1PctTotal += usdValue;
  }

  // Sort: closest to mid first (bids ↓ price, asks ↑ price)
  bidLevels.sort((a, b) => b.price - a.price);
  askLevels.sort((a, b) => a.price - b.price);

  const avgDepthNear1Pct = depthNear1PctTotal / 2;
  const bidStats         = _computeSideStats(bidLevels);
  const askStats         = _computeSideStats(askLevels);
  const bidAdaptiveThresh = _computeAdaptiveThreshold(staticThreshold, bidStats, avgDepthNear1Pct);
  const askAdaptiveThresh = _computeAdaptiveThreshold(staticThreshold, askStats, avgDepthNear1Pct);

  // Store for payload builders
  wallStatsMap.set(symbol, {
    bid: bidStats, ask: askStats,
    bidAdaptiveThresh, askAdaptiveThresh,
    avgDepthNear1Pct,
    midPrice, updatedAt: now,
  });

  // ── v3 Build qualifying active levels ─────────────────────────────────────
  // Qualification criteria:
  //   1. sizeUsd >= adaptiveThreshold   (adaptive: p95×1.5 / median×4 / depth×3%)
  //   2. sizeUsd >= localMedianUsd × WALL_LOCAL_MULTIPLIER  (3× local neighborhood)
  //   3. distancePct <= WALL_SCAN_DISTANCE_PCT  (5% flat — no dynamic scaling)
  //
  // Levels that pass become candidates; the lifecycle state machine then handles
  // the temporal minimum (FUTURES_MIN_WALL_LIFETIME_MS) before confirmation.
  //
  const activeLevels = new Map();

  const _qualifyOneSide = (sideArray, side, adaptiveThresh) => {
    for (let i = 0; i < sideArray.length; i++) {
      const level = sideArray[i];
      const { price, size, usdValue, dist } = level;

      // Hard filter 1: adaptive threshold
      if (usdValue < adaptiveThresh) continue;

      // Hard filter 2: local anomaly vs neighborhood
      const localMedianUsd = _computeLocalMedian(sideArray, i, WALL_LOCAL_WINDOW_LEVELS);
      if (localMedianUsd > 0 && usdValue < localMedianUsd * WALL_LOCAL_MULTIPLIER) continue;

      // Compute isolation metric.
      // Hard filter 3: reject levels that are part of a dense cluster of similar-sized
      // orders — they represent normal liquidity depth, not anomalous walls.
      // (WALL_SIMILAR_LEVELS_LIMIT default=5: reject if 6+ similar-sized levels exist)
      const similarLevelsCount = _computeSimilarLevelsCount(sideArray, usdValue);
      if (similarLevelsCount > WALL_SIMILAR_LEVELS_LIMIT) continue;

      const deepWall  = usdValue >= staticThreshold * FUTURES_DEEP_WALL_MULTIPLIER_FLAG;
      const normPrice = normalizePrice(price, symbol);
      const key       = `${symbol}:${side}:${normPrice}`;

      // If multiple raw prices collapse to the same normalised bucket, keep highest usdValue
      const existing = activeLevels.get(key);
      if (!existing || usdValue > existing.usdValue) {
        activeLevels.set(key, {
          price, normPrice, size, usdValue, side,
          distancePct:         dist,
          deepWall,
          // v3 analytics stored on the level for propagation to candidate
          p95Usd:              (side === 'bid' ? bidStats.p95 : askStats.p95),
          localMedianUsd,
          similarLevelsCount,
          adaptiveThreshold:   adaptiveThresh,
        });
      }
    }
  };

  _qualifyOneSide(bidLevels, 'bid', bidAdaptiveThresh);
  _qualifyOneSide(askLevels, 'ask', askAdaptiveThresh);

  // ── Ensure state map for this symbol ────────────────────────────
  if (!candidateMap.has(symbol)) {
    candidateMap.set(symbol, new Map());
  }
  const symMap = candidateMap.get(symbol);

  // ── Update existing candidates ──────────────────────────────────
  for (const [wallKey, cand] of symMap.entries()) {
    const scanInterval = Math.max(0, now - cand._prevScanTs);
    cand._prevScanTs = now;

    if (activeLevels.has(wallKey)) {
      // Wall present & above adaptive threshold this tick
      const level   = activeLevels.get(wallKey);
      const prevUsd = cand.currentUsdValue;
      cand.accumulatedPresenceMs += scanInterval;
      cand.lastSeenTs       = now;
      cand.currentUsdValue  = level.usdValue;
      cand.currentSize      = level.size;
      cand.distancePct      = level.distancePct;
      cand.deepWall         = level.deepWall;
      if (level.usdValue > cand.maxUsdValue) cand.maxUsdValue = level.usdValue;
      // Detect refill: USD value recovered after dropping by >20%
      if (prevUsd > 0 && cand.currentUsdValue > prevUsd * 1.2) cand.refillCount++;
      cand.hitCount++;
      cand.missingSinceTs = null;

      // Update v3 analytics from current scan
      cand.lastP95Usd             = level.p95Usd;
      cand.lastLocalMedianUsd     = level.localMedianUsd;
      cand.lastSimilarLevelsCount = level.similarLevelsCount;
      cand.lastAdaptiveThreshold  = level.adaptiveThreshold;

      // Emit increased/decreased events for confirmed/persistent walls only (30s cooldown)
      if (
        (cand.status === 'confirmed' || cand.status === 'persistent') &&
        prevUsd > 0 &&
        (!cand._lastSizeEventTs || now - cand._lastSizeEventTs >= 30_000)
      ) {
        const changePct = (cand.currentUsdValue - prevUsd) / prevUsd;
        if (changePct > 0.20) {
          _emitWallEvent(symbol, 'increased', cand, now);
          cand._lastSizeEventTs = now;
        } else if (changePct < -0.20) {
          _emitWallEvent(symbol, 'decreased', cand, now);
          cand._lastSizeEventTs = now;
        }
      }
    } else {
      // Wall absent or below adaptive threshold this tick — start/extend absence timer.
      if (cand.missingSinceTs === null) cand.missingSinceTs = now;
      const absentMs = now - cand.missingSinceTs;
      const graceMs  = cand.status === 'confirmed'
        ? FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS
        : FUTURES_WALL_ABSENCE_GRACE_MS;
      if (absentMs > graceMs) {
        dropCandidate(symbol, wallKey, cand, 'absent_too_long', now);
        continue;
      }
    }

    // Promote candidate → confirmed once enough presence has accumulated
    if (cand.status === 'candidate' && cand.accumulatedPresenceMs >= FUTURES_MIN_WALL_LIFETIME_MS) {
      cand.status = 'confirmed';
      console.log(
        `[futures-walls] ${symbol}: CONFIRMED — ${cand.side} @ ${cand.price}` +
        ` presence=${Math.round(cand.accumulatedPresenceMs / 1000)}s` +
        ` usd=${Math.round(cand.maxUsdValue).toLocaleString()}`,
      );
      _emitWallEvent(symbol, 'confirmed', cand, now);
    }

    // Promote confirmed → persistent
    if (cand.status === 'confirmed' && cand.accumulatedPresenceMs >= FUTURES_WALL_PERSISTENT_MS) {
      cand.status = 'persistent';
      console.log(
        `[futures-walls] ${symbol}: PERSISTENT — ${cand.side} @ ${cand.price}` +
        ` presence=${Math.round(cand.accumulatedPresenceMs / 1000)}s` +
        ` usd=${Math.round(cand.maxUsdValue).toLocaleString()}`,
      );
      _emitWallEvent(symbol, 'persistent', cand, now);
    }

    // Compute scores (v2 quality + v3 wallPower)
    const prevSpoof = cand.isSuspiciousSpoof;
    _computeScores(cand, staticThreshold, now);
    if (!prevSpoof && cand.isSuspiciousSpoof) {
      _emitWallEvent(symbol, 'suspicious_spoof', cand, now);
    }
  }

  // ── Add newly seen levels as candidates ─────────────────────────
  const pmSym = presenceMemoryMap.get(symbol);
  for (const [wallKey, level] of activeLevels) {
    if (!symMap.has(wallKey)) {
      const cand = makeCandidate(
        symbol,
        level.side,
        level.price,
        level.normPrice,
        level.usdValue,
        level.size,
        level.distancePct,
        level.deepWall,
        now,
      );

      // Populate v3 fields immediately from the first scan
      cand.lastP95Usd             = level.p95Usd;
      cand.lastLocalMedianUsd     = level.localMedianUsd;
      cand.lastSimilarLevelsCount = level.similarLevelsCount;
      cand.lastAdaptiveThreshold  = level.adaptiveThreshold;

      // Restore accumulated presence from memory if the same wall was recently dropped
      const mem = pmSym?.get(wallKey);
      if (mem && (now - mem.droppedAt) < PRESENCE_MEMORY_TTL_MS) {
        cand.accumulatedPresenceMs = mem.accMs;
        cand.maxUsdValue = Math.max(mem.maxUsdValue, level.usdValue);
        pmSym.delete(wallKey);
        console.log(
          `[futures-walls] ${symbol}: resumed — ${level.side} @ ${level.price}` +
          ` restored=${Math.round(mem.accMs / 1000)}s usd=${Math.round(level.usdValue).toLocaleString()}`,
        );
      } else {
        console.log(
          `[futures-walls] ${symbol}: new candidate — ${level.side} @ ${level.price}` +
          ` usd=${Math.round(level.usdValue).toLocaleString()} dist=${level.distancePct.toFixed(2)}%`,
        );
        _emitWallEvent(symbol, 'new', cand, now);
      }
      symMap.set(wallKey, cand);
    }
  }
}

/**
 * Compute quality / bounce / breakout / spoof scores in-place on a candidate.
 * All scores are integers 0–100.
 *
 * qualityScore  — overall wall quality (size, longevity, refills, stability)
 * bounceScore   — how likely price bounces off this wall
 * breakoutScore — how likely price breaks through this wall
 * spoofScore    — probability this is a spoof (higher = more suspicious)
 */
function _computeScores(cand, threshold, now) {
  const presenceSec  = cand.accumulatedPresenceMs / 1000;
  const lifetimeSec  = (now - cand.firstSeenTs) / 1000;

  // ── qualityScore ─────────────────────────────────────────────────
  // Components:
  //   sizeScore     (40): how oversized vs threshold
  //   lifeScore     (30): how long it has been alive (capped at 10min)
  //   refillScore   (15): how often it refilled (each refill adds points)
  //   stabilityScore(15): ratio of presence vs lifetime (0 = flaky, 1 = always there)

  const sizeRatio     = Math.min(cand.maxUsdValue / Math.max(threshold, 1), 10) / 10; // 0..1 (capped at 10×)
  const sizeScore     = Math.round(sizeRatio * 40);

  const lifeScore     = Math.round(Math.min(presenceSec / 600, 1) * 30);  // 10min = 100%

  const refillScore   = Math.round(Math.min(cand.refillCount / 5, 1) * 15);  // 5 refills = full

  const stabilityRatio = lifetimeSec > 0 ? Math.min(presenceSec / lifetimeSec, 1) : 1;
  const stabilityScore  = Math.round(stabilityRatio * 15);

  cand.qualityScore = Math.min(sizeScore + lifeScore + refillScore + stabilityScore, 100);

  // ── spoofScore ───────────────────────────────────────────────────
  // High if: appeared briefly, was removed quickly, low stability
  const briefLife    = lifetimeSec < 30 ? 40 : lifetimeSec < 60 ? 20 : 0;
  const unstable     = Math.round((1 - stabilityRatio) * 40);
  const onlyCandidate = cand.status === 'candidate' ? 20 : 0;

  cand.spoofScore = Math.min(briefLife + unstable + onlyCandidate, 100);
  cand.isSuspiciousSpoof = cand.spoofScore >= 70;

  // ── bounceScore ──────────────────────────────────────────────────
  // High if: wall persists, price approached but did not cross, refills happen
  const lifeBonus     = Math.round(Math.min(presenceSec / 300, 1) * 40); // 5min for full
  const refillBonus   = Math.round(Math.min(cand.refillCount / 3, 1) * 30);
  const statusBonus   = cand.status === 'persistent' ? 30 : cand.status === 'confirmed' ? 15 : 0;

  cand.bounceScore = Math.min(lifeBonus + refillBonus + statusBonus, 100);

  // ── breakoutScore ────────────────────────────────────────────────
  // High if: wall usd has been declining (being absorbed), only 1 side keeps showing
  const usdDecline   = cand.maxUsdValue > 0 ? Math.max(0, (cand.maxUsdValue - cand.currentUsdValue) / cand.maxUsdValue) : 0;
  cand.breakoutScore = Math.min(Math.round(usdDecline * 80) + (cand.absorptionUsd > threshold ? 20 : 0), 100);

  // ── v3 wallPower (0–1.0) and wallCategory ────────────────────────
  // Computed only for confirmed/persistent walls; candidates get 0/null.
  if (cand.status === 'confirmed' || cand.status === 'persistent') {
    cand.wallPower = _computeWallPower({
      usdValue:           cand.currentUsdValue,
      p95Usd:             cand.lastP95Usd            ?? 0,
      localMedianUsd:     cand.lastLocalMedianUsd     ?? 0,
      distancePct:        cand.distancePct,
      lifetimeMs:         now - cand.firstSeenTs,
      similarLevelsCount: cand.lastSimilarLevelsCount ?? 0,
    });
    cand.wallCategory = _getWallCategory(cand.wallPower);
  } else {
    cand.wallPower    = 0;
    cand.wallCategory = null;
  }
}

// ─── Additional accessors ────────────────────────────────────────────────────

function getPersistentWalls(symbol) {
  const m = candidateMap.get(symbol);
  if (!m) return [];
  return [...m.values()].filter(c => c.status === 'persistent');
}

// ─── Accessors ─────────────────────────────────────────────────────

function getConfirmedWalls(symbol) {
  const m = candidateMap.get(symbol);
  if (!m) return [];
  // Return both confirmed AND persistent (persistent is a superset of confirmed)
  return [...m.values()].filter(c => c.status === 'confirmed' || c.status === 'persistent');
}

function getCandidates(symbol) {
  const m = candidateMap.get(symbol);
  if (!m) return [];
  return [...m.values()];
}

function getDroppedRecent(symbol) {
  return droppedHistory.get(symbol) || [];
}

function clearSymbol(symbol) {
  candidateMap.delete(symbol);
  droppedHistory.delete(symbol);
  presenceMemoryMap.delete(symbol);
}

// ─── Payload builders ─────────────────────────────────────────────

/**
 * Build the public Redis payload written to futures:walls:${symbol}.
 * Contains only confirmed walls.
 *
 * @param {string}  symbol
 * @param {number}  midPrice
 * @param {number}  [now]
 * @param {object}  [metadata]  extra fields merged into the payload (e.g. safeModeActive)
 * @returns {object}
 */
function buildPublicWallsPayload(symbol, midPrice, now = Date.now(), metadata = {}) {
  const threshold = getFuturesWallThreshold(symbol);
  const confirmed = getConfirmedWalls(symbol);

  const walls = confirmed.map(c => ({
    // Core identity
    wallId:             `${symbol}:${c.side}:${c.price}`,
    side:               c.side,
    price:              c.price,
    // Size fields (aliased for compatibility)
    size:               c.currentSize,
    qty:                c.currentSize,
    usdValue:           c.currentUsdValue,
    sizeUsd:            c.currentUsdValue,
    distancePct:        parseFloat(c.distancePct.toFixed(4)),
    // v3 adaptive analytics
    wallPower:          c.wallPower          ?? 0,
    wallCategory:       c.wallCategory       ?? null,
    p95Ratio:           c.lastP95Usd > 0 ? parseFloat((c.currentUsdValue / c.lastP95Usd).toFixed(3)) : 0,
    localRatio:         c.lastLocalMedianUsd > 0 ? parseFloat((c.currentUsdValue / c.lastLocalMedianUsd).toFixed(3)) : 0,
    similarLevelsCount: c.lastSimilarLevelsCount ?? 0,
    adaptiveThreshold:  Math.round(c.lastAdaptiveThreshold ?? 0),
    localMedianUsd:     Math.round(c.lastLocalMedianUsd    ?? 0),
    sideP95Usd:         Math.round(c.lastP95Usd            ?? 0),
    // Legacy fields kept for backward compatibility
    strength:           parseFloat((c.currentUsdValue / threshold).toFixed(2)),
    deepWall:           c.deepWall ?? false,
    firstSeenAt:        c.firstSeenTs,
    lastSeenAt:         c.lastSeenTs,
    firstSeenTs:        c.firstSeenTs,
    lastSeenTs:         c.lastSeenTs,
    lifetimeMs:         now - c.firstSeenTs,
    accPresenceMs:      c.accumulatedPresenceMs,
    status:             c.status,
    qualityScore:       c.qualityScore       ?? 0,
    bounceScore:        c.bounceScore        ?? 0,
    breakoutScore:      c.breakoutScore      ?? 0,
    spoofScore:         c.spoofScore         ?? 0,
    isSuspiciousSpoof:  c.isSuspiciousSpoof  ?? false,
    refillCount:        c.refillCount        ?? 0,
    sourceUniverse:     c.sourceUniverse     ?? 'futures',
  }));

  // Top-level aggregates for universe builder + DensityCoinList
  const totalConfirmedCount  = walls.length;          // all confirmed/persistent (for debug)
  const candidateCount       = getCandidates(symbol).filter(c => c.status === 'candidate').length;
  const significantWalls     = walls.filter(w => w.wallPower >= WALL_POWER_STRONG_MIN);
  const significantWallCount = significantWalls.length;
  const sortedByPower        = [...walls].sort((a, b) => b.wallPower - a.wallPower);
  const bestWallEntry        = sortedByPower[0] ?? null;

  // ── Filter public walls to only those with meaningful wallPower ────────────
  // Walls below WALL_POWER_SOFT_MIN are confirmed by lifecycle but not anomalous
  // enough to display. This prevents clusters of similar-sized levels from
  // inflating the public wall count (e.g. BTC W=40 should be W=0-3).
  const visibleWalls = walls.filter(w => w.wallPower >= WALL_POWER_SOFT_MIN);

  // Sort for display: highest USD first
  visibleWalls.sort((a, b) => b.usdValue - a.usdValue);

  return {
    symbol,
    marketType:           'futures',
    midPrice,
    wallThresholds:       { base: threshold, source: 'adaptive' },
    walls:                visibleWalls,
    totalConfirmedCount,
    candidateCount,
    significantWallCount,
    bestWallPower:        bestWallEntry?.wallPower ?? 0,
    bestWallUsd:          bestWallEntry?.usdValue  ?? 0,
    updatedAt:            now,
    minVisibleLifetimeMs: FUTURES_MIN_WALL_LIFETIME_MS,
    scanIntervalMs:       FUTURES_WALL_SCAN_MS,
    safeModeActive:       metadata.safeModeActive ?? false,
  };
}

/**
 * Build the internal debug payload written to futures:walls:internal:${symbol}.
 * Contains candidates + confirmed + recently dropped.
 *
 * @param {string}  symbol
 * @param {number}  midPrice
 * @param {number}  [now]
 * @returns {object}
 */
function buildInternalWallsPayload(symbol, midPrice, now = Date.now()) {
  const allCandidates = getCandidates(symbol);
  const dropped       = getDroppedRecent(symbol);

  return {
    symbol,
    marketType: 'futures',
    midPrice,
    updatedAt:  now,
    candidates: allCandidates.map(c => ({
      side:                c.side,
      price:               c.price,
      normPrice:           c.normPrice,
      status:              c.status,
      firstSeenTs:         c.firstSeenTs,
      lastSeenTs:          c.lastSeenTs,
      currentUsdValue:     c.currentUsdValue,
      maxUsdValue:         c.maxUsdValue,
      accumulatedPresenceMs: c.accumulatedPresenceMs,
      lifetimeMs:          now - c.firstSeenTs,
      distancePct:         c.distancePct,
      deepWall:            c.deepWall ?? false,
      hitCount:            c.hitCount,
      missingSinceTs:      c.missingSinceTs,
    })),
    droppedRecent: dropped,
  };
}

/**
 * Restore confirmed walls from a previously-persisted public walls payload.
 * Called on collector startup to survive process restarts without losing confirmed state.
 *
 * Only restores walls that are still within a reasonable distance (uses stored distancePct).
 * Each restored wall is inserted as a confirmed candidate with full accumulated presence.
 *
 * @param {string} symbol
 * @param {object} payload  — parsed JSON from futures:walls:${symbol}
 * @param {number} [now]
 */
function restoreConfirmedWalls(symbol, payload, now = Date.now()) {
  if (!payload || !Array.isArray(payload.walls) || payload.walls.length === 0) return;

  if (!candidateMap.has(symbol)) candidateMap.set(symbol, new Map());
  const symMap = candidateMap.get(symbol);

  let restored = 0;
  for (const w of payload.walls) {
    if (w.status !== 'confirmed' && w.status !== 'persistent') continue;
    const normPrice = normalizePrice(Number(w.price), symbol);
    const wallKey = `${symbol}:${w.side}:${normPrice}`;
    if (symMap.has(wallKey)) continue; // already tracked, don't overwrite

    const cand = makeCandidate(
      symbol, w.side, Number(w.price), normPrice,
      Number(w.usdValue), Number(w.size ?? 0),
      Number(w.distancePct ?? 0), w.deepWall ?? false,
      w.firstSeenTs ?? now,
    );
    // Restore state (confirmed or persistent) and carry over accumulated presence
    cand.status               = w.status === 'persistent' ? 'persistent' : 'confirmed';
    cand.lastSeenTs           = w.lastSeenTs ?? now;
    cand.maxUsdValue          = Math.max(Number(w.usdValue), cand.maxUsdValue);
    cand.accumulatedPresenceMs = w.accPresenceMs ?? w.lifetimeMs ?? FUTURES_MIN_WALL_LIFETIME_MS;
    cand._prevScanTs          = now;
    cand.hitCount             = 10; // synthetic: treat restored wall as well-established
    cand.qualityScore         = w.qualityScore  ?? 0;
    cand.bounceScore          = w.bounceScore   ?? 0;
    cand.breakoutScore        = w.breakoutScore ?? 0;
    cand.spoofScore           = w.spoofScore    ?? 0;
    cand.refillCount          = w.refillCount   ?? 0;
    symMap.set(wallKey, cand);
    restored++;
    console.log(
      `[futures-walls] ${symbol}: RESTORED confirmed — ${w.side} @ ${w.price}` +
      ` usd=${Math.round(w.usdValue).toLocaleString()} (from Redis)`,
    );
  }
  if (restored > 0) console.log(`[futures-walls] ${symbol}: restored ${restored} confirmed wall(s) from Redis`);
}

/**
 * Restore presence memory from the internal payload's droppedRecent history.
 * Called on startup so partially-accumulated walls (e.g. walls outside the 1000-level
 * snapshot range that only appear via WS diffs) pick up where they left off instead
 * of restarting from zero every time the collector restarts.
 *
 * @param {string} symbol
 * @param {object} internalPayload  — parsed JSON from futures:walls:internal:${symbol}
 * @param {number} [now]
 */
function restorePresenceMemory(symbol, internalPayload, now = Date.now()) {
  if (!internalPayload || !Array.isArray(internalPayload.droppedRecent)) return;

  let pmSym = presenceMemoryMap.get(symbol);
  if (!pmSym) { pmSym = new Map(); presenceMemoryMap.set(symbol, pmSym); }

  let count = 0;
  for (const w of internalPayload.droppedRecent) {
    if (!w.accPresenceMs || w.accPresenceMs <= 0) continue;
    if ((now - w.droppedAt) >= PRESENCE_MEMORY_TTL_MS) continue; // too old
    const normPrice = normalizePrice(Number(w.price), symbol);
    const wallKey = `${symbol}:${w.side}:${normPrice}`;
    // Only restore if not already tracked as a live candidate
    const symMap = candidateMap.get(symbol);
    if (symMap?.has(wallKey)) continue;
    if (!pmSym.has(wallKey)) { // keep the most recent entry if duplicates
      pmSym.set(wallKey, { accMs: w.accPresenceMs, maxUsdValue: Number(w.usdValue ?? 0), droppedAt: w.droppedAt });
      count++;
    }
  }
  if (count > 0) console.log(`[futures-walls] ${symbol}: restored presence memory for ${count} dropped wall(s) from Redis`);
}

// ─── v3 Stats / Best-wall payload builders ────────────────────────────────

/**
 * Return the per-side orderbook statistics payload written to density:wallStats:{symbol}.
 * Returns null if no scan has been performed for this symbol yet.
 *
 * @param {string} symbol
 * @returns {object|null}
 */
function buildWallStatsPayload(symbol) {
  const s = wallStatsMap.get(symbol);
  if (!s) return null;
  return {
    symbol,
    bid: {
      medianOrderUsd:    Math.round(s.bid.p50),
      p75OrderUsd:       Math.round(s.bid.p75),
      p90OrderUsd:       Math.round(s.bid.p90),
      p95OrderUsd:       Math.round(s.bid.p95),
      maxOrderUsd:       Math.round(s.bid.max),
      levelCount:        s.bid.levelCount,
      adaptiveThreshold: Math.round(s.bidAdaptiveThresh),
    },
    ask: {
      medianOrderUsd:    Math.round(s.ask.p50),
      p75OrderUsd:       Math.round(s.ask.p75),
      p90OrderUsd:       Math.round(s.ask.p90),
      p95OrderUsd:       Math.round(s.ask.p95),
      maxOrderUsd:       Math.round(s.ask.max),
      levelCount:        s.ask.levelCount,
      adaptiveThreshold: Math.round(s.askAdaptiveThresh),
    },
    avgDepthNear1PctUsd: Math.round(s.avgDepthNear1Pct),
    updatedAt:           s.updatedAt,
  };
}

/**
 * Return the best (highest wallPower) confirmed wall for the symbol.
 * Only walls with a non-null wallCategory are considered.
 * Returns null if no qualifying wall exists.
 *
 * @param {string} symbol
 * @param {number} midPrice
 * @param {number} [now]
 * @returns {object|null}
 */
function buildBestWallPayload(symbol, midPrice, now = Date.now()) {
  const confirmed = getConfirmedWalls(symbol);
  if (!confirmed.length) return null;

  let bestCand = null;
  for (const c of confirmed) {
    if ((c.wallPower ?? 0) > 0 && (!bestCand || c.wallPower > bestCand.wallPower)) {
      bestCand = c;
    }
  }
  if (!bestCand || !bestCand.wallCategory) return null;

  return {
    symbol,
    side:               bestCand.side,
    price:              bestCand.price,
    sizeUsd:            bestCand.currentUsdValue,
    distancePct:        parseFloat(bestCand.distancePct.toFixed(4)),
    wallPower:          bestCand.wallPower,
    category:           bestCand.wallCategory,
    p95Ratio:           bestCand.lastP95Usd > 0
      ? parseFloat((bestCand.currentUsdValue / bestCand.lastP95Usd).toFixed(3)) : 0,
    localRatio:         bestCand.lastLocalMedianUsd > 0
      ? parseFloat((bestCand.currentUsdValue / bestCand.lastLocalMedianUsd).toFixed(3)) : 0,
    similarLevelsCount: bestCand.lastSimilarLevelsCount ?? 0,
    adaptiveThreshold:  bestCand.lastAdaptiveThreshold  ?? 0,
    lifetimeMs:         now - bestCand.firstSeenTs,
    updatedAt:          now,
  };
}

module.exports = {
  getFuturesWallThreshold,
  setTickSize,
  normalizePrice,
  scanAndUpdate,
  getConfirmedWalls,
  getPersistentWalls,
  getCandidates,
  getDroppedRecent,
  getAndClearPendingEvents,
  buildPublicWallsPayload,
  buildInternalWallsPayload,
  buildWallStatsPayload,
  buildBestWallPayload,
  clearSymbol,
  restoreConfirmedWalls,
  restorePresenceMemory,
  FUTURES_WALL_MIN_QUALITY_SCORE,
};
