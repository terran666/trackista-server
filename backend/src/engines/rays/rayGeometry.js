'use strict';

/**
 * rayGeometry.js
 *
 * Geometry helpers for sloped lines / rays.
 * These functions are shape-agnostic and work purely with the two
 * anchor points stored on a tracked ray record.
 *
 * The line is defined by exactly two anchor points:
 *   P0 = { timestamp: t0, value: v0 }
 *   P1 = { timestamp: t1, value: v1 }
 *
 * Linear interpolation / extrapolation formula:
 *   value(t) = v0 + (v1 - v0) * (t - t0) / (t1 - t0)
 */

/**
 * Return the line's value at an arbitrary timestamp using linear
 * interpolation / extrapolation between the two anchor points.
 *
 * @param {Array<{timestamp: number, value: number}>} points - exactly 2 anchors
 * @param {number} timestamp - target timestamp in milliseconds
 * @returns {number} interpolated / extrapolated value
 * @throws {Error} if points are malformed or t0 === t1
 */
function getLineValueAtTimestamp(points, timestamp) {
  if (!Array.isArray(points) || points.length !== 2) {
    throw new Error('points must be an array of exactly 2 anchor objects');
  }

  const [p0, p1] = points;

  if (
    typeof p0.timestamp !== 'number' || typeof p0.value !== 'number' ||
    typeof p1.timestamp !== 'number' || typeof p1.value !== 'number'
  ) {
    throw new Error('Each point must have numeric timestamp and value');
  }

  const dt = p1.timestamp - p0.timestamp;
  if (dt === 0) {
    throw new Error('Anchor points must have different timestamps (vertical line is not supported)');
  }

  const slope = (p1.value - p0.value) / dt;
  return p0.value + slope * (timestamp - p0.timestamp);
}

/**
 * Return the slope of the line in value-per-millisecond units.
 * Positive = upward, Negative = downward.
 *
 * @param {Array<{timestamp: number, value: number}>} points
 * @returns {number}
 */
function getSlope(points) {
  if (!Array.isArray(points) || points.length !== 2) {
    throw new Error('points must be an array of exactly 2 anchor objects');
  }
  const [p0, p1] = points;
  const dt = p1.timestamp - p0.timestamp;
  if (dt === 0) throw new Error('Anchor points must have different timestamps');
  return (p1.value - p0.value) / dt;
}

/**
 * Check whether a price is within `tolerancePct` percent of the line
 * value at the given timestamp. Useful for future proximity checks
 * in the alert engine.
 *
 * @param {Array<{timestamp: number, value: number}>} points
 * @param {number} timestamp
 * @param {number} currentPrice
 * @param {number} tolerancePct - e.g. 0.1 for 0.1%
 * @returns {{ near: boolean, lineValue: number, distancePct: number }}
 */
function isNearLine(points, timestamp, currentPrice, tolerancePct = 0.1) {
  const lineValue   = getLineValueAtTimestamp(points, timestamp);
  if (!lineValue) {
    return { near: currentPrice === 0, lineValue, distancePct: currentPrice === 0 ? 0 : Infinity };
  }
  const distancePct = Math.abs((currentPrice - lineValue) / lineValue) * 100;
  return {
    near:        distancePct <= tolerancePct,
    lineValue,
    distancePct,
  };
}

module.exports = { getLineValueAtTimestamp, getSlope, isNearLine };
