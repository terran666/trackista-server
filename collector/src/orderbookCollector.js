'use strict';

const WebSocket    = require('ws');
const { buildWallsPayload, getWallThreshold } = require('./wallDetector');
const { binanceFetch } = require('./binanceRestLogger');
const rateLimitStateStore = require('./shared/binanceRateLimitStateStore');

// ─── Configuration ────────────────────────────────────────────────
const BINANCE_REST_BASE  = 'https://api.binance.com';
const BINANCE_WS_BASE    = 'wss://stream.binance.com:9443';
const TOP_LEVELS         = 200;         // top N bids / asks stored in Redis per side
const SNAPSHOT_LIMIT     = 1000;        // REST depth snapshot depth (full book)
const FLUSH_INTERVAL_MS  = 200;         // write snapshots to Redis every 200 ms
const RECONNECT_DELAY_MS = 5000;        // WS reconnect delay after close
const STARTUP_STAGGER_MS = 400;         // ms between each symbol’s initial connectOrderbook()
const VOLUME_REFRESH_MS  = 60 * 60 * 1000; // refresh 24h volumes every hour

// ─── Rate limit safeguards ────────────────────────────────────────
const RESYNC_COOLDOWN_MS     = parseInt(process.env.ORDERBOOK_RESYNC_COOLDOWN_MS     || '15000', 10);
const MAX_SYNC_RETRIES       = 3;
const RESYNC_BACKOFF_BASE_MS = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MS  || '10000', 10);
const RESYNC_BACKOFF_MAX_MS  = parseInt(process.env.ORDERBOOK_RATE_LIMIT_BACKOFF_MAX_MS || '300000', 10);
const STATS_LOG_INTERVAL_MS  = 60_000; // print per-symbol stats every 60s
// Hard cap on simultaneously tracked symbols — prevents unbounded accumulation
// after symbol rotation in the density watched list.
const MAX_BOOK_SYMBOLS = parseInt(process.env.SPOT_MAX_SYMBOLS || '40', 10);

// ─── Global IP-level backoff ─────────────────────────────────────────────────
//
// Binance 418 = IP-level temporary ban. Unlike 429 (per-endpoint throttle)
// a 418 means ALL REST calls to api.binance.com from this IP will fail.
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
      `[orderbook] GLOBAL IP BACKOFF set — all depth calls paused for ${Math.ceil(durationMs / 1000)}s` +
      ` (until ${new Date(newUntil).toISOString()})`,
    );
  }
}

// ─── 24h volume cache ─────────────────────────────────────────────
//
// Map<symbol, quoteVolume24h (USDT)>
// Populated on startup and refreshed hourly via Binance /api/v3/ticker/24hr.
// Used to compute per-symbol wall detection thresholds.
//
const volumeCache = new Map();

async function refreshVolumeCache(symbols) {
  if (isGloballyBanned()) {
    const remainingS = Math.ceil((globalBackoff.until - Date.now()) / 1000);
    console.log(`[orderbook] volume refresh skipped — global IP backoff active (${remainingS}s remaining)`);
    return;
  }
  try {
    const url = `${BINANCE_REST_BASE}/api/v3/ticker/24hr`;
    const res = await binanceFetch(url, undefined, 'orderbookCollector', '*', 'volumeRefresh');
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
  // Delay initial fetch if a global IP ban is still active — avoids hitting
  // Binance immediately after a restart during an active ban period.
  const backoffRemaining = Math.max(0, globalBackoff.until - Date.now());
  if (backoffRemaining > 0) {
    console.log(`[orderbook] volume refresh startup delayed by ${Math.ceil(backoffRemaining / 1000)}s (global IP backoff active)`);
    setTimeout(() => refreshVolumeCache([...bookStates.keys()]), backoffRemaining + 2000);
  } else {
    refreshVolumeCache(symbols); // initial fetch (fire-and-forget)
  }
  // Use bookStates.keys() on each tick so symbols added dynamically
  // after startup are included in subsequent hourly refreshes.
  setInterval(() => refreshVolumeCache([...bookStates.keys()]), VOLUME_REFRESH_MS);
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
// On startup: reads density:symbols:tracked:spot from Redis (written by
// the backend dynamicTrackedSymbolsManager).  Falls back to the
// ORDERBOOK_SYMBOLS env var when the manager hasn't run yet.
//
// At runtime: startSymbolWatcher() re-reads the Redis key on every
// DENSITY_TRACKED_REFRESH_MS interval and calls connectOrderbook() for
// any newly-tracked symbols not yet in bookStates (one-way expansion;
// removal happens on collector restart).
//
async function getWatchlistSymbols(redis) {
  try {
    const raw = await redis.get('density:symbols:tracked:spot');
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.symbols) && data.symbols.length > 0) {
        console.log(`[orderbook] using dynamic tracked list (${data.symbols.length} symbols)`);
        return data.symbols;
      }
    }
  } catch (_) {}
  // Fallback: static ENV list
  const raw = process.env.ORDERBOOK_SYMBOLS || 'BTCUSDT';
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
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
      bids:                     new Map(),
      asks:                     new Map(),
      lastUpdateId:             0,
      synced:                   false,
      syncing:                  false,  // true while syncBook is running
      buffer:                   [],
      dirty:                    false,
      updatedAt:                0,
      lastResyncAt:             0,      // ts of last live-gap resync
      resyncCount:              0,      // total live-gap resyncs
      resyncSkippedCooldown:    0,      // resyncs skipped due to cooldown
      snapshotFetchCount:       0,      // total REST /depth calls
      rateLimitCount:           0,      // total 429/418 hits
      rateLimitBackoffUntilMs:  0,      // do not attempt REST before this ts
      deactivated:              false,  // set true by symbol watcher to stop reconnect cycle
      ws:                       null,   // live WebSocket ref for forced close
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
    marketType: 'spot',
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

  // ── Concurrency guard ─────────────────────────────────────────
  if (state.syncing) {
    console.warn(`[orderbook] ${sym}: syncBook already in progress, skipping duplicate call`);
    return false;
  }
  // ── Rate limit backoff guard ───────────────────────────────
  const backoffRemaining = state.rateLimitBackoffUntilMs - Date.now();
  if (backoffRemaining > 0) {
    console.warn(
      `[orderbook] ${sym}: in rate-limit backoff — skipping sync for ${Math.ceil(backoffRemaining / 1000)}s`,
    );
    return false;
  }
  // ── Global IP-level backoff guard ─────────────────────────────────────────
  if (isGloballyBanned()) {
    const globalRemaining = globalBackoff.until - Date.now();
    state.syncing = false;
    rateLimitStateStore.incSkipped('spot');
    console.warn(
      `[orderbook] ${sym}: global IP backoff active — skipping sync for ${Math.ceil(globalRemaining / 1000)}s`,
    );
    return false;
  }
  state.syncing = true;
  state.snapshotFetchCount = (state.snapshotFetchCount || 0) + 1;
  console.log(
    `[orderbook] ${sym}: fetching REST depth snapshot` +
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
      const syncReason = state.resyncCount === 0 ? 'initialSync' : `resync#${state.resyncCount}`;
      const res = await binanceFetch(
        `${BINANCE_REST_BASE}/api/v3/depth?symbol=${sym}&limit=${SNAPSHOT_LIMIT}`,
        undefined,
        'orderbookCollector',
        sym,
        syncReason,
      );
      if (res.status === 400) {
        console.warn(`[orderbook] ${sym}: HTTP 400 from depth — symbol may not exist on spot, skipping`);
        return false;
      }
      if (res.status === 429 || res.status === 418) {
        const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : backoffMs;
        const boundedWait = Math.min(waitMs, RESYNC_BACKOFF_MAX_MS);
        state.rateLimitCount = (state.rateLimitCount || 0) + 1;
        // Store backoff in state so reconnect loop knows to wait
        state.rateLimitBackoffUntilMs = Date.now() + boundedWait;
        if (res.status === 418) setGlobalBackoff(boundedWait);
        // Mirror rate-limit event to Redis
        {
          const rlNow = Date.now();
          const is418 = res.status === 418;
          rateLimitStateStore.patchMarketState('spot', {
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
        console.error(
          `[orderbook] ${sym}: Binance rate limit HTTP ${res.status}` +
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
          `[orderbook] ${sym}: REST snapshot failed after ${MAX_SYNC_RETRIES} attempts — ${err.message}`,
        );
        return false;
      }
      console.warn(
        `[orderbook] ${sym}: snapshot attempt ${attempt} error (${err.message}), retrying in ${backoffMs}ms...`,
      );
      await new Promise(r => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, RESYNC_BACKOFF_MAX_MS);
    }
  }

  if (!snapshot) return false;

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
      return false; // syncBook will retry via connectOrderbook after ws.terminate()
    }

    applyEvent(state, event);
    applied++;
  }

  state.buffer  = [];
  state.synced  = true;
  state.dirty   = true;

  // Mirror success to Redis rate-limit state if we were previously in backoff
  if (rateLimitStateStore.getMarketState('spot').backoffUntilTs !== null) {
    const wasBackoffActive = rateLimitStateStore.getMarketState('spot').globalBackoffActive;
    rateLimitStateStore.patchMarketState('spot', { lastSuccessTs: Date.now() });
    rateLimitStateStore.persist();
    if (wasBackoffActive) {
      console.log('[rate-limit-state] backoff cleared market=spot');
    }
  }

  console.log(
    `[orderbook] ${sym}: synced!` +
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
  const state     = getOrCreateBook(symbol);
  if (state.deactivated) return; // symbol removed by watcher — stop reconnect cycle
  state.synced    = false;
  state.buffer    = [];

  // Use the combined-stream endpoint for consistency with the collector pattern.
  // Message format: { stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", ... } }
  const streamName = `${symbol.toLowerCase()}@depth@100ms`;
  const url        = `${BINANCE_WS_BASE}/stream?streams=${streamName}`;

  console.log(`[orderbook] ${symbol}: connecting WS...`);
  const ws = new WebSocket(url);
  state.ws = ws;

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
      const now = Date.now();
      const msSinceLast = now - (state.lastResyncAt || 0);

      // Cooldown: drop the gap event if too soon
      if (msSinceLast < RESYNC_COOLDOWN_MS && state.lastResyncAt !== 0) {
        state.resyncSkippedCooldown = (state.resyncSkippedCooldown || 0) + 1;
        console.warn(
          `[orderbook] ${symbol}: live gap skipped — cooldown (${Math.round(msSinceLast)}ms < ${RESYNC_COOLDOWN_MS}ms)` +
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
        `[orderbook] ${symbol}: live sequence gap` +
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
    console.error(`[orderbook] ${symbol}: WS error — ${err.message}`);
  });

  ws.on('close', code => {
    if (state.deactivated) return; // removed by watcher — stop reconnect cycle
    // If we're in a rate-limit backoff, delay reconnect until it expires
    const perSymBackoff   = Math.max(0, (state.rateLimitBackoffUntilMs || 0) - Date.now());
    const globalRemaining = Math.max(0, globalBackoff.until - Date.now());
    const baseDelay       = Math.max(RECONNECT_DELAY_MS, perSymBackoff, globalRemaining);
    // Spread reconnects across symbols after global backoff expires to avoid burst
    const jitter          = globalRemaining > 0 ? Math.floor(Math.random() * 3000) : 0;
    const reconnectDelay  = baseDelay + jitter;
    if (globalRemaining > 0 || perSymBackoff > 0) {
      console.warn(
        `[orderbook] ${symbol}: WS closed (code=${code}), reconnecting after backoff in ${Math.ceil(reconnectDelay / 1000)}s...`,
      );
    } else {
      console.warn(`[orderbook] ${symbol}: WS closed (code=${code}), reconnecting in ${reconnectDelay}ms...`);
    }
    setTimeout(() => connectOrderbook(symbol), reconnectDelay);
  });
}

// ─── Public API ───────────────────────────────────────────────────

function startStatsLogger() {
  setInterval(() => {
    for (const [sym, state] of bookStates.entries()) {
      const inBackoff = Date.now() < state.rateLimitBackoffUntilMs;
      console.log(
        `[orderbook:stats] ${sym}:` +
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

// ─── Pending-connection guard ───────────────────────────────────────
// Symbols queued for staggered connection but not yet in bookStates.
// Prevents the symbol watcher from double-connecting a symbol that was
// already scheduled but whose WS hasn't opened yet.
const pendingSymbols = new Set();

// ─── Dynamic symbol expansion ────────────────────────────────────
//
// Polls density:symbols:tracked:spot every DENSITY_TRACKED_REFRESH_MS and
// starts a WS connection for any newly-tracked symbol not yet in bookStates.
// Symbols are never removed mid-session — removal happens on restart.
// New symbols are staggered 1500 ms apart to avoid a REST depth burst.
//
function startSymbolWatcher(redis) {
  const CHECK_MS    = parseInt(process.env.DENSITY_TRACKED_REFRESH_MS || '15000', 10);
  const ADD_STAGGER = 1500; // ms between each newly-discovered symbol’s connection
  setInterval(async () => {
    try {
      const raw = await redis.get('density:symbols:tracked:spot');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.symbols)) return;

      const trackedSet = new Set(data.symbols);

      // -- Disconnect symbols that left the tracked list
      for (const [sym, state] of bookStates.entries()) {
        if (!trackedSet.has(sym)) {
          state.deactivated = true;
          state.ws?.terminate();
          bookStates.delete(sym);
          console.log(`[orderbook] symbol watcher: disconnecting ${sym} (removed from tracked list)`);
        }
      }

      // -- Add new symbols, respecting hard cap
      const slotsAvailable = MAX_BOOK_SYMBOLS - bookStates.size - pendingSymbols.size;
      if (slotsAvailable <= 0) return;

      const newSymbols = data.symbols
        .filter(sym => !bookStates.has(sym) && !pendingSymbols.has(sym))
        .slice(0, slotsAvailable);
      if (newSymbols.length === 0) return;

      console.log(
        `[orderbook] symbol watcher: queuing ${newSymbols.length} new symbol(s)` +
        ` (staggered by ${ADD_STAGGER}ms each, tracked=${bookStates.size + pendingSymbols.size + newSymbols.length}/${MAX_BOOK_SYMBOLS})...`,
      );

      newSymbols.forEach((sym, i) => {
        pendingSymbols.add(sym);
        setTimeout(() => {
          pendingSymbols.delete(sym);
          console.log(`[orderbook] symbol watcher: connecting ${sym} (${i + 1}/${newSymbols.length})`);
          connectOrderbook(sym);
        }, i * ADD_STAGGER);
      });
    } catch (err) {
      console.error('[orderbook] symbol watcher error:', err.message);
    }
  }, CHECK_MS);
}

async function start(redis) {
  await rateLimitStateStore.initAndRestore(redis, { spot: globalBackoff });

  // Log restored backoff prominently so it's visible in startup output.
  if (isGloballyBanned()) {
    console.log(
      `[orderbook] restored global IP backoff from Redis — remaining ${Math.ceil((globalBackoff.until - Date.now()) / 1000)}s`,
    );
  }

  const symbols = await getWatchlistSymbols(redis);
  console.log(`[orderbook] Starting orderbook collector for: ${symbols.join(', ')}`);

  // Fetch 24h volumes immediately and refresh every hour so that wall
  // detection thresholds stay accurate as market conditions change.
  startVolumeRefresh(symbols);
  startStatsLogger();

  startFlushTimer(redis);
  startSymbolWatcher(redis);

  // Stagger initial connections to spread the burst of REST depth fetches.
  // Without stagger, all N symbols fire /api/v3/depth simultaneously.
  // Cap at MAX_BOOK_SYMBOLS so startup never exceeds the allowed limit.
  const startupSymbols = symbols.slice(0, MAX_BOOK_SYMBOLS);
  console.log(`[orderbook] connecting ${startupSymbols.length}/${symbols.length} symbols (cap=${MAX_BOOK_SYMBOLS}, stagger=${STARTUP_STAGGER_MS}ms each)...`);
  startupSymbols.forEach((sym, i) => {
    setTimeout(() => connectOrderbook(sym), i * STARTUP_STAGGER_MS);
  });
}

module.exports = { start };
