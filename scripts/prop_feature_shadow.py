"""Opt-in R127 prospective feature twins, never a serving or fitting path.

Explicit verified raw captures are inputs, not current files or backtest
fixtures. Outputs are pure content-addressed local observations. They do not
prove public availability, durable persistence, provider authentication or that
two newly graded weeks are sufficient evidence for promotion.
"""
from collections import Counter, defaultdict
import copy
import inspect
import math
import random
import sys

from scripts import backtest_parlay as reference
from scripts import build_learning_outcomes as outcomes
from scripts import capture_outcome_evidence as capture
from scripts import export_learning as export
from scripts import learning_receipts as receipts
from scripts.scrape.renames import normalize_team

POLICY = "r127_fixed_train_feature_shadow_v1"
MAX_ROWS, MAX_BYTES, MAX_CAPTURES = 10000, 128 * 1024 * 1024, 8
MARKETS = outcomes.MARKETS


class ShadowError(ValueError):
    """Static local reasons only; no source diagnostics or caller labels."""


def need(value, reason):
    if not value:
        raise ShadowError(reason)


def instant(value):
    result = receipts.instant(value)
    need(result is not None, "invalid_shadow_clock")
    return result


def seal(value, field):
    return {**value, field: receipts.fingerprint(value)}


def validate_hash(value, field):
    need(type(value) is dict and value.get(field) == receipts.fingerprint({k: v for k, v in value.items() if k != field}), "shadow_hash_mismatch")


def policy_id():
    # Conservative code pin: all strict ingestion/paired evaluation plus the
    # actual training arithmetic/constants. No fitted coefficient is selected.
    return receipts.fingerprint({"policy": POLICY, "source": inspect.getsource(sys.modules[__name__]),
        "blend": inspect.getsource(reference.PropCorpus._blend),
        "dvp": inspect.getsource(reference.PropCorpus.dvp_multiplier),
        "allowed": inspect.getsource(reference.PropCorpus._allowed_sum),
        "constants": [reference.PRIOR_WEIGHT, reference.MIN_PRIOR_GAMES, reference.MIN_CURRENT_GAMES,
                      reference.DVP_SHRINK, list(reference.DVP_CLAMP)]})


def _captures(values):
    need(type(values) is list and len(values) <= MAX_CAPTURES, "shadow_capture_work_limit")
    result, size = [], 0
    for bundle in values:
        capture.verify_capture(bundle)
        size += sum(len(raw) for raw in bundle["raw_objects"].values())
        need(size <= MAX_BYTES, "shadow_capture_work_limit")
        result.append({"bundle": bundle, "manifest": bundle["manifest"],
            "stats": capture.csv_rows(bundle, capture.STATS_PROFILE),
            "games": capture.scoreboard_rows(bundle),
            "source": capture.source_observation(bundle, capture.STATS_PROFILE)})
    return result


def _state(captures, teams, inventory, known_players, season, week, created):
    """Strict prefix-only state for the ACTUAL reference arithmetic methods.

    Never construct PropCorpus (its constructor picks target-week actual rows).
    Missing numeric measurements/position sheets are unknown, not neutral zero.
    """
    by_season = defaultdict(list)
    for item in captures:
        by_season[item["manifest"]["season"]].append(item)
    need(set(by_season) <= {season - 1, season}, "foreign_training_capture")
    need(len(by_season[season - 1]) == 1 and (week == 1 or len(by_season[season]) == 1), "missing_training_capture")
    state = reference.PropCorpus.__new__(reference.PropCorpus)
    state.weekly, state.allowed, state.unknown_positions = {}, {}, set()
    state.team_games = {(season, team): [] for team in teams}
    lineage, positions = [], {}
    for year in (season - 1, season):
        if year == season and week == 1:
            need(not by_season[year], "unexpected_current_week_capture")
            continue
        item = by_season[year][0]
        expected_weeks = list(range(1, 19 if year < season else week))
        need(item["manifest"]["weeks"] == expected_weeks, "incomplete_training_source_window")
        need(instant(item["manifest"]["completed_utc"]) <= created
             and all(instant(obs["observed_utc"]) <= created for obs in item["bundle"]["observations"].values()), "training_source_after_forecast")
        need(not item["manifest"]["audit"]["quarantined_game_ids"]
             and all(not obs["audit"].get("malformed_events") and not obs["audit"].get("conflicting_game_ids")
                     and not obs["audit"].get("invalid_final_scores")
                     for obs in item["bundle"]["observations"].values() if obs["profile"] == capture.SCOREBOARD_PROFILE),
             "quarantined_training_scoreboard")
        lineage.append({"capture_id": item["manifest"]["capture_id"], "source_observation_id": item["source"]["observation_id"],
                        "raw_sha256": item["source"]["raw_sha256"], "observed_utc": item["source"]["observed_utc"]})
        games, year_teams = {}, set()
        for game in item["games"]:
            if game["week"] not in expected_weeks:
                continue
            need(game["final"] and instant(game["kickoff_utc"]) <= instant(game["observed_utc"]), "training_game_not_final")
            for side in ("home", "away"):
                team = game[side];key = (team, game["week"])
                need(key not in games, "conflicting_training_team_game")
                games[key] = game;year_teams.add(team)
                state.team_games.setdefault((year, team), []).append(game["week"])
        if year < season:
            need(year_teams == teams, "incomplete_frozen_league_schedule")
        else:
            actual = {game["game_id"]: {key: game[key] for key in ("game_id", "week", "home", "away", "kickoff_utc")}
                      for game in item["games"] if game["week"] in expected_weeks}
            need(set(actual) == set(inventory), "incomplete_current_training_game_inventory")
            for gid, expected in inventory.items():
                observed = actual[gid]
                need(all(observed[key] == expected[key] for key in ("game_id", "week", "home", "away"))
                     and instant(observed["kickoff_utc"]) == instant(expected["kickoff_utc"]), "training_game_inventory_mismatch")
        seen, sheets = set(), set()
        for row in item["stats"]:
            # The target/current-later week cannot enter features, eligibility,
            # player selection or denominators, even when present in the CSV.
            row_year, row_week = outcomes._integer(row.get("season")), outcomes._integer(row.get("week"))
            need(row_year == year and row_week is not None, "invalid_training_period")
            pid = row.get("player_id")
            pos = outcomes.ALIASES.get(row.get("position"), row.get("position"))
            if row_week in expected_weeks and pos in reference.POSITIONS and row.get("season_type") not in ("REG", "POST"):
                state.unknown_positions.add(pos)
            if pid in known_players and row_week in expected_weeks:
                if row.get("season_type") not in ("REG", "POST") or row.get("season_type") == "REG" and pos != known_players[pid]:
                    state.unknown_positions.add(known_players[pid])
            if row.get("season_type") != "REG" or row_week not in expected_weeks:
                continue
            if pos not in reference.POSITIONS:
                continue
            pid = row.get("player_id");team = normalize_team(row.get("team") or row.get("recent_team"))
            need(type(pid) is str and bool(pid) and team is not None, "missing_training_gsis_identity")
            game = games.get((team, row_week));need(game is not None, "training_stat_game_not_verified")
            opp = game["away"] if game["home"] == team else game["home"]
            if row.get("opponent_team"):
                need(normalize_team(row["opponent_team"]) == opp, "training_opponent_mismatch")
            value = outcomes._number(row.get(MARKETS[next(m for m, info in MARKETS.items() if info[0] == pos)][1]))
            need(value is not None, "missing_training_measurement")
            key = (pid, row_week);need(key not in seen, "duplicate_training_player_week");seen.add(key)
            need(pid not in positions or positions[pid] == pos, "training_position_changed")
            positions[pid] = pos
            rec = state.weekly.setdefault(pid, {"pos": pos, "seasons": {}})
            rec["seasons"].setdefault(year, {})[row_week] = {reference.YARDS_FIELD[pos]: value}
            allowed = state.allowed.setdefault((year, opp, pos), {})
            allowed[row_week] = allowed.get(row_week, 0.0) + value;sheets.add((team, row_week, pos))
        need(all((team, wk, pos) in sheets for team, wk in games for pos in reference.POSITIONS), "incomplete_training_position_sheet")
    for weeks in state.team_games.values():
        weeks.sort()
    return state, lineage


def _schedules(plan):
    sources = {row["object_id"]: row["payload"] for row in plan["source_objects"]}
    result, known = {}, {}
    for item in plan["generations"]:
        for generation in item["request"]["payload"]["generations"]:
            gid = generation["generation_id"]
            identity = {"object_id": item["request"]["object_id"], "generation": generation}
            need(gid not in known or export._same_json(known[gid], identity), "conflicting_original_generation_capture")
            known[gid] = identity
            result[gid] = sources[generation["source_snapshots"]["schedule"]]
    return result


def _inventory(schedules, week):
    """Expected CURRENT games are pinned by original full consumer schedules.

    No independent prior-season full inventory is supplied by this contract;
    that remains an explicit permanent promotion hold, never a17-game guess.
    """
    values = []
    for schedule in schedules:
        games = {}
        for game in schedule["games"]:
            need(type(game.get("week")) is int, "invalid_frozen_game_inventory")
            if game["week"] >= week:
                continue
            row = {k: game[k] for k in ("game_id", "week", "home", "away", "kickoff_utc")}
            row["game_id"] = str(row["game_id"])
            row["home"], row["away"] = normalize_team(row["home"]), normalize_team(row["away"])
            need(row["game_id"] not in games or export._same_json(games[row["game_id"]], row), "conflicting_frozen_game_inventory")
            games[row["game_id"]] = row
        values.append(games)
    need(values and all(export._same_json(values[0], value) for value in values), "conflicting_frozen_game_inventory")
    return values[0]


def _original_inventory(plan, season, week):
    """Do not discard an invalid original before finding the earliest forecast."""
    rows = {}
    for item in plan["generations"]:
        doc = item["request"]["payload"]
        if doc.get("season") != season or doc.get("week") != week:
            continue
        need(type(doc.get("receipts")) is list, "unlocatable_original_forecast_authority")
        for row in doc["receipts"]:
            source = row.get("learning_receipt") if type(row) is dict else None
            need(type(source) is dict, "unlocatable_original_forecast_authority")
            key = receipts.canonical_key(source, season);sid = row.get("receipt_id")
            need(key is not None and type(sid) is str and export.HASH.fullmatch(sid)
                 and source.get("contract_id") == receipts.fingerprint(list(key)), "unlocatable_original_forecast_authority")
            valid_source_hash = source.get("receipt_id") == sid and sid == receipts.fingerprint({k: v for k, v in source.items() if k != "receipt_id"})
            value = {"contract_id": source["contract_id"], "created": receipts.instant(source.get("forecast_created_utc")) if valid_source_hash else None}
            need(sid not in rows or rows[sid] == value, "conflicting_original_forecast_authority")
            rows[sid] = value
    need(len(rows) <= MAX_ROWS, "shadow_receipt_work_limit")
    return rows


def collect(export_plan, training_captures, *, season, week, recorded_utc, experiment_started_utc):
    """Freeze twins before kickoff; no files, network, refit or receipt mutation.

    Caller must persist these exact content IDs before outcomes. This pure
    function's caller clock is not independent publication/database evidence.
    Only exact raw GSIS identities are supported, not guessed ESPN crosswalks.
    """
    need(type(season) is int and type(week) is int and 1 <= week <= 18, "invalid_shadow_period")
    recorded, started = instant(recorded_utc), instant(experiment_started_utc)
    need(started <= recorded, "shadow_before_experiment_start")
    _original_inventory(export_plan, season, week)
    entries, rejected, total, _ = outcomes._entries(export_plan, season, {week})
    need(total <= MAX_ROWS, "shadow_receipt_work_limit")
    captures, schedules, states = _captures(training_captures), _schedules(export_plan), {}
    version, rows = policy_id(), []
    known_players = {entry["source_receipt"]["player_id"]: entry["player"]["position"] for entry in entries.values()}
    for sid, entry in sorted(entries.items()):
        original = entry["source_receipt"];created, kickoff = instant(original["forecast_created_utc"]), instant(entry["game"]["kickoff_utc"])
        row = {"source_receipt_id": sid, "contract_id": original["contract_id"], "position": entry["player"]["position"],
            "generation_ids": entry["generation_ids"], "pool_snapshot_ids": entry["pool_snapshot_ids"], "incumbent": copy.deepcopy(original),
            "forecast_created_utc": original["forecast_created_utc"], "kickoff_utc": entry["game"]["kickoff_utc"], "recorded_utc": recorded_utc,
            "status": "withheld", "reason_codes": [], "shadow": None}
        try:
            need(started <= created <= recorded < kickoff, "shadow_not_prospective")
            teams = set()
            for gid in entry["generation_ids"]:
                for game in schedules[gid]["games"]:
                    teams.update(normalize_team(game.get(side)) for side in ("home", "away"))
            need(None not in teams and len(teams) > 1, "invalid_frozen_league_schedule")
            inventory = _inventory([schedules[gid] for gid in entry["generation_ids"]], week)
            cache_key = (original["forecast_created_utc"], tuple(sorted(teams)), receipts.fingerprint(inventory))
            if cache_key not in states:
                try:
                    states[cache_key] = _state(captures, teams, inventory, known_players, season, week, created)
                except ShadowError as error:
                    states[cache_key] = error
            if isinstance(states[cache_key], ShadowError):
                raise states[cache_key]
            state, lineage = states[cache_key];pos, pid = row["position"], original["player_id"]
            need(pos not in state.unknown_positions, "malformed_recognized_training_history")
            need(pid in state.weekly, "missing_exact_training_gsis_crosswalk")
            need(state.weekly[pid]["pos"] == pos, "training_receipt_position_mismatch")
            blend = state._blend(pid, pos, season, week);need(blend is not None, "insufficient_training_history")
            need(receipts.finite_number(blend), "nonfinite_training_feature")
            opponent = entry["game"]["away"] if original["side"] == "home" else entry["game"]["home"]
            mult = state.dvp_multiplier(season, week, opponent, pos);need(mult is not None, "unknown_training_dvp")
            need(receipts.finite_number(mult) and mult > 0, "nonfinite_training_feature")
            features = copy.deepcopy(original["features"])
            features.update(mu=blend * mult, z=(blend * mult - features["line"]) / features["sd"])
            need(receipts.finite_number(features["mu"]) and receipts.finite_number(features["z"]), "nonfinite_training_feature")
            base = receipts.base_probability(features["calibration"], features["z"], features["p_team"])
            need(receipts.finite_number(base) and 0 < base < 1, "shadow_probability_saturated")
            row.update(status="ready", shadow={"feature_version": version, "blend_mu": blend, "dvp_multiplier": mult,
                "features": features, "base_prob": base, "served_prob": receipts.serve_probability(base, original["calibrator"]),
                "calibrator_version": original["calibrator_version"], "source_lineage": lineage,
                "prior_game_inventory_scope": "captured_scoreboard_rows_only", "training_completeness_verified": False,
                "comparison": "fixed_incumbent_coefficients_and_serving_transform_feature_ablation", "weight": 0.0})
        except ShadowError as error:
            row["reason_codes"] = [str(error)]
        rows.append(seal(row, "row_id"))
    doc = {"version": 1, "kind": "nfl.r127_shadow.v1", "policy_id": version, "season": season, "week": week,
        "experiment_started_utc": experiment_started_utc, "recorded_utc": recorded_utc, "rows": rows,
        "training_capture_ids": sorted(item["manifest"]["capture_id"] for item in captures),
        "generation_object_ids": sorted({item["request"]["object_id"] for item in export_plan["generations"]
            if item["request"]["payload"]["season"] == season and item["request"]["payload"]["week"] == week}),
        "source_rejections": rejected, "activation": False, "candidate_weight": 0.0,
        "training_completeness_verified": False, "completeness_hold": "prior_game_inventory_not_independently_pinned",
        "scope": "original_eligible_pool_prop_receipts_shadow_only", "publication_status": "internal_capture_unverified",
        "source_authentication": "not_performed", "writes": False, "network_used": False}
    need(len(export.encoded(doc)) <= MAX_BYTES, "shadow_document_work_limit")
    return seal(doc, "shadow_id")


def _metrics(rows):
    def mean(key):
        return sum(r[key] for r in rows) / len(rows) if rows else None
    return {"n": len(rows), **{key: mean(key) for key in ("incumbent_log_loss", "shadow_log_loss", "log_loss_difference",
        "incumbent_brier", "shadow_brier", "incumbent_yards_absolute_error", "shadow_yards_absolute_error")}}


def evaluate(shadows, export_plan, outcome_captures, *, training_captures, as_of_utc, practical_margin=None, bootstrap_replicates=2000):
    """Score explicitly PINNED raw outcomes, not arbitrary normalized labels.

    No implicit latest-revision selector: overlapping week captures are refused.
    Later corrections require an explicit new pinned evaluation, never a rewrite
    of the twin or a claim that original revision IDs were supplied by NFL.
    """
    as_of = instant(as_of_utc)
    need(type(shadows) is list and len(shadows) <= 256, "shadow_document_work_limit")
    need(type(bootstrap_replicates) is int and 200 <= bootstrap_replicates <= 10000, "invalid_shadow_bootstrap_count")
    need(practical_margin is None or receipts.finite_number(practical_margin) and 0 < practical_margin < 1, "invalid_shadow_margin")
    # Bound the complete supplied authority and work BEFORE any raw capture
    # verification or collector replay. Duplicate documents still consume work;
    # deduplicating their final IDs cannot justify unbounded repeated parsing.
    encoded_bytes, processed_rows = len(export.encoded(export_plan)), 0
    need(encoded_bytes <= MAX_BYTES, "shadow_evaluation_work_limit")
    for doc in shadows:
        need(type(doc) is dict and type(doc.get("rows")) is list, "shadow_document_work_limit")
        processed_rows += len(doc["rows"])
        encoded_bytes += len(export.encoded(doc))
        need(processed_rows <= MAX_ROWS and encoded_bytes <= MAX_BYTES, "shadow_evaluation_work_limit")
    entries, originals, by_sid, ambiguous, contracts, excluded = {}, {}, {}, set(), defaultdict(list), Counter()
    seen_shadow_ids = set()
    version = policy_id()
    verified = {item["manifest"]["capture_id"]: item["bundle"] for item in _captures(training_captures)}
    for doc in shadows:
        validate_hash(doc, "shadow_id")
        if doc["shadow_id"] in seen_shadow_ids:
            continue
        seen_shadow_ids.add(doc["shadow_id"])
        need(instant(doc.get("recorded_utc")) <= as_of, "shadow_capture_after_asof")
        need(doc.get("version") == 1 and type(doc.get("version")) is int and doc.get("kind") == "nfl.r127_shadow.v1"
             and doc.get("policy_id") == version and doc.get("activation") is False and doc.get("candidate_weight") == 0.0, "unsupported_shadow_policy")
        need(type(doc.get("rows")) is list and len(doc["rows"]) <= MAX_ROWS, "shadow_document_work_limit")
        need(type(doc.get("training_capture_ids")) is list and doc["training_capture_ids"] == sorted(set(doc["training_capture_ids"]))
             and all(cid in verified for cid in doc["training_capture_ids"]), "missing_frozen_training_capture")
        need(type(doc.get("generation_object_ids")) is list and doc["generation_object_ids"] == sorted(set(doc["generation_object_ids"])), "invalid_shadow_generation_pin")
        pinned = {**export_plan, "generations": [item for item in export_plan["generations"] if item["request"]["object_id"] in doc["generation_object_ids"]]}
        need(len(pinned["generations"]) == len(doc["generation_object_ids"]), "missing_original_shadow_generation")
        replay = collect(pinned, [verified[cid] for cid in doc["training_capture_ids"]], season=doc["season"], week=doc["week"],
                         recorded_utc=doc["recorded_utc"], experiment_started_utc=doc["experiment_started_utc"])
        need(export._same_json(doc, replay), "shadow_replay_mismatch")
        originals.update(_original_inventory(export_plan, doc["season"], doc["week"]))
        current, _, _, _ = outcomes._entries(export_plan, doc["season"], {doc["week"]});entries.update(current)
        for row in doc["rows"]:
            validate_hash(row, "row_id");sid = row["source_receipt_id"]
            need(sid in current and export._same_json(row["incumbent"], current[sid]["source_receipt"]), "shadow_original_receipt_mismatch")
            need(row["contract_id"] == row["incumbent"]["contract_id"] and row["forecast_created_utc"] == row["incumbent"]["forecast_created_utc"]
                 and row["recorded_utc"] == doc["recorded_utc"] and row["kickoff_utc"] == current[sid]["game"]["kickoff_utc"], "invalid_shadow_identity")
            if sid in by_sid and not export._same_json(by_sid[sid], row):
                ambiguous.add(sid)
            by_sid[sid] = row
    need(len(by_sid) <= MAX_ROWS, "shadow_receipt_work_limit")
    for sid, original in originals.items():
        # A self-hashed clock still cannot order a receipt rejected by its
        # frozen source graph. Unknown authority holds its whole contract;
        # otherwise a forged later clock would let a later valid copy replace
        # the real first forecast before the evaluator ever considered it.
        created = original["created"] if sid in entries else None
        # Only fully validated original clocks can exclude a future forecast.
        # An invalid claimed future clock must still hold the affected contract,
        # never erase its earliest unverified original before cohort selection.
        if created is not None and created > as_of:
            continue
        contracts[original["contract_id"]].append((created, sid, by_sid.get(sid)))
    labels, pins, periods = {}, [], set()
    for item in _captures(outcome_captures):
        manifest = item["manifest"];need(instant(manifest["completed_utc"]) <= as_of, "outcome_capture_after_asof")
        scoped = {(manifest["season"], wk) for wk in manifest["weeks"]}
        need(not periods.intersection(scoped), "overlapping_outcome_capture_requires_pin");periods.update(scoped)
        produced = outcomes.build(export_plan, item["bundle"]);pins.append({"capture_id": manifest["capture_id"], "outcome_id": produced["outcome_id"]})
        for leg in produced["observed_legs"]:
            labels[leg["source_receipt_id"]] = leg
    rows, chosen = [], []
    for contract, candidates in sorted(contracts.items()):
        if any(clock is None for clock, _, _ in candidates):
            excluded["invalid_first_forecast_authority"] += 1;continue
        candidates.sort(key=lambda row: (row[0], row[1]));created, sid, twin = candidates[0];chosen.append(sid)
        if any(clock == created and original_id not in entries for clock, original_id, _ in candidates):
            excluded["invalid_first_forecast_authority"] += 1;continue
        if twin is None:
            excluded["missing_first_forecast_shadow"] += 1;continue
        first = [row for clock, _, row in candidates if clock == created]
        if any(row is None for row in first):
            excluded["missing_first_forecast_shadow"] += 1;continue
        signatures = {receipts.fingerprint({"incumbent": r["incumbent"], "shadow": r["shadow"], "status": r["status"]}) for r in first}
        if sid in ambiguous or len(signatures) != 1:
            excluded["conflicting_first_shadow"] += 1;continue
        if twin["status"] != "ready":
            excluded["shadow_withheld"] += 1;continue
        candidate = twin["shadow"];features = candidate["features"];original = twin["incumbent"]
        need(candidate["feature_version"] == version and type(candidate["weight"]) is float and candidate["weight"] == 0.0, "unsupported_shadow_policy")
        expected = copy.deepcopy(original["features"]);expected.update(mu=candidate["blend_mu"] * candidate["dvp_multiplier"], z=(candidate["blend_mu"] * candidate["dvp_multiplier"] - expected["line"]) / expected["sd"])
        need(export._same_json(features, expected) and candidate["calibrator_version"] == original["calibrator_version"], "invalid_shadow_features")
        base = receipts.base_probability(features["calibration"], features["z"], features["p_team"])
        need(base == candidate["base_prob"] and candidate["served_prob"] == receipts.serve_probability(base, original["calibrator"]), "invalid_shadow_probability")
        leg = labels.get(sid)
        if leg is None:
            excluded["pending_or_unjoined_outcome"] += 1;continue
        if leg["played"] is False:
            excluded["void_not_zero"] += 1;continue
        need(instant(leg["observed_utc"]) >= instant(twin["kickoff_utc"]) > instant(twin["recorded_utc"]), "outcome_not_future_of_shadow")
        actual = leg["actual"];hit = actual >= original["line"];p, q = original["served_prob"], candidate["served_prob"]
        ll, qll = reference._log_loss(p, hit), reference._log_loss(q, hit)
        rows.append({"source_receipt_id": sid, "contract_id": contract, "season": original["season"], "week": original["week"],
            "game_id": original["game_id"], "position": twin["position"], "incumbent_log_loss": ll, "shadow_log_loss": qll,
            "log_loss_difference": qll - ll, "incumbent_brier": reference._brier(p, hit), "shadow_brier": reference._brier(q, hit),
            "incumbent_yards_absolute_error": abs(actual - original["features"]["mu"]), "shadow_yards_absolute_error": abs(actual - features["mu"])})
    clusters = defaultdict(list)
    for row in rows:
        clusters[(row["season"], row["game_id"])].append(row["log_loss_difference"])
    interval = {"low": None, "high": None, "clusters": len(clusters), "method": "paired_game_cluster_percentile_leg_weighted",
                "sufficiency": "computability_not_operational_sample_size_approval"}
    if len(clusters) >= 2:
        rng, keys, boot = random.Random(127), sorted(clusters), []
        for _ in range(bootstrap_replicates):
            sample = [x for key in rng.choices(keys, k=len(keys)) for x in clusters[key]]
            boot.append(sum(sample) / len(sample))
        boot.sort();interval.update(low=boot[int(.025 * (len(boot) - 1))], high=boot[int(.975 * (len(boot) - 1))])
    metrics = _metrics(rows);per_position = {pos: _metrics([r for r in rows if r["position"] == pos]) for pos in reference.POSITIONS}
    weeks = sorted({(r["season"], r["week"]) for r in rows})
    holds = ["owner_approval_required", "operational_sample_sufficiency_not_approved", "prior_game_inventory_not_independently_pinned"]
    if len(weeks) < 2:holds.append("fewer_than_two_newly_graded_weeks")
    if practical_margin is None:holds.append("practical_margin_policy_unreviewed")
    elif metrics["log_loss_difference"] is None or metrics["log_loss_difference"] > -practical_margin:holds.append("practical_improvement_not_met")
    if interval["high"] is None or interval["high"] >= 0:holds.append("clustered_interval_not_below_zero")
    if any(v["n"] == 0 or v["log_loss_difference"] > 0 for v in per_position.values()):holds.append("position_missing_or_worse")
    return seal({"version": 1, "kind": "nfl.r127_evaluation.v1", "policy_id": version, "as_of_utc": as_of_utc,
        "shadow_ids": sorted({doc["shadow_id"] for doc in shadows}), "outcome_pins": pins, "outcome_policy": "explicit_pinned_raw_capture_not_revision_selector",
        "cohort_policy": "earliest_original_forecast_before_outcome_join", "selected_receipt_ids": chosen, "rows": rows, "metrics": metrics,
        "per_position": per_position, "graded_weeks": [list(w) for w in weeks], "paired_interval": interval, "exclusions": dict(sorted(excluded.items())),
        "practical_margin": practical_margin, "margin_authority": "caller_supplied_not_independently_verified",
        "training_completeness_verified": False, "evaluation_scope": "exploratory_paired_metrics_on_captured_prior_game_rows_only",
        "promotion_held": True, "hold_reasons": sorted(holds), "activation": False, "candidate_weight": 0.0,
        "source_authentication": "not_performed", "writes": False, "network_used": False}, "evaluation_id")
