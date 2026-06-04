'use strict';

// ─── Symbols Universe Builder v2 ──────────────────────────────────────────────
//
// Builds the tracked density universe using four distinct categories:
//
//   CORE         — force-include symbols (BTC, ETH, SOL, XRP, …)
//   WALL_ANOMALY — symbols with anomalous walls vs their own depth/liquidity
//   MOMENTUM     — symbols with volume/price spikes, even if no big walls
//   LIQUIDITY    — top 24h turnover symbols not captured above
//
// densityScore = max(wallRankScore, momentumScore, liquidityScore)
//
// Redis keys written:
//   tracked:universe:filtered     — backward-compat list + filters
//   tracked:universe:meta         — full per-symbol metadata
//   tracked:futures:symbols       — futures symbols list (backward compat)
//   tracked:spot:symbols          — spot symbols list (backward compat)
//   density:score:{symbol}        — per-symbol score breakdown (TTL 5 min)
//   density:symbols:ranked        — ordered list with score+reason (TTL 5 min)
//
// ─────────────────────────────────────────────────────────────────────────────

const {
  TRACK_MIN_VOLUME_24H_USD,
  TRACK_MIN_TRADE_COUNT_24H,
  TRACK_MIN_ACTIVITY_SCORE,
  INCLUDE_SPOT_FOR_TRACKED_FUTURES,
  FUTURES_ALL_TICKERS_KEY,
  FUTURES_TRACKED_MAX_SYMBOLS,
  FUTURES_TRACKED_HARD_MAX_SYMBOLS,
  TRACKED_UNIVERSE_REFRESH_MS,
  FUTURES_FORCE_INCLUDE,
  FUTURES_WALL_THRESHOLDS,
  WALL_POWER_SOFT_MIN,
  // Category limits
  DENSITY_CORE_LIMIT,
  DENSITY_WALL_ANOMALY_LIMIT,
  DENSITY_MOMENTUM_LIMIT,
  DENSITY_LIQUIDITY_LIMIT,
  // Wall rank sub-weights
  WALL_SCORE_NORMALIZED_W,
  WALL_SCORE_COUNT_W,
  WALL_SCORE_NEAR_PRICE_W,
  WALL_SCORE_LIFETIME_W,
  WALL_SCORE_REFRESH_W,
  // Momentum sub-weights
  MOMENTUM_VOL_SPIKE_W,
  MOMENTUM_TRADE_SPIKE_W,
  MOMENTUM_PRICE_MOVE_W,
  MOMENTUM_TAKER_W,
  MOMENTUM_VOLATILITY_W,
  // Adaptive threshold
  WALL_DEPTH_RATIO,
  WALL_ANOMALY_MIN_NORM,
  MOMENTUM_MIN_SCORE,
  // Score Redis keys
  DENSITY_SCORE_KEY_PREFIX,
  DENSITY_RANKED_KEY,
  DENSITY_SCORE_TTL_S,
  // Volatility filter
  DENSITY_STABLE_BASE_BLACKLIST,
  DENSITY_MIN_VOLATILITY_4H_PCT,
  DENSITY_MIN_VOLATILITY_24H_PCT,
  DENSITY_VOLATILITY_BREAKOUT_1H_PCT,
  DENSITY_PRICE_MOVE_BREAKOUT_15M_PCT,
  DENSITY_VOLUME_SPIKE_OVERRIDE,
  // Activity gate (pump/dump/volatility)
  DENSITY_ACTIVITY_GATE_ENABLED,
  DENSITY_ACTIVITY_PUMP_PCT_24H,
  DENSITY_ACTIVITY_DUMP_PCT_24H,
  DENSITY_ACTIVITY_VOLATILITY_PCT,
  DENSITY_ACTIVITY_PRICE_MOVE_15M_PCT,
  DENSITY_ACTIVITY_KEEP_TOP_TRADED,
  DENSITY_ACTIVITY_KEEP_WALL_COINS,
  DENSITY_MIN_UNIVERSE_SIZE,
  // Tier + hot candidates
  DENSITY_TIER1_SYMBOLS,
  HOT_CANDIDATE_EXPIRY_MS,
  HOT_VOLUME_SPIKE_MIN,
  HOT_TRADE_SPIKE_MIN,
  DENSITY_HOT_CANDIDATES_KEY,
} = require('./densityFuturesConfig');

const UNIVERSE_TTL_S  = Math.ceil(TRACKED_UNIVERSE_REFRESH_MS / 1000) * 5; // 5× refresh as TTL
const UNIVERSE_VOL_REF = parseFloat(process.env.UNIVERSE_VOL_24H_REF || '1000000000'); // $1B ref

// Redis keys for backward compat
const UNIVERSE_KEYS = {
  filtered: 'tracked:universe:filtered',
  meta:     'tracked:universe:meta',
  futures:  'tracked:futures:symbols',
  spot:     'tracked:spot:symbols',
};

// ─── Hot candidates in-memory registry ───────────────────────────────────────
//
// Tracks symbols that spiked into "HOT" status.  Each entry is a Unix ms
// timestamp recording *when* the symbol first became hot.  The TTL is
// HOT_CANDIDATE_EXPIRY_MS (default 15 min).  Entries are pruned every cycle
// and the resulting map is persisted to Redis so the backend can serve badges.
//
// Survives across universe rebuild calls within the same process; resets on
// collector restart (acceptable — symbols will re-enter on next spike).
//
const _hotCandidates = new Map(); // symbol → hotSince (ms)

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Static USD wall threshold for a symbol (fallback when no orderbook data).
 */
function _staticThreshold(symbol) {
  return FUTURES_WALL_THRESHOLDS[symbol] ?? FUTURES_WALL_THRESHOLDS._default;
}

/**
 * Compute normalWallUsdForSymbol using Вариант 2:
 *   normalWallUsd = max(avgSidedDepthWithin1Pct * WALL_DEPTH_RATIO, staticThreshold)
 *
 * avgSidedDepthWithin1Pct = (sum bids+asks USD within 1% of midPrice) / 2
 *
 * If the orderbook is unavailable, falls back to the static per-symbol threshold.
 *
 * @param {object|null} ob       Parsed futures:orderbook:{symbol} snapshot
 * @param {string}      symbol
 * @returns {number}
 */
function _computeNormalWallUsd(ob, symbol) {
  const staticFallback = _staticThreshold(symbol);
  if (!ob || !ob.midPrice || ob.midPrice <= 0) return staticFallback;

  const midPrice = ob.midPrice;
  const cap1Pct  = midPrice * 0.01; // 1% of mid
  let   totalUsd = 0;

  for (const level of (ob.bids || [])) {
    const dist = midPrice - (level.price ?? 0);
    if (dist >= 0 && dist <= cap1Pct) totalUsd += level.usdValue ?? 0;
  }
  for (const level of (ob.asks || [])) {
    const dist = (level.price ?? 0) - midPrice;
    if (dist >= 0 && dist <= cap1Pct) totalUsd += level.usdValue ?? 0;
  }

  const avgSidedDepth = totalUsd / 2;
  const computed      = avgSidedDepth * WALL_DEPTH_RATIO;
  return Math.max(computed, staticFallback);
}

/**
 * Compute wallRankScore ∈ [0, 1].
 *
 *   wallRankScore =
 *     WALL_SCORE_NORMALIZED_W * normalizedWallScore   (how anomalous vs symbol's depth)
 *   + WALL_SCORE_COUNT_W      * confirmedCountScore   (≥5 confirmed walls = 1.0)
 *   + WALL_SCORE_NEAR_PRICE_W * nearPriceScore        (fraction of walls within 1%)
 *   + WALL_SCORE_LIFETIME_W   * lifetimeScore         (avg lifetime ≥ 5 min = 1.0)
 *   + WALL_SCORE_REFRESH_W    * refreshScore          (avg refillCount ≥ 3 = 1.0)
 *
/**
 * Compute wallAnomalyScore (replaces _computeWallRankScore) ∈ [0, 1].
 *
 * Uses bestWallPower from the v3 adaptive wall algorithm, optionally boosted
 * by the count of significant walls (wallPower >= 0.65).
 *
 *   score = bestWallPower + (significantWallCount > 1 ? significantWallCount × 0.03 : 0)
 *   capped at 1.0
 *
 * @param {object} item   item from passed[] — must have ._bestWallPower, ._significantWallCount
 * @returns {number}
 */
function _computeWallAnomalyScore(item) {
  const bestWallPower        = item._bestWallPower        ?? 0;
  const significantWallCount = item._significantWallCount ?? 0;
  if (bestWallPower <= 0) return 0;
  if (significantWallCount > 1) {
    return parseFloat(Math.min(bestWallPower + significantWallCount * 0.03, 1).toFixed(5));
  }
  return parseFloat(bestWallPower.toFixed(5));
}

/**
 * Compute momentumScore ∈ [0, 1].
 *
 *   momentumScore =
 *     MOMENTUM_VOL_SPIKE_W   * volumeSpikeScore    (spike vs 24h avg/min, 10× = 1.0)
 *   + MOMENTUM_TRADE_SPIKE_W * tradeCountSpike     (spike vs 24h avg/min, 10× = 1.0)
 *   + MOMENTUM_PRICE_MOVE_W  * priceMoveScore      (abs(priceChange24h) / 10, 10% = 1.0)
 *   + MOMENTUM_TAKER_W       * takerImbalance      (0 in Этап 1)
 *   + MOMENTUM_VOLATILITY_W  * volatilityScore     ((H-L)/open, 10% range = 1.0)
 *
 * Stores intermediate values on item for the score payload:
 *   item._volumeSpike, item._tradeSpike, item._priceChangePct
 *
 * @param {object} item
 * @returns {number}
 */
function _computeMomentumScore(item) {
  // Volume spike: current 60s volume vs 24h average per minute
  const avgVolPerMin = item.quoteVol24h / (24 * 60);
  const volSpikeRaw  = (avgVolPerMin > 0 && item.volumeUsdt60s != null)
    ? item.volumeUsdt60s / avgVolPerMin
    : 1;
  item._volumeSpike = parseFloat(volSpikeRaw.toFixed(2));
  // Score: ratio 1 = baseline (no spike). 10× above avg = 1.0.
  const volumeSpikeScore = Math.min(Math.max(0, (volSpikeRaw - 1) / 9), 1);

  // Trade count spike: current 60s trades vs 24h avg per minute
  const avgTradesPerMin  = item.tradeCount24h / (24 * 60);
  const tradeSpikeRaw    = (avgTradesPerMin > 0 && item.tradeCount60s != null)
    ? item.tradeCount60s / avgTradesPerMin
    : 1;
  item._tradeSpike = parseFloat(tradeSpikeRaw.toFixed(2));
  const tradeCountSpikeScore = Math.min(Math.max(0, (tradeSpikeRaw - 1) / 9), 1);

  // Price move: 24h priceChangePercent (10% = 1.0)
  const priceChangePct = item.priceChangePct24h ?? 0;
  item._priceChangePct = parseFloat(priceChangePct.toFixed(2));
  const priceMoveScore = Math.min(Math.abs(priceChangePct) / 10, 1);

  // Volatility: (high - low) / open range (10% range = 1.0)
  const open       = item.openPrice24h  ?? 0;
  const rangeRatio = open > 0
    ? (item.highPrice24h - item.lowPrice24h) / open
    : 0;
  const volatilityScore = Math.min(rangeRatio / 0.10, 1);

  // Taker imbalance — not yet available from 24h ticker
  const takerImbalanceScore = 0;

  return parseFloat((
    MOMENTUM_VOL_SPIKE_W   * volumeSpikeScore       +
    MOMENTUM_TRADE_SPIKE_W * tradeCountSpikeScore   +
    MOMENTUM_PRICE_MOVE_W  * priceMoveScore         +
    MOMENTUM_TAKER_W       * takerImbalanceScore    +
    MOMENTUM_VOLATILITY_W  * volatilityScore
  ).toFixed(5));
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
  const stableBlacklistSet = new Set(DENSITY_STABLE_BASE_BLACKLIST);
  const stableExcluded     = [];   // symbols excluded by stable blacklist
  const volatilityExcluded = [];   // symbols excluded by low-volatility filter
  const activityExcluded   = [];   // symbols excluded by pump/dump/volatility gate
  const heldOut            = new Map(); // symbol → full item removed by a gate (for min-size relax fallback)

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

  // ── 2. Filter by 24h volume + trade-count lower-bounds (AND-gate) ─────────
  const volumeQualified = [];
  const belowThreshold  = [];   // eligible coins that fail ONLY the volume/trade thresholds — parked for the min-universe volume relax (2b)
  const STALE_TICKER_MS = 4 * 60 * 60 * 1000; // 4 hours — SETTLING/DELIVERING contracts have stale closeTime
  for (const [sym, t] of tickerMap) {
    const quoteVol   = parseFloat(t.quoteVolume || '0');
    const tradeCount = parseInt(t.count || '0', 10);
    const isForce    = forceSet.has(sym);
    // Skip contracts that stopped trading (SETTLING, DELIVERING) — their ticker is stale
    if (!isForce && t.closeTime && Number(t.closeTime) < now - STALE_TICKER_MS) continue;
    // Stable blacklist — always exclude, no override (even force-include cannot
    // bypass). Checked BEFORE the threshold so stable coins never leak into the
    // belowThreshold relax pool.
    const baseAsset = sym.replace(/USDT$/, '');
    if (stableBlacklistSet.has(baseAsset)) {
      const hi   = parseFloat(t.highPrice || '0');
      const lo   = parseFloat(t.lowPrice  || '0');
      const mid  = (hi + lo) / 2;
      const vol24h = mid > 0 ? parseFloat(((hi - lo) / mid * 100).toFixed(3)) : 0;
      stableExcluded.push({
        symbol:           sym,
        reason:           'STABLE_BLACKLIST',
        volatility1hPct:  null,
        volatility4hPct:  null,
        volatility24hPct: vol24h,
        quoteVolume24h:   quoteVol,
        updatedAt:        now,
      });
      continue;
    }
    const candidate = {
      symbol:          sym,
      quoteVol24h:     quoteVol,
      tradeCount24h:   tradeCount,
      isForce,
      // Ticker fields needed for momentumScore
      priceChangePct24h: parseFloat(t.priceChangePercent || '0'),
      highPrice24h:      parseFloat(t.highPrice   || '0'),
      lowPrice24h:       parseFloat(t.lowPrice    || '0'),
      openPrice24h:      parseFloat(t.openPrice   || '0'),
    };
    // AND-gate: both 24h volume and 24h trade count must clear their minimums.
    // Coins that fail are NOT discarded — they are parked in belowThreshold so
    // the min-universe volume relax (2b) can pull the most-traded ones back in
    // when the market is too thin to reach DENSITY_MIN_UNIVERSE_SIZE.
    const belowVol   = !isForce && quoteVol   < TRACK_MIN_VOLUME_24H_USD;
    const belowTrade = !isForce && TRACK_MIN_TRADE_COUNT_24H > 0 && tradeCount < TRACK_MIN_TRADE_COUNT_24H;
    if (belowVol || belowTrade) {
      belowThreshold.push(candidate);
      continue;
    }
    volumeQualified.push(candidate);
  }

  // ── 2b. Min-universe volume relax (layer 1) ───────────────────────────────
  //
  // If the strict AND-gate qualified fewer than DENSITY_MIN_UNIVERSE_SIZE coins
  // (genuinely thin / quiet market), reduce filtering: admit the most-traded
  // sub-threshold coins until the floor is reached. They flow through the full
  // enrichment + scoring pipeline like any other candidate and are flagged
  // (_relaxedVolume) so the downstream activity / volatility gates keep them in
  // rather than dropping them again.
  if (volumeQualified.length < DENSITY_MIN_UNIVERSE_SIZE && belowThreshold.length > 0) {
    const need    = DENSITY_MIN_UNIVERSE_SIZE - volumeQualified.length;
    const relaxIn = belowThreshold
      .sort((a, b) => (b.tradeCount24h ?? 0) - (a.tradeCount24h ?? 0))
      .slice(0, need);
    for (const item of relaxIn) {
      item._relaxedVolume = true;
      volumeQualified.push(item);
    }
    if (relaxIn.length > 0) {
      console.log(`[universe] volume relax: only ${volumeQualified.length - relaxIn.length} coins cleared the volume/trade AND-gate — admitted ${relaxIn.length} top-traded sub-threshold coins to reach floor=${DENSITY_MIN_UNIVERSE_SIZE} (${relaxIn.map(i => i.symbol).join(',')})`);
    }
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
    if (TRACK_MIN_ACTIVITY_SCORE > 0 && !item.isForce && !item._relaxedVolume && activityScore !== null && activityScore < TRACK_MIN_ACTIVITY_SCORE) {
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
      passesVolumeFilter: !item._relaxedVolume,
      passesActivityFilter: item.isForce || item._relaxedVolume || TRACK_MIN_ACTIVITY_SCORE === 0 || (activityScore !== null ? activityScore >= TRACK_MIN_ACTIVITY_SCORE : true),
      status:         'tracked',
      source:         'universe-builder',
      includedAt:     now,
    });
  }

  // ── 4b. Fetch walls + orderbook for all candidates (one combined pipeline) ────
  //
  // walls    → maxWallUsd, _walls (array of confirmed wall objects for scoring)
  // orderbook → normalWallUsd (adaptive per-symbol depth baseline via Вариант 2)
  {
    const combinedPipe = redis.pipeline();
    for (const item of passed) {
      combinedPipe.get(`futures:walls:${item.symbol}`);
      combinedPipe.get(`futures:orderbook:${item.symbol}`);
    }
    const results = await combinedPipe.exec();

    for (let i = 0; i < passed.length; i++) {
      const wallsRaw = results[i * 2]?.[1];
      const obRaw    = results[i * 2 + 1]?.[1];

      // Parse walls — support both old (bare array) and new (object with .walls) payload formats
      const wallsData = safeParse(wallsRaw);
      const walls     = Array.isArray(wallsData) ? wallsData : (wallsData?.walls || []);

      // v3 top-level aggregates (present in new payload format)
      passed[i].maxWallUsd            = wallsData?.bestWallUsd
        ?? walls.reduce((m, w) => Math.max(m, w.usdValue ?? w.sizeUsdt ?? 0), 0);
      passed[i]._walls                = walls;
      passed[i]._significantWallCount = wallsData?.significantWallCount ?? 0;
      passed[i]._bestWallPower        = wallsData?.bestWallPower        ?? 0;
      passed[i]._bestWallUsd          = wallsData?.bestWallUsd          ?? 0;
      // Best wall object: find the wall whose wallPower matches the reported bestWallPower
      passed[i]._bestWall             = walls.find(w => w.wallPower === wallsData?.bestWallPower) ?? null;

      // Compute normalWallUsd from orderbook (Вариант 2) with static fallback
      const ob = safeParse(obRaw);
      passed[i].normalWallUsd = _computeNormalWallUsd(ob, passed[i].symbol);
    }
  }
  // ── 4b-bis. Fetch 1m bars for volatility computation ────────────────────────
  //
  // bars:1m:{symbol} is a Sorted Set (score=ts, member=JSON bar) written by the
  // backend barAggregatorService. Last 240 members = 4 hours of 1-minute bars.
  // Fetched via pipeline for all passed candidates to avoid N serial reads.
  {
    const barsPipe = redis.pipeline();
    for (const item of passed) {
      barsPipe.zrange(`bars:1m:${item.symbol}`, -240, -1);
    }
    const barsResults = await barsPipe.exec();
    for (let i = 0; i < passed.length; i++) {
      passed[i]._barsRaw = barsResults[i]?.[1] || [];
    }
  }
  // ── 4c. Compute wallRankScore per symbol ──────────────────────────────────
  for (const item of passed) {
    item.wallRankScore = _computeWallAnomalyScore(item);  // v3: bestWallPower-based
  }

  // ── 4d. Compute momentumScore per symbol ──────────────────────────────────
  for (const item of passed) {
    item.momentumScore = _computeMomentumScore(item);
  }

  // ── 4e. Compute volatility metrics from bars + 24h ticker ─────────────────
  //
  // volatilityPct = (high - low) / midPrice * 100
  // Sources (priority):
  //   1. bars:1m:{symbol} sorted-set  — last 240 members = 4h of 1m bars
  //   2. 24h ticker high/low fallback — always available
  //
  // If no bar data → volatility1hPct / volatility4hPct set to null (err on
  // side of inclusion so symbols without bar history are not excluded).
  for (const item of passed) {
    const barsRaw = item._barsRaw || [];
    delete item._barsRaw; // free memory

    // 24h volatility — always from ticker (most reliable for the full day window)
    const hi24  = item.highPrice24h;
    const lo24  = item.lowPrice24h;
    const mid24 = (hi24 + lo24) / 2;
    item.volatility24hPct = mid24 > 0
      ? parseFloat(((hi24 - lo24) / mid24 * 100).toFixed(3))
      : 0;

    if (barsRaw.length >= 2) {
      const bars = barsRaw.map(r => {
        try { return JSON.parse(r); } catch (_) { return null; }
      }).filter(Boolean);

      if (bars.length >= 2) {
        const ref = bars[bars.length - 1].close ?? mid24;

        // 1h = last 60 1m bars
        const bars1h = bars.slice(-60);
        let hi1 = -Infinity, lo1 = Infinity;
        for (const b of bars1h) {
          if (b.high > hi1) hi1 = b.high;
          if (b.low  < lo1) lo1 = b.low;
        }
        item.volatility1hPct = (ref > 0 && bars1h.length >= 2 && hi1 > lo1)
          ? parseFloat(((hi1 - lo1) / ref * 100).toFixed(3))
          : null;

        // 4h = all 240 bars
        let hi4 = -Infinity, lo4 = Infinity;
        for (const b of bars) {
          if (b.high > hi4) hi4 = b.high;
          if (b.low  < lo4) lo4 = b.low;
        }
        item.volatility4hPct = (ref > 0 && bars.length >= 2 && hi4 > lo4)
          ? parseFloat(((hi4 - lo4) / ref * 100).toFixed(3))
          : null;

        // 15m price move (last 15 1m bars) — used for breakout override
        const recent15 = bars.slice(-15);
        item._priceMove15mPct = recent15.length >= 2
          ? parseFloat((Math.abs(
              (recent15[recent15.length - 1].close - recent15[0].open) / recent15[0].open * 100
            )).toFixed(3))
          : 0;
      } else {
        item.volatility1hPct  = null;
        item.volatility4hPct  = null;
        item._priceMove15mPct = 0;
      }
    } else {
      // No bars — do not exclude based on bar-derived metrics
      item.volatility1hPct  = null;
      item.volatility4hPct  = null;
      item._priceMove15mPct = 0;
    }
  }

  // ── 4e-bis. Override sets — top-traded coins & big-wall coins bypass gates ──
  //
  // The two gates below (low-volatility 4f, activity 4f-bis) must NOT drop a
  // coin that is either:
  //   • among the top-N by 24h trade count (most actively traded books — where
  //     large resting walls like XLM's 447k order are most relevant), or
  //   • currently carrying a significant confirmed wall.
  // Force-includes are always exempt as well.
  const topTradedSet = new Set(
    [...passed]
      .sort((a, b) => (b.tradeCount24h ?? 0) - (a.tradeCount24h ?? 0))
      .slice(0, Math.max(0, DENSITY_ACTIVITY_KEEP_TOP_TRADED))
      .map(i => i.symbol),
  );

  const _wallThreshold = (sym) => FUTURES_WALL_THRESHOLDS[sym] ?? FUTURES_WALL_THRESHOLDS._default;
  const _hasSignificantWall = (item) =>
    DENSITY_ACTIVITY_KEEP_WALL_COINS && (
      (item._significantWallCount ?? 0) > 0 ||
      (item._bestWallPower ?? 0) >= WALL_POWER_SOFT_MIN ||
      (item._bestWallUsd ?? 0) >= _wallThreshold(item.symbol)
    );

  // True when a coin must survive the gates regardless of price action.
  // _relaxedVolume coins were admitted specifically to fill the min-universe
  // floor (step 2b) — they must not be dropped again by the gates below.
  const _isGateExempt = (item) =>
    item.isForce || item._relaxedVolume || topTradedSet.has(item.symbol) || _hasSignificantWall(item);

  // ── 4f. Low-volatility filter ─────────────────────────────────────────────
  //
  // Exclude when BOTH 4h AND 24h volatility are below their minimums.
  // A breakout override (1h spike, 15m price move, volume spike) allows entry.
  // Force-include symbols bypass this filter entirely.
  {
    const stillPassed = [];
    for (const item of passed) {
      if (_isGateExempt(item)) {
        item.volatilityStatus = item._relaxedVolume ? 'RELAXED' : 'ACTIVE';
        stillPassed.push(item);
        continue;
      }

      const lowVol4h  = item.volatility4hPct  !== null && item.volatility4hPct  < DENSITY_MIN_VOLATILITY_4H_PCT;
      const lowVol24h = item.volatility24hPct !== null && item.volatility24hPct < DENSITY_MIN_VOLATILITY_24H_PCT;

      if (!(lowVol4h && lowVol24h)) {
        item.volatilityStatus = 'ACTIVE';
        stillPassed.push(item);
        continue;
      }

      // Both windows are low — check breakout overrides
      const breakout1h  = item.volatility1hPct  !== null && item.volatility1hPct  >= DENSITY_VOLATILITY_BREAKOUT_1H_PCT;
      const breakout15m = (item._priceMove15mPct ?? 0)                                >= DENSITY_PRICE_MOVE_BREAKOUT_15M_PCT;
      const volSpike    = (item._volumeSpike     ?? 0)                                >= DENSITY_VOLUME_SPIKE_OVERRIDE;

      if (breakout1h || breakout15m || volSpike) {
        item.volatilityStatus = 'BREAKOUT_OVERRIDE';
        stillPassed.push(item);
      } else {
        item.volatilityStatus = 'LOW_VOLATILITY';
        heldOut.set(item.symbol, item);
        volatilityExcluded.push({
          symbol:           item.symbol,
          reason:           'LOW_VOLATILITY',
          volatility1hPct:  item.volatility1hPct,
          volatility4hPct:  item.volatility4hPct,
          volatility24hPct: item.volatility24hPct,
          updatedAt:        now,
        });
      }
    }
    passed.splice(0, passed.length, ...stillPassed);
  }

  // ── 4f-bis. Activity gate (pump OR dump OR high-volatility) ───────────────
  //
  // After the AND-gate (volume + trade count) a symbol must show at least ONE
  // sign of being "in play":
  //   • pump   — 24h change >= +PUMP_PCT  OR  recent 15m up-move >= MOVE_15M_PCT
  //   • dump   — 24h change <= -DUMP_PCT  OR  recent 15m down-move >= MOVE_15M_PCT
  //   • highVol — 24h or 4h high-low range >= VOLATILITY_PCT
  // Force-include symbols bypass the gate. Disable via DENSITY_ACTIVITY_GATE_ENABLED=false.
  //
  if (DENSITY_ACTIVITY_GATE_ENABLED) {
    const stillPassed = [];
    for (const item of passed) {
      // Exemptions: force-include, top-traded, or coins carrying a big wall
      // always stay in — they bypass the pump/dump/volatility requirement.
      if (_isGateExempt(item)) {
        item.activityStatus = item.isForce
          ? 'ACTIVE'
          : item._relaxedVolume
            ? 'RELAXED'
            : (_hasSignificantWall(item) ? 'HAS_WALL' : 'TOP_TRADED');
        stillPassed.push(item);
        continue;
      }

      const chg24h   = item.priceChangePct24h ?? 0;
      const move15m  = item._priceMove15mPct ?? 0;
      const vol24h   = item.volatility24hPct ?? 0;
      const vol4h    = item.volatility4hPct;

      const isPump   = chg24h >=  DENSITY_ACTIVITY_PUMP_PCT_24H || move15m >= DENSITY_ACTIVITY_PRICE_MOVE_15M_PCT;
      const isDump   = chg24h <= -DENSITY_ACTIVITY_DUMP_PCT_24H;
      const isHighVol = vol24h >= DENSITY_ACTIVITY_VOLATILITY_PCT
        || (vol4h !== null && vol4h >= DENSITY_ACTIVITY_VOLATILITY_PCT);

      if (isPump || isDump || isHighVol) {
        item.activityStatus = isPump ? 'PUMP' : (isDump ? 'DUMP' : 'HIGH_VOLATILITY');
        stillPassed.push(item);
      } else {
        item.activityStatus = 'INACTIVE';
        heldOut.set(item.symbol, item);
        activityExcluded.push({
          symbol:           item.symbol,
          reason:           'NO_ACTIVITY',
          priceChangePct24h: chg24h,
          priceMove15mPct:   move15m,
          volatility4hPct:   vol4h,
          volatility24hPct:  vol24h,
          updatedAt:         now,
        });
      }
    }
    passed.splice(0, passed.length, ...stillPassed);
  }

  // ── 4f-ter. Min-universe relax fallback ───────────────────────────────────
  //
  // If the gates left fewer than DENSITY_MIN_UNIVERSE_SIZE coins, re-admit the
  // most-traded coins that were just dropped (low-vol / no-activity) until the
  // floor is reached. Guarantees there are always enough coins to surface wall
  // info even on a quiet market.
  if (passed.length < DENSITY_MIN_UNIVERSE_SIZE && heldOut.size > 0) {
    const passedSet = new Set(passed.map(i => i.symbol));
    const need      = DENSITY_MIN_UNIVERSE_SIZE - passed.length;
    const readmit   = [...heldOut.values()]
      .filter(i => !passedSet.has(i.symbol))
      .sort((a, b) => (b.tradeCount24h ?? 0) - (a.tradeCount24h ?? 0))
      .slice(0, need);
    if (readmit.length > 0) {
      const readmitSet = new Set(readmit.map(i => i.symbol));
      for (const item of readmit) {
        item.activityStatus   = 'RELAXED';
        item.volatilityStatus = item.volatilityStatus === 'LOW_VOLATILITY' ? 'RELAXED' : item.volatilityStatus;
        passed.push(item);
      }
      // Drop re-admitted symbols from the debug-exclude lists so a coin never
      // appears as both tracked and excluded.
      for (let i = volatilityExcluded.length - 1; i >= 0; i--) {
        if (readmitSet.has(volatilityExcluded[i].symbol)) volatilityExcluded.splice(i, 1);
      }
      for (let i = activityExcluded.length - 1; i >= 0; i--) {
        if (readmitSet.has(activityExcluded[i].symbol)) activityExcluded.splice(i, 1);
      }
      console.log(`[universe] relax fallback: re-admitted ${readmit.length} top-traded coins to reach floor=${DENSITY_MIN_UNIVERSE_SIZE} (${readmit.map(i => i.symbol).join(',')})`);
    }
  }

  // ── 4g. densityScore + reason per symbol ──────────────────────────────────
  //
  //   densityScore = max(wallRankScore, momentumScore, liquidityScore)
  //   reason       = dominant category (before dedup)
  //
  for (const item of passed) {
    item.liquidityScore = Math.min(item.quoteVol24h / UNIVERSE_VOL_REF, 1);
    const wallRankScore  = item.wallRankScore;
    const momentumScore  = item.momentumScore;
    const liquidityScore = item.liquidityScore;
    item.densityScore   = parseFloat(Math.max(wallRankScore, momentumScore, liquidityScore).toFixed(5));
    // Pre-assign reason based on dominant score (may be overwritten by category step below)
    if (item.isForce) {
      item.reason = 'CORE';
    } else if (wallRankScore >= momentumScore && wallRankScore >= liquidityScore) {
      item.reason = 'WALL_ANOMALY';
    } else if (momentumScore >= liquidityScore) {
      item.reason = 'MOMENTUM';
    } else {
      item.reason = 'LIQUIDITY';
    }
  }

  // ── 4h. Assign category buckets (CORE → WALL_ANOMALY → MOMENTUM → LIQUIDITY) ─
  //
  // Each symbol appears in exactly ONE category (first match wins).
  // Force-includes always go into CORE regardless of their scores.
  //
  const assignedSet = new Set();

  // CORE — force-include symbols
  const coreList = passed
    .filter(item => item.isForce)
    .slice(0, DENSITY_CORE_LIMIT);
  for (const item of coreList) { item.reason = 'CORE'; assignedSet.add(item.symbol); }

  // WALL — symbols with a significant wall (wallPower > 0 via v3 adaptive algorithm)
  const wallAnomalyList = passed
    .filter(item => !assignedSet.has(item.symbol))
    .filter(item => (item._bestWallPower ?? 0) > 0)
    .sort((a, b) => b.wallRankScore - a.wallRankScore)
    .slice(0, DENSITY_WALL_ANOMALY_LIMIT);
  for (const item of wallAnomalyList) { item.reason = 'WALL'; assignedSet.add(item.symbol); }

  // MOMENTUM — volume/price spike, with or without walls
  const momentumList = passed
    .filter(item => !assignedSet.has(item.symbol))
    .filter(item => item.momentumScore >= MOMENTUM_MIN_SCORE)
    .sort((a, b) => b.momentumScore - a.momentumScore)
    .slice(0, DENSITY_MOMENTUM_LIMIT);
  for (const item of momentumList) { item.reason = 'MOMENTUM'; assignedSet.add(item.symbol); }

  // LIQUIDITY — most liquid symbols not captured above
  const liquidityList = passed
    .filter(item => !assignedSet.has(item.symbol))
    .sort((a, b) => b.quoteVol24h - a.quoteVol24h)
    .slice(0, DENSITY_LIQUIDITY_LIMIT);
  for (const item of liquidityList) { item.reason = 'LIQUIDITY'; assignedSet.add(item.symbol); }

  const finalList      = [...coreList, ...wallAnomalyList, ...momentumList, ...liquidityList];
  const futuresSymbols = finalList.map(i => i.symbol);
  const spotSymbols    = INCLUDE_SPOT_FOR_TRACKED_FUTURES ? [...futuresSymbols] : [];

  // ── 4i. Assign tiers and update hot candidates registry ──────────────────
  //
  //   TIER 1 — DENSITY_TIER1_SYMBOLS (always-live, never rotated out)
  //   TIER 2 — CORE (other force-includes) + WALL_ANOMALY + MOMENTUM symbols
  //   TIER 3 — LIQUIDITY symbols (cold scan, lower priority)
  //
  // HOT status: a MOMENTUM (or WALL) symbol whose volume/trade-count spike
  // exceeds the configured minimum is added to _hotCandidates with the current
  // timestamp.  Entries that are older than HOT_CANDIDATE_EXPIRY_MS and are
  // no longer MOMENTUM/WALL are pruned from the registry.
  //
  for (const item of finalList) {
    if (DENSITY_TIER1_SYMBOLS.has(item.symbol)) {
      item.tier = 1;
    } else if (item.reason === 'CORE' || item.reason === 'WALL' || item.reason === 'MOMENTUM') {
      item.tier = 2;
    } else {
      item.tier = 3;
    }

    // Hot candidate detection: MOMENTUM or WALL symbol with a real spike
    const volSpike   = item._volumeSpike   ?? 0;
    const tradeSpike = item._tradeSpike    ?? 0;
    const isActive   = item.reason === 'MOMENTUM' || item.reason === 'WALL' || item.reason === 'CORE';
    const isSpiky    = volSpike >= HOT_VOLUME_SPIKE_MIN || tradeSpike >= HOT_TRADE_SPIKE_MIN;

    if (isActive && isSpiky && !_hotCandidates.has(item.symbol)) {
      _hotCandidates.set(item.symbol, now);
    }
  }

  // Prune expired hot candidates (no longer in finalList OR TTL exceeded)
  const finalSymbolSet = new Set(futuresSymbols);
  for (const [sym, hotSince] of _hotCandidates) {
    const expired   = (now - hotSince) > HOT_CANDIDATE_EXPIRY_MS;
    const stillSeen = finalSymbolSet.has(sym);
    // Remove if expired AND not actively spiking right now
    if (expired && !stillSeen) {
      _hotCandidates.delete(sym);
    } else if (expired) {
      // Still in universe — check if still spiking; if not, remove
      const item = finalList.find(i => i.symbol === sym);
      const recentSpike = (item?._volumeSpike ?? 0) >= HOT_VOLUME_SPIKE_MIN
                       || (item?._tradeSpike  ?? 0) >= HOT_TRADE_SPIKE_MIN;
      if (!recentSpike) _hotCandidates.delete(sym);
    }
  }

  // Assign hotSince to final list items
  for (const item of finalList) {
    item.hotSince = _hotCandidates.get(item.symbol) ?? null;
  }

  // ── 5. Write Redis ────────────────────────────────────────────────────────

  // 5a. Backward-compat universe keys
  const metaObj = {};
  for (const item of finalList) {
    metaObj[item.symbol] = {
      source:              item.source,
      reason:              item.reason,
      quoteVol24h:         item.quoteVol24h,
      tradeCount24h:       item.tradeCount24h,
      activityScore:       item.activityScore,
      volumeUsdt60s:       item.volumeUsdt60s,
      maxWallUsd:          item.maxWallUsd,
      normalWallUsd:       Math.round(item.normalWallUsd),
      densityScore:        item.densityScore,
      wallRankScore:       item.wallRankScore,
      momentumScore:       item.momentumScore,
      liquidityScore:      item.liquidityScore,
      hasFutures:          item.hasFutures,
      hasSpot:             item.hasSpot,
      monitorFutures:      item.monitorFutures,
      monitorSpot:         item.monitorSpot,
      passesVolumeFilter:  item.passesVolumeFilter,
      isForce:             item.isForce,
      includedAt:          item.includedAt,
      volatility1hPct:     item.volatility1hPct  ?? null,
      volatility4hPct:     item.volatility4hPct  ?? null,
      volatility24hPct:    item.volatility24hPct ?? null,
      volatilityStatus:    item.volatilityStatus ?? 'ACTIVE',
      activityStatus:      item.activityStatus   ?? 'ACTIVE',
    };
  }

  const filteredPayload = JSON.stringify({
    updatedAt: now,
    count:     futuresSymbols.length,
    symbols:   futuresSymbols,
    filters: {
      minVolume24h:     TRACK_MIN_VOLUME_24H_USD,
      minTradeCount24h: TRACK_MIN_TRADE_COUNT_24H,
      minActivityScore: TRACK_MIN_ACTIVITY_SCORE,
      activityGate:     DENSITY_ACTIVITY_GATE_ENABLED,
      keepTopTraded:    DENSITY_ACTIVITY_KEEP_TOP_TRADED,
      keepWallCoins:    DENSITY_ACTIVITY_KEEP_WALL_COINS,
      minUniverseSize:  DENSITY_MIN_UNIVERSE_SIZE,
      maxSymbols,
    },
  });

  const mainPipeline = redis.pipeline();
  mainPipeline.set(UNIVERSE_KEYS.filtered, filteredPayload,                         'EX', UNIVERSE_TTL_S);
  mainPipeline.set(UNIVERSE_KEYS.meta,     JSON.stringify(metaObj),                 'EX', UNIVERSE_TTL_S);
  mainPipeline.set(UNIVERSE_KEYS.futures,  JSON.stringify({ updatedAt: now, symbols: futuresSymbols }), 'EX', UNIVERSE_TTL_S);
  mainPipeline.set(UNIVERSE_KEYS.spot,     JSON.stringify({ updatedAt: now, symbols: spotSymbols }),    'EX', UNIVERSE_TTL_S);

  // Hot candidates map → Redis  { symbol: hotSince }
  if (_hotCandidates.size > 0) {
    const hotObj = {};
    for (const [sym, ts] of _hotCandidates) hotObj[sym] = ts;
    mainPipeline.set(
      DENSITY_HOT_CANDIDATES_KEY,
      JSON.stringify(hotObj),
      'EX', Math.ceil(HOT_CANDIDATE_EXPIRY_MS / 1000) + 60, // TTL = expiry + 1 min buffer
    );
  } else {
    mainPipeline.del(DENSITY_HOT_CANDIDATES_KEY);
  }

  // 5a-bis. Write excluded symbols debug list (stable + low-volatility)
  const allExcluded = [...stableExcluded, ...volatilityExcluded, ...activityExcluded];
  if (allExcluded.length > 0) {
    mainPipeline.set(
      'density:universe:excluded',
      JSON.stringify({ updatedAt: now, excluded: allExcluded }),
      'EX', 300, // 5 min TTL
    );
  }
  await mainPipeline.exec();

  // 5b. Per-symbol density:score:{symbol} — ALL processed symbols (not just finalList)
  //     so the frontend can inspect any symbol even if it didn't make the cut.
  const scorePipeline = redis.pipeline();
  for (const item of passed) {
    const normalizedWallScore = parseFloat(
      (item.maxWallUsd / Math.max(item.normalWallUsd, 1)).toFixed(3),
    );
    const scoreObj = {
      symbol:               item.symbol,
      densityScore:         item.densityScore    ?? 0,
      reason:               item.reason          ?? 'UNRANKED',
      tier:                 item.tier            ?? 3,
      hotSince:             item.hotSince        ?? null,
      wallRankScore:        item.wallRankScore    ?? 0,
      momentumScore:        item.momentumScore    ?? 0,
      liquidityScore:       item.liquidityScore   ?? 0,
      maxWallUsd:           item.maxWallUsd       ?? 0,
      normalizedWallScore,
      normalWallUsd:        Math.round(item.normalWallUsd ?? 0),
      bestWallPower:        item._bestWallPower   ?? 0,
      volumeSpike:          item._volumeSpike     ?? null,
      tradeCountSpike:      item._tradeSpike      ?? null,
      priceMove5mPct:       item._priceChangePct  ?? null,
      updatedAt:            now,
    };
    scorePipeline.set(
      `${DENSITY_SCORE_KEY_PREFIX}${item.symbol}`,
      JSON.stringify(scoreObj),
      'EX', DENSITY_SCORE_TTL_S,
    );
  }

  // 5c. density:symbols:ranked — ordered list for the density coin list sidebar
  const rankedPayload = {
    updatedAt: now,
    count:     finalList.length,
    categories: {
      CORE:         coreList.length,
      WALL:         wallAnomalyList.length,
      MOMENTUM:     momentumList.length,
      LIQUIDITY:    liquidityList.length,
    },
    symbols: finalList.map(item => ({
      symbol:              item.symbol,
      reason:              item.reason,
      tier:                item.tier            ?? 3,
      hotSince:            item.hotSince        ?? null,
      densityScore:        item.densityScore,
      wallRankScore:       item.wallRankScore,
      momentumScore:       item.momentumScore,
      maxWallUsd:          item.maxWallUsd,
      significantWallCount: item._significantWallCount ?? 0,
      bestWallPower:       item._bestWallPower        ?? 0,
      bestWallSide:        item._bestWall?.side        ?? null,
      bestWallDistancePct: item._bestWall?.distancePct ?? null,
      wallCategory:        item._bestWall?.wallCategory ?? item._bestWall?.category ?? null,
      volumeSpike:         item._volumeSpike     ?? null,
      tradeCountSpike:     item._tradeSpike      ?? null,
      priceMove5mPct:      item._priceChangePct  ?? null,
      volatility1hPct:     item.volatility1hPct  ?? null,
      volatility4hPct:     item.volatility4hPct  ?? null,
      volatility24hPct:    item.volatility24hPct ?? null,
      volatilityStatus:    item.volatilityStatus ?? 'ACTIVE',
    })),
  };
  scorePipeline.set(DENSITY_RANKED_KEY, JSON.stringify(rankedPayload), 'EX', DENSITY_SCORE_TTL_S * 2);
  await scorePipeline.exec();

  // ── Log summary ──────────────────────────────────────────────────────────
  const topByWall = [...wallAnomalyList]
    .sort((a, b) => b.maxWallUsd - a.maxWallUsd)
    .slice(0, 3)
    .map(i => `${i.symbol.replace('USDT', '')}(${(i.maxWallUsd / 1e6).toFixed(1)}M×${(i.maxWallUsd / Math.max(i.normalWallUsd, 1)).toFixed(1)}n)`);
  const topByMomentum = [...momentumList]
    .sort((a, b) => b.momentumScore - a.momentumScore)
    .slice(0, 3)
    .map(i => `${i.symbol.replace('USDT', '')}(m=${i.momentumScore.toFixed(2)},vol×${(i._volumeSpike ?? 0).toFixed(1)})`);

  console.log(
    `[universe] built — qualified=${volumeQualified.length} passed=${passed.length}` +
    ` stableExcluded=${stableExcluded.length} volatilityExcluded=${volatilityExcluded.length} activityExcluded=${activityExcluded.length}` +
    ` core=${coreList.length} walls=${wallAnomalyList.length} momentum=${momentumList.length} liq=${liquidityList.length}` +
    ` total=${futuresSymbols.length}` +
    ` topWalls=[${topByWall.join(',')}]` +
    ` topMomentum=[${topByMomentum.join(',')}]`,
  );

  return { futures: futuresSymbols, spot: spotSymbols, meta: metaObj };
}

module.exports = {
  buildAndPersistUniverse,
  UNIVERSE_KEYS,
};
