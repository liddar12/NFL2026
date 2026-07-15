"""The signal registry — the single source of truth for every named signal.

`SIGNALS` maps each signal name to `{group, weight, description}`. It is mirrored,
name-for-name and all at weight 0.0, into `data/meta.json`'s `weights` map (owned by
Agent 6). The Node test `tests/feature/signal_registry.test.mjs` reads that meta.json
and asserts every name below is present and set to exactly 0.0. THEREFORE the names
here and in meta.json must match byte-for-byte — do not rename or reorder casually.

Groups:
  "player"  -- season-long per-player projection factors
  "game"    -- game-outcome (win probability) factors
  "market"  -- sportsbook / prediction-market feeds, treated as first-class models

The "enters at weight 0" rule (docs/SIGNAL_REGISTRY.md): nothing is hand-weighted.
Every signal starts at 0.0 and earns weight only if the walk-forward optimizer proves
it beats the current weight vector on held-out log-loss by the NEVER-REGRESS margin.
On day zero (scaffold time) every weight is 0.0 — nothing has earned its place yet.

Stdlib only. Deterministic (insertion-ordered).
"""

from collections import OrderedDict

# Day-zero weight. Every signal is born here. The optimizer is the ONLY thing that
# may move a weight off 0.0, and only against out-of-sample proof.
_ZERO = 0.0


def _s(group, description):
    """Build a fresh signal record. Each call returns its own dict so no two signals
    accidentally share a mutable weight cell."""
    return {"group": group, "weight": _ZERO, "description": description}


# ---------------------------------------------------------------------------
# THE REGISTRY. Order is meaningful and stable: player signals, then game, then
# market. If you add a signal, add it here AND in data/meta.json's weights map.
# ---------------------------------------------------------------------------
SIGNALS = OrderedDict()

# --- Player signals (season-long projection) -------------------------------
SIGNALS["prior_perf"] = _s(
    "player",
    "Baseline: recency-weighted recent per-game production (points/yards/TDs) from "
    "prior seasons plus season-to-date. This IS the projection baseline; other "
    "player signals scale it.",
)
SIGNALS["age_curve"] = _s(
    "player",
    "Position-specific aging multiplier from scripts/signals/aging.py. RB declines "
    "earliest and steepest; QB latest.",
)
SIGNALS["injury_status"] = _s(
    "player",
    "Current game designation (OUT/DOUBTFUL/QUESTIONABLE/PROBABLE/healthy) mapped to "
    "an availability + effectiveness discount.",
)
SIGNALS["injury_history"] = _s(
    "player",
    "Trailing games-missed rate and recurring-injury flags; a durability prior on how "
    "much of the season this player is likely to be available.",
)
SIGNALS["ol_composite_vs_dl"] = _s(
    "player",
    "O-line combined mass + strength proxy + continuity (games the same five started "
    "together) versus the specific D-lines faced; scales pass-pro and run-blocking "
    "dependent production (scripts/signals/ol_dl.py).",
)
SIGNALS["target_competition"] = _s(
    "player",
    "Teammates who draw targets/touches away from this player; a share-of-opportunity "
    "discount (scripts/signals/targets.py).",
)
SIGNALS["qb_accuracy_delta"] = _s(
    "player",
    "Change in the passer's accuracy (CPOE-style proxy) versus the pass-catcher's or "
    "back's prior QB; up-weights receivers who inherit a more accurate QB.",
)
SIGNALS["qb_coaching"] = _s(
    "player",
    "QB-room / QB-coach quality change affecting passer development and protection "
    "reads.",
)
SIGNALS["coordinator_change"] = _s(
    "player",
    "New OC/DC scheme discontinuity; dampens prior-perf reliability and shifts usage.",
)
SIGNALS["head_coach_change"] = _s(
    "player",
    "New head coach; team-culture / usage-philosophy discontinuity applied roster-wide.",
)
SIGNALS["scheme_fit"] = _s(
    "player",
    "Fit between player archetype and the (possibly new) scheme's role demands.",
)
SIGNALS["supporting_cast_delta"] = _s(
    "player",
    "Net change in surrounding talent (added/lost teammates) that raises or lowers this "
    "player's expected efficiency and opportunity.",
)
SIGNALS["one_on_one_matchup"] = _s(
    "player",
    "Projected individual matchup (e.g. WR vs shadow CB, RB vs front-seven) for the "
    "specific opponent.",
)
SIGNALS["schedule_strength"] = _s(
    "player",
    "Strength of the position-relevant opposing units across the slate/season.",
)
SIGNALS["home_away"] = _s(
    "player",
    "Home vs road split adjustment.",
)
SIGNALS["indoor_outdoor"] = _s(
    "player",
    "Dome / retractable-closed vs open-air baseline effect on production, especially "
    "passing and kicking.",
)
SIGNALS["weather"] = _s(
    "player",
    "Wind/temp/precip adjustment from scripts/signals/weather.py; applied only to "
    "outdoor or roof-open games.",
)
SIGNALS["rest_days"] = _s(
    "player",
    "Days since last game (short week / bye / mini-bye) affecting freshness.",
)
SIGNALS["off_field"] = _s(
    "player",
    "Suspensions, holdouts, personal-conduct availability risk not captured by injury "
    "status.",
)

# --- Game signals (win probability) ----------------------------------------
SIGNALS["elo"] = _s(
    "game",
    "Team Elo rating differential (with home adjustment) -> baseline win probability.",
)
SIGNALS["market_spread"] = _s(
    "game",
    "Consensus point spread converted to a cover/win probability.",
)
SIGNALS["market_moneyline"] = _s(
    "game",
    "Consensus moneyline de-vigged to an implied win probability.",
)
SIGNALS["market_total"] = _s(
    "game",
    "Consensus over/under; informs pace/scoring for parlays and player props.",
)
SIGNALS["j5l_composite"] = _s(
    "game",
    "The fitted curated + Elo + signal composite score for the matchup.",
)
SIGNALS["home_field"] = _s(
    "game",
    "Venue-specific home-field advantage (crowd, travel, altitude where relevant).",
)
SIGNALS["rest_differential"] = _s(
    "game",
    "Difference in rest days between the two teams (off-bye vs short week).",
)
SIGNALS["travel"] = _s(
    "game",
    "Distance / time-zone crossing / body-clock burden for the visiting team.",
)
SIGNALS["weather_game"] = _s(
    "game",
    "Game-level wind/temp/precip effect on total scoring and variance.",
)
SIGNALS["injury_impact"] = _s(
    "game",
    "Aggregate roster injury burden (weighted by player importance) per side.",
)

# --- Market signals (first-class models, not just benchmarks) --------------
SIGNALS["odds_api"] = _s(
    "market",
    "The Odds API consensus lines (spread/ML/total) de-vigged to probabilities.",
)
SIGNALS["kalshi"] = _s(
    "market",
    "Kalshi event-contract prices -> implied probabilities for NFL markets.",
)
SIGNALS["polymarket"] = _s(
    "market",
    "Polymarket contract prices -> implied probabilities where NFL markets exist.",
)

# Valid group labels. Kept as a frozenset so validate_registry can reject typos.
_VALID_GROUPS = frozenset({"player", "game", "market"})


def signal_names():
    """Return the signal names in registry order (a list).

    This is the ordered list Agent 6 mirrors into data/meta.json's weights map.
    """
    return list(SIGNALS.keys())


def validate_registry():
    """Assert the registry is internally consistent. Raises ValueError on any problem.

    Invariants checked (these are the contract the rest of the platform relies on):
      * names are unique (guaranteed by dict, but we re-check defensively),
      * every record has exactly {group, weight, description},
      * every group is one of the valid labels,
      * every weight is exactly 0.0 at day zero (the "started at 0" rule),
      * every description is a non-empty string.

    Returns True on success so callers can `assert validate_registry()`.
    """
    seen = set()
    for name, rec in SIGNALS.items():
        if not isinstance(name, str) or not name:
            raise ValueError("signal name must be a non-empty string, got %r" % (name,))
        if name in seen:
            # Cannot actually happen with a dict, but the check documents intent.
            raise ValueError("duplicate signal name: %r" % (name,))
        seen.add(name)

        if set(rec.keys()) != {"group", "weight", "description"}:
            raise ValueError(
                "signal %r must have exactly keys {group, weight, description}, got %r"
                % (name, sorted(rec.keys()))
            )
        if rec["group"] not in _VALID_GROUPS:
            raise ValueError(
                "signal %r has invalid group %r (must be one of %s)"
                % (name, rec["group"], sorted(_VALID_GROUPS))
            )
        # Day-zero invariant: NOTHING has earned weight yet. If this ever fails on a
        # fresh checkout, someone hand-weighted a signal — which the discipline forbids.
        if rec["weight"] != 0.0:
            raise ValueError(
                "signal %r has non-zero day-zero weight %r; signals earn weight only "
                "via the optimizer" % (name, rec["weight"])
            )
        if not isinstance(rec["description"], str) or not rec["description"].strip():
            raise ValueError("signal %r has empty description" % (name,))

    return True


# Fail fast at import time: a malformed registry should never be silently usable.
validate_registry()
