/* tests/feature/r99_team_td.test.mjs — R99 E1-S2: team TD expectation.
 *
 *   AC1 no week reads data from itself or later: planting future rows and
 *       rewriting the week's own outcomes leaves every prediction for that week
 *       unchanged (who is ACTIVE that week is known before kickoff and is used;
 *       what they SCORED is not);
 *   AC2 mean predicted lambda vs mean realised team TDs, pooled over held-out
 *       2024-25, must sit inside +/-5% or the verdict refuses adoption and says so.
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
    input: `import json, sys, copy\nsys.path.insert(0, ".")\nsys.path.insert(0, "tests/fixtures/r99")\nfrom scripts import backtest_atd as A\nimport atd_synth as S\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('R99 S2 AC1: a planted future row and the week\'s own outcomes change nothing', () => {
  const r = py(`
uni, tg = S.league()
KEYS = ("p_model", "p_base", "p_opp", "share", "lam")
before = {pid: [p[k] for k in KEYS] for pid, p in S.week_preds(uni, tg, 2024, 6).items()}
u2, t2 = copy.deepcopy(uni), copy.deepcopy(tg)
# the week itself: every player scores twice
for k, r in u2.items():
    if k[0] == 2024 and k[1] == 6:
        r["rush_tds"], r["rec_tds"] = 2, 2
for k, g in t2.items():
    if k[0] == 2024 and k[1] == 6:
        g["tds"] = 99
# the future: a monster week 7-10 for team AAA
for k, r in u2.items():
    if k[0] == 2024 and k[1] >= 7 and r["team"] == "AAA":
        r["rush_tds"], r["rec_tds"], r["carries"] = 5, 5, 99.0
for k, g in t2.items():
    if k[0] == 2024 and k[1] >= 7:
        g["tds"] = 50
after = {pid: [p[k] for k in KEYS] for pid, p in S.week_preds(u2, t2, 2024, 6).items()}
moved = sorted(pid for pid in before if before[pid] != after[pid])
# control: the same edit made to a PAST week does move week 6
u3 = copy.deepcopy(uni)
for k, r in u3.items():
    if k[0] == 2024 and k[1] == 5 and r["team"] == "AAA":
        r["rush_tds"], r["rec_tds"] = 5, 5
past = {pid: [p[k] for k in KEYS] for pid, p in S.week_preds(u3, tg, 2024, 6).items()}
print(json.dumps({"n": len(before), "moved": moved, "past_moved": sum(before[p] != past[p] for p in before)}))`);
  assert.equal(r.n, 24);
  assert.deepEqual(r.moved, [], 'week 6 predictions read nothing from week 6 outcomes or later');
  assert.ok(r.past_moved > 0, 'control: a past-week change does reach week 6 (the test can go red)');
});

test('R99 S2 AC2: pooled 2024-25 team TDs outside +/-5% refuses adoption, by name', () => {
  const r = py(`
def rep(lam, act):
    good = {"n": 100, "log_loss": 0.38, "brier": 0.11, "calibration_intercept": 0.0,
            "calibration_slope": 1.0, "mean_p": 0.16, "hit_rate": 0.16}
    base = dict(good, log_loss=0.43, brier=0.13)
    return {"model": good, "position_base_rate": base, "opportunity_only": dict(base, log_loss=0.39, brier=0.12),
            "team_td": {"team_games": 544, "mean_lambda": lam, "mean_realised": act, "ratio": round(lam / act, 4)}}
ok = A.verdict({"2023": rep(2.3, 2.3), "2024": rep(2.30, 2.40), "2025": rep(2.40, 2.40)})
low = A.verdict({"2023": rep(2.3, 2.3), "2024": rep(2.10, 2.40), "2025": rep(2.20, 2.40)})
pooled = A.pooled_team_td({"2024": rep(2.10, 2.40), "2025": rep(2.20, 2.40)})
print(json.dumps({"ok": ok, "low": low, "pooled": pooled}))`);
  assert.equal(r.ok[0], true, 'a 2% miss pooled is inside the band');
  assert.equal(r.low[0], false);
  assert.match(r.low[1], /team TDs 2024-2025: mean lambda \/ mean realised 0\.8958 outside \[0\.95, 1\.05\]/);
  assert.equal(r.pooled.team_games, 1088);
});
