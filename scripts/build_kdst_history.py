#!/usr/bin/env python3
"""BUILD data/kdst_weekly_history.json — the resolved D/ST week corpus the R55
split is measured against.

WHY A COMMITTED CORPUS
----------------------
scripts/backtest_kdst.py is a GATE step: it runs offline, stdlib only, on every
CI run, and it must be able to answer "does the weekly split beat the flat
season average" without reaching the network. It therefore needs the resolved
per-week D/ST fantasy score for every team-week in the corpus seasons, which is
exactly what this file writes. Same arrangement as dvp_positional_history.json
behind the player weekly gate.

WHAT A ROW IS
-------------
One team-week: the D/ST fantasy points that team's defense actually scored,
under scripts.build_kdst's mirrored default scoring (dst_game_points -- the same
function the split itself uses, so the corpus and the model can never disagree
about what a D/ST point is), plus the opponent and home/away, which are the only
two inputs the split takes.

REGULAR SEASON ONLY. A playoff week is not part of a fantasy season and would
bias the surrendered-points table toward the good teams that reach January.

MARKET POLICY: nfldata games.csv is read for game_id / teams / SCORES ONLY, the
same five columns build_kdst reads. No spread, total, moneyline or odds column
is touched here.

NETWORK: nflverse release assets. On a feed error the existing file is left
untouched and the run exits 0 with a loud stderr warn -- never a short corpus
written over a good one.

  python3 scripts/build_kdst_history.py            write data/kdst_weekly_history.json
  python3 scripts/build_kdst_history.py --selftest fixtures only, writes nothing
"""
import argparse
import datetime as _dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_kdst import (  # noqa: E402
    DATA, GAMES_URL, GAMES_COLUMNS, TEAM_WEEK_URL, TEAM_WEEK_COLUMNS,
    KdstFeedError, _fetch_csv, _require_columns, _fixture_rows,
    dst_game_points, games_index,
)
from scripts.scrape.renames import normalize_team  # noqa: E402

OUT = os.path.join(DATA, "kdst_weekly_history.json")
# Five seasons: the split's blend reaches two seasons back, so scoring 2023-25
# walk-forward needs 2021 and 2022 on file as well.
CORPUS_SEASONS = (2021, 2022, 2023, 2024, 2025)


def corpus_rows(team_rows_by_season, scores_by_game):
    """[{season, week, team, opp, home, pts}] over REG weeks, sorted. A game with
    no score row is DROPPED WHOLE and counted -- points allowed decides a tier,
    so half a game is not a row. Pure -- no I/O."""
    out, skipped = [], []
    for season in sorted(team_rows_by_season):
        for r in team_rows_by_season[season]:
            if str(r.get("season_type") or "").upper() != "REG":
                continue
            team = normalize_team(r.get("team"))
            opp = normalize_team(r.get("opponent_team"))
            gid = str(r.get("game_id") or "")
            game = scores_by_game.get(gid)
            if team is None or opp is None:
                skipped.append({"season": season, "game_id": gid,
                                "reason": "team or opponent does not normalize"})
                continue
            if game is None:
                skipped.append({"season": season, "game_id": gid, "team": team,
                                "reason": "no score row in games.csv"})
                continue
            if team == game["home"]:
                pts_allowed, home = game["away_score"], True
            elif team == game["away"]:
                pts_allowed, home = game["home_score"], False
            else:
                skipped.append({"season": season, "game_id": gid, "team": team,
                                "reason": "team is neither side of the game row"})
                continue
            if pts_allowed is None:
                skipped.append({"season": season, "game_id": gid, "team": team,
                                "reason": "no final score (unplayed)"})
                continue
            try:
                week = int(r["week"])
            except (KeyError, TypeError, ValueError):
                skipped.append({"season": season, "game_id": gid, "team": team,
                                "reason": "no week number"})
                continue
            out.append({"season": int(season), "week": week, "team": team,
                        "opp": opp, "home": home,
                        "pts": dst_game_points(r, pts_allowed)})
    out.sort(key=lambda r: (r["season"], r["week"], r["team"]))
    return out, skipped


def build(selftest=False):
    team_by_season, skipped = {}, []
    if selftest:
        gm = _require_columns(_fixture_rows("games.csv"), GAMES_COLUMNS,
                              "fixture games.csv")
        for r in _require_columns(_fixture_rows("team_week.csv"),
                                  TEAM_WEEK_COLUMNS, "fixture team_week.csv"):
            team_by_season.setdefault(int(r["season"]), []).append(r)
        source = "selftest fixtures (data/fixtures/kdst_sample)"
    else:
        gm = _require_columns(_fetch_csv(GAMES_URL, "nfldata games.csv"),
                              GAMES_COLUMNS, "nfldata games.csv")
        for season in CORPUS_SEASONS:
            try:
                team_by_season[season] = _require_columns(
                    _fetch_csv(TEAM_WEEK_URL % season, "stats_team_week_%d" % season),
                    TEAM_WEEK_COLUMNS, "stats_team_week_%d" % season)
            except KdstFeedError as exc:
                skipped.append({"season": season, "reason": str(exc)})
                print("[warn] corpus season %d skipped: %s" % (season, exc),
                      file=sys.stderr)
        if not team_by_season:
            raise KdstFeedError("every corpus season failed — refusing to write "
                                "a short corpus over a good one")
        source = "nflverse stats_team_week + nfldata games.csv scores"

    rows, row_skips = corpus_rows(team_by_season, games_index(gm))
    skipped.extend(row_skips)
    seasons = sorted({r["season"] for r in rows})
    return {
        "generated_utc": _dt.datetime.now(_dt.timezone.utc)
                            .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "scoring": "scripts.build_kdst.dst_game_points — the mirrored default "
                   "profile, the same function the split scores with",
        "season_range": [seasons[0], seasons[-1]] if seasons else [],
        "seasons": seasons,
        "rows_by_season": {str(s): sum(1 for r in rows if r["season"] == s)
                           for s in seasons},
        "skipped": skipped[:50],
        "skipped_total": len(skipped),
        "rows": rows,
    }


def selftest():
    doc = build(selftest=True)
    rows = doc["rows"]
    assert rows, "the fixture produces rows"
    assert all(r["week"] < 19 for r in rows), "REG only — no playoff week"
    keys = {(r["season"], r["week"], r["team"]) for r in rows}
    assert len(keys) == len(rows), "one row per team-week, no duplicates"
    for r in rows:
        assert isinstance(r["home"], bool) and r["opp"] != r["team"]
    # the pairing is symmetric: if A played B in a week, B played A
    for r in rows:
        mate = [x for x in rows if x["season"] == r["season"]
                and x["week"] == r["week"] and x["team"] == r["opp"]]
        assert len(mate) == 1 and mate[0]["opp"] == r["team"], r
        assert mate[0]["home"] is not r["home"], "exactly one side is home"
    assert doc["season_range"] and doc["seasons"]
    print("selftest OK: REG-only team-weeks, unique per team-week, symmetric "
          "pairing with exactly one home side, scored by build_kdst")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    try:
        doc = build()
    except KdstFeedError as exc:
        print("[warn] kdst history not rebuilt: %s" % exc, file=sys.stderr)
        return 0
    with open(OUT, "w", encoding="utf-8") as fh:
        # COMPACT on purpose, and allowlisted in tests/smoke.sh with this same
        # reason: 2,718 rows are 194 KB tight and 348 KB at indent=2 (1.8x),
        # rewritten by a cron, so the indent would inflate every commit for a
        # file no human reads. sort_keys keeps the cron diff stable.
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        fh.write("\n")
    print("wrote %s: %d rows over %s" % (OUT, len(doc["rows"]), doc["seasons"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
