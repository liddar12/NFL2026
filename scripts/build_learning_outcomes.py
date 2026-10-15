#!/usr/bin/env python3
"""Read-only observed outcomes for exact frozen MY-prop forecast vintages.

Uses a verified capture and the original journal's pool/schedule objects, never
today's roster, compact score files, owner exclusions or reconstructed bases.
The output is evidence for the separately versioned observed-resolution adapter;
it does not invent source update/game-finish times, write data, fit or deliver.
"""
import argparse
from collections import Counter, defaultdict
import copy
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import capture_outcome_evidence as capture  # noqa: E402
from scripts import export_learning as export  # noqa: E402
from scripts import learning_receipts as receipts  # noqa: E402
from scripts.resolve_estimates import norm_name  # noqa: E402
from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402
from scripts.scrape.renames import canonical_player_name, normalize_team  # noqa: E402

VERSION = 2
POLICY = "nfl.observed_outcome_producer_v1"
JOIN_POLICY = "frozen_pool_exact_name_team_position_v1"
MARKETS = {"qb_pass_yds": ("QB", "passing_yards"),
           "rb_rush_yds": ("RB", "rushing_yards"),
           "wr_rec_yds": ("WR", "receiving_yards")}
ALIASES = {"FB": "RB", "HB": "RB"}
COMPACT_LEG_KEYS = {"game_id", "gsis_id", "market", "line", "side", "direction",
                    "comparison_operator", "model_prob", "selection", "position"}


def _same(left, right):
    return export.encoded(left) == export.encoded(right)


def _integer(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return int(number) if math.isfinite(number) and number.is_integer() else None


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _name(value):
    return norm_name(canonical_player_name(value)) if isinstance(value, str) else ""


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _unique(rows, reason):
    if len(rows) != 1:
        raise ValueError(reason)
    return rows[0]


def _entries(export_plan, season, weeks):
    """Bind every source receipt to its original full frozen player identity."""
    if type(export_plan.get("version")) is not int or export_plan["version"] != 1:
        raise ValueError("unsupported_export_plan")
    sources = {}
    for request in export_plan["source_objects"]:
        oid, payload = request["object_id"], request["payload"]
        if (type(request.get("version")) is not int or request["version"] != 1
                or request["kind"] != "source_snapshot" or receipts.fingerprint(payload) != oid):
            raise ValueError("source_object_hash_mismatch")
        if oid in sources and not _same(sources[oid], payload):
            raise ValueError("conflicting_source_object")
        sources[oid] = payload
    entries, rejected, total, scoped = {}, [], 0, 0
    for item in export_plan["generations"]:
        request = item["request"]
        doc = request["payload"]
        if (type(request.get("version")) is not int or request["version"] != 1
                or request.get("kind") != "generation"
                or type(doc.get("version")) is not int or doc["version"] != 1
                or type(doc.get("season")) is not int or type(doc.get("week")) is not int
                or not 1 <= doc["week"] <= 18 or not isinstance(doc.get("receipts"), list)
                or not isinstance(doc.get("generations"), list)
                or request.get("object_id") != doc.get("envelope_id")):
            raise ValueError("invalid_generation_document")
        if receipts.fingerprint({k: v for k, v in doc.items() if k != "envelope_id"}) != doc["envelope_id"]:
            raise ValueError("generation_object_hash_mismatch")
        total += len(doc["receipts"])
        if doc["season"] != season or doc["week"] not in weeks:
            continue
        generation = _unique(doc["generations"], "invalid_generation_manifest")
        if (type(generation.get("version")) is not int or generation["version"] != 1
                or type(generation.get("season")) is not int or generation["season"] != season
                or type(generation.get("week")) is not int or generation["week"] != doc["week"]
                or generation.get("publication_status") != "generated_unverified"
                or generation.get("population") != "eligible_pool_prop_rungs_before_display_dedupe"):
            raise ValueError("invalid_generation_manifest")
        if generation.get("generation_id") != receipts.fingerprint({k: generation[k] for k in export.MANIFEST_KEYS}):
            raise ValueError("generation_manifest_hash_mismatch")
        membership = [row.get("receipt_id") if isinstance(row, dict) else None for row in doc["receipts"]]
        if (any(not isinstance(sid, str) or not export.HASH.fullmatch(sid) for sid in membership)
                or len(membership) != len(set(membership)) or generation.get("receipt_ids") != sorted(membership)):
            raise ValueError("invalid_generation_receipt_membership")
        refs = generation["source_snapshots"]
        if not isinstance(refs, dict) or set(refs) != {"leg_pool", "schedule", "parlay_calibration"}:
            raise ValueError("invalid_generation_source_references")
        pool, schedule = sources[refs["leg_pool"]], sources[refs["schedule"]]
        if (pool.get("season") != season or pool.get("week") != doc["week"]
                or schedule.get("season", season) != season
                or pool.get("generated_utc") != generation.get("pool_generated_utc")):
            raise ValueError("source_generation_period_mismatch")
        candidates = defaultdict(list)
        for player in pool.get("players") or []:
            if not isinstance(player, dict):
                continue
            for rung in player.get("rungs") or []:
                if isinstance(rung, dict) and isinstance(rung.get("learning_receipt"), dict):
                    candidates[rung["learning_receipt"].get("receipt_id")].append((player, rung))
        for row in doc["receipts"]:
            scoped += 1
            sid = row.get("receipt_id")
            try:
                player, rung = _unique(candidates.get(sid, []), "missing_or_ambiguous_frozen_player")
                source = row["learning_receipt"]
                if (row.get("generation_id") != generation["generation_id"]
                        or source.get("receipt_id") != sid
                        or row.get("publication_status") != "generated_unverified"):
                    raise ValueError("receipt_generation_membership_mismatch")
                if not _same(rung["learning_receipt"], source):
                    raise ValueError("frozen_receipt_mismatch")
                leg = {**player, **rung}
                if receipts.receipt_problem(source, leg, season, doc["week"]):
                    raise ValueError("invalid_frozen_receipt")
                expected = {key: value for key, value in leg.items() if key in COMPACT_LEG_KEYS}
                if not _same(expected, row["leg"]):
                    raise ValueError("frozen_leg_mismatch")
                stamps = source.get("source_timestamps")
                if (not isinstance(stamps, dict) or not stamps
                        or any(not _text(k) or receipts.instant(v) is None for k, v in stamps.items())
                        or source.get("base_model_version") != pool.get("base_model_version")
                        or source.get("forecast_created_utc") != pool.get("generated_utc")):
                    raise ValueError("invalid_frozen_source_lineage")
                position, _ = MARKETS[source["market"]]
                if (player.get("position") != position or not _text(player.get("player"))
                        or not _name(player["player"])):
                    raise ValueError("invalid_frozen_player_identity")
                game = _unique([g for g in schedule.get("games") or []
                                if isinstance(g, dict) and str(g.get("game_id")) == source["game_id"]],
                               "missing_or_ambiguous_frozen_game")
                team = normalize_team(player.get("team"))
                created = receipts.instant(source.get("forecast_created_utc"))
                recorded = receipts.instant(row.get("recorded_utc"))
                kickoff = receipts.instant(game.get("kickoff_utc"))
                if (team is None or game.get("week") != doc["week"]
                        or normalize_team(game.get(source["side"])) != team
                        or kickoff is None or kickoff != receipts.instant(row.get("kickoff_utc"))
                        or game.get("status") != "STATUS_SCHEDULED"):
                    raise ValueError("frozen_player_game_mismatch")
                if (created is None or recorded is None or not created <= recorded < kickoff
                        or row.get("recorded_utc") != generation.get("recorded_utc")):
                    raise ValueError("not_captured_pregame")
                frozen_game = {k: game[k] for k in ("game_id", "week", "home", "away", "kickoff_utc", "status")}
                entry = {"source_receipt": copy.deepcopy(source),
                         "player": {"player": player["player"], "team": team, "position": position},
                         "game": frozen_game, "pool_snapshot_ids": [refs["leg_pool"]],
                         "generation_ids": [generation["generation_id"]]}
                if sid in entries:
                    old = entries[sid]
                    evidence_keys = ("source_receipt", "player", "game")
                    if not _same({k: old[k] for k in evidence_keys}, {k: entry[k] for k in evidence_keys}):
                        raise ValueError("conflicting_frozen_receipt_identity")
                    old["generation_ids"] = sorted(set(old["generation_ids"] + entry["generation_ids"]))
                    old["pool_snapshot_ids"] = sorted(set(old["pool_snapshot_ids"] + entry["pool_snapshot_ids"]))
                else:
                    entries[sid] = entry
            except (ValueError, TypeError, KeyError, OverflowError, AttributeError) as exc:
                reason = str(exc) if isinstance(exc, ValueError) else "invalid_frozen_generation_row"
                rejected.append({"source_receipt_id": sid if isinstance(sid, str) else None, "reason": reason})
    conflicted = {row["source_receipt_id"] for row in rejected}
    for sid in conflicted:
        entries.pop(sid, None)
    return entries, rejected, total, scoped


def _stat_rows(raw_rows, season, week):
    return [row for row in raw_rows if _integer(row.get("season")) == season
            and _integer(row.get("week")) == week and row.get("season_type") == "REG"]


def _matching_stats(rows, identity):
    return [row for row in rows
            if normalize_team(row.get("team") or row.get("recent_team")) == identity["team"]
            and ALIASES.get(str(row.get("position", "")).upper(), str(row.get("position", "")).upper()) == identity["position"]
            and _name(row.get("player_display_name") or row.get("player_name")) == _name(identity["player"])]


def _possible_alias(candidate, expected):
    left, right = _name(candidate), _name(expected)
    return (bool(left) and bool(right) and " " in left and " " in right
            and left[0] == right[0] and left.split(" ", 1)[1] == right.split(" ", 1)[1])


def _unjoined_stat_problem(raw_rows, identity, season, week):
    """Recognizable or unidentified production is not evidence of absence."""
    for row in raw_rows:
        row_season, row_week = _integer(row.get("season")), _integer(row.get("week"))
        if (row_season is not None and row_season != season) or (row_week is not None and row_week != week):
            continue
        name = row.get("player_display_name") or row.get("player_name")
        normalized = _name(name)
        team = normalize_team(row.get("team") or row.get("recent_team"))
        pos = str(row.get("position", "")).upper()
        pos = ALIASES.get(pos, pos)
        same_name = normalized == _name(identity["player"])
        alias = _possible_alias(name, identity["player"])
        if same_name or alias:
            if (row_season != season or row_week != week or row.get("season_type") != "REG"
                    or team != identity["team"] or pos != identity["position"]):
                return "unjoined_stat_identity_requires_crosswalk"
            if alias:
                return "possible_stat_alias_requires_crosswalk"
        if not normalized and team in (None, identity["team"]):
            return "unidentified_stat_row_prevents_zero_inference"
    return None


def _participation(raw_rows, identity, season, week):
    rows = []
    for row in raw_rows:
        row_season, row_week = _integer(row.get("season")), _integer(row.get("week"))
        if ((row_season is not None and row_season != season)
                or (row_week is not None and row_week != week) or row.get("game_type") == "POST"):
            continue
        team, name = normalize_team(row.get("team")), _name(row.get("player"))
        if not team and not name:
            raise ValueError("unlocatable_participation_identity")
        recognizable = name == _name(identity["player"]) or _possible_alias(row.get("player"), identity["player"])
        # Filtering malformed identities/periods first would turn an observed
        # participant into an apparent absence. Quarantine the affected sheet
        # (or recognizable player) without blocking measured stat neighbors.
        if team == identity["team"] or recognizable:
            if (row_season != season or row_week != week or row.get("game_type") != "REG"
                    or not team or not name):
                raise ValueError("missing_or_invalid_participation_sheet")
            if recognizable and team != identity["team"]:
                raise ValueError("unjoined_participation_identity_requires_crosswalk")
        if team == identity["team"]:
            rows.append(row)
    # A corrupt cell cannot turn a partial/unknown sheet into nonparticipation.
    if not rows or any(not _name(r.get("player")) or _number(r.get("offense_snaps")) is None
                       or _number(r["offense_snaps"]) < 0
                       or not _number(r["offense_snaps"]).is_integer() for r in rows):
        raise ValueError("missing_or_invalid_participation_sheet")
    if len({_name(r.get("player")) for r in rows}) != len(rows):
        raise ValueError("ambiguous_participation_sheet")
    exact = [r for r in rows if _name(r.get("player")) == _name(identity["player"])]
    if len(exact) > 1:
        raise ValueError("ambiguous_participation_identity")
    if exact:
        if _number(exact[0]["offense_snaps"]) >= 1:
            return True, "r106_positive_offensive_snaps_no_stat_row", receipts.fingerprint(exact[0])
        # Zero offense may still include special-team participation; do not
        # invent a sportsbook DNP ruling from this ambiguous case.
        raise ValueError("zero_offensive_snaps_requires_settlement_evidence")
    # Known nickname/ID crosswalk gaps remain unresolved rather than becoming
    # an inferred DNP because a similar initial+surname was silently ignored.
    if any(_possible_alias(r.get("player"), identity["player"]) for r in rows):
        raise ValueError("possible_participation_alias_requires_crosswalk")
    return False, "r106_team_snap_absence_inference", receipts.fingerprint(rows)


def build(export_plan, evidence_bundle):
    """Deterministic observed-leg payload; no persistence or network effects."""
    capture.verify_capture(evidence_bundle)
    manifest = evidence_bundle["manifest"]
    season, weeks = manifest["season"], set(manifest["weeks"])
    # Verify all bindings once, before using raw-reader helpers. Their parsers
    # alone cannot detect valid replacement CSV/JSON under an old content ID.
    stats = capture.csv_rows(evidence_bundle, capture.STATS_PROFILE)
    snaps = capture.csv_rows(evidence_bundle, capture.SNAPS_PROFILE)
    stat_obs = capture.source_observation(evidence_bundle, capture.STATS_PROFILE)
    snap_obs = capture.source_observation(evidence_bundle, capture.SNAPS_PROFILE)
    games = capture.scoreboard_rows(evidence_bundle)
    entries, rejections, total, scoped = _entries(export_plan, season, weeks)
    indexed_games = defaultdict(list)
    for game in games:
        indexed_games[str(game.get("game_id"))].append(game)
    observed_legs, sources, game_observations = [], [], {}
    for sid, entry in sorted(entries.items()):
        source, identity, frozen_game = entry["source_receipt"], entry["player"], entry["game"]
        sources.append(copy.deepcopy(source))
        try:
            game = _unique(indexed_games.get(source["game_id"], []), "missing_or_ambiguous_final_game")
            kickoff = receipts.instant(game.get("kickoff_utc"))
            if (game.get("status") not in FINAL_STATUSES or kickoff is None
                    or _integer(game.get("home_score")) is None or _integer(game.get("away_score")) is None
                    or game["home_score"] < 0 or game["away_score"] < 0):
                raise ValueError("game_not_final_with_complete_scores")
            if (game["season"] != season or game["week"] != source["week"]
                    or kickoff != receipts.instant(frozen_game["kickoff_utc"])
                    or any(normalize_team(game.get(side)) != normalize_team(frozen_game.get(side))
                           for side in ("home", "away"))):
                raise ValueError("observed_game_frozen_identity_mismatch")
            final_seen = receipts.instant(game["observed_utc"])
            if final_seen is None or final_seen < kickoff:
                raise ValueError("invalid_final_observation_clock")
            if receipts.instant(stat_obs["observed_utc"]) < final_seen:
                raise ValueError("stat_observed_before_final_evidence")
            week_rows = _stat_rows(stats, season, source["week"])
            if not week_rows:
                raise ValueError("stats_week_not_published")
            matches = _matching_stats(week_rows, identity)
            participation = {}
            if len(matches) > 1:
                raise ValueError("ambiguous_stat_identity")
            if matches:
                row = matches[0]
                actual = _number(row.get(MARKETS[source["market"]][1]))
                if actual is None:
                    raise ValueError("missing_stat_value")
                played, basis, row_hash = True, "stat_row", receipts.fingerprint(row)
                source_name, observation = "nflverse.stats_player", stat_obs
            else:
                # A missing exact name is not proof of no production when a
                # plausible provider alias remains unjoined. Positive snaps
                # must not turn an observed namesake's yardage into false zero.
                problem = _unjoined_stat_problem(stats, identity, season, source["week"])
                if problem:
                    raise ValueError(problem)
                if receipts.instant(snap_obs["observed_utc"]) < final_seen:
                    raise ValueError("participation_observed_before_final_evidence")
                played, basis, row_hash = _participation(snaps, identity, season, source["week"])
                actual = 0.0 if played else None
                source_name, observation = (("nflverse.stats_player", stat_obs) if played
                                            else ("nflverse.snap_counts", snap_obs))
                participation = {"participation_source": "nflverse.snap_counts",
                                 "participation_observed_utc": snap_obs["observed_utc"],
                                 "participation_observation_id": snap_obs["observation_id"]}
            leg = {key: source[key] for key in ("season", "week", "game_id", "player_id", "market",
                                                "line", "side", "direction", "comparison_operator")}
            leg.update(identity)
            leg.update(source_receipt_id=sid, model_prob=source["served_prob"], played=played,
                       result=("hit" if actual >= source["line"] else "miss") if played else "void",
                       actual=actual, reason=None if played else "did_not_play",
                       status=game["status"], authoritative=True, source=source_name,
                       observed_utc=observation["observed_utc"], observation_id=observation["observation_id"],
                       participation_basis=basis, evidence_quality="observed_source_snapshot",
                       evidence_capture_id=manifest["capture_id"], identity_join_policy=JOIN_POLICY,
                       source_row_sha256=row_hash, pool_snapshot_ids=entry["pool_snapshot_ids"],
                       generation_ids=entry["generation_ids"], **participation)
            normalized = {key: game[key] for key in ("season", "week", "game_id", "status", "kickoff_utc",
                                                     "home", "away", "home_score", "away_score", "observed_utc")}
            normalized.update(source="espn.scoreboard", observation_id=game["source_observation_id"],
                              final_utc=None, source_updated_utc=None)
            game_observations[source["game_id"]] = normalized
            observed_legs.append(leg)
        except (ValueError, KeyError, TypeError, OverflowError, AttributeError) as exc:
            reason = str(exc) if isinstance(exc, ValueError) else "malformed_outcome_source_evidence"
            rejections.append({"source_receipt_id": sid, "reason": reason})
    # Contradictory identity/provenance for one receipt cannot be repaired by
    # the order in which generation documents happened to be read.
    rejections.sort(key=lambda r: (str(r["source_receipt_id"]), r["reason"]))
    document = {"version": VERSION, "producer": POLICY, "capture_id": manifest["capture_id"],
                "season": season, "weeks": sorted(weeks), "capture_completed_utc": manifest["completed_utc"],
                "source_receipts": sources, "observed_legs": observed_legs,
                "game_observations": game_observations, "rejections": rejections,
                "clock_policy": "captured_observation_not_actual_finish_or_upstream_update",
                "summary": {"journal_rows": total, "captured_scope_rows": scoped,
                            "unique_frozen_receipts": len(entries), "observed_legs": len(observed_legs),
                            "excluded_records": len(rejections), "writes": False, "network_used": False,
                            "exclusion_reasons": dict(sorted(Counter(r["reason"] for r in rejections).items()))}}
    document["outcome_id"] = receipts.fingerprint(document)
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--snapshots", default=str(ROOT / "data/snapshots"))
    parser.add_argument("--evidence-capture", required=True)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args(argv)
    try:
        document = build(export.plan(args.snapshots), capture.load_capture(args.evidence_capture))
    except (ValueError, KeyError, TypeError, OSError, OverflowError):
        print("build_learning_outcomes: invalid frozen journal or evidence capture", file=sys.stderr)
        return 2
    print(json.dumps(document["summary"] if args.summary else document,
                     sort_keys=True, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
