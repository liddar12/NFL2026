"""Walk-forward, leak-safe weight fitter with shrinkage + NEVER REGRESS adoption.

This is the skeleton of the platform's optimizer. Given a list of *resolved*
point-in-time snapshot rows — each carrying the per-signal features that were
available AS-OF the event plus the realized outcome — it runs a small,
deterministic coordinate/grid search to minimize multiclass log-loss, regularizes
the fitted weights by shrinking them toward the current (incumbent) weights on
small samples, and then defers to `never_regress.should_adopt` to decide whether
the candidate is actually worth adopting.

Design invariants (these are the whole point — read them):

  * LEAK-SAFETY: a snapshot row only ever exposes features known as-of the event.
    We additionally evaluate candidates walk-forward: weights are scored on events
    that were NOT used to pick them, so reported loss is genuinely out-of-sample.
  * DETERMINISM: rows are sorted by (locked_utc, event_id); the grid and the
    coordinate sweep order are fixed; there is no RNG anywhere. Same input ->
    byte-identical summary, every run, on any box.
  * STDLIB ONLY: no numpy/pandas/sklearn. The "model" is a plain logistic blend
    of signal features so the math stays transparent and mirror-able.
  * NEVER REGRESS: the fitted+shrunk candidate replaces current weights only if it
    clears the margin. Nothing earns weight by fitting noise.

The internal model here is intentionally simple (a binary home/away logistic over
signed signal features). It is a stand-in that establishes the *contract and the
guardrails*; richer game/player models plug into the same fit/adopt machinery
later without changing the honesty properties.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Dict, List, Sequence, Tuple

# ---------------------------------------------------------------------------
# Paths (repo-relative, resolved from this file so it runs from any cwd).
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
_FIXTURES_DIR = os.path.join(_REPO_ROOT, "data", "fixtures")

# Ensure the repo root is importable whether this module is imported as
# `scripts.optimize.optimize_weights` or run directly as a script
# (`python3 scripts/optimize/optimize_weights.py`). In the script case Python
# puts the script's own dir on sys.path, not the repo root, which would break the
# absolute `scripts.*` imports below; inserting the repo root fixes both cases.
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Number of classes for the internal demo model: [away_win, home_win].
_N_CLASSES = 2


# ---------------------------------------------------------------------------
# Loss: delegate to the shared harness so the optimizer and the eval harness
# agree on the exact objective. Imported lazily with a clear error so a missing
# harness never turns into a cryptic ImportError at module import time.
# ---------------------------------------------------------------------------
def _dataset_log_loss(y_true_idx: Sequence[int],
                      probs: Sequence[Sequence[float]]) -> float:
    """Mean multiclass log-loss over a dataset, via scripts.harness.metrics.

    Prefers the harness's ``multiclass_log_loss(y_true_idx, probs)`` if present;
    otherwise averages the per-event ``log_loss(y_true_idx, probs)``. Either way
    the number is produced by the shared metrics module, never re-derived here,
    so the optimizer minimizes exactly what the evaluation harness reports.
    """
    try:
        from scripts.harness import metrics  # noqa: WPS433 (intentional lazy import)
    except Exception as exc:  # pragma: no cover - environment/config error path
        raise RuntimeError(
            "scripts.harness.metrics is required to score weights "
            f"(could not import it: {exc})"
        ) from exc

    if not y_true_idx:
        # No resolved events -> undefined loss. Caller must guard for this.
        raise ValueError("cannot compute log-loss over an empty dataset")

    # Preferred path: one batched call to the shared multiclass loss. The harness
    # contract is multiclass_log_loss(rows) where rows is an iterable of
    # (y_true_idx, probs) pairs, so zip the aligned sequences into that shape.
    mll = getattr(metrics, "multiclass_log_loss", None)
    if callable(mll):
        return float(mll(zip((int(i) for i in y_true_idx),
                             (list(p) for p in probs))))

    # Fallback path: average the single-event log_loss the harness guarantees.
    single = getattr(metrics, "log_loss", None)
    if not callable(single):
        raise RuntimeError(
            "scripts.harness.metrics exposes neither multiclass_log_loss nor log_loss"
        )
    total = 0.0
    for idx, p in zip(y_true_idx, probs):
        total += float(single(idx, list(p)))
    return total / len(y_true_idx)


# ---------------------------------------------------------------------------
# The internal demo model: a logistic blend of signed signal features.
# ---------------------------------------------------------------------------
def _sigmoid(x: float) -> float:
    """Numerically-stable logistic. Keeps probabilities strictly in (0, 1)."""
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def _predict_probs(features: Dict[str, float],
                   weights: Dict[str, float]) -> List[float]:
    """Map one event's signed signal features to a [p_away, p_home] vector.

    score = sum_s weights[s] * features[s]   (a signed "home edge" in logits)
    p_home = sigmoid(score);  p_away = 1 - p_home

    Only signals present in BOTH `weights` and `features` contribute. A signal at
    weight 0 (the day-zero default for every registry signal) contributes nothing
    until the fit earns it weight — exactly the intended behavior.
    """
    score = 0.0
    for name, w in weights.items():
        if w == 0.0:
            continue  # cheap skip; weight-0 signals are inert by construction
        score += w * float(features.get(name, 0.0))
    p_home = _sigmoid(score)
    # Clamp away from the exact endpoints so log-loss never sees log(0).
    eps = 1e-12
    p_home = min(1.0 - eps, max(eps, p_home))
    return [1.0 - p_home, p_home]


def _score_weights(rows: Sequence[dict], weights: Dict[str, float]) -> float:
    """Mean log-loss of `weights` over `rows` (each row already leak-safe)."""
    y = [int(r["outcome"]) for r in rows]
    p = [_predict_probs(r["features"], weights) for r in rows]
    return _dataset_log_loss(y, p)


# ---------------------------------------------------------------------------
# Deterministic coordinate/grid search.
# ---------------------------------------------------------------------------
# Fixed candidate offsets applied to each signal weight, sorted so the sweep is
# order-stable. Small and symmetric: this is a skeleton, not a tuned optimizer.
_GRID_STEPS: Tuple[float, ...] = (-0.50, -0.25, -0.10, 0.0, 0.10, 0.25, 0.50)


def _coordinate_search(train_rows: Sequence[dict],
                       start_weights: Dict[str, float],
                       signal_names: Sequence[str],
                       passes: int = 2) -> Dict[str, float]:
    """One-coordinate-at-a-time descent over a fixed grid, on TRAIN rows only.

    Deterministic: signals are visited in the given (sorted) order, each tried
    against the fixed `_GRID_STEPS`, and the best-improving step is kept before
    moving on. Repeated for `passes` sweeps so early coordinates can benefit from
    later ones. No randomness, no early-stop heuristics that depend on wall clock.
    """
    weights = dict(start_weights)
    best_loss = _score_weights(train_rows, weights)

    for _ in range(passes):
        for name in signal_names:
            base = weights.get(name, 0.0)
            best_val = base
            for step in _GRID_STEPS:
                weights[name] = base + step
                loss = _score_weights(train_rows, weights)
                # Strict improvement only; ties keep the earlier (smaller-|step|)
                # value because 0.0 is visited and wins ties by arriving first.
                if loss < best_loss - 1e-15:
                    best_loss = loss
                    best_val = weights[name]
            weights[name] = best_val
    return weights


def _shrink(fitted: Dict[str, float],
            current: Dict[str, float],
            n: int,
            k: float = 8.0) -> Dict[str, float]:
    """Shrink fitted weights toward current weights based on sample size.

    lam = n / (n + k) grows from ~0 (tiny samples -> trust the incumbent) toward
    1 (large samples -> trust the fit). This is the small-sample regularizer that
    stops a handful of games from yanking weights around.

        out[s] = lam * fitted[s] + (1 - lam) * current[s]

    `k` is the pseudo-count: the sample size at which fitted and current are
    weighted equally.
    """
    lam = n / (n + k) if (n + k) > 0 else 0.0
    out: Dict[str, float] = {}
    names = set(fitted) | set(current)
    for name in sorted(names):  # sorted -> deterministic dict ordering on disk
        f = fitted.get(name, 0.0)
        c = current.get(name, 0.0)
        out[name] = lam * f + (1.0 - lam) * c
    return out


# ---------------------------------------------------------------------------
# Walk-forward driver + the public fit entry point.
# ---------------------------------------------------------------------------
def _sorted_rows(rows: Sequence[dict]) -> List[dict]:
    """Chronological, deterministic ordering for walk-forward evaluation."""
    def key(r: dict) -> Tuple[str, str]:
        # locked_utc is when the prediction was frozen; event_id breaks ties.
        return (str(r.get("locked_utc", "")), str(r.get("event_id", "")))
    return sorted(rows, key=key)


def _walk_forward_oos(rows: Sequence[dict],
                      current_weights: Dict[str, float],
                      signal_names: Sequence[str],
                      n_folds: int,
                      shrink_k: float) -> Tuple[List[int], List[List[float]], List[List[float]]]:
    """Produce out-of-sample predictions for both current and candidate weights.

    Expanding-window walk-forward: split the chronologically-sorted rows into
    `n_folds` contiguous blocks. For each block after the first, fit (coordinate
    search + shrinkage) on everything strictly BEFORE it, then predict that block.
    Predictions for a block are therefore never influenced by that block's
    outcomes -> genuinely leak-safe, out-of-sample loss.

    Returns (y_true, current_probs, candidate_probs) aligned over all OOS rows.
    """
    ordered = _sorted_rows(rows)
    n = len(ordered)
    folds = max(2, n_folds)
    # Contiguous, near-equal fold boundaries; first fold is train-only seed.
    bounds = [round(i * n / folds) for i in range(folds + 1)]

    y_true: List[int] = []
    cur_probs: List[List[float]] = []
    cand_probs: List[List[float]] = []

    for fi in range(1, folds):
        train = ordered[: bounds[fi]]
        test = ordered[bounds[fi]: bounds[fi + 1]]
        if not train or not test:
            continue
        # Fit on the past only, then regularize toward the incumbent.
        fitted = _coordinate_search(train, current_weights, signal_names)
        candidate = _shrink(fitted, current_weights, n=len(train), k=shrink_k)
        for r in test:
            y_true.append(int(r["outcome"]))
            cur_probs.append(_predict_probs(r["features"], current_weights))
            cand_probs.append(_predict_probs(r["features"], candidate))

    return y_true, cur_probs, cand_probs


def fit_weights(rows: Sequence[dict],
                current_weights: Dict[str, float],
                signal_names: Sequence[str] | None = None,
                margin: float = 0.0015,
                n_folds: int = 4,
                shrink_k: float = 8.0) -> dict:
    """Fit signal weights walk-forward and decide adoption via NEVER REGRESS.

    Parameters
    ----------
    rows : sequence of dict
        Resolved snapshot rows. Each must have:
            - "event_id"  : str
            - "features"  : dict[signal_name -> float]  (leak-safe, as-of event)
            - "outcome"   : int class index (0 = away win, 1 = home win)
            - "locked_utc": str ISO timestamp the prediction was frozen at
    current_weights : dict
        The incumbent weight vector (signals at 0.0 on day zero).
    signal_names : sequence of str, optional
        Which signals the search is allowed to move. Defaults to the sorted keys
        of `current_weights` so the sweep order is deterministic.
    margin : float
        NEVER REGRESS margin passed straight through to should_adopt.
    n_folds : int
        Number of walk-forward folds (>=2).
    shrink_k : float
        Shrinkage pseudo-count; larger -> stronger pull toward current on small n.

    Returns
    -------
    dict
        Tuning summary:
            {
              "current_loss":   float,   # OOS log-loss of incumbent weights
              "candidate_loss": float,   # OOS log-loss of fitted+shrunk weights
              "adopted":        bool,    # should_adopt(current, candidate, margin)
              "margin":         float,
              "weights":        dict,    # the weights to USE going forward
                                         # (candidate if adopted, else current)
            }

    Notes
    -----
    Deterministic and offline. If there are too few resolved rows to form an
    out-of-sample split, nothing is adopted and current weights are returned
    unchanged (the honest default: no data, no change).
    """
    # Absolute import (repo root is on sys.path, see module top) so this works
    # both as an imported package and as a directly-run script.
    from scripts.optimize.never_regress import should_adopt

    if signal_names is None:
        signal_names = sorted(current_weights.keys())
    else:
        signal_names = list(signal_names)

    y_true, cur_probs, cand_probs = _walk_forward_oos(
        rows, current_weights, signal_names, n_folds=n_folds, shrink_k=shrink_k
    )

    # Not enough data to evaluate out-of-sample -> refuse to change anything.
    if not y_true:
        return {
            "current_loss": None,
            "candidate_loss": None,
            "adopted": False,
            "margin": margin,
            "weights": dict(current_weights),
        }

    current_loss = _dataset_log_loss(y_true, cur_probs)
    candidate_loss = _dataset_log_loss(y_true, cand_probs)
    adopted = should_adopt(current_loss, candidate_loss, margin=margin)

    # Re-fit the ADOPTED weights on ALL rows (still shrunk) so production uses the
    # full history — the walk-forward split was only for honest loss estimation,
    # never for the weights we ship. If not adopted, keep current untouched.
    if adopted:
        fitted_all = _coordinate_search(_sorted_rows(rows), current_weights, signal_names)
        ship_weights = _shrink(fitted_all, current_weights, n=len(rows), k=shrink_k)
    else:
        ship_weights = dict(current_weights)

    return {
        "current_loss": round(current_loss, 6),
        "candidate_loss": round(candidate_loss, 6),
        "adopted": adopted,
        "margin": margin,
        "weights": {k: round(v, 6) for k, v in sorted(ship_weights.items())},
    }


# ---------------------------------------------------------------------------
# Offline demo dataset. Real deployments feed archived resolved snapshots here;
# until those exist in the scaffold we synthesize a small, fully deterministic
# set so `python3 scripts/optimize/optimize_weights.py` demonstrates the whole
# fit->shrink->NEVER-REGRESS loop with no I/O and no external data.
# ---------------------------------------------------------------------------
def _synthetic_rows() -> List[dict]:
    """A deterministic toy dataset where `elo` genuinely predicts the outcome.

    We construct events whose home team wins iff its elo edge is positive, with a
    couple of upsets mixed in so the loss is never a degenerate 0. `market_spread`
    is a weaker echo of the same signal; every other registry signal is pure noise
    at value 0 and should therefore earn no weight. No RNG — the pattern is coded
    explicitly for reproducibility.
    """
    # (elo_edge, spread_edge, outcome) tuples. outcome 1 = home win.
    pattern = [
        (0.8, 0.5, 1), (-0.7, -0.4, 0), (1.2, 0.9, 1), (-1.1, -0.8, 0),
        (0.3, 0.2, 1), (-0.4, -0.1, 0), (0.9, 0.6, 1), (-0.9, -0.5, 0),
        (0.5, 0.3, 1), (-0.6, -0.3, 0), (1.0, 0.7, 1), (-1.0, -0.6, 0),
        (0.2, 0.1, 0),  # a mild upset: small edge, home still lost
        (-0.2, -0.1, 1),  # a mild upset the other way
        (0.7, 0.4, 1), (-0.8, -0.5, 0),
    ]
    rows: List[dict] = []
    for i, (elo, spread, outcome) in enumerate(pattern):
        rows.append({
            "event_id": f"DEMO-{i:03d}",
            # locked_utc strictly increasing -> a clean chronological order.
            "locked_utc": f"2026-09-{10 + i // 8:02d}T{(i % 8) * 3:02d}:00:00Z",
            "features": {"elo": elo, "market_spread": spread},
            "outcome": outcome,
        })
    return rows


def _demo_current_weights() -> Dict[str, float]:
    """Day-zero incumbent: every relevant signal at 0.0 (nothing earned yet)."""
    return {"elo": 0.0, "market_spread": 0.0}


def _main() -> int:
    """CLI entry: if data/fixtures exists, print a tuning summary; else no-op.

    Gated on the fixtures directory per the build spec. Uses the synthetic demo
    rows (a stand-in until real resolved snapshots are archived) so the run is
    deterministic and needs no network or extra data files.
    """
    if not os.path.isdir(_FIXTURES_DIR):
        # Clean no-op: nothing to demonstrate, exit successfully.
        print("optimize_weights: data/fixtures not found; nothing to do.")
        return 0

    rows = _synthetic_rows()
    current = _demo_current_weights()
    summary = fit_weights(rows, current)
    # ensure_ascii=True + indent=2 to match the repo's JSON-on-disk convention,
    # even though this is stdout (keeps output copy-pasteable into fixtures).
    print(json.dumps(summary, ensure_ascii=True, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
