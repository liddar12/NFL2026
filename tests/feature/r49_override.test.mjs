/* tests/feature/r49_override.test.mjs — R49 OWNER OVERRIDE of the baseline gate:
 * from this release the SHIPPED projection is the SCENARIO candidate.
 *
 * Recorded as an override, not as a gate result: the walk-forward gate said
 * "not adopted" (rank-corr up, MAE down) and that verdict stays in
 * data/player_backtest.json baseline_gate; the owner decided to ship the
 * scenario anyway and to keep the loop scoring gated vs candidate. Locks:
 *   1. SHIPPED_ESTIMATE == 'candidate': proj_points/low/high are the candidate,
 *      signals_used names the applied candidate signals, gated_* keeps the
 *      gate-conforming number on every record (nothing lost);
 *   2. the candidate band was CALIBRATED before shipping as the interval:
 *      CANDIDATE_BAND_MULTIPLIER x band covers ~0.68 of 2024->2025 actuals;
 *   3. COMPONENT PRICING stays consistent: league_components, base_applied_pts,
 *      receptions_prior and completions_prior scale by proj_points /
 *      prior_season_points, bonus_games stays a count, and the client's
 *      integrity check (app/team-logic.js componentDelta: sum(base x qty)
 *      reproduces base_applied_pts within 1.0) passes on the scaled records;
 *   4. the contracts accept records WITH and WITHOUT the new fields (the
 *      committed pool predates them until the daily run rebuilds it), and the
 *      ledger/resolver carry three series.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { componentDelta, ESPN_BASE_PPR } from '../../app/team-logic.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('SHIPPED_ESTIMATE is "candidate": proj_points IS the scenario, the gated number rides along', () => {
  const r = py(`
from scripts.models import player_projection as pp
rec = {"gsis_id": "x", "name": "A", "team": "BAL", "position": "QB",
       "prior_season_points": 214.86, "prior_games": 13, "age": 29,
       "injury_status": "Questionable", "games_missed_rate": 0.1}
c = pp.project_player(rec)
g = pp.project_player(rec, mode="gated")
print(json.dumps({"mode": pp.SHIPPED_ESTIMATE, "modes": list(pp.SHIPPED_MODES), "c": c, "g": g}))`);
  assert.equal(r.mode, 'candidate');
  assert.deepEqual(r.modes, ['gated', 'candidate']);
  const c = r.c;
  assert.equal(c.shipped_estimate, 'candidate');
  assert.equal(c.proj_points, c.candidate_points);
  assert.equal(c.low, c.candidate_low);
  assert.equal(c.high, c.candidate_high);
  assert.equal(c.baseline_rule, 'prior_ppg_x_projected_games');
  assert.deepEqual(c.signals_used,
    Object.keys(c.candidate_signals).filter((k) => c.candidate_signals[k] !== 1).sort());
  assert.ok(c.signals_used.length >= 2, 'age + status + durability applied');
  // the gate-conforming number is kept, byte for byte what "gated" mode ships
  assert.equal(c.gated_points, 214.86);
  assert.equal(c.gated_rule, 'prior_season_points');
  assert.equal(c.gated_points, r.g.proj_points);
  assert.equal(c.gated_low, r.g.low);
  assert.equal(c.gated_high, r.g.high);
  assert.equal(r.g.shipped_estimate, 'gated');
  assert.deepEqual(r.g.signals_used, [], 'gated: nothing has earned weight');
  // Lamar-shaped record: 13 games -> the shipped number is no longer a 13-game season
  assert.ok(c.candidate_baseline > 270 && c.candidate_baseline < 285, `${c.candidate_baseline}`);
});

test('the candidate band ships calibrated: multiplier x band covers ~0.68 of 2024->2025 actuals', () => {
  const r = py(`
from scripts.models import player_projection as pp
from scripts import backtest_player as bp
hist = json.load(open("data/player_history.json"))
rows, _ = bp.build_rows(hist, 2025)
per = []
for row in rows:
    o = pp.project_player(dict(row["record"]))
    per.append((o["candidate_points"], o["candidate_low"], o["candidate_high"], row["actual"]))
cov = sum(1 for c, lo, hi, a in per if lo <= a <= hi) / len(per)
raw = pp._interval_band({"position": "WR"}, {})
o = pp.project_player({"gsis_id": "x", "name": "A", "team": "SF", "position": "WR",
                       "prior_season_points": 170.0, "prior_games": 17})
print(json.dumps({"k": pp.CANDIDATE_BAND_MULTIPLIER, "target": pp.CANDIDATE_BAND_TARGET,
                  "coverage": cov, "n": len(per), "raw_band": raw,
                  "shipped_half_width": (o["high"] - o["proj_points"]) / o["proj_points"]}))`);
  assert.equal(r.k, 2.25);
  assert.equal(r.target, 0.68);
  assert.ok(r.n > 200);
  assert.ok(Math.abs(r.coverage - 0.68) <= 0.03, `coverage ${r.coverage} must sit at ~0.68`);
  assert.ok(Math.abs(r.shipped_half_width - r.raw_band * r.k) < 1e-6,
    'the shipped interval half-width is the raw band times the calibrated multiplier');
  const bt = JSON.parse(read('data/player_backtest.json')).candidate_2025;
  assert.equal(bt.band_multiplier, r.k);
  assert.ok(Math.abs(bt.band_coverage - r.coverage) < 1e-6, 'the artifact reports coverage AT the multiplier');
});

test('component pricing scales with the shipped number and the client integrity check still passes', () => {
  const r = py(`
from scripts import build_weekly as bw
comp = {"components": {"pass_yd": 4183.0, "pass_td": 41.0, "pass_int": 4.0, "pass_2pt": 1.0,
                       "rush_yd": 915.0, "rush_td": 4.0, "fum_lost": 3.0, "rec_tgt": 0.0,
                       "pass_att": 474.0, "pass_cmp": 316.0},
        "base_applied_pts": round(4183*0.04 + 41*4 - 4*2 + 1*2 + 915*0.1 + 4*6 - 3*2, 2),
        "bonus_games": {"bonus_pass_yd_300": 5}}
ratio = bw.shipped_ratio({"proj_points": 362.88}, 214.86)
rec, cmp, scaled = bw.scale_prior_lines(ratio, 0.0, 316.0, comp)
print(json.dumps({"ratio": ratio, "rec": rec, "cmp": cmp, "scaled": scaled, "orig": comp}))`);
  assert.ok(Math.abs(r.ratio - 362.88 / 214.86) < 1e-9);
  const { scaled, orig } = r;
  // every quantity and the base scale by the same ratio; the count does not
  for (const k of Object.keys(orig.components)) {
    assert.ok(Math.abs(scaled.components[k] - orig.components[k] * r.ratio) <= 0.05, k);
  }
  assert.ok(Math.abs(scaled.base_applied_pts - orig.base_applied_pts * r.ratio) < 0.01);
  assert.deepEqual(scaled.bonus_games, orig.bonus_games, 'bonus_games is a count');
  assert.ok(Math.abs(r.cmp - 316 * r.ratio) <= 0.05, 'completions_prior scales too (rule 3 agreement)');
  assert.ok(Math.abs(r.cmp - scaled.components.pass_cmp) <= 0.6);
  // the CLIENT's own integrity check: sum(base x qty) reproduces base_applied_pts within 1.0
  let baseCheck = 0;
  for (const [k, qty] of Object.entries(scaled.components)) baseCheck += (ESPN_BASE_PPR[k] || 0) * qty;
  assert.ok(Math.abs(baseCheck - scaled.base_applied_pts) <= 1.0, `drift ${baseCheck - scaled.base_applied_pts}`);
  // ...and the league delta (extras) scales with the ratio, through the real componentDelta
  const profile = { name: 'x', scoring: { pass_td: 6, pass_int: -1, pass_cmp: 0.5, bonus_pass_yd_300: 3 } };
  const before = componentDelta({ league_components: orig.components, base_applied_pts: orig.base_applied_pts }, profile);
  const after = componentDelta({ league_components: scaled.components, base_applied_pts: scaled.base_applied_pts }, profile);
  assert.ok(before !== null && after !== null, 'the integrity check must pass on both records');
  assert.ok(Math.abs(after - before * r.ratio) < 0.5, `extras must scale: ${before} -> ${after} (ratio ${r.ratio})`);
  const withBonus = componentDelta({ league_components: scaled.components, base_applied_pts: scaled.base_applied_pts, bonus_games: scaled.bonus_games }, profile);
  assert.ok(Math.abs(withBonus - after - 15) < 1e-6, 'bonus games add 5 x 3, unscaled');
  // the pipeline applies exactly this helper before the weekly split
  const src = read('scripts/build_predictions.py');
  assert.match(src, /build_weekly\.shipped_ratio\(/);
  assert.match(src, /build_weekly\.scale_prior_lines\(/);
  const idx = src.indexOf('build_weekly.scale_prior_lines(');
  assert.ok(idx > 0 && idx < src.indexOf('build_weekly.build_weekly_document('), 'scaled before the split');
});

test('contracts accept records with and without the override fields; three series in the ledger contracts', () => {
  const r = py(`
from scripts import validate_data as vd
from scripts.models import player_projection as pp
schema = json.load(open("data/contracts/player_projections.schema.json"))
old = {"season": 2026, "updated_utc": "t", "players": [
  {"gsis_id": "espn-1", "name": "A", "team": "SF", "position": "RB", "proj_points": 1.0,
   "low": 0.5, "high": 1.5, "signals_used": []}]}
new = {"season": 2026, "updated_utc": "t", "players": [pp.project_player(
  {"gsis_id": "espn-1", "name": "A", "team": "SF", "position": "RB",
   "prior_season_points": 100.0, "prior_games": 10, "age": 31})]}
vd.validate_against_schema(old, schema, "old")
vd.validate_against_schema(new, schema, "new")
bad = json.loads(json.dumps(new)); bad["players"][0]["shipped_estimate"] = "whatever"
try:
    vd.validate_against_schema(bad, schema, "bad"); rejected = False
except vd.ValidationError:
    rejected = True
committed = json.load(open("data/player_projections.json"))
vd.validate_against_schema(committed, schema, "committed")
led = json.load(open("data/contracts/estimate_ledger.schema.json"))
sc = json.load(open("data/contracts/estimate_scores.schema.json"))
print(json.dumps({"rejected": rejected,
  "ledger_gated": "gated_pts" in led["properties"]["players"]["additionalProperties"]["properties"]["latest"]["required"],
  "locked_gated": "gated" in led["properties"]["players"]["additionalProperties"]["properties"]["locked"]["additionalProperties"]["required"],
  "scores_gated": "mae_gated" in sc["properties"]["totals"]["required"] and "gated" in sc["properties"]["resolved"]["items"]["required"],
  "committed_has_new": all("gated_points" in p for p in committed["players"]),
}))`);
  assert.equal(r.rejected, true);
  assert.equal(r.ledger_gated, true);
  assert.equal(r.locked_gated, true);
  assert.equal(r.scores_gated, true);
  // whether or not the committed pool has been rebuilt with the new fields, it validates
  assert.equal(typeof r.committed_has_new, 'boolean');
  const meta = JSON.parse(read('data/meta.json'));
  assert.equal(meta.projection_baseline.shipped.mode, 'candidate');
  assert.equal(meta.projection_baseline.shipped.owner_override, true);
  const bt = meta.projection_baseline.shipped.backtest_2025;
  assert.equal(typeof bt.gated_mae, 'number');
  assert.equal(typeof bt.candidate_mae, 'number');
  assert.ok(Math.abs(bt.band_coverage_after_calibration - 0.68) <= 0.03);
});
