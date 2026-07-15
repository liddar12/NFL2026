"""NEVER REGRESS — the margin-gated adoption rule.

This is the single most important discipline in the whole platform, and it is
deliberately tiny, pure, and dependency-free so it can never rot or drift:

    A newly-fitted parameter vector is adopted ONLY if its leak-safe log-loss
    beats the incumbent's log-loss by at least `margin`. Otherwise the current
    parameters are kept, unchanged.

Why a *margin* and not plain `<`? Because a candidate that is only microscopically
"better" is almost always noise fitted to the particular held-out sample. Requiring
a real, non-trivial improvement (default 0.0015 nats of log-loss) stops the model
from churning weights on noise and quietly regressing production quality. New
signals therefore enter at weight 0 and earn weight only by clearing this bar.

The exact rule below is LOCKED by a Node test (tests/feature/never_regress.test.mjs).
Do not "improve" it — mirror it if you must re-implement it elsewhere.
"""

from __future__ import annotations


def should_adopt(current_loss: float, candidate_loss: float,
                 margin: float = 0.0015) -> bool:
    """Return True iff the candidate should replace the current parameters.

    Adoption requires the candidate to beat the incumbent by strictly more than
    `margin`:

        candidate_loss < current_loss - margin

    Parameters
    ----------
    current_loss : float
        Held-out (leak-safe) log-loss of the parameters currently in production.
    candidate_loss : float
        Held-out (leak-safe) log-loss of the newly-fitted candidate parameters,
        measured on the *same* set as ``current_loss``.
    margin : float, optional
        Minimum improvement (in the same units as the losses, i.e. mean log-loss)
        the candidate must clear. Defaults to 0.0015. Must be >= 0; a negative
        margin would let a *worse* model in, which is never intended.

    Returns
    -------
    bool
        True  -> adopt the candidate.
        False -> keep the current parameters (ties, regressions, and improvements
                 smaller than the margin all keep current).

    Notes
    -----
    Pure and deterministic: no I/O, no globals, no randomness. Equal losses are
    NOT adopted (that is the whole point — no free lunch for noise).
    """
    # Guard against a mis-configured margin sneaking a regression past the gate.
    if margin < 0:
        raise ValueError("margin must be >= 0 (a negative margin would admit regressions)")

    # The one rule. Strict `<` against the margin-shifted threshold means an
    # improvement must be genuinely larger than `margin`, and exact ties fail.
    return candidate_loss < current_loss - margin
