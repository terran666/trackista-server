'use strict';
/**
 * livePollingMetrics.js — Runtime metrics for the live polling endpoints.
 *
 * Tracks request counts, latencies, no-change rates, and per-client rate detection.
 * Used by liveSnapshotRoute, liveDeltaRoute, and liveHealthRoute.
 *
 * Rate guard: detects clients polling faster than RATE_GUARD_MAX_REQS in
 * RATE_GUARD_WINDOW_MS — does NOT block requests, but sets tooFrequentPolling=true
 * so the response can carry a longer nextPollMs hint.
 */

const RATE_GUARD_WINDOW_MS = 10_000;   // 10 s sliding window per client
const RATE_GUARD_MAX_REQS  = 20;       // >20 requests/10 s = too frequent
const STATS_WINDOW_MS      = 60_000;   // 1-minute rolling window for RPS

class LivePollingMetrics {
  constructor() {
    // ── Counters ───────────────────────────────────────────────────────────
    this.snapshotRequests        = 0;
    this.deltaRequests           = 0;
    this.noChangeDeltaResponses  = 0;
    this.changedDeltaResponses   = 0;
    this.fullResyncCount         = 0;
    this.tooFrequentPollingCount = 0;

    // ── Latency accumulators ───────────────────────────────────────────────
    this._snapshotLatencySum   = 0;
    this._snapshotLatencyCount = 0;
    this._deltaLatencySum      = 0;
    this._deltaLatencyCount    = 0;

    // ── Delta payload size ─────────────────────────────────────────────────
    this._payloadSizeSum   = 0;
    this._payloadSizeCount = 0;

    // ── Per-scope counters  ────────────────────────────────────────────────
    this.scopeCounts = {};   // { screener: N, testpage: N, monitor: N }

    // ── Per-client rate-guard: Map<clientKey, timestamp[]> ────────────────
    this._clientRequests = new Map();

    // ── Sliding-window timestamp arrays for RPS calculation ───────────────
    this._snapshotTimes = [];
    this._deltaTimes    = [];

    // Periodic cleanup — detached from Node event loop (.unref)
    this._cleanupInterval = setInterval(() => this._cleanup(), 30_000).unref();
  }

  // ─── Record helpers ────────────────────────────────────────────────────────

  /**
   * Called by liveSnapshotRoute after each successful response.
   * @param {number} latencyMs
   * @param {string} scope
   */
  recordSnapshot(latencyMs, scope) {
    this.snapshotRequests++;
    this._snapshotLatencySum += latencyMs;
    this._snapshotLatencyCount++;
    this._snapshotTimes.push(Date.now());
    if (scope) this.scopeCounts[scope] = (this.scopeCounts[scope] || 0) + 1;
  }

  /**
   * Called by liveDeltaRoute after each response.
   * @param {object} opts
   * @param {number}  opts.latencyMs
   * @param {boolean} opts.changed      — true when changedCount>0
   * @param {number}  [opts.payloadBytes]
   * @param {boolean} opts.fullResync   — true when fullResyncRequired
   * @param {string}  opts.scope
   */
  recordDelta({ latencyMs, changed, payloadBytes, fullResync, scope }) {
    this.deltaRequests++;
    this._deltaLatencySum += latencyMs;
    this._deltaLatencyCount++;
    this._deltaTimes.push(Date.now());

    if (fullResync) {
      this.fullResyncCount++;
    } else if (changed) {
      this.changedDeltaResponses++;
    } else {
      this.noChangeDeltaResponses++;
    }

    if (payloadBytes != null) {
      this._payloadSizeSum += payloadBytes;
      this._payloadSizeCount++;
    }

    if (scope) this.scopeCounts[scope] = (this.scopeCounts[scope] || 0) + 1;
  }

  /**
   * Check whether this client is polling too frequently.
   * Records the request regardless — returns true if over the rate limit.
   *
   * @param {string} clientKey  — e.g. `${ip}:${scope}`
   * @returns {boolean}
   */
  checkRateGuard(clientKey) {
    const now    = Date.now();
    const cutoff = now - RATE_GUARD_WINDOW_MS;

    let times = this._clientRequests.get(clientKey);
    if (!times) {
      times = [];
      this._clientRequests.set(clientKey, times);
    }

    // Prune expired timestamps
    let start = 0;
    while (start < times.length && times[start] < cutoff) start++;
    if (start > 0) times.splice(0, start);

    times.push(now);

    if (times.length > RATE_GUARD_MAX_REQS) {
      this.tooFrequentPollingCount++;
      return true;
    }
    return false;
  }

  // ─── Stat readers ──────────────────────────────────────────────────────────

  getSnapshotRps() {
    const cutoff = Date.now() - STATS_WINDOW_MS;
    const recent = this._snapshotTimes.filter(t => t > cutoff);
    return parseFloat((recent.length / (STATS_WINDOW_MS / 1000)).toFixed(3));
  }

  getDeltaRps() {
    const cutoff = Date.now() - STATS_WINDOW_MS;
    const recent = this._deltaTimes.filter(t => t > cutoff);
    return parseFloat((recent.length / (STATS_WINDOW_MS / 1000)).toFixed(3));
  }

  getAvgSnapshotLatencyMs() {
    return this._snapshotLatencyCount > 0
      ? Math.round(this._snapshotLatencySum / this._snapshotLatencyCount)
      : null;
  }

  getAvgDeltaLatencyMs() {
    return this._deltaLatencyCount > 0
      ? Math.round(this._deltaLatencySum / this._deltaLatencyCount)
      : null;
  }

  getAvgPayloadSize() {
    return this._payloadSizeCount > 0
      ? Math.round(this._payloadSizeSum / this._payloadSizeCount)
      : null;
  }

  /** noChangeDeltaResponses / (changed + noChange) * 100, or null */
  getNoChangeRate() {
    const total = this.changedDeltaResponses + this.noChangeDeltaResponses;
    if (total === 0) return null;
    return parseFloat((this.noChangeDeltaResponses / total * 100).toFixed(1));
  }

  /** Top scopes ordered by request count — [ { scope, count } ] */
  getHotScopes(limit = 5) {
    return Object.entries(this.scopeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([scope, count]) => ({ scope, count }));
  }

  // ─── Health summary used by liveHealthRoute ────────────────────────────────

  /**
   * Build the full health payload.
   * @param {object|null} cacheStats  — from screenerAggregationService.getCacheStats()
   */
  getSummary(cacheStats) {
    return {
      ts                       : Date.now(),
      currentLiveCursor        : cacheStats?.ts         ?? null,
      deltaWindowSize          : 120_000,               // MAX_SINCE_AGE_MS in aggregation svc
      snapshotRps              : this.getSnapshotRps(),
      deltaRps                 : this.getDeltaRps(),
      snapshotRequests         : this.snapshotRequests,
      deltaRequests            : this.deltaRequests,
      noChangeRate             : this.getNoChangeRate(),
      noChangeDeltaResponses   : this.noChangeDeltaResponses,
      changedDeltaResponses    : this.changedDeltaResponses,
      avgDeltaLatencyMs        : this.getAvgDeltaLatencyMs(),
      avgSnapshotLatencyMs     : this.getAvgSnapshotLatencyMs(),
      avgDeltaPayloadSize      : this.getAvgPayloadSize(),
      tooFrequentPollingCount  : this.tooFrequentPollingCount,
      fullResyncCount          : this.fullResyncCount,
      trackedSymbolsCount      : cacheStats?.rowCount   ?? null,
      hotScopes                : this.getHotScopes(),
      cacheStats,
    };
  }

  // ─── Internal cleanup ──────────────────────────────────────────────────────

  _cleanup() {
    const now = Date.now();

    // Trim RPS sliding-window arrays
    while (this._snapshotTimes.length && this._snapshotTimes[0] < now - STATS_WINDOW_MS) {
      this._snapshotTimes.shift();
    }
    while (this._deltaTimes.length && this._deltaTimes[0] < now - STATS_WINDOW_MS) {
      this._deltaTimes.shift();
    }

    // Remove stale per-client rate-guard entries
    const cutoff = now - RATE_GUARD_WINDOW_MS;
    for (const [key, times] of this._clientRequests) {
      const fresh = times.filter(t => t > cutoff);
      if (fresh.length === 0) {
        this._clientRequests.delete(key);
      } else {
        this._clientRequests.set(key, fresh);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
  }
}

// Singleton — the same instance is shared by all route modules
const metrics = new LivePollingMetrics();
module.exports = metrics;
module.exports.LivePollingMetrics = LivePollingMetrics; // exported for unit tests
