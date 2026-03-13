'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-rays.json');

// ─── Internal helpers ─────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId: 1, rays: [] }), 'utf8');
  }
}

function readStore() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Replace all records for symbol+marketType+tf+source with a fresh set.
 *
 * Each input ray must have at minimum: side, shape, points (for 'sloped').
 * For 'horizontal' rays price is expected instead of (or alongside) points.
 *
 * Returns the created records.
 */
function bulkSave({ symbol, marketType, tf, source, rays }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  // Remove old snapshot for this key combination
  store.rays = store.rays.filter(
    r => !(r.symbol === sym && r.marketType === marketType && r.tf === tf && r.source === source)
  );

  const created = rays.map(r => ({
    id:           store.nextId++,
    symbol:       sym,
    marketType,
    tf,
    source,
    side:         r.side,
    kind:         r.kind         || 'ray',
    shape:        r.shape        || 'sloped',
    price:        r.price        != null ? parseFloat(r.price) : null,
    points:       r.points       || null,
    strength:     r.strength     != null ? parseFloat(r.strength) : null,
    touches:      r.touches      != null ? parseInt(r.touches, 10) : null,
    alertEnabled: false,
    tracked:      false,
    createdAt:    now,
    updatedAt:    now,
  }));

  store.rays.push(...created);
  writeStore(store);
  return created;
}

/**
 * Return rays filtered by optional symbol / marketType / tf / source.
 */
function getAll({ symbol, marketType, tf, source } = {}) {
  const { rays } = readStore();
  return rays.filter(r => {
    if (symbol     && r.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && r.marketType !== marketType)           return false;
    if (tf         && r.tf         !== tf)                   return false;
    if (source     && r.source     !== source)               return false;
    return true;
  });
}

/**
 * Delete a single ray by id.
 * Returns the removed record, or null if not found.
 */
function removeOne(id) {
  const store = readStore();
  const idx   = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const [removed] = store.rays.splice(idx, 1);
  writeStore(store);
  return removed;
}

/**
 * Patch a single ray.
 * Patchable fields: points, price, alertEnabled, tracked.
 * Returns the updated record, or null if not found.
 */
function patchOne(id, patch) {
  const PATCHABLE = new Set(['points', 'price', 'alertEnabled', 'tracked']);
  const store     = readStore();
  const idx       = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;
  for (const key of Object.keys(patch)) {
    if (PATCHABLE.has(key)) store.rays[idx][key] = patch[key];
  }
  store.rays[idx].updatedAt = Date.now();
  writeStore(store);
  return store.rays[idx];
}

module.exports = { bulkSave, getAll, removeOne, patchOne };
