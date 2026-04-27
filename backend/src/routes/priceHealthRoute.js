'use strict';

/**
 * priceHealthRoute.js
 * ─────────────────────────────────────────────────────────────────
 * GET /api/debug/price-health?market=futures|spot|all
 *
 * Scans metrics:* (futures) and spot:metrics:* (spot) from Redis,
 * checks existence of price:<SYMBOL> keys, and returns health status
 * for every known coin.
 *
 * Response:
 * {
 *   ts: <ms>,
 *   futures: [ { symbol, hasPrice, lastPrice, lastTradeTime, tradeAgeMs, isActive } ],
 *   spot:    [ ... ]
 * }
 *
 * Status logic (per-symbol):
 *   isActive  — hasPrice AND tradeAgeMs < 15 000
 *   isStale   — tradeAgeMs < 3 600 000  (< 1 hour)
 *   isDead    — tradeAgeMs >= 3 600 000
 */

const ACTIVE_THRESHOLD_MS = 15_000;       // < 15s  → active
const STALE_THRESHOLD_MS  = 3_600_000;    // < 1h   → stale, else dead
const MAX_SYMBOLS         = 2_000;        // safety cap per market

/**
 * Scan all keys matching `pattern`, return just the base symbol part.
 * E.g. "metrics:BTCUSDT" → "BTCUSDT", "spot:metrics:ETHUSDT" → "ETHUSDT"
 */
async function scanSymbols(redis, pattern, stripPrefix) {
  const symbols = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    for (const key of keys) {
      symbols.push(key.slice(stripPrefix.length));
      if (symbols.length >= MAX_SYMBOLS) { cursor = '0'; break; }
    }
  } while (cursor !== '0');
  return symbols;
}

/**
 * Fetch health data for a list of symbols using a single pipeline.
 * metricsKeyFn(sym) → Redis key for metrics JSON
 * priceKeyFn(sym)   → Redis key for price existence check
 */
async function fetchHealth(redis, symbols, metricsKeyFn, priceKeyFn) {
  if (symbols.length === 0) return [];

  const now = Date.now();
  const pipeline = redis.pipeline();

  for (const sym of symbols) {
    pipeline.get(metricsKeyFn(sym));    // index i*2
    pipeline.exists(priceKeyFn(sym));   // index i*2+1
  }

  const results = await pipeline.exec();
  const output = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const [metricsErr, metricsRaw] = results[i * 2];
    const [priceErr,   priceExists] = results[i * 2 + 1];

    let lastPrice     = null;
    let lastTradeTime = null;
    let hasMetrics    = false;

    if (!metricsErr && metricsRaw) {
      try {
        const m = JSON.parse(metricsRaw);
        lastPrice     = m.lastPrice   ?? null;
        // updatedAt is the closest we have to last trade time
        lastTradeTime = m.updatedAt   ?? null;
        hasMetrics    = true;
      } catch (_) {}
    }

    const hasPrice  = !priceErr && priceExists === 1;
    const tradeAgeMs = (lastTradeTime != null) ? (now - lastTradeTime) : null;
    const isActive   = hasPrice && tradeAgeMs != null && tradeAgeMs < ACTIVE_THRESHOLD_MS;

    output.push({
      symbol:        sym,
      hasPrice,
      hasMetrics,
      lastPrice,
      lastTradeTime,
      tradeAgeMs,
      isActive,
    });
  }

  // Sort: active first, then by tradeAgeMs ascending
  output.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const ageA = a.tradeAgeMs ?? Infinity;
    const ageB = b.tradeAgeMs ?? Infinity;
    return ageA - ageB;
  });

  return output;
}

function createPriceHealthRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const market = (req.query.market || 'all').toLowerCase();
      const ts     = Date.now();

      const [futuresSymbols, spotSymbols] = await Promise.all([
        (market === 'spot') ? [] : scanSymbols(redis, 'metrics:*',      'metrics:'),
        (market === 'futures') ? [] : scanSymbols(redis, 'spot:metrics:*', 'spot:metrics:'),
      ]);

      const [futuresData, spotData] = await Promise.all([
        fetchHealth(redis, futuresSymbols,
          sym => `metrics:${sym}`,
          sym => `price:${sym}`,
        ),
        fetchHealth(redis, spotSymbols,
          sym => `spot:metrics:${sym}`,
          sym => `price:${sym}`,
        ),
      ]);

      return res.json({ ts, futures: futuresData, spot: spotData });
    } catch (err) {
      console.error('[priceHealthRoute] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createPriceHealthRouter };
