"""coach_quality — a head-coach effect priced as an Elo-space RESIDUAL.

WHAT THIS FAMILY CLAIMS
    Two teams with identical Elo ratings are not identical opponents if one is
    coached by someone whose teams have persistently outrun their rating and the
    other by someone whose teams have persistently underrun it. The family adds
    `q[home_coach] - q[away_coach]` Elo to the home price and nothing else.

THE TRAP, STATED FIRST (docs/roadmap/rel18/SOLUTION_DESIGN.md §9.5)
    Coach quality is ALREADY inside team Elo. A good coach's teams win; winning
    raises the rating; the rating is the model's input. So the naive build --
    rate coaches by their teams' win rate, or by point margin, or by anything
    the rating itself is fit on -- double-counts the coach and then reports the
    double-count as an improvement. In-sample it looks excellent. It is an
    accounting error.

    The fix is structural, not a hyperparameter: fit the coach on what the team
    rating FAILED to explain.

        r(game) = actual_home_win - expected_home(R_home, R_away, flat_hfa)

    r is the pre-game Elo forecast error. Whatever the rating already knew about
    this coach is, by construction, subtracted out of r before the coach ever
    sees it. A coach whose edge is fully priced by Elo has mean r == 0 and earns
    q == 0. Only the part Elo could not price survives.

    Three further anti-double-count details:

    1. SIGNED BY VENUE (+r when the coach's team was home, -r when away). The
       unsigned home residual is home-field advantage, which the `environment`
       family already prices per venue; signing it makes the quantity a
       team-STRENGTH residual instead, orthogonal to venue.
    2. DIFFERENCED (q_home - q_away). Any league-wide residual drift -- a
       mis-set global hfa, a scoring-era shift -- is common to both coaches in
       every game and cancels exactly. The family can only ever express a
       DIFFERENCE between the two sidelines.
    3. SHRUNK toward zero by n/(n+SHRINK_N), the same SHRINK_N=16 the adopted
       `environment` family uses. A coach with 8 career training games keeps
       a third of his measured mean; a coach with none keeps zero.

LEAKAGE DISCIPLINE (the part that invalidates everything if it is wrong)
    A coach's rating for eval season N is fit on decided games from seasons
    STRICTLY BEFORE N and on nothing else. This is enforced by SHAPE, not by a
    conditional that could be edited away: `fit_by_season` builds a frozen
    per-season snapshot dict, and `CoachFit.delta(season, ...)` can only read
    the snapshot filed under that season. There is no code path from a season-N
    game to a season-N residual. A coach in his first career season therefore
    has n == 0 and contributes exactly 0.0 -- the family is silent about him
    rather than guessing, which is the honest default.

    Within-season updating is deliberately NOT done. It would be defensible
    (weeks < W are pregame information for week W) but it is not what the design
    specifies, and a mid-season refit would let a hot start feed back into
    pricing the same season's later games through a quantity that is already a
    forecast error -- the exact shape of an accidental leak.

WHY THE RESIDUAL STREAM CAN BE RECOMPUTED HERE
    `promote_signals.walk_season` updates ratings with the FLAT incumbent hfa
    regardless of any candidate delta (that is the module's stated invariant),
    and between-season priors come from `elo.rate_season` + `elo.revert_to_mean`
    on the same games. The rating trajectory is therefore a pure function of
    (finals_by_year, hfa, k, revert) and is identical for every candidate. So
    this module reproduces it exactly rather than requiring the shared residual
    row to grow a game key -- `residual_stream` is asserted byte-identical to
    `walk_season`'s residuals in `selftest()`, and that assertion is what keeps
    the two copies honest.

THE HONEST CAVEAT, RECORDED BEFORE THE MEASUREMENT
    Even done correctly this is a thin signal. Elo converges: a coach who was
    underrated in 2004 has been priced correctly since about 2006, so his
    career-mean residual is mostly a stale artifact of seasons whose evidence
    the rating has long since absorbed. The construction is right; the quantity
    may still be near zero. That is a finding, not a failure, and the gate is
    what decides.

Stdlib only. Deterministic. Reads data/game_context.json (pregame enrichment;
market columns never appear in it) and never any market column.
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

# Elo points per unit of shrunk mean signed residual. 0.0 is "family off" and is
# excluded from the trial grid by the caller (it IS the incumbent). Mirrors
# VENUE_SCALES/COLD_SCALES in promote_signals: a mean residual of 0.05 (a team
# beating its price by 5 percentage points) buys 5-15 Elo at these scales, which
# is the right order of magnitude for a coaching edge and nowhere near enough to
# swamp the rating.
COACH_SCALES = [0.0, 100.0, 200.0, 300.0]

# Same shrinkage constant as promote_signals.SHRINK_N. Duplicated deliberately:
# importing promote_signals from a signals module would be a circular import
# (promote_signals imports this module). `selftest()` asserts the two agree.
SHRINK_N = 16

# A season is only counted as covered when essentially all of its decided games
# resolve to a context record. A silent join miss degrades the family to neutral
# on those games -- exact ties that dilute the measured improvement toward zero
# without anything going red -- so partial coverage is refused loudly instead.
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
    """(home_coach, away_coach) for a game, or (None, None) when unjoinable.

    Never raises and never invents a name: a missing record, a missing field or
    an empty string all collapse to None, which every caller treats as "this
    family has nothing to say about this game" -> delta 0.0.
    """
    rec = ctx.get(context_key(season, game)) if ctx else None
    if not rec:
        return (None, None)
    home = rec.get("home_coach") or None
    away = rec.get("away_coach") or None
    return (home, away)


# --------------------------------------------------------------------------- #
# the residual stream (a faithful copy of walk_season's rating trajectory)      #
# --------------------------------------------------------------------------- #

def residual_stream(finals_by_year, seasons, hfa, k, revert):
    """[(season, game, residual)] for every DECIDED game, in walk order.

    residual = actual_home_win - expected_home(pre-game ratings, FLAT hfa), i.e.
    the incumbent model's signed forecast error on that game. Ties are skipped
    (they score no log-loss and carry no direction), exactly as walk_season does.

    The rating trajectory reproduced here is walk_season's: in-season updates
    with the flat hfa and the MOV multiplier, then rate_season + revert_to_mean
    to seed the next season's priors.
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
            hs, as_ = g["home_score"], g["away_score"]
            exp_h = elo_mod.expected_home(rh, ra, hfa)
            if hs != as_:
                actual = 1.0 if hs > as_ else 0.0
                out.append((yr, g, actual - exp_h))
                margin = (hs - as_) if hs > as_ else (as_ - hs)
                dw = ((rh + hfa) - ra) if hs > as_ else (ra - (rh + hfa))
                actual_h = actual
            else:
                actual_h, margin, dw = 0.5, 1, 0.0
            mult = elo_mod._mov_multiplier(margin, dw)
            delta = k * mult * (actual_h - exp_h)
            ratings[h] = rh + delta
            ratings[a] = ra - delta
        rated = elo_mod.rate_season(games, hfa=hfa, k=k, initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    return out


def _accumulate(sums, ctx, season, game, resid):
    """Fold one game's residual into both coaches' signed accumulators.

    +resid for the HOME coach, -resid for the AWAY coach: a home overperformance
    is the home coach's credit and the away coach's debit. Games that do not
    join, or whose coach is missing, are skipped -- and skipped from the COUNT
    too, so shrinkage sees the real sample size rather than a padded one.
    """
    home, away = coach_pair(ctx, season, game)
    if home:
        acc = sums.setdefault(home, [0.0, 0])
        acc[0] += resid
        acc[1] += 1
    if away:
        acc = sums.setdefault(away, [0.0, 0])
        acc[0] -= resid
        acc[1] += 1


def join_coverage(finals_by_year, seasons, ctx):
    """{season: (joined_games, total_games)} over DECIDED games.

    Reported so a skip is a statement about the data and not a shrug.
    """
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


class CoachFit:
    """Frozen per-season coach ratings. THE leak barrier.

    `by_season[N]` was built from seasons < N and holds unscaled q values
    (shrunk mean signed residual). `delta()` may read no other season's map, so
    a season-N game cannot reach a season-N residual by any route.
    """

    __slots__ = ("by_season", "coverage", "seasons")

    def __init__(self, by_season, coverage=None, seasons=None):
        self.by_season = by_season
        self.coverage = coverage or {}
        self.seasons = list(seasons or sorted(by_season))

    def q(self, season, coach, scale):
        if not coach:
            return 0.0
        return scale * (self.by_season.get(season, {}).get(coach, 0.0))

    def delta(self, ctx, season, game, scale):
        """Elo added to the HOME price: scale * (q_home - q_away)."""
        home, away = coach_pair(ctx, season, game)
        return self.q(season, home, scale) - self.q(season, away, scale)

    def n_rated(self, season):
        return len(self.by_season.get(season, {}))


def fit_by_season(stream, ctx, seasons, shrink_n=SHRINK_N):
    """{season: {coach: shrunk mean signed residual}} -- walk-forward by shape.

    Walks the residual stream once in chronological order. Before consuming any
    of season N's residuals it FREEZES a snapshot of the accumulators as they
    stand -- which is exactly "every decided game from seasons < N". The
    snapshot for N is written before N's first residual is read, so no ordering
    mistake inside this loop can smuggle season N into its own fit.
    """
    sums = {}
    by_season = {}
    ordered = sorted(set(seasons))
    pending = list(ordered)
    for season, game, resid in stream:
        while pending and pending[0] <= season:
            yr = pending.pop(0)
            by_season[yr] = _snapshot(sums, shrink_n)
        _accumulate(sums, ctx, season, game, resid)
    for yr in pending:
        by_season[yr] = _snapshot(sums, shrink_n)
    return by_season


def _snapshot(sums, shrink_n):
    """shrink(n) * mean(signed residual) per coach, as of right now."""
    out = {}
    for coach, (total, n) in sums.items():
        if not n:
            continue
        out[coach] = (total / n) * (n / float(n + shrink_n))
    return out


# --------------------------------------------------------------------------- #
# the promote_signals family contract                                          #
# --------------------------------------------------------------------------- #

def inputs(finals_by_year, seasons, hfa, k, revert, ctx=None,
           context_path=CONTEXT_PATH):
    """(ctx, CoachFit) ready for `builder`, or None -- SKIP, never fake.

    None when game_context.json is absent, or when any season in the walk fails
    MIN_JOIN_RATE. Partial coverage is refused rather than silently scoring
    exact ties on the uncovered folds, which is the same discipline
    `weather_wind` and `skill_out` already apply.
    """
    if ctx is None:
        ctx = load_context(context_path)
    if not ctx:
        return None
    coverage = join_coverage(finals_by_year, seasons, ctx)
    for yr, (joined, total) in coverage.items():
        if not total or (joined / float(total)) < MIN_JOIN_RATE:
            return None
    stream = residual_stream(finals_by_year, seasons, hfa, k, revert)
    fit = CoachFit(fit_by_season(stream, ctx, seasons), coverage, seasons)
    return (ctx, fit)


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


def builder(scale, fit_inputs):
    """(setup, factory) in promote_signals' family shape.

    setup receives (season, games, training_residuals) and IGNORES
    training_residuals: this family does its own leak-free fit (see the module
    docstring) precisely so the shared residual row does not have to change
    shape for it.
    """
    ctx, fit = fit_inputs

    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            return fit.delta(ctx, season, g, scale)
        return fn

    return setup, factory


def production_deltas(finals_by_year, seasons, hfa, k, revert, scale,
                      ctx=None, context_path=CONTEXT_PATH):
    """{coach: q} fit over ALL resolved seasons, for `_write_adoption`.

    Training-only fitting is for honest EVALUATION; the shipped prior uses every
    resolved season, matching the `venue_hfa` precedent in promote_signals.
    """
    if ctx is None:
        ctx = load_context(context_path)
    if not ctx:
        return {}
    sums = {}
    for season, game, resid in residual_stream(finals_by_year, seasons, hfa, k,
                                               revert):
        _accumulate(sums, ctx, season, game, resid)
    return {c: scale * v for c, v in _snapshot(sums, SHRINK_N).items()}


def delta_from_params(params, home_coach, away_coach):
    """Prediction-time delta from an adopted game_params['coach_quality'] block.

    NOT WIRED into scripts/build_predictions.py by this agent, and the family is
    deliberately absent from promote_signals.APPLIABLE for that reason: the gate
    must never claim a signal is applied when the pipeline cannot apply it. This
    function is the reader that a future wiring change would call; it exists so
    the application path is a two-line change rather than a redesign.
    """
    if not params or not params.get("applied"):
        return 0.0
    deltas = params.get("deltas") or {}
    return float(deltas.get(home_coach or "", 0.0)) - \
        float(deltas.get(away_coach or "", 0.0))


# --------------------------------------------------------------------------- #
# selftest                                                                     #
# --------------------------------------------------------------------------- #

def _synth_seasons():
    """Two tiny seasons, four teams, decided games plus one tie."""
    def g(wk, h, a, hs, as_, yr):
        return {"home": h, "away": a, "home_score": hs, "away_score": as_,
                "week": wk, "kickoff_utc": f"{yr}-09-{10 + wk:02d}T17:00:00Z"}
    return {
        2001: [g(1, "AAA", "BBB", 24, 10, 2001), g(2, "CCC", "DDD", 17, 17, 2001),
               g(3, "BBB", "CCC", 3, 30, 2001), g(4, "DDD", "AAA", 21, 20, 2001)],
        2002: [g(1, "BBB", "AAA", 14, 31, 2002), g(2, "DDD", "CCC", 9, 6, 2002),
               g(3, "AAA", "CCC", 28, 27, 2002), g(4, "CCC", "BBB", 13, 10, 2002)],
    }


def _synth_ctx(finals):
    """Coach map: one coach per team, stable across both seasons."""
    coaches = {"AAA": "Ann Alpha", "BBB": "Bob Beta", "CCC": "Cal Gamma",
               "DDD": "Dee Delta"}
    ctx = {}
    for yr, games in finals.items():
        for gm in games:
            ctx[context_key(yr, gm)] = {"home_coach": coaches[gm["home"]],
                                        "away_coach": coaches[gm["away"]]}
    return ctx


def selftest():
    """Asserts only. Never reads or writes data/."""
    from scripts import promote_signals as ps

    assert SHRINK_N == ps.SHRINK_N, (SHRINK_N, ps.SHRINK_N)
    assert COACH_SCALES[0] == 0.0, COACH_SCALES

    finals = _synth_seasons()
    seasons = [2001, 2002]
    ctx = _synth_ctx(finals)
    hfa, k, revert = 45.0, 25.0, 0.45

    # --- 1. residual_stream reproduces walk_season EXACTLY ----------------- #
    # The two copies of the rating trajectory must not drift. Compare against
    # walk_season's own residual rows, projected to (team, residual).
    mine = residual_stream(finals, seasons, hfa, k, revert)
    theirs = []
    priors = {}
    for yr in seasons:
        _, _, res = ps.walk_season(finals[yr], priors, hfa, k,
                                   collect_residuals=True)
        theirs.extend(res)
        rated = elo_mod.rate_season(finals[yr], hfa=hfa, k=k,
                                    initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    assert len(mine) == len(theirs) == 7, (len(mine), len(theirs))  # 8 games, 1 tie
    for (yr, gm, r), (team, r2, _cold) in zip(mine, theirs):
        assert gm["home"] == team, (gm["home"], team)
        assert abs(r - r2) < 1e-12, (r, r2)

    # --- 2. hand-computed residual on the very first game ------------------ #
    # Both teams start at INIT, so expected_home = 1/(1+10^(-45/400)).
    import math
    p0 = 1.0 / (1.0 + math.pow(10.0, -(45.0 / 400.0)))
    assert abs(mine[0][2] - (1.0 - p0)) < 1e-12, (mine[0][2], 1.0 - p0)

    # --- 3. WALK-FORWARD: season 2001 is fit on NOTHING -------------------- #
    by_season = fit_by_season(mine, ctx, seasons)
    assert by_season[2001] == {}, by_season[2001]
    assert by_season[2002], "2002 must be fit on 2001's residuals"
    fit = CoachFit(by_season, seasons=seasons)
    for gm in finals[2001]:
        assert fit.delta(ctx, 2001, gm, 300.0) == 0.0, gm
    # A coach who never appears before 2002 would still be 0.0 in 2002.
    assert fit.q(2002, "Nobody Here", 300.0) == 0.0

    # --- 4. the 2002 fit uses ONLY 2001, and by hand ----------------------- #
    # Ann Alpha coaches AAA: 2001 games 1 (home, +r0) and 4 (away, -r3).
    r0 = mine[0][2]
    r3 = [r for (yr, gm, r) in mine
          if yr == 2001 and gm["home"] == "DDD" and gm["away"] == "AAA"][0]
    n = 2
    want = ((r0 - r3) / n) * (n / float(n + SHRINK_N))
    assert abs(by_season[2002]["Ann Alpha"] - want) < 1e-12, \
        (by_season[2002]["Ann Alpha"], want)
    # The tie (CCC 17-17 DDD) contributed no residual AND no count. Cal Gamma
    # played twice in 2001; only the decided game (3: away at BBB) is in n.
    cal_games = [(gm, r) for (yr, gm, r) in mine if yr == 2001
                 and "CCC" in (gm["home"], gm["away"])]
    assert len(cal_games) == 1, cal_games          # the tie is absent
    cal_gm, cal_r = cal_games[0]
    assert cal_gm["away"] == "CCC", cal_gm         # so the sign is negative
    cal_want = (-cal_r / 1.0) * (1.0 / (1.0 + SHRINK_N))
    assert abs(by_season[2002]["Cal Gamma"] - cal_want) < 1e-12, \
        (by_season[2002]["Cal Gamma"], cal_want)

    # --- 5. the family is DIFFERENCED and ANTISYMMETRIC -------------------- #
    gm = finals[2002][0]                            # BBB home, AAA away
    d = fit.delta(ctx, 2002, gm, 200.0)
    flipped = dict(gm)
    flipped["home"], flipped["away"] = gm["away"], gm["home"]
    ctx2 = dict(ctx)
    ctx2[context_key(2002, flipped)] = {"home_coach": "Ann Alpha",
                                        "away_coach": "Bob Beta"}
    assert abs(fit.delta(ctx2, 2002, flipped, 200.0) + d) < 1e-12
    # scale is linear and scale 0 is exactly the incumbent
    assert abs(fit.delta(ctx, 2002, gm, 400.0) - 2.0 * d) < 1e-12
    assert fit.delta(ctx, 2002, gm, 0.0) == 0.0

    # --- 6. a common shift in EVERY coach's q cancels ---------------------- #
    shifted = {2002: {c: v + 0.05 for c, v in by_season[2002].items()}}
    assert abs(CoachFit(shifted).delta(ctx, 2002, gm, 200.0) - d) < 1e-12

    # --- 7. missing context is 0.0, never a crash -------------------------- #
    assert fit.delta({}, 2002, gm, 300.0) == 0.0
    assert coach_pair({}, 2002, gm) == (None, None)
    assert coach_pair({context_key(2002, gm): {"home_coach": "",
                                               "away_coach": None}},
                      2002, gm) == (None, None)
    _, fac = builder(300.0, ({}, fit))
    assert fac(2002)(gm, 0) == 0.0

    # --- 8. inputs() refuses partial coverage ------------------------------ #
    assert inputs(finals, seasons, hfa, k, revert, ctx={}) is None
    holed = {kk: v for kk, v in ctx.items() if not kk.startswith("2002|1|")}
    assert inputs(finals, seasons, hfa, k, revert, ctx=holed) is None
    ok = inputs(finals, seasons, hfa, k, revert, ctx=ctx)
    assert ok is not None and ok[1].by_season[2001] == {}

    # --- 9. builder plugs into evaluate()'s (setup, factory) contract ------ #
    setup, factory = builder(200.0, (ctx, fit))
    fn = factory(setup(2002, finals[2002], []))
    assert abs(fn(finals[2002][0], 0) - d) < 1e-12

    # --- 10. production_deltas uses every season and is scale-linear ------- #
    prod = production_deltas(finals, seasons, hfa, k, revert, 100.0, ctx=ctx)
    prod2 = production_deltas(finals, seasons, hfa, k, revert, 200.0, ctx=ctx)
    assert set(prod) == {"Ann Alpha", "Bob Beta", "Cal Gamma", "Dee Delta"}
    for c in prod:
        assert abs(prod2[c] - 2.0 * prod[c]) < 1e-12, c
    # and it is NOT the 2002 training snapshot (it saw 2002 too)
    assert abs(prod["Ann Alpha"] / 100.0 - by_season[2002]["Ann Alpha"]) > 1e-9

    # --- 11. delta_from_params mirrors the fitted difference --------------- #
    params = {"applied": True, "scale": 100.0, "shrink_n": SHRINK_N,
              "deltas": prod}
    assert abs(delta_from_params(params, "Ann Alpha", "Bob Beta")
               - (prod["Ann Alpha"] - prod["Bob Beta"])) < 1e-12
    assert delta_from_params({"applied": False, "deltas": prod},
                             "Ann Alpha", "Bob Beta") == 0.0
    assert delta_from_params(params, None, None) == 0.0
    assert delta_from_params(params, "Ghost", "Ann Alpha") == -prod["Ann Alpha"]

    print("selftest OK: coach_quality residual stream == walk_season, "
          "walk-forward by shape (first season fits on nothing), differenced "
          "and shrunk, partial coverage refused")


def fixture_report(path):
    """Run the fit over a committed fixture and print the result as JSON.

    The fixture (data/fixtures/coach_quality_sample.json) is built so that its
    expected values are EXACT ARITHMETIC and can be derived on paper without
    reproducing an Elo trajectory — see its `note`. This entry point is what
    tests/feature/family_coach_quality.test.mjs drives, so the Node test checks
    the numbers itself rather than trusting a Python selftest's own verdict.
    """
    with open(path, encoding="utf-8") as fh:
        fx = json.load(fh)
    p = fx["params"]
    seasons = [int(s) for s in fx["seasons"]]
    finals = {int(y): games for y, games in fx["finals"].items()}
    ctx = fx["context"]
    scale = float(fx["scale"])

    stream = residual_stream(finals, seasons, p["hfa"], p["k"], p["revert"])
    by_season = fit_by_season(stream, ctx, seasons)
    fit = CoachFit(by_season, seasons=seasons)
    last = seasons[-1]
    report = {
        "by_season": {str(y): {c: v for c, v in sorted(m.items())}
                      for y, m in sorted(by_season.items())},
        "deltas": [fit.delta(ctx, last, g, scale) for g in finals[last]],
        "coverage": {str(y): list(v) for y, v in
                     sorted(join_coverage(finals, seasons, ctx).items())},
        "inputs_refused": inputs(finals, seasons, p["hfa"], p["k"], p["revert"],
                                 ctx=ctx) is None,
        "residuals": len(stream),
        "shrink_n": SHRINK_N,
        "scales": COACH_SCALES,
    }
    print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True))


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--fixture" in sys.argv:
        fixture_report(sys.argv[sys.argv.index("--fixture") + 1])
    else:
        print(__doc__)
