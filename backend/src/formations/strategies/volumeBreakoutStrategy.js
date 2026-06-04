'use strict';

/**
 * volumeBreakoutStrategy — breakout driven by rising volume.
 * Requires a confirmed volume spike building into the level.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.VOLUME_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.VOLUME_BREAKOUT,
      typeUp:   FORMATION_TYPES.VOLUME_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.VOLUME_BREAKOUT_DOWN,
      weights: { volume: 30, delta: 16, closeness: 16, strength: 12, structure: 10, compression: 8, oi: 4, liquidity: 4 },
      requiredSignal: 'volumeSpike',
    });
  },
};
