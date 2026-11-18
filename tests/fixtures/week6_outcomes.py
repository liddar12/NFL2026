"""Synthetic local-only cross-repository outcome capture/producer fixture.

No source discovery, network, committed data writes, fitting or cloud records.
The real NFL receipt producer, journal, capture parser and player grader run.
"""
import copy
import csv
import datetime as dt
import io
import json
import math

from scripts import build_my_cards as cards, capture_outcome_evidence as capture
from scripts import export_learning, learning_journal, learning_receipts as lr, player_outcomes
from scripts.resolve_parlay_legs import index_snaps, index_stats

T0 = "2026-09-01T12:00:00Z"
RECORDED = "2026-09-01T12:01:00Z"
KICKOFF = "2026-09-02T00:15:00Z"
STATS_HEADERS = ("season", "week", "season_type", "position", "team", "player_id",
                 "player_display_name", "passing_yards", "rushing_yards", "receiving_yards")
SNAPS_HEADERS = ("season", "week", "game_type", "team", "player", "offense_snaps")
ROSTER_IDENTITY_HEADERS = ("season", "espn_id", "gsis_id", "pfr_id")
ROSTER_HEADERS = (*ROSTER_IDENTITY_HEADERS, "week", "team")
BOUND_STATS_HEADERS = (*STATS_HEADERS, "game_id", "opponent_team")
BOUND_SNAPS_HEADERS = (*SNAPS_HEADERS, "game_id", "opponent", "pfr_player_id")
FIXTURE_NFLVERSE_GAME = "2026_06_LAR_SEA"


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


def roster_row(**extra):
    return {"season": "2026", "espn_id": "fixture-1", "gsis_id": "00-fixture",
            "pfr_id": "OneAl00", "week": "7", "team": "MIN", **extra}


def player_ids(index=0):
    return f"espn-{9_100_001 + index}", f"00-{91_001 + index:07d}", f"AlphOn{index:02d}"


def bound_stats_row(value="80", *, player_index=0, **extra):
    return stats_row(value, **{"player_id": player_ids(player_index)[1],
                              "game_id": FIXTURE_NFLVERSE_GAME, "opponent_team": "LAR", **extra})


def bound_snap_row(*, player_index=0, **extra):
    return snap_row(**{"pfr_player_id": player_ids(player_index)[2],
                       "game_id": FIXTURE_NFLVERSE_GAME, "opponent": "LAR", **extra})


def bound_roster_row(index=0, **extra):
    espn, gsis, pfr = player_ids(index)
    return roster_row(**{"espn_id": espn.removeprefix("espn-"), "gsis_id": gsis, "pfr_id": pfr, **extra})


def generation(snapshot_dir, created=T0, *, player_id="espn-fixture-1"):
    pool = cards._fixture_pool(created)
    pool.update(week=6, base_model_version="fixture-base")
    pool["players"] = pool["players"][:1]
    player = pool["players"][0]
    player.update(team="SEA", gsis_id=player_id)
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


def bound_generation(snapshot_dir, created=T0):
    return generation(snapshot_dir, created, player_id=player_ids()[0])


def bundle(*, value="80", status="STATUS_FINAL", stats_rows=None, snap_rows=None,
           observed="2026-09-03T12:00:00Z", game_extra=None, include_roster=False,
           roster_headers=ROSTER_HEADERS, roster_rows=None, stats_headers=STATS_HEADERS,
           snap_headers=SNAPS_HEADERS):
    event = {"id": "G1", "date": KICKOFF, "status": {"type": {"name": status}},
             "competitions": [{"competitors": [
                 {"homeAway": "home", "score": "24", "team": {"abbreviation": "SEA"}},
                 {"homeAway": "away", "score": "17", "team": {"abbreviation": "LAR"}}]}]}
    if game_extra:
        event.update(copy.deepcopy(game_extra))
    scoreboard = json.dumps({"season": {"year": 2026}, "week": {"number": 6}, "events": [event]}).encode()
    bodies = {capture.SCOREBOARD_PROFILE: scoreboard,
              capture.STATS_PROFILE: csv_bytes(stats_headers, [stats_row(value)] if stats_rows is None else stats_rows),
              capture.SNAPS_PROFILE: csv_bytes(snap_headers, [snap_row()] if snap_rows is None else snap_rows)}
    if include_roster:
        if roster_rows is None:
            row = roster_row()
            roster_rows = [{key: row[key] for key in roster_headers}]
        bodies[capture.ROSTERS_PROFILE] = csv_bytes(roster_headers, roster_rows)
    current = lr.instant(observed)

    def clock():
        nonlocal current
        current += dt.timedelta(seconds=1)
        return current.isoformat().replace("+00:00", "Z")

    return capture.capture(2026, [6], fetcher=lambda spec: (200, {}, bodies[spec["profile"]]),
                           clock=clock, include_roster=include_roster)


def bound_bundle(*, value="80", stats_rows=None, snap_rows=None, roster_rows=None, include_roster=True, **kwargs):
    if stats_rows is None:
        stats_rows = [bound_stats_row(value)]
    if snap_rows is None:
        snap_rows = [bound_snap_row(), bound_snap_row(player_index=1, player="Away Starter",
                                                     team="LAR", opponent="SEA")]
    if roster_rows is None:
        roster_rows = [bound_roster_row(i) for i in range(3)]
    return bundle(stats_rows=stats_rows, snap_rows=snap_rows, roster_rows=roster_rows,
                  include_roster=include_roster, stats_headers=BOUND_STATS_HEADERS,
                  snap_headers=BOUND_SNAPS_HEADERS, **kwargs)


def grades_from_capture(plan_doc, schedule, captured):
    """Compute product-side grades from captured bytes and the original rungs."""
    capture.verify_capture(captured)
    source_snapshots = {item["object_id"]: item["payload"] for item in plan_doc["source_objects"]}
    sources = {item["profile"] for item in captured["manifest"]["sources"]}
    roster = capture.csv_rows(captured, capture.ROSTERS_PROFILE) if capture.ROSTERS_PROFILE in sources else []
    stats = capture.csv_rows(captured, capture.STATS_PROFILE)
    snaps = capture.csv_rows(captured, capture.SNAPS_PROFILE)
    finals = {game["game_id"]: game for game in capture.scoreboard_rows(captured) if game["final"]}
    context = player_outcomes.context(schedule["games"], finals, schedule["season"], player_outcomes.identity_maps(roster))
    stats_by_week, snaps_by_week = index_stats(stats), index_snaps(snaps)
    grades = {}
    for item in plan_doc["generations"]:
        doc = item["request"]["payload"]
        generations = {g["generation_id"]: g for g in doc["generations"]}
        for row in doc["receipts"]:
            receipt = row["learning_receipt"]
            sources = generations[row["generation_id"]]["source_snapshots"]
            pool = source_snapshots[sources["leg_pool"]]
            player = next(p for p in pool["players"] if p["gsis_id"] == receipt["player_id"])
            leg = {**player, **row["leg"], "season": receipt["season"]}
            week = receipt["week"]
            facts = player_outcomes.player_event_facts(
                leg, week, stats_by_week.get(week), None, snaps_by_week.get(week), context)
            result, actual, reason = player_outcomes.grade_fact(facts, receipt["market"], receipt["line"])
            grades[row["receipt_id"]] = {"game_id": receipt["game_id"], "line": receipt["line"],
                                         "result": result, "actual": actual, "reason": reason}
    return grades


def plan(snapshot_dir):
    return export_learning.plan(snapshot_dir)
