'use strict';

/**
 * normalizeWall.js — canonical wall shape for all density endpoints.
 *
 * Required fields: price, side, sizeUsd, createdAt
 * Optional fields: updatedAt, ageSec, qty, isMajor, strength, distancePct, wallId
 *
 * createdAt = moment the wall first appeared (firstSeenAt / firstSeenTs from collector).
 *             NEVER changes while the wall is alive — even if sizeUsd grows.
 * updatedAt = last time the wall data was written (lastSeenAt / lastSeenTs).
 *
 * Used by:
 *   - densityChartRoute  (GET /api/density/chart, GET /api/density/depth-map)
 *   - wallDepthRoute     (GET /api/density/wall-depth  →  targetWall object)
 *   - liveWsGateway      (WS density:walls frame)
 */

// wallPower threshold at or above which a wall is considered "major"
const MAJOR_WALL_POWER_MIN = parseFloat(process.env.MAJOR_WALL_POWER_MIN || '0.65');

/**
 * Normalise a raw wall object from any Redis source to the canonical shape.
 *
 * Source field priority for createdAt:
 *   firstSeenAt  (set by buildPublicWallsPayload)
 *   firstSeenTs  (internal candidate field, present in debug payloads)
 *   fallback: now - ageSec*1000  (if ageSec available on the raw object)
 *   fallback: null
 *
 * Source field priority for updatedAt:
 *   lastSeenAt   (set by buildPublicWallsPayload)
 *   lastSeenTs   (internal candidate field)
 *   lastUpdatedAt
 *   fallback: now
 *
 * @param {object} w     raw wall from futures:walls:{sym} / walls:{sym}
 * @param {number} [now] current time ms — pass in for batch calls to avoid
 *                       per-item Date.now() overhead (optional, defaults fine)
 * @returns {object}
 */
function normalizeWall(w, now = Date.now()) {
  const sizeUsd = w.sizeUsd  ?? w.usdValue ?? 0;
  const qty     = w.qty      ?? w.size     ?? 0;

  // ── createdAt: when the wall FIRST appeared ─────────────────────
  let createdAt = w.firstSeenAt ?? w.firstSeenTs ?? null;
  if (createdAt === null && w.ageSec != null) {
    // Fallback: derive from reported age when collector did not persist firstSeenAt
    createdAt = Math.round(now - w.ageSec * 1000);
  }

  // ── updatedAt: when the wall was last refreshed ─────────────────
  const updatedAt = w.lastSeenAt ?? w.lastSeenTs ?? w.lastUpdatedAt ?? now;

  // ── ageSec: seconds since wall first appeared ───────────────────
  const ageSec = createdAt !== null
    ? parseFloat(((now - createdAt) / 1000).toFixed(1))
    : null;

  // isMajor: collector's wallCategory marks STRONG_WALL / EXTREME_WALL,
  // or wallPower >= threshold as a fallback for older payloads.
  const cat     = w.wallCategory ?? w.category ?? '';
  const isMajor = cat === 'STRONG_WALL' || cat === 'EXTREME_WALL'
               || (w.wallPower != null && w.wallPower >= MAJOR_WALL_POWER_MIN);

  const out = {
    price      : w.price,
    side       : w.side,
    sizeUsd,
    qty,
    isMajor,
    createdAt,
    updatedAt,
    ageSec,
    strength   : w.strength    ?? null,
    distancePct: w.distancePct ?? null,
  };

  // Preserve wallId so the frontend can deduplicate across frames
  if (w.wallId != null) out.wallId = w.wallId;

  return out;
}

/**
 * Walk candles right-to-left and return the `time` of the first candle whose
 * [low, high] bracket contains wallPrice.  Returns null if no match.
 *
 * Algorithm (per spec §5):
 *   1. start from the newest candle
 *   2. find first candle where wallPrice >= candle.low && wallPrice <= candle.high
 *   3. return candle.time, or null
 *
 * @param {number} wallPrice
 * @param {Array<{time:number, low:number, high:number}>} candles  sorted asc by time
 * @returns {number|null}
 */
function computeFirstBarTime(wallPrice, candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (wallPrice >= c.low && wallPrice <= c.high) return c.time;
  }
  return null;
}

module.exports = { normalizeWall, computeFirstBarTime };
