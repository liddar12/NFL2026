/* tests/feature/r101_atd_legs.test.mjs — R101 (R99 E1-S5): anytime-TD legs this week.
 *
 * scripts/build_atd_week.py prices this week's players with the ATD model
 * (scripts/backtest_atd.py, imported — one implementation); scripts/build_leg_pool.py
 * offers them as `atd_legs`. Locked here:
 *   AC1 no ATD leg on a player who does not play this week — at pricing AND again
 *       in the pool (a player ruled out after the ATD file was written loses it);
 *   AC2 no ATD leg exists while atd_backtest.json is not adopted, nor from a stale
 *       week's file;
 *   the pool's number is the ATD file's number verbatim (one pricing path), and
 *   the validator refuses each violation on its own;
 *   the R92 cascade in the live path: an OUT starter's share goes to his backup;
 *   the daily pipeline builds atd_week.json BEFORE the pool, continue-on-error.
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
    input: `import json, sys, copy\nsys.path.insert(0, ".")\nfrom scripts import build_atd_week as W, build_leg_pool as L, validate_data as V\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// A tiny two-team league with three weeks of history, priced for week 4.
const LEAGUE = `
uni, tg = {}, {}
for w in range(1, 4):
    for team, opp, home in (("AAA", "BBB", True), ("BBB", "AAA", False)):
        g = {"opp": opp, "home": home, "tds": 0, "carries": 0.0, "targets": 0.0}
        for pid, pos, c, t, td in (("n1", "RB", 18, 3, 1), ("n2", "RB", 4, 1, 0), ("n3", "WR", 0, 8, 1), ("n4", "TE", 0, 4, 0)):
            pid = team + pid
            uni[(2026, w, pid)] = {"season": 2026, "week": w, "pid": pid, "name": pid, "pos": pos,
                                   "team": team, "opp": opp, "home": home, "carries": float(c), "targets": float(t),
                                   "rush_tds": td if pos == "RB" else 0, "rec_tds": td if pos in ("WR", "TE") else 0}
            g["tds"] += td; g["carries"] += c; g["targets"] += t
        tg[(2026, w, team)] = g
games = [{"game_id": "G1", "home": "AAA", "away": "BBB"}]
app = [{"gsis_id": "espn-1", "name": "Alpha Back", "team": "AAA", "position": "RB"},
       {"gsis_id": "espn-2", "name": "Beta Back", "team": "AAA", "position": "RB"},
       {"gsis_id": "espn-3", "name": "Gamma Wide", "team": "AAA", "position": "WR"}]
ids = {"espn-1": "AAAn1", "espn-2": "AAAn2", "espn-3": "AAAn3"}
play = {"this_week": {"playable": True}}
sits = {"this_week": {"playable": False, "reason": "OUT"}}
`;

test('R101 AC1: only players who play are priced; an OUT starter cascades to his backup', () => {
  const r = py(`${LEAGUE}
all_in, c1 = W.price_week(uni, tg, 2026, 4, games, app, {k: play for k in ids}, ids)
out, c2 = W.price_week(uni, tg, 2026, 4, games, app, dict({k: play for k in ids}, **{"espn-1": sits}), ids)
off = W.price_week(uni, tg, 2026, 4, games, app, dict({k: play for k in ids}, **{"espn-1": sits}), ids,
                   params=dict(W.A.PARAMS, cascade_weeks=0))[0]
p1 = {x["gsis_id"]: x for x in all_in}; p2 = {x["gsis_id"]: x for x in out}; p3 = {x["gsis_id"]: x for x in off}
print(json.dumps({"priced": sorted(p1), "priced_out": sorted(p2), "not_playable": c2["not_playable"],
  "presumed": c1["presumed_active_non_app"],
  "backup": [p1["espn-2"]["model_prob"], p2["espn-2"]["model_prob"], p3["espn-2"]["model_prob"]],
  "wr": [p1["espn-3"]["model_prob"], p2["espn-3"]["model_prob"]],
  "market": sorted({x["market"] for x in all_in})}))`);
  assert.deepEqual(r.priced, ['espn-1', 'espn-2', 'espn-3']);
  assert.deepEqual(r.priced_out, ['espn-2', 'espn-3'], 'the OUT starter is not priced');
  assert.equal(r.not_playable, 1);
  assert.ok(r.presumed >= 5, 'nflverse players the app does not list still share their team TDs');
  const [before, after, noCascade] = r.backup;
  assert.ok(after > before * 1.3, `the backup inherits (${before} -> ${after})`);
  assert.ok(noCascade < after, 'control: with the cascade off he does not (the test can go red)');
  assert.equal(r.wr[0], r.wr[1], 'the RB1 share goes to the RB room, not to the receiver');
  assert.deepEqual(r.market, ['anytime_td']);
});

test('R101 AC2: the pool offers ATD legs only on an adopted model, for its own week, playable only', () => {
  const r = py(`${LEAGUE}
rows, _ = W.price_week(uni, tg, 2026, 4, games, app, {k: play for k in ids}, ids)
doc = W.document(2026, 4, rows, {}, {"adopted": True, "verdict": "ADOPTED — ok"})
weekly = {k: play for k in ids}
ok, why_ok = L.atd_legs(doc, {"adopted": True}, weekly, 2026, 4)
not_adopted = L.atd_legs(doc, {"adopted": False}, weekly, 2026, 4)[0]
stale = L.atd_legs(doc, {"adopted": True}, weekly, 2026, 5)
ruled_out = L.atd_legs(doc, {"adopted": True}, dict(weekly, **{"espn-1": sits}), 2026, 4)[0]
held = W.document(2026, 4, rows, {}, {"adopted": False, "verdict": "NOT ADOPTED — x"})
same = all(leg["rungs"][0]["model_prob"] == next(p for p in rows if p["gsis_id"] == leg["gsis_id"])["model_prob"] for leg in ok)
print(json.dumps({"ok": len(ok), "why": why_ok, "not_adopted": len(not_adopted), "stale": [len(stale[0]), stale[1]],
  "ruled_out": sorted(l["gsis_id"] for l in ruled_out), "held_players": len(held["players"]), "same": same,
  "rung": ok[0]["rungs"][0], "pricing": ok[0]["pricing"]}))`);
  assert.equal(r.ok, 3);
  assert.equal(r.not_adopted, 0, 'no ATD leg while the verdict is not adopted');
  assert.equal(r.stale[0], 0);
  assert.match(r.stale[1], /is for 2026 wk 4, this pool is 2026 wk 5/);
  assert.deepEqual(r.ruled_out, ['espn-2', 'espn-3'], 'ruled out after pricing = no leg');
  assert.equal(r.held_players, 0, 'a not-adopted week file prices nobody');
  assert.equal(r.same, true, 'the pool number is the ATD file number verbatim');
  assert.equal(r.rung.line, 0.5);
  assert.equal(r.pricing, 'atd_model');
});

test('R101: the validator refuses each violation on its own', () => {
  const r = py(`${LEAGUE}
rows, _ = W.price_week(uni, tg, 2026, 4, games, app, {k: play for k in ids}, ids)
wk = json.loads(json.dumps(W.document(2026, 4, rows, {}, {"adopted": True, "verdict": "ADOPTED — ok"})))
legs = L.atd_legs(wk, {"adopted": True}, {k: play for k in ids}, 2026, 4)[0]
pool = {"season": 2026, "week": 4, "atd_legs": legs}
bt = {"adopted": True}
def run(p, w, b):
    try:
        V.check_atd_offered(p, w, b); return "ok"
    except V.ValidationError as e:
        return str(e)
repriced = copy.deepcopy(pool); repriced["atd_legs"][0]["rungs"][0]["model_prob"] = 0.9
print(json.dumps({"honest": run(pool, wk, bt), "not_adopted": run(pool, wk, {"adopted": False}),
  "stale": run(dict(pool, week=5), wk, bt), "repriced": run(repriced, wk, bt),
  "week_file_unadopted_model": run({"atd_legs": []}, wk, {"adopted": False}),
  "nothing_offered": run({"atd_legs": []}, None, None)}))`);
  assert.equal(r.honest, 'ok');
  assert.match(r.not_adopted, /offers 3 ATD leg\(s\) on a model that is not adopted/);
  assert.match(r.stale, /without an atd_week.json for its week/);
  assert.match(r.repriced, /priced 0.9, atd_week.json says/);
  assert.match(r.week_file_unadopted_model, /prices 3 player\(s\) but atd_backtest.json is not adopted/);
  assert.equal(r.nothing_offered, 'ok');
});

test('R101: an ATD leg on a player who sits is refused by the R77 invariant too', () => {
  const r = py(`
weekly = {"model": {"this_week": {"wk": 4}}, "players": [
  {"gsis_id": "espn-1", "this_week": {"playable": False, "reason": "OUT"}, "weeks": []},
  {"gsis_id": "espn-2", "weeks": []}]}
pool = {"week": 4, "counts": {"not_playable": 1}, "players": [], "atd_legs": [
  {"gsis_id": "espn-1", "player": "Alpha Back"}, {"gsis_id": "espn-2", "player": "Beta Back"}]}
try:
    V.check_no_unplayable_legs(weekly, {"week": 4, "parlays": []}, pool); print(json.dumps("ok"))
except V.ValidationError as e:
    print(json.dumps(str(e)))`);
  assert.match(r, /atd_legs: Alpha Back is priced on a player who does not play this week/);
  assert.doesNotMatch(r, /Beta Back/);
});

test('R101: the daily pipeline prices ATD before the pool, continue-on-error; selftest in the gate', () => {
  const yml = read('.github/workflows/daily.yml');
  const atd = yml.indexOf('python3 scripts/build_atd_week.py --cache "$RUNNER_TEMP/atd"');
  const pool = yml.indexOf('python3 scripts/build_leg_pool.py');
  assert.ok(atd > 0 && pool > atd, 'atd_week.json is written before the pool reads it');
  const block = yml.slice(yml.lastIndexOf('- name:', atd), atd + 200);
  assert.match(block, /continue-on-error: true/);
  assert.match(read('tests/smoke.sh'), /python3 scripts\/build_atd_week\.py --selftest/);
  const src = read('scripts/build_atd_week.py');
  assert.match(src, /from scripts import backtest_atd as A/, 'the model is imported, not copied');
  assert.doesNotMatch(src, /moneyline|spread_line|odds|implied/i, 'no book number is read');
});
