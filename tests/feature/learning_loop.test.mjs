/* tests/feature/learning_loop.test.mjs — pure-function locks for the learning
 * loop (Agent E, Build 4 contract; Agent C's signatures arbitrate).
 *
 * scripts/resolve_locks.py + scripts/refit.py are Python; their cores are PURE
 * (no I/O, no network), so this test drives them through `python3 -` on
 * synthetic rows — python3 is already a fast-gate dependency (validate_data),
 * so the gate stays dependency-free. Each helper run prints one JSON blob that
 * node:test asserts on.
 *
 * Locks:
 *   resolve_rows(rows, finals_by_id):
 *     - fills actual/brier/log_loss ONLY on rows whose game is FINAL and
 *       non-tied; a tie or a not-yet-final game grades nothing;
 *     - NEVER mutates probs / locked_utc / as_of_utc (a lock is immutable —
 *       resolution attaches the receipt, it does not edit the prediction);
 *     - is idempotent: a second pass resolves nothing and changes no bytes.
 *   refit_game_params(resolved_rows, current) -> {candidate, adopted, losses}:
 *     - adoption respects the NEVER-REGRESS margin from BOTH sides: a candidate
 *       clearing the margin is adopted; the incumbent already being the best
 *       grid point (or a sub-margin win) changes nothing;
 *     - unusable rows (bool actual, missing raw Elo) are ignored, never guessed.
 *   resolve_all_locks keeps the contract signature (schedule_finals).
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

/* ---- resolve_rows: grading fills receipts, mutates nothing else ------------ */

const RESOLVE_PY = `
import copy, json, sys
sys.path.insert(0, ".")
from scripts.resolve_locks import outcome_index, resolve_rows

def row(eid, etype="game", probs=(0.7, 0.3), estimate=False):
    r = {"event_id": eid, "event_type": etype, "model": "elo_prior",
         "locked_utc": "2026-09-01T00:00:00Z", "as_of_utc": "2026-09-01T00:00:00Z",
         "estimate": estimate, "resolved": False}
    if etype == "game":
        r["probs"] = list(probs)
    else:
        r["point"] = 12.5
    return r

rows = [
    row("g-final"),                       # FINAL, home won -> resolves, actual 0
    row("g-pending"),                     # no final yet -> untouched
    row("g-tie", probs=(0.6, 0.4)),       # FINAL tie -> ungradable, skipped
    row("p-week", etype="player_week"),   # player row -> waits for weekly actuals
]
before = copy.deepcopy(rows)
finals = {
    "g-final": {"game_id": "g-final", "home_score": 27, "away_score": 20},
    "g-tie":   {"game_id": "g-tie",   "home_score": 21, "away_score": 21},
}
s1 = resolve_rows(rows, finals)
after1 = copy.deepcopy(rows)
s2 = resolve_rows(rows, finals)  # idempotence pass

print(json.dumps({
    "before": before, "after": rows, "s1": s1, "s2": s2,
    "second_pass_identical": rows == after1,
    "oi_home": outcome_index({"home_score": 27, "away_score": 20}),
    "oi_away": outcome_index({"home_score": 3, "away_score": 9}),
    "oi_tie": outcome_index({"home_score": 21, "away_score": 21}),
    "oi_missing": outcome_index({"home_score": None, "away_score": 20}),
}))
`;

test('resolve_rows grades FINAL games only, immutably, idempotently', () => {
  const r = runPy(RESOLVE_PY);
  const byId = (rows) => Object.fromEntries(rows.map((x) => [x.event_id, x]));
  const before = byId(r.before);
  const after = byId(r.after);

  // Summary: exactly one row graded this pass; tie skipped; two still pending.
  assert.equal(r.s1.resolved_now, 1);
  assert.equal(r.s1.ties_skipped, 1);
  assert.equal(r.s1.pending, 2);
  assert.equal(r.s1.scored_rows, 1);

  // The resolved row carries the receipt: actual 0 (home) + measured scores.
  const g = after['g-final'];
  assert.equal(g.resolved, true);
  assert.equal(g.actual, 0);
  // brier = (0.7-1)^2 + 0.3^2 = 0.18; log_loss = -ln(0.7).
  assert.ok(Math.abs(g.brier - 0.18) < 1e-9, `brier ${g.brier}`);
  assert.ok(Math.abs(g.log_loss - -Math.log(0.7)) < 1e-9, `log_loss ${g.log_loss}`);
  assert.ok(Math.abs(r.s1.brier_mean - 0.18) < 1e-9);

  // The prediction itself is untouched: probs / locked_utc / as_of_utc frozen.
  for (const id of Object.keys(before)) {
    assert.deepEqual(after[id].probs, before[id].probs, `${id}: probs mutated`);
    assert.equal(after[id].locked_utc, before[id].locked_utc, `${id}: locked_utc mutated`);
    assert.equal(after[id].as_of_utc, before[id].as_of_utc, `${id}: as_of_utc mutated`);
  }

  // Unresolvable rows are byte-identical: pending game, tie, player row.
  for (const id of ['g-pending', 'g-tie', 'p-week']) {
    assert.deepEqual(after[id], before[id], `${id}: must be untouched`);
    assert.equal(after[id].resolved, false);
    assert.equal('brier' in after[id], false, `${id}: must NOT carry brier`);
  }

  // Idempotence: the second pass resolves nothing and changes nothing.
  assert.equal(r.s2.resolved_now, 0);
  assert.equal(r.s2.already_resolved, 1);
  assert.equal(r.second_pass_identical, true, 'second pass must be a byte no-op');

  // outcome_index: 0 = home, 1 = away, None for ties / missing scores.
  assert.equal(r.oi_home, 0);
  assert.equal(r.oi_away, 1);
  assert.equal(r.oi_tie, null);
  assert.equal(r.oi_missing, null);
});

/* ---- refit_game_params: NEVER-REGRESS gated grid search --------------------- */

const REFIT_PY = `
import inspect, json, sys
sys.path.insert(0, ".")
from scripts.refit import refit_game_params, score_game_params
from scripts.resolve_locks import resolve_all_locks

# Synthetic graded locks: equal raw ratings, home ALWAYS wins -> the best grid
# point is the maximum hfa (85); revert is irrelevant at equal ratings, so the
# deterministic sweep keeps the first grid revert (0.20).
rows = [{"actual": 0, "home_elo_raw": 1500.0, "away_elo_raw": 1500.0}
        for _ in range(20)]

adopt = refit_game_params(rows, {"hfa_elo": 45.0, "revert": 0.20})
keep = refit_game_params(rows, {"hfa_elo": 85.0, "revert": 0.20})
wide = refit_game_params(rows, {"hfa_elo": 45.0, "revert": 0.20}, margin=10.0)
junk = refit_game_params(
    [{"actual": True, "home_elo_raw": 1500.0, "away_elo_raw": 1500.0},
     {"actual": 0, "away_elo_raw": 1500.0},
     {"actual": 0, "home_elo_raw": 1500.0}],
    {"hfa_elo": 65.0, "revert": 0.30})
empty = refit_game_params([], {"hfa_elo": 65.0, "revert": 0.30})

print(json.dumps({
    "adopt": adopt, "keep": keep, "wide": wide, "junk": junk, "empty": empty,
    "resolve_all_locks_params": list(
        inspect.signature(resolve_all_locks).parameters),
}))
`;

test('refit_game_params: adoption respects the NEVER-REGRESS margin from both sides', () => {
  const r = runPy(REFIT_PY);

  // Side 1 — a real improvement clears the margin and is adopted.
  assert.equal(r.adopt.adopted, true, 'clear improvement must be adopted');
  assert.deepEqual(r.adopt.candidate, { hfa_elo: 85.0, revert: 0.2 });
  assert.equal(r.adopt.n_resolved, 20);
  assert.ok(
    r.adopt.candidate_loss < r.adopt.current_loss - r.adopt.margin,
    `adoption must clear the margin: ${r.adopt.candidate_loss} vs ${r.adopt.current_loss}`,
  );

  // Side 2 — the incumbent already IS the best grid point: nothing changes.
  assert.equal(r.keep.adopted, false, 'incumbent-best must NOT be re-adopted');
  assert.ok(
    r.keep.candidate_loss >= r.keep.current_loss - r.keep.margin,
    'kept candidate must not have cleared the margin',
  );

  // Side 2b — the SAME improvement under a wide margin is refused: the margin
  // is the gate, not the sign of the delta.
  assert.equal(r.wide.adopted, false, 'sub-margin improvement must be refused');
  assert.ok(
    r.wide.candidate_loss < r.wide.current_loss,
    'wide-margin case must still be a raw improvement (that is the point)',
  );
  assert.equal(r.wide.margin, 10.0);

  // Unusable rows (bool actual, missing raw Elo) are ignored, never guessed.
  assert.equal(r.junk.n_resolved, 0);
  assert.equal(r.junk.adopted, false);
  assert.equal(r.junk.candidate, null);

  // Zero rows: no fit, no adoption, no losses — the honest day-zero no-op.
  assert.deepEqual(
    { candidate: r.empty.candidate, adopted: r.empty.adopted, n: r.empty.n_resolved },
    { candidate: null, adopted: false, n: 0 },
  );
  assert.equal(r.empty.current_loss, null);

  // Contract signature: resolve_all_locks(schedule_finals).
  assert.deepEqual(r.resolve_all_locks_params, ['schedule_finals']);
});
