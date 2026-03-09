'use strict';

// ─── Env helpers ─────────────────────────────────────────────────
function envBool(key, defaultVal) {
  const v = process.env[key];
  if (v === undefined) return defaultVal;
  return v.toLowerCase() === 'true';
}
function envInt(key, defaultVal) {
  const v = parseInt(process.env[key], 10);
  return isNaN(v) ? defaultVal : v;
}

// ─── Delivery feature flags ───────────────────────────────────────
const SEND_FLAGS = {
  market_impulse:             () => envBool('TELEGRAM_SEND_MARKET_IMPULSE',                 true),
  market_in_play:             () => envBool('TELEGRAM_SEND_MARKET_IN_PLAY',                 true),
  level_breakout_candidate:   () => envBool('TELEGRAM_SEND_LEVEL_BREAKOUT_CANDIDATE',       true),
  level_bounce_candidate:     () => envBool('TELEGRAM_SEND_LEVEL_BOUNCE_CANDIDATE',         true),
  level_approaching:          () => envBool('TELEGRAM_SEND_LEVEL_APPROACHING',              false),
  level_touched:              () => envBool('TELEGRAM_SEND_LEVEL_TOUCHED',                  false),
};

// ─── Delivery cooldowns (seconds) ────────────────────────────────
function getCooldownSec(type) {
  switch (type) {
    case 'market_impulse':           return envInt('TELEGRAM_DELIVERY_COOLDOWN_MARKET_IMPULSE',                120);
    case 'market_in_play':           return envInt('TELEGRAM_DELIVERY_COOLDOWN_MARKET_IN_PLAY',               180);
    case 'level_breakout_candidate': return envInt('TELEGRAM_DELIVERY_COOLDOWN_LEVEL_BREAKOUT_CANDIDATE',     180);
    case 'level_bounce_candidate':   return envInt('TELEGRAM_DELIVERY_COOLDOWN_LEVEL_BOUNCE_CANDIDATE',       180);
    case 'level_approaching':        return envInt('TELEGRAM_DELIVERY_COOLDOWN_LEVEL_APPROACHING',            120);
    case 'level_touched':            return envInt('TELEGRAM_DELIVERY_COOLDOWN_LEVEL_TOUCHED',                120);
    default:                         return 120;
  }
}

// ─── Time formatter ───────────────────────────────────────────────
function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().slice(0, 8); // HH:mm:ss
}

// ─── Number helpers ───────────────────────────────────────────────
function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return parseFloat(parseFloat(v).toFixed(decimals)).toString();
}

// ─── Message formatter ────────────────────────────────────────────
function formatAlertMessage(alert) {
  const sc  = alert.signalContext || {};
  const dir = (sc.impulseDirection || '').toUpperCase() || null;
  const time = fmtTime(alert.createdAt);

  switch (alert.type) {
    case 'market_impulse': {
      const score = fmtNum(sc.impulseScore, 1);
      const conf  = fmtNum(sc.signalConfidence, 0);
      const price = fmtNum(alert.currentPrice || alert.price, 2);
      let msg = `🚀 <b>MARKET IMPULSE</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (dir)   msg += `\nDirection: <b>${dir}</b>`;
      if (score) msg += `\nScore: <b>${score}</b>`;
      if (conf)  msg += `\nConfidence: <b>${conf}%</b>`;
      if (price) msg += `\nPrice: <b>${price}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'market_in_play': {
      const score = fmtNum(sc.inPlayScore, 1);
      const conf  = fmtNum(sc.signalConfidence, 0);
      const price = fmtNum(alert.currentPrice || alert.price, 2);
      let msg = `🔥 <b>MARKET IN PLAY</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (dir)   msg += `\nDirection: <b>${dir}</b>`;
      if (score) msg += `\nIn-Play Score: <b>${score}</b>`;
      if (conf)  msg += `\nConfidence: <b>${conf}%</b>`;
      if (price) msg += `\nPrice: <b>${price}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'level_breakout_candidate': {
      const levelType = (alert.levelType || '').toUpperCase() || null;
      const level  = fmtNum(alert.levelPrice, 4);
      const price  = fmtNum(alert.currentPrice, 4);
      const dist   = fmtNum(Math.abs(alert.distancePct || 0), 2);
      let msg = `💥 <b>BREAKOUT CANDIDATE</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (levelType) msg += `\nSide: <b>${levelType}</b>`;
      if (level)     msg += `\nLevel: <b>${level}</b>`;
      if (price)     msg += `\nPrice: <b>${price}</b>`;
      if (dist)      msg += `\nDistance: <b>${dist}%</b>`;
      if (dir)       msg += `\nDirection: <b>${dir}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'level_bounce_candidate': {
      const levelType = (alert.levelType || '').toUpperCase() || null;
      const level  = fmtNum(alert.levelPrice, 4);
      const price  = fmtNum(alert.currentPrice, 4);
      const dist   = fmtNum(Math.abs(alert.distancePct || 0), 2);
      let msg = `↩️ <b>BOUNCE CANDIDATE</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (levelType) msg += `\nSide: <b>${levelType}</b>`;
      if (level)     msg += `\nLevel: <b>${level}</b>`;
      if (price)     msg += `\nPrice: <b>${price}</b>`;
      if (dist)      msg += `\nDistance: <b>${dist}%</b>`;
      if (dir)       msg += `\nDirection: <b>${dir}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'level_approaching': {
      const levelType = (alert.levelType || '').toUpperCase() || null;
      const level = fmtNum(alert.levelPrice, 4);
      const dist  = fmtNum(Math.abs(alert.distancePct || 0), 2);
      let msg = `📍 <b>APPROACHING LEVEL</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (levelType) msg += `\nSide: <b>${levelType}</b>`;
      if (level)     msg += `\nLevel: <b>${level}</b>`;
      if (dist)      msg += `\nDistance: <b>${dist}%</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'level_touched': {
      const levelType = (alert.levelType || '').toUpperCase() || null;
      const level = fmtNum(alert.levelPrice, 4);
      let msg = `🎯 <b>LEVEL TOUCHED</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (levelType) msg += `\nSide: <b>${levelType}</b>`;
      if (level)     msg += `\nLevel: <b>${level}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    default:
      return null;
  }
}

// ─── Delivery key ─────────────────────────────────────────────────
function buildDeliveryKey(alert) {
  const sc  = alert.signalContext || {};
  const dir = (sc.impulseDirection || 'mixed').toLowerCase();

  switch (alert.type) {
    case 'market_impulse':
    case 'market_in_play':
      return `telegram:delivery:${alert.type}:${alert.symbol}:${dir}`;

    case 'level_breakout_candidate':
    case 'level_bounce_candidate':
    case 'level_approaching':
    case 'level_touched': {
      const lvl = alert.levelPrice != null ? alert.levelPrice : 'unknown';
      return `telegram:delivery:${alert.type}:${alert.symbol}:${alert.levelType || 'level'}:${lvl}`;
    }

    default:
      return `telegram:delivery:${alert.type}:${alert.symbol}:generic`;
  }
}

// ─── Factory ─────────────────────────────────────────────────────
function createAlertDeliveryService(redis, telegramService) {
  // ── Cooldown ─────────────────────────────────────────────────
  async function isInCooldown(key) {
    const val = await redis.get(key);
    return val !== null;
  }

  async function markDelivered(key, type) {
    const ttl = getCooldownSec(type);
    await redis.set(key, '1', 'EX', ttl);
  }

  // ── shouldDeliver ─────────────────────────────────────────────
  function shouldDeliver(alert) {
    const flagFn = SEND_FLAGS[alert.type];
    if (!flagFn) return false;
    return flagFn();
  }

  // ── handleAlert ───────────────────────────────────────────────
  async function handleAlert(alert) {
    if (!shouldDeliver(alert)) {
      console.log(`[telegram] skipped type=${alert.type} symbol=${alert.symbol} reason=disabled_by_config`);
      return { success: false, skipped: true, reason: 'disabled_by_config' };
    }

    const key = buildDeliveryKey(alert);

    const onCooldown = await isInCooldown(key);
    if (onCooldown) {
      // Тихий пропуск — cooldown нормальное поведение, не логируем каждую секунду
      return { success: false, skipped: true, reason: 'delivery_cooldown' };
    }

    const message = formatAlertMessage(alert);
    if (!message) {
      return { success: false, skipped: true, reason: 'empty_message' };
    }

    const result = await telegramService.sendMessage(message, { disableWebPagePreview: true });

    if (result.skipped) {
      return { success: false, skipped: true, reason: result.reason };
    }

    if (result.success) {
      await markDelivered(key, alert.type);
      console.log(`[telegram] delivered type=${alert.type} symbol=${alert.symbol} messageId=${result.telegramMessageId}`);
      return { success: true, telegramMessageId: result.telegramMessageId };
    }

    // Ошибка отправки
    const statusCode = result.statusCode ?? 'network';
    console.error(`[telegram] failed type=${alert.type} symbol=${alert.symbol} status=${statusCode} error=${result.error}`);
    return { success: false, error: result.error };
  }

  return { handleAlert };
}

module.exports = { createAlertDeliveryService };
