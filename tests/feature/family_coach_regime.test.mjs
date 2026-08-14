/* tests/feature/family_coach_regime.test.mjs — the `coach_regime` gate family
 * (R22-F3): a head-coach CHANGE priced as REDUCED CONFIDENCE in the rating a
 * team carries across the offseason.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these tests lock:
 *
 *   1. THE FAMILY QUIETLY BECOMING "NEW COACHES ARE WORSE". That is a different
 *      hypothesis, it is the one everybody's prior expects, and a one-line sign
 *      slip turns this family into it. The defence is structural: the delta is
 *      -phi * (rating - 1500) per flagged side, so a flagged team ABOVE the mean
 *      is priced down and a flagged team BELOW it is priced up by the same rule.
 *      The fixture deliberately contains both (HOU above, JAX below) and the
 *      opposite signs are asserted, along with the exact identity that the delta
 *      IS "price this game with a further-reverted rating" and nothing else.
 *
 *   2. LEAKAGE VIA THE RATING. Unlike every other family the delta reads the
 *      pre-game ratings, so this test recomputes the whole Elo trajectory in
 *      JavaScript from the fixture — 25 lines, importing nothing from the repo —
 *      and checks the Python numbers against ITS numbers. Separately, the
 *      corpus rows for seasons <= N are asserted byte-identical when the walk is
 *      truncated after N, so no future game can be reaching them.
 *
 *   3. THE MID-SEASON DECISION SILENTLY DRIFTING. Mid-season coach changes are
 *      EXCLUDED (module docstring says why) and COUNTED. The fixture contains
 *      one, and the tests assert it is counted, is not a flag, and does not
 *      disturb the flag that the season boundary did set.
 *
 *   4. SILENT DEGRADATION. A join miss makes the family an exact tie on those
 *      games — no error, no red test, just a diluted measurement. The corpus
 *      join is asserted at 100% and `inputs()` is asserted to refuse partial
 *      coverage.
 *
 *   5. WIRING. A family wired at some of promote_signals' sites but not all of
 *      them fails silently. The registration sites are grepped, INCLUDING the
 *      deliberate omission from APPLIABLE while build_predictions.py cannot
 *      apply the family.
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
const MODULE = join(REPO_ROOT, 'scripts', 'signals', 'coach_regime.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const FIXTURE = join(DATA, 'fixtures', 'coach_regime_sample.json');
const CORPUS = join(DATA, 'fixtures', 'backtest_corpus');
const CONTEXT = join(DATA, 'game_context.json');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const src = (p) => readFileSync(p, 'utf8');

function py(args) {
  return execFileSync('python3', args, {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

let REPORT = null;
function report() {
  if (REPORT === null) {
    REPORT = JSON.parse(py(['-m', 'scripts.signals.coach_regime',
      '--fixture', FIXTURE]));
  }
  return REPORT;
}

const near = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);

/* ---------------------------------------------------------------------- *
 * An INDEPENDENT Elo trajectory, written from the model's definition and   *
 * importing nothing from this repo. Everything below is checked against    *
 * these numbers rather than against Python's.                             *
 * ---------------------------------------------------------------------- */

const INIT = 1500;
const expectedHome = (rh, ra, hfa) => 1 / (1 + Math.pow(10, -((rh - ra + hfa) / 400)));
const movMult = (margin, dw) => Math.log(Math.abs(margin) + 1) * (2.2 / (dw * 0.001 + 2.2));

function trajectory(fx) {
  const { hfa, k, revert } = fx.params;
  let priors = new Map();
  const pre = new Map();        // join key -> [rating_home, rating_away]
  const played = new Map();     // join key -> [games_home, games_away]
  for (const season of fx.seasons) {
    const r = new Map(priors);
    const count = new Map();
    for (const g of fx.finals[String(season)]) {
      const h = g.home, a = g.away;
      if (!r.has(h)) r.set(h, INIT);
      if (!r.has(a)) r.set(a, INIT);
      const rh = r.get(h), ra = r.get(a);
      const key = `${season}|${g.week}|${h}|${a}`;
      pre.set(key, [rh, ra]);
      played.set(key, [count.get(h) || 0, count.get(a) || 0]);
      count.set(h, (count.get(h) || 0) + 1);
      count.set(a, (count.get(a) || 0) + 1);
      const hs = g.home_score, as_ = g.away_score;
      const exp = expectedHome(rh, ra, hfa);
      let actual, margin, dw;
      if (hs > as_) { actual = 1; margin = hs - as_; dw = (rh + hfa) - ra; }
      else if (hs < as_) { actual = 0; margin = as_ - hs; dw = ra - (rh + hfa); }
      else { actual = 0.5; margin = 1; dw = 0; }
      const d = k * movMult(margin, dw) * (actual - exp);
      r.set(h, rh + d);
      r.set(a, ra - d);
    }
    /* Between seasons: rate_season over the same ordered games from the same
     * priors is the same arithmetic the walk just did, then revert to 1500. */
    priors = new Map([...r].map(([t, v]) => [t, INIT + (v - INIT) * (1 - revert)]));
  }
  return { pre, played };
}

/* The regime rule, reimplemented from its statement: a team is flagged for
 * season N when the coach of its FIRST game of N differs from the coach of its
 * LAST game of N-1. No season N-1 in the walk => unknown, never flagged. */
function flagsFromFixture(fx) {
  const first = new Map(), last = new Map(), midseason = [];
  for (const season of fx.seasons) {
    const prev = new Map();
    for (const g of fx.finals[String(season)]) {
      const rec = fx.context[`${season}|${g.week}|${g.home}|${g.away}`];
      for (const [team, coach] of [[g.home, rec.home_coach], [g.away, rec.away_coach]]) {
        const kk = `${season}|${team}`;
        if (!first.has(kk)) first.set(kk, coach);
        else if (prev.get(team) !== coach) midseason.push([season, team, coach]);
        prev.set(team, coach);
        last.set(kk, coach);
      }
    }
  }
  const flags = new Set(), unknown = new Set();
  for (const kk of first.keys()) {
    const [season, team] = kk.split('|');
    const prior = last.get(`${Number(season) - 1}|${team}`);
    if (prior === undefined) unknown.add(kk);
    else if (prior !== first.get(kk)) flags.add(kk);
  }
  return { flags, unknown, midseason };
}

const weight = (g, n0) => (n0 === null || n0 === undefined ? 1 : n0 / (n0 + g));

/* ---------------------------------------------------------------------- *
 * 1. The module's own selftest must pass — it locks the invariants that    *
 *    need promote_signals to check (walk_season equality above all).       *
 * ---------------------------------------------------------------------- */

test('coach_regime: python selftest passes', () => {
  const out = py(['-m', 'scripts.signals.coach_regime', '--selftest']);
  assert.match(out, /selftest OK/);
  /* The single assertion that keeps the duplicated rating trajectory honest. */
  assert.match(out, /rating stream == walk_season/);
});

/* ---------------------------------------------------------------------- *
 * 2. The ratings the family prices with, checked against JavaScript's.     *
 * ---------------------------------------------------------------------- */

test('coach_regime: the reproduced pre-game ratings match an independent walk', () => {
  const fx = load(FIXTURE);
  const { pre } = trajectory(fx);
  const rows = report().ratings;
  assert.equal(rows.length, 10);
  for (const row of rows) {
    const want = pre.get(row.key);
    assert.ok(want, `no independent rating for ${row.key}`);
    near(row.rating_home, want[0]);
    near(row.rating_away, want[1]);
  }
  /* Season 2001 is built so every team is still at 1500 when it plays. */
  for (const row of rows.filter((r) => r.key.startsWith('2001|'))) {
    assert.equal(row.rating_home, 1500);
    assert.equal(row.rating_away, 1500);
  }
});

/* ---------------------------------------------------------------------- *
 * 3. Regime detection — the season boundary, and only the season boundary. *
 * ---------------------------------------------------------------------- */

test('coach_regime: flags match an independent reimplementation of the rule', () => {
  const fx = load(FIXTURE);
  const { flags, unknown, midseason } = flagsFromFixture(fx);
  assert.deepEqual([...flags].sort(), fx.expected.flags_2002.map((t) => `2002|${t}`).sort());
  assert.deepEqual(report().flags, [...flags].map((s) => {
    const [y, t] = s.split('|');
    return `${y}|${t}`;
  }).sort());
  /* the expansion team has no 2001 at all: UNKNOWN, never flagged */
  assert.ok(unknown.has('2002|XXX'));
  assert.ok(!flags.has('2002|XXX'));
  assert.equal(midseason.length, fx.expected.midseason_changes_2002);
});

test('coach_regime: a mid-season change is COUNTED and is NEVER a flag', () => {
  const fx = load(FIXTURE);
  const d = report().diagnostics;
  assert.equal(d.midseason_changes, fx.expected.midseason_changes_2002);
  assert.equal(d.by_season['2002'].midseason_changes, 1);
  /* KC's coach changes in week 6, and KC is flagged for 2002 — but by the
   * SEASON BOUNDARY (Ken Khaki -> Kit Kelp), not by the in-season change. The
   * two are independent, which is what the exclusion means. */
  assert.ok(d.by_season['2002'].flagged.includes('KC'));
  assert.match(d.midseason_policy, /EXCLUDED/);
  assert.match(d.rule, /season N-1/);
  /* Every team in the FIRST walk season is unknown, so nothing is flagged. */
  assert.equal(d.by_season['2001'].first_year_regimes, 0);
  assert.equal(d.by_season['2001'].no_prior_season.length, 8);
  assert.deepEqual(d.by_season['2002'].no_prior_season,
    fx.expected.no_prior_season_2002);
  assert.deepEqual(d.by_season['2002'].flagged.slice().sort(),
    fx.expected.flags_2002.slice().sort());
  assert.deepEqual(
    fx.expected.unflagged_2002.filter((t) => d.by_season['2002'].flagged.includes(t)),
    []);
});

/* ---------------------------------------------------------------------- *
 * 4. The delta itself — every grid cell, from JavaScript's ratings.        *
 * ---------------------------------------------------------------------- */

test('coach_regime: every grid delta equals the extra-reversion price shift', () => {
  const fx = load(FIXTURE);
  const { pre, played } = trajectory(fx);
  const { flags } = flagsFromFixture(fx);
  const season = fx.seasons[fx.seasons.length - 1];
  const keys = fx.finals[String(season)].map((g) => `${season}|${g.week}|${g.home}|${g.away}`);
  const rep = report();
  assert.equal(rep.grid.length, rep.shrinks.length * rep.decays.length);
  for (const cell of rep.grid) {
    assert.equal(cell.deltas.length, keys.length);
    keys.forEach((key, i) => {
      const [rh, ra] = pre.get(key);
      const [gh, ga] = played.get(key);
      const [, , home, away] = key.split('|');
      const devH = flags.has(`${season}|${home}`) ? rh - INIT : 0;
      const devA = flags.has(`${season}|${away}`) ? ra - INIT : 0;
      const want = cell.shrink * (-devH * weight(gh, cell.decay_n0)
        + devA * weight(ga, cell.decay_n0));
      near(cell.deltas[i], want, 1e-9);
    });
  }
});

test('coach_regime: the delta IS "price it with a further-reverted rating"', () => {
  /* The claim in one identity. If this holds, the family cannot be anything
   * other than reduced confidence in the rating. */
  const fx = load(FIXTURE);
  const { hfa } = fx.params;
  const { pre } = trajectory(fx);
  const key = '2002|1|HOU|IND';            // HOU flagged, IND not
  const [rh, ra] = pre.get(key);
  const idx = fx.finals['2002'].findIndex((g) => `2002|${g.week}|${g.home}|${g.away}` === key);
  for (const cell of report().grid.filter((c) => c.decay_n0 === null)) {
    const delta = cell.deltas[idx];
    const reverted = INIT + (1 - cell.shrink) * (rh - INIT);
    near(expectedHome(rh, ra, hfa + delta), expectedHome(reverted, ra, hfa), 1e-15);
  }
});

test('coach_regime: the sign follows the RATING, not the coach', () => {
  /* The whole point. HOU is flagged and ABOVE 1500 -> priced DOWN. JAX is
   * flagged and BELOW 1500 -> priced UP. Same rule, opposite signs: the family
   * is structurally incapable of saying "new coaches are worse". */
  const fx = load(FIXTURE);
  const { pre } = trajectory(fx);
  const hou = pre.get('2002|1|HOU|IND')[0];
  const jax = pre.get('2002|3|JAX|LAC')[0];
  assert.ok(hou > INIT, 'fixture must contain a flagged team above the mean');
  assert.ok(jax < INIT, 'fixture must contain a flagged team below the mean');
  const flat = report().grid.find((c) => c.decay_n0 === null && c.shrink === 0.15);
  const idxHou = 0;   // 2002|1|HOU|IND
  assert.ok(flat.deltas[idxHou] < 0, 'a strong team with a new coach must price DOWN');
  /* JAX vs LAC has BOTH sides flagged: JAX below the mean (its own term is
   * positive) and LAC above it (its term is positive for the home side too),
   * so the combined delta is positive and larger than either alone. */
  const rows = report().rows['2002|3|JAX|LAC'];
  assert.ok(rows[0] < 0 && rows[2] > 0, `expected opposite deviations, got ${rows}`);
  assert.ok(flat.deltas[2] > 0);
  /* And a flagged team sitting exactly on 1500 would move nothing — asserted in
   * the module selftest; here we assert the equivalent on real fixture data:
   * the unflagged game is EXACTLY zero at every setting. */
  const zeroKey = fx.expected.zero_delta_games[0];
  const zIdx = fx.finals['2002'].findIndex(
    (g) => `2002|${g.week}|${g.home}|${g.away}` === zeroKey);
  for (const cell of report().grid) {
    assert.ok(cell.deltas[zIdx] === 0, `${zeroKey} must be exactly 0, got ${cell.deltas[zIdx]}`);
  }
});

test('coach_regime: linear in shrink, and decay is exactly n0/(n0+g)', () => {
  const rep = report();
  const flat15 = rep.grid.find((c) => c.decay_n0 === null && c.shrink === 0.15);
  const flat30 = rep.grid.find((c) => c.decay_n0 === null && c.shrink === 0.3);
  flat15.deltas.forEach((d, i) => near(flat30.deltas[i], 2 * d, 1e-9));
  /* HOU's SECOND game of 2002 (index 4) is the one the decay axis acts on: one
   * game already played, so n0/(n0+1) = 4/5 of the discount survives. */
  const decay = rep.grid.find((c) => c.decay_n0 === 4 && c.shrink === 0.15);
  assert.equal(rep.rows['2002|5|HOU|XXX'][1], 1);
  near(decay.deltas[4], flat15.deltas[4] * (4 / 5), 1e-12);
  /* A team's FIRST game of the season keeps the full discount. */
  assert.equal(rep.rows['2002|1|HOU|IND'][1], 0);
  near(decay.deltas[0], flat15.deltas[0], 1e-12);
});

test('coach_regime: the grid is the shape the design fixed — 3 x 2, one-sided', () => {
  const rep = report();
  assert.deepEqual(rep.shrinks, [0.15, 0.3, 0.5]);
  assert.deepEqual(rep.decays, [null, 4]);
  assert.equal(rep.mean_elo, 1500);
  /* One-sided by construction: a negative shrink would claim a regime change
   * makes the OLD rating more informative, which is not this hypothesis. */
  for (const s of rep.shrinks) assert.ok(s > 0 && s < 1, `${s} is not a fraction`);
  assert.equal(rep.grid.length, 6);
});

/* ---------------------------------------------------------------------- *
 * 5. Leakage and coverage on the real corpus.                             *
 * ---------------------------------------------------------------------- */

const corpusReady = () =>
  existsSync(CONTEXT) && existsSync(join(CORPUS, 'manifest.json'));

test('coach_regime: the shipped corpus joins 100% in every season', (t) => {
  if (!corpusReady()) {
    t.skip('game_context.json or backtest_corpus absent (runner-built)');
    return;
  }
  const out = py(['-c', `
import json
from scripts import promote_signals as ps
from scripts.signals import coach_regime as cr
ps.use_corpus()
hfa, revert, k, _ = ps.game_params()
finals = {y: ps.load_finals(y) for y in ps.SEASONS}
ctx = cr.load_context()
cov = cr.join_coverage(finals, ps.SEASONS, ctx)
fit = cr.inputs(finals, ps.SEASONS, hfa, k, revert, ctx=ctx)
d = fit.diagnostics
print(json.dumps({
    "worst": min(j / t for j, t in cov.values()),
    "seasons": len(cov),
    "runnable": fit is not None,
    "first_year_regimes": d["first_year_regimes"],
    "midseason_changes": d["midseason_changes"],
    "first_season_flags": d["by_season"][ps.SEASONS[0]]["first_year_regimes"],
    "first_season_unknown": len(d["by_season"][ps.SEASONS[0]]["no_prior_season"]),
    "flagged_sides": fit.flagged_rows(),
    "rows": len(fit.rows),
}))
`]);
  const r = JSON.parse(out);
  assert.equal(r.seasons, 27, 'corpus must cover 1999-2025');
  assert.equal(r.worst, 1.0, 'every corpus season must join 100% — a miss is a silent tie');
  assert.equal(r.runnable, true);
  /* Leakage on real data: nobody can be flagged in the first walk season,
   * because there is no season before it inside the walk. */
  assert.equal(r.first_season_flags, 0);
  assert.equal(r.first_season_unknown, 31, '1999 had 31 teams, all unknown');
  /* The sample the family actually prices — a measurement, not a guess. */
  assert.equal(r.first_year_regimes, 171);
  assert.equal(r.midseason_changes, 43);
  assert.ok(r.flagged_sides > 2000 && r.flagged_sides < r.rows,
    `${r.flagged_sides} flagged sides of ${r.rows} games`);
});

test('coach_regime: truncating the future leaves every earlier row identical', (t) => {
  if (!corpusReady()) {
    t.skip('game_context.json or backtest_corpus absent (runner-built)');
    return;
  }
  /* The strongest available leak proof. Build the per-game rows over the whole
   * corpus, then rebuild over seasons <= N. Every row for a season <= N must be
   * byte-identical: if any later game were reaching a season-N flag, a season-N
   * rating or a season-N games-played count, they would differ. */
  const out = py(['-c', `
import json
from scripts import promote_signals as ps
from scripts.signals import coach_regime as cr
ps.use_corpus()
hfa, revert, k, _t = ps.game_params()
finals = {y: ps.load_finals(y) for y in ps.SEASONS}
ctx = cr.load_context()
full, _d = cr.build_rows(finals, ps.SEASONS, hfa, k, revert, ctx)
same = {}
for cut in (ps.SEASONS[5], ps.SEASONS[15], ps.SEASONS[-2]):
    upto = [y for y in ps.SEASONS if y <= cut]
    trunc, _d2 = cr.build_rows(finals, upto, hfa, k, revert, ctx)
    same[cut] = all(full[kk] == v for kk, v in trunc.items())
print(json.dumps({"same": same, "rows": len(full)}))
`]);
  const r = JSON.parse(out);
  assert.ok(r.rows > 6000);
  for (const [cut, ok] of Object.entries(r.same)) {
    assert.ok(ok, `rows through ${cut} changed when the future was removed — LEAK`);
  }
});

test('coach_regime: inputs() REFUSES partial coverage rather than scoring ties', (t) => {
  if (!corpusReady()) {
    t.skip('game_context.json or backtest_corpus absent (runner-built)');
    return;
  }
  const out = py(['-c', `
import json
from scripts import promote_signals as ps
from scripts.signals import coach_regime as cr
ps.use_corpus()
hfa, revert, k, _t = ps.game_params()
finals = {y: ps.load_finals(y) for y in ps.SEASONS}
ctx = cr.load_context()
holed = {kk: v for kk, v in ctx.items() if not kk.startswith("2015|")}
print(json.dumps({
    "absent": cr.inputs(finals, ps.SEASONS, hfa, k, revert, ctx={}) is None,
    "partial": cr.inputs(finals, ps.SEASONS, hfa, k, revert, ctx=holed) is None,
    "full": cr.inputs(finals, ps.SEASONS, hfa, k, revert, ctx=ctx) is not None,
    "reason": cr.coverage_reason(finals, ps.SEASONS),
}))
`]);
  const r = JSON.parse(out);
  assert.equal(r.absent, true);
  assert.equal(r.partial, true, 'a hole in one season must be refused, not diluted');
  assert.equal(r.full, true);
});

/* ---------------------------------------------------------------------- *
 * 6. The market boundary and the label-only fields.                       *
 * ---------------------------------------------------------------------- */

test('coach_regime: no betting column is named anywhere in the family', () => {
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

test('coach_regime: the family reads no post-game label field', () => {
  /* game_context.json declares referee and home_qb/away_qb POST-game and
   * label-only. This family reads home_coach/away_coach and nothing else. */
  const text = src(MODULE);
  for (const field of ['referee', 'home_qb', 'away_qb']) {
    assert.ok(!text.includes(`"${field}"`) && !text.includes(`'${field}'`),
      `${field} is label-only and must never be read here`);
  }
  assert.ok(text.includes('home_coach') && text.includes('away_coach'));
});

test('coach_regime: the module is stdlib-only', () => {
  const text = src(MODULE);
  for (const banned of ['numpy', 'pandas', 'scipy']) {
    assert.ok(!text.includes(banned), `${banned} is banned project-wide`);
  }
});

/* ---------------------------------------------------------------------- *
 * 7. Registration in promote_signals — including the deliberate omission.  *
 * ---------------------------------------------------------------------- */

test('coach_regime: wired at every promote_signals site it needs', () => {
  const text = src(PROMOTE);
  /* import */
  assert.match(text, /from scripts\.signals import coach_regime as coach_regime_mod/);
  /* trials block with the skip-loudly idiom */
  assert.match(text, /coach_regime_mod\.inputs\(finals_by_year, SEASONS, hfa, k,/);
  assert.match(text, /"family": "coach_regime", "skipped": True/);
  assert.match(text, /try_candidate\("coach_regime"/);
  assert.match(text, /coach_regime_mod\.REGIME_SHRINK/);
  assert.match(text, /coach_regime_mod\.REGIME_DECAY_N0/);
  /* _incumbent_family_fns — checklist point 7. An adopted family missing here
   * is not part of next week's incumbent, and the gate silently stops being
   * never-regress. */
  assert.match(text, /gp\.get\("coach_regime"\)/);
  assert.match(text, /__coach_regime__/);
  /* _write_adoption */
  assert.match(text, /gp\["coach_regime"\] = coach_regime_mod\.adoption_block/);
});

test('coach_regime: deliberately NOT in APPLIABLE while unwired downstream', () => {
  /* The honesty guard. build_predictions.py does not call
   * coach_regime.delta_from_params, so the pipeline cannot apply this family.
   * Listing it in APPLIABLE would make the gate claim an application path that
   * does not exist; leaving it out makes a winning coach_regime record
   * `would_adopt` instead of adopting. This test fails the moment someone adds
   * it to APPLIABLE without also wiring the reader — which is the point. */
  const promote = src(PROMOTE);
  const m = promote.match(/APPLIABLE = \{[\s\S]*?\}/);
  assert.ok(m, 'APPLIABLE set not found');
  const wiredDownstream = src(join(REPO_ROOT, 'scripts', 'build_predictions.py'))
    .includes('coach_regime');
  const inAppliable = m[0].includes('"coach_regime"');
  assert.equal(inAppliable, wiredDownstream,
    inAppliable
      ? 'coach_regime is in APPLIABLE but build_predictions.py cannot apply it'
      : 'build_predictions.py now applies coach_regime — add it to APPLIABLE');
  /* and the reader exists, so wiring it later is a small change */
  assert.match(src(MODULE), /def delta_from_params\(/);
});

test('coach_regime: the adoption block round-trips through delta_from_params', () => {
  /* An adopted block must reproduce the gate's own delta exactly, or the day it
   * is wired the pipeline will price something different from what was measured. */
  const out = py(['-c', `
import json
from scripts.signals import coach_regime as cr
fx = json.load(open("${FIXTURE}", encoding="utf-8"))
p = fx["params"]
seasons = [int(s) for s in fx["seasons"]]
finals = {int(y): g for y, g in fx["finals"].items()}
ctx = fx["context"]
fit = cr.inputs(finals, seasons, p["hfa"], p["k"], p["revert"], ctx=ctx)
flags, _d = cr.first_year_regimes(finals, seasons, ctx)
stream = {cr.context_key(y, g): (rh, ra)
          for (y, g, rh, ra) in cr.rating_stream(finals, seasons, p["hfa"],
                                                 p["k"], p["revert"])}
out = []
for sh in cr.REGIME_SHRINK:
    for n0 in cr.REGIME_DECAY_N0:
        blk = cr.adoption_block({"shrink": sh, "decay_n0": n0}, "now")
        for g in finals[2002]:
            kk = cr.context_key(2002, g)
            rh, ra = stream[kk]
            row = fit.rows[kk]
            out.append([fit.delta(2002, g, sh, n0),
                        cr.delta_from_params(blk, rh, ra,
                                             (2002, g["home"]) in flags,
                                             (2002, g["away"]) in flags,
                                             row[1], row[3])])
print(json.dumps(out))
`]);
  const pairs = JSON.parse(out);
  assert.equal(pairs.length, 6 * 6);
  for (const [gate, applied] of pairs) near(applied, gate, 1e-12);
});
