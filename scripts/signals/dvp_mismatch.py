"""`dvp_mismatch` — the game-level candidate family for defense-vs-position.

## What it prices, and what it deliberately does NOT price

A defense that is unusually leaky against one position, meeting an offense that
leans on that position, should be worth something beyond what the team ratings
already say. That is the claim. The thing that makes it a claim and not a
restatement of Elo is the word *unusually*.

    delta(g) = scale * (edge(home_off, away_def) - edge(away_off, home_def))
    edge(T, D) = SUM_p  lean[T][p] * tilt[D][p]

where, for season Y and week W, over the strictly-pregame window described
below:

    allow[D][p]  = scrimmage PPR per game position p scored against defense D
    z[D][p]      = (allow[D][p] - league_mean_p) / league_sd_p
    tilt[D][p]   = z[D][p] - mean_q z[D][q]        <- positional ASYMMETRY
    share[T][p]  = off_ppr[T][p] / SUM_q off_ppr[T][q]
    lean[T][p]   = share[T][p] - league_mean_share_p   <- positional LEAN

### Why both terms are centered (a deliberate departure from the design formula)

SOLUTION_DESIGN §5.4 writes `edge(T,D) = SUM_p share[T][p] * z_allowed[D][p]`.
Because `share` is a probability vector summing to 1, that expression is
approximately `mean_p z[D][p]` plus an interaction — i.e. it is dominated by
"is this defense bad at everything", which is precisely what Elo and
`epa_total` already carry. The same two documents state the actual hypothesis
in prose: *"the non-redundant thing DvP knows is positional asymmetry: a
defense elite vs WR and leaky vs RB has the same aggregate EPA as a balanced
one."* Centering `z` within the defense (`tilt`) and `share` within the league
(`lean`) is what makes the arithmetic say that sentence. Both centered vectors
sum to ~0 across positions, so a uniformly-bad defense and a
league-average-shaped offense both contribute exactly 0.0 and the family cannot
smuggle in overall strength.

This is a strictly harder test of the family than the uncentered form. It was
chosen before any measurement, on the double-counting argument, not after
comparing the two results.

## Leak freedom

For a season-Y week-W game, features come only from:

    cur  = SUM over weeks 1..W-1 of season Y        (strictly weeks < W)
    prev = SUM over ALL REG weeks of season Y-1     (finished before kickoff)
    rate = w*rate_cur + (1-w)*rate_prev,  w = cur_games / (cur_games + DVP_N0)

`DVP_N0 = 4`. At week 1 `cur_games == 0`, so `w == 0` and the rate is the
complete prior season — pregame-honest, never a peek at the season being
priced. If the prior season is absent AND `cur_games == 0`, the rate is
UNDEFINED: that team contributes nothing, the game's delta is 0.0, and the
count of such games is recorded in the promotion entry as `n0_games`. Never
imputed.

`z` is standardised within season Y over the identical weeks-<W window. If
fewer than `MIN_DEFENSES_FOR_Z` defenses have a defined rate, or the spread is
degenerate, every z for that (season, week, position) is 0.0.

## Inputs

`data/dvp_positional_history.json`, built by
`scripts/build_dvp_positional.py` from the nflverse `stats_player_week`
release. It covers 1999-2025, i.e. every backtest-corpus season, so the family
is measured on every fold rather than diluted by uncovered ones. It carries no
market column and none exists in its source.

## Application status — HONEST

Nothing in `scripts/build_predictions.py` calls this module, so the family is
NOT in `promote_signals.APPLIABLE`: a winning trial records `would_adopt`, not
an adoption. `delta_from_params` below is the prediction-time reader that a
future wiring change would call; until that change lands, the family is a
measurement only. Do not add `dvp_mismatch` to `APPLIABLE` in any change that
does not also wire this reader in.

Stdlib only, deterministic, no I/O outside the one documented read.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DVP_PATH = os.path.join(_ROOT, "data", "dvp_positional_history.json")

POSITIONS = ("QB", "RB", "WR", "TE")

# Elo per unit of centered positional mismatch. Non-negative: unlike wind or
# divisional familiarity, the direction here is fixed by the hypothesis itself
# (leaning on a position a defense is comparatively bad at should HELP you). A
# signed grid would double the multiplicity bill for a sign that is not in
# question, and a negative adoption would not be a finding, it would be a
# refutation dressed as one. 0.0 is the incumbent and is filtered out by the
# caller, exactly as EPA_SCALES / SKILL_OUT_SCALES are.
DVP_SCALES = [0.0, 100.0, 200.0, 300.0]

DVP_N0 = 4                  # games at which the current season outweighs prior
MIN_DEFENSES_FOR_Z = 24     # below this the z-scores are not a league standard
_MIN_SD = 1e-9


def _blank():
    return {p: 0.0 for p in POSITIONS}


# --------------------------------------------------------------------------- #
# window arithmetic                                                            #
# --------------------------------------------------------------------------- #

def _prev_totals(team_weeks):
    """`(games, {pos: ppr})` summed over ALL weeks of a season, per side.

    Used for the prior season only, which is complete before the season being
    priced kicks off.
    """
    out = {"g": 0, "off": _blank(), "def": _blank()}
    for wk in (team_weeks or {}).values():
        out["g"] += int(wk.get("g") or 0)
        for side in ("off", "def"):
            src = wk.get(side) or {}
            for p in POSITIONS:
                out[side][p] += float(src.get(p) or 0.0)
    return out


def _cumulative_by_week(team_weeks):
    """`{week: totals-strictly-before-week}` for one team-season.

    The `< week` half-open bound is the whole leak barrier, and it is written
    the same way `EpaFeatures._season_sums` writes it: accumulate in ascending
    week order and SNAPSHOT BEFORE folding the current week in.
    """
    acc = {"g": 0, "off": _blank(), "def": _blank()}
    out = {}
    for wk_key in sorted((int(w) for w in (team_weeks or {})), key=int):
        out[wk_key] = {"g": acc["g"],
                       "off": dict(acc["off"]), "def": dict(acc["def"])}
        wk = team_weeks[str(wk_key)] if str(wk_key) in team_weeks else team_weeks[wk_key]
        acc["g"] += int(wk.get("g") or 0)
        for side in ("off", "def"):
            src = wk.get(side) or {}
            for p in POSITIONS:
                acc[side][p] += float(src.get(p) or 0.0)
    return out, acc


def blended_rate(cur, prev, side):
    """Per-game rate for one team, one side, blended toward the prior season.

    Returns `{pos: rate}` or None when neither window carries a game — the
    honest 'undefined', which the caller turns into a 0.0 contribution and a
    counted game rather than an imputed league average.
    """
    cg = int((cur or {}).get("g") or 0)
    pg = int((prev or {}).get("g") or 0)
    if cg <= 0 and pg <= 0:
        return None
    w = cg / float(cg + DVP_N0) if cg > 0 else 0.0
    if pg <= 0:
        w = 1.0                     # no prior season: the current window is all
    out = {}
    for p in POSITIONS:
        rc = (float(cur[side][p]) / cg) if cg > 0 else 0.0
        rp = (float(prev[side][p]) / pg) if pg > 0 else 0.0
        out[p] = w * rc + (1.0 - w) * rp
    return out


def _mean_sd(values):
    n = len(values)
    if n < 2:
        return (values[0] if n else 0.0), 0.0
    m = sum(values) / n
    var = sum((v - m) ** 2 for v in values) / (n - 1)
    return m, var ** 0.5


def tilt_from_rates(def_rates):
    """`{team: {pos: tilt}}` — within-league z, then centered within the team.

    `def_rates` is `{team: {pos: allow_per_game}}` for one (season, week).
    Positions with too few defined defenses, or no spread, contribute z == 0.0
    for every team, so the family is a no-op there rather than an amplifier of
    rounding noise.
    """
    teams = sorted(def_rates)
    z = {t: _blank() for t in teams}
    if len(teams) >= MIN_DEFENSES_FOR_Z:
        for p in POSITIONS:
            vals = [def_rates[t][p] for t in teams]
            m, sd = _mean_sd(vals)
            if sd <= _MIN_SD:
                continue
            for t in teams:
                z[t][p] = (def_rates[t][p] - m) / sd
    out = {}
    for t in teams:
        mu = sum(z[t][p] for p in POSITIONS) / len(POSITIONS)
        out[t] = {p: z[t][p] - mu for p in POSITIONS}
    return out


def lean_from_rates(off_rates):
    """`{team: {pos: lean}}` — within-team production share, centered on the
    league's mean share for that position.

    A team with no offensive production at all (possible only in a degenerate
    window) is dropped rather than given a uniform 1/4 share it did not earn.
    """
    shares = {}
    for t, rates in off_rates.items():
        tot = sum(max(rates[p], 0.0) for p in POSITIONS)
        if tot <= _MIN_SD:
            continue
        shares[t] = {p: max(rates[p], 0.0) / tot for p in POSITIONS}
    if not shares:
        return {}
    league = {p: sum(s[p] for s in shares.values()) / len(shares) for p in POSITIONS}
    return {t: {p: s[p] - league[p] for p in POSITIONS} for t, s in shares.items()}


def edge(lean_row, tilt_row):
    """The interaction for one (offense, defense) pair. Missing either side is
    exactly 0.0 — a no-op, never a guess, never a raise inside a 7,276-game
    walk."""
    if not lean_row or not tilt_row:
        return 0.0
    return sum(lean_row[p] * tilt_row[p] for p in POSITIONS)


# --------------------------------------------------------------------------- #
# feature table                                                                #
# --------------------------------------------------------------------------- #

def build_features(doc, seasons):
    """`{season: {week: {"lean": {...}, "tilt": {...}}}}` for the given seasons.

    Every (season, week) table is built from strictly-pregame information for
    games played in that week, so a single table serves every game in it.
    """
    raw = doc.get("seasons") or {}
    per_season_cum = {}
    per_season_full = {}
    for yr_s, teams in raw.items():
        cums = {}
        fulls = {}
        for team, weeks in teams.items():
            cum, full = _cumulative_by_week(weeks)
            cums[team] = cum
            fulls[team] = full
        per_season_cum[int(yr_s)] = cums
        per_season_full[int(yr_s)] = fulls

    feats = {}
    undefined = 0
    defined = 0
    for yr in seasons:
        cums = per_season_cum.get(yr)
        if not cums:
            continue
        prevs = per_season_full.get(yr - 1) or {}
        weeks = sorted({w for c in cums.values() for w in c})
        by_week = {}
        for wk in weeks:
            off_rates, def_rates = {}, {}
            for team, cum in cums.items():
                if wk not in cum:
                    continue
                prev = prevs.get(team)
                for side, sink in (("off", off_rates), ("def", def_rates)):
                    r = blended_rate(cum[wk], prev, side)
                    if r is None:
                        undefined += 1
                    else:
                        defined += 1
                        sink[team] = r
            by_week[wk] = {"lean": lean_from_rates(off_rates),
                           "tilt": tilt_from_rates(def_rates)}
        feats[yr] = by_week
    return feats, {"team_side_rates_defined": defined,
                   "team_side_rates_undefined": undefined}


def load_features(seasons, path=DVP_PATH):
    """`(features, diagnostics)`, or None when the artifact is unusable.

    Returns None when the file is absent, or when its seasons do not span the
    walk INCLUDING the prior-season seed. Partial coverage is not a smaller
    measurement, it is a corrupted one: uncovered folds score exact ties
    against the incumbent, ties are counted in n and in the cluster-robust
    variance, and the recorded improvement is diluted toward zero. "No data
    here" would be archived as "no help here". Skip loudly instead.
    """
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    raw = doc.get("seasons") or {}
    if not raw:
        return None
    covered = {int(y) for y in raw}
    if not all(y in covered for y in seasons):
        return None
    feats, diag = build_features(doc, list(seasons))
    if not feats:
        return None
    return feats, diag


def coverage_reason(seasons, path=DVP_PATH):
    """Why `load_features` refused, in the words the promotion entry records."""
    if not os.path.exists(path):
        return ("data/dvp_positional_history.json absent — build it with "
                "scripts/build_dvp_positional.py")
    with open(path, encoding="utf-8") as fh:
        covered = {int(y) for y in (json.load(fh).get("seasons") or {})}
    missing = sorted(y for y in seasons if y not in covered)
    return ("data/dvp_positional_history.json does not cover seasons "
            f"{missing} — the uncovered folds would score exact ties and "
            "dilute the measured improvement")


# --------------------------------------------------------------------------- #
# the family                                                                   #
# --------------------------------------------------------------------------- #

def game_delta(feats, season, game, scale):
    """The per-game Elo delta. A game whose week or teams the features do not
    cover is exactly 0.0."""
    tbl = (feats.get(season) or {}).get(int(game.get("week") or 0))
    if not tbl:
        return 0.0
    lean, tilt = tbl["lean"], tbl["tilt"]
    home, away = game["home"], game["away"]
    return float(scale) * (edge(lean.get(home), tilt.get(away))
                           - edge(lean.get(away), tilt.get(home)))


def dvp_builder(scale, feats):
    """`(setup, factory)` — the promote_signals family-builder contract.

    Nothing is fitted from the walk, so `training_residuals` is unused: the
    entire leak surface is the weeks-<W window inside `build_features`, which
    is computed once from the artifact and never touches an outcome.
    """
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            return game_delta(feats, season, g, scale)
        return fn
    return setup, factory


def n0_games(feats, seasons, finals_by_year):
    """How many scored games the family priced at exactly 0.0 for want of a
    defined rate. Recorded in the adoption block so a family that 'helped' on
    a third of the corpus can never look like one that helped on all of it."""
    n = 0
    for yr in seasons:
        for g in finals_by_year.get(yr) or []:
            if game_delta(feats, yr, g, 1.0) == 0.0:
                n += 1
    return n


def adoption_block(best, now, zeros=None):
    """The `game_params.dvp_hfa` record written when the family is adopted."""
    blk = {"applied": True,
           "scale": best["scale"],
           "n0": DVP_N0,
           "min_defenses_for_z": MIN_DEFENSES_FOR_Z,
           "adopted_utc": now}
    if zeros is not None:
        blk["n0_games"] = int(zeros)
    return blk


def delta_from_params(params, season, game, feats):
    """PREDICTION-TIME reader. Nothing calls this yet — see the module
    docstring. It exists so the wiring change is a one-line call rather than a
    reimplementation, and so the family's `APPLIABLE` status is a statement
    about `build_predictions.py`, not about this module."""
    blk = params.get("dvp_hfa") or {}
    if not blk.get("applied"):
        return 0.0
    return game_delta(feats, season, game, float(blk.get("scale") or 0.0))


# --------------------------------------------------------------------------- #

def _fixture_doc():
    """A four-team, two-season synthetic artifact with hand-checkable numbers.

    Season 2098 is the prior season; 2099 is priced. AAA's offense is pure WR,
    BBB's is pure RB. DDD's defense is leaky vs WR and stingy vs RB; CCC's is
    the mirror image.
    """
    def wk(g, off, dfn):
        return {"g": g,
                "off": {p: off.get(p, 0.0) for p in POSITIONS},
                "def": {p: dfn.get(p, 0.0) for p in POSITIONS}}
    prior = {}
    for t, off, dfn in (
        ("AAA", {"WR": 30.0, "RB": 10.0}, {"WR": 20.0, "RB": 20.0}),
        ("BBB", {"WR": 10.0, "RB": 30.0}, {"WR": 20.0, "RB": 20.0}),
        ("CCC", {"WR": 20.0, "RB": 20.0}, {"WR": 10.0, "RB": 30.0}),
        ("DDD", {"WR": 20.0, "RB": 20.0}, {"WR": 30.0, "RB": 10.0}),
    ):
        prior[t] = {"1": wk(1, off, dfn), "2": wk(1, off, dfn)}
    cur = {t: {"1": wk(1, {"WR": 20.0, "RB": 20.0}, {"WR": 20.0, "RB": 20.0}),
               "2": wk(1, {"WR": 20.0, "RB": 20.0}, {"WR": 20.0, "RB": 20.0})}
           for t in prior}
    return {"seasons": {"2098": prior, "2099": cur}}


def selftest():
    """Family math on hand-computed values — asserts, never touches data/."""
    # --- blended_rate: the leak rule, stated as arithmetic --------------------
    cur = {"g": 0, "off": _blank(), "def": _blank()}
    prev = {"g": 2, "off": _blank(), "def": {"QB": 40.0, "RB": 20.0,
                                             "WR": 60.0, "TE": 10.0}}
    r = blended_rate(cur, prev, "def")
    # Week 1: cur_games == 0 => w == 0 => the rate IS the complete prior season.
    assert r == {"QB": 20.0, "RB": 10.0, "WR": 30.0, "TE": 5.0}, r
    cur4 = {"g": 4, "off": _blank(), "def": {"QB": 0.0, "RB": 0.0,
                                             "WR": 0.0, "TE": 0.0}}
    r4 = blended_rate(cur4, prev, "def")
    # 4 games in: w = 4/(4+4) = 0.5, so exactly half the prior rate.
    assert abs(r4["WR"] - 15.0) < 1e-9, r4
    # No prior season and no current games -> UNDEFINED, never imputed.
    assert blended_rate({"g": 0, "off": _blank(), "def": _blank()},
                        {"g": 0, "off": _blank(), "def": _blank()}, "def") is None
    # No prior season but games in hand -> the current window is the whole rate.
    r_nop = blended_rate({"g": 2, "off": _blank(),
                          "def": {"QB": 0.0, "RB": 0.0, "WR": 30.0, "TE": 0.0}},
                         None, "def")
    assert abs(r_nop["WR"] - 15.0) < 1e-9, r_nop

    # --- the half-open week bound --------------------------------------------
    weeks = {"1": {"g": 1, "off": {"WR": 10.0}, "def": {"WR": 100.0}},
             "2": {"g": 1, "off": {"WR": 10.0}, "def": {"WR": 0.0}},
             "3": {"g": 1, "off": {"WR": 10.0}, "def": {"WR": 0.0}}}
    for w in weeks.values():
        w["off"] = {p: w["off"].get(p, 0.0) for p in POSITIONS}
        w["def"] = {p: w["def"].get(p, 0.0) for p in POSITIONS}
    cum, full = _cumulative_by_week(weeks)
    assert cum[1]["g"] == 0 and cum[1]["def"]["WR"] == 0.0, cum[1]
    # Week 2's window EXCLUDES week 2 and INCLUDES week 1's 100-point outlier.
    assert cum[2]["g"] == 1 and cum[2]["def"]["WR"] == 100.0, cum[2]
    assert cum[3]["g"] == 2 and cum[3]["def"]["WR"] == 100.0, cum[3]
    assert full["g"] == 3 and full["def"]["WR"] == 100.0, full

    # --- centering: the whole reason this family is not epa_total ------------
    # A uniformly leaky defense (bad at everything, which Elo already knows)
    # has ZERO tilt. Only the shape survives.
    uniform = {f"T{i:02d}": {"QB": 10.0 + i, "RB": 10.0 + i,
                             "WR": 10.0 + i, "TE": 10.0 + i} for i in range(32)}
    tl = tilt_from_rates(uniform)
    for t in tl:
        for p in POSITIONS:
            assert abs(tl[t][p]) < 1e-9, (t, p, tl[t])
    # A league-average-shaped offense has ZERO lean.
    ln = lean_from_rates({f"T{i:02d}": {"QB": 4.0, "RB": 3.0, "WR": 2.0,
                                        "TE": 1.0} for i in range(32)})
    for t in ln:
        for p in POSITIONS:
            assert abs(ln[t][p]) < 1e-9, (t, p, ln[t])
    # Both centered vectors sum to ~0 across positions, always.
    shaped = dict(uniform)
    shaped["T00"] = {"QB": 10.0, "RB": 30.0, "WR": 5.0, "TE": 10.0}
    tl2 = tilt_from_rates(shaped)
    for t, row in tl2.items():
        assert abs(sum(row.values())) < 1e-9, (t, row)
    # The shaped defense is leaky vs RB and stingy vs WR, in that order.
    assert tl2["T00"]["RB"] > 0 > tl2["T00"]["WR"], tl2["T00"]

    # --- too few defenses, or no spread, is a no-op not an amplifier ---------
    tiny = {f"T{i:02d}": {"QB": 1.0 * i, "RB": 2.0, "WR": 3.0, "TE": 4.0}
            for i in range(MIN_DEFENSES_FOR_Z - 1)}
    for row in tilt_from_rates(tiny).values():
        assert all(abs(v) < 1e-9 for v in row.values()), row
    flat = {f"T{i:02d}": {"QB": 5.0, "RB": 5.0, "WR": 5.0, "TE": 5.0}
            for i in range(32)}
    for row in tilt_from_rates(flat).values():
        assert all(abs(v) < 1e-9 for v in row.values()), row
    # An offense with zero production is dropped, not handed a uniform share.
    assert lean_from_rates({"X": {p: 0.0 for p in POSITIONS}}) == {}

    # --- edge and the delta ---------------------------------------------------
    lean_row = {"QB": 0.0, "RB": -0.10, "WR": 0.10, "TE": 0.0}
    tilt_row = {"QB": 0.0, "RB": -0.50, "WR": 0.50, "TE": 0.0}
    assert abs(edge(lean_row, tilt_row) - 0.10) < 1e-12, edge(lean_row, tilt_row)
    # A missing side of the join is EXACTLY zero, never a raise.
    assert edge(None, tilt_row) == 0.0 and edge(lean_row, None) == 0.0
    feats = {2099: {5: {"lean": {"H": lean_row, "A": {p: 0.0 for p in POSITIONS}},
                        "tilt": {"H": {p: 0.0 for p in POSITIONS},
                                 "A": tilt_row}}}}
    g = {"home": "H", "away": "A", "week": 5}
    # home leans WR into a WR-leaky defense (+0.10); away is shapeless (0).
    assert abs(game_delta(feats, 2099, g, 200.0) - 20.0) < 1e-9
    # ANTISYMMETRY: swapping the teams must negate the delta exactly, or the
    # family is a home-field term wearing a matchup costume.
    swapped = {"home": "A", "away": "H", "week": 5}
    assert abs(game_delta(feats, 2099, swapped, 200.0) + 20.0) < 1e-9
    # Uncovered week, uncovered season, unknown team -> exact 0.0, no raise.
    assert game_delta(feats, 2099, {"home": "H", "away": "A", "week": 9}, 200.0) == 0.0
    assert game_delta(feats, 2100, g, 200.0) == 0.0
    assert game_delta(feats, 2099, {"home": "Z", "away": "A", "week": 5}, 200.0) == 0.0
    # scale 0 is the incumbent, exactly.
    assert game_delta(feats, 2099, g, 0.0) == 0.0

    # --- builder contract ------------------------------------------------------
    setup, factory = dvp_builder(200.0, feats)
    fn = factory(setup(2099, [], []))
    assert abs(fn(g, 0) - 20.0) < 1e-9

    # --- the grid --------------------------------------------------------------
    assert DVP_SCALES[0] == 0.0 and len(DVP_SCALES) == 4
    assert DVP_SCALES == sorted(DVP_SCALES)
    assert all(s >= 0.0 for s in DVP_SCALES)
    assert len([s for s in DVP_SCALES if s]) == 3      # live trials

    # --- end to end on the synthetic artifact ---------------------------------
    doc = _fixture_doc()
    f2, diag = build_features(doc, [2099])
    # Only 4 teams, so the z stage is deliberately inert (< MIN_DEFENSES_FOR_Z)
    # and every tilt is 0 -> the delta is 0. That is the guard doing its job on
    # a small league, and it must be visible rather than assumed away.
    assert diag["team_side_rates_undefined"] == 0, diag
    for wkrow in f2[2099].values():
        for row in wkrow["tilt"].values():
            assert all(abs(v) < 1e-9 for v in row.values()), row
    assert abs(game_delta(f2, 2099, {"home": "AAA", "away": "DDD",
                                     "week": 1}, 300.0)) < 1e-9
    # The LEAN half is live even in a 4-team league: AAA is WR-heavy.
    assert f2[2099][1]["lean"]["AAA"]["WR"] > 0 > f2[2099][1]["lean"]["AAA"]["RB"]

    # --- loader: absent / unspanned -> None, never a partial map --------------
    assert load_features([2099], path=os.path.join(_ROOT, "no_such.json")) is None
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "dvp.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        assert load_features([2099], path=p) is not None
        assert load_features([2097, 2098, 2099], path=p) is None   # 2097 uncovered
        assert "2097" in coverage_reason([2097, 2099], path=p)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"seasons": {}}, fh)
        assert load_features([2099], path=p) is None
    assert "absent" in coverage_reason([2099],
                                       path=os.path.join(_ROOT, "no_such.json"))

    # --- adoption block --------------------------------------------------------
    blk = adoption_block({"scale": 200.0}, "2026-01-01T00:00:00Z", zeros=17)
    assert blk == {"applied": True, "scale": 200.0, "n0": DVP_N0,
                   "min_defenses_for_z": MIN_DEFENSES_FOR_Z,
                   "adopted_utc": "2026-01-01T00:00:00Z", "n0_games": 17}, blk
    # The prediction-time reader is inert until a params block says otherwise.
    assert delta_from_params({}, 2099, g, feats) == 0.0
    assert delta_from_params({"dvp_hfa": {"applied": False, "scale": 200.0}},
                             2099, g, feats) == 0.0
    assert abs(delta_from_params({"dvp_hfa": {"applied": True, "scale": 200.0}},
                                 2099, g, feats) - 20.0) < 1e-9

    print("selftest OK: blend is prior-season-only at week 1 and half-and-half "
          "at 4 games, undefined never imputed, weeks-<W bound proven on an "
          "outlier, centering kills uniform defenses and average offenses, "
          "z guard inert below 24 defenses, delta antisymmetric, missing joins "
          "exact 0.0, span-or-skip loader")
    return True


if __name__ == "__main__":
    selftest()
