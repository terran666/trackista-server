'use strict';
/**
 * densityService.js — Footprint cluster collector for the Density page.
 *
 * Subscribes to Binance Futures aggTrade WebSocket streams to build footprint
 * clusters per symbol/timeframe. DOM (orderbook) is sourced from the collector's
 * Redis key (futures:orderbook:{symbol}) — no duplicate WS connection.
 *
 * Anti-ban principles:
 *   - One aggTrade WS stream per symbol, shared across all users
 *   - REST calls limited to exchangeInfo ONCE at startup
 *   - Hard limit MAX_SYMBOLS concurrent active symbols
 *   - Auto-reconnect with delay on disconnect
 *
 * Redis keys written:
 *   trade:last:{symbol}               TTL 30 s
 *   footprint:{symbol}:{tf}:{barTime} TTL 2 h
 *
 * Events emitted on wsEventBus:
 *   density:dom        { symbol, bids, asks, updatedAt }   — DOM change, ≤200ms
 *   density:lastTrade  { symbol, trade }                   — per aggTrade
 *   density:footprint  { symbol, tf, barTime, price, … }   — per aggTrade (1m only)
 */

const WebSocket = require('ws');

// ─── Config ───────────────────────────────────────────────────────
const ENABLED          = process.env.DOM_ENABLED !== 'false';
const MAX_SYMBOLS      = parseInt(process.env.DOM_MAX_SYMBOLS    || '20',  10);
const LEVELS_ABOVE     = parseInt(process.env.DOM_LEVELS_ABOVE   || '200', 10);
const LEVELS_BELOW     = parseInt(process.env.DOM_LEVELS_BELOW   || '200', 10);
const RECONNECT_DELAY  = 5_000;
const FLUSH_INTERVAL   = 500;    // ms — Redis write cadence
const DOM_POLL_MS      = 200;    // ms — DOM change detection cadence
const MAX_HISTORY_BARS = 30;     // closed bars kept per TF (+ 1 open)
const BAR_TTL_SEC      = 7_200;  // Redis TTL for footprint bars

const BINANCE_WS_BASE   = 'wss://fstream.binance.com';
const BINANCE_REST_BASE = 'https://fapi.binance.com';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h'];
const TF_MS = {
  '1m'  :    60_000,
  '5m'  :   300_000,
  '15m' :   900_000,
  '30m' : 1_800_000,
  '1h'  : 3_600_000,
};

// ─── Wall thresholds (USD notional) ───────────────────────────────
const WALL_THRESHOLDS = new Map([
  ['BTCUSDT',  5_000_000],
  ['ETHUSDT',  4_000_000],
  ['SOLUSDT',  3_000_000],
  ['BNBUSDT',  3_000_000],
  ['XRPUSDT',  3_000_000],
  ['DOGEUSDT', 1_000_000],
]);
const WALL_DEFAULT = 400_000;
function wallThreshold(sym) { return WALL_THRESHOLDS.get(sym) ?? WALL_DEFAULT; }

// ─── Tick sizes (loaded once from exchangeInfo) ───────────────────
const tickSizes = new Map();

async function loadTickSizes() {
  try {
    const res  = await fetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    for (const sym of info.symbols ?? []) {
      const pf = (sym.filters ?? []).find(f => f.filterType === 'PRICE_FILTER');
      if (pf) {
        const ts = parseFloat(pf.tickSize);
        if (isFinite(ts) && ts > 0) tickSizes.set(sym.symbol, ts);
      }
    }
    console.log(`[density] loaded tick sizes for ${tickSizes.size} symbols`);
  } catch (err) {
    console.error('[density] loadTickSizes failed:', err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────
function tickDec(sym) {
  const t = tickSizes.get(sym);
  return t ? (t.toString().split('.')[1] ?? '').length : 5;
}

function normPrice(price, tick) {
  if (!tick || !isFinite(tick) || tick <= 0) return price.toFixed(8);
  const dec = (tick.toString().split('.')[1] ?? '').length;
  return (Math.round(price / tick) * tick).toFixed(dec);
}

function barTime(tsMs, tf) {
  return Math.floor(tsMs / TF_MS[tf]) * TF_MS[tf];
}

// ─── Per-symbol state ─────────────────────────────────────────────
const symbolStates = new Map();

function getOrCreate(symbol) {
  if (!symbolStates.has(symbol)) {
    symbolStates.set(symbol, {
      symbol,
      ws:               null,
      wsOpen:           false,
      deactivated:      false,
      lastTrade:        null,
      lastDomUpdatedAt: 0,
      // footprint[tf] → Map<barTime, BarState>
      footprint: Object.fromEntries(TIMEFRAMES.map(tf => [tf, new Map()])),
    });
  }
  return symbolStates.get(symbol);
}

let _redis    = null;
let _eventBus = null;
const _pendingPersist = new Set();

// ─── Trade processing ─────────────────────────────────────────────
function processTrade(state, event) {
  const sym      = state.symbol;
  const tick     = tickSizes.get(sym) ?? 0.00001;
  const price    = parseFloat(event.p);
  const qty      = parseFloat(event.q);
  const ts       = event.T;          // trade time ms
  const isMaker  = event.m;          // true = buyer is maker → aggressor is seller
  const priceKey = normPrice(price, tick);
  const notional = Math.round(price * qty);

  // Last trade
  state.lastTrade = {
    symbol:    sym,
    price:     priceKey,
    qty:       Math.round(qty),
    notional,
    side:      isMaker ? 'sell' : 'buy',
    timestamp: ts,
  };

  // Build footprint for each timeframe
  for (const tf of TIMEFRAMES) {
    const bt   = barTime(ts, tf);
    const bars = state.footprint[tf];

    if (!bars.has(bt)) {
      bars.set(bt, {
        barTime:       bt,
        prices:        new Map(),
        totalBuyQty:   0,
        totalSellQty:  0,
        totalDeltaQty: 0,
        open:          priceKey,
        high:          price,
        low:           price,
        close:         priceKey,
      });
    }

    const bar = bars.get(bt);
    if (!bar.prices.has(priceKey)) {
      bar.prices.set(priceKey, {
        buyQty: 0, sellQty: 0, deltaQty: 0,
        buyNotional: 0, sellNotional: 0, deltaNotional: 0,
        tradesCount: 0,
      });
    }

    const cell = bar.prices.get(priceKey);
    cell.tradesCount++;
    if (isMaker) {
      cell.sellQty      += Math.round(qty);
      cell.sellNotional += notional;
      bar.totalSellQty  += Math.round(qty);
    } else {
      cell.buyQty       += Math.round(qty);
      cell.buyNotional  += notional;
      bar.totalBuyQty   += Math.round(qty);
    }
    cell.deltaQty      = cell.buyQty      - cell.sellQty;
    cell.deltaNotional = cell.buyNotional - cell.sellNotional;
    bar.totalDeltaQty  = bar.totalBuyQty  - bar.totalSellQty;

    if (price > bar.high)  bar.high  = price;
    if (price < bar.low)   bar.low   = price;
    bar.close = priceKey;

    // Keep at most MAX_HISTORY_BARS closed bars + the open one
    if (bars.size > MAX_HISTORY_BARS + 2) {
      const oldest = [...bars.keys()].sort((a, b) => a - b)[0];
      bars.delete(oldest);
    }
  }

  _pendingPersist.add(sym);

  if (_eventBus) {
    // lastTrade — lightweight, per trade
    _eventBus.emit('density:lastTrade', { symbol: sym, trade: state.lastTrade });

    // footprint cell update — only emit for 1m (most commonly subscribed)
    const bt1m = barTime(ts, '1m');
    const bar1m = state.footprint['1m'].get(bt1m);
    if (bar1m) {
      const cell = bar1m.prices.get(priceKey);
      if (cell) {
        _eventBus.emit('density:footprint', {
          symbol:        sym,
          tf:            '1m',
          barTime:       bt1m,
          price:         priceKey,
          buyQty:        cell.buyQty,
          sellQty:       cell.sellQty,
          deltaQty:      cell.deltaQty,
          buyNotional:   cell.buyNotional,
          sellNotional:  cell.sellNotional,
          deltaNotional: cell.deltaNotional,
        });
      }
    }
  }
}

// ─── WS aggTrade connection ───────────────────────────────────────
function connectWs(symbol) {
  const state = symbolStates.get(symbol);
  if (!state || state.deactivated) return;

  const url = `${BINANCE_WS_BASE}/stream?streams=${symbol.toLowerCase()}@aggTrade`;
  const ws  = new WebSocket(url);
  state.ws  = ws;

  ws.on('open', () => {
    state.wsOpen = true;
    console.log(`[density] ${symbol}: aggTrade WS connected`);
  });

  ws.on('message', (data) => {
    try {
      const msg   = JSON.parse(data.toString('utf8'));
      const event = msg.data ?? msg; // combined stream wrapper
      if (event.e !== 'aggTrade') return;
      processTrade(state, event);
    } catch (err) {
      console.error(`[density] ${symbol}: WS message error: ${err.message}`);
    }
  });

  ws.on('close', (code) => {
    state.wsOpen = false;
    if (state.deactivated) return;
    console.warn(`[density] ${symbol}: WS closed (${code}), reconnecting in ${RECONNECT_DELAY}ms`);
    setTimeout(() => connectWs(symbol), RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error(`[density] ${symbol}: WS error: ${err.message}`);
  });
}

// ─── Redis persistence ─────────────────────────────────────────────
async function flushToRedis() {
  if (!_redis || _pendingPersist.size === 0) return;
  const symbols = [..._pendingPersist];
  _pendingPersist.clear();
  const pipe = _redis.pipeline();

  for (const sym of symbols) {
    const state = symbolStates.get(sym);
    if (!state) continue;
    const dec = tickDec(sym);

    if (state.lastTrade) {
      pipe.set(`trade:last:${sym}`, JSON.stringify(state.lastTrade), 'EX', 30);
    }

    for (const tf of TIMEFRAMES) {
      for (const [bt, bar] of state.footprint[tf]) {
        const data = {
          symbol:        sym,
          timeframe:     tf,
          barTime:       bt,
          prices:        Object.fromEntries(bar.prices),
          totalBuyQty:   bar.totalBuyQty,
          totalSellQty:  bar.totalSellQty,
          totalDeltaQty: bar.totalDeltaQty,
          open:          bar.open,
          high:          bar.high.toFixed(dec),
          low:           bar.low.toFixed(dec),
          close:         bar.close,
          updatedAt:     Date.now(),
        };
        pipe.set(`footprint:${sym}:${tf}:${bt}`, JSON.stringify(data), 'EX', BAR_TTL_SEC);
      }
    }
  }

  pipe.exec().catch(err => console.error('[density] Redis flush error:', err.message));
}

// ─── DOM polling (reads collector orderbook, emits density:dom) ───
async function pollDom() {
  if (!_redis || !_eventBus) return;
  for (const [sym, state] of symbolStates) {
    if (state.deactivated) continue;
    try {
      const raw = await _redis.get(`futures:orderbook:${sym}`);
      if (!raw) continue;
      const ob        = JSON.parse(raw);
      const updatedAt = ob.updatedAt ?? 0;
      if (updatedAt <= state.lastDomUpdatedAt) continue;
      state.lastDomUpdatedAt = updatedAt;

      const tick = tickSizes.get(sym) ?? 0.00001;
      const bids = {};
      const asks = {};
      for (const e of ob.bids ?? []) {
        bids[normPrice(e.price, tick)] = Math.round(e.price * e.size);
      }
      for (const e of ob.asks ?? []) {
        asks[normPrice(e.price, tick)] = Math.round(e.price * e.size);
      }
      _eventBus.emit('density:dom', { symbol: sym, bids, asks, updatedAt });
    } catch (_) { /* non-critical */ }
  }
}

// ─── priceLevels ──────────────────────────────────────────────────
function buildPriceLevels(symbol, midPrice) {
  const tick = tickSizes.get(symbol) ?? 0.00001;
  const dec  = (tick.toString().split('.')[1] ?? '').length;
  const mid  = parseFloat(normPrice(midPrice, tick));
  const out  = [];
  for (let i = LEVELS_ABOVE; i >= -LEVELS_BELOW; i--) {
    out.push((mid + i * tick).toFixed(dec));
  }
  return out;
}

// ─── DOM snapshot (combined orderbook + footprint + walls) ────────
async function getDomSnapshot(symbol, tf, bars) {
  const sym  = symbol.toUpperCase();
  const tick = tickSizes.get(sym) ?? 0.00001;
  const dec  = (tick.toString().split('.')[1] ?? '').length;

  const raw = await _redis.get(`futures:orderbook:${sym}`);
  if (!raw) return null;
  const ob          = JSON.parse(raw);
  const midPriceNum = ob.midPrice
    ?? ((ob.bids?.[0]?.price ?? 0) + (ob.asks?.[0]?.price ?? ob.bids?.[0]?.price ?? 0)) / 2;
  if (!midPriceNum) return null;

  const priceLevels = buildPriceLevels(sym, midPriceNum);
  const wallThresh  = wallThreshold(sym);
  const bids = {}, asks = {}, walls = [];

  for (const e of ob.bids ?? []) {
    const pk = normPrice(e.price, tick);
    const n  = Math.round(e.price * e.size);
    bids[pk] = n;
    if (n >= wallThresh) walls.push({ price: pk, side: 'bid', notional: n, label: 'BID WALL' });
  }
  for (const e of ob.asks ?? []) {
    const pk = normPrice(e.price, tick);
    const n  = Math.round(e.price * e.size);
    asks[pk] = n;
    if (n >= wallThresh) walls.push({ price: pk, side: 'ask', notional: n, label: 'ASK WALL' });
  }

  // Footprint bars: prefer in-memory, fallback to Redis
  let footprintBars = [];
  if (symbolStates.has(sym)) {
    footprintBars = getFootprintBars(sym, tf, bars);
  } else {
    const tfMs     = TF_MS[tf] ?? 60_000;
    const latestBt = barTime(Date.now(), tf);
    const pipeline = _redis.pipeline();
    for (let i = 0; i < bars; i++) pipeline.get(`footprint:${sym}:${tf}:${latestBt - i * tfMs}`);
    const results = await pipeline.exec();
    for (const [, v] of results) {
      if (!v) continue;
      try { footprintBars.push(JSON.parse(v)); } catch (_) {}
    }
    footprintBars.sort((a, b) => a.barTime - b.barTime);
  }

  const lastTrade = getLastTrade(sym);
  const midPrice  = normPrice(midPriceNum, tick);

  return {
    symbol,
    tickSize:       tick.toFixed(dec),
    pricePrecision: dec,
    lastPrice:      lastTrade?.price ?? midPrice,
    midPrice,
    priceLevels,
    orderbook:      { bids, asks, updatedAt: ob.updatedAt },
    footprintBars:  footprintBars.slice(-bars),
    walls,
  };
}

// ─── Unified snapshot (single source of truth for /density page) ──
//
// Combines DOM (bid/ask notional) + footprint clusters (buy/sell volume)
// into one priceLevels[] array, normalized by tickSize.
//
// Returns:
//   { symbol, timeframe, tickSize, pricePrecision,
//     bestBid, bestAsk, midPrice, updatedAt,
//     stale: { dom, trades },
//     poc, priceLevels: [...] }
//
// priceLevels ordering: asks high→low, mid row, bids high→low.
// Each row: { price, type:'ask'|'bid'|'mid',
//             bidNotional, askNotional, buyVolume, sellVolume,
//             totalVolume, delta, isPOC }
async function getUnifiedSnapshot(symbol, tf, levelsAbove = 40, levelsBelow = 40) {
  const sym = symbol.toUpperCase();
  if (!TF_MS[tf]) tf = '1m';

  const tick = tickSizes.get(sym) ?? 0.00001;
  const dec  = (tick.toString().split('.')[1] ?? '').length;

  // 1) DOM from collector
  const raw = await _redis.get(`futures:orderbook:${sym}`);
  if (!raw) return null;
  let ob;
  try { ob = JSON.parse(raw); } catch { return null; }

  const rawBids = (ob.bids ?? []).map(e => ({ price: parseFloat(e.price), size: parseFloat(e.size) }))
    .filter(e => isFinite(e.price) && isFinite(e.size) && e.size > 0)
    .sort((a, b) => b.price - a.price);
  const rawAsks = (ob.asks ?? []).map(e => ({ price: parseFloat(e.price), size: parseFloat(e.size) }))
    .filter(e => isFinite(e.price) && isFinite(e.size) && e.size > 0)
    .sort((a, b) => a.price - b.price);

  if (rawBids.length === 0 || rawAsks.length === 0) return null;

  const bestBidNum = rawBids[0].price;
  const bestAskNum = rawAsks[0].price;
  const midNum     = (bestBidNum + bestAskNum) / 2;
  const midKey     = normPrice(midNum, tick);
  const midRounded = parseFloat(midKey);

  // 2) Aggregate DOM by tick-normalized price
  const bidByPrice = new Map(); // priceKey → notional (USD)
  const askByPrice = new Map();
  for (const e of rawBids) {
    const pk = normPrice(e.price, tick);
    bidByPrice.set(pk, (bidByPrice.get(pk) || 0) + e.price * e.size);
  }
  for (const e of rawAsks) {
    const pk = normPrice(e.price, tick);
    askByPrice.set(pk, (askByPrice.get(pk) || 0) + e.price * e.size);
  }

  // 3) Aggregate footprint clusters by price across all in-memory bars for tf
  const buyByPrice  = new Map();
  const sellByPrice = new Map();
  const state = symbolStates.get(sym);
  if (state) {
    const bars = state.footprint[tf];
    if (bars) {
      for (const bar of bars.values()) {
        for (const [pk, cell] of bar.prices) {
          if (cell.buyQty)  buyByPrice.set(pk,  (buyByPrice.get(pk)  || 0) + cell.buyQty);
          if (cell.sellQty) sellByPrice.set(pk, (sellByPrice.get(pk) || 0) + cell.sellQty);
        }
      }
    }
  }

  // 4) Build price ladder: top N asks above mid + N bids below mid
  const ladder = []; // descending prices

  // Asks: ascending prices > midRounded → take first levelsAbove → reverse to desc
  const asksAsc = [];
  for (let i = 1; i <= levelsAbove + 5 && asksAsc.length < levelsAbove; i++) {
    const p   = midRounded + i * tick;
    const pk  = p.toFixed(dec);
    asksAsc.push(pk);
  }
  for (let i = asksAsc.length - 1; i >= 0; i--) {
    ladder.push({ pk: asksAsc[i], type: 'ask' });
  }

  // Mid row
  ladder.push({ pk: midKey, type: 'mid' });

  // Bids: descending prices < midRounded → take levelsBelow
  for (let i = 1; i <= levelsBelow; i++) {
    const p  = midRounded - i * tick;
    const pk = p.toFixed(dec);
    ladder.push({ pk, type: 'bid' });
  }

  // 5) Compose rows + find POC
  let pocPrice    = null;
  let pocVolume   = 0;
  const priceLevels = ladder.map(({ pk, type }) => {
    const bidNotional = Math.round(bidByPrice.get(pk) || 0);
    const askNotional = Math.round(askByPrice.get(pk) || 0);
    const buyVolume   = Math.round(buyByPrice.get(pk)  || 0);
    const sellVolume  = Math.round(sellByPrice.get(pk) || 0);
    const totalVolume = buyVolume + sellVolume;
    const delta       = buyVolume - sellVolume;
    if (totalVolume > pocVolume) { pocVolume = totalVolume; pocPrice = pk; }
    return {
      price       : pk,
      type,
      bidNotional,
      askNotional,
      buyVolume,
      sellVolume,
      totalVolume,
      delta,
      isPOC       : false,
    };
  });
  if (pocPrice && pocVolume > 0) {
    for (const row of priceLevels) {
      if (row.price === pocPrice) { row.isPOC = true; break; }
    }
  }

  // 6) Stale flags
  const now           = Date.now();
  const updatedAt     = ob.updatedAt ?? 0;
  const lastTrade     = state?.lastTrade ?? null;
  const lastTradeTs   = lastTrade?.timestamp ?? 0;
  const staleDom      = !updatedAt   || (now - updatedAt)   > 2_000;
  const staleTrades   = !lastTradeTs || (now - lastTradeTs) > 2_000;

  return {
    symbol         : sym,
    timeframe      : tf,
    tickSize       : tick.toFixed(dec),
    pricePrecision : dec,
    bestBid        : normPrice(bestBidNum, tick),
    bestAsk        : normPrice(bestAskNum, tick),
    midPrice       : midKey,
    updatedAt,
    stale          : { dom: staleDom, trades: staleTrades },
    poc            : pocPrice,
    priceLevels,
  };
}

// ─── Public API ───────────────────────────────────────────────────

function activateSymbol(symbol) {
  const sym = symbol.toUpperCase();
  if (symbolStates.has(sym)) return { ok: true, alreadyActive: true };
  if (symbolStates.size >= MAX_SYMBOLS) {
    return { ok: false, error: 'MAX_SYMBOLS_REACHED', message: `Density limit is ${MAX_SYMBOLS} concurrent symbols` };
  }
  getOrCreate(sym);
  connectWs(sym);
  console.log(`[density] activated ${sym} (${symbolStates.size}/${MAX_SYMBOLS})`);
  return { ok: true };
}

function deactivateSymbol(symbol) {
  const sym   = symbol.toUpperCase();
  const state = symbolStates.get(sym);
  if (!state) return;
  state.deactivated = true;
  if (state.ws) { try { state.ws.terminate(); } catch (_) {} state.ws = null; }
  symbolStates.delete(sym);
  console.log(`[density] deactivated ${sym}`);
}

function isSymbolActive(symbol) {
  return symbolStates.has(symbol.toUpperCase());
}

function getFootprintBars(symbol, tf, count = MAX_HISTORY_BARS) {
  const state = symbolStates.get(symbol.toUpperCase());
  if (!state) return [];
  return [...(state.footprint[tf]?.values() ?? [])]
    .sort((a, b) => a.barTime - b.barTime)
    .slice(-count)
    .map(bar => ({
      barTime:       bar.barTime,
      prices:        Object.fromEntries(bar.prices),
      totalBuyQty:   bar.totalBuyQty,
      totalSellQty:  bar.totalSellQty,
      totalDeltaQty: bar.totalDeltaQty,
      open:          bar.open,
      high:          bar.high,
      low:           bar.low,
      close:         bar.close,
    }));
}

function getLastTrade(symbol) {
  return symbolStates.get(symbol.toUpperCase())?.lastTrade ?? null;
}

async function start(redis, eventBus) {
  if (!ENABLED) {
    console.log('[density] DOM_ENABLED=false — service disabled');
    return;
  }

  _redis    = redis;
  _eventBus = eventBus ?? null;

  await loadTickSizes();

  const defaults = (process.env.DOM_DEFAULT_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SYMBOLS);

  for (const sym of defaults) activateSymbol(sym);

  // Listen for on-demand activations from WS subscribe
  if (eventBus) {
    eventBus.on('density:activate', (symbol) => {
      activateSymbol(String(symbol).toUpperCase());
    });
  }

  // Redis persistence timer
  const flushTimer = setInterval(flushToRedis, FLUSH_INTERVAL);
  if (flushTimer.unref) flushTimer.unref();

  // DOM change detection timer
  const domTimer = setInterval(() => {
    pollDom().catch(err => console.error('[density] pollDom error:', err.message));
  }, DOM_POLL_MS);
  if (domTimer.unref) domTimer.unref();

  console.log(
    `[density] service started — symbols=${defaults.join(',')} ` +
    `maxSymbols=${MAX_SYMBOLS} levels=${LEVELS_ABOVE}+${LEVELS_BELOW}`,
  );
}

module.exports = {
  start,
  activateSymbol,
  deactivateSymbol,
  isSymbolActive,
  getFootprintBars,
  getLastTrade,
  getDomSnapshot,
  getUnifiedSnapshot,
  buildPriceLevels,
  tickSizes,
};
