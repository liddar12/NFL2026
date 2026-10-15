#!/usr/bin/env python3
"""Explicit, retry-safe transport of immutable NFL learning inputs (not activation).

Dry-run is the default and performs no writes, credential reads, or network I/O.
The source journal remains the authority; the output directory holds immutable
delivery requests and server acknowledgements, never generated sports data.
"""
import argparse
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_JSON_DEPTH = 24
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
REASON = re.compile(r"[a-z][a-z0-9_]{0,99}\Z")
MANIFEST_KEYS = ("version", "season", "week", "pool_generated_utc", "source_snapshots",
                 "offered_cards", "selection_policy_version", "joint_model_version")
OBJECT_ROUTE = "/api/v1/nfl/objects"
GENERATION_ROUTE = "/api/v1/nfl/generations"


class ExportError(ValueError):
    """A safe machine code: no response body, token, or untrusted URL is exposed."""


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def fingerprint(value):
    return "sha256:" + hashlib.sha256(encoded(value)).hexdigest()


def _same_json(left, right):
    # Python equality conflates true/1 and 1.0/1; content IDs do not.
    try:
        return encoded(left) == encoded(right)
    except (TypeError, ValueError, RecursionError):
        return False


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExportError("duplicate_json_key")
        result[key] = value
    return result


def _json(raw):
    def finite_number(value):
        number = float(value)
        if not math.isfinite(number):
            raise ExportError("nonfinite_json")
        return number

    try:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
        # Refuse extreme nesting before calling the decoder: its recursion
        # limits differ between Python 3.9 and 3.12. Quoted brackets are data.
        depth, quoted, escaped = 0, False, False
        for character in text:
            if quoted:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    quoted = False
            elif character == '"':
                quoted = True
            elif character in "[{":
                depth += 1
                if depth > MAX_JSON_DEPTH + 1:
                    raise ExportError("invalid_json")
            elif character in "]}":
                depth -= 1
        value = json.loads(text, object_pairs_hook=_pairs, parse_float=finite_number,
                           parse_constant=lambda _: (_ for _ in ()).throw(ExportError("nonfinite_json")))
        pending = [(value, 0)]
        while pending:
            node, depth = pending.pop()
            if depth > MAX_JSON_DEPTH:
                raise ExportError("invalid_json")
            if isinstance(node, dict):
                pending.extend((child, depth + 1) for child in node.values())
            elif isinstance(node, list):
                pending.extend((child, depth + 1) for child in node)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ExportError("invalid_json") from None


def _read(path):
    try:
        return _json(path.read_bytes())
    except OSError:
        raise ExportError("missing_or_unreadable_object") from None


def _hash(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ExportError("invalid_object_id")
    return value


def _request(kind, object_id, payload):
    request = {"version": 1, "kind": kind, "object_id": object_id, "payload": payload}
    if len(encoded(request)) > MAX_BODY_BYTES:
        raise ExportError("object_body_exceeds_3_mib")
    return request


def plan(snapshot_dir):
    """Read and fully validate the local object graph; no state or credentials.

This verifies content and reference integrity, not forecast semantic eligibility
or proof of public availability. The receiving adapter independently validates
each receipt. Orphan source files are not uploaded.
"""
    snapshots = Path(snapshot_dir).resolve()
    if not snapshots.is_dir():
        raise ExportError("missing_snapshot_directory")
    journal_dir = snapshots / "learning_journal"
    sources, generations = {}, []
    for path in sorted(journal_dir.rglob("*.json")):
        if path.is_symlink() or not path.resolve().is_relative_to(journal_dir):
            raise ExportError("journal_path_outside_snapshot_root")
        doc = _read(path)
        if (not isinstance(doc, dict) or type(doc.get("version")) is not int or doc["version"] != 1
                or not isinstance(doc.get("generations"), list) or len(doc["generations"]) != 1
                or not isinstance(doc.get("receipts"), list)):
            raise ExportError("invalid_generation_envelope")
        envelope_id = _hash(doc.get("envelope_id"))
        if fingerprint({k: v for k, v in doc.items() if k != "envelope_id"}) != envelope_id:
            raise ExportError("envelope_hash_mismatch")
        generation = doc["generations"][0]
        if not isinstance(generation, dict) or any(k not in generation for k in MANIFEST_KEYS):
            raise ExportError("invalid_generation_manifest")
        manifest = {k: generation[k] for k in MANIFEST_KEYS}
        gid = _hash(generation.get("generation_id"))
        if fingerprint(manifest) != gid or path.stem != gid.split(":")[1]:
            raise ExportError("generation_hash_or_filename_mismatch")
        season, week = doc.get("season"), doc.get("week")
        if (type(season) is not int or type(week) is not int or not 1 <= week <= 18
                or generation.get("season") != season or generation.get("week") != week
                or path.parent.name != "%d_wk%02d" % (season, week)):
            raise ExportError("generation_period_mismatch")
        references = generation.get("source_snapshots")
        if not isinstance(references, dict) or set(references) != {"leg_pool", "schedule", "parlay_calibration"}:
            raise ExportError("invalid_source_references")
        for digest in references.values():
            _hash(digest)
            source_path = snapshots / "learning_sources" / (digest.split(":")[1] + ".json")
            if source_path.is_symlink() or not source_path.resolve().is_relative_to(snapshots / "learning_sources"):
                raise ExportError("source_path_outside_snapshot_root")
            payload = _read(source_path)
            if fingerprint(payload) != digest:
                raise ExportError("source_hash_mismatch")
            sources[digest] = _request("source_snapshot", digest, payload)
        expected = generation.get("receipt_ids")
        if not isinstance(expected, list) or any(not isinstance(r, str) or not HASH.fullmatch(r) for r in expected):
            raise ExportError("invalid_receipt_references")
        rows = []
        for row in doc["receipts"]:
            if (not isinstance(row, dict) or not isinstance(row.get("learning_receipt"), dict)
                    or row.get("generation_id") != gid
                    or row.get("receipt_id") != row["learning_receipt"].get("receipt_id")):
                raise ExportError("invalid_receipt_references")
            rows.append(_hash(row.get("receipt_id")))
        if len(set(expected)) != len(expected) or len(set(rows)) != len(rows) or set(rows) != set(expected):
            raise ExportError("invalid_receipt_references")
        generations.append({"request": _request("generation", envelope_id, doc),
                            "expected_receipt_ids": sorted(expected)})
    return {"version": 1, "snapshot_dir": str(snapshots),
            "source_objects": [sources[k] for k in sorted(sources)], "generations": generations}


def base_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or any(c.isspace() for c in value)):
            raise ValueError()
        port = parsed.port
        host = parsed.hostname.lower()
        if ":" in host:
            # Zone identifiers and malformed literals must not reach a request
            # constructor where exception diagnostics could echo user input.
            if "%" in host:
                raise ValueError()
            host = "[" + str(ipaddress.IPv6Address(host)) + "]"
        else:
            host = host.encode("idna").decode("ascii")
            if (len(host) > 253 or host.endswith("..") or not re.fullmatch(r"[a-z0-9.-]+", host)
                    or any(not label or len(label) > 63 or label.startswith("-")
                           or label.endswith("-") for label in host.rstrip(".").split("."))):
                raise ValueError()
        if port == 0:
            raise ValueError()
        return "https://" + host + ((":" + str(port)) if port not in (None, 443) else "")
    except (ValueError, TypeError, AttributeError, UnicodeError):
        raise ExportError("invalid_https_base_url") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ExportError("redirect_rejected")


def http_transport(destination, token, timeout=20):
    """Return (path, bytes) -> (HTTP status, response bytes); redirects never follow."""
    opener = urllib.request.build_opener(_NoRedirect())

    def post(path, body):
        request = urllib.request.Request(destination + path, data=body, method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                     "Accept": "application/json"})
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_BODY_BYTES + 1)
                if len(raw) > MAX_BODY_BYTES:
                    raise ExportError("ack_body_too_large")
                return response.status, raw
        except urllib.error.HTTPError as error:
            # Never echo a remote error body/header (which may contain secrets).
            error.close()
            return error.code, b""
    return post


def _post(transport, route, request, attempts, sleep):
    body = encoded(request)
    for attempt in range(attempts):
        try:
            status, raw = transport(route, body)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt + 1 == attempts:
                raise ExportError("transport_retry_exhausted") from None
        else:
            if type(status) is not int:
                raise ExportError("invalid_http_status")
            if 200 <= status < 300:
                if not isinstance(raw, bytes) or len(raw) > MAX_BODY_BYTES:
                    raise ExportError("invalid_ack_body")
                return _json(raw)
            if 300 <= status < 400:
                raise ExportError("redirect_rejected")
            if status != 429 and not 500 <= status < 600:
                raise ExportError("http_%d" % status)
            if attempt + 1 == attempts:
                raise ExportError("http_%d_retry_exhausted" % status)
        sleep(min(0.5 * (2 ** attempt), 2))
    raise ExportError("invalid_retry_configuration")


def _validate_ack(ack, operation, expected):
    if (not isinstance(ack, dict) or type(ack.get("version")) is not int or ack["version"] != 1
            or ack.get("object_id") != operation["object_id"] or ack.get("durable") is not True):
        raise ExportError("invalid_durable_ack")
    if operation["phase"] == "object":
        if ack.get("status") not in ("recorded", "duplicate"):
            raise ExportError("invalid_object_ack_status")
        return
    receipts, rejections = ack.get("receipts"), ack.get("rejections")
    if not isinstance(receipts, list) or not isinstance(rejections, list):
        raise ExportError("invalid_generation_ack")
    seen = set()
    for row in receipts + rejections:
        if not isinstance(row, dict):
            raise ExportError("invalid_generation_ack")
        rid = row.get("source_receipt_id")
        if rid not in expected or rid in seen:
            raise ExportError("unknown_or_duplicate_receipt_ack")
        seen.add(rid)
    mapped = set()
    for row in receipts:
        generic_id = _hash(row.get("receipt_id"))
        if generic_id in mapped:
            raise ExportError("duplicate_generic_receipt_ack")
        mapped.add(generic_id)
        if row.get("status") not in ("recorded", "duplicate"):
            raise ExportError("invalid_receipt_ack_status")
    for row in rejections:
        if not isinstance(row.get("reason"), str) or not REASON.fullmatch(row["reason"]):
            raise ExportError("invalid_rejection_reason")
    if seen != set(expected):
        raise ExportError("missing_receipt_ack")


def _delivery_path(root, *parts):
    """Keep delivery files inside their explicit root, never through symlinks.

The operator must own the delivery directory; this is not a multi-user sandbox.
Checking every component also prevents a stale symlink from redirecting writes
into generated sports data after the initial output-root check.
"""
    path = root.joinpath(*parts)
    for component in (path, *path.parents):
        if component == root:
            break
        if component.is_symlink():
            raise ExportError("delivery_symlink_rejected")
    try:
        inside = path.resolve().is_relative_to(root)
    except (OSError, RuntimeError):
        raise ExportError("invalid_delivery_path") from None
    if not inside:
        raise ExportError("delivery_path_outside_output_root")
    return path


def _immutable(path, value, *, root=None):
    """Exclusive atomic publication, fsync file and directory; never overwrite."""
    if root is not None:
        _delivery_path(root, *path.relative_to(root).parts)
    content = encoded(value) + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if root is not None:
        _delivery_path(root, *path.relative_to(root).parts)
    if path.exists():
        if not _same_json(_read(path), value):
            raise ExportError("immutable_delivery_conflict")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".delivery-", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        try:
            os.link(temporary, path)
        except FileExistsError:
            if not _same_json(_read(path), value):
                raise ExportError("immutable_delivery_conflict")
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink()


def _safe_ack(ack, phase):
    """Retain protocol fields only; never persist arbitrary server diagnostics."""
    value = {k: ack[k] for k in ("version", "object_id", "durable")}
    if phase == "object":
        value["status"] = ack["status"]
    else:
        value["receipts"] = [{k: row[k] for k in ("source_receipt_id", "receipt_id", "status")}
                             for row in ack["receipts"]]
        value["rejections"] = [{k: row[k] for k in ("source_receipt_id", "reason")}
                               for row in ack["rejections"]]
    return value


def send(export_plan, destination, out_dir, token, *, transport=None, attempts=3, sleep=time.sleep):
    """Deliver a validated plan. Only explicit callers invoke this write/network API.

The injectable transport takes (route, body_bytes), returns (status, bytes).
An ACK is cached only after exact ID/partition checks. Interrupted delivery may
repeat a POST, whose stable content ID lets the server return a duplicate ACK.
"""
    destination = base_url(destination)
    if (not isinstance(token, str) or not token.strip() or len(token) > 8192
            or any(not 0x21 <= ord(c) <= 0x7e for c in token)):
        raise ExportError("missing_or_invalid_ingest_token")
    if type(attempts) is not int or not 1 <= attempts <= 5:
        raise ExportError("invalid_retry_configuration")
    output = Path(out_dir).resolve()
    snapshots = Path(export_plan["snapshot_dir"]).resolve()
    sports_data = Path(__file__).resolve().parent.parent / "data"
    if output.is_relative_to(sports_data) or output.is_relative_to(snapshots) or snapshots.is_relative_to(output):
        raise ExportError("delivery_directory_overlaps_sports_data")
    # Re-read the authority before sending: a caller must not mutate a plan or
    # swap a snapshot after dry-run and bypass hash validation.
    validated_plan = plan(snapshots)
    if not _same_json(export_plan, validated_plan):
        raise ExportError("plan_changed_since_validation")
    transport = transport or http_transport(destination, token)
    destination_id = fingerprint({"base_url": destination})
    target = _delivery_path(output, destination_id.split(":")[1])
    # Validate pre-existing subdirectories before creating any delivery file.
    for directory in ("outbox", "acks", "failures"):
        _delivery_path(output, target.name, directory)
    def operation_for(request, phase):
        operation = {"version": 1, "destination_id": destination_id, "phase": phase,
                     "object_id": request["object_id"]}
        if phase == "object":
            operation["kind"] = request["kind"]
        return operation

    pending = [(request, "object") for request in export_plan["source_objects"]]
    for entry in export_plan["generations"]:
        pending.append((entry["request"], "object"))
        pending.append(({"version": 1, "object_id": entry["request"]["object_id"]}, "generation"))
    for request, phase in pending:
        name = fingerprint(operation_for(request, phase)).split(":")[1] + ".json"
        for directory in ("outbox", "acks"):
            _delivery_path(output, target.name, directory, name)
    failures, acknowledged = [], set()
    summary = {"version": 1, "ok": True, "objects_acked": 0, "generations_acked": 0,
               "receipts_acked": 0, "receipts_rejected": 0, "cached_acks": 0, "failures": failures}

    def deliver(request, phase, expected=()):
        operation = operation_for(request, phase)
        operation_id = fingerprint(operation).split(":")[1]
        ack_path = _delivery_path(output, target.name, "acks", operation_id + ".json")
        try:
            conflict = {"operation": operation, "reason": "immutable_delivery_conflict"}
            conflict_path = _delivery_path(output, target.name, "failures",
                                          fingerprint(conflict).split(":")[1] + ".json")
            if conflict_path.exists():
                # A later replay must not turn a known contradictory durable
                # ACK into success merely because one side won the file race.
                raise ExportError("immutable_delivery_conflict")
            _immutable(_delivery_path(output, target.name, "outbox", operation_id + ".json"),
                       {"operation": operation, "request": request}, root=output)
            if ack_path.exists():
                stored = _read(ack_path)
                if not isinstance(stored, dict) or not _same_json(stored.get("operation"), operation):
                    raise ExportError("immutable_delivery_conflict")
                ack = stored.get("ack")
                _validate_ack(ack, operation, expected)
                summary["cached_acks"] += 1
            else:
                route = OBJECT_ROUTE if phase == "object" else GENERATION_ROUTE
                ack = _post(transport, route, request, attempts, sleep)
                _validate_ack(ack, operation, expected)
                ack = _safe_ack(ack, phase)
                # First valid durable response wins, even if concurrent requests
                # differ only in recorded/duplicate. Conflicting receipts fail.
                try:
                    _immutable(ack_path, {"operation": operation, "ack": ack}, root=output)
                except ExportError as error:
                    if str(error) != "immutable_delivery_conflict":
                        raise
                    stored = _read(ack_path)
                    if not isinstance(stored, dict) or not _same_json(stored.get("operation"), operation):
                        raise
                    _validate_ack(stored.get("ack"), operation, expected)
                    a, b = json.loads(encoded(ack)), json.loads(encoded(stored["ack"]))
                    for value in (a, b):
                        value.pop("status", None)
                        for row in value.get("receipts", []):
                            row.pop("status", None)
                        if "receipts" in value:
                            value["receipts"].sort(key=lambda row: row["source_receipt_id"])
                            value["rejections"].sort(key=lambda row: row["source_receipt_id"])
                    if not _same_json(a, b):
                        raise ExportError("immutable_delivery_conflict")
                    ack = stored["ack"]
            return ack
        except ExportError as error:
            failure = {"operation": operation, "reason": str(error)}
            # All errors above are local machine codes, not untrusted bodies.
            _immutable(_delivery_path(output, target.name, "failures",
                                      fingerprint(failure).split(":")[1] + ".json"), failure, root=output)
            failures.append({"object_id": request["object_id"], "phase": phase, "reason": str(error)})
            return None

    for request in export_plan["source_objects"]:
        if deliver(request, "object") is not None:
            acknowledged.add(request["object_id"])
            summary["objects_acked"] += 1
    for entry in export_plan["generations"]:
        request = entry["request"]
        dependencies = request["payload"]["generations"][0]["source_snapshots"].values()
        if not all(digest in acknowledged for digest in dependencies):
            failures.append({"object_id": request["object_id"], "phase": "generation",
                             "reason": "source_object_not_acked"})
            continue
        if deliver(request, "object") is None:
            continue
        summary["objects_acked"] += 1
        ack = deliver({"version": 1, "object_id": request["object_id"]}, "generation",
                      entry["expected_receipt_ids"])
        if ack is not None:
            summary["generations_acked"] += 1
            summary["receipts_acked"] += len(ack["receipts"])
            summary["receipts_rejected"] += len(ack["rejections"])
    summary["ok"] = not failures and summary["receipts_rejected"] == 0
    return summary


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally repeats arbitrary unknown CLI arguments, including
        # an accidentally supplied token. Never echo them.
        self.exit(2, '{"version":1,"ok":false,"reason":"invalid_cli_arguments"}\n')


def main(argv=None):
    parser = _SafeParser(description=__doc__)
    parser.add_argument("--snapshots", default=str(Path(__file__).resolve().parent.parent / "data/snapshots"))
    parser.add_argument("--send", action="store_true", help="explicitly permit delivery and local ACK writes")
    parser.add_argument("--base-url", help="HTTPS API origin; credentials must never be in this URL")
    parser.add_argument("--out-dir", help="explicit durable delivery directory outside generated sports data")
    args = parser.parse_args(argv)
    try:
        export_plan = plan(args.snapshots)
        if not args.send:
            print(json.dumps({"version": 1, "mode": "dry_run", "source_objects": len(export_plan["source_objects"]),
                "generations": len(export_plan["generations"]), "receipt_copies": sum(
                    len(row["expected_receipt_ids"]) for row in export_plan["generations"]),
                "network_used": False, "writes": False}))
            return 0
        if not args.base_url or not args.out_dir:
            raise ExportError("send_requires_base_url_and_out_dir")
        result = send(export_plan, args.base_url, args.out_dir, os.environ.get("SELFLEARN_NFL_INGEST_TOKEN"))
        print(json.dumps(result, sort_keys=True))
        return 0 if result["ok"] else 1
    except (ExportError, OSError) as error:
        reason = str(error) if isinstance(error, ExportError) else "local_io_failure"
        print(json.dumps({"version": 1, "ok": False, "reason": reason}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
