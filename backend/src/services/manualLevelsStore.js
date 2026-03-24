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
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function getAll({ symbol, marketType, tf } = {}) {
  const { levels } = readStore();
  return levels.filter(l => {
    if (symbol     && l.symbol     !== symbol.toUpperCase()) return false;
    if (marketType && l.marketType !== marketType)           return false;
    if (tf         && l.tf         !== tf)                   return false;
    return true;
  });
}

function create({ symbol, marketType, tf, price, side, createdAt }) {
  const store = readStore();
  const now   = Date.now();
  const level = {
    id:          store.nextId++,
    symbol:      symbol.toUpperCase(),
    marketType,
    tf,
    price:       parseFloat(price),
    side,
    createdAt:   createdAt || now,
    updatedAt:   now,
  };
  store.levels.push(level);
  writeStore(store);
  return level;
}

function remove(id) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  const [removed] = store.levels.splice(idx, 1);
  writeStore(store);
  return removed;
}

function getById(id) {
  const { levels } = readStore();
  return levels.find(l => l.id === id) || null;
}

function patch(id, updates) {
  const store = readStore();
  const idx   = store.levels.findIndex(l => l.id === id);
  if (idx === -1) return null;
  store.levels[idx] = { ...store.levels[idx], ...updates, updatedAt: Date.now() };
  writeStore(store);
  return store.levels[idx];
}

module.exports = { getAll, create, remove, getById, patch };
