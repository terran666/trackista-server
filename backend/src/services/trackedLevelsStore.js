'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Stable fingerprint of an input items array (geometry/data fields only).
// Items are key-sorted before stringify so field order doesn't matter.
function computeFingerprint(items) {
  const normalized = items.map(item => {
    const obj = {};
    for (const k of Object.keys(item).sort()) obj[k] = item[k];
    return obj;
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-levels.json');

let _cache = null;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextId: 1, levels: [], fingerprints: {} }), 'utf8');
  }
}

function readStore() {
  if (_cache) return _cache;
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    _cache = JSON.parse(raw);
    return _cache;
  } catch (err) {
    const bak = DATA_FILE + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const raw = fs.readFileSync(bak, 'utf8');
        const store = JSON.parse(raw);
        console.error('[tracked-levels-store] main file corrupted — restored from .bak');
        writeStore(store);
        return store;
      } catch (_) {}
    }
    console.error('[tracked-levels-store] data file corrupted, reinitializing:', err.message);
    const empty = { nextId: 1, levels: [], fingerprints: {} };
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
  _cache = store;
}

// Replace all records for symbol+marketType+tf+source with a fresh set.
// If the incoming payload is identical to the last saved snapshot (by fingerprint),
// skip the write and return { skipped: true, items: existingRecords }.
// Otherwise replace and return { skipped: false, items: createdRecords }.
function bulkSave({ symbol, marketType, tf, source, levels, force = false }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  if (!store.fingerprints) store.fingerprints = {};
  const fpKey    = `${sym}:${marketType}:${tf}:${source}`;
  const incoming = computeFingerprint(levels);

  if (!force && store.fingerprints[fpKey] === incoming) {
    const existing = store.levels.filter(
      l => l.symbol === sym && l.marketType === marketType && l.tf === tf && l.source === source
    );
    return { skipped: true, items: existing };
  }

  // Preserve user watch settings (alertEnabled, watchMode, alertOptions) for levels
  // that survive the bulk-replace at the same price+side. This prevents a data refresh
  // (new fingerprint) from silently wiping the user's marking on an unchanged level.
  const existingWatchMap = new Map(); // key: `${price}:${side}` → watch fields
  for (const l of store.levels) {
    if (l.symbol !== sym || l.marketType !== marketType || l.tf !== tf || l.source !== source) continue;
    if (!l.alertEnabled) continue;
    existingWatchMap.set(`${l.price}:${l.side}`, {
      alertEnabled: l.alertEnabled,
      watchMode:    l.watchMode    ?? null,
      alertOptions: l.alertOptions ?? null,
    });
  }

  // Remove old records for this combination
  store.levels = store.levels.filter(
    l => !(l.symbol === sym && l.marketType === marketType && l.tf === tf && l.source === source)
  );

  // Insert new records, restoring watch settings where price+side matches an existing watched level
  const created = levels.map(l => {
    const watchState = existingWatchMap.get(`${l.price}:${l.side}`);
    return {
      id:                 store.nextId++,
      symbol:             sym,
      marketType,
      tf,
      source,
      price:              l.price,
      side:               l.side,
      type:               l.type              || null,
      touches:            l.touches           ?? null,
      score:              l.score             ?? null,
      virgin:             l.virgin            ?? null,
      formationTimestamp: l.formationTimestamp || null,
      drawFromTimestamp:  l.drawFromTimestamp  || null,
      alertEnabled:       watchState?.alertEnabled ?? false,
      watchMode:          watchState?.watchMode    ?? null,
      alertOptions:       watchState?.alertOptions ?? null,
      createdAt:          now,
      updatedAt:          now,
    };
  });

  store.levels.push(...created);
  store.fingerprints[fpKey] = incoming;
  writeStore(store);
  return { skipped: false, items: created };
}

function getAll({ symbol, marketType, tf, source } = {}) {
  const { levels } = readStore();
  return levels.filter(l => {
    if (symbol     && l.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && l.marketType !== marketType)           return false;
    if (tf         && l.tf         !== tf)                   return false;
    if (source     && l.source     !== source)               return false;
    return true;
  });
}

function removeOne(id) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const [removed] = store.levels.splice(idx, 1);
  writeStore(store);
  return removed;
}

function removeMany(ids) {
  const idSet = new Set(ids);
  const store = readStore();
  const before = store.levels.length;
  store.levels = store.levels.filter(l => !idSet.has(l.id));
  const removed = before - store.levels.length;
  writeStore(store);
  return removed;
}

function patchOne(id, patch) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const PATCHABLE = new Set(['alertEnabled', 'price', 'watchMode', 'alertOptions']);
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.has(key)) continue;
    if (key === 'alertOptions' && patch[key] && typeof patch[key] === 'object') {
      store.levels[idx].alertOptions = { ...(store.levels[idx].alertOptions || {}), ...patch[key] };
    } else {
      store.levels[idx][key] = patch[key];
    }
  }
  store.levels[idx].updatedAt = Date.now();
  writeStore(store);
  return store.levels[idx];
}

function patchMany(ids, patch) {
  const idSet = new Set(ids);
  const store = readStore();
  const now   = Date.now();
  const PATCHABLE = new Set(['alertEnabled', 'price']);
  let count = 0;
  for (const l of store.levels) {
    if (!idSet.has(l.id)) continue;
    for (const key of Object.keys(patch)) {
      if (PATCHABLE.has(key)) l[key] = patch[key];
    }
    l.updatedAt = now;
    count++;
  }
  writeStore(store);
  return count;
}

function getById(id) {
  const { levels } = readStore();
  return levels.find(l => l.id === id) || null;
}

module.exports = { bulkSave, getAll, getById, removeOne, removeMany, patchOne, patchMany };
