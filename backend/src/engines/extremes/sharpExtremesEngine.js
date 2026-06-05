'use strict';

/**
 * sharpExtremesEngine.js — Sharp Extremes Algorithm
 *
 * Finds significant pivot highs/lows (sharp reversals) in bar data.
 * A "sharp" extreme is a pivot whose price movement to the turning point
 * exceeds a minimum strength threshold vs the local price range.
 *
 * Algorithm:
 *   1. Scan bars for pivot highs: bar.high > all bars in [i-pivotWindow, i+pivotWindow]
 *   2. Scan bars for pivot lows : bar.low  < all bars in [i-pivotWindow, i+pivotWindow]
 *   3. Filter by strength: % move from local window extremum must >= minStrengthPct
 *   4. Sort by strength desc, cap at maxExtremes
 *
 * Output: array of extreme records compatible with trackedExtremesStore.bulkSave()
 */

const DEFAULT_SETTINGS = {
  pivotWindow    : 3,    // bars left/right required to confirm a pivot
  lookbackBars   : 200,  // trailing window of bars to scan
  minStrengthPct : 0.3,  // min % move from window extremum to qualify as "sharp"
  maxExtremes    : 60,   // hard cap on output count
};

/**
 * Find sharp extremes in bars array.
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} bars
 *   Bars sorted oldest → newest.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [settings]
 * @returns {Array<{side,type,price,points,strength,touches}>}
 */
function findSharpExtremes(bars, settings = {}) {
  const cfg   = { ...DEFAULT_SETTINGS, ...settings };
  const slice = bars.slice(-cfg.lookbackBars);
  const n     = slice.length;
  const pw    = cfg.pivotWindow;

  if (n < pw * 2 + 1) return [];

  const results = [];

  for (let i = pw; i < n - pw; i++) {
    const bar = slice[i];

    // ── Pivot High ────────────────────────────────────────────
    let isPH = true;
    for (let j = i - pw; j <= i + pw; j++) {
      if (j !== i && slice[j].high >= bar.high) { isPH = false; break; }
    }
    if (isPH) {
      const windowLow    = _minLow(slice, i - pw, i + pw);
      const strengthPct  = windowLow > 0 ? (bar.high - windowLow) / windowLow * 100 : 0;
      if (strengthPct >= cfg.minStrengthPct) {
        results.push({
          side    : 'resistance',
          type    : 'extreme',
          price   : bar.high,
          points  : [{ timestamp: bar.time, value: bar.high }],
          strength: _r2(strengthPct),
          touches : 1,
        });
      }
    }

    // ── Pivot Low ─────────────────────────────────────────────
    let isPL = true;
    for (let j = i - pw; j <= i + pw; j++) {
      if (j !== i && slice[j].low <= bar.low) { isPL = false; break; }
    }
    if (isPL) {
      const windowHigh   = _maxHigh(slice, i - pw, i + pw);
      const strengthPct  = bar.low > 0 ? (windowHigh - bar.low) / bar.low * 100 : 0;
      if (strengthPct >= cfg.minStrengthPct) {
        results.push({
          side    : 'support',
          type    : 'extreme',
          price   : bar.low,
          points  : [{ timestamp: bar.time, value: bar.low }],
          strength: _r2(strengthPct),
          touches : 1,
        });
      }
    }
  }

  // Sort by strength descending so the caller gets the most significant first
  results.sort((a, b) => b.strength - a.strength);
  return results.slice(0, cfg.maxExtremes);
}

// ─── Helpers ──────────────────────────────────────────────────────

function _minLow(bars, from, to) {
  let m = Infinity;
  for (let i = from; i <= to; i++) if (bars[i].low  < m) m = bars[i].low;
  return m;
}

function _maxHigh(bars, from, to) {
  let m = -Infinity;
  for (let i = from; i <= to; i++) if (bars[i].high > m) m = bars[i].high;
  return m;
}

function _r2(v) { return Math.round(v * 100) / 100; }

module.exports = { findSharpExtremes, DEFAULT_SETTINGS };
