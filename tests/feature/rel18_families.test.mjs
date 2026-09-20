/* tests/feature/rel18_families.test.mjs — the Rel18 family REGISTRATION, locked.
 *
 * docs/roadmap/rel18/SOLUTION_DESIGN.md specifies this file and it was never
 * written. Its absence is not academic: two other specs (rel7_contracts and
 * tests/web/web.spec.mjs) had the pre-Rel18 EIGHT-family list frozen into them,
 * and nothing in the suite asserted the thirteen-family reality, so the
 * conflict was invisible until the weekly cron would have written a real entry
 * and turned two of the four gate steps red at once.
 *
 * WHY THIS ASSERTS AGAINST THE SOURCE, NOT ONLY THE ARCHIVE.
 * data/model_tuning.json is a cron-written ARCHIVE. It holds entries from
 * before Rel18 existed and will hold entries from after the next family lands,
 * so a bare `families_tested === 13` against "the newest entry" is the same
 * time bomb in a new file. The registration facts live in scripts/ and are
 * asserted there; the archived entry is then checked for the invariants that
 * must hold of ANY entry, plus the full Rel18 shape whenever the entry is one a
 * Rel18 gate actually produced (it carries a `significance` block — pre-Rel18
 * runs cannot, the block did not exist).
 *
 * What must stay true:
 *   1. thirteen families are registered in promote_signals, no more, no fewer;
 *   2. REFEREE IS NOT ONE OF THEM — not in the registry, and never in any
 *      archived families[]. SOLUTION_DESIGN R1 cut it because a non-appliable
 *      family that wins a run used to suppress adoption entirely. It stays a
 *      game-context FIELD and a separate diagnostic;
 *   3. divisional's signed grid really is 6 x 5 = 30 trials — the single
 *      largest contributor to the run's Bonferroni multiplicity;
 *   4. scheme_matchup declares its APPLICATION PATH DARK (FTN has no 2026
 *      release), so it can never be reported as applied to the live season;
 *   5. the four deliberately-unwired families are absent from APPLIABLE, and
 *      divisional — the only wired new one — is present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const readData = (rel) =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'data', rel), 'utf8'));

/* Every family the gate registers, in the order promote_signals appends them.
 * Eight core (pre-Rel18) + five Rel18 candidates. */
const CORE_FAMILIES = ['environment', 'rest', 'epa_total', 'epa_pass',
  'elo_epa', 'weather_wind', 'qb_out', 'skill_out'];
const REL18_FAMILIES = ['divisional', 'coach_quality', 'coach_regime',
  'dvp_mismatch', 'scheme_matchup'];
/* R92 added the owner's QB cascade as one family. It is WIRED (build_predictions
 * prices it through promote_signals.qb_depth_delta) and therefore appliable,
 * and it GENERALISES qb_out — the two may never be applied together, which the
 * gate enforces by stacking qb_depth on the incumbent minus qb_out. */
const R92_FAMILIES = ['qb_depth'];
const PRE_R92_FAMILIES = [...CORE_FAMILIES, ...REL18_FAMILIES];
const ALL_FAMILIES = [...PRE_R92_FAMILIES, ...R92_FAMILIES];

/* Families the prediction pipeline can actually apply. The four Rel18 families
 * outside this set are measured-only by design; claiming otherwise would be the
 * dishonesty the APPLIABLE guard exists to prevent. */
const REL18_UNWIRED = ['coach_quality', 'coach_regime', 'dvp_mismatch',
  'scheme_matchup'];

function py(script) {
  const out = execFileSync('python3', ['-c', script], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function latestV2() {
  const doc = readData('model_tuning.json');
  const entry = (doc.history || []).find(
    (h) => h && h.kind === 'signal_promotion' && h.format === 2);
  return { doc, entry };
}

test('rel18: fourteen families are registered, and referee is not one of them', () => {
  const src = readFileSync(PROMOTE, 'utf8');
  // Registration is the `families.append({"family": ...)` call — that is what
  // actually puts a family into the run. Reading the SOURCE rather than an
  // archived entry means a family added without a spec update fails HERE, on
  // the checkout that added it, not on the cron three days later.
  const registered = [...src.matchAll(/families\.append\(\{"family": "([a-z_]+)"/g)]
    .map((m) => m[1]);
  // epa_total / epa_pass are appended through a loop variable, so their names
  // live in the loop's (kind, family) pairs rather than at the append site.
  const looped = [...src.matchAll(/\("(?:total|pass)", "(epa_[a-z]+)"\)/g)]
    .map((m) => m[1]);
  assert.equal(looped.length, 2, 'the EPA loop still registers exactly two families');
  const unique = [...new Set([...registered, ...looped])];
  assert.deepEqual(unique.sort(), [...ALL_FAMILIES].sort(),
    'exactly the fourteen registered families — add a family here and in the '
    + 'MODEL tab, or it is a name nobody is checking');
  assert.equal(unique.length, 14,
    'families_tested is 14 (8 core + 5 Rel18 + 1 R92)');

  // referee: a FIELD in game context and a separate diagnostic, NEVER a family.
  assert.ok(!unique.includes('referee'),
    'referee must never be registered as a family (SOLUTION_DESIGN R1)');
  // ...and the loop that names families also names it in the game-context
  // contract as label-only, so the two statements cannot drift apart.
  const ctxSchema = JSON.parse(readFileSync(
    join(REPO_ROOT, 'data', 'contracts', 'game_context.schema.json'), 'utf8'));
  const labelOnly = ctxSchema.properties.label_only_fields.items.enum;
  assert.ok(labelOnly.includes('referee'),
    'referee stays a LABEL-ONLY game-context field');
});

test('rel18: referee never appears in any archived families[]', () => {
  const { doc } = latestV2();
  for (const h of doc.history || []) {
    if (!h || h.kind !== 'signal_promotion') continue;
    for (const fam of h.families || []) {
      assert.notEqual(fam.family, 'referee',
        `referee found in the ${h.generated_utc} entry — a non-appliable family `
        + 'that wins a run suppresses adoption, which is why it was cut');
    }
  }
});

test('rel18: divisional trials a signed 6 x 5 grid — 30 trials, none degenerate', () => {
  const grid = py(`
import json
from scripts.signals.divisional import DIV_SCALES, DIV_REMATCH_EXTRA
print(json.dumps({"scales": DIV_SCALES, "extras": DIV_REMATCH_EXTRA}))
`);
  assert.equal(grid.scales.length, 6, 'six signed base scales');
  assert.equal(grid.extras.length, 5, 'five rematch extras');
  assert.equal(grid.scales.length * grid.extras.length, 30,
    'divisional contributes 30 trials — the single largest slice of the run\'s '
    + 'Bonferroni multiplicity budget, and the entry records it per family');
  // Direction is unknown a priori, so the grid must span BOTH signs.
  assert.ok(grid.scales.some((s) => s < 0) && grid.scales.some((s) => s > 0),
    'the base grid is signed: "divisional games are closer" is folklore, not a '
    + 'measurement, so the family may not assume a direction');
  // No degenerate trial: scale == 0 would silently re-run the incumbent and
  // spend a multiplicity slot on nothing.
  assert.ok(!grid.scales.includes(0), 'scale is never 0 (that is the incumbent)');
});

test('rel18: scheme_matchup ships with its application path DARK', () => {
  const path = join(REPO_ROOT, 'data', 'scheme_history.json');
  if (!existsSync(path)) return;      // network-built; absence is documented
  const doc = readData('scheme_history.json');
  const app = doc.application;
  assert.ok(app, 'scheme_history declares an application block');
  assert.equal(app.applied, false,
    'scheme_matchup is BACKTEST-ONLY: nothing in build_predictions.py reads it');
  assert.ok(String(app.reason || '').length > 0, 'the application state carries its reason');
  assert.equal(doc.first_ftn_season, 2022);
  // Seasons before FTN are ABSENT, never zero-filled: "we do not know" and
  // "there was none" are different claims.
  for (const yr of Object.keys(doc.seasons || {})) {
    assert.ok(Number(yr) >= 2022, `season ${yr} predates FTN and must be absent`);
  }
  // The credit is rendered FROM the data, so removing the feed removes it.
  assert.ok(doc.attribution && doc.license, 'FTN attribution + licence carried');

  // DARK is derived from the artifact, never pinned to a calendar year: the
  // live season is dark while the artifact carries no charted play for it,
  // whatever the release host is currently serving. (FTN published the 2026
  // release in Sept 2026 while the build still ingested 2022-2025; a test that
  // asserted `dark === true` locked the date instead of the rule.)
  const covered = (doc.seasons_covered || []).map(Number);
  const live = Number(app.live_season);
  const uncovered = covered.includes(live) ? Math.max(...covered, live) + 1 : live;

  // ...and the family REFUSES such a season rather than pricing it at 0.0.
  // The refusal must be SchemeDark specifically: a KeyError or a TypeError is a
  // crash, and "something threw" is not the same guarantee.
  const got = py(`
import json, sys
sys.path.insert(0, ".")
from scripts.signals import scheme_matchup as sm
doc = sm.load_doc()
feats, _ = sm.build_features(doc, [${uncovered}])
live = {"scheme_hfa": {"applied": True, "scale": 120.0}}
g = {"home": "KC", "away": "BUF", "week": 8}
out = {"is_dark": sm.is_dark(${uncovered}, feats, doc)}
try:
    out["value"] = sm.delta_from_params(live, ${uncovered}, g, feats, doc)
    out["raises"] = False
except sm.SchemeDark as e:
    out["raises"] = True
    out["msg"] = str(e)
try:
    sm.scheme_current(${uncovered})
    out["current_raises"] = False
except sm.SchemeDark:
    out["current_raises"] = True
print(json.dumps(out))
`);
  assert.equal(got.is_dark, true,
    `season ${uncovered} is absent from seasons_covered [${covered}], so it is dark`);
  assert.equal(got.raises, true,
    'delta_from_params must RAISE SchemeDark on a season with no charting — a '
    + 'family that silently no-ops is indistinguishable from one that works');
  assert.match(got.msg, new RegExp(String(uncovered)), 'the refusal names the season');
  assert.equal(got.current_raises, true,
    'and the prediction-time input loader refuses it too, by the same rule');
});

test('rel18: divisional and qb_depth are appliable; the other four are measured-only', () => {
  const src = readFileSync(PROMOTE, 'utf8');
  const block = src.match(/APPLIABLE = \{([^}]*)\}/);
  assert.ok(block, 'APPLIABLE set found in promote_signals.py');
  const appliable = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const fam of CORE_FAMILIES) {
    assert.ok(appliable.includes(fam), `${fam} is wired and stays appliable`);
  }
  assert.ok(appliable.includes('divisional'),
    'divisional IS wired into build_predictions, so it may be adopted');
  assert.ok(appliable.includes('qb_depth'),
    'qb_depth IS wired into build_predictions (qb_depth_current + '
    + 'qb_depth_delta), so it may be adopted — being MEASURED every week while '
    + 'game_params carries no qb_depth block is what proposal-only means');
  for (const fam of REL18_UNWIRED) {
    assert.ok(!appliable.includes(fam),
      `${fam} has no application path — listing it would make the gate claim a `
      + 'path that does not exist; add it in the same change that wires it');
  }
});

test('rel18: a real gate entry carries every family of its era and its budget', () => {
  const { entry } = latestV2();
  assert.ok(entry, 'a format-2 promotion entry is archived');
  // GUARD: only a Rel18-era run can satisfy the Rel18 shape. Entries archived
  // before the release predate both the significance block and the five new
  // families, and requiring the new shape of them would red the gate against
  // history that was honestly recorded at the time.
  if (!entry.significance) return;

  const names = entry.families.map((f) => f.family);
  assert.equal(new Set(names).size, names.length, 'no family listed twice');
  /* The lock is kept in BOTH eras rather than loosened for the newer one: an
   * entry that lists qb_depth must carry the full R92 set, and one archived
   * before R92 must carry exactly the thirteen that existed then. Any other set
   * is a family added or dropped without updating this file. */
  const expected = names.includes('qb_depth') ? ALL_FAMILIES : PRE_R92_FAMILIES;
  assert.deepEqual([...names].sort(), [...expected].sort(),
    `a run tests exactly the ${expected.length} families registered in its era`);

  // Every family is trialed or explicitly skipped — never silent.
  for (const fam of entry.families) {
    assert.ok(fam.skipped || (fam.trials || []).length > 0,
      `${fam.family} must be trialed or explicitly skipped`);
    if (fam.skipped) assert.ok(fam.reason, 'a skip always carries its reason');
    assert.equal(typeof fam.appliable, 'boolean',
      `${fam.family} states whether the pipeline can apply it`);
  }

  // divisional's 30 trials, asserted where they are actually spent.
  const div = entry.families.find((f) => f.family === 'divisional');
  if (!div.skipped) {
    assert.equal(div.trials.length, 30, 'divisional spends its full 6 x 5 grid');
  }

  // THE MULTIPLICITY BUDGET IS ITEMISED. The Bonferroni divisor is the whole
  // run's trial count, so every family taxes every other one; the entry must
  // say who spent what rather than leaving the tax invisible.
  const s = entry.significance;
  const byFam = s.trials_by_family;
  assert.ok(byFam && typeof byFam === 'object',
    'the significance block itemises trials per family');
  const summed = Object.values(byFam).reduce((a, b) => a + b, 0);
  assert.equal(summed, s.trials, 'per-family trial counts sum to the divisor');

  // WHICH TERM BOUND. adoption_threshold is max(effect_floor, t_crit x se), and
  // on the 26-fold corpus the FLOOR binds — the decision there is identical to
  // the retired fixed-margin rule. Saying so is the difference between an
  // honest record and calling the gate "significance-based" when it is not the
  // half that decided.
  assert.ok(['effect_floor', 'significance'].includes(s.binding),
    `binding term recorded (got ${s.binding})`);
  assert.equal(entry.margin, s.threshold === null ? s.effect_floor : s.threshold,
    'entry.margin is the threshold actually applied');
  if (s.binding === 'effect_floor') {
    assert.equal(s.threshold, s.effect_floor,
      'floor-bound means the applied threshold IS the floor');
  } else {
    assert.ok(s.threshold > s.effect_floor,
      'significance-bound means t_crit x se exceeded the floor');
  }
});
