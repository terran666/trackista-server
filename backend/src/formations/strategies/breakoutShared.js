'use strict';

/**
 * breakoutShared.js — shared building blocks for every breakout strategy.
 *
 * Strategies stay thin: they call `evaluateBreakout()` with their own type tags,
 * probability weights and (optionally) a required preparation signal. All the
 * geometry (levels, distance, structure, signals, trade plan, reasons) lives
 * here so new strategies can be added without touching the engine.
 */

const {
  FORMATION_STATUS, DIRECTION, LEVEL_SIDE,
} = require('../formationTypes');
const { clamp, round, computeProbability } = require('../formationScore');

// ─── Level building (from 1m bars in Redis) ─────────────────────────────────

function findPivots(bars, strength) {
  const highs = [];
  const lows  = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const b = bars[i];
    let isHigh = true, isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (bars[j].high >= b.high) isHigh = false;
      if (bars[j].low  <= b.low)  isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: b.high, ts: b.ts });
    if (isLow)  lows.push({ index: i, price: b.low,  ts: b.ts });
  }
  return { highs, lows };
}

function clusterPivots(pivots, tolPct) {
  if (!pivots.length) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = { items: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const center = cur.items.reduce((s, x) => s + x.price, 0) / cur.items.length;
    const tol = center * (tolPct / 100);
    if (Math.abs(p.price - center) <= tol) cur.items.push(p);
    else { clusters.push(cur); cur = { items: [p] }; }
  }
  clusters.push(cur);
  return clusters.map(c => {
    const prices = c.items.map(x => x.price);
    const price = prices.reduce((s, x) => s + x, 0) / prices.length;
    const indices = c.items.map(x => x.index);
    return {
      price,
      touches: c.items.length,
      firstTs: Math.min(...c.items.map(x => x.ts)),
      lastTs:  Math.max(...c.items.map(x => x.ts)),
      span:    Math.max(...indices) - Math.min(...indices),
    };
  });
}

/**
 * Build support/resistance levels from 1m bars relative to the current price.
 * @returns {{ resistancesAbove: Level[], supportsBelow: Level[] }}
 */
function buildLevels(bars, price, cfg) {
  const { highs, lows } = findPivots(bars, cfg.pivotStrength);
  const all = [...highs, ...lows];
  const clusters = clusterPivots(all, cfg.clusterTolPct);

  const total = bars.length;
  const levels = clusters
    .filter(c => c.touches >= cfg.minTouches)
    .map(c => {
      const side = c.price > price ? LEVEL_SIDE.RESISTANCE : LEVEL_SIDE.SUPPORT;
      const spanBonus = total > 1 ? c.span / (total - 1) : 0;
      const strength = c.touches * 2 + spanBonus * 4;
      return {
        price:    round(c.price, 8),
        side,
        touches:  c.touches,
        strength: round(strength, 2),
        sources:  ['bars1m'],
        tfSource: ['1m'],
        firstTs:  c.firstTs,
        lastTs:   c.lastTs,
      };
    });

  const resistancesAbove = levels
    .filter(l => l.side === LEVEL_SIDE.RESISTANCE)
    .sort((a, b) => a.price - b.price)
    .slice(0, cfg.maxLevelsPerSide);
  const supportsBelow = levels
    .filter(l => l.side === LEVEL_SIDE.SUPPORT)
    .sort((a, b) => b.price - a.price)
    .slice(0, cfg.maxLevelsPerSide);

  return { resistancesAbove, supportsBelow };
}

// ─── Distance ───────────────────────────────────────────────────────────────

function distancePct(price, levelPrice, direction) {
  if (direction === DIRECTION.LONG) return ((levelPrice - price) / price) * 100;
  return ((price - levelPrice) / price) * 100; // SHORT
}

// ─── Structure / signal detectors ───────────────────────────────────────────

function recentPivotLows(bars, strength, n) {
  const { lows } = findPivots(bars, strength);
  return lows.slice(-n);
}
function recentPivotHighs(bars, strength, n) {
  const { highs } = findPivots(bars, strength);
  return highs.slice(-n);
}

function isAscending(points) {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i++) if (points[i].price <= points[i - 1].price) return false;
  return true;
}
function isDescending(points) {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i++) if (points[i].price >= points[i - 1].price) return false;
  return true;
}

function compressionScore(bars, lookback, threshold) {
  if (bars.length < lookback * 2) return { compression: false, score: 0 };
  const recent = bars.slice(-lookback);
  const older  = bars.slice(-lookback * 2, -lookback);
  const range = arr => {
    const hi = Math.max(...arr.map(b => b.high));
    const lo = Math.min(...arr.map(b => b.low));
    return hi - lo;
  };
  const rRecent = range(recent);
  const rOlder  = range(older);
  if (rOlder <= 0) return { compression: false, score: 0 };
  const ratio = rRecent / rOlder;
  const compression = ratio <= threshold;
  return { compression, score: compression ? clamp(1 - ratio, 0, 1) : 0, ratio };
}

function distanceDecreasing(bars, levelPrice, direction, lookback) {
  if (bars.length < lookback + 1) return false;
  const now  = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - lookback].close;
  const dNow  = Math.abs(levelPrice - now);
  const dThen = Math.abs(levelPrice - then);
  // price is closing in on the level AND has not crossed it
  if (direction === DIRECTION.LONG && now > levelPrice) return false;
  if (direction === DIRECTION.SHORT && now < levelPrice) return false;
  return dNow < dThen;
}

function liquidityBehindLevel(walls, levelPrice, direction) {
  if (!Array.isArray(walls) || !walls.length) return false;
  // "Behind" = just beyond the level on the breakout side (fuel / magnet).
  const band = levelPrice * 0.01; // within 1% beyond the level
  for (const w of walls) {
    const p = Number(w.price);
    if (!Number.isFinite(p)) continue;
    if (direction === DIRECTION.LONG) {
      if (p > levelPrice && p <= levelPrice + band) return true;
    } else {
      if (p < levelPrice && p >= levelPrice - band) return true;
    }
  }
  return false;
}

/**
 * Detect all preparation signals for a level/direction.
 * Returns { signals, reasons, hasAny }.
 */
function detectSignals(ctx, level, direction) {
  const { bars, metrics, signal, derivatives, walls, cfg } = ctx;
  const reasons = [];

  const lows  = recentPivotLows(bars, cfg.pivotStrength, 3);
  const highs = recentPivotHighs(bars, cfg.pivotStrength, 3);
  const higherLows = isAscending(lows);
  const lowerHighs = isDescending(highs);

  const structureAligned = direction === DIRECTION.LONG ? higherLows : lowerHighs;
  if (higherLows) reasons.push('Последние минимумы становятся выше');
  if (lowerHighs) reasons.push('Последние максимумы становятся ниже');

  const comp = compressionScore(bars, cfg.structureLookback, cfg.compressionRatio);
  if (comp.compression) reasons.push('Диапазон сжимается перед уровнем');

  const lastBar = bars[bars.length - 1] || {};
  const vsr = signal?.volumeSpikeRatio60s ?? lastBar.volumeSpikeRatio ?? 0;
  const volumeSpike = vsr >= cfg.volumeSpikeConfirm;
  const volumeScore = clamp((vsr - 1) / (cfg.volumeSpikeConfirm), 0, 1);
  if (volumeSpike) reasons.push('Растёт объём перед пробоем');

  const deltaUsdt = metrics?.deltaUsdt60s ?? lastBar.deltaUsdt ?? 0;
  const deltaAligned = direction === DIRECTION.LONG ? deltaUsdt > 0 : deltaUsdt < 0;
  const deltaScore = clamp(Math.abs(deltaUsdt) / (Math.abs(metrics?.volumeUsdt60s ?? lastBar.volumeUsdt ?? 1) || 1), 0, 1);
  if (deltaAligned) reasons.push(direction === DIRECTION.LONG ? 'Дельта положительная (покупатели агрессивны)' : 'Дельта отрицательная (продавцы агрессивны)');

  const recentOiDelta = bars.slice(-cfg.structureLookback).reduce((s, b) => s + (b.oiDelta ?? 0), 0);
  const oiRising = recentOiDelta > 0 || (derivatives?.oiValue != null && (lastBar.oiDelta ?? 0) > 0);
  if (oiRising) reasons.push('Открытый интерес растёт');

  const liqBehind = liquidityBehindLevel(walls, level.price, direction);
  if (liqBehind) reasons.push(direction === DIRECTION.LONG ? 'Ликвидность стоит выше уровня' : 'Ликвидность стоит ниже уровня');

  const approaching = distanceDecreasing(bars, level.price, direction, cfg.structureLookback);
  if (approaching) reasons.push('Цена поджимается к уровню');

  const signals = {
    higherLows,
    lowerHighs,
    structureAligned,
    compression: comp.compression,
    compressionScore: comp.score,
    volumeSpike,
    volumeScore,
    deltaDirection: deltaUsdt > 0 ? 'up' : deltaUsdt < 0 ? 'down' : 'flat',
    deltaAligned,
    deltaScore,
    oiDirection: oiRising ? 'up' : 'flat',
    oiRising,
    liquidityBehindLevel: liqBehind,
    distanceDecreasing: approaching,
  };

  const hasAny =
    structureAligned || comp.compression || volumeSpike ||
    deltaAligned || oiRising || liqBehind || approaching;

  return { signals, reasons, hasAny };
}

// ─── Status by distance ─────────────────────────────────────────────────────

function statusFromDistance(dPct, cfg) {
  if (dPct <= cfg.readyDistancePct)     return FORMATION_STATUS.READY;
  if (dPct <= cfg.approachDistancePct)  return FORMATION_STATUS.APPROACHING;
  return FORMATION_STATUS.DETECTED;
}

// ─── Trade plan ─────────────────────────────────────────────────────────────

function buildTradePlan(level, direction, bars, cfg) {
  const entry = level.price;
  const lookback = bars.slice(-cfg.structureLookback);
  let stop, tp1, tp2;
  if (direction === DIRECTION.LONG) {
    const swingLow = Math.min(...lookback.map(b => b.low));
    stop = swingLow * (1 - cfg.stopBufferPct / 100);
    const risk = entry - stop;
    tp1 = entry + risk * cfg.tp1R;
    tp2 = entry + risk * cfg.tp2R;
  } else {
    const swingHigh = Math.max(...lookback.map(b => b.high));
    stop = swingHigh * (1 + cfg.stopBufferPct / 100);
    const risk = stop - entry;
    tp1 = entry - risk * cfg.tp1R;
    tp2 = entry - risk * cfg.tp2R;
  }
  return { entry: round(entry, 8), stop: round(stop, 8), tp1: round(tp1, 8), tp2: round(tp2, 8) };
}

// ─── Main evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate one direction/side for a strategy.
 *
 * @param {object} ctx     per-symbol context
 * @param {object} opts    { strategy, typeUp, typeDown, weights, requiredSignal }
 * @returns {{ candidates: object[], skips: object[] }}
 */
function evaluateBreakout(ctx, opts) {
  const { price, levels, cfg } = ctx;
  const candidates = [];
  const skips = [];

  const sides = [
    { direction: DIRECTION.LONG,  type: opts.typeUp,   list: levels.resistancesAbove },
    { direction: DIRECTION.SHORT, type: opts.typeDown, list: levels.supportsBelow },
  ];

  for (const { direction, type, list } of sides) {
    for (const level of list) {
      const dPct = distancePct(price, level.price, direction);

      if (dPct < 0) { // price already beyond level → already broken
        skips.push({ levelPrice: level.price, side: level.side, distancePct: round(dPct, 3), reason: 'level_broken' });
        continue;
      }
      if (level.touches < cfg.minTouches) {
        skips.push({ levelPrice: level.price, side: level.side, distancePct: round(dPct, 3), reason: 'not_enough_touches' });
        continue;
      }
      if (dPct > cfg.maxDistancePct) {
        skips.push({ levelPrice: level.price, side: level.side, distancePct: round(dPct, 3), reason: 'too_far' });
        continue;
      }

      const { signals, reasons, hasAny } = detectSignals(ctx, level, direction);

      // Strategy-specific required signal (e.g. volumeBreakout needs a volume spike)
      if (opts.requiredSignal && !signals[opts.requiredSignal]) {
        skips.push({ levelPrice: level.price, side: level.side, distancePct: round(dPct, 3), reason: 'no_preparation_signals' });
        continue;
      }
      if (!hasAny) {
        skips.push({ levelPrice: level.price, side: level.side, distancePct: round(dPct, 3), reason: 'no_preparation_signals' });
        continue;
      }

      const probability = round(computeProbability(
        { distancePct: dPct, maxDistancePct: cfg.maxDistancePct, touches: level.touches, strength: level.strength, signals },
        opts.weights,
      ), 1);

      const status = statusFromDistance(dPct, cfg);
      const tradePlan = buildTradePlan(level, direction, ctx.bars, cfg);

      const fullReasons = [
        direction === DIRECTION.LONG
          ? `Найден resistance ${level.price} выше цены`
          : `Найден support ${level.price} ниже цены`,
        `Уровень имеет ${level.touches} касания`,
        `Расстояние до уровня ${round(dPct, 2)}%`,
        ...reasons,
        `Вероятность пробоя ${Math.round(probability)}%`,
      ];

      candidates.push({
        strategy:  opts.strategy,
        type,
        direction,
        status,
        level,
        distancePct: round(dPct, 3),
        probability,
        score: probability,
        signals,
        tradePlan,
        reason: fullReasons,
      });
    }
  }

  return { candidates, skips };
}

module.exports = {
  buildLevels,
  distancePct,
  detectSignals,
  evaluateBreakout,
  statusFromDistance,
};
