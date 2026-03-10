'use strict';

// ─── Default config ───────────────────────────────────────────────
const DEFAULT_CONFIG = {
  pivotLeft:  5,
  pivotRight: 5,

  toleranceMode:    'percent',
  tolerancePercent: 0.25,

  minPivotsInCluster: 2,
  minTouches:         2,

  maxLevels:                        10,
  minDistancePercentBetweenLevels:  0.15,

  wPivots:  2,
  wTouches: 1,
  wSpan:    1,
};

function mergeConfig(partial) {
  return { ...DEFAULT_CONFIG, ...(partial ?? {}) };
}

// ─── Pivot detection ──────────────────────────────────────────────
function findPivots(prices, left, right) {
  const n = prices.length;
  if (n === 0) return [];

  const pivots = [];

  for (let i = left; i < n - right; i++) {
    const p = prices[i];
    let isHigh = true;
    let isLow  = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const pj = prices[j];
      if (p <= pj) isHigh = false;
      if (p >= pj) isLow  = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh)      pivots.push({ index: i, price: p, type: 'high' });
    else if (isLow)  pivots.push({ index: i, price: p, type: 'low'  });
  }

  return pivots;
}

// ─── Clustering ───────────────────────────────────────────────────
function priceTolerance(price, percent) {
  return Math.abs(price) * (percent / 100);
}

function median(values) {
  if (values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function clusterPivotsByPrice(pivots, tolerancePercent) {
  if (pivots.length === 0) return [];

  const sorted = [...pivots].sort((a, b) => a.price - b.price);

  const clusters = [];

  let current = {
    prices:     [sorted[0].price],
    indices:    [sorted[0].index],
    pivotTypes: [sorted[0].type],
  };

  for (let i = 1; i < sorted.length; i++) {
    const pv     = sorted[i];
    const center = median(current.prices);
    const tol    = priceTolerance(center, tolerancePercent);

    if (Math.abs(pv.price - center) <= tol) {
      current.prices.push(pv.price);
      current.indices.push(pv.index);
      current.pivotTypes.push(pv.type);
    } else {
      clusters.push(current);
      current = {
        prices:     [pv.price],
        indices:    [pv.index],
        pivotTypes: [pv.type],
      };
    }
  }

  clusters.push(current);
  return clusters;
}

// ─── Levels calculation ───────────────────────────────────────────
function clampBars(bars) {
  return bars.filter(
    b =>
      Number.isFinite(b.time) &&
      Number.isFinite(b.close) &&
      b.time > 0,
  );
}

function countTouches(prices, levelPrice, tolAbs) {
  let c = 0;
  for (let i = 0; i < prices.length; i++) {
    if (Math.abs(prices[i] - levelPrice) <= tolAbs) c++;
  }
  return c;
}

function timeSpanBonus(indices, totalLen) {
  if (indices.length < 2) return 0;
  const minI = Math.min(...indices);
  const maxI = Math.max(...indices);
  const span = maxI - minI;
  return totalLen > 1 ? span / (totalLen - 1) : 0;
}

function filterCloseLevels(levels, minDistPercent) {
  const sorted = [...levels].sort((a, b) => b.strength - a.strength);
  const kept   = [];

  for (const lvl of sorted) {
    const tooClose = kept.some(k => {
      const tol = priceTolerance(k.price, minDistPercent);
      return Math.abs(lvl.price - k.price) <= tol;
    });
    if (!tooClose) kept.push(lvl);
  }

  return kept.sort((a, b) => a.price - b.price);
}

/**
 * @param {{ bars: object[], levelType: string, sourceInterval: string, config?: object }} params
 * @returns {{ price: number, type: string, sourceInterval: string, strength: number, touches: number, pivots: number, fromTs: number, toTs: number }[]}
 */
function calculateLevels(params) {
  const config = mergeConfig(params.config);
  const bars   = clampBars(params.bars);

  if (bars.length < config.pivotLeft + config.pivotRight + 5) return [];

  const closes = bars.map(b => b.close);
  const pivots  = findPivots(closes, config.pivotLeft, config.pivotRight);
  const clusters = clusterPivotsByPrice(pivots, config.tolerancePercent);

  const fromTs = bars[0].time;
  const toTs   = bars[bars.length - 1].time;

  const candidates = [];

  for (const cl of clusters) {
    const pivotsCount = cl.prices.length;
    if (pivotsCount < config.minPivotsInCluster) continue;

    const price  = median(cl.prices);
    const tolAbs = priceTolerance(price, config.tolerancePercent);
    const touches = countTouches(closes, price, tolAbs);

    if (touches < config.minTouches) continue;

    const spanBonus = timeSpanBonus(cl.indices, closes.length);

    const strength =
      config.wPivots  * pivotsCount +
      config.wTouches * touches     +
      config.wSpan    * spanBonus;

    candidates.push({
      price,
      type:           params.levelType,
      sourceInterval: params.sourceInterval,
      strength,
      touches,
      pivots:         pivotsCount,
      fromTs,
      toTs,
    });
  }

  candidates.sort((a, b) => b.strength - a.strength);

  const trimmed  = candidates.slice(0, Math.max(1, config.maxLevels * 3));
  const filtered = filterCloseLevels(trimmed, config.minDistancePercentBetweenLevels);

  return filtered
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.maxLevels)
    .sort((a, b) => a.price - b.price);
}

module.exports = { calculateLevels };
