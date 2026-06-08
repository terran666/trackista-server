'use strict';

/**
 * sharpExtremesEngine.js � Sharp Extremes (ported 1:1 from frontend sharpExtremes.ts)
 *
 * Bars format: { timestamp: number (ms), open, high, low, close, volume? }
 * NOTE: extremesEngineRoute converts Binance bars (time -> timestamp) before calling here.
 */

const DEFAULT_SETTINGS = {
  pivotLeft            : 3,
  pivotRight           : 3,
  L                    : 8,   // frontend hardcodes L:8 — must match
  R                    : 8,   // frontend hardcodes R:8 — must match
  minSlopePct          : 0.08,
  startFromFirstPivot  : true,
  unbrokenLookahead    : 300,
  breakMode            : 'equal',
  breakToleranceTicks  : 0,
  tickSize             : undefined,
  maxExtremes          : 60,
  lookbackBars         : 500,  // frontend default lookbackBars:500
};

// Per-timeframe overrides for lookbackBars and unbrokenLookahead.
//
// Strategy: always check unbrokenLookahead to the END of fetched data (use lookbackBars as
// lookahead) so broken levels never appear. To compensate on higher TFs (where a long lookback
// = almost everything gets broken), we reduce lookbackBars so we only look at recent history.
//
// lookbackBars = how far back to search for pivots (real-time equivalent):
//   5m  → 500 bars (~41h)
//   15m → 200 bars (~50h)
//   30m → 120 bars (~60h)
//   1h  →  72 bars (~72h)
//   4h  →  42 bars (~7d)
//
// unbrokenLookahead = 0 → always check to the very end of the fetched slice
const TF_DEFAULTS_BY_TF = {
  '1m' : { lookbackBars: 1000, unbrokenLookahead: 0 },
  '3m' : { lookbackBars:  600, unbrokenLookahead: 0 },
  '5m' : { lookbackBars:  500, unbrokenLookahead: 0 },
  '15m': { lookbackBars:  200, unbrokenLookahead: 0 },
  '30m': { lookbackBars:  120, unbrokenLookahead: 0 },
  '1h' : { lookbackBars:   72, unbrokenLookahead: 0 },
  '2h' : { lookbackBars:   48, unbrokenLookahead: 0 },
  '4h' : { lookbackBars:   42, unbrokenLookahead: 0 },
  '6h' : { lookbackBars:   28, unbrokenLookahead: 0 },
  '8h' : { lookbackBars:   21, unbrokenLookahead: 0 },
  '12h': { lookbackBars:   14, unbrokenLookahead: 0 },
  '1d' : { lookbackBars:    7, unbrokenLookahead: 0 },
};

/**
 * Merge per-timeframe defaults into settings unless caller explicitly overrode them.
 * Called at the top of findSharpExtremes / findSharpExtremesDebug.
 */
function _applyTfDefaults(p) {
  const tfDef = p.tf && TF_DEFAULTS_BY_TF[p.tf];
  if (!tfDef) return;
  if (p._lookaheadExplicit !== true) p.unbrokenLookahead = tfDef.unbrokenLookahead;
  if (p._lookbackExplicit  !== true) p.lookbackBars      = tfDef.lookbackBars;
}

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
  _applyTfDefaults(p);
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

/**
 * findSharpExtremesDebug — same algorithm as findSharpExtremes but returns
 * per-candle diagnostics: why each pivot was accepted or rejected.
 *
 * Returns:
 *   {
 *     pivots   : Array<{ candleIndex, timestamp, high, low, close, detectedType, finalPrice, reasons }>
 *     detected : number   // accepted count
 *     rejected : number   // rejected candidate count
 *   }
 */
function findSharpExtremesDebug(bars, settings) {
  const p = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  _applyTfDefaults(p);
  const slice = p.lookbackBars > 0 && p.lookbackBars < bars.length
    ? bars.slice(bars.length - p.lookbackBars) : bars;
  const n      = slice.length;
  const startI = p.pivotLeft;
  const endI   = n - 1 - p.pivotRight;

  const pivots = [];
  if (endI > startI) {
    for (let i = startI; i <= endI; i++) {
      if (isPivotHigh(slice, i, p.pivotLeft, p.pivotRight)) pivots.push({ i, type: 'HIGH' });
      if (isPivotLow(slice,  i, p.pivotLeft, p.pivotRight)) pivots.push({ i, type: 'LOW'  });
    }
    pivots.sort((a, b) => a.i - b.i);
  }

  if (!pivots.length) return { pivots: [], detected: 0, rejected: 0 };

  const firstPivotIndex     = p.startFromFirstPivot ? pivots[0].i : startI;
  const lookahead           = p.unbrokenLookahead ?? 0;
  const breakMode           = p.breakMode ?? 'equal';
  const breakToleranceTicks = p.breakToleranceTicks ?? 0;

  let detected = 0;
  let rejected = 0;
  const result = [];

  for (const pv of pivots) {
    const bar     = slice[pv.i];
    const reasons = [];
    let   status  = 'accepted';

    if (pv.i < firstPivotIndex) {
      reasons.push(`skipped: index ${pv.i} < firstPivotIndex ${firstPivotIndex}`);
      status = 'rejected';
    } else {
      // Check sharp slope
      const leftI  = pv.i - p.L;
      const rightI = pv.i + p.R;
      if (leftI < 0 || rightI >= slice.length) {
        reasons.push(`rejected: not enough bars for slope check (L=${p.L}, R=${p.R}, i=${pv.i}, n=${slice.length})`);
        status = 'rejected';
      } else {
        const before = slopePct(slice[leftI].close, bar.close, p.L);
        const after  = slopePct(bar.close, slice[rightI].close, p.R);
        reasons.push(`slope: before=${before.toFixed(4)}%/bar, after=${after.toFixed(4)}%/bar`);

        const sharpOk = pv.type === 'HIGH'
          ? (before > 0 && after < 0)
          : (before < 0 && after > 0);

        if (!sharpOk) {
          reasons.push(`rejected: slope check failed for ${pv.type} (need ${pv.type === 'HIGH' ? 'before>0 AND after<0' : 'before<0 AND after>0'})`);
          status = 'rejected';
        } else {
          reasons.push('sharp slope: OK');
          // Check broken
          const broken = isBrokenToRight(slice, pv.i, pv.type, lookahead, breakMode, p.tickSize, breakToleranceTicks);
          if (broken) {
            reasons.push(`rejected: level broken to the right (lookahead=${lookahead}, breakMode=${breakMode})`);
            status = 'rejected';
          } else {
            reasons.push('unbroken: OK');
          }
        }
      }
    }

    const finalPrice = pv.type === 'HIGH' ? bar.high : bar.low;
    result.push({
      candleIndex  : pv.i,
      timestamp    : bar.timestamp,
      high         : bar.high,
      low          : bar.low,
      close        : bar.close,
      detectedType : pv.type === 'HIGH' ? 'resistance' : 'support',
      priceSource  : pv.type === 'HIGH' ? 'candle.high' : 'candle.low',
      finalPrice,
      status,
      reasons,
    });

    if (status === 'accepted') detected++;
    else rejected++;
  }

  return { pivots: result, detected, rejected };
}

module.exports = { findSharpExtremes, findSharpExtremesDebug, DEFAULT_SETTINGS };
