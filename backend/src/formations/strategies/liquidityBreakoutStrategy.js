'use strict';

/**
 * liquidityBreakoutStrategy — breakout toward resting liquidity behind a level.
 * Requires a liquidity wall sitting just beyond the level (breakout fuel/magnet).
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.LIQUIDITY_BREAKOUT,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.LIQUIDITY_BREAKOUT,
      typeUp:   FORMATION_TYPES.LIQUIDITY_BREAKOUT_UP,
      typeDown: FORMATION_TYPES.LIQUIDITY_BREAKOUT_DOWN,
      weights: { liquidity: 26, closeness: 18, delta: 14, volume: 12, strength: 12, structure: 8, oi: 6, compression: 4 },
      requiredSignal: 'liquidityBehindLevel',
    });
  },
};
