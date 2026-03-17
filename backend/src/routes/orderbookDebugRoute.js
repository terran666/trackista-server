'use strict';

// ─── GET /api/orderbook/debug-compare ────────────────────────────
//
// DEBUG ONLY — compares the local Trackista orderbook (Redis)
// against a fresh Binance REST snapshot.
//
// Query params:
//   symbol  (required)   e.g. SOLUSDT
//   levels  (optional)   how many top levels to compare, default 20, max 50
//
// Response 200:
// {
//   symbol:             string,
//   marketType:         "spot",
//   levels:             number,
//   trackistaUpdatedAt: number (ms),
//   binanceSnapshotId:  number,
//   binanceFetchedAt:   number (ms),
//   staleness:          number (ms difference between Trackista updatedAt and fetch time),
//   totalChecked:       number,
//   matches:            number,
//   mismatches: [
//     {
//       side:             "bid" | "ask",
//       rank:             number,          // 0-based position in sorted list
//       price:            number,
//       trackistaSize:    number | null,   // null if level missing locally
//       binanceSize:      number | null,   // null if level missing on Binance
//       trackistaUsd:     number | null,
//       binanceUsd:       number | null,
//       sizeDelta:        number | null,   // trackistaSize - binanceSize
//       sizeDeltaPct:     number | null,   // % deviation from Binance
//     }
//   ],
//   summary: string   // human-readable verdict
// }
//
// A "match" means the price level exists on both sides and size is within
// MATCH_TOLERANCE_PCT of each other (default 0.5% — allows for normal
// order-fill updates between fetch and snapshot timestamps).
//
const { binanceFetch } = require('../utils/binanceRestLogger');
const BINANCE_SPOT_REST    = 'https://api.binance.com';
const BINANCE_FUTURES_REST = 'https://fapi.binance.com';
const BINANCE_DEPTH_LIMIT  = 1000;
const MATCH_TOLERANCE_PCT  = 0.5;  // sizes within 0.5% are considered matching
const MAX_LEVELS_PARAM     = 50;

// ─── Rate limit: debug-compare is a MANUAL debug tool ────────────────────
// Each call triggers a live Binance REST /depth fetch.
// Never poll this from production UI code.
const DEBUG_COOLDOWN_MS = 60_000; // 60s between calls per symbol+marketType
const lastDebugCallTs   = new Map(); // key: `${symbol}:${marketType}`

function createOrderbookDebugHandler(redis) {
  return async function orderbookDebugHandler(req, res) {
    // ── validate params ───────────────────────────────────────────
    const symbol     = (req.query.symbol     || '').toUpperCase().trim();
    const marketType = (req.query.marketType || 'spot').toLowerCase();
    if (!symbol) {
      return res.status(400).json({
        success: false,
        error:   'Query param "symbol" is required (e.g. ?symbol=SOLUSDT)',
      });
    }
    // Reject unexpected characters to prevent injection via symbol param
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format' });
    }
    if (marketType !== 'spot' && marketType !== 'futures') {
      return res.status(400).json({ success: false, error: 'marketType must be "spot" or "futures"' });
    }

    // ── Rate limit guard ─────────────────────────────────────────
    const cooldownKey = `${symbol}:${marketType}`;
    const lastCall    = lastDebugCallTs.get(cooldownKey) || 0;
    const msSinceLast = Date.now() - lastCall;
    if (msSinceLast < DEBUG_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((DEBUG_COOLDOWN_MS - msSinceLast) / 1000);
      console.warn(
        `[orderbook/debug-compare] rate limited: ${symbol} ${marketType}` +
        ` — retry in ${retryAfterSec}s`,
      );
      return res.status(429).json({
        success: false,
        error:   `debug-compare rate limited — this endpoint makes a live Binance REST call. Wait ${retryAfterSec}s.`,
        symbol,
        marketType,
        retryAfterSec,
      });
    }
    lastDebugCallTs.set(cooldownKey, Date.now());
    console.warn(
      `[orderbook/debug-compare] LIVE BINANCE REST CALL: symbol=${symbol} marketType=${marketType}` +
      ` — manual debug tool, do not call from production UI`,
    );

    const levels = Math.min(
      parseInt(req.query.levels, 10) || 20,
      MAX_LEVELS_PARAM,
    );

    // ── read local Trackista state from Redis ─────────────────────
    const redisKey = marketType === 'futures'
      ? `futures:orderbook:${symbol}`
      : `orderbook:${symbol}`;

    const raw = await redis.get(redisKey).catch(() => null);
    if (!raw) {
      return res.status(404).json({
        success: false,
        error:   `Orderbook not found in Redis — ${marketType} symbol not tracked or collector still syncing`,
        symbol,
        marketType,
      });
    }

    let local;
    try {
      local = JSON.parse(raw);
    } catch {
      return res.status(500).json({ success: false, error: 'Corrupt Redis orderbook data' });
    }

    // ── fetch fresh Binance snapshot ──────────────────────────────
    let binance;
    const binanceFetchedAt = Date.now();
    try {
      const base = marketType === 'futures' ? BINANCE_FUTURES_REST : BINANCE_SPOT_REST;
      const path = marketType === 'futures'
        ? `/fapi/v1/depth?symbol=${symbol}&limit=${BINANCE_DEPTH_LIMIT}`
        : `/api/v3/depth?symbol=${symbol}&limit=${BINANCE_DEPTH_LIMIT}`;
      const resp = await binanceFetch(`${base}${path}`, undefined, 'orderbookDebugRoute', symbol, 'debug-compare');
      if (!resp.ok) throw new Error(`Binance HTTP ${resp.status}`);
      binance = await resp.json();
    } catch (err) {
      if (err.status === 418 || err.message.includes('IP ban')) {
        const retryAfterSec = Math.ceil((err.retryAfterMs || 60000) / 1000);
        return res.status(503).json({
          success: false,
          error:   `Binance IP ban active — retry in ${retryAfterSec}s`,
          retryAfterSec,
        });
      }
      return res.status(502).json({
        success: false,
        error:   `Failed to fetch Binance ${marketType} snapshot: ${err.message}`,
      });
    }

    // ── build lookup maps for Binance (price → size) ──────────────
    const binanceBids = new Map();
    for (const [p, s] of binance.bids) {
      const sz = parseFloat(s);
      if (sz > 0) binanceBids.set(parseFloat(p), sz);
    }
    const binanceAsks = new Map();
    for (const [p, s] of binance.asks) {
      const sz = parseFloat(s);
      if (sz > 0) binanceAsks.set(parseFloat(p), sz);
    }

    // ── compare top N levels ──────────────────────────────────────
    let matches    = 0;
    let totalChecked = 0;
    const mismatches = [];

    function compareLevel(side, rank, localLevel, binanceMap) {
      totalChecked++;
      const price       = localLevel.price;
      const localSize   = localLevel.size;
      const binanceSize = binanceMap.get(price) ?? null;

      if (binanceSize === null) {
        // Level present in Trackista but missing from Binance snapshot
        mismatches.push({
          side,
          rank,
          price,
          trackistaSize: localSize,
          binanceSize:   null,
          trackistaUsd:  localLevel.usdValue,
          binanceUsd:    null,
          sizeDelta:     null,
          sizeDeltaPct:  null,
          note:          'level_missing_on_binance',
        });
        return;
      }

      const delta    = localSize - binanceSize;
      const deltaPct = parseFloat(((Math.abs(delta) / binanceSize) * 100).toFixed(4));

      if (deltaPct <= MATCH_TOLERANCE_PCT) {
        matches++;
      } else {
        mismatches.push({
          side,
          rank,
          price,
          trackistaSize: localSize,
          binanceSize,
          trackistaUsd:  localLevel.usdValue,
          binanceUsd:    parseFloat((price * binanceSize).toFixed(2)),
          sizeDelta:     parseFloat(delta.toFixed(8)),
          sizeDeltaPct:  deltaPct,
          note:          'size_mismatch',
        });
      }
    }

    const topBids = (local.bids || []).slice(0, levels);
    const topAsks = (local.asks || []).slice(0, levels);

    topBids.forEach((level, i) => compareLevel('bid', i, level, binanceBids));
    topAsks.forEach((level, i) => compareLevel('ask', i, level, binanceAsks));

    const staleness  = binanceFetchedAt - (local.updatedAt || 0);
    const mismatchPct = totalChecked > 0
      ? parseFloat(((mismatches.length / totalChecked) * 100).toFixed(1))
      : 0;

    let summary;
    if (mismatches.length === 0) {
      summary = `PERFECT MATCH — all ${totalChecked} levels identical (within ${MATCH_TOLERANCE_PCT}%)`;
    } else if (mismatchPct <= 5) {
      summary = `GOOD — ${matches}/${totalChecked} match (${mismatchPct}% deviation, likely due to ${staleness}ms staleness)`;
    } else if (mismatchPct <= 20) {
      summary = `PARTIAL — ${matches}/${totalChecked} match (${mismatchPct}% deviation) — possible sync lag`;
    } else {
      summary = `OUT OF SYNC — ${mismatches.length}/${totalChecked} mismatched — collector may need resync`;
    }

    console.log(
      `[orderbook/debug-compare] ${symbol} (${marketType}): ${summary}` +
      ` staleness=${staleness}ms levels=${levels}`,
    );

    return res.json({
      success:            true,
      symbol,
      marketType,
      ladderMode:         'raw',
      levels,
      comparedLevels:     { bids: topBids.length, asks: topAsks.length },
      matchTolerancePct:  MATCH_TOLERANCE_PCT,
      trackistaUpdatedAt: local.updatedAt,
      trackistaUpdatedAtIso: local.updatedAt ? new Date(local.updatedAt).toISOString() : null,
      binanceSnapshotId:  binance.lastUpdateId,
      binanceFetchedAt,
      binanceFetchedAtIso: new Date(binanceFetchedAt).toISOString(),
      staleness,
      totalChecked,
      matches,
      mismatches,
      summary,
    });
  };
}

module.exports = { createOrderbookDebugHandler };
