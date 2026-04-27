'use strict';
/**
 * wsSubscriptionRegistry.js — registry of active WebSocket subscriptions.
 *
 * Each subscription tracks:
 *   connectionId, subscriptionId, scope, params,
 *   lastDeliveredCursor, subscribedAt, lastActivityAt, state
 *
 * Thread-safety: single-threaded Node.js, no locking required.
 */

const MAX_SUBS_PER_CONNECTION = 10;
const MAX_SYMBOLS_PER_SUB     = 200;

class WsSubscriptionRegistry {
  constructor() {
    // Map<connectionId, Map<subscriptionId, Subscription>>
    this._byConnection = new Map();
    // Map<scope, Set<Subscription>>
    this._byScope = new Map();
  }

  /**
   * Register (or replace) a subscription.
   * @returns {{ ok: true, sub } | { ok: false, error: string }}
   */
  subscribe(connectionId, subscriptionId, scope, params, sinceCursor) {
    let connSubs = this._byConnection.get(connectionId);
    if (!connSubs) {
      connSubs = new Map();
      this._byConnection.set(connectionId, connSubs);
    }

    // Replace existing sub with same id before checking the limit
    if (connSubs.has(subscriptionId)) {
      this._removeSub(connectionId, subscriptionId, connSubs);
    }

    if (connSubs.size >= MAX_SUBS_PER_CONNECTION) {
      return { ok: false, error: 'MAX_SUBSCRIPTIONS_EXCEEDED' };
    }

    if (Array.isArray(params?.symbols) && params.symbols.length > MAX_SYMBOLS_PER_SUB) {
      return { ok: false, error: 'MAX_SYMBOLS_EXCEEDED' };
    }

    const now = Date.now();
    const sub = {
      connectionId,
      subscriptionId,
      scope,
      params              : params || {},
      lastDeliveredCursor : typeof sinceCursor === 'number' ? sinceCursor : null,
      subscribedAt        : now,
      lastActivityAt      : now,
      state               : 'active',
    };

    connSubs.set(subscriptionId, sub);

    let scopeSet = this._byScope.get(scope);
    if (!scopeSet) {
      scopeSet = new Set();
      this._byScope.set(scope, scopeSet);
    }
    scopeSet.add(sub);

    return { ok: true, sub };
  }

  /**
   * Unsubscribe a specific subscriptionId from a connection.
   * @returns {boolean}
   */
  unsubscribe(connectionId, subscriptionId) {
    const connSubs = this._byConnection.get(connectionId);
    if (!connSubs) return false;
    return this._removeSub(connectionId, subscriptionId, connSubs);
  }

  /**
   * Remove all subscriptions for a connection (call on disconnect).
   */
  cleanupConnection(connectionId) {
    const connSubs = this._byConnection.get(connectionId);
    if (!connSubs) return;
    for (const [subId] of connSubs) {
      this._removeSub(connectionId, subId, connSubs);
    }
    this._byConnection.delete(connectionId);
  }

  /**
   * Get all active subscriptions for a given scope.
   * @param {string} scope
   * @returns {object[]}
   */
  getSubscriptionsByScope(scope) {
    const scopeSet = this._byScope.get(scope);
    if (!scopeSet) return [];
    return [...scopeSet];
  }

  /**
   * Update lastDeliveredCursor for a subscription.
   */
  updateCursor(connectionId, subscriptionId, cursor) {
    const sub = this._getSub(connectionId, subscriptionId);
    if (!sub) return;
    sub.lastDeliveredCursor = cursor;
    sub.lastActivityAt      = Date.now();
  }

  /**
   * Total subscription count across all connections.
   */
  getTotalSubscriptions() {
    let total = 0;
    for (const connSubs of this._byConnection.values()) total += connSubs.size;
    return total;
  }

  /**
   * Number of active connections that have at least one subscription.
   */
  getConnectionCount() {
    return this._byConnection.size;
  }

  /**
   * Per-scope subscriber count: { scope: count }
   */
  getScopeCounts() {
    const counts = {};
    for (const [scope, set] of this._byScope) {
      counts[scope] = set.size;
    }
    return counts;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _getSub(connectionId, subscriptionId) {
    return this._byConnection.get(connectionId)?.get(subscriptionId) ?? null;
  }

  _removeSub(connectionId, subscriptionId, connSubs) {
    const sub = connSubs.get(subscriptionId);
    if (!sub) return false;
    connSubs.delete(subscriptionId);

    const scopeSet = this._byScope.get(sub.scope);
    if (scopeSet) {
      scopeSet.delete(sub);
      if (scopeSet.size === 0) this._byScope.delete(sub.scope);
    }
    return true;
  }
}

// Singleton shared by liveWsGateway and health endpoint
const registry = new WsSubscriptionRegistry();

module.exports = registry;
module.exports.WsSubscriptionRegistry = WsSubscriptionRegistry; // for unit tests
