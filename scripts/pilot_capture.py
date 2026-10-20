#!/usr/bin/env python3
"""Offline, default-off capture of MY eligible-prop forecasts for the lean pilot.

The command owns the capture clock; there is deliberately no --as-of option.
It never calls a provider, writes served data, or claims public publication.
Existing immutable captures retain their original clocks on replay. A library
caller may inject a trusted clock for tests, not obtain historical authenticity.
The default cohort is eligible pool props, NOT published WEEK/GAME cards, browser
filter builds, or placed sportsbook tickets. Exact offered records can be passed
by a future producer integration; that integration is not part of checkpoint 2.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import export_learning as export, learning_journal as journal, learning_receipts as lr
from scripts import pilot_config

ENGINE_COMMIT = "aacb19c73122f257449e977df40f2a2733991b2f"
MAX_INPUT_BYTES = 16 * 1024 * 1024


class PilotCaptureError(ValueError):
    pass


def need(value, reason):
    if not value:
        raise PilotCaptureError(reason)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def disabled_config():
    config = pilot_config.read_config(ROOT / "config/selflearning_pilot.json")
    need(config["enabled"] is False and config["serving_mode"] == "shadow"
         and config["engine_commit"] == ENGINE_COMMIT, "pilot_disabled_pin_required")


def workspace_root(value):
    need(value is not None, "pilot_explicit_workspace_required")
    path = Path(value).absolute()
    need(not path.is_symlink(), "pilot_workspace_symlink")
    path = path.resolve()
    need(path != Path(path.anchor) and not path.is_relative_to(ROOT)
         and not ROOT.is_relative_to(path), "pilot_workspace_overlaps_checkout")
    return path


def read_input(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        need(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "pilot_input_not_regular")
        raw = stream.read(MAX_INPUT_BYTES + 1)
    need(len(raw) <= MAX_INPUT_BYTES, "pilot_input_too_large")
    return export._json(raw)


def capture_generation(pool, schedule, calibration, *, workspace=None, execute=False,
                       offered_records=(), clock=now):
    """Persist only in an explicitly selected local shadow workspace.

    Clock injection is a trusted testing seam, not proof of historical capture.
    Invalid receipts are quarantined by the existing journal, never repaired.
    An offered card referencing a refused prop is itself refused, not truncated.
    """
    disabled_config()
    recorded = clock()
    when = lr.instant(recorded)
    need(when is not None, "pilot_capture_clock_invalid")
    need(type(pool) is dict and type(schedule) is dict, "pilot_input_malformed")
    generated = lr.instant(pool.get("generated_utc"))
    # A future/missing generation time is an invalid envelope, not merely an
    # invalid receipt. Persisting an empty one would poison the full graph for
    # the engine, which independently requires generation <= recording time.
    need(generated is not None and generated <= when, "pilot_generation_clock_invalid")
    need(type(offered_records) in (list, tuple), "pilot_offered_records_malformed")
    records = list(offered_records)
    need(all(type(row) is dict and type(row.get("card_id")) is str
             and type(row.get("legs")) is list for row in records), "pilot_offered_records_malformed")
    def validate_offered(doc):
        accepted = set(doc["generations"][0]["receipt_ids"])
        need(all(set(row["receipt_ids"]) <= accepted for row in doc["generations"][0]["offered_cards"]),
             "pilot_offered_card_has_refused_receipt")

    doc = None
    added = False
    if execute:
        root = workspace_root(workspace)
        snapshots = export._delivery_path(root, "snapshots")
        # Validate existing graph and paths before any journal writer can touch
        # it. No symlink inside an otherwise private workspace may redirect it.
        if snapshots.exists():
            export.plan(snapshots)
        for folder in ("learning_journal", "learning_sources"):
            export._delivery_path(root, "snapshots", folder)
        path = Path(journal.generation_path(str(snapshots), journal._manifest(
            pool, schedule, calibration, records)[0]))
        export._delivery_path(root, *path.relative_to(root).parts)
        if path.exists():
            # Validate the frozen original before applying today's eligibility.
            # journal.record's existing-file branch verifies hashes and sources
            # without writing or refreshing its historical capture clock.
            doc, added = journal.record(pool, schedule, calibration, records, recorded, str(snapshots))
    if doc is None:
        doc, _ = journal.capture(pool, schedule, calibration, records, recorded)
        validate_offered(doc)
        if execute:
            doc, added = journal.record(pool, schedule, calibration, records, recorded, str(snapshots))
    validate_offered(doc)
    if execute:
        export.plan(snapshots)
    generation = doc["generations"][0]
    return {"version": 1, "kind": "nfl.lean_pilot_capture.v1",
        "status": "local_shadow_capture" if execute else "dry_run_no_writes",
        "generation_id": generation["generation_id"], "envelope_id": doc["envelope_id"],
        "recorded_utc": generation["recorded_utc"], "checked_utc": recorded,
        "added_generation": added, "eligible_receipts": len(doc["receipts"]),
        "offered_cards": len(generation["offered_cards"]), "audit": generation["audit"],
        "population": generation["population"], "publication_status": "generated_unverified",
        "scope": "MY_supported_prop_receipts_not_browser_WEEK_GAME_or_tickets",
        "engine_commit": ENGINE_COMMIT, "learning_enabled": False, "serving_mode": "shadow",
        "production_authorized": False, "network_used": False, "writes": bool(execute)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--input-dir", default=str(ROOT / "data"))
    parser.add_argument("--workspace")
    args = parser.parse_args(argv)
    try:
        source = Path(args.input_dir).resolve()
        if args.execute:
            output = workspace_root(args.workspace)
            need(not output.is_relative_to(source) and not source.is_relative_to(output),
                 "pilot_workspace_overlaps_inputs")
        result = capture_generation(read_input(source / "leg_pool.json"),
            read_input(source / "schedule_full.json"), read_input(source / "parlay_backtest.json"),
            workspace=args.workspace, execute=args.execute)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    except Exception as error:
        reason = error.args[0] if type(error) is PilotCaptureError else "pilot_capture_refused"
        print(json.dumps({"version": 1, "status": "refused", "reason": reason,
            "learning_enabled": False, "production_authorized": False, "network_used": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
