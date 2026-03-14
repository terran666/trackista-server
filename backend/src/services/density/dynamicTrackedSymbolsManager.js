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
//   DENSITY_TRACKED_SYMBOLS_LIMIT  (default 20)
//   DENSITY_TRACKED_REFRESH_MS     (default 15000)
//   DENSITY_TRACKED_MIN_HOLD_MS    (default 60000)

// ─── Score reference baselines ────────────────────────────────────
// Values at or above these are treated as 100% contribution.
const ACT_REF = 500_000;  // activityScore — "very high" activity
const VOL_REF = 5_000_000; // volumeUsdt60s — $5M/min is "very high"
// impulseScore = (priceMovePct * 40) + (volSpikeRatio * 50) — no fixed ceiling;
// alertEngine treats ≥ 150 as "high" and ≥ 100 as "medium".
// inPlayScore is constructed similarly; ≥ 120 is "high" per alertEngine.
const IMP_REF = 150;       // impulseScore reference ceiling
const INP_REF = 120;       // inPlayScore reference ceiling

// ─── Config ───────────────────────────────────────────────────────
const LIMIT    = parseInt(process.env.DENSITY_TRACKED_SYMBOLS_LIMIT || '20',    10);
const REFRESH  = parseInt(process.env.DENSITY_TRACKED_REFRESH_MS    || '15000', 10);
const MIN_HOLD = parseInt(process.env.DENSITY_TRACKED_MIN_HOLD_MS   || '60000', 10);

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

  // 4. Apply same selection to both spot and futures (same signal data for now)
  for (const mt of ['spot', 'futures']) {
    const held = trackedSince[mt];

    // Hysteresis: force-keep symbols that haven't hit MIN_HOLD yet.
    // Force-kept symbols take slots from topN to keep total at LIMIT.
    const forceKeep = [];
    for (const [sym, since] of held.entries()) {
      if (!topSet.has(sym) && (now - since) < MIN_HOLD) {
        forceKeep.push(sym);
      }
    }

    // Cap total to LIMIT: forceKept symbols displace lowest-ranked topN entries
    const slotsForTopN = Math.max(0, LIMIT - forceKeep.length);
    const finalList = [...topN.slice(0, slotsForTopN), ...forceKeep];
    const finalSet  = new Set(finalList);

    // Detect changes for logging
    const prevSymbols = new Set(held.keys());
    const added       = finalList.filter(s => !prevSymbols.has(s));
    const removed     = [...prevSymbols].filter(s => !finalSet.has(s));

    // Update in-memory hold tracker
    for (const s of added)   held.set(s, now);
    for (const s of removed) held.delete(s);

    if (added.length > 0 || removed.length > 0) {
      const addStr = added.length   ? `+[${added.join(',')}] `    : '';
      const remStr = removed.length ? `-[${removed.join(',')}]`   : '';
      console.log(`[density-track] ${mt} updated: ${addStr}${remStr} → total=${finalList.length}`);
    }

    // 5. Write to Redis
    const payload = {
      updatedAt: now,
      limit:     LIMIT,
      symbols:   finalList,
      // Include top 50 scored items for the debug endpoint
      scored:    scored.slice(0, Math.min(50, scored.length)),
    };
    await redis.set(TRACKED_KEY[mt], JSON.stringify(payload));
  }

  console.log(
    `[density-track] refresh complete — universe=${universe.length}` +
    ` scored=${scored.length} tracked=${topN.length}` +
    ` top3=${topN.slice(0, 3).join(',')}`,
  );
}

// ─── Public API ───────────────────────────────────────────────────

function start(redis) {
  console.log(
    `[density-track] Starting dynamic tracked symbols manager` +
    ` (limit=${LIMIT} refresh=${REFRESH}ms minHold=${MIN_HOLD}ms)`,
  );

  // Run immediately on startup, then on the configured interval
  runRefresh(redis).catch(err =>
    console.error('[density-track] initial refresh error:', err.message),
  );

  setInterval(() => {
    runRefresh(redis).catch(err =>
      console.error('[density-track] refresh error:', err.message),
    );
  }, REFRESH);
}

module.exports = { start, TRACKED_KEY };
