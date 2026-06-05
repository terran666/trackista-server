'use strict';

/**
 * sharpExtremesEngine.js — Sharp Extremes (ported 1:1 from frontend sharpExtremes.ts)
 *
 * Bars format: { timestamp: number (ms), open, high, low, close, volume? }
 * NOTE: extremesEngineRoute converts Binance bars (time -> timestamp) before calling here.
 */

const DEFAULT_SETTINGS = {
  pivotLeft            : 3,
  pivotRight           : 3,
  L                    : 3,
  R                    : 3,
  minSlopePct          : 0.08,
  startFromFirstPivot  : true,
  unbrokenLookahead    : 300,
  breakMode            : 'equal',
  breakToleranceTicks  : 0,
  tickSize             : undefined,
  maxExtremes          : 60,
  lookbackBars         : 200,
};

function slopePct(fromClose, toClose, barsCount) {
  if (barsCount <= 0) return 0;
  const base = Math.max(1e-12, Math.abs(fromClose));
  return ((toClose - fromClose) / base) * 100 / barsCount;
}

function isPivotHigh(bars, i, left, right) {
  const h = bars[i].high;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (bars[j].high >= h) return false;
  }
  return true;
}

function isPivotLow(bars, i, left, right) {
  const l = bars[i].low;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) continue;
    if (bars[j].low <= l) return false;
  }
  return true;
}

function isSharpByClose(bars, i, p, type) {
  const leftI  = i - p.L;
  const rightI = i + p.R;
  if (leftI < 0 || rightI >= bars.length) return false;
  const before = slopePct(bars[leftI].close, bars[i].close, p.L);
  const after  = slopePct(bars[i].close, bars[rightI].close, p.R);
  if (type === 'HIGH') return before > 0 && after < 0;
  if (type === 'LOW')  return before < 0 && after > 0;
  return false;
}

function isBrokenToRight(bars, i, type, lookahead, breakMode, tickSize, breakToleranceTicks) {
  const raw = type === 'HIGH' ? bars[i].high : bars[i].low;
  const tol = tickSize && breakToleranceTicks > 0 ? tickSize * breakToleranceTicks : 0;
  const end = lookahead && lookahead > 0
    ? Math.min(bars.length - 1, i + lookahead)
    : bars.length - 1;
  for (let k = i + 1; k <= end; k++) {
    if (type === 'HIGH') {
      const threshold = raw + tol;
      if (breakMode === 'strict' ? bars[k].high > threshold : bars[k].high >= threshold) return true;
    } else {
      const threshold = raw - tol;
      if (breakMode === 'strict' ? bars[k].low < threshold : bars[k].low <= threshold) return true;
    }
  }
  return false;
}

function findSharpExtremes(bars, settings) {
  const p = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const slice = p.lookbackBars > 0 && p.lookbackBars < bars.length
    ? bars.slice(bars.length - p.lookbackBars) : bars;
  const n     = slice.length;
  const startI = p.pivotLeft;
  const endI   = n - 1 - p.pivotRight;
  if (endI <= startI) return [];

  const pivots = [];
  for (let i = startI; i <= endI; i++) {
    if (isPivotHigh(slice, i, p.pivotLeft, p.pivotRight)) pivots.push({ i, type: 'HIGH' });
    if (isPivotLow(slice,  i, p.pivotLeft, p.pivotRight)) pivots.push({ i, type: 'LOW'  });
  }
  pivots.sort((a, b) => a.i - b.i);
  if (!pivots.length) return [];

  const firstPivotIndex     = p.startFromFirstPivot ? pivots[0].i : startI;
  const lookahead           = p.unbrokenLookahead ?? 0;
  const breakMode           = p.breakMode ?? 'equal';
  const breakToleranceTicks = p.breakToleranceTicks ?? 0;

  const result = [];
  for (const pv of pivots) {
    if (pv.i < firstPivotIndex) continue;
    if (!isSharpByClose(slice, pv.i, p, pv.type)) continue;
    if (isBrokenToRight(slice, pv.i, pv.type, lookahead, breakMode, p.tickSize, breakToleranceTicks)) continue;
    const price = pv.type === 'HIGH' ? slice[pv.i].high : slice[pv.i].low;
    result.push({
      side   : pv.type === 'HIGH' ? 'resistance' : 'support',
      type   : 'extreme',
      price,
      points : [{ timestamp: slice[pv.i].timestamp, value: price }],
      strength: 1,
      touches : 1,
    });
  }
  return result.slice(0, p.maxExtremes);
}

module.exports = { findSharpExtremes, DEFAULT_SETTINGS };
