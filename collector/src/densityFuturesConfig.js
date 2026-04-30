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
};
