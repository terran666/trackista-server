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

const INTERVAL_MS    = 60_000;
const REDIS_TTL_MS   = parseInt(process.env.BARS_REDIS_TTL_MS  || String(48 * 3600 * 1000), 10);
const MAX_REDIS_BARS = parseInt(process.env.BARS_MAX_REDIS_BARS || '500', 10);
const SETTLE_OFFSET  = parseInt(process.env.BARS_SETTLE_OFFSET_MS || '5000', 10); // ms after :00

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
      }), 'EX', 120).catch(() => {});
    }
  }

  function start() {
    if (active) return;
    active    = true;
    startedAt = Date.now();

    const now       = Date.now();
    const nextBound = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    const delay     = nextBound - now + SETTLE_OFFSET;

    initialTimeoutId = setTimeout(() => {
      if (!active) return;
      tick();
      intervalId = setInterval(tick, INTERVAL_MS);
    }, delay);

    console.log(`[barAggregatorService] started — first tick in ~${Math.round(delay / 1000)}s`);
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
