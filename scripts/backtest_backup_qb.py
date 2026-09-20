"""Walk-forward BACKUP-QB CASCADE experiment (R92 part C, phase 1: MEASURE ONLY).

The owner's order (2026-09-20): "a drop when QB1 is out, another when QB2 is
out, then the capability of the replacement — applied to key positions and
carried into the PLAYER, game, week and MY parlay numbers." This file is the
PLAYER side of that order: what happens to a team's receivers and backs (and
to the quarterback slot itself) when the starting quarterback is out, measured
player-week by player-week on the SHIPPED weekly number, with every input
restricted to what was knowable before kickoff. It changes NO projection: a
backup-QB factor reaches build_weekly only after a candidate here clears the
weekly never-regress gate (phase 2), and the artifact says which did.

Substrate (reused by import, nothing edited):
  * scripts/backtest_weekly.py — the committed corpus
    data/fixtures/backtest_weekly/{weekly_actuals,games_meta}.json, the fixed
    season number, the pool, the as-of Elo / DvP / venue / weather factors and
    the deployed build_weekly path, so `v2` here IS the shipped weekly number;
  * scripts/backtest_lines.py — the R70 snapshot-to-week mapping
    (week_first_kickoffs / snapshot_week), so both cascades read the
    depth-chart releases the same way;
  * data/injury_history.json — the FINAL report statuses, pregame by
    construction (QB rows carry gsis ids);
  * data/epa_history.json — per (season, team, week) `passers`
    {gsis_id: {db, epa, name}}, the raw material for passer capability;
  * the nflverse depth-chart release per scored season (same fetch + --cache-dir
    as build_line_report.py).

QB STARTER RULE (walk-forward, ordered). R70 needed a SET of line starters, so
it tallied rank-1 rows. A quarterback room needs an ORDER, so the rule here is
the latest knowable chart instead of a tally: for team T in week wk, take the
LATEST depth-chart snapshot whose week is <= wk - STARTER_LAG (default lag 1 =
strictly before the week; week 1 therefore has no chart, is neutral and is
COUNTED) and read its QB rows in `rank` order, one entry per player. The 2025+
release is dated per snapshot (`dt`) and belongs to the first week whose first
kickoff (games_meta) is after it; the legacy release is dated per `week`.

CONDITION per (team, week), from the chart above and the final report:
  * qb1      — QB1 is not listed Out or Doubtful. The baseline. cap_gap = 0.
  * backup   — QB1 is out and the highest-ranked QB who is not out is QB2.
  * qb3_plus — QB1 and QB2 are both out (expected starter is rank 3 or deeper,
               or nobody on the chart when every listed QB is out).
  * unknown  — no chart was knowable before the week. Neutral, counted.
Out means listed Out OR Doubtful on the FINAL report, which is the owner's
wording; Questionable is not an absence. Ids join on gsis, names second,
nothing is guessed.

CAPABILITY and cap_gap. capability(QB) = EPA per dropback over his TRAILING
dropbacks strictly before the week (walking back through data/epa_history.json
until TRAILING_DB dropbacks are gathered); a passer with fewer than MIN_DB
trailing dropbacks has no measured capability and takes the FOLD's
REPLACEMENT-LEVEL POOL — the pooled EPA per dropback of every passer-season
BEFORE the scored season that never reached REPLACEMENT_SEASON_DB dropbacks
(i.e. the league's non-starters), so the substitute number is itself
walk-forward. cap_gap = capability(QB1) - capability(expected starter), in EPA
per dropback, and is 0 when QB1 starts. Positive = the replacement is worse.

CANDIDATES (both measure-only, both fit on folds BEFORE the scored season):
  * cap_gap_<pos>     : proj x (1 + beta_pos x cap_gap)
  * backup_flat_<pos> : proj x m_pos whenever a backup starts
  * ..._ALL           : every position's own fitted parameter at once.
Each parameter is fitted by least squares on the shipped scale AFTER removing
the fold's position-level bias (`base` = sum(actual) / sum(v2) over that fold's
qb1 rows). That subtraction matters: `actual / v2` sits below 1 in almost every
bucket of this corpus, so a factor fitted on backup rows alone would absorb
v2's generic level and look like a cascade it is not.

METRICS: the harness's own — pooled and held-out MAE / rank corr / top-K per
candidate, the residual (actual - v2) mean and MAE per position per condition
and per cap_gap bucket, the raw component yards the corpus carries (pass /
rush / rec) per condition, and a paired season-week block bootstrap CI of
MAE(candidate) - MAE(v2).

NEVER-REGRESS (the weekly criterion backtest_weekly uses): a candidate is
adoptable only if pooled MAE <= v2's AND pooled rank_corr >= v2's. Phase 1
adopts nothing regardless. Nothing here writes to any projection file.
Stdlib only.
"""

import datetime as dt
import json
import os
import random
import sys
import time

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import backtest_weekly as bwk                    # noqa: E402
from scripts import build_weekly as bw                        # noqa: E402
from scripts.backtest_lines import (                          # noqa: E402
    snapshot_week, week_first_kickoffs)
from scripts.backtest_player import mae                       # noqa: E402
from scripts.build_line_report import (                       # noqa: E402
    fetch_depth_chart, name_key, norm_team, normalize_depth_rows)

DATA = os.path.join(_ROOT, "data")
INJURY_HISTORY_PATH = os.path.join(DATA, "injury_history.json")
EPA_HISTORY_PATH = os.path.join(DATA, "epa_history.json")
OUT_PATH = os.path.join(DATA, "backup_qb_backtest.json")
INJURY_HISTORY_REL = "data/injury_history.json"
EPA_HISTORY_REL = "data/epa_history.json"

POSITIONS = bwk.POSITIONS
SEASONS_SCORED = bwk.SEASONS_SCORED
HELD_OUT = bwk.HELD_OUT
INCUMBENT = "v2"
STARTER_LAG = 1                      # snapshots strictly before the week
OUT_STATUSES = ("Out", "Doubtful")   # the owner's wording; Questionable is not an absence
CONDITIONS = ("qb1", "backup", "qb3_plus", "unknown")
BACKUP_CONDITIONS = ("backup", "qb3_plus")
MIN_DB = 100                         # trailing dropbacks for a measured capability
TRAILING_DB = 600                    # the trailing window, about one season of dropbacks
REPLACEMENT_SEASON_DB = 200          # a passer-season under this is replacement level
MIN_FIT_N = 25                       # fewer backup rows than this -> the fold fits nothing
FACTOR_CLAMP = (0.5, 1.5)            # a fitted factor may never move a number further
CAP_GAP_BUCKETS = ("none", "neg", "0.00-0.05", "0.05-0.15", "0.15+", "unknown")
COMPONENT_FIELDS = ("pass_yds", "rush_yds", "rec_yds")   # corpus fields 3, 4, 5
COMPONENT_MIN_BASE = 1.0             # a ratio against a sub-yard baseline says nothing
FAMILIES = ("cap_gap", "backup_flat")
SCOPES = POSITIONS + ("ALL",)

NEVER_REGRESS_RULE = (
    "never-regress (the weekly gate's own criterion): a backup-QB candidate is "
    "adoptable only if it is not worse than the shipped weekly number on pooled "
    "MAE and pooled rank_corr; phase 1 adopts nothing")
POLICY = (
    "MEASUREMENT ONLY. The quarterback room is read from depth-chart snapshots "
    "strictly before the week and the FINAL injury report for the week; passer "
    "capability is EPA per dropback over dropbacks before the week, with the "
    "fold's replacement-level pool standing in below %d dropbacks. Every "
    "candidate parameter is fitted on seasons BEFORE the season it is scored on. "
    "Team-weeks with no knowable chart are neutral and counted, never guessed. "
    "No shipped projection changes in this release: nothing in build_weekly "
    "reads this artifact. The book lines in games_meta are never read."
    % MIN_DB)
LIMITS = [
    "The final report lists a quarterback only when the team reports him. A QB1 "
    "on injured reserve for a long stretch can stop appearing on the weekly "
    "report, so some backup starts are read as condition qb1; those weeks dilute "
    "the baseline rather than inflating the effect.",
    "Out means Out or Doubtful on the final report. A game-time scratch that was "
    "listed Questionable is scored as qb1 — the pregame report is the only thing "
    "knowable before kickoff, and the inactive list is not.",
    "QB3-or-deeper starts are almost absent in this corpus; the condition is "
    "reported with its n and nothing is inferred from a handful of rows.",
    "Condition is a TEAM-week property, so a quarterback row under `backup` is "
    "usually the replacement himself, whose shipped number is his own prior-season "
    "baseline. That is a different mechanism (playing time) from the cascade onto "
    "receivers and backs; `qb_subject_rows` counts the two apart.",
    "The corpus carries component yards (pass / rush / rec) but the shipped weekly "
    "number is PPR points only, so the component tables are raw actual means by "
    "condition — a ratio against the qb1 baseline, never a residual against a "
    "projection that does not exist.",
    "Week 1 of every season has no chart under starter lag 1 and is counted as "
    "`unknown`; it is neutral for every candidate.",
    "Parameters are fitted by least squares on the shipped scale, which weights "
    "high-scoring rows more than the MAE the gate scores; a median-ratio fit would "
    "trade level accuracy for rank accuracy and is not tried here.",
    "The earliest scored season has no prior fold, so every candidate is exactly "
    "the shipped number there. Its rows still count in the pooled metrics, which "
    "is why a pooled delta is smaller than the per-fold deltas that produced it.",
]


# ---------------------------------------------------------------------------
# The quarterback room, walk-forward
# ---------------------------------------------------------------------------

def qb_depth_by_week(depth_rows, first_kick, weeks=bw.WEEKS, lag=STARTER_LAG):
    """{(team, wk): [(rank, pid, name), ...]} in rank order, from the LATEST
    snapshot whose week is <= wk - lag. A player's id is his gsis id, else his
    name key; a player listed twice in one snapshot keeps his best rank. Teams
    and weeks with nothing knowable are simply absent (never invented)."""
    by_team = {}
    for r in depth_rows:
        if r["pos"] != "QB":
            continue
        sw = snapshot_week(r["snap"], first_kick)
        if sw is None:
            continue  # a post-season chart precedes no week of this season
        by_team.setdefault(r["team"], {}).setdefault((sw, str(r["snap"])), []).append(r)
    out = {}
    for team, snaps in by_team.items():
        ordered = sorted(snaps)
        for wk in range(1, weeks + 1):
            usable = [k for k in ordered if k[0] <= wk - lag]
            if not usable:
                continue
            room, seen = [], set()
            for r in sorted(snaps[usable[-1]], key=lambda x: (x["rank"], x["name"])):
                pid = r["gsis_id"] or name_key(r["name"])
                if pid in seen:
                    continue
                seen.add(pid)
                room.append((int(r["rank"]), pid, r["name"]))
            if room:
                out[(team, wk)] = room
    return out


def qb_outs_by_team_week(injury_history, season, statuses=OUT_STATUSES):
    """{(team, wk): {pid}} — quarterbacks listed Out / Doubtful on the final
    report. Ids match qb_depth_by_week (gsis first, name key second)."""
    out = {}
    seasons = (injury_history or {}).get("seasons") or {}
    for team, weeks in (seasons.get(str(season)) or {}).items():
        for wk_s, rows in weeks.items():
            for r in rows:
                if str(r.get("position") or "").upper() != "QB":
                    continue
                if r.get("status") not in statuses:
                    continue
                pid = r.get("id") or name_key(r.get("name"))
                out.setdefault((norm_team(team), int(wk_s)), set()).add(pid)
    return out


def room_condition(room, outs):
    """(condition, qb1, expected) for one team-week. `room` is the ordered QB
    list (or None when nothing was knowable), `outs` the set of ids listed out.
    `expected` is the highest-ranked quarterback who is not out — None when the
    whole listed room is out, which is still a qb3_plus week."""
    if not room:
        return "unknown", None, None
    qb1 = room[0]
    if qb1[1] not in outs:
        return "qb1", qb1, qb1
    available = [q for q in room if q[1] not in outs]
    expected = available[0] if available else None
    if expected is not None and expected[0] <= 2:
        return "backup", qb1, expected
    return "qb3_plus", qb1, expected


# ---------------------------------------------------------------------------
# Passer capability
# ---------------------------------------------------------------------------

def passer_index(epa_doc):
    """{pid: [(season, week, dropbacks, epa_total), ...]} in time order, from
    data/epa_history.json seasons[yr][team][week].passers."""
    idx = {}
    for yr, teams in ((epa_doc or {}).get("seasons") or {}).items():
        for weeks in teams.values():
            for wk_s, rec in (weeks or {}).items():
                for pid, p in ((rec or {}).get("passers") or {}).items():
                    db = float(p.get("db") or 0.0)
                    if db <= 0:
                        continue
                    idx.setdefault(pid, []).append(
                        (int(yr), int(wk_s), db, float(p.get("epa") or 0.0)))
    for rows in idx.values():
        rows.sort()
    return idx


def trailing_capability(idx, pid, season, week, window=TRAILING_DB, min_db=MIN_DB):
    """(epa_per_dropback, dropbacks) over the passer's most recent dropbacks
    STRICTLY BEFORE (season, week), walking back until `window` dropbacks are
    gathered. (None, db) when fewer than `min_db` were ever thrown before the
    week — the caller then uses the fold's replacement-level pool."""
    rows = (idx or {}).get(pid) or []
    db = epa = 0.0
    for s, w, d, e in reversed(rows):
        if (s, w) >= (int(season), int(week)):
            continue
        db += d
        epa += e
        if db >= window:
            break
    if db < min_db:
        return None, db
    return epa / db, db


def replacement_level(epa_doc, before_season, season_db=REPLACEMENT_SEASON_DB):
    """The fold's replacement-level EPA per dropback: pooled over every
    passer-season STRICTLY BEFORE `before_season` that never reached
    `season_db` dropbacks — the league's non-starters, which is what a team
    actually reaches for. None when no earlier season exists (the row is then
    neutral and counted)."""
    per = {}
    for yr, teams in ((epa_doc or {}).get("seasons") or {}).items():
        if int(yr) >= int(before_season):
            continue
        for weeks in teams.values():
            for rec in (weeks or {}).values():
                for pid, p in ((rec or {}).get("passers") or {}).items():
                    cell = per.setdefault((pid, int(yr)), [0.0, 0.0])
                    cell[0] += float(p.get("db") or 0.0)
                    cell[1] += float(p.get("epa") or 0.0)
    db = epa = 0.0
    for tot_db, tot_epa in per.values():
        if tot_db < season_db:
            db += tot_db
            epa += tot_epa
    return (epa / db) if db > 0 else None


def capability_of(idx, pid, season, week, replacement):
    """(value, source) — the measured trailing capability, else the fold's
    replacement level, else (None, 'absent'). Absent is counted, never guessed."""
    if pid is None:
        return (replacement, "replacement") if replacement is not None else (None, "absent")
    value, _db = trailing_capability(idx, pid, season, week)
    if value is not None:
        return value, "measured"
    if replacement is not None:
        return replacement, "replacement"
    return None, "absent"


def cap_gap_for(idx, season, week, qb1, expected, replacement):
    """(cap_gap, source) for one team-week: capability(QB1) - capability(expected
    starter), in EPA per dropback. 0.0 when QB1 is the expected starter."""
    if qb1 is not None and expected is not None and qb1[1] == expected[1]:
        return 0.0, "qb1_starts"
    c1, s1 = capability_of(idx, qb1[1] if qb1 else None, season, week, replacement)
    c2, s2 = capability_of(idx, expected[1] if expected else None, season, week, replacement)
    if c1 is None or c2 is None:
        return None, "absent"
    return c1 - c2, "%s/%s" % (s1, s2)


def cap_gap_bucket(cond, gap):
    """The reporting bucket for one row's cap_gap."""
    if cond == "qb1":
        return "none"
    if gap is None:
        return "unknown"
    if gap < 0:
        return "neg"
    if gap < 0.05:
        return "0.00-0.05"
    if gap < 0.15:
        return "0.05-0.15"
    return "0.15+"


# ---------------------------------------------------------------------------
# Row annotation
# ---------------------------------------------------------------------------

def annotate_rows(rows, room_by_season, outs_by_season, idx, replacement_by_season,
                  actuals=None):
    """Set cond / cap_gap / cap_source / bucket on every row (and the component
    yards when the corpus carries them). Returns the coverage counts."""
    cov = {"rows": 0, "chart_known": 0, "cap_gap_known": 0, "replacement_used": 0}
    cache = {}
    for r in rows:
        cov["rows"] += 1
        season, wk, team = r["season"], r["week"], r["team"]
        key = (season, wk, team)
        if key not in cache:
            room = (room_by_season.get(season) or {}).get((team, wk))
            outs = (outs_by_season.get(season) or {}).get((team, wk), set())
            cond, qb1, expected = room_condition(room, outs)
            if cond == "unknown":
                cache[key] = (cond, None, "no_chart", None, None)
            else:
                gap, source = cap_gap_for(idx, season, wk, qb1, expected,
                                          replacement_by_season.get(season))
                cache[key] = (cond, gap, source, qb1, expected)
        cond, gap, source, qb1, expected = cache[key]
        r["cond"] = cond
        r["cap_gap"] = gap
        r["cap_source"] = source
        r["bucket"] = cap_gap_bucket(cond, gap)
        r["is_expected_starter"] = bool(expected is not None and r["pid"] == expected[1])
        if cond != "unknown":
            cov["chart_known"] += 1
        if gap is not None:
            cov["cap_gap_known"] += 1
        if "replacement" in str(source):
            cov["replacement_used"] += 1
        if actuals is not None:
            line = (((actuals.get("players") or {}).get(r["pid"]) or {}).get("seasons") or {}) \
                .get(str(season), {}).get(str(wk))
            for i, field in enumerate(COMPONENT_FIELDS, start=3):
                r[field] = float(line[i]) if line and len(line) > i and line[i] is not None else None
    return cov


# ---------------------------------------------------------------------------
# The fit (walk-forward, one parameter set per fold)
# ---------------------------------------------------------------------------

def base_ratio(rows, pos):
    """The fold's position-level bias: sum(actual) / sum(v2) over its qb1 rows.
    Removing it is what stops a candidate absorbing the shipped number's generic
    level and calling it a cascade. None when the fold has no qb1 rows."""
    num = den = 0.0
    for r in rows:
        if r["pos"] == pos and r["cond"] == "qb1":
            num += r["actual"]
            den += r[INCUMBENT]
    return (num / den) if den > 0 else None


def fit_position(rows, pos, min_n=MIN_FIT_N):
    """{base, m, beta, n_baseline, n_backup, note} from one fold's rows.

    m    : least squares of actual on (base x v2) over the fold's backup rows,
           i.e. the flat multiplier a backup start is worth for this position.
    beta : least squares of actual on (base x v2) x (1 + beta x cap_gap) over
           the same rows, i.e. the per-unit-of-cap_gap slope.
    Both are 1.0 / 0.0 (neutral) when the fold has fewer than `min_n` backup
    rows — a fold that cannot fit says so instead of fitting noise."""
    base = base_ratio(rows, pos)
    backup = [r for r in rows if r["pos"] == pos and r["cond"] in BACKUP_CONDITIONS
              and r[INCUMBENT] > 0]
    n_base = sum(1 for r in rows if r["pos"] == pos and r["cond"] == "qb1")
    if base is None or len(backup) < min_n:
        why = "no baseline rows" if base is None else "only %d backup rows (< %d)" % (
            len(backup), min_n)
        return {"base": base, "m": 1.0, "beta": 0.0, "n_baseline": n_base,
                "n_backup": len(backup), "note": "neutral: %s" % why}
    num = den = 0.0
    for r in backup:
        p = base * r[INCUMBENT]
        num += p * r["actual"]
        den += p * p
    m = (num / den) if den > 0 else 1.0
    bnum = bden = 0.0
    for r in backup:
        if r["cap_gap"] is None:
            continue
        p = base * r[INCUMBENT]
        g = r["cap_gap"]
        bnum += p * p * g * (r["actual"] / p - 1.0) if p > 0 else 0.0
        bden += p * p * g * g
    beta = (bnum / bden) if bden > 0 else 0.0
    return {"base": base, "m": m, "beta": beta, "n_baseline": n_base,
            "n_backup": len(backup), "note": "fitted"}


def fit_folds(rows, seasons=SEASONS_SCORED, min_n=MIN_FIT_N):
    """{season: {pos: fit}} — each season's parameters fitted ONLY on the
    seasons scored before it. The earliest season fits nothing and is neutral."""
    out = {}
    for season in seasons:
        prior = [r for r in rows if r["season"] < season]
        out[season] = {pos: fit_position(prior, pos, min_n) for pos in POSITIONS}
        for pos in POSITIONS:
            if not prior:
                out[season][pos]["note"] = "neutral: no fold before %d" % season
    return out


def clamp(value, lo=FACTOR_CLAMP[0], hi=FACTOR_CLAMP[1]):
    return max(lo, min(hi, value))


def row_factor(family, r, fit):
    """The multiplier one candidate family puts on one row. Neutral (1.0) on a
    qb1 week, on an unknown week and wherever cap_gap is absent."""
    if r["cond"] not in BACKUP_CONDITIONS:
        return 1.0
    if family == "backup_flat":
        return clamp(fit["m"])
    if family == "cap_gap":
        if r["cap_gap"] is None:
            return 1.0
        return clamp(1.0 + fit["beta"] * r["cap_gap"])
    raise ValueError("unknown family %r" % family)


def candidate_name(family, scope):
    return "%s_%s" % (family, scope)


def apply_candidates(rows, folds, families=FAMILIES, scopes=SCOPES):
    """Write every candidate's projection onto every row. Returns the names."""
    names = []
    for family in families:
        for scope in scopes:
            key = candidate_name(family, scope)
            names.append((key, family, scope))
            for r in rows:
                in_scope = (scope == "ALL" or r["pos"] == scope)
                fit = folds[r["season"]][r["pos"]]
                r[key] = r[INCUMBENT] * (row_factor(family, r, fit) if in_scope else 1.0)
    return names


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def paired_bootstrap(rows, key, incumbent=INCUMBENT, seasons=None, b=bwk.BOOT_B,
                     seed=bwk.BOOT_SEED):
    """Paired season-week block bootstrap of MAE(key) - MAE(incumbent), the
    harness's own resampling (blocks are whole season-weeks, fixed seed)."""
    blocks = {}
    for r in rows:
        if seasons is not None and r["season"] not in seasons:
            continue
        blocks.setdefault((r["season"], r["week"]), []).append(r)
    keys = sorted(blocks)
    if not keys:
        return {"mean": None, "lo95": None, "hi95": None, "blocks": "season-week", "B": b}
    rng = random.Random(seed)
    deltas = []
    for _ in range(b):
        sample = [r for _ in keys for r in blocks[rng.choice(keys)]]
        d_var = sum(abs(r[key] - r["actual"]) for r in sample) / len(sample)
        d_inc = sum(abs(r[incumbent] - r["actual"]) for r in sample) / len(sample)
        deltas.append(d_var - d_inc)
    return {"mean": sum(deltas) / len(deltas), "lo95": bwk.quantile(deltas, 0.025),
            "hi95": bwk.quantile(deltas, 0.975), "blocks": "season-week", "B": b}


def condition_counts(rows, seasons=SEASONS_SCORED):
    """{pos: {season: {condition: n}}} — every condition present with its n,
    including the zeros, so an absent condition is visible rather than missing."""
    out = {}
    for pos in POSITIONS:
        out[pos] = {}
        for season in seasons:
            out[pos][str(season)] = {
                cond: sum(1 for r in rows if r["pos"] == pos and r["season"] == season
                          and r["cond"] == cond)
                for cond in CONDITIONS}
    return out


def qb_subject_counts(rows, seasons=SEASONS_SCORED):
    """{season: {condition: {expected_starter, other_qb}}} — for QB rows only:
    whether the scored quarterback IS the man the chart expected to start."""
    out = {}
    for season in seasons:
        out[str(season)] = {}
        for cond in CONDITIONS:
            members = [r for r in rows if r["pos"] == "QB" and r["season"] == season
                       and r["cond"] == cond]
            out[str(season)][cond] = {
                "expected_starter": sum(1 for r in members if r["is_expected_starter"]),
                "other_qb": sum(1 for r in members if not r["is_expected_starter"])}
    return out


def _residual_cell(members, key=INCUMBENT):
    if not members:
        return {"n": 0, "mean_residual": None, "mae": None, "mean_actual": None,
                "mean_pred": None, "ratio": None}
    ma = sum(r["actual"] for r in members) / len(members)
    mp = sum(r[key] for r in members) / len(members)
    return {"n": len(members),
            "mean_residual": sum(r["actual"] - r[key] for r in members) / len(members),
            "mae": mae([(r[key], r["actual"]) for r in members]),
            "mean_actual": ma, "mean_pred": mp, "ratio": (ma / mp) if mp > 0 else None}


def residuals_by_condition(rows, key=INCUMBENT):
    """{pos: {condition: cell}} — the residual actual - v2 by condition."""
    return {pos: {cond: _residual_cell(
        [r for r in rows if r["pos"] == pos and r["cond"] == cond], key)
        for cond in CONDITIONS} for pos in POSITIONS}


def residuals_by_cap_gap(rows, key=INCUMBENT):
    """{pos: {bucket: cell}} — the same residual as a function of cap_gap."""
    return {pos: {b: _residual_cell(
        [r for r in rows if r["pos"] == pos and r["bucket"] == b], key)
        for b in CAP_GAP_BUCKETS} for pos in POSITIONS}


def components_by_condition(rows):
    """{pos: {condition: {field: mean or None, n_field: n}}} — the raw component
    yards the corpus carries. No projection exists for these, so they are means
    and a ratio against the position's qb1 baseline, never residuals."""
    out = {}
    for pos in POSITIONS:
        out[pos] = {}
        base = {}
        for field in COMPONENT_FIELDS:
            vals = [r[field] for r in rows if r["pos"] == pos and r["cond"] == "qb1"
                    and r.get(field) is not None]
            base[field] = (sum(vals) / len(vals)) if vals else None
        for cond in CONDITIONS:
            cell = {}
            for field in COMPONENT_FIELDS:
                vals = [r[field] for r in rows if r["pos"] == pos and r["cond"] == cond
                        and r.get(field) is not None]
                mean = (sum(vals) / len(vals)) if vals else None
                cell[field] = mean
                cell["n_" + field] = len(vals)
                # A ratio is only reported against a baseline worth dividing by: a
                # quarterback's receiving yards average a rounding error, and 2 / 0.02
                # would read as a hundredfold cascade that is not there.
                usable = base.get(field) is not None and base[field] >= COMPONENT_MIN_BASE
                cell["ratio_" + field] = (mean / base[field]) if (
                    mean is not None and usable) else None
            out[pos][cond] = cell
    return out


def _pos_block(rows, pos, key):
    prow = [r for r in rows if r["pos"] == pos]
    if not prow:
        return {"mae": None, "rank_corr": None, "n": 0}
    return {"mae": mae([(r[key], r["actual"]) for r in prow]),
            "rank_corr": bwk.rank_corr(prow, key), "n": len(prow)}


def _delta(candidate, shipped):
    return {k: (None if candidate.get(k) is None or shipped.get(k) is None
                else candidate[k] - shipped[k]) for k in ("mae", "rank_corr", "topk")}


def evaluate(rows, names, folds, seasons=SEASONS_SCORED, held_out=HELD_OUT):
    """(shipped block, [candidate records]) — every candidate scored on the whole
    corpus, so the pooled comparison against the shipped number is like for like
    (a candidate only moves the rows inside its own scope)."""
    held = [r for r in rows if r["season"] == held_out]
    shipped = {"pooled": bwk.block(rows, INCUMBENT),
               "held_out": bwk.block(held, INCUMBENT),
               "per_position": {pos: _pos_block(rows, pos, INCUMBENT) for pos in POSITIONS}}
    out = []
    for key, family, scope in names:
        pooled = bwk.block(rows, key)
        fold_results = []
        for season in seasons:
            srows = [r for r in rows if r["season"] == season]
            scoped = [r for r in srows if (scope == "ALL" or r["pos"] == scope)]
            moved = [r for r in scoped if abs(r[key] - r[INCUMBENT]) > 1e-12]
            params = {pos: (folds[season][pos]["m"] if family == "backup_flat"
                            else folds[season][pos]["beta"])
                      for pos in (POSITIONS if scope == "ALL" else (scope,))}
            fold_results.append({
                "season": season,
                "fit_seasons": [s for s in seasons if s < season],
                "params": params,
                "n_fit": {pos: folds[season][pos]["n_backup"]
                          for pos in (POSITIONS if scope == "ALL" else (scope,))},
                "note": {pos: folds[season][pos]["note"]
                         for pos in (POSITIONS if scope == "ALL" else (scope,))},
                "rows": len(srows), "rows_moved": len(moved),
                "shipped": bwk.block(srows, INCUMBENT),
                "candidate": bwk.block(srows, key),
            })
        measurable = all(x is not None for x in (
            pooled["mae"], pooled["rank_corr"],
            shipped["pooled"]["mae"], shipped["pooled"]["rank_corr"]))
        # A candidate whose folds could all fit nothing IS the shipped number, so it
        # passes never-regress by doing nothing. That is not an adoption case, and
        # calling it one would be the artifact lying about a no-op.
        rows_moved = sum(f["rows_moved"] for f in fold_results)
        would_adopt = bool(measurable and rows_moved > 0
                           and pooled["mae"] <= shipped["pooled"]["mae"]
                           and pooled["rank_corr"] >= shipped["pooled"]["rank_corr"])
        if not measurable:
            reason = "not measurable: a pooled metric is None (too few rows or groups)"
        elif rows_moved == 0:
            reason = ("neutral: no fold could fit this candidate (every fold is under the "
                      "%d-row minimum), so it is the shipped number row for row" % MIN_FIT_N)
        elif would_adopt:
            reason = ("does not regress the shipped number on pooled MAE (%.4f vs %.4f) "
                      "or pooled rank_corr (%.4f vs %.4f)"
                      % (pooled["mae"], shipped["pooled"]["mae"],
                         pooled["rank_corr"], shipped["pooled"]["rank_corr"]))
        else:
            reason = ("regresses the shipped number: pooled MAE %.4f vs %.4f, pooled "
                      "rank_corr %.4f vs %.4f"
                      % (pooled["mae"], shipped["pooled"]["mae"],
                         pooled["rank_corr"], shipped["pooled"]["rank_corr"]))
        out.append({
            "name": key,
            "family": family,
            "position": scope,
            "form": ("proj x (1 + beta_pos x cap_gap)" if family == "cap_gap"
                     else "proj x m_pos when a backup starts"),
            "params": {"by_season": {str(f["season"]): f["params"] for f in fold_results},
                       "clamp": list(FACTOR_CLAMP), "min_fit_n": MIN_FIT_N},
            "fold_results": fold_results,
            "rows_moved": rows_moved,
            "pooled": pooled,
            "held_out": bwk.block(held, key),
            "per_position": {pos: _pos_block(rows, pos, key) for pos in POSITIONS},
            "delta_vs_shipped": {"pooled": _delta(pooled, shipped["pooled"]),
                                 "held_out": _delta(bwk.block(held, key),
                                                    shipped["held_out"])},
            "ci": paired_bootstrap(rows, key),
            "ci_held_out": paired_bootstrap(rows, key, seasons=(held_out,)),
            "would_adopt": would_adopt,
            "reason": reason,
        })
    return shipped, out


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run(actuals, games_doc, dvp_doc, injury_history, epa_doc, depth_by_season,
        tuning_doc=None, seasons=SEASONS_SCORED, held_out=HELD_OUT, lag=STARTER_LAG,
        pool=bwk.POOL, min_fit_n=MIN_FIT_N):
    """The whole experiment on in-memory documents. depth_by_season: {season:
    raw depth-chart rows}. Returns the artifact body (plus "_rows")."""
    t0 = time.time()
    games = bwk.load_games(games_doc)
    params = bwk.game_params(tuning_doc)
    elo_pre = bwk.elo_pre_week(games, params["hfa"], params["k"], params["revert"])
    rows, sched = [], {}
    dvp_rates_at, venue_hfa = {}, {}
    meta = {"pooled": {}, "skipped": {}, "excluded": {}}
    room_by_season, outs_by_season, replacement_by_season, room_meta = {}, {}, {}, {}
    idx = passer_index(epa_doc)
    for season in seasons:
        s_rows, s_sched, s_meta = bwk.build_rows(actuals, games, season, pool)
        rows.extend(s_rows)
        sched[season] = s_sched
        meta["pooled"][str(season)] = s_meta["pooled"]
        for bucket in ("excluded", "skipped"):
            for k, v in s_meta[bucket].items():
                meta[bucket][k] = meta[bucket].get(k, 0) + v
        dvp_rates_at[season] = bwk.dvp_rates_by_week(dvp_doc, season)
        venue_hfa[season] = bwk.venue_hfa_walk_forward(games, season)
        depth = normalize_depth_rows(depth_by_season.get(season) or [])
        first_kick = week_first_kickoffs(games, season)
        room_by_season[season] = qb_depth_by_week(depth, first_kick, lag=lag)
        outs_by_season[season] = qb_outs_by_team_week(injury_history, season)
        replacement_by_season[season] = replacement_level(epa_doc, season)
        room_meta[str(season)] = {
            "depth_rows": len(depth),
            "qb_snapshots": len({str(r["snap"]) for r in depth if r["pos"] == "QB"}),
            "team_weeks_with_a_room": len(room_by_season[season]),
            "qb_out_listings": sum(len(v) for v in outs_by_season[season].values()),
            "replacement_level_epa_per_db": replacement_by_season[season],
        }
    bwk.project_rows(rows, games, sched, elo_pre, dvp_rates_at, venue_hfa)
    coverage = annotate_rows(rows, room_by_season, outs_by_season, idx,
                             replacement_by_season, actuals)
    folds = fit_folds(rows, seasons, min_fit_n)
    names = apply_candidates(rows, folds)
    shipped, candidates = evaluate(rows, names, folds, seasons, held_out)
    adoptable = sorted(c["name"] for c in candidates if c["would_adopt"])
    best = None
    if adoptable:
        by_name = {c["name"]: c for c in candidates}
        best = min(adoptable, key=lambda n: (by_name[n]["pooled"]["mae"], n))
    return {
        "experiment": "backup_qb_cascade_v0",
        "model_incumbent": bw.MODEL_NAME,
        "seasons_scored": list(seasons),
        "held_out": held_out,
        "substrate": {
            "weekly_actuals": bwk.ACTUALS_REL,
            "games_meta": bwk.GAMES_REL,
            "injury_history": INJURY_HISTORY_REL,
            "epa_history": EPA_HISTORY_REL,
            "depth_charts": "nflverse depth_charts_{season} releases",
            "shipped_number": ("%s through scripts/build_weekly.player_weeks, built by "
                               "scripts/backtest_weekly.py's as-of harness (same pool, "
                               "same fixed season number)" % bw.MODEL_NAME),
            "rows": len(rows),
            "pool": dict(pool),
            "starter_lag_weeks": lag,
        },
        "starter_rule": (
            "per team and week: the LATEST depth-chart snapshot whose week is <= wk - %d, "
            "read in QB rank order (one entry per player); QB1 is rank 1. Out = listed "
            "Out or Doubtful on the FINAL report for (team, week). A week with no earlier "
            "snapshot is condition `unknown`, neutral and counted." % lag),
        "capability_rule": (
            "capability = EPA per dropback over the passer's most recent %d dropbacks "
            "strictly before the week (data/epa_history.json); below %d trailing "
            "dropbacks the fold's replacement-level pool stands in (every passer-season "
            "before the scored season under %d dropbacks, pooled). cap_gap = "
            "capability(QB1) - capability(expected starter), 0 when QB1 starts."
            % (TRAILING_DB, MIN_DB, REPLACEMENT_SEASON_DB)),
        "fit_rule": (
            "one parameter set per fold, fitted ONLY on the scored seasons before it "
            "(the earliest scored season is neutral). Least squares of actual on "
            "base x v2 (flat m) and on base x v2 x (1 + beta x cap_gap), where base = "
            "sum(actual)/sum(v2) over that fold's qb1 rows for the position, so the "
            "fit measures the cascade and not the shipped number's generic level. "
            "Fewer than %d backup rows in a fold fits nothing and stays neutral. Every "
            "applied factor is clamped to %s." % (MIN_FIT_N, list(FACTOR_CLAMP))),
        "coverage": coverage,
        "conditions": condition_counts(rows, seasons),
        "qb_subject_rows": qb_subject_counts(rows, seasons),
        "residuals": residuals_by_condition(rows),
        "residuals_by_cap_gap": residuals_by_cap_gap(rows),
        "components": components_by_condition(rows),
        "shipped": shipped,
        "candidates": candidates,
        "verdict": {
            "adopted": False,
            "adoptable_candidates": adoptable,
            "best_adoptable": best,
            "rule": NEVER_REGRESS_RULE,
            "reason": ("phase 1 measures only; %d of %d candidates clear never-regress%s"
                       % (len(adoptable), len(candidates),
                          (" (best by pooled MAE: %s)" % best) if best else "")),
        },
        "policy": POLICY,
        "limits": list(LIMITS),
        "meta": {"rooms": room_meta, "rows_skipped": meta["skipped"],
                 "pool_excluded": meta["excluded"], "pooled_per_season": meta["pooled"],
                 "runtime_s": round(time.time() - t0, 2)},
        "_rows": rows,
    }


def artifact(result):
    doc = {k: v for k, v in result.items() if k != "_rows"}
    out = {"generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    out.update(bwk._round(doc, 4))
    return out


def _f(v, dp=4):
    return "n/a" if v is None else ("%." + str(dp) + "f") % v


def report(result):
    print("BACKUP-QB CASCADE (measure only) — rows %d, coverage %s"
          % (result["substrate"]["rows"], result["coverage"]))
    print("  condition n per season (qb1 / backup / qb3+ / unknown):")
    for pos in POSITIONS:
        cells = []
        for season in result["seasons_scored"]:
            c = result["conditions"][pos][str(season)]
            cells.append("%d: %d/%d/%d/%d" % (season, c["qb1"], c["backup"],
                                              c["qb3_plus"], c["unknown"]))
        print("    %-3s %s" % (pos, "  |  ".join(cells)))
    print("  residual actual - v2 by condition (mean, MAE, actual/v2):")
    for pos in POSITIONS:
        cells = ["%s n=%d %s %s %s" % (cond, c["n"], _f(c["mean_residual"], 2),
                                       _f(c["mae"], 2), _f(c["ratio"], 3))
                 for cond, c in result["residuals"][pos].items() if c["n"]]
        print("    %-3s %s" % (pos, " | ".join(cells)))
    print("  residual by cap_gap bucket (actual/v2):")
    for pos in POSITIONS:
        cells = ["%s n=%d %s" % (b, c["n"], _f(c["ratio"], 3))
                 for b, c in result["residuals_by_cap_gap"][pos].items() if c["n"]]
        print("    %-3s %s" % (pos, " | ".join(cells)))
    sh = result["shipped"]
    print("  shipped %s: pooled MAE %s rank %s topk %s | held-out MAE %s rank %s"
          % (result["model_incumbent"], _f(sh["pooled"]["mae"]), _f(sh["pooled"]["rank_corr"]),
             _f(sh["pooled"]["topk"]), _f(sh["held_out"]["mae"]),
             _f(sh["held_out"]["rank_corr"])))
    print("  candidate            pooled MAE   rank     | dMAE      | boot dMAE [lo, hi]        "
          "| would_adopt")
    for c in result["candidates"]:
        ci = c["ci"]
        print("  %-20s %s %s | %s | %s [%s, %s] | %s"
              % (c["name"], _f(c["pooled"]["mae"]), _f(c["pooled"]["rank_corr"]),
                 _f(c["delta_vs_shipped"]["pooled"]["mae"]), _f(ci["mean"]),
                 _f(ci["lo95"]), _f(ci["hi95"]), c["would_adopt"]))
    print("  VERDICT: %s" % result["verdict"]["reason"])


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def injury_history_has_qbs(doc, seasons=SEASONS_SCORED):
    """True when every scored season carries at least one QB row."""
    for season in seasons:
        teams = (doc.get("seasons") or {}).get(str(season)) or {}
        if not any(str(r.get("position") or "").upper() == "QB"
                   for weeks in teams.values() for rows in weeks.values() for r in rows):
            return False
    return True


def epa_history_has_passers(doc, seasons=SEASONS_SCORED):
    """True when at least one season BEFORE the earliest scored season carries
    passers — capability is trailing, so the first fold needs prior seasons."""
    first = min(seasons)
    for yr, teams in ((doc or {}).get("seasons") or {}).items():
        if int(yr) >= first:
            continue
        for weeks in teams.values():
            for rec in (weeks or {}).values():
                if (rec or {}).get("passers"):
                    return True
    return False


def main(argv):
    cache_dir = None
    if "--cache-dir" in argv:
        cache_dir = argv[argv.index("--cache-dir") + 1]
    lag = STARTER_LAG
    if "--starter-lag" in argv:
        lag = int(argv[argv.index("--starter-lag") + 1])
    out_path = OUT_PATH
    if "--out" in argv:
        out_path = argv[argv.index("--out") + 1]
    for path in (bwk.ACTUALS_PATH, bwk.GAMES_PATH, bw.DVP_PATH, INJURY_HISTORY_PATH,
                 EPA_HISTORY_PATH):
        if not os.path.exists(path):
            print("BACKUP-QB BACKTEST: %s is missing; refusing to score a partial corpus"
                  % os.path.relpath(path, _ROOT), file=sys.stderr)
            return 2
    injury_history = _load(INJURY_HISTORY_PATH)
    if not injury_history_has_qbs(injury_history):
        print("BACKUP-QB BACKTEST: %s carries no QB rows for every scored season %s. Run "
              "`python3 scripts/build_injury_history.py --rebuild` where the nflverse "
              "injuries releases are reachable, then re-run. No result is invented."
              % (INJURY_HISTORY_REL, list(SEASONS_SCORED)), file=sys.stderr)
        return 2
    epa_doc = _load(EPA_HISTORY_PATH)
    if not epa_history_has_passers(epa_doc):
        print("BACKUP-QB BACKTEST: %s carries no passer rows before %d, so no capability "
              "is knowable before the first scored week. No result is invented."
              % (EPA_HISTORY_REL, min(SEASONS_SCORED)), file=sys.stderr)
        return 2
    depth_by_season = {}
    for season in SEASONS_SCORED:
        rows, why = fetch_depth_chart(season, cache_dir)
        if rows is None:
            print("BACKUP-QB BACKTEST: depth chart for %d unavailable (%s); the "
                  "quarterback room cannot be built walk-forward. No result is invented."
                  % (season, why), file=sys.stderr)
            return 2
        depth_by_season[season] = rows
    tuning = _load(bwk.TUNING_PATH) if os.path.exists(bwk.TUNING_PATH) else None
    result = run(_load(bwk.ACTUALS_PATH), _load(bwk.GAMES_PATH), _load(bw.DVP_PATH),
                 injury_history, epa_doc, depth_by_season, tuning, lag=lag)
    report(result)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(artifact(result), fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(out_path, _ROOT))
    return 0


# ---------------------------------------------------------------------------
# Selftest: synthetic fixture with known answers
# ---------------------------------------------------------------------------

SYNTH_CAP = {0: 0.20, 1: 0.00, 2: -0.10}     # planted capability per QB rank index
SYNTH_M = 0.70                               # planted backup multiplier (= 1 - 1.5 x 0.20)
SYNTH_BETA = -1.5                            # planted slope per unit of cap_gap


def _synthetic():
    """bwk._synthetic()'s four-team corpus plus, per season: a legacy-shape
    depth chart with three quarterbacks a team in a stable order; an injury
    history listing QB1 Out in some weeks; an epa_history whose passers have
    the planted capabilities above (QB3 stays under MIN_DB so the replacement
    pool is exercised); and a PLANTED effect — on a backup week, every
    WR / TE / RB actual is multiplied by (1 + SYNTH_BETA x cap_gap)."""
    actuals, games_doc, dvp_doc = bwk._synthetic()
    rng = random.Random(92)
    teams = ["AAA", "BBB", "CCC", "DDD"]
    qb_ids = {t: ["%s-QB%d" % (t, i) for i in range(3)] for t in teams}
    depth_by_season, hist_seasons = {}, {}
    epa_seasons = {}
    backup_weeks = {}      # (season, team, wk) -> cap_gap
    for season in range(2021, 2026):
        rows = []
        for t in teams:
            for wk in range(1, 7):
                for i, pid in enumerate(qb_ids[t]):
                    rows.append({"season": season, "week": wk, "game_type": "REG",
                                 "club_code": t, "full_name": pid, "gsis_id": pid,
                                 "position": "QB", "depth_position": "QB",
                                 "depth_team": str(i + 1)})
        depth_by_season[season] = rows
        # Capability: QB1 and QB2 throw enough to be measured every week; QB3
        # never reaches MIN_DB, so he takes the fold's replacement pool.
        epa_seasons[str(season)] = {}
        for t in teams:
            epa_seasons[str(season)][t] = {}
            for wk in range(1, 7):
                passers = {}
                for i, pid in enumerate(qb_ids[t][:2]):
                    db = 40.0
                    passers[pid] = {"db": db, "epa": SYNTH_CAP[i] * db, "name": pid}
                passers[qb_ids[t][2]] = {"db": 2.0, "epa": SYNTH_CAP[2] * 2.0,
                                         "name": qb_ids[t][2]}
                epa_seasons[str(season)][t][str(wk)] = {"passers": passers}
        if season < 2023:
            continue
        hist_seasons[str(season)] = {}
        for t in teams:
            for wk in range(2, 7):                  # week 1 has no chart under lag 1
                if rng.random() > 0.45:
                    continue
                hist_seasons[str(season)].setdefault(t, {})[str(wk)] = [
                    {"id": qb_ids[t][0], "name": qb_ids[t][0], "position": "QB",
                     "status": "Out"}]
                backup_weeks[(season, t, wk)] = SYNTH_CAP[0] - SYNTH_CAP[1]
    for rec in actuals["players"].values():
        if rec["pos"] not in ("WR", "TE", "RB"):
            continue
        for season_s, lines in (rec.get("seasons") or {}).items():
            for wk_s, line in lines.items():
                gap = backup_weeks.get((int(season_s), line[0], int(wk_s)))
                if gap:
                    line[2] = round(line[2] * (1.0 + SYNTH_BETA * gap), 2)
    injury_history = {"generated_utc": "x", "source": "synthetic",
                      "seasons": hist_seasons}
    epa_doc = {"generated_utc": "x", "source": "synthetic", "seasons": epa_seasons}
    return actuals, games_doc, dvp_doc, injury_history, epa_doc, depth_by_season


def selftest():
    # --- the room, and the condition it implies -------------------------------
    depth = normalize_depth_rows([
        {"week": w, "club_code": "KC", "full_name": n, "gsis_id": n, "position": "QB",
         "depth_position": "QB", "depth_team": str(i + 1), "game_type": "REG"}
        for w in (1, 2) for i, n in enumerate(("A", "B", "C"))] + [
        {"week": 2, "club_code": "KC", "full_name": "Z", "gsis_id": "Z", "position": "WR",
         "depth_position": "WR", "depth_team": "1", "game_type": "REG"}])
    room = qb_depth_by_week(depth, {}, weeks=4, lag=1)
    assert ("KC", 1) not in room, "week 1 has no snapshot strictly before it"
    assert room[("KC", 2)] == [(1, "A", "A"), (2, "B", "B"), (3, "C", "C")], room[("KC", 2)]
    assert room[("KC", 4)] == room[("KC", 2)], "the latest usable snapshot carries forward"
    assert qb_depth_by_week(depth, {}, weeks=4, lag=0)[("KC", 1)][0][1] == "A"
    r = room[("KC", 2)]
    assert room_condition(r, set())[0] == "qb1"
    assert room_condition(r, {"A"})[0] == "backup"
    assert room_condition(r, {"A"})[2] == (2, "B", "B"), "expected starter is QB2"
    assert room_condition(r, {"A", "B"})[0] == "qb3_plus"
    assert room_condition(r, {"A", "B"})[2] == (3, "C", "C")
    assert room_condition(r, {"A", "B", "C"}) == ("qb3_plus", (1, "A", "A"), None), \
        "a whole room out is still qb3_plus, with no expected starter"
    assert room_condition(None, set()) == ("unknown", None, None)
    assert room_condition(r, {"B"})[0] == "qb1", "QB2 out with QB1 healthy is the baseline"

    # --- outs: Out and Doubtful, never Questionable ---------------------------
    hist = {"seasons": {"2024": {"LA": {"3": [
        {"id": "q1", "name": "q1", "position": "QB", "status": "Out"},
        {"id": "q2", "name": "q2", "position": "QB", "status": "Doubtful"},
        {"id": "q3", "name": "q3", "position": "QB", "status": "Questionable"},
        {"id": "w1", "name": "w1", "position": "WR", "status": "Out"}]}}}}
    assert qb_outs_by_team_week(hist, 2024) == {("LAR", 3): {"q1", "q2"}}, \
        qb_outs_by_team_week(hist, 2024)

    # --- capability, the trailing window and the replacement pool -------------
    epa = {"seasons": {"2022": {"KC": {str(w): {"passers": {
        "A": {"db": 60.0, "epa": 12.0, "name": "A"},         # 0.20 / dropback, a starter
        "B": {"db": 30.0, "epa": 0.0, "name": "B"},          # 0.00 / dropback, a backup
        "C": {"db": 1.0, "epa": -0.5, "name": "C"}}} for w in range(1, 7)}}}}
    idx = passer_index(epa)
    val, db = trailing_capability(idx, "A", 2023, 1)
    assert abs(val - 0.20) < 1e-12 and db == 360.0, (val, db)
    assert trailing_capability(idx, "C", 2023, 1) == (None, 6.0), "under MIN_DB"
    assert trailing_capability(idx, "A", 2022, 1) == (None, 0.0), "nothing before week 1"
    early, edb = trailing_capability(idx, "A", 2022, 5)
    assert abs(early - 0.20) < 1e-12 and edb == 240.0, "strictly-before is respected"
    rep = replacement_level(epa, 2023)
    # A threw 360 dropbacks in 2022 and is not replacement level; B (180) and C (6) are.
    assert abs(rep - (0.0 + -0.5 * 6) / (180.0 + 6.0)) < 1e-12, rep
    assert replacement_level(epa, 2022) is None, "no earlier season -> no pool"
    gap, src = cap_gap_for(idx, 2023, 1, (1, "A", "A"), (2, "B", "B"), rep)
    assert abs(gap - 0.20) < 1e-12 and src == "measured/measured", (gap, src)
    gap3, src3 = cap_gap_for(idx, 2023, 1, (1, "A", "A"), (3, "C", "C"), rep)
    assert abs(gap3 - (0.20 - rep)) < 1e-12 and src3 == "measured/replacement", src3
    assert cap_gap_for(idx, 2023, 1, (1, "A", "A"), (1, "A", "A"), rep) == (0.0, "qb1_starts")
    assert cap_gap_for(idx, 2023, 1, (1, "A", "A"), None, None)[0] is None, "absent, not guessed"
    assert cap_gap_bucket("qb1", 0.0) == "none" and cap_gap_bucket("backup", None) == "unknown"
    assert cap_gap_bucket("backup", -0.01) == "neg" and cap_gap_bucket("backup", 0.2) == "0.15+"
    assert cap_gap_bucket("backup", 0.04) == "0.00-0.05"
    assert cap_gap_bucket("backup", 0.05) == "0.05-0.15"

    # --- the fit on a toy fold, with an exact known answer --------------------
    toy = []
    for i in range(40):
        toy.append({"pos": "WR", "cond": "qb1", "v2": 10.0 + i, "actual": 10.0 + i,
                    "cap_gap": 0.0})
    for i in range(40):
        toy.append({"pos": "WR", "cond": "backup", "v2": 10.0 + i,
                    "actual": SYNTH_M * (10.0 + i), "cap_gap": 0.2})
    fit = fit_position(toy, "WR")
    assert abs(fit["base"] - 1.0) < 1e-12, fit
    assert abs(fit["m"] - SYNTH_M) < 1e-9, fit["m"]
    assert abs(fit["beta"] - SYNTH_BETA) < 1e-9, fit["beta"]
    assert fit["n_backup"] == 40 and fit["n_baseline"] == 40 and fit["note"] == "fitted"
    thin = fit_position(toy[:40] + toy[40:45], "WR")
    assert thin["m"] == 1.0 and thin["beta"] == 0.0 and "only 5 backup rows" in thin["note"]
    assert fit_position([], "WR")["note"].startswith("neutral: no baseline")
    row = {"cond": "backup", "cap_gap": 0.2}
    assert abs(row_factor("cap_gap", row, fit) - SYNTH_M) < 1e-9
    assert abs(row_factor("backup_flat", row, fit) - SYNTH_M) < 1e-9
    assert row_factor("cap_gap", {"cond": "qb1", "cap_gap": 0.0}, fit) == 1.0
    assert row_factor("cap_gap", {"cond": "unknown", "cap_gap": None}, fit) == 1.0
    assert row_factor("cap_gap", {"cond": "backup", "cap_gap": None}, fit) == 1.0
    wild = {"base": 1.0, "m": 9.0, "beta": -99.0, "n_backup": 99, "n_baseline": 99,
            "note": "fitted"}
    assert row_factor("backup_flat", row, wild) == FACTOR_CLAMP[1], "the clamp holds"
    assert row_factor("cap_gap", row, wild) == FACTOR_CLAMP[0]

    # --- the whole experiment on the synthetic corpus -------------------------
    actuals, games_doc, dvp_doc, hist_doc, epa_doc, depth = _synthetic()
    assert injury_history_has_qbs(hist_doc) and epa_history_has_passers(epa_doc)
    res = run(actuals, games_doc, dvp_doc, hist_doc, epa_doc, depth, min_fit_n=5)
    rows = res["_rows"]
    assert res["substrate"]["rows"] > 0
    assert res["coverage"]["chart_known"] > 0
    assert res["coverage"]["chart_known"] < res["coverage"]["rows"], "week 1 is unknown"
    assert res["coverage"]["cap_gap_known"] > 0
    backup = [r for r in rows if r["cond"] == "backup"]
    assert backup, "the planted backup weeks must be found"
    assert all(abs(r["cap_gap"] - 0.20) < 1e-9 for r in backup), "planted cap_gap"
    for pos in ("WR", "TE", "RB"):
        cells = res["residuals"][pos]
        assert cells["qb1"]["n"] and cells["backup"]["n"], cells
        assert cells["backup"]["ratio"] < cells["qb1"]["ratio"], \
            "%s: the planted backup dip must show in the residual table" % pos
    assert res["conditions"]["WR"]["2025"]["unknown"] > 0
    assert set(res["residuals_by_cap_gap"]["WR"]) == set(CAP_GAP_BUCKETS)
    later = res["candidates"][0]["fold_results"][-1]
    assert later["fit_seasons"] == [2023, 2024], later["fit_seasons"]
    assert res["candidates"][0]["fold_results"][0]["fit_seasons"] == []
    by_name = {c["name"]: c for c in res["candidates"]}
    assert len(by_name) == len(FAMILIES) * len(SCOPES)
    wr = by_name["backup_flat_WR"]
    fitted = wr["params"]["by_season"]["2025"]["WR"]
    # The synthetic corpus is four teams of noisy points, so the recovered m is the
    # planted one within sampling noise; the EXACT recovery is asserted on the toy
    # fold above, where the answer is known to the digit.
    assert abs(fitted - SYNTH_M) < 0.12, "the fold fit must recover the planted m: %r" % fitted
    assert wr["pooled"]["mae"] < res["shipped"]["pooled"]["mae"], "the planted dip must help"
    cap = by_name["cap_gap_WR"]
    assert abs(cap["params"]["by_season"]["2025"]["WR"] - SYNTH_BETA) < 0.6, \
        cap["params"]["by_season"]["2025"]["WR"]
    assert all(isinstance(c["would_adopt"], bool) for c in res["candidates"])
    assert res["verdict"]["adopted"] is False, "phase 1 adopts nothing"
    # A no-op candidate never counts as adoptable: raise the fit minimum above every
    # fold's row count and the same corpus must produce zero adoptable candidates.
    noop = run(actuals, games_doc, dvp_doc, hist_doc, epa_doc, depth, min_fit_n=10 ** 6)
    assert noop["verdict"]["adoptable_candidates"] == [], noop["verdict"]
    for c in noop["candidates"]:
        assert c["rows_moved"] == 0 and c["would_adopt"] is False
        assert "no fold could fit" in c["reason"], c["reason"]
        assert c["pooled"]["mae"] == noop["shipped"]["pooled"]["mae"]
    qb_only = by_name["backup_flat_QB"]
    moved = [r for r in rows if abs(r["backup_flat_QB"] - r["v2"]) > 1e-12]
    assert moved and all(r["pos"] == "QB" for r in moved), "a scoped candidate moves its own rows"
    assert qb_only["per_position"]["WR"] == res["shipped"]["per_position"]["WR"]

    # --- the artifact ---------------------------------------------------------
    doc = artifact(res)
    json.dumps(doc, ensure_ascii=True)
    assert "_rows" not in doc
    for key in ("generated_utc", "seasons_scored", "substrate", "conditions", "residuals",
                "candidates", "verdict", "policy", "limits"):
        assert key in doc, key
    assert doc["verdict"]["adopted"] is False
    print("selftest OK: walk-forward quarterback room, condition assignment, cap_gap with "
          "the replacement pool, the fold fit recovering the planted m and beta, the "
          "planted dip visible in the residual table, scoped candidates, artifact clean")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
