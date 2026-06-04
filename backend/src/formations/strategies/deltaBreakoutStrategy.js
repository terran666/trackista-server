'use strict';

/**
 * deltaBreakoutStrategy — breakout driven by aggressive order flow (delta).
 * Requires delta aligned with the breakout direction.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.DELTA_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.DELTA_BREAKOUT,
      typeUp:   FORMATION_TYPES.DELTA_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.DELTA_BREAKOUT_DOWN,
      weights: { delta: 30, volume: 16, closeness: 16, strength: 12, structure: 10, oi: 8, compression: 4, liquidity: 4 },
      requiredSignal: 'deltaAligned',
    });
  },
};
