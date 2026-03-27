'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'manual-sloped-levels.json');

// ─── Internal helpers ─────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId: 1, levels: [] }), 'utf8');
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
 * Return all manual sloped levels, optionally filtered by symbol and marketType.
 * No tf filter — callers load all lines for the instrument and render on any tf.
 */
function getAll({ symbol, marketType } = {}) {
  const { levels } = readStore();
  return levels.filter(l => {
    if (symbol     && l.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && l.marketType !== marketType)           return false;
    return true;
  });
}

/**
 * Create a single manual sloped level.
 * Returns the new record.
 */
function create({ symbol, marketType, source, side, kind, shape, points }) {
  const store = readStore();
  const now   = Date.now();
  const level = {
    id:           store.nextId++,
    symbol:       symbol.toUpperCase(),
    marketType,
    source:       source || 'manual-sloped-level',
    side,
    kind:         kind  || 'ray',
    shape:        shape || 'sloped',
    points,
    alertEnabled: false,
    tracked:      false,
    createdAt:    now,
    updatedAt:    now,
  };
  store.levels.push(level);
  writeStore(store);
  return level;
}

/**
 * Delete a single manual sloped level by id.
 * Returns the removed record, or null if not found.
 */
function remove(id) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const [removed] = store.levels.splice(idx, 1);
  writeStore(store);
  return removed;
}

/**
 * Patch a single manual sloped level.
 * Patchable fields: points, side, alertEnabled, tracked, watchMode, alertOptions, scenarioMode.
 * Returns the updated record, or null if not found.
 */
function patch(id, changes) {
  const PATCHABLE = new Set(['points', 'side', 'alertEnabled', 'tracked', 'watchMode', 'alertOptions', 'scenarioMode']);
  const store     = readStore();
  const idx       = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  for (const key of Object.keys(changes)) {
    if (PATCHABLE.has(key)) store.levels[idx][key] = changes[key];
  }
  store.levels[idx].updatedAt = Date.now();
  writeStore(store);
  return store.levels[idx];
}

module.exports = { getAll, create, remove, patch };
