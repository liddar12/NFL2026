/* tests/feature/team_rel2.test.mjs — REL2 fit-engine acceptance criteria.
 *
 * Locks the pure additions in app/team-logic.js:
 *   - POSITION_CAPS / positionAtCap + recommend()/recommendV2() honoring them
 *     (the "stop recommending a 3rd QB" fix),
 *   - recommend() sort modes ('fit' vs 'available'),
 *   - strengthOfSchedule() 1.0..5.0 mapping (1 easiest, 5 hardest),
 *   - trendLabel() up/down/flat with provenance,
 *   - recommendV2() carrying a `base` score so the view can show a base->AI delta.
 * Plus the data/team_strength.json contract shape the client SoS depends on.
 *
 * Pure functions -> imported directly under node, no DOM. Deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  POSITION_CAPS,
  positionAtCap,
  rosteredCountByPos,
  recommend,
  recommendV2,
  strengthOfSchedule,
  trendLabel,
  SOS_ELO_PER_POINT,
} from '../../app/team-logic.js';

const WEEKS = 18;

/* ---- fixtures (mirror team_logic.test.mjs) --------------------------------- */

function mkWeekly(id, byeWk, perWeekPts, rec = 0) {
  const weeks = [];
  for (let wk = 1; wk <= WEEKS; wk += 1) {
    const bye = wk === byeWk;
    weeks.push({ wk, opp: bye ? null : 'OPP', home: wk % 2 === 0, bye, pts: bye ? 0 : perWeekPts });
  }
  return { gsis_id: id, receptions_prior: rec, weeks };
}

function mkPlayer(id, name, team, position, proj) {
  return { gsis_id: id, name, team, position, proj_points: proj, low: proj * 0.7, high: proj * 1.3, signals_used: [] };
}

function lookup(entries) {
  const m = new Map(entries.map((e) => [String(e.gsis_id), e]));
  const o = Object.fromEntries(m);
  Object.defineProperty(o, 'get', { value: (k) => m.get(String(k)) });
  Object.defineProperty(o, 'has', { value: (k) => m.has(String(k)) });
  return o;
}

const SLOT_KEYS = ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6'];
function roster(fill = {}) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = null;
  return { slots: { ...slots, ...fill } };
}

const idOf = (row) => (row && row.player && row.player.gsis_id ? row.player.gsis_id : row.player);
const posOf = (row) => row.player.position;

/* ---- POSITION CAPS --------------------------------------------------------- */

test('POSITION_CAPS: QB capped at 2, DEF/DST/K at 1, RB/WR/TE uncapped', () => {
  assert.equal(POSITION_CAPS.QB, 2);
  assert.equal(POSITION_CAPS.DEF, 1);
  assert.equal(POSITION_CAPS.K, 1);
  assert.equal(POSITION_CAPS.RB, undefined);
  assert.equal(POSITION_CAPS.WR, undefined);
  assert.equal(POSITION_CAPS.TE, undefined);
});

test('rosteredCountByPos + positionAtCap: QB reaches cap at 2 rostered', () => {
  const players = [
    mkPlayer('qb1', 'QB One', 'KC', 'QB', 300),
    mkPlayer('qb2', 'QB Two', 'BUF', 'QB', 290),
    mkPlayer('rb1', 'RB One', 'SF', 'RB', 280),
  ];
  const byId = lookup(players);
  const oneQb = roster({ QB1: 'qb1' }).slots;
  const twoQb = roster({ QB1: 'qb1', BN1: 'qb2' }).slots;
  assert.equal(rosteredCountByPos(oneQb, byId).QB, 1);
  assert.equal(positionAtCap('QB', oneQb, byId), false, '1 QB is under the cap');
  assert.equal(positionAtCap('QB', twoQb, byId), true, '2 QBs hits the cap');
  assert.equal(positionAtCap('RB', twoQb, byId), false, 'RB is uncapped');
});

test('recommend excludes a 3rd QB for a bench slot once two QBs are rostered', () => {
  const pool = [
    mkPlayer('qb1', 'QB One', 'KC', 'QB', 300),
    mkPlayer('qb2', 'QB Two', 'BUF', 'QB', 290),
    mkPlayer('qb3', 'QB Three', 'PHI', 'QB', 285),
    mkPlayer('rb9', 'RB Nine', 'SF', 'RB', 200),
    mkPlayer('wr9', 'WR Nine', 'MIA', 'WR', 190),
  ];
  const weekly = lookup(pool.map((p) => mkWeekly(p.gsis_id, 0, p.proj_points / WEEKS)));
  // Two QBs already rostered -> a bench recommendation must NOT surface qb3.
  const full = roster({ QB1: 'qb1', BN1: 'qb2' });
  const recs = recommend(full, pool, weekly, 'ppr', 'BN2');
  const ids = recs.map(idOf);
  assert.ok(!ids.includes('qb3'), 'a 3rd QB must never be recommended for a bench slot');
  assert.ok(recs.every((r) => posOf(r) !== 'QB'), 'no QB appears once the QB cap is hit');
  assert.ok(ids.includes('rb9') || ids.includes('wr9'), 'non-QB candidates still recommended');
});

test('recommend still offers a QB when under the cap (one QB rostered)', () => {
  const pool = [
    mkPlayer('qb1', 'QB One', 'KC', 'QB', 300),
    mkPlayer('qb2', 'QB Two', 'BUF', 'QB', 290),
    mkPlayer('rb9', 'RB Nine', 'SF', 'RB', 120),
  ];
  const weekly = lookup(pool.map((p) => mkWeekly(p.gsis_id, 0, p.proj_points / WEEKS)));
  const oneQb = roster({ QB1: 'qb1' });
  const recs = recommend(oneQb, pool, weekly, 'ppr', 'BN1');
  assert.ok(recs.map(idOf).includes('qb2'), 'a 2nd QB is allowed (under the cap of 2)');
});

test('recommendV2 also enforces the QB cap', () => {
  const pool = [
    mkPlayer('qb1', 'QB One', 'KC', 'QB', 300),
    mkPlayer('qb2', 'QB Two', 'BUF', 'QB', 290),
    mkPlayer('qb3', 'QB Three', 'PHI', 'QB', 285),
    mkPlayer('rb9', 'RB Nine', 'SF', 'RB', 200),
  ];
  const weekly = lookup(pool.map((p) => mkWeekly(p.gsis_id, 0, p.proj_points / WEEKS)));
  const full = roster({ QB1: 'qb1', BN1: 'qb2' });
  const recs = recommendV2(full, pool, weekly, 'ppr', 'BN2', { players: {} });
  assert.ok(recs.every((r) => posOf(r) !== 'QB'), 'recommendV2 respects the QB cap too');
});

/* ---- reco sort modes ------------------------------------------------------- */

test("recommend sort: 'available' orders by raw points, 'fit' by fit score", () => {
  // Two WRs; the lower-points one gets a fit bonus (stacks with a rostered QB).
  const qb = mkPlayer('qb-kc', 'Q KC', 'KC', 'QB', 300);
  const wrStack = mkPlayer('wr-kc', 'WR KC', 'KC', 'WR', 200); // stacks (+12)
  const wrPlain = mkPlayer('wr-dal', 'WR DAL', 'DAL', 'WR', 210); // higher raw pts
  const pool = [qb, wrStack, wrPlain];
  const weekly = lookup([
    mkWeekly('qb-kc', 7, 18), mkWeekly('wr-kc', 9, 12), mkWeekly('wr-dal', 9, 13),
  ]);
  const r = roster({ QB1: 'qb-kc' });
  const byFit = recommend(r, pool, weekly, 'ppr', 'WR1', { sort: 'fit' });
  const byAvail = recommend(r, pool, weekly, 'ppr', 'WR1', { sort: 'available' });
  // Best AVAILABLE = highest raw projected points first (wr-dal 210 > wr-kc 200).
  assert.equal(idOf(byAvail[0]), 'wr-dal', 'available sorts by raw points');
  // Best FIT can promote the stacking WR despite fewer raw points.
  assert.equal(idOf(byFit[0]), 'wr-kc', 'fit sort promotes the stack partner');
});

/* ---- strength of schedule -------------------------------------------------- */

const STRENGTH = {
  ratings: { EASY: 1400, MID: 1500, HARD: 1600 },
  elo_min: 1400, elo_max: 1600,
};

function weeksVsOpp(opp) {
  // 3 real weeks all vs `opp`, plus a bye — mean opponent Elo == ratings[opp].
  return { weeks: [
    { wk: 1, opp, home: true, bye: false, pts: 10 },
    { wk: 2, opp, home: false, bye: false, pts: 10 },
    { wk: 3, opp: null, home: true, bye: true, pts: 0 },
    { wk: 4, opp, home: true, bye: false, pts: 10 },
  ] };
}

test('strengthOfSchedule: harder opponents -> higher SoS, one decimal, [1,5]', () => {
  const easy = strengthOfSchedule(weeksVsOpp('EASY'), STRENGTH);
  const mid = strengthOfSchedule(weeksVsOpp('MID'), STRENGTH);
  const hard = strengthOfSchedule(weeksVsOpp('HARD'), STRENGTH);
  // MID == 1500 -> exactly the 3.0 midpoint.
  assert.equal(mid, 3.0);
  // Monotonic: easy < mid < hard.
  assert.ok(easy < mid && mid < hard, `expected easy<mid<hard, got ${easy}/${mid}/${hard}`);
  // 100 Elo below mean at 25 Elo/point -> 3 - 4 = -1 -> clamped to 1.0.
  assert.equal(easy, 1.0, 'far-below-average schedule clamps to 1.0');
  assert.equal(hard, 5.0, 'far-above-average schedule clamps to 5.0');
  // One-decimal output.
  const s = strengthOfSchedule({ weeks: [{ wk: 1, opp: 'MID', home: true, bye: false, pts: 1 }, { wk: 2, opp: 'HARD', home: true, bye: false, pts: 1 }] }, STRENGTH);
  assert.equal(Math.round(s * 10), s * 10, 'SoS is rounded to one decimal');
  assert.equal(SOS_ELO_PER_POINT, 25);
});

test('strengthOfSchedule: null when no ratings or no opponents', () => {
  assert.equal(strengthOfSchedule(weeksVsOpp('EASY'), null), null);
  assert.equal(strengthOfSchedule(weeksVsOpp('EASY'), { ratings: null }), null);
  assert.equal(strengthOfSchedule({ weeks: [{ wk: 1, bye: true }] }, STRENGTH), null);
  // Unknown opponent (not in ratings) -> no usable opponents -> null.
  assert.equal(strengthOfSchedule(weeksVsOpp('ZZZ'), STRENGTH), null);
});

/* ---- trend labels ---------------------------------------------------------- */

test('trendLabel: up/down/flat with source + slope', () => {
  const up = trendLabel({ value: 0.13, source: 'measured', slope_pts_per_yr: 27.0, seasons_observed: 5 });
  assert.equal(up.dir, 'up');
  assert.equal(up.source, 'measured');
  assert.equal(up.slope_pts_per_yr, 27.0);
  assert.equal(up.seasons, 5);

  const down = trendLabel({ value: -0.2, source: 'ai_estimated' });
  assert.equal(down.dir, 'down');
  assert.equal(down.source, 'ai_estimated');

  const flat = trendLabel({ value: 0, source: 'measured' });
  assert.equal(flat.dir, 'flat');

  // Falls back to raw slope when no signed value is present.
  const bySlope = trendLabel({ slope_pts_per_yr: -8.0, source: 'measured' });
  assert.equal(bySlope.dir, 'down');

  assert.equal(trendLabel(null), null);
  assert.equal(trendLabel('x'), null);
});

/* ---- recommendV2 base-score passthrough (for the view's AI delta) ---------- */

test('recommendV2 rows carry a numeric base score (base->AI delta source)', () => {
  const pool = [mkPlayer('wr1', 'WR One', 'KC', 'WR', 200), mkPlayer('wr2', 'WR Two', 'DAL', 'WR', 190)];
  const weekly = lookup([mkWeekly('wr1', 9, 12), mkWeekly('wr2', 9, 11)]);
  const recs = recommendV2(roster(), pool, weekly, 'ppr', 'WR1', { players: {} });
  assert.ok(recs.length > 0);
  for (const r of recs) {
    assert.equal(typeof r.base, 'number', 'every reco row carries a numeric base score');
    assert.equal(typeof r.score, 'number');
  }
});

/* ---- team_strength.json contract ------------------------------------------- */

test('data/team_strength.json: ~32 team Elo ratings, min<=max, real bounds', () => {
  const path = fileURLToPath(new URL('../../data/team_strength.json', import.meta.url));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(typeof doc.season, 'number');
  assert.ok(doc.ratings && typeof doc.ratings === 'object', 'ratings map present');
  const teams = Object.keys(doc.ratings);
  assert.ok(teams.length >= 30 && teams.length <= 34, `expected ~32 teams, got ${teams.length}`);
  for (const t of teams) assert.equal(typeof doc.ratings[t], 'number', `${t} rating is numeric`);
  assert.ok(doc.elo_min <= doc.elo_max, 'elo_min <= elo_max');
  const vals = Object.values(doc.ratings);
  assert.ok(Math.min(...vals) >= doc.elo_min - 0.01 && Math.max(...vals) <= doc.elo_max + 0.01,
    'declared bounds contain the rating spread');
});
