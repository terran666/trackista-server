'use strict';

/**
 * formationPatternStore.js
 * Redis-backed store for extreme pattern formations.
 *
 * Keys:
 *   formations:patterns:active           → Set of all active IDs
 *   formations:patterns:symbol:{symbol}  → Set of IDs for one symbol
 *   formations:patterns:id:{id}          → JSON blob (TTL from config)
 */

const TTL_DEFAULT_MS = 6 * 3_600_000;

function buildId(f) {
  return `${f.symbol}:${f.marketType}:${f.formationType}:${f.direction}:${f.mainTf}:${Math.round(f.levelPrice)}`;
}

function createFormationPatternStore(redis, config) {
  const KEY_ACTIVE = 'formations:patterns:active';
  const keySymbol  = (sym) => `formations:patterns:symbol:${sym}`;
  const keyId      = (id) => `formations:patterns:id:${id}`;

  function getTtlSec(tf) {
    const ms = config.redisTtlMs?.[tf] ?? TTL_DEFAULT_MS;
    return Math.floor(ms / 1000);
  }

  // ── Upsert ─────────────────────────────────────────────────────────────────
  async function upsert(candidate) {
    const id = candidate.id || buildId(candidate);
    const now = Date.now();
    const existing = await getById(id);
    let record;

    if (existing) {
      // Update: preserve createdAt, update everything else
      record = {
        ...existing,
        ...candidate,
        id,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    } else {
      record = {
        ...candidate,
        id,
        createdAt: now,
        updatedAt: now,
      };
    }

    const ttl = getTtlSec(record.mainTf);
    const pipeline = redis.pipeline();
    pipeline.set(keyId(id), JSON.stringify(record), 'EX', ttl);
    pipeline.sadd(KEY_ACTIVE, id);
    pipeline.sadd(keySymbol(record.symbol), id);
    await pipeline.exec();
    return record;
  }

  // ── Get single ─────────────────────────────────────────────────────────────
  async function getById(id) {
    const raw = await redis.get(keyId(id));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── Get all active ─────────────────────────────────────────────────────────
  async function getActive() {
    const ids = await redis.smembers(KEY_ACTIVE);
    if (!ids.length) return [];
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(keyId(id));
    const results = await pipeline.exec();

    const active = [];
    const staleIds = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = results[i][1];
      if (!raw) { staleIds.push(ids[i]); continue; }
      try { active.push(JSON.parse(raw)); } catch { staleIds.push(ids[i]); }
    }
    if (staleIds.length) {
      const p2 = redis.pipeline();
      for (const id of staleIds) {
        p2.srem(KEY_ACTIVE, id);
        // don't remove from symbol set — too expensive without knowing symbol
      }
      await p2.exec();
    }
    return active;
  }

  // ── Get by symbol ──────────────────────────────────────────────────────────
  async function getBySymbol(symbol) {
    const ids = await redis.smembers(keySymbol(symbol));
    if (!ids.length) return [];
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(keyId(id));
    const results = await pipeline.exec();
    const active = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = results[i][1];
      if (!raw) continue;
      try { active.push(JSON.parse(raw)); } catch {}
    }
    return active;
  }

  // ── Remove ─────────────────────────────────────────────────────────────────
  async function remove(id, symbol) {
    const pipeline = redis.pipeline();
    pipeline.del(keyId(id));
    pipeline.srem(KEY_ACTIVE, id);
    if (symbol) pipeline.srem(keySymbol(symbol), id);
    await pipeline.exec();
  }

  // ── Refresh TTL (keep alive on lifecycle update) ───────────────────────────
  async function touch(id, tf) {
    const ttl = getTtlSec(tf);
    await redis.expire(keyId(id), ttl);
  }

  return { upsert, getById, getActive, getBySymbol, remove, touch, buildId };
}

module.exports = { createFormationPatternStore };
