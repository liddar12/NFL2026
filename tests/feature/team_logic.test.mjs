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
  fitScoreV2,
  recommendV2,
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

/* ---------------------------------------------------------------------------
 * Build 4 — Fit Engine v2 (the opt-in AI layer). Contract: the OFF path is
 * BYTE-IDENTICAL to v1; ON adds bounded terms from ai_insights with honest
 * provenance strings ("(measured 2021–2025)" vs "(AI estimate …)").
 * ------------------------------------------------------------------------- */

/** Synthetic ai_insights fixture (shape of data/ai_insights.json). */
const AI_FIXTURE = {
  default: 'off',
  players: {
    'wr-kc': {
      trajectory_adj: {
        value: 0.12, source: 'measured', slope_pts_per_yr: 24.0,
        seasons_observed: 4, why: 'OLS slope +24.0 pts/yr over 4 seasons',
      },
      stack_synergy: {
        value: 0.06, source: 'ai_estimated', pair: 'QB+WR',
        why: 'position-pair default',
      },
      cold_adj: {
        value: -0.1, source: 'measured', weeks: [12, 14],
        why: 'won 35% of sub-32F games vs 45% overall',
      },
    },
    'wr-dal': {
      trajectory_adj: {
        value: -0.08, source: 'ai_estimated', slope_pts_per_yr: -13.6,
        seasons_observed: 2, why: 'fewer than 3 seasons observed',
      },
      cold_adj: { value: 0, source: 'ai_estimated', weeks: [], why: 'no sample' },
    },
  },
};

/** ctx for the fixed stack fixture (wr-kc against a rostered same-team QB). */
function v2ctx(extra = {}) {
  return {
    playersById: lookup(stackPool),
    weeklyById: stackWeekly,
    mode: 'ppr',
    slot: 'WR1',
    ...extra,
  };
}

// The LOCKED v1 output for the fixed stack fixture. Any change to the v1 math,
// rounding, or reason wording changes these bytes and must fail here — the OFF
// path is the product default and is frozen by contract.
const V1_FIXTURE_JSON = '{"score":270,"reasons":["Projects 250.0 season points (PPR) — raw points drive the fit score","Stacks with Test Quarterback (KC) — QB+receiver points compound in good weeks","Raises your floor: worst week improves W7 0.0 → 14.7"]}';

test('v1 fitScore is byte-for-byte frozen on the fixed fixture', () => {
  assert.equal(JSON.stringify(fitScore(wrKC, stackRoster, v2ctx())), V1_FIXTURE_JSON);
});

test('fitScoreV2 OFF path (ai absent / false / truthy-not-true) is byte-identical to v1', () => {
  const v1 = JSON.stringify(fitScore(wrKC, stackRoster, v2ctx()));
  assert.equal(v1, V1_FIXTURE_JSON);
  // No ai flag at all.
  assert.equal(JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx())), v1);
  // Explicitly off.
  assert.equal(JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx({ ai: false }))), v1);
  // ONLY the literal true turns the layer on — truthy strings do not (and the
  // insights being present must not leak in).
  assert.equal(
    JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx({ ai: 'on', insights: AI_FIXTURE }))),
    v1,
  );
  // ON but no insight for the candidate: degrades to the v1 result.
  assert.equal(
    JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx({ ai: true, insights: { players: {} } }))),
    v1,
  );
});

test('fitScoreV2 ON: bounded AI terms with measured-up trajectory reason string', () => {
  const on = fitScoreV2(wrKC, stackRoster, v2ctx({ ai: true, insights: AI_FIXTURE }));
  // Terms: trajectory 0.12×40 = +4.8; cold −0.1×5×2 = −1.0; synergy 0.06×12 = +0.72.
  assert.ok(Math.abs(on.score - (270 + 4.8 - 1.0 + 0.72)) < 1e-6, `score ${on.score}`);
  const joined = on.reasons.join(' | ');
  assert.match(
    joined,
    /Trending up: \+24\.0 pts\/yr over 4 seasons \(measured 2021–2025\)/,
    `measured trajectory reason missing: ${joined}`,
  );
  // Cold term names the actual cold-venue weeks and its measured provenance.
  assert.match(joined, /below 32°F in Weeks 12, 14 \(measured 2021–2025\)/);
  // Stack synergy is ai_estimated by definition this build — it must say so.
  assert.match(joined, /Stack synergy with Test Quarterback: QB\+WR .*\(AI estimate — position-pair default\)/);
  // v1's own reasons all survive (v2 = v1 + extras, capped at 6).
  for (const r of JSON.parse(V1_FIXTURE_JSON).reasons) {
    assert.ok(on.reasons.includes(r), `v1 reason dropped: ${r}`);
  }
  assert.ok(on.reasons.length <= 6, 'reason cap is 6');
});

test('fitScoreV2 ON: declining <3-season player carries the AI-estimate provenance', () => {
  const on = fitScoreV2(wrDAL, stackRoster, v2ctx({ ai: true, insights: AI_FIXTURE }));
  const joined = on.reasons.join(' | ');
  assert.match(
    joined,
    /Declining faster than the WR age curve \(AI estimate — fewer than 3 seasons observed\)/,
    `estimated decline reason missing: ${joined}`,
  );
  // trajectory −0.08 × 40 = −3.2 off the v1 score (wr-dal has no stack/cold terms).
  const v1 = fitScore(wrDAL, stackRoster, v2ctx());
  assert.ok(Math.abs(on.score - (v1.score - 3.2)) < 1e-6, `score ${on.score} vs v1 ${v1.score}`);
});

test('fitScoreV2 ON: a measured decline cites its measured source, not an AI estimate', () => {
  const insights = {
    players: {
      'wr-kc': {
        trajectory_adj: {
          value: -0.15, source: 'measured', slope_pts_per_yr: -30.0,
          seasons_observed: 5, why: 'measured decline',
        },
      },
    },
  };
  const on = fitScoreV2(wrKC, stackRoster, v2ctx({ ai: true, insights }));
  const joined = on.reasons.join(' | ');
  assert.match(joined, /Declining faster than the WR age curve \(source: measured 2021–2025\)/);
  assert.doesNotMatch(joined, /AI estimate — fewer than 3 seasons/);
});

test('fitScoreV2 / recommendV2 are deterministic (two runs, identical bytes)', () => {
  const a = JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx({ ai: true, insights: AI_FIXTURE })));
  const b = JSON.stringify(fitScoreV2(wrKC, stackRoster, v2ctx({ ai: true, insights: AI_FIXTURE })));
  assert.equal(a, b);
  const r1 = recommendV2(stackRoster, stackPool, stackWeekly, 'ppr', 'WR1', AI_FIXTURE);
  const r2 = recommendV2(stackRoster, stackPool, stackWeekly, 'ppr', 'WR1', AI_FIXTURE);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('recommendV2 re-ranks on AI trajectory where v1 ties (and v1 stays v1)', () => {
  // Two WRs identical in every v1 term (same points, weeks, bye, no stacks);
  // the AI layer gives A a decline and B an ascent — only v2 separates them.
  const wrA = mkPlayer('wr-aaa', 'Test Receiver AA', 'MIA', 'WR', 250);
  const wrB = mkPlayer('wr-bbb', 'Test Receiver BB', 'DEN', 'WR', 250);
  const weeklyById = lookup([
    mkWeekly('wr-aaa', 9, 250 / 17, 80),
    mkWeekly('wr-bbb', 9, 250 / 17, 80),
  ]);
  const insights = {
    players: {
      'wr-aaa': {
        trajectory_adj: {
          value: -0.2, source: 'measured', slope_pts_per_yr: -40.0,
          seasons_observed: 4, why: 'w',
        },
      },
      'wr-bbb': {
        trajectory_adj: {
          value: 0.2, source: 'measured', slope_pts_per_yr: 40.0,
          seasons_observed: 4, why: 'w',
        },
      },
    },
  };
  const empty = roster();
  // v1: identical scores -> deterministic id tie-break puts wr-aaa first.
  const v1 = recommend(empty, [wrA, wrB], weeklyById, 'ppr', 'WR1');
  assert.deepEqual(v1.map(idOf), ['wr-aaa', 'wr-bbb']);
  assert.equal(v1[0].score, v1[1].score, 'v1 must tie — the pair differs only in AI terms');
  // v2: the ascending player outranks the declining one; the delta is exactly
  // (0.2 − (−0.2)) × TRAJECTORY_SCALE(40) = 16 fit points.
  const v2 = recommendV2(empty, [wrA, wrB], weeklyById, 'ppr', 'WR1', insights);
  assert.deepEqual(v2.map(idOf), ['wr-bbb', 'wr-aaa']);
  assert.ok(Math.abs((v2[0].score - v2[1].score) - 16) < 1e-6);
});
