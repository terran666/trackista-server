'use strict';

const WebSocket    = require('ws');
const { buildWallsPayload, getWallThreshold } = require('./wallDetector');
const { binanceFetch } = require('./binanceRestLogger');
const rateLimitStateStore = require('./shared/binanceRateLimitStateStore');

// ─── Configuration ────────────────────────────────────────────────
const BINANCE_REST_BASE  = 'https://fapi.binance.com';
const BINANCE_WS_BASE    = 'wss://fstream.binance.com';
const TOP_LEVELS         = parseInt(process.env.FUTURES_OB_TOP_LEVELS || '500', 10); // top N bids / asks stored per side

// Futures-specific hardening env vars
// FUTURES_OB_MAX_SYMBOLS          — hard cap on tracked futures symbols (default 10)
// FUTURES_OB_SNAPSHOT_LIMIT       — REST /depth limit (default 500, matches TOP_LEVELS)
// FUTURES_OB_TOP_LEVELS           — top N bids/asks stored in Redis per side (default 500)
// FUTURES_OB_RESYNC_COOLDOWN_MS   — min ms between snapshots per symbol (default 60 000)
// FUTURES_OB_CONNECT_STAGGER_MS   — ms between each new WS connection at startup (default 5 000)
// FUTURES_OB_QUARANTINE_MS        — how long a quarantined symbol is blocked (default 300 000 = 5 min)
// FUTURES_OB_MAX_FAILED_RESYNCS   — consecutive resync failures before quarantine (default 3)
// FUTURES_OB_MAX_GAPS_PER_MINUTE  — sequence gaps/min before quarantine (default 5)
// FUTURES_OB_MAX_CONCURRENT_RESYNCS — max parallel resync snapshot jobs (default 2)
const MAX_BOOK_SYMBOLS              = parseInt(process.env.FUTURES_OB_MAX_SYMBOLS              || '10',     10);

// Binance Futures /fapi/v1/depth only accepts these exact limit values.
// Any other value → HTTP 400. Snap configured value to nearest valid one.
const VALID_FUTURES_DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000];
function snapFuturesDepthLimit(requested) {
  if (VALID_FUTURES_DEPTH_LIMITS.includes(requested)) return requested;
  const snapped = VALID_FUTURES_DEPTH_LIMITS.reduce((prev, curr) =>
    Math.abs(curr - requested) < Math.abs(prev - requested) ? curr : prev,
  );
  console.warn(
    `[futures-ob] FUTURES_OB_SNAPSHOT_LIMIT=${requested} is not a valid Binance Futures depth limit` +
    ` — snapped to ${snapped}. Valid values: ${VALID_FUTURES_DEPTH_LIMITS.join(', ')}`,
  );
  return snapped;
}
const SNAPSHOT_LIMIT = snapFuturesDepthLimit(
  parseInt(process.env.FUTURES_OB_SNAPSHOT_LIMIT || '500', 10),
);
const RESYNC_COOLDOWN_MS            = parseInt(process.env.FUTURES_OB_RESYNC_COOLDOWN_MS       || '60000',  10);
const STARTUP_STAGGER_MS            = parseInt(process.env.FUTURES_OB_CONNECT_STAGGER_MS       || '5000',   10);
const QUARANTINE_MS                 = parseInt(process.env.FUTURES_OB_QUARANTINE_MS            || '300000', 10);
const MAX_FAILED_RESYNCS            = parseInt(process.env.FUTURES_OB_MAX_FAILED_RESYNCS       || '3',      10);
const MAX_GAPS_PER_MINUTE           = parseInt(process.env.FUTURES_OB_MAX_GAPS_PER_MINUTE      || '5',      10);
const MAX_CONCURRENT_RESYNCS        = parseInt(process.env.FUTURES_OB_MAX_CONCURRENT_RESYNCS   || '2',      10);

const FLUSH_INTERVAL_MS  = parseInt(process.env.ORDERBOOK_FLUSH_INTERVAL_MS || '1000', 10);
const RECONNECT_DELAY_MS = 5000;
const VOLUME_REFRESH_MS  = 60 * 60 * 1000;

// Per-attempt REST backoff (used inside the resync queue worker)
const RESYNC_BACKOFF_BASE_MS = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MS     || '10000',  10);
const RESYNC_BACKOFF_MAX_MS  = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MAX_MS  || '300000', 10);
const STATS_LOG_INTERVAL_MS  = 60_000;

// ─── Global IP-level backoff ────────────────────────────────────────────
//
// Binance 418 = IP-level temporary ban. Unlike 429 (per-symbol throttle)
// a 418 means ALL REST calls to fapi.binance.com from this IP will fail.
// We track this globally so every subsequent syncBook can bail immediately
// instead of piling on and extending the ban.
//
const globalBackoff = { until: 0 };

function isGloballyBanned() {
  return Date.now() < globalBackoff.until;
}

function setGlobalBackoff(durationMs) {
  const newUntil = Date.now() + durationMs;
  if (newUntil > globalBackoff.until) {
    globalBackoff.until = newUntil;
    console.error(
      `[futures-ob] GLOBAL IP BACKOFF set — all depth calls paused for ${Math.ceil(durationMs / 1000)}s` +
      ` (until ${new Date(newUntil).toISOString()})`,
    );
  }
}

// ─── Redis key helpers ────────────────────────────────────────────
// Futures data lives under a dedicated namespace so spot/futures
// are always separate in Redis.
const obKey    = sym => `futures:orderbook:${sym}`;
const wallsKey = sym => `futures:walls:${sym}`;
// ─── Futures exchangeInfo cache ─────────────────────────────────────────────
//
// Loaded once at startup (and on refresh). Used to validate that symbols
// being tracked actually exist as USDT-M perpetual futures — avoids wasting
// REST weight on spot-only symbols that will always 400.
//
const validFuturesSymbols = new Set();    // symbols present in fapi exchangeInfo
let   rejectedAtStartupSymbols = [];      // symbols from tracked list not in exchangeInfo

async function loadExchangeInfo() {
  const url = `${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`;
  console.log(`[futures-ob] loading exchangeInfo from ${url}`);
  try {
    const res = await binanceFetch(url, undefined, 'futuresOrderbookCollector', '*', 'exchangeInfo');
    if (!res.ok) {
      console.error(`[futures-ob] exchangeInfo HTTP ${res.status} — proceeding without symbol filter`);
      return;
    }
    const info = await res.json();
    let totalSymbols = 0;
    let activeUsdtM  = 0;
    validFuturesSymbols.clear();
    for (const sym of (info.symbols || [])) {
      totalSymbols++;
      if (
        sym.contractType === 'PERPETUAL' &&
        sym.quoteAsset   === 'USDT'      &&
        sym.status       === 'TRADING'
      ) {
        validFuturesSymbols.add(sym.symbol);
        activeUsdtM++;
      }
    }
    console.log(
      `[futures-ob] exchangeInfo loaded: total=${totalSymbols}` +
      ` activeUsdtMPerpetual=${activeUsdtM}`,
    );
  } catch (err) {
    console.error(`[futures-ob] exchangeInfo load failed: ${err.message} — proceeding without symbol filter`);
  }
}

// ─── Debug metrics ────────────────────────────────────────────────────
//
// In-memory counters. Accessible via getDebugState() which is called by
// the /api/futures-ob/state backend route.
//
const dbgMetrics = {
  skippedByCooldown:         0,
  skippedByQuarantine:       0,
  skippedByGlobalBackoff:    0,
  totalSequenceGaps:         0,
  totalResyncs:              0,
  totalFailedResyncs:        0,
  totalQuarantinedSymbols:   0,
  snapshotRequestsAttempted: 0,
  snapshotRequestsSucceeded: 0,
  snapshotRequestsFailed:    0,
};
// ─── 24h volume cache ─────────────────────────────────────────────
//
// Map<symbol, quoteVolume24h (USDT)>
// Populated on startup and refreshed hourly via Binance Futures ticker.
// Map<symbol, { volume, tradeCount24h }>
const volumeCache = new Map();

async function refreshVolumeCache(symbols, redis) {
  if (isGloballyBanned()) {
    const remainingS = Math.ceil((globalBackoff.until - Date.now()) / 1000);
    console.log(`[futures-ob] volume refresh skipped — global IP backoff active (${remainingS}s remaining)`);
    return;
  }
  try {
    const url = `${BINANCE_REST_BASE}/fapi/v1/ticker/24hr`;
    const res = await binanceFetch(url, undefined, 'futuresOrderbookCollector', '*', 'volumeRefresh');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tickers = await res.json();

    const symbolSet = new Set(symbols);
    let updated = 0;
    const pipeline = redis ? redis.pipeline() : null;
    
    for (const t of tickers) {
      if (!symbolSet.has(t.symbol)) continue;
      const vol = parseFloat(t.quoteVolume);
      const tradeCount = parseInt(t.count, 10);
      if (isFinite(vol) && isFinite(tradeCount)) {
        volumeCache.set(t.symbol, { volume: vol, tradeCount24h: tradeCount });
        // Write to Redis for dynamicTrackedSymbolsManager to filter by trade count
        if (pipeline) {
          pipeline.set(
            `futures:ticker24h:${t.symbol}`,
            JSON.stringify({ volume: vol, tradeCount24h: tradeCount, updatedAt: Date.now() }),
            'EX',
            3700, // expire in ~1h
          );
        }
        updated++;
      }
    }
    
    if (pipeline) await pipeline.exec();
    console.log(`[futures-ob] volume cache refreshed: ${updated}/${symbols.length} symbols`);

    for (const sym of symbols) {
      const data = volumeCache.get(sym);
      if (!data) continue;
      const thr = getWallThreshold(data.volume);
      console.log(
        `[futures-ob] ${sym}: volume24h=${Math.round(data.volume).toLocaleString()} USD` +
        ` trades24h=${data.tradeCount24h.toLocaleString()}` +
        ` → wallThreshold=${thr.toLocaleString()} USD`,
      );
    }
  } catch (err) {
    console.error('[futures-ob] volume cache refresh failed:', err.message);
  }
}

function startVolumeRefresh(symbols, redis) {
  // Delay initial fetch if a global IP ban is still active — avoids hitting
  // Binance immediately after a restart during an active ban period.
  const backoffRemaining = Math.max(0, globalBackoff.until - Date.now());
  if (backoffRemaining > 0) {
    console.log(`[futures-ob] volume refresh startup delayed by ${Math.ceil(backoffRemaining / 1000)}s (global IP backoff active)`);
    setTimeout(() => refreshVolumeCache([...bookStates.keys()], redis), backoffRemaining + 2000);
  } else {
    refreshVolumeCache(symbols, redis);
  }
  setInterval(() => refreshVolumeCache([...bookStates.keys()], redis), VOLUME_REFRESH_MS);
}

// ─── Wall lifetime state ──────────────────────────────────────────
//
// Tracks when each futures wall was first and last seen so we can compute
// lifetimeMs per wall.  Identity key: `${symbol}:${side}:${price}`.
//
// Map<key, { firstSeenTs, lastSeenTs }>
//
// After a restart all times reset — this is acceptable for MVP.
// Entries for walls that have disappeared are kept for one extra cycle
// (to allow downstream analysis of pulled walls) then pruned.
//
const wallLifetimes = new Map();

/**
 * Merge lifetime tracking into a freshly detected walls array.
 * Updates wallLifetimes in-place and annotates each wall with
 * firstSeenTs / lastSeenTs / lifetimeMs.
 *
 * @param {string} symbol
 * @param {Array<object>} walls   output of buildWallsPayload()
 * @param {number} now            current timestamp ms
 * @returns {Array<object>}       same array, walls annotated in-place
 */
function applyWallLifetime(symbol, walls, now) {
  const activeKeys = new Set();

  for (const wall of walls) {
    const key = `${symbol}:${wall.side}:${wall.price}`;
    activeKeys.add(key);

    if (wallLifetimes.has(key)) {
      const entry = wallLifetimes.get(key);
      entry.lastSeenTs = now;
      wall.firstSeenTs = entry.firstSeenTs;
      wall.lastSeenTs  = now;
      wall.lifetimeMs  = now - entry.firstSeenTs;
    } else {
      wallLifetimes.set(key, { firstSeenTs: now, lastSeenTs: now });
      wall.firstSeenTs = now;
      wall.lastSeenTs  = now;
      wall.lifetimeMs  = 0;
    }
  }

  for (const key of wallLifetimes.keys()) {
    if (!key.startsWith(`${symbol}:`)) continue;
    if (!activeKeys.has(key)) wallLifetimes.delete(key);
  }

  return walls;
}

// ─── Watchlist ────────────────────────────────────────────────────
//
// On startup: reads density:symbols:tracked:futures from Redis (written by
// the backend dynamicTrackedSymbolsManager).  Falls back to the
// FUTURES_ORDERBOOK_SYMBOLS / ORDERBOOK_SYMBOLS env var when the manager
// hasn't run yet.
//
// At runtime: each collector module's symbol-watcher re-reads the Redis key
// on every DENSITY_TRACKED_REFRESH_MS interval and calls connectOrderbook()
// for any newly-tracked symbols not yet in bookStates (one-way expansion;
// removal happens on collector restart).
//
async function getWatchlistSymbols(redis) {
  try {
    const raw = await redis.get('density:symbols:tracked:futures');
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.symbols) && data.symbols.length > 0) {
        console.log(`[futures-ob] using dynamic tracked list (${data.symbols.length} symbols)`);
        return data.symbols;
      }
    }
  } catch (_) {}
  // Fallback: static ENV list
  const raw = process.env.FUTURES_ORDERBOOK_SYMBOLS ||
              process.env.ORDERBOOK_SYMBOLS ||
              'BTCUSDT';
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

// ─── Per-symbol book state ────────────────────────────────────────
//
// Extended BookState fields vs spot collector:
//   consecutiveResyncFailures  — reset to 0 on success
//   gapTimestamps              — sliding window of gap events (last 60s)
//   quarantineUntil            — epoch ms; 0 = not quarantined
//   lastSnapshotAt             — epoch ms of most recent successful snapshot
//   inResyncQueue              — true while queued in resyncQueue (dedup guard)
//
const bookStates = new Map();

function getOrCreateBook(symbol) {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids:                       new Map(),
      asks:                       new Map(),
      lastUpdateId:               0,
      synced:                     false,
      buffer:                     [],
      dirty:                      false,
      updatedAt:                  0,
      lastResyncAt:               0,
      resyncCount:                0,
      resyncSkippedCooldown:      0,
      snapshotFetchCount:         0,
      rateLimitCount:             0,
      rateLimitBackoffUntilMs:    0,
      deactivated:                false,    // set true by symbol watcher to stop reconnect cycle
      ws:                         null,     // live WebSocket ref for forced close
      // ── circuit breaker fields ────────────────────────────────
      consecutiveResyncFailures:  0,
      gapTimestamps:              [],       // epoch ms of recent gap events
      quarantineUntil:            0,        // if > Date.now() symbol is quarantined
      lastSnapshotAt:             0,        // epoch ms of last *successful* snapshot
      inResyncQueue:              false,    // dedup guard for global resync queue
      lastDepthError:             null,     // { status, code, msg, ts } from most recent failed depth call
    });
  }
  return bookStates.get(symbol);
}

// ─── Book update helpers ──────────────────────────────────────────
function applyLevels(map, levels) {
  for (const [priceStr, sizeStr] of levels) {
    const size = parseFloat(sizeStr);
    if (size === 0) {
      map.delete(priceStr);
    } else {
      map.set(priceStr, size);
    }
  }
}

function applyEvent(state, event) {
  applyLevels(state.bids, event.b);
  applyLevels(state.asks, event.a);
  state.lastUpdateId = event.u;
  state.updatedAt    = event.T || event.E || Date.now(); // futures uses T (transaction time)
  state.dirty        = true;
}

// ─── Snapshot builder ─────────────────────────────────────────────
//
// Builds a normalised TOP_LEVELS snapshot from the current local futures book.
// bids sorted descending by price, asks ascending.
//
// RAW CONTRACT: every entry in bids/asks is a single Binance Futures price
// level (one key from the Map<priceStr, sizeNum>).  No levels are merged or
// bucketed before serialisation.  usdValue = round2(price * size).
// marketType is 'futures' — consumers use this to distinguish from spot.
// This snapshot is the canonical source for /api/orderbook (futures),
// /api/walls (futures), and /api/density-view (futures).
//
function buildSnapshot(state) {
  const bids = [...state.bids.entries()]
    .map(([p, s]) => ({ price: parseFloat(p), size: s }))
    .sort((a, b) => b.price - a.price)
    .slice(0, TOP_LEVELS)
    .map(l => ({
      price:    l.price,
      rawPrice: l.price,
      size:     l.size,
      usdValue: parseFloat((l.price * l.size).toFixed(2)),
    }));

  const asks = [...state.asks.entries()]
    .map(([p, s]) => ({ price: parseFloat(p), size: s }))
    .sort((a, b) => a.price - b.price)
    .slice(0, TOP_LEVELS)
    .map(l => ({
      price:    l.price,
      rawPrice: l.price,
      size:     l.size,
      usdValue: parseFloat((l.price * l.size).toFixed(2)),
    }));

  const bestBid  = bids.length > 0 ? bids[0].price : null;
  const bestAsk  = asks.length > 0 ? asks[0].price : null;
  const midPrice = bestBid !== null && bestAsk !== null
    ? parseFloat(((bestBid + bestAsk) / 2).toFixed(8))
    : null;

  return {
    symbol:     state.symbol,
    marketType: 'futures',
    ladderMode: 'raw',
    updatedAt:  state.updatedAt || Date.now(),
    bestBid,
    bestAsk,
    midPrice,
    bids,
    asks,
  };
}

// ─── Periodic Redis flush ─────────────────────────────────────────
function startFlushTimer(redis) {
  setInterval(() => {
    const pipeline = redis.pipeline();
    let count = 0;

    for (const state of bookStates.values()) {
      if (!state.dirty || !state.synced) continue;
      const snapshot = buildSnapshot(state);
      pipeline.set(obKey(state.symbol), JSON.stringify(snapshot));

      const volumeData    = volumeCache.get(state.symbol);
      const volume24h     = volumeData?.volume ?? null;
      const wallThreshold = getWallThreshold(volume24h);
      const wallsPayload  = buildWallsPayload(snapshot, wallThreshold);

      // Override marketType to futures in walls payload
      wallsPayload.marketType = 'futures';
      for (const w of wallsPayload.walls) {
        w.source = 'futures:orderbook';
      }

      applyWallLifetime(state.symbol, wallsPayload.walls, snapshot.updatedAt);

      pipeline.set(wallsKey(state.symbol), JSON.stringify(wallsPayload));

      state.dirty = false;
      count++;
    }

    if (count > 0) {
      pipeline.exec().catch(err =>
        console.error('[futures-ob] Redis flush error:', err.message),
      );
    }
  }, FLUSH_INTERVAL_MS);
}

// ─── Quarantine helpers ───────────────────────────────────────────

function isQuarantined(state) {
  return Date.now() < state.quarantineUntil;
}

function quarantineSymbol(state, reason) {
  state.quarantineUntil            = Date.now() + QUARANTINE_MS;
  state.consecutiveResyncFailures  = 0;
  dbgMetrics.totalQuarantinedSymbols++;
  console.warn(
    `[futures-ob] ${state.symbol}: quarantined for ${QUARANTINE_MS}ms due to ${reason}` +
    ` (until ${new Date(state.quarantineUntil).toISOString()})`,
  );
}

// Prune gapTimestamps older than 60s and return current count.
function recordGap(state) {
  const now     = Date.now();
  const cutoff  = now - 60_000;
  state.gapTimestamps = state.gapTimestamps.filter(ts => ts > cutoff);
  state.gapTimestamps.push(now);
  return state.gapTimestamps.length;
}

// ─── Global resync queue ──────────────────────────────────────────
//
// Architecture:
//   gap detected → mark state.synced = false → enqueueResync(symbol)
//   resyncQueue (ordered Set of symbol names)
//   resync worker: picks up to MAX_CONCURRENT_RESYNCS jobs at a time
//   each job: up to MAX_FAILED_RESYNCS attempts (10s / 20s / 40s backoff)
//   all attempts fail → quarantine symbol for QUARANTINE_MS
//   global IP ban active → pause the entire queue
//
// This prevents cascade storms: instead of N symbols immediately firing
// N simultaneous REST /depth calls, at most 2 run at any given moment.
//

const resyncQueue  = [];            // ordered array of symbol names
const activeResyncs = new Set();   // symbols whose resync job is currently running

function enqueueResync(symbol) {
  const state = bookStates.get(symbol);
  if (!state) return;

  if (isQuarantined(state)) {
    dbgMetrics.skippedByQuarantine++;
    console.log(`[futures-ob] ${symbol}: resync skipped (quarantine active until ${new Date(state.quarantineUntil).toISOString()})`);
    return;
  }
  if (state.inResyncQueue || activeResyncs.has(symbol)) {
    console.log(`[futures-ob] ${symbol}: resync skipped (already queued)`);
    return;
  }

  state.inResyncQueue = true;
  resyncQueue.push(symbol);
  console.log(`[futures-ob] ${symbol}: queued for resync (queue length=${resyncQueue.length})`);
  scheduleQueueDrain();
}

let drainScheduled = false;

function scheduleQueueDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  // Small tick delay to batch multiple nearly-simultaneous enqueue calls
  setImmediate(drainQueue);
}

function drainQueue() {
  drainScheduled = false;

  if (isGloballyBanned()) {
    console.log('[futures-ob] global backoff active — resync queue paused');
    return;
  }

  while (activeResyncs.size < MAX_CONCURRENT_RESYNCS && resyncQueue.length > 0) {
    const symbol = resyncQueue.shift();
    const state  = bookStates.get(symbol);
    if (!state) continue;

    state.inResyncQueue = false;
    activeResyncs.add(symbol);
    runResyncJob(symbol).finally(() => {
      activeResyncs.delete(symbol);
      // After each job completes, attempt to drain more if the queue is non-empty
      if (resyncQueue.length > 0) scheduleQueueDrain();
    });
  }
}

// Called periodically when global backoff expires so the queue resumes.
function resumeQueueAfterBackoff() {
  const remaining = globalBackoff.until - Date.now();
  if (remaining > 0) {
    setTimeout(resumeQueueAfterBackoff, remaining + 500);
    return;
  }
  if (resyncQueue.length > 0) {
    console.log('[futures-ob] global backoff ended — resync queue resumed');
    scheduleQueueDrain();
  }
}

// ─── Resync job (queue worker) ────────────────────────────────────
//
// Executes up to MAX_FAILED_RESYNCS snapshot attempts for one symbol,
// with exponential backoff between attempts (10s → 20s → 40s).
// On all attempts failing the symbol is quarantined.
//
async function runResyncJob(symbol) {
  const state = bookStates.get(symbol);
  if (!state) return;

  dbgMetrics.totalResyncs++;
  console.log(`[futures-ob] ${symbol}: resync started`);

  const ATTEMPT_DELAYS_MS = [
    RESYNC_BACKOFF_BASE_MS,
    RESYNC_BACKOFF_BASE_MS * 2,
    RESYNC_BACKOFF_BASE_MS * 4,
  ];

  for (let attempt = 1; attempt <= MAX_FAILED_RESYNCS; attempt++) {
    // Re-check quarantine on each attempt (may have been set externally)
    if (isQuarantined(state)) {
      dbgMetrics.skippedByQuarantine++;
      console.log(`[futures-ob] ${symbol}: resync skipped (quarantine active)`);
      return;
    }

    // Check global IP ban
    if (isGloballyBanned()) {
      dbgMetrics.skippedByGlobalBackoff++;
      const remaining = globalBackoff.until - Date.now();
      console.warn(`[futures-ob] ${symbol}: resync aborted — global IP backoff active (${Math.ceil(remaining / 1000)}s)`);
      // Re-queue after backoff lifts so the symbol eventually resyncs
      const requeDelay = remaining + 500 + Math.floor(Math.random() * 1000);
      setTimeout(() => enqueueResync(symbol), requeDelay);
      resumeQueueAfterBackoff();
      return;
    }

    // Cooldown check
    const msSinceLastSnap = Date.now() - (state.lastSnapshotAt || 0);
    if (attempt === 1 && state.lastSnapshotAt > 0 && msSinceLastSnap < RESYNC_COOLDOWN_MS) {
      dbgMetrics.skippedByCooldown++;
      state.resyncSkippedCooldown++;
      console.log(
        `[futures-ob] ${symbol}: resync skipped — cooldown active` +
        ` (${Math.round(msSinceLastSnap)}ms < ${RESYNC_COOLDOWN_MS}ms)`,
      );
      return;
    }

    const ok = await syncBook(state);
    state.lastResyncAt = Date.now();

    if (ok) {
      state.consecutiveResyncFailures = 0;
      console.log(`[futures-ob] ${symbol}: resync completed`);
      return;
    }

    // Attempt failed
    state.consecutiveResyncFailures++;
    dbgMetrics.totalFailedResyncs++;

    if (attempt < MAX_FAILED_RESYNCS) {
      const delay = ATTEMPT_DELAYS_MS[attempt - 1];
      console.warn(
        `[futures-ob] ${symbol}: resync attempt ${attempt}/${MAX_FAILED_RESYNCS} failed` +
        ` — retrying in ${delay}ms (consecutiveFailures=${state.consecutiveResyncFailures})`,
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // All attempts exhausted → quarantine
  quarantineSymbol(state, 'repeated resync failures');
}

// ─── Binance Futures depth sync (single attempt) ──────────────────
//
// Called exclusively by runResyncJob. Performs exactly ONE REST snapshot
// attempt without an internal retry loop. Returns true on success.
// Rate-limit state is updated on 429/418; caller handles retries.
//
async function syncBook(state) {
  const sym = state.symbol;

  // ── Rate limit backoff guard (per-symbol) ─────────────────────
  const backoffRemaining = state.rateLimitBackoffUntilMs - Date.now();
  if (backoffRemaining > 0) {
    console.warn(
      `[futures-ob] ${sym}: in rate-limit backoff — skipping sync for ${Math.ceil(backoffRemaining / 1000)}s`,
    );
    return false;
  }

  // ── Global IP-level backoff guard ─────────────────────────────
  if (isGloballyBanned()) {
    const globalRemaining = globalBackoff.until - Date.now();
    rateLimitStateStore.incSkipped('futures');
    dbgMetrics.skippedByGlobalBackoff++;
    console.warn(
      `[futures-ob] ${sym}: global IP backoff active — skipping sync for ${Math.ceil(globalRemaining / 1000)}s`,
    );
    return false;
  }

  state.snapshotFetchCount = (state.snapshotFetchCount || 0) + 1;
  dbgMetrics.snapshotRequestsAttempted++;
  const depthUrl = `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${sym}&limit=${SNAPSHOT_LIMIT}`;
  console.log(
    `[futures-ob] ${sym}: fetching REST depth snapshot →` +
    ` ${depthUrl}` +
    ` (fetch#${state.snapshotFetchCount} totalResyncs=${state.resyncCount})`,
  );

  // ── Single REST attempt ────────────────────────────────────────
  let res;
  try {
    const syncReason = state.resyncCount === 0 ? 'initialSync' : `resync#${state.resyncCount}`;
    res = await binanceFetch(
      depthUrl,
      undefined,
      'futuresOrderbookCollector',
      sym,
      syncReason,
    );
  } catch (err) {
    dbgMetrics.snapshotRequestsFailed++;
    state.lastDepthError = { status: null, code: null, msg: err.message, ts: Date.now() };
    console.error(`[futures-ob] ${sym}: REST fetch error — ${err.message}`);
    return false;
  }

  if (res.status === 429 || res.status === 418) {
    const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
    const waitMs        = retryAfterSec > 0 ? retryAfterSec * 1000 : RESYNC_BACKOFF_BASE_MS;
    const boundedWait   = Math.min(waitMs, RESYNC_BACKOFF_MAX_MS);
    state.rateLimitCount = (state.rateLimitCount || 0) + 1;
    state.rateLimitBackoffUntilMs = Date.now() + boundedWait;
    if (res.status === 418) {
      setGlobalBackoff(boundedWait);
      resumeQueueAfterBackoff();
    }
    {
      const rlNow = Date.now();
      const is418 = res.status === 418;
      rateLimitStateStore.patchMarketState('futures', {
        rateLimitCount:        state.rateLimitCount,
        lastRateLimitedSymbol: sym,
        lastRateLimitStatus:   res.status,
        backoffUntilTs:        rlNow + boundedWait,
        backoffDurationMs:     boundedWait,
        lastBackoffSetTs:      rlNow,
        lastBackoffReason:     is418 ? 'HTTP 418 IP ban' : 'HTTP 429 rate limit',
        ...(is418 ? { last418Ts: rlNow } : { last429Ts: rlNow }),
      });
      rateLimitStateStore.persist();
    }
    dbgMetrics.snapshotRequestsFailed++;
    console.error(
      `[futures-ob] ${sym}: Binance rate limit HTTP ${res.status}` +
      ` — waitMs=${boundedWait} rateLimitCount=${state.rateLimitCount}`,
    );
    return false;
  }

  if (res.status === 400) {
    let body = {};
    try { body = await res.json(); } catch (_) {}
    const bnCode = typeof body.code === 'number' ? body.code : null;
    const bnMsg  = body.msg  || '';
    state.lastDepthError = { status: 400, code: bnCode, msg: bnMsg, ts: Date.now() };
    dbgMetrics.snapshotRequestsFailed++;

    if (bnCode === -1121) {
      // Binance error -1121: Invalid symbol — this symbol does not exist on futures.
      // Deactivate immediately and stop reconnect cycle; no retries needed.
      console.warn(
        `[futures-ob] ${sym}: HTTP 400 code=${bnCode} msg="${bnMsg}"` +
        ` — symbol does not exist on futures, deactivating`,
      );
      state.deactivated = true;
      state.ws?.terminate();
      return false;
    }

    // Other 400 — request/config error (wrong limit, missing param, etc.)
    console.warn(
      `[futures-ob] ${sym}: HTTP 400 code=${bnCode} msg="${bnMsg}"` +
      ` — request/config error (check SNAPSHOT_LIMIT=${SNAPSHOT_LIMIT} and URL: ${depthUrl})`,
    );
    return false;
  }

  if (!res.ok) {
    dbgMetrics.snapshotRequestsFailed++;
    state.lastDepthError = { status: res.status, code: null, msg: `HTTP ${res.status}`, ts: Date.now() };
    console.error(`[futures-ob] ${sym}: unexpected HTTP ${res.status} from depth`);
    return false;
  }

  let snapshot;
  try {
    snapshot = await res.json();
  } catch (err) {
    dbgMetrics.snapshotRequestsFailed++;
    state.lastDepthError = { status: res.status, code: null, msg: `JSON parse: ${err.message}`, ts: Date.now() };
    console.error(`[futures-ob] ${sym}: failed to parse snapshot JSON — ${err.message}`);
    return false;
  }

  // Guard: Binance may return HTTP 200 with error body for invalid symbols.
  if (!Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks)) {
    dbgMetrics.snapshotRequestsFailed++;
    const bnCode = typeof snapshot.code === 'number' ? snapshot.code : null;
    const bnMsg  = snapshot.msg || 'missing bids/asks';
    state.lastDepthError = { status: 200, code: bnCode, msg: bnMsg, ts: Date.now() };
    console.warn(
      `[futures-ob] ${sym}: snapshot missing bids/asks — code=${bnCode} msg="${bnMsg}"` +
      ` body=${JSON.stringify(snapshot).slice(0, 120)}`,
    );
    return false;
  }

  const snapId = snapshot.lastUpdateId;
  console.log(
    `[futures-ob] ${sym}: snapshot lastUpdateId=${snapId}` +
    ` bids=${snapshot.bids.length} asks=${snapshot.asks.length}`,
  );

  state.bids.clear();
  state.asks.clear();
  for (const [p, s] of snapshot.bids) {
    const sz = parseFloat(s);
    if (sz > 0) state.bids.set(p, sz);
  }
  for (const [p, s] of snapshot.asks) {
    const sz = parseFloat(s);
    if (sz > 0) state.asks.set(p, sz);
  }
  state.lastUpdateId = snapId;

  let dropped = 0;
  let applied = 0;

  for (const event of state.buffer) {
    if (event.u <= snapId) { dropped++; continue; }

    if (event.U > state.lastUpdateId + 1) {
      console.warn(
        `[futures-ob] ${sym}: sequence gap in buffer` +
        ` (U=${event.U} > lastUpdateId+1=${state.lastUpdateId + 1}), re-queuing resync...`,
      );
      state.buffer = [];
      dbgMetrics.snapshotRequestsFailed++;
      return false;
    }

    applyEvent(state, event);
    applied++;
  }

  state.buffer         = [];
  state.synced         = true;
  state.dirty          = true;
  state.lastSnapshotAt = Date.now();
  state.resyncCount    = (state.resyncCount || 0) + 1;
  dbgMetrics.snapshotRequestsSucceeded++;

  // Clear market-state backoff flag if we succeeded
  if (rateLimitStateStore.getMarketState('futures').backoffUntilTs !== null) {
    const wasBackoffActive = rateLimitStateStore.getMarketState('futures').globalBackoffActive;
    rateLimitStateStore.patchMarketState('futures', { lastSuccessTs: Date.now() });
    rateLimitStateStore.persist();
    if (wasBackoffActive) {
      console.log('[rate-limit-state] backoff cleared market=futures');
    }
  }

  console.log(
    `[futures-ob] ${sym}: synced!` +
    ` dropped=${dropped} applied=${applied}` +
    ` bids=${state.bids.size} asks=${state.asks.size}` +
    ` lastUpdateId=${state.lastUpdateId}`,
  );
  return true;
}

// ─── WS connection per symbol ─────────────────────────────────────
function connectOrderbook(symbol) {
  const state  = getOrCreateBook(symbol);
  if (state.deactivated) return; // symbol removed by watcher — stop reconnect cycle

  // Guard: skip if a WS is already open or connecting to prevent duplicate REST /depth calls
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    console.warn(`[futures-ob] ${symbol}: connectOrderbook skipped — WS already active (readyState=${state.ws.readyState})`);
    return;
  }

  // Do not connect if currently quarantined — wait for quarantine to lift.
  if (isQuarantined(state)) {
    const waitMs = state.quarantineUntil - Date.now();
    console.warn(`[futures-ob] ${symbol}: connection deferred — quarantine active (${Math.ceil(waitMs / 1000)}s remaining)`);
    setTimeout(() => connectOrderbook(symbol), waitMs + 500);
    return;
  }

  // Do not start new connections during global IP ban.
  if (isGloballyBanned()) {
    const waitMs = globalBackoff.until - Date.now();
    const jitter = Math.floor(Math.random() * 2000);
    console.warn(`[futures-ob] ${symbol}: connection deferred — global IP backoff active (${Math.ceil(waitMs / 1000)}s remaining)`);
    setTimeout(() => connectOrderbook(symbol), waitMs + jitter);
    return;
  }

  state.synced = false;
  state.buffer = [];

  const streamName = `${symbol.toLowerCase()}@depth@100ms`;
  const url        = `${BINANCE_WS_BASE}/stream?streams=${streamName}`;

  console.log(`[futures-ob] ${symbol}: connecting WS...`);
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.on('open', () => {
    console.log(`[futures-ob] ${symbol}: WS open — buffering events, queuing initial resync...`);
    // Initial sync goes through the queue to respect concurrency cap and cooldown.
    enqueueResync(symbol);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      const envelope = JSON.parse(raw);
      msg = envelope.data || envelope;
    } catch (err) {
      console.error(`[futures-ob] ${symbol}: JSON parse error:`, err.message);
      return;
    }

    if (!msg || msg.e !== 'depthUpdate') return;

    if (!state.synced) {
      state.buffer.push(msg);
      return;
    }

    if (msg.u <= state.lastUpdateId) return;

    // Live sequence gap detected
    if (msg.U > state.lastUpdateId + 1) {
      const now       = Date.now();
      dbgMetrics.totalSequenceGaps++;

      // Track rapid-gap rate for quarantine trigger
      const gapsInLastMinute = recordGap(state);
      if (gapsInLastMinute >= MAX_GAPS_PER_MINUTE) {
        quarantineSymbol(state, `${gapsInLastMinute} sequence gaps in the last 60s`);
        state.synced = false;
        state.buffer = [];
        ws.terminate();
        return;
      }

      const msSinceLast = now - (state.lastResyncAt || 0);

      // Cooldown guard — drop gap if snapshot cooldown is active
      if (state.lastSnapshotAt > 0 && (now - state.lastSnapshotAt) < RESYNC_COOLDOWN_MS) {
        state.resyncSkippedCooldown++;
        dbgMetrics.skippedByCooldown++;
        console.warn(
          `[futures-ob] ${symbol}: live gap skipped — cooldown active` +
          ` (${Math.round(now - state.lastSnapshotAt)}ms < ${RESYNC_COOLDOWN_MS}ms)` +
          ` skippedTotal=${state.resyncSkippedCooldown}`,
        );
        return;
      }

      state.synced = false;
      state.buffer = [msg];

      console.warn(
        `[futures-ob] ${symbol}: live sequence gap` +
        ` (U=${msg.U} expected=${state.lastUpdateId + 1})` +
        ` gapsThisMinute=${gapsInLastMinute} msSinceLast=${Math.round(msSinceLast)}`,
      );

      enqueueResync(symbol);
      return;
    }

    applyEvent(state, msg);
  });

  ws.on('error', err => {
    console.error(`[futures-ob] ${symbol}: WS error — ${err.message}`);
  });

  ws.on('close', code => {
    if (state.deactivated) return; // removed by watcher — stop reconnect cycle
    if (isQuarantined(state)) {
      const waitMs = state.quarantineUntil - Date.now();
      console.warn(`[futures-ob] ${symbol}: WS closed, reconnect deferred — quarantine (${Math.ceil(waitMs / 1000)}s)`);
      setTimeout(() => connectOrderbook(symbol), waitMs + 500);
      return;
    }
    const perSymBackoff   = Math.max(0, (state.rateLimitBackoffUntilMs || 0) - Date.now());
    const globalRemaining = Math.max(0, globalBackoff.until - Date.now());
    const baseDelay       = Math.max(RECONNECT_DELAY_MS, perSymBackoff, globalRemaining);
    const jitter          = globalRemaining > 0 ? Math.floor(Math.random() * 3000) : 0;
    const reconnectDelay  = baseDelay + jitter;
    if (globalRemaining > 0 || perSymBackoff > 0) {
      console.warn(
        `[futures-ob] ${symbol}: WS closed (code=${code}), reconnecting after backoff in ${Math.ceil(reconnectDelay / 1000)}s...`,
      );
    } else {
      console.warn(`[futures-ob] ${symbol}: WS closed (code=${code}), reconnecting in ${reconnectDelay}ms...`);
    }
    setTimeout(() => connectOrderbook(symbol), reconnectDelay);
  });
}

// ─── Periodic stats logger ────────────────────────────────────────
function startStatsLogger() {
  setInterval(() => {
    const now = Date.now();
    for (const [sym, state] of bookStates.entries()) {
      const inBackoff    = now < state.rateLimitBackoffUntilMs;
      const quarantined  = isQuarantined(state);
      const quarLeftMs   = quarantined ? Math.ceil((state.quarantineUntil - now) / 1000) : 0;
      console.log(
        `[futures-ob:stats] ${sym}:` +
        ` synced=${state.synced}` +
        ` snapshotFetches=${state.snapshotFetchCount}` +
        ` resyncs=${state.resyncCount}` +
        ` skippedCooldown=${state.resyncSkippedCooldown || 0}` +
        ` consecutiveFailures=${state.consecutiveResyncFailures}` +
        ` rateLimits=${state.rateLimitCount || 0}` +
        ` inBackoff=${inBackoff}` +
        (quarantined ? ` QUARANTINED=${quarLeftMs}s` : ''),
      );
    }
    console.log(
      `[futures-ob:stats] queue: active=${activeResyncs.size}/${MAX_CONCURRENT_RESYNCS}` +
      ` queued=${resyncQueue.length}` +
      ` totalGaps=${dbgMetrics.totalSequenceGaps}` +
      ` totalResyncs=${dbgMetrics.totalResyncs}` +
      ` totalFailed=${dbgMetrics.totalFailedResyncs}` +
      ` totalQuarantined=${dbgMetrics.totalQuarantinedSymbols}` +
      ` snapshotOk=${dbgMetrics.snapshotRequestsSucceeded}` +
      ` snapshotFail=${dbgMetrics.snapshotRequestsFailed}`,
    );
  }, STATS_LOG_INTERVAL_MS);
}

// ─── Debug state export ───────────────────────────────────────────
//
// Called by the /api/futures-ob/state backend route.
//
function getDebugState() {
  const now    = Date.now();
  const active = [];
  const quarantined = [];

  for (const [sym, state] of bookStates.entries()) {
    const entry = {
      symbol:                    sym,
      synced:                    state.synced,
      inResyncQueue:             state.inResyncQueue || activeResyncs.has(sym),
      inBackoff:                 now < state.rateLimitBackoffUntilMs,
      snapshotFetches:           state.snapshotFetchCount,
      resyncCount:               state.resyncCount,
      consecutiveResyncFailures: state.consecutiveResyncFailures,
      skippedCooldown:           state.resyncSkippedCooldown,
      rateLimitCount:            state.rateLimitCount,
      gapsLastMinute:            state.gapTimestamps.filter(ts => ts > now - 60_000).length,
      lastSnapshotAt:            state.lastSnapshotAt || null,
      lastResyncAt:              state.lastResyncAt   || null,
      lastDepthError:            state.lastDepthError || null,
    };
    if (isQuarantined(state)) {
      quarantined.push({ ...entry, quarantineUntil: state.quarantineUntil, quarantineRemainingMs: state.quarantineUntil - now });
    } else {
      active.push(entry);
    }
  }

  return {
    config: {
      FUTURES_OB_MAX_SYMBOLS:             MAX_BOOK_SYMBOLS,
      FUTURES_OB_SNAPSHOT_LIMIT:          SNAPSHOT_LIMIT,
      FUTURES_OB_RESYNC_COOLDOWN_MS:      RESYNC_COOLDOWN_MS,
      FUTURES_OB_CONNECT_STAGGER_MS:      STARTUP_STAGGER_MS,
      FUTURES_OB_QUARANTINE_MS:           QUARANTINE_MS,
      FUTURES_OB_MAX_FAILED_RESYNCS:      MAX_FAILED_RESYNCS,
      FUTURES_OB_MAX_GAPS_PER_MINUTE:     MAX_GAPS_PER_MINUTE,
      FUTURES_OB_MAX_CONCURRENT_RESYNCS:  MAX_CONCURRENT_RESYNCS,
    },
    globalBackoff: {
      active:      isGloballyBanned(),
      until:       globalBackoff.until || null,
      remainingMs: isGloballyBanned() ? globalBackoff.until - now : 0,
    },
    queue: {
      activeResyncs:  [...activeResyncs],
      queuedResyncs:  [...resyncQueue],
      activeCount:    activeResyncs.size,
      queuedCount:    resyncQueue.length,
    },
    metrics: { ...dbgMetrics, activeSymbols: bookStates.size },
    symbols: { active, quarantined },
    exchangeInfo: {
      validFuturesSymbolsCount:     validFuturesSymbols.size,
      activeFuturesTrackedSymbols:  [...bookStates.keys()],
      rejectedAtStartupSymbols,
    },
  };
}

// ─── Pending-connection guard ─────────────────────────────────────────────────
const pendingSymbols = new Set();

function startSymbolWatcher(redis) {
  const CHECK_MS    = parseInt(process.env.DENSITY_TRACKED_REFRESH_MS || '15000', 10);
  const ADD_STAGGER = STARTUP_STAGGER_MS; // use same stagger as startup for consistency
  setInterval(async () => {
    try {
      const raw = await redis.get('density:symbols:tracked:futures');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.symbols)) return;

      const trackedSet = new Set(data.symbols);

      // ── Disconnect symbols that left the tracked list ──────────────
      for (const [sym, state] of bookStates.entries()) {
        if (!trackedSet.has(sym)) {
          state.deactivated = true;
          state.ws?.terminate();
          bookStates.delete(sym);
          console.log(`[futures-ob] symbol watcher: disconnecting ${sym} (removed from tracked list)`);
        }
      }

      // ── Add new symbols, respecting hard cap ──────────────────────
      const slotsAvailable = MAX_BOOK_SYMBOLS - bookStates.size - pendingSymbols.size;
      if (slotsAvailable <= 0) return;

      const newSymbols = data.symbols
        .filter(sym => !bookStates.has(sym) && !pendingSymbols.has(sym))
        .filter(sym => validFuturesSymbols.size === 0 || validFuturesSymbols.has(sym))
        .slice(0, slotsAvailable);
      if (newSymbols.length === 0) return;

      console.log(
        `[futures-ob] symbol watcher: queuing ${newSymbols.length} new symbol(s)` +
        ` (staggered by ${ADD_STAGGER}ms each, tracked=${bookStates.size + pendingSymbols.size + newSymbols.length}/${MAX_BOOK_SYMBOLS})...`,
      );

      newSymbols.forEach((sym, i) => {
        pendingSymbols.add(sym);
        setTimeout(() => {
          pendingSymbols.delete(sym);
          console.log(`[futures-ob] symbol watcher: connecting ${sym} (${i + 1}/${newSymbols.length})`);
          connectOrderbook(sym);
        }, i * ADD_STAGGER);
      });
    } catch (err) {
      console.error('[futures-ob] symbol watcher error:', err.message);
    }
  }, CHECK_MS);
}

// ─── Debug state Redis writer ─────────────────────────────────────
//
// Writes a snapshot of getDebugState() to Redis every 30s so the backend
// /api/futures-ob/state endpoint can serve it without talking to the
// collector process directly.
//
const DEBUG_STATE_REDIS_KEY    = 'debug:futures-ob-state';
const DEBUG_STATE_INTERVAL_MS  = 30_000;

function startDebugStateLogger(redis) {
  const write = () => {
    try {
      const state = getDebugState();
      redis.set(DEBUG_STATE_REDIS_KEY, JSON.stringify({ ...state, writtenAt: Date.now() }))
        .catch(err => console.error('[futures-ob] debug-state Redis write error:', err.message));
    } catch (err) {
      console.error('[futures-ob] debug-state build error:', err.message);
    }
  };
  write(); // immediate first write
  setInterval(write, DEBUG_STATE_INTERVAL_MS);
}

async function start(redis) {
  await rateLimitStateStore.initAndRestore(redis, { futures: globalBackoff });

  // Log restored backoff prominently so it's visible in startup output.
  if (isGloballyBanned()) {
    console.log(
      `[futures-ob] restored global IP backoff from Redis — remaining ${Math.ceil((globalBackoff.until - Date.now()) / 1000)}s`,
    );
  }

  // Load exchange info first — builds validFuturesSymbols so we
  // never attempt spot-only symbols against the futures depth endpoint.
  await loadExchangeInfo();

  const rawSymbols = await getWatchlistSymbols(redis);
  let symbols;
  if (validFuturesSymbols.size > 0) {
    symbols = rawSymbols.filter(s => validFuturesSymbols.has(s));
    rejectedAtStartupSymbols = rawSymbols.filter(s => !validFuturesSymbols.has(s));
    if (rejectedAtStartupSymbols.length > 0) {
      console.warn(
        `[futures-ob] ${rejectedAtStartupSymbols.length} symbol(s) not in futures exchangeInfo` +
        ` (spot-only or delisted) — excluded: ${rejectedAtStartupSymbols.join(', ')}`,
      );
    }
  } else {
    console.warn('[futures-ob] validFuturesSymbols empty (exchangeInfo failed?) — using unfiltered list');
    symbols = rawSymbols;
    rejectedAtStartupSymbols = [];
  }

  console.log(`[futures-ob] Starting futures orderbook collector for: ${symbols.join(', ')}`);

  startVolumeRefresh(symbols, redis);
  startStatsLogger();
  startFlushTimer(redis);
  startDebugStateLogger(redis);
  startSymbolWatcher(redis);

  // Stagger initial connections to avoid a burst of simultaneous REST /depth calls.
  // Cap at MAX_BOOK_SYMBOLS (default 10). Each connection fires every STARTUP_STAGGER_MS
  // (default 5s), giving Binance Futures REST room to breathe.
  const startupSymbols = symbols.slice(0, MAX_BOOK_SYMBOLS);
  console.log(
    `[futures-ob] starting with ${startupSymbols.length} symbols` +
    ` (cap=${MAX_BOOK_SYMBOLS}, stagger=${STARTUP_STAGGER_MS}ms)`,
  );
  startupSymbols.forEach((sym, i) => {
    // Mark pending so startSymbolWatcher doesn't double-queue these.
    pendingSymbols.add(sym);
    setTimeout(() => {
      pendingSymbols.delete(sym);
      console.log(`[futures-ob] connecting ${sym} (${i + 1}/${startupSymbols.length})`);
      connectOrderbook(sym);
    }, i * STARTUP_STAGGER_MS);
  });

  // If a global backoff was restored from Redis, kick off the resume watcher.
  if (isGloballyBanned()) resumeQueueAfterBackoff();
}

module.exports = { start, getDebugState };
