/* tests/feature/ros.test.mjs — the Rest-of-Season value engine (app/ros.js), locked.
 *
 * Pure math, exact expected numbers. Also enforces two design invariants:
 *   - zero-weight SoS/availability reproduces the raw remaining sum EXACTLY
 *     (the never-regress zero-default the promotion gate only tunes upward),
 *   - the engine imports NO market/price source (independent-of-Vegas rule).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  remainingWeeks, gamesLeft, nextBye, rosPoints, rosRange,
  replacementLevel, rosVOR, rankByRos, __selftest,
} from '../../app/ros.js';

const WEEKS = [
  { wk: 1, opp: 'A', home: true, bye: false, pts: 10 },
  { wk: 2, opp: 'B', home: false, bye: false, pts: 20 },
  { wk: 3, opp: null, home: false, bye: true, pts: 0 },
  { wk: 4, opp: 'C', home: true, bye: false, pts: 30 },
];

test('remaining weeks exclude byes and past weeks', () => {
  assert.equal(remainingWeeks(WEEKS, 2).length, 2);   // wk2 + wk4 (wk3 bye)
  assert.equal(gamesLeft(WEEKS, 1), 3);               // 3 non-bye weeks
  assert.equal(gamesLeft(WEEKS, 4), 1);
  assert.equal(gamesLeft([], 1), 0);
});

test('rosPoints sums remaining non-bye projections', () => {
  assert.equal(rosPoints(WEEKS, 1), 60);              // 10+20+30 (bye excluded)
  assert.equal(rosPoints(WEEKS, 2), 50);              // 20+30
  assert.equal(rosPoints(WEEKS, 4), 30);
});

test('nextBye finds the upcoming bye week or null', () => {
  assert.equal(nextBye(WEEKS, 1), 3);
  assert.equal(nextBye(WEEKS, 4), null);
});

test('zero-weight SoS/availability reproduces the raw sum EXACTLY (never-regress default)', () => {
  const raw = rosPoints(WEEKS, 1);
  const adj = rosPoints(WEEKS, 1, {
    sosW: 0, availW: 0, sosByTeam: { A: 2, B: 0.5, C: 1.5 }, avail: 0.4,
  });
  assert.equal(adj, raw, 'weight-0 adjustments must not move the number');
  // With weight > 0 the SoS factor DOES move it (proving the hook is real).
  const tilted = rosPoints(WEEKS, 1, { sosW: 1, sosByTeam: { A: 2, B: 1, C: 1 } });
  assert.ok(tilted > raw, 'a positive sosW with a favorable factor raises RoS');
});

test('rosRange returns a floor<=median<=ceil band, nulls when no games left', () => {
  const r = rosRange(WEEKS, 1);
  assert.ok(r.floor <= r.median && r.median <= r.ceil);
  assert.equal(r.median, 60);
  const empty = rosRange(WEEKS, 99);
  assert.deepEqual(empty, { floor: null, median: null, ceil: null });
});

test('replacementLevel + VOR at a position cutoff', () => {
  const list = [100, 80, 60, 40, 20];
  assert.equal(replacementLevel(list, 3), 60);        // 3rd-best is replacement
  assert.equal(rosVOR(100, 60), 40);
  assert.equal(replacementLevel([], 3), 0);
});

test('rankByRos orders by within-position VOR, carries games/bye/z', () => {
  const players = [
    { id: 'rb1', pos: 'RB', weeks: [{ wk: 1, bye: false, pts: 25 }, { wk: 2, bye: false, pts: 25 }] },
    { id: 'rb2', pos: 'RB', weeks: [{ wk: 1, bye: false, pts: 10 }, { wk: 2, bye: false, pts: 10 }] },
    { id: 'wr1', pos: 'WR', weeks: [{ wk: 1, bye: false, pts: 18 }, { wk: 2, bye: false, pts: 18 }] },
  ];
  const ranked = rankByRos(players, 1);
  assert.equal(ranked[0].id, 'rb1');                  // highest RoS
  assert.equal(ranked[0].ros, 50);
  assert.equal(ranked[0].gamesLeft, 2);
  assert.ok(ranked.every((r) => Number.isFinite(r.vor) && Number.isFinite(r.z)));
});

test('engine self-check passes', () => {
  assert.equal(__selftest(), true);
});

test('app/ros.js imports NO market / price / odds source (independent-of-Vegas rule)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/ros.js', import.meta.url)), 'utf8');
  assert.ok(!/\b(market|odds|vegas|kalshi|polymarket|implied|price)\b/i.test(src),
    'the RoS engine must never reference a betting-market source');
});
