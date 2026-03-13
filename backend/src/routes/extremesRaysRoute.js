'use strict';

const store = require('../services/extremesRaysStore');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_SIDES        = new Set(['support', 'resistance']);
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
  return Array.isArray(points) && points.length === 2 && points.every(isValidPoint);
}

// ─── POST /api/extremes-rays ──────────────────────────────────────
//
// Request body:
// {
//   rayId:      string   — client-generated stable ID (uuid or similar)
//   symbol:     string   — e.g. "BTCUSDT"
//   marketType: string   — "spot" | "futures"
//   tf:         string   — e.g. "5m"
//   side:       string   — "support" | "resistance"
//   points:     Array<{ timestamp: number, value: number }>  — exactly 2 anchors
// }
//
// Response 201:
// { success: true, ray: { id, rayId, symbol, marketType, tf, source, side, points, createdAt, updatedAt } }
function createHandler(req, res) {
  const body = req.body || {};
  const { rayId, symbol, marketType, tf, side, points } = body;

  if (!rayId || typeof rayId !== 'string' || rayId.trim() === '') {
    return res.status(400).json({ success: false, error: 'Missing or invalid field: rayId (expected non-empty string)' });
  }
  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    return res.status(400).json({ success: false, error: 'Missing or invalid field: symbol (expected non-empty string, e.g. "BTCUSDT")' });
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return res.status(400).json({ success: false, error: `Missing or invalid field: marketType (expected one of: ${[...VALID_MARKET_TYPES].join(', ')})` });
  }
  if (!VALID_INTERVALS.has(tf)) {
    return res.status(400).json({ success: false, error: `Missing or invalid field: tf (expected one of: ${[...VALID_INTERVALS].join(', ')})` });
  }
  if (!VALID_SIDES.has(side)) {
    return res.status(400).json({ success: false, error: `Missing or invalid field: side (expected one of: ${[...VALID_SIDES].join(', ')})` });
  }
  if (!isValidPoints(points)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid field: points (expected array of exactly 2 objects with {timestamp: number, value: number})' });
  }

  try {
    const ray = store.create({ rayId: rayId.trim(), symbol, marketType, tf, side, points });
    console.log(`[extremes-rays] created id=${ray.id} rayId=${ray.rayId} symbol=${ray.symbol} tf=${ray.tf} side=${ray.side}`);
    return res.status(201).json({ success: true, ray });
  } catch (err) {
    console.error('[extremes-rays] create error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── PATCH /api/extremes-rays/:id ────────────────────────────────
//
// Request body (all fields optional, at least one required):
// {
//   side?:   "support" | "resistance"
//   points?: Array<{ timestamp: number, value: number }>  — exactly 2 anchors
// }
//
// Response 200:
// { success: true, ray: { id, rayId, symbol, marketType, tf, source, side, points, createdAt, updatedAt } }
function patchHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  const body = req.body || {};
  const { side, points } = body;
  const patch = {};

  if (side !== undefined) {
    if (!VALID_SIDES.has(side)) {
      return res.status(400).json({ success: false, error: `Invalid field: side (expected one of: ${[...VALID_SIDES].join(', ')})` });
    }
    patch.side = side;
  }

  if (points !== undefined) {
    if (!isValidPoints(points)) {
      return res.status(400).json({ success: false, error: 'Invalid field: points (expected array of exactly 2 objects with {timestamp: number, value: number})' });
    }
    patch.points = points;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'No patchable fields provided. Accepted: side, points' });
  }

  try {
    const ray = store.patch(id, patch);
    if (!ray) {
      return res.status(404).json({ success: false, error: 'Ray not found' });
    }
    console.log(`[extremes-rays] patched id=${id} fields=${Object.keys(patch).join(',')}`);
    return res.json({ success: true, ray });
  } catch (err) {
    console.error(`[extremes-rays] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── DELETE /api/extremes-rays/:id ───────────────────────────────
//
// Response 200:
// { success: true, id: number }
function deleteHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const removed = store.remove(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Ray not found' });
    }
    console.log(`[extremes-rays] deleted id=${id} rayId=${removed.rayId} symbol=${removed.symbol}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[extremes-rays] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── GET /api/extremes-rays ───────────────────────────────────────
//
// Query params (all optional):
//   symbol     — e.g. "BTCUSDT"
//   marketType — "spot" | "futures"
//   tf         — e.g. "5m"
//
// Response 200:
// { success: true, count: number, rays: Ray[] }
function listHandler(req, res) {
  const { symbol, marketType, tf } = req.query;

  try {
    const rays = store.getAll({ symbol, marketType, tf });
    console.log(`[extremes-rays] list symbol=${symbol} marketType=${marketType} tf=${tf} count=${rays.length}`);
    return res.json({ success: true, count: rays.length, rays });
  } catch (err) {
    console.error('[extremes-rays] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = { createHandler, patchHandler, deleteHandler, listHandler };
