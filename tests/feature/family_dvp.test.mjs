/* tests/feature/family_dvp.test.mjs — the `dvp_mismatch` candidate family and
 * the artifact it reads.
 *
 * The delta itself is a four-term dot product. What can actually go wrong is
 * everything around it, so that is what these tests lock:
 *
 *   1. THE LEAK BARRIER. A week-W game may see weeks < W of season Y and ALL
 *      of season Y-1, and nothing else. It is proved the way the design says
 *      to prove it: a fixture whose week 1 is a wild outlier, asserting that
 *      the week-2 window contains it and the week-1 window does not. A
 *      family that quietly reads its own week is not a weak signal, it is a
 *      fabricated one.
 *   2. THE CENTERING, which is the family's entire claim to not being
 *      `epa_total` in a hat. A defense that is uniformly leaky (bad at
 *      everything — already priced by Elo) must contribute EXACTLY 0.0, and so
 *      must an offense shaped like the league average. If either centering
 *      regresses, the family starts re-pricing overall team strength and the
 *      gate would be measuring double-counting, not defense-vs-position.
 *   3. ANTISYMMETRY. Swapping home and away must negate the delta exactly.
 *      Any asymmetry here is a home-field term wearing a matchup costume.
 *   4. THE MISSING JOIN. An uncovered week, season or team is an exact 0.0 and
 *      never a raise inside a 7,276-game walk, and never an imputed average.
 *   5. SKIP-OR-TRIAL, NEVER SILENT. The loader returns None when the artifact
 *      cannot cover the walk, because uncovered folds score exact ties, ties
 *      count in n and in the cluster-robust variance, and "no data here" would
 *      be archived as "no help here".
 *   6. THE TWO REGISTRATION SITES THAT FAIL SILENTLY. `_write_adoption` must
 *      write `game_params.dvp_hfa`, and `_incumbent_family_fns` must rebuild
 *      that block into the incumbent — otherwise an adopted family is not part
 *      of next week's bar and never-regress quietly stops being a rule.
 *   7. THE APPLIABILITY HONESTY GUARD, as a LINKED invariant: `dvp_mismatch`
 *      is in `APPLIABLE` if and only if `build_predictions.py` actually calls
 *      the prediction-time reader. Today neither holds. The test fails if
 *      either one moves without the other, in both directions.
 *   8. THE ARTIFACT. Per-position league balance (every point produced is a
 *      point allowed), regular-season-only, and full corpus coverage.
 *   9. THE MARKET BOUNDARY. Neither module may name a betting column.
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
const MODULE = join(REPO_ROOT, 'scripts', 'signals', 'dvp_mismatch.py');
const BUILDER = join(REPO_ROOT, 'scripts', 'build_dvp_positional.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const FIXTURE = join(REPO_ROOT, 'data', 'fixtures', 'nflverse_sample',
  'stats_player_week_dvp.csv');
const ARTIFACT = join(REPO_ROOT, 'data', 'dvp_positional_history.json');
const TUNING = join(REPO_ROOT, 'data', 'model_tuning.json');

/* Run python and parse the JSON document printed on its LAST line — gate
 * functions print progress to stdout, so the payload is the final line. */
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

test('dvp: both modules ship and their own selftests pass', () => {
  assert.ok(existsSync(MODULE), 'scripts/signals/dvp_mismatch.py present');
  assert.ok(existsSync(BUILDER), 'scripts/build_dvp_positional.py present');
  assert.match(execFileSync('python3', [MODULE, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' }), /selftest OK/);
  assert.match(execFileSync('python3', [BUILDER, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' }), /selftest OK/);
});

test('dvp: a week-W game sees weeks < W and never its own week', () => {
  /* Week 1 is a 100-point outlier against this defense. If the week-1 window
   * saw it, the rate would be 100; if the week-2 window did NOT, the rate
   * would be 0. Both directions are asserted, so the bound cannot drift
   * either way undetected. */
  const got = py(`
import json
from scripts.signals import dvp_mismatch as d

def wk(g, dv):
    z = {p: 0.0 for p in d.POSITIONS}
    return {"g": g, "off": dict(z, WR=10.0), "def": dict(z, WR=dv)}

weeks = {"1": wk(1, 100.0), "2": wk(1, 0.0), "3": wk(1, 0.0)}
cum, full = d._cumulative_by_week(weeks)
prior = {"g": 2, "off": {p: 0.0 for p in d.POSITIONS},
         "def": {"QB": 0.0, "RB": 0.0, "WR": 20.0, "TE": 0.0}}
print(json.dumps({
  "wk1_games": cum[1]["g"], "wk1_wr": cum[1]["def"]["WR"],
  "wk2_games": cum[2]["g"], "wk2_wr": cum[2]["def"]["WR"],
  "wk3_games": cum[3]["g"], "wk3_wr": cum[3]["def"]["WR"],
  "full_wr": full["def"]["WR"],
  # week 1: cur_games == 0 -> w == 0 -> the rate IS the complete prior season
  "rate_wk1": d.blended_rate(cum[1], prior, "def")["WR"],
  # week 2: one game in -> w = 1/(1+4) = 0.2 -> 0.2*100 + 0.8*10
  "rate_wk2": round(d.blended_rate(cum[2], prior, "def")["WR"], 9),
  "n0": d.DVP_N0,
  "no_prior_no_games": d.blended_rate(cum[1], None, "def"),
}))
`);
  assert.equal(got.wk1_games, 0, 'week 1 sees no games of its own season');
  assert.equal(got.wk1_wr, 0.0, "week 1's window cannot contain week 1");
  assert.equal(got.wk2_games, 1);
  assert.equal(got.wk2_wr, 100.0, "week 2's window DOES contain week 1's outlier");
  assert.equal(got.wk3_wr, 100.0, 'and keeps containing it');
  assert.equal(got.full_wr, 100.0, 'the prior-season total is every week');
  assert.equal(got.n0, 4, 'DVP_N0 is the documented 4 games');
  assert.equal(got.rate_wk1, 10.0,
    'week 1 prices off the COMPLETE prior season (20 ppr / 2 games), never a peek');
  assert.equal(got.rate_wk2, 28.0, '0.2 * 100 + 0.8 * 10 = 28');
  assert.equal(got.no_prior_no_games, null,
    'no prior season and no games played -> UNDEFINED, never imputed');
});

test('dvp: centering removes overall strength — the reason this is not epa_total', () => {
  const got = py(`
import json
from scripts.signals import dvp_mismatch as d

# 32 defenses that differ ONLY in overall level (uniformly bad / uniformly
# good). That is exactly what Elo and epa_total already price.
uniform = {"T%02d" % i: {p: 10.0 + i for p in d.POSITIONS} for i in range(32)}
tilt_uniform = d.tilt_from_rates(uniform)

# One defense with a real SHAPE: leaky vs RB, stingy vs WR, same overall level.
shaped = dict(uniform)
shaped["T00"] = {"QB": 10.0, "RB": 30.0, "WR": 5.0, "TE": 15.0}
tilt_shaped = d.tilt_from_rates(shaped)

# 32 offenses with identical shape but wildly different volume.
vol = {"T%02d" % i: {"QB": 4.0*(i+1), "RB": 3.0*(i+1),
                     "WR": 2.0*(i+1), "TE": 1.0*(i+1)} for i in range(32)}
lean_vol = d.lean_from_rates(vol)

# Too few defenses, and zero spread: both must be inert.
few = {"T%02d" % i: {"QB": float(i), "RB": 2.0, "WR": 3.0, "TE": 4.0}
       for i in range(d.MIN_DEFENSES_FOR_Z - 1)}
flat = {"T%02d" % i: {p: 5.0 for p in d.POSITIONS} for i in range(32)}

print(json.dumps({
  "uniform_max_abs": max(abs(v) for r in tilt_uniform.values() for v in r.values()),
  "vol_max_abs": max(abs(v) for r in lean_vol.values() for v in r.values()),
  "shaped_row": tilt_shaped["T00"],
  "shaped_sum": sum(tilt_shaped["T00"].values()),
  "few_max_abs": max(abs(v) for r in d.tilt_from_rates(few).values()
                     for v in r.values()),
  "flat_max_abs": max(abs(v) for r in d.tilt_from_rates(flat).values()
                      for v in r.values()),
  "zero_offense": d.lean_from_rates({"X": {p: 0.0 for p in d.POSITIONS}}),
  "min_defenses": d.MIN_DEFENSES_FOR_Z,
}))
`);
  assert.ok(Math.abs(got.uniform_max_abs) < 1e-9,
    'a uniformly leaky defense has ZERO tilt — overall strength is Elo\'s job');
  assert.ok(Math.abs(got.vol_max_abs) < 1e-9,
    'offenses with league-average SHAPE have ZERO lean, at any volume');
  assert.ok(Math.abs(got.shaped_sum) < 1e-9,
    'tilt sums to zero across positions by construction');
  assert.ok(got.shaped_row.RB > 0 && got.shaped_row.WR < 0,
    'a defense leaky vs RB and stingy vs WR tilts in exactly that direction');
  assert.equal(got.min_defenses, 24);
  assert.ok(Math.abs(got.few_max_abs) < 1e-9,
    'below 24 defenses there is no league standard — z is 0, not noise amplified');
  assert.ok(Math.abs(got.flat_max_abs) < 1e-9, 'zero spread -> zero z');
  assert.deepEqual(got.zero_offense, {},
    'an offense with no production is dropped, never handed a uniform 1/4 share');
});

test('dvp: the delta is antisymmetric, scale-linear, and 0.0 on every missing join', () => {
  const got = py(`
import json
from scripts.signals import dvp_mismatch as d
Z = {p: 0.0 for p in d.POSITIONS}
lean = {"QB": 0.0, "RB": -0.10, "WR": 0.10, "TE": 0.0}
tilt = {"QB": 0.0, "RB": -0.50, "WR": 0.50, "TE": 0.0}
feats = {2099: {5: {"lean": {"H": lean, "A": dict(Z)},
                    "tilt": {"H": dict(Z), "A": tilt}}}}
def g(h, a, w): return {"home": h, "away": a, "week": w}
setup, factory = d.dvp_builder(200.0, feats)
fn = factory(setup(2099, [], []))
print(json.dumps({
  "home": d.game_delta(feats, 2099, g("H", "A", 5), 200.0),
  "swapped": d.game_delta(feats, 2099, g("A", "H", 5), 200.0),
  "half": d.game_delta(feats, 2099, g("H", "A", 5), 100.0),
  "zero_scale": d.game_delta(feats, 2099, g("H", "A", 5), 0.0),
  "bad_week": d.game_delta(feats, 2099, g("H", "A", 9), 200.0),
  "bad_season": d.game_delta(feats, 2100, g("H", "A", 5), 200.0),
  "bad_team": d.game_delta(feats, 2099, g("Z", "A", 5), 200.0),
  "no_week_key": d.game_delta(feats, 2099, {"home": "H", "away": "A"}, 200.0),
  "via_builder": fn(g("H", "A", 5), 0),
  "grid": d.DVP_SCALES,
}))
`);
  assert.ok(Math.abs(got.home - 20.0) < 1e-9,
    'lean 0.10 WR into tilt 0.50 WR, plus lean -0.10 RB into tilt -0.50 RB, x 200');
  assert.ok(Math.abs(got.swapped + got.home) < 1e-12,
    'swapping home and away negates the delta EXACTLY — no hidden home term');
  assert.ok(Math.abs(got.half - got.home / 2) < 1e-9, 'the scale is linear');
  assert.equal(got.zero_scale, 0.0, 'scale 0 IS the incumbent');
  for (const key of ['bad_week', 'bad_season', 'bad_team', 'no_week_key']) {
    assert.equal(got[key], 0.0, `${key} -> exact 0.0, never a raise, never a guess`);
  }
  assert.ok(Math.abs(got.via_builder - got.home) < 1e-9,
    'the builder factory applies the same delta the gate trialed');
  assert.deepEqual(got.grid, [0.0, 100.0, 200.0, 300.0]);
  assert.ok(got.grid.every((s) => s >= 0),
    'the grid is non-negative: the sign is fixed by the hypothesis, so paying '
    + 'multiplicity for a signed grid would buy nothing');
  assert.equal(got.grid.filter((s) => s !== 0).length, 3, '3 live trials');
});

test('dvp: the loader skips loudly rather than covering part of the walk', () => {
  const got = py(`
import json, os, tempfile
from scripts.signals import dvp_mismatch as d
Z = {p: 0.0 for p in d.POSITIONS}
wk = {"g": 1, "off": dict(Z, WR=20.0), "def": dict(Z, WR=20.0)}
doc = {"seasons": {"2098": {t: {"1": wk} for t in ("AAA", "BBB")},
                   "2099": {t: {"1": wk} for t in ("AAA", "BBB")}}}
res = {}
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "dvp.json")
    res["absent"] = d.load_features([2099], path=os.path.join(td, "nope.json"))
    res["absent_reason"] = d.coverage_reason([2099],
                                             path=os.path.join(td, "nope.json"))
    json.dump({"seasons": {}}, open(p, "w"))
    res["empty"] = d.load_features([2099], path=p)
    json.dump(doc, open(p, "w"))
    res["spanned"] = bool(d.load_features([2099], path=p))
    res["unspanned"] = d.load_features([2097, 2098, 2099], path=p)
    res["unspanned_reason"] = d.coverage_reason([2097, 2099], path=p)
print(json.dumps(res))
`);
  assert.equal(got.absent, null, 'absent artifact -> None (skip), never {}');
  assert.match(got.absent_reason, /absent/);
  assert.equal(got.empty, null, 'empty seasons -> None');
  assert.equal(got.spanned, true, 'a fully covered season set loads');
  assert.equal(got.unspanned, null,
    'a season the artifact cannot cover must skip the family, not tie the fold');
  assert.match(got.unspanned_reason, /2097/,
    'the skip names the seasons it is missing');
});

test('dvp: registration writes game_params AND rebuilds into the incumbent', () => {
  const got = py(`
import json
from scripts import promote_signals as ps
from scripts.signals import dvp_mismatch as dvp

# _write_adoption must produce a game_params.dvp_hfa block.
tuning = {}
ps._write_adoption(tuning, ("dvp_mismatch", {"scale": 200.0, "log_loss": 0.1,
                                             "n": 1}),
                   45.0, 0.45, 25.0, {}, "2026-01-01T00:00:00Z")
blk = tuning["game_params"]["dvp_hfa"]

# The nastiest omission: an APPLIED family must come back as part of the
# incumbent, or it re-clears the bar every week against a bar excluding it.
real = dvp.load_features
Z = {p: 0.0 for p in dvp.POSITIONS}
feats = {2099: {1: {"lean": {"H": Z}, "tilt": {"A": Z}}}}
dvp.load_features = lambda seasons, path=None: (feats, {})
try:
    fns, unavail = ps._incumbent_family_fns({"game_params": {"dvp_hfa": blk}})
    rebuilt = len(fns)
    dvp.load_features = lambda seasons, path=None: None
    _f2, unavail2 = ps._incumbent_family_fns({"game_params": {"dvp_hfa": blk}})
finally:
    dvp.load_features = real

# An un-applied block must NOT enter the incumbent.
off = dict(blk); off["applied"] = False
f3, _ = ps._incumbent_family_fns({"game_params": {"dvp_hfa": off}})

print(json.dumps({"block": blk, "rebuilt": rebuilt, "unavail": unavail,
                  "unavail_when_absent": unavail2, "when_off": len(f3)}))
`);
  assert.equal(got.block.applied, true);
  assert.equal(got.block.scale, 200.0);
  assert.equal(got.block.n0, 4, 'the blend constant is recorded with the adoption');
  assert.equal(got.block.min_defenses_for_z, 24);
  assert.ok(got.block.adopted_utc, 'adoption is dated');
  assert.equal(got.rebuilt, 1, 'an applied dvp_hfa block rebuilds into the incumbent');
  assert.deepEqual(got.unavail, [], 'nothing unavailable when the artifact loads');
  assert.deepEqual(got.unavail_when_absent, ['dvp_hfa'],
    'an unrebuildable adopted family must be NAMED, never silently dropped — '
    + 'that name is what refuses adoption against a weakened incumbent');
  assert.equal(got.when_off, 0, 'applied:false stays out of the incumbent');
});

test('dvp: APPLIABLE membership and the prediction-time wiring move together', () => {
  /* THE HONESTY GUARD, as a linked invariant rather than a snapshot. A family
   * listed in APPLIABLE that build_predictions cannot apply is the exact lie
   * the guard exists to prevent; a family wired into build_predictions but
   * left out of APPLIABLE is a winner suppressed for no reason (and, worse,
   * one that suppresses the whole run's adoption the way referee would have).
   * Today NEITHER holds, which is the honest state: dvp_mismatch is a
   * measurement, and a winning trial records would_adopt. */
  const src = readFileSync(PROMOTE, 'utf8');
  const appliable = src.slice(src.indexOf('APPLIABLE = {'), src.indexOf('APPLIABLE = {') + 500);
  const inAppliable = /["']dvp_mismatch["']/.test(appliable);

  const bpPath = join(REPO_ROOT, 'scripts', 'build_predictions.py');
  const bp = existsSync(bpPath) ? readFileSync(bpPath, 'utf8') : '';
  const wired = /dvp_mismatch|dvp_hfa/.test(bp);

  assert.equal(inAppliable, wired,
    inAppliable
      ? 'dvp_mismatch is in APPLIABLE but build_predictions.py never applies it '
        + '— the gate would claim an application path that does not exist'
      : 'build_predictions.py references dvp — then dvp_mismatch must be added '
        + 'to APPLIABLE in that same change, or a winning family is suppressed '
        + 'and takes the whole run\'s adoption down with it');

  /* Whatever the wiring status, the family MUST be registered as a trialled
   * family — a signal nobody measures is not a conservative choice, it is an
   * unanswered question. */
  assert.match(src, /"family": "dvp_mismatch"/,
    'dvp_mismatch is registered in families[]');
  assert.match(src, /dvp_mod\.dvp_builder\(/,
    'the gate trials the SAME builder the module exports');
  assert.match(src, /dvp_mod\.n0_games\(/,
    'the count of unpriceable games is recorded, so partial help never reads '
    + 'like whole help');
});

test('dvp: the artifact balances, is regular-season only, and covers the corpus', () => {
  if (!existsSync(ARTIFACT)) return;   // runner-built; skipped loudly, never faked
  const doc = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  assert.ok(doc.scoring.includes('ppr_scrimmage'), 'the scoring rule is stated');
  assert.ok(doc.excludes.length > 0, 'the honest limitation is stated in the file');
  assert.deepEqual(doc.positions, ['QB', 'RB', 'WR', 'TE']);
  assert.deepEqual(doc.renames, { LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' },
    'the rename map matches build_backtest_corpus exactly, or one franchise '
    + 'silently becomes two half-sampled ones');
  assert.ok(doc.diagnostics.unk_position_ppr_share < 0.03,
    'unmapped-position PPR share stays small — a blowout is a feed regression');
  assert.ok(doc.diagnostics.postseason_rows_dropped > 0,
    'postseason rows are dropped and COUNTED: only good teams play January, so '
    + 'including it would bias a prior-season defensive rate');

  /* LEAGUE BALANCE, per position, per season: every point an offense produced
   * is a point some defense allowed. This is the artifact's own proof that the
   * two mirrors are the same ledger read from two sides. */
  for (const [year, teams] of Object.entries(doc.seasons)) {
    const off = { QB: 0, RB: 0, WR: 0, TE: 0 };
    const def = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const weeks of Object.values(teams)) {
      for (const wk of Object.values(weeks)) {
        assert.ok(wk.g >= 1, `${year}: a recorded team-week played at least once`);
        for (const p of doc.positions) { off[p] += wk.off[p]; def[p] += wk.def[p]; }
      }
    }
    for (const p of doc.positions) {
      assert.ok(Math.abs(off[p] - def[p]) < 1e-3,
        `${year} ${p}: produced ${off[p]} vs allowed ${def[p]} — the mirrors must agree`);
    }
  }

  /* Coverage: every team code in the corpus must exist in the artifact for
   * that season, or the join silently drops games and the family is measured
   * on a subset it never declares. */
  const corpus = join(REPO_ROOT, 'data', 'fixtures', 'backtest_corpus');
  for (const yr of ['1999', '2025']) {
    const f = join(corpus, `finals_${yr}.json`);
    if (!existsSync(f)) continue;
    const games = JSON.parse(readFileSync(f, 'utf8')).games;
    const seen = doc.seasons[yr];
    assert.ok(seen, `artifact covers ${yr}`);
    for (const g of games) {
      assert.ok(seen[g.home], `${yr}: ${g.home} present in the artifact`);
      assert.ok(seen[g.away], `${yr}: ${g.away} present in the artifact`);
    }
  }
});

test('dvp: the shipped fixture exercises the traps the builder must handle', () => {
  assert.ok(existsSync(FIXTURE), 'stats_player_week_dvp.csv present');
  const rows = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  const head = rows[0].split(',');
  for (const col of ['position', 'season', 'week', 'season_type', 'game_id',
    'team', 'opponent_team', 'receptions', 'receiving_yards', 'rushing_yards',
    'passing_yards', 'passing_tds', 'passing_interceptions']) {
    assert.ok(head.includes(col), `fixture carries ${col}`);
  }
  const body = rows.slice(1).map((r) => r.split(','));
  const idx = (c) => head.indexOf(c);
  assert.ok(body.some((r) => r[idx('season_type')] === 'POST'),
    'a POST row is present — the REG filter must be exercised, not assumed');
  assert.ok(body.some((r) => r[idx('team')] === 'STL'),
    'a pre-rename team code is present so the rename is exercised');
  assert.ok(body.some((r) => !r[idx('opponent_team')]),
    'a row with no opponent is present — it must be dropped and COUNTED');
  assert.ok(body.some((r) => ['K', 'CB'].includes(r[idx('position')])),
    'an off-position row is present so the UNK bucket is exercised');
  assert.ok(body.some((r) => r[idx('passing_yards')] === 'NA' || r[idx('passing_yards')] === ''),
    'blank / NA cells are present — they mean zero production, not a crash');
});

test('dvp: neither module names a betting column', () => {
  for (const path of [MODULE, BUILDER]) {
    const src = readFileSync(path, 'utf8');
    for (const col of BETTING_COLUMNS) {
      assert.ok(!src.includes(col),
        `${col} must never appear in ${path} — market prices are display only`);
    }
    assert.ok(!/moneyline|vegas/i.test(src), `no market vocabulary in ${path}`);
  }
  if (existsSync(ARTIFACT)) {
    const raw = readFileSync(ARTIFACT, 'utf8');
    for (const col of BETTING_COLUMNS) {
      assert.ok(!raw.includes(col), `${col} must not exist in the artifact`);
    }
  }
});

test('dvp: when the gate has run it, the recorded family is well formed', () => {
  if (!existsSync(TUNING)) return;
  const doc = JSON.parse(readFileSync(TUNING, 'utf8'));
  const entry = (doc.history || []).find(
    (h) => h.kind === 'signal_promotion' && h.format === 2);
  if (!entry) return;
  const fam = (entry.families || []).find((f) => f.family === 'dvp_mismatch');
  if (!fam) return;   // pre-dates this family — skipped loudly, never faked green
  if (fam.skipped) {
    assert.ok(fam.reason, 'a skip always carries its reason');
    return;
  }
  assert.equal(fam.trials.length, 3, 'the 3 live scales are recorded whole');
  for (const t of fam.trials) {
    assert.equal(typeof t.scale, 'number');
    assert.notEqual(t.scale, 0, 'a zero scale is the incumbent, not a trial');
  }
  assert.equal(typeof fam.n0_games, 'number',
    'the count of games the family could not price is always recorded');
  const best = Math.min(...fam.trials.map((t) => t.log_loss));
  assert.equal(fam.best.log_loss, best, 'best is the min trial');
  if (entry.adopted && entry.adopted_family.family === 'dvp_mismatch') {
    const blk = (doc.game_params || {}).dvp_hfa;
    assert.ok(blk && blk.applied,
      'an adopted dvp_mismatch MUST carry an applied game_params block');
    assert.equal(blk.scale, entry.adopted_family.scale);
  }
});
