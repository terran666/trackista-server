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

const SPOT_WS_BASE    = 'wss://stream.binance.com:9443/ws';
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

  console.log('[backend] Binance WS proxy attached: /ws/stream/* (spot) /ws/fstream/* (futures)');
}

module.exports = { attachBinanceWsProxy, getWsProxyStats };

