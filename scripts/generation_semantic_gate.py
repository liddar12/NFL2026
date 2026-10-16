"""Opt-in exact-byte MY-yardage generation binding, without IO or activation.

The trusted caller supplies the bytes it actually consumes BEFORE generation;
this module cannot authenticate that call order, the filesystem, provider clocks,
or executed code. It never discovers inputs or modifies the v1 journal contract.
Only the supported consumer scope can pass. QB depth and in-window inactive
freshness remain held until those undefined policy boundaries are implemented.
"""
import ast
import functools
import hashlib
import json
import math

from scripts import availability, build_leg_pool, build_weekly
from scripts import learning_journal, learning_receipts as lr, prepublication_semantics as sem
from scripts import validate_data
from scripts.scrape.renames import canonical_player_name, normalize_team

MAX_BYTES, MAX_FILE, MAX_ROWS = 64 * 1024 * 1024, 16 * 1024 * 1024, 10000
INPUT_NAMES = frozenset(("player_weekly", "player_projections", "game_predictions", "pool_backtest",
    "parlays", "atd_week", "atd_backtest", "excluded_games", "schedule", "parlay_calibration",
    "injuries", "depth_chart", "inactives", "previous_my_cards"))
# The archive preimage is overwritten by this producer. It stays frozen in the
# original capture, not misrepresented as a reread of the now-current archive.
CURRENT_INPUT_NAMES = INPUT_NAMES - {"previous_my_cards"}
CODE_NAMES = frozenset(("scripts/build_leg_pool.py", "scripts/build_my_cards.py", "scripts/learning_journal.py",
    "scripts/learning_receipts.py", "scripts/models/my_cards.py", "scripts/models/parlay_builder.py",
    "scripts/build_weekly.py", "scripts/build_predictions.py", "scripts/availability.py", "scripts/validate_data.py",
    "scripts/excluded_games.py", "scripts/generation_semantic_gate.py", "scripts/prepublication_semantics.py",
    "scripts/publication_observations.py", "scripts/export_learning.py", "scripts/scrape/renames.py"))
POLICY = {"version": 1, "profile": "MY_yardage_consumer_foundation_v1", "injury_max_age_hours": 12.0,
    "inactives_window_hours": 3.0, "depth_max_age_hours": None, "inactives_max_age_hours": None}
FLAGS = {"whole_release_pass": False, "release_authorized": False, "code_execution_authenticated": False,
    "provider_authenticated": False, "provider_completeness_verified": False,
    "historical_original_reads_verified": False, "public_serving_verified": False,
    "model_training_verified": False, "model_adoption": False, "writes": False, "network_used": False}


class GateError(ValueError):
    """Static reason codes only, never input or callback diagnostics."""


def need(value, reason):
    if not value:
        raise GateError(reason)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def fingerprint(value):
    return "sha256:" + hashlib.sha256(encoded(value)).hexdigest()


def _plain(value):
    nodes, used = 0, 0
    def visit(item, depth):
        nonlocal nodes, used
        nodes += 1
        need(nodes <= 500000 and depth <= 32, "generation_binding_work_limit")
        kind = type(item)
        if kind is dict:
            need(all(type(k) is str for k in item), "invalid_plain_json")
            used += 2 + max(0, len(item) - 1)
            result = {}
            for key, child in item.items():
                visit(key, depth + 1);used += 1;result[key] = visit(child, depth + 1)
        elif kind is list:
            used += 2 + max(0, len(item) - 1)
            result = [visit(child, depth + 1) for child in item]
        else:
            need(kind in (str, int, float, bool) or item is None, "invalid_plain_json")
            need(not (kind is str and len(item) > MAX_BYTES - used or kind is int and item.bit_length() > 1024
                      or kind is float and not math.isfinite(item)), "generation_binding_work_limit")
            used += len(encoded(item));result = item
        need(used <= MAX_BYTES, "generation_binding_work_limit")
        return result
    return visit(value, 0)


def _keys(value, names):
    need(type(value) is dict and set(value) == set(names), "invalid_generation_binding_shape")


def _same(left, right, reason):
    need(encoded(left) == encoded(right), reason)


def _time(value):
    need(type(value) is str and lr.instant(value) is not None, "invalid_generation_binding_clock")
    return lr.instant(value)


def _seal(value, field):
    return {**value, field: fingerprint(value)}


def _hashed(value, field):
    need(value.get(field) == fingerprint({k: v for k, v in value.items() if k != field}), "generation_binding_hash_mismatch")


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "duplicate_generation_input_key");result[key] = value
        return result
    def constant(_value):
        raise GateError("nonfinite_generation_input")
    return _plain(json.loads(raw, object_pairs_hook=unique, parse_constant=constant))


def _freeze_bytes(values, names, *, documents):
    _keys(values, names)
    need(all(type(v) is bytes and 0 < len(v) <= MAX_FILE for v in values.values())
         and sum(map(len, values.values())) <= MAX_BYTES, "invalid_or_oversized_generation_bytes")
    result = {}
    for name, raw in values.items():
        text = raw.decode("utf-8")
        entry = {"raw_utf8": text, "raw_sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}
        if documents:entry["content_id"] = fingerprint(_json(raw))
        result[name] = entry
    return result


def _thaw(values, names, *, documents):
    _keys(values, names)
    raw = {}
    for name, entry in values.items():
        _keys(entry, {"raw_utf8", "raw_sha256", "content_id"} if documents else {"raw_utf8", "raw_sha256"})
        need(type(entry["raw_utf8"]) is str, "invalid_generation_raw_text")
        raw[name] = entry["raw_utf8"].encode()
    _same(values, _freeze_bytes(raw, names, documents=documents), "frozen_generation_byte_hash_mismatch")
    return raw


def _source(code, path, name, *, constant=False):
    """Read supplied source as syntax, never execute uploaded Python."""
    text = code[path].decode("utf-8");tree = ast.parse(text)
    nodes = [n for n in tree.body if (isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
             or constant and isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)]
    need(len(nodes) == 1, "unsupported_runtime_source_profile")
    node, = nodes
    if constant:return ast.literal_eval(node.value)
    need(not node.decorator_list, "unsupported_runtime_source_profile")
    return "".join(text.splitlines(keepends=True)[node.lineno - 1:node.end_lineno])


def _static_errors(function):
    @functools.wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except GateError:
            raise
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, SyntaxError):
            raise GateError("malformed_or_unavailable_generation_capture") from None
    return call


@_static_errors
def runtime_binding(code_bytes, input_documents):
    """Compute source/parameter identities from explicit bytes, not execution proof."""
    input_documents = _plain(input_documents)
    _keys(input_documents, INPUT_NAMES)
    frozen = _freeze_bytes(code_bytes, CODE_NAMES, documents=False)
    code = {k: v["raw_utf8"].encode() for k, v in frozen.items()}
    bt, calibration = input_documents["pool_backtest"], input_documents["parlay_calibration"]
    coefficients = {p: v for p, v in (bt.get("calibration") or {}).items() if v}
    pb, receipts = "scripts/models/parlay_builder.py", "scripts/learning_receipts.py"
    seeds = _source(code, pb, "_PROP_SEEDS", constant=True)
    base = fingerprint({"function": "pool_logistic_preclamp_v1", "projection": _source(code, pb, "project_prop_yards"),
        "projection_week_join": _source(code, pb, "_week_row"), "components": {p: v[3] for p, v in seeds.items()},
        "base_formula": _source(code, receipts, "base_probability"), "sigmoid": _source(code, pb, "_sigmoid"),
        "calibration": coefficients, "residual_sd": bt.get("residual_sd") or {}})
    need(_source(code, "scripts/build_weekly.py", "INJURY_MAX_AGE_HOURS", constant=True) == POLICY["injury_max_age_hours"]
         and _source(code, "scripts/build_predictions.py", "INACTIVES_WINDOW_HOURS", constant=True) == POLICY["inactives_window_hours"],
         "unsupported_runtime_freshness_policy")
    return {"code_content_id": fingerprint({k: v["raw_sha256"] for k, v in frozen.items()}),
        "base_model_version": base,
        "selection_policy_version": fingerprint({"policy": "my_cards_beam", "source": code["scripts/models/my_cards.py"].decode()}),
        "joint_model_version": fingerprint({"policy": "my_cards_game_group_probability", "source": code[pb].decode(), "calibration": calibration}),
        "receipt_policy": lr.POLICY, "policy_id": fingerprint(POLICY)}


@_static_errors
def capture_inputs(input_bytes, code_bytes, *, season, week, captured_utc, generation_sha, policy):
    """Call BEFORE the producer, with its actual explicit byte inputs.

An arbitrary later caller can lie about call order: the capture clock, revision
claim and this trusted-caller boundary are explicitly not authenticated here.
"""
    need(type(season) is int and 2000 <= season <= 2100 and type(week) is int and 1 <= week <= 18,
         "invalid_generation_period")
    _time(captured_utc);_same(_plain(policy), POLICY, "unsupported_generation_gate_policy")
    need(type(generation_sha) is str and 0 < len(generation_sha) <= 256, "missing_generation_revision_claim")
    inputs = _freeze_bytes(input_bytes, INPUT_NAMES, documents=True)
    code = _freeze_bytes(code_bytes, CODE_NAMES, documents=False)
    docs = {k: _json(v["raw_utf8"]) for k, v in inputs.items()}
    value = {"version": 1, "kind": "nfl.original_generation_inputs.v1", "season": season, "week": week,
        "captured_utc_claim": captured_utc, "generation_sha_claim": generation_sha,
        "capture_basis": "explicit_bytes_supplied_before_producer_by_trusted_caller_not_authenticated",
        "inputs": inputs, "code": code, "policy": _plain(policy), "runtime": runtime_binding(code_bytes, docs)}
    return _seal(_plain(value), "capture_id")


def _capture(value):
    value = _plain(value)
    _keys(value, {"version", "kind", "season", "week", "captured_utc_claim", "generation_sha_claim", "capture_basis",
        "inputs", "code", "policy", "runtime", "capture_id"})
    _hashed(value, "capture_id")
    raw = _thaw(value["inputs"], INPUT_NAMES, documents=True)
    code = _thaw(value["code"], CODE_NAMES, documents=False)
    expected = capture_inputs(raw, code, season=value["season"], week=value["week"], captured_utc=value["captured_utc_claim"],
        generation_sha=value["generation_sha_claim"], policy=value["policy"])
    _same(value, expected, "unsupported_or_changed_capture_contract")
    return value, {k: _json(v) for k, v in raw.items()}


def _paths(capture):
    return frozenset(("data/leg_pool.json", "data/my_cards/%d_wk%02d.json" % (capture["season"], capture["week"])))


@_static_errors
def bind_generation(capture, graph, output_bytes_by_path, *, target_generation_id, generated_utc, bound_utc):
    """Seal exact target/output bytes separately; never rewrite v1 journal keys."""
    capture, _docs = _capture(capture)
    need(_time(capture["captured_utc_claim"]) <= _time(generated_utc) <= _time(bound_utc), "invalid_generation_binding_order")
    frozen_graph = sem._graph(graph)
    targets = [e["request"]["payload"] for e in frozen_graph["generations"]
               if e["request"]["payload"]["generations"][0]["generation_id"] == target_generation_id]
    need(len(targets) == 1, "missing_or_ambiguous_bound_generation")
    generation = targets[0]["generations"][0]
    need(generation["pool_generated_utc"] == generated_utc and _time(generation["recorded_utc"]) <= _time(bound_utc),
         "generation_clock_not_bound")
    value = {"version": 1, "kind": "nfl.generation_consumer_binding.v1", "capture": capture, "graph": frozen_graph,
        "target_generation_id": target_generation_id, "target_envelope_id": targets[0]["envelope_id"],
        "generated_utc_claim": generated_utc, "bound_utc_claim": bound_utc,
        "outputs": _freeze_bytes(output_bytes_by_path, _paths(capture), documents=True)}
    return _seal(_plain(value), "binding_id")


def _unique(rows, key, reason):
    need(type(rows) is list and len(rows) <= MAX_ROWS and all(type(r) is dict and r.get(key) is not None for r in rows), reason)
    result = {}
    for row in rows:
        need(row[key] not in result, reason);result[row[key]] = row
    return result


def _explicit_source_identity(roster, rows, injury, pool, week):
    """A known provider ID cannot be weakened to an unsuccessful name join.

Only espn-N or an explicit original projection crosswalk is usable. Missing
nflverse→ESPN mappings are not invented from names. A quarantine remains source
uncertainty, not a new medical assertion or a projection zero.
"""
    def identifier(value):
        need(type(value) in (str, int) and type(value) is not bool, "invalid_explicit_injury_identity")
        result = str(value)
        need(1 <= len(result) <= 32 and result.isascii() and result.isdigit()
             and result[0] != "0", "invalid_explicit_injury_identity")
        return result
    matched = {}
    for pid, projection in roster.items():
        ids = {identifier(projection[k]) for k in ("espn_id", "athlete_id") if projection.get(k) is not None}
        if pid.startswith("espn-"):ids.add(identifier(pid[5:]))
        need(len(ids) <= 1, "ambiguous_explicit_projection_identity")
        for eid in ids:
            need(eid not in matched, "ambiguous_explicit_projection_identity");matched[eid] = pid
    evidence = {}
    for row in injury["injuries"]:
        if row.get("athlete_id") is not None:
            evidence.setdefault(identifier(row["athlete_id"]), []).append(row["availability"])
    quarantined = availability.quarantine_scope(list(roster.values()), injury.get("quarantine"))["players"]
    offered = {player["gsis_id"]: player for player in pool["players"]}
    for eid, codes in evidence.items():
        pid = matched.get(eid)
        if pid is None:continue  # No guessed crosswalk to an unrelated GSIS.
        refused = not build_leg_pool.playable_this_week(rows[pid], week)
        if any(code in availability.NOT_PLAYABLE for code in codes):
            need(refused and pid not in offered, "explicit_injury_id_negative_not_refused")
        elif pid not in quarantined and availability.QUESTIONABLE in codes and not refused:
            need((rows[pid].get("availability") or {}).get("status") == availability.QUESTIONABLE
                 and (pid not in offered or offered[pid].get("availability") == availability.QUESTIONABLE),
                 "explicit_injury_id_questionable_warning_missing")


def _consumers(capture, docs, pool, generated, checked):
    season, week = capture["season"], capture["week"]
    for document in docs.values():
        if type(document) is dict:
            for key, low, high in (("season", 2000, 2100), ("week", 1, 18)):
                if key in document:
                    need(type(document[key]) is int and low <= document[key] <= high, "invalid_original_source_period_type")
    weekly, projections, predictions, bt = [docs[k] for k in ("player_weekly", "player_projections", "game_predictions", "pool_backtest")]
    need(all(type(d) is dict and d.get("season") == season for d in (weekly, projections, predictions, docs["schedule"], docs["parlays"])),
         "source_season_mismatch")
    need(type((weekly.get("model") or {}).get("this_week")) is dict and weekly["model"]["this_week"].get("wk") == week
         and docs["parlays"].get("week") == week, "missing_or_wrong_source_week")
    rows = _unique(weekly.get("players"), "gsis_id", "ambiguous_weekly_player")
    roster = _unique(projections.get("players"), "gsis_id", "ambiguous_projection_player")
    games = _unique(predictions.get("games"), "game_id", "ambiguous_prediction_game")
    schedule = _unique(docs["schedule"].get("games"), "game_id", "ambiguous_schedule_game")
    need(all(p in rows for p in roster), "missing_original_weekly_player")
    for pid, projection in roster.items():
        need(type(pid) is str and bool(pid), "invalid_original_player_identity")
        need(all(type(projection.get(key)) is str and 0 < len(projection[key]) <= limit and projection[key].strip()
                 for key, limit in (("team", 100), ("position", 32))), "invalid_original_projection_identity")
        row = rows[pid]
        for key in ("team", "position", "name", "player"):
            if key not in row:continue  # Healthy legacy rows omit display metadata.
            need(type(row[key]) is str and bool(row[key].strip()), "invalid_present_weekly_identity")
            if key == "team":
                need(normalize_team(row[key]) is not None and normalize_team(row[key]) == normalize_team(projection.get("team")),
                     "contradictory_present_weekly_identity")
            elif key == "position":
                need(row[key].strip().upper() == projection.get("position"), "contradictory_present_weekly_identity")
            else:
                need(availability.norm_name(canonical_player_name(row[key])) == availability.norm_name(canonical_player_name(projection.get("name"))),
                     "contradictory_present_weekly_identity")
        weeks = _unique(row.get("weeks"), "wk", "ambiguous_original_player_week")
        need(all(type(w) is int and 1 <= w <= 18 for w in weeks), "invalid_original_player_week_type")
        for metadata in weeks.values():
            need(all(type(metadata[key]) is bool for key in ("bye", "home", "avail") if key in metadata),
                 "invalid_original_player_week_flag")
        need(week in weeks, "missing_original_target_player_week")
        for block, key in ((row.get("this_week"), "wk"), (row.get("eligibility"), "week")):
            if type(block) is dict and key in block:
                need(type(block[key]) is int and block[key] == week, "invalid_original_player_week_type")
    injury = docs["injuries"]
    need(type(injury) is dict and type(injury.get("week")) is int and injury["week"] == week
         and injury.get("season") == season, "missing_or_wrong_injury_period")
    need(type(injury.get("vocab_version")) is int and injury["vocab_version"] == availability.VOCAB_VERSION,
         "unknown_original_injury_vocabulary")
    need(type(injury.get("injuries")) is list and len(injury["injuries"]) <= MAX_ROWS, "invalid_original_injury_rows")
    for row in injury["injuries"]:
        need(type(row) is dict, "invalid_original_injury_rows")
        try:
            canonical = availability.enrich(row)
        except ValueError:
            raise GateError("unquarantined_original_injury_status") from None
        need(canonical["availability"] in availability.CODES, "unquarantined_original_injury_status")
        _same({k: row.get(k) for k in canonical}, canonical, "original_injury_canonical_status_mismatch")
    _same(injury.get("counts"), availability.counts(injury["injuries"]), "original_injury_status_accounting_mismatch")
    for when in (capture["captured_utc_claim"], generated, checked):
        state = build_weekly.injury_source_state(injury, when, week)
        need(state["verified"], "injury_source_" + str(state["reason"]))
    need(injury.get("source_updated_utc") is not None, "unknown_original_injury_provider_clock")
    need(all(_time(injury[k]) <= _time(capture["captured_utc_claim"]) for k in ("source_updated_utc", "received_utc")),
         "injury_evidence_after_original_capture")
    for name in ("player_weekly", "player_projections", "game_predictions", "pool_backtest"):
        doc = docs[name];stamp = doc.get("generated_utc") or doc.get("updated_utc")
        need(_time(stamp) <= _time(capture["captured_utc_claim"]), "consumer_source_after_original_capture")
    _explicit_source_identity(roster, rows, injury, pool, week)
    need(not any(p.get("position") == "QB" for p in roster.values()), "undefined_depth_freshness_policy")
    involved = set()
    for game in list(games.values()) + list(schedule.values()):
        need(type(game.get("game_id")) is str and bool(game["game_id"])
             and type(game.get("week")) is int and 1 <= game["week"] <= 18
             and ("season" not in game or type(game["season"]) is int and game["season"] == season),
             "invalid_original_game_period_or_identity")
    for game in games.values():
        need(type(game.get("week")) is int and game["week"] == week and game["game_id"] in schedule, "game_week_or_schedule_mismatch")
        original = schedule[game["game_id"]]
        need(all(encoded(game.get(k)) == encoded(original.get(k)) for k in ("week", "home", "away", "kickoff_utc", "status")),
             "frozen_game_identity_mismatch")
        need(game.get("home") and game.get("away") and game["home"] != game["away"]
             and not involved.intersection((game["home"], game["away"])), "ambiguous_team_game_join")
        involved.update((game["home"], game["away"]))
        for projection in roster.values():
            if projection.get("team") not in (game["home"], game["away"]):continue
            row = next(w for w in rows[projection["gsis_id"]]["weeks"] if w["wk"] == week)
            home = projection["team"] == game["home"]
            need(row.get("bye") is not True and row.get("opp") == (game["away"] if home else game["home"])
                 and type(row.get("home")) is bool and row["home"] is home, "contradictory_original_week_game_identity")
        need(game.get("status") == "STATUS_SCHEDULED" and _time(checked) < _time(game["kickoff_utc"]), "generation_event_not_pregame")
        # The existing producer defines a three-hour fetch window, but no
        # reviewed stale-inactive age rule. Presence alone cannot fill that gap.
        need((_time(game["kickoff_utc"]) - _time(checked)).total_seconds() > 3 * 3600,
             "undefined_inactive_freshness_or_applicability")
    try:
        validate_data.check_weekly_availability(weekly, projections, injury, docs["depth_chart"], docs["inactives"])
        validate_data.check_no_unplayable_legs(weekly, {"week": week, "parlays": []}, pool)
    except validate_data.ValidationError:
        raise GateError("frozen_source_eligibility_inconsistent") from None
    need(type(docs["excluded_games"]) is dict and type(docs["excluded_games"].get("games")) is list,
         "unknown_original_owner_exclusions")
    excluded = {str(g["game_id"]) for g in docs["excluded_games"]["games"] if g.get("game_id") is not None}
    calibration = {p: v for p, v in (bt.get("calibration") or {}).items() if v}
    need((bt.get("verdict") or {}).get("adopt") is True, "pool_calibration_not_adopted")
    runtime = capture["runtime"];live = bt.get("live_2026") or {}
    adjustment = (live.get("adjustment") if live.get("applied") and live.get("receipt_policy") == lr.POLICY
                  and live.get("base_model_version") == runtime["base_model_version"] else None)
    context = {"season": season, "week": week, "base_model_version": runtime["base_model_version"],
        "forecast_created_utc": generated, "generation_sha": capture["generation_sha_claim"],
        "source_snapshot_id": fingerprint({k: docs[k] for k in sem.UPSTREAM_NAMES}),
        "source_timestamps": {k: docs[k].get("generated_utc") or docs[k].get("updated_utc") for k in sem.UPSTREAM_NAMES}}
    expected, counts = build_leg_pool.prop_legs(list(roster.values()), rows, list(games.values()), calibration,
        {p: tuple(v) for p, v in (bt.get("support") or {}).items()}, bt.get("residual_sd") or {}, bt.get("ladder") or {},
        week, live=adjustment, receipt_context=context)
    expected, dropped = build_leg_pool.drop_excluded(expected, excluded)
    contracts = [lr.canonical_key({**player, **rung}, season) for player in expected for rung in player["rungs"]]
    need(len(contracts) <= MAX_ROWS and None not in contracts and len(set(contracts)) == len(contracts),
         "duplicate_or_invalid_original_prop_contract")
    _same(pool.get("players"), expected, "original_prop_population_or_once_serving_mismatch")
    need(pool.get("base_model_version") == runtime["base_model_version"] and pool.get("learning_receipt_policy") == lr.POLICY,
         "pool_model_or_receipt_policy_mismatch")
    _same(pool.get("live_adjustment"), adjustment, "pool_calibrator_mismatch")
    for key, value in {**counts, "prop_legs": sum(len(p["rungs"]) for p in expected), "players_with_a_leg": len(expected)}.items():
        if key == "excluded_game":continue
        _same((pool.get("counts") or {}).get(key), value, "pool_candidate_accounting_mismatch")
    scope = availability.quarantine_scope(list(roster.values()), injury.get("quarantine"))
    need(expected, "no_supported_MY_prop_population")
    return {"supported_players": len(expected), "supported_rungs": sum(len(p["rungs"]) for p in expected),
        "withheld_not_playable_players": counts["not_playable"], "owner_excluded_prop_players": dropped,
        "row_quarantined_players": len(scope["players"]),
        "unsupported_position_players": sum(p["position"] not in build_leg_pool.POSITIONS for p in roster.values())}


def verify_generation(bundle, *, current_input_bytes, current_code_bytes, current_output_bytes, checked_utc):
    """Recheck the exact final bytes; callers must invoke again after a rebase.

All current-byte arguments must come from trusted runtime, not uploaded claims.
current_input_bytes excludes previous_my_cards, whose original preimage is
frozen separately and whose old cards/runs must survive in the new output.
Missing original sources or undefined policy holds the supported consumer scope;
it never blocks/rewrites historical grading by itself or authorizes publication.
"""
    report = {"version": 1, "kind": "nfl.generation_semantic_gate_report.v1", "status": "held",
        "supported_consumer_pass": False, **FLAGS, "checked_utc_claim": None, "binding_id": None,
        "target_generation_id": None, "target_envelope_id": None, "capture_id": None, "checks": [],
        "reason_codes": [], "coverage": {}, "unsupported": ["Game/Week/ML/ATD", "whole-card and joint probability quality",
            "upstream training/provider completeness", "historical originals/publication", "QB depth and in-window inactive freshness"],
        "authority_basis": "trusted_caller_supplied_original_and_current_bytes_not_authenticated_execution"}
    try:
        checked = _time(checked_utc);report["checked_utc_claim"] = checked_utc
        value = _plain(bundle)
        _keys(value, {"version", "kind", "capture", "graph", "target_generation_id", "target_envelope_id",
            "generated_utc_claim", "bound_utc_claim", "outputs", "binding_id"})
        _hashed(value, "binding_id")
        capture, docs = _capture(value["capture"])
        output = _thaw(value["outputs"], _paths(capture), documents=True)
        expected = bind_generation(capture, value["graph"], output, target_generation_id=value["target_generation_id"],
            generated_utc=value["generated_utc_claim"], bound_utc=value["bound_utc_claim"])
        _same(value, expected, "unsupported_or_changed_generation_binding")
        need(_time(value["bound_utc_claim"]) <= checked, "checked_before_generation_bound")
        report.update(binding_id=value["binding_id"], capture_id=capture["capture_id"],
            target_generation_id=value["target_generation_id"], target_envelope_id=value["target_envelope_id"])
        _same({k: capture["inputs"][k] for k in CURRENT_INPUT_NAMES},
              _freeze_bytes(current_input_bytes, CURRENT_INPUT_NAMES, documents=True), "current_input_bytes_changed")
        _same(capture["code"], _freeze_bytes(current_code_bytes, CODE_NAMES, documents=False), "current_runtime_code_changed")
        _same(value["outputs"], _freeze_bytes(current_output_bytes, _paths(capture), documents=True), "current_output_bytes_changed")
        outputs = {k: _json(raw) for k, raw in output.items()}
        pool = outputs["data/leg_pool.json"]
        need(type(pool) is dict and type(pool.get("season")) is int and type(pool.get("week")) is int
             and (pool["season"], pool["week"]) == (capture["season"], capture["week"])
             and pool.get("generated_utc") == value["generated_utc_claim"], "bound_pool_period_or_clock_mismatch")
        generation = next(e["request"]["payload"]["generations"][0] for e in value["graph"]["generations"]
                          if e["request"]["payload"]["envelope_id"] == value["target_envelope_id"])
        source_by_id = {s["object_id"]: s["payload"] for s in value["graph"]["source_objects"]}
        for name, doc in (("leg_pool", pool), ("schedule", docs["schedule"]), ("parlay_calibration", docs["parlay_calibration"])):
            _same(source_by_id[generation["source_snapshots"][name]], doc, "generation_original_consumer_source_mismatch")
        archive_path = "data/my_cards/%d_wk%02d.json" % (capture["season"], capture["week"])
        previous = docs["previous_my_cards"]
        if previous is not None:
            need(type(previous) is dict and previous.get("season") == capture["season"] and previous.get("week") == capture["week"],
                 "unsupported_original_archive_preimage")
            for name, key in (("cards", "card_id"), ("runs", "pool_generated_utc")):
                old = _unique(previous.get(name), key, "ambiguous_original_archive_history")
                current = _unique(outputs[archive_path].get(name), key, "ambiguous_bound_archive_history")
                need(all(identity in current and encoded(row) == encoded(current[identity]) for identity, row in old.items()),
                     "original_archive_history_changed")
        expectation = {"version": 1, "season": capture["season"], "week": capture["week"],
            "target_generation_id": value["target_generation_id"], "target_envelope_id": value["target_envelope_id"],
            "source_snapshots": generation["source_snapshots"], "output_sha256": value["outputs"][archive_path]["raw_sha256"],
            **{k: capture["runtime"][k] for k in ("base_model_version", "selection_policy_version", "joint_model_version")},
            "code_revision_claim": capture["generation_sha_claim"]}
        diagnostic = sem.verify_candidate(value["graph"], output[archive_path], expectation,
            checked_utc=checked_utc, frozen_inputs={"version": 1, "documents": {k: docs[k] for k in sem.UPSTREAM_NAMES}})
        need(not diagnostic["failures"], "target_receipt_graph_or_membership_invalid")
        coverage = _consumers(capture, docs, pool, value["generated_utc_claim"], checked_utc)
        # Account for every frozen pool rung, including explicit known rejection
        # reasons; an envelope is not allowed to silently omit valid candidates.
        target = next(e["request"]["payload"] for e in value["graph"]["generations"]
                      if e["request"]["payload"]["envelope_id"] == value["target_envelope_id"])
        valid, rejected = set(), {}
        schedule = {str(g["game_id"]): g for g in docs["schedule"]["games"]}
        for player in pool["players"]:
            for rung in player["rungs"]:
                leg = {**player, **rung};source = rung["learning_receipt"]
                reason = learning_journal._candidate_problem(leg, source, pool, schedule.get(str(leg["game_id"])), False,
                    _time(generation["recorded_utc"]))
                if reason:rejected[reason] = rejected.get(reason, 0) + 1
                else:valid.add(source["receipt_id"])
        _same(sorted(valid), generation["receipt_ids"], "incomplete_generation_receipt_population")
        _same(generation["audit"], {"candidate_rungs": coverage["supported_rungs"], "eligible_receipts": len(valid),
            "quarantined_records": sum(rejected.values()), "quarantine_reasons": dict(sorted(rejected.items()))},
            "generation_quarantine_accounting_mismatch")
        need(len(target["receipts"]) == len(valid) and valid, "no_supported_generation_receipts")
        report.update(status="supported_MY_prop_consumer_generation_pass", supported_consumer_pass=True,
            coverage={**coverage, "target_archive_legs": diagnostic["coverage"]["target_prop_legs"],
                "retained_archive_legs": diagnostic["coverage"]["retained_vintage_prop_legs"]},
            checks=["exact_original_current_input_output_code_bytes", "existing_runtime_base_and_policy_identities",
                "frozen_eligibility_and_known_freshness_policy", "original_prop_population_features_and_once_serving",
                "exact_target_receipt_partition_and_output_membership"])
    except (GateError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, SyntaxError, StopIteration) as exc:
        report["reason_codes"] = [str(exc) if isinstance(exc, GateError) else "malformed_or_unavailable_generation_binding"]
    report["report_id"] = fingerprint(report)
    return report
