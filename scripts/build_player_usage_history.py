"""BUILD data/player_usage_history.json — per-SEASON player OPPORTUNITY SHARE
within team, for every resolved season. This is the multi-season backbone the
promotion gate's `skill_out` family needs: to price a game in season Y honestly,
a skill player's expected usage is their share from season Y-1 (fully pregame —
the prior season is complete before season Y kicks off, no leak). Single-season
player_usage.json stays the projection-feature snapshot; this is the historical
record for walk-forward trialing and prediction-time application.

Opportunity = targets + rush attempts (touches + targets); share = a player's
opportunity / their team's total. Reuses build_player_usage.aggregate so the
per-season math is identical to the snapshot builder. Runner-built (nflverse
pbp 403s the sandbox proxy) — OPTIONAL until the bootstrap dispatch runs, like
epa_history. --selftest validates share math on the fixture, never writes.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.nflverse import FeedError, iter_pbp_release  # noqa: E402
from scripts.build_player_usage import aggregate  # noqa: E402  (shared per-season math)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "player_usage_history.json")
FIXTURE = os.path.join(DATA, "fixtures", "nflverse_sample", "pbp_usage.csv")
SEASONS = [2021, 2022, 2023, 2024, 2025]   # 2021 feeds 2022 games, ... 2024 feeds 2025
MIN_PLAYERS_PER_SEASON = 200


def season_shares(rows):
    """{pid: {team, opp, share}} — each skill player's opportunity share within
    their team for the season. opp = targets + rush attempts."""
    players, _ = aggregate(rows)
    team_opp = {}
    opp = {}
    for pid, p in players.items():
        o = p["targets"] + p["rush_att"]
        if o <= 0:
            continue
        opp[pid] = (p["team"], o)
        team_opp[p["team"]] = team_opp.get(p["team"], 0) + o
    out = {}
    for pid, (team, o) in opp.items():
        tot = team_opp.get(team, 0)
        if tot:
            out[pid] = {"team": team, "opp": o, "share": round(o / tot, 4)}
    return out


def selftest():
    import csv
    with open(FIXTURE, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    shares = season_shares(rows)
    # Fixture: WR1 has 2 targets, RB1 has 2 rushes — same team, so each is half
    # the team's 4 opportunities.
    assert abs(shares["00-WR1"]["share"] - 0.5) < 1e-9, shares.get("00-WR1")
    assert abs(shares["00-RB1"]["share"] - 0.5) < 1e-9, shares.get("00-RB1")
    assert shares["00-WR1"]["opp"] == 2 and shares["00-RB1"]["opp"] == 2
    # Shares within a team sum to 1.0 (every opportunity attributed once).
    tot = sum(v["share"] for v in shares.values() if v["team"] == shares["00-WR1"]["team"])
    assert abs(tot - 1.0) < 1e-6, tot
    print("selftest OK: per-season usage-share aggregation exact")


def main():
    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("seasons") or {}

    out = dict(existing)
    built = 0
    for season in SEASONS:
        if str(season) in out and out[str(season)]:
            continue                              # immutable history: prior seasons are final
        try:
            shares = season_shares(iter_pbp_release(season))
        except FeedError as err:
            print(f"USAGE HISTORY: {season} fetch failed: {err}", file=sys.stderr)
            continue
        if len(shares) < MIN_PLAYERS_PER_SEASON:
            print(f"USAGE HISTORY: {season} only {len(shares)} players; skipped",
                  file=sys.stderr)
            continue
        out[str(season)] = shares
        built += 1

    if not out:
        print("USAGE HISTORY: nothing built; keeping existing file.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "nflverse play-by-play (per-season within-team opportunity share)",
        "policy": "skill_out gate family raw material - earns weight only via NEVER-REGRESS",
        "seasons": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote player_usage_history.json: {len(out)} seasons ({built} built this run)")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
