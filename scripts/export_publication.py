#!/usr/bin/env python3
"""Read a finalized forecast and validate its original publication evidence."""
import ipaddress
import os
from pathlib import Path
import re
import sys
import stat
import urllib.parse

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import export_learning as E, pilot_capture as capture
from scripts import run_forecast_delivery as forecast

ORIGIN = forecast.ORIGIN
ENGINE_COMMIT = "0fc6b1871bc6f06117adb42d1b72ff07f6c1a51a"
POLICY_KIND = "nfl.pool_http_publication.v1"
# Public pretty-printed bytes are larger than canonical ingestion envelopes.
# This bound applies only to the independently fetched public pool, not intake.
MAX_PUBLIC_POOL_BYTES = 4 * 1024 * 1024
ACK_KEYS = set("version kind object_id generation_id source_pool_id policy policy_id recorded_utc observation receipts rejections status scope durable attestation_id".split())
MEMBER_KEYS = set("receipt_id source_receipt_id market direction served_prob event_start_utc".split())


class PublicationError(ValueError):
    """Static local refusal; no arbitrary callback/server text is retained."""


def need(condition, reason="publication_refused"):
    if not condition:
        raise PublicationError(reason)


def keys(value, names):
    need(type(value) is dict and set(value) == set(names), "publication_invalid_fields")


def policy(origin):
    need(type(origin) is str and 1 <= len(origin) <= 2048 and origin.isascii(), "publication_invalid_origin")
    try:
        parsed = urllib.parse.urlsplit(origin)
        host = parsed.hostname
        valid = (parsed.scheme == "https" and host and parsed.netloc == host
            and not parsed.path and not parsed.query and not parsed.fragment
            and parsed.username is None and parsed.password is None and parsed.port is None
            and origin == "https://" + host and len(host) <= 253 and "." in host
            and host != "localhost" and not host.endswith(".localhost")
            and re.fullmatch(r"[a-z]{2,63}", host.rsplit(".",1)[-1])
            and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                    for label in host.split(".")))
        if valid:
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                valid = False
        need(valid, "publication_invalid_origin")
    except (ValueError, TypeError):
        raise PublicationError("publication_invalid_origin") from None
    return {"version":1, "kind":POLICY_KIND, "origin":origin, "path":"/data/leg_pool.json"}


def stamp(value):
    result = capture.lr.instant(value)
    need(result is not None, "publication_invalid_clock")
    return result


def read(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        need(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "publication_local_record_not_regular")
        raw = stream.read(E.MAX_BODY_BYTES + 65537)
    need(len(raw) <= E.MAX_BODY_BYTES + 65536, "publication_local_record_too_large")
    return E._json(raw)


def original_ack(root, request, phase, expected=()):
    op = forecast.intake_operation(request, phase)
    dest, name = op["destination_id"][7:], E.fingerprint(op)[7:] + ".json"
    conflict = {"operation":op, "reason":"immutable_delivery_conflict"}
    need(not E._delivery_path(root, "delivery", dest, "failures", E.fingerprint(conflict)[7:]+".json").exists(),
         "publication_ingest_conflict")
    outbox = read(E._delivery_path(root, "delivery", dest, "outbox", name))
    stored = read(E._delivery_path(root, "delivery", dest, "acks", name))
    keys(outbox, {"operation", "request"});keys(stored, {"operation", "ack"})
    need(E._same_json(outbox, {"operation":op, "request":request})
         and E._same_json(stored["operation"], op), "publication_ingest_conflict")
    ack = stored["ack"]
    E._validate_ack(ack, op, expected)
    need(E._same_json(ack, E._safe_ack(ack, phase)), "publication_ingest_ack_not_exact")
    return ack


def plan(workspace, expected_public_origin):
    capture.disabled_config()
    expected_policy = policy(expected_public_origin)
    root = capture.workspace_root(workspace)
    graph = E.plan(E._delivery_path(root, "snapshots"))
    entry, gen = forecast._generation(graph)
    for request in graph["source_objects"]:
        original_ack(root, request, "object")
    original_ack(root, entry["request"], "object")
    ack = original_ack(root, {"version":1, "object_id":entry["request"]["object_id"]},
                       "generation", entry["expected_receipt_ids"])
    # The exhaustive ACK is already strictly validated. A recovered immutable
    # operation may report duplicate instead of recorded, or reorder rows;
    # these transport differences cannot change publication evidence identity.
    semantic_ack = {**ack,
        "receipts":sorted(({k:v for k,v in row.items() if k != "status"} for row in ack["receipts"]),
                          key=lambda row:row["source_receipt_id"]),
        "rejections":sorted(ack["rejections"], key=lambda row:row["source_receipt_id"])}
    rows = {row["receipt_id"]:row for row in entry["request"]["payload"]["receipts"]}
    members = []
    for accepted in ack["receipts"]:
        sid = accepted["source_receipt_id"]; row = rows[sid]; source = row["learning_receipt"]
        need(source["receipt_id"] == sid and source["direction"] == "over", "publication_invalid_source")
        members.append({"receipt_id":accepted["receipt_id"], "source_receipt_id":sid,
            "market":source["market"], "direction":source["direction"],
            "served_prob":source["served_prob"], "event_start_utc":row["kickoff_utc"]})
    need(bool(members), "publication_no_accepted_forecasts")
    value = {"version":1, "kind":"nfl.publication_export_plan.v1", "workspace":str(root),
        "destination":ORIGIN, "policy":expected_policy, "policy_id":E.fingerprint(expected_policy),
        "request":{"version":1, "object_id":entry["request"]["object_id"]},
        "generation_id":gen["generation_id"], "source_pool_id":gen["source_snapshots"]["leg_pool"],
        "generation_recorded_utc":gen["recorded_utc"],
        "ingest_ack_id":E.fingerprint(semantic_ack), "ingest_rejections":semantic_ack["rejections"],
        "members":sorted(members,key=lambda row:row["source_receipt_id"])}
    # The locator is revalidated before every send, but is not forecast
    # evidence. Moving a whole outbox must preserve its immutable operation.
    return {**value, "plan_id":E.fingerprint({k:v for k,v in value.items() if k != "workspace"})}


def validate_ack(ack, value):
    keys(ack, ACK_KEYS)
    need(type(ack["version"]) is int and ack["version"] == 1
         and ack["kind"] == "nfl.pool_http_publication_attestation.v1"
         and ack["scope"] == "public_pool_http_evidence_only" and ack["durable"] is True,
         "publication_invalid_ack")
    for key in ("object_id", "generation_id", "source_pool_id", "policy_id", "attestation_id"):
        E._hash(ack[key])
    need(ack["object_id"] == value["request"]["object_id"]
         and all(ack[k] == value[k] for k in ("generation_id", "source_pool_id", "policy_id"))
         and E._same_json(ack["policy"], value["policy"]), "publication_wrong_identity")
    need(ack["attestation_id"] == E.fingerprint({k:v for k,v in ack.items() if k != "attestation_id"}),
         "publication_ack_hash_mismatch")
    obs = ack["observation"]
    keys(obs, {"observed_started_utc", "observed_completed_utc", "http_status", "body_sha256", "body_bytes"})
    E._hash(obs["body_sha256"])
    need(type(obs["http_status"]) is int and obs["http_status"] == 200
         and type(obs["body_bytes"]) is int and 0 < obs["body_bytes"] <= MAX_PUBLIC_POOL_BYTES,
         "publication_invalid_observation")
    begun, completed, recorded = map(stamp, (obs["observed_started_utc"], obs["observed_completed_utc"], ack["recorded_utc"]))
    need(stamp(value["generation_recorded_utc"]) <= begun <= completed <= recorded,
         "publication_invalid_clock")
    need(type(ack["receipts"]) is list and type(ack["rejections"]) is list, "publication_invalid_partition")
    expected = {row["source_receipt_id"]:row for row in value["members"]}
    seen, generic = set(), set()
    for rows, accepted in ((ack["receipts"],True), (ack["rejections"],False)):
        ordered = []
        for row in rows:
            keys(row, MEMBER_KEYS if accepted else {"receipt_id", "source_receipt_id", "reason"})
            sid, rid = row["source_receipt_id"], row["receipt_id"]
            need(type(sid) is str and sid in expected and sid not in seen
                 and type(rid) is str and rid == expected[sid]["receipt_id"] and rid not in generic,
                 "publication_invalid_partition")
            seen.add(sid);generic.add(rid);ordered.append(sid)
            late = completed >= stamp(expected[sid]["event_start_utc"]) or recorded >= stamp(expected[sid]["event_start_utc"])
            if accepted:
                need(not late and E._same_json(row, expected[sid]), "publication_invalid_member")
            else:
                need(late and row["reason"] == "publication_not_preevent", "publication_invalid_rejection")
        need(ordered == sorted(ordered), "publication_noncanonical_partition")
    need(seen == set(expected), "publication_incomplete_partition")
    status = ("accepted" if ack["receipts"] and not ack["rejections"] else "partial" if ack["receipts"]
              else "withheld" if ack["rejections"] else "no_supported_membership")
    need(ack["status"] == status, "publication_invalid_status")
    return ack

