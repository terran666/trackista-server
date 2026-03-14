'use strict';

const { calculateAutoLevels, AUTO_LEVELS_DEFAULTS } = require('../engines/autolevels/autoLevelsEngine');
const { getCachedBars, setCachedBars } = require('../utils/klinesCache');
const { binanceFetch } = require('../utils/binanceRestLogger');

const BINANCE_SPOT_BASE    = 'https://api.binance.com/api/v3/klines';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1/klines';

// klines cache is shared — see backend/src/utils/klinesCache.js

function fetchBars(symbol, interval, limit, marketType) {
  const base  = marketType === 'futures' ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
  const url   = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return binanceFetch(url, undefined, 'autoLevelsRoute', symbol, `klines:${interval}:${limit}`)
    .then(res => {
      if (!res.ok) throw new Error(`Binance ${res.status}`);
      return res.json();
    })
    .then(raw => {
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
