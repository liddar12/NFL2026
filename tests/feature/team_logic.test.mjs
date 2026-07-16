/* tests/feature/team_logic.test.mjs — unit locks for the fit engine (Agent E).
 *
 * PURE node:test against the PURE module app/team-logic.js — no DOM, no fetch,
 * no dependencies, so it runs inside the FAST gate (`node --test tests/feature/*.mjs`).
 *
 * The build contract fixes the exported signatures and the scoring/fit math;
 * these tests lock that behavior with SYNTHETIC players (never real names) so
 * they cannot churn when the projection data regenerates. Data-shape locks for
 * the committed weekly contract live in weekly_contract.test.mjs instead.
 *
 * Contract constants under test: W_PTS=1.0, STACK_BONUS=12, BYE_CLASH_PENALTY=10.
 * The stack test is built so EVERY other fitScore term cancels between the two
 * candidates — the score delta must be the stack bonus EXACTLY.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoringAdjust,
  weeklyPoints,
  byeWeek,
  slotEligible,
  teamWeeklyTotals,
  fitScore,
  recommend,
} from '../../app/team-logic.js';

const WEEKS = 18;

/* ---- Synthetic fixtures ---------------------------------------------------- */

/** A player_weekly entry: flat `perWeekPts` every non-bye week, bye at `byeWk`
 * (0 = no bye). Flat weeks make expected sums/floors trivially computable. */
function mkWeekly(id, byeWk, perWeekPts, rec = 0) {
  const weeks = [];
  for (let wk = 1; wk <= WEEKS; wk += 1) {
    const bye = wk === byeWk;
    weeks.push({
      wk,
      opp: bye ? null : 'OPP',
      home: wk % 2 === 0,
      bye,
      pts: bye ? 0 : perWeekPts,
    });
  }
  return { gsis_id: id, receptions_prior: rec, weeks };
}

/** A player_projections entry (synthetic — unit tests never use real names). */
function mkPlayer(id, name, team, position, proj) {
  return {
    gsis_id: id,
    name,
    team,
    position,
    proj_points: proj,
    low: proj * 0.7,
    high: proj * 1.3,
    signals_used: [],
  };
}

/** id -> entry lookup answering BOTH `lookup[id]` and `lookup.get(id)`. The
 * contract fixes the parameter NAME (weeklyById), not the container type; this
 * fixture locks behavior without also locking a Map-vs-object choice. get/has
 * are non-enumerable so key iteration sees only real ids. */
function lookup(entries) {
  const m = new Map(entries.map((e) => [String(e.gsis_id), e]));
  const o = Object.fromEntries(m);
  Object.defineProperty(o, 'get', { value: (k) => m.get(String(k)) });
  Object.defineProperty(o, 'has', { value: (k) => m.has(String(k)) });
  return o;
}

/** The contract's 13-slot roster storage shape, empty unless overridden. */
const SLOT_KEYS = [
  'QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX',
  'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6',
];
function roster(fill = {}) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = null;
  return { slots: { ...slots, ...fill } };
}

/** Tolerant id extraction from a recommend() row ({player, score, reasons}). */
const idOf = (row) =>
  row && row.player && row.player.gsis_id ? row.player.gsis_id : row.player;

/* ---- scoringAdjust: EXACT conversion via receptions ------------------------ */

test('scoringAdjust: ppr 300 with 100 receptions -> half 250, std 200 (exact)', () => {
  assert.equal(scoringAdjust(300, 100, 'ppr'), 300);
  assert.equal(scoringAdjust(300, 100, 'half'), 250);
  assert.equal(scoringAdjust(300, 100, 'std'), 200);
});

test('scoringAdjust: zero receptions makes every mode identical', () => {
  for (const mode of ['ppr', 'half', 'std']) {
    assert.equal(scoringAdjust(180, 0, mode), 180, `mode ${mode}`);
  }
});

/* ---- slotEligible: full truth table ---------------------------------------- */

test('slotEligible truth table: FLEX takes RB/WR/TE (not QB); BN takes any modeled', () => {
  const CASES = {
    QB: new Set(['QB1', 'BN1', 'BN6']),
    RB: new Set(['RB1', 'RB2', 'FLEX', 'BN1', 'BN6']),
    WR: new Set(['WR1', 'WR2', 'FLEX', 'BN1', 'BN6']),
    TE: new Set(['TE1', 'FLEX', 'BN1', 'BN6']),
  };
  const slots = ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'BN1', 'BN6'];
  for (const [pos, allowed] of Object.entries(CASES)) {
    for (const slot of slots) {
      assert.equal(
        !!slotEligible(pos, slot),
        allowed.has(slot),
        `slotEligible(${pos}, ${slot}) must be ${allowed.has(slot)}`,
      );
    }
  }
});

/* ---- byeWeek ---------------------------------------------------------------- */

test('byeWeek: detects the bye week; null when no week is a bye', () => {
  assert.equal(byeWeek(mkWeekly('p1', 9, 10)), 9);
  assert.equal(byeWeek(mkWeekly('p1', 5, 10)), 5);
  assert.equal(byeWeek(mkWeekly('p2', 0, 10)), null); // no bye row at all
});

/* ---- weeklyPoints: proportional rescale, byes stay zero-weeks --------------- */

test('weeklyPoints: 18 floats scaled by seasonAdj/seasonPpr; bye stays 0', () => {
  // 17 non-bye weeks x 10 = 170 season ppr; std adjust to 85 halves every week.
  const w = mkWeekly('p1', 7, 10);
  const pts = weeklyPoints(w, 85, 170);
  assert.equal(pts.length, 18);
  assert.equal(pts[6], 0, 'week 7 bye must remain a zero-week');
  for (let i = 0; i < 18; i += 1) {
    if (i === 6) continue;
    assert.ok(Math.abs(pts[i] - 5) < 1e-9, `week ${i + 1}: ${pts[i]} != 5`);
  }
  const sum = pts.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 85) < 1e-9, `non-bye sum ${sum} != seasonAdj 85`);
});

/* ---- teamWeeklyTotals -------------------------------------------------------- */

test('teamWeeklyTotals: 18 summed starter floats, byes drop to the other starter', () => {
  const weeklyById = lookup([mkWeekly('a', 5, 10), mkWeekly('b', 9, 20)]);
  const totals = teamWeeklyTotals(['a', 'b'], weeklyById);
  assert.equal(totals.length, 18);
  assert.ok(Math.abs(totals[4] - 20) < 1e-9, `wk5 (a on bye): ${totals[4]} != 20`);
  assert.ok(Math.abs(totals[8] - 10) < 1e-9, `wk9 (b on bye): ${totals[8]} != 10`);
  assert.ok(Math.abs(totals[0] - 30) < 1e-9, `wk1: ${totals[0]} != 30`);
});

/* ---- fitScore / recommend: the QB+receiver stack ---------------------------
 * Two WR candidates are IDENTICAL (points, weeks, bye) except team; the roster
 * holds a same-team QB for one of them. Every other fitScore term therefore
 * cancels, and the score delta must be STACK_BONUS = 12 exactly. */

const qbKC = mkPlayer('qb-kc', 'Test Quarterback', 'KC', 'QB', 320);
const wrKC = mkPlayer('wr-kc', 'Test Receiver A', 'KC', 'WR', 250);
const wrDAL = mkPlayer('wr-dal', 'Test Receiver B', 'DAL', 'WR', 250);
// QB bye wk7; both WRs bye wk9 (differs from the QB -> no clash asymmetry).
const stackWeekly = lookup([
  mkWeekly('qb-kc', 7, 320 / 17, 0),
  mkWeekly('wr-kc', 9, 250 / 17, 80),
  mkWeekly('wr-dal', 9, 250 / 17, 80),
]);
const stackPool = [qbKC, wrKC, wrDAL];
const stackRoster = roster({ QB1: 'qb-kc' });

test('fitScore via recommend: same-team QB+WR earns "Stacks with" and exactly +12', () => {
  const recs = recommend(stackRoster, stackPool, stackWeekly, 'ppr', 'WR1');
  const kc = recs.find((r) => idOf(r) === 'wr-kc');
  const dal = recs.find((r) => idOf(r) === 'wr-dal');
  assert.ok(kc && dal, 'both WR candidates must be recommended for WR1');

  const kcReasons = kc.reasons.join(' | ');
  assert.match(kcReasons, /Stacks with/, `missing stack reason: ${kcReasons}`);
  assert.match(kcReasons, /Test Quarterback/, 'stack reason must name the QB');
  assert.doesNotMatch(dal.reasons.join(' | '), /Stacks with/,
    'different-team WR must NOT claim a stack');

  // All other terms cancel between the identical candidates: delta == 12.
  const delta = kc.score - dal.score;
  assert.ok(Math.abs(delta - 12) < 1e-6, `stack delta ${delta} != STACK_BONUS 12`);
});

test('fitScore direct call: {score, reasons} shape with the stack reason', () => {
  // ctx carries every lookup a conforming implementation may need (the
  // contract fixes fitScore(candidate, roster, ctx) but not ctx's field list);
  // extra keys are inert.
  const ctx = {
    weeklyById: stackWeekly,
    playersById: lookup(stackPool),
    pool: stackPool,
    mode: 'ppr',
    scoring: 'ppr',
    slot: 'WR1',
  };
  const fit = fitScore(wrKC, stackRoster, ctx);
  assert.equal(typeof fit.score, 'number');
  assert.ok(Array.isArray(fit.reasons) && fit.reasons.length > 0);
  assert.match(fit.reasons.join(' | '), /Stacks with/);
});

/* ---- bye clash: sharing a starter's bye is penalized and explained ---------- */

test('candidate sharing a starter bye gets the clash reason and scores lower', () => {
  // Non-KC teams so no stack term muddies the comparison. Clash WR shares the
  // QB starter's wk7 bye; the clean WR byes wk9. Identical points otherwise.
  const wrClash = mkPlayer('wr-clash', 'Test Receiver C', 'MIA', 'WR', 250);
  const wrClean = mkPlayer('wr-clean', 'Test Receiver D', 'DEN', 'WR', 250);
  const weeklyById = lookup([
    mkWeekly('qb-kc', 7, 320 / 17, 0),
    mkWeekly('wr-clash', 7, 250 / 17, 80),
    mkWeekly('wr-clean', 9, 250 / 17, 80),
  ]);
  const recs = recommend(
    roster({ QB1: 'qb-kc' }),
    [qbKC, wrClash, wrClean],
    weeklyById,
    'ppr',
    'WR1',
  );
  const clash = recs.find((r) => idOf(r) === 'wr-clash');
  const clean = recs.find((r) => idOf(r) === 'wr-clean');
  assert.ok(clash && clean, 'both WR candidates must be recommended for WR1');
  assert.match(
    clash.reasons.join(' | '),
    /Shares Week 7 bye/,
    'clash reason must name the shared bye week',
  );
  assert.ok(
    clash.score < clean.score,
    `bye clash must cost score: clash ${clash.score} >= clean ${clean.score}`,
  );
});

/* ---- recommend: determinism, exclusion, top-5, scoring-mode awareness ------- */

test('recommend is deterministic and excludes rostered ids', () => {
  // 7 eligible WRs (distinct points) + 1 rostered WR that must never appear.
  const pool = [];
  const weeks = [];
  for (let i = 0; i < 7; i += 1) {
    const id = `wr-${i}`;
    pool.push(mkPlayer(id, `Test Wideout ${i}`, 'NYJ', 'WR', 150 + i * 10));
    weeks.push(mkWeekly(id, 5 + (i % 3), (150 + i * 10) / 17, 40));
  }
  const rostered = mkPlayer('wr-mine', 'Test Wideout Mine', 'BUF', 'WR', 500);
  pool.push(rostered);
  weeks.push(mkWeekly('wr-mine', 9, 500 / 17, 90));
  const weeklyById = lookup(weeks);
  const r = roster({ WR1: 'wr-mine' });

  const a = recommend(r, pool, weeklyById, 'ppr', 'WR2');
  const b = recommend(r, pool, weeklyById, 'ppr', 'WR2');

  assert.equal(a.length, 5, 'top-5: exactly 5 rows when >5 candidates are eligible');
  assert.deepEqual(a.map(idOf), b.map(idOf), 'same inputs -> same order');
  assert.deepEqual(a.map((x) => x.score), b.map((x) => x.score), 'same inputs -> same scores');
  assert.ok(!a.map(idOf).includes('wr-mine'), 'rostered id must be excluded');
  for (let i = 1; i < a.length; i += 1) {
    assert.ok(a[i - 1].score >= a[i].score, `scores must be non-increasing at ${i}`);
  }
  for (const row of a) {
    assert.equal(typeof row.score, 'number');
    assert.ok(Array.isArray(row.reasons));
  }
});

test('recommend respects the scoring mode (std demotes a reception-heavy WR)', () => {
  // Identical schedules; only receptions differ. ppr: 250 > 200. std: 130 < 200.
  const heavy = mkPlayer('wr-heavy', 'Test Wideout Heavy', 'LV', 'WR', 250);
  const light = mkPlayer('wr-light', 'Test Wideout Light', 'CHI', 'WR', 200);
  const weeklyById = lookup([
    mkWeekly('wr-heavy', 9, 250 / 17, 120),
    mkWeekly('wr-light', 9, 200 / 17, 0),
  ]);
  const empty = roster();
  const ppr = recommend(empty, [heavy, light], weeklyById, 'ppr', 'WR1');
  const std = recommend(empty, [heavy, light], weeklyById, 'std', 'WR1');
  assert.equal(idOf(ppr[0]), 'wr-heavy', 'ppr must rank the reception-heavy WR first');
  assert.equal(idOf(std[0]), 'wr-light', 'std must rank the low-reception WR first');
});
