/* tests/feature/r24f_builders.test.mjs — R24-F regression locks.
 *
 * One test per bug fixed in the R24 bug-fix release, each locking the EXACT
 * behaviour that changed. These are deliberately narrow: every one of them
 * fails against the pre-fix tree and passes against the post-fix tree, and none
 * of them re-asserts something another suite already covers.
 *
 * PURE node:test + python3 subprocesses. No browser, no dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const load = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));

/** Run a python snippet with the repo importable; returns stdout. */
function py(src) {
  return execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${src}`,
  });
}

/* ===========================================================================
 * 1. The market boundary now covers parlays + game predictions.
 *
 * check_market_price_fields() shut three doors: meta weights, the signal
 * registry, and the projection record/contract. The hard policy names PARLAY
 * PROBABILITY explicitly, and neither data/parlays.json nor
 * data/game_predictions.json was inspected at all — a price landing on a parlay
 * leg reached an output with the gate still green.
 * ========================================================================= */

test('a market price on a parlay leg or a game prediction REDS the gate', () => {
  // Poison each new door in turn and assert the validator raises. A green run
  // with a poisoned input would mean the extension is decorative.
  const out = py(
    'from scripts.validate_data import check_market_price_fields, ValidationError\n'
    + 'SCHEMA = {"properties": {"players": {"items": {"properties": '
    + '{"gsis_id": {}, "proj_points": {}}}}}}\n'
    + 'PROJ = {"players": [{"gsis_id": "espn-1", "proj_points": 200.0}]}\n'
    + 'def reds(extra):\n'
    + '    try:\n'
    + '        check_market_price_fields({"weights": {}}, PROJ, SCHEMA, extra_docs=extra)\n'
    + '    except ValidationError:\n'
    + '        return True\n'
    + '    return False\n'
    + 'res = {\n'
    // A legitimate parlay: probability, legs, no price anywhere.
    + '  "clean": reds([("parlays.json", {"parlays": [{"prob": 0.31, "legs": '
    + '[{"game_id": "g1", "pick": "KC"}]}]})]),\n'
    // A price on a NESTED parlay leg — the shape a top-level key scan misses.
    + '  "parlay_leg": reds([("parlays.json", {"parlays": [{"prob": 0.31, "legs": '
    + '[{"game_id": "g1", "pick": "KC", "auction_value": 61.8}]}]})]),\n'
    // A price on a game prediction record.
    + '  "game_pred": reds([("game_predictions.json", {"games": [{"game_id": "g1", '
    + '"adp": 12.4}]})]),\n'
    // DECLARED but not yet carried: the contract is a door too.
    + '  "schema_prop": reds([("parlays.schema.json", {"properties": {"parlays": '
    + '{"items": {"properties": {"auction_value": {"type": "number"}}}}}})]),\n'
    // ...including via a `required` array, which is a list of STRINGS, not keys.
    + '  "schema_required": reds([("parlays.schema.json", {"properties": {"parlays": '
    + '{"items": {"required": ["adp"]}}}})]),\n'
    // A DATA value that merely reads "adp" is not a field name and must not red.
    + '  "value_not_key": reds([("parlays.json", {"parlays": [{"note": "adp", '
    + '"tags": ["adp"]}]})]),\n'
    + '}\n'
    + 'print(json.dumps(res))\n',
  );
  assert.deepEqual(JSON.parse(out), {
    clean: false,
    parlay_leg: true,
    game_pred: true,
    schema_prop: true,
    schema_required: true,
    value_not_key: false,
  });
});

test('the real parlays + game_predictions files are scanned, not skipped', () => {
  // The extension is only worth anything if the call site actually passes the
  // shipped files. Assert the validator source names both, AND that the deep
  // scanner finds nothing in the files as they ship today.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'validate_data.py'), 'utf8');
  for (const f of ['parlays.json', 'game_predictions.json']) {
    assert.ok(src.includes(f), `validate_data.py never names ${f}`);
  }
  const out = py(
    'from scripts.validate_data import market_price_keys_deep\n'
    + 'res = {}\n'
    + 'for name in ("data/parlays.json", "data/game_predictions.json",\n'
    + '             "data/contracts/parlays.schema.json",\n'
    + '             "data/contracts/game_predictions.schema.json"):\n'
    + '    with open(name, encoding="utf-8") as fh:\n'
    + '        res[name] = sorted(market_price_keys_deep(json.load(fh)))\n'
    + 'print(json.dumps(res))\n',
  );
  for (const [name, leaked] of Object.entries(JSON.parse(out))) {
    assert.deepEqual(leaked, [], `${name} carries a market price field`);
  }
});

/* ===========================================================================
 * 2. player_usage_weekly __meta__.source_url_template is a TEMPLATE.
 *
 * It shipped as `RELEASE_URL % 0`, i.e. the literal dead URL
 * ".../stats_player_week_0.csv". A consumer reading the artifact's declared
 * source got a 404.
 * ========================================================================= */

test('player_usage_weekly declares a usable source URL TEMPLATE, not season 0', () => {
  const tmpl = load('player_usage_weekly.json').__meta__.source_url_template;
  assert.ok(
    !/_0\.csv$/.test(tmpl),
    `source_url_template is the dead season-0 URL: ${tmpl}`,
  );
  assert.ok(
    tmpl.includes('{season}'),
    `source_url_template carries no substitutable placeholder: ${tmpl}`,
  );
  // It must actually resolve to the URL the builder downloads from.
  assert.equal(
    tmpl.replace('{season}', '2024'),
    'https://github.com/nflverse/nflverse-data/releases/download/'
      + 'stats_player/stats_player_week_2024.csv',
  );
  // And the builder must emit exactly that, so the file and the code cannot drift.
  const emitted = py(
    'from scripts.build_player_usage_weekly import RELEASE_URL\n'
    + 'print(json.dumps(RELEASE_URL.replace("%d", "{season}")))\n',
  );
  assert.equal(JSON.parse(emitted), tmpl);
  const src = readFileSync(
    join(REPO_ROOT, 'scripts', 'build_player_usage_weekly.py'), 'utf8',
  );
  assert.ok(
    !src.includes('RELEASE_URL % 0'),
    'the builder still substitutes season 0 into the declared template',
  );
});

/* ===========================================================================
 * 3. K/DST honesty: `fum_rec` is the WHOLE-TEAM column.
 *
 * DEF fum_rec is built from stats_team_week `fumble_recovery_opp`, which the
 * same file's def_st_fum_rec entry says includes special-teams recoveries. So
 * ST recoveries ARE scored — as defensive fum_rec — while def_st_fum_rec is
 * declared unmodelled. Nothing in the shipped contract reconciled the two.
 * ========================================================================= */

test('def_st_fum_rec states that fum_rec already contains ST recoveries', () => {
  const doc = load('kdst_projections.json');
  const entry = doc.unmodelled_keys.find((u) => u.key === 'def_st_fum_rec');
  assert.ok(entry, 'def_st_fum_rec is no longer declared unmodelled');
  assert.match(
    entry.reason, /fum_rec/,
    'the reason never names the modelled key that already carries these recoveries',
  );
  assert.match(
    entry.reason, /mis-attributed/,
    'the reason does not say the consequence is mis-attribution, not under-counting',
  );
  // The builder's literal must match the shipped artifact, or the next build
  // silently reverts the note.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'build_kdst.py'), 'utf8');
  assert.ok(
    src.includes('already counted inside fum_rec'),
    'build_kdst.py no longer emits the fum_rec attribution note',
  );
  // The claim itself: fum_rec IS fumble_recovery_opp, unsplit.
  assert.ok(
    /t\["fum_rec"\] \+= _num\(r, "fumble_recovery_opp"\)/.test(src),
    'fum_rec no longer reads the whole-team column — revisit the note',
  );
});

/* ===========================================================================
 * 4. build_dvp_positional reconciles its join against the backtest corpus.
 *
 * 3 of 6,967 corpus REG games (6 team-weeks) have no stats_player_week row at
 * all. dvp_mismatch prices a missing team-week at 0.0 — a tie that dilutes the
 * family the same way an uncovered season would — and nothing recorded it.
 * ========================================================================= */

test('dvp_positional_history records its corpus join, misses included', () => {
  const rec = load('dvp_positional_history.json').diagnostics.corpus_reconcile;
  assert.ok(rec, 'the artifact carries no corpus_reconcile diagnostic');
  for (const k of ['seasons', 'compared', 'joined', 'missing', 'examples']) {
    assert.ok(k in rec, `corpus_reconcile is missing ${k}`);
  }
  assert.ok(rec.compared > 6000, `only ${rec.compared} team-weeks compared`);
  assert.equal(rec.joined + rec.missing, rec.compared);
  // The gap is REAL and must be reported, not zeroed to look clean.
  assert.ok(rec.missing > 0, 'a zero-miss join would mean the count is faked');
  assert.ok(rec.examples.length > 0, 'a miss with no example is not diagnosable');
  for (const ex of rec.examples) {
    assert.match(ex, /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}\|[A-Z]{2,3}$/,
      `example is not a game_id|team pair: ${ex}`);
  }
});

test('reconcile_corpus counts misses LOUDLY and never raises', () => {
  // The asymmetry with build_game_context.reconcile (which raises on one miss)
  // is deliberate: this join is against a DIFFERENT feed, so a miss is an
  // upstream gap. Lock that it counts instead of raising, and that a season the
  // artifact does not cover is "no overlap" rather than a wall of misses.
  const out = py(
    'from scripts.build_dvp_positional import _reconcile_against\n'
    + 'probe = {2099: [("KC", 1, "2099_01_SF_KC"), ("SF", 1, "2099_01_SF_KC"),\n'
    + '                ("KC", 2, "2099_02_KC_LAR"), ("LAR", 2, "2099_02_KC_LAR")]}\n'
    + 'res = {\n'
    + '  "full": _reconcile_against({2099: {"KC": {1: {}, 2: {}}, "SF": {1: {}}, '
    + '"LAR": {2: {}}}}, probe),\n'
    + '  "gap": _reconcile_against({2099: {"KC": {1: {}, 2: {}}, "SF": {1: {}}}}, probe),\n'
    + '  "no_overlap": _reconcile_against({2098: {"KC": {1: {}}}}, probe),\n'
    + '}\n'
    + 'print(json.dumps(res))\n',
  );
  const res = JSON.parse(out);
  assert.deepEqual(res.full,
    { seasons: 1, compared: 4, joined: 4, missing: 0, examples: [] });
  assert.equal(res.gap.missing, 1);
  assert.deepEqual(res.gap.examples, ['2099_02_KC_LAR|LAR']);
  assert.deepEqual(res.no_overlap,
    { seasons: 0, compared: 0, joined: 0, missing: 0, examples: [] });
});

test('the dvp contract REQUIRES the corpus_reconcile diagnostic', () => {
  // Without this, a future build could drop the diagnostic and stay green —
  // which is the state the finding was filed against.
  const schema = JSON.parse(readFileSync(
    join(DATA, 'contracts', 'dvp_positional_history.schema.json'), 'utf8',
  ));
  const diag = schema.properties.diagnostics;
  assert.ok(diag.required.includes('corpus_reconcile'));
  assert.deepEqual(
    Object.keys(diag.properties.corpus_reconcile.properties).sort(),
    ['compared', 'examples', 'joined', 'missing', 'seasons'],
  );
});

/* ===========================================================================
 * 5. Docstrings that asserted something the code does not do.
 *
 * These are HONEST-DATA fixes, not cosmetics: each one made a false claim about
 * what the gate measures, and a reader would have trusted it.
 * ========================================================================= */

test('no signal docstring claims postseason games are evaluated', () => {
  // promote_signals.load_finals filters the walk to game_type == "REG", so NO
  // family ever scores a January game. scheme_matchup said "Postseason games are
  // still priced"; divisional's meeting_no == 3 branch reasoned about playoff
  // rematches. Both now say the branch is unreachable from a gate run.
  const filt = readFileSync(join(REPO_ROOT, 'scripts', 'promote_signals.py'), 'utf8');
  assert.ok(
    /game_type["'\s]*\)?\s*or\s*["']REG["']\s*\)\s*==\s*["']REG["']/.test(filt),
    'the REG-only filter is gone — these docstrings need re-checking',
  );
  const scheme = readFileSync(
    join(REPO_ROOT, 'scripts', 'signals', 'scheme_matchup.py'), 'utf8',
  );
  assert.ok(
    !/Postseason games are still priced/.test(scheme),
    'scheme_matchup still claims postseason games are priced by the gate',
  );
  assert.match(scheme, /never EVALUATED/);
  const div = readFileSync(
    join(REPO_ROOT, 'scripts', 'signals', 'divisional.py'), 'utf8',
  );
  assert.match(div, /DEFENSIVE, not exercised/,
    'divisional still presents its meeting_no == 3 branch as a measured case');
});

test('dvp_mismatch.load_features documents the seed season as best-effort', () => {
  // The docstring claimed it returns None unless coverage spans the walk
  // "INCLUDING the prior-season seed". It never checked the seed — and it must
  // not: under --corpus the walk starts at 1999, the artifact's own first
  // season, so requiring 1998 would skip the family on the only walk that
  // matters. The docstring was wrong, not the code.
  const src = readFileSync(
    join(REPO_ROOT, 'scripts', 'signals', 'dvp_mismatch.py'), 'utf8',
  );
  assert.ok(
    !/span the\s+walk INCLUDING the prior-season seed/.test(src.replace(/\n\s*/g, ' ')),
    'the docstring still claims the prior-season seed is required',
  );
  assert.match(src, /best-effort and REPORTED/);
  // And the code still gates on the WALK, which is the half that is real.
  assert.match(src, /if not all\(y in covered for y in seasons\):/);
  // Proven, not read: coverage that misses only the seed still loads.
  const out = py(
    'from scripts.signals import dvp_mismatch as dm\n'
    + 'doc = {"seasons": {"2001": {"KC": {"1": {"g": 1, "off": {"QB": 1.0, "RB": 0.0, '
    + '"WR": 0.0, "TE": 0.0}, "def": {"QB": 1.0, "RB": 0.0, "WR": 0.0, "TE": 0.0}}}}}}\n'
    + 'import json as _j, tempfile, os\n'
    + 'fd, p = tempfile.mkstemp(suffix=".json")\n'
    + 'os.write(fd, _j.dumps(doc).encode()); os.close(fd)\n'
    + 'seeded = dm.load_features([2001], path=p) is not None\n'
    + 'gapped = dm.load_features([2001, 2002], path=p) is None\n'
    + 'os.unlink(p)\n'
    + 'print(json.dumps({"seed_absent_still_loads": seeded, '
    + '"walk_gap_skips": gapped}))\n',
  );
  assert.deepEqual(JSON.parse(out), {
    seed_absent_still_loads: true, // 2000 is not in the artifact; that is fine
    walk_gap_skips: true,          // 2002 is in the WALK and missing; skip loudly
  });
});
