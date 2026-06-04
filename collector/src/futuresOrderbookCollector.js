'use strict';

// ─── Futures Orderbook Collector v2 ──────────────────────────────────────────
//
// Per-symbol WebSocket depth stream (fstream.binance.com).
// REST snapshot used only for initial sync and genuine out-of-sequence resyncs.
//
// Anti-ban architecture:
//   - Snapshot requests go through a single-concurrency queue (max 1 concurrent)
//   - Per-symbol step-wise backoff on rate-limit errors
//   - Global IP-level backoff on 418 responses
//   - Circuit breaker: 3+ RL events in 5 minutes triggers SAFE MODE
//
// Wall detection:
//   - futuresWallDetector.scanAndUpdate() runs inside the flush timer (every 2s)
//   - Only "confirmed" walls (present for >= 60s) are written to public Redis key

const WebSocket           = require('ws');
const { binanceFetch }    = require('./binanceRestLogger');
const rateLimitStateStore = require('./shared/binanceRateLimitStateStore');
const wallDetector        = require('./futuresWallDetector');
const { buildAndPersistUniverse } = require('./symbolsUniverseBuilder');

const {
  FUTURES_TRACKED_SYMBOLS_REFRESH_MS,
  TRACKED_UNIVERSE_REFRESH_MS,
  FUTURES_TRACKED_HARD_MAX_SYMBOLS,
  FUTURES_SNAPSHOT_MIN_GAP_MS,
  FUTURES_STARTUP_STAGGER_MS,
  FUTURES_RESYNC_COOLDOWN_MS,
  FUTURES_SNAPSHOT_LIMIT,
  FUTURES_SYMBOL_BACKOFF_BASE_MS,
  FUTURES_SYMBOL_BACKOFF_MAX_MS,
  FUTURES_CIRCUIT_BREAKER_THRESHOLD,
  FUTURES_CIRCUIT_BREAKER_WINDOW_MS,
  FUTURES_SAFE_MODE_EXIT_MS,
  SAFE_MODE_REDIS_KEY,
  FUTURES_ALL_TICKERS_KEY,
  FUTURES_ORDERBOOK_FLUSH_MS,
  FUTURES_TOP_LEVELS,
  FUTURES_WS_STREAMS_PER_CONN,
  FUTURES_WS_OPEN_SNAPSHOT_STAGGER_MS,
  FUTURES_RECONNECT_DELAY_MS,
  FUTURES_STATS_LOG_INTERVAL_MS,
  FUTURES_VOLUME_REFRESH_MS,
} = require('./densityFuturesConfig');

// ─── Constants ─────────────────────────────────────────────────────
const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE   = 'wss://fstream.binance.com';
const MAX_SYNC_RETRIES  = 3;

const MAX_BOOK_SYMBOLS = parseInt(
  process.env.FUTURES_MAX_SYMBOLS || String(FUTURES_TRACKED_HARD_MAX_SYMBOLS),
  10,
);

// ─── Redis key helpers ──────────────────────────────────────────────
const obKey       = sym => `futures:orderbook:${sym}`;
const wallsKey    = sym => `futures:walls:${sym}`;
const wallsIntKey = sym => `futures:walls:internal:${sym}`;

// ─── Global IP-level backoff ────────────────────────────────────────
const globalBackoff = { until: 0 };

function isGloballyBanned() {
  return Date.now() < globalBackoff.until;
}

function setGlobalBackoff(durationMs) {
  const newUntil = Date.now() + durationMs;
  if (newUntil > globalBackoff.until) {
    globalBackoff.until = newUntil;
    console.error(
      `[futures-ob] GLOBAL IP BACKOFF — all depth calls paused for ${Math.ceil(durationMs / 1000)}s` +
      ` (until ${new Date(newUntil).toISOString()})`,
    );
    recordRateLimitEvent();
    enterSafeModeIfThreshold();
  }
}

// ─── Circuit breaker / Safe mode ───────────────────────────────────
const rlEventTimestamps = [];
let _safeModeActive  = false;
let _safeModeEnterTs = 0;
let _redis           = null;

function recordRateLimitEvent() {
  const now    = Date.now();
  rlEventTimestamps.push(now);
  const cutoff = now - FUTURES_CIRCUIT_BREAKER_WINDOW_MS;
  while (rlEventTimestamps.length > 0 && rlEventTimestamps[0] < cutoff) rlEventTimestamps.shift();
}

function enterSafeModeIfThreshold() {
  if (_safeModeActive) return;
  if (rlEventTimestamps.length >= FUTURES_CIRCUIT_BREAKER_THRESHOLD) {
    _safeModeActive  = true;
    _safeModeEnterTs = Date.now();
    console.error(
      `[futures-ob] SAFE MODE ENTERED (${rlEventTimestamps.length} RL events in 5m)` +
      ' — freezing symbol rotation, blocking non-critical resyncs',
    );
    if (_redis) _redis.set(SAFE_MODE_REDIS_KEY, '1').catch(() => {});
    rateLimitStateStore.patchMarketState('futures', { safeModeActive: true });
    rateLimitStateStore.persist();
  }
}

function checkSafeModeExit() {
  if (!_safeModeActive) return;
  const now    = Date.now();
  const cutoff = now - FUTURES_CIRCUIT_BREAKER_WINDOW_MS;
  while (rlEventTimestamps.length > 0 && rlEventTimestamps[0] < cutoff) rlEventTimestamps.shift();
  const lastEvent = rlEventTimestamps.length > 0
    ? rlEventTimestamps[rlEventTimestamps.length - 1]
    : _safeModeEnterTs;
  if (now - lastEvent >= FUTURES_SAFE_MODE_EXIT_MS) {
    _safeModeActive = false;
    console.log('[futures-ob] SAFE MODE EXITED — resuming normal operations');
    if (_redis) _redis.del(SAFE_MODE_REDIS_KEY).catch(() => {});
    rateLimitStateStore.patchMarketState('futures', { safeModeActive: false });
    rateLimitStateStore.persist();
  }
}

function isSafeModeActive() {
  checkSafeModeExit();
  return _safeModeActive;
}

// ─── Snapshot queue (max 1 concurrent, min gap enforced) ───────────
const snapshotQueue = [];
let snapshotRunning = false;
let lastSnapshotAt  = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requestSnapshot(state, critical = false) {
  if (state.syncQueued || state.syncing || state.deactivated) return;
  if (!critical && isSafeModeActive()) {
    console.warn(`[futures-ob] ${state.symbol}: snapshot skipped — safe mode active`);
    rateLimitStateStore.incSkipped('futures');
    return;
  }
  state.syncQueued = true;
  snapshotQueue.push(state);
  if (!snapshotRunning) setImmediate(drainSnapshotQueue);
}

async function drainSnapshotQueue() {
  if (snapshotRunning) return;
  snapshotRunning = true;
  try {
    while (snapshotQueue.length > 0) {
      const state = snapshotQueue.shift();
      state.syncQueued = false;
      if (state.deactivated) continue;

      if (isGloballyBanned()) {
        const waitMs = globalBackoff.until - Date.now() + 500;
        console.warn(`[futures-ob] snapshot queue paused ${Math.ceil(waitMs / 1000)}s (global IP ban)`);
        await sleep(waitMs);
      }

      const gap = Date.now() - lastSnapshotAt;
      if (gap < FUTURES_SNAPSHOT_MIN_GAP_MS) await sleep(FUTURES_SNAPSHOT_MIN_GAP_MS - gap);

      lastSnapshotAt = Date.now();
      const ok = await syncBook(state);
      // With combined-WS transport the socket is shared by many symbols, so a
      // failed snapshot must NOT tear down the connection. Instead re-queue a
      // soft snapshot retry for this symbol once its per-symbol backoff clears.
      if (!ok && !state.deactivated && !state.synced) {
        const retryDelay = Math.max(
          FUTURES_SNAPSHOT_MIN_GAP_MS,
          (state.rateLimitBackoffUntilMs || 0) - Date.now(),
        );
        setTimeout(() => requestSnapshot(state, false), retryDelay);
      }
    }
  } finally {
    snapshotRunning = false;
  }
}

// ─── Per-symbol step-wise backoff ────────────────────────────────────
// Error 1: 30s, Error 2: 60s, Error 3: 120s, Error 4+: 300s
function getSymbolBackoffMs(consecutiveErrors) {
  return Math.min(
    FUTURES_SYMBOL_BACKOFF_BASE_MS * Math.pow(2, Math.min(consecutiveErrors - 1, 30)),
    FUTURES_SYMBOL_BACKOFF_MAX_MS,
  );
}

// ─── Per-symbol book state ──────────────────────────────────────────
const bookStates = new Map();

function getOrCreateBook(symbol) {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids:                    new Map(),
      asks:                    new Map(),
      lastUpdateId:            0,
      synced:                  false,
      syncing:                 false,
      syncQueued:              false,
      buffer:                  [],
      dirty:                   false,
      updatedAt:               0,
      lastResyncAt:            0,
      resyncCount:             0,
      resyncSkippedCooldown:   0,
      snapshotFetchCount:      0,
      consecutiveErrors:       0,
      rateLimitCount:          0,
      rateLimitBackoffUntilMs: 0,
      deactivated:             false,
      poolId:                  null,
    });
  }
  return bookStates.get(symbol);
}

// ─── Book update helpers ────────────────────────────────────────────

function applyLevels(map, levels) {
  for (const [priceStr, sizeStr] of levels) {
    const size = parseFloat(sizeStr);
    if (size === 0) map.delete(priceStr);
    else            map.set(priceStr, size);
  }
}

function applyEvent(state, event) {
  applyLevels(state.bids, event.b);
  applyLevels(state.asks, event.a);
  state.lastUpdateId = event.u;
  state.updatedAt    = event.T || event.E || Date.now();
  state.dirty        = true;
}

// ─── Snapshot builder ───────────────────────────────────────────────

function buildSnapshot(state) {
  const bids = [...state.bids.entries()]
    .map(([p, s]) => { const price = parseFloat(p); return { price, size: s, usdValue: Math.round(price * s * 100) / 100 }; })
    .sort((a, b) => b.price - a.price)
    .slice(0, FUTURES_TOP_LEVELS);

  const asks = [...state.asks.entries()]
    .map(([p, s]) => { const price = parseFloat(p); return { price, size: s, usdValue: Math.round(price * s * 100) / 100 }; })
    .sort((a, b) => a.price - b.price)
    .slice(0, FUTURES_TOP_LEVELS);

  const bestBid  = bids.length > 0 ? bids[0].price : null;
  const bestAsk  = asks.length > 0 ? asks[0].price : null;
  const midPrice = bestBid !== null && bestAsk !== null
    ? parseFloat(((bestBid + bestAsk) / 2).toFixed(8)) : null;

  return { symbol: state.symbol, marketType: 'futures', updatedAt: state.updatedAt || Date.now(), bestBid, bestAsk, midPrice, bids, asks };
}

// ─── 24h ticker refresh → writes futures:tickers:all ───────────────

async function refreshTickers(redis) {
  if (isGloballyBanned()) {
    const rem = Math.ceil((globalBackoff.until - Date.now()) / 1000);
    console.log(`[futures-ob] ticker refresh skipped — global IP backoff (${rem}s remaining)`);
    return;
  }
  try {
    const res = await binanceFetch(`${BINANCE_REST_BASE}/fapi/v1/ticker/24hr`, undefined, 'futuresOrderbookCollector', '*', 'tickerRefresh');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tickers = await res.json();
    await redis.set(FUTURES_ALL_TICKERS_KEY, JSON.stringify(tickers));
    // Feed 24h trade counts into the wall detector so heavily-traded coins can
    // switch into relative-mode wall detection (lower absolute floor).
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        if (t && t.symbol) wallDetector.setSymbolTradeCount(t.symbol, t.count);
      }
    }
    console.log(`[futures-ob] ticker cache written — ${tickers.length} futures symbols`);
  } catch (err) {
    console.error('[futures-ob] ticker refresh failed:', err.message);
  }
}

function startTickerRefresh(redis) {
  const startDelay = Math.max(0, globalBackoff.until - Date.now()) + (globalBackoff.until > 0 ? 2000 : 0);
  setTimeout(() => refreshTickers(redis), startDelay);
  setInterval(() => refreshTickers(redis), FUTURES_VOLUME_REFRESH_MS);
}

// ─── Exchange info → tick sizes ─────────────────────────────────────

async function loadTickSizes() {
  try {
    const res = await binanceFetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`, undefined, 'futuresOrderbookCollector', '*', 'exchangeInfo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    let count = 0;
    for (const sym of info.symbols || []) {
      const pf = (sym.filters || []).find(f => f.filterType === 'PRICE_FILTER');
      if (pf) {
        const ts = parseFloat(pf.tickSize);
        if (isFinite(ts) && ts > 0) { wallDetector.setTickSize(sym.symbol, ts); count++; }
      }
    }
    console.log(`[futures-ob] loaded tick sizes for ${count} symbols`);
  } catch (err) {
    console.error('[futures-ob] loadTickSizes failed (fallback rounding will be used):', err.message);
  }
}

// ─── Orderbook flush + wall scan (every FUTURES_ORDERBOOK_FLUSH_MS) ──

function startFlushTimer(redis) {
  setInterval(() => {
    const now      = Date.now();
    const pipeline = redis.pipeline();
    let   obCount  = 0;

    checkSafeModeExit();

    for (const state of bookStates.values()) {
      // Allow flush even when !synced: the book is consistent right after syncBook
      // completes (dirty=true) — but for high-frequency symbols the live-gap detector
      // can set synced=false within milliseconds, before this timer fires.
      if (!state.dirty || state.syncing) continue;

      const snapshot = buildSnapshot(state);
      pipeline.set(obKey(state.symbol), JSON.stringify(snapshot));
      state.dirty = false;
      obCount++;

      if (snapshot.midPrice !== null) {
        wallDetector.scanAndUpdate(state.symbol, state.bids, state.asks, snapshot.midPrice, now);

        const pubPayload = wallDetector.buildPublicWallsPayload(
          state.symbol, snapshot.midPrice, now, { safeModeActive: _safeModeActive },
        );
        pipeline.set(wallsKey(state.symbol), JSON.stringify(pubPayload));

        const intPayload = wallDetector.buildInternalWallsPayload(state.symbol, snapshot.midPrice, now);
        pipeline.set(wallsIntKey(state.symbol), JSON.stringify(intPayload), 'EX', 300);

        // ── v3 density analytics keys ───────────────────────────────
        // density:wallStats:{symbol}  — per-side orderbook statistics + adaptive threshold
        const statsPayload = wallDetector.buildWallStatsPayload(state.symbol);
        if (statsPayload) {
          pipeline.set(`density:wallStats:${state.symbol}`, JSON.stringify(statsPayload), 'EX', 300);
        }
        // density:bestWall:{symbol}  — best (highest wallPower) confirmed wall
        const bestWallPayload = wallDetector.buildBestWallPayload(state.symbol, snapshot.midPrice, now);
        if (bestWallPayload) {
          pipeline.set(`density:bestWall:${state.symbol}`, JSON.stringify(bestWallPayload), 'EX', 300);
        } else {
          pipeline.del(`density:bestWall:${state.symbol}`);
        }

        // ── Wall lifecycle events → Redis sorted set ────────────────
        // density:wall-events:futures:{symbol}  score=ts  member=JSON
        // Trimmed to last 24 h so the set stays bounded.
        const events = wallDetector.getAndClearPendingEvents(state.symbol);
        if (events.length > 0) {
          const evKey = `density:wall-events:futures:${state.symbol}`;
          const cutoff = now - 24 * 60 * 60 * 1000;
          // zadd score member [score member …]
          const zaddArgs = [evKey];
          for (const ev of events) zaddArgs.push(ev.ts, JSON.stringify(ev));
          pipeline.zadd(...zaddArgs);
          // Remove events older than 24 h
          pipeline.zremrangebyscore(evKey, '-inf', cutoff);
          // Soft TTL so the key expires if no events arrive for 2 days
          pipeline.expire(evKey, 2 * 24 * 60 * 60);
        }
      }
    }

    if (obCount > 0) pipeline.exec().catch(err => console.error('[futures-ob] Redis flush error:', err.message));
  }, FUTURES_ORDERBOOK_FLUSH_MS);
}

// ─── syncBook ──────────────────────────────────────────────────────

async function syncBook(state) {
  const sym = state.symbol;

  if (state.syncing) { console.warn(`[futures-ob] ${sym}: syncBook already in progress, skipping`); return false; }
  state.syncing = true;
  state.snapshotFetchCount = (state.snapshotFetchCount || 0) + 1;

  const perSymBackoff = state.rateLimitBackoffUntilMs - Date.now();
  if (perSymBackoff > 0) {
    state.syncing = false;
    console.warn(`[futures-ob] ${sym}: per-symbol backoff — skipping for ${Math.ceil(perSymBackoff / 1000)}s`);
    return false;
  }

  if (isGloballyBanned()) {
    const rem = globalBackoff.until - Date.now();
    state.syncing = false;
    rateLimitStateStore.incSkipped('futures');
    console.warn(`[futures-ob] ${sym}: global IP backoff — skipping for ${Math.ceil(rem / 1000)}s`);
    return false;
  }

  console.log(`[futures-ob] ${sym}: fetching REST depth snapshot (limit=${FUTURES_SNAPSHOT_LIMIT} fetch#${state.snapshotFetchCount} resyncs=${state.resyncCount})`);

  try {
    let snapshot;
    let attempt = 0;

    while (attempt < MAX_SYNC_RETRIES) {
      attempt++;
      try {
        const reason = state.resyncCount === 0 ? 'initialSync' : `resync#${state.resyncCount}`;
        const res = await binanceFetch(
          `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${sym}&limit=${FUTURES_SNAPSHOT_LIMIT}`,
          undefined, 'futuresOrderbookCollector', sym, reason,
        );

        if (res.status === 429 || res.status === 418) {
          const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
          const is418 = res.status === 418;
          state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
          state.rateLimitCount    = (state.rateLimitCount    || 0) + 1;

          const backoffMs = is418
            ? Math.max(retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000, FUTURES_SYMBOL_BACKOFF_MAX_MS)
            : Math.max(retryAfterSec > 0 ? retryAfterSec * 1000 : 0, getSymbolBackoffMs(state.consecutiveErrors));

          state.rateLimitBackoffUntilMs = Date.now() + backoffMs;
          if (is418) setGlobalBackoff(backoffMs);
          recordRateLimitEvent();
          enterSafeModeIfThreshold();

          const tsNow = Date.now();
          rateLimitStateStore.patchMarketState('futures', {
            rateLimitCount: state.rateLimitCount, lastRateLimitedSymbol: sym,
            lastRateLimitStatus: res.status, backoffUntilTs: tsNow + backoffMs,
            backoffDurationMs: backoffMs, lastBackoffSetTs: tsNow,
            lastBackoffReason: is418 ? 'HTTP 418 IP ban' : 'HTTP 429 rate limit',
            ...(is418 ? { last418Ts: tsNow } : { last429Ts: tsNow }),
          });
          rateLimitStateStore.persist();
          console.error(`[futures-ob] ${sym}: rate limit HTTP ${res.status} — per-symbol backoff ${Math.ceil(backoffMs / 1000)}s (error #${state.consecutiveErrors})`);
          return false;
        }

        if (res.status === 400) {
          console.warn(`[futures-ob] ${sym}: HTTP 400 — symbol not on futures, deactivating`);
          state.deactivated = true;
          return false;
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        snapshot = await res.json();
        state.consecutiveErrors = 0;
        break;

      } catch (err) {
        if (attempt >= MAX_SYNC_RETRIES) {
          console.error(`[futures-ob] ${sym}: REST snapshot failed after ${MAX_SYNC_RETRIES} attempts — ${err.message}`);
          return false;
        }
        const retryMs = getSymbolBackoffMs(attempt);
        console.warn(`[futures-ob] ${sym}: snapshot attempt ${attempt} error (${err.message}), retrying in ${retryMs}ms...`);
        await sleep(retryMs);
      }
    }

    if (!snapshot) return false;

    if (!Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks)) {
      console.error(`[futures-ob] ${sym}: invalid snapshot structure — missing or non-array bids/asks`);
      state.syncing = false;
      return false;
    }

    const snapId = snapshot.lastUpdateId;
    console.log(`[futures-ob] ${sym}: snapshot id=${snapId} bids=${snapshot.bids.length} asks=${snapshot.asks.length}`);

    // Merge snapshot into existing state instead of clearing.
    // This preserves levels accumulated via WS diffs that fall OUTSIDE the snapshot's
    // price range (e.g. a large ask 1200 levels away from bestAsk that exceeds
    // the 1000-level REST limit but is present in the WS stream).
    //
    // Strategy:
    //   1. Delete all levels that are within the snapshot's covered price range
    //      (these are now replaced by the authoritative snapshot data).
    //   2. Apply snapshot levels — includes 0-size tombstones to remove stale levels.
    //   3. Keep any levels outside the snapshot range unchanged.
    if (snapshot.bids.length > 0 || snapshot.asks.length > 0) {
      // Determine covered ranges from snapshot
      const bidPrices = snapshot.bids.map(([p]) => parseFloat(p));
      const askPrices = snapshot.asks.map(([p]) => parseFloat(p));
      const snapBidLo  = bidPrices.length ? Math.min(...bidPrices) : null;
      const snapBidHi  = bidPrices.length ? Math.max(...bidPrices) : null;
      const snapAskLo  = askPrices.length ? Math.min(...askPrices) : null;
      const snapAskHi  = askPrices.length ? Math.max(...askPrices) : null;

      // Remove stale bid levels within AND above snapshot range.
      // Levels above snapBidHi are ghost bids from before a price drop — they must be purged.
      // Levels below snapBidLo (far-away walls) are intentionally preserved.
      if (snapBidLo !== null) {
        for (const [p] of state.bids) {
          const pf = parseFloat(p);
          if (pf >= snapBidLo) state.bids.delete(p);
        }
      }
      // Remove stale ask levels within AND below snapshot range.
      // Levels below snapAskLo are ghost asks from before a price rise — must be purged.
      // Levels above snapAskHi (far-away walls) are intentionally preserved.
      if (snapAskLo !== null) {
        for (const [p] of state.asks) {
          const pf = parseFloat(p);
          if (pf <= snapAskHi) state.asks.delete(p);
        }
      }
    } else {
      // Empty snapshot — full clear as fallback
      state.bids.clear();
      state.asks.clear();
    }

    for (const [p, s] of snapshot.bids) { const sz = parseFloat(s); if (sz > 0) state.bids.set(p, sz); }
    for (const [p, s] of snapshot.asks) { const sz = parseFloat(s); if (sz > 0) state.asks.set(p, sz); }
    state.lastUpdateId = snapId;

    // Futures (USD-M) order-book reconciliation rules (differ from Spot!):
    //   1. Drop any buffered event whose final id `u` is < snapshot id.
    //   2. The FIRST processed event must straddle the snapshot id: U <= snapId <= u.
    //   3. Every subsequent event must chain via `pu` (previous final id):
    //      event.pu === lastUpdateId, otherwise there is a real gap → resync.
    let dropped = 0, applied = 0;
    let firstApplied = false;
    for (const event of state.buffer) {
      if (event.u < snapId) { dropped++; continue; }
      if (!firstApplied) {
        if (event.U > snapId) {
          console.warn(`[futures-ob] ${sym}: no buffered event straddles snapshot id (U=${event.U} > snapId=${snapId}), resyncing...`);
          state.buffer = [];
          return false;
        }
        applyEvent(state, event);
        firstApplied = true;
        applied++;
        continue;
      }
      if (event.pu !== undefined && event.pu !== state.lastUpdateId) {
        console.warn(`[futures-ob] ${sym}: sequence gap in buffer (pu=${event.pu} != lastUpdateId=${state.lastUpdateId}), resyncing...`);
        state.buffer = [];
        return false;
      }
      applyEvent(state, event);
      applied++;
    }

    state.buffer = [];
    state.synced = true;
    state.dirty  = true;

    if (rateLimitStateStore.getMarketState('futures').backoffUntilTs !== null) {
      rateLimitStateStore.patchMarketState('futures', { lastSuccessTs: Date.now() });
      rateLimitStateStore.persist();
    }

    console.log(`[futures-ob] ${sym}: synced! dropped=${dropped} applied=${applied} bids=${state.bids.size} asks=${state.asks.size}`);

    // Immediately write orderbook to Redis without waiting for flush timer.
    // For high-frequency symbols (TAO, RIVER) a live-gap fires within ~5ms of this
    // return, setting synced=false before the 2s flush timer fires — causing the
    // symbol to be permanently skipped. Flushing here guarantees a fresh write.
    if (_redis) {
      const snap = buildSnapshot(state);
      const now  = Date.now();
      const pipe = _redis.pipeline();
      pipe.set(obKey(sym), JSON.stringify(snap));
      if (snap.midPrice !== null) {
        wallDetector.scanAndUpdate(sym, state.bids, state.asks, snap.midPrice, now);
        pipe.set(wallsKey(sym), JSON.stringify(
          wallDetector.buildPublicWallsPayload(sym, snap.midPrice, now, { safeModeActive: _safeModeActive }),
        ));
        pipe.set(wallsIntKey(sym), JSON.stringify(
          wallDetector.buildInternalWallsPayload(sym, snap.midPrice, now),
        ), 'EX', 300);
      }
      pipe.exec().catch(err => console.error(`[futures-ob] ${sym}: immediate flush error:`, err.message));
      state.dirty = false;
    }

    return true;

  } finally {
    state.syncing = false;
  }
}

// ─── Combined-WS connection pools ──────────────────────────────────
//
// Depth streams for many symbols are multiplexed onto a small number of
// combined WebSocket connections (wss://fstream.binance.com/stream). Each pool
// holds up to FUTURES_WS_STREAMS_PER_CONN symbols and uses Binance's
// SUBSCRIBE / UNSUBSCRIBE control frames to add/remove symbols without opening
// a new socket. This minimises TCP/WS handshakes (a key ban-risk signal) and
// lets us track far more symbols safely.
//
// pool = {
//   id, ws, ready, deactivated,
//   symbols: Set<string>,   // symbols assigned to this pool (UPPERCASE)
//   reqId,                  // monotonic id for SUBSCRIBE/UNSUBSCRIBE frames
// }
const wsPools = [];
let _poolSeq  = 0;

const streamName = sym => `${sym.toLowerCase()}@depth@100ms`;

function getBookBySymbol(sym) {
  return bookStates.get(sym) || null;
}

// Shared depth-message handler — routes by the depthUpdate `s` (symbol) field.
function handleDepthMessage(msg) {
  if (!msg || msg.e !== 'depthUpdate') return;
  const sym = (msg.s || '').toUpperCase();
  if (!sym) return;
  const state = getBookBySymbol(sym);
  if (!state || state.deactivated) return;

  if (!state.synced) {
    state.buffer.push(msg);
    // Apply speculatively while waiting for resync so Redis stays fresh.
    if (!state.syncing) applyEvent(state, msg);
    return;
  }
  if (msg.u <= state.lastUpdateId) return;

  // Futures continuity check: each live event's `pu` (previous final update id)
  // must equal the last applied `u`. Spot's `U === lastUpdateId + 1` rule does
  // NOT hold for USD-M futures and produced constant false gaps → endless resync.
  if (msg.pu !== undefined && msg.pu !== state.lastUpdateId) {
    const now         = Date.now();
    const msSinceLast = now - (state.lastResyncAt || 0);

    if (msSinceLast < FUTURES_RESYNC_COOLDOWN_MS && state.lastResyncAt !== 0) {
      state.resyncSkippedCooldown = (state.resyncSkippedCooldown || 0) + 1;
      // Apply speculatively despite the gap so the book stays live; a periodic
      // full resync (after cooldown) reconciles any drift.
      applyEvent(state, msg);
      return;
    }

    state.resyncCount  = (state.resyncCount || 0) + 1;
    state.synced       = false;
    state.buffer       = [msg];
    state.lastResyncAt = now;

    const delay = Math.max(0, FUTURES_RESYNC_COOLDOWN_MS - msSinceLast);
    console.warn(`[futures-ob] ${sym}: live gap (pu=${msg.pu} expected=${state.lastUpdateId}) resync#${state.resyncCount} in ${delay}ms`);
    setTimeout(() => requestSnapshot(state, false), delay);
    return;
  }

  applyEvent(state, msg);
}

// Send a SUBSCRIBE / UNSUBSCRIBE control frame for one stream on an open pool.
function sendPoolControl(pool, method, sym) {
  if (!pool.ws || pool.ws.readyState !== WebSocket.OPEN) return;
  try {
    pool.ws.send(JSON.stringify({
      method,
      params: [streamName(sym)],
      id:     ++pool.reqId,
    }));
  } catch (err) {
    console.error(`[futures-ob] pool#${pool.id}: ${method} ${sym} send failed — ${err.message}`);
  }
}

// Trigger a (staggered) REST snapshot for one symbol, marking it for re-sync.
function snapshotSymbol(state, staggerIndex = 0) {
  if (!state || state.deactivated) return;
  state.synced = false;
  state.buffer = [];
  const delay = staggerIndex * FUTURES_WS_OPEN_SNAPSHOT_STAGGER_MS;
  if (delay <= 0) requestSnapshot(state, true);
  else setTimeout(() => requestSnapshot(state, true), delay);
}

function connectPool(pool) {
  if (pool.deactivated) return;

  const url = `${BINANCE_WS_BASE}/stream`;
  console.log(`[futures-ob] pool#${pool.id}: connecting combined WS (${pool.symbols.size} streams)...`);
  const ws = new WebSocket(url);
  pool.ws    = ws;
  pool.ready = false;

  ws.on('open', () => {
    pool.ready = true;
    const syms = [...pool.symbols];
    console.log(`[futures-ob] pool#${pool.id}: WS open — subscribing ${syms.length} streams`);
    // Subscribe to all assigned streams in one (or chunked) control frame.
    if (syms.length > 0) {
      try {
        ws.send(JSON.stringify({
          method: 'SUBSCRIBE',
          params: syms.map(streamName),
          id:     ++pool.reqId,
        }));
      } catch (err) {
        console.error(`[futures-ob] pool#${pool.id}: bulk SUBSCRIBE failed — ${err.message}`);
      }
    }
    // Request a REST snapshot per symbol, staggered to avoid a burst.
    syms.forEach((sym, i) => snapshotSymbol(getOrCreateBook(sym), i));
  });

  ws.on('message', (raw) => {
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch (err) { console.error(`[futures-ob] pool#${pool.id}: JSON parse error: ${err.message}`); return; }
    // Combined-stream envelope: { stream, data }. Control replies: { result, id }.
    const msg = envelope.data || envelope;
    if (!msg || msg.e !== 'depthUpdate') return;
    handleDepthMessage(msg);
  });

  ws.on('error', err => console.error(`[futures-ob] pool#${pool.id}: WS error — ${err.message}`));

  ws.on('close', code => {
    pool.ready = false;
    if (pool.deactivated) return;
    if (pool.symbols.size === 0) { removePool(pool); return; }
    const globalRemaining = Math.max(0, globalBackoff.until - Date.now());
    const baseDelay       = Math.max(FUTURES_RECONNECT_DELAY_MS, globalRemaining);
    const jitter          = Math.floor(Math.random() * 3000);
    const reconnectDelay  = baseDelay + jitter;
    console.warn(`[futures-ob] pool#${pool.id}: WS closed (code=${code}, ${pool.symbols.size} streams), reconnecting in ${Math.ceil(reconnectDelay / 1000)}s...`);
    setTimeout(() => { if (!pool.deactivated) connectPool(pool); }, reconnectDelay);
  });
}

function createPool() {
  const pool = {
    id:          ++_poolSeq,
    ws:          null,
    ready:       false,
    deactivated: false,
    symbols:     new Set(),
    reqId:       0,
  };
  wsPools.push(pool);
  return pool;
}

function removePool(pool) {
  pool.deactivated = true;
  try { pool.ws?.terminate(); } catch (_) {}
  const idx = wsPools.indexOf(pool);
  if (idx !== -1) wsPools.splice(idx, 1);
}

// Find a pool with a free slot, or create one.
function getAvailablePool() {
  for (const pool of wsPools) {
    if (!pool.deactivated && pool.symbols.size < FUTURES_WS_STREAMS_PER_CONN) return pool;
  }
  const pool = createPool();
  connectPool(pool);
  return pool;
}

// Add a symbol: assign to a pool, subscribe (if pool open), snapshot.
function addSymbol(symbol) {
  const sym   = symbol.toUpperCase();
  const state = getOrCreateBook(sym);
  if (state.poolId) return; // already assigned
  state.deactivated = false;

  const pool = getAvailablePool();
  pool.symbols.add(sym);
  state.poolId = pool.id;

  // If the pool socket is already open, subscribe + snapshot immediately.
  // Otherwise the pool's 'open' handler will subscribe + snapshot all symbols.
  if (pool.ready && pool.ws && pool.ws.readyState === WebSocket.OPEN) {
    console.log(`[futures-ob] pool#${pool.id}: adding ${sym}`);
    sendPoolControl(pool, 'SUBSCRIBE', sym);
    snapshotSymbol(state, 0);
  }
}

// Remove a symbol: unsubscribe, drop state, free the slot.
function removeSymbol(symbol) {
  const sym   = symbol.toUpperCase();
  const state = bookStates.get(sym);
  if (!state) return;
  state.deactivated = true;

  const pool = wsPools.find(p => p.id === state.poolId);
  if (pool) {
    sendPoolControl(pool, 'UNSUBSCRIBE', sym);
    pool.symbols.delete(sym);
    // Tear down empty pools to avoid idle sockets.
    if (pool.symbols.size === 0) removePool(pool);
  }
  bookStates.delete(sym);
  wallDetector.clearSymbol(sym);
}

// ─── Universe builder timer ─────────────────────────────────────────────────
// Runs symbolsUniverseBuilder on a repeating interval so the tracked universe
// is always fresh. Runs immediately on startup (after tickers are available).

function startUniverseBuilder(redis) {
  // Build immediately, then on TRACKED_UNIVERSE_REFRESH_MS interval. The
  // builder fetches Binance REST + Redis pipelines and can outlive the next
  // tick under load \u2014 the `_building` guard prevents overlapping runs from
  // doubling the REST burst rate.
  let _building = false;
  const run = async () => {
    if (_building) {
      console.warn('[futures-ob] universe build still in flight \u2014 skipping this tick');
      return;
    }
    _building = true;
    try {
      await buildAndPersistUniverse(redis);
    } catch (err) {
      console.error('[futures-ob] universe build error (non-fatal):', err.message);
    } finally {
      _building = false;
    }
  };
  run();
  setInterval(run, TRACKED_UNIVERSE_REFRESH_MS);
}

// ─── Watchlist loader ───────────────────────────────────────────────

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
  const raw = process.env.FUTURES_ORDERBOOK_SYMBOLS || process.env.ORDERBOOK_SYMBOLS || 'BTCUSDT';
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

// ─── Symbol watcher ─────────────────────────────────────────────────
// Reads density:symbols:tracked:futures every FUTURES_TRACKED_SYMBOLS_REFRESH_MS
// and starts/stops WS connections. Blocked during SAFE MODE.

const pendingSymbols = new Set();

function startSymbolWatcher(redis) {
  setInterval(async () => {
    if (isSafeModeActive()) { console.log('[futures-ob] symbol watcher: safe mode — skipping rotation'); return; }

    try {
      const raw = await redis.get('density:symbols:tracked:futures');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.symbols)) return;

      const trackedSet = new Set(data.symbols);

      for (const [sym] of bookStates.entries()) {
        if (!trackedSet.has(sym)) {
          console.log(`[futures-ob] symbol watcher: disconnecting ${sym}`);
          removeSymbol(sym);
        }
      }

      const slotsAvailable = MAX_BOOK_SYMBOLS - bookStates.size - pendingSymbols.size;
      if (slotsAvailable <= 0) return;

      const newSymbols = data.symbols
        .filter(sym => !bookStates.has(sym) && !pendingSymbols.has(sym))
        .slice(0, slotsAvailable);
      if (newSymbols.length === 0) return;

      console.log(`[futures-ob] symbol watcher: queuing ${newSymbols.length} new symbol(s) (stagger=${FUTURES_STARTUP_STAGGER_MS}ms, total=${bookStates.size + pendingSymbols.size + newSymbols.length}/${MAX_BOOK_SYMBOLS}, pools=${wsPools.length})`);

      newSymbols.forEach((sym, i) => {
        pendingSymbols.add(sym);
        setTimeout(() => {
          pendingSymbols.delete(sym);
          if (!isSafeModeActive()) { console.log(`[futures-ob] symbol watcher: connecting ${sym}`); addSymbol(sym); }
        }, i * FUTURES_STARTUP_STAGGER_MS);
      });

    } catch (err) { console.error('[futures-ob] symbol watcher error:', err.message); }
  }, FUTURES_TRACKED_SYMBOLS_REFRESH_MS);
}

// ─── Stats logger ───────────────────────────────────────────────────

function startStatsLogger() {
  setInterval(() => {
    const confirmedWalls   = [...bookStates.keys()].reduce((n, s) => n + wallDetector.getConfirmedWalls(s).length, 0);
    const candidateWalls   = [...bookStates.keys()].reduce((n, s) => n + wallDetector.getCandidates(s).length, 0);
    const wsConnectedCount = [...bookStates.values()].filter(s => s.synced).length;
    console.log(
      `[futures-ob:stats] tracked=${bookStates.size}/${MAX_BOOK_SYMBOLS}` +
      ` pools=${wsPools.length} wsConnected=${wsConnectedCount} confirmedWalls=${confirmedWalls} candidateWalls=${candidateWalls}` +
      ` safeMode=${_safeModeActive} snapshotQueueLen=${snapshotQueue.length} rlEvents5m=${rlEventTimestamps.length}`,
    );
    for (const [sym, state] of bookStates.entries()) {
      console.log(
        `[futures-ob:stats] ${sym}: synced=${state.synced} snaps=${state.snapshotFetchCount}` +
        ` resyncs=${state.resyncCount} errors=${state.consecutiveErrors} rl=${state.rateLimitCount}` +
        ` inBackoff=${Date.now() < state.rateLimitBackoffUntilMs}`,
      );
    }
  }, FUTURES_STATS_LOG_INTERVAL_MS);
}

// ─── restoreWallsFromRedis ──────────────────────────────────────────

/**
 * On startup, read persisted confirmed walls from Redis and restore them
 * into the wall detector so a collector restart doesn't lose confirmed state.
 */
async function restoreWallsFromRedis(redis, symbols) {
  if (!symbols || symbols.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const sym of symbols) {
      pipeline.get(`futures:walls:${sym}`);          // public key (confirmed walls)
      pipeline.get(`futures:walls:internal:${sym}`); // internal key (droppedRecent)
    }
    const results = await pipeline.exec();
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const [pubErr, pubRaw]  = results[i * 2];
      const [intErr, intRaw]  = results[i * 2 + 1];

      if (!pubErr && pubRaw) {
        try { wallDetector.restoreConfirmedWalls(sym, JSON.parse(pubRaw)); } catch (_) {}
      }
      if (!intErr && intRaw) {
        try { wallDetector.restorePresenceMemory(sym, JSON.parse(intRaw)); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[futures-ob] restoreWallsFromRedis error (non-fatal):', err.message);
  }
}

// ─── start ──────────────────────────────────────────────────────────

async function start(redis) {
  _redis = redis;

  await rateLimitStateStore.initAndRestore(redis, { futures: globalBackoff });

  if (isGloballyBanned()) {
    console.log(`[futures-ob] restored global IP backoff — remaining ${Math.ceil((globalBackoff.until - Date.now()) / 1000)}s`);
  }

  // Reconcile any stale safe-mode flag in Redis with our actual (fresh) state.
  // checkSafeModeExit() only clears the flag while _safeModeActive is true, so a
  // crash/restart that happened while the flag was '1' would leave it stuck —
  // which makes the backend's dynamicTrackedSymbolsManager skip tracked-list
  // rotation forever (frozen universe → new big-wall coins never get collected).
  // On a fresh boot _safeModeActive is false, so clear the persisted flag to match.
  if (!_safeModeActive) {
    redis.del(SAFE_MODE_REDIS_KEY)
      .then(n => { if (n > 0) console.log('[futures-ob] cleared stale density:futures:safe-mode flag on startup'); })
      .catch(() => {});
  }

  loadTickSizes().catch(err => console.error('[futures-ob] loadTickSizes error (non-fatal):', err.message));

  const symbols = await getWatchlistSymbols(redis);
  console.log(`[futures-ob] Starting futures orderbook collector for: ${symbols.join(', ')}`);

  startTickerRefresh(redis);
  startStatsLogger();
  startFlushTimer(redis);
  startSymbolWatcher(redis);
  startUniverseBuilder(redis);

  // Restore confirmed walls from Redis before connecting — prevents losing confirmed state on restart
  await restoreWallsFromRedis(redis, symbols);

  const startupSymbols = symbols.slice(0, MAX_BOOK_SYMBOLS);
  const poolCount = Math.ceil(startupSymbols.length / FUTURES_WS_STREAMS_PER_CONN) || 0;
  console.log(`[futures-ob] connecting ${startupSymbols.length}/${symbols.length} symbols across ~${poolCount} combined WS pool(s) (cap=${MAX_BOOK_SYMBOLS}, streamsPerConn=${FUTURES_WS_STREAMS_PER_CONN})...`);
  // Assign symbols to pools. getAvailablePool() opens a pool socket once it is
  // first needed; each pool subscribes + REST-snapshots its symbols (staggered)
  // in its own 'open' handler, so no per-symbol connect stagger is needed here.
  for (const sym of startupSymbols) addSymbol(sym);
}

module.exports = { start };