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
      if (!ok && !state.deactivated) state.ws?.terminate();
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
      ws:                      null,
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

    let dropped = 0, applied = 0;
    for (const event of state.buffer) {
      if (event.u <= snapId) { dropped++; continue; }
      if (event.U > state.lastUpdateId + 1) {
        console.warn(`[futures-ob] ${sym}: sequence gap in buffer (U=${event.U} > lastUpdateId+1=${state.lastUpdateId + 1}), resyncing...`);
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

// ─── WebSocket connection per symbol ───────────────────────────────

function connectOrderbook(symbol) {
  const state = getOrCreateBook(symbol);
  if (state.deactivated) return;

  state.synced = false;
  state.buffer = [];

  const url = `${BINANCE_WS_BASE}/stream?streams=${symbol.toLowerCase()}@depth@100ms`;
  console.log(`[futures-ob] ${symbol}: connecting WS...`);
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.on('open', () => {
    console.log(`[futures-ob] ${symbol}: WS open — buffering events, requesting REST snapshot...`);
    requestSnapshot(state, true);
  });

  ws.on('message', (raw) => {
    let msg;
    try { const e = JSON.parse(raw); msg = e.data || e; }
    catch (err) { console.error(`[futures-ob] ${symbol}: JSON parse error:`, err.message); return; }

    if (!msg || msg.e !== 'depthUpdate') return;

    if (!state.synced) { state.buffer.push(msg); return; }
    if (msg.u <= state.lastUpdateId) return;

    if (msg.U > state.lastUpdateId + 1) {
      const now         = Date.now();
      const msSinceLast = now - (state.lastResyncAt || 0);

      if (msSinceLast < FUTURES_RESYNC_COOLDOWN_MS && state.lastResyncAt !== 0) {
        state.resyncSkippedCooldown = (state.resyncSkippedCooldown || 0) + 1;
        console.warn(`[futures-ob] ${symbol}: live gap skipped — cooldown (${Math.round(msSinceLast)}ms < ${FUTURES_RESYNC_COOLDOWN_MS}ms) skipped=${state.resyncSkippedCooldown}`);
        return;
      }

      state.resyncCount = (state.resyncCount || 0) + 1;
      state.synced      = false;
      state.buffer      = [msg];
      state.lastResyncAt = now;

      const delay = Math.max(0, FUTURES_RESYNC_COOLDOWN_MS - msSinceLast);
      console.warn(`[futures-ob] ${symbol}: live gap (U=${msg.U} expected=${state.lastUpdateId + 1}) resync#${state.resyncCount} in ${delay}ms`);
      setTimeout(() => requestSnapshot(state, false), delay);
      return;
    }

    applyEvent(state, msg);
  });

  ws.on('error', err => console.error(`[futures-ob] ${symbol}: WS error — ${err.message}`));

  ws.on('close', code => {
    if (state.deactivated) return;
    const perSymBackoff   = Math.max(0, (state.rateLimitBackoffUntilMs || 0) - Date.now());
    const globalRemaining = Math.max(0, globalBackoff.until - Date.now());
    const baseDelay       = Math.max(FUTURES_RECONNECT_DELAY_MS, perSymBackoff, globalRemaining);
    const jitter          = globalRemaining > 0 ? Math.floor(Math.random() * 3000) : 0;
    const reconnectDelay  = baseDelay + jitter;
    console.warn(`[futures-ob] ${symbol}: WS closed (code=${code}), reconnecting in ${Math.ceil(reconnectDelay / 1000)}s...`);
    setTimeout(() => connectOrderbook(symbol), reconnectDelay);
  });
}

// ─── Universe builder timer ─────────────────────────────────────────────────
// Runs symbolsUniverseBuilder on a repeating interval so the tracked universe
// is always fresh. Runs immediately on startup (after tickers are available).

function startUniverseBuilder(redis) {
  // Build immediately, then on TRACKED_UNIVERSE_REFRESH_MS interval
  const run = () => buildAndPersistUniverse(redis).catch(err =>
    console.error('[futures-ob] universe build error (non-fatal):', err.message),
  );
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

      for (const [sym, state] of bookStates.entries()) {
        if (!trackedSet.has(sym)) {
          state.deactivated = true;
          state.ws?.terminate();
          bookStates.delete(sym);
          wallDetector.clearSymbol(sym);
          console.log(`[futures-ob] symbol watcher: disconnecting ${sym}`);
        }
      }

      const slotsAvailable = MAX_BOOK_SYMBOLS - bookStates.size - pendingSymbols.size;
      if (slotsAvailable <= 0) return;

      const newSymbols = data.symbols
        .filter(sym => !bookStates.has(sym) && !pendingSymbols.has(sym))
        .slice(0, slotsAvailable);
      if (newSymbols.length === 0) return;

      console.log(`[futures-ob] symbol watcher: queuing ${newSymbols.length} new symbol(s) (stagger=${FUTURES_STARTUP_STAGGER_MS}ms, total=${bookStates.size + pendingSymbols.size + newSymbols.length}/${MAX_BOOK_SYMBOLS})`);

      newSymbols.forEach((sym, i) => {
        pendingSymbols.add(sym);
        setTimeout(() => {
          pendingSymbols.delete(sym);
          if (!isSafeModeActive()) { console.log(`[futures-ob] symbol watcher: connecting ${sym}`); connectOrderbook(sym); }
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
      ` wsConnected=${wsConnectedCount} confirmedWalls=${confirmedWalls} candidateWalls=${candidateWalls}` +
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
  console.log(`[futures-ob] connecting ${startupSymbols.length}/${symbols.length} symbols (cap=${MAX_BOOK_SYMBOLS}, stagger=${FUTURES_STARTUP_STAGGER_MS}ms each)...`);
  startupSymbols.forEach((sym, i) => setTimeout(() => connectOrderbook(sym), i * FUTURES_STARTUP_STAGGER_MS));
}

module.exports = { start };