/* tests/feature/family_divisional.test.mjs — the `divisional` candidate family.
 *
 * The family itself is four lines of arithmetic. What can actually go wrong is
 * everything around it, so that is what these tests lock:
 *
 *   1. THE DELTA, on every record shape that exists in the corpus. A divisional
 *      first meeting, its in-season rematch, a non-divisional game, a
 *      non-divisional REMATCH (which must not take the rematch term — the term
 *      is about divisional familiarity, not about playing anyone twice), a
 *      divisional PLAYOFF third meeting (also not the rematch), a null
 *      meeting_no, and a game the join does not cover at all. The last one is
 *      the dangerous shape: a missing key must be an exact 0.0, never a guess
 *      and never a raise inside a 7,276-game walk.
 *   2. THE GRID. 6 signed base scales x 5 rematch offsets = 30 trials, zero
 *      excluded from the base. The grid is signed because the direction is
 *      unknown a priori; a test that let it become one-sided would quietly turn
 *      a measurement into an assumption.
 *   3. SKIP-OR-TRIAL, NEVER SILENT. The loader returns None when the artifact
 *      is absent OR does not span the walk, because partial coverage scores
 *      exact ties on the uncovered folds and dilutes the measured improvement
 *      toward zero — "no data here" would be recorded as "no help here".
 *   4. THE TWO REGISTRATION SITES THAT FAIL SILENTLY. `_write_adoption` must
 *      write a `game_params.divisional` block, and `_incumbent_family_fns` must
 *      rebuild that block into the incumbent. An adopted family missing from
 *      the second is not part of next week's bar, so it re-clears the margin
 *      forever against a bar that excludes it and never-regress quietly stops
 *      being a rule. Both are exercised behaviourally, not grepped.
 *   5. THE MARKET BOUNDARY. The module may never name a betting column.
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
const MODULE = join(REPO_ROOT, 'scripts', 'signals', 'divisional.py');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');
const FIXTURE = join(REPO_ROOT, 'data', 'fixtures', 'divisional_context_sample.json');
const TUNING = join(REPO_ROOT, 'data', 'model_tuning.json');

/* Run python and parse the JSON document printed on its LAST line. The gate's
 * own functions print progress to stdout (`_write_adoption` announces the
 * adoption it just wrote), so the payload is taken from the final line rather
 * than the whole stream. */
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

test('divisional: the module ships and its own selftest passes', () => {
  assert.ok(existsSync(MODULE), 'scripts/signals/divisional.py present');
  const out = execFileSync('python3', [MODULE, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /selftest OK/, out);
});

test('divisional: delta is exact on every record shape, including the missing join', () => {
  const got = py(`
import json
from scripts.signals.divisional import divisional_builder
ctx = {
  "2024|3|BUF|MIA":  {"div_game": 1, "meeting_no": 1},
  "2024|12|MIA|BUF": {"div_game": 1, "meeting_no": 2},
  "2024|7|BUF|SF":   {"div_game": 0, "meeting_no": 1},
  "2024|15|BUF|SF":  {"div_game": 0, "meeting_no": 2},
  "2024|20|BUF|MIA": {"div_game": 1, "meeting_no": 3},
  "2024|21|KC|DEN":  {"div_game": 1, "meeting_no": None},
}
_, factory = divisional_builder(20.0, -30.0, ctx)
fn = factory(2024)
def d(h, a, w): return fn({"home": h, "away": a, "week": w}, 0)
print(json.dumps({
  "div_first":    d("BUF", "MIA", 3),
  "div_rematch":  d("MIA", "BUF", 12),
  "nondiv":       d("BUF", "SF", 7),
  "nondiv_again": d("BUF", "SF", 15),
  "div_playoff":  d("BUF", "MIA", 20),
  "null_meeting": d("KC", "DEN", 21),
  "unjoined":     d("SEA", "SF", 9),
}))
`);
  assert.equal(got.div_first, 20.0, 'first divisional meeting takes the base scale');
  assert.equal(got.div_rematch, -10.0, 'rematch takes base + extra (20 + -30)');
  assert.equal(got.nondiv, 0.0, 'a non-divisional game is an exact no-op');
  assert.equal(got.nondiv_again, 0.0,
    'a NON-divisional second meeting must not take the rematch term');
  assert.equal(got.div_playoff, 20.0,
    'a divisional playoff third meeting takes the base scale only');
  assert.equal(got.null_meeting, 20.0, 'a null meeting_no is still divisional at base');
  assert.equal(got.unjoined, 0.0, 'a game the join misses is 0.0, never a guess');
});

test('divisional: the trial grid is 30 signed, non-degenerate combinations', () => {
  const g = py(`
import json
from scripts.signals import divisional as d
print(json.dumps({"scales": d.DIV_SCALES, "extra": d.DIV_REMATCH_EXTRA,
                  "rematch_meeting_no": d.REMATCH_MEETING_NO}))
`);
  assert.equal(g.scales.length, 6);
  assert.equal(g.extra.length, 5);
  assert.equal(g.scales.length * g.extra.length, 30, '6 x 5 = 30 trials');
  assert.ok(!g.scales.includes(0), 'a zero base scale would BE the incumbent');
  assert.ok(g.scales.some((s) => s < 0) && g.scales.some((s) => s > 0),
    'the base grid is signed — direction is measured, not assumed');
  assert.ok(g.extra.includes(0),
    '0.0 is kept: "the rematch is nothing special" is a real hypothesis');
  assert.equal(g.rematch_meeting_no, 2, 'the rematch is the SECOND meeting');
});

test('divisional: the loader skips loudly rather than covering part of the walk', () => {
  const got = py(`
import json, os, tempfile
from scripts.signals.divisional import context_map
res = {}
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "ctx.json")
    res["absent"] = context_map([2024], path=os.path.join(td, "nope.json"))
    json.dump({"games": {}}, open(p, "w"))
    res["empty"] = context_map([2024], path=p)
    json.dump({"games": {"2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}},
              open(p, "w"))
    res["spanned"] = bool(context_map([2024], path=p))
    res["unspanned"] = context_map([2023, 2024], path=p)
print(json.dumps(res))
`);
  assert.equal(got.absent, null, 'absent artifact -> None (skip), never {}');
  assert.equal(got.empty, null, 'empty games -> None');
  assert.equal(got.spanned, true, 'a fully covered season set loads');
  assert.equal(got.unspanned, null,
    'a season the artifact cannot cover must skip the family, not tie the fold');
});

test('divisional: the shipped fixture drives the documented deltas', () => {
  assert.ok(existsSync(FIXTURE), 'divisional_context_sample.json present');
  const doc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const keys = Object.keys(doc.games);
  assert.ok(keys.length >= 6, 'fixture covers every branch');
  for (const k of keys) {
    assert.match(k, /^\d{4}\|\d+\|[A-Z]{2,3}\|[A-Z]{2,3}$/,
      `${k} is the flat {season}|{week}|{home}|{away} join key`);
  }
  const shapes = Object.values(doc.games);
  assert.ok(shapes.some((v) => v.div_game === 1 && v.meeting_no === 1));
  assert.ok(shapes.some((v) => v.div_game === 1 && v.meeting_no === 2));
  assert.ok(shapes.some((v) => v.div_game === 0 && v.meeting_no === 2),
    'a non-divisional rematch is in the fixture — it is the trap case');
  assert.ok(shapes.some((v) => v.div_game === 1 && v.meeting_no === 3));
  assert.ok(shapes.some((v) => v.meeting_no === null));
});

test('divisional: prediction-time application derives from the schedule when the artifact cannot', () => {
  const got = py(`
import json, os, tempfile
from scripts.signals.divisional import divisional_current
sched = [
  {"home": "KC",  "away": "DEN", "week": 2,  "kickoff_utc": "2026-09-13T17:00:00Z"},
  {"home": "KC",  "away": "NO",  "week": 3,  "kickoff_utc": "2026-09-20T17:00:00Z"},
  {"home": "DEN", "away": "KC",  "week": 15, "kickoff_utc": "2026-12-13T18:00:00Z"},
]
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "ctx.json")
    json.dump({"games": {"2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}},
              open(p, "w"))
    derived = divisional_current(2026, schedule=sched, path=p)
    # PARTIAL artifact coverage — the mid-season regime. game_context.json holds
    # COMPLETED games only, so once it is rebuilt after week 1 it carries SOME
    # of the live season. Returning those rows alone priced every UPCOMING game
    # at 0.0, silently, because a non-empty map is truthy.
    q = os.path.join(td, "partial.json")
    json.dump({"games": {"2026|2|KC|DEN": {"div_game": 1, "meeting_no": 1}}},
              open(q, "w"))
    # ...and where BOTH sources carry the game, the nflverse row wins.
    r = os.path.join(td, "wins.json")
    json.dump({"games": {"2026|3|KC|NO": {"div_game": 1, "meeting_no": 2}}},
              open(r, "w"))
    print(json.dumps({
      "derived": derived,
      "artifact_only": divisional_current(2024, schedule=None, path=p),
      "partial": divisional_current(2026, schedule=sched, path=q),
      "artifact_wins": divisional_current(2026, schedule=sched, path=r),
      "no_source": divisional_current(2026, schedule=None, path=p),
    }))
`);
  assert.deepEqual(got.derived['2026|2|KC|DEN'], { div_game: 1, meeting_no: 1 });
  assert.deepEqual(got.derived['2026|15|DEN|KC'], { div_game: 1, meeting_no: 2 },
    'meeting_no counts the unordered pair in kickoff order, not home/away order');
  assert.deepEqual(got.derived['2026|3|KC|NO'], { div_game: 0, meeting_no: 1 });
  assert.deepEqual(got.artifact_only,
    { '2024|1|KC|DEN': { div_game: 1, meeting_no: 1 } },
    'with no slate to cover, the nflverse rows are returned as they are');

  // EVERY SCHEDULED GAME RESOLVES, even when the artifact covers only some of
  // them. A game the artifact has not recorded yet may never fall through to a
  // silent 0.0 — that is indistinguishable from a non-divisional game, and
  // build_predictions' "not applied" warning cannot fire on a truthy map.
  assert.deepEqual(Object.keys(got.partial).sort(),
    ['2026|15|DEN|KC', '2026|2|KC|DEN', '2026|3|KC|NO'],
    'a partially-covering artifact is merged over the schedule, not preferred to it');
  assert.deepEqual(got.partial['2026|15|DEN|KC'], { div_game: 1, meeting_no: 2 },
    'the upcoming divisional rematch still prices, derived from the schedule');
  assert.deepEqual(got.artifact_wins['2026|3|KC|NO'], { div_game: 1, meeting_no: 2 },
    'where both sources have the game, the nflverse record wins');

  assert.equal(got.no_source, null,
    'no artifact row and no schedule -> None, so an adopted family says "not applied"');
});

test('divisional: registration writes game_params AND rebuilds into the incumbent', () => {
  const got = py(`
import json
from scripts import promote_signals as ps

# (6) _write_adoption must produce a game_params.divisional block.
tuning = {}
ps._write_adoption(tuning, ("divisional", {"scale": -10.0, "rematch_extra": 20.0,
                                           "log_loss": 0.1, "n": 1}),
                   55.0, 0.25, 20.0, {}, "2026-01-01T00:00:00Z")
blk = tuning["game_params"]["divisional"]

# (7) the nastiest omission: an APPLIED family must come back as part of the
# incumbent, or it re-clears the margin every week against a bar excluding it.
fns, unavail = ps._incumbent_family_fns({"game_params": {"divisional": blk}})
rebuilt = len(fns)

# ... and when its inputs cannot be rebuilt for this season set, it must be
# NAMED unavailable, which is what refuses adoption against a weak incumbent.
real = ps.divisional_context_map
ps.divisional_context_map = lambda seasons: None
try:
    _f2, unavail2 = ps._incumbent_family_fns({"game_params": {"divisional": blk}})
finally:
    ps.divisional_context_map = real

print(json.dumps({"block": blk, "rebuilt": rebuilt, "unavail": unavail,
                  "unavail_when_absent": unavail2,
                  "in_grid": [ps.DIV_SCALES, ps.DIV_REMATCH_EXTRA]}))
`);
  assert.equal(got.block.applied, true);
  assert.equal(got.block.scale, -10.0);
  assert.equal(got.block.rematch_extra, 20.0);
  assert.equal(got.block.rematch_meeting_no, 2);
  assert.ok(got.block.adopted_utc, 'adoption is dated');
  assert.equal(got.rebuilt, 1, 'an applied divisional block rebuilds into the incumbent');
  assert.deepEqual(got.unavail, [], 'nothing unavailable when the context loads');
  assert.deepEqual(got.unavail_when_absent, ['divisional'],
    'an unrebuildable adopted family must be named, never silently dropped');
  assert.equal(got.in_grid[0].length * got.in_grid[1].length, 30);
});

test('divisional: the family is APPLIABLE and wired at prediction time', () => {
  /* APPLIABLE is a local inside run(), so this one is read from source — but
   * the claim it makes is verified for real by the wiring assertions below:
   * a family in APPLIABLE that build_predictions cannot apply is exactly the
   * lie the honesty guard exists to prevent. */
  const src = readFileSync(PROMOTE, 'utf8');
  const appliable = src.slice(src.indexOf('APPLIABLE = {'));
  assert.match(appliable.slice(0, 400), /"divisional"/,
    'divisional is in APPLIABLE — a non-appliable winner suppresses adoption entirely');
  const bp = readFileSync(join(REPO_ROOT, 'scripts', 'build_predictions.py'), 'utf8');
  assert.match(bp, /_adopted\.get\("divisional"\)/,
    'build_predictions reads the adopted divisional block');
  assert.match(bp, /divisional_delta\(/,
    'build_predictions applies the SAME delta function the gate trialed');
});

test('divisional: the module never names a betting column', () => {
  const src = readFileSync(MODULE, 'utf8');
  for (const col of BETTING_COLUMNS) {
    assert.ok(!src.includes(col),
      `${col} must never appear in a family module — market prices are display only`);
  }
  assert.ok(!/moneyline|spread|vegas|odds/i.test(src),
    'no market vocabulary at all in the family module');
});

test('divisional: when the gate has run it, the recorded family is well formed', () => {
  if (!existsSync(TUNING)) return;                       // nothing to check yet
  const doc = JSON.parse(readFileSync(TUNING, 'utf8'));
  const entry = (doc.history || []).find(
    (h) => h.kind === 'signal_promotion' && h.format === 2);
  if (!entry) return;
  const fam = (entry.families || []).find((f) => f.family === 'divisional');
  if (!fam) return;   // pre-dates this family — skipped loudly, never faked green
  if (fam.skipped) {
    assert.ok(fam.reason, 'a skip always carries its reason');
    return;
  }
  assert.equal(fam.trials.length, 30, 'the 6 x 5 grid is recorded whole');
  for (const t of fam.trials) {
    assert.equal(typeof t.scale, 'number');
    assert.equal(typeof t.rematch_extra, 'number');
    assert.notEqual(t.scale, 0, 'a zero base scale is the incumbent, not a trial');
  }
  const combos = new Set(fam.trials.map((t) => `${t.scale}|${t.rematch_extra}`));
  assert.equal(combos.size, 30, 'every trial is a distinct combination');
  const best = Math.min(...fam.trials.map((t) => t.log_loss));
  assert.equal(fam.best.log_loss, best, 'best is the min trial');
  if (entry.adopted && entry.adopted_family.family === 'divisional') {
    const blk = (doc.game_params || {}).divisional;
    assert.ok(blk && blk.applied,
      'an adopted divisional MUST carry an applied game_params block');
    assert.equal(blk.scale, entry.adopted_family.scale);
    assert.equal(blk.rematch_extra, entry.adopted_family.rematch_extra);
  }
});
