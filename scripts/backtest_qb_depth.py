"""Walk-forward QB DEPTH CASCADE experiment (R92 part A: MEASURE ONLY).

The owner's order (2026-09-20):

  "there should be a drop if QB1 is out. And another if QB2 is out. And then
   look at the capability of QB3. This should apply to all key positions on
   offense and defense."

This file answers the QB half of that order with a number instead of an
opinion. It builds a per-team-game substrate that is leak-free by
construction, prices four candidate `qb_depth` shapes on top of it, and scores
each one on the SAME walk-forward held-out log-loss the promotion gate uses,
against the params production actually ships today (hfa 45, revert 0.45, k 25,
`qb_out` scale 75 in effect). It changes NO shipped number: nothing here writes
game_params, and the family it defines reaches a prediction only after the
weekly promotion run adopts it under the existing never-regress rule.

WHY A SEPARATE SUBSTRATE. The shipped `qb_out` family knows exactly one thing:
"the season's cumulative dropback leader is listed Out/Doubtful". It cannot
tell a team whose QB2 also went down from one whose healthy QB2 is a former
starter, and it has no notion of QB3 at all. The order asks for both, so the
substrate has to carry a DEPTH ORDER (who is QB1, QB2, QB3 this week) and a
CAPABILITY (how good is the man who will actually take the snaps). Those are
two different feeds - the nflverse depth-chart release and epa_history's
per-passer dropback record - and both are read strictly as of before kickoff.

SUBSTRATE (every input restricted to what was knowable before kickoff):

  * DEPTH ORDER - the nflverse depth-chart release per season, read through
    build_line_report.fetch_depth_chart (the same CSV cache the line report
    uses, so --cache-dir is shareable with it). For team T in week wk the
    order is the QB rows of the LATEST snapshot whose week is <= wk - LAG
    (default lag 1: snapshots strictly before the week - the backtest_lines
    STARTER RULE), ranked by pos_rank. The 2025+ release is dated per snapshot
    (`dt`); a snapshot belongs to the first week whose first kickoff is after
    it. The legacy release is dated per `week`.

    Why the LATEST usable snapshot rather than backtest_lines' modal tally: a
    tally answers "which five players are the OL", a set question where the
    membership is what matters. This is an ORDER question - QB1 before QB2
    before QB3 - and a tally across two different depth charts cannot produce
    one consistent ordering when the chart changed. The latest chart before
    the week IS the pregame expectation.

    Week 1 of a season has no in-season snapshot at lag 1, so it uses the
    PRIOR season's final chart. When that is absent too (a season whose
    predecessor was not fetched) the team-game is NEUTRAL and COUNTED, never
    guessed.

  * OUT/DOUBTFUL - data/injury_history.json, the FINAL report for (team,
    week), QB rows with status Out or Doubtful. Pregame by construction.
    `qb1_out` / `qb2_out` are those flags for the depth order's rank-1 and
    rank-2 players. Ids join first (gsis), names second; nothing is guessed.

  * EXPECTED STARTER - the highest-ranked QB on the order NOT listed
    Out/Doubtful. QB3 when QB1 and QB2 are both out, QB4 when three are, and
    None when the chart lists nobody who is available (counted, never
    invented).

  * CAPABILITY - EPA per dropback over a passer's TRAILING dropbacks before
    the week, across seasons, from data/epa_history.json's per-week `passers`
    record. A passer with fewer than MIN_DROPBACKS (100) prior dropbacks has
    no measured capability of his own and takes REPLACEMENT level: the pooled
    EPA/db of every passer who threw fewer than 100 dropbacks in the whole of
    that fold's TRAINING WINDOW (the seasons before the evaluated one).
    Computed once per fold, from training data only. Pooling by PASSER rather
    than by passer-week is what keeps it replacement level: a week-by-week rule
    would sweep every starter's first three weeks into the pool, because a
    starter is also under 100 prior dropbacks in September.

    cap_gap = capability(QB1) - capability(expected starter), and exactly 0.0
    when QB1 is the expected starter. It is the measured quality the team
    actually loses, which is the "look at the capability of QB3" half of the
    order: a team whose QB3 has thrown 400 good dropbacks loses less than one
    whose QB3 has never played.

CANDIDATES - each a per-game additive delta on hfa_eff in Elo points, home
side minus and away side plus, exactly like the shipped `qb_out`:

  qb1_out     scale x 1[QB1 out]                       (the shipped family,
                                                        RE-MEASURED on this
                                                        substrate - the depth
                                                        chart's QB1, not the
                                                        dropback leader)
  qb1_qb2     scale x 1[QB1 out] + extra x 1[QB2 out]  (the second drop)
  capability  cap_scale x cap_gap                      (the drop IS the
                                                        replacement's measured
                                                        quality)
  combined    all three terms

SCORING - scripts/promote_signals.evaluate(), the promotion gate's own
walk-forward: seasons 2021-2025, 2022-2025 evaluated, ratings updated on the
FLAT hfa so a candidate shifts pricing only. The baseline is the incumbent
production ships, rebuilt by _incumbent_family_fns (qb_out at 75 today). A
candidate walk drops the shipped qb_out builder and installs the qb_depth
builder in its place - NEVER BOTH, because qb_depth's first term IS the QB1
drop and running them together would price one absence twice.

ADOPTION RULE - the harness's, unchanged: paired per-game log-loss
differences, CR1 cluster-robust over the walk-forward folds, one-sided
Student-t at alpha 0.05 Bonferroni-corrected over the number of candidate
FAMILIES measured here, floored at the effect floor. `would_adopt` on each
candidate is that rule applied verbatim (promote_signals.should_adopt). This
run ADOPTS NOTHING: the verdict is a recommendation for the weekly promotion
run, and "none" is a valid verdict.

LIMITS, stated rather than inferred: the depth release is a listing, not a
lineup card, so a chart that never caught up to a mid-week change is wrong in
the same way the team's own public chart was wrong; the legacy (pre-2025)
release lists two QBs for most team-weeks, so QB3 is frequently unknown there
and the deeper conditions are thinner than 2025's; capability is EPA per
dropback with no opponent or situation adjustment; and the order's "all key
positions on offense and defense" is deliberately NOT attempted here - the
shipped `skill_out` family covers RB/WR/TE by usage share and the line
cascade lives in scripts/backtest_lines.py, so widening this substrate is a
separate measurement, not a wider grid.

Stdlib only. Nothing here reads a market number.
"""

import argparse
import datetime as dt
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import promote_signals as ps                       # noqa: E402
from scripts.build_line_report import (                         # noqa: E402
    fetch_depth_chart, name_key, norm_team, normalize_depth_rows)

DATA = os.path.join(_ROOT, "data")
INJURY_PATH = os.path.join(DATA, "injury_history.json")
EPA_PATH = os.path.join(DATA, "epa_history.json")
OUT_PATH = os.path.join(DATA, "qb_depth_backtest.json")

# The line report caches depth releases as <cache-dir>/depth_charts_<season>.csv.
# Defaulting into the system temp dir keeps a measurement run from dirtying the
# repo, and pointing --cache-dir at the line report's own cache shares the pull.
DEFAULT_CACHE_DIR = os.path.join(
    os.environ.get("TMPDIR") or "/tmp", "nflverse_cache")

STARTER_LAG = 1                    # snapshots STRICTLY before the week
OUT_STATUSES = ("Out", "Doubtful")  # the shipped qb_out vocabulary, unchanged
# ONE source of truth with the family itself: the gate and the prediction
# builder read promote_signals.QB_DEPTH_MIN_DROPBACKS, and so does this.
MIN_DROPBACKS = ps.QB_DEPTH_MIN_DROPBACKS

# Grids. Each family is ONE hypothesis measured at several amplitudes of the
# same per-game delta vector (the multiplicity unit promote_signals charges).
QB1_SCALES = (50.0, 75.0, 100.0, 125.0)
QB2_EXTRAS = (0.0, 25.0, 50.0, 75.0, 100.0)
# Elo per unit of EPA/dropback lost. A QB1-to-QB3 gap is typically 0.05-0.30
# EPA/db, so 100-500 spans "barely priced" to "a full qb_out's worth".
CAP_SCALES = (100.0, 200.0, 300.0, 400.0, 500.0)
COMBINED_QB1 = (25.0, 50.0, 75.0, 100.0)
COMBINED_QB2 = (0.0, 50.0, 100.0)
COMBINED_CAP = (100.0, 200.0, 300.0)

POLICY = [
    "MEASUREMENT ONLY. This run writes no model parameter: data/model_tuning.json "
    "game_params is untouched and the qb_depth family ships with applied=false.",
    "Every input is restricted to what was knowable before kickoff: depth-chart "
    "snapshots strictly before the week, the final injury report for the week, and "
    "passer dropbacks accumulated before the week.",
    "Absent data is COUNTED, never invented: a team-week with no usable depth chart "
    "is neutral and appears in the unknown counts, and a season whose depth release "
    "could not be fetched is named in substrate.seasons_unavailable.",
    "Adoption, if it ever happens, happens in the weekly promotion run under the "
    "existing never-regress rule; would_adopt here is that rule reported, not applied.",
    "No market number reaches any probability in this document.",
]

LIMITS = [
    "The depth-chart release is a public listing, not a lineup card: a chart that "
    "did not catch up to a mid-week change is wrong here exactly as it was wrong "
    "in public, and that error is not correctable after the fact.",
    "The legacy (pre-2025) release lists two QBs for most team-weeks, so QB3 is "
    "frequently unknown in 2022-2024 and the qb3_or_deeper_started counts for those "
    "seasons are a floor, not a census.",
    "Capability is raw EPA per dropback with no opponent, game-script or situation "
    "adjustment, so a backup whose sample came in garbage time reads better than he is.",
    "Four evaluated folds give the cluster-robust test three degrees of freedom, so "
    "the significance bar is very high and a real effect of this size can fail it. A "
    "'none' verdict here is 'not proven on 1,084 games', not 'no effect'.",
    "The order's 'all key positions on offense and defense' is not attempted here: "
    "RB/WR/TE absence is the shipped skill_out family and the line cascade is "
    "scripts/backtest_lines.py. Widening the substrate is a separate measurement.",
]


# ---------------------------------------------------------------------------
# Depth order, walk-forward
# ---------------------------------------------------------------------------

def week_first_kickoffs(games):
    """{week: 'YYYY-MM-DD'} - the date of a week's first kickoff, from the
    finals fixtures. Used to place a dated (2025+) snapshot in a week."""
    first = {}
    for g in games:
        d = str(g.get("kickoff_utc") or g.get("gameday") or "")[:10]
        if not d:
            continue
        wk = int(g.get("week") or 0)
        if not wk:
            continue
        if wk not in first or d < first[wk]:
            first[wk] = d
    return first


def snapshot_week(snap, first_kick):
    """The week a snapshot precedes: the legacy integer week as is, or for a
    dated snapshot the smallest week whose first kickoff is after it. None when
    the snapshot follows every kickoff (a postseason chart)."""
    if isinstance(snap, int):
        return snap
    d = str(snap)[:10]
    for wk in sorted(first_kick):
        if d < first_kick[wk]:
            return wk
    return None


def player_id(row):
    """The join key for a depth-chart player: his gsis id, else a name key.
    Prefixed when it is a name so a name can never collide with a gsis id."""
    gid = (row.get("gsis_id") or "").strip()
    return gid or ("name:" + name_key(row.get("name")))


def _snapshot_orders(depth_rows):
    """{(team, snap): [pid, ...]} - one rank-ordered QB list per snapshot.

    Duplicates keep their BEST (lowest) rank: a chart that lists a man twice
    still has him at one place in the order."""
    per = {}
    for r in depth_rows:
        if r["pos"] != "QB":
            continue
        per.setdefault((r["team"], r["snap"]), {})
        best = per[(r["team"], r["snap"])]
        pid = player_id(r)
        if pid not in best or r["rank"] < best[pid]:
            best[pid] = r["rank"]
    return {key: [p for p, _ in sorted(v.items(), key=lambda kv: (kv[1], kv[0]))]
            for key, v in per.items()}


def depth_orders(depth_by_season, finals_by_year, seasons, lag=STARTER_LAG):
    """{(season, team, week): [pid rank-ordered]} for every season in `seasons`.

    For week wk the order comes from the LATEST snapshot whose week is
    <= wk - lag. Week 1 has no such snapshot, so it takes the PRIOR season's
    final chart when that season was fetched; otherwise the team-week is absent
    from the map, which the substrate records as unknown and counts."""
    normed = {yr: normalize_depth_rows(rows)
              for yr, rows in depth_by_season.items()}
    orders_by_snap = {yr: _snapshot_orders(rows) for yr, rows in normed.items()}
    # Prior-season final chart per team: the largest snap key that season has.
    final_chart = {}
    for yr, snaps in orders_by_snap.items():
        by_team = {}
        for (team, snap), order in snaps.items():
            cur = by_team.get(team)
            if cur is None or _snap_sort_key(snap) > _snap_sort_key(cur[0]):
                by_team[team] = (snap, order)
        final_chart[yr] = {t: o for t, (_s, o) in by_team.items()}
    out = {}
    for yr in seasons:
        snaps = orders_by_snap.get(yr)
        if snaps is None:
            continue                       # season unavailable; counted upstream
        first_kick = week_first_kickoffs(finals_by_year.get(yr) or [])
        weeks = sorted(first_kick) or [1]
        # (team -> [(snapweek, snap, order)]) placed and sorted once.
        placed = {}
        for (team, snap), order in snaps.items():
            sw = snapshot_week(snap, first_kick)
            if sw is None:
                continue
            placed.setdefault(team, []).append((sw, snap, order))
        for team in set(list(placed) + list(final_chart.get(yr - 1) or {})):
            rows = sorted(placed.get(team) or [],
                          key=lambda t: (t[0], _snap_sort_key(t[1])))
            for wk in weeks:
                usable = [r for r in rows if r[0] <= wk - lag]
                if usable:
                    out[(yr, team, wk)] = list(usable[-1][2])
                else:
                    prev = (final_chart.get(yr - 1) or {}).get(team)
                    if prev:
                        out[(yr, team, wk)] = list(prev)
    return out


def _snap_sort_key(snap):
    """Order snapshots of one season: integers stay integers, dates stay dates.
    A season never mixes the two shapes, so the two orders never meet."""
    return (0, snap, "") if isinstance(snap, int) else (1, 0, str(snap))


# ---------------------------------------------------------------------------
# Injury report and capability
# ---------------------------------------------------------------------------

def qb_outs(injury_doc):
    """{(season, week, team): {id}} - QB rows listed Out or Doubtful on the
    final report. Each row contributes BOTH its gsis id and its name key, so a
    depth-chart player joins on whichever of the two he carries."""
    out = {}
    for yr_s, teams in ((injury_doc or {}).get("seasons") or {}).items():
        for team, weeks in teams.items():
            for wk_s, rows in weeks.items():
                ids = set()
                for r in rows or []:
                    if r.get("position") != "QB" or r.get("status") not in OUT_STATUSES:
                        continue
                    if r.get("id"):
                        ids.add(r["id"])
                    if r.get("name"):
                        ids.add("name:" + name_key(r["name"]))
                if ids:
                    out[(int(yr_s), int(wk_s), norm_team(team))] = ids
    return out


def capability_tables(epa_doc, seasons, query_weeks=None):
    """(cap_at, replacement_by_fold).

    cap_at[(season, week)] -> {pid: (dropbacks, epa)} accumulated over every
    passer-week BEFORE that (season, week), across seasons. Snapshots are taken
    before the point's own cells are folded in, so a week can never see itself.

    `query_weeks` are (season, week) pairs the caller will ask about. They are
    merged into the walk so a scheduled week with no passer record of its own
    (a bye, the live season) still gets a snapshot of everything before it
    rather than a KeyError or a silently older window.

    replacement_by_fold[season] -> REPLACEMENT LEVEL for that fold: the pooled
    EPA/db of every passer who threw fewer than MIN_DROPBACKS dropbacks in the
    whole TRAINING WINDOW (the seasons before the evaluated one). Pooling by
    PASSER, not by passer-week, is what makes this replacement level and not a
    league average: a week-by-week rule would sweep every starter's first three
    weeks into the pool, because a starter also has under 100 prior dropbacks
    in September. None when the training window holds no such passer."""
    doc = (epa_doc or {}).get("seasons") or {}
    points = set()
    for yr_s, teams in doc.items():
        for team_weeks in teams.values():
            for wk_s in team_weeks:
                points.add((int(yr_s), int(wk_s)))
    points.update((int(y), int(w)) for y, w in (query_weeks or ()))
    cum = {}                              # pid -> [db, epa], everything so far
    cap_at = {}
    replacement = {}
    year_seen = None
    for yr, wk in sorted(points):
        if yr != year_seen:               # a fold's training window ends here
            replacement[yr] = _replacement_level(cum)
            year_seen = yr
        cap_at[(yr, wk)] = {p: (v[0], v[1]) for p, v in cum.items()}
        for team_weeks in (doc.get(str(yr)) or {}).values():
            cell = team_weeks.get(str(wk))
            if not isinstance(cell, dict):
                continue
            for pid, rec in (cell.get("passers") or {}).items():
                acc = cum.setdefault(pid, [0.0, 0.0])
                acc[0] += float(rec.get("db") or 0.0)
                acc[1] += float(rec.get("epa") or 0.0)
    for yr in seasons:
        replacement.setdefault(yr, _replacement_level(cum))
    return cap_at, replacement


def _replacement_level(cum):
    """Pooled EPA/dropback of every passer under MIN_DROPBACKS in `cum`."""
    epa = db = 0.0
    for d, e in cum.values():
        if d < MIN_DROPBACKS:
            epa += e
            db += d
    return (epa / db) if db else None


def capability(pid, cap_map, replacement):
    """EPA/dropback for a passer as of the week, or REPLACEMENT level when he
    has thrown fewer than MIN_DROPBACKS. None when neither is measurable."""
    rec = cap_map.get(pid) if pid else None
    if rec and rec[0] >= MIN_DROPBACKS:
        return rec[1] / rec[0]
    return replacement


# ---------------------------------------------------------------------------
# The substrate
# ---------------------------------------------------------------------------

def build_substrate(orders, outs, cap_at, replacement, finals_by_year, seasons):
    """{(season, week, team): row} for every team-game of `seasons`.

    row = {known, depth_n, qb1_out, qb2_out, expected_rank, cap_gap, cap_known}.
    `known` false means no depth order was available for that team-week: the
    row is neutral (every candidate prices it 0.0) and it is COUNTED."""
    sub = {}
    for yr in seasons:
        rep = replacement.get(yr)
        for g in finals_by_year.get(yr) or []:
            wk = int(g.get("week") or 0)
            cap_map = cap_at.get((yr, wk)) or {}
            for side in ("home", "away"):
                team = g[side]
                key = (yr, wk, team)
                if key in sub:
                    continue
                order = orders.get((yr, team, wk))
                if not order:
                    sub[key] = {"known": False, "depth_n": 0, "qb1_out": False,
                                "qb2_out": False, "expected_rank": None,
                                "cap_gap": 0.0, "cap_known": False}
                    continue
                out_ids = outs.get((yr, wk, team)) or frozenset()
                qb1 = order[0]
                qb2 = order[1] if len(order) > 1 else None
                qb1_out = qb1 in out_ids
                qb2_out = bool(qb2) and qb2 in out_ids
                expected = next((p for p in order if p not in out_ids), None)
                expected_rank = (order.index(expected) + 1) if expected else None
                cap_gap = 0.0
                cap_known = False
                if qb1_out and expected is not None:
                    c1 = capability(qb1, cap_map, rep)
                    ce = capability(expected, cap_map, rep)
                    if c1 is not None and ce is not None:
                        cap_gap = c1 - ce
                        cap_known = True
                elif not qb1_out:
                    cap_known = True          # gap is exactly 0: QB1 starts
                sub[key] = {"known": True, "depth_n": len(order),
                            "qb1_out": qb1_out, "qb2_out": qb2_out,
                            "expected_rank": expected_rank,
                            "cap_gap": cap_gap, "cap_known": cap_known}
    return sub


def condition_counts(sub, finals_by_year, seasons):
    """Per-season team-game counts for every condition the owner asked to see.
    Counted over SCORED team-games (two per game), not over the substrate keys,
    so the n beside a log-loss is the n that log-loss was measured on."""
    keys = ("team_games", "depth_known", "depth_unknown", "qb1_out",
            "qb2_also_out", "qb3_or_deeper_started", "cap_gap_measured")
    counts = {k: {} for k in keys}
    for yr in seasons:
        acc = dict.fromkeys(keys, 0)
        for g in finals_by_year.get(yr) or []:
            wk = int(g.get("week") or 0)
            for side in ("home", "away"):
                row = sub.get((yr, wk, g[side]))
                acc["team_games"] += 1
                if not row or not row["known"]:
                    acc["depth_unknown"] += 1
                    continue
                acc["depth_known"] += 1
                if not row["qb1_out"]:
                    continue
                acc["qb1_out"] += 1
                if row["qb2_out"]:
                    acc["qb2_also_out"] += 1
                if (row["expected_rank"] or 0) >= 3:
                    acc["qb3_or_deeper_started"] += 1
                if row["cap_known"] and row["cap_gap"]:
                    acc["cap_gap_measured"] += 1
        for k in keys:
            counts[k][str(yr)] = acc[k]
    return counts


# ---------------------------------------------------------------------------
# The family: one pure penalty, one harness builder
# ---------------------------------------------------------------------------

# THE FAMILY ITSELF LIVES IN promote_signals. One definition, three callers:
# this measurement, the weekly gate's trial, and the prediction builder. A
# second copy here would be a copy to grade instead of the code that ships.
qb_depth_penalty = ps.qb_depth_penalty      # (row, qb1, qb2_extra, cap) -> Elo drop
qb_depth_delta = ps.qb_depth_delta          # per-game delta on hfa_eff
qb_depth_builder = ps.qb_depth_builder      # the (setup, factory) harness builder


def n_fired(sub, finals_by_year, seasons, qb1_scale, qb2_extra, cap_scale):
    """Scored team-games this parameterisation actually prices away from 0.0."""
    n = 0
    for yr in seasons:
        for g in finals_by_year.get(yr) or []:
            wk = int(g.get("week") or 0)
            for side in ("home", "away"):
                if qb_depth_penalty(sub.get((yr, wk, g[side])),
                                    qb1_scale, qb2_extra, cap_scale):
                    n += 1
    return n


# ---------------------------------------------------------------------------
# Substrate assembly (also the entry point promote_signals imports)
# ---------------------------------------------------------------------------

def _load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def walk_forward_substrate(cache_dir=None, seasons=None, finals_by_year=None,
                           injury_doc=None, epa_doc=None, offline=False,
                           verbose=False):
    """(substrate, diagnostics) for the walk, or None when it cannot be built.

    None means SKIP LOUDLY, never price a neutral 0.0 across the walk: an
    uncovered fold scores exact ties, ties count in n and in the cluster-robust
    variance, and "no data here" would be archived as "no help here"."""
    seasons = list(seasons or ps.SEASONS)
    if finals_by_year is None:
        finals_by_year = {yr: ps.load_finals(yr) for yr in seasons}
    injury_doc = injury_doc if injury_doc is not None else _load_json(INJURY_PATH)
    epa_doc = epa_doc if epa_doc is not None else _load_json(EPA_PATH)
    if not injury_doc or not epa_doc:
        return None
    # Week 1 of the first season takes the prior season's final chart, so the
    # pull reaches one season further back than the walk does.
    want = [seasons[0] - 1] + seasons
    depth_by_season = {}
    unavailable = {}
    for yr in want:
        if offline:
            unavailable[str(yr)] = "offline run (--offline)"
            continue
        rows, why = fetch_depth_chart(yr, cache_dir)
        if rows is None:
            unavailable[str(yr)] = why
            if verbose:
                print("  depth chart %d UNAVAILABLE: %s" % (yr, why))
            continue
        depth_by_season[yr] = rows
    scored = [yr for yr in seasons if yr in depth_by_season]
    if not scored:
        return None
    orders = depth_orders(depth_by_season, finals_by_year, scored)
    outs = qb_outs(injury_doc)
    query_weeks = {(yr, int(g.get("week") or 0))
                   for yr in seasons for g in (finals_by_year.get(yr) or [])}
    cap_at, replacement = capability_tables(epa_doc, seasons, query_weeks)
    sub = build_substrate(orders, outs, cap_at, replacement, finals_by_year, seasons)
    diagnostics = {
        "seasons_requested": [str(y) for y in want],
        "seasons_fetched": [str(y) for y in sorted(depth_by_season)],
        "seasons_unavailable": unavailable,
        "starter_lag_weeks": STARTER_LAG,
        "min_dropbacks": MIN_DROPBACKS,
        "out_statuses": list(OUT_STATUSES),
        "replacement_epa_per_db": {
            str(y): (round(v, 5) if v is not None else None)
            for y, v in sorted(replacement.items()) if y in seasons},
        "depth_source": "nflverse depth_charts_{season} releases",
        "injury_source": "data/injury_history.json (final weekly report)",
        "capability_source": "data/epa_history.json seasons[yr][team][wk].passers",
        "rule": ("QB1/QB2 are the rank-1 and rank-2 QBs of the latest depth-chart "
                 "snapshot whose week is <= wk - %d; week 1 uses the prior season's "
                 "final chart; the expected starter is the highest-ranked QB not "
                 "listed Out/Doubtful on that week's final report; cap_gap is "
                 "capability(QB1) - capability(expected starter) in EPA per "
                 "dropback, 0.0 when QB1 starts" % STARTER_LAG),
    }
    return sub, diagnostics


# ---------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------

def _fold_losses(losses):
    """{season: mean per-game log-loss} from evaluate()'s losses_out list."""
    acc = {}
    for yr, loss in losses:
        a = acc.setdefault(yr, [0.0, 0])
        a[0] += loss
        a[1] += 1
    return {str(yr): round(v[0] / v[1], 5) for yr, v in sorted(acc.items())}


def _paired(inc_losses, cand_losses):
    """promote_signals.paired_fold_stats over two evaluate() loss lists that
    scored the same games in the same order."""
    if len(inc_losses) != len(cand_losses):
        return None
    by_fold = {}
    for (yr, inc), (_yr, cand) in zip(inc_losses, cand_losses):
        by_fold.setdefault(yr, []).append(inc - cand)
    return ps.paired_fold_stats(by_fold)


def _candidate_grids():
    """[(name, description, [params, ...])] - one entry per HYPOTHESIS, which is
    the unit the Bonferroni divisor is charged in."""
    return [
        ("qb1_out",
         "the shipped drop, re-measured on the depth-chart substrate",
         [{"qb1_scale": s, "qb2_extra": 0.0, "cap_scale": 0.0}
          for s in QB1_SCALES]),
        ("qb1_qb2",
         "a second drop when QB2 is listed out as well",
         [{"qb1_scale": s, "qb2_extra": e, "cap_scale": 0.0}
          for s in QB1_SCALES for e in QB2_EXTRAS]),
        ("capability",
         "the drop IS the measured EPA/dropback gap to the expected starter",
         [{"qb1_scale": 0.0, "qb2_extra": 0.0, "cap_scale": c}
          for c in CAP_SCALES]),
        ("combined",
         "QB1 drop + QB2 extra + capability gap, all three together",
         [{"qb1_scale": s, "qb2_extra": e, "cap_scale": c}
          for s in COMBINED_QB1 for e in COMBINED_QB2 for c in COMBINED_CAP]),
    ]


def measure(sub, diagnostics, seasons=None, eval_seasons=None, progress=False):
    """Score every candidate against the shipped params. Returns the artifact."""
    seasons = list(seasons or ps.SEASONS)
    eval_seasons = list(eval_seasons or ps.EVAL_SEASONS)
    hfa, revert, k, tuning = ps.game_params()
    finals_by_year = {yr: ps.load_finals(yr) for yr in seasons}
    gp = tuning.get("game_params") or {}

    # SHIPPED BASELINE: the incumbent production actually walks with today.
    inc_fns, inc_unavailable = ps._incumbent_family_fns(tuning)
    shipped_builders = [mk() for mk in inc_fns]
    if any(not isinstance(b, tuple) or len(b) != 2 or not callable(b[0])
           for b in shipped_builders):
        # A sentinel builder (epa_blend / coach_*) needs run()'s materialisation,
        # which is not in scope here. Refuse rather than score a different model.
        raise SystemExit("qb_depth backtest: the shipped incumbent carries a "
                         "family this harness cannot rebuild standalone - rerun "
                         "inside scripts/promote_signals.py")
    inc_losses = []
    inc_loss, inc_n = ps.evaluate(shipped_builders, hfa, revert, k, finals_by_year,
                                  losses_out=inc_losses)

    # CANDIDATE INCUMBENT: the same model with the shipped qb_out builder
    # REMOVED. qb_depth's first term IS the QB1 drop, so running both would
    # price one absence twice (the rule is stated in build_predictions.py and
    # in docs/QB_DEPTH_CASCADE.md as well).
    ex_qb_tuning = {"game_params": {kk: vv for kk, vv in gp.items()
                                    if kk != "qb_out"}}
    ex_fns, _ = ps._incumbent_family_fns(ex_qb_tuning)
    base_builders = [mk() for mk in ex_fns]

    counts = condition_counts(sub, finals_by_year, eval_seasons)
    grids = _candidate_grids()
    n_tests = len(grids)               # one test per hypothesis, the harness unit
    candidates = []
    for name, description, params_list in grids:
        trials = []
        for params in params_list:
            losses = []
            builder = qb_depth_builder(params["qb1_scale"], params["qb2_extra"],
                                       params["cap_scale"], sub)
            ll, n = ps.evaluate(base_builders + [builder], hfa, revert, k,
                                finals_by_year, losses_out=losses)
            trials.append((ll, n, params, losses))
            if progress:
                print("  %-11s qb1=%-5g qb2=%-5g cap=%-5g -> %.5f"
                      % (name, params["qb1_scale"], params["qb2_extra"],
                         params["cap_scale"], ll))
        grid = [{"params": {kk: round(float(vv), 4) for kk, vv in sorted(pp.items())},
                 "pooled_log_loss": round(lll, 5)}
                for lll, _nn, pp, _ls in trials]
        ll, n, params, losses = min(trials, key=lambda t: t[0])
        stats = _paired(inc_losses, losses)
        se = stats["se"] if stats else None
        df = (stats["folds"] - 1) if stats else 0
        improvement = round(inc_loss, 5) - round(ll, 5)
        info = ps.adoption_threshold(se, df, n_tests)
        ci95 = None
        if stats and se:
            half = ps.student_t_ppf(0.5 + ps.CI_LEVEL / 2.0, stats["df"]) * se
            ci95 = [round(stats["mean"] - half, 6), round(stats["mean"] + half, 6)]
        candidates.append({
            "name": name,
            "description": description,
            "params": {kk: round(float(vv), 4) for kk, vv in sorted(params.items())},
            "trials": len(params_list),
            "grid": grid,
            "heldout_log_loss_by_fold": _fold_losses(losses),
            "pooled_log_loss": round(ll, 5),
            "n": n,
            "delta_vs_shipped": round(improvement, 5),
            "improvement": round(stats["mean"], 6) if stats else None,
            "se": round(se, 6) if se else None,
            "t_stat": (None if not stats or stats["t"] == math.inf
                       else round(stats["t"], 3)),
            "ci95": ci95,
            "folds_positive": stats["folds_positive"] if stats else 0,
            "threshold": info["threshold"],
            "would_adopt": bool(ps.should_adopt(improvement, se, df, n_tests)),
            "n_fired": n_fired(sub, finals_by_year, eval_seasons,
                               params["qb1_scale"], params["qb2_extra"],
                               params["cap_scale"]),
        })

    winners = [c for c in candidates if c["would_adopt"]]
    verdict = (min(winners, key=lambda c: c["pooled_log_loss"])["name"]
               if winners else "none")
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    substrate = dict(diagnostics)
    substrate["seasons_scored"] = [str(y) for y in eval_seasons]
    return {
        "generated_utc": now,
        "kind": "qb_depth_backtest",
        "seasons_scored": [str(y) for y in eval_seasons],
        "substrate": substrate,
        "conditions": counts,
        "baseline": {
            "name": "shipped",
            "params": {"hfa_elo": hfa, "revert": revert, "k": k,
                       "families": sorted(nm for nm, blk in gp.items()
                                          if isinstance(blk, dict) and blk.get("applied")),
                       "qb_out_scale": (float((gp.get("qb_out") or {}).get("scale"))
                                        if (gp.get("qb_out") or {}).get("applied") else None)},
            "unavailable": list(inc_unavailable),
            "heldout_log_loss_by_fold": _fold_losses(inc_losses),
            "pooled_log_loss": round(inc_loss, 5),
            "n": inc_n,
        },
        "candidates": candidates,
        "adoption_rule": {
            "method": "paired per-game log-loss, CR1 cluster-robust over the "
                      "walk-forward folds, one-sided Student-t, Bonferroni over "
                      "the candidate families measured here",
            "alpha": ps.SIG_ALPHA,
            "tests": n_tests,
            "effect_floor": ps.MIN_EFFECT,
            "double_count_rule": ("a qb_depth walk DROPS the shipped qb_out builder: "
                                  "qb_depth's first term is the QB1 drop, so running "
                                  "both would price one absence twice"),
        },
        "verdict": verdict,
        "policy": POLICY,
        "limits": LIMITS,
    }


def write(doc, out_path=OUT_PATH):
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Selftest: a synthetic fixture with answers worked out by hand
# ---------------------------------------------------------------------------

def _synthetic():
    """Two teams, one season of four weeks, with a planted depth cascade.

    HOU: QB1 'a1' (500 db, epa 100 -> 0.20/db), QB2 'a2' (200 db, epa 0 ->
    0.00/db), QB3 'a3' (10 db -> under the threshold, replacement level).
    DAL: QB1 'b1' only, never hurt.
    """
    finals = {
        2024: [{"home": "HOU", "away": "DAL", "week": w, "home_score": 20,
                "away_score": 17, "kickoff_utc": "2024-09-%02dT17:00Z" % (1 + 7 * w)}
               for w in (1, 2, 3, 4)],
    }
    depth_rows = []
    for wk in (1, 2, 3, 4):
        for rank, pid, nm in ((1, "a1", "Ann One"), (2, "a2", "Ann Two"),
                              (3, "a3", "Ann Three")):
            depth_rows.append({"week": wk, "club_code": "HOU", "position": "QB",
                               "depth_team": rank, "full_name": nm,
                               "gsis_id": pid, "game_type": "REG"})
        depth_rows.append({"week": wk, "club_code": "DAL", "position": "QB",
                           "depth_team": 1, "full_name": "Bob One",
                           "gsis_id": "b1", "game_type": "REG"})
    injuries = {"seasons": {"2024": {"HOU": {
        # wk 2: QB1 out alone -> QB2 expected. wk 3: QB1 and QB2 out -> QB3.
        "2": [{"id": "a1", "name": "Ann One", "position": "QB", "status": "Out"}],
        "3": [{"id": "a1", "name": "Ann One", "position": "QB", "status": "Out"},
              {"id": "a2", "name": "Ann Two", "position": "QB", "status": "Doubtful"}],
    }}}}
    # Season 2023 supplies the trailing dropbacks and the replacement pool.
    epa = {"seasons": {
        "2023": {"HOU": {
            "1": {"passers": {"a1": {"db": 500, "epa": 100.0, "name": "A.One"},
                              "a2": {"db": 200, "epa": 0.0, "name": "A.Two"},
                              "a3": {"db": 10, "epa": -2.0, "name": "A.Three"}}}},
            "DAL": {"1": {"passers": {"b1": {"db": 400, "epa": 40.0,
                                             "name": "B.One"}}}}},
        "2024": {"HOU": {}, "DAL": {}},
    }}
    return finals, depth_rows, injuries, epa


def selftest():
    finals, depth_rows, injuries, epa = _synthetic()

    # --- depth order, lag 1 -------------------------------------------------
    orders = depth_orders({2023: depth_rows, 2024: depth_rows}, finals, [2024])
    assert orders[(2024, "HOU", 2)] == ["a1", "a2", "a3"], orders[(2024, "HOU", 2)]
    # Week 1 has no in-season snapshot at lag 1: it takes 2023's final chart.
    assert orders[(2024, "HOU", 1)] == ["a1", "a2", "a3"], orders[(2024, "HOU", 1)]
    # With no prior season at all, week 1 is simply absent -> neutral, counted.
    only24 = depth_orders({2024: depth_rows}, finals, [2024])
    assert (2024, "HOU", 1) not in only24, "week 1 must not borrow its own week"
    # And the lag really is a lag: a week-4 chart may not reach week 4.
    wk4_only = [r for r in depth_rows if r["week"] == 4]
    lagged = depth_orders({2024: wk4_only}, finals, [2024])
    assert (2024, "HOU", 4) not in lagged, "a week's own snapshot leaked in"

    # --- capability + replacement pooling -----------------------------------
    query_weeks = {(2024, g["week"]) for g in finals[2024]}
    cap_at, replacement = capability_tables(epa, [2024], query_weeks)
    caps = cap_at[(2024, 1)]
    assert caps["a1"] == (500.0, 100.0), caps["a1"]
    # a3 threw 10 dropbacks in the whole training window: he alone is under the
    # threshold, so he alone IS the replacement pool (-2.0 / 10 = -0.2). a1, a2
    # and b1 all cleared 100, so no starter's early weeks leak into it.
    expect_rep = -2.0 / 10.0
    assert abs(replacement[2024] - expect_rep) < 1e-12, replacement[2024]
    assert abs(capability("a1", caps, replacement[2024]) - 0.2) < 1e-12
    assert abs(capability("a2", caps, replacement[2024]) - 0.0) < 1e-12
    # a3 is under MIN_DROPBACKS -> replacement, not his own 10-dropback number.
    assert abs(capability("a3", caps, replacement[2024]) - expect_rep) < 1e-12
    assert capability("nobody", caps, None) is None

    # --- substrate ----------------------------------------------------------
    outs = qb_outs(injuries)
    sub = build_substrate(orders, outs, cap_at, replacement, finals, [2024])
    w1 = sub[(2024, 1, "HOU")]
    assert w1["known"] and not w1["qb1_out"], w1
    assert w1["cap_gap"] == 0.0, "cap_gap must be exactly 0 when QB1 starts"
    w2 = sub[(2024, 2, "HOU")]
    assert w2["qb1_out"] and not w2["qb2_out"], w2
    assert w2["expected_rank"] == 2, w2
    assert abs(w2["cap_gap"] - (0.2 - 0.0)) < 1e-12, w2      # QB1 -> QB2
    w3 = sub[(2024, 3, "HOU")]
    assert w3["qb1_out"] and w3["qb2_out"], w3
    assert w3["expected_rank"] == 3, w3                       # QB3 starts
    assert abs(w3["cap_gap"] - (0.2 - expect_rep)) < 1e-12, w3
    dal = sub[(2024, 2, "DAL")]
    assert dal["known"] and not dal["qb1_out"], dal

    # --- the pure penalty ---------------------------------------------------
    assert qb_depth_penalty(w1, 75.0, 50.0, 300.0) == 0.0     # QB1 starts
    assert qb_depth_penalty(w2, 75.0, 50.0, 0.0) == 75.0      # QB1 only
    assert qb_depth_penalty(w3, 75.0, 50.0, 0.0) == 125.0     # QB1 + QB2 extra
    assert abs(qb_depth_penalty(w2, 0.0, 0.0, 300.0) - 300.0 * 0.2) < 1e-9
    assert qb_depth_penalty(None, 75.0, 50.0, 300.0) == 0.0   # unknown -> neutral
    assert qb_depth_penalty({"known": False}, 75.0, 0.0, 0.0) == 0.0

    # --- the builder's sign and antisymmetry --------------------------------
    setup, factory = qb_depth_builder(75.0, 50.0, 0.0, sub)
    fn = factory(setup(2024, finals[2024], []))
    g = finals[2024][2]                     # week 3: HOU (home) down to QB3
    assert fn(g, 0) == -125.0, fn(g, 0)     # home out -> the home edge shrinks
    swapped = dict(g, home="DAL", away="HOU")
    assert fn(swapped, 0) == +125.0, fn(swapped, 0)
    neutral = finals[2024][0]               # week 1: nobody out
    assert fn(neutral, 0) == 0.0

    # --- condition counts ---------------------------------------------------
    counts = condition_counts(sub, finals, [2024])
    assert counts["team_games"]["2024"] == 8, counts
    assert counts["qb1_out"]["2024"] == 2, counts             # weeks 2 and 3
    assert counts["qb2_also_out"]["2024"] == 1, counts        # week 3
    assert counts["qb3_or_deeper_started"]["2024"] == 1, counts
    assert counts["depth_unknown"]["2024"] == 0, counts
    # A season with no depth chart at all is unknown for every team-game, and
    # every candidate prices it at exactly 0.0.
    blank = build_substrate({}, outs, cap_at, replacement, finals, [2024])
    bc = condition_counts(blank, finals, [2024])
    assert bc["depth_unknown"]["2024"] == 8 and bc["qb1_out"]["2024"] == 0, bc
    assert n_fired(blank, finals, [2024], 75.0, 50.0, 300.0) == 0
    assert n_fired(sub, finals, [2024], 75.0, 0.0, 0.0) == 2

    # --- offline substrate refuses rather than inventing ---------------------
    assert walk_forward_substrate(seasons=[2024], finals_by_year=finals,
                                  injury_doc=injuries, epa_doc=epa,
                                  offline=True) is None

    print("selftest OK: depth order honours the lag (week 1 falls back to the "
          "prior season's final chart, a week never sees its own snapshot); "
          "capability needs 100 prior dropbacks and otherwise takes the pooled "
          "replacement level; cap_gap is 0 when QB1 starts and QB1-minus-QB3 "
          "when both are out; the penalty is 0 outside the QB1-out condition, "
          "antisymmetric across home/away, and neutral on an unknown chart")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help="CSV cache for the nflverse depth-chart releases "
                             "(shareable with scripts/build_line_report.py)")
    parser.add_argument("--out", default=OUT_PATH)
    parser.add_argument("--offline", action="store_true",
                        help="do not fetch; report every season unavailable")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    built = walk_forward_substrate(cache_dir=args.cache_dir, offline=args.offline,
                                   verbose=not args.quiet)
    if built is None:
        print("QB DEPTH BACKTEST: substrate unavailable (no depth release could "
              "be fetched, or injury_history/epa_history are absent) - nothing "
              "measured, nothing written", file=sys.stderr)
        return 1
    sub, diagnostics = built
    if diagnostics["seasons_unavailable"] and not args.quiet:
        for yr, why in sorted(diagnostics["seasons_unavailable"].items()):
            print("NOTICE: depth chart %s unavailable (%s) - that season's "
                  "team-games are neutral and counted" % (yr, why))
    doc = measure(sub, diagnostics, progress=not args.quiet)
    write(doc, args.out)
    base = doc["baseline"]
    print("shipped %.5f over %d games" % (base["pooled_log_loss"], base["n"]))
    for c in doc["candidates"]:
        print("  %-11s %-34s %.5f  delta %+.5f  t=%s  would_adopt=%s  n_fired=%d"
              % (c["name"],
                 "qb1=%g qb2=%g cap=%g" % (c["params"]["qb1_scale"],
                                           c["params"]["qb2_extra"],
                                           c["params"]["cap_scale"]),
                 c["pooled_log_loss"], c["delta_vs_shipped"], c["t_stat"],
                 c["would_adopt"], c["n_fired"]))
    print("verdict: %s" % doc["verdict"])
    print("wrote %s" % os.path.relpath(args.out, _ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
