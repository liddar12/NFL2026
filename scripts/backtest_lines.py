"""Walk-forward LINE-INJURY CASCADE experiment (R70, phase 1: MEASURE ONLY).

The owner's ask: "If key offensive linemen are out, this could impact running
back and QB performance. If key defensive linemen are out on the team they
play against, it could help RB and QB." This file measures both cascades on
the shipped weekly split, player-week by player-week, with every input
restricted to what was knowable before kickoff. It changes NO projection: a
line factor reaches build_weekly only after a variant here clears never-regress
(phase 2), and the artifact says which did.

Substrate (reused by import from scripts/backtest_weekly.py — not edited):
  * the committed corpus data/fixtures/backtest_weekly/{weekly_actuals,
    games_meta}.json, the fixed season number, the pool, the as-of Elo / DvP /
    venue / weather factors and the deployed build_weekly path — exactly the
    R51 harness, so `v2` here IS the shipped weekly_split_v2 number;
  * data/injury_history.json (build_injury_history.py, --rebuild once so the
    2021-2025 seasons carry OL / DL-front rows) — the FINAL report statuses,
    pregame by construction;
  * the nflverse depth-chart release per scored season (fetched through the
    same cache as build_line_report.py; --cache-dir points at cached CSVs).

STARTER RULE (history, walk-forward): for team T in week wk, the OL starters
are the N players most often listed at rank 1 on an OL position across the
season's depth-chart snapshots with week <= wk - STARTER_LAG (default lag 1:
weeks < wk, the brief's rule; week 1 therefore has no starters and is
neutral, counted), where N is the modal number of rank-1 OL rows the team
listed per snapshot. Same for the DL front (N is 3 or 4 by scheme). The
2025+ release is dated per snapshot (`dt`); a snapshot belongs to the first
week whose first kickoff (games_meta) is after it. The legacy release is dated
per `week`.

Counts: OL_out(T, wk) = |OL starters of T for wk listed Out on the final
report for (T, wk)|, capped at CAP; DL_out likewise for the opponent's front.
Out ONLY (Doubtful / Questionable are not absences). Ids join first, names
second, nothing is guessed.

VARIANTS on top of v2 (the incumbent): OL_OUT = 1 - a x min(OL_out, CAP)
applied to QB and RB at full strength and WR at half; DL_OUT = 1 + b x
min(opp DL_out, CAP) applied to QB and RB. Grid a, b in {0, .02, .04, .06},
(0, 0) excluded — 15 variants, so each cascade is also measured alone. Applied
post-split without renormalisation (phase 2 would put the factor inside
build_weekly's chain, where the season total is renormalised).

Metrics: the harness's own — pooled and held-out (2025) MAE / rank corr /
top-K, per-position MAE and rank corr, a paired season-week block bootstrap of
MAE(variant) - MAE(v2) on the held-out season — plus the RAW RATIO TABLE
(actual / v2 by "own OL starters out" and "opposing DL starters out" bucket,
per position) so the effect is visible before any factor is fitted.

NEVER-REGRESS per variant: adopted only if pooled MAE <= v2's AND pooled
rank_corr >= v2's. Nothing here writes to any projection file. Stdlib only.
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

from scripts import backtest_weekly as bwk                     # noqa: E402
from scripts import build_weekly as bw                         # noqa: E402
from scripts.backtest_player import mae                        # noqa: E402
from scripts.build_injury_history import line_group            # noqa: E402
from scripts.build_line_report import (                        # noqa: E402
    fetch_depth_chart, name_key, norm_team, normalize_depth_rows)

DATA = os.path.join(_ROOT, "data")
INJURY_HISTORY_PATH = os.path.join(DATA, "injury_history.json")
OUT_PATH = os.path.join(DATA, "lines_backtest.json")
POSITIONS = bwk.POSITIONS
SEASONS_SCORED = bwk.SEASONS_SCORED
HELD_OUT = bwk.HELD_OUT
INCUMBENT = "v2"
GRID = (0.0, 0.02, 0.04, 0.06)
CAP = 3
STARTER_LAG = 1
OL_WEIGHT = {"QB": 1.0, "RB": 1.0, "WR": 0.5, "TE": 0.0}
DL_WEIGHT = {"QB": 1.0, "RB": 1.0, "WR": 0.0, "TE": 0.0}
BUCKETS = ("0", "1", "2", "3+")
NEVER_REGRESS_RULE = ("never-regress: a line variant is adoptable only if it is not worse "
                      "than v2 on pooled MAE and pooled rank_corr; phase 1 adopts nothing")
POLICY = (
    "MEASUREMENT ONLY. Own-OL-out and opposing-DL-out counts are built walk-forward "
    "from the season's depth-chart snapshots before the week and the FINAL injury "
    "report for the week (Out only). Starters unknown (no prior snapshot) are "
    "neutral and counted. No projection number changes in this release; the book "
    "lines in games_meta are never read."
)


# ---------------------------------------------------------------------------
# Starters, walk-forward
# ---------------------------------------------------------------------------

def week_first_kickoffs(games, season):
    """{week: 'YYYY-MM-DD'} — the date of the week's first kickoff (games_meta
    kickoff_local_et; the date part is enough at a one-week lag)."""
    first = {}
    for g in games:
        if g["season"] != season:
            continue
        d = str(g.get("kickoff_local_et") or "")[:10]
        if not d:
            continue
        wk = int(g["week"])
        if wk not in first or d < first[wk]:
            first[wk] = d
    return first


def snapshot_week(snap, first_kick):
    """The week a snapshot precedes: the smallest week whose first kickoff date
    is after the snapshot date (2025+ `dt`), or the legacy integer week as is.
    None when the snapshot is after every kickoff (a post-season chart)."""
    if isinstance(snap, int):
        return snap
    d = str(snap)[:10]
    for wk in sorted(first_kick):
        if d < first_kick[wk]:
            return wk
    return None


def historical_starters(depth_rows, first_kick, weeks=bw.WEEKS, lag=STARTER_LAG):
    """{(team, wk): {"ol": {id}, "dl": {id}}} for wk in 1..weeks, from the
    snapshots whose week <= wk - lag. A player's id is his gsis id, else his
    name key. Empty sets where nothing was knowable."""
    by_snap = {}   # (team, grp, snapweek, snapkey) -> set of ids at rank 1
    for r in depth_rows:
        if r["rank"] != 1:
            continue
        grp = line_group(r["pos"])
        if grp is None:
            continue
        sw = snapshot_week(r["snap"], first_kick)
        if sw is None:
            continue
        pid = r["gsis_id"] or name_key(r["name"])
        by_snap.setdefault((r["team"], grp, sw, r["snap"]), set()).add(pid)
    per_team = {}
    for (team, grp, sw, _), ids in by_snap.items():
        per_team.setdefault((team, grp), []).append((sw, ids))
    out = {}
    for (team, grp), snaps in per_team.items():
        snaps.sort(key=lambda s: s[0])
        for wk in range(1, weeks + 1):
            usable = [ids for sw, ids in snaps if sw <= wk - lag]
            if not usable:
                continue
            sizes = sorted(len(ids) for ids in usable)
            n = max(set(sizes), key=lambda k: (sizes.count(k), k))
            tally = {}
            for ids in usable:
                for pid in ids:
                    tally[pid] = tally.get(pid, 0) + 1
            ranked = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
            out.setdefault((team, wk), {"ol": set(), "dl": set()})[grp] = {p for p, _ in ranked}
    return out


def outs_by_team_week(injury_history, season):
    """{(team, wk): {"ol": {id}, "dl": {id}}} — line players listed Out on the
    final report. Ids are gsis ids (else name keys), matching
    historical_starters."""
    out = {}
    seasons = (injury_history or {}).get("seasons") or {}
    for team, weeks in (seasons.get(str(season)) or {}).items():
        for wk_s, rows in weeks.items():
            for r in rows:
                grp = line_group(r.get("position"))
                if grp is None or r.get("status") != "Out":
                    continue
                pid = r.get("id") or name_key(r.get("name"))
                out.setdefault((norm_team(team), int(wk_s)), {"ol": set(), "dl": set()})[grp].add(pid)
    return out


def annotate_rows(rows, starters_by_season, outs_by_season):
    """Set r['ol_out'] (own OL starters Out) and r['dl_out'] (opponent's DL
    starters Out) on every row: an int, or None when that team's starters were
    not knowable for the week. Returns the coverage counts."""
    cov = {"rows": 0, "ol_known": 0, "dl_known": 0}
    for r in rows:
        cov["rows"] += 1
        starters = starters_by_season.get(r["season"], {})
        outs = outs_by_season.get(r["season"], {})
        own = starters.get((r["team"], r["week"]))
        opp = starters.get((r["opp"], r["week"]))
        r["ol_out"] = r["dl_out"] = None
        if own and own["ol"]:
            r["ol_out"] = len(own["ol"] & outs.get((r["team"], r["week"]), {"ol": set()})["ol"])
            cov["ol_known"] += 1
        if opp and opp["dl"]:
            r["dl_out"] = len(opp["dl"] & outs.get((r["opp"], r["week"]), {"dl": set()})["dl"])
            cov["dl_known"] += 1
    return cov


# ---------------------------------------------------------------------------
# Variants + metrics
# ---------------------------------------------------------------------------

def variant_key(a, b):
    return "ol%.2f_dl%.2f" % (a, b)


def line_factor(pos, ol_out, dl_out, a, b, cap=CAP):
    """The multiplier for one row. Unknown counts are neutral (1.0)."""
    f = 1.0
    if ol_out:
        f *= 1.0 - a * min(int(ol_out), cap) * OL_WEIGHT.get(pos, 0.0)
    if dl_out:
        f *= 1.0 + b * min(int(dl_out), cap) * DL_WEIGHT.get(pos, 0.0)
    return f


def apply_variants(rows, grid=GRID):
    keys = []
    for a in grid:
        for b in grid:
            if a == 0.0 and b == 0.0:
                continue
            key = variant_key(a, b)
            keys.append((key, a, b))
            for r in rows:
                r[key] = r[INCUMBENT] * line_factor(r["pos"], r["ol_out"], r["dl_out"], a, b)
    return keys


def paired_bootstrap(rows, key, incumbent=INCUMBENT, held_out=HELD_OUT, b=bwk.BOOT_B,
                     seed=bwk.BOOT_SEED):
    """bwk.block_bootstrap's paired season-week block bootstrap, for any key."""
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
        d_var = sum(abs(r[key] - r["actual"]) for r in sample) / len(sample)
        d_inc = sum(abs(r[incumbent] - r["actual"]) for r in sample) / len(sample)
        deltas.append(d_var - d_inc)
    return {"mean": sum(deltas) / len(deltas), "lo95": bwk.quantile(deltas, 0.025),
            "hi95": bwk.quantile(deltas, 0.975), "blocks": "season-week", "B": b}


def _pos_block(rows, pos, key):
    prow = [r for r in rows if r["pos"] == pos]
    if not prow:
        return {"mae": None, "rank_corr": None, "n": 0}
    return {"mae": mae([(r[key], r["actual"]) for r in prow]),
            "rank_corr": bwk.rank_corr(prow, key), "n": len(prow)}


def evaluate(rows, keys, held_out=HELD_OUT):
    held = [r for r in rows if r["season"] == held_out]
    inc = {"pooled": bwk.block(rows, INCUMBENT), "held_out": bwk.block(held, INCUMBENT),
           "per_position": {pos: _pos_block(rows, pos, INCUMBENT) for pos in POSITIONS}}
    variants = {}
    for key, a, b in keys:
        pooled = bwk.block(rows, key)
        measurable = all(x is not None for x in (pooled["mae"], pooled["rank_corr"],
                                                  inc["pooled"]["mae"], inc["pooled"]["rank_corr"]))
        adopted = bool(measurable and pooled["mae"] <= inc["pooled"]["mae"]
                       and pooled["rank_corr"] >= inc["pooled"]["rank_corr"])
        if not measurable:
            reason = "not measurable"
        elif adopted:
            reason = ("does not regress v2 on pooled MAE (%.4f vs %.4f) and rank_corr (%.4f vs %.4f)"
                      % (pooled["mae"], inc["pooled"]["mae"], pooled["rank_corr"],
                         inc["pooled"]["rank_corr"]))
        else:
            reason = ("regresses v2: pooled MAE %.4f vs %.4f, rank_corr %.4f vs %.4f"
                      % (pooled["mae"], inc["pooled"]["mae"], pooled["rank_corr"],
                         inc["pooled"]["rank_corr"]))
        variants[key] = {
            "a": a, "b": b,
            "pooled": pooled,
            "held_out": bwk.block(held, key),
            "per_position": {pos: _pos_block(rows, pos, key) for pos in POSITIONS},
            "bootstrap_delta_mae_held_out": paired_bootstrap(rows, key, held_out=held_out),
            "verdict": {"adopted": adopted, "reason": reason},
        }
    return inc, variants


def _bucket(n):
    if n is None:
        return None
    return "3+" if n >= 3 else str(int(n))


def ratio_table(rows, field, key=INCUMBENT):
    """{pos: {bucket: {n, mean_actual, mean_pred, ratio}}} — actual / v2 by
    the count in `field` ('ol_out' or 'dl_out'). Rows with an unknown count
    sit under 'unknown'. The effect, visible before any factor."""
    table = {}
    for pos in POSITIONS:
        table[pos] = {}
        for bucket in BUCKETS + ("unknown",):
            members = [r for r in rows if r["pos"] == pos and
                       (_bucket(r[field]) if r[field] is not None else "unknown") == bucket]
            if not members:
                table[pos][bucket] = {"n": 0, "mean_actual": None, "mean_pred": None, "ratio": None}
                continue
            ma = sum(r["actual"] for r in members) / len(members)
            mp = sum(r[key] for r in members) / len(members)
            table[pos][bucket] = {"n": len(members), "mean_actual": ma, "mean_pred": mp,
                                  "ratio": (ma / mp) if mp > 0 else None}
    return table


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run(actuals, games_doc, dvp_doc, injury_history, depth_by_season, tuning_doc=None,
        seasons=SEASONS_SCORED, held_out=HELD_OUT, lag=STARTER_LAG, grid=GRID,
        pool=bwk.POOL):
    """The whole experiment on in-memory documents. depth_by_season:
    {season: raw depth-chart rows}. Returns the artifact (plus "_rows")."""
    t0 = time.time()
    games = bwk.load_games(games_doc)
    params = bwk.game_params(tuning_doc)
    elo_pre = bwk.elo_pre_week(games, params["hfa"], params["k"], params["revert"])
    rows, sched = [], {}
    dvp_rates_at, venue_hfa = {}, {}
    meta = {"pooled": {}, "skipped": {}, "excluded": {}}
    starters_by_season, outs_by_season, starter_meta = {}, {}, {}
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
        starters_by_season[season] = historical_starters(depth, first_kick, lag=lag)
        outs_by_season[season] = outs_by_team_week(injury_history, season)
        line_rows = sum(len(v["ol"]) + len(v["dl"]) for v in outs_by_season[season].values())
        starter_meta[str(season)] = {
            "depth_rows": len(depth),
            "snapshots": len({r["snap"] for r in depth}),
            "team_weeks_with_starters": len(starters_by_season[season]),
            "line_out_listings": line_rows,
        }
    bwk.project_rows(rows, games, sched, elo_pre, dvp_rates_at, venue_hfa)
    coverage = annotate_rows(rows, starters_by_season, outs_by_season)
    keys = apply_variants(rows, grid)
    inc, variants = evaluate(rows, keys, held_out)
    adoptable = sorted(k for k, v in variants.items() if v["verdict"]["adopted"])
    best = None
    if adoptable:
        best = min(adoptable, key=lambda k: (variants[k]["pooled"]["mae"], k))
    return {
        "experiment": "line_injury_cascade_v0",
        "model_incumbent": bw.MODEL_NAME,
        "fixture": {"weekly_actuals": bwk.ACTUALS_REL, "games_meta": bwk.GAMES_REL,
                    "injury_history": "data/injury_history.json",
                    "depth_charts": "nflverse depth_charts_{season} releases",
                    "seasons_scored": list(seasons), "held_out": held_out, "rows": len(rows)},
        "starter_rule": ("per team and week: the N players most often listed at rank 1 on an "
                         "OL / DL-front position across the season's depth-chart snapshots "
                         "with week <= wk - %d (N = the modal rank-1 line count per snapshot); "
                         "Out = listed Out on the FINAL report for (team, week); capped at %d"
                         % (lag, CAP)),
        "variant_rule": ("v2 x (1 - a x min(own OL out, %d) x {QB 1, RB 1, WR 0.5, TE 0}) x "
                         "(1 + b x min(opp DL out, %d) x {QB 1, RB 1, WR 0, TE 0}); grid a, b in %s"
                         % (CAP, CAP, list(grid))),
        "coverage": coverage,
        "ratio_by_own_ol_out": ratio_table(rows, "ol_out"),
        "ratio_by_opp_dl_out": ratio_table(rows, "dl_out"),
        "incumbent": inc,
        "variants": variants,
        "verdict": {
            "adopted": False,
            "adoptable_variants": adoptable,
            "best_adoptable": best,
            "rule": NEVER_REGRESS_RULE,
            "reason": ("phase 1 measures only; %d of %d variants clear never-regress%s"
                       % (len(adoptable), len(variants),
                          (" (best by pooled MAE: %s)" % best) if best else "")),
        },
        "policy": POLICY,
        "meta": {"starters": starter_meta, "rows_skipped": meta["skipped"],
                 "pool_excluded": meta["excluded"], "pooled_per_season": meta["pooled"],
                 "starter_lag_weeks": lag, "runtime_s": round(time.time() - t0, 2)},
        "_rows": rows,
    }


def artifact(result):
    doc = {k: v for k, v in result.items() if k != "_rows"}
    doc["generated_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return bwk._round(doc, 4)


def _f(v):
    return "n/a" if v is None else "%.4f" % v


def report(result):
    print("LINE-INJURY CASCADE (measure only) — rows %d, coverage %s" % (
        result["fixture"]["rows"], result["coverage"]))
    for field, label in (("ratio_by_own_ol_out", "own OL starters out"),
                         ("ratio_by_opp_dl_out", "opposing DL-front starters out")):
        print("  RAW RATIO actual / v2 by %s:" % label)
        for pos in POSITIONS:
            cells = ["%s: n=%d %s" % (b, c["n"], _f(c["ratio"]))
                     for b, c in result[field][pos].items() if c["n"]]
            print("    %s  %s" % (pos, " | ".join(cells)))
    inc = result["incumbent"]
    print("  incumbent v2: pooled MAE %s rank %s topk %s | held-out MAE %s rank %s" % (
        _f(inc["pooled"]["mae"]), _f(inc["pooled"]["rank_corr"]), _f(inc["pooled"]["topk"]),
        _f(inc["held_out"]["mae"]), _f(inc["held_out"]["rank_corr"])))
    print("  variant        pooled MAE   rank    | held MAE   rank    | boot dMAE [lo, hi]      | verdict")
    for key, v in result["variants"].items():
        bt = v["bootstrap_delta_mae_held_out"]
        print("  %-14s %s %s | %s %s | %s [%s, %s] | %s" % (
            key, _f(v["pooled"]["mae"]), _f(v["pooled"]["rank_corr"]),
            _f(v["held_out"]["mae"]), _f(v["held_out"]["rank_corr"]),
            _f(bt["mean"]), _f(bt["lo95"]), _f(bt["hi95"]),
            "ADOPTABLE" if v["verdict"]["adopted"] else "regresses"))
    print("  VERDICT: %s" % result["verdict"]["reason"])


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def injury_history_has_lines(doc, seasons=SEASONS_SCORED):
    """True when every scored season carries at least one OL / DL-front row."""
    for season in seasons:
        teams = (doc.get("seasons") or {}).get(str(season)) or {}
        if not any(line_group(r.get("position")) for weeks in teams.values()
                   for rows in weeks.values() for r in rows):
            return False
    return True


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
    for path in (bwk.ACTUALS_PATH, bwk.GAMES_PATH, bw.DVP_PATH, INJURY_HISTORY_PATH):
        if not os.path.exists(path):
            print("LINES BACKTEST: %s is missing; refusing to score a partial corpus"
                  % os.path.relpath(path, _ROOT), file=sys.stderr)
            return 2
    injury_history = _load(INJURY_HISTORY_PATH)
    if not injury_history_has_lines(injury_history):
        print("LINES BACKTEST: data/injury_history.json carries no OL / DL-front rows for "
              "every scored season %s. Run `python3 scripts/build_injury_history.py --rebuild` "
              "where the nflverse injuries releases are reachable, then re-run. No result "
              "is invented." % (list(SEASONS_SCORED),), file=sys.stderr)
        return 2
    depth_by_season = {}
    for season in SEASONS_SCORED:
        rows, why = fetch_depth_chart(season, cache_dir)
        if rows is None:
            print("LINES BACKTEST: depth chart for %d unavailable (%s); starters cannot be "
                  "built walk-forward. No result is invented." % (season, why), file=sys.stderr)
            return 2
        depth_by_season[season] = rows
    tuning = _load(bwk.TUNING_PATH) if os.path.exists(bwk.TUNING_PATH) else None
    result = run(_load(bwk.ACTUALS_PATH), _load(bwk.GAMES_PATH), _load(bw.DVP_PATH),
                 injury_history, depth_by_season, tuning, lag=lag)
    report(result)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(artifact(result), fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(out_path, _ROOT))
    return 0


# ---------------------------------------------------------------------------
# Selftest: synthetic corpus + synthetic depth charts + planted OL effect
# ---------------------------------------------------------------------------

def _synthetic():
    """bwk._synthetic()'s four-team corpus plus a legacy-shape depth chart per
    season (five OL + four DL starters, stable all season) and an injury
    history that lists an OL starter Out in some weeks. A PLANTED effect: the
    actual points of a team's QB / RB fall by 10% per OL starter out, so the
    ratio table must dip and an a > 0 variant must beat v2."""
    actuals, games_doc, dvp_doc = bwk._synthetic()
    rng = random.Random(70)
    teams = ["AAA", "BBB", "CCC", "DDD"]
    depth_by_season, seasons = {}, {}
    for season in (2023, 2024, 2025):
        rows = []
        outs = {}
        for t in teams:
            ol = ["%s-OL%d" % (t, i) for i in range(5)]
            dl = ["%s-DL%d" % (t, i) for i in range(4)]
            for wk in range(1, 7):
                for i, pid in enumerate(ol):
                    rows.append({"season": season, "week": wk, "game_type": "REG",
                                 "club_code": t, "full_name": pid, "gsis_id": pid,
                                 "position": "T" if i in (0, 4) else ("C" if i == 2 else "G"),
                                 "depth_position": ["LT", "LG", "C", "RG", "RT"][i],
                                 "depth_team": "1"})
                for i, pid in enumerate(dl):
                    rows.append({"season": season, "week": wk, "game_type": "REG",
                                 "club_code": t, "full_name": pid, "gsis_id": pid,
                                 "position": "DE" if i in (0, 3) else "DT",
                                 "depth_position": "DE" if i in (0, 3) else "DT",
                                 "depth_team": "1"})
                n_out = rng.choice([0, 0, 0, 1, 1, 2])
                if n_out:
                    outs[(t, wk)] = ol[:n_out]
        depth_by_season[season] = rows
        seasons[str(season)] = {}
        for (t, wk), pids in outs.items():
            seasons[str(season)].setdefault(t, {})[str(wk)] = [
                {"id": p, "name": p, "position": "T", "status": "Out"} for p in pids]
        # Plant the effect on the corpus.
        for pid, rec in actuals["players"].items():
            if rec["pos"] not in ("QB", "RB"):
                continue
            lines = rec["seasons"].get(str(season)) or {}
            for wk_s, line in lines.items():
                n_out = len(outs.get((line[0], int(wk_s)), []))
                if n_out:
                    line[2] = round(line[2] * (1.0 - 0.10 * n_out), 2)
    injury_history = {"generated_utc": "x", "source": "synthetic", "seasons": seasons}
    return actuals, games_doc, dvp_doc, injury_history, depth_by_season


def selftest():
    # snapshot week mapping
    fk = {1: "2025-09-04", 2: "2025-09-11", 3: "2025-09-18"}
    assert snapshot_week("2025-09-01T10:00:00Z", fk) == 1
    assert snapshot_week("2025-09-05T10:00:00Z", fk) == 2
    assert snapshot_week("2025-09-30T10:00:00Z", fk) is None
    assert snapshot_week(7, fk) == 7
    # factor rules
    assert line_factor("RB", 2, 0, 0.04, 0.0) == 1.0 - 0.08
    assert abs(line_factor("WR", 2, 0, 0.04, 0.0) - (1.0 - 0.04)) < 1e-12
    assert line_factor("TE", 3, 3, 0.06, 0.06) == 1.0
    assert abs(line_factor("QB", 5, 5, 0.02, 0.02) - (1.0 - 0.06) * (1.0 + 0.06)) < 1e-12
    assert line_factor("RB", None, None, 0.06, 0.06) == 1.0
    # starters: modal count, walk-forward lag
    depth = normalize_depth_rows([
        {"week": w, "club_code": "KC", "full_name": n, "gsis_id": n, "position": "T",
         "depth_position": "LT", "depth_team": "1", "game_type": "REG"}
        for w in (1, 2, 3) for n in ("A", "B")] + [
        {"week": 3, "club_code": "KC", "full_name": "C", "gsis_id": "C", "position": "G",
         "depth_position": "LG", "depth_team": "1", "game_type": "REG"}])
    st = historical_starters(depth, {}, weeks=4, lag=1)
    assert ("KC", 1) not in st, "week 1 has no prior snapshot"
    assert st[("KC", 2)]["ol"] == {"A", "B"} and st[("KC", 4)]["ol"] == {"A", "B"}, st
    st0 = historical_starters(depth, {}, weeks=4, lag=0)
    assert st0[("KC", 1)]["ol"] == {"A", "B"}
    # the whole experiment on the synthetic corpus with the planted effect
    actuals, games_doc, dvp_doc, hist, depth_by_season = _synthetic()
    assert injury_history_has_lines(hist)
    res = run(actuals, games_doc, dvp_doc, hist, depth_by_season)
    assert res["fixture"]["rows"] > 0 and res["coverage"]["ol_known"] > 0
    rt = res["ratio_by_own_ol_out"]
    assert rt["RB"]["0"]["n"] > 0 and rt["RB"]["1"]["n"] > 0, rt["RB"]
    assert rt["RB"]["1"]["ratio"] < rt["RB"]["0"]["ratio"], "the planted OL dip must show"
    assert len(res["variants"]) == 15
    assert res["verdict"]["adopted"] is False, "phase 1 adopts nothing"
    for v in res["variants"].values():
        assert set(v["verdict"]) == {"adopted", "reason"}
        assert set(v["pooled"]) == {"mae", "rank_corr", "topk"}
    a_only = res["variants"][variant_key(0.06, 0.0)]
    assert a_only["pooled"]["mae"] < res["incumbent"]["pooled"]["mae"], "a > 0 must help"
    assert a_only["verdict"]["adopted"] is True
    doc = artifact(res)
    json.dumps(doc, ensure_ascii=True)
    assert "_rows" not in doc and doc["verdict"]["adopted"] is False
    print("selftest OK: walk-forward starters, factor rules, planted OL effect visible in the "
          "ratio table and cleared by an a>0 variant, verdict shape, artifact clean")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
