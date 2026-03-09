'use strict';

// ─── Constants ───────────────────────────────────────────────────
const ALERT_RECENT_LIMIT   = 500;
const ALERT_EVENT_TTL_SEC  = 7 * 24 * 60 * 60; // 7 дней

const COOLDOWN_LEVEL_APPROACHING_SEC = 60;
const COOLDOWN_LEVEL_TOUCHED_SEC     = 60;
const COOLDOWN_LEVEL_BREAKOUT_SEC    = 120;
const COOLDOWN_LEVEL_BOUNCE_SEC      = 120;
const COOLDOWN_MARKET_INPLAY_SEC     = 90;

// market_impulse is now handled by marketImpulseService (Phase 8.2)
const INPLAY_ALERT_THRESHOLD     = parseInt(process.env.ALERT_INPLAY_THRESHOLD     || '100', 10);
const ALERT_SIGNAL_CONFIDENCE_MIN = parseInt(process.env.ALERT_SIGNAL_CONFIDENCE_MIN || '70',  10);

const ENGINE_INTERVAL_MS   = 1000;
const SUMMARY_LOG_INTERVAL = 30;

// ─── Severity helpers ────────────────────────────────────────────
function getSeverity(type, signalContext) {
  const { impulseScore = 0, inPlayScore = 0, signalConfidence = 0 } = signalContext || {};

  switch (type) {
    case 'level_approaching':
      return signalConfidence >= 80 ? 'medium' : 'low';

    case 'level_touched':
      if (inPlayScore >= 120) return 'high';
      return signalConfidence >= 80 ? 'medium' : 'low';

    case 'level_breakout_candidate':
      if (signalConfidence >= 80 && impulseScore >= 120) return 'high';
      return 'medium';

    case 'level_bounce_candidate':
      if (inPlayScore >= 120) return 'high';
      return signalConfidence >= 80 ? 'medium' : 'low';

    case 'market_impulse':
      if (impulseScore >= 150) return 'high';
      if (impulseScore >= 100) return 'medium';
      return 'low';

    case 'market_in_play':
      if (inPlayScore >= 150) return 'high';
      if (inPlayScore >= 100) return 'medium';
      return 'low';

    default:
      return 'low';
  }
}

// ─── Title / message helpers ─────────────────────────────────────
function buildText(type, symbol, levelPrice, levelType, distancePct, signalContext) {
  const { impulseScore = 0, impulseDirection = 'mixed' } = signalContext || {};

  switch (type) {
    case 'level_approaching':
      return {
        title:   `${symbol} approaching ${levelType}`,
        message: `${symbol} is approaching ${levelType} level ${levelPrice} (distance ${Math.abs(distancePct).toFixed(2)}%).`,
      };
    case 'level_touched':
      return {
        title:   `${symbol} touched ${levelType}`,
        message: `${symbol} touched ${levelType} level ${levelPrice}.`,
      };
    case 'level_breakout_candidate':
      return {
        title:   `${symbol} breakout candidate near ${levelType}`,
        message: `${symbol} shows breakout candidate above ${levelPrice} ${levelType} with strong signal context.`,
      };
    case 'level_bounce_candidate':
      return {
        title:   `${symbol} bounce candidate near ${levelType}`,
        message: `${symbol} shows bounce candidate near ${levelType} ${levelPrice}.`,
      };
    case 'market_impulse':
      return {
        title:   `${symbol} market impulse detected`,
        message: `${symbol} shows strong impulse (score ${impulseScore.toFixed(1)}, direction ${impulseDirection}).`,
      };
    case 'market_in_play':
      return {
        title:   `${symbol} entered in-play state`,
        message: `${symbol} entered in-play state with elevated market activity.`,
      };
    default:
      return { title: `${symbol} ${type}`, message: `${symbol} triggered alert: ${type}.` };
  }
}

// ─── Alert event builder ─────────────────────────────────────────
function buildAlertEvent(type, symbol, now, opts = {}) {
  const {
    levelId     = null,
    levelPrice  = null,
    levelType   = null,
    currentPrice = null,
    distancePct  = null,
    signalContext = null,
  } = opts;

  const idSuffix = levelId !== null ? levelId : 'generic';
  const id = `${symbol}-${type}-${now}-${idSuffix}`;
  const severity = getSeverity(type, signalContext);
  const { title, message } = buildText(type, symbol, levelPrice, levelType, distancePct, signalContext);

  const event = { id, type, symbol, severity, title, message, createdAt: now };
  if (levelId    !== null) event.levelId    = levelId;
  if (levelPrice !== null) event.levelPrice = levelPrice;
  if (levelType  !== null) event.levelType  = levelType;
  if (currentPrice !== null) event.currentPrice = currentPrice;
  if (distancePct  !== null) event.distancePct  = distancePct;
  if (signalContext)        event.signalContext = signalContext;

  return event;
}

// ─── Factory ─────────────────────────────────────────────────────
function createAlertEngineService(redis, deliveryService = null) {
  let tickCount  = 0;
  let totalAlerts = 0;

  // ── Cooldown helpers ────────────────────────────────────────
  async function isCooldownActive(type, symbol, levelIdOrGeneric) {
    const key = `alertcooldown:${type}:${symbol}:${levelIdOrGeneric}`;
    const val = await redis.get(key);
    return val !== null;
  }

  async function setCooldown(type, symbol, levelIdOrGeneric, ttlSec) {
    const key = `alertcooldown:${type}:${symbol}:${levelIdOrGeneric}`;
    await redis.set(key, '1', 'EX', ttlSec);
  }

  // ── Write alert to Redis ────────────────────────────────────
  async function pushAlert(event) {
    const json = JSON.stringify(event);
    const pipeline = redis.pipeline();
    pipeline.set(`alert:${event.id}`, json, 'EX', ALERT_EVENT_TTL_SEC);
    pipeline.lpush('alerts:recent', json);
    pipeline.ltrim('alerts:recent', 0, ALERT_RECENT_LIMIT - 1);
    await pipeline.exec();
    totalAlerts++;
    console.log(`[alerts] created type=${event.type} symbol=${event.symbol} severity=${event.severity}`);

    // Delivery layer — без блокировки alert engine при ошибке доставки
    if (deliveryService) {
      deliveryService.handleAlert(event).catch(err =>
        console.error('[alerts] delivery error:', err.message)
      );
    }
  }

  // ── Process level-based alerts for one level state entry ────
  async function processLevelAlerts(symbol, levelEntry, currentPrice, signalContext, now) {
    const {
      levelId, price: levelPrice, type: levelType,
      approaching, touched, crossed,
      breakoutCandidate, bounceCandidate,
      distancePct,
    } = levelEntry;

    const checks = [
      { condition: approaching,       type: 'level_approaching',        ttl: COOLDOWN_LEVEL_APPROACHING_SEC },
      { condition: touched,           type: 'level_touched',            ttl: COOLDOWN_LEVEL_TOUCHED_SEC },
      { condition: breakoutCandidate, type: 'level_breakout_candidate', ttl: COOLDOWN_LEVEL_BREAKOUT_SEC },
      { condition: bounceCandidate,   type: 'level_bounce_candidate',   ttl: COOLDOWN_LEVEL_BOUNCE_SEC },
    ];

    for (const { condition, type, ttl } of checks) {
      if (!condition) continue;
      const onCooldown = await isCooldownActive(type, symbol, levelId);
      if (onCooldown) continue;

      const event = buildAlertEvent(type, symbol, now, {
        levelId, levelPrice, levelType,
        currentPrice, distancePct, signalContext,
      });
      await pushAlert(event);
      await setCooldown(type, symbol, levelId, ttl);
    }
  }

  // ── Process market-based alerts for one symbol ──────────────
  // Note: market_impulse is handled by marketImpulseService (Phase 8.2)
  async function processMarketAlerts(symbol, signal, now) {
    if (!signal) return;
    if (!signal.baselineReady) return;
    if ((signal.signalConfidence ?? 0) < ALERT_SIGNAL_CONFIDENCE_MIN) return;

    const signalContext = {
      impulseScore:     signal.impulseScore     ?? 0,
      impulseDirection: signal.impulseDirection ?? 'mixed',
      inPlayScore:      signal.inPlayScore      ?? 0,
      signalConfidence: signal.signalConfidence ?? 0,
    };

    // market_in_play
    if ((signal.inPlayScore ?? 0) >= INPLAY_ALERT_THRESHOLD) {
      const onCooldown = await isCooldownActive('market_in_play', symbol, 'generic');
      if (!onCooldown) {
        const event = buildAlertEvent('market_in_play', symbol, now, { signalContext });
        await pushAlert(event);
        await setCooldown('market_in_play', symbol, 'generic', COOLDOWN_MARKET_INPLAY_SEC);
      }
    }
  }

  // ── Main tick ───────────────────────────────────────────────
  async function tick() {
    tickCount++;
    const logSummary = (tickCount % SUMMARY_LOG_INTERVAL === 0);

    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      if (!rawSymbols) return;
      const symbols = JSON.parse(rawSymbols);

      // Одним pipeline читаем signal + levelstate для всех символов
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`signal:${sym}`);
        pipeline.get(`levelstate:${sym}`);
      }
      const results = await pipeline.exec();

      let processedSymbols = 0;
      let alertsThisTick   = 0;
      const prevTotal = totalAlerts;

      const now = Date.now();

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawSignal]     = results[i * 2];
        const [, rawLevelState] = results[i * 2 + 1];

        // Нет ни signal, ни levelstate — пропускаем
        if (!rawSignal && !rawLevelState) continue;

        processedSymbols++;

        let signal     = null;
        let levelState = null;
        try { if (rawSignal)     signal     = JSON.parse(rawSignal);     } catch (_) {}
        try { if (rawLevelState) levelState = JSON.parse(rawLevelState); } catch (_) {}

        // Контекст сигнала для level alerts
        const signalContext = signal ? {
          impulseScore:     signal.impulseScore     ?? 0,
          impulseDirection: signal.impulseDirection ?? 'mixed',
          inPlayScore:      signal.inPlayScore      ?? 0,
          signalConfidence: signal.signalConfidence ?? 0,
        } : null;

        // Уровневые алерты
        if (levelState && Array.isArray(levelState.levels)) {
          for (const lvl of levelState.levels) {
            // Получаем текущую цену из levelState — она уже вычислена монитором
            const currentPrice = lvl.price != null
              ? parseFloat(lvl.price) * (1 + (lvl.distancePct ?? 0) / 100)
              : null;
            await processLevelAlerts(sym, lvl, currentPrice, signalContext, now);
          }
        }

        // Рыночные алерты
        await processMarketAlerts(sym, signal, now);
      }

      alertsThisTick = totalAlerts - prevTotal;

      if (logSummary) {
        const recentCount = await redis.llen('alerts:recent');
        console.log(
          `[alerts] summary processed=${processedSymbols} new=${alertsThisTick}` +
          ` total=${totalAlerts} recentFeed=${recentCount}`
        );
      }
    } catch (err) {
      console.error('[alerts] tick error:', err.message);
    }
  }

  function start() {
    console.log('[alerts] Alert engine started (1s interval)');
    setInterval(tick, ENGINE_INTERVAL_MS);
  }

  return { start };
}

module.exports = { createAlertEngineService };
