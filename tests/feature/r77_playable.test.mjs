/* tests/feature/r77_playable.test.mjs — R77 THE THIS-WEEK GATE.
 *
 * RCA 2026-09-17: "will he play this week?" was not a first-class fact. An OUT
 * player kept 55% of his points on the current week, a DOUBTFUL kept 70%, a
 * suspended player of unstated length kept everything, a backup quarterback
 * behind a healthy starter projected as if he started — and the leg pool and
 * the slate props priced all of them (Josh Jacobs OUT at 36.5 rush yards, Sam
 * Darnold DOUBTFUL at 168 pass yards, four IR players at mu 0.0 in the week-2
 * pool). This file locks the one predicate that fixes it, end to end:
 *
 *   scripts/availability.NOT_PLAYABLE           -> the vocabulary's answer
 *   build_weekly.player_weeks(gate_week=)       -> mechanic (c): one week zeroed
 *   build_weekly.this_week_gate                 -> status, then QB depth chart
 *   build_weekly_document(this_week=...)        -> `this_week` block + model meta
 *   parlay_builder.build_props_by_game          -> gated players are not candidates
 *   build_leg_pool.prop_legs                    -> gated players carry no leg
 *   validate_data.check_weekly_availability     -> rules 6-8 (round-trip + reds)
 *   validate_data.check_no_unplayable_legs      -> slate + pool refuse a sitter
 *
 * Owner rules locked here: "Zero unless QB1 is out" and "Q priced + labelled,
 * D excluded". Node built-ins only; the Python cores run through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/* One synthetic world: SFX plays weeks 1, 3, 4, 5, 6 (bye in 2); DAL every week.
 * Three SFX quarterbacks on the chart, an OUT running back, a QUESTIONABLE
 * receiver; DAL has an IR tight end, a suspended receiver of unstated length and
 * a projected QB2 behind an UNPROJECTED starter. */
const SETUP = `
import json, sys, copy
sys.path.insert(0, ".")
from scripts import availability as av
from scripts.build_weekly import (build_weekly_document, build_factors, player_weeks,
                                  team_schedule, this_week_gate, unavailability,
                                  _fixture)
SCHED_BY_TEAM, ELOS, SCHED = _fixture()
FX = lambda: build_factors(2026, None, None, None)
PROJ = [
  {"gsis_id": "espn-1", "name": "QB One",   "team": "SFX", "position": "QB", "proj_points": 300.0},
  {"gsis_id": "espn-2", "name": "QB Two",   "team": "SFX", "position": "QB", "proj_points": 120.0},
  {"gsis_id": "espn-3", "name": "QB Three", "team": "SFX", "position": "QB", "proj_points": 40.0},
  {"gsis_id": "espn-4", "name": "Hurt RB",  "team": "SFX", "position": "RB", "proj_points": 200.0},
  {"gsis_id": "espn-5", "name": "Q WR",     "team": "SFX", "position": "WR", "proj_points": 150.0},
  {"gsis_id": "espn-6", "name": "IR TE",    "team": "DAL", "position": "TE", "proj_points": 100.0},
  {"gsis_id": "espn-7", "name": "Susp WR",  "team": "DAL", "position": "WR", "proj_points": 100.0},
  {"gsis_id": "espn-8", "name": "DAL QB",   "team": "DAL", "position": "QB", "proj_points": 250.0},
  {"gsis_id": "espn-9", "name": "DAL RB",   "team": "DAL", "position": "RB", "proj_points": 180.0},
]
DEPTH = {"season": 2026, "updated_utc": "2026-09-16T12:34:22Z", "source": "fixture",
  "positions": ["QB"], "counts": {"teams": 2, "rows": 5}, "teams": {
  "SFX": {"snapshot": "2026-09-16T12:34:22Z", "QB": [
     {"rank": 1, "name": "QB One",   "gsis_id": None, "espn_id": "1"},
     {"rank": 2, "name": "QB Two",   "gsis_id": None, "espn_id": "2"},
     {"rank": 3, "name": "QB Three", "gsis_id": None, "espn_id": "3"}]},
  "DAL": {"snapshot": "2026-09-16T12:34:22Z", "QB": [
     {"rank": 1, "name": "Unprojected Starter", "gsis_id": None, "espn_id": "99"},
     {"rank": 2, "name": "DAL QB",              "gsis_id": None, "espn_id": "8"}]}}}
INJ = [
  {"team": "SFX", "player": "Hurt RB", "status": "Out"},
  {"team": "SFX", "player": "Q WR",    "status": "Questionable"},
  {"team": "DAL", "player": "IR TE",   "status": "Injured Reserve"},
  {"team": "DAL", "player": "Susp WR", "status": "Suspension"},
]
def build(inj=INJ, wk=3, depth=DEPTH, skip=(), proj=PROJ):
    return build_weekly_document(proj, SCHED, ELOS, {}, 2026, "2026-09-17T00:00:00Z",
                                 injuries=inj, factors=FX(), this_week=wk,
                                 first_week=wk if wk else 1, depth_chart=depth,
                                 gate_skip_teams=skip)
def by_id(doc):
    return {p["gsis_id"]: p for p in doc["players"]}
def wkrow(p, wk):
    return next(w for w in p["weeks"] if w["wk"] == wk)
def emit(obj):
    print(json.dumps(obj))
`;

/* 1 — the vocabulary ------------------------------------------------------- */

test('R77: NOT_PLAYABLE is exactly D/OUT/IR/PUP/NFI/SUSP; Q and unknown stay playable', () => {
  const out = runPy(`${SETUP}
emit({"np": sorted(av.NOT_PLAYABLE),
      "q": av.status_playable(av.QUESTIONABLE), "a": av.status_playable(av.ACTIVE),
      "none": av.status_playable(None), "d": av.status_playable(av.DOUBTFUL)})`);
  assert.deepEqual(out.np, ['DOUBTFUL', 'IR', 'NFI', 'OUT', 'PUP', 'SUSPENDED']);
  assert.equal(out.q, true, 'owner rule: Q is priced + labelled, never gated');
  assert.equal(out.a, true);
  assert.equal(out.none, true, 'unknown is not a zero');
  assert.equal(out.d, false, 'owner rule: D is excluded');
});

/* 2 — mechanic (c) in player_weeks ------------------------------------------ */

test('R77: gate_week zeroes exactly that week, drops the total by its share, and is a no-op on a bye / inside a season block / when None', () => {
  const out = runPy(`${SETUP}
base = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None)
gated = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, gate_week=3)
bye = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, gate_week=2)
none = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, gate_week=None)
# season block of 2 from week 3 already covers week 3: the gate changes nothing
blk = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, unavailable_weeks=2, first_week=3)
blk_g = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, unavailable_weeks=2, first_week=3, gate_week=3)
# a season block that does NOT cover the gate week: both apply, pro-rata twice
blk4 = player_weeks(200.0, "SFX", SCHED_BY_TEAM, ELOS, round_dp=None, unavailable_weeks=1, first_week=4, gate_week=3)
emit({"base_total": sum(w["pts"] for w in base if not w["bye"]),
      "gated_total": sum(w["pts"] for w in gated if not w["bye"]),
      "gated_wk3": [w for w in gated if w["wk"] == 3][0],
      "base_wk3": [w for w in base if w["wk"] == 3][0]["pts"],
      "gated_avail_wks": [w["wk"] for w in gated if w.get("avail") is False],
      "ratios": [gated[i]["pts"] / base[i]["pts"] for i in (0, 3, 4, 5)],
      "bye_same": bye == base, "none_same": none == base,
      "blk_same": blk == blk_g,
      "blk4_total": sum(w["pts"] for w in blk4 if not w["bye"]),
      "blk4_avail": [w["wk"] for w in blk4 if w.get("avail") is False]})`);
  assert.ok(Math.abs(out.base_total - 200) < 1e-9);
  assert.ok(Math.abs(out.gated_total - 200 * 4 / 5) < 1e-9, 'one of five games gone: 4/5 of the total');
  assert.equal(out.gated_wk3.pts, 0);
  assert.equal(out.gated_wk3.avail, false);
  assert.deepEqual(out.gated_avail_wks, [3]);
  const common = out.gated_total / (out.base_total - out.base_wk3);
  for (const r of out.ratios) assert.ok(Math.abs(r - common) < 1e-9, 'the other weeks keep their SHAPE exactly (one common rescale)');
  assert.equal(out.bye_same, true, 'nothing is gated on a bye');
  assert.equal(out.none_same, true, 'gate_week=None is byte-identical to pre-R77');
  assert.equal(out.blk_same, true, 'a gate inside a season block changes nothing');
  assert.ok(Math.abs(out.blk4_total - 200 * 4 / 5 * 3 / 4) < 1e-9, 'season block (1 of 5) then the gate (1 of the 4 left)');
  assert.deepEqual(out.blk4_avail, [3, 4]);
});

/* 3 — the document: status gates, QB depth, promotion, meta ---------------- */

test('R77: OUT / DOUBTFUL / IR / SUSP zero this week and say why; Q keeps its points; the QB chart gates the backups', () => {
  const out = runPy(`${SETUP}
doc = build()
p = by_id(doc)
emit({"meta": doc["model"]["this_week"],
      "tw": {k: v.get("this_week") for k, v in p.items()},
      "wk3": {k: wkrow(v, 3) for k, v in p.items()},
      "avail": {k: v.get("availability") for k, v in p.items()},
      "totals": {k: round(sum(w["pts"] for w in v["weeks"]), 2) for k, v in p.items()},
      "keys": list(p["espn-4"].keys())})`);
  const m = out.meta;
  assert.equal(m.wk, 3);
  assert.deepEqual(m.by_reason, { inactive: 0, status: 3, depth: 3 });
  assert.equal(m.gated, 6);
  assert.equal(m.promoted, 0);
  assert.equal(m.depth_snapshot, '2026-09-16T12:34:22Z');
  assert.deepEqual(m.skipped_final_teams, []);
  // status gates
  assert.deepEqual(out.tw['espn-4'], { wk: 3, playable: false, reason: 'status', status: 'OUT', points_lost: out.tw['espn-4'].points_lost });
  assert.ok(out.tw['espn-4'].points_lost > 30, 'an OUT RB loses a real week of points');
  assert.equal(out.tw['espn-6'].status, 'IR');
  assert.equal(out.tw['espn-6'].points_lost, 0, 'already a season block: the gate itself cost nothing more');
  assert.equal(out.tw['espn-7'].status, 'SUSPENDED');
  assert.ok(out.tw['espn-7'].points_lost > 0, 'a suspension of unstated length still sits THIS week');
  assert.deepEqual(out.avail['espn-7'], { status: 'SUSPENDED', class: 'season' }, 'flag-only block stays two keys (no duration invented)');
  assert.deepEqual(out.avail['espn-4'], { status: 'OUT', class: 'week' }, 'week class states no duration');
  // Q untouched
  assert.equal(out.tw['espn-5'], null);
  assert.ok(out.wk3['espn-5'].pts > 0 && out.wk3['espn-5'].avail === undefined);
  assert.ok(Math.abs(out.totals['espn-5'] - 150) < 0.05, 'a QUESTIONABLE total is preserved exactly');
  // QB depth
  assert.equal(out.tw['espn-1'], null, 'the healthy starter carries no block');
  assert.deepEqual(out.tw['espn-2'], { wk: 3, playable: false, reason: 'depth', depth: 2, starter: 'QB One', points_lost: out.tw['espn-2'].points_lost });
  assert.equal(out.tw['espn-3'].depth, 3);
  assert.equal(out.tw['espn-8'].starter, 'Unprojected Starter', 'the starter need not be projected to be the starter');
  assert.equal(out.tw['espn-9'], null, 'RB depth gates nothing');
  for (const id of ['espn-2', 'espn-3', 'espn-4', 'espn-6', 'espn-7', 'espn-8']) {
    assert.equal(out.wk3[id].pts, 0, `${id} week 3 is 0.0`);
    assert.equal(out.wk3[id].avail, false);
  }
  assert.ok(Math.abs(out.totals['espn-2'] - 120 * 4 / 5) < 0.05, 'the QB2 total drops by the week');
  assert.deepEqual(out.keys, ['gsis_id', 'receptions_prior', 'availability', 'this_week', 'weeks']);
});

test('R77: QB1 out -> QB2 promoted (playable, stated), QB3 still gated by the new starter', () => {
  const out = runPy(`${SETUP}
doc = build(inj=INJ + [{"team": "SFX", "player": "QB One", "status": "Doubtful"}])
p = by_id(doc)
emit({"one": p["espn-1"].get("this_week"), "two": p["espn-2"].get("this_week"),
      "three": p["espn-3"].get("this_week"), "two_wk3": wkrow(p["espn-2"], 3)["pts"],
      "meta": doc["model"]["this_week"]})`);
  assert.equal(out.one.status, 'DOUBTFUL');
  assert.equal(out.one.playable, false, 'owner rule: D is excluded');
  assert.deepEqual(out.two, { wk: 3, playable: true, reason: 'depth_promoted', depth: 2, starter_out: 'QB One' });
  assert.ok(out.two_wk3 > 0, 'the promoted QB2 keeps his week');
  assert.deepEqual(out.three, { wk: 3, playable: false, reason: 'depth', depth: 3, starter: 'QB Two', points_lost: out.three.points_lost });
  assert.equal(out.meta.promoted, 1);
  assert.deepEqual(out.meta.by_reason, { inactive: 0, status: 4, depth: 2 }, 'OUT RB, IR TE, SUSP WR, D QB1 by status; QB3 and DAL QB2 by depth');
});

test('R77: no gate on a bye, none for a FINAL team, none without this_week; co-listed starters and an unlisted QB', () => {
  const out = runPy(`${SETUP}
bye = build(wk=2)                      # SFX is on bye in week 2
fin = build(skip=("DAL",))
off = build(wk=None)
nodc = build(depth=None)
co = copy.deepcopy(DEPTH); co["teams"]["SFX"]["QB"][1]["rank"] = 1
co_doc = build(depth=co)
unl = build(proj=PROJ + [{"gsis_id": "espn-10", "name": "Unlisted QB", "team": "SFX", "position": "QB", "proj_points": 30.0}])
emit({"bye": {k: v.get("this_week", {}).get("reason") for k, v in by_id(bye).items()},
      "fin": {k: v.get("this_week", {}).get("reason") for k, v in by_id(fin).items()},
      "fin_meta": fin["model"]["this_week"]["skipped_final_teams"],
      "off_model": "this_week" in off["model"],
      "off_rows": any("this_week" in p for p in off["players"]),
      "off_avail": [w["wk"] for w in by_id(off)["espn-4"]["weeks"] if w.get("avail") is False],
      "nodc": {k: v.get("this_week", {}).get("reason") for k, v in by_id(nodc).items()},
      "nodc_snap": nodc["model"]["this_week"]["depth_snapshot"],
      "co": {k: v.get("this_week", {}).get("reason") for k, v in by_id(co_doc).items() if k in ("espn-1", "espn-2", "espn-3")},
      "unl": by_id(unl)["espn-10"].get("this_week")})`);
  assert.deepEqual(out.bye, { 'espn-1': null, 'espn-2': null, 'espn-3': null, 'espn-4': null, 'espn-5': null,
    'espn-6': 'status', 'espn-7': 'status', 'espn-8': 'depth', 'espn-9': null });
  assert.deepEqual(out.fin, { 'espn-1': null, 'espn-2': 'depth', 'espn-3': 'depth', 'espn-4': 'status', 'espn-5': null,
    'espn-6': null, 'espn-7': null, 'espn-8': null, 'espn-9': null });
  assert.deepEqual(out.fin_meta, ['DAL']);
  assert.equal(out.off_model, false);
  assert.equal(out.off_rows, false);
  assert.deepEqual(out.off_avail, [], 'pre-R77 behaviour: an OUT blocks nothing when no gate week is given');
  assert.deepEqual(out.nodc, { 'espn-1': null, 'espn-2': null, 'espn-3': null, 'espn-4': 'status', 'espn-5': null,
    'espn-6': 'status', 'espn-7': 'status', 'espn-8': null, 'espn-9': null }, 'no chart: status still gates, depth does not');
  assert.equal(out.nodc_snap, null);
  assert.deepEqual(out.co, { 'espn-1': null, 'espn-2': null, 'espn-3': 'depth' }, 'two rank-1 QBs: neither gated, QB3 still is');
  assert.deepEqual(out.unl, { wk: 3, playable: false, reason: 'depth', depth: null, starter: 'QB One', points_lost: out.unl.points_lost });
});

test('R77: points_lost is the ungated split minus the gated one, and the factor counters are not double-counted', () => {
  const out = runPy(`${SETUP}
g = build()
u = build(wk=None)
pg, pu = by_id(g), by_id(u)
emit({"lost": pg["espn-4"]["this_week"]["points_lost"],
      "diff": round(sum(w["pts"] for w in pu["espn-4"]["weeks"]) - sum(w["pts"] for w in pg["espn-4"]["weeks"]), 2),
      "counts_g": g["model"]["neutral_counts"], "counts_u": u["model"]["neutral_counts"]})`);
  assert.ok(Math.abs(out.lost - out.diff) <= 0.011, `points_lost ${out.lost} vs measured ${out.diff}`);
  assert.deepEqual(out.counts_g, out.counts_u, 'the second split pass must not inflate the document counters');
});

/* 4 — the slate props and the pool refuse a sitter -------------------------- */

test('R77: build_props_by_game skips a gated player, takes the next playable one, names the player and labels Q', () => {
  const out = runPy(`${SETUP}
from scripts.models.parlay_builder import build_props_by_game, playable_this_week, questionable_label
doc = build(inj=INJ + [{"team": "SFX", "player": "QB One", "status": "Out"}])
for p in doc["players"]:
    pos = next(x["position"] for x in PROJ if x["gsis_id"] == p["gsis_id"])
    p["league_components"] = {"pass_yd": 4000.0, "rush_yd": 1200.0, "rec_yd": 1100.0}
gp = [{"game_id": "G1", "home": "SFX", "away": "DAL", "week": 3, "probs": {"home": 0.6, "away": 0.4}}]
legs = build_props_by_game(gp, doc, {"players": PROJ}, calibration_path="/nonexistent.json")["G1"]
emit({"legs": [{k: l.get(k) for k in ("market", "gsis_id", "availability")} for l in legs],
      "pt": playable_this_week(by_id(doc)["espn-1"]), "pt_none": playable_this_week(None),
      "q": questionable_label(by_id(doc)["espn-5"]), "q_none": questionable_label(by_id(doc)["espn-4"])})`);
  const by = Object.fromEntries(out.legs.map((l) => [l.market, l]));
  assert.equal(by.qb_pass_yds.gsis_id, 'espn-2', 'QB One is OUT: the promoted QB Two takes the slot, never the sitter');
  assert.equal(by.rb_rush_yds.gsis_id, 'espn-9', 'Hurt RB (200 pts, OUT) is skipped for DAL RB (180)');
  assert.equal(by.wr_rec_yds.gsis_id, 'espn-5');
  assert.equal(by.wr_rec_yds.availability, 'QUESTIONABLE', 'Q is priced AND labelled');
  assert.equal(by.rb_rush_yds.availability, null);
  assert.equal(out.pt, false);
  assert.equal(out.pt_none, true, 'no row is not a zero');
  assert.equal(out.q, 'QUESTIONABLE');
  assert.equal(out.q_none, null, 'OUT is gated, never a label');
});

test('R77: build_leg_pool.prop_legs counts not_playable and carries no leg for a sitter; Q players are labelled', () => {
  const out = runPy(`${SETUP}
from scripts.build_leg_pool import prop_legs
doc = build()
for p in doc["players"]:
    p["league_components"] = {"pass_yd": 4000.0, "rush_yd": 1200.0, "rec_yd": 1100.0}
weekly = by_id(doc)
# a 5-game fixture season: 1250 pass / 350 rush / 350 rec yards put mu at ~250 / ~70 / ~70
for p in doc["players"]:
    p["league_components"] = {"pass_yd": 1250.0, "rush_yd": 350.0, "rec_yd": 350.0}
gp = [{"game_id": "G1", "home": "SFX", "away": "DAL", "week": 3, "probs": {"home": 0.6, "away": 0.4}}]
calib = {p: {"a": 0.0, "b": 1.0, "c": 0.0} for p in ("QB", "RB", "WR")}
support = {p: (-3.0, 3.0) for p in ("QB", "RB", "WR")}
sd = {"QB": 60.0, "RB": 30.0, "WR": 30.0}
ladder = {"QB": [199.5, 249.5], "RB": [49.5, 74.5], "WR": [49.5, 74.5]}
legs, counts = prop_legs(PROJ, weekly, gp, calib, support, sd, ladder)
emit({"ids": sorted(l["gsis_id"] for l in legs), "counts": counts,
      "labels": {l["gsis_id"]: l.get("availability") for l in legs}})`);
  assert.deepEqual(out.ids, ['espn-1', 'espn-5', 'espn-9'], 'only the healthy starter, the Q receiver and the DAL back price');
  assert.equal(out.counts.not_playable, 5, 'QB2, QB3, OUT RB, SUSP WR, DAL QB2 (the IR TE is not a pool position)');
  assert.deepEqual(out.labels, { 'espn-1': null, 'espn-5': 'QUESTIONABLE', 'espn-9': null });
});

/* G19 (daily run 149, 2026-09-20) — the builder gate and the validator
 * disagreed on a game day. this_week_gate deliberately stops gating a team
 * whose game has gone FINAL ("a played week is never retro-zeroed"), so after
 * the early window a player listed out keeps avail:false on his week row while
 * this_week.playable goes quiet. check_no_unplayable_legs has always demanded
 * BOTH facts, so the pool priced Jordan Mason and A.J. Brown — both on teams
 * whose week-2 game had finished — and the pipeline red-lined at its last step,
 * after every number was rebuilt. The gate now takes the week. */
test('G19: a sitter whose game already went FINAL is still refused, and the validator agrees', () => {
  const out = runPy(`${SETUP}
import json
from scripts.models.parlay_builder import playable_this_week, build_props_by_game
from scripts.build_leg_pool import prop_legs
from scripts.validate_data import ValidationError, check_no_unplayable_legs

# The exact shape run 149 produced: the gate went quiet because the team's game
# is FINAL, while the week row still records that he does not play.
final_team_sitter = {"this_week": {}, "weeks": [{"wk": 1, "avail": True},
                                                {"wk": 2, "avail": False}]}
emit_rows = {
  "sitter_wk2": playable_this_week(final_team_sitter, 2),
  "sitter_wk1": playable_this_week(final_team_sitter, 1),
  "sitter_no_week": playable_this_week(final_team_sitter),
  "healthy": playable_this_week({"this_week": {"playable": True},
                                 "weeks": [{"wk": 2, "avail": True}]}, 2),
  "status_gated": playable_this_week({"this_week": {"playable": False}},  2),
  "no_weeks_block": playable_this_week({"this_week": {}}, 2),
}

# End to end: the same player, through both builders, at the week he sits.
doc = build()
for p in doc["players"]:
    p["league_components"] = {"pass_yd": 1250.0, "rush_yd": 350.0, "rec_yd": 350.0}
weekly = by_id(doc)
# espn-1 is the healthy starting QB. Put him in run 149's state: his game is
# FINAL so the gate says nothing, but week 3 is zeroed.
weekly["espn-1"]["this_week"] = {}
for w in weekly["espn-1"]["weeks"]:
    if w.get("wk") == 3:
        w["avail"] = False
gp = [{"game_id": "G1", "home": "SFX", "away": "DAL", "week": 3, "probs": {"home": 0.6, "away": 0.4}}]
calib = {p: {"a": 0.0, "b": 1.0, "c": 0.0} for p in ("QB", "RB", "WR")}
support = {p: (-3.0, 3.0) for p in ("QB", "RB", "WR")}
sd = {"QB": 60.0, "RB": 30.0, "WR": 30.0}
ladder = {"QB": [199.5, 249.5], "RB": [49.5, 74.5], "WR": [49.5, 74.5]}
legs_wk3, counts_wk3 = prop_legs(PROJ, weekly, gp, calib, support, sd, ladder, 3)
legs_nowk, _ = prop_legs(PROJ, weekly, gp, calib, support, sd, ladder)
slate = build_props_by_game(gp, doc, {"players": PROJ}, calibration_path="/nonexistent.json")

# And the validator's own verdict on a pool that DID price him, so the test
# proves the two now agree rather than asserting the builder in isolation.
pool_bad = {"week": 3, "counts": {"not_playable": 0},
            "players": [{"gsis_id": "espn-1", "player": "QB One"}]}
weekly_doc = {"model": {"this_week": {"wk": 3}}, "players": list(weekly.values())}
try:
    check_no_unplayable_legs(weekly_doc, None, pool_bad)
    validator_red = ""
except ValidationError as exc:
    validator_red = str(exc)
emit({"gate": emit_rows,
      "wk3_ids": sorted(l["gsis_id"] for l in legs_wk3),
      "nowk_ids": sorted(l["gsis_id"] for l in legs_nowk),
      "slate_qb": next((l.get("gsis_id") for l in slate["G1"]
                        if l["market"] == "qb_pass_yds"), None),
      "validator_red": validator_red})`);
  const g = out.gate;
  assert.equal(g.sitter_wk2, false, 'the week row alone is enough to refuse him');
  assert.equal(g.sitter_wk1, true, 'a week he DID play is untouched');
  assert.equal(g.sitter_no_week, true, 'without a week the R77 behaviour is unchanged');
  assert.equal(g.healthy, true);
  assert.equal(g.status_gated, false, 'the original R77 fact still gates on its own');
  assert.equal(g.no_weeks_block, true, 'absence is not a zero');

  assert.ok(!out.wk3_ids.includes('espn-1'),
    'the pool refuses the sitter once it is told which week it is pricing');
  assert.ok(out.nowk_ids.includes('espn-1'),
    'and without the week it would still have priced him — this is the defect the week closes');
  assert.notEqual(out.slate_qb, 'espn-1', 'the slate refuses him on the same fact');
  assert.match(out.validator_red, /zeroed week \(wk3 avail:false\)/,
    'the validator reds exactly this leg, so builder and validator now agree on the same fact');
});

/* 5 — the validator: round-trip green, and every red that matters ----------- */

test('R77: a gated document round-trips through check_weekly_availability + the schema, and each drift is caught', () => {
  const out = runPy(`${SETUP}
from scripts.validate_data import (ValidationError, check_weekly_availability,
                                   check_no_unplayable_legs, validate_against_schema, _load)
import os
schema = _load(os.path.join("data", "contracts", "player_weekly.schema.json"))
dc_schema = _load(os.path.join("data", "contracts", "depth_chart.schema.json"))
inj_doc = {"injuries": [dict(r, availability=av.normalize_status(r["status"])) for r in INJ]}
proj_doc = {"players": PROJ}
doc = build()
def red(d, why, dc=DEPTH, inj=inj_doc):
    try:
        check_weekly_availability(d, proj_doc, inj, depth_chart=dc)
    except ValidationError as exc:
        return str(exc)
    raise AssertionError("not caught: " + why)
res = {}
check_weekly_availability(doc, proj_doc, inj_doc, depth_chart=DEPTH)
RELABEL = {"SFX": "SF", "GBX": "GB"}
def real_teams(d):
    d = copy.deepcopy(d)
    for p in d["players"]:
        for w in p["weeks"]:
            w["opp"] = RELABEL.get(w["opp"], w["opp"])
    return d
validate_against_schema(real_teams(doc), schema, "player_weekly.json")
validate_against_schema(DEPTH, dc_schema, "depth_chart.json")
# the two new leg fields must be accepted by BOTH parlay contracts: the open
# week's archive (data/parlays/<season>_wk<NN>.json) is a verbatim copy of
# parlays.json, and the pipeline's first R77 run failed exactly there
# (2026-09-17, run 120: "additional property 'gsis_id' not allowed").
legdoc = {"season": 2026, "week": 3, "updated_utc": "2026-09-17T00:00:00Z", "parlays": [{
    "parlay_id": "p1", "scope": "game", "game_id": "G1", "legs": [
        {"market": "wr_rec_yds", "selection": "Q. WR 60+ rec yds", "implied_prob": 0.5,
         "model_prob": 0.55, "pricing": "calibrated", "estimate": True, "mu": 66.0,
         "sd": 30.0, "z": 0.2, "line": 59.5, "gsis_id": "espn-5", "availability": "QUESTIONABLE"},
        {"market": "moneyline", "selection": "SF ML", "implied_prob": 0.5, "model_prob": 0.6}],
    "model_ev": 0.01, "combined_prob": 0.33, "implied_combined": 0.25,
    "confidence_tier": "low", "estimate": True}]}
for name in ("parlays.schema.json", "parlays_archive.schema.json"):
    sch = _load(os.path.join("data", "contracts", name))
    try:
        validate_against_schema(legdoc, sch, name)
    except ValidationError as exc:
        # only leg-level complaints matter here; the fixture is not a full document
        bad = [l for l in str(exc).splitlines() if "legs[" in l]
        assert not bad, (name, bad)
res["green"] = True
# also green: QB1 out / promoted
doc2 = build(inj=INJ + [{"team": "SFX", "player": "QB One", "status": "Doubtful"}])
inj2 = {"injuries": inj_doc["injuries"] + [{"team": "SFX", "player": "QB One", "status": "Doubtful", "availability": "DOUBTFUL"}]}
check_weekly_availability(doc2, proj_doc, inj2, depth_chart=DEPTH)
validate_against_schema(real_teams(doc2), schema, "player_weekly.json")
res["green_promoted"] = True
# red 1: a sitter with no gate (rule 8)
d = copy.deepcopy(doc); p = by_id(d)["espn-4"]; del p["this_week"]
w = wkrow(p, 3); del w["avail"]; w["pts"] = 40.0
res["silent_sitter"] = red(d, "OUT player without a gate")
# red 2: this_week.wk drift
d = copy.deepcopy(doc); by_id(d)["espn-4"]["this_week"]["wk"] = 4
res["wk_drift"] = red(d, "this_week.wk != model.this_week.wk")
# red 3: depth claim without a chart
res["no_chart"] = red(copy.deepcopy(doc), "depth reason without depth_chart.json", dc=None)
# red 4: depth rank disagrees with the chart
d = copy.deepcopy(doc); by_id(d)["espn-2"]["this_week"]["depth"] = 3
res["rank_drift"] = red(d, "this_week.depth != chart rank")
# red 5: model summary disagrees with the rows
d = copy.deepcopy(doc); d["model"]["this_week"]["gated"] = 1
res["meta_drift"] = red(d, "model.this_week.gated != rows")
# red 6: gated but the week still scores
d = copy.deepcopy(doc); w = wkrow(by_id(d)["espn-2"], 3); del w["avail"]; w["pts"] = 20.0
res["still_scores"] = red(d, "this_week not playable but the week is not zeroed")
# red 7: gated for a team whose game was FINAL
d = copy.deepcopy(doc); d["model"]["this_week"]["skipped_final_teams"] = ["SFX"]
res["final_gated"] = red(d, "gated although the game was FINAL")
emit(res)`);
  assert.equal(out.green, true);
  assert.equal(out.green_promoted, true);
  assert.match(out.silent_sitter, /status OUT but wk3 is not gated/);
  assert.match(out.wk_drift, /this_week\.wk 4 != model\.this_week\.wk 3/);
  assert.match(out.no_chart, /lists no QB for SFX/);
  assert.match(out.rank_drift, /this_week\.depth 3 but the chart ranks him 2/);
  assert.match(out.meta_drift, /model\.this_week says/);
  assert.match(out.still_scores, /not playable but wk3 is not avail:false/);
  assert.match(out.final_gated, /gated although SFX's game was already FINAL/);
});

test('R77: check_no_unplayable_legs reds a sitter on the slate or in the pool, an unnamed prop leg and a silent Q; passes clean', () => {
  const out = runPy(`${SETUP}
from scripts.validate_data import ValidationError, check_no_unplayable_legs
doc = build()
def leg(gsis, market="rb_rush_yds", **kw):
    d = {"market": market, "selection": "X", "implied_prob": 0.5, "model_prob": 0.5, "gsis_id": gsis}
    d.update(kw); return d
def parlays(*legs):
    return {"season": 2026, "week": 3, "parlays": [{"parlay_id": "p1", "legs": list(legs)}]}
def pool(*players):
    return {"week": 3, "counts": {"not_playable": 0}, "players": list(players)}
def red(pa, lp, why):
    try:
        check_no_unplayable_legs(doc, pa, lp)
    except ValidationError as exc:
        return str(exc)
    raise AssertionError("not caught: " + why)
res = {}
check_no_unplayable_legs(doc, parlays(leg("espn-9"), leg("espn-5", "wr_rec_yds", availability="QUESTIONABLE"),
                                      {"market": "moneyline", "selection": "SFX ML", "implied_prob": 0.5, "model_prob": 0.6}),
                         pool({"gsis_id": "espn-1", "player": "QB One"}, {"gsis_id": "espn-5", "player": "Q WR", "availability": "QUESTIONABLE"}))
res["green"] = True
res["sitter"] = red(parlays(leg("espn-4")), None, "OUT RB on the slate")
res["qb2"] = red(parlays(leg("espn-2", "qb_pass_yds")), None, "QB2 on the slate")
res["unnamed"] = red(parlays({"market": "rb_rush_yds", "selection": "X", "implied_prob": 0.5, "model_prob": 0.5}), None, "prop leg without gsis_id")
res["silent_q"] = red(parlays(leg("espn-5", "wr_rec_yds")), None, "Q player unlabelled")
res["bad_label"] = red(parlays(leg("espn-9", availability="QUESTIONABLE")), None, "healthy player labelled Q")
res["pool_sitter"] = red(parlays(), pool({"gsis_id": "espn-7", "player": "Susp WR"}), "suspended player in the pool")
res["pool_old"] = red(parlays(), {"week": 3, "counts": {}, "players": []}, "pool built without the gate")
# an ungated (pre-R77) weekly document is neither faked green nor red: no fact to check
check_no_unplayable_legs(build(wk=None), parlays(leg("espn-4")), None)
res["pre_r77_skip"] = True
emit(res)`);
  assert.equal(out.green, true);
  assert.match(out.sitter, /does not play this week \(status OUT\)/);
  assert.match(out.qb2, /does not play this week \(depth 2\)/);
  assert.match(out.unnamed, /names no gsis_id/);
  assert.match(out.silent_q, /is QUESTIONABLE but the leg does not say so/);
  assert.match(out.bad_label, /labelled QUESTIONABLE but his row says None/);
  assert.match(out.pool_sitter, /leg_pool\.json: Susp WR is priced on a player who does not play/);
  assert.match(out.pool_old, /counts\.not_playable is not stated/);
  assert.equal(out.pre_r77_skip, true);
});
