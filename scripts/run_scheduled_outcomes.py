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
MAX_RECENT_GAMES = 48  # Three regular-season slates at most can intersect a 14-day window.
SHARED_CAPTURE_DIR = "selflearning-outcome-capture"
CONTINUABLE_REASONS = {"application_pending_budget", "application_pending_step_limit"}


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


def _same_final(captured, scheduled):
    return (captured["final"] and
            (captured["week"], captured["home"], captured["away"], capture._instant(captured["kickoff_utc"])) ==
            (scheduled["week"], scheduled["home"], scheduled["away"],
             handoff.clock(handoff.schedule_stamp(scheduled["kickoff_utc"]))))


def _verify_selected_final(bundle, scope, scheduled):
    matches = [row for row in capture.scoreboard_rows(bundle, scope["week"]) if row["game_id"] == scope["game_id"]]
    if len(matches) != 1 or not _same_final(matches[0], scheduled):
        raise ValueError("outcome_game_capture_schedule_mismatch")


def automatic_selection(games, bundle):
    """Return FINAL IDs corroborated by one immutable schedule and provider capture."""
    game_ids = [game.get("game_id") for game in games]
    if (len(game_ids) > MAX_RECENT_GAMES
            or any(type(game_id) is not str or not application.GAME_SCOPE_ID.fullmatch(game_id) for game_id in game_ids)
            or len(set(game_ids)) != len(game_ids)):
        raise ValueError("invalid_outcome_schedule_game_ids")
    observed = {row["game_id"]: row for row in capture.scoreboard_rows(bundle)}
    recent_first = sorted(games, key=lambda game: handoff.clock(handoff.schedule_stamp(game["kickoff_utc"])), reverse=True)
    ids = [game["game_id"] for game in recent_first
           if game["game_id"] in observed and _same_final(observed[game["game_id"]], game)]
    return ids, len(games) - len(ids)


def _selection_outputs(env, ids, unverified):
    with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        stream.write("game_ids=" + json.dumps(ids, separators=(",", ":")) + "\n")
        stream.write(f"selected_count={len(ids)}\nunverified_count={unverified}\n")
    print(json.dumps({"status": "scoped_games_selected", "selected_games": len(ids),
                      "unverified_games": unverified, "adoption_approved": False}))


def _shared_manifest(temp):
    manifests = list((temp / SHARED_CAPTURE_DIR / "captures").glob("*.json"))
    if len(manifests) != 1:
        raise ValueError("invalid_shared_outcome_capture")
    return manifests[0]


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
                      "processing_complete": terminal["processing_complete"],
                      "complete_success": terminal["complete_success"],
                      "adoption_approved": False}))
    return 0 if terminal["processing_complete"] else 1


def deliver_scoped(plan, pointer, out_dir, token):
    """Retry only an already verified registration, once and by exact IDs."""
    game_id = plan["request"]["game_scope"]["game_id"]
    result = application.send(plan, out_dir, token, max_run_seconds=210)
    if result["status"] != "pending" or result.get("reason") not in CONTINUABLE_REASONS:
        return result

    root, target = application.paths(plan, out_dir)
    path = handoff.export._delivery_path(root, *target.relative_to(root).parts, "registration", "original.json")
    if not path.is_file():
        return result
    registration = handoff.queue.read(path)
    application.result_base(registration, application.REG_KEYS,
                            "nfl.capture_application_registration.v2", "sealed_application_only")
    application.hashed(registration, "registration_id")
    application.need(registration["status"] == "registered" and registration["learning_accepted"] is False
                     and registration["application_id"] == pointer["application_id"]
                     and registration["request_id"] == pointer["request_id"])
    print(json.dumps({"status": "resuming_registered_application", "reason": result["reason"],
                      "application_id": pointer["application_id"], "adoption_approved": False}))
    try:
        return application.resume_registered(pointer["application_id"], pointer["request_id"], token,
                                             game_id=game_id, max_run_seconds=180)
    except application.ApplicationExportError as error:
        return {"status": "pending", "reason": str(error)}


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
            selected = env.get("OUTCOME_SOURCE_GAME_ID")
            expected = {"game_id": selected} if selected else {}
            try:
                result = application.resume_registered(pointer["application_id"], pointer["request_id"], env[TOKEN], **expected)
            except application.ApplicationExportError as error:
                return report({"status": "pending", "reason": str(error)})
            return report(result)
        run_id, attempt = env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"]
        if mode in ("prepare", "select"):
            handoff.scope("daily.yml", run_id, attempt)
            schedule = handoff.forecast.capture.read_input(ROOT / "data/schedule_full.json")
            now = datetime.now(timezone.utc)
            automatic = env.get("NFL_SELFLEARN_OUTCOME_AUTOMATIC_GAMES") == "true"
            if mode == "select":
                handoff.need(automatic)
                season, games = recent_finals(schedule, now)
                if not games:
                    _selection_outputs(env, [], 0)
                    return 0
                weeks = sorted({game["week"] for game in games})
                bundle = capture.capture(season, weeks, fetcher=capture.http_fetcher, include_roster=True)
                ids, unverified = automatic_selection(games, bundle)
                if ids:
                    capture.save_capture(bundle, temp / SHARED_CAPTURE_DIR)
                _selection_outputs(env, ids, unverified)
                return 0

            selected = env.get("OUTCOME_GAME_ID", "")
            if env.get("OUTCOME_SHARED_CAPTURE") == "true":
                handoff.need(automatic and selected)
                manifest = _shared_manifest(temp)
                bundle = capture.load_capture(manifest)
                now = capture._instant(bundle["manifest"]["started_utc"])
                scoped, scheduled = recent_game(schedule, now, selected)
                _verify_selected_final(bundle, scoped, scheduled)
            else:
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
        if mode not in ("deliver", "deliver-scoped"):
            raise ValueError("invalid_outcome_mode")
        if not (root / "pointer.json").is_file():
            handoff.need(mode == "deliver")
            return 0
        pointer = read_pointer(root / "pointer.json", run_id, attempt)
        plan = handoff.queue.read(root / "plan.json")
        handoff.need(capture_pointer(plan, run_id, attempt) == pointer)
        if mode == "deliver-scoped":
            return report(deliver_scoped(plan, pointer, root / "outbox", env[TOKEN]))
        return report(application.send(plan, root / "outbox", env[TOKEN], max_run_seconds=210))
    except Exception:
        print('{"status":"outcome_collection_held","adoption_approved":false}')
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("select", "prepare", "deliver", "deliver-scoped", "recover"))
    return run(parser.parse_args().mode)


if __name__ == "__main__":
    raise SystemExit(main())
