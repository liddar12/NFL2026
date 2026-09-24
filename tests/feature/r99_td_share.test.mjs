/* tests/feature/r99_td_share.test.mjs — R99 E1-S3: a player's share of his team's TDs.
 *
 *   AC1 shares per team-game sum to <= 1, including when every player's history
 *       would claim more;
 *   AC2 the R92 depth cascade: an OUT starter has no share (he is not offered)
 *       and his backup's share RISES from what it is with the starter active;
 *   AC3 a player with no history takes his position's prior, never 0.
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

test('R99 S3 AC1: team shares sum to <= 1 on every team-game, even when history claims more', () => {
  const r = py(`
uni, tg = S.league()
worst = 0.0
for s in (2024,):
    for w in range(1, 11):
        sums = {}
        for p in S.week_preds(uni, tg, s, w).values():
            sums[p["team"]] = sums.get(p["team"], 0.0) + p["share"]
        worst = max([worst] + list(sums.values()))
# every AAA player has scored every TD of every game so far: raw shares sum far past 1
u2 = copy.deepcopy(uni)
for k, rec in u2.items():
    if rec["team"] == "AAA" and (k[0] == 2023 or k[1] < 6):
        rec["rush_tds"], rec["rec_tds"] = 1, 1
t2 = copy.deepcopy(tg)
for k, g in t2.items():
    if k[2] == "AAA":
        g["tds"] = 2
greedy = sum(p["share"] for p in S.week_preds(u2, t2, 2024, 6).values() if p["team"] == "AAA")
print(json.dumps({"worst": worst, "greedy": greedy}))`);
  assert.ok(r.worst <= 1 + 1e-9, `a team-game summed to ${r.worst}`);
  assert.ok(r.greedy <= 1 + 1e-9 && r.greedy > 0.99, `the cap binds at exactly 1 (${r.greedy})`);
});

test('R99 S3 AC2: an OUT starter has no share and his backup inherits (R92 cascade)', () => {
  const r = py(`
uni, tg = S.league()
with_rb1 = S.week_preds(uni, tg, 2024, 6)
u2 = {k: v for k, v in uni.items() if not (k[0] == 2024 and k[1] == 6 and k[2] == "AAA-RB1")}
without = S.week_preds(u2, tg, 2024, 6)
off = S.week_preds(u2, tg, 2024, 6, dict(A.PARAMS, cascade_weeks=0))
print(json.dumps({"rb1_offered": "AAA-RB1" in without,
  "rb2": [with_rb1["AAA-RB2"]["share"], without["AAA-RB2"]["share"], off["AAA-RB2"]["share"]],
  "wr1": [with_rb1["AAA-WR1"]["share"], without["AAA-WR1"]["share"]],
  "other_team": [with_rb1["BBB-RB1"]["p_model"], without["BBB-RB1"]["p_model"]]}))`);
  assert.equal(r.rb1_offered, false, 'the OUT starter is not offered at all');
  const [before, after, noCascade] = r.rb2;
  assert.ok(after > before * 1.5, `RB2 share must rise when RB1 is out (${before} -> ${after})`);
  assert.equal(noCascade, before, 'control: with the cascade off, RB2 does not inherit (the test can go red)');
  assert.equal(r.wr1[0], r.wr1[1], 'the RB1 mass goes to the RB room, not to the receivers');
  assert.equal(r.other_team[0], r.other_team[1], 'another team is untouched');
});

test('R99 S3 AC3: a player with no history takes the position prior, never 0', () => {
  const r = py(`
uni, tg = S.league()
rookie = dict(uni[(2024, 6, "AAA-WR2")], pid="AAA-ROOKIE", name="Rookie", rush_tds=0, rec_tds=0)
uni[(2024, 6, "AAA-ROOKIE")] = rookie
p = S.week_preds(uni, tg, 2024, 6)["AAA-ROOKIE"]
by_week, tg_week = A._index(uni, tg)
h = A._history_for(2024, 6, by_week, tg_week, A.PARAMS["prev_w"])
ns = h.new_share["WR"]
base, opp, has_history = A.base_share(h, "AAA-ROOKIE", "WR")
vet = A.base_share(h, "AAA-WR2", "WR")
print(json.dumps({"p": p["p_model"], "share": p["share"], "prior": ns[0] / ns[1],
                  "base": base, "has_history": has_history, "vet_history": vet[2]}))`);
  assert.ok(r.prior > 0, 'the synthetic league has first-appearance WR TDs');
  assert.equal(r.has_history, false);
  assert.equal(r.vet_history, true, 'control: a veteran is priced from his own history');
  assert.equal(r.base, r.prior, 'no history = the WR first-appearance prior, exactly');
  assert.ok(r.share > 0 && r.p > 0.01, `a rookie is never priced at 0 (share ${r.share}, p ${r.p}; the team cap may scale it)`);
});
