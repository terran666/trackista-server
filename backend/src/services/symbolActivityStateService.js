'use strict';

/**
 * symbolActivityStateService — pure activity state machine.
 * Derives priceState, volumeState, tradesState and their timing.
 * No I/O; no side effects.
 */

// ── Thresholds ────────────────────────────────────────────────────────────────
const PRICE = {
  spike  : 0.5,   // abs% in 1m to call spike
  move   : 0.07,  // abs% to call rising/falling
};

const VOLUME = {
  spike   : 1.5,
  elevated: 1.1,
};

const TRADES = {
  spike : 1.5,
  active: 1.1,
};

// ── Price state ──────────────────────────────────────────────────────────────

function computePriceState(delta1m, delta5m) {
  // Prefer 1m delta; fall back to 5m/5 (per-minute estimate)
  const d = delta1m != null ? delta1m : (delta5m != null ? delta5m / 5 : null);
  if (d == null) return 'inactive';
  const abs = Math.abs(d);
  if (d > 0) return abs >= PRICE.spike ? 'spike_up'   : abs >= PRICE.move ? 'rising'  : 'inactive';
  else       return abs >= PRICE.spike ? 'spike_down' : abs >= PRICE.move ? 'falling' : 'inactive';
}

/**
 * Extract priceStartedAt from move:live object.
 * Prefer active event; fall back to most recent event.
 */
function getPriceStartedAt(moveLive) {
  if (!moveLive || !Array.isArray(moveLive.events) || moveLive.events.length === 0) return null;
  const active = moveLive.events.find(e => e.status === 'active' || e.status === 'building');
  if (active?.startTs) return active.startTs;
  const sorted = [...moveLive.events].sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  return sorted[0]?.startTs || null;
}

// ── Volume state ─────────────────────────────────────────────────────────────

function computeVolumeState(relativeVolume1m) {
  if (relativeVolume1m == null) return 'inactive';
  if (relativeVolume1m >= VOLUME.spike)    return 'spike';
  if (relativeVolume1m >= VOLUME.elevated) return 'elevated';
  return 'inactive';
}

// ── Trades state ─────────────────────────────────────────────────────────────

function computeTradesState(relativeTrades1m) {
  if (relativeTrades1m == null) return 'inactive';
  if (relativeTrades1m >= TRADES.spike)  return 'spike';
  if (relativeTrades1m >= TRADES.active) return 'active';
  return 'inactive';
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {number|null} params.delta1m
 * @param {number|null} params.delta5m
 * @param {number|null} params.relativeVolume1m
 * @param {number|null} params.relativeTrades1m
 * @param {object|null} params.moveLive
 * @param {number|null} params.volumeRunStartTs - from barsAggregation
 * @param {number}      params.nowMs
 */
function computeActivity({
  delta1m,
  delta5m,
  relativeVolume1m,
  relativeTrades1m,
  moveLive,
  volumeRunStartTs,
  nowMs,
}) {
  const priceState  = computePriceState(delta1m, delta5m);
  const volumeState = computeVolumeState(relativeVolume1m);
  const tradesState = computeTradesState(relativeTrades1m);

  // Price timing
  const priceStartedAt       = getPriceStartedAt(moveLive);
  const priceDurationSec     = priceStartedAt ? Math.floor((nowMs - priceStartedAt) / 1000) : null;
  const pricePercentFromStart = moveLive?.bestMovePct != null
    ? parseFloat(moveLive.bestMovePct.toFixed(4))
    : null;

  // Volume timing — from contiguous spike run in bars
  const volumeStartedAt   = volumeState !== 'inactive' ? (volumeRunStartTs || null) : null;
  const volumeDurationSec = volumeStartedAt ? Math.floor((nowMs - volumeStartedAt) / 1000) : null;
  const volumePercentFromBaseline = relativeVolume1m != null
    ? parseFloat(((relativeVolume1m - 1) * 100).toFixed(1))
    : null;

  // Trades timing — no per-bar ratio stored, cannot determine precisely
  const tradesPercentFromBaseline = relativeTrades1m != null
    ? parseFloat(((relativeTrades1m - 1) * 100).toFixed(1))
    : null;

  return {
    priceState,
    priceStartedAt,
    priceDurationSec,
    pricePercentFromStart,

    volumeState,
    volumeStartedAt,
    volumeDurationSec,
    volumePercentFromBaseline,

    tradesState,
    tradesStartedAt  : null,
    tradesDurationSec: null,
    tradesPercentFromBaseline,
  };
}

module.exports = { computeActivity };
