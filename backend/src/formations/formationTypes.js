'use strict';

/**
 * formationTypes.js — shared enums for the Formations breakout module.
 *
 * The Formations module answers: "Which level is most likely to break NEXT?"
 * Every formation is created BEFORE the breakout. A level that is already
 * broken is never shown (it is either skipped or moved to COMPLETED).
 */

// ─── Formation types (per strategy + direction) ──────────────────────────────
const FORMATION_TYPES = {
  BREAKOUT_PREPARATION_UP:   'BREAKOUT_PREPARATION_UP',
  BREAKOUT_PREPARATION_DOWN: 'BREAKOUT_PREPARATION_DOWN',

  CLASSIC_BREAKOUT_UP:   'CLASSIC_BREAKOUT_UP',
  CLASSIC_BREAKOUT_DOWN: 'CLASSIC_BREAKOUT_DOWN',

  VOLUME_BREAKOUT_UP:   'VOLUME_BREAKOUT_UP',
  VOLUME_BREAKOUT_DOWN: 'VOLUME_BREAKOUT_DOWN',

  OI_BREAKOUT_UP:   'OI_BREAKOUT_UP',
  OI_BREAKOUT_DOWN: 'OI_BREAKOUT_DOWN',

  DELTA_BREAKOUT_UP:   'DELTA_BREAKOUT_UP',
  DELTA_BREAKOUT_DOWN: 'DELTA_BREAKOUT_DOWN',

  LIQUIDITY_BREAKOUT_UP:   'LIQUIDITY_BREAKOUT_UP',
  LIQUIDITY_BREAKOUT_DOWN: 'LIQUIDITY_BREAKOUT_DOWN',

  SQUEEZE_BREAKOUT_UP:   'SQUEEZE_BREAKOUT_UP',
  SQUEEZE_BREAKOUT_DOWN: 'SQUEEZE_BREAKOUT_DOWN',
};

// ─── Strategy keys (one per strategy file) ───────────────────────────────────
const STRATEGY_KEYS = {
  BREAKOUT_PREPARATION: 'breakoutPreparation',
  CLASSIC_BREAKOUT:     'classicBreakout',
  VOLUME_BREAKOUT:      'volumeBreakout',
  OI_BREAKOUT:          'oiBreakout',
  DELTA_BREAKOUT:       'deltaBreakout',
  LIQUIDITY_BREAKOUT:   'liquidityBreakout',
  SQUEEZE_BREAKOUT:     'squeezeBreakout',
};

// ─── Lifecycle statuses ──────────────────────────────────────────────────────
// V2: no BREAKOUT phase. Once a level is broken the formation goes straight to
// COMPLETED and is removed — the page shows only future opportunities.
// V1 pattern engine adds ACTIVE status (replaces DETECTED/APPROACHING/READY).
const FORMATION_STATUS = {
  ACTIVE:      'ACTIVE',       // V1 pattern engine: pattern found, awaiting breakout
  BREAKOUT:    'BREAKOUT',
  BREAKDOWN:   'BREAKDOWN',
  CONFIRMED:   'CONFIRMED',
  RETEST:      'RETEST',
  DETECTED:    'DETECTED',
  APPROACHING: 'APPROACHING',
  READY:       'READY',
  COMPLETED:   'COMPLETED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED:     'EXPIRED',
};

// Shown on the frontend (future opportunities only).
const VISIBLE_STATUSES = new Set([
  FORMATION_STATUS.ACTIVE,
  FORMATION_STATUS.BREAKOUT,
  FORMATION_STATUS.BREAKDOWN,
  FORMATION_STATUS.CONFIRMED,
  FORMATION_STATUS.RETEST,
  FORMATION_STATUS.DETECTED,
  FORMATION_STATUS.APPROACHING,
  FORMATION_STATUS.READY,
]);

// Hidden / removed (history, not opportunities).
const TERMINAL_STATUSES = new Set([
  FORMATION_STATUS.COMPLETED,
  FORMATION_STATUS.INVALIDATED,
  FORMATION_STATUS.EXPIRED,
]);

// Sort priority — READY first (highest breakout probability about to fire).
const STATUS_PRIORITY = {
  [FORMATION_STATUS.CONFIRMED]:   0,
  [FORMATION_STATUS.BREAKOUT]:    0,
  [FORMATION_STATUS.BREAKDOWN]:   0,
  [FORMATION_STATUS.RETEST]:      0,
  [FORMATION_STATUS.READY]:       0,
  [FORMATION_STATUS.ACTIVE]:      0,   // V1 pattern: same urgency as READY
  [FORMATION_STATUS.APPROACHING]: 1,
  [FORMATION_STATUS.DETECTED]:    2,
  [FORMATION_STATUS.COMPLETED]:   3,
  [FORMATION_STATUS.INVALIDATED]: 4,
  [FORMATION_STATUS.EXPIRED]:     5,
};

const DIRECTION = {
  LONG:            'LONG',            // legacy: price below resistance, expecting break UP
  SHORT:           'SHORT',           // legacy: price above support,   expecting break DOWN
  LONG_BREAKOUT:   'LONG_BREAKOUT',   // pattern: Double Bottom — expecting break UP through neckline
  SHORT_BREAKDOWN: 'SHORT_BREAKDOWN', // pattern: Double Top   — expecting break DOWN through neckline
};

// ─── Pattern types (visual pattern engine V1) ─────────────────────────────────
const PATTERN_TYPE = {
  DOUBLE_TOP:           'DOUBLE_TOP',
  DOUBLE_BOTTOM:        'DOUBLE_BOTTOM',
  // Level-based patterns (levelBasedStrategy)
  SUPPORT_BREAKDOWN_SETUP: 'SUPPORT_BREAKDOWN_SETUP',
  SUPPORT_BREAKDOWN:    'SUPPORT_BREAKDOWN',
  RESISTANCE_BREAKOUT_SETUP: 'RESISTANCE_BREAKOUT_SETUP',
  RESISTANCE_BREAKOUT:  'RESISTANCE_BREAKOUT',
  SUPPORT_BOUNCE:       'SUPPORT_BOUNCE',
  RESISTANCE_REJECTION: 'RESISTANCE_REJECTION',
};

const LEVEL_SIDE = {
  RESISTANCE: 'resistance',
  SUPPORT:    'support',
};

// V1 pattern statuses — simpler than legacy (no APPROACHING/READY)
const PATTERN_STATUS = {
  ACTIVE:      'ACTIVE',
  COMPLETED:   'COMPLETED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED:     'EXPIRED',
};

module.exports = {
  FORMATION_TYPES,
  STRATEGY_KEYS,
  FORMATION_STATUS,
  VISIBLE_STATUSES,
  TERMINAL_STATUSES,
  STATUS_PRIORITY,
  DIRECTION,
  PATTERN_TYPE,
  PATTERN_STATUS,
  LEVEL_SIDE,
};
