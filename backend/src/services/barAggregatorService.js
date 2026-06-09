'use strict';

/**
 * barAggregatorService — runs every 60s (aligned to clock-minute boundary + 5s
 * to let collector flush the last second's data), reads Redis state per futures
 * symbol and writes 1-minute bars to MySQL + Redis Sorted Set.
 *
 * Redis keys read:
 *   tracked:futures:symbols   — symbol list
 *   metrics:<SYM>             — OHLC + volume (open60s/high60s/low60s added in collector)
 *   signal:<SYM>              — volumeSpikeRatio, impulseScore, inPlayScore
 *   derivatives:<SYM>         — fundingRate, oiValue, liquidations
 *
 * Redis keys written:
 *   bars:1m:<SYM>             — Sorted Set (score=ts, member=JSON bar)
 *   debug:bar-aggregator-service:state
 *
 * MySQL table written:
 *   symbol_bars_1m            — permanent bar history
 */

const { binanceFetch } = require('../utils/binanceRestLogger');

const INTERVAL_MS    = 60_000;
const REDIS_TTL_MS   = parseInt(process.env.BARS_REDIS_TTL_MS  || String(48 * 3600 * 1000), 10);
const MAX_REDIS_BARS = parseInt(process.env.BARS_MAX_REDIS_BARS || '500', 10);
const SETTLE_OFFSET  = parseInt(process.env.BARS_SETTLE_OFFSET_MS || '5000', 10); // ms after :00

const BINANCE_FAPI_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
// Backfill: fetch last N 1m bars per symbol to fill gaps after restart.
// limit=200 → weight=2 per call. Stagger: 250ms → ~4 req/s → 480 weight/min (safe under 2400/min).
const BACKFILL_LIMIT      = 1500; // covers full 25h Redis window
const BACKFILL_STAGGER_MS = 1500; // up to 2 fetches/symbol (weight=20) → 40 req/min × 20 = 800 weight/min

function createBarAggregatorService(redis, db) {
  const prevOiMap = new Map(); // symbol → last known oiValue

  let initialTimeoutId = null;
  let intervalId       = null;
  let active           = false;
  let startedAt        = null;
  let runCount         = 0;
  let errorsCount      = 0;
  let lastErrorMsg     = null;
  let totalLoopMs      = 0;
  let maxLoopMs        = 0;
  let lastSuccessTs    = null;

  // Lifetime counters (reset on restart)
  let mysqlWriteCount         = 0;
  let redisWriteCount         = 0;
  let missingMetricsCount     = 0;
  let missingSignalCount      = 0;
  let missingDerivativesCount = 0;
  let missingOhlcCount        = 0;
  let incompleteBarsCount     = 0;

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function buildBar(sym, barTs, metrics, signal, derivatives) {
    const open  = metrics.open60s;
    const high  = metrics.high60s;
    const low   = metrics.low60s;
    const close = metrics.lastPrice;

    if (!open || !close) return null;

    // Fallback for high/low: symbols with no trade data yet
    const safeHigh = high  != null ? high  : close;
    const safeLow  = low   != null ? low   : close;

    const priceChangePct = open !== 0 ? ((close - open) / open) * 100 : 0;
    const volatility     = open !== 0 ? ((safeHigh - safeLow) / open) * 100 : 0;

    const oiValue    = derivatives?.oiValue ?? null;
    const prevOi     = prevOiMap.get(sym) ?? null;
    const oiDelta    = (oiValue != null && prevOi != null) ? oiValue - prevOi : null;
    if (oiValue != null) prevOiMap.set(sym, oiValue);

    return {
      symbol          : sym,
      ts              : barTs,
      market          : 'futures',
      open,
      high            : safeHigh,
      low             : safeLow,
      close,
      priceChangePct,
      volatility,
      volumeUsdt      : metrics.volumeUsdt60s      ?? 0,
      buyVolumeUsdt   : metrics.buyVolumeUsdt60s   ?? 0,
      sellVolumeUsdt  : metrics.sellVolumeUsdt60s  ?? 0,
      deltaUsdt       : metrics.deltaUsdt60s       ?? 0,
      tradeCount      : metrics.tradeCount60s      ?? 0,
      volumeSpikeRatio: signal?.volumeSpikeRatio60s  ?? null,
      fundingRate     : derivatives?.fundingRate     ?? null,
      oiValue,
      oiDelta,
      liqLongUsd      : derivatives?.liquidationLongUsd1m  ?? null,
      liqShortUsd     : derivatives?.liquidationShortUsd1m ?? null,
      impulseScore    : signal?.impulseScore  ?? null,
      inPlayScore     : signal?.inPlayScore   ?? null,
    };
  }

  async function tick() {
    if (!active) return;
    const tickTs = Date.now();
    // Bar covers the just-completed minute
    const barTs = Math.floor(tickTs / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
    runCount++;

    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      const _parsed    = tryParse(rawSymbols);
      const symbols    = Array.isArray(_parsed) ? _parsed : (_parsed?.symbols ?? []);

      if (!symbols.length) {
        console.warn('[barAggregatorService] No symbols:active:usdt in Redis');
        return;
      }

      // Prune `prevOiMap` so delisted symbols don't accumulate stale OI.
      const _activeSet = new Set(symbols);
      for (const sym of prevOiMap.keys()) {
        if (!_activeSet.has(sym)) prevOiMap.delete(sym);
      }

      // Batch-read all keys for all symbols in one pipeline round-trip
      const rPipe = redis.pipeline();
      for (const sym of symbols) {
        rPipe.get(`metrics:${sym}`);
        rPipe.get(`signal:${sym}`);
        rPipe.get(`derivatives:${sym}`);
        rPipe.get(`kline:futures:${sym}:1m:last`); // fallback when aggTrade is blocked
      }
      const pResults = await rPipe.exec();

      const METRICS_STALE_MS = 120_000; // 2 minutes — if older, use kline fallback
      const bars = [];
      let localMissingMetrics      = 0;
      let localMissingSignal       = 0;
      let localMissingDerivatives  = 0;
      let localMissingOhlc         = 0;

      for (let i = 0; i < symbols.length; i++) {
        const sym         = symbols[i];
        const base        = i * 4;
        let   metrics     = tryParse(pResults[base + 0]?.[1]);
        const signal      = tryParse(pResults[base + 1]?.[1]);
        const derivatives = tryParse(pResults[base + 2]?.[1]);
        const klineLast   = tryParse(pResults[base + 3]?.[1]);

        // When aggTrade WS is blocked, metrics.updatedAt becomes stale.
        // Fall back to kline REST data for OHLC so bars stay accurate.
        if (metrics && klineLast && klineLast.k) {
          const metricsAge = Date.now() - (metrics.updatedAt || 0);
          if (metricsAge > METRICS_STALE_MS) {
            const k = klineLast.k;
            metrics = {
              ...metrics,
              lastPrice : Number(k.c),
              open60s   : Number(k.o),
              high60s   : Number(k.h),
              low60s    : Number(k.l),
              updatedAt : klineLast.E || Date.now(),
            };
          }
        }

        if (!metrics) {
          localMissingMetrics++;
          missingMetricsCount++;
          continue; // can't build bar without price data
        }
        if (!signal) {
          localMissingSignal++;
          missingSignalCount++;
          // signal missing → bar incomplete but still writable
        }
        if (!derivatives) {
          localMissingDerivatives++;
          missingDerivativesCount++;
          // derivatives missing → bar incomplete but still writable
        }

        if (!metrics.open60s || !metrics.lastPrice) {
          localMissingOhlc++;
          missingOhlcCount++;
          incompleteBarsCount++;
          continue; // can't build valid OHLC
        }

        const bar = buildBar(sym, barTs, metrics, signal, derivatives);
        if (!bar) {
          localMissingOhlc++;
          missingOhlcCount++;
          incompleteBarsCount++;
          continue;
        }
        bars.push(bar);
      }

      // ── Write to MySQL ──────────────────────────────────────────
      if (db && bars.length > 0) {
        const placeholders = bars.map(() =>
          '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).join(',');
        const sql = `INSERT IGNORE INTO symbol_bars_1m
          (symbol,ts,market,open,high,low,close,price_change_pct,volatility,
           volume_usdt,buy_volume_usdt,sell_volume_usdt,delta_usdt,trade_count,
           volume_spike_ratio,funding_rate,oi_value,oi_delta,
           liq_long_usd,liq_short_usd,impulse_score,in_play_score)
          VALUES ${placeholders}`;
        const values = bars.flatMap(b => [
          b.symbol, b.ts, b.market,
          b.open, b.high, b.low, b.close,
          b.priceChangePct, b.volatility,
          b.volumeUsdt, b.buyVolumeUsdt, b.sellVolumeUsdt, b.deltaUsdt, b.tradeCount,
          b.volumeSpikeRatio, b.fundingRate, b.oiValue, b.oiDelta,
          b.liqLongUsd, b.liqShortUsd, b.impulseScore, b.inPlayScore,
        ]);
        await db.execute(sql, values);
        mysqlWriteCount += bars.length;
      }

      // ── Write to Redis Sorted Set ───────────────────────────────
      if (bars.length > 0) {
        const wPipe = redis.pipeline();
        const cutoff = tickTs - REDIS_TTL_MS;
        for (const bar of bars) {
          const key = `bars:1m:${bar.symbol}`;
          wPipe.zremrangebyscore(key, bar.ts, bar.ts);     // evict stale same-ts entry
          wPipe.zadd(key, bar.ts, JSON.stringify(bar));
          wPipe.zremrangebyscore(key, 0, cutoff);          // drop expired
          wPipe.zremrangebyrank(key, 0, -(MAX_REDIS_BARS + 1)); // cap size
        }
        await wPipe.exec();
        redisWriteCount += bars.length;
      }

      // ── Spot bars ───────────────────────────────────────────────
      const rawSpotSymbols = await redis.get('spot:symbols:active:usdt');
      const _parsedSpot    = tryParse(rawSpotSymbols);
      const spotSymbols    = Array.isArray(_parsedSpot) ? _parsedSpot : (_parsedSpot?.symbols ?? []);

      let spotBarsWritten = 0;
      if (spotSymbols.length > 0) {
        const sPipe = redis.pipeline();
        for (const sym of spotSymbols) {
          sPipe.get(`spot:metrics:${sym}`);
          sPipe.get(`spot:signal:${sym}`);
        }
        const sResults = await sPipe.exec();

        const spotBars = [];
        for (let i = 0; i < spotSymbols.length; i++) {
          const sym     = spotSymbols[i];
          const metrics = tryParse(sResults[i * 2]?.[1]);
          const signal  = tryParse(sResults[i * 2 + 1]?.[1]);

          if (!metrics || !metrics.open60s || !metrics.lastPrice) continue;

          const open  = metrics.open60s;
          const high  = metrics.high60s  != null ? metrics.high60s  : metrics.lastPrice;
          const low   = metrics.low60s   != null ? metrics.low60s   : metrics.lastPrice;
          const close = metrics.lastPrice;
          const priceChangePct = open !== 0 ? ((close - open) / open) * 100 : 0;
          const volatility     = open !== 0 ? ((high  - low)  / open) * 100 : 0;

          spotBars.push({
            symbol          : sym,
            ts              : barTs,
            market          : 'spot',
            open, high, low, close,
            priceChangePct,
            volatility,
            volumeUsdt      : metrics.volumeUsdt60s      ?? 0,
            buyVolumeUsdt   : metrics.buyVolumeUsdt60s   ?? 0,
            sellVolumeUsdt  : metrics.sellVolumeUsdt60s  ?? 0,
            deltaUsdt       : metrics.deltaUsdt60s       ?? 0,
            tradeCount      : metrics.tradeCount60s      ?? 0,
            volumeSpikeRatio: signal?.volumeSpikeRatio60s ?? null,
            fundingRate     : null,
            oiValue         : null,
            oiDelta         : null,
            liqLongUsd      : null,
            liqShortUsd     : null,
            impulseScore    : signal?.impulseScore  ?? null,
            inPlayScore     : signal?.inPlayScore   ?? null,
          });
        }

        if (db && spotBars.length > 0) {
          const phs     = spotBars.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
          const spotSql = `INSERT IGNORE INTO symbol_bars_1m
            (symbol,ts,market,open,high,low,close,price_change_pct,volatility,
             volume_usdt,buy_volume_usdt,sell_volume_usdt,delta_usdt,trade_count,
             volume_spike_ratio,funding_rate,oi_value,oi_delta,
             liq_long_usd,liq_short_usd,impulse_score,in_play_score)
            VALUES ${phs}`;
          const sVals = spotBars.flatMap(b => [
            b.symbol, b.ts, b.market,
            b.open, b.high, b.low, b.close,
            b.priceChangePct, b.volatility,
            b.volumeUsdt, b.buyVolumeUsdt, b.sellVolumeUsdt, b.deltaUsdt, b.tradeCount,
            b.volumeSpikeRatio, b.fundingRate, b.oiValue, b.oiDelta,
            b.liqLongUsd, b.liqShortUsd, b.impulseScore, b.inPlayScore,
          ]);
          await db.execute(spotSql, sVals);
          mysqlWriteCount += spotBars.length;
        }

        if (spotBars.length > 0) {
          const swPipe = redis.pipeline();
          const cutoff = tickTs - REDIS_TTL_MS;
          for (const bar of spotBars) {
            const key = `bars:1m:spot:${bar.symbol}`;
            swPipe.zremrangebyscore(key, bar.ts, bar.ts);   // evict stale same-ts entry
            swPipe.zadd(key, bar.ts, JSON.stringify(bar));
            swPipe.zremrangebyscore(key, 0, cutoff);
            swPipe.zremrangebyrank(key, 0, -(MAX_REDIS_BARS + 1));
          }
          await swPipe.exec();
          redisWriteCount += spotBars.length;
          spotBarsWritten  = spotBars.length;
        }
      }

      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs = Date.now();

      console.log(
        `[barAggregatorService] tick barTs=${new Date(barTs).toISOString()}` +
        ` futures=${bars.length}/${symbols.length}` +
        ` spot=${spotBarsWritten}/${spotSymbols.length}` +
        ` missing(metrics=${localMissingMetrics} ohlc=${localMissingOhlc})` +
        ` loopMs=${loopMs}`,
      );

      await redis.set('debug:bar-aggregator-service:state', JSON.stringify({
        serviceName            : 'barAggregatorService',
        startedAt,
        lastRunTs              : tickTs,
        lastSuccessTs,
        runCount,
        symbolsProcessed       : bars.length,
        avgLoopMs              : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        redisWriteCount,
        mysqlWriteCount,
        errorsCount,
        lastErrorMessage       : lastErrorMsg,
        incompleteBarsCount,
        missingMetricsCount,
        missingSignalCount,
        missingDerivativesCount,
        missingOhlcCount,
        status                 : errorsCount > 10 ? 'warning' : 'ok',
      }), 'EX', 120);

    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[barAggregatorService] tick error:', err.message);
      await redis.set('debug:bar-aggregator-service:state', JSON.stringify({
        serviceName     : 'barAggregatorService',
        startedAt,
        lastRunTs       : tickTs,
        lastSuccessTs,
        runCount,
        errorsCount,
        lastErrorMessage: err.message,
        status          : 'warning',
      }), 'EX', 120).catch(e => console.warn('[barAgg] redis status set error:', e.message));
    }
  }

  function scheduleNext() {
    if (!active) return;
    const now       = Date.now();
    const nextBound = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    const delay     = nextBound - now + SETTLE_OFFSET;
    initialTimeoutId = setTimeout(() => {
      tick();
      scheduleNext();
    }, delay);
  }

  // ── Startup gap-fill: fetch recent 1m bars from Binance and write
  // any that are missing from Redis. Runs once after start(), staggered
  // to stay within Binance rate limits. Best-effort — errors are swallowed.
  async function backfillSymbol(sym) {
    try {
      const redisKey = `bars:1m:${sym}`;
      const existing = await redis.zrange(redisKey, 0, -1);
      const existingTsList = existing.map(r => { try { return JSON.parse(r).ts; } catch { return null; } }).filter(Boolean);
      const existingTs = new Set(existingTsList);

      // Find oldest bar in Redis to determine how far back we need to go.
      // Fetch in two chunks if needed: startTime..+1500 then remainder up to now.
      // Each fetch: limit=1500, weight=10. Two fetches = weight 20 per symbol.
      // Use reduce (not spread) to avoid V8 stack overflow with large arrays
      const oldestTs  = existingTsList.length > 0
        ? existingTsList.reduce((a, b) => a < b ? a : b)
        : Date.now() - REDIS_TTL_MS;
      const newestTs  = Date.now();
      const windowMs  = newestTs - oldestTs;
      const chunkMs   = BACKFILL_LIMIT * 60_000; // 1500 min = 90000000 ms

      // Build fetch URLs — one or two chunks to cover the full Redis window
      const fetchUrls = [];
      if (windowMs <= chunkMs) {
        fetchUrls.push(`${BINANCE_FAPI_KLINES}?symbol=${sym}&interval=1m&limit=${BACKFILL_LIMIT}`);
      } else {
        // Two chunks: oldest → oldest+1500min, then last 1500min
        fetchUrls.push(`${BINANCE_FAPI_KLINES}?symbol=${sym}&interval=1m&startTime=${oldestTs}&limit=${BACKFILL_LIMIT}`);
        fetchUrls.push(`${BINANCE_FAPI_KLINES}?symbol=${sym}&interval=1m&limit=${BACKFILL_LIMIT}`);
      }

      const allKlines = [];
      for (const url of fetchUrls) {
        const res = await binanceFetch(url, { signal: AbortSignal.timeout(8000) }, 'barBackfill', sym, 'backfill');
        if (!res.ok) continue;
        const klines = await res.json();
        if (Array.isArray(klines)) allKlines.push(...klines);
      }
      if (allKlines.length === 0) return;

      const pipe    = redis.pipeline();
      const cutoff  = Date.now() - REDIS_TTL_MS;
      let   filled  = 0;
      const mysqlRows = [];

      for (const k of allKlines) {
        const ts = k[0];
        if (existingTs.has(ts)) continue; // already present — skip
        const open  = Number(k[1]);
        const high  = Number(k[2]);
        const low   = Number(k[3]);
        const close = Number(k[4]);
        const quoteVol   = Number(k[7]);
        const buyQuote   = Number(k[10]);
        const bar = {
          symbol: sym, ts, market: 'futures',
          open, high, low, close,
          priceChangePct  : open !== 0 ? (close - open) / open * 100 : 0,
          volatility      : open !== 0 ? (high  - low)  / open * 100 : 0,
          volumeUsdt      : quoteVol,
          buyVolumeUsdt   : buyQuote,
          sellVolumeUsdt  : quoteVol - buyQuote,
          deltaUsdt       : buyQuote - (quoteVol - buyQuote),
          tradeCount      : Number(k[8]),
          volumeSpikeRatio: null, fundingRate: null,
          oiValue: null,  oiDelta: null,
          liqLongUsd: null, liqShortUsd: null,
          impulseScore: null, inPlayScore: null,
        };
        pipe.zremrangebyscore(redisKey, ts, ts);
        pipe.zadd(redisKey, ts, JSON.stringify(bar));
        filled++;
        mysqlRows.push(bar);
      }

      if (filled === 0) return;

      pipe.zremrangebyscore(redisKey, 0, cutoff); // only drop truly expired bars
      // NOTE: no zremrangebyrank here — backfill adds old bars that would be
      // immediately evicted by rank trim. Regular tick() handles rank capping.
      await pipe.exec();

      if (db && mysqlRows.length > 0) {
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
        await db.execute(sql, vals).catch(() => {});
      }

      console.log(`[barBackfill] ${sym}: filled ${filled} missing bars`);
    } catch (_) { /* best-effort */ }
  }

  async function runBackfill() {
    const rawSymbols = await redis.get('symbols:active:usdt').catch(() => null);
    const _parsed    = tryParse(rawSymbols);
    const symbols    = Array.isArray(_parsed) ? _parsed : (_parsed?.symbols ?? []);
    if (!symbols.length) {
      console.warn('[barBackfill] no symbols — skipping');
      return;
    }
    console.log(`[barBackfill] starting for ${symbols.length} symbols (stagger=${BACKFILL_STAGGER_MS}ms)`);
    for (let i = 0; i < symbols.length; i++) {
      if (!active) break;
      await backfillSymbol(symbols[i]);
      if (i + 1 < symbols.length) await new Promise(r => setTimeout(r, BACKFILL_STAGGER_MS));
    }
    console.log('[barBackfill] done');
  }

  function start() {
    if (active) return;
    active    = true;
    startedAt = Date.now();
    scheduleNext();

    const now       = Date.now();
    const nextBound = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    const delay     = nextBound - now + SETTLE_OFFSET;
    console.log(`[barAggregatorService] started — first tick in ~${Math.round(delay / 1000)}s`);

    // Run backfill 90s after start to let symbols load and first tick complete
    setTimeout(() => { if (active) runBackfill().catch(() => {}); }, 90_000);
  }

  function stop() {
    active = false;
    if (initialTimeoutId) { clearTimeout(initialTimeoutId);  initialTimeoutId = null; }
    if (intervalId)       { clearInterval(intervalId);       intervalId       = null; }
    console.log('[barAggregatorService] stopped');
  }

  return { start, stop };
}

module.exports = { createBarAggregatorService };
