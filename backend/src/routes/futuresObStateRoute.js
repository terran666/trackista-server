'use strict';

// ─── GET /api/futures-ob/state ────────────────────────────────────────────────
//
// Returns the latest debug snapshot written by the futures orderbook collector
// into Redis every 30s (key: debug:futures-ob-state).
//
// Includes:
//   config          — active env-based limits
//   globalBackoff   — current IP-ban state
//   queue           — activeResyncs / queuedResyncs
//   metrics         — counters (gaps, resyncs, failures, snapshots, quarantines…)
//   symbols.active  — per-symbol health stats
//   symbols.quarantined — quarantined symbols with remaining duration
//

const REDIS_KEY = 'debug:futures-ob-state';

function createFuturesObStateHandler(redis) {
  return async function handler(_req, res) {
    try {
      const raw = await redis.get(REDIS_KEY);
      if (!raw) {
        return res.json({
          success:   true,
          available: false,
          message:   'Futures OB collector has not written state yet — may still be starting up',
          now:       Date.now(),
        });
      }

      const state = JSON.parse(raw);
      return res.json({
        success:   true,
        available: true,
        now:       Date.now(),
        ...state,
      });
    } catch (err) {
      console.error('[backend] /api/futures-ob/state error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createFuturesObStateHandler };
