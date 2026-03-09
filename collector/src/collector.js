'use strict';

const WebSocket = require('ws');
const Redis     = require('ioredis');

// ─── Configuration ───────────────────────────────────────────────
const REDIS_HOST            = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT            = parseInt(process.env.REDIS_PORT || '6379', 10);
const BINANCE_REST_BASE     = 'https://api.binance.com';
const BINANCE_WS_BASE       = 'wss://stream.binance.com:9443';
const STREAMS_PER_BATCH     = 100;        // max streams per combined WebSocket connection
const MIN_QUOTE_VOLUME      = 10000;      // minimum 24h USDT volume
const SYMBOL_REFRESH_MS     = 60 * 60 * 1000; // re-fetch symbol list every hour
const FLUSH_INTERVAL_MS     = 1000;       // write metrics to Redis once per second
const SUMMARY_LOG_INTERVAL  = 30;        // print aggregation summary every N seconds
const BUCKET_COUNT          = 60;        // rolling window: 60 one-second buckets

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => console.log('[collector] Connected to Redis'));
redis.on('error',   (err) => console.error('[collector] Redis error:', err.message));

// ─── REST helper ─────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ─── Symbol fetching & filtering ─────────────────────────────────
async function fetchValidSymbols() {
  console.log('[collector] Fetching exchangeInfo from Binance...');
  const exchangeInfo = await fetchJSON(`${BINANCE_REST_BASE}/api/v3/exchangeInfo`);

  const tradingUsdtSet = new Set();
  for (const s of exchangeInfo.symbols) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
      tradingUsdtSet.add(s.symbol);
    }
  }
  console.log(`[collector] exchangeInfo: ${exchangeInfo.symbols.length} total symbols, ${tradingUsdtSet.size} active USDT pairs`);

  console.log('[collector] Fetching ticker/24hr from Binance...');
  const tickers = await fetchJSON(`${BINANCE_REST_BASE}/api/v3/ticker/24hr`);

  const validSymbols = [];
  let excludedStatus = 0;
  let excludedVolume = 0;

  for (const ticker of tickers) {
    if (!tradingUsdtSet.has(ticker.symbol)) { excludedStatus++; continue; }
    const quoteVolume = parseFloat(ticker.quoteVolume);
    if (isNaN(quoteVolume) || quoteVolume < MIN_QUOTE_VOLUME) { excludedVolume++; continue; }
    validSymbols.push(ticker.symbol);
  }

  console.log('[collector] Symbol filter results:');
  console.log(`[collector]   Valid symbols:                 ${validSymbols.length}`);
  console.log(`[collector]   Excluded (non-TRADING/USDT):  ${excludedStatus}`);
  console.log(`[collector]   Excluded (volume < ${MIN_QUOTE_VOLUME} USDT): ${excludedVolume}`);

  return validSymbols;
}

// ─── Batch helper ────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════
//  AGGREGATION LAYER — in-memory rolling 60-second window per symbol
// ═══════════════════════════════════════════════════════════════════

// Map<symbol, SymbolState>
const symbolStates = new Map();

function makeBucket(tsSec) {
  return {
    tsSec,
    volumeUsdt:     0,
    buyVolumeUsdt:  0,
    sellVolumeUsdt: 0,
    tradeCount:     0,
    openPrice:      null,
    closePrice:     null,
  };
}

function getOrCreateState(symbol) {
  if (!symbolStates.has(symbol)) {
    symbolStates.set(symbol, {
      symbol,
      lastPrice:          0,
      lastTradeTime:      0,
      currentBucket:      null, // will be set on first trade
      secondBuckets:      [],   // completed buckets, newest at end, max BUCKET_COUNT
    });
  }
  return symbolStates.get(symbol);
}

function onTrade(msg) {
  const symbol         = (msg.s || '').toUpperCase();
  const price          = Number(msg.p);
  const qty            = Number(msg.q);
  const tradeTime      = msg.T;          // ms
  const isMakerSell    = msg.m === true; // maker = sell-side (taker is buyer)
  const tradeValueUsdt = price * qty;
  const tradeSec       = Math.floor(tradeTime / 1000);

  if (!symbol || !price || !qty) return;

  const state = getOrCreateState(symbol);

  // Update last seen price (also written to price:<SYM> key during flush)
  state.lastPrice     = price;
  state.lastTradeTime = tradeTime;

  // ── bucket management ──────────────────────────────────────────
  if (!state.currentBucket || state.currentBucket.tsSec !== tradeSec) {
    // Seal the old bucket and push it into the history
    if (state.currentBucket) {
      state.secondBuckets.push(state.currentBucket);
      // Keep only the last BUCKET_COUNT completed buckets
      if (state.secondBuckets.length > BUCKET_COUNT) {
        state.secondBuckets.shift();
      }
    }
    state.currentBucket = makeBucket(tradeSec);
  }

  // ── update current bucket ──────────────────────────────────────
  const b = state.currentBucket;
  b.volumeUsdt   += tradeValueUsdt;
  b.tradeCount   += 1;
  if (isMakerSell) {
    b.sellVolumeUsdt += tradeValueUsdt;
  } else {
    b.buyVolumeUsdt  += tradeValueUsdt;
  }
  if (b.openPrice === null) b.openPrice = price;
  b.closePrice = price;
}

// ─── Window aggregation helpers ───────────────────────────────────
function sumBuckets(buckets) {
  let volumeUsdt     = 0;
  let buyVolumeUsdt  = 0;
  let sellVolumeUsdt = 0;
  let tradeCount     = 0;
  let openPrice      = null;
  let closePrice     = null;

  for (const b of buckets) {
    volumeUsdt     += b.volumeUsdt;
    buyVolumeUsdt  += b.buyVolumeUsdt;
    sellVolumeUsdt += b.sellVolumeUsdt;
    tradeCount     += b.tradeCount;
    if (openPrice  === null && b.openPrice  !== null) openPrice  = b.openPrice;
    if (b.closePrice !== null) closePrice = b.closePrice;
  }

  return { volumeUsdt, buyVolumeUsdt, sellVolumeUsdt, tradeCount, openPrice, closePrice };
}

function computeActivityScore(vol60, count60, priceChangePct60) {
  // Simple composite: volume weight + trade frequency + price movement
  return (vol60 * 0.5) + (count60 * 10) + (Math.abs(priceChangePct60) * 1000);
}

function buildSnapshot(state, nowMs) {
  // Merge completed buckets + current (in-flight) bucket for the window calculation
  const allBuckets = state.currentBucket
    ? [...state.secondBuckets, state.currentBucket]
    : [...state.secondBuckets];

  const total = allBuckets.length;

  const w1  = sumBuckets(allBuckets.slice(Math.max(0, total - 1)));
  const w5  = sumBuckets(allBuckets.slice(Math.max(0, total - 5)));
  const w15 = sumBuckets(allBuckets.slice(Math.max(0, total - 15)));
  const w60 = sumBuckets(allBuckets);

  let priceChangePct60 = 0;
  if (w60.openPrice && w60.openPrice !== 0) {
    priceChangePct60 = ((state.lastPrice - w60.openPrice) / w60.openPrice) * 100;
  }

  const activityScore = computeActivityScore(
    w60.volumeUsdt,
    w60.tradeCount,
    priceChangePct60,
  );

  return {
    symbol:            state.symbol,
    lastPrice:         state.lastPrice,
    lastTradeTime:     state.lastTradeTime,
    volumeUsdt1s:      w1.volumeUsdt,
    volumeUsdt5s:      w5.volumeUsdt,
    volumeUsdt15s:     w15.volumeUsdt,
    volumeUsdt60s:     w60.volumeUsdt,
    tradeCount1s:      w1.tradeCount,
    tradeCount5s:      w5.tradeCount,
    tradeCount15s:     w15.tradeCount,
    tradeCount60s:     w60.tradeCount,
    buyVolumeUsdt60s:  w60.buyVolumeUsdt,
    sellVolumeUsdt60s: w60.sellVolumeUsdt,
    deltaUsdt60s:      w60.buyVolumeUsdt - w60.sellVolumeUsdt,
    priceChangePct60s: priceChangePct60,
    activityScore,
    updatedAt:         nowMs,
  };
}

// ─── Periodic Redis flush ─────────────────────────────────────────
let flushCount     = 0;
let totalTradesAcc = 0; // trades accumulated between summary logs

function startFlushTimer() {
  console.log('[aggregator] Starting 1s flush timer...');

  setInterval(() => {
    const nowMs = Date.now();
    const pipeline = redis.pipeline();
    let snapshotCount = 0;

    for (const state of symbolStates.values()) {
      if (state.lastTradeTime === 0) continue; // no trades yet

      const snapshot = buildSnapshot(state, nowMs);
      pipeline.set(`metrics:${state.symbol}`, JSON.stringify(snapshot));
      // Also keep the price key up to date (backward compat)
      pipeline.set(`price:${state.symbol}`, String(state.lastPrice));
      snapshotCount++;
    }

    if (snapshotCount > 0) {
      pipeline.exec().catch((err) => {
        console.error('[aggregator] Redis pipeline flush error:', err.message);
      });
    }

    flushCount++;

    // Summary log every SUMMARY_LOG_INTERVAL seconds
    if (flushCount % SUMMARY_LOG_INTERVAL === 0) {
      console.log(
        `[aggregator] Summary: ${snapshotCount} metrics snapshots flushed to Redis` +
        ` | ${symbolStates.size} symbols tracked`,
      );
    }
  }, FLUSH_INTERVAL_MS);
}

// ─── WebSocket batches ───────────────────────────────────────────
const batchSockets = [];

function connectBatch(batchIndex, symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}@trade`).join('/');
  const url     = `${BINANCE_WS_BASE}/stream?streams=${streams}`;

  console.log(`[collector] Batch ${batchIndex + 1}: connecting (${symbols.length} streams)`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[collector] Batch ${batchIndex + 1}: connected`);
  });

  ws.on('message', (raw) => {
    try {
      // Combined stream envelope: { stream: "btcusdt@trade", data: { ... } }
      const envelope = JSON.parse(raw);
      const msg      = envelope.data;
      if (!msg || !msg.s) return;

      // Feed into aggregation layer (no Redis writes here)
      onTrade(msg);

      // Keep trade:SYMBOL:last key up to date (written every message, lightweight)
      const symbol = msg.s.toUpperCase();
      redis.set(`trade:${symbol}:last`, JSON.stringify(msg)).catch((err) => {
        console.error(`[collector] Failed to write trade:${symbol}:last:`, err.message);
      });
    } catch (err) {
      console.error('[collector] Failed to parse message:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error(`[collector] Batch ${batchIndex + 1} WebSocket error:`, err.message);
  });

  ws.on('close', (code) => {
    console.warn(`[collector] Batch ${batchIndex + 1} closed (code=${code}). Reconnecting in 5s...`);
    setTimeout(() => connectBatch(batchIndex, symbols), 5000);
  });

  batchSockets[batchIndex] = ws;
}

// ─── Main startup ────────────────────────────────────────────────
async function start() {
  console.log('[collector] Starting Trackista collector (stage 3)...');
  console.log(`[collector] Redis: ${REDIS_HOST}:${REDIS_PORT}`);

  let validSymbols;
  try {
    validSymbols = await fetchValidSymbols();
  } catch (err) {
    console.error('[collector] Failed to fetch symbols from Binance:', err.message);
    console.log('[collector] Retrying startup in 15s...');
    setTimeout(start, 15000);
    return;
  }

  if (validSymbols.length === 0) {
    console.error('[collector] No valid symbols found. Retrying in 30s...');
    setTimeout(start, 30000);
    return;
  }

  // Persist active symbol list to Redis
  await redis.set('symbols:active:usdt', JSON.stringify(validSymbols));
  console.log(`[collector] Saved ${validSymbols.length} active symbols to Redis (key: symbols:active:usdt)`);

  // Pre-create in-memory state for all symbols (avoids dynamic allocation on hot path)
  for (const sym of validSymbols) getOrCreateState(sym);
  console.log(`[aggregator] Pre-initialized state for ${validSymbols.length} symbols`);

  // Start the 1s Redis flush timer
  startFlushTimer();

  // Open one combined WebSocket per batch
  const batches = chunkArray(validSymbols, STREAMS_PER_BATCH);
  console.log(`[collector] Opening ${batches.length} WebSocket batch(es) of up to ${STREAMS_PER_BATCH} streams each`);

  for (let i = 0; i < batches.length; i++) {
    connectBatch(i, batches[i]);
  }

  // Periodically refresh the symbol list in Redis (sockets reconnect on next close)
  setInterval(async () => {
    console.log('[collector] Periodic symbol list refresh...');
    try {
      const refreshed = await fetchValidSymbols();
      await redis.set('symbols:active:usdt', JSON.stringify(refreshed));
      // Initialize state for any newly added symbols
      for (const sym of refreshed) getOrCreateState(sym);
      console.log(`[collector] Symbol list refreshed: ${refreshed.length} active symbols`);
    } catch (err) {
      console.error('[collector] Symbol refresh failed:', err.message);
    }
  }, SYMBOL_REFRESH_MS);
}

start();
