'use strict';

/**
 * v3/levelSources.js — unify levels from every available tool.
 *
 * A V3 formation can only form around a real level. Levels come from:
 *   • bars-derived pivots per aggregated timeframe (Extremes-style swing levels)
 *   • tracked-extremes  (data/tracked-extremes.json) — horizontal price extremes
 *   • tracked-levels    (data/tracked-levels.json)
 *   • manual-levels     (data/manual-levels.json)
 *   • redis levels:<sym> (MySQL-backed auto/manual/cluster/density levels)
 *
 * All sources are normalised, split into resistances-above / supports-below the
 * current price, merged by proximity (confluence), tagged with zone membership,
 * and scored. Volume/Delta/OI play NO part here — geometry only.
 */

const { findPivots, clusterPivots } = require('./pivots');
const { aggregate } = require('./timeframes');

const RESIST = 'resistance';
const SUPPORT = 'support';

// ── normalise a stored-tool side/type into 'resistance' | 'support' ───────────
function normSide(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === 'resistance' || s === 'high' || s === 'r') return RESIST;
  if (s === 'support' || s === 'low' || s === 's') return SUPPORT;
  return null;
}

/**
 * Build raw levels (price/side/touches/source/tf) from every source.
 * @param {Object} p
 * @param {Map<string,Array>} p.tfBars  tf → aggregated bars
 * @param {Array} p.storedLevels        already-normalised stored-tool levels for this symbol
 * @param {Object} cfg
 */
function collectRaw({ tfBars, storedLevels, cfg }) {
  const raw = [];

  // 1) Bars-derived pivots per timeframe
  if (cfg.sources?.barsDerived !== false) {
    for (const tf of cfg.timeframes) {
      const bars = tfBars.get(tf);
      const minBars = cfg.tfMinBars?.[tf] ?? cfg.minBarsRequired;
      if (!bars || bars.length < minBars) continue;
      const { highs, lows } = findPivots(bars, cfg.pivotStrength);
      for (const c of clusterPivots(highs, cfg.clusterTolPct)) {
        if (c.touches < cfg.minTouches) continue;
        raw.push({ price: c.price, side: RESIST, touches: c.touches, source: `bars:${tf}`, tf });
      }
      for (const c of clusterPivots(lows, cfg.clusterTolPct)) {
        if (c.touches < cfg.minTouches) continue;
        raw.push({ price: c.price, side: SUPPORT, touches: c.touches, source: `bars:${tf}`, tf });
      }
    }
  }

  // 2) Stored-tool levels (already filtered to this symbol by the service)
  for (const l of storedLevels || []) {
    const side = normSide(l.side ?? l.type);
    const price = Number(l.price);
    if (!side || !Number.isFinite(price) || price <= 0) continue;
    raw.push({
      price,
      side,
      touches: Number(l.touches) || 1,
      source:  l.source || 'stored',
      tf:      l.tf || l.timeframe || null,
    });
  }

  return raw;
}

/** Merge raw levels within mergeTolPct → one confluence level. */
function mergeConfluence(raw, cfg) {
  const sorted = raw.slice().sort((a, b) => a.price - b.price);
  const out = [];
  for (const lvl of sorted) {
    const last = out[out.length - 1];
    if (last && last.side === lvl.side &&
        Math.abs(lvl.price - last.priceSum / last.count) / (last.priceSum / last.count) * 100 <= cfg.mergeTolPct) {
      last.priceSum += lvl.price;
      last.count += 1;
      last.touches += lvl.touches;
      last.sources.add(lvl.source);
      if (lvl.tf) last.tfSource.add(lvl.tf);
    } else {
      out.push({
        side:     lvl.side,
        priceSum: lvl.price,
        count:    1,
        touches:  lvl.touches,
        sources:  new Set([lvl.source]),
        tfSource: new Set(lvl.tf ? [lvl.tf] : []),
      });
    }
  }
  return out.map(o => ({
    price:           o.priceSum / o.count,
    side:            o.side,
    touches:         o.touches,
    sources:         [...o.sources],
    tfSource:        [...o.tfSource],
    confluenceCount: o.sources.size,
  }));
}

/** Level strength 0..100 from touches, source diversity and tf coverage. */
function strengthOf(level) {
  let s = 0;
  s += Math.min(level.touches, 6) * 8;            // up to 48
  s += Math.min(level.sources.length, 4) * 8;     // up to 32
  s += Math.min(level.tfSource.length, 4) * 5;    // up to 20
  return Math.min(100, Math.round(s));
}

/**
 * A level qualifies as a REAL breakout level only if it is anchored:
 *   • backed by a stored tool (extremes / autolevels / tracked / manual / redis), OR
 *   • a bars-derived pivot confirmed on ≥ 2 timeframes (multi-tf confluence).
 * A lonely single-timeframe bars pivot (e.g. only `bars:1m`) is just a local
 * swing — noise, not a level — and must never create a formation.
 */
function isAnchoredLevel(level) {
  const hasStored = (level.sources || []).some(s => !String(s).startsWith('bars:'));
  const multiTf   = (level.tfSource || []).length >= 2;
  return hasStored || multiTf;
}

/**
 * Build the unified level book for a symbol.
 * @returns {{ resistancesAbove: Array, supportsBelow: Array }}
 */
function buildLevelBook({ tfBars, storedLevels, price, cfg }) {
  const raw = collectRaw({ tfBars, storedLevels, cfg });
  const merged = mergeConfluence(raw, cfg);

  // Reference bars (youngest tf with enough history) → recent price envelope.
  // A valid breakout level must CAP recent price action, i.e. sit cleanly above
  // (resistance) / below (support) the recent bars — never cut through them.
  let refBars = [];
  for (const tf of cfg.timeframes) {
    const b = tfBars.get(tf);
    const minBars = cfg.tfMinBars?.[tf] ?? cfg.minBarsRequired;
    if (b && b.length >= minBars) { refBars = b; break; }
  }
  const recentBars = refBars.slice(-(cfg.approachLookback || 40));
  let recentHigh = -Infinity;
  let recentLow  = Infinity;
  for (const bar of recentBars) {
    if (bar.high > recentHigh) recentHigh = bar.high;
    if (bar.low  < recentLow)  recentLow  = bar.low;
  }
  const margin = (cfg.brokenMarginPct ?? 0.05) / 100;
  const hasEnvelope = Number.isFinite(recentHigh) && Number.isFinite(recentLow);

  const resistancesAbove = [];
  const supportsBelow = [];
  for (const lvl of merged) {
    lvl.strength = strengthOf(lvl);
    // Only real, anchored levels become breakout candidates. Lonely single-tf
    // bars pivots (no stored tool, no multi-tf confluence) are noise → dropped.
    if (cfg.requireAnchoredLevel !== false && !isAnchoredLevel(lvl)) continue;
    if (lvl.side === RESIST && lvl.price > price) {
      // Resistance must stay above recent highs → line sits above the bars.
      if (hasEnvelope && recentHigh > lvl.price * (1 + margin)) continue;
      resistancesAbove.push(lvl);
    } else if (lvl.side === SUPPORT && lvl.price < price) {
      // Support must stay below recent lows → line sits below the bars.
      if (hasEnvelope && recentLow < lvl.price * (1 - margin)) continue;
      supportsBelow.push(lvl);
    }
  }

  // zone tagging — a second same-side level within zoneTolPct (beyond mergeTol)
  const tagZones = (arr) => {
    for (const a of arr) {
      a.zone = arr.some(b => b !== a &&
        Math.abs(b.price - a.price) / a.price * 100 <= cfg.zoneTolPct);
    }
  };
  tagZones(resistancesAbove);
  tagZones(supportsBelow);

  resistancesAbove.sort((a, b) => a.price - b.price);          // nearest first (just above)
  supportsBelow.sort((a, b) => b.price - a.price);             // nearest first (just below)

  return {
    resistancesAbove: resistancesAbove.slice(0, cfg.maxLevelsPerSide),
    supportsBelow:    supportsBelow.slice(0, cfg.maxLevelsPerSide),
  };
}

module.exports = { buildLevelBook, aggregate, RESIST, SUPPORT };
