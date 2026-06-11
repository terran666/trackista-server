'use strict';

/**
 * barsRoute — GET /api/bars/:symbol
 *
 * Returns 1-minute bars for a futures symbol.
 * Source priority: Redis Sorted Set (fast) → MySQL (fallback).
 *
 * Query params:
 *   interval  — currently only '1m' supported (default '1m')
 *   limit     — number of bars to return (default 30, max 5000)
 *   from      — optional start ts (unix ms, inclusive)
 *   to        — optional end ts (unix ms, inclusive)
 *   hints     — 1 to include axisHints block (day/month boundaries)
 *
 * Response always contains:
 *   timezone: "UTC", timeUnit: "ms", bars sorted ASC by ts
 */

const express = require('express');
const { safeSymbol } = require('../utils/parseClamp');

// ── QA: validate ts consistency, log warnings ─────────────────────
function validateBars(bars, symbol) {
  if (bars.length === 0) return;
  const warnings = [];

  // ts should be >978307200000 (Jan 1 2001 ms) — if smaller, likely seconds
  if (bars[0].ts < 978307200000) {
    warnings.push(`ts_looks_like_seconds: first=${bars[0].ts}`);
  }

  // Must be sorted ASC
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].ts < bars[i - 1].ts) {
      warnings.push(`not_sorted_asc at i=${i}: prev=${bars[i-1].ts} cur=${bars[i].ts}`);
      break;
    }
  }

  // No duplicates
  const seen = new Set();
  for (const b of bars) {
    if (seen.has(b.ts)) { warnings.push(`duplicate_ts: ${b.ts}`); break; }
    seen.add(b.ts);
  }

  // Interval consistency: for 1m, consecutive bars should differ by 60000ms
  // Allow gaps (missing bars) but flag unexpected negative deltas specifically
  if (bars.length >= 2) {
    let badDeltas = 0;
    for (let i = 1; i < bars.length; i++) {
      const diff = bars[i].ts - bars[i - 1].ts;
      if (diff <= 0 || diff % 60000 !== 0) badDeltas++;
    }
    if (badDeltas > 0) {
      warnings.push(`interval_inconsistent: ${badDeltas}/${bars.length - 1} gaps not multiple of 60000ms`);
    }
  }

  if (warnings.length) {
    console.warn(`[barsRoute] QA ${symbol}: ${warnings.join(' | ')}`);
  }
}

// ── Compute axis hints (day + month UTC boundaries within bar range) ─
const MONTHS_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_MS    = 86400000;

function computeAxisHints(bars) {
  if (bars.length === 0) return null;
  const firstTs = bars[0].ts;
  const lastTs  = bars[bars.length - 1].ts;

  const dayBoundaries   = [];
  const monthBoundaries = [];

  // Find first UTC midnight >= firstTs
  const startDay = Math.ceil(firstTs / DAY_MS) * DAY_MS;

  for (let ts = startDay; ts <= lastTs + DAY_MS; ts += DAY_MS) {
    const d   = new Date(ts);
    const day = d.getUTCDate();
    const mon = d.getUTCMonth(); // 0-based
    const yr  = d.getUTCFullYear();
    dayBoundaries.push({ ts, label: `${day} ${MONTHS_EN[mon]}` });
    if (day === 1) {
      monthBoundaries.push({ ts, label: `${MONTHS_EN[mon]} ${yr}` });
    }
  }

  return { dayBoundaries, monthBoundaries };
}

// ── Detect synthetic / zero-volume cross bars ────────────────────
// A bar where open===high===low===close and volumeUsdt===0 carries no
// real market information.  We flag it so callers can skip or mark it.
function isSyntheticBar(b) {
  const vol = b.volumeUsdt ?? b.volume ?? 0;
  if (Number(vol) !== 0) return false;
  const o = Number(b.open), h = Number(b.high), l = Number(b.low), c = Number(b.close);
  return o === h && h === l && l === c;
}

// ── Normalise bar array: sort ASC, deduplicate, tag synthetics ────
function normaliseBars(bars) {
  bars.sort((a, b) => a.ts - b.ts);
  // Remove duplicates (keep last written — higher index after sort)
  const seen = new Map();
  for (const b of bars) seen.set(b.ts, b);
  // Tag synthetic bars; real-time bars remain but frontend knows to skip them
  return [...seen.values()].map(b => isSyntheticBar(b) ? { ...b, synthetic: true } : b);
}

// ── Map MySQL snake_case columns → camelCase bar object ──────────
function rowToBar(row) {
  return {
    symbol          : row.symbol,
    ts              : Number(row.ts),
    market          : row.market,
    open            : Number(row.open),
    high            : Number(row.high),
    low             : Number(row.low),
    close           : Number(row.close),
    priceChangePct  : row.price_change_pct  != null ? Number(row.price_change_pct)  : null,
    volatility      : row.volatility        != null ? Number(row.volatility)        : null,
    volumeUsdt      : row.volume_usdt       != null ? Number(row.volume_usdt)       : null,
    buyVolumeUsdt   : row.buy_volume_usdt   != null ? Number(row.buy_volume_usdt)   : null,
    sellVolumeUsdt  : row.sell_volume_usdt  != null ? Number(row.sell_volume_usdt)  : null,
    deltaUsdt       : row.delta_usdt        != null ? Number(row.delta_usdt)        : null,
    tradeCount      : row.trade_count       != null ? Number(row.trade_count)       : null,
    volumeSpikeRatio: row.volume_spike_ratio!= null ? Number(row.volume_spike_ratio): null,
    fundingRate     : row.funding_rate      != null ? Number(row.funding_rate)      : null,
    oiValue         : row.oi_value          != null ? Number(row.oi_value)          : null,
    oiDelta         : row.oi_delta          != null ? Number(row.oi_delta)          : null,
    liqLongUsd      : row.liq_long_usd      != null ? Number(row.liq_long_usd)      : null,
    liqShortUsd     : row.liq_short_usd     != null ? Number(row.liq_short_usd)     : null,
    impulseScore    : row.impulse_score     != null ? Number(row.impulse_score)     : null,
    inPlayScore     : row.in_play_score     != null ? Number(row.in_play_score)     : null,
  };
}

function createBarsRouter(redis, db) {
  const router = express.Router();

  function tryParseMember(raw, sym) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[barsRoute] JSON.parse failed for bars:1m:${sym} member:`, e.message);
      return null;
    }
  }

  // Build the standard success response
  function buildResponse(source, symbol, bars, includeHints) {
    const resp = {
      success  : true,
      symbol,
      market   : 'futures',
      interval : '1m',
      timezone : 'UTC',
      timeUnit : 'ms',
      count    : bars.length,
      source,
      bars,
    };
    if (includeHints) {
      resp.axisHints = computeAxisHints(bars);
    }
    return resp;
  }

  // GET /api/bars/:symbol
  router.get('/:symbol', async (req, res) => {
    const symbol   = safeSymbol(req.params.symbol);
    if (!symbol) {
      return res.status(400).json({ success: false, error: "Invalid 'symbol' parameter" });
    }
    const interval = (req.query.interval || '1m').toLowerCase();

    // ── Validate & coerce params ──────────────────────────────────
    const rawLimit = parseInt(req.query.limit || '30', 10);
    if (isNaN(rawLimit)) {
      return res.status(400).json({ success: false, error: "Invalid 'limit' parameter" });
    }
    const limit = Math.min(Math.max(1, rawLimit), 5000);

    const fromTs = req.query.from != null ? parseInt(req.query.from, 10) : null;
    const toTs   = req.query.to   != null ? parseInt(req.query.to,   10) : null;

    if (fromTs !== null && isNaN(fromTs)) {
      return res.status(400).json({ success: false, error: "Invalid 'from' parameter" });
    }
    if (toTs !== null && isNaN(toTs)) {
      return res.status(400).json({ success: false, error: "Invalid 'to' parameter" });
    }
    if (interval !== '1m') {
      return res.status(400).json({
        success: false,
        error  : `Unsupported interval '${interval}'. Only '1m' is supported.`,
      });
    }

    const includeHints = req.query.hints === '1';
    const ctx = { symbol, interval, limit, fromTs, toTs };

    // ── Redis fast path ─────────────────────────────────────────
    let bars = null;
    try {
      const redisKey = `bars:1m:${symbol}`;
      let raw;
      if (fromTs != null && toTs != null) {
        raw = await redis.zrangebyscore(redisKey, fromTs, toTs, 'LIMIT', 0, limit);
      } else {
        raw = await redis.zrange(redisKey, -limit, -1);
      }
      if (Array.isArray(raw) && raw.length > 0) {
        bars = raw.map(r => tryParseMember(r, symbol)).filter(Boolean);
      }
    } catch (redisErr) {
      console.warn(`[barsRoute] redis read failed for ${symbol}:`, redisErr.message);
    }

    if (bars && bars.length > 0) {
      bars = normaliseBars(bars);
      validateBars(bars, symbol);
      return res.json(buildResponse('redis', symbol, bars, includeHints));
    }

    // ── MySQL fallback ──────────────────────────────────────────
    if (!db) {
      return res.json(buildResponse('none', symbol, [], includeHints));
    }

    try {
      let rows;
      const safeLimit = limit;

      if (fromTs != null && toTs != null) {
        [rows] = await db.execute(
          `SELECT * FROM symbol_bars_1m
           WHERE symbol = ? AND market = 'futures' AND ts >= ? AND ts <= ?
           ORDER BY ts ASC LIMIT ${safeLimit}`,
          [symbol, fromTs, toTs],
        );
      } else {
        let rawRows;
        [rawRows] = await db.execute(
          `SELECT * FROM symbol_bars_1m
           WHERE symbol = ? AND market = 'futures'
           ORDER BY ts DESC LIMIT ${safeLimit}`,
          [symbol],
        );
        rows = Array.isArray(rawRows) ? rawRows.slice().reverse() : [];
      }

      let mappedBars = Array.isArray(rows) ? rows.map(rowToBar) : [];
      mappedBars = normaliseBars(mappedBars);
      validateBars(mappedBars, symbol);
      return res.json(buildResponse('mysql', symbol, mappedBars, includeHints));

    } catch (mysqlErr) {
      console.error(`[barsRoute] mysql fallback failed`, ctx, mysqlErr.message);
      // Don't leak DB error text to clients \u2014 it can expose schema details
      // and connection state. Operators see the full message in the log above.
      return res.status(500).json({
        success: false,
        error  : 'bars_route_failed',
        stage  : 'mysql_fallback',
        message: 'Internal server error',
      });
    }
  });

  return router;
}

// ── Debug router: GET /api/debug/bars/:symbol/:timeframe ──────────
//
// Returns a quality report for the bars stored in Redis (and MySQL count).
// Supports any timeframe token but only "1m" currently has data in Redis.
// Example: GET /api/debug/bars/ETHUSDT/1m
function createDebugBarsRouter(redis, db) {
  const router = express.Router();

  router.get('/:symbol/:timeframe', async (req, res) => {
    const symbol    = safeSymbol(req.params.symbol);
    const timeframe = (req.params.timeframe || '1m').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!symbol) {
      return res.status(400).json({ success: false, error: "Invalid 'symbol' parameter" });
    }

    // Build the Redis key — currently only 1m is supported by the aggregator
    const redisKey = timeframe === '1m' ? `bars:1m:${symbol}` : `bars:${timeframe}:${symbol}`;

    let bars = [];
    let redisErr = null;
    try {
      const raw = await redis.zrange(redisKey, 0, -1, 'WITHSCORES');
      // WITHSCORES returns [member, score, member, score, …]
      for (let i = 0; i < raw.length; i += 2) {
        try { bars.push(JSON.parse(raw[i])); } catch (_) { /* ignore corrupt member */ }
      }
    } catch (e) {
      redisErr = e.message;
    }

    // Sort and deduplicate
    bars.sort((a, b) => a.ts - b.ts);
    const seen       = new Map();
    let duplicates   = 0;
    for (const b of bars) {
      if (seen.has(b.ts)) duplicates++;
      seen.set(b.ts, b);
    }
    const unique = [...seen.values()];

    // Gap analysis (for 1m bars we expect 60000 ms steps; allow gaps but report them)
    const expectedStep = timeframe === '1m' ? 60_000 : null;
    const gaps = [];
    if (expectedStep && unique.length >= 2) {
      for (let i = 1; i < unique.length; i++) {
        const diff = unique[i].ts - unique[i - 1].ts;
        if (diff !== expectedStep) {
          gaps.push({
            after : unique[i - 1].ts,
            before: unique[i].ts,
            gapMs : diff,
            missing: Math.round(diff / expectedStep) - 1,
          });
        }
      }
    }

    // Synthetic / zero-volume bar count
    let zeroVolumeBars = 0;
    let syntheticBars  = 0;
    for (const b of unique) {
      const vol = Number(b.volumeUsdt ?? b.volume ?? 0);
      if (vol === 0) zeroVolumeBars++;
      if (isSyntheticBar(b)) syntheticBars++;
    }

    // MySQL bar count for reference
    let mysqlCount = null;
    if (db) {
      try {
        const [[row]] = await db.execute(
          `SELECT COUNT(*) AS cnt FROM symbol_bars_1m WHERE symbol = ? AND market = 'futures'`,
          [symbol],
        );
        mysqlCount = Number(row?.cnt ?? 0);
      } catch (_) { /* non-fatal */ }
    }

    return res.json({
      symbol,
      timeframe,
      redisKey,
      count          : unique.length,
      duplicates,
      gaps           : gaps.slice(0, 50),          // cap response size
      gapCount       : gaps.length,
      zeroVolumeBars,
      syntheticBars,
      firstTimestamp : unique[0]?.ts   ?? null,
      lastTimestamp  : unique.at(-1)?.ts ?? null,
      mysqlCount,
      ...(redisErr ? { redisError: redisErr } : {}),
    });
  });

  return router;
}

module.exports = { createBarsRouter, createDebugBarsRouter };
