/* tests/feature/r100_pool_learning.test.mjs — R100: MY PARLAYS learns from this season.
 *
 * The pool calibration is fit on 2023-25. Until R100 the weekly grades of the MY
 * cards the app offered (data/my_card_scores.json) were recorded and never read
 * back. Measured 2026-09-24 on week 2: 166 distinct legs offered at 54.5 % on
 * average hit 68.1 % — every probability band ran low. This season's evidence now
 * enters as a two-number correction layer sigmoid(a + b*logit(p)) fit on 2026 legs
 * alone, and ships only when it wins on held-out weeks. Locked here:
 *   1. the join: one observation per distinct graded leg, game legs excluded;
 *   2. the rule: under 100 legs or 2 held-out weeks it holds; a season that really
 *      is underconfident gets a layer that lifts the probabilities and scores better
 *      on the weeks it never saw; a calibrated season, or one where a held-out week
 *      goes the other way, is left alone;
 *   3. pricing: without an applied layer every rung is the pre-R100 number exactly;
 *      with one, rungs stay ordered (a higher line is never more likely);
 *   4. the builder reads the layer only when `applied`, and the contract refuses a
 *      layer whose slope would reverse the legs.
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
    input: `import json, math, random, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const SYN = `
from scripts import backtest_leg_pool as b
def season(weeks, lift, n=80, seed=7):
    """Legs offered at p; the truth is p + lift (clamped). lift 0 = calibrated."""
    rnd = random.Random(seed)
    rows = []
    for w in weeks:
        for i in range(n):
            p = 0.3 + 0.5 * rnd.random()
            truth = min(max(p + (lift(w) if callable(lift) else lift), 0.02), 0.98)
            rows.append({"week": w, "pos": "WR", "p": p, "y": 1 if rnd.random() < truth else 0})
    return rows
`;

test('R100: the join — one observation per distinct graded leg, game legs never', () => {
  const r = py(`
from scripts import backtest_leg_pool as b
cards = [{"week": 2, "cards": [
  {"legs": [{"selection": "A 60+ rec yds", "mu": 70.0, "model_prob": 0.6, "position": "WR"},
            {"selection": "KC ML", "model_prob": 0.7}]},
  {"legs": [{"selection": "A 60+ rec yds", "mu": 70.0, "model_prob": 0.6, "position": "WR"},
            {"selection": "B 40+ rush yds", "mu": 50.0, "model_prob": 0.55, "position": "RB"}]}]}]
scores = {"cards": [
  {"week": 2, "legs": [{"selection": "A 60+ rec yds", "result": "hit"}, {"selection": "KC ML", "result": "hit"}]},
  {"week": 2, "legs": [{"selection": "A 60+ rec yds", "result": "hit"}, {"selection": "B 40+ rush yds", "result": "miss"},
                       {"selection": "C 20+ rec yds", "result": "hit"}]}]}
rows = b.live_rows(cards, scores)
real = b.load_live_rows()
print(json.dumps({"rows": rows, "real_n": len(real),
  "real_ok": all(r["y"] in (0, 1) and 0 < r["p"] < 1 and r["pos"] in ("QB", "RB", "WR") for r in real)}))`);
  assert.deepEqual(r.rows, [
    { week: 2, pos: 'RB', p: 0.55, y: 0 },
    { week: 2, pos: 'WR', p: 0.6, y: 1 },
  ], 'the repeated leg counts once, the ML leg and the never-offered leg not at all');
  assert.ok(r.real_n > 0, 'the committed ledger yields graded legs');
  assert.equal(r.real_ok, true);
});

test('R100: the rule — hold until it has earned it, apply when it wins on unseen weeks', () => {
  // Rates over 40 simulated seasons, not one seed: a single seed can be picked to
  // pass. Weeks carry 200 graded legs, the size a real MY week grades (week 2: 166).
  const r = py(`${SYN}
res = {"under": 0, "calibrated": 0, "flip": 0}
lift_ok, better_ok = True, True
for seed in range(40):
    u = b.live_recalibration(season([2, 3, 4], 0.14, n=200, seed=seed))
    if u["applied"]:
        res["under"] += 1
        lift_ok &= b.recal_apply((u["adjustment"]["a"], u["adjustment"]["b"]), 0.5) > 0.5
        better_ok &= all(p["adjusted_log_loss"] <= p["raw_log_loss"] for p in u["per_week"])
    res["calibrated"] += b.live_recalibration(season([2, 3, 4], 0.0, n=200, seed=seed))["applied"]
    res["flip"] += b.live_recalibration(season([2, 3, 4], lambda w: 0.14 if w < 4 else -0.14, n=200, seed=seed))["applied"]
thin = b.live_recalibration(season([2, 3, 4], 0.14, n=30))
one_held = b.live_recalibration(season([2, 3], 0.14, n=200))
print(json.dumps({**res, "lift_ok": lift_ok, "better_ok": better_ok,
  "thin": thin["applied"], "thin_reason": thin["reason"],
  "one_held": one_held["applied"], "one_held_reason": one_held["reason"]}))`);
  assert.ok(r.under >= 30, `a really underconfident season must get its layer most of the time (${r.under}/40)`);
  assert.equal(r.lift_ok, true, 'and every layer it gets raises what was under-priced');
  assert.equal(r.better_ok, true, 'and wins on every held-out week it was judged on');
  assert.ok(r.calibrated <= 4, `a calibrated season is rarely touched (${r.calibrated}/40)`);
  assert.equal(r.flip, 0, 'a season that turns around is never adopted');
  assert.equal(r.thin, false);
  assert.match(r.thin_reason, /needs >= 100/);
  assert.equal(r.one_held, false);
  assert.match(r.one_held_reason, /only on >= 2/);
});

test('R100: pricing — no layer is the pre-R100 number; a layer keeps the rungs in order', () => {
  const r = py(`
from scripts import build_leg_pool as lp
coef = {"a": 0.1, "b": 1.3, "c": 0.8}
def old(z, pt):
    p = 1.0 / (1.0 + math.exp(-(coef["a"] + coef["b"] * z + coef["c"] * (pt - 0.5))))
    return round(min(max(p, lp.PROB_CLAMP[0]), lp.PROB_CLAMP[1]), 4)
zs = [x / 10.0 for x in range(-15, 16)]
same = all(lp.pool_prob(coef, z, 0.6) == old(z, 0.6) for z in zs)
live = {"a": 0.35, "b": 1.1}
seq = [lp.pool_prob(coef, z, 0.6, live) for z in sorted(zs, reverse=True)]   # higher line = lower z
print(json.dumps({"same": same, "ordered": all(x >= y for x, y in zip(seq, seq[1:])),
  "moved": any(lp.pool_prob(coef, z, 0.6, live) != old(z, 0.6) for z in zs)}))`);
  assert.equal(r.same, true);
  assert.equal(r.ordered, true);
  assert.equal(r.moved, true);
});

test('R100: the builder reads the layer only when applied; the contract refuses a reversing slope', () => {
  const r = py(`
from scripts import build_leg_pool as lp
from scripts.validate_data import validate_against_schema, ValidationError
bt = json.load(open("data/leg_pool_backtest.json"))
inputs = lp.load_inputs()
def with_live(applied, adj):
    d = json.loads(json.dumps(bt))
    d["live_2026"] = {"weeks": [2, 3, 4], "legs": 300, "offered_mean": 0.55, "hit_rate": 0.66, "per_week": [],
                      "adjustment": adj, "applied": applied, "reason": "test"}
    i = dict(inputs); i["pool_backtest"] = d
    return lp.build(i)
off = with_live(False, {"a": 0.4, "b": 1.1})
on = with_live(True, {"a": 0.4, "b": 1.1})
p_off = [r["model_prob"] for p in off["players"] for r in p["rungs"]]
p_on = [r["model_prob"] for p in on["players"] for r in p["rungs"]]
schema = json.load(open("data/contracts/leg_pool_backtest.schema.json"))
bad = json.loads(json.dumps(bt)); bad["live_2026"] = {"weeks": [2], "legs": 1, "offered_mean": 0.5, "hit_rate": 0.5,
  "per_week": [], "adjustment": {"a": 0.0, "b": -1.0}, "applied": True, "reason": "x"}
try:
    validate_against_schema(bad, schema, "t"); refused = False
except ValidationError:
    refused = True
print(json.dumps({"off_none": off["live_adjustment"] is None, "on_set": on["live_adjustment"],
  "n": len(p_off), "raised": sum(b > a for a, b in zip(p_off, p_on)), "refused": refused}))`);
  assert.equal(r.off_none, true, 'a layer that has not earned it is never read');
  assert.deepEqual(r.on_set, { a: 0.4, b: 1.1 });
  assert.ok(r.n > 0);
  assert.ok(r.raised > r.n / 2, 'an applied lifting layer raises the offered probabilities');
  assert.equal(r.refused, true);
});
