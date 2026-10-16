#!/usr/bin/env python3
"""Retained-Git ON-CARD R126 reference, not a full-candidate historical test.

Reconstruct RCA section10 using last retained pre-kickoff data/parlays.json
trees and their own frozen correlations. Pin outcomes to the explicit reference
tree. Git clocks are mutable claims, not independent publication/as-of proof.
Legacy no_stat_line -> VOID is a reproduction convention, not verified DNP.
Default stdout only; --out is immutable and must be outside the source repo.
No network, old-code execution, refits, current calibration or deployment.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scripts import export_learning as ex
from scripts import replay_r126 as replay

RCA_REFERENCE = "fb8830ae35f1e11d3f589b435e303b719886e3e7"
PROPS = frozenset(("qb_pass_yds", "rb_rush_yds", "wr_rec_yds"))
FINAL = frozenset(("STATUS_FINAL", "STATUS_FINAL_OVERTIME"))
LEGACY_VOID = frozenset(("no_stat_line", "push", "tie", "did_not_play"))
Error = replay.ReplayError


def _blob(repo, revision, path, cache):
    key = (revision, path)
    if key not in cache:
        ref = revision + ":" + path
        try:
            size = int(replay._git(repo, ["cat-file", "-s", ref]))
        except ValueError:
            raise Error("reference_blob_unavailable") from None
        if not 0 < size <= replay.LIMIT:
            raise Error("reference_blob_exceeds_bound")
        raw = replay._git(repo, ["show", ref])
        try:
            value = ex._json(raw) if path.endswith(".json") else None
        except ValueError:
            raise Error("invalid_reference_json") from None
        cache[key] = (value, replay._raw_hash(raw))
    return cache[key]


def _indexed(rows, key):
    out = {}
    for row in rows:
        if not isinstance(row, dict):
            raise Error("malformed_outcome_row")
        out.setdefault(key(row), []).append(row)
    return out


def _leg_key(week, game_id, leg):
    return (week, str(game_id), leg.get("market"), leg.get("selection"))


def _one(rows):
    # Exact duplicate copies are harmless, conflicting immutable evidence is not.
    unique = {ex.fingerprint(row): row for row in rows}
    if len(unique) != 1:
        raise Error("ambiguous_outcome_evidence")
    return next(iter(unique.values()))


def _outcomes(schedule, review, scores, season, weeks):
    if (not isinstance(schedule, dict) or schedule.get("season") != season
            or not isinstance(review, dict) or review.get("season") != season
            or not isinstance(scores, dict) or scores.get("season") != season):
        raise Error("outcome_period_mismatch")
    events, finals, fallback = {}, {}, {}
    for game in schedule.get("games") or []:
        if game.get("week") not in weeks:
            continue
        gid = str(game["game_id"])
        event = {k: game[k] for k in ("game_id", "week", "home", "away", "kickoff_utc")}
        if (type(event["week"]) is not int or not gid or not isinstance(event["home"], str)
                or not isinstance(event["away"], str) or event["home"] == event["away"]):
            raise Error("invalid_reference_event")
        replay._clock(event["kickoff_utc"])
        if gid in events and not ex._same_json(events[gid], event):
            raise Error("conflicting_reference_event")
        events[gid] = event
    for week in weeks:
        page = (review.get("weeks") or {}).get(str(week)) or {}
        for game in page.get("games") or []:
            gid = str(game.get("game_id"))
            fin = game.get("final") or {}
            values = (fin.get("home_score"), fin.get("away_score"))
            if (game.get("status") not in FINAL or any(type(v) is not int or v < 0 for v in values)):
                continue
            row = {k: game.get(k) for k in ("home", "away", "kickoff_utc")}
            row.update(home_score=values[0], away_score=values[1], week=week)
            if gid in finals and not ex._same_json(finals[gid], row):
                raise Error("conflicting_reference_final")
            finals[gid] = row
        for card in page.get("parlays") or []:
            for leg in card.get("legs") or []:
                gid = leg.get("game_id") or card.get("game_id")
                fallback.setdefault(_leg_key(week, gid, leg), []).append(
                    {"result": leg.get("result"), "actual": leg.get("actual"),
                     **{k: leg[k] for k in ("line", "side", "team", "gsis_id") if k in leg}})
    key = lambda row: _leg_key(row.get("week"), row.get("game_id"), row)
    return events, finals, _indexed(scores.get("resolved") or [], key), _indexed(scores.get("unresolved") or [], key), fallback


def _union(cards, game_id):
    """First occurrence order, exact unchanged prices; never a sorted/set pool."""
    candidates, known = [], {}
    for card in cards:
        if not isinstance(card.get("legs"), list) or not card["legs"]:
            raise Error("missing_on_card_legs")
        for source in card["legs"]:
            if (not isinstance(source, dict) or source.get("market") not in replay.MARKETS
                    or not isinstance(source.get("selection"), str) or not source["selection"]
                    or source.get("side") not in ("home", "away")
                    or (source.get("game_id") is not None and str(source["game_id"]) != game_id)
                    or any(not replay._number(source.get(k)) or not 0 < source[k] < 1 for k in ("model_prob", "implied_prob"))
                    or (source.get("line") is not None and not replay._number(source["line"]))
                    or (source.get("gsis_id") is not None and (not isinstance(source["gsis_id"], str) or not source["gsis_id"]))):
                raise Error("unsupported_or_malformed_on_card_contract")
            leg = {**source, "_side": source["side"], "_corr_tag": source["market"]}
            contract = replay._bet_key([leg], game_id)
            if contract in known:
                if not ex._same_json(known[contract], source):
                    raise Error("conflicting_on_card_contract")
                continue
            known[contract] = source
            leg["candidate_id"] = ex.fingerprint({"game_id": game_id, "source_leg": source})
            candidates.append(leg)
    if not candidates or len(candidates) > 100:
        raise Error("on_card_union_outside_bounds")
    return candidates


def _correlations(calibration, commit_utc):
    if not isinstance(calibration, dict):
        raise Error("explicit_historical_correlations_missing")
    if replay._clock(calibration.get("generated_utc")) > replay._clock(commit_utc):
        raise Error("correlations_not_available_at_capture")
    corr = calibration.get("correlations") or {}
    if not isinstance(corr, dict):
        raise Error("explicit_historical_correlations_missing")
    pairs = corr.get("pairs")
    if (not isinstance(pairs, list) or not pairs or not replay._number(corr.get("default_rho"))
            or abs(corr["default_rho"]) > .95):
        raise Error("explicit_historical_correlations_missing")
    keys = set()
    for row in pairs:
        if not isinstance(row, dict) or not isinstance(row.get("key"), str):
            raise Error("invalid_historical_correlation")
        parts = row.get("key", "").split("|")
        if (len(parts) not in (2, 3) or any(x not in replay.MARKETS for x in parts[:2])
                or (len(parts) == 3 and parts[2] != "opposing")
                or not replay._number(row.get("rho")) or abs(row["rho"]) > .95):
            raise Error("invalid_historical_correlation")
        key = (frozenset(parts[:2]), len(parts) == 3)
        if key in keys:
            raise Error("ambiguous_historical_correlation")
        keys.add(key)
    return corr


def _metadata_conflict(leg, event, row):
    return ((row.get("line") is not None and (not replay._number(row["line"])
                or (leg.get("line") is not None and row["line"] != leg["line"])))
            or (row.get("side") is not None and row["side"] != leg["side"])
            or (row.get("team") is not None and row["team"] != event[leg["side"]])
            or (row.get("gsis_id") is not None and leg.get("gsis_id") is not None and row["gsis_id"] != leg["gsis_id"]))


def _leg_result(leg, event, final, resolved, unresolved, fallback):
    market, selection = leg["market"], leg["selection"]
    if (final is None or final["week"] != event["week"] or any(final[k] != event[k] for k in ("home", "away"))
            or replay._clock(final["kickoff_utc"]) != replay._clock(event["kickoff_utc"])):
        return {"result": "pending", "basis": "missing_or_conflicting_FINAL_evidence"}
    if market in ("moneyline", "spread"):
        match = re.fullmatch(r"([A-Z]{2,3}) (ML|[+-]\d+(?:\.\d+)?)", selection)
        if not match or match[1] not in (event["home"], event["away"]):
            return {"result": "pending", "basis": "unparseable_game_contract"}
        side = "home" if match[1] == event["home"] else "away"
        if side != leg["side"] or (market == "moneyline") != (match[2] == "ML"):
            return {"result": "pending", "basis": "game_contract_side_mismatch"}
        if leg.get("line") is not None and (market == "moneyline" or not replay._number(leg["line"]) or leg["line"] != float(match[2])):
            return {"result": "pending", "basis": "game_contract_line_mismatch"}
        margin = final["home_score"] - final["away_score"]
        margin = margin if side == "home" else -margin
        if market == "spread":
            margin += float(match[2])
        result = "void" if margin == 0 else "hit" if margin > 0 else "miss"
        return {"result": result, "basis": "pinned_review_FINAL_scores", "evidence_id": ex.fingerprint(final)}
    key = _leg_key(event["week"], event["game_id"], leg)
    try:
        hits, pending = resolved.get(key, []), unresolved.get(key, [])
        if hits and pending:
            raise Error("ambiguous_outcome_evidence")
        if hits:
            row = _one(hits)
            if (type(row.get("hit")) is not bool or not replay._number(row.get("actual"))
                    or _metadata_conflict(leg, event, row)
                    or (row.get("line") is not None and row["hit"] != (row["actual"] >= row["line"]))):
                raise Error("malformed_or_different_ledger_contract")
            return {"result": "hit" if row["hit"] else "miss", "basis": "pinned_resolved_prop_ledger", "evidence_id": ex.fingerprint(row)}
        if pending:
            row = _one(pending)
            if _metadata_conflict(leg, event, row):
                raise Error("malformed_or_different_ledger_contract")
            reason = row.get("reason")
            return {"result": "void" if reason in LEGACY_VOID else "pending", "reason": reason,
                "basis": "legacy_ledger_VOID_precedence" if reason in LEGACY_VOID else "pinned_unresolved_prop_ledger",
                "evidence_id": ex.fingerprint(row)}
        if key in fallback:
            row = _one(fallback[key])
            if row.get("result") not in ("hit", "miss", "void", "pending") or _metadata_conflict(leg, event, row):
                raise Error("invalid_review_fallback")
            return {"result": row["result"], "basis": "legacy_review_fallback_no_ledger_row", "evidence_id": ex.fingerprint(row)}
        return {"result": "pending", "basis": "no_legacy_outcome_evidence"}
    except Error as exc:
        return {"result": "pending", "basis": str(exc)}


def _grade(cards, event, evidence):
    counts, rows = Counter(), []
    for card in cards:
        outcomes = [_leg_result(leg, event, *evidence) for leg in card]
        results = [row["result"] for row in outcomes]
        decided = [x for x in results if x != "void"]
        status = ("pending" if "pending" in results else "all_void" if not decided else "loss" if "miss" in decided
                  else "reduced_win" if "void" in results else "full_win")
        counts[status] += 1
        rows.append({"legs": [{"market": leg["market"], "selection": leg["selection"], **outcome}
                              for leg, outcome in zip(card, outcomes)], "result": status})
    return {"distinct_or_as_built_cards": len(cards), "settlement_wins": counts["full_win"] + counts["reduced_win"],
        "settlement_graded_cards": len(cards) - counts["all_void"] - counts["pending"],
        "full_contract_hits": counts["full_win"], **{key: counts[key] for key in ("full_win", "reduced_win", "loss", "all_void", "pending")}, "cards": rows}


def reconstruct(repo_dir=_ROOT, reference=RCA_REFERENCE, season=2026, weeks=(2, 3, 4, 5)):
    """No current data reads: all historical/outcome documents are Git blobs."""
    try:
        if (not isinstance(reference, str) or not replay._SHA.fullmatch(reference) or type(season) is not int
                or not isinstance(weeks, (list, tuple)) or not weeks or len(set(weeks)) != len(weeks)
                or any(type(w) is not int or not 1 <= w <= 18 for w in weeks)):
            raise Error("invalid_reference_request")
        cache = {}
        names = ("schedule_full.json", "review.json", "parlay_leg_scores.json")
        inputs = {name: _blob(repo_dir, reference, "data/" + name, cache) for name in names}
        events, finals, resolved, unresolved, fallback = _outcomes(*(inputs[n][0] for n in names), season, weeks)
        history = []
        for row in replay._git(repo_dir, ["log", "--format=%H %cI", reference, "--", "data/parlays.json"]).decode().splitlines():
            sha, stamp = row.split(" ", 1)
            if not replay._SHA.fullmatch(sha):
                raise Error("invalid_history_revision")
            history.append((replay._clock(stamp), sha, stamp))
        if not history or len(history) > 5000:
            raise Error("retained_history_unavailable_or_excessive")
        root_ids = replay._git(repo_dir, ["rev-list", "--max-parents=0", reference]).decode().splitlines()
        roots = [{"commit": sha, "committer_utc": replay._git(repo_dir, ["show", "-s", "--format=%cI", sha]).decode().strip()} for sha in root_ids]
        games, exclusions = [], []
        for gid, event in sorted(events.items(), key=lambda item: (item[1]["week"], replay._clock(item[1]["kickoff_utc"]), item[0])):
            try:
                eligible = [row for row in history if row[0] < replay._clock(event["kickoff_utc"])]
                if not eligible:
                    raise Error("no_retained_pre_kickoff_snapshot")
                latest = max(row[0] for row in eligible)
                tied = [row for row in eligible if row[0] == latest]
                if len(tied) != 1:
                    raise Error("ambiguous_equal_clock_snapshot")
                _, sha, stamp = tied[0]
                doc, blob_id = _blob(repo_dir, sha, "data/parlays.json", cache)
                if (type(doc.get("season")) is not int or doc["season"] != season or type(doc.get("week")) is not int
                        or doc["week"] != event["week"] or replay._clock(doc.get("updated_utc")) > latest):
                    raise Error("snapshot_period_or_clock_mismatch")
                cards = [c for c in doc.get("parlays") or [] if c.get("scope") == "game" and str(c.get("game_id")) == gid]
                if not cards:
                    raise Error("game_absent_from_last_retained_snapshot")
                candidates = _union(cards, gid)
                cal, cal_id = _blob(repo_dir, sha, "data/parlay_backtest.json", cache)
                corr = _correlations(cal, stamp)
                _, historical_code_id = _blob(repo_dir, sha, "scripts/models/parlay_builder.py", cache)
                selection = replay.select_candidates({"game_id": gid, "candidates": candidates, "correlations": corr})
                policies = {"as_built_git_snapshot": [c["legs"] for c in cards], **selection}
                evidence = (finals.get(gid), resolved, unresolved, fallback)
                grades = {name: _grade(rows, event, evidence) for name, rows in policies.items()}
                lineage = {"commit": sha, "committer_utc_claim": stamp, "document_updated_utc_claim": doc["updated_utc"],
                    "parlays_sha256": blob_id, "calibration_sha256": cal_id, "correlation_id": ex.fingerprint(corr),
                    "calibration_generated_utc_claim": cal["generated_utc"], "historical_builder_sha256": historical_code_id}
                games.append({**event, "source": lineage, "cohort_id": ex.fingerprint({"event": event, "source": lineage}),
                    "as_built_card_ids": [card.get("card_id") or card.get("parlay_id") for card in cards],
                    "population": "ordered_first_occurrence_union_of_selected_snapshot_game_card_legs",
                    "candidate_union_id": ex.fingerprint(candidates), "candidate_count": len(candidates), "policies": grades,
                    "requested_reconstructed_slots": 3, "reconstructed_shortfalls": {name: 3 - len(rows) for name, rows in selection.items()}})
            except Error as exc:
                exclusions.append({"week": event["week"], "game_id": gid, "reason": str(exc)})
        summaries = []
        metrics = ("distinct_or_as_built_cards", "settlement_wins", "settlement_graded_cards", "full_contract_hits", "full_win", "reduced_win", "loss", "all_void", "pending")
        for week in weeks:
            rows = [g for g in games if g["week"] == week]
            policies = {name: {metric: sum(g["policies"][name][metric] for g in rows) for metric in metrics}
                        for name in ("as_built_git_snapshot", "r74_control", "r126")}
            summaries.append({"week": week, "expected_schedule_games": sum(g["week"] == week for g in events.values()),
                "recovered_games": len(rows), "policies": policies,
                "exclusions": dict(Counter(e["reason"] for e in exclusions if e["week"] == week)),
                "historical_acceptance_eligible": False})
        return {"version": 1, "kind": "nfl.on_card_reference.v1", "reference_commit": reference,
            "source_hashes": {name: inputs[name][1] for name in names}, "season": season,
            "history": {"retained_parlay_revisions": len(history), "shallow": replay._git(repo_dir, ["rev-parse", "--is-shallow-repository"]).strip() == b"true",
                "retained_roots": roots, "traversal": "retained reachable git log reference -- data/parlays.json",
                "clock_basis": "mutable Git committer and JSON timestamps; not independent capture/publication proof"},
            "runtime": {**replay.runtime_versions(), "on_card_replay_sha256": replay._raw_hash(Path(__file__).read_bytes())},
            "weeks": summaries, "games": games, "exclusions": exclusions, "historical_acceptance_eligible": False,
            "totals": {name: {metric: sum(w["policies"][name][metric] for w in summaries) for metric in metrics}
                       for name in ("as_built_git_snapshot", "r74_control", "r126")},
            "historical_claim_metric": "settlement_wins / settlement_graded_cards (reduced wins included), not full_contract_hits",
            "limits": ["on-card union is not the complete candidate universe", "available history may omit unreachable or truncated versions",
                "as-built means present in selected Git bytes, not independently verified served/public content",
                "legacy no_stat_line VOID is not verified official DNP; ledger VOID precedes review miss",
                "review fallback applies only when no ledger row exists; other unknown outcomes remain pending",
                "no original receipt mutation, current eligibility/owner-exclusion reconstruction, refit or causal-lift claim",
                "R74/R126 use the accepted current distinct-actual-bet guard; as-built retains original bytes/card multiplicity",
                "settlement wins include reduced wins; full-contract hits exclude every VOID; pending and all-VOID excluded from settlement denominator"]}
    except Error:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise Error("malformed_reference_source") from None


def gate_result(report):
    """Optional ON-CARD numeric diagnostic, never a promotion/publication gate.

The historical 59/188 -> 72/189 claim counts settlement wins (reduced wins
included), not full-contract hits. Required weeks are fixed 2–5; missing,
excluded or pending games cannot quietly pass. A numeric pass does not upgrade
the retained-Git evidence into a full-pool or independently verified backtest.
"""
    reasons = []
    try:
        rows = report["weeks"]
        if (report.get("kind") != "nfl.on_card_reference.v1" or not isinstance(rows, list)
                or len(rows) != 4 or {row["week"] for row in rows} != {2, 3, 4, 5}):
            raise Error("required_weeks_2_to_5_missing")
        for row in rows:
            week = row["week"]
            if (type(week) is not int or type(row["expected_schedule_games"]) is not int
                    or row["expected_schedule_games"] <= 0 or type(row["recovered_games"]) is not int
                    or row["recovered_games"] != row["expected_schedule_games"]
                    or row["exclusions"]):
                reasons.append({"week": week, "reason": "required_game_coverage_incomplete"})
            control, candidate = (row["policies"][key] for key in ("r74_control", "r126"))
            for metric in (control, candidate):
                if (any(type(metric[key]) is not int or metric[key] < 0 for key in ("pending", "settlement_wins", "settlement_graded_cards"))
                        or metric["pending"] or metric["settlement_graded_cards"] <= 0
                        or metric["settlement_wins"] > metric["settlement_graded_cards"]):
                    reasons.append({"week": week, "reason": "required_outcome_coverage_incomplete"})
            if candidate["settlement_wins"] < control["settlement_wins"]:
                reasons.append({"week": week, "reason": "r126_fewer_settlement_winners_than_same_union_r74"})
    except (Error, KeyError, TypeError, ValueError, AttributeError) as exc:
        reasons.append({"reason": str(exc) if isinstance(exc, Error) else "malformed_gate_evidence"})
    return {"version": 1, "passed": not reasons, "reasons": reasons,
        "basis": "per-week settlement winner count on the identical recovered on-card union; reduced wins included",
        "required_weeks": [2, 3, 4, 5], "historical_acceptance_eligible": False,
        "authority": "available-Git on-card diagnostic only; no adoption, publication or complete-candidate acceptance"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(_ROOT))
    parser.add_argument("--reference", default=RCA_REFERENCE)
    parser.add_argument("--out")
    parser.add_argument("--gate", action="store_true", help="opt-in on-card numeric/coverage diagnostic; failure exits1; no adoption")
    args = parser.parse_args(argv)
    try:
        report = reconstruct(args.repo, args.reference)
        if args.gate:
            report["on_card_gate"] = gate_result(report)
        report["report_id"] = ex.fingerprint(report)
        if args.out:
            replay.persist(report, args.out, source_roots=(args.repo,))
        print(json.dumps(report, ensure_ascii=True, allow_nan=False))
        return 1 if args.gate and not report["on_card_gate"]["passed"] else 0
    except Error as exc:
        print(json.dumps({"ok": False, "reason": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
