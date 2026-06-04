'use strict';

/**
 * oiBreakoutStrategy — breakout backed by rising open interest.
 * Requires open interest to be rising into the level.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.OI_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.OI_BREAKOUT,
      typeUp:   FORMATION_TYPES.OI_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.OI_BREAKOUT_DOWN,
      weights: { oi: 28, delta: 16, volume: 14, closeness: 16, strength: 10, structure: 8, compression: 4, liquidity: 4 },
      requiredSignal: 'oiRising',
    });
  },
};
