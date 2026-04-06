'use strict';
/**
 * rankingEngine.js — Phase 2
 * Pure functions for computing happened-rank and building-rank scores.
 *
 * Happened rank  — quality score for a completed/active move event.
 * Building rank  — priority score for a pre-signal about to trigger.
 *
 * Both return 0-100, a label, and a per-component breakdown.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function safe  (v)         { return typeof v === 'number' && isFinite(v) ? v : 0; }

function rankLabel(score) {
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

// ─────────────────────────────────────────────────────────────────────────────
// computeHappenedRank
//   event       — move_events row / live event object
//   metrics     — parsed metrics:<SYM>
//   signal      — parsed signal:<SYM>
//   derivatives — parsed derivatives:<SYM>  (nullable)
// ─────────────────────────────────────────────────────────────────────────────
function computeHappenedRank(event, metrics, signal, derivatives) {
  const breakdown = {};
  let total = 0;

  // 1. Move magnitude (20 pts) — steeper = better
  const movePct = Math.abs(safe(event.movePct));
  const movePts = clamp(Math.round(movePct / 0.5 * 4), 0, 20); // 5% → 20pts
  breakdown.moveMagnitude = movePts;
  total += movePts;

  // 2. Duration efficiency (10 pts) — fast move is better quality
  const durationMs  = safe(event.durationMs) || safe((event.closedAt || Date.now()) - event.startTs);
  const durationMin = durationMs / 60000;
  // optimal ~1-3 min: full score; >30min: 0
  let durPts;
  if      (durationMin <= 3)  durPts = 10;
  else if (durationMin <= 10) durPts = 8;
  else if (durationMin <= 20) durPts = 5;
  else if (durationMin <= 30) durPts = 2;
  else                        durPts = 0;
  breakdown.durationEfficiency = durPts;
  total += durPts;

  // 3. Volume (15 pts)
  const vol60 = safe(metrics?.volumeUsdt60s || event.snapshotB?.volumeUsdt60s);
  let volPts;
  if      (vol60 >= 10_000_000) volPts = 15;
  else if (vol60 >= 3_000_000)  volPts = 12;
  else if (vol60 >= 1_000_000)  volPts = 8;
  else if (vol60 >= 300_000)    volPts = 4;
  else                          volPts = 0;
  breakdown.volume = volPts;
  total += volPts;

  // 4. Trade count velocity (10 pts)
  const tc60 = safe(metrics?.tradeCount60s || event.snapshotB?.tradeCount60s);
  let tcPts;
  if      (tc60 >= 2000) tcPts = 10;
  else if (tc60 >= 800)  tcPts = 7;
  else if (tc60 >= 300)  tcPts = 4;
  else                   tcPts = 0;
  breakdown.tradeCount = tcPts;
  total += tcPts;

  // 5. Delta strength (10 pts) — directional conviction
  const deltaImb = Math.abs(safe(signal?.deltaImbalancePct60s || event.snapshotB?.deltaImbalancePct60s));
  const deltaPts = clamp(Math.round(deltaImb / 50 * 10), 0, 10);
  breakdown.delta = deltaPts;
  total += deltaPts;

  // 6. Impulse score at event start (15 pts)
  const impulse = safe(event.snapshotA?.impulseScore || signal?.impulseScore);
  let impPts;
  if      (impulse >= 600) impPts = 15;
  else if (impulse >= 400) impPts = 11;
  else if (impulse >= 200) impPts = 7;
  else if (impulse >= 100) impPts = 3;
  else                     impPts = 0;
  breakdown.impulse = impPts;
  total += impPts;

  // 7. Derivatives confirmation (10 pts)
  let derivPts = 0;
  if (derivatives) {
    const align = safe(derivatives.directionAlignment);
    const dir   = event.direction; // 'up' | 'down'
    if ((dir === 'up' && align > 0) || (dir === 'down' && align < 0)) {
      derivPts = clamp(Math.round(Math.abs(align) / 10 * 10), 0, 10);
    }
  }
  breakdown.derivatives = derivPts;
  total += derivPts;

  // 8. Wall interaction quality (10 pts)
  const wallBounce = safe(event.snapshotB?.wallBounceChance);
  const wallBreak  = safe(event.snapshotB?.wallBreakRisk);
  let wallPts = 0;
  // credit wall interactions that are relevant
  const wallScore = Math.max(wallBounce, wallBreak);
  if      (wallScore >= 70) wallPts = 10;
  else if (wallScore >= 50) wallPts = 7;
  else if (wallScore >= 30) wallPts = 4;
  breakdown.wallInteraction = wallPts;
  total += wallPts;

  const score = clamp(total, 0, 100);
  return {
    happenedRankScore     : score,
    happenedRankLabel     : rankLabel(score),
    happenedRankBreakdown : breakdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeBuildingRank
//   presignal   — presignal:<SYM> object (computePreSignalV2 output)
//   derivatives — parsed derivatives:<SYM>  (nullable)
// ─────────────────────────────────────────────────────────────────────────────
function computeBuildingRank(presignal, derivatives) {
  const breakdown = {};
  let total = 0;

  // 1. Adjusted readiness (30 pts)
  const readiness = safe(presignal.adjustedReadinessScore || presignal.readinessScore);
  const readPts   = clamp(Math.round(readiness * 0.30), 0, 30);
  breakdown.adjustedReadiness = readPts;
  total += readPts;

  // 2. Confidence (15 pts)
  const conf     = safe(presignal.confidenceScore);
  const confPts  = clamp(Math.round(conf * 0.15), 0, 15);
  breakdown.confidence = confPts;
  total += confPts;

  // 3. Score trend (10 pts)
  const trend = presignal.scoreTrend || 'flat';
  const trendPts = trend === 'rising' ? 10 : trend === 'slightly-rising' ? 6 :
                   trend === 'flat'   ? 3  : 0;
  breakdown.scoreTrend = trendPts;
  total += trendPts;

  // 4. Persistence (15 pts)
  const persMs = safe(presignal.persistenceMs);
  let persPts;
  if      (persMs >= 60000) persPts = 15;
  else if (persMs >= 30000) persPts = 10;
  else if (persMs >= 15000) persPts = 5;
  else                      persPts = 0;
  breakdown.persistence = persPts;
  total += persPts;

  // 5. Wall bias alignment (10 pts)
  const wb  = presignal.wallBias || 'neutral';
  const dir = presignal.directionBias;
  const wallAlignPts =
    (dir === 'up'   && wb === 'bid-heavy') ||
    (dir === 'down' && wb === 'ask-heavy') ? 10 :
    wb === 'neutral' ? 4 : 0;
  breakdown.wallBias = wallAlignPts;
  total += wallAlignPts;

  // 6. Derivatives (10 pts)
  let derivPts = 0;
  if (derivatives) {
    const align = safe(derivatives.directionAlignment);
    const squeeze = safe(derivatives.squeezeRisk);
    if ((dir === 'up' && align > 0) || (dir === 'down' && align < 0)) {
      derivPts = clamp(Math.round(Math.abs(align) / 10 * 7), 0, 7);
    }
    if (squeeze >= 60) derivPts = Math.min(10, derivPts + 3);
  }
  breakdown.derivatives = derivPts;
  total += derivPts;

  // 7. Distance to condition inverse (10 pts) — closer = better
  const dist = safe(presignal.distanceToConditionPct);
  let distPts;
  if      (dist <= 0.3) distPts = 10;
  else if (dist <= 0.8) distPts = 7;
  else if (dist <= 1.5) distPts = 4;
  else if (dist <= 3.0) distPts = 1;
  else                  distPts = 0;
  breakdown.distanceInverse = distPts;
  total += distPts;

  const score = clamp(total, 0, 100);
  return {
    buildingRankScore     : score,
    buildingRankLabel     : rankLabel(score),
    buildingRankBreakdown : breakdown,
  };
}

module.exports = { computeHappenedRank, computeBuildingRank, rankLabel };
