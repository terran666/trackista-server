'use strict';

// ─── Constants ───────────────────────────────────────────────────
const LEVEL_APPROACH_PCT             = 0.5;   // % от уровня — считается approaching
const LEVEL_TOUCH_PCT                = 0.05;  // % от уровня — считается touched
const BREAKOUT_SIGNAL_CONFIDENCE_MIN = 70;
const BREAKOUT_IMPULSE_SCORE_MIN     = 100;
const BREAKOUT_INPLAY_SCORE_MIN      = 100;
const BOUNCE_SIGNAL_CONFIDENCE_MIN   = 70;
const MONITOR_INTERVAL_MS            = 1000;
const SUMMARY_LOG_INTERVAL           = 30;   // тиков между summary-логами
const LEVELSTATE_TTL_SEC             = 30;   // TTL ключа levelstate:<SYM> в Redis

// ─── Factory ─────────────────────────────────────────────────────
function createLevelMonitorService(redis) {
  // in-memory: предыдущая цена по символу для определения crossed
  const previousPrices = new Map();
  let tickCount = 0;

  // ── Вычисление состояния одного уровня ──────────────────────
  function computeLevel(level, currentPrice, prevPrice, signal) {
    const levelPrice = parseFloat(level.price);
    if (isNaN(levelPrice) || levelPrice <= 0) return null;

    const distancePct    = ((currentPrice - levelPrice) / levelPrice) * 100;
    const absDistancePct = Math.abs(distancePct);

    let side;
    if      (currentPrice > levelPrice) side = 'above';
    else if (currentPrice < levelPrice) side = 'below';
    else                                side = 'at';

    const approaching = absDistancePct <= LEVEL_APPROACH_PCT;
    const touched     = absDistancePct <= LEVEL_TOUCH_PCT;

    // crossed — цена пересекла уровень с предыдущего тика
    let crossed = false;
    if (prevPrice !== null && prevPrice !== currentPrice) {
      const prevAbove = prevPrice > levelPrice;
      const currAbove = currentPrice > levelPrice;
      if (prevAbove !== currAbove) crossed = true;
    }

    const type = level.type || 'manual';

    // ── breakoutCandidate ────────────────────────────────────
    let breakoutCandidate = false;
    if (crossed && signal) {
      const conf   = signal.signalConfidence ?? 0;
      const impl   = signal.impulseScore     ?? 0;
      const inplay = signal.inPlayScore      ?? 0;
      if (
        conf   >= BREAKOUT_SIGNAL_CONFIDENCE_MIN &&
        impl   >= BREAKOUT_IMPULSE_SCORE_MIN     &&
        inplay >= BREAKOUT_INPLAY_SCORE_MIN
      ) {
        if (type === 'resistance' && currentPrice > levelPrice) breakoutCandidate = true;
        if (type === 'support'    && currentPrice < levelPrice) breakoutCandidate = true;
      }
    }

    // ── bounceCandidate ──────────────────────────────────────
    let bounceCandidate = false;
    if (touched && signal) {
      const conf      = signal.signalConfidence ?? 0;
      const direction = signal.impulseDirection ?? 'mixed';
      if (conf >= BOUNCE_SIGNAL_CONFIDENCE_MIN) {
        if (type === 'resistance' && side === 'below' && direction !== 'up')   bounceCandidate = true;
        if (type === 'support'    && side === 'above' && direction !== 'down') bounceCandidate = true;
      }
    }

    return {
      levelId:          level.id,
      price:            levelPrice,
      type:             level.type,
      source:           level.source,
      strength:         level.strength  ?? null,
      timeframe:        level.timeframe ?? null,
      distancePct:      parseFloat(distancePct.toFixed(4)),
      absDistancePct:   parseFloat(absDistancePct.toFixed(4)),
      side,
      approaching,
      touched,
      crossed,
      breakoutCandidate,
      bounceCandidate,
      signalContext: signal ? {
        impulseScore:     signal.impulseScore     ?? 0,
        impulseDirection: signal.impulseDirection ?? 'mixed',
        inPlayScore:      signal.inPlayScore      ?? 0,
        signalConfidence: signal.signalConfidence ?? 0,
      } : null,
    };
  }

  // ── Один тик мониторинга ─────────────────────────────────────
  async function tick() {
    tickCount++;
    const logSummary = (tickCount % SUMMARY_LOG_INTERVAL === 0);

    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      if (!rawSymbols) return;
      const symbols = JSON.parse(rawSymbols);

      // Читаем levels + price + signal для всех символов одним pipeline
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`levels:${sym}`);
        pipeline.get(`price:${sym}`);
        pipeline.get(`signal:${sym}`);
      }
      const results = await pipeline.exec();

      let monitoredSymbols = 0;
      let monitoredLevels  = 0;
      let approachingCount = 0;
      let touchedCount     = 0;
      let breakoutCount    = 0;
      let bounceCount      = 0;

      const writePipeline = redis.pipeline();

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawLevels] = results[i * 3];
        const [, rawPrice]  = results[i * 3 + 1];
        const [, rawSignal] = results[i * 3 + 2];

        // Пропускаем символы без уровней
        if (!rawLevels) continue;
        let activeLevels;
        try { activeLevels = JSON.parse(rawLevels); } catch (_) { continue; }
        if (!Array.isArray(activeLevels) || activeLevels.length === 0) continue;

        // Пропускаем символы без текущей цены
        if (!rawPrice) { previousPrices.delete(sym); continue; }
        const currentPrice = parseFloat(rawPrice);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        // Signal (может отсутствовать)
        let signal = null;
        if (rawSignal) {
          try { signal = JSON.parse(rawSignal); } catch (_) {}
        }

        const prevPrice = previousPrices.get(sym) ?? null;

        const computedLevels = activeLevels
          .map(level => computeLevel(level, currentPrice, prevPrice, signal))
          .filter(Boolean);

        if (computedLevels.length === 0) continue;

        // Обновляем previous price
        previousPrices.set(sym, currentPrice);

        // Статистика
        monitoredSymbols++;
        monitoredLevels += computedLevels.length;
        for (const cl of computedLevels) {
          if (cl.approaching)       approachingCount++;
          if (cl.touched)           touchedCount++;
          if (cl.breakoutCandidate) breakoutCount++;
          if (cl.bounceCandidate)   bounceCount++;
        }

        const state = {
          symbol:    sym,
          updatedAt: Date.now(),
          levels:    computedLevels,
        };

        const redisKey = `levelstate:${sym}`;
        writePipeline.setex(redisKey, LEVELSTATE_TTL_SEC, JSON.stringify(state));
        console.log(`[monitor] wrote ${redisKey} levels=${computedLevels.length}`);
      }

      const writeResults = await writePipeline.exec();
      if (writeResults) {
        for (const [writeErr] of writeResults) {
          if (writeErr) console.error('[monitor] pipeline write error:', writeErr.message);
        }
      }

      if (logSummary) {
        console.log(
          `[monitor] summary symbols=${monitoredSymbols} levels=${monitoredLevels}` +
          ` approaching=${approachingCount} touched=${touchedCount}` +
          ` breakout=${breakoutCount} bounce=${bounceCount}`
        );
      }
    } catch (err) {
      console.error('[monitor] tick error:', err.message);
    }
  }

  function start() {
    console.log('[monitor] Level monitor started (1s interval)');
    setInterval(tick, MONITOR_INTERVAL_MS);
  }

  return { start };
}

module.exports = { createLevelMonitorService };
