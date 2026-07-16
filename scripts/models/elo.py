"""Elo ratings from prior-season FINAL results — the game model's talent prior.

Standard NFL Elo (FiveThirtyEight-style): a logistic 400-point scale, home-field
advantage in Elo points, and a margin-of-victory multiplier so blowouts move ratings
more than one-score games (with the autocorrelation correction so a favorite winning
big doesn't run away). Between seasons, ratings revert partway to the 1500 mean — last
year's results are a prior for this year, not the truth.

Pure + deterministic + stdlib only: takes a chronologically-ordered list of final
games and returns {team: rating}. No network here (the scraper feeds it), so the fast
gate can unit-test the math offline.

INVARIANT: only FINAL games may be passed in. Feeding a live/scheduled 0-0 stub would
poison every downstream rating — the caller (scripts.scrape.espn.fetch_final_results)
is STATUS-gated for exactly this reason.
"""

import math

INIT = 1500.0        # league-average starting rating
K = 20.0             # update speed
HFA_ELO = 65.0       # home-field advantage in Elo points (~2.0-2.5 pts of spread)
REVERT = 0.33        # fraction reverted toward the mean between seasons


def expected_home(elo_home, elo_away, hfa=HFA_ELO):
    """Logistic expected home score in [0,1] given ratings + home-field advantage."""
    return 1.0 / (1.0 + math.pow(10.0, -((elo_home - elo_away + hfa) / 400.0)))


def _mov_multiplier(point_diff, elo_diff_winner):
    """Margin-of-victory multiplier with the favorite-autocorrelation correction.

    point_diff: absolute final margin. elo_diff_winner: (winner_elo - loser_elo) as seen
    pre-game *including* HFA from the winner's perspective. The denominator dampens the
    multiplier when a strong favorite wins, preventing rating runaway.
    """
    return math.log(abs(point_diff) + 1.0) * (2.2 / ((elo_diff_winner * 0.001) + 2.2))


def rate_season(final_games, init=INIT, k=K, hfa=HFA_ELO):
    """Run Elo over one season's FINAL games (in kickoff order). Returns {team: rating}.

    Each game dict needs: home, away, home_score, away_score. Ties (equal scores) update
    toward 0.5. Unknown teams start at `init`.
    """
    ratings = {}
    ordered = sorted(final_games, key=lambda g: g.get("kickoff_utc") or "")
    for g in ordered:
        h, a = g["home"], g["away"]
        hs, as_ = g.get("home_score"), g.get("away_score")
        if hs is None or as_ is None:
            continue  # defensive: never let a non-scored row in
        rh = ratings.setdefault(h, init)
        ra = ratings.setdefault(a, init)
        exp_h = expected_home(rh, ra, hfa)
        if hs > as_:
            actual_h, winner_margin, elo_diff_w = 1.0, hs - as_, (rh + hfa) - ra
        elif hs < as_:
            actual_h, winner_margin, elo_diff_w = 0.0, as_ - hs, ra - (rh + hfa)
        else:
            actual_h, winner_margin, elo_diff_w = 0.5, 1, 0.0
        mult = _mov_multiplier(winner_margin, elo_diff_w)
        delta = k * mult * (actual_h - exp_h)
        ratings[h] = rh + delta
        ratings[a] = ra - delta
    return ratings


def revert_to_mean(ratings, revert=REVERT, mean=INIT):
    """Season-to-season carryover: pull each rating `revert` of the way back to `mean`.
    Produces the *prior* for the next season (last year is evidence, not destiny)."""
    return {t: mean + (r - mean) * (1.0 - revert) for t, r in ratings.items()}


def preseason_priors(prior_final_games):
    """End-to-end: rate a completed season and revert to produce next-season priors."""
    return revert_to_mean(rate_season(prior_final_games))
