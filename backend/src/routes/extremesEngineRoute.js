'use strict';

/**
 * extremesEngineRoute.js — Server-side computation of chart analysis tools.
 *
 * GET /api/extremes-engine
 *
 * Required params:
 *   symbol     — e.g. BTCUSDT
 *   tf         — timeframe: 1m | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 6h | 8h | 12h | 1d | 3d | 1w | 1M
 *   source     — sharp-extremes | vertical-extremes | trendlines
 *
 * Optional params:
 *   marketType — spot | futures  (default: futures)
 *   save       — true | false    (default: true — persist to trackedExtremesStore)
 *
 * Settings overrides (all optional, server applies safe defaults):
 *   lookbackBars         — all sources
 *
 *   [sharp-extremes]
 *   pivotWindow          — bars left/right to confirm pivot (1–20, default 3)
 *   minStrengthPct       — min % move to qualify as "sharp" (0–20, default 0.3)
 *   maxExtremes          — max results (1–200, default 60)
 *
 *   [vertical-extremes]
 *   variant              — range | volume | both  (default: range)
 *   volumeMultiplier     — volume >= avg × this (1–20, default 2.5)
 *   rangeMultiplier      — range  >= ATR × this (1–20, default 2.0)
 *   atrPeriod            — ATR period (2–50, default 14)
 *   clusterTolerancePct  — merge levels within % (0.01–5, default 0.5)
 *   maxExtremes          — max results (1–200, default 50)
 *
 *   [trendlines]
 *   pivotWindow          — bars left/right to confirm pivot (1–20, default 3)
 *   minTouches           — min touches incl anchor pair (2–20, default 2)
 *   touchTolerancePct    — % to count a touch (0.01–5, default 0.35)
 *   maxLinesPerSide      — max lines per side (1–20, default 5)
 *   minSlopePct          — min slope per bar % (0–1, default 0.001)
 *
 * Response:
 *   { success, source, symbol, tf, marketType, settings, count, extremes, saved? }
 *
 * When save=true (default):
 *   • Results are persisted via trackedExtremesStore.bulkSave()
 *   • Records marked userModified=true are preserved unchanged across recalculations
 *   • Frontend can call GET /api/tracked-extremes to read persisted data
 *
 * Pattern mirrors levelsEngineRoute.js — uses shared klinesCache.
 */

const { getCachedBars, setCachedBars }     = require('../utils/klinesCache');
const { binanceFetch }                     = require('../utils/binanceRestLogger');
const { safeSymbol }                       = require('../utils/parseClamp');
const store                                = require('../services/trackedExtremesStore');

const { findSharpExtremes,    DEFAULT_SETTINGS: SHARP_DEFAULTS    } = require('../engines/extremes/sharpExtremesEngine');
const { findVerticalExtremes, DEFAULT_SETTINGS: VERTICAL_DEFAULTS } = require('../engines/extremes/verticalExtremesEngine');
const { findTrendlines,       DEFAULT_SETTINGS: TL_DEFAULTS       } = require('../engines/trendlines/trendlinesEngine');

// ─── Constants ────────────────────────────────────────────────────

const BINANCE_SPOT_BASE    = 'https://api.binance.com';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_SOURCES      = new Set(['sharp-extremes', 'vertical-extremes', 'trendlines']);
const VALID_INTERVALS    = new Set([
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M',
]);
const VALID_VE_VARIANTS  = new Set(['range', 'volume', 'both']);

// ─── Default settings per source ─────────────────────────────────

const SOURCE_DEFAULTS = {
  'sharp-extremes'    : { ...SHARP_DEFAULTS    },
  'vertical-extremes' : { ...VERTICAL_DEFAULTS },
  'trendlines'        : { ...TL_DEFAULTS       },
};

// ─── Bar fetching (mirrors levelsEngineRoute) ─────────────────────

async function _fetchBars(symbol, interval, limit, marketType) {
  const base = marketType === 'futures' ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
  const path = marketType === 'futures' ? '/fapi/v1/klines'    : '/api/v3/klines';
  const url  = `${base}${path}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;

  const res = await binanceFetch(url, undefined, 'extremesEngineRoute', symbol, `klines:${interval}:${limit}`);

  if (!res.ok) {
    const text  = await res.text().catch(() => '');
    const err   = new Error(`Binance ${marketType} ${res.status}: ${text}`);
    err.status  = res.status;
    throw err;
  }

  const raw = await res.json();
  return raw.map(k => ({
    time  : k[0],
    open  : parseFloat(k[1]),
    high  : parseFloat(k[2]),
    low   : parseFloat(k[3]),
    close : parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Settings parsing & safe clamping ────────────────────────────

function _parseSettings(source, query) {
  const settings = { ...SOURCE_DEFAULTS[source] };

  function _int(key, min, max) {
    const v = parseInt(query[key], 10);
    if (!isNaN(v) && Number.isFinite(v) && v >= min && v <= max) settings[key] = v;
  }
  function _num(key, min, max) {
    const v = parseFloat(query[key]);
    if (!isNaN(v) && Number.isFinite(v) && v >= min && v <= max) settings[key] = v;
  }

  // Shared
  _int('lookbackBars', 20, 2000);

  if (source === 'sharp-extremes') {
    // pivotWindow maps to both pivotLeft and pivotRight (mirrors frontend behavior)
    const pw = parseInt(query.pivotWindow, 10);
    if (!isNaN(pw) && pw >= 1 && pw <= 20) {
      settings.pivotLeft  = pw;
      settings.pivotRight = pw;
    }
    _num('minStrengthPct', 0,  20);
    _int('maxExtremes',    1, 200);
  } else if (source === 'vertical-extremes') {
    // maxVariantsPerSide (frontend name) → maxLinesPerSide (engine name)
    const mv = parseInt(query.maxVariantsPerSide, 10);
    if (!isNaN(mv) && mv >= 1 && mv <= 20) settings.maxLinesPerSide = mv;
    _int('maxLinesPerSide', 1, 20); // direct override if passed
    _int('minTouches',      2, 20);
    _num('tolPct',          0.0001, 0.05); // maps to tolPctDefault
    if (settings.tolPct !== undefined) { settings.tolPctDefault = settings.tolPct; delete settings.tolPct; }
    _int('pivotLeft',       1, 20);
    _int('pivotRight',      1, 20);
    const pw2 = parseInt(query.pivotWindow, 10);
    if (!isNaN(pw2) && pw2 >= 1 && pw2 <= 20) { settings.pivotLeft = pw2; settings.pivotRight = pw2; }
  } else if (source === 'trendlines') {
    _int('pivotWindow',       1,  20);
    // pivotWindow → pivotLeft + pivotRight
    if (settings.pivotWindow !== undefined) {
      settings.pivotLeft  = settings.pivotWindow;
      settings.pivotRight = settings.pivotWindow;
      delete settings.pivotWindow;
    }
    _int('minTouches',        2,  20);
    _num('touchTolerancePct', 0.001, 5);
    // touchTolerancePct from frontend is in percent (e.g. 0.2 = 0.2%), map to tolPctDefault (fraction)
    if (settings.touchTolerancePct !== undefined) {
      settings.tolPctDefault = settings.touchTolerancePct / 100;
      delete settings.touchTolerancePct;
    }
    _int('maxLinesPerSide',   1,  20);
    _num('minSlopePct',       0,   1);
    _num('minAngleDeg',       0,  89);
    _num('maxAngleDeg',       1,  89);
  }

  return settings;
}

// ─── Main handler ─────────────────────────────────────────────────

async function extremesEngineHandler(req, res) {
  // ── Validate ─────────────────────────────────────────────────
  const symbol     = safeSymbol(req.query.symbol);
  const marketType = VALID_MARKET_TYPES.has(req.query.marketType) ? req.query.marketType : 'futures';
  const tf         = (req.query.tf     || '').toLowerCase();
  const source     = (req.query.source || '').toLowerCase();
  const save       = req.query.save !== 'false'; // default true

  if (!symbol) {
    return res.status(400).json({ success: false, error: 'Missing or invalid symbol' });
  }
  if (!VALID_INTERVALS.has(tf)) {
    return res.status(400).json({
      success: false,
      error  : `Invalid or missing tf. Valid: ${[...VALID_INTERVALS].join(', ')}`,
    });
  }
  if (!VALID_SOURCES.has(source)) {
    return res.status(400).json({
      success: false,
      error  : `Invalid or missing source. Valid: ${[...VALID_SOURCES].join(', ')}`,
    });
  }

  const settings = _parseSettings(source, req.query);
  const limit    = settings.lookbackBars;

  // ── Fetch bars (shared klinesCache) ──────────────────────────
  let bars;
  try {
    const cacheKey = `${symbol}:${tf}:${marketType}:${limit}`;
    bars = getCachedBars(cacheKey);
    if (bars) {
      console.log(`[extremes-engine] cache HIT  ${cacheKey}`);
    } else {
      console.log(`[extremes-engine] cache MISS ${cacheKey} — fetching Binance`);
      bars = await _fetchBars(symbol, tf, limit, marketType);
      if (bars.length) setCachedBars(cacheKey, bars);
    }
  } catch (err) {
    console.error('[extremes-engine] fetch failed:', err.message);
    if (err.status === 418 || err.message.includes('IP ban')) {
      const retryAfterSec = Math.ceil((err.retryAfterMs || 60_000) / 1000);
      return res.status(503).json({
        success      : false,
        error        : `Binance IP ban active — retry in ${retryAfterSec}s`,
        retryAfterSec,
      });
    }
    return res.status(502).json({ success: false, error: `Binance fetch failed: ${err.message}` });
  }

  if (!bars || bars.length < 10) {
    return res.status(422).json({ success: false, error: 'Insufficient bar data from Binance' });
  }

  // ── Convert bar format: Binance returns time, algorithms expect timestamp ──
  // All three ported engines use { timestamp, open, high, low, close, volume }
  const barsWithTs = bars[0] && bars[0].timestamp !== undefined
    ? bars
    : bars.map(b => ({ ...b, timestamp: b.time }));

  // ── Compute ───────────────────────────────────────────────────
  // Pass tf into settings so slope filters work per-timeframe
  const computeSettings = { ...settings, tf };

  let extremes;
  try {
    if (source === 'sharp-extremes') {
      extremes = findSharpExtremes(barsWithTs, computeSettings);
    } else if (source === 'vertical-extremes') {
      extremes = findVerticalExtremes(barsWithTs, computeSettings);
    } else {
      extremes = findTrendlines(barsWithTs, computeSettings);
    }
  } catch (err) {
    console.error(`[extremes-engine] compute error source=${source}:`, err.message);
    return res.status(500).json({ success: false, error: 'Computation error' });
  }

  console.log(
    `[extremes-engine] symbol=${symbol} tf=${tf} source=${source} ` +
    `computed=${extremes.length} save=${save}`,
  );

  // ── Persist (optional, default: true) ────────────────────────
  // userModified=true records in the store are preserved automatically by
  // bulkSave — the server never overwrites manually-dragged trendlines.
  let saved = null;
  if (save) {
    try {
      const userId = req.user?.id ?? null;
      // Frontend reads tracked-extremes with source='extremes', so we must
      // save using that key regardless of the engine source type.
      const storeSource = source === 'sharp-extremes' ? 'extremes' : source;
      // force=true bypasses fingerprint cache so deleted levels are restored
      const result = store.bulkSave({ userId, symbol, marketType, tf, source: storeSource, extremes, force: true });
      saved = { skipped: result.skipped, count: result.items.length };
      console.log(
        `[extremes-engine] stored source=${storeSource} symbol=${symbol} ` +
        `count=${result.items.length} skipped=${result.skipped}`,
      );
    } catch (err) {
      // Non-fatal — still return computed results to client
      console.error('[extremes-engine] store.bulkSave failed:', err.message);
    }
  }

  return res.json({
    success   : true,
    source,
    symbol,
    tf,
    marketType,
    settings,
    count     : extremes.length,
    extremes,
    ...(saved !== null ? { saved } : {}),
  });
}

// ─── Debug handler ────────────────────────────────────────────────
// GET /api/extremes-engine/debug?symbol=XLMUSDT&tf=1h&source=sharp-extremes
//
// Returns per-candle diagnostic for every detected pivot:
//   { candleIndex, timestamp, high, low, close, detectedType, finalPrice, reasons[] }

async function extremesEngineDebugHandler(req, res) {
  const symbol     = safeSymbol(req.query.symbol);
  const marketType = VALID_MARKET_TYPES.has(req.query.marketType) ? req.query.marketType : 'futures';
  const tf         = (req.query.tf     || '').toLowerCase();
  const source     = (req.query.source || 'sharp-extremes').toLowerCase();

  if (!symbol)                  return res.status(400).json({ success: false, error: 'Missing or invalid symbol' });
  if (!VALID_INTERVALS.has(tf)) return res.status(400).json({ success: false, error: 'Invalid or missing tf' });
  if (source !== 'sharp-extremes')
    return res.status(400).json({ success: false, error: 'debug endpoint only supports source=sharp-extremes' });

  const settings = _parseSettings(source, req.query);
  const limit    = settings.lookbackBars;

  let bars;
  try {
    const cacheKey = `${symbol}:${tf}:${marketType}:${limit}`;
    bars = getCachedBars(cacheKey);
    if (!bars) {
      bars = await _fetchBars(symbol, tf, limit, marketType);
      if (bars.length) setCachedBars(cacheKey, bars);
    }
  } catch (err) {
    return res.status(502).json({ success: false, error: `Binance fetch failed: ${err.message}` });
  }

  if (!bars || bars.length < 10)
    return res.status(422).json({ success: false, error: 'Insufficient bar data' });

  const barsWithTs = bars[0]?.timestamp !== undefined
    ? bars
    : bars.map(b => ({ ...b, timestamp: b.time }));

  // Run engine with debug mode: collect reason for each pivot
  const { findSharpExtremesDebug } = require('../engines/extremes/sharpExtremesEngine');
  const debugResult = findSharpExtremesDebug(barsWithTs, { ...settings, tf });

  return res.json({
    success    : true,
    source,
    symbol,
    tf,
    marketType,
    settings,
    totalBars  : barsWithTs.length,
    detected   : debugResult.detected,
    rejected   : debugResult.rejected,
    pivots     : debugResult.pivots,
  });
}

module.exports = { extremesEngineHandler, extremesEngineDebugHandler };
