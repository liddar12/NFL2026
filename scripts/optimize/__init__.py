"""nfl2026 weight optimizer + NEVER REGRESS gate.

This package is the core inherited asset of the platform: it turns archived,
point-in-time (leak-safe) prediction snapshots into *fitted* signal weights, but
only ever adopts a new weight vector when it beats the incumbent by a margin on
the same held-out set. Everything here is Python 3.11 stdlib only and fully
deterministic so it runs inside the regression gate on a clean box.

Public surface:
    - never_regress.should_adopt(current_loss, candidate_loss, margin=0.0015)
    - optimize_weights.fit_weights(rows, current_weights, ...) -> tuning summary
"""

from .never_regress import should_adopt  # re-export the locked adoption rule

__all__ = ["should_adopt"]
