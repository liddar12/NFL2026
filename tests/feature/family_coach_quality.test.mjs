/* tests/feature/family_coach_quality.test.mjs — the `coach_quality` gate family
 * (R22-F2): a head-coach effect priced as an Elo RESIDUAL.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these tests lock:
 *
 *   1. DOUBLE-COUNTING. Coach quality is already inside team Elo — good coaches
 *      win, wins raise the rating, the rating is the model's input. A build that
 *      rates coaches on anything the rating is itself fit on counts the coach
 *      twice and reports the accounting error as an improvement. The defence is
 *      that q is fit on `actual - expected_home(...)`, the rating's own forecast
 *      error, and is then DIFFERENCED across the two sidelines. Both properties
 *      are asserted numerically below (a common shift in every coach's q must
 *      cancel to zero; swapping venues must negate the delta exactly).
 *
 *   2. LEAKAGE. A coach's season-N rating may read seasons < N and nothing else.
 *      Asserted three ways: the first walk season's map is EMPTY on the fixture
 *      AND on the shipped 27-season corpus; and truncating the residual stream
 *      after season N leaves the season-N map byte-identical, so no later game
 *      can be reaching it.
 *
 *   3. SILENT DEGRADATION. A join miss turns the family into an exact tie on
 *      those games — no error, no red test, just a diluted measurement. So the
 *      corpus join is asserted at 100%, and `inputs()` is asserted to REFUSE a
 *      fixture that is one record short.
 *
 *   4. WIRING. A family wired at some of promote_signals' sites but not all of
 *      them fails silently. The registration sites are grepped, INCLUDING the
 *      deliberate omission: `coach_quality` must NOT be in APPLIABLE while
 *      build_predictions.py cannot apply it, or the gate would claim an
 *      application path that does not exist.
 *
 * The exact numbers come from data/fixtures/coach_quality_sample.json, built so
 * every team plays exactly once in the training season. Every team is therefore
 * still at elo.INIT when its only game is priced, the home probability is one
 * constant p0, and the expected deltas are exact arithmetic — scale/17, with p0
 * cancelling — derivable on paper with no Elo trajectory to reproduce. That is
 * why this test computes its own expectations instead of trusting the Python
 * selftest's verdict.
 *
 * Node built-ins only. Corpus-dependent tests skip loudly when the runner-built
 * artifacts are absent; the fixture-driven tests always run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const MODULE = join(REPO_ROOT, 'scripts', 'signals', 'coach_quality.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const FIXTURE = join(DATA, 'fixtures', 'coach_quality_sample.json');
const CORPUS = join(DATA, 'fixtures', 'backtest_corpus');
const CONTEXT = join(DATA, 'game_context.json');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const src = (p) => readFileSync(p, 'utf8');

function py(args) {
  return execFileSync('python3', args, {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/* One driver invocation, reused by every fixture test. */
let REPORT = null;
function report() {
  if (REPORT === null) {
    REPORT = JSON.parse(py(['-m', 'scripts.signals.coach_quality',
      '--fixture', FIXTURE]));
  }
  return REPORT;
}

const near = (a, b, tol = 1e-12) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);

/* --------------------------------------------------------------------- *
 * 1. The module's own math selftest.                                     *
 * --------------------------------------------------------------------- */

test('coach_quality: python selftest passes', () => {
  const out = py(['-m', 'scripts.signals.coach_quality', '--selftest']);
  assert.match(out, /selftest OK/);
  /* The selftest's headline claim is that this module's residual stream is
   * identical to promote_signals.walk_season's. Two copies of a rating
   * trajectory that are allowed to drift are a silent wrong answer. */
  assert.match(out, /residual stream == walk_season/);
});

/* --------------------------------------------------------------------- *
 * 2. Exact fixture arithmetic — the anti-double-count properties.        *
 * --------------------------------------------------------------------- */

test('coach_quality: every fixture probe matches its hand-derived value', () => {
  const fx = load(FIXTURE);
  const got = report().deltas;
  assert.equal(got.length, fx.finals['2002'].length);
  for (const probe of fx.probes) {
    near(got[probe.index], probe.expect, 1e-12);
  }
});

test('coach_quality: the headline delta is exactly scale/17, p0 cancelled out', () => {
  const fx = load(FIXTURE);
  /* A coach who won at home (residual +(1-p0)) against one who lost at home
   * (residual -p0), each with n=1 so shrink is 1/(1+16): the difference is
   * scale * ((1-p0) + p0) / 17 = scale/17. p0 is gone. This is the whole
   * differencing argument reduced to a number a reader can check. */
  near(report().deltas[0], fx.scale / (1 + fx.shrink_n), 1e-12);
});

test('coach_quality: a common shift in EVERY coach cancels (differenced)', () => {
  /* League-wide residual drift — a mis-set global hfa, a scoring-era shift —
   * is common to both sidelines and must not reach the price. Shift every
   * fitted q by the same constant and the delta must not move. */
  const fx = load(FIXTURE);
  const m = report().by_season['2002'];
  const rec = fx.context['2002|1|HOU|JAX'];
  const raw = fx.scale * (m[rec.home_coach] - m[rec.away_coach]);
  const shift = 0.137;
  const shifted = fx.scale * ((m[rec.home_coach] + shift)
                            - (m[rec.away_coach] + shift));
  near(shifted, raw, 1e-12);
  near(raw, report().deltas[0], 1e-12);
});

test('coach_quality: swapping venues negates the delta exactly (antisymmetry)', () => {
  /* Probes 5 and 6 are the same coach pair with home and away swapped. If the
   * family carried any venue component it would not negate — that component
   * belongs to `environment`/venue_hfa, not here. */
  const d = report().deltas;
  near(d[5], -d[6], 1e-12);
  assert.notEqual(d[5], 0);
});

test('coach_quality: signed accumulation makes mirror-image coaches opposite', () => {
  /* +r for the home coach, -r for the away coach. In the fixture each 2001
   * game's two coaches saw the same residual with opposite sign and each has
   * n=1, so their q values must be exact negatives of one another. */
  const fx = load(FIXTURE);
  const m = report().by_season['2002'];
  for (const [a, b] of fx.expect.antisymmetric_pairs) {
    assert.ok(a in m && b in m, `${a}/${b} missing from the 2002 fit`);
    near(m[a], -m[b], 1e-15);
  }
});

test('coach_quality: an unseen coach is silent, not guessed', () => {
  /* Probe 7: two coaches with no prior games. n=0 means shrink 0 means q 0.
   * The honest default is "this family has nothing to say", never a prior. */
  const fx = load(FIXTURE);
  const m = report().by_season['2002'];
  assert.ok(report().deltas[7] === 0);
  assert.ok(!('Kip Rookie' in m));
  assert.ok(!('Lou Rookie' in m));
  assert.equal(Object.keys(m).length, fx.expect.coaches_rated_2002);
});

test('coach_quality: a tie contributes no residual AND no count', () => {
  /* A tie scores no log-loss and carries no direction, so walk_season skips it
   * and so must this family — including from n, or shrinkage would see a padded
   * sample. Both tie coaches must be absent from the fit entirely. */
  const fx = load(FIXTURE);
  const m = report().by_season['2002'];
  for (const c of fx.expect.tie_coaches_absent_2002) {
    assert.ok(!(c in m), `${c} must not be rated: their only game was a tie`);
  }
  assert.ok(report().deltas[3] === 0);
  /* 5 + 9 fixture games, one of which is a tie -> 13 residuals. */
  assert.equal(report().residuals, 13);
});

test('coach_quality: a missing context record is 0.0, never a crash', () => {
  assert.ok(report().deltas[8] === 0);
});

/* --------------------------------------------------------------------- *
 * 3. Leakage.                                                            *
 * --------------------------------------------------------------------- */

test('coach_quality: the first walk season is fit on NOTHING', () => {
  assert.deepEqual(report().by_season['2001'], {});
});

test('coach_quality: truncating the future leaves each season map identical', () => {
  /* The strongest available leak proof. Fit over all seasons, then re-fit with
   * the residual stream truncated to seasons < N. If any season-N or later game
   * were reaching the season-N map, the two would differ. They must not. */
  const out = py(['-c', `
import json
from scripts.signals import coach_quality as cq
fx = json.load(open("${FIXTURE}", encoding="utf-8"))
p = fx["params"]
seasons = [int(s) for s in fx["seasons"]]
finals = {int(y): g for y, g in fx["finals"].items()}
ctx = fx["context"]
stream = cq.residual_stream(finals, seasons, p["hfa"], p["k"], p["revert"])
full = cq.fit_by_season(stream, ctx, seasons)
same = {}
for n in seasons:
    past = [row for row in stream if row[0] < n]
    trunc = cq.fit_by_season(past, ctx, [n])
    same[n] = (trunc[n] == full[n])
print(json.dumps({"same": same, "n_seasons": len(seasons)}))
`]);
  const res = JSON.parse(out);
  assert.equal(res.n_seasons, 2);
  for (const [season, ok] of Object.entries(res.same)) {
    assert.ok(ok, `season ${season} map changed when the future was removed — LEAK`);
  }
});

test('coach_quality: scale 0 is exactly the incumbent', () => {
  /* The grid's first entry is 0.0 and the caller excludes it from the trials,
   * because a zero-scale family IS the incumbent. If it were ever included, it
   * must still be an exact no-op. */
  const fx = load(FIXTURE);
  assert.equal(report().scales[0], 0);
  const out = py(['-c', `
import json
from scripts.signals import coach_quality as cq
fx = json.load(open("${FIXTURE}", encoding="utf-8"))
p = fx["params"]
seasons = [int(s) for s in fx["seasons"]]
finals = {int(y): g for y, g in fx["finals"].items()}
ctx = fx["context"]
stream = cq.residual_stream(finals, seasons, p["hfa"], p["k"], p["revert"])
fit = cq.CoachFit(cq.fit_by_season(stream, ctx, seasons), seasons=seasons)
print(json.dumps([fit.delta(ctx, 2002, g, 0.0) for g in finals[2002]]))
`]);
  /* `=== 0` rather than strict-equal to the literal: a differenced product of
   * a zero scale can legitimately be negative zero, which is the same number. */
  for (const d of JSON.parse(out)) assert.ok(d === 0, `${d} is not zero`);
  assert.equal(fx.shrink_n, 16);
});

/* --------------------------------------------------------------------- *
 * 4. Coverage — a silent join miss is a diluted measurement.             *
 * --------------------------------------------------------------------- */

test('coach_quality: inputs() REFUSES a fixture that is one record short', () => {
  const fx = load(FIXTURE);
  assert.deepEqual(report().coverage['2002'], [8, 9]);
  assert.equal(report().inputs_refused, fx.expect.inputs_refused);
  assert.equal(report().inputs_refused, true);
});

test('coach_quality: the shipped corpus joins 100% in every season', { skip: false }, (t) => {
  if (!existsSync(CONTEXT) || !existsSync(join(CORPUS, 'manifest.json'))) {
    t.skip('game_context.json or backtest_corpus absent (runner-built)');
    return;
  }
  const out = py(['-c', `
import json
from scripts import promote_signals as ps
from scripts.signals import coach_quality as cq
ps.use_corpus()
hfa, revert, k, _ = ps.game_params()
finals = {y: ps.load_finals(y) for y in ps.SEASONS}
ctx = cq.load_context()
cov = cq.join_coverage(finals, ps.SEASONS, ctx)
res = cq.inputs(finals, ps.SEASONS, hfa, k, revert, ctx=ctx)
worst = min(j / t for j, t in cov.values())
first = ps.SEASONS[0]
print(json.dumps({
    "worst": worst,
    "seasons": len(cov),
    "runnable": res is not None,
    "first_season_rated": res[1].n_rated(first) if res else None,
    "last_season_rated": res[1].n_rated(ps.SEASONS[-1]) if res else None,
}))
`]);
  const r = JSON.parse(out);
  assert.equal(r.seasons, 27, 'corpus must cover 1999-2025');
  assert.equal(r.worst, 1.0, 'every corpus season must join 100% — a miss is a silent tie');
  assert.equal(r.runnable, true);
  /* Leakage, on real data this time: nobody is rated in the first walk season. */
  assert.equal(r.first_season_rated, 0);
  assert.ok(r.last_season_rated > 100, 'the last season should rate every coach ever seen');
});

/* --------------------------------------------------------------------- *
 * 5. The market boundary.                                                *
 * --------------------------------------------------------------------- */

test('coach_quality: no betting column is named anywhere in the family', () => {
  /* Denylist as a LITERAL, never imported from the producer. Market prices are
   * display-only in this project; a family may never read one. */
  const BETTING = [
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line',
    'over_odds', 'under_odds', 'away_spread_odds', 'home_spread_odds',
  ];
  for (const file of [MODULE, FIXTURE]) {
    const text = src(file);
    for (const col of BETTING) {
      assert.ok(!text.includes(col), `${col} appears in ${file}`);
    }
  }
});

test('coach_quality: the family reads no post-game label field', () => {
  /* game_context.json declares referee and home_qb/away_qb POST-game and
   * label-only. This family reads home_coach/away_coach and nothing else. */
  const text = src(MODULE);
  for (const field of ['referee', 'home_qb', 'away_qb']) {
    assert.ok(!text.includes(`"${field}"`) && !text.includes(`'${field}'`),
      `${field} is label-only and must never be read here`);
  }
  assert.ok(text.includes('home_coach') && text.includes('away_coach'));
});

/* --------------------------------------------------------------------- *
 * 6. Registration in promote_signals — including the deliberate omission. *
 * --------------------------------------------------------------------- */

test('coach_quality: wired at every promote_signals site it needs', () => {
  const text = src(PROMOTE);
  /* import */
  assert.match(text, /from scripts\.signals import coach_quality as coach_quality_mod/);
  /* trials block with the skip-loudly idiom */
  assert.match(text, /coach_quality_mod\.inputs\(finals_by_year, SEASONS, hfa, k,/);
  assert.match(text, /"family": "coach_quality", "skipped": True/);
  assert.match(text, /try_candidate\("coach_quality"/);
  assert.match(text, /coach_quality_mod\.COACH_SCALES/);
  /* _incumbent_family_fns — the nastiest omission: an adopted family missing
   * here is not part of next week's incumbent, and the gate silently stops
   * being never-regress. */
  assert.match(text, /gp\.get\("coach_quality"\)/);
  assert.match(text, /__coach_quality__/);
  /* _write_adoption */
  assert.match(text, /gp\["coach_quality"\] = \{/);
  assert.match(text, /coach_quality_mod\.production_deltas/);
});

test('coach_quality: deliberately NOT in APPLIABLE while unwired downstream', () => {
  /* The honesty guard. build_predictions.py does not call
   * coach_quality.delta_from_params, so the pipeline cannot apply this family.
   * Listing it in APPLIABLE would make the gate claim an application path that
   * does not exist; leaving it out makes a winning coach_quality record
   * `would_adopt` instead of adopting. This test fails the moment someone adds
   * it to APPLIABLE without also wiring the reader — which is the point. */
  const promote = src(PROMOTE);
  const m = promote.match(/APPLIABLE = \{[\s\S]*?\}/);
  assert.ok(m, 'APPLIABLE set not found');
  const wiredDownstream = src(join(REPO_ROOT, 'scripts', 'build_predictions.py'))
    .includes('coach_quality');
  const inAppliable = m[0].includes('"coach_quality"');
  assert.equal(inAppliable, wiredDownstream,
    inAppliable
      ? 'coach_quality is in APPLIABLE but build_predictions.py cannot apply it'
      : 'build_predictions.py now applies coach_quality — add it to APPLIABLE');
  /* and the reader exists, so wiring it later is a two-line change */
  assert.match(src(MODULE), /def delta_from_params\(/);
});

test('coach_quality: the module is stdlib-only', () => {
  const text = src(MODULE);
  for (const banned of ['numpy', 'pandas', 'scipy']) {
    assert.ok(!text.includes(banned), `${banned} is banned project-wide`);
  }
});
