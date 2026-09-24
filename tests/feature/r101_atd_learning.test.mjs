/* tests/feature/r101_atd_learning.test.mjs — R101: the ATD model keeps learning
 * from this season, and can be taken OFF the app by it.
 *
 * Owner (2026-09-24): "Make sure this aligns to self learning AI and continuous
 * improvement and predictability across code bases." Locked here:
 *   1. IN-SEASON DEMOTION. Once the season in progress has IN_SEASON_MIN_WEEKS
 *      whole weeks, a model that does not beat the position base rate on them is
 *      NOT ADOPTED (and so offers no leg) — the verdict names it; under the
 *      minimum the season cannot demote on noise. validate_data.py recomputes it.
 *   2. ONE LEARNING RULE. The in-season correction layer is the R100 rule itself
 *      (scripts/backtest_leg_pool.live_recalibration — same function object), and
 *      the live price moves only when it is `applied`.
 *   3. ONE CORRELATION TABLE. Measured ATD pairs use the app's key grammar
 *      ("a|b" same side, "a|b|opposing"), the method of every parlay_backtest.json
 *      pair (rho_from_events), and a planted dependence is found.
 *   4. The contract walker refuses keywords it does not implement (const, oneOf) —
 *      the hole R99's contract shipped with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys, copy\nsys.path.insert(0, ".")\nfrom scripts import backtest_atd as A, validate_data as V\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const REPORTS = `
def sc(ll, br=0.11, slope=1.0):
    return {"n": 400, "log_loss": ll, "brier": br, "calibration_intercept": 0.0,
            "calibration_slope": slope, "mean_p": 0.16, "hit_rate": 0.16}
def rep():
    return {"model": sc(0.38), "position_base_rate": sc(0.43, 0.13), "opportunity_only": sc(0.39, 0.12),
            "by_position": {}, "reliability": [],
            "team_td": {"team_games": 544, "mean_lambda": 2.4, "mean_realised": 2.4, "ratio": 1.0}}
reports = {"2022": rep(), "2023": rep(), "2024": rep(), "2025": rep()}
def season(weeks, model_ll):
    return {"season": 2026, "weeks": list(range(1, weeks + 1)), "model": sc(model_ll),
            "position_base_rate": sc(0.42, 0.13), "opportunity_only": sc(0.40, 0.12),
            "per_week": [], "live_2026": {"weeks": [], "legs": 0, "applied": False, "adjustment": None, "reason": "hold"}}
`;

test('R101: the season in progress demotes the model after enough weeks, not before', () => {
  const r = py(`${REPORTS}
out = {}
for label, blk in (("none", None), ("good4", season(4, 0.37)), ("bad3", season(3, 0.45)), ("bad4", season(4, 0.45)),
                   ("tie4", season(4, 0.42))):
    out[label] = A.verdict(reports, in_season=blk)
doc = json.loads(json.dumps(A.document(reports, {}, in_season=season(4, 0.45))))
forged = copy.deepcopy(doc); forged["adopted"] = True; forged["verdict"] = "ADOPTED — forced"
errs = {}
for label, d in (("honest", doc), ("forged", forged)):
    try:
        V.check_atd_backtest(d); errs[label] = "ok"
    except V.ValidationError as e:
        errs[label] = str(e)
print(json.dumps({"out": out, "errs": errs, "min": A.IN_SEASON_MIN_WEEKS}))`);
  assert.equal(r.min, 4);
  assert.equal(r.out.none[0], true);
  assert.equal(r.out.good4[0], true);
  assert.equal(r.out.bad3[0], true, 'three weeks cannot demote on noise');
  assert.equal(r.out.bad4[0], false);
  assert.match(r.out.bad4[1], /2026 in-season \(4 weeks\): model log_loss 0\.45000 is not better than the position base rate 0\.42000/);
  assert.equal(r.out.tie4[0], false, 'a tie is not better');
  assert.equal(r.errs.honest, 'ok', 'an honest demotion validates');
  assert.match(r.errs.forged, /says adopted but its receipts do not support it: 2026 in-season/);
});

test('R101: the in-season layer IS the R100 rule, and moves the live price only when applied', () => {
  const r = py(`
import random, inspect
from scripts import build_atd_week as W
from scripts.backtest_leg_pool import live_recalibration
src = inspect.getsource(A.in_season_report)
rnd = random.Random(3)
rows = []
for w in (1, 2, 3):
    for i in range(300):
        p = 0.05 + 0.5 * rnd.random()
        rows.append({"week": w, "p_model": p, "p_base": 0.16, "p_opp": p, "pos": "RB",
                     "y": 1 if rnd.random() < min(0.95, p * 1.4) else 0})
three = A.in_season_report(2026, rows)
two = A.in_season_report(2026, [x for x in rows if x["week"] < 3])
adj = three["live_2026"]["adjustment"]
print(json.dumps({"uses": "live_recalibration(" in src and "from scripts.backtest_leg_pool import live_recalibration" in src,
  "three": [three["live_2026"]["applied"], three["live_2026"]["reason"][:40]],
  "two": [two["live_2026"]["applied"], two["live_2026"]["reason"][:30]],
  "moves": W.apply_live(0.3, adj) > 0.3 if adj else None, "stays": W.apply_live(0.3, None)}))`);
  assert.equal(r.uses, true, 'the same function, not a second copy of the rule');
  assert.equal(r.two[0], false, 'one held-out week: hold');
  assert.match(r.two[1], /hold: 1 held-out week/);
  assert.equal(r.three[0], true, 'a genuine 40% under-statement is corrected on 2 held-out weeks');
  assert.equal(r.moves, true);
  assert.equal(r.stays, 0.3, 'no layer in force: the model number, untouched');
});

test('R101: ATD correlations use the app table grammar and find a planted dependence', () => {
  const r = py(`
from scripts.backtest_parlay import rho_from_events
import inspect
preds, uni = {2024: []}, {}
for w in range(1, 41):
    for team, opp in (("AAA", "BBB"), ("BBB", "AAA")):
        together = 1 if (w * 7 + len(team)) % 3 == 0 else 0
        for pid, pos, p, y in (("a", "RB", 0.4, together), ("b", "WR", 0.3, together), ("c", "QB", 0.1, 0)):
            pid = team + pid
            preds[2024].append({"pid": pid, "pos": pos, "team": team, "opp": opp, "week": w, "home": team == "AAA",
                                "p_model": p, "p_opp": p, "y": y})
            uni[(2024, w, pid)] = {"pass_yds": 300.0 if together else 100.0, "rush_yds": 80.0 * together, "rec_yds": 70.0 * together}
winners = {(2024, w, t): (1 if ((w * 7 + len(t)) % 3 == 0) == (t == "AAA") else 0) for w in range(1, 41) for t in ("AAA", "BBB")}
out = A.measure_correlations(preds, uni, winners, seasons=(2024,))
keys = [p["key"] for p in out["pairs"]]
same = next(p for p in out["pairs"] if p["key"] == "anytime_td|anytime_td")
print(json.dumps({"keys": keys, "same": same["rho"], "n": same["n"], "method": out["method"][:20],
                  "shared": "rho_from_events" in inspect.getsource(A.measure_correlations)}))`);
  for (const k of r.keys) assert.match(k, /^anytime_td\|[a-z_]+(\|opposing)?$/, k);
  assert.ok(r.keys.includes('anytime_td|anytime_td|opposing'));
  assert.ok(r.keys.includes('anytime_td|moneyline'));
  assert.equal(r.same, 1, 'two legs that always land together measure rho 1');
  assert.equal(r.n, 80);
  assert.equal(r.shared, true, 'the same estimator every parlay_backtest.json pair uses');
  assert.match(r.method, /^copula-lite rho/);
});

test('R101: the contract walker refuses const and oneOf instead of skipping them', () => {
  const r = py(`
out = {}
for kw, sub in (("const", {"const": 1}), ("oneOf", {"oneOf": [{"type": "null"}, {"type": "object"}]})):
    try:
        V.validate_against_schema({"x": 2}, {"type": "object", "properties": {"x": sub}}, "t"); out[kw] = "ok"
    except V.ValidationError as e:
        out[kw] = str(e)
bad = []
import glob
for f in glob.glob("data/contracts/*.json"):
    txt = open(f).read()
    if '"const"' in txt or '"oneOf"' in txt or '"anyOf"' in txt:
        bad.append(f)
print(json.dumps({"out": out, "bad": bad}))`);
  assert.match(r.out.const, /does not implement it/);
  assert.match(r.out.oneOf, /does not implement it/);
  assert.deepEqual(r.bad, [], 'no committed contract relies on an unimplemented keyword');
});
