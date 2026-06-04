'use strict';

/**
 * formationLifecycle.js — drives a stored formation through its terminal states.
 *
 * V2 philosophy: the page shows only FUTURE opportunities (not-yet-broken
 * levels). Active statuses (DETECTED/APPROACHING/READY) are refreshed by the
 * strategies each tick. This module only handles removal:
 *   - COMPLETED   : the level got broken (candle closed beyond it) → remove/hide
 *   - INVALIDATED : price ran away from the level / stop violated → remove/hide
 *   - EXPIRED     : TTL reached → remove/hide
 *
 * V1 pattern formations (patternType set) use `formation.levels` instead of
 * `formation.level` and follow direction SHORT_BREAKDOWN / LONG_BREAKOUT rules.
 */

const { DIRECTION } = require('./formationTypes');

/**
 * @param {object} formation stored formation
 * @param {object} ctx { price, lastClosedCandle, cfg }
 * @returns {{ action:'complete'|'invalidate'|'expire'|'none' }}
 */
function evaluate(formation, ctx) {
  const now = Date.now();
  const cfg = ctx.cfg;
  const price = ctx.price;

  if (now >= formation.expiresAt) return { action: 'expire' };

  if (formation.patternType) {
    const levelBased = _evaluateLevelBasedLifecycle(formation, price, ctx.lastClosedCandle, cfg);
    if (levelBased) return levelBased;
  }

  // ── V1 pattern formations (Double Top / Double Bottom) ─────────────────────
  if (formation.patternType) {
    return _evaluatePattern(formation, price, cfg);
  }

  // ── Legacy V2/V3 geometry formations ──────────────────────────────────────
  const lvl = formation.level.price;
  const dir = formation.direction;
  const lastClose = ctx.lastClosedCandle?.close ?? price;

  // Breakout already happened → COMPLETED (remove immediately)
  const brokenByClose = dir === DIRECTION.LONG ? lastClose > lvl : lastClose < lvl;
  const brokenByPrice = dir === DIRECTION.LONG ? price > lvl : price < lvl;
  if (brokenByClose || brokenByPrice) return { action: 'complete' };

  // Invalidation: price ran away from the level (opportunity gone)
  const awayPct = dir === DIRECTION.LONG
    ? ((lvl - price) / price) * 100
    : ((price - lvl) / price) * 100;
  if (awayPct > cfg.maxDistancePct) return { action: 'invalidate' };

  // Invalidation: protective stop violated
  const stop = formation.tradePlan?.stop;
  if (stop != null) {
    if (dir === DIRECTION.LONG  && price < stop) return { action: 'invalidate' };
    if (dir === DIRECTION.SHORT && price > stop) return { action: 'invalidate' };
  }

  return { action: 'none' };
}

function _toTfMinutes(tf) {
  const s = String(tf || '').trim();
  const map = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
  if (map[s]) return map[s];
  const m = s.toLowerCase().match(/^(\d+)(m|h|d)$/);
  if (!m) return 1;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (m[2] === 'm') return n;
  if (m[2] === 'h') return n * 60;
  return n * 1440;
}

function _toLevelPrice(formation) {
  const p = Number(
    formation.levelPrice
    ?? formation.breakLevel
    ?? formation.levels?.supportLevel
    ?? formation.levels?.resistanceLevel
    ?? formation.level?.price,
  );
  return Number.isFinite(p) && p > 0 ? p : null;
}

function _evaluateLevelBasedLifecycle(formation, price, lastClosedCandle, cfg) {
  const patternType = String(formation.patternType || '');
  const levelPrice = _toLevelPrice(formation);
  if (!(Number.isFinite(price) && levelPrice > 0)) return null;

  const lbCfg = cfg?.patternEngine?.levelBased || {};
  const breakThresholdPct = Number(lbCfg.breakThresholdPct ?? 0.2);
  const maxActiveDistancePct = Number(lbCfg.maxActiveDistancePct ?? 6.0);
  const requiredConfirmBars = Math.max(1, Number(lbCfg.requiredConfirmBars ?? 2));
  const maxBarsAfterBreak = Math.max(1, Number(lbCfg.maxBarsAfterBreak ?? 20));

  const zoneLower = Number(formation.zoneLower ?? (levelPrice * (1 - (Number(formation.tolerancePct ?? 0.35) / 100))));
  const zoneUpper = Number(formation.zoneUpper ?? (levelPrice * (1 + (Number(formation.tolerancePct ?? 0.35) / 100))));
  const close = Number(lastClosedCandle?.close ?? price);
  const breakDownByClose = close < zoneLower || close < levelPrice * (1 - breakThresholdPct / 100);
  const breakUpByClose = close > zoneUpper || close > levelPrice * (1 + breakThresholdPct / 100);
  const distancePct = Math.abs((price - levelPrice) / levelPrice * 100);
  const tfMinutes = _toTfMinutes(formation.tf);
  const breakTs = Number(formation.breakDetectedAt ?? formation.updatedAt ?? formation.createdAt ?? Date.now());
  const ageSinceBreakBars = Math.max(0, Math.floor((Date.now() - breakTs) / (tfMinutes * 60_000)));

  if (formation.isVisibleOnTestPage === false || formation.visibleOnTestPage === false) {
    return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'REMOVED_LEVEL_NOT_VISIBLE' };
  }

  if (patternType === 'SUPPORT_BREAKDOWN_SETUP') {
    if (breakDownByClose) {
      return {
        action: 'promote_breakdown',
        lifecycleStatus: 'PROMOTED_TO_BREAKDOWN',
        lifecycleReason: 'PROMOTED_TO_BREAKDOWN',
      };
    }
    if (distancePct > maxActiveDistancePct) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'REMOVED_PRICE_TOO_FAR' };
    }
    return { action: 'none', lifecycleStatus: 'ACTIVE_NEAR_LEVEL', lifecycleReason: 'SETUP_WAITING_BREAK' };
  }

  if (patternType === 'RESISTANCE_BREAKOUT_SETUP') {
    if (breakUpByClose) {
      return {
        action: 'promote_breakout',
        lifecycleStatus: 'PROMOTED_TO_BREAKOUT',
        lifecycleReason: 'PROMOTED_TO_BREAKOUT',
      };
    }
    if (distancePct > maxActiveDistancePct) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'REMOVED_PRICE_TOO_FAR' };
    }
    return { action: 'none', lifecycleStatus: 'ACTIVE_NEAR_LEVEL', lifecycleReason: 'SETUP_WAITING_BREAK' };
  }

  if (patternType === 'SUPPORT_BREAKDOWN' || patternType === 'RESISTANCE_BREAKOUT') {
    if (ageSinceBreakBars >= Math.max(requiredConfirmBars, maxBarsAfterBreak)) {
      return {
        action: 'remove',
        lifecycleStatus: 'REMOVED',
        lifecycleReason: 'REMOVED_EXPIRED_AFTER_BREAK',
      };
    }
    if (distancePct > maxActiveDistancePct) {
      return { action: 'remove', lifecycleStatus: 'REMOVED', lifecycleReason: 'REMOVED_PRICE_TOO_FAR' };
    }
  }

  return null;
}

/**
 * Lifecycle check for V1 visual pattern formations.
 *
 * DOUBLE_TOP  (SHORT_BREAKDOWN):
 *   Completed   : price < necklineLevel - breakoutBuffer
 *   Invalidated : price > invalidationLevel (= resistanceLevel + buffer)
 *
 * DOUBLE_BOTTOM (LONG_BREAKOUT):
 *   Completed   : price > necklineLevel + breakoutBuffer
 *   Invalidated : price < invalidationLevel (= supportLevel - buffer)
 */
function _evaluatePattern(formation, price, cfg) {
  const levels = formation.levels;
  if (!levels) return { action: 'none' };

  const dir            = formation.direction;
  const neckline       = levels.necklineLevel;
  const invalidation   = levels.invalidationLevel;
  const bufferPct      = cfg?.patternEngine?.doubleExtreme?.breakoutBufferPct ?? 0.15;

  if (!Number.isFinite(price)) return { action: 'none' };

  if (dir === 'SHORT_BREAKDOWN') {
    const breakoutBuffer = Number.isFinite(neckline) ? neckline * (bufferPct / 100) : 0;
    if (Number.isFinite(neckline)     && price < neckline - breakoutBuffer)  return { action: 'complete' };
    if (Number.isFinite(invalidation) && price > invalidation)               return { action: 'invalidate' };
  } else if (dir === 'LONG_BREAKOUT') {
    const breakoutBuffer = Number.isFinite(neckline) ? neckline * (bufferPct / 100) : 0;
    if (Number.isFinite(neckline)     && price > neckline + breakoutBuffer)  return { action: 'complete' };
    if (Number.isFinite(invalidation) && price < invalidation)               return { action: 'invalidate' };
  } else if (dir === 'SHORT') {
    // Level-based: SUPPORT_BREAKDOWN / RESISTANCE_REJECTION
    // Formation stays ACTIVE while price is below the level.
    // INVALIDATED if price recovers above the invalidation level.
    if (Number.isFinite(invalidation) && price > invalidation) return { action: 'invalidate' };
  } else if (dir === 'LONG') {
    // Level-based: RESISTANCE_BREAKOUT / SUPPORT_BOUNCE
    // Formation stays ACTIVE while price is above the level.
    // INVALIDATED if price drops back below the invalidation level.
    if (Number.isFinite(invalidation) && price < invalidation) return { action: 'invalidate' };
  }

  return { action: 'none', lifecycleStatus: 'ACTIVE_NEAR_LEVEL', lifecycleReason: 'SETUP_WAITING_BREAK' };
}

module.exports = { evaluate };

