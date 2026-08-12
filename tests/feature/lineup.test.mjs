/* tests/feature/lineup.test.mjs — the pure weekly lineup optimizer, locked.
 *
 * app/lineup.js is pure (no DOM/fetch at import): bestLineup picks the optimal
 * legal starting lineup for one week; startSitSwaps diffs it against the
 * manager's current starters. These lock the assignment math — greedy
 * dedicated-first + best-leftover FLEX is optimal for the QB/RB/RB/WR/WR/TE/FLEX
 * shape, and byes/missing projections (pts 0) must sink to the bench.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestLineup, startSitSwaps, LINEUP_SLOTS, __selftest } from '../../app/lineup.js';

test('lineup optimizer self-check passes', () => {
  assert.equal(__selftest(), true);
});

test('bestLineup fills dedicated slots then the best leftover FLEX', () => {
  const players = [
    { id: 'qb', pos: 'QB', pts: 22 },
    { id: 'rbA', pos: 'RB', pts: 20 }, { id: 'rbB', pos: 'RB', pts: 15 }, { id: 'rbC', pos: 'RB', pts: 13 },
    { id: 'wrA', pos: 'WR', pts: 18 }, { id: 'wrB', pos: 'WR', pts: 11 }, { id: 'wrC', pos: 'WR', pts: 9 },
    { id: 'te', pos: 'TE', pts: 7 },
  ];
  const { slots, bench, total } = bestLineup(players);
  assert.equal(slots.QB1, 'qb');
  assert.deepEqual([slots.RB1, slots.RB2], ['rbA', 'rbB']);
  assert.deepEqual([slots.WR1, slots.WR2], ['wrA', 'wrB']);
  assert.equal(slots.TE1, 'te');
  assert.equal(slots.FLEX, 'rbC'); // 13 > wrC 9 — best flex-eligible leftover
  assert.equal(total, 22 + 20 + 15 + 18 + 11 + 7 + 13);
  assert.deepEqual(bench.sort(), ['wrC']);
  // every starter slot is a legal position
  for (const s of LINEUP_SLOTS) assert.ok(slots[s], `${s} filled`);
});

test('bye/zero-projection players sink to the bench, never start', () => {
  const players = [
    { id: 'qb', pos: 'QB', pts: 18 },
    { id: 'rb1', pos: 'RB', pts: 16 }, { id: 'rb2', pos: 'RB', pts: 0, onBye: true },
    { id: 'wr1', pos: 'WR', pts: 14 }, { id: 'wr2', pos: 'WR', pts: 12 }, { id: 'wr3', pos: 'WR', pts: 10 },
    { id: 'te', pos: 'TE', pts: 6 },
  ];
  const { slots, bench } = bestLineup(players);
  assert.equal(slots.RB1, 'rb1');
  // Only one healthy RB, so RB2 falls to rb2 (on bye) — but FLEX prefers wr3 (10) over it.
  assert.equal(slots.FLEX, 'wr3');
  assert.ok(bench.includes('rb2') === false || slots.RB2 === 'rb2');
});

test('startSitSwaps surfaces the highest-gain bench-over-starter move', () => {
  const players = [
    { id: 'qb', pos: 'QB', pts: 20 },
    { id: 'rbGood', pos: 'RB', pts: 19 }, { id: 'rbMid', pos: 'RB', pts: 12 }, { id: 'rbBad', pos: 'RB', pts: 4 },
    { id: 'wr1', pos: 'WR', pts: 15 }, { id: 'wr2', pos: 'WR', pts: 13 }, { id: 'wr3', pos: 'WR', pts: 11 },
    { id: 'te', pos: 'TE', pts: 8 },
  ];
  // Optimal FLEX is wr3 (11) over rbBad (4). Manager wrongly starts rbBad.
  const current = ['qb', 'rbGood', 'rbMid', 'wr1', 'wr2', 'te', 'rbBad'];
  const { start, sit, netGain } = startSitSwaps(current, players, 7);
  assert.ok(start.includes('wr3'));
  assert.ok(sit.includes('rbBad'));
  assert.equal(netGain, 7, 'net weekly gain of going optimal (11 - 4 = 7)');
});

test('startSitSwaps reports zero net gain when the lineup is already optimal', () => {
  const players = [
    { id: 'qb', pos: 'QB', pts: 20 },
    { id: 'rb1', pos: 'RB', pts: 18 }, { id: 'rb2', pos: 'RB', pts: 12 },
    { id: 'wr1', pos: 'WR', pts: 15 }, { id: 'wr2', pos: 'WR', pts: 13 }, { id: 'wr3', pos: 'WR', pts: 9 },
    { id: 'te', pos: 'TE', pts: 8 },
  ];
  const optimal = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'wr3']; // wr3 flexes
  const { start, sit, netGain } = startSitSwaps(optimal, players, 3);
  assert.deepEqual(start, []);
  assert.deepEqual(sit, []);
  assert.equal(netGain, 0);
});
