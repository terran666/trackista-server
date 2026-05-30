'use strict';

// ─── Density Futures v2 — Centralized Configuration ──────────────────────────
//
// All numeric env vars are parsed with parseInt / parseFloat and have safe defaults.
// Import this module in any file that participates in the Futures Density pipeline.
//
// ENV variables (with defaults):
//
//   FUTURES_DENSITY_ENABLED              = true
//   FUTURES_TRACKED_SYMBOLS_REFRESH_MS   = 30000
//   FUTURES_TRACKED_MAX_SYMBOLS          = 3
//   FUTURES_TRACKED_MIN_HOLD_MS          = 600000
//   FUTURES_TRACKED_MAX_ROTATIONS_PER_CYCLE = 2
//   FUTURES_FILTER_MAX_TRADE_COUNT_24H   = 900000
//   FUTURES_FILTER_MAX_QUOTE_VOLUME_24H  = 100000000
//   FUTURES_FORCE_INCLUDE                = ETHUSDT,SOLUSDT,XRPUSDT
//
//   FUTURES_WALL_THRESHOLD_BTC           = 5000000
//   FUTURES_WALL_THRESHOLD_ETH           = 3000000
//   FUTURES_WALL_THRESHOLD_SOL           = 2000000
//   FUTURES_WALL_THRESHOLD_TRX           = 2000000
//   FUTURES_WALL_THRESHOLD_DEFAULT       = 400000
//
//   FUTURES_MAX_WALL_DISTANCE_PCT        = 5
//   FUTURES_DIST_SCALE_PER_MULTIPLIER    = 15
//   FUTURES_DEEP_WALL_MAX_DISTANCE_PCT   = 35
//   FUTURES_WALL_SCAN_MS                 = 2000
//   FUTURES_MIN_WALL_LIFETIME_MS         = 60000
//   FUTURES_WALL_ABSENCE_GRACE_MS                 = 10000
//   FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS        = 90000
//   FUTURES_WALL_SIZE_DROP_TOLERANCE_RATIO = 0.15
//
//   FUTURES_SNAPSHOT_MIN_GAP_MS          = 1500
//   FUTURES_STARTUP_STAGGER_MS           = 3000
//   FUTURES_RESYNC_COOLDOWN_MS           = 15000
//   FUTURES_SYMBOL_BACKOFF_BASE_MS       = 30000
//   FUTURES_SYMBOL_BACKOFF_MAX_MS        = 300000
//   FUTURES_ORDERBOOK_FLUSH_MS           = 2000
//
// Universe filtering (new — TestPage-aligned):
//   TRACK_MIN_VOLUME_24H_USD             = 100000000  (min 24h quoteVolume to enter universe)
//   TRACK_MIN_ACTIVITY_SCORE             = 0          (0 = skip spot activity filter)
//   INCLUDE_SPOT_FOR_TRACKED_FUTURES     = true       (also monitor spot for futures coins)
//   INCLUDE_SPOT_ONLY                    = false      (spot-only coins skipped by default)
//   TRACKED_UNIVERSE_REFRESH_MS          = 60000      (universe rebuild interval)
//
// Wall states:
//   WALL_PERSISTENT_MS                   = 180000     (accMs to reach persistent state)
//
// Wall scoring:
//   WALL_MIN_QUALITY_SCORE               = 40
//

// ─── Symbol tracking ──────────────────────────────────────────────
const FUTURES_DENSITY_ENABLED = process.env.FUTURES_DENSITY_ENABLED !== 'false';
const FUTURES_TRACKED_SYMBOLS_REFRESH_MS     = parseInt(process.env.FUTURES_TRACKED_SYMBOLS_REFRESH_MS     || '30000',  10);
const FUTURES_TRACKED_MAX_SYMBOLS            = parseInt(process.env.FUTURES_TRACKED_MAX_SYMBOLS            || '3',      10);
const FUTURES_TRACKED_HARD_MAX_SYMBOLS       = 600; // absolute ceiling, not configurable
const FUTURES_TRACKED_MIN_HOLD_MS            = parseInt(process.env.FUTURES_TRACKED_MIN_HOLD_MS            || '600000', 10);
const FUTURES_TRACKED_MAX_ROTATIONS_PER_CYCLE = parseInt(process.env.FUTURES_TRACKED_MAX_ROTATIONS_PER_CYCLE || '2',   10);

// ─── Symbol filters (inclusive upper bound — legacy, kept for compat) ──────────
const FUTURES_FILTER_MAX_TRADE_COUNT_24H  = parseInt(process.env.FUTURES_FILTER_MAX_TRADE_COUNT_24H  || '900000',   10);
const FUTURES_FILTER_MAX_QUOTE_VOLUME_24H = parseFloat(process.env.FUTURES_FILTER_MAX_QUOTE_VOLUME_24H || '100000000');

// ─── Universe filtering (TestPage-aligned lower-bound filters) ────────────────
// Minimum 24h quoteVolume (USDT) for a symbol to enter the tracked universe.
const TRACK_MIN_VOLUME_24H_USD  = parseFloat(process.env.TRACK_MIN_VOLUME_24H_USD  || '100000000');
// Minimum spot activityScore for the symbol to be included. 0 = no spot activity gate.
const TRACK_MIN_ACTIVITY_SCORE  = parseFloat(process.env.TRACK_MIN_ACTIVITY_SCORE  || '0');
// If true, spot orderbook is also monitored for each tracked futures symbol.
const INCLUDE_SPOT_FOR_TRACKED_FUTURES = process.env.INCLUDE_SPOT_FOR_TRACKED_FUTURES !== 'false';
// If true, symbols with spot but no futures-pairing can be added (off by default).
const INCLUDE_SPOT_ONLY         = process.env.INCLUDE_SPOT_ONLY === 'true';
// How often (ms) the tracked universe is rebuilt. Default 60s.
const TRACKED_UNIVERSE_REFRESH_MS = parseInt(process.env.TRACKED_UNIVERSE_REFRESH_MS || '60000', 10);

// ─── Force-include whitelist ──────────────────────────────────────
// These symbols are always tracked regardless of filter conditions.
const FUTURES_FORCE_INCLUDE = (process.env.FUTURES_FORCE_INCLUDE || 'ETHUSDT,SOLUSDT,XRPUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ─── Wall thresholds — fixed per symbol, not volume-based ─────────
const FUTURES_WALL_THRESHOLDS = {
  BTCUSDT:  parseFloat(process.env.FUTURES_WALL_THRESHOLD_BTC     || '5000000'),
  ETHUSDT:  parseFloat(process.env.FUTURES_WALL_THRESHOLD_ETH     || '3000000'),
  SOLUSDT:  parseFloat(process.env.FUTURES_WALL_THRESHOLD_SOL     || '2000000'),
  XRPUSDT:  parseFloat(process.env.FUTURES_WALL_THRESHOLD_XRP     || '1000000'),
  TRXUSDT:  parseFloat(process.env.FUTURES_WALL_THRESHOLD_TRX     || '2000000'),
  _default: parseFloat(process.env.FUTURES_WALL_THRESHOLD_DEFAULT || '400000'),
};

// ─── Wall detection ───────────────────────────────────────────────
// Normal distance cap (from mid price) for all qualifying walls.
const FUTURES_MAX_WALL_DISTANCE_PCT           = parseFloat(process.env.FUTURES_MAX_WALL_DISTANCE_PCT           || '5');
// Per each additional multiplier of threshold, the distance cap grows by this many %.
// effectiveMaxDist = min(BASE + (ratio-1) * SCALE, HARD_CAP)
// Example SOL (threshold=2M): 5M → ratio=2.5 → 5+1.5×15=27.5%  |  10M → ratio=5 → 65%→35%
const FUTURES_DIST_SCALE_PER_MULTIPLIER       = parseFloat(process.env.FUTURES_DIST_SCALE_PER_MULTIPLIER       || '15');
// Absolute maximum distance cap regardless of wall size.
const FUTURES_DEEP_WALL_MAX_DISTANCE_PCT      = parseFloat(process.env.FUTURES_DEEP_WALL_MAX_DISTANCE_PCT      || '35');
// deepWall flag is set when wall is >= this many × base threshold (used by frontend for visual tagging).
const FUTURES_DEEP_WALL_MULTIPLIER_FLAG       = parseFloat(process.env.FUTURES_DEEP_WALL_MULTIPLIER_FLAG       || '2');
const FUTURES_WALL_SCAN_MS                    = parseInt(process.env.FUTURES_WALL_SCAN_MS                    || '2000',  10);
const FUTURES_MIN_WALL_LIFETIME_MS            = parseInt(process.env.FUTURES_MIN_WALL_LIFETIME_MS            || '20000', 10);
// Wall accumulates WALL_PERSISTENT_MS of presence → promoted to 'persistent'.
const FUTURES_WALL_PERSISTENT_MS              = parseInt(process.env.WALL_PERSISTENT_MS                       || '180000', 10);
// Minimum qualityScore for a wall to appear in the screener (0 = no filter).
const FUTURES_WALL_MIN_QUALITY_SCORE          = parseInt(process.env.WALL_MIN_QUALITY_SCORE                   || '40',     10);
const FUTURES_WALL_ABSENCE_GRACE_MS           = parseInt(process.env.FUTURES_WALL_ABSENCE_GRACE_MS           || '10000', 10);
// Confirmed walls survive longer absences — covers spoofing/manipulation patterns where
// a large confirmed wall briefly disappears and re-appears (market-maker iceberg behaviour).
const FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS = parseInt(process.env.FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS || '90000', 10);
const FUTURES_WALL_SIZE_DROP_TOLERANCE_RATIO  = parseFloat(process.env.FUTURES_WALL_SIZE_DROP_TOLERANCE_RATIO || '0.15');

// ─── Snapshot queue / anti-ban ────────────────────────────────────
// max concurrency is always 1 by design (enforced in code, not configurable)
const FUTURES_SNAPSHOT_MIN_GAP_MS   = parseInt(process.env.FUTURES_SNAPSHOT_MIN_GAP_MS   || '3000', 10);
const FUTURES_STARTUP_STAGGER_MS    = parseInt(process.env.FUTURES_STARTUP_STAGGER_MS    || '3000', 10);
const FUTURES_RESYNC_COOLDOWN_MS    = parseInt(process.env.FUTURES_RESYNC_COOLDOWN_MS    || '60000', 10);
const FUTURES_SNAPSHOT_LIMIT        = 1000;

// ─── Per-symbol backoff (step-wise exponential) ───────────────────
// Error 1: base, Error 2: base×2, Error 3: base×4, Error 4+: max
const FUTURES_SYMBOL_BACKOFF_BASE_MS = parseInt(process.env.FUTURES_SYMBOL_BACKOFF_BASE_MS || '30000',  10);
const FUTURES_SYMBOL_BACKOFF_MAX_MS  = parseInt(process.env.FUTURES_SYMBOL_BACKOFF_MAX_MS  || '300000', 10);

// ─── Circuit breaker ──────────────────────────────────────────────
const FUTURES_CIRCUIT_BREAKER_THRESHOLD = 3;          // RL events within window → safe mode
const FUTURES_CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;  // 5 min rolling window
const FUTURES_SAFE_MODE_EXIT_MS         = 10 * 60 * 1000; // 10 min quiet before auto-exit

// ─── Redis keys ───────────────────────────────────────────────────
const SAFE_MODE_REDIS_KEY    = 'density:futures:safe-mode';
const FUTURES_ALL_TICKERS_KEY = 'futures:tickers:all'; // written by collector, read by manager

// ─── Orderbook flush ─────────────────────────────────────────────
const FUTURES_ORDERBOOK_FLUSH_MS = parseInt(process.env.FUTURES_ORDERBOOK_FLUSH_MS || '2000', 10);
const FUTURES_TOP_LEVELS         = 200;

// ─── Misc ─────────────────────────────────────────────────────────
const FUTURES_RECONNECT_DELAY_MS     = 5000;
const FUTURES_STATS_LOG_INTERVAL_MS  = 60_000;
const FUTURES_VOLUME_REFRESH_MS      = 60 * 60 * 1000;

// ─── Universe category limits ─────────────────────────────────────
//
// finalList = CORE (≤15) + WALL_ANOMALY (≤40) + MOMENTUM (≤30) + LIQUIDITY (≤20)
// Total ≤ DENSITY_TRACKED_SYMBOLS_LIMIT (100 default).
// Each symbol appears in exactly one category (dedup by insertion order).
//
const DENSITY_CORE_LIMIT         = parseInt(process.env.DENSITY_CORE_LIMIT         || '15', 10);
const DENSITY_WALL_ANOMALY_LIMIT = parseInt(process.env.DENSITY_WALL_ANOMALY_LIMIT || '40', 10);
const DENSITY_MOMENTUM_LIMIT     = parseInt(process.env.DENSITY_MOMENTUM_LIMIT     || '30', 10);
const DENSITY_LIQUIDITY_LIMIT    = parseInt(process.env.DENSITY_LIQUIDITY_LIMIT    || '20', 10);

// ─── Wall rank score sub-weights ─────────────────────────────────
//   wallRankScore =
//     NORMALIZED_W  * normalizedWallScore      (how anomalous vs symbol's own depth)
//     COUNT_W       * confirmedWallCountScore   (number of confirmed walls)
//     NEAR_PRICE_W  * wallNearPriceScore        (walls close to current price)
//     LIFETIME_W    * wallLifetimeScore         (avg lifetime of confirmed walls)
//     REFRESH_W     * wallRefreshScore          (avg refill count of confirmed walls)
//
const WALL_SCORE_NORMALIZED_W  = parseFloat(process.env.WALL_SCORE_NORMALIZED_W  || '0.45');
const WALL_SCORE_COUNT_W       = parseFloat(process.env.WALL_SCORE_COUNT_W       || '0.20');
const WALL_SCORE_NEAR_PRICE_W  = parseFloat(process.env.WALL_SCORE_NEAR_PRICE_W  || '0.15');
const WALL_SCORE_LIFETIME_W    = parseFloat(process.env.WALL_SCORE_LIFETIME_W    || '0.10');
const WALL_SCORE_REFRESH_W     = parseFloat(process.env.WALL_SCORE_REFRESH_W     || '0.10');

// ─── Momentum score sub-weights ───────────────────────────────────
//   momentumScore =
//     VOL_SPIKE_W   * volumeSpikeScore    (current vol vs 24h avg/min)
//     TRADE_SPIKE_W * tradeCountSpike     (current trades vs 24h avg/min)
//     PRICE_MOVE_W  * priceMoveScore      (abs(priceChange24h) / 10)
//     TAKER_W       * takerImbalance      (0 in Этап 1 — not yet available)
//     VOLATILITY_W  * volatilityScore     (H-L range / 10%)
//
const MOMENTUM_VOL_SPIKE_W     = parseFloat(process.env.MOMENTUM_VOL_SPIKE_W     || '0.30');
const MOMENTUM_TRADE_SPIKE_W   = parseFloat(process.env.MOMENTUM_TRADE_SPIKE_W   || '0.25');
const MOMENTUM_PRICE_MOVE_W    = parseFloat(process.env.MOMENTUM_PRICE_MOVE_W    || '0.20');
const MOMENTUM_TAKER_W         = parseFloat(process.env.MOMENTUM_TAKER_W         || '0.15');
const MOMENTUM_VOLATILITY_W    = parseFloat(process.env.MOMENTUM_VOLATILITY_W    || '0.10');

// ─── Adaptive wall threshold (normalWallUsdForSymbol) ─────────────
//
//   normalWallUsd = max(avgSidedDepthWithin1Pct * WALL_DEPTH_RATIO, staticThreshold)
//
//   A wall is "anomalous" when its USD size >= WALL_ANOMALY_MIN_NORM * normalWallUsd.
//   normalizedWallScore = min(wallUsd / (5 * normalWallUsd), 1)   so 5× = full score.
//
const WALL_DEPTH_RATIO      = parseFloat(process.env.WALL_DEPTH_RATIO      || '0.03');
const WALL_ANOMALY_MIN_NORM = parseFloat(process.env.WALL_ANOMALY_MIN_NORM || '1.5');

// ─── Adaptive wall detection v3 — per-orderbook statistical thresholds ────────
//
//  adaptiveThreshold = max(
//    staticMinWallUsd,
//    p95OrderUsd * WALL_P95_MULTIPLIER,
//    medianOrderUsd * WALL_MEDIAN_MULTIPLIER,
//    avgDepthNear1Pct * WALL_DEPTH_RATIO,
//  )
//
//  wallPower = 0.35*p95RatioScore + 0.30*localRatioScore
//            + 0.15*distanceScore + 0.10*lifetimeScore + 0.10*isolationScore
//
const WALL_SCAN_DISTANCE_PCT    = parseFloat(process.env.WALL_SCAN_DISTANCE_PCT    || '5');   // % from mid
const WALL_P95_MULTIPLIER       = parseFloat(process.env.WALL_P95_MULTIPLIER       || '1.5'); // sizeUsd >= p95 × 1.5
const WALL_LOCAL_WINDOW_LEVELS  = parseInt(process.env.WALL_LOCAL_WINDOW_LEVELS  || '5',  10); // ±N price levels
const WALL_LOCAL_MULTIPLIER     = parseFloat(process.env.WALL_LOCAL_MULTIPLIER     || '3');   // vs local median
const WALL_MEDIAN_MULTIPLIER    = parseFloat(process.env.WALL_MEDIAN_MULTIPLIER    || '4');   // vs side median
const WALL_SIMILAR_LEVELS_LIMIT = parseInt(process.env.WALL_SIMILAR_LEVELS_LIMIT || '5',  10); // isolation threshold

// wallPower tier thresholds
const WALL_POWER_SOFT_MIN    = parseFloat(process.env.WALL_POWER_SOFT_MIN    || '0.45');
const WALL_POWER_STRONG_MIN  = parseFloat(process.env.WALL_POWER_STRONG_MIN  || '0.65');
const WALL_POWER_EXTREME_MIN = parseFloat(process.env.WALL_POWER_EXTREME_MIN || '0.80');

// Redis keys for adaptive wall analytics
const DENSITY_WALL_STATS_KEY_PREFIX = 'density:wallStats:';   // + symbol
const DENSITY_BEST_WALL_KEY_PREFIX  = 'density:bestWall:';    // + symbol
const DENSITY_WALL_STATS_TTL_S      = 300;  // 5 minutes

// ─── Momentum category entry threshold ────────────────────────────
// Symbol enters MOMENTUM bucket only when its momentumScore >= this value.
const MOMENTUM_MIN_SCORE    = parseFloat(process.env.MOMENTUM_MIN_SCORE    || '0.20');

// ─── Score Redis keys / TTL ───────────────────────────────────────
const DENSITY_SCORE_KEY_PREFIX = 'density:score:';   // + symbol
const DENSITY_RANKED_KEY       = 'density:symbols:ranked';
const DENSITY_SCORE_TTL_S      = 300;  // 5 minutes
// ─── Volatility filter (low-volatility & stable-coin exclusion) ───────────────
//
//   DENSITY_STABLE_BASE_BLACKLIST         — base assets always excluded (comma-sep)
//   DENSITY_MIN_VOLATILITY_4H_PCT         — min 4h high-low range % for inclusion
//   DENSITY_MIN_VOLATILITY_24H_PCT        — min 24h high-low range % for inclusion
//   DENSITY_VOLATILITY_BREAKOUT_1H_PCT    — override: 1h spike allows entry despite low-vol
//   DENSITY_PRICE_MOVE_BREAKOUT_15M_PCT   — override: 15m price move allows entry
//   DENSITY_VOLUME_SPIKE_OVERRIDE         — override: volume spike ratio allows entry
//
// Logic: exclude if volatility4hPct < MIN_4H AND volatility24hPct < MIN_24H,
//        unless a breakout override fires. Stable blacklist has NO override.
//
const DENSITY_STABLE_BASE_BLACKLIST = (
  process.env.DENSITY_STABLE_BASE_BLACKLIST || 'USDC,FDUSD,TUSD,USDP,DAI,BUSD,EUR,AEUR'
).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const DENSITY_MIN_VOLATILITY_4H_PCT          = parseFloat(process.env.DENSITY_MIN_VOLATILITY_4H_PCT          || '1.0');
const DENSITY_MIN_VOLATILITY_24H_PCT         = parseFloat(process.env.DENSITY_MIN_VOLATILITY_24H_PCT         || '1.5');
const DENSITY_VOLATILITY_BREAKOUT_1H_PCT     = parseFloat(process.env.DENSITY_VOLATILITY_BREAKOUT_1H_PCT     || '1.2');
const DENSITY_PRICE_MOVE_BREAKOUT_15M_PCT    = parseFloat(process.env.DENSITY_PRICE_MOVE_BREAKOUT_15M_PCT    || '1.0');
const DENSITY_VOLUME_SPIKE_OVERRIDE          = parseFloat(process.env.DENSITY_VOLUME_SPIKE_OVERRIDE          || '3.0');

// ─── Tier 1 always-live symbols ───────────────────────────────────
//
// These symbols are always in CORE regardless of volume/momentum score.
// Tier assignments: CORE → tier1,  WALL/MOMENTUM → tier2,  LIQUIDITY → tier3
//
const DENSITY_TIER1_SYMBOLS = new Set(
  (process.env.DENSITY_TIER1_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
);

// ─── Hot candidate lifecycle ──────────────────────────────────────
//
// A symbol becomes HOT when its volume or trade-count spike >= threshold.
// It stays HOT for HOT_CANDIDATE_EXPIRY_MS even if the spike subsides.
// After expiry it is removed from the hot list unless it spikes again.
//
const HOT_CANDIDATE_EXPIRY_MS = parseInt(process.env.HOT_CANDIDATE_EXPIRY_MS || '900000', 10); // 15 min

// Minimum multiplier (vs 24h average) for a spike to trigger HOT status
const HOT_VOLUME_SPIKE_MIN = parseFloat(process.env.HOT_VOLUME_SPIKE_MIN || '3');
const HOT_TRADE_SPIKE_MIN  = parseFloat(process.env.HOT_TRADE_SPIKE_MIN  || '3');

// Redis key for hot candidates map  { symbol: hotSince (ms timestamp) }
const DENSITY_HOT_CANDIDATES_KEY = 'density:hot-candidates';

// ─── Badge thresholds ─────────────────────────────────────────────
//
// HIGH    — bestWallPower >= this value  (relative strength "extreme")
// NEAR    — nearestWall distancePct <= this value (% from mid price)
// WHALE   — wall sizeUsd >= normalWallUsd * this multiplier
// NEW     — wall firstSeen within last N ms
//
const BADGE_HIGH_WALL_POWER  = parseFloat(process.env.BADGE_HIGH_WALL_POWER  || '0.80');
const BADGE_NEAR_DIST_PCT    = parseFloat(process.env.BADGE_NEAR_DIST_PCT    || '0.5');
const BADGE_WHALE_MULTIPLIER = parseFloat(process.env.BADGE_WHALE_MULTIPLIER || '8');
const BADGE_NEW_LIFETIME_MS  = parseInt(process.env.BADGE_NEW_LIFETIME_MS    || '90000', 10); // 90 s

// ─── Smart density score weights ─────────────────────────────────
//
// smartDensityScore = (0-100) composite that drives left-panel sort order.
//
//   WALL_POWER_W  × bestWallPower              (relative wall strength 0-1)
//   NEAR_WALL_W   × nearestWallScore           (proximity to price, 0-1)
//   VOL_SPIKE_W   × volumeSpikeScore           (spike ratio clamped to [0,1])
//   TRADE_SPIKE_W × tradeSpikeScore            (spike ratio clamped to [0,1])
//   AGE_W         × ageScore                   (lifetime of nearest wall, 0-1)
//
// Scores sum to 100 points.
//
const SMART_SCORE_WALL_POWER_W  = parseFloat(process.env.SMART_SCORE_WALL_POWER_W  || '40');
const SMART_SCORE_NEAR_WALL_W   = parseFloat(process.env.SMART_SCORE_NEAR_WALL_W   || '25');
const SMART_SCORE_VOL_SPIKE_W   = parseFloat(process.env.SMART_SCORE_VOL_SPIKE_W   || '20');
const SMART_SCORE_TRADE_SPIKE_W = parseFloat(process.env.SMART_SCORE_TRADE_SPIKE_W || '10');
const SMART_SCORE_AGE_W         = parseFloat(process.env.SMART_SCORE_AGE_W         || '5');

module.exports = {
  FUTURES_DENSITY_ENABLED,
  TRACKED_UNIVERSE_REFRESH_MS,
  TRACK_MIN_VOLUME_24H_USD,
  TRACK_MIN_ACTIVITY_SCORE,
  INCLUDE_SPOT_FOR_TRACKED_FUTURES,
  INCLUDE_SPOT_ONLY,
  FUTURES_TRACKED_SYMBOLS_REFRESH_MS,
  FUTURES_TRACKED_MAX_SYMBOLS,
  FUTURES_TRACKED_HARD_MAX_SYMBOLS,
  FUTURES_TRACKED_MIN_HOLD_MS,
  FUTURES_TRACKED_MAX_ROTATIONS_PER_CYCLE,
  FUTURES_FILTER_MAX_TRADE_COUNT_24H,
  FUTURES_FILTER_MAX_QUOTE_VOLUME_24H,
  TRACK_MIN_VOLUME_24H_USD,
  FUTURES_FORCE_INCLUDE,
  FUTURES_WALL_THRESHOLDS,
  FUTURES_MAX_WALL_DISTANCE_PCT,
  FUTURES_DIST_SCALE_PER_MULTIPLIER,
  FUTURES_DEEP_WALL_MAX_DISTANCE_PCT,
  FUTURES_DEEP_WALL_MULTIPLIER_FLAG,
  FUTURES_WALL_SCAN_MS,
  FUTURES_MIN_WALL_LIFETIME_MS,
  FUTURES_WALL_PERSISTENT_MS,
  FUTURES_WALL_MIN_QUALITY_SCORE,
  FUTURES_WALL_ABSENCE_GRACE_MS,
  FUTURES_CONFIRMED_WALL_ABSENCE_GRACE_MS,
  FUTURES_WALL_SIZE_DROP_TOLERANCE_RATIO,
  FUTURES_SNAPSHOT_MIN_GAP_MS,
  FUTURES_STARTUP_STAGGER_MS,
  FUTURES_RESYNC_COOLDOWN_MS,
  FUTURES_SNAPSHOT_LIMIT,
  FUTURES_SYMBOL_BACKOFF_BASE_MS,
  FUTURES_SYMBOL_BACKOFF_MAX_MS,
  FUTURES_CIRCUIT_BREAKER_THRESHOLD,
  FUTURES_CIRCUIT_BREAKER_WINDOW_MS,
  FUTURES_SAFE_MODE_EXIT_MS,
  SAFE_MODE_REDIS_KEY,
  FUTURES_ALL_TICKERS_KEY,
  FUTURES_ORDERBOOK_FLUSH_MS,
  FUTURES_TOP_LEVELS,
  FUTURES_RECONNECT_DELAY_MS,
  FUTURES_STATS_LOG_INTERVAL_MS,
  FUTURES_VOLUME_REFRESH_MS,
  // Category limits
  DENSITY_CORE_LIMIT,
  DENSITY_WALL_ANOMALY_LIMIT,
  DENSITY_MOMENTUM_LIMIT,
  DENSITY_LIQUIDITY_LIMIT,
  // Wall rank score weights
  WALL_SCORE_NORMALIZED_W,
  WALL_SCORE_COUNT_W,
  WALL_SCORE_NEAR_PRICE_W,
  WALL_SCORE_LIFETIME_W,
  WALL_SCORE_REFRESH_W,
  // Momentum score weights
  MOMENTUM_VOL_SPIKE_W,
  MOMENTUM_TRADE_SPIKE_W,
  MOMENTUM_PRICE_MOVE_W,
  MOMENTUM_TAKER_W,
  MOMENTUM_VOLATILITY_W,
  // Adaptive threshold
  WALL_DEPTH_RATIO,
  WALL_ANOMALY_MIN_NORM,
  MOMENTUM_MIN_SCORE,
  // Adaptive wall v3
  WALL_SCAN_DISTANCE_PCT,
  WALL_P95_MULTIPLIER,
  WALL_LOCAL_WINDOW_LEVELS,
  WALL_LOCAL_MULTIPLIER,
  WALL_MEDIAN_MULTIPLIER,
  WALL_SIMILAR_LEVELS_LIMIT,
  WALL_POWER_SOFT_MIN,
  WALL_POWER_STRONG_MIN,
  WALL_POWER_EXTREME_MIN,
  DENSITY_WALL_STATS_KEY_PREFIX,
  DENSITY_BEST_WALL_KEY_PREFIX,
  DENSITY_WALL_STATS_TTL_S,
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
  // Tier 1 symbols
  DENSITY_TIER1_SYMBOLS,
  // Hot candidates
  HOT_CANDIDATE_EXPIRY_MS,
  HOT_VOLUME_SPIKE_MIN,
  HOT_TRADE_SPIKE_MIN,
  DENSITY_HOT_CANDIDATES_KEY,
  // Badges
  BADGE_HIGH_WALL_POWER,
  BADGE_NEAR_DIST_PCT,
  BADGE_WHALE_MULTIPLIER,
  BADGE_NEW_LIFETIME_MS,
  // Smart density score weights
  SMART_SCORE_WALL_POWER_W,
  SMART_SCORE_NEAR_WALL_W,
  SMART_SCORE_VOL_SPIKE_W,
  SMART_SCORE_TRADE_SPIKE_W,
  SMART_SCORE_AGE_W,
};
