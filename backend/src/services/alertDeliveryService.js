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
  // Watch engine events — per-level telegram_enabled governs delivery; global flag defaults off
  level_crossed:              () => envBool('TELEGRAM_SEND_LEVEL_CROSSED',                  false),
  early_warning:              () => envBool('TELEGRAM_SEND_EARLY_WARNING',                  false),
  nearby_wall_appeared:       () => envBool('TELEGRAM_SEND_NEARBY_WALL_APPEARED',           false),
  nearby_wall_strengthened:   () => envBool('TELEGRAM_SEND_NEARBY_WALL_STRENGTHENED',       false),
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
    case 'level_crossed':            return 120;
    case 'early_warning':            return 120;
    case 'nearby_wall_appeared':     return 180;
    case 'nearby_wall_strengthened': return 180;
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
      const move  = sc.priceMovePct5s != null ? parseFloat(sc.priceMovePct5s) : null;
      const spike = sc.volumeSpikeRatio != null ? parseFloat(sc.volumeSpikeRatio) : null;
      const score = fmtNum(sc.impulseScore, 0);
      const conf  = fmtNum(sc.signalConfidence, 0);
      const price = fmtNum(alert.currentPrice || alert.price, 4);
      let msg = `🚀 <b>MARKET IMPULSE</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (dir)           msg += `\nDirection: <b>${dir}</b>`;
      if (move !== null) msg += `\nMove (5s): <b>${move >= 0 ? '+' : ''}${move.toFixed(2)}%</b>`;
      if (spike !== null) msg += `\nVolume Spike: <b>${spike.toFixed(2)}x</b>`;
      if (score)         msg += `\nScore: <b>${score}</b>`;
      if (conf)          msg += `\nConfidence: <b>${conf}%</b>`;
      if (price)         msg += `\nPrice: <b>${price}</b>`;
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

    // ── Watch engine events ──────────────────────────────────────

    case 'level_crossed': {
      const level  = fmtNum(alert.levelPrice, 4);
      const price  = fmtNum(alert.currentPrice, 4);
      const market = (alert.market || '').toUpperCase();
      let msg = `⚡ <b>LEVEL CROSSED</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (market) msg += ` [${market}]`;
      if (level)  msg += `\nLevel: <b>${level}</b>`;
      if (price)  msg += `\nPrice: <b>${price}</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'early_warning': {
      const level  = fmtNum(alert.levelPrice, 4);
      const dist   = fmtNum(Math.abs(alert.distancePct || 0), 2);
      const ew     = alert.earlyWarning || {};
      let msg = `⏰ <b>EARLY WARNING</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (level) msg += `\nLevel: <b>${level}</b>`;
      if (dist)  msg += `\nDistance: <b>${dist}%</b>`;
      if (ew.estimatedTimeToLevelSec != null) msg += `\nETA: <b>~${ew.estimatedTimeToLevelSec}s</b>`;
      msg += `\nTime: <b>${time}</b>`;
      return msg;
    }

    case 'nearby_wall_appeared':
    case 'nearby_wall_strengthened': {
      const level  = fmtNum(alert.levelPrice, 4);
      const wc     = alert.wallContext || {};
      const label  = alert.type === 'nearby_wall_appeared' ? 'WALL APPEARED' : 'WALL STRENGTHENED';
      let msg = `🧱 <b>${label}</b>\n\nSymbol: <b>${alert.symbol}</b>`;
      if (level) msg += `\nLevel: <b>${level}</b>`;
      if (wc.wallStrength != null) msg += `\nWall: <b>${fmtNum(wc.wallStrength, 0)}</b>`;
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
// ─── Quality filter config ──────────────────────────────────────
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

function getSeverityRank(severity) {
  return SEVERITY_RANK[(severity || '').toLowerCase()] ?? -1;
}

function getMinScore(type) {
  switch (type) {
    case 'market_impulse':  return envInt('TELEGRAM_MIN_SCORE_MARKET_IMPULSE', 250);
    case 'market_in_play':  return envInt('TELEGRAM_MIN_SCORE_MARKET_IN_PLAY', 150);
    default:                return null;
  }
}

function getMinConfidence(type) {
  switch (type) {
    case 'market_impulse':  return envInt('TELEGRAM_MIN_CONFIDENCE_MARKET_IMPULSE', 80);
    case 'market_in_play':  return envInt('TELEGRAM_MIN_CONFIDENCE_MARKET_IN_PLAY', 75);
    default:                return null;
  }
}

function getMinSeverity(type) {
  switch (type) {
    case 'market_impulse':           return (process.env.TELEGRAM_MIN_SEVERITY_MARKET_IMPULSE           || 'high').toLowerCase();
    case 'market_in_play':           return (process.env.TELEGRAM_MIN_SEVERITY_MARKET_IN_PLAY           || 'medium').toLowerCase();
    case 'level_breakout_candidate': return (process.env.TELEGRAM_MIN_SEVERITY_LEVEL_BREAKOUT_CANDIDATE || 'medium').toLowerCase();
    case 'level_bounce_candidate':   return (process.env.TELEGRAM_MIN_SEVERITY_LEVEL_BOUNCE_CANDIDATE   || 'medium').toLowerCase();
    default:                         return null;
  }
}

function getBurstConfig(type) {
  switch (type) {
    case 'market_impulse':
      return { max: envInt('TELEGRAM_MAX_ALERTS_PER_WINDOW_MARKET_IMPULSE', 3), window: envInt('TELEGRAM_WINDOW_SECONDS_MARKET_IMPULSE', 60) };
    case 'market_in_play':
      return { max: envInt('TELEGRAM_MAX_ALERTS_PER_WINDOW_MARKET_IN_PLAY', 5), window: envInt('TELEGRAM_WINDOW_SECONDS_MARKET_IN_PLAY', 60) };
    default:
      return null;
  }
}

// ─── Quality filter functions ─────────────────────────────────────
function passesScoreThreshold(alert) {
  const minScore = getMinScore(alert.type);
  if (minScore === null) return { pass: true };
  const sc = alert.signalContext || {};
  const score = parseFloat(alert.type === 'market_impulse' ? sc.impulseScore : sc.inPlayScore);
  if (isNaN(score) || score < minScore) {
    return { pass: false, reason: 'score_below_threshold', score, min: minScore };
  }
  return { pass: true };
}

function passesConfidenceThreshold(alert) {
  const minConf = getMinConfidence(alert.type);
  if (minConf === null) return { pass: true };
  const sc = alert.signalContext || {};
  const conf = parseFloat(sc.signalConfidence);
  if (isNaN(conf) || conf < minConf) {
    return { pass: false, reason: 'confidence_below_threshold', confidence: conf, min: minConf };
  }
  return { pass: true };
}

function passesDirectionFilter(alert) {
  const DIRECTION_TYPES = ['market_impulse', 'market_in_play', 'level_breakout_candidate', 'level_bounce_candidate'];
  if (!DIRECTION_TYPES.includes(alert.type)) return { pass: true };
  if (envBool('TELEGRAM_ALLOW_MIXED_DIRECTION', false)) return { pass: true };
  const sc = alert.signalContext || {};
  if ((sc.impulseDirection || '').toUpperCase() === 'MIXED') {
    return { pass: false, reason: 'mixed_direction' };
  }
  return { pass: true };
}

function passesSeverityFilter(alert) {
  const severity = (alert.severity || '').toLowerCase();
  if (!severity) return { pass: true };
  const minSeverity = getMinSeverity(alert.type);
  if (minSeverity === null) return { pass: true };
  if (getSeverityRank(severity) < getSeverityRank(minSeverity)) {
    return { pass: false, reason: 'severity_below_threshold', severity, min: minSeverity };
  }
  return { pass: true };
}

function passesQualityFilter(alert) {
  for (const check of [passesDirectionFilter, passesScoreThreshold, passesConfidenceThreshold, passesSeverityFilter]) {
    const result = check(alert);
    if (!result.pass) return result;
  }
  return { pass: true };
}

function logQualitySkip(alert, result) {
  let extra = '';
  if (result.reason === 'score_below_threshold')           extra = ` score=${fmtNum(result.score, 1)} min=${result.min}`;
  else if (result.reason === 'confidence_below_threshold') extra = ` confidence=${fmtNum(result.confidence, 0)} min=${result.min}`;
  else if (result.reason === 'severity_below_threshold')   extra = ` severity=${result.severity} min=${result.min}`;
  console.log(`[telegram] skipped type=${alert.type} symbol=${alert.symbol} reason=${result.reason}${extra}`);
}
// ─── Factory ─────────────────────────────────────────────────────
// Глобальный rate limiter — макс N сообщений в минуту в Telegram
const GLOBAL_RATE_LIMIT_PER_MIN = envInt('TELEGRAM_RATE_LIMIT_PER_MIN', 5);

function createAlertDeliveryService(redis, telegramService) {
  // ── Global rate limiter (in-memory, per minute) ───────────────
  let sentThisMinute = 0;
  let rateLimitResetAt = Date.now() + 60000;

  function isRateLimited() {
    const now = Date.now();
    if (now >= rateLimitResetAt) {
      sentThisMinute = 0;
      rateLimitResetAt = now + 60000;
    }
    return sentThisMinute >= GLOBAL_RATE_LIMIT_PER_MIN;
  }

  function incrementRate() {
    sentThisMinute++;
  }

  // ── Burst limit (Redis-based, per alert type) ─────────────────
  async function passesBurstLimit(alert) {
    const cfg = getBurstConfig(alert.type);
    if (!cfg) return { pass: true };
    const key = `telegram:burst:${alert.type}`;
    const current = await redis.get(key);
    const count = parseInt(current, 10) || 0;
    if (count >= cfg.max) {
      return { pass: false, reason: 'burst_limit', count, window: cfg.window };
    }
    return { pass: true };
  }

  async function incrementBurstCount(type) {
    const cfg = getBurstConfig(type);
    if (!cfg) return;
    const key = `telegram:burst:${type}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, cfg.window);
  }

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

    const quality = passesQualityFilter(alert);
    if (!quality.pass) {
      logQualitySkip(alert, quality);
      return { success: false, skipped: true, reason: quality.reason };
    }

    const burst = await passesBurstLimit(alert);
    if (!burst.pass) {
      console.log(`[telegram] skipped type=${alert.type} symbol=${alert.symbol} reason=burst_limit count=${burst.count} window=${burst.window}`);
      return { success: false, skipped: true, reason: 'burst_limit' };
    }

    const key = buildDeliveryKey(alert);
    const onCooldown = await isInCooldown(key);
    if (onCooldown) {
      return { success: false, skipped: true, reason: 'delivery_cooldown' };
    }

    if (isRateLimited()) {
      return { success: false, skipped: true, reason: 'global_rate_limit' };
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
      incrementRate();
      await incrementBurstCount(alert.type);
      await markDelivered(key, alert.type);
      console.log(`[telegram] delivered type=${alert.type} symbol=${alert.symbol} messageId=${result.telegramMessageId}`);
      return { success: true, telegramMessageId: result.telegramMessageId };
    }

    const statusCode = result.statusCode ?? 'network';
    console.error(`[telegram] failed type=${alert.type} symbol=${alert.symbol} status=${statusCode} error=${result.error}`);
    return { success: false, error: result.error };
  }

  return { handleAlert };
}

module.exports = { createAlertDeliveryService };
