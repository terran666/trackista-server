'use strict';
/**
 * test-watch-engine.js
 * Unit + integration tests for levelWatchEngine pure functions.
 * Run: node src/test-watch-engine.js  (from backend/)
 *   or: npm test
 */

const assert = require('assert').strict;
const { _testing: T } = require('./services/levelWatchEngine');

// ── Test runner ───────────────────────────────────────────────────
let pass = 0, fail = 0;
function section(name) { console.log(`\n── ${name} ─────────────────────────────────────`); }
function test(name, fn) {
  try   { fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (e) { console.error(`  ✗  ${name}\n     ${e.message}`); fail++; }
}

// ── Tick-sequence simulator ───────────────────────────────────────
// Drives resolvePhase through an array of prices and accumulates state
// exactly as the engine's previousStates.set() does.
function simulate(prices, levelPrice = 100.0) {
  let s = {
    phase:                'watching',
    lastNonAtSide:        null,
    pendingContactTicks:  0,
    pendingCrossTicks:    0,
    pendingCrossDirection: null,
    pending: { contactCandidate: false, contactTicks: 0,
               crossCandidate: false,   crossTicks: 0, crossDirection: null },
  };
  return prices.map(price => {
    const absDistancePct  = Math.abs((price - levelPrice) / levelPrice * 100);
    const sideNow         = T.computeSide(price, levelPrice);
    const prevCrossActive = s.pending.crossCandidate;

    const r = T.resolvePhase({
      prevPhase:            s.phase,
      absDistancePct,
      sideNow,
      lastNonAtSide:        s.lastNonAtSide,          // PREV tick's stored value — matches engine fix
      pendingContactTicks:  s.pendingContactTicks,
      pendingCrossTicks:    s.pendingCrossTicks,
      pendingCrossDirection: s.pendingCrossDirection,
    });

    // wickDetected: pending cross was active last tick, cancelled now (price returned)
    const wickDetected = prevCrossActive && !r.pending.crossCandidate;

    // Mirror engine's previousStates.set()
    s.phase                = r.nextPhase;
    s.lastNonAtSide        = sideNow !== 'at' ? sideNow : s.lastNonAtSide;
    s.pendingContactTicks  = r.pending.contactTicks;
    s.pendingCrossTicks    = r.pending.crossTicks;
    s.pendingCrossDirection = r.pending.crossDirection;
    s.pending              = r.pending;

    return { price, sideNow, wickDetected, ...r };
  });
}

// ══════════════════════════════════════════════════════════════════
section('computeSide  (level = 100)');

test('price 0.10% above level → above', () =>
  assert.equal(T.computeSide(100.10, 100), 'above'));

test('price just above tolerance (0.06%) → above', () =>
  assert.equal(T.computeSide(100.06, 100), 'above'));

test('price on tolerance boundary (+0.05%) → at', () =>
  assert.equal(T.computeSide(100.05, 100), 'at'));

test('price exactly at level → at', () =>
  assert.equal(T.computeSide(100.00, 100), 'at'));

test('price on tolerance boundary (-0.05%) → at', () =>
  assert.equal(T.computeSide(99.95, 100), 'at'));

test('price just below tolerance (-0.06%) → below', () =>
  assert.equal(T.computeSide(99.94, 100), 'below'));

// ══════════════════════════════════════════════════════════════════
section('resolvePhase – single-step transitions');

test('watching → approaching when dist ≤ 0.50%', () => {
  const r = T.resolvePhase({ prevPhase: 'watching', absDistancePct: 0.45, sideNow: 'above', lastNonAtSide: null });
  assert.equal(r.nextPhase, 'approaching');
  assert.equal(r.eventType, 'approaching_entered');
  assert.equal(r.changed, true);
});

test('watching stays watching when dist > 0.50%', () => {
  const r = T.resolvePhase({ prevPhase: 'watching', absDistancePct: 0.55, sideNow: 'above', lastNonAtSide: null });
  assert.equal(r.nextPhase, 'watching');
  assert.equal(r.changed, false);
});

test('approaching → precontact when dist ≤ 0.15%', () => {
  const r = T.resolvePhase({ prevPhase: 'approaching', absDistancePct: 0.12, sideNow: 'above', lastNonAtSide: 'above' });
  assert.equal(r.nextPhase, 'precontact');
  assert.equal(r.eventType, 'precontact_entered');
});

test('approaching → watching when dist > 0.65%', () => {
  const r = T.resolvePhase({ prevPhase: 'approaching', absDistancePct: 0.70, sideNow: 'above', lastNonAtSide: 'above' });
  assert.equal(r.nextPhase, 'watching');
  assert.equal(r.changed, true);
});

test('approaching stays in dead zone (0.15 < dist ≤ 0.50)', () => {
  const r = T.resolvePhase({ prevPhase: 'approaching', absDistancePct: 0.30, sideNow: 'above', lastNonAtSide: 'above' });
  assert.equal(r.nextPhase, 'approaching');
  assert.equal(r.changed, false);
});

test('precontact → approaching when dist > 0.22%', () => {
  const r = T.resolvePhase({ prevPhase: 'precontact', absDistancePct: 0.25, sideNow: 'above', lastNonAtSide: 'above' });
  assert.equal(r.nextPhase, 'approaching');
});

test('precontact: enters contact zone → contact confirmed immediately (HOLD=1)', () => {
  const r = T.resolvePhase({ prevPhase: 'precontact', absDistancePct: 0.03, sideNow: 'at', lastNonAtSide: 'above', pendingContactTicks: 0 });
  assert.equal(r.nextPhase, 'contact');
  assert.equal(r.eventType, 'contact_hit');
  assert.equal(r.pending.contactTicks, 0, 'contact ticks reset after confirmation');
});

test('precontact: price just outside contact zone (0.06%) does not trigger contact', () => {
  const r = T.resolvePhase({ prevPhase: 'precontact', absDistancePct: 0.06, sideNow: 'above', lastNonAtSide: 'above', pendingContactTicks: 0 });
  assert.equal(r.nextPhase, 'precontact');
  assert.equal(r.pending.contactTicks, 0, 'no contact pending when outside contact zone threshold');
});

test('watching: extremely small dist only reaches approaching (ALLOWED guard)', () => {
  // Even with dist < 0.05%, from watching hysteresis gives 'approaching' only.
  // Contact hold requires prevPhase=precontact; cross requires prevPhase in {contact, precontact, approaching}.
  const r = T.resolvePhase({ prevPhase: 'watching', absDistancePct: 0.01, sideNow: 'at', lastNonAtSide: null });
  assert.equal(r.nextPhase, 'approaching');
  assert.notEqual(r.nextPhase, 'contact');
  assert.notEqual(r.nextPhase, 'crossed');
});

// ══════════════════════════════════════════════════════════════════
section('Cross hold confirmation  (KEY BUG FIX)');

test('tick-1: side flip → pending cross starts, crossDetectedRaw=true', () => {
  const r = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.07, sideNow: 'below',
    lastNonAtSide: 'above', pendingCrossTicks: 0, pendingCrossDirection: null,
  });
  assert.equal(r.pending.crossTicks, 1);
  assert.equal(r.pending.crossDirection, 'below');
  assert.notEqual(r.nextPhase, 'crossed', 'hold not yet complete');
  assert.equal(r.crossDetectedRaw, true, 'raw cross fires immediately on side flip');
});

test('tick-2 continuation: crossedToSide=false (lastNonAtSide=below) but still confirms cross', () => {
  // THE KEY FIX: after tick-1, stored lastNonAtSide='below'.
  // On tick-2 crossedToSide = below!=below = FALSE, but continuation branch fires.
  const r = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.07, sideNow: 'below',
    lastNonAtSide: 'below',             // ← stored value after tick-1 (the old bug ignored this)
    pendingCrossTicks: 1, pendingCrossDirection: 'below',
  });
  assert.equal(r.nextPhase, 'crossed');
  assert.equal(r.eventType, 'crossed_down');
  assert.equal(r.pending.crossTicks, 0, 'cross ticks reset after confirmation');
  assert.equal(r.crossDetectedRaw, false, 'no fresh side flip on tick-2');
});

test('cross cancelled: price reverses direction during hold', () => {
  // Pending was 'below' (down cross), price snaps back above → old pending cleared, new UP started
  const r = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.20, sideNow: 'above',
    lastNonAtSide: 'below',             // stored after tick-1 of DOWN cross
    pendingCrossTicks: 1, pendingCrossDirection: 'below',
  });
  assert.notEqual(r.pending.crossDirection, 'below', 'down direction should be gone');
  assert.equal(r.pending.crossDirection, 'above',  'new up direction started');
  assert.equal(r.pending.crossTicks, 1);
});

test('fast cross from approaching phase (skips precontact/contact)', () => {
  // tick-1: approaching, side flips
  const r1 = T.resolvePhase({
    prevPhase: 'approaching', absDistancePct: 0.10, sideNow: 'below',
    lastNonAtSide: 'above', pendingCrossTicks: 0,
  });
  assert.equal(r1.pending.crossTicks, 1, 'approaching phase must start pending cross');

  // tick-2: continuation — confirms
  const r2 = T.resolvePhase({
    prevPhase: r1.nextPhase, absDistancePct: 0.10, sideNow: 'below',
    lastNonAtSide: 'below',             // stored after tick-1
    pendingCrossTicks: 1, pendingCrossDirection: 'below',
  });
  assert.equal(r2.nextPhase, 'crossed');
  assert.equal(r2.eventType, 'crossed_down');
});

test('crossed_up direction when price goes above level', () => {
  const r1 = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.07, sideNow: 'above',
    lastNonAtSide: 'below', pendingCrossTicks: 0,
  });
  const r2 = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.07, sideNow: 'above',
    lastNonAtSide: 'above', pendingCrossTicks: 1, pendingCrossDirection: 'above',
  });
  assert.equal(r2.nextPhase, 'crossed');
  assert.equal(r2.eventType, 'crossed_up');
});

test('cross does NOT start below WATCH_CROSS_CONFIRM_PCT (dist < 0.03%)', () => {
  const r = T.resolvePhase({
    prevPhase: 'contact', absDistancePct: 0.02, sideNow: 'below',
    lastNonAtSide: 'above', pendingCrossTicks: 0,
  });
  assert.equal(r.pending.crossTicks, 0, 'no cross below minimum confirm distance');
  assert.notEqual(r.nextPhase, 'crossed');
});

// ══════════════════════════════════════════════════════════════════
section('Wick / probe detection');

test('wick detected when pending cross is cancelled by price returning to AT zone', () => {
  const ticks = simulate([
    100.45,  // t0: watching → approaching
    100.10,  // t1: approaching → precontact
    100.03,  // t2: precontact (pending contact tick 1)
    100.02,  // t3: contact confirmed
    99.94,   // t4: sideNow='below', dist=0.06≥0.03 → pending cross tick 1
    100.02,  // t5: sideNow='at', dist=0.02<0.03 → cross block skipped → cancelled → WICK
  ]);
  assert.equal(ticks[4].pending.crossTicks, 1, 't4 should have pending cross');
  assert.equal(ticks[4].pending.crossCandidate, true);
  assert.equal(ticks[5].pending.crossTicks, 0, 't5 cross block skipped (dist<0.03)');
  assert.equal(ticks[5].wickDetected, true, 'wick must be detected when cross is cancelled');
});

// ══════════════════════════════════════════════════════════════════
section('Tick-sequence integration – full approach + cross');

test('approach from above: correct phase sequence through all stages', () => {
  // Level=100, price approaches from above, then crosses down
  const ticks = simulate([
    101.00,  // t0: dist=1.00 → watching
    100.45,  // t1: dist=0.45 → approaching
    100.12,  // t2: dist=0.12 → precontact
    100.03,  // t3: dist=0.03, sideNow=at → pending contact 1
    100.02,  // t4: dist=0.02, sideNow=at → contact confirmed
    99.93,   // t5: dist=0.07, sideNow=below → pending cross 1 (crossDetectedRaw=true)
    99.93,   // t6: continuation (lastNonAt=below) → crossed_down
  ]);

  assert.equal(ticks[0].nextPhase, 'watching',    't0: watching');
  assert.equal(ticks[1].nextPhase, 'approaching', 't1: approaching');
  assert.equal(ticks[1].eventType, 'approaching_entered');
  assert.equal(ticks[2].nextPhase, 'precontact',  't2: precontact');
  assert.equal(ticks[2].eventType, 'precontact_entered');
  assert.equal(ticks[3].nextPhase, 'contact',     't3: contact confirmed immediately (HOLD=1)');
  assert.equal(ticks[3].eventType, 'contact_hit');
  assert.equal(ticks[3].pending.contactTicks, 0,  't3: contact ticks reset after confirmation');
  assert.equal(ticks[4].nextPhase, 'contact',     't4: stays contact');
  assert.equal(ticks[4].eventType, null,           't4: no duplicate contact event');
  assert.equal(ticks[5].nextPhase, 'contact',     't5: still contact (pendingCross=1)');
  assert.equal(ticks[5].crossDetectedRaw, true,   't5: raw cross fires immediately');
  assert.equal(ticks[6].nextPhase, 'crossed',     't6: crossed confirmed');
  assert.equal(ticks[6].eventType, 'crossed_down');
});

test('approach from below → crossed_up', () => {
  const ticks = simulate([
    99.00,   // t0: dist=1.00 → watching
    99.55,   // t1: dist=0.45 → approaching
    99.88,   // t2: dist=0.12 → precontact
    99.97,   // t3: dist=0.03, sideNow=at → pending contact 1
    99.98,   // t4: dist=0.02, sideNow=at → contact confirmed
    100.07,  // t5: sideNow=above (dist=0.07) → pending cross up 1
    100.07,  // t6: continuation → crossed_up
  ]);

  assert.equal(ticks[1].nextPhase, 'approaching');
  assert.equal(ticks[4].nextPhase, 'contact');
  assert.equal(ticks[5].crossDetectedRaw, true);
  assert.equal(ticks[6].nextPhase, 'crossed');
  assert.equal(ticks[6].eventType, 'crossed_up');
});

test('no spurious cross when price stays in AT zone (dist < 0.03%)', () => {
  const ticks = simulate([100.45, 100.12, 100.03, 100.02, 100.02, 100.02]);
  const phases = ticks.map(t => t.nextPhase);
  assert.ok(!phases.includes('crossed'), 'dist always < 0.03%, should never cross');
});

test('phase resets to watching after cross resolves (price moves far)', () => {
  const ticks = simulate([
    100.45, 100.12, 100.03, 100.02,   // approach + contact
    99.93, 99.93,                       // cross down
    101.00,                             // dist=1.00 > 0.65 → watching
  ]);
  assert.equal(ticks[5].nextPhase, 'crossed');
  assert.equal(ticks[6].nextPhase, 'watching', 'should exit crossed when dist > 0.65%');
});

// ══════════════════════════════════════════════════════════════════
section('computePopupStatus');

const nowTs   = Date.now();
const recentTs = nowTs - 1_000;   // 1 s ago — within POPUP_RECENT_COMPLETED_MS (5 min)
const oldTs    = nowTs - 400_000; // ~7 min ago — outside 5 min window

test('rollbackAfterAlert → pulling_back (highest priority)', () =>
  assert.equal(T.computePopupStatus('crossed', true, recentTs, nowTs, false, false, false), 'pulling_back'));

test('crossDetectedRaw overrides phase (approaching + raw cross → crossed)', () =>
  assert.equal(T.computePopupStatus('approaching', false, null, nowTs, false, false, true), 'crossed'));

test('phase=crossed → crossed', () =>
  assert.equal(T.computePopupStatus('crossed', false, recentTs, nowTs, false, false, false), 'crossed'));

test('rawContactDetected overrides phase (approaching + raw contact → contact)', () =>
  assert.equal(T.computePopupStatus('approaching', false, null, nowTs, false, true, false), 'contact'));

test('wickRecent → contact (even from watching phase)', () =>
  assert.equal(T.computePopupStatus('watching', false, null, nowTs, true, false, false), 'contact'));

test('phase=contact → contact', () =>
  assert.equal(T.computePopupStatus('contact', false, null, nowTs, false, false, false), 'contact'));

test('phase=precontact → very_close', () =>
  assert.equal(T.computePopupStatus('precontact', false, null, nowTs, false, false, false), 'very_close'));

test('phase=approaching → approaching', () =>
  assert.equal(T.computePopupStatus('approaching', false, null, nowTs, false, false, false), 'approaching'));

test('watching + recent strong event → completed', () =>
  assert.equal(T.computePopupStatus('watching', false, recentTs, nowTs, false, false, false), 'completed'));

test('watching + old strong event (>5 min) → inactive', () =>
  assert.equal(T.computePopupStatus('watching', false, oldTs, nowTs, false, false, false), 'inactive'));

test('watching + no strong event → inactive', () =>
  assert.equal(T.computePopupStatus('watching', false, null, nowTs, false, false, false), 'inactive'));

test('rollbackAfterAlert beats crossDetectedRaw', () =>
  assert.equal(T.computePopupStatus('crossed', true, recentTs, nowTs, false, false, true), 'pulling_back'));

test('recentTouchPullback while approaching → contact status', () =>
  assert.equal(T.computePopupStatus('approaching', false, recentTs, nowTs, false, false, false, true), 'contact'));

test('recentTouchPullback while precontact → contact status', () =>
  assert.equal(T.computePopupStatus('precontact', false, recentTs, nowTs, false, false, false, true), 'contact'));

test('recentTouchPullback overridden by crossDetectedRaw → crossed', () =>
  assert.equal(T.computePopupStatus('approaching', false, recentTs, nowTs, false, false, true, true), 'crossed'));

test('recentTouchPullback overridden by rollbackAfterAlert → pulling_back', () =>
  assert.equal(T.computePopupStatus('approaching', true, recentTs, nowTs, false, false, false, true), 'pulling_back'));

// ══════════════════════════════════════════════════════════════════
section('normDeltaToPct + deltaTrend');

test('normDeltaToPct: 0 delta → 50 (neutral)', () =>
  assert.equal(T.normDeltaToPct(0, 30), 50));

test('normDeltaToPct: +range → 100 (max positive)', () =>
  assert.equal(T.normDeltaToPct(30, 30), 100));

test('normDeltaToPct: -range → 0 (max negative)', () =>
  assert.equal(T.normDeltaToPct(-30, 30), 0));

test('normDeltaToPct: half positive → 75', () =>
  assert.equal(T.normDeltaToPct(15, 30), 75));

test('normDeltaToPct: null → null', () =>
  assert.equal(T.normDeltaToPct(null, 30), null));

test('deltaTrend: positive above threshold → rising', () =>
  assert.equal(T.deltaTrend(5, 3), 'rising'));

test('deltaTrend: negative below threshold → falling', () =>
  assert.equal(T.deltaTrend(-5, 3), 'falling'));

test('deltaTrend: within threshold → stable', () =>
  assert.equal(T.deltaTrend(2, 3), 'stable'));

test('deltaTrend: null → stable', () =>
  assert.equal(T.deltaTrend(null, 3), 'stable'));

// ══════════════════════════════════════════════════════════════════
section('Fingerprint-clear logic (minuteBucket key)');

test('buildFingerprint returns consistent key for same minute', () => {
  // The fingerprint key uses Math.floor(nowMs/60000) as minute bucket.
  // Two calls in the same minute must produce the same key.
  const nowMs = 1_700_000_060_000; // some fixed timestamp
  const minute = Math.floor(nowMs / 60000);
  const fp1 = `BTCUSDT:futures:db-1:approaching_entered:${minute}`;
  const fp2 = `BTCUSDT:futures:db-1:approaching_entered:${minute}`;
  assert.equal(fp1, fp2, 'same minute → same fingerprint key (would be blocked)');
});

test('different minuteBuckets produce different fingerprint keys', () => {
  const minA = Math.floor(1_700_000_060_000 / 60000); // minute N
  const minB = Math.floor(1_700_000_120_000 / 60000); // minute N+1
  assert.notEqual(minA, minB, 'different minutes → different fingerprint keys (would NOT be blocked)');
});

test('clearing fingerprint keys after cross: del targets include both cooldown and fp keys', () => {
  // Verify formula used in evaluateTransitionEvents fingerprint-clear block.
  // redis.del() must receive keys for both watchcooldown AND watcheventfp.
  const market = 'futures', symbol = 'BTCUSDT', id = 'db-42';
  const nowMs  = 1_700_000_080_000;
  const mb     = Math.floor(nowMs / 60000);

  const expectedCd = [
    `watchcooldown:approaching_entered:${market}:${symbol}:${id}`,
    `watchcooldown:precontact_entered:${market}:${symbol}:${id}`,
    `watchcooldown:contact_hit:${market}:${symbol}:${id}`,
  ];
  const expectedFp = [
    `watcheventfp:${symbol}:${market}:${id}:approaching_entered:${mb}`,
    `watcheventfp:${symbol}:${market}:${id}:precontact_entered:${mb}`,
    `watcheventfp:${symbol}:${market}:${id}:contact_hit:${mb}`,
  ];

  // Keys must all be unique (no accidental collision)
  const allKeys = [...expectedCd, ...expectedFp];
  const unique  = new Set(allKeys);
  assert.equal(unique.size, 6, 'all 6 deletion keys must be unique');
  // cd keys and fp keys must be different strings
  for (const cd of expectedCd) {
    assert.ok(!expectedFp.includes(cd), `cooldown key "${cd}" must not appear in fp list`);
  }
});

// ══════════════════════════════════════════════════════════════════
section('Geometry helpers — getSlopedLevelValueAtTimestamp');

test('value at anchor p1 equals p1.value', () => {
  const p1 = { timestamp: 1000, value: 100 };
  const p2 = { timestamp: 2000, value: 110 };
  assert.equal(T.getSlopedLevelValueAtTimestamp([p1, p2], 1000), 100);
});

test('value at anchor p2 equals p2.value', () => {
  const p1 = { timestamp: 1000, value: 100 };
  const p2 = { timestamp: 2000, value: 110 };
  assert.equal(T.getSlopedLevelValueAtTimestamp([p1, p2], 2000), 110);
});

test('value at midpoint is linear interpolation', () => {
  const p1 = { timestamp: 0, value: 100 };
  const p2 = { timestamp: 1000, value: 200 };
  assert.equal(T.getSlopedLevelValueAtTimestamp([p1, p2], 500), 150);
});

test('extrapolates beyond p2 (same slope)', () => {
  const p1 = { timestamp: 0, value: 100 };
  const p2 = { timestamp: 1000, value: 200 };
  // slope = 0.1 per ms → at ts=2000: 100 + 0.1*2000 = 300
  assert.equal(T.getSlopedLevelValueAtTimestamp([p1, p2], 2000), 300);
});

test('descending slope extrapolates correctly', () => {
  const p1 = { timestamp: 0,    value: 200 };
  const p2 = { timestamp: 1000, value: 100 };
  // slope = -0.1 per ms → at ts=1500: 200 + (-0.1)*1500 = 50
  assert.equal(T.getSlopedLevelValueAtTimestamp([p1, p2], 1500), 50);
});

// ══════════════════════════════════════════════════════════════════
section('Geometry helpers — getLevelPriceRef');

test('horizontal level returns level.price', () => {
  const level = { geometryType: 'horizontal', price: 42000 };
  assert.equal(T.getLevelPriceRef(level, Date.now()), 42000);
});

test('horizontal level with price=null returns null', () => {
  const level = { geometryType: 'horizontal', price: null };
  assert.equal(T.getLevelPriceRef(level, Date.now()), null);
});

test('horizontal level with price=0 returns null', () => {
  const level = { geometryType: 'horizontal', price: 0 };
  assert.equal(T.getLevelPriceRef(level, Date.now()), null);
});

test('sloped level returns extrapolated price at nowTs', () => {
  const level = {
    geometryType: 'sloped',
    price: null,
    points: [{ timestamp: 0, value: 100 }, { timestamp: 1000, value: 200 }],
  };
  assert.equal(T.getLevelPriceRef(level, 500), 150);
});

test('sloped level with missing points returns null', () => {
  const level = { geometryType: 'sloped', price: null, points: null };
  assert.equal(T.getLevelPriceRef(level, Date.now()), null);
});

test('sloped level with only 1 point returns null', () => {
  const level = {
    geometryType: 'sloped',
    price: null,
    points: [{ timestamp: 1000, value: 100 }],
  };
  assert.equal(T.getLevelPriceRef(level, Date.now()), null);
});

test('sloped level with duplicate timestamps returns null', () => {
  const level = {
    geometryType: 'sloped',
    price: null,
    points: [{ timestamp: 1000, value: 100 }, { timestamp: 1000, value: 200 }],
  };
  assert.equal(T.getLevelPriceRef(level, Date.now()), null);
});

test('unknown geometryType falls back to level.price', () => {
  const level = { geometryType: 'vertical', price: 55000 };
  assert.equal(T.getLevelPriceRef(level, Date.now()), 55000);
});

// ══════════════════════════════════════════════════════════════════
// Results
console.log(`\n${'═'.repeat(52)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(`\n❌  ${fail} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅  All ${pass} tests passed`);
}
