"""PARLAY-LEG walk-forward backtest — the never-regress gate for parlay pricing.

WHY THIS EXISTS
---------------
Until R51 the parlay builder priced two of its three leg families with numbers
nothing had ever measured:

  * SPREAD legs used "our margin model at the book's handicap" — the Elo win
    probability inverted through the normal CDF (margin = PHI^-1(p) x 13.5) and
    re-read at the book number. Sound in shape, never scored.
  * PROP legs used a documented SEED: 0.5 shaded by the player's team win
    probability, clamped to [0.35, 0.65]. A placeholder, honestly labelled, never
    scored either.

This script scores both against resolved 2023-2025 nflverse actuals (committed
fixtures, no network), walk-forward, and writes data/parlay_backtest.json — the
file scripts/models/parlay_builder.py reads its prop calibration and same-game
correlations from. What it found, and what the builder now does about it:

  T1 MONEYLINE — recorded only (no candidate). The incumbent Elo win probability
     is scored (log-loss, Brier) next to the de-vigged closing moneyline. The
     market number is a MEASUREMENT YARDSTICK ONLY: it never feeds a projection.
  T2 SPREAD — the shipped cover rule scores WORSE than a flat 0.5 on log-loss and
     its picks hit 44-54% in every conviction bin (break-even 52.4%). Verdict
     "no_edge": the builder now prices every spread leg at exactly 0.5 and says so
     on the leg.
  T3 PROPS — a calibrated per-position logistic on the player's projected yards
     against the line, p = sigmoid(a + b*z + c*(p_team - 0.5)) with
     z = (mu * dvp - line) / sd_pos, beats the seed on every walk-forward fold.
     Verdict "adopted" under never-regress; the coefficients shipped are re-fit
     on all fixture seasons and the builder reads them from the output file.
  T4 CORRELATIONS — copula-lite rho for the same-game pairs the builder combines,
     measured, replacing the transparent priors it used to carry.

OWNER POLICY (permanent): market / Vegas / Sleeper numbers are never projection
inputs. Here the book's spread is the HANDICAP a cover leg is evaluated at (the
terms of the bet, not a price) and the moneyline is a yardstick the incumbent is
measured beside. Neither reaches a number we ship.

WALK-FORWARD DISCIPLINE
-----------------------
Elo is chained season by season from the earliest fixture season; the rating used
for a (season, week) is built from that season's games with week < w on top of the
reverted prior-season carry. Prop features for week w use prior-season totals at
half weight plus current-season weeks < w. Calibration folds: Y=2024 fit on 2023;
Y=2025 fit on 2023-24. Nothing from season Y touches a fold-Y number. The SHIPPED
coefficients are fit on all fixture seasons (2023-2025) — that fit is not a
measurement and the file says so.

ABSENT IS ABSENT
----------------
A game with no book line, a tie, a push, a position with no eligible rostered
player that week — every one is SKIPPED and COUNTED (`skipped` blocks), never
zero-filled. A hit rate over zero picks is null, not 0.

CLI
---
  python3 scripts/backtest_parlay.py             recompute, write data/parlay_backtest.json
  python3 scripts/backtest_parlay.py --gate      recompute, write NOTHING; exit 1 if the
                                                 props verdict is not adopted, the spread
                                                 verdict is not "no_edge", or the committed
                                                 file's shipped numbers no longer match
  python3 scripts/backtest_parlay.py --selftest  synthetic fixture; exit code only

Stdlib only. Runs in well under a minute on the committed fixtures.
"""

import datetime as dt
import json
import math
import os
import sys
from statistics import NormalDist

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from scripts.models import elo  # noqa: E402

DATA = os.path.join(_REPO_ROOT, "data")
FIXTURE_DIR = os.path.join(DATA, "fixtures", "backtest_weekly")
GAMES_META_REL = "data/fixtures/backtest_weekly/games_meta.json"
WEEKLY_ACTUALS_REL = "data/fixtures/backtest_weekly/weekly_actuals.json"
GAMES_META_PATH = os.path.join(_REPO_ROOT, GAMES_META_REL)
WEEKLY_ACTUALS_PATH = os.path.join(_REPO_ROOT, WEEKLY_ACTUALS_REL)
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
OUT_PATH = os.path.join(DATA, "parlay_backtest.json")

# Seasons scored (T1/T2/T4) and the walk-forward prop folds (T3).
SEASONS = (2023, 2024, 2025)
FOLDS = ((2024, (2023,)), (2025, (2023, 2024)))

# The margin sigma the shipped cover rule used (game_model._MARGIN_SIGMA) —
# restated here as the number under test, not imported, so the measurement does
# not move if the model constant does.
SIGMA = 13.5

# Prop lines (the builder's documented seeds — round league-typical thresholds).
LINES = {"QB": 224.5, "RB": 59.5, "WR": 59.5}
YARDS_FIELD = {"QB": "pass_yds", "RB": "rush_yds", "WR": "rec_yds"}
POSITIONS = ("QB", "RB", "WR")

PRIOR_WEIGHT = 0.5          # prior season counts half against current-season weeks
MIN_PRIOR_GAMES = 6
MIN_CURRENT_GAMES = 4
DVP_SHRINK = 0.5            # applied multiplier = 1 + 0.5 * (dvp_ratio - 1)
DVP_CLAMP = (0.8, 1.2)
L2 = 0.1                    # ridge on the slope terms of the logistic fit
NEWTON_ITERS = 40

# The seed the builder shipped before R51 (parlay_builder._PROP_WIN_SHADE etc.).
SEED_SHADE, SEED_LO, SEED_HI = 0.4, 0.35, 0.65

# The builder's PRE-R51 correlation priors — recorded beside the measurement.
CORR_PAIRS = (
    ("moneyline|spread", "favorite ML & favorite cover", 0.55),
    ("qb_pass_yds|wr_rec_yds", "QB 225+ & same-team WR 60+", 0.45),
    ("qb_pass_yds|rb_rush_yds", "QB 225+ & same-team RB 60+", 0.20),
    ("qb_pass_yds|wr_rec_yds|opposing", "QB 225+ & opposing WR 60+", 0.20),
    ("rb_rush_yds|moneyline", "RB 60+ & his team wins", 0.25),
)
DEFAULT_RHO = 0.10

# Franchise moves inside the fixture window: one rating chain per franchise.
TEAM_RENAMES = {"OAK": "LV", "SD": "LAC", "STL": "LAR"}

_ND = NormalDist()
_EPS = 1e-6
_LN2 = math.log(2.0)

POLICY = (
    "Market / Vegas / Sleeper numbers are never projection inputs. The book's "
    "spread is the handicap a cover leg is evaluated at and the moneyline is a "
    "measurement yardstick for the incumbent; neither reaches a shipped number. "
    "Absent data is skipped and counted, never zero-filled. Learned changes ship "
    "only behind never-regress (calibrated <= seed on every walk-forward fold)."
)


# ---------------------------------------------------------------------------
# Small numeric helpers (stdlib only).
# ---------------------------------------------------------------------------
def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _sigmoid(x):
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def _log_loss(p, y):
    p = _clamp(p, _EPS, 1.0 - _EPS)
    return -(math.log(p) if y else math.log(1.0 - p))


def _brier(p, y):
    return (p - float(y)) ** 2


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


def american_to_prob(ml):
    """American odds -> raw (vig-inclusive) implied probability."""
    ml = float(ml)
    if ml < 0:
        return -ml / (-ml + 100.0)
    return 100.0 / (ml + 100.0)


def devig_pair(p_a, p_b):
    s = p_a + p_b
    return p_a / s, p_b / s


def _solve3(a, b):
    """Solve the 3x3 system a x = b by Gaussian elimination with pivoting."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    n = 3
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-12:
            raise ArithmeticError("singular Hessian in logistic fit")
        m[col], m[piv] = m[piv], m[col]
        for r in range(n):
            if r == col:
                continue
            f = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


def fit_logistic(rows, l2=L2, iters=NEWTON_ITERS):
    """Ridge logistic p = sigmoid(a + b*z + c*t) by Newton's method.

    rows: (z, t, y) triples. The intercept is unpenalised; the two slopes carry
    the L2 penalty `l2`. Returns (a, b, c). Stdlib only.
    """
    beta = [0.0, 0.0, 0.0]
    if not rows:
        return tuple(beta)
    for _ in range(iters):
        g = [0.0, 0.0, 0.0]
        h = [[0.0] * 3 for _ in range(3)]
        for z, t, y in rows:
            x = (1.0, z, t)
            p = _sigmoid(beta[0] + beta[1] * z + beta[2] * t)
            w = p * (1.0 - p)
            for i in range(3):
                g[i] += (p - y) * x[i]
                for j in range(3):
                    h[i][j] += w * x[i] * x[j]
        for i in (1, 2):
            g[i] += l2 * beta[i]
            h[i][i] += l2
        step = _solve3(h, g)
        beta = [beta[i] - step[i] for i in range(3)]
        if max(abs(s) for s in step) < 1e-10:
            break
    return tuple(beta)


# ---------------------------------------------------------------------------
# Fixture loading.
# ---------------------------------------------------------------------------
def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _team(t):
    return TEAM_RENAMES.get(t, t)


def load_games(doc):
    """games_meta.json -> list of game dicts, chronological, teams normalised."""
    fields = doc["fields"]
    games = []
    for row in doc["games"]:
        g = dict(zip(fields, row))
        g["home"] = _team(g["home"])
        g["away"] = _team(g["away"])
        g["season"] = int(g["season"])
        g["week"] = int(g["week"])
        # elo.rate_season orders on kickoff_utc; the fixture carries local ET,
        # which orders identically within a season.
        g["kickoff_utc"] = g.get("kickoff_local_et") or ""
        games.append(g)
    games.sort(key=lambda g: (g["season"], g["week"], g["kickoff_utc"], g["home"]))
    return games


def load_weekly(doc):
    """weekly_actuals.json -> {pid: {name, pos, seasons: {season: {week: row}}}}.

    Row = dict(team, opp, pts_ppr, pass_yds, rush_yds, rec_yds), ints for keys.
    """
    fields = doc["fields"]
    out = {}
    for pid, rec in doc["players"].items():
        seasons = {}
        for s, weeks in (rec.get("seasons") or {}).items():
            sw = {}
            for w, row in weeks.items():
                r = dict(zip(fields, row))
                r["team"] = _team(r["team"])
                r["opp"] = _team(r["opp"])
                sw[int(w)] = r
            seasons[int(s)] = sw
        out[pid] = {"name": rec.get("name"), "pos": rec.get("pos"), "seasons": seasons}
    return out


def load_game_params(path=TUNING_PATH):
    """hfa / k / revert from data/model_tuning.json game_params (the fitted set)."""
    gp = (_load(path).get("game_params") or {}) if os.path.exists(path) else {}
    return {
        "hfa": float(gp.get("hfa_elo", elo.HFA_ELO)),
        "k": float(gp.get("k", elo.K)),
        "revert": float(gp.get("revert", elo.REVERT)),
    }


# ---------------------------------------------------------------------------
# Elo pre-week ratings, chained across seasons.
# ---------------------------------------------------------------------------
def preweek_ratings(games, params):
    """{(season, week): {team: rating}} — ratings BEFORE that week's games.

    Season s starts from the reverted end-of-season ratings of s-1 (chain from
    the earliest fixture season); the pre-week-w rating is that carry updated by
    the season's games with week < w. Week 1 of the first season is all INIT.
    """
    by_season = {}
    for g in games:
        by_season.setdefault(g["season"], []).append(g)
    carry = None
    out = {}
    for season in sorted(by_season):
        sg = by_season[season]
        for w in sorted({g["week"] for g in sg}):
            prior = [g for g in sg if g["week"] < w]
            out[(season, w)] = elo.rate_season(
                prior, k=params["k"], hfa=params["hfa"], initial_ratings=carry)
        end = elo.rate_season(sg, k=params["k"], hfa=params["hfa"],
                              initial_ratings=carry)
        carry = elo.revert_to_mean(end, revert=params["revert"])
    return out


def p_home_elo(ratings, g, params):
    rh = ratings.get(g["home"], elo.INIT)
    ra = ratings.get(g["away"], elo.INIT)
    return elo.expected_home(rh, ra, params["hfa"])


# ---------------------------------------------------------------------------
# T1 — moneyline (record only).
# ---------------------------------------------------------------------------
def score_moneyline(games, pre, params, seasons=SEASONS):
    rows = []      # (season, p_elo, p_mkt, y)
    skipped = {"tie": 0, "no_moneyline": 0}
    for g in games:
        if g["season"] not in seasons:
            continue
        if g["home_score"] == g["away_score"]:
            skipped["tie"] += 1
            continue
        if g.get("home_ml") is None or g.get("away_ml") is None:
            skipped["no_moneyline"] += 1
            continue
        y = 1 if g["home_score"] > g["away_score"] else 0
        p = p_home_elo(pre[(g["season"], g["week"])], g, params)
        pm, _ = devig_pair(american_to_prob(g["home_ml"]),
                           american_to_prob(g["away_ml"]))
        rows.append((g["season"], p, pm, y))
    per_season = {}
    for s in seasons:
        srows = [r for r in rows if r[0] == s]
        if not srows:
            continue
        per_season[str(s)] = {
            "incumbent_log_loss": _r(_mean([_log_loss(p, y) for _, p, _, y in srows])),
            "market_log_loss": _r(_mean([_log_loss(pm, y) for _, _, pm, y in srows])),
        }
    return {
        "n": len(rows),
        "incumbent_log_loss": _r(_mean([_log_loss(p, y) for _, p, _, y in rows])),
        "incumbent_brier": _r(_mean([_brier(p, y) for _, p, _, y in rows])),
        "market_log_loss": _r(_mean([_log_loss(pm, y) for _, _, pm, y in rows])),
        "market_brier": _r(_mean([_brier(pm, y) for _, _, pm, y in rows])),
        "per_season": per_season,
        "skipped": skipped,
        "note": "market = de-vigged closing moneyline, MEASUREMENT ONLY, never an input",
    }


# ---------------------------------------------------------------------------
# T2 — spread cover at the book number (the shipped rule under test).
# ---------------------------------------------------------------------------
def shipped_home_cover_prob(p_home, spread_line_home, sigma=SIGMA):
    """The pre-R51 rule: margin = PHI^-1(p) * sigma; P(home covers) = PHI((margin - line)/sigma).

    spread_line_home is the nflverse sign: positive = home favoured by that many,
    so the home side covers when the final home margin exceeds it.
    """
    p = _clamp(float(p_home), 1e-4, 1.0 - 1e-4)
    margin = _ND.inv_cdf(p) * sigma
    return _ND.cdf((margin - float(spread_line_home)) / sigma)


def _bin_label(conv):
    lo = min(int(conv / 0.05), 9) * 0.05
    return "%.2f-%.2f" % (lo, lo + 0.05)


def score_spread(games, pre, params, seasons=SEASONS):
    rows = []      # (p_home_cover, y_home_cover)
    skipped = {"push": 0, "no_line": 0}
    for g in games:
        if g["season"] not in seasons:
            continue
        line = g.get("spread_line_home")
        if line is None:
            skipped["no_line"] += 1
            continue
        actual = g["home_score"] - g["away_score"]
        if actual == line:
            skipped["push"] += 1
            continue
        y = 1 if actual > line else 0
        p = shipped_home_cover_prob(p_home_elo(pre[(g["season"], g["week"])], g, params), line)
        rows.append((p, y))
    model_ll = _mean([_log_loss(p, y) for p, y in rows])
    bins = {}
    for p, y in rows:
        conv = abs(p - 0.5)
        pick_home = p >= 0.5
        hit = y if pick_home else 1 - y
        b = bins.setdefault(_bin_label(conv), [0, 0])
        b[0] += 1
        b[1] += hit
    by_bin = [{"bin": k, "n": n, "hit": _r(h / n) if n else None}
              for k, (n, h) in sorted(bins.items())]
    no_edge = model_ll is None or model_ll >= _LN2
    return {
        "n": len(rows),
        "sigma": SIGMA,
        "model_cover_log_loss": _r(model_ll),
        "flat_log_loss": _r(_LN2),
        "model_brier": _r(_mean([_brier(p, y) for p, y in rows])),
        "pick_hit_rate_by_conviction": by_bin,
        "skipped": skipped,
        "verdict": "no_edge" if no_edge else "edge",
        "reason": (
            "cover model log-loss %s >= flat 0.5 log-loss %.4f on %d games (pushes "
            "excluded): PHI^-1(p_elo) x %.1f evaluated at the book number carries no "
            "information the line does not; spread legs are priced flat until a margin "
            "model clears never-regress"
            % (_r(model_ll), _LN2, len(rows), SIGMA)
            if no_edge else
            "cover model log-loss %s < flat %.4f on %d games — re-measure before "
            "restoring a priced spread leg" % (_r(model_ll), _LN2, len(rows))
        ),
    }


# ---------------------------------------------------------------------------
# T3 — props: pick, features, seed vs calibrated, walk-forward.
# ---------------------------------------------------------------------------
class PropCorpus:
    """Per-position pick + feature rows for every (season, week, game), built once.

    Everything a fold needs is a function of the row; folds only decide which
    rows fit and which rows score, and the residual sd of the fit rows.
    """

    def __init__(self, games, weekly, pre, params, seasons=SEASONS):
        self.games = games
        self.weekly = weekly
        self.pre = pre
        self.params = params
        self.seasons = tuple(seasons)
        self.skipped = {pos: {"no_eligible_player": 0} for pos in POSITIONS}
        self._index()
        self.rows = self._build_rows()

    # -- indexes ------------------------------------------------------------
    def _index(self):
        # team-games per season/week, for per-game "allowed" denominators
        self.team_games = {}   # (season, team) -> sorted list of weeks played
        for g in self.games:
            for t in (g["home"], g["away"]):
                self.team_games.setdefault((g["season"], t), []).append(g["week"])
        for k in self.team_games:
            self.team_games[k].sort()
        # yards allowed to each position by (season, team) per week
        self.allowed = {}      # (season, team, pos) -> {week: yards}
        self.by_pos = {pos: [] for pos in POSITIONS}
        for pid, rec in self.weekly.items():
            pos = rec["pos"]
            if pos not in YARDS_FIELD:
                continue
            self.by_pos[pos].append(pid)
            yf = YARDS_FIELD[pos]
            for s, weeks in rec["seasons"].items():
                for w, row in weeks.items():
                    d = self.allowed.setdefault((s, row["opp"], pos), {})
                    d[w] = d.get(w, 0.0) + float(row[yf] or 0.0)
        for pos in POSITIONS:
            self.by_pos[pos].sort()

    def _allowed_sum(self, season, team, pos, before_week=None):
        d = self.allowed.get((season, team, pos), {})
        games = self.team_games.get((season, team), [])
        if before_week is not None:
            yards = sum(v for w, v in d.items() if w < before_week)
            n = sum(1 for w in games if w < before_week)
        else:
            yards = sum(d.values())
            n = len(games)
        return yards, n

    def dvp_multiplier(self, season, week, opp, pos):
        """clamp(1 + DVP_SHRINK * (ratio - 1)), ratio = opp's blended yards allowed
        per game to `pos` / league average of the same blend. None if no data."""
        teams = {t for (s, t) in self.team_games if s == season}
        py, pn = self._allowed_sum(season - 1, opp, pos)
        cy, cn = self._allowed_sum(season, opp, pos, before_week=week)
        denom = PRIOR_WEIGHT * pn + cn
        if denom <= 0:
            return None
        team_pg = (PRIOR_WEIGHT * py + cy) / denom
        ly = ln = 0.0
        for t in teams:
            a, b = self._allowed_sum(season - 1, t, pos)
            c, d = self._allowed_sum(season, t, pos, before_week=week)
            ly += PRIOR_WEIGHT * a + c
            ln += PRIOR_WEIGHT * b + d
        if ln <= 0:
            return None
        league_pg = ly / ln
        if league_pg <= 0:
            return None
        ratio = team_pg / league_pg
        return _clamp(1.0 + DVP_SHRINK * (ratio - 1.0), DVP_CLAMP[0], DVP_CLAMP[1])

    def _blend(self, pid, pos, season, week):
        """Blended yards per game entering `week`, or None if ineligible.

        Prior season at half weight plus current-season weeks < week; needs
        >= MIN_PRIOR_GAMES prior games or >= MIN_CURRENT_GAMES current ones.
        Only pre-week information is read.
        """
        rec = self.weekly[pid]
        yf = YARDS_FIELD[pos]
        prior = rec["seasons"].get(season - 1, {})
        cur = {w: r for w, r in rec["seasons"].get(season, {}).items() if w < week}
        if len(prior) < MIN_PRIOR_GAMES and len(cur) < MIN_CURRENT_GAMES:
            return None
        py = sum(float(r[yf] or 0.0) for r in prior.values())
        cy = sum(float(r[yf] or 0.0) for r in cur.values())
        denom = PRIOR_WEIGHT * len(prior) + len(cur)
        if denom <= 0:
            return None
        return (PRIOR_WEIGHT * py + cy) / denom

    def _build_rows(self):
        rows = []
        for g in self.games:
            season, week = g["season"], g["week"]
            if season not in self.seasons:
                continue
            ratings = self.pre[(season, week)]
            p_home = p_home_elo(ratings, g, self.params)
            home_win = (1 if g["home_score"] > g["away_score"] else
                        0 if g["home_score"] < g["away_score"] else None)
            for pos in POSITIONS:
                # Candidates: players on either roster THAT week (a row for the
                # game-week whose team is one of the two — roster membership is
                # pre-game knowledge; the row's yards are the only outcome read).
                best = None
                for pid in self.by_pos[pos]:
                    actual = self.weekly[pid]["seasons"].get(season, {}).get(week)
                    if actual is None or actual["team"] not in (g["home"], g["away"]):
                        continue
                    mu = self._blend(pid, pos, season, week)
                    if mu is None:
                        continue
                    key = (-mu, pid)
                    if best is None or key < best[0]:
                        best = (key, pid, actual["team"], mu, actual)
                if best is None:
                    self.skipped[pos]["no_eligible_player"] += 1
                    continue
                _, pid, team, mu, actual = best
                opp = g["away"] if team == g["home"] else g["home"]
                mult = self.dvp_multiplier(season, week, opp, pos)
                if mult is None:
                    mult = 1.0   # no allowed data at all (only week 1 of a first season)
                yards = float(actual[YARDS_FIELD[pos]] or 0.0)
                p_team = p_home if team == g["home"] else 1.0 - p_home
                team_win = (None if home_win is None else
                            home_win if team == g["home"] else 1 - home_win)
                rows.append({
                    "season": season, "week": week, "game": (season, week, g["home"], g["away"]),
                    "pos": pos, "pid": pid, "team": team, "opp": opp,
                    "mu": mu, "mult": mult, "yards": yards,
                    "y": 1 if yards >= LINES[pos] else 0,
                    "p_team": p_team, "team_win": team_win,
                })
        return rows


def residual_sd(rows, pos):
    res = [r["yards"] - r["mu"] * r["mult"] for r in rows if r["pos"] == pos]
    if len(res) < 2:
        return None
    m = sum(res) / len(res)
    return math.sqrt(sum((x - m) ** 2 for x in res) / (len(res) - 1))


def seed_prob(p_team):
    return _clamp(0.5 + SEED_SHADE * (p_team - 0.5), SEED_LO, SEED_HI)


def calibrated_prob(coef, z, p_team):
    a, b, c = coef
    return _sigmoid(a + b * z + c * (p_team - 0.5))


def _z(row, sd):
    return (row["mu"] * row["mult"] - LINES[row["pos"]]) / sd


def _metrics(pairs):
    """pairs: (p, y). Hit rates are over the picks with p > threshold; null if none."""
    if not pairs:
        return {"log_loss": None, "brier": None, "hit_rate": None, "picks": 0,
                "hit_rate_60": None, "picks_60": 0, "n": 0}
    picks = [(p, y) for p, y in pairs if p > 0.5]
    picks60 = [(p, y) for p, y in pairs if p > 0.6]
    return {
        "log_loss": _r(_mean([_log_loss(p, y) for p, y in pairs])),
        "brier": _r(_mean([_brier(p, y) for p, y in pairs])),
        "hit_rate": _r(_mean([y for _, y in picks])) if picks else None,
        "picks": len(picks),
        "hit_rate_60": _r(_mean([y for _, y in picks60])) if picks60 else None,
        "picks_60": len(picks60),
        "n": len(pairs),
    }


def fit_on(rows, fit_seasons):
    """(residual_sd by pos, coefficients by pos) fit on `fit_seasons` rows."""
    fit_rows = [r for r in rows if r["season"] in fit_seasons]
    sds, coefs = {}, {}
    for pos in POSITIONS:
        sd = residual_sd(fit_rows, pos)
        sds[pos] = sd
        if sd is None or sd <= 0:
            coefs[pos] = None
            continue
        triples = [(_z(r, sd), r["p_team"] - 0.5, r["y"])
                   for r in fit_rows if r["pos"] == pos]
        coefs[pos] = fit_logistic(triples) if triples else None
    return sds, coefs


def score_fold(rows, season, fit_seasons):
    sds, coefs = fit_on(rows, fit_seasons)
    test = [r for r in rows if r["season"] == season]
    seed_pairs, cal_pairs = [], []
    per_pos = {}
    for pos in POSITIONS:
        sp = [(seed_prob(r["p_team"]), r["y"]) for r in test if r["pos"] == pos]
        cp = []
        if sds[pos] and coefs[pos]:
            cp = [(calibrated_prob(coefs[pos], _z(r, sds[pos]), r["p_team"]), r["y"])
                  for r in test if r["pos"] == pos]
        seed_pairs += sp
        cal_pairs += cp
        per_pos[pos] = {"n": len(sp), "residual_sd": _r(sds[pos]),
                        "seed": _metrics(sp), "calibrated": _metrics(cp)}
    return {
        "season": season,
        "fit_seasons": list(fit_seasons),
        "seed": _metrics(seed_pairs),
        "calibrated": _metrics(cal_pairs),
        "per_position": per_pos,
    }


def score_props(corpus, seasons=SEASONS, folds=FOLDS):
    rows = corpus.rows
    fold_out = [score_fold(rows, y, fit) for y, fit in folds]
    # SHIPPED coefficients: fit on ALL fixture seasons — not a measurement.
    sds, coefs = fit_on(rows, seasons)
    calibration = {}
    for pos in POSITIONS:
        if coefs[pos] is None:
            continue
        a, b, c = coefs[pos]
        calibration[pos] = {"a": _r(a, 6), "b": _r(b, 6), "c": _r(c, 6),
                            "fit_seasons": list(seasons)}
    comparable = [f for f in fold_out
                  if f["seed"]["log_loss"] is not None and f["calibrated"]["log_loss"] is not None]
    regress = [f["season"] for f in comparable
               if f["calibrated"]["log_loss"] > f["seed"]["log_loss"]]
    adopted = bool(comparable) and not regress and len(comparable) == len(fold_out)
    if adopted:
        reason = "calibrated log-loss <= seed on every fold: " + "; ".join(
            "%d: %.4f vs %.4f" % (f["season"], f["calibrated"]["log_loss"], f["seed"]["log_loss"])
            for f in fold_out)
    elif not comparable:
        reason = "no fold could be scored (no prop rows) — nothing measured, nothing adopted"
    else:
        reason = "calibrated log-loss > seed on fold(s) %s — never-regress blocks adoption" % regress
    return {
        "lines": dict(LINES),
        "residual_sd": {pos: _r(sds[pos]) for pos in POSITIONS},
        "dvp_shrink": DVP_SHRINK,
        "folds": fold_out,
        "calibration": calibration,
        "calibration_note": (
            "SHIPPED coefficients are fit on ALL fixture seasons %s — that fit is not a "
            "measurement; the walk-forward folds above are. residual_sd is likewise the "
            "all-seasons value." % list(seasons)),
        "skipped": corpus.skipped,
        "verdict": {
            "adopted": adopted,
            "rule": "never-regress: calibrated log-loss <= seed log-loss on every walk-forward fold",
            "reason": reason,
        },
    }


# ---------------------------------------------------------------------------
# T4 — same-game correlations (copula-lite rho).
# ---------------------------------------------------------------------------
def rho_from_events(pairs):
    """pairs: (a, b) 0/1 events. rho = (P(AB) - P(A)P(B)) / sqrt(P(A)(1-P(A))P(B)(1-P(B)))."""
    n = len(pairs)
    if n == 0:
        return None, 0
    pa = sum(a for a, _ in pairs) / n
    pb = sum(b for _, b in pairs) / n
    pab = sum(1 for a, b in pairs if a and b) / n
    den = math.sqrt(pa * (1 - pa) * pb * (1 - pb))
    if den <= 0:
        return None, n
    return (pab - pa * pb) / den, n


def score_correlations(games, pre, params, corpus, seasons=SEASONS):
    picks = {}   # (season, week, home, away) -> {pos: row}
    for r in corpus.rows:
        picks.setdefault(r["game"], {})[r["pos"]] = r

    ml_cover = []
    for g in games:
        if g["season"] not in seasons:
            continue
        line = g.get("spread_line_home")
        actual = g["home_score"] - g["away_score"]
        if line is None or actual == line or actual == 0:
            continue
        p_home = p_home_elo(pre[(g["season"], g["week"])], g, params)
        fav_home = p_home >= 0.5
        fav_wins = (actual > 0) if fav_home else (actual < 0)
        fav_covers = (actual > line) if fav_home else (actual < line)
        ml_cover.append((int(fav_wins), int(fav_covers)))

    qb_wr_same, qb_rb_same, qb_wr_opp, rb_win = [], [], [], []
    for _, byp in picks.items():
        qb, rb, wr = byp.get("QB"), byp.get("RB"), byp.get("WR")
        if qb and wr:
            (qb_wr_same if qb["team"] == wr["team"] else qb_wr_opp).append((qb["y"], wr["y"]))
        if qb and rb and qb["team"] == rb["team"]:
            qb_rb_same.append((qb["y"], rb["y"]))
        if rb and rb["team_win"] is not None:
            rb_win.append((rb["y"], rb["team_win"]))

    samples = {
        "moneyline|spread": ml_cover,
        "qb_pass_yds|wr_rec_yds": qb_wr_same,
        "qb_pass_yds|rb_rush_yds": qb_rb_same,
        "qb_pass_yds|wr_rec_yds|opposing": qb_wr_opp,
        "rb_rush_yds|moneyline": rb_win,
    }
    out = []
    for key, label, prior in CORR_PAIRS:
        rho, n = rho_from_events(samples[key])
        out.append({"key": key, "label": label, "rho": _r(rho), "n": n, "prior": prior})
    return {
        "pairs": out,
        "default_rho": DEFAULT_RHO,
        "method": (
            "copula-lite rho = (P(AB) - P(A)P(B)) / sqrt(P(A)(1-P(A))P(B)(1-P(B))) on "
            "resolved %s games; favorite = the Elo favourite (the side the builder's legs "
            "take), ties and pushes excluded; prop events are the per-game pick's yards "
            "vs the line; 'opposing' = the picks sit on different teams. Priors are the "
            "pre-R51 hand-set values, kept for the record." % list(seasons)),
    }


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------
def run(games, weekly, params, seasons=SEASONS, folds=FOLDS, fixture=None):
    pre = preweek_ratings(games, params)
    corpus = PropCorpus(games, weekly, pre, params, seasons=seasons)
    return {
        "generated_utc": None,
        "fixture": fixture or {
            "games_meta": GAMES_META_REL,
            "weekly_actuals": WEEKLY_ACTUALS_REL,
            "seasons": list(seasons),
        },
        "elo_params": dict(params),
        "moneyline": score_moneyline(games, pre, params, seasons),
        "spread": score_spread(games, pre, params, seasons),
        "props": score_props(corpus, seasons=seasons, folds=folds),
        "correlations": score_correlations(games, pre, params, corpus, seasons),
        "policy": POLICY,
    }


def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stamp(doc, existing):
    """Keep the committed stamp when nothing but the stamp would change, so a
    re-run on unchanged inputs is byte-identical (deterministic output)."""
    if existing is not None:
        old = dict(existing)
        old.pop("generated_utc", None)
        new = dict(doc)
        new.pop("generated_utc", None)
        if old == new and existing.get("generated_utc"):
            doc["generated_utc"] = existing["generated_utc"]
            return doc
    doc["generated_utc"] = _now()
    return doc


def _write(path, doc):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def compute():
    games = load_games(_load(GAMES_META_PATH))
    weekly = load_weekly(_load(WEEKLY_ACTUALS_PATH))
    return run(games, weekly, load_game_params())


def _print_summary(doc):
    ml, sp, pr, co = doc["moneyline"], doc["spread"], doc["props"], doc["correlations"]
    print("PARLAY BACKTEST — walk-forward on %s (elo hfa=%s k=%s revert=%s)"
          % (doc["fixture"]["seasons"], doc["elo_params"]["hfa"], doc["elo_params"]["k"],
             doc["elo_params"]["revert"]))
    print("  T1 moneyline n=%d  incumbent log-loss %s brier %s | market (yardstick) "
          "log-loss %s brier %s" % (ml["n"], ml["incumbent_log_loss"], ml["incumbent_brier"],
                                    ml["market_log_loss"], ml["market_brier"]))
    for s, v in ml["per_season"].items():
        print("     %s: incumbent %s market %s" % (s, v["incumbent_log_loss"], v["market_log_loss"]))
    print("  T2 spread n=%d  cover log-loss %s vs flat %s brier %s -> %s"
          % (sp["n"], sp["model_cover_log_loss"], sp["flat_log_loss"], sp["model_brier"],
             sp["verdict"].upper()))
    for b in sp["pick_hit_rate_by_conviction"]:
        print("     |p-0.5| %s n=%-4d hit %s" % (b["bin"], b["n"], b["hit"]))
    print("  T3 props residual sd %s" % pr["residual_sd"])
    for f in pr["folds"]:
        s, c = f["seed"], f["calibrated"]
        print("     fold %d (fit %s) n=%d: seed ll %s hit %s (%d picks) | calibrated ll %s "
              "hit %s (%d picks) hit60 %s (%d picks)"
              % (f["season"], f["fit_seasons"], s["n"], s["log_loss"], s["hit_rate"],
                 s["picks"], c["log_loss"], c["hit_rate"], c["picks"], c["hit_rate_60"],
                 c["picks_60"]))
    for pos, c in pr["calibration"].items():
        print("     shipped %s: a=%+.3f b=%+.3f c=%+.3f (fit %s)"
              % (pos, c["a"], c["b"], c["c"], c["fit_seasons"]))
    print("     skipped: %s" % pr["skipped"])
    print("     verdict: %s — %s" % ("ADOPTED" if pr["verdict"]["adopted"] else "NOT ADOPTED",
                                     pr["verdict"]["reason"]))
    print("  T4 correlations:")
    for p in co["pairs"]:
        print("     %-32s rho %s n=%d (prior %s)" % (p["label"], p["rho"], p["n"], p["prior"]))


def gate(doc, committed_path=OUT_PATH):
    """Exit 1 when the world changed: props not adopted, spread verdict not
    no_edge, or the committed file's SHIPPED numbers no longer match what the
    fixtures produce (production reads that file)."""
    problems = []
    if not doc["props"]["verdict"]["adopted"]:
        problems.append("props verdict is NOT adopted: %s" % doc["props"]["verdict"]["reason"])
    if doc["spread"]["verdict"] != "no_edge":
        problems.append("spread verdict is %r, not 'no_edge' — the flat-0.5 pricing "
                        "premise moved; re-measure before touching the builder"
                        % doc["spread"]["verdict"])
    if not os.path.exists(committed_path):
        problems.append("%s is absent — run scripts/backtest_parlay.py to write it"
                        % os.path.relpath(committed_path, _REPO_ROOT))
    else:
        committed = _load(committed_path)
        for key in ("calibration", "residual_sd"):
            if committed.get("props", {}).get(key) != doc["props"][key]:
                problems.append("committed props.%s differs from the recomputed value — "
                                "production would price from stale numbers" % key)
        if committed.get("correlations", {}).get("pairs") != doc["correlations"]["pairs"]:
            problems.append("committed correlations.pairs differ from the recomputed values")
    for p in problems:
        print("GATE FAIL: %s" % p, file=sys.stderr)
    return 1 if problems else 0


# ---------------------------------------------------------------------------
# Selftest — synthetic fixture, exit code only, never writes.
# ---------------------------------------------------------------------------
def _synthetic():
    """Deterministic two-season-plus toy league: 8 teams, 14 weeks, players whose
    yards track a hidden per-player mean so the calibrated model has signal."""
    import random
    rng = random.Random(51)
    teams = ["T%d" % i for i in range(8)]
    strength = {t: rng.uniform(-6, 6) for t in teams}
    seasons = (2022, 2023, 2024, 2025)
    games, players = [], {}
    for pos, base, spread in (("QB", 235.0, 45.0), ("RB", 62.0, 22.0), ("WR", 62.0, 25.0)):
        for i, t in enumerate(teams):
            for depth in range(2):
                pid = "%s-%s-%d" % (pos, t, depth)
                players[pid] = {"name": pid, "pos": pos, "seasons": {},
                                "_team": t, "_mean": base + rng.uniform(-spread, spread) - 20 * depth}
    for s in seasons:
        for w in range(1, 15):
            order = teams[:]
            rng.shuffle(order)
            for i in range(0, 8, 2):
                h, a = order[i], order[i + 1]
                margin = strength[h] - strength[a] + 2.0 + rng.gauss(0, 13)
                hs = max(0, int(round(24 + margin / 2)))
                as_ = max(0, int(round(24 - margin / 2)))
                if hs == as_:
                    hs += 1
                line = round((strength[h] - strength[a] + 2.0) * 2) / 2
                fav_ml = -150 if line >= 0 else 130
                games.append({"season": s, "week": w, "home": h, "away": a,
                              "home_score": hs, "away_score": as_,
                              "kickoff_utc": "%d-W%02d" % (s, w),
                              "spread_line_home": line,
                              "home_ml": fav_ml, "away_ml": -fav_ml + 20})
                for t, opp, home in ((h, a, True), (a, h, False)):
                    for pid, rec in players.items():
                        if rec["_team"] != t:
                            continue
                        y = max(0.0, rec["_mean"] + (8 if home else -8) + rng.gauss(0, 30))
                        pass_y = y if rec["pos"] == "QB" else 0.0
                        rush_y = y if rec["pos"] == "RB" else 0.0
                        rec_y = y if rec["pos"] == "WR" else 0.0
                        rec["seasons"].setdefault(s, {})[w] = {
                            "team": t, "opp": opp, "pts_ppr": y / 10.0,
                            "pass_yds": pass_y, "rush_yds": rush_y, "rec_yds": rec_y}
    for rec in players.values():
        rec.pop("_team")
        rec.pop("_mean")
    return games, players


def selftest():
    # 1. the logistic fit recovers a known model on synthetic data
    import random
    rng = random.Random(7)
    rows = []
    for _ in range(4000):
        z, t = rng.gauss(0, 1), rng.uniform(-0.5, 0.5)
        p = _sigmoid(-0.3 + 1.2 * z + 0.8 * t)
        rows.append((z, t, 1 if rng.random() < p else 0))
    a, b, c = fit_logistic(rows)
    assert abs(a + 0.3) < 0.15 and abs(b - 1.2) < 0.15 and abs(c - 0.8) < 0.4, (a, b, c)
    # 2. helpers
    assert abs(american_to_prob(-200) - 2 / 3) < 1e-9
    assert abs(sum(devig_pair(0.6, 0.5)) - 1) < 1e-12
    assert abs(shipped_home_cover_prob(0.5, 0.0) - 0.5) < 1e-12
    assert shipped_home_cover_prob(0.7, 3.0) > shipped_home_cover_prob(0.7, 7.0)
    assert _bin_label(0.049) == "0.00-0.05" and _bin_label(0.05) == "0.05-0.10"
    assert rho_from_events([(1, 1), (0, 0), (1, 1), (0, 0)])[0] > 0.99
    assert rho_from_events([(1, 0), (0, 1), (1, 0), (0, 1)])[0] < -0.99
    assert rho_from_events([])[0] is None
    assert _metrics([])["hit_rate"] is None, "no picks is null, never 0"
    # 3. end-to-end on the synthetic league; contract keys present
    games, players = _synthetic()
    doc = run(games, players, {"hfa": 45.0, "k": 20.0, "revert": 0.45},
              seasons=(2023, 2024, 2025), folds=FOLDS,
              fixture={"games_meta": "synthetic", "weekly_actuals": "synthetic",
                       "seasons": [2023, 2024, 2025]})
    for k in ("moneyline", "spread", "props", "correlations", "policy", "fixture"):
        assert k in doc, k
    assert doc["moneyline"]["n"] > 0 and doc["spread"]["n"] > 0
    assert doc["spread"]["verdict"] in ("no_edge", "edge")
    assert set(doc["props"]["calibration"]) == set(POSITIONS)
    for f in doc["props"]["folds"]:
        assert f["seed"]["n"] > 0 and f["calibrated"]["n"] == f["seed"]["n"]
    # synthetic players have a strong hidden mean: the calibrated model must beat the seed
    assert doc["props"]["verdict"]["adopted"] is True, doc["props"]["verdict"]
    assert [p["key"] for p in doc["correlations"]["pairs"]] == [k for k, _, _ in CORR_PAIRS]
    assert all(p["n"] > 0 for p in doc["correlations"]["pairs"])
    # 4. leak check: flipping a held-out-season actual never moves a fold-2024 number
    games2 = [dict(g) for g in games]
    for g in games2:
        if g["season"] == 2025:
            g["home_score"], g["away_score"] = g["away_score"], g["home_score"]
    doc2 = run(games2, players, {"hfa": 45.0, "k": 20.0, "revert": 0.45},
               seasons=(2023, 2024, 2025), folds=FOLDS, fixture=doc["fixture"])
    assert doc2["props"]["folds"][0] == doc["props"]["folds"][0], "2025 leaked into fold 2024"
    assert doc2["moneyline"]["per_season"]["2024"] == doc["moneyline"]["per_season"]["2024"]
    print("selftest OK")


def main(argv):
    if "--selftest" in argv:
        selftest()
        return 0
    doc = compute()
    if "--gate" in argv:
        rc = gate(doc)
        print("parlay backtest gate: %s" % ("PASS" if rc == 0 else "FAIL"))
        return rc
    existing = _load(OUT_PATH) if os.path.exists(OUT_PATH) else None
    doc = _stamp(doc, existing)
    _write(OUT_PATH, doc)
    _print_summary(doc)
    print("wrote %s" % os.path.relpath(OUT_PATH, _REPO_ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
