"""BACKTEST the Rest-of-Season projection APPROACH against completed NFL seasons,
walk-forward and leak-free — the honest "is it directionally right?" proof.

Committed data has per-player SEASON totals (data/player_history.json, 2021-2025)
but NO per-player weekly actuals, so the backtest runs at the granularity the
data supports: SEASON RANK-CORRELATION.

Method (per target season S in 2022..2025):
  * Inputs use ONLY seasons <= S-1 (no season-S signal leaks in).
  * Projection under test (ros_proj): games-weighted recent-form projection —
    a blend of the last two prior seasons' per-game scoring, reprojected to a
    full 17-game season, nudged by the player's OWN trajectory slope recomputed
    from priors only. NOTE: this is a season-total PROXY for directional
    validation, NOT the deployed projection — the app's RoS engine (app/ros.js)
    sums per-WEEK player_weekly points, which no committed weekly-actuals dataset
    lets us backtest. So the rho below measures whether the recent-form +
    trajectory APPROACH ranks players right, not the exact numbers the app shows.
  * Baseline to beat (last_year): the naive "last year's finish" — prior season
    points alone. RoS earns its keep only by out-ranking this.
  * Score vs season-S ACTUAL points, within position (QB/RB/WR/TE): Spearman rho
    (primary) + NDCG@k at starter cutoffs. Stdlib only (no numpy/scipy).

Writes data/ros_backtest.json with honest labels (method/granularity, measured
vs estimate). --selftest validates the rank math on a fixture, never writes.
"""

import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
DATA = os.path.join(_ROOT, "data")
HISTORY_PATH = os.path.join(DATA, "player_history.json")
OUT_PATH = os.path.join(DATA, "ros_backtest.json")

SEASONS = [2022, 2023, 2024, 2025]
POSITIONS = ("QB", "RB", "WR", "TE")
STARTER_K = {"QB": 12, "RB": 24, "WR": 36, "TE": 12}
MIN_GAMES = 6                      # ignore tiny-sample fluke seasons on the actual side
GAMES_FULL = 17
ROS_MARGIN = 0.0                   # RoS must beat last-year by >= this (rho points)


def _spearman(pairs):
    """Spearman rank correlation for [(x, y), ...]; None if < 3 points."""
    n = len(pairs)
    if n < 3:
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


def _ndcg(ranked_actuals, k):
    """NDCG@k: ranked_actuals is the actual-points list ordered by the PROJECTION
    (best-projected first). Rewards putting truly high scorers near the top."""
    k = min(k, len(ranked_actuals))
    if k == 0:
        return None
    def dcg(vals):
        return sum(v / math.log2(i + 2) for i, v in enumerate(vals[:k]))
    ideal = sorted(ranked_actuals, reverse=True)
    idcg = dcg(ideal)
    return (dcg(ranked_actuals) / idcg) if idcg > 0 else None


def _project(priors):
    """Games-weighted recent-form projection from seasons <= S-1 ONLY.
    priors: [{yr, pts, games}] sorted ascending by yr. Returns projected full-
    season points, or None if no usable prior."""
    usable = [s for s in priors if s.get("games") and s["games"] > 0]
    if not usable:
        return None
    recent = usable[-2:]                          # last up-to-2 prior seasons
    # per-game scoring, weighted toward the most recent season (2:1)
    weights = [1.0, 2.0][-len(recent):]
    ppg = sum(w * (s["pts"] / s["games"]) for w, s in zip(weights, recent)) / sum(weights)
    base = ppg * GAMES_FULL
    # trajectory nudge: slope of season TOTALS across priors (recomputed here),
    # applied as one year forward, damped.
    if len(usable) >= 2:
        ys = list(range(len(usable)))
        ts = [s["pts"] for s in usable]
        my = sum(ys) / len(ys)
        mt = sum(ts) / len(ts)
        denom = sum((y - my) ** 2 for y in ys)
        slope = (sum((ys[i] - my) * (ts[i] - mt) for i in range(len(ys))) / denom) if denom else 0.0
        base += 0.25 * slope
    return max(0.0, base)


def run_backtest(history):
    players = history.get("players") or {}
    per_season = []
    pooled = {"proj": [], "last": []}            # (rho-weighting done by pooling pairs)
    pooled_pairs = {"proj": {p: [] for p in POSITIONS}, "last": {p: [] for p in POSITIONS}}

    for S in SEASONS:
        pos_rows = {p: [] for p in POSITIONS}
        for pid, rec in players.items():
            pos = str(rec.get("position") or "").upper()
            if pos not in POSITIONS:
                continue
            seasons = sorted(rec.get("seasons") or [], key=lambda s: s["yr"])
            priors = [s for s in seasons if s["yr"] <= S - 1]
            actual = next((s for s in seasons if s["yr"] == S), None)
            if not actual or not actual.get("games") or actual["games"] < MIN_GAMES:
                continue
            proj = _project(priors)
            last = next((s["pts"] for s in priors if s["yr"] == S - 1), None)
            if proj is None or last is None:
                continue
            pos_rows[pos].append({"actual": actual["pts"], "proj": proj, "last": last})

        season_entry = {"season": S, "positions": {}}
        for pos in POSITIONS:
            rows = pos_rows[pos]
            if len(rows) < 3:
                season_entry["positions"][pos] = {"n": len(rows), "skipped": "too_few"}
                continue
            rho_proj = _spearman([(r["proj"], r["actual"]) for r in rows])
            rho_last = _spearman([(r["last"], r["actual"]) for r in rows])
            k = STARTER_K[pos]
            ndcg_proj = _ndcg([r["actual"] for r in sorted(rows, key=lambda r: -r["proj"])], k)
            ndcg_last = _ndcg([r["actual"] for r in sorted(rows, key=lambda r: -r["last"])], k)
            season_entry["positions"][pos] = {
                "n": len(rows),
                "rho_ros": None if rho_proj is None else round(rho_proj, 4),
                "rho_lastyear": None if rho_last is None else round(rho_last, 4),
                "ndcg_ros": None if ndcg_proj is None else round(ndcg_proj, 4),
                "ndcg_lastyear": None if ndcg_last is None else round(ndcg_last, 4),
                "beats_baseline": (rho_proj is not None and rho_last is not None
                                   and rho_proj > rho_last + ROS_MARGIN),
                "measured": True,
            }
            for r in rows:
                pooled_pairs["proj"][pos].append((r["proj"], r["actual"]))
                pooled_pairs["last"][pos].append((r["last"], r["actual"]))
        per_season.append(season_entry)

    # Pooled per-position across all seasons.
    pooled_out = {}
    wins = 0
    total = 0
    for pos in POSITIONS:
        rp = _spearman(pooled_pairs["proj"][pos])
        rl = _spearman(pooled_pairs["last"][pos])
        if rp is None or rl is None:
            continue
        total += 1
        if rp > rl + ROS_MARGIN:
            wins += 1
        pooled_out[pos] = {
            "n": len(pooled_pairs["proj"][pos]),
            "rho_ros": round(rp, 4),
            "rho_lastyear": round(rl, 4),
            "delta": round(rp - rl, 4),
            "beats_baseline": rp > rl + ROS_MARGIN,
            "measured": True,
        }
    return per_season, pooled_out, wins, total


def selftest():
    # Perfect-rank fixture: projection order == actual order -> rho == 1.
    assert abs(_spearman([(1, 10), (2, 20), (3, 30)]) - 1.0) < 1e-9
    assert abs(_spearman([(1, 30), (2, 20), (3, 10)]) + 1.0) < 1e-9
    # NDCG: projection that puts the highest actual first beats reversed order.
    good = _ndcg([30, 20, 10], 3)
    bad = _ndcg([10, 20, 30], 3)
    assert good > bad, (good, bad)
    # _project uses priors only and is recency-weighted.
    p = _project([{"yr": 2021, "pts": 100, "games": 17}, {"yr": 2022, "pts": 200, "games": 17}])
    assert p is not None and p > 150, p          # weighted toward the 200 season
    print("selftest OK: spearman + ndcg + leak-free projection exact")


def main():
    if not os.path.exists(HISTORY_PATH):
        print("BACKTEST: player_history.json absent (runner-built); nothing to do.",
              file=sys.stderr)
        return 0
    with open(HISTORY_PATH, encoding="utf-8") as fh:
        history = json.load(fh)
    per_season, pooled, wins, total = run_backtest(history)

    import datetime as dt
    doc = {
        "__meta__": {
            "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "method": "season_rank_correlation",
            "granularity": "season",
            "baseline": "prior_season_points (last year's finish)",
            "note": "Walk-forward: season S projected from seasons <= S-1 only. "
                    "No per-player weekly actuals are committed, so this is the "
                    "honest season-level directional check, not a weekly backtest.",
        },
        "per_season": per_season,
        "pooled": pooled,
        "summary": {"positions_beating_baseline": wins, "positions_scored": total},
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=False)
        fh.write("\n")

    print("RoS backtest (season rank-correlation, walk-forward, leak-free):")
    for pos, r in pooled.items():
        flag = "BEATS last-year" if r["beats_baseline"] else "does NOT beat"
        print(f"  {pos}: rho_ros={r['rho_ros']:+.3f} vs last-year={r['rho_lastyear']:+.3f} "
              f"(delta {r['delta']:+.3f}, n={r['n']}) -> {flag}")
    print(f"Directional result: RoS beats last-year in {wins}/{total} positions "
          f"(pooled across {', '.join(str(s) for s in SEASONS)})")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
