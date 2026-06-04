'use strict';

/**
 * formationPatternEngine.js — visual-pattern formation engine.
 *
 * Unlike the V3 geometry engine (price proximity to levels), this engine
 * finds structural patterns in trackedExtremes data:
 *   - Double Top  (High → Low → High)
 *   - Double Bottom (Low → High → Low)
 *
 * Current price is NEVER used to find a pattern — only to check
 * breakout / invalidation state after the pattern is found.
 *
 * Usage:
 *   const pe = createPatternEngine(config.patternEngine);
 *   const result = pe.run({ symbol, marketType, extremes, currentPrice });
 */

const doubleExtremeStrategy = require('./strategies/doubleExtremeStrategy');
const levelBasedStrategy    = require('./strategies/levelBasedStrategy');

const REGISTRY = {
  [doubleExtremeStrategy.key]: doubleExtremeStrategy,
  [levelBasedStrategy.key]:    levelBasedStrategy,
};

/**
 * @param {object} patternConfig — config.patternEngine from formationConfig.js
 */
function createPatternEngine(patternConfig = {}) {
  const cfg = patternConfig;

  /**
   * Run all enabled strategies across one symbol slice.
   *
   * @param {object} params
   * @param {string}   params.symbol
   * @param {string}   params.marketType
   * @param {object[]} params.extremesByTf  — Map<tf, extreme[]> or plain array of extremes
  * @param {number}   params.currentPrice
  * @param {object}   params.marketMetrics
  * @param {Map}      params.tfBars
   * @param {object[]} params.storedLevels  — non-extreme stored levels (tracked + manual)
   * @returns {{ candidates: object[], debugByTf: object, totalExtremes: number }}
   */
  function run({ symbol, marketType, extremesByTf, currentPrice, storedLevels, marketMetrics, tfBars }) {
    const allCandidates = [];
    const debugByTf     = {};
    const statsByTf     = {};

    // extremesByTf is a Map<tf, extreme[]>
    const tfMap = extremesByTf instanceof Map
      ? extremesByTf
      : _groupByTf(Array.isArray(extremesByTf) ? extremesByTf : []);

    let totalExtremes = 0;
    for (const [, arr] of tfMap) totalExtremes += arr.length;

    for (const [tf, extremes] of tfMap) {
      const tfDebug = { extremesLoaded: extremes.length, sequences: [] };
      debugByTf[tf] = tfDebug;

      // doubleExtreme strategy
      if (cfg.doubleExtreme?.enabled !== false) {
        const { candidates, debugLog, stats } = doubleExtremeStrategy.evaluate({
          symbol, marketType, tf, extremes, currentPrice,
          cfg: { ...DEFAULT_DOUBLE_EXTREME_CFG, ...(cfg.doubleExtreme || {}) },
        });
        tfDebug.sequences.push(...debugLog);
        statsByTf[tf] = stats || { tf, extremesTotal: extremes.length, validPrice: 0, rejectedPrice: 0, rejectedQuality: 0, filteredByBarsDistance: 0, patternsCreated: candidates.length };
        allCandidates.push(...candidates);
      }
    }

    // ── Level-based strategy (runs once per symbol, not per-tf) ──────────────
    if (cfg.levelBased?.enabled !== false) {
      const { candidates: lbCandidates, debugLog: lbDebug } = levelBasedStrategy.evaluate({
        symbol, marketType,
        extremesByTf: tfMap,
        tfBars,
        storedLevels: storedLevels || [],
        currentPrice,
        marketMetrics,
        cfg: { ...(cfg.levelBased || {}) },
      });
      allCandidates.push(...lbCandidates);
      debugByTf._levelBased = { sequences: lbDebug };
    }

    // Dedup by fingerprint across all tfs (keep first / best score)
    const seen = new Map();
    const deduped = [];
    for (const c of allCandidates) {
      const prev = seen.get(c.fingerprint);
      if (!prev || c.score > prev.score) {
        seen.set(c.fingerprint, c);
      }
    }
    for (const c of seen.values()) deduped.push(c);

    return { candidates: deduped, debugByTf, statsByTf, totalExtremes };
  }

  /**
   * Debug run: returns full diagnostic info without persisting.
   */
  function diagnose({ symbol, marketType, extremesByTf, currentPrice, storedLevels, marketMetrics, tfBars }) {
    const result = run({ symbol, marketType, extremesByTf, currentPrice, storedLevels, marketMetrics, tfBars });
    // Build high/low breakdown per tf for the debug endpoint
    const tfSummary = {};
    const tfMap = extremesByTf instanceof Map
      ? extremesByTf
      : _groupByTf(Array.isArray(extremesByTf) ? extremesByTf : []);
    for (const [tf, extremes] of tfMap) {
      const highs = extremes.filter(e => {
        const s = (e.side || '').toLowerCase();
        return s === 'resistance' || s === 'high';
      });
      const lows = extremes.filter(e => {
        const s = (e.side || '').toLowerCase();
        return s === 'support' || s === 'low';
      });
      tfSummary[tf] = {
        total:  extremes.length,
        highs:  highs.length,
        lows:   lows.length,
        highPrices: highs.map(e => e.price).sort((a, b) => b - a).slice(0, 10),
        lowPrices:  lows.map(e => e.price).sort((a, b) => a - b).slice(0, 10),
      };
    }
    return { ...result, tfSummary };
  }

  return { run, diagnose };
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DOUBLE_EXTREME_CFG = {
  enabled:                 true,
  topBottomTolerancePct:   1.5,
  minBarsBetweenExtremes:  12,
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
  minTimeBetweenExtremesMs: null,
  minMoveToNecklinePct:    4.0,
  breakoutBufferPct:       0.15,
  invalidationBufferPct:   0.15,
  maxPatternAgeHours:      120,
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
  minExtremeStrength:      1.0,
  minTouches:              1,
  maxResultsPerSymbol:     5,
  minPatternQuality:       55,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _groupByTf(extremes) {
  const map = new Map();
  for (const e of extremes) {
    const tf = e.tf || 'unknown';
    if (!map.has(tf)) map.set(tf, []);
    map.get(tf).push(e);
  }
  return map;
}

module.exports = { createPatternEngine, DEFAULT_DOUBLE_EXTREME_CFG };
