'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

function computeFingerprint(items) {
  const normalized = items.map(item => {
    const obj = {};
    for (const k of Object.keys(item).sort()) obj[k] = item[k];
    return obj;
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-extremes.json');

// ─── Internal helpers ─────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId: 1, extremes: [], fingerprints: {} }), 'utf8');
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

  if (!store.fingerprints) store.fingerprints = {};
  const fpKey    = `${sym}:${marketType}:${tf}:${source}`;
  const incoming = computeFingerprint(extremes);

  if (store.fingerprints[fpKey] === incoming) {
    const existing = store.extremes.filter(
      e => e.symbol === sym && e.marketType === marketType && e.tf === tf && e.source === source
    );
    return { skipped: true, items: existing };
  }

  // Snapshot of existing records — used to carry over user state (alertEnabled, tracked)
  const prevRecords = store.extremes.filter(
    e => e.symbol === sym && e.marketType === marketType && e.tf === tf && e.source === source
  );

  // Match key: side + first-point timestamp (stable across minor price moves)
  function lineKey(side, pts) {
    const p0 = Array.isArray(pts) && pts[0];
    return p0 ? `${side}:${p0.timestamp}` : null;
  }
  const prevByKey = new Map();
  for (const rec of prevRecords) {
    const k = lineKey(rec.side, rec.points);
    if (k) prevByKey.set(k, rec);
  }

  // Remove old snapshot for this combination
  store.extremes = store.extremes.filter(
    e => !(e.symbol === sym && e.marketType === marketType && e.tf === tf && e.source === source)
  );

  // Insert new records — carry over alertEnabled/tracked from matching previous record
  const created = extremes.map(e => {
    const k    = lineKey(e.side, e.points);
    const prev = k ? prevByKey.get(k) : null;
    return {
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
      alertEnabled: prev?.alertEnabled ?? false,
      tracked:      prev?.tracked      ?? false,
      createdAt:    prev?.createdAt    ?? now,
      updatedAt:    now,
    };
  });

  store.extremes.push(...created);
  store.fingerprints[fpKey] = incoming;
  writeStore(store);
  return { skipped: false, items: created };
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
 * Patchable fields: price, points, alertEnabled, tracked, watchMode, alertOptions, scenarioMode.
 */
function patchOne(id, patch) {
  const PATCHABLE = new Set(['price', 'points', 'alertEnabled', 'tracked', 'watchMode', 'alertOptions', 'scenarioMode']);
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
 * Patchable fields: price, points, alertEnabled, tracked, watchMode, alertOptions, scenarioMode.
 * Returns count of updated records.
 */
function patchMany(ids, patch) {
  const PATCHABLE = new Set(['price', 'points', 'alertEnabled', 'tracked', 'watchMode', 'alertOptions', 'scenarioMode']);
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

function getById(id) {
  const store = readStore();
  return store.extremes.find(e => e.id === id) || null;
}

module.exports = { bulkSave, getAll, getById, removeOne, removeMany, patchOne, patchMany };
