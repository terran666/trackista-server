'use strict';
/**
 * heatmapService.js — Heatmap orderbook-history backend.
 *
 * Collects Binance Futures depth via WebSocket (@depth@500ms), maintains
 * in-memory orderbooks, builds 1-second price-bucket snapshots and stores
 * them in Redis for the /heatmap page.
 *
 * Anti-ban principles:
 *   - One shared WS stream per symbol — never one per user
 *   - REST depth snapshot used only for init/recovery
 *   - Recovery cooldown: minimum RECOVERY_COOLDOWN_MS between REST calls
 *   - Hard limit of MAX_SYMBOLS concurrent active symbols
 *
 * Redis keys:
 *   heatmap:latest:{symbol}   — latest snapshot JSON, TTL 60 s
 *   heatmap:history:{symbol}  — Redis list (LPUSH), newest first, max MAX_HISTORY items
 */

const WebSocket = require('ws');
const { binanceFetch } = require('../utils/binanceRestLogger');

// ─── Config ───────────────────────────────────────────────────────
const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE   = 'wss://fstream.binance.com';

const ENABLED                = process.env.HEATMAP_ENABLED !== 'false';
const MAX_SYMBOLS            = parseInt(process.env.HEATMAP_MAX_SYMBOLS           || '20',  10);
const RANGE_PERCENT          = parseFloat(process.env.HEATMAP_RANGE_PERCENT        || '3');
const BUCKET_TICK_MULTIPLIER = parseInt(process.env.HEATMAP_BUCKET_TICK_MULTIPLIER || '1',  10);
const SNAPSHOT_INTERVAL_MS   = parseInt(process.env.HEATMAP_SNAPSHOT_INTERVAL_SEC  || '1',  10) * 1000;
const MAX_HISTORY            = 1800;   // 30 min × 60 s
const RECOVERY_COOLDOWN_MS   = 30_000; // minimum gap between REST depth calls per symbol
const RECONNECT_DELAY_MS     = 5_000;
const SNAPSHOT_LIMIT         = 1000;   // Binance depth REST limit

// ─── Wall thresholds (USD notional) ───────────────────────────────
const WALL_THRESHOLDS = new Map([
  ['BTCUSDT',  5_000_000],
  ['ETHUSDT',  4_000_000],
  ['SOLUSDT',  3_000_000],
  ['BNBUSDT',  3_000_000],
  ['XRPUSDT',  3_000_000],
  ['DOGEUSDT', 1_000_000],
]);
const WALL_THRESHOLD_DEFAULT = 400_000;
function wallThreshold(symbol) {
  return WALL_THRESHOLDS.get(symbol) ?? WALL_THRESHOLD_DEFAULT;
}

// ─── Tick size cache (loaded from exchangeInfo once at startup) ───
const tickSizes = new Map(); // symbol → number

async function loadTickSizes() {
  try {
    const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    for (const sym of info.symbols || []) {
      const pf = (sym.filters || []).find(f => f.filterType === 'PRICE_FILTER');
      if (pf) {
        const ts = parseFloat(pf.tickSize);
        if (isFinite(ts) && ts > 0) tickSizes.set(sym.symbol, ts);
      }
    }
    console.log(`[heatmap] loaded tick sizes for ${tickSizes.size} symbols`);
  } catch (err) {
    console.error('[heatmap] loadTickSizes failed:', err.message);
  }
}

// ─── Bucket size computation ──────────────────────────────────────
/**
 * Compute bucket size aiming for ~120 rows in the ±RANGE_PERCENT window.
 * Result is always a multiple of tickSize × BUCKET_TICK_MULTIPLIER.
 */
function computeBucketSize(midPrice, tickSize) {
  const tick   = (tickSize && isFinite(tickSize) && tickSize > 0) ? tickSize : 0.01;
  const range  = midPrice * (RANGE_PERCENT / 100) * 2;
  const target = 120;
  const raw    = range / target;
  const ticks  = Math.max(1, Math.round(raw / tick)) * BUCKET_TICK_MULTIPLIER;
  const bucket = ticks * tick;
  // Preserve decimal precision of tickSize
  const dec = (tick.toString().split('.')[1] ?? '').length;
  return parseFloat(bucket.toFixed(dec));
}

// ─── Per-symbol book state ────────────────────────────────────────
const bookStates = new Map(); // symbol → BookState

function getOrCreate(symbol) {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids:           new Map(), // priceStr → qty (float)
      asks:           new Map(),
      lastUpdateId:   0,
      synced:         false,
      syncing:        false,
      buffer:         [],        // WS events buffered before first snapshot
      dirty:          false,
      updatedAt:      0,
      lastResyncTs:   0,
      recoveryTimer:  null,
      ws:             null,
      wsOpen:         false,
      deactivated:    false,
    });
  }
  return bookStates.get(symbol);
}

// ─── Book helpers ─────────────────────────────────────────────────
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

// ─── Heatmap snapshot builder ─────────────────────────────────────
function buildHeatmapSnapshot(symbol) {
  const state = bookStates.get(symbol);
  if (!state || !state.synced) return null;

  const tick     = tickSizes.get(symbol) ?? 0.01;
  const bidsArr  = [...state.bids.entries()]
    .map(([p, q]) => ({ p: parseFloat(p), q }))
    .sort((a, b) => b.p - a.p);
  const asksArr  = [...state.asks.entries()]
    .map(([p, q]) => ({ p: parseFloat(p), q }))
    .sort((a, b) => a.p - b.p);

  if (bidsArr.length === 0 && asksArr.length === 0) return null;

  const bestBid  = bidsArr[0]?.p ?? null;
  const bestAsk  = asksArr[0]?.p ?? null;
  const midPrice = bestBid !== null && bestAsk !== null
    ? (bestBid + bestAsk) / 2
    : (bestBid ?? bestAsk);
  if (midPrice === null) return null;

  const bucketSize    = computeBucketSize(midPrice, tick);
  const rangeHalf     = midPrice * RANGE_PERCENT / 100;
  const priceMin      = midPrice - rangeHalf;
  const priceMax      = midPrice + rangeHalf;
  const wallThresh    = wallThreshold(symbol);
  const buckets       = {};
  const walls         = [];

  for (const { p, q } of bidsArr) {
    if (p < priceMin || p > priceMax) continue;
    const key      = String(parseFloat((Math.floor(p / bucketSize) * bucketSize).toFixed(8)));
    const notional = Math.round(p * q);
    if (!buckets[key]) buckets[key] = { bidNotional: 0, askNotional: 0, totalNotional: 0 };
    buckets[key].bidNotional   += notional;
    buckets[key].totalNotional += notional;
    if (notional >= wallThresh) walls.push({ price: p, side: 'bid', notional });
  }

  for (const { p, q } of asksArr) {
    if (p < priceMin || p > priceMax) continue;
    const key      = String(parseFloat((Math.floor(p / bucketSize) * bucketSize).toFixed(8)));
    const notional = Math.round(p * q);
    if (!buckets[key]) buckets[key] = { bidNotional: 0, askNotional: 0, totalNotional: 0 };
    buckets[key].askNotional   += notional;
    buckets[key].totalNotional += notional;
    if (notional >= wallThresh) walls.push({ price: p, side: 'ask', notional });
  }

  return {
    symbol,
    ts:         Date.now(),
    midPrice:   parseFloat(midPrice.toFixed(8)),
    bucketSize,
    buckets,
    walls,
  };
}

// ─── REST depth snapshot (init / recovery) ────────────────────────
async function syncSnapshot(state) {
  const sym = state.symbol;
  const now = Date.now();

  if (state.syncing) return;
  if (now - state.lastResyncTs < RECOVERY_COOLDOWN_MS) {
    console.warn(`[heatmap] ${sym}: recovery cooldown active, skipping REST snapshot`);
    if (!state.recoveryTimer) {
      const remaining = RECOVERY_COOLDOWN_MS - (now - state.lastResyncTs);
      state.recoveryTimer = setTimeout(() => {
        state.recoveryTimer = null;
        syncSnapshot(state).catch(err =>
          console.error(`[heatmap] ${sym}: retry-sync error: ${err.message}`),
        );
      }, remaining + 200);
    }
    return;
  }
  if (state.recoveryTimer) {
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
  }

  state.syncing    = true;
  state.lastResyncTs = now;

  console.log(`[heatmap] ${sym}: fetching REST depth snapshot (limit=${SNAPSHOT_LIMIT})`);
  try {
    let res;
    try {
      res = await binanceFetch(
        `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${sym}&limit=${SNAPSHOT_LIMIT}`,
        { signal: AbortSignal.timeout(10_000) },
        'heatmapService',
        sym,
        'depth_snapshot',
      );
    } catch (banErr) {
      // binanceFetch throws (err.status=418) when in-process ban guard fires
      const penaltyMs = banErr.retryAfterMs || 60_000;
      state.lastResyncTs = now + penaltyMs;
      console.warn(`[heatmap] ${sym}: ban guard active — delaying resync ${Math.ceil(penaltyMs / 1000)}s`);
      state.syncing = false;
      return;
    }

    if (res.status === 429 || res.status === 418) {
      // Rate-limit — extend cooldown
      const penaltyMs = res.status === 418 ? 120_000 : 60_000;
      state.lastResyncTs = now + penaltyMs;
      console.error(`[heatmap] ${sym}: rate limit HTTP ${res.status} — extra ${penaltyMs / 1000}s cooldown`);
      state.syncing = false;
      return;
    }
    if (res.status === 400) {
      console.warn(`[heatmap] ${sym}: HTTP 400 — not on futures, deactivating`);
      state.deactivated = true;
      state.syncing = false;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const snap   = await res.json();
    const snapId = snap.lastUpdateId;

    // Replace book with snapshot data
    state.bids.clear();
    state.asks.clear();
    for (const [p, s] of snap.bids) { const sz = parseFloat(s); if (sz > 0) state.bids.set(p, sz); }
    for (const [p, s] of snap.asks) { const sz = parseFloat(s); if (sz > 0) state.asks.set(p, sz); }
    state.lastUpdateId = snapId;

    // Drain buffered WS events
    let applied = 0;
    for (const event of state.buffer) {
      if (event.u <= snapId) continue;
      if (event.U > state.lastUpdateId + 1) {
        // Gap in buffer — need another snapshot
        console.warn(`[heatmap] ${sym}: buffer gap (U=${event.U}), re-queueing snapshot`);
        state.buffer  = [];
        state.syncing = false;
        state.synced  = false;
        setTimeout(() => syncSnapshot(state).catch(err =>
          console.error(`[heatmap] ${sym}: re-sync error: ${err.message}`),
        ), 1000);
        return;
      }
      applyEvent(state, event);
      applied++;
    }
    state.buffer = [];
    state.synced = true;
    state.dirty  = true;
    console.log(`[heatmap] ${sym}: synced id=${snapId} bids=${state.bids.size} asks=${state.asks.size} buffered=${applied}`);
  } catch (err) {
    console.error(`[heatmap] ${sym}: REST snapshot error: ${err.message}`);
  } finally {
    state.syncing = false;
  }
}

// ─── WebSocket connection ─────────────────────────────────────────
function connectWs(symbol) {
  const state = bookStates.get(symbol);
  if (!state || state.deactivated) return;

  const url = `${BINANCE_WS_BASE}/stream?streams=${symbol.toLowerCase()}@depth@500ms`;
  const ws  = new WebSocket(url);
  state.ws  = ws;

  ws.on('open', () => {
    state.wsOpen = true;
    console.log(`[heatmap] ${symbol}: WS depth stream connected`);
    // Request initial REST snapshot
    syncSnapshot(state).catch(err =>
      console.error(`[heatmap] ${symbol}: initial sync error: ${err.message}`),
    );
  });

  ws.on('message', (data) => {
    try {
      const msg   = JSON.parse(data.toString('utf8'));
      const event = msg.data ?? msg; // combined stream wraps: { stream, data }
      if (!event.b || !event.a) return;

      if (!state.synced) {
        // Buffer until REST snapshot arrives
        state.buffer.push(event);
        return;
      }

      // Sequence gap — for heatmap display we tolerate small gaps (< 500 IDs)
      // and just apply the event, avoiding costly resync cycles on active symbols.
      // Large gaps (missed REST snapshot) still trigger a resync.
      if (event.U > state.lastUpdateId + 1) {
        const gap = event.U - (state.lastUpdateId + 1);
        if (gap > 500) {
          console.warn(`[heatmap] ${symbol}: large sequence gap (${gap} IDs), resyncing`);
          state.synced = false;
          state.buffer = [event];
          syncSnapshot(state).catch(err =>
            console.error(`[heatmap] ${symbol}: resync error: ${err.message}`),
          );
          return;
        }
        // Small gap — just continue, book stays accurate enough for display
      }
      if (event.u < state.lastUpdateId) return; // stale — skip

      applyEvent(state, event);
    } catch (err) {
      console.error(`[heatmap] ${symbol}: WS message parse error: ${err.message}`);
    }
  });

  ws.on('close', (code) => {
    state.wsOpen  = false;
    state.synced  = false;
    if (state.deactivated) return;
    console.warn(`[heatmap] ${symbol}: WS closed (${code}), reconnecting in ${RECONNECT_DELAY_MS}ms`);
    setTimeout(() => connectWs(symbol), RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    console.error(`[heatmap] ${symbol}: WS error: ${err.message}`);
  });
}

// ─── Top-volume symbol refresh ────────────────────────────────────
/**
 * Re-evaluate the top-N USDT symbols by 24h volume every hour.
 * Activates newly-ranked symbols; leaves existing ones running (they
 * continue accumulating history and may still be viewed by users).
 */
async function refreshTopSymbols() {
  if (!_redis) return;
  try {
    const raw = await _redis.get('futures:tickers:all');
    if (!raw) return;
    const tickers = JSON.parse(raw);
    const candidates = tickers
      .filter(t => t.symbol && t.symbol.endsWith('USDT'))
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, MAX_SYMBOLS * 3)
      .map(t => t.symbol);
    // Filter to symbols known to frontend (density tracked list)
    const trackedRaw = await _redis.get('density:symbols:tracked:futures');
    const trackedSet = trackedRaw
      ? new Set((JSON.parse(trackedRaw).symbols || []))
      : null;
    const top = trackedSet
      ? candidates.filter(s => trackedSet.has(s)).slice(0, MAX_SYMBOLS)
      : candidates.slice(0, MAX_SYMBOLS);
    let added = 0;
    for (const sym of top) {
      if (!bookStates.has(sym)) {
        const result = activateSymbol(sym);
        if (result.ok) added++;
      }
    }
    if (added > 0) {
      console.log(`[heatmap] hourly refresh: activated ${added} new top symbols`);
    }
  } catch (err) {
    console.warn('[heatmap] refreshTopSymbols error:', err.message);
  }
}

// ─── Snapshot flush timer ─────────────────────────────────────────
let _redis    = null;
let _eventBus = null;
let _timer    = null;

function startSnapshotTimer() {
  if (_timer) return;
  _timer = setInterval(async () => {
    if (!_redis) return;
    const pipeline = _redis.pipeline();
    let count = 0;

    for (const symbol of bookStates.keys()) {
      const snapshot = buildHeatmapSnapshot(symbol);
      if (!snapshot) continue;

      const json = JSON.stringify(snapshot);
      pipeline.lpush(`heatmap:history:${symbol}`, json);
      pipeline.ltrim(`heatmap:history:${symbol}`, 0, MAX_HISTORY - 1);
      pipeline.set(`heatmap:latest:${symbol}`, json, 'EX', 60);
      count++;

      // Near-instant push to WS subscribers
      if (_eventBus) {
        _eventBus.emit('heatmap:update', { symbol, snapshot });
      }
    }

    if (count > 0) {
      pipeline.exec().catch(err =>
        console.error('[heatmap] Redis pipeline error:', err.message),
      );
    }
  }, SNAPSHOT_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

// ─── Mid-price helper (public) ────────────────────────────────────
function getMidPrice(state) {
  const bests = [...state.bids.keys()].map(parseFloat);
  const besta = [...state.asks.keys()].map(parseFloat);
  const bid   = bests.length ? Math.max(...bests) : null;
  const ask   = besta.length ? Math.min(...besta) : null;
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask ?? null;
}

// ─── Public API ───────────────────────────────────────────────────

/** Activate heatmap collection for a symbol. */
function activateSymbol(symbol) {
  const sym = symbol.toUpperCase();
  if (bookStates.has(sym)) return { ok: true, alreadyActive: true };
  if (bookStates.size >= MAX_SYMBOLS) {
    return {
      ok:      false,
      error:   'MAX_SYMBOLS_REACHED',
      message: `Heatmap limit is ${MAX_SYMBOLS} concurrent symbols`,
    };
  }
  getOrCreate(sym);
  connectWs(sym);
  console.log(`[heatmap] activated ${sym} (${bookStates.size}/${MAX_SYMBOLS})`);
  return { ok: true };
}

/** Deactivate heatmap collection for a symbol. */
function deactivateSymbol(symbol) {
  const sym   = symbol.toUpperCase();
  const state = bookStates.get(sym);
  if (!state) return;
  state.deactivated = true;
  if (state.ws) {
    try { state.ws.terminate(); } catch (_) {}
    state.ws = null;
  }
  bookStates.delete(sym);
  console.log(`[heatmap] deactivated ${sym}`);
}

/** Returns list of currently tracked symbols with metadata. */
function getActiveSymbols(allTickers) {
  const out = [];
  for (const [symbol, state] of bookStates) {
    if (state.deactivated) continue;
    const ticker = allTickers?.find(t => t.symbol === symbol);
    out.push({
      symbol,
      price:      getMidPrice(state),
      volume24h:  ticker ? parseFloat(ticker.quoteVolume) : null,
      isActive:   true,
      hasHeatmap: true,   // all tracked symbols have heatmap enabled
      updatedAt:  state.updatedAt || null,
    });
  }
  return out;
}

/** Returns current orderbook for heatmap side-panel. */
function getOrderbookSnapshot(symbol, levels = 50) {
  const sym   = symbol.toUpperCase();
  const state = bookStates.get(sym);
  if (!state || !state.synced) return null;

  const bids = [...state.bids.entries()]
    .map(([p, q]) => { const price = parseFloat(p); return { price, notional: Math.round(price * q) }; })
    .sort((a, b) => b.price - a.price)
    .slice(0, levels);

  const asks = [...state.asks.entries()]
    .map(([p, q]) => { const price = parseFloat(p); return { price, notional: Math.round(price * q) }; })
    .sort((a, b) => a.price - b.price)
    .slice(0, levels);

  const midPrice = getMidPrice(state);
  return { symbol: sym, bids, asks, midPrice, updatedAt: state.updatedAt };
}

/** Returns true if symbol is currently being tracked. */
function isSymbolActive(symbol) {
  return bookStates.has(symbol.toUpperCase());
}

/** Start the heatmap service. */
async function start(redis, eventBus) {
  if (!ENABLED) {
    console.log('[heatmap] HEATMAP_ENABLED=false — service disabled');
    return;
  }

  _redis    = redis;
  _eventBus = eventBus ?? null;

  // Load tick sizes before activating symbols
  await loadTickSizes();

  // Listen for on-demand activation requests from WS handlers (liveWsGateway / heatmapRoute)
  if (eventBus) {
    eventBus.on('heatmap:activate', (symbol) => {
      activateSymbol(String(symbol).toUpperCase());
    });
  }

  // Activate default symbols — top-N by 24h futures volume, falling back to env/hardcoded list
  const defaults = await (async () => {
    // If env override is set, use it as-is
    if (process.env.HEATMAP_DEFAULT_SYMBOLS) {
      return process.env.HEATMAP_DEFAULT_SYMBOLS
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, MAX_SYMBOLS);
    }
    // Otherwise pick top-N USDT futures by 24h trade count from Redis ticker cache
    // Only include symbols present in density:symbols:tracked:futures (shown in frontend)
    try {
      const raw = await redis.get('futures:tickers:all');
      if (raw) {
        const tickers = JSON.parse(raw);
        const candidates = tickers
          .filter(t => t.symbol && t.symbol.endsWith('USDT'))
          .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
          .slice(0, MAX_SYMBOLS * 3)
          .map(t => t.symbol);
        // Filter to symbols known to frontend (density tracked list)
        const trackedRaw = await redis.get('density:symbols:tracked:futures');
        const trackedSet = trackedRaw
          ? new Set((JSON.parse(trackedRaw).symbols || []))
          : null;
        const top = trackedSet
          ? candidates.filter(s => trackedSet.has(s)).slice(0, MAX_SYMBOLS)
          : candidates.slice(0, MAX_SYMBOLS);
        if (top.length > 0) return top;
      }
    } catch (err) {
      console.warn('[heatmap] could not load top symbols from Redis:', err.message);
    }
    // Final fallback
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  })();

  for (const sym of defaults) {
    activateSymbol(sym);
  }

  startSnapshotTimer();

  // Hourly refresh: activate any newly-top symbols
  const _refreshTimer = setInterval(refreshTopSymbols, 60 * 60 * 1000);
  if (_refreshTimer.unref) _refreshTimer.unref();

  console.log(
    `[heatmap] service started — symbols=${defaults.join(',')} ` +
    `range=±${RANGE_PERCENT}% maxSymbols=${MAX_SYMBOLS} interval=${SNAPSHOT_INTERVAL_MS}ms`,
  );
}

module.exports = {
  start,
  activateSymbol,
  deactivateSymbol,
  getActiveSymbols,
  getOrderbookSnapshot,
  isSymbolActive,
  buildHeatmapSnapshot,
  tickSizes,
};
