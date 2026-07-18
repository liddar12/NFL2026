"""PROMOTE weight-0 game-level candidates into the game model — NEVER-REGRESS.

The recorded environment effects (venue-specific home field, cold-weather) have
sat at weight 0 since they were measured. This script gives them their shot at
REAL weight, the only honest way: wire each candidate into the Elo win
probability and walk-forward backtest it on seasons 2022-2025 against the
incumbent (the adopted flat game params). Adoption clears the same 0.0015
log-loss margin the parameter backtest uses; a candidate that cannot beat the
incumbent stays at weight 0, recorded.

LEAK-FREEDOM (the whole ballgame):
  * Every eval season Y prices games with priors from season Y-1 and candidate
    features fitted ONLY on training seasons < Y. A game never sees its own
    season's residuals.
  * Features are RESIDUAL-based: for each training home game, the residual
    r = actual_home - expected_home (flat-HFA model). A team's venue delta is
    its mean home residual, shrunk by n/(n+SHRINK_N), scaled to Elo points by
    a grid-searched factor. The cold delta is the mean residual of cold-region
    open-air home games in Nov-Feb, shared across teams (per-team cold splits
    are too thin — the environment model's low_n flags said so).

ADOPTION OUTPUT (model_tuning.json):
  game_params.venue_hfa = {applied, scale, shrink_n, deltas: {team: elo}} and
  game_params.cold_hfa = {applied, delta_elo} — production deltas recomputed
  from ALL seasons once adopted (training-only fitting is for honest EVAL; the
  shipped prior uses every resolved season, standard walk-forward practice).
  build_predictions applies them per game; every trial is archived in history.

Runs offline from the committed data/fixtures/finals_{yr}.json (no network).
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models import elo as elo_mod  # noqa: E402
from scripts.scrape.stadiums import STADIUMS  # noqa: E402
from scripts.refit import MARGIN  # noqa: E402

DATA = os.path.join(_ROOT, "data")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
SEASONS = [2021, 2022, 2023, 2024, 2025]
EVAL_SEASONS = [2022, 2023, 2024, 2025]

SHRINK_N = 16                      # residual shrinkage: n/(n+SHRINK_N)
VENUE_SCALES = [0.0, 150.0, 250.0, 350.0]   # Elo per unit mean residual (0 = off)
COLD_SCALES = [0.0, 150.0, 250.0, 350.0]
COLD_MONTHS = (11, 12, 1, 2)       # Nov-Feb kickoffs
COLD_HOMES = frozenset(ab for ab, s in STADIUMS.items()
                       if s.get("cold_region") and s.get("roof") == "open")
_EPS = 1e-12


def load_finals(year):
    with open(os.path.join(DATA, "fixtures", f"finals_{year}.json"), encoding="utf-8") as fh:
        games = json.load(fh)["games"]
    games.sort(key=lambda g: g.get("kickoff_utc") or "")
    return games


def is_cold_game(game):
    """Cold-region open-air home venue with a Nov-Feb kickoff."""
    if game["home"] not in COLD_HOMES:
        return False
    try:
        month = int(str(game["kickoff_utc"])[5:7])
    except (TypeError, ValueError):
        return False
    return month in COLD_MONTHS


def game_params():
    """The adopted incumbent params (backtest adoption) — the bar to beat."""
    with open(TUNING_PATH, encoding="utf-8") as fh:
        tuning = json.load(fh)
    gp = tuning.get("game_params") or {}
    return (float(gp.get("hfa_elo", elo_mod.HFA_ELO)),
            float(gp.get("revert", elo_mod.REVERT)),
            float(gp.get("k", elo_mod.K)),
            tuning)


def walk_season(games, priors, hfa, k, venue_delta=None, cold_delta=0.0,
                collect_residuals=False):
    """Predict-then-update one season. Returns (log_loss_sum, n, residuals).

    venue_delta: {home_team: elo_delta} added to hfa for that team's home games.
    cold_delta: elo added to hfa for cold games (see is_cold_game).
    collect_residuals: also return per-game (home, actual - expected, cold_flag)
    under the FLAT model — the training features for later seasons. Ties skipped
    for grading (no binary outcome) but still update ratings.
    """
    ratings = dict(priors)
    ll = 0.0
    n = 0
    residuals = []
    vd = venue_delta or {}
    for g in games:
        h, a = g["home"], g["away"]
        rh = ratings.setdefault(h, elo_mod.INIT)
        ra = ratings.setdefault(a, elo_mod.INIT)
        hfa_eff = hfa + vd.get(h, 0.0) + (cold_delta if cold_delta and is_cold_game(g) else 0.0)
        p = elo_mod.expected_home(rh, ra, hfa_eff)
        hs, as_ = g["home_score"], g["away_score"]
        if hs != as_:
            actual = 1.0 if hs > as_ else 0.0
            p_c = min(max(p, _EPS), 1.0 - _EPS)
            ll += -(actual * __import__("math").log(p_c)
                    + (1.0 - actual) * __import__("math").log(1.0 - p_c))
            n += 1
            if collect_residuals:
                p_flat = elo_mod.expected_home(rh, ra, hfa)
                residuals.append((h, actual - p_flat, is_cold_game(g)))
        # Rating update always uses the FLAT incumbent hfa (the shipped rater) so
        # candidate deltas shift PRICING only, never the rating trajectory —
        # isolates the signal's effect from rating drift.
        exp_h = elo_mod.expected_home(rh, ra, hfa)
        if hs > as_:
            actual_h, margin, dw = 1.0, hs - as_, (rh + hfa) - ra
        elif hs < as_:
            actual_h, margin, dw = 0.0, as_ - hs, ra - (rh + hfa)
        else:
            actual_h, margin, dw = 0.5, 1, 0.0
        mult = elo_mod._mov_multiplier(margin, dw)
        delta = k * mult * (actual_h - exp_h)
        ratings[h] = rh + delta
        ratings[a] = ra - delta
    return ll, n, residuals


def features_from_residuals(residual_rows, venue_scale, cold_scale):
    """(venue_delta map, cold_delta) from accumulated training residuals."""
    per_team = {}
    cold_rs = []
    for team, r, cold in residual_rows:
        per_team.setdefault(team, []).append(r)
        if cold:
            cold_rs.append(r)
    venue_delta = {}
    for team, rs in per_team.items():
        m = sum(rs) / len(rs)
        shrink = len(rs) / (len(rs) + SHRINK_N)
        venue_delta[team] = venue_scale * m * shrink
    cold_delta = 0.0
    if cold_rs and cold_scale:
        shrink = len(cold_rs) / (len(cold_rs) + SHRINK_N)
        cold_delta = cold_scale * (sum(cold_rs) / len(cold_rs)) * shrink
    return venue_delta, cold_delta


def evaluate(venue_scale, cold_scale, hfa, revert, k, finals_by_year):
    """Walk-forward mean log-loss with the candidate scales. Leak-free: season
    Y's features come only from residuals of seasons < Y."""
    total_ll = 0.0
    total_n = 0
    training_residuals = []
    # Seed training residuals + priors from 2021 (rated, never evaluated).
    priors = {}
    for yr in SEASONS:
        games = finals_by_year[yr]
        if yr in EVAL_SEASONS:
            vd, cd = features_from_residuals(training_residuals, venue_scale, cold_scale)
            ll, n, res = walk_season(games, priors, hfa, k, vd, cd,
                                     collect_residuals=True)
            total_ll += ll
            total_n += n
        else:
            _, _, res = walk_season(games, priors, hfa, k, collect_residuals=True)
        training_residuals.extend(res)
        # Next season's priors: rate this season from the running ratings, revert.
        rated = elo_mod.rate_season(games, hfa=hfa, k=k, initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    return total_ll / total_n, total_n


def main():
    hfa, revert, k, tuning = game_params()
    finals_by_year = {yr: load_finals(yr) for yr in SEASONS}

    trials = []
    for vs in VENUE_SCALES:
        for cs in COLD_SCALES:
            ll, n = evaluate(vs, cs, hfa, revert, k, finals_by_year)
            trials.append({"venue_scale": vs, "cold_scale": cs,
                           "log_loss": round(ll, 5), "n": n})
            print(f"  venue_scale={vs:5.0f} cold_scale={cs:5.0f} -> log-loss {ll:.5f}")

    incumbent = next(t for t in trials if t["venue_scale"] == 0 and t["cold_scale"] == 0)
    best = min(trials, key=lambda t: (t["log_loss"], t["venue_scale"], t["cold_scale"]))
    improvement = incumbent["log_loss"] - best["log_loss"]
    adopt = (best is not incumbent) and improvement > MARGIN

    import datetime as dt  # noqa: PLC0415 (single stamp)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "generated_utc": now,
        "kind": "signal_promotion",
        "source": "scripts/promote_signals.py walk-forward 2022-2025 (venue_hfa + cold_hfa)",
        "objective": "log_loss",
        "margin": MARGIN,
        "incumbent_loss": incumbent["log_loss"],
        "candidate": {"venue_scale": best["venue_scale"], "cold_scale": best["cold_scale"]},
        "candidate_loss": best["log_loss"],
        "improvement": round(improvement, 5),
        "adopted": bool(adopt),
        "reason": ("cleared never-regress margin" if adopt else
                   "incumbent retained: no candidate cleared the margin — signals stay at weight 0"),
        "trials": trials,
    }
    tuning.setdefault("history", []).insert(0, entry)

    if adopt:
        # Production deltas from ALL residuals (every resolved season) at the
        # winning scales — the shipped prior for 2026.
        all_res = []
        priors = {}
        for yr in SEASONS:
            _, _, res = walk_season(finals_by_year[yr], priors, hfa, k,
                                    collect_residuals=True)
            all_res.extend(res)
            rated = elo_mod.rate_season(finals_by_year[yr], hfa=hfa, k=k,
                                        initial_ratings=priors)
            priors = elo_mod.revert_to_mean(rated, revert=revert)
        vd, cd = features_from_residuals(all_res, best["venue_scale"], best["cold_scale"])
        gp = tuning.setdefault("game_params", {})
        gp["venue_hfa"] = {
            "applied": True, "scale": best["venue_scale"], "shrink_n": SHRINK_N,
            "adopted_utc": now,
            "deltas": {t: round(v, 2) for t, v in sorted(vd.items())},
        }
        gp["cold_hfa"] = {"applied": bool(best["cold_scale"]),
                          "delta_elo": round(cd, 2), "adopted_utc": now}
        print(f"ADOPTED venue_scale={best['venue_scale']} cold_scale={best['cold_scale']} "
              f"({incumbent['log_loss']:.5f} -> {best['log_loss']:.5f}); "
              f"deltas span [{min(vd.values()):.1f}, {max(vd.values()):.1f}] Elo, cold {cd:+.1f}")
    else:
        print(f"RETAINED incumbent ({incumbent['log_loss']:.5f}); best candidate "
              f"{best['log_loss']:.5f} (improvement {improvement:+.5f} <= margin {MARGIN})")

    with open(TUNING_PATH, "w", encoding="utf-8") as fh:
        json.dump(tuning, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")
    return entry


if __name__ == "__main__":
    main()
