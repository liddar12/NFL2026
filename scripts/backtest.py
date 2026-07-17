"""Walk-forward backtest of the Elo game model on REAL final seasons — gated.

The learning loop's historical half. scripts/refit.py learns from resolved 2026
locks (none exist before kickoff); this module learns from what DOES exist: the
2021-2025 FINAL results. For each eval season 2022..2025:

    priors  = prior season's finals -> elo.rate_season (incumbent defaults, held
              fixed exactly as refit does — the inside-season rating hfa is
              second-order) -> revert_to_mean at the CANDIDATE revert
    walk    = through the eval season in kickoff order, predicting every game
              with expected_home(...) BEFORE updating ratings with its result —
              leak-free by construction (a game's own result can never touch
              its own prediction), collecting log-loss + Brier per game.

Grid: hfa_elo x revert x k (see the grids below). The candidate is the grid
point with the best MEAN log-loss across the four eval seasons. Adoption is
NEVER-REGRESS gated against the incumbent (model_tuning.json "game_params" if
adopted earlier, else the scripts/models/elo.py defaults) with the same 0.0015
margin discipline as scripts/refit.py — its helpers (MARGIN, tuning-file I/O,
append_history, live_game_params) are imported, never re-implemented.

EVERY trial and the decision are appended to data/model_tuning.json "history"
with source "backtest_2022_2025" — additive, exactly like refit: the top-level
NEVER-REGRESS example entry is locked by never_regress.test.mjs + smoke.sh and
is never modified. Only an adoption that clears the margin writes "game_params"
(hfa_elo + revert are what scripts/build_predictions.py consumes; k is recorded
for the record but production's in-season chaining keeps elo.K until it, too,
is plumbed through).

Pure core vs I/O: grade_season() (and should_adopt via decide_adoption) take
plain rows so tests/feature/backtest.test.mjs drives them synthetically through
`python3 -`. Network lives ONLY in fetch_finals(), which caches each season to
data/fixtures/finals_{yr}.json so a re-run is offline and byte-stable. Loud on
zero rows everywhere (the silent-404 lesson): an empty season aborts the run.

Run: python -m scripts.backtest   (requests required — pipeline runner only).
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.harness import metrics  # noqa: E402
from scripts.models import elo as elo_mod  # noqa: E402
from scripts.optimize.never_regress import should_adopt  # noqa: E402
from scripts.refit import (  # noqa: E402
    MARGIN, _load_tuning, _utc_now, _write_tuning, append_history,
    live_game_params,
)

FIXTURES = os.path.join(_ROOT, "data", "fixtures")

SOURCE = "backtest_2022_2025"
EVAL_SEASONS = (2022, 2023, 2024, 2025)  # each needs the season before it rated

# Fixed ascending grids -> deterministic sweep; ties keep the FIRST (lowest)
# point, mirroring refit's strict-< discipline.
HFA_GRID = (45.0, 55.0, 65.0, 75.0, 85.0)
REVERT_GRID = (0.20, 0.33, 0.45)
K_GRID = (15.0, 20.0, 25.0)


# ---------------------------------------------------------------------------
# Fetch + cache (the ONLY network path in this module).
# ---------------------------------------------------------------------------
def _finals_cache_path(season):
    return os.path.join(FIXTURES, "finals_%d.json" % int(season))


def fetch_finals(season, cache_dir=None):
    """FINAL games for `season`, cached to data/fixtures/finals_{yr}.json.

    First run hits ESPN (STATUS-gated upstream in espn.fetch_final_results);
    every later run reads the cache byte-for-byte — a completed season's finals
    never change, so re-caching would only burn ~18 scoreboard calls. Loud on
    zero rows: an empty completed season is an outage, not history.
    """
    path = (os.path.join(cache_dir, "finals_%d.json" % int(season))
            if cache_dir else _finals_cache_path(season))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        games = doc.get("games") or []
        if not games:
            raise RuntimeError(
                "finals cache %s holds 0 games - delete it and re-fetch "
                "(a hollow cache must never masquerade as a season)" % path)
        return games
    from scripts.scrape import espn  # noqa: PLC0415 (network path only)
    games = espn.fetch_final_results(season)
    if not games:
        raise RuntimeError(
            "ESPN returned 0 FINAL games for completed season %d - outage or "
            "bad query, refusing to cache or score an empty season" % season)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"season": int(season), "fetched_utc": _utc_now(),
                   "games": games}, fh, ensure_ascii=True, indent=2,
                  sort_keys=False)
        fh.write("\n")
    print("backtest: fetched %d FINAL games for %d -> %s"
          % (len(games), season, path))
    return games


# ---------------------------------------------------------------------------
# Pure core.
# ---------------------------------------------------------------------------
def grade_season(games, params, initial_ratings=None):
    """Walk one season forward chronologically; score every decisive game. Pure.

    params: {"hfa_elo": float, "k": float}. Ratings start from
    `initial_ratings` (the reverted prior-season ratings; unknown teams start
    at elo.INIT) and move game-by-game with the standard Elo/MOV update — but
    each game's probability is taken BEFORE its own update, so no game's result
    can leak into its own prediction. Ties still move ratings (toward 0.5) but
    are never scored (a two-way [p, 1-p] vector has no tie outcome).

    Returns {"log_loss", "brier", "n", "p_home"} where p_home is the pre-update
    home probability per scored game, in walk order (the leak-freedom test
    asserts on it directly). Raises on zero scoreable games — a hollow perfect
    score is the one thing this must never emit.
    """
    hfa = float(params["hfa_elo"])
    k = float(params.get("k", elo_mod.K))
    ratings = dict(initial_ratings) if initial_ratings else {}
    ordered = sorted(games, key=lambda g: g.get("kickoff_utc") or "")

    pairs = []
    brier_total = 0.0
    p_home = []
    for g in ordered:
        hs, as_ = g.get("home_score"), g.get("away_score")
        if hs is None or as_ is None:
            continue  # defensive: never let a non-scored row in
        rh = ratings.setdefault(g["home"], elo_mod.INIT)
        ra = ratings.setdefault(g["away"], elo_mod.INIT)
        # Predict FIRST (leak-free): this game's result is not in `ratings` yet.
        exp_h = elo_mod.expected_home(rh, ra, hfa)
        if hs != as_:
            idx = 0 if hs > as_ else 1
            pairs.append((idx, [exp_h, 1.0 - exp_h]))
            brier_total += metrics.brier(idx, [exp_h, 1.0 - exp_h])
            p_home.append(exp_h)
        # THEN update, mirroring elo.rate_season's arithmetic exactly.
        if hs > as_:
            actual_h, winner_margin, elo_diff_w = 1.0, hs - as_, (rh + hfa) - ra
        elif hs < as_:
            actual_h, winner_margin, elo_diff_w = 0.0, as_ - hs, ra - (rh + hfa)
        else:
            actual_h, winner_margin, elo_diff_w = 0.5, 1, 0.0
        mult = elo_mod._mov_multiplier(winner_margin, elo_diff_w)
        delta = k * mult * (actual_h - exp_h)
        ratings[g["home"]] = rh + delta
        ratings[g["away"]] = ra - delta

    if not pairs:
        raise ValueError(
            "grade_season: zero scoreable FINAL games - refusing to report a "
            "hollow score on no data")
    return {
        "log_loss": metrics.multiclass_log_loss(pairs),
        "brier": brier_total / len(pairs),
        "n": len(pairs),
        "p_home": p_home,
    }


def score_candidate(finals_by_season, raw_by_season, params,
                    eval_seasons=EVAL_SEASONS):
    """Mean log-loss/Brier of one {hfa_elo, revert, k} across the eval seasons.

    raw_by_season holds the UNREVERTED prior-season ratings (rated once at the
    incumbent defaults, exactly refit's held-fixed convention); the candidate's
    `revert` produces each eval season's starting priors from them.
    """
    per_season = {}
    for yr in eval_seasons:
        priors = elo_mod.revert_to_mean(raw_by_season[yr - 1],
                                        revert=float(params["revert"]))
        res = grade_season(finals_by_season[yr], params,
                           initial_ratings=priors)
        per_season[str(yr)] = {"log_loss": round(res["log_loss"], 6),
                               "brier": round(res["brier"], 6),
                               "n": res["n"]}
    n_seasons = len(per_season)
    return {
        "log_loss": round(sum(s["log_loss"] for s in per_season.values())
                          / n_seasons, 6),
        "brier": round(sum(s["brier"] for s in per_season.values())
                       / n_seasons, 6),
        "n": sum(s["n"] for s in per_season.values()),
        "per_season": per_season,
    }


def decide_adoption(current_loss, candidate_loss, margin=MARGIN):
    """The one adoption rule — should_adopt, nothing else (mirrorable in tests)."""
    return should_adopt(current_loss, candidate_loss, margin=margin)


def run_grid(finals_by_season, raw_by_season, eval_seasons=EVAL_SEASONS):
    """Every grid trial, in fixed ascending order, plus the best-by-log-loss.

    Returns (trials, best) where each trial is {"hfa_elo", "revert", "k",
    "log_loss", "brier", "n"}. Strict-< keeps the FIRST (lowest) grid point on
    a tie — deterministic, like refit.
    """
    trials = []
    best = None
    for hfa in HFA_GRID:
        for revert in REVERT_GRID:
            for k in K_GRID:
                params = {"hfa_elo": hfa, "revert": revert, "k": k}
                score = score_candidate(finals_by_season, raw_by_season,
                                        params, eval_seasons)
                trial = dict(params)
                trial["log_loss"] = score["log_loss"]
                trial["brier"] = score["brier"]
                trial["n"] = score["n"]
                trials.append(trial)
                if best is None or score["log_loss"] < best["log_loss"]:
                    best = trial
    return trials, best


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------
def main():
    now = _utc_now()

    # 2021 is rated only as the prior for 2022; 2022..2025 are walked + scored.
    finals_by_season = {}
    for yr in range(EVAL_SEASONS[0] - 1, EVAL_SEASONS[-1] + 1):
        finals_by_season[yr] = fetch_finals(yr)
        print("backtest: season %d -> %d FINAL games"
              % (yr, len(finals_by_season[yr])))

    # Unreverted end-of-season ratings at the incumbent defaults (held fixed —
    # the grid explores prediction-time hfa/k and the between-season revert).
    raw_by_season = {yr: elo_mod.rate_season(finals_by_season[yr])
                     for yr in range(EVAL_SEASONS[0] - 1, EVAL_SEASONS[-1])}

    doc = _load_tuning()
    current = live_game_params(doc)
    current["k"] = elo_mod.K  # production's in-season chaining runs elo.K
    current_score = score_candidate(finals_by_season, raw_by_season, current)

    trials, best = run_grid(finals_by_season, raw_by_season)
    adopted = decide_adoption(current_score["log_loss"], best["log_loss"])

    candidate = {"hfa_elo": best["hfa_elo"], "revert": best["revert"],
                 "k": best["k"]}
    if adopted:
        reason = ("ADOPTED: walk-forward backtest candidate hfa_elo=%.0f "
                  "revert=%.2f k=%.0f improves mean log-loss over seasons "
                  "%s from %.4f to %.4f (n=%d real FINAL games), clearing the "
                  "%.4f margin. should_adopt == true."
                  % (best["hfa_elo"], best["revert"], best["k"],
                     "-".join(str(y) for y in EVAL_SEASONS),
                     current_score["log_loss"], best["log_loss"], best["n"],
                     MARGIN))
    else:
        reason = ("NEVER REGRESS: best backtest grid candidate hfa_elo=%.0f "
                  "revert=%.2f k=%.0f scores %.4f vs incumbent (hfa_elo=%.0f "
                  "revert=%.2f k=%.0f) at %.4f over %d real FINAL games "
                  "(seasons %s); the %.4f margin is not cleared, so the "
                  "incumbent params are kept unchanged. should_adopt == false."
                  % (best["hfa_elo"], best["revert"], best["k"],
                     best["log_loss"], current["hfa_elo"], current["revert"],
                     current["k"], current_score["log_loss"], best["n"],
                     "-".join(str(y) for y in EVAL_SEASONS), MARGIN))

    entry = {
        "generated_utc": now,
        "kind": "game_params",
        "source": SOURCE,
        "objective": "log_loss",
        "margin": MARGIN,
        "eval_seasons": list(EVAL_SEASONS),
        "n_resolved": best["n"],
        "current": current,
        "candidate": candidate,
        "current_loss": current_score["log_loss"],
        "candidate_loss": best["log_loss"],
        "current_brier": current_score["brier"],
        "candidate_brier": best["brier"],
        "improvement": round(current_score["log_loss"] - best["log_loss"], 6),
        "adopted": adopted,
        "reason": reason,
        "trials": trials,
    }
    append_history(doc, entry)

    if adopted:
        # The same single write-point refit uses: build_predictions consumes
        # hfa_elo + revert; k rides along for the record (see module docstring).
        doc["game_params"] = {
            "hfa_elo": candidate["hfa_elo"],
            "revert": candidate["revert"],
            "k": candidate["k"],
            "adopted_utc": now,
            "source": "scripts/backtest.py walk-forward grid on %s finals "
                      "(never-regress gated)"
                      % "-".join(str(y) for y in EVAL_SEASONS),
        }
        print("backtest: ADOPTED hfa_elo=%s revert=%s k=%s (%.4f -> %.4f, "
              "n=%d)" % (candidate["hfa_elo"], candidate["revert"],
                         candidate["k"], current_score["log_loss"],
                         best["log_loss"], best["n"]))
    else:
        print("backtest: kept incumbent hfa_elo=%s revert=%s k=%s - candidate "
              "%s scored %.4f vs %.4f (margin %.4f, n=%d); outcome archived."
              % (current["hfa_elo"], current["revert"], current["k"],
                 candidate, best["log_loss"], current_score["log_loss"],
                 MARGIN, best["n"]))

    _write_tuning(doc)
    print("backtest: %d trials + decision appended to data/model_tuning.json "
          "(history now %d entries)" % (len(trials), len(doc["history"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
