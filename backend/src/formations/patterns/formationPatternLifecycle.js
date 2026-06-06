'use strict';

/**
 * formationPatternLifecycle.js
 * Evaluates existing formations for status transitions.
 *
 * Statuses:
 *   FORMING → READY → BREAKOUT → RETEST / FAILED
 *   any     → EXPIRED
 */

const TERMINAL = new Set(['BREAKOUT', 'FAILED', 'EXPIRED']);

/**
 * @param {object} formation  — stored formation record
 * @param {object} ctx        — { currentPrice, latestBar, bars, config }
 * @returns {object}          — { action: 'none'|'update'|'remove', patch?: object }
 */
function evaluate(formation, ctx) {
  const { currentPrice, latestBar, config } = ctx;
  const now = Date.now();

  // ── Expire ──────────────────────────────────────────────────────────────────
  if (formation.timestamps?.expiresAt && now > formation.timestamps.expiresAt) {
    return { action: 'update', patch: { status: 'EXPIRED', updatedAt: now } };
  }

  const levelPrice = formation.levelPrice;
  if (!levelPrice) return { action: 'none' };

  const bufPct = config.breakout?.bufferPct ?? 0.15;
  const bufAbs = levelPrice * bufPct / 100;

  const isLong  = formation.direction === 'LONG';  // resistance breakout
  const isShort = formation.direction === 'SHORT'; // support breakdown

  const status = formation.status;

  // ── Already-terminal formations: keep for lifecycle reference, clean up later ─
  if (TERMINAL.has(status)) {
    // Remove EXPIRED/FAILED formations after a short grace period (TTL handles BREAKOUT)
    if ((status === 'EXPIRED' || status === 'FAILED') && now - formation.updatedAt > 300_000) {
      return { action: 'remove' };
    }
    return { action: 'none' };
  }

  // ── Breakout detection (close beyond level + buffer) ────────────────────────
  const closePrice = latestBar?.close ?? currentPrice;

  if (!formation.breakout?.isBroken) {
    if (isLong && closePrice > levelPrice + bufAbs) {
      return {
        action: 'update',
        patch: {
          status: 'BREAKOUT',
          updatedAt: now,
          breakout: {
            isBroken: true,
            brokenAt: latestBar?.ts ?? now,
            brokenPrice: closePrice,
            brokenCandleClose: closePrice,
            direction: 'UP',
            confirmed: true,
          },
        },
      };
    }
    if (isShort && closePrice < levelPrice - bufAbs) {
      return {
        action: 'update',
        patch: {
          status: 'BREAKOUT',
          updatedAt: now,
          breakout: {
            isBroken: true,
            brokenAt: latestBar?.ts ?? now,
            brokenPrice: closePrice,
            brokenCandleClose: closePrice,
            direction: 'DOWN',
            confirmed: true,
          },
        },
      };
    }
  }

  // ── Retest detection (price returns to level after breakout) ─────────────────
  if (formation.breakout?.isBroken && status === 'BREAKOUT') {
    const retestTolPct = config.breakout?.retestTolerancePct ?? 0.5;
    const retestAbs = levelPrice * retestTolPct / 100;
    if (Math.abs(currentPrice - levelPrice) <= retestAbs) {
      return {
        action: 'update',
        patch: { status: 'RETEST', updatedAt: now },
      };
    }
  }

  // ── Failed breakout detection ─────────────────────────────────────────────────
  // After BREAKOUT: if price returns strongly to the wrong side
  if (formation.breakout?.isBroken) {
    const failBuf = levelPrice * (bufPct * 2) / 100;
    if (isLong && currentPrice < levelPrice - failBuf) {
      return { action: 'update', patch: { status: 'FAILED', updatedAt: now } };
    }
    if (isShort && currentPrice > levelPrice + failBuf) {
      return { action: 'update', patch: { status: 'FAILED', updatedAt: now } };
    }
  }

  // ── FORMING → READY: enough touches + bars ─────────────────────────────────
  if (status === 'FORMING') {
    const { minTouches = 2, minBarsInsidePattern = 8, minScore = 30 } = config.filters || {};
    const touches = formation.pattern?.touches ?? 0;
    const barsIn  = formation.pattern?.barsInside ?? 0;
    const score   = formation.score ?? 0;
    if (touches >= minTouches && barsIn >= minBarsInsidePattern && score >= minScore) {
      return { action: 'update', patch: { status: 'READY', updatedAt: now } };
    }
  }

  return { action: 'none' };
}

module.exports = { evaluate };
