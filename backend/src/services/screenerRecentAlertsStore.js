'use strict';

/**
 * screenerRecentAlertsStore.js
 * ─────────────────────────────────────────────────────────────────
 * Per-user Redis list of recent screener alerts.
 *
 * Key:   screener:alerts:recent:{userId}
 * Type:  Redis LPUSH / LRANGE list (newest first)
 * Limit: 200 entries
 *
 * These are separate from the global alerts:recent list and
 * let users see their own growth/drop alert history after reload.
 */

const RECENT_LIMIT = 200;

function recentKey(userId) {
  return `screener:alerts:recent:${userId}`;
}

/**
 * Push an alert event to the user's recent list.
 * Trims to RECENT_LIMIT automatically.
 */
async function pushAlert(redis, userId, event) {
  const key  = recentKey(userId);
  const json = JSON.stringify(event);
  const p    = redis.pipeline();
  p.lpush(key, json);
  p.ltrim(key, 0, RECENT_LIMIT - 1);
  await p.exec();
}

/**
 * Fetch the most recent N alerts for a user.
 * Returns parsed event objects, newest first.
 */
async function getRecent(redis, userId, limit = 50) {
  const count = Math.min(limit, RECENT_LIMIT);
  const raws  = await redis.lrange(recentKey(userId), 0, count - 1);
  return raws
    .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
    .filter(Boolean);
}

module.exports = { pushAlert, getRecent };
