'use strict';

const WebSocket = require('ws');
const Redis     = require('ioredis');
const { binanceFetch } = require('./binanceRestLogger');

// ─── Configuration ───────────────────────────────────────────────
const REDIS_HOST            = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT            = parseInt(process.env.REDIS_PORT || '6379', 10);
const BINANCE_REST_BASE     = 'https://fapi.binance.com';          // Binance Futures REST
const BINANCE_WS_BASE       = 'wss://fstream.binance.com';         // Binance Futures WS
const STREAMS_PER_BATCH     = 100;        // max streams per combined WebSocket connection
const MIN_QUOTE_VOLUME      = parseInt(process.env.TRACK_MIN_VOLUME_24H_USD || '1000000', 10);

// ─── Spot configuration ──────────────────────────────────────────
const SPOT_REST_BASE         = 'https://api.binance.com';           // Binance Spot REST
const SPOT_WS_BASE           = 'wss://stream.binance.com:9443';     // Binance Spot WS
const SPOT_STREAMS_PER_BATCH = 100;       // max streams per spot WS connection
const SPOT_MIN_QUOTE_VOLUME  = parseInt(process.env.SPOT_MIN_VOLUME_24H_USD || '1000000', 10);
// Delay before spot REST calls on startup (avoid burst overlap with futures)
const SPOT_STARTUP_DELAY_MS  = parseInt(process.env.SPOT_STARTUP_DELAY_MS  || '12000', 10);
const SYMBOL_REFRESH_MS     = 60 * 60 * 1000; // re-fetch symbol list every hour
const FLUSH_INTERVAL_MS     = 1000;       // write metrics to Redis once per second
const SUMMARY_LOG_INTERVAL  = 30;        // print aggregation summary every N seconds
const BUCKET_COUNT          = 60;        // rolling window: 60 one-second buckets
const MINUTE_BUCKET_COUNT   = 60;        // rolling window: 60 one-minute buckets (1h max)
const SIGNAL_HISTORY_SIZE   = 60;        // keep last 60 metric snapshots for baseline

// Kline intervals subscribed by the collector for chart streaming
const KLINE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];

// ─── Signal stabilization constants ─────────────────────────────
const BASELINE_MIN_VOL60    = 1000;   // min USDT baseline for 60s vol ratio
const BASELINE_MIN_VOL15    = 200;    // min USDT baseline for 15s vol ratio
const BASELINE_MIN_COUNT60  = 5;      // min trade count baseline
const RATIO_CAP             = 20;     // max value for spike ratios
const ACCEL_CAP             = 20;     // max value for tradeAcceleration
const WARMUP_SNAPSHOTS      = 30;     // # snapshots before baselineReady
const LIQUIDITY_MIN_VOL60   = 5000;   // min vol60s USDT for ranking eligibility
const LIQUIDITY_MIN_COUNT60 = 20;     // min trade count for ranking eligibility

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => console.log('[collector] Connected to Redis'));
redis.on('error',   (err) => console.error('[collector] Redis error:', err.message));

// ─── REST helper ─────────────────────────────────────────────────
async function fetchJSON(url, service, symbol, reason) {
  const res = await binanceFetch(url, undefined, service || 'collector', symbol || '*', reason || '');
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ─── Stablecoin filter ───────────────────────────────────────────
const STABLECOIN_BASES = new Set([
  'USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP',
  'USD1', 'PYUSD', 'USDS', 'EURI',
]);

function isStablecoin(asset) {
  return STABLECOIN_BASES.has(asset);
}

// ─── Symbol fetching & filtering ─────────────────────────────────
async function fetchValidSymbols() {
  console.log('[collector] Fetching futures exchangeInfo from Binance...');
  const exchangeInfo = await fetchJSON(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`, 'collector', '*', 'exchangeInfo');

  // Build map: symbol → baseAsset for all TRADING USDT futures perpetuals
  const tradingMap = new Map(); // symbol → baseAsset
  for (const s of exchangeInfo.symbols) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
      tradingMap.set(s.symbol, s.baseAsset);
    }
  }
  console.log(`[collector] futures exchangeInfo: ${exchangeInfo.symbols.length} total, ${tradingMap.size} active USDT futures`);

  console.log('[collector] Fetching futures ticker/24hr from Binance...');
  const tickers = await fetchJSON(`${BINANCE_REST_BASE}/fapi/v1/ticker/24hr`, 'collector', '*', 'ticker24hr');

  const now = Date.now();
  const STALE_MS = 4 * 60 * 60 * 1000; // 4h — SETTLING contracts have stale closeTime
  const validSymbols = [];
  let excludedStatus     = 0;
  let excludedVolume     = 0;
  let excludedStablecoin = 0;
  let excludedStale      = 0;

  for (const ticker of tickers) {
    const baseAsset = tradingMap.get(ticker.symbol);
    if (baseAsset === undefined) { excludedStatus++; continue; }
    if (isStablecoin(baseAsset)) { excludedStablecoin++; continue; }
    if (ticker.closeTime && Number(ticker.closeTime) < now - STALE_MS) { excludedStale++; continue; }
    const quoteVolume = parseFloat(ticker.quoteVolume);
    if (isNaN(quoteVolume) || quoteVolume < MIN_QUOTE_VOLUME) { excludedVolume++; continue; }
    validSymbols.push(ticker.symbol);
  }

  console.log(
    `[collector] Futures symbol filter: valid=${validSymbols.length}` +
    ` excluded(status=${excludedStatus} stablecoin=${excludedStablecoin}` +
    ` stale=${excludedStale} volume<${MIN_QUOTE_VOLUME}=${excludedVolume})`,
  );
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

// ─── Spot in-memory state ─────────────────────────────────────────
const spotStates = new Map();

function getOrCreateSpotState(symbol) {
  if (!spotStates.has(symbol)) {
    spotStates.set(symbol, {
      symbol,
      lastPrice:          0,
      lastTradeTime:      0,
      currentBucket:      null,
      secondBuckets:      [],
      currentMinuteBucket: null,
      minuteBuckets:       [],
      signalHistory:      [],
    });
  }
  return spotStates.get(symbol);
}

// Spot aggTrade handler — same logic as onTrade but uses spotStates
function onSpotTrade(msg) {
  const symbol         = (msg.s || '').toUpperCase();
  const price          = Number(msg.p);
  const qty            = Number(msg.q);
  const tradeTime      = msg.T;
  const isMakerSell    = msg.m === true;
  const tradeValueUsdt = price * qty;
  const tradeSec       = Math.floor(tradeTime / 1000);

  if (!symbol || !price || !qty) return;

  const state = getOrCreateSpotState(symbol);
  state.lastPrice     = price;
  state.lastTradeTime = tradeTime;

  // ── second bucket management (spot) ─────────────────────────────
  if (!state.currentBucket || state.currentBucket.tsSec !== tradeSec) {
    if (state.currentBucket) {
      state.secondBuckets.push(state.currentBucket);
      if (state.secondBuckets.length > BUCKET_COUNT) state.secondBuckets.shift();
    }
    state.currentBucket = makeBucket(tradeSec);
  }

  // ── second bucket update (spot) ─────────────────────────────
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
  if (b.highPrice === null || price > b.highPrice) b.highPrice = price;
  if (b.lowPrice  === null || price < b.lowPrice)  b.lowPrice  = price;

  // ── minute bucket update (spot) ──────────────────────────────
  const tradeMinSpot = Math.floor(Math.floor(msg.T / 1000) / 60);
  if (!state.currentMinuteBucket || state.currentMinuteBucket.tsMin !== tradeMinSpot) {
    if (state.currentMinuteBucket) {
      state.minuteBuckets.push(state.currentMinuteBucket);
      if (state.minuteBuckets.length > MINUTE_BUCKET_COUNT) state.minuteBuckets.shift();
    }
    state.currentMinuteBucket = makeMinuteBucket(tradeMinSpot);
  }
  const mbSpot = state.currentMinuteBucket;
  mbSpot.volumeUsdt   += tradeValueUsdt;
  mbSpot.tradeCount   += 1;
  if (isMakerSell) mbSpot.sellVolumeUsdt += tradeValueUsdt;
  else             mbSpot.buyVolumeUsdt  += tradeValueUsdt;
}

function makeBucket(tsSec) {
  return {
    tsSec,
    volumeUsdt:     0,
    buyVolumeUsdt:  0,
    sellVolumeUsdt: 0,
    tradeCount:     0,
    openPrice:      null,
    closePrice:     null,
    highPrice:      null,
    lowPrice:       null,
  };
}

function makeMinuteBucket(tsMin) {
  return {
    tsMin,
    volumeUsdt:     0,
    buyVolumeUsdt:  0,
    sellVolumeUsdt: 0,
    tradeCount:     0,
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
      currentMinuteBucket: null, // current in-flight minute bucket
      minuteBuckets:       [],   // completed minute buckets, max MINUTE_BUCKET_COUNT
      signalHistory:      [],   // last SIGNAL_HISTORY_SIZE snapshots for baseline
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

  // ── second bucket management ──────────────────────────────────
  if (!state.currentBucket || state.currentBucket.tsSec !== tradeSec) {
    if (state.currentBucket) {
      state.secondBuckets.push(state.currentBucket);
      if (state.secondBuckets.length > BUCKET_COUNT) state.secondBuckets.shift();
    }
    state.currentBucket = makeBucket(tradeSec);
  }

  // ── minute bucket management ──────────────────────────────────
  const tradeMin = Math.floor(tradeSec / 60);
  if (!state.currentMinuteBucket || state.currentMinuteBucket.tsMin !== tradeMin) {
    if (state.currentMinuteBucket) {
      state.minuteBuckets.push(state.currentMinuteBucket);
      if (state.minuteBuckets.length > MINUTE_BUCKET_COUNT) state.minuteBuckets.shift();
    }
    state.currentMinuteBucket = makeMinuteBucket(tradeMin);
  }

  // ── update current second bucket ──────────────────────────────
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
  if (b.highPrice === null || price > b.highPrice) b.highPrice = price;
  if (b.lowPrice  === null || price < b.lowPrice)  b.lowPrice  = price;

  // ── update current minute bucket ──────────────────────────────
  const mb = state.currentMinuteBucket;
  mb.volumeUsdt   += tradeValueUsdt;
  mb.tradeCount   += 1;
  if (isMakerSell) mb.sellVolumeUsdt += tradeValueUsdt;
  else             mb.buyVolumeUsdt  += tradeValueUsdt;
}

// ─── Window aggregation helpers ───────────────────────────────────
function sumBuckets(buckets) {
  let volumeUsdt     = 0;
  let buyVolumeUsdt  = 0;
  let sellVolumeUsdt = 0;
  let tradeCount     = 0;
  let openPrice      = null;
  let closePrice     = null;
  let highPrice      = null;
  let lowPrice       = null;

  for (const b of buckets) {
    volumeUsdt     += b.volumeUsdt;
    buyVolumeUsdt  += b.buyVolumeUsdt;
    sellVolumeUsdt += b.sellVolumeUsdt;
    tradeCount     += b.tradeCount;
    if (openPrice  === null && b.openPrice  !== null) openPrice  = b.openPrice;
    if (b.closePrice !== null) closePrice = b.closePrice;
    if (b.highPrice !== null && (highPrice === null || b.highPrice > highPrice)) highPrice = b.highPrice;
    if (b.lowPrice  !== null && (lowPrice  === null || b.lowPrice  < lowPrice))  lowPrice  = b.lowPrice;
  }

  return { volumeUsdt, buyVolumeUsdt, sellVolumeUsdt, tradeCount, openPrice, closePrice, highPrice, lowPrice };
}

function computeActivityScore(vol60, count60, priceChangePct60) {
  // Simple composite: volume weight + trade frequency + price movement
  return (vol60 * 0.5) + (count60 * 10) + (Math.abs(priceChangePct60) * 1000);
}

// ═══════════════════════════════════════════════════════════════════
//  DERIVED SIGNAL METRICS
// ═══════════════════════════════════════════════════════════════════

const EPSILON = 1e-9; // avoid division by zero

function avgField(history, field) {
  if (history.length === 0) return 0;
  let sum = 0;
  for (const s of history) sum += (s[field] || 0);
  return sum / history.length;
}

function cap(value, max) {
  return Math.min(value, max);
}

function computeSignalConfidence(signalHistory, snapshot) {
  let score = 0;
  // Warmup: full confidence only after WARMUP_SNAPSHOTS
  if (signalHistory.length >= WARMUP_SNAPSHOTS) score += 50;
  else score += Math.round((signalHistory.length / WARMUP_SNAPSHOTS) * 50);
  // Liquidity
  if (snapshot.volumeUsdt60s >= LIQUIDITY_MIN_VOL60) score += 30;
  else score += Math.round((snapshot.volumeUsdt60s / LIQUIDITY_MIN_VOL60) * 30);
  if (snapshot.tradeCount60s >= LIQUIDITY_MIN_COUNT60) score += 20;
  else score += Math.round((snapshot.tradeCount60s / LIQUIDITY_MIN_COUNT60) * 20);
  return score; // 0–100
}

function computeInPlayScore(vsr60, vsr15, tradeAcc, pricePct60, deltaImb) {
  return (
    (vsr60 * 40) +
    (vsr15 * 30) +
    (tradeAcc * 20) +
    (Math.abs(pricePct60) * 50) +
    (Math.abs(deltaImb) * 100)
  );
}

function computeImpulseScore(vsr15, tradeAcc, deltaImb, priceVel, pricePct60) {
  return (
    (vsr15 * 35) +
    (tradeAcc * 25) +
    (Math.abs(deltaImb) * 120) +
    (Math.abs(priceVel) * 5000) +
    (Math.abs(pricePct60) * 80)
  );
}

function buildSignal(snapshot, signalHistory, nowMs) {
  const histLen = signalHistory.length;
  const baselineReady = histLen >= WARMUP_SNAPSHOTS;

  const rawAvgVol60  = avgField(signalHistory, 'volumeUsdt60s');
  const rawAvgVol15  = avgField(signalHistory, 'volumeUsdt15s');
  const rawAvgCnt60  = avgField(signalHistory, 'tradeCount60s');

  // Apply minimum baselines to prevent division explosions
  const avgVol60 = Math.max(rawAvgVol60, BASELINE_MIN_VOL60);
  const avgVol15 = Math.max(rawAvgVol15, BASELINE_MIN_VOL15);
  const avgCnt60 = Math.max(rawAvgCnt60, BASELINE_MIN_COUNT60);

  // Capped ratios
  const vsr60 = cap(snapshot.volumeUsdt60s / avgVol60, RATIO_CAP);
  const vsr15 = cap(snapshot.volumeUsdt15s / avgVol15, RATIO_CAP);

  // tradeAcceleration: current 5s trade rate vs expected 5s rate derived from 60s average
  const expectedPer5s = avgCnt60 / 12;
  const tradeAcc      = cap(snapshot.tradeCount5s / Math.max(expectedPer5s, EPSILON), ACCEL_CAP);

  // deltaImbalance: clamped to [-1, 1]
  const vol60    = Math.max(snapshot.volumeUsdt60s, EPSILON);
  const deltaImb = Math.max(-1, Math.min(1, snapshot.deltaUsdt60s / vol60));
  const priceVel = snapshot.priceChangePct60s / 60;

  // Liquidity gate: don't produce meaningful scores for illiquid snapshots
  const liquidityOk = snapshot.volumeUsdt60s >= LIQUIDITY_MIN_VOL60 &&
                      snapshot.tradeCount60s  >= LIQUIDITY_MIN_COUNT60;

  const inPlayScore  = liquidityOk
    ? computeInPlayScore(vsr60, vsr15, tradeAcc, snapshot.priceChangePct60s, deltaImb)
    : 0;
  const impulseScore = liquidityOk
    ? computeImpulseScore(vsr15, tradeAcc, deltaImb, priceVel, snapshot.priceChangePct60s)
    : 0;

  let impulseDirection = 'mixed';
  if (snapshot.priceChangePct60s > 0 && deltaImb > 0) impulseDirection = 'up';
  else if (snapshot.priceChangePct60s < 0 && deltaImb < 0) impulseDirection = 'down';

  const signalConfidence = computeSignalConfidence(signalHistory, snapshot);

  return {
    symbol:               snapshot.symbol,
    baselineReady,
    signalConfidence,
    volumeSpikeRatio60s:  vsr60,
    volumeSpikeRatio15s:  vsr15,
    tradeAcceleration:    tradeAcc,
    deltaImbalancePct60s: deltaImb,
    priceVelocity60s:     priceVel,
    inPlayScore,
    impulseScore,
    impulseDirection,
    updatedAt:            nowMs,
  };
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

  // Minute-level windows (5m / 15m / 30m / 60m)
  const allMinBuckets = state.currentMinuteBucket
    ? [...state.minuteBuckets, state.currentMinuteBucket]
    : [...state.minuteBuckets];
  const mTotal = allMinBuckets.length;
  const m5  = mTotal >= 1  ? sumBuckets(allMinBuckets.slice(Math.max(0, mTotal - 5)))  : null;
  const m15 = mTotal >= 1  ? sumBuckets(allMinBuckets.slice(Math.max(0, mTotal - 15))) : null;
  const m30 = mTotal >= 1  ? sumBuckets(allMinBuckets.slice(Math.max(0, mTotal - 30))) : null;
  const m60 = mTotal >= 1  ? sumBuckets(allMinBuckets.slice(Math.max(0, mTotal - 60))) : null;

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
    open60s:           w60.openPrice,
    high60s:           w60.highPrice,
    low60s:            w60.lowPrice,
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
    // Minute-level volume windows (null until enough minute buckets accumulate)
    volumeUsdt5m:      m5  ? m5.volumeUsdt  : null,
    volumeUsdt15m:     m15 ? m15.volumeUsdt : null,
    volumeUsdt30m:     m30 ? m30.volumeUsdt : null,
    volumeUsdt60m:     m60 ? m60.volumeUsdt : null,
    buyVolumeUsdt5m:   m5  ? m5.buyVolumeUsdt  : null,
    buyVolumeUsdt15m:  m15 ? m15.buyVolumeUsdt : null,
    buyVolumeUsdt30m:  m30 ? m30.buyVolumeUsdt : null,
    buyVolumeUsdt60m:  m60 ? m60.buyVolumeUsdt : null,
    sellVolumeUsdt5m:  m5  ? m5.sellVolumeUsdt  : null,
    sellVolumeUsdt15m: m15 ? m15.sellVolumeUsdt : null,
    sellVolumeUsdt30m: m30 ? m30.sellVolumeUsdt : null,
    sellVolumeUsdt60m: m60 ? m60.sellVolumeUsdt : null,
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

    // Used for summary log
    let topInPlay   = { symbol: '', score: -1 };
    let topImpulse  = { symbol: '', score: -1 };
    const topInPlayList  = [];
    const topImpulseList = [];

    // ── Futures flush ──────────────────────────────────────────────
    for (const state of symbolStates.values()) {
      if (state.lastTradeTime === 0) continue; // no trades yet

      const snapshot = buildSnapshot(state, nowMs);
      pipeline.set(`metrics:${state.symbol}`, JSON.stringify(snapshot));
      pipeline.set(`price:${state.symbol}`, String(state.lastPrice));

      // Build signal from history, then append current snapshot to history
      const signal = buildSignal(snapshot, state.signalHistory, nowMs);
      pipeline.set(`signal:${state.symbol}`, JSON.stringify(signal));

      // Update signal history (append current snapshot, trim to SIGNAL_HISTORY_SIZE)
      state.signalHistory.push({
        volumeUsdt60s:     snapshot.volumeUsdt60s,
        volumeUsdt15s:     snapshot.volumeUsdt15s,
        tradeCount60s:     snapshot.tradeCount60s,
      });
      if (state.signalHistory.length > SIGNAL_HISTORY_SIZE) {
        state.signalHistory.shift();
      }

      snapshotCount++;

      if (flushCount % SUMMARY_LOG_INTERVAL === SUMMARY_LOG_INTERVAL - 1) {
        topInPlayList.push({ symbol: state.symbol, score: signal.inPlayScore });
        topImpulseList.push({ symbol: state.symbol, score: signal.impulseScore });
      }
    }

    // ── Spot flush ────────────────────────────────────────────────
    for (const state of spotStates.values()) {
      if (state.lastTradeTime === 0) continue;

      const snapshot = buildSnapshot(state, nowMs);
      pipeline.set(`spot:metrics:${state.symbol}`, JSON.stringify(snapshot));
      pipeline.set(`spot:price:${state.symbol}`, String(state.lastPrice));

      const signal = buildSignal(snapshot, state.signalHistory, nowMs);
      pipeline.set(`spot:signal:${state.symbol}`, JSON.stringify(signal));

      state.signalHistory.push({
        volumeUsdt60s: snapshot.volumeUsdt60s,
        volumeUsdt15s: snapshot.volumeUsdt15s,
        tradeCount60s: snapshot.tradeCount60s,
      });
      if (state.signalHistory.length > SIGNAL_HISTORY_SIZE) state.signalHistory.shift();

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
      topInPlayList.sort((a, b) => b.score - a.score);
      topImpulseList.sort((a, b) => b.score - a.score);
      const top3InPlay   = topInPlayList.slice(0, 3).map(x => `${x.symbol}(${x.score.toFixed(1)})`).join(', ');
      const top3Impulse  = topImpulseList.slice(0, 3).map(x => `${x.symbol}(${x.score.toFixed(1)})`).join(', ');
      console.log(
        `[aggregator] Summary: ${snapshotCount} snapshots flushed` +
        ` | top in-play: ${top3InPlay}` +
        ` | top impulse: ${top3Impulse}`,
      );
    }
  }, FLUSH_INTERVAL_MS);
}

// ─── WebSocket batches ───────────────────────────────────────────
const batchSockets = [];

// ─── Spot symbol fetching ─────────────────────────────────────────
async function fetchValidSpotSymbols() {
  console.log('[spot-collector] Fetching spot exchangeInfo from Binance...');
  const exchangeInfo = await fetchJSON(
    `${SPOT_REST_BASE}/api/v3/exchangeInfo`,
    'collector-spot', '*', 'exchangeInfo',
  );

  const tradingMap = new Map();
  for (const s of exchangeInfo.symbols) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed) {
      tradingMap.set(s.symbol, s.baseAsset);
    }
  }
  console.log(`[spot-collector] exchangeInfo: ${tradingMap.size} active USDT spot pairs`);

  console.log('[spot-collector] Fetching spot ticker/24hr from Binance...');
  const tickers = await fetchJSON(
    `${SPOT_REST_BASE}/api/v3/ticker/24hr`,
    'collector-spot', '*', 'ticker24hr',
  );

  const validSymbols = [];
  let excludedVolume = 0, excludedStablecoin = 0, excludedStatus = 0;

  for (const ticker of tickers) {
    const baseAsset = tradingMap.get(ticker.symbol);
    if (!baseAsset) { excludedStatus++; continue; }
    if (isStablecoin(baseAsset)) { excludedStablecoin++; continue; }
    const qv = parseFloat(ticker.quoteVolume);
    if (isNaN(qv) || qv < SPOT_MIN_QUOTE_VOLUME) { excludedVolume++; continue; }
    validSymbols.push(ticker.symbol);
  }

  console.log(
    `[spot-collector] Spot symbol filter: valid=${validSymbols.length}` +
    ` excluded(status=${excludedStatus} stablecoin=${excludedStablecoin}` +
    ` volume<${SPOT_MIN_QUOTE_VOLUME}=${excludedVolume})`,
  );
  return validSymbols;
}

// ─── Spot WebSocket batches ───────────────────────────────────────
const spotBatchSockets = [];

function connectSpotBatch(batchIndex, symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}@aggTrade`).join('/');
  const url     = `${SPOT_WS_BASE}/stream?streams=${streams}`;

  console.log(`[spot-collector] Batch ${batchIndex + 1}: connecting (${symbols.length} streams)`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[spot-collector] Batch ${batchIndex + 1}: connected`);
  });

  ws.on('message', (raw) => {
    try {
      const envelope = JSON.parse(raw);
      const msg      = envelope.data;
      if (!msg || !msg.s) return;
      onSpotTrade(msg);
    } catch (err) {
      console.error('[spot-collector] Parse error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error(`[spot-collector] Batch ${batchIndex + 1} WS error:`, err.message);
  });

  ws.on('close', (code) => {
    console.warn(`[spot-collector] Batch ${batchIndex + 1} closed (code=${code}). Reconnecting in 5s...`);
    setTimeout(() => connectSpotBatch(batchIndex, symbols), 5000);
  });

  spotBatchSockets[batchIndex] = ws;
}

// ─── Spot collector startup ───────────────────────────────────────
async function startSpotCollector() {
  // Delay to let futures REST burst complete first (avoids IP rate limit overlap)
  console.log(`[spot-collector] Startup delayed by ${SPOT_STARTUP_DELAY_MS / 1000}s...`);
  await new Promise(resolve => setTimeout(resolve, SPOT_STARTUP_DELAY_MS));

  // Respect any active IP ban before hitting REST
  try {
    const rawBanState = await redis.get('debug:binance-rate-limit-state');
    if (rawBanState) {
      const banState    = JSON.parse(rawBanState);
      const now         = Date.now();
      const bannedUntil = Math.max(
        banState.spot?.backoffUntilTs    || 0,
        banState.futures?.backoffUntilTs || 0,
      );
      if (bannedUntil > now) {
        const waitMs = bannedUntil - now;
        console.warn(`[spot-collector] IP ban active — delaying ${Math.ceil(waitMs / 1000)}s`);
        await new Promise(resolve => setTimeout(resolve, waitMs + 2000));
      }
    }
  } catch (_) { /* Redis not ready — proceed */ }

  let spotSymbols;
  try {
    spotSymbols = await fetchValidSpotSymbols();
  } catch (err) {
    console.error('[spot-collector] Failed to fetch spot symbols:', err.message);
    console.log('[spot-collector] Retrying in 30s...');
    setTimeout(startSpotCollector, 30000);
    return;
  }

  if (spotSymbols.length === 0) {
    console.warn('[spot-collector] No valid spot symbols found. Skipping.');
    return;
  }

  await redis.set('spot:symbols:active:usdt', JSON.stringify(spotSymbols));
  console.log(`[spot-collector] Saved ${spotSymbols.length} spot symbols to Redis (key: spot:symbols:active:usdt)`);

  for (const sym of spotSymbols) getOrCreateSpotState(sym);
  console.log(`[spot-collector] Pre-initialized state for ${spotSymbols.length} spot symbols`);

  const batches = chunkArray(spotSymbols, SPOT_STREAMS_PER_BATCH);
  console.log(`[spot-collector] Opening ${batches.length} WS batch(es) of up to ${SPOT_STREAMS_PER_BATCH} streams each`);
  for (let i = 0; i < batches.length; i++) {
    connectSpotBatch(i, batches[i]);
  }

  // Start spot kline collector (publishes to Redis pub/sub for chart streaming)
  startSpotKlineCollector(spotSymbols);

  // Hourly symbol list refresh
  setInterval(async () => {
    try {
      const rawBanState = await redis.get('debug:binance-rate-limit-state').catch(() => null);
      if (rawBanState) {
        const banState    = JSON.parse(rawBanState);
        const now         = Date.now();
        const bannedUntil = Math.max(
          banState.spot?.backoffUntilTs    || 0,
          banState.futures?.backoffUntilTs || 0,
        );
        if (bannedUntil > now) {
          console.warn('[spot-collector] Symbol refresh skipped — IP ban active');
          return;
        }
      }
      const refreshed = await fetchValidSpotSymbols();
      await redis.set('spot:symbols:active:usdt', JSON.stringify(refreshed));
      for (const sym of refreshed) getOrCreateSpotState(sym);
      console.log(`[spot-collector] Symbol list refreshed: ${refreshed.length} active symbols`);
    } catch (err) {
      console.error('[spot-collector] Symbol refresh failed:', err.message);
    }
  }, SYMBOL_REFRESH_MS);
}

function connectBatch(batchIndex, symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}@aggTrade`).join('/');
  const url     = `${BINANCE_WS_BASE}/stream?streams=${streams}`;

  console.log(`[collector] Batch ${batchIndex + 1}: connecting (${symbols.length} streams)`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[collector] Batch ${batchIndex + 1}: connected`);
  });

  ws.on('message', (raw) => {
    try {
      // Combined stream envelope: { stream: "btcusdt@aggTrade", data: { ... } }
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

function connectFuturesAggTradeBatch(symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}@aggTrade`).join('/');
  const url     = `${BINANCE_WS_BASE}/stream?streams=${streams}`;

  console.log(`[collector] Futures aggTrade: connecting ${symbols.length} streams (${symbols.join(',')})`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[collector] Futures aggTrade: connected (${symbols.length} symbols)`);
  });

  ws.on('message', (raw) => {
    try {
      // Futures combined stream: { stream: "...", data: { ... } }
      const envelope = JSON.parse(raw);
      const msg      = envelope.data;
      if (!msg || !msg.s) return;
      // futures aggTrade format matches spot trade format — feed into same handler
      onTrade(msg);
      const symbol = msg.s.toUpperCase();
      redis.set(`trade:${symbol}:last`, JSON.stringify(msg)).catch(() => {});
    } catch (err) {
      console.error('[collector] Futures aggTrade parse error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error(`[collector] Futures aggTrade WS error:`, err.message);
  });

  ws.on('close', (code) => {
    console.warn(`[collector] Futures aggTrade WS closed (code=${code}). Reconnecting in 5s...`);
    setTimeout(() => connectFuturesAggTradeBatch(symbols), 5000);
  });
}

const futuresAggTradeSet = new Set();

async function startFuturesAggTradeCollector(spotSymbolSet) {
  // Retry up to 6 times (30s) — universe builder might not have run yet
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const raw    = await redis.get('tracked:futures:symbols');
      if (!raw) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const parsed = JSON.parse(raw);
      const allFutures = Array.isArray(parsed) ? parsed : (parsed?.symbols ?? []);
      const nonSpot    = allFutures.filter(s => !spotSymbolSet.has(s) && !futuresAggTradeSet.has(s));
      if (nonSpot.length > 0) {
        for (const s of nonSpot) { futuresAggTradeSet.add(s); getOrCreateState(s); }
        const batches = chunkArray(nonSpot, 20);
        for (const batch of batches) connectFuturesAggTradeBatch(batch);
        console.log(`[collector] Futures aggTrade: subscribed to ${nonSpot.length} non-spot symbols: ${nonSpot.join(', ')}`);
      } else {
        console.log('[collector] Futures aggTrade: all tracked futures symbols have spot coverage');
      }
      return;
    } catch (err) {
      console.error('[collector] startFuturesAggTradeCollector error:', err.message);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.warn('[collector] Futures aggTrade: tracked:futures:symbols not available — skipping');
}

// ─── Kline pub/sub — collector subscribes to Binance, publishes to Redis ────────
// Backend WS gateway reads from Redis pub/sub instead of proxying to Binance.
// This ensures Binance sees only collector connections regardless of user count.

function connectFuturesKlineBatch(batchIdx, symbols, interval) {
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_${interval}`).join('/');
  const url     = `${BINANCE_WS_BASE}/stream?streams=${streams}`;
  console.log(`[kline-collector] futures/${interval} batch${batchIdx + 1}: connecting (${symbols.length} symbols)`);
  const ws = new WebSocket(url);
  ws.on('open', () => console.log(`[kline-collector] futures/${interval} batch${batchIdx + 1}: connected`));
  ws.on('message', (raw) => {
    try {
      const envelope = JSON.parse(raw);
      const msg = envelope.data;
      if (!msg || msg.e !== 'kline') return;
      const channel = `kline:futures:${msg.s.toUpperCase()}:${msg.k.i}`;
      const payload = JSON.stringify(msg); // single-stream format: { e, k, s } — matches what frontend expects
      redis.publish(channel, payload).catch(() => {});
      redis.set(`${channel}:last`, payload, 'EX', 300).catch(() => {});
    } catch (err) {
      console.error('[kline-collector] futures parse error:', err.message);
    }
  });
  ws.on('error', (err) => console.error(`[kline-collector] futures/${interval} batch${batchIdx + 1} error:`, err.message));
  ws.on('close', (code) => {
    console.warn(`[kline-collector] futures/${interval} batch${batchIdx + 1} closed (code=${code}). Reconnecting in 5s...`);
    setTimeout(() => connectFuturesKlineBatch(batchIdx, symbols, interval), 5000);
  });
}

function startFuturesKlineCollector(symbols) {
  const batches = chunkArray(symbols, STREAMS_PER_BATCH);
  for (const interval of KLINE_INTERVALS) {
    for (let i = 0; i < batches.length; i++) {
      connectFuturesKlineBatch(i, batches[i], interval);
    }
  }
  console.log(
    `[kline-collector] Futures kline started: ${KLINE_INTERVALS.length} intervals × ` +
    `${batches.length} batch(es) = ${KLINE_INTERVALS.length * batches.length} WS connections`,
  );
}

function connectSpotKlineBatch(batchIdx, symbols, interval) {
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_${interval}`).join('/');
  const url     = `${SPOT_WS_BASE}/stream?streams=${streams}`;
  console.log(`[kline-collector] spot/${interval} batch${batchIdx + 1}: connecting (${symbols.length} symbols)`);
  const ws = new WebSocket(url);
  ws.on('open', () => console.log(`[kline-collector] spot/${interval} batch${batchIdx + 1}: connected`));
  ws.on('message', (raw) => {
    try {
      const envelope = JSON.parse(raw);
      const msg = envelope.data;
      if (!msg || msg.e !== 'kline') return;
      const channel = `kline:spot:${msg.s.toUpperCase()}:${msg.k.i}`;
      const payload = JSON.stringify(msg);
      redis.publish(channel, payload).catch(() => {});
      redis.set(`${channel}:last`, payload, 'EX', 300).catch(() => {});
    } catch (err) {
      console.error('[kline-collector] spot parse error:', err.message);
    }
  });
  ws.on('error', (err) => console.error(`[kline-collector] spot/${interval} batch${batchIdx + 1} error:`, err.message));
  ws.on('close', (code) => {
    console.warn(`[kline-collector] spot/${interval} batch${batchIdx + 1} closed (code=${code}). Reconnecting in 5s...`);
    setTimeout(() => connectSpotKlineBatch(batchIdx, symbols, interval), 5000);
  });
}

function startSpotKlineCollector(symbols) {
  const batches = chunkArray(symbols, SPOT_STREAMS_PER_BATCH);
  for (const interval of KLINE_INTERVALS) {
    for (let i = 0; i < batches.length; i++) {
      connectSpotKlineBatch(i, batches[i], interval);
    }
  }
  console.log(
    `[kline-collector] Spot kline started: ${KLINE_INTERVALS.length} intervals × ` +
    `${batches.length} batch(es) = ${KLINE_INTERVALS.length * batches.length} WS connections`,
  );
}

// ─── REST kline fallback — activates when futures WS kline is stale ────────────
// Polls fapi.binance.com/fapi/v1/klines when no kline:futures:* data appears in
// Redis for STALE_THRESHOLD_MS. Publishes in the same WS-event format so the
// backend proxy and bar-aggregator-service work transparently.

const KLINE_REST_STALE_MS      = 2 * 60 * 1000;   // 2 min without WS data → switch to REST
const KLINE_REST_POLL_MS       = 5_000;             // check interval; actual polling uses priority tiers
const KLINE_REST_INTERVALS     = ['1m'];             // only 1m — bar aggregator needs it; others via WS
const KLINE_REST_CONCURRENCY   = 8;                 // max parallel REST requests per chunk
const KLINE_REST_CHUNK_DELAY   = 250;               // ms between chunks to spread load

// Top symbols polled every ~5s; all others polled every ~60s (one per cycle)
const KLINE_REST_HOT_SYMBOLS   = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT',
  'AVAXUSDT','DOTUSDT','TRXUSDT','LINKUSDT','MATICUSDT','LTCUSDT','UNIUSDT',
  'BCHUSDT','ETCUSDT','XLMUSDT','ATOMUSDT','NEARUSDT','OPUSDT','ARBUSDT',
  'INJUSDT','SUIUSDT','APTUSDT','SEIUSDT','TIAUSDT','WIFUSDT','PEPEUSDT',
  'FLOKIUSDT','BONKUSDT',
];

let _klineRestFallbackActive = false;
let _klineRestIntervalId     = null;

async function _pollFuturesKlineRestBatch(symbols, interval) {
  // Process in chunks with delay to stay well within Binance rate limits
  for (let i = 0; i < symbols.length; i += KLINE_REST_CONCURRENCY) {
    const chunk = symbols.slice(i, i + KLINE_REST_CONCURRENCY);
    await Promise.all(chunk.map(async (sym) => {
      try {
        const url  = `${BINANCE_REST_BASE}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=2`;
        const data = await binanceFetch(url, undefined, 'kline-rest-fallback', sym, 'klinePoll').then(r => r.json());
        if (!Array.isArray(data) || data.length === 0) return;
        const row = data[data.length - 1]; // last (possibly open) candle
        // REST format: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
        const isClosed = Date.now() > Number(row[6]);
        const msg = {
          e: 'kline',
          E: Date.now(),
          s: sym,
          k: {
            t: Number(row[0]),
            T: Number(row[6]),
            s: sym,
            i: interval,
            f: 0,
            L: 0,
            o: row[1],
            c: row[4],
            h: row[2],
            l: row[3],
            v: row[5],
            n: Number(row[8]),
            x: isClosed,
            q: row[7],
            V: row[9],
            Q: row[10],
            B: '0',
          },
        };
        const payload = JSON.stringify(msg);
        const channel = `kline:futures:${sym}:${interval}`;
        await Promise.all([
          redis.publish(channel, payload).catch(() => {}),
          redis.set(`${channel}:last`, payload, 'EX', 300).catch(() => {}),
        ]);
      } catch (_err) {
        // silently skip per-symbol errors; stale data is better than crashing
      }
    }));
    // Throttle: wait between chunks to avoid bursting Binance rate limit
    if (i + KLINE_REST_CONCURRENCY < symbols.length) {
      await new Promise(r => setTimeout(r, KLINE_REST_CHUNK_DELAY));
    }
  }
}

async function _runFuturesKlineRestPoll(symbols) {
  for (const interval of KLINE_REST_INTERVALS) {
    await _pollFuturesKlineRestBatch(symbols, interval);
  }
}

function startFuturesKlineRestFallback(getSymbolsFn) {
  if (_klineRestIntervalId) return; // already running
  console.log('[kline-rest-fallback] Scheduler started — will activate when WS is stale');

  let _coldCycleIdx = 0; // rotating index into cold symbols for round-robin batch

  // Sentinel: check BTCUSDT 1m key freshness every poll cycle
  _klineRestIntervalId = setInterval(async () => {
    try {
      const lastKey = 'kline:futures:BTCUSDT:1m:last';
      const raw     = await redis.get(lastKey).catch(() => null);
      let stale     = true;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const age    = Date.now() - (parsed.E || 0);
          stale = age > KLINE_REST_STALE_MS;
        } catch { /* stale = true */ }
      }

      if (stale) {
        if (!_klineRestFallbackActive) {
          console.warn('[kline-rest-fallback] WS kline stale — REST fallback now ACTIVE');
          _klineRestFallbackActive = true;
        }
        const allSymbols = await getSymbolsFn();
        if (allSymbols.length === 0) return;

        // Hot symbols: poll every cycle (~5s)
        const hotSet  = new Set(KLINE_REST_HOT_SYMBOLS);
        const hot     = allSymbols.filter(s => hotSet.has(s));
        const cold    = allSymbols.filter(s => !hotSet.has(s));

        // Cold symbols: poll one batch per cycle (round-robin) — full rotation every ~(cold.length/8)*5s
        const coldBatch = cold.slice(_coldCycleIdx, _coldCycleIdx + KLINE_REST_CONCURRENCY);
        _coldCycleIdx   = (_coldCycleIdx + KLINE_REST_CONCURRENCY) % Math.max(cold.length, 1);

        await _runFuturesKlineRestPoll([...hot, ...coldBatch]);
      } else {
        if (_klineRestFallbackActive) {
          console.log('[kline-rest-fallback] WS kline fresh again — REST fallback DEACTIVATED');
          _klineRestFallbackActive = false;
        }
      }
    } catch (err) {
      console.error('[kline-rest-fallback] poll error:', err.message);
    }
  }, KLINE_REST_POLL_MS);
}

// ─── Main startup ────────────────────────────────────────────────
async function start() {
  console.log('[collector] Starting Trackista collector (stage 4)...');
  console.log(`[collector] Redis: ${REDIS_HOST}:${REDIS_PORT}`);

  // Check if a global IP ban is still active before hitting Binance REST on startup.
  // Ban state is persisted by orderbookCollector via binanceRateLimitStateStore.
  try {
    const rawBanState = await redis.get('debug:binance-rate-limit-state');
    if (rawBanState) {
      const banState = JSON.parse(rawBanState);
      const now = Date.now();
      const spotUntil    = banState.spot?.backoffUntilTs    || 0;
      const futuresUntil = banState.futures?.backoffUntilTs || 0;
      const bannedUntil  = Math.max(spotUntil, futuresUntil);
      if (bannedUntil > now) {
        const waitMs = bannedUntil - now;
        console.warn(
          `[collector] IP ban active — delaying startup by ${Math.ceil(waitMs / 1000)}s` +
          ` (until ${new Date(bannedUntil).toISOString()})`,
        );
        setTimeout(start, waitMs + 2000);
        return;
      }
    }
  } catch (_) { /* Redis not ready yet — proceed anyway */ }

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

  // Start spot aggTrade collector (delayed to avoid REST burst overlap with futures)
  startSpotCollector().catch(err => console.error('[spot-collector] Startup error:', err.message));

  // Open one combined WebSocket per batch
  const batches = chunkArray(validSymbols, STREAMS_PER_BATCH);
  console.log(`[collector] Opening ${batches.length} WebSocket batch(es) of up to ${STREAMS_PER_BATCH} streams each`);

  for (let i = 0; i < batches.length; i++) {
    connectBatch(i, batches[i]);
  }

  // Start futures kline collector (publishes to Redis pub/sub for chart streaming)
  startFuturesKlineCollector(validSymbols);

  // Start REST kline fallback — activates automatically when WS kline is stale
  // (e.g. during partial Binance IP ban that blocks kline/aggTrade but allows depth)
  let _cachedFallbackSymbols = validSymbols.slice();
  startFuturesKlineRestFallback(async () => {
    // Try to get fresh symbol list from Redis; fall back to cached list
    try {
      const raw = await redis.get('symbols:active:usdt').catch(() => null);
      if (raw) { _cachedFallbackSymbols = JSON.parse(raw); }
    } catch { /* use cached */ }
    return _cachedFallbackSymbols;
  });

  // Periodically refresh the symbol list in Redis (sockets reconnect on next close)
  setInterval(async () => {
    console.log('[collector] Periodic symbol list refresh...');
    try {
      // Skip refresh if IP ban is active — avoid extending the ban
      const rawBanState = await redis.get('debug:binance-rate-limit-state').catch(() => null);
      if (rawBanState) {
        const banState = JSON.parse(rawBanState);
        const now = Date.now();
        const bannedUntil = Math.max(
          banState.spot?.backoffUntilTs    || 0,
          banState.futures?.backoffUntilTs || 0,
        );
        if (bannedUntil > now) {
          console.warn(
            `[collector] Symbol refresh skipped — IP ban active for ${Math.ceil((bannedUntil - now) / 1000)}s`,
          );
          return;
        }
      }
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

// ─── Spot orderbook collector — DISABLED (collecting futures only) ────────────
// const orderbookCollector = require('./orderbookCollector');
// orderbookCollector.start(redis);

// ─── Futures orderbook collector ──────────────────────────────────
// Maintains a local futures order book using Binance Futures endpoints.
// Symbols: FUTURES_ORDERBOOK_SYMBOLS (falls back to ORDERBOOK_SYMBOLS).
// Writes to Redis keys: futures:orderbook:${symbol}  futures:walls:${symbol}
//
// IMPORTANT: delayed start to avoid 418 IP ban.
// Spot and futures share one Binance IP rate limit bucket.
// Spot starts first (stagger 2000ms × N symbols), futures waits until
// spot's startup REST burst is fully complete before adding its own load.
// FUTURES_STARTUP_DELAY_MS default = 90s (covers spot connecting 100 symbols × 2s = ~200s? no, tracked starts at 20 → first 20×2s=40s, then watcher adds more).
const FUTURES_STARTUP_DELAY_MS = parseInt(process.env.FUTURES_STARTUP_DELAY_MS || '60000', 10);
const futuresOrderbookCollector = require('./futuresOrderbookCollector');
console.log(`[collector] futures orderbook collector will start in ${FUTURES_STARTUP_DELAY_MS / 1000}s to avoid rate-limit burst with spot collector`);
setTimeout(() => futuresOrderbookCollector.start(redis), FUTURES_STARTUP_DELAY_MS);
