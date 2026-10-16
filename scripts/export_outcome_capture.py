"""Opt-in bounded outcome-capture sender; staging is never learning acceptance.

Default CLI: verified local plan only, with no environment/network/write access.
The initial approved API origin is a configuration restriction, not a claim that
the host, external intake, quota port or production learning is enabled. The
current receiver holds complete captures above500 members: never split them.
"""
import base64
import hashlib
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scripts import capture_outcome_evidence as capture, export_learning as ex  # noqa: E402

ORIGIN = "https://self-learning-beige.vercel.app"
PRODUCER = "nfl2026"
POLICY = "nfl.capture_labels_v1"
CHUNK_BYTES = 1024 * 1024
BODY_BYTES = 3 * CHUNK_BYTES
CHUNK_ROUTE = "/api/v1/nfl/capture-chunks"
DELIVERY_ROUTE = "/api/v1/nfl/capture-deliveries"
RESULT_KEYS = {"version", "kind", "delivery_id", "request_id", "capture_id", "membership_id", "status", "groups",
               "added_observations", "added_revisions", "input_watermark", "watermark", "delivery_seq", "recorded_utc",
               "durable", "scope", "source_authentication"}
GROUP_KEYS = {"group_id", "scope", "receipt_ids", "source_receipt_ids", "generation_object_ids", "membership_id",
              "status", "reason_codes", "observation_ids", "revision_ids"}
_FAILURES = frozenset("""outcome_http_refused outcome_http_retry_exhausted outcome_transport_retry_exhausted
outcome_transport_failed
outcome_redirect_rejected invalid_outcome_http_status invalid_outcome_response_bound invalid_outcome_response_json
invalid_outcome_route invalid_outcome_request_body
invalid_staging_ack invalid_outcome_delivery_wrapper invalid_original_delivery_result original_result_identity_mismatch
invalid_original_result_clock original_result_clock_mismatch invalid_result_ids noncanonical_result_ids
invalid_result_sequence invalid_result_groups invalid_result_group invalid_result_scope invalid_group_membership
invalid_result_group_status incomplete_result_group too_many_group_revisions duplicate_result_member
invalid_result_membership invalid_original_result_status invalid_original_result_counts invalid_original_result_watermark
invalid_outcome_digest outcome_request_exceeds_3_mib immutable_outcome_outbox_failure original_outcome_result_conflict""".split())


class OutcomeExportError(ValueError):
    """Static local machine code; never include credentials or upstream text."""


def _reason(error):
    # Injected callbacks can raise our class too; class identity is not redaction.
    value = error.args[0] if type(error) is OutcomeExportError and len(error.args) == 1 else None
    return value if type(value) is str and value in _FAILURES else "outcome_delivery_failed"


def _require(condition, reason):
    if not condition:
        raise OutcomeExportError(reason)


def _origin(value):
    try:
        result = ex.base_url(value)
    except ex.ExportError:
        raise OutcomeExportError("invalid_outcome_origin") from None
    _require(result == ORIGIN, "unapproved_outcome_origin")
    return result


def _hash(value):
    _require(type(value) is str and bool(ex.HASH.fullmatch(value)), "invalid_outcome_digest")
    return value


def _body(value):
    raw = ex.encoded(value)
    _require(len(raw) <= BODY_BYTES, "outcome_request_exceeds_3_mib")
    return raw


def _raw_hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _chunk(raw):
    return {"version": 1, "kind": "selflearn.evidence_chunk.v1", "scope": "uploaded_only",
            "chunk_id": _raw_hash(raw), "raw_bytes": len(raw), "encoding": "base64",
            "data": base64.b64encode(raw).decode("ascii")}


def _selected_path(value):
    # Inspect selected ancestors BEFORE resolve erases user-controlled symlinks.
    selected = Path(os.path.abspath(os.fspath(value)))
    for name in ("/var", "/tmp"):
        alias = Path(name)
        if selected.is_relative_to(alias) and alias.is_symlink() and str(alias.resolve()) == "/private" + name:
            selected = alias.resolve() / selected.relative_to(alias)
    _require(not any(path.is_symlink() for path in (selected, *selected.parents)), "outcome_path_symlink")
    return selected.resolve()


def _plan(capture_path, destination):
    destination = _origin(destination)
    selected = _selected_path(capture_path)
    try:
        bundle = capture.load_capture(selected)
    except (capture.CaptureError, OSError, ValueError, TypeError):
        raise OutcomeExportError("invalid_saved_outcome_capture") from None
    pointers, descriptors, chunks = [], [], set()
    total = 0
    for object_id, raw in sorted(bundle["raw_objects"].items()):
        refs = []
        for start in range(0, len(raw), CHUNK_BYTES):
            part = raw[start:start + CHUNK_BYTES]
            refs.append({"chunk_id": _raw_hash(part), "raw_bytes": len(part)})
            chunks.add(_raw_hash(part))
        pointers.append({"version": 1, "kind": "selflearn.evidence_object.v1", "scope": "uploaded_only",
                         "object_id": object_id, "raw_bytes": len(raw), "chunks": refs})
        descriptors.append({"raw_sha256": object_id, "raw_bytes": len(raw)})
        total += len(raw)
    _require(total <= capture.CAPTURE_LIMIT, "outcome_capture_exceeds_64_mib")
    envelope = {"version": 1, "kind": "nfl.capture_envelope.v1", "scope": "uploaded_only",
                "manifest": bundle["manifest"], "observations": bundle["observations"], "raw_objects": descriptors}
    destination_id = ex.fingerprint({"base_url": destination})
    identity = {"version": 1, "kind": "nfl.capture_delivery.v1", "destination_id": destination_id,
                "producer_id": PRODUCER, "capture_id": bundle["manifest"]["capture_id"], "binding_policy": POLICY}
    request = {**identity, "kind": "nfl.capture_delivery_request.v1", "envelope": envelope,
               "raw_pointers": pointers, "delivery_id": ex.fingerprint(identity)}
    _body(request)
    value = {"version": 1, "capture_path": str(selected), "destination": destination, "request": request,
             "raw_bytes": total, "unique_chunks": len(chunks), "whole_capture_member_limit": 500,
             "membership_capacity": "receiver_owned_unknown_until_complete_binding", "fragmentation_allowed": False}
    return {**value, "plan_id": ex.fingerprint(value)}, bundle


def plan(capture_path, destination):
    """Verify the exact saved capture, without refetch/restamping or credentials."""
    return _plan(capture_path, destination)[0]


def _validated(value):
    _require(type(value) is dict, "invalid_outcome_plan")
    try:
        fresh, bundle = _plan(value["capture_path"], value["destination"])
        _require(ex._same_json(value, fresh), "outcome_plan_changed")
    except (KeyError, TypeError):
        raise OutcomeExportError("invalid_outcome_plan") from None
    return fresh, bundle


def _output(value, out_dir):
    output = _selected_path(out_dir)
    authority = Path(value["capture_path"]).parent.parent
    sports = _ROOT / "data"
    _require(not any(output.is_relative_to(root) or root.is_relative_to(output) for root in (authority, sports))
             and output != _ROOT, "outcome_outbox_overlaps_authority")
    target = output / value["request"]["destination_id"][7:] / value["request"]["delivery_id"][7:]
    for folder in ("outbox", "staging", "results", "failures"):
        ex._delivery_path(output, *target.relative_to(output).parts, folder)
    return output, target


def _write(root, path, value):
    try:
        ex._immutable(path, value, root=root)
    except (ex.ExportError, OSError, RuntimeError, ValueError):
        raise OutcomeExportError("immutable_outcome_outbox_failure") from None


def prepare(value, out_dir):
    """Explicit local immutable intent publication, no network or token reads."""
    value, _ = _validated(value)
    root, target = _output(value, out_dir)
    _write(root, target / "outbox" / "delivery.json", {"version": 1, "request": value["request"]})
    return {"version": 1, "prepared": True, "delivery_id": value["request"]["delivery_id"],
            "network_used": False, "learning_ack": False}


def _ids(value, *, hashes=True, nonempty=False):
    _require(type(value) is list and len(value) <= 500 and (value or not nonempty)
             and all(type(item) is str and 0 < len(item) <= 200 for item in value), "invalid_result_ids")
    _require(value == sorted(set(value)), "noncanonical_result_ids")
    if hashes:
        for item in value:
            _hash(item)


def _sequence(value, *, positive=False):
    _require(type(value) is str and bool(re.fullmatch(r"(?:0|[1-9][0-9]{0,18})", value))
             and (not positive or value != "0"), "invalid_result_sequence")
    return int(value)


def _result(value, request):
    _require(type(value) is dict and set(value) == RESULT_KEYS and type(value["version"]) is int and value["version"] == 1
             and value["kind"] == "nfl.capture_delivery_result.v1" and value["durable"] is True
             and value["scope"] == "observations_and_group_results" and value["source_authentication"] == "not_performed",
             "invalid_original_delivery_result")
    for key in ("delivery_id", "request_id", "capture_id", "membership_id"):
        _hash(value[key])
    _require(value["delivery_id"] == request["delivery_id"] and value["request_id"] == ex.fingerprint(request)
             and value["capture_id"] == request["capture_id"], "original_result_identity_mismatch")
    try:
        _require(capture._instant(value["recorded_utc"]) >= capture._instant(request["envelope"]["manifest"]["completed_utc"]),
                 "original_result_clock_mismatch")
    except capture.CaptureError:
        raise OutcomeExportError("invalid_original_result_clock") from None
    groups = value["groups"]
    _require(type(groups) is list and len(groups) <= 500, "invalid_result_groups")
    seen = {key: set() for key in ("group_id", "receipt_ids", "source_receipt_ids", "observation_ids", "revision_ids")}
    for group in groups:
        _require(type(group) is dict and set(group) == GROUP_KEYS, "invalid_result_group")
        scope = group["scope"]
        _require(type(scope) is list and len(scope) == 5 and type(scope[0]) is int
                 and scope[0] == request["envelope"]["manifest"]["season"]
                 and all(type(item) is str and 0 < len(item) <= 200 for item in scope[1:])
                 and scope[3] in ("qb_pass_yds", "rb_rush_yds", "wr_rec_yds") and scope[4] in ("home", "away")
                 and group["group_id"] == ex.fingerprint(scope), "invalid_result_scope")
        for key in ("receipt_ids", "source_receipt_ids", "generation_object_ids", "observation_ids", "revision_ids"):
            _ids(group[key], hashes=key != "revision_ids", nonempty=key in ("receipt_ids", "source_receipt_ids", "generation_object_ids"))
        membership = {"binding_policy": POLICY, **{key: group[key] for key in ("scope", "receipt_ids", "source_receipt_ids", "generation_object_ids")}}
        _require(group["membership_id"] == ex.fingerprint(membership)
                 and len(group["receipt_ids"]) == len(group["source_receipt_ids"]), "invalid_group_membership")
        reasons = group["reason_codes"]
        _require(type(reasons) is list and len(reasons) <= 100
                 and all(type(reason) is str and bool(ex.REASON.fullmatch(reason)) for reason in reasons)
                 and reasons == sorted(set(reasons)) and group["status"] in ("accepted", "withheld")
                 and (group["status"] == "accepted") == (not reasons), "invalid_result_group_status")
        _require((len(group["observation_ids"]) == len(group["receipt_ids"]) if group["status"] == "accepted"
                 else not group["observation_ids"] and not group["revision_ids"]), "incomplete_result_group")
        _require(len(group["revision_ids"]) <= len(group["receipt_ids"]), "too_many_group_revisions")
        for key in seen:
            values = [group[key]] if key == "group_id" else group[key]
            _require(not seen[key].intersection(values), "duplicate_result_member")
            seen[key].update(values)
    _require(len(seen["receipt_ids"]) <= 500 and value["membership_id"] == ex.fingerprint(
        {"binding_policy": POLICY, "groups": [group["membership_id"] for group in groups]}), "invalid_result_membership")
    expected = ("no_supported_membership" if not groups else "accepted" if all(g["status"] == "accepted" for g in groups)
                else "partial" if any(g["status"] == "accepted" for g in groups) else "withheld")
    _require(value["status"] == expected, "invalid_original_result_status")
    for key, ids in (("added_observations", seen["observation_ids"]), ("added_revisions", seen["revision_ids"])):
        _require(type(value[key]) is int and 0 <= value[key] <= len(ids), "invalid_original_result_counts")
    low, high = _sequence(value["input_watermark"]), _sequence(value["watermark"])
    _sequence(value["delivery_seq"], positive=True)
    _require(high >= low and bool(value["added_observations"] + value["added_revisions"]) == (high != low), "invalid_original_result_watermark")
    _body(value)
    return value


def _stage(value, dto):
    _require(type(value) is dict and set(value) == {"version", "kind", "scope", "bucket", "key", "chunk_id", "raw_bytes", "learning_accepted", "durable_ack"}
             and type(value["version"]) is int and value["version"] == 1 and value["kind"] == "selflearn.evidence_stage.v1"
             and value["scope"] == "uploaded_only" and value["learning_accepted"] is False and value["durable_ack"] is False
             and value["chunk_id"] == dto["chunk_id"] and type(value["raw_bytes"]) is int and value["raw_bytes"] == dto["raw_bytes"]
             and all(type(value[key]) is str and 0 < len(value[key]) <= 1024 for key in ("bucket", "key")), "invalid_staging_ack")
    # Bucket/key are server-private implementation details, not future URLs.
    return {key: value[key] for key in ("version", "kind", "scope", "chunk_id", "raw_bytes", "learning_accepted", "durable_ack")}


def http_transport(destination, token):
    destination = _origin(destination)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ex._NoRedirect())

    def exchange(method, path, body):
        # Check BEFORE constructing a URL or attaching the bearer credential:
        # origin + '@host/path' would otherwise reinterpret origin as userinfo.
        _require(type(method) is str and type(path) is str and (
            method == "POST" and path in (CHUNK_ROUTE, DELIVERY_ROUTE) or method == "GET"
            and re.fullmatch(re.escape(DELIVERY_ROUTE) + r"/sha256%3A[0-9a-f]{64}", path)), "invalid_outcome_route")
        _require(body is None if method == "GET" else type(body) is bytes and 0 < len(body) <= BODY_BYTES,
                 "invalid_outcome_request_body")
        request = urllib.request.Request(destination + path, data=body, method=method,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with opener.open(request, timeout=20) as response:
                _require(response.geturl() == destination + path, "outcome_redirect_rejected")
                return response.status, response.read(BODY_BYTES + 1)
        except urllib.error.HTTPError as error:
            error.close()
            return error.code, b""
    return exchange


def _exchange(transport, method, route, body, attempts, sleep, *, missing=False):
    for attempt in range(attempts):
        try:
            status, raw = transport(method, route, body)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt + 1 == attempts:
                raise OutcomeExportError("outcome_transport_retry_exhausted") from None
        except Exception:
            # Protocol/parser/custom transport errors are not safe diagnostics
            # and are not evidence of a retryable network outage.
            raise OutcomeExportError("outcome_transport_failed") from None
        else:
            _require(type(status) is int, "invalid_outcome_http_status")
            if status == 404 and missing:
                return None
            if 200 <= status < 300:
                _require(type(raw) is bytes and len(raw) <= BODY_BYTES, "invalid_outcome_response_bound")
                try:
                    return ex._json(raw)
                except ex.ExportError:
                    raise OutcomeExportError("invalid_outcome_response_json") from None
            _require(not 300 <= status < 400, "outcome_redirect_rejected")
            _require(status == 429 or 500 <= status < 600, "outcome_http_refused")
            if attempt + 1 == attempts:
                raise OutcomeExportError("outcome_http_retry_exhausted")
        sleep(min(.5 * 2 ** attempt, 2))
    raise OutcomeExportError("invalid_outcome_retry_configuration")


def send(value, out_dir, token, *, transport=None, attempts=3, sleep=time.sleep):
    """Explicit bounded sender. Original result always describes its old cohort."""
    value, bundle = _validated(value)  # Origin/capture checks precede credentials/writes.
    _require(type(token) is str and 32 <= len(token) <= 8192 and all(0x21 <= ord(c) <= 0x7e for c in token), "invalid_outcome_ingest_token")
    _require(type(attempts) is int and 1 <= attempts <= 5, "invalid_outcome_retry_configuration")
    root, target = _output(value, out_dir)
    _write(root, target / "outbox" / "delivery.json", {"version": 1, "request": value["request"]})
    request = value["request"]
    route = DELIVERY_ROUTE + "/" + urllib.parse.quote(request["delivery_id"], safe="")
    result_path = target / "results" / "original.json"
    conflict_path = target / "failures" / "conflict.json"
    for path in (result_path, conflict_path):
        ex._delivery_path(root, *path.relative_to(root).parts)
    _require(not conflict_path.exists(), "known_outcome_result_conflict")
    try:
        transport = transport or http_transport(value["destination"], token)
        result = _exchange(transport, "GET", route, None, attempts, sleep, missing=True)
        if result is None:
            staged = set()
            for object_id, raw in sorted(bundle["raw_objects"].items()):
                for start in range(0, len(raw), CHUNK_BYTES):
                    dto = _chunk(raw[start:start + CHUNK_BYTES])
                    if dto["chunk_id"] in staged:
                        continue
                    body = _body(dto)
                    operation = {"version": 1, "destination_id": request["destination_id"], "chunk_id": dto["chunk_id"],
                                 "raw_bytes": dto["raw_bytes"], "request_sha256": _raw_hash(body)}
                    name = dto["chunk_id"][7:] + ".json"
                    _write(root, target / "outbox" / name, operation)
                    ack = _stage(_exchange(transport, "POST", CHUNK_ROUTE, body, attempts, sleep), dto)
                    _write(root, target / "staging" / name, ack)
                    staged.add(dto["chunk_id"])
            for attempt in range(attempts):
                try:
                    wrapper = _exchange(transport, "POST", DELIVERY_ROUTE, _body(request), 1, sleep)
                    _require(type(wrapper) is dict and set(wrapper) == {"version", "status", "attempts", "result", "scope"}
                             and type(wrapper["version"]) is int and wrapper["version"] == 1
                             and wrapper["status"] in ("recorded_or_recovered", "recovered_original")
                             and type(wrapper["attempts"]) is int and 1 <= wrapper["attempts"] <= 5
                             and wrapper["scope"] == "internal_delivery_results_only", "invalid_outcome_delivery_wrapper")
                    result = wrapper["result"]
                    break
                except OutcomeExportError as error:
                    if _reason(error) not in ("outcome_transport_retry_exhausted", "outcome_http_retry_exhausted"):
                        raise
                    result = _exchange(transport, "GET", route, None, attempts, sleep, missing=True)
                    if result is not None:
                        break
                    if attempt + 1 == attempts:
                        raise
                    sleep(min(.5 * 2 ** attempt, 2))
        result = _result(result, request)
        if result_path.exists() and not ex._same_json(ex._read(result_path), result):
            _write(root, conflict_path, {"version": 1, "reason": "original_outcome_result_conflict"})
            raise OutcomeExportError("original_outcome_result_conflict")
        _write(root, result_path, result)
        accepted = sum(group["status"] == "accepted" for group in result["groups"])
        return {"version": 1, "status": "original_result", "delivery_id": request["delivery_id"], "result": result,
                "durable_result_ack": True, "learning_ack": accepted > 0, "accepted_groups": accepted,
                "complete_success": result["status"] == "accepted", "current_membership_reverified": False,
                "source_authentication": "not_performed"}
    except Exception as error:
        reason = _reason(error)
        _write(root, target / "failures" / (ex.fingerprint(reason)[7:] + ".json"), {"version": 1, "reason": reason})
        return {"version": 1, "status": "pending", "delivery_id": request["delivery_id"], "learning_ack": False, "reason": reason}


def main(argv=None):
    parser = ex._SafeParser(description=__doc__)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--out-dir")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--send", action="store_true")
    mode.add_argument("--prepare", action="store_true")
    args = parser.parse_args(argv)
    try:
        value = plan(args.capture, args.base_url)
        if not args.send and not args.prepare:
            result = {"version": 1, "mode": "dry_run", "capture_id": value["request"]["capture_id"],
                "raw_bytes": value["raw_bytes"], "unique_chunks": value["unique_chunks"], "network_used": False,
                "writes": False, "learning_ack": False, "membership_capacity": value["membership_capacity"]}
        else:
            _require(args.out_dir is not None, "explicit_outcome_outbox_required")
            result = (send(value, args.out_dir, os.environ.get("SELFLEARN_NFL_OUTCOME_INGEST_TOKEN")) if args.send
                      else prepare(value, args.out_dir))
        print(ex.encoded(result).decode("ascii"))
        return (1 if result.get("status") == "pending" else 3
                if result.get("status") == "original_result" and not result["complete_success"] else 0)
    except Exception:
        print('{"version":1,"status":"pending","learning_ack":false,"reason":"outcome_export_refused"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
