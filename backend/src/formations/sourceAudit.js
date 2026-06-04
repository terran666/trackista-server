'use strict';

const trackedExtremesStore = require('../services/trackedExtremesStore');
const trackedLevelsStore = require('../services/trackedLevelsStore');
const manualLevelsStore = require('../services/manualLevelsStore');

const BREAKOUT_BUFFER_PCT = 0.15; // matches doubleExtremeStrategy config default

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSide(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'support' || s === 'low') return 'SUPPORT';
  if (s === 'resistance' || s === 'high') return 'RESISTANCE';
  return s.toUpperCase();
}

function normalizeExtreme(e) {
  const points = Array.isArray(e.points) ? e.points : [];
  const firstTs = points[0]?.timestamp ?? e.timestamp ?? null;
  return {
    id: e.id,
    symbol: e.symbol,
    marketType: e.marketType,
    tf: e.tf,
    source: e.source || 'extremes',
    side: normalizeSide(e.side),
    type: e.type || null,
    price: safeNum(e.price),
    touches: safeNum(e.touches),
    strength: safeNum(e.strength),
    time: firstTs,
    points,
    updatedAt: e.updatedAt || e.createdAt || null,
  };
}

function normalizeLevel(l, sourceType) {
  return {
    id: l.id,
    symbol: l.symbol,
    marketType: l.marketType,
    tf: l.tf,
    source: l.source || sourceType,
    sourceType,
    side: normalizeSide(l.side),
    type: l.type || null,
    price: safeNum(l.price),
    touches: safeNum(l.touches),
    strength: safeNum(l.score),
    formationTimestamp: l.formationTimestamp || null,
    createdAt: l.createdAt || null,
    status: l.isActive === false ? 'INACTIVE' : 'ACTIVE',
    updatedAt: l.updatedAt || l.createdAt || null,
  };
}

function buildQuality(items, type) {
  const out = {
    total: items.length,
    valid: 0,
    invalid: 0,
    issues: {
      missingPrice: 0,
      missingTypeOrSide: 0,
      missingSource: 0,
      nonPositiveTouchesOrStrength: 0,
    },
  };

  for (const item of items) {
    const hasPrice = Number.isFinite(item.price) && item.price > 0;
    const hasType = !!(item.type || item.side);
    const hasSource = !!item.source;
    let hasQuality = true;
    if (type === 'extreme') {
      hasQuality = Number.isFinite(item.touches) && item.touches > 0 && Number.isFinite(item.strength) && item.strength > 0;
    }
    if (type === 'level' && item.sourceType === 'tracked') {
      hasQuality = Number.isFinite(item.touches) && item.touches > 0 && Number.isFinite(item.strength) && item.strength > 0;
    }

    if (hasPrice && hasType && hasSource && hasQuality) {
      out.valid += 1;
      continue;
    }

    out.invalid += 1;
    if (!hasPrice) out.issues.missingPrice += 1;
    if (!hasType) out.issues.missingTypeOrSide += 1;
    if (!hasSource) out.issues.missingSource += 1;
    if (!hasQuality) out.issues.nonPositiveTouchesOrStrength += 1;
  }

  return out;
}

function collectDecisionTrace(diag) {
  const byTf = diag?.debugByTf || {};
  const candidates = Array.isArray(diag?.candidates) ? diag.candidates : [];
  const selected = candidates
    .slice()
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0] || null;
  const lbSeq = Array.isArray(byTf?._levelBased?.sequences) ? byTf._levelBased.sequences : [];
  const lbSummary = lbSeq.find((x) => x && x.kind === 'summary') || null;

  const rejectedPatterns = [];
  const rejectedByReason = {};
  for (const [tf, payload] of Object.entries(byTf)) {
    if (tf === '_levelBased') continue;
    const sequences = Array.isArray(payload?.sequences) ? payload.sequences : [];
    for (const seq of sequences) {
      if (seq.accepted) continue;
      const reason = seq.rejectReason || 'UNKNOWN';
      rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
      rejectedPatterns.push({
        tf,
        patternType: seq.patternType || null,
        reason,
        points: Array.isArray(seq.points) ? seq.points : [],
        prices: Array.isArray(seq.prices) ? seq.prices : [],
      });
    }
  }

  const whySelected = [];
  if (selected) {
    whySelected.push(`patternType=${selected.patternType}`);
    whySelected.push(`score=${selected.score}`);
    if (selected.levelId) whySelected.push(`levelId=${selected.levelId}`);
    if (selected.levelSource) whySelected.push(`levelSource=${selected.levelSource}`);
    if (selected.levelTf) whySelected.push(`levelTf=${selected.levelTf}`);
    if (selected.levelType) whySelected.push(`levelType=${selected.levelType}`);
    if (typeof selected.isVisibleOnTestPage === 'boolean') {
      whySelected.push(`isVisibleOnTestPage=${selected.isVisibleOnTestPage}`);
    }
    const q = selected.metrics?.patternQuality;
    if (q != null) whySelected.push(`patternQuality=${q}`);
    const move = selected.metrics?.moveToNecklinePct;
    if (move != null) whySelected.push(`moveToNecklinePct=${move}`);
  }

  // Explain why SHORT was not selected
  const whyNoShort = [];
  if (candidates.length === 0) {
    whyNoShort.push('NO_PATTERNS_CREATED — no accepted H-L-H or L-H-L sequence in extremes');
    whyNoShort.push('ENGINE_ONLY_KNOWS_DOUBLE_EXTREME — no support-breakdown / bear-flag strategy exists');
  } else {
    const hasShort = candidates.some(c => c.direction === 'SHORT_BREAKDOWN');
    if (!hasShort) {
      whyNoShort.push('NO_DOUBLE_TOP_FORMED — no H-L-H sequence found or all rejected by filters');
      whyNoShort.push('ENGINE_ONLY_KNOWS_DOUBLE_EXTREME — no support-breakdown / bear-flag strategy exists');
    }
  }

  const selectedPattern = selected
    ? {
        patternType: selected.patternType,
        direction: selected.direction,
        tf: selected.tf,
        score: selected.score,
        levels: {
          ...selected.levels,
          resistanceSource: selected.patternType === 'DOUBLE_TOP'
            ? 'derived-from-extremes-avg'
            : (selected.levels?.resistanceSource ?? selected.levelSource ?? null),
          supportSource: selected.patternType === 'DOUBLE_BOTTOM'
            ? 'derived-from-extremes-avg'
            : (selected.levels?.supportSource ?? selected.levelSource ?? null),
        },
        metrics: selected.metrics,
        points: selected.points,
      }
    : null;

  const selectedCandidateLevel = selected
    ? {
        levelId: selected.levelId ?? selected.metrics?.levelId ?? null,
        levelSource: selected.levelSource ?? selected.metrics?.levelSource ?? null,
        levelTf: selected.levelTf ?? selected.metrics?.levelTf ?? null,
        levelType: selected.levelType ?? selected.metrics?.levelType ?? null,
        levelPrice: selected.levelPrice ?? selected.metrics?.levelPrice ?? selected.breakLevel ?? null,
        isVisibleOnTestPage: typeof selected.isVisibleOnTestPage === 'boolean'
          ? selected.isVisibleOnTestPage
          : (typeof selected.metrics?.isVisibleOnTestPage === 'boolean' ? selected.metrics.isVisibleOnTestPage : null),
      }
    : null;

  return {
    selectedPattern: selected
      ? selectedPattern
      : null,
    candidateLevel: selectedCandidateLevel,
    whySelected,
    rejectedPatterns,
    rejectedByReason,
    whyNoShort,
    totalCandidates: candidates.length,
    longCandidates:  candidates.filter(c => c.direction === 'LONG_BREAKOUT' || c.direction === 'LONG').length,
    shortCandidates: candidates.filter(c => c.direction === 'SHORT_BREAKDOWN' || c.direction === 'SHORT').length,
    levelBased: lbSummary ? {
      totalLongCandidates: lbSummary.totalLongCandidates ?? 0,
      totalShortCandidates: lbSummary.totalShortCandidates ?? 0,
      longRejectedReasons: lbSummary.longRejectedReasons || {},
      shortRejectedReasons: lbSummary.shortRejectedReasons || {},
      levelsFoundByTf: lbSummary.levelsFoundByTf || {},
      validLevelsByTf: lbSummary.validLevelsByTf || {},
      candidatesByTf: lbSummary.candidatesByTf || {},
      rejectedByTf: lbSummary.rejectedByTf || {},
      perTf: lbSummary.perTf || {},
      warning: lbSummary.warning || null,
    } : null,
  };
}

// Build breakout status for every support/resistance (both extremes and levels)
function buildBreakoutChecks(items, currentPrice) {
  if (!(currentPrice > 0)) return items.map(item => ({ ...item, breakoutStatus: 'PRICE_UNKNOWN' }));
  return items.map(item => {
    const p = safeNum(item.price);
    if (!(p > 0)) return { ...item, breakoutStatus: 'INVALID_PRICE', distancePct: null, isBroken: null };
    const buf = p * (BREAKOUT_BUFFER_PCT / 100);
    const distancePct = Number(((currentPrice - p) / p * 100).toFixed(4));
    let isBroken = null;
    let breakoutStatus = 'INTACT';
    if (item.side === 'SUPPORT') {
      isBroken = currentPrice < (p - buf);
      if (isBroken) breakoutStatus = 'BROKEN_DOWN';
      else if (Math.abs(distancePct) < 0.5) breakoutStatus = 'AT_LEVEL';
    } else if (item.side === 'RESISTANCE') {
      isBroken = currentPrice > (p + buf);
      if (isBroken) breakoutStatus = 'BROKEN_UP';
      else if (Math.abs(distancePct) < 0.5) breakoutStatus = 'AT_LEVEL';
    }
    return { ...item, distancePct, isBroken, breakoutStatus };
  });
}

// Find clusters of close extremes that look like a single visual level on the chart
function buildExtremeClusters(extremes, tolerancePct = 1.5) {
  const clusters = [];
  const used = new Set();
  const sorted = extremes.slice().sort((a, b) => (a.price || 0) - (b.price || 0));
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const base = sorted[i];
    if (!(base.price > 0)) continue;
    const group = [base];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const other = sorted[j];
      if (!(other.price > 0)) continue;
      const pct = Math.abs(other.price - base.price) / base.price * 100;
      if (pct <= tolerancePct && other.side === base.side) {
        group.push(other);
        used.add(j);
      }
    }
    const avgPrice = group.reduce((s, e) => s + e.price, 0) / group.length;
    clusters.push({
      side: base.side,
      avgPrice: Number(avgPrice.toFixed(8)),
      prices: group.map(e => e.price),
      ids: group.map(e => e.id),
      count: group.length,
      isCluster: group.length > 1,
      visualLabel: `~${Number(avgPrice.toFixed(5))}`,
    });
  }
  return clusters;
}

function findMatch(price, pool, maxPctDiff) {
  let best = null;
  let bestPct = Infinity;
  for (const candidate of pool) {
    const p = safeNum(candidate.price);
    if (!(p > 0)) continue;
    const pct = Math.abs(price - p) / p * 100;
    if (pct < bestPct) {
      bestPct = pct;
      best = candidate;
    }
  }
  if (!best || bestPct > maxPctDiff) return null;
  return { candidate: best, pctDiff: Number(bestPct.toFixed(6)) };
}

function computeZone(levelPrice, tolerancePct = 0.35) {
  const p = safeNum(levelPrice);
  if (!(p > 0)) return { zoneLower: null, zoneUpper: null };
  const t = Number.isFinite(Number(tolerancePct)) ? Number(tolerancePct) : 0.35;
  return {
    zoneLower: Number((p * (1 - t / 100)).toFixed(8)),
    zoneUpper: Number((p * (1 + t / 100)).toFixed(8)),
  };
}

function buildLevelRootCauseReport({ testPageLevels, candidates, decisionTrace, tf }) {
  const levelBased = decisionTrace?.levelBased || {};
  const rejects = levelBased.perTf?.[tf]?.rejectReasons || {};

  const bySelectedLevelId = new Map();
  const byLevelTuple = new Map();
  for (const c of candidates || []) {
    const sel = c.selectedLevel || null;
    if (sel?.id != null) bySelectedLevelId.set(String(sel.id), c);
    const tuple = `${String(c.levelSource || '')}:${String(c.levelTf || '')}:${Number(c.levelPrice || c.breakLevel || 0).toFixed(8)}`;
    if (!byLevelTuple.has(tuple)) byLevelTuple.set(tuple, c);
  }

  const rows = [];
  for (const lvl of testPageLevels || []) {
    const levelPrice = safeNum(lvl.price);
    const tuple = `${String((lvl.source || '').toLowerCase() === 'autolevels' ? 'auto-levels' : (lvl.source || ''))}:${String(lvl.tf || '')}:${Number(levelPrice || 0).toFixed(8)}`;
    const cById = lvl.id != null ? bySelectedLevelId.get(String(lvl.id)) : null;
    const cByTuple = byLevelTuple.get(tuple) || null;
    const candidate = cById || cByTuple || null;

    const tolerancePct = safeNum(candidate?.tolerancePct ?? candidate?.metrics?.tolerancePct ?? 0.35) || 0.35;
    const { zoneLower, zoneUpper } = computeZone(levelPrice, tolerancePct);

    let rejectReason = null;
    let rejectStage = null;
    if (!candidate) {
      const reasonOrder = [
        'NOT_ENOUGH_TOUCHES',
        'LEVEL_TOO_OLD',
        'LEVEL_TOO_FAR',
        'LEVEL_NOT_VISIBLE_ON_TESTPAGE',
        'LEVEL_CROSSES_TOO_MANY_BODIES',
        'DIRECTION_NOT_MATCHED',
        'CANDLES_NOT_AVAILABLE',
        'TF_NOT_ANALYZED',
        'LEVEL_INVALID_SOURCE',
      ];
      rejectReason = reasonOrder.find((r) => (rejects[r] || 0) > 0) || null;
      rejectStage = rejectReason ? 'candidate_filter' : null;
    }

    const levelAgeMinutes = candidate?.levelAgeMinutes ?? null;
    const levelAgeBars = candidate?.levelAgeBars ?? null;
    const bodyCrossCount = candidate?.bodyCrossCount ?? null;
    const barsCrossedCount = candidate?.barsCrossedCount ?? null;
    const bodyCrossRatio = (Number.isFinite(bodyCrossCount) && Number.isFinite(barsCrossedCount) && barsCrossedCount > 0)
      ? Number((bodyCrossCount / barsCrossedCount).toFixed(4))
      : null;

    rows.push({
      levelId: candidate?.levelId || (lvl.id != null ? String(lvl.id) : null),
      levelSource: candidate?.levelSource || lvl.source || null,
      levelTf: candidate?.levelTf || lvl.tf || null,
      levelType: candidate?.levelType || lvl.side || null,
      levelPrice,
      zoneLower: candidate?.zoneLower ?? zoneLower,
      zoneUpper: candidate?.zoneUpper ?? zoneUpper,
      isVisibleOnTestPage: typeof candidate?.isVisibleOnTestPage === 'boolean'
        ? candidate.isVisibleOnTestPage
        : true,
      touches: candidate?.touches ?? safeNum(lvl.touches),
      independentTouches: candidate?.independentTouches ?? null,
      touchPoints: Array.isArray(candidate?.touchPoints) ? candidate.touchPoints : [],
      levelAgeBars,
      levelAgeMinutes,
      distancePct: candidate?.distancePct ?? null,
      bodyCrossRatio,
      barsCrossedCount,
      bodyCrossCount,
      wickTouchCount: candidate?.wickTouchCount ?? null,
      directionFit: candidate ? true : (rejectReason === 'DIRECTION_NOT_MATCHED' ? false : null),
      candidatePattern: candidate?.patternType ?? null,
      candidateDirection: candidate?.direction ?? null,
      rejectReason,
      rejectStage,
    });
  }

  return rows;
}

function buildLevelMismatches(testPageLevels, formationLevels, maxPctDiff = 0.08) {
  const mismatches = [];

  const tpCore = testPageLevels.filter(l => l.side === 'SUPPORT' || l.side === 'RESISTANCE');
  const fCore = formationLevels.filter(l => l.side === 'SUPPORT' || l.side === 'RESISTANCE');

  for (const level of tpCore) {
    if (!(level.price > 0)) continue;
    const match = findMatch(level.price, fCore.filter(x => x.side === level.side), maxPctDiff);
    if (!match) {
      mismatches.push({
        type: 'LEVEL_MISSING_IN_FORMATIONS',
        side: level.side,
        price: level.price,
        source: level.source,
      });
    }
  }

  for (const level of fCore) {
    if (!(level.price > 0)) continue;
    const match = findMatch(level.price, tpCore.filter(x => x.side === level.side), maxPctDiff);
    if (!match) {
      mismatches.push({
        type: 'LEVEL_EXTRA_IN_FORMATIONS',
        side: level.side,
        price: level.price,
        source: level.source,
      });
    }
  }

  return mismatches;
}

function buildFormationLevelsFromCandidates(candidates) {
  const out = [];
  for (const c of candidates) {
    const tf = c.tf || null;
    const patternType = c.patternType || null;
    const add = (kind, side, price) => {
      const p = safeNum(price);
      if (!(p > 0)) return;
      out.push({
        side,
        kind,
        price: p,
        tf,
        source: 'pattern-engine',
        patternType,
        score: c.score || null,
      });
    };

    add('RESISTANCE_LEVEL', 'RESISTANCE', c.levels?.resistanceLevel);
    add('SUPPORT_LEVEL', 'SUPPORT', c.levels?.supportLevel);
    add('NECKLINE', c.patternType === 'DOUBLE_TOP' ? 'SUPPORT' : 'RESISTANCE', c.levels?.necklineLevel);
    add('BREAKOUT', c.patternType === 'DOUBLE_TOP' ? 'SUPPORT' : 'RESISTANCE', c.levels?.breakoutLevel);
    add('INVALIDATION', c.patternType === 'DOUBLE_TOP' ? 'RESISTANCE' : 'SUPPORT', c.levels?.invalidationLevel);
  }
  return out;
}

async function buildFormationSourceAudit(service, { symbol, tf, marketType }) {
  const sym = String(symbol || '').toUpperCase().trim();
  const mt = String(marketType || 'futures').trim();
  const tfNorm = tf && String(tf).trim() !== 'ALL' ? String(tf).trim() : null;

  const testPageExtremes = trackedExtremesStore
    .getAll({ symbol: sym, marketType: mt, ...(tfNorm ? { tf: tfNorm } : {}) })
    .map(normalizeExtreme);
  const testPageTrackedLevels = trackedLevelsStore
    .getAll({ symbol: sym, marketType: mt, ...(tfNorm ? { tf: tfNorm } : {}) })
    .map(l => normalizeLevel(l, 'tracked'));
  const testPageManualLevels = manualLevelsStore
    .getAll({ symbol: sym, marketType: mt, ...(tfNorm ? { tf: tfNorm } : {}) })
    .map(l => normalizeLevel(l, 'manual'));
  const testPageLevels = [...testPageTrackedLevels, ...testPageManualLevels];

  const diagnostics = await service.diagnosePatterns([sym], { marketType: mt, tf: tfNorm || undefined });
  const diag = diagnostics?.[0] || { candidates: [], totalExtremes: 0, debugByTf: {} };
  const lbSeq = Array.isArray(diag.debugByTf?._levelBased?.sequences) ? diag.debugByTf._levelBased.sequences : [];
  const lbSummary = lbSeq.find((x) => x && x.kind === 'summary') || {};
  const perTf = lbSummary.perTf || {};
  const tfOrder = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const levelsFoundByTf = {};
  const extremesFoundByTf = {};
  const validLevelsByTf = {};
  const candidatesByTf = {};
  const rejectedByTf = {};
  for (const tfKey of tfOrder) {
    const item = perTf[tfKey] || {};
    levelsFoundByTf[tfKey] = item.levelsFound ?? 0;
    extremesFoundByTf[tfKey] = item.extremesFound ?? 0;
    validLevelsByTf[tfKey] = item.validLevels ?? 0;
    candidatesByTf[tfKey] = item.candidatesCreated ?? 0;
    rejectedByTf[tfKey] = item.rejectReasons || {};
  }
  const candidates = Array.isArray(diag.candidates) ? diag.candidates : [];
  const candlesByTf = diag.candlesByTf || {};
  const candlesReadinessByTf = diag.candlesReadinessByTf || {};
  const tracedCandidates = candidates.map((c) => ({
    ...c,
    selectedLevel: c.selectedLevel || c.metrics?.selectedLevel || (c.levelId ? {
      id: c.levelId,
      source: c.levelSource || null,
      tf: c.levelTf || null,
      side: c.levelType || null,
      price: c.levelPrice || c.breakLevel || null,
    } : null),
    selectedExtremes: c.selectedExtremes || c.metrics?.selectedExtremes ||
      (Array.isArray(c.extremeIds) ? c.extremeIds.map((id) => ({ id, source: c.extremeSource || 'tracked-extremes' })) : []),
    candidateTouches: c.candidateTouches || c.metrics?.candidateTouches || [],
    rejectedReason: c.rejectedReason || null,
  }));
  const formationLevels = buildFormationLevelsFromCandidates(candidates);
  const decisionTrace = collectDecisionTrace({ ...diag, candidates });
  const rootCauseByLevel = buildLevelRootCauseReport({
    testPageLevels,
    candidates: tracedCandidates,
    decisionTrace,
    tf: tfNorm || '15m',
  });

  const mismatches = buildLevelMismatches(testPageLevels, formationLevels);

  const tpHighs = testPageExtremes.filter(e => e.side === 'RESISTANCE');
  const tpLows = testPageExtremes.filter(e => e.side === 'SUPPORT');
  const tpRes = testPageLevels.filter(l => l.side === 'RESISTANCE');
  const tpSup = testPageLevels.filter(l => l.side === 'SUPPORT');

  // Current price estimation: use the latest second-point timestamp across all extremes
  // The second point is the chart-right-edge price (snapshot end price)
  let currentPrice = null;
  let latestTs = 0;
  for (const e of testPageExtremes) {
    if (Array.isArray(e.points) && e.points.length >= 2) {
      const lastPt = e.points[e.points.length - 1];
      if ((lastPt?.timestamp || 0) > latestTs) {
        latestTs = lastPt.timestamp;
        // The second point value = the right-edge projection of that extreme
        // It is NOT the current price but is a reasonable proxy in absence of ticker
        currentPrice = lastPt.value ?? lastPt.price ?? null;
      }
    }
  }

  // Build breakout checks — attaches distancePct / isBroken to each level/extreme
  const supportsWithBreakout = buildBreakoutChecks(
    [...tpLows.map(e => ({ ...e, category: 'extreme' })),
     ...tpSup.map(l => ({ ...l, category: 'tracked-level' }))],
    currentPrice,
  ).sort((a, b) => (b.price || 0) - (a.price || 0));

  const resistancesWithBreakout = buildBreakoutChecks(
    [...tpHighs.map(e => ({ ...e, category: 'extreme' })),
     ...tpRes.map(l => ({ ...l, category: 'tracked-level' }))],
    currentPrice,
  ).sort((a, b) => (a.price || 0) - (b.price || 0));

  // Extreme clusters — groups of close extremes that appear as a single visual level
  const extremeClusters = [
    ...buildExtremeClusters(tpLows),
    ...buildExtremeClusters(tpHighs),
  ];

  return {
    symbol: sym,
    tf: tfNorm || 'ALL',
    marketType: mt,
    generatedAt: Date.now(),
    currentPrice,
    counts: {
      testPage: {
        extremes: testPageExtremes.length,
        levels: testPageLevels.length,
        highs: tpHighs.length,
        lows: tpLows.length,
        resistances: tpRes.length,
        supports: tpSup.length,
      },
      formations: {
        extremes: Number(diag.totalExtremes) || 0,
        levels: formationLevels.length,
        candidates: candidates.length,
      },
    },
    sourceDebug: {
      testPage: {
        highs: tpHighs,
        lows: tpLows,
        resistances: tpRes,
        supports: tpSup,
        extremes: testPageExtremes,
        levels: testPageLevels,
      },
      formations: {
        candidates: tracedCandidates,
        levels: formationLevels,
        tfSummary: diag.tfSummary || {},
        statsByTf: diag.statsByTf || {},
        candlesByTf,
        candlesReadinessByTf,
      },
    },
    visibleSupports: supportsWithBreakout,
    visibleResistances: resistancesWithBreakout,
    testPageLevels,
    testPageExtremes,
    candlesByTf,
    candlesReadinessByTf,
    levelsFoundByTf,
    extremesFoundByTf,
    validLevelsByTf,
    candidatesByTf,
    rejectedByTf,
    extremeClusters,
    quality: {
      extremes: buildQuality(testPageExtremes, 'extreme'),
      levels: buildQuality(testPageLevels, 'level'),
    },
    mismatches,
    decisionTrace,
    rootCauseByLevel,
  };
}

module.exports = {
  buildFormationSourceAudit,
};
