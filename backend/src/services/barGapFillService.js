'use strict';

/**
 * barGapFillService.js
 *
 * Scans Redis bars:1m:{SYM} Sorted Sets for gaps (consecutive timestamps that
 * differ by more than 1 bar interval), then fetches the missing bars from
 * Binance REST and writes them to Redis + MySQL.
 *
 * Run modes:
 *   1. Periodic: attach to the barAggregatorService lifecycle — runs every
 *      GAP_FILL_INTERVAL_MS (default 10 min) so short collector outages are
 *      healed automatically.
 *   2. Manual: node barGapFillService.js  (standalone, runs once)
 *
 * Binance REST weight per symbol: limit=10 → weight=2. At 1 symbol/200ms the
 * total load is ≤ 5 req/s = 300 req/min = 600 weight/min (well under 2400/min).
 */

const { binanceFetch } = require('../utils/binanceRestLogger');

const BINANCE_FAPI_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const BINANCE_SPOT_KLINES = 'https://api.binance.com/api/v3/klines';

const GAP_FILL_INTERVAL_MS = parseInt(process.env.BAR_GAP_FILL_INTERVAL_MS || String(10 * 60 * 1000), 10);
const GAP_THRESHOLD_MS     = 120_000;   // gaps smaller than 2m are treated as normal (price inactivity)
const MAX_FILL_BARS        = 50;        // maximum bars to fetch per gap (1 Binance call)
const STAGGER_MS           = 500;       // delay between symbols — 2 req/s = 4 weight/s (safe at any load level)
const REDIS_TTL_MS         = parseInt(process.env.BARS_REDIS_TTL_MS || String(48 * 3600 * 1000), 10);
const MAX_REDIS_BARS       = parseInt(process.env.BARS_MAX_REDIS_BARS || '1500', 10);

let _redis = null;
let _db    = null;
let _timer = null;
let _running = false;

function attach(redis, db) {
  _redis = redis;
  _db    = db;
}

function start() {
  if (_timer) return;
  // First run 60s after service starts (let backfill settle)
  setTimeout(() => {
    runGapFill().catch(err => console.error('[barGapFill] initial run error:', err.message));
    _timer = setInterval(() => {
      runGapFill().catch(err => console.error('[barGapFill] periodic run error:', err.message));
    }, GAP_FILL_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
  }, 60_000);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Main gap-fill routine.
 * Scans all bars:1m:* keys, finds gaps, fetches missing bars from Binance.
 */
async function runGapFill() {
  if (!_redis) return;
  if (_running) {
    console.log('[barGapFill] previous run still in progress — skipping');
    return;
  }
  _running = true;
  const startTs = Date.now();

  try {
    // Get all futures bar keys (exclude spot)
    const keys = await _redis.keys('bars:1m:*');
    const futuresKeys = keys.filter(k => !k.startsWith('bars:1m:spot:'));
    if (futuresKeys.length === 0) return;

    let symbolsScanned = 0;
    let symbolsWithGaps = 0;
    let totalGapsFilled = 0;
    let totalBarsFilled = 0;

    for (const key of futuresKeys) {
      const symbol = key.replace('bars:1m:', '');

      // Only check recent bars (last 48h to limit scan time)
      const since = Date.now() - REDIS_TTL_MS;
      const raw = await _redis.zrangebyscore(key, since, '+inf');
      if (raw.length < 2) continue;

      const tsList = raw
        .map(r => { try { return JSON.parse(r).ts; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => a - b);

      // Find gaps
      const gaps = [];
      for (let i = 1; i < tsList.length; i++) {
        const diff = tsList[i] - tsList[i - 1];
        if (diff > GAP_THRESHOLD_MS) {
          gaps.push({ startTs: tsList[i - 1], endTs: tsList[i], missingMs: diff - 60_000 });
        }
      }

      if (gaps.length === 0) { symbolsScanned++; continue; }

      symbolsWithGaps++;
      symbolsScanned++;

      for (const gap of gaps) {
        const filled = await fillGap(symbol, gap.startTs, gap.endTs);
        totalBarsFilled += filled;
        if (filled > 0) totalGapsFilled++;
        // Stagger every gap fill to protect rate limit
        await sleep(STAGGER_MS);
      }
    }

    const elapsedMs = Date.now() - startTs;
    if (symbolsWithGaps > 0 || elapsedMs > 5000) {
      console.log(
        `[barGapFill] scan done: ${symbolsScanned} symbols, ${symbolsWithGaps} with gaps,` +
        ` ${totalGapsFilled} filled, ${totalBarsFilled} bars added, ${elapsedMs}ms`,
      );
    }

  } finally {
    _running = false;
  }
}

/**
 * Fetch missing bars from Binance for a single gap window and write to Redis + MySQL.
 * Returns the number of bars written.
 */
async function fillGap(symbol, gapStartTs, gapEndTs) {
  // Fetch bars: startTime = gapStartTs + 1 bar, endTime = gapEndTs - 1 bar
  const startTime = gapStartTs + 60_000;
  const endTime   = gapEndTs   - 60_000;
  if (startTime > endTime) return 0;

  const limit = Math.min(Math.ceil((endTime - startTime) / 60_000) + 1, MAX_FILL_BARS);
  const url   = `${BINANCE_FAPI_KLINES}?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;

  let klines;
  try {
    const res = await binanceFetch(url, { signal: AbortSignal.timeout(8_000) }, 'barGapFill', symbol, 'gap-fill');
    if (!res.ok) {
      if (res.status === 418 || res.status === 429) {
        console.warn(`[barGapFill] ${symbol} rate-limited (${res.status}) — skipping gap`);
      }
      return 0;
    }
    klines = await res.json();
  } catch (err) {
    // binanceFetch throws with err.status=418 when soft-paused or IP-banned
    if (err.status === 418 || err.status === 429) {
      // Don't spam logs — just skip silently; periodic retry will handle it
      return 0;
    }
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
      console.warn(`[barGapFill] ${symbol} fetch error: ${err.message}`);
    }
    return 0;
  }

  if (!Array.isArray(klines) || klines.length === 0) return 0;

  const key     = `bars:1m:${symbol}`;
  const cutoff  = Date.now() - REDIS_TTL_MS;
  const pipe    = _redis.pipeline();
  const mysqlRows = [];

  for (const k of klines) {
    const ts       = Number(k[0]);
    const open     = Number(k[1]);
    const high     = Number(k[2]);
    const low      = Number(k[3]);
    const close    = Number(k[4]);
    const quoteVol = Number(k[7]);
    const buyQuote = Number(k[10]);

    // Skip synthetic bars
    if (open === high && high === low && low === close && quoteVol === 0) continue;

    const bar = {
      symbol,
      ts,
      market          : 'futures',
      open, high, low, close,
      priceChangePct  : open !== 0 ? (close - open) / open * 100 : 0,
      volatility      : open !== 0 ? (high  - low)  / open * 100 : 0,
      volumeUsdt      : quoteVol,
      buyVolumeUsdt   : buyQuote,
      sellVolumeUsdt  : quoteVol - buyQuote,
      deltaUsdt       : buyQuote - (quoteVol - buyQuote),
      tradeCount      : Number(k[8]),
      volumeSpikeRatio: null, fundingRate: null,
      oiValue: null, oiDelta: null,
      liqLongUsd: null, liqShortUsd: null,
      impulseScore: null, inPlayScore: null,
    };

    pipe.zremrangebyscore(key, ts, ts);            // evict stale same-ts entry
    pipe.zadd(key, ts, JSON.stringify(bar));
    mysqlRows.push(bar);
  }

  if (mysqlRows.length === 0) return 0;

  pipe.zremrangebyscore(key, 0, cutoff);
  pipe.zremrangebyrank(key, 0, -(MAX_REDIS_BARS + 1));
  await pipe.exec();

  // Write to MySQL
  if (_db && mysqlRows.length > 0) {
    try {
      const phs = mysqlRows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      const sql = `INSERT IGNORE INTO symbol_bars_1m
        (symbol,ts,market,open,high,low,close,price_change_pct,volatility,
         volume_usdt,buy_volume_usdt,sell_volume_usdt,delta_usdt,trade_count,
         volume_spike_ratio,funding_rate,oi_value,oi_delta,
         liq_long_usd,liq_short_usd,impulse_score,in_play_score)
        VALUES ${phs}`;
      const vals = mysqlRows.flatMap(b => [
        b.symbol, b.ts, b.market, b.open, b.high, b.low, b.close,
        b.priceChangePct, b.volatility, b.volumeUsdt, b.buyVolumeUsdt,
        b.sellVolumeUsdt, b.deltaUsdt, b.tradeCount, b.volumeSpikeRatio,
        b.fundingRate, b.oiValue, b.oiDelta, b.liqLongUsd, b.liqShortUsd,
        b.impulseScore, b.inPlayScore,
      ]);
      await _db.execute(sql, vals);
    } catch (err) {
      console.warn(`[barGapFill] ${symbol} MySQL write error: ${err.message}`);
    }
  }

  console.log(`[barGapFill] ${symbol}: filled ${mysqlRows.length} bars in gap ${new Date(gapStartTs).toISOString()} → ${new Date(gapEndTs).toISOString()}`);
  return mysqlRows.length;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { attach, start, stop, runGapFill };
