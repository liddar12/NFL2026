/* tests/feature/weekly_injury.test.mjs — locks the injury-aware weekly shaping
 * (scripts/build_weekly.py, Task C).
 *
 * Drives the PURE weekly builder through `python3 -` on synthetic projections,
 * schedule, and injury rows (the learning_loop.test.mjs pattern; python3 is
 * already a fast-gate dependency, no network, no committed-data churn).
 *
 * Locks:
 *   - the status -> multiplier prior is exactly the documented table
 *     (Out 0.55 / Doubtful 0.7 / Questionable 0.9, else 1.0);
 *   - the multiplier shapes ONLY the first 3 NON-BYE weeks (a bye inside the
 *     window pushes the window past it), then the renormalization restores the
 *     season total EXACTLY (unrounded split preserved to 1e-6 — injuries move
 *     shape, never total);
 *   - absent/empty injuries -> byte-identical document and NO injury_shape
 *     meta; applied injuries -> injury_shape {applied: true, statuses_used: N}.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

/* Shared synthetic world: two teams, 6 scheduled weeks, SFX's bye in week 2 —
 * so SFX's first 3 NON-bye weeks are 1, 3, 4 (the window must skip the bye). */
const SETUP = `
import json, sys
sys.path.insert(0, ".")
from scripts.build_weekly import (INJURY_MULT, build_weekly_document,
                                  injury_multipliers, player_weeks,
                                  team_schedule)

def g(wk, home, away):
    return {"week": wk, "home": home, "away": away}

SCHED = [g(1, "SFX", "DAL"), g(2, "DAL", "GBX"), g(3, "DAL", "SFX"),
         g(4, "SFX", "GBX"), g(5, "GBX", "SFX"), g(6, "SFX", "DAL")]
PROJ = [
    {"gsis_id": "p1", "name": "Hurt Guy", "team": "SFX", "proj_points": 200.0},
    {"gsis_id": "p2", "name": "Fine Guy", "team": "DAL", "proj_points": 150.0},
]
ELOS = {"SFX": 1580.0, "DAL": 1470.0, "GBX": 1500.0}
RECS = {"p1": 80.0, "p2": 40.0}
INJ_OUT = [{"team": "SFX", "player": "Hurt Guy", "status": "Out"}]
`;

test('the status -> multiplier prior is exactly the documented table', () => {
  const out = runPy(`${SETUP}
print(json.dumps(INJURY_MULT))
`);
  assert.deepEqual(out, { Out: 0.55, Doubtful: 0.7, Questionable: 0.9 },
    'the documented prior table drifted');
});

test('multiplier hits ONLY the first 3 non-bye weeks; season total preserved to 1e-6', () => {
  const out = runPy(`${SETUP}
sched = team_schedule(SCHED)
base = player_weeks(200.0, "SFX", sched, ELOS, round_dp=None)
hurt = player_weeks(200.0, "SFX", sched, ELOS, injury_mult=0.55, round_dp=None)
print(json.dumps({
    "base": [w["pts"] for w in base],
    "hurt": [w["pts"] for w in hurt],
    "byes": [w["wk"] for w in base if w["bye"]],
    "sum_base": sum(w["pts"] for w in base),
    "sum_hurt": sum(w["pts"] for w in hurt),
}))
`);
  // SFX plays weeks 1,3,4,5,6 and byes ALL other weeks (2 and 7..18).
  assert.ok(out.byes.includes(2), 'SFX week 2 must be a bye');
  assert.ok(Math.abs(out.sum_base - 200.0) < 1e-6, 'baseline split must sum to season');
  assert.ok(Math.abs(out.sum_hurt - 200.0) < 1e-6,
    `injured split must preserve the season total to 1e-6 (got ${out.sum_hurt})`);

  // Pre-normalization the first 3 NON-bye weeks (1, 3, 4) carry 0.55x, the
  // rest 1.0x; the uniform renormalization s preserves those ratios exactly:
  // hurt/base = 0.55*s on shaped weeks and s on the others.
  const shaped = [0, 2, 3];   // week indices 1, 3, 4 (0-based)
  const unshaped = [4, 5];    // weeks 5, 6
  const ratio = (i) => out.hurt[i] / out.base[i];
  const s = ratio(unshaped[0]);
  assert.ok(s > 1, 'unshaped weeks must gain share (renormalization pushes points back)');
  for (const i of unshaped) {
    assert.ok(Math.abs(ratio(i) - s) < 1e-9, `week idx ${i}: unshaped ratio drifted`);
  }
  for (const i of shaped) {
    assert.ok(Math.abs(ratio(i) / s - 0.55) < 1e-9,
      `week idx ${i}: shaped/unshaped ratio must be exactly the 0.55 multiplier`);
  }
  // Bye rows stay untouched zero-weeks.
  assert.equal(out.hurt[1], 0, 'bye week must stay 0 pts');
});

test('injury join: (team, normalized name) match, worst status wins, else ignored', () => {
  const out = runPy(`${SETUP}
rows = [
    {"team": "SFX", "player": "hurt guy", "status": "Questionable"},
    {"team": "SFX", "player": "Hurt Guy", "status": "Out"},        # worst wins
    {"team": "DAL", "player": "Hurt Guy", "status": "Out"},        # wrong team
    {"team": "DAL", "player": "Fine Guy", "status": "Active"},     # 1.0 -> dropped
    {"team": "DAL", "player": "Nobody Projected", "status": "Out"} # no join
]
print(json.dumps(injury_multipliers(PROJ, rows)))
`);
  assert.deepEqual(out, { p1: 0.55 },
    'only the projected SFX player shapes, at the worst (Out) multiplier');
});

test('absent/empty injuries -> byte-identical document, no injury_shape meta', () => {
  const out = runPy(`${SETUP}
kw = dict(receptions_by_id=RECS, season=2026, updated_utc="2026-07-17T00:00:00Z")
doc_empty = build_weekly_document(PROJ, SCHED, ELOS, injuries=[], **kw)
doc_absent = build_weekly_document(PROJ, SCHED, ELOS,
                                   injuries_path="/nonexistent/injuries.json", **kw)
doc_active = build_weekly_document(PROJ, SCHED, ELOS,
                                   injuries=[{"team": "SFX", "player": "Hurt Guy",
                                              "status": "Active"}], **kw)
b = lambda d: json.dumps(d, ensure_ascii=True, indent=2, sort_keys=False)
print(json.dumps({
    "absent_identical": b(doc_absent) == b(doc_empty),
    "active_identical": b(doc_active) == b(doc_empty),
    "no_shape_key": "injury_shape" not in doc_empty["model"],
}))
`);
  assert.equal(out.absent_identical, true,
    'a missing injuries.json must yield byte-identical output');
  assert.equal(out.active_identical, true,
    'an all-Active report must be a byte-identical no-op');
  assert.equal(out.no_shape_key, true,
    'injury_shape must be absent when nothing was shaped');
});

test('applied injuries -> injury_shape meta, shaped early weeks, season total intact', () => {
  const out = runPy(`${SETUP}
kw = dict(receptions_by_id=RECS, season=2026, updated_utc="2026-07-17T00:00:00Z")
doc = build_weekly_document(PROJ, SCHED, ELOS, injuries=INJ_OUT, **kw)
base = build_weekly_document(PROJ, SCHED, ELOS, injuries=[], **kw)
p1, p1b = doc["players"][0], base["players"][0]
p2, p2b = doc["players"][1], base["players"][1]
print(json.dumps({
    "shape": doc["model"].get("injury_shape"),
    "p1_sum": sum(w["pts"] for w in p1["weeks"]),
    "p1_wk1_dropped": p1["weeks"][0]["pts"] < p1b["weeks"][0]["pts"],
    "p1_wk6_raised": p1["weeks"][5]["pts"] > p1b["weeks"][5]["pts"],
    "p2_untouched": p2 == p2b,
}))
`);
  assert.deepEqual(out.shape, { applied: true, statuses_used: 1 },
    'injury_shape meta must record the applied shaping');
  // Rounded rows: the committed-file tolerance (18 * 0.005) still holds.
  assert.ok(Math.abs(out.p1_sum - 200.0) <= 0.09,
    `rounded injured split must stay within rounding of the season (${out.p1_sum})`);
  assert.equal(out.p1_wk1_dropped, true, 'an Out player\'s week 1 must drop');
  assert.equal(out.p1_wk6_raised, true, 'the healthy back weeks must absorb the points');
  assert.equal(out.p2_untouched, true, 'an uninjured player\'s split must not move');
});
