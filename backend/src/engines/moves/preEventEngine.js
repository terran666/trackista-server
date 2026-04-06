'use strict';

/**
 * preEventEngine — pure functions for computing pre-event readiness signals.
 *
 * Readiness score 0–100, broken into weighted components:
 *   impulse      25 pts
 *   inPlay       15 pts
 *   volSpike     15 pts
 *   delta imb    15 pts
 *   distance     20 pts  (how close we are to alert threshold)
 *   wall align   10 pts
 */

const { computePriceChange } = require('./moveDetectionEngine');
const { computeWallContext  } = require('./wallContextEngine');

const READINESS_MIN_SCORE    = parseInt(process.env.PRESIGNAL_MIN_SCORE     || '25',  10);
const PRIMARY_WINDOW_LABEL   = process.env.PRESIGNAL_PRIMARY_WINDOW         || '5m';

/**
 * Compute a pre-event signal for a symbol.
 *
 * @param {object} opts
 * @param {string}                          opts.symbol
 * @param {Array<{ts:number,price:number}>} opts.priceHistory
 * @param {number}                          opts.currentPrice
 * @param {object|null}                     opts.metrics
 * @param {object|null}                     opts.signal
 * @param {object|null}                     opts.walls
 * @param {Array<{label,secs,threshold}>}   opts.windowConfigs
 * @param {number}                          opts.nowMs
 * @returns {object|null}   — null when readiness is below threshold
 */
function computePreSignal({ symbol, priceHistory, currentPrice, metrics, signal, walls, windowConfigs, nowMs }) {
  if (!signal?.baselineReady || !currentPrice || !priceHistory?.length) return null;

  const now     = nowMs || Date.now();
  const wallCtx = computeWallContext(walls, currentPrice);

  // ── Direction bias from impulse + price history ──────────────────
  let directionBias = 'neutral';
  let maxUpPct  = 0;
  let maxDownPct = 0;

  for (const win of windowConfigs) {
    const ch = computePriceChange(priceHistory, win.secs, currentPrice, now);
    if (!ch) continue;
    if (ch.movePct > 0) maxUpPct   = Math.max(maxUpPct,   ch.movePct);
    else                maxDownPct = Math.max(maxDownPct, -ch.movePct);
  }

  const impulseDir = signal.impulseDirection;
  if      (impulseDir === 'up'   && signal.impulseScore > 100) directionBias = 'up';
  else if (impulseDir === 'down' && signal.impulseScore > 100) directionBias = 'down';
  else if (maxUpPct   > maxDownPct * 1.5)                      directionBias = 'up';
  else if (maxDownPct > maxUpPct  * 1.5)                       directionBias = 'down';

  // ── Components ───────────────────────────────────────────────────
  // 1. Impulse (25 pts) — normalized at 600 = very high
  const impulseComp = Math.min(25, (signal.impulseScore  || 0) / 600 * 25);

  // 2. InPlay (15 pts) — normalized at 1000
  const inPlayComp  = Math.min(15, (signal.inPlayScore   || 0) / 1000 * 15);

  // 3. Volume spike 15s (15 pts) — 1× = 0 pts, 5× = 15 pts
  const volSpikeComp = Math.min(15, Math.max(0, ((signal.volumeSpikeRatio15s || 1) - 1) / 4 * 15));

  // 4. Delta imbalance (15 pts) — |delta/vol| 0→0pts, 0.5→15pts
  const deltaImb    = Math.abs(signal.deltaImbalancePct60s || 0);
  const deltaComp   = Math.min(15, deltaImb / 0.5 * 15);

  // 5. Distance to threshold (20 pts) — inversely proportional to remaining distance
  const primaryCfg  = windowConfigs.find(w => w.label === PRIMARY_WINDOW_LABEL) || windowConfigs[2];
  const primaryCh   = computePriceChange(priceHistory, primaryCfg.secs, currentPrice, now);
  let distanceComp  = 0;
  let distanceToCond = null;

  if (primaryCh) {
    const currentPct   = Math.abs(primaryCh.movePct);
    const threshold    = primaryCfg.threshold;
    distanceToCond     = threshold - currentPct;         // negative means already crossed
    if (distanceToCond <= 0) {
      distanceComp = 20;                                  // already past threshold
    } else {
      distanceComp = Math.min(20, (1 - distanceToCond / threshold) * 20);
    }
  }

  // 6. Wall alignment (10 pts)
  let wallComp = 0;
  if      (directionBias === 'up'   && wallCtx.wallBias === 'bid-heavy') wallComp = 10;
  else if (directionBias === 'down' && wallCtx.wallBias === 'ask-heavy') wallComp = 10;
  else if (wallCtx.wallBias !== 'neutral')                               wallComp = 5;

  const readinessScore = Math.round(
    impulseComp + inPlayComp + volSpikeComp + deltaComp + distanceComp + wallComp,
  );

  if (readinessScore < READINESS_MIN_SCORE) return null;

  // ── Signal classification ────────────────────────────────────────
  let signalType = directionBias === 'down' ? 'PRE_DUMP_SIGNAL' : 'PRE_PUMP_SIGNAL';

  if (wallCtx.nearestAskWallDistancePct !== null && wallCtx.nearestAskWallDistancePct < 0.5) {
    signalType = 'PRE_BREAKOUT_SIGNAL';
  } else if (wallCtx.nearestBidWallDistancePct !== null && wallCtx.nearestBidWallDistancePct < 0.5) {
    signalType = 'PRE_BOUNCE_SIGNAL';
  }

  // ── Acceleration state ───────────────────────────────────────────
  const vsr   = signal.volumeSpikeRatio15s || 1;
  const accel = signal.tradeAcceleration   || 1;
  let accelerationState = 'neutral';
  if      (vsr >= 3   && accel >= 3)     accelerationState = 'accelerating';
  else if (vsr >= 1.5 && accel >= 1.5)   accelerationState = 'building';
  else if (vsr < 1    && accel < 1)      accelerationState = 'decelerating';

  // ── Volatility state ─────────────────────────────────────────────
  const vel = Math.abs(signal.priceVelocity60s || 0);
  const volatilityState = vel > 0.05 ? 'elevated' : vel > 0.02 ? 'normal' : 'compressed';

  // ── Cause tags ───────────────────────────────────────────────────
  const causeTags = [];
  if (signal.volumeSpikeRatio15s >= 2)            causeTags.push('volume-driven');
  if (deltaImb > 0.3)                             causeTags.push('delta-driven');
  if (signal.impulseScore  > 200)                 causeTags.push('impulse-driven');
  if (wallCtx.wallBounceChance > 50)              causeTags.push('wall-bounce');
  if (wallCtx.wallBreakRisk   > 50)               causeTags.push('wall-break');
  if (directionBias !== 'neutral')                causeTags.push(`${directionBias}-bias`);

  const confidenceScore = Math.min(100, Math.round(
    readinessScore * 0.6 + (signal.signalConfidence || 0) * 0.4,
  ));

  return {
    symbol,
    ts                      : now,
    signalType,
    directionBias,
    readinessScore,
    confidenceScore,
    distanceToConditionPct  : distanceToCond !== null ? round(distanceToCond, 4) : null,
    distanceToWallPct       : directionBias === 'up'
      ? wallCtx.nearestAskWallDistancePct
      : wallCtx.nearestBidWallDistancePct,
    accelerationState,
    wallBias                : wallCtx.wallBias,
    wallBounceChance        : wallCtx.wallBounceChance,
    wallBreakRisk           : wallCtx.wallBreakRisk,
    volatilityState,
    causeTags,
    // Raw inputs for transparency
    impulseScore            : signal.impulseScore,
    inPlayScore             : signal.inPlayScore,
    volumeSpikeRatio15s     : signal.volumeSpikeRatio15s,
    deltaImbalancePct60s    : signal.deltaImbalancePct60s,
  };
}

function round(v, dec) {
  const m = 10 ** dec;
  return Math.round(v * m) / m;
}

// ─────────────────────────────────────────────────────────────────────────────
// computePreSignalV2 — Phase 2 quality upgrade
//   Adds derivatives alignment, persistence bonus, noise penalties,
//   readinessLabel, and separate raw/adjusted scores.
//
// New params vs computePreSignal:
//   opts.derivatives  {object|null}  — parsed derivatives:<SYM> context
//   opts.persistenceMs {number}      — how long this symbol has had a score
//                                      at/above MIN_SCORE (managed by caller)
//   opts.prevScore   {number|null}   — previous readiness score (for trend)
// ─────────────────────────────────────────────────────────────────────────────
const PERSIST_BONUS_MS    = parseInt(process.env.PRESIGNAL_PERSIST_BONUS_MS  || '15000', 10);
const PERSIST_BONUS_PTS   = parseInt(process.env.PRESIGNAL_PERSIST_BONUS_PTS || '5',     10);
const DERIV_ALIGN_PTS     = parseInt(process.env.PRESIGNAL_DERIV_ALIGN_PTS   || '10',    10);
const NOISE_JUMP_THRESHOLD= parseFloat(process.env.PRESIGNAL_NOISE_JUMP      || '25');

function computePreSignalV2(opts) {
  const {
    derivatives   = null,
    persistenceMs = 0,
    prevScore     = null,
    ...baseOpts
  } = opts;

  // Run v1 engine first
  const base = computePreSignal(baseOpts);
  if (!base) return null;

  const rawReadinessScore  = base.readinessScore;
  let   adjustedScore      = rawReadinessScore;
  const debugReasons       = [];
  let   noisePenalty       = 0;

  // ── Derivatives alignment bonus/penalty ──────────────────────────
  let derivAlignBonus = 0;
  if (derivatives) {
    const alignment = derivatives.directionAlignment ?? 0; // -10..+10
    const bias      = base.directionBias;                  // 'up'|'down'|'neutral'
    if (bias === 'up'   && alignment > 0) {
      derivAlignBonus = Math.round(DERIV_ALIGN_PTS * (alignment / 10));
      debugReasons.push(`derivatives align up +${derivAlignBonus}pts`);
    } else if (bias === 'down' && alignment < 0) {
      derivAlignBonus = Math.round(DERIV_ALIGN_PTS * (Math.abs(alignment) / 10));
      debugReasons.push(`derivatives align down +${derivAlignBonus}pts`);
    } else if (alignment !== 0) {
      // Contradiction
      const penalty = Math.round(5 * (Math.abs(alignment) / 10));
      noisePenalty += penalty;
      debugReasons.push(`derivatives contradict direction -${penalty}pts`);
    }
  }

  // ── Wall bias contradiction penalty ──────────────────────────────
  const wb = base.wallBias;
  if (base.directionBias === 'up'   && wb === 'ask-heavy') {
    noisePenalty += 8;
    debugReasons.push('wall bias contradicts up move -8pts');
  } else if (base.directionBias === 'down' && wb === 'bid-heavy') {
    noisePenalty += 8;
    debugReasons.push('wall bias contradicts down move -8pts');
  }

  // ── Score jump without volume (noise) ────────────────────────────
  if (prevScore !== null && rawReadinessScore - prevScore > NOISE_JUMP_THRESHOLD) {
    const volSpike = opts.signal?.volumeSpikeRatio15s || 1;
    if (volSpike < 1.5) {
      const penalty = Math.round((rawReadinessScore - prevScore - NOISE_JUMP_THRESHOLD) * 0.5);
      const capped  = Math.min(25, penalty);
      noisePenalty += capped;
      debugReasons.push(`score jump without volume -${capped}pts`);
    }
  }

  // ── Persistence bonus ─────────────────────────────────────────────
  let persistBonus = 0;
  if (persistenceMs >= PERSIST_BONUS_MS) {
    persistBonus = PERSIST_BONUS_PTS;
    debugReasons.push(`persistence ${Math.round(persistenceMs / 1000)}s +${persistBonus}pts`);
  }

  adjustedScore = Math.max(0, Math.min(100,
    rawReadinessScore + derivAlignBonus + persistBonus - noisePenalty,
  ));

  // ── Readiness label ───────────────────────────────────────────────
  let readinessLabel;
  if      (adjustedScore >= 80) readinessLabel = 'very-strong';
  else if (adjustedScore >= 60) readinessLabel = 'strong';
  else if (adjustedScore >= 40) readinessLabel = 'building';
  else                          readinessLabel = 'weak';

  // ── Score trend ───────────────────────────────────────────────────
  let scoreTrend = 'flat';
  if (prevScore !== null) {
    const delta = adjustedScore - prevScore;
    if      (delta >= 10)  scoreTrend = 'rising';
    else if (delta <= -10) scoreTrend = 'falling';
    else if (delta > 0)    scoreTrend = 'slightly-rising';
    else if (delta < 0)    scoreTrend = 'slightly-falling';
  }

  return {
    ...base,
    // v2 additions:
    rawReadinessScore,
    adjustedReadinessScore : adjustedScore,
    readinessScore         : adjustedScore,   // override so callers get adjusted
    readinessLabel,
    scoreTrend,
    noisePenalty,
    persistenceMs,
    derivAlignBonus,
    debugReasons,
    derivativesBias        : derivatives?.derivativesBias          ?? null,
    derivativesConfidence  : derivatives?.derivativesConfidence    ?? null,
    squeezeRisk            : derivatives?.squeezeRisk              ?? null,
  };
}

module.exports = { computePreSignal, computePreSignalV2, READINESS_MIN_SCORE };
