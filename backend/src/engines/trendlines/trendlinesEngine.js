'use strict';

/**
 * trendlinesEngine.js — Trendlines Algorithm
 *
 * Finds ascending support trendlines and descending resistance trendlines
 * by connecting confirmed pivot points and scoring them by touch count.
 *
 * Algorithm:
 *   1. Identify pivot highs (local max within pivotWindow) and pivot lows (local min)
 *   2. For every ordered pair of same-type pivots, compute slope + intercept
 *      — Ascending  (support):    p2.price > p1.price
 *      — Descending (resistance): p2.price < p1.price
 *   3. Count additional pivots within touchTolerancePct of the line ("touches")
 *   4. Reject lines with fewer than minTouches (anchor pair = 2)
 *   5. Deduplicate: for lines sharing an anchor pivot keep only the highest-scoring
 *   6. Sort by touches desc, cap at maxLinesPerSide per side
 *
 * Trendline points array: [p1 (older anchor), p2 (newer anchor)]
 * The frontend extends this line using slope to the current bar.
 *
 * Output: array of trendline records compatible with trackedExtremesStore.bulkSave()
 */

const DEFAULT_SETTINGS = {
  pivotWindow         : 3,      // bars left/right to confirm a pivot
  lookbackBars        : 200,    // trailing window of bars to scan
  minTouches          : 2,      // minimum touches (anchor pair = 2, so this is always met)
  touchTolerancePct   : 0.35,   // % tolerance to count an additional touch
  maxLinesPerSide     : 5,      // max output lines per side
  minSlopePct         : 0.001,  // min % slope per bar — rejects nearly-horizontal lines
                                // (those are better handled by Sharp/Vertical Extremes)
};

/**
 * Find trendlines in bars array.
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} bars
 *   Bars sorted oldest → newest.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [settings]
 * @returns {Array<{side,type,price,points,strength,touches}>}
 */
function findTrendlines(bars, settings = {}) {
  const cfg   = { ...DEFAULT_SETTINGS, ...settings };
  const slice = bars.slice(-cfg.lookbackBars);
  const n     = slice.length;
  const pw    = cfg.pivotWindow;

  if (n < pw * 2 + 2) return [];

  // ── 1. Find pivots ────────────────────────────────────────────
  const pivotHighs = [];
  const pivotLows  = [];

  for (let i = pw; i < n - pw; i++) {
    const bar = slice[i];

    let isPH = true;
    for (let j = i - pw; j <= i + pw; j++) {
      if (j !== i && slice[j].high >= bar.high) { isPH = false; break; }
    }
    if (isPH) pivotHighs.push({ i, time: bar.time, price: bar.high });

    let isPL = true;
    for (let j = i - pw; j <= i + pw; j++) {
      if (j !== i && slice[j].low <= bar.low) { isPL = false; break; }
    }
    if (isPL) pivotLows.push({ i, time: bar.time, price: bar.low });
  }

  const candidates = [];

  // ── 2. Build resistance lines (descending pivot highs) ────────
  _buildLines(pivotHighs, cfg, 'resistance', false /* descending */, candidates);

  // ── 3. Build support lines (ascending pivot lows) ─────────────
  _buildLines(pivotLows, cfg, 'support', true /* ascending */, candidates);

  // ── 4. Sort + dedup + cap per side ────────────────────────────
  const resistance = _finalize(candidates.filter(l => l.side === 'resistance'), cfg.maxLinesPerSide);
  const support    = _finalize(candidates.filter(l => l.side === 'support'),    cfg.maxLinesPerSide);

  return [...resistance, ...support];
}

// ─── Internal ─────────────────────────────────────────────────────

function _buildLines(pivots, cfg, side, ascending, out) {
  const np = pivots.length;
  for (let a = 0; a < np - 1; a++) {
    for (let b = a + 1; b < np; b++) {
      const p1 = pivots[a];
      const p2 = pivots[b];

      // Enforce directionality
      if ( ascending && p2.price <= p1.price) continue;
      if (!ascending && p2.price >= p1.price) continue;

      // Reject near-flat lines (slope too small relative to price level)
      const barSpan    = p2.i - p1.i;
      const slopePct   = Math.abs(p2.price - p1.price) / p1.price / barSpan * 100;
      if (slopePct < cfg.minSlopePct) continue;

      // Line equation: price(i) = slope × i + intercept
      const slope     = (p2.price - p1.price) / barSpan;
      const intercept = p1.price - slope * p1.i;

      // Count additional pivots touching this line
      let touches = 2; // anchor pair always counts
      for (let k = 0; k < np; k++) {
        if (k === a || k === b) continue;
        const pk       = pivots[k];
        const expected = slope * pk.i + intercept;
        if (expected <= 0) continue;
        const diffPct  = Math.abs(pk.price - expected) / expected * 100;
        if (diffPct <= cfg.touchTolerancePct) touches++;
      }

      if (touches < cfg.minTouches) continue;

      out.push({
        side,
        type    : 'line',
        price   : _r4(p2.price),     // most-recent anchor price (frontend uses for label)
        points  : [
          { timestamp: p1.time, value: _r4(p1.price) },
          { timestamp: p2.time, value: _r4(p2.price) },
        ],
        strength: touches,
        touches,
        // Internal fields for dedup — stripped before returning
        _a: a,
        _b: b,
      });
    }
  }
}

/**
 * Sort by touches desc, deduplicate (each pivot anchor used at most once),
 * cap at maxLines, and strip internal fields.
 */
function _finalize(lines, maxLines) {
  lines.sort((a, b) => b.touches - a.touches || b._b - a._b);

  const usedA = new Set();
  const usedB = new Set();
  const out   = [];

  for (const l of lines) {
    if (usedA.has(l._a) || usedB.has(l._b)) continue;
    usedA.add(l._a);
    usedB.add(l._b);
    const { _a, _b, ...clean } = l;  // eslint-disable-line no-unused-vars
    out.push(clean);
    if (out.length >= maxLines) break;
  }

  return out;
}

function _r4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { findTrendlines, DEFAULT_SETTINGS };
