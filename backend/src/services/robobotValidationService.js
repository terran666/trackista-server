'use strict';
/**
 * robobotValidationService.js — payload validation for Robobot tasks.
 */

const VALID_SCENARIOS    = new Set(['breakout', 'bounce']);
const VALID_DIRECTIONS   = new Set(['long', 'short']);
const VALID_MARKETS      = new Set(['futures']); // MVP
const VALID_ENTRY_TYPES  = new Set(['market', 'limit']);
const SYMBOL_RX          = /^[A-Z0-9]{3,20}$/;

const VALID_TRIGGERS = {
  breakout: new Set(['cross_above', 'cross_below']),
  bounce  : new Set(['bounce_up', 'bounce_down']),
};

/**
 * Validate a task payload (used both on create and patch).
 * Returns { ok:true, value } on success or { ok:false, errors:[...] }.
 *
 * @param {object} input  raw payload
 * @param {object} ctx    { universeSymbols:Set<string> } optional
 */
function validateTaskInput(input, ctx = {}) {
  const errors = [];
  const out    = {};

  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['payload must be an object'] };
  }

  // symbol
  const symbol = String(input.symbol || '').toUpperCase().trim();
  if (!symbol)              errors.push('symbol is required');
  else if (!SYMBOL_RX.test(symbol)) errors.push('symbol has invalid format');
  else if (ctx.universeSymbols && !ctx.universeSymbols.has(symbol)) {
    errors.push(`symbol "${symbol}" not found in universe`);
  }
  out.symbol = symbol;

  // market
  const market = String(input.market || 'futures').toLowerCase();
  if (!VALID_MARKETS.has(market)) errors.push(`market must be one of: ${[...VALID_MARKETS].join(', ')}`);
  out.market = market;

  // scenario / direction
  const scenario  = String(input.scenario  || '').toLowerCase();
  const direction = String(input.direction || '').toLowerCase();
  if (!VALID_SCENARIOS.has(scenario))   errors.push(`scenario must be one of: ${[...VALID_SCENARIOS].join(', ')}`);
  if (!VALID_DIRECTIONS.has(direction)) errors.push(`direction must be one of: ${[...VALID_DIRECTIONS].join(', ')}`);
  out.scenario  = scenario;
  out.direction = direction;

  // numeric prices
  const levelPrice       = Number(input.levelPrice);
  const stopLossPrice    = Number(input.stopLossPrice);
  const takeProfitPrice  = Number(input.takeProfitPrice);
  const positionSizeUsdt = Number(input.positionSizeUsdt);

  if (!isFinite(levelPrice) || levelPrice <= 0)             errors.push('levelPrice must be > 0');
  if (!isFinite(stopLossPrice) || stopLossPrice <= 0)       errors.push('stopLossPrice must be > 0');
  if (!isFinite(takeProfitPrice) || takeProfitPrice <= 0)   errors.push('takeProfitPrice must be > 0');
  if (!isFinite(positionSizeUsdt) || positionSizeUsdt <= 0) errors.push('positionSizeUsdt must be > 0');

  out.levelPrice       = levelPrice;
  out.stopLossPrice    = stopLossPrice;
  out.takeProfitPrice  = takeProfitPrice;
  out.positionSizeUsdt = positionSizeUsdt;

  // direction-specific TP/SL ordering
  if (direction === 'long') {
    if (takeProfitPrice <= levelPrice) errors.push('long: takeProfitPrice must be > levelPrice');
    if (stopLossPrice   >= levelPrice) errors.push('long: stopLossPrice must be < levelPrice');
  } else if (direction === 'short') {
    if (takeProfitPrice >= levelPrice) errors.push('short: takeProfitPrice must be < levelPrice');
    if (stopLossPrice   <= levelPrice) errors.push('short: stopLossPrice must be > levelPrice');
  }

  // forbidden equalities
  if (takeProfitPrice === stopLossPrice)   errors.push('takeProfitPrice cannot equal stopLossPrice');
  if (takeProfitPrice === levelPrice)      errors.push('takeProfitPrice cannot equal levelPrice');
  if (stopLossPrice   === levelPrice)      errors.push('stopLossPrice cannot equal levelPrice');

  // trigger
  let triggerType = String(input.triggerType || '').toLowerCase();
  if (!triggerType && scenario === 'breakout') {
    triggerType = direction === 'long' ? 'cross_above' : 'cross_below';
  } else if (!triggerType && scenario === 'bounce') {
    triggerType = direction === 'long' ? 'bounce_up' : 'bounce_down';
  }
  if (scenario && !VALID_TRIGGERS[scenario]?.has(triggerType)) {
    errors.push(`triggerType "${triggerType}" not valid for scenario "${scenario}"`);
  }
  out.triggerType = triggerType;

  // trigger config (for bounce: confirmDistancePercent)
  const triggerConfig = (input.triggerConfig && typeof input.triggerConfig === 'object')
    ? { ...input.triggerConfig } : {};
  if (scenario === 'bounce') {
    const cd = Number(triggerConfig.confirmDistancePercent ?? 0.05);
    if (!isFinite(cd) || cd <= 0 || cd > 5) {
      errors.push('triggerConfig.confirmDistancePercent must be in (0, 5]');
    }
    triggerConfig.confirmDistancePercent = cd;
  }
  out.triggerConfig = triggerConfig;

  // entry type
  const entryType = String(input.entry?.type || input.entryType || 'market').toLowerCase();
  if (!VALID_ENTRY_TYPES.has(entryType)) errors.push(`entry.type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`);
  out.entryType = entryType;

  // risk config (free JSON)
  out.riskConfig = (input.riskConfig && typeof input.riskConfig === 'object') ? input.riskConfig : {};

  // expiresAt (optional ISO/ms)
  if (input.expiresAt != null) {
    const t = (typeof input.expiresAt === 'number')
      ? new Date(input.expiresAt)
      : new Date(String(input.expiresAt));
    if (isNaN(t.getTime())) errors.push('expiresAt is not a valid date');
    else out.expiresAt = t;
  } else {
    out.expiresAt = null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

module.exports = {
  validateTaskInput,
  VALID_SCENARIOS,
  VALID_DIRECTIONS,
  VALID_MARKETS,
  VALID_TRIGGERS,
};
