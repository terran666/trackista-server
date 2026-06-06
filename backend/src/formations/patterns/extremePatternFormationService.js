'use strict';

/**
 * extremePatternFormationService.js
 * On-bar-close scanner for horizontal Sharp Extreme pattern formations.
 *
 * Strategy:
 *  1. On heartbeat (2s): lifecycle pass for all stored formations.
 *  2. On new bar close (per TF): run detectors for all eligible symbols.
 *  3. Bars read from Redis bars:1m:{SYM} (sorted set).
 *  4. Sharp Extremes read from trackedExtremesStore (file-backed, cached in-memory).
 *  5. Binance REST used only as fallback (guarded by binanceRequestGuard).
 */

const { patternConfig } = require('./formationPatternConfig');
const { createFormationPatternStore } = require('./formationPatternStore');
const { computeAdaptiveTolerance } = require('./formationPatternScorer');
const { evaluate: evaluateLifecycle } = require('./formationPatternLifecycle');

const ascendingTriangleDetector   = require('./detectors/ascendingTriangleDetector');
const descendingTriangleDetector  = require('./detectors/descendingTriangleDetector');
const rangeBreakoutDetector       = require('./detectors/rangeBreakoutDetector');
const compressionToLevelDetector  = require('./detectors/compressionToLevelDetector');
const bullFlagDetector            = require('./detectors/bullFlagDetector');
const bearFlagDetector            = require('./detectors/bearFlagDetector');

const DETECTORS = [
  ascendingTriangleDetector,
  descendingTriangleDetector,
  rangeBreakoutDetector,
  compressionToLevelDetector,
  bullFlagDetector,
  bearFlagDetector,
];

const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

// ── Binance Request Guard ──────────────────────────────────────────────────────
function createBinanceRequestGuard(cfg) {
  const maxRpm      = cfg.maxRequestsPerMinute ?? 30;
  const c429        = cfg.cooldownOn429Ms      ?? 60_000;
  const c418        = cfg.cooldownOn418Ms      ?? 20 * 60_000;
  const windowMs    = 60_000;

  let requestLog    = []; // timestamps of recent requests
  let cooldownUntil = 0;
  let restCount     = 0;

  function prune(now) {
    requestLog = requestLog.filter(t => now - t < windowMs);
  }

  function canRequest() {
    const now = Date.now();
    if (now < cooldownUntil) return false;
    prune(now);
    return requestLog.length < maxRpm;
  }

  function recordRequest() {
    requestLog.push(Date.now());
    restCount++;
  }

  function recordError(status) {
    const now = Date.now();
    if (status === 429) { cooldownUntil = now + c429; console.warn('[patternFormations] Binance 429 — cooldown 60s'); }
    if (status === 418) { cooldownUntil = now + c418; console.warn('[patternFormations] Binance 418 — cooldown 20m'); }
  }

  function isRateLimited() { return Date.now() < cooldownUntil; }
  function getCooldownMs() { return Math.max(0, cooldownUntil - Date.now()); }
  function getRestCount()  { return restCount; }

  return { canRequest, recordRequest, recordError, isRateLimited, getCooldownMs, getRestCount };
}

// ── Aggregate 1m bars into higher TF ─────────────────────────────────────────
function aggregateBars(bars1m, tfMs) {
  if (!bars1m.length || tfMs <= 60_000) return bars1m;
  const result = [];
  let bucket = null;

  for (const b of bars1m) {
    const bucketTs = Math.floor(b.ts / tfMs) * tfMs;
    if (!bucket || bucket.ts !== bucketTs) {
      if (bucket) result.push(bucket);
      bucket = { ts: bucketTs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      if (b.high > bucket.high) bucket.high = b.high;
      if (b.low  < bucket.low)  bucket.low  = b.low;
      bucket.close = b.close;
      bucket.volume += (b.volume || 0);
    }
  }
  if (bucket) result.push(bucket);
  return result;
}

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Service factory ────────────────────────────────────────────────────────────
function createExtremePatternFormationService({ redis, trackedExtremesStore, config: cfgOverride }) {
  const config = { ...patternConfig, ...(cfgOverride || {}) };
  const store  = createFormationPatternStore(redis, config);
  const guard  = createBinanceRequestGuard(config.binanceRest || {});

  // ── In-memory caches ────────────────────────────────────────────────────────
  const extremesCache = { data: null, builtAt: 0 }; // all extremes from file store
  let lastBarTs       = {}; // symbol:tf → last seen bar ts (bar-close detection)

  // ── Stats ───────────────────────────────────────────────────────────────────
  const stats = {
    heartbeats:    0,
    scans:         0,
    errors:        0,
    candidatesFound: 0,
    formationsCreated: 0,
    formationsUpdated: 0,
    formationsRemoved: 0,
    lastScanAt:    null,
    lastScanMs:    0,
    lastError:     null,
  };

  const debugLogs = []; // rolling debug log (last 200 entries)

  function addDebugLog(entry) {
    debugLogs.push({ ts: Date.now(), ...entry });
    if (debugLogs.length > 200) debugLogs.splice(0, debugLogs.length - 200);
  }

  // ── Get extremes (Sharp Extremes only; cached) ──────────────────────────────
  function getExtremes(symbol, tf, marketType) {
    const now = Date.now();
    if (!extremesCache.data || now - extremesCache.builtAt > config.extremesCacheTtlMs) {
      try {
        extremesCache.data = trackedExtremesStore.getAll({ marketType }) || [];
        extremesCache.builtAt = now;
      } catch (e) {
        console.warn('[patternFormations] extremes read failed:', e.message);
        extremesCache.data = extremesCache.data || [];
      }
    }
    // Filter: only sharp-extremes (source='extremes'), correct symbol+tf
    return (extremesCache.data || []).filter(e =>
      e.source === 'extremes' &&
      e.symbol === symbol &&
      e.tf === tf &&
      e.marketType === marketType
    );
  }

  // ── Read 1m bars from Redis ─────────────────────────────────────────────────
  async function getBars1m(symbol, marketType) {
    const key = marketType === 'spot' ? `bars:1m:spot:${symbol}` : `bars:1m:${symbol}`;
    const limit = config.tfTargetBars?.['1m'] ?? 300;
    const raw = await redis.zrange(key, -limit, -1);
    return raw.map(tryParse).filter(Boolean).sort((a, b) => a.ts - b.ts);
  }

  // ── Fetch from Binance REST (fallback only) ─────────────────────────────────
  async function fetchBinanceBars(symbol, tf, marketType) {
    if (!guard.canRequest()) {
      addDebugLog({ symbol, tf, rejectReason: 'BINANCE_RATE_LIMITED' });
      return null;
    }
    const path  = marketType === 'spot' ? 'https://api.binance.com/api/v3/klines' : `${BINANCE_FUTURES_BASE}/fapi/v1/klines`;
    const limit = config.tfTargetBars?.[tf] ?? 300;
    const url   = `${path}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${limit}`;

    guard.recordRequest();
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        guard.recordError(res.status);
        return null;
      }
      if (!res.ok) return null;
      const rows = await res.json();
      return rows.map(r => ({
        ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
        low: Number(r[3]), close: Number(r[4]),
        volume: Number(r[7]) || Number(r[5]) || 0,
      })).filter(b => Number.isFinite(b.ts) && Number.isFinite(b.close));
    } catch {
      return null;
    }
  }

  // ── Get bars for a specific TF ──────────────────────────────────────────────
  async function getBarsForTf(symbol, tf, marketType) {
    const tfMs   = config.tfDurationMs?.[tf] ?? 60_000;
    const bars1m = await getBars1m(symbol, marketType);
    let bars;

    if (tf === '1m') {
      bars = bars1m;
    } else if (bars1m.length > 0) {
      bars = aggregateBars(bars1m, tfMs);
    }

    // Fallback: if we don't have enough bars, fetch from Binance
    const minBars = config.filters?.minBarsInsidePattern ?? 8;
    if (!bars || bars.length < minBars * 2) {
      const fetched = await fetchBinanceBars(symbol, tf, marketType);
      if (fetched && fetched.length > bars?.length) bars = fetched;
    }

    return bars || [];
  }

  // ── Detect new bar close ────────────────────────────────────────────────────
  function hasNewBarClosed(symbol, tf, bars) {
    if (!bars.length) return false;
    const lastTs = bars[bars.length - 1].ts;
    const key    = `${symbol}:${tf}`;
    const prev   = lastBarTs[key];
    lastBarTs[key] = lastTs;
    return prev !== undefined && lastTs !== prev;
  }

  // ── Check liquidity ─────────────────────────────────────────────────────────
  async function isLiquid(symbol) {
    try {
      const raw = await redis.get('futures:tickers:all');
      const tickers = tryParse(raw) || [];
      const ticker  = (Array.isArray(tickers) ? tickers : tickers.tickers || []).find(t => t.symbol === symbol);
      if (!ticker) return true; // unknown = assume liquid
      const vol    = parseFloat(ticker.volume24hUsd ?? ticker.quoteVolume ?? 0);
      const trades = parseInt(ticker.trades24h ?? ticker.count ?? 0, 10);
      return vol >= config.minVolume24hUsd || trades >= config.minTrades24h;
    } catch {
      return true;
    }
  }

  // ── Run detectors for one symbol+tf ────────────────────────────────────────
  async function scanSymbolTf(symbol, tf, marketType) {
    const scanStart = Date.now();

    const bars = await getBarsForTf(symbol, tf, marketType);
    if (!bars.length) {
      addDebugLog({ symbol, tf, rejectReason: 'NO_CANDLES' });
      return;
    }

    const extremes = getExtremes(symbol, tf, marketType);
    if (!extremes.length) {
      addDebugLog({ symbol, tf, rejectReason: 'NO_SHARP_EXTREMES' });
      return;
    }

    const effectiveTolPct = computeAdaptiveTolerance(bars, config);
    const lastBar         = bars[bars.length - 1];
    const currentPrice    = lastBar?.close ?? 0;

    const debugLog = (entry) => addDebugLog({ symbol, tf, ...entry });

    const candidates = [];
    for (const detector of DETECTORS) {
      try {
        const results = detector.detect({
          symbol, marketType, timeframe: tf,
          candles: bars, extremes, config,
          effectiveTolPct, debugLog,
        });
        candidates.push(...(results || []));
      } catch (e) {
        console.error(`[patternFormations] detector error ${symbol} ${tf}:`, e.message);
      }
    }

    stats.candidatesFound += candidates.length;

    const now = Date.now();
    const expiresAt = now + (config.redisTtlMs?.[tf] ?? 6 * 3_600_000);

    for (const candidate of candidates) {
      const record = {
        ...candidate,
        symbol,
        marketType,
        mainTf: tf,
        currentPrice,
        status: 'FORMING',
        breakout: { isBroken: false, brokenAt: null, brokenPrice: null, brokenCandleClose: null, direction: null, confirmed: false },
        timestamps: { createdAt: now, updatedAt: now, expiresAt },
      };

      try {
        const upserted = await store.upsert(record);
        if (upserted.createdAt === upserted.updatedAt) {
          stats.formationsCreated++;
        } else {
          stats.formationsUpdated++;
        }
      } catch (e) {
        console.error(`[patternFormations] store.upsert error:`, e.message);
      }
    }

    const scanMs = Date.now() - scanStart;
    addDebugLog({
      symbol, tf,
      event: 'SCAN_COMPLETE',
      barsLoaded: bars.length,
      extremesFound: extremes.length,
      candidatesFound: candidates.length,
      effectiveTolPct: +effectiveTolPct.toFixed(3),
      scanMs,
    });
  }

  // ── Lifecycle pass ──────────────────────────────────────────────────────────
  async function runLifecycle() {
    const formations = await store.getActive();
    if (!formations.length) return;

    // Get current prices for all symbols
    const symbols = [...new Set(formations.map(f => f.symbol))];
    const priceMap = new Map();
    try {
      const pipeline = redis.pipeline();
      for (const sym of symbols) pipeline.get(`metrics:${sym}`);
      const results = await pipeline.exec();
      for (let i = 0; i < symbols.length; i++) {
        const m = tryParse(results[i][1]);
        const price = parseFloat(m?.lastPrice ?? m?.price ?? 0);
        if (price > 0) priceMap.set(symbols[i], price);
      }
    } catch {}

    for (const formation of formations) {
      try {
        const currentPrice = priceMap.get(formation.symbol) ?? formation.currentPrice ?? 0;
        const result = evaluateLifecycle(formation, { currentPrice, latestBar: { close: currentPrice, ts: Date.now() }, config });

        if (result.action === 'remove') {
          await store.remove(formation.id, formation.symbol);
          stats.formationsRemoved++;
        } else if (result.action === 'update' && result.patch) {
          await store.upsert({ ...formation, ...result.patch, currentPrice });
          stats.formationsUpdated++;
        }
      } catch (e) {
        console.error(`[patternFormations] lifecycle error ${formation.id}:`, e.message);
      }
    }
  }

  // ── Symbols list ────────────────────────────────────────────────────────────
  async function getActiveSymbols() {
    try {
      // symbols:active:usdt may be a JSON string or a Redis Set
      const type = await redis.type('symbols:active:usdt');
      if (type === 'set') {
        const members = await redis.smembers('symbols:active:usdt');
        return (members || []).filter(Boolean).map(s => s.toUpperCase());
      } else {
        // string — JSON array
        const raw = await redis.get('symbols:active:usdt');
        const arr = tryParse(raw);
        if (Array.isArray(arr)) return arr.filter(Boolean).map(s => s.toUpperCase());
        return [];
      }
    } catch {
      return [];
    }
  }

  // ── Main heartbeat ──────────────────────────────────────────────────────────
  let heartbeatTimer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const tickStart = Date.now();
    stats.heartbeats++;

    try {
      // 1) Lifecycle pass every heartbeat
      await runLifecycle();

      // 2) On-bar-close: figure out which symbols have new 1m bars
      const symbols = await getActiveSymbols();
      if (!symbols.length) { running = false; return; }

      const marketType = config.marketType || 'futures';

      // Batch-read last 1m bar timestamp for all symbols (1 pipeline)
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        const key = marketType === 'spot' ? `bars:1m:spot:${sym}` : `bars:1m:${sym}`;
        pipeline.zrange(key, -1, -1);
      }
      const batchResults = await pipeline.exec();

      const now = Date.now();
      // Process each symbol — check bar-close, then scan relevant TFs
      // Limit scans per tick to avoid blocking the event loop for too long
      const MAX_SCANS_PER_TICK = 30;
      let scansThisTick = 0;

      for (let si = 0; si < symbols.length && scansThisTick < MAX_SCANS_PER_TICK; si++) {
        const symbol    = symbols[si];
        const lastRawArr = batchResults[si]?.[1];
        const lastBar1m  = tryParse(Array.isArray(lastRawArr) ? lastRawArr[0] : null);
        if (!lastBar1m?.ts) continue;

        for (const tf of config.timeframes) {
          try {
            const tfMs = config.tfDurationMs?.[tf] ?? 60_000;
            const bucketTs = Math.floor(lastBar1m.ts / tfMs) * tfMs;

            const barKey = `${symbol}:${tf}`;
            const lastKnownBarTs = lastBarTs[barKey];

            // Skip if no new bar closed in this TF
            if (lastKnownBarTs !== undefined && lastKnownBarTs === bucketTs) continue;
            lastBarTs[barKey] = bucketTs;

            // Cooldown: don't rescan too frequently
            const cooldownKey = `scan:${barKey}`;
            const lastScan = lastBarTs[cooldownKey] ?? 0;
            if (now - lastScan < Math.max(10_000, tfMs * 0.9)) continue;
            lastBarTs[cooldownKey] = now;

            // Liquidity gate (lightweight — reads cached Redis tickers)
            const liquid = await isLiquid(symbol);
            if (!liquid) {
              addDebugLog({ symbol, tf, rejectReason: 'LOW_LIQUIDITY' });
              continue;
            }

            await scanSymbolTf(symbol, tf, marketType);
            stats.scans++;
            scansThisTick++;
          } catch (e) {
            stats.errors++;
            stats.lastError = e.message;
          }
        }
      }

      stats.lastScanAt = Date.now();
      stats.lastScanMs = Date.now() - tickStart;
    } catch (e) {
      stats.errors++;
      stats.lastError = e.message;
    } finally {
      running = false;
    }
  }

  function start() {
    if (heartbeatTimer) return;
    // Pre-populate lastBarTs so we don't scan everything on first heartbeat.
    // We do a one-shot "snapshot" of current bar timestamps.
    _initLastBarTs().catch(() => {});
    heartbeatTimer = setInterval(tick, config.heartbeatMs ?? 2_000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
    console.log('[patternFormations] service started');
  }

  async function _initLastBarTs() {
    try {
      const symbols = await getActiveSymbols();
      if (!symbols.length) return;
      const marketType = config.marketType || 'futures';
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        const key = marketType === 'spot' ? `bars:1m:spot:${sym}` : `bars:1m:${sym}`;
        pipeline.zrange(key, -1, -1);
      }
      const results = await pipeline.exec();
      const now = Date.now();
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const lastRaw = results[i]?.[1];
        const lastBar = tryParse(Array.isArray(lastRaw) ? lastRaw[0] : null);
        if (!lastBar?.ts) continue;
        for (const tf of config.timeframes) {
          const tfMs = config.tfDurationMs?.[tf] ?? 60_000;
          const bucketTs = Math.floor(lastBar.ts / tfMs) * tfMs;
          const barKey = `${sym}:${tf}`;
          lastBarTs[barKey] = bucketTs;
          // Do NOT set scan cooldown here — let first real bar-close trigger scans
        }
      }
      console.log(`[patternFormations] init: seeded lastBarTs for ${symbols.length} symbols`);
    } catch (e) {
      console.warn('[patternFormations] _initLastBarTs failed:', e.message);
    }
  }

  function stop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    console.log('[patternFormations] service stopped');
  }

  function getStats() {
    return {
      ...stats,
      binanceRestCount: guard.getRestCount(),
      binanceRateLimited: guard.isRateLimited(),
      binanceCooldownMs: guard.getCooldownMs(),
    };
  }

  function getDebugLogs(symbol, tf) {
    if (!symbol) return debugLogs.slice(-50);
    return debugLogs.filter(e => e.symbol === symbol && (!tf || e.tf === tf)).slice(-50);
  }

  return { start, stop, store, getStats, getDebugLogs };
}

module.exports = { createExtremePatternFormationService };
