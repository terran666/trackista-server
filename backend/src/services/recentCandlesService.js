'use strict';

/**
 * recentCandlesService — aggregates recent closed candles from 1m bars.
 *
 * Reads bars:1m:<SYM> (or bars:1m:spot:<SYM>) from caller,
 * groups them by real 5m time boundaries, returns last 5 complete candles.
 *
 * Algorithm:
 *  1. Sort 1m bars by ts ascending
 *  2. Drop any bar whose bucket equals the current (potentially unclosed) minute
 *  3. Group by floor(ts / 300000) * 300000 (real 5m boundary)
 *  4. Keep only groups with exactly 5 bars (complete 5m candles)
 *  5. Take the last 5 complete groups
 *  6. For each group compute: open, high, low, close, changePct, direction, strengthLevel
 */

const FIVE_MIN_MS     = 5 * 60 * 1000;  // 300 000 ms
const ONE_MIN_MS      = 60 * 1000;       // 60 000 ms
const CANDLE_COUNT    = 5;               // how many 5m candles to return
// Need at least CANDLE_COUNT full 5m groups = 25 bars; read 50 for safety headroom
const BARS_TO_READ    = 50;
const NEUTRAL_THRESH  = 0.05;           // abs(changePct) below this → "neutral"

/**
 * Compute direction string from changePct.
 * @param {number} changePct
 * @returns {"up"|"down"|"neutral"}
 */
function direction(changePct) {
  if (Math.abs(changePct) < NEUTRAL_THRESH) return 'neutral';
  return changePct > 0 ? 'up' : 'down';
}

/**
 * Compute strength level 0–4 from abs(changePct).
 * @param {number} changePct
 * @returns {0|1|2|3|4}
 */
function strengthLevel(changePct) {
  const abs = Math.abs(changePct);
  if (abs < 0.05) return 0;
  if (abs < 0.15) return 1;
  if (abs < 0.30) return 2;
  if (abs < 0.60) return 3;
  return 4;
}

/**
 * Build the recentCandles payload from an already-parsed, sorted array of 1m bars.
 *
 * @param {object[]} bars  — sorted ascending by ts, already parsed JSON objects
 * @param {number}   nowMs — current timestamp in ms (used to exclude unclosed bar)
 * @returns {{ timeframe: string, items: object[] }}
 */
function buildRecentCandles(bars, nowMs) {
  const TIMEFRAME = '5m';

  if (!bars || bars.length === 0) {
    return { timeframe: TIMEFRAME, items: [] };
  }

  // ── 1. Drop the current unclosed 1m bar ──────────────────────────────────
  // A bar is "unclosed" if its minute bucket equals the current minute bucket.
  const currentMinuteBucket = Math.floor(nowMs / ONE_MIN_MS) * ONE_MIN_MS;
  const closedBars = bars.filter(b => b.ts < currentMinuteBucket);

  if (closedBars.length < 5) {
    return { timeframe: TIMEFRAME, items: [] };
  }

  // ── 2. Group by 5m boundary ───────────────────────────────────────────────
  const groups = new Map(); // bucketTs → bar[]
  for (const bar of closedBars) {
    const bucketTs = Math.floor(bar.ts / FIVE_MIN_MS) * FIVE_MIN_MS;
    if (!groups.has(bucketTs)) groups.set(bucketTs, []);
    groups.get(bucketTs).push(bar);
  }

  // ── 3. Keep only complete groups (exactly 5 bars) ────────────────────────
  const completeGroups = [];
  for (const [bucketTs, groupBars] of groups) {
    if (groupBars.length === 5) {
      completeGroups.push({ bucketTs, bars: groupBars });
    }
  }

  if (completeGroups.length === 0) {
    return { timeframe: TIMEFRAME, items: [] };
  }

  // ── 4. Sort groups ascending and take last CANDLE_COUNT ──────────────────
  completeGroups.sort((a, b) => a.bucketTs - b.bucketTs);
  const recent = completeGroups.slice(-CANDLE_COUNT);

  // ── 5. Aggregate each group into a 5m candle ─────────────────────────────
  const items = recent.map(({ bucketTs, bars: grp }) => {
    // grp is already filtered to exactly 5 bars; sort by ts to be safe
    grp.sort((a, b) => a.ts - b.ts);

    const open  = grp[0].open;
    const close = grp[grp.length - 1].close;
    const high  = Math.max(...grp.map(b => b.high));
    const low   = Math.min(...grp.map(b => b.low));
    const changePct = open !== 0 ? parseFloat(((close - open) / open * 100).toFixed(4)) : 0;

    return {
      ts           : bucketTs,
      open         : parseFloat(open.toFixed(8)),
      high         : parseFloat(high.toFixed(8)),
      low          : parseFloat(low.toFixed(8)),
      close        : parseFloat(close.toFixed(8)),
      changePct,
      direction    : direction(changePct),
      strengthLevel: strengthLevel(changePct),
    };
  });

  return { timeframe: TIMEFRAME, items };
}

module.exports = { buildRecentCandles, BARS_TO_READ };
