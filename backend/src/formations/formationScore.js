'use strict';

/**
 * formationScore.js — probability + score helpers.
 *
 * probability (0–100): each strategy's estimate that the level breaks soon.
 *   It is NOT a hard creation filter — it is used for sorting / colour / rating.
 * score: for the MVP, score === probability.
 */

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round(n, d = 2) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Compute breakout probability from the building blocks every strategy shares.
 * `weights` lets each strategy emphasise the signal it specialises in.
 *
 * @param {object} parts
 *   distancePct, maxDistancePct, touches, strength, signals{...}
 * @param {object} weights  per-component weight (defaults below)
 * @returns {number} 0–100
 */
function computeProbability(parts, weights = {}) {
  const w = {
    closeness:   18, // how near price is to the level
    strength:    14, // level strength / touches
    structure:   16, // higher-lows (LONG) / lower-highs (SHORT)
    compression: 12, // range squeeze toward the level
    volume:      14, // volume spike building
    delta:       12, // aggressive flow in the breakout direction
    oi:          8,  // open interest rising
    liquidity:   6,  // resting liquidity behind the level
    ...weights,
  };

  const s = parts.signals || {};

  // closeness: 1 at the level, 0 at maxDistance
  const maxD = parts.maxDistancePct || 5;
  const closeness = clamp(1 - (parts.distancePct / maxD), 0, 1);

  // strength: touches scaled (2 touches ~0.3, 5+ ~1.0)
  const touchScore = clamp((parts.touches - 2) / 4 + 0.3, 0, 1);
  const strengthScore = clamp(((parts.strength || 0) / 12), 0, 1);
  const strength = clamp((touchScore * 0.6 + strengthScore * 0.4), 0, 1);

  const structure   = s.structureAligned ? 1 : 0;
  const compression = s.compression ? clamp(s.compressionScore ?? 1, 0, 1) : 0;
  const volume      = s.volumeSpike ? clamp(s.volumeScore ?? 1, 0, 1) : 0;
  const delta       = s.deltaAligned ? clamp(s.deltaScore ?? 1, 0, 1) : 0;
  const oi          = s.oiRising ? 1 : 0;
  const liquidity   = s.liquidityBehindLevel ? 1 : 0;

  const totalW =
    w.closeness + w.strength + w.structure + w.compression +
    w.volume + w.delta + w.oi + w.liquidity;

  const raw =
    w.closeness   * closeness +
    w.strength    * strength +
    w.structure   * structure +
    w.compression * compression +
    w.volume      * volume +
    w.delta       * delta +
    w.oi          * oi +
    w.liquidity   * liquidity;

  return clamp((raw / totalW) * 100, 0, 100);
}

// ─── V2 confluence / multi-signal scoring ────────────────────────────────────

/**
 * MULTI SIGNAL BONUS — reward stacking of independent breakout drivers
 * (compression + volume + delta + OI). 1 signal → +0, 2 → +5, 3 → +10, 4 → +20.
 */
function multiSignalBonus(count) {
  if (count >= 4) return 20;
  if (count === 3) return 10;
  if (count === 2) return 5;
  return 0;
}

/**
 * CONFLUENCE bonus — several independent strategies agreeing on the same level
 * raises the breakout probability. +5 per extra strategy, capped at +20.
 */
function confluenceStrategyBonus(strategyCount) {
  return clamp((strategyCount - 1) * 5, 0, 20);
}

/**
 * LEVEL STRENGTH (0–100) — how important the level is, from touches + sources +
 * extremes. The stronger the level, the more meaningful its potential breakout.
 */
function computeLevelStrength(level) {
  const touches = level.touches || 0;
  const sources = Array.isArray(level.sources) ? level.sources.length : 1;
  const extremes = level.extremes ?? touches; // pivot clusters are swing extremes
  const touchesPart  = clamp((touches - 2) / 4, 0, 1);   // 2→0 … 6→1
  const sourcesPart  = clamp((sources - 1) / 2, 0, 1);   // 1→0 … 3→1
  const extremesPart = clamp(extremes / 5, 0, 1);        // 0…5+
  return round((touchesPart * 0.5 + sourcesPart * 0.2 + extremesPart * 0.3) * 100, 1);
}

/**
 * CONFLUENCE SCORE (0–100) — how many independent confirmations back the level:
 * sources (tracked / manual / extremes) + timeframes (1m / 5m / 15m / 1h) +
 * agreeing strategies.
 */
function computeConfluenceScore(level, strategyCount = 1) {
  const srcCount = Array.isArray(level.sources)  ? level.sources.length  : 1;
  const tfCount  = Array.isArray(level.tfSource) ? level.tfSource.length : 1;
  return round(clamp((srcCount + tfCount + strategyCount) / 9, 0, 1) * 100, 1);
}

module.exports = {
  clamp,
  round,
  computeProbability,
  multiSignalBonus,
  confluenceStrategyBonus,
  computeLevelStrength,
  computeConfluenceScore,
};
