"""BUILD data/epa_history.json — per team-season-week EPA aggregates from
nflverse play-by-play. The predictive core's raw material: every top public
model (nfelo, PFF, Sumer) prices off EPA, and this file is what lets OUR
walk-forward promotion gate test EPA-blend candidates leak-free.

Shape (sums, not means, so any rolling window recomposes exactly):

  seasons.<year>.<team>.<week> = {
    off_plays, off_epa, off_pass_plays, off_pass_epa,
    off_rush_plays, off_rush_epa,
    def_plays, def_epa, def_pass_plays, def_pass_epa,
    def_rush_plays, def_rush_epa
  }

HONESTY RULES (same as every nflverse feed):
  * Streams the release CSVs (iter_pbp_release) — a season is ~50k plays and
    never held in memory. The sandbox proxy 403s these releases; the weekly
    backtest workflow (GitHub runner) is where real data lands. Locally this
    script fails LOUD and keeps whatever file already exists.
  * Past seasons are immutable: a season already present in the existing file
    is NOT refetched (saves ~50MB per season per run). Only the current season
    refreshes weekly.
  * --selftest aggregates the committed fixture CSV and asserts the math —
    it NEVER writes; fixture data must never masquerade as real data.

Row filter: play_type in ('run','pass'), parseable epa + week, both team codes
present. nflverse codes match our canonical set except LA -> LAR.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.nflverse import FeedError, iter_pbp_release  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "epa_history.json")
FIXTURE = os.path.join(DATA, "fixtures", "nflverse_sample", "pbp_epa.csv")

HISTORY_SEASONS = [2021, 2022, 2023, 2024, 2025]  # immutable once ingested
CURRENT_SEASON = 2026                             # refreshed weekly in-season
RENAMES = {"LA": "LAR"}                           # nflverse -> canonical
MIN_PLAYS_PER_SEASON = 25000                      # a full season is ~32k run+pass

_FIELDS = ("plays", "epa", "pass_plays", "pass_epa", "rush_plays", "rush_epa")


def _blank():
    return {f"{side}_{f}": 0 for side in ("off", "def") for f in _FIELDS}


def aggregate(rows):
    """(teams dict, kept_play_count) from an iterable of pbp dict rows."""
    teams = {}
    kept = 0
    for r in rows:
        pt = (r.get("play_type") or "").strip()
        if pt not in ("run", "pass"):
            continue
        off = RENAMES.get((r.get("posteam") or "").strip(), (r.get("posteam") or "").strip())
        de = RENAMES.get((r.get("defteam") or "").strip(), (r.get("defteam") or "").strip())
        if not off or not de:
            continue
        try:
            epa = float(r.get("epa"))
            week = int(float(r.get("week")))
        except (TypeError, ValueError):
            continue
        kept += 1
        wk = str(week)
        for team, side in ((off, "off"), (de, "def")):
            cell = teams.setdefault(team, {}).setdefault(wk, _blank())
            cell[f"{side}_plays"] += 1
            cell[f"{side}_epa"] += epa
            if pt == "pass":
                cell[f"{side}_pass_plays"] += 1
                cell[f"{side}_pass_epa"] += epa
            else:
                cell[f"{side}_rush_plays"] += 1
                cell[f"{side}_rush_epa"] += epa
    # Round the float sums once, at the end (stable output, exact recomposition
    # to 4dp is plenty next to per-play EPA noise).
    for weeks in teams.values():
        for cell in weeks.values():
            for k in cell:
                if k.endswith("_epa"):
                    cell[k] = round(cell[k], 4)
    return teams, kept


def selftest():
    """Aggregate the committed fixture and assert exact sums. NEVER writes."""
    import csv
    with open(FIXTURE, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    teams, kept = aggregate(rows)
    # Fixture: 6 counted plays (see the CSV) — KC off week 1: 3 plays
    # (pass +0.5, pass -0.2, run +0.1), week 2: 1 run -0.3; SF off: 2 passes
    # (+1.0, -0.5) against KC defense; one kneel row and one no-epa row dropped.
    assert kept == 6, f"kept {kept} plays, want 6"
    kc1 = teams["KC"]["1"]
    assert kc1["off_plays"] == 3 and kc1["off_pass_plays"] == 2 and kc1["off_rush_plays"] == 1
    assert abs(kc1["off_epa"] - 0.4) < 1e-9, kc1["off_epa"]
    assert abs(kc1["off_pass_epa"] - 0.3) < 1e-9
    assert abs(kc1["off_rush_epa"] - 0.1) < 1e-9
    assert teams["KC"]["2"]["off_rush_plays"] == 1
    assert abs(teams["KC"]["2"]["off_epa"] - (-0.3)) < 1e-9
    # LAR rename: the fixture's 'LA' defense rows land under LAR.
    assert "LAR" in teams and "LA" not in teams
    sf1 = teams["SF"]["1"]
    assert sf1["off_plays"] == 2 and abs(sf1["off_epa"] - 0.5) < 1e-9
    # Defense mirrors offense: KC's week-1 defense saw SF's 2 passes.
    assert teams["KC"]["1"]["def_pass_plays"] == 0  # SF passes were vs LAR
    assert teams["LAR"]["1"]["def_pass_plays"] == 2
    print("selftest OK: 6 plays aggregated, sums exact, LA->LAR renamed")


def main():
    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("seasons") or {}

    seasons_out = {}
    fetched = []
    for season in HISTORY_SEASONS + [CURRENT_SEASON]:
        key = str(season)
        if key in existing and season in HISTORY_SEASONS:
            seasons_out[key] = existing[key]   # immutable history: no refetch
            continue
        try:
            teams, kept = aggregate(iter_pbp_release(season))
        except FeedError as err:
            if season == CURRENT_SEASON:
                print(f"NOTICE: season {season} pbp not available yet ({err}); skipping")
                continue
            if key in existing:
                seasons_out[key] = existing[key]
                continue
            print(f"EPA HISTORY FAILED for {season}: {err}", file=sys.stderr)
            print("Keeping existing epa_history.json untouched.", file=sys.stderr)
            return 0 if existing else 1
        if season in HISTORY_SEASONS and kept < MIN_PLAYS_PER_SEASON:
            print(f"EPA HISTORY FAILED: season {season} kept only {kept} plays "
                  f"(< {MIN_PLAYS_PER_SEASON}) — refusing a partial season", file=sys.stderr)
            return 0 if existing else 1
        seasons_out[key] = teams
        fetched.append(f"{season}:{kept}")

    if not seasons_out:
        print("EPA HISTORY: nothing available; keeping existing file.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "nflverse play_by_play releases (run/pass plays with EPA)",
        "seasons": seasons_out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote epa_history.json: seasons {sorted(seasons_out)} "
          f"(fetched {', '.join(fetched) if fetched else 'none — all cached'})")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
