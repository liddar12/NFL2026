"""Refit game-model parameters from resolved locks — NEVER-REGRESS gated.

The learning half of the loop. Inputs are the graded point-in-time lock rows produced
by scripts/resolve_locks.py — leak-safe by construction (locked before kickoff,
resolved only after FINAL). Over those rows we search the two Elo game parameters
nothing has earned yet: hfa_elo (prediction-time home-field advantage, Elo points)
and revert (between-season reversion toward the mean).

OFF-GRID SEARCH (R18-A3). The search used to be a fixed coarse grid — hfa 45..85
step 5, revert 0.20..0.45 step 0.05 — and every parameter the platform had adopted
sat EXACTLY on one of its edges (hfa_elo=45 at the low edge, revert=0.45 at the
high edge, k=25 at the high edge of the walk-forward grid). A value on the edge of
the box is chosen by the BOX, not by the data: the objective was still falling when
the grid ran out. The search is now:

    * WIDE  — the box comes from elo.HFA_BOUNDS / elo.REVERT_BOUNDS, the outer
              limits of what the parameter can physically mean, so the optimum has
              room to be interior.
    * FINE  — coarse-to-fine box refinement (search_axes): sweep at the coarse
              step, then re-sweep a shrinking box around the best point at half
              the step, down to min_step. Resolution 0.5 Elo / 0.005 revert for a
              few hundred evaluations — cheap enough for a weekly cron.
    * HONEST — clamped_axes() reports any parameter that still lands on a bound.
              A clamped fit is NOT a converged optimum, is labelled as such in
              model_tuning.json history, and (strict_boundary=True, the driver's
              setting) is REFUSED rather than adopted.

Each candidate is scored by mean log-loss (scripts.harness.metrics — the exact
objective the harness reports, never re-derived) of its re-derived Elo home
probability. Adoption is decided ONLY by
scripts.optimize.never_regress.should_adopt, and it is fed HELD-OUT numbers: the
rows are split into deterministic folds, the search is re-run on each fold's
training rows, and both the fitted candidate and the incumbent are scored on the
rows that fit never saw (cross_validated_refit). An in-sample improvement is not
evidence; a candidate that does not beat the incumbent out-of-fold by the margin
changes nothing.

EVERY refit outcome (adopted or not) is appended to data/model_tuning.json under
"history" — additive: the file's top-level NEVER-REGRESS example entry is locked by
never_regress.test.mjs + smoke.sh and is never modified. ONLY on adoption are the live
params written to model_tuning.json:"game_params", where scripts/build_predictions.py
reads them (absent => the incumbent scripts/models/elo.py defaults, so probs stay
byte-identical). A run that grades zero rows appends nothing — a no-op is printed, not
archived, so daily crons never churn the file.

tilt_coef/home_coef (weekly player params) CANNOT be refit yet: tilt shapes PLAYER
weeklies, not game probs, and no resolved weekly player actuals exist. That path is
guarded with a loud skip line until the weekly-actuals feed lands (see
refit_player_params).

Pure core (unit-testable, no I/O, no network): score_game_params() +
refit_game_params(). Row contract for refit_game_params — each resolved row carries:

    home_elo_raw / away_elo_raw : UNREVERTED end-of-prior-season Elo ratings
                                  (elo.rate_season over the prior season's finals)
    actual                      : 0 = home won, 1 = away won  (the lock's outcome index)

The grid explores the prediction-time hfa and the between-season revert applied to
those raw ratings; the raw ratings themselves are held fixed (the hfa used INSIDE the
prior season's rating updates is second-order and stays at the incumbent — honest and
simple beats clever here).

Run in the pipeline runner (network + requests): python -m scripts.refit
The fast gate never runs this; it validates the committed model_tuning.json.
"""

import collections
import datetime as dt
import glob
import itertools
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.harness import metrics  # noqa: E402
from scripts.harness import snapshot as snap  # noqa: E402
from scripts.models import elo as elo_mod  # noqa: E402
from scripts.optimize.never_regress import should_adopt  # noqa: E402
from scripts.resolve_locks import LOCK_GLOB  # noqa: E402
from scripts.scrape import espn  # noqa: E402

PRIOR_SEASON = 2025  # mirrors scripts/build_predictions.py
DATA = os.path.join(_ROOT, "data")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")

MARGIN = 0.0015  # the NEVER-REGRESS default, same units as the losses

FOLDS = 5  # held-out folds used to decide adoption (see cross_validated_refit)

# ---------------------------------------------------------------------------
# Search axes. An Axis is a closed box [lo, hi] swept at `step` and refined down
# to `min_step`; lo/hi come from the model's own plausibility bounds so a fitted
# value that touches one is a CLAMP, not an optimum.
# ---------------------------------------------------------------------------
Axis = collections.namedtuple("Axis", "name lo hi step min_step")

GAME_AXES = (
    Axis("hfa_elo", elo_mod.HFA_BOUNDS[0], elo_mod.HFA_BOUNDS[1], 5.0, 0.5),
    Axis("revert", elo_mod.REVERT_BOUNDS[0], elo_mod.REVERT_BOUNDS[1], 0.05, 0.005),
)

# The pre-R18-A3 coarse grid, kept ONLY as the documented default of
# refit_game_params (whose exact sweep + tie-breaking is locked by
# tests/feature/learning_loop.test.mjs). step == min_step, so it refines nothing:
# it is one flat cartesian sweep, byte-identical to the grid it replaced. The
# driver never uses it — main() searches GAME_AXES.
LEGACY_AXES = (
    Axis("hfa_elo", 45.0, 85.0, 5.0, 5.0),
    Axis("revert", 0.20, 0.45, 0.05, 0.05),
)


def axis_values(axis, lo=None, hi=None, step=None):
    """Ascending, inclusive sweep points for `axis` (optionally over a sub-box).

    Deterministic and float-drift-free: values are lo + i*step rounded to 10
    decimals, so 0.20 + 2*0.05 is 0.3 and never 0.30000000000000004. `hi` is
    always included even when the step does not divide the span exactly.
    """
    lo = axis.lo if lo is None else float(lo)
    hi = axis.hi if hi is None else float(hi)
    step = axis.step if step is None else float(step)
    if step <= 0:
        raise ValueError("axis %s: step must be > 0 (got %r)" % (axis.name, step))
    if hi < lo:
        raise ValueError("axis %s: hi %r < lo %r" % (axis.name, hi, lo))
    n = int(math.floor((hi - lo) / step + 1e-9))
    vals = [round(lo + i * step, 10) for i in range(n + 1)]
    if vals[-1] < hi - 1e-9:
        vals.append(round(hi, 10))
    return tuple(vals)


# Back-compat aliases for the old module constants — DERIVED from LEGACY_AXES so
# the two can never drift apart.
HFA_GRID = axis_values(LEGACY_AXES[0])
REVERT_GRID = axis_values(LEGACY_AXES[1])


def search_axes(score_fn, axes):
    """Coarse-to-fine box search for the minimum of `score_fn`. Pure + deterministic.

    Round 1 sweeps the full box at each axis's coarse `step`. Every later round
    halves each step (floored at `min_step`) and re-centres that axis's box on the
    current best point, +/- one OLD step — wide enough that the refinement cannot
    walk off a local shelf it has not actually measured. Points are cached, so
    re-visiting a coarse point costs nothing.

    Ties keep the FIRST point in ascending sweep order (strict `<`), exactly as
    the flat grid did. With step == min_step on every axis this IS the flat grid:
    one sweep, same order, same tie-breaking.

    Returns {"point": {name: value}, "loss": float, "evals": int, "rounds": int}.
    """
    boxes = [(a.lo, a.hi, a.step) for a in axes]
    cache = {}
    best_point = None
    best_loss = None
    rounds = 0

    while True:
        rounds += 1
        grids = [axis_values(a, lo, hi, st) for a, (lo, hi, st) in zip(axes, boxes)]
        for combo in itertools.product(*grids):
            key = combo
            if key in cache:
                loss = cache[key]
            else:
                loss = float(score_fn({a.name: v for a, v in zip(axes, combo)}))
                cache[key] = loss
            if best_loss is None or loss < best_loss:
                best_loss = loss
                best_point = {a.name: v for a, v in zip(axes, combo)}
        if all(st <= a.min_step + 1e-12 for a, (_, _, st) in zip(axes, boxes)):
            break
        boxes = [
            (max(a.lo, round(best_point[a.name] - st, 10)),
             min(a.hi, round(best_point[a.name] + st, 10)),
             max(a.min_step, st / 2.0))
            for a, (_, _, st) in zip(axes, boxes)
        ]

    return {"point": best_point, "loss": best_loss, "evals": len(cache),
            "rounds": rounds}


def clamped_axes(point, axes, tol=1e-9):
    """Axes whose fitted value sits ON a search bound -> {name: "lo"|"hi"}.

    A non-empty result means the search box, not the data, picked those values:
    the objective was still improving when the box ran out. Such a fit must be
    reported as CLAMPED, never as a converged optimum.
    """
    out = {}
    if not point:
        return out
    for a in axes:
        v = float(point[a.name])
        if abs(v - a.lo) <= tol:
            out[a.name] = "lo"
        elif abs(v - a.hi) <= tol:
            out[a.name] = "hi"
    return out


def _clamp_note(clamped, axes):
    """One loud human line naming every clamped axis and the bound it hit."""
    by_name = {a.name: a for a in axes}
    bits = ["%s pinned to its %s bound %g"
            % (name, clamped[name], getattr(by_name[name], clamped[name]))
            for name in sorted(clamped)]
    return ("CLAMPED, NOT CONVERGED: " + "; ".join(bits)
            + " - the search box chose these values, not the data. Widen the "
              "bounds in scripts/models/elo.py before trusting them.")


def fold_indices(n, folds):
    """Deterministic strided fold assignment: fold f owns rows f, f+folds, ...

    Strided (not contiguous) because resolved locks arrive in week order and a
    contiguous tail-fold would compare parameters on one week of football. The
    parameters being fit are global scalars, so striding leaks nothing: the fold's
    own rows never touch the fit that is scored on them.
    """
    folds = max(1, min(int(folds), int(n)))
    return [[i for i in range(n) if i % folds == f] for f in range(folds)]


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _prior(raw, revert):
    """Between-season reversion (mirrors elo.revert_to_mean, per single rating)."""
    return elo_mod.INIT + (float(raw) - elo_mod.INIT) * (1.0 - float(revert))


def score_game_params(resolved_rows, params):
    """Mean log-loss of {hfa_elo, revert} over resolved lock rows. Pure.

    For each row: revert both raw ratings by params["revert"], take the Elo home
    probability at params["hfa_elo"], and grade [p_home, p_away] against the row's
    realized outcome index via the shared harness metrics.
    """
    pairs = []
    for r in resolved_rows:
        p_home = elo_mod.expected_home(
            _prior(r["home_elo_raw"], params["revert"]),
            _prior(r["away_elo_raw"], params["revert"]),
            hfa=float(params["hfa_elo"]),
        )
        pairs.append((int(r["actual"]), [p_home, 1.0 - p_home]))
    return metrics.multiclass_log_loss(pairs)


def usable_rows(resolved_rows):
    """The subset of rows that can honestly be scored — the rest are dropped, never
    guessed at: an integer (not bool) `actual` plus both raw Elo ratings."""
    return [r for r in resolved_rows
            if isinstance(r.get("actual"), int) and not isinstance(r.get("actual"), bool)
            and r.get("home_elo_raw") is not None
            and r.get("away_elo_raw") is not None]


def refit_game_params(resolved_rows, current, margin=MARGIN, axes=LEGACY_AXES):
    """Search hfa_elo x revert on IN-SAMPLE resolved-lock log-loss; margin-gated.

    The single-fit primitive: one search over `axes`, one should_adopt call, no
    folds. cross_validated_refit() is what the driver runs (and what decides
    adoption for real) — this function is kept for the per-fold fits and because
    its exact sweep and tie-breaking are locked by
    tests/feature/learning_loop.test.mjs, hence the LEGACY_AXES default.

    Parameters
    ----------
    resolved_rows : sequence of dict
        Resolved lock rows, each carrying home_elo_raw, away_elo_raw and an integer
        `actual` (0 = home won, 1 = away won). Rows missing any of those are
        ignored (they cannot be scored, and guessing would poison the fit).
    current : dict
        The incumbent live params: {"hfa_elo": float, "revert": float}.
    margin : float
        NEVER-REGRESS margin, passed straight through to should_adopt.
    axes : sequence of Axis
        The search box. Defaults to the legacy coarse grid; the driver passes
        GAME_AXES (wide bounds, refined to 0.5 Elo / 0.005 revert).

    Returns
    -------
    dict
        {"candidate": {"hfa_elo", "revert"} | None,
         "current_loss": float | None, "candidate_loss": float | None,
         "adopted": bool, "n_resolved": int, "margin": float,
         "on_boundary": {axis: "lo"|"hi"}, "evals": int}

    With zero usable rows nothing is fit and nothing is adopted (the honest
    default: no data, no change). Deterministic: ascending sweeps, strict-<
    improvement, so ties keep the earliest (lowest) point. Adoption here is
    should_adopt(current_loss, candidate_loss, margin) and nothing else — the
    boundary check is REPORTED, not enforced, at this level.
    """
    rows = usable_rows(resolved_rows)
    if not rows:
        return {"candidate": None, "current_loss": None, "candidate_loss": None,
                "adopted": False, "n_resolved": 0, "margin": margin,
                "on_boundary": {}, "evals": 0}

    current_loss = score_game_params(rows, current)
    found = search_axes(lambda p: score_game_params(rows, p), axes)

    adopted = should_adopt(current_loss, found["loss"], margin=margin)
    return {
        "candidate": found["point"],
        "current_loss": round(current_loss, 6),
        "candidate_loss": round(found["loss"], 6),
        "adopted": adopted,
        "n_resolved": len(rows),
        "margin": margin,
        "on_boundary": clamped_axes(found["point"], axes),
        "evals": found["evals"],
    }


def cross_validated_refit(resolved_rows, current, margin=MARGIN, axes=GAME_AXES,
                          folds=FOLDS, strict_boundary=True):
    """The adoption decision: refit per fold, judge on the rows each fit never saw.

    For every fold: search `axes` on the OTHER folds' rows, then score both that
    fitted candidate and the incumbent on this fold's rows. Pooling those per-row
    losses gives one held-out number per side, and should_adopt sees only those —
    an in-sample win proves nothing, since a finer search can always chase noise
    down to a lower training loss.

    The candidate actually shipped is the full-data fit (all rows, same axes);
    the folds decide *whether* it ships, not what it is.

    strict_boundary=True (the driver) REFUSES a candidate whose fitted value sits
    on a search bound: that is a clamp, not an optimum, and adopting it would bake
    the box into production. The refusal is reported, never silent.

    Fewer than two usable rows -> no held-out fold exists -> nothing is adopted.
    """
    rows = usable_rows(resolved_rows)
    n = len(rows)
    base = {"candidate": None, "current_loss": None, "candidate_loss": None,
            "heldout_current_loss": None, "heldout_candidate_loss": None,
            "improvement": None, "adopted": False, "n_resolved": n,
            "margin": margin, "folds": 0, "fold_candidates": [],
            "on_boundary": {}, "evals": 0,
            "axes": [{"name": a.name, "lo": a.lo, "hi": a.hi,
                      "min_step": a.min_step} for a in axes]}
    if n < 2:
        base["refusal"] = ("fewer than 2 usable resolved rows - no held-out fold "
                           "exists, so nothing can be validated or adopted")
        return base

    full = search_axes(lambda p: score_game_params(rows, p), axes)
    clamped = clamped_axes(full["point"], axes)

    idx_folds = fold_indices(n, folds)
    ho_cur_total = 0.0
    ho_cand_total = 0.0
    ho_n = 0
    fold_candidates = []
    evals = full["evals"]
    for held in idx_folds:
        held_set = set(held)
        train = [rows[i] for i in range(n) if i not in held_set]
        test = [rows[i] for i in held]
        if not train or not test:
            continue
        fit = search_axes(lambda p: score_game_params(train, p), axes)
        evals += fit["evals"]
        fold_candidates.append({"hfa_elo": fit["point"]["hfa_elo"],
                                "revert": fit["point"]["revert"],
                                "n_train": len(train), "n_held": len(test)})
        # Pool per-row losses (weight by fold size) so folds of unequal size do
        # not get equal say.
        ho_cand_total += score_game_params(test, fit["point"]) * len(test)
        ho_cur_total += score_game_params(test, current) * len(test)
        ho_n += len(test)

    if not ho_n:
        base["refusal"] = "no fold produced both training and held-out rows"
        return base

    ho_cur = ho_cur_total / ho_n
    ho_cand = ho_cand_total / ho_n
    adopted = should_adopt(ho_cur, ho_cand, margin=margin)
    refusal = None
    if adopted and strict_boundary and clamped:
        adopted = False
        refusal = _clamp_note(clamped, axes)

    out = dict(base)
    out.update({
        "candidate": full["point"],
        "current_loss": round(score_game_params(rows, current), 6),
        "candidate_loss": round(full["loss"], 6),
        "heldout_current_loss": round(ho_cur, 6),
        "heldout_candidate_loss": round(ho_cand, 6),
        "improvement": round(ho_cur - ho_cand, 6),
        "adopted": adopted,
        "folds": len(fold_candidates),
        "fold_candidates": fold_candidates,
        "on_boundary": clamped,
        "evals": evals,
    })
    if refusal:
        out["refusal"] = refusal
    elif clamped:
        out["refusal"] = _clamp_note(clamped, axes)
    return out


def refit_player_params(resolved_player_rows, current):
    """tilt_coef/home_coef refit — GUARDED until weekly player actuals exist.

    tilt/home shape the weekly PLAYER point split, so their refit target is realized
    weekly player points — a feed that does not exist yet. With no resolved
    player_week rows this returns a loud skip record (adopted=False, nothing
    changes). If resolved player rows ever arrive while this guard is still in
    place, we REFUSE loudly rather than silently ignore real data.
    """
    if not resolved_player_rows:
        return {"candidate": None, "current_loss": None, "candidate_loss": None,
                "adopted": False, "n_resolved": 0,
                "skipped": "no resolved weekly player actuals yet"}
    raise NotImplementedError(
        "resolved weekly player rows exist but the tilt_coef/home_coef refit is not "
        "implemented yet — implement it (against realized weekly player points) "
        "instead of letting real data rot unused.")


# ---------------------------------------------------------------------------
# model_tuning.json — additive history (the top-level example entry is locked
# by never_regress.test.mjs + smoke.sh and must never be touched).
# ---------------------------------------------------------------------------
def _load_tuning():
    with open(TUNING_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _write_tuning(doc):
    with open(TUNING_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def append_history(doc, entry):
    """Append one refit outcome to the document's "history" list (created on first
    use). Purely additive — every other key keeps its committed value."""
    doc.setdefault("history", []).append(entry)
    return doc


def live_game_params(doc):
    """The params production currently runs on: an adopted game_params entry if one
    exists, else the incumbent scripts/models/elo.py defaults."""
    gp = doc.get("game_params") or {}
    return {"hfa_elo": float(gp.get("hfa_elo", elo_mod.HFA_ELO)),
            "revert": float(gp.get("revert", elo_mod.REVERT))}


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------
def _collect_resolved_rows(event_type):
    """All resolved, measured rows of `event_type` across data/snapshots/*_games_open.json."""
    rows = []
    for path in sorted(glob.glob(os.path.join(snap.SNAPSHOT_DIR, LOCK_GLOB))):
        for r in snap.load_snapshot(os.path.basename(path)):
            if (r.get("event_type") == event_type and r.get("resolved")
                    and not r.get("estimate", True)):
                rows.append(r)
    return rows


def _enrich_with_raw_elo(rows):
    """Attach home_elo_raw/away_elo_raw (unreverted end-of-2025 ratings) to each row.

    Teams come from data/schedule_full.json (game_id -> home/away); ratings from
    elo.rate_season over the prior season's FINAL results (network). Rows whose
    game_id is missing from the schedule are dropped loudly — grading a game we
    cannot identify would be a silent mis-attribution.
    """
    with open(SCHEDULE_PATH, encoding="utf-8") as fh:
        by_id = {str(g["game_id"]): g for g in json.load(fh)["games"]}
    finals_prior = espn.fetch_final_results(PRIOR_SEASON)
    print(f"espn finals {PRIOR_SEASON}: {len(finals_prior)} FINAL games "
          f"-> raw (unreverted) Elo ratings")
    raw = elo_mod.rate_season(finals_prior)
    enriched, dropped = [], 0
    for r in rows:
        g = by_id.get(str(r.get("event_id")))
        if g is None:
            dropped += 1
            print(f"[warn] resolved lock row {r.get('event_id')!r} not in "
                  f"schedule_full.json — dropped from the refit set", file=sys.stderr)
            continue
        r2 = dict(r)
        r2["home_elo_raw"] = raw.get(g["home"], elo_mod.INIT)
        r2["away_elo_raw"] = raw.get(g["away"], elo_mod.INIT)
        enriched.append(r2)
    if dropped:
        print(f"[warn] refit: {dropped} resolved rows dropped (no schedule match)",
              file=sys.stderr)
    return enriched


def _reason(result, current):
    """A one-paragraph honest explanation, in the file's example tone.

    Always states the HELD-OUT numbers (the ones adoption is decided on) and, when
    the fit clamped to a search bound, says so instead of calling it an optimum.
    """
    tail = ""
    if result.get("refusal"):
        tail = " " + result["refusal"]
    if result["adopted"]:
        return ("ADOPTED: candidate hfa_elo=%(h).1f revert=%(r).3f improves "
                "HELD-OUT log-loss %(cl).4f -> %(nl).4f across %(f)d folds, "
                "clearing the %(m).4f margin over n=%(n)d resolved locks. "
                "should_adopt == true.%(t)s"
                % {"h": result["candidate"]["hfa_elo"],
                   "r": result["candidate"]["revert"],
                   "cl": result["heldout_current_loss"],
                   "nl": result["heldout_candidate_loss"],
                   "f": result["folds"], "m": result["margin"],
                   "n": result["n_resolved"], "t": tail})
    return ("NEVER REGRESS: best off-grid candidate %(c)s scores %(nl)s HELD-OUT "
            "vs incumbent (hfa_elo=%(h).1f revert=%(r).3f) at %(cl)s across "
            "%(f)d folds over n=%(n)d resolved locks; the %(m).4f margin is not "
            "cleared, so the incumbent params are kept unchanged. "
            "should_adopt == false.%(t)s"
            % {"c": result["candidate"],
               "nl": result["heldout_candidate_loss"],
               "h": current["hfa_elo"], "r": current["revert"],
               "cl": result["heldout_current_loss"], "f": result["folds"],
               "m": result["margin"], "n": result["n_resolved"], "t": tail})


def _player_refit_guard():
    """Run the guarded tilt/home path and print its (loud) outcome."""
    doc = _load_tuning()
    player_rows = _collect_resolved_rows("player_week")
    skip = refit_player_params(player_rows, live_game_params(doc))
    print(f"refit: tilt_coef/home_coef skipped: {skip['skipped']}")


def main():
    now = _utc_now()
    resolved = _collect_resolved_rows("game")
    print(f"refit: {len(resolved)} resolved game lock rows under data/snapshots/")

    if not resolved:
        # No graded record yet -> nothing to fit, nothing to archive (a no-op is
        # printed, not written, so daily crons never churn model_tuning.json).
        print("refit: no resolved lock rows yet - nothing to refit (clean no-op).")
        _player_refit_guard()
        return 0

    doc = _load_tuning()
    current = live_game_params(doc)
    rows = _enrich_with_raw_elo(resolved)
    # Off-grid: wide bounds, refined to 0.5 Elo / 0.005 revert, adoption judged on
    # held-out folds, boundary-clamped fits refused (see cross_validated_refit).
    result = cross_validated_refit(rows, current, axes=GAME_AXES, folds=FOLDS,
                                   strict_boundary=True)

    entry = {
        "generated_utc": now,
        "kind": "game_params",
        "objective": "log_loss",
        "search": "coarse-to-fine box refinement (scripts/refit.search_axes)",
        "axes": result["axes"],
        "folds": result["folds"],
        "fold_candidates": result["fold_candidates"],
        "evals": result["evals"],
        "margin": result["margin"],
        "n_resolved": result["n_resolved"],
        "current": current,
        "candidate": result["candidate"],
        # In-sample, for the record only.
        "current_loss": result["current_loss"],
        "candidate_loss": result["candidate_loss"],
        # Held-out — the numbers adoption is actually decided on.
        "heldout_current_loss": result["heldout_current_loss"],
        "heldout_candidate_loss": result["heldout_candidate_loss"],
        "improvement": result["improvement"],
        "on_boundary": result["on_boundary"],
        "adopted": result["adopted"],
        "reason": _reason(result, current),
    }
    append_history(doc, entry)

    if result["on_boundary"]:
        # Loud on stderr as well as in the archive: a clamped fit is a bug in the
        # search box, not a result.
        print("refit: " + _clamp_note(result["on_boundary"], GAME_AXES),
              file=sys.stderr)

    if result["adopted"]:
        # The ONE place live game params are updated — build_predictions reads them
        # from here. Only an adoption that cleared the margin OUT-OF-FOLD lands.
        doc["game_params"] = {
            "hfa_elo": result["candidate"]["hfa_elo"],
            "revert": result["candidate"]["revert"],
            "adopted_utc": now,
            "source": "scripts/refit.py off-grid refined search on resolved locks "
                      "(held-out folds, never-regress gated)",
        }
        print(f"refit: ADOPTED hfa_elo={result['candidate']['hfa_elo']} "
              f"revert={result['candidate']['revert']} "
              f"(held-out {result['heldout_current_loss']} -> "
              f"{result['heldout_candidate_loss']}, "
              f"n={result['n_resolved']}, folds={result['folds']})")
    else:
        print(f"refit: kept incumbent hfa_elo={current['hfa_elo']} "
              f"revert={current['revert']} — candidate {result['candidate']} "
              f"scored {result['heldout_candidate_loss']} vs "
              f"{result['heldout_current_loss']} held-out "
              f"(margin {result['margin']}, n={result['n_resolved']}, "
              f"folds={result['folds']}); outcome archived."
              + (" " + result["refusal"] if result.get("refusal") else ""))

    _write_tuning(doc)
    print(f"refit: outcome appended to data/model_tuning.json "
          f"(history now {len(doc['history'])} entries)")
    _player_refit_guard()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
