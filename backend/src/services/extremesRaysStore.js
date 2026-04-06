'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'extremes-rays.json');

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
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    return JSON.parse(raw);
  } catch (err) {
    const bak = DATA_FILE + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const raw = fs.readFileSync(bak, 'utf8');
        const store = JSON.parse(raw);
        console.error('[extremes-rays-store] main file corrupted — restored from .bak');
        writeStore(store);
        return store;
      } catch (_) {}
    }
    console.error('[extremes-rays-store] data file corrupted, reinitializing:', err.message);
    const empty = { nextId: 1, rays: [] };
    writeStore(empty);
    return empty;
  }
}

function writeStore(store) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (_) {}
  }
  fs.renameSync(tmp, DATA_FILE);
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Return rays filtered by optional symbol / marketType / tf.
 */
function getAll({ symbol, marketType, tf } = {}) {
  const { rays } = readStore();
  return rays.filter(r => {
    if (symbol     && r.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && r.marketType !== marketType)           return false;
    if (tf         && r.tf         !== tf)                   return false;
    return true;
  });
}

/**
 * Create a new extremes ray.
 *
 * @param {object} params
 * @param {string}   params.rayId      - Client-generated stable ID (uuid or similar)
 * @param {string}   params.symbol     - e.g. "BTCUSDT"
 * @param {string}   params.marketType - "spot" | "futures"
 * @param {string}   params.tf         - e.g. "5m"
 * @param {string}   params.side       - "support" | "resistance"
 * @param {Array<{timestamp:number,value:number}>} params.points - exactly 2 anchor points
 * @returns {object} The created ray record
 */
function create({ rayId, symbol, marketType, tf, side, points }) {
  const store = readStore();
  const now   = Date.now();

  const ray = {
    id:          store.nextId++,
    rayId,
    symbol:      symbol.toUpperCase(),
    marketType,
    tf,
    source:      'extremes-ray',
    side,
    points,
    createdAt:   now,
    updatedAt:   now,
  };

  store.rays.push(ray);
  writeStore(store);
  return ray;
}

/**
 * Patch an existing ray.
 * Patchable fields: side, points.
 *
 * @param {number} id
 * @param {object} patch - { side?, points? }
 * @returns {object|null} Updated ray, or null if not found
 */
function patch(id, patch) {
  const PATCHABLE = new Set(['side', 'points']);
  const store     = readStore();
  const idx       = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;

  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.has(key)) continue;
    store.rays[idx][key] = patch[key];
  }
  store.rays[idx].updatedAt = Date.now();

  writeStore(store);
  return store.rays[idx];
}

/**
 * Delete a ray by id.
 *
 * @param {number} id
 * @returns {object|null} Removed ray, or null if not found
 */
function remove(id) {
  const store = readStore();
  const idx   = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const [removed] = store.rays.splice(idx, 1);
  writeStore(store);
  return removed;
}

module.exports = { getAll, create, patch, remove };
