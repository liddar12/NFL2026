"""Signal package for NFL2026.

Each *factor* the platform considers is a named **signal**. Signals live here as
small, deterministic, stdlib-only functions that each compute a raw multiplicative
adjustment around 1.0 (1.0 == neutral / no effect). The single source of truth for
which signals exist — and their current fitted weight — is `registry.SIGNALS`.

The "Dominance started at 0" discipline (see docs/SIGNAL_REGISTRY.md): a signal is
*named and computed* here, but it contributes nothing to any projection until the
walk-forward optimizer awards it weight. On day zero every weight is 0.0, so every
signal's *effective* contribution is neutral even though the raw adjustment is
computed. That separation — compute the factor honestly, gate its influence on
out-of-sample proof — is the whole point.

Modules:
  registry.py  -- the canonical signal list (all weights 0.0) + validation
  aging.py     -- position-specific age curves (QB/RB/WR/TE)
  ol_dl.py     -- O-line vs D-line mass/strength/continuity adjustment
  targets.py   -- target/touch competition (share-of-opportunity discount)
  weather.py   -- stadium roof lookup + wind/temp/precip adjustment
"""

from .registry import SIGNALS, validate_registry, signal_names

__all__ = ["SIGNALS", "validate_registry", "signal_names"]
