"""Game outcome model: Elo + market + J5L composite -> full win-probability vector.

NFL games are 2-way (no draw): the outcome vector is {home, away} and sums to 1. This
module combines several *source* probability vectors into one blended vector and emits a
record matching data/contracts/game_predictions.schema.json.

## THE INVARIANT: blend full vectors, never average point picks

The cardinal rule (inherited from wc2026): we blend the full probability VECTORS, and on
directional disagreement we take the MAX, never the average of point picks.

Why. Suppose Elo says home 0.60 and the market says away 0.60 (they disagree on the
favorite). Naively averaging the two would land near 0.50/0.50 — a manufactured coin
flip that throws away the real, strong (but opposing) evidence on both sides. That is
dishonest: neither model thinks it's a coin flip. So when sources disagree on the
favorite we instead take the element-wise MAX across the source vectors and renormalize,
preserving the strongest directional signal rather than washing it out. When sources
agree on the favorite, the weighted average is safe and we use it.

    agree    -> final = normalize( sum_i w_i * vec_i )     (full-vector weighted blend)
    disagree -> final = normalize( elementwise_max_i vec_i ) (preserve strongest signal)

Blend weights start uniform across whatever sources are present (nothing is hand-tuned);
the optimizer refits them later. Deterministic, stdlib only, reads fixtures.
"""

import json
import math
import os
import sys

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from scripts.signals.weather import roof_for_team  # noqa: E402

# Elo: standard 400-point logistic scale. Home-field advantage expressed in Elo points
# (~65 pts ≈ the long-run NFL home edge, roughly 2.0-2.5 points on the spread).
_ELO_SCALE = 400.0
_DEFAULT_HFA_ELO = 65.0

# Margin-to-probability: NFL final margins have a std dev of ~13.5 points. A predicted
# home margin `m` maps to a home win prob via the normal CDF of m / sigma.
_MARGIN_SIGMA = 13.5

# Floor/ceiling so no single source ever reports a literal 0 or 1 (which would blow up
# log-loss downstream). Probabilities live in [_EPS, 1 - _EPS].
_EPS = 1e-4


def _clamp_prob(p):
    return _EPS if p < _EPS else (1.0 - _EPS) if p > 1.0 - _EPS else p


def _normalize2(home, away):
    """Normalize a 2-vector to sum 1, clamped away from the 0/1 rails."""
    home = _clamp_prob(home)
    away = _clamp_prob(away)
    total = home + away
    return {"home": home / total, "away": away / total}


def _vec_from_any(v):
    """Coerce a source value into a {home, away} vector.

    Accepts: {"home":p,"away":q}, a scalar p_home in [0,1], or None -> None.
    """
    if v is None:
        return None
    if isinstance(v, dict):
        if "home" in v and "away" in v:
            return _normalize2(float(v["home"]), float(v["away"]))
        if "home" in v:
            ph = float(v["home"])
            return _normalize2(ph, 1.0 - ph)
    else:
        ph = float(v)
        return _normalize2(ph, 1.0 - ph)
    return None


# ---------------------------------------------------------------------------
# Source constructors: turn raw inputs into {home, away} vectors.
# ---------------------------------------------------------------------------
def elo_prob(home_elo, away_elo, hfa_elo=_DEFAULT_HFA_ELO):
    """Elo win-probability vector for the home team, with home-field advantage."""
    diff = (float(home_elo) - float(away_elo) + hfa_elo) / _ELO_SCALE
    p_home = 1.0 / (1.0 + math.pow(10.0, -diff))
    return _normalize2(p_home, 1.0 - p_home)


def _american_to_prob(ml):
    """American moneyline -> raw (vig-inclusive) implied probability."""
    ml = float(ml)
    if ml < 0:
        return (-ml) / ((-ml) + 100.0)
    return 100.0 / (ml + 100.0)


def market_prob_from_moneyline(home_ml, away_ml):
    """De-vigged win-probability vector from a two-way moneyline.

    Removes the bookmaker's overround by normalizing the two raw implied probs so they
    sum to 1 — the standard proportional de-vig.
    """
    raw_home = _american_to_prob(home_ml)
    raw_away = _american_to_prob(away_ml)
    return _normalize2(raw_home, raw_away)


def prob_from_margin(home_margin, sigma=_MARGIN_SIGMA):
    """Convert a predicted home margin (points) to a win-probability vector.

    Uses the normal CDF of (margin / sigma). This is how a J5L composite point spread
    or an Elo/power-rating margin becomes a probability.
    """
    z = float(home_margin) / sigma
    # Normal CDF via the error function (stdlib math.erf).
    p_home = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
    return _normalize2(p_home, 1.0 - p_home)


# ---------------------------------------------------------------------------
# The blend.
# ---------------------------------------------------------------------------
def _favorite(vec):
    """Which side a vector favors: 'home', 'away', or 'pick' on an exact tie."""
    if vec["home"] > vec["away"]:
        return "home"
    if vec["away"] > vec["home"]:
        return "away"
    return "pick"


def blend_vectors(source_vectors, weights=None):
    """Blend named source vectors into one {home, away} vector.

    source_vectors : {name: {"home":p,"away":q}} — only real sources (None dropped).
    weights        : optional {name: w}. Defaults to UNIFORM across present sources
                     (nothing hand-tuned; the optimizer refits later).

    Applies the max-on-disagreement invariant (see module docstring). Returns
    (vector, meta) where meta = {"disagreement": bool, "favorite": str, "sources": [...]}.
    """
    present = {n: v for n, v in source_vectors.items() if v is not None}
    names = sorted(present.keys())  # sorted -> deterministic

    if not names:
        # No evidence at all -> honest coin flip.
        return {"home": 0.5, "away": 0.5}, {
            "disagreement": False, "favorite": "pick", "sources": [],
        }

    # Directional agreement check across sources (ignore exact 'pick' ties).
    favs = {_favorite(present[n]) for n in names}
    decisive = favs - {"pick"}
    disagreement = len(decisive) > 1

    if disagreement:
        # Preserve the strongest signal on each side rather than averaging to a false
        # toss-up: element-wise max, then renormalize.
        home = max(present[n]["home"] for n in names)
        away = max(present[n]["away"] for n in names)
        blended = _normalize2(home, away)
    else:
        # Sources agree -> safe weighted average of the full vectors.
        if weights is None:
            w = {n: 1.0 / len(names) for n in names}
        else:
            w = {n: float(weights.get(n, 0.0)) for n in names}
            wsum = sum(w.values())
            if wsum <= 0.0:
                w = {n: 1.0 / len(names) for n in names}
            else:
                w = {n: wv / wsum for n, wv in w.items()}
        home = sum(w[n] * present[n]["home"] for n in names)
        away = sum(w[n] * present[n]["away"] for n in names)
        blended = _normalize2(home, away)

    return blended, {
        "disagreement": disagreement,
        "favorite": _favorite(blended),
        "sources": names,
    }


def _game_sources(game):
    """Extract source vectors from a game fixture record (tolerant to missing feeds).

    Recognized inputs (any subset):
      elo:            home_elo + away_elo         -> Elo vector
      market_*:       market.home_moneyline/away_moneyline, or market.home_prob,
                      or market.home_margin/spread                     -> market vector
      j5l_composite:  composite (vector) or composite_margin (points)  -> composite vector
    """
    sources = {}

    # Elo
    if game.get("home_elo") is not None and game.get("away_elo") is not None:
        hfa = game.get("hfa_elo", _DEFAULT_HFA_ELO)
        sources["elo"] = elo_prob(game["home_elo"], game["away_elo"], hfa)

    # Market
    market = game.get("market") or {}
    if market.get("home_moneyline") is not None and market.get("away_moneyline") is not None:
        sources["market"] = market_prob_from_moneyline(
            market["home_moneyline"], market["away_moneyline"]
        )
    elif market.get("home_prob") is not None:
        sources["market"] = _vec_from_any({"home": market["home_prob"]})
    elif market.get("home_margin") is not None:
        sources["market"] = prob_from_margin(market["home_margin"])
    elif market.get("spread_home") is not None:
        # A spread of -3 for the home team == a predicted home margin of +3.
        sources["market"] = prob_from_margin(-float(market["spread_home"]))

    # J5L composite
    if game.get("composite") is not None:
        sources["j5l_composite"] = _vec_from_any(game["composite"])
    elif game.get("composite_margin") is not None:
        sources["j5l_composite"] = prob_from_margin(game["composite_margin"])

    return sources


def predict_game(game, teams=None, weights=None, model="hybrid"):
    """Predict one game. Returns a record valid vs game_predictions.schema.json.

    game    : game fixture record (see _game_sources for accepted feed fields). Required
              output fields sourced from it: game_id, home, away, kickoff_utc, roof.
    teams   : optional teams fixture, used to resolve `roof` if the game lacks it.
    weights : optional {source_name: w} blend weights (default uniform).
    model   : model label recorded on the row.

    `estimate` is always True: a prediction is NOT a measurement. Only after the game is
    FINAL and resolved by the harness does a measured row (with brier/log_loss) exist.
    """
    sources = _game_sources(game)
    vec, meta = blend_vectors(sources, weights=weights)

    # Resolve roof: explicit on the game, else look up the home team, else 'outdoor'.
    roof = game.get("roof")
    if roof not in ("indoor", "outdoor", "retractable"):
        roof = roof_for_team(game.get("home"), teams) if teams is not None else "outdoor"

    return {
        "game_id": game.get("game_id", ""),
        "home": game.get("home", ""),
        "away": game.get("away", ""),
        "kickoff_utc": game.get("kickoff_utc", ""),
        "roof": roof,
        "probs": {"home": round(vec["home"], 4), "away": round(vec["away"], 4)},
        "model": model,
        # Honesty flag: predictions are estimates until the game resolves FINAL.
        "estimate": True,
    }


def predict_games(games, teams=None, weights=None, model="hybrid"):
    """Predict a list of games. Deterministic, order-preserving."""
    return [predict_game(g, teams=teams, weights=weights, model=model) for g in games]


def load_games(path):
    """Load a games fixture. Accepts {"games": [...]} or a bare list."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        return data.get("games", [])
    return data
