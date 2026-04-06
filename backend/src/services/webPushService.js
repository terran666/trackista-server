'use strict';

/**
 * webPushService.js
 * ─────────────────────────────────────────────────────────────────
 * Web Push (VAPID) delivery layer.
 *
 * Responsibilities:
 *  - VAPID initialization
 *  - sendPushToUser(userId, payload) — fetch subscriptions from DB, send to all
 *  - sendPushToSubscription(subscription, payload) — single delivery + cleanup
 *  - shouldSendPush(alert) — priority filter
 *  - Push dedup (Redis TTL per dedupKey)
 *  - In-memory rate limit (global + per-user)
 */

const webPush = require('web-push');

// ─── VAPID init ───────────────────────────────────────────────────

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — Web Push disabled');
} else {
  webPush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@trackista.live',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

const PUSH_ENABLED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

// ─── Payload builder ─────────────────────────────────────────────

function buildPayload(alert) {
  const sym = (alert.symbol || '').replace(/USDT$/i, '');

  const LABELS = {
    level_crossed:           '💥 Пробой уровня',
    crossed_up:              '💥 Пробой вверх',
    crossed_down:            '💥 Пробой вниз',
    level_touched:           '📍 Касание уровня',
    contact_hit:             '📍 Касание уровня',
    breakout:                '🚀 Пробой',
    breakout_candidate:      '🔎 Кандидат на пробой',
    bounce:                  '🔄 Отскок',
    bounce_candidate:        '🔎 Кандидат на отскок',
    bounce_detected:         '🔄 Отскок обнаружен',
    early_warning:           '⚠️ Раннее предупреждение',
    level_approaching:       '📊 Подход к уровню',
    approaching_entered:     '📊 Подход к уровню',
    precontact_entered:      '⚡ Очень близко к уровню',
    market_impulse:          '🚀 Импульс рынка',
    market_in_play:          '🔥 Рынок в игре',
  };

  const title = LABELS[alert.type] || alert.title || 'Trackista Alert';
  const parts = [];
  if (sym) parts.push(sym);
  if (alert.levelPrice != null) parts.push(`Уровень: ${Number(alert.levelPrice).toPrecision(5)}`);
  if (alert.distancePct != null) parts.push(`Дист: ${Number(alert.distancePct).toFixed(2)}%`);
  if (alert.message) parts.push(alert.message);
  const body = parts.join(' • ') || (alert.symbol || 'Trackista');

  const tag = `${alert.type}:${alert.symbol || ''}:${alert.levelId || alert.externalLevelId || 'market'}`;

  return JSON.stringify({
    title,
    body,
    icon:     '/favicon.ico',
    badge:    '/favicon.png',
    tag,
    renotify: true,
    data: {
      url:      `/test?coin=${alert.symbol || ''}&market=${alert.market || alert.marketType || 'futures'}${alert.timeframe ? '&tf=' + alert.timeframe : ''}`,
      symbol:   alert.symbol,
      type:     alert.type,
      levelId:  alert.levelId ?? alert.externalLevelId ?? null,
      priority: alert.priority,
    },
  });
}

// ─── shouldSendPush filter ────────────────────────────────────────

/**
 * Returns true if this alert should be sent as a push notification.
 * ТЗ §9.
 */
function shouldSendPush(alert) {
  const type     = alert.type || '';
  const priority = (alert.priority || '').toLowerCase();
  const sc       = alert.signalContext || {};

  // Level-critical events — always push
  const CRITICAL = new Set([
    'level_crossed', 'crossed_up', 'crossed_down',
    'level_touched', 'contact_hit',
    'breakout', 'breakout_candidate',
    'bounce',   'bounce_detected', 'bounce_candidate',
  ]);
  if (CRITICAL.has(type)) return true;

  // Approach events — always push (approaching a level is always relevant)
  const APPROACH = new Set([
    'level_approaching', 'approaching_entered', 'precontact_entered', 'early_warning',
  ]);
  if (APPROACH.has(type)) return true;

  // market_impulse — only if quality thresholds met
  if (type === 'market_impulse') {
    const impulseScore   = parseFloat(sc.impulseScore)    || 0;
    const volumeSpike    = parseFloat(sc.volumeSpikeRatio) || 0;
    return impulseScore > 150 && volumeSpike > 2;
  }

  // market_in_play — never push (ТЗ §9 / §15)
  if (type === 'market_in_play') return false;

  // Fallback: only high priority
  return priority === 'high';
}

// ─── Rate limiter (ТЗ §11) ───────────────────────────────────────

const GLOBAL_MAX_PER_SEC  = 5;
const PER_USER_MAX_PER_SEC = 2;

// Simple fixed-window counters (reset each second)
let globalCount = 0;
let globalWindowEnd = Date.now() + 1000;
const userCounters  = new Map(); // userId → { count, windowEnd }

function checkRateLimit(userId) {
  const now = Date.now();

  // Global
  if (now >= globalWindowEnd) {
    globalCount = 0;
    globalWindowEnd = now + 1000;
  }
  if (globalCount >= GLOBAL_MAX_PER_SEC) return 'global_rate_limit';
  globalCount++;

  // Per-user
  let uc = userCounters.get(userId);
  if (!uc || now >= uc.windowEnd) {
    uc = { count: 0, windowEnd: now + 1000 };
    userCounters.set(userId, uc);
  }
  if (uc.count >= PER_USER_MAX_PER_SEC) return 'user_rate_limit';
  uc.count++;

  return null; // ok
}

// ─── Factory ─────────────────────────────────────────────────────

function createWebPushService(db, redis) {
  // ── Dedup ──────────────────────────────────────────────────────
  const DEDUP_TTL_SEC = 45;

  async function isDuplicate(dedupKey) {
    if (!dedupKey) return false;
    const key = `push:dedup:${dedupKey}`;
    const set = await redis.set(key, '1', 'EX', DEDUP_TTL_SEC, 'NX');
    return set === null; // null → key already existed → duplicate
  }

  // ── DB helpers ─────────────────────────────────────────────────
  async function getSubscriptionsForUser(userId) {
    const [rows] = await db.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND alert_enabled = 1',
      [userId],
    );
    return rows;
  }

  async function deleteSubscription(endpoint) {
    await db.query(
      'DELETE FROM push_subscriptions WHERE endpoint = ?',
      [endpoint],
    );
    console.log(`[push.deleted_subscription] endpoint=${endpoint.slice(0, 60)}...`);
  }

  // ── Single send ────────────────────────────────────────────────
  async function sendPushToSubscription(sub, payloadStr) {
    if (!PUSH_ENABLED) return { skipped: true, reason: 'vapid_not_configured' };

    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payloadStr,
        { TTL: 60 }, // 60s TTL — short-lived alert
      );
      return { success: true };
    } catch (err) {
      const status = err.statusCode || err.code;
      console.error(`[push.error] statusCode=${status} endpoint=${sub.endpoint.slice(0, 60)}...`);
      if (status === 404 || status === 410) {
        // Subscription expired / unsubscribed — clean up (ТЗ §6.2 / §12)
        await deleteSubscription(sub.endpoint);
        return { expired: true };
      }
      return { success: false, error: err.message };
    }
  }

  // ── Send to user ───────────────────────────────────────────────
  async function sendPushToUser(userId, alert) {
    if (!PUSH_ENABLED) return;

    // Dedup
    const dedupKey = alert.dedupKey || alert.id;
    if (await isDuplicate(dedupKey)) {
      console.log(`[push.skip] reason=dedup user=${userId} type=${alert.type} symbol=${alert.symbol}`);
      return;
    }

    // Rate limit
    const rlReason = checkRateLimit(userId);
    if (rlReason) {
      console.log(`[push.skip] reason=${rlReason} user=${userId} type=${alert.type} symbol=${alert.symbol}`);
      return;
    }

    const subs = await getSubscriptionsForUser(userId);
    if (!subs.length) return;

    const payload = buildPayload(alert);
    console.log(`[push.send] user=${userId} symbol=${alert.symbol} type=${alert.type} subscriptions=${subs.length}`);

    // Fire all subscriptions for this user (may have multiple devices)
    await Promise.allSettled(subs.map(sub => sendPushToSubscription(sub, payload)));
  }

  // ── Send to all users (broadcast, use sparingly) ───────────────
  async function sendPushToAll(alert) {
    if (!PUSH_ENABLED) return;

    const [rows] = await db.query(
      'SELECT DISTINCT user_id FROM push_subscriptions WHERE alert_enabled = 1',
    );
    await Promise.allSettled(rows.map(r => sendPushToUser(r.user_id, alert)));
  }

  return {
    shouldSendPush,
    sendPushToUser,
    sendPushToAll,
    sendPushToSubscription,
    PUSH_ENABLED: () => PUSH_ENABLED,
  };
}

module.exports = { createWebPushService, shouldSendPush };
