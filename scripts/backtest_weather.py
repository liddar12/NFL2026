"""R94 WEATHER EFFECT, POWER-GATED (MEASURE ONLY).

The owner's order (2026-09-20):

  "Rain has to matter. The ball is wet, the QB's numbers should be down and
   it's harder to catch. Call it 8% off in heavy rain. Is that in the model?"

This file answers that with numbers instead of an opinion, and the first thing
it answers is a question the order did not ask: WHAT IS THE UNIT. The shipped
code already carries the folklore - scripts/signals/weather.py holds an 8%
passing haircut as a constant and has zero call sites - and the reason it has
never been measured is that at the GAME level this corpus cannot resolve it.
Thirty-four wet games is not a sample, it is an anecdote with a standard error.
The whole of this file exists because the SAME thirty-four games carry a few
thousand PASS ATTEMPTS, and a completion is a Bernoulli trial whether or not
the game around it is one of thirty-four.

So: the denominator is an attempt or a target, never a game.

WHAT THIS RUN DOES AND DOES NOT DO. It measures. It adopts nothing, registers
no signal family, writes no model parameter and changes no live number. The
artifact's verdict.adopted is pinned false by the contract, and verdict
.families_registered is pinned empty, so the document cannot record an adoption
even if a future edit to this file tried to claim one. Anything that reads like
a recommendation is a recommendation for a human, made mechanically, with the
arithmetic on the page.

THE POWER STAGE RUNS FIRST. Before a single coefficient is fitted, every term
gets an MDE computed on THE SAMPLE IT WILL BE FITTED ON, and a powered flag
that is simply "is the smallest effect this sample could see no larger than the
effect being claimed". An underpowered term is then structurally incapable of
returning would_adopt true however large its measured coefficient, because
clause 1 of the adoption criterion reads that flag. This ordering is the point:
a power calculation done after seeing the estimate is not a power calculation.

A STRATIFIED PRIMARY IS POWERED ON ITS STRATIFIED n. Rain and wind travel
together, so a marginal rain coefficient is partly a wind coefficient wearing a
rain label. The primary rain estimate is therefore taken inside the stratum
wind < 20 kph and temp > 5 C - and that stratum costs 274 of 874 games and
takes the wet cell from 34 games to 18. Powering the term on the 34 and
estimating it on the 18 is exactly how a design gets sold on power it does not
have; power_table takes the analysis sample as an argument for that reason and
this file passes it the stratum.

A WIND TERM IS NOT STRATIFIED ON WIND. Stratifying a slope on its own predictor
leaves no predictor spread inside the stratum, the slope SE is then division by
zero, and the term reads unpowered for an arithmetical reason rather than a
physical one. The wind terms use WIND_STRATUM (temperature and precipitation
only) and say so in the artifact's policy.

SUBSTRATE (four feeds, joined on the repo's one game key):

  * data/weather_history.json, read through scripts/weather_corpus.py. The
    relocation filter lives in THAT READER and never on disk: the file is not
    rewritten, refiltered or refetched, and its sha256 is reported so the claim
    is checkable. 893 rows read, 19 dropped as neutral-site relocations (a game
    played indoors in another city carries the weather of a stadium nobody was
    in), 874 kept, and every one of the 874 is independently confirmed
    'outdoors' by nflverse's own roof column.

  * data/epa_history.json - off_pass_plays and off_pass_epa per team-week, the
    dropback count and the efficiency outcome.

  * data/dvp_positional_history.json - the per-team-week fantasy points each
    position GROUP actually scored, which is the points-level outcome.

  * data/fixtures/wet_rates/*.json, built by scripts/build_wet_rates.py - the
    play-level counters (completions, attempts, targets, receptions, sacks)
    that weekly_actuals.json throws away. This is the only feed that needs a
    pull the repo does not do on every run; when it is absent, or when it is
    the committed synthetic placeholder, build_wet_rates.available() says no
    and every rate term reports substrate_unavailable rather than measuring on
    hand-made numbers.

ESTIMATOR - one estimator for every term, which is why the terms are
comparable. A within-group weighted least squares slope: each passer against
his own games in the same season, each team against its own games in the same
season, weighted by the denominator that carries the precision. The group mean
absorbs player quality, scheme and home stadium in one step, which is the only
defence in this build that reaches the geographic confound (CLE alone supplies
about a quarter of the windy games). For a 0/1 treatment the slope IS the
denominator-weighted wet-minus-dry contrast; for a continuous predictor it is
the within-group regression coefficient per 10 kph. Same code, same sandwich.

INFERENCE - CR1 cluster-robust, computed TWICE: clustered on the walk-forward
folds and clustered on the home stadium. The binding threshold is the LARGER
THRESHOLD, not the larger SE. Taking the larger SE with its own degrees of
freedom can hand back a LOWER bar - at 3 df against 20 df the t multiplier is
roughly twice as large, so a fold SE up to about 2.26x the stadium SE still
produces the easier threshold - and a rule that can be gamed by choosing a
clustering is not a rule.

FOLDS - five seasons, four scored. Fold Y is scored on season Y with
fit_seasons strictly before Y; the first fold has nothing before it, fits
nothing, and is reported neutral-and-counted rather than quietly dropped. The
power stage reads outcome-bearing quantities (baseline rate, ICC, outcome sd)
from TRAINING_SEASONS only, never from the held-out season, which is what makes
the power table invariant to permuting held-out outcomes.

ARMS:

  MECHANISM  rain and wind as per-attempt rates and per-team-game values,
             within-player or within-team, stratified where stated.
  CONTROL    does the weather factor the repo ALREADY ships earn its place?
             The deployed split is re-priced with its weather inputs removed -
             through the deployed code, with no monkey-patching and no edit to
             scripts/build_weekly.py - and scored against the shipped split and
             against a flat split on the same 8,279 rows.
  PLACEBO    the identical estimator on roofed team-games handed the weather of
             a matched outdoor game in the same season-week. A diagnostic with
             its own interval, NEVER a pass/fail threshold: it is a ratio of
             two noisy point estimates and reads as a coin flip in both
             directions.
  REACH      deterministic propagation of a measured effect through the
             deployed renormalisation identity to prop mu, to z, to leg-pool
             rung probability, so "real but immaterial" is a verdict with a
             count behind it rather than a shrug.

LIMITS are in the LIMITS constant and are reported in the artifact. The one
that has to be read before any number is quoted: precip_mm is a single hourly
value at the kickoff hour and, by the archive API's own convention, it is the
sum over the hour BEFORE kickoff. It is roughly the rain before the game rather
than during it, snow enters only as liquid-water equivalent, and the coldest
windiest game in the corpus records 0.0. That attenuates a true effect toward
zero, so a null here BOUNDS the effect; it does not disprove it.

Stdlib only. Nothing here reads a market number: the games_meta join is through
weather_corpus's positive allow-list of seven columns, and no other feed in
this file carries a price.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_wet_rates as wr                       # noqa: E402
from scripts import weather_corpus as wc                        # noqa: E402
from scripts import weather_power as wp                         # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "weather_backtest.json")
EPA_PATH = os.path.join(DATA, "epa_history.json")
DVP_PATH = os.path.join(DATA, "dvp_positional_history.json")
LEG_POOL_PATH = os.path.join(DATA, "leg_pool.json")
LEG_POOL_BACKTEST_PATH = os.path.join(DATA, "leg_pool_backtest.json")
PLAYER_WEEKLY_PATH = os.path.join(DATA, "player_weekly.json")
FORECAST_PATH = os.path.join(DATA, "weather_forecast.json")
ACTUALS_PATH = os.path.join(DATA, "fixtures", "backtest_weekly", "weekly_actuals.json")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
SCHEMA_PATH = os.path.join(DATA, "contracts", "weather_backtest.schema.json")

# The script fetches nothing. --cache-dir is where it will look for a wet-rates
# corpus built OUTSIDE the repo (build_wet_rates.py --out-dir <dir>), so a
# measurement can be taken on a real pull without committing 11 MB of derived
# data. Under TMPDIR so a run cannot dirty the tree.
DEFAULT_CACHE_DIR = os.path.join(
    os.environ.get("TMPDIR") or "/tmp", "nflverse_cache", "wet_rates")

KIND = "weather_backtest"

SEASONS = wc.SEASONS                      # (2021, 2022, 2023, 2024, 2025)
# Fold Y is scored on season Y with fit_seasons strictly before it. 2021 has
# nothing before it: it fits nothing, is NEUTRAL, and is counted as such.
SCORED_FOLDS = tuple(s for s in SEASONS if s > SEASONS[0])
# The seasons whose OUTCOMES the power stage may read. Every season that is a
# fit season for some scored fold, and never the final held-out season - which
# is what the permutation acceptance test moves.
TRAINING_SEASONS = tuple(SEASONS[:-1])
HOLDOUT_SEASON = SEASONS[-1]

# THE POWER STAGE IS COMPUTED ON THE ROWS THE COEFFICIENT IS ACTUALLY FITTED
# ON, WHICH IS THE SCORED FOLDS AND NOTHING ELSE.
#
# R94 audit 2026-09-20, P0-A: this file used to build the analysis sample over
# all five SEASONS and hand THAT to the power stage, while every inference
# quantity - heldout_estimate, se_fold, se_stadium, binding_threshold,
# rows_moved, folds_sign - is computed on SCORED_FOLDS only. Season 2021 fits
# nothing; it is the neutral first fold. Counting its trials in n_treated
# inflated the denominator, shrank the SE and shrank the MDE, so `powered` was
# decided on 5 seasons of data that 4 seasons of estimation never saw. That is
# verbatim the defect weather_power.py's own docstring calls defect 3, and on
# the real corpus it was the difference between the primary reading
# powered: true (MDE 0.04553) and powered: false (MDE 0.05812) against the same
# 0.052 bar. Powering a term on rows it will never be fitted on is how a
# headline gets sold on power it does not have.
POWER_SEASONS = SCORED_FOLDS
# ...and the outcome-bearing quantities inside that sample still come from
# training seasons only. The intersection is what is left: the seasons that are
# both fitted on and not the held-out one.
POWER_TRAINING_SEASONS = tuple(s for s in TRAINING_SEASONS if s in POWER_SEASONS)
assert POWER_TRAINING_SEASONS and HOLDOUT_SEASON not in POWER_TRAINING_SEASONS

PRIMARY_MM = 1.0                          # the wet threshold the primary uses
HEAVY_MM = 2.5                            # "heavy rain" in the owner's words
WIND_TREATED_KPH = 20.0                   # the reporting split for a wind term
RB_WIND_KPH = 24.0                        # the SHIPPED rb_wind threshold, re-measured
# The week the selftest fixture plants its one relocation in. Outside the
# fixture's played weeks so nothing else collides with it.
RELOCATION_WEEK = 11

# The primary stratum, borrowed from the corpus reader so there is one
# definition of it in the repo.
STRATUM_PRIMARY = "primary"
STRATUM_WIND = "wind"
STRATUM_NONE = None
# A wind term may not be stratified on wind (see the docstring): inside such a
# stratum the predictor is nearly constant and the slope SE is a division by a
# vanishing number. Temperature and precipitation only.
WIND_STRATUM_MIN_TEMP_C = wc.STRATUM_MIN_TEMP_C
WIND_STRATUM_MAX_PRECIP_MM = PRIMARY_MM
STRATUM_RULES = {
    STRATUM_PRIMARY: wc.STRATUM_RULE,
    STRATUM_WIND: "temp > %g C and precip < %g mm (NOT stratified on wind: a "
                  "slope stratified on its own predictor has no predictor left)"
                  % (WIND_STRATUM_MIN_TEMP_C, WIND_STRATUM_MAX_PRECIP_MM),
}

MIN_FIRED = 30                            # adoption clause 2
MOVE_EPS = 1e-9                           # adoption clause 6: what "moved" means
# Clause 5 compares two ESTIMATES against a CI half-width. When the estimator is
# near-deterministic the half-width collapses toward zero and the comparison
# starts reading the last bits of a double as a confound: on the selftest
# fixture the marginal and stratified coefficients agree to 5e-17 while the
# half-width is 4e-17, and the term refused as "confounded" on nothing at all.
# Two estimates that agree to floating point have not disagreed.
EST_EPS = 1e-12
MIN_LADDER_BANDS = 3                      # a dose-response needs a shape to have
# A BAND HAS TO WEIGH SOMETHING BEFORE IT IS ALLOWED TO VOTE.
#
# R94 audit 2026-09-20, P1-B: is_monotone had no minimum cell size, so a band
# holding one row carried exactly the weight of a band holding 1,264, and
# clause 4 is conjunctive in both directions - a single-row cell could both
# certify AND refuse a dose-response. On the real corpus the primary's
# non_monotone refusal rested on precip_light at n 6. Bands under this floor
# are now dropped from the ladder's shape exactly the way empty bands already
# were: they are still PUBLISHED, with their n, because an under-weighted cell
# is a fact about the corpus and hiding it would be the other kind of lie.
MIN_BAND_N = 10
FOLD_SIGN_MIN = 3                         # adoption clause 7: 3 of the 4 folds
ALPHA = wp.ALPHA                          # 0.05, one-sided, BEFORE multiplicity
CI_LEVEL = 0.95

# Inclusion floors for a within-group contrast, in the group's own denominator.
# A passer with four dropbacks in the rain tells you nothing about a passer;
# eight is the smallest number at which a per-attempt rate is not simply the
# outcome of one play. A receiver needs two targets for the same reason.
MIN_PASS_DENOM = 8
MIN_TARGET_DENOM = 2
MIN_VALUE_DENOM = 1                       # a team-game is already one unit

# The outcome-side floor, PER OUTCOME IN THAT OUTCOME'S OWN UNITS. This is not
# promote_signals.MIN_EFFECT: that constant is a log-loss floor and applying it
# to a coefficient measured in percentage points or fantasy points is a units
# category error. Each number below is the smallest effect that could change
# anything a human looks at, with the reasoning beside it.
EFFECT_FLOOR = {
    # Half a percentage point on a ~64% completion base is under 1% relative.
    # Below that a per-attempt effect cannot move a weekly projection by a
    # tenth of a point, so it is not a finding, it is a rounding difference.
    "completion_rate": 0.005,
    "catch_rate": 0.005,
    # A quarter of a fantasy point: the rounding grain of every projection the
    # app displays (data/player_weekly.json rounds to 2 dp but the leg pool's
    # ladder steps in 10-yard rungs, which is ~0.4 QB points).
    "qb_fantasy_points": 0.25,
    "rb_fantasy_points": 0.25,
    # 0.01 EPA per dropback per 10 kph. Over the corpus's 0-43 kph range that
    # is 0.04 EPA/db end to end, about a third of the descriptive spread; a
    # slope below it cannot be told from the season-to-season wobble.
    "epa_per_dropback": 0.01,
    # Half a dropback per 10 kph. A team-game averages ~35 dropbacks, so half a
    # dropback is the smallest change that survives integer play-calling.
    "dropbacks_per_team_game": 0.5,
}

# The effect of interest - the size of the claim being tested - for the outcomes
# the owner's 8% says nothing about. weather_power.EFFECT_OF_INTEREST already
# carries completion_rate, catch_rate and qb_fantasy_points as the 8% restated
# on each outcome's own base; these four are declared HERE, on the term, with
# their reasoning, because a defaulted bar is how an underpowered term acquires
# a powered:true flag that a closed contract then records as a fact.
EOI_EPA_PER_10KPH = 0.033      # the descriptive calm-to-gale EPA/db spread in
                               # this corpus is ~0.115 over ~35 kph. A wind term
                               # smaller than the pattern that motivated it is
                               # not the term anyone asked for.
EOI_DROPBACKS_PER_10KPH = 1.0  # the 5.8% dropback cut above 24 kph that
                               # motivated the term is ~2 dropbacks on a ~35
                               # dropback mean, over roughly 20 kph of wind.
EOI_RB_WIND_POINTS = 1.0       # the SHIPPED rb_wind 0.95 multiplier on a ~20
                               # point RB group is ~1.0 points. The bar is the
                               # size of the penalty that already ships, because
                               # the question is whether that penalty is real.

# ---------------------------------------------------------------------------
# The immutable hypothesis grid
# ---------------------------------------------------------------------------
# PRE-REGISTERED AND IMMUTABLE. The multiplicity divisor is len(HYPOTHESES), so
# the unit charged is the HYPOTHESIS and never a threshold, a band or an
# outcome: adding resolution to a ladder cannot move any term's bar. Adding a
# ROW does, which is the correct incentive.
#
# Fields:
#   kind          "rate" (a binomial on num/den) or "value" (a per-unit number)
#   unit          "player_week" or "team_game" - what one row is
#   group         the within-group key: pairing absorbs quality and venue
#   treatment     "threshold" (0/1) or "continuous" (per 10 kph)
#   stratum       which stratum the PRIMARY estimate is taken in
#   sign          the pre-registered sign, fixed before any fit

HYPOTHESES = (
    {
        "name": "rain_completion_rate",
        "arm": "MECHANISM",
        "position": "QB",
        "unit": "player_week",
        "outcome": "completion_rate",
        "form": "rate ~ 1[precip >= %g mm], within passer-season, attempt-weighted"
                % PRIMARY_MM,
        "hypothesis": "A wet ball costs completion percentage. The owner's 8% on a "
                      "~64.5% base is 5.2 percentage points.",
        "sign": -1,
        "kind": "rate",
        "group": "player_season",
        "treatment": "threshold",
        "threshold_mm": PRIMARY_MM,
        "stratum": STRATUM_PRIMARY,
        "num": "completions",
        "den": "pass_attempts",
        "positions": ("QB",),
        "min_treated": MIN_PASS_DENOM,
        "min_control": MIN_PASS_DENOM,
        "ladder": "precip",
        "primary": True,
    },
    {
        "name": "rain_catch_rate_wr",
        "arm": "MECHANISM",
        "position": "WR",
        "unit": "player_week",
        "outcome": "catch_rate",
        "form": "rate ~ 1[precip >= %g mm], within receiver-season, target-weighted"
                % PRIMARY_MM,
        "hypothesis": "\"It's harder to catch\" - the owner's words. Same 8%, "
                      "restated on the catch-rate base.",
        "sign": -1,
        "kind": "rate",
        "group": "player_season",
        "treatment": "threshold",
        "threshold_mm": PRIMARY_MM,
        # Pre-registered MARGINAL, and honestly so: inside the primary stratum
        # the WR target count roughly halves and the MDE goes above the effect.
        # Reporting it marginal with confounded computed against the stratified
        # estimate is the truthful version of a term that is powered in one
        # sample and not the other.
        "stratum": STRATUM_NONE,
        "num": "receptions",
        "den": "targets",
        "positions": ("WR",),
        "min_treated": MIN_TARGET_DENOM,
        "min_control": MIN_TARGET_DENOM,
        "ladder": "precip",
    },
    {
        "name": "rain_catch_rate_te",
        "arm": "MECHANISM",
        "position": "TE",
        "unit": "player_week",
        "outcome": "catch_rate",
        "form": "rate ~ 1[precip >= %g mm], within receiver-season, target-weighted"
                % PRIMARY_MM,
        "hypothesis": "The same catch-rate claim on tight ends, pre-registered as "
                      "the thinner arm.",
        "sign": -1,
        "kind": "rate",
        "group": "player_season",
        "treatment": "threshold",
        "threshold_mm": PRIMARY_MM,
        "stratum": STRATUM_NONE,
        "num": "receptions",
        "den": "targets",
        "positions": ("TE",),
        "min_treated": MIN_TARGET_DENOM,
        "min_control": MIN_TARGET_DENOM,
        "ladder": "precip",
    },
    {
        "name": "rain_catch_rate_rb",
        "arm": "MECHANISM",
        "position": "RB",
        "unit": "player_week",
        "outcome": "catch_rate",
        "form": "rate ~ 1[precip >= %g mm], within receiver-season, target-weighted"
                % PRIMARY_MM,
        "hypothesis": "THE CONTROL POSITION. A wet ball should hurt a contested "
                      "20-yard target more than a checkdown at the line. A large "
                      "RB effect alongside a small WR effect is evidence of a "
                      "confound, not of the mechanism.",
        "sign": -1,
        "kind": "rate",
        "group": "player_season",
        "treatment": "threshold",
        "threshold_mm": PRIMARY_MM,
        "stratum": STRATUM_NONE,
        "num": "receptions",
        "den": "targets",
        "positions": ("RB",),
        "min_treated": MIN_TARGET_DENOM,
        "min_control": MIN_TARGET_DENOM,
        "ladder": "precip",
    },
    {
        "name": "rain_heavy_completion_rate",
        "arm": "MECHANISM",
        "position": "QB",
        "unit": "player_week",
        "outcome": "completion_rate",
        "form": "rate ~ 1[precip >= %g mm], within passer-season, attempt-weighted"
                % HEAVY_MM,
        "hypothesis": "The owner said HEAVY rain. Pre-registered NO_GO: 12 games "
                      "marginal and 5 inside the stratum. Measured anyway so the "
                      "bound is on the page rather than in a sentence.",
        "sign": -1,
        "kind": "rate",
        "group": "player_season",
        "treatment": "threshold",
        "threshold_mm": HEAVY_MM,
        "stratum": STRATUM_PRIMARY,
        "num": "completions",
        "den": "pass_attempts",
        "positions": ("QB",),
        "min_treated": MIN_PASS_DENOM,
        "min_control": MIN_PASS_DENOM,
        "ladder": "precip",
    },
    {
        "name": "wind_epa_per_dropback",
        "arm": "MECHANISM",
        "position": "TEAM",
        "unit": "team_game",
        "outcome": "epa_per_dropback",
        "form": "EPA/dropback ~ wind (per 10 kph), within team-season, "
                "dropback-weighted",
        "hypothesis": "The term the model genuinely lacks: weather_factor applies "
                      "roof and cold and no wind at all.",
        "sign": -1,
        "kind": "value",
        "group": "team_season",
        "treatment": "continuous",
        "stratum": STRATUM_WIND,
        "value": "epa_per_dropback",
        "weight": "dropbacks",
        "effect_of_interest": EOI_EPA_PER_10KPH,
        "min_treated": MIN_VALUE_DENOM,
        "min_control": MIN_VALUE_DENOM,
        "ladder": "wind",
    },
    {
        "name": "wind_dropback_volume",
        "arm": "MECHANISM",
        "position": "TEAM",
        "unit": "team_game",
        "outcome": "dropbacks_per_team_game",
        "form": "dropbacks ~ wind (per 10 kph), within team-season, unweighted",
        "hypothesis": "MANDATORY COMPANION. If wind cuts passing yards partly by "
                      "cutting the number of passes, then a yardage finding is "
                      "partly a coaching decision and must not be sold as physics.",
        "sign": -1,
        "kind": "value",
        "group": "team_season",
        "treatment": "continuous",
        "stratum": STRATUM_WIND,
        "value": "dropbacks",
        "weight": None,
        "effect_of_interest": EOI_DROPBACKS_PER_10KPH,
        "min_treated": MIN_VALUE_DENOM,
        "min_control": MIN_VALUE_DENOM,
        "ladder": "wind",
    },
    {
        "name": "wind_qb_points",
        "arm": "MECHANISM",
        "position": "QB",
        "unit": "team_game",
        "outcome": "qb_fantasy_points",
        "form": "QB group points ~ wind (per 10 kph), within team-season, unweighted",
        "hypothesis": "The points-level version of the wind term, which is what a "
                      "projection would actually carry.",
        "sign": -1,
        "kind": "value",
        "group": "team_season",
        "treatment": "continuous",
        "stratum": STRATUM_WIND,
        "value": "qb_points",
        "weight": None,
        "min_treated": MIN_VALUE_DENOM,
        "min_control": MIN_VALUE_DENOM,
        "ladder": "wind",
    },
    {
        "name": "rain_qb_points",
        "arm": "MECHANISM",
        "position": "QB",
        "unit": "team_game",
        "outcome": "qb_fantasy_points",
        "form": "QB group points ~ 1[precip >= %g mm], within team-season, unweighted"
                % PRIMARY_MM,
        "hypothesis": "PRE-REGISTERED NO_GO, and the reason this whole build moved "
                      "to the play level: 68 wet team-games against a 7.7 point sd "
                      "can only see an effect twice the size of the one claimed.",
        "sign": -1,
        "kind": "value",
        "group": "team_season",
        "treatment": "threshold",
        "threshold_mm": PRIMARY_MM,
        "stratum": STRATUM_PRIMARY,
        "value": "qb_points",
        "weight": None,
        "min_treated": MIN_VALUE_DENOM,
        "min_control": MIN_VALUE_DENOM,
        "ladder": "precip",
    },
    {
        "name": "rb_wind_reprice",
        "arm": "MECHANISM",
        "position": "RB",
        "unit": "team_game",
        "outcome": "rb_fantasy_points",
        "form": "RB group points ~ 1[wind >= %g kph], within team-season, unweighted"
                % RB_WIND_KPH,
        "hypothesis": "A LIVE NUMBER, re-measured. build_weekly ships rb_wind 0.95 "
                      "above %g kph and descriptively RBs score MORE in wind than "
                      "in calm. This run measures the sign; it does not change the "
                      "constant." % RB_WIND_KPH,
        "sign": -1,
        "kind": "value",
        "group": "team_season",
        "treatment": "threshold",
        "threshold_kph": RB_WIND_KPH,
        "stratum": STRATUM_NONE,
        "value": "rb_points",
        "weight": None,
        "effect_of_interest": EOI_RB_WIND_POINTS,
        "min_treated": MIN_VALUE_DENOM,
        "min_control": MIN_VALUE_DENOM,
        "ladder": "wind",
    },
)

N_TESTS = len(HYPOTHESES)
PRIMARY_TERM = next(h["name"] for h in HYPOTHESES if h.get("primary"))

# The exact clause names the contract's refused_reasons enum admits. One name
# per adoption clause plus two substrate refusals, so a reader can map a refusal
# back to the numbered clause that produced it without reading this file.
REFUSAL_UNDERPOWERED = "underpowered"                  # clause 1
REFUSAL_TOO_FEW_FIRED = "too_few_fired"                # clause 2
REFUSAL_WRONG_SIGN = "wrong_sign"                      # clause 3
REFUSAL_NON_MONOTONE = "non_monotone"                  # clause 4
REFUSAL_CONFOUNDED = "confounded"                      # clause 5
REFUSAL_NO_ROWS_MOVED = "no_rows_moved"                # clause 6
REFUSAL_FOLD_SIGN = "fold_sign_disagrees"              # clause 7
REFUSAL_BELOW_THRESHOLD = "below_threshold"            # clause 8
REFUSAL_UNAVAILABLE = "substrate_unavailable"
REFUSAL_UNESTIMABLE = "unestimable"
REFUSALS = (REFUSAL_UNDERPOWERED, REFUSAL_TOO_FEW_FIRED, REFUSAL_WRONG_SIGN,
            REFUSAL_NON_MONOTONE, REFUSAL_CONFOUNDED, REFUSAL_NO_ROWS_MOVED,
            REFUSAL_FOLD_SIGN, REFUSAL_BELOW_THRESHOLD, REFUSAL_UNAVAILABLE,
            REFUSAL_UNESTIMABLE)

VERDICT_NOT_POWERED = "not_powered"
VERDICT_NONE = "none"
VERDICT_IMMATERIAL = "real_but_immaterial"
VERDICT_NAMES = tuple([h["name"] for h in HYPOTHESES] +
                      [VERDICT_NONE, VERDICT_NOT_POWERED, VERDICT_IMMATERIAL])

# The pool's own calibration error, from data/leg_pool_backtest.json
# reliability.refit.ece. A rung whose probability moves by less than the pool's
# own miscalibration has not moved in any sense a bettor could act on.
POOL_ECE = 0.0066

ROUND_DP = 6

POLICY = [
    "MEASUREMENT ONLY. This run adopts nothing, registers no signal family and "
    "writes no model parameter: data/model_tuning.json game_params is untouched, "
    "verdict.adopted is pinned false by the contract and families_registered is "
    "pinned empty.",
    "The power stage runs BEFORE any coefficient is fitted and every term is "
    "powered on the analysis sample it is estimated on. A stratified primary is "
    "powered on its stratified n; powering on the marginal n and estimating on "
    "the stratum is the defect this ordering exists to prevent.",
    "The analysis sample the power stage reads is the SCORED rows and only "
    "those. The neutral first fold fits no coefficient, so its trials may not "
    "count toward an n that claims to describe the estimation sample; "
    "substrate.power_seasons names the seasons counted and power.n_treated "
    "equals terms.n_wet on exactly those rows.",
    "Powered requires BOTH minimum detectable effects. The model-based MDE is a "
    "pooled two-arm binomial with the measured design effect; the realized MDE "
    "is mde_z times the estimator's own binding clustered error. On this corpus "
    "the model SE runs well below the realized one, so publishing powered on "
    "the model number alone asserts a detection capability the estimator does "
    "not have.",
    "The dose-response ladder is tabulated on the SCORED rows, like every other "
    "published quantity, and a band under adoption_rule.min_band_n rows is then "
    "dropped from the ladder's SHAPE the way an empty band already was, while "
    "still being published with its n. Clause 4 is conjunctive in both "
    "directions, so a one-row cell would otherwise be able to certify or refuse "
    "a dose-response by itself, and a band the estimator never saw would be "
    "able to decide a clause about the estimate.",
    "A wind term is never stratified on wind. Stratifying a slope on its own "
    "predictor removes the predictor spread the slope is estimated from, and the "
    "term would then read unpowered for an arithmetical reason rather than a "
    "physical one.",
    "The binding threshold is the LARGER THRESHOLD of the fold-clustered and "
    "stadium-clustered tests, not the larger standard error. At 3 degrees of "
    "freedom against 20 the larger SE can carry the lower bar, so choosing on SE "
    "is choosing the clustering that adopts.",
    "Every estimate is within-player-season or within-team-season. The group mean "
    "absorbs player quality, scheme and home stadium, which is the only defence "
    "here that reaches the geographic concentration of bad weather.",
    "The relocation filter lives in the reader: data/weather_history.json is never "
    "rewritten, refiltered or refetched, and its sha256 is reported in this "
    "document so the claim can be checked rather than believed.",
    "Any winner carries oracle_only true. The effect arm is fitted on reanalysis "
    "weather - perfect foresight - so a NULL under a perfect forecast is "
    "conclusive and a WIN under one is not adoptable evidence.",
    "No market number is read anywhere in this document. The games_meta join runs "
    "through weather_corpus's seven-column allow-list and no other feed here "
    "carries a price.",
]

LIMITS = list(wc.CORPUS_LIMITS) + [
    "The rate substrate needs an nflverse release pull the repo does not perform "
    "on every run. When it is absent, or when it is the committed synthetic "
    "placeholder, every rate term reports substrate_unavailable rather than "
    "measuring on hand-made numbers - which is why an artifact from a fresh clone "
    "carries no completion-rate finding.",
    "Four scored folds give the fold-clustered test three degrees of freedom, and "
    "at alpha 0.05 / %d hypotheses one-sided that is a t multiplier of about 5.8 "
    "against about 2.9 on the stadium clustering's ~20 df. The binding threshold "
    "is therefore roughly six standard errors wide on most terms, which on the "
    "primary is about 20 percentage points of completion rate. NOTHING on this "
    "corpus clears that, so a 'none' verdict here means 'not proven with four "
    "folds', never 'no effect'. Extending the corpus backwards buys folds as well "
    "as games, and that is the single change that would most alter this "
    "document." % N_TESTS,
    "The placebo arm assigns a roofed game the weather of a matched outdoor game "
    "in the same season-week. That is the cleanest construction available and it "
    "is still a judgement call, not a randomised assignment: read a small placebo "
    "coefficient as weak reassurance and never as a clean bill of health.",
    "A dropback here is attempts + sacks. Scrambles are not separable in this "
    "substrate - they sit in the rushing counters - so a scramble in the rain "
    "leaves the passing denominator entirely.",
    "The REACH arm is computed on ONE live slate and names it. Rung counts differ "
    "week to week and must never be read as a season-long frequency.",
    "The CONTROL arm removes the weather inputs from the deployed split and lets "
    "the split renormalise. Because it renormalises to the player's season total, "
    "a weather factor can never lower that total - it only moves points between a "
    "player's own weeks - so the CONTROL arm measures allocation, not level.",
]


# ---------------------------------------------------------------------------
# Substrate
# ---------------------------------------------------------------------------

def _load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def load_epa(doc=None, path=EPA_PATH):
    """{(season, week, team): {'dropbacks': float, 'pass_epa': float}}.

    A dropback is off_pass_plays: the attempts plus the sacks the play-by-play
    recorded as pass plays. A team-week with no pass plays is absent, never a
    zero, because a zero denominator is not an observation of a rate.
    """
    doc = doc if doc is not None else _load_json(path)
    out = {}
    for season_s, teams in ((doc or {}).get("seasons") or {}).items():
        for team, weeks in (teams or {}).items():
            for week_s, rec in (weeks or {}).items():
                plays = rec.get("off_pass_plays")
                if not plays:
                    continue
                out[(int(season_s), int(week_s), team)] = {
                    "dropbacks": float(plays),
                    "pass_epa": float(rec.get("off_pass_epa") or 0.0),
                }
    return out


def load_dvp_points(doc=None, path=DVP_PATH):
    """{(season, week, team): {POS: points}} - the points each position GROUP
    actually scored for that team that week (the `off` side of the DvP table)."""
    doc = doc if doc is not None else _load_json(path)
    out = {}
    for season_s, teams in ((doc or {}).get("seasons") or {}).items():
        for team, weeks in (teams or {}).items():
            for week_s, rec in (weeks or {}).items():
                off = (rec or {}).get("off") or {}
                if not off:
                    continue
                out[(int(season_s), int(week_s), team)] = {
                    k: float(v) for k, v in off.items() if v is not None}
    return out


def matched_placebo_weather(placebo_keys, weather_rows):
    """{placebo key: the weather row of a matched outdoor game}.

    A roofed game has no weather of its own worth measuring - that is the whole
    point of it as a placebo - so it is handed the weather of an outdoor game in
    the SAME season and week. The match is deterministic (both lists sorted, the
    i-th roofed game takes the i-th outdoor game modulo its length) so the arm
    is reproducible and no seed is involved. A season-week with no outdoor game
    at all yields no placebo row, and that is reported as a count.
    """
    by_week = {}
    for key, row in weather_rows.items():
        by_week.setdefault((row["season"], row["week"]), []).append(key)
    for keys in by_week.values():
        keys.sort()
    grouped = {}
    for key in placebo_keys:
        season, week = int(key.split("|")[0]), int(key.split("|")[1])
        grouped.setdefault((season, week), []).append(key)
    out = {}
    for slot, keys in sorted(grouped.items()):
        donors = by_week.get(slot) or []
        if not donors:
            continue
        for i, key in enumerate(sorted(keys)):
            out[key] = weather_rows[donors[i % len(donors)]]
    return out


def _stadium_of(row):
    """The stadium cluster for a row: the venue the game was PLAYED in. Windy
    games concentrate in a handful of them, which is exactly why this is a
    clustering variable and not a control."""
    return row.get("stadium") or ("venue:" + row["home"])


def team_game_rows(weather_rows, epa, dvp, bucket, weather_by_key=None):
    """Two rows per game - one per side - carrying every team-level outcome.

    `weather_by_key` lets the placebo arm hand a roofed game the weather of a
    matched outdoor one while everything else about the row stays its own.
    """
    rows = []
    for key, game in sorted(weather_rows.items()):
        wx = (weather_by_key or {}).get(key, game)
        season, week = game["season"], game["week"]
        for side in ("home", "away"):
            team = game[side]
            opp = game["away" if side == "home" else "home"]
            e = epa.get((season, week, team))
            pts = dvp.get((season, week, team)) or {}
            if e is None:
                continue
            rows.append({
                "game_key": key,
                "season": season,
                "week": week,
                "team": team,
                "opp": opp,
                "side": side,
                "stadium": _stadium_of(game),
                "bucket": bucket,
                "precip_mm": float(wx["precip_mm"]),
                "temp_c": float(wx["temp_c"]),
                "wind_kph": float(wx["wind_kph"]),
                "dropbacks": e["dropbacks"],
                "epa_per_dropback": e["pass_epa"] / e["dropbacks"],
                "qb_points": pts.get("QB"),
                "rb_points": pts.get("RB"),
                "wr_points": pts.get("WR"),
                "te_points": pts.get("TE"),
                "team_season": "%s|%d" % (team, season),
            })
    return rows


def player_week_rows(weather_rows, player_doc, bucket, weather_by_key=None):
    """One row per (player, week) inside a weather-carrying game.

    The wet-rates player document keys as '{week}|{team}|{pid}', so the join to
    a game is exact: both of a game's teams are named in the game key. A row
    with no passing and no receiving denominator never enters, because a rate
    with a zero denominator is not an observation.
    """
    if not player_doc:
        return []
    rows = []
    by_season = {}
    for season_s, season_rows in (player_doc.get("rows") or {}).items():
        by_team = by_season.setdefault(int(season_s), {})
        for row_key, row in season_rows.items():
            week_s, team = row_key.split("|")[0], row_key.split("|")[1]
            by_team.setdefault((int(week_s), team), []).append((row_key, row))
    for key, game in sorted(weather_rows.items()):
        wx = (weather_by_key or {}).get(key, game)
        season, week = game["season"], game["week"]
        for side in ("home", "away"):
            team = game[side]
            for row_key, row in (by_season.get(season, {}).get((week, team)) or []):
                attempts = float(row.get("attempts") or 0.0)
                sacks = float(row.get("sacks") or 0.0)
                targets = float(row.get("targets") or 0.0)
                if attempts <= 0.0 and targets <= 0.0:
                    continue
                pid = row_key.split("|")[2]
                rows.append({
                    "game_key": key,
                    "season": season,
                    "week": week,
                    "team": team,
                    "pid": pid,
                    "pos": row.get("pos"),
                    "stadium": _stadium_of(game),
                    "bucket": bucket,
                    "precip_mm": float(wx["precip_mm"]),
                    "temp_c": float(wx["temp_c"]),
                    "wind_kph": float(wx["wind_kph"]),
                    "completions": float(row.get("completions") or 0.0),
                    "pass_attempts": attempts,
                    "dropbacks": attempts + sacks,
                    "receptions": float(row.get("receptions") or 0.0),
                    "targets": targets,
                    "player_season": "%s|%d" % (pid, season),
                })
    return rows


def in_stratum(row, stratum):
    """Is this row inside the named stratum? STRATUM_NONE is the marginal
    sample and admits everything."""
    if stratum is None:
        return True
    if stratum == STRATUM_PRIMARY:
        return wc.in_stratum(row)
    if stratum == STRATUM_WIND:
        return (row["temp_c"] > WIND_STRATUM_MIN_TEMP_C
                and row["precip_mm"] < WIND_STRATUM_MAX_PRECIP_MM)
    raise ValueError("unknown stratum %r" % (stratum,))


# ---------------------------------------------------------------------------
# Power (runs FIRST, before any coefficient is fitted)
# ---------------------------------------------------------------------------

def term_x(term, row):
    """The treatment value for one row, in the units the coefficient is
    reported in: 0/1 for a threshold term, kph/10 for a continuous one."""
    if term["treatment"] == "threshold":
        return 1.0 if term_treated(term, row) else 0.0
    return float(row["wind_kph"]) / 10.0


def term_treated(term, row):
    """The 0/1 treatment, and for a continuous term the REPORTING split that
    n_wet / n_dry are counted on."""
    if "threshold_mm" in term:
        return float(row["precip_mm"]) >= float(term["threshold_mm"])
    if "threshold_kph" in term:
        return float(row["wind_kph"]) >= float(term["threshold_kph"])
    return float(row["wind_kph"]) >= WIND_TREATED_KPH


def term_weight(term, row):
    """The precision weight on one row: the denominator for a rate, the named
    weight column for a value term, 1.0 when the term declares none."""
    if term["kind"] == "rate":
        return float(row[term["den"]])
    col = term.get("weight")
    return 1.0 if col is None else float(row[col])


def term_y(term, row):
    """The outcome for one row: the rate for a rate term, the value column for a
    value term. None when the row carries no outcome (a DvP table with no row
    for that team-week), which drops the row rather than reading it as zero."""
    if term["kind"] == "rate":
        den = float(row[term["den"]])
        if den <= 0.0:
            return None
        return float(row[term["num"]]) / den
    val = row.get(term["value"])
    return None if val is None else float(val)


def term_rows(term, rows):
    """The term's ANALYSIS SAMPLE: rows of the right unit and position, inside
    the term's stratum, carrying an outcome and a positive weight, and belonging
    to a group that clears BOTH inclusion floors.

    Nothing here reads an outcome VALUE to decide inclusion - only denominators,
    positions and weather - so building the sample before the power stage leaks
    nothing into it.
    """
    positions = term.get("positions")
    pool = []
    for row in rows:
        if positions and row.get("pos") not in positions:
            continue
        if not in_stratum(row, term["stratum"]):
            continue
        w = term_weight(term, row)
        if w <= 0.0:
            continue
        if term_y(term, row) is None:
            continue
        pool.append(row)
    # Floors are on the GROUP: a passer needs eight dropbacks on both sides of
    # the contrast before his own difference means anything.
    by_group = {}
    for row in pool:
        by_group.setdefault(row[term["group"]], []).append(row)
    keep = []
    for group_rows in by_group.values():
        if term["treatment"] == "continuous":
            # A SLOPE IS IDENTIFIED BY PREDICTOR SPREAD, NOT BY A 0/1 SPLIT.
            # term_treated's >= WIND_TREATED_KPH line exists only to report
            # n_wet and n_dry; making a group clear a floor on BOTH sides of
            # that line would throw away every team-season that never happened
            # to play in a gale - and those are precisely the groups that pin
            # the calm end of the slope. The first draft of this file did that
            # and every wind term measured an empty sample.
            xs = [term_x(term, r) for r in group_rows]
            if max(xs) - min(xs) <= 0.0:
                continue         # no predictor spread inside the group
            if sum(term_weight(term, r) for r in group_rows) <= 0.0:
                continue
        else:
            treated_w = sum(term_weight(term, r) for r in group_rows
                            if term_treated(term, r))
            control_w = sum(term_weight(term, r) for r in group_rows
                            if not term_treated(term, r))
            if treated_w < term["min_treated"] or control_w < term["min_control"]:
                continue
        keep.extend(group_rows)
    keep.sort(key=lambda r: (r["season"], r["week"], r["game_key"],
                             r.get("pid") or r.get("team") or ""))
    return keep


def power_spec(term):
    """The term spec weather_power.power_table wants, built from the hypothesis
    so the two can never drift apart."""
    spec = {
        "name": term["name"],
        "outcome": term["outcome"],
        "cluster": "game_key",       # rain treats BOTH sides of a game at once
    }
    if term.get("effect_of_interest") is not None:
        spec["effect_of_interest"] = float(term["effect_of_interest"])
    if term["kind"] == "rate":
        spec.update({"kind": wp.TERM_RATE, "num": term["num"], "den": term["den"],
                     "treated": lambda r, t=term: term_treated(t, r)})
    else:
        spec.update({"kind": wp.TERM_SLOPE,
                     "x": lambda r, t=term: term_x(t, r),
                     "y": lambda r, t=term: float(r[t["value"]]),
                     "treated": lambda r, t=term: term_treated(t, r)})
    return spec


def scored_rows(rows, seasons=POWER_SEASONS):
    """The rows of an analysis sample that a coefficient is actually fitted on.

    The neutral first fold fits nothing, so its rows carry no coefficient and
    no error bar. Every published quantity that claims to describe the
    ESTIMATION sample - n_wet, n_dry, the power table's n_treated / n_control -
    is counted through here, so the claim and the estimate are the same sample.
    """
    keep = set(int(s) for s in seasons)
    return [r for r in rows if int(r["season"]) in keep]


def power_stage(samples, hypotheses=HYPOTHESES,
                training_seasons=POWER_TRAINING_SEASONS):
    """{term name: the ten published power fields}, computed BEFORE any fit.

    One power_table call per term, on that term's OWN analysis sample and with
    that sample's label, which is the whole reason weather_power takes the
    sample as an argument - and on the SCORED rows of that sample, which is the
    whole reason `scored_rows` exists (see POWER_SEASONS).
    """
    table = {}
    for term in hypotheses:
        sample = scored_rows(samples.get(term["name"]) or [])
        label = "marginal" if term["stratum"] is None else "stratified"
        one = wp.power_table(sample, [power_spec(term)], training_seasons, label)
        table[term["name"]] = one[term["name"]]
    return table


# ---------------------------------------------------------------------------
# Estimation
# ---------------------------------------------------------------------------

def contributions(term, rows):
    """The per-row sandwich pieces of a within-group weighted slope.

    beta = sum(S_i) / sum(H_i) with S_i = w_i * xd_i * yd_i and
    H_i = w_i * xd_i^2, where xd and yd are deviations from that row's GROUP
    mean (weighted). Writing the estimator row-separably is what lets the same
    numbers be re-clustered on the fold and on the stadium without refitting:
    a CR1 sandwich only ever needs the score of each observation and the label
    it belongs to.

    For a 0/1 treatment this is exactly the denominator-weighted wet-minus-dry
    contrast within the group, with the harmonic weight w1*w0/(w1+w0) - the
    precision weight, not the treated weight.
    """
    by_group = {}
    for row in rows:
        by_group.setdefault(row[term["group"]], []).append(row)
    out = []
    for group_rows in by_group.values():
        ws, xs, ys = [], [], []
        for row in group_rows:
            ws.append(term_weight(term, row))
            xs.append(term_x(term, row))
            ys.append(term_y(term, row))
        tot = sum(ws)
        if tot <= 0.0:
            continue
        xbar = sum(w * x for w, x in zip(ws, xs)) / tot
        ybar = sum(w * y for w, y in zip(ws, ys)) / tot
        for row, w, x, y in zip(group_rows, ws, xs, ys):
            xd = x - xbar
            out.append({
                "row": row,
                "fold": row["season"],
                "stadium": row["stadium"],
                "S": w * xd * (y - ybar),
                "H": w * xd * xd,
            })
    return out


def point_estimate(contribs):
    """sum(S)/sum(H), or None when the predictor carries no within-group
    spread at all. NEVER 0.0 for an unestimable term: a zero would read as a
    measured null."""
    h = sum(c["H"] for c in contribs)
    if h <= 0.0:
        return None
    return sum(c["S"] for c in contribs) / h


def cluster_se(contribs, label):
    """(estimate, se, df, clusters) - CR1 cluster-robust on `label`.

    u_c = sum over the cluster of (S_i - beta*H_i); Var = G/(G-1) * sum(u_c^2)
    / (sum H)^2. One cluster carries no between-cluster variation and returns
    se None, which propagates to an unestimable threshold rather than to a
    small one.
    """
    beta = point_estimate(contribs)
    if beta is None:
        return None, None, 0, 0
    h = sum(c["H"] for c in contribs)
    per = {}
    for c in contribs:
        per[c[label]] = per.get(c[label], 0.0) + (c["S"] - beta * c["H"])
    g = len(per)
    if g < 2:
        return beta, None, max(g - 1, 0), g
    var = (g / (g - 1.0)) * sum(u * u for u in per.values()) / (h * h)
    return beta, math.sqrt(var) if var > 0.0 else 0.0, g - 1, g


def fold_estimates(contribs, folds=SCORED_FOLDS):
    """{season: estimate} over the SCORED folds only. The first fold fits
    nothing and is not scored; it is counted in the fold record instead."""
    out = {}
    for season in folds:
        part = [c for c in contribs if c["fold"] == season]
        out[season] = point_estimate(part)
    return out


def fold_records(seasons=SEASONS, folds=SCORED_FOLDS):
    """The walk-forward barrier, written down. Fold Y's fit_seasons are strictly
    before Y; the first fold's are empty, so it is NEUTRAL and COUNTED rather
    than silently dropped or quietly scored on itself."""
    records = []
    for season in seasons:
        fit = tuple(s for s in seasons if s < season)
        records.append({
            "season": season,
            "fit_seasons": list(fit),
            "scored": season in folds,
            "neutral": not fit,
        })
    return records


def threshold_for(se, df, floor, n_tests=N_TESTS, alpha=ALPHA):
    """max(EFFECT_FLOOR, t_crit * se), one-sided Student-t at alpha/n_tests on
    that clustering's own df. An absent SE has NO threshold - None, not the
    floor - so an unestimable term cannot clear a bar by having no error bar."""
    if se is None or df < 1:
        return None
    t_crit = _student_t_ppf(1.0 - alpha / float(n_tests), df)
    return max(float(floor), t_crit * float(se))


def _student_t_ppf(p, df):
    """promote_signals' own inverse-t, imported by assignment rather than
    re-implemented. Imported lazily because promote_signals is a heavy module
    and the selftest should not pay for it until it needs a number from it."""
    from scripts import promote_signals as ps
    return ps.student_t_ppf(p, df)


def binding(se_fold, df_fold, se_stadium, df_stadium, floor):
    """(threshold, df) - the LARGER THRESHOLD of the two clusterings.

    Not the larger SE. At df 3 the multiplier is about twice the df 20 one, so
    the fold clustering can carry a bigger SE and still produce the easier bar;
    choosing on SE is choosing the clustering that adopts. Taking the larger
    THRESHOLD is what makes the choice unexploitable.
    """
    t_fold = threshold_for(se_fold, df_fold, floor)
    t_stad = threshold_for(se_stadium, df_stadium, floor)
    if t_fold is None and t_stad is None:
        return None, None
    if t_stad is None or (t_fold is not None and t_fold >= t_stad):
        return t_fold, df_fold
    return t_stad, df_stadium


def dose_response(term, rows):
    """The five-band ladder: [{band, n, value}] in physical order, over THE
    ROWS THE COEFFICIENT IS FITTED ON.

    A band that never fired is PRESENT with n 0 and value None, because a
    missing band and an empty band are different facts and a contract that
    allowed the first could not tell them apart.

    The scored-fold filter lives HERE, inside the function, for the same reason
    it lives inside power_stage: so no caller can bypass it. Clause 4 decides
    adoption, and a clause decided on rows the estimator never used is the same
    defect as powering a term on rows it is not fitted on. Nothing this document
    publishes is computed on data the estimator did not see - the ladder was the
    last exception and is no longer one, which is why a band's n can never
    exceed its own term's n_treated_rows plus n_control_rows.
    """
    names = (wc.PRECIP_BAND_NAMES if term["ladder"] == "precip"
             else wc.WIND_BAND_NAMES)
    band_of = (wc.precip_band if term["ladder"] == "precip" else wc.wind_band)
    field = "precip_mm" if term["ladder"] == "precip" else "wind_kph"
    acc = {name: [0, 0.0, 0.0] for name in names}   # n, weight, weighted outcome
    for row in scored_rows(rows):
        y = term_y(term, row)
        if y is None:
            continue
        w = term_weight(term, row)
        slot = acc[band_of(row[field])]
        slot[0] += 1
        slot[1] += w
        slot[2] += w * y
    return [{"band": name,
             "n": acc[name][0],
             "value": (acc[name][2] / acc[name][1]) if acc[name][1] > 0.0 else None}
            for name in names]


def is_monotone(ladder, sign, min_bands=MIN_LADDER_BANDS, min_n=MIN_BAND_N):
    """Is the dose-response monotone in the claimed direction?

    Bands with no observation are skipped - an absent band is not a reversal -
    and so are bands UNDER THE FLOOR (`min_n` rows), for the same reason and by
    the same rule: a cell of one row is not an observation of a shape, it is one
    row, and clause 4 is conjunctive in both directions, so such a cell could
    both certify and refuse a dose-response on its own. Fewer than `min_bands`
    surviving bands is not a shape, so it is not monotone. A perfectly flat
    ladder is not monotone either: it has to move at least once, in the claimed
    direction, or nothing has been demonstrated.
    """
    vals = [b["value"] for b in ladder
            if b["value"] is not None and int(b.get("n") or 0) >= min_n]
    # Zero surviving bands is the common case once BOTH rules bite - the floor
    # and the scored-fold sample - and it is not an error. There is simply no
    # shape to read, so there is no dose-response, so the clause refuses.
    if len(vals) < min_bands:
        return False
    moved = False
    for prev, nxt in zip(vals, vals[1:]):
        delta = (nxt - prev) * sign
        if delta < 0.0:
            return False
        if delta > 0.0:
            moved = True
    return moved


def rows_moved(term, contribs, estimate, folds=SCORED_FOLDS):
    """THE R92 NO-OP CLAUSE. How many SCORED rows would this coefficient
    actually change?

    A candidate that fits nothing IS the shipped number, and a never-regress
    gate happily passes a term that does nothing by doing nothing. A row moves
    when the fitted coefficient times its own within-group predictor deviation
    is not zero.
    """
    if estimate is None or abs(estimate) <= MOVE_EPS:
        return 0
    # H_i = w_i * xd_i^2 is zero exactly when the row's predictor sits on its
    # own group mean, and such a row is unmoved by ANY coefficient: it carries
    # no contrast for the coefficient to act on.
    scored = set(folds)
    return sum(1 for c in contribs
               if c["row"]["season"] in scored and abs(c["H"]) > MOVE_EPS)


# ---------------------------------------------------------------------------
# Arms
# ---------------------------------------------------------------------------

def _renormalise(weeks, ratios, total):
    """The deployed split's own identity: raw[w] = pts[w] * ratio[w], then
    rescale so the season total is unchanged.

    This is the arithmetic a weather factor actually performs inside
    build_weekly.player_weeks, and writing it out here is what lets the REACH
    arm price a candidate WITHOUT patching the shipped builder. It also forces
    the honest reading: the split renormalises, so a weather factor can never
    lower a player's season total - it only moves points between his own weeks.
    """
    raw = {w: float(pts) * float(ratios.get(w, 1.0)) for w, pts in weeks.items()}
    s = sum(raw.values())
    if s <= 0.0:
        return dict(weeks)
    scale = float(total) / s
    return {w: v * scale for w, v in raw.items()}


def control_arm(actuals_doc=None, games_doc=None, dvp_doc=None, tuning_doc=None,
                seasons=None):
    """Does the weather factor the repo ALREADY ships earn its place?

    Three series on the same rows, all priced through the deployed split:
      shipped_v2      - scripts/build_weekly exactly as it ships
      v2_no_weather   - the identical split with its weather INPUTS removed
                        (no roof, no forecast), so build_weekly.weather_factor
                        returns 1.0 for every position on every week. Nothing
                        is monkey-patched and scripts/build_weekly.py is
                        byte-unchanged; the factor is simply handed nothing to
                        read, exactly as it is for a venue the repo has no roof
                        for today.
      flat            - the season total spread evenly over the non-bye weeks.

    R51's gate can only ever ask whether v2 beats v1. It structurally cannot
    ask whether v2 beats v2-minus-weather, which is the question with the
    biggest n in this whole document.
    """
    from scripts import backtest_weekly as bwk
    import scripts.build_weekly as bw

    actuals = actuals_doc if actuals_doc is not None else _load_json(ACTUALS_PATH)
    games_doc = games_doc if games_doc is not None else _load_json(wc.GAMES_META_PATH)
    dvp_doc = dvp_doc if dvp_doc is not None else _load_json(DVP_PATH)
    tuning_doc = tuning_doc if tuning_doc is not None else _load_json(TUNING_PATH)
    if not actuals or not games_doc or not dvp_doc:
        return {"available": False,
                "reason": "weekly_actuals / games_meta / dvp feed missing",
                "seasons_scored": [], "rows": 0, "series": {}, "note": CONTROL_NOTE}

    seasons = list(seasons or bwk.SEASONS_SCORED)
    games = bwk.load_games(games_doc)
    params = bwk.game_params(tuning_doc)
    elo_pre = bwk.elo_pre_week(games, params["hfa"], params["k"], params["revert"])

    rows, sched, dvp_at, venue_hfa = [], {}, {}, {}
    for season in seasons:
        s_rows, s_sched, _meta = bwk.build_rows(actuals, games, season, bwk.POOL)
        rows.extend(s_rows)
        sched[season] = s_sched
        dvp_at[season] = bwk.dvp_rates_by_week(dvp_doc, season)
        venue_hfa[season] = bwk.venue_hfa_walk_forward(games, season)

    by_week = {}
    for r in rows:
        by_week.setdefault((r["season"], r["week"]), []).append(r)
    for (season, wk), group in sorted(by_week.items()):
        elos = elo_pre.get(season, {}).get(wk, {})
        shipped = bwk.asof_factors(season, wk, games, dvp_at[season], venue_hfa[season])
        # The weather-free twin: same DvP, same Elo, same venue, and NO roof and
        # NO forecast. build_weekly.roof_class(None) is neither indoor nor
        # outdoor, so weather_factor returns exactly 1.0 for every position.
        blind = bw.build_factors(season, None, {"stadiums": {}, "venue_hfa": venue_hfa[season]},
                                 {"games": {}}, roof_by_game={})
        for w in range(1, bwk.WEEKS + 1):
            blind["dvp_by_week"][w] = dvp_at[season][min(w, wk)]
        cache_ship, cache_blind = {}, {}
        for r in group:
            key = (r["team"], r["number"], r["pos"])
            if key not in cache_ship:
                cache_ship[key] = bwk.split_v2(r["number"], r["team"], sched[season],
                                               elos, r["pos"], shipped)
                cache_blind[key] = bwk.split_v2(r["number"], r["team"], sched[season],
                                                elos, r["pos"], blind)
            r["shipped_v2"] = cache_ship[key][wk]
            r["v2_no_weather"] = cache_blind[key][wk]
            weeks = sched[season].get(r["team"]) or {}
            r["flat"] = (r["number"] / len(weeks)) if weeks else r["number"]

    series = {}
    for name in ("shipped_v2", "v2_no_weather", "flat"):
        series[name] = {
            "pooled_mae": bwk.mae([(r[name], r["actual"]) for r in rows]),
            "rank_corr": bwk.rank_corr(rows, name),
        }
    ship = series["shipped_v2"]
    blind_s = series["v2_no_weather"]
    weather_earns = (ship["pooled_mae"] is not None and blind_s["pooled_mae"] is not None
                     and ship["pooled_mae"] < blind_s["pooled_mae"])
    return {
        "available": True,
        "reason": "",
        "seasons_scored": [str(s) for s in seasons],
        "rows": len(rows),
        "series": series,
        "weather_earns_its_place": bool(weather_earns),
        "note": CONTROL_NOTE,
    }


CONTROL_NOTE = (
    "v2_no_weather is the deployed split handed no roof and no forecast, so "
    "build_weekly.weather_factor returns 1.0 everywhere. scripts/build_weekly.py "
    "is byte-unchanged and nothing is monkey-patched. Because the split "
    "renormalises to the player's season total, this arm measures ALLOCATION "
    "between a player's weeks, never his level.")


def placebo_arm(term, rows):
    """The identical estimator on roofed team-games handed matched weather.

    Reported WITH its own interval and NEVER as a pass/fail threshold. A
    placebo/treated ratio is two noisy point estimates divided, which is a coin
    flip in both directions; the honest use of a small placebo coefficient is
    weak reassurance and nothing more.
    """
    sample = term_rows(term, rows)
    contribs = contributions(term, sample)
    est, se, df, clusters = cluster_se(contribs, "stadium")
    ci = None
    if est is not None and se:
        half = _student_t_ppf(0.5 + CI_LEVEL / 2.0, df) * se
        ci = [est - half, est + half]
    return {
        "term": term["name"],
        "n_rows": len(sample),
        "n_treated": sum(1 for r in sample if term_treated(term, r)),
        "estimate": est,
        "se": se,
        "df": df,
        "clusters": clusters,
        "ci95": ci,
    }


def reach_arm(effect_ratio, pool_doc=None, calib_doc=None, weekly_doc=None,
              forecast_doc=None, threshold_mm=PRIMARY_MM, ece=POOL_ECE):
    """Propagate a measured effect to leg-pool rung probabilities.

    The chain, every step deterministic and none of it a simulation:
      the effect as a multiplicative factor on the affected week
        -> through the deployed renormalisation identity to the player's week
        -> the same proportion on his prop mu (project_prop_yards scales with
           the week it is built from)
        -> z = (mu - line) / residual_sd, the pool's own z
        -> the pool's own calibration, pool_prob(a + b z + c (p_team - 0.5))
    and then two counts: how many rungs move by more than the POOL'S OWN
    calibration error, and how many cross a support bound - the second being
    the silent hazard, because a rung that leaves support is not re-priced, it
    stops being OFFERED, and no gate in this repo watches that.
    """
    pool = pool_doc if pool_doc is not None else _load_json(LEG_POOL_PATH)
    calib = calib_doc if calib_doc is not None else _load_json(LEG_POOL_BACKTEST_PATH)
    weekly = weekly_doc if weekly_doc is not None else _load_json(PLAYER_WEEKLY_PATH)
    forecast = forecast_doc if forecast_doc is not None else _load_json(FORECAST_PATH)
    blank = {"available": False, "reason": "", "slate": None, "rungs": 0,
             "rungs_moved_beyond_ece": 0, "rungs_crossing_support": 0,
             "mean_abs_delta_p": None, "p90_abs_delta_p": None,
             "max_abs_delta_p": None, "games_triggering": 0,
             "ece": ece, "effect_ratio": effect_ratio, "note": REACH_NOTE}
    if not pool or not calib:
        blank["reason"] = "leg_pool / leg_pool_backtest absent"
        return blank
    if effect_ratio is None:
        blank["reason"] = "no measured effect to propagate"
        blank["slate"] = "%s week %s" % (pool.get("season"), pool.get("week"))
        return blank

    coefs = calib.get("calibration") or {}
    support = {p: tuple(v) for p, v in (pool.get("support") or {}).items()}
    sds = pool.get("residual_sd") or {}
    weeks_by_id = {}
    for p in (weekly or {}).get("players") or []:
        weeks_by_id[p.get("gsis_id")] = p

    wet_games = set()
    for key, row in ((forecast or {}).get("games") or {}).items():
        if str(row.get("source") or "") != "forecast":
            continue
        if float(row.get("precip_mm") or 0.0) >= float(threshold_mm):
            wet_games.add(key)

    season, week = pool.get("season"), pool.get("week")
    deltas, moved, crossed, rungs = [], 0, 0, 0
    for player in pool.get("players") or []:
        pos = player.get("position")
        coef, sd = coefs.get(pos), sds.get(pos)
        window = support.get(pos)
        if not coef or not sd or not window:
            continue
        team, opp = player.get("team"), None
        # A player is affected when HIS game is one of the wet ones. The game
        # key spells both teams, so membership is a substring-free comparison
        # on the two orderings the key can take.
        affected = any(k.split("|")[2] == team or k.split("|")[3] == team
                       for k in wet_games)
        mu = float(player.get("mu") or 0.0)
        p_team = float(player.get("p_team") or 0.5)
        ratio = 1.0
        if affected and mu > 0.0:
            rec = weeks_by_id.get(player.get("gsis_id"))
            ratio = _week_ratio(rec, week, effect_ratio)
        mu_new = mu * ratio
        lo, hi = window
        for rung in player.get("rungs") or []:
            rungs += 1
            line = float(rung["line"])
            z_old = (mu - line) / float(sd)
            z_new = (mu_new - line) / float(sd)
            p_old = _pool_prob(coef, z_old, p_team)
            p_new = _pool_prob(coef, z_new, p_team)
            d = abs(p_new - p_old)
            deltas.append(d)
            if d > ece:
                moved += 1
            if (lo <= z_old <= hi) != (lo <= z_new <= hi):
                crossed += 1
        _ = opp
    deltas.sort()
    return {
        "available": True,
        "reason": "",
        "slate": "%s week %s" % (season, week),
        "rungs": rungs,
        "rungs_moved_beyond_ece": moved,
        "rungs_crossing_support": crossed,
        "mean_abs_delta_p": (sum(deltas) / len(deltas)) if deltas else None,
        "p90_abs_delta_p": _quantile(deltas, 0.90),
        "max_abs_delta_p": (deltas[-1] if deltas else None),
        "games_triggering": len(wet_games),
        "ece": ece,
        "effect_ratio": effect_ratio,
        "note": REACH_NOTE,
    }


REACH_NOTE = (
    "Computed on ONE live slate, named above. Rung counts differ week to week "
    "and are never a season-long frequency. A rung that crosses a support bound "
    "is not re-priced - it stops being OFFERED - and backtest_parlay never calls "
    "build_weekly, so no gate in this repo watches that happen.")


def _week_ratio(rec, week, effect_ratio):
    """The multiplicative change to ONE week after the deployed split has
    renormalised. A player with no weekly row takes the raw factor, which is the
    conservative reading (renormalisation always shrinks the change)."""
    weeks = {w["wk"]: float(w["pts"]) for w in ((rec or {}).get("weeks") or [])
             if not w.get("bye") and w.get("pts") is not None}
    if week not in weeks or sum(weeks.values()) <= 0.0:
        return effect_ratio
    total = sum(weeks.values())
    after = _renormalise(weeks, {week: effect_ratio}, total)
    return after[week] / weeks[week] if weeks[week] > 0.0 else effect_ratio


def _pool_prob(coef, z, p_team):
    """The leg pool's own probability form, restated: a logistic in z and the
    team's win probability. Restated rather than imported because importing
    build_leg_pool would pull a builder into a measurement script for four
    lines of arithmetic."""
    a, b, c = coef["a"], coef["b"], coef["c"]
    t = a + b * float(z) + c * (float(p_team) - 0.5)
    t = max(-60.0, min(60.0, t))
    return 1.0 / (1.0 + math.exp(-t))


def _quantile(sorted_values, q):
    if not sorted_values:
        return None
    idx = min(len(sorted_values) - 1,
              max(0, int(math.ceil(q * len(sorted_values))) - 1))
    return sorted_values[idx]


# ---------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------

def would_adopt(record):
    """The adoption criterion, all eight conjunctive clauses, computed
    MECHANICALLY from the record's own numbers so the human decision is a
    reading rather than a judgement.

    Returns (bool, [refusal names]). Every clause that fails is named; the list
    is not short-circuited, because "why not" is more useful than "no".
    """
    reasons = []
    if not record.get("available", True):
        return False, [REFUSAL_UNAVAILABLE]
    # (1) powered, read from the power table computed on the term's OWN sample
    #     before any coefficient existed.
    if not record["powered"]:
        reasons.append(REFUSAL_UNDERPOWERED)
    # (2) enough treated observations to be talking about anything.
    if min(record["n_wet"], record["n_treated_rows"]) < MIN_FIRED:
        reasons.append(REFUSAL_TOO_FEW_FIRED)
    est = record["heldout_estimate"]
    if est is None:
        reasons.append(REFUSAL_UNESTIMABLE)
    else:
        # (3) the fitted sign is the sign that was written down first.
        if est * record["pre_registered_sign"] <= 0.0:
            reasons.append(REFUSAL_WRONG_SIGN)
        # (8) the held-out effect clears the binding threshold, in the
        #     pre-registered direction.
        thr = record["binding_threshold"]
        if thr is None or abs(est) < thr or est * record["pre_registered_sign"] <= 0.0:
            if REFUSAL_BELOW_THRESHOLD not in reasons:
                reasons.append(REFUSAL_BELOW_THRESHOLD)
    # (4) the dose-response has the shape the claim asserts.
    if not record["monotone"]:
        reasons.append(REFUSAL_NON_MONOTONE)
    # (5) the marginal and stratified estimates agree inside the interval.
    if record["confounded"]:
        reasons.append(REFUSAL_CONFOUNDED)
    # (6) THE R92 NO-OP CLAUSE: a term that fits nothing IS the shipped number.
    if record["rows_moved"] <= 0:
        reasons.append(REFUSAL_NO_ROWS_MOVED)
    # (7) the sign holds up out of sample, fold by fold.
    if record["folds_sign"] < FOLD_SIGN_MIN:
        reasons.append(REFUSAL_FOLD_SIGN)
    return (not reasons), reasons


def measure_term(term, rows, power, available, reason):
    """One term, end to end: sample -> contrasts -> two clusterings -> the
    eight clauses. Returns the 26-field record the contract requires."""
    sign = term["sign"]
    floor = EFFECT_FLOOR[term["outcome"]]
    base = {
        "name": term["name"],
        "arm": term["arm"],
        "position": term["position"],
        "unit": term["unit"],
        "outcome": term["outcome"],
        "form": term["form"],
        "hypothesis": term["hypothesis"],
        "pre_registered_sign": sign,
        "effect_of_interest": power["effect_of_interest"],
        "analysis_sample": power["analysis_sample"],
        "stratum_rule": STRATUM_RULES.get(term["stratum"], "marginal: no stratum"),
        "available": bool(available),
        "unavailable_reason": "" if available else reason,
        # POWERED IS A CONJUNCTION, and the second half of it is written after
        # the fit (see mde_realized below). power["powered"] alone is the
        # model-based gate: it runs before any coefficient is fitted and is what
        # makes an underpowered term structurally unadoptable. The realized half
        # can only ever REMOVE power, never grant it, so the pre-fit ordering
        # still does its whole job.
        "powered": bool(power["powered"]),
    }
    if not available:
        base.update({
            # No substrate means no error bar, and no error bar means no
            # realized MDE - so the conjunction in clause 1 is false here by the
            # same rule it is false anywhere else, never by a special case.
            "powered": False,
            "mde_realized": None,
            "n_wet": 0, "n_dry": 0, "n_treated_rows": 0, "n_control_rows": 0,
            "marginal_estimate": None, "stratified_estimate": None,
            "heldout_estimate": None, "confounded": False,
            "dose_response": [{"band": b, "n": 0, "value": None}
                              for b in (wc.PRECIP_BAND_NAMES
                                        if term["ladder"] == "precip"
                                        else wc.WIND_BAND_NAMES)],
            "monotone": False, "ci95": None, "se_fold": None, "se_stadium": None,
            "binding_threshold": None, "binding_df": None, "folds_sign": 0,
            "fold_estimates": {}, "rows_moved": 0,
            "would_adopt": False, "refused_reasons": [REFUSAL_UNAVAILABLE],
        })
        return base

    marginal_term = dict(term, stratum=STRATUM_NONE)
    # The stratified twin a MARGINAL term is compared against for clause 5.
    # It must be the stratum that term would legitimately use: a wind-ladder
    # term compared against the wind < 20 kph stratum is being compared against
    # a sample with no treated row in it, which is the same mistake the policy
    # forbids for the primary estimate and would make `confounded` false by
    # vacuity rather than by agreement.
    stratified_term = dict(term, stratum=(
        term["stratum"] or (STRATUM_WIND if term["ladder"] == "wind"
                            else STRATUM_PRIMARY)))

    sample = term_rows(term, rows)
    marg_rows = term_rows(marginal_term, rows)
    strat_rows = term_rows(stratified_term, rows)

    contribs = contributions(term, sample)
    marg_est = point_estimate(contributions(marginal_term, marg_rows))
    strat_est = point_estimate(contributions(stratified_term, strat_rows))

    scored = [c for c in contribs if c["row"]["season"] in SCORED_FOLDS]
    est_fold, se_fold, df_fold, _gf = cluster_se(scored, "fold")
    est_stad, se_stad, df_stad, _gs = cluster_se(scored, "stadium")
    assert est_fold is None or est_stad is None or abs(est_fold - est_stad) < 1e-9, (
        "the two clusterings must re-weight the SAME point estimate")
    heldout = est_fold if est_fold is not None else est_stad

    thr, thr_df = binding(se_fold, df_fold, se_stad, df_stad, floor)
    ci = None
    half = None
    se_ci, df_ci = ((se_fold, df_fold) if thr_df == df_fold else (se_stad, df_stad))
    if heldout is not None and se_ci:
        half = _student_t_ppf(0.5 + CI_LEVEL / 2.0, df_ci) * se_ci
        ci = [heldout - half, heldout + half]

    # CONFOUNDED: the marginal and stratified estimates disagree by more than
    # the interval can absorb. A rain coefficient that moves when wind is held
    # fixed was partly a wind coefficient.
    confounded = False
    if marg_est is not None and strat_est is not None and half is not None:
        gap = abs(marg_est - strat_est)
        scale = max(1.0, abs(marg_est), abs(strat_est))
        confounded = gap > max(half, EST_EPS * scale)

    ladder = dose_response(term, sample)
    folds = fold_estimates(contribs)
    folds_sign = sum(1 for v in folds.values() if v is not None and v * sign > 0.0)

    # n_wet / n_dry / the row counts describe THE ESTIMATION SAMPLE, so they are
    # counted on the scored rows - the same rows power_stage powered the term on
    # and the same rows `scored` above fits. Counting the neutral first fold
    # here would restore exactly the identity-shaped lie P0-A was: a published n
    # that no coefficient in the document was ever computed from.
    fitted = scored_rows(sample)
    n_wet = _denominator(term, fitted, True)
    n_dry = _denominator(term, fitted, False)
    # The realized MDE: the same Z multiplier the power stage uses, applied to
    # the estimator's OWN binding clustered error rather than to a pooled
    # two-arm binomial model of it. R94 audit 2026-09-20, P1-A: the model SE ran
    # 1.6x to 2.1x SMALLER than the realized one on the real corpus, always in
    # the flattering direction, so `powered: true` asserted a detection
    # capability the estimator demonstrably did not have.
    realized_ses = [x for x in (se_fold, se_stad) if x is not None]
    mde_realized = (wp.Z_MDE * max(realized_ses)) if realized_ses else None
    record = dict(base)
    record.update({
        "mde_realized": mde_realized,
        "n_wet": n_wet,
        "n_dry": n_dry,
        "n_treated_rows": sum(1 for r in fitted if term_treated(term, r)),
        "n_control_rows": sum(1 for r in fitted if not term_treated(term, r)),
        "marginal_estimate": marg_est,
        "stratified_estimate": strat_est,
        "heldout_estimate": heldout,
        "confounded": bool(confounded),
        "dose_response": ladder,
        "monotone": bool(is_monotone(ladder, sign)),
        "ci95": ci,
        "se_fold": se_fold,
        "se_stadium": se_stad,
        "binding_threshold": thr,
        "binding_df": thr_df,
        "folds_sign": folds_sign,
        "fold_estimates": {str(k): v for k, v in sorted(folds.items())},
        "rows_moved": rows_moved(term, contribs, heldout),
    })
    # CLAUSE 1 REQUIRES BOTH MDEs. The model-based one asks "could a sample this
    # size see the claimed effect under a pooled binomial with the measured
    # design effect"; the realized one asks the same question of the error bar
    # this estimator actually produced. A term is powered only if both say yes.
    eoi = record["effect_of_interest"]
    realized_ok = mde_realized is not None and mde_realized <= eoi
    record["powered"] = bool(power["powered"] and realized_ok)
    # The two numbers can never be PUBLISHED in contradiction: nothing may carry
    # powered: true beside an MDE - of either kind - that exceeds its own bar.
    assert not record["powered"] or (
        power["mde"] is not None and power["mde"] <= eoi
        and mde_realized is not None and mde_realized <= eoi), (
        "%s publishes powered:true with mde %r / mde_realized %r against a bar "
        "of %r" % (term["name"], power["mde"], mde_realized, eoi))
    ok, reasons = would_adopt(record)
    record["would_adopt"] = bool(ok)
    record["refused_reasons"] = reasons
    return record


def _denominator(term, rows, treated):
    """n_wet / n_dry in the term's OWN unit: trials for a rate, rows for a
    value term. This is deliberately the same quantity weather_power's power
    table counts, so power.n_treated == terms.n_wet is a checkable identity and
    not a coincidence."""
    if term["kind"] == "rate":
        return int(round(sum(term_weight(term, r) for r in rows
                             if term_treated(term, r) == treated)))
    return sum(1 for r in rows if term_treated(term, r) == treated)


def _leading_winner(winners):
    """Which winning term the verdict NAMES.

    Not the largest coefficient: the terms are measured in percentage points,
    in fantasy points and in EPA per dropback, and 0.9 fantasy points is not
    "bigger" than 0.125 of a catch rate in any sense that survives being said
    out loud. Two rules, both unit-free:

      1. If the PRIMARY term won, it is the answer - it is the question the
         owner actually asked, and a companion term does not outrank it.
      2. Otherwise, the largest margin over the term's OWN binding threshold,
         which is a ratio and therefore carries no units. Ties break on the
         name so the artifact is reproducible.
    """
    for term in winners:
        if term["name"] == PRIMARY_TERM:
            return PRIMARY_TERM

    def margin(term):
        thr = term.get("binding_threshold")
        est = abs(term.get("heldout_estimate") or 0.0)
        return est / thr if thr else float("inf")

    return sorted(winners, key=lambda t: (-margin(t), t["name"]))[0]["name"]


def verdict_for(terms, reach):
    """The verdict, mechanically.

    'not_powered'          the PRIMARY term is underpowered: the corpus cannot
                           answer the question that was asked, and nothing
                           downstream of that is worth reading.
    'real_but_immaterial'  every clause but the threshold passes AND the REACH
                           arm shows zero rungs moving more than the pool's own
                           calibration error. A first-class outcome, not a
                           polite way of saying no.
    'none'                 some clause failed.
    a term name            it passed all eight - and still carries oracle_only.
    """
    by_name = {t["name"]: t for t in terms}
    primary = by_name.get(PRIMARY_TERM)
    winners = [t for t in terms if t["would_adopt"]]
    # ORDER MATTERS AND IS THE ADOPTION CRITERION'S OWN ORDER: not_powered is
    # read FIRST. If the corpus cannot answer the question that was asked, that
    # is the headline, and a companion term clearing its own bar does not
    # change it. Letting a winner outrank an unpowered primary would let the
    # document answer a question nobody asked.
    if primary is None or not primary["powered"]:
        name = VERDICT_NOT_POWERED
    elif winners:
        name = _leading_winner(winners)
    else:
        immaterial = [
            t for t in terms
            if t["refused_reasons"] == [REFUSAL_BELOW_THRESHOLD]
            and reach.get("available") and reach.get("rungs_moved_beyond_ece") == 0]
        name = VERDICT_IMMATERIAL if immaterial else VERDICT_NONE
    return {
        "name": name,
        "adopted": False,
        "families_registered": [],
        # The effect arm is fitted on reanalysis weather - perfect foresight -
        # so a winner here is evidence about physics and not about anything a
        # Sunday-morning forecast could have told us.
        "oracle_only": True,
        "adoptable_candidates": sorted(t["name"] for t in winners),
    }


def measure(weather_doc=None, games_meta_doc=None, context_doc=None,
            epa_doc=None, dvp_doc=None, team_rates=None, player_rates=None,
            control=None, reach=None, hypotheses=HYPOTHESES, now_utc=None,
            weather_path=wc.WEATHER_PATH, games_meta_path=wc.GAMES_META_PATH,
            context_path=wc.GAME_CONTEXT_PATH, corpus_sha=None):
    """The whole measurement on in-memory documents. Returns the artifact."""
    corpus = wc.load_corpus(weather_doc=weather_doc, games_meta_doc=games_meta_doc,
                            weather_path=weather_path,
                            games_meta_path=games_meta_path)
    if corpus_sha is None:
        # ALWAYS a real digest of what this run actually read. A blank would be
        # a claim that could not be checked, and a file digest reported beside
        # an injected document would be a claim that was not true.
        corpus_sha = (wc.corpus_sha256(weather_path) if weather_doc is None
                      else hashlib.sha256(json.dumps(
                          weather_doc, sort_keys=True).encode("utf-8")).hexdigest())
    verified = wc.venue_verified(corpus)
    audit = wc.roof_audit(verified["rows"].keys(), context_doc=context_doc,
                          context_path=context_path)
    # roof_state takes a RAW game_context document via context_doc and an
    # already-normalised games_meta index via meta; the two parameters are
    # separate on purpose so nothing has to sniff a shape.
    state = wc.roof_state(
        context_doc=context_doc,
        meta=wc.meta_index(games_meta_doc) if games_meta_doc is not None else None,
        context_path=context_path,
        games_meta_path=games_meta_path)

    epa = load_epa(epa_doc, EPA_PATH)
    dvp = load_dvp_points(dvp_doc, DVP_PATH)

    treated_rows = verified["rows"]
    placebo_keys = state["placebo"]
    placebo_weather = matched_placebo_weather(placebo_keys, treated_rows)
    placebo_games = {k: {"season": int(k.split("|")[0]), "week": int(k.split("|")[1]),
                         "home": k.split("|")[2], "away": k.split("|")[3],
                         "stadium": "roofed:" + k.split("|")[2],
                         "precip_mm": 0.0, "temp_c": 0.0, "wind_kph": 0.0}
                     for k in placebo_weather}

    rates_ok, rates_reason = wr.available(player_rates)
    team_ok, team_reason = wr.available(team_rates)
    _ = (team_ok, team_reason)

    team_rows_treated = team_game_rows(treated_rows, epa, dvp, "treated")
    team_rows_placebo = team_game_rows(placebo_games, epa, dvp, "placebo",
                                       weather_by_key=placebo_weather)
    player_rows_treated = (player_week_rows(treated_rows, player_rates, "treated")
                           if rates_ok else [])
    player_rows_placebo = (player_week_rows(placebo_games, player_rates, "placebo",
                                            weather_by_key=placebo_weather)
                           if rates_ok else [])

    pool_of = {"team_game": team_rows_treated, "player_week": player_rows_treated}
    placebo_of = {"team_game": team_rows_placebo, "player_week": player_rows_placebo}

    # --- POWER FIRST. No coefficient has been fitted at this point. ---------
    samples = {t["name"]: term_rows(t, pool_of[t["unit"]]) for t in hypotheses}
    power = power_stage(samples, hypotheses)

    terms, placebos = [], []
    for term in hypotheses:
        available = True if term["unit"] == "team_game" else rates_ok
        reason = "" if available else rates_reason
        terms.append(measure_term(term, pool_of[term["unit"]], power[term["name"]],
                                  available, reason))
        if available:
            placebos.append(placebo_arm(term, placebo_of[term["unit"]]))

    control = control if control is not None else unavailable_control()
    primary = next((t for t in terms if t["name"] == PRIMARY_TERM), None)
    ratio = _effect_ratio(primary, power.get(PRIMARY_TERM))
    reach = reach if reach is not None else reach_arm(ratio)
    verdict = verdict_for(terms, reach)

    now = now_utc or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "generated_utc": now,
        "kind": KIND,
        "seasons_scored": [str(s) for s in SCORED_FOLDS],
        "substrate": {
            "seasons_requested": [str(s) for s in SEASONS],
            "seasons_fetched": [str(s) for s in
                                sorted(set(int(s) for s in
                                           (player_rates or {}).get("seasons_fetched") or []))]
            if rates_ok else [],
            "seasons_unavailable": ({} if rates_ok
                                    else {str(s): rates_reason for s in SEASONS}),
            "column_contract": list(wr.REQUIRED_RATE_COLUMNS),
            "feeds": {
                "weather": wc.WEATHER_REL,
                "games_meta": wc.GAMES_META_REL,
                "game_context": wc.GAME_CONTEXT_REL,
                "epa": "data/epa_history.json",
                "dvp": "data/dvp_positional_history.json",
                "rates": os.path.relpath(wr.OUT_DIR, _ROOT),
            },
            "weather_role": "label",
            "perfect_foresight": True,
            "rule": ("Fold Y is scored on season Y and fits only seasons strictly "
                     "before it; the first fold fits nothing, is neutral and is "
                     "counted. Power reads outcome-bearing quantities from the "
                     "training seasons only and never from the held-out season."),
            "folds": fold_records(),
            "training_seasons": [str(s) for s in TRAINING_SEASONS],
            "holdout_season": str(HOLDOUT_SEASON),
            # The rows the power table was computed on, and the subset of those
            # whose OUTCOMES it was allowed to read. Published so the n in
            # `power` can be reproduced rather than taken on trust.
            "power_seasons": [str(s) for s in POWER_SEASONS],
            "power_training_seasons": [str(s) for s in POWER_TRAINING_SEASONS],
        },
        "corpus_filter": wc.corpus_filter_report(verified, audit),
        "roof_census": wc.roof_census(state),
        "conditions": wc.condition_counts(verified["rows"], unit="team_game"),
        "conditions_unit": "team_game",
        # The band CUTS, from the reader's own tables. docs/WEATHER_EFFECT.md
        # used to quote these edges in prose with no field behind them, which
        # made every band number in the document unreproducible from the file.
        "band_edges": {"precip": dict(wc.PRECIP_BAND_EDGES),
                       "wind": dict(wc.WIND_BAND_EDGES)},
        "weather_history_sha256": corpus_sha,
        "power": {name: _round_power(rec) for name, rec in sorted(power.items())},
        "terms": [_round_node(t) for t in terms],
        "arms": {"control": _round_node(control), "reach": _round_node(reach)},
        "placebo": {
            "rule": ("the identical estimator on roofed team-games handed the "
                     "weather of a matched outdoor game in the same season-week"),
            "note": PLACEBO_NOTE,
            "terms": [_round_node(p) for p in placebos],
        },
        "verdict": verdict,
        "adoption_rule": {
            "clauses": ADOPTION_CLAUSES,
            "tests": N_TESTS,
            "alpha": ALPHA,
            "min_fired": MIN_FIRED,
            "fold_sign_min": FOLD_SIGN_MIN,
            "min_band_n": MIN_BAND_N,
            "mde_z": wp.Z_MDE,
            "power_rule": ("powered = the model-based MDE AND the realized MDE "
                           "are both no larger than the effect of interest. "
                           "mde_realized = mde_z * max(se_fold, se_stadium): "
                           "the estimator's own binding clustered error, which "
                           "on this corpus runs 1.3x to 2.1x LARGER than the "
                           "pooled-binomial model of it, always in the "
                           "flattering direction."),
            "effect_floor": dict(EFFECT_FLOOR),
            "binding_rule": ("max(threshold_fold, threshold_stadium), NEVER "
                             "max(se): at 3 df against 20 the larger SE can "
                             "carry the lower bar"),
            "primary_term": PRIMARY_TERM,
        },
        "policy": POLICY,
        "limits": LIMITS,
    }
    assert doc["verdict"]["adopted"] is False, "this run adopts nothing"
    assert doc["verdict"]["families_registered"] == [], "this run registers nothing"
    return doc


PLACEBO_NOTE = (
    "A DIAGNOSTIC WITH AN INTERVAL, never a pass/fail threshold. A "
    "placebo-over-treated ratio is two noisy point estimates divided and reads "
    "as a coin flip in both directions; a small placebo coefficient is weak "
    "reassurance and nothing more.")

ADOPTION_CLAUSES = [
    "1 powered: the model-based MDE, read from the power table computed on the "
    "term's OWN analysis sample - the SCORED rows it is fitted on - before any "
    "coefficient was fitted, AND the realized MDE mde_z * max(se_fold, "
    "se_stadium) from the estimator's own clustered error, both no larger than "
    "the effect of interest (refusal: underpowered)",
    "2 n_fired >= %d treated observations AND treated rows (refusal: "
    "too_few_fired)" % MIN_FIRED,
    "3 the fitted sign equals the pre-registered sign (refusal: wrong_sign)",
    "4 the dose-response is monotone in the claimed direction across the five "
    "bands, counting only bands of at least min_band_n rows - a one-row cell "
    "votes like a thousand-row cell otherwise (refusal: non_monotone)",
    "5 confounded is false: the marginal and stratified estimates differ by no "
    "more than the CI half-width (refusal: confounded)",
    "6 rows_moved > 0 - the R92 no-op clause, because a candidate that fits "
    "nothing IS the shipped number (refusal: no_rows_moved)",
    "7 the sign agrees in at least %d of the %d held-out folds (refusal: "
    "fold_sign_disagrees)" % (FOLD_SIGN_MIN, len(SCORED_FOLDS)),
    "8 the held-out estimate exceeds the binding threshold, which is "
    "max(threshold_fold, threshold_stadium) and never max(se) (refusal: "
    "below_threshold)",
]


def unavailable_control():
    return {"available": False, "reason": "control arm not run",
            "seasons_scored": [], "rows": 0, "series": {},
            "weather_earns_its_place": False, "note": CONTROL_NOTE}


def _effect_ratio(primary, power):
    """The primary term's effect expressed as a multiplicative factor on a
    projection, which is the only shape the REACH arm can propagate. A rate
    effect of -0.02 on a 0.64 base is a factor of 1 - 0.02/0.64."""
    if primary is None or not primary.get("available"):
        return None
    est = primary.get("heldout_estimate")
    base = (power or {}).get("baseline_rate")
    if est is None or not base:
        return None
    return 1.0 + est / float(base)


def _round_power(rec):
    return {k: (round(v, ROUND_DP) if isinstance(v, float) else v)
            for k, v in rec.items()}


def _round_node(node):
    """Round every float ONCE, at the artifact boundary. Nothing upstream of
    here rounds, so no threshold is ever compared against a rounded estimate."""
    if isinstance(node, float):
        return round(node, ROUND_DP)
    if isinstance(node, dict):
        return {k: _round_node(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_round_node(v) for v in node]
    return node


def write(doc, out_path=OUT_PATH):
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Synthetic fixture: answers worked out by hand, offline, writes nothing
# ---------------------------------------------------------------------------

def _synthetic(wet_effect=-0.10, seasons=SEASONS, monotone=True):
    """Six outdoor teams, five seasons, ten weeks: 150 games, 300 team-games.

    THE FIXTURE'S ONE JOB IS TO BREAK THE COLLINEARITY THE REAL CORPUS HAS.
    In the real world rain and wind arrive together, which is why the primary
    estimate is stratified at all. A fixture that reproduces that collinearity
    reproduces it PERFECTLY - and then the primary stratum (wind < 20 kph)
    holds no wet game at all, every stratified term measures an empty sample,
    and a selftest built on it asserts nothing about the term the owner asked
    about. That is exactly what the first draft of this fixture did. So here
    precip and wind are CROSSED on purpose:

        week   1     2     3     4     5     6     7     8     9    10
        precip 0.0   0.0   0.1   0.1   0.5   0.5   1.6   1.6   3.0   6.0
        wind   4    26    12    30     8    22    10    28     6    24

    Three properties are planted and each is load-bearing:

      * The primary stratum (wind < 20 kph, temp > 5 C) is weeks 1, 3, 5, 7, 9
        - one week from each precip band - so it holds BOTH wet and dry games
        and all five bands. A stratified term measures something.
      * Inside that stratum the wet weeks (7, 9) and the dry weeks (1, 3, 5)
        have the SAME mean wind, 8 kph. Rain and wind are orthogonal inside the
        stratum, which is what a stratum is for, so the marginal and stratified
        estimates coincide exactly and `confounded` reads false for an honest
        reason rather than because the interval swallowed a real gap.
      * The wind stratum (temp > 5 C, precip < 1.0 mm) is weeks 1-6, which
        spans 4 to 30 kph and populates all five wind bands. A slope has
        predictor spread inside its own stratum because the stratum is not
        built on its own predictor.

    Every planted effect is a step per precip BAND, and each team carries a
    fixed completion offset so the two sides of a game differ (a game-clustered
    ICC of exactly 1 would make the design effect the whole cluster size and
    nothing would ever read powered). The offset is constant within a
    player-season, so it cancels exactly in the within-group contrast: the
    fitted coefficient is the planted one to floating-point.

    The planted effects are deliberately larger than anything football would
    produce. They exist to drive the machinery through every branch, and no
    number in this function is a claim about football.
    """
    teams = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF")
    dome_home, dome_away = "YYY", "ZZZ"
    # Three rotating pairings so all six stadiums host and the stadium
    # clustering has more degrees of freedom (5) than the fold clustering (3) -
    # the configuration in which the binding-threshold rule actually has a
    # choice to make.
    pairings = (
        ((teams[0], teams[1]), (teams[2], teams[3]), (teams[4], teams[5])),
        ((teams[1], teams[2]), (teams[3], teams[4]), (teams[5], teams[0])),
        ((teams[2], teams[0]), (teams[4], teams[1]), (teams[5], teams[3])),
    )
    precip = {1: 0.0, 2: 0.0, 3: 0.1, 4: 0.1, 5: 0.5,
              6: 0.5, 7: 1.6, 8: 1.6, 9: 3.0, 10: 6.0}
    wind = {1: 4.0, 2: 26.0, 3: 12.0, 4: 30.0, 5: 8.0,
            6: 22.0, 7: 10.0, 8: 28.0, 9: 6.0, 10: 24.0}
    # The precip BAND ordinal each week sits in: 0 dry, 1 trace, 2 light,
    # 3 moderate, 4 heavy. Two weeks per band.
    band_index = {1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 3, 9: 4, 10: 4}
    if not monotone:
        # The SAME rows, the same n, the same treatment and the same band
        # membership - only the planted ladder is permuted, so the dose-response
        # zig-zags while everything else the record carries is untouched.
        band_index = {1: 0, 2: 0, 3: 3, 4: 3, 5: 1, 6: 1, 7: 4, 8: 4, 9: 2, 10: 2}
    weeks = tuple(sorted(precip))

    # Completions per band step, as an integer, so the planted ladder is exact
    # rather than a rounding artefact. 40 attempts and a -0.10 effect over four
    # band steps is one completion per step.
    pass_attempts = 40
    step = int(round(pass_attempts * abs(wet_effect) / 4.0))
    base_completions = int(round(pass_attempts * 0.65))
    sign = -1 if wet_effect < 0 else 1
    wr_targets, wr_base = 20, 14        # .70 at the dry end, one step per band
    te_targets, te_base = 8, 6          # a smaller, heterogeneous effect
    rb_targets, rb_base = 6, 4          # THE CONTROL: no planted effect at all

    weather = {"generated_utc": "2026-01-01T00:00:00Z", "source": "synthetic",
               "games": {}}
    meta_games = []
    context = {"games": {}}
    epa = {"seasons": {}}
    dvp = {"seasons": {}}
    player_rows = {}
    team_rows = {}

    # EXACTLY the seven columns weather_corpus.META_ALLOW admits, in that order.
    # The real games_meta fixture carries market columns beside
    # these; this file never names one, not even as a header string, because a
    # measurement script that spells a betting column has already blurred the
    # line this build is supposed to hold. meta_index zips by the header rather
    # than by position, so nothing here depends on the order either.
    META_FIELDS = list(wc.META_ALLOW)

    def _meta_row(season, week, home, away, roof, stadium, neutral=False):
        by_name = {"season": season, "week": week, "home": home, "away": away,
                   "roof": roof, "neutral": neutral, "stadium": stadium}
        return [by_name[col] for col in META_FIELDS]

    for season in seasons:
        epa["seasons"][str(season)] = {}
        dvp["seasons"][str(season)] = {}
        player_rows[str(season)] = {}
        team_rows[str(season)] = {}
        for week in weeks:
            idx = band_index[week]
            wet = 1.0 if precip[week] >= PRIMARY_MM else 0.0
            gust = wind[week]
            for home, away in pairings[(week - 1) % len(pairings)]:
                key = wc.game_key(season, week, home, away)
                weather["games"][key] = {
                    "precip_mm": precip[week], "temp_c": 18.0,
                    "wind_kph": gust, "source": "archive"}
                meta_games.append(_meta_row(season, week, home, away, "outdoors",
                                            "Stadium %s" % home))
                context["games"][key] = {"roof": "outdoors", "game_type": "REG",
                                         "neutral_site": False}
                for team in (home, away):
                    opp = away if team == home else home
                    # Constant within a team-season, so it cancels exactly in
                    # every within-group contrast while still making the two
                    # sides of a game differ.
                    offset = (teams.index(team) % 3) - 1
                    # Every value outcome also carries the team's fixed
                    # offset. Without it the two sides of a game are identical,
                    # the game-clustered ICC is exactly 1, and the design effect
                    # is the whole cluster size - a fixture that could never
                    # show the ICC being MEASURED rather than assumed. The
                    # offset is constant within a team-season, so the
                    # within-group slope is still the planted one exactly.
                    drops = 36.0 - 0.8 * gust / 10.0 + 0.5 * offset
                    epa["seasons"][str(season)].setdefault(team, {})[str(week)] = {
                        "off_pass_plays": drops,
                        "off_pass_epa": drops * (0.10 - 0.02 * gust / 10.0
                                                 + 0.004 * offset),
                    }
                    dvp["seasons"][str(season)].setdefault(team, {})[str(week)] = {
                        "off": {
                            # Wind hurts QB points; rain takes another half
                            # point on top, which is the rain-on-points claim
                            # planted at a size the team-game unit may or may
                            # not be able to see. That is the question.
                            "QB": 18.0 - 0.9 * gust / 10.0 - 0.5 * wet
                                  + 0.3 * offset,
                            # THE SHIPPED rb_wind PENALTY, PLANTED WRONG-SIGNED
                            # on purpose: the descriptive evidence in the repo
                            # says RBs score MORE in wind, and a fixture that
                            # agreed with the shipped constant could not show
                            # the term refusing on sign.
                            "RB": 20.0 + 0.4 * (1.0 if gust >= RB_WIND_KPH else 0.0)
                                  + 0.3 * offset,
                            "WR": 21.0, "TE": 9.0}}
                    completions = base_completions + sign * step * idx + offset
                    receptions_wr = wr_base + sign * idx
                    # A HETEROGENEOUS effect, planted on a growing subset of
                    # teams. Eight targets cannot express a two-point step in
                    # catch rate inside one game - the smallest move a whole
                    # reception can make is 12.5 points - so the TE effect is
                    # planted on (idx + 1) of the six teams and appears only in
                    # the POOLED band mean, which steps by 1/6 of a reception.
                    # That is what a small effect on a thin denominator looks
                    # like, and it is the shape this arm exists to test.
                    docked = teams.index(team) <= idx if sign < 0 else False
                    receptions_te = te_base - (1 if docked else 0)
                    receptions_rb = rb_base
                    team_rows[str(season)]["%d|%s" % (week, team)] = {
                        "team": team, "opp": opp, "week": week,
                        "completions": completions, "attempts": pass_attempts,
                        "passing_yards": 220.0, "passing_interceptions": 0,
                        "sacks": 2, "carries": 24,
                        "targets": wr_targets + te_targets + rb_targets,
                        "receptions": receptions_wr + receptions_te + receptions_rb,
                        "receiving_yards": 220.0, "receiving_air_yards": 260.0,
                        "sack_fumbles": 0, "sack_fumbles_lost": 0,
                        "rushing_fumbles": 0, "rushing_fumbles_lost": 0,
                        "receiving_fumbles": 0, "receiving_fumbles_lost": 0,
                        "players": 4,
                    }
                    roster = (("%s-QB" % team, "QB", pass_attempts, 0, 0),
                              ("%s-WR" % team, "WR", 0, wr_targets, receptions_wr),
                              ("%s-TE" % team, "TE", 0, te_targets, receptions_te),
                              ("%s-RB" % team, "RB", 0, rb_targets, receptions_rb))
                    for pid, pos, att, tgt, recs in roster:
                        player_rows[str(season)]["%d|%s|%s" % (week, team, pid)] = {
                            "name": pid, "pos": pos, "team": team, "opp": opp,
                            "week": week,
                            "completions": completions if att else 0,
                            "attempts": att,
                            "passing_yards": 220.0 if att else 0.0,
                            "passing_interceptions": 0,
                            "sacks": 2 if att else 0, "carries": 0,
                            "targets": tgt, "receptions": recs,
                            "receiving_yards": 60.0, "receiving_air_yards": 70.0,
                            "sack_fumbles": 0, "sack_fumbles_lost": 0,
                            "rushing_fumbles": 0, "rushing_fumbles_lost": 0,
                            "receiving_fumbles": 0, "receiving_fumbles_lost": 0,
                        }
            # ONE RELOCATION A SEASON, in week 11, so the corpus filter has
            # something to drop and the artifact's dropped_relocations is not
            # zero. Its weather is deliberately the worst in the fixture -
            # 5 mm and 35.6 kph, the numbers the real 2022|11|BUF|CLE carries -
            # because that game was played indoors in another city and is
            # exactly the row a venue filter exists to remove. It is dropped in
            # the reader, so it needs no outcome anywhere.
            if week == weeks[0]:
                key = wc.game_key(season, RELOCATION_WEEK, teams[0], teams[3])
                weather["games"][key] = {
                    "precip_mm": 5.0, "temp_c": 2.0, "wind_kph": 35.6,
                    "source": "archive"}
                meta_games.append(_meta_row(season, RELOCATION_WEEK, teams[0],
                                            teams[3], "outdoors",
                                            "Neutral Field", neutral=True))
                context["games"][key] = {"roof": "outdoors", "game_type": "REG",
                                         "neutral_site": True}

            # One roofed game a week so the placebo arm has a sample. It carries
            # no weather of its own: matched_placebo_weather hands it an outdoor
            # game's weather from the same season-week, which is the whole
            # construction the placebo arm is.
            key = wc.game_key(season, week, dome_home, dome_away)
            context["games"][key] = {"roof": "dome", "game_type": "REG",
                                     "neutral_site": False}
            meta_games.append(_meta_row(season, week, dome_home, dome_away,
                                        "dome", "Dome %s" % dome_home))
            for team in (dome_home, dome_away):
                opp = dome_away if team == dome_home else dome_home
                epa["seasons"][str(season)].setdefault(team, {})[str(week)] = {
                    "off_pass_plays": 34.0, "off_pass_epa": 3.4}
                dvp["seasons"][str(season)].setdefault(team, {})[str(week)] = {
                    "off": {"QB": 18.0, "RB": 20.0, "WR": 21.0, "TE": 9.0}}
                team_rows[str(season)]["%d|%s" % (week, team)] = dict(
                    team_rows[str(season)]["%d|%s" % (week, teams[0])],
                    team=team, opp=opp)
                for pid, pos, att, tgt, recs in (
                        ("%s-QB" % team, "QB", pass_attempts, 0, 0),
                        ("%s-WR" % team, "WR", 0, wr_targets, wr_base)):
                    player_rows[str(season)]["%d|%s|%s" % (week, team, pid)] = {
                        "name": pid, "pos": pos, "team": team, "opp": opp,
                        "week": week,
                        "completions": base_completions if att else 0,
                        "attempts": att, "passing_yards": 220.0,
                        "passing_interceptions": 0, "sacks": 2 if att else 0,
                        "carries": 0, "targets": tgt, "receptions": recs,
                        "receiving_yards": 60.0, "receiving_air_yards": 70.0,
                        "sack_fumbles": 0, "sack_fumbles_lost": 0,
                        "rushing_fumbles": 0, "rushing_fumbles_lost": 0,
                        "receiving_fumbles": 0, "receiving_fumbles_lost": 0}

    meta = {"source": "synthetic", "fields": META_FIELDS,
            "policy": "synthetic", "games": meta_games}
    rates_stub = {"kind": "wet_rates", "provenance": wr.PROVENANCE_RELEASE,
                  "source": "synthetic fixture built in memory by "
                            "backtest_weather._synthetic; writes nothing",
                  "policy": "synthetic fixture: planted effects, not football",
                  "generated_utc": "2026-01-01T00:00:00Z",
                  "seasons_requested": list(seasons),
                  "seasons_fetched": list(seasons), "seasons_unavailable": {},
                  "required_columns": list(wr.REQUIRED_RATE_COLUMNS)}
    player_doc = dict(rates_stub, unit=wr.UNIT_PLAYER, rows=player_rows)
    team_doc = dict(rates_stub, unit=wr.UNIT_TEAM, rows=team_rows)
    return weather, meta, context, epa, dvp, team_doc, player_doc


# ---------------------------------------------------------------------------
# Selftest
# ---------------------------------------------------------------------------

def selftest():
    import copy
    import random
    import shutil

    weather, meta, context, epa, dvp, team_doc, player_doc = _synthetic()

    def run(**kw):
        args = dict(weather_doc=weather, games_meta_doc=meta, context_doc=context,
                    epa_doc=epa, dvp_doc=dvp, team_rates=team_doc,
                    player_rates=player_doc, control=unavailable_control(),
                    reach=reach_arm(None, pool_doc={}, calib_doc={}),
                    now_utc="2026-01-01T00:00:00Z")
        args.update(kw)
        return measure(**args)

    doc = run()

    # --- the fold barrier, in both directions ------------------------------
    folds = doc["substrate"]["folds"]
    assert len(folds) == len(SEASONS), folds
    for rec in folds:
        for fit in rec["fit_seasons"]:
            assert fit < rec["season"], ("fold %s fits %s, which is not strictly "
                                         "before it" % (rec["season"], fit))
    first = folds[0]
    assert first["fit_seasons"] == [] and first["neutral"] and not first["scored"], (
        "the first fold must fit nothing and be reported neutral-and-counted, got "
        "%r" % (first,))
    assert sum(1 for f in folds if f["scored"]) == 4, folds

    # --- (a) power is BLIND to held-out outcomes ---------------------------
    # Permute the EVAL season's outcome column only. Training-season variance is
    # untouched, so a power table that reads a held-out outcome moves and one
    # that does not cannot. A blindness test nothing can move proves nothing, so
    # the training-season permutation below must MOVE it.
    shuffled_player = copy.deepcopy(player_doc)
    rng = random.Random(94)
    holdout = str(HOLDOUT_SEASON)
    comps = [r["completions"] for r in shuffled_player["rows"][holdout].values()]
    rng.shuffle(comps)
    for row, c in zip(shuffled_player["rows"][holdout].values(), comps):
        row["completions"] = c
    permuted = run(player_rates=shuffled_player)
    assert permuted["power"] == doc["power"], (
        "the power table read a held-out outcome: it must be computed from "
        "TRAINING seasons only")
    train_shuffled = copy.deepcopy(player_doc)
    # POWER_TRAINING_SEASONS, not TRAINING_SEASONS: the power sample is the
    # SCORED rows, so the neutral first fold's outcomes are not read by the
    # power stage either - perturbing THEM would leave the table untouched for
    # a second, entirely different reason and would make the blindness test
    # above vacuous in exactly the way it exists to rule out.
    train = str(POWER_TRAINING_SEASONS[0])
    for i, row in enumerate(train_shuffled["rows"][train].values()):
        if row["attempts"]:
            row["completions"] = 10 + (i % 7)
    moved = run(player_rates=train_shuffled)
    assert moved["power"][PRIMARY_TERM] != doc["power"][PRIMARY_TERM], (
        "permuting a TRAINING outcome must move the power table, or the "
        "blindness test above is vacuous")
    # ...and the NEUTRAL FIRST FOLD must not move it either, in EITHER of its
    # two roles: not through its outcomes (it is not a training season) and not
    # through its DENOMINATORS, which is the half that was broken. This is the
    # P0-A lock: a power table that still counts the first fold's attempts is
    # powering on rows no coefficient is fitted on.
    neutral_shuffled = copy.deepcopy(player_doc)
    neutral = str(SEASONS[0])
    for i, row in enumerate(neutral_shuffled["rows"][neutral].values()):
        if row["attempts"]:
            row["completions"] = 10 + (i % 7)
            row["attempts"] = int(row["attempts"]) + 11
    unmoved = run(player_rates=neutral_shuffled)
    assert unmoved["power"] == doc["power"], (
        "the power table moved when the NEUTRAL first fold changed: it is "
        "being powered on rows no coefficient is fitted on (R94 P0-A)")

    # --- power is computed on the term's OWN sample ------------------------
    by_name = {t["name"]: t for t in doc["terms"]}
    for name, rec in doc["power"].items():
        term = by_name[name]
        assert rec["n_treated"] == term["n_wet"], (name, rec["n_treated"],
                                                   term["n_wet"])
        assert rec["n_control"] == term["n_dry"], (name, rec["n_control"],
                                                   term["n_dry"])
        assert rec["analysis_sample"] == term["analysis_sample"], name
    strat = [t for t in doc["terms"] if t["analysis_sample"] == "stratified"]
    assert strat, "at least one term must be powered on a stratified sample"

    # --- (b) an underpowered term with a huge coefficient cannot adopt ------
    big = {
        "name": "fixture_underpowered", "arm": "MECHANISM", "position": "QB",
        "unit": "team_game", "outcome": "qb_fantasy_points",
        "form": "fixture", "hypothesis": "fixture", "pre_registered_sign": -1,
        "effect_of_interest": 1.32, "analysis_sample": "stratified",
        "stratum_rule": "fixture", "available": True, "unavailable_reason": "",
        "powered": False,               # the ONLY failing clause
        "n_wet": 10 ** 6, "n_dry": 10 ** 6, "n_treated_rows": 10 ** 6,
        "n_control_rows": 10 ** 6,
        "marginal_estimate": -13.2, "stratified_estimate": -13.2,
        "heldout_estimate": -13.2,     # 10x the effect of interest
        "confounded": False,
        "dose_response": [{"band": b, "n": 10, "value": 20.0 - i}
                          for i, b in enumerate(wc.PRECIP_BAND_NAMES)],
        "monotone": True, "ci95": [-13.3, -13.1], "se_fold": 1e-9,
        "se_stadium": 1e-9, "binding_threshold": 0.25, "binding_df": 20,
        "folds_sign": 4, "fold_estimates": {}, "rows_moved": 1000,
    }
    ok, reasons = would_adopt(big)
    assert ok is False and reasons == [REFUSAL_UNDERPOWERED], (ok, reasons)
    powered_copy = dict(big, powered=True)
    ok2, reasons2 = would_adopt(powered_copy)
    assert ok2 is True and reasons2 == [], (ok2, reasons2)

    # --- (c) non-monotone refuses; monotone with all else fixed flips true --
    bad_ladder = [{"band": b, "n": 10, "value": v} for b, v in
                  zip(wc.PRECIP_BAND_NAMES, (20.0, 18.0, 19.5, 17.0, 16.0))]
    good_ladder = [{"band": b, "n": 10, "value": v} for b, v in
                   zip(wc.PRECIP_BAND_NAMES, (20.0, 19.0, 18.0, 17.0, 16.0))]
    assert is_monotone(bad_ladder, -1) is False
    assert is_monotone(good_ladder, -1) is True
    assert is_monotone(good_ladder, +1) is False, "direction must matter"
    flat = [{"band": b, "n": 10, "value": 20.0} for b in wc.PRECIP_BAND_NAMES]
    assert is_monotone(flat, -1) is False, "a flat ladder demonstrates nothing"
    thin = [{"band": b, "n": (10 if i < 2 else 0),
             "value": (20.0 - i if i < 2 else None)}
            for i, b in enumerate(wc.PRECIP_BAND_NAMES)]
    assert is_monotone(thin, -1) is False, "two bands are not a dose-response"
    nm_rec = dict(powered_copy, monotone=False, dose_response=bad_ladder)
    ok3, reasons3 = would_adopt(nm_rec)
    assert ok3 is False and reasons3 == [REFUSAL_NON_MONOTONE], (ok3, reasons3)
    m_rec = dict(nm_rec, monotone=True, dose_response=good_ladder)
    ok4, _r4 = would_adopt(m_rec)
    assert ok4 is True, "the ONLY change was the ladder's shape"

    # --- the R92 no-op clause and the fold-sign clause ---------------------
    ok5, reasons5 = would_adopt(dict(powered_copy, rows_moved=0))
    assert ok5 is False and reasons5 == [REFUSAL_NO_ROWS_MOVED], reasons5
    ok6, reasons6 = would_adopt(dict(powered_copy, folds_sign=2))
    assert ok6 is False and reasons6 == [REFUSAL_FOLD_SIGN], reasons6
    ok7, reasons7 = would_adopt(dict(powered_copy, confounded=True))
    assert ok7 is False and reasons7 == [REFUSAL_CONFOUNDED], reasons7
    ok8, reasons8 = would_adopt(dict(powered_copy, heldout_estimate=+13.2))
    assert ok8 is False and set(reasons8) == {REFUSAL_WRONG_SIGN,
                                              REFUSAL_BELOW_THRESHOLD}, reasons8
    ok9, reasons9 = would_adopt(dict(powered_copy, n_wet=5, n_treated_rows=5))
    assert ok9 is False and reasons9 == [REFUSAL_TOO_FEW_FIRED], reasons9
    ok10, r10 = would_adopt(dict(powered_copy, heldout_estimate=-0.10))
    assert ok10 is False and r10 == [REFUSAL_BELOW_THRESHOLD], r10

    # --- (d) an absurd PRIMARY_MM fires nothing ----------------------------
    dry_terms = tuple(dict(h, threshold_mm=10_000.0) if "threshold_mm" in h else h
                      for h in HYPOTHESES)
    dry = run(hypotheses=dry_terms)
    rain = [t for t in dry["terms"] if "threshold_mm" in
            dict((h["name"], h) for h in dry_terms)[t["name"]]]
    assert rain, "the fixture must contain rain terms to zero out"
    for t in rain:
        assert t["n_wet"] == 0, (t["name"], t["n_wet"])
        assert t["rows_moved"] == 0, (t["name"], t["rows_moved"])
        assert t["would_adopt"] is False, t["name"]
    assert dry["verdict"]["name"] == VERDICT_NOT_POWERED, dry["verdict"]
    assert dry["verdict"]["adopted"] is False
    assert dry["verdict"]["families_registered"] == []

    # --- (f) the binding threshold is the larger THRESHOLD, not the larger SE
    # df 3 vs df 20 at alpha 0.05/10: t is 6.965 against 3.153, so a fold SE of
    # 0.010 gives 0.0697 and a stadium SE of 0.020 - TWICE as large - gives only
    # 0.0631. Choosing on SE would take the LOWER bar; choosing on threshold
    # takes 0.0697.
    t_fold, df_f = binding(0.010, 3, 0.020, 20, 0.0)
    assert df_f == 3 and abs(t_fold - threshold_for(0.010, 3, 0.0)) < 1e-12, t_fold
    assert t_fold > threshold_for(0.020, 20, 0.0), (
        "the larger SE carried the lower bar and the rule still took the larger "
        "THRESHOLD: %r vs %r" % (t_fold, threshold_for(0.020, 20, 0.0)))
    # Swap them and the choice reverses, with nothing else changed.
    t_stad, df_s = binding(0.002, 3, 0.020, 20, 0.0)
    assert df_s == 20 and abs(t_stad - threshold_for(0.020, 20, 0.0)) < 1e-12, t_stad
    assert threshold_for(None, 3, 0.0) is None, "no SE means NO threshold, not the floor"
    assert threshold_for(0.0, 3, 0.5) == 0.5, "the floor binds when the SE is tiny"
    assert binding(None, 0, None, 0, 0.1) == (None, None)

    # --- the estimator: a 0/1 treatment IS the weighted within-group contrast
    fixture_term = {"name": "fx", "kind": "rate", "group": "player_season",
                    "treatment": "threshold", "threshold_mm": 1.0,
                    "num": "receptions", "den": "targets", "stratum": None,
                    "sign": -1, "ladder": "precip", "min_treated": 1,
                    "min_control": 1, "positions": None, "unit": "player_week",
                    "outcome": "catch_rate"}
    fx_rows = [
        {"player_season": "p|2021", "season": 2021, "week": 1, "game_key": "g1",
         "stadium": "S1", "precip_mm": 0.0, "temp_c": 18.0, "wind_kph": 5.0,
         "targets": 10.0, "receptions": 7.0, "pos": None},
        {"player_season": "p|2021", "season": 2021, "week": 2, "game_key": "g2",
         "stadium": "S1", "precip_mm": 2.0, "temp_c": 18.0, "wind_kph": 5.0,
         "targets": 10.0, "receptions": 5.0, "pos": None},
    ]
    est = point_estimate(contributions(fixture_term, fx_rows))
    assert abs(est - (0.5 - 0.7)) < 1e-12, est    # exactly wet minus dry
    # ...and the harmonic weight is the precision weight, not the treated one.
    h = sum(c["H"] for c in contributions(fixture_term, fx_rows))
    assert abs(h - (10.0 * 10.0) / 20.0) < 1e-12, h

    # --- the renormalisation identity --------------------------------------
    weeks = {1: 10.0, 2: 10.0, 3: 10.0, 4: 10.0}
    after = _renormalise(weeks, {2: 0.90}, 40.0)
    assert abs(sum(after.values()) - 40.0) < 1e-12, after
    assert after[2] < 10.0 < after[1], after
    assert abs(after[2] - 9.0 * 40.0 / 39.0) < 1e-12, after[2]

    # --- REACH: the propagation moves a rung, and counts what moved --------
    pool = {"season": 2026, "week": 2,
            "support": {"QB": [-2.0, 2.0]}, "residual_sd": {"QB": 50.0},
            "players": [{"gsis_id": "q1", "position": "QB", "team": "AAA",
                         "mu": 240.0, "p_team": 0.5,
                         "rungs": [{"line": 199.5}, {"line": 149.5}]}]}
    calib = {"calibration": {"QB": {"a": 0.0, "b": 1.3, "c": 0.5}}}
    fcst = {"games": {"2026|2|AAA|BBB": {"source": "forecast", "precip_mm": 2.0}}}
    hit = reach_arm(0.90, pool_doc=pool, calib_doc=calib, weekly_doc={},
                    forecast_doc=fcst)
    assert hit["available"] and hit["rungs"] == 2, hit
    assert hit["games_triggering"] == 1, hit
    assert hit["max_abs_delta_p"] > POOL_ECE and hit["rungs_moved_beyond_ece"] >= 1, hit
    assert hit["slate"] == "2026 week 2", hit
    dry_slate = reach_arm(0.90, pool_doc=pool, calib_doc=calib, weekly_doc={},
                          forecast_doc={"games": {}})
    assert dry_slate["games_triggering"] == 0 and dry_slate["max_abs_delta_p"] == 0.0, dry_slate
    assert dry_slate["rungs_moved_beyond_ece"] == 0, dry_slate
    # A climatology row carries no precip and can never trigger the factor.
    clim = reach_arm(0.90, pool_doc=pool, calib_doc=calib, weekly_doc={},
                     forecast_doc={"games": {"2026|2|AAA|BBB":
                                             {"source": "climatology",
                                              "precip_mm": 9.0}}})
    assert clim["games_triggering"] == 0, clim
    # A rung leaving support is counted even when its probability barely moves.
    tight = dict(pool, support={"QB": [0.75, 2.0]})
    crossed = reach_arm(0.80, pool_doc=tight, calib_doc=calib, weekly_doc={},
                        forecast_doc=fcst)
    assert crossed["rungs_crossing_support"] >= 1, crossed

    # --- the placebo arm reports an interval, never a verdict --------------
    assert "terms" in doc["placebo"] and doc["placebo"]["terms"], doc["placebo"]
    for p in doc["placebo"]["terms"]:
        assert set(p) == {"term", "n_rows", "n_treated", "estimate", "se", "df",
                          "clusters", "ci95"}, sorted(p)
        assert "would_adopt" not in p and "powered" not in p

    # --- the corpus filter actually filtered, as identities not literals ---
    cf = doc["corpus_filter"]
    assert cf["dropped_relocations"] >= 1, (
        "the fixture plants a relocation in week %d and the reader must drop "
        "it: a venue filter that drops nothing did not run" % RELOCATION_WEEK)
    assert cf["rows_read"] - cf["rows_unjoined"] == cf["rows_joined"], cf
    assert cf["rows_joined"] - cf["dropped_relocations"] == cf["rows_kept"], cf
    assert cf["rows_kept"] < cf["rows_read"] and cf["roof_check_ok"] is True, cf
    sha = doc["weather_history_sha256"]
    assert len(sha) == 64 and set(sha) <= set("0123456789abcdef"), sha
    assert run()["weather_history_sha256"] == sha, "the digest is not stable"

    # --- every band present for every season, and the families partition ----
    cond = doc["conditions"]
    assert set(cond) == set(wc.CONDITIONS), sorted(set(cond) ^ set(wc.CONDITIONS))
    for name, by_season in cond.items():
        assert set(by_season) == set(str(s) for s in SEASONS), (name, by_season)
    for season in (str(s) for s in SEASONS):
        total = cond[wc.TOTAL_NAME][season]
        for family in (wc.PRECIP_BAND_NAMES, wc.WIND_BAND_NAMES):
            assert sum(cond[b][season] for b in family) == total, (season, family)

    # --- NO TERM MAY MEASURE AN EMPTY SAMPLE -------------------------------
    # This is the assertion the first draft of this file could not make. Its
    # fixture reproduced the real corpus's rain/wind collinearity exactly, so
    # the primary stratum held no wet game, every stratified term measured
    # nothing, and the selftest below it proved nothing about the term the
    # owner asked about.
    for name, rec in doc["power"].items():
        assert rec["n_treated"] > 0 and rec["n_control"] > 0, (
            "%s measured an EMPTY analysis sample; a selftest built on one "
            "asserts nothing" % name)

    # --- a slope's group floor is PREDICTOR SPREAD, not a 0/1 split --------
    wind_term = next(h for h in HYPOTHESES if h["name"] == "wind_epa_per_dropback")
    calm = [{"team_season": "T|2021", "season": 2021, "week": w,
             "game_key": "g%d" % w, "stadium": "S", "precip_mm": 0.0,
             "temp_c": 18.0, "wind_kph": 5.0 + w, "dropbacks": 30.0,
             "epa_per_dropback": 0.10 - 0.002 * w, "pos": None}
            for w in range(1, 6)]
    assert term_rows(wind_term, calm) == calm, (
        "a team-season that never played above %g kph was dropped from a "
        "CONTINUOUS slope. That line is a REPORTING split for n_wet/n_dry, and "
        "those groups are exactly the ones that pin the calm end of the line."
        % WIND_TREATED_KPH)
    assert not any(term_treated(wind_term, r) for r in calm), "none are treated"
    assert term_rows(wind_term, [dict(r, wind_kph=12.0) for r in calm]) == [], (
        "a group with no predictor spread carries no slope information")

    # --- (b) END TO END: a measured term that clears its own bar and STILL
    #     cannot adopt, because the power stage ran first and said no --------
    te = by_name["rain_catch_rate_te"]
    te_power = doc["power"]["rain_catch_rate_te"]
    assert te["powered"] is False, te_power
    assert te_power["mde"] > te_power["effect_of_interest"], te_power
    assert abs(te["heldout_estimate"]) > te["binding_threshold"], te
    assert te["would_adopt"] is False, te
    assert te["refused_reasons"] == [REFUSAL_UNDERPOWERED], te["refused_reasons"]

    # THE CONTROL POSITION. The fixture plants no effect on RB catch rate, and
    # the machinery has to say so rather than finding one.
    rb = by_name["rain_catch_rate_rb"]
    assert rb["heldout_estimate"] == 0.0 and rb["monotone"] is False, rb
    assert rb["would_adopt"] is False, rb

    # --- (c) END TO END: only the LADDER'S SHAPE is permuted ---------------
    zig = run(*(), **dict(zip(
        ("weather_doc", "games_meta_doc", "context_doc", "epa_doc", "dvp_doc",
         "team_rates", "player_rates"), _synthetic(monotone=False))))
    z_primary = {t["name"]: t for t in zig["terms"]}[PRIMARY_TERM]
    d_primary = by_name[PRIMARY_TERM]
    assert d_primary["monotone"] is True and d_primary["would_adopt"] is True
    assert z_primary["monotone"] is False, z_primary["dose_response"]
    assert REFUSAL_NON_MONOTONE in z_primary["refused_reasons"], z_primary
    assert z_primary["n_wet"] == d_primary["n_wet"], (
        "the permuted fixture must move the ladder's SHAPE and nothing else: "
        "%r vs %r" % (z_primary["n_wet"], d_primary["n_wet"]))

    # --- the verdict names the PRIMARY when the primary wins ---------------
    assert doc["verdict"]["name"] == PRIMARY_TERM, doc["verdict"]
    assert PRIMARY_TERM in doc["verdict"]["adoptable_candidates"]
    assert _leading_winner([{"name": "big_units", "heldout_estimate": -0.9,
                             "binding_threshold": 0.8},
                            {"name": "small_units", "heldout_estimate": -0.1,
                             "binding_threshold": 0.01}]) == "small_units", (
        "the leading winner is the largest margin over its OWN threshold. "
        "Ranking on the raw coefficient compares fantasy points against catch "
        "rate, which is not a comparison.")

    # --- the contract, in memory: the artifact validates, and five reds bite
    from scripts import validate_data as vd
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)
    errs = []
    vd._validate(doc, schema, "weather_backtest", errs)
    assert not errs, errs[:6]

    def red(mutate, why):
        bad = copy.deepcopy(doc)
        mutate(bad)
        e = []
        vd._validate(bad, schema, "weather_backtest", e)
        assert e, "the contract accepted %s" % why

    red(lambda d: d["verdict"].__setitem__("adopted", True), "verdict.adopted true")
    red(lambda d: d["verdict"].__setitem__("families_registered", ["weather_wind"]),
        "a registered family")
    red(lambda d: d["terms"][0].__setitem__("powered", "false"),
        "powered as the STRING 'false'")
    red(lambda d: d["terms"][0].pop("n_wet"), "a terms row missing n_wet")
    red(lambda d: d["terms"][0].__setitem__("refused_reasons", ["because"]),
        "a refusal outside the enum")
    red(lambda d: d["corpus_filter"].__setitem__("dropped_relocations", 0),
        "zero dropped relocations")
    red(lambda d: d.__setitem__("policy", d["policy"][:2]), "a two-line policy")

    # --- the WRITE path, end to end, entirely under TMPDIR -----------------
    import tempfile
    tmp = tempfile.mkdtemp(prefix="r94_weather_")
    try:
        out_path = os.path.join(tmp, "weather_backtest.json")
        write(doc, out_path)
        with open(out_path, encoding="utf-8") as fh:
            text = fh.read()
        assert text.endswith("}\n"), "the repo's data files end in a newline"
        again = json.loads(text)
        e = []
        vd._validate(again, schema, "weather_backtest", e)
        assert not e, e[:6]
        assert again["verdict"]["adopted"] is False, again["verdict"]
        assert again["verdict"]["families_registered"] == [], again["verdict"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- nothing here claims an adoption -----------------------------------
    assert doc["verdict"]["adopted"] is False
    assert doc["verdict"]["families_registered"] == []
    assert all(t["name"] in [h["name"] for h in HYPOTHESES] for t in doc["terms"])
    assert len(doc["terms"]) == len(HYPOTHESES) == N_TESTS

    print("selftest OK: power runs first and is blind to the held-out season "
          "(a permuted eval outcome leaves the table byte-identical while a "
          "permuted TRAINING outcome moves it), power.n_treated equals each "
          "term's own n_wet on the term's own analysis sample, an underpowered "
          "term with a coefficient 10x its effect of interest refuses with "
          "'underpowered' and adopts the moment the flag flips, a non-monotone "
          "ladder refuses and the same record with a monotone one adopts, "
          "rows_moved 0 and a 2-of-4 fold sign each refuse alone, an absurd "
          "threshold leaves n_wet 0 / rows_moved 0 / verdict 'not_powered', the "
          "binding threshold takes the larger THRESHOLD even when the other "
          "clustering has twice the SE and reverses when they are swapped, the "
          "0/1 estimator is exactly the harmonic-weighted within-group contrast, "
          "the REACH chain moves a rung and counts a support crossing while a "
          "climatology row never triggers, and the artifact validates against "
          "the closed contract while seven mutations - adopted true, a "
          "registered family, powered as a string, a missing n_wet, a refusal "
          "outside the enum, zero dropped relocations, a short policy - each red it. "
          "Also: no term measures an empty analysis sample (the defect that made "
          "the first draft of this selftest vacuous); a continuous slope keeps "
          "every team-season that never played in a gale and drops only groups "
          "with no predictor spread; the measured TE catch-rate term clears its "
          "own binding threshold and still refuses with exactly "
          "['underpowered'], which is acceptance (b) on a real measurement "
          "rather than a hand-built record; the RB control position measures "
          "exactly zero; permuting only the planted LADDER flips the primary "
          "from would_adopt true to non_monotone with n_wet unchanged; the "
          "verdict names the primary rather than the largest coefficient, "
          "because fantasy points and catch rate are not comparable; the "
          "corpus-filter identities hold and the digest is a stable 64-hex "
          "value; all 21 conditions are present for all five seasons and both "
          "band families partition the sample; and the written file ends in a "
          "newline, validates from disk and still carries adopted false with an "
          "empty families_registered")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help="a wet-rates corpus built OUTSIDE the repo "
                             "(build_wet_rates.py --out-dir <dir>); used only "
                             "when the committed fixture is the synthetic "
                             "placeholder")
    parser.add_argument("--out", default=OUT_PATH)
    parser.add_argument("--offline", action="store_true",
                        help="read only committed fixtures; ignore --cache-dir")
    parser.add_argument("--no-control", action="store_true",
                        help="skip the CONTROL arm (it re-prices 8,279 rows "
                             "through the deployed split)")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if args.selftest:
        selftest()
        return 0

    player_rates = wr.load_player_rates()
    team_rates = wr.load_team_rates()
    ok, why = wr.available(player_rates)
    if not ok and not args.offline and os.path.isdir(args.cache_dir):
        alt = wr.load_player_rates(out_dir=args.cache_dir)
        alt_team = wr.load_team_rates(out_dir=args.cache_dir)
        alt_ok, alt_why = wr.available(alt)
        if alt_ok:
            player_rates, team_rates = alt, alt_team
            if not args.quiet:
                print("rate substrate: %s" % args.cache_dir)
        else:
            if not args.quiet:
                print("NOTICE: %s unusable (%s)" % (args.cache_dir, alt_why),
                      file=sys.stderr)
    ok, why = wr.available(player_rates)
    if not ok and not args.quiet:
        print("NOTICE: rate substrate unavailable (%s) - every rate term will "
              "report substrate_unavailable rather than measure on hand-made "
              "numbers" % why, file=sys.stderr)

    sha_before = wc.corpus_sha256()
    control = None if args.no_control else control_arm()
    doc = measure(team_rates=team_rates, player_rates=player_rates,
                  control=control, corpus_sha=sha_before)
    sha_after = wc.corpus_sha256()
    assert sha_before == sha_after, (
        "data/weather_history.json changed during a measurement run - the "
        "relocation filter is supposed to live in the reader")
    write(doc, args.out)

    if not args.quiet:
        cf = doc["corpus_filter"]
        print("corpus: %d read, %d joined, %d relocations dropped, %d kept (%s)"
              % (cf["rows_read"], cf["rows_joined"], cf["dropped_relocations"],
                 cf["rows_kept"], cf["roof_check"]))
        print("%-28s %-10s %8s %8s %10s %10s %10s %s"
              % ("term", "sample", "n_wet", "n_dry", "mde", "estimate",
                 "threshold", "would_adopt"))
        for t in doc["terms"]:
            p = doc["power"][t["name"]]
            print("%-28s %-10s %8d %8d %10s %10s %10s %s%s"
                  % (t["name"], t["analysis_sample"], t["n_wet"], t["n_dry"],
                     _fmt(p["mde"]), _fmt(t["heldout_estimate"]),
                     _fmt(t["binding_threshold"]), t["would_adopt"],
                     ("  [%s]" % ",".join(t["refused_reasons"]))
                     if t["refused_reasons"] else ""))
        ctrl = doc["arms"]["control"]
        if ctrl.get("available"):
            for name, s in sorted(ctrl["series"].items()):
                print("control %-14s MAE %-8s rank_corr %s"
                      % (name, _fmt(s["pooled_mae"]), _fmt(s["rank_corr"])))
        reach = doc["arms"]["reach"]
        print("reach: %s, %d rungs, %d beyond ECE %.4f, %d crossing support, "
              "%d forecast games trigger"
              % (reach.get("slate"), reach.get("rungs") or 0,
                 reach.get("rungs_moved_beyond_ece") or 0, reach.get("ece"),
                 reach.get("rungs_crossing_support") or 0,
                 reach.get("games_triggering") or 0))
        print("verdict: %s (adopted=%s, families_registered=%s)"
              % (doc["verdict"]["name"], doc["verdict"]["adopted"],
                 doc["verdict"]["families_registered"]))
        print("wrote %s" % args.out)
    return 0


def _fmt(x):
    return "None" if x is None else ("%.5f" % x)


if __name__ == "__main__":
    sys.exit(main())
