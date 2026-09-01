/* tests/feature/r49_sleeper_projections.test.mjs — R49 Deliverable B: the
 * data/sleeper_projections.json producer (DISPLAY-ONLY, never a model input).
 *
 * Locks:
 *   1. the reference fixture (tests/fixtures/sleeper_proj/) validates against
 *      the new contract through the SAME validator the gate runs;
 *   2. the builder's pure core reproduces the fixture's shape from raw
 *      Sleeper rows: exact-match crosswalk (espn id / gsis id / DST-<TEAM> /
 *      unique name), the pts_ppr keep rule, the stat_keys reduction, and a
 *      measured match report;
 *   3. the stat_keys allowlist IS the fixture's (the scoring universe
 *      app/league.js applyScoring prices), byte for byte;
 *   4. the contract pins display_only: true, the validator routes the file and
 *      treats it as runner-built, the daily runner builds it AFTER the pool,
 *      the perf allowlist admits it, and NO data file was committed from the
 *      fixture (that would be fabricated provenance).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const FIXTURE = 'tests/fixtures/sleeper_proj/sleeper_projections.json';

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('the reference fixture validates against data/contracts/sleeper_projections.schema.json', () => {
  const r = py(`
from scripts import validate_data as vd
schema = json.load(open("data/contracts/sleeper_projections.schema.json"))
doc = json.load(open("${FIXTURE}"))
vd.validate_against_schema(doc, schema, "fixture")
bad = json.loads(json.dumps(doc)); bad["display_only"] = False
try:
    vd.validate_against_schema(bad, schema, "fixture"); flipped = "accepted"
except vd.ValidationError as exc:
    flipped = "rejected"
leak = json.loads(json.dumps(doc)); leak["players"][0]["weeks"]["1"]["adp"] = 3.0
try:
    vd.check_market_price_fields(json.load(open("data/meta.json")),
        json.load(open("data/player_projections.json")),
        json.load(open("data/contracts/player_projections.schema.json")),
        extra_docs=[("sleeper_projections.json", leak)]); price = "accepted"
except vd.ValidationError:
    price = "rejected"
print(json.dumps({"ok": True, "players": len(doc["players"]), "flipped": flipped, "price": price}))`);
  assert.equal(r.ok, true);
  assert.ok(r.players > 200);
  assert.equal(r.flipped, 'rejected', 'display_only is pinned true by enum');
  assert.equal(r.price, 'rejected', 'a price field inside the feed reds the market-display-only scan');
});

test('the pure core reproduces the fixture shape from raw Sleeper rows, with exact matching only', () => {
  const r = py(`
from scripts import build_sleeper_projections as b
fx = json.load(open("${FIXTURE}"))
dump = {"96": {"player_id": "96", "espn_id": 8439, "full_name": "Aaron Rodgers", "team": "PIT", "position": "QB"},
        "1433": {"player_id": "1433", "gsis_id": "00-0029822", "full_name": "Brandon McManus", "position": "K"},
        "5859": {"player_id": "5859", "espn_id": 4047646, "full_name": "A.J. Brown", "team": "NE", "position": "WR"},
        "42": {"player_id": "42", "full_name": "Odell Beckham Jr.", "team": None, "position": "WR"},
        "43": {"player_id": "43", "espn_id": 1, "full_name": "Jayden Daniels", "team": "WAS", "position": "QB"}}
pool = [{"gsis_id": "espn-8439", "name": "Aaron Rodgers", "team": "PIT", "position": "QB"},
        {"gsis_id": "espn-4047646", "name": "A.J. Brown", "team": "NE", "position": "WR"},
        {"gsis_id": "espn-77", "name": "Odell Beckham", "team": "LAR", "position": "WR"},
        {"gsis_id": "espn-78", "name": "Jayden Daniels", "team": "WAS", "position": "QB"}]
kickers = [{"player_id": "00-0029822", "name": "Brandon McManus", "team": "GB"}]
def row(sid, first, last, pos, team, week, stats):
    return {"player_id": sid, "week": week, "team": team,
            "player": {"first_name": first, "last_name": last, "position": pos, "team": team},
            "stats": stats}
rows = {1: [row("96", "Aaron", "Rodgers", "QB", "PIT", 1, {"pts_ppr": 17.63, "pass_yd": 218.28, "adp_dd_ppr": 103.0, "cmp_pct": 63.7}),
            row("1433", "Brandon", "McManus", "K", None, 1, {"pts_ppr": 7.0, "fgm_yds": 40.0}),
            row("5859", "A.J.", "Brown", "WR", "NE", 1, {"pts_ppr": 16.84, "rec": 5.42}),
            row("42", "Odell", "Beckham Jr.", "WR", None, 1, {"pts_ppr": 5.0}),
            row("43", "Jayden", "Daniels", "QB", "WAS", 1, {"pts_ppr": 22.0}),
            row("SF", "San Francisco", "49ers", "DEF", "SF", 1, {"pts_ppr": 5.75, "sack": 2.17, "yds_allow_350_399": 1.0}),
            row("900", "No", "Points", "RB", "SEA", 1, {"gp": 1.0})],
        2: [row("96", "Aaron", "Rodgers", "QB", "PIT", 2, {"pts_ppr": 18.0})]}
doc = b.build_document(rows, b.build_dump_index(dump), b.build_pool_index(pool, kickers), 2026, fx["generated_utc"])
print(json.dumps({"doc": doc, "fixture_keys": list(fx.keys()), "fixture_row_keys": list(fx["players"][0].keys()),
                  "fixture_stat_keys": fx["stat_keys"], "builder_stat_keys": doc["stat_keys"]}))`);
  const { doc } = r;
  // same top-level and row shape as the reference fixture (additive keys aside)
  for (const k of r.fixture_keys) assert.ok(k in doc, `builder output lacks fixture key ${k}`);
  for (const k of r.fixture_row_keys) assert.ok(k in doc.players[0], `row lacks ${k}`);
  assert.equal(doc.display_only, true);
  assert.equal(doc.source, 'sleeper');
  assert.deepEqual(r.builder_stat_keys, r.fixture_stat_keys, 'stat_keys IS the fixture allowlist');
  const by = Object.fromEntries(doc.players.map((p) => [p.sleeper_id, p]));
  assert.equal(by['96'].app_id, 'espn-8439', 'offence by espn id');
  assert.equal(by['1433'].app_id, '00-0029822', 'kickers by gsis id');
  assert.equal(by['5859'].app_id, 'espn-4047646');
  assert.equal(by['42'].app_id, 'espn-77', 'name+position fallback (no team known): Jr. stripped');
  assert.equal(by['43'].app_id, 'espn-78', 'espn id NOT in the pool -> name+team+position fallback');
  assert.equal(by.SF.app_id, 'DST-SF', 'defenses are DST-<TEAM>');
  assert.equal(by['900'], undefined, 'a row with no pts_ppr in any week is dropped');
  assert.deepEqual(Object.keys(by['96'].weeks), ['1', '2']);
  assert.ok(!('adp_dd_ppr' in by['96'].weeks['1']) && !('cmp_pct' in by['96'].weeks['1']),
    'only stat_keys survive — ADP is a market price and never rides along');
  assert.equal(by['96'].weeks['1'].pass_yd, 218.28);
  assert.equal(doc.match.rows_kept, 6);
  assert.equal(doc.match.rows_dropped_no_pts_ppr, 1);
  assert.equal(doc.match.pool_matched, 5);
  assert.equal(doc.match.pool_players, 5);
  assert.deepEqual(doc.match.by_method,
    { espn_id: 2, gsis_id: 1, name_position: 1, name_team_position: 1, team_def: 1 });
});

test('the builder output validates against the contract', () => {
  const r = py(`
from scripts import build_sleeper_projections as b
from scripts import validate_data as vd
dump, proj, kickers, rows = b._synthetic()
doc = b.build_document(rows, b.build_dump_index(dump), b.build_pool_index(proj, kickers), 2026, "2026-09-01T00:00:00Z")
vd.validate_against_schema(doc, json.load(open("data/contracts/sleeper_projections.schema.json")), "built")
print(json.dumps({"ok": True}))`);
  assert.equal(r.ok, true);
});

test('wiring: validator routes it as runner-built, daily.yml builds it AFTER the pool, perf allowlist admits it, no data file committed from the fixture', () => {
  const vd = read('scripts/validate_data.py');
  assert.match(vd, /"sleeper_projections\.schema\.json":\s*"sleeper_projections\.json"/);
  const optional = vd.slice(vd.indexOf('OPTIONAL_DATA'), vd.indexOf('EXPECTED_SIGNALS'));
  assert.ok(optional.includes('"sleeper_projections.json"'), 'runner-built -> OPTIONAL_DATA');
  const yml = read('.github/workflows/daily.yml');
  const pool = yml.indexOf('python -m scripts.build_predictions');
  const sleeper = yml.indexOf('scripts/build_sleeper_projections.py');
  const validate = yml.indexOf('python scripts/validate_data.py');
  assert.ok(pool > 0 && sleeper > pool && validate > sleeper,
    'the Sleeper build must run after the pool is built and before validation');
  const budget = read('tests/perf/budget.spec.mjs');
  assert.match(budget, /'sleeper_projections\.json'/, 'CONTRACT_ALLOWLIST must admit the lazy fetch');
  assert.match(budget, /R49/);
  // the fixture is a reference shape, not provenance: the data file is runner-built
  const committed = existsSync(join(REPO_ROOT, 'data/sleeper_projections.json'));
  if (committed) {
    const doc = JSON.parse(read('data/sleeper_projections.json'));
    const fx = JSON.parse(read(FIXTURE));
    assert.notEqual(doc.generated_utc, fx.generated_utc,
      'data/sleeper_projections.json may never be a copy of the test fixture');
    assert.ok(doc.match, 'a runner-built file carries its measured match report');
  }
  assert.match(read('tests/smoke.sh'), /build_sleeper_projections\.py --selftest/);
});
