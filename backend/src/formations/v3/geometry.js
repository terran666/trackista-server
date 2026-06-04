'use strict';

/**
 * v3/geometry.js — the ONLY thing that creates a formation.
 *
 * Given a level and a direction, decide whether price is *preparing* to break it,
 * using pure geometry from the structure timeframe bars:
 *   • approach history — repeated tests of the level, each closer, each reaction
 *     weaker (the primary preparation signal);
 *   • structure        — higher-lows toward resistance (LONG) /
 *     lower-highs toward support (SHORT);
 *   • compression      — the swing range is shrinking (поджатие/сжатие);
 *   • zone             — a second level backs it (set upstream, scored here).
 *
 * Returns a geometry score 0..1 and the boolean gate `created`.
 */

const { findPivots } = require('./pivots');

const LONG = 'LONG';

function pctDist(a, b) { return Math.abs(a - b) / b * 100; }

/**
 * @param {Object} p
 * @param {Array}  p.bars       structure-tf bars (ascending)
 * @param {Object} p.level      unified level { price, side, strength, zone, confluenceCount }
 * @param {string} p.direction  LONG | SHORT
 * @param {number} p.price      current price
 * @param {Object} p.cfg
 */
function analyze({ bars, level, direction, price, cfg }) {
  const reasons = [];
  const isLong = direction === LONG;
  if (!Array.isArray(bars) || bars.length < cfg.minBarsRequired) {
    return { created: false, score: 0, reasons: ['insufficient_bars'] };
  }
  // Approach tests are read from a recent window; structure/compression use more.
  const approachWindow = bars.slice(-cfg.approachLookback);
  const window = bars;

  const { highs, lows } = findPivots(approachWindow, cfg.pivotStrength);

  // Tests = pivots probing toward the level.
  // LONG (resistance above): swing highs reaching up toward the level.
  // SHORT (support below): swing lows reaching down toward the level.
  const tests = (isLong ? highs : lows).slice(-cfg.maxApproaches);
  const guards = isLong ? lows : highs; // protective swings forming the structure

  // ── Approach history: each test closer to the level ───────────────────────
  let approachCount = 0;
  let tighteningOk = false;
  if (tests.length >= cfg.minApproaches) {
    const dists = tests.map(t => Math.abs(level.price - t.price));
    let closer = 1;
    for (let i = 1; i < dists.length; i++) {
      if (dists[i] <= dists[i - 1] * 1.001) closer++;
    }
    approachCount = closer;
    tighteningOk = dists[dists.length - 1] < dists[0];
    if (approachCount >= cfg.minApproaches) reasons.push(`approaches=${approachCount}`);
    if (tighteningOk) reasons.push('tightening');
  }

  // ── Reactions weakening: pullback amplitude after each test shrinks ────────
  let reactionsWeakening = false;
  if (guards.length >= 2) {
    const amps = [];
    for (let i = 1; i < guards.length; i++) {
      amps.push(Math.abs(guards[i].price - guards[i - 1].price));
    }
    let weak = true;
    for (let i = 1; i < amps.length; i++) {
      if (amps[i] > amps[i - 1] * cfg.reactionWeakenTol) { weak = false; break; }
    }
    reactionsWeakening = weak && amps.length >= 1;
    if (reactionsWeakening) reasons.push('reactions_weakening');
  }

  // ── Structure: higher-lows (LONG) / lower-highs (SHORT) ───────────────────
  let structureAligned = false;
  const struct = (isLong ? lows : highs).slice(-3);
  if (struct.length >= 2) {
    structureAligned = true;
    for (let i = 1; i < struct.length; i++) {
      if (isLong && struct[i].price <= struct[i - 1].price) structureAligned = false;
      if (!isLong && struct[i].price >= struct[i - 1].price) structureAligned = false;
    }
    if (structureAligned) reasons.push(isLong ? 'higher_lows' : 'lower_highs');
  }

  // ── Compression: recent range shrinking vs older range ────────────────────
  let compression = false;
  let compressionRatioVal = 1;
  const lb = cfg.structureLookback;
  if (window.length >= lb * 2) {
    const older = window.slice(-lb * 2, -lb);
    const recent = window.slice(-lb);
    const rng = arr => Math.max(...arr.map(b => b.high)) - Math.min(...arr.map(b => b.low));
    const oR = rng(older), rR = rng(recent);
    if (oR > 0) {
      compressionRatioVal = rR / oR;
      compression = compressionRatioVal <= cfg.compressionRatio;
      if (compression) reasons.push(`compression=${compressionRatioVal.toFixed(2)}`);
    }
  }

  // ── Distance closeness (the closer to the level, the more "ready") ─────────
  const dPct = pctDist(price, level.price);
  const closeness = Math.max(0, 1 - dPct / cfg.maxDistancePct);
  const strengthNorm = Math.max(0, Math.min(1, (level.strength || 0) / 100));

  // ── CREATOR GATE ──────────────────────────────────────────────────────────
  // A formation is created when a real level is genuinely IN PLAY. Three paths:
  //   1. a preparation pattern is forming within range (approach history /
  //      higher-lows-lower-highs / compression / weakening reactions), OR
  //   2. price is pressed against a strong, repeatedly-tested level — proximity
  //      to a solid level IS a breakout setup, even without a textbook coil, OR
  //   3. price is extremely close to any qualified level (imminent test).
  // Far + weak + no-signal levels never create (→ low_probability / too_far).
  const hasApproach = approachCount >= cfg.minApproaches;
  const anyPrep     = hasApproach || structureAligned || compression || reactionsWeakening;
  const strongLevel = (level.strength || 0) >= (cfg.minLevelStrength ?? 45);
  const near        = dPct <= cfg.approachDistancePct;
  const veryClose   = dPct <= cfg.readyDistancePct;
  const created =
    (anyPrep && dPct <= cfg.maxDistancePct) ||
    (near && strongLevel) ||
    veryClose;

  // ── Geometry score 0..1 (weighted; this is the 80% half of probability) ───
  // Proximity + level strength form the BASE (a clear level near price is the
  // core breakout setup); the coil signals (approach / tightening / structure /
  // compression / weakening reactions) add conviction on top.
  const score =
      0.30 * closeness +
      0.20 * strengthNorm +
      0.18 * (hasApproach ? Math.min(approachCount / cfg.maxApproaches, 1) : 0) +
      0.10 * (tighteningOk ? 1 : 0) +
      0.10 * (structureAligned ? 1 : 0) +
      0.07 * (compression ? Math.min((cfg.compressionRatio - compressionRatioVal) / cfg.compressionRatio + 0.4, 1) : 0) +
      0.05 * (reactionsWeakening ? 1 : 0);

  return {
    created,
    score: Math.max(0, Math.min(1, score)),
    distancePct: dPct,
    closeness,
    approachCount,
    tighteningOk,
    structureAligned,
    compression,
    compressionRatio: compressionRatioVal,
    reactionsWeakening,
    reasons,
  };
}

module.exports = { analyze };
