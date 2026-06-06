'use strict';

/**
 * detectorHelpers.js
 * Shared utilities for all pattern detectors.
 */

/**
 * Count bars whose high is within tolerance of a resistance level,
 * or whose low is within tolerance of a support level.
 * Returns array of touch objects { timestamp, price, barIndex }.
 */
function findTouches(bars, levelPrice, toleranceAbs, side) {
  const touches = [];
  let lastTouchIdx = -Infinity;
  const MIN_GAP = 3; // bars between touches

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const testPrice = side === 'resistance' ? b.high : b.low;
    if (Math.abs(testPrice - levelPrice) <= toleranceAbs && i - lastTouchIdx >= MIN_GAP) {
      touches.push({ timestamp: b.ts, price: testPrice, barIndex: i });
      lastTouchIdx = i;
    }
  }
  return touches;
}

/**
 * Find the bar closest to a given timestamp (within the bar array).
 * Returns { bar, index } or null.
 */
function barNearTimestamp(bars, ts) {
  if (!bars.length) return null;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.abs(bars[i].ts - ts);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return { bar: bars[best], index: best };
}

/**
 * Detect higher-lows in a sequence of values (for LONG structure confirmation).
 * Returns true if last 3+ pivots are progressively higher.
 */
function hasHigherLows(values) {
  if (values.length < 3) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) return false;
  }
  return true;
}

/**
 * Detect lower-highs (for SHORT structure confirmation).
 */
function hasLowerHighs(values) {
  if (values.length < 3) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) return false;
  }
  return true;
}

/**
 * Find swing lows in a window. Returns array of { price, index, ts }.
 */
function findSwingLows(bars, window = 3) {
  const pivots = [];
  for (let i = window; i < bars.length - window; i++) {
    const b = bars[i];
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && bars[j].low < b.low) { isLow = false; break; }
    }
    if (isLow) pivots.push({ price: b.low, index: i, ts: b.ts });
  }
  return pivots;
}

/**
 * Find swing highs.
 */
function findSwingHighs(bars, window = 3) {
  const pivots = [];
  for (let i = window; i < bars.length - window; i++) {
    const b = bars[i];
    let isHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && bars[j].high > b.high) { isHigh = false; break; }
    }
    if (isHigh) pivots.push({ price: b.high, index: i, ts: b.ts });
  }
  return pivots;
}

/**
 * Compute range compression ratio between first half and second half of bars.
 * Returns 0..100 (100 = max compression).
 */
function computeCompression(bars) {
  if (bars.length < 10) return 0;
  const half = Math.floor(bars.length / 2);
  const oldHalf = bars.slice(0, half);
  const newHalf = bars.slice(half);

  const rangeOf = (bs) => {
    let hi = -Infinity, lo = Infinity;
    for (const b of bs) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    return hi - lo;
  };

  const oldRange = rangeOf(oldHalf);
  const newRange = rangeOf(newHalf);
  if (oldRange === 0) return 0;

  const ratio = 1 - newRange / oldRange; // positive = compressed
  return Math.max(0, Math.min(100, ratio * 100));
}

/**
 * Compute simple volume growth % comparing first and second half.
 */
function computeVolumeGrowth(bars) {
  if (bars.length < 6) return 0;
  const half = Math.floor(bars.length / 2);
  const avgVol = (bs) => bs.reduce((s, b) => s + (b.volume || 0), 0) / bs.length;
  const v1 = avgVol(bars.slice(0, half));
  const v2 = avgVol(bars.slice(half));
  if (v1 === 0) return 0;
  return Math.max(0, Math.min(100, (v2 - v1) / v1 * 100));
}

module.exports = {
  findTouches,
  barNearTimestamp,
  hasHigherLows,
  hasLowerHighs,
  findSwingLows,
  findSwingHighs,
  computeCompression,
  computeVolumeGrowth,
};
