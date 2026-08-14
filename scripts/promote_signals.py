"""PROMOTE game-level candidate signals into the game model — NEVER-REGRESS.

v2: the gate now tests candidate FAMILIES, each an additive per-game Elo delta
on top of the incumbent model, walk-forward on seasons 2022-2025:

  environment  venue-specific HFA + cold-weather (residual-fitted; the Rel6
               family, kept under test forever)
  rest         rest-day differential from kickoff dates (nfelo-style: byes and
               short weeks are real, ~0.5 pts documented) — runs offline from
               the committed finals fixtures
  epa_total    rolling EPA margin differential (off EPA/play - def EPA/play,
               shrunk + prev-season blended) — the industry-standard predictive
               core (nfelo/PFF/Sumer all price off EPA)
  epa_pass     pass-only EPA margin (QB-form proxy)

EPA families need data/epa_history.json (built by the weekly backtest workflow
on a GitHub runner — the sandbox proxy 403s nflverse). When the file is absent
those families are SKIPPED with a recorded notice, never faked.

LEAK-FREEDOM (the whole ballgame):
  * Every eval season Y prices games with priors from season Y-1 and features
    computed ONLY from information available before kickoff: residual features
    fit on seasons < Y; EPA features for a week-W game use weeks < W of season
    Y blended with season Y-1; rest days derive from the schedule itself.
  * Rating updates always use the FLAT incumbent hfa — candidate deltas shift
    PRICING only, never the rating trajectory.

ADOPTION (the discipline that makes it self-learning, not self-deluding):
  * Incumbent = flat params + families ALREADY adopted in game_params (their
    features recomputed leak-free at the adopted scales).
  * At most ONE family is adopted per run — the best scale of the best family.
    Sequential forward selection, one honest step per weekly cron run.
  * --auto-adopt actually writes game_params; without it the run is a dry run
    that records trials only. Every trial is archived either way.
  * The incumbent walk also emits CALIBRATION bins (predicted-prob buckets vs
    actual home-win rates) for the MODEL tab.

SIGNIFICANCE GATE (R18 — replaces the fixed 0.0015 adoption margin):
  A fixed margin is not a significance threshold. On the 2022-2025 fixtures
  0.0015 nats is roughly 0.85 standard errors of the paired improvement, so a
  candidate could "clear" it while its 95% confidence interval still spanned
  zero — i.e. while being statistically indistinguishable from noise. Adding
  candidate families to a gate that loose adopts noise faster, not slower.

  A candidate is now adopted only when ALL THREE hold:
    1. EFFECT FLOOR   improvement > MIN_EFFECT (= the old MARGIN). Kept so the
       new gate is strictly stricter than the old one: nothing that failed
       before can pass now, and a statistically clean but practically
       meaningless improvement still cannot buy pricing weight.
    2. SIGNIFICANCE   the paired per-game log-loss improvement must exceed
       t_crit x its own standard error, where the standard error is estimated
       CLUSTER-ROBUSTLY over the walk-forward folds (see paired_fold_stats):
       games inside one fold share fitted features and one rating trajectory,
       so they are not independent draws and an i.i.d. standard error would
       overstate the evidence by a large factor.
    3. MULTIPLICITY   t_crit is Bonferroni-corrected for EVERY trial the run
       evaluated, because the candidate is the argmin over all of them. The
       selection is what inflates the apparent improvement, so the selection
       is what must be paid for.
  The threshold actually applied, max(MIN_EFFECT, t_crit x se), is recorded as
  the entry's `margin` — the never-regress rule is unchanged in form (beat the
  incumbent by more than the margin), only the margin is now earned from the
  data instead of being a constant. Every trial records its own t statistic and
  95% confidence interval, so a candidate that fails is visibly a coin flip
  rather than silently discarded.

  Consequence, stated plainly: with four eval seasons the fold-clustered test
  has three degrees of freedom, so almost nothing can clear it. That is the
  honest reading of 1,084 games, and it is the argument for evaluating over the
  expanded corpus (data/fixtures/backtest_corpus/, --corpus) where more folds
  buy real power.
"""

import functools
import json
import math
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
EPA_PATH = os.path.join(DATA, "epa_history.json")
SEASONS = [2021, 2022, 2023, 2024, 2025]
EVAL_SEASONS = [2022, 2023, 2024, 2025]

SHRINK_N = 16                      # residual shrinkage: n/(n+SHRINK_N)
VENUE_SCALES = [0.0, 150.0, 250.0, 350.0]   # Elo per unit mean residual (0 = off)
COLD_SCALES = [0.0, 150.0, 250.0, 350.0]
COLD_MONTHS = (11, 12, 1, 2)       # Nov-Feb kickoffs
COLD_HOMES = frozenset(ab for ab, s in STADIUMS.items()
                       if s.get("cold_region") and s.get("roof") == "open")

REST_SCALES = [0.0, 1.5, 3.0, 4.5, 6.0]     # Elo per day of rest advantage
REST_CLAMP = 7                     # |home_rest - away_rest| capped at a bye's worth
REST_BASELINE = 7                  # first game of a season counts as normal rest

EPA_SCALES = [0.0, 200.0, 350.0, 500.0]     # Elo per unit EPA-margin differential
EPA_N0 = 600                       # plays at which current season outweighs prior

WEATHER_PATH = os.path.join(DATA, "weather_history.json")
FORECAST_PATH = os.path.join(DATA, "weather_forecast.json")
BASELINE_PATH = os.path.join(DATA, "market_baseline.json")
INJURY_PATH = os.path.join(DATA, "injury_history.json")
USAGE_PATH = os.path.join(DATA, "player_usage.json")
USAGE_HISTORY_PATH = os.path.join(DATA, "player_usage_history.json")

# elo_epa: a PARALLEL rating track driven by per-play EPA margins instead of
# scores (the Rel7 finding: EPA *added onto* score-Elo double-counts; rating
# FROM EPA is the honest experiment). Priced as a blend weight over the
# rating-difference: delta = w * ((Eh - Ea) - (Rh - Ra)).
EPA_BLEND_WEIGHTS = [0.05, 0.10, 0.15, 0.30, 0.50]
EPA_SIGMA = 0.15                   # per-play margin -> pseudo-outcome logistic scale

WIND_KPH = 30.0                    # 'windy game' threshold (open roofs only)
WIND_SCALES = [-60.0, -45.0, -30.0, -15.0, 15.0, 30.0, 45.0]  # sign unknown a priori

QB_OUT_SCALES = [25.0, 50.0, 75.0]  # Elo penalty when the primary passer is Out/Doubtful

# skill_out: Elo per unit of LOST within-team opportunity share when RB/WR/TE
# starters are Out/Doubtful. A team missing 30% of its opportunity (share 0.30
# out) moves 0.30 * scale Elo. Scales span a plausible band; sign is fixed
# (losing usage weakens you) but magnitude is earned by NEVER-REGRESS.
SKILL_OUT_SCALES = [40.0, 80.0, 120.0, 160.0]
SKILL_POSITIONS = ("RB", "WR", "TE")

CAL_BINS = 10
_EPS = 1e-12

# --- adoption gate ---------------------------------------------------------- #
MIN_EFFECT = MARGIN        # effect-size floor (the old fixed margin, retained)
SIG_ALPHA = 0.05           # one-sided false-adoption rate BEFORE multiplicity
CI_LEVEL = 0.95            # two-sided level for the reported (uncorrected) CI

# Expanded corpus (scripts/build_backtest_corpus.py). Opt-in via --corpus: the
# default run keeps reading the committed ESPN fixtures so the cron, the
# prediction builder and the contract tests see exactly the shape they always
# have.
FIXTURE_DIR = os.path.join(DATA, "fixtures")
CORPUS_DIR = os.path.join(DATA, "fixtures", "backtest_corpus")


# --------------------------------------------------------------------------- #
# statistics (stdlib only — no scipy; verified against published values in     #
# selftest())                                                                  #
# --------------------------------------------------------------------------- #

def _betacf(a, b, x, itmax=400, eps=3e-16):
    """Continued fraction for the incomplete beta function (modified Lentz)."""
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        step = d * c
        h *= step
        if abs(step - 1.0) < eps:
            break
    return h


def betainc(a, b, x):
    """Regularized incomplete beta I_x(a, b), 0 <= x <= 1."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
                     + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def student_t_sf(t, df):
    """Upper-tail P(T > t) for Student's t with df degrees of freedom."""
    if df <= 0:
        raise ValueError("df must be > 0")
    if t != t:                                   # NaN in, NaN out is worse
        raise ValueError("t must be a number")
    if t == 0.0:
        return 0.5
    two_tail = betainc(df / 2.0, 0.5, df / (df + float(t) * float(t)))
    return 0.5 * two_tail if t > 0 else 1.0 - 0.5 * two_tail


@functools.lru_cache(maxsize=512)
def student_t_ppf(p, df):
    """Inverse CDF of Student's t: the value t with P(T <= t) == p.

    Bisection on the (monotone) survival function — slower than a rational
    approximation and exactly as accurate as student_t_sf, which is what the
    gate is entitled to rely on.
    """
    if not 0.0 < p < 1.0:
        raise ValueError("p must be in (0, 1)")
    target = 1.0 - p
    lo, hi = -1.0e7, 1.0e7
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if student_t_sf(mid, df) > target:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-12 * max(1.0, abs(mid)):
            break
    return 0.5 * (lo + hi)


def adoption_threshold(se, df, n_trials, alpha=SIG_ALPHA, floor=MIN_EFFECT):
    """The improvement a candidate must EXCEED to be adopted, in log-loss units.

    max(floor, t_crit x se), where t_crit is the one-sided Student-t critical
    value at alpha/n_trials with `df` degrees of freedom. The Bonferroni divisor
    is the number of trials the run evaluated, because the candidate put to this
    test is the argmin over all of them — the selection is what inflates the
    apparent improvement, so the selection is what must be paid for.

    Returns {threshold, t_crit, alpha_bonferroni}; threshold is None when the
    uncertainty cannot be estimated (fewer than two folds), which the caller
    must treat as 'do not adopt', never as 'adopt freely'.
    """
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be in (0, 1)")
    if floor < 0:
        raise ValueError("floor must be >= 0 (a negative floor admits regressions)")
    if se is None or df is None or df < 1:
        return {"threshold": None, "t_crit": None, "alpha_bonferroni": None}
    a = float(alpha) / max(int(n_trials), 1)
    t_crit = student_t_ppf(1.0 - a, df)
    return {"threshold": round(max(floor, t_crit * float(se)), 5),
            "t_crit": t_crit, "alpha_bonferroni": a}


def should_adopt(improvement, se, df, n_trials, alpha=SIG_ALPHA, floor=MIN_EFFECT):
    """NEVER-REGRESS, significance form. True only when `improvement` (positive
    = the candidate beats the incumbent) exceeds both the effect floor and its
    own Bonferroni-corrected significance threshold. A worse, tied, or merely
    noisy candidate can never return True."""
    th = adoption_threshold(se, df, n_trials, alpha, floor)["threshold"]
    return th is not None and improvement > th


def paired_fold_stats(deltas_by_fold):
    """Cluster-robust paired statistics for per-game log-loss differences.

    deltas_by_fold: {fold: [d_i]} with d_i = incumbent_loss_i - candidate_loss_i
    (positive = the candidate priced game i better). Both walks score exactly
    the same games in the same order, so the pairing is game-for-game.

    The mean of d is the reported improvement. Its variance is estimated with a
    CR1 cluster sandwich over the walk-forward folds rather than an i.i.d.
    formula: within a fold every game is priced by the same fitted features and
    the same rating trajectory, so the games are not independent evidence. The
    t statistic is referenced to df = G - 1 (G = folds), the conservative
    small-cluster convention.

    Returns {n, folds, df, mean, se, t, fold_means, folds_positive} or None.
    """
    folds = {f: list(v) for f, v in deltas_by_fold.items() if v}
    n = sum(len(v) for v in folds.values())
    if not n:
        return None
    g = len(folds)
    mean = sum(sum(v) for v in folds.values()) / n
    fold_means = {f: sum(v) / len(v) for f, v in folds.items()}
    out = {"n": n, "folds": g, "df": max(g - 1, 0), "mean": mean,
           "fold_means": fold_means,
           "folds_positive": sum(1 for m in fold_means.values() if m > 0)}
    if g < 2:
        out["se"] = None       # one cluster carries no between-fold evidence
        out["t"] = 0.0
        return out
    ss = 0.0
    for v in folds.values():
        s = sum(d - mean for d in v)
        ss += s * s
    var = (g / (g - 1.0)) * ss / float(n * n)
    se = math.sqrt(var) if var > 0.0 else 0.0
    out["se"] = se
    out["t"] = (mean / se) if se > 0.0 else (math.inf if mean > 0.0 else 0.0)
    return out


def _load_json(path, key):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return (json.load(fh)).get(key) or None


def _spans_seasons(covered):
    """True when `covered` includes EVERY season in the current SEASONS set.

    A family whose inputs cover only part of the walk still gets scored on
    every fold: its builder returns 0.0 for the games it cannot see, which is
    an exact tie with the incumbent. Those ties are counted in n and in the CR1
    variance, so they dilute the measured improvement toward zero and make
    `folds_positive` conflate 'no data here' with 'no help here'. Under
    --corpus (1999-2025) that is a ~12x dilution for a 2021-2025 input.
    epa_week_margins() has always guarded this; weather_wind and skill_out now
    do too. Partial coverage means SKIP the family loudly, never score it.
    """
    c = {str(x) for x in covered}
    return all(str(y) in c for y in SEASONS)


def load_weather_map():
    """{season|week|home|away: wind_kph}, or None when the builder has not run
    or its games do not span SEASONS (see _spans_seasons)."""
    games = _load_json(WEATHER_PATH, "games")
    if not games:
        return None
    if not _spans_seasons(k.split("|", 1)[0] for k in games):
        return None
    return {k: v.get("wind_kph") for k, v in games.items()}


def load_baseline_map():
    """{season|week|home|away: de-vigged home prob} or None. MEASUREMENT ONLY."""
    return _load_json(BASELINE_PATH, "games")


def epa_week_margins():
    """{(season, week, team): per-play epa margin} from epa_history, or None."""
    seasons = _load_json(EPA_PATH, "seasons")
    if not seasons or not all(str(y) in seasons for y in SEASONS):
        return None
    out = {}
    for yr_s, teams in seasons.items():
        for team, weeks in teams.items():
            for wk, c in weeks.items():
                if not isinstance(c, dict) or not c.get("off_plays") or not c.get("def_plays"):
                    continue
                m = c["off_epa"] / c["off_plays"] - c["def_epa"] / c["def_plays"]
                out[(int(yr_s), int(wk), team)] = m
    return out


def qb_out_inputs():
    """(primaries, outs) for the qb_out family, or None until the runner has
    built BOTH passer aggregates (epa_history) and injury_history.

    primaries[(season, team, week)] -> the expected starter's passer id for that
    week: the passer with the most cumulative dropbacks in weeks < week (weeks
    from the PRIOR season when week 1) — pregame information only.
    outs[(season, week, team)] -> set of Out/Doubtful player ids.
    """
    seasons = _load_json(EPA_PATH, "seasons")
    injuries = _load_json(INJURY_PATH, "seasons")
    if not seasons or not injuries:
        return None
    if not any("passers" in c for t in seasons.get(str(SEASONS[0]), {}).values()
               for c in t.values()):
        return None                      # pre-passer-format file: runner refresh pending
    primaries = {}
    for yr in SEASONS:
        teams = seasons.get(str(yr)) or {}
        prev = seasons.get(str(yr - 1)) or {}
        for team, weeks in teams.items():
            cum = {}
            # Week-1 expectation: last season's dropback leader.
            for c in (prev.get(team) or {}).values():
                for pid, rec in (c.get("passers") or {}).items():
                    cum[pid] = cum.get(pid, 0) + rec["db"]
            for wk in sorted((int(w) for w in weeks), key=int):
                if cum:
                    primaries[(yr, team, wk)] = max(cum.items(), key=lambda kv: kv[1])[0]
                for pid, rec in (weeks[str(wk)].get("passers") or {}).items():
                    cum[pid] = cum.get(pid, 0) + rec["db"]
    outs = {}
    for yr_s, teams in injuries.items():
        for team, weeks in teams.items():
            for wk, rows in weeks.items():
                outs[(int(yr_s), int(wk), team)] = {
                    r["id"] for r in rows
                    if r.get("position") == "QB" and r.get("status") in ("Out", "Doubtful")
                    and r.get("id")}
    return primaries, outs


def skill_out_inputs():
    """(shares_by_season, outs) for the skill_out family, or None until the
    runner has built BOTH player_usage_history and injury_history.

    shares_by_season[season] -> {pid: within-team opportunity share} for that
    season. outs[(season, week, team)] -> set of RB/WR/TE Out/Doubtful pids.
    The builder prices a game with the PRIOR season's shares (pregame-honest).
    """
    usage = _load_json(USAGE_HISTORY_PATH, "seasons")
    injuries = _load_json(INJURY_PATH, "seasons")
    if not usage or not injuries:
        return None
    if not _spans_seasons(usage) or not _spans_seasons(injuries):
        return None                      # partial coverage would dilute, not measure
    shares_by_season = {
        int(yr): {pid: rec["share"] for pid, rec in players.items()}
        for yr, players in usage.items()
    }
    outs = {}
    for yr_s, teams in injuries.items():
        for team, weeks in teams.items():
            for wk, rows in weeks.items():
                s = {r["id"] for r in rows
                     if r.get("position") in SKILL_POSITIONS
                     and r.get("status") in ("Out", "Doubtful") and r.get("id")}
                if s:
                    outs[(int(yr_s), int(wk), team)] = s
    return shares_by_season, outs


def load_finals(year):
    """Regular-season finals for one season, in kickoff order.

    Reads FIXTURE_DIR, which is the committed ESPN fixtures by default and the
    expanded corpus under --corpus. Corpus records carry postseason rows and a
    `gameday` fallback for seasons whose kickoff clock time is unknown; both are
    handled here so every downstream builder keeps its 'regular season, kickoff
    order' contract.
    """
    with open(os.path.join(FIXTURE_DIR, f"finals_{year}.json"), encoding="utf-8") as fh:
        games = json.load(fh)["games"]
    games = [g for g in games if (g.get("game_type") or "REG") == "REG"]
    games.sort(key=lambda g: (g.get("kickoff_utc") or g.get("gameday") or ""))
    return games


def use_corpus():
    """Point the gate at data/fixtures/backtest_corpus/ (--corpus).

    Rebinds the module's season set and fixture directory, which every builder
    reads through, and returns the season list. Raises when the corpus has not
    been built — a missing corpus is never silently downgraded to the small
    fixture set, because that would report a corpus result that isn't one.
    """
    global FIXTURE_DIR, SEASONS, EVAL_SEASONS
    manifest = os.path.join(CORPUS_DIR, "manifest.json")
    if not os.path.exists(manifest):
        raise SystemExit(f"corpus not built: {manifest} absent "
                         "(run scripts/build_backtest_corpus.py)")
    years = sorted(int(f[7:11]) for f in os.listdir(CORPUS_DIR)
                   if f.startswith("finals_") and f.endswith(".json"))
    if not years:
        raise SystemExit(f"corpus not built: no finals_*.json in {CORPUS_DIR}")
    FIXTURE_DIR = CORPUS_DIR
    SEASONS = years
    EVAL_SEASONS = years[1:]        # season 1 seeds the priors, never evaluated
    return years


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


# --------------------------------------------------------------------------- #
# per-game candidate features                                                 #
# --------------------------------------------------------------------------- #

def _date_ord(kickoff_utc):
    """Kickoff date as an ordinal day number (UTC date part), or None."""
    try:
        import datetime as dt
        return dt.date(int(kickoff_utc[0:4]), int(kickoff_utc[5:7]),
                       int(kickoff_utc[8:10])).toordinal()
    except (TypeError, ValueError):
        return None


def rest_diffs(games):
    """Per-game clamped (home_rest - away_rest) in days, from kickoff dates.

    A team's rest = days since its previous game this season; the season opener
    counts as REST_BASELINE (normal week) so openers contribute no signal.
    """
    last = {}
    diffs = []
    for g in games:
        d = _date_ord(g.get("kickoff_utc"))
        rests = {}
        for side in ("home", "away"):
            team = g[side]
            prev = last.get(team)
            rests[side] = (d - prev) if (d is not None and prev is not None) else REST_BASELINE
        diff = max(-REST_CLAMP, min(REST_CLAMP, rests["home"] - rests["away"]))
        diffs.append(float(diff))
        for side in ("home", "away"):
            if d is not None:
                last[g[side]] = d
    return diffs


class EpaFeatures:
    """Leak-free rolling EPA margins from data/epa_history.json.

    margin(team, season, week) blends this season's weeks < week with the full
    prior season: w = cur_plays/(cur_plays + EPA_N0). kind: 'total' or 'pass'.
    """

    def __init__(self, seasons_doc, kind):
        self.doc = seasons_doc
        self.pp = ("off_pass_plays", "off_pass_epa", "def_pass_plays", "def_pass_epa") \
            if kind == "pass" else ("off_plays", "off_epa", "def_plays", "def_epa")

    def _margin_and_plays(self, sums):
        op, oe, dp, de = sums
        off = (oe / op) if op else 0.0
        dfn = (de / dp) if dp else 0.0
        return off - dfn, op + dp

    def _season_sums(self, season, team, before_week=None):
        weeks = ((self.doc.get(str(season)) or {}).get(team)) or {}
        acc = [0.0, 0.0, 0.0, 0.0]
        kp, ke, kdp, kde = self.pp
        for wk, cell in weeks.items():
            if before_week is not None and int(wk) >= before_week:
                continue
            acc[0] += cell[kp]
            acc[1] += cell[ke]
            acc[2] += cell[kdp]
            acc[3] += cell[kde]
        return acc

    def margin(self, season, team, week):
        cur_m, cur_n = self._margin_and_plays(self._season_sums(season, team, week))
        prev_m, prev_n = self._margin_and_plays(self._season_sums(season - 1, team))
        if not prev_n:
            prev_m = 0.0
        w = cur_n / (cur_n + EPA_N0)
        return w * cur_m + (1.0 - w) * prev_m

    def diff(self, game, season):
        try:
            week = int(game.get("week"))
        except (TypeError, ValueError):
            return 0.0
        return (self.margin(season, game["home"], week)
                - self.margin(season, game["away"], week))

    def has_season(self, season):
        return str(season) in self.doc and len(self.doc[str(season)]) >= 30


def load_epa_features(kind):
    """EpaFeatures or None (file absent / seasons incomplete — SKIP, don't fake)."""
    if not os.path.exists(EPA_PATH):
        return None
    with open(EPA_PATH, encoding="utf-8") as fh:
        doc = (json.load(fh)).get("seasons") or {}
    feats = EpaFeatures(doc, kind)
    if not all(feats.has_season(y) for y in SEASONS):
        return None
    return feats


# --------------------------------------------------------------------------- #
# walk-forward machinery                                                      #
# --------------------------------------------------------------------------- #

def walk_season(games, priors, hfa, k, delta_fn=None, collect_residuals=False,
                calibration=None, probs=None):
    """Predict-then-update one season. Returns (log_loss_sum, n, residuals).

    delta_fn(game, idx) -> Elo added to hfa for pricing THAT game.
    Rating updates always use the FLAT hfa (see module docstring).
    calibration: optional [n, sum_expected, sum_actual] x CAL_BINS accumulator.
    """
    ratings = dict(priors)
    ll = 0.0
    n = 0
    residuals = []
    for idx, g in enumerate(games):
        h, a = g["home"], g["away"]
        rh = ratings.setdefault(h, elo_mod.INIT)
        ra = ratings.setdefault(a, elo_mod.INIT)
        hfa_eff = hfa + (delta_fn(g, idx) if delta_fn else 0.0)
        p = elo_mod.expected_home(rh, ra, hfa_eff)
        hs, as_ = g["home_score"], g["away_score"]
        if hs != as_:
            actual = 1.0 if hs > as_ else 0.0
            p_c = min(max(p, _EPS), 1.0 - _EPS)
            ll += -(actual * math.log(p_c) + (1.0 - actual) * math.log(1.0 - p_c))
            n += 1
            if collect_residuals:
                p_flat = elo_mod.expected_home(rh, ra, hfa)
                residuals.append((h, actual - p_flat, is_cold_game(g)))
            if calibration is not None:
                b = min(CAL_BINS - 1, int(p_c * CAL_BINS))
                calibration[b][0] += 1
                calibration[b][1] += p_c
                calibration[b][2] += actual
            if probs is not None:
                probs.append((g, p_c, actual))
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


def _incumbent_family_fns(tuning):
    """Delta builders for families ALREADY adopted in game_params — they are part
    of the incumbent every candidate must now beat.

    Returns (builders, unavailable): `unavailable` names every applied family
    whose inputs could not be rebuilt for this season set, so a run can never
    quietly compare candidates against a WEAKER incumbent than production ships
    (it happens for real: the corpus reaches back to 1999, the EPA and injury
    histories do not).
    """
    gp = tuning.get("game_params") or {}
    fns = []
    unavailable = []
    vh = gp.get("venue_hfa") or {}
    ch = gp.get("cold_hfa") or {}
    if vh.get("applied") or ch.get("applied"):
        fns.append(lambda: environment_builder(float(vh.get("scale") or 0.0),
                                               float(ch.get("scale") or 0.0)))
    rh = gp.get("rest_hfa") or {}
    if rh.get("applied"):
        fns.append(lambda: rest_builder(float(rh["scale_per_day"])))
    eh = gp.get("epa_hfa") or {}
    if eh.get("applied"):
        feats = load_epa_features(eh.get("kind") or "total")
        if feats is not None:
            fns.append(lambda: epa_builder(float(eh["scale"]), feats))
        else:
            unavailable.append("epa_hfa")
    eb = gp.get("epa_blend") or {}
    if eb.get("applied"):
        margins = epa_week_margins()
        if margins is not None:
            fns.append(lambda: ("__elo_epa__", float(eb["weight"]), margins))
        else:
            unavailable.append("epa_blend")
    wh = gp.get("wind_hfa") or {}
    if wh.get("applied"):
        wind = load_weather_map()
        if wind is not None:
            fns.append(lambda: weather_wind_builder(float(wh["scale"]), wind))
        else:
            unavailable.append("wind_hfa")
    qo = gp.get("qb_out") or {}
    if qo.get("applied"):
        inputs = qb_out_inputs()
        if inputs is not None:
            fns.append(lambda: qb_out_builder(float(qo["scale"]), *inputs))
        else:
            unavailable.append("qb_out")
    so = gp.get("skill_out") or {}
    if so.get("applied"):
        inputs = skill_out_inputs()
        if inputs is not None:
            fns.append(lambda: skill_out_builder(float(so["scale"]), *inputs))
        else:
            unavailable.append("skill_out")
    return fns, unavailable


# Family builders. Each returns (season_setup, delta_fn_factory):
#   season_setup(season, games, training_residuals) -> ctx
#   delta_fn_factory(ctx) -> (game, idx) -> elo_delta
def environment_builder(venue_scale, cold_scale):
    def setup(season, games, training_residuals):
        return features_from_residuals(training_residuals, venue_scale, cold_scale)

    def factory(ctx):
        vd, cd = ctx
        return lambda g, i: vd.get(g["home"], 0.0) + (cd if cd and is_cold_game(g) else 0.0)
    return setup, factory


def rest_builder(scale_per_day):
    def setup(season, games, training_residuals):
        return rest_diffs(games)

    def factory(diffs):
        return lambda g, i: scale_per_day * diffs[i]
    return setup, factory


def epa_builder(scale, feats):
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        return lambda g, i: scale * feats.diff(g, season)
    return setup, factory


def elo_epa_builder(weight, finals_by_year, margins, hfa, k, revert):
    """Blend-weight family over a parallel EPA-driven rating track.

    Maintains its OWN score-rating replica (identical update rule to
    walk_season, so it tracks the real trajectory exactly) plus an EPA rating
    updated from a logistic pseudo-outcome of the game's per-play EPA margin.
    delta(game) = weight x ((Eh - Ea) - (Rh - Ra)), computed PREGAME; both
    tracks then update with that game's result. On each setup(season) the
    state replays all prior seasons from scratch — leak-free and idempotent.
    """
    state = {"r": {}, "e": {}}

    def _step(g, season):
        h, a = g["home"], g["away"]
        rh = state["r"].setdefault(h, elo_mod.INIT)
        ra = state["r"].setdefault(a, elo_mod.INIT)
        eh = state["e"].setdefault(h, elo_mod.INIT)
        ea = state["e"].setdefault(a, elo_mod.INIT)
        hs, as_ = g["home_score"], g["away_score"]
        # Score-track update (mirror of walk_season's flat-hfa rater).
        exp_h = elo_mod.expected_home(rh, ra, hfa)
        if hs > as_:
            actual_h, margin, dw = 1.0, hs - as_, (rh + hfa) - ra
        elif hs < as_:
            actual_h, margin, dw = 0.0, as_ - hs, ra - (rh + hfa)
        else:
            actual_h, margin, dw = 0.5, 1, 0.0
        mult = elo_mod._mov_multiplier(margin, dw)
        d = k * mult * (actual_h - exp_h)
        state["r"][h] = rh + d
        state["r"][a] = ra - d
        # EPA-track update from the game's per-play margin (skip if missing).
        mh = margins.get((season, int(g.get("week") or 0), h))
        if mh is not None:
            pseudo = 1.0 / (1.0 + math.exp(-mh / EPA_SIGMA))
            exp_e = elo_mod.expected_home(eh, ea, hfa)
            de = k * (pseudo - exp_e)
            state["e"][h] = eh + de
            state["e"][a] = ea - de

    def _revert_all():
        for key in ("r", "e"):
            state[key] = {t: elo_mod.INIT + (v - elo_mod.INIT) * (1 - revert)
                          for t, v in state[key].items()}

    def setup(season, games, training_residuals):
        state["r"] = {}
        state["e"] = {}
        for yr in SEASONS:
            if yr >= season:
                break
            for g in finals_by_year[yr]:
                _step(g, yr)
            _revert_all()
        return season

    def factory(season):
        def fn(g, i):
            h, a = g["home"], g["away"]
            rh = state["r"].get(h, elo_mod.INIT)
            ra = state["r"].get(a, elo_mod.INIT)
            eh = state["e"].get(h, elo_mod.INIT)
            ea = state["e"].get(a, elo_mod.INIT)
            delta = weight * ((eh - ea) - (rh - ra))
            _step(g, season)          # post-pricing: consume this game's result
            return delta
        return fn
    return setup, factory


def weather_wind_builder(scale, wind_map):
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            w = wind_map.get(f"{season}|{g.get('week')}|{g['home']}|{g['away']}")
            return scale if (w is not None and w >= WIND_KPH) else 0.0
        return fn
    return setup, factory


def qb_out_builder(scale, primaries, outs):
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            wk = int(g.get("week") or 0)
            delta = 0.0
            hp = primaries.get((season, g["home"], wk))
            if hp and hp in outs.get((season, wk, g["home"]), ()):  # home QB out
                delta -= scale
            ap = primaries.get((season, g["away"], wk))
            if ap and ap in outs.get((season, wk, g["away"]), ()):  # away QB out
                delta += scale
            return delta
        return fn
    return setup, factory


def _skill_lost(shares_by_season, outs, season, wk, team):
    """Sum of PRIOR-season opportunity shares of a team's Out/Doubtful skill
    players for (season, week) — the lost usage fraction (pregame-honest)."""
    prev = shares_by_season.get(season - 1)
    if not prev:
        return 0.0
    return sum(prev.get(pid, 0.0) for pid in outs.get((season, wk, team), ()))


def skill_out_builder(scale, shares_by_season, outs):
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            wk = int(g.get("week") or 0)
            lost_h = _skill_lost(shares_by_season, outs, season, wk, g["home"])
            lost_a = _skill_lost(shares_by_season, outs, season, wk, g["away"])
            # Home losing usage weakens the home edge (subtract); away losing it
            # strengthens the home edge (add). Magnitude = scale * lost share.
            return scale * (lost_a - lost_h)
        return fn
    return setup, factory


def evaluate(builders, hfa, revert, k, finals_by_year, calibration=None,
             probs_out=None, losses_out=None):
    """Walk-forward mean log-loss with the given family builders combined
    (their per-game deltas add). Leak-free per the module docstring.

    losses_out: optional list that receives (season, per-game log-loss) for every
    scored game in walk order. Two evaluate() calls score the identical games in
    the identical order, so their losses_out lists pair element-for-element —
    that pairing is what the significance test consumes.
    """
    total_ll = 0.0
    total_n = 0
    training_residuals = []
    priors = {}
    for yr in SEASONS:
        games = finals_by_year[yr]
        if yr in EVAL_SEASONS:
            fns = []
            for setup, factory in builders:
                fns.append(factory(setup(yr, games, training_residuals)))
            delta_fn = (lambda g, i: sum(fn(g, i) for fn in fns)) if fns else None
            want_probs = probs_out is not None or losses_out is not None
            season_probs = [] if want_probs else None
            ll, n, res = walk_season(games, priors, hfa, k, delta_fn,
                                     collect_residuals=True, calibration=calibration,
                                     probs=season_probs)
            if probs_out is not None:
                for g, p, actual in season_probs:
                    probs_out.append((yr, g, p, actual))
            if losses_out is not None:
                for _g, p, actual in season_probs:
                    losses_out.append(
                        (yr, -(actual * math.log(p) + (1.0 - actual) * math.log(1.0 - p))))
            total_ll += ll
            total_n += n
        else:
            _, _, res = walk_season(games, priors, hfa, k, collect_residuals=True)
        training_residuals.extend(res)
        rated = elo_mod.rate_season(games, hfa=hfa, k=k, initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    return total_ll / total_n, total_n


# --------------------------------------------------------------------------- #
# main gate run                                                               #
# --------------------------------------------------------------------------- #

def run(auto_adopt=False):
    hfa, revert, k, tuning = game_params()
    finals_by_year = {yr: load_finals(yr) for yr in SEASONS}
    incumbent_builders = []
    inc_fns, inc_unavailable = _incumbent_family_fns(tuning)
    if inc_unavailable:
        print("NOTICE: adopted famil"
              f"{'ies' if len(inc_unavailable) != 1 else 'y'} "
              f"{', '.join(inc_unavailable)} could not be rebuilt for seasons "
              f"{SEASONS[0]}-{SEASONS[-1]} (inputs unavailable) — the incumbent "
              "in this run is WEAKER than the one production ships")
    for mk in inc_fns:
        built = mk()
        if isinstance(built, tuple) and built and built[0] == "__elo_epa__":
            _, w, margins = built
            built = elo_epa_builder(w, finals_by_year, margins, hfa, k, revert)
        incumbent_builders.append(built)

    # Incumbent walk also produces the calibration record for the MODEL tab.
    cal = [[0, 0.0, 0.0] for _ in range(CAL_BINS)]
    inc_probs = []
    inc_losses = []
    inc_loss, inc_n = evaluate(incumbent_builders, hfa, revert, k,
                               finals_by_year, calibration=cal,
                               probs_out=inc_probs, losses_out=inc_losses)
    calibration = {
        "seasons": f"{EVAL_SEASONS[0]}-{EVAL_SEASONS[-1]}",
        "n": inc_n,
        "bins": [{"p_lo": round(i / CAL_BINS, 2), "p_hi": round((i + 1) / CAL_BINS, 2),
                  "n": c[0],
                  "expected": round(c[1] / c[0], 4) if c[0] else None,
                  "actual": round(c[2] / c[0], 4) if c[0] else None}
                 for i, c in enumerate(cal)],
    }
    print(f"incumbent log-loss {inc_loss:.5f} over {inc_n} games "
          f"({len(incumbent_builders)} adopted famil{'ies' if len(incumbent_builders) != 1 else 'y'})")

    families = []

    def try_candidate(family, label, params, builder):
        cand_losses = []
        ll, n = evaluate(incumbent_builders + [builder], hfa, revert, k,
                         finals_by_year, losses_out=cand_losses)
        trial = dict(params)
        trial.update({"log_loss": round(ll, 5), "n": n})
        stats = None
        if len(cand_losses) == len(inc_losses):
            by_fold = {}
            for (yr, inc_l), (_yr2, cand_l) in zip(inc_losses, cand_losses):
                by_fold.setdefault(yr, []).append(inc_l - cand_l)
            stats = paired_fold_stats(by_fold)
        if stats:
            se = stats["se"]
            trial["improvement"] = round(stats["mean"], 6)
            trial["se"] = round(se, 6) if se is not None else None
            trial["t_stat"] = (None if stats["t"] == math.inf
                               else round(stats["t"], 3))
            trial["folds_positive"] = stats["folds_positive"]
            trial["folds"] = stats["folds"]
            if se:
                half = student_t_ppf(0.5 + CI_LEVEL / 2.0, stats["df"]) * se
                trial["ci95"] = [round(stats["mean"] - half, 6),
                                 round(stats["mean"] + half, 6)]
            t_txt = "n/a" if trial["t_stat"] is None else f"{trial['t_stat']:+.2f}"
            print(f"  {family:12s} {label:24s} -> log-loss {ll:.5f}  "
                  f"t={t_txt} ({stats['folds_positive']}/{stats['folds']} folds +)")
        else:
            print(f"  {family:12s} {label:24s} -> log-loss {ll:.5f}")
        return trial

    # environment (venue x cold grid, zero-combo excluded: that IS the incumbent)
    env_trials = []
    for vs in VENUE_SCALES:
        for cs in COLD_SCALES:
            if vs == 0 and cs == 0:
                continue
            env_trials.append(try_candidate(
                "environment", f"venue={vs:.0f} cold={cs:.0f}",
                {"venue_scale": vs, "cold_scale": cs},
                environment_builder(vs, cs)))
    families.append({"family": "environment", "trials": env_trials})

    # rest differential
    rest_trials = [try_candidate("rest", f"scale={s}", {"scale_per_day": s},
                                 rest_builder(s))
                   for s in REST_SCALES if s]
    families.append({"family": "rest", "trials": rest_trials})

    # EPA families (skip loudly when the runner hasn't built the data yet)
    for kind, fam in (("total", "epa_total"), ("pass", "epa_pass")):
        feats = load_epa_features(kind)
        if feats is None:
            print(f"  {fam:12s} SKIPPED: data/epa_history.json absent/incomplete "
                  "(runner-built)")
            families.append({"family": fam, "skipped": True,
                             "reason": "epa_history.json absent or incomplete — "
                                       "built by the weekly backtest workflow"})
            continue
        fam_trials = [try_candidate(fam, f"scale={s:.0f}", {"scale": s},
                                    epa_builder(s, feats))
                      for s in EPA_SCALES if s]
        families.append({"family": fam, "trials": fam_trials})

    # elo_epa (blend over an EPA-driven rating track — the replace-not-add test)
    margins = epa_week_margins()
    if margins is None:
        print("  elo_epa      SKIPPED: epa_history.json absent/incomplete")
        families.append({"family": "elo_epa", "skipped": True,
                         "reason": "epa_history.json absent or incomplete"})
    else:
        fam_trials = [try_candidate("elo_epa", f"w={w}", {"weight": w},
                                    elo_epa_builder(w, finals_by_year, margins,
                                                    hfa, k, revert))
                      for w in EPA_BLEND_WEIGHTS]
        families.append({"family": "elo_epa", "trials": fam_trials})

    # weather_wind (open-roof windy games; sign grid — direction unknown a priori)
    wind_map = load_weather_map()
    if wind_map is None:
        print("  weather_wind SKIPPED: weather_history.json absent or does not "
              f"span {SEASONS[0]}-{SEASONS[-1]}")
        families.append({"family": "weather_wind", "skipped": True,
                         "reason": "weather_history.json absent or incomplete — "
                                   f"its games must span {SEASONS[0]}-{SEASONS[-1]} "
                                   "or the uncovered folds score exact ties and "
                                   "dilute the measured improvement",
                         "seasons_required": [SEASONS[0], SEASONS[-1]]})
    else:
        fam_trials = [try_candidate("weather_wind", f"scale={sc:+.0f}", {"scale": sc},
                                    weather_wind_builder(sc, wind_map))
                      for sc in WIND_SCALES]
        families.append({"family": "weather_wind", "trials": fam_trials})

    # qb_out (primary passer listed Out/Doubtful — needs runner passer+injury data)
    qb_inputs = qb_out_inputs()
    if qb_inputs is None:
        print("  qb_out       SKIPPED: needs passer aggregates + injury_history "
              "(runner-built)")
        families.append({"family": "qb_out", "skipped": True,
                         "reason": "passer aggregates + injury_history pending "
                                   "(built by the weekly backtest workflow)"})
    else:
        fam_trials = [try_candidate("qb_out", f"scale={sc:.0f}", {"scale": sc},
                                    qb_out_builder(sc, *qb_inputs))
                      for sc in QB_OUT_SCALES]
        families.append({"family": "qb_out", "trials": fam_trials})

    # skill_out (RB/WR/TE Out/Doubtful, weighted by prior-season usage share —
    # needs player_usage_history + injury_history, both runner-built)
    skill_inputs = skill_out_inputs()
    if skill_inputs is None:
        print("  skill_out    SKIPPED: needs player_usage_history + injury_history "
              f"spanning {SEASONS[0]}-{SEASONS[-1]} (runner-built)")
        families.append({"family": "skill_out", "skipped": True,
                         "reason": "usage-share history + injury_history pending or "
                                   f"not spanning {SEASONS[0]}-{SEASONS[-1]} — "
                                   "uncovered folds would score exact ties and "
                                   "dilute the measured improvement",
                         "seasons_required": [SEASONS[0], SEASONS[-1]]})
    else:
        fam_trials = [try_candidate("skill_out", f"scale={sc:.0f}", {"scale": sc},
                                    skill_out_builder(sc, *skill_inputs))
                      for sc in SKILL_OUT_SCALES]
        families.append({"family": "skill_out", "trials": fam_trials})

    # Verdict: best scale per family; adopt at most the single best family.
    best_overall = None
    for fam in families:
        if fam.get("skipped"):
            continue
        best = min(fam["trials"], key=lambda t: t["log_loss"])
        fam["best"] = best
        fam["improvement"] = round(inc_loss - best["log_loss"], 5)
        if best_overall is None or best["log_loss"] < best_overall[1]["log_loss"]:
            best_overall = (fam["family"], best)
    # Families whose prediction-time application is wired in build_predictions.
    # A family NOT in this set can clear the margin but records would_adopt —
    # the gate must never claim a signal is applied when the pipeline cannot
    # actually apply it.
    APPLIABLE = {"environment", "rest", "epa_total", "epa_pass", "elo_epa",
                 "qb_out", "weather_wind", "skill_out"}

    # SIGNIFICANCE GATE. The threshold the best candidate must clear is earned
    # from its own uncertainty, not fixed: t_crit x the fold-clustered standard
    # error, floored at MIN_EFFECT so the gate can only ever be stricter than
    # the old constant margin. t_crit is Bonferroni-corrected for every trial
    # evaluated this run, because the candidate is the argmin over all of them.
    n_trials = sum(len(f.get("trials") or []) for f in families
                   if not f.get("skipped"))
    best_trial = best_overall[1] if best_overall else None
    df = (best_trial or {}).get("folds", 0) - 1
    se = (best_trial or {}).get("se")
    info = adoption_threshold(se, df, n_trials)
    threshold = info["threshold"]        # None = too few folds to measure it
    # Compare the numbers exactly as recorded (all rounded to 5dp) so the
    # archived entry is a faithful, re-checkable statement of the decision.
    imp = (round(inc_loss, 5) - best_trial["log_loss"]) if best_trial else 0.0
    adopt = (best_trial is not None
             and should_adopt(imp, se, df, n_trials))
    significance = {
        "method": "paired per-game log-loss, CR1 cluster-robust over "
                  "walk-forward folds, one-sided Student-t",
        "alpha": SIG_ALPHA,
        "trials": n_trials,
        "alpha_bonferroni": (round(info["alpha_bonferroni"], 8)
                             if info["alpha_bonferroni"] is not None else None),
        "df": df if df >= 1 else 0,
        "t_crit": round(info["t_crit"], 4) if info["t_crit"] is not None else None,
        "effect_floor": MIN_EFFECT,
        "threshold": threshold,
        "best_t_stat": (best_trial or {}).get("t_stat"),
        "best_ci95": (best_trial or {}).get("ci95"),
        "significant": bool(adopt),
    }
    # DEGRADED-INCUMBENT BLOCK. If any family production ships could not be
    # rebuilt for this season set, the bar every candidate just cleared is
    # LOWER than the model in production (it happens for real under --corpus:
    # qb_out needs passer + injury history that does not reach back to 1999, so
    # the incumbent walk runs with zero adopted families while production ships
    # qb_out at scale 75). Beating a weaker-than-production incumbent is not
    # evidence for adding a family on top of production, so adoption is refused
    # outright — never-regress has to be absolute or it is not a rule.
    if adopt and inc_unavailable:
        adopt = False
        degraded = best_overall
    else:
        degraded = None
    if adopt and best_overall[0] not in APPLIABLE:
        adopt = False
        pending = best_overall
    else:
        pending = None

    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "generated_utc": now,
        "kind": "signal_promotion",
        "format": 2,
        "source": (f"scripts/promote_signals.py walk-forward {EVAL_SEASONS[0]}-"
                   f"{EVAL_SEASONS[-1]} over {os.path.basename(FIXTURE_DIR)} "
                   "(environment + rest + epa families)"),
        "objective": "log_loss",
        # `margin` is the threshold ACTUALLY APPLIED this run: max(effect floor,
        # t_crit x the best candidate's fold-clustered standard error). It is no
        # longer a constant — see `significance` for how it was earned.
        "margin": threshold if threshold is not None else MIN_EFFECT,
        "effect_floor": MIN_EFFECT,
        "significance": significance,
        "incumbent_loss": round(inc_loss, 5),
        "incumbent_families": sorted(
            name for name, blk in (tuning.get("game_params") or {}).items()
            if isinstance(blk, dict) and blk.get("applied")),
        "incumbent_unavailable": inc_unavailable,
        "families": families,
        "adopted": bool(adopt),
        "adopted_family": ({"family": best_overall[0], **best_overall[1]}
                           if adopt else None),
        "auto_adopt": bool(auto_adopt),
        "reason": ("improvement is significant at the Bonferroni-corrected "
                   "one-sided level and clears the effect floor" if adopt else
                   "incumbent retained: no family's improvement was large "
                   "relative to its own fold-clustered uncertainty"),
        "calibration": calibration,
    }
    baseline = load_baseline_map()
    if baseline:
        ours_ll = 0.0
        mkt_ll = 0.0
        bn = 0
        for yr, g, p, actual in inc_probs:
            bp = baseline.get(f"{yr}|{g.get('week')}|{g['home']}|{g['away']}")
            if bp is None:
                continue
            bp = min(max(float(bp), _EPS), 1.0 - _EPS)
            ours_ll += -(actual * math.log(p) + (1 - actual) * math.log(1 - p))
            mkt_ll += -(actual * math.log(bp) + (1 - actual) * math.log(1 - bp))
            bn += 1
        if bn:
            entry["market_baseline"] = {
                "policy": "measurement only - never an input (owner rule)",
                "games": bn,
                "our_log_loss": round(ours_ll / bn, 5),
                "market_log_loss": round(mkt_ll / bn, 5),
                "gap": round((ours_ll - mkt_ll) / bn, 5),
            }
            print(f"market baseline: ours {ours_ll/bn:.5f} vs close {mkt_ll/bn:.5f} "
                  f"over {bn} games (gap {(ours_ll-mkt_ll)/bn:+.5f})")
    tuning.setdefault("history", []).insert(0, entry)

    if degraded is not None:
        entry["reason"] = (
            f"{degraded[0]} cleared the significance threshold, but adopted "
            f"famil{'ies' if len(inc_unavailable) != 1 else 'y'} "
            f"{', '.join(inc_unavailable)} could not be rebuilt for "
            f"{SEASONS[0]}-{SEASONS[-1]}, so the incumbent it beat is WEAKER "
            "than the one production ships - recorded, not adopted")
        entry["would_adopt"] = {"family": degraded[0], **degraded[1]}
        entry["adopted"] = False
        entry["adopted_family"] = None
        entry["adoption_blocked"] = {
            "rule": "degraded_incumbent",
            "unavailable": list(inc_unavailable),
            "detail": "adoption requires the incumbent walk to carry every "
                      "family production ships; beating a weaker incumbent is "
                      "not evidence for adding a family on top of production",
        }
        print(f"BLOCKED: {degraded[0]} cleared the threshold "
              f"({inc_loss:.5f} -> {degraded[1]['log_loss']:.5f}) but the "
              f"incumbent is missing {', '.join(inc_unavailable)} — not adopted")
    if pending is not None:
        entry["reason"] = (f"{pending[0]} cleared the margin but its application "
                           "path is not wired yet - recorded, not adopted")
        entry["would_adopt"] = {"family": pending[0], **pending[1]}
        entry["adopted"] = False
        entry["adopted_family"] = None
        print(f"PENDING: {pending[0]} cleared the margin but has no application "
              f"path yet ({inc_loss:.5f} -> {pending[1]['log_loss']:.5f})")
    if adopt and auto_adopt:
        _write_adoption(tuning, best_overall, hfa, revert, k, finals_by_year, now)
    elif adopt:
        print(f"DRY RUN: {best_overall[0]} would be adopted "
              f"({inc_loss:.5f} -> {best_overall[1]['log_loss']:.5f}) — "
              "run with --auto-adopt to write game_params")
        entry["reason"] = "cleared margin but dry run — game_params unchanged"
        entry["adopted"] = False
        entry["would_adopt"] = {"family": best_overall[0], **best_overall[1]}
        entry["adopted_family"] = None
    elif degraded is not None:
        pass                     # already reported above; RETAINED text would lie
    else:
        if best_overall:
            bt = best_overall[1]
            ci = bt.get("ci95")
            ci_txt = (f" 95% CI [{ci[0]:+.5f}, {ci[1]:+.5f}]" if ci else "")
            best_txt = (f"best {best_overall[0]} {bt['log_loss']:.5f} "
                        f"(+{imp:.5f}, t={bt.get('t_stat')}{ci_txt})")
        else:
            best_txt = "no runnable candidates"
        print(f"RETAINED incumbent ({inc_loss:.5f}); {best_txt} — needed "
              f"> {threshold} (t_crit {significance['t_crit']} x se over "
              f"{significance['df'] + 1} folds, Bonferroni over {n_trials} trials)")

    with open(TUNING_PATH, "w", encoding="utf-8") as fh:
        json.dump(tuning, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")
    return entry


def _write_adoption(tuning, best_overall, hfa, revert, k, finals_by_year, now):
    """Write the adopted family's production params into game_params. Production
    features use ALL resolved seasons (training-only fitting is for honest EVAL;
    the shipped prior uses every season, standard walk-forward practice)."""
    family, best = best_overall
    gp = tuning.setdefault("game_params", {})
    if family == "environment":
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
        gp["venue_hfa"] = {"applied": bool(best["venue_scale"]),
                           "scale": best["venue_scale"], "shrink_n": SHRINK_N,
                           "adopted_utc": now,
                           "deltas": {t: round(v, 2) for t, v in sorted(vd.items())}}
        gp["cold_hfa"] = {"applied": bool(best["cold_scale"]),
                          "scale": best["cold_scale"],
                          "delta_elo": round(cd, 2), "adopted_utc": now}
    elif family == "rest":
        gp["rest_hfa"] = {"applied": True, "scale_per_day": best["scale_per_day"],
                          "clamp_days": REST_CLAMP, "baseline_days": REST_BASELINE,
                          "adopted_utc": now}
    elif family in ("epa_total", "epa_pass"):
        gp["epa_hfa"] = {"applied": True,
                         "kind": "pass" if family == "epa_pass" else "total",
                         "scale": best["scale"], "n0_plays": EPA_N0,
                         "adopted_utc": now}
    elif family == "elo_epa":
        gp["epa_blend"] = {"applied": True, "weight": best["weight"],
                           "sigma": EPA_SIGMA, "adopted_utc": now}
    elif family == "weather_wind":
        gp["wind_hfa"] = {"applied": True, "scale": best["scale"],
                          "threshold_kph": WIND_KPH, "adopted_utc": now}
    elif family == "qb_out":
        gp["qb_out"] = {"applied": True, "scale": best["scale"],
                        "adopted_utc": now}
    elif family == "skill_out":
        gp["skill_out"] = {"applied": True, "scale": best["scale"],
                           "adopted_utc": now}
    print(f"ADOPTED {family} {best} into game_params")


def selftest():
    """Feature math on synthetic data — asserts, never touches data/."""
    # rest_diffs: B rests 14 days (bye) into game 3 while A played 7 days ago.
    games = [
        {"home": "A", "away": "B", "kickoff_utc": "2025-09-07T17:00:00Z"},
        {"home": "A", "away": "C", "kickoff_utc": "2025-09-14T17:00:00Z"},
        {"home": "B", "away": "A", "kickoff_utc": "2025-09-21T17:00:00Z"},
        {"home": "C", "away": "A", "kickoff_utc": "2025-09-24T17:00:00Z"},
    ]
    d = rest_diffs(games)
    assert d[0] == 0.0, d          # opener: both at baseline
    assert d[1] == 0.0, d          # A rested 7, C opener-baseline 7
    assert d[2] == 7.0, d          # home B off a bye (14) vs A's 7 -> +7
    assert d[3] == 7.0, d          # home C rested 10 vs A's short-week 3 -> +7 (clamped)

    # EpaFeatures: week-3 margin uses only weeks 1-2 blended with prior season.
    doc = {
        "2024": {"KC": {"18": {"off_plays": 500, "off_epa": 50.0, "off_pass_plays": 300,
                               "off_pass_epa": 45.0, "off_rush_plays": 200, "off_rush_epa": 5.0,
                               "def_plays": 500, "def_epa": -25.0, "def_pass_plays": 300,
                               "def_pass_epa": -20.0, "def_rush_plays": 200, "def_rush_epa": -5.0}}},
        "2025": {"KC": {"1": {"off_plays": 60, "off_epa": 12.0, "off_pass_plays": 40,
                              "off_pass_epa": 10.0, "off_rush_plays": 20, "off_rush_epa": 2.0,
                              "def_plays": 60, "def_epa": 0.0, "def_pass_plays": 40,
                              "def_pass_epa": 0.0, "def_rush_plays": 20, "def_rush_epa": 0.0},
                        "3": {"off_plays": 60, "off_epa": -12.0, "off_pass_plays": 40,
                              "off_pass_epa": -10.0, "off_rush_plays": 20, "off_rush_epa": -2.0,
                              "def_plays": 60, "def_epa": 0.0, "def_pass_plays": 40,
                              "def_pass_epa": 0.0, "def_rush_plays": 20, "def_rush_epa": 0.0}}},
    }
    feats = EpaFeatures(doc, "total")
    # Before week 3: cur = week 1 only (120 plays, margin (12/60 - 0/60)=0.2);
    # prev 2024 full: off 50/500=0.1, def -25/500=-0.05 -> margin 0.15.
    # w = 120/720; margin = w*0.2 + (1-w)*0.15 = 0.15833...
    m = feats.margin(2025, "KC", 3)
    assert abs(m - (120 / 720 * 0.2 + 600 / 720 * 0.15)) < 1e-9, m
    # Leak check: week-3's own plays are EXCLUDED (else margin would drop).
    m_leaky_would_be = feats.margin(2025, "KC", 4)
    assert m_leaky_would_be < m, (m_leaky_would_be, m)

    # skill_out: home loses a 0.30-share WR (prior season), away loses nothing.
    # delta = scale * (lost_away - lost_home) = 100 * (0 - 0.30) = -30 Elo.
    shares = {2024: {"WR9": 0.30, "RB9": 0.20}}
    outs = {(2025, 5, "KC"): {"WR9"}, (2025, 5, "BUF"): set()}
    _, factory = skill_out_builder(100.0, shares, outs)
    fn = factory(2025)
    d = fn({"home": "KC", "away": "BUF", "week": 5}, 0)
    assert abs(d - (-30.0)) < 1e-9, d
    # No prior-season shares (rookie season) -> no delta, never a crash.
    _, f2 = skill_out_builder(100.0, {}, outs)
    assert f2(2025)({"home": "KC", "away": "BUF", "week": 5}, 0) == 0.0

    _stats_selftest()
    print("selftest OK: rest clamp + EPA leak-free blending + skill_out "
          "share-weighting exact + significance statistics vs published values")


def _stats_selftest():
    """The adoption gate's statistics, checked against CLOSED FORMS and
    published t tables. Home-rolled statistics that are never verified are how
    a 'significance test' becomes a second arbitrary constant."""
    # --- betainc against exact closed forms -------------------------------- #
    # I_x(1, 1) = x ; I_x(a, 1) = x^a ; I_x(1, b) = 1 - (1-x)^b
    for x in (0.05, 0.25, 0.5, 0.75, 0.99):
        assert abs(betainc(1.0, 1.0, x) - x) < 1e-12, x
        assert abs(betainc(3.0, 1.0, x) - x ** 3) < 1e-12, x
        assert abs(betainc(1.0, 4.0, x) - (1 - (1 - x) ** 4)) < 1e-12, x
    assert betainc(2.0, 5.0, 0.0) == 0.0
    assert betainc(2.0, 5.0, 1.0) == 1.0
    assert abs(betainc(2.5, 2.5, 0.5) - 0.5) < 1e-12      # symmetry at the median

    # --- Student-t CDF/quantile against published critical values ---------- #
    assert abs(student_t_sf(0.0, 7) - 0.5) < 1e-12
    # two-sided symmetry
    assert abs(student_t_sf(1.3, 9) + student_t_sf(-1.3, 9) - 1.0) < 1e-12
    # t(df=1) is Cauchy: P(T > 1) = 0.25 exactly
    assert abs(student_t_sf(1.0, 1) - 0.25) < 1e-12
    table = {                     # (p, df): published t quantile
        (0.95, 1): 6.313752, (0.975, 1): 12.706205,
        (0.95, 2): 2.919986, (0.975, 2): 4.302653,
        (0.95, 3): 2.353363, (0.975, 3): 3.182446, (0.995, 3): 5.840909,
        (0.95, 10): 1.812461, (0.975, 10): 2.228139, (0.995, 10): 3.169273,
        (0.95, 20): 1.724718, (0.975, 20): 2.085963, (0.995, 20): 2.845340,
        (0.975, 30): 2.042272, (0.975, 26): 2.055529, (0.95, 26): 1.705618,
    }
    for (p, df), want in table.items():
        got = student_t_ppf(p, df)
        assert abs(got - want) < 5e-6, (p, df, got, want)
    # df -> infinity collapses onto the normal quantile
    assert abs(student_t_ppf(0.975, 2_000_000) - 1.959964) < 1e-4
    # round trip
    for df in (3, 12, 40):
        for p in (0.6, 0.9, 0.999):
            assert abs(student_t_sf(student_t_ppf(p, df), df) - (1 - p)) < 1e-9

    # --- cluster-robust paired statistics ---------------------------------- #
    # One fold, constant delta: no between-game spread -> zero se, and the
    # single-cluster case must refuse to claim evidence.
    one = paired_fold_stats({2024: [0.01] * 10})
    assert one["folds"] == 1 and one["se"] is None and one["t"] == 0.0

    # Hand-computable case: two folds, delta 0 in one and 0.2 in the other,
    # five games each. mean = 0.1. Fold deviation sums: 5*(0-0.1) = -0.5 and
    # 5*(0.2-0.1) = +0.5 -> ss = 0.5. var = (2/1) * 0.5 / 100 = 0.01,
    # se = 0.1, t = 1.0 — i.e. an improvement carried entirely by one fold is
    # exactly one standard error, which is the whole point of clustering.
    two = paired_fold_stats({2023: [0.0] * 5, 2024: [0.2] * 5})
    assert two["n"] == 10 and two["folds"] == 2 and two["df"] == 1
    assert abs(two["mean"] - 0.1) < 1e-12
    assert abs(two["se"] - 0.1) < 1e-12, two
    assert abs(two["t"] - 1.0) < 1e-12, two
    assert two["folds_positive"] == 1

    # The same total improvement spread evenly over the folds is far more
    # significant than the same amount concentrated in one fold.
    even = paired_fold_stats({2023: [0.1] * 5, 2024: [0.1] * 5})
    assert abs(even["mean"] - 0.1) < 1e-12
    assert even["se"] == 0.0 and even["t"] == math.inf
    assert even["folds_positive"] == 2

    # NEVER-REGRESS direction: a candidate that is worse produces a negative t
    # and can never clear a positive threshold.
    worse = paired_fold_stats({2023: [-0.05] * 5, 2024: [-0.01] * 5})
    assert worse["mean"] < 0 and worse["t"] < 0 and worse["folds_positive"] == 0
    assert paired_fold_stats({}) is None

    # --- the adoption rule itself ------------------------------------------ #
    # 44 trials, 4 folds (df 3): t_crit = t(1 - 0.05/44, 3) = 9.7784...
    info = adoption_threshold(0.001, 3, 44)
    assert abs(info["t_crit"] - 9.7784) < 1e-3, info
    assert info["threshold"] == round(9.7784134 * 0.001, 5), info
    # The floor still binds when the standard error is tiny.
    assert adoption_threshold(1e-9, 3, 44)["threshold"] == MIN_EFFECT
    # Fewer than two folds -> no uncertainty estimate -> never adopt.
    assert adoption_threshold(None, 0, 44)["threshold"] is None
    assert should_adopt(999.0, None, 0, 44) is False

    # NEVER-REGRESS: worse, tied and sub-floor candidates are never adopted,
    # and neither is a large-but-noisy one.
    assert should_adopt(-0.01, 0.0005, 3, 44) is False
    assert should_adopt(0.0, 0.0005, 3, 44) is False
    assert should_adopt(MIN_EFFECT, 1e-9, 3, 44) is False       # strict >
    assert should_adopt(0.0014, 1e-9, 3, 44) is False           # under the floor
    assert should_adopt(0.02, 0.01, 3, 44) is False             # t = 2.0, not enough
    assert should_adopt(0.11, 0.01, 3, 44) is True              # t = 11 > 9.78
    # More folds buy power: the same effect+se that fails on 4 folds passes on 26.
    assert should_adopt(0.04, 0.01, 25, 44) is True
    # More trials cost power: the same numbers on a single trial pass earlier.
    assert adoption_threshold(0.01, 3, 1)["t_crit"] < adoption_threshold(0.01, 3, 44)["t_crit"]
    # A negative floor would admit regressions and is rejected outright.
    try:
        adoption_threshold(0.001, 3, 44, floor=-0.001)
        raise AssertionError("negative floor must raise")
    except ValueError:
        pass

    # The measured qb_out adoption (2026-07-18): improvement 0.0024 against a
    # fold-clustered se of 0.00246 is t = 0.98 — a coin flip, never adoptable.
    assert should_adopt(0.0024, 0.002462, 3, 44) is False


def wind_current(season):
    """{season|week|home|away: wind_kph} for PREDICTION-TIME weather_wind
    application, from the daily-refreshed weather_forecast.json (upcoming
    open-roof home games). None until the forecast builder has run; empty in
    the offseason (correctly dormant — no fabricated wind for future games)."""
    games = _load_json(FORECAST_PATH, "games")
    if games is None:
        return None
    out = {}
    for key, w in games.items():
        wk = w.get("wind_kph") if isinstance(w, dict) else None
        if wk is not None and str(key).startswith(f"{season}|"):
            out[key] = wk
    return out


def qb_out_current(season):
    """(primary_by_team, out_ids_by_team_week) for PREDICTION-TIME application.

    Primary passer per team for the season: cumulative dropback leader from
    epa_history's current season if present, else last season's leader (the
    honest preseason expectation). Outs come from injury_history's current
    season (refreshed by the daily cron in-season; empty preseason = no
    deltas, correctly dormant)."""
    seasons = _load_json(EPA_PATH, "seasons")
    injuries = _load_json(INJURY_PATH, "seasons") or {}
    if not seasons:
        return None
    primary = {}
    for team in (seasons.get(str(season - 1)) or {}):
        cum = {}
        for yr in (season, season - 1):
            tw = (seasons.get(str(yr)) or {}).get(team) or {}
            for c in tw.values():
                for pid, rec in (c.get("passers") or {}).items():
                    cum[pid] = cum.get(pid, 0) + rec["db"]
            if cum:
                break                      # current season data wins outright
        if cum:
            primary[team] = max(cum.items(), key=lambda kv: kv[1])[0]
    outs = {}
    for team, weeks in (injuries.get(str(season)) or {}).items():
        for wk, rows in weeks.items():
            outs[(team, int(wk))] = {
                r["id"] for r in rows
                if r.get("position") == "QB" and r.get("status") in ("Out", "Doubtful")
                and r.get("id")}
    return primary, outs


def skill_out_current(season):
    """(share_by_pid, outs_by_team_week) for PREDICTION-TIME skill_out.

    Shares are the PRIOR season's within-team opportunity shares (pregame
    expectation, from player_usage_history). Outs come from injury_history's
    current season (RB/WR/TE Out/Doubtful, refreshed daily). None until the
    runner has built the usage history; empty preseason -> dormant."""
    usage = _load_json(USAGE_HISTORY_PATH, "seasons")
    injuries = _load_json(INJURY_PATH, "seasons") or {}
    if not usage:
        return None
    prev = usage.get(str(season - 1)) or usage.get(str(season)) or {}
    share_by_pid = {pid: rec["share"] for pid, rec in prev.items()}
    outs = {}
    for team, weeks in (injuries.get(str(season)) or {}).items():
        for wk, rows in weeks.items():
            s = {r["id"] for r in rows
                 if r.get("position") in SKILL_POSITIONS
                 and r.get("status") in ("Out", "Doubtful") and r.get("id")}
            if s:
                outs[(team, int(wk))] = s
    return share_by_pid, outs


def epa_blend_deltas(weight):
    """PRODUCTION application for an adopted epa_blend: replay ALL resolved
    seasons through both rating tracks (identical math to the walk-forward
    builder) and return {team: weight x (E - R)} — the additive Elo delta per
    team for pricing upcoming games. None if EPA data is unavailable."""
    margins = epa_week_margins()
    if margins is None:
        return None
    hfa, revert, k, _ = game_params()
    finals_by_year = {yr: load_finals(yr) for yr in SEASONS}
    st = {"r": {}, "e": {}}
    for yr in SEASONS:
        for g in finals_by_year[yr]:
            h, a = g["home"], g["away"]
            rh = st["r"].setdefault(h, elo_mod.INIT)
            ra = st["r"].setdefault(a, elo_mod.INIT)
            eh = st["e"].setdefault(h, elo_mod.INIT)
            ea = st["e"].setdefault(a, elo_mod.INIT)
            hs, as_ = g["home_score"], g["away_score"]
            exp_h = elo_mod.expected_home(rh, ra, hfa)
            if hs > as_:
                actual_h, margin, dw = 1.0, hs - as_, (rh + hfa) - ra
            elif hs < as_:
                actual_h, margin, dw = 0.0, as_ - hs, ra - (rh + hfa)
            else:
                actual_h, margin, dw = 0.5, 1, 0.0
            mult = elo_mod._mov_multiplier(margin, dw)
            d = k * mult * (actual_h - exp_h)
            st["r"][h] = rh + d
            st["r"][a] = ra - d
            mh = margins.get((yr, int(g.get("week") or 0), h))
            if mh is not None:
                pseudo = 1.0 / (1.0 + math.exp(-mh / EPA_SIGMA))
                de = k * (pseudo - elo_mod.expected_home(eh, ea, hfa))
                st["e"][h] = eh + de
                st["e"][a] = ea - de
        for key in ("r", "e"):
            st[key] = {t: elo_mod.INIT + (v - elo_mod.INIT) * (1 - revert)
                       for t, v in st[key].items()}
    return {t: round(weight * (st["e"].get(t, elo_mod.INIT) - st["r"][t]), 2)
            for t in st["r"]}


def main():
    if "--selftest" in sys.argv:
        selftest()
        return None
    if "--corpus" in sys.argv:
        years = use_corpus()
        print(f"corpus mode: {len(years)} seasons {years[0]}-{years[-1]} from "
              f"{os.path.relpath(CORPUS_DIR, _ROOT)}")
    return run(auto_adopt="--auto-adopt" in sys.argv)


if __name__ == "__main__":
    main()
