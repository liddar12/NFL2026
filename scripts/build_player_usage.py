"""BUILD data/player_usage.json — per-player OPPORTUNITY metrics from nflverse
play-by-play: targets, target share, air yards, red-zone touches, plus rush
attempts. Opportunity predicts fantasy points better than efficiency — these
are candidate FEATURES for the player-projection refit (weight 0 until the
in-season player gate earns them weight) and honest context for player rows.

Runner-built (sandbox proxy 403s nflverse). Prior season only for now — the
projection model's feature season. --selftest validates math from the fixture,
never writes.
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
OUT_PATH = os.path.join(DATA, "player_usage.json")
FIXTURE = os.path.join(DATA, "fixtures", "nflverse_sample", "pbp_usage.csv")
SEASON = 2025                      # the projection model's feature season
RENAMES = {"LA": "LAR"}
MIN_PLAYERS = 250
TOP_N = 450


def aggregate(rows):
    """(players dict by id, team target totals) from pbp rows."""
    players = {}
    team_targets = {}

    def rec(pid, name, team, pos_hint=None):
        p = players.setdefault(pid, {"name": name, "team": team, "targets": 0,
                                     "air_yards": 0.0, "rz_touches": 0,
                                     "rush_att": 0})
        p["team"] = team or p["team"]
        return p

    for r in rows:
        pt = (r.get("play_type") or "").strip()
        team = RENAMES.get((r.get("posteam") or "").strip(), (r.get("posteam") or "").strip())
        try:
            ydl = float(r.get("yardline_100")) if r.get("yardline_100") else None
        except ValueError:
            ydl = None
        in_rz = ydl is not None and ydl <= 10
        if pt == "pass":
            pid = (r.get("receiver_player_id") or "").strip()
            if pid:
                p = rec(pid, (r.get("receiver_player_name") or "").strip(), team)
                p["targets"] += 1
                team_targets[team] = team_targets.get(team, 0) + 1
                try:
                    p["air_yards"] += float(r.get("air_yards") or 0.0)
                except ValueError:
                    pass
                if in_rz:
                    p["rz_touches"] += 1
        elif pt == "run":
            pid = (r.get("rusher_player_id") or "").strip()
            if pid:
                p = rec(pid, (r.get("rusher_player_name") or "").strip(), team)
                p["rush_att"] += 1
                if in_rz:
                    p["rz_touches"] += 1
    return players, team_targets


def finalize(players, team_targets):
    out = []
    for pid, p in players.items():
        tt = team_targets.get(p["team"], 0)
        out.append({
            "id": pid, "name": p["name"], "team": p["team"],
            "targets": p["targets"],
            "target_share": round(p["targets"] / tt, 4) if tt else 0.0,
            "air_yards": round(p["air_yards"], 1),
            "rz_touches": p["rz_touches"],
            "rush_att": p["rush_att"],
        })
    out.sort(key=lambda r: -(r["targets"] + r["rush_att"]))
    return out[:TOP_N]


def selftest():
    import csv
    with open(FIXTURE, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    players, tt = aggregate(rows)
    out = {r["id"]: r for r in finalize(players, tt)}
    # Fixture: WR1 two targets (one in RZ, air 8+2), RB1 two rushes (one RZ).
    assert out["00-WR1"]["targets"] == 2 and out["00-WR1"]["rz_touches"] == 1
    assert abs(out["00-WR1"]["air_yards"] - 10.0) < 1e-9
    assert out["00-WR1"]["target_share"] == 1.0, out["00-WR1"]
    assert out["00-RB1"]["rush_att"] == 2 and out["00-RB1"]["rz_touches"] == 1
    print("selftest OK: usage aggregation exact")


def main():
    existing = os.path.exists(OUT_PATH)
    try:
        players, tt = aggregate(iter_pbp_release(SEASON))
    except FeedError as err:
        print(f"PLAYER USAGE FAILED: {err}", file=sys.stderr)
        return 0 if existing else 1
    out = finalize(players, tt)
    if len(out) < MIN_PLAYERS:
        print(f"PLAYER USAGE FAILED: only {len(out)} players", file=sys.stderr)
        return 0 if existing else 1
    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": SEASON,
        "source": "nflverse play-by-play (targets/air yards/red-zone/rushes)",
        "policy": "candidate refit FEATURES - weight 0 until the player gate earns weight",
        "players": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote player_usage.json: {len(out)} players")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
