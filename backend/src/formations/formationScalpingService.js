'use strict';

/**
 * formationScalpingService.js — the 1-second scanner.
 *
 * Each tick:
 *   1. read active futures USDT symbols
 *   2. check liquidity gate
 *   3. read light per-symbol state (price/metrics) for all eligible symbols
 *   4. [LEGACY — disabled when config.legacyEngineEnabled = false]
 *      run V3 geometry engine → upsert DETECTED/APPROACHING/READY formations
 *   5. [V1 pattern engine — enabled when config.patternEngineEnabled = true]
 *      read trackedExtremes → find Double Top / Double Bottom structures →
 *      upsert ACTIVE pattern formations
 *   6. run the lifecycle over all stored formations → remove terminal ones
 *
 * Philosophy: V1 pattern formations are detected from visual extremes.
 * Current price is used ONLY for lifecycle checks (breakout / invalidation).
 */

const { createEngineV3 } = require('./v3/engineV3');
const { aggregate } = require('./v3/timeframes');
const lifecycle = require('./formationLifecycle');
const { createPatternEngine } = require('./patternEngine/formationPatternEngine');
const { runExtremeFormations, evaluateExtremeLifecycle } = require('./strategies/extremeFormationsStrategy');
const eventBus = require('../services/wsEventBus');
const { binanceFetch } = require('../utils/binanceRestLogger');

const manualLevelsStore    = require('../services/manualLevelsStore');
const manualSlopedLevelsStore = require('../services/manualSlopedLevelsStore');
const trackedLevelsStore   = require('../services/trackedLevelsStore');
const trackedExtremesStore = require('../services/trackedExtremesStore');
const savedRaysStore       = require('../services/savedRaysStore');

const BINANCE_SPOT_BASE = 'https://api.binance.com';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';
const VALID_LEVEL_SOURCES = new Set([
  'manual-levels',
  'tracked-levels',
  'auto-levels',
  'saved-rays',
  'tracked-extremes',
  'vertical-extremes',
  'sloped-levels',
]);

function tryParse(raw) { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }

// Normalise a stored-tool record into the shape levelSources expects.
function normStored(l, source) {
  const sourceNorm = String(source || '').trim().toLowerCase();
  const sourceTf = l.sourceTf || l.tf || l.timeframe || null;
  const visibleOnTestPage = typeof l.visibleOnTestPage === 'boolean'
    ? l.visibleOnTestPage
    : (typeof l.visibleOnAllTimeframes === 'boolean' ? l.visibleOnAllTimeframes : true);
  return {
    id:                 l.id ?? null,
    price:              Number(l.price),
    side:               l.side ?? l.type ?? null,
    type:               l.type ?? null,
    touches:            Number(l.touches) || 1,
    strength:           Number(l.strength ?? l.score) || 0,
    source:             sourceNorm || source,
    tf:                 sourceTf,
    sourceTf,
    visibleOnTestPage,
    createdAt:          l.createdAt || null,
    updatedAt:          l.updatedAt || null,
    formationTimestamp: l.formationTimestamp || null,
  };
}

function parseWalls(raw) {
  const v = tryParse(raw);
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.walls)) return v.walls;
  return [];
}

function createFormationService({ redis, store, config }) {
  // Legacy V3 geometry engine (disabled when config.legacyEngineEnabled = false)
  const engine = createEngineV3(config);

  // V1 Pattern engine
  const patternEngine = config.patternEngineEnabled !== false
    ? createPatternEngine(config.patternEngine)
    : null;

  // Cache for pattern engine extremes: symbol → { extremesByTf: Map<tf, extreme[]>, builtAt }
  const patternExtremesCache = new Map();
  const PATTERN_EXTREMES_TTL = config.storedLevelsRefreshMs || 30_000;
  const tfHistoryCache = new Map(); // key(symbol:tf) -> { bars, builtAt, failAt }

  const barsCache = new Map();       // symbol → { bars, builtAt }   (raw 1m bars)
  const tfBarsCache = new Map();     // symbol → { tfBars: Map, builtAt }
  const nextAnalyzeAt = new Map();   // symbol → ts (per-symbol scheduler)
  let storedLevels = { bySymbol: new Map(), builtAt: 0 }; // file-store levels grouped by symbol
  let timer = null;
  let running = false;   // re-entrancy guard for a single tick
  let started = false;   // whether the scan loop is active (start/stop)
  const lifecycleEvents = []; // newest last, bounded ring buffer
  const MAX_LIFECYCLE_EVENTS = 2000;
  const rejectLog = [];        // rolling log of rejected extreme candidates (newest last)
  const MAX_REJECT_LOG = 100;
  let _lastTickExtremeStats = null; // stats snapshot from the most recent tick
  // Liquidity cache — refreshed at most once per cacheTtlMs (default 60 s).
  // detailsBySymbol: Map<symbol, { volume24hUsd, volumeSource, trades24h, tradesSource,
  //                                  volumeOk, tradesOk, eligible, reason }>
  let _liquidityCache            = null;  // { updatedAt, ttlMs, liquidSymbols, rejectedSymbols, detailsBySymbol, stats }
  let _liquidityRefreshInProgress = false; // prevents parallel Redis reads
  let _lastLiquidityStats        = null;  // last computed stats exposed via getStats()
  const stats = {
    runs: 0, errors: 0, lastRunMs: 0,
    created: 0, updated: 0, removed: 0,
    skippedLowLiquidity: 0,                 // cumulative
    symbolsScanned: 0, lowLiquiditySkipped: 0, eligibleSymbols: 0, // last tick
    // V1 pattern engine counters (cumulative since start)
    patternCandidatesFound:   0,
    patternDuplicatesRemoved: 0,
    patternFormationsStored:  0,
    lastError: null, lastTickAt: null,
  };

  const tfTargetBars = config.tfTargetBars || {};
  const tfHistoryBackfill = config.tfHistoryBackfill || {};

  function getTfTargetBars(tf) {
    const v = Number(tfTargetBars?.[tf]);
    return Number.isFinite(v) && v > 0 ? Math.max(30, Math.floor(v)) : 200;
  }

  function recordLifecycleEvent(event) {
    lifecycleEvents.push({ ts: Date.now(), ...event });
    if (lifecycleEvents.length > MAX_LIFECYCLE_EVENTS) {
      lifecycleEvents.splice(0, lifecycleEvents.length - MAX_LIFECYCLE_EVENTS);
    }
  }

  function normalizeLevelSource(value) {
    const s = String(value || '').trim().toLowerCase();
    if (s === 'autolevels') return 'auto-levels';
    if (s === 'manual') return 'manual-levels';
    if (s === 'tracked') return 'tracked-levels';
    if (s === 'extremes') return 'tracked-extremes';
    return s;
  }

  function buildPromotedLevelBasedCandidate(formation, patternType, status, lifecycleReason) {
    const now = Date.now();
    const symbol = String(formation.symbol || '').toUpperCase();
    const marketType = formation.marketType || config.marketType;
    const tf = formation.tf || '1m';
    const levelPrice = Number(formation.levelPrice ?? formation.breakLevel ?? formation.levels?.breakoutLevel ?? 0);
    const levelId = formation.levelId || null;
    const levelSource = formation.levelSource || null;
    const fingerprint = `${symbol}:${marketType}:LEVEL_BASED:${tf}:${patternType}:${levelId || String(levelPrice)}`;
    return {
      id: `${symbol}_${tf}_${patternType}_${Number(levelPrice || 0).toFixed(8)}`,
      fingerprint,
      symbol,
      marketType,
      tf,
      patternType,
      strategy: 'levelBased',
      direction: patternType === 'SUPPORT_BREAKDOWN' ? 'SHORT' : 'LONG',
      status,
      breakDirection: patternType === 'SUPPORT_BREAKDOWN' ? 'DOWN' : 'UP',
      breakLevel: Number(levelPrice || 0),
      levelId,
      levelSource,
      levelTf: formation.levelTf || null,
      sourceTf: formation.sourceTf || formation.levelTf || null,
      confluenceTf: Boolean(formation.confluenceTf),
      debugTfReason: formation.debugTfReason || 'OK',
      levelType: formation.levelType || (patternType === 'SUPPORT_BREAKDOWN' ? 'SUPPORT' : 'RESISTANCE'),
      levelPrice: Number(levelPrice || 0),
      levelCreatedAt: formation.levelCreatedAt || null,
      extremeTf: formation.extremeTf || null,
      extremeIds: Array.isArray(formation.extremeIds) ? formation.extremeIds : [],
      extremeSource: formation.extremeSource || null,
      isVisibleOnTestPage: formation.isVisibleOnTestPage,
      visibleOnTestPage: formation.visibleOnTestPage,
      zoneLower: formation.zoneLower ?? null,
      zoneUpper: formation.zoneUpper ?? null,
      tolerancePct: formation.tolerancePct ?? null,
      touches: formation.touches ?? null,
      touchPoints: formation.touchPoints ?? [],
      candidateTouches: formation.candidateTouches ?? [],
      independentTouches: formation.independentTouches ?? null,
      touchClusterCount: formation.touchClusterCount ?? null,
      touchTimeSpreadBars: formation.touchTimeSpreadBars ?? null,
      touchTimeSpreadMinutes: formation.touchTimeSpreadMinutes ?? null,
      barsCrossedCount: formation.barsCrossedCount ?? null,
      cleanTouchCount: formation.cleanTouchCount ?? null,
      bodyCrossCount: formation.bodyCrossCount ?? null,
      wickTouchCount: formation.wickTouchCount ?? null,
      levelAgeBars: formation.levelAgeBars ?? null,
      levelAgeMinutes: formation.levelAgeMinutes ?? null,
      firstTouchTime: formation.firstTouchTime ?? null,
      lastTouchTime: formation.lastTouchTime ?? null,
      avgReactionPct: formation.avgReactionPct ?? null,
      maxReactionPct: formation.maxReactionPct ?? null,
      distancePct: formation.distancePct ?? null,
      breakdownPct: patternType === 'SUPPORT_BREAKDOWN' ? (formation.breakdownPct ?? 0) : null,
      breakoutPct: patternType === 'RESISTANCE_BREAKOUT' ? (formation.breakoutPct ?? 0) : null,
      volumeFactor: formation.volumeFactor ?? null,
      score: formation.score ?? 0,
      scoreBreakdown: formation.scoreBreakdown ?? null,
      chartRange: formation.chartRange ?? null,
      supportLevel: formation.supportLevel ?? (patternType === 'SUPPORT_BREAKDOWN' ? Number(levelPrice || 0) : null),
      supportSource: formation.supportSource ?? (patternType === 'SUPPORT_BREAKDOWN' ? levelSource : null),
      resistanceLevel: formation.resistanceLevel ?? (patternType === 'RESISTANCE_BREAKOUT' ? Number(levelPrice || 0) : null),
      resistanceSource: formation.resistanceSource ?? (patternType === 'RESISTANCE_BREAKOUT' ? levelSource : null),
      selectedLevel: formation.selectedLevel || null,
      selectedExtremes: formation.selectedExtremes || [],
      lifecycleStatus: status,
      lifecycleReason,
      breakDetectedAt: now,
      updatedAt: now,
    };
  }

  function normalizeKlineBar(row) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const ts = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volumeBase = Number(row[5]);
    const volumeQuote = Number(row[7]);
    if (![ts, open, high, low, close].every(Number.isFinite)) return null;
    return {
      ts,
      open,
      high,
      low,
      close,
      volumeUsdt: Number.isFinite(volumeQuote) ? volumeQuote : (Number.isFinite(volumeBase) ? volumeBase : 0),
      deltaUsdt: 0,
    };
  }

  async function fetchTfKlines(symbol, tf, limit, marketType) {
    const base = marketType === 'spot' ? BINANCE_SPOT_BASE : BINANCE_FUTURES_BASE;
    const path = marketType === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${Math.max(30, limit)}`;
    const timeoutMs = Number(tfHistoryBackfill.requestTimeoutMs) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    try {
      const res = await binanceFetch(
        url,
        { signal: controller.signal },
        'formationScalpingService',
        symbol,
        `tf-history:${tf}:${limit}`,
        { critical: true },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`klines ${tf} status=${res.status} ${text}`.trim());
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) return [];
      return raw.map(normalizeKlineBar).filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureTfBarsDepth(symbol, tfBarsMap, now) {
    const candlesByTf = {};
    const candlesReadinessByTf = {};
    const backfillEnabled = tfHistoryBackfill.enabled !== false;
    const cacheTtlMs = Number(tfHistoryBackfill.cacheTtlMs) || (15 * 60 * 1000);

    for (const tf of config.timeframes || []) {
      const required = getTfTargetBars(tf);
      let bars = Array.isArray(tfBarsMap.get(tf)) ? tfBarsMap.get(tf) : [];

      if (bars.length < required && backfillEnabled) {
        const key = `${symbol}:${tf}`;
        const cached = tfHistoryCache.get(key);
        const isFresh = cached && (now - cached.builtAt) <= cacheTtlMs;
        const inFailCooldown = cached?.failAt && (now - cached.failAt) < 60_000;

        if (isFresh && Array.isArray(cached.bars) && cached.bars.length >= required) {
          bars = cached.bars;
        } else if (!inFailCooldown) {
          try {
            const fetched = await fetchTfKlines(symbol, tf, required, config.marketType);
            if (fetched.length > 0) {
              bars = fetched;
              tfHistoryCache.set(key, { bars: fetched, builtAt: now, failAt: null });
            }
          } catch (_) {
            tfHistoryCache.set(key, {
              bars: Array.isArray(cached?.bars) ? cached.bars : [],
              builtAt: cached?.builtAt || now,
              failAt: now,
            });
          }
        }
      }

      const clipped = bars.slice(-required);
      tfBarsMap.set(tf, clipped);
      candlesByTf[tf] = clipped.length;
      candlesReadinessByTf[tf] = {
        symbol,
        tf,
        candlesLoaded: clipped.length,
        required,
        ready: clipped.length >= required,
      };
    }

    return { tfBarsMap, candlesByTf, candlesReadinessByTf };
  }

  // ── Liquidity gate (FIRST filter) ───────────────────────────────────────────
  // Reads the Binance 24h ticker snapshot AT MOST once per cacheTtlMs (60 s).
  // Returns the cached detailsBySymbol Map on subsequent calls within the TTL.
  //
  // Pass logic: config.formationLiquidityFilter.mode === 'OR'  (default)
  //   eligible = volume24hUsd >= minVolume24hUsd  OR  trades24h >= minTrades24h
  //
  // Supports multiple Binance field-name variations:
  //   volume : volume24hUsd | quoteVolume | quoteVolume24h
  //   trades : trades24h | count | tradeCount | tradeCount24h
  //
  // Returns Map<symbol, { volume24hUsd, volumeSource, trades24h, tradesSource,
  //                        volumeOk, tradesOk, eligible, reason }>.
  async function readLiquidity() {
    const liqCfg   = config.formationLiquidityFilter ?? {};
    const cacheTtl = liqCfg.cacheTtlMs ?? 60_000;
    const now      = Date.now();

    // ── Cache hit ────────────────────────────────────────────────────────────
    if (_liquidityCache && (now - _liquidityCache.updatedAt) < cacheTtl) {
      return _liquidityCache.detailsBySymbol;
    }

    // ── Lock: skip parallel refresh, return stale cache if available ─────────
    if (_liquidityRefreshInProgress) {
      return _liquidityCache ? _liquidityCache.detailsBySymbol : new Map();
    }
    _liquidityRefreshInProgress = true;

    try {
      const enabled   = liqCfg.enabled !== false;
      const minVol    = liqCfg.minVolume24hUsd ?? config.minVolume24h ?? 40_000_000;
      const minTrades = liqCfg.minTrades24h    ?? config.minTrades24h ?? 400_000;
      const useOr     = (liqCfg.mode ?? 'OR') !== 'AND';

      const map  = new Map();
      const raw  = tryParse(await redis.get(config.tickersKey));
      const tickers = Array.isArray(raw) ? raw : (raw?.tickers ?? []);

      const liquidSymbols   = [];
      const rejectedSymbols = [];
      let passedByVolume = 0, passedByTrades = 0, passedByBoth = 0, rejectedByBoth = 0;

      for (const t of tickers) {
        if (!t || !t.symbol) continue;

        // Volume — detect source field
        let volume24hUsd = 0, volumeSource = null;
        if (t.volume24hUsd  != null) { volume24hUsd = parseFloat(t.volume24hUsd)   || 0; volumeSource = 'volume24hUsd'; }
        else if (t.quoteVolume   != null) { volume24hUsd = parseFloat(t.quoteVolume)   || 0; volumeSource = 'quoteVolume'; }
        else if (t.quoteVolume24h != null){ volume24hUsd = parseFloat(t.quoteVolume24h)|| 0; volumeSource = 'quoteVolume24h'; }

        // Trades — detect source field
        let trades24h = 0, tradesSource = null;
        if (t.trades24h     != null) { trades24h = parseInt(t.trades24h,     10) || 0; tradesSource = 'trades24h'; }
        else if (t.count         != null) { trades24h = parseInt(t.count,         10) || 0; tradesSource = 'count'; }
        else if (t.tradeCount    != null) { trades24h = parseInt(t.tradeCount,    10) || 0; tradesSource = 'tradeCount'; }
        else if (t.tradeCount24h != null) { trades24h = parseInt(t.tradeCount24h, 10) || 0; tradesSource = 'tradeCount24h'; }

        const volumeOk = volume24hUsd >= minVol;
        const tradesOk = trades24h    >= minTrades;

        let eligible, reason;
        if (!enabled) {
          eligible = true;
          reason   = 'FILTER_DISABLED';
        } else if (useOr ? (volumeOk || tradesOk) : (volumeOk && tradesOk)) {
          eligible = true;
          if (volumeOk && tradesOk) { reason = 'VOLUME_AND_TRADES_OK'; passedByBoth++; }
          else if (volumeOk)        { reason = 'VOLUME_OK';            passedByVolume++; }
          else                      { reason = 'TRADES_OK';            passedByTrades++; }
        } else {
          eligible = false;
          reason   = 'LIQUIDITY_FILTER_FAILED';
          rejectedByBoth++;
        }

        map.set(t.symbol, { volume24hUsd, volumeSource, trades24h, tradesSource, volumeOk, tradesOk, eligible, reason });
        if (eligible) liquidSymbols.push(t.symbol);
        else          rejectedSymbols.push(t.symbol);
      }

      const statsObj = {
        enabled,
        mode:            liqCfg.mode ?? 'OR',
        minVolume24hUsd: minVol,
        minTrades24h:    minTrades,
        totalSymbols:    liquidSymbols.length + rejectedSymbols.length,
        passedSymbols:   liquidSymbols.length,
        rejectedSymbols: rejectedSymbols.length,
        passedByVolume,
        passedByTrades,
        passedByBoth,
        rejectedByBoth,
        lastUpdatedAt:   now,
        cacheAgeMs:      0,
      };

      _liquidityCache = {
        updatedAt:       now,
        ttlMs:           cacheTtl,
        liquidSymbols,
        rejectedSymbols,
        detailsBySymbol: map,
        stats:           statsObj,
      };
      return map;

    } finally {
      _liquidityRefreshInProgress = false;
    }
  }

  // ── Stored-tool levels (Extremes + Levels). Re-read at most every
  //     storedLevelsRefreshMs and group by symbol. File stores are synchronous. ─
  function refreshStoredLevels(now) {
    if (now - storedLevels.builtAt < (config.storedLevelsRefreshMs || 30_000)) return;
    const bySymbol = new Map();
    const push = (rec) => {
      if (!rec.price || !Number.isFinite(rec.price)) return;
      const key = rec.symbol;
      if (!key) return;
      if (!bySymbol.has(key)) bySymbol.set(key, []);
      bySymbol.get(key).push(rec.norm);
    };
    try {
      if (config.sources?.manualLevels !== false) {
        for (const l of manualLevelsStore.getAll({ marketType: config.marketType }) || [])
          push({ symbol: l.symbol, price: Number(l.price), norm: normStored(l, 'manual-levels') });
      }
      if (config.sources?.savedRays !== false) {
        for (const r of savedRaysStore.getAll({ marketType: config.marketType }) || []) {
          const points = Array.isArray(r.points) ? r.points : [];
          const price = Number(points[0]?.value ?? points[0]?.price ?? NaN);
          push({
            symbol: r.symbol,
            price,
            norm: normStored({
              ...r,
              price,
              tf: r.tf || null,
              type: r.kind || 'ray',
              visibleOnTestPage: r.visibleOnAllTimeframes !== false,
            }, 'saved-rays'),
          });
        }
      }
      if (config.sources?.savedRays !== false) {
        for (const l of manualSlopedLevelsStore.getAll({ marketType: config.marketType }) || []) {
          const points = Array.isArray(l.points) ? l.points : [];
          const price = Number(points[0]?.value ?? points[0]?.price ?? NaN);
          push({
            symbol: l.symbol,
            price,
            norm: normStored({
              ...l,
              price,
              visibleOnTestPage: true,
            }, 'saved-rays'),
          });
        }
      }
      if (config.sources?.trackedLevels !== false) {
        for (const l of trackedLevelsStore.getAll({ marketType: config.marketType }) || [])
          push({ symbol: l.symbol, price: Number(l.price), norm: normStored(l, l.source || 'tracked-levels') });
      }
      if (config.sources?.trackedExtremes !== false) {
        for (const l of trackedExtremesStore.getAll({ marketType: config.marketType }) || [])
          push({ symbol: l.symbol, price: Number(l.price), norm: normStored(l, l.source || 'tracked-extremes') });
      }
    } catch (e) {
      console.warn('[formations] storedLevels refresh failed:', e.message);
    }
    storedLevels = { bySymbol, builtAt: now };
  }

  // ── Pattern engine: build extremes grouped by symbol+tf ─────────────────────
  // Returns a Map<symbol, Map<tf, extreme[]>> from trackedExtremesStore.
  // Cached for PATTERN_EXTREMES_TTL ms to avoid re-reading the JSON on every tick.
  function refreshPatternExtremes(now) {
    // Build a full Map regardless — the cache is per-symbol
    const all = trackedExtremesStore.getAll({ marketType: config.marketType }) || [];
    const bySymbol = new Map();
    for (const ext of all) {
      if (!ext.symbol) continue;
      const sym = ext.symbol.toUpperCase();
      if (!bySymbol.has(sym)) bySymbol.set(sym, new Map());
      const tfMap = bySymbol.get(sym);
      const tf = ext.tf || 'unknown';
      if (!tfMap.has(tf)) tfMap.set(tf, []);
      tfMap.get(tf).push(ext);
    }
    return bySymbol;
  }

  // Aggregate cached 1m bars into every configured timeframe.
  function buildTfBars(symbol, bars1m, now) {
    const cached = tfBarsCache.get(symbol);
    if (cached && (now - cached.builtAt) <= config.levelsRefreshMs) return cached.tfBars;
    const tfBars = new Map();
    for (const tf of config.timeframes) {
      tfBars.set(tf, aggregate(bars1m, tf, { maxBars: config.tfLookbackBars }));
    }
    tfBarsCache.set(symbol, { tfBars, builtAt: now });
    return tfBars;
  }

  // Youngest timeframe (smallest cadence) that has enough bars → analysis cadence.
  function cadenceFor(tfBars) {
    for (const tf of config.timeframes) {
      const bars = tfBars.get(tf);
      const minBars = config.tfMinBars?.[tf] ?? config.minBarsRequired;
      if (bars && bars.length >= minBars) return config.tfCadenceMs?.[tf] ?? config.levelsRefreshMs;
    }
    return config.levelsRefreshMs;
  }

  // ── Read all light per-symbol keys + (stale-only) bars ──────────────────────
  async function readSymbolData(symbols, now) {
    const lightPipe = redis.pipeline();
    for (const s of symbols) {
      lightPipe.get(`price:${s}`);
      lightPipe.get(`metrics:${s}`);
      lightPipe.get(`signal:${s}`);
      lightPipe.get(`derivatives:${s}`);
      lightPipe.get(`futures:walls:${s}`);
      lightPipe.get(`levels:${s}`);
    }
    const lightRes = await lightPipe.exec();

    const light = new Map();
    const needBars = [];
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      const base = i * 6;
      light.set(s, {
        price:       parseFloat(lightRes[base][1]),
        metrics:     tryParse(lightRes[base + 1][1]),
        signal:      tryParse(lightRes[base + 2][1]),
        derivatives: tryParse(lightRes[base + 3][1]),
        walls:       parseWalls(lightRes[base + 4][1]),
      });
      const cached = barsCache.get(s);
      if (!cached || (now - cached.builtAt) > config.levelsRefreshMs) needBars.push(s);
    }

    if (needBars.length) {
      const barsPipe = redis.pipeline();
      for (const s of needBars) barsPipe.zrange(`bars:1m:${s}`, -config.barsLookback, -1);
      const barsRes = await barsPipe.exec();
      for (let i = 0; i < needBars.length; i++) {
        const arr = Array.isArray(barsRes[i][1])
          ? barsRes[i][1].map(tryParse).filter(Boolean).sort((a, b) => a.ts - b.ts)
          : [];
        barsCache.set(needBars[i], { bars: arr, builtAt: now });
      }
    }

    // prune cache for delisted symbols
    if (barsCache.size > symbols.length * 1.5) {
      const set = new Set(symbols);
      for (const k of barsCache.keys()) if (!set.has(k)) barsCache.delete(k);
      for (const k of tfBarsCache.keys()) if (!set.has(k)) tfBarsCache.delete(k);
      for (const k of nextAnalyzeAt.keys()) if (!set.has(k)) nextAnalyzeAt.delete(k);
    }

    return light;
  }

  function buildContext(symbol, light, now) {
    if (!light) return { skip: 'missing_candles' };
    const cached = barsCache.get(symbol);
    const bars = cached?.bars || [];
    if (bars.length < config.minBarsRequired) return { skip: 'missing_candles' };

    const lastBar = bars[bars.length - 1];
    const price = light.metrics?.lastPrice ?? light.price ?? lastBar?.close;
    if (!Number.isFinite(price)) return { skip: 'missing_candles' };

    const tfBars = buildTfBars(symbol, bars, now);
    const stored = [
      ...(storedLevels.bySymbol.get(symbol) || []),
    ];

    return {
      ctx: {
        symbol,
        marketType:  config.marketType,
        price,
        bars,
        tfBars,
        storedLevels: stored,
        lastClosedCandle: lastBar,
        metrics:     light.metrics,
        signal:      light.signal,
        derivatives: light.derivatives,
        walls:       light.walls,
      },
      cadence: cadenceFor(tfBars),
    };
  }

  // ── One scan tick ───────────────────────────────────────────────────────────
  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    let created = 0, updated = 0, removed = 0;
    try {
      const symbols = tryParse(await redis.get(config.symbolsKey));
      const list = Array.isArray(symbols) ? symbols : (symbols?.symbols ?? []);
      if (!list.length) { running = false; return; }

      // ── FIRST FILTER: liquidity. Only eligible coins are analysed further. ──
      // futures:tickers:all is read at most once per cacheTtlMs (60 s).
      // Ликвидность влияет ТОЛЬКО на создание новых формаций (createOnly: true).
      // Уже созданные формации удалению по ликвидности НЕ подлежат.
      const liquidity = await readLiquidity();
      const tradable  = [];
      for (const s of list) {
        const liq = liquidity.get(s);
        if (liq && liq.eligible) {
          tradable.push(s);
        } else {
          stats.skippedLowLiquidity++;
        }
      }
      // Per-tick liquidity metrics (for /debug/page).
      stats.symbolsScanned      = list.length;
      stats.eligibleSymbols     = tradable.length;
      stats.lowLiquiditySkipped = list.length - tradable.length;
      // Expose cache stats (with live cacheAgeMs) for getStats().
      if (_liquidityCache) {
        _lastLiquidityStats = { ..._liquidityCache.stats, cacheAgeMs: Date.now() - _liquidityCache.updatedAt };
      }
      if (!tradable.length) { running = false; return; }

      const light = await readSymbolData(tradable, t0);
      refreshStoredLevels(t0);

      // Existing formations (id + fingerprint maps for upsert + lifecycle)
      const active = await store.getActive();
      const activeMap = new Map(active.map(f => [f.id, f]));
      const fpMap = new Map(active.map(f => [f.fingerprint, f]));

      // ── Legacy geometry pass (disabled when legacyEngineEnabled = false) ────
      if (config.legacyEngineEnabled !== false) {
        for (const symbol of tradable) {
          if ((nextAnalyzeAt.get(symbol) || 0) > t0) continue;
          const { ctx, skip, cadence } = buildContext(symbol, light.get(symbol), t0);
          if (skip) { nextAnalyzeAt.set(symbol, t0 + config.levelsRefreshMs); continue; }

          const result = engine.run(ctx);
          nextAnalyzeAt.set(symbol, t0 + (cadence || config.levelsRefreshMs));

          for (const c of result.candidates) {
            const candidate = {
              symbol,
              marketType:  config.marketType,
              version:     'v3',
              strategy:    c.strategy,
              direction:   c.direction,
              type:        c.type,
              status:      c.status,
              price:       ctx.price,
              level:       c.level,
              breakout:    c.breakout,
              distancePct: c.distancePct,
              probability: c.probability,
              score:       c.score,
              signals:     c.signals,
              confluenceStrategies: c.confluenceStrategies,
              confluenceBonus:      c.confluenceBonus,
              zoneBonus:            c.zoneBonus,
              levelStrength:        c.levelStrength,
              confluenceScore:      c.confluenceScore,
              reason:      c.reason,
              lastAnalyzedAt: t0,
              nextAnalyzeAt:  t0 + (cadence || config.levelsRefreshMs),
              fingerprint: store.buildFingerprint({
                symbol, marketType: config.marketType,
                direction: c.direction, levelPrice: c.level.price,
              }),
            };
            const { formation, created: isNew } = await store.upsert(candidate, fpMap);
            activeMap.set(formation.id, formation);
            fpMap.set(formation.fingerprint, formation);
            eventBus.emit('formation:updated', formation);
            if (isNew) created++; else updated++;
          }
        }
      }

      // ── V1 Pattern engine pass ────────────────────────────────────────────
      // Runs every tick (patterns change slowly but lifecycle check is every tick).
      // Uses trackedExtremes grouped by symbol+tf — no bars or price needed for
      // detection; current price is attached for lifecycle checks only.
      if (patternEngine) {
        const patternExtremesAll = refreshPatternExtremes(t0);

        for (const symbol of tradable) {
          const extremesByTf = patternExtremesAll.get(symbol);
          if (!extremesByTf || extremesByTf.size === 0) continue;

          const lightData  = light.get(symbol);
          const cached     = barsCache.get(symbol);
          const lastBar    = cached?.bars?.[cached.bars.length - 1];
          const baseTfBarsMap = tfBarsCache.get(symbol)?.tfBars || buildTfBars(symbol, cached?.bars || [], t0);
          const { tfBarsMap } = await ensureTfBarsDepth(symbol, baseTfBarsMap, t0);
          const currentPrice = lightData?.metrics?.lastPrice ?? lightData?.price ?? lastBar?.close ?? null;

          const result = patternEngine.run({
            symbol,
            marketType: config.marketType,
            extremesByTf,
            currentPrice,
            tfBars: tfBarsMap,
            storedLevels: storedLevels.bySymbol.get(symbol) || [],
            marketMetrics: lightData?.metrics || {},
          });

          stats.patternCandidatesFound = (stats.patternCandidatesFound || 0) + result.candidates.length;

          // ── Priority conflict resolution ────────────────────────────────
          // If a SUPPORT_BREAKDOWN exists → evict DOUBLE_BOTTOM for same symbol.
          // If a RESISTANCE_BREAKOUT exists → evict DOUBLE_TOP for same symbol.
          const hasBreakdown = result.candidates.some(c => c.patternType === 'SUPPORT_BREAKDOWN');
          const hasBreakout  = result.candidates.some(c => c.patternType === 'RESISTANCE_BREAKOUT');
          if (hasBreakdown || hasBreakout) {
            for (const [fid, f] of activeMap) {
              if (f.symbol !== symbol) continue;
              if (hasBreakdown && f.patternType === 'DOUBLE_BOTTOM') {
                await store.remove(f);
                activeMap.delete(fid);
                fpMap.delete(f.fingerprint);
                eventBus.emit('formation:updated', { ...f, status: 'COMPLETED', updatedAt: Date.now() });
                removed++;
              } else if (hasBreakout && f.patternType === 'DOUBLE_TOP') {
                await store.remove(f);
                activeMap.delete(fid);
                fpMap.delete(f.fingerprint);
                eventBus.emit('formation:updated', { ...f, status: 'COMPLETED', updatedAt: Date.now() });
                removed++;
              }
            }
          }

          // ── Global dedup: enforce max 1 DT + 1 DB per symbol+tf ──────────
          // The strategy already returns best-per-type per tf. Here we also
          // enforce that only one formation slot exists per symbol+tf+patternType
          // in Redis. When the incoming candidate has a *higher* score than the
          // stored formation for that slot, the stored one is evicted first.
          for (const c of result.candidates) {
            // Priority filter: breakdown blocks double-bottom, breakout blocks double-top
            if (hasBreakdown && c.patternType === 'DOUBLE_BOTTOM') continue;
            if (hasBreakout  && c.patternType === 'DOUBLE_TOP')    continue;

            const candidate = {
              ...c,
              currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
            };

            // Find any stored formation for the same slot (diff fingerprint)
            const existingForSlot = [...activeMap.values()].find(f =>
              f.patternType === c.patternType &&
              f.symbol      === c.symbol &&
              f.tf          === c.tf &&
              f.fingerprint !== c.fingerprint,
            );

            if (existingForSlot) {
              const existingScore = existingForSlot.score ?? 0;
              const newScore      = c.score ?? 0;
              if (newScore <= existingScore) {
                // Existing is better or equal → skip new candidate
                stats.patternDuplicatesRemoved = (stats.patternDuplicatesRemoved || 0) + 1;
                continue;
              }
              // New is better → evict the inferior stored formation
              await store.remove(existingForSlot);
              activeMap.delete(existingForSlot.id);
              fpMap.delete(existingForSlot.fingerprint);
              eventBus.emit('formation:updated', {
                ...existingForSlot,
                status: 'COMPLETED',
                updatedAt: Date.now(),
              });
              removed++;
              stats.patternDuplicatesRemoved = (stats.patternDuplicatesRemoved || 0) + 1;
            }

            const { formation, created: isNew } = await store.upsert(candidate, fpMap);
            activeMap.set(formation.id, formation);
            fpMap.set(formation.fingerprint, formation);
            eventBus.emit('formation:updated', formation);
            if (isNew) {
              created++;
              stats.patternFormationsStored = (stats.patternFormationsStored || 0) + 1;
            } else {
              updated++;
            }
          }
        }
      }

      // ── Extreme formations pass (Stage 1: extremes only) ────────────────────
      // Reads tracked-extremes per symbol+tf, evaluates proximity to current price,
      // and creates SUPPORT_BOUNCE / SUPPORT_BREAKDOWN_SETUP / RESISTANCE_REJECTION /
      // RESISTANCE_BREAKOUT_SETUP cards when price is within setupDistancePct %.
      // Does NOT fetch from Binance REST — only reads trackedExtremesStore.
      if (config.extremeFormationsEnabled !== false) {
        const efCfg       = config.extremeFormations || {};
        const maxSymbols  = Number(efCfg.maxSymbols)  || 100;
        const maxFormations = Number(efCfg.maxFormations) || 200;
        const maxJobs     = Number(efCfg.maxJobsPerTick) || 5;
        const concurrency = Number(efCfg.maxConcurrentJobs) || 3;

        // Count only extreme-based formations toward the cap
        const efFormationCount = [...activeMap.values()].filter(f => f.strategy === 'extremeBased').length;

        // Refresh extremes snapshot once per pass (synchronous file read, no Redis)
        const extremeExtremesAll = refreshPatternExtremes(t0);

        // Cap the symbol list for this pass
        const efSymbols = tradable.slice(0, maxSymbols);
        let efJobsThisTick = 0;

        // Per-tick diagnostic stats — saved to _lastTickExtremeStats after the pass.
        const tickEfStats = {
          trackedExtremes: 0, candidatesCreated: 0, accepted: 0, rejected: 0,
          rejectReasons: {}, byTf: {}, sources: {},
          acceptedByTf: {}, acceptedBySource: {},
          priceTooFarBuckets: { d0_1: 0, d1_2: 0, d2_3: 0, d3_5: 0, d5_10: 0, d10plus: 0 },
          ts: t0,
        };

        // Process in bounded parallel batches to limit Redis load
        for (let i = 0; i < efSymbols.length; i += concurrency) {
          if (efFormationCount + efJobsThisTick >= maxFormations) break;
          const batch = efSymbols.slice(i, i + concurrency);
          await Promise.allSettled(batch.map(async (symbol) => {
            if (efFormationCount + efJobsThisTick >= maxFormations) return;

            const extremesByTf = extremeExtremesAll.get(symbol);
            if (!extremesByTf || extremesByTf.size === 0) return;

            const lightData    = light.get(symbol);
            const cached       = barsCache.get(symbol);
            const lastBar      = cached?.bars?.[cached.bars.length - 1];
            const currentPrice = lightData?.metrics?.lastPrice ?? lightData?.price ?? lastBar?.close ?? null;
            if (!Number.isFinite(currentPrice)) return;

            // Flatten all extremes across all TFs into one list with symbol injected
            const allExtremes = [];
            for (const [, exts] of extremesByTf) {
              for (const ext of exts) allExtremes.push({ ...ext, symbol });
            }

            const { candidates: _rawCandidates, rejected } = runExtremeFormations(allExtremes, currentPrice, efCfg);

            // ── Bar validation: reject if extremeTime has no matching bar ──────
            // Uses the in-memory tfBarsCache so no extra Redis calls are needed.
            // EXTREME_BAR_NOT_FOUND   → ts is within range but no exact bar match.
            // EXTREME_OUTSIDE_VISIBLE_RANGE → ts predates stored bars (older
            //   extremes on 1h/4h TFs are expected; skip but record extremeBarIndex=null).
            const tfBarsForSymbol = buildTfBars(symbol, barsCache.get(symbol)?.bars || [], t0);
            const candidates = [];
            for (const c of _rawCandidates) {
              const extremeTime = c.extremeTime;
              if (!extremeTime) {
                // No time info available — allow through without validation
                candidates.push(c);
                continue;
              }
              const ctf  = c.extremeTf || c.tf;
              // For 1m: use the full barsCache (1600 bars ~26h) — tfBarsForSymbol
              // is limited to tfLookbackBars (200) which may not cover older extremes.
              // For higher TFs: use aggregated bars from tfBarsForSymbol.
              const bars = ctf === '1m'
                ? (barsCache.get(symbol)?.bars || [])
                : (tfBarsForSymbol.get(ctf) || []);
              if (bars.length === 0) {
                // No bar data for this TF — skip bar validation
                candidates.push(c);
                continue;
              }
              const minTs = bars[0].ts;
              const maxTs = bars[bars.length - 1].ts;
              if (extremeTime < minTs || extremeTime > maxTs) {
                // Extreme predates (or postdates) stored bar window.
                // This is expected for multi-day extremes on higher TFs.
                // Record as diagnostic but do NOT reject — allow the formation.
                rejected.push({ extremeId: c.extremeId, reason: 'EXTREME_OUTSIDE_VISIBLE_RANGE',
                  tf: ctf, extremeTime, minTs, maxTs, _diagnostic: true });
                candidates.push(c); // pass through without extremeBarIndex
                continue;
              }
              const barIdx = bars.findIndex(b => b.ts === extremeTime);
              if (barIdx === -1) {
                // Timestamp is within bar range but no exact bar match.
                // Per Stage 1 spec: visual warning only — do NOT hard-reject.
                // Formation passes through; extremeBarIndex stays null.
                rejected.push({ extremeId: c.extremeId, reason: 'EXTREME_BAR_NOT_FOUND',
                  tf: ctf, extremeTime, _diagnostic: true });
                candidates.push(c); // pass through without extremeBarIndex
                continue;
              }
              candidates.push({ ...c, extremeBarIndex: barIdx });
            }

            // ── Accumulate per-tick diagnostic stats ──────────────────────────
            for (const e of allExtremes) {
              tickEfStats.trackedExtremes++;
              const etf = e.tf || 'unknown';
              if (!tickEfStats.byTf[etf]) tickEfStats.byTf[etf] = { extremes: 0, candidates: 0, rejected: 0, accepted: 0 };
              tickEfStats.byTf[etf].extremes++;
              const src = String(e.source || e.extremeSource || 'unknown').toLowerCase();
              tickEfStats.sources[src] = (tickEfStats.sources[src] || 0) + 1;
            }
            for (const c of candidates) {
              tickEfStats.candidatesCreated++;
              const ctf = c.tf || 'unknown';
              if (!tickEfStats.byTf[ctf]) tickEfStats.byTf[ctf] = { extremes: 0, candidates: 0, rejected: 0, accepted: 0 };
              tickEfStats.byTf[ctf].candidates++;
            }
            for (const r of rejected) {
              tickEfStats.rejected++;
              tickEfStats.rejectReasons[r.reason] = (tickEfStats.rejectReasons[r.reason] || 0) + 1;
              const matchExt = r.extremeId != null
                ? allExtremes.find(e => String(e.id) === String(r.extremeId))
                : null;
              const rtf = matchExt?.tf || r.tf || 'unknown';
              if (!tickEfStats.byTf[rtf]) tickEfStats.byTf[rtf] = { extremes: 0, candidates: 0, rejected: 0, accepted: 0 };
              tickEfStats.byTf[rtf].rejected++;
              // Bucket PRICE_TOO_FAR by distance
              if (r.reason === 'PRICE_TOO_FAR' && typeof r.distancePct === 'number') {
                const d = r.distancePct;
                const b = tickEfStats.priceTooFarBuckets;
                if      (d < 1)  b.d0_1++;
                else if (d < 2)  b.d1_2++;
                else if (d < 3)  b.d2_3++;
                else if (d < 5)  b.d3_5++;
                else if (d < 10) b.d5_10++;
                else             b.d10plus++;
              }
              // Rolling reject log (newest last, bounded)
              if (rejectLog.length >= MAX_REJECT_LOG) rejectLog.shift();
              rejectLog.push({
                ts:          t0,
                symbol,
                tf:          rtf !== 'unknown' ? rtf : null,
                extremeId:   r.extremeId ?? null,
                price:       Number.isFinite(currentPrice) ? +currentPrice.toFixed(8) : null,
                extremePrice: r.rawExtreme?.price ?? matchExt?.price ?? null,
                distancePct: typeof r.distancePct === 'number' ? r.distancePct : null,
                rejectReason: r.reason,
              });
            }

            for (const c of candidates) {
              if (efFormationCount + efJobsThisTick >= maxFormations) break;
              // Attach TTL via patternTtlSec hint so store uses the right expiry
              const ttlHours = Number(efCfg.maxPatternAgeHours) || 24;
              const withTtl  = { ...c, ttlSec: ttlHours * 3600 };
              const { formation, created: isNew } = await store.upsert(withTtl, fpMap);
              activeMap.set(formation.id, formation);
              fpMap.set(formation.fingerprint, formation);
              eventBus.emit('formation:updated', formation);
              efJobsThisTick++;
              tickEfStats.accepted++;
              const ctf = c.tf || 'unknown';
              if (tickEfStats.byTf[ctf]) tickEfStats.byTf[ctf].accepted++;
              // Track accepted by TF and by source
              tickEfStats.acceptedByTf[ctf] = (tickEfStats.acceptedByTf[ctf] || 0) + 1;
              const csrc = String(c.extremeSource || 'unknown').toLowerCase();
              tickEfStats.acceptedBySource[csrc] = (tickEfStats.acceptedBySource[csrc] || 0) + 1;
              stats.efFormationsUpserted = (stats.efFormationsUpserted || 0) + 1;
              if (isNew) created++; else updated++;
            }
          }));
        }
        _lastTickExtremeStats = tickEfStats;
      }

      // ── Reset per-tick lifecycle counters ──────────────────────────────────
      // These are stored directly on _lastTickExtremeStats so the debug endpoint
      // can read them alongside the detection counters.
      if (_lastTickExtremeStats) {
        _lastTickExtremeStats.brokenLastTick         = 0;
        _lastTickExtremeStats.orphanedLastTick        = 0;
        _lastTickExtremeStats.liquidityFilterFailed   = list.length - tradable.length;
      }

      // ── Lifecycle pass: terminal transitions (runs every tick) ──────────────
      // Extreme-based formations use a dedicated lifecycle evaluator; all others
      // go through the existing formationLifecycle.evaluate() path.
      const _extremeExtremesForLifecycle = config.extremeFormationsEnabled !== false
        ? refreshPatternExtremes(t0)
        : null;

      for (const formation of activeMap.values()) {
        const lightData = light.get(formation.symbol);
        const cached    = barsCache.get(formation.symbol);

        // For pattern formations, bars are not required — use live price only
        const lastBar = cached?.bars?.[cached.bars.length - 1];
        const price = lightData?.metrics?.lastPrice ?? lightData?.price ?? lastBar?.close ?? formation.currentPrice;
        if (!Number.isFinite(price)) continue;

        // ── Extreme-based formation lifecycle (Stage 1) ─────────────────────
        // Evaluated before generic lifecycle — entirely different rules.
        if (formation.strategy === 'extremeBased') {
          const efCfg        = config.extremeFormations || {};
          const extremesByTf = _extremeExtremesForLifecycle
            ? (_extremeExtremesForLifecycle.get(formation.symbol) || null)
            : null;

          const efDecision = evaluateExtremeLifecycle(formation, price, extremesByTf, efCfg);

          if (efDecision.action === 'remove') {
            await store.remove(formation);
            activeMap.delete(formation.id);
            fpMap.delete(formation.fingerprint);
            const removedPayload = {
              ...formation,
              status: 'INVALIDATED',
              lifecycleStatus: efDecision.lifecycleStatus || 'REMOVED',
              lifecycleReason: efDecision.lifecycleReason || 'REMOVED_EXTREME_LIFECYCLE',
              updatedAt: t0,
            };
            eventBus.emit('formation:updated', removedPayload);
            recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'remove', reason: removedPayload.lifecycleReason, formation: removedPayload });
            // Track broken / orphaned counts in per-tick stats
            if (_lastTickExtremeStats) {
              const lr = removedPayload.lifecycleReason || '';
              if (lr === 'SUPPORT_EXTREME_BROKEN' || lr === 'RESISTANCE_EXTREME_BROKEN') {
                _lastTickExtremeStats.brokenLastTick = (_lastTickExtremeStats.brokenLastTick || 0) + 1;
              } else if (lr === 'EXTREME_DELETED_FROM_TESTPAGE' || lr === 'EXTREME_NOT_VISIBLE_ON_TESTPAGE') {
                _lastTickExtremeStats.orphanedLastTick = (_lastTickExtremeStats.orphanedLastTick || 0) + 1;
              }
            }
            removed++;
          } else {
            // Update currentPrice + distancePct if changed
            const newDistancePct = efDecision.distancePct ?? formation.distancePct;
            if (formation.currentPrice !== price || formation.distancePct !== newDistancePct) {
              const patch = {
                ...formation,
                currentPrice: price,
                distancePct:  newDistancePct,
                updatedAt:    t0,
              };
              const ttlSec = Math.max(1, Math.ceil(((patch.expiresAt || (t0 + 86400_000)) - t0) / 1000));
              await store.save(patch, ttlSec);
              activeMap.set(patch.id, patch);
              fpMap.set(patch.fingerprint, patch);
              eventBus.emit('formation:updated', patch);
              updated++;
            }
          }
          continue; // skip generic lifecycle for extreme-based formations
        }

        const sourceNorm = normalizeLevelSource(formation.levelSource);
        if (formation.levelSource && !VALID_LEVEL_SOURCES.has(sourceNorm)) {
          await store.remove(formation);
          activeMap.delete(formation.id);
          fpMap.delete(formation.fingerprint);
          const removedPayload = {
            ...formation,
            status: 'INVALIDATED',
            lifecycleStatus: 'REMOVED',
            lifecycleReason: 'REMOVED_LEVEL_INVALID_SOURCE',
            updatedAt: Date.now(),
          };
          eventBus.emit('formation:updated', removedPayload);
          recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'remove', reason: 'REMOVED_LEVEL_INVALID_SOURCE', formation: removedPayload });
          removed++;
          continue;
        }

        if (formation.isVisibleOnTestPage === false || formation.visibleOnTestPage === false) {
          await store.remove(formation);
          activeMap.delete(formation.id);
          fpMap.delete(formation.fingerprint);
          const removedPayload = {
            ...formation,
            status: 'INVALIDATED',
            lifecycleStatus: 'REMOVED',
            lifecycleReason: 'REMOVED_LEVEL_NOT_VISIBLE',
            updatedAt: Date.now(),
          };
          eventBus.emit('formation:updated', removedPayload);
          recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'remove', reason: 'REMOVED_LEVEL_NOT_VISIBLE', formation: removedPayload });
          removed++;
          continue;
        }

        const symbolStoredLevels = storedLevels.bySymbol.get(formation.symbol) || [];
        const selectedId = formation.selectedLevel?.id ?? null;
        if (selectedId != null) {
          const stillExists = symbolStoredLevels.some((x) => x.id === selectedId);
          if (!stillExists) {
            await store.remove(formation);
            activeMap.delete(formation.id);
            fpMap.delete(formation.fingerprint);
            const removedPayload = {
              ...formation,
              status: 'INVALIDATED',
              lifecycleStatus: 'REMOVED',
              lifecycleReason: 'REMOVED_LEVEL_DELETED',
              updatedAt: Date.now(),
            };
            eventBus.emit('formation:updated', removedPayload);
            recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'remove', reason: 'REMOVED_LEVEL_DELETED', formation: removedPayload });
            removed++;
            continue;
          }
        }

        const decision = lifecycle.evaluate(formation, {
          price,
          lastClosedCandle: lastBar ?? null,
          cfg: config,
        });

        if (decision.action === 'none') {
          if (decision.lifecycleStatus || decision.lifecycleReason) {
            const nextLifecycleStatus = decision.lifecycleStatus || formation.lifecycleStatus || 'ACTIVE_NEAR_LEVEL';
            const nextLifecycleReason = decision.lifecycleReason || formation.lifecycleReason || 'SETUP_WAITING_BREAK';
            if (formation.lifecycleStatus !== nextLifecycleStatus || formation.lifecycleReason !== nextLifecycleReason) {
              const patch = {
                ...formation,
                lifecycleStatus: nextLifecycleStatus,
                lifecycleReason: nextLifecycleReason,
                updatedAt: Date.now(),
              };
              await store.save(patch, Math.max(1, Math.ceil((patch.expiresAt - Date.now()) / 1000)));
              activeMap.set(patch.id, patch);
              fpMap.set(patch.fingerprint, patch);
              eventBus.emit('formation:updated', patch);
              updated++;
            }
          }
          continue;
        }

        if (decision.action === 'promote_breakdown' || decision.action === 'promote_breakout') {
          await store.remove(formation);
          activeMap.delete(formation.id);
          fpMap.delete(formation.fingerprint);
          const oldPayload = {
            ...formation,
            status: 'COMPLETED',
            lifecycleStatus: 'REMOVED',
            lifecycleReason: decision.lifecycleReason || 'PROMOTED',
            updatedAt: Date.now(),
          };
          eventBus.emit('formation:updated', oldPayload);

          const nextPatternType = decision.action === 'promote_breakdown' ? 'SUPPORT_BREAKDOWN' : 'RESISTANCE_BREAKOUT';
          const nextStatus = decision.action === 'promote_breakdown' ? 'BREAKDOWN' : 'BREAKOUT';
          const promotedCandidate = buildPromotedLevelBasedCandidate(
            formation,
            nextPatternType,
            nextStatus,
            decision.lifecycleReason || (decision.action === 'promote_breakdown' ? 'PROMOTED_TO_BREAKDOWN' : 'PROMOTED_TO_BREAKOUT'),
          );
          const { formation: promoted, created: isNew } = await store.upsert(promotedCandidate, fpMap);
          activeMap.set(promoted.id, promoted);
          fpMap.set(promoted.fingerprint, promoted);
          eventBus.emit('formation:updated', promoted);
          recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'promote', reason: promoted.lifecycleReason, fromPatternType: formation.patternType, toPatternType: nextPatternType, formation: promoted });
          removed++;
          if (isNew) created++; else updated++;
          continue;
        }

        if (decision.action === 'remove') {
          await store.remove(formation);
          activeMap.delete(formation.id);
          fpMap.delete(formation.fingerprint);
          const removedPayload = {
            ...formation,
            status: 'INVALIDATED',
            lifecycleStatus: decision.lifecycleStatus || 'REMOVED',
            lifecycleReason: decision.lifecycleReason || 'REMOVED_PRICE_TOO_FAR',
            updatedAt: Date.now(),
          };
          eventBus.emit('formation:updated', removedPayload);
          recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: 'remove', reason: removedPayload.lifecycleReason, formation: removedPayload });
          removed++;
          continue;
        }
        // complete / invalidate / expire → hide (remove from store immediately)
        await store.remove(formation);
        activeMap.delete(formation.id);
        fpMap.delete(formation.fingerprint);
        const statusMap = {
          complete: 'COMPLETED',
          invalidate: 'INVALIDATED',
          expire: 'EXPIRED',
        };
        const terminalPayload = {
          ...formation,
          status: statusMap[decision.action] || formation.status,
          lifecycleStatus: decision.lifecycleStatus || 'REMOVED',
          lifecycleReason: decision.lifecycleReason || `REMOVED_${String(decision.action || 'UNKNOWN').toUpperCase()}`,
          updatedAt: Date.now(),
        };
        eventBus.emit('formation:updated', terminalPayload);
        recordLifecycleEvent({ symbol: formation.symbol, tf: formation.tf, id: formation.id, action: decision.action, reason: terminalPayload.lifecycleReason, formation: terminalPayload });
        removed++;
      }

      stats.created += created;
      stats.updated += updated;
      stats.removed += removed;
    } catch (err) {
      stats.errors++;
      stats.lastError = err.message;
      console.error('[formations] tick error:', err.message);
    } finally {
      stats.runs++;
      stats.lastRunMs = Date.now() - t0;
      stats.lastTickAt = new Date().toISOString();
      running = false;
    }
  }

  // ── Debug: diagnose specific symbols without persisting ─────────────────────
  async function diagnose(symbols) {
    const now = Date.now();
    // Use the same cache that tick() uses — avoids a redundant Redis read.
    const liquidity = await readLiquidity();
    const light = await readSymbolData(symbols, now);
    refreshStoredLevels(now);
    const out = [];
    for (const symbol of symbols) {
      const liq = liquidity.get(symbol) || { trades24h: 0, tradesSource: null, volume24hUsd: 0, volumeSource: null, volumeOk: false, tradesOk: false, eligible: false, reason: 'NO_TICKER_DATA' };
      const liquidityDetail = {
        symbol,
        volume24hUsd:  liq.volume24hUsd,
        volumeSource:  liq.volumeSource,
        trades24h:     liq.trades24h,
        tradesSource:  liq.tradesSource,
        volumeOk:      liq.volumeOk   ?? false,
        tradesOk:      liq.tradesOk   ?? false,
        passed:        liq.eligible,
        reason:        liq.reason,
      };
      // FIRST FILTER: liquidity. Fail → not analysed at all.
      if (!liq.eligible) {
        out.push({
          symbol,
          trades24h:  liq.trades24h,
          volume24hUsd: liq.volume24hUsd,
          liquidity:  liquidityDetail,
          skipped:    'low_liquidity',
          skippedReason: liq.reason,
        });
        continue;
      }
      const { ctx, skip } = buildContext(symbol, light.get(symbol), now);
      if (skip) {
        out.push({ symbol, trades24h: liq.trades24h, volume24hUsd: liq.volume24hUsd, liquidity: liquidityDetail, skipped: skip });
        continue;
      }
      const result = engine.run(ctx);
      const levelDiag = [];
      for (const c of result.candidates) {
        levelDiag.push({
          levelPrice: c.level.price, side: c.level.side, touches: c.level.touches,
          distancePct: c.distancePct, isBroken: false, strategy: c.strategy,
          direction: c.direction, signalsDetected: c.signals, probability: c.probability,
          confluenceStrategies: c.confluenceStrategies, levelStrength: c.levelStrength,
          confluenceScore: c.confluenceScore, zoneBonus: c.zoneBonus,
          // geometry breakdown (mirrors skip entries for a uniform shape)
          confluence: c.signals?.approachCount != null ? c.confluenceScore / 20 : undefined,
          hasZone: c.level.zone,
          approachCount: c.signals?.approachCount,
          tightening: c.signals?.tightening,
          compression: c.signals?.compression,
          higherLows: c.signals?.higherLows,
          lowerHighs: c.signals?.lowerHighs,
          reactionWeakening: c.signals?.reactionsWeakening,
          created: true,
        });
      }
      for (const s of result.skips) {
        const g = s.geometry || {};
        levelDiag.push({
          levelPrice: s.levelPrice, side: s.side, direction: s.direction,
          distancePct: s.distancePct,
          isBroken: s.reason === 'level_broken',
          strategy: s.strategy,
          created: false, skipReason: s.reason, nearMiss: !!s.nearMiss,
          confluence: g.confluence, hasZone: g.hasZone,
          approachCount: g.approachCount, tightening: g.tightening,
          compression: g.compression, higherLows: g.higherLows,
          lowerHighs: g.lowerHighs, reactionWeakening: g.reactionWeakening,
        });
      }
      // near-miss = passed distance gate but geometry/probability not yet ready.
      const nearMissCandidates = result.skips
        .filter(s => s.nearMiss)
        .sort((a, b) => a.distancePct - b.distancePct)
        .slice(0, 5)
        .map(s => ({
          levelPrice: s.levelPrice, side: s.side, direction: s.direction,
          distancePct: s.distancePct, skipReason: s.reason,
          approachCount: s.geometry?.approachCount, tightening: s.geometry?.tightening,
          compression: s.geometry?.compression, hasZone: s.geometry?.hasZone,
        }));
      out.push({
        symbol,
        price: ctx.price,
        trades24h:    liq.trades24h,
        tradesSource: liq.tradesSource,
        volume24hUsd: liq.volume24hUsd,
        volumeSource: liq.volumeSource,
        liquidity: liquidityDetail,
        strategiesChecked: ['geometryV3'],
        tfBars: Object.fromEntries([...ctx.tfBars].map(([tf, b]) => [tf, b.length])),
        timeframes: Object.fromEntries([...ctx.tfBars].map(([tf, b]) => [tf, b.length])),
        storedLevels: ctx.storedLevels.length,
        levelsFound: result.levels.resistancesAbove.length + result.levels.supportsBelow.length,
        resistancesAbove: result.levels.resistancesAbove,
        supportsBelow: result.levels.supportsBelow,
        nearestBreakoutLevels: result.candidates
          .slice().sort((a, b) => a.distancePct - b.distancePct).slice(0, 5)
          .map(c => ({ levelPrice: c.level.price, direction: c.direction, distancePct: c.distancePct, probability: c.probability })),
        nearMissCandidates,
        createdFormations: result.candidates.length,
        skippedReasons: result.skips.map(s => s.reason),
        levels: levelDiag,
      });
    }
    return out;
  }

  // ── Debug: diagnose pattern engine for specific symbols ─────────────────────
  async function diagnosePatterns(symbols, { marketType, tf } = {}) {
    const now = Date.now();
    const light = await readSymbolData(symbols, now);
    const patternExtremesAll = refreshPatternExtremes(now);
    const out = [];
    for (const sym of symbols) {
      const symbol = sym.toUpperCase();
      const extremesByTf = patternExtremesAll.get(symbol);
      const lightData  = light.get(symbol);
      const cached     = barsCache.get(symbol);
      const lastBar    = cached?.bars?.[cached.bars.length - 1];
      const baseTfBarsMap = tfBarsCache.get(symbol)?.tfBars || buildTfBars(symbol, cached?.bars || [], now);
      const { tfBarsMap, candlesByTf, candlesReadinessByTf } = await ensureTfBarsDepth(symbol, baseTfBarsMap, now);
      const currentPrice = lightData?.metrics?.lastPrice ?? lightData?.price ?? lastBar?.close ?? null;

      if (!extremesByTf || extremesByTf.size === 0) {
        out.push({ symbol, extremesLoaded: 0, message: 'No tracked extremes found for this symbol.' });
        continue;
      }

      // Optionally filter to one tf
      let filteredMap = extremesByTf;
      if (tf) {
        const single = extremesByTf.get(tf);
        filteredMap = new Map(single ? [[tf, single]] : []);
      }

      const diagResult = patternEngine
        ? patternEngine.diagnose({ symbol, marketType: marketType || config.marketType, extremesByTf: filteredMap, currentPrice, tfBars: tfBarsMap, storedLevels: storedLevels.bySymbol.get(symbol) || [], marketMetrics: lightData?.metrics || {} })
        : { candidates: [], debugByTf: {}, totalExtremes: 0, tfSummary: {} };

      out.push({
        symbol,
        currentPrice,
        totalExtremes:    diagResult.totalExtremes,
        tfSummary:        diagResult.tfSummary,
        statsByTf:        diagResult.statsByTf,
        candlesByTf,
        candlesReadinessByTf,
        candidatesFound:  diagResult.candidates.length,
        candidates:       diagResult.candidates,
        debugByTf:        diagResult.debugByTf,
      });
    }
    return out;
  }

  // ── Debug: diagnose extreme-based formations for specific symbols ───────────
  // Returns per-symbol/per-tf detail matching TZ §16 debug format.
  async function diagnoseExtremes(symbols, { tf: filterTf, marketType: filterMarket } = {}) {
    const now = Date.now();
    const efCfg = config.extremeFormations || {};
    const light = await readSymbolData(symbols, now);
    const extremeExtremesAll = refreshPatternExtremes(now);
    const liquidity = await readLiquidity();
    const out = [];

    for (const sym of symbols) {
      const symbol = sym.toUpperCase();
      const liq = liquidity.get(symbol) || { eligible: false, reason: 'NO_TICKER_DATA', volume24hUsd: 0, trades24h: 0 };
      const lightData    = light.get(symbol);
      const cached       = barsCache.get(symbol);
      const lastBar      = cached?.bars?.[cached.bars.length - 1];
      const currentPrice = lightData?.metrics?.lastPrice ?? lightData?.price ?? lastBar?.close ?? null;

      const extremesByTf = extremeExtremesAll.get(symbol) || new Map();

      // Flatten all extremes with optional tf filter
      const allExtremes = [];
      for (const [etf, exts] of extremesByTf) {
        if (filterTf && etf !== filterTf) continue;
        for (const ext of exts) allExtremes.push({ ...ext, symbol });
      }

      const extremeTfCounts = {};
      for (const [etf, exts] of extremesByTf) extremeTfCounts[etf] = exts.length;

      const { candidates, rejected } = Number.isFinite(currentPrice)
        ? runExtremeFormations(allExtremes, currentPrice, efCfg)
        : { candidates: [], rejected: allExtremes.map(e => ({ extremeId: e.id, reason: 'PRICE_UNAVAILABLE' })) };

      // Rejection breakdown
      const rejectByReason = {};
      for (const r of rejected) {
        rejectByReason[r.reason] = (rejectByReason[r.reason] || 0) + 1;
      }

      out.push({
        symbol,
        tf: filterTf || 'ALL',
        marketType: filterMarket || config.marketType,
        currentPrice: currentPrice ?? null,
        liquidity: {
          volume24hUsd: liq.volume24hUsd,
          trades24h: liq.trades24h,
          passed: liq.eligible,
          reason: liq.reason,
        },
        extremes: {
          loaded: allExtremes.length,
          valid: candidates.length / 2,   // 2 candidates per extreme (both directions)
          rejected: rejected.length,
          byTf: extremeTfCounts,
        },
        candidates: candidates.map(c => ({
          patternType:  c.patternType,
          direction:    c.direction,
          extremeId:    c.extremeId,
          extremeType:  c.extremeType,
          extremeSource: c.extremeSource,
          extremeTf:    c.extremeTf,
          extremePrice: c.extremePrice,
          distancePct:  c.distancePct,
          score:        c.score,
        })),
        rejected: rejected.map(r => ({ extremeId: r.extremeId, reason: r.reason })),
        rejectBreakdown: rejectByReason,
      });
    }
    return out;
  }

  function start() {
    if (timer) return;
    started = true;
    console.log('[formations] service started');
    console.log('[formations] tick loop enabled');
    console.log(`[formations] mode=${config.style}`);
    if (config.legacyEngineEnabled !== false) {
      console.log(`[formations] legacyEngine=ON strategies=${engine.activeStrategies.join(',')}`);
    } else {
      console.log('[formations] legacyEngine=OFF (disabled by config)');
    }
    if (patternEngine) {
      const lbEnabled = config.patternEngine?.levelBased?.enabled !== false;
      console.log(`[formations] patternEngine=ON (doubleExtreme${lbEnabled ? '+levelBased' : ''})`);
    } else {
      console.log('[formations] patternEngine=OFF (disabled by config)');
    }
    if (config.extremeFormationsEnabled !== false) {
      const efCfg = config.extremeFormations || {};
      console.log(`[formations] extremeFormations=ON maxSymbols=${efCfg.maxSymbols || 100} maxFormations=${efCfg.maxFormations || 200}`);
    }
    timer = setInterval(() => { tick().catch(() => {}); }, config.intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    started = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function getStats() {
    const liq = _lastLiquidityStats || {};
    return {
      ...stats,
      started,
      activeStrategies: engine.activeStrategies,
      cachedSymbols: barsCache.size,
      // V1 pattern engine counters
      patternCandidatesFound:  stats.patternCandidatesFound  ?? 0,
      patternDuplicatesRemoved: stats.patternDuplicatesRemoved ?? 0,
      patternFormationsStored: stats.patternFormationsStored ?? 0,
      // Extreme formations counters
      efFormationsUpserted: stats.efFormationsUpserted ?? 0,
      // Liquidity filter breakdown (last tick)
      liquidityFilter: liq,
      passedSymbols:   liq.passedSymbols   ?? null,
      rejectedSymbols: liq.rejectedSymbols ?? null,
      passedByVolume:  liq.passedByVolume  ?? null,
      passedByTrades:  liq.passedByTrades  ?? null,
      passedByBoth:    liq.passedByBoth    ?? null,
      rejectedByBoth:  liq.rejectedByBoth  ?? null,
    };
  }

  function getConfig() { return config; }

  async function getLifecycleDebug(symbol, tf) {
    const sym = symbol ? String(symbol).toUpperCase().trim() : null;
    const tfNorm = tf ? String(tf).trim() : null;
    const active = await store.getActive();
    const activeFormations = active
      .filter((x) => (!sym || String(x.symbol || '').toUpperCase() === sym) && (!tfNorm || String(x.tf || '') === tfNorm))
      .map((x) => ({
        id: x.id,
        symbol: x.symbol,
        tf: x.tf,
        patternType: x.patternType || null,
        status: x.status,
        lifecycleStatus: x.lifecycleStatus || null,
        lifecycleReason: x.lifecycleReason || null,
        levelId: x.levelId || null,
        levelSource: x.levelSource || null,
        levelTf: x.levelTf || null,
        levelPrice: x.levelPrice ?? x.breakLevel ?? null,
        updatedAt: x.updatedAt || null,
      }));

    const removedFormations = lifecycleEvents
      .filter((x) => (!sym || String(x.symbol || '').toUpperCase() === sym) && (!tfNorm || String(x.tf || '') === tfNorm))
      .slice(-300)
      .map((x) => ({
        ts: x.ts,
        id: x.id,
        action: x.action,
        reason: x.reason,
        fromPatternType: x.fromPatternType || null,
        toPatternType: x.toPatternType || null,
      }));

    const reasons = {};
    for (const item of removedFormations) {
      reasons[item.reason || 'UNKNOWN'] = (reasons[item.reason || 'UNKNOWN'] || 0) + 1;
    }

    return {
      activeFormations,
      removedFormations,
      reasons,
      generatedAt: Date.now(),
    };
  }

  function getRejectLog() {
    // Return newest first (most recent rejects at top)
    return rejectLog.slice().reverse();
  }

  function getExtremeStats() {
    return _lastTickExtremeStats;
  }

  return { start, stop, tick, diagnose, diagnosePatterns, diagnoseExtremes, getStats, getConfig, getLifecycleDebug, getRejectLog, getExtremeStats };
}

module.exports = { createFormationService };
