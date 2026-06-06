'use strict';

/**
 * formationPatternScorer.js
 * Computes a 0–100 score for a formation candidate.
 *
 * Score components:
 *   closeness      (20) — how tight distance to level is
 *   touches        (25) — number of confirmed touches
 *   barsInside     (15) — duration of pattern (more = more reliable)
 *   compression    (15) — range tightening into the level
 *   volume         (10) — volume trend
 *   higherLows     (10) — structural confirmation (LONG) / lower-highs (SHORT)
 *   multiTf        ( 5) — same pattern confirmed on another TF
 */

/**
 * @param {object} features
 * @param {number} features.distancePct         current distance to level (%)
 * @param {number} features.effectiveTolPct     adaptive tolerance upper bound
 * @param {number} features.touches             confirmed touches
 * @param {number} features.barsInside          bars within pattern
 * @param {number} features.compressionPct      0..100 (100 = max tightening)
 * @param {number} features.volumeGrowthPct     0..100
 * @param {boolean} features.structureAligned   higher-lows or lower-highs
 * @param {boolean} features.multiTfConfirmed
 * @returns {number} 0–100 score
 */
function computePatternScore(features) {
  const {
    distancePct        = 0,
    effectiveTolPct    = 1,
    touches            = 0,
    barsInside         = 0,
    compressionPct     = 0,
    volumeGrowthPct    = 0,
    structureAligned   = false,
    multiTfConfirmed   = false,
  } = features;

  // closeness: 1 when distance=0, 0 when distance=tolerance
  const closeness = Math.max(0, 1 - distancePct / Math.max(effectiveTolPct, 0.01));

  // touches: 2=min→0.3, 5→0.8, 8→1.0 (log-scaled)
  const touchScore = Math.min(1, Math.max(0, (Math.log2(Math.max(touches, 1)) - 1) / 2));

  // barsInside: 8=min→0, 50→0.7, 100→1.0
  const barsScore = Math.min(1, Math.max(0, barsInside / 80));

  // compressionPct: raw 0–100 → 0–1
  const compScore = Math.min(1, Math.max(0, compressionPct / 100));

  // volumeGrowthPct: raw 0–100 → 0–1
  const volScore = Math.min(1, Math.max(0, volumeGrowthPct / 100));

  const structScore   = structureAligned  ? 1 : 0;
  const multiTfScore  = multiTfConfirmed  ? 1 : 0;

  const raw = (
    closeness    * 20 +
    touchScore   * 25 +
    barsScore    * 15 +
    compScore    * 15 +
    volScore     * 10 +
    structScore  * 10 +
    multiTfScore *  5
  );

  return Math.round(Math.min(100, Math.max(0, raw)));
}

/**
 * Compute adaptive tolerance in % based on recent bar volatility.
 */
function computeAdaptiveTolerance(bars, config) {
  const { minPct = 0.2, maxPct = 3.0, defaultPct = 1.0,
          volatilityLookbackBars = 50, volatilityMultiplier = 1.5 } = config.tolerance || {};

  const slice = bars.slice(-volatilityLookbackBars);
  if (slice.length < 5) return defaultPct;

  const avgRange = slice.reduce((sum, b) => {
    const range = (b.high - b.low) / Math.max(b.close, 0.000001) * 100;
    return sum + range;
  }, 0) / slice.length;

  const tol = avgRange * volatilityMultiplier;
  return Math.max(minPct, Math.min(maxPct, tol));
}

module.exports = { computePatternScore, computeAdaptiveTolerance };
