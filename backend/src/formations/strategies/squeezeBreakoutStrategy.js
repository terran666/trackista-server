'use strict';

/**
 * squeezeBreakoutStrategy — breakout out of a volatility contraction (squeeze).
 * Requires range compression building into the level.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.SQUEEZE_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.SQUEEZE_BREAKOUT,
      typeUp:   FORMATION_TYPES.SQUEEZE_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.SQUEEZE_BREAKOUT_DOWN,
      weights: { compression: 30, closeness: 16, strength: 14, volume: 12, structure: 10, delta: 8, oi: 6, liquidity: 4 },
      requiredSignal: 'compression',
    });
  },
};
