#!/usr/bin/env python3
"""DEFAULT OFF local engine-parity diagnostic; never updates review/data/history.

Supply a FULL pinned observed-snapshot wrapper and trusted local engine checkout.
Only the engine tool invokes the independent NFL oracle. This wrapper performs
no network calls, writes, refits, discovery, credential reads or live activation.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.learning_receipts import fingerprint  # noqa: E402
from scripts.export_outcome_capture import ORIGIN, PRODUCER  # noqa: E402

MAX_INPUT, MAX_OUTPUT, TIMEOUT = 128 * 1024 * 1024, 1024 * 1024, 75
NAMESPACE = {"destination_id": fingerprint({"base_url": ORIGIN}), "producer_id": PRODUCER}
PROJECTION_KEYS = ("version", "watermark", "receipts", "generation_records", "revisions")
STATUSES = {"supported_pinned_cohort_parity", "partial_pinned_cohort_parity", "unsupported_local_content_pin",
            "unsupported_population", "mismatch_or_unavailable"}


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("nonfinite_json")


def _json(raw):
    return json.loads(raw, object_pairs_hook=_unique, parse_constant=_constant)


def _run(path, bundle, expected_input_id, now_utc):
    process = subprocess.Popen([sys.executable, str(path), "--bundle", str(bundle), "--expected-input-id", expected_input_id,
        "--nfl-checkout", str(ROOT), "--now-utc", now_utc], cwd=path.parent.parent,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={"PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"})
    deadline, result = time.monotonic() + TIMEOUT, bytearray()
    try:
        with selectors.DefaultSelector() as selected:
            os.set_blocking(process.stdout.fileno(), False)
            selected.register(process.stdout, selectors.EVENT_READ)
            while selected.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("engine_review_parity_deadline_exceeded")
                for key, _ in selected.select(min(remaining, 1)):
                    chunk = os.read(key.fd, min(65536, MAX_OUTPUT - len(result) + 1))
                    if not chunk:
                        selected.unregister(process.stdout)
                    result.extend(chunk)
                    if len(result) > MAX_OUTPUT:
                        raise ValueError("engine_review_parity_output_exceeds_byte_limit")
            code = process.wait(timeout=max(.01, deadline - time.monotonic()))
        if code not in (0, 3):
            raise ValueError("engine_review_parity_refused_input")
        return code, _json(result)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise ValueError("local_engine_review_parity_failed") from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def check(bundle_path, *, engine_checkout, expected_input_id, now_utc):
    """Check one local content pin; return diagnostics, never attach/write them."""
    path = Path(bundle_path).resolve()
    if not path.is_file():
        raise ValueError("missing_local_review_parity_bundle")
    with path.open("rb") as stream:
        raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("review_parity_input_exceeds_byte_limit")
    value = _json(raw)
    if (type(value) is not dict or fingerprint(value) != expected_input_id or value.get("namespace") != NAMESPACE):
        raise ValueError("invalid_review_parity_pin_or_namespace")
    script = Path(engine_checkout).resolve() / "tools/nfl_review_parity.py"
    if not script.is_file():
        raise ValueError("missing_trusted_local_engine_review_tool")
    source_hash = "sha256:" + hashlib.sha256(script.read_bytes()).hexdigest()
    code, result = _run(script, path, expected_input_id, now_utc)
    if type(result) is not dict:
        raise ValueError("invalid_engine_review_parity_diagnostic")
    analysis = value["analysis"]; snapshot = analysis["snapshot"]
    projection = {k: snapshot[k] for k in PROJECTION_KEYS}
    if (type(result.get("version")) is not int or result["version"] != 1
            or result.get("kind") != "nfl.review_parity_diagnostic.v1"
            or result.get("diagnostic_id") != fingerprint({k: v for k, v in result.items() if k != "diagnostic_id"})
            or result.get("input_id") != expected_input_id or result.get("namespace") != NAMESPACE
            or result.get("full_snapshot_id") != fingerprint(snapshot)
            or result.get("projection_id") != fingerprint(projection)
            or result.get("comparator_input_id") != fingerprint({**analysis, "snapshot": projection})
            or result.get("as_of_utc") != analysis["as_of_utc"] or result.get("snapshot_exported_utc") != value["snapshot_exported_utc"]
            or result.get("snapshot_watermark") != snapshot["watermark"] or result.get("population") != analysis["population"]
            or result.get("source_code_sha256", {}).get("tools/nfl_review_parity.py") != source_hash
            or "sha256:" + hashlib.sha256(script.read_bytes()).hexdigest() != source_hash
            or result.get("status") not in STATUSES or type(result.get("parity")) is not bool
            or (code == 0) != result["parity"] or result.get("namespace_authenticated") is not False
            or result.get("completeness_authenticated") is not False or result.get("model_adoption") is not False
            or result.get("live_review_replaced") is not False or result.get("source_authentication") != "not_performed"):
        raise ValueError("invalid_engine_review_parity_diagnostic")
    coverage = result.get("coverage")
    if (type(coverage) is not dict or any(type(coverage.get("supplied_" + name)) is not int
            or coverage["supplied_" + name] != len(snapshot[name]) for name in ("receipts", "revisions", "generation_records", "observations"))
            or any(type(coverage.get(name)) is not int or coverage[name] < 0 for name in ("first_eligible_forecasts", "graded_contracts"))
            or coverage["graded_contracts"] > coverage["first_eligible_forecasts"]):
        raise ValueError("invalid_engine_review_parity_coverage")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--engine-checkout", type=Path)
    parser.add_argument("--expected-input-id")
    parser.add_argument("--now-utc")
    args = parser.parse_args(argv)
    if args.bundle is None and args.engine_checkout is None and args.expected_input_id is None and args.now_utc is None:
        print('{"version":1,"status":"disabled","parity":false}')
        return 0
    try:
        if args.bundle is None or args.engine_checkout is None or args.expected_input_id is None:
            raise ValueError("explicit_local_review_inputs_required")
        result = check(args.bundle, engine_checkout=args.engine_checkout, expected_input_id=args.expected_input_id,
                       now_utc=args.now_utc or datetime.now(timezone.utc).isoformat())
        print(json.dumps(result, sort_keys=True, ensure_ascii=True, allow_nan=False))
        return 0 if result["parity"] else 3
    except (ValueError, TypeError, KeyError, OSError, OverflowError, AttributeError, RecursionError):
        print('{"version":1,"status":"invalid_or_unavailable_review_input","parity":false}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
