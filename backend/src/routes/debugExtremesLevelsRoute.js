'use strict';

const { getAll: getTrackedExtremes } = require('../services/trackedExtremesStore');
const { getAll: getTrackedLevels } = require('../services/trackedLevelsStore');
const { getAll: getManualLevels } = require('../services/manualLevelsStore');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickExtremeTime(extreme) {
  const points = Array.isArray(extreme?.points) ? extreme.points : [];
  if (!points.length) return null;
  const p0 = points[0] || {};
  const p1 = points[points.length - 1] || {};
  const t0 = toNum(p0.timestamp);
  const t1 = toNum(p1.timestamp);
  return t1 || t0 || null;
}

function buildExtremesQuality(extremes) {
  const invalidReasons = {
    price: 0,
    time: 0,
    type: 0,
    source: 0,
  };
  const invalidItems = [];

  for (const ex of extremes) {
    const reasons = [];
    const price = toNum(ex?.price);
    if (!(price > 0)) {
      invalidReasons.price += 1;
      reasons.push('price');
    }

    const t = pickExtremeTime(ex);
    if (!(toNum(t) > 0)) {
      invalidReasons.time += 1;
      reasons.push('time');
    }

    if (!ex?.type) {
      invalidReasons.type += 1;
      reasons.push('type');
    }

    if (!ex?.source) {
      invalidReasons.source += 1;
      reasons.push('source');
    }

    if (reasons.length) {
      invalidItems.push({ id: ex?.id ?? null, reasons });
    }
  }

  const total = extremes.length;
  const invalid = invalidItems.length;
  return {
    total,
    valid: Math.max(0, total - invalid),
    invalid,
    invalidReasons,
    invalidItems,
  };
}

function buildTrackedLevelsQuality(levels) {
  const invalidReasons = {
    price: 0,
    touches: 0,
    strength: 0,
    type: 0,
  };
  const invalidItems = [];

  for (const lvl of levels) {
    const reasons = [];
    const price = toNum(lvl?.price);
    const touches = toNum(lvl?.touches);
    // In tracked levels, score is the closest equivalent of strength.
    const strength = toNum(lvl?.score);

    if (!(price > 0)) {
      invalidReasons.price += 1;
      reasons.push('price');
    }
    if (!(touches > 0)) {
      invalidReasons.touches += 1;
      reasons.push('touches');
    }
    if (!(strength > 0)) {
      invalidReasons.strength += 1;
      reasons.push('strength');
    }
    if (!lvl?.type) {
      invalidReasons.type += 1;
      reasons.push('type');
    }

    if (reasons.length) {
      invalidItems.push({ id: lvl?.id ?? null, reasons });
    }
  }

  const total = levels.length;
  const invalid = invalidItems.length;
  return {
    total,
    valid: Math.max(0, total - invalid),
    invalid,
    invalidReasons,
    invalidItems,
  };
}

function buildManualLevelsQuality(levels) {
  const invalidReasons = {
    price: 0,
    side: 0,
  };
  const invalidItems = [];

  for (const lvl of levels) {
    const reasons = [];
    const price = toNum(lvl?.price);
    if (!(price > 0)) {
      invalidReasons.price += 1;
      reasons.push('price');
    }
    if (!lvl?.side) {
      invalidReasons.side += 1;
      reasons.push('side');
    }
    if (reasons.length) {
      invalidItems.push({ id: lvl?.id ?? null, reasons });
    }
  }

  const total = levels.length;
  const invalid = invalidItems.length;
  return {
    total,
    valid: Math.max(0, total - invalid),
    invalid,
    invalidReasons,
    invalidItems,
  };
}

function normalizeExtreme(ex) {
  return {
    id: ex?.id ?? null,
    symbol: ex?.symbol ?? null,
    marketType: ex?.marketType ?? null,
    tf: ex?.tf ?? null,
    source: ex?.source ?? null,
    side: ex?.side ?? null,
    type: ex?.type ?? null,
    price: toNum(ex?.price),
    strength: toNum(ex?.strength),
    touches: toNum(ex?.touches),
    time: pickExtremeTime(ex),
    points: Array.isArray(ex?.points) ? ex.points : [],
    alertEnabled: Boolean(ex?.alertEnabled),
    updatedAt: ex?.updatedAt ?? null,
  };
}

function normalizeTrackedLevel(lvl) {
  return {
    id: lvl?.id ?? null,
    symbol: lvl?.symbol ?? null,
    marketType: lvl?.marketType ?? null,
    tf: lvl?.tf ?? null,
    source: lvl?.source ?? 'tracked-levels',
    side: lvl?.side ?? null,
    type: lvl?.type ?? null,
    price: toNum(lvl?.price),
    touches: toNum(lvl?.touches),
    strength: toNum(lvl?.score),
    score: toNum(lvl?.score),
    virgin: lvl?.virgin ?? null,
    formationTimestamp: lvl?.formationTimestamp ?? null,
    drawFromTimestamp: lvl?.drawFromTimestamp ?? null,
    alertEnabled: Boolean(lvl?.alertEnabled),
    updatedAt: lvl?.updatedAt ?? null,
    _kind: 'tracked',
  };
}

function normalizeManualLevel(lvl) {
  return {
    id: lvl?.id ?? null,
    symbol: lvl?.symbol ?? null,
    marketType: lvl?.marketType ?? null,
    tf: lvl?.tf ?? null,
    source: 'manual-levels',
    side: lvl?.side ?? null,
    type: 'manual',
    price: toNum(lvl?.price),
    touches: null,
    strength: null,
    score: null,
    virgin: null,
    formationTimestamp: null,
    drawFromTimestamp: null,
    alertEnabled: false,
    updatedAt: lvl?.updatedAt ?? null,
    _kind: 'manual',
  };
}

function createDebugExtremesLevelsHandler() {
  return function debugExtremesLevelsHandler(req, res) {
    try {
      const symbol = String(req.query.symbol || 'SLXUSDT').toUpperCase().trim();
      const tf = String(req.query.tf || '5m').trim();
      const marketType = String(req.query.marketType || 'futures').trim();
      const userId = req.user?.id ?? null;

      const extremesRaw = getTrackedExtremes({ userId, symbol, marketType, tf });
      const trackedLevelsRaw = getTrackedLevels({ symbol, marketType, tf });
      const manualLevelsRaw = getManualLevels({ symbol, marketType, tf, userId });

      const extremes = extremesRaw.map(normalizeExtreme);
      const trackedLevels = trackedLevelsRaw.map(normalizeTrackedLevel);
      const manualLevels = manualLevelsRaw.map(normalizeManualLevel);
      const levels = [...trackedLevels, ...manualLevels];

      const extremesQuality = buildExtremesQuality(extremes);
      const trackedLevelsQuality = buildTrackedLevelsQuality(trackedLevelsRaw);
      const manualLevelsQuality = buildManualLevelsQuality(manualLevelsRaw);

      return res.json({
        success: true,
        symbol,
        tf,
        marketType,
        generatedAt: Date.now(),
        extremes,
        levels,
        quality: {
          extremes: extremesQuality,
          trackedLevels: trackedLevelsQuality,
          manualLevels: manualLevelsQuality,
          summary: {
            extremesTotal: extremes.length,
            levelsTotal: levels.length,
            trackedLevelsTotal: trackedLevels.length,
            manualLevelsTotal: manualLevels.length,
            totalInvalid:
              extremesQuality.invalid +
              trackedLevelsQuality.invalid +
              manualLevelsQuality.invalid,
          },
        },
      });
    } catch (err) {
      console.error('[debug-extremes-levels] handler error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createDebugExtremesLevelsHandler };
