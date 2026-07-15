"""Scraper package for NFL2026 — the *only* place external data libraries live.

HARD RULE (inherited from wc2026, see repo CLAUDE.md / build spec):
the regression gate must run green on a clean box with **no pip install**. So NOTHING
in this package may be imported by the gate, and every module here imports its heavy
dependency (`nfl_data_py`, `requests`) **inside the fetch function**, guarded, so that
merely importing the module — which the gate's discovery might do transitively — never
raises. A missing package surfaces as a single clear, actionable line at *call* time,
not a bare ImportError at import time.

Determinism note: these modules touch the network and the wall clock, so they are NOT
part of the deterministic gate. The gate-safe orchestrator (`scripts/build_all.py`)
reads pre-committed fixtures instead and never imports this package.

Modules:
  renames.py       -- ESPN <-> nflverse team/player name reconciliation (mirror in JS)
  nflverse.py      -- weekly stats / rosters / depth charts / snap counts (nfl_data_py)
  espn.py          -- schedule / scores / injuries (ESPN public JSON, requests)
  odds.py          -- Odds API + Kalshi implied probabilities, free-tier budgeted
  weather_fetch.py -- Open-Meteo keyless forecast for a stadium lat/lon
"""

# Re-export the pure, dependency-free helpers so callers can do
# `from scripts.scrape import normalize_team` without triggering a guarded import.
from .renames import RENAMES, PLAYER_RENAMES, normalize_team, canonical_player_name

__all__ = [
    "RENAMES",
    "PLAYER_RENAMES",
    "normalize_team",
    "canonical_player_name",
]
