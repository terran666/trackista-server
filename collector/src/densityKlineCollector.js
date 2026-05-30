'use strict';

// ─── Density Kline Collector ──────────────────────────────────────────────────
//
// Fetches and maintains OHLCV candle history for the density page.
//
// Architecture:
//   1. On startup (and every SYMBOL_REFRESH_MS): reads tracked symbol list from
//      Redis (density:symbols:tracked:futures) and bootstraps each symbol×TF
//      via Binance Futures REST /fapi/v1/klines → writes to Redis.
//   2. Subscribes to Binance Futures kline WebSocket streams (combined stream)
//      for live candle updates.  Only CLOSED candles are persisted; the open
//      candle is stored separately so the chart can render a live bar.
//   3. Spot klines supported via BINANCE_SPOT_REST_BASE / BINANCE_SPOT_WS_BASE
//      (enabled via DENSITY_KLINE_SPOT=true).
//
// Redis keys:
//   density:candles:futures:{symbol}:{tf}   ← JSON array of candle objects, EX=2×TF
//   density:candles:spot:{symbol}:{tf}      ← same for spot (when enabled)
//
// Candle object:
//   { time, open, high, low, close, volume }
//   `time` is the candle open time in milliseconds.
//
// Config env vars:
//   DENSITY_KLINE_TFS           = 1m,15m,1h,4h
//   DENSITY_KLINE_BARS          = 300
//   DENSITY_KLINE_SPOT          = false
//   DENSITY_KLINE_MAX_SYMBOLS   = 30
//   DENSITY_KLINE_REST_DELAY_MS = 200    (gap between REST fetches on startup)

const WebSocket       = require('ws');
const { binanceFetch } = require('./binanceRestLogger');

// ─── Config ───────────────────────────────────────────────────────
const TRACKED_TFS = (process.env.DENSITY_KLINE_TFS || '1m,15m,1h,4h')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_BARS       = Math.min(parseInt(process.env.DENSITY_KLINE_BARS          || '300',  10), 1000);
const SPOT_ENABLED   = process.env.DENSITY_KLINE_SPOT === 'true';
const MAX_SYMBOLS    = parseInt(process.env.DENSITY_KLINE_MAX_SYMBOLS            || '30',  10);
const REST_DELAY_MS  = parseInt(process.env.DENSITY_KLINE_REST_DELAY_MS          || '200', 10);
const SYMBOL_REFRESH_MS = 60_000; // how often to re-check tracked symbol list
const WS_RECONNECT_DELAY_MS = 5_000;

// TTL = 2 × TF duration so the key survives one refresh cycle if the WS drops.
const TF_MS = {
  '1m':   60_000,
  '3m':  180_000,
  '5m':  300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h':  3_600_000,
  '2h':  7_200_000,
  '4h':  14_400_000,
  '6h':  21_600_000,
  '12h': 43_200_000,
  '1d':  86_400_000,
};

function ttlForTf(tf) {
  const ms = TF_MS[tf] ?? 60_000;
  return Math.max(Math.ceil((MAX_BARS * ms) / 1000) + 120, 600); // seconds
}

const FUTURES_REST_BASE = 'https://fapi.binance.com';
const FUTURES_WS_BASE   = 'wss://fstream.binance.com';
const SPOT_REST_BASE    = 'https://api.binance.com';
const SPOT_WS_BASE      = 'wss://stream.binance.com:9443';

// ─── State ────────────────────────────────────────────────────────
let _redis       = null;
// Map<candleKey, candle[]>  — candleKey = `${market}:${symbol}:${tf}`
const candleCache = new Map();
// Set<symbol> — currently subscribed symbols (futures only to start)
let _activeSymbols = new Set();
// Map<market, WebSocket>  — one combined-stream WS per market
const _wsMap = new Map();

// ─── Redis helpers ─────────────────────────────────────────────────
function candleRedisKey(market, symbol, tf) {
  return `density:candles:${market}:${symbol}:${tf}`;
}

async function persistCandles(market, symbol, tf, candles) {
  if (!_redis || !candles.length) return;
  const key = candleRedisKey(market, symbol, tf);
  const ttl = ttlForTf(tf);
  try {
    await _redis.set(key, JSON.stringify(candles), 'EX', ttl);
  } catch (err) {
    console.error(`[density-kline] persist ${key}:`, err.message);
  }
}

// ─── REST bootstrap ────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch klines from Binance REST and write to Redis + in-memory cache.
 */
async function fetchAndStoreKlines(market, symbol, tf, limit = MAX_BARS) {
  const base = market === 'futures' ? FUTURES_REST_BASE : SPOT_REST_BASE;
  const path = market === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
  const url  = `${base}${path}?symbol=${symbol}&interval=${tf}&limit=${limit}`;

  let raw;
  try {
    const res = await binanceFetch(url, undefined, 'densityKlineCollector', symbol, `klines-${tf}`);
    if (!res.ok) {
      if (res.status === 429 || res.status === 418) {
        console.warn(`[density-kline] ${symbol}/${tf}: rate limited (${res.status}), skipping`);
      } else if (res.status !== 400) {
        console.warn(`[density-kline] ${symbol}/${tf}: HTTP ${res.status}`);
      }
      return;
    }
    raw = await res.json();
  } catch (err) {
    console.error(`[density-kline] fetchAndStoreKlines ${symbol}/${tf}:`, err.message);
    return;
  }

  if (!Array.isArray(raw)) return;

  const candles = raw.map(k => ({
    time  : k[0],
    open  : parseFloat(k[1]),
    high  : parseFloat(k[2]),
    low   : parseFloat(k[3]),
    close : parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  const cacheKey = `${market}:${symbol}:${tf}`;
  candleCache.set(cacheKey, candles);
  await persistCandles(market, symbol, tf, candles);
}

/**
 * Bootstrap all tracked symbols from Redis.
 */
async function bootstrapSymbols(market, symbols) {
  let count = 0;
  for (const symbol of symbols) {
    for (const tf of TRACKED_TFS) {
      await fetchAndStoreKlines(market, symbol, tf);
      if (REST_DELAY_MS > 0) await sleep(REST_DELAY_MS);
      count++;
    }
  }
  console.log(`[density-kline] bootstrapped ${count} symbol×TF combos for ${market}`);
}

// ─── In-memory candle update from WS ──────────────────────────────

function applyKlineUpdate(market, symbol, tf, kline) {
  const cacheKey = `${market}:${symbol}:${tf}`;
  let candles    = candleCache.get(cacheKey);

  const candle = {
    time  : kline.t,
    open  : parseFloat(kline.o),
    high  : parseFloat(kline.h),
    low   : parseFloat(kline.l),
    close : parseFloat(kline.c),
    volume: parseFloat(kline.v),
  };

  if (!candles || candles.length === 0) {
    candles = [candle];
    candleCache.set(cacheKey, candles);
    persistCandles(market, symbol, tf, candles).catch(() => {});
    return;
  }

  const last = candles[candles.length - 1];

  if (last.time === candle.time) {
    // Update in-place
    candles[candles.length - 1] = candle;
  } else if (candle.time > last.time) {
    // New bar
    candles.push(candle);
    if (candles.length > MAX_BARS) candles.shift();
  } else {
    // Out-of-order / late update — ignore
    return;
  }

  // Only persist on bar close to reduce Redis write rate.
  // kline.x === true means the candle is closed/finalized.
  if (kline.x) {
    persistCandles(market, symbol, tf, candles).catch(() => {});
  }
}

// ─── Combined WebSocket stream ────────────────────────────────────

/**
 * Build the combined stream URL for kline streams of all active symbols × TFs.
 * Binance limits: 1024 streams per connection, 300 connections per IP.
 */
function buildStreamUrl(market, symbols) {
  const base = market === 'futures' ? FUTURES_WS_BASE : SPOT_WS_BASE;
  const streams = [];
  for (const sym of symbols) {
    for (const tf of TRACKED_TFS) {
      streams.push(`${sym.toLowerCase()}@kline_${tf}`);
    }
  }
  if (streams.length === 0) return null;
  // Binance combined stream URL: /stream?streams=a@kline_1m/b@kline_1m/...
  return `${base}/stream?streams=${streams.join('/')}`;
}

function connectKlineStream(market, symbols) {
  const url = buildStreamUrl(market, symbols);
  if (!url) return;

  const ws = new WebSocket(url);
  _wsMap.set(market, ws);

  ws.on('open', () => {
    console.log(`[density-kline] ${market} WS connected (${symbols.length} symbols, ${TRACKED_TFS.length} TFs)`);
  });

  ws.on('message', raw => {
    let envelope;
    try { envelope = JSON.parse(raw); } catch (_) { return; }

    // Combined stream format: { stream: 'btcusdt@kline_1m', data: { ... } }
    const msg = envelope.data || envelope;
    if (!msg || msg.e !== 'kline') return;

    const symbol = (msg.s || '').toUpperCase();
    const k      = msg.k;
    if (!k) return;

    applyKlineUpdate(market, symbol, k.i, k);
  });

  ws.on('error', err => {
    console.error(`[density-kline] ${market} WS error:`, err.message);
  });

  ws.on('close', code => {
    _wsMap.delete(market);
    console.warn(`[density-kline] ${market} WS closed (${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms...`);
    setTimeout(() => reconnectKlineStream(market), WS_RECONNECT_DELAY_MS);
  });
}

function reconnectKlineStream(market) {
  // Re-read active symbols from Redis and reconnect
  loadTrackedSymbols(market).then(symbols => {
    if (symbols.length > 0) connectKlineStream(market, symbols);
  }).catch(err => {
    console.error(`[density-kline] reconnect symbol load failed (${market}):`, err.message);
  });
}

// ─── Symbol list management ───────────────────────────────────────

async function loadTrackedSymbols(market) {
  if (!_redis) return [];
  try {
    const raw = await _redis.get(`density:symbols:tracked:${market}`);
    if (!raw) return [];
    const data = JSON.parse(raw);
    const symbols = Array.isArray(data) ? data : (data.symbols || []);
    return symbols.slice(0, MAX_SYMBOLS);
  } catch (err) {
    console.error(`[density-kline] loadTrackedSymbols (${market}):`, err.message);
    return [];
  }
}

/**
 * Refresh tracked symbols: reconnect WS if set changed.
 */
async function refreshSymbols(market) {
  const symbols = await loadTrackedSymbols(market);
  if (symbols.length === 0) return;

  const newSet     = new Set(symbols);
  const changed    = symbols.some(s => !_activeSymbols.has(s)) ||
                     [..._activeSymbols].some(s => !newSet.has(s));

  if (changed) {
    console.log(`[density-kline] symbol list changed (${market}) — reconnecting stream`);
    _activeSymbols = newSet;

    // Bootstrap any new symbols
    const newSymbols = symbols.filter(s => {
      // Check if we already have cached candles for the first TF
      const cacheKey = `${market}:${s}:${TRACKED_TFS[0]}`;
      return !candleCache.has(cacheKey);
    });
    if (newSymbols.length > 0) {
      bootstrapSymbols(market, newSymbols).catch(err =>
        console.error('[density-kline] partial bootstrap error:', err.message),
      );
    }

    // Reconnect WS with new symbol list
    const existing = _wsMap.get(market);
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.terminate();
    }
    connectKlineStream(market, symbols);
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Start the kline collector.
 * @param {import('ioredis').Redis} redis
 */
async function start(redis) {
  _redis = redis;

  const markets = ['futures'];
  if (SPOT_ENABLED) markets.push('spot');

  for (const market of markets) {
    const symbols = await loadTrackedSymbols(market);
    if (symbols.length === 0) {
      console.log(`[density-kline] no tracked symbols for ${market} yet — will retry`);
    } else {
      _activeSymbols = new Set(symbols);
      await bootstrapSymbols(market, symbols);
      connectKlineStream(market, symbols);
    }

    // Periodic symbol refresh
    setInterval(() => refreshSymbols(market).catch(err =>
      console.error('[density-kline] refreshSymbols error:', err.message),
    ), SYMBOL_REFRESH_MS);
  }

  console.log(`[density-kline] started (TFs: ${TRACKED_TFS.join(',')} bars: ${MAX_BARS})`);
}

module.exports = { start };
