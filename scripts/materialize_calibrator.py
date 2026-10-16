"""Opt-in, pure calibration-return DRAFTS; never approval or NFL activation.

The callback is explicitly trusted application code, not a JSON field, URL or
uploaded authentication flag. This local mechanism checks the supplied complete
owner-intent CLAIM and content pins. It does NOT authenticate an owner, query an
approval store, sign events, re-execute an evaluation or change R100/serving.
Existing engine candidates remain retrospective shadow reconstructions.
"""
import datetime as dt
import json
import math
import re

from scripts import learning_receipts as receipts

MAX_BYTES, MAX_ROWS, MAX_EVENTS, MAX_PRIOR = 32 * 1024 * 1024, 10000, 256, 64
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
KIND = "nfl.my_props.base_logit.v1"
TASK = "nfl.parlay_leg"
TRANSFORM = {"name": "sigmoid_intercept_plus_slope_logit", "input_stage": "immutable_base_prob",
    "input_clip": [.0001, .9999], "output_stage": "served_prob", "output_clamp": [.05, .95],
    "output_decimals": 4, "coefficient_decimals": 6}
EVALUATION_KIND = "refitting_policy_walk_forward_not_fixed_artifact_prospective_validation"
NAMESPACE = {"domain": "nfl", "task": TASK, "producer_id": "nfl2026"}
FLAGS = {"owner_authorization_verified": False, "release_authorized": False,
    "serving_changed": False, "model_adoption": False, "working_learning_loop": False}
TRAINING_ROW = set("receipt_id source_receipt_id contract_id event_id correlation_group season week position base_prob served_prob hit forecast_created_utc event_start_utc first_seen_utc base_model_version revision_id revision_hash outcome_recorded_utc resolved_utc".split())
EVENT_KEYS = set("version kind sequence previous_event_id action season weeks markets target_candidate_id target_artifact_id evaluation_report_id policy_id generation_context_id expected_previous_current_id evidence_status_acknowledged reason actor_ref recorded_utc effective_from_utc expires_utc event_id".split())
DRAFT_KEYS = set("version kind status artifact_id candidate_id candidate_evidence_status evaluation_report_id evaluation_policy_id base_model_version receipt_policy transform coefficients calibrator_version context_id forecast_created_utc owner_event_id owner_snapshot_id owner_head_id previous_current_id rollback_from_artifact_id source_code_pins authority_basis evaluation_basis owner_authorization_verified release_authorized serving_changed model_adoption working_learning_loop materialization_id".split())


class MaterializationError(ValueError):
    """Static local codes; no callback diagnostics or input text are returned."""


def need(value, reason="invalid_materialization_input"):
    if not value:
        raise MaterializationError(reason)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _copy(value):
    nodes, used = 0, 0
    def visit(item, depth):
        nonlocal nodes, used
        nodes += 1
        need(nodes <= 500000 and depth <= 24, "materialization_work_limit")
        kind = type(item)
        if kind is dict:
            need(all(type(k) is str for k in item))
            used += 2 + max(0, len(item) - 1)
            result = {}
            for key, value in item.items():
                visit(key, depth + 1);used += 1;result[key] = visit(value, depth + 1)
        elif kind is list:
            used += 2 + max(0, len(item) - 1)
            result = [visit(v, depth + 1) for v in item]
        else:
            need(kind in (str, int, float, bool) or item is None)
            need(not (kind is str and (len(item) > 1024 * 1024 or len(item) > MAX_BYTES - used)
                      or kind is int and item.bit_length() > 1024 or kind is float and not math.isfinite(item)), "materialization_work_limit")
            used += len(encoded(item));result = item
        need(used <= MAX_BYTES, "materialization_work_limit")
        return result
    result = visit(value, 0)
    need(len(encoded(result)) <= MAX_BYTES, "materialization_work_limit")
    return result


def keys(value, expected):
    need(type(value) is dict and set(value) == set(expected))


def integer(value, low, high):
    need(type(value) is int and low <= value <= high)


def digest(value):
    need(type(value) is str and HASH.fullmatch(value))


def instant(value):
    result = receipts.instant(value)
    need(type(value) is str and result is not None, "invalid_materialization_clock")
    return result


def text(value, maximum=200):
    need(type(value) is str and 0 < len(value) <= maximum and value.strip())


def sealed(value, field):
    return {**value, field: receipts.fingerprint(value)}


def hashed(value, field):
    digest(value[field])
    need(value[field] == receipts.fingerprint({k: v for k, v in value.items() if k != field}), "materialization_hash_mismatch")


def same(left, right):
    need(encoded(left) == encoded(right), "materialization_pin_mismatch")


def coefficients(value):
    keys(value, {"a", "b"})
    need(all(receipts.finite_number(v) and round(v, 6) == v for v in value.values()) and value["b"] > 0,
         "incompatible_calibrator_coefficients")


def validate_candidate(value):
    """Independent NFL contract validator; never import the engine's fitter."""
    keys(value, set("version kind task state automatic_promotion evidence_status receipt_policy base_model_version transform coefficients fit_as_of_utc training candidate_id".split()))
    need(type(value["version"]) is int and value["version"] == 1 and value["kind"] == KIND
         and value["task"] == TASK and value["state"] == "shadow" and value["automatic_promotion"] is False
         and value["evidence_status"] == "retrospective_reconstruction" and value["receipt_policy"] == receipts.POLICY,
         "incompatible_candidate")
    same(value["transform"], TRANSFORM);digest(value["base_model_version"]);coefficients(value["coefficients"])
    training = value["training"]
    keys(training, set("population membership_policy cutoff_utc n fit_rule ridge dataset_id rows".split()))
    need(training["population"] in ("eligible_pool", "offered_my")
         and training["membership_policy"] in ("first_envelope_capture_v1", "committed_generations_v1")
         and training["fit_rule"] == "ridge_newton_logit_base_v1" and type(training["ridge"]) is float and training["ridge"] == .001,
         "incompatible_training_policy")
    integer(training["n"], 100, MAX_ROWS)
    need(type(training["rows"]) is list and len(training["rows"]) == training["n"])
    cutoff = instant(training["cutoff_utc"])
    need(cutoff == instant(value["fit_as_of_utc"]))
    need(training["dataset_id"] == receipts.fingerprint(training["rows"]), "materialization_hash_mismatch")
    contracts, receipt_ids, source_ids = [], set(), set()
    offered = training["population"] == "offered_my" and training["membership_policy"] == "committed_generations_v1"
    for row in training["rows"]:
        keys(row, TRAINING_ROW | ({"offering"} if offered else set()))
        for name in ("receipt_id", "source_receipt_id", "contract_id", "revision_hash"):
            digest(row[name])
        integer(row["season"], 2000, 2100);integer(row["week"], 1, 18);text(row["revision_id"])
        prefix = "nfl:%s:game:" % row["season"]
        need(type(row["event_id"]) is str and row["event_id"].startswith(prefix) and 0 < len(row["event_id"][len(prefix):]) <= 200
             and row["correlation_group"] == row["event_id"] and row["position"] in ("QB", "RB", "WR")
             and row["base_model_version"] == value["base_model_version"] and receipts.finite_number(row["base_prob"])
             and 0 < row["base_prob"] < 1 and receipts.finite_number(row["served_prob"]) and 0 <= row["served_prob"] <= 1
             and type(row["hit"]) is bool)
        created, seen, start, resolved, recorded = [instant(row[k]) for k in
            ("forecast_created_utc", "first_seen_utc", "event_start_utc", "resolved_utc", "outcome_recorded_utc")]
        need(created <= seen < start <= resolved <= recorded < cutoff, "invalid_training_chronology")
        need(row["receipt_id"] not in receipt_ids and row["source_receipt_id"] not in source_ids, "duplicate_training_identity")
        receipt_ids.add(row["receipt_id"]);source_ids.add(row["source_receipt_id"]);contracts.append(row["contract_id"])
        if offered:
            offer = row["offering"];keys(offer, {"object_id", "generation_id", "captured_utc", "recorded_utc", "card_ids"})
            digest(offer["object_id"]);digest(offer["generation_id"])
            need(type(offer["card_ids"]) is list and offer["card_ids"] and len(offer["card_ids"]) <= MAX_ROWS
                 and len(set(offer["card_ids"])) == len(offer["card_ids"]))
            for card in offer["card_ids"]:text(card)
            need(created <= instant(offer["captured_utc"]) < start and instant(offer["captured_utc"]) <= instant(offer["recorded_utc"]) < cutoff)
    need(len(set(contracts)) == len(contracts), "duplicate_training_identity")
    hashed(value, "candidate_id")


def evaluation_policy_id(report):
    """Pin the proposed shared policy; do not claim it is the current R100 rule."""
    return receipts.fingerprint({"evaluation_kind": report["evaluation_kind"],
        "shared_gate": {k: v for k, v in report["shared_shadow_numeric_gate"].items() if k not in ("passed", "failures")},
        "proposed_gate": {k: v for k, v in report["proposed_shared_return_gate"].items() if k not in ("passed", "failures")},
        "current_nfl_rules_reference": report["current_nfl_rules_reference"]})


def _report(report, candidate):
    need(type(report) is dict and type(report.get("version")) is int and report["version"] == 1
         and report.get("kind") == "nfl.my_props.walk_forward.v1" and report.get("evaluation_kind") == EVALUATION_KIND
         and report.get("automatic_promotion") is False and report.get("public_serving_verified") is False,
         "incompatible_evaluation_report")
    hashed(report, "report_id");same(report["candidate"], candidate)
    need(instant(report["as_of_utc"]) == instant(candidate["fit_as_of_utc"])
         and report["population"] == candidate["training"]["population"]
         and report["membership_policy"] == candidate["training"]["membership_policy"]
         and report["cohort_n"] == candidate["training"]["n"]
         and type(report["cohort_n"]) is int and report["cohort_id"] == candidate["training"]["dataset_id"])
    for name in ("shared_shadow_numeric_gate", "proposed_shared_return_gate"):
        gate = report[name]
        need(type(gate) is dict and gate.get("passed") is True and gate.get("failures") == [], "evaluation_gate_held")
    need(report["proposed_shared_return_gate"].get("additional_margin") == .0015
         and type(report["proposed_shared_return_gate"]["additional_margin"]) is float,
         "unreviewed_evaluation_policy")
    metrics = report["metrics"];integer(metrics["n"], 1, MAX_ROWS)
    for key in ("incumbent_log_loss", "candidate_log_loss", "base_log_loss", "delta_log_loss"):
        need(receipts.finite_number(metrics[key]))
        if key != "delta_log_loss":need(metrics[key] >= 0, "evaluation_gate_held")
    need(metrics["candidate_log_loss"] < min(metrics["incumbent_log_loss"], metrics["base_log_loss"])
         and metrics["delta_log_loss"] < -.0015
         and math.isclose(metrics["delta_log_loss"], metrics["candidate_log_loss"] - metrics["incumbent_log_loss"], abs_tol=1e-12, rel_tol=1e-12),
         "evaluation_gate_held")
    keys(report["per_position"], {"QB", "RB", "WR"})
    for metrics in report["per_position"].values():
        integer(metrics["n"], 1, MAX_ROWS)
        need(receipts.finite_number(metrics["delta_log_loss"]) and metrics["delta_log_loss"] <= 0, "evaluation_gate_held")
        for key in ("incumbent_log_loss", "candidate_log_loss", "base_log_loss"):
            if key in metrics:
                need(receipts.finite_number(metrics[key]) and metrics[key] >= 0, "evaluation_gate_held")
    ci = report["paired_game_interval"]
    need(all(receipts.finite_number(ci.get(k)) for k in ("low", "high")) and ci["low"] <= ci["high"] < 0,
         "evaluation_gate_held")
    scored = [fold for fold in report["folds"] if fold.get("status") == "scored"]
    need(len(scored) >= 2 and not any(fold.get("status") == "held" for fold in report["folds"]), "evaluation_gate_held")
    for fold in scored:
        need(all(receipts.finite_number(fold.get(k)) and fold[k] >= 0 for k in ("candidate_log_loss", "base_log_loss", "incumbent_log_loss"))
             and fold["candidate_log_loss"] <= min(fold["base_log_loss"], fold["incumbent_log_loss"]), "evaluation_gate_held")
    return evaluation_policy_id(report)


def artifact_id(candidate):
    return receipts.fingerprint({"version": 1, "kind": "nfl.calibrator_artifact.v1", "candidate_id": candidate["candidate_id"],
        **{k: candidate[k] for k in ("base_model_version", "receipt_policy", "transform", "coefficients")}})


def current_pin(base_model_version, adjustment=None, *, artifact=None, materialization=None):
    """Seal a CALLER CLAIM about the incumbent; not a serving-store read."""
    digest(base_model_version)
    if adjustment is not None:coefficients(adjustment)
    need((artifact is None) == (materialization is None))
    if artifact is not None:digest(artifact);digest(materialization)
    return sealed({"version": 1, "kind": "nfl.current_calibrator_claim.v1", "base_model_version": base_model_version,
        "adjustment": dict(adjustment) if adjustment is not None else None, "calibrator_version": receipts.fingerprint(adjustment),
        "artifact_id": artifact, "materialization_id": materialization}, "current_id")


def _prior(draft):
    keys(draft, DRAFT_KEYS);hashed(draft, "materialization_id")
    need(type(draft["version"]) is int and draft["version"] == 1 and draft["kind"] == "nfl.calibrator_materialization_draft.v1"
         and draft["status"] == "not_active" and all(draft[k] is False for k in FLAGS)
         and draft["candidate_evidence_status"] == "retrospective_reconstruction"
         and draft["authority_basis"] == "supplied_claim_from_trusted_callback"
         and draft["evaluation_basis"] == "hash_bound_supplied_report_not_reexecuted")
    same(draft["transform"], TRANSFORM);coefficients(draft["coefficients"])
    for name in ("candidate_id", "evaluation_report_id", "evaluation_policy_id", "base_model_version", "context_id", "owner_event_id",
                 "owner_snapshot_id", "owner_head_id", "previous_current_id"):
        digest(draft[name])
    need(draft["receipt_policy"] == receipts.POLICY and draft["calibrator_version"] == receipts.fingerprint(draft["coefficients"])
         and draft["artifact_id"] == artifact_id(draft))
    keys(draft["source_code_pins"], {"nfl_code_id", "engine_code_id"})
    for value in draft["source_code_pins"].values():digest(value)
    if draft["rollback_from_artifact_id"] is not None:digest(draft["rollback_from_artifact_id"])
    instant(draft["forecast_created_utc"])


def _authority(snapshot, query, context, policy, now, known):
    keys(snapshot, {"version", "kind", "namespace", "complete", "events", "head_sequence", "head_event_id", "observed_utc", "expires_utc", "snapshot_id"})
    need(type(snapshot["version"]) is int and snapshot["version"] == 1 and snapshot["kind"] == "selflearn.owner_intent_snapshot_claim.v1"
         and snapshot["complete"] is True and encoded(snapshot["namespace"]) == encoded(NAMESPACE), "incomplete_owner_head")
    hashed(snapshot, "snapshot_id")
    seen = instant(snapshot["observed_utc"])
    need(seen <= now <= instant(snapshot["expires_utc"]) and (now - seen).total_seconds() <= policy["max_authority_age_seconds"], "stale_owner_head")
    need(type(snapshot["events"]) is list and 1 <= len(snapshot["events"]) <= MAX_EVENTS, "incomplete_owner_head")
    integer(snapshot["head_sequence"], 1, MAX_EVENTS)
    need(snapshot["head_sequence"] == len(snapshot["events"]), "incomplete_owner_head")
    previous, previous_recorded, approved, revoked = None, None, set(), set()
    for index, event in enumerate(snapshot["events"], 1):
        keys(event, EVENT_KEYS);hashed(event, "event_id")
        need(type(event["version"]) is int and event["version"] == 1 and event["kind"] == "selflearn.owner_calibrator_intent.v1"
             and type(event["sequence"]) is int and event["sequence"] == index and event["previous_event_id"] == previous, "incomplete_owner_head")
        previous = event["event_id"]
        for name in ("target_candidate_id", "target_artifact_id", "evaluation_report_id", "policy_id", "generation_context_id", "expected_previous_current_id"):
            digest(event[name])
        integer(event["season"], 2000, 2100)
        need(type(event["weeks"]) is list and event["weeks"] and event["weeks"] == sorted(set(event["weeks"])))
        for week in event["weeks"]:integer(week, 1, 18)
        same(event["markets"], ["qb_pass_yds", "rb_rush_yds", "wr_rec_yds"])
        need(event["evidence_status_acknowledged"] == "retrospective_reconstruction", "incompatible_owner_intent")
        text(event["reason"]);text(event["actor_ref"])
        recorded = instant(event["recorded_utc"])
        need((previous_recorded is None or previous_recorded <= recorded) and recorded <= seen
             and recorded <= instant(event["effective_from_utc"]) < instant(event["expires_utc"]), "invalid_owner_event_chronology")
        previous_recorded = recorded
        action, target = event["action"], event["target_artifact_id"]
        need(action in ("approve", "revoke", "rollback"))
        if action == "approve":approved.add(target);revoked.discard(target)
        elif action == "revoke":revoked.add(target)
        else:need(target in approved and target not in revoked and target in known, "rollback_target_unavailable")
    need(snapshot["head_event_id"] == previous, "incomplete_owner_head")
    event_ids = {event["event_id"] for event in snapshot["events"]}
    need(all(prior["owner_event_id"] in event_ids and prior["owner_head_id"] in event_ids
             for values in known.values() for prior in values), "incomplete_owner_head")
    event = snapshot["events"][-1]
    need(query["artifact_id"] not in revoked, "artifact_revoked")
    need(event["action"] in ("approve", "rollback") and event["target_candidate_id"] == query["candidate_id"]
         and event["target_artifact_id"] == query["artifact_id"] and event["evaluation_report_id"] == query["evaluation_report_id"]
         and event["policy_id"] == policy["policy_id"] and event["generation_context_id"] == context["context_id"]
         and event["expected_previous_current_id"] == query["current_id"] and event["season"] == context["season"]
         and context["week"] in event["weeks"], "owner_intent_pin_mismatch")
    need(instant(query["candidate_fit_asof_utc"]) <= instant(event["recorded_utc"]), "owner_intent_before_evidence")
    need(instant(event["effective_from_utc"]) <= instant(context["forecast_created_utc"]) < instant(event["expires_utc"]), "owner_intent_not_effective")
    if event["action"] == "rollback":
        need(any(prior["candidate_id"] == query["candidate_id"] and prior["evaluation_report_id"] == query["evaluation_report_id"]
                 and prior["base_model_version"] == context["base_model_version"] for prior in known[query["artifact_id"]]), "rollback_target_incompatible")
    return event


def materialize(candidate, report, context, current, policy, *, authority_reader=None,
                prior_materializations=(), issued_receipts=(), now_utc):
    """Return a held decision or a NON-ACTIVE draft; never write or call URLs.

    The configured callback belongs to the local application's trust boundary.
    Its response still remains a supplied claim here, not proof of real owner
    approval. Inputs/old forecasts are copied and never rewritten.
    """
    held = {"version": 1, "kind": "nfl.calibrator_materialization_decision.v1", "status": "held", "draft": None,
        "reason_codes": [], "authority_basis": "unavailable", "current_serving_basis": "supplied_claim_not_requeried",
        "network_implemented_by_materializer": False, "writes_implemented_by_materializer": False,
        "authority_reader_io": "not_observed", **FLAGS}
    try:
        need(type(prior_materializations) in (list, tuple) and len(prior_materializations) <= MAX_PRIOR
             and type(issued_receipts) in (list, tuple) and len(issued_receipts) <= MAX_ROWS, "materialization_work_limit")
        inputs = _copy([candidate, report, context, current, policy, list(prior_materializations), list(issued_receipts)])
        candidate, report, context, current, policy, prior_materializations, issued_receipts = inputs
        now = instant(now_utc);validate_candidate(candidate);evaluation_id = _report(report, candidate)
        keys(policy, set("version kind base_model_version nfl_code_id engine_code_id evaluation_policy_id max_candidate_age_seconds max_authority_age_seconds policy_id".split()))
        need(type(policy["version"]) is int and policy["version"] == 1 and policy["kind"] == "nfl.calibrator_materializer_policy.v1")
        hashed(policy, "policy_id");integer(policy["max_candidate_age_seconds"], 1, 90 * 86400);integer(policy["max_authority_age_seconds"], 1, 3600)
        for name in ("base_model_version", "nfl_code_id", "engine_code_id", "evaluation_policy_id"):digest(policy[name])
        keys(context, set("version kind season week forecast_created_utc first_kickoff_utc base_model_version source_snapshot_id nfl_code_id engine_code_id context_id".split()))
        need(type(context["version"]) is int and context["version"] == 1 and context["kind"] == "nfl.future_generation_context.v1")
        hashed(context, "context_id");integer(context["season"], 2000, 2100);integer(context["week"], 1, 18);digest(context["source_snapshot_id"])
        created = instant(context["forecast_created_utc"])
        need(now <= created < instant(context["first_kickoff_utc"]), "generation_not_future")
        need(instant(candidate["fit_as_of_utc"]) <= now and (now - instant(candidate["fit_as_of_utc"])).total_seconds() <= policy["max_candidate_age_seconds"], "stale_candidate")
        need(candidate["base_model_version"] == context["base_model_version"] == policy["base_model_version"]
             and evaluation_id == policy["evaluation_policy_id"] and all(context[k] == policy[k] for k in ("nfl_code_id", "engine_code_id")), "incompatible_generation_pins")
        keys(current, set("version kind base_model_version adjustment calibrator_version artifact_id materialization_id current_id".split()))
        same(current, current_pin(current["base_model_version"], current["adjustment"], artifact=current["artifact_id"], materialization=current["materialization_id"]))
        need(current["base_model_version"] == context["base_model_version"], "incompatible_current_base")
        known, materializations = {}, {}
        for prior in prior_materializations:
            _prior(prior)
            mid = prior["materialization_id"]
            need(mid not in materializations or encoded(materializations[mid]) == encoded(prior), "conflicting_prior_materialization")
            if mid not in materializations:known.setdefault(prior["artifact_id"], []).append(prior)
            materializations[mid] = prior
        if current["artifact_id"] is not None:
            need(current["materialization_id"] in materializations and materializations[current["materialization_id"]]["artifact_id"] == current["artifact_id"]
                 and encoded(materializations[current["materialization_id"]]["coefficients"]) == encoded(current["adjustment"]), "unknown_current_materialization")
        for receipt in issued_receipts:
            need(type(receipt) is dict and receipts.receipt_problem(receipt, {**receipt, "model_prob": receipt.get("served_prob")}, receipt.get("season"), receipt.get("week")) is None,
                 "invalid_issued_receipt")
            need(instant(receipt["forecast_created_utc"]) < created, "generation_already_issued")
        need(authority_reader is None or callable(authority_reader), "invalid_authority_reader")
        if authority_reader is None:raise MaterializationError("owner_authority_unavailable")
        query = {"version": 1, "namespace": dict(NAMESPACE), "candidate_id": candidate["candidate_id"], "artifact_id": artifact_id(candidate),
            "evaluation_report_id": report["report_id"], "candidate_fit_asof_utc": candidate["fit_as_of_utc"],
            "policy_id": policy["policy_id"], "context_id": context["context_id"], "current_id": current["current_id"]}
        try:snapshot = _copy(authority_reader(_copy(query)))
        except Exception:raise MaterializationError("owner_authority_unavailable") from None
        event = _authority(snapshot, query, context, policy, now, known)
        draft = sealed({"version": 1, "kind": "nfl.calibrator_materialization_draft.v1", "status": "not_active",
            "artifact_id": query["artifact_id"], "candidate_id": candidate["candidate_id"], "candidate_evidence_status": candidate["evidence_status"],
            "evaluation_report_id": report["report_id"], "evaluation_policy_id": evaluation_id, "base_model_version": candidate["base_model_version"],
            "receipt_policy": receipts.POLICY, "transform": TRANSFORM, "coefficients": candidate["coefficients"],
            "calibrator_version": receipts.fingerprint(candidate["coefficients"]), "context_id": context["context_id"],
            "forecast_created_utc": context["forecast_created_utc"], "owner_event_id": event["event_id"], "owner_snapshot_id": snapshot["snapshot_id"],
            "owner_head_id": snapshot["head_event_id"], "previous_current_id": current["current_id"],
            "rollback_from_artifact_id": current["artifact_id"] if event["action"] == "rollback" else None,
            "source_code_pins": {k: context[k] for k in ("nfl_code_id", "engine_code_id")},
            "authority_basis": "supplied_claim_from_trusted_callback", "evaluation_basis": "hash_bound_supplied_report_not_reexecuted", **FLAGS}, "materialization_id")
        return {**held, "status": "materialized_draft", "draft": _copy(draft), "authority_basis": draft["authority_basis"]}
    except MaterializationError as error:
        return {**held, "reason_codes": [str(error)]}
    except Exception:
        return {**held, "reason_codes": ["materialization_refused"]}
