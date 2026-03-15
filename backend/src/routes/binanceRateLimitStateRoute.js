'use strict';

// ─── GET /api/binance-rate-limit-state ───────────────────────────────────────
//
// Reads the shared rate-limit mirror written by the collector into Redis and
// returns a normalised, up-to-date view.
//
// Does NOT make any external calls. Redis-read + local normalisation only.
//

const REDIS_KEY = 'debug:binance-rate-limit-state';

function _defaultMarketState() {
  return {
    globalBackoffActive:   false,
    backoffUntilTs:        null,
    backoffRemainingMs:    0,
    last418Ts:             null,
    last429Ts:             null,
    lastRateLimitStatus:   null,
    backoffDurationMs:     0,
    lastBackoffSetTs:      null,
    lastBackoffReason:     null,
    lastRateLimitedSymbol: null,
    skippedRequestsCount:  0,
    rateLimitCount:        0,
    lastSuccessTs:         null,
  };
}

// Merge raw Redis payload for one market with defaults, then recompute
// backoffRemainingMs / globalBackoffActive against current `now` so the
// caller always sees fresh values regardless of when the collector last wrote.
function _normalizeMarket(raw, now) {
  const ms = Object.assign(_defaultMarketState(), typeof raw === 'object' && raw !== null ? raw : {});
  if (ms.backoffUntilTs !== null && ms.backoffUntilTs > now) {
    ms.globalBackoffActive = true;
    ms.backoffRemainingMs  = ms.backoffUntilTs - now;
  } else {
    ms.globalBackoffActive = false;
    ms.backoffRemainingMs  = 0;
  }
  return ms;
}

function createBinanceRateLimitStateHandler(redis) {
  return async function handler(_req, res) {
    const now = Date.now();
    try {
      const raw = await redis.get(REDIS_KEY);

      if (!raw) {
        // Collector not yet started or hasn't written state — return clean defaults
        return res.json({
          success:   true,
          now,
          updatedAt: null,
          spot:      _normalizeMarket(null, now),
          futures:   _normalizeMarket(null, now),
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = {};
      }

      return res.json({
        success:   true,
        now,
        updatedAt: parsed.updatedAt || null,
        spot:      _normalizeMarket(parsed.spot,    now),
        futures:   _normalizeMarket(parsed.futures, now),
      });
    } catch (err) {
      console.error('[backend] /api/binance-rate-limit-state error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createBinanceRateLimitStateHandler };
