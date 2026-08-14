"""coach_regime — a head-coach CHANGE priced as REDUCED CONFIDENCE in the rating.

WHAT THIS FAMILY CLAIMS, AND HOW IT DIFFERS FROM `coach_quality`
    `coach_quality` asks "is this coach better than that coach" and answers with
    a level shift by coach identity. This family asks a different question and
    must not be confused with it:

        When a team changes head coach over the offseason, the rating it carries
        into the new season was earned by a team that no longer exists.

    The claim is therefore about the RELIABILITY of an input, not about the
    merit of the new coach. The family says nothing whatsoever about whether new
    coaches are good or bad -- it is deliberately incapable of saying it. A
    first-year regime is priced by pulling that team's rating FURTHER toward the
    1500 mean than the incumbent already does, in whichever direction the rating
    happens to point:

        R'(T) = MEAN + (1 - phi_T) * (R(T) - MEAN)

    A strong team with a new coach is priced DOWN; a weak team with a new coach
    is priced UP by exactly the same rule. `phi` is a shrink FRACTION, not an
    Elo amount, and a team sitting on 1500 is untouched no matter who coaches it.
    That antisymmetry is what makes this "less information", not "new coaches are
    worse", and it is asserted numerically in `selftest()`.

    Expressed as the additive home-side Elo delta the gate's family contract
    wants (`walk_season` adds it to hfa, so it must be the change in the RATING
    DIFFERENCE, not in one rating):

        delta = (R'_home - R_home) - (R'_away - R_away)
              = -phi_home * (R_home - MEAN) + phi_away * (R_away - MEAN)

WHY IT NEEDS THE RATING, AND WHY THAT IS NOT A LEAK
    Unlike every other family here, the delta is a function of the pre-game
    ratings themselves, which `walk_season` never passes to `delta_fn`. This
    module therefore reproduces the rating trajectory, exactly as
    `coach_quality.residual_stream` already does and for the same reason: the
    trajectory is a pure function of (finals, hfa, k, revert) because candidate
    deltas shift PRICING only and never the rating update (promote_signals'
    stated invariant). The reproduction is asserted byte-identical to
    `walk_season`'s own residuals in `selftest()`, and that assertion is the only
    thing keeping the two copies honest.

    The ratings used for a game are the PRE-game ratings of that same game --
    the identical quantity the incumbent prices with. Nothing from the game's own
    outcome, or from any later game, can reach the delta.

THE SECOND INPUT: HAS THIS TEAM CHANGED HEAD COACH?
    Taken from `data/game_context.json` (`home_coach` / `away_coach`, 100%
    populated over all 27 corpus seasons). A team T is in a FIRST-YEAR REGIME in
    season N when the coach of its first game of season N differs from the coach
    of its last game of season N-1. Both facts are settled before season N kicks
    off, and the comparison is made only against seasons the walk has already
    passed, so there is no path from season N's results into season N's flag.

    Deliberately NOT "first season with this team ever": a coach returning to a
    team after years away IS a regime change by this family's mechanism, and an
    ever-seen test would miss him.

    A team with no season N-1 inside the walk (the first walk season; Houston in
    2002) is UNKNOWN, not unflagged-because-continuous. It scores exactly 0.0 --
    the family is silent rather than guessing.

MID-SEASON COACH CHANGES ARE EXCLUDED. WHY, EXPLICITLY.
    43 of them occur over 1999-2025 (counted, not assumed -- see
    `diagnostics()["midseason_changes"]`). They are excluded from the family,
    and this is a decision, not an oversight:

    1. The mechanism does not apply. The claim is about a rating CARRIED ACROSS
       an offseason, when no games are played and the roster and staff turn over.
       Mid-season the rating is being updated week by week from games the new
       coach's own team actually played; there is no stale carry-over to
       discount.
    2. The selection is confounded in a direction this family cannot separate.
       A coach is fired mid-season *because* the team has been underrunning its
       rating, so those games carry a large negative residual by construction.
       "Reduced confidence" and "the reason he was fired" would be fit as one
       quantity, and the family would take credit for the second while claiming
       the first.
    3. The retained-interim case is handled conservatively by the same rule. If
       an interim finishes season N-1 and is kept for season N, the season-N
       comparison sees the same name and does NOT flag the team -- the rating it
       carries was in fact partly earned under him. Fewer flags means the family
       is silent more often, which is the correct direction for a rule that is
       not certain.

    The exclusion is a data statement, so it is measured and published in the
    diagnostics rather than left as prose.

WITHIN-SEASON DECAY (the `decay_n0` axis)
    Confidence in the carried rating should recover as the new regime plays
    games, because after week 8 the rating is no longer mostly the old team's.
    `decay_n0` is the prior-strength of that recovery:

        phi_effective = phi * n0 / (n0 + games_played_this_season_before_this_one)

    `decay_n0 = None` is the honest null on that axis -- the discount holds flat
    for the whole first season -- and it is kept in the grid so the decay is
    earned rather than assumed.

WHY THE GRID IS ONE-SIDED
    `divisional` and `weather_wind` carry signed grids because their direction is
    genuinely unknown. This one is not: less information about a team's true
    strength can only argue for pricing it CLOSER to average. A negative phi
    would mean a regime change makes the old rating MORE informative, which is
    not a weaker version of this hypothesis but a different and incoherent one.
    Three shrink levels x two decay settings = 6 trials, and every trial the run
    evaluates is paid for by every other family through the Bonferroni
    correction, so the grid is kept deliberately small.

THE HONEST CAVEAT, RECORDED BEFORE THE MEASUREMENT
    The incumbent ALREADY reverts every team 45% of the way to 1500 between
    seasons. Whatever staleness a coaching change adds is on top of a discount
    that is already large, and the marginal quantity may well be zero. Roughly
    6.6 teams per season change coach, ~20% of team-games, and the extra shrink
    only bites for teams whose rating is far from 1500. The construction can be
    right and the answer still nothing. That is a finding, and the gate decides.

Stdlib only. Deterministic. Reads data/game_context.json and never a market
column (that artifact carries none; validate_data.py enforces it).
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models import elo as elo_mod  # noqa: E402

DATA = os.path.join(_ROOT, "data")
CONTEXT_PATH = os.path.join(DATA, "game_context.json")

# The rating the extra reversion pulls toward. Not a free parameter: it is the
# same mean elo.revert_to_mean already uses between seasons, so this family is
# literally "revert that team a bit further" and nothing else.
MEAN = elo_mod.INIT

# EXTRA reversion fraction applied to a first-year-regime team's rating, on top
# of the incumbent's between-season revert. One-sided by construction (see the
# module docstring). 0.0 is excluded: it IS the incumbent.
REGIME_SHRINK = [0.15, 0.30, 0.50]

# Games-into-the-season at which the discount has halved. None = no decay, the
# discount holds flat across the first season. Kept small: 3 x 2 = 6 trials.
REGIME_DECAY_N0 = [None, 4.0]

# A season is only counted as covered when essentially every decided game
# resolves to a context record. A silent join miss degrades the family to
# neutral on those games -- exact ties that dilute the measured improvement
# toward zero without anything going red -- so partial coverage is refused
# loudly instead. Same constant and same reasoning as coach_quality.
MIN_JOIN_RATE = 0.99


# --------------------------------------------------------------------------- #
# game_context.json access                                                     #
# --------------------------------------------------------------------------- #

def load_context(path=CONTEXT_PATH):
    """The `games` map of data/game_context.json, or None when absent.

    None means SKIP, never fake. The artifact is runner-built (its source is a
    network fetch), so its absence is documented state and not a failure.
    """
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    return (doc.get("games") or None)


def context_key(season, game):
    """The flat join key published by game_context.json: season|week|home|away."""
    return f"{season}|{game.get('week')}|{game['home']}|{game['away']}"


def coach_pair(ctx, season, game):
    """(home_coach, away_coach), or (None, None) when unjoinable.

    Never raises and never invents a name: a missing record, a missing field or
    an empty string all collapse to None, which every caller treats as "this
    family has nothing to say about this game".
    """
    rec = ctx.get(context_key(season, game)) if ctx else None
    if not rec:
        return (None, None)
    return (rec.get("home_coach") or None, rec.get("away_coach") or None)


# --------------------------------------------------------------------------- #
# regime detection                                                             #
# --------------------------------------------------------------------------- #

def coach_spells(finals_by_year, seasons, ctx):
    """Per team-season coach bookends plus the mid-season changes.

    Returns (first_coach, last_coach, midseason) where the first two are
    {(season, team): coach} taken from that team's FIRST and LAST joined game of
    the season in walk order, and `midseason` is
    {season: [(team, week, from_coach, to_coach), ...]} for every within-season
    change -- recorded so the exclusion documented in the module docstring is a
    measurement rather than an assumption.

    Games whose context row is missing contribute nothing, in either direction.
    """
    first_coach, last_coach = {}, {}
    midseason = {}
    for season in seasons:
        prev = {}
        for g in finals_by_year[season]:
            home, away = coach_pair(ctx, season, g)
            for team, coach in ((g["home"], home), (g["away"], away)):
                if not coach:
                    continue
                kk = (season, team)
                if kk not in first_coach:
                    first_coach[kk] = coach
                elif prev[team] != coach:
                    midseason.setdefault(season, []).append(
                        (team, g.get("week"), prev[team], coach))
                prev[team] = coach
                last_coach[kk] = coach
    return first_coach, last_coach, midseason


def first_year_regimes(finals_by_year, seasons, ctx):
    """({(season, team) with a NEW head coach}, diagnostics dict).

    A team is flagged for season N when the coach of its first game of N differs
    from the coach of its last game of N-1, and N-1 is inside the walk. No prior
    season inside the walk means UNKNOWN, which is never a flag.
    """
    first_coach, last_coach, midseason = coach_spells(finals_by_year, seasons,
                                                      ctx)
    flags = set()
    by_season = {}
    for season in seasons:
        teams = sorted({t for (s, t) in first_coach if s == season})
        flagged, unknown = [], []
        for team in teams:
            prior = last_coach.get((season - 1, team))
            if prior is None:
                unknown.append(team)
            elif prior != first_coach[(season, team)]:
                flags.add((season, team))
                flagged.append(team)
        by_season[season] = {
            "teams": len(teams),
            "first_year_regimes": len(flagged),
            "flagged": flagged,
            "no_prior_season": unknown,
            "midseason_changes": len(midseason.get(season, ())),
        }
    diag = {
        "rule": ("first game's coach in season N != last game's coach in "
                 "season N-1; no season N-1 inside the walk => unknown, never "
                 "flagged"),
        "midseason_policy": ("mid-season changes are EXCLUDED from the family "
                             "(counted here): the mechanism is a rating carried "
                             "across an offseason, and a mid-season firing is "
                             "confounded with the underperformance that caused "
                             "it"),
        "first_year_regimes": len(flags),
        "midseason_changes": sum(len(v) for v in midseason.values()),
        "by_season": by_season,
    }
    return flags, diag


# --------------------------------------------------------------------------- #
# the rating trajectory (a faithful copy of walk_season's)                     #
# --------------------------------------------------------------------------- #

def rating_stream(finals_by_year, seasons, hfa, k, revert):
    """[(season, game, rating_home, rating_away)] for EVERY game, in walk order.

    The ratings are the PRE-game ones, i.e. exactly what `walk_season` prices
    the game with. Ties are included here (unlike coach_quality's residual
    stream): they carry no residual but they do carry a rating, and the family
    prices them like any other game.

    Rating updates use the FLAT hfa and the MOV multiplier, then
    rate_season + revert_to_mean seeds the next season -- the same trajectory
    `promote_signals.evaluate` walks, and asserted identical in `selftest()`.
    """
    out = []
    priors = {}
    for yr in seasons:
        games = finals_by_year[yr]
        ratings = dict(priors)
        for g in games:
            h, a = g["home"], g["away"]
            rh = ratings.setdefault(h, elo_mod.INIT)
            ra = ratings.setdefault(a, elo_mod.INIT)
            out.append((yr, g, rh, ra))
            hs, as_ = g["home_score"], g["away_score"]
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
        rated = elo_mod.rate_season(games, hfa=hfa, k=k, initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    return out


# --------------------------------------------------------------------------- #
# the per-game inputs the grid is evaluated over                               #
# --------------------------------------------------------------------------- #

def confidence_weight(games_played, decay_n0):
    """How much of the discount still applies after `games_played` this season.

    1.0 flat when `decay_n0` is None. Otherwise n0 / (n0 + g): full discount on
    the regime's first game of the season, half of it after n0 games.
    """
    if decay_n0 is None:
        return 1.0
    n0 = float(decay_n0)
    return n0 / (n0 + float(games_played))


class RegimeFit:
    """Frozen per-game inputs: {join_key: (dev_home, g_home, dev_away, g_away)}.

    `dev_*` is (pre-game rating - MEAN) for a team in a first-year regime and
    EXACTLY 0.0 otherwise, so an unflagged team contributes nothing at any
    shrink. `g_*` is how many games that team has already played this season.
    Keying by the published join key rather than by list index means a caller
    that hands over a differently-ordered slate degrades to 0.0 instead of
    silently pricing the wrong game.
    """

    __slots__ = ("rows", "diagnostics", "coverage", "seasons")

    def __init__(self, rows, diagnostics=None, coverage=None, seasons=None):
        self.rows = rows
        self.diagnostics = diagnostics or {}
        self.coverage = coverage or {}
        self.seasons = list(seasons or ())

    def delta(self, season, game, shrink, decay_n0):
        """Elo added to the HOME price for this game."""
        row = self.rows.get(context_key(season, game))
        if not row:
            return 0.0
        dev_h, g_h, dev_a, g_a = row
        return shrink * (
            -dev_h * confidence_weight(g_h, decay_n0)
            + dev_a * confidence_weight(g_a, decay_n0))

    def flagged_rows(self):
        return sum(1 for r in self.rows.values() if r[0] or r[2])


def build_rows(finals_by_year, seasons, hfa, k, revert, ctx):
    """{join_key: (dev_home, g_home, dev_away, g_away)} over the whole walk."""
    flags, diag = first_year_regimes(finals_by_year, seasons, ctx)
    rows = {}
    played = {}
    for season, game, rh, ra in rating_stream(finals_by_year, seasons, hfa, k,
                                              revert):
        h, a = game["home"], game["away"]
        g_h = played.get((season, h), 0)
        g_a = played.get((season, a), 0)
        rows[context_key(season, game)] = (
            (rh - MEAN) if (season, h) in flags else 0.0, g_h,
            (ra - MEAN) if (season, a) in flags else 0.0, g_a)
        played[(season, h)] = g_h + 1
        played[(season, a)] = g_a + 1
    return rows, diag


def join_coverage(finals_by_year, seasons, ctx):
    """{season: (joined_games, total_games)} over DECIDED games."""
    cov = {}
    for yr in seasons:
        joined = total = 0
        for g in finals_by_year[yr]:
            if g["home_score"] == g["away_score"]:
                continue
            total += 1
            home, away = coach_pair(ctx, yr, g)
            if home and away:
                joined += 1
        cov[yr] = (joined, total)
    return cov


# --------------------------------------------------------------------------- #
# the promote_signals family contract                                          #
# --------------------------------------------------------------------------- #

def inputs(finals_by_year, seasons, hfa, k, revert, ctx=None,
           context_path=CONTEXT_PATH):
    """A RegimeFit ready for `builder`, or None -- SKIP, never fake.

    None when game_context.json is absent, or when any season in the walk falls
    below MIN_JOIN_RATE. Partial coverage is refused rather than silently
    scoring exact ties on the uncovered folds.
    """
    if ctx is None:
        ctx = load_context(context_path)
    if not ctx:
        return None
    coverage = join_coverage(finals_by_year, seasons, ctx)
    for _yr, (joined, total) in coverage.items():
        if not total or (joined / float(total)) < MIN_JOIN_RATE:
            return None
    rows, diag = build_rows(finals_by_year, seasons, hfa, k, revert, ctx)
    return RegimeFit(rows, diag, coverage, seasons)


def coverage_reason(finals_by_year, seasons, context_path=CONTEXT_PATH):
    """Human-readable why-skipped string. Used only on the skip path."""
    ctx = load_context(context_path)
    if not ctx:
        return (f"{os.path.relpath(context_path, _ROOT)} absent "
                "(runner-built by scripts/build_game_context.py)")
    cov = join_coverage(finals_by_year, seasons, ctx)
    bad = [f"{yr} {j}/{t}" for yr, (j, t) in sorted(cov.items())
           if not t or (j / float(t)) < MIN_JOIN_RATE]
    return ("head-coach join below "
            f"{MIN_JOIN_RATE:.0%} for: {', '.join(bad)} — uncovered games would "
            "score exact ties and dilute the measured improvement")


def coach_regime_builder(shrink, decay_n0, fit):
    """(setup, factory) in promote_signals' family shape.

    `training_residuals` is unused: the family fits nothing. Its two inputs are
    the pre-game rating (recomputed, not fitted) and a coaching fact settled
    before the season started.
    """
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            return fit.delta(season, g, shrink, decay_n0)
        return fn

    return setup, factory


# `builder` is the name promote_signals uses for coach_quality; both spellings
# are exported so the wiring reads the same either way.
builder = coach_regime_builder


def diagnostics_summary(diag):
    """The compact form of `diagnostics()` archived in the gate's history entry.

    Per-season COUNTS only, not the team lists: the history file is appended to
    weekly and the full listing belongs in the module's fixture report, not in
    every archived run.
    """
    if not diag:
        return {}
    return {
        "rule": diag.get("rule"),
        "midseason_policy": diag.get("midseason_policy"),
        "first_year_regimes": diag.get("first_year_regimes"),
        "midseason_changes_excluded": diag.get("midseason_changes"),
        "by_season": {str(y): v.get("first_year_regimes", 0)
                      for y, v in sorted((diag.get("by_season") or {}).items())},
    }


def trial_label(shrink, decay_n0):
    decay = "flat" if decay_n0 is None else f"n0={decay_n0:g}"
    return f"shrink={shrink:.2f} {decay}"


def adoption_block(best, now):
    """The `game_params.coach_regime` record written when the family is adopted."""
    return {"applied": True,
            "shrink": best["shrink"],
            "decay_n0": best["decay_n0"],
            "mean_elo": MEAN,
            "adopted_utc": now}


def delta_from_params(params, home_rating, away_rating,
                      home_new_regime, away_new_regime,
                      home_games_played=0, away_games_played=0):
    """Prediction-time delta from an adopted `game_params['coach_regime']` block.

    NOT WIRED into scripts/build_predictions.py by this agent, and the family is
    deliberately absent from promote_signals.APPLIABLE for exactly that reason:
    the gate must never claim a signal is applied when the pipeline cannot apply
    it. This is the reader a future wiring change calls -- it needs only the
    current ratings the prediction builder already holds and the two coaching
    flags -- so wiring is a small change rather than a redesign.
    """
    if not params or not params.get("applied"):
        return 0.0
    shrink = float(params.get("shrink") or 0.0)
    n0 = params.get("decay_n0")
    mean = float(params.get("mean_elo", MEAN))
    dev_h = (float(home_rating) - mean) if home_new_regime else 0.0
    dev_a = (float(away_rating) - mean) if away_new_regime else 0.0
    return shrink * (-dev_h * confidence_weight(home_games_played, n0)
                     + dev_a * confidence_weight(away_games_played, n0))


# --------------------------------------------------------------------------- #
# selftest                                                                     #
# --------------------------------------------------------------------------- #

def _synth_seasons():
    """Three tiny seasons, four teams. Season 1 seeds, 2 and 3 are priced."""
    def g(wk, h, a, hs, as_, yr, day):
        return {"home": h, "away": a, "home_score": hs, "away_score": as_,
                "week": wk, "kickoff_utc": f"{yr}-09-{day:02d}T17:00:00Z"}
    return {
        2001: [g(1, "AAA", "BBB", 24, 10, 2001, 10),
               g(1, "CCC", "DDD", 20, 17, 2001, 11),
               g(2, "BBB", "CCC", 13, 13, 2001, 17)],
        2002: [g(1, "BBB", "AAA", 14, 31, 2002, 10),
               g(1, "DDD", "CCC", 9, 6, 2002, 11),
               g(2, "AAA", "CCC", 28, 27, 2002, 17),
               g(2, "BBB", "DDD", 3, 30, 2002, 18)],
        2003: [g(1, "AAA", "DDD", 21, 20, 2003, 10),
               g(1, "CCC", "BBB", 17, 14, 2003, 11)],
    }


def _synth_ctx(finals, coaches):
    """coaches: {(season, team): name} -> a context map."""
    ctx = {}
    for yr, games in finals.items():
        for gm in games:
            ctx[context_key(yr, gm)] = {
                "home_coach": coaches[(yr, gm["home"])],
                "away_coach": coaches[(yr, gm["away"])]}
    return ctx


def selftest():
    """Asserts only. Never reads or writes data/."""
    import math
    from scripts import promote_signals as ps

    finals = _synth_seasons()
    seasons = [2001, 2002, 2003]
    hfa, k, revert = 45.0, 25.0, 0.45
    base = {"AAA": "Ann Alpha", "BBB": "Bob Beta",
            "CCC": "Cal Gamma", "DDD": "Dee Delta"}
    coaches = {(yr, t): base[t] for yr in seasons for t in base}
    coaches[(2002, "BBB")] = "NEW"          # offseason regime change
    coaches[(2003, "BBB")] = "NEW"          # ... continuous the year after
    ctx = _synth_ctx(finals, coaches)

    # --- 1. the rating trajectory reproduces walk_season EXACTLY ----------- #
    stream = rating_stream(finals, seasons, hfa, k, revert)
    assert len(stream) == sum(len(v) for v in finals.values()) == 9
    theirs = []
    priors = {}
    for yr in seasons:
        _, _, res = ps.walk_season(finals[yr], priors, hfa, k,
                                   collect_residuals=True)
        theirs.extend(res)
        rated = elo_mod.rate_season(finals[yr], hfa=hfa, k=k,
                                    initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    mine = [(gm["home"], a - elo_mod.expected_home(rh, ra, hfa))
            for (_yr, gm, rh, ra) in stream
            if gm["home_score"] != gm["away_score"]
            for a in (1.0 if gm["home_score"] > gm["away_score"] else 0.0,)]
    assert len(mine) == len(theirs) == 8, (len(mine), len(theirs))   # 1 tie
    for (team, r), (team2, r2, _cold) in zip(mine, theirs):
        assert team == team2, (team, team2)
        assert abs(r - r2) < 1e-12, (r, r2)

    # --- 2. the very first game's ratings are hand-known ------------------- #
    assert stream[0][2] == elo_mod.INIT and stream[0][3] == elo_mod.INIT

    # --- 3. regime detection, including the no-prior-season case ----------- #
    flags, diag = first_year_regimes(finals, seasons, ctx)
    assert flags == {(2002, "BBB")}, flags
    assert diag["by_season"][2001]["no_prior_season"] == \
        ["AAA", "BBB", "CCC", "DDD"], diag["by_season"][2001]
    assert diag["by_season"][2001]["first_year_regimes"] == 0
    assert diag["by_season"][2002]["flagged"] == ["BBB"]
    assert diag["by_season"][2003]["first_year_regimes"] == 0   # NEW retained
    assert diag["midseason_changes"] == 0

    # --- 4. a MID-SEASON change is counted and NEVER flagged --------------- #
    ctx_mid = _synth_ctx(finals, dict(coaches))     # DDD continuous into 2002
    # ... now rewrite DDD's SECOND 2002 game to a different coach in-season.
    ctx_mid[context_key(2002, finals[2002][3])]["away_coach"] = "INTERIM"
    f2, d2 = first_year_regimes(finals, seasons, ctx_mid)
    assert (2002, "DDD") not in f2, f2                 # excluded, as documented
    assert d2["midseason_changes"] == 1, d2
    assert d2["by_season"][2002]["midseason_changes"] == 1
    # and the interim finishing 2002 DOES make 2003 a regime change for DDD
    assert (2003, "DDD") in f2, f2

    # --- 5. the delta is the exact reversion difference -------------------- #
    fit = inputs(finals, seasons, hfa, k, revert, ctx=ctx)
    assert fit is not None
    by_key = {context_key(yr, gm): (rh, ra) for (yr, gm, rh, ra) in stream}
    gm = finals[2002][0]                                # BBB home (flagged), AAA away
    rh, ra = by_key[context_key(2002, gm)]
    phi = 0.30
    want = -phi * (rh - MEAN)                           # away is not flagged
    assert abs(fit.delta(2002, gm, phi, None) - want) < 1e-12, \
        (fit.delta(2002, gm, phi, None), want)
    # and it really is "price this game with a further-reverted rating"
    rh2 = MEAN + (1 - phi) * (rh - MEAN)
    assert abs(elo_mod.expected_home(rh, ra, hfa + fit.delta(2002, gm, phi, None))
               - elo_mod.expected_home(rh2, ra, hfa)) < 1e-15

    # --- 6. NOT "new coaches are worse": the sign follows the RATING ------- #
    # BBB lost its 2001 opener, so its rating is below the mean and the discount
    # RAISES its price. Flip the deviation and the delta flips with it.
    assert rh < MEAN and fit.delta(2002, gm, phi, None) > 0.0
    up = RegimeFit({context_key(2002, gm): (+100.0, 0, 0.0, 0)})
    down = RegimeFit({context_key(2002, gm): (-100.0, 0, 0.0, 0)})
    assert abs(up.delta(2002, gm, phi, None) + down.delta(2002, gm, phi, None)) < 1e-15
    assert up.delta(2002, gm, phi, None) < 0 < down.delta(2002, gm, phi, None)
    # a flagged team sitting exactly on the mean is untouched
    assert RegimeFit({context_key(2002, gm): (0.0, 0, 0.0, 0)}).delta(
        2002, gm, 0.5, None) == 0.0

    # --- 7. linear in shrink; shrink 0 is exactly the incumbent ------------ #
    d = fit.delta(2002, gm, 0.25, None)
    assert abs(fit.delta(2002, gm, 0.50, None) - 2.0 * d) < 1e-12
    assert fit.delta(2002, gm, 0.0, None) == 0.0

    # --- 8. antisymmetry under swapping the two sidelines ------------------ #
    key_game = {"home": "H", "away": "A", "week": "w"}
    kk = context_key("s", key_game)
    sym = RegimeFit({kk: (30.0, 2, -70.0, 5)})
    swapped = RegimeFit({kk: (-70.0, 5, 30.0, 2)})
    for n0 in (None, 4.0):
        a = sym.delta("s", key_game, 0.4, n0)
        b = swapped.delta("s", key_game, 0.4, n0)
        assert abs(a + b) < 1e-12, (a, b, n0)

    # --- 9. decay is exactly n0/(n0+g) ------------------------------------- #
    assert confidence_weight(0, None) == 1.0
    assert confidence_weight(9, None) == 1.0
    assert confidence_weight(0, 4.0) == 1.0
    assert abs(confidence_weight(4, 4.0) - 0.5) < 1e-15
    assert abs(confidence_weight(12, 4.0) - 0.25) < 1e-15
    g6 = finals[2002][3]                                # BBB's SECOND 2002 game
    row = fit.rows[context_key(2002, g6)]
    assert row[1] == 1, row                             # one game already played
    assert abs(fit.delta(2002, g6, phi, 4.0)
               - fit.delta(2002, g6, phi, None) * (4.0 / 5.0)) < 1e-12

    # --- 10. unflagged games are EXACTLY zero, at every setting ------------ #
    for g_ in (finals[2002][1], finals[2002][2]):       # DDD/CCC and AAA/CCC
        for n0 in (None, 4.0):
            assert fit.delta(2002, g_, 0.5, n0) == 0.0, g_
    for g_ in finals[2001]:                             # no prior season at all
        assert fit.delta(2001, g_, 0.5, None) == 0.0, g_

    # --- 11. missing context is 0.0, never a crash ------------------------- #
    assert RegimeFit({}).delta(2002, gm, 0.5, None) == 0.0
    assert coach_pair({}, 2002, gm) == (None, None)
    assert coach_pair({context_key(2002, gm): {"home_coach": "",
                                               "away_coach": None}},
                      2002, gm) == (None, None)

    # --- 12. inputs() refuses absent and partial coverage ------------------ #
    assert inputs(finals, seasons, hfa, k, revert, ctx={}) is None
    holed = {kk2: v for kk2, v in ctx.items() if not kk2.startswith("2002|1|")}
    assert inputs(finals, seasons, hfa, k, revert, ctx=holed) is None

    # --- 13. builder plugs into evaluate()'s (setup, factory) contract ----- #
    setup, factory = coach_regime_builder(phi, None, fit)
    fn = factory(setup(2002, finals[2002], []))
    assert abs(fn(finals[2002][0], 0) - want) < 1e-12
    assert fn(finals[2002][1], 1) == 0.0

    # --- 14. the grid is the shape the design fixed ------------------------ #
    assert len(REGIME_SHRINK) == 3 and 0.0 not in REGIME_SHRINK
    assert all(0.0 < s < 1.0 for s in REGIME_SHRINK)
    assert REGIME_DECAY_N0 == [None, 4.0]
    assert len(REGIME_SHRINK) * len(REGIME_DECAY_N0) == 6
    assert MEAN == elo_mod.INIT

    # --- 15. delta_from_params mirrors the fitted delta --------------------- #
    params = adoption_block({"shrink": phi, "decay_n0": None}, "now")
    assert abs(delta_from_params(params, rh, ra, True, False) - want) < 1e-12
    assert delta_from_params(params, rh, ra, False, False) == 0.0
    assert delta_from_params({"applied": False, "shrink": phi}, rh, ra,
                             True, True) == 0.0
    p4 = adoption_block({"shrink": phi, "decay_n0": 4.0}, "now")
    assert abs(delta_from_params(p4, rh, ra, True, False, 4, 0)
               - want * 0.5) < 1e-12

    assert math.isfinite(want)
    print("selftest OK: coach_regime rating stream == walk_season, regime "
          "detection at the season boundary only (mid-season counted and "
          "excluded), delta == the exact extra-reversion price difference, "
          "sign follows the rating not the coach, decay n0/(n0+g), "
          "unflagged and unjoined games exactly 0.0")


def fixture_report(path):
    """Run the family over a committed fixture and print the result as JSON.

    tests/feature/family_coach_regime.test.mjs drives this and recomputes the
    expected Elo trajectory itself in JavaScript, so the Node test checks the
    numbers rather than trusting this module's own verdict.
    """
    with open(path, encoding="utf-8") as fh:
        fx = json.load(fh)
    p = fx["params"]
    seasons = [int(s) for s in fx["seasons"]]
    finals = {int(y): games for y, games in fx["finals"].items()}
    ctx = fx["context"]

    flags, diag = first_year_regimes(finals, seasons, ctx)
    fit = inputs(finals, seasons, p["hfa"], p["k"], p["revert"], ctx=ctx)
    stream = rating_stream(finals, seasons, p["hfa"], p["k"], p["revert"])
    last = seasons[-1]
    grid = [{"shrink": s, "decay_n0": n0,
             "deltas": [fit.delta(last, g, s, n0) for g in finals[last]]}
            for s in REGIME_SHRINK for n0 in REGIME_DECAY_N0]
    report = {
        "flags": sorted(f"{s}|{t}" for (s, t) in flags),
        "diagnostics": diag,
        "ratings": [{"key": context_key(yr, g), "home": g["home"],
                     "away": g["away"], "rating_home": rh, "rating_away": ra}
                    for (yr, g, rh, ra) in stream],
        "rows": {kk: list(v) for kk, v in sorted(fit.rows.items())},
        "grid": grid,
        "coverage": {str(y): list(v) for y, v in
                     sorted(join_coverage(finals, seasons, ctx).items())},
        "mean_elo": MEAN,
        "shrinks": REGIME_SHRINK,
        "decays": REGIME_DECAY_N0,
    }
    print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True))


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--fixture" in sys.argv:
        fixture_report(sys.argv[sys.argv.index("--fixture") + 1])
    else:
        print(__doc__)
