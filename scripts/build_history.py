"""Assemble data/player_history.json — 5-year history (2021-2025) with trajectories.

Scope: the CURRENT 300 projected players (player_projections.json order, so diffs
stay minimal). Past seasons 2021-2024 come from scripts.scrape.espn_history; the
2025 season line is MERGED from the existing N2 pool (espn_players) so history can
never drift from the prior_season_points the projections were built on — the 2025
kona pull only contributes targets/games, which the N2 pool does not carry.

Trajectory rules (the contract):

  * seasons_observed >= 3 -> source "measured":
      - slope_pts_per_yr  = OLS slope over (yr, pts);
      - curve_residual_per_yr = mean per-year delta between the observed
        season-over-season pts ratio and the position age-curve expectation
        (scripts.signals.aging). Positive = outperforming the curve; an aging
        back declining FASTER than the RB cliff shows up negative.
        Ages per past season are back-projected from the current roster age
        (age_at(yr) = roster_age - (2026 - yr)); an unknown age degrades the
        expectation to flat (1.0), never to a punishment.
  * seasons_observed < 3 -> scripts.ai_estimates (Agent D's DOCUMENTED,
    deterministic estimation rules) fills the trajectory, source "ai_estimated".
    If that module (or its estimate_trajectory hook) is not present yet, the
    trajectory is written as source "pending" with null slope/residual — honest
    about what has not been estimated, and the integrator re-runs after it lands.

Standalone: python -m scripts.build_history (refetches the N2 pool itself).
In-pipeline: build_predictions calls run() with the pool already in hand.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import espn_history  # noqa: E402
from scripts.scrape.espn import FeedError  # noqa: E402
from scripts.signals import aging  # noqa: E402

SEASON_RANGE = [2021, 2025]
CURRENT_SEASON = 2026            # roster ages are as-of this build year
MIN_MATCHED = 250                # < 250/300 ids with any history = broken join
DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "player_history.json")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _ols_slope(points):
    """OLS slope of pts on yr over [(yr, pts), ...]; needs >= 2 distinct years."""
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    denom = sum((p[0] - mx) ** 2 for p in points)
    if denom == 0:
        return 0.0
    return sum((p[0] - mx) * (p[1] - my) for p in points) / denom


def _age_at(roster_age, yr):
    """Back-projected age in season `yr` from the current roster age, or None."""
    if roster_age is None:
        return None
    return roster_age - (CURRENT_SEASON - yr)


def _curve_residual(position, roster_age, seasons):
    """Mean per-year delta between observed pts ratio and the age-curve expectation.

    For each adjacent pair of OBSERVED seasons: observed ratio pts_b/pts_a vs the
    expected ratio age_multiplier(b)/age_multiplier(a), normalized by the year gap
    (a missed season between them dilutes, it does not double-count).
    """
    deltas = []
    for a, b in zip(seasons, seasons[1:]):
        if a["pts"] <= 0:
            continue
        gap = b["yr"] - a["yr"]
        r_obs = b["pts"] / a["pts"]
        m_a = aging.age_multiplier(position, _age_at(roster_age, a["yr"]))
        m_b = aging.age_multiplier(position, _age_at(roster_age, b["yr"]))
        r_exp = (m_b / m_a) if m_a > 0 else 1.0
        deltas.append((r_obs - r_exp) / gap)
    if not deltas:
        return None
    return sum(deltas) / len(deltas)


def _estimated_trajectory(position, roster_age, seasons):
    """Trajectory for a <3-season player via scripts.ai_estimates (Agent D).

    Duck-typed hook: ai_estimates.estimate_trajectory(position=, age=, seasons=)
    -> {"slope_pts_per_yr": float, "curve_residual_per_yr": float}. Returns None
    (-> source "pending") when the module or hook is absent; a PRESENT hook that
    raises is a real bug and warns loudly before degrading to pending.
    """
    try:
        from scripts import ai_estimates  # noqa: PLC0415 (optional, lands with Agent D)
    except ImportError:
        return None
    fn = getattr(ai_estimates, "estimate_trajectory", None)
    if fn is None:
        return None
    try:
        est = fn(position=position, age=roster_age, seasons=seasons)
        return {
            "slope_pts_per_yr": round(float(est["slope_pts_per_yr"]), 2),
            "curve_residual_per_yr": round(float(est["curve_residual_per_yr"]), 4),
            "seasons_observed": len(seasons),
            "source": "ai_estimated",
        }
    except Exception as exc:  # noqa: BLE001 — degrade to pending, never crash history
        print(f"[warn] ai_estimates.estimate_trajectory failed for a "
              f"{position}: {exc}", file=sys.stderr)
        return None


def build_history_document(projected, pool_2025, now, history=None, actuals_2025=None):
    """Pure assembly: projections slice + N2 pool + per-season actuals -> contract doc.

    projected     : player_projections.json's players (the current 300; sets key order)
    pool_2025     : espn_players.build_player_records output (2025 pts/rec + ages)
    history       : {season: {espn_id: rec}} for 2021-2024 (fetched when None)
    actuals_2025  : espn_history season pull for 2025, ONLY for targets/games
    """
    if history is None:
        history = espn_history.fetch_history()
    if actuals_2025 is None:
        actuals_2025 = espn_history.fetch_season_actuals(2025)
    pool_by_id = {}
    for rec in pool_2025:
        gid = rec.get("gsis_id", "")
        if gid.startswith("espn-"):
            pool_by_id[gid[len("espn-"):]] = rec

    players, pending = {}, 0
    for proj in projected:
        gid = proj["gsis_id"]
        eid = gid[len("espn-"):] if gid.startswith("espn-") else gid
        pos = proj["position"]
        pool_rec = pool_by_id.get(eid)
        roster_age = pool_rec.get("age") if pool_rec else None

        seasons = []
        for yr in sorted(history):
            rec = history[yr].get(eid)
            if not rec or rec["pts"] <= 0:
                continue
            row = {"yr": yr, "pts": rec["pts"], "receptions": rec["receptions"],
                   "targets": rec["targets"]}
            if rec.get("games") is not None:
                row["games"] = rec["games"]
            seasons.append(row)
        # 2025: pts/receptions are the N2 pool's numbers (what projections used);
        # the kona 2025 pull only adds the raw keys the pool doesn't carry.
        k25 = actuals_2025.get(eid)
        pts25 = pool_rec["prior_season_points"] if pool_rec else (k25["pts"] if k25 else None)
        if pts25 is not None and pts25 > 0:
            row = {"yr": 2025, "pts": round(float(pts25), 2),
                   "receptions": (pool_rec or k25)["receptions"],
                   "targets": k25["targets"] if k25 else 0.0}
            if k25 and k25.get("games") is not None:
                row["games"] = k25["games"]
            seasons.append(row)

        n = len(seasons)
        if n >= 3:
            slope = _ols_slope([(s["yr"], s["pts"]) for s in seasons])
            residual = _curve_residual(pos, roster_age, seasons)
            trajectory = {
                "slope_pts_per_yr": round(slope, 2),
                "curve_residual_per_yr": round(residual, 4) if residual is not None else None,
                "seasons_observed": n,
                "source": "measured",
            }
        else:
            trajectory = _estimated_trajectory(pos, roster_age, seasons)
            if trajectory is None:
                pending += 1
                trajectory = {
                    "slope_pts_per_yr": None,
                    "curve_residual_per_yr": None,
                    "seasons_observed": n,
                    "source": "pending",
                }
        players[gid] = {"name": proj["name"], "position": pos,
                        "seasons": seasons, "trajectory": trajectory}

    matched = sum(1 for p in players.values() if p["seasons"])
    if matched < MIN_MATCHED:
        raise FeedError(
            f"player history joined only {matched}/{len(players)} projected ids "
            f"(< {MIN_MATCHED}) — id join or season pulls look broken, failing loudly."
        )
    doc = {"season_range": list(SEASON_RANGE), "updated_utc": now, "players": players}
    counts = [len(p["seasons"]) for p in players.values()]
    summary = {
        "players": len(players),
        "seasons_ge3": sum(1 for c in counts if c >= 3),
        "seasons_eq2": sum(1 for c in counts if c == 2),
        "seasons_le1": sum(1 for c in counts if c <= 1),
        "pending": pending,
    }
    return doc, summary


def run(projected, pool_2025, now, out_path=OUT_PATH):
    """Build + write player_history.json; returns the coverage summary dict."""
    doc, summary = build_history_document(projected, pool_2025, now)
    _write(out_path, doc)
    print(f"history: {summary['players']} players -> {out_path} "
          f"(>=3 seasons: {summary['seasons_ge3']}, ==2: {summary['seasons_eq2']}, "
          f"<=1: {summary['seasons_le1']}, pending trajectories: {summary['pending']})")
    return summary


if __name__ == "__main__":  # standalone: python -m scripts.build_history
    import datetime as dt

    from scripts.scrape import espn, espn_players

    with open(os.path.join(DATA, "player_projections.json"), encoding="utf-8") as fh:
        projected = json.load(fh)["players"]
    teams = espn.fetch_teams()
    pool = espn_players.build_player_records(2025, teams)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(projected, pool, now)
