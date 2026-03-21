'use strict';

/**
 * derivativesContextService — polls Binance /fapi for funding rates and OI
 * for all tracked futures symbols, computes derivatives context, writes to Redis.
 *
 * Redis keys written:
 *   derivatives:<SYM>   — full computed context
 *   funding:<SYM>       — raw funding snapshot
 *   oi:<SYM>            — raw OI snapshot
 *
 * Liquidations are tracked via rolling accumulators fed by the futures WS proxy
 * listener (Phase 4). For now liq fields default to 0 unless data is injected.
 */

const { computeDerivativesContext } = require('../engines/moves/derivativesContextEngine');

const POLL_INTERVAL_MS  = parseInt(process.env.DERIVATIVES_POLL_INTERVAL_MS || '60000', 10); // 60s
const ENABLED           = process.env.DERIVATIVES_ENABLED !== 'false';
const BINANCE_FAPI      = 'https://fapi.binance.com';
const MAX_SYMBOLS       = parseInt(process.env.DERIVATIVES_MAX_SYMBOLS || '150', 10);
const OI_HISTORY_SLOTS  = 4; // enough for 5m delta (each slot = POLL_INTERVAL_MS)
const LIQ_TTL_MS        = 5 * 60 * 1000; // 5 min rolling window for liq accumulators

function createDerivativesContextService(redis) {
  /** @type {Map<string, number[]>} symbol → last N OI values */
  const oiHistory = new Map();
  /** @type {Map<string, {fundingRate:number, ts:number}>} */
  const fundingHistory = new Map();
  /** @type {Map<string, Array<{ts:number,long:number,short:number}>>} rolling liq events */
  const liquidationRolling = new Map();

  let intervalHandle  = null;
  let isRunning        = false;
  let startedAt        = null;
  let runCount         = 0;
  let errorsCount      = 0;
  let lastErrorMsg     = null;
  let totalLoopMs      = 0;
  let maxLoopMs        = 0;
  let lastSuccessTs    = null;
  let symbolsProcessed = 0;

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  /** Add a liquidation event — called externally when WS forceOrder fires */
  function recordLiquidation(symbol, side, usdValue, ts) {
    if (!liquidationRolling.has(symbol)) liquidationRolling.set(symbol, []);
    const arr = liquidationRolling.get(symbol);
    const now = ts || Date.now();
    arr.push({ ts: now, long: side === 'SELL' ? usdValue : 0, short: side === 'BUY' ? usdValue : 0 });
    // Trim old entries
    const cutoff = now - LIQ_TTL_MS;
    while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
  }

  function getLiqSums(symbol, windowMs) {
    const arr = liquidationRolling.get(symbol) || [];
    const cutoff = Date.now() - windowMs;
    let long = 0, short = 0;
    for (const e of arr) {
      if (e.ts >= cutoff) { long += e.long; short += e.short; }
    }
    return { long, short };
  }

  async function refreshSymbols() {
    const raw = await redis.get('symbols:active:usdt');
    if (!raw) return [];
    const parsed = tryParse(raw);
    const syms = Array.isArray(parsed) ? parsed : (parsed?.symbols ?? []);
    return syms.slice(0, MAX_SYMBOLS);
  }

  async function tick() {
    if (!isRunning) return;
    const nowMs  = Date.now();
    const tickTs = nowMs;
    runCount++;

    try {
      const symbols = await refreshSymbols();
      if (!symbols.length) return;

      // Batch fetch: premiumIndex (funding + mark), openInterest
      // Binance allows bulk: /fapi/v1/premiumIndex (no symbol = all)
      let premiumAll, oiResults;
      try {
        premiumAll = await fetchJson(`${BINANCE_FAPI}/fapi/v1/premiumIndex`);
      } catch (e) {
        console.warn('[derivativesContextService] premiumIndex fetch failed:', e.message);
        premiumAll = [];
      }

      // Build map of funding by symbol
      const fundingMap = {};
      if (Array.isArray(premiumAll)) {
        for (const item of premiumAll) {
          if (item.symbol && item.lastFundingRate != null) {
            fundingMap[item.symbol] = {
              fundingRate : parseFloat(item.lastFundingRate),
              markPrice   : parseFloat(item.markPrice),
              indexPrice  : parseFloat(item.indexPrice),
              nextFundingTime: item.nextFundingTime,
            };
          }
        }
      }

      const pipeline = redis.pipeline();
      symbolsProcessed = 0;

      for (const sym of symbols) {
        // Fetch OI individually (no bulk endpoint for all symbols in one call)
        let oiValue = null;
        try {
          const oiData = await fetchJson(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${sym}`);
          oiValue = oiData.openInterest ? parseFloat(oiData.openInterest) * (fundingMap[sym]?.markPrice || 1) : null;
        } catch {
          // non-critical
        }

        // OI history for delta
        if (!oiHistory.has(sym)) oiHistory.set(sym, []);
        const oiArr = oiHistory.get(sym);
        const oiValuePrev = oiArr.length > 0 ? oiArr[oiArr.length - 1] : null;
        if (oiValue != null) {
          oiArr.push(oiValue);
          if (oiArr.length > OI_HISTORY_SLOTS) oiArr.shift();
        }

        // Funding
        const fData      = fundingMap[sym] || {};
        const fundingRate = fData.fundingRate ?? null;
        const prevFunding = fundingHistory.get(sym)?.fundingRate ?? null;
        if (fundingRate != null) fundingHistory.set(sym, { fundingRate, ts: nowMs });

        // Liquidations from rolling accumulator
        const liq1m = getLiqSums(sym, 60_000);
        const liq5m = getLiqSums(sym, 300_000);

        // Compute context
        const ctx = computeDerivativesContext({
          fundingRate,
          fundingRatePrev      : prevFunding,
          oiValue,
          oiValuePrev,
          liquidationLongUsd1m : liq1m.long,
          liquidationShortUsd1m: liq1m.short,
          liquidationLongUsd5m : liq5m.long,
          liquidationShortUsd5m: liq5m.short,
          directionBias        : 'neutral',
        });

        const payload = {
          symbol         : sym,
          ts             : nowMs,
          markPrice      : fData.markPrice   ?? null,
          indexPrice     : fData.indexPrice  ?? null,
          nextFundingTime: fData.nextFundingTime ?? null,
          ...ctx,
        };

        pipeline.set(`derivatives:${sym}`, JSON.stringify(payload));
        pipeline.set(`funding:${sym}`, JSON.stringify({ symbol: sym, fundingRate, ts: nowMs }));
        if (oiValue != null) {
          pipeline.set(`oi:${sym}`, JSON.stringify({ symbol: sym, oiValue, ts: nowMs }));
        }

        symbolsProcessed++;
      }

      const loopMs = Date.now() - tickTs;
      totalLoopMs += loopMs;
      if (loopMs > maxLoopMs) maxLoopMs = loopMs;
      lastSuccessTs = Date.now();

      // Update service health state (unified format)
      pipeline.set('debug:derivatives-service:state', JSON.stringify({
        serviceName     : 'derivativesContextService',
        startedAt,
        lastRunTs       : nowMs,
        lastSuccessTs,
        runCount,
        symbolsProcessed,
        avgLoopMs       : Math.round(totalLoopMs / runCount),
        maxLoopMs,
        errorsCount,
        lastErrorMessage: lastErrorMsg,
        status          : errorsCount > 20 ? 'warning' : 'ok',
      }));

      await pipeline.exec();

    } catch (err) {
      errorsCount++;
      lastErrorMsg = err.message;
      console.error('[derivativesContextService] tick error:', err.message);
      await redis.set('debug:derivatives-service:state', JSON.stringify({
        serviceName     : 'derivativesContextService',
        startedAt,
        lastRunTs       : nowMs,
        lastSuccessTs,
        runCount,
        errorsCount,
        lastErrorMessage: err.message,
        status          : 'warning',
      }), 'EX', 120).catch(() => {});
    }
  }

  function start() {
    if (!ENABLED) {
      console.log('[derivativesContextService] Disabled (DERIVATIVES_ENABLED=false)');
      return;
    }
    if (isRunning) return;
    isRunning = true;
    startedAt = Date.now();
    // Initial run after short delay to let other services stabilize
    setTimeout(tick, 5000);
    intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
    console.log(`[derivativesContextService] Started (interval=${POLL_INTERVAL_MS}ms)`);
  }

  function stop() {
    isRunning = false;
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    console.log('[derivativesContextService] Stopped');
  }

  return { start, stop, recordLiquidation };
}

module.exports = { createDerivativesContextService };
