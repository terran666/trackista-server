'use strict';

const { VISIBLE_STATUSES } = require('./formationTypes');

const ALLOWED_TFS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']);

const STATUS_WEIGHT = {
  CONFIRMED: 5,
  BREAKOUT: 4,
  BREAKDOWN: 4,
  RETEST: 4,
  DETECTED: 4,
  READY: 4,
  APPROACHING: 3,
  ACTIVE: 3,
  FORMING: 2,
  WEAK: 1,
};

const TF_WEIGHT = {
  '1m': 1,
  '3m': 2,
  '5m': 3,
  '15m': 4,
  '30m': 5,
  '1h': 6,
  '4h': 7,
  '1d': 8,
};

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isDoublePattern(patternType) {
  return patternType === 'DOUBLE_TOP' || patternType === 'DOUBLE_BOTTOM';
}

function normalizeDirection(value) {
  const v = String(value || '').trim().toUpperCase();

  if (!v || v === 'ALL') return 'ALL';
  if (
    v === 'LONG' ||
    v === 'BULLISH' ||
    v === 'BUY' ||
    v === 'LONG_BREAKOUT' ||
    v === 'UP' ||
    v === 'RISE'
  ) return 'LONG';
  if (
    v === 'SHORT' ||
    v === 'BEARISH' ||
    v === 'SELL' ||
    v === 'SHORT_BREAKDOWN' ||
    v === 'DOWN' ||
    v === 'FALL'
  ) return 'SHORT';

  return null;
}

function normalizePatternType(value) {
  const v = String(value || '').trim().toUpperCase();

  if (!v || v === 'ALL') return 'ALL';
  if (v === 'DOUBLE_TOP'    || v === 'DOUBLE TOP')    return 'DOUBLE_TOP';
  if (v === 'DOUBLE_BOTTOM' || v === 'DOUBLE BOTTOM') return 'DOUBLE_BOTTOM';
  // Level-based patterns
  if (v === 'SUPPORT_BREAKDOWN_SETUP') return 'SUPPORT_BREAKDOWN_SETUP';
  if (v === 'SUPPORT_BREAKDOWN')    return 'SUPPORT_BREAKDOWN';
  if (v === 'RESISTANCE_BREAKOUT_SETUP') return 'RESISTANCE_BREAKOUT_SETUP';
  if (v === 'RESISTANCE_BREAKOUT')  return 'RESISTANCE_BREAKOUT';
  if (v === 'SUPPORT_BOUNCE')       return 'SUPPORT_BOUNCE';
  if (v === 'RESISTANCE_REJECTION') return 'RESISTANCE_REJECTION';

  return null;
}

function normalizeTf(value) {
  const v = String(value || '').trim();
  if (!v || String(v).toUpperCase() === 'ALL') return 'ALL';
  return ALLOWED_TFS.has(v) ? v : null;
}

function normalizeMarket(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'all') return 'ALL';
  if (v === 'futures' || v === 'spot') return v;
  return null;
}

function normalizeStatus(status, patternType) {
  const raw = String(status || '').toUpperCase();
  if (patternType === 'SUPPORT_BREAKDOWN' && (raw === 'ACTIVE' || raw === 'APPROACHING')) return 'BREAKDOWN';
  if (patternType === 'RESISTANCE_BREAKOUT' && (raw === 'ACTIVE' || raw === 'APPROACHING')) return 'BREAKOUT';
  if (raw === 'ACTIVE') return 'APPROACHING';
  return raw || null;
}

function computeDistancePct(price, levelPrice) {
  if (!Number.isFinite(price) || !Number.isFinite(levelPrice) || levelPrice <= 0) return null;
  return Math.abs((price - levelPrice) / levelPrice) * 100;
}

function buildFormationViewItem(f) {
  const symbol = String(f.symbol || '').toUpperCase();
  const tf = f.tf || null;
  const patternType = f.patternType || null;
  const isDouble = isDoublePattern(patternType);
  const market = f.marketType || f.market || null;
  const direction = normalizeDirection(f.direction);
  const score = toNum(f.score, 0);
  const price = toNum(f.currentPrice ?? f.price, null);
  const neckline = toNum(
    f.levels?.necklineLevel
    ?? f.levels?.supportLevel     // level-based: SUPPORT_BREAKDOWN / SUPPORT_BOUNCE
    ?? f.levels?.resistanceLevel  // level-based: RESISTANCE_BREAKOUT / RESISTANCE_REJECTION
    ?? f.levels?.breakoutLevel    // level-based fallback
    ?? f.breakout?.price
    ?? f.level?.price
    ?? null,
    null,
  );
  const rawDistance = toNum(f.distancePct ?? f.breakdownPct ?? f.debug?.distancePct, null);
  const signedDistance = Number.isFinite(rawDistance)
    ? rawDistance
    : (Number.isFinite(price) && Number.isFinite(neckline) && neckline > 0
      ? ((price - neckline) / neckline) * 100
      : null);
  const distancePct = (patternType === 'SUPPORT_BREAKDOWN' || patternType === 'RESISTANCE_REJECTION')
    ? signedDistance
    : (Number.isFinite(signedDistance) ? Math.abs(signedDistance) : null);

  const id = patternType && symbol && tf
    ? `${symbol}_${tf}_${patternType}`
    : String(f.id);

  const topA = toNum(f.points?.firstExtreme?.price, null);
  const topB = toNum(f.points?.secondExtreme?.price, null);
  const lowA = toNum(f.points?.firstExtreme?.price, null);
  const lowB = toNum(f.points?.secondExtreme?.price, null);
  const necklinePrice = toNum(f.levels?.necklineLevel, null);
  const topDistancePct = patternType === 'DOUBLE_TOP'
    ? toNum(f.metrics?.priceDiffPct, null)
    : null;
  const lowDistancePct = patternType === 'DOUBLE_BOTTOM'
    ? toNum(f.metrics?.priceDiffPct, null)
    : null;
  const patternQuality = toNum(f.metrics?.patternQuality, null);
  const levelPrice = toPositiveNumOrNull(f.levelPrice ?? f.metrics?.levelPrice ?? f.breakLevel ?? f.levels?.breakoutLevel);
  const levelCreatedAt = toNum(f.levelCreatedAt ?? f.metrics?.levelCreatedAt ?? f.debug?.levelCreatedAt, null);
  const levelId = f.levelId ?? f.metrics?.levelId ?? f.debug?.levelId ?? null;
  const levelSource = f.levelSource ?? f.metrics?.levelSource ?? f.debug?.levelSource ?? null;
  const levelTf = f.levelTf ?? f.metrics?.levelTf ?? f.debug?.levelTf ?? null;
  const sourceTf = f.sourceTf ?? f.metrics?.sourceTf ?? f.debug?.sourceTf ?? levelTf ?? null;
  const confluenceTf = typeof f.confluenceTf === 'boolean'
    ? f.confluenceTf
    : (sourceTf && tf ? String(sourceTf) !== String(tf) : false);
  const debugTfReason = f.debugTfReason ?? f.metrics?.debugTfReason ?? f.debug?.debugTfReason ?? null;
  const extremeTf = f.extremeTf ?? f.metrics?.extremeTf ?? f.debug?.extremeTf ?? levelTf ?? null;
  const extremeIds = Array.isArray(f.extremeIds)
    ? f.extremeIds
    : (Array.isArray(f.metrics?.extremeIds) ? f.metrics.extremeIds : []);
  const extremeId = f.extremeId ?? f.metrics?.extremeId ?? f.debug?.extremeId ?? null;
  const extremeSource = f.extremeSource ?? f.metrics?.extremeSource ?? f.debug?.extremeSource ?? null;
  const extremeType = f.extremeType ?? f.metrics?.extremeType ?? f.debug?.extremeType ?? null;
  const extremePrice = toPositiveNumOrNull(f.extremePrice ?? f.metrics?.extremePrice ?? f.debug?.extremePrice);
  const extremeTime = toNum(f.extremeTime ?? f.metrics?.extremeTime ?? f.debug?.extremeTime, null);
  const extremeBarIndex = toNum(f.extremeBarIndex ?? f.metrics?.extremeBarIndex ?? f.debug?.extremeBarIndex, null);
  const levelAge = toNum(f.levelAge ?? f.metrics?.levelAge ?? f.debug?.levelAge, null);
  const levelType = String(f.levelType ?? f.metrics?.levelType ?? f.debug?.levelType ?? '').toUpperCase() || null;
  const zoneLower = toPositiveNumOrNull(f.zoneLower ?? f.metrics?.zoneLower ?? f.debug?.zoneLower ?? f.levels?.supportZone?.lowerBound ?? f.levels?.resistanceZone?.lowerBound);
  const zoneUpper = toPositiveNumOrNull(f.zoneUpper ?? f.metrics?.zoneUpper ?? f.debug?.zoneUpper ?? f.levels?.supportZone?.upperBound ?? f.levels?.resistanceZone?.upperBound);
  const tolerancePct = toNum(f.tolerancePct ?? f.metrics?.tolerancePct ?? f.debug?.tolerancePct, null);
  const distanceToLevel = toNum(f.distanceToLevel ?? f.metrics?.distanceToLevel ?? f.debug?.distanceToLevel, null);
  const volumeFactor = toNum(f.volumeFactor ?? f.metrics?.volumeFactor ?? f.debug?.volumeFactor, null);
  const setupScore = toNum(f.metrics?.setupScore ?? f.debug?.setupScore, null);
  const levelAgeBars = toNum(f.levelAgeBars ?? f.metrics?.levelAgeBars ?? f.debug?.levelAgeBars, null);
  const levelAgeMinutes = toNum(f.levelAgeMinutes ?? f.metrics?.levelAgeMinutes ?? f.debug?.levelAgeMinutes, null);
  const firstTouchTime = toNum(f.firstTouchTime ?? f.metrics?.firstTouchTime ?? f.debug?.firstTouchTime, null);
  const lastTouchTime = toNum(f.lastTouchTime ?? f.metrics?.lastTouchTime ?? f.debug?.lastTouchTime, null);
  const avgReactionPct = toNum(f.avgReactionPct ?? f.metrics?.avgReactionPct ?? f.debug?.avgReactionPct, null);
  const maxReactionPct = toNum(f.maxReactionPct ?? f.metrics?.maxReactionPct ?? f.debug?.maxReactionPct, null);
  const touchPoints = Array.isArray(f.touchPoints)
    ? f.touchPoints
    : (Array.isArray(f.metrics?.touchPoints) ? f.metrics.touchPoints : (Array.isArray(f.debug?.touchPoints) ? f.debug.touchPoints : []));
  const independentTouches = toNum(f.independentTouches ?? f.metrics?.independentTouches ?? f.debug?.independentTouches, null);
  const touchClusterCount = toNum(f.touchClusterCount ?? f.metrics?.touchClusterCount ?? f.debug?.touchClusterCount, null);
  const touchTimeSpreadBars = toNum(f.touchTimeSpreadBars ?? f.metrics?.touchTimeSpreadBars ?? f.debug?.touchTimeSpreadBars, null);
  const touchTimeSpreadMinutes = toNum(f.touchTimeSpreadMinutes ?? f.metrics?.touchTimeSpreadMinutes ?? f.debug?.touchTimeSpreadMinutes, null);
  const barsCrossedCount = toNum(f.barsCrossedCount ?? f.metrics?.barsCrossedCount ?? f.debug?.barsCrossedCount, null);
  const cleanTouchCount = toNum(f.cleanTouchCount ?? f.metrics?.cleanTouchCount ?? f.debug?.cleanTouchCount, null);
  const bodyCrossCount = toNum(f.bodyCrossCount ?? f.metrics?.bodyCrossCount ?? f.debug?.bodyCrossCount, null);
  const wickTouchCount = toNum(f.wickTouchCount ?? f.metrics?.wickTouchCount ?? f.debug?.wickTouchCount, null);
  const isVisibleOnTestPage = typeof f.isVisibleOnTestPage === 'boolean'
    ? f.isVisibleOnTestPage
    : (typeof f.visibleOnTestPage === 'boolean'
      ? f.visibleOnTestPage
      : (typeof f.metrics?.isVisibleOnTestPage === 'boolean' ? f.metrics.isVisibleOnTestPage : null));
  const _rawChartRange = f.chartRange ?? f.metrics?.chartRange ?? f.debug?.chartRange ?? null;
  // Derive chartRange from extremeTime when no explicit range is provided (optional visual field)
  const _TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  const chartRange = _rawChartRange
    ?? (extremeTime
      ? { fromTime: extremeTime - (_TF_MS[extremeTf || tf] ?? 60000) * 50, toTime: null, reason: 'from_extreme_time' }
      : null);
  // levelLine: horizontal line from extremeTime to present at extremePrice (optional, for chart drawing)
  const levelLine = (extremePrice && extremeType)
    ? { fromTime: extremeTime ?? null, toTime: null, price: extremePrice, type: extremeType }
    : null;
  const breakDirection = f.breakDirection ?? f.metrics?.breakDirection ?? f.debug?.breakDirection ?? null;
  const lifecycleStatus = f.lifecycleStatus ?? f.metrics?.lifecycleStatus ?? f.debug?.lifecycleStatus ?? null;
  const lifecycleReason = f.lifecycleReason ?? f.metrics?.lifecycleReason ?? f.debug?.lifecycleReason ?? null;

  return {
    id,
    symbol,
    tf,
    market,
    patternType,
    direction: direction === 'ALL' ? null : direction,
    status: normalizeStatus(f.status, patternType),
    score,
    price,
    neckline,
    distancePct,
    breakLevel: toPositiveNumOrNull(f.breakLevel ?? f.levels?.breakoutLevel ?? null),
    breakDirection,
    lifecycleStatus,
    lifecycleReason,
    levelId,
    levelSource,
    levelTf,
    sourceTf,
    confluenceTf,
    debugTfReason,
    levelPrice,
    levelCreatedAt,
    extremeId,
    extremeTf,
    extremeIds,
    extremeSource,
    extremeType,
    extremePrice,
    extremeTime,
    extremeBarIndex,
    levelLine,
    levelType,
    zoneLower,
    zoneUpper,
    tolerancePct,
    isVisibleOnTestPage,
    visibleOnTestPage: isVisibleOnTestPage,
    levelAge,
    levelAgeBars,
    levelAgeMinutes,
    firstTouchTime,
    lastTouchTime,
    avgReactionPct,
    maxReactionPct,
    touchPoints,
    independentTouches,
    touchClusterCount,
    touchTimeSpreadBars,
    touchTimeSpreadMinutes,
    barsCrossedCount,
    cleanTouchCount,
    bodyCrossCount,
    wickTouchCount,
    distanceToLevel,
    volumeFactor,
    setupScore,
    chartRange,
    supportLevel: isDouble ? null : toPositiveNumOrNull(f.supportLevel ?? f.levels?.supportLevel ?? f.metrics?.supportLevel),
    supportSource: isDouble ? null : (f.supportSource ?? f.levels?.supportSource ?? f.metrics?.supportSource ?? null),
    resistanceLevel: isDouble ? null : toPositiveNumOrNull(f.resistanceLevel ?? f.levels?.resistanceLevel ?? f.metrics?.resistanceLevel),
    resistanceSource: isDouble ? null : (f.resistanceSource ?? f.levels?.resistanceSource ?? f.metrics?.resistanceSource ?? null),
    touches: isDouble ? null : toPositiveNumOrNull(f.touches ?? f.metrics?.touches ?? f.debug?.touches),
    strength: isDouble ? null : toPositiveNumOrNull(f.strength ?? f.metrics?.strength ?? f.debug?.strength),
    breakdownPct: toNum(f.breakdownPct ?? f.metrics?.breakdownPct ?? f.debug?.breakdownPct, null),
    breakoutPct: toNum(f.breakoutPct ?? f.metrics?.breakoutPct ?? f.debug?.breakoutPct, null),
    scoreBreakdown: f.metrics?.scoreBreakdown ?? f.debug?.scoreBreakdown ?? null,
    pattern: isDouble ? {
      patternType,
      topA: patternType === 'DOUBLE_TOP' ? topA : null,
      topB: patternType === 'DOUBLE_TOP' ? topB : null,
      lowA: patternType === 'DOUBLE_BOTTOM' ? lowA : null,
      lowB: patternType === 'DOUBLE_BOTTOM' ? lowB : null,
      neckline: necklinePrice,
      topDistancePct,
      lowDistancePct,
      necklinePrice,
      patternQuality,
    } : null,
    strategy: f.strategy || null,
    updatedAt: f.updatedAt || null,
    createdAt: f.createdAt || null,
    alsoFound: [],
    debug: {
      source: f.source || null,
      extremesUsed: 3,
      reason: Array.isArray(f.reason) && f.reason.length ? f.reason[0] : null,
      whySelected: Array.isArray(f.debug?.whySelected) ? f.debug.whySelected : [],
    },
    _raw: f,
  };
}

function isValidLevelBasedItem(item) {
  const isLevelBased =
    item.patternType === 'SUPPORT_BREAKDOWN_SETUP' ||
    item.patternType === 'SUPPORT_BREAKDOWN' ||
    item.patternType === 'RESISTANCE_BREAKOUT_SETUP' ||
    item.patternType === 'RESISTANCE_BREAKOUT' ||
    item.patternType === 'SUPPORT_BOUNCE' ||
    item.patternType === 'RESISTANCE_REJECTION';

  if (isLevelBased) {
    if (item.isVisibleOnTestPage !== true) return false;

    // Stage 1: extreme-based formations use extremeId instead of levelId.
    const isExtremeBased = item.strategy === 'extremeBased' || !!item.extremeId;
    if (isExtremeBased) {
      if (!item.extremeId) return false;            // EXTREME_ID_MISSING
      if (!(item.extremePrice > 0)) return false;   // EXTREME_PRICE_INVALID
      if (!item.extremeType) return false;          // EXTREME_TYPE_INVALID
    } else {
      // Legacy level-based: require levelId, levelSource, levelTf, levelPrice
      if (!item.levelId || !item.levelSource || !item.levelTf || !(item.levelPrice > 0)) return false;
    }
  }

  if (item.patternType === 'RESISTANCE_BREAKOUT') {
    return (item.resistanceLevel > 0) && (item.breakLevel > 0) && (item.strength > 0) && item.status !== 'APPROACHING';
  }
  if (item.patternType === 'SUPPORT_BREAKDOWN') {
    return (item.supportLevel > 0) && (item.breakLevel > 0) && (item.strength > 0) && item.status !== 'APPROACHING';
  }
  return true;
}

function isBetterFormation(a, b) {
  const aStatus = STATUS_WEIGHT[a.status] ?? 0;
  const bStatus = STATUS_WEIGHT[b.status] ?? 0;
  if (aStatus !== bStatus) return aStatus > bStatus;

  const aScore = toNum(a.score, 0);
  const bScore = toNum(b.score, 0);
  if (aScore !== bScore) return aScore > bScore;

  const aDistance = Math.abs(toNum(a.distancePct, 999));
  const bDistance = Math.abs(toNum(b.distancePct, 999));
  if (aDistance !== bDistance) return aDistance < bDistance;

  return (TF_WEIGHT[a.tf] ?? 0) > (TF_WEIGHT[b.tf] ?? 0);
}

function sortForList(a, b) {
  if ((b.score ?? 0) !== (a.score ?? 0)) {
    return (b.score ?? 0) - (a.score ?? 0);
  }

  if ((STATUS_WEIGHT[b.status] ?? 0) !== (STATUS_WEIGHT[a.status] ?? 0)) {
    return (STATUS_WEIGHT[b.status] ?? 0) - (STATUS_WEIGHT[a.status] ?? 0);
  }

  const ad = Math.abs(a.distancePct ?? 999);
  const bd = Math.abs(b.distancePct ?? 999);
  if (ad !== bd) {
    return ad - bd;
  }

  return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
}

function selectBestFormationPerSymbol(items) {
  const bySymbol = new Map();

  for (const item of items) {
    const current = bySymbol.get(item.symbol);
    if (!current || isBetterFormation(item, current)) {
      bySymbol.set(item.symbol, item);
    }
  }

  return [...bySymbol.values()];
}

function buildAlsoFound(bestItems, allItemsBySymbol) {
  for (const best of bestItems) {
    const all = allItemsBySymbol.get(best.symbol) || [];
    best.alsoFound = all
      .filter(x => x.id !== best.id)
      .map(x => ({
        tf: x.tf,
        patternType: x.patternType,
        direction: x.direction,
        status: x.status,
        score: x.score,
      }));
  }
}

function normalizeQuery(query = {}) {
  const strategy = String(query.strategy || query.strategies || 'ALL').trim();
  const symbol = query.symbol ? String(query.symbol).trim().toUpperCase() : null;
  const tf = normalizeTf(query.tf || 'ALL');
  const direction = normalizeDirection(query.direction || 'ALL') || 'ALL';
  const market = normalizeMarket(query.market || query.marketType || 'futures');
  const pattern = normalizePatternType(query.pattern || query.patternType || 'ALL');
  const uniqueSymbol = String(query.uniqueSymbol ?? 'true').toLowerCase() !== 'false';
  const limit = Math.min(parseInt(query.limit || '200', 10) || 200, 1000);

  return { strategy, symbol, tf, direction, market, pattern, uniqueSymbol, limit };
}

function buildFormationsView(rawFormations, query = {}) {
  const opts = normalizeQuery(query);

  const totalRawFormations = rawFormations.length;
  const rawVisible = rawFormations.filter(f => VISIBLE_STATUSES.has(f.status));

  const filtered = rawVisible.filter(f => {
    const symbol = String(f.symbol || '').toUpperCase();
    if (!symbol) return false;

    if (opts.symbol && symbol !== opts.symbol) {
      return false;
    }

    if (opts.strategy !== 'ALL' && opts.strategy !== '*' && String(f.strategy || '') !== opts.strategy) {
      return false;
    }

    if (opts.tf !== 'ALL' && String(f.tf || '') !== opts.tf) {
      return false;
    }

    if (opts.market !== 'ALL' && String(f.marketType || '').toLowerCase() !== opts.market) {
      return false;
    }

    const direction = normalizeDirection(f.direction);
    if (opts.direction !== 'ALL' && direction !== opts.direction) {
      return false;
    }

    const patternType = normalizePatternType(f.patternType || 'ALL');
    if (opts.pattern !== 'ALL' && patternType !== opts.pattern) {
      return false;
    }

    return true;
  });

  const mapped = filtered.map(buildFormationViewItem);
  const items = mapped.filter(isValidLevelBasedItem);
  const afterFilters = items.length;

  const bySymbol = new Map();
  for (const item of items) {
    if (!bySymbol.has(item.symbol)) bySymbol.set(item.symbol, []);
    bySymbol.get(item.symbol).push(item);
  }

  let finalItems = items;
  if (opts.uniqueSymbol) {
    finalItems = selectBestFormationPerSymbol(items);
    buildAlsoFound(finalItems, bySymbol);
  }

  const afterUniqueSymbol = finalItems.length;

  finalItems.sort(sortForList);
  finalItems = finalItems.slice(0, opts.limit);

  for (const item of finalItems) {
    delete item._raw;
  }

  return {
    options: opts,
    mode: opts.uniqueSymbol ? 'uniqueSymbol' : 'raw',
    count: finalItems.length,
    items: finalItems,
    debug: {
      totalRawFormations,
      afterFilters,
      afterUniqueSymbol,
    },
  };
}

module.exports = {
  ALLOWED_TFS,
  STATUS_WEIGHT,
  normalizeDirection,
  normalizePatternType,
  normalizeTf,
  normalizeMarket,
  normalizeQuery,
  buildFormationViewItem,
  isBetterFormation,
  selectBestFormationPerSymbol,
  buildFormationsView,
};
