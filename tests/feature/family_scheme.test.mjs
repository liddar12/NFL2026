/* tests/feature/family_scheme.test.mjs — the `scheme_matchup` candidate family
 * and the FTN ingest it stands on.
 *
 * The arithmetic of this family is four z-scores and a product. What can
 * actually go wrong is everything around it, and every single failure mode
 * below has caused a wrong build of this feature before:
 *
 *   1. THE APPLICATION PATH IS DARK, AND MUST STAY LOUD ABOUT IT. FTN charting
 *      has no 2026 release. A family that answers "0.0" for 2026 is byte-for-
 *      byte indistinguishable from a family that is working perfectly and
 *      finding nothing. So `delta_from_params` and `scheme_current` must RAISE
 *      on a dark season, the artifact must carry a probed `application` block,
 *      and `scheme_matchup` must be absent from `promote_signals.APPLIABLE`.
 *      That is three independent locks and all three are tested.
 *   2. THE FTN COLUMN NAME. It is `is_screen_pass`, not `is_screen_p`. A
 *      rename must raise, never silently read zero forever.
 *   3. THE JOIN. The FTN release has NO posteam/defteam column, so a charted
 *      play has no team until it is joined to play-by-play. A build that
 *      "works" without the join is attributing nothing to anyone.
 *   4. THE 0 SENTINEL. ~23.7% of FTN rows carry a literal 0 in n_defense_box /
 *      qb_location (uncharted plays and special teams). Filtering is mandatory
 *      and the fixture proves the filter FIRES — a filter that quietly stopped
 *      firing leaves no trace otherwise.
 *   5. PARTIAL COVERAGE IS EXPECTED HERE, NOT A SKIP — and the dilution it
 *      causes must be recorded, or a measurement over 16% of the corpus reads
 *      like one over all of it.
 *   6. THE MARKET BOUNDARY. Neither module may name a betting column.
 *
 * Node built-ins only. Python is invoked for the behaviour that lives in
 * Python — a JS re-implementation of the delta would grade a copy, not the
 * code the gate runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE = join(REPO_ROOT, 'scripts', 'signals', 'scheme_matchup.py');
const BUILDER = join(REPO_ROOT, 'scripts', 'build_scheme_history.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const FTN_FIXTURE = join(REPO_ROOT, 'data', 'fixtures', 'nflverse_sample', 'ftn_sample.csv');
const PBP_FIXTURE = join(REPO_ROOT, 'data', 'fixtures', 'nflverse_sample', 'pbp_scheme.csv');
const ARTIFACT = join(REPO_ROOT, 'data', 'scheme_history.json');

/* Run python and parse the JSON printed on its LAST line. */
function py(script) {
  const out = execFileSync('python3', ['-c', script], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

/* The denylist as a LITERAL — never imported from the producer, because a
 * checker that reuses the producer's constants grades the pipeline with the
 * pipeline's own marking scheme. */
const BETTING_COLUMNS = [
  'away_moneyline', 'home_moneyline', 'spread_line', 'total_line',
  'over_odds', 'under_odds', 'away_spread_odds', 'home_spread_odds',
];

/* ------------------------------------------------------------------ *
 * 1. the two modules ship and their own selftests pass                *
 * ------------------------------------------------------------------ */

test('scheme: the family module ships and its selftest passes', () => {
  assert.ok(existsSync(MODULE), 'scripts/signals/scheme_matchup.py present');
  const out = execFileSync('python3', [MODULE], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /selftest OK/, out);
});

test('scheme: the FTN ingest ships and its fixture selftest passes', () => {
  assert.ok(existsSync(BUILDER), 'scripts/build_scheme_history.py present');
  assert.ok(existsSync(FTN_FIXTURE), 'ftn_sample.csv fixture present');
  assert.ok(existsSync(PBP_FIXTURE), 'pbp_scheme.csv fixture present');
  const out = execFileSync('python3', [BUILDER, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /selftest OK/, out);
});

/* ------------------------------------------------------------------ *
 * 2. the join, because FTN carries no team column                     *
 * ------------------------------------------------------------------ */

test('scheme: the FTN fixture has NO team column, so the join is not optional', () => {
  const header = readFileSync(FTN_FIXTURE, 'utf8').split('\n')[0].trim().split(',');
  assert.ok(!header.includes('posteam'), 'FTN has no posteam');
  assert.ok(!header.includes('defteam'), 'FTN has no defteam');
  assert.ok(header.includes('nflverse_game_id') && header.includes('nflverse_play_id'),
    'the join keys are the only way to attribute a charted play to a team');
  /* The real column name. This assertion is the cheapest guard that exists
   * against the rename that has silently zeroed this feature before. */
  assert.ok(header.includes('is_screen_pass'), 'the column is is_screen_pass');
  assert.ok(!header.includes('is_screen_p'), 'is_screen_p is NOT the column name');
});

test('scheme: the join attributes offence and defence to the right sides', () => {
  const got = py(`
import csv, json, sys
sys.path.insert(0, "scripts")
import build_scheme_history as b
pbp = list(csv.DictReader(open(b.PBP_FIXTURE, newline="", encoding="utf-8")))
ftn = list(csv.DictReader(open(b.FTN_FIXTURE, newline="", encoding="utf-8")))
teams, diag = b.accumulate_season(2099, ftn, b.index_pbp(iter(pbp)),
                                  max_unjoined_share=0.10)
print(json.dumps({"diag": diag, "AAA1": teams["AAA"]["1"], "BBB1": teams["BBB"]["1"],
                  "teams": sorted(teams), "AAA_weeks": sorted(teams["AAA"])}))
`);
  /* AAA ran 4 charted plays in week 1 against boxes 6,7,8,7. */
  assert.equal(got.AAA1.off_plays, 4);
  assert.equal(got.AAA1.pa, 3);
  assert.equal(got.AAA1.screen, 1);
  assert.equal(got.AAA1.motion, 2);
  assert.equal(got.AAA1.no_huddle, 1);
  /* Those same 4 plays are credited to BBB's DEFENCE, box_sum 6+7+8+7 = 28. */
  assert.equal(got.BBB1.def_plays, 4);
  assert.equal(got.BBB1.box_sum, 28);
  assert.equal(got.BBB1.box_plays, got.BBB1.def_plays,
    'box_plays == def_plays after the sentinel filter, by construction');
  /* ...and AAA's own defence saw only BBB's 2 plays. */
  assert.equal(got.AAA1.def_plays, 2);
  assert.equal(got.AAA1.box_sum, 10);
  /* Team codes are the corpus codes: the fixture charts SD, which is LAC. */
  assert.ok(got.teams.includes('LAC') && !got.teams.includes('SD'),
    'source team codes are renamed to the corpus convention');
});

test('scheme: an unjoinable FTN row is COUNTED, and a broken join raises', () => {
  const got = py(`
import csv, json, sys
sys.path.insert(0, "scripts")
import build_scheme_history as b
ftn = list(csv.DictReader(open(b.FTN_FIXTURE, newline="", encoding="utf-8")))
pbp = list(csv.DictReader(open(b.PBP_FIXTURE, newline="", encoding="utf-8")))
idx = b.index_pbp(iter(pbp))
_, diag = b.accumulate_season(2099, ftn, idx, max_unjoined_share=0.10)
res = {"diag": diag}
try:
    b.accumulate_season(2099, ftn, idx)          # production ceiling
except b.BuildError as e:
    res["ceiling"] = str(e)
try:
    b.accumulate_season(2099, ftn, {})           # nothing joins at all
except b.BuildError as e:
    res["total"] = str(e)
try:
    b.index_pbp(iter([{"game_id": "g", "play_id": "1"}]))
except b.BuildError as e:
    res["pbp_cols"] = str(e)
print(json.dumps(res))
`);
  assert.equal(got.diag.unjoined, 1, 'the unjoinable row is counted, not dropped silently');
  assert.match(got.ceiling, /did not join/, 'the production unjoined ceiling is live');
  assert.match(got.total, /did not join/, 'a fully broken join refuses to write');
  assert.match(got.pbp_cols, /posteam/, 'pbp without posteam raises rather than guessing');
});

/* ------------------------------------------------------------------ *
 * 3. the 0 sentinel — mandatory, and proven to fire                   *
 * ------------------------------------------------------------------ */

test('scheme: the 0/blank sentinel filter fires and is mandatory', () => {
  const got = py(`
import csv, json, sys
sys.path.insert(0, "scripts")
import build_scheme_history as b
ftn = list(csv.DictReader(open(b.FTN_FIXTURE, newline="", encoding="utf-8")))
pbp = list(csv.DictReader(open(b.PBP_FIXTURE, newline="", encoding="utf-8")))
_, diag = b.accumulate_season(2099, ftn, b.index_pbp(iter(pbp)),
                              max_unjoined_share=0.10)
print(json.dumps({
  "diag": diag,
  "box_zero":   b.is_uncharted({"n_defense_box": "0", "qb_location": "S"}),
  "qb_zero":    b.is_uncharted({"n_defense_box": "6", "qb_location": "0"}),
  "qb_blank":   b.is_uncharted({"n_defense_box": "6", "qb_location": ""}),
  "box_blank":  b.is_uncharted({"n_defense_box": "",  "qb_location": "S"}),
  "charted":    b.is_uncharted({"n_defense_box": "6", "qb_location": "S"}),
  "sentinel_in_fixture": sum(1 for r in ftn if b.is_uncharted(r)),
}));
`);
  assert.equal(got.diag.uncharted_dropped, 2, 'both sentinel rows were dropped');
  assert.ok(got.diag.uncharted_dropped > 0,
    'THE POINT: a filter that quietly stopped firing leaves no other trace');
  assert.equal(got.sentinel_in_fixture, 2, 'the fixture carries sentinel rows to catch');
  assert.equal(got.box_zero, true, 'n_defense_box == 0 is uncharted');
  assert.equal(got.qb_zero, true, 'qb_location == 0 is uncharted (2023+ shape)');
  assert.equal(got.qb_blank, true, 'a BLANK qb_location is the 2022 shape of the same thing');
  assert.equal(got.box_blank, true, 'a blank box is uncharted, never zero defenders');
  assert.equal(got.charted, false, 'a fully charted play survives');
});

test('scheme: a renamed screen column RAISES instead of reading zero', () => {
  const got = py(`
import csv, json, sys
sys.path.insert(0, "scripts")
import build_scheme_history as b
ftn = [dict(r) for r in csv.DictReader(open(b.FTN_FIXTURE, newline="", encoding="utf-8"))]
pbp = list(csv.DictReader(open(b.PBP_FIXTURE, newline="", encoding="utf-8")))
idx = b.index_pbp(iter(pbp))
for r in ftn:
    r["is_screen_p"] = r.pop("is_screen_pass")
try:
    b.accumulate_season(2099, ftn, idx, max_unjoined_share=0.10)
    print(json.dumps({"raised": False, "msg": ""}))
except b.BuildError as e:
    print(json.dumps({"raised": True, "msg": str(e)}))
`);
  assert.equal(got.raised, true, 'an upstream rename must fail loud');
  assert.match(got.msg, /is_screen_pass/, 'the error names the real column');
});

test('scheme: postseason plays are excluded from the sums, teamless plays dropped', () => {
  const got = py(`
import csv, json, sys
sys.path.insert(0, "scripts")
import build_scheme_history as b
ftn = list(csv.DictReader(open(b.FTN_FIXTURE, newline="", encoding="utf-8")))
pbp = list(csv.DictReader(open(b.PBP_FIXTURE, newline="", encoding="utf-8")))
teams, diag = b.accumulate_season(2099, ftn, b.index_pbp(iter(pbp)),
                                  max_unjoined_share=0.10)
print(json.dumps({"diag": diag, "weeks": sorted(teams["AAA"])}))
`);
  assert.equal(got.diag.postseason_dropped, 1,
    'January is played by good teams only — including it biases a prior-season rate');
  assert.equal(got.diag.no_team_dropped, 1,
    'a play with no possession team is dropped, never credited to someone');
  assert.deepEqual(got.weeks, ['1', '2'], 'the week-19 play never reached the sums');
});

/* ------------------------------------------------------------------ *
 * 4. THE APPLICATION PATH IS DARK                                     *
 * ------------------------------------------------------------------ */

test('scheme: the shipped artifact carries a PROBED application block saying dark', () => {
  assert.ok(existsSync(ARTIFACT), 'data/scheme_history.json present');
  const doc = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const app = doc.application;
  assert.ok(app, 'the artifact carries an application block');
  assert.equal(app.applied, false, 'the family is not applied to the live season');
  assert.equal(app.dark, true, 'and it says WHY in the data, not only in a comment');
  assert.equal(app.live_season, 2026);
  assert.notEqual(app.http_status, 200,
    'dark means the probe did not find a live-season FTN release');
  assert.ok(String(app.reason).length > 40, 'the reason is a sentence, not a flag');
  assert.match(String(app.reason), /2026/, 'the reason names the season it cannot price');
  /* Coverage is a claim about what exists, not a rounding of it. */
  assert.ok(Array.isArray(doc.seasons_covered) && doc.seasons_covered.length > 0);
  assert.ok(Math.min(...doc.seasons_covered) >= doc.first_ftn_season,
    'no season before FTN began may appear');
  assert.ok(!Object.keys(doc.seasons).includes('2021'),
    'a pre-FTN season is ABSENT, never present-and-zero');
  /* The credit travels with the data so it cannot go stale. */
  assert.equal(doc.attribution, 'FTN Data via nflverse');
  assert.equal(doc.license, 'CC-BY-SA 4.0');
  assert.equal(doc.season_type, 'REG');
});

test('scheme: the application path RAISES on a dark season, never returns 0.0', () => {
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts.signals import scheme_matchup as sm
doc = sm.load_doc()
feats, _diag = sm.build_features(doc, [2024, 2025, 2026])
live = {"scheme_hfa": {"applied": True, "scale": 120.0}}
g = {"home": "KC", "away": "BUF", "week": 8}
res = {"covered_seasons": sorted(feats)}

# an INERT params block is 0.0 everywhere, dark or not
res["inert_dark"] = sm.delta_from_params({}, 2026, g, feats, doc)
res["inert_off"] = sm.delta_from_params(
    {"scheme_hfa": {"applied": False, "scale": 120.0}}, 2026, g, feats, doc)

# an ACTIVE block on a DARK season must RAISE
for season in (2026, 2019):
    try:
        v = sm.delta_from_params(live, season, g, feats, doc)
        res["dark_%d" % season] = {"raised": False, "value": v}
    except sm.SchemeDark as e:
        res["dark_%d" % season] = {"raised": True, "msg": str(e)}

# scheme_current is the live input loader: same rule
try:
    sm.scheme_current(2026)
    res["current_2026"] = {"raised": False}
except sm.SchemeDark as e:
    res["current_2026"] = {"raised": True, "msg": str(e)}
res["current_2025_ok"] = bool(sm.scheme_current(2025))

# and an ACTIVE block on a COVERED season prices normally (a real, finite number)
v = sm.delta_from_params(live, 2025, g, feats, doc)
res["covered_value"] = v
res["is_dark"] = {"2025": sm.is_dark(2025, feats, doc),
                  "2026": sm.is_dark(2026, feats, doc),
                  "1999": sm.is_dark(1999, feats, doc)}
print(json.dumps(res))
`);
  assert.equal(Math.abs(got.inert_dark), 0, 'an unapplied block is inert, not an error');
  assert.equal(Math.abs(got.inert_off), 0, 'applied:false is inert too');
  assert.equal(got.dark_2026.raised, true,
    'THE CORE RULE: a dark season is a refusal, not a neutral number');
  assert.match(got.dark_2026.msg, /2026/);
  assert.equal(got.dark_2019.raised, true,
    'a pre-FTN season is dark for exactly the same reason');
  assert.equal(got.current_2026.raised, true, 'the live input loader refuses too');
  assert.equal(got.current_2025_ok, true, 'a covered season still loads');
  assert.equal(typeof got.covered_value, 'number');
  assert.deepEqual(got.is_dark, { 2025: false, 2026: true, 1999: true });
});

test('scheme: adoption can never turn into application while the season is dark', () => {
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts.signals import scheme_matchup as sm
doc = sm.load_doc()
dark = sm.adoption_block({"scale": 120.0}, "2026-01-01T00:00:00Z",
                         application=doc["application"])
lit = sm.adoption_block({"scale": 120.0}, "2026-01-01T00:00:00Z",
                        application={"live_season": 2030, "dark": False})
none = sm.adoption_block({"scale": 120.0}, "2026-01-01T00:00:00Z")
print(json.dumps({"dark": dark, "lit": lit, "none": none}))
`);
  assert.equal(got.dark.applied, false,
    'a winning backtest is not permission to price a season whose input is missing');
  assert.equal(got.dark.dark, true);
  assert.equal(got.dark.attribution, 'FTN Data via nflverse');
  assert.equal(got.dark.license, 'CC-BY-SA 4.0');
  assert.ok(String(got.dark.reason).length > 40, 'the block carries the reason');
  assert.equal(got.lit.applied, true, 'a published season would be appliable');
  assert.equal(got.none.applied, false,
    'with no application record at all the default is DARK, never lit');
});

test('scheme: the family is absent from APPLIABLE, so a win records would_adopt', () => {
  const src = readFileSync(PROMOTE, 'utf8');
  const m = src.match(/APPLIABLE\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'promote_signals declares an APPLIABLE set');
  assert.ok(!m[1].includes('scheme_matchup'),
    'scheme_matchup must NOT be appliable — nothing in build_predictions.py calls it, '
    + 'and FTN has no live season to call it with');
  assert.ok(src.includes('scheme_matchup'), 'but the family IS registered for trialling');
});

/* ------------------------------------------------------------------ *
 * 5. the family arithmetic                                            *
 * ------------------------------------------------------------------ */

test('scheme: the delta is an interaction and is exactly antisymmetric', () => {
  const got = py(`
import json
from scripts.signals.scheme_matchup import scheme_builder
feats = {2025: {8: {"off": {"H": 0.5, "A": 0.0, "P": 0.0},
                    "box": {"H": 0.0, "A": -2.0, "P": 0.0}}}}
_, factory = scheme_builder(80.0, feats)
fn = factory(2025)
def d(h, a, w=8, season=2025):
    _, f2 = scheme_builder(80.0, feats)
    return f2(season)({"home": h, "away": a, "week": w}, 0)
print(json.dumps({
  "matchup":     d("H", "A"),
  "swapped":     d("A", "H"),
  "no_box":      d("H", "P"),
  "no_tendency": d("P", "A"),
  "neither":     d("P", "P"),
  "bad_week":    d("H", "A", 99),
  "bad_season":  d("H", "A", 8, 1999),
  "bad_team":    d("Z", "A"),
}))
`);
  assert.equal(got.matchup, -80.0, '0.5 tendency x -2.0 box x 80 scale');
  assert.equal(got.swapped, 80.0, 'swapping the venue negates the delta EXACTLY');
  assert.equal(Math.abs(got.matchup + got.swapped), 0,
    'a matchup term must not survive the swap');
  assert.equal(Math.abs(got.no_box), 0,
    'a tendency with no box on the other side is 0.0 — this is an interaction, '
    + 'not a main effect that would re-price team strength');
  assert.equal(Math.abs(got.no_tendency), 0, 'and a box with no tendency is 0.0 too');
  assert.equal(Math.abs(got.neither), 0);
  assert.equal(Math.abs(got.bad_week), 0, 'an uncovered week is an exact 0.0, never a raise');
  assert.equal(Math.abs(got.bad_season), 0, 'an uncovered season is 0.0 INSIDE the walk');
  assert.equal(Math.abs(got.bad_team), 0, 'a team the join misses is 0.0, never a guess');
});

test('scheme: the window is strictly weeks < W, and blends N0=400 plays', () => {
  const got = py(`
import json
from scripts.signals import scheme_matchup as sm
prev = {"off_plays": 1000, "pa": 300, "screen": 100, "motion": 400,
        "no_huddle": 100, "def_plays": 1000, "box_sum": 6500, "box_plays": 1000}
empty = {k: 0 for k in sm._ALL_KEYS}
cur = dict(empty); cur.update({"off_plays": 400, "pa": 400, "def_plays": 400,
                               "box_plays": 400, "box_sum": 3400})
w1_off, w1_box = sm.blended_rates(empty, prev)
n0_off, n0_box = sm.blended_rates(cur, prev)
noprev_off, noprev_box = sm.blended_rates(cur, None)
weeks = {"9": {"off_plays": 1}, "10": {"off_plays": 1}, "11": {"off_plays": 1}}
print(json.dumps({
  "n0": sm.SCHEME_N0,
  "week1_pa": w1_off["pa"], "week1_box": w1_box,
  "n0_pa": n0_off["pa"], "n0_box": n0_box,
  "noprev_pa": noprev_off["pa"],
  "undefined": sm.blended_rates(empty, None),
  "before_11": sm._sum_weeks(weeks, ("off_plays",), before_week=11),
  "all": sm._sum_weeks(weeks, ("off_plays",)),
  "scales": sm.SCHEME_SCALES, "min_teams": sm.MIN_TEAMS_FOR_Z,
}))
`);
  assert.equal(got.n0, 400, 'SCHEME_N0 is 400 charted plays');
  assert.equal(got.week1_pa, 0.3, 'week 1 has no current window, so the rate IS the prior season');
  assert.equal(got.week1_box, 6.5);
  assert.equal(got.n0_pa, 0.65, 'at exactly N0 plays it is half current (1.0) and half prior (0.3)');
  assert.equal(got.n0_box, 7.5, 'and half of 8.5 plus half of 6.5');
  assert.equal(got.noprev_pa, 1.0, 'with no prior season the current window is the whole rate');
  assert.deepEqual(got.undefined, [null, null],
    'no prior AND no plays is UNDEFINED — never imputed to a league average');
  assert.deepEqual(got.before_11, { off_plays: 2 },
    'the week bound is NUMERIC: week 10 is inside week 11 window, and week 11 is not');
  assert.deepEqual(got.all, { off_plays: 3 });
  assert.deepEqual(got.scales, [0, 40, 80, 120], 'the grid TECH_DESIGN committed to');
  assert.equal(got.scales[0], 0, '0.0 is the incumbent and is filtered out by the caller');
  assert.equal(got.min_teams, 24, 'below 24 teams there is no league standard to z against');
});

test('scheme: z-scores are centered, and the small-league guard is inert not amplifying', () => {
  const got = py(`
import json
from scripts.signals import scheme_matchup as sm
few = {"T%02d" % i: float(i) for i in range(sm.MIN_TEAMS_FOR_Z - 1)}
flat = {"T%02d" % i: 5.0 for i in range(32)}
spread = {"T%02d" % i: float(i) for i in range(32)}
z = sm._z_map(spread)
print(json.dumps({
  "few_all_zero": all(v == 0.0 for v in sm._z_map(few).values()),
  "flat_all_zero": all(v == 0.0 for v in sm._z_map(flat).values()),
  "sum_z": round(sum(z.values()), 12),
  "hi": z["T31"] > 0, "lo": z["T00"] < 0,
}))
`);
  assert.equal(got.few_all_zero, true, 'too few teams -> all zeros, never a wild z');
  assert.equal(got.flat_all_zero, true, 'no spread -> all zeros, never a divide-by-epsilon');
  assert.equal(got.sum_z, 0, 'z is centered, so "good at everything" scores nothing');
  assert.ok(got.hi && got.lo);
});

/* ------------------------------------------------------------------ *
 * 6. coverage: partial is expected, and the dilution must be visible  *
 * ------------------------------------------------------------------ */

test('scheme: partial FTN coverage is TRIALLED, unlike a corrupted feed', () => {
  const got = py(`
import json, os, sys, tempfile
sys.path.insert(0, ".")
from scripts.signals import scheme_matchup as sm
res = {}
res["absent"] = sm.load_features([2025], path="/nonexistent/scheme.json")
res["absent_reason"] = sm.coverage_reason([2025], path="/nonexistent/scheme.json")
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "s.json")
    json.dump({"seasons": {}}, open(p, "w"))
    res["empty"] = sm.load_features([2025], path=p)
    res["empty_reason"] = sm.coverage_reason([2025], path=p)
loaded = sm.load_features(list(range(1999, 2026)))
res["partial_trialled"] = loaded is not None
res["covered"] = sorted(loaded[0]) if loaded else None
print(json.dumps(res))
`);
  assert.equal(got.absent, null, 'no artifact at all -> skip loudly');
  assert.match(got.absent_reason, /absent/);
  assert.equal(got.empty, null, 'an artifact with no seasons -> skip loudly');
  assert.match(got.empty_reason, /no seasons/);
  assert.equal(got.partial_trialled, true,
    'FTN starting in 2022 is the PERMANENT state of this feed — refusing to run '
    + 'on partial coverage would mean never measuring the family at all');
  assert.ok(got.covered.length >= 3 && Math.min(...got.covered) >= 2022);
});

test('scheme: the coverage block makes the dilution impossible to miss', () => {
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts.signals import scheme_matchup as sm
import scripts.promote_signals as ps
ps.use_corpus()
feats, diag, doc = sm.load_features(ps.SEASONS)
finals = {yr: ps.load_finals(yr) for yr in ps.SEASONS}
cov = sm.coverage_block(feats, ps.EVAL_SEASONS, finals, doc=doc)
print(json.dumps(cov))
`);
  assert.ok(got.seasons_with_ftn.length > 0 && got.seasons_dark.length > 0,
    'the corpus reaches back before FTN, so both lists are non-empty');
  assert.equal(got.folds_dark, got.seasons_dark.length);
  assert.equal(got.eval_folds, got.seasons_with_ftn.length + got.seasons_dark.length);
  assert.ok(got.games_priced > 0, 'the family did fire somewhere');
  assert.ok(got.games_unpriced > got.games_priced,
    'most of the corpus is dark — a reader must not mistake this for full coverage');
  assert.match(got.note, /DILUTED/, 'the record says the improvement is diluted');
  assert.match(got.note, /does not exist/,
    'and that a 0.0 there means "no data", not "no effect"');
  /* The measured magnitude, recorded rather than asserted — but it must be
   * SANE: TECH_DESIGN sized SCHEME_SCALES for a per-unit edge of order 1, so
   * the top of the grid reaches roughly +/-360 Elo, not +/-1200. */
  assert.ok(got.delta_stats.n > 0);
  assert.ok(got.delta_stats.sd > 0 && got.delta_stats.sd < 2,
    `per-unit delta sd is O(1) (got ${got.delta_stats.sd})`);
  assert.ok(Math.max(Math.abs(got.delta_stats.min), Math.abs(got.delta_stats.max)) < 5,
    'the extreme per-unit delta stays inside the magnitude the grid was sized for');
  assert.equal(got.attribution, 'FTN Data via nflverse',
    'the credit is read FROM the artifact, never hardcoded at the render site');
  assert.equal(got.license, 'CC-BY-SA 4.0');
  assert.equal(got.application.dark, true, 'the coverage record carries the dark flag too');
});

/* ------------------------------------------------------------------ *
 * 7. the market boundary                                              *
 * ------------------------------------------------------------------ */

test('scheme: neither module ever names a betting column', () => {
  for (const f of [MODULE, BUILDER]) {
    const src = readFileSync(f, 'utf8');
    for (const col of BETTING_COLUMNS) {
      assert.ok(!src.includes(col), `${f} must never name ${col}`);
    }
  }
  const doc = readFileSync(ARTIFACT, 'utf8');
  for (const col of BETTING_COLUMNS) {
    assert.ok(!doc.includes(col), `data/scheme_history.json must never carry ${col}`);
  }
});

test('scheme: the artifact is stdlib-shaped — ASCII, indent 2, numeric week order', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(raw), 'ensure_ascii=True, matching data/*.json');
  assert.match(raw, /^\{\n {2}"/, 'indent=2');
  const doc = JSON.parse(raw);
  const season = doc.seasons[String(Math.max(...doc.seasons_covered))];
  const team = Object.keys(season)[0];
  const weeks = Object.keys(season[team]).map(Number);
  assert.deepEqual(weeks, [...weeks].sort((a, b) => a - b),
    'weeks are emitted in NUMERIC order, so "10" never sorts before "2"');
});
