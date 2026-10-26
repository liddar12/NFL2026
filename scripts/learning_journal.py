"""Immutable internal MY forecast journal, independent of display-card dedupe.

Each generation is a NEW file under data/snapshots/learning_journal/. Exact
consumer inputs are content-addressed under data/snapshots/learning_sources/.
The existing publisher preserves snapshots and refuses conflicting versions.
This is internal capture, NOT evidence that Netlify or a viewer saw a forecast.
Upstream producer documents are identified by the receipt's source_snapshot_id;
this journal freezes the consumer inputs and receipt features, not absent history.
"""
import collections
import inspect
import json
import os
import tempfile

from scripts import learning_receipts as lr
from scripts.models import my_cards, parlay_builder

VERSION = 1
PUBLICATION_STATUS = "generated_unverified"


def policy_versions(calibration):
    """Content versions of the actual unchanged selector and joint implementation.

The joint version conservatively covers the entire helper module, including
fallback constants, plus the exact correlation calibration. It is not a claim
that the joint probabilities have been calibrated prospectively.
"""
    return {
        "selection_policy_version": lr.fingerprint({
            "policy": "my_cards_beam", "source": inspect.getsource(my_cards)}),
        "joint_model_version": lr.fingerprint({
            "policy": "my_cards_game_group_probability",
            "source": inspect.getsource(parlay_builder), "calibration": calibration}),
    }


def _manifest(pool, schedule, calibration, records):
    season, week = pool.get("season"), pool.get("week")
    if type(season) is not int or type(week) is not int or not 1 <= week <= 18:
        raise ValueError("learning journal requires an explicit season and week")
    inputs = {"leg_pool": pool, "schedule": schedule, "parlay_calibration": calibration}
    sources = {name: lr.fingerprint(value) for name, value in inputs.items()}
    # Display keys are references only. No legacy archive is consulted here.
    offered = []
    for card in records:
        offered.append({"card_id": card["card_id"], "receipt_ids": sorted({
            leg["learning_receipt"]["receipt_id"] for leg in card.get("legs", [])
            if isinstance(leg.get("learning_receipt"), dict)
            and isinstance(leg["learning_receipt"].get("receipt_id"), str)})})
    manifest = {"version": VERSION, "season": season, "week": week,
                "pool_generated_utc": pool.get("generated_utc"),
                "source_snapshots": sources, "offered_cards": offered,
                **policy_versions(calibration)}
    return manifest, {sources[name]: value for name, value in inputs.items()}


def _candidate_problem(leg, receipt, pool, game, conflicting_game, recorded):
    try:
        problem = lr.receipt_problem(receipt, leg, pool["season"], pool["week"])
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
        return "malformed_receipt"
    if problem:
        return problem
    # The historic NFL receipt verifier permits unknown source timestamps.
    # New durable captures use the shared engine's stricter contract: absence
    # cannot establish that a source was available before the prediction.
    timestamps = receipt.get("source_timestamps")
    if not isinstance(timestamps, dict) or not timestamps:
        return "missing_source_timestamps"
    for name, stamp in timestamps.items():
        if lr.instant(stamp) is None:
            return "invalid_timestamp"
        if not isinstance(name, str) or not name.strip():
            return "source_after_prediction"
    if receipt.get("publication_status") != PUBLICATION_STATUS:
        return "unsupported_publication_claim"
    created = lr.instant(receipt["forecast_created_utc"])
    if created != lr.instant(pool.get("generated_utc")):
        return "receipt_pool_generation_mismatch"
    if receipt.get("base_model_version") != pool.get("base_model_version"):
        return "receipt_pool_base_mismatch"
    if conflicting_game:
        return "conflicting_schedule_game"
    if not game or game.get("week") != pool["week"]:
        return "missing_or_wrong_week_game"
    kickoff = lr.instant(game.get("kickoff_utc"))
    if kickoff is None:
        return "missing_or_invalid_kickoff"
    if game.get("status") != "STATUS_SCHEDULED":
        return "game_not_scheduled"
    if not created <= recorded < kickoff:
        return "not_captured_pregame"
    context = receipt.get("input_context") or {}
    if not isinstance(context, dict):
        return "invalid_eligibility_context"
    eligibility, this_week = context.get("eligibility") or {}, context.get("this_week") or {}
    if not isinstance(eligibility, dict) or not isinstance(this_week, dict):
        return "invalid_eligibility_context"
    if eligibility.get("eligible") is False or this_week.get("playable") is False:
        return "source_not_eligible"
    if (eligibility.get("week", pool["week"]) != pool["week"]
            or this_week.get("wk", pool["week"]) != pool["week"]):
        return "wrong_week_eligibility_context"
    return None


def capture(pool, schedule, calibration, records, recorded_utc):
    """Pure generation envelope plus exact content-addressed source payloads.

Every valid pre-event prop receipt in the pool is retained, including rungs not
selected on a team card. That candidate population is named explicitly; it must
not be silently substituted for the offered-card evaluation cohort.
"""
    manifest, snapshots = _manifest(pool, schedule, calibration, records)
    recorded = lr.instant(recorded_utc)
    if recorded is None:
        raise ValueError("learning journal requires a timezone-aware capture time")
    if schedule.get("season", pool["season"]) != pool["season"]:
        raise ValueError("learning journal schedule season does not match pool")
    generation_id = lr.fingerprint(manifest)
    by_id, conflicts = {}, set()
    for game in schedule.get("games") or []:
        gid = str(game.get("game_id"))
        if gid in by_id and by_id[gid] != game:
            conflicts.add(gid)
        by_id[gid] = game
    rejected, rows = collections.Counter(), {}
    candidates = 0
    for player in pool.get("players") or []:
        if not isinstance(player, dict) or not isinstance(player.get("rungs"), list):
            rejected["invalid_pool_player"] += 1
            continue
        for rung in player["rungs"]:
            candidates += 1
            if not isinstance(rung, dict):
                rejected["invalid_pool_rung"] += 1
                continue
            leg = {k: value for k, value in {**player, **rung}.items()
                   if k in ("game_id", "gsis_id", "market", "line", "side", "direction",
                            "comparison_operator", "model_prob", "selection", "position")}
            receipt = rung.get("learning_receipt")
            gid = str(leg.get("game_id"))
            reason = _candidate_problem(leg, receipt, pool, by_id.get(gid), gid in conflicts, recorded)
            if reason:
                rejected[reason] += 1
                continue
            rid = receipt["receipt_id"]
            rows.setdefault(rid, {"receipt_id": rid, "learning_receipt": receipt,
                "leg": leg, "kickoff_utc": by_id[gid]["kickoff_utc"],
                "recorded_utc": recorded_utc, "generation_id": generation_id,
                "publication_status": PUBLICATION_STATUS})
    generation = {**manifest, "generation_id": generation_id,
        "recorded_utc": recorded_utc, "receipt_ids": sorted(rows),
        "population": "eligible_pool_prop_rungs_before_display_dedupe",
        "snapshot_coverage": "exact consumer pool/schedule/correlation inputs; upstream producer documents identified by receipt source hash, not reconstructed",
        "publication_status": PUBLICATION_STATUS,
        "audit": {"candidate_rungs": candidates, "eligible_receipts": len(rows),
                  "quarantined_records": sum(rejected.values()),
                  "quarantine_reasons": dict(sorted(rejected.items()))}}
    doc = {"version": VERSION, "season": pool["season"], "week": pool["week"],
           "receipts": [rows[rid] for rid in sorted(rows)], "generations": [generation]}
    # Detach every nested source object: callers cannot mutate captured history.
    doc = json.loads(json.dumps(doc, allow_nan=False))
    doc["envelope_id"] = lr.fingerprint(doc)
    return doc, json.loads(json.dumps(snapshots, allow_nan=False))


def generation_path(snapshot_dir, manifest):
    digest = lr.fingerprint(manifest).split(":", 1)[1]
    return os.path.join(snapshot_dir, "learning_journal",
                        "%d_wk%02d" % (manifest["season"], manifest["week"]), digest + ".json")


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _immutable_write(path, doc):
    """Publish atomically without overwriting. Conflicting content fails closed."""
    if os.path.exists(path):
        if _load(path) != doc:
            raise ValueError("immutable learning snapshot conflict: " + path)
        return False
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                     prefix=".learning-", delete=False) as fh:
        temporary = fh.name
        try:
            json.dump(doc, fh, ensure_ascii=True, allow_nan=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        except BaseException:
            os.unlink(temporary)
            raise
    try:
        try:
            os.link(temporary, path)  # exclusive + atomic; a competing writer cannot be replaced
        except FileExistsError:
            if _load(path) != doc:
                raise ValueError("immutable learning snapshot conflict: " + path)
            return False
    finally:
        os.unlink(temporary)
    return True


def record(pool, schedule, calibration, records, recorded_utc, snapshot_dir):
    """Persist before display dedupe; an exact replay preserves original times.

Returns (envelope, added). No existing record is updated, including rejected
generations. A receipt seen in multiple generations remains one forecast for
learning; adapters must dedupe by receipt_id and preserve earliest capture time.
"""
    manifest, snapshots = _manifest(pool, schedule, calibration, records)
    path = generation_path(snapshot_dir, manifest)
    if os.path.exists(path):
        doc = _load(path)
        if (doc.get("envelope_id") != lr.fingerprint({k: v for k, v in doc.items() if k != "envelope_id"})
                or len(doc.get("generations", [])) != 1
                or any(doc["generations"][0].get(k) != v for k, v in manifest.items())):
            raise ValueError("invalid immutable learning envelope: " + path)
        for digest, value in snapshots.items():
            source = os.path.join(snapshot_dir, "learning_sources", digest.split(":", 1)[1] + ".json")
            if not os.path.exists(source) or _load(source) != value:
                raise ValueError("missing or conflicting learning source snapshot: " + source)
        return doc, False
    doc, snapshots = capture(pool, schedule, calibration, records, recorded_utc)
    for digest, value in snapshots.items():
        _immutable_write(os.path.join(snapshot_dir, "learning_sources", digest.split(":", 1)[1] + ".json"), value)
    added = _immutable_write(path, doc)
    return doc, added
