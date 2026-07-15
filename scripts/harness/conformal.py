"""Split-conformal prediction sets ("safe sets").

The user-facing uncertainty layer. Instead of a false point estimate we present
a SET of plausible outcomes with a coverage guarantee: at 85% coverage, the true
outcome falls inside the reported set ~85% of the time (marginally, over the
calibration distribution). This is the honest way to say "we're not sure" —
a wider set means more genuine uncertainty.

Method: the standard LAC / "least-ambiguous set-valued classifier" split-conformal
scheme.
  * Nonconformity score of a labelled example = 1 - p(true class). A confident,
    correct prediction scores near 0; a confident miss scores near 1.
  * calibrate(): on a held-out calibration set of such scores, pick the threshold
    as the finite-sample conformal quantile
        k = ceil((n + 1) * coverage),   threshold = k-th smallest score
    (threshold = 1.0 if k > n, i.e. include everything). This +1 correction is
    what gives the finite-sample marginal coverage guarantee.
  * safe_set(): for a new probability vector, include every class whose
    nonconformity 1 - p_k <= threshold, i.e. every p_k >= 1 - threshold.

Everything here is deterministic (only sorting) and stdlib-only. The Node test
(tests/feature/conformal.test.mjs, Agent 6) re-checks coverage on a fixed set.
"""

import math

# The two coverage levels the platform exposes. 0.85 = "likely" band,
# 0.70 = "core" band. Higher coverage => larger, safer sets.
COVERAGES = (0.85, 0.70)


def nonconformity(probs, true_idx):
    """Nonconformity score of a labelled example: 1 - p(true class).

    Lower = the model conformed well (put mass on the realized outcome).
    """
    if true_idx < 0 or true_idx >= len(probs):
        raise IndexError("true_idx %r out of range for probs of len %d"
                         % (true_idx, len(probs)))
    p = probs[true_idx]
    # Clamp into [0, 1] defensively; scores live in [0, 1].
    if p < 0.0:
        p = 0.0
    elif p > 1.0:
        p = 1.0
    return 1.0 - p


def calibrate(scores, coverage):
    """Return the conformal nonconformity threshold for a target coverage.

    `scores`   : calibration nonconformity scores (list of 1 - p_true values).
    `coverage` : desired marginal coverage in (0, 1), e.g. 0.85.

    Uses the finite-sample quantile k = ceil((n+1) * coverage). If k exceeds the
    number of calibration points we cannot guarantee the level with this sample,
    so we return 1.0 (the maximal nonconformity) which yields all-inclusive sets
    — the conservative, honest fallback rather than a falsely tight set.
    """
    if not 0.0 < coverage < 1.0:
        raise ValueError("coverage must be in (0, 1), got %r" % (coverage,))
    scores = sorted(scores)
    n = len(scores)
    if n == 0:
        raise ValueError("calibrate requires at least one calibration score")
    k = math.ceil((n + 1) * coverage)
    if k > n:
        # Not enough calibration data to certify this level; include everything.
        return 1.0
    # k is 1-based; index into the sorted list.
    return scores[k - 1]


def safe_set(probs, threshold):
    """Return the list of outcome indices in the conformal safe set.

    An outcome k is included iff its nonconformity 1 - p_k <= threshold. The set
    is never empty: if the threshold would exclude all classes we fall back to
    the single argmax outcome, because reporting "no plausible outcome" for an
    event that will certainly have one is dishonest.
    """
    included = [k for k, p in enumerate(probs)
                if (1.0 - p) <= threshold + 1e-12]  # tiny slack for float eq
    if not included:
        # Degenerate threshold: keep the most probable class so the set is a
        # valid non-empty prediction.
        best = max(range(len(probs)), key=lambda k: probs[k])
        included = [best]
    return included


def safe_sets_85_70(cal_scores, probs):
    """Convenience: build both the 85% and 70% safe sets in one call.

    `cal_scores` : calibration nonconformity scores.
    `probs`      : the probability vector to build sets for.
    Returns a dict keyed by coverage (float) ->
        {"threshold": float, "safe_set": [idx, ...]}
    """
    out = {}
    for cov in COVERAGES:
        thr = calibrate(cal_scores, cov)
        out[cov] = {
            "threshold": thr,
            "safe_set": safe_set(probs, thr),
        }
    return out
