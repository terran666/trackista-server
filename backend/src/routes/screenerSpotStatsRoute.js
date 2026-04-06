'use strict';

/**
 * screenerSpotStatsRoute.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/screener/spot-stats
 *
 * Returns live screener rows for spot market symbols.
 * Closes the frontend→Binance direct call for spot screener use-case.
 *
 * Data sources (all Redis, no Binance REST on request path):
 *   spot:symbols:active:usdt     — active spot symbol list (written by collector)
 *   spot:metrics:{SYM}           — live 60s metrics (same schema as futures metrics:{SYM})
 *   spot:signal:{SYM}            — live 60s signal  (same schema as futures signal:{SYM})
 *
 * Response shape is aligned with /api/screener/snapshot rows (ScreenerRowDTO),
 * omitting futures-only fields (fundingRate, oiValue, oiDelta, move events).
 *
 * Query params (all optional, AND-logic):
 *   sortBy        priceChange|volume|trades|spike|impulse|inPlay|vol24h
 *   sortDir       desc|asc
 *   limit         1–500  (default 200)
 *   priceDir      up|down|any
 *   priceMinPct   number
 *   priceMaxPct   number
 *   tradesMin     number
 *   turnoverMin   number  (min volumeUsdt60s)
 *   minImpulse    number
 *   minInPlay     number
 *   symbolSearch  string  (substring match)
 *
 * Response:
 * {
 *   ts           : number,
 *   market       : "spot",
 *   count        : N,
 *   totalScanned : N,
 *   totalMatched : N,
 *   pipelineMs   : number,
 *   rows         : SpotScreenerRow[]
 * }
 *
 * SpotScreenerRow fields:
 *   symbol, market, lastPrice, priceChangePct, priceChangePctWindow ("60s"),
 *   volumeUsdt60s, tradeCount60s, buyVolumeUsdt60s, sellVolumeUsdt60s,
 *   deltaUsdt60s, volumeSpikeRatio60s, impulseScore, impulseDirection,
 *   inPlayScore, tradeAcceleration, deltaImbalancePct60s,
 *   hasMetrics, hasSignal, dataStatus, freshnessMs, updatedAt
 */

const MAX_LIMIT  = 500;
const STALE_MS   = 5 * 60 * 1000;

const SORT_FIELDS = {
  priceChange : r => Math.abs(r.priceChangePct),
  volume      : r => r.volumeUsdt60s,
  trades      : r => r.tradeCount60s,
  spike       : r => r.volumeSpikeRatio60s,
  impulse     : r => r.impulseScore,
  inPlay      : r => r.inPlayScore,
  freshness   : r => r.updatedAt,
};

function tryParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function nf(v, d = null) {
  if (v == null) return null;
  const f = parseFloat(v);
  if (!isFinite(f)) return null;
  return d != null ? parseFloat(f.toFixed(d)) : f;
}

function createScreenerSpotStatsRouter(redis) {
  const express = require('express');
  const router  = express.Router();

  router.get('/', async (req, res) => {
    try {
      const t0  = Date.now();
      const q   = req.query;

      const sortBy   = q.sortBy  || 'priceChange';
      const sortDir  = q.sortDir || 'desc';
      const limitNum = Math.min(parseInt(q.limit, 10) || 200, MAX_LIMIT);

      // ── Filters ────────────────────────────────────────────────
      const priceDir      = q.priceDir     || 'any';
      const priceMinPct   = q.priceMinPct  != null ? parseFloat(q.priceMinPct)  : null;
      const priceMaxPct   = q.priceMaxPct  != null ? parseFloat(q.priceMaxPct)  : null;
      const tradesMin     = q.tradesMin    != null ? parseInt(q.tradesMin, 10)  : null;
      const turnoverMin   = q.turnoverMin  != null ? parseFloat(q.turnoverMin)  : null;
      const minImpulse    = q.minImpulse   != null ? parseFloat(q.minImpulse)   : null;
      const minInPlay     = q.minInPlay    != null ? parseFloat(q.minInPlay)    : null;
      const symbolSearch  = q.symbolSearch ? q.symbolSearch.toUpperCase()       : null;

      // ── Symbol list ────────────────────────────────────────────
      const symbolsRaw = await redis.get('spot:symbols:active:usdt');
      if (!symbolsRaw) {
        return res.json({ ts: Date.now(), market: 'spot', count: 0, totalScanned: 0, totalMatched: 0, pipelineMs: 0, rows: [] });
      }
      const symbols = tryParse(symbolsRaw) || [];
      if (!symbols.length) {
        return res.json({ ts: Date.now(), market: 'spot', count: 0, totalScanned: 0, totalMatched: 0, pipelineMs: 0, rows: [] });
      }

      // ── Batch read: 2 keys per symbol ─────────────────────────
      const pipe = redis.pipeline();
      for (const sym of symbols) {
        pipe.get(`spot:metrics:${sym}`);  // i*2 + 0
        pipe.get(`spot:signal:${sym}`);   // i*2 + 1
      }
      const raw       = await pipe.exec();
      const pipelineMs = Date.now() - t0;

      const nowMs = Date.now();
      const rows  = [];

      for (let i = 0; i < symbols.length; i++) {
        const sym     = symbols[i];
        const metrics = tryParse(raw[i * 2    ]?.[1]);
        if (!metrics) continue; // no live data

        const signal  = tryParse(raw[i * 2 + 1]?.[1]);

        const pricePct = nf(metrics.priceChangePct60s, 4) ?? 0;
        const absPct   = Math.abs(pricePct);
        const vol60s   = nf(metrics.volumeUsdt60s)    ?? 0;
        const tr60s    = nf(metrics.tradeCount60s)    ?? 0;
        const spike    = nf(signal?.volumeSpikeRatio60s, 3) ?? 0;
        const impulse  = nf(signal?.impulseScore, 1)  ?? 0;
        const inPlay   = nf(signal?.inPlayScore, 1)   ?? 0;

        // Filters
        if (priceDir === 'up'   && pricePct <= 0) continue;
        if (priceDir === 'down' && pricePct >= 0) continue;
        if (priceMinPct  !== null && absPct < priceMinPct)  continue;
        if (priceMaxPct  !== null && absPct > priceMaxPct)  continue;
        if (tradesMin    !== null && tr60s  < tradesMin)    continue;
        if (turnoverMin  !== null && vol60s < turnoverMin)  continue;
        if (minImpulse   !== null && impulse < minImpulse)  continue;
        if (minInPlay    !== null && inPlay  < minInPlay)   continue;
        if (symbolSearch && !sym.includes(symbolSearch))   continue;

        const freshnessMs = metrics.updatedAt != null ? (nowMs - metrics.updatedAt) : null;

        rows.push({
          symbol               : sym,
          market               : 'spot',
          lastPrice            : nf(metrics.lastPrice) ?? 0,
          priceChangePct       : pricePct,
          priceChangePctWindow : '60s',
          volumeUsdt60s        : vol60s,
          tradeCount60s        : tr60s,
          buyVolumeUsdt60s     : nf(metrics.buyVolumeUsdt60s)   ?? 0,
          sellVolumeUsdt60s    : nf(metrics.sellVolumeUsdt60s)  ?? 0,
          deltaUsdt60s         : nf(metrics.deltaUsdt60s)       ?? 0,
          volumeSpikeRatio60s  : spike,
          impulseScore         : impulse,
          impulseDirection     : signal?.impulseDirection       ?? 'neutral',
          inPlayScore          : inPlay,
          tradeAcceleration    : nf(signal?.tradeAcceleration, 3)       ?? null,
          deltaImbalancePct60s : nf(signal?.deltaImbalancePct60s, 3)    ?? null,
          volumeSpikeRatio15s  : nf(signal?.volumeSpikeRatio15s, 3)     ?? null,
          // Spot has no derivatives
          fundingRate          : null,
          oiValue              : null,
          oiDelta              : null,
          moveEventState       : null,
          currentMovePct       : null,
          hasMetrics           : true,
          hasSignal            : signal != null,
          dataStatus           : signal == null ? 'warning' : 'ok',
          freshnessMs,
          updatedAt            : metrics.updatedAt ?? nowMs,
        });
      }

      // Sort
      const sortFn = SORT_FIELDS[sortBy] || SORT_FIELDS.priceChange;
      const mult   = sortDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => mult * (sortFn(a) - sortFn(b)));

      const totalMatched = rows.length;

      return res.json({
        ts           : nowMs,
        market       : 'spot',
        count        : Math.min(totalMatched, limitNum),
        totalScanned : symbols.length,
        totalMatched,
        pipelineMs,
        rows         : rows.slice(0, limitNum),
      });
    } catch (err) {
      console.error('[screenerSpotStats] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createScreenerSpotStatsRouter };
