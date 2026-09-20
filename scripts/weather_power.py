"""R94 WEATHER POWER STAGE: measured ICC, design effect, MDE, powered flags.

MEASURE ONLY. This module reads no file, writes no file, touches no shipped
constant and reads no market number. It is the stage that runs BEFORE any
coefficient is fitted, and it exists so that an underpowered term is
STRUCTURALLY INCAPABLE of coming back adoptable however large its measured
effect turns out to be.

WHY POWER RUNS FIRST. The owner's rain question (2026-09-20) is asked against a
number that is already written down: scripts/signals/weather.py carries
_PRECIP_PASS_MAX = 0.08 — "up to -8% passing in heavy precip" — folklore that
has never priced anything (weather_adjustment has zero call sites) and has
never been measured. A backtest that fits the coefficient first and asks about
significance afterwards will, on a corpus this thin, hand back a "significant"
rain effect about one run in twenty by construction. So the order is inverted.
The MINIMUM DETECTABLE EFFECT is computed from counts first, set beside the
effect the claim itself implies, and written into the artifact before any fit.
A term whose MDE exceeds its effect of interest is stamped powered:false, and
downstream that flag is a gate, not a note.

THREE ARITHMETIC DEFECTS THIS MODULE EXISTS TO AVOID. Each was found in a
rejected design during review, and each one inflates power in the flattering
direction:

  1. ASSUMING THE DESIGN EFFECT. One design assumed a clustering inflation of
     1.4-1.5 on its headline term; the review that rejected it put the real
     figure nearer 1.9. Both are guesses until something counts, and an assumed
     deff that is too low understates the standard error by sqrt(true/assumed)
     — power that was never there. Pass attempts inside one team-game are not
     independent Bernoulli draws (one passer, one scheme, one opponent, one set
     of conditions), but how far from independent is a question with an answer.

     Pointed at the only completion substrate the repo holds today —
     data/fixtures/gamestats_2025.json, 272 games, 544 team-games, 17,439
     attempts at a 0.6432 base — icc_same_game() returns ICC 0.0033 within a
     TEAM-GAME (deff 1.103 at mbar 32.1) and ICC 0.0046 within a GAME (deff
     1.292 at mbar 64.1). So the assumed 1.5 was too high, the asserted 1.9
     much too high, and the CLUSTERING LEVEL moves the answer more than either
     guess did. The level that matters for a rain contrast is the game: rain
     treats both sides at once, so all 64 of a wet game's attempts share one
     draw of the treatment.

     Not one of those numbers is written down in this file. They are what the
     function returned when it was run, and what it returns on the play-level
     substrate is the number the artifact will carry. That is the whole point:
     icc_same_game() MEASURES the within-cluster correlation from whatever
     substrate it is handed and design_effect() converts it, so no design
     effect is assumed anywhere here.

  2. sum(x) WHERE sum((x - xbar)^2) BELONGS. One design computed a continuous
     term's effective sample size as the sum of the treatment intensity. A
     slope is estimated from the SPREAD of its predictor, sum((x - xbar)^2),
     not from its total. On a predictor that is mostly small and positive the
     two differ by 3-4x in the optimistic direction, which turns an unpowered
     term into one whose powered:true flag a closed contract would then lock in
     as a gate-checked fact. mde_slope() takes the sum of squared deviations,
     and returns None — not a number — when the predictor is constant, because
     the honest answer there is an infinite MDE.

  3. POWERING ON A DIFFERENT SAMPLE FROM THE ONE ESTIMATED ON. One design
     computed power on the marginal corpus and estimated on a stratified one.
     Stratifying rain against wind and temperature costs roughly half the wet
     games, so its headline was sold on power it did not have. power_table()
     therefore takes the ANALYSIS SAMPLE as an argument and stamps every row
     with which sample that was, so the n beside a powered flag is the n the
     coefficient will actually be fitted on.

BLIND BY CONSTRUCTION. Every quantity in the power table that requires reading
an OUTCOME — the baseline rate, the measured ICC, the outcome's standard
deviation — is measured on TRAINING seasons only. The counts come from
denominators, which are known before a single outcome is read. That is what
makes the table invariant under a permutation of the evaluation seasons'
outcome column, and selftest() proves it BOTH ways: permuting an eval outcome
leaves the table byte-identical, and changing a training outcome moves it. A
blindness test that passes because the table is insensitive to everything would
prove nothing at all.

CONSERVATIVE IN ONE DIRECTION ONLY. Where a choice exists this module takes the
one that reports LESS power:

  * a measured negative ICC is read as sampling noise around zero and the
    design effect is floored at 1.0, because a deff below 1 hands back a
    tighter interval than an independent sample — the one direction a power
    stage must never err in;
  * mbar in the design effect is the mean cluster size, not the smaller ANOVA
    weight m0, so the inflation is the larger of the two readings;
  * the slope MDE uses the outcome's total standard deviation rather than a
    residual one, which can only overstate the standard error;
  * an ICC that cannot be measured returns None and the term reads not-powered,
    rather than silently borrowing deff = 1.0 (i.e. "no clustering"), which
    would be the assumption defect 1 exists to prevent;
  * an unestimable quantity is None, never 0.0 — a zero MDE reads as infinite
    power to every comparison downstream.

UNITS. Every effect of interest is declared in ITS OWN OUTCOME'S UNITS:
percentage points for a rate, fantasy points for points, the outcome's units
per unit of predictor for a slope. Importing a log-loss floor and applying it
to a coefficient in fantasy points is a units category error, and one of the
rejected designs did exactly that.

WHAT THIS MODULE DOES NOT DECIDE. It answers "could this measurement see an
effect of the size being claimed". It does not fit, adopt, threshold or rank.
The adoption rule, the multiplicity divisor and the binding threshold live with
the measurement script; powered:true is one of that rule's conditions and never
a verdict on its own.

Stdlib only.
"""

import argparse
import math
import sys

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALPHA = 0.05            # two-sided significance
POWER = 0.80            # conventional 80% power

# z(1 - ALPHA/2) + z(POWER) = 1.95996 + 0.84162 = 2.80158. Pinned as a literal
# at the specification's own precision so that every MDE published in the
# artifact can be re-derived by hand from the counts printed beside it.
Z_MDE = 2.8016

# Below this many clusters the between-cluster mean square has fewer than seven
# degrees of freedom and the ICC's own sampling error is the same order as the
# ICC. icc_same_game() then returns None and the term reads not-powered, which
# is the safe direction: the alternative is importing a design effect from
# somewhere else, which is the assumption this module exists to refuse.
MIN_ICC_CLUSTERS = 8

# Cluster-input kinds for icc_same_game(). RATE: each row is (cluster, successes,
# trials) and the underlying observation is one PLAY. VALUE: each row is
# (cluster, value) and the underlying observation is the ROW — for a game
# cluster holding two team-games that is literally the correlation between the
# two sides of one game.
RATE = "rate"
VALUE = "value"

# Term kinds for power_table().
TERM_RATE = "rate"      # a per-attempt / per-target binomial
TERM_SLOPE = "slope"    # a continuous coefficient per unit of predictor

# Which sample a power row was computed on. The label is recorded beside the n
# so a stratified primary can never be read as though it had the marginal n.
SAMPLES = ("marginal", "stratified")

# THE EFFECT OF INTEREST, keyed by OUTCOME and declared in that outcome's own
# units. 0.08 is not this module's number and not a guess: it is
# _PRECIP_PASS_MAX in scripts/signals/weather.py, the 8% the claim asserts.
# Each entry is that 8% applied to a base measured on this repo's own corpus,
# so the bar a term must clear to be called powered is the size of the effect
# the owner's claim itself asserts — not a bar this module chose.
#
# Keyed by outcome rather than by term name on purpose: the 8% is a statement
# about an outcome's scale, and the UNIT lives on the outcome. A term name is a
# grid label, and a grid that gains a row must not thereby gain a new bar.
EFFECT_OF_INTEREST = {
    "completion_rate": 0.052,       # 0.08 x the 0.645 completion base = 5.2pp
    "catch_rate": 0.052,            # the same claim, restated: 5.2pp
    "qb_fantasy_points": 1.32,      # 0.08 x the measured 16.47-point QB mean
}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _pull(spec, row):
    """Read a field from a row: `spec` is a key, or a callable taking the row.

    A missing key raises. Nothing here defaults to zero — a silently absent
    denominator reads as "this play never happened", which is the quietest way
    to manufacture power.
    """
    if callable(spec):
        return spec(row)
    return row[spec]


def sum_squared_deviations(xs):
    """sum((x - xbar)^2) — the information a slope is estimated from.

    NOT sum(x). The distinction is defect 2 in the module docstring: the total
    of a mostly-positive predictor overstates slope information several-fold.
    Returns 0.0 for a constant or one-element predictor, which callers must
    read as "no information", never as "no uncertainty".
    """
    vals = [float(x) for x in xs]
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    return sum((v - mean) ** 2 for v in vals)


def sample_sd(values):
    """Sample standard deviation (n - 1). None when fewer than two values.

    The unbiased n-1 form, and the TOTAL sd rather than a residual one: both
    choices push the standard error up, which is the only direction this module
    is allowed to err in.
    """
    vals = [float(v) for v in values]
    if len(vals) < 2:
        return None
    mean = sum(vals) / len(vals)
    return math.sqrt(sum((v - mean) ** 2 for v in vals) / (len(vals) - 1))


# ---------------------------------------------------------------------------
# Measured intra-cluster correlation and the design effect it implies
# ---------------------------------------------------------------------------

def _cluster_aggregates(units, kind):
    """{cluster_id: (n, total, within_ss)} for the one-way ANOVA.

    For RATE the within-cluster sum of squares around the cluster mean has a
    closed form on 0/1 data: sum_j (x_j - p)^2 = n p (1 - p). It depends only on
    the cluster's own totals, so a cluster's plays never have to be enumerated.
    """
    if kind == RATE:
        totals = {}
        for unit in units:
            cid, successes, trials = unit
            trials = float(trials)
            successes = float(successes)
            if trials <= 0.0:
                continue                      # no denominator, no information
            if successes < 0.0 or successes > trials:
                raise ValueError("successes %r outside 0..%r in cluster %r"
                                 % (successes, trials, cid))
            n, tot = totals.get(cid, (0.0, 0.0))
            totals[cid] = (n + trials, tot + successes)
        out = {}
        for cid, (n, tot) in totals.items():
            p = tot / n
            out[cid] = (n, tot, n * p * (1.0 - p))
        return out

    if kind == VALUE:
        grouped = {}
        for unit in units:
            # Deliberately 2-tuples only. An earlier draft accepted a weight and
            # a caller weighted team-game rates by their attempt counts, which
            # made mbar a WEIGHT TOTAL rather than a cluster size and turned a
            # true design effect of 1.14 into 37.5. One row is one observation
            # here; a denominator-weighted clustering is a different estimator
            # and does not belong in a power stage.
            unit = tuple(unit)
            if len(unit) != 2:
                raise ValueError(
                    "a VALUE unit is (cluster_id, value); got %d fields. To "
                    "cluster PLAYS use kind=%r with (cluster_id, successes, "
                    "trials); weighting a VALUE row is refused because mbar "
                    "would become a weight total rather than a cluster size."
                    % (len(unit), RATE))
            cid, value = unit
            grouped.setdefault(cid, []).append(float(value))
        out = {}
        for cid, vals in grouped.items():
            n = float(len(vals))
            tot = sum(vals)
            mean = tot / n
            out[cid] = (n, tot, sum((v - mean) ** 2 for v in vals))
        return out

    raise ValueError("kind must be %r or %r, got %r" % (RATE, VALUE, kind))


def icc_same_game(units, kind=RATE, min_clusters=MIN_ICC_CLUSTERS):
    """MEASURE the intra-cluster correlation, and the design effect it implies.

    One-way random-effects ANOVA estimator with unequal cluster sizes:

        MSB = sum_i n_i (ybar_i - ybar)^2 / (k - 1)
        MSW = sum_i SSW_i / (N - k)
        m0  = (N - sum_i n_i^2 / N) / (k - 1)
        ICC = (MSB - MSW) / (MSB + (m0 - 1) MSW)

    `units` is an iterable of (cluster_id, successes, trials) under RATE, or of
    (cluster_id, value) under VALUE; rows sharing a cluster_id are pooled, so
    the CALLER chooses the clustering level by how it keys the rows.
    Key on the game and a rate term's ICC is the correlation of plays inside one
    game; key on (game, team) and it is the correlation inside one team-game.
    For a VALUE term keyed on the game with one row per side, it is exactly the
    correlation between the two team-games of one game.

    Returns None — never a number and never a default — when the correlation
    cannot be measured: fewer than `min_clusters` clusters, one observation per
    cluster, or no variation of any kind to decompose. A caller that receives
    None must report the term not-powered; the alternative is assuming a design
    effect, which is the defect this function exists to remove.

    The returned `icc` is the raw measurement and may be negative (less
    variation than independent sampling would give). The returned `deff` is
    floored at 1.0, because a design effect below 1 would report a TIGHTER
    interval than an independent sample of the same size and hand back power
    that no clustering ever created.
    """
    agg = _cluster_aggregates(units, kind)
    k = len(agg)
    if k < max(2, int(min_clusters)):
        return None
    n_total = sum(n for n, _, _ in agg.values())
    if n_total <= k:
        return None                 # one observation per cluster: MSW unobservable
    grand = sum(tot for _, tot, _ in agg.values()) / n_total
    msb = sum(n * (tot / n - grand) ** 2 for n, tot, _ in agg.values()) / (k - 1)
    msw = sum(ss for _, _, ss in agg.values()) / (n_total - k)
    sum_n_sq = sum(n * n for n, _, _ in agg.values())
    m0 = (n_total - sum_n_sq / n_total) / (k - 1)
    denom = msb + (m0 - 1.0) * msw
    if denom <= 0.0:
        return None                 # no variation anywhere: nothing to decompose
    icc = (msb - msw) / denom
    mbar = n_total / k
    return {
        "icc": icc,
        "deff": design_effect(icc, mbar),
        "mbar": mbar,
        "m0": m0,
        "clusters": k,
        "n": n_total,
        "mean": grand,
    }


def design_effect(icc, mbar):
    """deff = 1 + (mbar - 1) * ICC, floored at 1.0.

    mbar is the MEAN cluster size, not the ANOVA weight m0. With unequal
    clusters m0 <= mbar, so mean-cluster-size is the larger inflation of the
    two available readings and therefore the one this module reports.
    """
    if icc is None or mbar is None:
        return None
    return max(1.0, 1.0 + (float(mbar) - 1.0) * float(icc))


# ---------------------------------------------------------------------------
# Minimum detectable effect
# ---------------------------------------------------------------------------

def se_rate(baseline_rate, n_treated, n_control, deff=1.0):
    """SE of a difference in RATES under the null baseline, with clustering.

        se = sqrt( p (1 - p) * (deff / n_treated + 1 / n_control) )

    n_treated and n_control are counts of TRIALS (attempts, targets), never of
    games: that denominator move is the whole reason the mechanism is
    measurable where a per-game outcome is not.

    The clustering penalty is charged to the treated arm, which is where it
    bites — the treated arm is a few dozen games and the control arm is
    thousands, so 1/n_control is a rounding error in the sum either way.

    None whenever the quantity does not exist (an empty arm, a degenerate rate),
    because 0.0 would read as perfect precision.
    """
    if baseline_rate is None or deff is None:
        return None
    p = float(baseline_rate)
    if not 0.0 < p < 1.0:
        return None
    n_t = float(n_treated or 0.0)
    n_c = float(n_control or 0.0)
    if n_t <= 0.0 or n_c <= 0.0:
        return None
    return math.sqrt(p * (1.0 - p) * (float(deff) / n_t + 1.0 / n_c))


def mde_rate(baseline_rate, n_treated, n_control, deff=1.0, z=Z_MDE):
    """The smallest rate difference this sample could detect, in rate units."""
    se = se_rate(baseline_rate, n_treated, n_control, deff)
    return None if se is None else float(z) * se


def se_slope(xs, ys=None, sd_y=None, deff=1.0):
    """SE of an OLS slope: sd_y / sqrt(Sxx / deff), Sxx = sum((x - xbar)^2).

    Equivalent to the sd_y / (sd_x * sqrt(n_eff)) form with a population sd_x
    and n_eff = n / deff, and written in the Sxx form so that the quantity being
    used is visible: slope information is the spread of the predictor.

    `xs` spans the ANALYSIS SAMPLE while `sd_y` is measured on TRAINING seasons
    only, so the two are deliberately NOT the same length. That is the blindness
    rule, not an oversight: predictor spread is known before kickoff, outcome
    spread is not.

    None when the predictor is constant (Sxx = 0 — an infinite MDE, which is a
    refusal and not a number) or when the outcome has no spread to detect
    against.
    """
    if deff is None:
        return None
    sxx = sum_squared_deviations(xs)
    if sxx <= 0.0:
        return None
    if sd_y is None:
        if ys is None:
            raise ValueError("se_slope needs ys or sd_y")
        sd_y = sample_sd(ys)
    if sd_y is None or float(sd_y) <= 0.0:
        return None
    return float(sd_y) / math.sqrt(sxx / float(deff))


def mde_slope(xs, ys=None, sd_y=None, deff=1.0, z=Z_MDE):
    """The smallest slope this sample could detect, per unit of predictor."""
    se = se_slope(xs, ys=ys, sd_y=sd_y, deff=deff)
    return None if se is None else float(z) * se


def is_powered(mde, effect_of_interest):
    """powered = the MDE is no larger than the effect the claim asserts.

    An unmeasurable MDE is NOT powered. There is no branch in which a missing
    number reads as adequate power.
    """
    if mde is None or effect_of_interest is None:
        return False
    return float(mde) <= float(effect_of_interest)


def resolve_effect_of_interest(term):
    """The bar for one term, in its outcome's own units.

    A term may carry its own `effect_of_interest` — a continuous term whose
    outcome the 8% claim says nothing about MUST, and must justify it where it
    is declared. Otherwise the outcome is looked up in EFFECT_OF_INTEREST.

    An outcome with neither raises. It would be trivial to default to something,
    and a defaulted bar is precisely how an underpowered term acquires a
    powered:true flag that a closed contract then records as a fact.
    """
    own = term.get("effect_of_interest")
    if own is not None:
        return float(own)
    outcome = term.get("outcome")
    if outcome in EFFECT_OF_INTEREST:
        return float(EFFECT_OF_INTEREST[outcome])
    raise ValueError(
        "term %r has outcome %r with no pre-registered effect of interest: "
        "declare one on the term spec in that outcome's own units, or add the "
        "outcome to EFFECT_OF_INTEREST. This module will not invent a bar."
        % (term.get("name"), outcome))


# ---------------------------------------------------------------------------
# The power table
# ---------------------------------------------------------------------------

def _training_rows(rows, training_seasons, season_key):
    seasons = set(int(s) for s in training_seasons)
    return [r for r in rows if int(_pull(season_key, r)) in seasons]


def _rate_power(rows, train, term, z):
    num = term["num"]
    den = term["den"]
    treated = term["treated"]
    cluster = term.get("cluster", "game_key")

    n_treated = 0.0
    n_control = 0.0
    for row in rows:
        trials = float(_pull(den, row))
        if trials <= 0.0:
            continue
        if _pull(treated, row):
            n_treated += trials
        else:
            n_control += trials

    # Outcome-bearing quantities: TRAINING seasons only.
    train_num = sum(float(_pull(num, r)) for r in train)
    train_den = sum(float(_pull(den, r)) for r in train)
    baseline = (train_num / train_den) if train_den > 0.0 else None
    measured = icc_same_game(
        [(_pull(cluster, r), float(_pull(num, r)), float(_pull(den, r)))
         for r in train], kind=RATE)
    deff = measured["deff"] if measured else None
    se = se_rate(baseline, n_treated, n_control, deff)
    return {
        "n_treated": int(round(n_treated)),
        "n_control": int(round(n_control)),
        "baseline_rate": baseline,
        "measured_icc": measured["icc"] if measured else None,
        "deff": deff,
        "se": se,
        "mde": None if se is None else float(z) * se,
    }


def _slope_power(rows, train, term, z):
    x = term["x"]
    y = term["y"]
    treated = term.get("treated")
    cluster = term.get("cluster", "game_key")

    # Predictor spread spans the whole analysis sample: it is known before any
    # outcome is read, so using all of it leaks nothing.
    xs = [float(_pull(x, r)) for r in rows]

    if treated is None:
        n_treated, n_control = len(rows), 0
    else:
        n_treated = sum(1 for r in rows if _pull(treated, r))
        n_control = len(rows) - n_treated

    # Outcome-bearing quantities: TRAINING seasons only.
    sd_y = sample_sd([float(_pull(y, r)) for r in train])
    measured = icc_same_game(
        [(_pull(cluster, r), float(_pull(y, r))) for r in train], kind=VALUE)
    deff = measured["deff"] if measured else None
    se = se_slope(xs, sd_y=sd_y, deff=deff)
    return {
        "n_treated": int(n_treated),
        "n_control": int(n_control),
        "baseline_rate": None,          # a slope has no null rate to sit under
        "measured_icc": measured["icc"] if measured else None,
        "deff": deff,
        "se": se,
        "mde": None if se is None else float(z) * se,
    }


def power_table(sample, terms, training_seasons, analysis_sample,
                season_key="season", z=Z_MDE):
    """Power for every term, computed ON THE SAMPLE IT WILL BE FITTED ON.

    `sample`           the analysis sample: the rows the coefficients will be
                       estimated from. A stratified primary passes its STRATUM
                       here, which is the point of the argument existing.
    `terms`            term specs. Every term carries name, kind, outcome and a
                       `cluster` key (default "game_key"). A TERM_RATE term adds
                       num, den and treated; a TERM_SLOPE term adds x, y and an
                       optional treated used only to report the n split. Each
                       field is a row key or a callable on the row.
    `training_seasons` the seasons whose OUTCOMES this stage is allowed to read.
    `analysis_sample`  "marginal" or "stratified" — the label stamped on every
                       row so an n can never be read as belonging to a sample it
                       did not come from.

    Returns {name: record} with exactly the ten published fields, unrounded.
    Rounding happens once at the artifact boundary, not here.
    """
    if analysis_sample not in SAMPLES:
        raise ValueError("analysis_sample must be one of %r, got %r"
                         % (SAMPLES, analysis_sample))
    rows = list(sample)
    train = _training_rows(rows, training_seasons, season_key)

    table = {}
    for term in terms:
        name = term["name"]
        if name in table:
            raise ValueError("duplicate term name %r in the power table" % name)
        kind = term.get("kind", TERM_RATE)
        if kind == TERM_RATE:
            core = _rate_power(rows, train, term, z)
        elif kind == TERM_SLOPE:
            core = _slope_power(rows, train, term, z)
        else:
            raise ValueError("term %r has unknown kind %r" % (name, kind))
        effect = resolve_effect_of_interest(term)
        table[name] = {
            "analysis_sample": analysis_sample,
            "n_treated": core["n_treated"],
            "n_control": core["n_control"],
            "baseline_rate": core["baseline_rate"],
            "measured_icc": core["measured_icc"],
            "deff": core["deff"],
            "se": core["se"],
            "mde": core["mde"],
            "effect_of_interest": effect,
            "powered": is_powered(core["mde"], effect),
        }
    return table


# ---------------------------------------------------------------------------
# Selftest: synthetic fixtures with answers worked out by hand
# ---------------------------------------------------------------------------

def _synthetic():
    """A paired sample whose stratum is an exact copy of its complement.

    Twelve PAIRS of games. Both members of a pair carry identical attempts,
    completions, targets, receptions, wind and EPA; they differ ONLY in
    temperature, so one member falls in the (temp > 5 C) stratum and one does
    not. The stratified analysis sample is therefore the marginal one with each
    pattern appearing once instead of twice: the same rates, the same
    cluster-size profile and the same predictor spread on exactly half the
    trials. Any MDE difference between the two is then attributable to n and to
    nothing else, which is what acceptance (c) has to isolate.

    The stratifying field is deliberately NOT the slope term's own predictor.
    Stratifying on wind would leave the wind term a constant predictor inside
    its own stratum — a real hazard for the primary, worth stating here rather
    than discovering downstream, and not the thing this fixture is isolating.

    Seasons 2021 and 2022 are training; 2023 is held out. Each game holds two
    team-games so a VALUE clustering has the two sides of one game in it.
    """
    rows = []
    for pair in range(12):
        season = 2021 + (pair % 3)               # 4 pairs per season
        wet = pair < 4                           # a third of the pairs are wet
        wind = 6.0 + 3.0 * pair                  # 6 to 39 kph, spread by pair
        for warm in (True, False):
            gid = "g%02d%s" % (pair, "w" if warm else "c")
            for side in ("home", "away"):
                # Completion counts vary by pair so clusters differ, and by side
                # so there is within-game variation to decompose.
                attempts = 30 + pair
                completions = 18 + (pair % 5) + (2 if side == "home" else 0)
                targets = 12 + (pair % 3)
                receptions = 7 + (pair % 4) + (1 if side == "home" else 0)
                rows.append({
                    "season": season,
                    "game_key": gid,
                    "team": "%s_%s" % (gid, side),
                    "wind_kph": wind,
                    "temp_c": 12.0 if warm else 1.0,
                    "precip_mm": 1.4 if wet else 0.0,
                    "wet": wet,
                    "attempts": attempts,
                    "completions": completions,
                    "targets": targets,
                    "receptions": receptions,
                    # A deterministic, non-constant continuous outcome.
                    "epa_per_db": 0.02 + 0.004 * pair - (0.01 if side == "away" else 0.0),
                })
    return rows


def _terms():
    """Two terms, one of each kind, over the fixture above."""
    return [
        {"name": "rain_completion_rate", "kind": TERM_RATE,
         "outcome": "completion_rate", "num": "completions", "den": "attempts",
         "treated": lambda r: r["wet"], "cluster": "game_key"},
        {"name": "wind_epa_per_db", "kind": TERM_SLOPE,
         "outcome": "epa_per_dropback", "x": "wind_kph", "y": "epa_per_db",
         "treated": lambda r: r["wind_kph"] >= 20.0, "cluster": "game_key",
         # No 8% claim exists for EPA, so this term declares its own bar: half
         # the descriptive calm-to-gale spread in the corpus, per 10 kph.
         "effect_of_interest": 0.02},
    ]


def selftest():
    train_seasons = (2021, 2022)

    # --- the ICC is MEASURED, with exact arithmetic on exact fixtures --------
    # Ten clusters of ten plays, each cluster all-success or all-failure: every
    # play inside a cluster agrees, so the correlation is 1 and the design
    # effect is the whole cluster size.
    all_or_nothing = [("c%d" % i, 10 if i < 5 else 0, 10) for i in range(10)]
    got = icc_same_game(all_or_nothing, kind=RATE)
    assert abs(got["icc"] - 1.0) < 1e-12, "planted ICC 1.0, got %r" % got["icc"]
    assert abs(got["deff"] - 10.0) < 1e-12, "deff must be mbar=10, got %r" % got["deff"]
    assert got["clusters"] == 10 and got["n"] == 100.0, got

    # The same n and the same overall rate with NO between-cluster spread: the
    # ANOVA returns exactly -1/(m0-1) = -1/9 and the deff is floored at 1.0.
    # This is the pair that proves the design effect is read off the substrate
    # and not assumed: identical counts, identical mbar, different clustering,
    # deff 10.0 against deff 1.0.
    flat = [("c%d" % i, 5, 10) for i in range(10)]
    got_flat = icc_same_game(flat, kind=RATE)
    assert abs(got_flat["icc"] - (-1.0 / 9.0)) < 1e-12, got_flat["icc"]
    assert got_flat["deff"] == 1.0, "a negative ICC must floor at 1.0, not %r" % got_flat["deff"]
    assert got_flat["mbar"] == got["mbar"], "the two fixtures must share mbar"

    # VALUE kind, the two sides of one game: identical sides correlate 1 and
    # inflate by exactly the cluster size 2; mirrored sides correlate -1.
    same = [("g%d" % i, float(i)) for i in range(10) for _ in (0, 1)]
    got_same = icc_same_game(same, kind=VALUE)
    assert abs(got_same["icc"] - 1.0) < 1e-12, got_same["icc"]
    assert abs(got_same["deff"] - 2.0) < 1e-12, got_same["deff"]
    mirror = [("g%d" % i, sign * 1.0) for i in range(10) for sign in (1.0, -1.0)]
    got_mirror = icc_same_game(mirror, kind=VALUE)
    assert abs(got_mirror["icc"] - (-1.0)) < 1e-12, got_mirror["icc"]
    assert got_mirror["deff"] == 1.0, got_mirror["deff"]
    # mbar under VALUE is the number of ROWS in a cluster — two team-games, not
    # their combined play count. A weighted row is refused at the door: weighting
    # team-game rates by their attempts once turned mbar into a weight total and
    # a true design effect of 1.14 into 37.5.
    assert got_same["mbar"] == 2.0 and got_same["n"] == 20.0, got_same
    try:
        icc_same_game([("g%d" % i, 1.0 * i, 30.0) for i in range(10)], kind=VALUE)
        raise AssertionError("a weighted VALUE unit must raise, not be pooled")
    except ValueError:
        pass

    # With UNEQUAL clusters the two available cluster sizes part company, and
    # the reported design effect is built on the larger one. Five clusters of
    # ten plays and five of fifty, each internally unanimous: mbar = 30 while
    # the ANOVA weight m0 = (300 - 13000/300)/9 = 28.5185, so the deff is 30.0
    # and not 29.5185. Reporting m0 here would quietly buy back power.
    unequal = icc_same_game(
        [("c%d" % i, (10 if i % 2 == 0 else 50) if i < 5 else 0,
          10 if i % 2 == 0 else 50) for i in range(10)], kind=RATE)
    assert abs(unequal["icc"] - 1.0) < 1e-12, unequal["icc"]
    assert unequal["mbar"] == 30.0 and abs(unequal["m0"] - 28.518518518518519) < 1e-9, unequal
    assert abs(unequal["deff"] - 30.0) < 1e-12, \
        "deff must use mbar (30.0), not the smaller ANOVA weight m0 (28.5185): %r" \
        % unequal["deff"]

    # An unmeasurable correlation is None, never a default. Too few clusters,
    # and one observation per cluster, are both refusals.
    assert icc_same_game([("c%d" % i, 5, 10) for i in range(3)], kind=RATE) is None
    assert icc_same_game([("g%d" % i, 1.0) for i in range(20)], kind=VALUE) is None
    # A cluster whose successes exceed its trials is a substrate error, loud.
    try:
        icc_same_game([("c", 11, 10)] * 10, kind=RATE)
        raise AssertionError("successes > trials must raise")
    except ValueError:
        pass

    # --- (a) an infinite MDE is None, not a number --------------------------
    const_x = [7.0] * 40
    ys = [float(i % 5) for i in range(40)]
    assert mde_slope(const_x, ys=ys) is None, \
        "a constant predictor carries no slope information: MDE is infinite"
    assert se_slope(const_x, ys=ys) is None
    # ... and the same predictor with any spread at all does return a number.
    spread_x = [7.0] * 39 + [8.0]
    assert mde_slope(spread_x, ys=ys) is not None
    # sum((x-xbar)^2) is the quantity used: a constant predictor has Sxx 0 while
    # its sum(x) is 280, the arithmetic that broke a rejected design.
    assert sum_squared_deviations(const_x) == 0.0 and sum(const_x) == 280.0

    # --- (b) doubling n scales the MDE by 1/sqrt(2) -------------------------
    # The deff and the rate here are arbitrary inputs held fixed across the
    # pair; what is asserted is the SCALING, not either value.
    root_half = 1.0 / math.sqrt(2.0)
    one = mde_rate(0.645, 2380, 59499, deff=1.9)
    two = mde_rate(0.645, 4760, 118998, deff=1.9)
    assert abs(two / one - root_half) < 1e-9, \
        "doubling both arms must scale the rate MDE by 1/sqrt(2): %r" % (two / one)
    xs = [float(i % 11) for i in range(200)]
    slope_one = mde_slope(xs, sd_y=7.66, deff=1.4)
    slope_two = mde_slope(xs + xs, sd_y=7.66, deff=1.4)
    assert abs(slope_two / slope_one - root_half) < 1e-9, \
        "doubling the sample must scale the slope MDE by 1/sqrt(2): %r" % (
            slope_two / slope_one)
    # A slope pays for clustering exactly as a rate does: deff 2 costs sqrt(2)
    # of the bar, which is the same as halving the sample. Asserted because a
    # slope SE that quietly drops deff looks identical in every other test.
    assert abs(mde_slope(xs, sd_y=7.66, deff=2.0)
               / mde_slope(xs, sd_y=7.66, deff=1.0) - math.sqrt(2.0)) < 1e-12, \
        "the slope MDE must carry the design effect, not ignore it"

    # --- (d) a hand-worked binomial, literal ---------------------------------
    # p = 0.5, 100 trials each arm, no clustering:
    #   se  = sqrt(0.25 * (1/100 + 1/100)) = sqrt(0.005) = 0.07071067811865475
    #   mde = 2.8016 * 0.07071067811865475 = 0.19810303581722316
    hand = mde_rate(0.5, 100, 100, deff=1.0)
    assert abs(hand - 0.19810303581722316) < 1e-15, \
        "hand-worked MDE is 2.8016 * sqrt(0.25 * 0.02) = 0.19810303581722316, got %r" % hand
    # And with a design effect of exactly 2 on the treated arm:
    #   se  = sqrt(0.25 * (2/100 + 1/100)) = sqrt(0.0075) = 0.08660254037844387
    #   mde = 2.8016 * 0.08660254037844387 = 0.24262567712424835
    hand_deff = mde_rate(0.5, 100, 100, deff=2.0)
    assert abs(hand_deff - 0.24262567712424835) < 1e-15, \
        "with deff 2 the hand-worked MDE is 2.8016 * sqrt(0.0075) = " \
        "0.24262567712424835, got %r" % hand_deff
    # A larger design effect can only ever widen the bar.
    assert hand_deff > hand, "deff must be monotone in the MDE"
    # An empty arm has no MDE at all, and None is never powered.
    assert mde_rate(0.645, 0, 59499, deff=1.9) is None
    assert mde_rate(0.645, 2380, 0, deff=1.9) is None
    assert is_powered(None, 0.052) is False
    # The powered flag is <=, checked at the boundary and just past it.
    assert is_powered(0.052, 0.052) is True
    assert is_powered(0.0520000001, 0.052) is False

    # --- (c) a stratified sample is powered on ITS OWN n --------------------
    rows = _synthetic()
    terms = _terms()
    marginal = power_table(rows, terms, train_seasons, "marginal")
    stratum = [r for r in rows if r["temp_c"] > 5.0]
    stratified = power_table(stratum, terms, train_seasons, "stratified")
    assert len(stratum) * 2 == len(rows), "the fixture's stratum must be half of it"
    for name in marginal:
        m, s = marginal[name], stratified[name]
        assert s["analysis_sample"] == "stratified" and m["analysis_sample"] == "marginal"
        assert abs((m["baseline_rate"] or 0.0) - (s["baseline_rate"] or 0.0)) < 1e-12, \
            "the fixture holds rates equal across the two samples: %s" % name
        assert s["mde"] > m["mde"], \
            "%s: the stratified MDE must be strictly larger (%r vs %r)" % (
                name, s["mde"], m["mde"])
        # Half the trials, so the ratio brackets sqrt(2); it is not exactly
        # sqrt(2) because the ICC is re-measured on each sample, which is the
        # behaviour being asserted.
        assert 1.25 < s["mde"] / m["mde"] < 1.55, s["mde"] / m["mde"]
    # The n beside the flag is the stratum's n, counted from the rows that were
    # actually handed over. Pinned ABSOLUTELY, not as a ratio: a ratio survives
    # a power_table that silently doubles or halves every sample it is given,
    # and the whole point of the argument is that the n is the sample's own.
    # Four wet pairs (attempts 30..33), four rows each: 4 x (30+31+32+33) = 504
    # treated attempts marginal, half of them inside the stratum.
    assert marginal["rain_completion_rate"]["n_treated"] == 504, \
        "4 rows x (30+31+32+33) = 504 treated attempts, got %r" % \
        marginal["rain_completion_rate"]["n_treated"]
    assert stratified["rain_completion_rate"]["n_treated"] == 252, \
        stratified["rain_completion_rate"]["n_treated"]
    # Eight dry pairs (attempts 34..41), four rows each: 4 x 300 = 1200.
    assert marginal["rain_completion_rate"]["n_control"] == 1200, \
        marginal["rain_completion_rate"]["n_control"]
    assert stratified["rain_completion_rate"]["n_control"] == 600, \
        stratified["rain_completion_rate"]["n_control"]
    # The slope term counts TEAM-GAMES, not attempts: wind = 6 + 3*pair reaches
    # 20 kph at pair 5, so seven pairs x four rows = 28 windy team-games.
    assert marginal["wind_epa_per_db"]["n_treated"] == 28, \
        marginal["wind_epa_per_db"]["n_treated"]
    assert stratified["wind_epa_per_db"]["n_treated"] == 14, \
        stratified["wind_epa_per_db"]["n_treated"]
    # A stratum that removes the slope's own predictor spread has no slope to
    # measure at all, and says None rather than producing a confident number.
    calm_only = [r for r in rows if r["wind_kph"] == rows[0]["wind_kph"]]
    assert power_table(calm_only, terms, train_seasons,
                       "stratified")["wind_epa_per_db"]["mde"] is None

    # --- the table is BLIND to held-out outcomes, and not blind to training --
    baseline = power_table(rows, terms, train_seasons, "marginal")
    permuted = []
    holdout = [r["completions"] for r in rows if r["season"] == 2023]
    holdout = holdout[1:] + holdout[:1]          # a genuine permutation
    idx = 0
    for r in rows:
        r2 = dict(r)
        if r["season"] == 2023:
            r2["completions"] = holdout[idx]
            r2["epa_per_db"] = -r["epa_per_db"]
            idx += 1
        permuted.append(r2)
    after = power_table(permuted, terms, train_seasons, "marginal")
    assert after == baseline, \
        "permuting a held-out outcome must not move the power table"
    # The converse, so the blindness assertion is not vacuous: a TRAINING
    # outcome moves it. A test that passes because nothing can move the table
    # proves nothing about blindness.
    bumped = [dict(r) for r in rows]
    for r in bumped:
        if r["season"] == 2021:
            r["completions"] = max(0, r["completions"] - 5)
            r["epa_per_db"] = r["epa_per_db"] * 3.0
    moved = power_table(bumped, terms, train_seasons, "marginal")
    assert moved["rain_completion_rate"]["baseline_rate"] != \
        baseline["rain_completion_rate"]["baseline_rate"], \
        "a training-season outcome must move the baseline rate"
    assert moved["wind_epa_per_db"]["se"] != baseline["wind_epa_per_db"]["se"], \
        "a training-season outcome must move the slope standard error"

    # --- the table's shape and its refusals ---------------------------------
    expected_fields = {"analysis_sample", "n_treated", "n_control", "baseline_rate",
                       "measured_icc", "deff", "se", "mde", "effect_of_interest",
                       "powered"}
    for name, rec in marginal.items():
        assert set(rec) == expected_fields, (name, sorted(rec))
        assert isinstance(rec["powered"], bool), "powered must be a plain bool"
        assert rec["effect_of_interest"] > 0.0
    assert marginal["rain_completion_rate"]["effect_of_interest"] == 0.052, \
        "the rain bar is the owner's own 8% on the completion base: 5.2pp"
    # An outcome with no pre-registered bar and no declared one refuses.
    try:
        resolve_effect_of_interest({"name": "x", "outcome": "made_up_outcome"})
        raise AssertionError("an unregistered outcome must raise, not default")
    except ValueError:
        pass
    # An unlabelled analysis sample refuses too: the label is what stops a
    # stratified n being read as a marginal one.
    try:
        power_table(rows, terms, train_seasons, "whatever")
        raise AssertionError("an unknown analysis_sample label must raise")
    except ValueError:
        pass
    # A term whose ICC cannot be measured is not powered, rather than silently
    # taking deff = 1.0 and reporting the independent-sample MDE.
    thin = [r for r in rows if r["game_key"] in ("g00c", "g01c", "g00w")]
    thin_table = power_table(thin, terms, train_seasons, "marginal")
    assert thin_table["rain_completion_rate"]["deff"] is None
    assert thin_table["rain_completion_rate"]["mde"] is None
    assert thin_table["rain_completion_rate"]["powered"] is False

    print("selftest OK: the design effect is MEASURED from the substrate "
          "(identical counts and identical mbar return deff 10.0 when plays "
          "inside a cluster agree and 1.0 when they do not, and a negative ICC "
          "floors at 1.0 rather than buying power); slope power uses "
          "sum((x-xbar)^2), so a constant predictor returns None and not a "
          "number; doubling n scales both MDEs by 1/sqrt(2) to 1e-9; a "
          "hand-worked binomial matches 2.8016*sqrt(0.25*0.02) = "
          "0.19810303581722316 exactly; a stratified sample is powered on its "
          "own n and returns strictly larger MDEs than the marginal sample it "
          "came from; and the whole table is unchanged by permuting a held-out "
          "outcome while a training-season outcome moves it")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    if not args.selftest:
        parser.error("this module is a library: --selftest is the only action")
    selftest()
    return 0


if __name__ == "__main__":
    sys.exit(main())
