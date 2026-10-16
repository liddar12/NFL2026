#!/usr/bin/env python3
"""Opt-in exact public MY-content observations; not deployment attestation.

Default CLI is a local plan: no network, credential reads or writes. A public
fetch proves only that these exact bytes were retrieved at fetch completion,
not their first publication, a deploy/SHA identity, global CDN consistency or
what an individual viewer saw. Hashes are integrity identifiers, not signatures.
No source receipt, model, workflow, sports data or API selector is modified.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.request

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts import export_learning as ex, learning_journal as journal, learning_receipts as lr

ORIGIN = "https://nfl2026.netlify.app"
MAX_BYTES = 16 * 1024 * 1024
TIMEOUT = 12
KIND = "nfl.publication_observation.v1"
CACHE_HEADERS = frozenset(("age", "date", "cache-control", "etag", "last-modified", "vary", "x-cache"))


class PublicationError(ValueError):
    """Safe machine code; never a body, supplied URL, credential or header."""


def _raw_hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _instant(value):
    parsed = lr.instant(value)
    if parsed is None or parsed.utcoffset() is None:
        raise PublicationError("invalid_observation_clock")
    return parsed.astimezone(dt.timezone.utc)


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _stamp(clock):
    return _instant(clock()).isoformat(timespec="microseconds").replace("+00:00", "Z")


def source_spec(season, week):
    if type(season) is not int or not 2000 <= season <= 2100 or type(week) is not int or not 1 <= week <= 18:
        raise PublicationError("invalid_publication_period")
    path = "/data/my_cards/%d_wk%02d.json" % (season, week)
    return {"season": season, "week": week, "origin": ORIGIN, "path": path, "url": ORIGIN + path,
            "maximum_bytes": MAX_BYTES, "timeout_seconds": TIMEOUT}


def _read_bytes(path):
    try:
        path = Path(path)
        if path.is_symlink() or not path.is_file():
            raise PublicationError("invalid_frozen_output_path")
        with path.open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise PublicationError("public_output_exceeds_16_mib")
        return raw
    except OSError:
        raise PublicationError("unreadable_frozen_output") from None


def _authority(export_plan, season, week):
    sources = {entry["object_id"]: entry["payload"] for entry in export_plan["source_objects"]}
    receipts, seen_generations = {}, {}
    for item in export_plan["generations"]:
        doc = item["request"]["payload"]
        if (doc["season"], doc["week"]) != (season, week):
            continue
        generation = doc["generations"][0]
        if (type(generation.get("version")) is not int or generation["version"] != 1
                or type(generation.get("season")) is not int or generation["season"] != season
                or type(generation.get("week")) is not int or generation["week"] != week
                or not isinstance(generation.get("offered_cards"), list)
                or not isinstance(generation.get("source_snapshots"), dict)
                or set(generation["source_snapshots"]) != {"leg_pool", "schedule", "parlay_calibration"}
                or not isinstance(generation.get("receipt_ids"), list)
                or generation.get("publication_status") != "generated_unverified"
                or generation.get("population") != "eligible_pool_prop_rungs_before_display_dedupe"):
            raise PublicationError("unsupported_generation_contract")
        for value in [generation["generation_id"], generation.get("selection_policy_version"),
                      generation.get("joint_model_version"), *generation["source_snapshots"].values(),
                      *generation["receipt_ids"]]:
            ex._hash(value)
        _instant(generation.get("recorded_utc"))
        _instant(generation.get("pool_generated_utc"))
        gid = generation["generation_id"]
        if gid in seen_generations:
            if not ex._same_json(seen_generations[gid], doc):
                raise PublicationError("conflicting_generation_envelopes")
            continue  # Exact copies are not a new lineage or observation.
        seen_generations[gid] = doc
        refs = generation["source_snapshots"]
        pool, schedule = sources[refs["leg_pool"]], sources[refs["schedule"]]
        if (not isinstance(pool, dict) or type(pool.get("season")) is not int or pool["season"] != season
                or type(pool.get("week")) is not int or pool["week"] != week
                or not isinstance(pool.get("players"), list)
                or not isinstance(schedule, dict) or not isinstance(schedule.get("games"), list)
                or not ex._same_json(generation["pool_generated_utc"], pool.get("generated_utc"))
                or _instant(generation["recorded_utc"]) < _instant(generation["pool_generated_utc"])):
            raise PublicationError("generation_frozen_source_mismatch")
        games, conflicts = {}, set()
        for game in schedule.get("games", []):
            gid = str(game.get("game_id"))
            if gid in games and not ex._same_json(games[gid], game):
                conflicts.add(gid)
            games[gid] = game
        frozen = {}
        for player in pool.get("players", []):
            for rung in player.get("rungs", []):
                source = rung.get("learning_receipt")
                if isinstance(source, dict) and isinstance(source.get("receipt_id"), str):
                    value = {"receipt": source, "leg": {**player, **rung}}
                    rid = source["receipt_id"]
                    if rid in frozen and not ex._same_json(frozen[rid], value):
                        raise PublicationError("conflicting_frozen_receipt")
                    frozen[rid] = value
        offered = {}
        for card in generation["offered_cards"]:
            if (not isinstance(card, dict) or set(card) != {"card_id", "receipt_ids"}
                    or not isinstance(card["card_id"], str) or not card["card_id"]
                    or not isinstance(card["receipt_ids"], list)
                    or len(set(card["receipt_ids"])) != len(card["receipt_ids"])):
                raise PublicationError("invalid_offered_card_mapping")
            for rid in card["receipt_ids"]:
                ex._hash(rid)
            if card["card_id"] in offered and offered[card["card_id"]] != set(card["receipt_ids"]):
                raise PublicationError("conflicting_offered_card_mapping")
            offered[card["card_id"]] = set(card["receipt_ids"])
        for row in doc["receipts"]:
            source, rid, leg = row["learning_receipt"], row["receipt_id"], row["leg"]
            original = frozen.get(rid)
            game = games.get(str(source.get("game_id")))
            recorded = _instant(row["recorded_utc"])
            if (not ex._same_json(row["recorded_utc"], generation["recorded_utc"])
                    or original is None or not ex._same_json(source, original["receipt"])
                    or lr.receipt_problem(source, original["leg"], season, week)
                    or journal._candidate_problem(leg, source, pool, game,
                        str(source.get("game_id")) in conflicts, recorded)
                    or not ex._same_json(row["kickoff_utc"], game["kickoff_utc"])):
                raise PublicationError("invalid_durable_source_receipt")
            lineage = {"generation_id": generation["generation_id"], "envelope_id": doc["envelope_id"],
                "source_snapshots": refs, "selection_policy_version": generation["selection_policy_version"],
                "joint_model_version": generation["joint_model_version"],
                "generation_sha": source.get("generation_sha"), "base_model_version": source["base_model_version"],
                "calibrator_version": source["calibrator_version"]}
            receipts.setdefault(rid, []).append({"source": source, "leg": leg, "offered": offered,
                "lineage": lineage, "recorded_utc": row["recorded_utc"], "kickoff_utc": row["kickoff_utc"]})
    return receipts


def plan(snapshot_dir, my_cards_path, season, week):
    """Validate local frozen bytes and exact actual-card membership, read-only."""
    spec = source_spec(season, week)
    try:
        graph = ex.plan(snapshot_dir)
        raw = _read_bytes(my_cards_path)
        doc = ex._json(raw)
        if (not isinstance(doc, dict) or type(doc.get("season")) is not int or doc["season"] != season
                or type(doc.get("week")) is not int or doc["week"] != week or not isinstance(doc.get("cards"), list)):
            raise PublicationError("public_output_period_mismatch")
        authority = _authority(graph, season, week)
        members, unsupported, seen = [], [], set()
        for card in doc["cards"]:
            if (not isinstance(card, dict) or not isinstance(card.get("card_id"), str) or not card["card_id"]
                    or card["card_id"] in seen or not isinstance(card.get("legs"), list) or not card["legs"]
                    or ("n_legs" in card and (type(card["n_legs"]) is not int or card["n_legs"] != len(card["legs"])) )):
                raise PublicationError("invalid_or_duplicate_public_card")
            seen.add(card["card_id"])
            for index, leg in enumerate(card["legs"]):
                location = {"card_id": card["card_id"], "leg_index": index}
                if not isinstance(leg, dict):
                    raise PublicationError("invalid_public_leg")
                if leg.get("market") not in lr.PROP_MARKETS:
                    unsupported.append({**location, "reason": "unsupported_market"})
                    continue
                source = leg.get("learning_receipt")
                if source is None:
                    unsupported.append({**location, "reason": "missing_original_learning_receipt"})
                    continue
                if (lr.receipt_problem(source, leg, season, week)
                        or any(leg.get(k) != source.get(k) for k in ("season", "direction", "comparison_operator"))):
                    raise PublicationError("conflicting_public_receipt_identity_or_probability")
                rid = source["receipt_id"]
                known = authority.get(rid, [])
                if not known:
                    unsupported.append({**location, "reason": "no_matching_durable_receipt", "source_receipt_id": rid})
                    continue
                if any(not ex._same_json(source, row["source"]) for row in known):
                    raise PublicationError("conflicting_public_source_receipt")
                matched = {row["lineage"]["generation_id"]: row for row in known
                           if rid in row["offered"].get(card["card_id"], set())}
                if not matched:
                    raise PublicationError("receipt_not_offered_for_public_card")
                if len(matched) != 1:
                    unsupported.append({**location, "reason": "ambiguous_generation_membership", "source_receipt_id": rid})
                    continue
                row = next(iter(matched.values()))
                members.append({**location, "source_receipt_id": rid, "contract_id": source["contract_id"],
                    "canonical_contract": list(lr.canonical_key(leg, season)), "served_prob": source["served_prob"],
                    "forecast_created_utc": source["forecast_created_utc"], "recorded_utc": row["recorded_utc"],
                    "kickoff_utc": row["kickoff_utc"], "lineage": row["lineage"]})
        value = {"version": 1, "kind": "nfl.publication_plan.v1", "season": season, "week": week,
            "origin": spec["origin"], "path": spec["path"], "output_sha256": _raw_hash(raw), "output_bytes": len(raw),
            "membership": members, "unsupported": unsupported,
            "coverage": "exact supported prop legs only; no whole-card, joint-probability or generated-pool attestation",
            "deployment_identity_supported": False, "historical_first_publication_utc": None}
        return {**value, "plan_id": lr.fingerprint(value)}
    except PublicationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        raise PublicationError("invalid_publication_authority") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PublicationError("public_redirect_rejected")


def http_fetcher(spec):
    """Fixed HTTPS origin, no redirects/proxy credentials, identity encoding."""
    if spec != source_spec(spec.get("season"), spec.get("week")):
        raise PublicationError("invalid_public_source_spec")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(spec["url"], method="GET",
        headers={"Accept": "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-cache"})
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            if response.geturl() != spec["url"]:
                raise PublicationError("public_origin_changed")
            return response.status, dict(response.headers.items()), response.read(MAX_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise PublicationError("public_fetch_failed") from None


def _observation(publication_plan, started, completed, http=None):
    end = _instant(completed)
    if end < _instant(started):
        raise PublicationError("observation_clock_regressed")
    expected_url = publication_plan["origin"] + publication_plan["path"]
    http = http or {"status": 200, "final_url": expected_url, "response_cache_headers": {}}
    if (not isinstance(http, dict) or set(http) != {"status", "final_url", "response_cache_headers"}
            or type(http["status"]) is not int or http["status"] != 200 or http["final_url"] != expected_url
            or not isinstance(http["response_cache_headers"], dict)
            or any(k not in CACHE_HEADERS or not isinstance(v, str) or len(v) > 2048
                   for k, v in http["response_cache_headers"].items())):
        raise PublicationError("invalid_public_http_evidence")
    members = []
    for member in publication_plan["membership"]:
        if end < _instant(member["recorded_utc"]):
            raise PublicationError("observation_before_generation_capture")
        members.append({**member, "observed_before_event": end < _instant(member["kickoff_utc"])})
    value = {"version": 1, "kind": KIND, "plan": publication_plan,
        "evidence_class": "content_observed_at_public_origin", "fetch_started_utc": started,
        "observed_utc": completed, "membership": members, "deployment_identity_verified": False,
        "deployment_id": None, "first_publication_utc": None,
        "observed_region": None, "http": http,
        "status": ("no_supported_publication_membership" if not members else "content_observed"
                   if any(m["observed_before_event"] for m in members) else "late_content_observed"),
        "pre_event_receipt_ids": sorted({m["source_receipt_id"] for m in members if m["observed_before_event"]}),
        "limitations": ["not a verified deployment or code-SHA identity", "not proof of actual first publication",
            "not global CDN or individual-viewer evidence", "hashes are not signatures"],
        "original_receipt_status_changed": False}
    return {**value, "observation_id": lr.fingerprint(value)}


def observe(publication_plan, *, snapshot_dir, my_cards_path, fetcher=None, clock=_now, deployment_identity=None):
    """Explicit fetch only. Validate everything before returning any observation."""
    if deployment_identity is not None:
        raise PublicationError("verified_deployment_identity_not_supported")
    try:
        current = plan(snapshot_dir, my_cards_path, publication_plan["season"], publication_plan["week"])
        if not ex._same_json(current, publication_plan):
            raise PublicationError("publication_plan_changed")
        spec = source_spec(current["season"], current["week"])
        started = _stamp(clock)
        status, headers, raw = (fetcher or http_fetcher)(spec)
        completed = _stamp(clock)  # Never use a server header or generated time.
        if type(status) is not int or status != 200:
            raise PublicationError("public_http_status_rejected")
        if not isinstance(raw, bytes) or len(raw) > MAX_BYTES or not isinstance(headers, dict):
            raise PublicationError("invalid_public_response")
        normalized = {}
        for name, value in headers.items():
            if not isinstance(name, str) or not isinstance(value, str) or len(value) > 2048 or len(headers) > 128:
                raise PublicationError("invalid_public_headers")
            key = name.lower()
            if key in normalized and normalized[key] != value:
                raise PublicationError("conflicting_public_headers")
            normalized[key] = value
        if (normalized.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json"
                or normalized.get("content-encoding", "identity").lower() != "identity"):
            raise PublicationError("public_json_content_type_required")
        if "content-length" in normalized and normalized["content-length"] != str(len(raw)):
            raise PublicationError("partial_public_response")
        if _raw_hash(raw) != current["output_sha256"] or len(raw) != current["output_bytes"]:
            raise PublicationError("public_output_bytes_mismatch")
        if not ex._same_json(plan(snapshot_dir, my_cards_path, current["season"], current["week"]), current):
            raise PublicationError("publication_authority_changed_during_fetch")
        http = {"status": status, "final_url": spec["url"],
                "response_cache_headers": {k: normalized[k] for k in sorted(CACHE_HEADERS) if k in normalized}}
        return {"observation": _observation(current, started, completed, http), "raw": raw}
    except PublicationError:
        raise
    except (Exception,):
        raise PublicationError("public_observation_failed") from None


def persist(bundle, out_dir, *, snapshot_dir, my_cards_path):
    """Persist raw bytes then one immutable complete record, never under data/."""
    try:
        observation, raw = bundle["observation"], bundle["raw"]
        expected = _observation(plan(snapshot_dir, my_cards_path,
            observation["plan"]["season"], observation["plan"]["week"]),
            observation["fetch_started_utc"], observation["observed_utc"], observation.get("http"))
        if (not ex._same_json(expected, observation) or not isinstance(raw, bytes)
                or _raw_hash(raw) != expected["plan"]["output_sha256"]):
            raise PublicationError("publication_observation_tampered")
        selected = Path(out_dir).absolute()
        # Normalize only protected, known macOS aliases. General resolve()
        # before inspection would hide a user-controlled root/ancestor link.
        for alias, physical in ((Path("/var"), Path("/private/var")), (Path("/tmp"), Path("/private/tmp"))):
            if (selected.is_relative_to(alias) and alias.is_symlink()
                    and os.lstat(alias).st_uid == 0 and alias.resolve() == physical):
                selected = physical / selected.relative_to(alias)
                break
        if any(component.is_symlink() for component in (selected, *selected.parents)):
            raise PublicationError("publication_output_symlink_rejected")
        output = selected.resolve()
        snapshots = Path(snapshot_dir).resolve()
        sports_data = (_ROOT / "data").resolve()
        if (output.is_relative_to(sports_data) or output == _ROOT or output.is_relative_to(snapshots)
                or snapshots.is_relative_to(output)):
            raise PublicationError("publication_directory_overlaps_authority")
        # _delivery_path checks every directory component against symlink escape.
        target = ex._delivery_path(output, "observations", observation["observation_id"].split(":")[1] + ".json")
        raw_path = ex._delivery_path(output, "raw", expected["plan"]["output_sha256"].split(":")[1] + ".json")
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        ex._delivery_path(output, *raw_path.relative_to(output).parts)
        with tempfile.NamedTemporaryFile(dir=raw_path.parent, prefix=".public-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        try:
            try:
                os.link(temporary, raw_path)
            except FileExistsError:
                if _read_bytes(raw_path) != raw:
                    raise PublicationError("immutable_public_bytes_conflict")
            directory_fd = os.open(raw_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            ex._immutable(target, observation, root=output)
        finally:
            temporary.unlink()
        return {"observation_id": observation["observation_id"], "record_path": str(target),
                "status": observation["status"], "writes": True}
    except PublicationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RuntimeError):
        raise PublicationError("publication_persistence_failed") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshots", required=True)
    parser.add_argument("--my-cards", required=True)
    parser.add_argument("--season", required=True, type=int)
    parser.add_argument("--week", required=True, type=int)
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--out-dir")
    args = parser.parse_args(argv)
    try:
        proposal = plan(args.snapshots, args.my_cards, args.season, args.week)
        if not args.observe:
            result = {"mode": "local_plan", "plan": proposal, "network_used": False, "writes": False}
        else:
            if not args.out_dir:
                raise PublicationError("explicit_output_directory_required")
            bundle = observe(proposal, snapshot_dir=args.snapshots, my_cards_path=args.my_cards)
            result = {"mode": "observed_content", **persist(bundle, args.out_dir,
                snapshot_dir=args.snapshots, my_cards_path=args.my_cards), "network_used": True}
        print(json.dumps(result, ensure_ascii=True, allow_nan=False))
        return 3 if args.observe and result["status"] == "no_supported_publication_membership" else 0
    except PublicationError as exc:
        # An interrupted persistence may leave an unreferenced raw object;
        # never claim that no writes happened after explicit observation.
        print(json.dumps({"ok": False, "reason": str(exc), "complete_success": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
