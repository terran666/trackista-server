'use strict';

/**
 * doubleExtremeStrategy.js — Double Top / Double Bottom pattern detection.
 *
 * Looks for structural High-Low-High or Low-High-Low sequences in
 * trackedExtremes for a single symbol+marketType+tf slice.
 * Current price is NOT used for detection — only for breakout/invalidation checks.
 */

const STRATEGY_KEY   = 'doubleExtreme';
const DOUBLE_TOP     = 'DOUBLE_TOP';
const DOUBLE_BOTTOM  = 'DOUBLE_BOTTOM';
const DIR_SHORT      = 'SHORT_BREAKDOWN';
const DIR_LONG       = 'LONG_BREAKOUT';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveExtremePrice(ext) {
  const direct = safeNumOrNull(ext?.price);
  if (direct != null && direct > 0) return direct;

  const points = Array.isArray(ext?.points) ? ext.points : [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i] || {};
    const v = safeNumOrNull(p.value ?? p.price);
    if (v != null && v > 0) return v;
  }
  return null;
}

function normalizeStrength(ext) {
  const strength = safeNumOrNull(ext?.strength);

  if (strength != null && strength > 0) {
    return strength;
  }

  if (ext?.source === 'extremes' || ext?.source === 'vertical-extremes') {
    return 1;
  }

  return 0;
}

function normalizeTouches(ext) {
  const touches = safeNumOrNull(ext?.touches);

  if (touches != null && touches > 0) {
    return touches;
  }

  if (ext?.source === 'extremes' || ext?.source === 'vertical-extremes') {
    return 1;
  }

  return 0;
}

function pctDiff(a, b) {
  if (!b) return Infinity;
  return Math.abs(a - b) / b * 100;
}

function avg(a, b) {
  return (a + b) / 2;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Build a scored candidate for a Double Top pattern.
 * @param {object} hiA  extreme record (High A)
 * @param {object} loB  extreme record (Low B — neckline)
 * @param {object} hiC  extreme record (High C)
 * @param {number} currentPrice
 * @param {object} cfg  doubleExtreme config
 * @param {string} symbol
 * @param {string} marketType
 * @param {string} tf
 * @returns {{ candidate: object, rejectReason: string|null }}
 */
function buildDoubleTop(hiA, loB, hiC, currentPrice, cfg, symbol, marketType, tf) {
  const priceA   = resolveExtremePrice(hiA);
  const priceB   = resolveExtremePrice(loB);
  const priceC   = resolveExtremePrice(hiC);

  if (!(priceA > 0) || !(priceB > 0) || !(priceC > 0)) {
    return { candidate: null, rejectReason: 'INVALID_EXTREME_PRICE' };
  }

  // 1. Tops close enough?
  const topDiffPct = pctDiff(priceA, priceC);
  if (topDiffPct > cfg.topBottomTolerancePct) {
    return { candidate: null, rejectReason: 'TOPS_TOO_FAR_APART' };
  }

  // 2. Minimum time / bars between A and C
  const tsA = safeNum(hiA.points?.[0]?.timestamp ?? hiA.timestamp);
  const tsB = safeNum(loB.points?.[0]?.timestamp ?? loB.timestamp);
  const tsC = safeNum(hiC.points?.[0]?.timestamp ?? hiC.timestamp);

  if (cfg.minTimeBetweenExtremesMs != null && (tsC - tsA) < cfg.minTimeBetweenExtremesMs) {
    return { candidate: null, rejectReason: 'NOT_ENOUGH_TIME_BETWEEN_EXTREMES' };
  }
  if (cfg.minBarsBetweenExtremes > 0) {
    const barMs = _tfToMs(tf);
    if (barMs > 0 && (tsC - tsA) < cfg.minBarsBetweenExtremes * barMs) {
      return { candidate: null, rejectReason: 'NOT_ENOUGH_TIME_BETWEEN_EXTREMES' };
    }
  }

  // 3. Neckline (Low B) must be sufficiently lower than the tops
  const resistanceLevel = avg(priceA, priceC);
  const necklineLevel   = priceB;
  const moveToNeckPct   = ((resistanceLevel - necklineLevel) / resistanceLevel) * 100;
  if (moveToNeckPct < cfg.minMoveToNecklinePct) {
    return { candidate: null, rejectReason: 'NECKLINE_MOVE_TOO_SMALL' };
  }

  // 4. After High C — resistance not yet broken upward
  const breakoutBuffer     = resistanceLevel * (cfg.breakoutBufferPct / 100);
  const invalidationLevel  = resistanceLevel + breakoutBuffer;
  if (Number.isFinite(currentPrice) && currentPrice > invalidationLevel) {
    return { candidate: null, rejectReason: 'PATTERN_INVALIDATED' };
  }

  // 5. Neckline not yet broken downward (pattern still active)
  const breakoutLevel = necklineLevel;
  const downBuffer    = necklineLevel * (cfg.breakoutBufferPct / 100);
  if (Number.isFinite(currentPrice) && currentPrice < necklineLevel - downBuffer) {
    return { candidate: null, rejectReason: 'PATTERN_ALREADY_BROKEN' };
  }

  // 6. Score
  const score = _scorePattern({
    topBottomDiffPct:   topDiffPct,
    tolerancePct:       cfg.topBottomTolerancePct,
    moveToNecklinePct:  moveToNeckPct,
    minMovePct:         cfg.minMoveToNecklinePct,
    timeDistanceMs:     tsC - tsA,
    minTimeMs:          (_getMinBarsBetween(cfg, tf) || 0) * _tfToMs(tf),
    strengthA:          normalizeStrength(hiA),
    strengthC:          normalizeStrength(hiC),
    touchesA:           normalizeTouches(hiA),
    touchesC:           normalizeTouches(hiC),
  });

  if (score < cfg.minPatternQuality) {
    return { candidate: null, rejectReason: 'SCORE_TOO_LOW' };
  }

  const fingerprint = `${symbol}:${marketType}:${tf}:${DOUBLE_TOP}:${tsA}:${tsB}:${tsC}`;
  const symmetryScore = Math.max(0, 100 - topDiffPct * 20);

  return {
    candidate: {
      fingerprint,
      symbol,
      marketType,
      tf,
      patternType:  DOUBLE_TOP,
      strategy:     STRATEGY_KEY,
      direction:    DIR_SHORT,
      status:       'ACTIVE',
      levels: {
        resistanceLevel,
        supportLevel:     null,
        necklineLevel,
        breakoutLevel,
        invalidationLevel,
      },
      points: {
        firstExtreme:  { timestamp: tsA, price: priceA, side: hiA.side, id: hiA.id },
        middleExtreme: { timestamp: tsB, price: priceB, side: loB.side, id: loB.id },
        secondExtreme: { timestamp: tsC, price: priceC, side: hiC.side, id: hiC.id },
      },
      metrics: {
        priceDiffPct:       topDiffPct,
        timeDistanceMs:     tsC - tsA,
        timeDistanceBars:   _tfToMs(tf) > 0 ? Math.round((tsC - tsA) / _tfToMs(tf)) : null,
        moveToNecklinePct:  moveToNeckPct,
        symmetryScore:      Math.round(symmetryScore),
        patternQuality:     Math.round(score),
      },
      score:        Math.round(score),
    },
    rejectReason: null,
  };
}

/**
 * Build a scored candidate for a Double Bottom pattern.
 */
function buildDoubleBottom(loA, hiB, loC, currentPrice, cfg, symbol, marketType, tf) {
  const priceA   = resolveExtremePrice(loA);
  const priceB   = resolveExtremePrice(hiB);
  const priceC   = resolveExtremePrice(loC);

  if (!(priceA > 0) || !(priceB > 0) || !(priceC > 0)) {
    return { candidate: null, rejectReason: 'INVALID_EXTREME_PRICE' };
  }

  // 1. Bottoms close enough?
  const bottomDiffPct = pctDiff(priceA, priceC);
  if (bottomDiffPct > cfg.topBottomTolerancePct) {
    return { candidate: null, rejectReason: 'BOTTOMS_TOO_FAR_APART' };
  }

  // 2. Minimum time between A and C
  const tsA = safeNum(loA.points?.[0]?.timestamp ?? loA.timestamp);
  const tsB = safeNum(hiB.points?.[0]?.timestamp ?? hiB.timestamp);
  const tsC = safeNum(loC.points?.[0]?.timestamp ?? loC.timestamp);

  if (cfg.minTimeBetweenExtremesMs != null && (tsC - tsA) < cfg.minTimeBetweenExtremesMs) {
    return { candidate: null, rejectReason: 'NOT_ENOUGH_TIME_BETWEEN_EXTREMES' };
  }
  if (cfg.minBarsBetweenExtremes > 0) {
    const barMs = _tfToMs(tf);
    if (barMs > 0 && (tsC - tsA) < cfg.minBarsBetweenExtremes * barMs) {
      return { candidate: null, rejectReason: 'NOT_ENOUGH_TIME_BETWEEN_EXTREMES' };
    }
  }

  // 3. Neckline (High B) must be sufficiently above the bottoms
  const supportLevel   = avg(priceA, priceC);
  const necklineLevel  = priceB;
  const moveToNeckPct  = ((necklineLevel - supportLevel) / necklineLevel) * 100;
  if (moveToNeckPct < cfg.minMoveToNecklinePct) {
    return { candidate: null, rejectReason: 'NECKLINE_MOVE_TOO_SMALL' };
  }

  // 4. After Low C — support not yet broken downward
  const invalidationBuffer  = supportLevel * (cfg.invalidationBufferPct / 100);
  const invalidationLevel   = supportLevel - invalidationBuffer;
  if (Number.isFinite(currentPrice) && currentPrice < invalidationLevel) {
    return { candidate: null, rejectReason: 'PATTERN_INVALIDATED' };
  }

  // 5. Neckline not yet broken upward (pattern still active)
  const breakoutLevel = necklineLevel;
  const upBuffer      = necklineLevel * (cfg.breakoutBufferPct / 100);
  if (Number.isFinite(currentPrice) && currentPrice > necklineLevel + upBuffer) {
    return { candidate: null, rejectReason: 'PATTERN_ALREADY_BROKEN' };
  }

  // 6. Score
  const score = _scorePattern({
    topBottomDiffPct:   bottomDiffPct,
    tolerancePct:       cfg.topBottomTolerancePct,
    moveToNecklinePct:  moveToNeckPct,
    minMovePct:         cfg.minMoveToNecklinePct,
    timeDistanceMs:     tsC - tsA,
    minTimeMs:          (_getMinBarsBetween(cfg, tf) || 0) * _tfToMs(tf),
    strengthA:          normalizeStrength(loA),
    strengthC:          normalizeStrength(loC),
    touchesA:           normalizeTouches(loA),
    touchesC:           normalizeTouches(loC),
  });

  if (score < cfg.minPatternQuality) {
    return { candidate: null, rejectReason: 'SCORE_TOO_LOW' };
  }

  const fingerprint = `${symbol}:${marketType}:${tf}:${DOUBLE_BOTTOM}:${tsA}:${tsB}:${tsC}`;
  const symmetryScore = Math.max(0, 100 - bottomDiffPct * 20);

  return {
    candidate: {
      fingerprint,
      symbol,
      marketType,
      tf,
      patternType:  DOUBLE_BOTTOM,
      strategy:     STRATEGY_KEY,
      direction:    DIR_LONG,
      status:       'ACTIVE',
      levels: {
        resistanceLevel:  null,
        supportLevel,
        necklineLevel,
        breakoutLevel,
        invalidationLevel,
      },
      points: {
        firstExtreme:  { timestamp: tsA, price: priceA, side: loA.side, id: loA.id },
        middleExtreme: { timestamp: tsB, price: priceB, side: hiB.side, id: hiB.id },
        secondExtreme: { timestamp: tsC, price: priceC, side: loC.side, id: loC.id },
      },
      metrics: {
        priceDiffPct:       bottomDiffPct,
        timeDistanceMs:     tsC - tsA,
        timeDistanceBars:   _tfToMs(tf) > 0 ? Math.round((tsC - tsA) / _tfToMs(tf)) : null,
        moveToNecklinePct:  moveToNeckPct,
        symmetryScore:      Math.round(symmetryScore),
        patternQuality:     Math.round(score),
      },
      score: Math.round(score),
    },
    rejectReason: null,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function _scorePattern({ topBottomDiffPct, tolerancePct, moveToNecklinePct, minMovePct,
  timeDistanceMs, minTimeMs, strengthA, strengthC, touchesA, touchesC }) {

  // priceSimilarityScore — 0..1, linear: 0 diff = 1, tolerancePct diff = 0
  const priceSim = clamp01(1 - topBottomDiffPct / Math.max(tolerancePct, 0.01));

  // moveToNecklineScore — 0..1: anything > 2× minMove = 1
  const moveSim = clamp01((moveToNecklinePct - minMovePct) / Math.max(minMovePct, 0.01));

  // timeDistanceScore — 0..1: minTimeMs = 0, 4× = 1
  const tMin = Math.max(minTimeMs, 1);
  const timeSim = clamp01(Math.log(Math.max(timeDistanceMs, tMin) / tMin) / Math.log(4));

  // extremeStrengthScore — 0..1, from avg strength/touches
  const avgStrength = (strengthA + strengthC) / 2;
  const avgTouches  = (touchesA  + touchesC)  / 2;
  const strengthSim = clamp01((Math.min(avgStrength, 5) / 5) * 0.6 + (Math.min(avgTouches, 4) / 4) * 0.4);

  const raw = priceSim * 0.35 + moveSim * 0.30 + timeSim * 0.20 + strengthSim * 0.15;
  return Math.round(raw * 100);
}

// ─── tf → milliseconds ───────────────────────────────────────────────────────

const TF_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

function _getMinBarsBetween(cfg, tf) {
  return cfg.minBarsBetweenExtremesByTf?.[tf] ?? cfg.minBarsBetweenExtremes ?? 12;
}

function _getMaxPatternAgeHours(cfg, tf) {
  return cfg.maxPatternAgeHoursByTf?.[tf] ?? cfg.maxPatternAgeHours ?? 120;
}

function _tfToMs(tf) {
  return TF_MS[tf] ?? 0;
}

// ─── Extreme classification ──────────────────────────────────────────────────

/**
 * Classify an extreme record as 'high' or 'low' based on its side field.
 * Resistance extremes are "highs", support extremes are "lows".
 */
function _extremeClass(ext) {
  const s = (ext.side || '').toLowerCase();
  if (s === 'resistance' || s === 'high') return 'high';
  if (s === 'support' || s === 'low')    return 'low';
  // Fallback: compare price to points
  if (ext.points && ext.points.length >= 2) {
    const first = ext.points[0].value ?? ext.points[0].price ?? 0;
    const last  = ext.points[ext.points.length - 1].value ?? ext.points[ext.points.length - 1].price ?? 0;
    return last > first ? 'high' : 'low';
  }
  return null;
}

// ─── Main evaluate ───────────────────────────────────────────────────────────

/**
 * Evaluate double extreme patterns for one symbol+marketType+tf slice.
 *
 * V1 rules (per TZ):
 *   - max 1 DOUBLE_TOP + 1 DOUBLE_BOTTOM per symbol+tf (best score wins)
 *   - barsBetween > maxBarsBetweenExtremes → PATTERN_TOO_STRETCHED (or OLD_LEVEL_RETEST)
 *   - price must confirm pullback after second top/bottom before creation
 *
 * @param {object}   params
 * @param {string}   params.symbol
 * @param {string}   params.marketType
 * @param {string}   params.tf
 * @param {object[]} params.extremes  — raw records from trackedExtremesStore
 * @param {number}   params.currentPrice
 * @param {object}   params.cfg       — doubleExtreme config section
 * @returns {{ candidates: object[], debugLog: object[] }}
 */
function evaluate({ symbol, marketType, tf, extremes, currentPrice, cfg }) {
  if (!cfg.enabled) return { candidates: [], debugLog: [] };

  const now               = Date.now();
  const maxAgeHours       = _getMaxPatternAgeHours(cfg, tf);
  const maxAgeMs          = maxAgeHours * 3_600_000;
  const barMs             = _tfToMs(tf);
  const minBarsBetween    = _getMinBarsBetween(cfg, tf);
  const maxBarsBetween    = cfg.maxBarsBetweenExtremes ?? 300;
  const pullbackPct       = cfg.pullbackConfirmPct ?? 0.8;
  const stats = {
    tf,
    extremesTotal: Array.isArray(extremes) ? extremes.length : 0,
    validPrice: 0,
    rejectedPrice: 0,
    rejectedQuality: 0,
    filteredByBarsDistance: 0,
    patternsCreated: 0,
  };

  // 1. Filter + classify extremes
  const valid = [];
  for (const ext of extremes) {
    const resolvedPrice = resolveExtremePrice(ext);
    const hasValidPrice = resolvedPrice != null && Number.isFinite(resolvedPrice) && resolvedPrice > 0;
    if (!hasValidPrice) {
      stats.rejectedPrice++;
      continue;
    }
    stats.validPrice++;

    const nStrength = normalizeStrength(ext);
    const nTouches = normalizeTouches(ext);
    const hasAnyQuality =
      nStrength >= (cfg.minExtremeStrength ?? 1) ||
      nTouches >= (cfg.minTouches ?? 1) ||
      ext.source === 'extremes' ||
      ext.source === 'vertical-extremes';
    if (!hasAnyQuality) {
      stats.rejectedQuality++;
      continue;
    }

    const cls = _extremeClass(ext);
    if (!cls) continue;
    const ts = safeNum(ext.points?.[0]?.timestamp ?? ext.timestamp);
    if (!ts) continue;
    if (now - ts > maxAgeMs) continue;
    valid.push({ ...ext, _cls: cls, _ts: ts, _price: resolvedPrice, _strength: nStrength, _touches: nTouches });
  }

  // 2. Sort by timestamp ASC
  valid.sort((a, b) => a._ts - b._ts);

  const debugLog = [];
  const allDT   = [];   // all accepted DOUBLE_TOP candidates (pre-dedup)
  const allDB   = [];   // all accepted DOUBLE_BOTTOM candidates (pre-dedup)
  const seen    = new Set(); // same-extremes fingerprint dedup within this scan

  // ─── helper: barsBetween + age-based reject reason ─────────────────────────
  function stretchRejectReason(tsA, tsC) {
    if (barMs <= 0) return null;
    const bars = Math.round((tsC - tsA) / barMs);
    if (bars < minBarsBetween) return 'tooClose';
    if (bars <= maxBarsBetween) return null;
    // First extreme is "old" (> 60% of the window) → looks like a stale retest
    return (now - tsA) > maxAgeMs * 0.6 ? 'retest' : 'stretched';
  }

  // ─── helper: pullback/bounce confirmation against current price ────────────
  // Returns reject reason string or null if confirmation passes.
  function confirmationReject(secondPrice, patternType) {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || secondPrice <= 0) return null;
    if (patternType === DOUBLE_TOP) {
      const pullback = (secondPrice - currentPrice) / secondPrice * 100;
      return pullback < pullbackPct ? 'NO_CONFIRMATION_AFTER_SECOND_TOP' : null;
    }
    // DOUBLE_BOTTOM
    const bounce = (currentPrice - secondPrice) / secondPrice * 100;
    return bounce < pullbackPct ? 'NO_CONFIRMATION_AFTER_SECOND_BOTTOM' : null;
  }

  // 3. Find High-Low-High (Double Top)
  for (let a = 0; a < valid.length - 2; a++) {
    if (valid[a]._cls !== 'high') continue;
    for (let b = a + 1; b < valid.length - 1; b++) {
      if (valid[b]._cls !== 'low') continue;
      for (let c = b + 1; c < valid.length; c++) {
        if (valid[c]._cls !== 'high') continue;

        const tsA = valid[a]._ts, tsB = valid[b]._ts, tsC = valid[c]._ts;
        const entry = {
          patternType: DOUBLE_TOP,
          points: [tsA, tsB, tsC],
          prices: [valid[a]._price, valid[b]._price, valid[c]._price],
        };

        // Stretch / old-retest gate
        const stretch = stretchRejectReason(tsA, tsC);
        if (stretch) {
          const reason =
            stretch === 'tooClose'
              ? 'TOO_CLOSE'
              : (stretch === 'retest' ? 'OLD_LEVEL_RETEST_NOT_DOUBLE_TOP' : 'PATTERN_TOO_STRETCHED');
          const bars = barMs > 0 ? Math.round((tsC - tsA) / barMs) : null;
          debugLog.push({ ...entry, accepted: false, rejectReason: reason, barsBetween: bars });
          stats.filteredByBarsDistance++;
          continue;
        }

        // Pullback confirmation after second top
        const confReject = confirmationReject(valid[c]._price, DOUBLE_TOP);
        if (confReject) {
          const pullback = Number.isFinite(currentPrice) && valid[c]._price > 0
            ? +((valid[c]._price - currentPrice) / valid[c]._price * 100).toFixed(3) : null;
          debugLog.push({ ...entry, accepted: false, rejectReason: confReject, pullbackPct: pullback });
          continue;
        }

        const { candidate, rejectReason } = buildDoubleTop(
          valid[a], valid[b], valid[c], currentPrice, cfg, symbol, marketType, tf,
        );
        if (rejectReason) {
          debugLog.push({ ...entry, accepted: false, rejectReason });
          continue;
        }
        if (seen.has(candidate.fingerprint)) {
          debugLog.push({ ...entry, accepted: false, rejectReason: 'SAME_EXTREMES_DUPLICATE' });
          continue;
        }
        seen.add(candidate.fingerprint);
        debugLog.push({ ...entry, accepted: true, score: candidate.score });
        allDT.push(candidate);
      }
    }
  }

  // 4. Find Low-High-Low (Double Bottom)
  for (let a = 0; a < valid.length - 2; a++) {
    if (valid[a]._cls !== 'low') continue;
    for (let b = a + 1; b < valid.length - 1; b++) {
      if (valid[b]._cls !== 'high') continue;
      for (let c = b + 1; c < valid.length; c++) {
        if (valid[c]._cls !== 'low') continue;

        const tsA = valid[a]._ts, tsB = valid[b]._ts, tsC = valid[c]._ts;
        const entry = {
          patternType: DOUBLE_BOTTOM,
          points: [tsA, tsB, tsC],
          prices: [valid[a]._price, valid[b]._price, valid[c]._price],
        };

        // Stretch / old-retest gate
        const stretch = stretchRejectReason(tsA, tsC);
        if (stretch) {
          const reason =
            stretch === 'tooClose'
              ? 'TOO_CLOSE'
              : (stretch === 'retest' ? 'OLD_LEVEL_RETEST_NOT_DOUBLE_BOTTOM' : 'PATTERN_TOO_STRETCHED');
          const bars = barMs > 0 ? Math.round((tsC - tsA) / barMs) : null;
          debugLog.push({ ...entry, accepted: false, rejectReason: reason, barsBetween: bars });
          stats.filteredByBarsDistance++;
          continue;
        }

        // Bounce confirmation after second bottom
        const confReject = confirmationReject(valid[c]._price, DOUBLE_BOTTOM);
        if (confReject) {
          const bounce = Number.isFinite(currentPrice) && valid[c]._price > 0
            ? +((currentPrice - valid[c]._price) / valid[c]._price * 100).toFixed(3) : null;
          debugLog.push({ ...entry, accepted: false, rejectReason: confReject, bouncePct: bounce });
          continue;
        }

        const { candidate, rejectReason } = buildDoubleBottom(
          valid[a], valid[b], valid[c], currentPrice, cfg, symbol, marketType, tf,
        );
        if (rejectReason) {
          debugLog.push({ ...entry, accepted: false, rejectReason });
          continue;
        }
        if (seen.has(candidate.fingerprint)) {
          debugLog.push({ ...entry, accepted: false, rejectReason: 'SAME_EXTREMES_DUPLICATE' });
          continue;
        }
        seen.add(candidate.fingerprint);
        debugLog.push({ ...entry, accepted: true, score: candidate.score });
        allDB.push(candidate);
      }
    }
  }

  // 5. Dedup: keep 1 DT + 1 DB (best score). Lower-score ones are logged.
  const candidates = [];
  if (allDT.length > 0) {
    allDT.sort((a, b) => b.score - a.score);
    candidates.push(allDT[0]);
    for (const d of allDT.slice(1)) {
      debugLog.push({
        patternType: DOUBLE_TOP, fingerprint: d.fingerprint,
        score: d.score, accepted: false, rejectReason: 'LOWER_SCORE_DUPLICATE',
        keptScore: allDT[0].score,
      });
    }
  }
  if (allDB.length > 0) {
    allDB.sort((a, b) => b.score - a.score);
    candidates.push(allDB[0]);
    for (const d of allDB.slice(1)) {
      debugLog.push({
        patternType: DOUBLE_BOTTOM, fingerprint: d.fingerprint,
        score: d.score, accepted: false, rejectReason: 'LOWER_SCORE_DUPLICATE',
        keptScore: allDB[0].score,
      });
    }
  }

  stats.patternsCreated = candidates.length;
  return { candidates, debugLog, stats };
}

module.exports = {
  evaluate,
  key: STRATEGY_KEY,
  normalizeStrength,
  normalizeTouches,
  resolveExtremePrice,
};
