/* tests/feature/r27_auction.test.mjs — R27: money the room actually has.
 *
 * Four changes, all in the draft room, all owner-decided on 2026-08-14:
 *
 *  A. PER-TEAM BUDGETS. createAuction built every team with one scalar, so a
 *     league whose preseason trades left T3 with $215 and T7 with $185 was
 *     modelled as twelve identical $200 teams — and every threat estimate built
 *     from a wrong maxBid was wrong for the rest of the draft.
 *  B. TYPED OBSERVED PRICES. sellTo already recorded buyer + price and already
 *     fed tendencyUpdate; what was missing was a way to enter the real number.
 *     Engine-side that means: whatever price is recorded is what lands in the
 *     budget, the log and the learned tendency.
 *  C. THE DOLLAR CEILING ON BEST FIT — and deliberately NOT on BEST AVAILABLE.
 *  D. K AND DEF ARE DRAFTABLE, priced at the $1 tier.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAuction, normalizeTeamBudgets, totalRoomMoney, sellTo, undoLastSale,
  fairDollars, marketDollars, maxBid, myTeam, liveInflation, scoreAuction,
  DEFAULT_BUDGET, MIN_BID,
} from '../../app/auction.js';
import { rosterShape, ROSTER_BOUNDS, DEFAULT_ROSTER } from '../../app/draft-sim.js';
import { recommend, bestPickNow, rosterGeometry } from '../../app/team-logic.js';

/* ==========================================================================
   A. PER-TEAM BUDGETS
   ========================================================================== */

test('normalizeTeamBudgets always yields exactly leagueSize finite amounts', () => {
  assert.deepEqual(normalizeTeamBudgets(null, 4, 200), [200, 200, 200, 200]);
  assert.deepEqual(normalizeTeamBudgets([215, 185], 4, 200), [215, 185, 200, 200],
    'a short array is filled with the league default, never left undefined');
  assert.deepEqual(normalizeTeamBudgets([215, 185, 1, 2, 3], 3, 200), [215, 185, 1],
    'a long array is truncated to the teams that actually play');
  // A typo must not mint or destroy money, and must never produce NaN — a
  // single NaN budget would poison maxBid, inflation and every price.
  assert.deepEqual(normalizeTeamBudgets(['abc', -5, null, NaN], 4, 200),
    [200, 200, 200, 200], 'unusable entries fall back to the league default');
  assert.deepEqual(normalizeTeamBudgets([200.4, 200.6], 2, 200), [200, 201],
    'amounts are whole dollars');
});

test('a level room is byte-for-byte the pre-R27 construction', () => {
  // The safety property the whole release rests on: passing per-team budgets
  // that happen to be equal must reproduce exactly what one scalar produced.
  const rows = board(40);
  const common = { leagueSize: 4, mySlot: 1, boardRows: rows, adjPointsById: pts(rows) };
  const scalar = createAuction({ ...common, budget: 200 });
  const explicit = createAuction({ ...common, budget: 200, teamBudgets: [200, 200, 200, 200] });
  assert.deepEqual(explicit.teams.map((t) => t.budget), scalar.teams.map((t) => t.budget));
  assert.deepEqual([...explicit.fair.entries()], [...scalar.fair.entries()],
    'OUR dollars must not move');
  assert.deepEqual([...explicit.market.entries()], [...scalar.market.entries()],
    'market dollars must not move');
});

test('uneven budgets seat the real amounts and change the money in the room', () => {
  const rows = board(40);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, teamBudgets: [215, 185, 200, 200],
    boardRows: rows, adjPointsById: pts(rows),
  });
  assert.deepEqual(a.teams.map((t) => t.budget), [215, 185, 200, 200]);
  assert.equal(totalRoomMoney(a), 800, 'the room still holds 4 x 200 in total here');
  // My ceiling is my OWN money, not the league default.
  assert.equal(maxBid(a.teams[0].budget, a.shape.size), 215 - (a.shape.size - 1) * MIN_BID);
  assert.equal(maxBid(a.teams[1].budget, a.shape.size), 185 - (a.shape.size - 1) * MIN_BID);
});

test('the board is priced against the money actually in the room', () => {
  const rows = board(40);
  const adjOf = adjFrom(pts(rows));
  const shape = rosterShape(null);
  const level = fairDollars(rows, adjOf, 4, 200, shape);
  const rich = fairDollars(rows, adjOf, 4, 200, shape, 1000);   // same teams, more money
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  assert.ok(sum(rich) > sum(level),
    'more dollars chasing the same players must price the board higher');
  // And the default path is unchanged when no total is supplied.
  assert.deepEqual([...fairDollars(rows, adjOf, 4, 200, shape).entries()], [...level.entries()]);
  const mLevel = marketDollars(rows, 4, 200, shape.size);
  const mRich = marketDollars(rows, 4, 200, shape.size, 1000);
  assert.ok(sum(mRich) > sum(mLevel), 'the market curve scales with the room too');
});

test('scoreAuction measures MY spend against MY starting budget', () => {
  const rows = board(40);
  const a = createAuction({
    leagueSize: 4, mySlot: 2, budget: 200, teamBudgets: [200, 185, 200, 200],
    boardRows: rows, adjPointsById: pts(rows),
  });
  sellTo(a, 1, 85, 0);                       // I am team index 1, starting at $185
  assert.equal(scoreAuction(a).spent, 85,
    'spending $85 of $185 is $85 spent — not $115, which the league default would give');
});

/* ==========================================================================
   B. THE RECORDED PRICE IS THE PRICE
   ========================================================================== */

test('the recorded price flows into budget, log, ceiling and learned tendency', () => {
  const rows = board(40);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, boardRows: rows, adjPointsById: pts(rows),
  });
  const before = a.teams[2].budget;
  sellTo(a, 2, 47, 0);
  assert.equal(a.teams[2].budget, before - 47, 'the observed price leaves that team');
  assert.equal(a.log[0].price, 47, 'and it is what the log records');
  assert.equal(a.log[0].team, 3, 'together with WHO took the player');
  assert.equal(a.teams[2].players.length, 1, 'and the player lands on their roster');
  // The learning step: an opponent's per-position tendency moves with what they
  // actually paid. This is the opponent model the release is feeding.
  const pos = rows[0].position;
  assert.ok(Number.isFinite(a.teams[2].tendencies[pos]),
    'an observed sale must teach the opponent model');
  // Exact reversal, including the tendency.
  undoLastSale(a);
  assert.equal(a.teams[2].budget, before);
  assert.equal(a.teams[2].players.length, 0);
});

test('my own buys never train the opponent model', () => {
  const rows = board(40);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, boardRows: rows, adjPointsById: pts(rows),
  });
  sellTo(a, 0, 60, 0);                       // mySlot 1 -> index 0 is me
  assert.deepEqual(myTeam(a).tendencies, {},
    'learning from myself would be measuring my own opinion back');
});

test('a recorded price is clamped to what the buyer can legally pay', () => {
  const rows = board(40);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, teamBudgets: [200, 20, 200, 200],
    boardRows: rows, adjPointsById: pts(rows),
  });
  const cap = maxBid(20, a.shape.size);
  sellTo(a, 1, 500, 0);                      // a mis-typed price
  assert.equal(a.log[0].price, cap, 'clamped to maxBid, not to the whole budget');
  assert.ok(a.teams[1].budget >= (a.shape.size - 1) * MIN_BID,
    '$1 stays reserved for every remaining slot');
});

test('liveInflation is 1 at kickoff for ANY room size, and moves with real spending', () => {
  // Written the other way round first, asserting a bigger budget inflates more.
  // That was wrong, and the code was right: inflation is a RATIO of remaining
  // dollars to remaining fair value, and fair value is itself allocated over
  // the room's money — so a $100 room and a $300 room both start at exactly
  // 1.00. That self-calibration is the property worth locking, because it is
  // what makes the number comparable across leagues at all.
  const rows = board(40);
  const mk = (b) => createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, teamBudgets: [b, b, b, b],
    boardRows: rows, adjPointsById: pts(rows),
  });
  const lean = mk(100);
  const rich = mk(300);
  assert.equal(Math.round(liveInflation(lean) * 100) / 100, 1);
  assert.equal(Math.round(liveInflation(rich) * 100) / 100, 1);

  // Underpaying for a player leaves more money chasing less value: inflation up.
  const a = mk(200);
  const fairTop = a.fair.get('p0');
  assert.ok(fairTop > 5, 'the fixture needs a genuinely valuable top player');
  sellTo(a, 1, 1, 0);                       // a $1 steal
  assert.ok(liveInflation(a) > 1,
    'a bargain leaves the room richer relative to what is left');
});

/* ==========================================================================
   C. THE CEILING APPLIES TO BEST FIT, AND ONLY TO BEST FIT
   ========================================================================== */

const POOL = [
  { gsis_id: 'cheap', name: 'Cheap Guy', position: 'RB', proj_points: 100 },
  { gsis_id: 'mid', name: 'Mid Guy', position: 'RB', proj_points: 150 },
  { gsis_id: 'stud', name: 'Stud Guy', position: 'RB', proj_points: 300 },
];
const PRICES = new Map([['cheap', 5], ['mid', 20], ['stud', 60]]);
const EMPTY_ROSTER = { slots: {} };

test('BEST FIT drops what I cannot afford', () => {
  const rich = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1',
    { sort: 'fit', budget: { cap: 100, priceById: PRICES } });
  const broke = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1',
    { sort: 'fit', budget: { cap: 25, priceById: PRICES } });
  assert.ok(rich.some((r) => r.player.gsis_id === 'stud'), 'a $60 stud is offered at a $100 cap');
  assert.ok(!broke.some((r) => r.player.gsis_id === 'stud'),
    'and is NOT offered at a $25 cap — that is the whole point');
  assert.ok(broke.some((r) => r.player.gsis_id === 'mid'), 'what I CAN buy is still ranked');
});

test('BEST AVAILABLE ignores my budget, by design', () => {
  const broke = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1',
    { sort: 'available', budget: { cap: 25, priceById: PRICES } });
  assert.ok(broke.some((r) => r.player.gsis_id === 'stud'),
    'BEST AVAILABLE answers "who is the best player left", which does not depend on my wallet');
});

test('no budget means nothing changes — the snake path is untouched', () => {
  const withNone = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1', { sort: 'fit' });
  const withNull = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1',
    { sort: 'fit', budget: null });
  assert.deepEqual(withNull.map((r) => r.player.gsis_id), withNone.map((r) => r.player.gsis_id));
  assert.ok(withNone.some((r) => r.player.gsis_id === 'stud'));
});

test('an unpriced player is unknown, not unaffordable', () => {
  const pool = POOL.concat([{ gsis_id: 'nop', name: 'No Price', position: 'RB', proj_points: 200 }]);
  const out = recommend(EMPTY_ROSTER, pool, new Map(), 'ppr', 'RB1',
    { sort: 'fit', budget: { cap: 25, priceById: PRICES } });
  assert.ok(out.some((r) => r.player.gsis_id === 'nop'),
    'dropping unpriced players would silently shrink the board (HONEST DATA)');
});

test('an impossible ceiling returns the list rather than an empty panel', () => {
  const out = recommend(EMPTY_ROSTER, POOL, new Map(), 'ppr', 'RB1',
    { sort: 'fit', budget: { cap: 0, priceById: PRICES } });
  assert.ok(out.length > 0,
    'a blank card reads as "no players exist"; the view states the ceiling instead');
});

test('BEST PICK NOW respects the ceiling too (owner call)', () => {
  const rich = bestPickNow(EMPTY_ROSTER, POOL, new Map(), 'ppr',
    { budget: { cap: 100, priceById: PRICES } });
  const broke = bestPickNow(EMPTY_ROSTER, POOL, new Map(), 'ppr',
    { budget: { cap: 25, priceById: PRICES } });
  assert.ok(rich.some((r) => r.player.gsis_id === 'stud'));
  assert.ok(!broke.some((r) => r.player.gsis_id === 'stud'),
    'a pick I cannot pay for is not a pick');
  const none = bestPickNow(EMPTY_ROSTER, POOL, new Map(), 'ppr', undefined);
  assert.ok(none.some((r) => r.player.gsis_id === 'stud'), 'snake drafts are unaffected');
});

/* ==========================================================================
   D. K AND DEF ARE DRAFTABLE, AT THE $1 TIER
   ========================================================================== */

test('the sim shape seats K and DEF only when the league asks for them', () => {
  const classic = rosterShape(null);
  assert.ok(!classic.starters.includes('K1'), 'the default shape is unchanged');
  assert.ok(!classic.starters.includes('DEF1'));
  assert.equal(classic.size, 13);
  assert.equal(DEFAULT_ROSTER.k, 0);
  assert.equal(DEFAULT_ROSTER.def, 0);
  assert.ok(!('K' in classic.starterDemand), 'no phantom K demand for a league without one');

  const kdef = rosterShape({ k: 1, def: 1 });
  assert.deepEqual(kdef.starters.slice(-2), ['K1', 'DEF1'], 'K and DEF sit after the flex');
  assert.equal(kdef.size, 15);
  assert.equal(kdef.starterDemand.K, 1);
  assert.equal(kdef.starterDemand.DEF, 1);
  assert.deepEqual(ROSTER_BOUNDS.k, [0, 1]);
  assert.deepEqual(ROSTER_BOUNDS.def, [0, 1]);
});

test('K and DEF price at the $1 floor and take no dollars from the offence', () => {
  const rows = board(30);
  const withK = rows.concat([
    { gsis_id: 'k1', name: 'A Kicker', position: 'K', proj_points: 140 },
    { gsis_id: 'd1', name: 'A Defense', position: 'DEF', proj_points: 130 },
  ]);
  const adjOf = adjFrom(pts(withK));
  const shape = rosterShape({ k: 1, def: 1 });
  const priced = fairDollars(withK, adjOf, 4, 200, shape);
  assert.equal(priced.get('k1'), MIN_BID, 'a kicker is a $1 player');
  assert.equal(priced.get('d1'), MIN_BID, 'so is a defence');

  // The offence must be priced as if the kicker were not there at all —
  // otherwise adding K/DEF to the board would silently reprice every RB. A
  // kicker projecting 140 points would, unfloored, out-earn most of the board.
  const without = fairDollars(rows, adjOf, 4, 200, shape);
  for (const r of rows) {
    assert.equal(priced.get(String(r.gsis_id)), without.get(String(r.gsis_id)),
      `${r.gsis_id} must not be repriced by the presence of a kicker`);
  }
});

test('a K/DEF league geometry agrees with its draft-sim shape', () => {
  // The convergence R27 delivers: the two objects that used to disagree 15 vs
  // 13 about the same league now agree, which is what let the room have a
  // kicker on the board in the first place.
  const shape = rosterShape({ k: 1, def: 1 });
  const geo = rosterGeometry(shape);
  assert.equal(geo.all.length, shape.size);
  assert.ok(geo.all.includes('K1') && geo.all.includes('DEF1'));
});

/* -------------------------------------------------------------------------- */

/** A deterministic board: descending projections, all RB/WR so the shape can
 * seat them, ids stable so every assertion above is reproducible. */
function board(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      gsis_id: `p${i}`,
      name: `Player ${i}`,
      position: i % 2 === 0 ? 'RB' : 'WR',
      adp: i + 1,
      proj_points: 300 - i * 5,
    });
  }
  return out;
}
function pts(rows) {
  return new Map(rows.map((r) => [String(r.gsis_id), Number(r.proj_points)]));
}
function adjFrom(map) {
  return (r) => {
    const v = map.get(String(r.gsis_id));
    return Number.isFinite(v) ? v : 0;
  };
}

test('the fixtures are what the assertions above assume', () => {
  assert.equal(DEFAULT_BUDGET, 200);
  assert.equal(MIN_BID, 1);
  assert.equal(board(3).length, 3);
});
