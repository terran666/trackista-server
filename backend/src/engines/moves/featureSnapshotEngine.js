'use strict';

/**
 * featureSnapshotEngine — builds a structured feature snapshot from market data.
 * Used to record context at: event start, alert crossing, extreme, close.
 *
 * schemaVersion 1: original flat structure (Phase 1)
 * schemaVersion 2: structured blocks + derivatives + sourceCompleteness (Phase 2)
 *   Backward-compatible: v1 fields are still present at root level.
 */

const { computePriceChange } = require('./moveDetectionEngine');
const { computeWallContext  } = require('./wallContextEngine');

const SNAPSHOT_WINDOWS = [
  { label: '1m',  secs: 60   },
  { label: '3m',  secs: 180  },
  { label: '5m',  secs: 300  },
  { label: '15m', secs: 900  },
  { label: '30m', secs: 1800 },
  { label: '1h',  secs: 3600 },
];

/**
 * Build a feature snapshot.
 *
 * @param {object} opts
 * @param {number}                          opts.price        — current price
 * @param {object|null}                     opts.metrics      — parsed metrics:<SYM>
 * @param {object|null}                     opts.signal       — parsed signal:<SYM>
 * @param {object|null}                     opts.walls        — parsed walls:<SYM>
 * @param {object|null}                     opts.derivatives  — parsed derivatives:<SYM> (Phase 2)
 * @param {Array<{ts:number,price:number}>} opts.priceHistory — ascending ts
 * @param {number}                          opts.nowMs
 * @returns {object}
 */
function buildFeatureSnapshot({ price, metrics, signal, walls, derivatives, priceHistory, nowMs }) {
  const now = nowMs || Date.now();

  // Price change across all windows
  const priceChanges = {};
  if (priceHistory && priceHistory.length > 1) {
    for (const w of SNAPSHOT_WINDOWS) {
      const ch = computePriceChange(priceHistory, w.secs, price, now);
      priceChanges[w.label] = ch ? round(ch.movePct, 4) : null;
    }
  }

  const wallCtx = computeWallContext(walls, price);

  // ── v1 flat fields (backward-compatible) ─────────────────────────
  const base = {
    ts            : now,
    // ── Price ────────────────────────────────────────
    currentPrice  : price,
    priceChange1m : priceChanges['1m']  ?? null,
    priceChange3m : priceChanges['3m']  ?? null,
    priceChange5m : priceChanges['5m']  ?? null,
    priceChange15m: priceChanges['15m'] ?? null,
    priceChange30m: priceChanges['30m'] ?? null,
    priceChange1h : priceChanges['1h']  ?? null,

    // ── Tape ─────────────────────────────────────────
    volumeUsdt1s      : metrics?.volumeUsdt1s       ?? null,
    volumeUsdt5s      : metrics?.volumeUsdt5s       ?? null,
    volumeUsdt15s     : metrics?.volumeUsdt15s      ?? null,
    volumeUsdt60s     : metrics?.volumeUsdt60s      ?? null,
    tradeCount1s      : metrics?.tradeCount1s       ?? null,
    tradeCount5s      : metrics?.tradeCount5s       ?? null,
    tradeCount60s     : metrics?.tradeCount60s      ?? null,
    buyVolumeUsdt60s  : metrics?.buyVolumeUsdt60s   ?? null,
    sellVolumeUsdt60s : metrics?.sellVolumeUsdt60s  ?? null,
    deltaUsdt60s      : metrics?.deltaUsdt60s       ?? null,
    activityScore     : metrics?.activityScore      ?? null,

    // ── Signal ───────────────────────────────────────
    volumeSpikeRatio60s  : signal?.volumeSpikeRatio60s  ?? null,
    volumeSpikeRatio15s  : signal?.volumeSpikeRatio15s  ?? null,
    tradeAcceleration    : signal?.tradeAcceleration    ?? null,
    deltaImbalancePct60s : signal?.deltaImbalancePct60s ?? null,
    priceVelocity60s     : signal?.priceVelocity60s     ?? null,
    impulseScore         : signal?.impulseScore         ?? null,
    impulseDirection     : signal?.impulseDirection     ?? null,
    inPlayScore          : signal?.inPlayScore          ?? null,
    signalConfidence     : signal?.signalConfidence     ?? null,

    // ── Wall context ─────────────────────────────────
    ...wallCtx,
  };

  // ── v2 structured extension ───────────────────────────────────────
  const sourceCompleteness = {
    price       : price != null && price > 0,
    metrics     : metrics != null,
    signal      : signal  != null,
    walls       : walls   != null,
    derivatives : derivatives != null,
  };

  const derivativesBlock = derivatives ? {
    fundingRate          : derivatives.fundingRate,
    fundingDelta         : derivatives.fundingDelta,
    fundingBias          : derivatives.fundingBias,
    oiValue              : derivatives.oiValue,
    oiDeltaPct5m         : derivatives.oiDeltaPct5m,
    oiBias               : derivatives.oiBias,
    liquidationLongUsd5m : derivatives.liquidationLongUsd5m,
    liquidationShortUsd5m: derivatives.liquidationShortUsd5m,
    liquidationBias      : derivatives.liquidationBias,
    squeezeRisk          : derivatives.squeezeRisk,
    derivativesBias      : derivatives.derivativesBias,
    derivativesConfidence: derivatives.derivativesConfidence,
  } : null;

  return {
    ...base,
    // v2 metadata
    schemaVersion      : 2,
    capturedAt         : now,
    sourceCompleteness,
    // v2 structured blocks (mirrors flat fields for structured consumption)
    price_block: {
      currentPrice   : price,
      priceChange1m  : priceChanges['1m']  ?? null,
      priceChange3m  : priceChanges['3m']  ?? null,
      priceChange5m  : priceChanges['5m']  ?? null,
      priceChange15m : priceChanges['15m'] ?? null,
      priceChange30m : priceChanges['30m'] ?? null,
      priceChange1h  : priceChanges['1h']  ?? null,
    },
    tape_block: {
      volumeUsdt60s     : metrics?.volumeUsdt60s      ?? null,
      tradeCount60s     : metrics?.tradeCount60s      ?? null,
      deltaUsdt60s      : metrics?.deltaUsdt60s       ?? null,
      buyVolumeUsdt60s  : metrics?.buyVolumeUsdt60s   ?? null,
      sellVolumeUsdt60s : metrics?.sellVolumeUsdt60s  ?? null,
      activityScore     : metrics?.activityScore      ?? null,
    },
    impulse_block: {
      impulseScore     : signal?.impulseScore     ?? null,
      impulseDirection : signal?.impulseDirection ?? null,
      inPlayScore      : signal?.inPlayScore      ?? null,
      volumeSpikeRatio15s: signal?.volumeSpikeRatio15s ?? null,
      tradeAcceleration  : signal?.tradeAcceleration   ?? null,
      deltaImbalancePct60s: signal?.deltaImbalancePct60s ?? null,
    },
    walls_block: wallCtx,
    derivatives_block: derivativesBlock,
  };
}

function round(v, dec) {
  const m = 10 ** dec;
  return Math.round(v * m) / m;
}

module.exports = { buildFeatureSnapshot }; // buildFeatureSnapshotV2 merged into buildFeatureSnapshot (derivatives param supported)
