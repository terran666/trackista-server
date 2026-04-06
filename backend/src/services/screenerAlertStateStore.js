'use strict';

/**
 * screenerAlertStateStore.js
 * ─────────────────────────────────────────────────────────────────
 * Redis-backed runtime state for the Screener Alert Engine.
 *
 * State machine per (userId, type, symbol, timeframe):
 *   conditionActive  — is the condition currently true?
 *   cooldownUntil    — epoch ms; don't fire until this timestamp passes
 *   lastTriggeredAt  — epoch ms of last fired alert
 *   lastChangePct    — changePct at last observed tick
 *   lastVolumeUsdt   — volumeUsdt at last observed tick
 *
 * Key pattern:
 *   screener:alertstate:{userId}:{type}:{symbol}:{timeframe}
 *
 * TTL: 48 hours (auto-GC if engine stops or user disables)
 */

const STATE_TTL_SEC = 48 * 3600; // 48 hours

function stateKey(userId, type, symbol, timeframe) {
  return `screener:alertstate:${userId}:${type}:${symbol}:${timeframe}`;
}

/**
 * Batch-read states for an array of {userId,type,symbol,timeframe} descriptors.
 * Returns Map<key, stateObject>.
 */
async function batchGetStates(redis, descriptors) {
  if (descriptors.length === 0) return new Map();
  const keys = descriptors.map(d => stateKey(d.userId, d.type, d.symbol, d.timeframe));
  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.get(k);
  const results = await pipeline.exec();

  const map = new Map();
  for (let i = 0; i < keys.length; i++) {
    const raw = results[i][1];
    let state = { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0 };
    if (raw) {
      try { state = { ...state, ...JSON.parse(raw) }; } catch (_) {}
    }
    map.set(keys[i], state);
  }
  return map;
}

/**
 * Batch-write states. Accepts Map<key, stateObject>.
 */
async function batchSetStates(redis, updates) {
  if (updates.size === 0) return;
  const pipeline = redis.pipeline();
  for (const [k, v] of updates) {
    pipeline.set(k, JSON.stringify(v), 'EX', STATE_TTL_SEC);
  }
  await pipeline.exec();
}

/**
 * Get a single state.
 */
async function getState(redis, userId, type, symbol, timeframe) {
  const raw = await redis.get(stateKey(userId, type, symbol, timeframe));
  if (!raw) return { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0 };
  try {
    return { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0, ...JSON.parse(raw) };
  } catch (_) {
    return { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0 };
  }
}

/**
 * Set a single state.
 */
async function setState(redis, userId, type, symbol, timeframe, state) {
  await redis.set(stateKey(userId, type, symbol, timeframe), JSON.stringify(state), 'EX', STATE_TTL_SEC);
}

module.exports = {
  stateKey,
  batchGetStates,
  batchSetStates,
  getState,
  setState,
};
