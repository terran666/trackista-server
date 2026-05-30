'use strict';
/**
 * parseClamp.js — safe numeric query/body parsing.
 *
 * `Math.min(NaN, X)` returns NaN, which then propagates into Redis ranges,
 * SQL LIMIT, or service params and causes silent failures. These helpers
 * always return a finite number inside [min, max] (or `def` when input is
 * missing / non-numeric).
 */

/** Parse an integer and clamp to [min, max]. Returns `def` on NaN. */
function parseIntClamp(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

/** Parse a float and clamp to [min, max]. Returns `def` on NaN. */
function parseFloatClamp(value, def, min, max) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return def;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

/**
 * Normalize and validate a Binance-style trading symbol.
 * Accepts case-insensitive input, trims whitespace, returns uppercased
 * symbol if it matches /^[A-Z0-9]{3,20}$/, or null otherwise.
 *
 * Use whenever a `symbol` query/body field is interpolated into a Redis key,
 * filesystem path, or external URL to prevent command/path injection.
 */
function safeSymbol(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(s)) return null;
  return s;
}

module.exports = { parseIntClamp, parseFloatClamp, safeSymbol };
