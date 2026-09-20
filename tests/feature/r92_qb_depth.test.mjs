/* tests/feature/r92_qb_depth.test.mjs — the R92 QB DEPTH CASCADE, locked.
 *
 * The owner's order was three sentences: "there should be a drop if QB1 is
 * out. And another if QB2 is out. And then look at the capability of QB3."
 * R92 part A answers it with a measurement, and this file locks the things
 * that would quietly turn that measurement into a claim it cannot support:
 *
 *   1. THE LEAK BARRIER. A week-W game may read depth-chart snapshots from
 *      weeks < W and nothing else. It is proved in both directions on a
 *      fixture: a chart dated in the priced week must NOT be visible, and
 *      week 1 must fall back to the prior season's final chart rather than
 *      borrow its own. A family that reads its own week is not a weak signal,
 *      it is a fabricated one.
 *   2. THE CASCADE ARITHMETIC. Every term fires only inside the QB1-out
 *      condition, the QB2 extra only when QB2 is out too, and the capability
 *      term is the measured gap to the EXPECTED starter — QB3 when QB1 and QB2
 *      are both out. cap_gap is EXACTLY 0.0 when QB1 starts, never a fitted
 *      near-zero.
 *   3. REPLACEMENT LEVEL IS POOLED BY PASSER, not by passer-week. Pooling by
 *      week would sweep every starter's first three September weeks into the
 *      pool and turn "replacement" into "league average", which would shrink
 *      every cap_gap toward nothing.
 *   4. THE DOUBLE-COUNT RULE, asserted at BOTH sites. qb_depth's first term IS
 *      qb_out's drop, so (a) the gate stacks qb_depth on the incumbent MINUS
 *      qb_out, and (b) build_predictions skips the qb_out term whenever
 *      qb_depth is applied. If either site drifts, one absence gets priced
 *      twice and the incumbent stops being the model production ships.
 *   5. PROPOSAL ONLY. The family is registered and appliable, and
 *      game_params carries NO qb_depth block: nothing shipped moved.
 *   6. THE ARTIFACT. When present it validates against its strict contract,
 *      its conditions carry n per season, and its verdict is one of the
 *      families it actually ran ("none" included).
 *   7. THE MARKET BOUNDARY. Neither module may name a betting column.
 *
 * Node built-ins only. Python is invoked for the behaviour that lives in
 * Python — a JS re-implementation of the cascade would grade a copy, not the
 * code the gate and the prediction builder run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKTEST = join(REPO_ROOT, 'scripts', 'backtest_qb_depth.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const PREDICT = join(REPO_ROOT, 'scripts', 'build_predictions.py');
const VALIDATE = join(REPO_ROOT, 'scripts', 'validate_data.py');
const ARTIFACT = join(REPO_ROOT, 'data', 'qb_depth_backtest.json');
const CONTRACT = join(REPO_ROOT, 'data', 'contracts', 'qb_depth_backtest.schema.json');
const TUNING = join(REPO_ROOT, 'data', 'model_tuning.json');

/* Run python and parse the JSON printed on its LAST line — the modules print
 * progress, so the payload is the final line. */
function py(script) {
  const out = execFileSync('python3', ['-c', script], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* The denylist as a LITERAL — never imported from the producer, because a
 * checker that reuses the producer's constants grades the pipeline with the
 * pipeline's own marking scheme. */
const BETTING_COLUMNS = [
  'away_moneyline', 'home_moneyline', 'spread_line', 'total_line',
  'over_odds', 'under_odds', 'away_spread_odds', 'home_spread_odds',
];

/* A synthetic fixture with answers worked out by hand, shared by the
 * walk-forward tests below. HOU lists three QBs; a1 has 500 trailing
 * dropbacks at +0.20 EPA/db, a2 has 200 at 0.00, a3 has 10 (under the
 * threshold, so he is replacement level, which here is a3 alone: -0.20). */
const FIXTURE = `
import json, sys
sys.path.insert(0, ".")
import scripts.backtest_qb_depth as qd

finals = {2024: [{"home": "HOU", "away": "DAL", "week": w, "home_score": 20,
                  "away_score": 17,
                  "kickoff_utc": "2024-09-%02dT17:00Z" % (1 + 7 * w)}
                 for w in (1, 2, 3, 4)]}
def chart(week):
    rows = []
    for rank, pid, nm in ((1, "a1", "Ann One"), (2, "a2", "Ann Two"),
                          (3, "a3", "Ann Three")):
        rows.append({"week": week, "club_code": "HOU", "position": "QB",
                     "depth_team": rank, "full_name": nm, "gsis_id": pid,
                     "game_type": "REG"})
    rows.append({"week": week, "club_code": "DAL", "position": "QB",
                 "depth_team": 1, "full_name": "Bob One", "gsis_id": "b1",
                 "game_type": "REG"})
    return rows
depth = [r for w in (1, 2, 3, 4) for r in chart(w)]
injuries = {"seasons": {"2024": {"HOU": {
    "2": [{"id": "a1", "name": "Ann One", "position": "QB", "status": "Out"}],
    "3": [{"id": "a1", "name": "Ann One", "position": "QB", "status": "Out"},
          {"id": "a2", "name": "Ann Two", "position": "QB", "status": "Doubtful"}],
}}}}
epa = {"seasons": {
    "2023": {"HOU": {"1": {"passers": {
                 "a1": {"db": 500, "epa": 100.0, "name": "A.One"},
                 "a2": {"db": 200, "epa": 0.0, "name": "A.Two"},
                 "a3": {"db": 10, "epa": -2.0, "name": "A.Three"}}}},
             "DAL": {"1": {"passers": {"b1": {"db": 400, "epa": 40.0,
                                              "name": "B.One"}}}}},
    "2024": {"HOU": {}, "DAL": {}}}}
qw = {(2024, g["week"]) for g in finals[2024]}
`;

test('qb_depth: both selftests pass (backtest substrate + family arithmetic)', () => {
  assert.ok(existsSync(BACKTEST), 'scripts/backtest_qb_depth.py present');
  assert.match(execFileSync('python3', [BACKTEST, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' }), /selftest OK/);
  assert.match(execFileSync('python3', ['-m', 'scripts.promote_signals', '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' }), /qb_depth cascade arithmetic/);
});

test('qb_depth: a week-W game never sees its own depth chart', () => {
  /* Both directions, so the bound cannot drift silently: the week-4 chart is
   * visible to nothing at lag 1 when it is the only chart, and week 2 DOES see
   * the week-1 chart. */
  const got = py(`${FIXTURE}
own_week_only = qd.depth_orders({2024: chart(4)}, finals, [2024])
lagged = qd.depth_orders({2024: depth}, finals, [2024])
print(json.dumps({
    "own_week_key": (2024, "HOU", 4) in own_week_only,
    "wk2": lagged.get((2024, "HOU", 2)),
    "wk1_no_prior": (2024, "HOU", 1) in lagged,
}))
`);
  assert.equal(got.own_week_key, false,
    'a chart dated in the priced week must be invisible at lag 1 — reading it '
    + 'would be reading the answer');
  assert.deepEqual(got.wk2, ['a1', 'a2', 'a3'],
    'week 2 reads the week-1 chart, rank order preserved');
  assert.equal(got.wk1_no_prior, false,
    'week 1 with no prior season is ABSENT (neutral, counted), never its own week');
});

test("qb_depth: week 1 falls back to the prior season's final chart", () => {
  const got = py(`${FIXTURE}
orders = qd.depth_orders({2023: chart(18), 2024: depth}, finals, [2024])
print(json.dumps({"wk1": orders.get((2024, "HOU", 1))}))
`);
  assert.deepEqual(got.wk1, ['a1', 'a2', 'a3'],
    "week 1 uses last season's final ranking — the honest preseason expectation");
});

test('qb_depth: replacement level is pooled by PASSER, not by passer-week', () => {
  const got = py(`${FIXTURE}
cap_at, rep = qd.capability_tables(epa, [2024], qw)
caps = cap_at[(2024, 1)]
print(json.dumps({
    "rep": rep[2024],
    "a1": qd.capability("a1", caps, rep[2024]),
    "a2": qd.capability("a2", caps, rep[2024]),
    "a3": qd.capability("a3", caps, rep[2024]),
    "unknown_no_rep": qd.capability("nobody", caps, None),
    "min_db": qd.MIN_DROPBACKS,
}))
`);
  assert.equal(got.min_db, 100, 'the capability threshold is 100 trailing dropbacks');
  /* a3 alone is under the threshold across the whole training window, so the
   * pool is a3 alone: -2.0 / 10 = -0.20. A by-week pool would also swallow
   * a1's 500 and b1's 400 opening dropbacks and land near +0.09. */
  assert.ok(Math.abs(got.rep - (-0.2)) < 1e-12,
    `replacement is a3 alone (-0.20), got ${got.rep} — a by-week pool would `
    + 'make every starter replacement level in September');
  assert.ok(Math.abs(got.a1 - 0.2) < 1e-12, 'a1 carries his own measured rate');
  assert.ok(Math.abs(got.a2 - 0.0) < 1e-12, 'a2 carries his own measured rate');
  assert.ok(Math.abs(got.a3 - (-0.2)) < 1e-12,
    'a3 is under the threshold, so he takes REPLACEMENT level, not his own '
    + '10-dropback number');
  assert.equal(got.unknown_no_rep, null,
    'no measurement and no replacement level is "unknown", never 0.0');
});

test('qb_depth: QB1 out, QB2 out, QB3 starting — the substrate says so', () => {
  const got = py(`${FIXTURE}
orders = qd.depth_orders({2023: chart(18), 2024: depth}, finals, [2024])
cap_at, rep = qd.capability_tables(epa, [2024], qw)
outs = qd.qb_outs(injuries)
sub = qd.build_substrate(orders, outs, cap_at, rep, finals, [2024])
counts = qd.condition_counts(sub, finals, [2024])
print(json.dumps({
    "w1": sub[(2024, 1, "HOU")], "w2": sub[(2024, 2, "HOU")],
    "w3": sub[(2024, 3, "HOU")], "dal": sub[(2024, 2, "DAL")],
    "counts": counts,
}))
`);
  assert.equal(got.w1.qb1_out, false, 'week 1: QB1 healthy');
  assert.equal(got.w1.cap_gap, 0,
    'cap_gap is EXACTLY 0.0 when QB1 starts — not a small fitted number');

  assert.equal(got.w2.qb1_out, true);
  assert.equal(got.w2.qb2_out, false);
  assert.equal(got.w2.expected_rank, 2, 'QB1 out alone -> QB2 is expected');
  assert.ok(Math.abs(got.w2.cap_gap - 0.2) < 1e-12,
    'the gap is QB1 (0.20) minus QB2 (0.00)');

  assert.equal(got.w3.qb1_out, true);
  assert.equal(got.w3.qb2_out, true, 'Doubtful counts as out, same as qb_out');
  assert.equal(got.w3.expected_rank, 3,
    'QB1 and QB2 both out -> QB3 starts, which is the whole point of the order');
  assert.ok(Math.abs(got.w3.cap_gap - (0.2 - -0.2)) < 1e-12,
    'the gap to QB3 uses REPLACEMENT level, because QB3 has not played enough');

  assert.equal(got.dal.known, true, 'the opponent is knowable and simply healthy');
  assert.equal(got.counts.qb1_out['2024'], 2, 'two QB1-out team-games');
  assert.equal(got.counts.qb2_also_out['2024'], 1, 'one of them had QB2 out too');
  assert.equal(got.counts.qb3_or_deeper_started['2024'], 1, 'one QB3 start');
  assert.equal(got.counts.team_games['2024'], 8, 'four games, two team-games each');
  assert.equal(got.counts.depth_unknown['2024'], 0);
});

test('qb_depth: an unknown depth chart is neutral and COUNTED, never imputed', () => {
  const got = py(`${FIXTURE}
cap_at, rep = qd.capability_tables(epa, [2024], qw)
outs = qd.qb_outs(injuries)
blank = qd.build_substrate({}, outs, cap_at, rep, finals, [2024])
print(json.dumps({
    "counts": qd.condition_counts(blank, finals, [2024]),
    "fired": qd.n_fired(blank, finals, [2024], 75.0, 50.0, 300.0),
}))
`);
  assert.equal(got.counts.depth_unknown['2024'], 8,
    'every team-game is counted as unknown');
  assert.equal(got.counts.qb1_out['2024'], 0,
    '"no chart" must never be recorded as "QB1 was fine"');
  assert.equal(got.fired, 0, 'and nothing is priced away from 0.0');
});

test('qb_depth: the pure delta — the function build_predictions prices with', () => {
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts.promote_signals import (qb_depth_penalty, qb_depth_delta,
                                     qb_depth_row, QB_DEPTH_MIN_DROPBACKS)
starts = {"known": True, "qb1_out": False, "qb2_out": False, "cap_gap": 0.0}
one = {"known": True, "qb1_out": True, "qb2_out": False, "cap_gap": 0.20}
two = {"known": True, "qb1_out": True, "qb2_out": True, "cap_gap": 0.45}
dark = {"known": False, "qb1_out": True, "qb2_out": True, "cap_gap": 9.0}
better = {"known": True, "qb1_out": True, "qb2_out": False, "cap_gap": -0.10}
orders = {"KC": ["p1", "p2", "p3"]}
outs = {("KC", 5): {"p1", "p2"}}
cap = {"p1": (500.0, 100.0), "p2": (300.0, 0.0), "p3": (10.0, -5.0)}
print(json.dumps({
    "healthy": qb_depth_penalty(starts, 75.0, 50.0, 300.0),
    "qb1": qb_depth_penalty(one, 75.0, 50.0, 0.0),
    "qb1_qb2": qb_depth_penalty(two, 75.0, 50.0, 0.0),
    "cap_only": qb_depth_penalty(one, 0.0, 0.0, 300.0),
    "all_three": qb_depth_penalty(two, 75.0, 50.0, 300.0),
    "dark": qb_depth_penalty(dark, 75.0, 50.0, 300.0),
    "missing": qb_depth_penalty(None, 75.0, 50.0, 300.0),
    "negative_gap": qb_depth_penalty(better, 0.0, 0.0, 300.0),
    "as_qb_out": qb_depth_penalty(two, 75.0, 0.0, 0.0),
    "home_out": qb_depth_delta(one, starts, 75.0, 50.0, 0.0),
    "away_out": qb_depth_delta(starts, one, 75.0, 50.0, 0.0),
    "both_out": qb_depth_delta(one, one, 75.0, 50.0, 300.0),
    "row_wk5": qb_depth_row("KC", 5, orders, outs, cap, -0.25),
    "row_wk6": qb_depth_row("KC", 6, orders, outs, cap, -0.25),
    "row_unknown": qb_depth_row("SF", 5, orders, outs, cap, -0.25),
    "min_db": QB_DEPTH_MIN_DROPBACKS,
}))
`);
  assert.equal(got.healthy, 0, 'no term fires while QB1 starts, at any scale');
  assert.equal(got.qb1, 75, 'QB1 out: the drop');
  assert.equal(got.qb1_qb2, 125, 'QB2 out too: a second drop');
  assert.ok(Math.abs(got.cap_only - 60) < 1e-9, 'capability alone: 300 x 0.20');
  assert.ok(Math.abs(got.all_three - 260) < 1e-9, '75 + 50 + 300 x 0.45');
  assert.equal(got.dark, 0, 'an unknown chart is neutral however alarming it looks');
  assert.equal(got.missing, 0, 'a missing row is neutral, never a crash');
  assert.ok(Math.abs(got.negative_gap + 30) < 1e-9,
    'a backup who out-produced the starter carries the penalty NEGATIVE — '
    + 'clamping would be a prior, not a measurement');
  assert.equal(got.as_qb_out, 75,
    'at (scale, 0, 0) qb_depth IS qb_out: the families are nested, which is '
    + 'exactly why they may never be applied together');

  assert.equal(got.home_out, -75, 'home losing its QB shrinks the home edge');
  assert.equal(got.away_out, +75, 'away losing its QB widens it');
  assert.equal(got.both_out, 0, 'symmetric absences cancel exactly');

  assert.equal(got.min_db, 100);
  assert.equal(got.row_wk5.qb1_out, true);
  assert.equal(got.row_wk5.qb2_out, true);
  assert.ok(Math.abs(got.row_wk5.cap_gap - (0.2 - -0.25)) < 1e-9,
    'p3 is under the threshold, so the gap is measured to REPLACEMENT level');
  assert.equal(got.row_wk6.cap_gap, 0, 'QB1 healthy -> exactly 0.0');
  assert.deepEqual(got.row_unknown,
    { known: false, qb1_out: false, qb2_out: false, cap_gap: 0 },
    'a team with no depth order is unknown, not healthy');
});

test('qb_depth: the gate registers it, and game_params carries NOTHING', () => {
  const src = readFileSync(PROMOTE, 'utf8');
  const registered = [...src.matchAll(/families\.append\(\{"family": "([a-z_]+)"/g)]
    .map((m) => m[1]);
  assert.ok(registered.includes('qb_depth'),
    'qb_depth is a registered candidate family, measured beside qb_out and '
    + 'skill_out on every run');
  const block = src.match(/APPLIABLE = \{([^}]*)\}/);
  const appliable = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(appliable.includes('qb_depth'),
    'qb_depth is appliable because build_predictions really does call its '
    + 'reader — the APPLIABLE rule is unchanged');

  /* PROPOSAL ONLY: the whole point of R92 part A. The family exists, is
   * measured and could be adopted by the weekly run — and nothing shipped has
   * moved, which is visible as the absence of the block. */
  const gp = readJson(TUNING).game_params || {};
  assert.ok(!('qb_depth' in gp) || gp.qb_depth.applied === false,
    'game_params carries no APPLIED qb_depth block: this change adopts nothing');
  assert.equal((gp.qb_out || {}).applied, true,
    'and qb_out is still the family production ships — untouched by a '
    + 'measure-only release');
  assert.equal((gp.qb_out || {}).scale, 75.0, 'at the scale it was adopted at');
});

test('qb_depth: the QB1 double-count rule holds at BOTH application sites', () => {
  /* (a) The GATE. A qb_depth trial is stacked on the incumbent MINUS qb_out. */
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts import promote_signals as ps
shipped = {"game_params": {"qb_out": {"applied": True, "scale": 75.0}}}
both = {"game_params": {"qb_out": {"applied": True, "scale": 75.0},
                        "qb_depth": {"applied": True, "qb1_scale": 50.0,
                                     "qb2_extra": 0.0, "cap_scale": 0.0}}}
print(json.dumps({
    "shipped_n": len(ps._incumbent_family_fns(shipped)[0]),
    "excluded_n": len(ps._incumbent_family_fns(shipped, exclude=("qb_out",))[0]),
    "both_unavailable": ps._incumbent_family_fns(both)[1],
    "both_n": len(ps._incumbent_family_fns(both)[0]),
}))
`);
  assert.equal(got.shipped_n, 1, 'the shipped incumbent rebuilds qb_out');
  assert.equal(got.excluded_n, 0,
    'excluding qb_out really removes it — the base a qb_depth trial stacks on');
  /* With BOTH applied, qb_out must not be rebuilt: qb_depth folds it in. The
   * only builder that may appear is qb_depth's own (and it is reported
   * unavailable here when the depth releases cannot be reached, which is the
   * honest state in a sandbox — either way qb_out is gone). */
  assert.ok(got.both_n <= 1 && !got.both_unavailable.includes('qb_out'),
    'an applied qb_depth FOLDS IN qb_out: the qb_out builder is skipped, and '
    + 'its absence is not reported as a degraded incumbent');

  /* (b) The PREDICTION BUILDER, asserted on the source: the qb_out branch is
   * reachable only when qb_depth is not applied. */
  const pred = readFileSync(PREDICT, 'utf8');
  assert.match(pred, /_qb_out\.get\("applied"\) and _qd_params is not None/,
    'build_predictions detects "both adopted" explicitly');
  assert.match(pred, /elif _qb_out\.get\("applied"\):/,
    'and prices qb_out only in the ELSE branch, so one absence is priced once');
  assert.match(pred, /qb_depth_delta\(/, 'qb_depth is actually applied to hfa_eff');
  assert.match(pred, /NEVER DOUBLE-COUNT QB1/,
    'the rule is stated where a future editor will read it');

  /* And the gate says the same thing in its own record. */
  const promote = readFileSync(PROMOTE, 'utf8');
  assert.match(promote, /NEVER DOUBLE-COUNT QB1/,
    'the same rule is stated at the gate site');
});

test('qb_depth: the artifact validates and reports n beside every number', () => {
  if (!existsSync(ARTIFACT)) return;      // runner-built; absence is documented
  const doc = readJson(ARTIFACT);
  const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import validate_against_schema
doc = json.load(open("data/qb_depth_backtest.json", encoding="utf-8"))
sch = json.load(open("data/contracts/qb_depth_backtest.schema.json", encoding="utf-8"))
validate_against_schema(doc, sch, "qb_depth_backtest.json")
print("VALID")
`], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /VALID/, 'the committed artifact satisfies its strict contract');

  const names = doc.candidates.map((c) => c.name);
  assert.ok(names.includes('qb1_out') && names.includes('qb1_qb2')
    && names.includes('capability') && names.includes('combined'),
  'all four candidates of the order are measured');
  assert.ok(doc.verdict === 'none' || names.includes(doc.verdict),
    'the verdict names a candidate that actually ran, or "none"');
  if (doc.verdict === 'none') {
    assert.ok(doc.candidates.every((c) => c.would_adopt === false),
      'a "none" verdict means no candidate cleared the rule');
  }

  /* n per season per condition — the owner asked for it explicitly, and a
   * condition that fired twice must read like one that fired twice. */
  for (const key of ['qb1_out', 'qb2_also_out', 'qb3_or_deeper_started']) {
    for (const season of doc.seasons_scored) {
      assert.equal(typeof doc.conditions[key][season], 'number',
        `conditions.${key} carries an n for ${season}`);
    }
  }
  for (const c of doc.candidates) {
    assert.equal(typeof c.n_fired, 'number',
      `${c.name} reports how many team-games it actually priced`);
    for (const season of doc.seasons_scored) {
      assert.equal(typeof c.heldout_log_loss_by_fold[season], 'number',
        `${c.name} reports its held-out loss for fold ${season}`);
    }
  }

  /* MEASURE ONLY, said in the document's own words. */
  assert.match(doc.policy[0], /MEASUREMENT ONLY/,
    'the first policy line states the run adopts nothing');
  assert.ok(doc.limits.length >= 3, 'the limits are stated, not left to inference');
  assert.match(doc.adoption_rule.double_count_rule, /qb_out/,
    'the artifact records the QB1 double-count rule it was measured under');

  /* Absent data is counted, never invented. */
  assert.equal(typeof doc.substrate.seasons_unavailable, 'object',
    'a season whose depth release could not be read is named, not skipped');
  assert.equal(doc.substrate.starter_lag_weeks, 1,
    'the lag that makes the substrate pregame is recorded on the artifact');
});

test('qb_depth: the contract is registered OPTIONAL and reds a dishonest doc', () => {
  const src = readFileSync(VALIDATE, 'utf8');
  assert.match(src, /"qb_depth_backtest\.schema\.json": "qb_depth_backtest\.json"/,
    'the contract is routed to its file');
  assert.match(src, /"qb_depth_backtest\.json",/,
    'and registered OPTIONAL — runner-built, so its absence may not red a clone');
  assert.match(execFileSync('python3', [VALIDATE, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' }), /qb-depth backtest contract reds/,
  'the validator selftest proves the contract actually catches a bad document');
});

test('qb_depth: no market number anywhere near the family', () => {
  for (const [label, path] of [['backtest', BACKTEST], ['contract', CONTRACT]]) {
    const src = readFileSync(path, 'utf8');
    for (const col of BETTING_COLUMNS) {
      assert.ok(!src.includes(col),
        `${label} names the betting column ${col} — no market number may reach `
        + 'a model probability');
    }
  }
  if (existsSync(ARTIFACT)) {
    const raw = readFileSync(ARTIFACT, 'utf8');
    for (const col of BETTING_COLUMNS) {
      assert.ok(!raw.includes(col), `the artifact carries ${col}`);
    }
  }
});
