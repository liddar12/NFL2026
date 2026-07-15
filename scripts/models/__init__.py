"""Model package for NFL2026.

Models are plug-ins on top of the evaluation harness — the harness is the product.
Each model is deterministic, stdlib-only, and reads fixtures (never the network) so the
regression gate can run it on a clean box with no installs.

Modules:
  player_projection.py -- per-position season projection (baseline + signals -> points
                          + low/high interval)
  game_model.py        -- Elo + market + composite -> full 2-way probability vector
                          (full-vector blend; max-on-disagreement invariant)
  parlay_builder.py    -- >=3 parlays/game and >=3/week, correlation-aware, EV + tier
"""
