"""`scheme_matchup` — the game-level candidate family for FTN charting scheme,
shipped with its APPLICATION PATH DARK.

## THE HEADLINE: THIS FAMILY CANNOT BE APPLIED TO THE LIVE SEASON

FTN charting exists for 2022-2025. There is no 2026 release — the URL 404s, and
`scripts/build_scheme_history.py` PROBES that at build time and records the
answer in `data/scheme_history.json.application`:

    {"live_season": 2026, "applied": false, "dark": true, "http_status": 404,
     "reason": "...", "checked_utc": "..."}

So this family may be MEASURED on the backtest corpus and it may NOT be applied
to a live game. Two independent mechanisms enforce that, because one is a
comment and two is a design:

1. `scheme_matchup` is deliberately absent from `promote_signals.APPLIABLE`.
   A winning trial therefore records `would_adopt`, not an adoption — the
   existing honesty guard, same as `dvp_mismatch` and `coach_regime`.
2. `delta_from_params` and `scheme_current` RAISE `SchemeDark` when asked to
   price a season the artifact has no charting for. They do NOT return 0.0.

Point 2 is the one that matters and it is the reason this module exists in the
shape it does. A family that quietly returns a neutral delta for 2026 produces
exactly the same predictions, logs and dashboards as a family that is working
perfectly and finding nothing. Those two states must never be confusable. Inside
the backtest walk an uncovered season IS priced 0.0 — that is a measurement
choice, it is counted, and it is reported (see `coverage_block`). At prediction
time it is an error, because there is nobody to read the count.

## What it prices

    off_agg[T]  = mean of z(pa/off_plays), z(screen/off_plays),
                  z(motion/off_plays), z(no_huddle/off_plays)
    def_box[D]  = z(box_sum / box_plays)
    edge(T, D)  = off_agg[T] * def_box[D]
    delta(g)    = scale * (edge(home, away) - edge(away, home))

An offense that leans on misdirection — play-action, screens, motion, tempo —
against a defense that plays an unusually heavy, downhill box. Both halves are
z-scores within the season, so a team that is merely good at everything scores
zero on both and the family cannot re-price overall strength, which Elo and
`epa_total` already carry. The delta is antisymmetric under swapping the teams
by construction; the selftest pins that, because a matchup term that survives
the swap is a home-field term in a costume.

### MEAN of the four z's, not the SUM (a deliberate departure)

TECH_DESIGN §5.3 writes `off_agg = z + z + z + z` and then argues the grid
`SCHEME_SCALES = [0, 40, 80, 120]` spans "roughly +/-0-360 Elo at the extreme"
because "the product of two z-scores is O(1) and rarely exceeds +/-3". Those two
sentences are inconsistent: a SUM of four z's has sd near 2, so its product with
another z reaches +/-10 and the top of the grid would be worth 1,200 Elo — a
number that is not a rating adjustment, it is a coin flip forced to 0 or 1.
The magnitude claim is the load-bearing one (it is what makes the grid
comparable to `epa_total`'s reach), so the mean is used and the grid is kept.
Measured on the corpus the delta's sd is small and its extreme sits inside the
design's stated range; the empirical distribution is recorded in the family's
`delta_stats` diagnostic rather than asserted.

## Leak freedom

For a season-Y week-W game the features come only from

    cur  = SUM over REG weeks 1..W-1 of season Y     (strictly weeks < W)
    prev = SUM over ALL REG weeks of season Y-1      (finished before kickoff)
    rate = w*rate_cur + (1-w)*rate_prev,  w = cur_plays / (cur_plays + SCHEME_N0)

`SCHEME_N0 = 400` charted plays — about six games' worth of one side of the
ball, so the current season takes over around the mid-point of a season, the
same shape `EpaFeatures` uses. At week 1 `cur_plays == 0`, so `w == 0` and the
rate IS the complete prior season. With no prior season and no plays in hand the
rate is UNDEFINED: that team contributes nothing, the game's delta is exactly
0.0, and the count is recorded. Never imputed.

Postseason games are still priced — week 19 simply reads the complete weeks-1-18
window. Postseason PLAYS are excluded from the sums by the builder (only good
teams play in January, so including it would make a prior-season rate a
survivorship-biased description of a team).

## Coverage, and why the measured improvement is diluted

The corpus walks 1999-2025 (26 evaluated folds). FTN covers 2022-2025, so:

  * 2022 is priced from the CURRENT season only (2021 has no charting at all),
    which means week 1 of 2022 is unpriced and the early weeks are thin.
  * 2023-2025 are priced with a full prior season behind them.
  * The other 22 folds are priced at exactly 0.0 for every game.

A zero on an uncovered fold is NOT a claim that scheme does not matter there; it
is a claim that we do not know. But the gate's statistic is the mean paired
per-game log-loss difference over all folds, so those 22 zero folds pull the
reported improvement toward zero and shrink the between-fold spread. The family
is therefore structurally disadvantaged against the same threshold every other
family faces, and that is accepted rather than corrected for — a per-family
threshold tuned to a family's own coverage is not a never-regress gate. What is
required instead is that the dilution be VISIBLE: `coverage_block` records the
covered and dark seasons, the count of games actually priced, and the count of
folds that are entirely dark, and that block is attached to the family's entry.

**Pre-committed expectation: `scheme_matchup` may legitimately never be
adopted.** Success is "the family runs, is honest about its coverage, and the
trials are archived", not "the family adopts".

## Input

`data/scheme_history.json`, built by `scripts/build_scheme_history.py` from the
nflverse FTN charting release joined to play-by-play on
`(nflverse_game_id, nflverse_play_id)` — the FTN file carries no team column, so
the join is not optional. Attribution (`FTN Data via nflverse`, CC-BY-SA 4.0) is
carried in the artifact and must be rendered FROM it, never as a literal.

MARKET BOUNDARY: this module reads a play-charting artifact. It never reads,
derives or writes a spread, total or moneyline; none exist in the source.

Stdlib only, deterministic, no I/O outside the one documented read.
"""

import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

SCHEME_PATH = os.path.join(_ROOT, "data", "scheme_history.json")

# Elo per unit of scheme mismatch. Non-negative: the hypothesis fixes the sign
# (misdirection into a heavy box should HELP the offense running it), so a
# signed grid would double the multiplicity bill for a sign that is not in
# question. 0.0 is the incumbent and is filtered out by the caller, exactly as
# EPA_SCALES and DVP_SCALES are.
SCHEME_SCALES = [0.0, 40.0, 80.0, 120.0]

SCHEME_N0 = 400             # charted plays at which the current season outweighs prior
MIN_TEAMS_FOR_Z = 24        # below this the z-scores are not a league standard
MAX_WEEK = 22               # 18 REG + 4 postseason rounds
_MIN_SD = 1e-9

# (numerator key, denominator key) for each offensive tendency rate.
OFF_RATES = (("pa", "off_plays"), ("screen", "off_plays"),
             ("motion", "off_plays"), ("no_huddle", "off_plays"))
DEF_RATE = ("box_sum", "box_plays")


class SchemeDark(RuntimeError):
    """Raised when the application path is asked to price a season with no FTN
    charting. Deliberately NOT a return value of 0.0 — see the module docstring.
    """


# --------------------------------------------------------------------------- #
# window arithmetic                                                            #
# --------------------------------------------------------------------------- #

def _sum_weeks(weeks, keys, before_week=None):
    """Sum the given keys over a team's weeks, optionally strictly before W."""
    out = {k: 0 for k in keys}
    for wk, row in weeks.items():
        if before_week is not None and int(wk) >= int(before_week):
            continue
        for k in keys:
            out[k] += row.get(k, 0)
    return out


_ALL_KEYS = ("off_plays", "pa", "screen", "motion", "no_huddle",
             "def_plays", "box_sum", "box_plays")


def blended_rates(cur, prev):
    """`(off_rates, def_rate)` for one team, blending the weeks-<W window with
    the complete prior season.

    Each returns None when neither window has a play to divide by — UNDEFINED,
    never zero. Offense and defense are blended independently because a team can
    have charted plays on one side and not the other in a thin window.
    """
    def blend(num_key, den_key):
        cur_den = cur.get(den_key, 0)
        prev_den = (prev or {}).get(den_key, 0)
        if cur_den <= 0 and prev_den <= 0:
            return None
        w = cur_den / float(cur_den + SCHEME_N0) if cur_den > 0 else 0.0
        if prev_den <= 0:
            w = 1.0                      # nothing to blend toward
        cur_rate = (cur[num_key] / float(cur_den)) if cur_den > 0 else 0.0
        prev_rate = (prev[num_key] / float(prev_den)) if prev_den > 0 else 0.0
        return w * cur_rate + (1.0 - w) * prev_rate

    off = {}
    for num_key, den_key in OFF_RATES:
        r = blend(num_key, den_key)
        if r is None:
            off = None
            break
        off[num_key] = r
    dfn = blend(*DEF_RATE)
    return off, dfn


# --------------------------------------------------------------------------- #
# standardisation                                                              #
# --------------------------------------------------------------------------- #

def _z_map(values):
    """`{team: z}` over a `{team: value}` map. All zeros when there are too few
    teams to define a league standard, or when the spread is degenerate — a
    guard that is inert rather than an amplifier."""
    if len(values) < MIN_TEAMS_FOR_Z:
        return {t: 0.0 for t in values}
    mean = sum(values.values()) / len(values)
    var = sum((v - mean) ** 2 for v in values.values()) / len(values)
    sd = math.sqrt(var)
    if sd < _MIN_SD:
        return {t: 0.0 for t in values}
    return {t: (v - mean) / sd for t, v in values.items()}


def off_agg_from_rates(off_rates_by_team):
    """`{team: off_agg}` — the MEAN of the four standardised tendency rates.

    Mean, not sum: see the module docstring. The mean keeps `off_agg` O(1) so
    the product with `def_box` stays inside the magnitude the SCHEME_SCALES grid
    was sized for.
    """
    if not off_rates_by_team:
        return {}
    zs = {}
    for num_key, _den in OFF_RATES:
        zs[num_key] = _z_map({t: r[num_key] for t, r in off_rates_by_team.items()})
    n = float(len(OFF_RATES))
    return {t: sum(zs[num_key][t] for num_key, _d in OFF_RATES) / n
            for t in off_rates_by_team}


def def_box_from_rates(def_rate_by_team):
    """`{team: def_box}` — the standardised mean defenders-in-the-box."""
    return _z_map(dict(def_rate_by_team))


def edge(off_agg, def_box):
    """The interaction. A missing side of the join is EXACTLY zero, never a
    raise inside a 7,276-game walk."""
    if off_agg is None or def_box is None:
        return 0.0
    return float(off_agg) * float(def_box)


# --------------------------------------------------------------------------- #
# feature build                                                                #
# --------------------------------------------------------------------------- #

def build_features(doc, seasons):
    """`(features, diagnostics)`.

    features[season][week] = {"off": {team: off_agg}, "box": {team: def_box}}

    Only seasons the artifact actually covers appear. A season absent from
    `features` is priced at exactly 0.0 by `game_delta`, and the caller records
    that in the coverage block — it is never filled in.
    """
    raw = doc.get("seasons") or {}
    per_season = {int(y): v for y, v in raw.items()}

    feats = {}
    diag = {"team_weeks_defined": 0, "team_weeks_undefined": 0,
            "seasons_with_prior": [], "seasons_without_prior": []}
    for yr in seasons:
        teams = per_season.get(yr)
        if not teams:
            continue
        prev_teams = per_season.get(yr - 1) or {}
        prevs = {t: _sum_weeks(w, _ALL_KEYS) for t, w in prev_teams.items()}
        (diag["seasons_with_prior"] if prevs
         else diag["seasons_without_prior"]).append(yr)

        by_week = {}
        for wk in range(1, MAX_WEEK + 1):
            off_rates, def_rates = {}, {}
            for team, weeks in teams.items():
                cur = _sum_weeks(weeks, _ALL_KEYS, before_week=wk)
                off, dfn = blended_rates(cur, prevs.get(team))
                if off is None and dfn is None:
                    diag["team_weeks_undefined"] += 1
                    continue
                diag["team_weeks_defined"] += 1
                if off is not None:
                    off_rates[team] = off
                if dfn is not None:
                    def_rates[team] = dfn
            by_week[wk] = {"off": off_agg_from_rates(off_rates),
                           "box": def_box_from_rates(def_rates)}
        feats[yr] = by_week
    return feats, diag


def load_doc(path=SCHEME_PATH):
    """The raw artifact, or None when it is absent."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_features(seasons, path=SCHEME_PATH):
    """`(features, diagnostics, doc)`, or None when the artifact is unusable.

    UNLIKE `dvp_mismatch.load_features`, partial season coverage is NOT a
    refusal here. `dvp_positional_history.json` covers every corpus season, so
    a gap in it is a corruption; FTN charting starts in 2022 and a gap is the
    permanent, expected state of this feed. Refusing to run would mean the
    family is never measured at all. Running it means the measurement is
    diluted, which `coverage_block` states in the record.

    None is returned only when the file is absent or carries no seasons at all.
    """
    doc = load_doc(path)
    if not doc:
        return None
    if not (doc.get("seasons") or {}):
        return None
    feats, diag = build_features(doc, list(seasons))
    if not feats:
        return None
    return feats, diag, doc


def coverage_reason(seasons, path=SCHEME_PATH):
    """Why `load_features` refused, in the words the promotion entry records."""
    if not os.path.exists(path):
        return ("data/scheme_history.json absent — build it with "
                "scripts/build_scheme_history.py")
    doc = load_doc(path) or {}
    covered = sorted(int(y) for y in (doc.get("seasons") or {}))
    if not covered:
        return ("data/scheme_history.json carries no seasons — the FTN join "
                "produced nothing, so there is no scheme feature to trial")
    return ("data/scheme_history.json covers " + str(covered) + " but none of "
            f"the walk seasons {seasons[0]}-{seasons[-1]} intersect it")


# --------------------------------------------------------------------------- #
# the family                                                                   #
# --------------------------------------------------------------------------- #

def game_delta(feats, season, game, scale):
    """The per-game Elo delta. A game in a season or week the features do not
    cover is exactly 0.0 — inside the walk that is a counted measurement
    choice, not an application. See `delta_from_params` for the rule at
    prediction time."""
    tbl = (feats.get(season) or {}).get(int(game.get("week") or 0))
    if not tbl:
        return 0.0
    off, box = tbl["off"], tbl["box"]
    home, away = game["home"], game["away"]
    return float(scale) * (edge(off.get(home), box.get(away))
                           - edge(off.get(away), box.get(home)))


def scheme_builder(scale, feats):
    """`(setup, factory)` — the promote_signals family-builder contract.

    Nothing is fitted from the walk, so `training_residuals` is unused: the
    entire leak surface is the weeks-<W window inside `build_features`, which is
    computed once from the artifact and never touches an outcome.
    """
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            return game_delta(feats, season, g, scale)
        return fn
    return setup, factory


# --------------------------------------------------------------------------- #
# coverage — the honesty surface                                               #
# --------------------------------------------------------------------------- #

def coverage_block(feats, eval_seasons, finals_by_year, doc=None):
    """The `coverage` record attached to the family's promotion entry.

    Everything a reader needs to stop mistaking a diluted measurement for a
    complete one: which folds had charting, how many games were actually
    priced, how many folds were entirely dark, and what the delta distribution
    looked like where the family did fire.
    """
    with_ftn, dark = [], []
    priced = unpriced = 0
    deltas = []
    for yr in eval_seasons:
        yr_priced = 0
        for g in finals_by_year.get(yr) or []:
            d = game_delta(feats, yr, g, 1.0)
            if d == 0.0:
                unpriced += 1
            else:
                yr_priced += 1
                deltas.append(d)
        priced += yr_priced
        (with_ftn if yr_priced else dark).append(yr)

    block = {
        "seasons_with_ftn": with_ftn,
        "seasons_dark": dark,
        "eval_folds": len(eval_seasons),
        "folds_dark": len(dark),
        "games_priced": priced,
        "games_unpriced": unpriced,
        "note": ("a 0.0 delta on a dark season is NOT a claim that scheme does "
                 "not matter there, it is a claim that FTN charting does not "
                 "exist there; those folds are still counted in the paired "
                 "statistic, so the reported improvement is DILUTED by roughly "
                 "the priced share of games"),
    }
    if deltas:
        n = float(len(deltas))
        mean = sum(deltas) / n
        var = sum((d - mean) ** 2 for d in deltas) / n
        block["delta_stats"] = {
            "unit": "elo per unit scale (multiply by the trial's scale)",
            "n": len(deltas),
            "mean": round(mean, 6),
            "sd": round(math.sqrt(var), 6),
            "min": round(min(deltas), 6),
            "max": round(max(deltas), 6),
        }
    if doc is not None:
        block["attribution"] = doc.get("attribution")
        block["license"] = doc.get("license")
        block["application"] = doc.get("application")
    return block


# --------------------------------------------------------------------------- #
# APPLICATION PATH — dark, loudly                                              #
# --------------------------------------------------------------------------- #

def is_dark(season, feats=None, doc=None):
    """True when `season` has no FTN charting behind it.

    A season is dark when the features carry nothing for it. The artifact's own
    `application` block is consulted too, so a build that probed the live season
    and got a 404 keeps that answer even if a future caller hands in features
    built for a different season set.
    """
    if feats is not None and int(season) in feats:
        return False
    app = (doc or {}).get("application") or {}
    if app.get("live_season") == int(season):
        return bool(app.get("dark", True))
    return True


def dark_reason(season, doc=None):
    """The sentence recorded or raised when a dark season is asked for."""
    app = (doc or {}).get("application") or {}
    if app.get("live_season") == int(season) and app.get("reason"):
        return str(app["reason"])
    return (f"FTN charting has no data for season {int(season)}, so "
            "scheme_matchup cannot be applied to it. Refusing to return a "
            "neutral 0.0: a family that silently no-ops is indistinguishable "
            "from one that is working. Rebuild data/scheme_history.json with "
            "scripts/build_scheme_history.py once FTN publishes the season.")


def scheme_current(season, path=SCHEME_PATH):
    """PREDICTION-TIME input loader. Returns the per-week feature table for
    `season`, or RAISES `SchemeDark`.

    This is the function a live pipeline would call. It has no success path
    for a season without charting, by design.
    """
    doc = load_doc(path)
    if not doc:
        raise SchemeDark("data/scheme_history.json absent — scheme_matchup has "
                         "no input at all; build it with "
                         "scripts/build_scheme_history.py")
    feats, _diag = build_features(doc, [int(season)])
    if is_dark(season, feats, doc):
        raise SchemeDark(dark_reason(season, doc))
    return feats[int(season)]


def adoption_block(best, now, coverage=None, application=None):
    """The `game_params.scheme_hfa` record a future adoption would write.

    `applied` is FALSE whenever the live season is dark, regardless of what the
    trial measured. Adoption of a backtest result is not permission to price a
    season whose input does not exist.
    """
    dark = bool((application or {}).get("dark", True))
    blk = {
        "applied": not dark,
        "dark": dark,
        "scale": best["scale"],
        "n0_plays": SCHEME_N0,
        "min_teams_for_z": MIN_TEAMS_FOR_Z,
        "attribution": "FTN Data via nflverse",
        "license": "CC-BY-SA 4.0",
        "adopted_utc": now,
    }
    if application is not None:
        blk["application"] = application
        blk["reason"] = application.get("reason")
    if coverage is not None:
        blk["coverage"] = coverage
    return blk


def delta_from_params(params, season, game, feats, doc=None):
    """PREDICTION-TIME reader. Nothing calls this yet — `scheme_matchup` is
    absent from `promote_signals.APPLIABLE` precisely because nothing in
    `scripts/build_predictions.py` calls it.

    An inert params block returns 0.0. An ACTIVE params block pointed at a dark
    season RAISES: at prediction time there is no record to carry the caveat, so
    the only honest output is a refusal.
    """
    blk = params.get("scheme_hfa") or {}
    if not blk.get("applied"):
        return 0.0
    if is_dark(season, feats, doc):
        raise SchemeDark(dark_reason(season, doc))
    return game_delta(feats, season, game, float(blk.get("scale") or 0.0))


# --------------------------------------------------------------------------- #

def _fixture_doc():
    """A 26-team, two-season synthetic artifact with hand-checkable numbers.

    26 >= MIN_TEAMS_FOR_Z so the z stage is LIVE (unlike the dvp fixture, where
    a 4-team league leaves it inert). The four interesting teams are DISJOINT
    across the two axes, which is what makes the interaction checkable:

        T00  misdirection offense, league-average box   -> off +a, box  0
        T01  plodding offense,     league-average box   -> off -a, box  0
        T02  league-average offense, lightest box       -> off  0, box -b
        T03  league-average offense, heaviest box       -> off  0, box +b
        rest exactly league-average on both axes        -> off  0, box  0

    Each axis is an exact mirror pair inside a field of averages, so the league
    means are exact and every other team's z is exactly 0.0. T00-vs-T03 is then
    the family's strongest matchup (+a*b) and T00-vs-T01 is exactly 0.0, which
    is the point: this family needs a tendency AND a box, not either alone.
    """
    def week(off_plays, pa, screen, motion, no_huddle, def_plays, box):
        return {"off_plays": off_plays, "pa": pa, "screen": screen,
                "motion": motion, "no_huddle": no_huddle,
                "def_plays": def_plays, "box_sum": box * def_plays,
                "box_plays": def_plays}

    season = {}
    for i in range(26):
        t = "T%02d" % i
        if i == 0:
            row = week(500, 150, 50, 300, 50, 500, 6.5)     # misdirection
        elif i == 1:
            row = week(500, 50, 10, 100, 10, 500, 6.5)      # plodding
        elif i == 2:
            row = week(500, 100, 30, 200, 30, 500, 6.0)     # lightest box
        elif i == 3:
            row = week(500, 100, 30, 200, 30, 500, 7.0)     # heaviest box
        else:
            row = week(500, 100, 30, 200, 30, 500, 6.5)     # league average
        season[t] = {"1": row, "2": dict(row)}
    return {"seasons": {"2098": season, "2099": {t: {"1": dict(v["1"])}
                                                 for t, v in season.items()}},
            "attribution": "FTN Data via nflverse",
            "license": "CC-BY-SA 4.0",
            "application": {"live_season": 2100, "applied": False, "dark": True,
                            "http_status": 404,
                            "reason": "no 2100 FTN release (test fixture)"}}


def selftest():
    """Family math on hand-computed values — asserts, never touches data/."""
    # --- the blend: the leak rule, stated as arithmetic ----------------------
    prev = {"off_plays": 1000, "pa": 300, "screen": 100, "motion": 400,
            "no_huddle": 100, "def_plays": 1000, "box_sum": 6500,
            "box_plays": 1000}
    empty = {k: 0 for k in _ALL_KEYS}
    off, box = blended_rates(empty, prev)
    # Week 1: cur_plays == 0 => w == 0 => the rate IS the complete prior season.
    assert abs(off["pa"] - 0.3) < 1e-12, off
    assert abs(box - 6.5) < 1e-12, box
    # SCHEME_N0 plays in hand => w = 400/800 = 0.5 => exactly half and half.
    cur = {k: 0 for k in _ALL_KEYS}
    cur.update({"off_plays": SCHEME_N0, "pa": SCHEME_N0,
                "def_plays": SCHEME_N0, "box_plays": SCHEME_N0,
                "box_sum": int(8.5 * SCHEME_N0)})
    off2, box2 = blended_rates(cur, prev)
    assert abs(off2["pa"] - (0.5 * 1.0 + 0.5 * 0.3)) < 1e-12, off2
    assert abs(box2 - (0.5 * 8.5 + 0.5 * 6.5)) < 1e-12, box2
    # No prior and no plays -> UNDEFINED on both sides, never imputed.
    assert blended_rates(empty, None) == (None, None)
    # No prior but plays in hand -> the current window is the whole rate.
    off3, box3 = blended_rates(cur, None)
    assert abs(off3["pa"] - 1.0) < 1e-12 and abs(box3 - 8.5) < 1e-12
    # Offense charted, defense not: the two sides blend INDEPENDENTLY.
    half = {k: 0 for k in _ALL_KEYS}
    half.update({"off_plays": 100, "pa": 50})
    off4, box4 = blended_rates(half, None)
    assert off4 is not None and abs(off4["pa"] - 0.5) < 1e-12, off4
    assert box4 is None, box4

    # --- the half-open week bound -------------------------------------------
    weeks = {"1": {"off_plays": 10, "pa": 10}, "2": {"off_plays": 10, "pa": 0},
             "3": {"off_plays": 10, "pa": 0}}
    assert _sum_weeks(weeks, ("off_plays", "pa"), before_week=1) == {"off_plays": 0, "pa": 0}
    # Week 2's window EXCLUDES week 2 and INCLUDES week 1's all-play-action game.
    assert _sum_weeks(weeks, ("off_plays", "pa"), before_week=2) == {"off_plays": 10, "pa": 10}
    assert _sum_weeks(weeks, ("off_plays", "pa"), before_week=3) == {"off_plays": 20, "pa": 10}
    assert _sum_weeks(weeks, ("off_plays", "pa")) == {"off_plays": 30, "pa": 10}
    # Week ordering is NUMERIC, so week 10 is inside week 11's window.
    wide = {"9": {"off_plays": 1}, "10": {"off_plays": 1}, "11": {"off_plays": 1}}
    assert _sum_weeks(wide, ("off_plays",), before_week=11) == {"off_plays": 2}

    # --- z guards are inert, never amplifiers -------------------------------
    tiny = {"T%02d" % i: float(i) for i in range(MIN_TEAMS_FOR_Z - 1)}
    assert all(v == 0.0 for v in _z_map(tiny).values())
    flat = {"T%02d" % i: 5.0 for i in range(32)}
    assert all(v == 0.0 for v in _z_map(flat).values())
    spread = {"T%02d" % i: float(i) for i in range(32)}
    zs = _z_map(spread)
    assert abs(sum(zs.values())) < 1e-9                    # z is centered
    assert zs["T31"] > 0 > zs["T00"]

    # --- the interaction, and its antisymmetry ------------------------------
    assert abs(edge(0.5, -2.0) + 1.0) < 1e-12
    assert edge(None, 1.0) == 0.0 and edge(1.0, None) == 0.0
    feats = {2099: {5: {"off": {"H": 0.5, "A": 0.0}, "box": {"H": 0.0, "A": -2.0}}}}
    g = {"home": "H", "away": "A", "week": 5}
    # H's misdirection (+0.5) meets A's light box (-2.0) -> edge -1.0.
    assert abs(game_delta(feats, 2099, g, 80.0) + 80.0) < 1e-9
    swapped = {"home": "A", "away": "H", "week": 5}
    assert abs(game_delta(feats, 2099, swapped, 80.0) - 80.0) < 1e-9
    # Uncovered week / season / team -> exact 0.0, no raise, inside the walk.
    assert game_delta(feats, 2099, {"home": "H", "away": "A", "week": 9}, 80.0) == 0.0
    assert game_delta(feats, 2021, g, 80.0) == 0.0
    assert game_delta(feats, 2099, {"home": "Z", "away": "A", "week": 5}, 80.0) == 0.0
    assert game_delta(feats, 2099, g, 0.0) == 0.0

    # --- the grid ------------------------------------------------------------
    assert SCHEME_SCALES == [0.0, 40.0, 80.0, 120.0]
    assert SCHEME_SCALES == sorted(SCHEME_SCALES) and SCHEME_SCALES[0] == 0.0
    assert len([s for s in SCHEME_SCALES if s]) == 3        # live trials

    # --- builder contract ----------------------------------------------------
    setup, factory = scheme_builder(80.0, feats)
    fn = factory(setup(2099, [], []))
    assert abs(fn(g, 0) + 80.0) < 1e-9

    # --- end to end on the synthetic artifact --------------------------------
    doc = _fixture_doc()
    f2, diag = build_features(doc, [2098, 2099])
    # Exactly the 26 (team, week-1-of-2098) cells are undefined: no prior
    # season and no plays yet. Undefined is COUNTED, never filled in.
    assert diag["team_weeks_undefined"] == 26, diag
    assert diag["team_weeks_defined"] == 26 * (2 * MAX_WEEK - 1), diag
    # 2098 has no prior season in the doc; 2099 does.
    assert diag["seasons_without_prior"] == [2098], diag
    assert diag["seasons_with_prior"] == [2099], diag
    # 2098 week 1: no prior, no plays -> nothing defined -> empty tables.
    assert f2[2098][1]["off"] == {} and f2[2098][1]["box"] == {}
    # 2099 week 1: the complete 2098 season is the whole rate, so the z stage is
    # live with 26 teams. T00 is the misdirection offense; T01 the plodding one.
    w1 = f2[2099][1]
    assert w1["off"]["T00"] > 0 > w1["off"]["T01"], w1["off"]
    assert w1["box"]["T03"] > 0 > w1["box"]["T02"], w1["box"]
    assert abs(sum(w1["off"].values())) < 1e-9              # centered
    assert abs(sum(w1["box"].values())) < 1e-9
    # The axes are DISJOINT: the tendency teams are average-box and the box
    # teams are average-tendency, and the 22 plain teams are 0 on both.
    assert abs(w1["box"]["T00"]) < 1e-9 and abs(w1["box"]["T01"]) < 1e-9
    assert abs(w1["off"]["T02"]) < 1e-9 and abs(w1["off"]["T03"]) < 1e-9
    assert abs(w1["off"]["T05"]) < 1e-9 and abs(w1["box"]["T05"]) < 1e-9
    # MEAN, NOT SUM — pinned on a hand-computed number. All four tendency rates
    # are proportionally identical in this fixture, so all four z's are equal
    # and their MEAN is that single z: (0.3-0.2)/sqrt(0.02/26) = sqrt(13).
    # A sum would be 4*sqrt(13) and the top of SCHEME_SCALES would be worth
    # four times what TECH_DESIGN sized it for.
    assert abs(w1["off"]["T00"] - math.sqrt(13.0)) < 1e-9, w1["off"]["T00"]
    # THE HYPOTHESIS, in one assertion: T00's misdirection into T03's heavy box
    # is the family's most positive matchup, and swapping the venue negates it
    # exactly.
    best = game_delta(f2, 2099, {"home": "T00", "away": "T03", "week": 1}, 120.0)
    worst = game_delta(f2, 2099, {"home": "T03", "away": "T00", "week": 1}, 120.0)
    assert best > 0 > worst and abs(best + worst) < 1e-9, (best, worst)
    # Misdirection into the LIGHTEST box is the mirror image, not a bonus.
    assert abs(game_delta(f2, 2099, {"home": "T00", "away": "T02", "week": 1},
                          120.0) + best) < 1e-9
    # AN INTERACTION, NOT TWO MAIN EFFECTS. Two extreme offenses with average
    # boxes cancel to EXACTLY 0.0, and so do two extreme boxes with average
    # offenses. A family that scored either of these is re-pricing team
    # strength, which Elo and epa_total already carry.
    assert abs(game_delta(f2, 2099, {"home": "T00", "away": "T01", "week": 1},
                          120.0)) < 1e-9
    assert abs(game_delta(f2, 2099, {"home": "T02", "away": "T03", "week": 1},
                          120.0)) < 1e-9
    # A plain team against anyone is 0.0 on both halves of the difference.
    assert abs(game_delta(f2, 2099, {"home": "T05", "away": "T09", "week": 1},
                          120.0)) < 1e-9
    # NOTE ON MAGNITUDE: this fixture league is 22 identical teams plus two
    # mirror pairs, so its sd is artificially tiny and its z's reach sqrt(13).
    # That is a property of the fixture, not of the family — the real
    # distribution is measured, not asserted, and lands in the family's
    # `coverage.delta_stats` on every gate run.
    assert abs(best - 120.0 * 13.0) < 1e-6, best

    # --- coverage: the dilution is VISIBLE -----------------------------------
    one = [{"home": "T00", "away": "T03", "week": 1,
            "home_score": 1, "away_score": 0}]
    finals = {2098: list(one), 2099: list(one), 2100: list(one)}
    cov = coverage_block(f2, [2098, 2099, 2100], finals, doc=doc)
    assert cov["seasons_with_ftn"] == [2099], cov
    assert cov["seasons_dark"] == [2098, 2100], cov
    assert cov["folds_dark"] == 2 and cov["eval_folds"] == 3, cov
    assert cov["games_priced"] == 1 and cov["games_unpriced"] == 2, cov
    assert cov["delta_stats"]["n"] == 1, cov
    # The credit travels with the measurement, read from the artifact.
    assert cov["attribution"] == "FTN Data via nflverse", cov
    assert cov["license"] == "CC-BY-SA 4.0", cov
    assert cov["application"]["dark"] is True, cov

    # --- THE APPLICATION PATH IS DARK, AND IT SAYS SO -----------------------
    assert is_dark(2099, f2, doc) is False
    assert is_dark(2100, f2, doc) is True          # the artifact's live season
    assert is_dark(1999, f2, doc) is True          # simply uncovered
    assert "2100" in dark_reason(2100, doc) or "test fixture" in dark_reason(2100, doc)
    assert "neutral" in dark_reason(1999, doc)     # the generic refusal
    # An inert params block is 0.0 everywhere, dark or not.
    assert delta_from_params({}, 2100, g, f2, doc) == 0.0
    assert delta_from_params({"scheme_hfa": {"applied": False, "scale": 80.0}},
                             2100, g, f2, doc) == 0.0
    # An ACTIVE block on a covered season prices normally...
    live = {"scheme_hfa": {"applied": True, "scale": 120.0}}
    gg = {"home": "T00", "away": "T03", "week": 1}
    assert abs(delta_from_params(live, 2099, gg, f2, doc) - best) < 1e-9
    # ...and on a DARK season it RAISES rather than returning a neutral 0.0.
    # This is the assertion the whole module is shaped around.
    for dark_season in (2100, 1999):
        try:
            delta_from_params(live, dark_season, gg, f2, doc)
        except SchemeDark as exc:
            assert str(exc)
        else:                                              # pragma: no cover
            raise AssertionError(
                f"season {dark_season} is dark and delta_from_params returned "
                "a number — a silent no-op is indistinguishable from a working "
                "family")

    # --- the adoption block refuses to claim application on a dark season ---
    blk = adoption_block({"scale": 80.0}, "2026-01-01T00:00:00Z",
                         coverage=cov, application=doc["application"])
    assert blk["applied"] is False and blk["dark"] is True, blk
    assert blk["scale"] == 80.0 and blk["n0_plays"] == SCHEME_N0, blk
    assert blk["attribution"] == "FTN Data via nflverse", blk
    assert blk["coverage"]["folds_dark"] == 2, blk
    lit = adoption_block({"scale": 80.0}, "2026-01-01T00:00:00Z",
                         application={"live_season": 2100, "dark": False})
    assert lit["applied"] is True and lit["dark"] is False, lit

    # --- loader: absent artifact -> None, and scheme_current RAISES ---------
    missing = os.path.join(_ROOT, "no_such_scheme.json")
    assert load_features([2099], path=missing) is None
    assert "absent" in coverage_reason([2099], path=missing)
    try:
        scheme_current(2026, path=missing)
    except SchemeDark as exc:
        assert "absent" in str(exc), exc
    else:                                                  # pragma: no cover
        raise AssertionError("a missing artifact must raise, not return empty")

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "scheme.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        # PARTIAL coverage is NOT a refusal here — that is the whole point.
        loaded = load_features([1999, 2098, 2099], path=p)
        assert loaded is not None, "partial FTN coverage must still be trialled"
        lf, _ld, ldoc = loaded
        assert set(lf) == {2098, 2099}, sorted(lf)
        assert ldoc["attribution"] == "FTN Data via nflverse"
        assert scheme_current(2099, path=p)                # covered -> a table
        try:
            scheme_current(2100, path=p)                   # dark -> raise
        except SchemeDark as exc:
            assert "2100" in str(exc) or "fixture" in str(exc), exc
        else:                                              # pragma: no cover
            raise AssertionError("scheme_current must raise on a dark season")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"seasons": {}}, fh)
        assert load_features([2099], path=p) is None
        assert "no seasons" in coverage_reason([2099], path=p)

    print("selftest OK: blend is prior-season-only at week 1 and half-and-half "
          "at 400 plays, undefined never imputed, weeks-<W bound numeric, z "
          "guard inert below 24 teams and centered above it, misdirection-vs-"
          "heavy-box is the top matchup, delta antisymmetric, coverage records "
          "the dilution, and the APPLICATION PATH RAISES on a dark season "
          "instead of returning a neutral 0.0")
    return True


if __name__ == "__main__":
    selftest()
