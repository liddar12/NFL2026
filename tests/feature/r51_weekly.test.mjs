/* tests/feature/r51_weekly.test.mjs — locks for weekly_split_v2 (R51) and its
 * walk-forward never-regress harness.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE FACTOR MATH. Each of the four multipliers (DvP, QB-only Elo tilt,
 *      weather, venue) is exercised through the real scripts/build_weekly.py
 *      functions on fixture feeds, including every neutral rule (absent
 *      opponent, retractable roof, no forecast row, low_n / missing venue,
 *      lam <= 0.3). A silent change to a multiplier or a neutral rule reds the
 *      gate.
 *   2. THE INVARIANTS v1 GUARANTEED still hold under v2: bye rows are 0, the
 *      playable non-bye weeks sum EXACTLY to the season target (1e-6), the
 *      row schema is unchanged, and both injury mechanics compose with the
 *      new factors.
 *   3. THE ARTIFACT CANNOT LIE. data/weekly_backtest.json must carry the exact
 *      contract other agents code against, its verdict must follow from its own
 *      pooled numbers, a fresh recompute must reproduce its pooled block, and
 *      `--gate` must exit 0 on the committed fixtures.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/backtest_player.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = resolve(REPO_ROOT, 'data/weekly_backtest.json');
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const PRELUDE = `
import json
from scripts import build_weekly as bw
sched_by_team, elos, sched = bw._fixture()
dvp_fx, env_fx, fc_fx = bw._fixture_feeds()
flat_elo = {"SFX": 1500.0, "DAL": 1500.0, "GBX": 1500.0}
def fx():
    return bw.build_factors(2026, dvp_fx, env_fx, fc_fx)
def pts(rows):
    return [w["pts"] for w in rows if not w["bye"]]
`;

// ---------------------------------------------------------------------------
// 1. Elo tilt: QB only.
// ---------------------------------------------------------------------------

test('the Elo tilt moves a QB week and leaves RB/WR/TE weeks untouched', () => {
  const r = runPy(`${PRELUDE}
out = {}
for pos in ("QB", "RB", "WR", "TE"):
    hot = pts(bw.player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None, position=pos, factors=fx()))
    cold = pts(bw.player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position=pos, factors=fx()))
    out[pos] = max(abs(a - b) for a, b in zip(hot, cold))
out["tilt_1580_1470"] = bw.tilt_factor(1580.0, 1470.0)
out["tilt_max"] = bw.tilt_factor(2000.0, 1000.0)
out["tilt_min"] = bw.tilt_factor(1000.0, 2000.0)
out["tilt_positions"] = list(bw.ELO_TILT_POSITIONS)
print(json.dumps(out))`);
  assert.ok(r.QB > 1e-6, 'a QB week must move with Elo');
  for (const pos of ['RB', 'WR', 'TE']) {
    assert.ok(r[pos] < 1e-9, `${pos} weeks must be unchanged by Elo (got ${r[pos]})`);
  }
  assert.ok(Math.abs(r.tilt_1580_1470 - (1 + 0.5 * 110 / 400)) < 1e-12);
  assert.equal(r.tilt_max, 1.25);
  assert.equal(r.tilt_min, 0.75);
  assert.deepEqual(r.tilt_positions, ['QB']);
});

// ---------------------------------------------------------------------------
// 2. Weather: every multiplier, retractable and no-forecast neutrality.
// ---------------------------------------------------------------------------

test('weather multipliers and their neutral rules', () => {
  const r = runPy(`${PRELUDE}
W = bw.weather_factor
print(json.dumps({
  "qb_dome": W("QB", "dome"), "wr_closed": W("WR", "closed"),
  "te_out_mild": W("TE", "outdoors", 10.0, 5.0),
  "qb_open_cold": W("QB", "open", 0.0, 5.0), "qb_out_just_warm": W("QB", "outdoors", 0.1, 5.0),
  "qb_out_no_forecast": W("QB", "outdoors"), "qb_retractable": W("QB", "retractable", -10.0, 40.0),
  "qb_unknown_roof": W("QB", None, -10.0, 40.0),
  "rb_windy": W("RB", "outdoors", -10.0, 24.0), "rb_calm": W("RB", "outdoors", -10.0, 23.9),
  "rb_no_forecast": W("RB", "outdoors"), "rb_dome_windy": W("RB", "dome", 0.0, 50.0),
  "rb_retractable": W("RB", "retractable", 0.0, 50.0),
  "k_out": W("K", "outdoors", -10.0, 40.0),
  "table": bw.WEATHER,
}))`);
  assert.deepEqual(r.qb_dome, [1.03, false]);
  assert.deepEqual(r.wr_closed, [1.03, false]);
  assert.deepEqual(r.te_out_mild, [0.97, false]);
  assert.ok(Math.abs(r.qb_open_cold[0] - 0.97 * 0.97) < 1e-12 && r.qb_open_cold[1] === false);
  assert.deepEqual(r.qb_out_just_warm, [0.97, false]);
  assert.deepEqual(r.qb_out_no_forecast, [0.97, true], 'no forecast: roof-only, counted');
  assert.deepEqual(r.qb_retractable, [1.0, false], 'retractable is neutral at forecast time');
  assert.deepEqual(r.qb_unknown_roof, [1.0, false]);
  assert.deepEqual(r.rb_windy, [0.95, false]);
  assert.deepEqual(r.rb_calm, [1.0, false]);
  assert.deepEqual(r.rb_no_forecast, [1.0, true]);
  assert.deepEqual(r.rb_dome_windy, [1.0, false]);
  assert.deepEqual(r.rb_retractable, [1.0, false]);
  assert.deepEqual(r.k_out, [1.0, false], 'an unknown position claims nothing');
  assert.deepEqual(r.table, {
    pass_dome: 1.03, pass_outdoors: 0.97, pass_cold_extra: 0.97, rb_wind: 0.95,
    cold_c: 0.0, wind_kph: 24.0,
  });
});

// ---------------------------------------------------------------------------
// 3. Venue: rel clamp, flat fallbacks.
// ---------------------------------------------------------------------------

test('venue rel is clamped to [-1.0, 2.5] and falls flat on lam <= 0.3, low_n, or a missing venue', () => {
  const r = runPy(`${PRELUDE}
rel, lam = bw.venue_rel_table(env_fx["venue_hfa"])
wide, _ = bw.venue_rel_table({"A": {"games": 10, "avg_home_margin": 40.0},
                              "B": {"games": 10, "avg_home_margin": -30.0}})
tiny, lam_tiny = bw.venue_rel_table({"A": {"games": 10, "avg_home_margin": 0.3},
                                     "B": {"games": 10, "avg_home_margin": 0.3}})
f = fx()
bw.player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR", factors=f)
print(json.dumps({
  "lam": lam, "rel": rel, "wide": wide, "tiny": tiny, "lam_tiny": lam_tiny,
  "none": bw.venue_rel_table(None),
  "home_15": bw.venue_factor(1.5, True), "away_15": bw.venue_factor(1.5, False),
  "home_flat": bw.venue_factor(1.0, True), "away_flat": bw.venue_factor(1.0, False),
  "flat_weeks": f["counts"]["venue_flat_weeks"],
  "clamp": list(bw.VENUE_REL_CLAMP), "lam_min": bw.VENUE_LAM_MIN,
}))`);
  assert.ok(Math.abs(r.lam - 4.0) < 1e-9);
  assert.ok(Math.abs(r.rel.SFX - 1.5) < 1e-9 && Math.abs(r.rel.DAL - 0.5) < 1e-9);
  assert.ok(!('GBX' in r.rel), 'a low_n venue is not in the table (flat at the caller)');
  assert.equal(r.wide.A, 2.5);
  assert.equal(r.wide.B, -1.0);
  assert.deepEqual(r.tiny, {}, 'lam <= 0.3 -> every venue flat');
  assert.ok(r.lam_tiny <= 0.3);
  assert.deepEqual(r.none, [{}, 0.0]);
  assert.ok(Math.abs(r.home_15 - 1.03) < 1e-12 && Math.abs(r.away_15 - 0.97) < 1e-12);
  assert.ok(Math.abs(r.home_flat - 1.02) < 1e-12 && Math.abs(r.away_flat - 0.98) < 1e-12,
    'rel = 1.0 is exactly the old flat +/-0.02');
  assert.equal(r.flat_weeks, 1, 'the one @GBX (low_n) week is counted flat');
  assert.deepEqual(r.clamp, [-1.0, 2.5]);
  assert.equal(r.lam_min, 0.3);
});

// ---------------------------------------------------------------------------
// 4. DvP: half-weight prior blend, shrink 0.25, clamp, LA -> LAR, neutral.
// ---------------------------------------------------------------------------

test('DvP blends the prior season at half weight with weeks < wk and shrinks by 0.25', () => {
  const r = runPy(`${PRELUDE}
r1 = bw.dvp_rates(dvp_fx, 2026, 1)
r2 = bw.dvp_rates(dvp_fx, 2026, 2)
f = fx()
sched_n = bw.team_schedule(sched + [{"week": 7, "home": "SFX", "away": "ZZZ"}])
bw.player_weeks(200.0, "SFX", sched_n, flat_elo, round_dp=None, position="WR", factors=f)
print(json.dumps({
  "wk1_dal_qb": r1["DAL"]["QB"], "wk1_sfx_qb": r1["SFX"]["QB"],
  "wk2_dal_qb": r2["DAL"]["QB"],
  "d_15": bw.dvp_factor(1.5), "d_05": bw.dvp_factor(0.5), "d_hi": bw.dvp_factor(3.0), "d_lo": bw.dvp_factor(-2.0),
  "la": bw.dvp_rates({"seasons": {"2025": {"LA": {"1": {"def": {"QB": 5.0}, "g": 1}}}}, "renames": {"LA": "LAR"}}, 2026, 3),
  "empty": bw.dvp_rates({"seasons": {}}, 2026, 1),
  "neutral": f["counts"]["dvp_neutral_weeks"], "shrink": bw.DVP_SHRINK,
  "prior_weight": bw.DVP_PRIOR_WEIGHT,
}))`);
  // prior QB allowed per game: DAL 30 / SFX 10 / GBX 20 -> league 20
  assert.ok(Math.abs(r.wk1_dal_qb - 1.5) < 1e-9 && Math.abs(r.wk1_sfx_qb - 0.5) < 1e-9);
  // week 2: DAL (0.5*60 + 60) / (0.5*2 + 1) = 45; SFX 10; GBX 20 -> league 25
  assert.ok(Math.abs(r.wk2_dal_qb - 45 / 25) < 1e-9, `blend at week 2: ${r.wk2_dal_qb}`);
  assert.ok(Math.abs(r.d_15 - 1.125) < 1e-12 && Math.abs(r.d_05 - 0.875) < 1e-12);
  assert.equal(r.d_hi, 1.25);
  assert.equal(r.d_lo, 0.75);
  assert.deepEqual(r.la, { LAR: { QB: 1.0 } }, 'the feed spelling LA reads as LAR');
  assert.deepEqual(r.empty, {});
  assert.equal(r.neutral, 1, 'an opponent absent from the feed is neutral and counted');
  assert.equal(r.shrink, 0.25);
  assert.equal(r.prior_weight, 0.5);
});

// ---------------------------------------------------------------------------
// 5. Model meta: name, keys, neutral counts.
// ---------------------------------------------------------------------------

test('the document meta names weekly_split_v2 and carries the v2 keys + neutral counts', () => {
  const r = runPy(`${PRELUDE}
proj = [{"gsis_id": "p1", "name": "QB Guy", "team": "SFX", "position": "QB", "proj_points": 300.0},
        {"gsis_id": "p2", "name": "RB Guy", "team": "DAL", "position": "RB", "proj_points": 150.0}]
doc = bw.build_weekly_document(proj, sched, elos, {}, 2026, "2026-09-02T00:00:00Z", injuries=[], factors=fx())
m = doc["model"]
print(json.dumps({"model": m, "row_keys": [sorted(w) for w in doc["players"][0]["weeks"]],
                  "order": [p["gsis_id"] for p in doc["players"]],
                  "sum_p1": sum(w["pts"] for w in doc["players"][0]["weeks"]),
                  "sum_p2": sum(w["pts"] for w in doc["players"][1]["weeks"])}))`);
  const m = r.model;
  assert.equal(m.name, 'weekly_split_v2');
  assert.equal(m.tilt_coef, 0.5);
  assert.equal(m.home_coef, 0.02);
  assert.equal(m.estimate, true);
  assert.equal(typeof m.notes, 'string');
  assert.equal(m.dvp_shrink, 0.25);
  assert.deepEqual(m.elo_tilt_positions, ['QB']);
  assert.deepEqual(m.venue, { coef: 0.02, rel_clamp: [-1.0, 2.5] });
  assert.equal(m.weather.pass_dome, 1.03);
  assert.equal(m.backtest, 'data/weekly_backtest.json');
  assert.deepEqual(Object.keys(m.neutral_counts).sort(),
    ['dvp_neutral_weeks', 'venue_flat_weeks', 'weather_no_forecast_weeks']);
  // SFX (5 games) visits the low_n GBX venue once (wk 5); DAL never does. The
  // open-roof SFX home weeks without a forecast row are counted, never guessed.
  assert.equal(m.neutral_counts.venue_flat_weeks, 1);
  assert.equal(m.neutral_counts.dvp_neutral_weeks, 0);
  assert.ok(m.neutral_counts.weather_no_forecast_weeks >= 1);
  assert.ok(!('injury_shape' in m) && !('availability' in m));
  for (const keys of r.row_keys) {
    assert.deepEqual(keys, ['bye', 'home', 'opp', 'pts', 'wk']);
  }
  assert.deepEqual(r.order, ['p1', 'p2']);
  assert.ok(Math.abs(r.sum_p1 - 300.0) < 0.05 && Math.abs(r.sum_p2 - 150.0) < 0.05);
});

// ---------------------------------------------------------------------------
// 6. The renormalization invariant survives v2.
// ---------------------------------------------------------------------------

test('non-bye playable weeks still sum exactly to the season target under v2', () => {
  const r = runPy(`${PRELUDE}
out = []
for pos in ("QB", "RB", "WR", "TE"):
    for target in (200.0, 33.3, 0.0):
        rows = bw.player_weeks(target, "SFX", sched_by_team, elos, round_dp=None, position=pos, factors=fx())
        out.append({"pos": pos, "target": target, "sum": sum(pts(rows)),
                    "bye_zero": all(w["pts"] == 0.0 for w in rows if w["bye"]), "n": len(rows)})
blocked = bw.player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None, position="QB",
                          unavailable_weeks=2, injury_mult=0.55, factors=fx())
in_total = bw.player_weeks(130.0, "SFX", sched_by_team, elos, round_dp=None, position="WR",
                           unavailable_weeks=2, absence_in_total=True, factors=fx())
print(json.dumps({"cases": out,
  "blocked_sum": sum(pts(blocked)), "blocked_weeks": [w["wk"] for w in blocked if w.get("avail") is False],
  "in_total_sum": sum(pts(in_total))}))`);
  for (const c of r.cases) {
    assert.ok(Math.abs(c.sum - c.target) < 1e-6, `${c.pos} ${c.target}: got ${c.sum}`);
    assert.equal(c.bye_zero, true);
    assert.equal(c.n, 18);
  }
  assert.ok(Math.abs(r.blocked_sum - 200.0 * 3 / 5) < 1e-9, 'pro-rata target with mechanic (b)');
  assert.deepEqual(r.blocked_weeks, [1, 3]);
  assert.ok(Math.abs(r.in_total_sum - 130.0) < 1e-6, 'absence_in_total renormalizes to the full number');
});

// ---------------------------------------------------------------------------
// 7. The committed artifact: contract, verdict, reproducibility, gate.
// ---------------------------------------------------------------------------

test('data/weekly_backtest.json is committed and carries the exact contract', () => {
  assert.ok(existsSync(ARTIFACT), 'data/weekly_backtest.json must be committed');
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  assert.equal(typeof a.generated_utc, 'string');
  assert.equal(a.model_candidate, 'weekly_split_v2');
  assert.equal(a.model_incumbent, 'weekly_split_v1');
  assert.deepEqual(a.fixture.weekly_actuals, 'data/fixtures/backtest_weekly/weekly_actuals.json');
  assert.deepEqual(a.fixture.games_meta, 'data/fixtures/backtest_weekly/games_meta.json');
  assert.deepEqual(a.fixture.seasons_scored, [2023, 2024, 2025]);
  assert.ok(Number.isInteger(a.fixture.rows) && a.fixture.rows > 1000);
  assert.deepEqual(a.fixture.pool, { QB: 32, RB: 60, WR: 80, TE: 32 });
  assert.equal(typeof a.season_number_rule, 'string');
  for (const blockName of ['pooled', 'held_out_2025']) {
    for (const v of ['v1', 'v2']) {
      for (const k of ['mae', 'rank_corr', 'topk']) {
        assert.equal(typeof a[blockName][v][k], 'number', `${blockName}.${v}.${k}`);
      }
    }
  }
  for (const pos of POSITIONS) {
    for (const v of ['v1', 'v2']) {
      assert.equal(typeof a.per_position[pos][v].mae, 'number');
      assert.equal(typeof a.per_position[pos][v].rank_corr, 'number');
    }
  }
  assert.equal(typeof a.band.rule, 'string');
  for (const v of ['v1', 'v2']) {
    assert.equal(typeof a.band[v].coverage_2025, 'number');
    assert.equal(typeof a.band[v].half_width_2025, 'number');
    assert.ok(a.band[v].coverage_2025 > 0.5 && a.band[v].coverage_2025 < 0.85,
      'a 68% band should cover roughly 68% out of sample');
  }
  const bs = a.bootstrap.delta_mae_2025;
  assert.equal(typeof bs.mean, 'number');
  assert.ok(bs.lo95 <= bs.mean && bs.mean <= bs.hi95);
  assert.equal(bs.blocks, 'season-week');
  assert.equal(bs.B, 400);
  assert.deepEqual(a.factors, {
    dvp: { shrink: 0.25, source: 'data/dvp_positional_history.json' },
    elo_tilt_positions: ['QB'],
    weather: { pass_dome: 1.03, pass_outdoors: 0.97, pass_cold_extra: 0.97, rb_wind: 0.95, cold_f: 32, wind_mph: 15 },
    venue: { coef: 0.02, rel_clamp: [-1.0, 2.5], shrink_n0: 16 },
  });
  assert.equal(a.verdict.rule,
    'never-regress: v2 must not be worse than v1 on pooled MAE and pooled rank_corr');
  assert.equal(typeof a.verdict.reason, 'string');
  assert.equal(typeof a.policy, 'string');
  // The verdict follows from the artifact's own numbers, and it is adopted.
  const follows = a.pooled.v2.mae <= a.pooled.v1.mae
    && a.pooled.v2.rank_corr >= a.pooled.v1.rank_corr;
  assert.equal(a.verdict.adopted, follows, 'verdict.adopted must follow from pooled');
  assert.equal(a.verdict.adopted, true);
  // Skips are counted, never hidden (owner policy).
  assert.equal(typeof a.meta.rows_skipped.team_mismatch, 'number');
  assert.equal(typeof a.meta.pool_excluded['prior_games_lt_6'], 'number');
});

test('a fresh recompute reproduces the committed pooled block and the gate exits 0', () => {
  const fresh = runPy(`
import json
from scripts import backtest_weekly as bt, build_weekly as bw
res = bt.run(bt._load(bt.ACTUALS_PATH), bt._load(bt.GAMES_PATH), bt._load(bw.DVP_PATH), bt._load(bt.TUNING_PATH))
art = bt.artifact(res)
print(json.dumps({"pooled": art["pooled"], "held": art["held_out_2025"], "adopted": art["verdict"]["adopted"], "rows": art["fixture"]["rows"]}))`);
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(fresh.pooled, a.pooled, 'the committed pooled block is stale or edited');
  assert.deepEqual(fresh.held, a.held_out_2025);
  assert.equal(fresh.rows, a.fixture.rows);
  assert.equal(fresh.adopted, true);

  const gate = spawnSync('python3', ['scripts/backtest_weekly.py', '--gate'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  assert.equal(gate.status, 0, `--gate must exit 0 on the committed fixtures:\n${gate.stdout}\n${gate.stderr}`);
  assert.match(gate.stdout, /GATE: PASS/);
});

test('the three R51 selftests exit 0 offline', () => {
  for (const script of ['scripts/build_weekly.py', 'scripts/backtest_weekly.py',
    'scripts/build_backtest_weekly_corpus.py']) {
    const r = spawnSync('python3', [script, '--selftest'], {
      cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    });
    assert.equal(r.status, 0, `${script} --selftest failed:\n${r.stdout}\n${r.stderr}`);
  }
});
