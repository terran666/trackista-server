'use strict';

const https = require('https');
const { calculateAutoLevels, AUTO_LEVELS_DEFAULTS } = require('../engines/autolevels/autoLevelsEngine');

const BINANCE_SPOT_BASE    = 'https://api.binance.com/api/v3/klines';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1/klines';

// ─── In-memory klines cache ───────────────────────────────────────
//
// Prevents repeated Binance klines fetches for identical requests.
// TTL is 15s by default (configurable via KLINES_CACHE_TTL_MS).
// Cache key: "${symbol}:${tf}:${marketType}:${limit}"
//
const KLINES_CACHE_TTL_MS = parseInt(process.env.KLINES_CACHE_TTL_MS || '15000', 10);
const klinesCache = new Map(); // key → { bars, expiresAt }

function getCachedBars(key) {
  const entry = klinesCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    klinesCache.delete(key);
    return null;
  }
  return entry.bars;
}

function setCachedBars(key, bars) {
  klinesCache.set(key, { bars, expiresAt: Date.now() + KLINES_CACHE_TTL_MS });
  // Evict expired entries when cache grows (simple GC)
  if (klinesCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of klinesCache) {
      if (now > v.expiresAt) klinesCache.delete(k);
    }
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchBars(symbol, interval, limit, marketType) {
  const base  = marketType === 'futures' ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
  const url   = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return fetchJson(url).then(raw => {
    if (!Array.isArray(raw)) return [];
    return raw.map(k => ({
      timestamp: Number(k[0]),
      open:      Number(k[1]),
      high:      Number(k[2]),
      low:       Number(k[3]),
      close:     Number(k[4]),
      volume:    Number(k[5]),
    }));
  });
}

function parseBool(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  if (val === 'false' || val === '0') return false;
  if (val === 'true'  || val === '1') return true;
  return fallback;
}

function parseNum(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

async function autoLevelsHandler(req, res) {
  const {
    symbol,
    tf          = '5m',
    marketType  = 'spot',
    lookbackBars,
    minBars,
    pivotWindow,
    maxLevels,
    clusterMode,
    atrFactor,
    percentStep,
    swingAtrFactor,
    swingPercent,
    maxSupport,
    maxResistance,
    virginOnly,
    virginPolicy,
    virginFallback,
    toleranceMode,
    toleranceAtrFactor,
    tolerancePercent,
  } = req.query;

  console.log(`[autolevels] request: symbol=${symbol} tf=${tf} marketType=${marketType} lookbackBars=${lookbackBars ?? 'default'}`);

  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }

  let bars;
  try {
    const limit = Math.min(2000, Math.max(200, parseNum(lookbackBars, AUTO_LEVELS_DEFAULTS.lookbackBars) + 50));
    const cacheKey = `${symbol.toUpperCase()}:${tf}:${marketType}:${limit}`;
    bars = getCachedBars(cacheKey);
    if (bars) {
      console.log(`[autolevels] cache HIT: ${cacheKey}`);
    } else {
      console.log(`[autolevels] cache MISS: ${cacheKey} — fetching from Binance`);
      bars = await fetchBars(symbol.toUpperCase(), tf, limit, marketType);
      if (bars.length) setCachedBars(cacheKey, bars);
    }
  } catch (err) {
    console.error('[autolevels] fetchBars error:', err.message);
    return res.json([]);
  }

  console.log(`[autolevels] bars fetched: ${bars.length}`);

  if (!bars.length) return res.json([]);

  const options = {
    lookbackBars:       parseNum(lookbackBars,       AUTO_LEVELS_DEFAULTS.lookbackBars),
    minBars:            parseNum(minBars,             AUTO_LEVELS_DEFAULTS.minBars),
    pivotWindow:        parseNum(pivotWindow,         AUTO_LEVELS_DEFAULTS.pivotWindow),
    maxLevels:          parseNum(maxLevels,           AUTO_LEVELS_DEFAULTS.maxLevels),
    clusterMode:        clusterMode || AUTO_LEVELS_DEFAULTS.clusterMode,
    atrFactor:          parseNum(atrFactor,           AUTO_LEVELS_DEFAULTS.atrFactor),
    percentStep:        parseNum(percentStep,         AUTO_LEVELS_DEFAULTS.percentStep),
    swingAtrFactor:     parseNum(swingAtrFactor,      AUTO_LEVELS_DEFAULTS.swingAtrFactor),
    swingPercent:       parseNum(swingPercent,        AUTO_LEVELS_DEFAULTS.swingPercent),
    maxSupport:         parseNum(maxSupport,          AUTO_LEVELS_DEFAULTS.maxSupport),
    maxResistance:      parseNum(maxResistance,       AUTO_LEVELS_DEFAULTS.maxResistance),
    virginOnly:         parseBool(virginOnly,         AUTO_LEVELS_DEFAULTS.virginOnly),
    virginPolicy:       virginPolicy || AUTO_LEVELS_DEFAULTS.virginPolicy,
    virginFallback:     parseBool(virginFallback,     AUTO_LEVELS_DEFAULTS.virginFallback),
    toleranceMode:      toleranceMode || AUTO_LEVELS_DEFAULTS.toleranceMode,
    toleranceAtrFactor: parseNum(toleranceAtrFactor,  AUTO_LEVELS_DEFAULTS.toleranceAtrFactor),
    tolerancePercent:   parseNum(tolerancePercent,    AUTO_LEVELS_DEFAULTS.tolerancePercent),
  };

  let result;
  try {
    result = calculateAutoLevels(bars, options);
  } catch (err) {
    console.error('[autolevels] calculateAutoLevels error:', err.message);
    return res.json([]);
  }

  const levels = (result?.levels ?? []);
  console.log(`[autolevels] result count=${levels.length} reason=${result?.reason}`);

  return res.json(levels);
}

module.exports = { autoLevelsHandler };
