'use strict';

/**
 * screenerSymbolsService
 *
 * Builds enriched symbol rows for GET /api/screener/symbols.
 * All data from Redis — no Binance calls, no MySQL.
 *
 * Pipeline per symbol (single round-trip):
 *   metrics:<SYM>     i*5 + 0  — live 60s metrics
 *   signal:<SYM>      i*5 + 1  — live 60s signal
 *   derivatives:<SYM> i*5 + 2  — OI, funding, liquidations context
 *   move:live:<SYM>   i*5 + 3  — active move event state
 *   presignal:<SYM>   i*5 + 4  — readiness / pre-signal
 *
 * Plus two single reads:
 *   symbols:active:usdt   — universe list
 *   futures:tickers:all   — 24h liquidity context
 */

const SORT_FIELD_MAP = {
  priceChange : r => Math.abs(r.priceChangePct),
  volume      : r => r.volumeUsdt60s,
  trades      : r => r.tradeCount60s,
  spike       : r => r.volumeSpikeRatio60s,
  impulse     : r => r.impulseScore,
  readiness   : r => r.adjustedReadinessScore ?? 0,
  vol24h      : r => r.quoteVol24h ?? 0,
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function nf(v, decimals = null) {
  if (v == null) return null;
  const f = parseFloat(v);
  if (isNaN(f)) return null;
  return decimals != null ? parseFloat(f.toFixed(decimals)) : f;
}

function computeDataStatus(hasMetrics, hasSignal, hasDerivatives) {
  if (!hasMetrics)                     return 'fail';
  if (!hasSignal || !hasDerivatives)   return 'warning';
  return 'ok';
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * @param {object} redis      — ioredis client
 * @param {object} [opts]     — filter + sort options from query params
 * @returns {Promise<{rows, totalScanned, totalMatched}>}
 */
async function buildSymbolRows(redis, opts = {}) {
  const {
    priceDir,
    priceMinPct,
    priceMaxPct,
    volumeGrowthMin,
    tradesMin,
    turnoverMin,
    vol24hMin,
    sortBy   = 'priceChange',
    sortDir  = 'desc',
    limit    = 200,
  } = opts;

  const nowMs = Date.now();

  // ── Universe ──────────────────────────────────────────────────────────────
  const symbolsRaw = await redis.get('symbols:active:usdt');
  if (!symbolsRaw) return { rows: [], totalScanned: 0, totalMatched: 0 };
  const symbols = tryParse(symbolsRaw);
  if (!Array.isArray(symbols) || !symbols.length) {
    return { rows: [], totalScanned: 0, totalMatched: 0 };
  }

  // ── 24h liquidity map (always fetched for quoteVol24h + tradeCount24h) ────
  const tickersRaw = await redis.get('futures:tickers:all');
  const tickers    = tryParse(tickersRaw) || [];
  const tickerMap  = new Map();
  for (const t of tickers) {
    if (t.symbol) tickerMap.set(t.symbol, t);
  }

  // ── Batch read — 5 keys per symbol ───────────────────────────────────────
  const pipe = redis.pipeline();
  for (const sym of symbols) {
    pipe.get(`metrics:${sym}`);       // i*5 + 0
    pipe.get(`signal:${sym}`);        // i*5 + 1
    pipe.get(`derivatives:${sym}`);   // i*5 + 2
    pipe.get(`move:live:${sym}`);     // i*5 + 3
    pipe.get(`presignal:${sym}`);     // i*5 + 4
  }
  const raw = await pipe.exec();

  // ── Filter thresholds ────────────────────────────────────────────────────
  const dir          = typeof priceDir === 'string' ? priceDir : 'any';
  const pMin         = priceMinPct    != null ? parseFloat(priceMinPct)    : null;
  const pMax         = priceMaxPct    != null ? parseFloat(priceMaxPct)    : null;
  const neededSpike  = volumeGrowthMin != null
    ? (1 + parseFloat(volumeGrowthMin) / 100)
    : null;
  const trMin        = tradesMin      != null ? parseInt(tradesMin, 10)    : null;
  const turnMin      = turnoverMin    != null ? parseFloat(turnoverMin)    : null;
  const v24Min       = vol24hMin      != null ? parseFloat(vol24hMin)      : null;

  const rows = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym         = symbols[i];
    const metrics     = tryParse(raw[i * 5    ]?.[1]);
    const signal      = tryParse(raw[i * 5 + 1]?.[1]);
    const derivatives = tryParse(raw[i * 5 + 2]?.[1]);
    const moveLive    = tryParse(raw[i * 5 + 3]?.[1]);
    const presignal   = tryParse(raw[i * 5 + 4]?.[1]);
    const ticker      = tickerMap.get(sym) || null;

    const hasMetrics     = metrics     != null;
    const hasSignal      = signal      != null;
    const hasDerivatives = derivatives != null;

    // symbols without realtime data are excluded entirely
    if (!hasMetrics) continue;

    // ── Live 60s ─────────────────────────────────────────────────────────
    const pricePct  = nf(metrics.priceChangePct60s, 4) ?? 0;
    const absPct    = Math.abs(pricePct);
    const vol60s    = nf(metrics.volumeUsdt60s)    ?? 0;
    const tr60s     = nf(metrics.tradeCount60s)    ?? 0;
    const spike     = nf(signal?.volumeSpikeRatio60s, 3) ?? 0;
    const impulse   = nf(signal?.impulseScore, 1)  ?? 0;
    const inPlay    = nf(signal?.inPlayScore, 1)   ?? 0;
    const impDir    = signal?.impulseDirection     ?? 'neutral';

    // ── 24h context ───────────────────────────────────────────────────────
    const quoteVol24h   = ticker ? nf(ticker.quoteVolume) : null;
    const tradeCount24h = ticker ? nf(ticker.count)       : null;
    const pctChg24h     = ticker ? nf(ticker.priceChangePercent, 4) : null;

    // ── Filter pass ───────────────────────────────────────────────────────
    if (dir === 'up'   && pricePct <= 0) continue;
    if (dir === 'down' && pricePct >= 0) continue;
    if (pMin         !== null && absPct  < pMin)  continue;
    if (pMax         !== null && absPct  > pMax)  continue;
    if (neededSpike  !== null && spike   < neededSpike) continue;
    if (trMin        !== null && tr60s   < trMin)  continue;
    if (turnMin      !== null && vol60s  < turnMin) continue;
    if (v24Min       !== null && (quoteVol24h ?? 0) < v24Min) continue;

    // ── Derivatives ───────────────────────────────────────────────────────
    const fundingRate = derivatives ? nf(derivatives.fundingRate) : null;
    const oiValue     = derivatives ? nf(derivatives.oiValue)     : null;
    const oiDelta     = derivatives ? nf(derivatives.oiDelta5m)   : null;

    // ── Move event ────────────────────────────────────────────────────────
    const moveEventState = moveLive?.bestStatus    ?? null;
    const currentMovePct = moveLive ? nf(moveLive.bestMovePct, 4) : null;

    // ── Presignal ─────────────────────────────────────────────────────────
    const adjustedReadinessScore = presignal ? nf(presignal.adjustedReadinessScore) : null;
    const readinessLabel         = presignal?.readinessLabel ?? null;

    // ── Freshness ─────────────────────────────────────────────────────────
    const freshnessMs = metrics.updatedAt != null ? (nowMs - metrics.updatedAt) : null;

    rows.push({
      symbol                 : sym,
      market                 : 'futures',

      lastPrice              : nf(metrics.lastPrice) ?? 0,

      priceChangePct         : pricePct,
      priceChangePctWindow   : '60s',

      volumeUsdt60s          : vol60s,
      tradeCount60s          : tr60s,
      buyVolumeUsdt60s       : nf(metrics.buyVolumeUsdt60s)   ?? 0,
      sellVolumeUsdt60s      : nf(metrics.sellVolumeUsdt60s)  ?? 0,
      deltaUsdt60s           : nf(metrics.deltaUsdt60s)       ?? 0,

      volumeSpikeRatio60s    : spike,
      impulseScore           : impulse,
      impulseDirection       : impDir,
      inPlayScore            : inPlay,

      quoteVol24h            : quoteVol24h,
      tradeCount24h          : tradeCount24h,
      priceChangePct24h      : pctChg24h,

      fundingRate            : fundingRate,
      oiValue                : oiValue,
      oiDelta                : oiDelta,

      adjustedReadinessScore : adjustedReadinessScore,
      readinessLabel         : readinessLabel,

      moveEventState         : moveEventState,
      currentMovePct         : currentMovePct,

      hasMetrics,
      hasSignal,
      hasDerivatives,
      dataStatus             : computeDataStatus(hasMetrics, hasSignal, hasDerivatives),
      freshnessMs,
    });
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  const sortFn = SORT_FIELD_MAP[sortBy] || SORT_FIELD_MAP.priceChange;
  const mult   = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => mult * (sortFn(a) - sortFn(b)));

  // ── Slice ─────────────────────────────────────────────────────────────────
  const limitNum    = Math.min(parseInt(limit, 10) || 200, 500);
  const totalMatched = rows.length;

  return {
    rows         : rows.slice(0, limitNum),
    totalScanned : symbols.length,
    totalMatched,
  };
}

module.exports = { buildSymbolRows };
