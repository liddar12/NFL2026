#!/usr/bin/env python3
"""Default-off local forecast/outcome intake, NOT an operational learning loop.

Only --send reads the two distinct credentials or permits HTTP. --prepare writes
immutable local metadata, never sports data. Cached ACKs prove local original
integrity, not a fresh database query, provider origin or namespace authenticity.
Intake completion is original-operation completion, not proof that every newly
acknowledged forecast is graded by an older immutable capture application.
Socket/deadline checks are bounded recovery, not a hard DNS wall-clock guarantee.
"""
import sys
sys.dont_write_bytecode = True

import copy
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scripts import export_learning as forecast, export_capture_application as outcome  # noqa: E402

ORIGIN = outcome.ORIGIN
MAX_PLAN_BYTES = 128 * 1024 * 1024
MAX_CAPTURES, MAX_GENERATIONS, MAX_OBJECTS = 16, 256, 1024
FLAGS = {"evaluation_run": False, "model_adoption": False, "working_learning_loop": False,
         "namespace_authenticated": False, "source_completeness_verified": False,
         "current_membership_reverified": False, "current_outcome_coverage_verified": False}


class IntakeError(ValueError):
    """Static machine code only; untrusted callback text is never reported."""


class IntakeBudgetExceeded(RuntimeError):
    """Not TimeoutError/ExportError: legacy per-item catches cannot swallow it."""


def need(condition, reason="invalid_intake_plan"):
    if not condition:
        raise IntakeError(reason)


def keys(value, expected):
    need(type(value) is dict and set(value) == set(expected))


def no_credentials(value, credentials):
    """Refuse credential echoes before ANY input/ACK string is persisted."""
    pending = [value]
    while pending:
        node = pending.pop()
        if type(node) is str:
            need(not any(token in node for token in credentials), "intake_credential_echo_refused")
        elif type(node) is dict:
            pending.extend(node.keys()); pending.extend(node.values())
        elif type(node) in (list, tuple):
            pending.extend(node)


def bounded_read(path, maximum):
    try:
        with path.open("rb") as stream:
            raw = stream.read(maximum + 1)
        need(len(raw) <= maximum, "intake_local_record_too_large")
        return forecast._json(raw)
    except (OSError, forecast.ExportError):
        raise IntakeError("intake_local_record_unavailable") from None


def forecast_plan_valid(value):
    """Validate the saved transport graph without reopening its source paths."""
    keys(value, {"version", "snapshot_dir", "source_objects", "generations"})
    need(type(value["version"]) is int and value["version"] == 1)
    need(type(value["snapshot_dir"]) is str and str(outcome.O._selected_path(value["snapshot_dir"])) == value["snapshot_dir"])
    need(type(value["source_objects"]) is list and 1 <= len(value["source_objects"]) <= MAX_OBJECTS)
    need(type(value["generations"]) is list and 1 <= len(value["generations"]) <= MAX_GENERATIONS)
    sources, generations, periods, copies = set(), set(), set(), 0
    for request in value["source_objects"]:
        keys(request, {"version", "kind", "object_id", "payload"})
        need(type(request["version"]) is int and request["version"] == 1 and request["kind"] == "source_snapshot")
        forecast._hash(request["object_id"])
        need(request["object_id"] == forecast.fingerprint(request["payload"]) and request["object_id"] not in sources)
        need(len(forecast.encoded(request)) <= forecast.MAX_BODY_BYTES)
        sources.add(request["object_id"])
    for entry in value["generations"]:
        keys(entry, {"request", "expected_receipt_ids"})
        request, expected = entry["request"], entry["expected_receipt_ids"]
        keys(request, {"version", "kind", "object_id", "payload"})
        need(type(request["version"]) is int and request["version"] == 1 and request["kind"] == "generation")
        forecast._hash(request["object_id"])
        need(request["object_id"] not in generations and len(forecast.encoded(request)) <= forecast.MAX_BODY_BYTES)
        generations.add(request["object_id"])
        doc = request["payload"]
        need(type(doc) is dict and type(doc.get("version")) is int and doc["version"] == 1
             and doc.get("envelope_id") == request["object_id"]
             and forecast.fingerprint({k: v for k, v in doc.items() if k != "envelope_id"}) == request["object_id"]
             and type(doc.get("generations")) is list and len(doc["generations"]) == 1)
        generation = doc["generations"][0]
        need(type(generation) is dict and all(k in generation for k in forecast.MANIFEST_KEYS))
        need(generation.get("generation_id") == forecast.fingerprint({k: generation[k] for k in forecast.MANIFEST_KEYS}))
        season, week = doc.get("season"), doc.get("week")
        need(type(season) is int and type(week) is int and 1 <= week <= 18
             and generation.get("season") == season and generation.get("week") == week)
        refs = generation.get("source_snapshots")
        keys(refs, {"leg_pool", "schedule", "parlay_calibration"})
        need(all(digest in sources for digest in refs.values()))
        need(type(expected) is list and expected == sorted(set(expected)))
        for digest in expected:
            forecast._hash(digest)
        need(type(doc.get("receipts")) is list)
        found = []
        for row in doc["receipts"]:
            need(type(row) is dict and type(row.get("learning_receipt")) is dict
                 and row.get("generation_id") == generation["generation_id"]
                 and row.get("receipt_id") == row["learning_receipt"].get("receipt_id"))
            found.append(row["receipt_id"])
        need(len(found) == len(set(found)) and sorted(found) == expected
             and type(generation.get("receipt_ids")) is list
             and len(generation["receipt_ids"]) == len(set(generation["receipt_ids"]))
             and sorted(generation["receipt_ids"]) == expected)
        copies += len(expected)
        if expected:
            periods.add((season, week))
    need(copies > 0, "intake_empty_forecasts")
    return {"objects": len(sources) + len(generations), "generations": len(generations), "receipt_copies": copies}, periods


def validate_plan(value):
    keys(value, {"version", "kind", "destination", "forecast_plan", "forecast_plan_id", "capture_plans", "run_id"})
    need(type(value["version"]) is int and value["version"] == 1 and value["kind"] == "nfl.learning_intake_run.v1")
    need(outcome.O._origin(value["destination"]) == ORIGIN)
    need(value["forecast_plan_id"] == forecast.fingerprint(value["forecast_plan"]))
    _, periods = forecast_plan_valid(value["forecast_plan"])
    need(type(value["capture_plans"]) is list and 1 <= len(value["capture_plans"]) <= MAX_CAPTURES)
    applications = set()
    for captured in value["capture_plans"]:
        outcome.validate_plan(captured)
        aid = captured["request"]["application_id"]
        need(aid not in applications, "intake_duplicate_capture")
        applications.add(aid)
        manifest = captured["request"]["capture_request"]["envelope"]["manifest"]
        need(all((manifest["season"], week) in periods for week in manifest["weeks"]), "intake_forecast_period_missing")
    need(value["run_id"] == forecast.fingerprint({k: v for k, v in value.items() if k != "run_id"}))
    need(len(forecast.encoded(value)) <= MAX_PLAN_BYTES, "intake_plan_too_large")
    return copy.deepcopy(value)


def plan(snapshot_dir, captures, destination=ORIGIN):
    destination = outcome.O._origin(destination)
    need(type(captures) in (list, tuple) and 1 <= len(captures) <= MAX_CAPTURES)
    snapshots = outcome.O._selected_path(snapshot_dir)
    original = forecast.plan(snapshots)
    value = {"version": 1, "kind": "nfl.learning_intake_run.v1", "destination": destination,
        "forecast_plan": original, "forecast_plan_id": forecast.fingerprint(original),
        "capture_plans": [outcome.plan(path, destination) for path in captures]}
    value["run_id"] = forecast.fingerprint(value)
    return validate_plan(value)


def paths(value, out_dir):
    output = outcome.O._selected_path(out_dir)
    snapshots = Path(value["forecast_plan"]["snapshot_dir"])
    authorities = [snapshots, _ROOT / "data", *(Path(c["capture_plan"]["capture_path"]).parent.parent for c in value["capture_plans"])]
    need(output != _ROOT and not any(output.is_relative_to(p) or p.is_relative_to(output) for p in authorities),
         "intake_output_overlaps_authority")
    destination = forecast.fingerprint({"base_url": ORIGIN})[7:]
    target = forecast._delivery_path(output, destination, "intake-runs", value["run_id"][7:])
    for name in ("forecasts", "outcomes", "attempts"):
        forecast._delivery_path(output, *target.relative_to(output).parts, name)
    return output, target


def save(output, path, value):
    try:
        if path.exists():
            need(path.stat().st_size <= MAX_PLAN_BYTES + 1, "intake_local_record_too_large")
        forecast._immutable(path, value, root=output)
    except Exception:
        raise IntakeError("intake_original_conflict") from None


def prepare(value, out_dir):
    value = validate_plan(value)
    need(forecast._same_json(forecast.plan(value["forecast_plan"]["snapshot_dir"]), value["forecast_plan"]), "intake_forecast_source_changed")
    for captured in value["capture_plans"]:
        outcome.O._validated(captured["capture_plan"])
    output, target = paths(value, out_dir)
    save(output, target / "run.json", value)
    for captured in value["capture_plans"]:
        outcome.prepare(captured, target / "outcomes")
    return summary(value, "prepared_only", False, forecast_complete=False, network_used=False, writes=True)


def operations(value):
    for request in value["forecast_plan"]["source_objects"]:
        yield request, "object", ()
    for entry in value["forecast_plan"]["generations"]:
        yield entry["request"], "object", ()
        yield {"version": 1, "object_id": entry["request"]["object_id"]}, "generation", entry["expected_receipt_ids"]


def original_forecast_proof(value, root, credentials=()):
    """Validate ALL original ACK/outbox records; never infer from summary.ok."""
    expected, _ = forecast_plan_valid(value["forecast_plan"])
    dest = forecast.fingerprint({"base_url": ORIGIN})
    ack_ids = []
    for request, phase, receipt_ids in operations(value):
        operation = {"version": 1, "destination_id": dest, "phase": phase, "object_id": request["object_id"]}
        if phase == "object":
            operation["kind"] = request["kind"]
        name = forecast.fingerprint(operation)[7:]
        conflict = {"operation": operation, "reason": "immutable_delivery_conflict"}
        conflict_path = forecast._delivery_path(root, dest[7:], "failures", forecast.fingerprint(conflict)[7:] + ".json")
        need(not conflict_path.exists(), "intake_forecast_ack_conflict")
        outbox = forecast._delivery_path(root, dest[7:], "outbox", name + ".json")
        ack_path = forecast._delivery_path(root, dest[7:], "acks", name + ".json")
        if not outbox.exists() or not ack_path.exists():
            return None
        prepared = bounded_read(outbox, forecast.MAX_BODY_BYTES + 65536)
        stored = bounded_read(ack_path, forecast.MAX_BODY_BYTES + 65536)
        keys(prepared, {"operation", "request"}); keys(stored, {"operation", "ack"})
        need(forecast._same_json(prepared, {"operation": operation, "request": request})
             and forecast._same_json(stored["operation"], operation), "intake_forecast_ack_conflict")
        forecast._validate_ack(stored["ack"], operation, receipt_ids)
        need(forecast._same_json(stored["ack"], forecast._safe_ack(stored["ack"], phase)), "intake_forecast_ack_conflict")
        no_credentials(stored["ack"], credentials)
        if phase == "generation":
            need(not stored["ack"]["rejections"], "intake_forecast_rejections")
        ack_ids.append(forecast.fingerprint(stored))
    return {"version": 1, "kind": "nfl.learning_intake_forecast_proof.v1", "run_id": value["run_id"],
        "forecast_plan_id": value["forecast_plan_id"], "expected": expected, "ack_ids": ack_ids,
        "complete": True, "scope": "local_original_ack_integrity_only", "database_requeried": False,
        "namespace_authenticated": False}


def forecast_route(route, body):
    need(type(route) is str and route in (forecast.OBJECT_ROUTE, forecast.GENERATION_ROUTE), "intake_forecast_route_refused")
    need(type(body) is bytes and 1 <= len(body) <= forecast.MAX_BODY_BYTES, "intake_forecast_body_refused")
    request = forecast._json(body)
    keys(request, {"version", "object_id"} if route == forecast.GENERATION_ROUTE else {"version", "object_id", "kind", "payload"})
    need(type(request["version"]) is int and request["version"] == 1 and forecast.encoded(request) == body)
    forecast._hash(request["object_id"])
    if route == forecast.OBJECT_ROUTE:
        need(request["kind"] in ("source_snapshot", "generation"))
    return request


def forecast_http_transport(token, end, monotonic):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), forecast._NoRedirect())
    def remaining():
        seconds = end - monotonic()
        if seconds <= 0:
            raise IntakeBudgetExceeded()
        return min(20, seconds)
    def post(route, body):
        forecast_route(route, body); remaining()  # Before URL/credential construction.
        request = urllib.request.Request(ORIGIN + route, data=body, method="POST", headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with opener.open(request, timeout=remaining()) as response:
                need(response.geturl() == ORIGIN + route)
                chunks, size = [], 0
                while size <= forecast.MAX_BODY_BYTES:
                    remaining()
                    part = response.read1(min(65536, forecast.MAX_BODY_BYTES + 1 - size))
                    remaining(); need(type(part) is bytes)
                    if not part:
                        break
                    chunks.append(part); size += len(part)
                need(size <= forecast.MAX_BODY_BYTES)
                return response.status, b"".join(chunks)
        except urllib.error.HTTPError as error:
            error.close(); remaining(); return error.code, b""
    return post


def summary(value, status, complete, **fields):
    return {"version": 1, "kind": "nfl.learning_intake_status.v1", "run_id": value["run_id"],
        "status": status, "intake_complete": complete, "scope": "intake_only", **fields, **FLAGS}


def send(value, out_dir, forecast_token, outcome_token, *, forecast_transport=None, outcome_transport=None,
         attempts=3, max_steps=16, max_run_seconds=240, sleep=time.sleep, monotonic=time.monotonic):
    value = validate_plan(value)
    for token in (forecast_token, outcome_token):
        need(type(token) is str and 32 <= len(token) <= 8192 and all(0x21 <= ord(c) <= 0x7e for c in token), "intake_invalid_credentials")
    need(forecast_token != outcome_token, "intake_credentials_not_distinct")
    credentials = (forecast_token, outcome_token)
    # A credential could itself look like a public content ID. Refuse that
    # collision before writing immutable input metadata rather than redacting
    # protocol identities or weakening the original graph/hash contracts.
    no_credentials(value, credentials)
    need(type(attempts) is int and 1 <= attempts <= 5 and type(max_steps) is int and 1 <= max_steps <= 2000)
    need(type(max_run_seconds) in (int, float) and math.isfinite(max_run_seconds) and 0 < max_run_seconds <= 300
         and callable(monotonic) and callable(sleep))
    end, phase, results, used_steps = monotonic() + max_run_seconds, "forecasts", [], set()
    def check():
        if monotonic() >= end:
            raise IntakeBudgetExceeded()
    def pause(seconds):
        check()
        try:
            sleep(min(seconds, max(0, end - monotonic())))
        except Exception:
            raise IntakeError("intake_sleep_refused") from None
        check()
    output, target = paths(value, out_dir)
    save(output, target / "run.json", value)
    def finish(status, complete=False, **fields):
        result = summary(value, status, complete, forecast_complete=phase != "forecasts",
            capture_results=results, steps_issued=len(used_steps), **fields)
        save(output, target / "attempts" / (forecast.fingerprint(result)[7:] + ".json"), result)
        return result
    try:
        check()
        proof_path = target / "forecast-complete.json"
        proof = original_forecast_proof(value, target / "forecasts", credentials)
        if proof_path.exists():
            need(proof is not None and forecast._same_json(bounded_read(proof_path, MAX_PLAN_BYTES), proof), "intake_forecast_proof_incomplete")
        elif proof is None:
            channel = forecast_transport or forecast_http_transport(forecast_token, end, monotonic)
            expected_by_object = {entry["request"]["object_id"]: entry["expected_receipt_ids"]
                                  for entry in value["forecast_plan"]["generations"]}
            def post(route, body):
                request = forecast_route(route, body); check()
                try:
                    result = channel(route, body)
                except IntakeBudgetExceeded:
                    raise
                except (urllib.error.URLError, TimeoutError, OSError):
                    # Keep legacy bounded retry behavior, never callback text.
                    raise OSError("intake_forecast_transport_failed") from None
                except Exception:
                    # In particular, do not let an injected ExportError carry
                    # untrusted text into legacy per-operation failure files.
                    raise IntakeError("intake_forecast_transport_refused") from None
                check()
                status, raw = result
                if type(status) is int and 200 <= status < 300:
                    need(type(raw) is bytes and len(raw) <= forecast.MAX_BODY_BYTES)
                    ack = forecast._json(raw)
                    phase = "object" if route == forecast.OBJECT_ROUTE else "generation"
                    expected = () if phase == "object" else expected_by_object.get(request["object_id"])
                    need(expected is not None)
                    operation = {"phase": phase, "object_id": request["object_id"]}
                    forecast._validate_ack(ack, operation, expected)
                    if phase == "generation":
                        # Legacy safe_ack retains arbitrary reason strings.
                        # Our acceptance policy forbids ANY rejected receipt;
                        # stop here, before that older exporter can cache it.
                        need(not ack["rejections"], "intake_forecast_rejections")
                    no_credentials(forecast._safe_ack(ack, phase), credentials)
                return result
            reported = forecast.send(value["forecast_plan"], ORIGIN, target / "forecasts", forecast_token,
                transport=post, attempts=attempts, sleep=pause)
            check()
            expected, _ = forecast_plan_valid(value["forecast_plan"])
            need(type(reported) is dict and reported.get("ok") is True and reported.get("failures") == []
                 and type(reported.get("receipts_rejected")) is int and reported["receipts_rejected"] == 0
                 and all(type(reported.get(key)) is int and reported[key] == count for key, count in (
                     ("objects_acked", expected["objects"]), ("generations_acked", expected["generations"]),
                     ("receipts_acked", expected["receipt_copies"]))), "intake_forecasts_incomplete")
            proof = original_forecast_proof(value, target / "forecasts", credentials)
        need(proof is not None, "intake_forecast_proof_incomplete")
        save(output, proof_path, proof)
        phase = "outcomes"; check()
        channel = outcome_transport or outcome.http_transport(ORIGIN, outcome_token, deadline=end, monotonic=monotonic)
        def exchange(method, route, body):
            outcome.route_valid(method, route, body)
            check()
            if method == "POST" and "/steps/" in route and route not in used_steps:
                if len(used_steps) >= max_steps:
                    raise outcome.ApplicationBudgetExceeded("application_pending_budget")
                used_steps.add(route)
            elif method == "POST" and "/steps/" not in route and len(used_steps) >= max_steps:
                # GET can recover completed originals, but a spent allowance
                # cannot stage/register another capture in this command.
                raise outcome.ApplicationBudgetExceeded("application_pending_budget")
            result = channel(method, route, body); check()
            status, raw = result
            if type(status) is int and 200 <= status < 300:
                # The child persists full valid pages/reports, including
                # opaque revision IDs and reason codes. A correct content
                # hash is not a privacy check: refuse echoes in EVERY
                # successful JSON response before returning it to the child.
                need(type(raw) is bytes and len(raw) <= forecast.MAX_BODY_BYTES)
                no_credentials(forecast._json(raw), credentials)
            return result
        for captured in value["capture_plans"]:
            check()
            result = outcome.send(captured, target / "outcomes", outcome_token, transport=exchange,
                # Even after the new-step allowance is consumed, GET may
                # recover an already-complete original without issuing steps.
                attempts=attempts, max_steps=max(1, max_steps - len(used_steps)), max_run_seconds=end - monotonic(),
                sleep=pause, monotonic=monotonic)
            results.append(result); check()
            if result.get("status") == "pending":
                return finish("pending_outcomes", reason="intake_outcome_pending")
            need(result.get("status") == "terminal_original" and result.get("durable_result_ack") is True,
                 "intake_outcome_original_unavailable")
            if result.get("complete_success") is not True:
                return finish("terminal_incomplete", reason="intake_outcome_terminal_incomplete")
        return finish("intake_complete", True)
    except IntakeBudgetExceeded:
        return finish("pending_" + phase, reason="intake_command_budget")
    except Exception:
        return finish("pending_" + phase, reason="intake_phase_refused")


def resume(out_dir, run_id, forecast_token, outcome_token, **kwargs):
    forecast._hash(run_id)
    output = outcome.O._selected_path(out_dir)
    need(output != _ROOT and not (output.is_relative_to(_ROOT / "data") or (_ROOT / "data").is_relative_to(output)))
    path = forecast._delivery_path(output, forecast.fingerprint({"base_url": ORIGIN})[7:], "intake-runs", run_id[7:], "run.json")
    value = validate_plan(bounded_read(path, MAX_PLAN_BYTES))
    need(value["run_id"] == run_id)
    return send(value, output, forecast_token, outcome_token, **kwargs)


def main(argv=None):
    parser = forecast._SafeParser(description=__doc__)
    parser.add_argument("--snapshots"); parser.add_argument("--capture", action="append", default=[])
    parser.add_argument("--base-url", default=ORIGIN); parser.add_argument("--out-dir"); parser.add_argument("--resume")
    parser.add_argument("--attempts", type=int, default=3); parser.add_argument("--max-steps", type=int, default=16)
    parser.add_argument("--max-run-seconds", type=float, default=240)
    mode = parser.add_mutually_exclusive_group(); mode.add_argument("--send", action="store_true"); mode.add_argument("--prepare", action="store_true")
    args = parser.parse_args(argv)
    try:
        outcome.O._origin(args.base_url)
        if args.resume:
            need(args.send and args.out_dir and not args.snapshots and not args.capture)
            # Resume reuses exact immutable plans. No current raw/source reads.
            result = resume(args.out_dir, args.resume, os.environ.get("SELFLEARN_NFL_INGEST_TOKEN"),
                os.environ.get("SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"), attempts=args.attempts,
                max_steps=args.max_steps, max_run_seconds=args.max_run_seconds)
        else:
            need(args.snapshots is not None and args.capture)
            value = plan(args.snapshots, args.capture, args.base_url)
            if not args.send and not args.prepare:
                result = summary(value, "dry_run", False, forecast_complete=False, network_used=False, writes=False,
                    forecast_counts=forecast_plan_valid(value["forecast_plan"])[0],
                    application_ids=[c["request"]["application_id"] for c in value["capture_plans"]])
            else:
                need(args.out_dir is not None); paths(value, args.out_dir)
                result = send(value, args.out_dir, os.environ.get("SELFLEARN_NFL_INGEST_TOKEN"),
                    os.environ.get("SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"), attempts=args.attempts,
                    max_steps=args.max_steps, max_run_seconds=args.max_run_seconds) if args.send else prepare(value, args.out_dir)
        print(forecast.encoded(result).decode("ascii"))
        return 3 if result["status"] == "terminal_incomplete" else 1 if result["status"].startswith("pending_") else 0
    except Exception:
        print(forecast.encoded({"version": 1, "status": "pending", "scope": "intake_only", **FLAGS,
            "reason": "intake_refused"}).decode("ascii"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
