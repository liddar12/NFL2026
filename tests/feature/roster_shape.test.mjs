/* tests/feature/roster_shape.test.mjs — R19-B4: roster shape is DATA.
 *
 * Locks the shape-aware paths added to app/team-logic.js, app/draft-sim.js and
 * app/auction.js:
 *   - rosterGeometry() normalises a LeagueProfile / a draft-sim rosterShape /
 *     nothing-at-all into one geometry, and the nothing-at-all case reproduces
 *     the frozen STARTER_SLOTS / BENCH_SLOTS / SLOT_ORDER / POSITION_CAPS,
 *   - caps derived from the shape (a 2-QB league may carry a THIRD QB, which
 *     the frozen {QB:2} forbade everywhere: reco panel, BEST PICK NOW, and
 *     every simulated opponent),
 *   - slot order / starter set derived from the shape (a 9-starter K+DEF league
 *     and a 2-QB league no longer lose slots, and fitScore counts every
 *     starter),
 *   - ONE replacement level and ONE flex rule shared by the fit engine and the
 *     auction engine, so team count actually moves VOR and the FLEX is not
 *     winner-takes-all in one engine and spread in the other.
 *
 * Backward compatibility is the headline assertion: with no shape argument the
 * arithmetic must be byte-for-byte what it was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STARTER_SLOTS, BENCH_SLOTS, SLOT_ORDER, POSITION_CAPS, STARTER_DEMAND,
  FLEX_WIN_SHARE, rosterGeometry, positionDemand, replacementIndex,
  slotEligible, positionAtCap, replacementLevel, vorScore, recommend,
  neediestOpenSlot, bestPickNow, fitScore,
} from '../../app/team-logic.js';
import { DEFAULT_PROFILE } from '../../app/league.js';
import { rosterShape, opponentNeeds, startersTotal } from '../../app/draft-sim.js';
import { fairDollars, MIN_BID } from '../../app/auction.js';

const WEEKS = 18;

/* ---- fixtures --------------------------------------------------------------- */

function mkWeekly(id, byeWk, perWeekPts, rec = 0) {
  const weeks = [];
  for (let wk = 1; wk <= WEEKS; wk += 1) {
    const bye = wk === byeWk;
    weeks.push({ wk, opp: bye ? null : 'OPP', home: wk % 2 === 0, bye, pts: bye ? 0 : perWeekPts });
  }
  return { gsis_id: id, receptions_prior: rec, weeks };
}

function mkPlayer(id, name, team, position, proj) {
  return { gsis_id: id, name, team, position, proj_points: proj, signals_used: [] };
}

function lookup(entries) {
  const m = new Map(entries.map((e) => [String(e.gsis_id), e]));
  const o = Object.fromEntries(m);
  Object.defineProperty(o, 'get', { value: (k) => m.get(String(k)) });
  Object.defineProperty(o, 'has', { value: (k) => m.has(String(k)) });
  return o;
}

function mkWeeklyMap(pool, byeWk = 0) {
  return lookup(pool.map((p) => mkWeekly(p.gsis_id, byeWk, p.proj_points / WEEKS)));
}

/** A ladder of `n` players at `pos`, points descending by `step` from `top`. */
function ladder(pos, n, top, step) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(mkPlayer(`${pos}-${i + 1}`, `${pos} ${i + 1}`, 'KC', pos, top - i * step));
  }
  return out;
}

/** Deep, symmetric pool: league-wide replacement indices land inside it. */
function deepPool() {
  return [
    ...ladder('QB', 30, 320, 4),
    ...ladder('RB', 45, 330, 4),
    ...ladder('WR', 45, 300, 4),
    ...ladder('TE', 25, 220, 4),
  ];
}

function slotsFor(geo, fill = {}) {
  const slots = {};
  geo.all.forEach((s) => { slots[s] = null; });
  return { slots: { ...slots, ...fill } };
}

/* ---- profiles under test ---------------------------------------------------- */

const P_2QB = {
  shape: {
    teams: 12,
    roster_positions: ['QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
};

const P_K_DEF = {
  shape: {
    teams: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
};

const P_SUPERFLEX = {
  shape: {
    teams: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
};

/* ---- BACKWARD COMPATIBILITY: no shape == the frozen constants ---------------- */

test('rosterGeometry(): no shape reproduces the frozen slots, caps and demand', () => {
  const geo = rosterGeometry(null);
  assert.deepEqual(geo.starters, [...STARTER_SLOTS]);
  assert.deepEqual(geo.bench, [...BENCH_SLOTS]);
  assert.deepEqual(geo.all, [...SLOT_ORDER]);
  // R47: K and DEF are started by default, so each gets a starter + one backup.
  assert.deepEqual(geo.caps, { ...POSITION_CAPS, K: 2, DEF: 2 });
  assert.deepEqual(geo.demand, { ...STARTER_DEMAND });
  assert.equal(geo.legacy, true);
  assert.deepEqual(rosterGeometry(undefined).all, [...SLOT_ORDER]);
});

test('rosterGeometry(): the DEFAULT profile and the default rosterShape agree with it', () => {
  const legacy = rosterGeometry(null);
  for (const shape of [DEFAULT_PROFILE, rosterShape(null)]) {
    const geo = rosterGeometry(shape);
    assert.deepEqual(geo.starters, legacy.starters);
    assert.deepEqual(geo.bench, legacy.bench);
    assert.deepEqual(geo.all, legacy.all);
    assert.deepEqual(geo.caps, legacy.caps);
    assert.deepEqual(geo.demand, legacy.demand);
    assert.deepEqual(geo.positions, legacy.positions);
  }
});

test('slotEligible(): the DEFAULT profile answers exactly like the no-shape path', () => {
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST'];
  SLOT_ORDER.forEach((slot) => {
    positions.forEach((pos) => {
      assert.equal(
        slotEligible(pos, slot, DEFAULT_PROFILE), slotEligible(pos, slot),
        `slotEligible(${pos}, ${slot}) must not move under the DEFAULT profile`,
      );
    });
  });
});

test('replacementLevel(): no shape keeps the per-roster, winner-takes-all FLEX rule', () => {
  // Identical RB/WR ladders except RB owns the single best player, so the
  // legacy flexAbsorbPos hands the whole FLEX to RB.
  const pool = [
    ...ladder('RB', 6, 400, 0), ...ladder('WR', 6, 350, 0),
  ];
  // Give both ladders real spreads under the top player.
  const shaped = pool.map((p, i) => ({ ...p, proj_points: (i % 6 === 0 ? p.proj_points : 300 - (i % 6) * 10) }));
  const weekly = mkWeeklyMap(shaped);
  const rb = replacementLevel(shaped, weekly, 'ppr', 'RB');
  const wr = replacementLevel(shaped, weekly, 'ppr', 'WR');
  assert.equal(rb, 270, 'RB demand 2 + the absorbed FLEX -> the 4th best RB');
  assert.equal(wr, 280, 'WR demand 2 with no FLEX bump -> the 3rd best WR');
  assert.notEqual(rb, wr, 'legacy FLEX is winner-takes-all');
});

/* ---- BUG #4: a 2-QB league may carry a third QB ------------------------------ */

test('caps: a 2-QB league caps QB at 3; the default league still caps it at 2', () => {
  assert.equal(rosterGeometry(P_2QB).caps.QB, 3);
  assert.equal(rosterGeometry(rosterShape({ qb: 2 })).caps.QB, 3);
  assert.equal(rosterGeometry(DEFAULT_PROFILE).caps.QB, 2);
  assert.equal(rosterGeometry(null).caps.QB, 2);
  // Non-QB caps are untouched by the QB count.
  assert.equal(rosterGeometry(P_2QB).caps.K, 1);
  assert.equal(rosterGeometry(P_2QB).caps.RB, undefined, 'RB stays uncapped');
});

test('positionAtCap(): 2 rostered QBs block a third only in a 1-QB league', () => {
  const geo = rosterGeometry(P_2QB);
  const byId = lookup([
    mkPlayer('q1', 'Q1', 'KC', 'QB', 300), mkPlayer('q2', 'Q2', 'BUF', 'QB', 290),
  ]);
  const slots = slotsFor(geo, { QB1: 'q1', QB2: 'q2' }).slots;
  assert.equal(positionAtCap('QB', slots, byId), true, 'frozen cap: no 3rd QB');
  assert.equal(positionAtCap('QB', slots, byId, P_2QB), false, '2-QB league wants a backup');
  assert.equal(positionAtCap('QB', slots, byId, DEFAULT_PROFILE), true);
});

test('recommend(): a 2-QB league proposes a third QB for the bench; the default never does', () => {
  const geo = rosterGeometry(P_2QB);
  // QB-heavy pool: if a 3rd QB is legal at all it belongs in the top 5.
  const pool = [...ladder('QB', 10, 400, 5), ...ladder('RB', 10, 200, 5)];
  const weekly = mkWeeklyMap(pool);
  const roster = slotsFor(geo, { QB1: 'QB-1', QB2: 'QB-2' });
  const withShape = recommend(roster, pool, weekly, 'ppr', 'BN1', null, P_2QB);
  const without = recommend(roster, pool, weekly, 'ppr', 'BN1', null);
  assert.ok(withShape.some((r) => r.player.position === 'QB'),
    'the 2-QB shape offers a QB backup');
  assert.ok(!without.some((r) => r.player.position === 'QB'),
    'the frozen cap still refuses a 3rd QB with no shape');
});

test('bestPickNow(): a 2-QB league still ranks QBs once two are rostered', () => {
  const geo = rosterGeometry(P_2QB);
  const pool = deepPool();
  const weekly = mkWeeklyMap(pool);
  const roster = slotsFor(geo, { QB1: 'QB-1', QB2: 'QB-2' });
  const picks = bestPickNow(roster, pool, weekly, 'ppr', { limit: 40 }, P_2QB);
  const frozen = bestPickNow(roster, pool, weekly, 'ppr', { limit: 40 });
  assert.ok(picks.some((r) => r.player.position === 'QB'));
  assert.ok(!frozen.some((r) => r.player.position === 'QB'));
});

test('opponentNeeds(): the simulated room drafts a third QB in a 2-QB league', () => {
  const twoQb = rosterShape({ qb: 2 });
  const oneQb = rosterShape(null);
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', twoQb), true, 'a 2-QB room wants a backup');
  assert.equal(opponentNeeds({ QB: 3 }, 'QB', twoQb), false, 'and stops at three');
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', oneQb), false, '1-QB room unchanged');
  assert.equal(opponentNeeds({ QB: 1 }, 'QB', oneQb), true);
  assert.equal(opponentNeeds({ RB: 4 }, 'RB', oneQb), false, 'RB want = 2+flex+backup');
  assert.equal(opponentNeeds({ RB: 3 }, 'RB', oneQb), true);
});

/* ---- BUG #5: the starter set / slot order follow the shape -------------------- */

test('a 9-starter K+DEF league keeps all 15 slots and its K/DEF eligibility', () => {
  const geo = rosterGeometry(P_K_DEF);
  assert.equal(geo.starters.length, 9);
  assert.equal(geo.all.length, 15);
  assert.deepEqual(geo.starters,
    ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'K1', 'DEF1']);
  assert.equal(slotEligible('K', 'K1', P_K_DEF), true);
  assert.equal(slotEligible('DEF', 'DEF1', P_K_DEF), true);
  assert.equal(slotEligible('K', 'BN1', P_K_DEF), true, 'bench holds a bye-week kicker');
  assert.equal(slotEligible('K', 'FLEX', P_K_DEF), false, 'a K never fills the FLEX');
  // R47: the frozen geometry seats K1/DEF1 too — the pre-R47 gap is closed.
  assert.equal(slotEligible('K', 'K1'), true);
  assert.equal(slotEligible('DEF', 'DEF1'), true);
  assert.equal(slotEligible('K', 'BN1'), true, 'default bench holds a bye-week kicker');
  assert.equal(slotEligible('K', 'FLEX'), false);
  assert.ok(SLOT_ORDER.includes('K1') && SLOT_ORDER.includes('DEF1'));
});

test('neediestOpenSlot(): an open K1 is a real open STARTER, not a bench slot', () => {
  const geo = rosterGeometry(P_K_DEF);
  const pool = [...deepPool(), mkPlayer('K-1', 'Kicker One', 'KC', 'K', 120)];
  const weekly = mkWeeklyMap(pool);
  const filled = {
    QB1: 'QB-1', RB1: 'RB-1', RB2: 'RB-2', WR1: 'WR-1', WR2: 'WR-2',
    TE1: 'TE-1', FLEX: 'RB-3',
  };
  const roster = slotsFor(geo, filled);
  assert.equal(neediestOpenSlot(roster, pool, weekly, 'ppr', P_K_DEF), 'K1');
  assert.equal(neediestOpenSlot(roster, pool, weekly, 'ppr'), 'K1',
    'R47: the frozen geometry seats K1/DEF1 and answers like the profile');
});

test('fitScore(): a starter in QB2 counts as a starter (the frozen 13 slots missed it)', () => {
  const geo = rosterGeometry(P_2QB);
  const pool = [
    mkPlayer('q1', 'Starter QB', 'KC', 'QB', 300),
    mkPlayer('q2', 'Second QB', 'BUF', 'QB', 290),
    mkPlayer('q3', 'Free Agent QB', 'PHI', 'QB', 280),
  ];
  const playersById = lookup(pool);
  // q2 (in QB2) and the candidate q3 share a Week 7 bye; q1 does not.
  const weeklyById = lookup([
    mkWeekly('q1', 5, 16), mkWeekly('q2', 7, 16), mkWeekly('q3', 7, 15),
  ]);
  const roster = slotsFor(geo, { QB1: 'q1', QB2: 'q2' });
  const ctx = { playersById, weeklyById, mode: 'ppr', slot: 'BN1' };
  const seen = fitScore(pool[2], roster, { ...ctx, shape: P_2QB });
  const blind = fitScore(pool[2], roster, ctx);
  assert.ok(seen.reasons.some((r) => r.includes('Second QB')),
    'the QB2 starter is part of the bye-clash math');
  assert.ok(!blind.reasons.some((r) => r.includes('Second QB')),
    'the frozen 7-slot starter set never looked at QB2');
  assert.ok(seen.score < blind.score, 'the missed clash was a missed 10-point penalty');
});

/* ---- SUPERFLEX --------------------------------------------------------------- */

test('superflex: QB is a flex position, so the cap and the demand both rise', () => {
  const geo = rosterGeometry(P_SUPERFLEX);
  assert.equal(slotEligible('QB', 'SUPER_FLEX', P_SUPERFLEX), true);
  assert.equal(geo.caps.QB, 3, 'one fixed QB + a superflex QB + a backup');
  const demand = positionDemand(P_SUPERFLEX);
  assert.equal(demand.QB, 1 + FLEX_WIN_SHARE.SUPER_FLEX.QB);
  assert.ok(demand.QB > positionDemand(DEFAULT_PROFILE).QB,
    'a superflex league demands more QBs league-wide');
});

test('startersTotal(): a superflex is won by a QB; the classic FLEX still is not', () => {
  const players = [
    { position: 'QB', gsis_id: 'q1' }, { position: 'QB', gsis_id: 'q2' },
    { position: 'RB', gsis_id: 'r1' }, { position: 'RB', gsis_id: 'r2' },
    { position: 'WR', gsis_id: 'w1' }, { position: 'WR', gsis_id: 'w2' },
    { position: 'TE', gsis_id: 't1' },
  ];
  const pts = new Map([['q1', 300], ['q2', 290], ['r1', 250], ['r2', 240],
    ['w1', 220], ['w2', 210], ['t1', 150]]);
  const adjOf = (p) => pts.get(p.gsis_id) || 0;
  // Classic: the FLEX takes RB/WR/TE and nothing is left -> the 2nd QB is bench.
  assert.equal(startersTotal(players, rosterShape(null), adjOf), 1370);
  // Superflex: the leftover QB wins the slot.
  assert.equal(startersTotal(players, P_SUPERFLEX, adjOf), 1660);
});

test('opponentNeeds(): a superflex room treats QB as flexible', () => {
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', P_SUPERFLEX), true);
  assert.equal(opponentNeeds({ QB: 3 }, 'QB', P_SUPERFLEX), false, 'the derived cap still bites');
});

/* ---- ONE replacement level, ONE flex rule ------------------------------------ */

test('replacementIndex(): league-wide rank = round(demand x teams) - 1, floored at 0', () => {
  assert.equal(replacementIndex(1, 12), 11);
  assert.equal(replacementIndex(2.45, 10), 24);   // round(24.5) = 25
  assert.equal(replacementIndex(0, 12), 0);
  assert.equal(replacementIndex(0.1, 2), 0, 'never negative');
});

test('positionDemand(): the classic FLEX spreads {RB .45, WR .45, TE .10}', () => {
  // R47: the default league demands one K and one DEF as well.
  assert.deepEqual(positionDemand(rosterShape(null)), { QB: 1, RB: 2.45, WR: 2.45, TE: 1.1, K: 1, DEF: 1 });
  assert.deepEqual(positionDemand(DEFAULT_PROFILE), { QB: 1, RB: 2.45, WR: 2.45, TE: 1.1, K: 1, DEF: 1 });
  assert.deepEqual(positionDemand(P_2QB), { QB: 2, RB: 2.45, WR: 2.45, TE: 1.1 });
  // A K+DEF league demands one of each; the FLEX never leaks into them.
  const kd = positionDemand(P_K_DEF);
  assert.equal(kd.K, 1);
  assert.equal(kd.DEF, 1);
});

test('replacementLevel(): with a shape the FLEX is SHARED, not winner-takes-all', () => {
  // RB owns the best player overall, so the legacy rule gives it the whole FLEX.
  const pool = [
    ...ladder('RB', 40, 400, 5),
    ...ladder('WR', 40, 350, 5),
  ];
  const weekly = mkWeeklyMap(pool);
  const shape = { shape: { teams: 2, roster_positions: DEFAULT_PROFILE.shape.roster_positions } };
  const rbRank = pool.filter((p) => p.position === 'RB')
    .findIndex((p) => p.proj_points === replacementLevel(pool, weekly, 'ppr', 'RB', shape));
  const wrRank = pool.filter((p) => p.position === 'WR')
    .findIndex((p) => p.proj_points === replacementLevel(pool, weekly, 'ppr', 'WR', shape));
  assert.equal(rbRank, wrRank, 'shared flex demand -> the same league-wide rank');
  assert.equal(rbRank, replacementIndex(2.45, 2));
  // The legacy path still ranks them differently (RB absorbed the FLEX).
  const rbLegacy = pool.filter((p) => p.position === 'RB')
    .findIndex((p) => p.proj_points === replacementLevel(pool, weekly, 'ppr', 'RB'));
  const wrLegacy = pool.filter((p) => p.position === 'WR')
    .findIndex((p) => p.proj_points === replacementLevel(pool, weekly, 'ppr', 'WR'));
  assert.equal(rbLegacy, 3);
  assert.equal(wrLegacy, 2);
});

test('replacementLevel(): team count moves VOR once a shape is supplied', () => {
  const pool = deepPool();
  const weekly = mkWeeklyMap(pool);
  const mk = (teams) => ({ shape: { teams, roster_positions: DEFAULT_PROFILE.shape.roster_positions } });
  const ten = replacementLevel(pool, weekly, 'ppr', 'RB', mk(10));
  const fourteen = replacementLevel(pool, weekly, 'ppr', 'RB', mk(14));
  assert.ok(fourteen < ten, 'a deeper league digs further down the ladder');
  const cand = pool.find((p) => p.gsis_id === 'RB-1');
  assert.ok(vorScore(cand, pool, weekly, 'ppr', mk(14))
    > vorScore(cand, pool, weekly, 'ppr', mk(10)),
  'the same RB is worth more in a 14-team league');
  // Without a shape team count is not even an input — the legacy number stands.
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'RB'),
    replacementLevel(pool, weekly, 'ppr', 'RB', undefined));
});

test('replacementLevel(): a pool shallower than the league-wide index clamps', () => {
  const pool = ladder('TE', 3, 200, 10);
  const weekly = mkWeeklyMap(pool);
  const shape = { shape: { teams: 12, roster_positions: DEFAULT_PROFILE.shape.roster_positions } };
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'TE', shape), 180, 'worst available');
  assert.equal(replacementLevel([], weekly, 'ppr', 'TE', shape), 0, 'nothing available -> 0');
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'K', shape), 0,
    'a position this league cannot roster has no replacement level');
});

test('the fit engine and the auction engine agree on WHO the replacement player is', () => {
  const pool = deepPool();
  const weekly = mkWeeklyMap(pool);
  const leagueSize = 10;
  const shape = { shape: { teams: leagueSize, roster_positions: DEFAULT_PROFILE.shape.roster_positions } };
  const adjOf = (r) => (pool.find((p) => p.gsis_id === r.gsis_id) || {}).proj_points || 0;
  const dollars = fairDollars(pool, adjOf, leagueSize, 200, shape);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const ranked = pool.filter((p) => p.position === pos)
      .sort((a, b) => b.proj_points - a.proj_points);
    const idx = replacementIndex(positionDemand(shape)[pos], leagueSize);
    const repl = ranked[idx];
    // The fit engine's replacement level IS that player's points ...
    assert.equal(replacementLevel(pool, weekly, 'ppr', pos, shape), repl.proj_points,
      `${pos}: the fit engine points at the same player`);
    // ... and the auction engine prices exactly that player at the $1 floor.
    assert.equal(dollars.get(repl.gsis_id), MIN_BID,
      `${pos}: the auction engine prices the same player at replacement`);
    assert.ok(dollars.get(ranked[idx - 1].gsis_id) > MIN_BID,
      `${pos}: the player one rank better is still worth real money`);
  }
});
