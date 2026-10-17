#!/usr/bin/env python3
"""Read-only R126 source audit and explicit frozen-candidate experiments.

Default weeks2–5 historical metrics are unavailable: shipped-card archives and
their leg ledger do not establish the complete candidate universe. No archive
union, current feature reconstruction, parameter fit, network or adoption path.
Synthetic and local-Git experiments are separate from historical acceptance.
Git committer/capture clocks are mutable claims, not independent as-of or
public-availability proof; a content hash is not a timestamp or signature.
"""
import argparse
import ast
from collections import Counter
import datetime as dt
import hashlib
import inspect
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scripts import export_learning as ex
from scripts.models import parlay_builder as pb

LIMIT = 8 * 1024 * 1024
MARKETS = frozenset(("moneyline", "spread", "qb_pass_yds", "rb_rush_yds", "wr_rec_yds"))
R74_REFERENCE = "bb6ae6ed94389f8435038ced244afae27bb7754f"
_SHA = re.compile(r"[0-9a-f]{40}\Z")


class ReplayError(ValueError):
    """Safe machine code, not raw Git diagnostics, paths or JSON content."""


def _raw_hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _clock(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc)
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise ReplayError("invalid_capture_clock") from None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _bet_key(legs, game_id):
    # Use the exact contract the protected builder actually emits, not capture
    # metadata/candidate IDs or raw labels. _strip_leg retains public side/line/
    # GSIS identity, while parlay_bet_key normalizes labels and leg ordering.
    return pb.parlay_bet_key({"scope": "game", "game_id": game_id,
                              "legs": [pb._strip_leg(leg) for leg in legs]})


def _read(path):
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ReplayError("input_exceeds_8_mib")
        return ex._json(raw), _raw_hash(raw)
    except ReplayError:
        raise
    except (ValueError, OSError):
        raise ReplayError("unreadable_or_invalid_replay_input") from None


def runtime_versions():
    return {"ranking_runtime_sha256": _raw_hash(Path(pb.__file__).read_bytes()),
        "replay_runtime_sha256": _raw_hash(Path(__file__).read_bytes()),
        "r126_ranker_sha256": _raw_hash(inspect.getsource(pb._rank_game_pairs).encode()),
        "r126_builder_sha256": _raw_hash(inspect.getsource(pb.build_game_parlays).encode()),
        "r74_reference_commit": R74_REFERENCE,
        "r74_control": "legal pairs sorted by (-abs(rho), -EV, original_i, original_j)",
        "r126_policy": "actual _rank_game_pairs; non-spread first; spread fallback only if fewer than 3 pairs and spread exists"}


def audit_sources(data_dir, weeks=(2, 3, 4, 5), season=2026):
    """Explain available artifacts without upgrading offered subsets to pools."""
    if (type(season) is not int or not isinstance(weeks, (list, tuple)) or not weeks
            or any(type(w) is not int or not 1 <= w <= 18 for w in weeks) or len(set(weeks)) != len(weeks)):
        raise ReplayError("invalid_audit_period")
    root = Path(data_dir)
    rows = []
    for week in weeks:
        evidence = []
        for name, population in ((f"parlays/{season}_wk{week:02d}.json", "shipped cards, not full candidates"),
                (f"snapshots/{season}_wk{week:02d}_games_open.json", "game predictions, not prop candidates"),
                (f"estimates/parlays_{season}.json", "first-seen shipped legs, not full candidates"),
                ("parlay_backtest.json", "current calibration; not an automatically valid historical correlation snapshot")):
            path = root / name
            if path.is_file():
                value, digest = _read(path)
                evidence.append({"path": name, "sha256": digest, "population": population,
                    "generated_utc": value.get("generated_utc") if isinstance(value, dict) else None})
            else:
                evidence.append({"path": name, "sha256": None, "population": population})
        rows.append({"season": season, "week": week, "status": "unavailable",
            "historical_metrics": None, "historical_acceptance_eligible": False,
            "exclusions": {"complete_frozen_candidate_authority_missing": 1,
                           "independent_pre_kickoff_capture_evidence_missing": 1}, "source_evidence": evidence})
    return {"version": 1, "scope": "historical_complete_candidate_availability_audit", "weeks": rows,
        "prior_rca_claim": {"status": "historical_claim_not_reverified",
            "source": "docs/qa/RCA_2026-10-15_PARLAY_ACCURACY.md section10",
            "claim": "59/188 -> 72/189 was an on-card-leg-union replay, not complete-candidate replay"},
        "fixed_leg_rescoring": "not performed; frozen probabilities are never changed",
        "selection_comparison": "only explicit complete-candidate experiments below", "runtime": runtime_versions()}


def _git(repo, args):
    try:
        # Unsupported Git versions fail closed rather than risk a promisor
        # object lazily fetching from a remote or consulting a credential helper.
        result = subprocess.run(["git", "--no-lazy-fetch", "--no-replace-objects", "-C", str(repo), *args], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=10, check=False)
        if result.returncode or len(result.stdout) > LIMIT:
            raise ReplayError("git_capture_evidence_unavailable")
        return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        raise ReplayError("git_capture_evidence_unavailable") from None


def _provenance(payload, provenance, repo):
    if provenance == {"profile": "synthetic_fixture_v1"}:
        return {"input_class": "synthetic_fixture", "capture_clock_basis": "explicit synthetic test clock",
                "historical_acceptance_eligible": False}
    if (not isinstance(provenance, dict) or set(provenance) != {"profile", "commit", "path"}
            or provenance["profile"] != "local_git_complete_candidates_v1"
            or not isinstance(provenance["commit"], str) or not _SHA.fullmatch(provenance["commit"])
            or not isinstance(provenance["path"], str)):
        raise ReplayError("unsupported_candidate_provenance")
    path = PurePosixPath(provenance["path"])
    if (path.is_absolute() or ".." in path.parts or not path.parts or ":" in str(path)
            or str(path) != provenance["path"] or not re.fullmatch(r"[A-Za-z0-9_./-]{1,255}", str(path))):
        raise ReplayError("invalid_git_capture_path")
    revision = provenance["commit"] + ":" + str(path)
    try:
        size = int(_git(repo, ["cat-file", "-s", revision]))
    except ValueError:
        raise ReplayError("invalid_git_capture_size") from None
    if not 0 < size <= LIMIT:
        raise ReplayError("git_capture_exceeds_bound")
    raw = _git(repo, ["show", revision])
    try:
        stored = ex._json(raw)
    except ValueError:
        raise ReplayError("invalid_git_capture_payload") from None
    if not ex._same_json(stored, payload):
        raise ReplayError("git_capture_payload_mismatch")
    code_ref = provenance["commit"] + ":scripts/models/parlay_builder.py"
    if not 0 < int(_git(repo, ["cat-file", "-s", code_ref])) <= LIMIT:
        raise ReplayError("git_policy_source_exceeds_bound")
    code = _git(repo, ["show", code_ref])
    try:
        text = code.decode("utf-8")
        lines = text.splitlines(keepends=True)
        policies = [node for node in ast.parse(text).body if isinstance(node, ast.FunctionDef) and node.name == "build_game_parlays"]
        if len(policies) != 1:
            raise ValueError()
        policy = policies[0]
        policy_hash = _raw_hash("".join(lines[policy.lineno - 1:policy.end_lineno]).encode())
    except (ValueError, SyntaxError, UnicodeError):
        raise ReplayError("invalid_frozen_policy_source") from None
    if payload["code_version"] != _raw_hash(code) or payload["policy_version"] != policy_hash:
        raise ReplayError("frozen_code_or_policy_hash_mismatch")
    stamp = _git(repo, ["show", "-s", "--format=%cI", provenance["commit"]]).decode().strip()
    if not _clock(payload["captured_utc"]) <= _clock(stamp) < _clock(payload["kickoff_utc"]):
        raise ReplayError("git_capture_not_recorded_before_kickoff")
    return {"input_class": "local_git_content_replay", "commit": provenance["commit"],
        "path": str(path), "blob_sha256": _raw_hash(raw), "git_committer_utc": stamp,
        "capture_clock_basis": "mutable Git committer timestamp and payload claim; not independent as-of proof",
        "historical_acceptance_eligible": False}


def _capture(entry, repo):
    if not isinstance(entry, dict) or set(entry) != {"payload", "provenance"}:
        raise ReplayError("invalid_capture_envelope")
    value = entry["payload"]
    required = {"version", "season", "week", "game_id", "captured_utc", "kickoff_utc", "population",
                "candidates", "correlations", "correlation_available_utc", "code_version", "policy_version", "manifest_id"}
    if (not isinstance(value, dict) or set(value) != required or type(value["version"]) is not int or value["version"] != 1
            or type(value["season"]) is not int or not 2000 <= value["season"] <= 2100
            or type(value["week"]) is not int or not 1 <= value["week"] <= 18
            or not isinstance(value["game_id"], str) or not value["game_id"]
            or value["population"] != "complete_builder_candidates"
            or value["manifest_id"] != ex.fingerprint({k: v for k, v in value.items() if k != "manifest_id"})
            or not isinstance(value["candidates"], list) or not 1 <= len(value["candidates"]) <= 100):
        raise ReplayError("invalid_complete_candidate_manifest")
    for digest in (value["code_version"], value["policy_version"]):
        ex._hash(digest)
    if not _clock(value["correlation_available_utc"]) <= _clock(value["captured_utc"]) < _clock(value["kickoff_utc"]):
        raise ReplayError("candidate_or_correlation_not_frozen_before_kickoff")
    seen = set()
    for leg in value["candidates"]:
        if (not isinstance(leg, dict) or leg.get("market") not in MARKETS
                or not isinstance(leg.get("selection"), str) or not leg["selection"]
                or leg.get("_corr_tag") != leg["market"] or leg.get("_side") not in ("home", "away")
                or ("side" in leg and leg["side"] != leg["_side"])
                or (leg.get("line") is not None and not _number(leg["line"]))
                or (leg.get("gsis_id") is not None and (not isinstance(leg["gsis_id"], str) or not leg["gsis_id"]))
                or any(not _number(leg.get(k)) or not 0 < leg[k] < 1 for k in ("model_prob", "implied_prob"))
                or leg.get("candidate_id") != ex.fingerprint({k: v for k, v in leg.items() if k != "candidate_id"})):
            raise ReplayError("invalid_frozen_candidate")
        identity = _bet_key([leg], value["game_id"])
        if identity in seen:
            raise ReplayError("duplicate_frozen_candidate")
        seen.add(identity)
    correlations = value["correlations"]
    if (not isinstance(correlations, dict) or not isinstance(correlations.get("pairs"), list)
            or not correlations["pairs"] or not _number(correlations.get("default_rho"))
            or not -.95 <= correlations["default_rho"] <= .95):
        raise ReplayError("explicit_frozen_correlations_required")
    rules = set()
    for pair in correlations["pairs"]:
        if not isinstance(pair, dict) or not isinstance(pair.get("key"), str):
            raise ReplayError("invalid_frozen_correlation")
        parts = pair["key"].split("|")
        if (len(parts) not in (2, 3) or any(p not in MARKETS for p in parts[:2])
                or (len(parts) == 3 and parts[2] != "opposing") or not _number(pair.get("rho"))
                or not -.95 <= pair["rho"] <= .95):
            raise ReplayError("invalid_frozen_correlation")
        key = (frozenset(parts[:2]), len(parts) == 3)
        if key in rules:
            raise ReplayError("duplicate_frozen_correlation")
        rules.add(key)
    return value, _provenance(value, entry["provenance"], repo)


def select_candidates(payload):
    """No outcomes argument: neither policy may select using settled results."""
    legs = payload["candidates"]
    corr = pb._correlation_table({"correlations": payload["correlations"]})
    nonspread = [leg for leg in legs if leg["market"] != "spread"]
    ranked = pb._rank_game_pairs(nonspread, corr)
    r126_pool = nonspread
    if len(ranked) < 3 and len(nonspread) < len(legs):
        ranked = pb._rank_game_pairs(legs, corr)
        r126_pool = legs
    control = []
    for i in range(len(legs)):
        for j in range(i + 1, len(legs)):
            if pb.same_side_game_pair(legs[i], legs[j]):
                continue
            model, implied = pb._combined_probs([legs[i], legs[j]], correlated=True, corr=corr)
            control.append((-abs(pb._pair_rho(legs[i], legs[j], corr)), -(model / implied - 1), i, j, [legs[i], legs[j]]))
    control.sort(key=lambda row: row[:4])
    def distinct_output(ranking, pool):
        # Exact protected builder singleton top-up, followed by the shipped
        # document's distinct-actual-bet guard. Never synthesize duplicate wins.
        raw = [r[4] for r in ranking[:3]]
        index = len(raw)
        while len(raw) < 3 and pool:
            raw.append([pool[index % len(pool)]])
            index += 1
        seen, cards = set(), []
        for card in raw:
            key = _bet_key(card, payload["game_id"])
            if key not in seen:
                seen.add(key); cards.append(card)
        return cards
    return {"r126": distinct_output(ranked, r126_pool), "r74_control": distinct_output(control, legs)}


def _grade(cards, outcomes, payload):
    counts, detail = Counter(), []
    for pair in cards:
        rows = [outcomes.get((payload["week"], payload["game_id"], leg["candidate_id"])) for leg in pair]
        if any(row is None or row["status"] == "UNRESOLVED" for row in rows):
            raise ReplayError("selected_outcome_unresolved")
        decided = [row for row in rows if row["status"] == "FINAL"]
        result = "all_void" if not decided else "loss" if any(not row["hit"] for row in decided) else "reduced_win" if len(decided) < len(rows) else "full_win"
        counts[result] += 1
        joint = pb._combined_probs(pair, correlated=True, corr=pb._correlation_table({"correlations": payload["correlations"]}))[0]
        detail.append({"candidate_ids": [leg["candidate_id"] for leg in pair], "joint_model_probability": joint, "result": result})
    return {"settlement_wins": counts["full_win"] + counts["reduced_win"],
        "settlement_graded_cards": len(cards) - counts["all_void"],
        "full_contract_hits": counts["full_win"], "distinct_selected_cards": len(cards),
        **{k: counts[k] for k in ("full_win", "reduced_win", "loss", "all_void")}, "cards": detail}


def replay(bundle, *, repo_dir=_ROOT):
    """Explicit experiments; never a qualified historical acceptance result."""
    try:
        if (not isinstance(bundle, dict) or set(bundle) != {"version", "kind", "captures", "outcomes"}
                or type(bundle["version"]) is not int or bundle["version"] != 1
                or bundle["kind"] != "nfl.r126_replay_bundle.v1" or not isinstance(bundle["captures"], list)
                or not isinstance(bundle["outcomes"], list) or len(bundle["captures"]) > 1000):
            raise ReplayError("unsupported_replay_bundle")
        outcomes = {}
        for row in bundle["outcomes"]:
            if (not isinstance(row, dict) or set(row) != {"week", "game_id", "candidate_id", "status", "hit", "available_utc", "source_id"}
                    or type(row["week"]) is not int or not 1 <= row["week"] <= 18
                    or not isinstance(row["game_id"], str) or row["status"] not in ("FINAL", "VOID", "UNRESOLVED")
                    or (type(row["hit"]) is not bool if row["status"] == "FINAL" else row["hit"] is not None)):
                raise ReplayError("invalid_outcome_snapshot")
            ex._hash(row["candidate_id"]); ex._hash(row["source_id"]); _clock(row["available_utc"])
            key = (row["week"], row["game_id"], row["candidate_id"])
            if key in outcomes:
                raise ReplayError("duplicate_outcome_snapshot")
            outcomes[key] = row
        experiments, exclusions, seen, seasons = [], [], set(), set()
        for entry in bundle["captures"]:
            value, provenance = _capture(entry, repo_dir)
            event = (value["season"], value["week"], value["game_id"])
            if event in seen:
                raise ReplayError("duplicate_event_capture")
            seen.add(event)
            seasons.add(value["season"])
            if len(seasons) != 1:
                raise ReplayError("mixed_season_bundle")
            selection = select_candidates(value)
            try:
                for row in outcomes.values():
                    if (row["week"], row["game_id"]) == (value["week"], value["game_id"]) and _clock(row["available_utc"]) < _clock(value["kickoff_utc"]):
                        raise ReplayError("outcome_before_event")
                grades = {policy: _grade(cards, outcomes, value) for policy, cards in selection.items()}
            except ReplayError as exc:
                exclusions.append({"season": value["season"], "week": value["week"], "game_id": value["game_id"], "reason": str(exc)})
                continue
            experiments.append({"season": value["season"], "week": value["week"], "game_id": value["game_id"],
                "cohort_id": ex.fingerprint({"manifest_id": value["manifest_id"], "outcomes": [outcomes[k] for k in sorted(outcomes) if k[:2] == event[1:]]}),
                "manifest_id": value["manifest_id"], "candidate_input_id": ex.fingerprint(value["candidates"]),
                "correlation_input_id": ex.fingerprint(value["correlations"]), "kickoff_utc": value["kickoff_utc"],
                "captured_utc": value["captured_utc"], "code_version": value["code_version"], "policy_version": value["policy_version"],
                "provenance": provenance, "historical_acceptance_eligible": False, "policies": grades,
                "candidate_coverage": {policy: {"requested_slots": 3, "distinct_cards": len(cards),
                    "shortfall": 3 - len(cards)} for policy, cards in selection.items()},
                "settlement_winner_difference": grades["r126"]["settlement_wins"] - grades["r74_control"]["settlement_wins"],
                "full_contract_hit_difference": grades["r126"]["full_contract_hits"] - grades["r74_control"]["full_contract_hits"]})
        return {"version": 1, "bundle_id": ex.fingerprint(bundle), "runtime": runtime_versions(),
            "experiments": experiments, "exclusions": exclusions, "historical_acceptance_eligible": False,
            "metric_basis": {"settlement": "reduced wins included; all-VOID cards excluded from settlement denominator",
                "full_contract": "only every-original-leg-hit counts; denominator is all distinct selected cards, including VOID",
                "authority": "frozen-candidate experiment, not a verified as-offered/publication record"},
            "fixed_leg_rescoring": "not performed; identical frozen probabilities under both selection policies",
            "limits": ["no full historical pipeline or feature reconstruction", "no refit or adoption", "Git timestamps are not independent availability proof", "cards share outcomes; no independence or causal lift claim"]}
    except ReplayError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ReplayError("malformed_replay_input") from None


def persist(report, path, *, source_roots=()):
    if not isinstance(report, dict) or report.get("report_id") != ex.fingerprint({k: v for k, v in report.items() if k != "report_id"}):
        raise ReplayError("invalid_report_identity")
    selected = Path(path).absolute()
    for alias, physical in ((Path("/var"), Path("/private/var")), (Path("/tmp"), Path("/private/tmp"))):
        if selected.is_relative_to(alias) and alias.is_symlink() and os.lstat(alias).st_uid == 0 and alias.resolve() == physical:
            selected = physical / selected.relative_to(alias)
            break
    if any(p.is_symlink() for p in (selected, *selected.parents)):
        raise ReplayError("replay_output_symlink_rejected")
    target = selected.resolve()
    authority_roots = [(_ROOT / "data").resolve(), *(Path(root).resolve() for root in source_roots)]
    if any(target.is_relative_to(root) for root in authority_roots) or target.is_dir():
        raise ReplayError("replay_output_inside_data_or_directory")
    try:
        ex._immutable(target, report, root=target.parent)
    except (ValueError, OSError):
        raise ReplayError("immutable_replay_report_conflict") from None
    return str(target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=str(_ROOT / "data"))
    parser.add_argument("--bundle")
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    try:
        report = audit_sources(args.data_dir)
        if args.bundle:
            bundle, raw_id = _read(args.bundle)
            report["explicit_experiment"] = {"source_sha256": raw_id, **replay(bundle)}
        report["report_id"] = ex.fingerprint(report)
        if args.out:
            persist(report, args.out, source_roots=(args.data_dir,))
        print(json.dumps(report, ensure_ascii=True, allow_nan=False))
        return 0
    except (ReplayError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, ReplayError) else "invalid_replay_input"
        print(json.dumps({"ok": False, "reason": reason}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
