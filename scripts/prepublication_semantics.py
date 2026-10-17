"""Pure, opt-in frozen MY-prop semantic report, NOT a release authorization.

Inputs are explicit JSON graphs, exact output bytes and caller expectations.
There are no loaders, clocks, environment reads, credentials, writes or network.
Expected identity equality is not proof of code execution or model adoption.
Missing raw producer/model authority and unsupported display vintages remain
unknown; no report from this bounded slice declares a whole release ready.
"""
import datetime as dt
import hashlib

from scripts import export_learning as ex, learning_receipts as lr
from scripts import publication_observations as publication
from scripts import validate_data as validators

KIND = "nfl.prepublication_semantics.v1"
SOURCE_NAMES = frozenset(("leg_pool", "schedule", "parlay_calibration"))
UPSTREAM_NAMES = frozenset(("player_weekly", "player_projections", "game_predictions", "pool_backtest"))
GRAPH_LIMIT = 32 * 1024 * 1024


class SemanticError(ValueError):
    """Static reason code only; rejected payload/error text is never returned."""


def _require(condition, reason):
    if not condition:
        raise SemanticError(reason)


def _clone(value, limit):
    raw = ex.encoded(value)
    _require(len(raw) <= limit, "input_graph_exceeds_bound")
    return ex._json(raw)


def _clock(value):
    result = lr.instant(value)
    _require(result is not None, "invalid_checked_clock")
    return result.astimezone(dt.timezone.utc)


def _request(value, kind):
    _require(isinstance(value, dict) and set(value) == {"version", "kind", "object_id", "payload"}
             and type(value["version"]) is int and value["version"] == 1 and value["kind"] == kind,
             "invalid_object_request")
    ex._hash(value["object_id"])
    _require(len(ex.encoded(value)) <= ex.MAX_BODY_BYTES, "object_request_exceeds_bound")


def _graph(value):
    graph = _clone(value, GRAPH_LIMIT)
    _require(isinstance(graph, dict) and set(graph) in ({"version", "source_objects", "generations"},
             {"version", "snapshot_dir", "source_objects", "generations"})
             and type(graph["version"]) is int and graph["version"] == 1
             and isinstance(graph["source_objects"], list) and len(graph["source_objects"]) <= 256
             and isinstance(graph["generations"], list) and len(graph["generations"]) <= 64,
             "invalid_frozen_graph")
    sources, generations = {}, {}
    for source in graph["source_objects"]:
        _request(source, "source_snapshot")
        _require(ex.fingerprint(source["payload"]) == source["object_id"], "source_content_hash_mismatch")
        sources[source["object_id"]] = source
    for entry in graph["generations"]:
        _require(isinstance(entry, dict) and set(entry) == {"request", "expected_receipt_ids"}, "invalid_generation_entry")
        request = entry["request"]
        _request(request, "generation")
        doc = request["payload"]
        _require(isinstance(doc, dict) and type(doc.get("version")) is int and doc["version"] == 1
                 and type(doc.get("season")) is int and type(doc.get("week")) is int and 1 <= doc["week"] <= 18
                 and isinstance(doc.get("generations"), list) and len(doc["generations"]) == 1
                 and isinstance(doc.get("receipts"), list) and len(doc["receipts"]) <= 8192,
                 "invalid_generation_envelope")
        envelope_id = ex._hash(doc.get("envelope_id"))
        _require(request["object_id"] == envelope_id
                 and ex.fingerprint({k: v for k, v in doc.items() if k != "envelope_id"}) == envelope_id,
                 "generation_envelope_hash_mismatch")
        generation = doc["generations"][0]
        _require(isinstance(generation, dict) and all(k in generation for k in ex.MANIFEST_KEYS), "invalid_generation_manifest")
        gid = ex._hash(generation.get("generation_id"))
        _require(ex.fingerprint({k: generation[k] for k in ex.MANIFEST_KEYS}) == gid
                 and type(generation.get("version")) is int and generation["version"] == 1
                 and type(generation.get("season")) is int and generation["season"] == doc["season"]
                 and type(generation.get("week")) is int and generation["week"] == doc["week"],
                 "generation_manifest_identity_mismatch")
        refs = generation["source_snapshots"]
        _require(isinstance(refs, dict) and set(refs) == SOURCE_NAMES
                 and all(ex._hash(digest) in sources for digest in refs.values()), "missing_frozen_source_reference")
        expected = generation.get("receipt_ids")
        _require(isinstance(expected, list) and len(set(expected)) == len(expected), "invalid_receipt_partition")
        rows = []
        for row in doc["receipts"]:
            _require(isinstance(row, dict) and isinstance(row.get("learning_receipt"), dict)
                     and row.get("generation_id") == gid and row.get("receipt_id") == row["learning_receipt"].get("receipt_id"),
                     "invalid_durable_receipt_reference")
            rows.append(ex._hash(row["receipt_id"]))
        _require(len(set(rows)) == len(rows) and set(rows) == set(expected)
                 and ex._same_json(sorted(expected), entry["expected_receipt_ids"]), "invalid_receipt_partition")
        if envelope_id in generations:
            _require(ex._same_json(generations[envelope_id], entry), "conflicting_generation_envelope")
        generations[envelope_id] = entry
    # Filesystem locations are not source authority and never enter the report.
    return {"version": 1, "source_objects": [sources[k] for k in sorted(sources)],
            "generations": [generations[k] for k in sorted(generations)]}


def _expectation(value):
    expected = _clone(value, 65536)
    keys = {"version", "season", "week", "target_generation_id", "target_envelope_id", "source_snapshots",
            "output_sha256", "base_model_version", "selection_policy_version", "joint_model_version", "code_revision_claim"}
    _require(isinstance(expected, dict) and set(expected) == keys and type(expected["version"]) is int and expected["version"] == 1
             and type(expected["season"]) is int and 2000 <= expected["season"] <= 2100
             and type(expected["week"]) is int and 1 <= expected["week"] <= 18,
             "invalid_expectation_contract")
    for key in ("target_generation_id", "target_envelope_id", "output_sha256", "selection_policy_version", "joint_model_version"):
        ex._hash(expected[key])
    _require(isinstance(expected["source_snapshots"], dict) and set(expected["source_snapshots"]) == SOURCE_NAMES,
             "invalid_expected_source_references")
    for digest in expected["source_snapshots"].values():
        ex._hash(digest)
    _require(all(isinstance(expected[k], str) and 0 < len(expected[k]) <= 256 for k in ("base_model_version", "code_revision_claim")),
             "invalid_expected_identity_claim")
    return expected


def _target(graph, expected, checked):
    docs = [item["request"]["payload"] for item in graph["generations"]
            if item["request"]["payload"]["generations"][0]["generation_id"] == expected["target_generation_id"]]
    _require(len(docs) == 1, "missing_or_ambiguous_target_generation")
    doc, = docs
    gen = doc["generations"][0]
    _require(doc["envelope_id"] == expected["target_envelope_id"] and (doc["season"], doc["week"]) == (expected["season"], expected["week"])
             and ex._same_json(gen["source_snapshots"], expected["source_snapshots"]), "target_authority_or_source_mismatch")
    _require(all(ex._same_json(gen[k], expected[k]) for k in ("selection_policy_version", "joint_model_version")),
             "expected_policy_claim_mismatch")
    _require(_clock(gen["recorded_utc"]) <= checked, "target_capture_after_checked_clock")
    sources = {item["object_id"]: item["payload"] for item in graph["source_objects"]}
    pool = sources[gen["source_snapshots"]["leg_pool"]]
    _require(ex._same_json(pool.get("base_model_version"), expected["base_model_version"]), "expected_model_claim_mismatch")
    for row in doc["receipts"]:
        receipt = row["learning_receipt"]
        ex._hash(receipt.get("source_snapshot_id"))
        _require(ex._same_json(receipt.get("base_model_version"), expected["base_model_version"])
                 and ex._same_json(receipt.get("generation_sha"), expected["code_revision_claim"]), "expected_model_or_code_claim_mismatch")
        _require(checked < _clock(row["kickoff_utc"]), "target_event_started_at_checked_clock")
    return doc, pool


def _membership(output, authority, target_id, season, week, target_recorded, checked, *, retained_unknown=None):
    _require(isinstance(output, dict) and type(output.get("season")) is int and output["season"] == season
             and type(output.get("week")) is int and output["week"] == week, "output_period_mismatch")
    members, unsupported, seen = [], [], set()
    if "cards" not in output:
        return [], [{"reason": "unsupported_output_family"}]
    _require(isinstance(output["cards"], list), "invalid_output_cards")
    for card in output["cards"]:
        _require(isinstance(card, dict) and isinstance(card.get("card_id"), str) and card["card_id"] and card["card_id"] not in seen
                 and isinstance(card.get("legs"), list) and card["legs"]
                 and ("n_legs" not in card or (type(card["n_legs"]) is int and card["n_legs"] == len(card["legs"]))),
                 "invalid_or_duplicate_output_card")
        seen.add(card["card_id"])
        for index, leg in enumerate(card["legs"]):
            location = {"card_id": card["card_id"], "leg_index": index}
            _require(isinstance(leg, dict), "invalid_output_leg")
            if leg.get("market") not in lr.PROP_MARKETS or leg.get("learning_receipt") is None:
                unsupported.append({**location, "reason": "unsupported_market_or_missing_original_receipt"})
                continue
            receipt = leg["learning_receipt"]
            _require(lr.receipt_problem(receipt, leg, season, week) is None
                     and all(ex._same_json(leg.get(k), receipt.get(k)) for k in ("season", "direction", "comparison_operator")),
                     "output_receipt_identity_or_serving_mismatch")
            rid = receipt["receipt_id"]
            known = authority.get(rid, [])
            if not known and retained_unknown is not None:
                old = retained_unknown['cards'].get(card['card_id'])
                allowed = (card['card_id'], index, rid) in retained_unknown['locations']
                if allowed and old is not None and ex._same_json(card, old):
                    unsupported.append({**location, 'reason': 'retained_prejournal_vintage_unverified',
                        'source_receipt_id': rid})
                    continue
            _require(known and all(ex._same_json(receipt, row["source"]) for row in known), "output_receipt_missing_or_conflicting_authority")
            matched = {row["lineage"]["generation_id"]: row for row in known if rid in row["offered"].get(card["card_id"], set())}
            _require(matched, "output_receipt_not_offered_for_card")
            if len(matched) != 1:
                unsupported.append({**location, "reason": "ambiguous_generation_membership", "source_receipt_id": rid})
                continue
            generation_id, row = next(iter(matched.items()))
            recorded = _clock(row["recorded_utc"])
            _require(recorded <= checked, "output_vintage_after_checked_clock")
            members.append({**location, "source_receipt_id": rid, "contract_id": receipt["contract_id"],
                "generation_id": generation_id, "envelope_id": row["lineage"]["envelope_id"],
                "selection_policy_version_claim": row["lineage"]["selection_policy_version"],
                "joint_model_version_claim": row["lineage"]["joint_model_version"],
                "source_snapshots": row["lineage"]["source_snapshots"],
                "lineage_class": "target_generation" if generation_id == target_id else
                    "retained_older_display_vintage" if recorded < target_recorded else "non_target_newer_or_unordered_vintage"})
    return members, unsupported


def _upstream(bundle, target, pool, output, members):
    if bundle is None:
        return None, "unknown", "missing_frozen_upstream_consumer_bundle", None
    bundle = _clone(bundle, GRAPH_LIMIT)
    _require(isinstance(bundle, dict) and set(bundle) == {"version", "documents"} and type(bundle["version"]) is int and bundle["version"] == 1
             and isinstance(bundle["documents"], dict) and set(bundle["documents"]) == UPSTREAM_NAMES
             and all(isinstance(doc, dict) for doc in bundle["documents"].values()), "invalid_frozen_upstream_bundle")
    docs = bundle["documents"]
    digest = ex.fingerprint(docs)
    if not target["receipts"]:
        return digest, "unknown", "no_target_receipt_upstream_binding", None
    clocks = {name: doc.get("generated_utc") or doc.get("updated_utc") for name, doc in docs.items()}
    for row in target["receipts"]:
        receipt = row["learning_receipt"]
        _require(receipt["source_snapshot_id"] == digest, "upstream_content_not_bound_to_receipt")
        _require(ex._same_json(receipt["source_timestamps"], clocks), "upstream_source_clock_mismatch")
    weekly = docs["player_weekly"]
    if not isinstance((weekly.get("model") or {}).get("this_week"), dict):
        return digest, "unknown", "missing_frozen_weekly_eligibility_metadata", None
    period = weekly["model"]["this_week"].get("wk")
    if period is None:
        return digest, "unknown", "missing_frozen_weekly_period", None
    _require(type(period) is int and period == target["week"], "frozen_upstream_week_mismatch")
    rows = weekly.get("players") or []
    _require(isinstance(rows, list), "invalid_frozen_weekly_rows")
    known = {}
    for row in rows:
        _require(isinstance(row, dict), "invalid_frozen_weekly_rows")
        pid = row.get("gsis_id")
        if pid in known:
            _require(ex._same_json(known[pid], row), "ambiguous_frozen_weekly_player")
        known[pid] = row
    unknown = 0
    for player in pool["players"]:
        row = known.get(player.get("gsis_id")) or {}
        played = row.get("this_week") or {}
        weeks = row.get("weeks") or []
        _require(isinstance(played, dict) and isinstance(weeks, list) and all(isinstance(w, dict) for w in weeks),
                 "invalid_frozen_weekly_player_metadata")
        current = [w for w in weeks if type(w.get("wk")) is int and w["wk"] == target["week"]]
        _require(len({ex.fingerprint(w) for w in current}) <= 1, "conflicting_frozen_player_week_rows")
        if not (type(played.get("playable")) is bool and len(current) == 1 and type(current[0].get("avail")) is bool):
            unknown += 1
    # The legacy checker treats absent per-player metadata as no negative. Do
    # not turn that into a PASS. Still check every present row, including an
    # explicit refusal beside an unknown neighbor; absence remains row-local.
    # R77's parlays argument is a LIVE-card contract, not the closed MY archive
    # schema: archives intentionally lack a top-level Q annotation. _authority
    # and _membership already bind each supported archive prop's exact original
    # receipt/contract/probability to its own frozen pool and offered generation.
    # Check that pool, never invent archive labels or borrow a newer vintage.
    present = {p.get("gsis_id") for p in pool["players"] if p.get("gsis_id") in known}
    scoped_pool = {**pool, "players": [p for p in pool["players"] if p.get("gsis_id") in present], "atd_legs": []}
    try:
        validators.check_no_unplayable_legs(weekly, {"week": target["week"], "parlays": []}, scoped_pool)
    except validators.ValidationError:
        raise SemanticError("frozen_eligibility_validation_failed") from None
    coverage = {"pool_players": len(pool["players"]), "unknown_players": unknown, "known_metadata_players": len(pool["players"]) - unknown}
    return (digest, "unknown" if unknown else "pass",
            "missing_per_player_eligibility_evidence" if unknown else "content_bound_frozen_consumer_eligibility_only", coverage)


def verify_candidate(graph, output_bytes, expectation, *, checked_utc, frozen_inputs=None):
    """Return a sealed diagnostic; no partial success on invalid evidence.

The supplied clock/expected identities are caller claims. Hash checks establish
content/reference integrity, not signatures, actual execution or public serving.
"""
    report = {"version": 1, "kind": KIND, "status": "failed", "release_ready": False,
        "consumer_checks_passed": False, "checked_utc_claim": None, "input_ids": {}, "checks": [],
        "membership": [], "unsupported": [], "failures": [],
        "scope": "exact supported target-generation MY yardage props only; not whole cards, joint prices, Game/Week/ATD or a full release",
        "consumer_check_scope": "receipt identity, captured features/context, once-serving and target-card membership; excludes unknown upstream/model/code authority",
        "eligibility_check_scope": "exact target-generation frozen pool consumer eligibility only; MY archive Q annotations are outside its schema; live Q rendering is not checked; non-target vintages are not checked",
        "original_receipts_mutated": False, "network_used": False, "writes": False}
    try:
        checked = _clock(checked_utc)
        report["checked_utc_claim"] = checked.isoformat().replace("+00:00", "Z")
        expected = _expectation(expectation)
        report["input_ids"]["expectation_id"] = ex.fingerprint(expected)
        _require(isinstance(output_bytes, bytes) and 0 < len(output_bytes) <= publication.MAX_BYTES, "invalid_or_oversized_output_bytes")
        output_id = "sha256:" + hashlib.sha256(output_bytes).hexdigest()
        report["input_ids"]["output_sha256"] = output_id
        _require(output_id == expected["output_sha256"], "exact_output_bytes_mismatch")
        output = ex._json(output_bytes)
        frozen = _graph(graph)
        report["input_ids"]["graph_id"] = ex.fingerprint(frozen)
        report["checks"].append({"name": "content_graph_integrity", "status": "pass", "authority": "canonical content hashes, not signatures"})
        try:
            authority = publication._authority(frozen, expected["season"], expected["week"])
        except publication.PublicationError:
            raise SemanticError("invalid_durable_consumer_authority") from None
        target, pool = _target(frozen, expected, checked)
        report["input_ids"].update(generation_id=expected["target_generation_id"], envelope_id=expected["target_envelope_id"])
        report["checks"].append({"name": "expected_model_policy_code_identity", "status": "pass", "authority": "caller-claim equality only; not proven execution/adoption"})
        report["checks"].append({"name": "frozen_receipt_event_and_once_serving", "status": "pass", "authority": "captured consumer contracts/features/context only"})
        members, unsupported = _membership(output, authority, expected["target_generation_id"], expected["season"], expected["week"],
                                           _clock(target["generations"][0]["recorded_utc"]), checked)
        upstream_id, eligibility_status, eligibility_basis, eligibility_coverage = _upstream(frozen_inputs, target, pool, output, members)
        report["input_ids"]["upstream_consumer_bundle_id"] = upstream_id
        target_members = sum(m["lineage_class"] == "target_generation" for m in members)
        non_target = len(members) - target_members
        retained = sum(m["lineage_class"] == "retained_older_display_vintage" for m in members)
        report.update(membership=members, unsupported=unsupported,
            coverage={"target_prop_legs": target_members, "retained_vintage_prop_legs": retained,
                      "other_non_target_vintage_prop_legs": non_target - retained, "unsupported_locations": len(unsupported)},
            upstream_eligibility_coverage=eligibility_coverage,
            consumer_checks_passed=target_members > 0, status="incomplete")
        report["checks"].extend([
            {"name": "supported_target_output_membership", "status": "pass" if target_members else "unknown", "authority": "exact original receipt/card mappings; no generated-pool publication inference"},
            {"name": "upstream_consumer_eligibility", "status": eligibility_status, "reason": eligibility_basis,
             "authority": report["eligibility_check_scope"]},
            {"name": "unsupported_output_or_retained_vintages", "status": "unknown" if non_target or unsupported else "pass", "authority": "non-target lineage retained; not promoted to target-generation freshness/policy"},
            {"name": "generation_capture_completeness", "status": "unknown", "reason": "quarantine_and_full_candidate_population_not_independently_rebuilt"},
            {"name": "raw_provider_freshness", "status": "unknown", "reason": "raw_provider_capture_not_bound_by_this_journal_contract"},
            {"name": "base_model_training_and_code_execution_authority", "status": "unknown", "reason": "version_claims_are_not_frozen_code_or_adoption_evidence"},
            {"name": "public_serving_or_deployment_identity", "status": "unknown", "reason": "prepublication_diagnostic_not_public_observation"}])
    except (SemanticError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as exc:
        reason = str(exc) if isinstance(exc, SemanticError) else "malformed_semantic_evidence"
        report.update(status="failed", consumer_checks_passed=False, membership=[], unsupported=[])
        report["failures"] = [{"reason": reason}]
    report["report_id"] = ex.fingerprint(report)
    return report
