'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'saved-rays.json');

// ─── Internal helpers ─────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ nextId: 1, rays: [], rayFingerprints: {} }),
      'utf8',
    );
  }
}

function readStore() {
  ensureFile();
  const raw   = fs.readFileSync(DATA_FILE, 'utf8');
  const store = JSON.parse(raw);
  if (!store.rayFingerprints) store.rayFingerprints = {};
  return store;
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Geometry fingerprint for a single ray.
 * Based on: symbol + marketType + side + kind + shape + sorted points.
 * Field order in each point object is normalised so {value,timestamp} and
 * {timestamp,value} produce the same hash.
 */
function computeRayFingerprint(sym, marketType, ray) {
  const rawPoints = Array.isArray(ray.points) ? ray.points : [];
  const points    = [...rawPoints]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(p => ({ timestamp: p.timestamp, value: p.value }));

  const data = JSON.stringify({
    symbol:     sym,
    marketType,
    side:       ray.side,
    kind:       ray.kind  || 'ray',
    shape:      ray.shape || 'sloped',
    points,
  });

  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Snapshot-replace bulk save.
 *
 * Removes ALL existing saved rays for symbol + marketType + createdFrom,
 * then inserts the new set.  Per-ray geometry fingerprints of the removed
 * records are cleaned up so the same geometry can be re-saved without
 * being treated as a duplicate.
 *
 * "Same saved set" key: symbol + marketType + createdFrom.
 *
 * Returns { replaced: Ray[], oldCount: number }.
 */
function bulkSave({ userId = null, symbol, marketType, source, createdFrom, visibleOnAllTimeframes, persistent, rays }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  // ── 1. Remove old snapshot for this scope (scoped to userId if present) ──────────────
  const isOld = r =>
    r.symbol === sym &&
    r.marketType === marketType &&
    r.createdFrom === (createdFrom || null) &&
    (!userId || !r.userId || r.userId === userId);

  const oldRecords = store.rays.filter(isOld);
  const oldIds     = new Set(oldRecords.map(r => r.id));

  // Clean fingerprints of old records.
  for (const [fp, rayId] of Object.entries(store.rayFingerprints)) {
    if (oldIds.has(rayId)) delete store.rayFingerprints[fp];
  }

  store.rays = store.rays.filter(r => !isOld(r));

  // ── 2. Insert new snapshot ─────────────────────────────────────
  const replaced = rays.map(r => {
    const fp     = computeRayFingerprint(sym, marketType, r);
    const record = {
      id:                   store.nextId++,
      userId:               userId ?? null,
      symbol:               sym,
      marketType,
      source:               source || 'saved-rays',
      createdFrom:          createdFrom || null,
      side:                 r.side,
      kind:                 r.kind        || 'ray',
      shape:                r.shape       || 'sloped',
      points:               r.points      || null,
      strength:             r.strength  != null ? parseFloat(r.strength)  : null,
      touches:              r.touches   != null ? parseInt(r.touches, 10) : null,
      persistent:           true,
      visibleOnAllTimeframes: true,
      alertEnabled:         false,
      tracked:              false,
      createdAt:            now,
      updatedAt:            now,
    };
    store.rays.push(record);
    store.rayFingerprints[fp] = record.id;
    return record;
  });

  writeStore(store);
  return { replaced, oldCount: oldIds.size };
}

/**
 * Return saved rays filtered by symbol and marketType.
 * Records with no userId are visible to everyone (backward compat).
 * No tf filter — saved rays are tf-agnostic.
 */
function getAll({ userId = null, symbol, marketType, source } = {}) {
  const store = readStore();
  return store.rays.filter(r => {
    if (symbol     && r.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && r.marketType !== marketType)           return false;
    if (source     && r.source     !== source)               return false;
    if (userId     && r.userId     && r.userId !== userId)   return false;
    return true;
  });
}

/**
 * Delete a single saved ray by id.
 * If userId provided, verifies ownership (records with no userId are deletable by anyone).
 * Also removes its geometry fingerprint so the same ray can be re-saved.
 * Returns the removed record, or null if not found.
 */
function removeOne(id, userId = null) {
  const store = readStore();
  const idx   = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const record = store.rays[idx];
  if (userId && record.userId && record.userId !== userId) return null;

  const [removed] = store.rays.splice(idx, 1);

  // Clean up fingerprint so the same geometry can be re-added later.
  for (const [fp, rayId] of Object.entries(store.rayFingerprints)) {
    if (rayId === removed.id) {
      delete store.rayFingerprints[fp];
      break;
    }
  }

  writeStore(store);
  return removed;
}

/**
 * Delete multiple saved rays by ids array.
 * If userId provided, only removes records owned by that user (or without userId).
 * Returns count of removed records.
 */
function removeMany(ids, userId = null) {
  const idSet = new Set(ids);
  const store = readStore();
  const before = store.rays.length;

  const removedIds = new Set(store.rays.filter(r => idSet.has(r.id) && (!userId || !r.userId || r.userId === userId)).map(r => r.id));
  store.rays = store.rays.filter(r => !idSet.has(r.id));

  // Clean up fingerprints for removed rays.
  for (const [fp, rayId] of Object.entries(store.rayFingerprints)) {
    if (removedIds.has(rayId)) delete store.rayFingerprints[fp];
  }

  const count = before - store.rays.length;
  writeStore(store);
  return count;
}

/**
 * Patch a single saved ray.
 * Patchable fields: points, alertEnabled, tracked, watchMode, alertOptions, scenarioMode.
 * If userId provided, verifies ownership.
 *
 * If points are patched the geometry fingerprint is updated so the old geometry
 * can be re-saved and the new geometry won't be treated as a duplicate.
 *
 * Returns the updated record, or null if not found.
 */
function patchOne(id, patch, userId = null) {
  const PATCHABLE = new Set(['points', 'alertEnabled', 'tracked', 'watchMode', 'alertOptions', 'scenarioMode']);
  const store     = readStore();
  const idx       = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const ray = store.rays[idx];
  if (userId && ray.userId && ray.userId !== userId) return null;

  // If points change, rotate the fingerprint.
  if (patch.points !== undefined) {
    // Remove old fingerprint entry.
    for (const [fp, rayId] of Object.entries(store.rayFingerprints)) {
      if (rayId === id) {
        delete store.rayFingerprints[fp];
        break;
      }
    }
    // Apply new points and write new fingerprint.
    ray.points = patch.points;
    const newFp = computeRayFingerprint(ray.symbol, ray.marketType, ray);
    store.rayFingerprints[newFp] = id;
  }

  for (const key of Object.keys(patch)) {
    if (PATCHABLE.has(key) && key !== 'points') ray[key] = patch[key];
  }

  ray.updatedAt = Date.now();
  writeStore(store);
  return ray;
}

/**
 * Patch multiple saved rays with the same patch object.
 * Patchable fields: alertEnabled, tracked, watchMode, alertOptions, scenarioMode (not points for bulk patch).
 * If userId provided, only patches records owned by that user (or without userId).
 * Returns count of updated records.
 */
function patchMany(ids, patch, userId = null) {
  const PATCHABLE = new Set(['alertEnabled', 'tracked', 'watchMode', 'alertOptions', 'scenarioMode']);
  const idSet     = new Set(ids);
  const store     = readStore();
  const now       = Date.now();
  let count       = 0;

  for (const r of store.rays) {
    if (!idSet.has(r.id)) continue;
    if (userId && r.userId && r.userId !== userId) continue;
    for (const key of Object.keys(patch)) {
      if (PATCHABLE.has(key)) r[key] = patch[key];
    }
    r.updatedAt = now;
    count++;
  }

  writeStore(store);
  return count;
}

/**
 * Return a single saved ray by numeric id, or null if not found.
 */
function getById(id) {
  const store = readStore();
  return store.rays.find(r => r.id === id) || null;
}

module.exports = { bulkSave, getAll, getById, removeOne, removeMany, patchOne, patchMany };
