'use strict';

/**
 * classicBreakoutStrategy — pure price-structure breakout.
 *
 * Emphasises level strength + aligned market structure (higher-lows for LONG,
 * lower-highs for SHORT). Requires the structure signal to be present.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.CLASSIC_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.CLASSIC_BREAKOUT,
      typeUp:   FORMATION_TYPES.CLASSIC_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.CLASSIC_BREAKOUT_DOWN,
      weights: { strength: 22, structure: 24, volume: 8, delta: 8, oi: 6, liquidity: 6 },
      requiredSignal: 'structureAligned',
    });
  },
};
