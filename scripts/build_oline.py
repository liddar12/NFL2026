"""O-line composite builder - per-team offensive line context from ESPN rosters.

Feeds the REGISTERED weight-0 `ol_composite_vs_dl` signal with real roster facts.
This file is CONTEXT ONLY: params.applied=false / weight 0.0, and nothing here
touches data/meta.json or any game probability (the "started at 0" discipline).

Source of truth per team is the KEYLESS ESPN roster endpoint
    https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{slug}/roster
where {slug} is the ESPN team abbreviation (lowercased canonical abbrev; the one
divergence is WAS -> wsh, mirrored from scripts/scrape/renames.py). Team list
comes from data/fixtures/teams_espn.json (32 canonical abbrevs).

Per team, over OL positions (C, G, OG, T, OT, OL):
    n_linemen           roster count
    avg_weight_lb       mean listed weight
    avg_age             mean age in years from dateOfBirth (missing DOBs skipped)
    avg_experience_yrs  mean ESPN experience.years
    continuity          share of linemen with experience >= 2 seasons; refined to
                        the 2025 returning-OL snap share when the nflverse snap
                        count release CSV is reachable (it is proxy-blocked in
                        some sandboxes; the doc's `source` says which was used)

Composite score = z-score blend across the 32 teams, documented weights:
    0.4 * z(avg_weight_lb) + 0.4 * z(avg_experience_yrs) + 0.2 * z(continuity)
A blend of z-scores has mean 0 by construction, so the league average line
scores 0.0 and the sign reads directly (positive = better than average).

Run it for real (network + `requests`, 32 polite roster calls):
    python3 -m scripts.build_oline
The fast gate never runs this; tests/feature/oline_contract.test.mjs validates
the committed data/oline_composite.json.
"""

import datetime as dt
import json
import math
import os
import sys
import time

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import nflverse  # noqa: E402
from scripts.scrape.renames import CANONICAL_TEAMS, canonical_player_name, normalize_team  # noqa: E402

DATA = os.path.join(_ROOT, "data")
TEAMS_FIXTURE = os.path.join(DATA, "fixtures", "teams_espn.json")
OUT_PATH = os.path.join(DATA, "oline_composite.json")

_ROSTER_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{slug}/roster"
_HTTP_TIMEOUT = 20
_SLEEP_S = 0.25  # politeness between the 32 roster calls

# ESPN accepts the lowercased team abbreviation as the roster path slug. The only
# canonical abbrev ESPN spells differently is Washington (WAS -> wsh); keep this
# in lockstep with the RENAMES map in scripts/scrape/renames.py.
_ESPN_SLUG_OVERRIDES = {"WAS": "wsh"}

# ESPN position abbreviations that count as offensive line.
OL_POSITIONS = frozenset(["C", "G", "OG", "T", "OT", "OL"])

# Documented composite blend (see module docstring). Must sum to 1.0.
BLEND = {"avg_weight_lb": 0.4, "avg_experience_yrs": 0.4, "continuity": 0.2}
# When combine bench-press reps are available (nflverse aggregates on the
# runner), strength joins the blend — the composite's original design.
BLEND_BENCH = {"avg_weight_lb": 0.3, "avg_experience_yrs": 0.3,
               "continuity": 0.2, "avg_bench_press": 0.2}
AGGREGATES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "..", "data", "nflverse_aggregates.json")

# A lineman with >= 2 seasons of experience counts toward roster continuity.
CONTINUITY_EXP_YEARS = 2

SNAP_SEASON = 2025  # season whose OL snaps refine continuity when reachable


class FeedError(RuntimeError):
    """Loud failure: non-200 roster response or a structurally empty payload."""


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _require_requests():
    """Guarded in-function import (scrape/espn.py pattern): the gate imports this
    module without `requests` installed; only a real run needs it."""
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover - exercised only off the gate
        raise FeedError(
            "requests is not installed. Install it in the pipeline runner only: "
            "`pip install requests`. It must NEVER be a gate dependency."
        ) from exc
    return requests


def _get_json(url):
    """GET + parse JSON with a loud non-200 policy (the silent-404 lesson)."""
    requests = _require_requests()
    resp = requests.get(url, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise FeedError(
            f"ESPN GET {url} returned HTTP {resp.status_code}. Refusing to treat a "
            f"non-200 as empty data."
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise FeedError(f"ESPN GET {url} returned non-JSON body.") from exc


def _espn_slug(abbrev):
    return _ESPN_SLUG_OVERRIDES.get(abbrev, abbrev.lower())


def _age_years(dob_iso, as_of):
    """Age in years from an ESPN dateOfBirth like '2000-07-21T07:00Z'. None if the
    field is missing/unparseable (the caller skips it, it never becomes 0)."""
    if not dob_iso:
        return None
    try:
        d = dt.date.fromisoformat(str(dob_iso)[:10])
    except ValueError:
        return None
    return (as_of - d).days / 365.25


def fetch_team_linemen(abbrev):
    """All OL roster entries for one team. Loud when a roster comes back with no
    linemen - no NFL roster has zero OL; that is an outage or a schema change."""
    doc = _get_json(_ROSTER_URL.format(slug=_espn_slug(abbrev)))
    groups = doc.get("athletes") or []
    linemen = []
    for group in groups:
        for item in group.get("items") or []:
            pos = ((item.get("position") or {}).get("abbreviation") or "").upper()
            if pos not in OL_POSITIONS:
                continue
            linemen.append({
                "name": item.get("fullName") or "",
                "position": pos,
                "weight_lb": item.get("weight"),
                "dob": item.get("dateOfBirth"),
                "experience_yrs": (item.get("experience") or {}).get("years"),
            })
    if not linemen:
        raise FeedError(
            f"ESPN roster for {abbrev} yielded 0 offensive linemen - refusing to "
            f"treat an empty position group as data (outage or schema change)."
        )
    return linemen


def _mean(values):
    vals = [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    return (sum(vals) / len(vals)) if vals else None


def team_raw_metrics(linemen, as_of):
    """Per-team raw OL metrics from the ESPN roster entries."""
    n = len(linemen)
    exp_years = [p["experience_yrs"] for p in linemen if isinstance(p["experience_yrs"], (int, float))]
    veterans = sum(1 for y in exp_years if y >= CONTINUITY_EXP_YEARS)
    return {
        "n_linemen": n,
        "avg_weight_lb": _mean([p["weight_lb"] for p in linemen]),
        "avg_age": _mean([_age_years(p["dob"], as_of) for p in linemen]),
        "avg_experience_yrs": _mean(exp_years),
        # ESPN-only proxy: share of the room with >= 2 seasons. Refined to real
        # snap shares below when the nflverse release CSV is reachable.
        "continuity": (veterans / len(exp_years)) if exp_years else 0.0,
    }


def refine_continuity_with_snaps(teams, rosters_by_team):
    """Refine continuity with real 2025 OL snap shares from the nflverse snap count
    release CSV: for each team, the share of its 2025 OL offense snaps taken by
    linemen still on the current ESPN roster (matched on canonicalized name).

    Returns the number of teams refined. Raises nflverse.FeedError when the feed
    is unreachable (proxy-blocked sandboxes) - the caller degrades to ESPN-only
    and says so in the doc's source field.
    """
    rows = nflverse.fetch_snap_counts_release(SNAP_SEASON)
    snaps = {}  # abbrev -> {canonical name -> offense snaps}
    for r in rows:
        if (r.get("position") or "").upper() not in OL_POSITIONS:
            continue
        team = normalize_team(r.get("team") or "")
        if team is None:
            continue
        try:
            n_snaps = float(r.get("offense_snaps") or 0)
        except ValueError:
            continue
        key = canonical_player_name(r.get("player") or "")
        snaps.setdefault(team, {})
        snaps[team][key] = snaps[team].get(key, 0.0) + n_snaps
    refined = 0
    for ab, metrics in teams.items():
        team_snaps = snaps.get(ab) or {}
        total = sum(team_snaps.values())
        if total <= 0:
            continue  # no 2025 OL snap rows for this team; keep the ESPN proxy
        current = {canonical_player_name(p["name"]) for p in rosters_by_team[ab]}
        returning = sum(v for name, v in team_snaps.items() if name in current)
        metrics["continuity"] = returning / total
        refined += 1
    return refined


def _zscores(values_by_team):
    """Population z-scores across the 32 teams. A degenerate (constant) column
    z-scores to all zeros rather than dividing by zero."""
    vals = list(values_by_team.values())
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    sd = math.sqrt(var)
    if sd == 0:
        return {ab: 0.0 for ab in values_by_team}
    return {ab: (v - mean) / sd for ab, v in values_by_team.items()}


def compute_composites(teams, blend=BLEND):
    """Attach the documented z-score blend to every team (mean 0 by construction)."""
    z_by_metric = {
        metric: _zscores({ab: teams[ab][metric] for ab in teams})
        for metric in blend
    }
    for ab in teams:
        teams[ab]["composite"] = round(
            sum(w * z_by_metric[metric][ab] for metric, w in blend.items()), 4
        )


def apply_bench_press(teams):
    """Fold combine bench-press reps (data/nflverse_aggregates.json) into the
    metrics. Returns the blend to use: BLEND_BENCH when >= 30 teams carry a real
    bench average (a team with no tested linemen gets the league mean, z 0 —
    neutral, documented), else the unchanged 3-term BLEND (aggregate absent ->
    byte-identical composite path)."""
    try:
        with open(AGGREGATES_PATH, encoding="utf-8") as fh:
            agg = json.load(fh).get("combine_oline") or {}
    except (OSError, ValueError):
        return BLEND
    benches = {ab: v.get("avg_bench_press") for ab, v in agg.items()
               if isinstance(v.get("avg_bench_press"), (int, float))}
    if len(benches) < 30:
        return BLEND
    league_mean = sum(benches.values()) / len(benches)
    for ab, m in teams.items():
        b = benches.get(ab)
        m["avg_bench_press"] = round(b if b is not None else league_mean, 2)
        m["bench_n"] = int((agg.get(ab) or {}).get("n_tested") or 0)
    return BLEND_BENCH


def main():
    with open(TEAMS_FIXTURE, encoding="utf-8") as fh:
        fixture = json.load(fh)
    abbrevs = sorted(fixture["teams"].keys())
    unknown = [ab for ab in abbrevs if ab not in CANONICAL_TEAMS]
    if unknown:
        raise FeedError(f"teams_espn.json has non-canonical abbrevs: {unknown}")

    as_of = dt.datetime.now(dt.timezone.utc).date()
    rosters_by_team = {}
    teams = {}
    for ab in abbrevs:
        linemen = fetch_team_linemen(ab)
        rosters_by_team[ab] = linemen
        teams[ab] = team_raw_metrics(linemen, as_of)
        print(f"  {ab}: {teams[ab]['n_linemen']} OL")
        time.sleep(_SLEEP_S)

    # continuity refinement: real 2025 snap shares when the release CSV is
    # reachable; otherwise the ESPN experience proxy, stated in `source`.
    source = "espn_roster + nflverse_snap_counts_2025"
    try:
        refined = refine_continuity_with_snaps(teams, rosters_by_team)
        if refined < len(teams):
            source = f"espn_roster + nflverse_snap_counts_2025 ({refined}/{len(teams)} teams refined)"
        print(f"continuity refined from 2025 OL snap shares for {refined} teams")
    except nflverse.FeedError as exc:
        source = "espn_roster only (nflverse snap counts unreachable; continuity = share of linemen with >= 2 yrs experience)"
        print(f"nflverse snap counts unavailable, ESPN-only continuity: {exc}")

    # DEPTH-CHART CONTINUITY (Rel6): how many of last season's week-max OL
    # STARTERS (depth_team 1) are still on the current ESPN roster. Recorded as
    # context (returning_starters_ol, 0-5+) alongside the snap-share continuity;
    # not yet a composite term (weight-0 discipline: it earns its way in like
    # everything else). Guarded: unreachable release -> metric absent, stated.
    try:
        depth_rows = nflverse.fetch_depth_charts_release(SNAP_SEASON)
        latest_week = max(int(float(r.get("week") or 0)) for r in depth_rows)
        starters = {}
        for r in depth_rows:
            if int(float(r.get("week") or 0)) != latest_week:
                continue
            if (r.get("position") or "").upper() not in OL_POSITIONS:
                continue
            if str(r.get("depth_team") or "") not in ("1", "1.0"):
                continue
            team = normalize_team(r.get("club_code") or r.get("team") or "")
            if team is None:
                continue
            starters.setdefault(team, set()).add(
                canonical_player_name(r.get("full_name") or r.get("player") or ""))
        for ab, metrics in teams.items():
            current = {canonical_player_name(p["name"]) for p in rosters_by_team[ab]}
            metrics["returning_starters_ol"] = len(starters.get(ab, set()) & current)
        source += " + nflverse_depth_charts"
        print(f"depth-chart continuity: week {latest_week} starters checked for {len(starters)} teams")
    except nflverse.FeedError as exc:
        print(f"nflverse depth charts unavailable, returning_starters_ol omitted: {exc}")

    blend = apply_bench_press(teams)
    if blend is BLEND_BENCH:
        source += " + nflverse_combine_bench"
    compute_composites(teams, blend)

    # rounding pass for a stable, readable diff
    for m in teams.values():
        m["avg_weight_lb"] = round(m["avg_weight_lb"], 1)
        m["avg_age"] = round(m["avg_age"], 1)
        m["avg_experience_yrs"] = round(m["avg_experience_yrs"], 2)
        m["continuity"] = round(m["continuity"], 3)

    doc = {
        "season": 2026,
        "updated_utc": _utc_now(),
        "source": source,
        "teams": teams,
        "params": {
            "applied": False,
            "weight": 0.0,
            "feeds": "ol_composite_vs_dl signal - not yet weighted",
        },
        "estimate": True,
    }
    _write(OUT_PATH, doc)
    print(f"wrote {OUT_PATH} ({len(teams)} teams, source: {source})")


if __name__ == "__main__":
    main()
