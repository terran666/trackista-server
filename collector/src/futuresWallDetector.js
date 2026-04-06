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

const MAX_DROPPED_HISTORY = 20;

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
    // Scoring fields — computed each scan tick
    qualityScore:          0,
    bounceScore:           0,
    breakoutScore:         0,
    spoofScore:            0,
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

  const map = candidateMap.get(symbol);
  if (map) map.delete(wallKey);

  console.log(
    `[futures-walls] ${symbol}: dropped (${reason}) — ${candidate.side} @ ${candidate.price}` +
    ` accPresence=${Math.round(candidate.accumulatedPresenceMs / 1000)}s`,
  );
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
  // presenceMemoryMap entries are written on dropCandidate() and consumed when
  // the same wall reappears.  Without explicit TTL cleanup the map grows without
  // bound for symbols whose walls disappear and never return.
  const _pmCleanup = presenceMemoryMap.get(symbol);
  if (_pmCleanup) {
    for (const [key, mem] of _pmCleanup) {
      if (now - mem.droppedAt >= PRESENCE_MEMORY_TTL_MS) _pmCleanup.delete(key);
    }
  }

  const threshold       = getFuturesWallThreshold(symbol);

  // Smooth linear distance scaling:
  //   effectiveMaxDist = min(BASE + (ratio-1) * SCALE, HARD_CAP)
  // where ratio = usdValue / threshold.
  // This lets large walls be visible far from the current price,
  // scaling proportionally rather than with a hard binary cutoff.
  function effectiveDistCap(usdValue) {
    const ratio = usdValue / threshold;
    return Math.min(
      FUTURES_MAX_WALL_DISTANCE_PCT + (ratio - 1) * FUTURES_DIST_SCALE_PER_MULTIPLIER,
      FUTURES_DEEP_WALL_MAX_DISTANCE_PCT,
    );
  }

  // ── Build the set of qualifying levels this tick ─────────────────
  // Map<wallKey, { price, normPrice, size, usdValue, side, distancePct, deepWall }>
  const activeLevels = new Map();

  for (const [priceStr, size] of bids) {
    if (size <= 0) continue;
    const price    = parseFloat(priceStr);
    const usdValue = price * size;
    if (usdValue < threshold) continue;
    const dist     = ((midPrice - price) / midPrice) * 100;
    if (dist < 0) continue;
    if (dist > effectiveDistCap(usdValue)) continue;
    const deepWall  = usdValue >= threshold * FUTURES_DEEP_WALL_MULTIPLIER_FLAG;
    const normPrice = normalizePrice(price, symbol);
    const key = `${symbol}:bid:${normPrice}`;
    // If multiple raw prices collapse to the same normalised bucket, keep highest usdValue
    const existing = activeLevels.get(key);
    if (!existing || usdValue > existing.usdValue) {
      activeLevels.set(key, { price, normPrice, size, usdValue, side: 'bid', distancePct: dist, deepWall });
    }
  }

  for (const [priceStr, size] of asks) {
    if (size <= 0) continue;
    const price    = parseFloat(priceStr);
    const usdValue = price * size;
    if (usdValue < threshold) continue;
    const dist     = ((price - midPrice) / midPrice) * 100;
    if (dist < 0) continue;
    if (dist > effectiveDistCap(usdValue)) continue;
    const deepWall  = usdValue >= threshold * FUTURES_DEEP_WALL_MULTIPLIER_FLAG;
    const normPrice = normalizePrice(price, symbol);
    const key = `${symbol}:ask:${normPrice}`;
    const existing = activeLevels.get(key);
    if (!existing || usdValue > existing.usdValue) {
      activeLevels.set(key, { price, normPrice, size, usdValue, side: 'ask', distancePct: dist, deepWall });
    }
  }

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
      // Wall present & above threshold this tick
      const level = activeLevels.get(wallKey);
      const prevUsd = cand.currentUsdValue;
      cand.accumulatedPresenceMs += scanInterval;
      cand.lastSeenTs      = now;
      cand.currentUsdValue = level.usdValue;
      cand.currentSize     = level.size;
      cand.distancePct     = level.distancePct;
      cand.deepWall        = level.deepWall;
      if (level.usdValue > cand.maxUsdValue) cand.maxUsdValue = level.usdValue;
      // Detect refill: USD value recovered after dropping by >20%
      if (prevUsd > 0 && cand.currentUsdValue > prevUsd * 1.2) cand.refillCount++;
      cand.hitCount++;
      cand.missingSinceTs  = null;
    } else {
      // Wall absent or below threshold this tick — start/extend absence timer.
      // Confirmed walls get a longer grace period to survive brief disappearances
      // (spoofing / iceberg / market-maker repositioning).
      if (cand.missingSinceTs === null) cand.missingSinceTs = now;
      const absentMs = now - cand.missingSinceTs;
      const graceMs = cand.status === 'confirmed'
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
    }

    // Promote confirmed → persistent once additional presence milestone reached
    if (cand.status === 'confirmed' && cand.accumulatedPresenceMs >= FUTURES_WALL_PERSISTENT_MS) {
      cand.status = 'persistent';
      console.log(
        `[futures-walls] ${symbol}: PERSISTENT — ${cand.side} @ ${cand.price}` +
        ` presence=${Math.round(cand.accumulatedPresenceMs / 1000)}s` +
        ` usd=${Math.round(cand.maxUsdValue).toLocaleString()}`,
      );
    }

    // Compute scores each tick (lightweight)
    _computeScores(cand, getFuturesWallThreshold(symbol), now);
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

      // Restore accumulated presence from memory if the same wall was recently dropped
      const mem = pmSym?.get(wallKey);
      if (mem && (now - mem.droppedAt) < PRESENCE_MEMORY_TTL_MS) {
        cand.accumulatedPresenceMs = mem.accMs;
        cand.maxUsdValue = Math.max(mem.maxUsdValue, level.usdValue);
        pmSym.delete(wallKey); // consume memory entry
        console.log(
          `[futures-walls] ${symbol}: resumed — ${level.side} @ ${level.price}` +
          ` restored=${Math.round(mem.accMs / 1000)}s usd=${Math.round(level.usdValue).toLocaleString()}`,
        );
      } else {
        console.log(
          `[futures-walls] ${symbol}: new candidate — ${level.side} @ ${level.price}` +
          ` usd=${Math.round(level.usdValue).toLocaleString()} dist=${level.distancePct.toFixed(2)}%`,
        );
      }

      symMap.set(wallKey, cand);
    }
  }
}

// ─── Scoring ────────────────────────────────────────────────────────

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
    side:          c.side,
    price:         c.price,
    size:          c.currentSize,
    usdValue:      c.currentUsdValue,
    distancePct:   parseFloat(c.distancePct.toFixed(4)),
    strength:      parseFloat((c.currentUsdValue / threshold).toFixed(2)),
    deepWall:      c.deepWall ?? false,
    firstSeenTs:   c.firstSeenTs,
    lastSeenTs:    c.lastSeenTs,
    lifetimeMs:    now - c.firstSeenTs,
    accPresenceMs: c.accumulatedPresenceMs,
    status:        c.status,
    qualityScore:  c.qualityScore  ?? 0,
    bounceScore:   c.bounceScore   ?? 0,
    breakoutScore: c.breakoutScore ?? 0,
    spoofScore:    c.spoofScore    ?? 0,
    isSuspiciousSpoof: c.isSuspiciousSpoof ?? false,
    refillCount:   c.refillCount   ?? 0,
    sourceUniverse: c.sourceUniverse ?? 'futures',
  }));

  walls.sort((a, b) => b.usdValue - a.usdValue);

  return {
    symbol,
    marketType:           'futures',
    midPrice,
    wallThresholds:       { base: threshold, source: 'symbol-fixed-threshold' },
    walls,
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

module.exports = {
  getFuturesWallThreshold,
  setTickSize,
  normalizePrice,
  scanAndUpdate,
  getConfirmedWalls,
  getPersistentWalls,
  getCandidates,
  getDroppedRecent,
  buildPublicWallsPayload,
  buildInternalWallsPayload,
  clearSymbol,
  restoreConfirmedWalls,
  restorePresenceMemory,
  FUTURES_WALL_MIN_QUALITY_SCORE,
};
