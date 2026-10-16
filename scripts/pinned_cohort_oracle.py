#!/usr/bin/env python3
"""Independent, read-only NFL oracle for a supplied frozen engine cohort.

Only eligible-pool MY yardage receipts and observed-resolution-v2 chains are
supported. This is NOT the live review, a revision producer, an authenticated
source, a database snapshot reader, historical reconstruction or a fitter.
Original revision identities and database clocks are supplied, never minted.
The oracle imports only NFL code/stdlib, never the engine cohort selector.
"""
import base64
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import build_learning_outcomes as producer  # noqa: E402
from scripts import capture_outcome_evidence as capture  # noqa: E402
from scripts import learning_receipts as lr  # noqa: E402
from scripts.resolve_my_cards import grade_prop  # noqa: E402
from scripts.resolve_parlay_legs import brier, index_capture_snaps, index_stats, log_loss  # noqa: E402

MAX_INPUT = 128 * 1024 * 1024
MAX_RAW = 64 * 1024 * 1024
MAX_RECEIPTS, MAX_REVISIONS, MAX_GENERATIONS, MAX_CAPTURES = 5000, 20000, 256, 20
BRIDGE = "nfl.observed_resolution_v2"
PARITY = ("contract_id", "base_prob", "served_prob", "base_model_version", "calibrator_version",
          "forecast_created_utc", "source_snapshot_id", "source_timestamps", "features", "publication_status")


def _time(value):
    result = lr.instant(value)
    if result is None:
        raise ValueError("invalid_clock")
    return result


def _equal(left, right):
    return lr.fingerprint(left) == lr.fingerprint(right)


def _bounded(value):
    if len(json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False).encode()) > MAX_INPUT:
        raise ValueError("analysis_input_too_large")
    if (type(value) is not dict or set(value) != {"version", "snapshot", "export_plan", "captures", "as_of_utc", "population"}
            or type(value["version"]) is not int or value["version"] != 1):
        raise ValueError("invalid_analysis_input")
    snapshot = value["snapshot"]
    if (type(snapshot) is not dict or type(snapshot.get("version")) is not int or snapshot["version"] != 1
            or set(snapshot) - {"version", "watermark", "receipts", "generation_records", "revisions"}):
        raise ValueError("invalid_snapshot")
    for key, limit in (("receipts", MAX_RECEIPTS), ("revisions", MAX_REVISIONS), ("generation_records", MAX_GENERATIONS)):
        if type(snapshot.get(key)) is not list or len(snapshot[key]) > limit:
            raise ValueError("snapshot_population_limit")
    if snapshot.get("watermark") is not None and (type(snapshot["watermark"]) is not str
            or re.fullmatch(r"0|[1-9][0-9]{0,18}", snapshot["watermark"]) is None):
        raise ValueError("invalid_snapshot_watermark")
    if type(value["captures"]) is not list or len(value["captures"]) > MAX_CAPTURES:
        raise ValueError("capture_population_limit")
    _time(value["as_of_utc"])
    return snapshot


def _capture_rows(encoded, plan):
    """Verify exact raw bytes, run the actual producer AND recorded prop grader."""
    labels, total, rejections = {}, 0, Counter()
    frozen_legs = {row["receipt_id"]: row["leg"] for item in plan["generations"]
                   for row in item["request"]["payload"]["receipts"]}
    for wrapped in encoded:
        if type(wrapped) is not dict or set(wrapped) != {"manifest", "observations", "raw"} or type(wrapped["raw"]) is not dict:
            raise ValueError("invalid_capture_transport")
        raw = {}
        for oid, text in wrapped["raw"].items():
            if type(text) is not str:
                raise ValueError("invalid_capture_raw")
            data = base64.b64decode(text, validate=True)
            total += len(data)
            if total > MAX_RAW:
                raise ValueError("capture_byte_limit")
            raw[oid] = data
        bundle = {"manifest": wrapped["manifest"], "observations": wrapped["observations"], "raw_objects": raw}
        capture.verify_capture(bundle)
        produced = producer.build(plan, bundle)
        rejections.update(produced["summary"]["exclusion_reasons"])
        stats = capture.csv_rows(bundle, capture.STATS_PROFILE)
        snaps, _ = index_capture_snaps(capture.csv_rows(bundle, capture.SNAPS_PROFILE))
        indexed = index_stats(stats)
        for leg in produced["observed_legs"]:
            graded = grade_prop({**frozen_legs[leg["source_receipt_id"]], **leg}, leg["week"], indexed, snaps)
            same_actual = (graded[1] is None and leg["actual"] is None) or (
                lr.finite_number(graded[1]) and lr.finite_number(leg["actual"])
                and math.isclose(graded[1], leg["actual"], rel_tol=0, abs_tol=1e-12))
            if graded[0] != leg["result"] or graded[2] != leg["reason"] or not same_actual:
                raise ValueError("actual_nfl_grader_producer_disagreement")
            key = (produced["capture_id"], leg["source_receipt_id"])
            label = {"leg": leg, "game": produced["game_observations"][leg["game_id"]]}
            if key in labels and not _equal(labels[key], label):
                raise ValueError("conflicting_raw_capture_grade")
            labels[key] = label
    return labels, dict(sorted(rejections.items()))


def _receipt(row, entries):
    if (type(row) is not dict or type(row.get("version")) is not int or row["version"] != 1
            or row.get("domain") != "nfl" or row.get("task") != "nfl.parlay_leg"
            or row.get("receipt_id") != lr.fingerprint({k: v for k, v in row.items() if k != "receipt_id"})):
        raise ValueError("invalid_engine_receipt")
    entry = entries.get(row.get("source_receipt_id"))
    if entry is None:
        raise ValueError("missing_original_source")
    source = entry["source_receipt"]
    if not all(_equal(row.get(key), source.get(key)) for key in PARITY):
        raise ValueError("source_envelope_parity_mismatch")
    if not _time(row["forecast_created_utc"]) <= _time(row["first_seen_utc"]) < _time(row["event_start_utc"]):
        raise ValueError("not_preevent")
    if (_time(row["event_start_utc"]) != _time(entry["game"]["kickoff_utc"])
            or row["event_id"] != "nfl:%s:game:%s" % (source["season"], source["game_id"])
            or row["correlation_group"] != row["event_id"]):
        raise ValueError("event_mismatch")
    context = source.get("input_context") or {}
    eligibility, weekly = context.get("eligibility") or {}, context.get("this_week") or {}
    if (eligibility.get("eligible") is False or weekly.get("playable") is False
            or eligibility.get("week", source["week"]) != source["week"]
            or weekly.get("wk", source["week"]) != source["week"]):
        raise ValueError("source_not_eligible")
    provenance = row.get("capture_provenance") or {}
    if (provenance.get("kind") != "nfl_generation_journal"
            or provenance.get("population") != "eligible_pool_prop_rungs_before_display_dedupe"):
        raise ValueError("unsupported_capture_population")
    return source


def _commits(snapshot, plan):
    """Bind supplied commit records to exact original documents and ACK partition.

    These are checked supplied records, not independently fetched durable proof.
    The caller's content pin cannot prove that omitted commits never existed.
    """
    docs = {item["request"]["object_id"]: item["request"]["payload"] for item in plan["generations"]}
    persisted = {row["source_receipt_id"]: row["receipt_id"] for row in snapshot["receipts"]}
    accepted, captures, seen = set(), defaultdict(list), {}
    for record in snapshot["generation_records"]:
        oid, doc, ack = record["object_id"], record["payload"], record["ack"]
        if (oid not in docs or not _equal(docs[oid], doc) or oid != doc["envelope_id"]
                or oid != lr.fingerprint({k: v for k, v in doc.items() if k != "envelope_id"})
                or type(ack.get("version")) is not int or ack["version"] != 1
                or ack.get("object_id") != oid or ack.get("durable") is not True):
            raise ValueError("invalid_original_generation_commit")
        if oid in seen:
            if not _equal(seen[oid], record):
                raise ValueError("conflicting_generation_commit")
            continue
        seen[oid] = record
        wanted = {row["receipt_id"] for row in doc["receipts"]}
        partition = []
        for row in ack["receipts"]:
            sid = row["source_receipt_id"]
            if row.get("status") not in ("recorded", "duplicate") or persisted.get(sid) != row.get("receipt_id"):
                raise ValueError("generation_ack_mapping_mismatch")
            accepted.add(sid)
            partition.append(sid)
        for row in ack["rejections"]:
            if type(row.get("reason")) is not str or not row["reason"].strip():
                raise ValueError("invalid_generation_rejection")
            partition.append(row["source_receipt_id"])
        if len(partition) != len(set(partition)) or set(partition) != wanted:
            raise ValueError("generation_ack_partition_mismatch")
        for row in doc["receipts"]:
            if _time(row["recorded_utc"]) > _time(record["recorded_utc"]):
                raise ValueError("capture_after_database_commit")
            captures[row["receipt_id"]].append(row["recorded_utc"])
    if accepted != set(persisted):
        raise ValueError("incomplete_snapshot_receipt_commit_mapping")
    for row in snapshot["receipts"]:
        if _time(row["first_seen_utc"]) != min(map(_time, captures[row["source_receipt_id"]])):
            raise ValueError("original_first_capture_mismatch")


def _revision(receipt, revisions, cutoff, labels):
    """Independent chain traversal, using supplied database observation clocks."""
    known = {}
    for node in revisions:
        if _time(node["recorded_utc"]) >= cutoff:
            continue
        if (type(node.get("version")) is not int or node["version"] != 1
                or type(node.get("revision_id")) is not str or not node["revision_id"]):
            raise ValueError("invalid_revision_identity")
        out = node["resolution"]
        if (any(out.get(key) != receipt[key] for key in ("receipt_id", "contract_id", "event_id"))
                or out.get("evidence_basis") != BRIDGE
                or out.get("status") not in ("FINAL", "VOID")
                or (out["status"] == "FINAL" and type(out.get("hit")) is not bool)
                or (out["status"] == "VOID" and out.get("hit") is not None)
                or not _time(receipt["event_start_utc"]) <= _time(out["resolved_utc"]) <= _time(node["recorded_utc"])):
            raise ValueError("unsupported_or_invalid_revision")
        label = labels.get(((out.get("producer_trace") or {}).get("evidence_capture_id"), receipt["source_receipt_id"]))
        if label is None:
            raise ValueError("missing_original_raw_evidence")
        leg, game = label["leg"], label["game"]
        expected_status = "VOID" if leg["result"] == "void" else "FINAL"
        expected_hit = None if expected_status == "VOID" else leg["result"] == "hit"
        if not all(_equal(out.get(key), expected) for key, expected in
                   (("status", expected_status), ("hit", expected_hit), ("actual", leg["actual"]), ("reason", leg["reason"]))):
            raise ValueError("raw_grade_revision_mismatch")
        measurement = {"version": 1, "canonical_contract": list(lr.canonical_key(leg, leg["season"])),
            "week": leg["week"], "actual": leg["actual"], "played": leg["played"], "status": expected_status,
            "hit": expected_hit, "reason": leg["reason"], "participation_basis": leg["participation_basis"],
            "game": {"season": leg["season"], "week": leg["week"], "game_id": leg["game_id"],
                "kickoff_utc": _time(game["kickoff_utc"]).isoformat(), "home": game["home"], "away": game["away"], "state": "FINAL"}}
        if (not _equal(out.get("measurement"), measurement) or out.get("source") != leg["source"]
                or out.get("participation_basis") != leg["participation_basis"]
                or out.get("authoritative") is not True or out.get("final_evidence_status") != "FINAL"
                or "source_updated_utc" in out or "source_revision_id" in out):
            raise ValueError("raw_measurement_revision_mismatch")
        components = out.get("source_observations")
        if type(components) is not dict or not components:
            raise ValueError("missing_observation_components")
        for component in components.values():
            if _time(component["observed_utc"]) > _time(node["recorded_utc"]):
                raise ValueError("evidence_after_database_observation")
        expected_components = {
            leg["source"]: {"source": leg["source"], "observation_id": leg["observation_id"], "observed_utc": leg["observed_utc"]},
            "espn.scoreboard": {"source": "espn.scoreboard", "observation_id": game["observation_id"], "observed_utc": game["observed_utc"]}}
        if "participation_source" in leg:
            source = leg["participation_source"]
            expected_components[source] = {"source": source, "observation_id": leg["participation_observation_id"],
                                           "observed_utc": leg["participation_observed_utc"]}
        if (not _equal(components, expected_components)
                or out.get("evidence_observed_utc") != out.get("resolved_utc")
                or not _equal(out.get("game_evidence"), {"status": game["status"], "kickoff_utc": game["kickoff_utc"],
                    "source": "espn.scoreboard", "observed_utc": game["observed_utc"], "observation_id": game["observation_id"],
                    "final_utc": None, "source_updated_utc": None})
                or not _equal(out.get("timing_limitations"), {"upstream_updated_utc": None, "provider_final_revision_known": False})
                or out.get("measurement_id") != lr.fingerprint(out.get("measurement"))
                or out.get("evidence_observation_id") != lr.fingerprint({"measurement_id": out["measurement_id"], "components": components})
                or out.get("resolved_utc") != max((c["observed_utc"] for c in components.values()), key=_time)
                or node["revision_id"] != BRIDGE + ":" + lr.fingerprint({"receipt_id": receipt["receipt_id"],
                    "observation_id": out["evidence_observation_id"], "supersedes": node.get("supersedes")})):
            raise ValueError("revision_evidence_identity_mismatch")
        rid = node["revision_id"]
        if node.get("supersedes") is None and not _equal(out.get("observation_watermarks"), components):
            raise ValueError("invalid_initial_observation_fence")
        if rid in known and not _equal(node, known[rid]):
            raise ValueError("revision_id_conflict")
        known[rid] = node
    if not known:
        return None
    children, roots = defaultdict(list), []
    for rid, node in known.items():
        parent = node.get("supersedes")
        if parent is None:
            roots.append(rid)
        elif parent not in known:
            raise ValueError("missing_revision_predecessor")
        else:
            old = known[parent]
            if (not isinstance(node.get("reason"), str) or not node["reason"].strip()
                    or _time(old["recorded_utc"]) > _time(node["recorded_utc"])
                    or _time(old["resolution"]["resolved_utc"]) >= _time(node["resolution"]["resolved_utc"])
                    or old["resolution"]["measurement_id"] == node["resolution"]["measurement_id"]
                    or not _equal(old["resolution"]["measurement"]["game"], node["resolution"]["measurement"]["game"])):
                raise ValueError("invalid_revision_correction")
            expected_watermarks = {**old["resolution"]["observation_watermarks"], **node["resolution"]["source_observations"]}
            if not _equal(node["resolution"].get("observation_watermarks"), expected_watermarks):
                raise ValueError("invalid_carried_observation_fence")
            for source, component in node["resolution"]["source_observations"].items():
                prior = old["resolution"]["observation_watermarks"].get(source)
                if prior and _time(component["observed_utc"]) < _time(prior["observed_utc"]):
                    raise ValueError("revision_source_clock_regressed")
                if prior and source == node["resolution"]["source"] and (
                        _time(component["observed_utc"]) <= _time(prior["observed_utc"])
                        or component["observation_id"] == prior["observation_id"]):
                    raise ValueError("changed_measurement_primary_observation_not_newer")
            children[parent].append(rid)
    if len(roots) != 1 or any(len(items) > 1 for items in children.values()):
        raise ValueError("revision_chain_fork")
    cursor, visited = roots[0], set()
    while cursor not in visited:
        visited.add(cursor)
        if not children[cursor]:
            if len(visited) != len(known):
                raise ValueError("disconnected_revision_chain")
            return known[cursor]
        cursor = children[cursor][0]
    raise ValueError("revision_chain_cycle")


def oracle(value):
    snapshot = _bounded(value)
    if value["population"] != "eligible_pool":
        return {"version": 1, "status": "unsupported_population", "supported": False}
    plan, cutoff = value["export_plan"], _time(value["as_of_utc"])
    docs = [item["request"]["payload"] for item in plan["generations"]]
    if len(docs) > MAX_GENERATIONS or not docs:
        raise ValueError("generation_population_limit")
    seasons = {doc["season"] for doc in docs}
    if len(seasons) != 1:
        raise ValueError("unsupported_mixed_seasons")
    entries, rejected, _, _ = producer._entries(plan, next(iter(seasons)), {doc["week"] for doc in docs})
    if rejected:
        raise ValueError("invalid_original_generation_graph")
    _commits(snapshot, plan)
    labels, capture_excluded = _capture_rows(value["captures"], plan)
    indexed, revision_ids = defaultdict(list), {}
    receipt_index = {row["receipt_id"]: row for row in snapshot["receipts"]}
    for node in snapshot["revisions"]:
        if (type(node) is not dict or set(node) != {"version", "revision_id", "supersedes", "reason", "resolution", "recorded_utc"}
                or type(node.get("version")) is not int or node["version"] != 1
                or type(node.get("revision_id")) is not str or not node["revision_id"]
                or type(node.get("resolution")) is not dict):
            raise ValueError("malformed_global_revision_population")
        out = node["resolution"]
        original = receipt_index.get(out.get("receipt_id"))
        if original is None or any(out.get(key) != original.get(key) for key in ("contract_id", "event_id")):
            raise ValueError("foreign_or_mismatched_global_revision")
        _time(node["recorded_utc"])
        rid = node["revision_id"]
        if rid in revision_ids and not _equal(node, revision_ids[rid]):
            raise ValueError("conflicting_global_revision_identity")
        revision_ids[rid] = node
        indexed[node["resolution"]["receipt_id"]].append(node)
    candidates, sources, reasons, seen = defaultdict(list), {}, Counter(), {}
    for row in snapshot["receipts"]:
        source = _receipt(row, entries)
        sources[source["receipt_id"]] = source
        if _time(row["first_seen_utc"]) >= cutoff:
            reasons["future_capture"] += 1
            continue
        if row["receipt_id"] in seen:
            reasons["duplicate_receipt_copy"] += 1
            continue
        seen[row["receipt_id"]] = row
        candidates[row["contract_id"]].append((row, source))
    rows, forecasts = [], []
    for contract, versions in sorted(candidates.items()):
        versions.sort(key=lambda pair: (_time(pair[0]["forecast_created_utc"]), _time(pair[0]["first_seen_utc"]), pair[0]["receipt_id"]))
        first = _time(versions[0][0]["forecast_created_utc"])
        tied = [r for r, _ in versions if _time(r["forecast_created_utc"]) == first]
        if len({lr.fingerprint([r[key] for key in ("base_prob", "served_prob", "base_model_version", "calibrator_version", "features")]) for r in tied}) != 1:
            reasons["conflicting_first_forecast"] += 1
            continue
        row, source = versions[0]
        forecasts.append({"receipt_id": row["receipt_id"], "source_receipt_id": source["receipt_id"], "contract_id": contract})
        try:
            latest = [_revision(r, indexed[r["receipt_id"]], cutoff, labels) for r, _ in versions]
            dispositions = {(n["resolution"]["status"], n["resolution"]["hit"]) for n in latest if n}
            if len(dispositions) > 1:
                raise ValueError("conflicting_contract_outcomes")
            node = latest[0]
            if node is None:
                raise ValueError("unresolved_at_cutoff")
            result = node["resolution"]
            if result["status"] != "FINAL":
                raise ValueError("non_binary_latest_revision")
            rows.append({"receipt_id": row["receipt_id"], "source_receipt_id": source["receipt_id"], "contract_id": contract,
                "revision_id": node["revision_id"], "revision_hash": lr.fingerprint(node), "base_prob": row["base_prob"],
                "served_prob": row["served_prob"], "hit": result["hit"], "brier": brier(row["served_prob"], result["hit"]),
                "log_loss": log_loss(row["served_prob"], result["hit"])})
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            reasons[str(exc) if isinstance(exc, ValueError) else "malformed_revision"] += 1
    return {"version": 1, "status": "supported_pinned_cohort" if rows else "unavailable_no_graded_cohort", "supported": True,
        "population": "eligible_pool", "as_of_utc": value["as_of_utc"], "snapshot_id": lr.fingerprint(snapshot),
        "pin_basis": "caller_supplied_snapshot_with_watermark_not_independently_verified" if snapshot.get("watermark") is not None else "local_frozen_content_copy_not_database_fence",
        "source_receipts": [sources[key] for key in sorted(sources)], "forecasts": forecasts, "rows": rows,
        "excluded": dict(sorted(reasons.items())), "n": len(rows), "capture_ids": sorted({c["manifest"]["capture_id"] for c in value["captures"]}),
        "raw_producer_excluded": capture_excluded,
        "source_code_sha256": {name: "sha256:" + hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
            ("scripts/pinned_cohort_oracle.py", "scripts/learning_receipts.py", "scripts/build_learning_outcomes.py",
             "scripts/capture_outcome_evidence.py", "scripts/resolve_my_cards.py", "scripts/resolve_parlay_legs.py")},
        "live_review_revision_integration": False, "source_authentication": "not_performed", "public_serving_verified": False}


def _unique(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate_json_key")
        out[key] = value
    return out


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("analysis_input_too_large")
        value = json.loads(raw, object_pairs_hook=_unique)
        print(json.dumps(oracle(value), sort_keys=True, ensure_ascii=True, allow_nan=False))
        return 0
    except (ValueError, TypeError, KeyError, OverflowError, OSError, AttributeError, RecursionError):
        print(json.dumps({"version": 1, "status": "invalid_or_unavailable_input", "supported": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
