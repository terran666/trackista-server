'use strict';

/**
 * Binance WebSocket proxy.
 *
 * Attaches to an existing http.Server and proxies WebSocket upgrade requests:
 *
 *   Client  → ws://backend/ws/stream/<streamName>
 *   Backend → wss://stream.binance.com:9443/ws/<streamName>   (spot)
 *
 *   Client  → ws://backend/ws/fstream/<streamName>
 *   Backend → wss://fstream.binance.com/ws/<streamName>        (futures)
 *
 * Relay behaviour:
 *   - Every message from Binance WS is forwarded verbatim to the client.
 *   - Client messages (subscribe/unsubscribe) are forwarded to Binance.
 *   - If the Binance upstream closes, the proxy reconnects automatically
 *     (up to MAX_UPSTREAM_RECONNECTS times, with exponential backoff) while
 *     keeping the client connection alive.  Only when reconnects are exhausted
 *     is the client connection closed.
 *   - REST anti-ban guard has NO effect on WS connections — they are
 *     independent paths and must not be conflated.
 *
 * Usage:
 *   const { attachBinanceWsProxy, getWsProxyStats } = require('./routes/binanceWsProxy');
 *   attachBinanceWsProxy(httpServer);
 */

const { WebSocketServer, WebSocket } = require('ws');
const Redis = require('ioredis');

// ── Redis pub/sub fan-out for kline streams ───────────────────────────────────
// When a client connects to /ws/fstream/{sym}@kline_{iv} or /ws/stream/{sym}@kline_{iv},
// we serve data from Redis pub/sub (populated by the collector) instead of opening
// a new Binance WS connection. This means zero new Binance connections per user.

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

// channel → Set<WebSocket> — in-process fan-out map
const klineListeners = new Map();

let _redisSub = null; // dedicated pub/sub client (cannot issue other commands)
let _redisGet = null; // used only for GET (last cached bar)

function getRedisKlineClients() {
  if (!_redisSub) {
    _redisSub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    _redisGet = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    _redisSub.on('error', err => console.error('[kline-ws-redis] sub error:', err.message));
    _redisGet.on('error', err => console.error('[kline-ws-redis] get error:', err.message));
    // Route pub/sub messages to subscribed WS clients AND reset stale watchdog
    _redisSub.on('message', (channel, message) => {
      _resetKlineWatchdog(channel);
      const clients = klineListeners.get(channel);
      if (!clients || clients.size === 0) return;
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      }
    });
  }
  return { sub: _redisSub, get: _redisGet };
}

// ── Per-channel stale watchdog + on-demand REST fallback ──────────────────────
// When a kline channel has active subscribers but no Redis pub/sub messages arrive
// for KLINE_STALE_TRIGGER_MS, the backend polls Binance REST directly and publishes
// to the pub/sub channel — keeping the chart alive even when the collector WS batch
// for this symbol is blocked or stale.

const KLINE_STALE_TRIGGER_MS  =  8_000; // silence → start REST polling
const KLINE_STALE_TRIGGER_FAST =     0; // immediate start when no cached :last exists
const KLINE_POLL_INTERVAL_MS  =  1_000; // poll Binance REST every 1 s while stale
const BINANCE_SPOT_KLINES    = 'https://api.binance.com/api/v3/klines';
const BINANCE_FAPI_KLINES    = 'https://fapi.binance.com/fapi/v1/klines';

// channel → { staleTimer, pollTimer }
const _klineWatchdogs = new Map();

function _startKlineWatchdog(channel, immediateMs = KLINE_STALE_TRIGGER_MS) {
  if (_klineWatchdogs.has(channel)) return; // already watching
  const entry = { staleTimer: null, pollTimer: null };
  _klineWatchdogs.set(channel, entry);
  _armStaleTimer(channel, entry, immediateMs);
}

function _stopKlineWatchdog(channel) {
  const entry = _klineWatchdogs.get(channel);
  if (!entry) return;
  clearTimeout(entry.staleTimer);
  clearInterval(entry.pollTimer);
  _klineWatchdogs.delete(channel);
}

function _resetKlineWatchdog(channel) {
  const entry = _klineWatchdogs.get(channel);
  if (!entry) return;
  // Data arrived — stop REST polling (if running) and re-arm stale timer
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
    // Parse channel to log correctly
    const parts = channel.split(':'); // kline:{market}:{symbol}:{interval}
    console.log(`[kline-watchdog] ${parts[1]}/${parts[2]}@${parts[3]} WS data resumed — REST fallback stopped`);
  }
  clearTimeout(entry.staleTimer);
  _armStaleTimer(channel, entry);
}

function _armStaleTimer(channel, entry, delayMs = KLINE_STALE_TRIGGER_MS) {
  entry.staleTimer = setTimeout(() => {
    entry.staleTimer = null;
    _activateRestFallback(channel, entry);
  }, delayMs);
}

async function _pollKlineOnce(market, symbol, interval) {
  const baseUrl = market === 'futures' ? BINANCE_FAPI_KLINES : BINANCE_SPOT_KLINES;
    const url     = `${baseUrl}?symbol=${symbol}&interval=${interval}&limit=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      console.warn(`[kline-watchdog] REST ${market}/${symbol}@${interval} HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return;
    const row      = data[data.length - 1]; // last (possibly open) candle
    const isClosed = Date.now() > Number(row[6]);
    const msg = {
      e: 'kline',
      E: Date.now(),
      s: symbol,
      k: {
        t: Number(row[0]), T: Number(row[6]),
        s: symbol, i: interval,
        f: 0, L: 0,
        o: row[1], c: row[4], h: row[2], l: row[3],
        v: row[5], n: Number(row[8]),
        x: isClosed,
        q: row[7], V: row[9], Q: row[10], B: '0',
      },
    };
    const payload  = JSON.stringify(msg);
    const channel  = `kline:${market}:${symbol}:${interval}`;
    const { get }  = getRedisKlineClients();

    // Send DIRECTLY to WebSocket clients — do NOT publish to Redis pub/sub.
    // Publishing to pub/sub would trigger _redisSub.on('message') → _resetKlineWatchdog
    // which would mistake our own message for "collector WS resumed" and stop the fallback.
    const clients = klineListeners.get(channel);
    if (clients) {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
    // Still update the :last key so new clients get fresh data on connect
    get.set(`${channel}:last`, payload, 'EX', 300).catch(() => {});
  } catch (err) {
    // Ignore individual poll errors — next tick will retry
  }
}

function _activateRestFallback(channel, entry) {
  const parts    = channel.split(':'); // kline:{market}:{symbol}:{interval}
  const market   = parts[1];
  const symbol   = parts[2];
  const interval = parts[3];
  if (!market || !symbol || !interval) return;

  // Only poll if there are still active subscribers
  if (!klineListeners.has(channel) || klineListeners.get(channel).size === 0) return;

  console.log(`[kline-watchdog] ${market}/${symbol}@${interval} stale — REST fallback activated`);

  // Poll immediately, then on interval
  _pollKlineOnce(market, symbol, interval);
  entry.pollTimer = setInterval(() => {
    if (!klineListeners.has(channel) || klineListeners.get(channel).size === 0) {
      _stopKlineWatchdog(channel);
      return;
    }
    _pollKlineOnce(market, symbol, interval);
  }, KLINE_POLL_INTERVAL_MS);
}

function subscribeKlineClient(market, symbol, interval, clientWs) {
  const channel = `kline:${market}:${symbol}:${interval}`;
  const label   = `[kline-ws] ${market}/${symbol}@kline_${interval}`;
  const { sub, get } = getRedisKlineClients();

  console.log(`${label} client connected (Redis pub/sub)`);

  // Register in fan-out; subscribe to Redis channel if this is the first client
  const isFirstClient = !klineListeners.has(channel);
  if (isFirstClient) {
    klineListeners.set(channel, new Set());
    sub.subscribe(channel).catch(err => console.error(`${label} Redis subscribe error:`, err.message));
  }
  klineListeners.get(channel).add(clientWs);

  // Send the last cached bar immediately so the chart updates right away.
  // Also check if the cached bar is stale to decide how quickly to start the watchdog.
  if (isFirstClient) {
    get.get(`${channel}:last`).then(cached => {
      let cacheAge = Infinity;
      if (cached) {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(cached);
        try { cacheAge = Date.now() - (JSON.parse(cached).E || 0); } catch (_) {}
      }
      // No :last or stale > 10 s → start REST immediately; otherwise wait 8 s
      const initialDelay = (cacheAge > 10_000) ? KLINE_STALE_TRIGGER_FAST : KLINE_STALE_TRIGGER_MS;
      _startKlineWatchdog(channel, initialDelay);
    }).catch(() => {
      _startKlineWatchdog(channel, KLINE_STALE_TRIGGER_FAST);
    });
  } else {
    // Not the first client — just send :last immediately
    get.get(`${channel}:last`).then(cached => {
      if (cached && clientWs.readyState === WebSocket.OPEN) clientWs.send(cached);
    }).catch(() => {});
  }

  const cleanup = () => {
    const clients = klineListeners.get(channel);
    if (!clients) return;
    clients.delete(clientWs);
    if (clients.size === 0) {
      klineListeners.delete(channel);
      sub.unsubscribe(channel).catch(() => {});
      // Stop watchdog when no more clients are watching
      _stopKlineWatchdog(channel);
    }
    console.log(`${label} client disconnected (${clients.size} remaining)`);
  };

  clientWs.on('close', cleanup);
  clientWs.on('error', cleanup);
}
const FUTURES_WS_BASE = 'wss://fstream.binance.com/ws';

// How many times to retry upstream before giving up and closing the client
const MAX_UPSTREAM_RECONNECTS      = 10;
// Base delay for first reconnect (doubles each attempt, caps at 30s)
const UPSTREAM_RECONNECT_BASE_MS   = 2_000;
const UPSTREAM_RECONNECT_MAX_MS    = 30_000;
// Log relay stats every N messages per connection (avoids log spam)
const RELAY_LOG_EVERY_N_MSGS       = 1_000;
// Log relay stats periodically regardless of message count
const RELAY_STATS_INTERVAL_MS      = 60_000;

// ── Connection registry ───────────────────────────────────────────────────────
// Tracks every active proxy session for diagnostics.
// Map<connId, ConnectionInfo>
const activeConnections = new Map();
let nextConnId = 1;

function getWsProxyStats() {
  const now  = Date.now();
  const list = [];
  for (const [id, info] of activeConnections.entries()) {
    list.push({
      id,
      market:             info.market,
      stream:             info.stream,
      connectedAt:        new Date(info.connectedAt).toISOString(),
      ageMs:              now - info.connectedAt,
      msgRelayed:         info.msgRelayed,
      upstreamReconnects: info.upstreamReconnects,
      upstreamState:      info.upstream ? stateLabel(info.upstream.readyState) : 'none',
      clientState:        info.clientWs ? stateLabel(info.clientWs.readyState) : 'unknown',
    });
  }
  return { total: list.length, connections: list };
}

function stateLabel(state) {
  return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state] ?? String(state);
}

// ── Upstream connection (with reconnect) ──────────────────────────────────────
function connectUpstream(upstreamUrl, market, stream, connId, clientWs, attempt) {
  const info = activeConnections.get(connId);
  if (!info) return; // client already gone

  const label = `[binance-ws-proxy] [${connId}] ${market}/${stream}`;

  const upstream = new WebSocket(upstreamUrl, {
    headers: { 'User-Agent': 'Trackista/2.0 ws-proxy' },
  });

  // Store ref so client message handler always has the latest upstream
  info.upstream = upstream;

  upstream.on('open', () => {
    console.log(`${label} upstream connected (attempt=${attempt})`);
    info.upstreamReconnects = attempt;

    // Start periodic stats ticker for this connection
    if (!info.statsInterval) {
      info.statsInterval = setInterval(() => {
        const upState = stateLabel(upstream.readyState);
        console.log(
          `${label} relay stats: msgRelayed=${info.msgRelayed}` +
          ` upstreamState=${upState}` +
          ` ageMs=${Date.now() - info.connectedAt}`,
        );
      }, RELAY_STATS_INTERVAL_MS);
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    clientWs.send(data, { binary: isBinary });
    info.msgRelayed++;
    if (info.msgRelayed % RELAY_LOG_EVERY_N_MSGS === 0) {
      console.log(`${label} relay checkpoint: ${info.msgRelayed} messages relayed`);
    }
  });

  upstream.on('error', (err) => {
    // 'error' is always followed by 'close' — just log it here
    console.error(`${label} upstream error: ${err.message}`);
  });

  upstream.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '';
    console.log(`${label} upstream closed code=${code}${reasonStr ? ` reason=${reasonStr}` : ''}`);

    // If client is gone, nothing to do
    if (clientWs.readyState !== WebSocket.OPEN) return;

    // Reconnect upstream while keeping the client connection alive
    if (attempt < MAX_UPSTREAM_RECONNECTS) {
      const delay = Math.min(
        UPSTREAM_RECONNECT_BASE_MS * Math.pow(2, attempt),
        UPSTREAM_RECONNECT_MAX_MS,
      );
      const nextAttempt = attempt + 1;
      console.log(`${label} scheduling upstream reconnect #${nextAttempt} in ${delay}ms`);
      setTimeout(() => {
        if (clientWs.readyState === WebSocket.OPEN && activeConnections.has(connId)) {
          connectUpstream(upstreamUrl, market, stream, connId, clientWs, nextAttempt);
        }
      }, delay);
    } else {
      console.warn(`${label} max upstream reconnects (${MAX_UPSTREAM_RECONNECTS}) exhausted — closing client`);
      clientWs.close(1011, 'upstream reconnect exhausted');
    }
  });
}

// ── Server attachment ─────────────────────────────────────────────────────────
function attachBinanceWsProxy(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url || '';

    // Match /ws/stream/<streamName>  (spot)
    // Match /ws/fstream/<streamName> (futures)
    const spotMatch    = url.match(/^\/ws\/stream\/(.+)$/);
    const futuresMatch = url.match(/^\/ws\/fstream\/(.+)$/);

    if (!spotMatch && !futuresMatch) {
      // Not our route — destroy socket so nothing hangs
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const market       = spotMatch ? 'spot' : 'futures';
      const streamName   = spotMatch ? spotMatch[1] : futuresMatch[1];

      // ── Kline streams → Redis pub/sub (zero new Binance connections) ────────
      const klineM = streamName.match(/^(.+)@kline_(.+)$/);
      if (klineM) {
        subscribeKlineClient(market, klineM[1].toUpperCase(), klineM[2], clientWs);
        return;
      }

      // ── All other streams → proxy to Binance ──────────────────────────────
      const upstreamBase = market === 'spot' ? SPOT_WS_BASE : FUTURES_WS_BASE;
      const upstreamUrl  = `${upstreamBase}/${streamName}`;
      const connId       = nextConnId++;
      const label        = `[binance-ws-proxy] [${connId}] ${market}/${streamName}`;

      activeConnections.set(connId, {
        market,
        stream:             streamName,
        connectedAt:        Date.now(),
        msgRelayed:         0,
        upstreamReconnects: 0,
        upstream:           null,
        clientWs:           clientWs,
        statsInterval:      null,
      });

      console.log(`${label} client connected → ${upstreamUrl}`);

      // Connect upstream (attempt 0 = initial, not a reconnect)
      connectUpstream(upstreamUrl, market, streamName, connId, clientWs, 0);

      // Forward client messages → upstream (subscribe / unsubscribe JSON frames)
      clientWs.on('message', (data, isBinary) => {
        if (data.length > 1024 * 1024) {
          clientWs.close(1009, 'message too large');
          return;
        }
        const info = activeConnections.get(connId);
        const up   = info?.upstream;
        if (up && up.readyState === WebSocket.OPEN) {
          up.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', (code) => {
        const info = activeConnections.get(connId);
        console.log(
          `${label} client disconnected code=${code} msgRelayed=${info?.msgRelayed ?? 0}`,
        );
        // Stop stats interval
        if (info?.statsInterval) clearInterval(info.statsInterval);
        // Close upstream
        const up = info?.upstream;
        if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) {
          up.close();
        }
        activeConnections.delete(connId);
      });

      clientWs.on('error', (err) => {
        const info = activeConnections.get(connId);
        console.error(`${label} client error: ${err.message} msgRelayed=${info?.msgRelayed ?? 0}`);
        if (info?.statsInterval) clearInterval(info.statsInterval);
        const up = info?.upstream;
        if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) {
          up.close();
        }
        activeConnections.delete(connId);
      });
    });
  });

  console.log('[backend] Binance WS proxy attached: kline→Redis pub/sub, other→Binance proxy');
}

module.exports = { attachBinanceWsProxy, getWsProxyStats };

