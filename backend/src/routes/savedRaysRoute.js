'use strict';

const store = require('../services/savedRaysStore');

const VALID_MARKET_TYPES = new Set(['spot', 'futures', 'synthetic']);
const VALID_SIDES        = new Set(['support', 'resistance']);
const VALID_SHAPES       = new Set(['horizontal', 'sloped']);
const VALID_KINDS        = new Set(['ray', 'line', 'level', 'extreme']);

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

function validateSlopedPoints(points, label) {
  if (!Array.isArray(points) || points.length !== 2 || !points.every(isValidPoint)) {
    return `${label} must be an array of exactly 2 objects with {timestamp: number, value: number}`;
  }
  if (points[0].timestamp === points[1].timestamp) {
    return `${label}: both anchor points must have different timestamps`;
  }
  return null;
}

// ─── POST /api/saved-rays/bulk ────────────────────────────────────
//
// Additive save: does NOT wipe existing saved rays.
// Deduplication is per-ray by geometry fingerprint.
//
// Body:
// {
//   symbol:                 string            e.g. "BTCUSDT"
//   marketType:             "spot"|"futures"
//   source:                 string            optional, default "saved-rays"
//   createdFrom:            string            optional, e.g. "vertical-extremes"
//   visibleOnAllTimeframes: boolean           informational, always stored as true
//   persistent:             boolean           informational, always stored as true
//   rays: [
//     {
//       side:     "support"|"resistance"
//       kind:     "ray"|"line"              (optional, default "ray")
//       shape:    "sloped"|"horizontal"     (optional, default "sloped")
//       points:   [{timestamp,value},{timestamp,value}]  (required for sloped)
//       strength: number   (optional)
//       touches:  number   (optional)
//     }
//   ]
// }
//
// Response 200:
// { success: true, savedCount: number, skippedCount: number, rays: Ray[] }
function bulkHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, source, createdFrom, visibleOnAllTimeframes, persistent, rays } = body;

  // Log the raw incoming envelope so validation failures are easy to diagnose.
  const bodyPreview = {
    symbol,
    marketType,
    source,
    createdFrom,
    visibleOnAllTimeframes,
    persistent,
    raysCount: Array.isArray(rays) ? rays.length : rays,
    firstRay:  Array.isArray(rays) && rays.length > 0 ? rays[0] : undefined,
  };
  console.log(`[saved-rays] bulk received body=${JSON.stringify(bodyPreview)}`);

  function fail(reason, extra) {
    console.log(`[saved-rays] bulk validation failed reason=${reason}`);
    if (extra !== undefined) {
      console.log(`[saved-rays] invalid body=${JSON.stringify(extra)}`);
    }
    return res.status(400).json({ success: false, error: reason });
  }

  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    return fail('Missing or invalid field: symbol (expected non-empty string, e.g. "BTCUSDT")', { symbol });
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return fail(`Missing or invalid field: marketType (expected one of: ${[...VALID_MARKET_TYPES].join(', ')})`, { marketType });
  }
  if (!Array.isArray(rays) || rays.length === 0) {
    return fail('Missing or invalid field: rays (expected non-empty array)', { rays });
  }

  console.log(`[saved-rays] bulk input symbol=${symbol.toUpperCase()} marketType=${marketType} source=${source || 'saved-rays'} createdFrom=${createdFrom || 'unknown'} count=${rays.length}`);

  for (let i = 0; i < rays.length; i++) {
    const r = rays[i];

    if (!VALID_SIDES.has(r.side)) {
      return fail(`rays[${i}].side must be one of: ${[...VALID_SIDES].join(', ')}`, { i, side: r.side });
    }
    if (r.kind !== undefined && !VALID_KINDS.has(r.kind)) {
      return fail(`rays[${i}].kind must be one of: ${[...VALID_KINDS].join(', ')}`, { i, kind: r.kind });
    }

    const shape = r.shape || 'sloped';
    if (!VALID_SHAPES.has(shape)) {
      return fail(`rays[${i}].shape must be one of: ${[...VALID_SHAPES].join(', ')}`, { i, shape });
    }
    if (shape === 'sloped') {
      const err = validateSlopedPoints(r.points, `rays[${i}].points`);
      if (err) return fail(err, { i, points: r.points });
    }
    if (shape === 'horizontal') {
      if (r.price == null || isNaN(parseFloat(r.price)) || parseFloat(r.price) <= 0) {
        return fail(`rays[${i}].price is required and must be a positive number for shape=horizontal`, { i, price: r.price });
      }
    }
  }

  try {
    const { replaced, oldCount } = store.bulkSave({
      symbol, marketType, source, createdFrom, visibleOnAllTimeframes, persistent, rays,
    });

    const sym = symbol.toUpperCase();
    if (oldCount > 0) {
      console.log(`[saved-rays] replacing existing snapshot symbol=${sym} marketType=${marketType} createdFrom=${createdFrom || 'unknown'}`);
      console.log(`[saved-rays] old count=${oldCount}`);
    }
    console.log(`[saved-rays] bulk saved symbol=${sym} marketType=${marketType} createdFrom=${createdFrom || 'unknown'} count=${replaced.length}`);
    console.log(`[saved-rays] new count=${replaced.length}`);

    return res.status(200).json({
      success:  true,
      count:    replaced.length,
      replaced: oldCount > 0,
      oldCount,
      rays:     replaced,
    });
  } catch (err) {
    console.error('[saved-rays] bulk save error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/saved-rays ─────────────────────────────────────────
//
// Query params (required): symbol, marketType.
// No tf filter — saved rays are visible on all timeframes.
//
// Response 200:
// { success: true, count: number, rays: Ray[] }
function listHandler(req, res) {
  const { symbol, marketType } = req.query;

  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    return res.status(400).json({ success: false, error: 'Query param symbol is required' });
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return res.status(400).json({
      success: false,
      error: `Query param marketType must be one of: ${[...VALID_MARKET_TYPES].join(', ')}`,
    });
  }

  try {
    const rays = store.getAll({ symbol, marketType });
    console.log(`[saved-rays] listed symbol=${symbol.toUpperCase()} marketType=${marketType} count=${rays.length}`);
    for (const r of rays) {
      console.log(`[saved-rays] list id=${r.id} points=${JSON.stringify(r.points)} updatedAt=${r.updatedAt}`);
    }
    return res.json({ success: true, count: rays.length, rays });
  } catch (err) {
    console.error('[saved-rays] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── DELETE /api/saved-rays/:id ──────────────────────────────────
//
// Response 200: { success: true, id: number }
// Response 404: { success: false, error: 'Saved ray not found' }
function deleteOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const removed = store.removeOne(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Saved ray not found' });
    }
    console.log(`[saved-rays] deleted id=${id} symbol=${removed.symbol}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[saved-rays] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── PATCH /api/saved-rays/:id ───────────────────────────────────
//
// Patchable fields: points, alertEnabled, tracked.
// Patching points updates the geometry fingerprint so the old geometry can be
// re-saved later without being treated as a duplicate.
//
// Response 200: { success: true, ray: Ray }
// Response 404: { success: false, error: 'Saved ray not found' }
function patchOneHandler(req, res) {
  if (typeof req.params.id === 'string' && req.params.id.startsWith('local_')) {
    return res.status(404).json({ success: false, error: 'Saved ray not found (local id not yet synced)' });
  }
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
    const err = validateSlopedPoints(body.points, 'points');
    if (err) return res.status(400).json({ success: false, error: err });
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
    return res.status(400).json({ success: false, error: 'No patchable fields provided (allowed: points, alertEnabled, tracked)' });
  }

  try {
    const updated = store.patchOne(id, patch);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Saved ray not found' });
    }
    console.log(`[saved-rays] patched id=${id} fields=${Object.keys(patch).join(',')} points=${JSON.stringify(updated.points)} updatedAt=${updated.updatedAt}`);
    return res.json({ success: true, ray: updated });
  } catch (err) {
    console.error(`[saved-rays] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/saved-rays/delete-many ────────────────────────────
//
// Body: { ids: number[] }
// Response 200: { success: true, deletedCount: number }
function deleteManyHandler(req, res) {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array of numbers' });
  }
  if (!ids.every(id => Number.isInteger(id) && id > 0)) {
    return res.status(400).json({ success: false, error: 'All ids must be positive integers' });
  }

  try {
    const deletedCount = store.removeMany(ids);
    console.log(`[saved-rays] delete-many ids=[${ids.join(',')}] deletedCount=${deletedCount}`);
    return res.json({ success: true, deletedCount });
  } catch (err) {
    console.error('[saved-rays] delete-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── POST /api/saved-rays/patch-many ─────────────────────────────
//
// Body: { ids: number[], patch: { alertEnabled?: boolean, tracked?: boolean } }
// Response 200: { success: true, updatedCount: number }
function patchManyHandler(req, res) {
  const { ids, patch } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array of numbers' });
  }
  if (!ids.every(id => Number.isInteger(id) && id > 0)) {
    return res.status(400).json({ success: false, error: 'All ids must be positive integers' });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ success: false, error: 'patch must be an object' });
  }

  const allowed    = new Set(['alertEnabled', 'tracked']);
  const patchKeys  = Object.keys(patch);
  const invalid    = patchKeys.filter(k => !allowed.has(k));
  if (invalid.length > 0) {
    return res.status(400).json({ success: false, error: `Unknown patch fields: ${invalid.join(', ')}. Allowed: ${[...allowed].join(', ')}` });
  }
  if (patchKeys.length === 0) {
    return res.status(400).json({ success: false, error: 'patch object has no fields' });
  }
  if (patch.alertEnabled !== undefined && typeof patch.alertEnabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'patch.alertEnabled must be a boolean' });
  }
  if (patch.tracked !== undefined && typeof patch.tracked !== 'boolean') {
    return res.status(400).json({ success: false, error: 'patch.tracked must be a boolean' });
  }

  try {
    const updatedCount = store.patchMany(ids, patch);
    console.log(`[saved-rays] patch-many ids=[${ids.join(',')}] fields=${patchKeys.join(',')} updatedCount=${updatedCount}`);
    return res.json({ success: true, updatedCount });
  } catch (err) {
    console.error('[saved-rays] patch-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  bulkHandler,
  listHandler,
  deleteOneHandler,
  patchOneHandler,
  deleteManyHandler,
  patchManyHandler,
};
