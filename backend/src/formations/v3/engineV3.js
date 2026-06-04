'use strict';

/**
 * v3/engineV3.js — geometry-driven breakout-probability engine.
 *
 * For each symbol:
 *   1. build the unified level book (Levels + Extremes tools + bars pivots);
 *   2. for the nearest resistances above (LONG) / supports below (SHORT), run the
 *      geometry analyser — geometry ALONE decides whether a formation exists;
 *   3. probability = geometry 80% + extra flow signals 20% (+ zone/confluence);
 *   4. emit candidates (≤ maxPerDirection per side), already deduped by level.
 *
 * Reads nothing external — pure function of the supplied context.
 */

const { buildLevelBook } = require('./levelSources');
const geometry = require('./geometry');
const { FORMATION_STATUS, DIRECTION } = require('../formationTypes');

function statusFromDistance(dPct, cfg) {
  if (dPct <= cfg.readyDistancePct) return FORMATION_STATUS.READY;
  if (dPct <= cfg.approachDistancePct) return FORMATION_STATUS.APPROACHING;
  return FORMATION_STATUS.DETECTED;
}

/** Extra flow signals (20% of probability). Never create — only enhance. */
function extrasScore({ direction, metrics, signal, derivatives, walls, level, price }) {
  const isLong = direction === DIRECTION.LONG;
  const parts = [];

  const spike = signal?.volumeSpikeRatio60s ?? metrics?.volumeSpikeRatio ?? null;
  if (Number.isFinite(spike)) parts.push(Math.min(Math.max((spike - 1) / 1.5, 0), 1));

  const delta = metrics?.deltaUsdt60s ?? metrics?.deltaUsdt ?? null;
  if (Number.isFinite(delta) && delta !== 0) {
    const aligned = isLong ? delta > 0 : delta < 0;
    parts.push(aligned ? 1 : 0);
  }

  const oiDelta = derivatives?.oiDelta ?? metrics?.oiDelta ?? null;
  if (Number.isFinite(oiDelta) && oiDelta !== 0) parts.push(oiDelta > 0 ? 1 : 0);

  // Liquidity wall sitting just beyond the level (fuel for a breakout).
  if (Array.isArray(walls) && walls.length) {
    const beyond = walls.some(w => {
      const wp = Number(w.price);
      if (!Number.isFinite(wp)) return false;
      return isLong ? wp >= level.price : wp <= level.price;
    });
    if (beyond) parts.push(1);
  }

  if (!parts.length) return 0;
  return parts.reduce((s, v) => s + v, 0) / parts.length;
}

/**
 * Round a price to a sensible, human-readable precision based on magnitude,
 * killing float artifacts like 0.27832999999999997 → 0.27833.
 */
function fmtPrice(p) {
  if (!Number.isFinite(p)) return p;
  const abs = Math.abs(p);
  let decimals;
  if (abs >= 1000)      decimals = 2;
  else if (abs >= 100)  decimals = 3;
  else if (abs >= 1)    decimals = 4;
  else if (abs >= 0.01) decimals = 5;
  else if (abs >= 0.0001) decimals = 6;
  else                  decimals = 8;
  return Number(p.toFixed(decimals));
}

/**
 * Build a render-ready breakout map for the frontend so the card can draw
 * "where the level is" + "what the breakout potential is" without re-deriving it.
 *
 * Returned fields (all prices already rounded for display):
 *   - direction      : 'up' (LONG, through resistance) | 'down' (SHORT, through support)
 *   - breakoutPrice  : the level price that must be broken
 *   - currentPrice   : price right now
 *   - distancePct    : how far price is from the breakout line (to know how close)
 *   - targetPrice    : projected destination (next level beyond the breakout)
 *   - targetIsLevel  : true if target is a real level, false if measured-move estimate
 *   - potentialPct   : reward move from the breakout line to the target
 *   - stopPrice      : where the idea is wrong (nearest opposite-side level)
 *   - riskPct        : move from breakout line back to the stop
 *   - riskReward     : potentialPct / riskPct (how many R the trade pays)
 *   - label          : one-line human caption
 *   - summary        : short machine fields for compact UI badges
 */
function buildBreakout({ book, direction, level, price }) {
  const isLong = direction === DIRECTION.LONG;
  const up     = isLong;
  const bp     = level.price;
  const arrow  = up ? '▲' : '▼';
  const word   = up ? 'вверх' : 'вниз';

  // Next level beyond the breakout = projected target.
  const target = isLong
    ? (book.resistancesAbove.find(l => l.price > bp) || null)
    : (book.supportsBelow.find(l => l.price < bp) || null);

  // Nearest opposite-side level = stop / invalidation reference.
  const invalidation = isLong
    ? (book.supportsBelow[0] || null)
    : (book.resistancesAbove[0] || null);

  const distanceAbs = Math.abs(price - bp);
  const distancePct = bp ? (distanceAbs / bp) * 100 : 0;

  // Projected move from the breakout line to the next level (measured-move
  // fallback when there is no further level: 1.5× the run-up to the line).
  let targetPriceRaw = target ? target.price : null;
  let potentialPct;
  if (targetPriceRaw) {
    potentialPct = bp ? Math.abs(targetPriceRaw - bp) / bp * 100 : 0;
  } else {
    potentialPct = Math.max(distancePct * 1.5, 1);
    targetPriceRaw = up ? bp * (1 + potentialPct / 100) : bp * (1 - potentialPct / 100);
  }

  // Risk = distance from the breakout line back to the invalidation level.
  const stopPriceRaw = invalidation ? invalidation.price : null;
  const riskPct = stopPriceRaw && bp ? Math.abs(bp - stopPriceRaw) / bp * 100 : null;
  const riskReward = riskPct && riskPct > 0 ? Number((potentialPct / riskPct).toFixed(2)) : null;

  const breakoutPrice = fmtPrice(bp);
  const targetPrice   = fmtPrice(targetPriceRaw);
  const stopPrice     = stopPriceRaw != null ? fmtPrice(stopPriceRaw) : null;
  const potRounded    = Number(potentialPct.toFixed(2));

  // One clear line: direction, level, distance to it, target with %, and stop.
  let label = `Пробой ${word} ${arrow} ${breakoutPrice} (${distancePct.toFixed(2)}% до уровня) → цель ${targetPrice} +${potRounded}%`;
  if (stopPrice != null) label += ` | стоп ${stopPrice}`;
  if (riskReward != null) label += ` | R:R ${riskReward}`;

  return {
    direction:        up ? 'up' : 'down',
    breakoutPrice,
    currentPrice:     fmtPrice(price),
    distancePct:      Number(distancePct.toFixed(2)),
    distanceAbs:      fmtPrice(distanceAbs),
    targetPrice,
    targetIsLevel:    !!target,
    potentialPct:     potRounded,
    stopPrice,
    riskPct:          riskPct != null ? Number(riskPct.toFixed(2)) : null,
    riskReward,
    invalidationPrice: stopPrice,   // kept for backward compatibility
    label,
    summary: {
      arrow,
      distance: `${distancePct.toFixed(2)}%`,
      potential: `+${potRounded}%`,
      rr: riskReward != null ? `${riskReward}R` : null,
    },
  };
}

function pickStructureBars(tfBars, cfg) {
  for (const tf of cfg.timeframes) {
    const bars = tfBars.get(tf);
    if (bars && bars.length >= cfg.minBarsRequired) return { tf, bars };
  }
  return { tf: null, bars: [] };
}

function createEngineV3(config) {
  function run(ctx) {
    const { symbol, price, tfBars, storedLevels, metrics, signal, derivatives, walls } = ctx;
    const out = { candidates: [], skips: [], levels: { resistancesAbove: [], supportsBelow: [] } };

    const book = buildLevelBook({ tfBars, storedLevels, price, cfg: config });
    out.levels = book;

    const { bars: structureBars } = pickStructureBars(tfBars, config);
    if (!structureBars.length) return out;

    const sides = [
      { direction: DIRECTION.LONG,  levels: book.resistancesAbove },
      { direction: DIRECTION.SHORT, levels: book.supportsBelow },
    ];

    for (const { direction, levels } of sides) {
      let made = 0;
      for (const level of levels) {
        const g = geometry.analyze({ bars: structureBars, level, direction, price, cfg: config });

        // Geometry breakdown shared by candidates and skips (for debug/UI).
        const geo = {
          distancePct:        Number(g.distancePct.toFixed(3)),
          hasZone:            !!level.zone,
          confluence:         level.confluenceCount,
          approachCount:      g.approachCount,
          tightening:         g.tighteningOk,
          structureAligned:   g.structureAligned,
          higherLows:         direction === DIRECTION.LONG ? g.structureAligned : false,
          lowerHighs:         direction === DIRECTION.SHORT ? g.structureAligned : false,
          compression:        g.compression,
          compressionRatio:   Number(g.compressionRatio.toFixed(3)),
          reactionWeakening:  g.reactionsWeakening,
        };

        const pushSkip = (reason) => out.skips.push({
          levelPrice: level.price, side: level.side, direction,
          distancePct: geo.distancePct, reason, strategy: 'geometryV3',
          geometry: geo,
          // nearMiss = passed the distance gate but geometry/probability not ready yet
          nearMiss: reason === 'no_geometry' || reason === 'low_probability',
        });

        if (g.distancePct > config.maxDistancePct) { pushSkip('too_far'); continue; }

        const extras = extrasScore({ direction, metrics, signal, derivatives, walls, level, price });
        const zoneBonus = level.zone ? config.zoneBonus : 0;
        const confluenceBonus = Math.min((level.confluenceCount - 1) * 4, config.confluenceBonusMax);
        const probability = Math.round(Math.max(0, Math.min(100,
          g.score * 100 * config.geometryWeight +
          extras * 100 * config.extrasWeight +
          zoneBonus + confluenceBonus,
        )));

        if (made >= config.maxPerDirection) { pushSkip('per_direction_cap'); continue; }
        if (!g.created) { pushSkip('no_geometry'); continue; }
        if (probability < config.minProbability) { pushSkip('low_probability'); continue; }

        out.candidates.push({
          strategy:    'geometryV3',
          direction,
          type:        'BREAKOUT_PREPARATION',
          status:      statusFromDistance(g.distancePct, config),
          level:       { price: level.price, side: level.side, touches: level.touches, strength: level.strength, sources: level.sources, tfSource: level.tfSource, zone: level.zone },
          // render-ready breakout map (target / invalidation / direction / label)
          breakout:    buildBreakout({ book, direction, level, price }),
          distancePct: Number(g.distancePct.toFixed(3)),
          probability,
          score:       Math.round(g.score * 100),
          signals: {
            approachCount:      g.approachCount,
            tightening:         g.tighteningOk,
            structureAligned:   g.structureAligned,
            higherLows:         geo.higherLows,
            lowerHighs:         geo.lowerHighs,
            compression:        g.compression,
            compressionRatio:   Number(g.compressionRatio.toFixed(3)),
            reactionsWeakening: g.reactionsWeakening,
            zone:               level.zone,
            extrasScore:        Number(extras.toFixed(3)),
          },
          confluenceStrategies: level.sources,
          confluenceScore:      Math.min(100, level.confluenceCount * 20),
          levelStrength:        level.strength,
          zoneBonus,
          confluenceBonus,
          // reason is an ARRAY (contract: every formation carries a non-empty reason[])
          reason: g.reasons.length ? g.reasons : ['geometry'],
        });
        made++;
      }
    }

    return out;
  }

  return { run, activeStrategies: ['geometryV3'] };
}

module.exports = { createEngineV3 };
