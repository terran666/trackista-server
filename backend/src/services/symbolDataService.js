'use strict';

/**
 * symbolDataService — unified data aggregator for GET /api/symbol/:symbol/data.
 *
 * Reads 8 Redis sources in one pipeline, aggregates bars, computes activity
 * states and market context, returns a single structured payload.
 *
 * Redis sources:
 *   price:<SYM>
 *   metrics:<SYM>
 *   signal:<SYM>
 *   funding:current:<SYM>
 *   derivatives:<SYM>
 *   move:live:<SYM>
 *   correlation:btc:current:<SYM>:5m:20
 *   bars:1m:<SYM>  (last 60 bars)
 */

const { aggregateBars }    = require('./symbolDataAggregation');
const { computeActivity }  = require('./symbolActivityStateService');
const { computeContext }   = require('./symbolContextService');

const CORR_TF              = '5m';
const CORR_WINDOW          = 20;
const MAX_BARS             = 60;
const METRICS_STALE_MS     = 5  * 60 * 1000;
const FUNDING_STALE_MS     = 10 * 60 * 1000;

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Round to d decimal places; return null for null/NaN. */
function r(n, d = 4) {
  if (n == null || !isFinite(n)) return null;
  return parseFloat(n.toFixed(d));
}

// ─────────────────────────────────────────────────────────────────────────────

async function buildSymbolData(redis, symbol) {
  const sym   = symbol.toUpperCase();
  const nowMs = Date.now();

  // ── 1. Batch read all Redis sources in one round-trip ─────────────
  const pipe = redis.pipeline();
  pipe.get(`price:${sym}`);                                                         // 0
  pipe.get(`metrics:${sym}`);                                                       // 1
  pipe.get(`signal:${sym}`);                                                        // 2
  pipe.get(`funding:current:${sym}`);                                               // 3
  pipe.get(`derivatives:${sym}`);                                                   // 4
  pipe.get(`move:live:${sym}`);                                                     // 5
  pipe.get(`correlation:btc:current:${sym}:${CORR_TF}:${CORR_WINDOW}`);           // 6
  pipe.zrange(`bars:1m:${sym}`, -MAX_BARS, -1);                                    // 7

  const results       = await pipe.exec();
  const priceRaw      = results[0][1];
  const metrics       = tryParse(results[1][1]);
  const signal        = tryParse(results[2][1]);
  const funding       = tryParse(results[3][1]);
  const derivatives   = tryParse(results[4][1]);
  const moveLive      = tryParse(results[5][1]);
  const correlation   = tryParse(results[6][1]);
  const barsRaw       = results[7][1];

  // ── 2. Parse + sort bars ──────────────────────────────────────────
  let bars = [];
  if (Array.isArray(barsRaw)) {
    bars = barsRaw.map(r => tryParse(r)).filter(Boolean);
    bars.sort((a, b) => a.ts - b.ts);
  }
  const hasBars     = bars.length >= 5;
  const partialData = !metrics || !hasBars;

  // ── 3. Direct fields from metrics / signal ────────────────────────
  const currentPrice = metrics?.lastPrice   ?? parseFloat(priceRaw) ?? null;
  const delta1m      = metrics?.priceChangePct60s ?? null;
  const volume1m     = metrics?.volumeUsdt60s     ?? null;
  const trades1m     = metrics?.tradeCount60s     ?? null;
  const buyVolume1m  = metrics?.buyVolumeUsdt60s  ?? null;
  const sellVolume1m = metrics?.sellVolumeUsdt60s ?? null;
  const deltaUsdt1m  = metrics?.deltaUsdt60s      ?? null;

  const relativeVolume1m = signal?.volumeSpikeRatio60s ?? null;
  const impulseScore     = signal?.impulseScore        ?? null;
  const inPlayScore      = signal?.inPlayScore         ?? null;
  const impulseDirection = signal?.impulseDirection    ?? null;
  const signalConfidence = signal?.signalConfidence    ?? null;

  // ── 4. Bar aggregations ───────────────────────────────────────────
  const barAgg = hasBars ? aggregateBars(bars) : null;

  // trades relative (uses avgTrades1m from bars as baseline)
  const relativeTrades1m = (trades1m != null && barAgg?.avgTrades1m)
    ? trades1m / barAgg.avgTrades1m
    : null;

  // ── 5. Activity states ────────────────────────────────────────────
  const activity = computeActivity({
    delta1m,
    delta5m          : barAgg?.delta5m   ?? null,
    relativeVolume1m,
    relativeTrades1m,
    moveLive,
    volumeRunStartTs : barAgg?.volumeRunStartTs ?? null,
    nowMs,
  });

  // ── 6. Market context / mode / phase / strength ───────────────────
  const context = computeContext({
    priceState       : activity.priceState,
    volumeState      : activity.volumeState,
    tradesState      : activity.tradesState,
    deltaUsdt1m,
    impulseScore,
    inPlayScore,
    relativeVolume1m,
    relativeTrades1m,
    priceStartedAt   : activity.priceStartedAt,
    volumeStartedAt  : activity.volumeStartedAt,
    tradesStartedAt  : activity.tradesStartedAt,
  });

  // ── 7. Stale flags ────────────────────────────────────────────────
  const staleFlag    = !metrics || (nowMs - (metrics.updatedAt || 0)) > METRICS_STALE_MS;
  const fundingStale = funding  ? (nowMs - (funding.updatedAt  || 0)) > FUNDING_STALE_MS : null;

  // ── 8. Assemble payload ───────────────────────────────────────────
  return {
    symbol,
    updatedAt   : nowMs,
    staleFlag,
    partialData,

    price: {
      currentPrice  : r(currentPrice, 8),
      delta1m       : r(delta1m,  4),
      delta5m       : r(barAgg?.delta5m,  4),
      delta15m      : r(barAgg?.delta15m, 4),
    },

    flow: {
      volume1m         : r(volume1m,  2),
      volume5m         : r(barAgg?.volume5m,  2),
      relativeVolume1m : r(relativeVolume1m, 4),
      relativeVolume5m : r(barAgg?.relativeVolume5m, 4),
      avgVolume1m      : r(barAgg?.avgVolume1m, 2),
      trades1m,
      trades5m         : barAgg?.trades5m  ?? null,
      relativeTrades1m : r(relativeTrades1m, 4),
      relativeTrades5m : r(barAgg?.relativeTrades5m, 4),
      avgTrades1m      : barAgg?.avgTrades1m != null ? Math.round(barAgg.avgTrades1m) : null,
      volatility5m     : r(barAgg?.volatility5m,  4),
      volatility15m    : r(barAgg?.volatility15m, 4),
      buyVolume1m      : r(buyVolume1m,  2),
      sellVolume1m     : r(sellVolume1m, 2),
      deltaUsdt1m      : r(deltaUsdt1m,  2),
    },

    signal: {
      impulseScore,
      inPlayScore,
      impulseDirection,
      signalConfidence,
      tradeAcceleration : signal?.tradeAcceleration     ?? null,
      deltaImbalancePct : signal?.deltaImbalancePct60s  ?? null,
    },

    funding: funding ? {
      fundingCurrent  : funding.fundingRateCurrent,
      fundingPrevious : funding.fundingRatePrevious,
      fundingDirection: funding.fundingDirection,
      fundingAbs      : funding.fundingAbs,
      nextFundingTime : funding.nextFundingTime,
      fundingChangedAt: funding.fundingChangedAt,
      markPrice       : funding.markPrice,
      indexPrice      : funding.indexPrice,
      staleFlag       : fundingStale,
    } : null,

    derivatives: derivatives ? {
      oiValue            : derivatives.oiValue,
      oiDelta5m          : derivatives.oiDelta5m,
      oiDeltaPct5m       : derivatives.oiDeltaPct5m,
      oiBias             : derivatives.oiBias,
      derivativesBias    : derivatives.derivativesBias,
      derivativesScore   : derivatives.derivativesScore,
      liquidationLong1m  : derivatives.liquidationLongUsd1m,
      liquidationShort1m : derivatives.liquidationShortUsd1m,
    } : null,

    correlation: correlation ? {
      value     : correlation.correlationToBtc,
      bias      : correlation.correlationBias,
      badgeText : correlation.badgeText,
      colorHint : correlation.colorHint,
      timeframe : correlation.timeframe,
      window    : correlation.window,
      staleFlag : correlation.staleFlag,
    } : null,

    activity,

    state: {
      marketContext : context.marketContext,
      mode          : context.mode,
      phaseSequence : context.phaseSequence,
      strengthScore : context.strengthScore,
    },

    context: {
      lines: context.contextLines,
    },
  };
}

module.exports = { buildSymbolData };
