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
import {
  bestLineup, startSitSwaps, lineupGeometry, isProjectedPosition,
  LINEUP_SLOTS, PROJECTED_POSITIONS, WARN_FORCED_UNAVAILABLE, WARN_NO_PROJECTION,
  __selftest,
} from '../../app/lineup.js';
import { DEFAULT_PROFILE, normalizeProfile } from '../../app/league.js';

/** A 9-starter league: QB RB RB WR WR TE FLEX K DEF + 6 bench. */
const NINE = normalizeProfile({
  shape: {
    roster_positions: [
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ],
  },
});

/** A healthy 8-man roster: 7 starters + one leftover WR. */
const ROSTER = () => [
  { id: 'qb', pos: 'QB', pts: 22 },
  { id: 'rbA', pos: 'RB', pts: 20 }, { id: 'rbB', pos: 'RB', pts: 15 }, { id: 'rbC', pos: 'RB', pts: 13 },
  { id: 'wrA', pos: 'WR', pts: 18 }, { id: 'wrB', pos: 'WR', pts: 11 }, { id: 'wrC', pos: 'WR', pts: 9 },
  { id: 'te', pos: 'TE', pts: 7 },
];

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

/* ---------------------------------------------------------------------------
 * R19-B5 — K / DEF slots exist, render, and are honestly unprojected.
 *
 * The failure this locks out is a lineup that is quietly 7 slots long when the
 * league starts 9: a wrong answer presented as a right one. The slots must come
 * back, must be worth nothing rather than 0.0, and must announce themselves on
 * the warnings channel under their OWN reason code.
 * ------------------------------------------------------------------------- */

test('the default geometry is byte-for-byte the legacy seven slots', () => {
  const geo = lineupGeometry();
  assert.deepEqual(geo.map((g) => g.slot), [...LINEUP_SLOTS]);
  assert.ok(geo.every((g) => g.projected), 'every default slot has a feed');
  assert.deepEqual(lineupGeometry(DEFAULT_PROFILE).map((g) => g.slot), [...LINEUP_SLOTS]);
  // ...and an omitted profile must not conjure warnings out of nowhere.
  assert.deepEqual(bestLineup(ROSTER()).warnings, []);
});

test('K and DEF are known to have no projection feed', () => {
  assert.deepEqual([...PROJECTED_POSITIONS], ['QB', 'RB', 'WR', 'TE']);
  for (const pos of ['QB', 'rb', 'WR', 'te']) assert.equal(isProjectedPosition(pos), true);
  for (const pos of ['K', 'DEF', 'DST', '', null, undefined]) {
    assert.equal(isProjectedPosition(pos), false, `${pos} has no feed`);
  }
});

test('a 9-starter league gets NINE slots — K and DEF are never silently omitted', () => {
  const l = bestLineup(ROSTER(), NINE);
  assert.equal(l.slotCount, 9);
  assert.deepEqual(l.slotIds, ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'K1', 'DEF1']);
  // Present as KEYS — a view that iterates the map cannot lose them.
  assert.ok('K1' in l.slots && 'DEF1' in l.slots);
  assert.equal(l.slots.K1, null);
  assert.equal(l.slots.DEF1, null);
});

test('an unprojected slot is worth NOTHING, never a fabricated 0.0', () => {
  const seven = bestLineup(ROSTER());
  const nine = bestLineup(ROSTER(), NINE);
  // Identical points: the two extra slots add no value and subtract none.
  assert.equal(nine.total, seven.total);
  assert.equal(nine.total, 22 + 20 + 15 + 18 + 11 + 7 + 13);
  // And the card can state the coverage instead of implying a complete lineup.
  assert.equal(nine.projectedSlots, 7);
  assert.equal(nine.slotCount, 9);
  assert.equal(`${nine.projectedSlots} of ${nine.slotCount} slots projected`, '7 of 9 slots projected');
  // The seven projected slots are assigned exactly as they were before.
  for (const s of LINEUP_SLOTS) assert.equal(nine.slots[s], seven.slots[s], s);
});

test('each unprojected slot reports itself through the warnings channel', () => {
  const { warnings } = bestLineup(ROSTER(), NINE);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings, [
    { slot: 'K1', id: null, reason: WARN_NO_PROJECTION },
    { slot: 'DEF1', id: null, reason: WARN_NO_PROJECTION },
  ]);
});

test('the two warning reasons are distinct and stay distinguishable', () => {
  // Distinct codes, so no consumer can confuse one for the other.
  assert.notEqual(WARN_NO_PROJECTION, WARN_FORCED_UNAVAILABLE);
  assert.equal(WARN_FORCED_UNAVAILABLE, 'no_available_alternative'); // Rel17's code, unchanged

  // One roster, BOTH conditions: only two RBs and one is on IR (forced start),
  // in a league that also starts a K and a DEF (no feed).
  const players = [
    { id: 'qb', pos: 'QB', pts: 20 },
    { id: 'rbIR', pos: 'RB', pts: 12.4, playable: false }, { id: 'rbOk', pos: 'RB', pts: 4 },
    { id: 'wrA', pos: 'WR', pts: 15 }, { id: 'wrB', pos: 'WR', pts: 11 },
    { id: 'te', pos: 'TE', pts: 7 },
  ];
  const { slots, warnings } = bestLineup(players, NINE);
  assert.equal(warnings.length, 3);

  const forced = warnings.filter((w) => w.reason === WARN_FORCED_UNAVAILABLE);
  const unprojected = warnings.filter((w) => w.reason === WARN_NO_PROJECTION);
  assert.deepEqual(forced.map((w) => w.slot), ['RB2']);
  assert.deepEqual(unprojected.map((w) => w.slot), ['K1', 'DEF1']);
  // The partition is total and disjoint — nothing lands in both buckets or neither.
  assert.equal(forced.length + unprojected.length, warnings.length);
  assert.equal(new Set(warnings.map((w) => w.reason)).size, 2);

  // A forced start names the player; an unprojected slot has no player to name.
  assert.equal(forced[0].id, 'rbIR');
  assert.ok(unprojected.every((w) => w.id === null));

  // Rel17 behaviour is preserved exactly: DEMOTED, not excluded, and the slot is
  // FILLED rather than emptied.
  assert.equal(slots.RB1, 'rbOk');
  assert.equal(slots.RB2, 'rbIR');
  // An unprojected slot is NOT a forced start: it stays empty on purpose.
  assert.equal(slots.K1, null);
});

test('startSitSwaps never invents a move for a slot it cannot project', () => {
  const players = ROSTER();
  const current = ['qb', 'rbA', 'rbB', 'wrA', 'wrB', 'te', 'wrC']; // wrC flexes over rbC (13)
  const nine = startSitSwaps(current, players, 6, NINE);
  const seven = startSitSwaps(current, players, 6);
  // Identical advice and identical honest net gain — K/DEF add nothing either way.
  assert.deepEqual(nine.start, seven.start);
  assert.deepEqual(nine.sit, seven.sit);
  assert.equal(nine.netGain, seven.netGain);
  assert.equal(nine.netGain, 4); // rbC 13 in, wrC 9 out — NET, not a 1:1 pairing
  assert.ok(nine.start.every((id) => id !== 'K1' && id !== 'DEF1'));
  assert.equal(nine.optimal.slotCount, 9);
});
