'use strict';

/**
 * v3/pivots.js — swing-pivot detection shared by level building and geometry.
 * A pivot high/low is a bar whose high/low is the extreme of a ±strength window.
 */

function findPivots(bars, strength = 3) {
  const highs = [];
  const lows = [];
  const n = bars.length;
  for (let i = strength; i < n - strength; i++) {
    const b = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (bars[j].high >= b.high) isHigh = false;
      if (bars[j].low <= b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ ts: b.ts, price: b.high, idx: i });
    if (isLow) lows.push({ ts: b.ts, price: b.low, idx: i });
  }
  return { highs, lows };
}

/** Group nearby pivot prices into clustered levels. */
function clusterPivots(pivots, tolPct) {
  if (!pivots.length) return [];
  const sorted = pivots.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = cur[cur.length - 1].price;
    const diffPct = Math.abs(sorted[i].price - prev) / prev * 100;
    if (diffPct <= tolPct) {
      cur.push(sorted[i]);
    } else {
      clusters.push(cur);
      cur = [sorted[i]];
    }
  }
  clusters.push(cur);
  return clusters.map(group => {
    const price = group.reduce((s, p) => s + p.price, 0) / group.length;
    const lastTs = Math.max(...group.map(p => p.ts));
    const firstTs = Math.min(...group.map(p => p.ts));
    return { price, touches: group.length, firstTs, lastTs };
  });
}

module.exports = { findPivots, clusterPivots };
