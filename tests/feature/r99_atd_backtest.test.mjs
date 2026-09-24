/* tests/feature/r99_atd_backtest.test.mjs — R99 E1-S4: P(ATD) measured walk-forward.
 *
 * P(ATD) = 1 - exp(-lambda_team * share), written by scripts/backtest_atd.py to
 * data/atd_backtest.json (MEASURE ONLY). Locked here:
 *   AC1 log loss and Brier are reported for the model AND both baselines
 *       (position base rate; opportunity-only share) in every season, and the
 *       document passes its contract;
 *   AC2 `adopted` is true only if the model beats both baselines on log loss and
 *       Brier in EVERY held-out season with a calibration slope inside [0.9, 1.1]
 *       (and team TDs within 5%, S2) — each condition alone blocks it, and
 *       validate_data.py recomputes it from the receipts;
 *   AC3 the verdict text names the failing condition;
 * and the plumbing: the weekly workflow runs it before the contract check, the
 * gate runs its selftest, and no book column is read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys, copy\nsys.path.insert(0, ".")\nsys.path.insert(0, "tests/fixtures/r99")\nfrom scripts import backtest_atd as A\nfrom scripts import validate_data as V\nimport atd_synth as S\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const GOOD = `
def rep(slope=1.0, ll=0.38, br=0.11, opp_ll=0.39, opp_br=0.12, lam=2.4, act=2.4):
    m = {"n": 100, "log_loss": ll, "brier": br, "calibration_intercept": 0.0,
         "calibration_slope": slope, "mean_p": 0.16, "hit_rate": 0.16}
    return {"model": m, "position_base_rate": dict(m, log_loss=0.43, brier=0.13, calibration_slope=1.0),
            "opportunity_only": dict(m, log_loss=opp_ll, brier=opp_br, calibration_slope=1.0),
            "by_position": {}, "reliability": [],
            "team_td": {"team_games": 544, "mean_lambda": lam, "mean_realised": act, "ratio": round(lam / act, 4)}}
def reps(**bad2024):
    return {"2022": rep(), "2023": rep(), "2024": rep(**bad2024), "2025": rep()}
`;

test('R99 S4 AC1: model and both baselines scored in every season; the document passes its contract', () => {
  const r = py(`
uni, tg = S.league(seasons=(2022, 2023, 2024, 2025))
preds = A.walk_forward(uni, tg, (2023, 2024, 2025))
reports = {str(s): A.season_report(rows) for s, rows in preds.items()}
doc = A.document(reports, {"synthetic": True})
doc = json.loads(json.dumps(doc))
schema = json.load(open("data/contracts/atd_backtest.schema.json"))
errs = []
try:
    V.validate_against_schema(doc, schema, "atd_backtest.json")
except V.ValidationError as exc:
    errs.append(str(exc))
try:
    V.check_atd_backtest(doc)
except V.ValidationError as exc:
    errs.append(str(exc))
cols = {s: sorted(k for k in rep if k in ("model", "position_base_rate", "opportunity_only") and "log_loss" in rep[k] and "brier" in rep[k]) for s, rep in doc["seasons"].items()}
print(json.dumps({"errs": errs, "cols": cols, "held_out": doc["held_out_seasons"]}))`);
  assert.deepEqual(r.errs, [], 'the synthetic document passes the schema and the receipt check');
  for (const s of ['2023', '2024', '2025']) {
    assert.deepEqual(r.cols[s], ['model', 'opportunity_only', 'position_base_rate'], `season ${s}`);
  }
  assert.deepEqual(r.held_out, [2023, 2024, 2025]);
});

test('R99 S4 AC2+AC3: each condition alone blocks adoption and is named', () => {
  const r = py(`${GOOD}
cases = {
  "all_pass": reps(),
  "slope_high": reps(slope=1.15),
  "slope_low": reps(slope=0.85),
  "ll_vs_opp": reps(ll=0.395),
  "brier_vs_opp": reps(br=0.125),
  "ll_tie": reps(ll=0.39),
  "team_td": {"2022": rep(), "2023": rep(), "2024": rep(lam=2.1), "2025": rep(lam=2.2)},
  "missing_2025": {"2023": rep(), "2024": rep()},
}
print(json.dumps({k: A.verdict(v) for k, v in cases.items()}))`);
  assert.equal(r.all_pass[0], true);
  assert.match(r.all_pass[1], /^ADOPTED/);
  const expect = {
    slope_high: /2024: calibration slope 1\.150 outside \[0\.9, 1\.1\]/,
    slope_low: /2024: calibration slope 0\.850 outside/,
    ll_vs_opp: /2024: model log_loss 0\.39500 is not better than opportunity_only 0\.39000/,
    brier_vs_opp: /2024: model brier 0\.12500 is not better than opportunity_only 0\.12000/,
    ll_tie: /2024: model log_loss 0\.39000 is not better than opportunity_only/,
    team_td: /team TDs 2024-2025: mean lambda \/ mean realised 0\.8958 outside/,
    missing_2025: /2025: not measured/,
  };
  for (const [k, re] of Object.entries(expect)) {
    assert.equal(r[k][0], false, `${k} must block adoption`);
    assert.match(r[k][1], /^NOT ADOPTED — /, k);
    assert.match(r[k][1], re, k);
  }
});

test('R99 S4 AC2: the validator refuses an adopted flag its receipts do not earn, and the reverse', () => {
  const r = py(`${GOOD}
def doc_for(reports, adopted=None):
    d = json.loads(json.dumps(A.document(reports, {})))
    if adopted is not None:
        d["adopted"] = adopted
        d["verdict"] = ("ADOPTED — forced" if adopted else "NOT ADOPTED — forced")
    return d
out = {}
for label, d in (("honest_pass", doc_for(reps())), ("honest_fail", doc_for(reps(slope=1.3))),
                 ("forged_adopt", doc_for(reps(slope=1.3), adopted=True)),
                 ("forged_hold", doc_for(reps(), adopted=False)),
                 ("text_mismatch", dict(doc_for(reps()), verdict="NOT ADOPTED — but flag true"))):
    try:
        V.check_atd_backtest(d)
        out[label] = "ok"
    except V.ValidationError as exc:
        out[label] = str(exc)
V.check_atd_backtest(None)
print(json.dumps(out))`);
  assert.equal(r.honest_pass, 'ok');
  assert.equal(r.honest_fail, 'ok', 'an honest NOT ADOPTED is a valid document');
  assert.match(r.forged_adopt, /says adopted but its receipts do not support it: 2024 slope 1\.3/);
  assert.match(r.forged_hold, /says not adopted but every receipt passes/);
  assert.match(r.text_mismatch, /verdict text disagrees with adopted/);
});

test('R99 S4: runs weekly before the contract check, selftest in the gate, no book column read', () => {
  const yml = read('.github/workflows/backtest.yml');
  const step = yml.indexOf('python3 scripts/backtest_atd.py --cache "$RUNNER_TEMP/atd"');
  assert.ok(step > 0, 'the weekly workflow runs the ATD backtest with its CSVs outside data/');
  assert.ok(step < yml.indexOf('run: python scripts/validate_data.py'), 'it runs before the contract check');
  const block = yml.slice(yml.lastIndexOf('- name:', step), step + 200);
  assert.match(block, /continue-on-error: true/, 'a third-party outage must not red the weekly cron');
  assert.match(read('tests/smoke.sh'), /python3 scripts\/backtest_atd\.py --selftest/);
  const src = read('scripts/backtest_atd.py');
  const cols = src.slice(src.indexOf('TD_COLUMNS = {'), src.indexOf('TD_FIELDS ='));
  assert.doesNotMatch(cols, /moneyline|spread|odds|price|line/i, 'no book number is an input');
  const vd = read('scripts/validate_data.py');
  assert.match(vd, /"atd_backtest\.schema\.json": "atd_backtest\.json"/);
  assert.match(vd, /check_atd_backtest\(/);
});
