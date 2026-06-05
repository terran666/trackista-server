'use strict';

/**
 * extremeFormationsStrategy.js вЂ” Extreme-based formation detection.
 *
 * Reads tracked-extremes (source: extremes | tracked-extremes |
 * vertical-extremes | sharp-extremes) and creates formations when
 * current price is within setupDistancePct % of a HIGH or LOW extreme.
 *
 * Pattern types produced:
 *   HIGH extreme в†’ RESISTANCE_REJECTION      (direction: SHORT)
 *                  RESISTANCE_BREAKOUT_SETUP  (direction: LONG)
 *   LOW  extreme в†’ SUPPORT_BOUNCE             (direction: LONG)
 *                  SUPPORT_BREAKDOWN_SETUP    (direction: SHORT)
 *
 * Reject reasons:
 *   EXTREME_ID_MISSING
 *   EXTREME_SOURCE_MISSING
 *   EXTREME_TF_MISSING
 *   EXTREME_NOT_VISIBLE_ON_TESTPAGE
 *   EXTREME_TYPE_INVALID
 *   EXTREME_PRICE_INVALID
 *   EXTREME_ALREADY_BROKEN
 *   PRICE_TOO_FAR
 *
 * @module extremeFormationsStrategy
 */

const ALLOWED_TFS = new Set(['1m', '5m', '15m', '30m', '1h', '4h']);

const ALLOWED_SOURCES = new Set([
  'extremes',
  'tracked-extremes',
  'vertical-extremes',
  'sharp-extremes',
]);

// Score boost by tf вЂ” higher timeframe extremes carry more weight.
const TF_SCORE_BONUS = { '1m': 0, '5m': 2, '15m': 4, '30m': 6, '1h': 8, '4h': 10 };

// в”Ђв”Ђв”Ђ Price extractor в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Extract extreme price from a raw extreme record.
 * Supports all known field layouts from tracked-extremes storage:
 *   price, extremePrice, levelPrice, y, value, points[last].value
 *
 * @param {object} ext
 * @returns {number|null} valid positive price or null
 */
function getExtremePrice(ext) {
  // Try direct scalar fields first
  for (const field of ['price', 'extremePrice', 'levelPrice', 'y', 'value']) {
    const v = Number(ext[field]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  // Fall back to last point value (vertical-extremes store multi-point records)
  if (Array.isArray(ext.points) && ext.points.length) {
    const lastPt = ext.points[ext.points.length - 1];
    const v = Number(lastPt?.value ?? lastPt?.price ?? lastPt?.y ?? NaN);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * Extract the timestamp of the extreme's first-touch bar.
 * Used to locate the bar index in the bars series and validate visibility.
 *
 * @param {object} ext
 * @returns {number|null}
 */
function getExtremeTime(ext) {
  if (Array.isArray(ext.points) && ext.points.length) {
    // Use the LAST point — that is the most recent touch, most likely to be
    // within the stored bar window for chart drawing.
    const last = ext.points[ext.points.length - 1];
    const ts = Number(last.timestamp ?? last.ts ?? last.time ?? NaN);
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  const ts = Number(ext.createdAt ?? NaN);
  if (Number.isFinite(ts) && ts > 0) return ts;
  return null;
}

// в”Ђв”Ђв”Ђ Type normalizer в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Normalize raw side/type/extremeType fields to 'HIGH' | 'LOW' | null.
 */
function normalizeExtremeType(ext) {
  const raw = String(
    ext.side || ext.type || ext.extremeType || ext.direction || '',
  ).toLowerCase().trim();
  if (raw === 'resistance' || raw === 'high') return 'HIGH';
  if (raw === 'support'    || raw === 'low')  return 'LOW';
  return null;
}

/**
 * Evaluate a list of extremes against the current price and return
 * formation candidates and rejection log.
 *
 * @param {object[]} extremes вЂ” raw extreme records from trackedExtremesStore
 * @param {number}   currentPrice
 * @param {object}   [cfg] вЂ” extremeFormations config block
 * @returns {{ candidates: object[], rejected: object[] }}
 */
function runExtremeFormations(extremes, currentPrice, cfg) {
  cfg = cfg || {};
  const setupDistancePct     = Number(cfg.setupDistancePct)     > 0 ? Number(cfg.setupDistancePct)     : 3.0;
  const breakThresholdPct    = Number(cfg.breakThresholdPct)    > 0 ? Number(cfg.breakThresholdPct)    : 0.2;

  const candidates = [];
  const rejected   = [];

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { candidates, rejected };
  }

  for (const ext of (extremes || [])) {
    const extremeId  = ext.id ?? null;
    const extremeIds = Array.isArray(ext.extremeIds)
      ? ext.extremeIds
      : (extremeId != null ? [extremeId] : []);

    // в”Ђв”Ђ 1. extremeId в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    if (extremeId == null && extremeIds.length === 0) {
      rejected.push({ extremeId: null, reason: 'EXTREME_ID_MISSING' });
      continue;
    }

    // в”Ђв”Ђ 2. extremeSource в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const extremeSource = String(ext.source || ext.extremeSource || '').toLowerCase().trim();
    if (!extremeSource || !ALLOWED_SOURCES.has(extremeSource)) {
      rejected.push({
        extremeId,
        reason: 'EXTREME_SOURCE_MISSING',
        source: extremeSource || null,
        rawExtreme: { price: ext.price ?? null, levelPrice: ext.levelPrice ?? null },
      });
      continue;
    }

    // в”Ђв”Ђ 3. tf в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const tf = String(ext.tf || ext.timeframe || '').trim();
    if (!tf || !ALLOWED_TFS.has(tf)) {
      rejected.push({
        extremeId,
        reason: 'EXTREME_TF_MISSING',
        tf: tf || null,
        rawExtreme: { price: ext.price ?? null, levelPrice: ext.levelPrice ?? null },
      });
      continue;
    }

    // в”Ђв”Ђ 4. visibleOnTestPage в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const visibleOnTestPage = ext.visibleOnTestPage !== false;
    if (!visibleOnTestPage) {
      rejected.push({ extremeId, reason: 'EXTREME_NOT_VISIBLE_ON_TESTPAGE' });
      continue;
    }

    // в”Ђв”Ђ 5. extremePrice (must be a finite positive number) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const extremePrice = getExtremePrice(ext);
    if (extremePrice === null) {
      rejected.push({
        extremeId,
        symbol: ext.symbol || null,
        tf,
        source: extremeSource,
        reason: 'EXTREME_PRICE_INVALID',
        rawExtreme: {
          price:      ext.price      ?? null,
          levelPrice: ext.levelPrice ?? null,
          y:          ext.y          ?? null,
          value:      ext.value      ?? null,
          pointsLen:  Array.isArray(ext.points) ? ext.points.length : 0,
        },
      });
      continue;
    }

    // в”Ђв”Ђ 6. extremeType в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const extremeType = normalizeExtremeType(ext);
    if (!extremeType) {
      rejected.push({
        extremeId,
        reason: 'EXTREME_TYPE_INVALID',
        side: ext.side ?? null,
        type: ext.type ?? null,
        rawExtreme: { price: extremePrice, levelPrice: ext.levelPrice ?? null },
      });
      continue;
    }

    // в”Ђв”Ђ 7. Distance gate в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const distancePct = Math.abs(currentPrice - extremePrice) / extremePrice * 100;
    if (distancePct > setupDistancePct) {
      rejected.push({ extremeId, reason: 'PRICE_TOO_FAR', distancePct: +distancePct.toFixed(4) });
      continue;
    }

    // в”Ђв”Ђ 8. Broken extreme check в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    if (extremeType === 'LOW') {
      const breakLevel = extremePrice * (1 - breakThresholdPct / 100);
      if (currentPrice < breakLevel) {
        rejected.push({ extremeId, reason: 'SUPPORT_EXTREME_BROKEN', extremeType, breakLevel });
        continue;
      }
    } else {
      const breakLevel = extremePrice * (1 + breakThresholdPct / 100);
      if (currentPrice > breakLevel) {
        rejected.push({ extremeId, reason: 'RESISTANCE_EXTREME_BROKEN', extremeType, breakLevel });
        continue;
      }
    }

    // в”Ђв”Ђ Build candidates в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    const symbol     = String(ext.symbol || '').toUpperCase();
    const marketType = String(ext.marketType || 'futures').toLowerCase();
    const score      = _computeScore(ext, distancePct, setupDistancePct);

    const sharedFields = {
      symbol, marketType, tf, extremeId, extremeIds,
      extremeSource, extremePrice, extremeType, visibleOnTestPage,
      extremeTime: getExtremeTime(ext),
      currentPrice, distancePct: +distancePct.toFixed(4),
      score, ext,
    };

    if (extremeType === 'LOW') {
      candidates.push(_buildCandidate({ ...sharedFields, patternType: 'SUPPORT_BOUNCE',          direction: 'LONG'  }));
      candidates.push(_buildCandidate({ ...sharedFields, patternType: 'SUPPORT_BREAKDOWN_SETUP', direction: 'SHORT' }));
    } else {
      candidates.push(_buildCandidate({ ...sharedFields, patternType: 'RESISTANCE_REJECTION',      direction: 'SHORT' }));
      candidates.push(_buildCandidate({ ...sharedFields, patternType: 'RESISTANCE_BREAKOUT_SETUP', direction: 'LONG'  }));
    }
  }

  return { candidates, rejected };
}

// в”Ђв”Ђв”Ђ Helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

function _computeScore(ext, distancePct, setupDistancePct) {
  const proximity     = Math.max(0, 1 - distancePct / setupDistancePct);
  const base          = Math.round(proximity * 60);
  const strengthBonus = Math.min(20, Math.round((Number(ext.strength) || Number(ext.score) || 0) / 5));
  const touchBonus    = Math.min(10, (Number(ext.touches) || 1) * 3);
  const tfBonus       = TF_SCORE_BONUS[String(ext.tf || '')] || 0;
  return Math.min(100, base + strengthBonus + touchBonus + tfBonus);
}

function _buildCandidate({
  symbol, marketType, tf, extremeId, extremeIds,
  extremeSource, extremePrice, extremeType, extremeTime,
  patternType, direction,
  currentPrice, distancePct, visibleOnTestPage,
  score, ext,
}) {
  const now    = Date.now();
  const idKey  = extremeId != null
    ? String(extremeId)
    : (extremeIds.length ? extremeIds.join(',') : extremePrice.toFixed(8));
  const id          = `${symbol}_${tf}_${patternType}_${idKey}`;
  const fingerprint = `${symbol}:${marketType}:EXTREME:${tf}:${patternType}:${idKey}`;

  return {
    id,
    fingerprint,
    symbol,
    marketType,
    tf,
    patternType,
    strategy:   'extremeBased',
    direction,
    status:     'ACTIVE',

    // Extreme metadata вЂ” all required per TZ
    extremeId,
    extremeIds,
    extremeSource,
    extremeTf:        tf,
    extremePrice,           // guaranteed > 0 by runExtremeFormations()
    extremeType,            // 'HIGH' | 'LOW'
    extremeTime,            // bar timestamp of the extreme's first touch (ms)
    extremeBarIndex: null,  // filled by formationScalpingService after bar lookup
    visibleOnTestPage,      // true

    // Price snapshot
    currentPrice,
    distancePct,
    score,
    probability: score,

    // Level compat fields (used by formationLifecycle + view)
    levelPrice:  extremePrice,
    levelSource: extremeSource,
    levelTf:     tf,

    // Reason list (required by store validation)
    reason: [`EXTREME_${extremeType}_NEAR_PRICE`],

    // Store housekeeping
    createdAt:  now,
    updatedAt:  now,

    // Raw extreme snapshot for debug
    _extremeRaw: {
      id:        ext.id,
      touches:   ext.touches,
      strength:  ext.strength,
      createdAt: ext.createdAt,
    },
  };
}

/**
 * Evaluate the lifecycle of an already-stored extreme-based formation.
 * Returns { action: 'remove', lifecycleReason } or { action: 'none' }.
 *
 * @param {object} formation вЂ” stored formation with strategy='extremeBased'
 * @param {number} currentPrice
 * @param {Map}    extremesByTf вЂ” Map<tf, extreme[]> for this symbol
 * @param {object} cfg вЂ” extremeFormations config block
 */
function evaluateExtremeLifecycle(formation, currentPrice, extremesByTf, cfg) {
  cfg = cfg || {};
  const breakThresholdPct    = Number(cfg.breakThresholdPct)    > 0 ? Number(cfg.breakThresholdPct)    : 0.2;
  const maxActiveDistancePct = Number(cfg.maxActiveDistancePct) > 0 ? Number(cfg.maxActiveDistancePct) : 5.0;

  // в”Ђв”Ђ Guard: extremePrice must be valid в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  const extremePrice = Number(formation.extremePrice);
  if (!Number.isFinite(extremePrice) || extremePrice <= 0) {
    return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'REMOVED_EXTREME_PRICE_INVALID' };
  }

  const rawExtType  = String(formation.extremeType || '').toUpperCase();
  const extremeType =
    (rawExtType === 'HIGH' || rawExtType === 'RESISTANCE') ? 'HIGH'
    : (rawExtType === 'LOW'  || rawExtType === 'SUPPORT')   ? 'LOW'
    : null;

  const extremeId = formation.extremeId;

  // в”Ђв”Ђ Extreme still exists and visible on TestPage в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  if (extremeId != null && extremesByTf) {
    let found = false;
    for (const exts of extremesByTf.values()) {
      const match = exts.find(e => e.id === extremeId || String(e.id) === String(extremeId));
      if (match) {
        if (match.visibleOnTestPage === false) {
          return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'EXTREME_NOT_VISIBLE_ON_TESTPAGE' };
        }
        found = true;
        break;
      }
    }
    if (!found) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'EXTREME_DELETED_FROM_TESTPAGE' };
    }
  }

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { action: 'none' };

  // в”Ђв”Ђ Broken extreme check в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  if (extremeType === 'LOW') {
    const breakLevel = extremePrice * (1 - breakThresholdPct / 100);
    if (currentPrice < breakLevel) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'SUPPORT_EXTREME_BROKEN' };
    }
  } else if (extremeType === 'HIGH') {
    const breakLevel = extremePrice * (1 + breakThresholdPct / 100);
    if (currentPrice > breakLevel) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'RESISTANCE_EXTREME_BROKEN' };
    }
  }

  // в”Ђв”Ђ Price drifted too far в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  const distancePct = Math.abs(currentPrice - extremePrice) / extremePrice * 100;
  if (distancePct > maxActiveDistancePct) {
    return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'PRICE_TOO_FAR' };
  }

  return { action: 'none', distancePct: +distancePct.toFixed(4) };
}

module.exports = { runExtremeFormations, evaluateExtremeLifecycle, getExtremePrice, getExtremeTime, normalizeExtremeType, ALLOWED_TFS, ALLOWED_SOURCES };
