'use strict';

const store       = require('../services/trackedRaysStore');
const { getLineValueAtTimestamp } = require('../engines/rays/rayGeometry');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_SIDES        = new Set(['support', 'resistance']);
const VALID_SHAPES       = new Set(['horizontal', 'sloped']);
const VALID_KINDS        = new Set(['level', 'extreme', 'ray', 'line']);
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

// Sloped rays require exactly 2 anchor points
function isValidSlopedPoints(points) {
  return Array.isArray(points) && points.length === 2 && points.every(isValidPoint);
}

function validatePoints(points, label) {
  if (!isValidSlopedPoints(points)) {
    return `${label} must be an array of exactly 2 objects with {timestamp: number, value: number}`;
  }
  if (points[0].timestamp === points[1].timestamp) {
    return `${label}: both anchor points must have different timestamps`;
  }
  return null;
}

// ─── POST /api/tracked-rays/bulk ─────────────────────────────────
//
// Request body:
// {
//   symbol:     string            e.g. "BTCUSDT"
//   marketType: "spot"|"futures"
//   tf:         string            e.g. "5m"
//   source:     string            e.g. "extremes-rays"
//   rays: [
//     {
//       side:     "support"|"resistance"
//       kind:     "level"|"extreme"|"ray"   (optional, default "ray")
//       shape:    "horizontal"|"sloped"      (optional, default "sloped")
//       price:    number                     (required for horizontal, optional cache for sloped)
//       points:   [{timestamp,value},{timestamp,value}]  (required for sloped)
//       strength: number  (optional)
//       touches:  number  (optional)
//     }
//   ]
// }
//
// Response 200:
// { success: true, count: number, rays: Ray[] }
function bulkHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, tf, source, rays } = body;

  function fail(reason) {
    console.log(`[tracked-rays] bulk validation failed reason=${reason}`);
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
    return fail('Missing or invalid field: source (expected non-empty string)');
  }
  if (!Array.isArray(rays)) {
    return fail('Missing or invalid field: rays (expected array)');
  }

  console.log(`[tracked-rays] bulk input symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${rays.length}`);

  for (let i = 0; i < rays.length; i++) {
    const r = rays[i];
    if (!VALID_SIDES.has(r.side)) {
      return fail(`rays[${i}].side must be one of: ${[...VALID_SIDES].join(', ')}`);
    }
    if (r.kind !== undefined && !VALID_KINDS.has(r.kind)) {
      return fail(`rays[${i}].kind must be one of: ${[...VALID_KINDS].join(', ')}`);
    }
    const shape = r.shape || 'sloped';
    if (!VALID_SHAPES.has(shape)) {
      return fail(`rays[${i}].shape must be one of: ${[...VALID_SHAPES].join(', ')}`);
    }
    if (shape === 'horizontal') {
      if (r.price === undefined || r.price === null || isNaN(parseFloat(r.price)) || parseFloat(r.price) <= 0) {
        return fail(`rays[${i}].price is required and must be a positive number for shape=horizontal`);
      }
    }
    if (shape === 'sloped') {
      const pointsErr = validatePoints(r.points, `rays[${i}].points`);
      if (pointsErr) return fail(pointsErr);
    }
  }

  try {
    const result = store.bulkSave({ symbol, marketType, tf, source, rays });
    if (result.skipped) {
      console.log(`[tracked-rays] bulk skipped unchanged snapshot symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${result.items.length}`);
      return res.status(200).json({ success: true, skipped: true, count: result.items.length, rays: result.items });
    }
    console.log(`[tracked-rays] bulk replaced snapshot symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${result.items.length}`);
    return res.status(200).json({ success: true, skipped: false, count: result.items.length, rays: result.items });
  } catch (err) {
    console.error('[tracked-rays] bulk save error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/tracked-rays ───────────────────────────────────────
//
// Query params (all optional): symbol, marketType, tf, source
//
// Response 200:
// { success: true, count: number, rays: Ray[] }
function listHandler(req, res) {
  const { symbol, marketType, tf, source } = req.query;

  try {
    const rays = store.getAll({ symbol, marketType, tf, source });
    console.log(`[tracked-rays] listed symbol=${symbol} marketType=${marketType} tf=${tf} source=${source} count=${rays.length}`);
    return res.json({ success: true, count: rays.length, rays });
  } catch (err) {
    console.error('[tracked-rays] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── DELETE /api/tracked-rays/:id ────────────────────────────────
//
// Response 200: { success: true, id: number }
// Response 404: { success: false, error: 'Ray not found' }
function deleteOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const removed = store.removeOne(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Ray not found' });
    }
    console.log(`[tracked-rays] deleted id=${id} symbol=${removed.symbol} shape=${removed.shape}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[tracked-rays] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── PATCH /api/tracked-rays/:id ─────────────────────────────────
//
// Patchable fields: points, price, alertEnabled, tracked
//
// Examples:
//   Drag sloped ray:      { "points": [{...}, {...}] }
//   Drag horizontal:      { "price": 84300 }
//   Toggle alert:         { "alertEnabled": true }
//   Toggle tracking:      { "tracked": true }
//
// Response 200: { success: true, ray: Ray }
// Response 404: { success: false, error: 'Ray not found' }
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

  if (body.points !== undefined) {
    const pointsErr = validatePoints(body.points, 'points');
    if (pointsErr) {
      return res.status(400).json({ success: false, error: pointsErr });
    }
    patch.points = body.points;
  }

  if (body.price !== undefined) {
    const p = parseFloat(body.price);
    if (isNaN(p) || p <= 0) {
      return res.status(400).json({ success: false, error: 'price must be a positive number' });
    }
    patch.price = p;
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
    return res.status(400).json({ success: false, error: 'No patchable fields provided. Accepted: points, price, alertEnabled, tracked' });
  }

  try {
    const updated = store.patchOne(id, patch);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Ray not found' });
    }
    console.log(`[tracked-rays] patched id=${id} fields=${Object.keys(patch).join(',')}`);
    return res.json({ success: true, ray: updated });
  } catch (err) {
    console.error(`[tracked-rays] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/tracked-rays/delete-many ─────────────────────────
//
// Request body:
// { "ids": [1, 2, 3] }
//
// Response 200: { success: true, count: number }
function deleteManyHandler(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }

  try {
    const count = store.removeMany(ids);
    console.log(`[tracked-rays] delete-many count=${count}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-rays] delete-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/tracked-rays/patch-many ───────────────────────────
//
// Request body:
// { "ids": [1, 2, 3], "patch": { "alertEnabled": true } }
//
// Accepted patch fields: points, price, alertEnabled, tracked
//
// Response 200: { success: true, count: number }
function patchManyHandler(req, res) {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'patch must be a non-empty object' });
  }

  const PATCHABLE = new Set(['points', 'price', 'alertEnabled', 'tracked']);
  const unknown   = Object.keys(patch).filter(k => !PATCHABLE.has(k));
  if (unknown.length > 0) {
    return res.status(400).json({ success: false, error: `Unknown patch fields: ${unknown.join(', ')}. Accepted: ${[...PATCHABLE].join(', ')}` });
  }

  try {
    const count = store.patchMany(ids, patch);
    console.log(`[tracked-rays] patch-many count=${count} fields=${Object.keys(patch).join(',')}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-rays] patch-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/tracked-rays/:id/value?ts=<timestamp> ──────────────
//
// Compute the line's value at a given timestamp for a sloped ray.
// Useful for alert engine proximity checks.
//
// Query param: ts (required) — timestamp in milliseconds
//
// Response 200: { success: true, id, ts, lineValue }
// Response 400: { success: false, error }
// Response 404: { success: false, error: 'Ray not found' }
function lineValueHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  const ts = parseInt(req.query.ts, 10);
  if (isNaN(ts) || ts <= 0) {
    return res.status(400).json({ success: false, error: 'Query param ts must be a positive integer timestamp in ms' });
  }

  try {
    const [ray] = store.getAll({}).filter(r => r.id === id);
    if (!ray) {
      return res.status(404).json({ success: false, error: 'Ray not found' });
    }
    if (ray.shape !== 'sloped' || !ray.points) {
      return res.status(400).json({ success: false, error: `Ray id=${id} is not sloped or has no points` });
    }

    const lineValue = getLineValueAtTimestamp(ray.points, ts);
    console.log(`[tracked-rays] line value calculated id=${id} ts=${ts} value=${lineValue}`);
    return res.json({ success: true, id, ts, lineValue });
  } catch (err) {
    console.error(`[tracked-rays] line value error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = { bulkHandler, listHandler, deleteOneHandler, deleteManyHandler, patchOneHandler, patchManyHandler, lineValueHandler };
