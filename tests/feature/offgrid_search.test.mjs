/* tests/feature/offgrid_search.test.mjs — locks for the OFF-GRID parameter
 * refit (R18-A3, scripts/refit.py + scripts/models/elo.py).
 *
 * Every game parameter the platform had adopted sat exactly ON an edge of the
 * old coarse grid (hfa_elo=45 at the low edge, revert=0.45 and k=25 at the
 * high edge). A value on the edge of the box was chosen by the BOX, not by the
 * data. The search is now wide (bounds from elo.HFA_BOUNDS / REVERT_BOUNDS /
 * K_BOUNDS), refined coarse-to-fine, and loud when a fit still clamps.
 *
 * The core is PURE python (no I/O, no network), so this drives it through
 * `python3 -` on synthetic rows exactly like learning_loop.test.mjs.
 *
 * Locks:
 *   elo bounds: wide enough that the incumbent/adopted values are INTERIOR.
 *   axis_values / LEGACY_AXES: the legacy grids are reproduced exactly, so the
 *     old sweep and its tie-breaking cannot drift.
 *   search_axes: finds an interior optimum a coarse grid provably misses, to
 *     min_step resolution, deterministically, and never leaves its box.
 *   clamped_axes: reports lo/hi hits, empty for an interior fit.
 *   cross_validated_refit:
 *     - adoption is decided on HELD-OUT folds, not the in-sample fit;
 *     - a candidate that only wins in-sample is REFUSED;
 *     - a boundary-clamped candidate is refused under strict_boundary and the
 *       refusal says CLAMPED, NOT CONVERGED;
 *     - fewer than two usable rows adopts nothing.
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

/* ---- the search box itself ------------------------------------------------ */

const BOX_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.models import elo
from scripts.refit import (Axis, HFA_GRID, REVERT_GRID, LEGACY_AXES, GAME_AXES,
                           axis_values, search_axes, clamped_axes)

# A known interior optimum the OLD coarse grid cannot express: the minimum of
# (x - 34.25)^2 lives between the old grid's 30 and 35.
coarse = (Axis("x", 0.0, 100.0, 5.0, 5.0),)     # step == min_step -> flat grid
fine = (Axis("x", 0.0, 100.0, 5.0, 0.25),)
quad = lambda p: (p["x"] - 34.25) ** 2
c = search_axes(quad, coarse)
f = search_axes(quad, fine)

# A monotone objective has no interior optimum: it must clamp, and say so.
mono = search_axes(lambda p: -p["x"], fine)

# Every value the search returns must live inside the declared box.
inside = all(fine[0].lo <= v <= fine[0].hi for v in axis_values(fine[0]))

print(json.dumps({
    "hfa_bounds": list(elo.HFA_BOUNDS),
    "revert_bounds": list(elo.REVERT_BOUNDS),
    "k_bounds": list(elo.K_BOUNDS),
    "legacy_hfa": list(HFA_GRID),
    "legacy_revert": list(REVERT_GRID),
    "legacy_axes": [list(a) for a in LEGACY_AXES],
    "game_axes": [list(a) for a in GAME_AXES],
    "coarse": c, "fine": f, "fine_again": search_axes(quad, fine),
    "coarse_clamped": clamped_axes(c["point"], coarse),
    "fine_clamped": clamped_axes(f["point"], fine),
    "mono": mono, "mono_clamped": clamped_axes(mono["point"], fine),
    "inside": inside,
}))
`;

test('search box: wide bounds, exact legacy grids, interior optimum found', () => {
  const r = runPy(BOX_PY);

  // The bounds must be wide enough that the values in play are INTERIOR — that
  // is the whole point of the widening. 45 / 0.45 / 25 all sat on the old edges.
  const [hLo, hHi] = r.hfa_bounds;
  assert.ok(hLo < 35 && hHi > 85, `hfa bounds ${r.hfa_bounds} too narrow`);
  const [vLo, vHi] = r.revert_bounds;
  assert.ok(vLo < 0.2 && vHi > 0.45, `revert bounds ${r.revert_bounds} too narrow`);
  const [kLo, kHi] = r.k_bounds;
  assert.ok(kLo < 15 && kHi > 25, `k bounds ${r.k_bounds} too narrow`);

  // The legacy grids are reproduced exactly (nothing about the old sweep drifts).
  assert.deepEqual(r.legacy_hfa, [45, 50, 55, 60, 65, 70, 75, 80, 85]);
  assert.deepEqual(r.legacy_revert, [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]);
  // ...and a legacy axis refines nothing: step === min_step.
  for (const [, , , step, minStep] of r.legacy_axes) assert.equal(step, minStep);
  // The live axes DO refine: min_step is strictly finer than the coarse step.
  for (const [, , , step, minStep] of r.game_axes) assert.ok(minStep < step);

  // The coarse grid can only land on a multiple of its step; the refined search
  // gets within its min_step of the true optimum. That gap is the bug this fixes.
  assert.equal(r.coarse.point.x % 5, 0);
  assert.ok(Math.abs(r.coarse.point.x - 34.25) >= 0.75);
  assert.ok(
    Math.abs(r.fine.point.x - 34.25) <= 0.25,
    `refined search landed at ${r.fine.point.x}, not within min_step of 34.25`,
  );
  assert.ok(r.fine.loss < r.coarse.loss, 'refinement must beat the coarse grid');
  assert.ok(r.fine.rounds > 1, 'a refining axis must run more than one round');

  // Deterministic: same inputs, same point, same evaluation count.
  assert.deepEqual(r.fine_again, r.fine);

  // Never leaves the declared box.
  assert.equal(r.inside, true);

  // Boundary reporting: interior fit is clean; a monotone objective clamps high.
  assert.deepEqual(r.fine_clamped, {});
  assert.deepEqual(r.coarse_clamped, {});
  assert.equal(r.mono.point.x, 100);
  assert.deepEqual(r.mono_clamped, { x: 'hi' });
});

/* ---- cross_validated_refit: held-out folds decide, clamps are refused ------ */

const CV_PY = `
import json, random, sys
sys.path.insert(0, ".")
from scripts.models import elo
from scripts.refit import cross_validated_refit, GAME_AXES

def synth(n, hfa, revert, seed):
    """Rows drawn from a KNOWN (hfa, revert) — seeded, so this is deterministic.
    Ratings vary, so both parameters are identifiable (equal ratings would leave
    revert free, and a free parameter drifts to whichever bound sorts first)."""
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        hr = 1500.0 + rnd.uniform(-220.0, 220.0)
        ar = 1500.0 + rnd.uniform(-220.0, 220.0)
        p = elo.expected_home(1500.0 + (hr - 1500.0) * (1.0 - revert),
                              1500.0 + (ar - 1500.0) * (1.0 - revert), hfa)
        out.append({"actual": 0 if rnd.random() < p else 1,
                    "home_elo_raw": round(hr, 3), "away_elo_raw": round(ar, 3)})
    return out

signal = synth(600, 60.0, 0.30, 11)
real = cross_validated_refit(signal, {"hfa_elo": 0.0, "revert": 0.33})

# The incumbent already IS the fitted point: a search can match the in-sample
# loss exactly, but there is nothing real left to win out-of-fold.
noop = cross_validated_refit(signal, real["candidate"])

# Degenerate: home ALWAYS wins -> the objective falls monotonically in hfa, so
# the fit clamps to the upper bound. Huge held-out "improvement", but it is the
# box talking, not the data -> strict_boundary must refuse it.
allhome = [{"actual": 0, "home_elo_raw": 1500.0, "away_elo_raw": 1500.0}
           for _ in range(60)]
clamped = cross_validated_refit(allhome, {"hfa_elo": 0.0, "revert": 0.33})
clamped_loose = cross_validated_refit(allhome, {"hfa_elo": 0.0, "revert": 0.33},
                                      strict_boundary=False)

thin = cross_validated_refit(
    [{"actual": 0, "home_elo_raw": 1500.0, "away_elo_raw": 1500.0}],
    {"hfa_elo": 65.0, "revert": 0.33})
none_ = cross_validated_refit([], {"hfa_elo": 65.0, "revert": 0.33})

print(json.dumps({"real": real, "noop": noop, "clamped": clamped,
                  "clamped_loose": clamped_loose, "thin": thin, "none": none_,
                  "axis_names": [a.name for a in GAME_AXES]}))
`;

test('cross_validated_refit: held-out folds decide adoption, clamps are refused', () => {
  const r = runPy(CV_PY);

  // A genuine, out-of-fold improvement over a bad incumbent IS adopted, and the
  // fitted hfa is interior (~62 Elo), not pinned to a bound.
  assert.equal(r.real.adopted, true, 'a real held-out win must be adopted');
  assert.deepEqual(r.real.on_boundary, {}, 'the fit must be interior');
  assert.ok(
    r.real.heldout_candidate_loss < r.real.heldout_current_loss - r.real.margin,
    'adoption must clear the margin on HELD-OUT loss',
  );
  // 600 rows is a noisy sample, so this is a sanity band around the true 60 Elo,
  // not a point estimate — the lock that matters is that it is INTERIOR.
  assert.ok(r.real.candidate.hfa_elo > 25 && r.real.candidate.hfa_elo < 110,
    `fitted hfa ${r.real.candidate.hfa_elo} is nowhere near the 60 Elo used to draw the data`);
  // Off-grid: the fit is free to land between the old grid's 5-Elo steps.
  assert.notEqual(r.real.candidate.hfa_elo % 5, 0,
    'a refined fit should not have to be a multiple of the coarse step');
  assert.equal(r.real.folds, 5);
  assert.equal(r.real.fold_candidates.length, 5);
  // Each fold fit really was held out: train + held partition the rows.
  for (const f of r.real.fold_candidates) {
    assert.equal(f.n_train + f.n_held, r.real.n_resolved);
    assert.ok(f.n_held > 0);
  }

  // In-sample always improves (more freedom, same data) — but that alone must
  // NOT adopt. This is the overfitting the held-out folds exist to catch.
  assert.ok(r.noop.candidate_loss <= r.noop.current_loss,
    'the in-sample fit can only match or beat the incumbent');
  assert.equal(r.noop.adopted, false,
    'an in-sample-only improvement must never be adopted');

  // Boundary refusal: same numbers, opposite decisions, and the reason is loud.
  assert.equal(r.clamped_loose.adopted, true,
    'without strict_boundary the clamped fit would clear the margin');
  assert.equal(r.clamped.adopted, false,
    'a fit pinned to a search bound is not a converged optimum');
  assert.equal(r.clamped.on_boundary.hfa_elo, 'hi',
    'a monotone objective must pin hfa_elo to the high bound');
  assert.match(r.clamped.refusal, /CLAMPED, NOT CONVERGED/);
  assert.match(r.clamped.refusal, /hfa_elo/);

  // Too little data to hold anything out: nothing is fit, nothing is adopted.
  for (const thin of [r.thin, r.none]) {
    assert.equal(thin.adopted, false);
    assert.equal(thin.candidate, null);
    assert.equal(thin.folds, 0);
    assert.match(thin.refusal, /held-out|usable/);
  }
  assert.deepEqual(r.axis_names, ['hfa_elo', 'revert']);
});
