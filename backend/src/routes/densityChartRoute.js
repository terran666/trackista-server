'use strict';

// ─── Density Chart Route ──────────────────────────────────────────────────────
//
// Provides 7 REST endpoints for the /density page.
// None of these endpoints break any existing /api/density/* routes.
//
// Endpoints:
//   GET /api/density/chart            — candles + walls + density profile
//   GET /api/density/orderbook        — grouped L2 book (Binance-style)
//   GET /api/density/depth-map        — cumulative depth map
//   GET /api/density/symbols          — tracked symbol list with stats
//   GET /api/density/appearance       — wall appearance timeline (per-bar counts)
//   GET /api/density/wall-events      — latest wall lifecycle events table
//   GET /api/density/debug            — quick Redis state overview per symbol
//
// All endpoints share a Redis client passed via the factory.
// Binance REST fetches use the shared binanceFetch utility (IP backoff aware).

const express        = require('express');
const { parseIntClamp, parseFloatClamp, safeSymbol } = require('../utils/parseClamp');
const { binanceFetch } = require('../utils/binanceRestLogger');
const registry       = require('../services/wsSubscriptionRegistry');
const { normalizeWall, computeFirstBarTime } = require('../utils/normalizeWall');

// ─── Constants ────────────────────────────────────────────────────────────────

const FUTURES_REST_BASE = 'https://fapi.binance.com';
const SPOT_REST_BASE    = 'https://api.binance.com';

const TF_MS = {
  '1m':    60_000,
  '3m':   180_000,
  '5m':   300_000,
  '15m':  900_000,
  '30m':  1_800_000,
  '1h':   3_600_000,
  '2h':   7_200_000,
  '4h':  14_400_000,
  '6h':  21_600_000,
  '12h': 43_200_000,
  '1d':  86_400_000,
};

const VALID_TFS = new Set(Object.keys(TF_MS));

/** Cache TTL in seconds = 2 × TF duration, minimum 60 s */
function candleTtl(tf) {
  const ms = TF_MS[tf] ?? 60_000;
  return Math.max(Math.ceil((ms * 2) / 1000), 60);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Floor a timestamp to the bar open time for a given TF. */
function floorToTf(ts, tf) {
  const tfMs = TF_MS[tf] ?? 60_000;
  return Math.floor(ts / tfMs) * tfMs;
}

/**
 * Fetch candles: Redis-cache-first, then Binance REST.
 * Returns array of { time, open, high, low, close, volume } or null on error.
 */
async function fetchCandles(redis, market, symbol, tf, limit) {
  const cacheKey = `density:candles:${market}:${symbol}:${tf}`;

  // 1. Try Redis
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr) && arr.length > 0) return arr.slice(-limit);
    }
  } catch (_) { /* cache miss */ }

  // 2. Fetch from Binance REST
  const base   = market === 'futures' ? FUTURES_REST_BASE : SPOT_REST_BASE;
  const path   = market === 'futures' ? '/fapi/v1/klines'  : '/api/v3/klines';
  const url    = `${base}${path}?symbol=${symbol}&interval=${tf}&limit=${Math.min(limit, 1000)}`;

  let raw;
  try {
    const res = await binanceFetch(url, undefined, 'densityChartRoute', symbol, `klines-${tf}`);
    if (!res.ok) return null;
    raw = await res.json();
  } catch (err) {
    console.error(`[densityChart] fetchCandles ${symbol}/${tf}:`, err.message);
    return null;
  }

  if (!Array.isArray(raw)) return null;

  const candles = raw.map(k => ({
    time  : k[0],
    open  : parseFloat(k[1]),
    high  : parseFloat(k[2]),
    low   : parseFloat(k[3]),
    close : parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  // Persist to Redis for the next caller
  try {
    await redis.set(cacheKey, JSON.stringify(candles), 'EX', candleTtl(tf));
  } catch (_) { /* non-fatal */ }

  return candles;
}

/**
 * Read current walls from Redis (public payload written by collector).
 * Returns [] on miss/error.
 */
async function readWalls(redis, market, symbol) {
  const key = market === 'futures' ? `futures:walls:${symbol}` : `walls:${symbol}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return [];
    const data = JSON.parse(raw);
    // Payload shape: { walls: [...] } or plain array
    return Array.isArray(data) ? data : (data.walls || []);
  } catch (_) { return []; }
}

/**
 * Read orderbook from Redis.
 * Returns { bids: [[price, size], ...], asks: [[price, size], ...], updatedAt } or null.
 */
async function readOrderbook(redis, market, symbol) {
  const key = market === 'futures' ? `futures:orderbook:${symbol}` : `orderbook:${symbol}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const ob = JSON.parse(raw);
    // Collector stores levels as {price, size, usdValue} objects; all callers
    // expect [price, size] arrays (Binance-style). Normalize at read time.
    const norm = (level) => Array.isArray(level) ? level : [level.price, level.size];
    if (ob.bids) ob.bids = ob.bids.map(norm);
    if (ob.asks) ob.asks = ob.asks.map(norm);
    return ob;
  } catch (_) { return null; }
}

/**
 * Read wall events from sorted set density:wall-events:{market}:{symbol}.
 * Optional minTs/maxTs for time range filtering.
 */
async function readWallEvents(redis, market, symbol, minTs = '-inf', maxTs = '+inf') {
  const key = `density:wall-events:${market}:${symbol}`;
  try {
    const members = await redis.zrangebyscore(key, minTs, maxTs);
    return members.map(m => { try { return JSON.parse(m); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/**
 * Build a simple density profile from the orderbook.
 * Groups levels into `buckets` price buckets around mid-price, range = ±rangePct%.
 */
function buildDensityProfile(ob, buckets = 50, rangePct = 2) {
  if (!ob) return [];
  const { bids = [], asks = [] } = ob;
  if (!bids.length && !asks.length) return [];

  const bestBid = bids.length ? parseFloat(bids[0][0]) : 0;
  const bestAsk = asks.length ? parseFloat(asks[0][0]) : 0;
  const mid     = (bestBid + bestAsk) / 2 || bestBid || bestAsk;
  if (mid === 0) return [];

  const range     = mid * (rangePct / 100);
  const priceMin  = mid - range;
  const priceMax  = mid + range;
  const bucketSz  = (priceMax - priceMin) / buckets;
  if (bucketSz <= 0) return [];

  const bucketBid = new Float64Array(buckets);
  const bucketAsk = new Float64Array(buckets);

  for (const [p, s] of bids) {
    const price = parseFloat(p);
    const size  = parseFloat(s);
    if (price < priceMin || price > priceMax) continue;
    const idx = Math.min(Math.floor((price - priceMin) / bucketSz), buckets - 1);
    bucketBid[idx] += size * price; // in USDT
  }
  for (const [p, s] of asks) {
    const price = parseFloat(p);
    const size  = parseFloat(s);
    if (price < priceMin || price > priceMax) continue;
    const idx = Math.min(Math.floor((price - priceMin) / bucketSz), buckets - 1);
    bucketAsk[idx] += size * price;
  }

  const profile = [];
  for (let i = 0; i < buckets; i++) {
    const price = priceMin + (i + 0.5) * bucketSz;
    const bidSizeUsdt   = bucketBid[i];
    const askSizeUsdt   = bucketAsk[i];
    const totalSizeUsdt = bidSizeUsdt + askSizeUsdt;
    if (totalSizeUsdt > 0) {
      profile.push({ price: Math.round(price * 10000) / 10000, bidSizeUsdt, askSizeUsdt, totalSizeUsdt });
    }
  }
  return profile;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the Express router for density chart endpoints.
 * @param {import('ioredis').Redis} redis
 * @returns {import('express').Router}
 */
function createDensityChartRouter(redis) {
  const router = express.Router();

  // ── 1. Chart: candles + walls + density profile ──────────────────────────
  // GET /api/density/chart?marketType=futures&symbol=BTCUSDT&tf=15m&bars=300
  router.get('/chart', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const tf         = VALID_TFS.has(req.query.tf) ? req.query.tf : '15m';
    const bars       = parseIntClamp(req.query.bars, 300, 1, 1000);

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const [candles, walls, ob] = await Promise.all([
      fetchCandles(redis, marketType, symbol, tf, bars),
      readWalls(redis, marketType, symbol),
      readOrderbook(redis, marketType, symbol),
    ]);

    if (!candles) {
      return res.status(502).json({ success: false, error: 'failed to fetch candles' });
    }

    // Wall events in the candle time range
    const minTs = candles.length ? candles[0].time : 0;
    const maxTs = candles.length ? candles[candles.length - 1].time + (TF_MS[tf] ?? 60_000) : '+inf';
    const wallEvents = await readWallEvents(redis, marketType, symbol, minTs, maxTs);

    const densityProfile = buildDensityProfile(ob);

    // Normalize walls to canonical shape; compute firstBarTime from fetched candles
    const now = Date.now();
    const normalizedWalls = walls.map(w => {
      const nw = normalizeWall(w, now);
      nw.firstBarTime = computeFirstBarTime(nw.price, candles);
      return nw;
    });

    return res.json({
      success: true,
      marketType,
      symbol,
      tf,
      candles,
      walls: normalizedWalls,
      wallEvents,
      densityProfile,
    });
  });

  // ── 2. Orderbook: Binance-style grouped L2 ───────────────────────────────
  // GET /api/density/orderbook?marketType=futures&symbol=BTCUSDT&group=0.1&limit=20
  router.get('/orderbook', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const group      = parseFloatClamp(req.query.group, 0, 0, 1_000_000); // 0 = no grouping
    const limit      = parseIntClamp(req.query.limit, 20, 1, 500);

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const ob = await readOrderbook(redis, marketType, symbol);
    if (!ob) return res.status(404).json({ success: false, error: 'ORDERBOOK_NOT_FOUND', symbol, marketType });

    const rawBids = (ob.bids || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]);
    const rawAsks = (ob.asks || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]);

    // Compute mid price
    const bestBid = rawBids.length ? rawBids[0][0] : 0;
    const bestAsk = rawAsks.length ? rawAsks[0][0] : 0;
    const midPrice = (bestBid + bestAsk) / 2 || bestBid || bestAsk;

    /**
     * Group levels by `group` bucket width.
     * bids: sorted high→low (best bid first).
     * asks: sorted low→high (best ask first).
     */
    function groupLevels(levels, isBid) {
      if (group <= 0) return levels.map(([p, s]) => ({ price: p, size: s }));

      const map = new Map();
      for (const [p, s] of levels) {
        const bucket = isBid
          ? Math.floor(p / group) * group
          : Math.ceil(p / group) * group;
        const key = bucket.toFixed(10); // avoid float key collision
        map.set(key, (map.get(key) || 0) + s);
      }

      const arr = Array.from(map.entries()).map(([k, s]) => ({ price: parseFloat(k), size: s }));
      arr.sort((a, b) => isBid ? b.price - a.price : a.price - b.price);
      return arr;
    }

    const groupedBids = groupLevels(rawBids, true).slice(0, limit);
    const groupedAsks = groupLevels(rawAsks, false).slice(0, limit);

    /** Enrich with running totals and USDT values. */
    function enrich(levels, midP) {
      let cumulativeSize  = 0;
      let cumulativeUsdt  = 0;
      const totalSize = levels.reduce((s, l) => s + l.size, 0) || 1;
      return levels.map(l => {
        cumulativeSize += l.size;
        cumulativeUsdt += l.size * l.price;
        return {
          price        : l.price,
          size         : l.size,
          sizeUsdt     : l.size * l.price,
          total        : cumulativeSize,
          totalUsdt    : cumulativeUsdt,
          density      : l.size / totalSize,
        };
      });
    }

    return res.json({
      success    : true,
      symbol,
      marketType,
      lastPrice  : ob.lastPrice  ?? midPrice,
      changePct  : ob.changePct  ?? 0,
      grouping   : group,
      bids       : enrich(groupedBids, midPrice),
      asks       : enrich(groupedAsks, midPrice),
      updatedAt  : ob.updatedAt ?? null,
    });
  });

  // ── 3. Depth map: cumulative sizes + wall markers ───────────────────────
  // GET /api/density/depth-map?marketType=futures&symbol=BTCUSDT&levels=100
  router.get('/depth-map', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const levels     = parseIntClamp(req.query.levels, 100, 1, 1000);

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const [ob, walls] = await Promise.all([
      readOrderbook(redis, marketType, symbol),
      readWalls(redis, marketType, symbol),
    ]);
    if (!ob) return res.status(404).json({ success: false, error: 'ORDERBOOK_NOT_FOUND', symbol, marketType });

    const rawBids = (ob.bids || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]).slice(0, levels);
    const rawAsks = (ob.asks || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]).slice(0, levels);

    const bestBid = rawBids.length ? rawBids[0][0] : 0;
    const bestAsk = rawAsks.length ? rawAsks[0][0] : 0;
    const midPrice = (bestBid + bestAsk) / 2 || bestBid || bestAsk;

    // Build wall lookup by price for O(1) annotation
    const wallByPrice = new Map(); // price (string) → { strength, sizeUsdt }
    for (const w of walls) {
      wallByPrice.set(String(w.price), { strength: w.strength ?? 0, sizeUsdt: w.usdValue ?? w.sizeUsdt ?? 0 });
    }

    // Determine wall threshold: total book USDT / 200 as rough per-level threshold
    const totalObUsdt = [...rawBids, ...rawAsks].reduce((s, [p, sz]) => s + sz * p, 0);
    const wallThreshold = totalObUsdt > 0 ? totalObUsdt / 200 : 0;

    function buildCumulative(levels) {
      let cumSize = 0, cumUsdt = 0;
      return levels.map(([p, s]) => {
        cumSize += s;
        cumUsdt += s * p;
        const sizeUsdt = s * p;
        const wEntry   = wallByPrice.get(String(p));
        const isWall   = !!(wEntry || (wallThreshold > 0 && sizeUsdt >= wallThreshold));
        return {
          price          : p,
          size           : s,
          sizeUsdt,
          cumulativeSize : cumSize,
          cumulativeUsdt : cumUsdt,
          isWall,
          wallStrength   : wEntry ? wEntry.strength : (isWall ? parseFloat((sizeUsdt / Math.max(wallThreshold, 1)).toFixed(2)) : 0),
        };
      });
    }

    // Compact walls array for chart overlay — use shared normalizer
    const wallsCompact = walls.map(w => normalizeWall(w));

    return res.json({
      success    : true,
      symbol,
      marketType,
      midPrice,
      bids       : buildCumulative(rawBids),
      asks       : buildCumulative(rawAsks),
      walls      : wallsCompact,
      updatedAt  : ob.updatedAt ?? null,
    });
  });

  // ── 4. Symbols: tracked symbol list with wall stats ──────────────────────
  // GET /api/density/symbols?marketType=futures
  router.get('/symbols', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';

    let symbols = [];
    try {
      const raw = await redis.get(`density:symbols:tracked:${marketType}`);
      if (raw) {
        const data = JSON.parse(raw);
        symbols = Array.isArray(data) ? data : (data.symbols || []);
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: 'redis error' });
    }

    if (symbols.length === 0) {
      return res.json({ success: true, marketType, items: [] });
    }

    const items = await Promise.all(symbols.map(async sym => {
      const [walls, ob] = await Promise.all([
        readWalls(redis, marketType, sym),
        readOrderbook(redis, marketType, sym),
      ]);

      const bestBid  = ob?.bids?.length  ? parseFloat(ob.bids[0][0])  : 0;
      const bestAsk  = ob?.asks?.length  ? parseFloat(ob.asks[0][0])  : 0;
      const price    = (bestBid + bestAsk) / 2 || bestBid || bestAsk;

      const activeWalls       = walls.filter(w => w.status === 'confirmed' || w.status === 'persistent');
      const bidWalls          = activeWalls.filter(w => w.side === 'bid');
      const askWalls          = activeWalls.filter(w => w.side === 'ask');
      const topWall           = activeWalls.reduce((best, w) => (!best || w.sizeUsdt > best.sizeUsdt) ? w : best, null);
      const nearestWall       = activeWalls.reduce((best, w) => {
        if (!w.distancePct) return best;
        if (!best || Math.abs(w.distancePct) < Math.abs(best.distancePct)) return w;
        return best;
      }, null);

      // Simple liquidity score: log of total visible book depth in USDT
      const totalBidUsdt  = (ob?.bids  || []).slice(0, 20).reduce((s, [p, sz]) => s + parseFloat(sz) * parseFloat(p), 0);
      const totalAskUsdt  = (ob?.asks  || []).slice(0, 20).reduce((s, [p, sz]) => s + parseFloat(sz) * parseFloat(p), 0);
      const liquidityScore = Math.round(Math.log10(Math.max(totalBidUsdt + totalAskUsdt, 1)) * 100) / 100;

      // Density level heuristic: 1-5 based on total active wall USDT
      const totalWallUsdt = activeWalls.reduce((s, w) => s + (w.sizeUsdt || 0), 0);
      const densityLevel  = Math.min(5, Math.max(1, Math.ceil(Math.log10(Math.max(totalWallUsdt, 10)) - 3)));

      return {
        symbol                 : sym,
        price,
        densityLevel,
        activeWalls            : activeWalls.length,
        bidWalls               : bidWalls.length,
        askWalls               : askWalls.length,
        icebergs               : 0,  // TODO: iceberg detection
        topWallSizeUsdt        : topWall?.sizeUsdt          ?? 0,
        nearestWallDistancePct : nearestWall?.distancePct   ?? null,
        liquidityScore,
        walls24h               : walls.length,
      };
    }));

    return res.json({ success: true, marketType, items });
  });

  // ── 5. Appearance: wall appearance/removal timeline per bar ─────────────
  // GET /api/density/appearance?marketType=futures&symbol=BTCUSDT&tf=15m&bars=100
  router.get('/appearance', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const tf         = VALID_TFS.has(req.query.tf) ? req.query.tf : '15m';
    const bars       = parseIntClamp(req.query.bars, 100, 1, 1000);

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const tfMs   = TF_MS[tf] ?? 60_000;
    const nowTs  = Date.now();
    const minTs  = nowTs - bars * tfMs;

    const events = await readWallEvents(redis, marketType, symbol, minTs, '+inf');

    // Group events by bar
    const barMap = new Map(); // barTime → stats object

    function getBar(ts) {
      const barTime = floorToTf(ts, tf);
      if (!barMap.has(barTime)) {
        barMap.set(barTime, {
          time            : barTime,
          newBidWalls     : 0,
          newAskWalls     : 0,
          removedBidWalls : 0,
          removedAskWalls : 0,
          bidSizeUsdt     : 0,
          askSizeUsdt     : 0,
          removedSizeUsdt : 0,
        });
      }
      return barMap.get(barTime);
    }

    for (const ev of events) {
      const bar = getBar(ev.ts);
      const isBid     = ev.side === 'bid';
      const sizeUsdt  = ev.sizeUsdt || 0;

      // new / confirmed / increased → appear as active
      if (ev.status === 'new' || ev.status === 'confirmed' || ev.status === 'increased') {
        if (isBid) { bar.newBidWalls++;  bar.bidSizeUsdt  += sizeUsdt; }
        else       { bar.newAskWalls++;  bar.askSizeUsdt  += sizeUsdt; }
      } else if (ev.status === 'dropped' || ev.status === 'cancelled' || ev.status === 'filled') {
        // dropped / cancelled / filled → removed
        if (isBid) { bar.removedBidWalls++; bar.removedSizeUsdt += sizeUsdt; }
        else       { bar.removedAskWalls++; bar.removedSizeUsdt += sizeUsdt; }
      }
    }

    // Sort bars chronologically and ensure there are no gaps (fill empty bars)
    const firstBarTime = floorToTf(minTs, tf);
    const lastBarTime  = floorToTf(nowTs, tf);
    const result       = [];

    for (let t = firstBarTime; t <= lastBarTime; t += tfMs) {
      if (barMap.has(t)) {
        result.push(barMap.get(t));
      } else {
        result.push({
          time            : t,
          newBidWalls     : 0,
          newAskWalls     : 0,
          removedBidWalls : 0,
          removedAskWalls : 0,
          bidSizeUsdt     : 0,
          askSizeUsdt     : 0,
          removedSizeUsdt : 0,
        });
      }
    }

    return res.json({ success: true, symbol, marketType, tf, bars: result });
  });

  // ── 6. Wall events: latest lifecycle events table ───────────────────────────
  // GET /api/density/wall-events?marketType=futures&symbol=BTCUSDT&limit=50&since=<ts>
  router.get('/wall-events', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const limit      = parseIntClamp(req.query.limit, 50, 1, 500);
    const since      = req.query.since ? parseIntClamp(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER) : 0;

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const evKey = `density:wall-events:${marketType}:${symbol}`;
    let items = [];
    try {
      // Fetch newest-first from the sorted set using ZREVRANGEBYSCORE
      const minTs = since > 0 ? since + 1 : '-inf';
      const raws  = await redis.zrevrangebyscore(evKey, '+inf', minTs, 'LIMIT', 0, limit);
      items = raws
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean)
        .map(ev => ({
          id:          ev.id,
          ts:          ev.ts,
          time:        new Date(ev.ts).toISOString().slice(11, 19),
          side:        ev.side,
          price:       ev.price,
          sizeUsdt:    ev.sizeUsdt,
          type:        ev.type ?? 'limit',
          status:      ev.status,
          lifetimeMs:  ev.lifetimeMs ?? 0,
          strength:    ev.strength   ?? 0,
          distancePct: ev.distancePct ?? 0,
        }));
    } catch (err) {
      console.error('[densityChartRoute] wall-events:', err.message);
      return res.status(500).json({ success: false, error: 'redis error' });
    }

    return res.json({ success: true, marketType, symbol, items });
  });

  // ── 7. Debug: quick state overview per symbol ────────────────────────────────
  // GET /api/density/debug?marketType=futures&symbol=BTCUSDT&tf=1m
  router.get('/debug', async (req, res) => {
    const marketType = req.query.marketType === 'spot' ? 'spot' : 'futures';
    const symbol     = safeSymbol(req.query.symbol);
    const tf         = VALID_TFS.has(req.query.tf) ? req.query.tf : '1m';

    if (!symbol) return res.status(400).json({ success: false, error: 'invalid symbol' });

    const obKey        = marketType === 'futures' ? `futures:orderbook:${symbol}` : `orderbook:${symbol}`;
    const wallsKey     = marketType === 'futures' ? `futures:walls:${symbol}`     : `walls:${symbol}`;
    const evKey        = `density:wall-events:${marketType}:${symbol}`;
    const candlesKey   = `density:candles:${marketType}:${symbol}:${tf}`;
    const barsKey      = `bars:1m:${symbol}`;
    const trackedKey   = `density:symbols:tracked:${marketType}`;

    try {
      const [obRaw, wallsRaw, evCount, candlesRaw, trackedRaw, lastEvRaw, lastBarRaw] = await Promise.all([
        redis.get(obKey),
        redis.get(wallsKey),
        redis.zcard(evKey),
        redis.get(candlesKey),
        redis.get(trackedKey),
        redis.zrevrangebyscore(evKey, '+inf', '-inf', 'LIMIT', 0, 1),
        redis.zrange(barsKey, -1, -1),
      ]);

      let orderbookUpdatedAt = null;
      let orderbookBids = 0;
      let orderbookAsks = 0;
      if (obRaw) {
        try {
          const d = JSON.parse(obRaw);
          orderbookUpdatedAt = d.updatedAt ?? null;
          orderbookBids = (d.bids || []).length;
          orderbookAsks = (d.asks || []).length;
        } catch (_) {}
      }

      let activeWallsCount = 0;
      if (wallsRaw) { try { const d = JSON.parse(wallsRaw); activeWallsCount = (Array.isArray(d) ? d : (d.walls || [])).filter(w => w.status === 'confirmed' || w.status === 'persistent' || !w.status).length; } catch (_) {} }

      let candlesCount = 0;
      let lastCandleTs = null;
      if (candlesRaw) { try { const c = JSON.parse(candlesRaw); if (Array.isArray(c) && c.length > 0) { candlesCount = c.length; lastCandleTs = c[c.length - 1].time ?? c[c.length - 1].ts ?? null; } } catch (_) {} }
      // Fallback: check bar aggregator for last 1m bar
      if (!lastCandleTs && lastBarRaw && lastBarRaw[0]) { try { lastCandleTs = JSON.parse(lastBarRaw[0]).ts ?? null; } catch (_) {} }

      let tracked = false;
      if (trackedRaw) { try { const d = JSON.parse(trackedRaw); const syms = Array.isArray(d) ? d : (d.symbols || []); tracked = syms.includes(symbol); } catch (_) {} }

      let lastWallEventTs = null;
      if (lastEvRaw && lastEvRaw[0]) { try { lastWallEventTs = JSON.parse(lastEvRaw[0]).ts ?? null; } catch (_) {} }

      // Compute appearance bars count (bars that have at least one event in the last 2h)
      let appearanceBarsCount = 0;
      try {
        const tfMs    = TF_MS[tf] ?? 60_000;
        const minTs   = Date.now() - 120 * tfMs;
        const evRaws2 = await redis.zrangebyscore(evKey, minTs, '+inf');
        const barTimes = new Set();
        for (const r of evRaws2) { try { const e = JSON.parse(r); barTimes.add(floorToTf(e.ts, tf)); } catch (_) {} }
        appearanceBarsCount = barTimes.size;
      } catch (_) {}

      // WS density subscribers
      let wsClientsDensity = 0;
      try { wsClientsDensity = registry.getScopeCounts()?.density ?? 0; } catch (_) {}

      return res.json({
        success              : true,
        symbol,
        marketType,
        tf,
        tracked,
        orderbookExists      : !!obRaw,
        orderbookUpdatedAt,
        orderbookBids,
        orderbookAsks,
        activeWallsCount,
        wallEventsCount      : evCount ?? 0,
        lastWallEventTs,
        appearanceBarsCount,
        candlesCount,
        lastCandleTs,
        wsClientsDensity,
        redisKeys: {
          orderbook  : obKey,
          walls      : wallsKey,
          wallEvents : evKey,
          candles    : candlesKey,
        },
      });
    } catch (err) {
      console.error('[densityChartRoute] debug:', err.message);
      return res.status(500).json({ success: false, error: 'redis error' });
    }
  });

  return router;
}

module.exports = { createDensityChartRouter };
