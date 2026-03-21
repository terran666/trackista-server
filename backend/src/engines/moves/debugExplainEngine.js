'use strict';
/**
 * debugExplainEngine.js — Phase 2
 *
 * Human-readable explainability for move events and pre-signals.
 * Pure functions — no I/O.
 */

function safe(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// ─────────────────────────────────────────────────────────────────────────────
// explainHappenedEvent
//   Returns why an event was ranked high/low and dominant contributing factors.
// ─────────────────────────────────────────────────────────────────────────────
function explainHappenedEvent(event, metrics, signal, walls, derivatives) {
  const whyIncluded  = [];
  const whyPenalized = [];
  const dominant     = [];

  const movePct  = Math.abs(safe(event.movePct));
  const dir      = event.direction || 'up';
  const impulse  = safe(event.snapshotA?.impulseScore || signal?.impulseScore);
  const vol60    = safe(metrics?.volumeUsdt60s || event.snapshotB?.volumeUsdt60s);
  const durMin   = safe(event.durationMs) / 60000;

  // ── Positive signals ──────────────────────────────────────────────
  if (movePct >= 3)   whyIncluded.push(`Strong move ${movePct.toFixed(2)}%`);
  if (movePct >= 1.5) whyIncluded.push(`Move magnitude ≥1.5% (${movePct.toFixed(2)}%)`);
  if (impulse >= 300) { whyIncluded.push(`High impulse score ${impulse}`); dominant.push('impulse'); }
  if (vol60   >= 5_000_000) { whyIncluded.push(`Large volume ${(vol60/1e6).toFixed(1)}M`); dominant.push('volume'); }
  if (durMin  <= 3)   whyIncluded.push(`Fast move in ${durMin.toFixed(1)} min`);

  const deltaImb = Math.abs(safe(signal?.deltaImbalancePct60s));
  if (deltaImb >= 60) { whyIncluded.push(`Strong delta imbalance ${deltaImb.toFixed(0)}%`); dominant.push('delta'); }

  if (derivatives) {
    const align = safe(derivatives.directionAlignment);
    if ((dir === 'up' && align > 3) || (dir === 'down' && align < -3)) {
      whyIncluded.push(`Derivatives confirm direction (alignment ${align > 0 ? '+' : ''}${align.toFixed(1)})`);
      dominant.push('derivatives');
    }
    if (derivatives.squeezeRisk >= 70) {
      whyIncluded.push(`High squeeze risk ${derivatives.squeezeRisk}`);
      dominant.push('squeeze');
    }
  }

  const wallBounce = safe(event.snapshotB?.wallBounceChance);
  const wallBreak  = safe(event.snapshotB?.wallBreakRisk);
  if (wallBounce >= 60) { whyIncluded.push(`Wall bounce likely (${wallBounce}%)`); dominant.push('wall-bounce'); }
  if (wallBreak  >= 60) { whyIncluded.push(`Wall break likely  (${wallBreak}%)`); dominant.push('wall-break'); }

  // ── Negative signals ──────────────────────────────────────────────
  if (movePct < 1.5) whyPenalized.push(`Small move (${movePct.toFixed(2)}%), less reliable`);
  if (durMin  > 20)  whyPenalized.push(`Slow move (${durMin.toFixed(1)} min), lower efficiency`);
  if (vol60   < 200_000) whyPenalized.push(`Low volume (${(vol60/1000).toFixed(0)}K)`);

  if (derivatives) {
    const align = safe(derivatives.directionAlignment);
    if ((dir === 'up' && align < -3) || (dir === 'down' && align > 3)) {
      whyPenalized.push(`Derivatives oppose direction (alignment ${align > 0 ? '+' : ''}${align.toFixed(1)})`);
    }
  }

  // ── Summary text ──────────────────────────────────────────────────
  const rank    = event.happenedRankLabel || '?';
  const topFact = dominant[0] || (movePct >= 2 ? 'move magnitude' : 'mixed signals');
  const finalDecisionText = dominant.length
    ? `Rank ${rank}: Driven by ${topFact}. Move of ${movePct.toFixed(2)}% in ${durMin.toFixed(1)}min.`
    : `Rank ${rank}: Moderate quality move — no single dominant factor.`;

  return { whyIncluded, whyPenalized, dominantFactors: dominant, finalDecisionText };
}

// ─────────────────────────────────────────────────────────────────────────────
// explainPreSignal
// ─────────────────────────────────────────────────────────────────────────────
function explainPreSignal(presignal, derivatives) {
  const whyIncluded  = [];
  const whyPenalized = [];
  const dominant     = [];

  const readiness  = safe(presignal.adjustedReadinessScore || presignal.readinessScore);
  const dir        = presignal.directionBias;
  const impulse    = safe(presignal.impulseScore);
  const inPlay     = safe(presignal.inPlayScore);
  const label      = presignal.readinessLabel || 'weak';
  const trend      = presignal.scoreTrend     || 'flat';
  const persMs     = safe(presignal.persistenceMs);
  const noise      = safe(presignal.noisePenalty);
  const causeTags  = presignal.causeTags || [];

  // ── Positive signals ──────────────────────────────────────────────
  if (readiness >= 60) { whyIncluded.push(`${label} readiness ${readiness}`); dominant.push('readiness'); }
  if (impulse   >= 200) { whyIncluded.push(`Active impulse ${impulse}`); dominant.push('impulse'); }
  if (inPlay    >= 60)  { whyIncluded.push(`In-play score ${inPlay}`); dominant.push('in-play'); }
  if (trend === 'rising') { whyIncluded.push('Score is rising'); dominant.push('trend-up'); }
  if (persMs >= 15000) { whyIncluded.push(`Persistent signal ${Math.round(persMs/1000)}s`); dominant.push('persistence'); }

  if (causeTags.includes('volume-driven'))  whyIncluded.push('Volume-driven signal');
  if (causeTags.includes('delta-driven'))   whyIncluded.push('Delta imbalance driving');
  if (causeTags.includes('wall-bounce'))    { whyIncluded.push('Wall bounce context'); dominant.push('wall'); }
  if (causeTags.includes('wall-break'))     { whyIncluded.push('Wall break context');  dominant.push('wall'); }

  if (presignal.derivAlignBonus > 0) {
    whyIncluded.push(`Derivatives confirm ${dir} (+${presignal.derivAlignBonus}pts)`);
    dominant.push('derivatives');
  }

  if (derivatives?.squeezeRisk >= 70) {
    whyIncluded.push(`High squeeze risk ${derivatives.squeezeRisk}`);
    dominant.push('squeeze');
  }

  // ── Negative signals ──────────────────────────────────────────────
  if (noise >= 10)  whyPenalized.push(`Noise penalty -${noise}pts`);
  if (label === 'weak') whyPenalized.push('Low readiness score — watching only');
  if (trend === 'falling') whyPenalized.push('Score declining');
  if (presignal.debugReasons?.length) {
    for (const r of presignal.debugReasons) {
      if (r.includes('-')) whyPenalized.push(r);
    }
  }

  const topFact = dominant[0] || 'mixed signals';
  const finalDecisionText = `${label.toUpperCase()} (${readiness}/100): ${topFact} — ${trend} trend, ${
    causeTags.slice(0, 2).join(' + ') || 'no strong cause tag'
  }.`;

  return { whyIncluded, whyPenalized, dominantFactors: dominant, finalDecisionText };
}

module.exports = { explainHappenedEvent, explainPreSignal };
