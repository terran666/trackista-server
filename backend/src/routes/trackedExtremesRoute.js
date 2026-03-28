'use strict';

const store = require('../services/trackedExtremesStore');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_SIDES        = new Set(['support', 'resistance']);
const VALID_TYPES        = new Set(['ray', 'line', 'extreme']);
const VALID_INTERVALS    = new Set([
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M',
]);

// ─── Shared validation ────────────────────────────────────────────

function isValidPoint(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    typeof p.timestamp === 'number' &&
    Number.isFinite(p.timestamp) &&
    p.timestamp > 0 &&
    typeof p.value === 'number' &&
    Number.isFinite(p.value) &&
    p.value > 0
  );
}

function isValidPoints(points) {
  return Array.isArray(points) && points.length >= 1 && points.every(isValidPoint);
}

// ─── POST /api/tracked-extremes/bulk ─────────────────────────────
//
// Request body:
// {
//   symbol:     string          e.g. "BTCUSDT"
//   marketType: "spot"|"futures"
//   tf:         string          e.g. "5m"
//   source:     string          e.g. "extremes"
//   extremes:   Array<{
//     side:     "support"|"resistance"
//     type:     "ray"|"line"|"extreme"
//     price:    number
//     points:   [{ timestamp, value }, ...]
//     strength: number   (optional)
//     touches:  number   (optional)
//   }>
// }
//
// Response 200:
// { success: true, count: number, extremes: Extreme[] }
function bulkHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, tf, source, extremes } = body;

  function fail(reason) {
    console.log(`[tracked-extremes] bulk validation failed reason=${reason}`);
    return res.status(400).json({ success: false, error: reason });
  }

  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    return fail('Missing or invalid field: symbol (expected non-empty string, e.g. "BTCUSDT")');
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return fail(`Missing or invalid field: marketType (expected one of: ${[...VALID_MARKET_TYPES].join(', ')})`);
  }
  if (!VALID_INTERVALS.has(tf)) {
    return fail(`Missing or invalid field: tf (expected one of: ${[...VALID_INTERVALS].join(', ')})`);
  }
  if (!source || typeof source !== 'string' || source.trim() === '') {
    return fail('Missing or invalid field: source (expected non-empty string, e.g. "extremes")');
  }
  if (!Array.isArray(extremes)) {
    return fail('Missing or invalid field: extremes (expected array)');
  }

  console.log(`[tracked-extremes] bulk input symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${extremes.length}`);

  for (let i = 0; i < extremes.length; i++) {
    const e = extremes[i];
    if (!VALID_SIDES.has(e.side)) {
      return fail(`extremes[${i}].side must be one of: ${[...VALID_SIDES].join(', ')}`);
    }
    if (e.type !== undefined && !VALID_TYPES.has(e.type)) {
      return fail(`extremes[${i}].type must be one of: ${[...VALID_TYPES].join(', ')}`);
    }
    if (e.price !== undefined && (isNaN(parseFloat(e.price)) || parseFloat(e.price) <= 0)) {
      return fail(`extremes[${i}].price must be a positive number`);
    }
    if (e.points !== undefined && !isValidPoints(e.points)) {
      return fail(`extremes[${i}].points must be an array of {timestamp: number, value: number}`);
    }
  }

  try {
    const userId = req.user?.id ?? null;
    const result = store.bulkSave({ userId, symbol, marketType, tf, source, extremes });
    if (result.skipped) {
      console.log(`[tracked-extremes] bulk skipped unchanged snapshot symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${result.items.length}`);
      return res.status(200).json({ success: true, skipped: true, count: result.items.length, extremes: result.items });
    }
    console.log(`[tracked-extremes] bulk replaced snapshot symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${result.items.length}`);
    return res.status(200).json({ success: true, skipped: false, count: result.items.length, extremes: result.items });
  } catch (err) {
    console.error('[tracked-extremes] bulk save error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/tracked-extremes ────────────────────────────────────
//
// Query params (all optional):
//   symbol, marketType, tf, source
//
// Response 200:
// { success: true, count: number, extremes: Extreme[] }
function listHandler(req, res) {
  const { symbol, marketType, tf, source } = req.query;

  try {
    const userId  = req.user?.id ?? null;
    const extremes = store.getAll({ userId, symbol, marketType, tf, source });
    console.log(`[tracked-extremes] list symbol=${symbol} marketType=${marketType} tf=${tf} source=${source} count=${extremes.length}`);
    return res.json({ success: true, count: extremes.length, extremes });
  } catch (err) {
    console.error('[tracked-extremes] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── DELETE /api/tracked-extremes/:id ────────────────────────────
//
// Response 200:
// { success: true, id: number }
function deleteOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const userId  = req.user?.id ?? null;
    const removed = store.removeOne(id, userId);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Extreme not found' });
    }
    console.log(`[tracked-extremes] deleted id=${id} symbol=${removed.symbol}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[tracked-extremes] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/tracked-extremes/delete-many ──────────────────────
//
// Request body:
// { "ids": [1, 2, 3] }
//
// Response 200:
// { success: true, count: number }
function deleteManyHandler(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }

  try {
    const userId = req.user?.id ?? null;
    const count = store.removeMany(ids, userId);
    console.log(`[tracked-extremes] delete-many count=${count}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-extremes] delete-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── PATCH /api/tracked-extremes/:id ─────────────────────────────
//
// Patchable fields: price, points, alertEnabled, tracked
//
// Request body examples:
//   { "price": 84300 }                              — drag/move price
//   { "points": [{...}, {...}] }                    — drag/move ray
//   { "alertEnabled": true }                        — toggle alert
//   { "tracked": true }                             — toggle tracking
//   { "price": 84300, "points": [{...}, {...}] }    — move ray + price
//
// Response 200:
// { success: true, extreme: Extreme }
function patchOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  const body = req.body || {};
  if (Object.keys(body).length === 0) {
    return res.status(400).json({ success: false, error: 'Patch body is empty' });
  }

  const patch = {};

  if (body.price !== undefined) {
    const p = parseFloat(body.price);
    if (isNaN(p) || p <= 0) {
      return res.status(400).json({ success: false, error: 'price must be a positive number' });
    }
    patch.price = p;
  }

  if (body.points !== undefined) {
    if (!isValidPoints(body.points)) {
      return res.status(400).json({ success: false, error: 'points must be an array of {timestamp: number, value: number}' });
    }
    patch.points = body.points;
  }

  if (body.alertEnabled !== undefined) {
    if (typeof body.alertEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'alertEnabled must be a boolean' });
    }
    patch.alertEnabled = body.alertEnabled;
  }

  if (body.tracked !== undefined) {
    if (typeof body.tracked !== 'boolean') {
      return res.status(400).json({ success: false, error: 'tracked must be a boolean' });
    }
    patch.tracked = body.tracked;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'No patchable fields provided. Accepted: price, points, alertEnabled, tracked' });
  }

  try {
    const userId  = req.user?.id ?? null;
    const updated = store.patchOne(id, patch, userId);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Extreme not found' });
    }
    console.log(`[tracked-extremes] patched id=${id} fields=${Object.keys(patch).join(',')}`);
    return res.json({ success: true, extreme: updated });
  } catch (err) {
    console.error(`[tracked-extremes] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/tracked-extremes/patch-many ───────────────────────
//
// Request body:
// {
//   "ids": [1, 2, 3],
//   "patch": { "alertEnabled": true }
// }
//
// Response 200:
// { success: true, count: number }
function patchManyHandler(req, res) {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'patch must be a non-empty object' });
  }

  const PATCHABLE = new Set(['price', 'points', 'alertEnabled', 'tracked']);
  const unknown   = Object.keys(patch).filter(k => !PATCHABLE.has(k));
  if (unknown.length > 0) {
    return res.status(400).json({ success: false, error: `Unknown patch fields: ${unknown.join(', ')}. Accepted: ${[...PATCHABLE].join(', ')}` });
  }

  try {
    const userId = req.user?.id ?? null;
    const count = store.patchMany(ids, patch, userId);
    console.log(`[tracked-extremes] patch-many count=${count} fields=${Object.keys(patch).join(',')}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-extremes] patch-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  bulkHandler,
  listHandler,
  deleteOneHandler,
  deleteManyHandler,
  patchOneHandler,
  patchManyHandler,
};
