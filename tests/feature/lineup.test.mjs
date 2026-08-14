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
  bestLineup, startSitSwaps, lineupGeometry, isProjectedPosition, canonPosition,
  LINEUP_SLOTS, PROJECTED_POSITIONS, WARN_FORCED_UNAVAILABLE, WARN_NO_PROJECTION,
  __selftest,
} from '../../app/lineup.js';
import { DEFAULT_PROFILE, normalizeProfile, applyScoring } from '../../app/league.js';
import {
  shapeKdst, fedPositions, teamByeWeeks, omittedKeys, positionKeyUniverse,
  canonKdstPosition, isKdstPosition, KDST_POSITIONS,
  __selftest as kdstSelftest,
} from '../../app/kdst.js';

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

/* ---------------------------------------------------------------------------
 * R20-B1 — the K/DST feed fills the slots R19 drew.
 *
 * app/kdst.js is the lineup's data layer, so it is locked here alongside the
 * optimizer it feeds (tests/feature/kdst.test.mjs belongs to the builder that
 * produces the contract, not to the surface that consumes it).
 *
 * The failures these lock out, in order of how easy each is to ship by accident:
 *   - the "no feed" path quietly deleted because the file happens to exist today;
 *   - a season total presented as a week;
 *   - a D/ST total that omits components the league scores, shown as complete;
 *   - K/DST breaking Rel17 demotion or the honest net gain;
 *   - anything at all moving for a user with no league profile.
 * ------------------------------------------------------------------------- */

const KD_ROSTER = () => [
  ...ROSTER(),
  { id: 'kA', pos: 'K', pts: 9.5 }, { id: 'kB', pos: 'K', pts: 7.1 },
  { id: 'dA', pos: 'DEF', pts: 8.2 },
];
const FEEDS = { feeds: ['K', 'DEF', 'DST'] };

/** A 9-starter league whose defense slot is spelled DST rather than DEF. */
const NINE_DST = normalizeProfile({
  shape: {
    roster_positions: [
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ],
  },
});

test('kdst self-check passes', () => {
  assert.equal(kdstSelftest(), true);
});

/* ---- backward compatibility: nothing moves without a league profile ---- */

test('R20 changes NOTHING for a user with no league profile', () => {
  const before = bestLineup(ROSTER());
  // Same call with the K/DST feed connected and K/DST players on the roster:
  // the default league starts neither, so the answer is identical.
  const after = bestLineup(KD_ROSTER(), undefined, FEEDS);
  assert.deepEqual(after.slotIds, [...LINEUP_SLOTS]);
  assert.equal(after.slotCount, 7);
  assert.equal(after.projectedSlots, 7);
  assert.equal(after.total, before.total);
  for (const s of LINEUP_SLOTS) assert.equal(after.slots[s], before.slots[s], s);
  assert.deepEqual(after.warnings, []);
  // The K and DEF the default league cannot start are on the bench, not lost.
  for (const id of ['kA', 'kB', 'dA']) assert.ok(after.bench.includes(id), id);
  // And the geometry helper is untouched either way.
  assert.deepEqual(lineupGeometry(undefined, FEEDS).map((g) => g.slot), [...LINEUP_SLOTS]);
  assert.ok(lineupGeometry(undefined, FEEDS).every((g) => g.projected));
});

test('PROJECTED_POSITIONS still describes player_projections.json alone', () => {
  // The K/DST contract is a SEPARATE file. Widening this constant would claim
  // data/player_projections.json covers kickers, which it does not.
  assert.deepEqual([...PROJECTED_POSITIONS], ['QB', 'RB', 'WR', 'TE']);
  assert.equal(isProjectedPosition('K'), false);
  assert.equal(isProjectedPosition('DEF'), false);
});

/* ---- the slots fill, and the count follows reality ---- */

test('with the feed connected, K and DEF fill and the count becomes 9 of 9', () => {
  const l = bestLineup(KD_ROSTER(), NINE, FEEDS);
  assert.equal(l.slotCount, 9);
  assert.equal(l.projectedSlots, 9);
  assert.equal(l.slots.K1, 'kA');    // the better kicker, 9.5 over 7.1
  assert.equal(l.slots.DEF1, 'dA');
  assert.deepEqual(l.warnings, [], 'a fed slot has nothing to warn about');
  assert.ok(l.bench.includes('kB'), 'the backup kicker benches');
  // The seven offensive slots are assigned exactly as they were before.
  const seven = bestLineup(ROSTER());
  for (const s of LINEUP_SLOTS) assert.equal(l.slots[s], seven.slots[s], s);
  // And the total is the old total plus exactly the two new starters.
  assert.equal(Math.round((l.total - seven.total) * 10) / 10, 17.7);
});

test('the coverage count is read off the lineup, never hardcoded', () => {
  const cover = (o) => `${o.projectedSlots} of ${o.slotCount}`;
  assert.equal(cover(bestLineup(KD_ROSTER(), NINE)), '7 of 9');              // no feed
  assert.equal(cover(bestLineup(KD_ROSTER(), NINE, { feeds: ['K'] })), '8 of 9');
  assert.equal(cover(bestLineup(KD_ROSTER(), NINE, FEEDS)), '9 of 9');
  assert.equal(cover(bestLineup(ROSTER())), '7 of 7');                       // default league
});

test('the unprojected path stays reachable and correct when the feed is gone', () => {
  // A 404, an empty contract, a deploy that predates the builder: the caller
  // passes no feeds and R19-B5 behaviour must be byte-for-byte intact.
  for (const opts of [undefined, {}, { feeds: [] }, { feeds: null }]) {
    const l = bestLineup(KD_ROSTER(), NINE, opts);
    assert.equal(l.slots.K1, null, 'slot present but empty');
    assert.equal(l.slots.DEF1, null);
    assert.equal(l.projectedSlots, 7);
    assert.equal(l.slotCount, 9);
    assert.equal(l.total, bestLineup(ROSTER()).total, 'worth nothing, never a fabricated 0.0');
    assert.deepEqual(l.warnings, [
      { slot: 'K1', id: null, reason: WARN_NO_PROJECTION },
      { slot: 'DEF1', id: null, reason: WARN_NO_PROJECTION },
    ]);
    // The K/DST players are still on the roster — demoted to the bench, not erased.
    for (const id of ['kA', 'kB', 'dA']) assert.ok(l.bench.includes(id), id);
  }
});

test('a feed is honoured per position, not all-or-nothing', () => {
  // The contract ships kickers but its `defenses` array is empty.
  const l = bestLineup(KD_ROSTER(), NINE, { feeds: ['K'] });
  assert.equal(l.slots.K1, 'kA');
  assert.equal(l.slots.DEF1, null);
  assert.equal(l.projectedSlots, 8);
  assert.deepEqual(l.warnings, [{ slot: 'DEF1', id: null, reason: WARN_NO_PROJECTION }]);
});

test('DST and DEF are one roster spot under two spellings', () => {
  assert.equal(canonPosition('DST'), 'DEF');
  assert.equal(canonPosition('def'), 'DEF');
  assert.equal(canonPosition('WR'), 'WR');
  assert.equal(canonKdstPosition('DST'), 'DEF');
  assert.ok(isKdstPosition('DST') && isKdstPosition('K') && !isKdstPosition('WR'));
  assert.deepEqual([...KDST_POSITIONS], ['K', 'DEF']);
  // A league whose slot token is DST is fed by the DEF rows.
  const l = bestLineup(KD_ROSTER(), NINE_DST, FEEDS);
  assert.equal(l.slots.DST1, 'dA');
  assert.equal(l.projectedSlots, 9);
  // ...and a DEF row still cannot reach a flex slot: FLEX is WR/RB/TE.
  assert.equal(l.slots.FLEX, 'rbC');
});

/* ---- Rel17 behaviour is preserved for the new positions ---- */

test('Rel17 holds for kickers: DEMOTED not excluded, forced starts flagged', () => {
  const players = [
    ...ROSTER(),
    { id: 'kIR', pos: 'K', pts: 14.0, playable: false },
    { id: 'dA', pos: 'DEF', pts: 8.2 },
  ];
  // Only one kicker and he cannot play -> the slot is FILLED and flagged, never
  // emptied, and never called optimal.
  const l = bestLineup(players, NINE, FEEDS);
  assert.equal(l.slots.K1, 'kIR', 'forced slot is filled, not emptied');
  assert.deepEqual(l.warnings, [{ slot: 'K1', id: 'kIR', reason: WARN_FORCED_UNAVAILABLE }]);
  assert.notEqual(WARN_FORCED_UNAVAILABLE, WARN_NO_PROJECTION);

  // Add an available kicker worth far less: he takes the slot anyway.
  const withBackup = [...players, { id: 'kOk', pos: 'K', pts: 3.1 }];
  const better = bestLineup(withBackup, NINE, FEEDS);
  assert.equal(better.slots.K1, 'kOk', 'an available 3.1 beats an unavailable 14.0');
  assert.deepEqual(better.warnings, [], 'a benched unavailable player is not a warning');
  assert.ok(better.bench.includes('kIR'), 'demoted to the bench, not excluded from the roster');
});

test('start/sit reports the honest NET gain once K/DST are in the lineup', () => {
  const players = KD_ROSTER();
  // The manager starts the WEAKER kicker and no defense at all.
  const current = ['qb', 'rbA', 'rbB', 'wrA', 'wrB', 'te', 'rbC', 'kB'];
  const m = startSitSwaps(current, players, 6, NINE, FEEDS);
  assert.ok(m.start.includes('kA') && m.start.includes('dA'));
  assert.ok(m.sit.includes('kB'));
  // NET, not a 1:1 pairing: (kA 9.5 - kB 7.1) + dA 8.2 = 10.6.
  assert.equal(m.netGain, 10.6);
  assert.equal(m.optimal.slotCount, 9);
  // A slot id is never mistaken for a player id.
  assert.ok(m.start.every((id) => id !== 'K1' && id !== 'DEF1'));
});

/* ---- app/kdst.js: shaping, scoring, partial totals, byes ---- */

test('shapeKdst scores the stat line under the CONNECTED league, not the contract total', () => {
  const raw = {
    games_projected: 10,
    modelled_keys: { K: ['xpm'], DEF: ['sack'] },
    kickers: [{ player_id: 'k1', name: 'K One', team: 'HOU', position: 'K', stats: { xpm: 30 }, proj_points: 999 }],
    defenses: [{ player_id: 'd1', name: 'D One', team: 'DEN', position: 'DEF', stats: { sack: 40 }, proj_points: 999 }],
  };
  const idx = shapeKdst(raw);
  // proj_points: 999 is IGNORED — the number comes from applyScoring.
  assert.equal(idx.byId.get('k1').seasonPoints, 30);   // xpm 1 pt
  assert.equal(idx.byId.get('d1').seasonPoints, 40);   // sack 1 pt
  // A double-PPR-ish custom league that pays 3 per sack recomputes exactly.
  const custom = shapeKdst(raw, { scoring: { ...DEFAULT_PROFILE.scoring, sack: 3 } });
  assert.equal(custom.byId.get('d1').seasonPoints, 120);
  assert.equal(custom.byId.get('d1').weeklyPoints, 12);
});

test('a K/DST week is a flat season average, and is carried as one', () => {
  const idx = shapeKdst({
    games_projected: 4,
    modelled_keys: { K: ['xpm'] },
    kickers: [{ player_id: 'k1', name: 'K', team: 'HOU', position: 'K', stats: { xpm: 10 } }],
    defenses: [],
  });
  const k = idx.byId.get('k1');
  assert.equal(k.seasonPoints, 10);
  assert.equal(k.weeklyPoints, 2.5);
  assert.equal(k.games, 4);
  assert.equal(Math.round(k.weeklyPoints * k.games * 100) / 100, k.seasonPoints);
});

test('a D/ST total that omits scored components is marked PARTIAL and names them', () => {
  const raw = {
    games_projected: 17,
    modelled_keys: { K: ['xpm'], DEF: ['sack'] },
    unmodelled_keys: [
      { key: 'def_4_and_stop', label: '4th-down stop', position: 'DEF', reason: 'no play-by-play column' },
      { key: 'def_st_ff', label: 'ST forced fumble', position: 'DEF', reason: 'not separable' },
    ],
    partial_scoring: { K: false, DEF: true },
    kickers: [{ player_id: 'k1', name: 'K', team: 'HOU', position: 'K', stats: { xpm: 34 } }],
    defenses: [{ player_id: 'd1', name: 'D', team: 'DEN', position: 'DEF', stats: { sack: 51 } }],
  };
  // The contract declares what it could not model, regardless of any league.
  assert.deepEqual(positionKeyUniverse(raw, 'DEF'), ['sack', 'def_4_and_stop', 'def_st_ff']);
  assert.deepEqual(positionKeyUniverse(raw, 'DST'), ['sack', 'def_4_and_stop', 'def_st_ff']);
  assert.deepEqual(positionKeyUniverse(raw, 'K'), ['xpm']);

  // A league that does NOT score those keys omits nothing — marking it would be
  // a false alarm, and a badge that cries wolf is worse than no badge.
  const plain = shapeKdst(raw);
  assert.equal(plain.byId.get('d1').partial, false);
  assert.deepEqual(plain.byId.get('d1').omitted, []);

  // A league that DOES score one gets a marked, itemised total.
  const paying = shapeKdst(raw, { scoring: { ...DEFAULT_PROFILE.scoring, def_4_and_stop: 2 } });
  const d = paying.byId.get('d1');
  assert.equal(d.partial, true);
  assert.equal(d.omitted.length, 1);
  assert.equal(d.omitted[0].key, 'def_4_and_stop');
  assert.equal(d.omitted[0].label, '4th-down stop');
  assert.equal(d.omitted[0].points_per, 2);
  assert.match(d.omitted[0].reason, /play-by-play/);
  // The arithmetic is IDENTICAL — which is exactly why the marker has to exist.
  assert.equal(d.seasonPoints, plain.byId.get('d1').seasonPoints);
  // A D/ST gap never marks a kicker: the key does not belong to that position.
  assert.equal(paying.byId.get('k1').partial, false);
  // Scoring an unmodelled key at ZERO omits nothing worth naming.
  const zero = shapeKdst(raw, { scoring: { ...DEFAULT_PROFILE.scoring, def_4_and_stop: 0 } });
  assert.equal(zero.byId.get('d1').partial, false);
  // omittedKeys is directly callable and agrees with the shaped entry.
  assert.deepEqual(
    omittedKeys(raw, { sack: 51 }, 'DEF', { scoring: { ...DEFAULT_PROFILE.scoring, def_4_and_stop: 2 } })
      .map((o) => o.key),
    ['def_4_and_stop'],
  );
});

test('shapeKdst degrades to NO FEED rather than to a fabricated one', () => {
  for (const bad of [null, undefined, 0, 'x', [], {}, { games_projected: 0, kickers: [{}] },
    { games_projected: 17 }, { games_projected: 17, kickers: [], defenses: [] }]) {
    const idx = shapeKdst(bad);
    assert.equal(idx.ok, false);
    assert.deepEqual(idx.positions, []);
    assert.deepEqual(fedPositions(idx), []);
    assert.equal(idx.byId.size, 0);
  }
  // A row with no stat line has nothing honest to score, so it is dropped —
  // not scored as zero and offered as a starter.
  const idx = shapeKdst({
    games_projected: 17,
    kickers: [{ player_id: 'k1', position: 'K' }, { player_id: 'k2', position: 'K', stats: { xpm: 17 } }],
    defenses: [],
  });
  assert.equal(idx.byId.has('k1'), false);
  assert.equal(idx.byId.has('k2'), true);
  assert.deepEqual(idx.positions, ['K']);
  assert.deepEqual(fedPositions(idx), ['K'], 'no defenses -> no DST feed either');
});

test('fedPositions is what keeps the unprojected path one failed fetch away', () => {
  const both = shapeKdst({
    games_projected: 17,
    kickers: [{ player_id: 'k', position: 'K', stats: { xpm: 1 } }],
    defenses: [{ player_id: 'd', position: 'DEF', stats: { sack: 1 } }],
  });
  assert.deepEqual(fedPositions(both), ['K', 'DEF', 'DST']);
  assert.deepEqual(fedPositions(null), []);
  // Feeding bestLineup straight from a failed fetch reproduces R19-B5 exactly.
  const l = bestLineup(KD_ROSTER(), NINE, { feeds: fedPositions(shapeKdst(null)) });
  assert.equal(l.projectedSlots, 7);
  assert.equal(l.slots.K1, null);
});

test('K/DST byes come from the schedule, and only when unambiguous', () => {
  const byes = teamByeWeeks({
    games: [
      { week: 1, home: 'DEN', away: 'HOU' },
      { week: 2, home: 'DEN', away: 'KC' },
      { week: 3, home: 'HOU', away: 'KC' },
    ],
  });
  assert.equal(byes.get('DEN'), 3);
  assert.equal(byes.get('HOU'), 2);
  assert.equal(byes.get('KC'), 1);
  // No schedule, or a team missing two weeks, yields no claim rather than a guess.
  assert.equal(teamByeWeeks(null).size, 0);
  assert.equal(teamByeWeeks({ games: [] }).size, 0);
  const ambiguous = teamByeWeeks({
    games: [
      { week: 1, home: 'DEN', away: 'HOU' }, { week: 2, home: 'KC', away: 'SF' },
      { week: 3, home: 'KC', away: 'SF' }, { week: 4, home: 'KC', away: 'SF' },
    ],
  });
  assert.equal(ambiguous.has('DEN'), false, 'two missing weeks is not a bye');
  assert.equal(ambiguous.get('KC'), 1);
});

/* ---- the committed contract itself ---- */

test('the committed K/DST contract shapes, and reproduces its own totals exactly', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../../data/kdst_projections.json', import.meta.url), 'utf8'));
  const idx = shapeKdst(raw);
  assert.equal(idx.ok, true);
  assert.deepEqual(idx.positions, ['K', 'DEF']);
  assert.deepEqual(fedPositions(idx), ['K', 'DEF', 'DST']);
  assert.ok(idx.games > 0);
  assert.equal(idx.byPosition.DEF.length, 32, 'all 32 team defenses');
  assert.ok(idx.byPosition.K.length > 0);

  for (const row of [...raw.kickers, ...raw.defenses]) {
    const e = idx.byId.get(String(row.player_id));
    assert.ok(e, `${row.player_id} shaped`);
    // The contract's proj_points is a DEFAULT-profile convenience total; our
    // recomputation from the stat line must land on it to the cent, or one of
    // the two is wrong and a manager cannot tell which.
    assert.ok(Math.abs(e.seasonPoints - Number(row.proj_points)) < 0.011,
      `${row.player_id}: ${e.seasonPoints} vs ${row.proj_points}`);
    assert.equal(e.seasonPoints, Math.round(applyScoring(row.stats, DEFAULT_PROFILE) * 100) / 100);
    assert.ok(e.weeklyPoints > 0 && e.weeklyPoints < 30, `${row.player_id} weekly in range`);
    // Under DEFAULT nothing is omitted — DEFAULT scores none of the unmodelled keys.
    assert.equal(e.partial, false);
  }

  // The declared-unmodelled keys really are ABSENT from every stat line, not zeroed.
  for (const u of raw.unmodelled_keys || []) {
    for (const row of raw.defenses) {
      assert.equal(Object.prototype.hasOwnProperty.call(row.stats, u.key), false,
        `${u.key} absent from ${row.player_id}`);
    }
  }
  // ...and a league that pays for them sees every defense marked partial.
  const paying = shapeKdst(raw, {
    scoring: { ...DEFAULT_PROFILE.scoring, def_4_and_stop: 2, def_st_ff: 1, def_st_fum_rec: 2 },
  });
  const marked = [...paying.byId.values()].filter((e) => e.partial);
  assert.equal(marked.length, 32, 'every defense, and only the defenses');
  assert.ok(marked.every((e) => e.pos === 'DEF'));
  assert.deepEqual(marked[0].omitted.map((o) => o.key).sort(),
    ['def_4_and_stop', 'def_st_ff', 'def_st_fum_rec']);
});

test('the committed schedule yields exactly one bye for every K/DST team', async () => {
  const { readFileSync } = await import('node:fs');
  const here = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const byes = teamByeWeeks(here('../../data/schedule_full.json'));
  const idx = shapeKdst(here('../../data/kdst_projections.json'));
  for (const e of idx.byId.values()) {
    assert.ok(byes.has(e.team), `${e.team} has a resolvable bye`);
  }
  // A defense on its bye is worth 0, exactly like everyone else, and benches.
  const d = idx.byPosition.DEF[0];
  const bye = byes.get(d.team);
  const players = [...ROSTER(),
    { id: 'kA', pos: 'K', pts: 9.5 },
    { id: d.id, pos: 'DEF', pts: 0 },          // the view zeroes a bye before this point
  ];
  const l = bestLineup(players, NINE, FEEDS);
  assert.ok(Number.isInteger(bye) && bye >= 1 && bye <= 18);
  assert.equal(l.slots.DEF1, d.id, 'the only defense still fills the slot');
  assert.equal(l.total, bestLineup(ROSTER()).total + 9.5, 'a bye adds nothing');
});

test('a league that scores nothing a kicker does gets NO kicker number, not 0.0', () => {
  // The defect this locks out was found in the browser, not in a unit test: a
  // profile whose scoring table omits every kicking key made applyScoring
  // return 0, and the lineup printed "0.0" for Ka'imi Fairbairn — a fabricated
  // projection dressed as a real one. 0 here is a fact about the SCORING TABLE.
  const raw = {
    games_projected: 17,
    modelled_keys: { K: ['xpm', 'fgm_30_39'], DEF: ['sack', 'int'] },
    kickers: [{ player_id: 'k1', name: 'K', team: 'HOU', position: 'K', stats: { xpm: 34, fgm_30_39: 17 } }],
    defenses: [{ player_id: 'd1', name: 'D', team: 'DEN', position: 'DEF', stats: { sack: 51, int: 17 } }],
  };
  const recOnly = shapeKdst(raw, { scoring: { rec: 1 } });
  assert.equal(recOnly.byId.get('k1').unscored, true);
  assert.equal(recOnly.byId.get('d1').unscored, true);
  assert.deepEqual(recOnly.byId.get('k1').scoredKeys, []);
  // NOT FED: there is no honest number, so the slot must not claim to be projected.
  assert.equal(recOnly.ok, false);
  assert.deepEqual(fedPositions(recOnly), []);
  // ...and the reason is recorded separately from "the file is missing".
  assert.deepEqual(recOnly.unscoredPositions, ['K', 'DEF']);
  assert.deepEqual(shapeKdst(null).unscoredPositions, [], 'no rows is not "unscored"');

  const l = bestLineup(KD_ROSTER(), NINE, { feeds: fedPositions(recOnly) });
  assert.equal(l.projectedSlots, 7);
  assert.equal(l.slots.K1, null);
  assert.deepEqual(l.warnings.map((w) => w.reason), [WARN_NO_PROJECTION, WARN_NO_PROJECTION]);

  // A league that scores ONE kicking key can value kickers, and does.
  const partialTable = shapeKdst(raw, { scoring: { rec: 1, xpm: 1 } });
  assert.equal(partialTable.byId.get('k1').unscored, false);
  assert.equal(partialTable.byId.get('k1').seasonPoints, 34);
  assert.deepEqual(partialTable.byId.get('k1').scoredKeys, ['xpm']);
  assert.deepEqual(partialTable.unscoredPositions, ['DEF'], 'per position, not all-or-nothing');
  assert.deepEqual(fedPositions(partialTable), ['K']);

  // A key scored at ZERO is not a key the league pays for.
  assert.equal(shapeKdst(raw, { scoring: { rec: 1, xpm: 0 } }).byId.get('k1').unscored, true);

  // Under the real DEFAULT profile every committed row is valuable.
  const full = shapeKdst(raw);
  assert.equal(full.byId.get('k1').unscored, false);
  assert.deepEqual(full.unscoredPositions, []);
});
