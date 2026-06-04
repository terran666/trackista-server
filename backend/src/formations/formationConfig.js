'use strict';

/**
 * formationConfig.js -- central configuration for the Formations module.
 *
 * Strategies are enabled purely via `enabledStrategies`. Adding a new strategy
 * means: (1) drop a file in ./strategies, (2) register it in the engine REGISTRY,
 * (3) add its key here. The engine itself never needs editing for new logic.
 */

const { STRATEGY_KEYS } = require('./formationTypes');

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  // -- Scan loop --
  marketType:        'futures',
  style:             'scalping',
  intervalMs:        1000,          // 1-second scan tick (price/breakout freshness)
  levelsRefreshMs:   10_000,        // rebuild 1m levels per symbol at most this often
  symbolsKey:        'symbols:active:usdt',
  tickersKey:        'futures:tickers:all',

  // -- Liquidity filter (FIRST gate -- coins below this are not analysed) --
  // Legacy scalar fields kept for backwards compat (used by diagnose / debug).
  minTrades24h:      envInt('FORMATIONS_MIN_TRADES_24H', 400_000),
  minVolume24h:      envInt('FORMATIONS_MIN_VOLUME_24H', 40_000_000),

  // Structured liquidity filter -- OR logic: pass if EITHER threshold met.
  formationLiquidityFilter: {
    enabled:         true,
    minVolume24hUsd: envInt('FORMATIONS_MIN_VOLUME_24H',  40_000_000),
    minTrades24h:    envInt('FORMATIONS_MIN_TRADES_24H',    400_000),
    mode:            'OR',        // 'OR' | 'AND'
    cacheTtlMs:      60_000,      // refresh futures:tickers:all at most once per minute
    createOnly:      true,        // liquidity only gates formation CREATE, not lifecycle
    gracePeriodMs:   600_000,     // reserved: evict only after 10 min of illiquidity
  },

  // --
  // V3 -- geometry-driven breakout-probability engine.
  // Source of every formation = Levels + Extremes tools + price structure.
  // Volume / Delta / OI / Liquidity NEVER create a formation -- they only raise
  // probability (geometry 80% / extras 20%).
  // --
  engineVersion:     'v3',

  // -- Timeframes analysed (youngest -- oldest) --
  timeframes:        ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],

  // Per-timeframe full-recompute cadence (ms). Breakout check still runs every
  // tick regardless of these. A formation spanning several tfs uses the cadence
  // of its YOUNGEST tf.
  tfCadenceMs: {
    '1m':  10_000,        // 10 s
    '5m':  30_000,        // 30 s
    '15m': 120_000,       // 2 min
    '30m': 300_000,       // 5 min
    '1h':  600_000,       // 10 min
    '4h':  1_800_000,     // 30 min
    '1d':  7_200_000,     // 2 h
  },

  // Target history depth loaded for every timeframe before pattern analysis.
  // If Redis 1m aggregation cannot provide this depth, the service backfills
  // missing candles from Binance klines and caches the result in-memory.
  tfTargetBars: {
    '1m': 200,
    '5m': 200,
    '15m': 200,
    '30m': 200,
    '1h': 200,
    '4h': 200,
    '1d': 200,
  },

  tfHistoryBackfill: {
    enabled: true,
    cacheTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 5000,
  },

  // Minimum 1m bars required to aggregate a usable tf window. Tfs that cannot be
  // built from the 48h of 1m history fall back to stored-tool levels only.
  tfMinBars: {
    '1m': 60, '5m': 60, '15m': 48, '30m': 40, '1h': 36, '4h': 10, '1d': 3,
  },
  // Bars kept per aggregated tf for structure analysis.
  tfLookbackBars:    200,

  // -- Level sources (Extremes + Levels tools). Bars-derived levels are the
  //     base; stored tools add confluence + higher-tf coverage. --
  sources: {
    barsDerived:     true,   // pivot-cluster levels from aggregated tf bars
    manualLevels:    true,   // manual-levels.json
    trackedLevels:   true,   // tracked-levels.json
    trackedExtremes: true,   // tracked-extremes.json
    redisLevels:     true,   // levels:<symbol> (MySQL-backed auto/manual)
  },
  storedLevelsRefreshMs: 30_000,  // re-read file/redis level stores at most this often

  // -- Distance gates (percent of price) --
  maxDistancePct:    5.0,   // farther than this -> do not create a formation
  approachDistancePct: 2.0, // 0.8-2%  -> APPROACHING
  readyDistancePct:  0.8,   // 0-0.8%  -> READY
  // 2--5% -- DETECTED

  // -- Level building (from Redis 1m bars) --
  barsLookback:      3000,  // last N 1m bars used to build levels
  minBarsRequired:   60,    // skip symbol if fewer bars are available
  pivotStrength:     3,     // bars on each side to qualify a swing pivot
  clusterTolPct:     0.25,  // cluster pivots within this % of each other
  minTouches:        2,     // a valid level needs >= this many touches
  maxLevelsPerSide:  6,     // cap resistances / supports considered

  // -- V2 confluence / dedup / quality gates --
  mergeTolPct:       0.2,   // levels within this % are ONE level (confluence)
  minProbability:    30,    // probability < this -> not saved (no junk formations)
  maxPerDirection:   3,     // <= 3 LONG and <= 3 SHORT formations per symbol

  // -- Breakout / structure thresholds --
  brokenMarginPct:   0.05,  // price beyond level by this % counts as "broken"
  volumeSpikeConfirm: 1.5,  // volumeSpikeRatio above this = confirmed spike
  compressionRatio:  0.7,   // recent range / older range below this = squeeze
  structureLookback: 12,    // bars used for higher-lows / lower-highs / squeeze

  // --
  // V3 -- geometry (the ONLY thing that creates a formation)
  // --
  // Approach history: price tested the level, retreated, tested again closer,
  // each reaction weaker. This is the primary preparation signal.
  minApproaches:     2,     // >= this many tests toward the level required
  maxApproaches:     6,     // consider at most the last N tests
  approachLookback:  40,    // bars scanned for approach pivots
  reactionWeakenTol: 1.05,  // each reaction <= prev * this counts as "weaker"

  // Minimum level strength (0..100 from touches + source/tf diversity) for a
  // level to be treated as a "solid" breakout setup on proximity alone (path 2
  // of the creator gate). Below this, a level needs an actual preparation
  // pattern or extreme closeness to create a formation.
  minLevelStrength:  45,

  // Only build formations on REAL anchored levels: backed by a stored tool
  // (extremes / autolevels / tracked / manual / redis) OR a bars pivot
  // confirmed on -- 2 timeframes. Lonely single-tf bars pivots (e.g. only
  // `bars:1m`) are local swings -- noise -- and never create a formation.
  requireAnchoredLevel: true,

  // Zone: a SECOND distinct level on the same side within this % of the primary
  // level -- support/resistance zone (raises probability).
  zoneTolPct:        0.6,   // second level within this % forms a zone
  zoneBonus:         8,     // probability added when a zone backs the level

  // Confluence: a level confirmed by N independent sources/tfs.
  confluenceBonusMax: 12,   // max probability added from multi-source confluence

  // Probability split (TZ): geometry 80% / extra flow signals 20%.
  geometryWeight:    0.8,
  extrasWeight:      0.2,

  // -- Lifecycle --
  // V2: no BREAKOUT phase -- once a level is broken the formation is COMPLETED
  // and removed immediately (the page shows only future opportunities).
  expireMs:          24 * 60 * 60 * 1000, // 24h TTL / EXPIRED
  maxPerSymbol:      8,      // cap stored formations per symbol

  // -- Trade plan (R-multiples) --
  stopBufferPct:     0.4,   // stop placed this % beyond the protective swing
  tp1R:              1.0,
  tp2R:              2.0,

  // --
  // Pattern Engine V1 -- visual pattern detection from tracked extremes.
  //
  // legacyEngineEnabled: false -- the V3 geometry engine (price-proximity to
  //   levels) is disabled and produces NO formations.
  // patternEngineEnabled: true  -- the new visual-pattern engine is active.
  //
  // Patterns found: DOUBLE_TOP, DOUBLE_BOTTOM (from trackedExtremes).
  // Current price is used ONLY to check breakout / invalidation -- NEVER to
  // find the pattern.
  // --
  legacyEngineEnabled:  false,
  patternEngineEnabled: true,

  patternEngine: {
    doubleExtreme: {
      enabled:                  true,

      // How close the two tops/bottoms must be (% of price)
      topBottomTolerancePct:    1.5,

      // Minimum bars between the first and second extreme
      minBarsBetweenExtremes:   20,

      // Minimum wall-clock time between extremes (null = use bars only)
      minTimeBetweenExtremesMs: null,

      // Minimum depth of the neckline vs the two tops/bottoms
      minMoveToNecklinePct:     4.0,

      // Buffer for breakout and invalidation checks
      breakoutBufferPct:        0.15,
      invalidationBufferPct:    0.15,

      // Patterns older than this are not shown
      maxPatternAgeHours:       120,
      maxPatternAgeHoursByTf: {
        '1m': 12,
        '3m': 24,
        '5m': 36,
        '15m': 72,
        '30m': 120,
        '1h': 168,
        '4h': 240,
        '1d': 720,
      },

      // Minimum extreme quality gates
      minExtremeStrength:       1.0,
      minTouches:               1,

      // Max patterns per patternType per symbol+tf (1 DT + 1 DB; best score wins)
      maxResultsPerSymbol:      1,

      // Min bars between first and second extreme (A--C span), by timeframe.
      minBarsBetweenExtremesByTf: {
        '1m': 20,
        '3m': 16,
        '5m': 12,
        '15m': 8,
        '30m': 6,
        '1h': 4,
        '4h': 3,
        '1d': 2,
      },

      // Max bars between first and second extreme (A--C span).
      // Patterns spanning more than this are rejected:
      //   - first extreme is "old" (>60% of maxPatternAgeHours window) -- OLD_LEVEL_RETEST
      //   - otherwise -- PATTERN_TOO_STRETCHED
      maxBarsBetweenExtremes:   300,

      // After the second top/bottom forms, current price must already have pulled
      // back at least this many % from the second peak/bottom to confirm the pattern.
      // Skip check when currentPrice is unavailable (null / non-finite).
      pullbackConfirmPct:       0.8,

      // Minimum combined quality score (0--100) to accept a pattern
      minPatternQuality:        55,
    },

    // --
    // Level-Based formations engine.
    //
    // Uses tracked-levels (autolevels / manual) + extreme clusters from
    // trackedExtremes as the source of truth for support / resistance.
    // Does NOT require an A-B-C extreme sequence.
    //
    // Patterns: SUPPORT_BREAKDOWN_SETUP, SUPPORT_BREAKDOWN,
    //           RESISTANCE_BREAKOUT_SETUP, RESISTANCE_BREAKOUT
    // --
    levelBased: {
      enabled: true,

      // Price must be at least this % past the level to trigger a breakdown/breakout
      breakThresholdPct:          0.2,

      // Price must be within this % of the level to trigger setup
      setupDistancePct:           3.0,

      // Minimum touch count (extreme cluster count or tracked-level touches)
      minTouches:                 3,

      // Minimum level strength for support/resistance acceptance
      minStrength:                3,

      // Minimum age for a level to be considered durable
      minLevelAgeMs:              7200000,

      // Minimal distance in bars between touches (independence check)
      minBarsBetweenTouches:      10,

      // Pivot strength and reaction window for touch/reaction extraction
      pivotStrengthBars:          2,
      reactionLookaheadBars:      12,
      reactionTargetPct:          3.0,
      minReactionPct:             0.2,

      // Level zone width tolerance
      zoneTolerancePct:           0.5,

      // Max share of touched bars where candle body crosses the level line.
      // If exceeded, level is considered visually noisy and rejected.
      maxBodyCrossRatio:          0.25,

      // Price-level matching tolerance used by TestPage visibility checks.
      levelMatchTolerancePct:     0.5,

      // Chart range hints for frontend cards
      paddingBars:                20,
      rightPaddingBars:           8,

      // Bars analyzed by timeframe (do not reduce to tiny windows)
      historyBarsByTf: {
        '1m': 300,
        '5m': 250,
        '15m': 200,
        '30m': 180,
        '1h': 150,
        '4h': 120,
        '1d': 90,
      },

      // Break confirmation requires elevated volume factor (> avg)
      minBreakVolumeFactor:       1.1,

      // Max level-based formations returned per symbol per tick
      maxResults:                 4,

      // Minimum score (0--100) to create a formation
      minScore:                   45,

      // Ignore if price broke too far past the level (stale / irrelevant)
      maxBreakdownPct:            8.0,
      maxBreakoutPct:             8.0,

      // SUPPORT_BREAKDOWN status thresholds (in % below support)
      confirmedBreakdownPct:      1.2,
      confirmedBreakoutPct:       1.2,
      retestMaxBreakdownPct:      0.6,

      // Cluster extremes within this % of each other on the same side
      extremeClusterTolerancePct: 1.5,

      // Minimum confirmed extreme-cluster strength.
      minClusterCount:            3,
      minClusterAgeBars:          30,

      // Staleness check for tracked-levels.
      // If a tracked-level's formationTimestamp is older than this, skip it.
      maxStalenessMinutes:        1440,

      // Level age lower bound (minutes)
      minLevelAgeMinutes:         30,

      // Break event requires this many bars for confirmation (reserved)
      confirmBars:                1,

      // Formation TTL
      maxPatternAgeHours:         8,
    },
  },
};

module.exports = { config };
