'use strict';

const STRATEGY_KEY = 'levelBased';

const SUPPORT_BREAKDOWN_SETUP = 'SUPPORT_BREAKDOWN_SETUP';
const SUPPORT_BREAKDOWN = 'SUPPORT_BREAKDOWN';
const RESISTANCE_BREAKOUT_SETUP = 'RESISTANCE_BREAKOUT_SETUP';
const RESISTANCE_BREAKOUT = 'RESISTANCE_BREAKOUT';
const SUPPORT_BOUNCE = 'SUPPORT_BOUNCE';
const RESISTANCE_REJECTION = 'RESISTANCE_REJECTION';

const DIR_SHORT = 'SHORT';
const DIR_LONG = 'LONG';

const TF_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

const DEFAULT_HISTORY_BARS = {
  '1m': 300,
  '5m': 250,
  '15m': 200,
  '30m': 180,
  '1h': 150,
  '4h': 120,
  '1d': 90,
};

const REQUIRED_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MIN_FRAME_BARS = 30;

const ALLOWED_SOURCES = new Set([
  'manual-levels',
  'tracked-levels',
  'auto-levels',
  'saved-rays',
  'tracked-extremes',
  'vertical-extremes',
  'sloped-levels',
]);

const SOURCE_PRIORITY = {
  'manual-levels': 4,
  'tracked-levels': 3,
  'auto-levels': 3,
  'saved-rays': 2,
  'tracked-extremes': 1,
  'vertical-extremes': 1,
  'sloped-levels': 1,
};

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tfToMinutes(tf) {
  const key = String(tf || '').trim();
  if (TF_MINUTES[key]) return TF_MINUTES[key];
  const m = key.toLowerCase().match(/^(\d+)(m|h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === 'm') return n;
  if (m[2] === 'h') return n * 60;
  return n * 1440;
}

function tfToMs(tf) {
  const m = tfToMinutes(tf);
  return Number.isFinite(m) ? m * 60000 : null;
}

function normalizeSide(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'support' || s === 'low' || s === 's') return 'SUPPORT';
  if (s === 'resistance' || s === 'high' || s === 'r') return 'RESISTANCE';
  return null;
}

function normalizeSource(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'tracked' || s === 'tracked-levels') return 'tracked-levels';
  if (s === 'manual' || s === 'manual-levels') return 'manual-levels';
  if (s === 'autolevels' || s === 'auto-levels') return 'auto-levels';
  if (s === 'saved-rays' || s === 'saved-rays-store' || s === 'manual-sloped-level' || s === 'manual-sloped-levels') return 'saved-rays';
  if (s === 'vertical-extremes') return 'vertical-extremes';
  if (s === 'sloped-levels') return 'sloped-levels';
  if (s === 'extreme' || s === 'extremes' || s === 'extreme-cluster' || s === 'tracked-extremes') return 'tracked-extremes';
  if (s === 'derived' || s === 'synthetic' || s === 'average-line' || s === 'mid-range') return s;
  return s;
}

function levelIdFor({ source, symbol, tf, type, price }) {
  return `${source}:${symbol}:${tf}:${type}:${Number(price).toFixed(8)}`;
}

function buildFrameList(tfBars, historyBarsByTf) {
  if (!(tfBars instanceof Map) || tfBars.size === 0) return [];
  const out = [];
  for (const [tf, barsRaw] of tfBars) {
    const bars = Array.isArray(barsRaw) ? barsRaw : [];
    if (!bars.length) continue;
    const cap = Math.max(MIN_FRAME_BARS, toNum(historyBarsByTf?.[tf], DEFAULT_HISTORY_BARS[tf] || 120));
    const clipped = bars.slice(-cap);
    if (clipped.length < MIN_FRAME_BARS) continue;
    out.push({ tf, tfMinutes: tfToMinutes(tf) || 1, tfMs: tfToMs(tf) || 60000, bars: clipped });
  }
  out.sort((a, b) => a.tfMinutes - b.tfMinutes);
  return out;
}

function getVolumeFactor(marketMetrics = {}) {
  const candidates = [
    marketMetrics.volumeSpikeRatio60s,
    marketMetrics.volumeSpikeRatio,
    marketMetrics.relativeVolume1m,
    marketMetrics.relativeVolume5m,
    marketMetrics.volumeFactor,
  ]
    .map((v) => toNumOrNull(v))
    .filter((v) => v != null && v > 0);
  if (!candidates.length) return 1;
  return Math.max(...candidates);
}

function findLevelTf(frameTf, levelTf) {
  const fm = tfToMinutes(frameTf) || 0;
  const lm = tfToMinutes(levelTf) || 0;
  if (!fm || !lm) return false;
  // Level TF is same or older (higher minutes).
  return lm >= fm;
}

function withinPct(a, b, pct) {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / b * 100 <= pct;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function buildStoredSourceLevels({ symbol, storedLevels, cfg, rejected }) {
  const out = [];

  for (const raw of storedLevels || []) {
    const price = toNumOrNull(raw?.price);
    const side = normalizeSide(raw?.side ?? raw?.type);
    const sourceTf = raw?.sourceTf ?? raw?.tf ?? raw?.timeframe ?? null;
    const levelTf = sourceTf ? String(sourceTf) : null;
    const source = normalizeSource(raw?.source);
    const hasId = raw?.id != null;
    const visibleOnTestPage = typeof raw?.visibleOnTestPage === 'boolean' ? raw.visibleOnTestPage : true;
    const levelCreatedAt = toNumOrNull(raw?.createdAt ?? raw?.formationTimestamp ?? raw?.updatedAt ?? null);

    if (!(price > 0) || !side) continue;

    if (!levelTf || !tfToMinutes(levelTf)) {
      rejected.push({
        rejectReason: 'TF_MISSING',
        source,
        side,
        tf: null,
        sourceTf: sourceTf ?? null,
        price,
      });
      continue;
    }

    if (source === 'tracked-extremes') {
      rejected.push({
        rejectReason: 'EXTREMES_MUST_USE_EXTREME_IDS',
        source,
        side,
        tf: levelTf,
        price,
      });
      continue;
    }

    if (!ALLOWED_SOURCES.has(source)) {
      rejected.push({
        rejectReason: 'LEVEL_SOURCE_NOT_CONFIRMED',
        rejectStage: 'source_validation',
        sourceType: 'level',
        candidateLevel: price,
        candidateTf: levelTf,
        candidateSource: source,
        source,
        side,
        tf: levelTf,
        price,
      });
      continue;
    }

    if (!hasId) {
      rejected.push({
        rejectReason: 'LEVEL_ID_MISSING',
        rejectStage: 'source_validation',
        sourceType: 'level',
        candidateLevel: price,
        candidateTf: levelTf,
        candidateSource: source,
        source,
        side,
        tf: levelTf,
        price,
      });
      continue;
    }

    if (!visibleOnTestPage) {
      rejected.push({
        rejectReason: 'LEVEL_NOT_VISIBLE_ON_TESTPAGE',
        rejectStage: 'visibility_filter',
        sourceType: 'level',
        candidateLevel: price,
        candidateTf: levelTf,
        candidateSource: source,
        source,
        side,
        tf: levelTf,
        price,
      });
      continue;
    }

    const tolerancePct = Math.max(0.03, toNum(raw?.tolerancePct, cfg.defaultTolerancePct));
    const zoneLower = toNumOrNull(raw?.zoneLower) || Number((price * (1 - tolerancePct / 100)).toFixed(8));
    const zoneUpper = toNumOrNull(raw?.zoneUpper) || Number((price * (1 + tolerancePct / 100)).toFixed(8));

    out.push({
      levelId: levelIdFor({ source, symbol, tf: levelTf, type: side, price }),
      levelSource: source,
      levelTf,
      sourceTf: levelTf,
      levelType: side,
      levelPrice: price,
      zoneLower: Math.min(zoneLower, zoneUpper),
      zoneUpper: Math.max(zoneLower, zoneUpper),
      tolerancePct,
      sourceRaw: raw?.source || null,
      sourcePayload: raw,
      selectedLevel: {
        id: raw?.id,
        source,
        tf: levelTf,
        sourceTf: levelTf,
        side,
        price: Number(price.toFixed(8)),
      },
      levelCreatedAt,
      sourcePriority: SOURCE_PRIORITY[source] || 0,
      sourceStrength: Math.max(1, toNum(raw?.touches, 0), toNum(raw?.strength, 0), toNum(raw?.score, 0) / 10),
      isVisibleOnTestPage: visibleOnTestPage,
      extremeIds: [],
    });
  }

  return out;
}

function buildClusterSourceLevels({ symbol, extremesByTf, cfg, now, rejected }) {
  const out = [];
  if (!(extremesByTf instanceof Map)) return out;

  for (const [tf, list] of extremesByTf) {
    if (!tfToMinutes(tf)) {
      for (const ex of list || []) {
        rejected.push({
          rejectReason: 'TF_MISSING',
          rejectStage: 'source_validation',
          sourceType: 'extreme',
          candidateLevel: toNumOrNull(ex?.price ?? ex?.points?.[0]?.value),
          candidateTf: tf || null,
          candidateSource: normalizeSource(ex?.source),
          tf: tf || null,
        });
      }
      continue;
    }
    for (const ex of list || []) {
      const side = normalizeSide(ex?.side ?? ex?.type);
      const source = normalizeSource(ex?.source);
      const levelPrice = toNumOrNull(ex?.price ?? ex?.points?.[0]?.value);
      const id = ex?.id ?? null;
      if (!side || !(levelPrice > 0)) continue;
      if (!ALLOWED_SOURCES.has(source)) continue;
      if (!id) {
        rejected.push({
          rejectReason: 'EXTREME_ID_MISSING',
          rejectStage: 'source_validation',
          sourceType: 'extreme',
          candidateLevel: levelPrice,
          candidateTf: tf,
          candidateSource: source,
          tf,
        });
        continue;
      }
      const visibleOnTestPage = typeof ex?.visibleOnTestPage === 'boolean' ? ex.visibleOnTestPage : true;
      if (!visibleOnTestPage) {
        rejected.push({
          rejectReason: 'LEVEL_NOT_VISIBLE_ON_TESTPAGE',
          rejectStage: 'visibility_filter',
          sourceType: 'extreme',
          candidateLevel: levelPrice,
          candidateTf: tf,
          candidateSource: source,
          tf,
        });
        continue;
      }

      const tolerancePct = Math.max(0.03, toNum(ex?.tolerancePct, cfg.defaultTolerancePct));
      const zoneLower = Number((levelPrice * (1 - tolerancePct / 100)).toFixed(8));
      const zoneUpper = Number((levelPrice * (1 + tolerancePct / 100)).toFixed(8));
      const pt = Array.isArray(ex?.points) ? ex.points : [];
      const firstPt = pt[0] || null;
      const lastPt = pt[pt.length - 1] || null;

      out.push({
        levelId: levelIdFor({ source, symbol, tf, type: side, price: levelPrice }),
        levelSource: source,
        levelTf: tf,
        sourceTf: tf,
        levelType: side,
        levelPrice,
        zoneLower,
        zoneUpper,
        tolerancePct,
        sourceStrength: Math.max(1, toNum(ex?.touches, 1), toNum(ex?.strength, 0)),
        isVisibleOnTestPage: true,
        levelCreatedAt: toNumOrNull(ex?.createdAt ?? ex?.updatedAt ?? firstPt?.timestamp ?? null),
        sourcePriority: SOURCE_PRIORITY[source] || 0,
        selectedLevel: null,
        extremeIds: [id],
        extremeSource: source,
        selectedExtremes: [{
          id,
          source,
          tf,
          side,
          time: toNumOrNull(lastPt?.timestamp ?? firstPt?.timestamp ?? null),
          price: Number(levelPrice.toFixed(8)),
        }],
      });
    }
  }

  return out;
}

function dedupeLevels(levels) {
  const byKey = new Map();
  for (const level of levels) {
    const key = `${level.levelTf}:${level.levelType}:${level.levelPrice.toFixed(8)}`;
    if (!byKey.has(key)) {
      byKey.set(key, level);
      continue;
    }
    const prev = byKey.get(key);
    const prevPrio = SOURCE_PRIORITY[prev.levelSource] || 0;
    const nextPrio = SOURCE_PRIORITY[level.levelSource] || 0;
    const preferred = nextPrio > prevPrio ? level : prev;
    byKey.set(key, {
      ...preferred,
      zoneLower: Math.min(prev.zoneLower, level.zoneLower),
      zoneUpper: Math.max(prev.zoneUpper, level.zoneUpper),
      sourceStrength: Math.max(prev.sourceStrength || 0, level.sourceStrength || 0),
    });
  }
  return Array.from(byKey.values());
}

function levelVisibleOnTestPage(level, catalog, cfg, frameTf) {
  if (level.levelSource === 'tracked-extremes') {
    return Array.isArray(level.extremeIds) && level.extremeIds.length > 0;
  }

  if (!level.levelId) return false;
  const sameId = catalog.find((x) => x.levelId === level.levelId);
  if (sameId) return true;

  return catalog.some((x) =>
    x.levelType === level.levelType
    && withinPct(x.levelPrice, level.levelPrice, cfg.levelMatchTolerancePct)
    && findLevelTf(frameTf, x.levelTf),
  );
}

function buildTouchesAndLineStats(level, frame, cfg) {
  const bars = frame.bars;
  const center = level.levelPrice;
  const touchZoneLower = level.zoneLower;
  const touchZoneUpper = level.zoneUpper;

  const touchesRaw = [];
  let bodyCrossCount = 0;
  let wickTouchCount = 0;
  let barsCrossedCount = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] || {};
    const low = toNumOrNull(b.low);
    const high = toNumOrNull(b.high);
    const open = toNumOrNull(b.open);
    const close = toNumOrNull(b.close);
    const ts = toNumOrNull(b.ts ?? b.timestamp ?? b.time);
    const vol = toNumOrNull(b.volume ?? b.vol ?? b.quoteVolume);
    if (!(low > 0) || !(high > 0)) continue;

    const touchesZone = high >= touchZoneLower && low <= touchZoneUpper;
    if (!touchesZone) continue;

    const bodyLo = Math.min(open ?? close ?? center, close ?? open ?? center);
    const bodyHi = Math.max(open ?? close ?? center, close ?? open ?? center);
    const bodyCross = bodyLo <= center && bodyHi >= center;

    barsCrossedCount += 1;
    if (bodyCross) bodyCrossCount += 1;
    else wickTouchCount += 1;

    let reactionPct = 0;
    const lookahead = Math.max(2, cfg.reactionLookaheadBars);
    for (let j = i + 1; j <= Math.min(bars.length - 1, i + lookahead); j++) {
      const n = bars[j] || {};
      const nh = toNumOrNull(n.high);
      const nl = toNumOrNull(n.low);
      if (level.levelType === 'SUPPORT' && nh > 0) {
        reactionPct = Math.max(reactionPct, (nh - center) / center * 100);
      }
      if (level.levelType === 'RESISTANCE' && nl > 0) {
        reactionPct = Math.max(reactionPct, (center - nl) / center * 100);
      }
    }

    touchesRaw.push({
      time: ts,
      price: Number(center.toFixed(8)),
      barIndex: i,
      reactionPct: Number(reactionPct.toFixed(4)),
      volume: vol,
      tf: frame.tf,
    });
  }

  const independentTouches = [];
  let lastIdx = -1e9;
  for (const t of touchesRaw) {
    if ((t.barIndex - lastIdx) < cfg.minBarsBetweenTouches) continue;
    independentTouches.push(t);
    lastIdx = t.barIndex;
  }

  const firstTouch = independentTouches[0] || null;
  const lastTouch = independentTouches[independentTouches.length - 1] || null;
  const spreadBars = firstTouch && lastTouch ? Math.max(0, lastTouch.barIndex - firstTouch.barIndex) : 0;
  const spreadMinutes = spreadBars * (frame.tfMinutes || 1);
  const bodyCrossRatio = barsCrossedCount > 0 ? bodyCrossCount / barsCrossedCount : 0;

  return {
    touches: independentTouches.length,
    touchPoints: Array.isArray(level.selectedExtremes)
      ? level.selectedExtremes
          .filter((x) => Number.isFinite(x.time) && Number.isFinite(x.price) && x.price > 0)
          .map((x) => ({
            time: x.time,
            price: x.price,
            type: 'TOUCH',
            source: x.source || level.levelSource,
            tf: x.tf || level.levelTf,
          }))
      : [],
    candidateTouches: independentTouches,
    independentTouches: independentTouches.length,
    touchClusterCount: touchesRaw.length,
    touchTimeSpreadBars: spreadBars,
    touchTimeSpreadMinutes: spreadMinutes,
    firstTouchTime: firstTouch?.time || null,
    lastTouchTime: lastTouch?.time || null,
    avgReactionPct: Number(avg(independentTouches.map((t) => t.reactionPct || 0)).toFixed(4)),
    maxReactionPct: Number(Math.max(0, ...independentTouches.map((t) => t.reactionPct || 0)).toFixed(4)),
    barsCrossedCount,
    cleanTouchCount: independentTouches.length,
    bodyCrossCount,
    wickTouchCount,
    bodyCrossRatio,
  };
}

function scoreBreakdown({ touches, ageMinutes, avgReactionPct, distancePct, volumeFactor, cfg }) {
  const touchScore = Math.round(Math.min(25, Math.max(0, (touches - cfg.minTouches + 1) * 8)));
  const ageScore = Math.round(Math.min(20, Math.max(0, (ageMinutes / cfg.minLevelAgeMinutes) * 20)));
  const reactionScore = Math.round(Math.min(20, Math.max(0, (avgReactionPct / cfg.reactionTargetPct) * 20)));
  const distanceScore = Math.round(Math.min(15, Math.max(0, (1 - Math.min(1, distancePct / cfg.setupDistancePct)) * 15)));
  const volumeScore = Math.round(Math.min(20, Math.max(0, (volumeFactor - 1) * 20)));
  const total = touchScore + ageScore + reactionScore + distanceScore + volumeScore;
  return { touchScore, ageScore, reactionScore, distanceScore, volumeScore, total };
}

function buildChartRange(firstTouchTime, frame, cfg, now) {
  return {
    fromTime: (firstTouchTime || now) - (cfg.paddingBars * frame.tfMs),
    toTime: now + (cfg.rightPaddingBars * frame.tfMs),
    reason: 'from_first_touch',
  };
}

function makeCandidate({ symbol, marketType, frame, level, patternType, direction, breakDirection, status, distancePct, breakdownPct, breakoutPct, volumeFactor, score, stats, cfg, now }) {
  const levelAgeMinutes = Math.max(0, (now - (stats.firstTouchTime || now)) / 60000);
  const levelAgeBars = Math.max(1, Math.round(levelAgeMinutes / frame.tfMinutes));
  const chartRange = buildChartRange(stats.firstTouchTime, frame, cfg, now);
  const setupPattern = (
    patternType === SUPPORT_BREAKDOWN_SETUP
    || patternType === RESISTANCE_BREAKOUT_SETUP
    || patternType === SUPPORT_BOUNCE
    || patternType === RESISTANCE_REJECTION
  );
  const lifecycleStatus = setupPattern
    ? 'ACTIVE_NEAR_LEVEL'
    : (patternType === SUPPORT_BREAKDOWN ? 'PROMOTED_TO_BREAKDOWN' : (patternType === RESISTANCE_BREAKOUT ? 'PROMOTED_TO_BREAKOUT' : 'ACTIVE_NEAR_LEVEL'));
  const lifecycleReason = setupPattern
    ? 'SETUP_WAITING_BREAK'
    : (patternType === SUPPORT_BREAKDOWN ? 'PROMOTED_TO_BREAKDOWN' : (patternType === RESISTANCE_BREAKOUT ? 'PROMOTED_TO_BREAKOUT' : 'SETUP_WAITING_BREAK'));

  return {
    formationId: `${symbol}_${frame.tf}_${patternType}_${Number(level.levelPrice.toFixed(8))}`,
    id: `${symbol}_${frame.tf}_${patternType}_${Number(level.levelPrice.toFixed(8))}`,
    fingerprint: `${symbol}:${marketType}:LEVEL_BASED:${frame.tf}:${patternType}:${level.levelId}`,
    symbol,
    marketType,
    tf: frame.tf,
    patternType,
    strategy: STRATEGY_KEY,
    source: level.levelSource,
    direction,
    status,
    breakDirection,
    lifecycleStatus,
    lifecycleReason,
    breakLevel: Number(level.levelPrice.toFixed(8)),
    levelId: level.levelId,
    levelSource: level.levelSource,
    levelTf: level.levelTf,
    sourceTf: level.sourceTf || level.levelTf || null,
    confluenceTf: Boolean(level.levelTf && frame.tf && level.levelTf !== frame.tf),
    debugTfReason: 'OK',
    levelType: level.levelType,
    levelPrice: Number(level.levelPrice.toFixed(8)),
    levelCreatedAt: level.levelCreatedAt || null,
    extremeIds: Array.isArray(level.extremeIds) ? level.extremeIds : [],
    extremeTf: level.levelSource === 'tracked-extremes' ? (level.levelTf || null) : null,
    extremeSource: level.extremeSource || null,
    selectedLevel: level.selectedLevel || null,
    selectedExtremes: Array.isArray(level.selectedExtremes) ? level.selectedExtremes : [],
    zoneLower: Number(level.zoneLower.toFixed(8)),
    zoneUpper: Number(level.zoneUpper.toFixed(8)),
    tolerancePct: Number(level.tolerancePct.toFixed(4)),
    isVisibleOnTestPage: true,
    visibleOnTestPage: true,

    touches: stats.touches,
    touchPoints: stats.touchPoints,
    candidateTouches: stats.candidateTouches,
    independentTouches: stats.independentTouches,
    touchClusterCount: stats.touchClusterCount,
    touchTimeSpreadBars: stats.touchTimeSpreadBars,
    touchTimeSpreadMinutes: stats.touchTimeSpreadMinutes,

    barsCrossedCount: stats.barsCrossedCount,
    cleanTouchCount: stats.cleanTouchCount,
    bodyCrossCount: stats.bodyCrossCount,
    wickTouchCount: stats.wickTouchCount,

    levelAgeBars,
    levelAgeMinutes: Math.round(levelAgeMinutes),
    firstTouchTime: stats.firstTouchTime,
    lastTouchTime: stats.lastTouchTime,

    avgReactionPct: stats.avgReactionPct,
    maxReactionPct: stats.maxReactionPct,

    distanceToLevel: Number(distancePct.toFixed(4)),
    distancePct: Number(distancePct.toFixed(4)),
    breakdownPct: Number.isFinite(breakdownPct) ? Number(breakdownPct.toFixed(4)) : null,
    breakoutPct: Number.isFinite(breakoutPct) ? Number(breakoutPct.toFixed(4)) : null,

    score: score.total,
    scoreBreakdown: {
      touchScore: score.touchScore,
      ageScore: score.ageScore,
      reactionScore: score.reactionScore,
      distanceScore: score.distanceScore,
      volumeScore: score.volumeScore,
      total: score.total,
    },

    volumeFactor: Number(volumeFactor.toFixed(4)),
    chartRange,

    supportLevel: level.levelType === 'SUPPORT' ? Number(level.levelPrice.toFixed(8)) : null,
    supportSource: level.levelType === 'SUPPORT' ? level.levelSource : null,
    resistanceLevel: level.levelType === 'RESISTANCE' ? Number(level.levelPrice.toFixed(8)) : null,
    resistanceSource: level.levelType === 'RESISTANCE' ? level.levelSource : null,

    levels: {
      supportLevel: level.levelType === 'SUPPORT' ? Number(level.levelPrice.toFixed(8)) : null,
      supportSource: level.levelType === 'SUPPORT' ? level.levelSource : null,
      resistanceLevel: level.levelType === 'RESISTANCE' ? Number(level.levelPrice.toFixed(8)) : null,
      resistanceSource: level.levelType === 'RESISTANCE' ? level.levelSource : null,
      breakoutLevel: Number(level.levelPrice.toFixed(8)),
      supportZone: level.levelType === 'SUPPORT' ? { centerPrice: level.levelPrice, lowerBound: level.zoneLower, upperBound: level.zoneUpper } : null,
      resistanceZone: level.levelType === 'RESISTANCE' ? { centerPrice: level.levelPrice, lowerBound: level.zoneLower, upperBound: level.zoneUpper } : null,
    },

    metrics: {
      levelId: level.levelId,
      levelSource: level.levelSource,
      levelTf: level.levelTf,
      sourceTf: level.sourceTf || level.levelTf || null,
      confluenceTf: Boolean(level.levelTf && frame.tf && level.levelTf !== frame.tf),
      levelType: level.levelType,
      levelPrice: Number(level.levelPrice.toFixed(8)),
      levelCreatedAt: level.levelCreatedAt || null,
      extremeIds: Array.isArray(level.extremeIds) ? level.extremeIds : [],
      extremeTf: level.levelSource === 'tracked-extremes' ? (level.levelTf || null) : null,
      extremeSource: level.extremeSource || null,
      zoneLower: Number(level.zoneLower.toFixed(8)),
      zoneUpper: Number(level.zoneUpper.toFixed(8)),
      touches: stats.touches,
      touchPoints: stats.touchPoints,
      candidateTouches: stats.candidateTouches,
      independentTouches: stats.independentTouches,
      touchClusterCount: stats.touchClusterCount,
      touchTimeSpreadBars: stats.touchTimeSpreadBars,
      touchTimeSpreadMinutes: stats.touchTimeSpreadMinutes,
      barsCrossedCount: stats.barsCrossedCount,
      cleanTouchCount: stats.cleanTouchCount,
      bodyCrossCount: stats.bodyCrossCount,
      wickTouchCount: stats.wickTouchCount,
      levelAgeBars,
      levelAgeMinutes: Math.round(levelAgeMinutes),
      firstTouchTime: stats.firstTouchTime,
      lastTouchTime: stats.lastTouchTime,
      avgReactionPct: stats.avgReactionPct,
      maxReactionPct: stats.maxReactionPct,
      distanceToLevel: Number(distancePct.toFixed(4)),
      volumeFactor: Number(volumeFactor.toFixed(4)),
      breakDirection,
      scoreBreakdown: {
        touchScore: score.touchScore,
        ageScore: score.ageScore,
        reactionScore: score.reactionScore,
        distanceScore: score.distanceScore,
        volumeScore: score.volumeScore,
        total: score.total,
      },
      chartRange,
      isVisibleOnTestPage: true,
      visibleOnTestPage: true,
      selectedLevel: level.selectedLevel || null,
      selectedExtremes: Array.isArray(level.selectedExtremes) ? level.selectedExtremes : [],
    },

    debug: {
      levelId: level.levelId,
      levelSource: level.levelSource,
      levelTf: level.levelTf,
      sourceTf: level.sourceTf || level.levelTf || null,
      confluenceTf: Boolean(level.levelTf && frame.tf && level.levelTf !== frame.tf),
      levelType: level.levelType,
      levelPrice: Number(level.levelPrice.toFixed(8)),
      levelCreatedAt: level.levelCreatedAt || null,
      extremeIds: Array.isArray(level.extremeIds) ? level.extremeIds : [],
      extremeTf: level.levelSource === 'tracked-extremes' ? (level.levelTf || null) : null,
      extremeSource: level.extremeSource || null,
      zoneLower: Number(level.zoneLower.toFixed(8)),
      zoneUpper: Number(level.zoneUpper.toFixed(8)),
      touches: stats.touches,
      touchPoints: stats.touchPoints,
      candidateTouches: stats.candidateTouches,
      independentTouches: stats.independentTouches,
      touchClusterCount: stats.touchClusterCount,
      touchTimeSpreadBars: stats.touchTimeSpreadBars,
      touchTimeSpreadMinutes: stats.touchTimeSpreadMinutes,
      barsCrossedCount: stats.barsCrossedCount,
      cleanTouchCount: stats.cleanTouchCount,
      bodyCrossCount: stats.bodyCrossCount,
      wickTouchCount: stats.wickTouchCount,
      levelAgeBars,
      levelAgeMinutes: Math.round(levelAgeMinutes),
      firstTouchTime: stats.firstTouchTime,
      lastTouchTime: stats.lastTouchTime,
      avgReactionPct: stats.avgReactionPct,
      maxReactionPct: stats.maxReactionPct,
      distanceToLevel: Number(distancePct.toFixed(4)),
      volumeFactor: Number(volumeFactor.toFixed(4)),
      breakDirection,
      chartRange,
      isVisibleOnTestPage: true,
      visibleOnTestPage: true,
      selectedLevel: level.selectedLevel || null,
      selectedExtremes: Array.isArray(level.selectedExtremes) ? level.selectedExtremes : [],
      whySelected: [
        `patternType=${patternType}`,
        `levelId=${level.levelId}`,
        `source=${level.levelSource}`,
        `touches=${stats.touches}`,
        `distancePct=${Number(distancePct.toFixed(4))}`,
        `score=${score.total}`,
      ],
    },
  };
}

function evaluate({ symbol, marketType, tfBars, storedLevels, extremesByTf, currentPrice, cfg: rawCfg, marketMetrics }) {
  const cfg = {
    enabled: true,
    setupDistancePct: 3.0,
    breakThresholdPct: 0.2,
    confirmBars: 1,

    minTouches: 3,
    minBarsBetweenTouches: 10,
    minLevelAgeMinutes: 30,
    minReactionPct: 0.2,
    reactionTargetPct: 3.0,

    maxBodyCrossRatio: 0.25,

    minBreakVolumeFactor: 1.1,
    maxBreakdownPct: 12.0,
    maxBreakoutPct: 12.0,
    minScore: 35,
    maxResults: 8,

    defaultTolerancePct: 0.35,
    levelMatchTolerancePct: 0.5,
    extremeClusterTolerancePct: 0.6,
    minClusterCount: 3,
    minClusterAgeBars: 30,

    reactionLookaheadBars: 12,
    maxStalenessMinutes: 24 * 60,

    paddingBars: 20,
    rightPaddingBars: 8,
    historyBarsByTf: { ...DEFAULT_HISTORY_BARS },
    maxPatternAgeHours: 8,

    ...(rawCfg || {}),
  };

  const candidates = [];
  const rejected = [];
  const byTfStats = {};

  const longRejectedReasons = {};
  const shortRejectedReasons = {};
  let totalLongCandidates = 0;
  let totalShortCandidates = 0;

  if (!cfg.enabled || !(toNumOrNull(currentPrice) > 0)) {
    return { candidates, debugLog: [{ kind: 'summary', reason: 'DISABLED_OR_NO_PRICE' }] };
  }

  const now = Date.now();
  const tfBarsCount = new Map();
  if (tfBars instanceof Map) {
    for (const [tf, barsRaw] of tfBars) {
      tfBarsCount.set(tf, Array.isArray(barsRaw) ? barsRaw.length : 0);
    }
  }
  const frames = buildFrameList(tfBars, cfg.historyBarsByTf);
  const frameByTf = new Map(frames.map((f) => [f.tf, f]));
  const candlesReadinessByTf = Object.fromEntries(
    REQUIRED_TFS.map((tf) => {
      const loaded = tfBarsCount.get(tf) ?? 0;
      return [tf, { tf, loaded, required: MIN_FRAME_BARS, ready: loaded >= MIN_FRAME_BARS }];
    }),
  );

  for (const tf of REQUIRED_TFS) {
    byTfStats[tf] = {
      tf,
      levelsFound: 0,
      extremesFound: 0,
      validLevels: 0,
      validClusters: 0,
      candidatesCreated: 0,
      rejectReasons: {},
    };
  }

  const bumpTfReject = (tf, reason) => {
    if (!byTfStats[tf]) {
      byTfStats[tf] = {
        tf,
        levelsFound: 0,
        extremesFound: 0,
        validLevels: 0,
        validClusters: 0,
        candidatesCreated: 0,
        rejectReasons: {},
      };
    }
    byTfStats[tf].rejectReasons[reason] = (byTfStats[tf].rejectReasons[reason] || 0) + 1;
  };

  for (const [tf, list] of (extremesByTf instanceof Map ? extremesByTf : new Map())) {
    if (!byTfStats[tf]) continue;
    byTfStats[tf].extremesFound = Array.isArray(list) ? list.length : 0;
  }

  const rejectedSourceLevels = [];
  const sourceLevels = buildStoredSourceLevels({ symbol, storedLevels, cfg, rejected: rejectedSourceLevels });
  const clusterLevels = buildClusterSourceLevels({ symbol, extremesByTf, cfg, now, rejected: rejectedSourceLevels });
  const catalog = dedupeLevels([...sourceLevels, ...clusterLevels]);

  for (const r of rejectedSourceLevels) {
    rejected.push(r);
    if (r.tf) bumpTfReject(r.tf, r.rejectReason || 'REJECTED_SOURCE');
  }

  for (const level of catalog) {
    if (byTfStats[level.levelTf]) {
      byTfStats[level.levelTf].levelsFound += 1;
      if (level.levelSource === 'tracked-extremes') byTfStats[level.levelTf].validClusters += 1;
    }
  }

  if (!frames.length) {
    for (const tf of REQUIRED_TFS) {
      const barsCount = tfBarsCount.get(tf) ?? 0;
      bumpTfReject(tf, barsCount > 0 ? 'CANDLES_NOT_AVAILABLE' : 'TF_NOT_ANALYZED');
      if (barsCount > 0 && barsCount < MIN_FRAME_BARS) {
        rejected.push({
          rejectReason: 'CANDLES_NOT_AVAILABLE',
          tf,
          loaded: barsCount,
          required: MIN_FRAME_BARS,
        });
      }
    }
    return {
      candidates,
      debugLog: [
        ...rejected,
        {
          kind: 'summary',
          totalLongCandidates: 0,
          totalShortCandidates: 0,
          longRejectedReasons,
          shortRejectedReasons,
          levelsFoundByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.levelsFound])),
          validLevelsByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.validLevels])),
          candidatesByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.candidatesCreated])),
          rejectedByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.rejectReasons])),
          candlesReadinessByTf,
          perTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v])),
          warning: 'NO_TF_BARS',
        },
      ],
    };
  }

  const ttlSec = Math.ceil(cfg.maxPatternAgeHours * 3600);
  const volumeFactor = getVolumeFactor(marketMetrics || {});

  for (const tf of REQUIRED_TFS) {
    if (!frameByTf.has(tf)) {
      const barsCount = tfBarsCount.get(tf) ?? 0;
      bumpTfReject(tf, barsCount > 0 ? 'CANDLES_NOT_AVAILABLE' : 'TF_NOT_ANALYZED');
      if (barsCount > 0 && barsCount < MIN_FRAME_BARS) {
        rejected.push({
          rejectReason: 'CANDLES_NOT_AVAILABLE',
          tf,
          loaded: barsCount,
          required: MIN_FRAME_BARS,
        });
      }
    }
    if (byTfStats[tf].levelsFound === 0) bumpTfReject(tf, 'LEVEL_NOT_FOUND_ON_TF');
    if (byTfStats[tf].extremesFound === 0) bumpTfReject(tf, 'EXTREME_NOT_FOUND_ON_TF');
  }

  for (const frame of frames) {
    const tf = frame.tf;
    if (!byTfStats[tf]) continue;

    for (const level of catalog) {
      if (!findLevelTf(tf, level.levelTf)) continue;

      if (!levelVisibleOnTestPage(level, catalog, cfg, tf)) {
        bumpTfReject(tf, 'LEVEL_NOT_VISIBLE_ON_TESTPAGE');
        rejected.push({ rejectReason: 'LEVEL_NOT_VISIBLE_ON_TESTPAGE', tf, levelId: level.levelId });
        continue;
      }

      const levelTs = toNumOrNull(level.sourcePayload?.formationTimestamp ?? level.sourcePayload?.updatedAt ?? null);
      if (levelTs && (now - levelTs) > (cfg.maxStalenessMinutes * 60000)) {
        bumpTfReject(tf, 'LEVEL_TOO_OLD');
        rejected.push({ rejectReason: 'LEVEL_TOO_OLD', tf, levelId: level.levelId, ageMinutes: Math.round((now - levelTs) / 60000) });
        continue;
      }

      const stats = buildTouchesAndLineStats(level, frame, cfg);

      if (stats.independentTouches < cfg.minTouches) {
        bumpTfReject(tf, 'NOT_ENOUGH_TOUCHES');
        rejected.push({ rejectReason: 'NOT_ENOUGH_TOUCHES', tf, levelId: level.levelId, independentTouches: stats.independentTouches });
        continue;
      }

      if (stats.touchTimeSpreadBars < cfg.minBarsBetweenTouches) {
        bumpTfReject(tf, 'TOUCHES_NOT_INDEPENDENT');
        rejected.push({ rejectReason: 'TOUCHES_NOT_INDEPENDENT', tf, levelId: level.levelId, touchTimeSpreadBars: stats.touchTimeSpreadBars });
        continue;
      }

      if (stats.bodyCrossRatio > cfg.maxBodyCrossRatio) {
        bumpTfReject(tf, 'LEVEL_CROSSES_TOO_MANY_BODIES');
        rejected.push({ rejectReason: 'LEVEL_CROSSES_TOO_MANY_BODIES', tf, levelId: level.levelId, bodyCrossRatio: Number(stats.bodyCrossRatio.toFixed(4)) });
        continue;
      }

      const ageMinutes = stats.firstTouchTime ? Math.max(0, (now - stats.firstTouchTime) / 60000) : 0;
      if (ageMinutes < cfg.minLevelAgeMinutes) {
        bumpTfReject(tf, 'LEVEL_TOO_NEW');
        rejected.push({ rejectReason: 'LEVEL_TOO_NEW', tf, levelId: level.levelId, levelAgeMinutes: Math.round(ageMinutes) });
        continue;
      }

      if (!level.levelId && !(Array.isArray(level.extremeIds) && level.extremeIds.length > 0)) {
        bumpTfReject(tf, 'MISSING_LEVEL_OR_EXTREME_LINK');
        rejected.push({ rejectReason: 'MISSING_LEVEL_OR_EXTREME_LINK', tf, levelId: null });
        continue;
      }

      byTfStats[tf].validLevels += 1;

      const distPctAbs = Math.abs((currentPrice - level.levelPrice) / level.levelPrice * 100);
      if (distPctAbs > cfg.setupDistancePct) {
        bumpTfReject(tf, 'LEVEL_TOO_FAR');
        rejected.push({ rejectReason: 'LEVEL_TOO_FAR', tf, levelId: level.levelId, distancePct: Number(distPctAbs.toFixed(4)) });
        continue;
      }
      const breakdownPct = (level.zoneLower - currentPrice) / level.zoneLower * 100;
      const breakoutPct = (currentPrice - level.zoneUpper) / level.zoneUpper * 100;

      const score = scoreBreakdown({
        touches: stats.independentTouches,
        ageMinutes,
        avgReactionPct: stats.avgReactionPct,
        distancePct: distPctAbs,
        volumeFactor,
        cfg,
      });

      const emit = (data) => {
        if (data.direction === DIR_LONG) totalLongCandidates += 1;
        else totalShortCandidates += 1;
        byTfStats[tf].candidatesCreated += 1;
        candidates.push(data);
      };

      const beforeCandidates = byTfStats[tf].candidatesCreated;

      if (level.levelType === 'SUPPORT') {
        if (currentPrice >= level.zoneLower && currentPrice >= level.levelPrice && distPctAbs <= cfg.setupDistancePct && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: SUPPORT_BREAKDOWN_SETUP,
            direction: DIR_SHORT,
            breakDirection: 'DOWN',
            status: 'APPROACHING',
            distancePct: distPctAbs,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        } else {
          shortRejectedReasons.NOT_IN_SETUP_CONDITION = (shortRejectedReasons.NOT_IN_SETUP_CONDITION || 0) + 1;
        }

        if (currentPrice < level.zoneLower && breakdownPct >= cfg.breakThresholdPct && breakdownPct <= cfg.maxBreakdownPct && volumeFactor >= cfg.minBreakVolumeFactor && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: SUPPORT_BREAKDOWN,
            direction: DIR_SHORT,
            breakDirection: 'DOWN',
            status: breakdownPct >= 1.2 ? 'CONFIRMED' : 'BREAKDOWN',
            distancePct: distPctAbs,
            breakdownPct,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        }

        if (currentPrice > level.zoneUpper && distPctAbs <= cfg.setupDistancePct && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: SUPPORT_BOUNCE,
            direction: DIR_LONG,
            breakDirection: 'UP',
            status: 'APPROACHING',
            distancePct: distPctAbs,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        } else {
          longRejectedReasons.NOT_IN_BOUNCE_CONDITION = (longRejectedReasons.NOT_IN_BOUNCE_CONDITION || 0) + 1;
        }
      } else {
        if (currentPrice <= level.zoneUpper && currentPrice <= level.levelPrice && distPctAbs <= cfg.setupDistancePct && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: RESISTANCE_BREAKOUT_SETUP,
            direction: DIR_LONG,
            breakDirection: 'UP',
            status: 'APPROACHING',
            distancePct: distPctAbs,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        } else {
          longRejectedReasons.NOT_IN_SETUP_CONDITION = (longRejectedReasons.NOT_IN_SETUP_CONDITION || 0) + 1;
        }

        if (currentPrice > level.zoneUpper && breakoutPct >= cfg.breakThresholdPct && breakoutPct <= cfg.maxBreakoutPct && volumeFactor >= cfg.minBreakVolumeFactor && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: RESISTANCE_BREAKOUT,
            direction: DIR_LONG,
            breakDirection: 'UP',
            status: breakoutPct >= 1.2 ? 'CONFIRMED' : 'BREAKOUT',
            distancePct: distPctAbs,
            breakoutPct,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        }

        if (currentPrice < level.zoneLower && distPctAbs <= cfg.setupDistancePct && score.total >= cfg.minScore) {
          emit(makeCandidate({
            symbol,
            marketType,
            frame,
            level,
            patternType: RESISTANCE_REJECTION,
            direction: DIR_SHORT,
            breakDirection: 'DOWN',
            status: 'APPROACHING',
            distancePct: distPctAbs,
            volumeFactor,
            score,
            stats,
            cfg,
            now,
            ttlSec,
          }));
        } else {
          shortRejectedReasons.NOT_IN_REJECTION_CONDITION = (shortRejectedReasons.NOT_IN_REJECTION_CONDITION || 0) + 1;
        }
      }

      if (byTfStats[tf].candidatesCreated === beforeCandidates) {
        bumpTfReject(tf, 'DIRECTION_NOT_MATCHED');
      }
    }
  }

  const shortBias = (totalLongCandidates + totalShortCandidates) > 0
    ? totalShortCandidates / (totalLongCandidates + totalShortCandidates)
    : 0;

  candidates.sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    const priority = {
      SUPPORT_BREAKDOWN: 5,
      RESISTANCE_BREAKOUT: 5,
      SUPPORT_BREAKDOWN_SETUP: 3,
      RESISTANCE_BREAKOUT_SETUP: 3,
      SUPPORT_BOUNCE: 2,
      RESISTANCE_REJECTION: 2,
    };
    return (priority[b.patternType] || 0) - (priority[a.patternType] || 0);
  });

  return {
    candidates: candidates.slice(0, cfg.maxResults),
    debugLog: [
      ...rejected,
      {
        kind: 'summary',
        totalLongCandidates,
        totalShortCandidates,
        longRejectedReasons,
        shortRejectedReasons,
        levelsFoundByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.levelsFound])),
        validLevelsByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.validLevels])),
        candidatesByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.candidatesCreated])),
        rejectedByTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v.rejectReasons])),
        candlesReadinessByTf,
        perTf: Object.fromEntries(Object.entries(byTfStats).map(([k, v]) => [k, v])),
        warning: shortBias > 0.8 ? 'DIRECTION_BIAS_SHORT' : null,
      },
    ],
  };
}

module.exports = { key: STRATEGY_KEY, evaluate };
