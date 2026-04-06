'use strict';

/**
 * screenerAlertEngine.js
 * ─────────────────────────────────────────────────────────────────
 * Screener Alert Engine — evaluates growth_alert and drop_alert
 * conditions for all active users every ENGINE_INTERVAL_MS.
 *
 * Data sources:
 *   - Redis `symbols:active:usdt`  — universe of symbols
 *   - Redis `bars:1m:{SYMBOL}`     — 1-minute bar sorted set
 *   - Redis `price:{SYMBOL}`       — live price (futures)
 *   - MySQL `screener_alert_settings` — user settings
 *
 * State machine per (userId, type, symbol, timeframe):
 *   Idle → condition enters (not in cooldown) → FIRE → conditionActive=true
 *   conditionActive → condition exits → conditionActive=false (re-armed)
 *   conditionActive (re-armed) → condition enters (not in cooldown) → FIRE
 *
 * Alert delivery:
 *   1. Global `alerts:live` sorted set  (frontend polls /api/alerts/live)
 *   2. Per-user `screener:alerts:recent:{userId}` list
 *   3. alertDeliveryService.handleAlert()  (Telegram / Web Push)
 */

const settingsService    = require('./screenerAlertSettingsService');
const alertStateStore    = require('./screenerAlertStateStore');
const recentAlertsStore  = require('./screenerRecentAlertsStore');

// ─── Constants ────────────────────────────────────────────────────

const ENGINE_INTERVAL_MS   = 10_000;            // 10-second tick
const SETTINGS_CACHE_TTL_MS = 30_000;           // refresh user settings every 30 s
const ALERT_EVENT_TTL_SEC  = 7 * 24 * 3600;    // individual alert key TTL in Redis
const GLOBAL_RECENT_LIMIT  = 500;               // alerts:live sorted set size cap

/** Minutes per timeframe string */
const TF_MINUTES = {
  '1m':  1,
  '5m':  5,
  '15m': 15,
  '30m': 30,
  '1h':  60,
  '4h':  240,
  '24h': 1440,
};

// ─── Factory ─────────────────────────────────────────────────────

function createScreenerAlertEngine(redis, db, deliveryService = null) {
  let timer    = null;
  let ticking  = false;

  // In-memory settings cache so we don't query MySQL every tick
  let settingsCache   = null;
  let settingsCachedAt = 0;

  // ── Settings cache ──────────────────────────────────────────
  async function loadEnabledUsers() {
    const now = Date.now();
    if (settingsCache && (now - settingsCachedAt) < SETTINGS_CACHE_TTL_MS) {
      return settingsCache;
    }
    try {
      const rows = await settingsService.getAllEnabledUsers(db);
      settingsCache   = rows;
      settingsCachedAt = now;
      return rows;
    } catch (err) {
      console.error('[screener.engine] Failed to load user settings:', err.message);
      return settingsCache || [];
    }
  }

  /** Invalidate the settings cache (call after PATCH /api/screener/alert-settings). */
  function invalidateSettingsCache() {
    settingsCache   = null;
    settingsCachedAt = 0;
  }

  // ── Data fetch helpers ──────────────────────────────────────

  function tryParseBar(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Batch-fetch bars and live prices for all symbols in a single pipeline.
   * Returns Map<symbol, { bars: Bar[], currentPrice: number|null }>
   */
  async function buildDataCache(symbols, maxMinutes) {
    const nowTs  = Date.now();
    // Fetch bars covering refTs (with a 5-minute buffer) so the reference
    // bar at exactly `now - tf_minutes * 60000` is reliably included.
    const fromTs = nowTs - (maxMinutes + 5) * 60_000;

    const pipeline = redis.pipeline();
    for (const sym of symbols) {
      pipeline.zrangebyscore(`bars:1m:${sym}`, fromTs, nowTs);
      pipeline.get(`price:${sym}`);
    }
    const results = await pipeline.exec();

    const cache = new Map();
    for (let i = 0; i < symbols.length; i++) {
      const barsRaw   = results[i * 2][1]     || [];
      const priceRaw  = results[i * 2 + 1][1];

      const bars = barsRaw
        .map(r => tryParseBar(r))
        .filter(b => b && b.ts && b.close != null);
      bars.sort((a, b) => a.ts - b.ts);

      let currentPrice = null;
      if (priceRaw) {
        const pv = parseFloat(priceRaw);
        if (!isNaN(pv) && pv > 0) currentPrice = pv;
      }
      // Fallback: use last bar close
      if (!currentPrice && bars.length > 0) {
        currentPrice = bars[bars.length - 1].close;
      }

      cache.set(symbols[i], { bars, currentPrice });
    }
    return cache;
  }

  // ── Change / volume calculation ──────────────────────────────

  /**
   * Compute changePct and volumeUsdt for a given timeframe.
   * @returns {{ changePct, volumeUsdt, currentPrice, referencePrice }} or null
   */
  function computeMetrics(data, timeframe, nowTs) {
    const { bars, currentPrice } = data;
    if (!bars || bars.length === 0 || !currentPrice) return null;

    const minutes = TF_MINUTES[timeframe];
    if (!minutes) return null;

    const refTs = nowTs - minutes * 60_000;

    // Reference bar: last bar with ts <= refTs
    let refBar = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= refTs) {
        refBar = bars[i];
        break;
      }
    }
    if (!refBar || !refBar.close || refBar.close <= 0) return null;

    const referencePrice = refBar.close;
    const changePct      = ((currentPrice - referencePrice) / referencePrice) * 100;

    // Volume: sum all bars from refTs onwards
    let volumeUsdt = 0;
    for (const b of bars) {
      if (b.ts >= refTs && b.volumeUsdt != null) {
        volumeUsdt += b.volumeUsdt;
      }
    }

    return {
      changePct,
      volumeUsdt,
      currentPrice,
      referencePrice,
    };
  }

  // ── Alert push ───────────────────────────────────────────────

  async function pushToGlobalQueue(event) {
    const json = JSON.stringify(event);
    const p    = redis.pipeline();
    p.set(`alert:${event.id}`, json, 'EX', ALERT_EVENT_TTL_SEC);
    p.zadd('alerts:live', event.createdAt, json);
    p.zremrangebyrank('alerts:live', 0, -(GLOBAL_RECENT_LIMIT + 1));
    await p.exec();
  }

  function buildAlertEvent(userId, type, symbol, timeframe, metrics, userRow) {
    const direction = type === 'growth_alert' ? 'up' : 'down';
    const threshold = type === 'growth_alert'
      ? parseFloat(userRow.growth_percent_threshold)
      : parseFloat(userRow.drop_percent_threshold);

    return {
      id:             `${symbol}-${type}-${Date.now()}-${userId}`,
      type,
      symbol,
      market:         'futures',
      timeframe,
      changePct:      parseFloat(metrics.changePct.toFixed(4)),
      thresholdPct:   threshold,
      currentPrice:   metrics.currentPrice,
      referencePrice: metrics.referencePrice,
      volumeUsdt:     Math.round(metrics.volumeUsdt),
      triggeredAt:    Date.now(),
      direction,
      priority:       'normal',
      severity:       'medium',
      source:         'screener_alert_engine',
      userId,
      createdAt:      Date.now(),
    };
  }

  // ── Tick ────────────────────────────────────────────────────

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await runTick();
    } catch (err) {
      console.error('[screener.engine] Tick error:', err.message);
    } finally {
      ticking = false;
    }
  }

  async function runTick() {
    // 1. Load active users (cached every 30 s)
    const userRows = await loadEnabledUsers();
    if (userRows.length === 0) return;

    // 2. Get universe symbols
    const symbolsRaw = await redis.get('symbols:active:usdt');
    if (!symbolsRaw) return;
    let symbols;
    try { symbols = JSON.parse(symbolsRaw); } catch { return; }
    if (!symbols || symbols.length === 0) return;

    // 3. Determine required timeframes and max minutes
    const neededTfs = new Set();
    for (const u of userRows) {
      if (u.growth_enabled) neededTfs.add(u.growth_timeframe);
      if (u.drop_enabled)   neededTfs.add(u.drop_timeframe);
    }
    if (neededTfs.size === 0) return;

    const maxMinutes = Math.max(...[...neededTfs].map(tf => TF_MINUTES[tf] || 15));
    const nowTs      = Date.now();

    // 4. Batch-fetch bars + live prices for all symbols
    const dataCache = await buildDataCache(symbols, maxMinutes);

    // 5. Pre-compute metrics per (symbol × timeframe) so multiple users
    //    sharing the same settings don't repeat the computation.
    const metricsCache = new Map(); // key: `${symbol}:${tf}`
    for (const sym of symbols) {
      const data = dataCache.get(sym);
      if (!data) continue;
      for (const tf of neededTfs) {
        const m = computeMetrics(data, tf, nowTs);
        if (m) metricsCache.set(`${sym}:${tf}`, m);
      }
    }

    // 6. Build the list of state keys we need
    const stateDescriptors = [];
    for (const u of userRows) {
      const uid = u.user_id;
      for (const sym of symbols) {
        if (u.growth_enabled) stateDescriptors.push({ userId: uid, type: 'growth', symbol: sym, timeframe: u.growth_timeframe });
        if (u.drop_enabled)   stateDescriptors.push({ userId: uid, type: 'drop',   symbol: sym, timeframe: u.drop_timeframe   });
      }
    }

    // 7. Batch-load all states
    const stateMap = await alertStateStore.batchGetStates(redis, stateDescriptors);

    // 8. Evaluate conditions for every user × symbol
    const stateUpdates = new Map();
    const alertEvents  = [];

    for (const u of userRows) {
      const uid = u.user_id;

      for (const sym of symbols) {
        // ── Growth ──────────────────────────────────────────
        if (u.growth_enabled) {
          const tf    = u.growth_timeframe;
          const m     = metricsCache.get(`${sym}:${tf}`);
          if (m) {
            const condMet = m.changePct >= parseFloat(u.growth_percent_threshold) &&
              (!u.growth_volume_filter_enabled || m.volumeUsdt >= parseFloat(u.growth_min_volume_usdt));

            const stKey   = alertStateStore.stateKey(uid, 'growth', sym, tf);
            const state   = stateMap.get(stKey) || { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0 };
            const newState = { ...state };
            let dirty      = false;

            if (condMet) {
              if (!state.conditionActive) {
                // Condition just entered
                if (nowTs >= (state.cooldownUntil || 0)) {
                  // FIRE — re-arm has happened (conditionActive was false)
                  const cooldownMs = parseInt(u.growth_cooldown_minutes, 10) * 60_000;
                  newState.conditionActive = true;
                  newState.lastTriggeredAt = nowTs;
                  newState.cooldownUntil   = nowTs + cooldownMs;
                  newState.lastChangePct   = m.changePct;
                  newState.lastVolumeUsdt  = m.volumeUsdt;
                  dirty = true;
                  alertEvents.push({ userId: uid, type: 'growth_alert', symbol: sym, timeframe: tf, metrics: m, userRow: u });
                } else {
                  // In cooldown: mark conditionActive so we don't re-check until it exits
                  newState.conditionActive = true;
                  dirty = true;
                }
              }
              // conditionActive already true: nothing changes
            } else {
              // Condition not met
              if (state.conditionActive) {
                // Condition just exited — re-arm
                newState.conditionActive = false;
                dirty = true;
              }
            }

            if (dirty) stateUpdates.set(stKey, newState);
          }
        }

        // ── Drop ─────────────────────────────────────────────
        if (u.drop_enabled) {
          const tf    = u.drop_timeframe;
          const m     = metricsCache.get(`${sym}:${tf}`);
          if (m) {
            const condMet = m.changePct <= -parseFloat(u.drop_percent_threshold) &&
              (!u.drop_volume_filter_enabled || m.volumeUsdt >= parseFloat(u.drop_min_volume_usdt));

            const stKey   = alertStateStore.stateKey(uid, 'drop', sym, tf);
            const state   = stateMap.get(stKey) || { conditionActive: false, cooldownUntil: 0, lastTriggeredAt: 0 };
            const newState = { ...state };
            let dirty      = false;

            if (condMet) {
              if (!state.conditionActive) {
                if (nowTs >= (state.cooldownUntil || 0)) {
                  // FIRE
                  const cooldownMs = parseInt(u.drop_cooldown_minutes, 10) * 60_000;
                  newState.conditionActive = true;
                  newState.lastTriggeredAt = nowTs;
                  newState.cooldownUntil   = nowTs + cooldownMs;
                  newState.lastChangePct   = m.changePct;
                  newState.lastVolumeUsdt  = m.volumeUsdt;
                  dirty = true;
                  alertEvents.push({ userId: uid, type: 'drop_alert', symbol: sym, timeframe: tf, metrics: m, userRow: u });
                } else {
                  newState.conditionActive = true;
                  dirty = true;
                }
              }
            } else {
              if (state.conditionActive) {
                newState.conditionActive = false;
                dirty = true;
              }
            }

            if (dirty) stateUpdates.set(stKey, newState);
          }
        }
      }
    }

    // 9. Batch-write state updates
    await alertStateStore.batchSetStates(redis, stateUpdates);

    // 10. Deliver alerts
    for (const a of alertEvents) {
      const event = buildAlertEvent(a.userId, a.type, a.symbol, a.timeframe, a.metrics, a.userRow);
      try {
        // Push to global live feed
        await pushToGlobalQueue(event);
        // Push to per-user recent list
        await recentAlertsStore.pushAlert(redis, a.userId, event);

        console.log(
          `[screener.alert] type=${event.type} symbol=${event.symbol} user=${a.userId}` +
          ` tf=${event.timeframe} changePct=${event.changePct.toFixed(2)}%` +
          ` vol=${event.volumeUsdt.toLocaleString()}`,
        );

        // Telegram / Web Push via existing delivery service
        if (deliveryService) {
          deliveryService.handleAlert(event).catch(err =>
            console.error('[screener.engine] delivery error:', err.message),
          );
        }
      } catch (err) {
        console.error(`[screener.engine] pushAlert failed for ${event.symbol}:`, err.message);
      }
    }
  }

  // ── Public interface ────────────────────────────────────────

  function start() {
    console.log('[screener.engine] Screener alert engine started — 10s tick');
    timer = setInterval(tick, ENGINE_INTERVAL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, invalidateSettingsCache };
}

module.exports = { createScreenerAlertEngine };
