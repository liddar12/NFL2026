/* tests/feature/backtest_player.test.mjs — locks for the PLAYER-LEVEL
 * walk-forward harness (scripts/backtest_player.py).
 *
 * The harness exists because the never-regress gate measures GAME-level
 * log-loss only; before it, no player signal could be honestly adopted because
 * nothing measured player-level projections at all. These locks protect the
 * three properties that make it worth trusting:
 *
 *   1. IT SCORES THE DEPLOYED CODE PATH. The projection under test is
 *      scripts.models.player_projection.project_player itself — the same
 *      function build_predictions.py calls — and its season total is what
 *      app/ros.js rosPoints() returns for from_week=1. We prove that end to
 *      end by splitting a projection with the REAL build_weekly.player_weeks()
 *      in python and summing it with the REAL rosPoints() imported from
 *      app/ros.js here in node. A python-side mirror that drifts from the
 *      shipped JS fails this test.
 *   2. IT IS LEAK-FREE. Flipping a held-out season's actuals must not change a
 *      single projection input for that season.
 *   3. IT CANNOT LIE IN THE COMMITTED ARTIFACT. data/player_backtest.json is
 *      recomputed-and-compared here: summary counts must follow from the
 *      per-position blocks, `measured` blocks must actually carry metrics, and
 *      data/ros_backtest.json must agree with it number for number. A
 *      dishonest or malformed write reds the gate (REL15 bugs #9, #10, #11).
 *
 * Node built-ins only; python3 is already a fast-gate dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { rosPoints } from '../../app/ros.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = resolve(REPO_ROOT, 'data/player_backtest.json');
const LEGACY = resolve(REPO_ROOT, 'data/ros_backtest.json');
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

const PRELUDE = `
import json
from scripts import backtest_player as bp
`;

// ---------------------------------------------------------------------------
// 1. Rank + error metrics.
// ---------------------------------------------------------------------------

test('rank and error metrics are correct on known fixtures', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({
  "perfect": bp.spearman([(1, 10), (2, 20), (3, 30)]),
  "inverse": bp.spearman([(1, 30), (2, 20), (3, 10)]),
  "too_few": bp.spearman([(1, 1), (2, 2)]),
  "flat": bp.spearman([(1, 5), (2, 5), (3, 5)]),
  "ndcg_good": bp.ndcg([30, 20, 10], 3),
  "ndcg_bad": bp.ndcg([10, 20, 30], 3),
  "mae": bp.mae([(10, 12), (10, 8)]),
  "rmse": bp.rmse([(10, 13), (10, 7)]),
}))`);
  assert.ok(Math.abs(r.perfect - 1) < 1e-9, `perfect rank corr, got ${r.perfect}`);
  assert.ok(Math.abs(r.inverse + 1) < 1e-9, `inverse rank corr, got ${r.inverse}`);
  assert.equal(r.too_few, null, 'fewer than 3 points is not a correlation');
  assert.equal(r.flat, null, 'a constant column has no rank correlation');
  assert.ok(r.ndcg_good > r.ndcg_bad);
  assert.equal(r.mae, 2);
  assert.equal(r.rmse, 3);
});

// ---------------------------------------------------------------------------
// 2. The projection under test IS the deployed one.
// ---------------------------------------------------------------------------

test('the harness scores project_player itself, not a proxy formula', () => {
  const r = runPy(`${PRELUDE}
from scripts.models.player_projection import project_player
hist = bp._fixture_history()
rows, _ = bp.build_rows(hist, 2025)
row = rows[0]
print(json.dumps({
  "harness": bp.engine_projection(row["record"]),
  "deployed": project_player(row["record"], ctx=None, weights=None)["proj_points"],
  "prior_season_points": row["record"]["prior_season_points"],
  "last_year": row["last_year"],
}))`);
  assert.equal(r.harness, r.deployed);
  // Day-zero weights: applied = 1 + 0*(adj-1) = 1, so the projection collapses
  // to the prior_perf baseline exactly. If this ever stops holding, a signal
  // has earned weight and the "engine == last_year" disclosure must change too.
  assert.equal(r.harness, r.prior_season_points);
  assert.equal(r.harness, r.last_year);
});

test('the python RoS mirror matches the shipped app/ros.js rosPoints', () => {
  const r = runPy(`${PRELUDE}
sched = bp.build_weekly.team_schedule(bp._synthetic_schedule())
out = []
for proj in (123.4, 250.0, 7.5, 0.0):
    weeks = bp.build_weekly.player_weeks(proj, "AAA", sched, {})
    out.append({"proj": proj, "weeks": weeks, "mirror": bp.ros_points_mirror(weeks, 1),
                "mirror_wk10": bp.ros_points_mirror(weeks, 10)})
print(json.dumps(out))`);
  for (const c of r) {
    assert.equal(rosPoints(c.weeks, 1), c.mirror,
      'the python mirror has drifted from app/ros.js rosPoints');
    assert.equal(rosPoints(c.weeks, 10), c.mirror_wk10);
    // The deployed-path identity the whole season-granularity backtest rests on.
    assert.ok(Math.abs(rosPoints(c.weeks, 1) - c.proj) <= 0.15,
      `split->sum must round-trip the season projection (${c.proj})`);
  }
});

// ---------------------------------------------------------------------------
// 3. Walk-forward leak-freedom.
// ---------------------------------------------------------------------------

test('held-out actuals cannot reach the projection inputs for that season', () => {
  const r = runPy(`${PRELUDE}
hist = bp._fixture_history()
rows_a, _ = bp.build_rows(hist, 2025)
leaked = json.loads(json.dumps(hist))
for rec in leaked["players"].values():
    for s in rec["seasons"]:
        if s["yr"] == 2025:
            s["pts"] = 9999.0
rows_b, _ = bp.build_rows(leaked, 2025)
print(json.dumps({
  "records_equal": [r["record"] for r in rows_a] == [r["record"] for r in rows_b],
  "projections_equal": ([bp.engine_projection(r["record"]) for r in rows_a]
                        == [bp.engine_projection(r["record"]) for r in rows_b]),
  "baselines_equal": ([r["ppg17"] for r in rows_a] == [r["ppg17"] for r in rows_b]),
  "actuals_moved": all(r["actual"] == 9999.0 for r in rows_b),
  "max_prior_year": max(max(s["yr"] for s in rec["seasons"] if s["yr"] <= 2024)
                        for rec in hist["players"].values()),
}))`);
  assert.equal(r.records_equal, true);
  assert.equal(r.projections_equal, true);
  assert.equal(r.baselines_equal, true);
  assert.equal(r.actuals_moved, true, 'the fixture flip must actually have landed');
  assert.equal(r.max_prior_year, 2024);
});

test('every held-out season is scored only against strictly earlier seasons', () => {
  const r = runPy(`${PRELUDE}
res = bp.run(bp._fixture_history())
print(json.dumps([{"held_out": e["held_out"], "fit": e["fit_seasons"],
                   "season": e["season"]} for e in res["per_season"]]))`);
  assert.ok(r.length > 0);
  for (const e of r) {
    assert.equal(e.season, e.held_out);
    assert.equal(e.fit, `<= ${e.held_out - 1}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The retired backtest_ros orphan stays retired (REL15 #9/#10).
// ---------------------------------------------------------------------------

test('scripts/backtest_ros.py is gone and no code path still calls it', () => {
  assert.equal(existsSync(resolve(REPO_ROOT, 'scripts/backtest_ros.py')), false);
  // Built at runtime so this file's own prose can never match the search.
  const N = `backtest_${'ros'}`;
  const invocation = `(python3? +(-m +)?scripts[./]${N}` +
    `|import +(scripts\\.)?${N}|from +scripts +import +${N})`;
  // grep exits 1 when nothing matches, which is exactly the passing case.
  let hits = '';
  try {
    hits = execFileSync('grep', ['-rIlE', '--exclude-dir=__pycache__',
      invocation, 'scripts', 'app', 'tests', '.github'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    }).trim();
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  assert.equal(hits, '', `still invokes the retired RoS backtest script: ${hits}`);
});

test('data/player_backtest.json is registered in validate_data.py', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/validate_data.py'), 'utf8');
  assert.match(src, /"player_backtest\.schema\.json":\s*"player_backtest\.json"/,
    'the artifact must be routed to its contract');
  const optional = src.slice(src.indexOf('OPTIONAL_DATA'), src.indexOf('EXPECTED_SIGNALS'));
  assert.ok(optional.includes('"player_backtest.json"'),
    'the artifact is runner-built, so it belongs in OPTIONAL_DATA');
  assert.ok(existsSync(resolve(REPO_ROOT, 'data/contracts/player_backtest.schema.json')));
});

test('the smoke gate runs the harness selftest', () => {
  const smoke = readFileSync(resolve(REPO_ROOT, 'tests/smoke.sh'), 'utf8');
  assert.match(smoke, /scripts\/backtest_player\.py --selftest/);
});

// ---------------------------------------------------------------------------
// 5. The committed artifact cannot lie.
// ---------------------------------------------------------------------------

const artifact = existsSync(ARTIFACT)
  ? JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  : null;

test('committed player_backtest.json declares the real engine and its limits', {
  skip: artifact ? false : 'data/player_backtest.json not built yet (runner-built)',
}, () => {
  const m = artifact.__meta__;
  assert.equal(m.engine, 'scripts.models.player_projection.project_player');
  assert.equal(m.method, 'walk_forward_season_holdout');
  assert.equal(m.granularity, 'season');
  assert.ok(m.approximations.length >= 3, 'the disclosure list may not be emptied');
  const disclosure = m.approximations.join(' ').toLowerCase();
  for (const must of ['weekly', 'availability', 'input set']) {
    assert.ok(disclosure.includes(must), `approximations must disclose: ${must}`);
  }
  // The path-identity claim is a MEASUREMENT, and it has to hold.
  assert.ok(m.path_identity.checked > 0);
  assert.ok(m.path_identity.max_abs_diff <= m.path_identity.tolerance);
  assert.equal(m.path_identity.holds, true);
  // Weight provenance is explicit; a "registry" run may not carry overrides.
  assert.ok(['registry', 'override'].includes(m.weights_source));
  if (m.weights_source === 'registry') {
    assert.deepEqual(m.nonzero_weights, {},
      'the registry is at day-zero: a non-zero weight here is a false claim');
  }
});

test('every scored block carries real metrics; every skipped block says why', {
  skip: artifact ? false : 'artifact not built yet',
}, () => {
  const blocks = [
    ...Object.entries(artifact.pooled).map(([p, b]) => [`pooled.${p}`, b]),
    ...artifact.per_season.flatMap((e) => Object.entries(e.positions)
      .map(([p, b]) => [`${e.season}.${p}`, b])),
  ];
  assert.ok(blocks.length > 0);
  for (const [label, b] of blocks) {
    if (!b.measured) {
      assert.ok(b.skipped, `${label}: an unscored block must state why`);
      assert.ok(!('rho_engine' in b), `${label}: unscored blocks carry no metrics`);
      continue;
    }
    assert.ok(b.n >= 3, `${label}: a rank correlation needs >= 3 players`);
    for (const key of ['rho_engine', 'rho_last_year', 'rho_ppg17',
      'mae_engine', 'mae_last_year', 'mae_ppg17',
      'rmse_engine', 'rmse_last_year', 'rmse_ppg17']) {
      assert.equal(typeof b[key], 'number', `${label}: measured but ${key} missing`);
    }
    // "beats" is derived, never independently asserted.
    assert.equal(b.beats_last_year, b.rho_engine > b.rho_last_year, `${label}`);
    assert.equal(b.beats_ppg17, b.rho_engine > b.rho_ppg17, `${label}`);
    // The day-zero identity: if the engine IS the baseline it cannot beat it.
    if (b.engine_equals_last_year) {
      assert.equal(b.rho_engine, b.rho_last_year, `${label}`);
      assert.equal(b.mae_engine, b.mae_last_year, `${label}`);
      assert.equal(b.beats_last_year, false, `${label}`);
    }
  }
});

test('summary counts follow from the per-position blocks', {
  skip: artifact ? false : 'artifact not built yet',
}, () => {
  const measured = Object.values(artifact.pooled).filter((b) => b.measured);
  const s = artifact.summary;
  assert.equal(s.positions_scored, measured.length);
  assert.equal(s.engine_beats_last_year,
    measured.filter((b) => b.beats_last_year).length);
  assert.equal(s.engine_beats_ppg17, measured.filter((b) => b.beats_ppg17).length);
  assert.equal(s.engine_equals_last_year_everywhere,
    measured.every((b) => b.engine_equals_last_year));
  if (s.engine_equals_last_year_everywhere) {
    assert.equal(s.engine_beats_last_year, 0,
      'the engine cannot out-rank a baseline it is numerically identical to');
  }
  assert.ok(s.player_seasons_scored > 0);
  assert.ok(s.player_seasons_excluded_no_prior >= 0);
});

test('the signal audit partitions the registry without overlap', {
  skip: artifact ? false : 'artifact not built yet',
}, () => {
  const a = artifact.signal_audit;
  const union = new Set([...a.baseline_fed, ...a.engine_implements, ...a.registry_only]);
  assert.equal(union.size, a.player_signals_in_registry);
  for (const name of a.registry_only) {
    assert.ok(!a.engine_implements.includes(name),
      `${name} cannot be both implemented and registry-only`);
  }
  for (const name of [...a.deployed_inputs_fire, ...a.candidate_inputs_fire]) {
    assert.ok(a.engine_implements.includes(name),
      `${name} fires but is not listed as implemented`);
    assert.ok(!a.substrate_missing.includes(name),
      `${name} fires, so its inputs are not missing`);
  }
});

test('ros_backtest.json agrees with player_backtest.json number for number', {
  skip: (artifact && existsSync(LEGACY)) ? false : 'artifact(s) not built yet',
}, () => {
  const legacy = JSON.parse(readFileSync(LEGACY, 'utf8'));
  assert.match(legacy.__meta__.method, /deployed_engine/,
    'the legacy view must name the deployed engine, not the retired proxy');
  assert.equal(legacy.summary.positions_scored, artifact.summary.positions_scored);
  assert.equal(legacy.summary.positions_beating_baseline,
    artifact.summary.engine_beats_last_year);
  for (const pos of POSITIONS) {
    const a = artifact.pooled[pos];
    const l = legacy.pooled[pos];
    if (!a || !a.measured) continue;
    assert.ok(l, `pooled ${pos} present in player_backtest but not ros_backtest`);
    assert.equal(l.n, a.n);
    assert.equal(l.rho_ros, a.rho_engine, `${pos}: legacy rho drifted from the engine`);
    assert.equal(l.rho_lastyear, a.rho_last_year);
    assert.equal(l.beats_baseline, a.beats_last_year);
    assert.equal(l.measured, true);
  }
});
