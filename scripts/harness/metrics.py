"""Pure-stdlib scoring metrics for the evaluation harness.

Every formula here is deliberately SIMPLE and dependency-free so the Node
regression test (tests/feature/metrics.test.mjs, owned by Agent 6) can
re-implement the identical arithmetic and lock exact numeric constants. Do not
"improve" a formula here without updating the mirrored Node test — the whole
point is that the two implementations agree to the bit.

Conventions:
  * Probabilities are clamped to [EPS, 1 - EPS] before any log, so log_loss is
    always finite (no -inf on a confident miss).
  * `y_true_idx` is the integer index of the realized outcome within a
    probability vector `probs` (e.g. probs=[p_home, p_away], y_true_idx=0 means
    home won).
  * These are single-event metrics by design. Aggregation (mean over events) is
    explicit in multiclass_log_loss / mae so the caller controls the unit of
    validation (the event, never the season).
"""

import math

# Clamp bound. Small enough to barely move well-behaved probabilities, large
# enough to keep log_loss finite on a 0-probability realized outcome.
EPS = 1e-15


def clamp_prob(p):
    """Clamp a single probability into [EPS, 1 - EPS]."""
    if p < EPS:
        return EPS
    if p > 1.0 - EPS:
        return 1.0 - EPS
    return p


def log_loss(y_true_idx, probs):
    """Multiclass log loss for ONE event.

    Returns -ln(p) where p is the clamped predicted probability assigned to the
    realized outcome. Lower is better; a perfect confident prediction -> ~0.

    This is the harness objective for game outcomes.
    """
    if y_true_idx < 0 or y_true_idx >= len(probs):
        raise IndexError("y_true_idx %r out of range for probs of len %d"
                         % (y_true_idx, len(probs)))
    p = clamp_prob(probs[y_true_idx])
    return -math.log(p)


def brier(y_true_idx, probs):
    """Multiclass Brier score for ONE event.

    Sum over classes k of (probs[k] - onehot[k])**2, where onehot is 1 at the
    realized outcome and 0 elsewhere. Range [0, 2] for a proper distribution;
    lower is better. Probabilities are clamped for consistency with log_loss,
    though Brier is finite regardless.
    """
    if y_true_idx < 0 or y_true_idx >= len(probs):
        raise IndexError("y_true_idx %r out of range for probs of len %d"
                         % (y_true_idx, len(probs)))
    total = 0.0
    for k, p in enumerate(probs):
        pc = clamp_prob(p)
        target = 1.0 if k == y_true_idx else 0.0
        diff = pc - target
        total += diff * diff
    return total


def multiclass_log_loss(rows):
    """Mean log loss over many events.

    `rows` is an iterable of (y_true_idx, probs) pairs. Returns the arithmetic
    mean of per-event log_loss. Raises on an empty input rather than silently
    returning 0 (a 0 loss on no data would be a dishonest "perfect score").
    """
    rows = list(rows)
    if not rows:
        raise ValueError("multiclass_log_loss requires at least one row")
    total = 0.0
    for y_true_idx, probs in rows:
        total += log_loss(y_true_idx, probs)
    return total / len(rows)


def mae(pred_list, actual_list):
    """Mean absolute error between two equal-length numeric sequences.

    The reported objective for player-point projections (alongside rank_corr).
    """
    pred_list = list(pred_list)
    actual_list = list(actual_list)
    if len(pred_list) != len(actual_list):
        raise ValueError("mae length mismatch: %d vs %d"
                         % (len(pred_list), len(actual_list)))
    if not pred_list:
        raise ValueError("mae requires at least one element")
    total = 0.0
    for p, a in zip(pred_list, actual_list):
        total += abs(p - a)
    return total / len(pred_list)


def _ranks(values):
    """Return fractional (average-tie) ranks for a sequence.

    Ties share the mean of the ranks they would occupy, so Spearman degrades
    gracefully on repeated values. Ranks are 1-based but any constant offset
    cancels in the Pearson step, so the base is irrelevant to the result.
    """
    n = len(values)
    # Sort positions by value; assign average ranks within each tie group.
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        # Extend j over the run of equal values.
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        # Positions i..j (0-based) => 1-based ranks (i+1)..(j+1); average them.
        avg_rank = (i + 1 + j + 1) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def _pearson(xs, ys):
    """Pearson correlation of two equal-length sequences (stdlib math)."""
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    cov = 0.0
    var_x = 0.0
    var_y = 0.0
    for x, y in zip(xs, ys):
        dx = x - mean_x
        dy = y - mean_y
        cov += dx * dy
        var_x += dx * dx
        var_y += dy * dy
    denom = math.sqrt(var_x * var_y)
    if denom == 0.0:
        # No variance in at least one series => correlation undefined; return
        # 0.0 (no measurable monotonic relationship) rather than raising.
        return 0.0
    return cov / denom


def rank_corr(pred, actual):
    """Spearman rank correlation: Pearson correlation of the fractional ranks.

    Simple and mirrorable: rank both sequences (average ties), then Pearson.
    Reported alongside MAE for player projections — measures whether we order
    players correctly even when absolute point levels drift.
    """
    pred = list(pred)
    actual = list(actual)
    if len(pred) != len(actual):
        raise ValueError("rank_corr length mismatch: %d vs %d"
                         % (len(pred), len(actual)))
    if len(pred) < 2:
        raise ValueError("rank_corr requires at least two elements")
    return _pearson(_ranks(pred), _ranks(actual))


def calibration_bins(probs, outcomes, n_bins=10):
    """Reliability-diagram bins for a binary predicted probability.

    `probs`    : predicted probability of the positive class per event (scalar).
    `outcomes` : realized 0/1 label per event.
    Returns a list of n_bins dicts, each:
      {lo, hi, count, avg_pred, avg_outcome}
    where [lo, hi) is the predicted-probability sub-interval of [0, 1]. The last
    bin is closed on the right so a predicted prob of exactly 1.0 lands in it.
    Empty bins report avg_pred = avg_outcome = None (honest: no data, not 0).

    A well-calibrated model has avg_pred ~= avg_outcome in every populated bin.
    """
    if len(probs) != len(outcomes):
        raise ValueError("calibration_bins length mismatch: %d vs %d"
                         % (len(probs), len(outcomes)))
    if n_bins < 1:
        raise ValueError("n_bins must be >= 1")

    width = 1.0 / n_bins
    # Accumulators per bin.
    sums_pred = [0.0] * n_bins
    sums_out = [0.0] * n_bins
    counts = [0] * n_bins

    for p, o in zip(probs, outcomes):
        pc = clamp_prob(p)
        # Bin index; clamp into range and put exact 1.0 into the last bin.
        idx = int(pc / width)
        if idx >= n_bins:
            idx = n_bins - 1
        sums_pred[idx] += pc
        sums_out[idx] += o
        counts[idx] += 1

    bins = []
    for i in range(n_bins):
        lo = i * width
        hi = (i + 1) * width
        c = counts[i]
        if c == 0:
            avg_pred = None
            avg_out = None
        else:
            avg_pred = sums_pred[i] / c
            avg_out = sums_out[i] / c
        bins.append({
            "lo": lo,
            "hi": hi,
            "count": c,
            "avg_pred": avg_pred,
            "avg_outcome": avg_out,
        })
    return bins
