'use strict';

const store = require('../services/manualSlopedLevelsStore');
const { getLineValueAtTimestamp } = require('../engines/rays/rayGeometry');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_SIDES        = new Set(['support', 'resistance']);
const VALID_KINDS        = new Set(['ray', 'line']);

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

function validatePoints(points) {
  if (!Array.isArray(points) || points.length !== 2 || !points.every(isValidPoint)) {
    return 'points must be an array of exactly 2 objects with {timestamp: number, value: number}';
  }
  if (points[0].timestamp === points[1].timestamp) {
    return 'points: both anchor points must have different timestamps';
  }
  return null;
}

// ─── POST /api/manual-sloped-levels ──────────────────────────────
//
// Body:
// {
//   symbol:     string            e.g. "BTCUSDT"
//   marketType: "spot"|"futures"
//   source:     string            optional, default "manual-sloped-level"
//   side:       "support"|"resistance"
//   kind:       "ray"|"line"      optional, default "ray"
//   shape:      "sloped"          optional, always stored as "sloped"
//   points:     [{timestamp, value}, {timestamp, value}]   required
// }
//
// Response 201:
// { success: true, level: ManualSlopedLevel }
function createHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, source, side, kind, shape, points } = body;

  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    return res.status(400).json({ success: false, error: 'Missing or invalid field: symbol' });
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return res.status(400).json({ success: false, error: `marketType must be one of: ${[...VALID_MARKET_TYPES].join(', ')}` });
  }
  if (!VALID_SIDES.has(side)) {
    return res.status(400).json({ success: false, error: `side must be one of: ${[...VALID_SIDES].join(', ')}` });
  }
  if (kind !== undefined && !VALID_KINDS.has(kind)) {
    return res.status(400).json({ success: false, error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` });
  }

  const pointsErr = validatePoints(points);
  if (pointsErr) {
    return res.status(400).json({ success: false, error: pointsErr });
  }

  try {
    const level = store.create({ symbol, marketType, source, side, kind, shape, points });
    console.log(`[manual-sloped-levels] created id=${level.id} symbol=${level.symbol} side=${level.side}`);
    return res.status(201).json({ success: true, level });
  } catch (err) {
    console.error('[manual-sloped-levels] create error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/manual-sloped-levels ───────────────────────────────
//
// Query params (required): symbol, marketType
// No tf param — manual sloped levels are tf-agnostic.
//
// Response 200:
// { success: true, count: number, levels: ManualSlopedLevel[] }
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
    const levels = store.getAll({ symbol, marketType });
    console.log(`[manual-sloped-levels] listed symbol=${symbol.toUpperCase()} marketType=${marketType} count=${levels.length}`);
    return res.json({ success: true, count: levels.length, levels });
  } catch (err) {
    console.error('[manual-sloped-levels] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── DELETE /api/manual-sloped-levels/:id ────────────────────────
//
// Response 200: { success: true, id: number }
// Response 404: { success: false, error: 'Level not found' }
function deleteHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const removed = store.remove(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Level not found' });
    }
    console.log(`[manual-sloped-levels] deleted id=${id} symbol=${removed.symbol}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[manual-sloped-levels] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── PATCH /api/manual-sloped-levels/:id ─────────────────────────
//
// Patchable fields: points, side, alertEnabled, tracked
//
// Examples:
//   Drag line:          { "points": [{...}, {...}] }
//   Flip side:          { "side": "resistance" }
//   Toggle alert:       { "alertEnabled": true }
//   Toggle tracking:    { "tracked": true }
//
// Response 200: { success: true, level: ManualSlopedLevel }
// Response 404: { success: false, error: 'Level not found' }
function patchHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  const body = req.body || {};
  if (Object.keys(body).length === 0) {
    return res.status(400).json({ success: false, error: 'Patch body is empty' });
  }

  const changes = {};

  if (body.points !== undefined) {
    const err = validatePoints(body.points);
    if (err) return res.status(400).json({ success: false, error: err });
    changes.points = body.points;
  }
  if (body.side !== undefined) {
    if (!VALID_SIDES.has(body.side)) {
      return res.status(400).json({ success: false, error: `side must be one of: ${[...VALID_SIDES].join(', ')}` });
    }
    changes.side = body.side;
  }
  if (body.alertEnabled !== undefined) {
    if (typeof body.alertEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'alertEnabled must be a boolean' });
    }
    changes.alertEnabled = body.alertEnabled;
  }
  if (body.tracked !== undefined) {
    if (typeof body.tracked !== 'boolean') {
      return res.status(400).json({ success: false, error: 'tracked must be a boolean' });
    }
    changes.tracked = body.tracked;
  }

  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ success: false, error: 'No patchable fields provided (allowed: points, side, alertEnabled, tracked)' });
  }

  try {
    const updated = store.patch(id, changes);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Level not found' });
    }
    console.log(`[manual-sloped-levels] patched id=${id} fields=${Object.keys(changes).join(',')}`);
    return res.json({ success: true, level: updated });
  } catch (err) {
    console.error(`[manual-sloped-levels] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/manual-sloped-levels/:id/value ─────────────────────
//
// Returns the line's interpolated value at a given timestamp.
// Useful for alert engine: "where is this line RIGHT NOW?"
//
// Query params: timestamp (ms)
//
// Response 200: { success: true, id, timestamp, value }
function lineValueHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }
  const ts = parseFloat(req.query.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return res.status(400).json({ success: false, error: 'Query param timestamp must be a positive number (ms)' });
  }

  try {
    const all   = store.getAll();
    const level = all.find(l => l.id === id);
    if (!level) {
      return res.status(404).json({ success: false, error: 'Level not found' });
    }
    const value = getLineValueAtTimestamp(level.points, ts);
    return res.json({ success: true, id, timestamp: ts, value });
  } catch (err) {
    console.error(`[manual-sloped-levels] value error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { createHandler, listHandler, deleteHandler, patchHandler, lineValueHandler };
