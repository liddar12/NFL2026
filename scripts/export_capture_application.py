"""Opt-in resumable v2 capture sender; staging/registration are not learning.

No default writes, credential reads, network, workflow or model activation.
Server-owned whole-group assignments are reconstructed completely at one pinned
ledger fence. Hashes check integrity, not provider authenticity or DB honesty.
"""
import base64
import copy
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timezone

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scripts import export_outcome_capture as O, export_learning as ex, capture_outcome_evidence as capture  # noqa: E402

ORIGIN, PRODUCER, BINDING = O.ORIGIN, O.PRODUCER, O.POLICY
POLICY = "sealed_whole_groups_v2"
BASE = "/api/v2/nfl/capture-applications"
MAX_GROUPS, MAX_MEMBERS, MAX_REPORT = 2000, 10000, 64 * 1024 * 1024
HASH_PATH = r"sha256%3A[0-9a-f]{64}"
PAGE_KEYS = set("version kind found application_id view ledger_watermark registration_id seal_id records total_records next_after".split())
IDENTITIES = "application_id request_id capture_intent_id capture_id seal_id membership_id source_vector_id".split()
SEAL_KEYS = set("version kind application_id request_id capture_intent_id capture_id execution_policy binding_policy season weeks source_watermark membership_id source_vector_id limits groups batches seal_id".split())
SEALED_KEYS = set("group_id scope receipt_ids source_receipt_ids generation_object_ids membership_id status reason_codes batch_ordinal fact fact_id".split())
REG_KEYS = set("version kind application_id request_id capture_intent_id capture_id seal_id membership_id source_vector_id status group_count member_count batch_count next_step_id source_watermark application_seq recorded_utc scope durable learning_accepted source_authentication registration_id".split())
BATCH_KEYS = set("version kind application_id step_id ordinal seal_id membership_id status groups added_observations added_revisions input_watermark watermark application_seq recorded_utc durable scope source_authentication batch_result_id".split())
TERM_KEYS = set("version kind application_id request_id capture_intent_id capture_id seal_id membership_id source_vector_id status reason_codes current_membership_id group_report_id counts registered_watermark watermark application_seq recorded_utc processing_complete complete_success learning_accepted durable scope source_authentication terminal_result_id".split())
STATUS_KEYS = set("version kind application_id registration_id seal_id membership_id status batch_count committed_batches next_step_id terminal_result_id ledger_watermark scope durable_ack execution_ready source_authentication".split())
COUNTS = set("groups members accepted_groups accepted_members withheld_groups withheld_members not_applied_groups not_applied_members batches committed_batches".split())
NORMAL = {"accepted", "partial", "withheld", "no_supported_membership"}
SAFE = {"application_transport_failed", "application_transport_exhausted", "application_http_refused", "application_http_exhausted",
        "application_protocol_refused", "application_pending_budget", "application_pending_step_limit", "application_original_conflict"}


class ApplicationExportError(ValueError):
    """Only static local codes may cross this boundary."""


class ApplicationBudgetExceeded(ApplicationExportError):
    """No new work; a prior in-flight commit is recovered by its original ID."""


def need(condition):
    if not condition:
        raise ApplicationExportError("application_protocol_refused")


def keys(value, expected):
    need(type(value) is dict and set(value) == expected)


def integer(value, low, high):
    need(type(value) is int and low <= value <= high)
    return value


def sequence(value, positive=False):
    number = O._sequence(value, positive=positive)
    need(number <= 9223372036854775807)
    return number


def hashed(value, field):
    O._hash(value[field])
    need(value[field] == ex.fingerprint({k: v for k, v in value.items() if k != field}))


def same(a, b):
    need(ex._same_json(a, b))


def reasons(value):
    need(type(value) is list and len(value) <= 100 and all(type(r) is str and ex.REASON.fullmatch(r) for r in value)
         and value == sorted(set(value)))


def ids(value, nonempty=True, hashes=True):
    need(type(value) is list and (value or not nonempty) and len(value) <= MAX_MEMBERS
         and all(type(v) is str and 0 < len(v) <= 200 for v in value) and value == sorted(set(value)))
    if hashes:
        for item in value:
            O._hash(item)


def membership(group):
    scope = group["scope"]
    need(type(scope) is list and len(scope) == 5 and type(scope[0]) is int and 2000 <= scope[0] <= 2100
         and all(type(x) is str and 0 < len(x) <= 200 for x in scope[1:])
         and scope[3] in ("qb_pass_yds", "rb_rush_yds", "wr_rec_yds") and scope[4] in ("home", "away"))
    need(group["group_id"] == ex.fingerprint(scope))
    for key in ("receipt_ids", "source_receipt_ids", "generation_object_ids"):
        ids(group[key])
    need(len(group["receipt_ids"]) == len(group["source_receipt_ids"]))
    projection = {k: group[k] for k in ("scope", "receipt_ids", "source_receipt_ids", "generation_object_ids")}
    need(group["membership_id"] == ex.fingerprint({"binding_policy": BINDING, **projection}))


def step_id(aid, ordinal):
    return ex.fingerprint({"version": 2, "kind": "nfl.capture_application_step.v2", "application_id": aid, "ordinal": ordinal})


def request_for(original):
    identity = {"version": 2, "kind": "nfl.capture_application.v2", "capture_intent_id": original["delivery_id"], "execution_policy": POLICY}
    return {"version": 2, "kind": "nfl.capture_application_request.v2", "execution_policy": POLICY,
            "capture_request": original, "application_id": ex.fingerprint(identity)}


def metadata(original, destination):
    """Metadata integrity only; new writes still require complete raw verification."""
    O._origin(destination)
    keys(original, set("version kind destination_id producer_id capture_id binding_policy envelope raw_pointers delivery_id".split()))
    need(type(original["version"]) is int and original["version"] == 1 and original["kind"] == "nfl.capture_delivery_request.v1"
         and original["destination_id"] == ex.fingerprint({"base_url": destination}) and original["producer_id"] == PRODUCER
         and original["binding_policy"] == BINDING)
    identity = {k: original[k] for k in ("version", "destination_id", "producer_id", "capture_id", "binding_policy")}
    need(original["delivery_id"] == ex.fingerprint({**identity, "kind": "nfl.capture_delivery.v1"}))
    env = original["envelope"]
    keys(env, {"version", "kind", "scope", "manifest", "observations", "raw_objects"})
    need(type(env["version"]) is int and env["version"] == 1 and env["kind"] == "nfl.capture_envelope.v1" and env["scope"] == "uploaded_only")
    manifest, observations = env["manifest"], env["observations"]
    need(type(manifest) is dict and type(observations) is dict)
    keys(manifest, set("version kind season weeks started_utc completed_utc sources clock_policy publication_status capture_id audit".split()))
    need(type(manifest["version"]) is int and manifest["version"] == 1 and manifest["kind"] == "nfl.outcome_capture.v1"
         and manifest["clock_policy"] == capture._CLOCK_POLICY and manifest["publication_status"] == "source_capture_not_public_forecast_evidence")
    hashed(manifest, "capture_id");need(manifest["capture_id"] == original["capture_id"])
    specs = capture.fetch_plan(manifest["season"], manifest["weeks"])
    need(type(manifest["sources"]) is list and len(manifest["sources"]) == len(specs))
    observed_ids, raw_sizes = [], {}
    previous, completed = capture._instant(manifest["started_utc"]), capture._instant(manifest["completed_utc"])
    for row, spec in zip(manifest["sources"], specs):
        oid = row["observation_id"];O._hash(oid)
        same(row, {"profile": spec["profile"], "season": spec["season"], "week": spec["week"], "observation_id": oid})
        obs = observations[oid];need(ex.fingerprint(obs) == oid)
        keys(obs, set("version kind evidence_class profile season week source_url raw_sha256 raw_bytes fetch_started_utc observed_utc upstream_updated_utc http audit".split()))
        need(type(obs["version"]) is int and obs["version"] == 1 and obs["kind"] == "nfl.outcome_source_observation.v1"
             and obs["evidence_class"] == "observed_source_snapshot" and obs["upstream_updated_utc"] is None
             and type(obs["http"]) is dict and type(obs["http"].get("status")) is int and obs["http"]["status"] == 200
             and all(ex._same_json(obs.get(k), spec[k]) for k in ("profile", "season", "week", "source_url")))
        began, clock = capture._instant(obs["fetch_started_utc"]), capture._instant(obs["observed_utc"])
        need(previous <= began <= clock <= completed);previous = clock
        size = integer(obs["raw_bytes"], 1, spec["maximum_bytes"]);rid = O._hash(obs["raw_sha256"])
        need(rid not in raw_sizes or raw_sizes[rid] == size);raw_sizes[rid] = size;observed_ids.append(oid)
    need(set(observations) == set(observed_ids) and len(observed_ids) == len(set(observed_ids)))
    same(env["raw_objects"], [{"raw_sha256": oid, "raw_bytes": raw_sizes[oid]} for oid in sorted(raw_sizes)])
    need(type(original["raw_pointers"]) is list and len(original["raw_pointers"]) == len(raw_sizes))
    for pointer, oid in zip(original["raw_pointers"], sorted(raw_sizes)):
        keys(pointer, {"version", "kind", "scope", "object_id", "raw_bytes", "chunks"})
        need(type(pointer["version"]) is int and pointer["version"] == 1 and pointer["kind"] == "selflearn.evidence_object.v1"
             and pointer["scope"] == "uploaded_only" and pointer["object_id"] == oid)
        same(pointer["raw_bytes"], raw_sizes[oid]);need(type(pointer["chunks"]) is list and pointer["chunks"])
        total = 0
        for index, chunk in enumerate(pointer["chunks"]):
            keys(chunk, {"chunk_id", "raw_bytes"});O._hash(chunk["chunk_id"])
            total += integer(chunk["raw_bytes"], 1, O.CHUNK_BYTES)
            need(index == len(pointer["chunks"]) - 1 or chunk["raw_bytes"] == O.CHUNK_BYTES)
        need(total == raw_sizes[oid])
    need(sum(raw_sizes.values()) <= capture.CAPTURE_LIMIT)
    O._body(request_for(original))


def plan(capture_path, destination):
    old = O.plan(capture_path, destination)
    value = {"version": 2, "kind": "nfl.capture_application_plan.v2", "capture_plan": old, "request": request_for(old["request"])}
    metadata(old["request"], old["destination"])
    result = {**value, "plan_id": ex.fingerprint(value)}
    O._body(result)
    return result


def validate_plan(value):
    keys(value, {"version", "kind", "capture_plan", "request", "plan_id"})
    need(type(value["version"]) is int and value["version"] == 2 and value["kind"] == "nfl.capture_application_plan.v2")
    hashed(value, "plan_id");O._body(value)
    old = value["capture_plan"]
    keys(old, set("version capture_path destination request raw_bytes unique_chunks whole_capture_member_limit membership_capacity fragmentation_allowed plan_id".split()))
    need(type(old["version"]) is int and old["version"] == 1 and type(old["capture_path"]) is str
         and str(O._selected_path(old["capture_path"])) == old["capture_path"])
    integer(old["raw_bytes"], 1, capture.CAPTURE_LIMIT);integer(old["unique_chunks"], 1, capture.CAPTURE_LIMIT // O.CHUNK_BYTES + 20)
    need(type(old["whole_capture_member_limit"]) is int and old["whole_capture_member_limit"] == 500 and old["fragmentation_allowed"] is False
         and old["membership_capacity"] == "receiver_owned_unknown_until_complete_binding")
    hashed(old, "plan_id");metadata(old["request"], old["destination"]);same(value["request"], request_for(old["request"]))
    return copy.deepcopy(value)


def paths(value, out_dir):
    root = O._selected_path(out_dir)
    authority = Path(value["capture_plan"]["capture_path"]).parent.parent
    need(not any(root.is_relative_to(p) or p.is_relative_to(root) for p in (authority, _ROOT / "data")) and root != _ROOT)
    target = root / value["request"]["capture_request"]["destination_id"][7:] / "applications-v2" / value["request"]["application_id"][7:]
    for name in ("outbox", "registration", "steps", "reports", "terminal", "staging", "failures"):
        ex._delivery_path(root, *target.relative_to(root).parts, name)
    return root, target


def write(root, target, value):
    try:
        ex._immutable(target, value, root=root)
    except Exception:
        raise ApplicationExportError("application_original_conflict") from None


def prepare(value, out_dir):
    value = validate_plan(value)
    # Explicit offline preparation verifies original raw, unlike recovery.
    O._validated(value["capture_plan"])
    root, target = paths(value, out_dir)
    write(root, target / "outbox" / "request.json", value)
    return {"version": 2, "application_id": value["request"]["application_id"], "scope": "prepared_only",
            "network_used": False, "learning_accepted": False}


def vector(envelope):
    rows = []
    for source in envelope["observations"].values():
        clock = capture._instant(source["observed_utc"]).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        rows.append([source[k] for k in ("profile", "season", "week", "raw_sha256", "raw_bytes")] + [clock])
    rows.sort(key=lambda r: (r[0], r[1], -1 if r[2] is None else r[2]))
    return ex.fingerprint(rows)


def fact(value, scope, seal, request):
    keys(value, {"week", "actual", "played", "status", "reason", "participation_basis", "game", "source_observations"})
    integer(value["week"], 1, 18);need(value["week"] in seal["weeks"])
    game = value["game"];keys(game, {"season", "week", "game_id", "kickoff_utc", "home", "away", "state"})
    need(type(game["season"]) is int and game["season"] == scope[0] and type(game["week"]) is int and game["week"] == value["week"]
         and game["game_id"] == scope[1] and game["state"] == "FINAL" and game["home"] != game["away"]
         and all(type(game[k]) is str and 0 < len(game[k]) <= 200 for k in ("home", "away")))
    kickoff = capture._instant(game["kickoff_utc"])
    sources = value["source_observations"]
    profiles = {"espn.scoreboard": capture.SCOREBOARD_PROFILE, "nflverse.stats_player": capture.STATS_PROFILE, "nflverse.snap_counts": capture.SNAPS_PROFILE}
    need(type(sources) is dict and {"espn.scoreboard"} < set(sources) <= set(profiles))
    if value["status"] == "VOID":
        need(value["actual"] is None and value["played"] is False and value["reason"] == "did_not_play"
             and value["participation_basis"] == "r106_team_snap_absence_inference" and set(sources) == {"espn.scoreboard", "nflverse.snap_counts"})
    else:
        need(value["status"] == "FINAL" and value["played"] is True and value["reason"] is None
             and type(value["actual"]) in (int, float) and math.isfinite(value["actual"]) and "nflverse.stats_player" in sources
             and value["participation_basis"] in ("stat_row", "r106_positive_offensive_snaps_no_stat_row"))
        need(value["participation_basis"] != "r106_positive_offensive_snaps_no_stat_row" or value["actual"] == 0 and "nflverse.snap_counts" in sources)
    for name, part in sources.items():
        keys(part, {"source", "observation_id", "observed_utc"});O._hash(part["observation_id"])
        source = request["capture_request"]["envelope"]["observations"][part["observation_id"]]
        need(part["source"] == name and source["profile"] == profiles[name] and source["season"] == scope[0]
             and (name != "espn.scoreboard" or source["week"] == value["week"]) and part["observed_utc"] == source["observed_utc"])
        need(capture._instant(part["observed_utc"]) >= kickoff
             and capture._instant(part["observed_utc"]) >= capture._instant(sources["espn.scoreboard"]["observed_utc"]))


def seal_valid(seal, request):
    keys(seal, SEAL_KEYS)
    old = request["capture_request"];manifest = old["envelope"]["manifest"]
    need(type(seal["version"]) is int and seal["version"] == 2 and seal["kind"] == "nfl.capture_application_seal.v2"
         and seal["application_id"] == request["application_id"] and seal["request_id"] == ex.fingerprint(request)
         and seal["capture_intent_id"] == old["delivery_id"] and seal["capture_id"] == old["capture_id"]
         and seal["execution_policy"] == POLICY and seal["binding_policy"] == BINDING
         and type(seal["season"]) is int and seal["season"] == manifest["season"] and seal["source_vector_id"] == vector(old["envelope"]))
    same(seal["weeks"], manifest["weeks"]);sequence(seal["source_watermark"])
    keys(seal["limits"], {"members", "observations", "revisions", "rpc_bytes"})
    for name, size in seal["limits"].items():
        integer(size, 1, 8 * 1024 * 1024 if name == "rpc_bytes" else 500)
    groups, batches = seal["groups"], seal["batches"]
    need(type(groups) is list and len(groups) <= MAX_GROUPS and type(batches) is list and len(batches) <= MAX_GROUPS)
    seen, source_ids, planned, gids = set(), set(), {}, []
    for group in groups:
        keys(group, SEALED_KEYS);membership(group);reasons(group["reason_codes"])
        need(group["scope"][0] == seal["season"] and not seen.intersection(group["receipt_ids"]) and not source_ids.intersection(group["source_receipt_ids"]))
        seen.update(group["receipt_ids"]);source_ids.update(group["source_receipt_ids"]);gids.append(group["group_id"])
        need(group["status"] in ("planned", "withheld") and (group["status"] == "planned") == (not group["reason_codes"]))
        if group["status"] == "planned":
            integer(group["batch_ordinal"], 0, MAX_GROUPS - 1)
            need(len(group["receipt_ids"]) <= min(seal["limits"]["members"], seal["limits"]["observations"]))
            fact(group["fact"], group["scope"], seal, request);need(group["fact_id"] == ex.fingerprint(group["fact"]))
            planned[group["group_id"]] = group
        else:
            need(all(group[k] is None for k in ("batch_ordinal", "fact", "fact_id")))
    need(gids == sorted(set(gids)) and len(seen) <= MAX_MEMBERS and seal["membership_id"] == ex.fingerprint({"binding_policy": BINDING, "groups": [g["membership_id"] for g in groups]}))
    assigned = []
    for ordinal, assignment in enumerate(batches):
        keys(assignment, {"ordinal", "step_id", "group_ids", "member_count"})
        integer(assignment["ordinal"], 0, MAX_GROUPS - 1);need(assignment["ordinal"] == ordinal and assignment["step_id"] == step_id(seal["application_id"], ordinal))
        ids(assignment["group_ids"]);need(all(g in planned for g in assignment["group_ids"]))
        integer(assignment["member_count"], 1, min(seal["limits"]["members"], seal["limits"]["observations"]))
        need(assignment["member_count"] == sum(len(planned[g]["receipt_ids"]) for g in assignment["group_ids"])
             and all(planned[g]["batch_ordinal"] == ordinal for g in assignment["group_ids"]))
        assigned.extend(assignment["group_ids"])
    need(assigned == list(planned));hashed(seal, "seal_id");O._body(seal)


def result_base(value, expected, kind, scope):
    keys(value, expected)
    need(type(value["version"]) is int and value["version"] == 2 and value["kind"] == kind and value["scope"] == scope
         and value["durable"] is True and value["source_authentication"] == "not_performed")
    sequence(value["application_seq"], True);capture._instant(value["recorded_utc"])


def identities(value, seal, fields=IDENTITIES):
    for field in fields:
        O._hash(value[field]);need(value[field] == seal[field])


def registration_valid(value, seal):
    result_base(value, REG_KEYS, "nfl.capture_application_registration.v2", "sealed_application_only");identities(value, seal)
    need(value["status"] == "registered" and value["learning_accepted"] is False and value["source_watermark"] == seal["source_watermark"]
         and value["next_step_id"] == (seal["batches"][0]["step_id"] if seal["batches"] else None))
    for name, count in (("group_count", len(seal["groups"])), ("member_count", sum(len(g["receipt_ids"]) for g in seal["groups"])), ("batch_count", len(seal["batches"]))):
        integer(value[name], 0, MAX_MEMBERS);need(value[name] == count)
    hashed(value, "registration_id")


def group_result(value, sealed):
    keys(value, O.GROUP_KEYS);membership(value);reasons(value["reason_codes"])
    for key in ("group_id", "scope", "receipt_ids", "source_receipt_ids", "generation_object_ids", "membership_id"):
        same(value[key], sealed[key])
    need(value["status"] in ("accepted", "withheld") and (value["status"] == "accepted") == (not value["reason_codes"]))
    ids(value["observation_ids"], False);ids(value["revision_ids"], False, False)
    need(len(value["revision_ids"]) <= len(value["receipt_ids"]))
    need(len(value["observation_ids"]) == len(value["receipt_ids"]) if value["status"] == "accepted" else not value["observation_ids"] and not value["revision_ids"])
    if sealed["status"] == "withheld":
        need(value["status"] == "withheld" and value["reason_codes"] == sealed["reason_codes"])


def batch_valid(value, seal):
    result_base(value, BATCH_KEYS, "nfl.capture_application_batch_result.v2", "observations_and_batch_results")
    identities(value, seal, ("application_id", "seal_id", "membership_id"))
    ordinal = integer(value["ordinal"], 0, len(seal["batches"]) - 1);assignment = seal["batches"][ordinal]
    need(value["step_id"] == assignment["step_id"] and value["status"] in ("committed", "not_applied") and type(value["groups"]) is list)
    need([g["group_id"] for g in value["groups"]] == assignment["group_ids"])
    sealed = {g["group_id"]: g for g in seal["groups"]};observations, revisions = set(), set()
    for group in value["groups"]:
        group_result(group, sealed[group["group_id"]])
        need(not observations.intersection(group["observation_ids"]) and not revisions.intersection(group["revision_ids"]))
        observations.update(group["observation_ids"]);revisions.update(group["revision_ids"])
        need(value["status"] != "not_applied" or group["status"] == "withheld" and group["reason_codes"] == ["application_membership_changed"])
    need(len(observations) <= seal["limits"]["observations"] and len(revisions) <= seal["limits"]["revisions"])
    integer(value["added_observations"], 0, len(observations));integer(value["added_revisions"], 0, len(revisions))
    low, high = sequence(value["input_watermark"]), sequence(value["watermark"])
    need(low >= sequence(seal["source_watermark"]) and high >= low and bool(value["added_observations"] + value["added_revisions"]) == (high != low)
         and (value["status"] != "not_applied" or high == low and not observations and not revisions))
    hashed(value, "batch_result_id")


def report_valid(value, request):
    """Complete server report, not an independent audit of DB insertion counts."""
    seal, registration, groups, batches, status, terminal = (value[k] for k in ("seal", "registration", "groups", "batches", "status", "terminal"))
    same(value["request"], request);seal_valid(seal, request);registration_valid(registration, seal)
    need(len(groups) == len(seal["groups"]) and len(batches) == len(seal["batches"]))
    results, observations, revisions, stopped = {}, set(), set(), False
    low, seq = sequence(seal["source_watermark"]), sequence(registration["application_seq"])
    term_reasons = None if terminal is None else terminal["reason_codes"]
    for row, assigned in zip(batches, seal["batches"]):
        keys(row, {"assignment", "result"});same(row["assignment"], assigned)
        result = row["result"]
        if result is None:
            stopped = True
            continue
        batch_valid(result, seal)
        need(not stopped and result["ordinal"] == assigned["ordinal"] and sequence(result["input_watermark"]) >= low and sequence(result["application_seq"]) > seq)
        low, seq = sequence(result["watermark"]), sequence(result["application_seq"])
        for group in result["groups"]:
            need(not observations.intersection(group["observation_ids"]) and not revisions.intersection(group["revision_ids"]))
            observations.update(group["observation_ids"]);revisions.update(group["revision_ids"]);results[group["group_id"]] = (result["status"], group)
        if result["status"] == "not_applied":
            need(term_reasons == ["application_membership_changed"]);stopped = True
    counts = {key: 0 for key in COUNTS}
    counts.update(groups=len(groups), members=sum(len(g["receipt_ids"]) for g in seal["groups"]), batches=len(batches), committed_batches=sum(b["result"] is not None and b["result"]["status"] == "committed" for b in batches))
    for row, sealed in zip(groups, seal["groups"]):
        keys(row, {"sealed_group", "execution_state", "result"});same(row["sealed_group"], sealed)
        state, result = row["execution_state"], row["result"]
        if sealed["status"] == "withheld":
            need(state == "initial_withheld" and result is not None)
        elif sealed["group_id"] in results:
            cause, original = results[sealed["group_id"]]
            need(state == ("committed" if cause == "committed" else "not_applied"));same(result, original)
        elif terminal is not None:
            need(state == "not_applied" and term_reasons and type(result) is dict and result["status"] == "withheld" and result["reason_codes"] == term_reasons)
        else:
            need(state == "pending" and result is None)
        if result is not None:
            group_result(result, sealed)
            prefix = "accepted" if result["status"] == "accepted" else "withheld"
            counts[prefix + "_groups"] += 1;counts[prefix + "_members"] += len(sealed["receipt_ids"])
            if state == "not_applied":
                counts["not_applied_groups"] += 1;counts["not_applied_members"] += len(sealed["receipt_ids"])
    keys(status, STATUS_KEYS)
    need(type(status["version"]) is int and status["version"] == 2 and status["kind"] == "nfl.capture_application_status.v2"
         and status["scope"] == "pinned_application_progress" and status["durable_ack"] is False and status["source_authentication"] == "not_performed")
    for key in ("application_id", "seal_id", "membership_id"):
        need(status[key] == seal[key])
    need(status["registration_id"] == registration["registration_id"] and status["ledger_watermark"] == value["ledger_watermark"])
    fence = sequence(value["ledger_watermark"]);need(fence >= seq)
    pending = next((b["assignment"]["step_id"] for b in batches if b["result"] is None), None)
    integer(status["batch_count"], 0, MAX_GROUPS);integer(status["committed_batches"], 0, MAX_GROUPS)
    need(status["batch_count"] == len(batches) and status["committed_batches"] == counts["committed_batches"]
         and status["status"] == ("terminal" if terminal is not None else "active") and status["execution_ready"] is (terminal is None)
         and status["next_step_id"] == (None if terminal is not None else pending)
         and status["terminal_result_id"] == (None if terminal is None else terminal["terminal_result_id"]))
    if terminal is not None:
        result_base(terminal, TERM_KEYS, "nfl.capture_application_result.v2", "application_group_results");identities(terminal, seal)
        state, cause = terminal["status"], terminal["reason_codes"];reasons(cause);O._hash(terminal["current_membership_id"])
        need(state in NORMAL | {"incomplete_membership_changed", "incomplete_integrity_or_capacity"})
        complete = state in NORMAL
        need((not cause) is complete and (state != "incomplete_membership_changed" or cause == ["application_membership_changed"])
             and (state != "incomplete_integrity_or_capacity" or bool(cause) and set(cause) <= {"source_integrity_failed", "runtime_capacity_exceeded"}))
        expected = "no_supported_membership" if not groups else "accepted" if counts["accepted_groups"] == len(groups) else "partial" if counts["accepted_groups"] else "withheld"
        keys(terminal["counts"], COUNTS)
        for number in terminal["counts"].values():
            integer(number, 0, MAX_MEMBERS)
        same(terminal["counts"], counts)
        need(terminal["group_report_id"] == ex.fingerprint(groups) and terminal["processing_complete"] is complete
             and terminal["complete_success"] is (state == "accepted") and terminal["learning_accepted"] is bool(counts["accepted_groups"])
             and terminal["registered_watermark"] == seal["source_watermark"] and sequence(terminal["watermark"]) >= low
             and seq < sequence(terminal["application_seq"]) <= fence
             and all(g["execution_state"] != "pending" for g in groups))
        need(not complete or state == expected and not counts["not_applied_groups"] and counts["committed_batches"] == len(batches) and terminal["current_membership_id"] == seal["membership_id"])
        need(state != "incomplete_membership_changed" or terminal["current_membership_id"] != seal["membership_id"])
        hashed(terminal, "terminal_result_id")
    else:
        need(pending is not None)
    need(len(ex.encoded(value)) <= MAX_REPORT)
    return value


def route(aid, view, *, fence=None, after=None):
    pairs = {"view": view, "limit": "100" if view in ("groups", "batches") else "1"}
    if fence is not None:
        pairs["ledger_watermark"] = fence
    if after is not None:
        pairs["after"] = after
    return BASE + "/" + urllib.parse.quote(aid, safe="") + "?" + urllib.parse.urlencode(sorted(pairs.items()))


def route_valid(method, path, body):
    need(type(method) is str and type(path) is str)
    match = re.fullmatch(re.escape(BASE) + "/(" + HASH_PATH + ")(?:/steps/(" + HASH_PATH + "))?(?:\?(.*))?", path)
    if method == "POST":
        need(path in (BASE, O.CHUNK_ROUTE) or match is not None and match[2] is not None and match[3] is None)
        need(type(body) is bytes and 0 < len(body) <= O.BODY_BYTES)
        need(match is None or body == b"{}")
        if match is None:
            value = ex._json(body);need(body == ex.encoded(value))
            if path == BASE:
                keys(value, {"version", "kind", "execution_policy", "capture_request", "application_id"})
                metadata(value["capture_request"], ORIGIN);same(value, request_for(value["capture_request"]))
            else:
                keys(value, {"version", "kind", "scope", "chunk_id", "raw_bytes", "encoding", "data"})
                need(type(value["data"]) is str)
                raw = base64.b64decode(value["data"], validate=True)
                need(0 < len(raw) <= O.CHUNK_BYTES);same(value, O._chunk(raw))
    else:
        need(method == "GET" and body is None and match is not None)
        if match[2] is not None:
            need(match[3] is None)
        else:
            query = match[3];need(query is not None)
            pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True)
            need(len(pairs) == len(dict(pairs)) and set(dict(pairs)) <= {"view", "limit", "after", "ledger_watermark"}
                 and urllib.parse.urlencode(sorted(pairs)) == query)
            options = dict(pairs);view = options.get("view")
            need(view in ("registration", "groups", "batches", "status", "terminal") and options.get("limit") in ("1", "100"))
            need(options["limit"] == ("100" if view in ("groups", "batches") else "1"))
            if "ledger_watermark" in options:
                sequence(options["ledger_watermark"])
            if "after" in options:
                need(view in ("groups", "batches"))
                O._hash(options["after"]) if view == "groups" else integer(sequence(options["after"]), 0, MAX_GROUPS - 1)


def http_transport(destination, token, *, timeout=50, deadline=None, monotonic=time.monotonic):
    """Bound socket waits and check a shared command deadline around I/O.

    urllib's timeout bounds socket inactivity, not DNS/continuous-trickle wall
    time. No thread is left running after cancellation; late replies never
    become success in the expired command and can be recovered next time.
    """
    destination = O._origin(destination)
    need(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 50 and callable(monotonic)
         and (deadline is None or type(deadline) in (int, float) and math.isfinite(deadline)))
    def remaining():
        budget = timeout if deadline is None else min(timeout, deadline - monotonic())
        if budget <= 0:
            raise ApplicationBudgetExceeded("application_pending_budget")
        return budget
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ex._NoRedirect())
    def exchange(method, path, body):
        route_valid(method, path, body)  # Before URL construction or credentials.
        remaining()  # An expired command attaches no credential or request.
        req = urllib.request.Request(destination + path, method=method, data=body,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with opener.open(req, timeout=remaining()) as response:
                need(response.geturl() == destination + path)
                parts, size = [], 0
                while size <= O.BODY_BYTES:
                    remaining()
                    # read1 makes at most one underlying buffered read;
                    # check time/size between bounded chunks, never drain an
                    # unbounded streaming response before checking its clock.
                    part = response.read1(min(65536, O.BODY_BYTES + 1 - size))
                    need(type(part) is bytes)
                    remaining()
                    if not part:
                        break
                    parts.append(part);size += len(part)
                return response.status, b"".join(parts)
        except urllib.error.HTTPError as error:
            error.close();remaining();return error.code, b""
    return exchange


def exchange(transport, method, path, body, attempts, sleep, check, missing=False):
    route_valid(method, path, body)
    for attempt in range(attempts):
        check()
        try:
            status, raw = transport(method, path, body)
        except ApplicationBudgetExceeded:
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt + 1 == attempts:
                raise ApplicationExportError("application_transport_exhausted") from None
        except Exception:
            raise ApplicationExportError("application_transport_failed") from None
        else:
            check()  # Injected and actual transports cannot bless a late ACK.
            need(type(status) is int)
            if status == 404 and missing:
                return None
            if 200 <= status < 300:
                need(type(raw) is bytes and len(raw) <= O.BODY_BYTES)
                return ex._json(raw)
            if status != 429 and not 500 <= status <= 599:
                raise ApplicationExportError("application_http_refused")
            if attempt + 1 == attempts:
                raise ApplicationExportError("application_http_exhausted")
        check();sleep(min(.5 * 2 ** attempt, 2))


def read_application(request, transport, attempts, sleep, check):
    aid = request["application_id"];fence, meta, output, size = None, None, {}, 0
    for view in ("registration", "groups", "batches", "status", "terminal"):
        after, rows, total = None, [], None
        for _ in range(MAX_GROUPS + 1):
            page = exchange(transport, "GET", route(aid, view, fence=fence, after=after), None, attempts, sleep, check, missing=view == "registration")
            if page is None:
                need(view == "registration");return None
            keys(page, PAGE_KEYS)
            need(type(page["version"]) is int and page["version"] == 2 and page["kind"] == "nfl.capture_application_page.v2"
                 and page["found"] is True and page["application_id"] == aid and page["view"] == view
                 and type(page["records"]) is list and len(page["records"]) <= (100 if view in ("groups", "batches") else 1))
            sequence(page["ledger_watermark"]);O._hash(page["registration_id"]);O._hash(page["seal_id"])
            current = (page["ledger_watermark"], page["registration_id"], page["seal_id"])
            need(meta is None or current == meta);meta = current;fence = current[0]
            integer(page["total_records"], 0, MAX_GROUPS if view in ("groups", "batches") else 1)
            need(total is None or total == page["total_records"]);total = page["total_records"]
            size += len(ex.encoded(page));need(size <= MAX_REPORT)
            for row in page["records"]:
                if view in ("groups", "batches"):
                    cursor = row["sealed_group"]["group_id"] if view == "groups" else str(integer(row["assignment"]["ordinal"], 0, MAX_GROUPS - 1))
                    if view == "groups":
                        O._hash(cursor)
                    need(after is None or (cursor > after if view == "groups" else int(cursor) > int(after)))
                    after = cursor
                rows.append(row)
            need(len(rows) <= total)
            if page["next_after"] is None:
                need(len(rows) == total);break
            need(view in ("groups", "batches") and page["records"] and page["next_after"] == after and len(rows) < total)
        else:
            raise ApplicationExportError("application_protocol_refused")
        output[view] = rows
    need(len(output["registration"]) == len(output["status"]) == 1 and len(output["terminal"]) <= 1)
    header = output["registration"][0];keys(header, {"request", "seal_header", "registration"});keys(header["seal_header"], SEAL_KEYS - {"groups", "batches"})
    result = {"request": header["request"], "seal": {**header["seal_header"], "groups": [r["sealed_group"] for r in output["groups"]], "batches": [r["assignment"] for r in output["batches"]]},
        "registration": header["registration"], "groups": output["groups"], "batches": output["batches"], "status": output["status"][0],
        "terminal": output["terminal"][0] if output["terminal"] else None, "ledger_watermark": fence}
    need(result["registration"]["registration_id"] == meta[1] and result["seal"]["seal_id"] == meta[2])
    return report_valid(result, request)


def send(value, out_dir, token, *, transport=None, attempts=3, max_steps=16, max_run_seconds=240, sleep=time.sleep, monotonic=time.monotonic):
    value = validate_plan(value)  # Fixed origin before token checks or writes.
    need(type(token) is str and 32 <= len(token) <= 8192 and all(0x21 <= ord(c) <= 0x7e for c in token))
    ex._reject_credentials(value, (token,))
    integer(attempts, 1, 5);integer(max_steps, 1, MAX_GROUPS)
    need(type(max_run_seconds) in (int, float) and math.isfinite(max_run_seconds) and 0 < max_run_seconds <= 300 and callable(monotonic))
    end = monotonic() + max_run_seconds
    def check():
        if monotonic() >= end:
            raise ApplicationBudgetExceeded("application_pending_budget")
    root, target = paths(value, out_dir);request = value["request"]
    write(root, target / "outbox" / "request.json", value)
    conflict = target / "failures" / (ex.fingerprint("application_original_conflict")[7:] + ".json")
    ex._delivery_path(root, *conflict.relative_to(root).parts)
    need(not conflict.exists())
    def save(path, payload):
        write(root, target / path, payload)
    def fetch():
        report = read_application(request, channel, attempts, sleep, check)
        if report is not None:
            save("registration/original.json", report["registration"])
            save("reports/" + report["ledger_watermark"] + ".json", report)
            for row in report["batches"]:
                if row["result"] is not None:
                    save("steps/" + row["assignment"]["step_id"][7:] + "/original.json", row["result"])
            if report["terminal"] is not None:
                save("terminal/original.json", report["terminal"])
        return report
    def terminal_result(report):
        terminal = report["terminal"]
        return {"version": 2, "status": "terminal_original", "application_id": request["application_id"], "scope": "application_group_results",
            "result": terminal, "durable_result_ack": True, "processing_complete": terminal["processing_complete"],
            "complete_success": terminal["complete_success"], "learning_accepted": terminal["learning_accepted"], "current_membership_reverified": False,
            "source_authentication": "not_performed"}
    def post_original(path, body, validator):
        for attempt in range(attempts):
            try:
                response = exchange(channel, "POST", path, body, 1, sleep, check)
                claimed = validator(response)
                break
            except ApplicationExportError as error:
                if str(error) not in {"application_transport_exhausted", "application_http_exhausted", "application_http_refused"}:
                    raise
                # Never choose a new step after a lost reply. Complete GET
                # verifies the original exact command before another POST.
                original = fetch()
                if original is not None and (path == BASE or any(row["result"] is not None and path.endswith("/" + urllib.parse.quote(row["assignment"]["step_id"], safe="")) for row in original["batches"]) or original["terminal"] is not None):
                    return original
                if attempt + 1 == attempts or str(error) == "application_http_refused":
                    raise
        original = fetch();need(original is not None)
        actual = original["registration"] if path == BASE else next((row["result"] for row in original["batches"] if path.endswith("/" + urllib.parse.quote(row["assignment"]["step_id"], safe=""))), None)
        same(claimed, actual)
        return original
    try:
        channel = ex._credential_guarded_transport(transport or http_transport(
            value["capture_plan"]["destination"], token, deadline=end, monotonic=monotonic), (token,))
        report = fetch()  # Before loading raw bytes, current source clocks or staging.
        if report is None:
            _, bundle = O._validated(value["capture_plan"]);check()
            seen = set()
            for raw in bundle["raw_objects"].values():
                for offset in range(0, len(raw), O.CHUNK_BYTES):
                    dto = O._chunk(raw[offset:offset + O.CHUNK_BYTES])
                    if dto["chunk_id"] in seen:
                        continue
                    save("outbox/chunk-" + dto["chunk_id"][7:] + ".json", {k: dto[k] for k in ("version", "kind", "scope", "chunk_id", "raw_bytes")})
                    ack = O._stage(exchange(channel, "POST", O.CHUNK_ROUTE, O._body(dto), attempts, sleep, check), dto)
                    save("staging/" + dto["chunk_id"][7:] + ".json", ack);seen.add(dto["chunk_id"])
            def registered(wrapper):
                keys(wrapper, {"version", "registration", "scope", "learning_accepted"})
                need(type(wrapper["version"]) is int and wrapper["version"] == 2 and wrapper["scope"] == "registration_only" and wrapper["learning_accepted"] is False)
                result_base(wrapper["registration"], REG_KEYS, "nfl.capture_application_registration.v2", "sealed_application_only")
                need(wrapper["registration"]["application_id"] == request["application_id"] and wrapper["registration"]["request_id"] == ex.fingerprint(request))
                hashed(wrapper["registration"], "registration_id")
                return wrapper["registration"]
            report = post_original(BASE, O._body(request), registered)
        for _ in range(max_steps):
            if report["terminal"] is not None:
                return terminal_result(report)
            check();sid = report["status"]["next_step_id"];O._hash(sid)
            path = BASE + "/" + urllib.parse.quote(request["application_id"], safe="") + "/steps/" + urllib.parse.quote(sid, safe="")
            save("steps/" + sid[7:] + "/command.json", {"version": 2, "application_id": request["application_id"], "step_id": sid, "body": {}})
            current = report
            def stepped(wrapper):
                keys(wrapper, {"version", "result", "scope"})
                need(type(wrapper["version"]) is int and wrapper["version"] == 2 and wrapper["scope"] == "batch_only")
                batch_valid(wrapper["result"], current["seal"]);need(wrapper["result"]["step_id"] == sid)
                return wrapper["result"]
            report = post_original(path, b"{}", stepped)
        if report["terminal"] is not None:
            # A final allowed step may terminalize; return the immutable result
            # without requiring an extra invocation or additional POST.
            return terminal_result(report)
        raise ApplicationExportError("application_pending_step_limit")
    except Exception as error:
        reason = "application_pending_budget" if type(error) is ApplicationBudgetExceeded else str(error) if type(error) is ApplicationExportError and str(error) in SAFE else "application_protocol_refused"
        save("failures/" + ex.fingerprint(reason)[7:] + ".json", {"version": 2, "reason": reason})
        return {"version": 2, "status": "pending", "application_id": request["application_id"], "scope": "progress_only",
                "learning_accepted": False, "complete_success": False, "reason": reason}


def resume(out_dir, application_id, destination, token, **kwargs):
    destination = O._origin(destination);O._hash(application_id)
    root = O._selected_path(out_dir)
    path = ex._delivery_path(root, ex.fingerprint({"base_url": destination})[7:], "applications-v2", application_id[7:], "outbox", "request.json")
    need(path.stat().st_size <= O.BODY_BYTES + 65536)
    value = validate_plan(ex._read(path));need(value["request"]["application_id"] == application_id)
    return send(value, out_dir, token, **kwargs)


def main(argv=None):
    parser = ex._SafeParser(description=__doc__)
    parser.add_argument("--capture");parser.add_argument("--resume")
    parser.add_argument("--base-url", required=True);parser.add_argument("--out-dir")
    parser.add_argument("--max-steps", type=int, default=16);parser.add_argument("--attempts", type=int, default=3)
    mode = parser.add_mutually_exclusive_group();mode.add_argument("--send", action="store_true");mode.add_argument("--prepare", action="store_true")
    args = parser.parse_args(argv)
    try:
        O._origin(args.base_url);need(bool(args.capture) != bool(args.resume))
        if args.resume:
            need(args.send and args.out_dir)
            result = resume(args.out_dir, args.resume, args.base_url, os.environ.get("SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"), attempts=args.attempts, max_steps=args.max_steps)
        else:
            value = plan(args.capture, args.base_url)
            if not args.send and not args.prepare:
                result = {"version": 2, "mode": "dry_run", "application_id": value["request"]["application_id"], "network_used": False,
                    "writes": False, "learning_accepted": False, "membership": "server_owned_unknown_until_registration"}
            else:
                need(args.out_dir is not None)
                result = send(value, args.out_dir, os.environ.get("SELFLEARN_NFL_OUTCOME_INGEST_TOKEN"), attempts=args.attempts, max_steps=args.max_steps) if args.send else prepare(value, args.out_dir)
        print(ex.encoded(result).decode("ascii"))
        return 1 if result.get("status") == "pending" else 3 if result.get("status") == "terminal_original" and not result["complete_success"] else 0
    except Exception:
        print('{"version":2,"status":"pending","learning_accepted":false,"reason":"application_export_refused"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
