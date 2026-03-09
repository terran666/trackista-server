'use strict';

const WebSocket = require('ws');
const Redis     = require('ioredis');

// ─── Configuration ───────────────────────────────────────────────
const REDIS_HOST            = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT            = parseInt(process.env.REDIS_PORT || '6379', 10);
const BINANCE_REST_BASE     = 'https://api.binance.com';
const BINANCE_WS_BASE       = 'wss://stream.binance.com:9443';
const STREAMS_PER_BATCH     = 100;   // max streams per combined WebSocket connection
const MIN_QUOTE_VOLUME      = 10000; // minimum 24h USDT volume
const SYMBOL_REFRESH_MS     = 60 * 60 * 1000; // re-fetch symbol list every hour
const LOG_THROTTLE_MS       = 10000; // log trade activity per symbol at most once per 10s

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => console.log('[collector] Connected to Redis'));
redis.on('error',   (err) => console.error('[collector] Redis error:', err.message));

// ─── Log throttle (avoid flooding console with trade messages) ───
const lastLogTime = new Map();

function throttledLog(symbol, message) {
  const now  = Date.now();
  const last = lastLogTime.get(symbol) || 0;
  if (now - last >= LOG_THROTTLE_MS) {
    console.log(message);
    lastLogTime.set(symbol, now);
  }
}

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

  // Build a set of symbols that are TRADING and quoted in USDT
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
  let excludedStatus  = 0;
  let excludedVolume  = 0;

  for (const ticker of tickers) {
    if (!tradingUsdtSet.has(ticker.symbol)) {
      excludedStatus++;
      continue;
    }
    const quoteVolume = parseFloat(ticker.quoteVolume);
    if (isNaN(quoteVolume) || quoteVolume < MIN_QUOTE_VOLUME) {
      excludedVolume++;
      continue;
    }
    validSymbols.push(ticker.symbol);
  }

  console.log('[collector] Symbol filter results:');
  console.log(`[collector]   Valid symbols:                 ${validSymbols.length}`);
  console.log(`[collector]   Excluded (non-TRADING/USDT):  ${excludedStatus}`);
  console.log(`[collector]   Excluded (volume < ${MIN_QUOTE_VOLUME} USDT): ${excludedVolume}`);
  console.log(`[collector]   Total excluded:                ${excludedStatus + excludedVolume}`);

  return validSymbols;
}

// ─── Batch helper ────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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
      const symbol   = (msg.s || '').toUpperCase();
      const price    = msg.p;

      if (!symbol || !price) return;

      throttledLog(symbol, `[${symbol}] price=${price} qty=${msg.q}`);

      redis.set(`price:${symbol}`, price).catch((err) => {
        console.error(`[collector] Failed to write price:${symbol}:`, err.message);
      });

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
  console.log('[collector] Starting Trackista collector (stage 2)...');
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

  // Open one combined WebSocket per batch
  const batches = chunkArray(validSymbols, STREAMS_PER_BATCH);
  console.log(`[collector] Opening ${batches.length} WebSocket batch(es) of up to ${STREAMS_PER_BATCH} streams each`);

  for (let i = 0; i < batches.length; i++) {
    connectBatch(i, batches[i]);
  }

  // Periodically refresh the symbol list and store it (sockets are NOT reconnected
  // mid-run to avoid disruption — they will pick up the new list on next reconnect)
  setInterval(async () => {
    console.log('[collector] Periodic symbol list refresh...');
    try {
      const refreshed = await fetchValidSymbols();
      await redis.set('symbols:active:usdt', JSON.stringify(refreshed));
      console.log(`[collector] Symbol list refreshed: ${refreshed.length} active symbols`);
    } catch (err) {
      console.error('[collector] Symbol refresh failed:', err.message);
    }
  }, SYMBOL_REFRESH_MS);
}

start();
