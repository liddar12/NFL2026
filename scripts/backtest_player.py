"""PLAYER-LEVEL walk-forward evaluation harness — the missing half of the gate.

The never-regress gate (scripts/promote_signals.py) measures GAME-level log-loss
only. Every candidate family it knows is a game family. Until this file existed
there was NO player-level measurement anywhere, which meant that under the
project's own rule ("it must improve backtesting") no player signal could be
honestly adopted: there was nothing to measure it with.

WHAT THIS SCORES — the deployed path, not a proxy
-------------------------------------------------
The shipped rest-of-season number a user reads in Lineup / Players / Compare is
produced by exactly three steps:

  1. scripts/scrape/espn_players.build_player_records(PRIOR_SEASON, teams)
     -> {gsis_id, name, team, position, age, injury_status, prior_season_points,
         receptions}
  2. scripts/models/player_projection.project_player(record, ctx, weights)
     -> proj_points = baseline(prior_perf) * PROD over signals of
        (1 + weight * (adj - 1))
  3. scripts/build_weekly.player_weeks(proj_points, ...) splits that season
     number across the 18 weeks and RENORMALIZES the playable weeks so they sum
     back to the season target; app/ros.js rosPoints() then SUMS the remaining
     non-bye weeks.

Step 3 is norm-preserving by construction, so for from_week = 1 and a fully
available player:

        rosPoints(weeks, 1) == project_player(...)["proj_points"]

That identity is what makes an honest season-granularity backtest possible at
all, and this harness does not merely assert it — `path_identity_check()` drives
the REAL build_weekly.player_weeks() and a line-for-line mirror of ros.js
rosPoints() over every evaluated projection and reports the measured maximum
absolute difference in the artifact (`__meta__.path_identity`). So step 2 is
called directly here — the actual deployed function, imported, not reimplemented
— and scoring its output IS scoring the week-1 RoS number the app renders.

This replaces scripts/backtest_ros.py, which is deleted. That script scored a
standalone `ppg * 17 + slope` formula that appears nowhere in the product
(REL15 bug #9). That formula is not gone: it survives here as one of the two
BASELINES the deployed engine has to beat, which is the only honest role it ever
had.

WHAT THIS DOES NOT SCORE — stated plainly, because the previous version's
vagueness here was the bug
--------------------------------------------------------------------------
  * WEEKLY SHAPE. Only the from_week = 1 total is graded. Grading a mid-season
    RoS (from_week > 1) needs per-player WEEKLY actuals, and no such artifact is
    committed (data/player_weekly.json holds 2026 PROJECTIONS, not actuals).
    Nothing here measures start/sit accuracy. Neither the tilt coefficient nor
    the weekly split's own coefficients are graded by scripts/backtest_weekly.py (R51).
  * THE AVAILABILITY REDUCTION (build_weekly mechanic (b)). Blocking weeks for
    an IR/PUP/NFI/suspended player needs the injury report AS IT STOOD in that
    historical week; data/injuries.json is a current snapshot only. Every
    backtested player is therefore projected as fully available.
  * HISTORICAL SIGNAL INPUTS. data/player_history.json carries season totals
    (pts, games, receptions, targets) and nothing else, so the engine runs here
    with a REDUCED input set: no age, no injury status, no O-line, no target
    competition. At the registry's day-zero weights this provably cannot change
    the output (applied = 1 + 0 * (adj - 1) = 1 for every signal, so proj_points
    collapses to the prior_perf baseline regardless of which adjustments could be
    computed), and `signal_audit` in the artifact MEASURES which inputs fire
    rather than claiming anything. Under non-zero --weights it would matter, and
    the harness says so loudly on stderr instead of quietly scoring a fiction.

WALK-FORWARD DISCIPLINE
-----------------------
For each held-out season S in 2022..2025 the engine sees seasons <= S-1 ONLY,
and is scored against season S. Nothing is fitted here — the registry weights
are all 0.0 — so there is no fit set to leak from; the walk-forward split is
enforced anyway (and asserted in --selftest by flipping a season-S actual and
proving the projection for S does not move) so that the harness stays leak-free
the day a candidate weight vector IS fitted.

METRICS, per position (QB/RB/WR/TE), per held-out season and pooled:
  rank : Spearman rho, NDCG@k at the 12-team starter cutoffs
  error: MAE and RMSE in season fantasy points
against two baselines that BOTH have to be beaten:
  last_year : prior-season point total (the naive "last year's finish")
  ppg17     : the retired backtest_ros formula — games-weighted per-game scoring
              over the last two prior seasons, reprojected to 17 games, plus a
              damped own-trajectory slope

OUTPUT
  data/player_backtest.json  (data/contracts/player_backtest.schema.json)
  data/ros_backtest.json     (unchanged contract; the season rank-correlation
                              view, now sourced from the DEPLOYED engine instead
                              of the retired proxy)

Stdlib only. --selftest validates the math on fixtures and never writes.
"""

import datetime as dt
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_weekly                                    # noqa: E402
from scripts.models import player_projection as pp_mod             # noqa: E402
from scripts.models.player_projection import (                      # noqa: E402
    compute_raw_signals,
    project_player,
)
from scripts.signals.registry import SIGNALS                        # noqa: E402

DATA = os.path.join(_ROOT, "data")
HISTORY_PATH = os.path.join(DATA, "player_history.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
STRENGTH_PATH = os.path.join(DATA, "team_strength.json")
OUT_PATH = os.path.join(DATA, "player_backtest.json")
LEGACY_PATH = os.path.join(DATA, "ros_backtest.json")

EVAL_SEASONS = (2022, 2023, 2024, 2025)
POSITIONS = ("QB", "RB", "WR", "TE")
STARTER_K = {"QB": 12, "RB": 24, "WR": 36, "TE": 12}
MIN_GAMES = 6          # ignore tiny-sample fluke seasons on the ACTUAL side
GAMES_FULL = 17
MIN_ROWS = 3           # fewer than this and a rank correlation is meaningless
MARGIN = 0.0           # a baseline must be strictly out-ranked to count as beaten

# build_weekly rounds each week to 2dp and app/ros.js rounds the sum to 1dp, so
# the split->sum round trip cannot be exact to the cent. 18 weeks * 0.005 + 0.05
# bounds the loss; anything above this tolerance means the identity BROKE (a real
# regression), not that rounding drifted.
PATH_IDENTITY_TOL = 0.15


# ---------------------------------------------------------------------------
# Metrics (stdlib only — no numpy, no scipy).
# ---------------------------------------------------------------------------

def spearman(pairs):
    """Spearman rank correlation for [(x, y), ...]; None if < 3 points."""
    n = len(pairs)
    if n < MIN_ROWS:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]

    def ranks(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        r = [0.0] * len(vals)
        i = 0
        while i < len(vals):
            j = i
            while j + 1 < len(vals) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0            # average rank for ties (1-based)
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx = sum(rx) / n
    my = sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ry[i] - my) ** 2 for i in range(n)))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def ndcg(ranked_actuals, k):
    """NDCG@k. `ranked_actuals` is the ACTUAL points list ordered by the
    projection under test (best-projected first)."""
    k = min(k, len(ranked_actuals))
    if k == 0:
        return None

    def dcg(vals):
        return sum(v / math.log2(i + 2) for i, v in enumerate(vals[:k]))

    idcg = dcg(sorted(ranked_actuals, reverse=True))
    return (dcg(ranked_actuals) / idcg) if idcg > 0 else None


def mae(pairs):
    """Mean absolute error over [(pred, actual), ...]; None if empty."""
    if not pairs:
        return None
    return sum(abs(p - a) for p, a in pairs) / len(pairs)


def rmse(pairs):
    """Root mean squared error over [(pred, actual), ...]; None if empty."""
    if not pairs:
        return None
    return math.sqrt(sum((p - a) ** 2 for p, a in pairs) / len(pairs))


# ---------------------------------------------------------------------------
# Baselines. `ppg17` is scripts/backtest_ros.py's retired formula, verbatim in
# behaviour — demoted from "the projection under test" to what it always was: a
# baseline the deployed engine has to beat.
# ---------------------------------------------------------------------------

def baseline_ppg17(priors):
    """Games-weighted recent-form season projection from priors ONLY.

    priors: [{yr, pts, games}] ascending by yr, all with yr <= S-1. Returns
    projected full-season points, or None when no prior season had games."""
    usable = [s for s in priors if s.get("games")]
    if not usable:
        return None
    recent = usable[-2:]                          # last up-to-2 prior seasons
    weights = [1.0, 2.0][-len(recent):]           # recency-weighted 2:1
    ppg = (sum(w * (s["pts"] / s["games"]) for w, s in zip(weights, recent))
           / sum(weights))
    base = ppg * GAMES_FULL
    if len(usable) >= 2:                          # damped own-trajectory slope
        ys = list(range(len(usable)))
        ts = [s["pts"] for s in usable]
        my = sum(ys) / len(ys)
        mt = sum(ts) / len(ts)
        denom = sum((y - my) ** 2 for y in ys)
        slope = (sum((ys[i] - my) * (ts[i] - mt) for i in range(len(ys))) / denom
                 ) if denom else 0.0
        base += 0.25 * slope
    return max(0.0, base)


# ---------------------------------------------------------------------------
# Walk-forward record construction.
# ---------------------------------------------------------------------------

def build_rows(history, season, include_candidate_inputs=True):
    """Rows for held-out `season`, each carrying the ENGINE INPUT RECORD built
    from seasons <= season-1 only, plus that season's actual.

    The record mirrors scripts/scrape/espn_players.build_player_records field for
    field. `age` and `injury_status` are absent because the historical substrate
    has neither — see the module docstring; at day-zero weights their absence
    provably cannot move proj_points.

    include_candidate_inputs adds `games_missed_rate` (derivable from the
    substrate: 1 - games/17 averaged over priors). It is NOT fed by the deployed
    record builder today, so it is labelled a CANDIDATE input: it exists so a
    future injury_history weight can be evaluated here before anyone gives it
    weight. At weight 0.0 it changes nothing.

    Returns (rows, excluded) where excluded counts season-`season` players with
    no season-(season-1) line at all — the engine cannot rank them, and pretending
    otherwise would be the fabrication the project forbids.
    """
    rows = []
    excluded = 0
    for pid, rec in sorted((history.get("players") or {}).items()):
        pos = str(rec.get("position") or "").upper()
        if pos not in POSITIONS:
            continue
        seasons = sorted(rec.get("seasons") or [], key=lambda s: s["yr"])
        priors = [s for s in seasons if s["yr"] <= season - 1]
        assert all(s["yr"] < season for s in priors), "walk-forward violation"
        actual = next((s for s in seasons if s["yr"] == season), None)
        if not actual or not actual.get("games") or actual["games"] < MIN_GAMES:
            continue
        last = next((s for s in priors if s["yr"] == season - 1), None)
        if last is None:
            excluded += 1
            continue
        record = {
            "gsis_id": pid,
            "name": rec.get("name", ""),
            "team": "",                       # unknown historically; unused at w=0
            "position": pos,
            "prior_season_points": float(last["pts"]),
            "receptions": last.get("receptions"),
            # R49 — the games-normalized baseline inputs, exactly as
            # build_predictions._stamp_prior_seasons supplies them live: every
            # prior season line (yr <= S-1) with its game count. No absence is
            # knowable historically, so projected_games is 17 for everyone here.
            "prior_games": int(last["games"]) if last.get("games") else None,
            "prior_seasons": [{"yr": s["yr"], "pts": float(s["pts"]),
                               "games": s.get("games")} for s in priors],
        }
        if include_candidate_inputs:
            played = [s for s in priors if s.get("games")]
            if played:
                missed = sum(max(0.0, 1.0 - s["games"] / GAMES_FULL) for s in played)
                record["games_missed_rate"] = round(missed / len(played), 4)
        rows.append({
            "pos": pos,
            "record": record,
            "actual": float(actual["pts"]),
            "last_year": float(last["pts"]),
            "ppg17": baseline_ppg17(priors),
        })
    return rows, excluded


def engine_projection(record, weights=None):
    """The DEPLOYED projection for one record — project_player, imported."""
    return project_player(record, ctx=None, weights=weights)["proj_points"]


# ---------------------------------------------------------------------------
# The deployed-path identity: split -> sum == the season projection.
# ---------------------------------------------------------------------------

def ros_points_mirror(weeks, from_week=1):
    """Line-for-line mirror of app/ros.js rosPoints() at its zero-weight defaults:
    sum the non-bye weeks from `from_week` on, round to 1dp."""
    total = 0.0
    for w in weeks:
        if w.get("bye"):
            continue
        if int(w["wk"]) < int(from_week):
            continue
        total += float(w.get("pts") or 0.0)
    return round(total * 10) / 10.0


def _synthetic_schedule():
    """A minimal two-team schedule with one bye each — used by --selftest so the
    identity check runs offline with no committed data file."""
    games = []
    for wk in range(1, 19):
        if wk == 9:                                  # both teams idle -> bye
            continue
        games.append({"week": wk, "home": "AAA", "away": "BBB"})
    return games


def path_identity_check(projections, schedule_games, elos):
    """MEASURE (never assert) that the deployed split+sum round-trips a season
    projection: build_weekly.player_weeks() -> ros.js rosPoints() == proj_points.

    projections: [float]. Returns the measured summary that goes into __meta__.
    """
    sched_by_team = build_weekly.team_schedule(schedule_games)
    teams = sorted(sched_by_team)
    if not teams or not projections:
        return {"checked": 0, "max_abs_diff": None, "tolerance": PATH_IDENTITY_TOL,
                "holds": False, "note": "no schedule or no projections to check"}
    worst = 0.0
    for i, proj in enumerate(projections):
        team = teams[i % len(teams)]
        weeks = build_weekly.player_weeks(proj, team, sched_by_team, elos)
        worst = max(worst, abs(ros_points_mirror(weeks, 1) - round(proj, 1)))
    return {
        "checked": len(projections),
        "max_abs_diff": round(worst, 4),
        "tolerance": PATH_IDENTITY_TOL,
        "holds": worst <= PATH_IDENTITY_TOL,
        "note": "build_weekly.player_weeks() split then app/ros.js rosPoints() "
                "sum, measured against project_player()'s season projection; "
                "difference is week-level 2dp + sum-level 1dp rounding only",
    }


# ---------------------------------------------------------------------------
# Scoring.
# ---------------------------------------------------------------------------

def score_rows(rows, pos, weights=None):
    """Score one position's rows. Returns the per-position metric block."""
    scored = [r for r in rows
              if r["pos"] == pos and r["ppg17"] is not None]
    if len(scored) < MIN_ROWS:
        return {"n": len(scored), "measured": False, "skipped": "too_few_players"}

    for r in scored:
        r["engine"] = engine_projection(r["record"], weights)

    k = STARTER_K[pos]
    out = {"n": len(scored), "measured": True}
    for name, key in (("engine", "engine"),
                      ("last_year", "last_year"),
                      ("ppg17", "ppg17")):
        pairs = [(r[key], r["actual"]) for r in scored]
        rho = spearman(pairs)
        by_proj = [r["actual"] for r in sorted(scored, key=lambda r: -r[key])]
        out["rho_" + name] = None if rho is None else round(rho, 4)
        nd = ndcg(by_proj, k)
        out["ndcg_" + name] = None if nd is None else round(nd, 4)
        out["mae_" + name] = round(mae(pairs), 3)
        out["rmse_" + name] = round(rmse(pairs), 3)

    out["beats_last_year"] = (out["rho_engine"] is not None
                              and out["rho_last_year"] is not None
                              and out["rho_engine"] > out["rho_last_year"] + MARGIN)
    out["beats_ppg17"] = (out["rho_engine"] is not None
                          and out["rho_ppg17"] is not None
                          and out["rho_engine"] > out["rho_ppg17"] + MARGIN)
    # MEASURED, not claimed: at day-zero weights under the shipped TOTAL rule
    # proj_points IS the prior-season total, so the engine and the last_year
    # baseline are literally the same numbers and every delta below must be
    # exactly 0. (R49: under the games-normalized rule this would be false for
    # every sub-17-game season — which is why it is measured, not asserted.)
    out["engine_equals_last_year"] = all(
        abs(r["engine"] - r["last_year"]) < 1e-9 for r in scored)
    # R49 owner override: the engine's proj_points is the candidate, so the
    # gate-conforming series is scored beside it (measured, never assumed equal).
    gated_pairs = [(project_player(r["record"], ctx=None, weights=weights)["gated_points"],
                    r["actual"]) for r in scored]
    grho = spearman(gated_pairs)
    out["rho_gated"] = None if grho is None else round(grho, 4)
    out["mae_gated"] = round(mae(gated_pairs), 3)
    return out


# A record carrying every input compute_raw_signals() looks at. Used to MEASURE
# which signals the engine actually implements, so the audit below never has to
# hardcode (and never has to guess) that list.
_PROBE_RECORD = {
    "gsis_id": "probe", "name": "Probe", "team": "PRB", "position": "WR",
    "age": 26,
    "ol": {"mass_lbs_avg": 315.0, "strength_grade": 60.0, "continuity_games": 40},
    "dl_faced": [{"strength_grade": 55.0, "mass_lbs_avg": 300.0}],
    "team_target_share": 0.24,
    "teammate_shares": [0.18, 0.12],
    "injury_status": "Questionable",
    "games_missed_rate": 0.2,
    "prior_season_points": 200.0,
}
_PROBE_CTX = {"teams": {"teams": [{"abbrev": "PRB", "roof": "indoor"}]}}


def signal_audit(rows):
    """Which projection signals this substrate can actually feed — all MEASURED
    by running the engine's own compute_raw_signals(), nothing asserted.

      engine_implements   : signals that fire for a fully-populated probe record
                            (i.e. the engine has a branch for them at all)
      deployed_inputs_fire: signals that fire from the record shape the DEPLOYED
                            builder supplies here (season totals only)
      candidate_inputs_fire: signals that additionally fire from the candidate
                            inputs this harness derives from history
      substrate_missing   : implemented, but their inputs are not in the
                            substrate — no player-level evidence for them can be
                            produced until a richer history is committed
      registry_only       : declared in the signal registry with NO engine branch
                            at all; nothing here or anywhere computes them today
    """
    deployed = set()
    candidate = set()
    for r in rows[:400]:
        rec = dict(r["record"])
        cand = rec.pop("games_missed_rate", None)
        deployed |= set(compute_raw_signals(rec))
        if cand is not None:
            rec["games_missed_rate"] = cand
        candidate |= set(compute_raw_signals(rec))
    implements = set(compute_raw_signals(dict(_PROBE_RECORD), _PROBE_CTX))
    player_signals = {n for n, s in SIGNALS.items() if s.get("group") == "player"}
    # prior_perf is the BASELINE itself, not a multiplicative adjustment, so it
    # never appears in compute_raw_signals — it is fed here as
    # prior_season_points and is the only player signal this harness does feed.
    baseline = {"prior_perf"} & player_signals
    return {
        "player_signals_in_registry": len(player_signals),
        "baseline_fed": sorted(baseline),
        "engine_implements": sorted(implements),
        "deployed_inputs_fire": sorted(deployed),
        "candidate_inputs_fire": sorted(candidate - deployed),
        "substrate_missing": sorted(implements - candidate),
        "registry_only": sorted(player_signals - implements - baseline),
        "note": "MEASURED, not declared. Only baseline_fed + "
                "deployed_inputs_fire + candidate_inputs_fire carry any "
                "player-level evidence here; substrate_missing needs a richer "
                "committed history and registry_only has no engine branch at "
                "all. At day-zero weights (all 0.0) none of this can change "
                "proj_points.",
    }


# ---------------------------------------------------------------------------
# R49 — the baseline gate and the candidate machinery, measured.
# ---------------------------------------------------------------------------

def _pooled(blocks, key):
    """n-weighted pool of a per-position metric over measured blocks."""
    m = [(b["n"], b[key]) for b in blocks.values() if b.get("measured") and b.get(key) is not None]
    n = sum(x[0] for x in m)
    return round(sum(x[0] * x[1] for x in m) / n, 4) if n else None


def baseline_gate(history, weights=None):
    """NEVER-REGRESS verdict on the games-normalized baseline for the SHIPPED
    number: the same walk-forward, with `proj_points` built under
    BASELINE_RULE_PPG (prior_ppg x 17; no historical absence) versus the
    incumbent total rule. Adopted for shipped ONLY when it beats the incumbent on
    BOTH pooled rank-corr and pooled MAE. Pure given the history."""
    def scored(rule):
        pooled_rows = {p: [] for p in POSITIONS}
        for season in EVAL_SEASONS:
            rows, _ = build_rows(history, season)
            for r in rows:
                # The rule under test applies to the GATED series (proj_points is
                # the candidate under the R49 owner override, whatever the rule).
                r["engine"] = project_player(r["record"], ctx=None, weights=weights,
                                             baseline_rule=rule)["gated_points"]
                if r["ppg17"] is not None:
                    pooled_rows[r["pos"]].append(r)
        out = {}
        for pos in POSITIONS:
            rs = pooled_rows[pos]
            if len(rs) < MIN_ROWS:
                out[pos] = {"n": len(rs), "measured": False}
                continue
            pairs = [(r["engine"], r["actual"]) for r in rs]
            rho = spearman(pairs)
            out[pos] = {"n": len(rs), "measured": True,
                        "rho": None if rho is None else round(rho, 4),
                        "mae": round(mae(pairs), 3)}
        return out
    total, ppg = scored(pp_mod.BASELINE_RULE_TOTAL), scored(pp_mod.BASELINE_RULE_PPG)
    rho_t, rho_p = _pooled(total, "rho"), _pooled(ppg, "rho")
    mae_t, mae_p = _pooled(total, "mae"), _pooled(ppg, "mae")
    both = (rho_t is not None and rho_p is not None and mae_t is not None
            and mae_p is not None and rho_p > rho_t and mae_p < mae_t)
    reason = ("games-normalized rule beats the total rule on BOTH pooled rank-corr "
              "(%s -> %s) and pooled MAE (%s -> %s)" % (rho_t, rho_p, mae_t, mae_p)
              if both else
              "NEVER REGRESS for the shipped number: pooled rank-corr %s -> %s, pooled "
              "MAE %s -> %s — the per-game rule must improve BOTH to replace "
              "prior_season_points; it ships as the CANDIDATE baseline instead"
              % (rho_t, rho_p, mae_t, mae_p))
    # R49 owner override — the walk-forward comparison that now matters: the
    # CANDIDATE (what ships) vs the GATED number, both through project_player.
    def series(rows_key):
        pooled_rows = {p: [] for p in POSITIONS}
        for season in EVAL_SEASONS:
            rows, _ = build_rows(history, season)
            for r in rows:
                if r["ppg17"] is None:
                    continue
                out = project_player(r["record"], ctx=None, weights=weights)
                r["engine"] = out[rows_key]
                pooled_rows[r["pos"]].append(r)
        out = {}
        for pos in POSITIONS:
            rs = pooled_rows[pos]
            if len(rs) < MIN_ROWS:
                out[pos] = {"n": len(rs), "measured": False}
                continue
            pairs = [(r["engine"], r["actual"]) for r in rs]
            rho = spearman(pairs)
            out[pos] = {"n": len(rs), "measured": True,
                        "rho": None if rho is None else round(rho, 4),
                        "mae": round(mae(pairs), 3)}
        return out
    cand_s, gated_s = series("candidate_points"), series("gated_points")
    cvg = {
        "shipped_estimate": pp_mod.SHIPPED_ESTIMATE,
        "owner_override": pp_mod.SHIPPED_ESTIMATE == "candidate",
        "pooled_rho_gated": _pooled(gated_s, "rho"),
        "pooled_rho_candidate": _pooled(cand_s, "rho"),
        "pooled_mae_gated": _pooled(gated_s, "mae"),
        "pooled_mae_candidate": _pooled(cand_s, "mae"),
        "per_position": {
            pos: {"n": gated_s[pos]["n"],
                  "rho_gated": gated_s[pos].get("rho"),
                  "rho_candidate": cand_s[pos].get("rho"),
                  "mae_gated": gated_s[pos].get("mae"),
                  "mae_candidate": cand_s[pos].get("mae")}
            for pos in POSITIONS},
        "note": ("walk-forward 2022-2025, season granularity; the candidate here "
                 "carries only the signals the committed history can feed "
                 "(injury_history) — its live signals (age, status, roof) are not "
                 "evaluable on this substrate"),
    }
    return {
        "shipped_rule": pp_mod.SHIPPED_BASELINE_RULE,
        "candidate_rule": pp_mod.BASELINE_RULE_PPG,
        "adopted_for_shipped": bool(both),
        "reason": reason,
        "candidate_vs_gated": cvg,
        "pooled_rho_total_rule": rho_t,
        "pooled_rho_ppg_rule": rho_p,
        "pooled_mae_total_rule": mae_t,
        "pooled_mae_ppg_rule": mae_p,
        "per_position": {
            pos: {"n": total[pos]["n"],
                  "rho_total_rule": total[pos].get("rho"),
                  "rho_ppg_rule": ppg[pos].get("rho"),
                  "mae_total_rule": total[pos].get("mae"),
                  "mae_ppg_rule": ppg[pos].get("mae")}
            for pos in POSITIONS},
    }


CANDIDATE_SEASON = 2025


def candidate_2025(history, sleeper_totals=None, sleeper_note=None, season=CANDIDATE_SEASON):
    """Last year's projected vs actual through the CANDIDATE machinery.

    2024 priors -> 2025 actuals, season granularity, the same rows the harness
    scores. Three numbers per player: baseline (prior_ppg x 17, no signal),
    candidate (baseline x every raw signal this substrate can feed at full
    strength — project_player's candidate_points) and shipped (the total rule).
    Signals the substrate CANNOT feed are named in signals_not_evaluable — they
    are absent from the candidate, never assumed neutral. `sleeper_totals`
    ({app_id: season pts_ppr}) is a DISPLAY-ONLY reference, never an input.
    """
    rows, _ = build_rows(history, season)
    per = []
    evaluated = set()
    for r in rows:
        rec = dict(r["record"])
        out = project_player(rec, ctx=None, weights=None)
        evaluated |= set(out["candidate_signals"].keys())
        per.append({"pos": r["pos"], "pid": rec["gsis_id"], "actual": r["actual"],
                    "baseline": out["candidate_baseline"], "candidate": out["candidate_points"],
                    "low": out["candidate_low"], "high": out["candidate_high"],
                    "shipped": out["proj_points"], "gated": out["gated_points"]})

    def block(rs):
        n = len(rs)
        if not n:
            return {"n": 0, "baseline_mae": None, "candidate_mae": None,
                    "shipped_mae": None, "gated_mae": None, "band_coverage": None,
                    "sleeper_mae": None, "sleeper_n": None}
        b = {"n": n,
             "baseline_mae": round(sum(abs(x["baseline"] - x["actual"]) for x in rs) / n, 3),
             "candidate_mae": round(sum(abs(x["candidate"] - x["actual"]) for x in rs) / n, 3),
             "shipped_mae": round(sum(abs(x["shipped"] - x["actual"]) for x in rs) / n, 3),
             "gated_mae": round(sum(abs(x["gated"] - x["actual"]) for x in rs) / n, 3),
             "band_coverage": round(sum(1 for x in rs if x["low"] <= x["actual"] <= x["high"])
                                    / n, 4)}
        sl = [(sleeper_totals[x["pid"]], x["actual"]) for x in rs
              if sleeper_totals and x["pid"] in sleeper_totals]
        b["sleeper_mae"] = round(sum(abs(p - a) for p, a in sl) / len(sl), 3) if sl else None
        b["sleeper_n"] = len(sl) if sleeper_totals else None
        return b

    total = block(per)
    probe = set(compute_raw_signals(dict(_PROBE_RECORD), _PROBE_CTX))
    player_signals = {n for n, sg in SIGNALS.items() if sg.get("group") == "player"}
    not_evaluable = sorted((probe - evaluated) | (player_signals - probe - {"prior_perf"}))
    pairs_b = [(x["baseline"], x["actual"]) for x in per]
    pairs_c = [(x["candidate"], x["actual"]) for x in per]
    pairs_s = [(x["shipped"], x["actual"]) for x in per]
    pairs_g = [(x["gated"], x["actual"]) for x in per]
    rho = lambda pairs: (None if spearman(pairs) is None else round(spearman(pairs), 4))  # noqa: E731
    return {
        "season": season,
        "players": len(per),
        "shipped_estimate": pp_mod.SHIPPED_ESTIMATE,
        "baseline_mae": total["baseline_mae"],
        "candidate_mae": total["candidate_mae"],
        "shipped_mae": total["shipped_mae"],
        "gated_mae": total["gated_mae"],
        "baseline_rho": rho(pairs_b),
        "candidate_rho": rho(pairs_c),
        "shipped_rho": rho(pairs_s),
        "gated_rho": rho(pairs_g),
        "band_coverage": total["band_coverage"],
        "band_multiplier": pp_mod.CANDIDATE_BAND_MULTIPLIER,
        "band_target": pp_mod.CANDIDATE_BAND_TARGET,
        "band_rule": pp_mod.CANDIDATE_SD_RULE,
        "signals_evaluated": sorted(evaluated),
        "signals_not_evaluable": not_evaluable,
        "by_position": {pos: block([x for x in per if x["pos"] == pos]) for pos in POSITIONS},
        "sleeper_mae": total["sleeper_mae"],
        "sleeper_players": total["sleeper_n"],
        "sleeper_note": sleeper_note or (
            "Sleeper's own %d weekly projections (projections/nfl/%d/{week}, weeks "
            "1-18) summed per player and joined by the same exact crosswalk as "
            "data/sleeper_projections.json — DISPLAY-ONLY reference, never an input"
            % (season, season) if sleeper_totals else
            "Sleeper %d projections not retrieved this run (network/requests "
            "unavailable, or --no-sleeper): no reference MAE" % season),
    }


def sleeper_reference(season=CANDIDATE_SEASON, history=None):
    """({app_id: season pts_ppr}, note) from Sleeper's OWN projections for
    `season`, through scripts.build_sleeper_projections' exact crosswalk against
    the history's player ids. Returns (None, why) when not retrievable."""
    try:
        from scripts import build_sleeper_projections as bsp  # noqa: PLC0415
        dump_index = bsp.build_dump_index(bsp.fetch_dump())
        rows_by_week = bsp.fetch_rows_by_week(season)
    except Exception as exc:  # noqa: BLE001 — a reference, never a failure
        return None, ("Sleeper %d projections not retrievable (%s: %s)"
                      % (season, exc.__class__.__name__, exc))
    pool = [{"gsis_id": pid, "name": rec.get("name"), "team": None,
             "position": rec.get("position")}
            for pid, rec in (history or {}).get("players", {}).items()]
    doc = bsp.build_document(rows_by_week, dump_index, bsp.build_pool_index(pool, []),
                             season, "n/a")
    totals = bsp.season_totals(doc)
    return totals, ("Sleeper %d weekly projections (category 'proj', Rotowire) summed "
                    "over weeks 1-18, %d history players matched by %s — DISPLAY-ONLY "
                    "reference, never an input. NOT LIKE-FOR-LIKE: each week's number "
                    "was made that week, so injuries, benchings and role changes are "
                    "already known to it; a preseason season-long projection cannot "
                    "know them, and the gap flatters Sleeper by construction."
                    % (season, len(totals), doc["match"]["by_method"]))


def run(history, weights=None, schedule_games=None, elos=None):
    """The whole walk-forward evaluation. Pure given its inputs."""
    per_season = []
    pooled_rows = {p: [] for p in POSITIONS}
    all_projections = []
    audit_rows = []
    excluded_total = 0
    scored_total = 0

    for season in EVAL_SEASONS:
        rows, excluded = build_rows(history, season)
        excluded_total += excluded
        audit_rows.extend(rows)
        entry = {
            "season": season,
            "held_out": season,
            "fit_seasons": "<= %d" % (season - 1),
            "excluded_no_prior_season": excluded,
            "positions": {},
        }
        for pos in POSITIONS:
            block = score_rows(rows, pos, weights)
            entry["positions"][pos] = block
            if block.get("measured"):
                scored_total += block["n"]
                pooled_rows[pos].extend(
                    r for r in rows if r["pos"] == pos and r["ppg17"] is not None)
        per_season.append(entry)
        all_projections.extend(r["engine"] for r in rows if "engine" in r)

    pooled = {}
    for pos in POSITIONS:
        block = score_rows(pooled_rows[pos], pos, weights)
        if block.get("measured"):
            block["delta_vs_last_year"] = round(
                block["rho_engine"] - block["rho_last_year"], 4)
            block["delta_vs_ppg17"] = round(
                block["rho_engine"] - block["rho_ppg17"], 4)
        pooled[pos] = block

    measured = [b for b in pooled.values() if b.get("measured")]
    summary = {
        "positions_scored": len(measured),
        "engine_beats_last_year": sum(1 for b in measured if b["beats_last_year"]),
        "engine_beats_ppg17": sum(1 for b in measured if b["beats_ppg17"]),
        "player_seasons_scored": scored_total,
        "player_seasons_excluded_no_prior": excluded_total,
        "engine_equals_last_year_everywhere": all(
            b["engine_equals_last_year"] for b in measured) if measured else False,
    }
    identity = path_identity_check(
        all_projections,
        schedule_games if schedule_games is not None else _synthetic_schedule(),
        elos or {})
    return {
        "per_season": per_season,
        "pooled": pooled,
        "summary": summary,
        "signal_audit": signal_audit(audit_rows),
        "path_identity": identity,
    }


# ---------------------------------------------------------------------------
# Documents.
# ---------------------------------------------------------------------------

def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _nonzero_weights(weights):
    src = weights if weights is not None else {
        n: float(s["weight"]) for n, s in SIGNALS.items()}
    return {k: float(v) for k, v in sorted(src.items()) if float(v) != 0.0}


def build_document(result, weights, schedule_source, gate=None, candidate=None):
    """data/player_backtest.json, valid vs its contract."""
    nonzero = _nonzero_weights(weights)
    doc = {
        "__meta__": {
            "generated_utc": _now(),
            "method": "walk_forward_season_holdout",
            "granularity": "season",
            "engine": "scripts.models.player_projection.project_player",
            "engine_path": "espn_players.build_player_records -> project_player "
                           "-> build_weekly.player_weeks -> app/ros.js "
                           "rosPoints(from_week=1)",
            "baseline_rule_scored": pp_mod.SHIPPED_BASELINE_RULE,
            "substrate": "data/player_history.json (season totals 2021-2025)",
            "eval_seasons": list(EVAL_SEASONS),
            "min_games": MIN_GAMES,
            "baselines": ["last_year (prior-season point total)",
                          "ppg17 (retired backtest_ros formula: games-weighted "
                          "2-season ppg * 17 + damped trajectory slope)"],
            "weights_source": "override" if weights is not None else "registry",
            "nonzero_weights": nonzero,
            "schedule_source": schedule_source,
            "path_identity": result["path_identity"],
            "approximations": [
                "WEEKLY SHAPE IS NOT GRADED HERE: only the from_week=1 RoS total is "
                "scored. Start/sit accuracy and the weekly split's factors are graded "
                "by scripts/backtest_weekly.py (R51) on data/fixtures/backtest_weekly/.",
                "AVAILABILITY REDUCTION IS NOT GRADED: build_weekly mechanic (b) "
                "needs the historical week's injury report, which is not "
                "committed; every backtested player is projected fully available.",
                "REDUCED INPUT SET: the substrate has no age, injury status, "
                "O-line or target-competition history, so those engine inputs are "
                "absent. At day-zero weights applied = 1 + 0*(adj-1) = 1, so this "
                "provably cannot change proj_points; under non-zero weights it "
                "would, and the run warns on stderr.",
            ],
        },
        "per_season": result["per_season"],
        "pooled": result["pooled"],
        "summary": result["summary"],
        "signal_audit": result["signal_audit"],
    }
    if gate is not None:
        doc["baseline_gate"] = gate
    if candidate is not None:
        doc["candidate_2025"] = candidate
    return doc


def build_legacy_document(result):
    """data/ros_backtest.json — the season rank-correlation view kept alive for
    its existing contract and consumers, but now sourced from the DEPLOYED
    engine (project_player) instead of the retired standalone proxy."""
    def view(block):
        if not block.get("measured"):
            return {"n": block["n"], "measured": False,
                    "rho_ros": None, "rho_lastyear": None,
                    "beats_baseline": False}
        out = {
            "n": block["n"],
            "rho_ros": block["rho_engine"],
            "rho_lastyear": block["rho_last_year"],
            "ndcg_ros": block["ndcg_engine"],
            "ndcg_lastyear": block["ndcg_last_year"],
            "beats_baseline": block["beats_last_year"],
            "measured": True,
        }
        if "delta_vs_last_year" in block:
            out["delta"] = block["delta_vs_last_year"]
        return out

    per_season = [
        {"season": e["season"],
         "positions": {p: view(b) for p, b in e["positions"].items()}}
        for e in result["per_season"]
    ]
    pooled = {p: view(b) for p, b in result["pooled"].items() if b.get("measured")}
    return {
        "__meta__": {
            "generated_utc": _now(),
            "method": "deployed_engine_season_rank_correlation",
            "granularity": "season",
            "baseline": "prior_season_points (last year's finish)",
            "note": "Walk-forward: season S projected from seasons <= S-1 only, "
                    "through the DEPLOYED engine "
                    "(scripts.models.player_projection.project_player), whose "
                    "week-1 RoS total is identical to the value app/ros.js "
                    "renders. Written by scripts/backtest_player.py; the retired "
                    "scripts/backtest_ros.py proxy formula now appears only as a "
                    "baseline in data/player_backtest.json. At day-zero weights "
                    "proj_points == prior_season_points under the shipped total "
                    "rule (R49: the games-normalized rule is the CANDIDATE baseline, "
                    "gated by player_backtest.json baseline_gate), so rho_ros and "
                    "rho_lastyear are the SAME NUMBERS by construction and no "
                    "position can beat the baseline until a signal earns weight.",
        },
        "per_season": per_season,
        "pooled": pooled,
        "summary": {
            "positions_beating_baseline": result["summary"]["engine_beats_last_year"],
            "positions_scored": result["summary"]["positions_scored"],
        },
    }


def _write(path, doc, indent):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=indent, sort_keys=False)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Selftest — fixtures only, never writes.
# ---------------------------------------------------------------------------

def _fixture_history():
    """Three seasons for six players per position; season 2025 actuals are a
    deterministic function of the 2024 line so the rank math has signal."""
    players = {}
    for pos in POSITIONS:
        for i in range(6):
            base = 100.0 + 20.0 * i
            players["p_%s_%d" % (pos, i)] = {
                "name": "%s %d" % (pos, i),
                "position": pos,
                "seasons": [
                    {"yr": 2023, "pts": base * 0.9, "games": 17, "receptions": 10.0},
                    {"yr": 2024, "pts": base, "games": 17, "receptions": 12.0},
                    {"yr": 2025, "pts": base * 1.1, "games": 17, "receptions": 14.0},
                ],
            }
    return {"players": players}


def selftest():
    # --- rank + error math -------------------------------------------------
    assert abs(spearman([(1, 10), (2, 20), (3, 30)]) - 1.0) < 1e-9
    assert abs(spearman([(1, 30), (2, 20), (3, 10)]) + 1.0) < 1e-9
    assert spearman([(1, 1), (2, 2)]) is None                    # too few points
    assert ndcg([30, 20, 10], 3) > ndcg([10, 20, 30], 3)
    assert abs(mae([(10, 12), (10, 8)]) - 2.0) < 1e-9
    assert abs(rmse([(10, 13), (10, 7)]) - 3.0) < 1e-9

    # --- the retired proxy, preserved as a baseline ------------------------
    p = baseline_ppg17([{"yr": 2023, "pts": 100, "games": 17},
                        {"yr": 2024, "pts": 200, "games": 17}])
    assert p is not None and p > 150, p               # recency-weighted toward 200
    assert baseline_ppg17([{"yr": 2023, "pts": 100, "games": 0}]) is None

    hist = _fixture_history()

    # --- LEAK-FREEDOM: a held-out actual cannot touch its own input --------
    rows_a, _ = build_rows(hist, 2025)
    leaked = json.loads(json.dumps(hist))
    for rec in leaked["players"].values():
        for s in rec["seasons"]:
            if s["yr"] == 2025:
                s["pts"] = 9999.0                     # flip the held-out truth
    rows_b, _ = build_rows(leaked, 2025)
    assert [r["record"] for r in rows_a] == [r["record"] for r in rows_b], \
        "season-S actuals leaked into the season-S projection inputs"
    assert [r["last_year"] for r in rows_a] == [r["last_year"] for r in rows_b]
    assert all(r["actual"] == 9999.0 for r in rows_b)  # ...but the truth did move

    # --- the engine under test IS the deployed one -------------------------
    row = rows_a[0]
    out = project_player(row["record"], ctx=None, weights=None)
    assert engine_projection(row["record"]) == out["proj_points"]
    # ...and at day-zero weights the GATED series collapses to the prior-season
    # total exactly; the shipped number is the candidate under the R49 override.
    assert abs(out["gated_points"] - row["last_year"]) < 1e-9
    if pp_mod.SHIPPED_ESTIMATE == "candidate":
        assert out["proj_points"] == out["candidate_points"]
    else:
        assert abs(engine_projection(row["record"]) - row["last_year"]) < 1e-9

    # --- deployed-path identity: split -> sum == the season projection ------
    ident = path_identity_check([123.4, 250.0, 7.5], _synthetic_schedule(), {})
    assert ident["checked"] == 3 and ident["holds"], ident
    # A broken mirror must FAIL the check, not pass it quietly.
    weeks = build_weekly.player_weeks(
        100.0, "AAA", build_weekly.team_schedule(_synthetic_schedule()), {})
    assert abs(ros_points_mirror(weeks, 1) - 100.0) <= PATH_IDENTITY_TOL
    assert ros_points_mirror(weeks, 18) < ros_points_mirror(weeks, 1), \
        "a later from_week must sum fewer weeks"

    # --- end-to-end walk-forward on the fixture ----------------------------
    result = run(hist)
    assert result["summary"]["positions_scored"] == len(POSITIONS)
    gated_mode = pp_mod.SHIPPED_ESTIMATE == "gated"
    assert result["summary"]["engine_equals_last_year_everywhere"] is gated_mode
    for pos in POSITIONS:
        block = result["pooled"][pos]
        assert block["measured"] and block["n"] >= MIN_ROWS
        assert block["rho_gated"] == block["rho_last_year"], \
            "the day-zero GATED series and the last-year baseline are identical numbers"
        assert block["mae_gated"] == block["mae_last_year"]
        if gated_mode:
            assert block["rho_engine"] == block["rho_last_year"]
        assert block["mae_engine"] is not None and block["rmse_engine"] is not None
    # No held-out season may be scored against a fit season it also trained on.
    for entry in result["per_season"]:
        assert entry["fit_seasons"] == "<= %d" % (entry["held_out"] - 1)

    # --- the signal audit is measured, and partitions cleanly --------------
    audit = result["signal_audit"]
    assert audit["deployed_inputs_fire"] == [], \
        "season-total substrate cannot fire an adjustment signal"
    assert audit["candidate_inputs_fire"] == ["injury_history"], audit
    assert "age_curve" in audit["substrate_missing"], audit
    assert audit["baseline_fed"] == ["prior_perf"], audit
    buckets = (set(audit["baseline_fed"]) | set(audit["engine_implements"])
               | set(audit["registry_only"]))
    assert len(buckets) == audit["player_signals_in_registry"], audit
    assert not (set(audit["engine_implements"]) & set(audit["registry_only"]))

    # --- documents are shaped as the contracts require ---------------------
    doc = build_document(result, None, "synthetic")
    assert doc["__meta__"]["weights_source"] == "registry"
    assert doc["__meta__"]["nonzero_weights"] == {}
    assert len(doc["__meta__"]["approximations"]) >= 3
    legacy = build_legacy_document(result)
    assert legacy["summary"]["positions_scored"] == len(POSITIONS)
    if gated_mode:
        assert legacy["summary"]["positions_beating_baseline"] == 0, \
            "nothing can beat the baseline while the engine IS the baseline"

    # --- R49: the baseline gate and the candidate machinery -----------------
    # Every fixture season is 17 games, so the per-game rule differs from the
    # total only through the 2:1 recency weighting (2024 x2 + 2023 x1): the gate
    # must MEASURE both rules and every number must be a real metric.
    gate = baseline_gate(hist)
    assert isinstance(gate["adopted_for_shipped"], bool)
    for k in ("pooled_rho_total_rule", "pooled_rho_ppg_rule",
              "pooled_mae_total_rule", "pooled_mae_ppg_rule"):
        assert isinstance(gate[k], float), (k, gate[k])
    assert set(gate["per_position"]) == set(POSITIONS)
    # The rule itself, on one row: recency-weighted ppg x 17 (2024 13 games).
    rows_s, _ = build_rows(hist, 2025)
    rec = dict(rows_s[0]["record"])
    rec["prior_games"] = 13
    rec["prior_seasons"] = [{"yr": 2024, "pts": rec["prior_season_points"], "games": 13},
                            {"yr": 2023, "pts": 90.0, "games": 17}]
    ppg_proj = project_player(rec, baseline_rule=pp_mod.BASELINE_RULE_PPG)
    want = (2.0 * rec["prior_season_points"] / 13 + 1.0 * 90.0 / 17) / 3.0 * 17
    assert abs(ppg_proj["proj_points"] - want) < 0.02, (ppg_proj["proj_points"], want)
    assert ppg_proj["candidate_baseline"] == ppg_proj["proj_points"]
    assert ppg_proj["prior_games"] == 13 and ppg_proj["projected_games"] == 17
    # ...and the GATED series (total rule) on the same record is untouched.
    assert project_player(rec)["gated_points"] == rec["prior_season_points"]
    cand = candidate_2025(hist)
    assert cand["players"] == len(rows_a) and cand["season"] == 2025
    assert cand["baseline_mae"] is not None and cand["candidate_mae"] is not None
    assert cand["shipped_mae"] > 0 and cand["gated_mae"] > 0
    assert cand["band_multiplier"] == pp_mod.CANDIDATE_BAND_MULTIPLIER
    assert 0.0 <= cand["band_coverage"] <= 1.0
    cvg = gate["candidate_vs_gated"]
    assert cvg["shipped_estimate"] == pp_mod.SHIPPED_ESTIMATE
    for k in ("pooled_rho_gated", "pooled_rho_candidate", "pooled_mae_gated",
              "pooled_mae_candidate"):
        assert isinstance(cvg[k], float), (k, cvg[k])
    assert "injury_history" in cand["signals_evaluated"], cand["signals_evaluated"]
    assert "age_curve" in cand["signals_not_evaluable"], "no ages in the substrate"
    assert cand["sleeper_mae"] is None and "not retrieved" in cand["sleeper_note"]
    cand_sl = candidate_2025(hist, sleeper_totals={rows_a[0]["record"]["gsis_id"]: 100.0},
                             sleeper_note="fixture")
    assert cand_sl["sleeper_players"] == 1 and cand_sl["sleeper_mae"] is not None
    doc_full = build_document(result, None, "synthetic", gate=gate, candidate=cand)
    assert doc_full["baseline_gate"]["adopted_for_shipped"] is False
    assert doc_full["__meta__"]["baseline_rule_scored"] == pp_mod.SHIPPED_BASELINE_RULE

    print("selftest OK: rank/error math, leak-freedom, deployed-engine identity, "
          "split->sum path identity, walk-forward document shape, R49 baseline "
          "gate + candidate machinery")


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------

def _parse_weights(argv):
    """--weights name=0.1,other=0.25 -> {name: 0.1, ...}; None when absent."""
    for i, a in enumerate(argv):
        if a == "--weights" and i + 1 < len(argv):
            raw = argv[i + 1]
        elif a.startswith("--weights="):
            raw = a.split("=", 1)[1]
        else:
            continue
        out = {}
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            name, _, val = part.partition("=")
            out[name.strip()] = float(val)
        return out
    return None


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv):
    if not os.path.exists(HISTORY_PATH):
        print("BACKTEST: player_history.json absent (runner-built); nothing to do.",
              file=sys.stderr)
        return 0
    weights = _parse_weights(argv)
    history = _load(HISTORY_PATH)

    schedule_games, schedule_source = None, "synthetic (schedule_full.json absent)"
    if os.path.exists(SCHEDULE_PATH):
        schedule_games = _load(SCHEDULE_PATH).get("games") or None
        if schedule_games:
            schedule_source = "data/schedule_full.json"
    elos = {}
    if os.path.exists(STRENGTH_PATH):
        elos = {t: float(r)
                for t, r in (_load(STRENGTH_PATH).get("ratings") or {}).items()}

    result = run(history, weights=weights, schedule_games=schedule_games, elos=elos)

    if weights:
        audit = result["signal_audit"]
        blind = set(audit["substrate_missing"]) | set(audit["registry_only"])
        unfeedable = sorted(set(weights) & blind)
        if unfeedable:
            print("[warn] non-zero weight given to signal(s) whose inputs this "
                  "substrate CANNOT supply: %s — their adjustment is 1.0 here, so "
                  "the numbers below understate (or overstate) what they would do "
                  "in production. Do not adopt on this evidence."
                  % ", ".join(unfeedable), file=sys.stderr)

    # R49 — the baseline gate (shipped number) and last year's candidate MAE.
    gate = baseline_gate(history, weights)
    sleeper_totals, sleeper_note = (None, None)
    if "--no-sleeper" not in argv:
        sleeper_totals, sleeper_note = sleeper_reference(CANDIDATE_SEASON, history)
        if sleeper_totals is None:
            print("[warn] %s" % sleeper_note, file=sys.stderr)
    gate["measured_utc"] = _now()
    candidate = candidate_2025(history, sleeper_totals, sleeper_note)
    gate_doc = {k: v for k, v in gate.items() if k != "measured_utc"}

    _write(OUT_PATH, build_document(result, weights, schedule_source,
                                    gate=gate_doc, candidate=candidate), 2)
    _write(LEGACY_PATH, build_legacy_document(result), 1)

    ident = result["path_identity"]
    print("PLAYER BACKTEST — walk-forward, held-out seasons %s"
          % ", ".join(str(s) for s in EVAL_SEASONS))
    print("  engine: project_player (the deployed projection), weights=%s"
          % ("override" if weights else "registry (all 0.0)"))
    print("  deployed-path identity (split -> ros.js sum): checked=%d "
          "max_abs_diff=%s tol=%s -> %s"
          % (ident["checked"], ident["max_abs_diff"], ident["tolerance"],
             "HOLDS" if ident["holds"] else "BROKEN"))
    for pos in POSITIONS:
        b = result["pooled"][pos]
        if not b.get("measured"):
            print("  %s: skipped (%s, n=%d)" % (pos, b.get("skipped"), b["n"]))
            continue
        print("  %s n=%-4d rho engine=%+.3f last_year=%+.3f ppg17=%+.3f | "
              "MAE engine=%6.1f last_year=%6.1f ppg17=%6.1f"
              % (pos, b["n"], b["rho_engine"], b["rho_last_year"], b["rho_ppg17"],
                 b["mae_engine"], b["mae_last_year"], b["mae_ppg17"]))
    s = result["summary"]
    print("  engine beats last_year in %d/%d positions, ppg17 in %d/%d"
          % (s["engine_beats_last_year"], s["positions_scored"],
             s["engine_beats_ppg17"], s["positions_scored"]))
    if s["engine_equals_last_year_everywhere"]:
        print("  NOTE (measured, not editorial): at day-zero weights every signal "
              "applies 1.0, so under the shipped total rule proj_points == "
              "prior_season_points. The deployed engine and the last_year baseline "
              "are the SAME NUMBERS; the engine cannot beat it until a signal earns "
              "weight or the R49 baseline gate flips.")
    print("  excluded (no prior season, engine cannot rank them): %d player-seasons"
          % s["player_seasons_excluded_no_prior"])
    print("  R49 baseline gate (shipped number): rho %s -> %s, MAE %s -> %s -> %s"
          % (gate["pooled_rho_total_rule"], gate["pooled_rho_ppg_rule"],
             gate["pooled_mae_total_rule"], gate["pooled_mae_ppg_rule"],
             "ADOPT" if gate["adopted_for_shipped"] else "NOT ADOPTED (candidate only)"))
    cvg = gate["candidate_vs_gated"]
    print("  R49 shipped=%s (owner override=%s): walk-forward candidate vs gated — "
          "rho %s vs %s, MAE %s vs %s"
          % (cvg["shipped_estimate"], cvg["owner_override"], cvg["pooled_rho_candidate"],
             cvg["pooled_rho_gated"], cvg["pooled_mae_candidate"], cvg["pooled_mae_gated"]))
    print("  R49 candidate 2025 (2024 priors -> 2025 actuals, n=%d): MAE baseline=%s "
          "candidate=%s gated=%s shipped=%s | band x%s coverage=%s | sleeper=%s (n=%s)"
          % (candidate["players"], candidate["baseline_mae"], candidate["candidate_mae"],
             candidate["gated_mae"], candidate["shipped_mae"], candidate["band_multiplier"],
             candidate["band_coverage"], candidate["sleeper_mae"],
             candidate["sleeper_players"]))
    print("  R49 signals evaluated historically: %s; not evaluable: %s"
          % (candidate["signals_evaluated"], candidate["signals_not_evaluable"]))
    print("wrote %s and %s" % (OUT_PATH, LEGACY_PATH))
    return 0 if ident["holds"] else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
