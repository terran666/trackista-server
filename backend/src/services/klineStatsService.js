'use strict';

/**
 * klineStatsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared service for kline-based statistics over Redis 1m bars.
 * Used by:
 *   - klineStatsRoute      (GET /api/screener/kline-stats)
 *   - klineFlatRoute       (POST /api/screener/kline-flat)
 *
 * Public exports:
 *   PERIOD_TO_BARS            — map period string → bars needed
 *   PERIOD_CACHE_TTL          — map period string → cache TTL ms
 *   aggregatePeriodRow        — aggregate sorted 1m bars → PeriodStatsRow
 *   getSinglePeriodStats      — full snapshot for one period
 *   getMultiPeriodStats       — full snapshot for N periods in one pipeline
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const PERIOD_TO_BARS = {
  '1m' : 2,    // fetch 2, drop still-open last bar → effectively 1 completed
  '5m' : 5,
  '15m': 15,
  '30m': 30,
  '1h' : 60,
  '2h' : 120,
  '4h' : 240,
  '6h' : 360,
  '12h': 720,
  '24h': 1440,
};

// ms TTL for in-memory cache per period key
const PERIOD_CACHE_TTL = {
  '1m' : 30_000,
  '5m' : 60_000,
  '15m': 120_000,
  '30m': 300_000,
  '1h' : 600_000,
  '2h' : 1_200_000,
  '4h' : 1_800_000,
  '6h' : 1_800_000,
  '12h': 1_800_000,
  '24h': 1_800_000,
};

const MAX_PERIODS_PER_REQUEST = 6;  // guardrail for multi-period requests

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Single-period cache key: `${period}:${market}`
// Multi-period cache key:  `multi:${sortedPeriods}:${market}`
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  return e.data;
}

function cacheSet(key, data, ttlMs) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  // Periodic GC — keep map small
  if (_cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now > v.expiresAt) _cache.delete(k);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Aggregate an array of already-sorted (ASC by ts) 1m bars into a single
 * PeriodStatsRow.  Used for both single-period and multi-period slices.
 *
 * @param {string}   symbol
 * @param {object[]} bars   — sorted ASC by ts, non-empty
 * @returns {PeriodStatsRow}
 */
function aggregatePeriodRow(symbol, bars) {
  const firstBar = bars[0];
  const lastBar  = bars[bars.length - 1];

  const open  = firstBar.open  ?? firstBar.close ?? 0;
  const close = lastBar.close  ?? 0;

  const priceChangePercent = (open !== 0)
    ? parseFloat(((close - open) / open * 100).toFixed(4))
    : 0;

  let high  = -Infinity;
  let low   = Infinity;
  let volume     = 0;
  let buyVolume  = 0;
  let sellVolume = 0;
  let delta      = 0;
  let tradeCount = 0;
  let volatilitySum = 0;
  let volatilityCount = 0;

  for (const b of bars) {
    if (b.high != null && b.high > high) high = b.high;
    if (b.low  != null && b.low  < low)  low  = b.low;
    volume     += b.volumeUsdt     ?? 0;
    buyVolume  += b.buyVolumeUsdt  ?? 0;
    sellVolume += b.sellVolumeUsdt ?? 0;
    delta      += b.deltaUsdt      ?? 0;
    tradeCount += b.tradeCount     ?? 0;
    if (b.volatility != null) { volatilitySum += b.volatility; volatilityCount++; }
  }

  if (high === -Infinity) high = close;
  if (low  === Infinity)  low  = close;

  const avgVolatility = volatilityCount > 0
    ? parseFloat((volatilitySum / volatilityCount).toFixed(4))
    : null;

  return {
    symbol,
    priceChangePercent,
    open               : parseFloat((open  ?? 0).toFixed(8)),
    close              : parseFloat((close ?? 0).toFixed(8)),
    high               : parseFloat(high.toFixed(8)),
    low                : parseFloat(low.toFixed(8)),
    volume             : parseFloat(volume.toFixed(2)),
    buyVolume          : parseFloat(buyVolume.toFixed(2)),
    sellVolume         : parseFloat(sellVolume.toFixed(2)),
    delta              : parseFloat(delta.toFixed(2)),
    tradeCount         : Math.round(tradeCount),
    avgBarVolatility   : avgVolatility,
    barsAvailable      : bars.length,
  };
}

/**
 * Build a row from Binance 24h ticker data (stored as futures:tickers:all).
 */
function ticker24hRow(t) {
  return {
    symbol             : t.symbol,
    priceChangePercent : parseFloat(t.priceChangePercent) || 0,
    open               : parseFloat(t.openPrice)          || 0,
    close              : parseFloat(t.lastPrice)          || 0,
    high               : parseFloat(t.highPrice)          || 0,
    low                : parseFloat(t.lowPrice)           || 0,
    volume             : parseFloat(t.quoteVolume)        || 0,
    buyVolume          : null,
    sellVolume         : null,
    delta              : null,
    tradeCount         : parseInt(t.count, 10)            || 0,
    avgBarVolatility   : null,
    barsAvailable      : null,
    source             : 'binance_24h',
  };
}

// ─── getSinglePeriodStats ─────────────────────────────────────────────────────

/**
 * Fetch stats for a single period across all (or specified) symbols.
 * Mirrors the original klineStatsRoute logic but extracted for reuse.
 *
 * @param {object} redis
 * @param {object} opts
 *   period    string   '5m' | '15m' | ... | '24h'
 *   market    string   'futures' (default)
 *   symbols   string[] optional — omit to use all active USDT symbols
 *   useCache  bool     default true; set false when caller needs fresh data
 * @returns {{ ts, period, barsRequested, market, count, rows }}
 */
async function getSinglePeriodStats(redis, { period = '15m', market = 'futures', symbols: symArg, useCache = true } = {}) {
  const p = period.toLowerCase();
  const m = market.toLowerCase();

  const barsNeeded = PERIOD_TO_BARS[p];
  if (!barsNeeded) throw new Error(`Unsupported period '${p}'`);

  const cacheKey = `${p}:${m}`;
  const ttl      = PERIOD_CACHE_TTL[p];

  // Cache only applies to full-universe requests
  if (useCache && !symArg) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  // ── Symbol list ────────────────────────────────────────────────
  const symbols = symArg ?? await _loadSymbols(redis, m);
  if (!symbols.length) {
    return { ts: Date.now(), period: p, barsRequested: barsNeeded, market: m, count: 0, rows: [] };
  }

  // ── 24h special case: use Binance tickers ──────────────────────
  if (p === '24h') {
    const rows = await _get24hRows(redis, symbols, symArg ? new Set(symbols) : null);
    const result = { ts: Date.now(), period: p, barsRequested: barsNeeded, market: m, count: rows.length, rows };
    if (!symArg) cacheSet(cacheKey, result, ttl);
    return result;
  }

  // ── Read bars via pipeline ────────────────────────────────────
  const pipe = redis.pipeline();
  const barsKey = (sym) => m === 'spot' ? `bars:1m:spot:${sym}` : `bars:1m:${sym}`;
  for (const sym of symbols) pipe.zrange(barsKey(sym), -barsNeeded, -1);
  const results = await pipe.exec();

  const rows = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym    = symbols[i];
    const rawArr = results[i]?.[1];
    if (!Array.isArray(rawArr) || rawArr.length === 0) continue;

    let bars = rawArr.map(r => tryParse(r)).filter(Boolean);
    if (!bars.length) continue;
    bars.sort((a, b) => a.ts - b.ts);

    if (p === '1m') {
      bars = bars.slice(0, bars.length - 1);
      if (!bars.length) continue;
    }

    const row = aggregatePeriodRow(sym, bars);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

  const result = {
    ts           : Date.now(),
    period       : p,
    barsRequested: p === '1m' ? 1 : barsNeeded,
    market       : m,
    count        : rows.length,
    rows,
  };
  if (!symArg) cacheSet(cacheKey, result, ttl);
  return result;
}

// ─── getMultiPeriodStats ──────────────────────────────────────────────────────

/**
 * Fetch stats for multiple periods across all (or specified) symbols.
 * Single pipeline read per symbol — reads max(bars_needed) bars once.
 *
 * @param {object} redis
 * @param {object} opts
 *   periods   string[]  required — e.g. ['5m', '15m', '30m']
 *   market    string    'futures' (default)
 *   symbols   string[]  optional
 *   useCache  bool      default true
 *   sortBy    string    period key to sort by, e.g. '15m'; default = first period
 * @returns {MultiPeriodResult}
 */
async function getMultiPeriodStats(redis, { periods, market = 'futures', symbols: symArg, useCache = true, sortBy } = {}) {
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('periods must be a non-empty array');
  }

  const validPeriods = periods
    .map(p => p.toLowerCase().trim())
    .filter(p => PERIOD_TO_BARS[p]);

  if (validPeriods.length === 0) throw new Error(`No valid periods provided. Supported: ${Object.keys(PERIOD_TO_BARS).join(', ')}`);
  if (validPeriods.length > MAX_PERIODS_PER_REQUEST) {
    throw new Error(`Max ${MAX_PERIODS_PER_REQUEST} periods per request`);
  }

  const m          = market.toLowerCase();
  const sortedKey  = [...validPeriods].sort().join(',');
  const cacheKey   = `multi:${sortedKey}:${m}`;
  const minTtl     = Math.min(...validPeriods.map(p => PERIOD_CACHE_TTL[p] ?? 60_000));

  if (useCache && !symArg) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const symbols = symArg ?? await _loadSymbols(redis, m);
  if (!symbols.length) {
    return { ts: Date.now(), market: m, periods: validPeriods, count: 0, rows: [] };
  }

  // Separate 24h from bar-based periods
  const barPeriods = validPeriods.filter(p => p !== '24h');
  const has24h     = validPeriods.includes('24h');

  // ── Parallel: bars pipeline + 24h tickers (if needed) ─────────
  const maxBarsNeeded = barPeriods.length > 0
    ? Math.max(...barPeriods.map(p => PERIOD_TO_BARS[p]))
    : 0;

  const barsKey = (sym) => m === 'spot' ? `bars:1m:spot:${sym}` : `bars:1m:${sym}`;

  const [barsResults, tickerMap] = await Promise.all([
    barPeriods.length > 0 ? (async () => {
      const pipe = redis.pipeline();
      for (const sym of symbols) pipe.zrange(barsKey(sym), -maxBarsNeeded, -1);
      return pipe.exec();
    })() : Promise.resolve([]),
    has24h ? _get24hMap(redis) : Promise.resolve(new Map()),
  ]);

  // ── Build per-symbol rows keyed by period ─────────────────────
  const rowMap = new Map(); // symbol → { symbol, [period]: PeriodStatsRow }

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const entry = { symbol: sym };

    // Bar-based periods — slice from the same bar array
    if (barPeriods.length > 0) {
      const rawArr = barsResults[i]?.[1];
      if (Array.isArray(rawArr) && rawArr.length > 0) {
        let bars = rawArr.map(r => tryParse(r)).filter(Boolean);
        bars.sort((a, b) => a.ts - b.ts);

        for (const p of barPeriods) {
          let slice = bars.slice(-PERIOD_TO_BARS[p]);
          if (p === '1m') slice = slice.slice(0, slice.length - 1);
          if (slice.length > 0) {
            const { symbol: _, ...stats } = aggregatePeriodRow(sym, slice);
            entry[p] = stats;
          }
        }
      }
    }

    // 24h ticker period
    if (has24h) {
      const t = tickerMap.get(sym);
      if (t) {
        const { symbol: _, ...stats } = ticker24hRow(t);
        entry['24h'] = stats;
      }
    }

    // Only include symbol if it has data for at least one period
    const hasSomeData = validPeriods.some(p => entry[p] != null);
    if (hasSomeData) rowMap.set(sym, entry);
  }

  // ── Sort by chosen period priceChangePercent ───────────────────
  const sortPeriod = (sortBy && validPeriods.includes(sortBy)) ? sortBy : validPeriods[0];
  const rows = [...rowMap.values()];
  rows.sort((a, b) => {
    const aPct = Math.abs(a[sortPeriod]?.priceChangePercent ?? 0);
    const bPct = Math.abs(b[sortPeriod]?.priceChangePercent ?? 0);
    return bPct - aPct;
  });

  const result = {
    ts      : Date.now(),
    market  : m,
    periods : validPeriods,
    sortedBy: sortPeriod,
    count   : rows.length,
    rows,
  };

  if (!symArg) cacheSet(cacheKey, result, minTtl);
  return result;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _loadSymbols(redis, market) {
  const key = market === 'spot' ? 'spot:symbols:active:usdt' : 'symbols:active:usdt';
  const raw = await redis.get(key);
  return tryParse(raw) || [];
}

async function _get24hRows(redis, symbols, symSet) {
  const rawTickers = await redis.get('futures:tickers:all');
  const tickers    = tryParse(rawTickers) || [];
  const rows       = [];
  for (const t of tickers) {
    if (!t.symbol || !t.symbol.endsWith('USDT')) continue;
    if (symSet && !symSet.has(t.symbol)) continue;
    rows.push(ticker24hRow(t));
  }
  rows.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
  return rows;
}

async function _get24hMap(redis) {
  const rawTickers = await redis.get('futures:tickers:all');
  const tickers    = tryParse(rawTickers) || [];
  const map = new Map();
  for (const t of tickers) if (t.symbol) map.set(t.symbol, t);
  return map;
}

module.exports = {
  PERIOD_TO_BARS,
  PERIOD_CACHE_TTL,
  aggregatePeriodRow,
  getSinglePeriodStats,
  getMultiPeriodStats,
};
