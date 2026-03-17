'use strict';

// ─── Env helpers ─────────────────────────────────────────────────
function envBool(key, def) {
  const v = process.env[key];
  return v === undefined ? def : v.toLowerCase() === 'true';
}
function envInt(key, def) {
  const v = parseInt(process.env[key], 10);
  return isNaN(v) ? def : v;
}
function envFloat(key, def) {
  const v = parseFloat(process.env[key]);
  return isNaN(v) ? def : v;
}

// ─── Config accessors (read each tick so env changes take effect) ─
function cfg() {
  return {
    enabled:             envBool ('MARKET_IMPULSE_ENABLED',              true),
    windowSec:           envInt  ('MARKET_IMPULSE_WINDOW_SEC',           5),
    priceMovePct:        envFloat('MARKET_IMPULSE_PRICE_MOVE_PCT',       2.5),
    volumeSpikeRatio:    envFloat('MARKET_IMPULSE_VOLUME_SPIKE_RATIO',   2.0),
    baselineSec:         envInt  ('MARKET_IMPULSE_BASELINE_SEC',         60),
    minBaselineVolume:   envFloat('MARKET_IMPULSE_MIN_BASELINE_VOLUME',  1),
    requireFullBaseline: envBool ('MARKET_IMPULSE_REQUIRE_FULL_BASELINE', true),
    debug:               envBool ('MARKET_IMPULSE_DEBUG',                false),
  };
}

// ─── Constants ───────────────────────────────────────────────────
const ENGINE_INTERVAL_MS   = 1000;
const COOLDOWN_SEC         = 60;           // alert engine cooldown per symbol
const ALERT_EVENT_TTL_SEC  = 7 * 24 * 3600;
const ALERT_RECENT_LIMIT   = 500;
const PRICE_HISTORY_MAX_MS = 90 * 1000;   // keep last 90s of price points
const SUMMARY_LOG_INTERVAL = 30;          // ticks between summary log lines

// ─── Utility ─────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ─── Factory ─────────────────────────────────────────────────────
function createMarketImpulseService(redis, deliveryService = null) {
  // per-symbol rolling price history: [{ ts: number(ms), price: number }] sorted asc
  const priceHistories = new Map();

  let tickCount   = 0;
  let totalAlerts = 0;

  // ── Price history helpers ────────────────────────────────────
  function getPriceHistory(symbol) {
    if (!priceHistories.has(symbol)) priceHistories.set(symbol, []);
    return priceHistories.get(symbol);
  }

  function addPricePoint(symbol, price, nowMs) {
    const hist   = getPriceHistory(symbol);
    const cutoff = nowMs - PRICE_HISTORY_MAX_MS;
    // trim stale points from front
    while (hist.length > 0 && hist[0].ts < cutoff) hist.shift();
    hist.push({ ts: nowMs, price });
  }

  // Returns the price closest to (nowMs - seconds * 1000) from below,
  // or null if not enough history or the point is too stale (> 2s off target)
  function getPriceNSecondsAgo(symbol, seconds, nowMs) {
    const hist     = getPriceHistory(symbol);
    const targetTs = nowMs - seconds * 1000;
    let result     = null;
    for (const pt of hist) {
      if (pt.ts <= targetTs) result = pt;
      else break;
    }
    if (!result) return null;
    // reject if the best point is more than 2s before targetTs
    if (targetTs - result.ts > 2000) return null;
    return result.price;
  }

  function hasFullBaseline(symbol, nowMs, baselineSec) {
    const hist = getPriceHistory(symbol);
    if (hist.length < 2) return false;
    return (nowMs - hist[0].ts) >= baselineSec * 1000;
  }

  // ── Cooldown (reuses existing alertcooldown key space) ───────
  async function isCooldownActive(symbol) {
    const v = await redis.get(`alertcooldown:market_impulse:${symbol}:generic`);
    return v !== null;
  }

  async function setCooldown(symbol) {
    await redis.set(`alertcooldown:market_impulse:${symbol}:generic`, '1', 'EX', COOLDOWN_SEC);
  }

  // ── Persist alert to Redis ───────────────────────────────────
  async function pushAlert(event) {
    const json = JSON.stringify(event);
    const p    = redis.pipeline();
    p.set(`alert:${event.id}`, json, 'EX', ALERT_EVENT_TTL_SEC);
    p.lpush('alerts:recent', json);
    p.ltrim('alerts:recent', 0, ALERT_RECENT_LIMIT - 1);
    await p.exec();
    totalAlerts++;

    const sc = event.signalContext;
    console.log(
      `[impulse] detected symbol=${event.symbol}` +
      ` dir=${sc.impulseDirection}` +
      ` move5s=${sc.priceMovePct5s.toFixed(2)}%` +
      ` volSpike=${sc.volumeSpikeRatio.toFixed(2)}x` +
      ` score=${Math.round(sc.impulseScore)}`
    );

    if (deliveryService) {
      deliveryService.handleAlert(event).catch(err =>
        console.error('[impulse] delivery error:', err.message)
      );
    }
  }

  // ── Core computation ─────────────────────────────────────────
  function computeImpulseMetrics(symbol, currentPrice, metrics, nowMs, c) {
    // Baseline check
    if (c.requireFullBaseline && !hasFullBaseline(symbol, nowMs, c.baselineSec)) {
      return null; // still in warmup
    }

    // Price 5s ago
    const price5sAgo = getPriceNSecondsAgo(symbol, c.windowSec, nowMs);
    if (price5sAgo === null || price5sAgo === 0) return null;

    const priceMovePct5s = ((currentPrice - price5sAgo) / price5sAgo) * 100;
    if (Math.abs(priceMovePct5s) < c.priceMovePct) return null;

    // Volume derived from metrics already computed by collector
    const volume5s        = metrics.volumeUsdt5s  || 0;
    const volumeUsdt60s   = metrics.volumeUsdt60s || 0;
    // baseline = average 5s-window volume over last 60s = total60s / (60/5 windows)
    const windows5sIn60s  = Math.max(c.baselineSec / c.windowSec, 1);
    const baselineVolume5s = volumeUsdt60s / windows5sIn60s;

    if (baselineVolume5s <= c.minBaselineVolume) return null;

    const volumeSpikeRatio = volume5s / baselineVolume5s;
    if (volumeSpikeRatio < c.volumeSpikeRatio) return null;

    // Direction — only UP or DOWN, never MIXED
    const impulseDirection = priceMovePct5s > 0 ? 'UP' : 'DOWN';

    // Confidence: how far above thresholds are we?
    const priceFactor  = Math.abs(priceMovePct5s) / c.priceMovePct;
    const volumeFactor = volumeSpikeRatio / c.volumeSpikeRatio;
    const signalConfidence = clamp(((priceFactor + volumeFactor) / 2) * 100, 0, 100);

    // Derived impulse score — compatible with existing Telegram filters
    const impulseScore = (Math.abs(priceMovePct5s) * 40) + (volumeSpikeRatio * 50);

    // Severity
    const severity = (Math.abs(priceMovePct5s) >= 5.0 && volumeSpikeRatio >= 3.0)
      ? 'critical'
      : 'high';

    return {
      impulseDirection,
      impulseScore,
      signalConfidence,
      priceMovePct5s,
      volume5s,
      baselineVolume5s,
      volumeSpikeRatio,
      impulseWindowSec: c.windowSec,
      severity,
    };
  }

  // ── Main tick ────────────────────────────────────────────────
  async function tick() {
    tickCount++;
    const logSummary = (tickCount % SUMMARY_LOG_INTERVAL === 0);
    const c = cfg();

    if (!c.enabled) return;

    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      if (!rawSymbols) return;
      const symbols = JSON.parse(rawSymbols);
      const nowMs   = Date.now();

      // Batch read price + metrics for all symbols
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`price:${sym}`);
        pipeline.get(`metrics:${sym}`);
      }
      const results = await pipeline.exec();

      let warmupCount   = 0;
      let detectedCount = 0;

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawPrice]   = results[i * 2];
        const [, rawMetrics] = results[i * 2 + 1];

        if (!rawPrice || !rawMetrics) continue;

        const currentPrice = parseFloat(rawPrice);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        let metrics;
        try { metrics = JSON.parse(rawMetrics); } catch (_) { continue; }

        // Record price point BEFORE computing (so history includes current price)
        addPricePoint(sym, currentPrice, nowMs);

        const m = computeImpulseMetrics(sym, currentPrice, metrics, nowMs, c);

        if (!m) {
          if (c.requireFullBaseline && !hasFullBaseline(sym, nowMs, c.baselineSec)) {
            warmupCount++;
          }
          continue;
        }

        // Per-symbol alert engine cooldown
        const onCooldown = await isCooldownActive(sym);
        if (onCooldown) continue;

        const id    = `${sym}-market_impulse-${nowMs}-generic`;
        const event = {
          id,
          type:         'market_impulse',
          symbol:       sym,
          severity:     m.severity,
          title:        `${sym} market impulse detected`,
          message:      `${sym} moved ${m.priceMovePct5s.toFixed(2)}% in ${c.windowSec}s with ${m.volumeSpikeRatio.toFixed(2)}x volume spike`,
          createdAt:    nowMs,
          currentPrice,
          signalContext: {
            impulseDirection:  m.impulseDirection,
            impulseScore:      m.impulseScore,
            signalConfidence:  m.signalConfidence,
            priceMovePct5s:    parseFloat(m.priceMovePct5s.toFixed(4)),
            volume5s:          m.volume5s,
            baselineVolume5s:  parseFloat(m.baselineVolume5s.toFixed(2)),
            volumeSpikeRatio:  parseFloat(m.volumeSpikeRatio.toFixed(4)),
            impulseWindowSec:  m.impulseWindowSec,
          },
        };

        await pushAlert(event);
        await setCooldown(sym);
        detectedCount++;
      }

      if (logSummary) {
        console.log(
          `[impulse] summary tick=${tickCount}` +
          ` warmed=${symbols.length - warmupCount}/${symbols.length}` +
          ` detected=${detectedCount} total=${totalAlerts}`
        );
      }
    } catch (err) {
      console.error('[impulse] tick error:', err.message);
    }
  }

  function start() {
    console.log('[impulse] Market impulse service started — 5s price move + 2x volume spike rule');
    let running = false;
    setInterval(async () => {
      if (running) return; // skip if previous tick still in progress
      running = true;
      try { await tick(); } finally { running = false; }
    }, ENGINE_INTERVAL_MS);
  }

  return { start };
}

module.exports = { createMarketImpulseService };
