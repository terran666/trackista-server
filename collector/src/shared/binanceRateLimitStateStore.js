'use strict';

// ─── Redis-backed shared mirror of Binance rate-limit state ──────────────────
//
// source-of-truth: in-memory _state (updated by orderbookCollector / futuresOrderbookCollector)
// mirror:          Redis key "debug:binance-rate-limit-state" (read by backend route)
//
// Callers:
//   init(redis)                            — store Redis ref, write initial clean state
//   patchMarketState(market, partial)      — merge partial into _state[market]
//   incSkipped(market)                     — increment skippedRequestsCount (no persist)
//   getMarketState(market)                 — read current in-memory market state
//   persist()                              — async: recompute dynamic fields, SET Redis key
//
// market = 'spot' | 'futures'
//

const REDIS_KEY = 'debug:binance-rate-limit-state';

let _redis = null;

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

const _state = {
  updatedAt: null,
  spot:      _defaultMarketState(),
  futures:   _defaultMarketState(),
};

function init(redis) {
  if (_redis) return; // singleton — only the first caller initialises
  _redis = redis;
  // Write initial clean state immediately so backend endpoint sees a valid key
  persist().catch(err =>
    console.error('[rate-limit-state] initial persist failed:', err.message),
  );
}

// Like init(), but also restores globalBackoff.until in each collector from Redis
// so that container restarts don't re-hit Binance while a ban is still active.
//
// backoffRefs = { spot: globalBackoffObj, futures: globalBackoffObj }
// Each value is the live { until: 0 } object the collector checks via isGloballyBanned().
async function initAndRestore(redis, backoffRefs) {
  const firstInit = !_redis;
  if (!_redis) _redis = redis;

  try {
    const raw = await redis.get(REDIS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const now   = Date.now();

      // Always restore the provided backoffRefs, even on subsequent calls.
      // Each collector module has its own globalBackoff object that must be
      // restored independently — without this, the second caller always loses.
      if (backoffRefs) {
        for (const market of ['spot', 'futures']) {
          if (!saved[market] || !backoffRefs[market]) continue;
          const savedUntil = saved[market].backoffUntilTs;
          if (savedUntil && savedUntil > now) {
            backoffRefs[market].until = savedUntil;
            console.log(
              `[rate-limit-state] restored ${market} ban: ${Math.ceil((savedUntil - now) / 1000)}s remaining — skipping Binance until ban expires`,
            );
          }
        }
      }

      // Merge state + persist only on first init to avoid double-write
      if (firstInit) {
        for (const market of ['spot', 'futures']) {
          if (!saved[market]) continue;
          Object.assign(_state[market], saved[market]);
        }
        _state.updatedAt = saved.updatedAt || now;
        console.log('[rate-limit-state] state restored from Redis');
        await persist();
      }
      return;
    }
  } catch (err) {
    console.error('[rate-limit-state] restore failed, starting clean:', err.message);
  }

  // No saved state — write initial clean baseline (first init only)
  if (firstInit) {
    persist().catch(err =>
      console.error('[rate-limit-state] initial persist failed:', err.message),
    );
  }
}

function patchMarketState(market, partial) {
  if (market !== 'spot' && market !== 'futures') return;
  Object.assign(_state[market], partial);
  _state.updatedAt = Date.now();
}

function incSkipped(market) {
  if (market !== 'spot' && market !== 'futures') return;
  _state[market].skippedRequestsCount = (_state[market].skippedRequestsCount || 0) + 1;
  _state.updatedAt = Date.now();
}

function getMarketState(market) {
  return _state[market];
}

// Recompute globalBackoffActive + backoffRemainingMs from backoffUntilTs at write time.
// The backend route also recomputes these on read, so the fields stay accurate even
// if the Redis write happened a while ago.
function _recomputeDynamic(now) {
  for (const market of ['spot', 'futures']) {
    const ms = _state[market];
    if (ms.backoffUntilTs !== null && ms.backoffUntilTs > now) {
      ms.globalBackoffActive = true;
      ms.backoffRemainingMs  = ms.backoffUntilTs - now;
    } else {
      ms.globalBackoffActive = false;
      ms.backoffRemainingMs  = 0;
    }
  }
}

async function persist() {
  if (!_redis) return;
  const now = Date.now();
  _recomputeDynamic(now);
  _state.updatedAt = now;
  try {
    await _redis.set(REDIS_KEY, JSON.stringify(_state));
    const spot    = _state.spot;
    const futures = _state.futures;
    console.log(
      `[rate-limit-state] persisted` +
      ` spot={backoffActive=${spot.globalBackoffActive} remainingMs=${spot.backoffRemainingMs}}` +
      ` futures={backoffActive=${futures.globalBackoffActive} remainingMs=${futures.backoffRemainingMs}}`,
    );
  } catch (err) {
    console.error('[rate-limit-state] Redis persist error:', err.message);
  }
}

module.exports = {
  init,
  initAndRestore,
  patchMarketState,
  incSkipped,
  getMarketState,
  persist,
  REDIS_KEY,
};
