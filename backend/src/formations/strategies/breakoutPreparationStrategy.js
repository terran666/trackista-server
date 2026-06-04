'use strict';

/**
 * breakoutPreparationStrategy — the MVP strategy.
 *
 * Generic "a level is being prepared for a breakout" detector. Requires at least
 * one preparation signal (handled by the shared evaluator) but does not insist on
 * any specific one — it is the broadest of the strategies.
 */

const { FORMATION_TYPES, STRATEGY_KEYS } = require('../formationTypes');
const { evaluateBreakout } = require('./breakoutShared');

module.exports = {
  key: STRATEGY_KEYS.BREAKOUT_PREPARATION,
  evaluate(ctx) {
    return evaluateBreakout(ctx, {
      strategy: STRATEGY_KEYS.BREAKOUT_PREPARATION,
      typeUp:   FORMATION_TYPES.BREAKOUT_PREPARATION_UP,
      typeDown: FORMATION_TYPES.BREAKOUT_PREPARATION_DOWN,
      // balanced weights — no single signal dominates
      weights: {},
      requiredSignal: null,
    });
  },
};
