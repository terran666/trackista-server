'use strict';

const { calculateLevels } = require('../engines/levels/levelsEngine');
const { getCachedBars, setCachedBars } = require('../utils/klinesCache');
const { binanceFetch } = require('../utils/binanceRestLogger');

const BINANCE_SPOT_BASE    = 'https://api.binance.com';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

// klines cache is shared — see backend/src/utils/klinesCache.js

const VALID_INTERVALS = new Set([
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M'
]);

const VALID_MARKET_TYPES = new Set(['spot','futures']);

const GLOBAL_SOURCE_INTERVAL = '1h';
const GLOBAL_LIMIT = 500;
const LOCAL_LIMIT  = 500;

const CONFIG_BY_TYPE = {

  global: {
    maxLevels: 12,
    tolerancePercent: 0.4,
    minPivotsInCluster: 1,
    minTouches: 2,
    minDistancePercentBetweenLevels: 0.3
  },

  local: {
    maxLevels: 10,
    tolerancePercent: 0.25,
    minPivotsInCluster: 1,
    minTouches: 2,
    minDistancePercentBetweenLevels: 0.15
  }

};

async function fetchBars(symbol, interval, limit, marketType){

  const base = marketType === 'futures'
    ? BINANCE_FUTURES_BASE
    : BINANCE_SPOT_BASE;

  const path = marketType === 'futures'
    ? '/fapi/v1/klines'
    : '/api/v3/klines';

  const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;

  const res = await binanceFetch(url, undefined, 'levelsEngineRoute', symbol, `klines:${interval}:${limit}`);

  if(!res.ok){

    const text = await res.text().catch(()=>'');

    throw new Error(`Binance ${marketType} ${res.status}: ${text}`);

  }

  const raw = await res.json();

  return raw.map(k=>({

    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low:  parseFloat(k[3]),
    close:parseFloat(k[4]),
    volume:parseFloat(k[5])

  }));

}

async function levelsHandler(req,res){

  console.log('[levels] HANDLER VERSION 2');

  const symbol = (req.query.symbol || '').toUpperCase();
  const tf     = (req.query.tf || '').toLowerCase();
  const type   = (req.query.type || 'local').toLowerCase();

  const marketType = VALID_MARKET_TYPES.has(req.query.marketType)
    ? req.query.marketType
    : 'spot';

  if(!symbol){

    return res.status(400).json({
      success:false,
      error:'Missing symbol'
    });

  }

  if(!tf){

    return res.status(400).json({
      success:false,
      error:'Missing tf'
    });

  }

  if(!VALID_INTERVALS.has(tf)){

    return res.status(400).json({
      success:false,
      error:`Invalid tf ${tf}`
    });

  }

  const isGlobal = type === 'global';

  const sourceInterval = isGlobal
    ? GLOBAL_SOURCE_INTERVAL
    : tf;

  const limit = isGlobal
    ? GLOBAL_LIMIT
    : LOCAL_LIMIT;

  const config = CONFIG_BY_TYPE[type] || CONFIG_BY_TYPE.local;

  console.log(`[levels] request symbol=${symbol} tf=${tf} type=${type} marketType=${marketType} source=${sourceInterval}`);

  let bars = [];

  try{

    const cacheKey = `${symbol}:${sourceInterval}:${marketType}:${limit}`;
    bars = getCachedBars(cacheKey);
    if (bars) {
      console.log(`[levels] cache HIT: ${cacheKey}`);
    } else {
      console.log(`[levels] cache MISS: ${cacheKey} — fetching from Binance`);
      bars = await fetchBars(symbol, sourceInterval, limit, marketType);
      if (bars.length) setCachedBars(cacheKey, bars);
    }

  } catch(err) {
    console.error('[levels] fetch failed', err.message);
    // IP ban: tell the frontend to retry later rather than return empty data
    if (err.status === 418 || err.message.includes('IP ban')) {
      const retryAfterSec = Math.ceil((err.retryAfterMs || 60000) / 1000);
      return res.status(503).json({
        success: false,
        error:   `Binance IP ban active — retry in ${retryAfterSec}s`,
        retryAfterSec,
      });
    }
    return res.json([]);
  }

  const minRequired = 15;

  console.log(`[levels] bars=${bars.length}`);

  if(!bars || bars.length < minRequired){

    console.warn('[levels] insufficient bars');

    return res.json([]);

  }

  let levels = [];

  try{

    levels = calculateLevels({

      bars,
      levelType:type,
      sourceInterval,
      config

    }) || [];

  }catch(err){

    console.error('[levels] calculateLevels error',err.message);

    return res.json([]);

  }

  console.log(`[levels] result ${levels.length} levels`);

  return res.json(levels);

}

module.exports = { levelsHandler };