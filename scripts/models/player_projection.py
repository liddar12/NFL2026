"""Per-position player projection engine.

Produces one record per player matching data/contracts/player_projections.schema.json:

    {gsis_id, name, team, position, proj_points, low, high, signals_used}

## The projection identity

    proj_points = baseline(prior_perf) * PRODUCT over signals of applied(signal)

where `baseline` is the player's recency-weighted prior production (the `prior_perf`
signal, which is the baseline itself), and each other player signal contributes a raw
multiplicative adjustment `adj` around 1.0.

## The "started at 0" gate (leak-safe influence)

Each signal computes an honest raw adjustment, but its INFLUENCE is gated by its fitted
weight from the registry (mirrored in data/meta.json):

    applied(signal) = 1 + weight * (adj - 1)

At weight 0 (day zero — nothing has earned weight yet) applied == 1.0, so every signal
is *computed but neutral*, and `proj_points` collapses to the pure prior-perf baseline
times the... nothing. That is deliberate: a signal earns influence only when the
walk-forward optimizer awards it weight against out-of-sample proof. `signals_used`
therefore lists only signals with non-zero weight that actually moved the projection —
which is [] on day zero, and that is the honest answer.

## The interval

`low`/`high` are a documented +/- band around the point projection, widened by
position volatility (RB/TE noisiest) and by player-specific uncertainty (injury,
extreme age). This is a transparent placeholder for the harness's split-conformal
"safe set" (scripts/harness/conformal.py): once enough resolved player-weeks exist the
optimizer can replace this band with a calibrated conformal interval. We never present
the band as a measured quantity — it is an estimate of spread, labelled as such upstream.

Deterministic, stdlib only, reads fixtures (never the network).
"""

import json
import os
import sys

# Make repo-root-relative absolute imports work whether this module is imported as
# `scripts.models.player_projection` or run directly (mirrors the optimizer's pattern).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from scripts.signals.registry import SIGNALS               # noqa: E402
from scripts.signals.aging import age_multiplier           # noqa: E402
from scripts.signals.ol_dl import ol_dl_adjustment         # noqa: E402
from scripts.signals.targets import target_competition     # noqa: E402
from scripts.signals.weather import roof_for_team          # noqa: E402

# Default number of games projected for a fully-available player.
_DEFAULT_GAMES = 17

# Position-relative base interval half-width (fraction of the point projection). RB and
# TE are the noisiest fantasy positions week to week and season to season; QB the most
# stable. These are transparent priors, not fitted — see module docstring.
_POSITION_BAND = {"QB": 0.14, "RB": 0.22, "WR": 0.20, "TE": 0.24}

# Injury-status -> (availability, effectiveness) discount. Availability scales games
# played; effectiveness scales per-game output when they do play. healthy == neutral.
_INJURY_STATUS = {
    "healthy": (1.00, 1.00),
    "probable": (0.98, 1.00),
    "questionable": (0.85, 0.95),
    "doubtful": (0.35, 0.90),
    "out": (0.00, 1.00),
    "ir": (0.00, 1.00),
    "pup": (0.50, 0.95),
}

# indoor_outdoor: season-long production nudge from the player's home environment. Dome
# teams pass in controlled conditions all year; a small passing-game premium for
# QB/WR/TE, negligible for RB. Retractable treated as ~half a dome (often closed).
_INDOOR_BONUS = {"QB": 0.03, "WR": 0.03, "TE": 0.02, "RB": 0.00}


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _weight(name, weights):
    """Fitted weight for a signal: the override map if given, else the registry (0.0)."""
    if weights is not None and name in weights:
        return float(weights[name])
    rec = SIGNALS.get(name)
    return float(rec["weight"]) if rec else 0.0


def _baseline_points(player):
    """Season-long baseline from prior_perf, tolerant to a few fixture field spellings.

    Priority:
      1. explicit season total: `prior_season_points` / `baseline_points`
      2. per-game * projected games: `prior_points_per_game` * `projected_games`
    Missing everything -> 0.0 (an unknown player projects to nothing, not to a guess).
    """
    for key in ("prior_season_points", "baseline_points"):
        if player.get(key) is not None:
            return float(player[key])
    ppg = player.get("prior_points_per_game")
    if ppg is None:
        ppg = player.get("prior_ppg")
    if ppg is not None:
        games = player.get("projected_games", _DEFAULT_GAMES) or _DEFAULT_GAMES
        return float(ppg) * float(games)
    return 0.0


def compute_raw_signals(player, ctx=None):
    """Compute each player signal's RAW multiplicative adjustment (around 1.0).

    Returns {signal_name: adj}. Only signals we can compute from the available fixture
    fields get a non-1.0 value; the rest are omitted (treated as neutral 1.0 by the
    caller). This is honest: a signal we lack the feed for contributes nothing rather
    than a fabricated number — and since its weight is 0 anyway, it is doubly neutral.

    ctx : optional context dict, e.g. {"teams": <teams fixture>} for roof lookups.
    """
    ctx = ctx or {}
    pos = str(player.get("position", "")).upper()
    adjustments = {}

    # age_curve -----------------------------------------------------------
    age = player.get("age")
    if age is not None:
        adjustments["age_curve"] = age_multiplier(pos, age)

    # ol_composite_vs_dl --------------------------------------------------
    ol = player.get("ol")  # {mass_lbs_avg, strength_grade, continuity_games}
    if ol:
        dl_faced = player.get("dl_faced")  # dict or list of {strength_grade, mass_lbs_avg}
        adjustments["ol_composite_vs_dl"] = ol_dl_adjustment(ol, dl_faced, position=pos)

    # target_competition (skill positions only) --------------------------
    if pos in ("RB", "WR", "TE"):
        own_share = player.get("team_target_share")
        teammate_shares = player.get("teammate_shares")
        if own_share is not None or teammate_shares:
            tc = target_competition(own_share, teammate_shares or [])
            adjustments["target_competition"] = tc["multiplier"]

    # injury_status -------------------------------------------------------
    status = player.get("injury_status")
    if status:
        avail, effect = _INJURY_STATUS.get(str(status).lower(), (1.0, 1.0))
        # Season projection scales by BOTH availability (games) and effectiveness.
        adjustments["injury_status"] = avail * effect

    # injury_history (durability prior) -----------------------------------
    missed_rate = player.get("games_missed_rate")  # fraction of games missed, trailing
    if missed_rate is not None:
        # A durable player (0 missed) is neutral; chronic absences discount the season.
        adjustments["injury_history"] = 1.0 - 0.5 * _clamp(float(missed_rate), 0.0, 1.0)

    # indoor_outdoor ------------------------------------------------------
    teams = ctx.get("teams")
    if teams is not None and player.get("team"):
        roof = roof_for_team(player["team"], teams)
        if roof == "indoor":
            adjustments["indoor_outdoor"] = 1.0 + _INDOOR_BONUS.get(pos, 0.0)
        elif roof == "retractable":
            adjustments["indoor_outdoor"] = 1.0 + 0.5 * _INDOOR_BONUS.get(pos, 0.0)

    return adjustments


def _interval_band(player, applied_signals):
    """Half-width of the projection interval as a fraction of the point estimate.

    Base = position volatility. Widened for known uncertainty drivers (injury flags,
    extreme age past the prime plateau). Transparent prior, not a measured quantity.
    """
    pos = str(player.get("position", "")).upper()
    band = _POSITION_BAND.get(pos, 0.20)

    # Injury uncertainty widens the interval.
    status = str(player.get("injury_status", "healthy")).lower()
    if status in ("questionable", "doubtful", "pup"):
        band += 0.06
    if player.get("games_missed_rate", 0) and float(player["games_missed_rate"]) > 0.25:
        band += 0.04

    # Age uncertainty: a steep age adjustment (either way) means more spread.
    age_adj = applied_signals.get("age_curve", 1.0)
    band += 0.5 * abs(1.0 - age_adj)

    return _clamp(band, 0.05, 0.60)


def project_player(player, ctx=None, weights=None):
    """Project one player. Returns a record valid vs player_projections.schema.json.

    player  : a player fixture record (see field usage in compute_raw_signals /
              _baseline_points). Required for output: gsis_id, name, team, position.
    ctx     : optional context (e.g. {"teams": <teams fixture>}).
    weights : optional {signal_name: fitted_weight} override. Defaults to the registry
              weights (all 0.0 at day zero).
    """
    pos = str(player.get("position", "")).upper()
    baseline = _baseline_points(player)

    raw = compute_raw_signals(player, ctx)

    # Apply each raw adjustment gated by its fitted weight. At weight 0 the applied
    # factor is 1.0 (neutral) no matter how large the raw adjustment is.
    proj = baseline
    signals_used = []
    for name, adj in raw.items():
        w = _weight(name, weights)
        applied = 1.0 + w * (adj - 1.0)
        proj *= applied
        # A signal is "used" only if it carries weight AND actually moved the number.
        if w != 0.0 and applied != 1.0:
            signals_used.append(name)

    band = _interval_band(player, raw)
    low = proj * (1.0 - band)
    high = proj * (1.0 + band)

    return {
        "gsis_id": player.get("gsis_id", ""),
        "name": player.get("name", ""),
        "team": player.get("team", ""),
        "position": pos,
        "proj_points": round(proj, 2),
        "low": round(low, 2),
        "high": round(high, 2),
        # Sorted for stable, minimal-diff output.
        "signals_used": sorted(signals_used),
    }


def project_players(players, ctx=None, weights=None):
    """Project a list of player records. Deterministic, order-preserving."""
    return [project_player(p, ctx=ctx, weights=weights) for p in players]


def load_players(path):
    """Load a players fixture. Accepts {"players": [...]} or a bare list."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        return data.get("players", [])
    return data
