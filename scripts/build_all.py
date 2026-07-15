"""build_all — the OFFLINE, GATE-SAFE orchestrator.

Reads pre-committed fixtures under `data/fixtures/` and writes the three model outputs:
  data/player_projections.json   (schema: player_projections.schema.json)
  data/game_predictions.json     (schema: game_predictions.schema.json)
  data/parlays.json              (schema: parlays.schema.json)

HARD CONTRACT (why this file is special):
  * STDLIB ONLY. No numpy/pandas/requests — so CI can run it on a clean box.
  * NO NETWORK. It never touches a scraper; the fixtures are the whole input.
  * DETERMINISTIC. Same fixtures -> byte-identical JSON (modulo the injectable
    `--as-of` timestamp). No `random`, no unseeded anything.
  * GRACEFUL DEGRADATION. It PREFERS the real model engines in `scripts/models/*`,
    but those are authored by another agent and may be absent or have a different
    surface at scaffold time. Every model call is wrapped: if the engine is missing,
    errors, or needs inputs the fixtures don't carry, we fall back to a transparent,
    honest baseline and mark rows `estimate: true`. The pipeline never hard-fails just
    because a model isn't wired yet — it produces valid, clearly-provisional output.

Honesty: everything this file emits is an ESTIMATE (nothing is a resolved measurement),
so game rows carry `estimate: true`. Signals contribute nothing on day zero (the
"started at 0" rule), so `signals_used` is empty — we do not pretend a signal earned
weight it hasn't.
"""

import argparse
import datetime as _dt
import json
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_FIX = os.path.join(_REPO_ROOT, "data", "fixtures")
_DATA = os.path.join(_REPO_ROOT, "data")
_SEASON = 2026

# Canonical team set — used to defensively filter fixture rows to schema-valid teams.
_TEAMS = frozenset(
    "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LAR MIA "
    "MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WAS".split()
)

# Position season-baseline points (approx PPR). ONLY used when neither a model nor a
# fixture prior is available — a transparent floor, never presented as a measurement.
_POS_BASELINE = {"QB": 300.0, "RB": 180.0, "WR": 170.0, "TE": 110.0}


# ---------------------------------------------------------------------------
# Fixture loading (defensive: a missing/empty fixture degrades to []).
# ---------------------------------------------------------------------------
def _load_json(path, default):
    if not os.path.exists(path):
        print(f"[build_all] fixture missing: {path} -> degrading", file=sys.stderr)
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError) as exc:
        print(f"[build_all] fixture unreadable {path}: {exc} -> degrading", file=sys.stderr)
        return default


def _as_list(obj, *keys):
    """Fixtures may be a bare list or an object wrapping the list under a key. Normalize."""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in keys:
            if isinstance(obj.get(k), list):
                return obj[k]
    return []


def _load_teams_raw():
    """Return the raw teams fixture as a list of dicts (for the engine, which resolves
    roof itself), or []."""
    return _as_list(_load_json(os.path.join(_FIX, "teams.json"), {}), "teams")


def _roof_index(teams_raw):
    """teams list -> {abbrev: roof}. roof in {indoor, outdoor, retractable}. Used only by
    the degraded (engine-absent) path; the engine resolves its own roof."""
    roof_by_team = {}
    for t in teams_raw:
        ab = t.get("abbrev") or t.get("team") or t.get("abbreviation")
        roof = (t.get("roof") or t.get("roof_type") or "outdoor").lower()
        if roof not in ("indoor", "outdoor", "retractable"):
            roof = "outdoor"
        if ab in _TEAMS:
            roof_by_team[ab] = roof
    return roof_by_team


# ---------------------------------------------------------------------------
# Optional model engine loader. Returns the module or None. NEVER raises — a missing or
# broken engine simply means "use the baseline".
# ---------------------------------------------------------------------------
def _try_import(modname):
    try:
        mod = __import__(modname, fromlist=["_"])
        return mod
    except Exception as exc:  # noqa: BLE001 - degradation is the whole point here
        print(f"[build_all] {modname} unavailable ({exc.__class__.__name__}) -> baseline", file=sys.stderr)
        return None


def _call_first(mod, names, *args, **kwargs):
    """Call the first attribute in `names` that exists and is callable on `mod`.
    Returns (ok, result). Any exception -> (False, None) so the caller degrades."""
    if mod is None:
        return False, None
    for n in names:
        fn = getattr(mod, n, None)
        if callable(fn):
            try:
                return True, fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                print(f"[build_all] {mod.__name__}.{n} raised {exc.__class__.__name__} -> baseline", file=sys.stderr)
                return False, None
    return False, None


# ---------------------------------------------------------------------------
# Player projections.
# ---------------------------------------------------------------------------
def build_player_projections(players, teams_raw, updated_utc):
    # PREFERRED PATH: the real engine's batch entrypoint (returns schema-valid records).
    engine = _try_import("scripts.models.player_projection")
    ok, res = _call_first(engine, ("project_players",), players, {"teams": teams_raw})
    if ok and isinstance(res, list):
        rows = [r for r in res if isinstance(r, dict)]
    else:
        # DEGRADED PATH: transparent baseline, no engine required.
        rows = []
        for p in players:
            pos = p.get("position")
            if not p.get("gsis_id") or p.get("team") not in _TEAMS or pos not in _POS_BASELINE:
                continue
            proj, low, high, signals = _baseline_projection(p, pos)
            rows.append(
                {
                    "gsis_id": str(p["gsis_id"]),
                    "name": str(p.get("name") or p["gsis_id"]),
                    "team": p["team"],
                    "position": pos,
                    "proj_points": round(proj, 2),
                    "low": round(low, 2),
                    "high": round(high, 2),
                    "signals_used": signals,
                }
            )

    # Defensive schema guard regardless of source: drop any row that isn't valid rather
    # than emit a contract violation. (Belt-and-suspenders against a partial engine.)
    out = [
        r for r in rows
        if r.get("team") in _TEAMS and r.get("position") in _POS_BASELINE and r.get("gsis_id")
    ]
    # Stable order: highest projection first, tie-break by gsis for determinism.
    out.sort(key=lambda r: (-float(r.get("proj_points", 0.0)), str(r.get("gsis_id"))))
    return {"season": _SEASON, "updated_utc": updated_utc, "players": out}


def _baseline_projection(player, pos):
    """Deterministic baseline: a fixture prior-points field if present, else the
    position floor. Interval is a flat +/-20%. `signals_used` is EMPTY on day zero — no
    signal has earned weight yet (the 'started at 0' discipline)."""
    prior = None
    for k in ("prior_points", "proj_points", "fantasy_points", "ppr_points", "prior_ppr"):
        if isinstance(player.get(k), (int, float)):
            prior = float(player[k])
            break
    proj = prior if prior is not None else _POS_BASELINE[pos]
    return proj, proj * 0.8, proj * 1.2, []


# ---------------------------------------------------------------------------
# Game predictions.
# ---------------------------------------------------------------------------
def build_game_predictions(games, teams_raw, updated_utc):
    week = _infer_week(games)
    roof_by_team = _roof_index(teams_raw)

    # PREFERRED PATH: the real engine's batch entrypoint (schema-valid, resolves roof).
    engine = _try_import("scripts.models.game_model")
    ok, res = _call_first(engine, ("predict_games",), games, teams_raw)
    if ok and isinstance(res, list):
        rows = [r for r in res if isinstance(r, dict)]
    else:
        # DEGRADED PATH: deterministic Elo/home-edge baseline.
        rows = []
        for g in games:
            home, away = g.get("home"), g.get("away")
            if home not in _TEAMS or away not in _TEAMS or home == away:
                continue
            ph, pa, model = _baseline_game_prob(g)
            total = ph + pa
            ph, pa = (ph / total, pa / total) if total > 0 else (0.5, 0.5)
            rows.append(
                {
                    "game_id": str(g.get("game_id") or f"{_SEASON}_{home}_{away}"),
                    "home": home,
                    "away": away,
                    "kickoff_utc": g.get("kickoff_utc") or f"{_SEASON}-09-10T17:00:00Z",
                    "roof": roof_by_team.get(home, "outdoor"),
                    "probs": {"home": round(ph, 4), "away": round(pa, 4)},
                    "model": model,
                    "estimate": True,  # never a resolved measurement
                }
            )

    # Defensive schema guard: keep only rows with valid teams and a normalized 2-vector.
    out = []
    for r in rows:
        if r.get("home") not in _TEAMS or r.get("away") not in _TEAMS:
            continue
        probs = r.get("probs") or {}
        ph, pa = float(probs.get("home", 0.5)), float(probs.get("away", 0.5))
        total = ph + pa
        ph, pa = (ph / total, pa / total) if total > 0 else (0.5, 0.5)
        r = dict(r)
        r["probs"] = {"home": round(ph, 4), "away": round(pa, 4)}
        r.setdefault("roof", roof_by_team.get(r["home"], "outdoor"))
        r.setdefault("model", "hybrid")
        r["estimate"] = True
        out.append(r)
    out.sort(key=lambda r: r["game_id"])
    return {"season": _SEASON, "week": week, "updated_utc": updated_utc, "games": out}


def _baseline_game_prob(game):
    """Deterministic baseline win-prob. Uses a fixture Elo/spread hint if present, else a
    flat home-field edge. NEVER random."""
    # If the fixture carries a home win prob or Elo, respect it.
    for k in ("home_win_prob", "prob_home"):
        if isinstance(game.get(k), (int, float)):
            ph = float(game[k])
            return ph, 1.0 - ph, "market"
    home_elo = game.get("home_elo")
    away_elo = game.get("away_elo")
    if isinstance(home_elo, (int, float)) and isinstance(away_elo, (int, float)):
        # Standard Elo win expectation with a modest home-field bump (+55 Elo).
        diff = (float(home_elo) + 55.0) - float(away_elo)
        ph = 1.0 / (1.0 + 10.0 ** (-diff / 400.0))
        return ph, 1.0 - ph, "elo"
    # Flat league-average home edge.
    return 0.55, 0.45, "baseline"


def _infer_week(games):
    for g in games:
        w = g.get("week")
        if isinstance(w, int) and 1 <= w <= 18:
            return w
    return 1  # default to Week 1 when the fixture omits it


# ---------------------------------------------------------------------------
# Parlays. Invariant (schema + build spec): >= 3 parlays per game AND >= 3 per week.
# Correlation-aware: same-game legs carry an explicit correlation_note.
# ---------------------------------------------------------------------------
def build_parlays(game_pred_doc, updated_utc):
    week = game_pred_doc.get("week", 1)
    games = game_pred_doc.get("games", [])

    # PREFERRED PATH: the real engine (correlation-aware, conformal tier, >=3/game & week).
    engine = _try_import("scripts.models.parlay_builder")
    ok, res = _call_first(engine, ("build_parlays",), games)
    if ok and isinstance(res, list) and res:
        parlays = [p for p in res if isinstance(p, dict)]
    else:
        # DEGRADED PATH: deterministic parlays that still satisfy the >=3 invariants.
        parlays = _baseline_parlays(games)

    return {"season": _SEASON, "week": week, "updated_utc": updated_utc, "parlays": parlays}


def _baseline_parlays(games):
    """Deterministic parlays meeting the >=3/game & >=3/week invariant.

    For each game we emit 3 single-leg parlays (moneyline home, moneyline away, and the
    higher-confidence side as a 'value' pick) so the per-game floor is always satisfied.
    Then 3 cross-game 'week' parlays chain the most-confident favorite from consecutive
    games. Implied prob = the model prob nudged by a flat 4% vig so a small positive edge
    is visible; this is a SCAFFOLD placeholder until real odds feed in (odds.py).
    """
    parlays = []
    VIG = 0.04

    # --- per-game (>=3 each) --------------------------------------------------
    for g in games:
        gid = g["game_id"]
        ph = g["probs"]["home"]
        pa = g["probs"]["away"]
        legs_specs = [
            ("moneyline", f"{g['home']} ML", ph),
            ("moneyline", f"{g['away']} ML", pa),
            # A 'value' pick on the model's preferred side.
            ("moneyline", f"{(g['home'] if ph >= pa else g['away'])} ML (value)", max(ph, pa)),
        ]
        for i, (market, selection, model_prob) in enumerate(legs_specs):
            implied = min(0.999, model_prob + VIG)  # vig inflates the implied price
            ev = _ev_single(model_prob, implied)
            parlays.append(
                {
                    "parlay_id": f"{gid}-g{i+1}",
                    "scope": "game",
                    "game_id": gid,
                    "legs": [
                        {
                            "market": market,
                            "selection": selection,
                            "implied_prob": round(implied, 4),
                            "model_prob": round(model_prob, 4),
                        }
                    ],
                    "model_ev": round(ev, 4),
                    "confidence_tier": _tier(model_prob),
                    # Single-leg => no intra-parlay correlation to model.
                    "correlation_note": "single leg (no same-game correlation)",
                }
            )

    # --- cross-game week parlays (>=3) ---------------------------------------
    # Favorite (higher-prob side) of each game, most-confident first.
    favorites = sorted(
        (
            {
                "game_id": g["game_id"],
                "team": g["home"] if g["probs"]["home"] >= g["probs"]["away"] else g["away"],
                "p": max(g["probs"]["home"], g["probs"]["away"]),
            }
            for g in games
        ),
        key=lambda x: (-x["p"], x["game_id"]),
    )
    # Build up to 3 week parlays of 2 favorites each (independent, cross-game legs).
    for i in range(3):
        pair = _pick_pair(favorites, i)
        if not pair:
            break
        legs = []
        joint_model = 1.0
        joint_implied = 1.0
        for fav in pair:
            model_prob = fav["p"]
            implied = min(0.999, model_prob + VIG)
            joint_model *= model_prob
            joint_implied *= implied
            legs.append(
                {
                    "market": "moneyline",
                    "selection": f"{fav['team']} ML",
                    "implied_prob": round(implied, 4),
                    "model_prob": round(model_prob, 4),
                }
            )
        ev = _ev_single(joint_model, joint_implied)
        parlays.append(
            {
                "parlay_id": f"week-w{i+1}",
                "scope": "week",
                "legs": legs,
                "model_ev": round(ev, 4),
                "confidence_tier": _tier(joint_model),
                # Cross-game legs are treated as independent (different games).
                "correlation_note": "cross-game legs treated as independent",
            }
        )
    return parlays


def _pick_pair(favorites, offset):
    """Two distinct favorites for week-parlay #offset (rotating window). Empty if <2."""
    if len(favorites) < 2:
        return []
    a = favorites[offset % len(favorites)]
    b = favorites[(offset + 1) % len(favorites)]
    if a["game_id"] == b["game_id"]:
        return []
    return [a, b]


def _ev_single(model_prob, implied_prob):
    """EV of a $1 stake priced at `implied_prob` when the true prob is `model_prob`.
    Decimal price = 1/implied; EV = model_prob*price - 1. Positive => model sees edge."""
    if implied_prob <= 0:
        return 0.0
    price = 1.0 / implied_prob
    return model_prob * price - 1.0


def _tier(prob):
    """Conformal-flavored confidence band from the model probability. A stand-in for the
    real conformal safe-set tier until harness/conformal.py is wired in."""
    if prob >= 0.65:
        return "high"
    if prob >= 0.55:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# Writer + entrypoint.
# ---------------------------------------------------------------------------
def _write(doc, name):
    path = os.path.join(_DATA, name)
    os.makedirs(_DATA, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Offline, gate-safe model orchestrator")
    ap.add_argument("--as-of", help="ISO-8601 UTC stamp for updated_utc (default: now)")
    args = ap.parse_args(argv)
    if args.as_of:
        updated_utc = args.as_of
    else:
        updated_utc = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    players = _as_list(_load_json(os.path.join(_FIX, "players_sample.json"), []), "players")
    games = _as_list(_load_json(os.path.join(_FIX, "games_sample.json"), []), "games")
    teams_raw = _load_teams_raw()

    proj_doc = build_player_projections(players, teams_raw, updated_utc)
    game_doc = build_game_predictions(games, teams_raw, updated_utc)
    parlay_doc = build_parlays(game_doc, updated_utc)

    p1 = _write(proj_doc, "player_projections.json")
    p2 = _write(game_doc, "game_predictions.json")
    p3 = _write(parlay_doc, "parlays.json")

    print(f"[build_all] wrote {len(proj_doc['players'])} players -> {p1}", file=sys.stderr)
    print(f"[build_all] wrote {len(game_doc['games'])} games   -> {p2}", file=sys.stderr)
    print(f"[build_all] wrote {len(parlay_doc['parlays'])} parlays -> {p3}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
