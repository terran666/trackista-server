'use strict';

/**
 * screenerAggregationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central aggregation layer for the Screener domain.
 *
 * Replaces the scattered per-route Redis reads that previously required the
 * frontend to call 2-4 separate endpoints and merge data client-side.
 *
 * Architecture:
 *   Two network round-trips total per snapshot:
 *     1. Two singleton GETs (symbols list + tickers).
 *     2. One pipeline:  6 keys per symbol  +  1 alerts:live ZRANGEBYSCORE.
 *
 * Pipeline layout per symbol (offset = i * KEYS_PER_SYM):
 *   +0  GET metrics:<SYM>
 *   +1  GET signal:<SYM>
 *   +2  GET derivatives:<SYM>
 *   +3  GET move:live:<SYM>
 *   +4  GET presignal:<SYM>
 *   +5  ZRANGE bars:1m:<SYM> -BAR_FETCH_COUNT -1   (last N 1m bars)
 *
 * Appended at end of pipeline (index = symbols.length * 6):
 *   [n*6]  ZRANGEBYSCORE alerts:live <since_1h> +inf
 *
 * Public API:
 *   getSnapshot(redis, opts)          → SnapshotResult
 *   getDelta(redis, since, opts)      → DeltaResult
 *   buildAlertPresenceMap(alertRaws)  → Map<symbol, AlertSummary>
 *
 * ScreenerRowDTO shape is defined inline below (see buildRow).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const KEYS_PER_SYM       = 6;
const BAR_FETCH_COUNT    = 16;   // covers both 5m (last 5) and 15m (last 15) aggregation
const ALERT_LOOKBACK_MS  = 60 * 60 * 1000;     // 1 h alert presence window
const MAX_SINCE_AGE_MS   = 2 * 60 * 1000;      // delta cursor older than 2 min → full resync
const MAX_LIMIT          = 500;
const SNAPSHOT_CACHE_TTL = 1500; // ms — shared row cache for snapshot AND delta hot path

// Shared in-memory cache.  Invalidated every SNAPSHOT_CACHE_TTL ms.
// Eliminates redundant Redis pipeline + JSON parsing on high-frequency /live polling
// and on concurrent /snapshot requests from multiple tabs/connections.
let _screenerCache        = null;
let _screenerCacheBuilding = null;  // in-flight Promise sentinel — prevents concurrent rebuilds
let _cacheHits    = 0;
let _cacheMisses  = 0;

// Filter / sort field extractors
const SORT_FIELDS = {
  // Legacy sort keys (backwards compat)
  priceChange   : r => Math.abs(r.priceChangePct),
  priceChange5m : r => Math.abs(r.priceChangePct5m ?? 0),
  volume        : r => r.volumeUsdt60s,
  volume5m      : r => r.volumeUsdt5m ?? 0,
  trades        : r => r.tradeCount60s,
  spike         : r => r.volumeSpikeRatio60s,
  impulse       : r => r.impulseScore,
  inPlay        : r => r.inPlayScore,
  readiness     : r => r.readinessScore ?? 0,
  vol24h        : r => r.quoteVol24h ?? 0,
  funding       : r => Math.abs(r.fundingRate ?? 0),
  freshness     : r => r.updatedAt,
  // ТЗ §1 canonical sort keys
  price         : r => r.lastPrice ?? 0,
  priceChange1m : r => Math.abs(r.priceChangePct),
  priceChange15m: r => Math.abs(r.priceChangePct15m ?? 0),
  volume1m      : r => r.volumeUsdt60s,
  volume15m     : r => r.volumeUsdt15m ?? 0,
  trades1m      : r => r.tradeCount60s,
  trades5m      : r => r.tradeCount5m ?? 0,
  delta         : r => Math.abs(r.delta ?? 0),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function nf(v, decimals = null) {
  if (v == null) return null;
  const f = parseFloat(v);
  if (!isFinite(f)) return null;
  return decimals != null ? parseFloat(f.toFixed(decimals)) : f;
}

/**
 * Aggregate an array of 1m bar objects (sorted ASC by ts).
 * Returns { delta5m, delta15m, volumeUsdt5m, volumeUsdt15m,
 *           buyVolumeUsdt5m, sellVolumeUsdt5m, deltaUsdt5m }.
 */
function aggregateBarsCompact(bars) {
  if (!bars || bars.length === 0) return null;

  const last15 = bars.slice(-15);
  const last5  = bars.slice(-5);

  function priceDelta(slice) {
    if (slice.length < 2) return null;
    const open  = slice[0].open;
    const close = slice[slice.length - 1].close;
    if (!open || !close) return null;
    return ((close - open) / open) * 100;
  }

  function sumF(slice, field) {
    let s = 0;
    for (const b of slice) if (b[field] != null) s += b[field];
    return s;
  }

  const delta5m  = priceDelta(last5);
  const delta15m = priceDelta(last15);

  return {
    delta5m          : delta5m  != null ? parseFloat(delta5m.toFixed(4))  : null,
    delta15m         : delta15m != null ? parseFloat(delta15m.toFixed(4)) : null,
    volumeUsdt5m     : parseFloat(sumF(last5,  'volumeUsdt').toFixed(2)),
    volumeUsdt15m    : parseFloat(sumF(last15, 'volumeUsdt').toFixed(2)),
    buyVolumeUsdt5m  : parseFloat(sumF(last5,  'buyVolumeUsdt').toFixed(2)),
    sellVolumeUsdt5m : parseFloat(sumF(last5,  'sellVolumeUsdt').toFixed(2)),
    deltaUsdt5m      : parseFloat(sumF(last5,  'deltaUsdt').toFixed(2)),
    tradeCount5m     : Math.round(sumF(last5,  'tradeCount')),
    tradeCount15m    : Math.round(sumF(last15, 'tradeCount')),
  };
}

/**
 * Build a per-symbol alert presence map from recent alerts:live entries.
 * Returns Map<symbol, { hasAlert, recentAlertType, recentAlertTs }>.
 */
function buildAlertPresenceMap(alertRaws) {
  const map = new Map();
  if (!Array.isArray(alertRaws)) return map;

  for (const raw of alertRaws) {
    const a = tryParse(raw);
    if (!a || !a.symbol) continue;
    const existing = map.get(a.symbol);
    if (!existing) {
      map.set(a.symbol, {
        hasAlert       : true,
        alertCount     : 1,
        recentAlertType: a.type     ?? null,
        recentAlertTs  : a.createdAt ?? null,
      });
    } else {
      existing.alertCount++;
      if ((a.createdAt ?? 0) > (existing.recentAlertTs ?? 0)) {
        existing.recentAlertType = a.type     ?? null;
        existing.recentAlertTs   = a.createdAt ?? null;
      }
    }
  }
  return map;
}

/**
 * Build a single normalised ScreenerRowDTO from pre-parsed Redis sources.
 */
function buildRow(sym, metrics, signal, derivatives, moveLive, presignal, barAgg, alertInfo, ticker, nowMs) {
  const pricePct  = nf(metrics.priceChangePct60s, 4) ?? 0;
  const vol60s    = nf(metrics.volumeUsdt60s)    ?? 0;
  const tr60s     = nf(metrics.tradeCount60s)    ?? 0;
  const spike60s  = nf(signal?.volumeSpikeRatio60s, 3) ?? 0;
  const impulse   = nf(signal?.impulseScore, 1)  ?? 0;
  const inPlay    = nf(signal?.inPlayScore, 1)   ?? 0;
  const impDir    = signal?.impulseDirection     ?? 'neutral';

  const quoteVol24h   = ticker ? nf(ticker.quoteVolume)          : null;
  const tradeCount24h = ticker ? nf(ticker.count)                : null;
  const pctChg24h     = ticker ? nf(ticker.priceChangePercent, 4): null;

  const fundingRate   = derivatives ? nf(derivatives.fundingRate)  : null;
  const oiValue       = derivatives ? nf(derivatives.oiValue)      : null;
  const oiDelta       = derivatives ? nf(derivatives.oiDelta5m)    : null;

  const moveEventState         = moveLive?.bestStatus    ?? null;
  const currentMovePct         = moveLive ? nf(moveLive.bestMovePct, 4) : null;
  const moveDirection          = moveLive?.bestDirection ?? null;

  const adjustedReadinessScore = presignal ? nf(presignal.adjustedReadinessScore) : null;
  const readinessLabel         = presignal?.readinessLabel  ?? null;
  const signalType             = presignal?.signalType      ?? null;

  const freshnessMs = metrics.updatedAt != null ? (nowMs - metrics.updatedAt) : null;
  const updatedAt   = metrics.updatedAt ?? nowMs;

  const hasMetrics     = true;
  const hasSignal      = signal     != null;
  const hasDerivatives = derivatives != null;
  const dataStatus     = !hasSignal || !hasDerivatives ? 'warning' : 'ok';

  return {
    // ── Identity ───────────────────────────────────────────────────
    symbol                 : sym,
    market                 : 'futures',
    marketType             : 'futures',          // ТЗ canonical alias

    // ── Price ─────────────────────────────────────────────────────
    lastPrice              : nf(metrics.lastPrice) ?? 0,
    priceChangePct         : pricePct,            // 60s rolling
    priceChangePct5m       : barAgg?.delta5m       ?? null,
    priceChangePct15m      : barAgg?.delta15m      ?? null,

    // ── Volume / trades 60s ────────────────────────────────────────
    volumeUsdt60s          : vol60s,
    tradeCount60s          : tr60s,
    buyVolumeUsdt60s       : nf(metrics.buyVolumeUsdt60s)   ?? 0,
    sellVolumeUsdt60s      : nf(metrics.sellVolumeUsdt60s)  ?? 0,
    deltaUsdt60s           : nf(metrics.deltaUsdt60s)       ?? 0,
    volumeSpikeRatio60s    : spike60s,

    // ── Volume / trades multi-period (from 1m bars) ───────────────
    volumeUsdt5m           : barAgg?.volumeUsdt5m      ?? null,
    volumeUsdt15m          : barAgg?.volumeUsdt15m     ?? null,
    buyVolumeUsdt5m        : barAgg?.buyVolumeUsdt5m   ?? null,
    sellVolumeUsdt5m       : barAgg?.sellVolumeUsdt5m  ?? null,
    deltaUsdt5m            : barAgg?.deltaUsdt5m       ?? null,
    tradeCount5m           : barAgg?.tradeCount5m      ?? null,
    tradeCount15m          : barAgg?.tradeCount15m     ?? null,

    // ── Signals ────────────────────────────────────────────────────
    impulseScore           : impulse,
    impulseDirection       : impDir,
    inPlayScore            : inPlay,
    tradeAcceleration      : nf(signal?.tradeAcceleration, 3)          ?? null,
    deltaImbalancePct60s   : nf(signal?.deltaImbalancePct60s, 3)       ?? null,
    volumeSpikeRatio15s    : nf(signal?.volumeSpikeRatio15s, 3)        ?? null,

    // ── 24h context ────────────────────────────────────────────────
    quoteVol24h            : quoteVol24h,
    tradeCount24h          : tradeCount24h,
    priceChangePct24h      : pctChg24h,

    // ── Derivatives ────────────────────────────────────────────────
    fundingRate            : fundingRate,
    oiValue                : oiValue,
    oiDelta                : oiDelta,

    // ── Move event state ───────────────────────────────────────────
    moveEventState         : moveEventState,
    currentMovePct         : currentMovePct,
    moveDirection          : moveDirection,

    // ── Pre-event readiness ────────────────────────────────────────
    readinessScore         : adjustedReadinessScore,  // ТЗ canonical name
    adjustedReadinessScore : adjustedReadinessScore,  // backwards compat
    readinessLabel         : readinessLabel,
    signalType             : signalType,

    // ── Alert presence ─────────────────────────────────────────────
    hasRecentAlert         : alertInfo?.hasAlert        ?? false,
    alertCount             : alertInfo?.alertCount      ?? 0,
    recentAlertType        : alertInfo?.recentAlertType ?? null,
    recentAlertTs          : alertInfo?.recentAlertTs   ?? null,
    lastAlertType          : alertInfo?.recentAlertType ?? null,  // ТЗ §3 canonical alias

    // ── Data quality ───────────────────────────────────────────────
    hasMetrics,
    hasSignal,
    hasDerivatives,
    dataStatus,
    freshnessMs,

    // ── Move event timestamp — used by delta change detection ────────────────────
    moveEventTs            : moveLive?.lastEventTs         ?? null,

    // ── Cursor ─────────────────────────────────────────────────────────────────────
    updatedAt,

    // ── ТЗ §1 canonical field aliases (stable contract names per spec) ───────────
    price              : nf(metrics.lastPrice)          ?? 0,
    priceChangePct1m   : pricePct,                         // 60s rolling ≈ 1m bar window
    volumeUsdt1m       : vol60s,
    tradeCount1m       : tr60s,
    buyVolume          : nf(metrics.buyVolumeUsdt60s)   ?? 0,
    sellVolume         : nf(metrics.sellVolumeUsdt60s)  ?? 0,
    delta              : nf(metrics.deltaUsdt60s)       ?? 0,
    volumeSpikeRatio   : spike60s,
    quoteVolume24h     : quoteVol24h,
    alertPresence      : alertInfo?.hasAlert            ?? false,
    moveState          : moveEventState,
    ts                 : updatedAt,
  };
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

function passesFilters(row, filters) {
  const {
    marketType,
    priceDir,
    priceMinPct,
    priceMaxPct,
    volumeGrowthMin,
    tradesMin,
    turnoverMin,
    vol24hMin,
    minImpulse,
    minInPlay,
    minReadiness,
    minFundingPct,
    hasMoves,
    hasAlerts,
    symbolSearch,
  } = filters;

  if (marketType && row.market !== marketType)               return false;
  if (priceDir === 'up'   && row.priceChangePct <= 0)        return false;
  if (priceDir === 'down' && row.priceChangePct >= 0)        return false;

  const absPct = Math.abs(row.priceChangePct);
  if (priceMinPct   != null && absPct        < priceMinPct)  return false;
  if (priceMaxPct   != null && absPct        > priceMaxPct)  return false;

  if (volumeGrowthMin != null) {
    const neededSpike = 1 + volumeGrowthMin / 100;
    if (row.volumeSpikeRatio60s < neededSpike)               return false;
  }
  if (tradesMin   != null && row.tradeCount60s   < tradesMin)  return false;
  if (turnoverMin != null && row.volumeUsdt60s   < turnoverMin) return false;
  if (vol24hMin   != null && (row.quoteVol24h ?? 0) < vol24hMin) return false;
  if (minImpulse  != null && row.impulseScore    < minImpulse)  return false;
  if (minInPlay   != null && row.inPlayScore     < minInPlay)   return false;
  if (minReadiness!= null && (row.readinessScore ?? 0) < minReadiness) return false;
  if (minFundingPct!= null && Math.abs(row.fundingRate ?? 0) * 100 < minFundingPct) return false;
  if (hasMoves    === true  && !row.moveEventState)            return false;
  if (hasAlerts   === true  && !row.hasRecentAlert)            return false;

  if (symbolSearch) {
    const q = symbolSearch.toUpperCase();
    if (!row.symbol.includes(q))                             return false;
  }

  return true;
}

// ─── Core pipeline executor ───────────────────────────────────────────────────

/**
 * Run the full pipeline for all symbols.
 * Returns { symbols, raw, tickerMap, alertMap, pipelineMs }
 */
async function runPipeline(redis, alertSinceMs) {
  const t0 = Date.now();

  // ── Round 1: singletons ──────────────────────────────────────────
  const symbolsRaw = await redis.get('symbols:active:usdt');
  if (!symbolsRaw) return null;

  const symbols  = tryParse(symbolsRaw) || [];
  if (!symbols.length) return { symbols: [], raw: [], tickerMap: new Map(), alertMap: new Map(), pipelineMs: 0 };

  const tickersRaw = await redis.get('futures:tickers:all');
  const tickers    = tryParse(tickersRaw) || [];
  const tickerMap  = new Map();
  for (const t of tickers) if (t.symbol) tickerMap.set(t.symbol, t);

  // ── Round 2: big pipeline per-symbol + alerts:live ───────────────
  const pipe = redis.pipeline();
  for (const sym of symbols) {
    pipe.get(`metrics:${sym}`);                              // i*6+0
    pipe.get(`signal:${sym}`);                              // i*6+1
    pipe.get(`derivatives:${sym}`);                         // i*6+2
    pipe.get(`move:live:${sym}`);                           // i*6+3
    pipe.get(`presignal:${sym}`);                           // i*6+4
    pipe.zrange(`bars:1m:${sym}`, -BAR_FETCH_COUNT, -1);   // i*6+5
  }
  // Alert lookup appended at end of the same pipeline (one extra round-trip saved)
  const alertWindowStart = alertSinceMs ?? (Date.now() - ALERT_LOOKBACK_MS);
  pipe.zrangebyscore('alerts:live', alertWindowStart, '+inf');

  const raw = await pipe.exec();

  // Alert map (last entry in pipeline)
  const alertRaws = raw[symbols.length * KEYS_PER_SYM]?.[1] || [];
  const alertMap  = buildAlertPresenceMap(alertRaws);

  const pipelineMs = Date.now() - t0;
  return { symbols, raw, tickerMap, alertMap, pipelineMs };
}

// ─── Snapshot / delta shared cache ──────────────────────────────────────────

/**
 * Internal: build the full screener cache from Redis.
 * @returns {Promise<CacheEntry>}
 */
async function _buildCache(redis) {
  const ctx = await runPipeline(redis, null);
  const now = Date.now();

  if (!ctx) return { ts: now, allRows: [], alertRaws: [], totalScanned: 0, pipelineMs: 0, buildMs: 0 };

  const { symbols, raw, tickerMap, alertMap, pipelineMs } = ctx;

  if (!symbols.length) {
    return { ts: now, allRows: [], alertRaws: [], totalScanned: 0, pipelineMs, buildMs: 0 };
  }

  const buildStart = Date.now();
  const allRows    = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym     = symbols[i];
    const metrics = tryParse(raw[i * KEYS_PER_SYM    ]?.[1]);
    if (!metrics) continue;

    const signal      = tryParse(raw[i * KEYS_PER_SYM + 1]?.[1]);
    const derivatives = tryParse(raw[i * KEYS_PER_SYM + 2]?.[1]);
    const moveLive    = tryParse(raw[i * KEYS_PER_SYM + 3]?.[1]);
    const presignal   = tryParse(raw[i * KEYS_PER_SYM + 4]?.[1]);
    const barsRaw     = raw[i * KEYS_PER_SYM + 5]?.[1];

    const barsParsed = Array.isArray(barsRaw)
      ? barsRaw.map(r => tryParse(r)).filter(Boolean).sort((a, b) => a.ts - b.ts)
      : [];
    const barAgg   = aggregateBarsCompact(barsParsed);

    const ticker   = tickerMap.get(sym) || null;
    const alertInf = alertMap.get(sym)  || null;

    allRows.push(buildRow(sym, metrics, signal, derivatives, moveLive, presignal, barAgg, alertInf, ticker, now));
  }

  const alertRaws = raw[symbols.length * KEYS_PER_SYM]?.[1] || [];
  const buildMs   = Date.now() - buildStart;

  return { ts: now, allRows, alertRaws, totalScanned: symbols.length, pipelineMs, buildMs };
}

/**
 * Return (or build+cache) the full set of all screener rows and alert raws.
 * Uses an in-flight promise sentinel to prevent concurrent cache rebuilds
 * ("thundering herd" / race condition).
 *
 * @returns {Promise<CacheEntry|null>}
 */
async function _getOrBuildCache(redis) {
  const now = Date.now();
  if (_screenerCache && (now - _screenerCache.ts) < SNAPSHOT_CACHE_TTL) {
    _cacheHits++;
    return _screenerCache;
  }

  // If a build is already in flight, wait for it instead of starting another
  if (_screenerCacheBuilding) {
    return _screenerCacheBuilding;
  }

  _cacheMisses++;
  _screenerCacheBuilding = _buildCache(redis)
    .then(entry => {
      _screenerCache         = entry;
      _screenerCacheBuilding = null;
      return entry;
    })
    .catch(err => {
      _screenerCacheBuilding = null;
      throw err;
    });
  return _screenerCacheBuilding;
}

/**
 * Return current cache statistics (hits, misses, age, state).
 */
function getCacheStats() {
  const age = _screenerCache ? Date.now() - _screenerCache.ts : null;
  return {
    hits          : _cacheHits,
    misses        : _cacheMisses,
    hitRate       : (_cacheHits + _cacheMisses) > 0
                    ? parseFloat((_cacheHits / (_cacheHits + _cacheMisses) * 100).toFixed(1))
                    : null,
    cacheAgeMs    : age,
    cacheValid    : age != null && age < SNAPSHOT_CACHE_TTL,
    building      : _screenerCacheBuilding != null,
    rowCount      : _screenerCache ? _screenerCache.allRows.length : 0,
    ttlMs         : SNAPSHOT_CACHE_TTL,
  };
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Build a full snapshot of all screener rows.
 *
 * @param {object}  redis
 * @param {object}  [opts]
 *   sortBy           string   — sort field key (default: 'priceChange')
 *   sortDir          string   — 'asc' | 'desc' (default: 'desc')
 *   limit            number   — max rows to return (default: 200, max: 500)
 *   priceDir         string   — 'up' | 'down' | 'any'
 *   priceMinPct      number
 *   priceMaxPct      number
 *   volumeGrowthMin  number   — min spike growth %
 *   tradesMin        number
 *   turnoverMin      number
 *   vol24hMin        number
 *   minImpulse       number
 *   minInPlay        number
 *   minReadiness     number
 *   minFundingPct    number
 *   hasMoves         bool
 *   hasAlerts        bool
 *   symbolSearch     string
 * @returns {Promise<SnapshotResult>}
 */
async function getSnapshot(redis, opts = {}) {
  const t0   = Date.now();
  const data = await _getOrBuildCache(redis);
  if (!data) {
    return { rows: [], totalScanned: 0, totalMatched: 0, snapshotTs: t0, nextCursor: t0, pipelineMs: 0, buildMs: 0 };
  }

  const { sortBy = 'priceChange', sortDir = 'desc', limit = 200, ...filters } = opts;
  const hasFilters = Object.keys(filters).some(k => filters[k] !== undefined);
  const filtered   = hasFilters
    ? data.allRows.filter(r => passesFilters(r, filters))
    : data.allRows;

  const sortFn   = SORT_FIELDS[sortBy] || SORT_FIELDS.priceChange;
  const mult     = sortDir === 'asc' ? 1 : -1;
  const sorted   = [...filtered].sort((a, b) => mult * (sortFn(a) - sortFn(b)));
  const limitNum = Math.min(parseInt(limit, 10) || 200, MAX_LIMIT);
  const nowMs    = Date.now();

  return {
    rows         : sorted.slice(0, limitNum),
    totalScanned : data.totalScanned,
    totalMatched : filtered.length,
    snapshotTs   : nowMs,
    nextCursor   : nowMs,
    pipelineMs   : data.pipelineMs,
    buildMs      : data.buildMs,
  };
}

/**
 * Return only rows that changed since `since` (ms cursor).
 *
 * A row is "changed" if:
 *   metrics.updatedAt > since   (price/volume ticked)
 *   OR moveLive has events updated after since
 *
 * Also returns new alerts from alerts:live since the cursor.
 *
 * @param {object}  redis
 * @param {number}  since     — ms cursor from previous response's nextCursor
 * @param {object}  [opts]    — same filter/sort options as getSnapshot
 * @returns {Promise<DeltaResult>}
 */
async function getDelta(redis, since, opts = {}) {
  const t0    = Date.now();
  const nowMs = t0;

  // Cursor freshness check — if too old, tell the client to full-resync
  if (typeof since !== 'number' || isNaN(since) || (nowMs - since) > MAX_SINCE_AGE_MS) {
    return {
      fullResyncRequired : true,
      reason             : since == null ? 'no_cursor' : 'cursor_too_old',
      serverTs           : nowMs,
      nextCursor         : nowMs,
    };
  }

  const data = await _getOrBuildCache(redis);
  if (!data) {
    return { changedRows: [], newAlerts: [], nextCursor: nowMs, serverTs: nowMs, totalChanged: 0, pipelineMs: 0, fullResyncRequired: false };
  }

  const { sortBy = 'priceChange', sortDir = 'desc', limit = 200, ...filters } = opts;
  const hasFilters = Object.keys(filters).some(k => filters[k] !== undefined);

  // Delta detection from cached rows — no extra Redis read needed
  const changedAll = data.allRows.filter(r =>
    (r.updatedAt   ?? 0) > since ||
    (r.moveEventTs ?? 0) > since
  );

  const changedFiltered = hasFilters
    ? changedAll.filter(r => passesFilters(r, filters))
    : changedAll;

  const sortFn = SORT_FIELDS[sortBy] || SORT_FIELDS.priceChange;
  const mult   = sortDir === 'asc' ? 1 : -1;
  changedFiltered.sort((a, b) => mult * (sortFn(a) - sortFn(b)));

  const limitNum = Math.min(parseInt(limit, 10) || 200, MAX_LIMIT);

  // New alerts: filter from cached 1h alert window
  const newAlerts = data.alertRaws
    .map(r => tryParse(r))
    .filter(a => a && a.createdAt > since)
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    fullResyncRequired : false,
    changedRows        : changedFiltered.slice(0, limitNum),
    newAlerts,
    totalChanged       : changedAll.length,
    nextCursor         : nowMs,
    serverTs           : nowMs,
    pipelineMs         : data.pipelineMs,
  };
}

/**
 * Get symbols count and basic health info for the diagnostics endpoint.
 */
async function getDiagnostics(redis) {
  const t0 = Date.now();

  // Load futures + spot symbol lists in parallel
  const [symbolsRaw, spotSymbolsRaw] = await Promise.all([
    redis.get('symbols:active:usdt'),
    redis.get('spot:symbols:active:usdt'),
  ]);

  const symbols     = tryParse(symbolsRaw)     || [];
  const spotSymbols = tryParse(spotSymbolsRaw) || [];

  if (!symbols.length) {
    return {
      symbolsTotal         : 0,
      metricsAvailable     : 0,
      signalAvailable      : 0,
      derivativesAvailable : 0,
      staleCount           : 0,
      symbolsSpotTotal     : spotSymbols.length,
      spotMetricsAvailable : 0,
      avgMetricsFreshnessMs: null,
      maxMetricsFreshnessMs: null,
      diagMs               : Date.now() - t0,
    };
  }

  // Sample spot symbols to avoid heavy pipeline (first 50)
  const spotSample = spotSymbols.slice(0, 50);

  const pipe = redis.pipeline();
  for (const sym of symbols) {
    pipe.get(`metrics:${sym}`);      // i*3+0
    pipe.get(`signal:${sym}`);       // i*3+1
    pipe.get(`derivatives:${sym}`);  // i*3+2
  }
  for (const sym of spotSample) {
    pipe.get(`spot:metrics:${sym}`); // symbols.length*3 + j
  }
  const raw = await pipe.exec();

  let metricsOk = 0, signalOk = 0, derivOk = 0, staleCount = 0;
  let sumFreshnessMs = 0, maxFreshnessMs = 0, freshCount = 0;
  const nowMs    = Date.now();
  const STALE_MS = 5 * 60 * 1000;

  for (let i = 0; i < symbols.length; i++) {
    const m = tryParse(raw[i * 3    ]?.[1]);
    const s = tryParse(raw[i * 3 + 1]?.[1]);
    const d = tryParse(raw[i * 3 + 2]?.[1]);
    if (m) {
      metricsOk++;
      if (m.updatedAt) {
        const age = nowMs - m.updatedAt;
        sumFreshnessMs += age;
        if (age > maxFreshnessMs) maxFreshnessMs = age;
        freshCount++;
        if (age > STALE_MS) staleCount++;
      }
    }
    if (s) signalOk++;
    if (d) derivOk++;
  }

  // Spot availability — scale estimate from the sample
  const spotOffset    = symbols.length * 3;
  let   spotMetricsOk = 0;
  for (let j = 0; j < spotSample.length; j++) {
    if (tryParse(raw[spotOffset + j]?.[1])) spotMetricsOk++;
  }
  const spotMetricsAvailable = spotSample.length > 0
    ? Math.round((spotMetricsOk / spotSample.length) * spotSymbols.length)
    : 0;

  return {
    symbolsTotal         : symbols.length,
    metricsAvailable     : metricsOk,
    signalAvailable      : signalOk,
    derivativesAvailable : derivOk,
    staleCount,
    symbolsSpotTotal     : spotSymbols.length,
    spotMetricsAvailable,
    avgMetricsFreshnessMs: freshCount > 0 ? Math.round(sumFreshnessMs / freshCount) : null,
    maxMetricsFreshnessMs: maxFreshnessMs > 0 ? maxFreshnessMs : null,
    diagMs               : Date.now() - t0,
  };
}

/**
 * Scan all presignal:<SYM> keys and return filtered, sorted results.
 * Shared by /api/screener/pre-moves and /api/pre-signals.
 *
 * @param {object} redis
 * @param {object} [opts]
 *   minReadiness     number  — min readinessScore (default 0)
 *   minConfidence    number  — min confidenceScore (default 0)
 *   signalType       string
 *   directionBias    string  — up|down|neutral
 *   wallBias         string  — bid-heavy|ask-heavy|neutral
 *   accelerationState string
 *   maxDistancePct   number  — max distanceToConditionPct
 *   limit            number  — max results (default 50, max 200)
 * @returns {Promise<object[]>}
 */
async function getPreMoveScan(redis, opts = {}) {
  const {
    minReadiness   = 0,
    minConfidence  = 0,
    signalType,
    directionBias,
    wallBias,
    accelerationState,
    maxDistancePct = null,
    limit          = 50,
  } = opts;

  const minReadinessN = parseFloat(minReadiness)  || 0;
  const minConfN      = parseFloat(minConfidence) || 0;
  const maxDistN      = maxDistancePct != null ? parseFloat(maxDistancePct) : null;
  const limitNum      = Math.min(parseInt(limit, 10) || 50, 200);

  const symbolsRaw = await redis.get('symbols:active:usdt');
  if (!symbolsRaw) return [];
  const symbols = tryParse(symbolsRaw) || [];
  if (!symbols.length) return [];

  const pipe = redis.pipeline();
  for (const sym of symbols) pipe.get(`presignal:${sym}`);
  const raw = await pipe.exec();

  const items = [];
  for (let i = 0; i < symbols.length; i++) {
    const ps = tryParse(raw[i][1]);
    if (!ps) continue;
    if (ps.readinessScore  < minReadinessN) continue;
    if (ps.confidenceScore < minConfN)      continue;
    if (signalType        && ps.signalType        !== signalType)        continue;
    if (directionBias     && ps.directionBias     !== directionBias)     continue;
    if (wallBias          && ps.wallBias          !== wallBias)          continue;
    if (accelerationState && ps.accelerationState !== accelerationState) continue;
    if (maxDistN !== null && ps.distanceToConditionPct != null && ps.distanceToConditionPct > maxDistN) continue;
    items.push(ps);
  }

  items.sort((a, b) => b.readinessScore - a.readinessScore);
  return items.slice(0, limitNum);
}

module.exports = { getSnapshot, getDelta, getDiagnostics, getPreMoveScan, getCacheStats, KEYS_PER_SYM, MAX_SINCE_AGE_MS };
