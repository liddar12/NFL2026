"""Synthetic local-only cross-repository outcome capture/producer fixture.

No source discovery, network, committed data writes, fitting or cloud records.
The real NFL receipt producer, journal, capture parser and outcome producer run.
"""
import copy
import csv
import datetime as dt
import io
import json
import math

from scripts import build_my_cards as cards, capture_outcome_evidence as capture
from scripts import export_learning, learning_journal, learning_receipts as lr

T0 = "2026-09-01T12:00:00Z"
RECORDED = "2026-09-01T12:01:00Z"
KICKOFF = "2026-09-02T00:15:00Z"
STATS_HEADERS = ("season", "week", "season_type", "position", "team", "player_id",
                 "player_display_name", "passing_yards", "rushing_yards", "receiving_yards")
SNAPS_HEADERS = ("season", "week", "game_type", "team", "player", "offense_snaps")


def csv_bytes(headers, rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers)
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def stats_row(value="80", **extra):
    return {"season": "2026", "week": "6", "season_type": "REG", "position": "WR", "team": "SEA",
            "player_id": "00-fixture", "player_display_name": "Alpha One", "passing_yards": "",
            "rushing_yards": "", "receiving_yards": value, **extra}


def snap_row(**extra):
    return {"season": "2026", "week": "6", "game_type": "REG", "team": "SEA",
            "player": "Alpha One", "offense_snaps": "50", **extra}


def generation(snapshot_dir, created=T0):
    pool = cards._fixture_pool(created)
    pool.update(week=6, base_model_version="fixture-base")
    pool["players"] = pool["players"][:1]
    player = pool["players"][0]
    player.update(team="SEA", gsis_id="espn-fixture-1")
    for rung in player["rungs"]:
        z = (player["mu"] - rung["line"]) / 30
        coef = {"a": math.log(rung["model_prob"] / (1 - rung["model_prob"])), "b": 0, "c": 0}
        features = {"market": player["market"], "line": rung["line"], "mu": player["mu"], "sd": 30,
                    "z": z, "p_team": player["p_team"], "calibration": coef, "correlation_tags": ["game:G1"]}
        context = {"season": 2026, "week": 6, "base_model_version": "fixture-base",
                   "forecast_created_utc": created, "source_snapshot_id": lr.fingerprint({"created": created}),
                   "source_timestamps": {"fixture": created}, "generation_sha": "synthetic-local-fixture"}
        receipt = lr.make_receipt({**player, **rung}, lr.base_probability(coef, z, player["p_team"]),
                                  None, context, features=features)
        rung.update(model_prob=receipt["served_prob"], learning_receipt=receipt)
    schedule = {"season": 2026, "games": [{"game_id": "G1", "week": 6, "home": "SEA", "away": "LAR",
                  "status": "STATUS_SCHEDULED", "kickoff_utc": KICKOFF}]}
    # The offered cohort is explicit; this fixture offers both supported rungs.
    offered = [{"card_id": "synthetic-card", "legs": [dict(r) for r in player["rungs"]]}]
    recorded = (lr.instant(created) + dt.timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    doc, _ = learning_journal.record(pool, schedule, None, offered, recorded, str(snapshot_dir))
    return doc, pool, schedule


def bundle(*, value="80", status="STATUS_FINAL", stats_rows=None, snap_rows=None,
           observed="2026-09-03T12:00:00Z", game_extra=None):
    event = {"id": "G1", "date": KICKOFF, "status": {"type": {"name": status}},
             "competitions": [{"competitors": [
                 {"homeAway": "home", "score": "24", "team": {"abbreviation": "SEA"}},
                 {"homeAway": "away", "score": "17", "team": {"abbreviation": "LAR"}}]}]}
    if game_extra:
        event.update(copy.deepcopy(game_extra))
    scoreboard = json.dumps({"season": {"year": 2026}, "week": {"number": 6}, "events": [event]}).encode()
    bodies = {capture.SCOREBOARD_PROFILE: scoreboard,
              capture.STATS_PROFILE: csv_bytes(STATS_HEADERS, [stats_row(value)] if stats_rows is None else stats_rows),
              capture.SNAPS_PROFILE: csv_bytes(SNAPS_HEADERS, [snap_row()] if snap_rows is None else snap_rows)}
    current = lr.instant(observed)

    def clock():
        nonlocal current
        current += dt.timedelta(seconds=1)
        return current.isoformat().replace("+00:00", "Z")

    return capture.capture(2026, [6], fetcher=lambda spec: (200, {}, bodies[spec["profile"]]), clock=clock)


def plan(snapshot_dir):
    return export_learning.plan(snapshot_dir)
