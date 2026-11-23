#!/usr/bin/env python3
"""Capture recent NFL outcomes and recover registered applications by exact ID."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import capture_outcome_evidence as capture, export_capture_application as application
from scripts import run_collection_handoff as handoff

TOKEN = "SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"
POINTER_FIELDS = {"version", "run_id", "run_attempt", "application_id", "request_id"}


def recent_finals(schedule, now):
    season = schedule["season"]
    if type(season) is not int or not 2020 <= season <= 2100:
        raise ValueError("invalid_schedule_season")
    oldest = now - timedelta(days=14)
    games = []
    for game in schedule["games"]:
        week, kickoff = game.get("week"), game.get("kickoff_utc")
        if game.get("status") != "STATUS_FINAL" or type(week) is not int or not 1 <= week <= 18:
            continue
        if oldest <= handoff.clock(handoff.schedule_stamp(kickoff)) < now:
            games.append(game)
    return season, games


def recent_period(schedule, now):
    season, games = recent_finals(schedule, now)
    return season, sorted({game["week"] for game in games})


def recent_game(schedule, now, game_id):
    if type(game_id) is not str or not application.GAME_SCOPE_ID.fullmatch(game_id):
        raise ValueError("invalid_outcome_game_id")
    season, games = recent_finals(schedule, now)
    matches = [game for game in games if game.get("game_id") == game_id]
    if len(matches) != 1:
        raise ValueError("outcome_game_must_match_one_recent_final")
    scope = {"policy": application.GAME_SCOPE_POLICY, "season": season,
             "week": matches[0]["week"], "game_id": game_id}
    return scope, matches[0]


def _verify_selected_final(bundle, scope, scheduled):
    games = [row for row in capture.scoreboard_rows(bundle, scope["week"]) if row["game_id"] == scope["game_id"]]
    if len(games) != 1 or not games[0]["final"]:
        raise ValueError("outcome_game_must_match_one_captured_final")
    captured = games[0]
    if (captured["home"], captured["away"], capture._instant(captured["kickoff_utc"])) != (
            scheduled["home"], scheduled["away"], handoff.clock(handoff.schedule_stamp(scheduled["kickoff_utc"]))):
        raise ValueError("outcome_game_capture_schedule_mismatch")


def capture_pointer(plan, run_id, run_attempt):
    handoff.scope("daily.yml", run_id, run_attempt)
    request = plan["request"]
    return {"version": 1, "run_id": run_id, "run_attempt": run_attempt,
            "application_id": request["application_id"], "request_id": handoff.export.fingerprint(request)}


def read_pointer(path, run_id, run_attempt):
    handoff.scope("daily.yml", run_id, run_attempt)
    value = handoff.queue.read(path)
    handoff.fields(value, POINTER_FIELDS, versioned=True)
    handoff.need((value["run_id"], value["run_attempt"]) == (run_id, run_attempt))
    handoff.export._hash(value["application_id"])
    handoff.export._hash(value["request_id"])
    return value


def report(result):
    if result["status"] != "terminal_original":
        reason = result.get("reason")
        if not isinstance(reason, str) or reason not in application.SAFE:
            reason = "application_protocol_refused"
        print(json.dumps({"status": "pending", "reason": reason, "adoption_approved": False}))
        return 1
    terminal = result["result"]
    print(json.dumps({"status": terminal["status"], "application_id": terminal["application_id"],
                      "accepted_members": terminal["counts"]["accepted_members"],
                      "withheld_members": terminal["counts"]["withheld_members"],
                      "adoption_approved": False}))
    return 0 if terminal["processing_complete"] else 1


def run(mode, *, env=os.environ):
    if (env.get("NFL_SELFLEARN_OUTCOME_MODE") != "record"
            or env.get("GITHUB_REPOSITORY", "").lower() != handoff.REPOSITORY
            or env.get("GITHUB_REF") != "refs/heads/main"):
        return 0
    try:
        handoff.forecast.capture.disabled_config()
        temp = Path(env["RUNNER_TEMP"]).resolve(strict=True)
        root = temp / "selflearning-outcomes"
        if mode == "recover":
            pointer = read_pointer(temp / "selflearning-outcome-pointer" / "pointer.json",
                                   env["OUTCOME_SOURCE_RUN_ID"], env["OUTCOME_SOURCE_RUN_ATTEMPT"])
            try:
                result = application.resume_registered(pointer["application_id"], pointer["request_id"], env[TOKEN])
            except application.ApplicationExportError as error:
                return report({"status": "pending", "reason": str(error)})
            return report(result)
        run_id, attempt = env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"]
        if mode == "prepare":
            handoff.scope("daily.yml", run_id, attempt)
            schedule = handoff.forecast.capture.read_input(ROOT / "data/schedule_full.json")
            now = datetime.now(timezone.utc)
            selected = env.get("OUTCOME_GAME_ID", "")
            if selected:
                scoped, scheduled = recent_game(schedule, now, selected)
                season, weeks = scoped["season"], [scoped["week"]]
            else:
                scoped = None
                season, weeks = recent_period(schedule, now)
            if not weeks:
                print('{"status":"no_recent_finals","adoption_approved":false}')
                return 0
            bundle = capture.capture(season, weeks, fetcher=capture.http_fetcher, include_roster=True)
            if scoped is not None:
                _verify_selected_final(bundle, scoped, scheduled)
            manifest = capture.save_capture(bundle, root / "raw")
            plan = application.plan(manifest, application.ORIGIN, scope=scoped)
            handoff.export._immutable(root / "plan.json", plan, root=root)
            handoff.export._immutable(root / "pointer.json", capture_pointer(plan, run_id, attempt), root=root)
            print('{"status":"prepared","adoption_approved":false}')
            return 0
        if mode != "deliver":
            raise ValueError("invalid_outcome_mode")
        if not (root / "pointer.json").is_file():
            return 0
        pointer = read_pointer(root / "pointer.json", run_id, attempt)
        plan = handoff.queue.read(root / "plan.json")
        handoff.need(capture_pointer(plan, run_id, attempt) == pointer)
        return report(application.send(plan, root / "outbox", env[TOKEN], max_run_seconds=210))
    except Exception:
        print('{"status":"outcome_collection_held","adoption_approved":false}')
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "deliver", "recover"))
    return run(parser.parse_args().mode)


if __name__ == "__main__":
    raise SystemExit(main())
