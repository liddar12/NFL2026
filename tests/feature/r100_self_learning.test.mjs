/* tests/feature/r100_self_learning.test.mjs — R100: this season's results can move
 * the number that ships (owner, 2026-09-24: "enable the self learning ai based on
 * the results of this season, so that the parlay accuracy continues to improve").
 *
 * Before R100 the player-signal loop could only PROPOSE, and its incumbent was the
 * gated series, which never ships. Its 9/22 "proposal" was all signals at 1.0 —
 * exactly what already shipped under the R49 override — so nothing was waiting to
 * be applied; the gap was that nothing COULD be. Locked here:
 *   1. absent learned weights, every projection is byte-identical to pre-R100;
 *   2. the decision rule: hold under 2 held-out weeks, hold if any week is worse or
 *      the gain is under the margin, adopt otherwise, revert when full strength
 *      beats the learned weights;
 *   3. end to end, --adopt writes the weights with a receipt the validator accepts,
 *      and a later season that disagrees reverts them;
 *   4. the validator refuses a weight with no passing receipt;
 *   5. the live pipeline reads the key on both projection passes, and the weekly
 *      workflow runs the fit with --adopt.
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
    input: `import json, os, sys, tempfile\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('R100: no learned weights = the pre-R100 number, byte for byte', () => {
  // Players in the shape the LIVE pipeline hands project_player (espn_players
  // records: prior_season_points / prior_games / age). data/fixtures/
  // players_sample.json is an older shape whose candidate baseline is 0, so a
  // test on it would pass while proving nothing — every number would be 0.
  const r = py(`
from scripts.models import player_projection as pp
players = []
for i, (pos, age) in enumerate([("QB", 24), ("QB", 38), ("RB", 22), ("RB", 31), ("WR", 26),
                                ("WR", 33), ("TE", 29), ("TE", 35)]):
    players.append({"gsis_id": "espn-%d" % i, "name": "P%d" % i, "team": "KC", "position": pos,
                    "age": age, "prior_season_points": 120.0 + 17 * i, "prior_games": 14 + i % 4,
                    "injury_status": "QUESTIONABLE" if i % 3 == 0 else None})
names = set()
for p in players:
    names |= set(pp.compute_raw_signals(p, None).keys())
a = pp.project_players(players)
b = pp.project_players(players, candidate_weights=None)
c = pp.project_players(players, candidate_weights={n: 1.0 for n in names})
z = pp.project_players(players, candidate_weights={n: 0.0 for n in names})
print(json.dumps({"n": len(a), "nonzero": all(x["proj_points"] > 0 for x in a),
  "active_signals": sum(1 for p in players for v in pp.compute_raw_signals(p, None).values() if v != 1.0),
  "same_none": a == b, "same_ones": a == c,
  "moved_at_zero": sum(x["proj_points"] != y["proj_points"] for x, y in zip(a, z))}))`);
  assert.equal(r.n, 8);
  assert.equal(r.nonzero, true, 'the players really project — a test on zeros proves nothing');
  assert.ok(r.active_signals >= 3, 'several signals are live, so the weights have something to act on');
  assert.equal(r.same_none, true);
  assert.equal(r.same_ones, true, 'weight 1.0 must be the full-strength number exactly, not a float away');
  assert.ok(r.moved_at_zero >= 3, 'and a learned weight really does reach the shipped number');
});

test('R100: the decision rule — hold, adopt, revert', () => {
  const r = py(`
from scripts import fit_player_signals as f
def wf(folds, inc, cand, full, per=None):
    per = per or [{"week": 2 + i, "incumbent_mae": inc, "candidate_mae": cand} for i in range(folds)]
    return {"folds": folds, "incumbent_mae": inc, "candidate_mae": cand, "full_strength_mae": full, "per_fold": per}
ones = {"age_curve": 1.0}
half = {"age_curve": 0.5}
out = {
 "one_week": f.adoption_decision(wf(1, 6.0, 5.0, 6.0), ones, half, 0.10)[0],
 "adopt": f.adoption_decision(wf(2, 6.0, 5.8, 6.0), ones, half, 0.10)[0],
 "under_margin": f.adoption_decision(wf(2, 6.0, 5.95, 6.0), ones, half, 0.10)[0],
 "a_week_worse": f.adoption_decision(wf(2, 6.0, 5.5, 6.0, per=[{"week": 2, "incumbent_mae": 6.0, "candidate_mae": 6.1}, {"week": 3, "incumbent_mae": 6.0, "candidate_mae": 4.9}]), ones, half, 0.10)[0],
 "same_weights": f.adoption_decision(wf(2, 6.0, 5.5, 6.0), ones, dict(ones), 0.10)[0],
 "revert": f.adoption_decision(wf(2, 6.0, 6.0, 5.9), half, half, 0.10)[0],
 "no_revert_when_learned_wins": f.adoption_decision(wf(2, 5.9, 5.9, 6.0), half, half, 0.10)[0],
}
print(json.dumps(out))`);
  assert.deepEqual(r, {
    one_week: 'hold', adopt: 'adopt', under_margin: 'hold', a_week_worse: 'hold',
    same_weights: 'hold', revert: 'revert', no_revert_when_learned_wins: 'hold',
  });
});

const E2E = `
from scripts import fit_player_signals as f
from scripts.validate_data import check_candidate_signal_weights, ValidationError
tmp = tempfile.mkdtemp()
P = {k: os.path.join(tmp, k + ".json") for k in ("scores", "meta", "tuning")}
json.dump({"weights": {"age_curve": 0.0}}, open(P["meta"], "w"))
json.dump({"history": []}, open(P["tuning"], "w"))
def season(true_w, weeks=(1, 2, 3)):
    json.dump({"weeks_resolved": len(weeks), "resolved": f._rows(list(weeks), true_w=true_w)}, open(P["scores"], "w"))
def tuning():
    return json.load(open(P["tuning"]))
def valid(t):
    try:
        check_candidate_signal_weights(t); return True
    except ValidationError:
        return False
`;

test('R100: --adopt learns from a season that disagrees with full strength, and the receipt validates', () => {
  const r = py(`${E2E}
season(true_w=0.0)                       # the signal is pure noise this season
e = f.run(P["scores"], P["meta"], P["tuning"], adopt=True, now="2026-10-01T00:00:00Z")
t = tuning()
rec = t.get("candidate_signal_weights") or {}
print(json.dumps({"action": e["auto"]["action"], "applied": e["auto"]["applied"],
  "weights": rec.get("weights"), "kind": rec.get("kind"), "folds": rec.get("folds"),
  "valid": valid(t), "archived": t["history"][-1]["auto"]["action"],
  "meta_untouched": json.load(open(P["meta"])) == {"weights": {"age_curve": 0.0}}}))`);
  assert.equal(r.action, 'adopt');
  assert.equal(r.applied, true);
  assert.deepEqual(r.weights, { age_curve: 0.0 }, 'the loop learned to switch the noisy signal off');
  assert.equal(r.kind, 'adopt');
  assert.equal(r.folds, 2);
  assert.equal(r.valid, true, 'the receipt it wrote satisfies the validator');
  assert.equal(r.archived, 'adopt');
  assert.equal(r.meta_untouched, true, 'meta.json registry weights are never touched');
});

test('R100: a later season that disagrees reverts the learned weights; one week is never enough', () => {
  const r = py(`${E2E}
season(true_w=0.0); f.run(P["scores"], P["meta"], P["tuning"], adopt=True, now="t1")
season(true_w=1.0)                       # now the signal is exactly right
e = f.run(P["scores"], P["meta"], P["tuning"], adopt=True, now="t2")
t = tuning(); rec = t["candidate_signal_weights"]
json.dump({"history": []}, open(P["tuning"], "w"))
season(true_w=0.0, weeks=(1, 2))         # only ONE held-out week
e1 = f.run(P["scores"], P["meta"], P["tuning"], adopt=True, now="t3")
print(json.dumps({"action": e["auto"]["action"], "weights": rec["weights"], "kind": rec["kind"],
  "valid": valid(t), "one_week": e1["auto"]["action"],
  "one_week_wrote": "candidate_signal_weights" in tuning()}))`);
  assert.equal(r.action, 'revert');
  assert.deepEqual(r.weights, { age_curve: 1.0 });
  assert.equal(r.kind, 'revert');
  assert.equal(r.valid, true);
  assert.equal(r.one_week, 'hold');
  assert.equal(r.one_week_wrote, false, 'nothing ships on a single held-out week');
});

test('R100: the validator refuses a learned weight that did not earn its place', () => {
  const r = py(`
from scripts.validate_data import check_candidate_signal_weights, ValidationError
good = {"weights": {"age_curve": 0.5}, "kind": "adopt", "adopted_utc": "t", "folds": 2, "margin": 0.1,
        "incumbent_mae": 6.0, "candidate_mae": 5.8,
        "per_fold": [{"week": 2, "incumbent_mae": 6.0, "candidate_mae": 5.8}, {"week": 3, "incumbent_mae": 6.0, "candidate_mae": 5.8}]}
def ok(rec):
    try:
        check_candidate_signal_weights({"candidate_signal_weights": rec}); return True
    except ValidationError:
        return False
cases = {
 "good": good,
 "hand_edited": {"weights": {"age_curve": 0.5}, "adopted_utc": "t"},
 "off_grid": {**good, "weights": {"age_curve": 0.6}},
 "one_fold": {**good, "folds": 1, "per_fold": good["per_fold"][:1]},
 "under_own_margin": {**good, "candidate_mae": 5.95},
 "a_week_worse": {**good, "per_fold": [{"week": 2, "incumbent_mae": 6.0, "candidate_mae": 6.2}, good["per_fold"][1]]},
 "bad_revert": {"weights": {"age_curve": 0.5}, "kind": "revert", "adopted_utc": "t", "full_strength_mae": 5.0, "incumbent_mae": 6.0},
}
out = {k: ok(v) for k, v in cases.items()}
try:
    check_candidate_signal_weights({}); out["absent"] = True
except ValidationError:
    out["absent"] = False
print(json.dumps(out))`);
  assert.deepEqual(r, {
    good: true, hand_edited: false, off_grid: false, one_fold: false,
    under_own_margin: false, a_week_worse: false, bad_revert: false, absent: true,
  });
});

test('R100: the live pipeline reads the learned weights on both projection passes; the workflow adopts', () => {
  const bp = read('scripts/build_predictions.py');
  assert.match(bp, /get\("candidate_signal_weights"\)/);
  assert.equal((bp.match(/candidate_weights=cand_weights/g) || []).length, 2,
    'the first pass AND the injury re-projection must both use the learned weights');
  const wf = read('.github/workflows/backtest.yml');
  assert.match(wf, /fit_player_signals\.py --propose --adopt/);
});
