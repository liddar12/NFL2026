/* tests/feature/preseason.test.mjs — locks the Rel17 F7 preseason-form signal
 * (scripts/build_preseason.py + data/contracts/preseason_form.schema.json).
 *
 * The OWNER RULE this file exists to enforce: preseason box scores are NOT true
 * performance — starters sit or play one series and everyone is avoiding contact
 * — so the signal must be LOW-WEIGHTED, hard-CAPPED, DECAY TO ZERO once real
 * football lands, and never be able to flip a ranking on its own.
 *
 * Locked here, with exact numbers:
 *   - the cap: a 10x preseason with a full sample and no decay is EXACTLY 1.03,
 *     a zero preseason is EXACTLY 0.97, and no ratio anywhere escapes +/-3%;
 *   - the decay ladder 1.0 / 2-3 / 1-3 / 0.0 over 0..3 team FINALs, and adj
 *     EXACTLY 1.0 at DECAY_GAMES (not 0.9999 — exactly);
 *   - the sample scale: 3 of 15 opportunities turns a capped +3% into +0.6%;
 *   - honest absence: no baseline / no opportunities -> adj exactly 1.0 WITH a
 *     reason, never a fabricated number;
 *   - the committed data/preseason_form.json obeys its contract, is labelled with
 *     the mandatory caveat, and its self-reported rank guard recomputes;
 *   - the document names its sample basis honestly (opportunities, not snaps).
 *
 * Drives the PURE builder through `python3 -` (the weekly_injury.test.mjs
 * pattern): python3 is already a fast-gate dependency, no network, no data churn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC_PATH = resolve(REPO_ROOT, 'data/preseason_form.json');
const SCHEMA_PATH = resolve(REPO_ROOT, 'data/contracts/preseason_form.schema.json');

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

const IMPORT = `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})
from scripts import build_preseason as bp
`;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('the cap is absolute: no preseason line can move a projection more than 3%', () => {
  const got = runPy(`${IMPORT}
out = {}
# A 10x-his-career preseason, a full sample, zero decay -> the clamp, exactly.
out["huge"] = bp.compute_adj(100.0, 1, 17.0, 999, 0)[0]
# A zero-point preseason under the same conditions -> the other side, exactly.
out["zero"] = bp.compute_adj(0.0, 1, 170.0, 999, 0)[0]
# A sweep of absurd ratios: none may escape the band.
out["sweep"] = [bp.compute_adj(p, 1, 17.0, 999, 0)[0]
                for p in (0.0, 0.5, 1.0, 5.0, 50.0, 500.0, 5000.0)]
out["cap"] = bp.PRESEASON_CAP
print(json.dumps(out))
`);
  assert.equal(got.cap, 0.03);
  assert.equal(got.huge, 1.03);
  assert.equal(got.zero, 0.97);
  for (const adj of got.sweep) {
    assert.ok(Math.abs(adj - 1) <= 0.03 + 1e-12, `escaped the cap: ${adj}`);
  }
  // A backup's three-TD August cannot outrank a starter who sat: the biggest
  // possible preseason edge over a rival is 6% of one projection, and that is
  // before the sample scale and the decay shrink it further.
  assert.ok(got.huge / got.zero <= 1.062);
});

test('the signal decays to EXACTLY zero once three real games are in the books', () => {
  const got = runPy(`${IMPORT}
out = {"decay": [bp.decay_for(n) for n in (0, 1, 2, 3, 4, 17)],
       "adj": [bp.compute_adj(100.0, 1, 17.0, 999, n)[0] for n in (0, 1, 2, 3, 4, 17)],
       "decay_games": bp.DECAY_GAMES}
print(json.dumps(out))
`);
  assert.equal(got.decay_games, 3);
  assert.deepEqual(got.decay, [1.0, 2 / 3, 1 / 3, 0.0, 0.0, 0.0]);
  // The full-strength +3% fades linearly and then is gone. Note 1.0 EXACTLY at
  // three team FINALs — the fourth and seventeenth game cannot resurrect August.
  assert.deepEqual(got.adj, [1.03, 1.02, 1.01, 1.0, 1.0, 1.0]);
});

test('sample scaling: the starter who played one series barely moves', () => {
  const got = runPy(`${IMPORT}
out = {"min_opps": bp.MIN_OPPORTUNITIES,
       "three": bp.compute_adj(100.0, 1, 17.0, 3, 0),
       "full": bp.compute_adj(100.0, 1, 17.0, 15, 0),
       "over": bp.compute_adj(100.0, 1, 17.0, 60, 0),
       "opps": bp.opportunities({"pass_att": 20, "rush_att": 3, "targets": 4,
                                 "receptions": 4, "rec_yds": 99})}
print(json.dumps(out))
`);
  assert.equal(got.min_opps, 15);
  // 3 of 15 opportunities -> sample 0.2 -> the capped +3% arrives as +0.6%.
  assert.equal(got.three[0], 1.006);
  assert.equal(got.three[2].sample, 0.2);
  assert.equal(got.full[0], 1.03);
  // The sample weight saturates: 60 opportunities is not four times 15.
  assert.equal(got.over[0], 1.03);
  assert.equal(got.over[2].sample, 1.0);
  // Opportunities are CHANCES (attempts + targets), not production.
  assert.equal(got.opps, 27);
});

test('honest data: a missing input yields exactly 1.0 and says why', () => {
  const got = runPy(`${IMPORT}
out = {"no_base": bp.compute_adj(9.0, 1, None, 12, 0)[:2],
       "zero_base": bp.compute_adj(9.0, 1, 0.0, 12, 0)[:2],
       "no_opps": bp.compute_adj(9.0, 1, 170.0, 0, 0)[:2],
       "no_games": bp.compute_adj(0.0, 0, 170.0, 0, 0)[:2],
       "down": bp.document({}, 0, [], available=False, reason="feed down")}
print(json.dumps(out))
`);
  assert.deepEqual(got.no_base, [1.0, 'no_baseline']);
  assert.deepEqual(got.zero_base, [1.0, 'no_baseline']);
  assert.deepEqual(got.no_opps, [1.0, 'no_preseason_opportunities']);
  assert.deepEqual(got.no_games, [1.0, 'no_preseason_opportunities']);
  // A dead feed is a stated absence, not an empty-looking success.
  assert.equal(got.down.available, false);
  assert.equal(got.down.reason, 'feed down');
  assert.deepEqual(got.down.players, {});
  assert.equal(got.down.estimate, true);
  assert.ok(got.down.caveat.length > 40);
});

test('the rank guard is measured, not assumed', () => {
  const got = runPy(`${IMPORT}
proj = json.load(open("data/player_projections.json"))["players"]
worst = {p["gsis_id"]: {"adj": 1.0 + bp.PRESEASON_CAP * (1 if i % 2 else -1)}
         for i, p in enumerate(proj)}
out = {"none": bp.max_rank_move({}, proj),
       "worst": bp.max_rank_move(worst, proj),
       "bound": bp.MAX_RANK_MOVE,
       "guard_false": bp.document(worst, 1, proj)["rank_guard_ok"]}
print(json.dumps(out))
`);
  assert.equal(got.none, 0, 'all-1.0 adjustments must move nobody');
  assert.equal(got.bound, 2);
  // The guard has teeth: a maximally adversarial board trips it, so a document
  // that reports rank_guard_ok:true is reporting something real.
  assert.ok(got.worst > got.bound);
  assert.equal(got.guard_false, false);
});

test('the committed preseason_form.json obeys its contract and its own guard', () => {
  assert.ok(existsSync(SCHEMA_PATH), 'preseason_form.schema.json must exist');
  if (!existsSync(DOC_PATH)) return; // runner-built; absence is not a failure.
  const doc = readJson(DOC_PATH);

  const schemaOk = runPy(`${IMPORT}
from scripts.validate_data import validate_against_schema, ValidationError
doc = json.load(open("data/preseason_form.json"))
schema = json.load(open("data/contracts/preseason_form.schema.json"))
try:
    validate_against_schema(doc, schema, "preseason_form.json")
    print(json.dumps({"ok": True, "err": None}))
except ValidationError as exc:
    print(json.dumps({"ok": False, "err": str(exc)}))
`);
  assert.equal(schemaOk.ok, true, schemaOk.err || '');

  // The mandatory label, and the honest name for what the sample measures.
  assert.match(doc.caveat, /not true performance/i);
  assert.match(doc.caveat, /weight 0/i);
  assert.equal(doc.sample_basis, 'opportunities');
  assert.equal(doc.estimate, true);
  assert.equal(doc.constants.preseason_cap, 0.03);
  assert.equal(doc.constants.decay_games, 3);

  // Every emitted adjustment respects the cap, and every reasoned row is exactly 1.0.
  for (const [pid, row] of Object.entries(doc.players)) {
    assert.ok(Math.abs(row.adj - 1) <= 0.03 + 1e-9, `${pid} escaped the cap`);
    if (row.reason !== null) assert.equal(row.adj, 1.0, `${pid} claims ${row.reason}`);
    if (row.decay === 0) assert.equal(row.adj, 1.0, `${pid} survived the decay`);
    if (row.signal !== null) {
      assert.ok(row.signal >= 0.97 && row.signal <= 1.03, `${pid} signal unclamped`);
    }
  }

  // The self-reported rank guard must recompute from the committed board.
  const guard = runPy(`${IMPORT}
doc = json.load(open("data/preseason_form.json"))
proj = json.load(open("data/player_projections.json"))["players"]
print(json.dumps({"stamped": doc["max_rank_move"],
                  "recomputed": bp.max_rank_move(doc["players"], proj),
                  "ok": doc["rank_guard_ok"]}))
`);
  assert.equal(guard.stamped, guard.recomputed);
  assert.equal(guard.ok, guard.recomputed <= doc.constants.max_rank_move);
});

test('the preseason scraper is seasontype-1 only and never leaks into real stats', () => {
  const src = readFileSync(
    resolve(REPO_ROOT, 'scripts/scrape/espn_gamestats.py'), 'utf8');
  // The preseason fetcher defaults to seasontype=1 and the regular-season ones to 2:
  // one function per world, so no aggregate can accidentally mix August into September.
  assert.match(src, /def fetch_preseason_playerstats\(season, weeks=range\(1, 5\), seasontype=1/);
  assert.match(src, /def fetch_season_gamestats\(season, weeks=range\(1, 19\), seasontype=2/);
  assert.match(src, /def fetch_final_linescores\(season, week, seasontype=2\)/);

  // And the builder is standalone — the core pipeline must not import it, so a
  // dead preseason feed can never change build_predictions' failure semantics.
  const preds = readFileSync(resolve(REPO_ROOT, 'scripts/build_predictions.py'), 'utf8');
  assert.ok(!/build_preseason/.test(preds),
    'build_predictions.py must not invoke the preseason builder');
});
