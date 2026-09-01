/* tests/feature/r49_learning_ledger.test.mjs — R49 Deliverable E: the learning
 * ledger (owner: "create estimates for the signal to regress and backtest
 * against to improve the AI").
 *
 * The minimal honest loop, and what each lock protects:
 *   1. scripts/build_estimate_ledger.py — append is IDEMPOTENT per day, keeps
 *      first + latest per player, and LOCKS each week's estimate at the last
 *      as-of before kickoff (a locked week never changes);
 *   2. scripts/resolve_estimates.py — SKIPS when a week has no rows (never
 *      scores 0 on absence), joins name+position exactly, and its scores
 *      CONSERVE COUNTS (totals == sum by position == sum by week);
 *   3. scripts/harness/ledger_objective.py — the objective REFUSES to fit with
 *      0 resolved weeks (LedgerNotReady), and scripts/fit_player_signals.py
 *      cannot adopt on a single resolved week;
 *   4. the committed record is honest: no 2026 week has resolved, so
 *      data/estimate_scores.json says 0 and meta.learning_record carries null
 *      MAE — an invented number here would be the exact lie this loop exists
 *      to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('ledger append is idempotent per day; first/latest kept; weeks lock before kickoff and never change', () => {
  const r = py(`
from scripts import build_estimate_ledger as bl
kick = {1: "2026-09-10T00:20:00Z", 2: "2026-09-17T00:20:00Z"}
w = {"age_curve": 0.0}
p1, w1 = bl._fixture("2026-09-01T06:00:00Z", shipped=170.0, cand=200.0)
d1 = bl.append(None, p1, w1, kick, w, 2026, "t1")
d1b = bl.append(d1, p1, w1, kick, w, 2026, "t2"); d1b["generated_utc"] = "t1"
p2, w2 = bl._fixture("2026-09-08T06:00:00Z", shipped=175.0, cand=210.0)
d2 = bl.append(d1, p2, w2, kick, w, 2026, "t3")
p3, w3 = bl._fixture("2026-09-11T06:00:00Z", shipped=100.0, cand=100.0)
d3 = bl.append(d2, p3, w3, kick, w, 2026, "t4")
p4, w4 = bl._fixture("2026-09-12T06:00:00Z", shipped=50.0, cand=50.0)
d4 = bl.append(d3, p4, w4, kick, w, 2026, "t5")
e3 = d3["players"]["espn-1"]; e4 = d4["players"]["espn-1"]
print(json.dumps({
  "idempotent": json.dumps(d1b, sort_keys=True) == json.dumps(d1, sort_keys=True),
  "runs_after_repeat": len(d1b["runs"]),
  "first_as_of": e4["first"]["as_of_utc"], "latest_as_of": e4["latest"]["as_of_utc"],
  "locked3": e3["locked"], "locked4": e4["locked"],
  "week_est": bl.week_estimate(e3["latest"], 2),
  "runs": d4["runs"],
}))`);
  assert.equal(r.idempotent, true, 'same as-of twice -> identical document');
  assert.equal(r.runs_after_repeat, 1);
  assert.equal(r.first_as_of, '2026-09-01T06:00:00Z');
  assert.equal(r.latest_as_of, '2026-09-12T06:00:00Z');
  assert.deepEqual(Object.keys(r.locked3), ['1'], 'week 1 locks on the first append after its kickoff');
  assert.equal(r.locked3['1'].as_of_utc, '2026-09-08T06:00:00Z', 'from the LAST pre-kickoff as-of');
  assert.ok(Math.abs(r.locked3['1'].shipped - 175 / 17) < 0.01);
  assert.ok(Math.abs(r.locked3['1'].candidate - 210 / 17) < 0.02);
  assert.deepEqual(r.locked4['1'], r.locked3['1'], 'a locked week is immutable');
  assert.deepEqual(Object.keys(r.locked4), ['1'], 'week 2 has not kicked off: not locked');
  assert.ok(r.week_est.low < r.week_est.candidate && r.week_est.candidate < r.week_est.high);
  assert.equal(r.runs.length, 4);
  assert.deepEqual(r.runs[2].weeks_locked, [1]);
  assert.deepEqual(r.runs[0].weights_applied, { age_curve: 0 });
});

test('resolver skips when the week has no rows, never scores an unmatched player, and conserves counts', () => {
  const r = py(`
from scripts import resolve_estimates as re_
ledger = re_._fixture_ledger()
rows = [
  {"season_type": "REG", "week": "1", "position": "RB", "player_display_name": "AJ Back", "fantasy_points_ppr": "14.0"},
  {"season_type": "REG", "week": "1", "position": "WR", "player_display_name": "Some Receiver", "fantasy_points_ppr": "16.0"},
]
resolved, unmatched, per_week = re_.resolve(ledger, rows)
doc = re_.document(2026, "data/estimates/2026.json", resolved, unmatched, per_week, None, "2026-09-15T00:00:00Z")
empty_resolved, empty_unmatched, empty_pw = re_.resolve(ledger, [])
empty = re_.document(2026, "x", empty_resolved, empty_unmatched, empty_pw, "no rows yet", "2026-09-01T00:00:00Z")
print(json.dumps({"doc": doc, "empty": empty, "unmatched": unmatched}))`);
  const { doc, empty } = r;
  assert.equal(doc.weeks_resolved, 1);
  assert.deepEqual(doc.resolved.map((x) => [x.gsis_id, x.week]).sort(), [['espn-1', 1], ['espn-2', 1]],
    'week 2 (no rows) is skipped, the never-joining TE is unmatched, the unlocked QB is not scored');
  assert.equal(r.unmatched, 1);
  assert.equal(doc.totals.n, doc.resolved.length);
  assert.equal(Object.values(doc.by_position).reduce((a, b) => a + b.n, 0), doc.totals.n);
  assert.equal(doc.weeks.reduce((a, w) => a + w.players_scored, 0), doc.totals.n);
  assert.equal(doc.players_scored, 2);
  assert.ok(Math.abs(doc.totals.mae_shipped - 6) < 1e-9);
  assert.ok(Math.abs(doc.totals.bias_shipped + 6) < 1e-9, 'bias = mean(estimate - actual)');
  assert.equal(doc.totals.band_coverage, 0.5);
  // the honest empty document
  assert.equal(empty.weeks_resolved, 0);
  assert.equal(empty.players_scored, 0);
  assert.equal(empty.totals.mae_shipped, null);
  assert.equal(empty.totals.mae_candidate, null);
  assert.equal(empty.skipped, 'no rows yet');
});

test('the harness objective refuses to fit with 0 resolved weeks, and one week yields no held-out fold', () => {
  const r = py(`
from scripts.harness import ledger_objective as lo
from scripts import fit_player_signals as fps
out = {}
try:
    lo.load_resolved({"weeks_resolved": 0, "resolved": [], "skipped": "nothing resolved"})
    out["zero"] = "fitted"
except lo.LedgerNotReady as exc:
    out["zero"] = "refused: " + str(exc)
try:
    lo.objective([], {})
    out["empty_obj"] = "scored"
except lo.LedgerNotReady:
    out["empty_obj"] = "refused"
one = fps._rows([1])
out["one_week_folds"] = fps.walk_forward(one, {"age_curve": 0.0})["folds"]
three = fps._rows([1, 2, 3])
wf = fps.walk_forward(three, {"age_curve": 0.0})
out["three"] = wf
out["min_weeks"] = lo.MIN_RESOLVED_WEEKS
out["margin"] = lo.ADOPTION_MARGIN_MAE
# the committed record must refuse too
scores = json.load(open("data/estimate_scores.json"))
try:
    lo.load_resolved(scores); out["committed"] = "fitted"
except lo.LedgerNotReady:
    out["committed"] = "refused"
out["committed_weeks"] = scores["weeks_resolved"]
print(json.dumps(out))`);
  assert.match(r.zero, /^refused: .*0 week/);
  assert.equal(r.empty_obj, 'refused');
  assert.equal(r.min_weeks, 1);
  assert.equal(r.margin, 0.1);
  assert.equal(r.one_week_folds, 0, 'nothing can be adopted on a single resolved week');
  assert.equal(r.three.folds, 2);
  assert.deepEqual(r.three.candidate_weights, { age_curve: 1 }, 'walk-forward recovers the true signal');
  assert.ok(r.three.candidate_mae < r.three.current_mae - r.margin);
  if (r.committed_weeks === 0) {
    assert.equal(r.committed, 'refused', 'the committed scores file has 0 resolved weeks: the fit must refuse');
  }
});

test('the committed record is honest: 0 resolved weeks, null MAE, nothing invented', () => {
  const scores = JSON.parse(read('data/estimate_scores.json'));
  const meta = JSON.parse(read('data/meta.json'));
  const lr = meta.learning_record;
  assert.ok(lr, 'data/meta.json must carry learning_record for the MODEL tab');
  assert.equal(lr.weeks_resolved, scores.weeks_resolved);
  assert.equal(lr.players_scored, scores.players_scored);
  assert.equal(lr.mae_ppr, scores.totals.mae_shipped);
  assert.equal(lr.bias_ppr, scores.totals.bias_shipped);
  if (scores.weeks_resolved === 0) {
    assert.equal(lr.mae_ppr, null, 'no resolved week -> no MAE, ever');
    assert.equal(lr.bias_ppr, null);
    assert.equal(lr.objective_ready, false);
    assert.equal(typeof scores.skipped, 'string', 'the skip must say why');
    assert.equal(scores.resolved.length, 0);
  } else {
    assert.equal(typeof lr.mae_ppr, 'number');
  }
  assert.deepEqual(lr.signals_with_weight,
    Object.entries(meta.weights).filter(([, v]) => v !== 0).map(([k]) => k).sort());
  assert.equal(lr.adoption_margin_mae, 0.1);
  // last year's projected vs actual rides along from the walk-forward artifact
  const bt = JSON.parse(read('data/player_backtest.json')).candidate_2025;
  assert.ok(bt, 'player_backtest.json must carry candidate_2025');
  assert.ok(lr.backtest_2025, 'learning_record must carry backtest_2025');
  for (const k of ['baseline_mae', 'candidate_mae', 'shipped_mae', 'band_coverage', 'players']) {
    assert.equal(lr.backtest_2025[k], bt[k], `backtest_2025.${k} must mirror the artifact`);
    assert.equal(typeof bt[k], 'number', `candidate_2025.${k} is a measurement`);
  }
  assert.ok(bt.players > 100);
  assert.ok(bt.signals_evaluated.length >= 1 && bt.signals_not_evaluable.length >= 1,
    'the artifact must say which signals it could and could not evaluate historically');
  assert.ok(bt.sleeper_note.length > 10, 'the Sleeper reference outcome is stated either way');
  if (bt.sleeper_mae !== null) assert.ok(bt.sleeper_players > 0);
});

test('wiring: daily.yml appends then resolves after the pool; backtest.yml proposes only; smoke runs the selftests; contracts registered', () => {
  const yml = read('.github/workflows/daily.yml');
  const pool = yml.indexOf('python -m scripts.build_predictions');
  const ledger = yml.indexOf('scripts/build_estimate_ledger.py');
  const resolveAt = yml.indexOf('scripts/resolve_estimates.py');
  const validate = yml.indexOf('python scripts/validate_data.py');
  assert.ok(pool > 0 && ledger > pool && resolveAt > ledger && validate > resolveAt);
  const bt = read('.github/workflows/backtest.yml');
  assert.match(bt, /scripts\/fit_player_signals\.py --propose/);
  assert.doesNotMatch(bt, /fit_player_signals\.py --auto-adopt/);
  const smoke = read('tests/smoke.sh');
  for (const s of ['build_estimate_ledger.py --selftest', 'resolve_estimates.py --selftest',
    'fit_player_signals.py --selftest']) {
    assert.ok(smoke.includes(s), `smoke.sh must run ${s}`);
  }
  const vd = read('scripts/validate_data.py');
  assert.match(vd, /"estimate_scores\.schema\.json":\s*"estimate_scores\.json"/);
  assert.match(vd, /ESTIMATES_SCHEMA = "estimate_ledger\.schema\.json"/);
  for (const c of ['estimate_ledger', 'estimate_scores']) {
    assert.ok(existsSync(join(REPO_ROOT, `data/contracts/${c}.schema.json`)));
  }
  // the fit never writes weights: only model_tuning history, only with --propose
  const fit = read('scripts/fit_player_signals.py');
  assert.doesNotMatch(fit, /meta_record\.set_record|"weights"\]\s*=/);
  assert.match(fit, /"adopted": False/);
});
