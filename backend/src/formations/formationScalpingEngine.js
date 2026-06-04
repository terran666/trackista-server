'use strict';

/**
 * formationScalpingEngine.js — strategy orchestrator.
 *
 * The engine is universal: it only knows how to (1) build levels once per symbol,
 * (2) run every enabled strategy against that context, (3) merge results.
 * Strategy logic lives entirely in ./strategies — adding a new one means adding
 * a file + REGISTRY entry + config key. This file never changes for new logic.
 */

const { buildLevels } = require('./strategies/breakoutShared');
const {
  round, clamp,
  multiSignalBonus, confluenceStrategyBonus,
  computeLevelStrength, computeConfluenceScore,
} = require('./formationScore');
const { DIRECTION } = require('./formationTypes');

// ── Strategy registry ────────────────────────────────────────────────────────
// Map of strategyKey → strategy module. New strategies are registered here.
const REGISTRY = {};
function register(mod) { REGISTRY[mod.key] = mod; }

register(require('./strategies/breakoutPreparationStrategy'));
register(require('./strategies/classicBreakoutStrategy'));
register(require('./strategies/volumeBreakoutStrategy'));
register(require('./strategies/oiBreakoutStrategy'));
register(require('./strategies/deltaBreakoutStrategy'));
register(require('./strategies/liquidityBreakoutStrategy'));
register(require('./strategies/squeezeBreakoutStrategy'));

function createFormationEngine(config) {
  const active = config.enabledStrategies
    .map(k => REGISTRY[k])
    .filter(Boolean);

  /**
   * Run all enabled strategies for one symbol context.
   * @param {object} baseCtx { symbol, marketType, price, bars, metrics, signal,
   *                           derivatives, walls }
   * @returns {{ candidates: object[], levels: object, skips: object[],
   *             strategiesChecked: string[] }}
   */
  function run(baseCtx) {
    const levels = buildLevels(baseCtx.bars, baseCtx.price, config);
    const ctx = { ...baseCtx, levels, cfg: config };

    const candidates = [];
    const skips = [];
    const strategiesChecked = [];

    for (const strat of active) {
      strategiesChecked.push(strat.key);
      let out;
      try {
        out = strat.evaluate(ctx);
      } catch (err) {
        console.error(`[formations] strategy ${strat.key} error for ${baseCtx.symbol}:`, err.message);
        continue;
      }
      if (out?.candidates) candidates.push(...out.candidates);
      if (out?.skips) for (const s of out.skips) skips.push({ ...s, strategy: strat.key });
    }

    // ── Confluence merge + V2 scoring + per-symbol limits ──────────────────
    const merged = mergeConfluence(candidates, config);

    return {
      candidates: merged,
      levels,
      skips,
      strategiesChecked,
    };
  }

  return { run, registry: REGISTRY, activeStrategies: active.map(s => s.key) };
}

// ─── V2: merge candidates that hit the same level (within mergeTolPct) ───────
//
// Several strategies finding the same price (0.1780 / 0.1781 / 0.1779) must
// produce ONE formation, not three. Merging records every agreeing strategy in
// `confluenceStrategies`, unions their signals, and raises probability via the
// multi-signal and confluence bonuses. Then min-probability + per-direction
// limits are applied.

function mergeConfluence(candidates, cfg) {
  const out = [];

  for (const direction of [DIRECTION.LONG, DIRECTION.SHORT]) {
    const list = candidates
      .filter(c => c.direction === direction)
      .sort((a, b) => a.level.price - b.level.price);
    if (!list.length) continue;

    // Cluster by level price within mergeTolPct.
    const clusters = [];
    let cur = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const center = cur.reduce((s, x) => s + x.level.price, 0) / cur.length;
      const tol = center * (cfg.mergeTolPct / 100);
      if (Math.abs(list[i].level.price - center) <= tol) cur.push(list[i]);
      else { clusters.push(cur); cur = [list[i]]; }
    }
    clusters.push(cur);

    const formationsForDir = [];
    for (const group of clusters) {
      // Representative = strongest level (touches/strength), then closest.
      const base = group.slice().sort((a, b) =>
        (b.level.strength - a.level.strength) ||
        (b.level.touches - a.level.touches) ||
        (a.distancePct - b.distancePct))[0];

      const confluenceStrategies = [...new Set(group.map(c => c.strategy))].sort();

      // Union of boolean signals; max of score-like signal fields.
      const signals = { ...base.signals };
      for (const c of group) {
        for (const [k, v] of Object.entries(c.signals)) {
          if (typeof v === 'boolean') signals[k] = signals[k] || v;
          else if (typeof v === 'number') signals[k] = Math.max(signals[k] ?? 0, v);
        }
      }

      // Merged level: keep representative, but take the strongest touches/sources.
      const sources  = [...new Set(group.flatMap(c => c.level.sources  || []))];
      const tfSource = [...new Set(group.flatMap(c => c.level.tfSource || []))];
      const level = {
        ...base.level,
        touches:  Math.max(...group.map(c => c.level.touches)),
        strength: Math.max(...group.map(c => c.level.strength)),
        sources,
        tfSource,
      };

      // MULTI SIGNAL BONUS — independent breakout drivers stacking.
      const activeSignalCount =
        (signals.compression  ? 1 : 0) +
        (signals.volumeSpike  ? 1 : 0) +
        (signals.deltaAligned ? 1 : 0) +
        (signals.oiRising     ? 1 : 0);
      const msBonus = multiSignalBonus(activeSignalCount);
      const confBonus = confluenceStrategyBonus(confluenceStrategies.length);

      const baseProb = Math.max(...group.map(c => c.probability));
      const probability = round(clamp(baseProb + msBonus + confBonus, 0, 100), 1);

      const levelStrength   = computeLevelStrength(level);
      const confluenceScore = computeConfluenceScore(level, confluenceStrategies.length);

      formationsForDir.push({
        ...base,
        level,
        signals,
        probability,
        score: probability,
        confluenceStrategies,
        multiSignalBonus: msBonus,
        confluenceBonus:  confBonus,
        levelStrength,
        confluenceScore,
        version: 'v2',
      });
    }

    // MINIMUM PROBABILITY — drop junk before applying the per-direction cap.
    const kept = formationsForDir
      .filter(f => f.probability >= cfg.minProbability)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, cfg.maxPerDirection); // keep the strongest N per direction

    out.push(...kept);
  }

  return out;
}

module.exports = { createFormationEngine, REGISTRY };
