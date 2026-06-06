'use strict';

/**
 * formationPatternConfig.js
 * Configuration for the new Extreme Pattern Formations system (v1).
 * v1 scope: horizontal Sharp Extremes only.
 * Vertical/diagonal extremes explicitly disabled.
 */

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const patternConfig = {
  enabled: true,

  // Source of levels
  levelSource: 'sharp-extremes', // ONLY sharp-extremes in v1
  verticalExtremesEnabled: false, // explicitly disabled
  diagonalExtremesEnabled: false, // explicitly disabled

  // Timeframes to scan
  timeframes: ['1m', '5m', '15m', '30m', '1h', '4h'],

  // Liquidity gate (same as existing formations module)
  minVolume24hUsd: envInt('FORMATIONS_MIN_VOLUME_24H', 70_000_000),
  minTrades24h:    envInt('FORMATIONS_MIN_TRADES_24H',    900_000),

  // Per-TF: how many bars we try to load
  tfTargetBars: {
    '1m':  300,
    '5m':  300,
    '15m': 300,
    '30m': 300,
    '1h':  300,
    '4h':  300,
  },

  // Candle durations in ms (used to detect new bar close)
  tfDurationMs: {
    '1m':    60_000,
    '5m':   300_000,
    '15m':  900_000,
    '30m': 1_800_000,
    '1h':  3_600_000,
    '4h': 14_400_000,
  },

  // How often each TF gets a full rescan (after bar-close event)
  // Minimum interval so we don't hammer the system
  tfCooldownMs: {
    '1m':    60_000,
    '5m':   300_000,
    '15m':  900_000,
    '30m': 1_800_000,
    '1h':  3_600_000,
    '4h': 14_400_000,
  },

  // Heartbeat interval (lightweight lifecycle-only check)
  heartbeatMs: 2_000,

  // Sharp Extremes cache TTL in ms (re-read from file store at most this often)
  extremesCacheTtlMs: 10_000,

  // Enabled detectors
  enabledPatterns: {
    ASCENDING_TRIANGLE:        true,
    DESCENDING_TRIANGLE:       true,
    RANGE_RESISTANCE_BREAKOUT: true,
    RANGE_SUPPORT_BREAKDOWN:   true,
    COMPRESSION_TO_RESISTANCE: true,
    COMPRESSION_TO_SUPPORT:    true,
    BULL_FLAG:                 false,  // Phase 2
    BEAR_FLAG:                 false,  // Phase 2
  },

  filters: {
    minTouches:              2,
    minBarsInsidePattern:    8,
    maxDistanceToExtremePct: 3.0,
    breakoutBufferPct:       0.15,
    minScore:                30,
    requireMultiTf:          false,
  },

  // Adaptive tolerance
  tolerance: {
    minPct:                  0.2,
    defaultPct:              1.0,
    maxPct:                  3.0,
    volatilityLookbackBars:  50,
    volatilityMultiplier:    1.5,
  },

  // Breakout detection
  breakout: {
    bufferPct:       0.15,   // price must exceed level by this % (confirmed breakout)
    confirmBars:     1,      // close must be beyond level for this many bars
    retestTolerancePct: 0.5, // how close to return to level to count as retest
  },

  // Redis TTL by TF
  redisTtlMs: {
    '1m':   6 * 3_600_000,
    '5m':   6 * 3_600_000,
    '15m': 12 * 3_600_000,
    '30m': 12 * 3_600_000,
    '1h':  24 * 3_600_000,
    '4h':  72 * 3_600_000,
  },

  // Max formations per symbol
  maxPerSymbol: 20,

  // Binance REST guard
  binanceRest: {
    maxRequestsPerMinute: 30,
    cooldownOn429Ms: 60_000,
    cooldownOn418Ms: 20 * 60_000,
    backoffBase:     1_000,
  },
};

module.exports = { patternConfig };
