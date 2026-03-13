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
 * Additive bulk save with per-ray geometry deduplication.
 *
 * Unlike snapshot-replace stores, this does NOT wipe existing rays; it only
 * adds rays whose geometry fingerprint is not yet stored.
 *
 * Returns { saved: Ray[], skippedCount: number }.
 */
function bulkSave({ symbol, marketType, source, createdFrom, visibleOnAllTimeframes, persistent, rays }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  const savedRays   = [];
  let   skippedCount = 0;

  for (const r of rays) {
    const fp = computeRayFingerprint(sym, marketType, r);

    if (store.rayFingerprints[fp] !== undefined) {
      skippedCount++;
      continue;
    }

    const record = {
      id:                   store.nextId++,
      symbol:               sym,
      marketType,
      source:               source || 'saved-rays',
      createdFrom:          createdFrom || null,
      side:                 r.side,
      kind:                 r.kind        || 'ray',
      shape:                r.shape       || 'sloped',
      points:               r.points,
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
    savedRays.push(record);
  }

  writeStore(store);
  return { saved: savedRays, skippedCount };
}

/**
 * Return saved rays filtered by symbol and marketType.
 * No tf filter — saved rays are tf-agnostic.
 */
function getAll({ symbol, marketType } = {}) {
  const store = readStore();
  return store.rays.filter(r => {
    if (symbol     && r.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && r.marketType !== marketType)           return false;
    return true;
  });
}

/**
 * Delete a single saved ray by id.
 * Also removes its geometry fingerprint so the same ray can be re-saved.
 * Returns the removed record, or null if not found.
 */
function removeOne(id) {
  const store = readStore();
  const idx   = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;

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
 * Returns count of removed records.
 */
function removeMany(ids) {
  const idSet = new Set(ids);
  const store = readStore();
  const before = store.rays.length;

  const removedIds = new Set(store.rays.filter(r => idSet.has(r.id)).map(r => r.id));
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
 * Patchable fields: points, alertEnabled, tracked.
 *
 * If points are patched the geometry fingerprint is updated so the old geometry
 * can be re-saved and the new geometry won't be treated as a duplicate.
 *
 * Returns the updated record, or null if not found.
 */
function patchOne(id, patch) {
  const PATCHABLE = new Set(['points', 'alertEnabled', 'tracked']);
  const store     = readStore();
  const idx       = store.rays.findIndex(r => r.id === id);
  if (idx === -1) return null;

  const ray = store.rays[idx];

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
 * Patchable fields: alertEnabled, tracked (not points for bulk patch).
 * Returns count of updated records.
 */
function patchMany(ids, patch) {
  const PATCHABLE = new Set(['alertEnabled', 'tracked']);
  const idSet     = new Set(ids);
  const store     = readStore();
  const now       = Date.now();
  let count       = 0;

  for (const r of store.rays) {
    if (!idSet.has(r.id)) continue;
    for (const key of Object.keys(patch)) {
      if (PATCHABLE.has(key)) r[key] = patch[key];
    }
    r.updatedAt = now;
    count++;
  }

  writeStore(store);
  return count;
}

module.exports = { bulkSave, getAll, removeOne, removeMany, patchOne, patchMany };
