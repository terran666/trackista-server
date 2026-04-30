'use strict';
/**
 * heatmapRoute.js — REST API and dedicated WS for the /impulse (heatmap) page.
 *
 * Endpoints:
 *   GET  /api/heatmap/symbols
 *   GET  /api/heatmap/history?symbol=&minutes=&range=
 *   GET  /api/heatmap/live?symbol=
 *   GET  /api/heatmap/orderbook?symbol=&levels=
 *   POST /api/heatmap/activate  { symbol }
 *   WS   /ws/heatmap?symbol=BTCUSDT
 */

const express               = require('express');
const { WebSocketServer,
        WebSocket }         = require('ws');
const { createRateLimiter } = require('../middleware/rateLimiters');

// ─── Wire-format helpers (ТЗ format) ─────────────────────────────

/**
 * Convert internal snapshot to ТЗ wire format:
 * { time, midPrice, prices: { priceKey: { bid, ask } } }
 */
function toWireSnapshot(snap) {
  const prices = {};
  for (const [key, val] of Object.entries(snap.buckets ?? {})) {
    prices[key] = {
      bid: Math.round(val.bidNotional ?? 0),
      ask: Math.round(val.askNotional ?? 0),
    };
  }
  return { time: snap.ts, midPrice: snap.midPrice, prices };
}

function getSnapMeta(snap, rangeOverride) {
  const bucketSize     = snap.bucketSize ?? null;
  const pricePrecision = bucketSize
    ? (bucketSize.toString().split('.')[1] ?? '').length
    : 1;
  return {
    bucketSize,
    pricePrecision,
    rangePercent: rangeOverride ?? parseFloat(process.env.HEATMAP_RANGE_PERCENT || '3'),
  };
}

// /api/heatmap/history — max 30 req/min per client (prevents REST polling abuse)
const historyLimiter = createRateLimiter({
  max:       30,
  windowSec: 60,
  keyPrefix: 'heatmap-history',
});

function createHeatmapRouter(redis, heatmapService) {
  const router = express.Router();

  // ─── GET /api/heatmap/symbols ─────────────────────────────────
  // Returns list of currently active heatmap symbols with live metadata.
  router.get('/symbols', async (_req, res) => {
    try {
      let allTickers = null;
      try {
        const raw = await redis.get('futures:tickers:all');
        if (raw) allTickers = JSON.parse(raw);
      } catch (_) { /* non-critical */ }

      const symbols = heatmapService.getActiveSymbols(allTickers);
      return res.json({ success: true, symbols });
    } catch (err) {
      console.error('[heatmapRoute] GET /symbols error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/heatmap/history ─────────────────────────────────
  // Returns the last `minutes` of 1-second snapshots for a symbol.
  // Response format per ТЗ:
  //   { meta: { bucketSize, pricePrecision, rangePercent },
  //     snapshots: [{ time, midPrice, prices: { key: { bid, ask } } }] }
  router.get('/history', historyLimiter(redis), async (req, res) => {
    const symbol     = (req.query.symbol || '').toUpperCase();
    const minutes    = Math.min(parseInt(req.query.minutes || '30', 10), 60);
    const rangeParam = req.query.range ? parseFloat(req.query.range) : null;

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }
    if (!heatmapService.isSymbolActive(symbol)) {
      return res.status(404).json({
        success: false,
        error:   `Heatmap not enabled for ${symbol}`,
        symbol,
      });
    }

    try {
      const count     = minutes * 60; // 1 snapshot/sec
      const raws      = await redis.lrange(`heatmap:history:${symbol}`, 0, count - 1);
      const snapshots = [];
      let firstSnap   = null;

      for (const raw of raws) {
        try {
          const snap = JSON.parse(raw);
          if (firstSnap === null) firstSnap = snap;
          snapshots.push(toWireSnapshot(snap));
        } catch (_) { /* skip corrupt entry */ }
      }

      // LPUSH ⇒ index 0 = newest; reverse so response is oldest → newest
      snapshots.reverse();

      const meta = firstSnap
        ? getSnapMeta(firstSnap, rangeParam)
        : { bucketSize: null, pricePrecision: 1,
            rangePercent: rangeParam ?? parseFloat(process.env.HEATMAP_RANGE_PERCENT || '3') };

      return res.json({ meta, snapshots });
    } catch (err) {
      console.error(`[heatmapRoute] GET /history error (${symbol}):`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/heatmap/live ────────────────────────────────────
  // Returns the single latest snapshot. Prefer WS scope=heatmap over polling this.
  router.get('/live', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }
    if (!heatmapService.isSymbolActive(symbol)) {
      return res.status(404).json({ success: false, error: 'heatmap_not_enabled_for_symbol', symbol });
    }

    try {
      const raw = await redis.get(`heatmap:latest:${symbol}`);
      if (!raw) {
        return res.status(202).json({ success: false, error: 'snapshot_not_ready', symbol });
      }
      return res.json({ success: true, symbol, snapshot: JSON.parse(raw) });
    } catch (err) {
      console.error(`[heatmapRoute] GET /live error (${symbol}):`, err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── GET /api/heatmap/orderbook ───────────────────────────────
  // Returns current orderbook for the side-panel ladder.
  router.get('/orderbook', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const levels = Math.min(parseInt(req.query.levels || '50', 10), 200);

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }
    if (!heatmapService.isSymbolActive(symbol)) {
      return res.status(404).json({ success: false, error: 'heatmap_not_enabled_for_symbol', symbol });
    }

    const ob = heatmapService.getOrderbookSnapshot(symbol, levels);
    if (!ob) {
      return res.status(202).json({ success: false, error: 'orderbook_not_ready', symbol });
    }
    return res.json({ success: true, ...ob });
  });

  // ─── POST /api/heatmap/activate ───────────────────────────────
  // Activates heatmap collection for a symbol on demand.
  // Symbol stays active until server restart (or deactivate is called).
  router.post('/activate', (req, res) => {
    const symbol = ((req.body?.symbol || req.query.symbol || '') + '').toUpperCase().trim();
    if (!symbol) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }
    // Basic symbol validation — alphanumeric only
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }

    const result = heatmapService.activateSymbol(symbol);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error, message: result.message });
    }
    return res.json({ success: true, symbol, alreadyActive: result.alreadyActive ?? false });
  });

  return router;
}

// ─── Dedicated WebSocket /ws/heatmap?symbol= ─────────────────────
/**
 * Attaches a dedicated WS endpoint at /ws/heatmap.
 * Must be called BEFORE attachBinanceWsProxy.
 *
 * Client connects: ws://host/ws/heatmap?symbol=BTCUSDT
 * Server → client on connect:  { type: 'heatmap:snapshot', meta, data }
 * Server → client on update:   { type: 'heatmap:update', data }
 * data = { time, midPrice, prices: { priceKey: { bid, ask } } }
 */
function attachHeatmapWs(httpServer, redis, eventBus) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return; }
    if (url.pathname !== '/ws/heatmap') return;

    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, symbol);
    });
  });

  wss.on('connection', async (ws, symbol) => {
    // Auto-activate if not yet collecting
    eventBus.emit('heatmap:activate', symbol);

    // Send initial full snapshot so client can render immediately
    try {
      const raw = await redis.get(`heatmap:latest:${symbol}`);
      if (raw && ws.readyState === WebSocket.OPEN) {
        const snap = JSON.parse(raw);
        ws.send(JSON.stringify({
          type : 'heatmap:snapshot',
          meta : getSnapMeta(snap),
          data : toWireSnapshot(snap),
        }));
      }
    } catch (_) { /* non-critical — client will wait for first update */ }

    // Subscribe to live snapshot events from heatmapService
    const onUpdate = ({ symbol: sym, snapshot }) => {
      if (sym !== symbol) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({
          type : 'heatmap:update',
          data : toWireSnapshot(snapshot),
        }));
      } catch (_) {}
    };

    eventBus.on('heatmap:update', onUpdate);
    ws.on('close', () => eventBus.off('heatmap:update', onUpdate));
    ws.on('error', () => eventBus.off('heatmap:update', onUpdate));
  });

  console.log('[heatmap] dedicated WS registered at ws://{host}/ws/heatmap?symbol=SYMBOL');
}

module.exports = { createHeatmapRouter, attachHeatmapWs };
