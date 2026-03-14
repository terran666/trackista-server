'use strict';

const WebSocket    = require('ws');
const { buildWallsPayload, getWallThreshold } = require('./wallDetector');

// ─── Configuration ────────────────────────────────────────────────
const BINANCE_REST_BASE  = 'https://api.binance.com';
const BINANCE_WS_BASE    = 'wss://stream.binance.com:9443';
const TOP_LEVELS         = 50;          // top N bids / asks in snapshot
const SNAPSHOT_LIMIT     = 1000;        // REST depth snapshot depth
const FLUSH_INTERVAL_MS  = 200;         // write snapshots to Redis every 200 ms
const RECONNECT_DELAY_MS = 5000;        // WS reconnect delay after close
const VOLUME_REFRESH_MS  = 60 * 60 * 1000; // refresh 24h volumes every hour

// ─── 24h volume cache ─────────────────────────────────────────────
//
// Map<symbol, quoteVolume24h (USDT)>
// Populated on startup and refreshed hourly via Binance /api/v3/ticker/24hr.
// Used to compute per-symbol wall detection thresholds.
//
const volumeCache = new Map();

async function refreshVolumeCache(symbols) {
  try {
    const url = `${BINANCE_REST_BASE}/api/v3/ticker/24hr`;
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
    console.log(`[orderbook] volume cache refreshed: ${updated}/${symbols.length} symbols`);

    // Log thresholds for the tracked symbols so they are visible in logs
    for (const sym of symbols) {
      const vol = volumeCache.get(sym);
      const thr = getWallThreshold(vol);
      console.log(
        `[orderbook] ${sym}: volume24h=${vol != null ? Math.round(vol).toLocaleString() : 'n/a'} USD` +
        ` → wallThreshold=${thr.toLocaleString()} USD`,
      );
    }
  } catch (err) {
    console.error('[orderbook] volume cache refresh failed:', err.message);
  }
}

function startVolumeRefresh(symbols) {
  refreshVolumeCache(symbols); // initial fetch (fire-and-forget)
  setInterval(() => refreshVolumeCache(symbols), VOLUME_REFRESH_MS);
}

// ─── Wall lifetime state store ────────────────────────────────────
//
// Tracks when each wall was first and last seen so we can compute
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
 * @param {Array<object>} walls   output of detectWalls()
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
      wall.firstSeenTs  = entry.firstSeenTs;
      wall.lastSeenTs   = now;
      wall.lifetimeMs   = now - entry.firstSeenTs;
    } else {
      wallLifetimes.set(key, { firstSeenTs: now, lastSeenTs: now });
      wall.firstSeenTs = now;
      wall.lastSeenTs  = now;
      wall.lifetimeMs  = 0;
    }
  }

  // Prune stale entries (walls no longer present for this symbol)
  for (const key of wallLifetimes.keys()) {
    if (!key.startsWith(`${symbol}:`)) continue;
    if (!activeKeys.has(key)) wallLifetimes.delete(key);
  }

  return walls;
}

// ─── Watchlist ────────────────────────────────────────────────────
//
// ORDERBOOK_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
//
// Architecture note: this function is the single entry point for the
// symbol list.  To add a dynamic watchlist manager later, replace this
// function with one that reads from Redis or a DB at runtime — the rest
// of the collector does not need to change.
//
function getWatchlistSymbols() {
  const raw = process.env.ORDERBOOK_SYMBOLS || 'BTCUSDT';
  return raw
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

// ─── Per-symbol book state ────────────────────────────────────────
//
// Map<symbol, BookState>
//
// BookState = {
//   symbol:       string
//   bids:         Map<priceStr, sizeNum>   price-level → quantity
//   asks:         Map<priceStr, sizeNum>
//   lastUpdateId: number                   last applied Binance updateId
//   synced:       boolean                  true after REST+WS sync complete
//   buffer:       DepthEvent[]             events buffered during sync
//   dirty:        boolean                  snapshot changed, needs flush
//   updatedAt:    number (ms)
// }
//
const bookStates = new Map();

function getOrCreateBook(symbol) {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids:         new Map(),
      asks:         new Map(),
      lastUpdateId: 0,
      synced:       false,
      buffer:       [],
      dirty:        false,
      updatedAt:    0,
    });
  }
  return bookStates.get(symbol);
}

// ─── Book update helpers ──────────────────────────────────────────

// Apply a Binance diff-update array [[priceStr, sizeStr], ...] to a Map.
// size = 0  → remove the price level
// size > 0  → set / overwrite the price level
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
  state.updatedAt    = event.E || Date.now();
  state.dirty        = true;
}

// ─── Snapshot builder ─────────────────────────────────────────────
//
// Builds a normalised TOP_LEVELS snapshot from the current local book.
// bids sorted descending by price, asks ascending.
//
// RAW CONTRACT: every entry in bids/asks is a single Binance price level
// (one key from the Map<priceStr, sizeNum>).  No levels are merged or
// bucketed before serialisation.  usdValue = round2(price * size).
// This snapshot is the canonical source for /api/orderbook, /api/walls,
// and /api/density-view — all three must reflect the same raw levels.
//
function buildSnapshot(state) {
  const bids = [...state.bids.entries()]
    .map(([p, s]) => ({ price: parseFloat(p), size: s }))
    .sort((a, b) => b.price - a.price)
    .slice(0, TOP_LEVELS)
    .map(l => ({
      price:    l.price,
      size:     l.size,
      usdValue: parseFloat((l.price * l.size).toFixed(2)),
    }));

  const asks = [...state.asks.entries()]
    .map(([p, s]) => ({ price: parseFloat(p), size: s }))
    .sort((a, b) => a.price - b.price)
    .slice(0, TOP_LEVELS)
    .map(l => ({
      price:    l.price,
      size:     l.size,
      usdValue: parseFloat((l.price * l.size).toFixed(2)),
    }));

  const bestBid  = bids.length > 0 ? bids[0].price : null;
  const bestAsk  = asks.length > 0 ? asks[0].price : null;
  const midPrice = bestBid !== null && bestAsk !== null
    ? parseFloat(((bestBid + bestAsk) / 2).toFixed(8))
    : null;

  return {
    symbol:    state.symbol,
    updatedAt: state.updatedAt || Date.now(),
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
      pipeline.set(`orderbook:${state.symbol}`, JSON.stringify(snapshot));

      // Wall detection runs on the same snapshot — no extra Redis read needed.
      // Use the per-symbol threshold derived from its 24h volume tier.
      const volume24h     = volumeCache.get(state.symbol);
      const wallThreshold = getWallThreshold(volume24h);
      const wallsPayload  = buildWallsPayload(snapshot, wallThreshold);

      // Annotate walls with lifetime data (firstSeenTs / lastSeenTs / lifetimeMs)
      applyWallLifetime(state.symbol, wallsPayload.walls, snapshot.updatedAt);

      pipeline.set(`walls:${state.symbol}`, JSON.stringify(wallsPayload));

      state.dirty = false;
      count++;
    }

    if (count > 0) {
      pipeline.exec().catch(err =>
        console.error('[orderbook] Redis flush error:', err.message),
      );
    }
  }, FLUSH_INTERVAL_MS);
}

// ─── Binance order book sync algorithm ───────────────────────────
//
// Per official Binance docs (How to manage a local order book correctly):
//
//   1. Open WS stream → start buffering every event immediately.
//   2. GET /api/v3/depth?symbol=X&limit=1000 → REST snapshot.
//   3. Drop buffered events where event.u <= snapshot.lastUpdateId.
//   4. First valid buffered event must satisfy:
//        event.U <= lastUpdateId + 1  AND  event.u >= lastUpdateId + 1
//      If its U > lastUpdateId + 1 there is a gap → must resync.
//   5. Apply remaining valid buffered events.
//   6. Live: each new event's U must equal previous event's u + 1.
//      Gap detected → resync.
//   7. Quantity in each event is absolute (not delta).
//   8. Quantity = 0 → remove price level.
//
async function syncBook(state) {
  const sym = state.symbol;
  console.log(`[orderbook] ${sym}: fetching REST depth snapshot (limit=${SNAPSHOT_LIMIT})...`);

  let snapshot;
  try {
    const res = await fetch(
      `${BINANCE_REST_BASE}/api/v3/depth?symbol=${sym}&limit=${SNAPSHOT_LIMIT}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snapshot = await res.json();
  } catch (err) {
    console.error(`[orderbook] ${sym}: REST snapshot failed — ${err.message}`);
    return false;
  }

  const snapId = snapshot.lastUpdateId;
  console.log(
    `[orderbook] ${sym}: snapshot lastUpdateId=${snapId}` +
    ` bids=${snapshot.bids.length} asks=${snapshot.asks.length}`,
  );

  // Initialise local book from REST snapshot
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

  // Apply valid buffered events
  let dropped = 0;
  let applied = 0;

  for (const event of state.buffer) {
    // Drop stale events (u <= snapshot id)
    if (event.u <= snapId) {
      dropped++;
      continue;
    }

    // Sequence gap: first valid event's U jumped past snapId+1
    if (event.U > state.lastUpdateId + 1) {
      console.warn(
        `[orderbook] ${sym}: sequence gap in buffer` +
        ` (U=${event.U} > lastUpdateId+1=${state.lastUpdateId + 1}), resyncing...`,
      );
      state.buffer = [];
      return false;
    }

    applyEvent(state, event);
    applied++;
  }

  state.buffer  = [];
  state.synced  = true;
  state.dirty   = true;

  console.log(
    `[orderbook] ${sym}: synced!` +
    ` dropped=${dropped} applied=${applied}` +
    ` bids=${state.bids.size} asks=${state.asks.size}` +
    ` lastUpdateId=${state.lastUpdateId}`,
  );
  return true;
}

// ─── WS connection per symbol ─────────────────────────────────────

function connectOrderbook(symbol) {
  const state     = getOrCreateBook(symbol);
  state.synced    = false;
  state.buffer    = [];

  // Use the combined-stream endpoint for consistency with the collector pattern.
  // Message format: { stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", ... } }
  const streamName = `${symbol.toLowerCase()}@depth@100ms`;
  const url        = `${BINANCE_WS_BASE}/stream?streams=${streamName}`;

  console.log(`[orderbook] ${symbol}: connecting WS...`);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[orderbook] ${symbol}: WS open — buffering events, fetching REST snapshot...`);
    syncBook(state).then(ok => {
      if (!ok) {
        console.warn(`[orderbook] ${symbol}: initial sync failed, terminating WS to reconnect...`);
        ws.terminate();
      }
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      const envelope = JSON.parse(raw);
      msg = envelope.data || envelope; // combined stream wraps payload in .data
    } catch (err) {
      console.error(`[orderbook] ${symbol}: JSON parse error:`, err.message);
      return;
    }

    if (!msg || msg.e !== 'depthUpdate') return;

    // While syncing: buffer every event so syncBook can replay them
    if (!state.synced) {
      state.buffer.push(msg);
      return;
    }

    // Duplicate / already-applied event (e.g. arrives just after resync)
    if (msg.u <= state.lastUpdateId) return;

    // Live sequence check: U must equal previous u + 1
    if (msg.U > state.lastUpdateId + 1) {
      console.warn(
        `[orderbook] ${symbol}: live sequence gap` +
        ` (U=${msg.U} > lastUpdateId+1=${state.lastUpdateId + 1}), resyncing...`,
      );
      state.synced = false;
      state.buffer = [msg];
      syncBook(state).then(ok => {
        if (!ok) ws.terminate();
      });
      return;
    }

    applyEvent(state, msg);
  });

  ws.on('error', err => {
    console.error(`[orderbook] ${symbol}: WS error — ${err.message}`);
  });

  ws.on('close', code => {
    console.warn(`[orderbook] ${symbol}: WS closed (code=${code}), reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(() => connectOrderbook(symbol), RECONNECT_DELAY_MS);
  });
}

// ─── Public API ───────────────────────────────────────────────────

function start(redis) {
  const symbols = getWatchlistSymbols();
  console.log(`[orderbook] Starting orderbook collector for: ${symbols.join(', ')}`);

  // Fetch 24h volumes immediately and refresh every hour so that wall
  // detection thresholds stay accurate as market conditions change.
  startVolumeRefresh(symbols);

  startFlushTimer(redis);

  for (const sym of symbols) {
    connectOrderbook(sym);
  }
}

module.exports = { start };
