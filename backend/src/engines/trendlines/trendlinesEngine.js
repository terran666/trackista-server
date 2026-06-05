'use strict';

/**
 * trendlinesEngine.js — Trendlines (ported 1:1 from frontend trendlines.ts)
 *
 * Bars format: { timestamp: number (ms), open, high, low, close, volume? }
 *
 * Algorithm: pivot-based, time-space line equation price = k*t + b.
 * Filters: side/cut rule, hard no-penetration, ray-crosses-bars, path-following,
 *          near-now relevance, break detection.
 * Output: array compatible with trackedExtremesStore.
 */

const DEFAULT_SETTINGS = {
  mode              : 'local',
  tf                : undefined,
  lookbackBars      : 1200,
  pivotLeft         : 5,
  pivotRight        : 5,
  minPivotGapBars   : 8,
  maxLinesPerSide   : 3,
  tolPctDefault     : 0.0008,
  tolTicks          : 2,
  minTolAbs         : 0,
  tickSize          : undefined,
  minTouchGapBars   : 12,
  breakTolMult      : 1.5,
  breakConfirmBars  : 2,
  minAngleDeg       : 3,
  maxAngleDeg       : 70,
  mergeTolMult      : 1.0,
};

function trendlinePriceAt(line, timestamp) { return line.k * timestamp + line.b; }

function clampLookback(bars, lookbackBars) {
  if (lookbackBars <= 0 || lookbackBars >= bars.length) return { start: 0, slice: bars };
  const start = Math.max(0, bars.length - lookbackBars);
  return { start, slice: bars.slice(start) };
}

function getTolAbs(opts, priceRef) {
  const pct    = (opts.tf && opts.tolPctByTf && opts.tolPctByTf[opts.tf]) || opts.tolPctDefault;
  const byPct  = Math.abs(priceRef) * pct;
  const byTick = opts.tickSize && opts.tolTicks ? opts.tickSize * opts.tolTicks : 0;
  return Math.max(byPct, byTick, opts.minTolAbs || 0);
}

function detectPivots(bars, pivotLeft, pivotRight, minPivotGapBars) {
  const highs = [], lows = [];
  let lastHighI = -Infinity, lastLowI = -Infinity;
  for (let i = pivotLeft; i < bars.length - pivotRight; i++) {
    const hi = bars[i].high, lo = bars[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - pivotLeft; j <= i + pivotRight; j++) {
      if (j === i) continue;
      if (bars[j].high >= hi) isHigh = false;
      if (bars[j].low  <= lo) isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh && i - lastHighI >= minPivotGapBars) { highs.push({ i, t: bars[i].timestamp, price: hi }); lastHighI = i; }
    if (isLow  && i - lastLowI  >= minPivotGapBars) { lows.push({ i, t: bars[i].timestamp, price: lo }); lastLowI  = i; }
  }
  return { highs, lows };
}

function computeLineThrough(p1, p2) {
  const dt = p2.t - p1.t;
  if (dt === 0) return { k: Infinity, b: NaN };
  const k = (p2.price - p1.price) / dt;
  const b = p1.price - k * p1.t;
  return { k, b };
}

function passesSideAndCutRule(type, bars, line, tolAbs, startIndex) {
  let okSide = 0, cutBad = 0;
  const total = Math.max(1, bars.length - startIndex);
  for (let i = startIndex; i < bars.length; i++) {
    const lp = trendlinePriceAt(line, bars[i].timestamp);
    if (type === 'support') {
      if (bars[i].low  >= lp - tolAbs) okSide++;
      if (bars[i].close < lp - tolAbs * 1.2) cutBad++;
    } else {
      if (bars[i].high <= lp + tolAbs) okSide++;
      if (bars[i].close > lp + tolAbs * 1.2) cutBad++;
    }
  }
  return (okSide / total) >= 0.82 && (cutBad / total) <= 0.08;
}

function passesHardNoPenetration(type, bars, line, tolAbs, startIndex) {
  let violations = 0;
  const maxV = Math.max(1, Math.floor((bars.length - startIndex) * 0.02));
  for (let i = startIndex; i < bars.length; i++) {
    const lp = trendlinePriceAt(line, bars[i].timestamp);
    if (type === 'support'    && bars[i].low  < lp - tolAbs) { if (++violations > maxV) return false; }
    if (type === 'resistance' && bars[i].high > lp + tolAbs) { if (++violations > maxV) return false; }
  }
  return true;
}

function rejectIfRayCrossesBars(type, bars, line, tolAbs, startIndex, tickSize) {
  const tolCross = Math.min(tolAbs * 0.3, tickSize && tickSize > 0 ? tickSize : tolAbs * 0.15);
  for (let i = startIndex; i < bars.length; i++) {
    const lp = trendlinePriceAt(line, bars[i].timestamp);
    if (type === 'resistance' && lp < bars[i].high - tolCross) return true;
    if (type === 'support'    && lp > bars[i].low  + tolCross) return true;
  }
  return false;
}

function rejectIfPathFollowing(bars, line, tolAbs, startIndex, nearStreakLimit, nearDistanceMult) {
  const nearDist = tolAbs * (nearDistanceMult || 1.0);
  let streak = 0;
  for (let i = startIndex; i < bars.length; i++) {
    const lp = trendlinePriceAt(line, bars[i].timestamp);
    if (Math.abs(bars[i].close - lp) <= nearDist) { if (++streak >= nearStreakLimit) return true; }
    else streak = 0;
  }
  return false;
}

function isBroken(type, bars, line, tolAbs, breakTolMult, breakConfirmBars, fromIndex) {
  const breakTol = tolAbs * breakTolMult;
  let streak = 0;
  for (let i = fromIndex; i < bars.length; i++) {
    const lp   = trendlinePriceAt(line, bars[i].timestamp);
    const broke = type === 'support' ? bars[i].close < lp - breakTol : bars[i].close > lp + breakTol;
    if (broke) streak++; else streak = 0;
    if (streak >= breakConfirmBars) return { brokenAtT: bars[i].timestamp };
  }
  return {};
}

function countTouches(type, bars, line, tolAbs, minTouchGapBars, startIndex) {
  let touches = 0, lastTouchI = -Infinity, errSum = 0;
  const touchIdx = [];
  for (let i = startIndex; i < bars.length; i++) {
    const lp    = trendlinePriceAt(line, bars[i].timestamp);
    const probe = type === 'support' ? bars[i].low : bars[i].high;
    const err   = Math.abs(probe - lp);
    if (err <= tolAbs && i - lastTouchI >= minTouchGapBars) {
      touches++; touchIdx.push(i); lastTouchI = i; errSum += err;
    }
  }
  return {
    touches, touchIdx,
    avgErr    : touches > 0 ? errSum / touches : Infinity,
    lastTouchI: touchIdx.length ? touchIdx[touchIdx.length - 1] : -1,
  };
}

function scoreLine(touches, avgErr, tolAbs, lengthBars, broken) {
  if (touches < 2) return -1e9;
  let s = touches * 10;
  if (touches >= 3) s += 10;
  if (isFinite(avgErr)) s += Math.max(0, 10 - (avgErr / Math.max(tolAbs, 1e-12)) * 5);
  s += Math.min(15, lengthBars / 200);
  if (broken) s -= 20;
  return s;
}

function buildCandidatesFromPivots(type, pivots, bars, opts) {
  const out  = [];
  const tail = pivots.slice(Math.max(0, pivots.length - 30));
  const recentFrom = opts.mode === 'global' ? 0.3 : 0.6;
  const mustBeRecentFrom = Math.floor(bars.length * recentFrom);
  const lastPrice = bars[bars.length - 1]?.close || 1;

  const tfKey = opts.tf || '';
  const maxSlopePctPerBar = tfKey === '1m' ? 0.0015 : tfKey === '3m' ? 0.002 : tfKey === '5m' ? 0.0025 : tfKey === '15m' ? 0.004 : tfKey === '1h' ? 0.006 : 0.004;

  for (let a = 0; a < tail.length; a++) {
    for (let b = a + 1; b < tail.length; b++) {
      const p1 = tail[a], p2 = tail[b];
      if (p2.t <= p1.t) continue;
      if (p2.i < mustBeRecentFrom) continue;
      const line = computeLineThrough({ t: p1.t, price: p1.price }, { t: p2.t, price: p2.price });
      if (!isFinite(line.k)) continue;
      const barsDx = p2.i - p1.i;
      if (barsDx <= 0) continue;
      const spb = Math.abs((p2.price - p1.price) / barsDx) / Math.max(lastPrice, 1e-9);
      if (spb > maxSlopePctPerBar) continue;
      out.push({ type, p1, p2, k: line.k, b: line.b });
    }
  }
  return out;
}

function mergeSimilarTrendlines(lines, opts, lastT) {
  if (lines.length <= 1) return lines;
  const out = [];
  for (const l of lines) {
    let merged = false;
    for (let ki = 0; ki < out.length; ki++) {
      const keep = out[ki];
      const slopeClose = Math.abs(l.k - keep.k) <= Math.max(Math.abs(keep.k), 1e-12) * 0.25;
      if (!slopeClose) continue;
      const tolAbs   = keep._tolAbs || getTolAbs(opts, 1);
      const mergeTol = tolAbs * opts.mergeTolMult;
      const t = lastT || 0;
      const d = Math.abs(trendlinePriceAt(l, t) - trendlinePriceAt(keep, t));
      if (d > mergeTol) continue;
      const lSpan = l._spanBars || 0, kSpan = keep._spanBars || 0;
      if (l.score > keep.score || (Math.abs(l.score - keep.score) < 5 && lSpan > kSpan)) out[ki] = l;
      merged = true; break;
    }
    if (!merged) out.push(l);
  }
  return out;
}

function buildTrendlines(barsFull, options) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, options || {});
  const { start, slice: bars } = clampLookback(barsFull, opts.lookbackBars);
  if (bars.length < opts.pivotLeft + opts.pivotRight + 10) return [];

  const piv = detectPivots(bars, opts.pivotLeft, opts.pivotRight, opts.minPivotGapBars);

  const supportCandidates = buildCandidatesFromPivots('support',    piv.lows,  bars, opts);
  const resistCandidates  = buildCandidatesFromPivots('resistance', piv.highs, bars, opts);

  const lastI  = bars.length - 1;
  const lastT  = bars[lastI].timestamp;
  const scored = [];

  const evalCandidate = (c) => {
    const priceRef = bars[lastI].close;
    const tolAbs   = getTolAbs(opts, priceRef);
    const startIdxStrict = Math.max(c.p1.i, 0);

    if (!passesSideAndCutRule(c.type, bars, c, tolAbs, startIdxStrict)) return null;
    if (!passesHardNoPenetration(c.type, bars, c, tolAbs, startIdxStrict)) return null;
    if (rejectIfRayCrossesBars(c.type, bars, c, tolAbs, startIdxStrict, opts.tickSize)) return null;
    const nearLimit = opts.tf === '1m' ? 15 : 10;
    if (rejectIfPathFollowing(bars, c, tolAbs, startIdxStrict, nearLimit, 1.0)) return null;

    const priceNow   = bars[lastI].close;
    const lpNow      = trendlinePriceAt(c, bars[lastI].timestamp);
    const distNow    = Math.abs(lpNow - priceNow);
    const nearNowTol = tolAbs * (opts.mode === 'global' ? 25 : 8);
    if (distNow > nearNowTol) return null;

    const startIdx    = Math.max(c.p2.i + 1, 0);
    const broken      = isBroken(c.type, bars, c, tolAbs, opts.breakTolMult, opts.breakConfirmBars, startIdx);
    const touchesInfo = countTouches(c.type, bars, c, tolAbs, opts.minTouchGapBars, Math.max(c.p1.i, 0));

    const recentTouchBars = opts.mode === 'global'
      ? (opts.tf === '1m' ? 800 : 250)
      : (opts.tf === '1m' ? 180 : 80);
    if (touchesInfo.lastTouchI < 0 || lastI - touchesInfo.lastTouchI > recentTouchBars) return null;

    const spanBars = lastI - c.p1.i;
    let   s        = scoreLine(touchesInfo.touches, touchesInfo.avgErr, tolAbs, spanBars, !!broken.brokenAtT);
    s += Math.max(0, 15 - (distNow / Math.max(tolAbs, 1e-9)) * 2);
    s += Math.min(30, spanBars / 150);
    if (s < -1e8) return null;

    return {
      type       : c.type,
      k          : c.k, b: c.b,
      touches    : touchesInfo.touches,
      score      : s,
      brokenAtT  : broken.brokenAtT,
      _tolAbs    : tolAbs,
      _spanBars  : spanBars,
      p1         : { i: c.p1.i + start, t: c.p1.t, price: c.p1.price },
      p2         : { i: c.p2.i + start, t: c.p2.t, price: c.p2.price },
    };
  };

  for (const c of [...supportCandidates, ...resistCandidates]) {
    const tl = evalCandidate(c); if (tl) scored.push(tl);
  }

  const supports = scored.filter(x => x.type === 'support').sort((a, b) => b.score - a.score);
  const resists  = scored.filter(x => x.type === 'resistance').sort((a, b) => b.score - a.score);

  const topSupports = mergeSimilarTrendlines(supports.slice(0, 20), opts, lastT).slice(0, opts.maxLinesPerSide);
  const topResists  = mergeSimilarTrendlines(resists.slice(0, 20),  opts, lastT).slice(0, opts.maxLinesPerSide);

  return [...topSupports, ...topResists];
}

/**
 * Main export — converts trendline results to trackedExtremesStore format.
 * @param {Array<{timestamp,open,high,low,close,volume}>} bars
 * @param {object} [settings]
 * @returns {Array<{side,type,price,points,strength,touches}>}
 */
function findTrendlines(bars, settings) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const lines = buildTrendlines(bars, opts);

  return lines.map(l => ({
    side   : l.type,
    type   : 'line',
    price  : l.p2.price,
    points : [
      { timestamp: l.p1.t, value: l.p1.price },
      { timestamp: l.p2.t, value: l.p2.price },
    ],
    strength: l.score,
    touches : l.touches,
    meta   : { k: l.k, b: l.b, brokenAtT: l.brokenAtT },
  }));
}

module.exports = { findTrendlines, DEFAULT_SETTINGS };
