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
    // --- classic impulse: 2.5% in 5s + 2x volume spike ---
    enabled:             envBool ('MARKET_IMPULSE_ENABLED',              true),
    windowSec:           envInt  ('MARKET_IMPULSE_WINDOW_SEC',           5),
    priceMovePct:        envFloat('MARKET_IMPULSE_PRICE_MOVE_PCT',       2.5),
    volumeSpikeRatio:    envFloat('MARKET_IMPULSE_VOLUME_SPIKE_RATIO',   2.0),
    baselineSec:         envInt  ('MARKET_IMPULSE_BASELINE_SEC',         60),
    minBaselineVolume:   envFloat('MARKET_IMPULSE_MIN_BASELINE_VOLUME',  1),
    requireFullBaseline: envBool ('MARKET_IMPULSE_REQUIRE_FULL_BASELINE', true),
    debug:               envBool ('MARKET_IMPULSE_DEBUG',                false),
    // --- surge: 5%+ in 60s, no volume spike required ---
    surgeEnabled:        envBool ('PRICE_SURGE_ENABLED',                 true),
    surgeWindowSec:      envInt  ('PRICE_SURGE_WINDOW_SEC',              60),
    surgeMovePct:        envFloat('PRICE_SURGE_MOVE_PCT',                5.0),
    surgeCooldownSec:    envInt  ('PRICE_SURGE_COOLDOWN_SEC',            300),
  };
}

// ─── Constants ───────────────────────────────────────────────────
const ENGINE_INTERVAL_MS   = 1000;
const COOLDOWN_SEC         = 60;           // alert engine cooldown per symbol
const ALERT_EVENT_TTL_SEC  = 7 * 24 * 3600;
const ALERT_RECENT_LIMIT   = 500;
const PRICE_HISTORY_MAX_MS = 130 * 1000;  // keep last 130s of price points (covers 60s surge window)
const SUMMARY_LOG_INTERVAL = 30;          // ticks between summary log lines

// ─── Utility ─────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ─── Composite impulse score helpers ────────────────────────────
const DOM_TOP_N            = 20;   // top N levels for DOM notional sum
const IMPULSE_SIGNAL_TTL   = 15;   // seconds TTL for impulse:signal:{sym}
const TICKS_MAX_COUNT      = 300;  // rolling 1s ticks kept per symbol (~5 min)

// ─── Multi-window trigger thresholds (configurable via env) ──────
const TRIGGER_1S_PCT  = parseFloat(process.env.IMPULSE_TRIGGER_1S_PCT  || '1.5');
const TRIGGER_5S_PCT  = parseFloat(process.env.IMPULSE_TRIGGER_5S_PCT  || '2.5');
const TRIGGER_15S_PCT = parseFloat(process.env.IMPULSE_TRIGGER_15S_PCT || '3.5');
const TRIGGER_60S_PCT = parseFloat(process.env.IMPULSE_TRIGGER_60S_PCT || '5.0');

// ─── 24h liquidity gate ──────────────────────────────────────────
// A coin only enters the impulse active list when BOTH its 24h quote
// volume and 24h trade count clear these minimums (read from
// futures:tickers:all → quoteVolume / count).
const MIN_VOL_24H_USD = parseFloat(process.env.IMPULSE_MIN_VOL_24H_USD || '40000000');
const MIN_TRADES_24H  = parseInt(process.env.IMPULSE_MIN_TRADES_24H || '500000', 10);

// How long (ms) an active impulse coin stays in the list after detection
const ACTIVE_TTL_MS = parseInt(process.env.IMPULSE_ACTIVE_TTL_MS || '60000', 10);

// ─── Factory ─────────────────────────────────────────────────────
function createMarketImpulseService(redis, deliveryService = null) {
  // per-symbol rolling price history: [{ ts: number(ms), price: number }] sorted asc
  const priceHistories = new Map();

  // OI state per symbol for change-% computation
  // { oi: number, ts: number }
  const oiState = new Map();

  // Active impulse tracking (in-memory, survives service restarts via activeUntil in payload)
  const activeUntilMap = new Map(); // symbol → ms timestamp until which coin stays in active list
  const detectedAtMap  = new Map(); // symbol → ms timestamp of first detection in current window

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

  // Returns % price change over the last N seconds, or null if history is insufficient.
  // Must be called AFTER addPricePoint for the current tick.
  function computeMovePct(symbol, seconds, nowMs, currentPrice) {
    const oldPrice = getPriceNSecondsAgo(symbol, seconds, nowMs);
    if (oldPrice === null || oldPrice === 0) return null;
    return ((currentPrice - oldPrice) / oldPrice) * 100;
  }

  // ── Cooldown (reuses existing alertcooldown key space) ───────
  async function isCooldownActive(symbol) {
    const v = await redis.get(`alertcooldown:market_impulse:${symbol}:generic`);
    return v !== null;
  }

  async function setCooldown(symbol) {
    await redis.set(`alertcooldown:market_impulse:${symbol}:generic`, '1', 'EX', COOLDOWN_SEC);
  }

  // ── Surge cooldown (independent from impulse cooldown) ───────
  async function isSurgeCooldownActive(symbol) {
    const v = await redis.get(`alertcooldown:price_surge:${symbol}:generic`);
    return v !== null;
  }
  async function setSurgeCooldown(symbol, sec) {
    await redis.set(`alertcooldown:price_surge:${symbol}:generic`, '1', 'EX', sec);
  }

  // ── Persist alert to Redis ───────────────────────────────────
  async function pushAlert(event) {
    const json = JSON.stringify(event);
    const p    = redis.pipeline();
    p.set(`alert:${event.id}`, json, 'EX', ALERT_EVENT_TTL_SEC);
    p.lpush('alerts:recent', json);
    p.ltrim('alerts:recent', 0, ALERT_RECENT_LIMIT - 1);
    // Sorted set for timestamp-based polling (GET /api/alerts/live?since=<ts>)
    p.zadd('alerts:live', event.createdAt, json);
    p.zremrangebyrank('alerts:live', 0, -(ALERT_RECENT_LIMIT + 1));
    await p.exec();
    totalAlerts++;

    const sc = event.signalContext || {};
    const movePct = sc.impulseMovePct ?? sc.priceMovePct5s ?? null;
    const winSec  = sc.impulseWindow  ?? sc.impulseWindowSec ?? '?';
    console.log(
      `[alert.published] id=${event.id} type=${event.type} symbol=${event.symbol} priority=${event.priority}` +
      ` dir=${sc.impulseDirection}` +
      (movePct != null ? ` move=${parseFloat(movePct).toFixed(2)}%/${winSec}s` : '') +
      ` score=${Math.round(sc.impulseScore ?? 0)}`
    );

    if (deliveryService) {
      deliveryService.handleAlert(event).catch(err =>
        console.error('[impulse] delivery error:', err.message)
      );
    }
  }

  // ── Fire alert with per-window cooldown ─────────────────────
  async function _fireAlert(sym, currentPrice, impulseWindow, impulseMovePct, direction, nowMs, metrics2) {
    const isShort    = impulseWindow <= 5;
    const onCooldown = isShort
      ? await isCooldownActive(sym)
      : await isSurgeCooldownActive(sym);
    if (onCooldown) return;

    const alertType  = isShort ? 'market_impulse' : 'price_surge';
    const movePctAbs = Math.abs(impulseMovePct);
    const severity   = movePctAbs >= 5.0 ? 'critical' : 'high';
    const id         = `${sym}-${alertType}-${nowMs}-generic`;

    const vol15    = metrics2?.volumeUsdt15s ?? 0;
    const vol60    = Math.max(metrics2?.volumeUsdt60s ?? 0, 1);
    const vsr15    = parseFloat((vol15 / Math.max(vol60 / 4, 1)).toFixed(4));
    const trades15 = metrics2?.tradeCount15s ?? 0;
    const trades60 = Math.max(metrics2?.tradeCount60s ?? 0, 1);
    const ta       = parseFloat((trades15 / Math.max(trades60 / 4, 1)).toFixed(4));

    const event = {
      id,
      type:      alertType,
      symbol:    sym,
      severity,
      priority:  severity,
      title:     `${sym} impulse ${direction.toUpperCase()} ${impulseMovePct.toFixed(2)}% / ${impulseWindow}s`,
      message:   `${sym} moved ${impulseMovePct.toFixed(2)}% in ${impulseWindow}s`,
      createdAt: nowMs,
      currentPrice,
      signalContext: {
        impulseDirection:    direction,
        impulseWindow,
        impulseMovePct:      parseFloat(impulseMovePct.toFixed(4)),
        volumeSpikeRatio15s: vsr15,
        tradeAcceleration:   ta,
        deltaUsdt60s:        parseFloat((metrics2?.deltaUsdt60s ?? 0).toFixed(2)),
        impulseScore:        0,
        // legacy compat so existing alert formatters don't break
        priceMovePct5s:      parseFloat(impulseMovePct.toFixed(4)),
        volumeSpikeRatio:    vsr15,
        impulseWindowSec:    impulseWindow,
      },
    };

    await pushAlert(event);
    if (isShort) await setCooldown(sym);
    else         await setSurgeCooldown(sym, envInt('PRICE_SURGE_COOLDOWN_SEC', 300));
  }

  // ── Main tick ────────────────────────────────────────────────
  async function tick() {
    tickCount++;
    const logSummary = (tickCount % SUMMARY_LOG_INTERVAL === 0);

    if (!envBool('MARKET_IMPULSE_ENABLED', true)) return;

    try {
      const rawSymbols = await redis.get('symbols:active:usdt');
      if (!rawSymbols) return;
      const symbols = JSON.parse(rawSymbols);
      const nowMs   = Date.now();

      // 24h liquidity map (symbol → ticker) for the active-list gate. When the
      // key is unavailable we fail open (gate disabled) to avoid emptying the
      // list during a transient ticker-refresh gap.
      let tickerMap = null;
      try {
        const rawTickers = await redis.get('futures:tickers:all');
        if (rawTickers) {
          const arr = JSON.parse(rawTickers);
          if (Array.isArray(arr)) {
            tickerMap = new Map();
            for (const t of arr) if (t && t.symbol) tickerMap.set(t.symbol, t);
          }
        }
      } catch (_) { /* fail open */ }

      // Batch read: price, metrics, signal, oi, orderbook
      const pipeline = redis.pipeline();
      for (const sym of symbols) {
        pipeline.get(`price:${sym}`);
        pipeline.get(`metrics:${sym}`);
        pipeline.get(`signal:${sym}`);
        pipeline.get(`oi:${sym}`);
        pipeline.get(`futures:orderbook:${sym}`);
      }
      const results = await pipeline.exec();
      if (!results) {
        console.error('[marketImpulse] read pipeline returned no result');
        return;
      }

      const writePipeline = redis.pipeline();
      let impulseWriteCount = 0;
      let detectedCount     = 0;

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawPrice]     = results[i * 5]     || [null, null];
        const [, rawMetrics]   = results[i * 5 + 1] || [null, null];
        const [, rawSignal]    = results[i * 5 + 2] || [null, null];
        const [, rawOI]        = results[i * 5 + 3] || [null, null];
        const [, rawOrderbook] = results[i * 5 + 4] || [null, null];

        if (!rawPrice || !rawMetrics) continue;

        const currentPrice = parseFloat(rawPrice);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        let metrics2;
        try { metrics2 = JSON.parse(rawMetrics); } catch (_) { continue; }

        // Record price point BEFORE computing moves (history includes current tick)
        addPricePoint(sym, currentPrice, nowMs);

        // ── Multi-window price moves ─────────────────────────────
        const move1s  = computeMovePct(sym, 1,  nowMs, currentPrice);
        const move5s  = computeMovePct(sym, 5,  nowMs, currentPrice);
        const move15s = computeMovePct(sym, 15, nowMs, currentPrice);
        const move60s = computeMovePct(sym, 60, nowMs, currentPrice);

        // ── Trigger conditions ───────────────────────────────────
        const triggers = [];
        if (move1s  !== null && Math.abs(move1s)  >= TRIGGER_1S_PCT)  triggers.push({ window: 1,  pct: move1s  });
        if (move5s  !== null && Math.abs(move5s)  >= TRIGGER_5S_PCT)  triggers.push({ window: 5,  pct: move5s  });
        if (move15s !== null && Math.abs(move15s) >= TRIGGER_15S_PCT) triggers.push({ window: 15, pct: move15s });
        if (move60s !== null && Math.abs(move60s) >= TRIGGER_60S_PCT) triggers.push({ window: 60, pct: move60s });

        // ── 24h liquidity gate: exclude thin coins from the active list ──
        let liquidityEligible = true;
        if (tickerMap) {
          const t24       = tickerMap.get(sym);
          const vol24h    = t24 ? (parseFloat(t24.quoteVolume) || 0) : 0;
          const trades24h = t24 ? (parseInt(t24.count, 10) || 0)     : 0;
          liquidityEligible = vol24h >= MIN_VOL_24H_USD && trades24h >= MIN_TRADES_24H;
        }

        const impulseFired = triggers.length > 0 && liquidityEligible;

        // ── Best trigger: max |pct|, tie-break shorter window ────
        let impulseWindow = null, impulseMovePct = null;
        if (impulseFired) {
          triggers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || a.window - b.window);
          impulseWindow  = triggers[0].window;
          impulseMovePct = triggers[0].pct;
        }

        // ── Direction ────────────────────────────────────────────
        let impulseDirection;
        if (impulseFired) {
          const dirs = new Set(triggers.map(t => t.pct > 0 ? 'up' : 'down'));
          impulseDirection = dirs.size > 1 ? 'mixed' : [...dirs][0];
        } else {
          const ref = move60s ?? move15s ?? move5s ?? move1s ?? 0;
          impulseDirection = ref > 0.1 ? 'up' : ref < -0.1 ? 'down' : 'neutral';
        }

        // ── Active list (coins stay ACTIVE_TTL_MS after trigger) ─
        let detectedAt = detectedAtMap.get(sym) ?? null;
        if (impulseFired) {
          const prev = activeUntilMap.get(sym) ?? 0;
          activeUntilMap.set(sym, Math.max(prev, nowMs + ACTIVE_TTL_MS));
          // Fresh detection when no previous active window or it already expired
          if (detectedAt === null || (nowMs - detectedAt) >= ACTIVE_TTL_MS) {
            detectedAtMap.set(sym, nowMs);
            detectedAt = nowMs;
          }
          detectedCount++;
        }
        const activeUntil = activeUntilMap.get(sym) ?? 0;

        // ── Alerts ───────────────────────────────────────────────
        if (impulseFired) {
          _fireAlert(sym, currentPrice, impulseWindow, impulseMovePct, impulseDirection, nowMs, metrics2)
            .catch(err => console.error('[impulse] alert err:', err.message));
        }

        // ── OI change ────────────────────────────────────────────
        let oiChangePct = 0;
        if (rawOI) {
          try {
            const oiData = JSON.parse(rawOI);
            if (oiData && oiData.oiValue > 0) {
              const prev = oiState.get(sym);
              if (prev && prev.oi > 0) {
                oiChangePct = ((oiData.oiValue - prev.oi) / prev.oi) * 100;
              }
              oiState.set(sym, { oi: oiData.oiValue, ts: oiData.ts });
            }
          } catch (_) {}
        }

        // ── DOM split ────────────────────────────────────────────
        let domBidPct = 50, domAskPct = 50;
        if (rawOrderbook) {
          try {
            const ob = JSON.parse(rawOrderbook);
            const bids = ob.bids || [], asks = ob.asks || [];
            let bidNotional = 0, askNotional = 0;
            for (let j = 0; j < Math.min(bids.length, DOM_TOP_N); j++) {
              const b = bids[j];
              if (Array.isArray(b))  bidNotional += b[0] * b[1];
              else if (b?.usdValue)  bidNotional += b.usdValue;
              else if (b?.price)     bidNotional += b.price * b.size;
            }
            for (let j = 0; j < Math.min(asks.length, DOM_TOP_N); j++) {
              const a = asks[j];
              if (Array.isArray(a))  askNotional += a[0] * a[1];
              else if (a?.usdValue)  askNotional += a.usdValue;
              else if (a?.price)     askNotional += a.price * a.size;
            }
            const total = bidNotional + askNotional;
            if (total > 0) {
              domBidPct = parseFloat(((bidNotional / total) * 100).toFixed(2));
              domAskPct = parseFloat(((askNotional / total) * 100).toFixed(2));
            }
          } catch (_) {}
        }

        // ── Volume spike & trade acceleration ────────────────────
        let signal2 = null;
        if (rawSignal) { try { signal2 = JSON.parse(rawSignal); } catch (_) {} }

        const vol15    = metrics2.volumeUsdt15s ?? 0;
        const vol60    = Math.max(metrics2.volumeUsdt60s ?? 0, 1);
        const vsr15    = parseFloat(clamp(
          signal2?.volumeSpikeRatio15s ?? (vol15 / Math.max(vol60 / 4, 1)),
          0, 100
        ).toFixed(4));

        const trades15 = metrics2.tradeCount15s ?? 0;
        const trades60 = Math.max(metrics2.tradeCount60s ?? 0, 1);
        const ta       = parseFloat(clamp(
          signal2?.tradeAcceleration ?? (trades15 / Math.max(trades60 / 4, 1)),
          0, 100
        ).toFixed(4));

        const deltaUsdt60s = metrics2.deltaUsdt60s ?? 0;

        // ── New impulse score (0–100) ─────────────────────────────
        // volumeScore = min(vsr15/3, 1)*30  speedScore = min(ta/3, 1)*20
        // moveScore   = min(|movePct|/5, 1)*25  deltaScore = min(|delta|/deltaNorm, 1)*15
        // oiScore     = min(|oiChg|/3, 1)*10
        const deltaNorm  = Math.max(vol60 * 0.3, 1);
        const volScore   = clamp(vsr15 / 3.0, 0, 1) * 30;
        const spdScore   = clamp(ta / 3.0, 0, 1) * 20;
        const moveScore  = clamp(Math.abs(impulseMovePct ?? 0) / 5.0, 0, 1) * 25;
        const deltaScore = clamp(Math.abs(deltaUsdt60s) / deltaNorm, 0, 1) * 15;
        const oiScore    = clamp(Math.abs(oiChangePct) / 3.0, 0, 1) * 10;
        const impulseScore = Math.min(
          Math.round((volScore + spdScore + moveScore + deltaScore + oiScore) * 10) / 10,
          100
        );

        // ── Build & write signal payload ──────────────────────────
        const signalPayload = {
          symbol:              sym,
          price:               currentPrice,
          impulseDirection,
          impulseWindow,
          impulseMovePct:      impulseMovePct !== null ? parseFloat(impulseMovePct.toFixed(4)) : null,
          move1sPct:           move1s  !== null ? parseFloat(move1s.toFixed(4))  : null,
          move5sPct:           move5s  !== null ? parseFloat(move5s.toFixed(4))  : null,
          move15sPct:          move15s !== null ? parseFloat(move15s.toFixed(4)) : null,
          move60sPct:          move60s !== null ? parseFloat(move60s.toFixed(4)) : null,
          volumeSpikeRatio15s: vsr15,
          tradeAcceleration:   ta,
          deltaUsdt60s:        parseFloat(deltaUsdt60s.toFixed(2)),
          oiChangePct:         parseFloat(oiChangePct.toFixed(4)),
          domBidPct,
          domAskPct,
          impulseScore,
          detectedAt,
          activeUntil,
          lastUpdateTs:        nowMs,
          updatedAt:           nowMs,
          // backward-compat fields used by existing consumers
          baselineReady:           hasFullBaseline(sym, nowMs, 60),
          volumeUsdt15s:           vol15,
          volumeUsdt60s:           vol60,
          openInterestChangePct:   parseFloat(oiChangePct.toFixed(4)),
        };

        writePipeline.set(`impulse:signal:${sym}`, JSON.stringify(signalPayload), 'EX', IMPULSE_SIGNAL_TTL);

        // ── Tick history (only for active / just-fired symbols) ───
        if (activeUntil > nowMs || impulseFired) {
          const tickMember = JSON.stringify({
            ts:                  nowMs,
            price:               currentPrice,
            impulseMovePct:      signalPayload.impulseMovePct,
            impulseWindow,
            impulseDirection,
            impulseScore,
            move1sPct:           signalPayload.move1sPct,
            move5sPct:           signalPayload.move5sPct,
            move15sPct:          signalPayload.move15sPct,
            move60sPct:          signalPayload.move60sPct,
            volumeSpikeRatio15s: vsr15,
            tradeAcceleration:   ta,
            deltaUsdt60s:        signalPayload.deltaUsdt60s,
            oiChangePct:         signalPayload.oiChangePct,
          });
          writePipeline.zadd(`ticks:impulse:${sym}`, nowMs, tickMember);
          writePipeline.zremrangebyrank(`ticks:impulse:${sym}`, 0, -(TICKS_MAX_COUNT + 1));
        }

        impulseWriteCount++;
      }

      if (impulseWriteCount > 0) {
        await writePipeline.exec();
      }

      // Prune maps for delisted symbols
      const activeSet = new Set(symbols);
      for (const sym of priceHistories.keys()) { if (!activeSet.has(sym)) priceHistories.delete(sym); }
      for (const sym of oiState.keys())        { if (!activeSet.has(sym)) oiState.delete(sym); }
      for (const sym of activeUntilMap.keys()) { if (!activeSet.has(sym)) activeUntilMap.delete(sym); }
      for (const sym of detectedAtMap.keys())  { if (!activeSet.has(sym)) detectedAtMap.delete(sym); }

      if (logSummary) {
        const activeCount = [...activeUntilMap.values()].filter(t => t > Date.now()).length;
        console.log(
          `[impulse] tick=${tickCount} active=${activeCount}/${symbols.length}` +
          ` detected=${detectedCount} total=${totalAlerts}`
        );
      }
    } catch (err) {
      console.error('[impulse] tick error:', err.message);
    }
  }

  function start() {
    console.log('[impulse] Market impulse service started — multi-window 1s/5s/15s/60s detection');
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
