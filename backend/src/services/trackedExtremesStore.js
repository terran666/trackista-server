'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-extremes.json');

// ─── Internal helpers ─────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId: 1, extremes: [] }), 'utf8');
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
 * Returns the created records.
 */
function bulkSave({ symbol, marketType, tf, source, extremes }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  // Remove old snapshot for this combination
  store.extremes = store.extremes.filter(
    e => !(e.symbol === sym && e.marketType === marketType && e.tf === tf && e.source === source)
  );

  // Insert new records
  const created = extremes.map(e => ({
    id:           store.nextId++,
    symbol:       sym,
    marketType,
    tf,
    source,
    side:         e.side,
    type:         e.type         || null,
    price:        e.price        != null ? parseFloat(e.price) : null,
    points:       e.points       || null,
    strength:     e.strength     != null ? parseFloat(e.strength) : null,
    touches:      e.touches      != null ? parseInt(e.touches, 10) : null,
    alertEnabled: false,
    tracked:      false,
    createdAt:    now,
    updatedAt:    now,
  }));

  store.extremes.push(...created);
  writeStore(store);
  return created;
}

/**
 * Return extremes filtered by optional symbol / marketType / tf / source.
 */
function getAll({ symbol, marketType, tf, source } = {}) {
  const { extremes } = readStore();
  return extremes.filter(e => {
    if (symbol     && e.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && e.marketType !== marketType)           return false;
    if (tf         && e.tf         !== tf)                   return false;
    if (source     && e.source     !== source)               return false;
    return true;
  });
}

/**
 * Delete a single extreme by id.
 */
function removeOne(id) {
  const store = readStore();
  const idx   = store.extremes.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const [removed] = store.extremes.splice(idx, 1);
  writeStore(store);
  return removed;
}

/**
 * Delete multiple extremes by ids array.
 * Returns count of removed records.
 */
function removeMany(ids) {
  const idSet = new Set(ids);
  const store = readStore();
  const before = store.extremes.length;
  store.extremes = store.extremes.filter(e => !idSet.has(e.id));
  const count = before - store.extremes.length;
  writeStore(store);
  return count;
}

/**
 * Patch a single extreme.
 * Patchable fields: price, points, alertEnabled, tracked.
 */
function patchOne(id, patch) {
  const PATCHABLE = new Set(['price', 'points', 'alertEnabled', 'tracked']);
  const store     = readStore();
  const idx       = store.extremes.findIndex(e => e.id === id);
  if (idx === -1) return null;
  for (const key of Object.keys(patch)) {
    if (PATCHABLE.has(key)) store.extremes[idx][key] = patch[key];
  }
  store.extremes[idx].updatedAt = Date.now();
  writeStore(store);
  return store.extremes[idx];
}

/**
 * Patch multiple extremes with the same patch object.
 * Patchable fields: price, points, alertEnabled, tracked.
 * Returns count of updated records.
 */
function patchMany(ids, patch) {
  const PATCHABLE = new Set(['price', 'points', 'alertEnabled', 'tracked']);
  const idSet     = new Set(ids);
  const store     = readStore();
  const now       = Date.now();
  let count       = 0;
  for (const e of store.extremes) {
    if (!idSet.has(e.id)) continue;
    for (const key of Object.keys(patch)) {
      if (PATCHABLE.has(key)) e[key] = patch[key];
    }
    e.updatedAt = now;
    count++;
  }
  writeStore(store);
  return count;
}

module.exports = { bulkSave, getAll, removeOne, removeMany, patchOne, patchMany };
