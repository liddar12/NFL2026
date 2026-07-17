/* tests/feature/backtest.test.mjs — pure-function locks for the walk-forward
 * backtest (scripts/backtest.py, Task C).
 *
 * The backtest's core is PURE (no I/O, no network): grade_season walks a
 * season chronologically, predicting each game BEFORE updating ratings with
 * it, and decide_adoption is should_adopt and nothing else. Like
 * learning_loop.test.mjs, this drives both through `python3 -` on synthetic
 * games — python3 is already a fast-gate dependency, so the gate stays
 * offline and dependency-free.
 *
 * Locks:
 *   grade_season(games, params):
 *     - LEAK-FREEDOM: flipping a game's own result changes NOTHING about its
 *       own prediction (nor any earlier game's) — only later predictions move;
 *     - ties move ratings but are never scored (n counts decisive games only);
 *     - deterministic: identical inputs -> identical outputs;
 *     - loud on zero scoreable games (no hollow perfect scores).
 *   decide_adoption(current, candidate):
 *     - the NEVER-REGRESS margin from BOTH sides: clearing 0.0015 adopts,
 *       a sub-margin win / tie / regression keeps the incumbent.
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

/* ---- grade_season: leak-freedom + tie handling + determinism --------------- */

const GRADE_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.backtest import grade_season

def game(wk, home, away, hs, as_):
    return {"home": home, "away": away, "home_score": hs, "away_score": as_,
            "kickoff_utc": "2024-09-%02dT17:00Z" % wk}

PARAMS = {"hfa_elo": 65.0, "k": 20.0}

# A tiny 4-team season: 5 decisive games + 1 tie, in kickoff order.
base = [
    game(1, "AAA", "BBB", 27, 20),
    game(2, "CCC", "DDD", 14, 14),   # tie: rated toward 0.5, never scored
    game(3, "AAA", "CCC", 31, 10),
    game(4, "BBB", "DDD", 17, 24),
    game(5, "AAA", "DDD", 21, 28),
    game(6, "BBB", "CCC", 30, 3),
]

# flip_last: the LAST game's result is reversed. Its own prediction (and every
# earlier one) must be identical — walk-forward means its result arrives after.
flip_last = [dict(g) for g in base]
flip_last[-1]["home_score"], flip_last[-1]["away_score"] = 3, 30

# flip_first: the FIRST game's result is reversed. Its own prediction must not
# move, but LATER predictions must (the walk actually learns from results).
flip_first = [dict(g) for g in base]
flip_first[0]["home_score"], flip_first[0]["away_score"] = 20, 27

r1 = grade_season(base, PARAMS)
r2 = grade_season(base, PARAMS)          # determinism re-run
rl = grade_season(flip_last, PARAMS)
rf = grade_season(flip_first, PARAMS)

print(json.dumps({"base": r1, "again": r2, "flip_last": rl, "flip_first": rf}))
`;

const G = runPy(GRADE_PY);

test('ties are rated but never scored: n counts decisive games only', () => {
  assert.equal(G.base.n, 5, '6 games, 1 tie -> 5 scored');
  assert.equal(G.base.p_home.length, 5, 'one pre-update p_home per scored game');
  assert.ok(G.base.log_loss > 0 && Number.isFinite(G.base.log_loss));
  assert.ok(G.base.brier > 0 && Number.isFinite(G.base.brier));
});

test('LEAK-FREE: flipping the last game leaves its own (and every) prediction unchanged', () => {
  // Every prediction is made before that game's result exists in the ratings,
  // so reversing the final score can move NO p_home at all.
  assert.deepEqual(G.flip_last.p_home, G.base.p_home,
    'a game\'s own result leaked into its own (or an earlier) prediction');
});

test('the walk still LEARNS: flipping the first game moves later predictions, not its own', () => {
  assert.equal(G.flip_first.p_home[0], G.base.p_home[0],
    'game 1\'s own prediction must not depend on game 1\'s result');
  const laterMoved = G.flip_first.p_home
    .slice(1)
    .some((p, i) => p !== G.base.p_home[i + 1]);
  assert.ok(laterMoved,
    'reversing game 1 changed no later prediction — the walk is not updating');
});

test('deterministic: identical inputs give identical outputs', () => {
  assert.deepEqual(G.again, G.base);
});

test('loud on zero scoreable games — no hollow perfect score', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.backtest import grade_season
try:
    grade_season([{"home": "AAA", "away": "BBB", "home_score": None,
                   "away_score": None, "kickoff_utc": "2024-09-01T17:00Z"}],
                 {"hfa_elo": 65.0, "k": 20.0})
    print(json.dumps({"raised": False}))
except ValueError:
    print(json.dumps({"raised": True}))
`);
  assert.equal(out.raised, true, 'zero scoreable games must raise, not score');
});

/* ---- decide_adoption: the NEVER-REGRESS margin from both sides ------------- */

test('decide_adoption honors the 0.0015 margin exactly (adopt / keep / keep / keep)', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.backtest import MARGIN, decide_adoption
print(json.dumps({
    "margin": MARGIN,
    "clears": decide_adoption(0.6931, 0.6931 - 0.0016),
    "sub_margin": decide_adoption(0.6931, 0.6931 - 0.0014),
    "exact_margin": decide_adoption(0.6931, 0.6931 - 0.0015),
    "tie": decide_adoption(0.6931, 0.6931),
    "regression": decide_adoption(0.6931, 0.70),
}))
`);
  assert.equal(out.margin, 0.0015, 'MARGIN must be the shared refit 0.0015');
  assert.equal(out.clears, true, 'a > margin improvement must adopt');
  assert.equal(out.sub_margin, false, 'a sub-margin win keeps the incumbent');
  assert.equal(out.exact_margin, false, 'exactly the margin is NOT enough (strict <)');
  assert.equal(out.tie, false, 'a tie keeps the incumbent');
  assert.equal(out.regression, false, 'a regression keeps the incumbent');
});

/* ---- run_grid: deterministic sweep, best by mean log-loss ------------------ */

test('run_grid picks the lowest mean log-loss over synthetic seasons, deterministically', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.backtest import run_grid
from scripts.models import elo

def game(yr, wk, home, away, hs, as_):
    return {"home": home, "away": away, "home_score": hs, "away_score": as_,
            "kickoff_utc": "%d-10-%02dT17:00Z" % (yr, wk)}

# Two tiny eval seasons where AAA (home) always beats BBB: a larger hfa can
# only help, so the sweep must still be well-ordered and reproducible.
finals = {}
for yr in (2021, 2022, 2023):
    finals[yr] = [game(yr, wk, "AAA", "BBB", 24, 10) for wk in range(1, 7)]
raw = {yr: elo.rate_season(finals[yr]) for yr in (2021, 2022)}

t1, b1 = run_grid(finals, raw, eval_seasons=(2022, 2023))
t2, b2 = run_grid(finals, raw, eval_seasons=(2022, 2023))
print(json.dumps({
    "n_trials": len(t1),
    "same": t1 == t2 and b1 == b2,
    "best_is_min": b1["log_loss"] == min(t["log_loss"] for t in t1),
    "first_min_kept": b1 == [t for t in t1
                             if t["log_loss"] == b1["log_loss"]][0],
}))
`);
  assert.equal(out.n_trials, 45, '5 hfa x 3 revert x 3 k = 45 trials');
  assert.equal(out.same, true, 'the sweep must be deterministic');
  assert.equal(out.best_is_min, true, 'best must carry the minimum mean log-loss');
  assert.equal(out.first_min_kept, true, 'ties keep the FIRST (lowest) grid point');
});
