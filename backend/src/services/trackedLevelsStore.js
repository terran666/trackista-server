'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-levels.json');

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

// Replace all records for symbol+marketType+tf+source with a fresh set,
// assigning new ids. Returns the created records.
function bulkSave({ symbol, marketType, tf, source, levels }) {
  const sym   = symbol.toUpperCase();
  const store = readStore();
  const now   = Date.now();

  // Remove old records for this combination
  store.levels = store.levels.filter(
    l => !(l.symbol === sym && l.marketType === marketType && l.tf === tf && l.source === source)
  );

  // Insert new records
  const created = levels.map(l => ({
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
    alertEnabled:       false,
    createdAt:          now,
    updatedAt:          now,
  }));

  store.levels.push(...created);
  writeStore(store);
  return created;
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
  const PATCHABLE = new Set(['alertEnabled', 'price']);
  for (const key of Object.keys(patch)) {
    if (PATCHABLE.has(key)) store.levels[idx][key] = patch[key];
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

module.exports = { bulkSave, getAll, removeOne, removeMany, patchOne, patchMany };
