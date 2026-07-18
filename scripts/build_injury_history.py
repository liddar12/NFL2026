"""BUILD data/injury_history.json — weekly PREGAME injury-report statuses for
skill players, from the nflverse injuries releases. The qb_out promotion
family's availability signal: a team whose primary passer is listed Out or
Doubtful on the final report priced differently — walked forward leak-free
(report status is pregame information by construction).

Runner-built (sandbox proxy 403s nflverse releases); past seasons immutable;
loud on failure keeps the existing file. --selftest checks row shaping only.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.nflverse import FeedError, fetch_injuries_release  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "injury_history.json")
HISTORY_SEASONS = [2021, 2022, 2023, 2024, 2025]
CURRENT_SEASON = 2026
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC"}
POSITIONS = frozenset(["QB", "RB", "WR", "TE"])
STATUSES = frozenset(["Out", "Doubtful", "Questionable"])
MIN_KEPT_PER_SEASON = 500


def shape(rows):
    """seasons[team][week] = [{id, name, position, status}] for skill players
    carrying a real report status. Returns (teams dict, kept count)."""
    teams = {}
    kept = 0
    for r in rows:
        pos = (r.get("position") or "").strip()
        status = (r.get("report_status") or "").strip()
        if pos not in POSITIONS or status not in STATUSES:
            continue
        team = RENAMES.get((r.get("team") or "").strip(), (r.get("team") or "").strip())
        try:
            week = int(float(r.get("week")))
        except (TypeError, ValueError):
            continue
        if not team:
            continue
        kept += 1
        teams.setdefault(team, {}).setdefault(str(week), []).append({
            "id": (r.get("gsis_id") or "").strip() or None,
            "name": (r.get("full_name") or "").strip(),
            "position": pos,
            "status": status,
        })
    return teams, kept


def selftest():
    rows = [
        {"position": "QB", "report_status": "Out", "team": "LA", "week": "10",
         "gsis_id": "00-1", "full_name": "Matthew Stafford"},
        {"position": "QB", "report_status": "", "team": "KC", "week": "10",
         "gsis_id": "00-2", "full_name": "Healthy Guy"},        # no status: dropped
        {"position": "K", "report_status": "Out", "team": "KC", "week": "10",
         "gsis_id": "00-3", "full_name": "A Kicker"},           # position: dropped
        {"position": "WR", "report_status": "Questionable", "team": "KC", "week": "11",
         "gsis_id": "00-4", "full_name": "Some Receiver"},
    ]
    teams, kept = shape(rows)
    assert kept == 2, kept
    assert teams["LAR"]["10"][0]["status"] == "Out"             # LA -> LAR rename
    assert teams["KC"]["11"][0]["position"] == "WR"
    print("selftest OK: status filter + rename + shaping exact")


def main():
    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("seasons") or {}

    seasons_out = {}
    for season in HISTORY_SEASONS + [CURRENT_SEASON]:
        key = str(season)
        if key in existing and season in HISTORY_SEASONS:
            seasons_out[key] = existing[key]
            continue
        try:
            teams, kept = shape(fetch_injuries_release(season))
        except FeedError as err:
            if season == CURRENT_SEASON:
                print(f"NOTICE: {season} injuries not available yet ({err}); skipping")
                continue
            if key in existing:
                seasons_out[key] = existing[key]
                continue
            print(f"INJURY HISTORY FAILED for {season}: {err}", file=sys.stderr)
            return 0 if existing else 1
        if season in HISTORY_SEASONS and kept < MIN_KEPT_PER_SEASON:
            print(f"INJURY HISTORY FAILED: {season} kept {kept} (<{MIN_KEPT_PER_SEASON})",
                  file=sys.stderr)
            return 0 if existing else 1
        seasons_out[key] = teams

    if not seasons_out:
        print("INJURY HISTORY: nothing available; keeping existing.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "nflverse injuries releases (final report statuses, skill positions)",
        "seasons": seasons_out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote injury_history.json: seasons {sorted(seasons_out)}")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
