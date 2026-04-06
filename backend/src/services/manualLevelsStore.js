'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'manual-levels.json');

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
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    return JSON.parse(raw);
  } catch (err) {
    // Try .bak before resetting to empty
    const bak = DATA_FILE + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const raw = fs.readFileSync(bak, 'utf8');
        const store = JSON.parse(raw);
        console.error('[manual-levels-store] main file corrupted — restored from .bak');
        writeStore(store);
        return store;
      } catch (_) {}
    }
    console.error('[manual-levels-store] data file corrupted, reinitializing:', err.message);
    const empty = { nextId: 1, levels: [] };
    writeStore(empty);
    return empty;
  }
}

function writeStore(store) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  // Rotate: current main → .bak before replacing
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (_) {}
  }
  fs.renameSync(tmp, DATA_FILE); // atomic on POSIX (Docker/Linux)
}

function getAll({ symbol, marketType, tf, userId = null } = {}) {
  const { levels } = readStore();
  return levels.filter(l => {
    if (symbol     && l.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && l.marketType !== marketType)           return false;
    if (tf         && l.tf         !== tf)                   return false;
    // userId isolation: backward compat — records without userId visible to all
    if (userId && l.userId && l.userId !== userId)           return false;
    return true;
  });
}

function create({ symbol, marketType, tf, price, side, createdAt, userId = null }) {
  const store = readStore();
  const now   = Date.now();
  const level = {
    id:          store.nextId++,
    symbol:      symbol.toUpperCase(),
    marketType,
    tf,
    price:       parseFloat(price),
    side,
    userId:      userId ?? null,
    createdAt:   createdAt || now,
    updatedAt:   now,
  };
  store.levels.push(level);
  writeStore(store);
  return level;
}

function remove(id, userId = null) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const level = store.levels[idx];
  // ownership check: backward compat — levels without userId removable by anyone
  if (userId && level.userId && level.userId !== userId) return 'forbidden';
  const [removed] = store.levels.splice(idx, 1);
  writeStore(store);
  return removed;
}

function getById(id) {
  const { levels } = readStore();
  return levels.find(l => l.id === id) || null;
}

function patch(id, updates, userId = null) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const level = store.levels[idx];
  // ownership check: backward compat — levels without userId patchable by anyone
  if (userId && level.userId && level.userId !== userId) return 'forbidden';
  store.levels[idx] = { ...level, ...updates, updatedAt: Date.now() };
  writeStore(store);
  return store.levels[idx];
}

module.exports = { getAll, create, remove, getById, patch };
