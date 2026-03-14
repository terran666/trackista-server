'use strict';

const WebSocket    = require('ws');
const { buildWallsPayload, getWallThreshold } = require('./wallDetector');

// ─── Configuration ────────────────────────────────────────────────
const BINANCE_REST_BASE  = 'https://fapi.binance.com';
const BINANCE_WS_BASE    = 'wss://fstream.binance.com';
const TOP_LEVELS         = 200;         // top N bids / asks stored per side
const SNAPSHOT_LIMIT     = 1000;        // REST depth snapshot depth
const FLUSH_INTERVAL_MS  = 200;         // write snapshots to Redis every 200 ms
const RECONNECT_DELAY_MS = 5000;        // WS reconnect delay after close
const VOLUME_REFRESH_MS  = 60 * 60 * 1000;

// ─── Rate limit safeguards ────────────────────────────────────────
const RESYNC_COOLDOWN_MS     = parseInt(process.env.ORDERBOOK_RESYNC_COOLDOWN_MS     || '15000', 10);
const MAX_SYNC_RETRIES       = 3;
const RESYNC_BACKOFF_BASE_MS = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MS  || '10000', 10);
const RESYNC_BACKOFF_MAX_MS  = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MAX_MS || '300000', 10);
const STATS_LOG_INTERVAL_MS  = 60_000;

// ─── Redis key helpers ────────────────────────────────────────────
// Futures data lives under a dedicated namespace so spot/futures
// are always separate in Redis.
const obKey    = sym => `futures:orderbook:${sym}`;
const wallsKey = sym => `futures:walls:${sym}`;

// ─── 24h volume cache ─────────────────────────────────────────────
//
// Map<symbol, quoteVolume24h (USDT)>
// Populated on startup and refreshed hourly via Binance Futures ticker.
//
const volumeCache = new Map();

async function refreshVolumeCache(symbols) {
  try {
    const url = `${BINANCE_REST_BASE}/fapi/v1/ticker/24hr`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tickers = await res.json();

    const symbolSet = new Set(symbols);
    let updated = 0;
    for (const t of tickers) {
      if (!symbolSet.has(t.symbol)) continue;
      const vol = parseFloat(t.quoteVolume);
      if (isFinite(vol)) {
        volumeCache.set(t.symbol, vol);
        updated++;
      }
    }
    console.log(`[futures-ob] volume cache refreshed: ${updated}/${symbols.length} symbols`);

    for (const sym of symbols) {
      const vol = volumeCache.get(sym);
      const thr = getWallThreshold(vol);
      console.log(
        `[futures-ob] ${sym}: futures volume24h=${vol != null ? Math.round(vol).toLocaleString() : 'n/a'} USD` +
        ` → wallThreshold=${thr.toLocaleString()} USD`,
      );
    }
  } catch (err) {
    console.error('[futures-ob] volume cache refresh failed:', err.message);
  }
}

function startVolumeRefresh(symbols) {
  refreshVolumeCache(symbols);
  setInterval(() => refreshVolumeCache([...bookStates.keys()]), VOLUME_REFRESH_MS);
}

// ─── Wall lifetime state ──────────────────────────────────────────
const wallLifetimes = new Map();

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
const bookStates = new Map();

function getOrCreateBook(symbol) {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids:                     new Map(),
      asks:                     new Map(),
      lastUpdateId:             0,
      synced:                   false,
      syncing:                  false,
      buffer:                   [],
      dirty:                    false,
      updatedAt:                0,
      lastResyncAt:             0,
      resyncCount:              0,
      resyncSkippedCooldown:    0,
      snapshotFetchCount:       0,
      rateLimitCount:           0,
      rateLimitBackoffUntilMs:  0,
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
// RAW CONTRACT: every entry is a single Binance Futures price level.
// No aggregation. usdValue = round2(price * size).
// marketType: 'futures' identifies the market to consumers.
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

      const volume24h     = volumeCache.get(state.symbol);
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

// ─── Binance Futures depth sync ───────────────────────────────────
//
// Algorithm identical to spot, but using Futures REST + WS endpoints.
// Binance Futures depth stream is @depth@100ms (same cadence as spot).
// Transaction time field is `T` (not `E` which is event time).
//
async function syncBook(state) {
  const sym = state.symbol;

  // ── Concurrency guard ─────────────────────────────────────────
  if (state.syncing) {
    console.warn(`[futures-ob] ${sym}: syncBook already in progress, skipping duplicate call`);
    return false;
  }
  state.syncing = true;
  state.snapshotFetchCount = (state.snapshotFetchCount || 0) + 1;

  // ── Rate limit backoff guard ───────────────────────────────
  const backoffRemaining = state.rateLimitBackoffUntilMs - Date.now();
  if (backoffRemaining > 0) {
    state.syncing = false;
    console.warn(
      `[futures-ob] ${sym}: in rate-limit backoff — skipping sync for ${Math.ceil(backoffRemaining / 1000)}s`,
    );
    return false;
  }

  console.log(
    `[futures-ob] ${sym}: fetching REST depth snapshot` +
    ` (limit=${SNAPSHOT_LIMIT} fetch#${state.snapshotFetchCount} totalResyncs=${state.resyncCount})`,
  );

  try {

  // ── REST snapshot with 429/418 backoff ────────────────────────
  let snapshot;
  let attempt = 0;
  let backoffMs = RESYNC_BACKOFF_BASE_MS;

  while (attempt < MAX_SYNC_RETRIES) {
    attempt++;
    try {
      const res = await fetch(
        `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${sym}&limit=${SNAPSHOT_LIMIT}`,
      );
      if (res.status === 429 || res.status === 418) {
        const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : backoffMs;
        state.rateLimitCount = (state.rateLimitCount || 0) + 1;
        state.rateLimitBackoffUntilMs = Date.now() + Math.min(waitMs, RESYNC_BACKOFF_MAX_MS);
        console.error(
          `[futures-ob] ${sym}: Binance rate limit HTTP ${res.status}` +
          ` — waiting ${waitMs}ms before retry ${attempt}/${MAX_SYNC_RETRIES}` +
          ` rateLimitCount=${state.rateLimitCount}`,
        );
        await new Promise(r => setTimeout(r, waitMs));
        backoffMs = Math.min(backoffMs * 2, RESYNC_BACKOFF_MAX_MS);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      snapshot = await res.json();
      break; // success
    } catch (err) {
      if (attempt >= MAX_SYNC_RETRIES) {
        console.error(
          `[futures-ob] ${sym}: REST snapshot failed after ${MAX_SYNC_RETRIES} attempts — ${err.message}`,
        );
        return false;
      }
      console.warn(
        `[futures-ob] ${sym}: snapshot attempt ${attempt} error (${err.message}), retrying in ${backoffMs}ms...`,
      );
      await new Promise(r => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, RESYNC_BACKOFF_MAX_MS);
    }
  }

  if (!snapshot) return false;

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
        ` (U=${event.U} > lastUpdateId+1=${state.lastUpdateId + 1}), resyncing...`,
      );
      state.buffer = [];
      return false; // syncBook will retry via connectOrderbook after ws.terminate()
    }

    applyEvent(state, event);
    applied++;
  }

  state.buffer  = [];
  state.synced  = true;
  state.dirty   = true;

  console.log(
    `[futures-ob] ${sym}: synced!` +
    ` dropped=${dropped} applied=${applied}` +
    ` bids=${state.bids.size} asks=${state.asks.size}` +
    ` lastUpdateId=${state.lastUpdateId}`,
  );
  return true;

  } finally {
    state.syncing = false;
  }
}

// ─── WS connection per symbol ─────────────────────────────────────
function connectOrderbook(symbol) {
  const state  = getOrCreateBook(symbol);
  state.synced = false;
  state.buffer = [];

  const streamName = `${symbol.toLowerCase()}@depth@100ms`;
  const url        = `${BINANCE_WS_BASE}/stream?streams=${streamName}`;

  console.log(`[futures-ob] ${symbol}: connecting WS...`);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[futures-ob] ${symbol}: WS open — buffering events, fetching REST snapshot...`);
    syncBook(state).then(ok => {
      if (!ok) {
        console.warn(`[futures-ob] ${symbol}: initial sync failed, terminating WS to reconnect...`);
        ws.terminate();
      }
    });
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

    if (msg.U > state.lastUpdateId + 1) {
      const now = Date.now();
      const msSinceLast = now - (state.lastResyncAt || 0);

      // Cooldown: drop the gap event if too soon
      if (msSinceLast < RESYNC_COOLDOWN_MS && state.lastResyncAt !== 0) {
        state.resyncSkippedCooldown = (state.resyncSkippedCooldown || 0) + 1;
        console.warn(
          `[futures-ob] ${symbol}: live gap skipped — cooldown (${Math.round(msSinceLast)}ms < ${RESYNC_COOLDOWN_MS}ms)` +
          ` skippedTotal=${state.resyncSkippedCooldown}`,
        );
        return;
      }

      state.resyncCount = (state.resyncCount || 0) + 1;
      state.synced = false;
      state.buffer = [msg];

      const delay = Math.max(0, RESYNC_COOLDOWN_MS - msSinceLast);
      state.lastResyncAt = now;

      console.warn(
        `[futures-ob] ${symbol}: live sequence gap` +
        ` (U=${msg.U} expected=${state.lastUpdateId + 1})` +
        ` resync#${state.resyncCount} in ${delay}ms`,
      );

      setTimeout(() => {
        syncBook(state).then(ok => {
          if (!ok) ws.terminate();
        });
      }, delay);
      return;
    }

    applyEvent(state, msg);
  });

  ws.on('error', err => {
    console.error(`[futures-ob] ${symbol}: WS error — ${err.message}`);
  });

  ws.on('close', code => {
    const backoffRemaining = Math.max(0, (state.rateLimitBackoffUntilMs || 0) - Date.now());
    const reconnectDelay   = Math.max(RECONNECT_DELAY_MS, backoffRemaining);
    if (backoffRemaining > 0) {
      console.warn(
        `[futures-ob] ${symbol}: WS closed (code=${code}), reconnecting after rate-limit backoff in ${Math.ceil(reconnectDelay / 1000)}s...`,
      );
    } else {
      console.warn(`[futures-ob] ${symbol}: WS closed (code=${code}), reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    }
    setTimeout(() => connectOrderbook(symbol), reconnectDelay);
  });
}

// ─── Periodic stats logger ────────────────────────────────────────
function startStatsLogger() {
  setInterval(() => {
    for (const [sym, state] of bookStates.entries()) {
      const inBackoff = Date.now() < state.rateLimitBackoffUntilMs;
      console.log(
        `[futures-ob:stats] ${sym}:` +
        ` synced=${state.synced}` +
        ` snapshotFetches=${state.snapshotFetchCount}` +
        ` resyncs=${state.resyncCount}` +
        ` skippedCooldown=${state.resyncSkippedCooldown || 0}` +
        ` rateLimits=${state.rateLimitCount || 0}` +
        ` inBackoff=${inBackoff}`,
      );
    }
  }, STATS_LOG_INTERVAL_MS);
}

function startSymbolWatcher(redis) {
  const CHECK_MS = parseInt(process.env.DENSITY_TRACKED_REFRESH_MS || '15000', 10);
  setInterval(async () => {
    try {
      const raw = await redis.get('density:symbols:tracked:futures');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.symbols)) return;
      let added = 0;
      for (const sym of data.symbols) {
        if (!bookStates.has(sym)) {
          console.log(`[futures-ob] symbol watcher: dynamically adding ${sym}`);
          connectOrderbook(sym);
          added++;
        }
      }
      if (added > 0) {
        console.log(`[futures-ob] symbol watcher: added ${added} new symbol(s), total=${bookStates.size + added}`);
      }
    } catch (err) {
      console.error('[futures-ob] symbol watcher error:', err.message);
    }
  }, CHECK_MS);
}

// ─── Public API ───────────────────────────────────────────────────
function startStatsLogger(symbols) {
  setInterval(() => {
    for (const sym of symbols) {
      const state = bookStates.get(sym);
      if (!state) continue;
      const inBackoff = Date.now() < state.rateLimitBackoffUntilMs;
      console.log(
        `[futures-ob:stats] ${sym}:` +
        ` synced=${state.synced}` +
        ` snapshotFetches=${state.snapshotFetchCount}` +
        ` resyncs=${state.resyncCount}` +
        ` skippedCooldown=${state.resyncSkippedCooldown || 0}` +
        ` rateLimits=${state.rateLimitCount || 0}` +
        ` inBackoff=${inBackoff}`,
      );
    }
  }, STATS_LOG_INTERVAL_MS);
}

async function start(redis) {
  const symbols = await getWatchlistSymbols(redis);
  console.log(`[futures-ob] Starting futures orderbook collector for: ${symbols.join(', ')}`);

  startVolumeRefresh(symbols);
  startStatsLogger();
  startFlushTimer(redis);
  startSymbolWatcher(redis);

  for (const sym of symbols) {
    connectOrderbook(sym);
  }
}

module.exports = { start };
