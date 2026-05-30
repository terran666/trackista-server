'use strict';
/**
 * liveWsGateway.js — WebSocket gateway for hybrid realtime transport.
 *
 * URL path: ws://host/ws/live
 *
 * Architecture:
 *   - One shared screener/delta cache via getDelta() → _getOrBuildCache()
 *     (no extra Redis pipeline per WS client — cache is shared with HTTP delta)
 *   - One server-side flush loop per scope, builds delta ONCE per tick,
 *     distributes to all scope subscribers (not per-client polling)
 *   - Alert events from Redis alerts:live on 500 ms cadence
 *   - Watch-state from Redis levelwatchstate:* on 2000 ms cadence
 *   - HTTP delta/snapshot endpoints remain intact as fallback/debug
 *
 * Client → Server messages: hello, subscribe, unsubscribe, resync_request, ping
 * Server → Client messages: ready, subscribed, delta, heartbeat,
 *                           full_resync_required, alert_event, watch_delta,
 *                           error, pong
 *
 * Flush cadences (ms):
 *   screener  :  500
 *   monitor   : 2000
 *   testpage  :  250
 *   alerts    :  500
 *   watch     : 2000
 *   heatmap   : 1000
 *   density   :  400
 */

const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID }                  = require('crypto');
const { getDelta }                    = require('../services/screenerAggregationService');
const registry                        = require('../services/wsSubscriptionRegistry');
const eventBus                        = require('../services/wsEventBus');
const metrics                         = require('../services/livePollingMetrics');
const densityService                  = require('../services/densityService');
const { normalizeWall }               = require('../utils/normalizeWall');

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_PATH                 = '/ws/live';
const MAX_CONNECTIONS         = 1000;
const PING_INTERVAL_MS        = 20_000;   // send native WS ping every 20 s
const MSG_RATE_WINDOW_MS      = 10_000;   // sliding window for client msg rate guard
const MSG_RATE_MAX            = 50;       // max client messages per window
const MAX_SINCE_AGE_MS        = 2 * 60 * 1000; // cursor older than 2 min → full resync
const GET_DELTA_TIMEOUT_MS    = 5_000;    // cap per-client getDelta() to keep flush loop alive

/** Flush cadence per scope (ms). */
const FLUSH_CADENCE = {
  screener : 500,
  monitor  : 2000,
  testpage : 250,
  alerts   : 500,
  watch    : 2000,
  heatmap  : 1000,
  density  : 400,
  robobot  : 5000,
};

const VALID_SCOPES = new Set(Object.keys(FLUSH_CADENCE));

/**
 * Scope-level field projection (mirrors liveDeltaRoute SCOPE_FIELDS).
 * null = return full row.
 */
const SCOPE_FIELDS = {
  screener : null,
  testpage : null,
  monitor  : new Set([
    'symbol', 'market', 'lastPrice', 'price',
    'priceChangePct', 'priceChangePct5m', 'priceChangePct15m',
    'volumeUsdt60s', 'volumeUsdt1m',
    'impulseScore', 'inPlayScore',
    'hasRecentAlert', 'alertCount', 'recentAlertType',
    'moveEventState', 'moveState',
    'dataStatus', 'updatedAt', 'ts',
  ]),
};

function projectRow(row, scope) {
  const fieldSet = SCOPE_FIELDS[scope] ?? null;
  if (!fieldSet) return row;
  const out = {};
  for (const key of fieldSet) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

// ─── Connection state ─────────────────────────────────────────────────────────

// Map<connectionId, ConnState>
const connections = new Map();

function createConnState(ws) {
  return {
    connectionId  : randomUUID(),
    ws,
    isAlive       : true,    // reset to false on ping, set to true on pong
    msgTimestamps : [],       // for per-client message rate guard
    pingTimer     : null,
  };
}

// ─── Safe send ────────────────────────────────────────────────────────────────

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
    metrics.recordWsMessageSent();
  } catch (_) { /* connection closing */ }
}

// ─── Message rate guard ───────────────────────────────────────────────────────

function checkMsgRate(state) {
  const now    = Date.now();
  const cutoff = now - MSG_RATE_WINDOW_MS;
  let i = 0;
  while (i < state.msgTimestamps.length && state.msgTimestamps[i] < cutoff) i++;
  if (i > 0) state.msgTimestamps.splice(0, i);
  state.msgTimestamps.push(now);
  return state.msgTimestamps.length <= MSG_RATE_MAX;
}

// ─── Incoming message dispatcher ─────────────────────────────────────────────

function handleMessage(connId, raw) {
  const state = connections.get(connId);
  if (!state) return;

  if (!checkMsgRate(state)) {
    safeSend(state.ws, {
      type    : 'error',
      code    : 'RATE_LIMITED',
      message : 'Too many messages. Slow down client.',
    });
    return;
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    safeSend(state.ws, { type: 'error', code: 'INVALID_JSON', message: 'Could not parse message as JSON' });
    return;
  }

  if (!msg || typeof msg.type !== 'string') {
    safeSend(state.ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Missing or non-string "type" field' });
    return;
  }

  switch (msg.type) {
    case 'hello':
      // Optional auth/version handshake — acknowledge with ready
      safeSend(state.ws, { type: 'ready', connectionId: connId, serverTime: Date.now() });
      break;

    case 'subscribe':
      handleSubscribe(connId, state, msg);
      break;

    case 'unsubscribe':
      handleUnsubscribe(connId, msg);
      break;

    case 'resync_request':
      handleResyncRequest(connId, msg);
      break;

    case 'ping':
      safeSend(state.ws, { type: 'pong', ts: msg.ts ?? null, serverTime: Date.now() });
      break;

    default:
      safeSend(state.ws, {
        type    : 'error',
        code    : 'UNKNOWN_MESSAGE_TYPE',
        message : `Unknown message type: ${String(msg.type)}`,
      });
  }
}

function handleSubscribe(connId, state, msg) {
  const scope          = msg.scope;
  const subscriptionId = msg.subscriptionId;
  // Support top-level symbol/timeframe fields for heatmap and density scopes
  const rawParams      = typeof msg.params === 'object' && msg.params !== null ? msg.params : {};
  const params         =
    (scope === 'heatmap' && msg.symbol && !rawParams.symbol)
      ? { ...rawParams, symbol: msg.symbol } :
    (scope === 'density' && (msg.symbol || msg.timeframe))
      ? {
          ...rawParams,
          symbol    : (rawParams.symbol || msg.symbol || null),
          timeframe : (rawParams.timeframe || msg.timeframe || '1m'),
        } :
    rawParams;
  const since          = typeof msg.since === 'number' ? msg.since : null;

  if (!subscriptionId) {
    safeSend(state.ws, { type: 'error', code: 'MISSING_SUBSCRIPTION_ID', message: 'subscriptionId is required' });
    return;
  }

  if (!VALID_SCOPES.has(scope)) {
    safeSend(state.ws, {
      type    : 'error',
      code    : 'INVALID_SCOPE',
      message : `scope must be one of: ${[...VALID_SCOPES].join(', ')}`,
    });
    return;
  }

  // For density scope: detect symbol switch (same subscriptionId, different symbol).
  // Save the old symbol BEFORE registry.subscribe replaces the sub object so we
  // can deactivate it afterwards if no other subscribers need it.
  let _oldDensitySymbol = null;
  if (scope === 'density' && params.symbol) {
    const existingDensitySubs = registry.getSubscriptionsByScope('density');
    const existingSub = existingDensitySubs.find(
      s => s.connectionId === connId && s.subscriptionId === subscriptionId
    );
    if (existingSub?.params?.symbol) {
      const oldSym = existingSub.params.symbol.toUpperCase();
      const newSym = params.symbol.toUpperCase();
      if (oldSym !== newSym) _oldDensitySymbol = oldSym;
    }
  }

  const result = registry.subscribe(connId, subscriptionId, scope, params, since);

  if (!result.ok) {
    safeSend(state.ws, {
      type    : 'error',
      code    : result.error,
      message : `Subscription failed: ${result.error}`,
    });
    return;
  }

  metrics.recordWsSubscribe(scope);

  // Auto-activate symbol for scopes backed by streaming services
  if ((scope === 'heatmap' || scope === 'density') && params.symbol) {
    eventBus.emit(`${scope}:activate`, params.symbol);
  }

  // Deactivate old density symbol if no other subscribers need it
  if (_oldDensitySymbol) {
    const remaining = registry.getSubscriptionsByScope('density')
      .filter(s => (s.params?.symbol || '').toUpperCase() === _oldDensitySymbol);
    if (remaining.length === 0) {
      densityService.deactivateSymbol(_oldDensitySymbol);
    }
  }

  safeSend(state.ws, {
    type           : 'subscribed',
    scope,
    subscriptionId,
    cursor         : result.sub.lastDeliveredCursor ?? Date.now(),
    serverTime     : Date.now(),
  });
}

function handleUnsubscribe(connId, msg) {
  const subscriptionId = msg.subscriptionId;
  if (!subscriptionId) return;

  // For density: find the symbol being removed so we can deactivate if orphaned.
  let _oldDensitySymbol = null;
  const removingSub = registry.getSubscriptionsByScope('density')
    .find(s => s.connectionId === connId && s.subscriptionId === subscriptionId);
  if (removingSub?.params?.symbol) {
    _oldDensitySymbol = removingSub.params.symbol.toUpperCase();
  }

  registry.unsubscribe(connId, subscriptionId);
  metrics.recordWsUnsubscribe();

  if (_oldDensitySymbol) {
    const remaining = registry.getSubscriptionsByScope('density')
      .filter(s => (s.params?.symbol || '').toUpperCase() === _oldDensitySymbol);
    if (remaining.length === 0) {
      densityService.deactivateSymbol(_oldDensitySymbol);
    }
  }
}

function handleResyncRequest(connId, msg) {
  const { scope, subscriptionId } = msg;
  if (!scope || !subscriptionId) return;
  // Clear cursor — next flush will produce full_resync_required so client re-HTTP-snapshots
  const subs = registry.getSubscriptionsByScope(scope);
  const sub  = subs.find(s => s.connectionId === connId && s.subscriptionId === subscriptionId);
  if (sub) sub.lastDeliveredCursor = null;
}

// ─── Flush loops ──────────────────────────────────────────────────────────────

const flushTimers   = new Map();  // Map<scope, timer>
let   _redis        = null;       // set by attachLiveWsGateway

// Server-side watch-state snapshot for incremental diff
let _watchStateSnap = null;       // Map<redisKey, object>

function startFlushLoops() {
  for (const [scope, cadence] of Object.entries(FLUSH_CADENCE)) {
    const timer = setInterval(() => _runFlush(scope), cadence);
    timer.unref();
    flushTimers.set(scope, timer);
  }
}

function stopFlushLoops() {
  for (const timer of flushTimers.values()) clearInterval(timer);
  flushTimers.clear();
}

function _runFlush(scope) {
  if (scope === 'alerts') {
    _flushAlerts().catch(err => console.error('[liveWsGateway] flushAlerts:', err.message));
  } else if (scope === 'watch') {
    _flushWatch().catch(err => console.error('[liveWsGateway] flushWatch:', err.message));
  } else if (scope === 'heatmap') {
    _flushHeatmap().catch(err => console.error('[liveWsGateway] flushHeatmap:', err.message));
  } else if (scope === 'density') {
    _flushDensity().catch(err => console.error('[liveWsGateway] flushDensity:', err.message));
  } else if (scope === 'robobot') {
    _flushRobobot();
  } else {
    _flushScreenerScope(scope).catch(err =>
      console.error(`[liveWsGateway] flushScope(${scope}):`, err.message),
    );
  }
}

// ─── Screener / monitor / testpage flush ─────────────────────────────────────

async function _flushScreenerScope(scope) {
  const subs = registry.getSubscriptionsByScope(scope);
  if (subs.length === 0) return;

  // Process subs in bounded parallel batches so a single slow sub does not
  // serialize the entire scope's flush. Each sub's I/O is independent
  // (per-cursor getDelta), but we cap concurrency to avoid hammering Redis.
  const CONCURRENCY = 10;
  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    const batch = subs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(sub => _flushOneScreenerSub(scope, sub)));
  }
}

async function _flushOneScreenerSub(scope, sub) {
  const { connectionId, subscriptionId, params, lastDeliveredCursor } = sub;
    const state = connections.get(connectionId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) return;

    // Stale cursor → tell client to resync via HTTP
    if (lastDeliveredCursor == null || (Date.now() - lastDeliveredCursor) > MAX_SINCE_AGE_MS) {
      safeSend(state.ws, {
        type           : 'full_resync_required',
        scope,
        subscriptionId,
        reason         : lastDeliveredCursor == null ? 'no_cursor' : 'stale_cursor',
        serverTime     : Date.now(),
      });
      metrics.recordWsFullResync();
      // Set cursor to now so we don't spam resync
      registry.updateCursor(connectionId, subscriptionId, Date.now());
      return;
    }

    try {
      // Bounded getDelta so a hung Redis call cannot stall the per-scope flush
      // loop indefinitely. On timeout we fall through to a heartbeat for this
      // tick — next tick will retry naturally.
      const result = await Promise.race([
        getDelta(_redis, lastDeliveredCursor, params || {}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('getDelta timeout')), GET_DELTA_TIMEOUT_MS).unref(),
        ),
      ]);

      if (result.fullResyncRequired) {
        safeSend(state.ws, {
          type           : 'full_resync_required',
          scope,
          subscriptionId,
          reason         : result.reason || 'stale_cursor',
          serverTime     : Date.now(),
        });
        metrics.recordWsFullResync();
        registry.updateCursor(connectionId, subscriptionId, Date.now());
        return;
      }

      const changedRows = Array.isArray(result.changedRows) ? result.changedRows : [];
      const newAlerts   = Array.isArray(result.newAlerts)   ? result.newAlerts   : [];
      const newCursor   = result.nextCursor;

      registry.updateCursor(connectionId, subscriptionId, newCursor);

      // No changes → heartbeat
      if (changedRows.length === 0 && newAlerts.length === 0) {
        safeSend(state.ws, {
          type           : 'heartbeat',
          scope,
          subscriptionId,
          cursor         : newCursor,
          serverTime     : Date.now(),
        });
        metrics.recordWsHeartbeat();
        return;
      }

      // Build change map with scope-level field projection
      const changes = {};
      for (const row of changedRows) {
        changes[row.symbol] = projectRow(row, scope);
      }

      const frame = {
        type         : 'delta',
        scope,
        subscriptionId,
        cursor       : newCursor,
        changes,
        removed      : [],
        changedCount : changedRows.length,
        serverTime   : Date.now(),
      };
      // Include newAlerts inline (matches HTTP delta contract)
      if (newAlerts.length > 0) frame.newAlerts = newAlerts;

      // Сериализуем один раз — и для отправки, и для подсчёта байт.
      const encoded = JSON.stringify(frame);
      if (state.ws.readyState === WebSocket.OPEN) {
        try {
          state.ws.send(encoded);
          metrics.recordWsMessageSent();
        } catch (_) { /* connection closing */ }
      }
      metrics.recordWsDelta(scope, Buffer.byteLength(encoded, 'utf8'));

    } catch (err) {
      console.error(`[liveWsGateway] _flushScreenerScope(${scope}) err:`, err.message);
    }
}

// ─── Heatmap flush ───────────────────────────────────────────────────────────

async function _flushHeatmap() {
  const subs = registry.getSubscriptionsByScope('heatmap');
  if (subs.length === 0) return;

  const now = Date.now();

  for (const sub of subs) {
    const { connectionId, subscriptionId, params } = sub;
    const state = connections.get(connectionId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) continue;

    const symbol = (params?.symbol || '').toUpperCase();
    if (!symbol) continue;

    try {
      const raw = await _redis.get(`heatmap:latest:${symbol}`);
      if (!raw) {
        safeSend(state.ws, { type: 'heartbeat', scope: 'heatmap', subscriptionId, cursor: now, serverTime: now });
        metrics.recordWsHeartbeat();
        continue;
      }

      const snapshot = JSON.parse(raw);
      // Only push if snapshot is newer than cursor already delivered
      const snapshotTs = snapshot.ts ?? now;
      if (typeof sub.lastDeliveredCursor === 'number' && snapshotTs <= sub.lastDeliveredCursor) {
        safeSend(state.ws, { type: 'heartbeat', scope: 'heatmap', subscriptionId, cursor: sub.lastDeliveredCursor, serverTime: now });
        metrics.recordWsHeartbeat();
        continue;
      }

      registry.updateCursor(connectionId, subscriptionId, snapshotTs);
      safeSend(state.ws, {
        type           : 'heatmap:update',
        subscriptionId,
        symbol,
        cursor         : snapshotTs,
        snapshot,
        serverTime     : now,
      });
    } catch (err) {
      console.error('[liveWsGateway] _flushHeatmap err:', err.message);
    }
  }
}

// ─── Density flush (unified snapshot per subscription) ────────────────────────
//
// Builds the unified DOM+cluster+POC snapshot for each active density
// subscription and sends it as `density:snapshot`. Skips delivery if the
// snapshot signature has not changed since the last flush for that subscription.

async function _flushDensity() {
  const subs = registry.getSubscriptionsByScope('density');
  if (subs.length === 0) return;
  const now = Date.now();

  // Group subs by symbol+tf+window so we build each snapshot once per tick.
  const groups = new Map(); // key → { symbol, tf, above, below, subs:[] }
  for (const sub of subs) {
    const symbol = (sub.params?.symbol || '').toUpperCase();
    if (!symbol) {
      // No symbol bound yet → heartbeat only
      const state = connections.get(sub.connectionId);
      if (state && state.ws.readyState === WebSocket.OPEN) {
        safeSend(state.ws, {
          type: 'heartbeat', scope: 'density',
          subscriptionId: sub.subscriptionId, cursor: now, serverTime: now,
        });
        metrics.recordWsHeartbeat();
      }
      continue;
    }
    const tf    = sub.params?.timeframe || '1m';
    const above = Math.min(Math.max(parseInt(sub.params?.above ?? 40, 10) || 40, 1), 200);
    const below = Math.min(Math.max(parseInt(sub.params?.below ?? 40, 10) || 40, 1), 200);
    const key   = `${symbol}|${tf}|${above}|${below}`;
    if (!groups.has(key)) groups.set(key, { symbol, tf, above, below, subs: [] });
    const grp = groups.get(key);
    // Dedup by subscriptionId so an accidental double-subscribe does not
    // produce duplicated frames per tick.
    if (!grp.subs.some(s => s.subscriptionId === sub.subscriptionId && s.connectionId === sub.connectionId)) {
      grp.subs.push(sub);
    }
  }

  for (const { symbol, tf, above, below, subs: gsubs } of groups.values()) {
    let snap;
    let activateError = null;
    try {
      if (!densityService.isSymbolActive(symbol)) {
        const r = densityService.activateSymbol(symbol);
        if (r && r.ok === false) activateError = r;
      }
      if (!activateError) {
        // Cap density snapshot build time so a slow densityService call
        // cannot stall the 400ms flush loop indefinitely.
        snap = await Promise.race([
          densityService.getUnifiedSnapshot(symbol, tf, above, below),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('density snapshot timeout')), 3_000).unref(),
          ),
        ]);
      }
    } catch (err) {
      console.error(`[liveWsGateway] density snapshot ${symbol}/${tf}:`, err.message);
      snap = null;
    }

    for (const sub of gsubs) {
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;

      // Surface capacity / activation failure exactly once per subscription.
      if (activateError && sub.lastDensityActivateErr !== activateError.error) {
        safeSend(state.ws, {
          type           : 'error',
          scope          : 'density',
          subscriptionId : sub.subscriptionId,
          code           : activateError.error,
          message        : activateError.message || 'Density symbol activation failed',
          serverTime     : now,
        });
        sub.lastDensityActivateErr = activateError.error;
        continue;
      }

      if (!snap) {
        safeSend(state.ws, {
          type: 'heartbeat', scope: 'density',
          subscriptionId: sub.subscriptionId, cursor: now, serverTime: now,
        });
        metrics.recordWsHeartbeat();
        continue;
      }
      // Clear sticky activation error once snapshot resumes.
      if (sub.lastDensityActivateErr) sub.lastDensityActivateErr = null;

      // Dedupe signature — must change when DOM updates, when POC moves, when
      // stale flags flip, AND when new trades land (footprint cells change).
      const sig =
        `${snap.updatedAt}|${snap.poc}|${snap.stale.dom?1:0}|${snap.stale.trades?1:0}|${snap.lastTradeTs ?? 0}`;
      if (sub.lastDensitySig === sig) {
        // Still emit heartbeat so client knows the link is alive
        safeSend(state.ws, {
          type: 'heartbeat', scope: 'density',
          subscriptionId: sub.subscriptionId, cursor: now, serverTime: now,
        });
        metrics.recordWsHeartbeat();
        continue;
      }
      sub.lastDensitySig = sig;

      safeSend(state.ws, {
        type           : 'density:snapshot',
        subscriptionId : sub.subscriptionId,
        cursor         : now,
        serverTime     : now,
        ...snap,
      });
    }

    // ── density:walls — current confirmed/persistent walls from Redis ────
    // Sent every flush tick so the client always sees the current wall list.
    // Only delivered when there are subscribed clients for this group.
    try {
      const marketType = 'futures'; // TODO: derive from subscription params when spot is added
      const wallsKey   = `${marketType}:walls:${symbol}`;
      const wallsRaw   = await _redis.get(wallsKey);
      if (wallsRaw) {
        const wallsData = JSON.parse(wallsRaw);
        const rawWalls  = Array.isArray(wallsData) ? wallsData : (wallsData.walls || []);
        const walls     = rawWalls.map(w => normalizeWall(w));
        const wallsSig  = `${wallsData.updatedAt ?? wallsData.ts ?? now}:${walls.length}`;
        for (const sub of gsubs) {
          const state = connections.get(sub.connectionId);
          if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
          if (sub.lastDensityWallsSig === wallsSig) continue;
          sub.lastDensityWallsSig = wallsSig;
          safeSend(state.ws, {
            type           : 'density:walls',
            subscriptionId : sub.subscriptionId,
            cursor         : now,
            serverTime     : now,
            marketType,
            symbol,
            walls,
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── density.wallDepth.updated — pre-computed depth-to-wall data ──────
    // Read from density:wallDepth:{symbol} cache written by wallDepthRoute.
    // Cache miss triggers an inline build + write so the WS is always fed.
    try {
      const wdKey = `density:wallDepth:${symbol}`;
      let wdRaw   = await _redis.get(wdKey);
      if (!wdRaw) {
        // Cache is empty — attempt inline rebuild (non-fatal if it fails)
        try {
          const { buildAndCacheWallDepth } = require('./wallDepthRoute');
          const built = await buildAndCacheWallDepth(_redis, symbol);
          if (built) wdRaw = JSON.stringify(built);
        } catch (_ignore) { /* wallDepthRoute unavailable */ }
      }
      if (wdRaw) {
        const wdData = JSON.parse(wdRaw);
        const wdSig  = `${wdData.updatedAt}:${wdData.bid?.targetWall?.price ?? 'x'}:${wdData.ask?.targetWall?.price ?? 'x'}`;
        for (const sub of gsubs) {
          const state = connections.get(sub.connectionId);
          if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
          if (sub.lastDensityWallDepthSig === wdSig) continue;
          sub.lastDensityWallDepthSig = wdSig;
          safeSend(state.ws, {
            type           : 'density.wallDepth.updated',
            subscriptionId : sub.subscriptionId,
            cursor         : now,
            serverTime     : now,
            symbol,
            data           : wdData,
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── density:depth — cumulative depth map from orderbook ─────────────
    // Sent every flush tick. Only bids/asks arrays, lightweight.
    try {
      const marketType  = 'futures';
      const obKey       = `${marketType}:orderbook:${symbol}`;
      const obRaw       = await _redis.get(obKey);
      if (obRaw) {
        const ob      = JSON.parse(obRaw);
        const DEPTH_LEVELS = 100;
        const rawBids = (ob.bids || []).slice(0, DEPTH_LEVELS);
        const rawAsks = (ob.asks || []).slice(0, DEPTH_LEVELS);
        const bestBid = rawBids.length ? parseFloat(rawBids[0][0]) : 0;
        const bestAsk = rawAsks.length ? parseFloat(rawAsks[0][0]) : 0;
        const midPrice = (bestBid + bestAsk) / 2 || bestBid || bestAsk;
        const obSig = ob.updatedAt ?? ob.ts ?? now;
        function buildCum(levels) {
          let c = 0, cu = 0;
          return levels.map((level) => {
            // Normalize: collector stores {price,size} objects; handle both formats.
            const price = Array.isArray(level) ? parseFloat(level[0]) : parseFloat(level.price);
            const size  = Array.isArray(level) ? parseFloat(level[1]) : parseFloat(level.size);
            c += size; cu += size * price;
            return { price, size, cumulativeSize: c, cumulativeUsdt: cu };
          });
        }
        for (const sub of gsubs) {
          const state = connections.get(sub.connectionId);
          if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
          if (sub.lastDensityDepthSig === obSig) continue;
          sub.lastDensityDepthSig = obSig;
          safeSend(state.ws, {
            type           : 'density:depth',
            subscriptionId : sub.subscriptionId,
            cursor         : now,
            serverTime     : now,
            marketType,
            symbol,
            midPrice,
            bids           : buildCum(rawBids),
            asks           : buildCum(rawAsks),
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── density:wall-event — new wall lifecycle events since last poll ───
    // Uses per-subscription cursor (lastWallEventTs) so each client gets
    // only events it hasn't seen yet.
    try {
      const marketType = 'futures';
      const evKey      = `density:wall-events:${marketType}:${symbol}`;
      // Find the highest cursor across all subs in this group to do one ZRANGEBYSCORE.
      const minCursor  = gsubs.reduce((m, sub) => Math.min(m, sub.lastWallEventTs ?? (now - 60_000)), now);
      const evRaws     = await _redis.zrangebyscore(evKey, minCursor + 1, '+inf');
      if (evRaws.length > 0) {
        const events = evRaws.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        if (events.length > 0) {
          for (const sub of gsubs) {
            const state = connections.get(sub.connectionId);
            if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
            const subCursor = sub.lastWallEventTs ?? (now - 60_000);
            const subEvents = events.filter(ev => ev.ts > subCursor);
            if (subEvents.length === 0) continue;
            safeSend(state.ws, {
              type           : 'density:wall-event',
              subscriptionId : sub.subscriptionId,
              cursor         : now,
              serverTime     : now,
              marketType,
              symbol,
              events         : subEvents,
            });
            sub.lastWallEventTs = subEvents[subEvents.length - 1].ts;
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── density:candle — latest 1m bar from the bar aggregator ──────────
    // Pushed every 400ms flush cadence so the chart always shows a live
    // (potentially incomplete) current candle. Signature-deduped per sub.
    try {
      const marketType = 'futures';
      const barsKey    = `bars:1m:${symbol}`;
      const lastRaw    = await _redis.zrange(barsKey, -1, -1);
      if (lastRaw && lastRaw.length > 0) {
        const bar = JSON.parse(lastRaw[0]);
        const candle = {
          time   : bar.ts,
          open   : bar.open,
          high   : bar.high,
          low    : bar.low,
          close  : bar.close,
          volume : bar.volumeUsdt ?? 0,
        };
        const candleSig = `${candle.time}:${candle.close}`;
        for (const sub of gsubs) {
          const state = connections.get(sub.connectionId);
          if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
          if (sub.lastDensityCandleSig === candleSig) continue;
          sub.lastDensityCandleSig = candleSig;
          safeSend(state.ws, {
            type           : 'density:candle',
            subscriptionId : sub.subscriptionId,
            cursor         : now,
            serverTime     : now,
            marketType,
            symbol,
            tf             : '1m',
            candle,
          });
        }
      }
    } catch (_) { /* non-fatal */ }
  }
}

// ─── Robobot flush (heartbeat only — real updates pushed via eventBus) ───────

function _flushRobobot() {
  const subs = registry.getSubscriptionsByScope('robobot');
  if (subs.length === 0) return;
  const now = Date.now();
  for (const sub of subs) {
    const state = connections.get(sub.connectionId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
    safeSend(state.ws, {
      type: 'heartbeat', scope: 'robobot',
      subscriptionId: sub.subscriptionId, cursor: now, serverTime: now,
    });
    metrics.recordWsHeartbeat();
  }
}

// ─── Alerts flush ─────────────────────────────────────────────────────────────

async function _flushAlerts() {
  const subs = registry.getSubscriptionsByScope('alerts');
  if (subs.length === 0) return;

  const now = Date.now();
  const CONCURRENCY = 10;
  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    const batch = subs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(sub => _flushOneAlertsSub(sub, now)));
  }
}

async function _flushOneAlertsSub(sub, now) {
  const { connectionId, subscriptionId, lastDeliveredCursor } = sub;
    const state = connections.get(connectionId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) return;

    const since = typeof lastDeliveredCursor === 'number' ? lastDeliveredCursor : now - 5000;

    try {
      const raws = await _redis.zrangebyscore('alerts:live', since + 1, '+inf');

      if (!raws || raws.length === 0) {
        safeSend(state.ws, { type: 'heartbeat', scope: 'alerts', subscriptionId, cursor: now, serverTime: now });
        metrics.recordWsHeartbeat();
        return;
      }

      // Re-read the live cursor from the sub object: the event-bus listener may have
      // already delivered some of these alerts (and advanced the cursor) while we
      // were awaiting the Redis call above. Using the snapshot `lastDeliveredCursor`
      // would cause duplicates for alerts delivered by the event bus.
      const liveCursor = typeof sub.lastDeliveredCursor === 'number' ? sub.lastDeliveredCursor : since;

      const alerts = raws
        .map(r => { try { return JSON.parse(r); } catch (e) { console.warn('[liveWsGateway] _flushAlerts parse:', e.message); return null; } })
        .filter(Boolean)
        .filter(a => (a.createdAt ?? 0) > liveCursor);
      alerts.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      // Никогда не откатываем курсор ниже того, что уже доставил event-bus.
      // Иначе: event-bus обновил liveCursor до T_alert во время await zrangebyscore,
      // alerts.length = 0 после фильтрации, newCursor = now < T_alert → откат → дубль.
      const rawCursor = alerts.length > 0 ? (alerts[alerts.length - 1]?.createdAt ?? now) : now;
      const newCursor = Math.max(rawCursor, liveCursor);
      registry.updateCursor(connectionId, subscriptionId, newCursor);

      if (alerts.length === 0) {
        safeSend(state.ws, { type: 'heartbeat', scope: 'alerts', subscriptionId, cursor: newCursor, serverTime: now });
        metrics.recordWsHeartbeat();
        return;
      }

      for (const alert of alerts) {
        safeSend(state.ws, {
          type           : 'alert_event',
          subscriptionId,
          cursor         : alert.createdAt ?? now,
          event          : alert,
          serverTime     : now,
        });
        metrics.recordWsAlertSent();
      }

    } catch (err) {
      console.error('[liveWsGateway] _flushAlerts err:', err.message);
    }
}

// ─── Watch-state flush ────────────────────────────────────────────────────────

async function _flushWatch() {
  const subs = registry.getSubscriptionsByScope('watch');
  if (subs.length === 0) return;

  try {
    // Scan all levelwatchstate:* keys from Redis — ONCE per flush interval.
    // Hard caps prevent an unbounded SCAN from blowing memory or starving the
    // flush loop if the keyspace ever explodes.
    const SCAN_KEY_CAP   = 5000;
    const SCAN_ITER_CAP  = 50;
    const snapshot = new Map();
    let cursor   = '0';
    let iters    = 0;
    let aborted  = false;
    do {
      const [nextCursor, keys] = await _redis.scan(cursor, 'MATCH', 'levelwatchstate:*', 'COUNT', 200);
      cursor = nextCursor;
      iters++;
      if (!keys.length) {
        if (iters >= SCAN_ITER_CAP) { aborted = true; break; }
        continue;
      }

      const pipe = _redis.pipeline();
      for (const k of keys) pipe.get(k);
      const results = await pipe.exec();
      if (!results) {
        console.error('[liveWsGateway] _flushWatch pipeline returned no result');
        break;
      }

      for (let i = 0; i < keys.length; i++) {
        const raw = results[i]?.[1];
        if (!raw) continue;
        try {
          snapshot.set(keys[i], JSON.parse(raw));
        } catch (e) { console.warn('[liveWsGateway] _flushWatch JSON parse:', e.message); }
        if (snapshot.size >= SCAN_KEY_CAP) { aborted = true; break; }
      }
      if (aborted || iters >= SCAN_ITER_CAP) { aborted = aborted || iters >= SCAN_ITER_CAP; break; }
    } while (cursor !== '0');
    if (aborted) {
      // Partial snapshot — do NOT overwrite _watchStateSnap.
      // If we did, keys captured in previous full scan but absent from this
      // partial scan would appear as `removed` on the next tick (false removes).
      console.warn(`[liveWsGateway] _flushWatch aborted SCAN at ${snapshot.size} keys (iters=${iters}) — skipping diff`);
      const now = Date.now();
      for (const sub of subs) {
        const { connectionId, subscriptionId } = sub;
        const state = connections.get(connectionId);
        if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
        safeSend(state.ws, { type: 'heartbeat', scope: 'watch', subscriptionId, cursor: now, serverTime: now });
        metrics.recordWsHeartbeat();
      }
      return;
    }

    // Compute diff against previous snapshot
    const prev        = _watchStateSnap || new Map();
    _watchStateSnap   = snapshot;

    const changes = {};
    for (const [key, obj] of snapshot) {
      const p = prev.get(key);
      if (!p || p.updatedAt !== obj.updatedAt || p.phase !== obj.phase) {
        changes[key] = obj;
      }
    }

    const removed = [];
    for (const key of prev.keys()) {
      if (!snapshot.has(key)) removed.push(key);
    }

    const hasChanges = Object.keys(changes).length > 0 || removed.length > 0;
    const now        = Date.now();

    for (const sub of subs) {
      const { connectionId, subscriptionId } = sub;
      const state = connections.get(connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;

      if (!hasChanges) {
        safeSend(state.ws, {
          type           : 'heartbeat',
          scope          : 'watch',
          subscriptionId,
          cursor         : now,
          serverTime     : now,
        });
        metrics.recordWsHeartbeat();
        continue;
      }

      safeSend(state.ws, {
        type           : 'watch_delta',
        subscriptionId,
        cursor         : now,
        changes,
        removed,
        serverTime     : now,
      });
      metrics.recordWsWatchDelta();
      registry.updateCursor(connectionId, subscriptionId, now);
    }

  } catch (err) {
    console.error('[liveWsGateway] _flushWatch err:', err.message);
  }
}

// ─── Event bus listeners (near-instant alert push) ───────────────────────────

// Keep references so we can detach on shutdown / re-attach safely.
const _busHandlers = [];

function _attachEventBusListeners() {
  // Detach any previously-attached handlers first — protects against
  // double-attach when attachLiveWsGateway() is called more than once.
  _detachEventBusListeners();
  // Near-instant heatmap snapshot push (complements the 1s flush loop)
  const onHeatmap = ({ symbol, snapshot }) => {
    const subs = registry.getSubscriptionsByScope('heatmap');
    const now  = Date.now();
    for (const sub of subs) {
      if ((sub.params?.symbol || '').toUpperCase() !== symbol) continue;
      const snapshotTs = snapshot.ts ?? now;
      if (
        typeof sub.lastDeliveredCursor === 'number' &&
        snapshotTs <= sub.lastDeliveredCursor
      ) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'heatmap:update',
        subscriptionId : sub.subscriptionId,
        symbol,
        cursor         : snapshotTs,
        snapshot,
        serverTime     : now,
      });
      registry.updateCursor(sub.connectionId, sub.subscriptionId, snapshotTs);
    }
  };
  eventBus.on('heatmap:update', onHeatmap);
  _busHandlers.push(['heatmap:update', onHeatmap]);

  // ── Density DOM update — orderbook changed (≤200ms cadence from densityService)
  const onDensityDom = ({ symbol, bids, asks, updatedAt }) => {
    const subs = registry.getSubscriptionsByScope('density');
    if (subs.length === 0) return;
    const now  = Date.now();
    for (const sub of subs) {
      if ((sub.params?.symbol || '').toUpperCase() !== symbol) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'density:orderbook',
        subscriptionId : sub.subscriptionId,
        symbol,
        bids,
        asks,
        updatedAt,
        serverTime     : now,
      });
    }
  };
  eventBus.on('density:dom', onDensityDom);
  _busHandlers.push(['density:dom', onDensityDom]);

  // ── Density last trade — per aggTrade
  const onDensityLastTrade = ({ symbol, trade }) => {
    const subs = registry.getSubscriptionsByScope('density');
    if (subs.length === 0) return;
    const now  = Date.now();
    for (const sub of subs) {
      if ((sub.params?.symbol || '').toUpperCase() !== symbol) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'density:lastTrade',
        subscriptionId : sub.subscriptionId,
        symbol         : trade.symbol,
        price          : trade.price,
        qty            : trade.qty,
        side           : trade.side,
        timestamp      : trade.timestamp,
        serverTime     : now,
      });
    }
  };
  eventBus.on('density:lastTrade', onDensityLastTrade);
  _busHandlers.push(['density:lastTrade', onDensityLastTrade]);

  // ── Density footprint cell update — per aggTrade (1m only)
  const onDensityFootprint = (update) => {
    const subs = registry.getSubscriptionsByScope('density');
    if (subs.length === 0) return;
    const now  = Date.now();
    for (const sub of subs) {
      if ((sub.params?.symbol || '').toUpperCase() !== update.symbol) continue;
      // Filter by subscriber's timeframe (default 1m matches all 1m events)
      const subTf = sub.params?.timeframe ?? '1m';
      if (subTf !== update.tf) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'density:footprint',
        subscriptionId : sub.subscriptionId,
        symbol         : update.symbol,
        timeframe      : update.tf,
        barTime        : update.barTime,
        price          : update.price,
        buyQty         : update.buyQty,
        sellQty        : update.sellQty,
        deltaQty       : update.deltaQty,
        serverTime     : now,
      });
    }
  };
  eventBus.on('density:footprint', onDensityFootprint);
  _busHandlers.push(['density:footprint', onDensityFootprint]);

  // ── Robobot task lifecycle update — broadcast to all robobot subscribers
  const onRobobotTask = (update) => {
    const subs = registry.getSubscriptionsByScope('robobot');
    const now  = Date.now();
    for (const sub of subs) {
      // Optional symbol filter
      if (sub.params?.symbol && String(sub.params.symbol).toUpperCase() !== String(update.symbol || '').toUpperCase()) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'robobot:task:update',
        subscriptionId : sub.subscriptionId,
        cursor         : update.updatedAt ?? now,
        serverTime     : now,
        ...update,
      });
    }
  };
  eventBus.on('robobot:task:update', onRobobotTask);
  _busHandlers.push(['robobot:task:update', onRobobotTask]);

  const onRobobotEvent = (ev) => {
    const subs = registry.getSubscriptionsByScope('robobot');
    const now  = Date.now();
    for (const sub of subs) {
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'robobot:event',
        subscriptionId : sub.subscriptionId,
        cursor         : ev.createdAt ?? now,
        serverTime     : now,
        event          : ev,
      });
    }
  };
  eventBus.on('robobot:event', onRobobotEvent);
  _busHandlers.push(['robobot:event', onRobobotEvent]);

  // Immediate alert push to scope='alerts' subscribers (complements the flush loop)
  const onAlert = (alert) => {
    const subs = registry.getSubscriptionsByScope('alerts');
    const now  = Date.now();
    for (const sub of subs) {
      // Skip if _flushAlerts already delivered this alert (cursor already advanced past it)
      if (
        typeof sub.lastDeliveredCursor === 'number' &&
        typeof alert.createdAt === 'number' &&
        alert.createdAt <= sub.lastDeliveredCursor
      ) continue;
      const state = connections.get(sub.connectionId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;
      safeSend(state.ws, {
        type           : 'alert_event',
        subscriptionId : sub.subscriptionId,
        cursor         : alert.createdAt ?? now,
        event          : alert,
        serverTime     : now,
      });
      metrics.recordWsAlertSent();
      registry.updateCursor(sub.connectionId, sub.subscriptionId, alert.createdAt ?? now);
    }
  };
  eventBus.on('alert', onAlert);
  _busHandlers.push(['alert', onAlert]);
}

function _detachEventBusListeners() {
  while (_busHandlers.length) {
    const [event, handler] = _busHandlers.pop();
    try { eventBus.off(event, handler); } catch (_) { /* noop */ }
  }
}

// ─── Ping/pong lifecycle ──────────────────────────────────────────────────────

function _startPingCycle(state) {
  state.pingTimer = setInterval(() => {
    if (!state.isAlive) {
      // No pong received since last ping — consider connection dead
      state.ws.terminate();
      return;
    }
    state.isAlive = false; // will be set to true on pong
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.ping();
    }
  }, PING_INTERVAL_MS);
  if (state.pingTimer.unref) state.pingTimer.unref();
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────

function _onConnection(ws) {
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server at capacity');
    return;
  }

  const state = createConnState(ws);
  connections.set(state.connectionId, state);
  metrics.recordWsConnect();

  // Greet client immediately
  safeSend(ws, {
    type         : 'ready',
    connectionId : state.connectionId,
    serverTime   : Date.now(),
  });

  ws.on('pong', () => { state.isAlive = true; });

  _startPingCycle(state);

  ws.on('message', (data) => {
    handleMessage(state.connectionId, data.toString('utf8'));
  });

  // Single guarded cleanup so close+error firing together don't double-clean
  // and so externally-triggered ws.terminate() still releases the ping timer
  // and registry entries.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    // Collect density symbols held by this connection BEFORE the registry wipes them.
    const _densitySymbols = new Set(
      registry.getSubscriptionsByScope('density')
        .filter(s => s.connectionId === state.connectionId && s.params?.symbol)
        .map(s => s.params.symbol.toUpperCase())
    );

    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
    registry.cleanupConnection(state.connectionId);
    connections.delete(state.connectionId);
    metrics.recordWsDisconnect();

    // Deactivate any density symbols that now have no remaining subscribers.
    for (const sym of _densitySymbols) {
      const remaining = registry.getSubscriptionsByScope('density')
        .filter(s => (s.params?.symbol || '').toUpperCase() === sym);
      if (remaining.length === 0) {
        densityService.deactivateSymbol(sym);
      }
    }
  };

  ws.on('close', cleanup);

  ws.on('error', (err) => {
    console.error(`[liveWsGateway] ws error [${state.connectionId}]:`, err.message);
    cleanup();
  });
}

// ─── Attach to httpServer ─────────────────────────────────────────────────────

/**
 * Attach the WS gateway to an existing http.Server.
 *
 * IMPORTANT: must be called BEFORE attachBinanceWsProxy so this handler
 * intercepts /ws/live upgrades first. The Binance proxy must NOT call
 * socket.destroy() for unrecognised paths (see binanceWsProxy.js fix).
 *
 * @param {import('http').Server} httpServer
 * @param {import('ioredis').Redis} redis
 * @returns {{ wss: WebSocketServer }}
 */
function attachLiveWsGateway(httpServer, redis) {
  _redis = redis;

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', _onConnection);

  httpServer.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url !== WS_PATH) return; // leave for other handlers (Binance proxy)
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  _attachEventBusListeners();
  startFlushLoops();

  console.log(`[liveWsGateway] WebSocket gateway at ws://{host}${WS_PATH}`);
  return { wss };
}

// ─── Stats for health endpoint ────────────────────────────────────────────────

/**
 * Stop flush loops and detach event-bus handlers. Used by graceful shutdown
 * and during testing to release timers/listeners.
 */
function stopGateway() {
  stopFlushLoops();
  _detachEventBusListeners();
  _watchStateSnap = null;
  for (const state of connections.values()) {
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
    try { state.ws.terminate(); } catch (_) { /* noop */ }
  }
  connections.clear();
}

/**
 * Runtime stats for inclusion in /api/runtime/live-health.
 */
function getGatewayStats() {
  return {
    wsConnectionsCurrent   : connections.size,
    wsSubscriptionsCurrent : registry.getTotalSubscriptions(),
    perScopeSubscribers    : registry.getScopeCounts(),
  };
}

module.exports = { attachLiveWsGateway, getGatewayStats, stopGateway };
