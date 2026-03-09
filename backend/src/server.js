'use strict';

const express = require('express');
const Redis   = require('ioredis');

// ─── Configuration ───────────────────────────────────────────────
const PORT       = parseInt(process.env.API_PORT  || '3000', 10);
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

console.log('[backend] Starting backend API...');
console.log(`[backend] Redis: ${REDIS_HOST}:${REDIS_PORT}`);

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => console.log('[backend] Connected to Redis'));
redis.on('error',   (err) => console.error('[backend] Redis error:', err.message));

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

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[backend] API listening on port ${PORT}`);
});
