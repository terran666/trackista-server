'use strict';

/**
 * correlationService — computes Pearson correlation of tracked symbols to BTCUSDT.
 *
 * Data source: bars:1m:<SYM> Redis Sorted Sets (already collected by barAggregatorService).
 * BTC returns are computed once per config and reused across all symbols.
 *
 * Redis keys written:
 *   correlation:btc:current:<SYM>:<TF>:<WINDOW>  — single correlation record
 *
 * Configs (MVP):
 *   1m  window 20 — scheduler every 60s
 *   1m  window 50 — scheduler every 60s
 *   5m  window 20 — scheduler every 60s
 *   5m  window 50 — scheduler every 60s
 *   15m window 20 — scheduler every 60s
 */

const { computeSimpleReturns, pearsonCorrelation, classifyCorrelation, groupBarsToCloses } = require('./correlationMath');

const ENABLED      = process.env.CORRELATION_ENABLED !== 'false';
const INTERVAL_MS  = parseInt(process.env.CORRELATION_INTERVAL_MS  || '60000', 10);
const MAX_SYMBOLS  = parseInt(process.env.CORRELATION_MAX_SYMBOLS  || '400',   10);
const BTC_SYMBOL   = 'BTCUSDT';

// Each config: tf label, return window (# of TF-candles), 1m-bar multiplier, bars to fetch, stale threshold
// Long-TF configs (1h, 12h, 24h) use mult=60 (hourly closes); 4h/6h use native candle size.
const CONFIGS = [
  { tf: '1m',  window: 20, mult:   1, barsNeeded:   21, staleMs:  3 * 60 * 1000 },
  { tf: '1m',  window: 50, mult:   1, barsNeeded:   51, staleMs:  3 * 60 * 1000 },
  { tf: '5m',  window: 20, mult:   5, barsNeeded:  105, staleMs: 10 * 60 * 1000 },
  { tf: '5m',  window: 50, mult:   5, barsNeeded:  255, staleMs: 10 * 60 * 1000 },
  { tf: '15m', window: 20, mult:  15, barsNeeded:  315, staleMs: 30 * 60 * 1000 },
  // ── Long-period configs
  { tf: '1h',  window: 20, mult:  60, barsNeeded: 1260, staleMs:  2 * 60 * 60 * 1000 },
  { tf: '4h',  window:  5, mult: 240, barsNeeded: 1440, staleMs:  8 * 60 * 60 * 1000 },
  { tf: '6h',  window:  3, mult: 360, barsNeeded: 1440, staleMs: 12 * 60 * 60 * 1000 },
  { tf: '12h', window: 12, mult:  60, barsNeeded:  780, staleMs: 24 * 60 * 60 * 1000 },
  { tf: '24h', window: 24, mult:  60, barsNeeded: 1500, staleMs: 48 * 60 * 60 * 1000 },
];

// Read this many 1m bars per symbol (covers the largest config).
const MAX_BARS_NEEDED = Math.max(...CONFIGS.map(c => c.barsNeeded));

// Min bars present to accept a symbol (allow up to 5 missing bars)
const MIN_BARS_TOLERANCE = 5;

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function createCorrelationService(redis) {
  let intervalHandle = null;
  let isRunning      = false;
  let runCount       = 0;
  let errorsCount    = 0;
  let lastErrorMsg   = null;
  let startedAt      = null;
  let lastRunMs      = 0;

  async function tick() {
    if (!isRunning) return;
    runCount++;
    const nowMs  = Date.now();
    const tickTs = nowMs;

    try {
      // 1. Tracked symbols
      const rawSyms = await redis.get('symbols:active:usdt');
      const allSyms = tryParse(rawSyms) || [];
      const symbols = allSyms
        .filter(s => s !== BTC_SYMBOL)
        .slice(0, MAX_SYMBOLS);

      if (!symbols.length) return;

      // 2. Read BTC + all symbol bars in one pipeline
      const readPipe = redis.pipeline();
      readPipe.zrange(`bars:1m:${BTC_SYMBOL}`, -MAX_BARS_NEEDED, -1);
      for (const sym of symbols) {
        readPipe.zrange(`bars:1m:${sym}`, -MAX_BARS_NEEDED, -1);
      }
      const readResults = await readPipe.exec();

      // 3. Parse & sort BTC bars
      const btcRaw  = readResults[0]?.[1];
      if (!Array.isArray(btcRaw) || btcRaw.length < 21) {
        console.warn('[correlationService] Not enough BTC bars, skipping tick');
        return;
      }
      const btcBars = btcRaw.map(r => tryParse(r)).filter(Boolean);
      btcBars.sort((a, b) => a.ts - b.ts);

      // 4. Pre-compute BTC returns for each config — REUSED across all symbols
      const btcReturnsByConfig = CONFIGS.map(cfg => {
        const bars   = btcBars.slice(-cfg.barsNeeded);
        const closes = groupBarsToCloses(bars, cfg.mult);
        return computeSimpleReturns(closes);
      });

      // 5. Per-symbol calculation
      const writePipe = redis.pipeline();
      let computed = 0;

      for (let si = 0; si < symbols.length; si++) {
        const sym    = symbols[si];
        const rawArr = readResults[si + 1]?.[1];
        if (!Array.isArray(rawArr) || rawArr.length < 21) continue;

        const symBars = rawArr.map(r => tryParse(r)).filter(Boolean);
        symBars.sort((a, b) => a.ts - b.ts);

        for (let ci = 0; ci < CONFIGS.length; ci++) {
          const cfg        = CONFIGS[ci];
          const btcReturns = btcReturnsByConfig[ci];
          if (!btcReturns || btcReturns.length < cfg.window) continue;

          // Accept symbol if it has enough bars (with small tolerance)
          const bars = symBars.slice(-cfg.barsNeeded);
          if (bars.length < cfg.barsNeeded - MIN_BARS_TOLERANCE) continue;

          const closes    = groupBarsToCloses(bars, cfg.mult);
          const symReturns = computeSimpleReturns(closes);
          if (symReturns.length < cfg.window) continue;

          // Align to same length (take last N of each)
          const n        = Math.min(btcReturns.length, symReturns.length, cfg.window);
          const btcSlice = btcReturns.slice(-n);
          const symSlice = symReturns.slice(-n);

          const r              = pearsonCorrelation(btcSlice, symSlice);
          const classification = classifyCorrelation(r); // signed r → correct direction

          const record = {
            symbol             : sym,
            btcSymbol          : BTC_SYMBOL,
            timeframe          : cfg.tf,
            window             : cfg.window,
            correlationToBtc   : r != null ? parseFloat(Math.abs(r).toFixed(4)) : null,
            sampleSize         : n,
            ...classification,
            updatedAt          : nowMs,
            staleFlag          : false,
          };

          // TTL = 2× stale threshold
          writePipe.set(
            `correlation:btc:current:${sym}:${cfg.tf}:${cfg.window}`,
            JSON.stringify(record),
            'EX', Math.ceil(cfg.staleMs * 2 / 1000),
          );
          computed++;
        }
      }

      await writePipe.exec();

      lastRunMs = Date.now() - tickTs;
      console.log(`[correlationService] tick #${runCount}: ${symbols.length} symbols, ${computed} records, ${lastRunMs}ms`);

    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[correlationService] tick error:', err.message);
    }
  }

  function start() {
    if (!ENABLED) {
      console.log('[correlationService] Disabled (CORRELATION_ENABLED=false)');
      return;
    }
    if (isRunning) return;
    isRunning = true;
    startedAt = Date.now();
    setTimeout(tick, 15_000); // first run after 15s to let bars accumulate
    intervalHandle = setInterval(tick, INTERVAL_MS);
    console.log(`[correlationService] Started (interval=${INTERVAL_MS}ms, maxSymbols=${MAX_SYMBOLS})`);
  }

  function stop() {
    isRunning = false;
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    console.log('[correlationService] Stopped');
  }

  function getStatus() {
    return { isRunning, startedAt, runCount, errorsCount, lastErrorMsg, lastRunMs };
  }

  return { start, stop, getStatus };
}

module.exports = { createCorrelationService };
