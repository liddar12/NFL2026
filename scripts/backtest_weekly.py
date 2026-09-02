"""Walk-forward WEEKLY harness — the never-regress gate for weekly_split_v2.

scripts/backtest_player.py grades the SEASON total (from_week = 1). Nothing
graded the WEEKLY SHAPE — which is the thing Lineup, Waivers and Grade actually
read — so the tilt / venue / DvP / weather factors of the weekly split could not
be adopted honestly. This harness scores the split itself, player-week by
player-week, with every input restricted to what was knowable before kickoff:

  * The SEASON NUMBER is FIXED across variants (a prior-seasons PPG rule, see
    SEASON_NUMBER_RULE), so the comparison isolates the weekly SHAPE. The pool is
    the top N per position per season by that number (POOL), and the rows are the
    weeks a pooled player has a stat line.
  * v1 (incumbent, weekly_split_v1): base x Elo tilt (every position) x flat
    venue +/-0.02, renormalized over the team's scheduled weeks.
  * v2 (candidate, weekly_split_v2): base x D x T x W x V through the REAL
    scripts.build_weekly.player_weeks — the deployed code path, with fixture
    feeds built as-of each (season, week) — not a re-implementation.
  * As-of state per (season, week): Elo ratings chained season by season from
    the earliest fixture season (scripts.models.elo, data/model_tuning.json
    game_params) and moved game by game, snapshotted BEFORE the week; DvP from
    the prior season at half weight plus the current season's weeks < wk; venue
    home-field from games_meta seasons < Y only (home margin shrunk to the league
    mean with n0 = VENUE_N0 — the committed environment_model numbers span
    2021-2025 and are NEVER read here); weather from the roof / temperature /
    wind nflverse recorded for the game (the forecast is not archived; the
    observed kickoff-hour reading stands in for it, thresholds 32 F / 15 mph
    converted to the production 0 C / 24 km/h).

MARKET BOUNDARY: games_meta carries the book's spread and moneylines. They are
NOT read by this file — not for a projection, not for a metric.

Metrics (pooled over SEASONS_SCORED and on HELD_OUT alone): MAE; within
(season, week, position) Spearman rank correlation, n-weighted over groups of
>= MIN_GROUP; top-K start efficiency (actual points of the top-K by projection
/ actual points of the top-K by actual, K per position capped at half the
group); per-position MAE and rank corr; a split-conformal 68% band (per-position
|residual| quantile fitted on BAND_FIT_SEASONS, coverage and mean half-width
on HELD_OUT); and a paired season-week block bootstrap of MAE(v2) - MAE(v1) on
HELD_OUT (B = BOOT_B, fixed seed, so the artifact is deterministic).

NEVER-REGRESS: v2 is adopted only if it is not worse than v1 on pooled MAE AND
pooled rank_corr. `--gate` recomputes and exits 1 on a regression; the default
run writes data/weekly_backtest.json; `--selftest` runs a synthetic in-memory
fixture (offline, exit code only). Stdlib only.
"""

import datetime as dt
import json
import math
import os
import random
import sys
import time

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_weekly as bw                       # noqa: E402
from scripts.backtest_player import mae, spearman            # noqa: E402
from scripts.models import elo as elo_mod                    # noqa: E402

DATA = os.path.join(_ROOT, "data")
FIXTURE_DIR = os.path.join(DATA, "fixtures", "backtest_weekly")
ACTUALS_PATH = os.path.join(FIXTURE_DIR, "weekly_actuals.json")
GAMES_PATH = os.path.join(FIXTURE_DIR, "games_meta.json")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
OUT_PATH = os.path.join(DATA, "weekly_backtest.json")
ACTUALS_REL = "data/fixtures/backtest_weekly/weekly_actuals.json"
GAMES_REL = "data/fixtures/backtest_weekly/games_meta.json"

MODEL_CANDIDATE = bw.MODEL_NAME                 # "weekly_split_v2"
MODEL_INCUMBENT = "weekly_split_v1"
POSITIONS = bw.POSITIONS
SEASONS_SCORED = (2023, 2024, 2025)
HELD_OUT = 2025
BAND_FIT_SEASONS = (2023, 2024)
POOL = {"QB": 32, "RB": 60, "WR": 80, "TE": 32}
TOPK = {"QB": 12, "RB": 24, "WR": 36, "TE": 12}
MIN_GROUP = 5                 # a rank correlation needs a real group
MIN_PRIOR_GAMES = 6           # >= 6 stat lines in S-1 or the player has no number
PRIOR_WEIGHTS = (1.0, 2.0)    # S-2, S-1
GAMES_PER_SEASON = 17
VENUE_N0 = 16                 # shrinkage games toward the league mean margin
BAND_Q = 0.68
BOOT_B = 400
BOOT_SEED = 20260902
WEEKS = bw.WEEKS
SEASON_NUMBER_RULE = (
    "recency-weighted prior points per game (weights 1:2 over S-2, S-1; >= 6 stat "
    "lines in S-1 required; a player with only S-1 uses it alone) x 17; pool = the "
    "top N per position per season by that number among players with a stat line "
    "in S; rows = the weeks a pooled player has a stat line. FIXED across variants."
)
POLICY = (
    "BACKTEST ONLY. Walk-forward: every input to a (season, week) projection is "
    "restricted to seasons < Y or weeks < wk (Elo pre-week, DvP to date, venue "
    "margins from earlier seasons shrunk with n0 = 16); the observed kickoff-hour "
    "roof/temperature/wind stand in for the unarchived forecast. The book lines in "
    "games_meta are never read. Absent inputs are neutral and counted, never "
    "guessed; skipped rows are counted in meta. v2 ships only if it does not "
    "regress v1 on pooled MAE and pooled rank correlation."
)
NEVER_REGRESS_RULE = ("never-regress: v2 must not be worse than v1 on pooled MAE and "
                      "pooled rank_corr")


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def game_params(tuning_doc):
    """{hfa, k, revert} from data/model_tuning.json game_params; the module
    defaults for anything the file does not carry."""
    gp = (tuning_doc or {}).get("game_params") or {}
    return {"hfa": float(gp.get("hfa_elo", elo_mod.HFA_ELO)),
            "k": float(gp.get("k", elo_mod.K)),
            "revert": float(gp.get("revert", elo_mod.REVERT))}


def load_games(doc):
    """games_meta rows as dicts (fields zipped), team codes canonical, in
    (season, week, kickoff) order. Book columns are carried through untouched
    and never read."""
    fields = doc["fields"]
    rows = []
    for r in doc["games"]:
        g = dict(zip(fields, r))
        g["home"] = bw.norm_team(g["home"])
        g["away"] = bw.norm_team(g["away"])
        g["season"] = int(g["season"])
        g["week"] = int(g["week"])
        rows.append(g)
    rows.sort(key=lambda g: (g["season"], g["week"], str(g.get("kickoff_local_et") or "")))
    return rows


def f_to_c(temp_f):
    return None if temp_f is None else (float(temp_f) - 32.0) * 5.0 / 9.0


def mph_to_kph(wind_mph):
    return None if wind_mph is None else float(wind_mph) * 1.609344


# ---------------------------------------------------------------------------
# As-of state: Elo, venue, DvP
# ---------------------------------------------------------------------------

def elo_pre_week(games, hfa, k, revert):
    """{season: {wk: ratings}} — ratings as they stood BEFORE each week, chained
    from the earliest season (revert_to_mean between seasons, rate_season game by
    game inside one). Weeks with no games snapshot the unchanged state."""
    by_season = {}
    for g in games:
        by_season.setdefault(g["season"], {}).setdefault(g["week"], []).append(g)
    ratings = {}
    out = {}
    for i, season in enumerate(sorted(by_season)):
        if i > 0:
            ratings = elo_mod.revert_to_mean(ratings, revert=revert)
        out[season] = {}
        for wk in range(1, WEEKS + 1):
            out[season][wk] = dict(ratings)
            finals = [{"home": g["home"], "away": g["away"],
                       "home_score": g.get("home_score"), "away_score": g.get("away_score"),
                       "kickoff_utc": str(g.get("kickoff_local_et") or "")}
                      for g in by_season[season].get(wk, [])
                      if g.get("home_score") is not None and g.get("away_score") is not None]
            if finals:
                ratings = elo_mod.rate_season(finals, k=k, hfa=hfa, initial_ratings=ratings)
    return out


def venue_hfa_walk_forward(games, season, n0=VENUE_N0):
    """environment_model-shaped venue_hfa from games_meta seasons < `season`:
    per home team, the mean home margin over its true (non-neutral) home games,
    shrunk toward the league mean margin with n0 pseudo-games. Empty when no
    earlier season exists (every venue then falls to the flat rel = 1.0)."""
    prior = [g for g in games
             if g["season"] < season and not g.get("neutral")
             and g.get("home_score") is not None and g.get("away_score") is not None]
    if not prior:
        return {}
    margins = [float(g["home_score"]) - float(g["away_score"]) for g in prior]
    lam_raw = sum(margins) / len(margins)
    per = {}
    for g, m in zip(prior, margins):
        per.setdefault(g["home"], []).append(m)
    out = {}
    for team, ms in sorted(per.items()):
        n = len(ms)
        shrunk = (n * (sum(ms) / n) + n0 * lam_raw) / (n + n0)
        out[team] = {"avg_home_margin": shrunk, "games": n, "n": n, "low_n": False}
    return out


def dvp_rates_by_week(dvp_doc, season):
    """[None, rates@wk1, ..., rates@wk18]: bw.dvp_rates for every target week of
    `season` on the FULL feed. As-of week wk, target week w reads weeks < min(w,
    wk) — i.e. rates_at[min(w, wk)] — which is exactly what production computes
    when the feed only holds weeks < wk."""
    return [None] + [bw.dvp_rates(dvp_doc, season, w) for w in range(1, WEEKS + 1)]


# ---------------------------------------------------------------------------
# Season number, pool, rows
# ---------------------------------------------------------------------------

def _ppg(lines):
    return sum(float(v[2]) for v in lines.values()) / len(lines)


def season_number(rec, season):
    """The fixed season number for `season`, or None (with the reason) when the
    player has fewer than MIN_PRIOR_GAMES stat lines in S-1."""
    seasons = rec.get("seasons") or {}
    s1 = seasons.get(str(season - 1)) or {}
    s2 = seasons.get(str(season - 2)) or {}
    if len(s1) < MIN_PRIOR_GAMES:
        return None, "prior_games_lt_%d" % MIN_PRIOR_GAMES
    ppg1 = _ppg(s1)
    if s2:
        w2, w1 = PRIOR_WEIGHTS
        ppg = (w2 * _ppg(s2) + w1 * ppg1) / (w2 + w1)
    else:
        ppg = ppg1
    return ppg * GAMES_PER_SEASON, None


def majority_team(lines):
    counts = {}
    for v in lines.values():
        t = bw.norm_team(v[0])
        counts[t] = counts.get(t, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def build_pool(actuals, season, pool=POOL):
    """({pos: [(pid, number, team)]}, excluded_counts) — the top N per position
    by the fixed number, among players with at least one stat line in S."""
    excluded = {"no_stat_line_in_season": 0, "prior_games_lt_%d" % MIN_PRIOR_GAMES: 0,
                "position_out_of_scope": 0}
    cands = {pos: [] for pos in POSITIONS}
    for pid, rec in (actuals.get("players") or {}).items():
        pos = str(rec.get("pos") or "").upper()
        if pos not in cands:
            excluded["position_out_of_scope"] += 1
            continue
        lines = (rec.get("seasons") or {}).get(str(season)) or {}
        if not lines:
            excluded["no_stat_line_in_season"] += 1
            continue
        number, why = season_number(rec, season)
        if number is None:
            excluded[why] += 1
            continue
        cands[pos].append((pid, number, majority_team(lines)))
    out = {}
    for pos in POSITIONS:
        ranked = sorted(cands[pos], key=lambda c: (-c[1], c[0]))
        out[pos] = ranked[:pool[pos]]
    return out, excluded


def build_rows(actuals, games, season, pool=POOL):
    """Player-week rows for one season plus the skip counts. A row is a pooled
    player's stat line whose team and opponent agree with the schedule the split
    is computed on (a traded player's weeks on his other team are skipped, and
    counted, rather than scored against the wrong schedule)."""
    sched_by_team = bw.team_schedule([g for g in games if g["season"] == season])
    pooled, excluded = build_pool(actuals, season, pool)
    skipped = {"team_mismatch": 0, "schedule_mismatch": 0}
    rows = []
    for pos in POSITIONS:
        for pid, number, team in pooled[pos]:
            rec = actuals["players"][pid]
            lines = rec["seasons"][str(season)]
            sched = sched_by_team.get(team, {})
            for wk_s, line in lines.items():
                wk = int(wk_s)
                if bw.norm_team(line[0]) != team:
                    skipped["team_mismatch"] += 1
                    continue
                game = sched.get(wk)
                if game is None or game[0] != bw.norm_team(line[1]):
                    skipped["schedule_mismatch"] += 1
                    continue
                rows.append({"season": season, "week": wk, "pos": pos, "pid": pid,
                             "team": team, "opp": game[0], "home": game[1],
                             "number": number, "actual": float(line[2])})
    return rows, sched_by_team, {"excluded": excluded, "skipped": skipped,
                                 "pooled": {p: len(pooled[p]) for p in POSITIONS}}


# ---------------------------------------------------------------------------
# The two variants
# ---------------------------------------------------------------------------

def split_v1(number, team, sched_by_team, elos):
    """weekly_split_v1, verbatim: base x Elo tilt (every position) x flat venue
    (home 1 + HOME_COEF / away 1 - HOME_COEF), renormalized to `number` over the
    team's scheduled weeks. {wk: pts}."""
    sched = sched_by_team.get(team, {})
    if not sched:
        return {}
    base = number / len(sched)
    raw = {}
    for wk, (opp, home) in sched.items():
        tilt = bw.tilt_factor(elos.get(team, bw.ELO_INIT), elos.get(opp, bw.ELO_INIT))
        venue = 1.0 + bw.HOME_COEF if home else 1.0 - bw.HOME_COEF
        raw[wk] = base * tilt * venue
    total = sum(raw.values())
    scale = number / total if total > 0 else 0.0
    return {wk: v * scale for wk, v in raw.items()}


def split_v2(number, team, sched_by_team, elos, position, factors):
    """weekly_split_v2 through the deployed scripts.build_weekly.player_weeks
    (unrounded). {wk: pts} over the non-bye weeks."""
    weeks = bw.player_weeks(number, team, sched_by_team, elos, round_dp=None,
                            position=position, factors=factors)
    return {w["wk"]: w["pts"] for w in weeks if not w["bye"]}


def asof_factors(season, wk, games, dvp_rates_at, venue_hfa):
    """build_weekly.build_factors as of (season, wk): DvP weeks < wk, venue from
    earlier seasons, the roof nflverse recorded per game, and the observed
    kickoff-hour reading for THIS week's games only as the 'forecast' (the other
    weeks are roof-only, exactly as production sees them)."""
    roof_by_game = {}
    forecast = {}
    for g in games:
        if g["season"] != season:
            continue
        key = f"{season}|{g['week']}|{g['home']}|{g['away']}"
        roof_by_game[key] = g.get("roof")
        if g["week"] == wk and g.get("temp_f") is not None and g.get("wind_mph") is not None:
            forecast[key] = {"temp_c": f_to_c(g["temp_f"]),
                             "wind_kph": mph_to_kph(g["wind_mph"]), "precip_mm": 0.0}
    factors = bw.build_factors(season, None, {"stadiums": {}, "venue_hfa": venue_hfa},
                               {"games": forecast}, roof_by_game=roof_by_game)
    # Pre-fill the per-week DvP cache with the as-of tables (see dvp_rates_by_week).
    for w in range(1, WEEKS + 1):
        factors["dvp_by_week"][w] = dvp_rates_at[min(w, wk)]
    return factors


def project_rows(rows, games, sched_by_team, elo_pre, dvp_rates_at, venue_hfa):
    """Fill v1 / v2 on every row in place; returns the summed neutral counts."""
    counts = {k: 0 for k in bw.NEUTRAL_KEYS}
    by_week = {}
    for r in rows:
        by_week.setdefault((r["season"], r["week"]), []).append(r)
    for (season, wk), group in sorted(by_week.items()):
        elos = elo_pre.get(season, {}).get(wk, {})
        factors = asof_factors(season, wk, games, dvp_rates_at[season], venue_hfa[season])
        cache_v1, cache_v2 = {}, {}
        for r in group:
            k1 = (r["team"], r["number"])
            if k1 not in cache_v1:
                cache_v1[k1] = split_v1(r["number"], r["team"], sched_by_team[season], elos)
            k2 = (r["team"], r["number"], r["pos"])
            if k2 not in cache_v2:
                cache_v2[k2] = split_v2(r["number"], r["team"], sched_by_team[season],
                                        elos, r["pos"], factors)
            r["v1"] = cache_v1[k1][wk]
            r["v2"] = cache_v2[k2][wk]
        for k in counts:
            counts[k] += factors["counts"][k]
    return counts


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _groups(rows):
    g = {}
    for r in rows:
        g.setdefault((r["season"], r["week"], r["pos"]), []).append(r)
    return g


def rank_corr(rows, key, min_group=MIN_GROUP):
    """n-weighted mean within-(season, week, position) Spearman; None if no
    group reaches min_group or yields a correlation."""
    num = den = 0.0
    for members in _groups(rows).values():
        if len(members) < min_group:
            continue
        rho = spearman([(r[key], r["actual"]) for r in members])
        if rho is None:
            continue
        num += rho * len(members)
        den += len(members)
    return (num / den) if den else None


def topk_efficiency(rows, key, topk=TOPK):
    """sum over groups of actual points of the top-K by `key` / sum of actual
    points of the top-K by actual; K = min(K_pos, n // 2). None if no group."""
    num = den = 0.0
    for (_, _, pos), members in _groups(rows).items():
        k = min(topk[pos], len(members) // 2)
        if k < 1:
            continue
        by_proj = sorted(members, key=lambda r: (-r[key], r["pid"]))[:k]
        by_act = sorted(members, key=lambda r: (-r["actual"], r["pid"]))[:k]
        num += sum(r["actual"] for r in by_proj)
        den += sum(r["actual"] for r in by_act)
    return (num / den) if den > 0 else None


def block(rows, key):
    return {"mae": mae([(r[key], r["actual"]) for r in rows]),
            "rank_corr": rank_corr(rows, key),
            "topk": topk_efficiency(rows, key)}


def quantile(values, q):
    """Linear-interpolation quantile (numpy's default); None on empty."""
    s = sorted(values)
    if not s:
        return None
    pos = (len(s) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def conformal_band(rows, key, fit_seasons=BAND_FIT_SEASONS, held_out=HELD_OUT, q=BAND_Q):
    """Split-conformal band: per-position |residual| q-quantile on fit_seasons;
    coverage (share of held-out rows inside +/- that width) and mean half-width
    on held_out. None metrics when either side is empty."""
    widths = {}
    for pos in POSITIONS:
        res = [abs(r[key] - r["actual"]) for r in rows
               if r["season"] in fit_seasons and r["pos"] == pos]
        widths[pos] = quantile(res, q)
    test = [r for r in rows if r["season"] == held_out and widths.get(r["pos"]) is not None]
    if not test:
        return {"coverage_%d" % held_out: None, "half_width_%d" % held_out: None}
    inside = sum(1 for r in test if abs(r[key] - r["actual"]) <= widths[r["pos"]])
    return {"coverage_%d" % held_out: inside / len(test),
            "half_width_%d" % held_out: sum(widths[r["pos"]] for r in test) / len(test)}


def block_bootstrap(rows, held_out=HELD_OUT, b=BOOT_B, seed=BOOT_SEED):
    """Paired (season, week) block bootstrap of MAE(v2) - MAE(v1) on held_out:
    mean and the 2.5 / 97.5 percentiles. Deterministic under `seed`."""
    blocks = {}
    for r in rows:
        if r["season"] == held_out:
            blocks.setdefault((r["season"], r["week"]), []).append(r)
    keys = sorted(blocks)
    if not keys:
        return {"mean": None, "lo95": None, "hi95": None, "blocks": "season-week", "B": b}
    rng = random.Random(seed)
    deltas = []
    for _ in range(b):
        sample = [r for _ in keys for r in blocks[rng.choice(keys)]]
        d2 = sum(abs(r["v2"] - r["actual"]) for r in sample) / len(sample)
        d1 = sum(abs(r["v1"] - r["actual"]) for r in sample) / len(sample)
        deltas.append(d2 - d1)
    return {"mean": sum(deltas) / len(deltas), "lo95": quantile(deltas, 0.025),
            "hi95": quantile(deltas, 0.975), "blocks": "season-week", "B": b}


# ---------------------------------------------------------------------------
# Run + document
# ---------------------------------------------------------------------------

def run(actuals, games_doc, dvp_doc, tuning_doc=None, seasons=SEASONS_SCORED,
        held_out=HELD_OUT, band_fit=BAND_FIT_SEASONS, pool=POOL, boot_b=BOOT_B):
    """The whole harness on in-memory documents. Returns the artifact (minus the
    timestamp) plus the scored rows under "_rows" for tests."""
    t0 = time.time()
    games = load_games(games_doc)
    params = game_params(tuning_doc)
    elo_pre = elo_pre_week(games, params["hfa"], params["k"], params["revert"])

    rows, sched, meta = [], {}, {"excluded": {}, "skipped": {}, "pooled": {}}
    dvp_rates_at, venue_hfa = {}, {}
    for season in seasons:
        s_rows, s_sched, s_meta = build_rows(actuals, games, season, pool)
        rows.extend(s_rows)
        sched[season] = s_sched
        meta["pooled"][str(season)] = s_meta["pooled"]
        for bucket in ("excluded", "skipped"):
            for k, v in s_meta[bucket].items():
                meta[bucket][k] = meta[bucket].get(k, 0) + v
        dvp_rates_at[season] = dvp_rates_by_week(dvp_doc, season)
        venue_hfa[season] = venue_hfa_walk_forward(games, season)
    neutral = project_rows(rows, games, sched, elo_pre, dvp_rates_at, venue_hfa)

    held = [r for r in rows if r["season"] == held_out]
    pooled = {"v1": block(rows, "v1"), "v2": block(rows, "v2")}
    per_position = {}
    for pos in POSITIONS:
        prow = [r for r in rows if r["pos"] == pos]
        per_position[pos] = {v: {"mae": mae([(r[v], r["actual"]) for r in prow]),
                                 "rank_corr": rank_corr(prow, v)} for v in ("v1", "v2")}
    band = {"rule": ("split-conformal %d%% band: per-position |residual| quantile fitted "
                     "on %s, coverage and mean half-width on %d"
                     % (round(BAND_Q * 100), "-".join(str(s) for s in band_fit), held_out)),
            "v1": conformal_band(rows, "v1", band_fit, held_out),
            "v2": conformal_band(rows, "v2", band_fit, held_out)}
    boot = block_bootstrap(rows, held_out, boot_b)

    p1, p2 = pooled["v1"], pooled["v2"]
    measurable = all(x is not None for x in (p1["mae"], p2["mae"], p1["rank_corr"], p2["rank_corr"]))
    adopted = bool(measurable and p2["mae"] <= p1["mae"] and p2["rank_corr"] >= p1["rank_corr"])
    if not measurable:
        reason = "not measurable: a pooled metric is None (too few rows or groups)"
    elif adopted:
        reason = ("v2 beats v1 on pooled MAE (%.3f vs %.3f) and pooled rank_corr (%.3f vs "
                  "%.3f); held-out %d MAE %.3f vs %.3f"
                  % (p2["mae"], p1["mae"], p2["rank_corr"], p1["rank_corr"], held_out,
                     block(held, "v2")["mae"] or float("nan"),
                     block(held, "v1")["mae"] or float("nan")))
    else:
        reason = ("v2 regresses v1: pooled MAE %.3f vs %.3f, pooled rank_corr %.3f vs %.3f"
                  % (p2["mae"], p1["mae"], p2["rank_corr"], p1["rank_corr"]))

    doc = {
        "model_candidate": MODEL_CANDIDATE,
        "model_incumbent": MODEL_INCUMBENT,
        "fixture": {"weekly_actuals": ACTUALS_REL, "games_meta": GAMES_REL,
                    "seasons_scored": list(seasons), "rows": len(rows), "pool": dict(pool)},
        "season_number_rule": SEASON_NUMBER_RULE,
        "pooled": pooled,
        "held_out_%d" % held_out: {"v1": block(held, "v1"), "v2": block(held, "v2")},
        "per_position": per_position,
        "band": band,
        "bootstrap": {"delta_mae_%d" % held_out: boot},
        "factors": {
            "dvp": {"shrink": bw.DVP_SHRINK, "source": "data/dvp_positional_history.json"},
            "elo_tilt_positions": list(bw.ELO_TILT_POSITIONS),
            "weather": {"pass_dome": bw.WEATHER["pass_dome"],
                        "pass_outdoors": bw.WEATHER["pass_outdoors"],
                        "pass_cold_extra": bw.WEATHER["pass_cold_extra"],
                        "rb_wind": bw.WEATHER["rb_wind"], "cold_f": 32, "wind_mph": 15},
            "venue": {"coef": bw.HOME_COEF, "rel_clamp": list(bw.VENUE_REL_CLAMP),
                      "shrink_n0": VENUE_N0},
        },
        "verdict": {"adopted": adopted, "rule": NEVER_REGRESS_RULE, "reason": reason},
        "policy": POLICY,
        "meta": {
            "rows_skipped": meta["skipped"],
            "pool_excluded": meta["excluded"],
            "pooled_per_season": meta["pooled"],
            "neutral_weeks": neutral,
            "game_params": params,
            "elo_chain_from": min(g["season"] for g in games) if games else None,
            "runtime_s": round(time.time() - t0, 2),
        },
        "_rows": rows,
    }
    return doc


def _round(node, dp=4):
    if isinstance(node, float):
        return round(node, dp)
    if isinstance(node, dict):
        return {k: _round(v, dp) for k, v in node.items()}
    if isinstance(node, list):
        return [_round(v, dp) for v in node]
    return node


def artifact(result):
    """The committed document: timestamped, rounded, without the row dump."""
    body = {k: v for k, v in result.items() if k != "_rows"}
    out = {"generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    out.update(_round(body))
    return out


def _fmt(b):
    return "MAE %s / rank_corr %s / topk %s" % tuple(
        ("%.3f" % b[k]) if b.get(k) is not None else "n/a" for k in ("mae", "rank_corr", "topk"))


def report(result, held_out=HELD_OUT):
    print("WEEKLY BACKTEST - walk-forward, %s vs %s, seasons %s, rows %d"
          % (MODEL_CANDIDATE, MODEL_INCUMBENT,
             "-".join(str(s) for s in result["fixture"]["seasons_scored"]),
             result["fixture"]["rows"]))
    for label, blk in (("pooled", result["pooled"]),
                       ("held-out %d" % held_out, result["held_out_%d" % held_out])):
        print("  %-14s v1 %s | v2 %s" % (label, _fmt(blk["v1"]), _fmt(blk["v2"])))
    for pos in POSITIONS:
        pp = result["per_position"][pos]
        print("  %-3s v1 MAE %.3f rank %.3f | v2 MAE %.3f rank %.3f"
              % (pos, pp["v1"]["mae"] or 0, pp["v1"]["rank_corr"] or 0,
                 pp["v2"]["mae"] or 0, pp["v2"]["rank_corr"] or 0))
    band = result["band"]
    for v in ("v1", "v2"):
        print("  band %s coverage %s half-width %s"
              % (v, band[v]["coverage_%d" % held_out], band[v]["half_width_%d" % held_out]))
    bs = result["bootstrap"]["delta_mae_%d" % held_out]
    print("  bootstrap delta MAE(v2-v1) %d: mean %s [%s, %s] (B=%d, season-week blocks)"
          % (held_out, bs["mean"], bs["lo95"], bs["hi95"], bs["B"]))
    m = result["meta"]
    print("  skipped rows %s | pool excluded %s | neutral weeks %s | %.1fs"
          % (m["rows_skipped"], m["pool_excluded"], m["neutral_weeks"], m["runtime_s"]))
    print("  VERDICT: %s - %s" % ("ADOPT" if result["verdict"]["adopted"] else "KEEP v1",
                                  result["verdict"]["reason"]))


# ---------------------------------------------------------------------------
# selftest — synthetic, in memory, exit code only
# ---------------------------------------------------------------------------

def _synthetic():
    """Four teams, seasons 2021-2025 x 6 weeks, eight players per position whose
    weekly points follow a hidden per-player rate plus noise (seeded)."""
    rng = random.Random(7)
    teams = ["AAA", "BBB", "CCC", "DDD"]
    pairings = [[(0, 1), (2, 3)], [(0, 2), (1, 3)], [(0, 3), (1, 2)]]
    roofs = {"AAA": "outdoors", "BBB": "dome", "CCC": "outdoors", "DDD": "closed"}
    fields = ["season", "week", "home", "away", "home_score", "away_score",
              "kickoff_local_et", "roof", "temp_f", "wind_mph", "spread_line_home",
              "home_ml", "away_ml", "home_rest", "away_rest", "neutral", "stadium", "weekday"]
    games = []
    for season in range(2021, 2026):
        for wk in range(1, 7):
            for (h, a) in pairings[(wk - 1) % 3]:
                if wk > 3:
                    h, a = a, h
                home, away = teams[h], teams[a]
                out = roofs[home] == "outdoors"
                games.append([season, wk, home, away, rng.randint(10, 35), rng.randint(7, 31),
                              "%d-10-%02dT13:00" % (season, wk), roofs[home],
                              rng.choice([25.0, 45.0, 70.0]) if out else None,
                              rng.choice([5.0, 12.0, 20.0]) if out else None,
                              None, None, None, 7, 7, False, "Synthetic Field", "Sunday"])
    games_doc = {"fields": fields, "games": games}
    players = {}
    for pos in POSITIONS:
        for i in range(8):
            pid = "%s-%02d" % (pos, i)
            rate = 6.0 + 2.5 * i
            team = teams[i % 4]
            seasons = {}
            for season in range(2022, 2026):
                lines = {}
                for wk in range(1, 7):
                    game = next(g for g in games if g[0] == season and g[1] == wk
                                and team in (g[2], g[3]))
                    opp = game[3] if game[2] == team else game[2]
                    pts = max(0.0, rng.gauss(rate, 4.0))
                    lines[str(wk)] = [team, opp, round(pts, 2), 0.0, 0.0, 0.0]
                seasons[str(season)] = lines
            players[pid] = {"name": pid, "pos": pos, "seasons": seasons}
    actuals = {"players": players}
    dvp_seasons = {}
    for season in range(2021, 2026):
        dvp_seasons[str(season)] = {}
        for t in teams:
            dvp_seasons[str(season)][t] = {
                str(wk): {"def": {p: 15.0 + 4.0 * teams.index(t) for p in POSITIONS}, "g": 1,
                          "off": {p: 0.0 for p in POSITIONS}} for wk in range(1, 7)}
    dvp_doc = {"seasons": dvp_seasons, "renames": {}}
    return actuals, games_doc, dvp_doc


def selftest():
    # --- metric helpers -------------------------------------------------------
    assert quantile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5 and quantile([5.0], 0.68) == 5.0
    assert quantile([], 0.5) is None
    g = [{"season": 2025, "week": 1, "pos": "QB", "pid": str(i), "actual": a, "p": p}
         for i, (a, p) in enumerate([(30, 30), (20, 25), (10, 5), (5, 4), (1, 2)])]
    assert abs(topk_efficiency(g, "p", {"QB": 2}) - 1.0) < 1e-12, "top-2 by proj == top-2 by actual"
    inv = [dict(r, p=-r["p"]) for r in g]
    assert topk_efficiency(inv, "p", {"QB": 2}) < 1.0
    assert topk_efficiency(g[:1], "p", {"QB": 2}) is None, "K < 1 -> no group"
    assert abs(rank_corr(g, "p") - 1.0) < 1e-12
    assert rank_corr(g[:4], "p") is None, "a group under MIN_GROUP is not scored"

    # --- the season-number rule ----------------------------------------------
    rec = {"seasons": {"2023": {str(w): ["A", "B", 10.0, 0, 0, 0] for w in range(1, 11)},
                       "2024": {str(w): ["A", "B", 16.0, 0, 0, 0] for w in range(1, 9)}}}
    n, why = season_number(rec, 2025)
    assert why is None and abs(n - ((1 * 10.0 + 2 * 16.0) / 3) * 17) < 1e-9, n
    only_last = {"seasons": {"2024": rec["seasons"]["2024"]}}
    assert abs(season_number(only_last, 2025)[0] - 16.0 * 17) < 1e-9, "S-1 alone"
    thin = {"seasons": {"2024": {str(w): ["A", "B", 16.0, 0, 0, 0] for w in range(1, 6)}}}
    assert season_number(thin, 2025) == (None, "prior_games_lt_6")
    assert season_number({"seasons": {"2023": rec["seasons"]["2023"]}}, 2025)[0] is None, \
        "S-2 alone is not a number"

    # --- venue shrinkage + Elo chain ----------------------------------------
    actuals, games_doc, dvp_doc = _synthetic()
    games = load_games(games_doc)
    assert venue_hfa_walk_forward(games, 2021) == {}, "no earlier season -> no venue table"
    v = venue_hfa_walk_forward(games, 2023)
    prior = [g for g in games if g["season"] < 2023]
    lam = sum(g["home_score"] - g["away_score"] for g in prior) / len(prior)
    aaa = [g["home_score"] - g["away_score"] for g in prior if g["home"] == "AAA"]
    want = (len(aaa) * (sum(aaa) / len(aaa)) + VENUE_N0 * lam) / (len(aaa) + VENUE_N0)
    assert abs(v["AAA"]["avg_home_margin"] - want) < 1e-9 and v["AAA"]["games"] == len(aaa)
    assert all(g["season"] < 2023 for g in prior), "walk-forward: never the scored season"
    params = game_params({"game_params": {"hfa_elo": 45.0, "k": 25.0, "revert": 0.45}})
    assert params == {"hfa": 45.0, "k": 25.0, "revert": 0.45}
    assert game_params(None)["hfa"] == elo_mod.HFA_ELO
    pre = elo_pre_week(games, **params)
    assert pre[2021][1] == {}, "before the first game every team is at INIT (absent)"
    assert pre[2021][2] and pre[2021][2] != pre[2021][3]
    assert pre[2022][1] != pre[2021][7], "the season boundary reverts toward the mean"
    ratings_end_2021 = pre[2021][WEEKS]
    reverted = elo_mod.revert_to_mean(ratings_end_2021, revert=params["revert"])
    assert all(abs(pre[2022][1][t] - reverted[t]) < 1e-9 for t in reverted)

    # --- rows + pool ----------------------------------------------------------
    rows, sched, meta = build_rows(actuals, games, 2025, pool={p: 5 for p in POSITIONS})
    assert meta["pooled"] == {p: 5 for p in POSITIONS}
    assert len(rows) == 4 * 5 * 6, len(rows)
    assert meta["skipped"] == {"team_mismatch": 0, "schedule_mismatch": 0}
    leaked = json.loads(json.dumps(actuals))
    for p in leaked["players"].values():
        for wk in p["seasons"]["2025"].values():
            wk[2] = 999.0
    rows_l, _, _ = build_rows(leaked, games, 2025, pool={p: 5 for p in POSITIONS})
    assert [r["number"] for r in rows_l] == [r["number"] for r in rows], \
        "the held-out season's actuals never reach the season number"
    assert all(r["actual"] == 999.0 for r in rows_l)

    # --- the whole run, its contract, determinism ----------------------------
    pool = {p: 6 for p in POSITIONS}
    res = run(actuals, games_doc, dvp_doc, {"game_params": {"hfa_elo": 45.0, "k": 25.0,
                                                             "revert": 0.45}},
              seasons=(2023, 2024, 2025), pool=pool, boot_b=50)
    for key in ("model_candidate", "model_incumbent", "fixture", "season_number_rule",
                "pooled", "held_out_2025", "per_position", "band", "bootstrap", "factors",
                "verdict", "policy", "meta"):
        assert key in res, key
    assert res["fixture"]["rows"] == 3 * 4 * 6 * 6
    for v in ("v1", "v2"):
        assert res["pooled"][v]["mae"] is not None and res["pooled"][v]["rank_corr"] is not None
        assert res["pooled"][v]["topk"] is not None
        assert res["band"][v]["coverage_2025"] is not None
    assert isinstance(res["verdict"]["adopted"], bool)
    assert res["verdict"]["adopted"] == (
        res["pooled"]["v2"]["mae"] <= res["pooled"]["v1"]["mae"]
        and res["pooled"]["v2"]["rank_corr"] >= res["pooled"]["v1"]["rank_corr"])
    bs = res["bootstrap"]["delta_mae_2025"]
    assert bs["B"] == 50 and bs["lo95"] <= bs["mean"] <= bs["hi95"]
    # v1 and v2 both renormalize to the SAME season number over the schedule
    r0 = res["_rows"][0]
    elos = elo_pre_week(games, **params)[r0["season"]][r0["week"]]
    s1 = split_v1(r0["number"], r0["team"], sched, elos)
    assert abs(sum(s1.values()) - r0["number"]) < 1e-9
    # an RB's v2 week ignores Elo; a QB's does not
    fx = asof_factors(2025, 3, games, dvp_rates_by_week(dvp_doc, 2025),
                      venue_hfa_walk_forward(games, 2025))
    hot = {"AAA": 1600.0, "BBB": 1300.0, "CCC": 1500.0, "DDD": 1500.0}
    flat = {t: 1500.0 for t in hot}
    rb_a = split_v2(100.0, "AAA", sched, hot, "RB", fx)
    rb_b = split_v2(100.0, "AAA", sched, flat, "RB", fx)
    assert all(abs(rb_a[w] - rb_b[w]) < 1e-9 for w in rb_a)
    qb_a = split_v2(100.0, "AAA", sched, hot, "QB", fx)
    qb_b = split_v2(100.0, "AAA", sched, flat, "QB", fx)
    assert any(abs(qb_a[w] - qb_b[w]) > 1e-6 for w in qb_a)
    assert abs(sum(qb_a.values()) - 100.0) < 1e-9
    again = run(actuals, games_doc, dvp_doc, {"game_params": {"hfa_elo": 45.0, "k": 25.0,
                                                               "revert": 0.45}},
                seasons=(2023, 2024, 2025), pool=pool, boot_b=50)
    a1 = {k: v for k, v in artifact(res).items() if k not in ("generated_utc", "meta")}
    a2 = {k: v for k, v in artifact(again).items() if k not in ("generated_utc", "meta")}
    assert a1 == a2, "the artifact must be deterministic"
    assert "_rows" not in artifact(res)
    print("selftest OK: season number fixed and leak-free, venue/Elo walk-forward, "
          "QB-only tilt through the deployed split, contract keys present, "
          "bootstrap deterministic")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv):
    for path in (ACTUALS_PATH, GAMES_PATH, bw.DVP_PATH):
        if not os.path.exists(path):
            print("WEEKLY BACKTEST: %s is missing; refusing to score a partial corpus"
                  % os.path.relpath(path, _ROOT), file=sys.stderr)
            return 1
    tuning = _load(TUNING_PATH) if os.path.exists(TUNING_PATH) else None
    result = run(_load(ACTUALS_PATH), _load(GAMES_PATH), _load(bw.DVP_PATH), tuning)
    report(result)
    if "--gate" in argv:
        adopted = result["verdict"]["adopted"]
        print("GATE: %s" % ("PASS (v2 does not regress v1)" if adopted
                             else "FAIL (v2 regresses v1 on pooled MAE or rank_corr)"))
        return 0 if adopted else 1
    doc = artifact(result)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(OUT_PATH, _ROOT))
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
