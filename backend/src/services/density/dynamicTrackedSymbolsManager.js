'use strict';

// ─── Dynamic Tracked Symbols Manager ─────────────────────────────
//
// Runs on a periodic interval and:
//   1. Reads the full active symbol universe from Redis (symbols:active:usdt)
//   2. Fetches metrics + signal for every symbol via a single pipeline
//   3. Computes a trackingScore for each symbol
//   4. Selects top N by score with hysteresis (min hold time)
//   5. Writes the tracked list to Redis for spot + futures separately
//   6. Logs any additions / removals
//
// Redis keys written:
//   density:symbols:tracked:spot
//   density:symbols:tracked:futures
//
// Both use the same score (metrics/signal are spot-based collector data).
// Future: separate futures metrics when a futures signal collector exists.
//
// ENV:
//   DENSITY_TRACKED_SYMBOLS_LIMIT  (default 100)
//   DENSITY_TRACKED_REFRESH_MS     (default 15000)
//   DENSITY_TRACKED_MIN_HOLD_MS    (default 180000 — 3 min hysteresis)

// ─── Score reference baselines ────────────────────────────────────
// Values at or above these are treated as 100% contribution.
const ACT_REF = 500_000;  // activityScore — "very high" activity
const VOL_REF = 5_000_000; // volumeUsdt60s — $5M/min is "very high"
// impulseScore = (priceMovePct * 40) + (volSpikeRatio * 50) — no fixed ceiling;
// alertEngine treats ≥ 150 as "high" and ≥ 100 as "medium".
// inPlayScore is constructed similarly; ≥ 120 is "high" per alertEngine.
const IMP_REF = 150;       // impulseScore reference ceiling
const INP_REF = 120;       // inPlayScore reference ceiling

// ─── Spot config ─────────────────────────────────────────────────
// DENSITY_SPOT_ENABLED=false — set to 'true' to re-enable spot density tracking
const DENSITY_SPOT_ENABLED = process.env.DENSITY_SPOT_ENABLED === 'true';
const LIMIT    = parseInt(process.env.DENSITY_TRACKED_SYMBOLS_LIMIT || '100',   10);
const REFRESH  = parseInt(process.env.DENSITY_TRACKED_REFRESH_MS    || '15000', 10);
const MIN_HOLD = parseInt(process.env.DENSITY_TRACKED_MIN_HOLD_MS   || '180000', 10);

// ─── Futures v2 config ────────────────────────────────────────────
const FUTURES_MIN_HOLD   = parseInt(process.env.FUTURES_TRACKED_MIN_HOLD_MS          || '600000', 10);  // 10 min
const FUTURES_REFRESH_MS = parseInt(process.env.TRACKED_UNIVERSE_REFRESH_MS          || process.env.FUTURES_TRACKED_SYMBOLS_REFRESH_MS || '60000', 10);
const FUTURES_SAFE_MODE  = 'density:futures:safe-mode';

// Universe keys written by collector/symbolsUniverseBuilder.js
const UNIVERSE_KEYS = {
  filtered:  'tracked:universe:filtered',
  meta:      'tracked:universe:meta',
  futures:   'tracked:futures:symbols',
  spot:      'tracked:spot:symbols',
};

// ─── Redis keys ───────────────────────────────────────────────────
const TRACKED_KEY = {
  spot:    'density:symbols:tracked:spot',
  futures: 'density:symbols:tracked:futures',
};

// ─── State ────────────────────────────────────────────────────────
// Tracks when each symbol entered the tracked list (for hysteresis).
// Map<symbol, trackedSinceMs>  — one per marketType
const trackedSince = {
  spot:    new Map(),
  futures: new Map(),
};

// ─── Helpers ──────────────────────────────────────────────────────

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function clamp(val, ref) {
  if (val == null || !isFinite(val) || val < 0) return 0;
  return Math.min(val / ref, 1);
}

/**
 * Compute a 0–100 composite tracking score.
 *
 * Weights:
 *   40%  activityScore (from metrics)
 *   30%  impulseScore  (from signal)
 *   20%  inPlayScore   (from signal)
 *   10%  volumeUsdt60s (from metrics)
 */
function computeTrackingScore(metrics, signal) {
  const activity = clamp(metrics?.activityScore, ACT_REF);
  const volume   = clamp(metrics?.volumeUsdt60s,  VOL_REF);
  const impulse  = clamp(signal?.impulseScore,    IMP_REF);
  const inPlay   = clamp(signal?.inPlayScore,     INP_REF);
  return (activity * 40) + (impulse * 30) + (inPlay * 20) + (volume * 10);
}

// ─── Core refresh ─────────────────────────────────────────────────

async function runRefresh(redis) {
  // 1. Load symbol universe
  const universeRaw = await redis.get('symbols:active:usdt');
  const universe    = safeParse(universeRaw);

  if (!Array.isArray(universe) || universe.length === 0) {
    console.warn('[density-track] symbol universe empty — skipping refresh');
    return;
  }

  // 2. Fetch metrics + signal for all symbols in a single pipeline
  const pipeline = redis.pipeline();
  for (const sym of universe) {
    pipeline.get(`metrics:${sym}`);
    pipeline.get(`signal:${sym}`);
  }
  const results = await pipeline.exec();

  // 3. Score every symbol
  const scored = [];
  for (let i = 0; i < universe.length; i++) {
    const sym     = universe[i];
    const metrics = safeParse(results[i * 2][1]);
    const signal  = safeParse(results[i * 2 + 1][1]);

    // Skip symbols with no data (collector hasn't warmed up for them yet)
    if (!metrics && !signal) continue;

    const score = computeTrackingScore(metrics, signal);
    scored.push({
      symbol:        sym,
      trackingScore: Math.round(score * 10) / 10,
      activityScore: metrics?.activityScore ?? null,
      impulseScore:  signal?.impulseScore   ?? null,
      inPlayScore:   signal?.inPlayScore    ?? null,
      volumeUsdt60s: metrics?.volumeUsdt60s ?? null,
      tradeCount60s: metrics?.tradeCount60s ?? null,
    });
  }

  // Sort descending by score
  scored.sort((a, b) => b.trackingScore - a.trackingScore);

  const now      = Date.now();
  const topN     = scored.slice(0, LIMIT).map(s => s.symbol);
  const topSet   = new Set(topN);

  // 4. Apply selection to spot only (when spot is enabled).
  //    Futures is handled by the separate runFuturesRefresh() function.
  if (!DENSITY_SPOT_ENABLED) {
    // Write empty list so density-summary returns nothing for spot
    await redis.set(TRACKED_KEY.spot, JSON.stringify({ updatedAt: now, limit: 0, symbols: [], scored: [] }));
    console.log('[density-track] spot disabled (DENSITY_SPOT_ENABLED !== true) — wrote empty tracked list');
  } else {
    const held = trackedSince.spot;

    const forceKeep = [];
    for (const [sym, since] of held.entries()) {
      if (!topSet.has(sym) && (now - since) < MIN_HOLD) forceKeep.push(sym);
    }

    const slotsForTopN = Math.max(0, LIMIT - forceKeep.length);
    const finalList = [...topN.slice(0, slotsForTopN), ...forceKeep];
    const finalSet  = new Set(finalList);

    const prevSymbols = new Set(held.keys());
    const added       = finalList.filter(s => !prevSymbols.has(s));
    const removed     = [...prevSymbols].filter(s => !finalSet.has(s));

    for (const s of added)   held.set(s, now);
    for (const s of removed) held.delete(s);

    if (added.length > 0 || removed.length > 0) {
      const addStr = added.length   ? `+[${added.join(',')}] ` : '';
      const remStr = removed.length ? `-[${removed.join(',')}]` : '';
      console.log(`[density-track] spot updated: ${addStr}${remStr} → total=${finalList.length}`);
    }

    await redis.set(TRACKED_KEY.spot, JSON.stringify({
      updatedAt: now,
      limit:     LIMIT,
      symbols:   finalList,
      scored:    scored.slice(0, Math.min(50, scored.length)),
    }));
  }

  console.log(
    `[density-track] refresh complete — universe=${universe.length}` +
    ` scored=${scored.length} tracked=${topN.length}` +
    ` top3=${topN.slice(0, 3).join(',')}`,
  );
}

// ─── Futures v2 refresh ───────────────────────────────────────────
//
// Completely independent from the spot scoring logic.
// Reads the pre-built tracked:universe:filtered list written by
// symbolsUniverseBuilder (collector side) and syncs it into the
// density:symbols:tracked:futures key used by the backend.
// Also propagates tracked:spot:symbols → density:symbols:tracked:spot.
//
// Hysteresis: once a symbol enters the hold window, it stays for
// FUTURES_MIN_HOLD_MS even if it temporarily falls out of the universe.

async function runFuturesRefresh(redis) {
  const now = Date.now();

  // Skip rotation while collector is in safe mode
  const safeModeRaw = await redis.get(FUTURES_SAFE_MODE);
  if (safeModeRaw === '1') {
    console.log('[density-track] futures: safe mode active — skipping rotation');
    return;
  }

  // Read the universe built by the collector (symbolsUniverseBuilder.js)
  const [filteredRaw, metaRaw, spotUniverseRaw] = await Promise.all([
    redis.get(UNIVERSE_KEYS.filtered),
    redis.get(UNIVERSE_KEYS.meta),
    redis.get(UNIVERSE_KEYS.spot),
  ]);

  if (!filteredRaw) {
    // Universe not yet built — collector may still be starting up.
    // Keep current tracked list as-is until universe is available.
    console.warn('[density-track] futures: tracked:universe:filtered not yet available — retaining current list');
    return;
  }

  const universe = safeParse(filteredRaw);
  if (!Array.isArray(universe?.symbols)) return;

  const universeSymbols = universe.symbols;
  const universeSet     = new Set(universeSymbols);
  const held            = trackedSince.futures;

  // Apply hysteresis: keep symbols still within their min-hold window
  const hysteresisKeep = [];
  for (const [sym, since] of held.entries()) {
    if (!universeSet.has(sym) && (now - since) < FUTURES_MIN_HOLD) {
      hysteresisKeep.push(sym);
    }
  }

  // Build final list: universe symbols + hysteresis keeps (deduped)
  const finalSet  = new Set([...universeSymbols, ...hysteresisKeep]);
  const finalList = [...finalSet];

  const prevSet = new Set(held.keys());
  const added   = finalList.filter(s => !prevSet.has(s));
  const removed = [...prevSet].filter(s => !finalSet.has(s));

  for (const s of added)   held.set(s, now);
  for (const s of removed) held.delete(s);

  if (added.length > 0 || removed.length > 0) {
    const addStr = added.length   ? `+[${added.join(',')}] ` : '';
    const remStr = removed.length ? `-[${removed.join(',')}]` : '';
    console.log(`[density-track] futures v2: ${addStr}${remStr} → total=${finalList.length}`);
  }

  // Build scored array from meta
  const metaObj = safeParse(metaRaw) || {};
  const scored  = Object.entries(metaObj).map(([sym, m]) => ({
    symbol:        sym,
    quoteVol24h:   m.quoteVol24h,
    tradeCount24h: m.tradeCount24h,
    activityScore: m.activityScore,
    isForce:       m.isForce,
  })).slice(0, 50);

  await redis.set(TRACKED_KEY.futures, JSON.stringify({
    updatedAt: now,
    limit:     finalList.length,
    symbols:   finalList,
    source:    'universe-builder',
    scored,
  }));

  // Sync spot tracking list if available
  const spotUniverse = safeParse(spotUniverseRaw);
  if (Array.isArray(spotUniverse?.symbols) && spotUniverse.symbols.length > 0) {
    await redis.set(TRACKED_KEY.spot, JSON.stringify({
      updatedAt: now,
      limit:     spotUniverse.symbols.length,
      symbols:   spotUniverse.symbols,
      source:    'universe-builder:spot',
      scored:    [],
    }));
    console.log(`[density-track] spot synced from universe — count=${spotUniverse.symbols.length}`);
  }

  console.log(
    `[density-track] futures v2 refresh complete — universe=${universeSymbols.length}` +
    ` hysteresisKeep=${hysteresisKeep.length} final=${finalList.length}`,
  );
}

// ─── Public API ───────────────────────────────────────────────────

function start(redis) {
  console.log(
    `[density-track] Starting dynamic tracked symbols manager` +
    ` (spot: limit=${LIMIT} refresh=${REFRESH}ms minHold=${MIN_HOLD}ms |` +
    ` futures v2: refresh=${FUTURES_REFRESH_MS}ms minHold=${FUTURES_MIN_HOLD}ms)`,
  );

  // Spot refresh
  runRefresh(redis).catch(err =>
    console.error('[density-track] initial spot refresh error:', err.message),
  );
  setInterval(() => {
    runRefresh(redis).catch(err =>
      console.error('[density-track] spot refresh error:', err.message),
    );
  }, REFRESH);

  // Futures v2 refresh — reads from universe builder
  runFuturesRefresh(redis).catch(err =>
    console.error('[density-track] initial futures refresh error:', err.message),
  );
  setInterval(() => {
    runFuturesRefresh(redis).catch(err =>
      console.error('[density-track] futures refresh error:', err.message),
    );
  }, FUTURES_REFRESH_MS);
}

module.exports = { start, TRACKED_KEY, UNIVERSE_KEYS };
