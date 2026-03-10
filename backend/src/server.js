'use strict';

const express = require('express');
const Redis   = require('ioredis');
const mysql   = require('mysql2/promise');

const { createLevelsService }         = require('./levelsService');
const { levelsHandler }               = require('./routes/levelsEngineRoute');
const { autoLevelsHandler }           = require('./routes/autoLevelsRoute');
const { createLevelMonitorService }  = require('./services/levelMonitorService');
const { createAlertEngineService }   = require('./services/alertEngineService');
const { createMarketImpulseService } = require('./services/marketImpulseService');
const { createTelegramService }      = require('./services/telegramService');
const { createAlertDeliveryService } = require('./services/alertDeliveryService');

// ─── Configuration ───────────────────────────────────────────────
const PORT       = parseInt(process.env.API_PORT  || '3000', 10);
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const MYSQL_HOST = process.env.DB_HOST     || process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = parseInt(process.env.DB_PORT     || process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.DB_USER     || process.env.MYSQL_USER || 'trackista';
const MYSQL_PASS = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '';
const MYSQL_DB   = process.env.DB_NAME     || process.env.MYSQL_DATABASE || 'trackista';

console.log('[backend] Starting backend API...');
console.log(`[backend] Redis: ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`[backend] MySQL: ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => console.log('[backend] Connected to Redis'));
redis.on('error',   (err) => console.error('[backend] Redis error:', err.message));

// ─── MySQL pool ───────────────────────────────────────────────────
const db = mysql.createPool({
  host:            MYSQL_HOST,
  port:            MYSQL_PORT,
  user:            MYSQL_USER,
  password:        MYSQL_PASS,
  database:        MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10,
  timezone:        'Z',
});

db.getConnection()
  .then(conn => { console.log('[backend] Connected to MySQL'); conn.release(); })
  .catch(err => console.error('[backend] MySQL connection error:', err.message));

// ─── Levels service ───────────────────────────────────────────────
const levels  = createLevelsService(db, redis);

// ─── Level monitor ────────────────────────────────────────────────
const monitor = createLevelMonitorService(redis);
monitor.start();

const telegram      = createTelegramService();
const alertDelivery = createAlertDeliveryService(redis, telegram);

const alertEngine   = createAlertEngineService(redis, alertDelivery);
alertEngine.start();

const impulse       = createMarketImpulseService(redis, alertDelivery);
impulse.start();

// ─── Express app ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/price/:symbol
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  console.log(`[backend] GET /api/price/${symbol}`);

  try {
    const price = await redis.get(`price:${symbol}`);

    if (price === null) {
      return res.status(404).json({
        success: false,
        error:   'Price not found',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      price,
    });
  } catch (err) {
    console.error(`[backend] Error reading price:${symbol}:`, err.message);
    return res.status(500).json({
      success: false,
      error:   'Internal server error',
      symbol,
    });
  }
});

// GET /api/symbols
app.get('/api/symbols', async (_req, res) => {
  try {
    const raw = await redis.get('symbols:active:usdt');

    if (raw === null) {
      return res.status(503).json({
        success: false,
        error:   'Symbol list not available yet — collector may still be starting up',
      });
    }

    const symbols = JSON.parse(raw);
    return res.json({
      success: true,
      count:   symbols.length,
      symbols,
    });
  } catch (err) {
    console.error('[backend] Error reading symbols:active:usdt:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/trade/:symbol/last
app.get('/api/trade/:symbol/last', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  console.log(`[backend] GET /api/trade/${symbol}/last`);

  try {
    const raw = await redis.get(`trade:${symbol}:last`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Trade data not found',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      trade:   JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading trade:${symbol}:last:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/metrics/:symbol
app.get('/api/metrics/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    const raw = await redis.get(`metrics:${symbol}`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Metrics not found — symbol may be inactive or collector still warming up',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      metrics: JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading metrics:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/signals/:symbol
app.get('/api/signals/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    const raw = await redis.get(`signal:${symbol}`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Signal not found — symbol may be inactive or collector still warming up',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      signal: JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading signal:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Helper: fetch all signal snapshots by active symbol list via pipeline
async function fetchAllSignals() {
  const rawSymbols = await redis.get('symbols:active:usdt');
  if (!rawSymbols) return null;
  const symbols = JSON.parse(rawSymbols);
  const pipeline = redis.pipeline();
  for (const sym of symbols) pipeline.get(`signal:${sym}`);
  const results = await pipeline.exec();
  const signals = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try { signals.push(JSON.parse(raw)); } catch (_) {}
  }
  return signals;
}

// GET /api/market/in-play?limit=20
app.get('/api/market/in-play', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 500);

  try {
    const signals = await fetchAllSignals();
    if (signals === null) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }

    signals.sort((a, b) => b.inPlayScore - a.inPlayScore);
    const items = signals.slice(0, limit).map(s => ({
      symbol:               s.symbol,
      inPlayScore:          s.inPlayScore,
      volumeSpikeRatio60s:  s.volumeSpikeRatio60s,
      volumeSpikeRatio15s:  s.volumeSpikeRatio15s,
      tradeAcceleration:    s.tradeAcceleration,
      deltaImbalancePct60s: s.deltaImbalancePct60s,
      impulseDirection:     s.impulseDirection,
      signalConfidence:     s.signalConfidence,
      baselineReady:        s.baselineReady,
    }));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] Error in /api/market/in-play:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/market/impulse?limit=20&direction=up|down|mixed|all
app.get('/api/market/impulse', async (req, res) => {
  const limit     = Math.min(parseInt(req.query.limit || '20', 10), 500);
  const direction = (req.query.direction || 'all').toLowerCase();

  try {
    const signals = await fetchAllSignals();
    if (signals === null) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }

    const filtered = direction === 'all'
      ? signals
      : signals.filter(s => s.impulseDirection === direction);

    filtered.sort((a, b) => b.impulseScore - a.impulseScore);
    const items = filtered.slice(0, limit).map(s => ({
      symbol:               s.symbol,
      impulseScore:         s.impulseScore,
      impulseDirection:     s.impulseDirection,
      volumeSpikeRatio15s:  s.volumeSpikeRatio15s,
      tradeAcceleration:    s.tradeAcceleration,
      deltaImbalancePct60s: s.deltaImbalancePct60s,
      priceVelocity60s:     s.priceVelocity60s,
      signalConfidence:     s.signalConfidence,
      baselineReady:        s.baselineReady,
    }));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] Error in /api/market/impulse:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/market/top-active?limit=20
app.get('/api/market/top-active', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 500);

  try {
    const rawSymbols = await redis.get('symbols:active:usdt');
    if (rawSymbols === null) {
      return res.status(503).json({
        success: false,
        error:   'Symbol list not available yet — collector may still be starting up',
      });
    }

    const symbols = JSON.parse(rawSymbols);

    // Fetch all metrics in one pipeline
    const pipeline = redis.pipeline();
    for (const sym of symbols) pipeline.get(`metrics:${sym}`);
    const results = await pipeline.exec();

    const items = [];
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      try {
        const m = JSON.parse(raw);
        items.push({
          symbol:            m.symbol,
          activityScore:     m.activityScore,
          volumeUsdt60s:     m.volumeUsdt60s,
          tradeCount60s:     m.tradeCount60s,
          priceChangePct60s: m.priceChangePct60s,
          lastPrice:         m.lastPrice,
        });
      } catch (_) { /* skip malformed */ }
    }

    items.sort((a, b) => b.activityScore - a.activityScore);

    return res.json({
      success: true,
      count:   Math.min(items.length, limit),
      items:   items.slice(0, limit),
    });
  } catch (err) {
    console.error('[backend] Error in /api/market/top-active:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Level endpoints ─────────────────────────────────────────────

// GET /api/levels — DEPRECATED, use /api/autolevels
console.log('[backend] registering /api/levels route (deprecated 410)');
app.get('/api/levels', (_req, res) => {
  res.status(410).json({ success: false, error: 'Deprecated. Use /api/autolevels' });
});

// GET /api/autolevels — AutoLevels engine (pivot grid clustering)
console.log('[backend] registering /api/autolevels route');
app.get('/api/autolevels', autoLevelsHandler);

// GET /api/levels/state/:symbol
app.get('/api/levels/state/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const raw = await redis.get(`levelstate:${symbol}`);
    if (!raw) {
      return res.status(404).json({
        success: false,
        symbol,
        error: 'No level state found — symbol may have no active levels or monitor is warming up',
      });
    }
    return res.json({ success: true, symbol, state: JSON.parse(raw) });
  } catch (err) {
    console.error(`[backend] Error reading levelstate:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/levels/watchlist — symbols with approaching/touched/breakout/bounce
app.get('/api/levels/watchlist', async (req, res) => {
  try {
    const rawSymbols = await redis.get('symbols:active:usdt');
    if (!rawSymbols) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }
    const symbols = JSON.parse(rawSymbols);

    const pipeline = redis.pipeline();
    for (const sym of symbols) pipeline.get(`levelstate:${sym}`);
    const results = await pipeline.exec();

    const watchlist = [];
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      let state;
      try { state = JSON.parse(raw); } catch (_) { continue; }
      const { levels: lvls = [] } = state;
      const approaching       = lvls.some(l => l.approaching);
      const touched           = lvls.some(l => l.touched);
      const breakoutCandidate = lvls.some(l => l.breakoutCandidate);
      const bounceCandidate   = lvls.some(l => l.bounceCandidate);
      if (!approaching && !touched && !breakoutCandidate && !bounceCandidate) continue;
      watchlist.push({
        symbol:             state.symbol,
        updatedAt:          state.updatedAt,
        levelCount:         lvls.length,
        approaching,
        touched,
        breakoutCandidate,
        bounceCandidate,
      });
    }

    return res.json({ success: true, count: watchlist.length, watchlist });
  } catch (err) {
    console.error('[backend] Error in /api/levels/watchlist:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/levels/:symbol
app.get('/api/levels/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const result = await levels.getActiveLevelsBySymbol(symbol);
    return res.json({ success: true, symbol, count: result.length, levels: result });
  } catch (err) {
    console.error(`[backend] Error reading levels:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/levels/manual
app.post('/api/levels/manual', async (req, res) => {
  const payload = req.body || {};
  const errors  = levels.validateLevelPayload(payload, true);
  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }
  if (!levels.ALLOWED_TYPES.has(payload.type)) {
    return res.status(400).json({ success: false, errors: [`type must be one of: ${[...levels.ALLOWED_TYPES].join(', ')}`] });
  }

  try {
    const level = await levels.createManualLevel(payload);
    return res.status(201).json({ success: true, level });
  } catch (err) {
    console.error('[backend] Error creating manual level:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/levels/:id
app.patch('/api/levels/:id', async (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const payload = req.body || {};

  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const errors = levels.validateLevelPayload(payload, false);
  if (errors.length) return res.status(400).json({ success: false, errors });

  try {
    const level = await levels.updateLevel(id, payload);
    if (!level) return res.status(404).json({ success: false, error: 'Level not found' });
    return res.json({ success: true, level });
  } catch (err) {
    console.error(`[backend] Error updating level ${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/levels/:id  (soft delete)
app.delete('/api/levels/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  try {
    const result = await levels.deactivateLevel(id);
    if (!result) return res.status(404).json({ success: false, error: 'Level not found' });
    return res.json({ success: true, id: result.id, message: 'Level deactivated' });
  } catch (err) {
    console.error(`[backend] Error deactivating level ${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Delivery endpoints ───────────────────────────────────────────

// GET /api/delivery/status
app.get('/api/delivery/status', async (_req, res) => {
  try {
    const recentCount = await redis.llen('alerts:recent');
    return res.json({
      success: true,
      telegram: {
        enabled:       telegram.enabled,
        chatConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      },
      recentAlerts: recentCount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/delivery/test  (dev/internal only)
app.post('/api/delivery/test', async (req, res) => {
  const body = req.body || {};
  const symbol       = body.symbol       || 'BTCUSDT';
  const direction    = body.direction    || 'UP';
  const priceMovePct = body.priceMovePct || 10.0;
  const volSpike     = body.volSpike     || 3.2;
  const price        = body.price        || 82450.50;

  const impulseScore      = parseFloat(((Math.abs(priceMovePct) * 40) + (volSpike * 50)).toFixed(1));
  const priceFactor       = Math.abs(priceMovePct) / 2.5;
  const volumeFactor      = volSpike / 2.0;
  const signalConfidence  = Math.min(((priceFactor + volumeFactor) / 2) * 100, 100);
  const severity          = (Math.abs(priceMovePct) >= 5.0 && volSpike >= 3.0) ? 'critical' : 'high';

  const testAlert = {
    type:         'market_impulse',
    symbol,
    severity,
    createdAt:    Date.now(),
    currentPrice: price,
    signalContext: {
      impulseDirection:  direction,
      impulseScore,
      signalConfidence:  parseFloat(signalConfidence.toFixed(1)),
      priceMovePct5s:    priceMovePct,
      volume5s:          125000,
      baselineVolume5s:  39062,
      volumeSpikeRatio:  volSpike,
      impulseWindowSec:  5,
    },
  };
  try {
    const result = await alertDelivery.handleAlert(testAlert);
    return res.json({ success: true, alert: testAlert, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Alert endpoints ───────────────────────────────────────────────

// GET /api/alerts/recent?limit=50
app.get('/api/alerts/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  try {
    const raws = await redis.lrange('alerts:recent', 0, limit - 1);
    const alerts = raws.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
    return res.json({ success: true, count: alerts.length, alerts });
  } catch (err) {
    console.error('[backend] Error reading alerts:recent:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/alerts/watchlist
app.get('/api/alerts/watchlist', async (req, res) => {
  try {
    const raws = await redis.lrange('alerts:recent', 0, 499);
    const seen = new Set();
    for (const r of raws) {
      try { const a = JSON.parse(r); if (a && a.symbol) seen.add(a.symbol); } catch (_) {}
    }
    const symbols = [...seen];
    return res.json({ success: true, count: symbols.length, symbols });
  } catch (err) {
    console.error('[backend] Error reading alerts watchlist:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/alerts/:symbol?limit=20
app.get('/api/alerts/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const limit  = Math.min(parseInt(req.query.limit || '20', 10), 500);
  try {
    const raws = await redis.lrange('alerts:recent', 0, 499);
    const alerts = [];
    for (const r of raws) {
      if (alerts.length >= limit) break;
      try {
        const a = JSON.parse(r);
        if (a && a.symbol === symbol) alerts.push(a);
      } catch (_) {}
    }
    return res.json({ success: true, symbol, count: alerts.length, alerts });
  } catch (err) {
    console.error(`[backend] Error reading alerts for ${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[backend] API listening on port ${PORT}`);
});
