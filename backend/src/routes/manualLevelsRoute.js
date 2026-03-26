'use strict';

const store = require('../services/manualLevelsStore');

const VALID_MARKET_TYPES = new Set(['spot', 'futures', 'synthetic']);
const VALID_SIDES        = new Set(['support', 'resistance']);
const VALID_INTERVALS    = new Set([
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M',
]);

// POST /api/manual-levels
function createHandler(req, res) {
  const body = req.body || {};
  const { symbol, marketType, tf, price, side, createdAt } = body;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid symbol' });
  }
  if (!VALID_MARKET_TYPES.has(marketType)) {
    return res.status(400).json({ success: false, error: `marketType must be one of: ${[...VALID_MARKET_TYPES].join(', ')}` });
  }
  if (!VALID_INTERVALS.has(tf)) {
    return res.status(400).json({ success: false, error: `tf must be a valid interval` });
  }
  if (price === undefined || price === null || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
    return res.status(400).json({ success: false, error: 'price must be a positive number' });
  }
  if (!VALID_SIDES.has(side)) {
    return res.status(400).json({ success: false, error: `side must be one of: ${[...VALID_SIDES].join(', ')}` });
  }

  try {
    const level = store.create({ symbol, marketType, tf, price, side, createdAt });
    console.log(`[manual-levels] created id=${level.id} symbol=${level.symbol} price=${level.price}`);
    return res.status(201).json({ success: true, level });
  } catch (err) {
    console.error('[manual-levels] create error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// GET /api/manual-levels?symbol=BTCUSDT&marketType=futures&tf=5m
function listHandler(req, res) {
  const { symbol, marketType, tf } = req.query;

  try {
    const levels = store.getAll({ symbol, marketType, tf });
    console.log(`[manual-levels] list symbol=${symbol} marketType=${marketType} tf=${tf} count=${levels.length}`);
    return res.json({ success: true, count: levels.length, levels });
  } catch (err) {
    console.error('[manual-levels] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// DELETE /api/manual-levels/:id
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
    console.log(`[manual-levels] deleted id=${id}`);
    return res.json({ success: true, id: removed.id });
  } catch (err) {
    console.error(`[manual-levels] delete error id=${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// PATCH /api/manual-levels/:id — update price and/or side after drag
function patchHandler(watchLoader) {
  return function(req, res) {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    const { price, side } = req.body || {};
    const updates = {};

    if (price !== undefined) {
      const p = parseFloat(price);
      if (!isFinite(p) || p <= 0) {
        return res.status(400).json({ success: false, error: 'price must be a positive number' });
      }
      updates.price = p;
    }
    if (side !== undefined) {
      if (!VALID_SIDES.has(side)) {
        return res.status(400).json({ success: false, error: `side must be one of: ${[...VALID_SIDES].join(', ')}` });
      }
      updates.side = side;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }

    try {
      const existing = store.getById(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Level not found' });
      }
      const updated = store.patch(id, updates);
      console.log(`[manual-levels] patched id=${id}`, updates);
      // Reload watch engine so it uses the new price immediately
      if (watchLoader) watchLoader.invalidate();
      return res.json({ success: true, level: updated });
    } catch (err) {
      console.error(`[manual-levels] patch error id=${id}:`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createHandler, listHandler, deleteHandler, patchHandler };
