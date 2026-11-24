#!/usr/bin/env python3
"""Capture recent NFL outcomes and recover registered applications by exact ID."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import capture_outcome_evidence as capture, export_capture_application as application
from scripts import run_collection_handoff as handoff
from scripts import outcome_recovery_history as history

TOKEN = "SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"
POINTER_FIELDS = {"version", "run_id", "run_attempt", "application_id", "request_id"}
MAX_RECENT_GAMES = 48  # Three regular-season slates at most can intersect a 14-day window.
SHARED_CAPTURE_DIR = "selflearning-outcome-capture"
CONTINUABLE_REASONS = {
    "application_pending_budget",
    "application_pending_step_limit",
    "application_http_exhausted",
    "application_transport_exhausted",
}
SCOPED_DELIVERY_WINDOW_SECONDS = 285
MAX_SCOPED_CONTINUATIONS = 3
RECOVERY_PRIORITY = {"stopped": 0, "active": 1, "processed": 2}
MAX_RECOVERY_CANDIDATES_PER_GAME = 24
RECOVERY_SELECTION_SECONDS = 300


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


def _recent_first(games):
    game_ids = [game.get("game_id") for game in games]
    if (len(game_ids) > MAX_RECENT_GAMES
            or any(type(game_id) is not str or not application.GAME_SCOPE_ID.fullmatch(game_id) for game_id in game_ids)
            or len(set(game_ids)) != len(game_ids)):
        raise ValueError("invalid_outcome_schedule_game_ids")
    return sorted(games, key=lambda game: handoff.clock(handoff.schedule_stamp(game["kickoff_utc"])), reverse=True)


def automatic_selection(games, bundle):
    """Return FINAL IDs corroborated by one immutable schedule and provider capture."""
    observed = {row["game_id"]: row for row in capture.scoreboard_rows(bundle)}
    ids = [game["game_id"] for game in _recent_first(games)
           if game["game_id"] in observed and _same_final(observed[game["game_id"]], game)]
    return ids, len(games) - len(ids)


def _selection_outputs(env, entries, unverified, held):
    recover = sum(row["mode"] == "resume" for row in entries)
    fresh = len(entries) - recover
    with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        stream.write("entries=" + json.dumps(entries, separators=(",", ":")) + "\n")
        stream.write(f"selected_count={len(entries)}\nfresh_count={fresh}\nrecovery_count={recover}\n"
                     f"unverified_count={unverified}\nrecovery_held_count={held}\n")
    print(json.dumps({"status": "scoped_games_selected", "selected_games": len(entries), "fresh_games": fresh,
                      "recovery_games": recover, "unverified_games": unverified,
                      "recovery_held_games": held, "adoption_approved": False}))


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
    return pointer_value(handoff.queue.read(path), run_id, run_attempt)


def pointer_value(value, run_id, run_attempt):
    handoff.scope("daily.yml", run_id, run_attempt)
    handoff.fields(value, POINTER_FIELDS, versioned=True)
    handoff.need((value["run_id"], value["run_attempt"]) == (run_id, run_attempt))
    handoff.export._hash(value["application_id"])
    handoff.export._hash(value["request_id"])
    return value


def recoverable_application(scope, candidates, download, progress):
    """Choose a processed terminal, or the registered application furthest along."""
    best, best_rank, seen = None, None, set()
    game_id = scope["game_id"]
    for index, artifact in enumerate(candidates):
        if index >= MAX_RECOVERY_CANDIDATES_PER_GAME:
            raise history.HistoryError("outcome_recovery_candidate_limit")
        _, run_id, attempt, _, _ = artifact
        pointer = pointer_value(download(artifact), run_id, attempt)
        application_id, request_id = pointer["application_id"], pointer["request_id"]
        if (application_id, request_id) in seen:
            continue
        seen.add((application_id, request_id))
        summary = progress(application_id, request_id, scope)
        if summary is None:
            continue
        state, batches = summary
        rank = (RECOVERY_PRIORITY[state], batches)
        if best_rank is None or rank > best_rank:
            best = {"mode": "resume", "game_id": game_id, **pointer}
            best_rank = rank
        if state == "processed":
            break
    return best


def select_scoped(schedule, now, env, temp):
    season, games = recent_finals(schedule, now)
    probe = env.get("OUTCOME_PROBE_GAME_ID", "")
    if probe:
        _, game = recent_game(schedule, now, probe)
        games = [game]
    games = _recent_first(games)
    if not games:
        _selection_outputs(env, [], 0, 0)
        return 0
    deadline = time.monotonic() + RECOVERY_SELECTION_SECONDS
    github = history.GitHubHistory(env["OUTCOME_GITHUB_TOKEN"], deadline=deadline)
    earliest_kickoff = min(handoff.clock(handoff.schedule_stamp(game["kickoff_utc"])) for game in games)
    candidates = history.pointer_candidates(github.json, [game["game_id"] for game in games],
                                             earliest_kickoff, env["GITHUB_RUN_ID"])

    def inspect(game):
        game_id = game["game_id"]
        scope = {"policy": application.GAME_SCOPE_POLICY, "season": season,
                 "week": game["week"], "game_id": game_id}
        try:
            return recoverable_application(scope, candidates[game_id], github.download,
                lambda aid, rid, scope: application.registered_progress(
                    aid, rid, scope, env[TOKEN], deadline=deadline)), False
        except Exception:
            print(json.dumps({"status": "outcome_recovery_authority_held", "game_id": game_id,
                              "adoption_approved": False}))
            return None, True

    with ThreadPoolExecutor(max_workers=6) as pool:
        decisions = list(pool.map(inspect, games))
    recovery, fresh, held = [], [], 0
    for game, (entry, blocked) in zip(games, decisions):
        if entry is not None:
            recovery.append(entry)
        elif blocked or probe:
            held += 1
        else:
            fresh.append(game)
    unverified = 0
    if fresh:
        weeks = sorted({game["week"] for game in fresh})
        bundle = capture.capture(season, weeks, fetcher=capture.http_fetcher, include_roster=True)
        ids, unverified = automatic_selection(fresh, bundle)
        if ids:
            capture.save_capture(bundle, temp / SHARED_CAPTURE_DIR)
        recovery.extend({"mode": "fresh", "game_id": game_id} for game_id in ids)
    _selection_outputs(env, recovery, unverified, held)
    return 0


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
    """Continue a verified registration by exact IDs within fixed windows."""
    game_id = plan["request"]["game_scope"]["game_id"]
    result = application.send(plan, out_dir, token, max_run_seconds=SCOPED_DELIVERY_WINDOW_SECONDS)
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
    return continue_registered(pointer, game_id, token, result, MAX_SCOPED_CONTINUATIONS)


def continue_registered(pointer, game_id, token, result, windows, *, expected_scope=None):
    """Use only a verified saved registration, including in a later workflow."""
    for continuation in range(1, windows + 1):
        print(json.dumps({"status": "resuming_registered_application", "reason": result["reason"],
                          "application_id": pointer["application_id"], "continuation": continuation,
                          "adoption_approved": False}))
        try:
            scope = {"expected_scope": expected_scope} if expected_scope is not None else {}
            result = application.resume_registered(
                pointer["application_id"], pointer["request_id"], token,
                game_id=game_id, max_run_seconds=SCOPED_DELIVERY_WINDOW_SECONDS, **scope)
        except application.ApplicationExportError as error:
            result = {"status": "pending", "reason": str(error)}
        if result["status"] != "pending" or result.get("reason") not in CONTINUABLE_REASONS:
            break
    return result


def run(mode, *, env=os.environ):
    if (env.get("NFL_SELFLEARN_OUTCOME_MODE") != "record"
            or env.get("GITHUB_REPOSITORY", "").lower() != handoff.REPOSITORY
            or env.get("GITHUB_REF") != "refs/heads/main"):
        return 0
    try:
        handoff.forecast.capture.disabled_config()
        temp = Path(env["RUNNER_TEMP"]).resolve(strict=True)
        root = temp / "selflearning-outcomes"
        if mode == "recover-auto":
            handoff.need(env.get("NFL_SELFLEARN_OUTCOME_AUTOMATIC_GAMES") == "true")
            selected = env["OUTCOME_GAME_ID"]
            schedule = handoff.forecast.capture.read_input(ROOT / "data/schedule_full.json")
            scope, _ = recent_game(schedule, datetime.now(timezone.utc), selected)
            pointer = pointer_value({
                "version": 1, "run_id": env["OUTCOME_SOURCE_RUN_ID"],
                "run_attempt": env["OUTCOME_SOURCE_RUN_ATTEMPT"],
                "application_id": env["OUTCOME_APPLICATION_ID"], "request_id": env["OUTCOME_REQUEST_ID"],
            }, env["OUTCOME_SOURCE_RUN_ID"], env["OUTCOME_SOURCE_RUN_ATTEMPT"])
            return report(continue_registered(pointer, selected, env[TOKEN],
                {"status": "pending", "reason": "saved_registered_application"},
                1 + MAX_SCOPED_CONTINUATIONS, expected_scope=scope))
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
                return select_scoped(schedule, now, env, temp)

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
    parser.add_argument("mode", choices=("select", "prepare", "deliver", "deliver-scoped", "recover", "recover-auto"))
    return run(parser.parse_args().mode)


if __name__ == "__main__":
    raise SystemExit(main())
