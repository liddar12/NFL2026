#!/usr/bin/env python3
"""Prepare immutable NFL forecasts, then explicitly deliver the frozen capture.

Default: preview only, without credential reads, writes or HTTP. --prepare saves
one generation outside the checkout; --send delivers that saved generation and
never reconstructs it from today's data. Reuse the workspace after interruptions.
This is eligible-pool capture, not proof of publication or permission to fit/apply
a correction. No outcome, evaluation, model, served document or config is changed.
"""
import fcntl
import json
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import export_learning as export, pilot_capture as capture
from scripts import learning_journal as journal

ORIGIN = "https://self-learning-beige.vercel.app"
REQUEST_TIMEOUT_SECONDS = 20
MAX_ATTEMPTS = 3
FLAGS = {"learning_enabled": False, "model_adoption": False,
         "working_learning_loop": False, "hosted_presence_reverified": False,
         "publication_verified": False, "remote_engine_commit_verified": False,
         "served_data_written": False}
SAFE_REASONS = frozenset({"delivery_workspace_required", "delivery_workspace_overlaps_inputs",
    "delivery_requires_single_generation", "delivery_generation_changed_use_new_workspace",
    "delivery_workspace_busy",
    "delivery_no_eligible_forecasts", "delivery_publication_claim_refused",
    "delivery_invalid_ingest_token", "delivery_invalid_attempts", "delivery_deadline_exceeded",
    "delivery_http_400", "delivery_http_401", "delivery_http_403", "delivery_http_409",
    "delivery_http_422", "delivery_incomplete_ack", "delivery_capture_refused"})


class DeliveryError(ValueError):
    """Static refusal; never include input paths, credentials or HTTP bodies."""


class DeliveryStopped(export.ExportAborted):
    """Stop the entire attempt without converting a global refusal to retries."""


def need(value, reason):
    if not value:
        raise DeliveryError(reason)


def _workspace(value):
    need(value is not None, "delivery_workspace_required")
    return capture.workspace_root(value)


def _generation(plan):
    need(len(plan["generations"]) == 1, "delivery_requires_single_generation")
    entry = plan["generations"][0]
    doc = entry["request"]["payload"]
    generation = doc["generations"][0]
    need(bool(entry["expected_receipt_ids"]), "delivery_no_eligible_forecasts")
    need(generation.get("publication_status") == "generated_unverified"
         and generation.get("population") == "eligible_pool_prop_rungs_before_display_dedupe"
         and all(row.get("publication_status") == "generated_unverified"
                 and row["learning_receipt"].get("publication_status") == "generated_unverified"
                 for row in doc["receipts"]), "delivery_publication_claim_refused")
    return entry, generation


def _result(status, **values):
    return {"version": 1, "kind": "nfl.forecast_delivery.v1", "status": status,
            "publication_status": "generated_unverified", "engine_commit": capture.ENGINE_COMMIT,
            "durable_ack_validated": False, **FLAGS, **values}


def _sync(root, path):
    checked = export._delivery_path(root, *path.relative_to(root).parts)
    journal._sync_published(str(checked), str(root))


def _sync_capture(root, plan, generation):
    snapshots = export._delivery_path(root, "snapshots")
    for request in plan["source_objects"]:
        _sync(root, snapshots / "learning_sources" / (request["object_id"][7:] + ".json"))
    _sync(root, Path(journal.generation_path(str(snapshots),
          {key: generation[key] for key in export.MANIFEST_KEYS})))


def intake_operation(request, phase):
    operation = {"version": 1, "destination_id": export.fingerprint({"base_url": ORIGIN}),
                 "phase": phase, "object_id": request["object_id"]}
    if phase == "object":
        operation["kind"] = request["kind"]
    return operation


def _intake_paths(root, request, phase):
    operation = intake_operation(request, phase)
    name = export.fingerprint(operation)[7:] + ".json"
    return tuple(export._delivery_path(root, "delivery", operation["destination_id"][7:], folder, name)
                 for folder in ("outbox", "acks"))


def prepare(input_dir, workspace=None, *, execute=False, clock=capture.now):
    """Capture with the actual call clock; trusted tests may inject a clock.

    Each workspace belongs to exactly one generation. Replays preserve its first
    clock even after kickoff. A new generation requires a new workspace, so an
    unrelated old ACK cannot make today's capture look delivered.
    """
    capture.disabled_config()
    source = Path(input_dir).resolve()
    root = _workspace(workspace) if execute else None
    if root is not None:
        need(not root.is_relative_to(source) and not source.is_relative_to(root),
             "delivery_workspace_overlaps_inputs")
    pool = capture.read_input(source / "leg_pool.json")
    schedule = capture.read_input(source / "schedule_full.json")
    calibration = capture.read_input(source / "parlay_backtest.json")
    recorded = clock()
    def preview():
        result = capture.capture_generation(pool, schedule, calibration, clock=lambda: recorded)
        status = "dry_run" if result["eligible_receipts"] else "no_eligible_forecasts"
        return _result(status, ok=bool(result["eligible_receipts"]), writes=False, network_used=False,
            capture=result, generation_id=result["generation_id"], envelope_id=result["envelope_id"],
            eligible_receipts=result["eligible_receipts"])

    if root is None:
        return preview()
    initial = None
    if not root.exists():
        initial = preview()
        if not initial["ok"]:
            return initial
        root.mkdir(parents=True, mode=0o700, exist_ok=True)

    # A single workspace can own only one generation. Lock the directory itself
    # so competing preparations cannot leave two distinct immutable envelopes.
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeliveryError("delivery_workspace_busy") from None
        snapshots = export._delivery_path(root, "snapshots")
        previous = export.plan(snapshots) if snapshots.exists() else None
        if previous and previous["generations"]:
            _, generation = _generation(previous)
            expected = export.fingerprint(journal._manifest(pool, schedule, calibration, [])[0])
            need(generation["generation_id"] == expected,
                 "delivery_generation_changed_use_new_workspace")
        elif initial is None:
            initial = preview()
            if not initial["ok"]:
                return initial
        result = capture.capture_generation(pool, schedule, calibration, workspace=root,
                                           execute=True, clock=lambda: recorded)
        plan = export.plan(snapshots)
        _, generation = _generation(plan)
        _sync_capture(root, plan, generation)
    finally:
        os.close(descriptor)
    return _result("prepared", ok=True, writes=True, network_used=False,
        generation_id=generation["generation_id"], envelope_id=result["envelope_id"],
        recorded_utc=generation["recorded_utc"], eligible_receipts=result["eligible_receipts"],
        capture=result)


def deliver(workspace, token, *, transport=None, attempts=MAX_ATTEMPTS,
            sleep=time.sleep, monotonic=time.monotonic):
    """Validate all ACK identities/partitions and preserve retryable local state.

    The deadline bounds cooperative request/retry work; socket timeout is 20s.
    A supervising process must enforce its own hard limit (DNS is not a hard
    socket wall-clock bound). Cached ACKs validate original delivery, not a fresh
    remote read. An injected transport enables offline engine acceptance tests.
    """
    capture.disabled_config()
    need(type(token) is str and 32 <= len(token) <= 8192
         and token != "[SENSITIVE]" and all(0x21 <= ord(c) <= 0x7e for c in token),
         "delivery_invalid_ingest_token")
    need(type(attempts) is int and 1 <= attempts <= MAX_ATTEMPTS, "delivery_invalid_attempts")
    root = _workspace(workspace)
    plan = export.plan(export._delivery_path(root, "snapshots"))
    entry, generation = _generation(plan)
    _sync_capture(root, plan, generation)
    # Also reject a symlinked delivery root before exporter resolves it.
    output = export._delivery_path(root, "delivery")
    operations = len(plan["source_objects"]) + 2
    budget = operations * (REQUEST_TIMEOUT_SECONDS * attempts + 4)
    deadline = monotonic() + budget
    post = transport if transport is not None else export.http_transport(
        ORIGIN, token, timeout=REQUEST_TIMEOUT_SECONDS)
    calls = 0

    def check_budget():
        if monotonic() >= deadline:
            raise DeliveryStopped("delivery_deadline_exceeded")

    def bounded_post(route, body):
        nonlocal calls
        check_budget()
        phase = "object" if route == export.OBJECT_ROUTE else "generation"
        outbox, _ = _intake_paths(root, export._json(body), phase)
        _sync(root, outbox)
        check_budget()
        calls += 1
        response = post(route, body)
        check_budget()
        if type(response[0]) is int and response[0] in (400, 401, 403, 409, 422):
            raise DeliveryStopped("delivery_http_%d" % response[0])
        return response

    def bounded_sleep(seconds):
        check_budget()
        if monotonic() + seconds >= deadline:
            raise DeliveryStopped("delivery_deadline_exceeded")
        sleep(seconds)
        check_budget()

    try:
        result = export.send(plan, ORIGIN, output, token, transport=bounded_post,
                             attempts=attempts, sleep=bounded_sleep)
    except DeliveryStopped as error:
        return _result("delivery_stopped", ok=False, reason=error.args[0], writes=True,
                       transport_calls=calls, network_used=transport is None and calls > 0,
                       generation_id=generation["generation_id"], envelope_id=entry["request"]["object_id"])
    complete = (result["ok"] is True
        and result["objects_acked"] == len(plan["source_objects"]) + 1
        and result["generations_acked"] == 1
        and result["receipts_acked"] == len(entry["expected_receipt_ids"])
        and result["receipts_rejected"] == 0)
    if result["generations_acked"] == 1:
        # A partial intake ACK is still the immutable authority for whichever
        # receipts were accepted by the engine.
        for request in [*plan["source_objects"], entry["request"]]:
            for path in _intake_paths(root, request, "object"):
                _sync(root, path)
        for path in _intake_paths(root, entry["request"], "generation"):
            _sync(root, path)
    return _result("delivered" if complete else "delivery_incomplete", ok=complete,
        writes=True, transport_calls=calls, network_used=transport is None and calls > 0,
        durable_ack_validated=complete, generation_id=generation["generation_id"],
        envelope_id=entry["request"]["object_id"], recorded_utc=generation["recorded_utc"],
        delivery=result)


def main(argv=None):
    parser = export._SafeParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--send", action="store_true")
    parser.add_argument("--input-dir", default=str(ROOT / "data"))
    parser.add_argument("--workspace")
    args = parser.parse_args(argv)
    token = None
    try:
        if args.send:
            token = os.environ.get("SELFLEARN_NFL_INGEST_TOKEN")
            result = deliver(args.workspace, token)
        else:
            result = prepare(args.input_dir, args.workspace, execute=args.prepare)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0 if result["ok"] else 1
    except Exception as error:
        reason = error.args[0] if type(error) is DeliveryError and error.args else None
        if reason not in SAFE_REASONS:
            reason = export._safe_error(error, (token,)) if type(error) is export.ExportError else "delivery_capture_refused"
        print(json.dumps(_result("refused", ok=False, reason=reason), sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
