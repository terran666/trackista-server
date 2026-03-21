'use strict';

// ─── Symbols Universe Builder ─────────────────────────────────────────────────
//
// Builds the filtered tracked-universe that drives wall monitoring.
//
// Philosophy: track symbols that are genuinely liquid and active — the same
// coins a trader would see on the TestPage screener.
//
// Data sources:
//   futures:tickers:all     — Binance 24h futures ticker data (quoteVolume, count)
//   metrics:${symbol}       — Spot collector metrics (activityScore, volumeUsdt60s)
//
// Redis keys written:
//   tracked:universe:filtered       — final list of symbols passing all filters
//   tracked:universe:meta           — full per-symbol metadata
//   tracked:futures:symbols         — futures-only list (subset of filtered)
//   tracked:spot:symbols            — spot list (same symbols if INCLUDE_SPOT_FOR_TRACKED_FUTURES)
//
// All keys have a 5-minute TTL so stale data expires automatically.
// ─────────────────────────────────────────────────────────────────────────────

const {
  TRACK_MIN_VOLUME_24H_USD,
  TRACK_MIN_ACTIVITY_SCORE,
  INCLUDE_SPOT_FOR_TRACKED_FUTURES,
  FUTURES_ALL_TICKERS_KEY,
  FUTURES_TRACKED_MAX_SYMBOLS,
  FUTURES_TRACKED_HARD_MAX_SYMBOLS,
  TRACKED_UNIVERSE_REFRESH_MS,
  FUTURES_FORCE_INCLUDE,
} = require('./densityFuturesConfig');

const UNIVERSE_TTL_S = Math.ceil(TRACKED_UNIVERSE_REFRESH_MS / 1000) * 5; // 5× refresh as TTL

// Redis keys for the universe
const UNIVERSE_KEYS = {
  filtered:       'tracked:universe:filtered',
  meta:           'tracked:universe:meta',
  futures:        'tracked:futures:symbols',
  spot:           'tracked:spot:symbols',
};

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Build and persist the tracked symbol universe.
 *
 * Called by the collector on startup and periodically thereafter.
 *
 * @param {import('ioredis').Redis} redis
 * @returns {Promise<{futures: string[], spot: string[], meta: object}>}
 */
async function buildAndPersistUniverse(redis) {
  const now = Date.now();
  const forceSet = new Set(FUTURES_FORCE_INCLUDE);

  // ── 1. Load futures tickers ───────────────────────────────────────────────
  const tickersRaw = await redis.get(FUTURES_ALL_TICKERS_KEY);
  const allTickers = safeParse(tickersRaw);
  if (!Array.isArray(allTickers) || allTickers.length === 0) {
    console.warn('[universe] futures:tickers:all not yet available — universe build skipped');
    return null;
  }

  // Build fast lookup: symbol → ticker
  const tickerMap = new Map();
  for (const t of allTickers) {
    if (t.symbol && t.symbol.endsWith('USDT')) {
      tickerMap.set(t.symbol, t);
    }
  }

  // ── 2. Filter by 24h volume lower-bound ──────────────────────────────────
  const volumeQualified = [];
  const STALE_TICKER_MS = 4 * 60 * 60 * 1000; // 4 hours — SETTLING/DELIVERING contracts have stale closeTime
  for (const [sym, t] of tickerMap) {
    const quoteVol = parseFloat(t.quoteVolume || '0');
    const isForce  = forceSet.has(sym);
    // Skip contracts that stopped trading (SETTLING, DELIVERING) — their ticker is stale
    if (!isForce && t.closeTime && Number(t.closeTime) < now - STALE_TICKER_MS) continue;
    if (!isForce && quoteVol < TRACK_MIN_VOLUME_24H_USD) continue;
    volumeQualified.push({ symbol: sym, quoteVol24h: quoteVol, tradeCount24h: parseInt(t.count || '0', 10), isForce });
  }

  // ── 3. Load spot metrics for activity gate (if configured) ────────────────
  let metricsMap = new Map();
  if (TRACK_MIN_ACTIVITY_SCORE > 0) {
    const pipeline = redis.pipeline();
    for (const item of volumeQualified) pipeline.get(`metrics:${item.symbol}`);
    const results = await pipeline.exec();
    for (let i = 0; i < volumeQualified.length; i++) {
      const raw = results[i][1];
      const m = safeParse(raw);
      if (m) metricsMap.set(volumeQualified[i].symbol, m);
    }
  }

  // ── 4. Apply activity filter ──────────────────────────────────────────────
  const maxSymbols = Math.min(FUTURES_TRACKED_MAX_SYMBOLS, FUTURES_TRACKED_HARD_MAX_SYMBOLS);
  const passed = [];
  for (const item of volumeQualified) {
    const m = metricsMap.get(item.symbol);
    const activityScore = m?.activityScore ?? null;
    if (TRACK_MIN_ACTIVITY_SCORE > 0 && !item.isForce && activityScore !== null && activityScore < TRACK_MIN_ACTIVITY_SCORE) {
      continue;
    }
    passed.push({
      ...item,
      activityScore,
      volumeUsdt60s:  m?.volumeUsdt60s  ?? null,
      tradeCount60s:  m?.tradeCount60s  ?? null,
      hasFutures:     true,
      hasSpot:        true,   // all USDT futures chains have a corresponding spot pair in most cases
      monitorFutures: true,
      monitorSpot:    INCLUDE_SPOT_FOR_TRACKED_FUTURES,
      passesVolumeFilter: true,
      passesActivityFilter: item.isForce || TRACK_MIN_ACTIVITY_SCORE === 0 || (activityScore !== null ? activityScore >= TRACK_MIN_ACTIVITY_SCORE : true),
      status:         'tracked',
      source:         'universe-builder',
      includedAt:     now,
    });
  }

  // Sort: force-includes first, then by 24h volume descending (biggest markets first)
  passed.sort((a, b) => {
    if (a.isForce && !b.isForce) return -1;
    if (!a.isForce && b.isForce)  return 1;
    return b.quoteVol24h - a.quoteVol24h;
  });

  // Cap at maxSymbols
  const finalList = passed.slice(0, maxSymbols);
  const futuresSymbols = finalList.map(i => i.symbol);
  const spotSymbols    = INCLUDE_SPOT_FOR_TRACKED_FUTURES ? [...futuresSymbols] : [];

  // ── 5. Build and write Redis payloads ─────────────────────────────────────
  const metaObj = {};
  for (const item of finalList) {
    metaObj[item.symbol] = {
      source:              item.source,
      quoteVol24h:         item.quoteVol24h,
      tradeCount24h:       item.tradeCount24h,
      activityScore:       item.activityScore,
      volumeUsdt60s:       item.volumeUsdt60s,
      hasFutures:          item.hasFutures,
      hasSpot:             item.hasSpot,
      monitorFutures:      item.monitorFutures,
      monitorSpot:         item.monitorSpot,
      passesVolumeFilter:  item.passesVolumeFilter,
      isForce:             item.isForce,
      includedAt:          item.includedAt,
    };
  }

  const filteredPayload = JSON.stringify({
    updatedAt:  now,
    count:      futuresSymbols.length,
    symbols:    futuresSymbols,
    filters: {
      minVolume24h:     TRACK_MIN_VOLUME_24H_USD,
      minActivityScore: TRACK_MIN_ACTIVITY_SCORE,
      maxSymbols,
    },
  });

  const metaPayload    = JSON.stringify(metaObj);
  const futuresPayload = JSON.stringify({ updatedAt: now, symbols: futuresSymbols });
  const spotPayload    = JSON.stringify({ updatedAt: now, symbols: spotSymbols });

  const pipeline = redis.pipeline();
  pipeline.set(UNIVERSE_KEYS.filtered, filteredPayload, 'EX', UNIVERSE_TTL_S);
  pipeline.set(UNIVERSE_KEYS.meta,     metaPayload,     'EX', UNIVERSE_TTL_S);
  pipeline.set(UNIVERSE_KEYS.futures,  futuresPayload,  'EX', UNIVERSE_TTL_S);
  pipeline.set(UNIVERSE_KEYS.spot,     spotPayload,     'EX', UNIVERSE_TTL_S);
  await pipeline.exec();

  console.log(
    `[universe] built — volume_qualified=${volumeQualified.length} passed_activity=${passed.length}` +
    ` final=${futuresSymbols.length} spot=${spotSymbols.length}` +
    ` symbols=[${futuresSymbols.slice(0, 6).join(',')}${futuresSymbols.length > 6 ? '...' : ''}]`,
  );

  return { futures: futuresSymbols, spot: spotSymbols, meta: metaObj };
}

module.exports = {
  buildAndPersistUniverse,
  UNIVERSE_KEYS,
};
