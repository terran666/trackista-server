'use strict';

/**
 * AutoLevels Engine — 1-to-1 port of frontend src/levels/autoLevels.js
 *
 * Key differences from backend levelsEngine.js:
 *  - uses bar.timestamp instead of bar.time (frontend convention)
 *  - clusterByBins (fixed grid) instead of median clustering
 *  - virginOnly filter with policy fallback queue
 *  - outputs { price, side, touches, score, virgin, ... } not Level type
 */

function safeNumber(value, fallback) {
  if (fallback === undefined) fallback = 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function calculateAtr(bars, period) {
  if (period === undefined) period = 14;
  if (!Array.isArray(bars) || bars.length < period + 2) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h  = safeNumber(bars[i]?.high,  NaN);
    const l  = safeNumber(bars[i]?.low,   NaN);
    const pc = safeNumber(bars[i - 1]?.close, NaN);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (tr.length < period) return null;

  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) atr = ((atr * (period - 1)) + tr[i]) / period;
  return Number.isFinite(atr) ? atr : null;
}

function extractSignificantPivots(bars, pivotWindow, minSwing) {
  const pivots = [];
  const k = Math.max(2, Number(pivotWindow) || 3);

  for (let i = k; i < bars.length - k; i += 1) {
    const ch = safeNumber(bars[i]?.high, NaN);
    const cl = safeNumber(bars[i]?.low,  NaN);
    if (!Number.isFinite(ch) || !Number.isFinite(cl)) continue;

    let leftMax  = -Infinity;
    let rightMax = -Infinity;
    let leftMin  = +Infinity;
    let rightMin = +Infinity;

    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      const h = safeNumber(bars[j]?.high, NaN);
      const l = safeNumber(bars[j]?.low,  NaN);
      if (Number.isFinite(h)) {
        if (j < i) leftMax  = Math.max(leftMax,  h);
        else        rightMax = Math.max(rightMax, h);
      }
      if (Number.isFinite(l)) {
        if (j < i) leftMin  = Math.min(leftMin,  l);
        else        rightMin = Math.min(rightMin, l);
      }
    }

    const highProm = ch - Math.max(leftMax, rightMax);
    const lowProm  = Math.min(leftMin, rightMin) - cl;

    if (Number.isFinite(highProm) && highProm >= minSwing) {
      pivots.push({ type: 'pivotHigh', price: ch, index: i, timestamp: bars[i].timestamp, prom: highProm });
    }
    if (Number.isFinite(lowProm) && lowProm >= minSwing) {
      pivots.push({ type: 'pivotLow',  price: cl, index: i, timestamp: bars[i].timestamp, prom: lowProm  });
    }
  }

  return pivots;
}

function clusterByBins(pivots, clusterStep) {
  const bins = new Map();
  for (const p of pivots) {
    const binId = Math.round(p.price / clusterStep);
    const hit   = bins.get(binId);
    if (!hit) bins.set(binId, { binId, items: [p] });
    else hit.items.push(p);
  }

  const clusters = [];
  for (const c of bins.values()) {
    const prices = c.items.map(x => x.price).sort((a, b) => a - b);
    const mid    = prices[Math.floor(prices.length / 2)];
    clusters.push({ price: mid, items: c.items });
  }
  clusters.sort((a, b) => a.price - b.price);

  const merged = [];
  for (const c of clusters) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.price - c.price) <= clusterStep) {
      last.items.push(...c.items);
      const prices = last.items.map(x => x.price).sort((a, b) => a - b);
      last.price   = prices[Math.floor(prices.length / 2)];
    } else {
      merged.push({ ...c });
    }
  }

  return merged;
}

function scoreCluster(cluster, barsCount) {
  const touches  = cluster.items.length;
  const avgIndex = cluster.items.reduce((sum, item) => sum + item.index, 0) / Math.max(1, touches);
  const recency  = barsCount > 1 ? avgIndex / (barsCount - 1) : 0;
  const promAvg  = cluster.items.reduce((sum, item) => sum + safeNumber(item.prom, 0), 0) / Math.max(1, touches);
  const score    = touches * (1 + 0.5 * recency) * (1 + 0.3 * (promAvg > 0 ? 1 : 0));
  return { score, touches, recency, promAvg };
}

function getFormationIndex(cluster) {
  if (!cluster?.items?.length) return 0;
  return Math.max(...cluster.items.map(p => Number(p.index) || 0));
}

function calculateTolerance(lastClose, clusterStep, atr, settings) {
  const toleranceMode = ['auto', 'atr', 'percent'].includes(settings?.toleranceMode)
    ? settings.toleranceMode
    : 'auto';
  const atrFactor = Number(settings?.toleranceAtrFactor);
  const percent   = Number(settings?.tolerancePercent);

  const atrTolerance     = Number.isFinite(atr) ? Math.max(0, atr * (Number.isFinite(atrFactor) ? atrFactor : 0.05)) : 0;
  const percentTolerance = Number.isFinite(lastClose) ? Math.max(0, lastClose * (Number.isFinite(percent) ? percent : 0.0002)) : 0;
  const clusterTolerance = Number.isFinite(clusterStep) ? Math.max(0, clusterStep * 0.25) : 0;

  if (toleranceMode === 'atr')     return atrTolerance;
  if (toleranceMode === 'percent') return percentTolerance;
  return Math.max(clusterTolerance, atrTolerance, percentTolerance);
}

function isVirginLevel(levelPrice, side, bars, fromIndex, tolerance, policy) {
  if (policy === undefined) policy = 'no-touch';
  const startIndex = Math.max(0, Number(fromIndex) || 0);
  const mode = ['no-touch', 'no-body-cross', 'no-close-cross'].includes(policy)
    ? policy
    : 'no-touch';

  for (let i = startIndex; i < bars.length; i += 1) {
    const b     = bars[i];
    const high  = safeNumber(b?.high,  NaN);
    const low   = safeNumber(b?.low,   NaN);
    const open  = safeNumber(b?.open,  NaN);
    const close = safeNumber(b?.close, NaN);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(open) || !Number.isFinite(close)) continue;

    if (mode === 'no-touch') {
      if (side === 'resistance') { if (high  >= levelPrice - tolerance) return false; }
      else                       { if (low   <= levelPrice + tolerance) return false; }
      continue;
    }
    if (mode === 'no-body-cross') {
      const bodyHigh = Math.max(open, close);
      const bodyLow  = Math.min(open, close);
      if (side === 'resistance') { if (bodyHigh >= levelPrice - tolerance) return false; }
      else                       { if (bodyLow  <= levelPrice + tolerance) return false; }
      continue;
    }
    // no-close-cross
    if (side === 'resistance') { if (close >= levelPrice - tolerance) return false; }
    else                       { if (close <= levelPrice + tolerance) return false; }
  }

  return true;
}

const AUTO_LEVELS_DEFAULTS = {
  lookbackBars:       600,
  minBars:            250,
  pivotWindow:        3,
  maxLevels:          10,
  clusterMode:        'auto',
  atrFactor:          0.6,
  percentStep:        0.0018,
  swingAtrFactor:     0.6,
  swingPercent:       0.002,
  maxSupport:         5,
  maxResistance:      5,
  virginOnly:         true,
  virginPolicy:       'no-touch',
  toleranceMode:      'auto',
  toleranceAtrFactor: 0.05,
  tolerancePercent:   0.0002,
  virginFallback:     true,
};

/**
 * 1-to-1 port of frontend calculateAutoLevels().
 *
 * Bars must have: { timestamp, open, high, low, close }
 * (backend fetcher maps Binance k[0] → timestamp)
 *
 * @param {object[]} rawBars
 * @param {object}   options
 * @returns {{ levels: object[], clusterStep: number|null, atr: number|null, reason: string }}
 */
function calculateAutoLevels(rawBars, options) {
  const s = { ...AUTO_LEVELS_DEFAULTS, ...(options || {}) };

  const DBG = '[autolevels]';

  if (!Array.isArray(rawBars) || !rawBars.length) {
    console.warn(DBG, 'STOP: NO_BARS');
    return { levels: [], clusterStep: null, atr: null, reason: 'NO_BARS' };
  }

  const lookbackBars    = Math.max(200, Math.min(2000, Number(s.lookbackBars) || 600));
  const bars            = rawBars.slice(-lookbackBars);
  const minBarsRequired = Math.max(200, Number(s.minBars) || 250);

  console.log(DBG, `Step 1: rawBars=${rawBars.length} lookback=${lookbackBars} bars=${bars.length} minRequired=${minBarsRequired} virginOnly=${s.virginOnly}`);

  if (bars.length < minBarsRequired) {
    console.warn(DBG, `STOP: NOT_ENOUGH_BARS ${bars.length} < ${minBarsRequired}`);
    return { levels: [], clusterStep: null, atr: null, reason: 'NOT_ENOUGH_BARS' };
  }

  const lastBar   = bars[bars.length - 1];
  const lastClose = safeNumber(lastBar?.close, NaN);
  if (!Number.isFinite(lastClose) || lastClose <= 0) {
    console.warn(DBG, 'STOP: INVALID_PRICE', lastClose);
    return { levels: [], clusterStep: null, atr: null, reason: 'INVALID_PRICE' };
  }

  const atr         = calculateAtr(bars, 14);
  const atrStep     = Number.isFinite(atr) ? atr * (Number(s.atrFactor) || 0.6) : null;
  const percentStep = lastClose * (Number(s.percentStep) || 0.0018);

  let clusterStep;
  if (s.clusterMode === 'atr' && Number.isFinite(atrStep))   clusterStep = atrStep;
  else if (s.clusterMode === 'percent')                       clusterStep = percentStep;
  else clusterStep = Math.max(Number.isFinite(atrStep) ? atrStep : 0, percentStep);

  console.log(DBG, `Step 2: lastClose=${lastClose.toFixed(4)} atr=${atr?.toFixed(4)} clusterStep=${clusterStep?.toFixed(4)} percentStep=${percentStep?.toFixed(4)}`);

  if (!Number.isFinite(clusterStep) || clusterStep <= 0) {
    console.warn(DBG, 'STOP: INVALID_CLUSTER_STEP', clusterStep);
    return { levels: [], clusterStep: null, atr, reason: 'INVALID_CLUSTER_STEP' };
  }

  const minSwing = Math.max(
    Number.isFinite(atr) ? atr * (Number(s.swingAtrFactor) || 0.6) : 0,
    lastClose * (Number(s.swingPercent) || 0.002),
  );

  const pivots = extractSignificantPivots(bars, s.pivotWindow, minSwing);
  console.log(DBG, `Step 3: minSwing=${minSwing?.toFixed(4)} pivots=${pivots.length}`);

  if (!pivots.length) {
    console.warn(DBG, 'STOP: NO_PIVOTS');
    return { levels: [], clusterStep, atr, reason: 'NO_PIVOTS' };
  }

  const clusters = clusterByBins(pivots, clusterStep);
  console.log(DBG, `Step 4: clusters=${clusters.length}`);

  if (!clusters.length) {
    console.warn(DBG, 'STOP: NO_CLUSTERS');
    return { levels: [], clusterStep, atr, reason: 'NO_CLUSTERS' };
  }

  const scored = clusters
    .map(cluster => ({ ...cluster, ...scoreCluster(cluster, bars.length) }))
    .sort((a, b) => b.score - a.score);

  const virginOnly    = Boolean(s.virginOnly);
  const virginPolicy  = ['no-touch', 'no-body-cross', 'no-close-cross'].includes(s.virginPolicy) ? s.virginPolicy : 'no-touch';
  const virginFallback = s.virginFallback !== false;
  const tolerance     = calculateTolerance(lastClose, clusterStep, atr, s);

  const maxSupport    = Math.max(1, Math.min(10, Number(s.maxSupport)    || 5));
  const maxResistance = Math.max(1, Math.min(10, Number(s.maxResistance) || 5));
  const maxLevelsCap  = Math.max(3, Math.min(20, Number(s.maxLevels)     || 10));
  const targetCount   = Math.min(maxLevelsCap, maxSupport + maxResistance);

  console.log(DBG, `Step 5: virginOnly=${virginOnly} policy=${virginPolicy} tolerance=${tolerance?.toFixed(4)} targetCount=${targetCount}`);

  const policyQueue = (() => {
    if (!virginOnly) return ['no-touch'];
    if (!virginFallback) return [virginPolicy];
    const queue = [virginPolicy];
    if (virginPolicy === 'no-touch') queue.push('no-body-cross', 'no-close-cross');
    else if (virginPolicy === 'no-body-cross') queue.push('no-close-cross');
    return queue;
  })();

  const filteredByVirgin = [];
  for (const policy of policyQueue) {
    for (const cluster of scored) {
      const formationIndex = getFormationIndex(cluster);
      const formationTimestamp = Number.isFinite(Number(bars[formationIndex]?.timestamp))
        ? Number(bars[formationIndex].timestamp)
        : Math.max(...cluster.items.map(p => p.timestamp != null ? Number(p.timestamp) : 0));
      const side      = cluster.price <= lastClose ? 'support' : 'resistance';
      const fromIndex = Math.min(bars.length - 1, Math.max(0, formationIndex + 1));
      const virgin    = !virginOnly || isVirginLevel(cluster.price, side, bars, fromIndex, tolerance, policy);
      if (!virgin) continue;

      const duplicate = filteredByVirgin.some(
        x => x.side === side && Math.abs(x.price - cluster.price) < clusterStep * 0.5,
      );
      if (duplicate) continue;

      filteredByVirgin.push({ ...cluster, side, formationIndex, formationTimestamp, virgin: true, virginPolicyUsed: policy });
      if (filteredByVirgin.length >= targetCount) break;
    }
    if (filteredByVirgin.length >= targetCount) break;
  }

  console.log(DBG, `Step 6: filteredByVirgin=${filteredByVirgin.length}`);

  if (!filteredByVirgin.length) {
    console.warn(DBG, 'STOP:', virginOnly ? 'NO_VIRGIN_LEVELS' : 'NO_FILTERED_LEVELS');
    return { levels: [], clusterStep, atr, tolerance, reason: virginOnly ? 'NO_VIRGIN_LEVELS' : 'NO_FILTERED_LEVELS' };
  }

  const support    = [];
  const resistance = [];

  for (const c of filteredByVirgin) {
    const target = c.side === 'support' ? support : resistance;
    const cap    = c.side === 'support' ? maxSupport : maxResistance;
    if (target.length >= cap) continue;
    const tooClose = target.some(x => Math.abs(x.price - c.price) < clusterStep);
    if (tooClose) continue;
    target.push(c);
    if (support.length >= maxSupport && resistance.length >= maxResistance) break;
  }

  const picked = [...support, ...resistance]
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevelsCap);

  const levels = picked.map((c, idx) => {
    const firstTouchIndex     = Math.min(...c.items.map(p => p.index));
    const firstTouchTimestamp = Math.min(...c.items.map(p => p.timestamp != null ? Number(p.timestamp) : Number.MAX_SAFE_INTEGER));
    return {
      index:              idx,
      price:              c.price,
      type:               c.side === 'support' ? 'low' : 'high',
      side:               c.side,
      touches:            c.touches,
      score:              c.score,
      virgin:             true,
      virginPolicyUsed:   c.virginPolicyUsed,
      firstTouchIndex,
      firstTouchTimestamp,
      formationIndex:     c.formationIndex,
      formationTimestamp: c.formationTimestamp,
      drawFromTimestamp:  Number.isFinite(c.formationTimestamp) && c.formationTimestamp > 0
        ? c.formationTimestamp
        : Number(lastBar.timestamp),
    };
  });

  console.log(DBG, `✅ Done: ${levels.length} levels`);
  return { levels, clusterStep, atr, tolerance, reason: levels.length ? 'OK' : 'EMPTY' };
}

module.exports = { calculateAutoLevels, AUTO_LEVELS_DEFAULTS };
