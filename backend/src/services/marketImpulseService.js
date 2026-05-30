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

// ─── Factory ─────────────────────────────────────────────────────
function createMarketImpulseService(redis, deliveryService = null) {
  // per-symbol rolling price history: [{ ts: number(ms), price: number }] sorted asc
  const priceHistories = new Map();

  // OI state per symbol for change-% computation
  // { oi: number, ts: number }
  const oiState = new Map();

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

    const sc = event.signalContext;
    console.log(
      `[alert.published] id=${event.id} type=${event.type} symbol=${event.symbol} priority=${event.priority}` +
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

  // ── Surge computation (5%+ in 60s, no volume spike required) ─
  function computeSurgeMetrics(symbol, currentPrice, nowMs, c) {
    if (c.requireFullBaseline && !hasFullBaseline(symbol, nowMs, c.baselineSec)) {
      return null;
    }
    const priceNAgo = getPriceNSecondsAgo(symbol, c.surgeWindowSec, nowMs);
    if (priceNAgo === null || priceNAgo === 0) return null;

    const priceMovePct = ((currentPrice - priceNAgo) / priceNAgo) * 100;
    if (Math.abs(priceMovePct) < c.surgeMovePct) return null;

    return {
      direction:   priceMovePct > 0 ? 'UP' : 'DOWN',
      priceMovePct,
      windowSec:   c.surgeWindowSec,
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

      // Batch read price + metrics + signal + oi + orderbook for all symbols
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

      let warmupCount   = 0;
      let detectedCount = 0;

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawPrice]   = results[i * 5]     || [null, null];
        const [, rawMetrics] = results[i * 5 + 1] || [null, null];

        if (!rawPrice || !rawMetrics) continue;

        const currentPrice = parseFloat(rawPrice);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        let metrics;
        try { metrics = JSON.parse(rawMetrics); } catch (_) { continue; }

        // Record price point BEFORE computing (so history includes current price)
        addPricePoint(sym, currentPrice, nowMs);

        // ── Classic impulse: 2.5% in 5s + 2× volume spike ────────
        const m = computeImpulseMetrics(sym, currentPrice, metrics, nowMs, c);

        if (!m) {
          if (c.requireFullBaseline && !hasFullBaseline(sym, nowMs, c.baselineSec)) {
            warmupCount++;
            continue; // still warming up — skip surge check too
          }
        } else {
          // Per-symbol alert engine cooldown
          const onCooldown = await isCooldownActive(sym);
          if (!onCooldown) {
            const id    = `${sym}-market_impulse-${nowMs}-generic`;
            const priority = m.severity === 'critical' ? 'critical' : 'high';
            const event = {
              id,
              type:         'market_impulse',
              symbol:       sym,
              severity:     m.severity,
              priority,
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
        }

        // ── Surge check: 5%+ in 60s, no volume spike required ────
        if (c.surgeEnabled) {
          const surge = computeSurgeMetrics(sym, currentPrice, nowMs, c);
          if (surge) {
            const surgeOnCooldown = await isSurgeCooldownActive(sym);
            if (!surgeOnCooldown) {
              const surgeId  = `${sym}-price_surge-${nowMs}-generic`;
              const surgeEvent = {
                id:           surgeId,
                type:         'price_surge',
                symbol:       sym,
                severity:     Math.abs(surge.priceMovePct) >= 10 ? 'critical' : 'high',
                priority:     Math.abs(surge.priceMovePct) >= 10 ? 'critical' : 'high',
                title:        `${sym} surge ${surge.direction} ${surge.priceMovePct.toFixed(1)}%`,
                message:      `${sym} moved ${surge.priceMovePct.toFixed(2)}% in ${surge.windowSec}s`,
                createdAt:    nowMs,
                currentPrice,
                signalContext: {
                  impulseDirection:  surge.direction,
                  impulseScore:      clamp(Math.abs(surge.priceMovePct) * 15, 0, 100),
                  signalConfidence:  clamp((Math.abs(surge.priceMovePct) / c.surgeMovePct) * 100, 0, 100),
                  priceMovePct5s:    parseFloat(surge.priceMovePct.toFixed(4)),
                  volume5s:          0,
                  baselineVolume5s:  0,
                  volumeSpikeRatio:  0,
                  impulseWindowSec:  surge.windowSec,
                },
              };
              await pushAlert(surgeEvent);
              await setSurgeCooldown(sym, c.surgeCooldownSec);
              detectedCount++;
            }
          }
        }
      } // end per-symbol loop

      // ── Phase 2: Composite impulse score (0-100) + DOM + OI ──────
      const writePipeline = redis.pipeline();
      let impulseWriteCount = 0;

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const [, rawMetrics]   = results[i * 5 + 1] || [null, null];
        const [, rawSignal]    = results[i * 5 + 2] || [null, null];
        const [, rawOI]        = results[i * 5 + 3] || [null, null];
        const [, rawOrderbook] = results[i * 5 + 4] || [null, null];

        if (!rawSignal || !rawMetrics) continue;

        let signal, metrics2;
        try { signal   = JSON.parse(rawSignal);  } catch (_) { continue; }
        try { metrics2 = JSON.parse(rawMetrics); } catch (_) { continue; }

        // OI change
        let openInterestChangePct = 0;
        if (rawOI) {
          try {
            const oiData = JSON.parse(rawOI);
            if (oiData && oiData.oiValue > 0) {
              const prev = oiState.get(sym);
              if (prev && prev.oi > 0) {
                openInterestChangePct = ((oiData.oiValue - prev.oi) / prev.oi) * 100;
              }
              oiState.set(sym, { oi: oiData.oiValue, ts: oiData.ts });
            }
          } catch (_) {}
        }

        // DOM split: bidNotional / askNotional from top DOM_TOP_N levels
        let domBidPct = 0;
        let domAskPct = 0;
        if (rawOrderbook) {
          try {
            const ob = JSON.parse(rawOrderbook);
            const bids = ob.bids || [];
            const asks = ob.asks || [];
            let bidNotional = 0;
            let askNotional = 0;
            for (let j = 0; j < Math.min(bids.length, DOM_TOP_N); j++) {
              const b = bids[j];
              if (Array.isArray(b))        bidNotional += b[0] * b[1];
              else if (b && b.usdValue)    bidNotional += b.usdValue;
              else if (b && b.price)       bidNotional += b.price * b.size;
            }
            for (let j = 0; j < Math.min(asks.length, DOM_TOP_N); j++) {
              const a = asks[j];
              if (Array.isArray(a))        askNotional += a[0] * a[1];
              else if (a && a.usdValue)    askNotional += a.usdValue;
              else if (a && a.price)       askNotional += a.price * a.size;
            }
            const total = bidNotional + askNotional;
            if (total > 0) {
              domBidPct = parseFloat(((bidNotional / total) * 100).toFixed(2));
              domAskPct = parseFloat(((askNotional / total) * 100).toFixed(2));
            }
          } catch (_) {}
        }

        // Raw delta (USDT) for the 60s window
        const deltaUsdt60s = metrics2.deltaUsdt60s ?? 0;

        // deltaImbalancePct60s: buy share of total volume 0-100 (50 = neutral)
        // e.g. 55.2 = 55% was buy volume; 44.8 = 55% was sell volume
        const buyVol60  = metrics2.buyVolumeUsdt60s  ?? 0;
        const sellVol60 = metrics2.sellVolumeUsdt60s ?? 0;
        const totalVol60 = buyVol60 + sellVol60;
        const deltaImbalancePct60s = totalVol60 > 0
          ? parseFloat(((buyVol60 / totalVol60) * 100).toFixed(2))
          : 50;

        // Trades per second metrics
        const tradesPerSec      = metrics2.tradeCount1s  ?? 0;
        const avgTradesPerSec60s = parseFloat(((metrics2.tradeCount60s ?? 0) / 60).toFixed(3));

        // Composite score components (spec formula)
        // delta component: normalize raw USDT delta by 60s volume (clamped ratio)
        const vsr15    = signal.volumeSpikeRatio15s  || 1;
        const ta       = signal.tradeAcceleration    || 1;
        const vol60    = Math.max(metrics2.volumeUsdt60s || 0, 1);
        const deltaRat = clamp(Math.abs(deltaUsdt60s) / vol60, 0, 1); // 0..1
        const volC   = clamp((vsr15 / 3.0) * 35,                          0, 35);
        const spdC   = clamp(((ta - 1) / 3.0) * 25,                       0, 25);
        const dltC   = clamp((deltaRat / 0.6) * 20,                        0, 20);
        const oiC    = clamp((Math.abs(openInterestChangePct) / 2.0) * 10, 0, 10);
        const domBidPctMid = domBidPct || 50; // fallback to neutral when no data
        const domC   = clamp((Math.abs(domBidPctMid - 50) / 20) * 10,     0, 10);
        const compositeScore = Math.round((volC + spdC + dltC + oiC + domC) * 10) / 10;

        // domImbalancePct: positive = more bids, negative = more asks
        const domImbalancePct = parseFloat((domBidPct - domAskPct).toFixed(2));

        // Direction based on 60s price change
        const pcp = metrics2.priceChangePct60s || 0;
        const direction = pcp > 0.1 ? 'UP' : pcp < -0.1 ? 'DOWN' : 'NEUTRAL';

        // Current price (for tick record)
        const [, rawPriceCur] = results[i * 5] || [null, null];
        const currentPriceCur = rawPriceCur ? parseFloat(rawPriceCur) : 0;

        const impulseData = {
          symbol:                 sym,
          impulseScore:           compositeScore,
          impulseDirection:       direction,
          volumeSpikeRatio15s:    signal.volumeSpikeRatio15s ?? 0,
          tradeAcceleration:      signal.tradeAcceleration   ?? 0,
          tradesPerSec,
          avgTradesPerSec60s,
          // Volume fields for Volume panel
          volumeUsdt1s:           metrics2.volumeUsdt1s  ?? 0,
          volumeUsdt5s:           metrics2.volumeUsdt5s  ?? 0,
          volumeUsdt15s:          metrics2.volumeUsdt15s ?? 0,
          volumeUsdt60s:          metrics2.volumeUsdt60s ?? 0,
          // Delta fields for Delta panel
          deltaUsdt60s:           deltaUsdt60s,
          deltaImbalancePct60s,
          openInterestChangePct:  parseFloat(openInterestChangePct.toFixed(4)),
          domBidPct,
          domAskPct,
          domImbalancePct,
          priceVelocity60s:       pcp,
          signalConfidence:       signal.signalConfidence ?? 0,
          baselineReady:          signal.baselineReady    ?? false,
          updatedAt:              nowMs,
        };

        writePipeline.set(`impulse:signal:${sym}`, JSON.stringify(impulseData), 'EX', IMPULSE_SIGNAL_TTL);

        // Rolling 1s tick for short-term chart (capped at TICKS_MAX_COUNT entries)
        if (currentPriceCur > 0) {
          const tickMember = JSON.stringify({
            ts:            nowMs,
            price:         currentPriceCur,
            volumeUsdt1s:  metrics2.volumeUsdt1s  ?? 0,
            volumeUsdt5s:  metrics2.volumeUsdt5s  ?? 0,
            volumeUsdt60s: metrics2.volumeUsdt60s ?? 0,
            deltaUsdt1s:   metrics2.deltaUsdt1s   ?? 0,
            deltaUsdt:     deltaUsdt60s,
            tradeCount1s:  tradesPerSec,
          });
          writePipeline.zadd(`ticks:impulse:${sym}`, nowMs, tickMember);
          writePipeline.zremrangebyrank(`ticks:impulse:${sym}`, 0, -(TICKS_MAX_COUNT + 1));
        }

        impulseWriteCount++;
      }

      if (impulseWriteCount > 0) {
        await writePipeline.exec();
      }

      // Prune priceHistories against active universe — otherwise delisted
      // symbols accumulate price points indefinitely.
      const activeSet = new Set(symbols);
      for (const sym of priceHistories.keys()) {
        if (!activeSet.has(sym)) priceHistories.delete(sym);
      }
      for (const sym of oiState.keys()) {
        if (!activeSet.has(sym)) oiState.delete(sym);
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
    console.log('[impulse] Market impulse service started — 5s/2.5%+2x-spike + surge 60s/5%+');
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
