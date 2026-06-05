'use strict';

/**
 * verticalExtremesEngine.js — Vertical Extremes Algorithm (V2)
 *
 * Finds price levels defined by candles with exceptional vertical movement.
 * Supports three variants that can be selected per request:
 *
 *   'range'  (default) — candles where range(high-low) >= N × ATR(14)
 *                         Catches explosive moves regardless of volume
 *   'volume'           — candles where volume >= N × average volume
 *                         Catches institutional activity / absorption
 *   'both'             — candles that qualify on BOTH criteria simultaneously
 *
 * Post-processing:
 *   - Qualifying candles are clustered by midpoint within clusterTolerancePct
 *   - Cluster center is volume-weighted (heaviest candle dominates position)
 *   - Result sorted by significance (touches desc, then avg volume ratio desc)
 *
 * Output: array of extreme records compatible with trackedExtremesStore.bulkSave()
 */

const DEFAULT_SETTINGS = {
  variant              : 'range',  // 'range' | 'volume' | 'both'
  lookbackBars         : 200,
  volumeMultiplier     : 2.5,      // volume >= avg × this  (for 'volume'/'both')
  rangeMultiplier      : 2.0,      // range  >= ATR × this  (for 'range'/'both')
  atrPeriod            : 14,       // ATR period for baseline volatility
  clusterTolerancePct  : 0.5,      // merge levels within this % of each other
  maxExtremes          : 50,       // hard cap on output count
};

/**
 * Find vertical extremes in bars array.
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} bars
 *   Bars sorted oldest → newest.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [settings]
 * @returns {Array<{side,type,price,points,strength,touches}>}
 */
function findVerticalExtremes(bars, settings = {}) {
  const cfg   = { ...DEFAULT_SETTINGS, ...settings };
  const slice = bars.slice(-cfg.lookbackBars);
  const n     = slice.length;

  if (n < cfg.atrPeriod + 2) return [];

  const currentPrice = slice[n - 1].close;

  // ── Baseline metrics ──────────────────────────────────────────
  const avgVolume = slice.reduce((s, b) => s + b.volume, 0) / n;
  const atr       = _computeATR(slice, cfg.atrPeriod);

  // ── Identify qualifying candles ───────────────────────────────
  const qualifying = [];
  for (const bar of slice) {
    const range     = bar.high - bar.low;
    const volumeOk  = bar.volume >= avgVolume * cfg.volumeMultiplier;
    const rangeOk   = atr > 0 && range  >= atr    * cfg.rangeMultiplier;

    const qualifies =
      cfg.variant === 'volume' ? volumeOk            :
      cfg.variant === 'range'  ? rangeOk             :
      /* 'both' */               volumeOk && rangeOk;

    if (qualifies) {
      qualifying.push({
        time       : bar.time,
        midPrice   : (bar.high + bar.low) / 2,
        high       : bar.high,
        low        : bar.low,
        volume     : bar.volume,
        volumeRatio: avgVolume > 0 ? bar.volume / avgVolume : 1,
        rangeRatio : atr       > 0 ? range       / atr      : 1,
      });
    }
  }

  if (qualifying.length === 0) return [];

  // ── Cluster by price proximity ────────────────────────────────
  const clusters = _cluster(qualifying, cfg.clusterTolerancePct);

  // ── Build extreme records ─────────────────────────────────────
  return clusters
    .slice(0, cfg.maxExtremes)
    .map(c => {
      const firstBar  = c.bars[0]; // earliest bar in cluster
      const avgRatio  = c.bars.reduce((s, b) => s + b.volumeRatio, 0) / c.bars.length;
      const side      = c.price < currentPrice ? 'support' : 'resistance';
      return {
        side,
        type    : 'extreme',
        price   : _r4(c.price),
        points  : [{ timestamp: firstBar.time, value: _r4(c.price) }],
        strength: _r2(avgRatio),
        touches : c.bars.length,
      };
    });
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * True Range–based ATR over the last `period` bars.
 */
function _computeATR(bars, period) {
  const n     = bars.length;
  const start = Math.max(1, n - period);
  let   sum   = 0;
  let   count = 0;
  for (let i = start; i < n; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low  - bars[i - 1].close),
    );
    sum   += tr;
    count += 1;
  }
  if (count === 0) return bars[n - 1].high - bars[n - 1].low;
  return sum / count;
}

/**
 * Greedy cluster: sort by midPrice, merge bars within tolerancePct of cluster center.
 * Cluster center is updated as volume-weighted average after each merge.
 */
function _cluster(bars, tolerancePct) {
  const sorted   = [...bars].sort((a, b) => a.midPrice - b.midPrice);
  const clusters = [];

  for (const bar of sorted) {
    let merged = false;
    for (const c of clusters) {
      const diffPct = Math.abs(c.price - bar.midPrice) / c.price * 100;
      if (diffPct <= tolerancePct) {
        c.bars.push(bar);
        // Recompute volume-weighted center
        const totalVol = c.bars.reduce((s, b) => s + b.volume, 0);
        c.price        = c.bars.reduce((s, b) => s + b.midPrice * b.volume, 0) / totalVol;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ price: bar.midPrice, bars: [bar] });
  }

  // Sort: most-touched first, then highest avg volume ratio
  clusters.sort((a, b) => {
    const touchDiff = b.bars.length - a.bars.length;
    if (touchDiff !== 0) return touchDiff;
    const aRatio = a.bars.reduce((s, b) => s + b.volumeRatio, 0) / a.bars.length;
    const bRatio = b.bars.reduce((s, b) => s + b.volumeRatio, 0) / b.bars.length;
    return bRatio - aRatio;
  });

  return clusters;
}

function _r2(v) { return Math.round(v * 100)   / 100;   }
function _r4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { findVerticalExtremes, DEFAULT_SETTINGS };
