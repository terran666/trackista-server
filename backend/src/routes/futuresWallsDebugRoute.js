'use strict';

// ─── GET /api/futures-walls-debug ─────────────────────────────────
//
// Debug endpoint for inspecting futures wall lifecycle state.
//
// Query params:
//   symbol  (required)  e.g. BTCUSDT
//
// Response 200:
// {
//   "success":      true,
//   "symbol":       "BTCUSDT",
//   "now":          <ms>,
//   "syncStatus":   { synced, snapshotFetchCount, resyncCount, consecutiveErrors, rateLimitCount, inBackoff, lastResyncAt },
//   "wsConnected":  true,
//   "lastSnapshotTs": <ms|null>,
//   "safeModeActive": false,
//   "rateLimitState": { ... },
//   "wallThreshold":   400000,
//   "candidates":  [ { side, price, status, firstSeenTs, lastSeenTs, lifetimeMs, accPresenceMs, ... } ],
//   "confirmed":   [ ... ],
//   "droppedRecently": [ ... ],
//   "midPrice":    <number|null>,
//   "minVisibleLifetimeMs": 60000,
//   "scanIntervalMs": 2000
// }
//
// The internal state is read from futures:walls:internal:${symbol} (written by collector
// every flush cycle with a 5-minute TTL).  Rate-limit state is read from the shared
// debug:binance-rate-limit-state key.

function createFuturesWallsDebugHandler(redis) {
  return async function futuresWallsDebugHandler(req, res) {
    const symbol = (req.query.symbol || '').toUpperCase().trim();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=BTCUSDT)',
      });
    }

    try {
      const [rawInternal, rawOb, rawRateLimitState, rawSafeMode] = await Promise.all([
        redis.get(`futures:walls:internal:${symbol}`),
        redis.get(`futures:orderbook:${symbol}`),
        redis.get('debug:binance-rate-limit-state'),
        redis.get('density:futures:safe-mode'),
      ]);

      const now         = Date.now();
      const internal    = rawInternal ? tryParse(rawInternal) : null;
      const ob          = rawOb       ? tryParse(rawOb)       : null;
      const rlState     = rawRateLimitState ? tryParse(rawRateLimitState) : null;
      const safeModeActive = rawSafeMode === '1';

      const midPrice = ob?.midPrice ?? null;

      // Derive sync status from the orderbook data and the internal wall doc
      const collectorActive = ob !== null;
      const obUpdatedAt     = ob?.updatedAt ?? null;

      const candidates  = internal?.candidates       ?? [];
      const dropped     = internal?.droppedRecent    ?? [];
      const confirmed   = candidates.filter(c => c.status === 'confirmed');
      const pending     = candidates.filter(c => c.status === 'candidate');

      // Enrich confirmed list with computed lifetimeMs relative to now
      const enriched = candidates.map(c => ({
        ...c,
        lifetimeMs: now - (c.firstSeenTs || now),
      }));

      console.log(
        `[futures-walls-debug] GET /api/futures-walls-debug symbol=${symbol}` +
        ` candidates=${candidates.length} confirmed=${confirmed.length}`,
      );

      return res.json({
        success:              true,
        symbol,
        now,
        safeModeActive,
        collectorActive,
        midPrice,
        obUpdatedAt,
        wallThreshold:        rlState?.futures?.wallThreshold ?? null,
        rateLimitState:       rlState?.futures ?? null,
        candidates:           enriched,
        confirmedCount:       confirmed.length,
        candidateCount:       pending.length,
        droppedRecently:      dropped,
        minVisibleLifetimeMs: 60000,
        scanIntervalMs:       2000,
      });

    } catch (err) {
      console.error('[futures-walls-debug] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

function tryParse(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

module.exports = { createFuturesWallsDebugHandler };
