/* tests/feature/r94_weather.test.mjs — R94 WEATHER EFFECT, locked.
 *
 * The owner asked whether rain matters: "does a QB throw worse in the rain,
 * is it harder to catch". R94 answers it with a MEASUREMENT and adopts
 * nothing. This file locks the handful of properties that would quietly turn
 * that measurement into a claim it cannot support. Each lock is numbered and
 * says why it is a lock, not merely what it checks.
 *
 *   1. POWER IS BLIND. The power table is computed from TRAINING seasons only,
 *      before any coefficient is fitted. Proved in BOTH directions: permuting
 *      the held-out season's outcome column must leave the table byte-identical,
 *      and perturbing a TRAINING outcome must MOVE it. A blindness test that
 *      nothing can move proves nothing — that exact vacuity was a real defect
 *      during the build, caused by a term whose analysis sample was empty.
 *   2. AN UNDERPOWERED TERM CANNOT ADOPT. This is the release's whole thesis.
 *      Take a real measured term that DOES adopt, multiply its coefficient by
 *      ten, collapse its standard errors to nothing, and clear the powered
 *      flag: it must refuse with exactly ["underpowered"], and must adopt again
 *      the moment the flag alone is restored. Nothing else changes.
 *   3. THE GRID IS IMMUTABLE AND IS THE MULTIPLICITY DIVISOR. Every artifact
 *      row is a pre-registered hypothesis, and N_TESTS is len(HYPOTHESES), so
 *      grid RESOLUTION cannot move a bar but an added ROW raises every bar.
 *   4. would_adopt IS RECOMPUTED HERE, in JavaScript, from the artifact's own
 *      published numbers and its own published rule, and compared to the stored
 *      flag. A document whose flag disagrees with its numbers is a document
 *      that cannot be read.
 *   5. THE STRATIFIED-POWER IDENTITY. power[term].n_treated is the term's OWN
 *      n_wet, not the marginal one. Powering a stratified primary on the
 *      marginal sample is how a headline gets sold on power it does not have.
 *      The same lock holds clause 1's CONJUNCTION: `powered` requires the
 *      model-based MDE and the realized MDE — mde_z * max(se_fold, se_stadium),
 *      the estimator's own binding clustered error — to BOTH clear the bar, so
 *      the two numbers can never be published in contradiction.
 *  5b. THE POWER n IS THE ESTIMATION n. Recounted from the rows, season by
 *      season: the published n_treated must be the SCORED-fold count, not the
 *      five-season one. An identity between two equally inflated numbers
 *      certifies the defect instead of catching it, so the recount also proves
 *      the filter is load-bearing.
 *  5c. NO DOSE-RESPONSE IS DECIDED BY A CELL TOO SMALL TO VOTE. monotone is
 *      recomputed here from bands clearing adoption_rule.min_band_n; every
 *      band is still published with its own n.
 *   6. THE FOLD BARRIER, both directions. Fold Y fits only seasons strictly
 *      before Y; the first fold fits nothing and is reported neutral-and-counted
 *      rather than dropped.
 *   7. THE RELOCATION FILTER IS A READER CONCERN. Asserted as a PROPERTY
 *      (survivors < rows read, at least one relocation dropped, every survivor
 *      outdoors, and the two subtraction identities) — never as a hard literal,
 *      so a games_meta refresh from daily.yml cannot red it.
 *   8. THE CORPUS IS NEVER REWRITTEN. sha256 of data/weather_history.json is
 *      computed HERE by node, and must equal python's digest before a full run,
 *      after it, and the digest the artifact itself publishes.
 *   9. ZEROS ARE PRESENT, NOT MISSING. Every pre-registered condition exists
 *      for every season, and both five-band families partition the sample.
 *  10. THE BINDING THRESHOLD IS THE LARGER THRESHOLD, NEVER THE LARGER SE. At
 *      3 df against 20 the larger SE can carry the LOWER bar, so choosing on SE
 *      is choosing the clustering that adopts.
 *  11. NOTHING FIRES WHEN NOTHING IS WET. Push the wet threshold to 10,000 mm
 *      and every rain term must read n_wet 0, rows_moved 0, would_adopt false,
 *      with the verdict falling to "not_powered".
 *  12. NOTHING LIVE MOVES. verdict.adopted is false, families_registered is
 *      empty, game_params gains no key, the promotion gate's divisor is
 *      unmoved, weather_wind has never been adopted, and no file under app/
 *      reads the artifact.
 *  13. THE MARKET BOUNDARY, AS A RUNTIME VALUE. A literal eight-column betting
 *      denylist is declared HERE (never imported from the producer) and
 *      asserted absent from the reader's allow-list, from every row the corpus
 *      reader actually produces, from the artifact, and from both contracts.
 *      This is checked on VALUES the code produces rather than on module source
 *      text, because a grep proves a word is missing while this proves a column
 *      never arrived.
 *  14. STDLIB ONLY. Importing all five R94 modules must leave numpy, pandas,
 *      scipy, sklearn and requests absent from sys.modules.
 *  15. THE SHIPPED MULTIPLIERS ARE UNTOUCHED. build_weekly.weather_factor still
 *      returns exactly 1.03 / 0.97 / 0.97*0.97 / 0.95 through a live call.
 *
 * Node built-ins only, and ZERO source-text assertions: there is not one
 * assertion against readFileSync of any .py module in this file. Every check
 * runs the code and inspects a value, because a source-text assertion grades a
 * string and this release's thesis lives in arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = join(REPO_ROOT, 'data', 'weather_backtest.json');
const WEATHER_HISTORY = join(REPO_ROOT, 'data', 'weather_history.json');
const TUNING = join(REPO_ROOT, 'data', 'model_tuning.json');
const CONTRACTS = [
  join(REPO_ROOT, 'data', 'contracts', 'weather_backtest.schema.json'),
  join(REPO_ROOT, 'data', 'contracts', 'wet_rates.schema.json'),
  join(REPO_ROOT, 'data', 'contracts', 'weather_forecast_archive.schema.json'),
];

/* Run python and parse the JSON printed on its LAST line — the modules print
 * progress, so the payload is the final line. */
function py(script) {
  const out = execFileSync('python3', ['-c', script], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* The denylist as a LITERAL — never imported from the producer, because a
 * checker that reuses the producer's constants grades the pipeline with the
 * pipeline's own marking scheme. Eight COLUMN NAMES, not loose substrings:
 * "spread" on its own would red on the phrase "predictor spread", which is the
 * statistical quantity a slope is identified by. */
const BETTING_COLUMNS = [
  'away_moneyline', 'home_moneyline', 'spread_line', 'total_line',
  'over_odds', 'under_odds', 'away_spread_odds', 'home_spread_odds',
];

/* Every R94 driver shares this preamble: it builds the offline synthetic
 * corpus and exposes one run() that drives the whole measurement in memory.
 * Nothing here reads or writes a file under data/. */
const PRELUDE = `
import sys, json, copy, random
sys.path.insert(0, '.')
from scripts import backtest_weather as b
from scripts import weather_corpus as wc
W, M, C, E, D, T, P = b._synthetic()
def run(**kw):
    a = dict(weather_doc=W, games_meta_doc=M, context_doc=C, epa_doc=E, dvp_doc=D,
             team_rates=T, player_rates=P, control=b.unavailable_control(),
             reach=b.reach_arm(None, pool_doc={}, calib_doc={}),
             now_utc='2026-01-01T00:00:00Z')
    a.update(kw)
    return b.measure(**a)
`;

/* Two artifacts, each measured once and reused by every test below.
 *   SYNTH — the in-memory synthetic corpus. Its planted effects are large
 *           enough that terms actually ADOPT, which is the only way to prove
 *           that clearing the powered flag is what stops them.
 *   REAL  — the committed 2021-2025 corpus, measured end to end. Its rate arms
 *           report substrate_unavailable on a clone that has never run the
 *           nflverse pull, which is exactly the state CI sees.
 * Memoised so the whole file pays for each run once. */
let _synth = null;
function synth() {
  if (_synth === null) _synth = py(`${PRELUDE}\nprint(json.dumps(run()))`);
  return _synth;
}
let _real = null;
function real() {
  if (_real === null) {
    _real = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import backtest_weather as b
from scripts import weather_corpus as wc
before = wc.corpus_sha256()
doc = b.measure(control=b.unavailable_control(),
                reach=b.reach_arm(None, pool_doc={}, calib_doc={}),
                now_utc='2026-01-01T00:00:00Z')
after = wc.corpus_sha256()
print(json.dumps({'doc': doc, 'sha_before': before, 'sha_after': after}))
`);
  }
  return _real;
}

/* Documents to run the structural locks over: the two measured in memory, plus
 * the runner-built artifact when it happens to be on disk. The artifact is
 * OPTIONAL_DATA and is absent on a fresh clone, so every structural property is
 * proved on a document this test produced itself — the file, when present, is
 * held to the same standard rather than being the only thing checked. */
function docs() {
  const out = [['synthetic', synth()], ['real-corpus', real().doc]];
  if (existsSync(ARTIFACT)) out.push(['on-disk artifact', readJson(ARTIFACT)]);
  return out;
}

/* ---------------------------------------------------------------------------
 * 1. POWER IS BLIND — in both directions.
 * ------------------------------------------------------------------------- */
test('r94: the power table cannot see a held-out outcome, and the test is not vacuous', () => {
  const r = py(`${PRELUDE}
base = run()
# Permute the HELD-OUT season's outcome column. Training-season variance is
# untouched, so a power table computed from training seasons cannot move.
shuffled = copy.deepcopy(P)
rng = random.Random(9401)
hold = str(b.HOLDOUT_SEASON)
vals = [r['completions'] for r in shuffled['rows'][hold].values()]
rng.shuffle(vals)
for row, v in zip(shuffled['rows'][hold].values(), vals):
    row['completions'] = v
permuted = run(player_rates=shuffled)
# Perturb a TRAINING outcome. This MUST move the table, or the assertion above
# is satisfied by a table nothing can move.
trained = copy.deepcopy(P)
# POWER_TRAINING_SEASONS, not TRAINING_SEASONS: the power sample is the SCORED
# rows, so the neutral first fold is outside it and perturbing THAT season would
# leave the table still for a second, unrelated reason.
tr = str(b.POWER_TRAINING_SEASONS[0])
for i, row in enumerate(trained['rows'][tr].values()):
    if row['attempts']:
        row['completions'] = 10 + (i % 7)
moved = run(player_rates=trained)
# The NEUTRAL first fold, changed in both of its roles - outcome AND
# denominator. No coefficient is fitted on it, so nothing in the power table may
# move. The denominator half is the one P0-A broke.
neutral = copy.deepcopy(P)
nz = str(b.SEASONS[0])
for i, row in enumerate(neutral['rows'][nz].values()):
    if row['attempts']:
        row['completions'] = 10 + (i % 7)
        row['attempts'] = int(row['attempts']) + 11
unmoved = run(player_rates=neutral)
print(json.dumps({
    'primary': b.PRIMARY_TERM,
    'base': base['power'], 'permuted': permuted['power'], 'moved': moved['power'],
    'unmoved': unmoved['power'],
    'terms_measured': [t['name'] for t in base['terms']
                       if t['n_treated_rows'] == 0 and t['available']],
}))`);

  assert.deepEqual(r.permuted, r.base,
    'permuting the held-out season moved the power table: power must be computed '
    + 'from TRAINING seasons only, before any coefficient is fitted');
  assert.notDeepEqual(r.moved[r.primary], r.base[r.primary],
    'perturbing a TRAINING outcome did NOT move the power table — the blindness '
    + 'assertion above is then vacuous, which is exactly the defect this lock exists for');
  assert.deepEqual(r.unmoved, r.base,
    'changing the NEUTRAL first fold moved the power table: the power stage is '
    + 'counting rows no coefficient is ever fitted on, which is how `powered` gets '
    + 'decided on more data than the estimate ever saw (R94 P0-A)');
  assert.deepEqual(r.terms_measured, [],
    'a term measured on an EMPTY analysis sample makes the blindness test vacuous '
    + 'without failing it');
});

/* ---------------------------------------------------------------------------
 * 2. AN UNDERPOWERED TERM CANNOT ADOPT — the release's thesis.
 * ------------------------------------------------------------------------- */
test('r94: an underpowered term cannot adopt, however large its coefficient', () => {
  const r = py(`${PRELUDE}
doc = run()
rows = {t['name']: t for t in doc['terms']}
rec = rows[b.PRIMARY_TERM]
assert rec['would_adopt'] is True, 'the fixture must contain a term that DOES adopt'
# Ten times the effect of interest, standard errors collapsed to nothing, and
# the powered flag cleared. Only the flag differs between the two calls below.
huge = dict(rec, powered=False,
            heldout_estimate=rec['heldout_estimate'] * 10.0,
            marginal_estimate=rec['heldout_estimate'] * 10.0,
            stratified_estimate=rec['heldout_estimate'] * 10.0,
            se_fold=1e-12, se_stadium=1e-12)
off_ok, off_reasons = b.would_adopt(huge)
on_ok, on_reasons = b.would_adopt(dict(huge, powered=True))
print(json.dumps({'off': [off_ok, off_reasons], 'on': [on_ok, on_reasons],
                  'underpowered': b.REFUSAL_UNDERPOWERED}))`);

  assert.equal(r.off[0], false,
    'a term with ten times its effect of interest and no standard error still '
    + 'adopted while powered was false');
  assert.deepEqual(r.off[1], [r.underpowered],
    'the ONLY refusal must be the power clause — anything else means the test is '
    + 'passing for the wrong reason');
  assert.equal(r.on[0], true,
    'restoring the powered flag alone must flip the identical record to adoptable, '
    + 'or the clause above was not what refused it');
  assert.deepEqual(r.on[1], []);

  // ...and the same implication across every measured row of every document.
  for (const [label, doc] of docs()) {
    for (const t of doc.terms) {
      if (t.powered === false) {
        assert.equal(t.would_adopt, false,
          `${label}: ${t.name} is not powered and still carries would_adopt true`);
        assert.ok(t.refused_reasons.includes('underpowered') || t.available === false,
          `${label}: ${t.name} is not powered but does not say so in refused_reasons`);
      }
      assert.equal(typeof t.powered, 'boolean',
        `${label}: ${t.name}.powered must be a plain boolean — the string "false" is truthy`);
      assert.equal(typeof t.would_adopt, 'boolean', `${label}: ${t.name}.would_adopt`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * 3. THE GRID IS IMMUTABLE AND IS THE MULTIPLICITY DIVISOR.
 * ------------------------------------------------------------------------- */
test('r94: the hypothesis grid is pre-registered and is the Bonferroni divisor', () => {
  const g = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import backtest_weather as b
print(json.dumps({'names': [h['name'] for h in b.HYPOTHESES], 'n_tests': b.N_TESTS,
                  'primary': b.PRIMARY_TERM, 'refusals': list(b.REFUSALS),
                  'verdicts': list(b.VERDICT_NAMES)}))`);

  assert.equal(g.n_tests, g.names.length,
    'N_TESTS must be len(HYPOTHESES): the multiplicity unit is the hypothesis, so '
    + 'grid resolution cannot move a bar but an added row raises every bar');
  assert.equal(new Set(g.names).size, g.names.length, 'duplicate hypothesis name');
  assert.ok(g.names.includes(g.primary), 'the primary term must be in the grid');

  for (const [label, doc] of docs()) {
    assert.equal(doc.adoption_rule.tests, g.names.length,
      `${label}: the artifact's published divisor disagrees with the grid it ran`);
    assert.equal(doc.adoption_rule.primary_term, g.primary, label);
    const got = doc.terms.map((t) => t.name);
    assert.deepEqual([...got].sort(), [...g.names].sort(),
      `${label}: the artifact's rows are not exactly the pre-registered grid`);
    for (const t of doc.terms) {
      for (const why of t.refused_reasons) {
        assert.ok(g.refusals.includes(why),
          `${label}: ${t.name} refused with "${why}", which is not a clause name`);
      }
    }
    assert.ok(g.verdicts.includes(doc.verdict.name),
      `${label}: verdict "${doc.verdict.name}" is outside the pre-registered set`);
  }
});

/* ---------------------------------------------------------------------------
 * 4. would_adopt RECOMPUTED HERE, from the artifact's own numbers and rule.
 * ------------------------------------------------------------------------- */
/* An independent re-implementation of the eight conjunctive clauses. It reads
 * ONLY what the artifact publishes — including its own min_fired and
 * fold_sign_min — so it needs no constant of its own and cannot drift into
 * agreeing with the producer by sharing its inputs. */
function recomputeRefusals(t, rule) {
  if (t.available === false) return { reasons: ['substrate_unavailable'], ambiguous: false };
  const reasons = [];
  let ambiguous = false;
  if (!t.powered) reasons.push('underpowered');                                  // (1)
  if (Math.min(t.n_wet, t.n_treated_rows) < rule.min_fired) reasons.push('too_few_fired'); // (2)
  const est = t.heldout_estimate;
  if (est === null) {
    reasons.push('unestimable');
  } else {
    const sign = t.pre_registered_sign;
    if (est * sign <= 0) reasons.push('wrong_sign');                             // (3)
    const thr = t.binding_threshold;                                             // (8)
    // The artifact rounds every float once at its boundary, so an estimate that
    // sits within a rounding step of its threshold is genuinely undecidable from
    // the published numbers. Say so rather than guess.
    if (thr !== null && Math.abs(Math.abs(est) - thr) <= 2e-6) ambiguous = true;
    if (thr === null || Math.abs(est) < thr || est * sign <= 0) {
      if (!reasons.includes('below_threshold')) reasons.push('below_threshold');
    }
  }
  if (!t.monotone) reasons.push('non_monotone');                                 // (4)
  if (t.confounded) reasons.push('confounded');                                  // (5)
  if (t.rows_moved <= 0) reasons.push('no_rows_moved');                          // (6)
  if (t.folds_sign < rule.fold_sign_min) reasons.push('fold_sign_disagrees');    // (7)
  return { reasons, ambiguous };
}

test('r94: would_adopt is recomputable from the artifact alone, row by row', () => {
  let checked = 0;
  for (const [label, doc] of docs()) {
    const rule = doc.adoption_rule;
    assert.ok(Number.isInteger(rule.min_fired) && rule.min_fired > 0, label);
    assert.ok(Number.isInteger(rule.fold_sign_min) && rule.fold_sign_min > 0, label);
    for (const t of doc.terms) {
      const { reasons, ambiguous } = recomputeRefusals(t, rule);
      if (ambiguous) continue;
      assert.deepEqual([...t.refused_reasons].sort(), [...reasons].sort(),
        `${label}: ${t.name} publishes refusals that its own numbers do not imply`);
      assert.equal(t.would_adopt, reasons.length === 0,
        `${label}: ${t.name}.would_adopt disagrees with its own published numbers`);
      assert.equal(t.would_adopt, t.refused_reasons.length === 0,
        `${label}: ${t.name} adopts while naming a refusal, or refuses namelessly`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `too few rows recomputed (${checked}) for this to mean anything`);
});

/* ---------------------------------------------------------------------------
 * 5. THE STRATIFIED-POWER IDENTITY.
 * ------------------------------------------------------------------------- */
test('r94: every term is powered on its OWN analysis sample', () => {
  for (const [label, doc] of docs()) {
    const byName = Object.fromEntries(doc.terms.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(doc.power).sort(), Object.keys(byName).sort(),
      `${label}: the power table and the term list are not the same set of terms`);
    let stratified = 0;
    for (const [name, p] of Object.entries(doc.power)) {
      const t = byName[name];
      // Absolute n, not a ratio: a power stage that silently doubled every
      // sample handed to it would survive a ratio-only assertion.
      assert.equal(p.n_treated, t.n_wet,
        `${label}: ${name} was powered on ${p.n_treated} treated units and estimated on ${t.n_wet}`);
      assert.equal(p.n_control, t.n_dry, `${label}: ${name} control n`);
      // ...and BOTH of them are the ESTIMATION sample's n. An identity between
      // two numbers that are both five-season counts, while every coefficient
      // and every error bar is four-season, certifies the defect instead of
      // catching it — the season-filtered recount below is what makes this lock
      // mean something.
      assert.deepEqual(doc.substrate.power_seasons,
        doc.seasons_scored,
        `${label}: the power table's seasons are not the scored folds`);
      assert.ok(!doc.substrate.power_training_seasons.includes(doc.substrate.holdout_season),
        `${label}: the power stage may read the held-out season's outcomes`);
      assert.equal(p.analysis_sample, t.analysis_sample,
        `${label}: ${name} was powered on the ${p.analysis_sample} sample and estimated `
        + `on the ${t.analysis_sample} one — that is how a headline gets sold on power it lacks`);
      assert.ok(['marginal', 'stratified'].includes(p.analysis_sample), `${label}: ${name}`);
      assert.equal(p.effect_of_interest, t.effect_of_interest, `${label}: ${name} bar`);
      // powered is a comparison of the MDE against the bar, never a free flag.
      if (p.mde === null) {
        assert.equal(p.powered, false,
          `${label}: ${name} has no MDE and is nevertheless powered`);
      } else {
        assert.equal(p.powered, p.mde <= p.effect_of_interest,
          `${label}: ${name} powered=${p.powered} with mde ${p.mde} against ${p.effect_of_interest}`);
      }
      // CLAUSE 1 IS A CONJUNCTION, and this is the lock that stops the two MDEs
      // being published in contradiction. The model-based MDE is a pooled
      // two-arm binomial; the realized one is the estimator's own binding
      // clustered error. On the real corpus the model SE runs up to 2.1x
      // smaller, always flattering, so a `powered` read off the model number
      // alone asserts a detection capability the estimator does not have.
      const z = doc.adoption_rule.mde_z;
      const ses = [t.se_fold, t.se_stadium].filter((x) => x !== null);
      if (ses.length === 0) {
        assert.equal(t.mde_realized, null,
          `${label}: ${name} has no clustered error and still publishes a realized MDE`);
      } else {
        const expect = z * Math.max(...ses);
        assert.ok(Math.abs(t.mde_realized - expect) <= 1e-5,
          `${label}: ${name} publishes mde_realized ${t.mde_realized}, but `
          + `mde_z * max(se_fold, se_stadium) is ${expect}`);
      }
      const realizedOk = t.mde_realized !== null && t.mde_realized <= t.effect_of_interest;
      assert.equal(t.powered, p.powered && realizedOk,
        `${label}: ${name}.powered is ${t.powered} with model mde ${p.mde} and `
        + `realized mde ${t.mde_realized} against a bar of ${t.effect_of_interest} — `
        + 'powered must require BOTH');
      if (t.powered) {
        assert.ok(t.mde_realized <= t.effect_of_interest,
          `${label}: ${name} is powered with a realized MDE above its own bar`);
        assert.ok(p.mde !== null && p.mde <= p.effect_of_interest,
          `${label}: ${name} is powered with a model MDE above its own bar`);
      }
      if (p.analysis_sample === 'stratified') stratified += 1;
    }
    assert.ok(stratified > 0,
      `${label}: no term is powered on a stratified sample, so the stratification `
      + 'rule costs nothing and therefore does nothing');
  }
});

/* ---------------------------------------------------------------------------
 * 5b. THE POWER n IS THE ESTIMATION n — RECOUNTED, SEASON BY SEASON.
 * ------------------------------------------------------------------------- *
 * R94 P0-A. The producer used to build the analysis sample over all five
 * seasons and hand THAT to the power stage, while every inference quantity is
 * computed on the four SCORED folds. The neutral first fold fits nothing, so
 * its trials inflated n_treated, shrank the SE and shrank the MDE — `powered`
 * decided on more data than the coefficient was ever fitted on. Asserting
 * n_treated === n_wet could not catch it, because both numbers carried the same
 * inflation. So this lock recounts the treated denominator from the ROWS, twice
 * — once over every season and once over the scored folds only — and requires
 * the published n to be the SCORED one. The `differs` assertion is what stops
 * the recount being satisfied by a corpus where the filter happens to be a
 * no-op. */
test('r94: power.n_treated is a recount of the SCORED rows, not of every season', () => {
  const r = py(`${PRELUDE}
# Spy on the samples the producer builds, BEFORE the power stage filters them,
# and recount each term's treated/control denominator from the rows directly.
seen = {}
orig = b.power_stage
def spy(samples, hypotheses=b.HYPOTHESES, training_seasons=b.POWER_TRAINING_SEASONS):
    for k, v in samples.items():
        seen[k] = list(v)
    return orig(samples, hypotheses, training_seasons)
b.power_stage = spy
doc = run()
b.power_stage = orig

scored = set(b.SCORED_FOLDS)
def denom(term, rows, treated):
    hit = [r for r in rows if b.term_treated(term, r) == treated]
    if term['kind'] == 'rate':
        return int(round(sum(b.term_weight(term, r) for r in hit)))
    return len(hit)

by_name = dict((h['name'], h) for h in b.HYPOTHESES)
recount = {}
for name, rows in seen.items():
    term = by_name[name]
    fitted = [r for r in rows if r['season'] in scored]
    recount[name] = {
        'all_seasons': denom(term, rows, True),
        'scored': denom(term, fitted, True),
        'scored_control': denom(term, fitted, False),
    }
print(json.dumps({'power': doc['power'],
                  'terms': dict((t['name'], t) for t in doc['terms']),
                  'recount': recount,
                  'scored_folds': [str(x) for x in b.SCORED_FOLDS],
                  'all_seasons': [str(x) for x in b.SEASONS]}));
`);

  assert.ok(r.all_seasons.length > r.scored_folds.length,
    'there is no neutral fold in this corpus, so this lock proves nothing');
  let differs = 0;
  let checked = 0;
  for (const [name, counts] of Object.entries(r.recount)) {
    const p = r.power[name];
    const t = r.terms[name];
    assert.equal(p.n_treated, counts.scored,
      `${name}: powered on ${p.n_treated} treated units, but only ${counts.scored} `
      + `of them are in a scored fold (${counts.all_seasons} across every season)`);
    assert.equal(p.n_control, counts.scored_control, `${name}: control n`);
    assert.equal(t.n_wet, counts.scored,
      `${name}: n_wet ${t.n_wet} is not the scored-fold recount ${counts.scored}`);
    if (counts.all_seasons > counts.scored) differs += 1;
    checked += 1;
  }
  assert.ok(checked >= 5, `too few terms recounted (${checked})`);
  assert.ok(differs > 0,
    'the scored-fold filter changed no term\'s n, so this recount would pass '
    + 'unchanged against the unfiltered sample and locks nothing');
});

/* ---------------------------------------------------------------------------
 * 5c. NO DOSE-RESPONSE IS DECIDED BY A CELL TOO SMALL TO VOTE.
 * ------------------------------------------------------------------------- *
 * R94 P1-B. is_monotone had no minimum band size, so a band holding one row
 * carried the weight of a band holding 1,264 — and clause 4 is conjunctive in
 * both directions, so such a cell could certify a dose-response as easily as
 * refuse one. The ladder still PUBLISHES every band with its n (an
 * under-weighted cell is a fact about the corpus); it is the ladder's SHAPE
 * that is decided on bands clearing adoption_rule.min_band_n.
 *
 * The ladder is ALSO tabulated on the scored rows now, like every other
 * published quantity, which gives this lock an exact arithmetic identity to
 * hold: the five band n's must sum to n_treated_rows + n_control_rows. A ladder
 * counted over a wider sample than the coefficient was fitted on would break
 * that sum, so clause 4 can no longer be decided on rows the estimator never
 * saw — which was the last place in the artifact where it could be. */
test('r94: monotone is decided only on bands that clear the published floor', () => {
  for (const [label, doc] of docs()) {
    const floor = doc.adoption_rule.min_band_n;
    assert.ok(Number.isInteger(floor) && floor > 1,
      `${label}: min_band_n is not a published integer floor`);
    for (const t of doc.terms) {
      const voting = t.dose_response.filter((b) => b.value !== null && b.n >= floor);
      // THE LADDER IS THE ESTIMATION SAMPLE. Exact, not approximate: every row
      // the term is fitted on lands in exactly one of the five bands, so the
      // band n's sum to the term's own row counts. This is what stops clause 4
      // being decided on a wider table than the coefficient (R94, the last
      // instance of the P0-A species).
      const bandRows = t.dose_response.reduce((acc, b) => acc + b.n, 0);
      if (t.available) {
        assert.equal(bandRows, t.n_treated_rows + t.n_control_rows,
          `${label}: ${t.name} tabulates ${bandRows} rows across its five bands `
          + `while the coefficient is fitted on ${t.n_treated_rows + t.n_control_rows} `
          + '— the ladder is not the estimation sample');
      }
      // Too few voting bands is not a shape, and must never read as one. This
      // is the branch a narrow sample plus a floor actually lands in: zero
      // voting bands is a normal outcome, not an error.
      if (voting.length < 3) {
        assert.equal(t.monotone, false,
          `${label}: ${t.name} publishes monotone:true on ${voting.length} band(s) `
          + `clearing the ${floor}-row floor — fewer than three is not a ladder`);
      }
      if (t.monotone) {
        assert.ok(voting.length >= 3,
          `${label}: ${t.name} is monotone on ${voting.length} bands that clear `
          + `the ${floor}-row floor — a shape needs at least three`);
        // Recomputed here, in JS, from the surviving bands alone.
        const sign = t.pre_registered_sign;
        let moved = false;
        for (let i = 1; i < voting.length; i += 1) {
          const delta = (voting[i].value - voting[i - 1].value) * sign;
          assert.ok(delta >= 0,
            `${label}: ${t.name} publishes monotone:true while its `
            + `${voting[i - 1].band} -> ${voting[i].band} step moves the wrong way`);
          if (delta > 0) moved = true;
        }
        assert.ok(moved,
          `${label}: ${t.name} publishes monotone:true on a flat ladder`);
      }
      for (const band of t.dose_response) {
        assert.ok(Number.isInteger(band.n) && band.n >= 0,
          `${label}: ${t.name} band ${band.band} publishes no n`);
      }
    }
  }
});

/* ---------------------------------------------------------------------------
 * 6. THE FOLD BARRIER, both directions.
 * ------------------------------------------------------------------------- */
test('r94: fold Y fits only seasons strictly before Y, and the first fold fits nothing', () => {
  for (const [label, doc] of docs()) {
    const folds = doc.substrate.folds;
    assert.ok(folds.length >= 2, label);
    for (const f of folds) {
      for (const fit of f.fit_seasons) {
        assert.ok(fit < f.season,
          `${label}: fold ${f.season} fits ${fit}, which is not strictly before it`);
      }
    }
    const first = folds[0];
    assert.deepEqual(first.fit_seasons, [],
      `${label}: the first fold fits something — it has nothing to fit`);
    assert.equal(first.neutral, true,
      `${label}: the first fold must be reported neutral-and-counted, never dropped`);
    assert.equal(first.scored, false, label);
    const scored = folds.filter((f) => f.scored).map((f) => String(f.season));
    assert.deepEqual(scored, doc.seasons_scored,
      `${label}: seasons_scored disagrees with the folds that were actually scored`);
    assert.equal(scored.length, folds.length - 1,
      `${label}: exactly one fold — the first — may go unscored`);
    assert.ok(!scored.includes(String(first.season)), label);
    assert.equal(doc.substrate.perfect_foresight, true,
      `${label}: the weather arm is fitted on reanalysis; claiming otherwise would `
      + 'make an oracle result look adoptable');
    assert.equal(doc.substrate.weather_role, 'label', label);
    assert.ok(!doc.substrate.training_seasons.includes(doc.substrate.holdout_season),
      `${label}: the held-out season is also a training season`);
  }
});

/* ---------------------------------------------------------------------------
 * 7 + 8. THE RELOCATION FILTER AS A PROPERTY; THE CORPUS NEVER REWRITTEN.
 * ------------------------------------------------------------------------- */
test('r94: the relocation filter lives in the reader and drops at least one row', () => {
  for (const [label, doc] of docs()) {
    const cf = doc.corpus_filter;
    // Properties, never the hard literal 874: a games_meta refresh from
    // daily.yml must be able to move these counts without reddening the lock.
    assert.ok(cf.rows_read > 0, label);
    assert.equal(cf.rows_read - cf.rows_unjoined, cf.rows_joined,
      `${label}: a row that failed to join was swallowed rather than reported`);
    assert.equal(cf.rows_joined - cf.dropped_relocations, cf.rows_kept,
      `${label}: the survivor count is not the joined count minus the relocations`);
    assert.ok(cf.dropped_relocations >= 1,
      `${label}: no relocation was dropped — a filter that never fires is not a filter`);
    assert.ok(cf.rows_kept < cf.rows_read, label);
    assert.equal(cf.roof_check_ok, true,
      `${label}: a survivor of the venue filter is not an outdoor game`);
    assert.equal(cf.roof_check, 'all survivors outdoors', label);
    // The roof census keeps the retractables OPEN bucket out of both pooled
    // arms, because opening a roof is itself a weather decision.
    const census = doc.roof_census;
    assert.ok(census.games.treated > 0 && census.games.placebo > 0, label);
    assert.ok(!census.vocabulary.treated.includes('open')
      && !census.vocabulary.placebo.includes('open'),
      `${label}: an open retractable was pooled into a treated or placebo arm`);
  }
});

test('r94: data/weather_history.json is byte-identical before and after a full run', () => {
  const onDisk = createHash('sha256').update(readFileSync(WEATHER_HISTORY)).digest('hex');
  const r = real();
  assert.equal(r.sha_before, onDisk,
    'python and node disagree about the corpus digest before the run');
  assert.equal(r.sha_after, onDisk,
    'the corpus was rewritten by a measurement run — the relocation filter belongs '
    + 'in the reader, and the r56 exact-equality pins depend on this file not moving');
  assert.equal(r.doc.weather_history_sha256, onDisk,
    'the artifact publishes a digest that is not the digest of the file it read');
  if (existsSync(ARTIFACT)) {
    const disk = readJson(ARTIFACT);
    assert.match(disk.weather_history_sha256, /^[0-9a-f]{64}$/,
      'the artifact must publish a real digest, so the never-rewritten claim is checkable');
  }
});

/* ---------------------------------------------------------------------------
 * 9. ZEROS PRESENT, NOT MISSING.
 * ------------------------------------------------------------------------- */
test('r94: every pre-registered condition is present for every season, zeros included', () => {
  const c = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import weather_corpus as wc
print(json.dumps({'conditions': list(wc.CONDITIONS),
                  'precip': list(wc.PRECIP_BAND_NAMES),
                  'wind': list(wc.WIND_BAND_NAMES),
                  'total': wc.TOTAL_NAME}))`);

  for (const [label, doc] of docs()) {
    const cond = doc.conditions;
    const seasons = Object.keys(cond[c.total]);
    assert.ok(seasons.length >= 2, label);
    for (const name of c.conditions) {
      assert.ok(Object.prototype.hasOwnProperty.call(cond, name),
        `${label}: condition "${name}" is absent — a band that never fired must read 0, `
        + 'because a missing key and a zero are different claims');
      for (const s of seasons) {
        const n = cond[name][s];
        assert.ok(Number.isInteger(n) && n >= 0,
          `${label}: conditions.${name}.${s} is ${n}`);
      }
    }
    assert.ok(['team_game', 'game'].includes(doc.conditions_unit),
      `${label}: a count whose unit is not stated is not a count`);
    // Both five-band families are partitions: every scored unit lands in
    // exactly one band, so each family sums to the total for every season.
    for (const family of [c.precip, c.wind]) {
      for (const s of seasons) {
        const sum = family.reduce((a, b) => a + cond[b][s], 0);
        assert.equal(sum, cond[c.total][s],
          `${label}: the ${family[0].split('_')[0]} bands sum to ${sum} in ${s} `
          + `against a total of ${cond[c.total][s]} — they are meant to partition the sample`);
      }
    }
  }
});

/* ---------------------------------------------------------------------------
 * 10. THE BINDING THRESHOLD IS THE LARGER THRESHOLD, NEVER THE LARGER SE.
 * ------------------------------------------------------------------------- */
test('r94: the binding threshold is the larger threshold, not the larger standard error', () => {
  const r = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import backtest_weather as b
# The stadium clustering carries TWICE the SE and still loses, because at 3 df
# the t multiplier is about twice the 20 df one. Choosing on SE here would hand
# back the LOWER bar, which is the defect this rule closes.
tight, df_tight = b.binding(0.010, 3, 0.020, 20, 0.0)
loose, df_loose = b.binding(0.002, 3, 0.020, 20, 0.0)
floor_case, _fdf = b.binding(1e-12, 3, 1e-12, 20, 0.25)
none_case, none_df = b.binding(None, 3, None, 20, 0.0)
half_case, half_df = b.binding(None, 3, 0.020, 20, 0.0)
print(json.dumps({
    'tight': [tight, df_tight, b.threshold_for(0.010, 3, 0.0), b.threshold_for(0.020, 20, 0.0)],
    'loose': [loose, df_loose, b.threshold_for(0.002, 3, 0.0), b.threshold_for(0.020, 20, 0.0)],
    'floor': floor_case, 'none': [none_case, none_df], 'half': [half_case, half_df]}))`);

  const [tThr, tDf, tFold, tStad] = r.tight;
  assert.ok(tStad > tFold * 0 && 0.020 > 0.010, 'the stadium SE is the larger one here');
  assert.equal(tDf, 3,
    'the fold clustering carried the larger THRESHOLD and must therefore bind, even '
    + 'though the stadium clustering carried the larger SE');
  assert.equal(tThr, Math.max(tFold, tStad));
  const [lThr, lDf, lFold, lStad] = r.loose;
  assert.equal(lDf, 20, 'shrinking the fold SE must reverse the choice');
  assert.equal(lThr, Math.max(lFold, lStad));
  assert.ok(lThr > 0 && tThr > 0);
  assert.equal(r.floor, 0.25,
    'with both standard errors at nothing, the per-outcome effect floor must bind');
  assert.deepEqual(r.none, [null, null],
    'no standard error means NO threshold — an unestimable term must not clear a bar '
    + 'by having no error bar');
  assert.equal(r.half[1], 20, 'one clustering missing leaves the other binding');

  for (const [label, doc] of docs()) {
    for (const t of doc.terms) {
      if (t.binding_threshold === null) {
        assert.ok(t.would_adopt === false,
          `${label}: ${t.name} adopted with no binding threshold`);
        continue;
      }
      assert.ok(t.binding_threshold >= doc.adoption_rule.effect_floor[t.outcome],
        `${label}: ${t.name}'s threshold sits under its own per-outcome effect floor`);
      assert.ok([t.se_fold, t.se_stadium].some((s) => s !== null), `${label}: ${t.name}`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * 11. NOTHING FIRES WHEN NOTHING IS WET.
 * ------------------------------------------------------------------------- */
test('r94: with the wet threshold absurdly high, nothing fires and the verdict is not_powered', () => {
  const r = py(`${PRELUDE}
# 10,000 mm of rain in an hour. The grid is passed in rather than mutated, so
# the module's own pre-registered constants are untouched.
hyp = tuple(dict(h, threshold_mm=10000.0) if 'threshold_mm' in h else h
            for h in b.HYPOTHESES)
doc = run(hypotheses=hyp)
rain = [t for t in doc['terms'] if t['name'].startswith('rain')]
print(json.dumps({'verdict': doc['verdict']['name'], 'adopted': doc['verdict']['adopted'],
                  'rain': [{'name': t['name'], 'n_wet': t['n_wet'],
                            'rows_moved': t['rows_moved'],
                            'would_adopt': t['would_adopt']} for t in rain]}))`);

  assert.ok(r.rain.length >= 5, 'the grid must still carry its rain terms');
  for (const t of r.rain) {
    assert.equal(t.n_wet, 0, `${t.name} fired on a 10,000 mm threshold`);
    assert.equal(t.rows_moved, 0, `${t.name} moved a scored row with nothing wet`);
    assert.equal(t.would_adopt, false, `${t.name} adopted on an empty treated arm`);
  }
  assert.equal(r.verdict, 'not_powered',
    'with the primary term unable to fire at all, the verdict must fall to not_powered '
    + 'rather than promoting a companion term past it');
  assert.equal(r.adopted, false);
});

/* ---------------------------------------------------------------------------
 * 12. NOTHING LIVE MOVES.
 * ------------------------------------------------------------------------- */
test('r94: this release adopts nothing and registers nothing', () => {
  for (const [label, doc] of docs()) {
    assert.equal(doc.verdict.adopted, false, `${label}: verdict.adopted`);
    assert.deepEqual(doc.verdict.families_registered, [],
      `${label}: a signal family was registered by a measure-only release`);
    assert.equal(doc.verdict.oracle_only, true,
      `${label}: the effect arm is fitted on reanalysis, so any winner is oracle-only`);
    assert.equal(doc.kind, 'weather_backtest', label);
    assert.ok(Array.isArray(doc.policy) && doc.policy.length >= 4, label);
    assert.ok(Array.isArray(doc.limits) && doc.limits.length >= 5, label);
  }
});

test('r94: the live model is untouched — no game parameter, no new family, no divisor move', () => {
  const tuning = readJson(TUNING);
  const gp = tuning.game_params || {};
  assert.deepEqual(Object.keys(gp).sort(),
    ['adopted_utc', 'hfa_elo', 'k', 'qb_out', 'revert', 'source'],
    'game_params gained a key: R94 measures and adopts nothing on the game side');
  for (const key of Object.keys(gp)) {
    assert.ok(!/weather|wind|rain|precip/i.test(key),
      `game_params carries a weather key (${key}) that this release must not have added`);
  }
  // The promotion gate's own archived record: weather_wind is a CANDIDATE that
  // is measured every run and has never been adopted, and the Bonferroni
  // divisor has not moved.
  const runs = (tuning.history || []).filter(
    (h) => h && h.kind === 'signal_promotion' && h.format === 2);
  assert.ok(runs.length > 0, 'no archived promotion run to read');
  assert.equal(runs[0].families_runnable, 13,
    'the promotion gate\'s Bonferroni divisor moved — R94 registers no family, so it '
    + 'must not');
  let seen = 0;
  for (const r of runs) {
    for (const f of r.families || []) {
      if (!/weather/.test(f.family || '')) continue;
      seen += 1;
      assert.notEqual(f.adopted, true,
        `an archived run adopted ${f.family}; the docs call it a candidate`);
    }
  }
  assert.ok(seen > 0, 'no archived run measured a weather family at all');
});

test('r94: no file under app/ reads the measurement artifact', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = walk(join(REPO_ROOT, 'app')).filter((p) => /\.(js|mjs|html|css)$/.test(p));
  assert.ok(files.length > 20,
    `the app walk found only ${files.length} files — a walk that finds nothing proves nothing`);
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    for (const needle of ['weather_backtest', 'wet_rates', 'weather_forecast_archive']) {
      assert.ok(!src.includes(needle),
        `${p} reads ${needle}: this release ships a measurement, not a number the client renders`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * 13. THE MARKET BOUNDARY, AS A RUNTIME VALUE.
 * ------------------------------------------------------------------------- */
/* Collect every key and every string in a document. Checking the VALUES the
 * code produced is stronger than grepping its source: a grep proves a word is
 * missing from a file, this proves a betting column never arrived anywhere. */
function tokensOf(node, out = new Set()) {
  if (typeof node === 'string') { out.add(node); return out; }
  if (Array.isArray(node)) { for (const v of node) tokensOf(v, out); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { out.add(k); tokensOf(v, out); }
  }
  return out;
}

test('r94: no market column reaches the reader, the artifact or the contracts', () => {
  const r = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import weather_corpus as wc
corpus = wc.load_corpus()
keys = set()
for row in corpus['rows'].values():
    keys.update(row.keys())
print(json.dumps({'allow': list(wc.META_ALLOW), 'row_fields': sorted(keys),
                  'declared': list(wc.ROW_FIELDS)}))`);

  // The reader projects games_meta through a POSITIVE allow-list, so a betting
  // column living in that same fixture is dropped at the door.
  for (const col of BETTING_COLUMNS) {
    assert.ok(!r.allow.includes(col), `the reader's allow-list admits ${col}`);
  }
  assert.deepEqual(r.row_fields.sort(), [...r.declared].sort(),
    'a row carries a field the reader does not declare — the allow-list leaked');
  for (const f of r.row_fields) {
    assert.ok(!BETTING_COLUMNS.includes(f), `a corpus row carries the column ${f}`);
  }

  const surfaces = [...docs().map(([l, d]) => [l, d])];
  for (const p of CONTRACTS) surfaces.push([p, readJson(p)]);
  for (const [label, doc] of surfaces) {
    const tokens = tokensOf(doc);
    for (const col of BETTING_COLUMNS) {
      assert.ok(!tokens.has(col),
        `${label} names the betting column ${col}: a measurement that reads a price is `
        + 'not measuring the weather');
      for (const tok of tokens) {
        assert.ok(!tok.includes(col), `${label} embeds the betting column ${col} in "${tok}"`);
      }
    }
  }
});

/* ---------------------------------------------------------------------------
 * 14. STDLIB ONLY.
 * ------------------------------------------------------------------------- */
test('r94: every R94 module imports the standard library and nothing else', () => {
  const loaded = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import weather_corpus, weather_power, build_wet_rates
from scripts import backtest_weather, archive_weather_forecast
third = ('numpy', 'pandas', 'scipy', 'sklearn', 'requests', 'yaml', 'matplotlib')
print(json.dumps(sorted(m for m in sys.modules if m.split('.')[0] in third)))`);
  assert.deepEqual(loaded, [],
    `importing the R94 modules pulled in ${loaded.join(', ')}: this repo has no build `
    + 'step and no third-party runtime, so a dependency here is a dependency the cron cannot install');
});

/* ---------------------------------------------------------------------------
 * 15. THE SHIPPED MULTIPLIERS ARE UNTOUCHED.
 * ------------------------------------------------------------------------- */
test('r94: build_weekly still returns exactly the shipped weather multipliers', () => {
  const w = py(`
import sys, json
sys.path.insert(0, '.')
from scripts import build_weekly as bw
print(json.dumps({
    'dome': bw.weather_factor('QB', 'dome'),
    'outdoors': bw.weather_factor('QB', 'outdoors', temp_c=10.0),
    'cold': bw.weather_factor('QB', 'outdoors', temp_c=-5.0),
    'rb_windy': bw.weather_factor('RB', 'outdoors', wind_kph=30.0),
    'rb_calm': bw.weather_factor('RB', 'outdoors', wind_kph=5.0),
    'rules': list(bw.WEATHER_RULES)}))`);

  assert.deepEqual(w.dome, [1.03, false], 'the dome passing multiplier moved');
  assert.deepEqual(w.outdoors, [0.97, false], 'the outdoor passing multiplier moved');
  assert.deepEqual(w.cold, [0.97 * 0.97, false], 'the cold extra moved');
  assert.deepEqual(w.rb_windy, [0.95, false], 'the rb_wind penalty moved');
  assert.deepEqual(w.rb_calm, [1.0, false], 'rb_wind fired below its own threshold');
  assert.deepEqual(w.rules, ['cold', 'wind'],
    'WEATHER_RULES gained a precipitation rule: R94 measured rain and adopted nothing, '
    + 'so no rain term may have been wired into the shipped factor');
});

/* ---------------------------------------------------------------------------
 * THE ARTIFACT: valid against its own closed contract, absent or present.
 * ------------------------------------------------------------------------- */
test('r94: the measurement validates against its contract, and says so about itself', () => {
  const r = py(`${PRELUDE}
import os, tempfile
from scripts import validate_data as vd
schema = json.load(open('data/contracts/weather_backtest.schema.json'))
def errs(doc):
    out = []
    vd._validate(doc, schema, 'doc', out)
    return out
syn = run()
realdoc = b.measure(control=b.unavailable_control(),
                    reach=b.reach_arm(None, pool_doc={}, calib_doc={}),
                    now_utc='2026-01-01T00:00:00Z')
disk = None
if os.path.exists('data/weather_backtest.json'):
    disk = errs(json.load(open('data/weather_backtest.json')))
# A closed contract that accepts a lie is not a contract. Each mutation below
# is a way this document could claim more than it measured.
liar = copy.deepcopy(syn)
liar['verdict']['adopted'] = True
liar2 = copy.deepcopy(syn)
liar2['verdict']['families_registered'] = ['weather_wind']
liar3 = copy.deepcopy(syn)
liar3['terms'][0]['powered'] = 'false'
liar4 = copy.deepcopy(syn)
del liar4['terms'][0]['n_wet']
liar5 = copy.deepcopy(syn)
liar5['terms'][0]['refused_reasons'] = ['because']
print(json.dumps({'syn': errs(syn), 'real': errs(realdoc), 'disk': disk,
                  'adopted_true': len(errs(liar)), 'family': len(errs(liar2)),
                  'string_false': len(errs(liar3)), 'no_n_wet': len(errs(liar4)),
                  'bad_reason': len(errs(liar5))}))`);

  assert.deepEqual(r.syn, [], 'the synthetic measurement does not satisfy its own contract');
  assert.deepEqual(r.real, [], 'the real-corpus measurement does not satisfy its own contract');
  if (r.disk !== null) {
    assert.deepEqual(r.disk, [],
      'the runner-built artifact on disk does not satisfy its own contract');
  }
  assert.ok(r.adopted_true > 0, 'the contract accepts verdict.adopted true');
  assert.ok(r.family > 0, 'the contract accepts a registered signal family');
  assert.ok(r.string_false > 0,
    'the contract accepts powered as the STRING "false", which is truthy everywhere');
  assert.ok(r.no_n_wet > 0, 'the contract accepts a term with no n_wet');
  assert.ok(r.bad_reason > 0, 'the contract accepts a refusal outside the clause enum');
});

test('r94: the placebo arm is a diagnostic with an interval, never a gate', () => {
  for (const [label, doc] of docs()) {
    const pl = doc.placebo;
    assert.ok(Array.isArray(pl.terms) && pl.terms.length > 0, label);
    const names = new Set(doc.terms.map((t) => t.name));
    for (const p of pl.terms) {
      assert.ok(names.has(p.term),
        `${label}: the placebo row "${p.term}" is not one of the measured terms`);
      // A placebo row that carried powered / would_adopt would be a second gate
      // wearing a diagnostic's clothes.
      assert.ok(!Object.prototype.hasOwnProperty.call(p, 'powered'),
        `${label}: the placebo row ${p.term} carries a powered flag`);
      assert.ok(!Object.prototype.hasOwnProperty.call(p, 'would_adopt'),
        `${label}: the placebo row ${p.term} carries a would_adopt flag`);
      assert.ok(!Object.prototype.hasOwnProperty.call(p, 'refused_reasons'),
        `${label}: the placebo row ${p.term} names a refusal clause`);
      // An interval, or an honest null when the arm could not be estimated at
      // all — never a bare point estimate presented as if it were resolved.
      if (p.se === null) {
        assert.equal(p.ci95, null,
          `${label}: the placebo row ${p.term} reports an interval with no standard error`);
      } else {
        assert.ok(Array.isArray(p.ci95) && p.ci95.length === 2,
          `${label}: the placebo row ${p.term} has a standard error and no interval`);
        assert.ok(p.ci95[0] <= p.estimate && p.estimate <= p.ci95[1],
          `${label}: the placebo row ${p.term}'s estimate sits outside its own interval`);
      }
    }
    assert.ok(pl.note.length > 20, `${label}: the placebo arm must say what it is not`);
  }
});
