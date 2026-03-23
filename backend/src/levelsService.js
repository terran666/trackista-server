'use strict';

// ─── Allowed values ───────────────────────────────────────────────
const ALLOWED_TYPES = new Set([
  'support', 'resistance', 'manual', 'high', 'low', 'cluster', 'density',
]);

const ALLOWED_SOURCES = new Set([
  'manual', 'auto', 'auto_swing', 'auto_extreme', 'auto_cluster', 'auto_density',
]);

const REDIS_TTL = 300; // cache levels for 5 minutes (refreshed on any write)

// ─── Row → API object ─────────────────────────────────────────────
function rowToLevel(row) {
  return {
    id:           row.id,
    symbol:       row.symbol,
    price:        parseFloat(row.price),
    type:         row.type,
    source:       row.source,
    strength:     row.strength !== null ? row.strength : null,
    timeframe:    row.timeframe || null,
    isActive:     Boolean(row.is_active),
    market:       row.market        || 'futures',
    geometryType: row.geometry_type || 'horizontal',
    side:         row.side          || null,
    // Watch fields (present only when watch columns exist on the table)
    watchEnabled:   row.watch_enabled   !== undefined ? Boolean(row.watch_enabled)   : undefined,
    watchMode:      row.watch_mode      !== undefined ? (row.watch_mode || 'off')     : undefined,
    alertEnabled:   row.alert_enabled   !== undefined ? Boolean(row.alert_enabled)   : undefined,
    lastTriggeredAt: row.last_triggered_at !== undefined ? (row.last_triggered_at ?? null) : undefined,
    triggerCount:   row.trigger_count   !== undefined ? (row.trigger_count ?? 0)     : undefined,
    meta:      row.meta_json ? (typeof row.meta_json === 'string' ? (() => { try { return JSON.parse(row.meta_json); } catch (_) { return null; } })() : row.meta_json) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// ─── Validation ───────────────────────────────────────────────────
function validateLevelPayload(payload, requireAll = true) {
  const errors = [];

  if (requireAll || payload.symbol !== undefined) {
    if (!payload.symbol || typeof payload.symbol !== 'string') errors.push('symbol is required and must be a string');
  }

  if (requireAll || payload.price !== undefined) {
    const price = Number(payload.price);
    if (payload.price === undefined || payload.price === null || isNaN(price) || price <= 0) {
      errors.push('price must be a positive number');
    }
  }

  if (requireAll || payload.type !== undefined) {
    if (!payload.type || !ALLOWED_TYPES.has(payload.type)) {
      errors.push(`type must be one of: ${[...ALLOWED_TYPES].join(', ')}`);
    }
  }

  if (payload.strength !== undefined && payload.strength !== null) {
    const s = Number(payload.strength);
    if (isNaN(s) || !Number.isInteger(s) || s < 0 || s > 100) {
      errors.push('strength must be an integer 0–100');
    }
  }

  if (payload.meta !== undefined && payload.meta !== null && typeof payload.meta !== 'object') {
    errors.push('meta must be an object or null');
  }

  return errors;
}

// ─── Service factory ──────────────────────────────────────────────
function createLevelsService(db, redis) {

  // Rebuild Redis cache for a symbol from MySQL (called after every write)
  async function rebuildLevelsCache(symbol) {
    const [rows] = await db.query(
      'SELECT * FROM levels WHERE symbol = ? AND is_active = TRUE ORDER BY price ASC',
      [symbol],
    );
    const levels = rows.map(rowToLevel);
    await redis.set(`levels:${symbol}`, JSON.stringify(levels), 'EX', REDIS_TTL);
    return levels;
  }

  // GET active levels — try Redis first, fall back to MySQL
  async function getActiveLevelsBySymbol(symbol) {
    const cached = await redis.get(`levels:${symbol}`);
    if (cached) {
      try { return JSON.parse(cached); } catch (_) {}
    }
    return rebuildLevelsCache(symbol);
  }

  // POST /api/levels/manual
  async function createManualLevel(payload) {
    const symbol   = payload.symbol.toUpperCase();
    const price    = Number(payload.price);
    const type     = payload.type;
    const source   = 'manual';
    const strength = payload.strength !== undefined ? Number(payload.strength) : null;
    const timeframe = payload.timeframe || null;
    const meta     = payload.meta || null;

    const [result] = await db.query(
      `INSERT INTO levels (symbol, price, type, source, strength, timeframe, is_active, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [symbol, price, type, source, strength, timeframe, meta ? JSON.stringify(meta) : null],
    );

    const id = result.insertId;
    const [[row]] = await db.query('SELECT * FROM levels WHERE id = ?', [id]);
    await rebuildLevelsCache(symbol);
    return rowToLevel(row);
  }

  // PATCH /api/levels/:id
  async function updateLevel(id, payload) {
    const [[existing]] = await db.query('SELECT * FROM levels WHERE id = ?', [id]);
    if (!existing) return null;

    const updates = {};
    if (payload.price     !== undefined) updates.price     = Number(payload.price);
    if (payload.type      !== undefined) updates.type      = payload.type;
    if (payload.strength  !== undefined) updates.strength  = payload.strength !== null ? Number(payload.strength) : null;
    if (payload.timeframe !== undefined) updates.timeframe = payload.timeframe || null;
    if (payload.meta      !== undefined) updates.meta_json = payload.meta ? JSON.stringify(payload.meta) : null;
    if (payload.isActive  !== undefined) updates.is_active = payload.isActive ? 1 : 0;

    if (Object.keys(updates).length === 0) {
      return rowToLevel(existing);
    }

    const setClauses = Object.keys(updates).map(k => `\`${k}\` = ?`).join(', ');
    const values     = [...Object.values(updates), id];
    await db.query(`UPDATE levels SET ${setClauses} WHERE id = ?`, values);

    const [[updated]] = await db.query('SELECT * FROM levels WHERE id = ?', [id]);
    await rebuildLevelsCache(updated.symbol);
    return rowToLevel(updated);
  }

  // DELETE /api/levels/:id (soft delete)
  async function deactivateLevel(id) {
    const [[existing]] = await db.query('SELECT * FROM levels WHERE id = ?', [id]);
    if (!existing) return null;

    await db.query('UPDATE levels SET is_active = FALSE WHERE id = ?', [id]);
    await rebuildLevelsCache(existing.symbol);
    return { id, symbol: existing.symbol };
  }

  return {
    getActiveLevelsBySymbol,
    createManualLevel,
    updateLevel,
    deactivateLevel,
    rebuildLevelsCache,
    validateLevelPayload,
    ALLOWED_TYPES,
    ALLOWED_SOURCES,
  };
}

module.exports = { createLevelsService };
