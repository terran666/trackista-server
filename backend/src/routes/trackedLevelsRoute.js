'use strict';

const store = require('../services/trackedLevelsStore');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);
const VALID_INTERVALS    = new Set([
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M',
]);

// POST /api/tracked-levels/bulk
// Expected body:
// {
//   symbol:     string          e.g. "BTCUSDT"
//   marketType: "spot"|"futures"
//   tf:         "1m"|"3m"|"5m"|"15m"|"30m"|"1h"|"2h"|"4h"|"6h"|"8h"|"12h"|"1d"|"3d"|"1w"|"1M"
//   source:     string          e.g. "autolevels"
//   levels:     array           e.g. [{ price, side, type, touches, score, virgin, formationTimestamp, drawFromTimestamp }]
// }
function bulkHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, tf, source, levels } = body;

  function fail(reason) {
    console.log(`[tracked-levels] bulk validation failed reason=${reason}`);
    return res.status(400).json({ success: false, error: reason });
  }

  if (!symbol || typeof symbol !== 'string') {
    return fail('Missing or invalid field: symbol (expected non-empty string, e.g. "BTCUSDT")');
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return fail(`Missing or invalid field: marketType (expected one of: ${[...VALID_MARKET_TYPES].join(', ')})`);
  }
  if (!VALID_INTERVALS.has(tf)) {
    return fail(`Missing or invalid field: tf (expected one of: ${[...VALID_INTERVALS].join(', ')})`);
  }
  if (!source || typeof source !== 'string') {
    return fail('Missing or invalid field: source (expected non-empty string, e.g. "autolevels")');
  }
  if (!Array.isArray(levels)) {
    return fail('Missing or invalid field: levels (expected array)');
  }

  try {
    const created = store.bulkSave({ symbol, marketType, tf, source, levels });
    console.log(`[tracked-levels] bulk saved symbol=${symbol.toUpperCase()} marketType=${marketType} tf=${tf} source=${source} count=${created.length}`);
    return res.status(200).json({ success: true, count: created.length, levels: created });
  } catch (err) {
    console.error('[tracked-levels] bulk save error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// GET /api/tracked-levels?symbol=BTCUSDT&marketType=futures&tf=5m&source=autolevels
function listHandler(req, res) {
  const { symbol, marketType, tf, source } = req.query;

  try {
    const levels = store.getAll({ symbol, marketType, tf, source });
    console.log(`[tracked-levels] list symbol=${symbol} marketType=${marketType} tf=${tf} source=${source} count=${levels.length}`);
    return res.json({ success: true, count: levels.length, levels });
  } catch (err) {
    console.error('[tracked-levels] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// DELETE /api/tracked-levels/:id
function deleteOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const removed = store.removeOne(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Level not found' });
    }
    console.log(`[tracked-levels] deleted id=${id}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[tracked-levels] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// POST /api/tracked-levels/delete-many
function deleteManyHandler(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }

  try {
    const count = store.removeMany(ids);
    console.log(`[tracked-levels] delete-many count=${count}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-levels] delete-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// PATCH /api/tracked-levels/:id
function patchOneHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }
  const patch = req.body || {};
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'Patch body is empty' });
  }
  if (patch.price !== undefined) {
    const p = parseFloat(patch.price);
    if (isNaN(p) || p <= 0) {
      return res.status(400).json({ success: false, error: 'price must be a positive number' });
    }
    patch.price = p;
  }

  try {
    const updated = store.patchOne(id, patch);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Level not found' });
    }
    const priceLog = patch.price !== undefined ? ` price=${updated.price}` : '';
    console.log(`[tracked-levels] updated id=${id}${priceLog}`);
    return res.json({ success: true, level: updated });
  } catch (err) {
    console.error(`[tracked-levels] patch error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// POST /api/tracked-levels/patch-many
function patchManyHandler(req, res) {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: 'patch must be a non-empty object' });
  }

  try {
    const count = store.patchMany(ids, patch);
    console.log(`[tracked-levels] patch-many count=${count}`);
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[tracked-levels] patch-many error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = { bulkHandler, listHandler, deleteOneHandler, deleteManyHandler, patchOneHandler, patchManyHandler };
