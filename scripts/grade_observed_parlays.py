#!/usr/bin/env python3
"""Grade retained public parlay cards against a verified raw outcome capture."""
import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
from math import log
from pathlib import Path
import re
import sys
from statistics import fmean

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import capture_outcome_evidence as capture
from scripts.build_review import direct_leg_grader, parlay_result
from scripts.learning_receipts import fingerprint, instant
from scripts.observe_parlay_offers import NAMES, classify_offers
from scripts.player_outcomes import context, identity_maps
from scripts.resolve_parlay_legs import index_snaps


def read_observation(path):
    evidence = json.loads(path.read_bytes())
    body = {key: value for key, value in evidence.items() if key != "observation_id"}
    if (body.get("kind") != "nfl.public_parlay_observation.v1"
            or body.get("version") != 1 or fingerprint(body) != evidence["observation_id"]):
        raise ValueError("invalid_public_parlay_observation")
    inputs = {}
    for name in NAMES:
        digest = evidence["objects_sha256"][name]
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid_public_parlay_source_digest")
        raw = (path.parent / (digest + ".bin")).read_bytes()
        if sha256(raw).hexdigest() != digest:
            raise ValueError("public_parlay_source_changed")
        inputs[name] = json.loads(raw)
    slate, schedule = (inputs[name] for name in NAMES)
    if (classify_offers(slate, schedule, evidence["observed_completed_utc"]) != evidence["cards"]
            or any(slate[key] != evidence[key] for key in ("season", "week"))):
        raise ValueError("public_parlay_observation_membership_changed")
    return evidence, slate, schedule


def grade_cards(evidence, slate, schedule, observed_games, stats, snaps, roster):
    week = evidence["week"]
    scheduled = {str(game["game_id"]): game for game in schedule["games"] if game["week"] == week}
    finals = {}
    identities_refused = set()
    for row in observed_games:
        gid = row["game_id"]
        game = scheduled.get(gid)
        if not game or not row["final"]:
            continue
        if ((row["home"], row["away"], instant(row["kickoff_utc"]))
                != (game["home"], game["away"], instant(game["kickoff_utc"]))
                or instant(row["observed_utc"]) < instant(game["kickoff_utc"])):
            identities_refused.add(gid)
            continue
        finals[gid] = row
    grade = direct_leg_grader(scheduled, finals, stats, index_snaps(snaps), None,
                              context(scheduled.values(), finals, evidence["season"], identity_maps(roster)))
    counts = defaultdict(Counter)
    rows = []
    for original, reference in zip(slate["parlays"], evidence["cards"]):
        if not reference["pre_kickoff_observed"]:
            continue
        legs = []
        for term, gid in zip(original["legs"], reference["game_ids"]):
            game = scheduled[gid]
            if gid not in finals:
                outcome, actual = "pending", None
                reason = "final_fixture_mismatch" if gid in identities_refused else "no_verified_final"
            else:
                bound = {**term, "game_id": gid, "season": evidence["season"]}
                if term["market"] == "moneyline":
                    bound["side"] = "home" if term["selection"] == game["home"] + " ML" else "away"
                outcome, actual, reason = grade(bound, gid, week) or ("pending", None, "unsupported_market")
            legs.append({"game_id": gid, "market": term["market"], "selection": term["selection"],
                         "outcome": outcome, "actual": actual, "reason": reason})
        results = [leg["outcome"] for leg in legs]
        verdict = {"hit": "full_hit", "miss": "loss", "pending": "pending", "void": "void"}[parlay_result(results)]
        if verdict == "void" and "hit" in results:
            verdict = "reduced"
        counts[reference["scope"]][verdict] += 1
        rows.append({"offer_sha256": reference["offer_sha256"], "scope": reference["scope"],
                     "card_id": reference["card_id"], "result": verdict, "legs": legs})
    return {"by_scope": dict(counts), "cards": rows, "rejected_fixture_ids": sorted(identities_refused)}


def _score_published_cards(rows):
    scored = [row for row in rows if row["exclusion"] is None]
    expected = [row["joint_model_prob"] for row in scored]
    actual = [row["full_hit"] for row in scored]
    games = Counter(gid for row in scored for gid in set(row["game_ids"]))

    def loss(probability, hit):
        correct_probability = probability if hit else 1 - probability
        return -log(max(1e-15, correct_probability))

    return {
        "eligible_offers": len(rows),
        "recorded_joint_probability_count": sum(row["joint_model_prob"] is not None for row in rows),
        "all_legs_binary_count": sum(row["full_hit"] is not None for row in rows),
        "scored_count": len(scored),
        "expected_full_hits": sum(expected) if scored else None,
        "observed_full_hits": sum(actual) if scored else None,
        "brier": fmean((p - hit) ** 2 for p, hit in zip(expected, actual)) if scored else None,
        "log_loss": fmean(loss(p, hit) for p, hit in zip(expected, actual)) if scored else None,
        "scored_game_count": len(games),
        "max_scored_card_share_one_game": max(games.values()) / len(scored) if games else None,
        "exclusions": dict(Counter(row["exclusion"] for row in rows if row["exclusion"] is not None)),
    }


def summarize_published_calibration(evidence, slate, grades):
    """Score immutable joint probabilities on the original full-card terms."""
    offers = {reference["offer_sha256"]: card for reference, card in zip(evidence["cards"], slate["parlays"])
              if reference["pre_kickoff_observed"]}
    rows, by_scope, by_size = [], defaultdict(list), defaultdict(list)
    for grade in grades:
        card = offers[grade["offer_sha256"]]
        probability = card.get("joint_model_prob")
        if type(probability) not in (int, float) or not 0 <= probability <= 1:
            probability = None
        outcomes = [leg["outcome"] for leg in grade["legs"]]
        binary = bool(outcomes) and all(outcome in ("hit", "miss") for outcome in outcomes)
        if not binary:
            exclusion = "void_leg" if "void" in outcomes else "unresolved_leg"
        else:
            exclusion = "missing_recorded_joint_probability" if probability is None else None
        row = {
            "offer_sha256": grade["offer_sha256"], "scope": grade["scope"],
            "leg_count": len(outcomes), "game_ids": sorted({leg["game_id"] for leg in grade["legs"]}),
            "joint_model_prob": probability, "full_hit": all(outcome == "hit" for outcome in outcomes) if binary else None,
            "joint_model_version": card.get("offer_lineage", {}).get("joint_model_version"),
            "exclusion": exclusion,
        }
        rows.append(row)
        by_scope[grade["scope"]].append(row)
        by_size[(grade["scope"], len(outcomes))].append(row)
    return {
        "probability_basis": "recorded_joint_model_prob",
        "score_population": "observed_published_cards_with_binary_outcomes_for_every_original_leg",
        "total": _score_published_cards(rows),
        "by_scope": {scope: _score_published_cards(cards) for scope, cards in sorted(by_scope.items())},
        "by_scope_and_leg_count": [{"scope": scope, "leg_count": size, **_score_published_cards(cards)}
                                   for (scope, size), cards in sorted(by_size.items())],
        "cards": rows,
    }


def evaluate(observation_path, outcome_path, *, calibration=False):
    evidence, slate, schedule = read_observation(observation_path)
    bundle = capture.load_capture(outcome_path)
    outcome = bundle["manifest"]
    if (outcome["season"] != evidence["season"] or evidence["week"] not in outcome["weeks"]
            or instant(outcome["started_utc"]) <= instant(evidence["observed_completed_utc"])):
        raise ValueError("outcome_capture_does_not_follow_observation")
    results = grade_cards(
        evidence, slate, schedule, capture.scoreboard_rows(bundle, evidence["week"]),
        capture.csv_rows(bundle, capture.STATS_PROFILE), capture.csv_rows(bundle, capture.SNAPS_PROFILE),
        capture.csv_rows(bundle, capture.ROSTERS_PROFILE),
    )
    body = {
        "version": 1, "kind": "nfl.public_parlay_grading.v1",
        "observation_id": evidence["observation_id"], "outcome_capture_id": outcome["capture_id"],
        "season": evidence["season"], "week": evidence["week"],
        "excluded_unverified_offers": sum(not row["pre_kickoff_observed"] for row in evidence["cards"]),
        **results, "adoption_approved": False,
    }
    if calibration:
        body.update(kind="nfl.public_parlay_calibration.v1",
                    calibration=summarize_published_calibration(evidence, slate, results["cards"]))
    return {**body, "report_id": fingerprint(body)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observation", type=Path, required=True)
    parser.add_argument("--outcomes", type=Path, required=True)
    parser.add_argument("--calibration", action="store_true", help="include descriptive full-card probability scores")
    parser.add_argument("--report-dir", type=Path, help="retain the result in a local append-only directory")
    args = parser.parse_args()
    try:
        report = evaluate(args.observation, args.outcomes, calibration=args.calibration)
        encoded = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.report_dir:
            directory = args.report_dir.resolve()
            if directory.is_relative_to(ROOT):
                raise ValueError("grading_reports_must_be_outside_repo")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            capture._immutable(directory / (report["report_id"].split(":")[1] + ".json"), encoded.encode())
        print(encoded, end="")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"observed parlay grading refused: {exc}\n")


if __name__ == "__main__":
    main()
