'use strict';

/**
 * verticalExtremesEngine.js — Vertical Extremes Rays (ported 1:1 from frontend verticalExtremesRays.ts)
 *
 * Bars format: { timestamp: number (ms), open, high, low, close, volume? }
 *
 * Algorithm: pivot-based 2+ touch rays using bar extremes.
 * Right side rule: NO crossings to the right of last touch.
 * Slope filter: rejects excessively steep lines per timeframe.
 * Output: array compatible with trackedExtremesStore (points = [{timestamp, value}, ...])
 */

const DEFAULT_SETTINGS = {
  tf                      : undefined,
  lookbackBars            : 1200,
  pivotLeft               : 5,
  pivotRight              : 5,
  minPivotGapBars         : 8,
  seedTailPivots          : 50,
  minTouches              : 2,
  minTouchGapBars         : 12,
  tolPctDefault           : 0.0008,
  tolTicks                : 2,
  minTolAbs               : 0,
  tickSize                : undefined,
  rightCrossAllowRatio    : 0,
  maxLinesPerSide         : 1,
  nearNowTolMult          : 10,
  spanBonusDiv            : 150,
  maxSlopePctPerBarByTf   : { '1m': 0.0015, '3m': 0.002, '5m': 0.0025, '15m': 0.004, '1h': 0.006 },
};

function trendlinePriceAt(line, timestamp) { return line.k * timestamp + line.b; }

function getTolAbs(opts, priceRef) {
  const pct    = (opts.tf && opts.tolPctByTf && opts.tolPctByTf[opts.tf]) || opts.tolPctDefault;
  const byPct  = Math.abs(priceRef) * pct;
  const byTick = opts.tickSize && opts.tolTicks ? opts.tickSize * opts.tolTicks : 0;
  return Math.max(byPct, byTick, opts.minTolAbs || 0);
}

function clampLookback(bars, lookbackBars) {
  if (lookbackBars <= 0 || lookbackBars >= bars.length) return { start: 0, slice: bars };
  const start = Math.max(0, bars.length - lookbackBars);
  return { start, slice: bars.slice(start) };
}

function detectPivots(bars, opts) {
  const highs = [], lows = [];
  let lastHighI = -Infinity, lastLowI = -Infinity;
  for (let i = opts.pivotLeft; i < bars.length - opts.pivotRight; i++) {
    if (bars[i].synthetic) continue;
    const hi = bars[i].high, lo = bars[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - opts.pivotLeft; j <= i + opts.pivotRight; j++) {
      if (j === i) continue;
      if (bars[j].high >= hi) isHigh = false;
      if (bars[j].low  <= lo) isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh && i - lastHighI >= opts.minPivotGapBars) { highs.push({ i, t: bars[i].timestamp, price: hi }); lastHighI = i; }
    if (isLow  && i - lastLowI  >= opts.minPivotGapBars) { lows.push({ i, t: bars[i].timestamp, price: lo }); lastLowI  = i; }
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

function slopePctPerBar(p1, p2, lastPrice) {
  const dx = p2.i - p1.i;
  if (dx <= 0) return Infinity;
  return Math.abs((p2.price - p1.price) / dx) / Math.max(lastPrice, 1e-9);
}

function adjustInterceptToAvoidCross(type, bars, line, tolAbs, fromI, toI) {
  if (fromI > toI || fromI < 0 || toI >= bars.length) return line;
  if (type === 'resistance') {
    let neededB = -Infinity;
    for (let i = fromI; i <= toI; i++) neededB = Math.max(neededB, (bars[i].high - tolAbs) - line.k * bars[i].timestamp);
    return { k: line.k, b: neededB };
  } else {
    let neededB = Infinity;
    for (let i = fromI; i <= toI; i++) neededB = Math.min(neededB, (bars[i].low + tolAbs) - line.k * bars[i].timestamp);
    return { k: line.k, b: neededB };
  }
}

function adjustBToClearRight(type, bars, line, tolAbs, lastTouchI, opts) {
  if (lastTouchI < 0 || lastTouchI >= bars.length - 1) return line;
  const epsilonAbs = Math.max(tolAbs * 0.8, (opts.tickSize && opts.tickSize * 1.5) || 0);
  if (type === 'resistance') {
    let reqB = -Infinity;
    for (let i = lastTouchI + 1; i < bars.length; i++) reqB = Math.max(reqB, (bars[i].high - tolAbs) - line.k * bars[i].timestamp);
    return { k: line.k, b: Math.max(line.b, reqB + epsilonAbs) };
  } else {
    let reqB = Infinity;
    for (let i = lastTouchI + 1; i < bars.length; i++) reqB = Math.min(reqB, (bars[i].low + tolAbs) - line.k * bars[i].timestamp);
    return { k: line.k, b: Math.min(line.b, reqB - epsilonAbs) };
  }
}

function countTouches(type, bars, line, tolAbs, minTouchGapBars, startIndex, pivotSet) {
  let touches = 0, lastTouchI = -Infinity, errSum = 0;
  const touchIdx = [];
  for (let i = startIndex; i < bars.length; i++) {
    if (pivotSet && !pivotSet.has(i)) continue;
    const lp    = trendlinePriceAt(line, bars[i].timestamp);
    const probe = type === 'support' ? bars[i].low : bars[i].high;
    const err   = Math.abs(probe - lp);
    if (err <= tolAbs && i - lastTouchI >= minTouchGapBars) {
      touches++; touchIdx.push(i); lastTouchI = i; errSum += err;
    }
  }
  const avgErr     = touches > 0 ? errSum / touches : Infinity;
  const firstTouchI = touchIdx.length ? touchIdx[0] : -1;
  const lastTouch   = touchIdx.length ? touchIdx[touchIdx.length - 1] : -1;
  return { touches, touchIdx, avgErr, firstTouchI, lastTouchI: lastTouch };
}

function violatesRightNoCross(type, bars, line, tolAbs, lastTouchI, opts) {
  let violations = 0;
  const rightCount = Math.max(0, bars.length - (lastTouchI + 1));
  const maxViol = Math.floor(rightCount * opts.rightCrossAllowRatio);
  for (let i = lastTouchI + 1; i < bars.length; i++) {
    const lp = trendlinePriceAt(line, bars[i].timestamp);
    if (type === 'resistance' && lp < bars[i].high - tolAbs) { if (++violations > maxViol) return true; }
    if (type === 'support'    && lp > bars[i].low  + tolAbs) { if (++violations > maxViol) return true; }
  }
  return false;
}

function scoreRay(touches, avgErr, tolAbs, spanBars, distNow, opts) {
  if (touches < opts.minTouches) return -1e9;
  let s = touches * 12;
  if (touches >= 4) s += 10;
  if (touches >= 6) s += 10;
  if (isFinite(avgErr)) s += Math.max(0, 12 - (avgErr / Math.max(tolAbs, 1e-12)) * 6);
  s += Math.min(30, spanBars / Math.max(1, opts.spanBonusDiv));
  s += Math.max(0, 18 - (distNow / Math.max(tolAbs, 1e-9)) * 2);
  return s;
}

function buildVerticalExtremesRays(barsFull, options) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, options || {});
  const { start, slice: bars } = clampLookback(barsFull, opts.lookbackBars);
  if (bars.length < opts.pivotLeft + opts.pivotRight + 50) return [];

  const piv      = detectPivots(bars, opts);
  const lastI    = bars.length - 1;
  const lastBar  = bars[lastI];
  const priceNow = lastBar.close;
  const tolAbs   = getTolAbs(opts, priceNow);
  const nearNowTol = tolAbs * opts.nearNowTolMult;
  const lastPrice  = priceNow;

  const tfKey = opts.tf || '';
  const maxSlope = (opts.maxSlopePctPerBarByTf && opts.maxSlopePctPerBarByTf[tfKey]) ||
    (tfKey === '1m' ? 0.0015 : tfKey === '3m' ? 0.002 : tfKey === '5m' ? 0.0025 : tfKey === '15m' ? 0.004 : tfKey === '1h' ? 0.006 : 0.004);

  const makeSeeds = (type, pivots) => {
    const tail  = pivots.slice(Math.max(0, pivots.length - opts.seedTailPivots));
    const seeds = [];
    for (let a = 0; a < tail.length; a++) {
      for (let b = a + 1; b < tail.length; b++) {
        const p1 = tail[a], p2 = tail[b];
        if (p2.t <= p1.t) continue;
        if (slopePctPerBar(p1, p2, lastPrice) > maxSlope) continue;
        const line = computeLineThrough({ t: p1.t, price: p1.price }, { t: p2.t, price: p2.price });
        if (!isFinite(line.k)) continue;
        seeds.push({ p1, p2, k: line.k, b: line.b });
      }
    }
    return seeds;
  };

  const evalSeed = (type, seed, pivotSet) => {
    const base       = { k: seed.k, b: seed.b };
    const touchesInfo = countTouches(type, bars, base, tolAbs, opts.minTouchGapBars, seed.p1.i, pivotSet);
    if (touchesInfo.touches < opts.minTouches || touchesInfo.lastTouchI < 0) return null;

    const cleanSeg         = adjustInterceptToAvoidCross(type, bars, base, tolAbs, touchesInfo.firstTouchI, touchesInfo.lastTouchI);
    const rayWithRightClear = adjustBToClearRight(type, bars, cleanSeg, tolAbs, touchesInfo.lastTouchI, opts);

    const touches2 = countTouches(type, bars, rayWithRightClear, tolAbs, opts.minTouchGapBars, seed.p1.i, pivotSet);
    if (touches2.touches < opts.minTouches || touches2.lastTouchI < 0) return null;
    if (violatesRightNoCross(type, bars, rayWithRightClear, tolAbs, touches2.lastTouchI, opts)) return null;

    const ray      = rayWithRightClear;
    const lpNow    = ray.k * lastBar.timestamp + ray.b;
    const distNow  = Math.abs(lpNow - priceNow);
    const firstI   = touches2.firstTouchI;
    const lastTouchI = touches2.lastTouchI;
    const spanBars = lastTouchI - firstI;

    let score = scoreRay(touches2.touches, touches2.avgErr, tolAbs, spanBars, distNow, opts);
    if (distNow > nearNowTol) score -= (distNow / nearNowTol) * 15;
    if (score < -1e8) return null;

    // Convert to store-compatible points using actual anchor bar prices
    const p1Price = type === 'support' ? bars[firstI].low   : bars[firstI].high;
    const p2Price = type === 'support' ? bars[lastTouchI].low : bars[lastTouchI].high;

    return {
      id     : `${type}:${bars[firstI].timestamp}:${bars[lastTouchI].timestamp}`,
      type,
      k      : ray.k,
      b      : ray.b,
      touches: touches2.touches,
      score,
      p1     : { i: firstI + start, t: bars[firstI].timestamp, price: p1Price },
      p2     : { i: lastTouchI + start, t: bars[lastTouchI].timestamp, price: p2Price },
    };
  };

  const supportPivotSet    = new Set(piv.lows.map(p => p.i));
  const resistancePivotSet = new Set(piv.highs.map(p => p.i));

  const supports = [], resists = [];
  for (const s of makeSeeds('support',    piv.lows))  { const tl = evalSeed('support',    s, supportPivotSet);    if (tl) supports.push(tl); }
  for (const s of makeSeeds('resistance', piv.highs)) { const tl = evalSeed('resistance', s, resistancePivotSet); if (tl) resists.push(tl);  }

  supports.sort((a, b) => b.score - a.score);
  resists.sort((a,  b) => b.score - a.score);

  return [
    ...supports.slice(0, opts.maxLinesPerSide),
    ...resists.slice(0, opts.maxLinesPerSide),
  ];
}

/**
 * Main export — converts ray results to trackedExtremesStore format.
 * @param {Array<{timestamp,open,high,low,close,volume}>} bars
 * @param {object} [settings]
 * @returns {Array<{side,type,price,points,strength,touches}>}
 */
function findVerticalExtremes(bars, settings) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const rays = buildVerticalExtremesRays(bars, opts);

  return rays.map(ray => ({
    side   : ray.type,
    type   : 'line',
    price  : ray.p2.price,
    points : [
      { timestamp: ray.p1.t, value: ray.p1.price },
      { timestamp: ray.p2.t, value: ray.p2.price },
    ],
    strength: ray.score,
    touches : ray.touches,
    meta   : { k: ray.k, b: ray.b },
  }));
}

module.exports = { findVerticalExtremes, DEFAULT_SETTINGS };
