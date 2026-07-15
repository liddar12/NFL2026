"""nfl2026 evaluation harness (Agent 2).

The harness is the product; models are plug-ins. This package holds the
leak-safe, honesty-enforcing evaluation machinery:

- metrics    : pure-stdlib scoring rules (log_loss, brier, mae, rank_corr, ...)
- snapshot   : point-in-time prediction rows written to data/snapshots/
- honesty    : the estimate-vs-measured invariant enforcer
- conformal  : split-conformal "safe sets" (85% / 70% coverage)

Global invariants (see the shared build spec):
  * ZERO external dependencies. Python 3.11 stdlib only.
  * Deterministic. No RNG without a fixed seed, no wall-clock in tested logic.
  * Honesty: a row that is a bare estimate can NEVER carry measured scores, and
    a resolved measurement can NEVER omit them.
"""

# Re-export the most commonly used entry points so callers can do e.g.
#   from harness import log_loss, brier, resolve, validate
# without needing to know the exact submodule layout.
from .metrics import (
    log_loss,
    brier,
    multiclass_log_loss,
    mae,
    rank_corr,
    calibration_bins,
    clamp_prob,
    EPS,
)
from .snapshot import (
    make_row,
    resolve,
    write_snapshot,
    load_snapshot,
    SNAPSHOT_DIR,
)
from .honesty import validate, assert_measured_rows, HonestyError
from .conformal import calibrate, safe_set, safe_sets_85_70

__all__ = [
    # metrics
    "log_loss",
    "brier",
    "multiclass_log_loss",
    "mae",
    "rank_corr",
    "calibration_bins",
    "clamp_prob",
    "EPS",
    # snapshot
    "make_row",
    "resolve",
    "write_snapshot",
    "load_snapshot",
    "SNAPSHOT_DIR",
    # honesty
    "validate",
    "assert_measured_rows",
    "HonestyError",
    # conformal
    "calibrate",
    "safe_set",
    "safe_sets_85_70",
]
