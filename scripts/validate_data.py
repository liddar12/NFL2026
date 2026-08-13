#!/usr/bin/env python3
"""Contract validator for every data/*.json file — the first gate step.

Stdlib only (Python 3.11). No jsonschema, no pip. We implement just enough of
JSON Schema draft-07 to actually check the contracts in data/contracts/:

    type, required, properties, additionalProperties (bool OR subschema),
    items (array element schema), enum, minimum, maximum, minItems, maxItems.

That subset is exactly what the six contracts use; anything richer is out of
scope on purpose (a validator you can read top-to-bottom is worth more here than
a general one you can't audit). The keywords $schema/$id/title/description are
metadata and ignored.

Beyond per-file schema validation we assert three CROSS-FILE invariants that no
single schema can express:

  1. meta.json's `weights` map contains EVERY registry signal name, each at
     exactly 0.0 (the day-zero "started at 0" rule), and nothing extra.
  2. pipeline_status.json is HONEST: the overall `health` equals the worst
     per-feed status (ok < stale < degraded < down). You may not claim "ok"
     while a feed is broken — the silent-scraper-404 lesson, enforced.
  3. player_weekly.json's AVAILABILITY story agrees with itself and with its two
     sources (Rel17): the weekly points really are reduced by the blocked weeks,
     a stated duration equals the applied one, and no player is flagged
     unavailable without a matching row in data/injuries.json. See
     check_weekly_availability — that last rule is the honest-data rule made
     mechanical: the app may never show an IR badge no feed backs.

Exit code 0 iff everything passes; non-zero with a clear, single-line-per-error
message otherwise. The gate (tests/run_gate.sh) keys on this exit code.
"""

import json
import os
import sys

# Repo root = parent of this scripts/ directory. All paths resolved from here so
# the validator works regardless of the caller's cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
CONTRACTS = os.path.join(ROOT, "data", "contracts")
DATA = os.path.join(ROOT, "data")


def snapshot_schema_for(filename):
    """Route a data/snapshots/ file to the contract that matches its SHAPE.

    Two families coexist under data/snapshots/: point-in-time LOCK arrays
    (e.g. 2026_wk01_games_open.json) and the archived game_predictions.<ts>.json
    copies the gameday cron drops there (byte copies of game_predictions.json —
    a dict, not the lock array). A single blanket schema failed the gameday cron
    with "expected type array, got dict"; route each family to its own schema."""
    if filename.startswith("game_predictions."):
        return "game_predictions.schema.json"
    return "snapshot.schema.json"

# Which schema validates which data file. snapshot.schema.json validates every
# array file dropped into data/snapshots/ (there are none at scaffold time, and
# that is fine — we simply skip an empty directory).
SCHEMA_TO_DATA = {
    "player_projections.schema.json": "player_projections.json",
    "player_history.schema.json": "player_history.json",
    "player_weekly.schema.json": "player_weekly.json",
    "game_predictions.schema.json": "game_predictions.json",
    "team_strength.schema.json": "team_strength.json",
    "game_script.schema.json": "game_script.json",
    "oline_composite.schema.json": "oline_composite.json",
    "market_prices.schema.json": "market_prices.json",
    "playoff_odds.schema.json": "playoff_odds.json",
    "defense_composite.schema.json": "defense_composite.json",
    "adp.schema.json": "adp.json",
    "parlays.schema.json": "parlays.json",
    "pipeline_status.schema.json": "pipeline_status.json",
    "meta.schema.json": "meta.json",
    "environment_model.schema.json": "environment_model.json",
    "ai_insights.schema.json": "ai_insights.json",
    "epa_history.schema.json": "epa_history.json",
    "weather_history.schema.json": "weather_history.json",
    "weather_forecast.schema.json": "weather_forecast.json",
    "market_baseline.schema.json": "market_baseline.json",
    "injury_history.schema.json": "injury_history.json",
    "injuries.schema.json": "injuries.json",
    "player_usage.schema.json": "player_usage.json",
    "player_usage_history.schema.json": "player_usage_history.json",
    "ros_backtest.schema.json": "ros_backtest.json",
    "adp_history.schema.json": "adp_history.json",
}

# Files whose FIRST build happens on a GitHub runner (the sandbox proxy blocks
# their upstream): validated strictly when present, but absence is not a
# failure until the bootstrap workflow has run.
OPTIONAL_DATA = frozenset([
    "epa_history.json", "weather_history.json", "weather_forecast.json",
    "market_baseline.json", "injury_history.json", "player_usage.json",
    "player_usage_history.json", "ros_backtest.json", "adp_history.json",
])

# The signal registry, mirrored name-for-name from scripts/signals/registry.py.
# Kept as a literal (not imported) so the validator has ZERO local imports and
# runs even if the signals package is mid-edit. If registry.py changes, this and
# data/meta.json must change with it — signal_registry.test.mjs guards meta.json.
EXPECTED_SIGNALS = [
    # player (19)
    "prior_perf", "age_curve", "injury_status", "injury_history",
    "ol_composite_vs_dl", "target_competition", "qb_accuracy_delta",
    "qb_coaching", "coordinator_change", "head_coach_change", "scheme_fit",
    "supporting_cast_delta", "one_on_one_matchup", "schedule_strength",
    "home_away", "indoor_outdoor", "weather", "rest_days", "off_field",
    # game (10)
    "elo", "market_spread", "market_moneyline", "market_total", "j5l_composite",
    "home_field", "rest_differential", "travel", "weather_game", "injury_impact",
    # market (3)
    "odds_api", "kalshi", "polymarket",
]

# Ordered severity for the pipeline-health honesty check.
_STATUS_SEVERITY = {"ok": 0, "stale": 1, "degraded": 2, "down": 3}


class ValidationError(Exception):
    """A single contract or invariant violation, with a human-readable path."""


# ---------------------------------------------------------------------------
# Minimal draft-07 subset validator.
# ---------------------------------------------------------------------------

def _type_ok(value, type_name):
    """Return True if `value` matches a single JSON Schema `type` name.

    Note the bool/int trap: in Python `True`/`False` are ints, but JSON Schema
    treats booleans and numbers as distinct. We exclude bool from integer/number
    and vice-versa so a stray boolean can never masquerade as a count.
    """
    if type_name == "object":
        return isinstance(value, dict)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "null":
        return value is None
    raise ValidationError("unknown schema type %r" % (type_name,))


def _check_type(value, schema, path, errors):
    """Validate the `type` keyword, which may be a string or a list of strings."""
    if "type" not in schema:
        return True
    t = schema["type"]
    types = t if isinstance(t, list) else [t]
    if not any(_type_ok(value, tn) for tn in types):
        errors.append("%s: expected type %s, got %s"
                      % (path, "|".join(types), type(value).__name__))
        return False
    return True


def _validate(value, schema, path, errors):
    """Recursively validate `value` against `schema`, collecting error strings.

    Returns nothing; appends to `errors`. We keep going after a failure so one
    run reports as many problems as possible instead of one-at-a-time.
    """
    # type (gate the rest on it: e.g. don't check `properties` on a non-object)
    if not _check_type(value, schema, path, errors):
        return

    # enum
    if "enum" in schema and value not in schema["enum"]:
        errors.append("%s: value %r not in enum %r" % (path, value, schema["enum"]))

    # numeric bounds (only meaningful for numbers; skip bools)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append("%s: %r < minimum %r" % (path, value, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            errors.append("%s: %r > maximum %r" % (path, value, schema["maximum"]))

    # object: required, properties, additionalProperties
    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                errors.append("%s: missing required property '%s'" % (path, req))
        props = schema.get("properties", {})
        addl = schema.get("additionalProperties", True)
        for key, sub in value.items():
            child = "%s.%s" % (path, key)
            if key in props:
                _validate(sub, props[key], child, errors)
            elif addl is False:
                errors.append("%s: additional property '%s' not allowed" % (path, key))
            elif isinstance(addl, dict):
                # additionalProperties as a subschema (used by meta.weights,
                # meta.models, pipeline feeds) — validate the value against it.
                _validate(sub, addl, child, errors)
            # addl is True (or missing) => anything goes; nothing to check.

    # array: items, minItems, maxItems
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append("%s: array has %d items, minItems %d"
                          % (path, len(value), schema["minItems"]))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append("%s: array has %d items, maxItems %d"
                          % (path, len(value), schema["maxItems"]))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, elem in enumerate(value):
                _validate(elem, item_schema, "%s[%d]" % (path, i), errors)


def validate_against_schema(data, schema, label):
    """Validate `data` against `schema`; raise ValidationError listing all misses."""
    errors = []
    _validate(data, schema, label, errors)
    if errors:
        raise ValidationError("%s failed schema validation:\n  - %s"
                              % (label, "\n  - ".join(errors)))


# ---------------------------------------------------------------------------
# Cross-file invariants.
# ---------------------------------------------------------------------------

# MARKET INDEPENDENCE (user policy, PERMANENT): market-price signals are
# DISPLAY ONLY. They are pinned to weight 0.0 forever — even after the day-zero
# rule relaxes for earned signals, these may never be fitted. Any optimizer
# that writes a non-zero weight here reds the gate and nothing deploys.
MARKET_DISPLAY_ONLY = frozenset([
    "market_spread", "market_moneyline", "market_total",
    "odds_api", "kalshi", "polymarket",
])


def check_meta_weights(meta):
    """Every registry signal present at exactly 0.0, and no unexpected extras.

    When signals start earning weight the blanket 0.0 assertion will relax —
    but the MARKET_DISPLAY_ONLY subset stays pinned at 0.0 permanently (the
    dedicated loop below stands on its own so relaxing day-zero cannot
    accidentally unpin the market signals)."""
    weights = meta.get("weights", {})
    problems = []
    for name in EXPECTED_SIGNALS:
        if name not in weights:
            problems.append("missing signal '%s'" % name)
        elif weights[name] != 0.0:
            problems.append("signal '%s' is %r, expected 0.0 (day-zero rule)"
                            % (name, weights[name]))
    for name in MARKET_DISPLAY_ONLY:
        if weights.get(name, 0.0) != 0.0:
            problems.append(
                "signal '%s' is %r — MARKET DISPLAY-ONLY POLICY: market prices "
                "are never weighted into predictions" % (name, weights[name]))
    extra = set(weights) - set(EXPECTED_SIGNALS)
    if extra:
        problems.append("unexpected weight(s): %s" % ", ".join(sorted(extra)))
    if len(weights) != len(EXPECTED_SIGNALS):
        problems.append("weight count %d != expected %d"
                        % (len(weights), len(EXPECTED_SIGNALS)))
    if problems:
        raise ValidationError("meta.json weights invariant:\n  - %s"
                              % "\n  - ".join(problems))


def check_pipeline_health(status):
    """Overall `health` must equal the worst CONFIGURED feed status.

    Honesty, not optics — with one carve-out: a feed that is 'unconfigured'
    (needs a key / integration the owner has not turned on) is excluded from
    the health roll-up, because "not set up" is a fact, not a failure. A feed
    that WAS working and broke is degraded/down and still drags health. The UI
    surfaces unconfigured feeds separately ("N awaiting config")."""
    feeds = status.get("feeds", {})
    if not feeds:
        raise ValidationError("pipeline_status.json has no feeds")
    configured = [f for f in feeds.values() if f["status"] != "unconfigured"]
    if not configured:
        raise ValidationError("pipeline_status.json: every feed unconfigured?")
    worst = max(_STATUS_SEVERITY[f["status"]] for f in configured)
    worst_label = next(k for k, v in _STATUS_SEVERITY.items() if v == worst)
    health = status.get("health")
    if _STATUS_SEVERITY.get(health) != worst:
        raise ValidationError(
            "pipeline_status.json health %r is dishonest: worst configured feed "
            "status is %r; health must reflect the worst configured feed (you "
            "cannot report 'ok' while a feed is broken)" % (health, worst_label))


# Mirrors scripts/availability.norm_name ("A.J. Brown" == "AJ Brown"). Duplicated
# rather than imported ON PURPOSE: this validator keeps ZERO local imports so it
# still runs while the scripts/ package is mid-edit, and — more importantly — a
# cross-file checker that imported the producer's own helpers would be grading the
# pipeline with the pipeline's own marking scheme. Two independent spellings of
# the join key is the point.
def _norm_name(name):
    return " ".join(str(name or "").replace(".", "").lower().split())


# The eight canonical availability codes (scripts/availability.CODES), mirrored as
# a literal for the same reason as EXPECTED_SIGNALS above.
_AVAIL_CODES = frozenset([
    "ACTIVE", "QUESTIONABLE", "DOUBTFUL", "OUT", "IR", "PUP", "NFI", "SUSPENDED",
])


def check_weekly_availability(weekly, projections, injuries):
    """Rel17: player_weekly.json's availability story must agree with itself.

    Five rules, each one a bug this release fixed:

      1. sum(non-bye pts) == proj_points * available_non_bye / total_non_bye
         (+/-0.1) for EVERY player. This is F2: before Rel17 the weekly split
         renormalized the blocked weeks away, so an injury only RESHAPED the
         curve and the season total never moved. A player who will not take a
         snap must not carry 100% of his season points — and equally, a merely
         QUESTIONABLE player's total must still be preserved exactly.
      2. out_for_season => every non-bye pts is exactly 0.0.
      3. count(weeks with avail:false) == weeks_out, or every non-bye week when
         out_for_season. `weeks_out` is a DURATION STATEMENT and `avail:false` is
         its APPLIED CONSEQUENCE; this is what lets weeks[].avail stay the single
         carrier for blocked weeks instead of a second, driftable array.
      4. NO ORPHAN FLAGS: every player carrying an `availability` block has a
         matching (team, normalized name) row in data/injuries.json whose
         canonical code equals the flagged status. The honest-data rule made
         mechanical — the app can never show an IR badge that no feed backs.
      5. model.availability.unavailable == the count of class "season" players,
         and season_points_removed == sum(season_points_lost) (+/-0.05).

    `injuries` may be None (feed never fetched). That is not a failure in itself —
    but it makes ANY availability flag an orphan, which rule 4 then reports.
    """
    problems = []
    proj = {p["gsis_id"]: p for p in projections.get("players", [])}

    # (team, normalized name) -> {canonical codes on that player's report rows}
    report = {}
    for row in (injuries or {}).get("injuries", []):
        code = row.get("availability")
        if not code:
            continue  # unmapped rows are the smoke check's business, not ours
        report.setdefault((row.get("team"), _norm_name(row.get("player"))),
                          set()).add(code)

    season_players = 0
    season_ending = 0
    points_lost = 0.0

    for pl in weekly.get("players", []):
        pid = pl.get("gsis_id")
        weeks = pl.get("weeks", [])
        non_bye = [w for w in weeks if not w.get("bye")]
        blocked = [w for w in non_bye if w.get("avail") is False]
        avail = pl.get("availability")

        # A blocked week with no availability block is a flag with no story.
        if blocked and not avail:
            problems.append("%s: %d week(s) marked avail:false with no availability "
                            "block" % (pid, len(blocked)))
        if any(w.get("avail") is False for w in weeks if w.get("bye")):
            problems.append("%s: a bye week is marked avail:false (bye and "
                            "unavailable are deliberately distinguishable)" % pid)
        for w in blocked:
            if w.get("pts") != 0.0:
                problems.append("%s: wk%s is avail:false but scores %r"
                                % (pid, w.get("wk"), w.get("pts")))

        # --- rule 1 -----------------------------------------------------------
        record = proj.get(pid)
        if record is None:
            problems.append("%s: in player_weekly.json but not in "
                            "player_projections.json" % pid)
        elif non_bye:
            target = record["proj_points"] * (len(non_bye) - len(blocked)) / len(non_bye)
            total = sum(w.get("pts", 0.0) for w in non_bye)
            if abs(total - target) > 0.1:
                problems.append(
                    "%s: non-bye weeks sum to %.2f, expected %.2f (proj %.2f * %d "
                    "playable / %d non-bye)"
                    % (pid, total, target, record["proj_points"],
                       len(non_bye) - len(blocked), len(non_bye)))

        if not avail:
            continue

        # --- rule 4 -----------------------------------------------------------
        if record is not None:
            key = (record.get("team"), _norm_name(record.get("name")))
            codes = report.get(key)
            if codes is None:
                problems.append(
                    "%s (%s %s): flagged %s with NO matching row in "
                    "data/injuries.json — you may not mark a player unavailable "
                    "without a source row"
                    % (pid, record.get("team"), record.get("name"),
                       avail.get("status")))
            elif avail.get("status") not in codes:
                problems.append(
                    "%s (%s %s): flagged %s but data/injuries.json says %s"
                    % (pid, record.get("team"), record.get("name"),
                       avail.get("status"), sorted(codes)))
        if avail.get("status") not in _AVAIL_CODES:
            problems.append("%s: availability.status %r is not a canonical code"
                            % (pid, avail.get("status")))

        if avail.get("class") != "season":
            if blocked:
                problems.append("%s: class %r blocked %d week(s) — only the season "
                                "class may zero weeks" % (pid, avail.get("class"),
                                                          len(blocked)))
            continue

        # --- season class: rules 2, 3, 5 --------------------------------------
        # FLAG-ONLY ROW. build_weekly emits exactly {status, class} — and NONE of
        # the five season keys — for a season-class status that blocked nothing:
        # a suspension whose length was never announced. It states no duration, so
        # there is nothing to reconcile against `avail:false` and nothing for the
        # model summary to count. Enforcing rules 3 and 5 on it reds the gate on a
        # document the producer emits by design (and the schema allows: only
        # `status` and `class` are required). Deliberately tight — the two-key
        # shape with zero blocked weeks and nothing else.
        if set(avail) == {"status", "class"} and not blocked:
            continue

        season_players += 1
        points_lost += float(avail.get("season_points_lost") or 0.0)
        if avail.get("out_for_season"):
            season_ending += 1
            if any(w.get("pts") != 0.0 for w in non_bye):
                problems.append("%s: out_for_season but some non-bye week still "
                                "scores" % pid)
            if len(blocked) != len(non_bye):
                problems.append("%s: out_for_season but only %d of %d non-bye weeks "
                                "are avail:false" % (pid, len(blocked), len(non_bye)))
            if avail.get("weeks_out") is not None:
                problems.append("%s: out_for_season must not also state weeks_out "
                                "(%r)" % (pid, avail.get("weeks_out")))
        else:
            if avail.get("weeks_out") != len(blocked):
                problems.append(
                    "%s: weeks_out %r != %d week(s) actually marked avail:false — a "
                    "duration statement and its applied consequence must agree"
                    % (pid, avail.get("weeks_out"), len(blocked)))
        if avail.get("confidence") == "explicit" and not avail.get("evidence"):
            problems.append("%s: confidence 'explicit' with no evidence sentence to "
                            "quote" % pid)
        if avail.get("confidence") == "rule" and avail.get("evidence"):
            problems.append("%s: confidence 'rule' means nothing was stated, so it "
                            "may not carry evidence" % pid)

    # --- rule 5 ---------------------------------------------------------------
    model = (weekly.get("model") or {}).get("availability")
    if season_players and not model:
        problems.append("%d season-class player(s) but model.availability is absent"
                        % season_players)
    elif model and not season_players:
        problems.append("model.availability claims %r unavailable but no player "
                        "carries a season-class block" % model.get("unavailable"))
    elif model:
        if model.get("unavailable") != season_players:
            problems.append("model.availability.unavailable %r != %d season-class "
                            "player(s)" % (model.get("unavailable"), season_players))
        if model.get("season_ending") != season_ending:
            problems.append("model.availability.season_ending %r != %d"
                            % (model.get("season_ending"), season_ending))
        removed = float(model.get("season_points_removed") or 0.0)
        if abs(removed - points_lost) > 0.05:
            problems.append("model.availability.season_points_removed %.2f != "
                            "%.2f summed over players" % (removed, points_lost))

    if problems:
        raise ValidationError("player_weekly.json availability invariant:\n  - %s"
                              % "\n  - ".join(problems))


# ---------------------------------------------------------------------------
# Selftest — a check nobody has watched fail is a check that might do nothing.
# ---------------------------------------------------------------------------

def _fixture(blocked=0, weeks_out=None, out_for_season=False, klass="season"):
    """A one-player weekly/projections/injuries triple, valid by construction.

    Season 100.0 over 17 non-bye weeks (wk18 is the bye), `blocked` of them zeroed,
    the rest carrying an equal share of the availability-adjusted target.
    """
    non_bye, share = 17, 0.0
    playable = non_bye - blocked
    if playable:
        share = round(100.0 * playable / non_bye / playable, 2)
    weeks = []
    for wk in range(1, 19):
        if wk == 18:
            weeks.append({"wk": wk, "opp": None, "home": False, "bye": True, "pts": 0.0})
        elif wk <= blocked:
            weeks.append({"wk": wk, "opp": "SEA", "home": True, "bye": False,
                          "pts": 0.0, "avail": False})
        else:
            weeks.append({"wk": wk, "opp": "SEA", "home": True, "bye": False,
                          "pts": share})
    avail = {"status": "IR" if klass == "season" else "QUESTIONABLE", "class": klass}
    if klass == "season":
        avail.update({"weeks_out": weeks_out, "out_for_season": out_for_season,
                      "confidence": "rule", "evidence": None,
                      "season_points_lost": round(100.0 * blocked / non_bye, 2)})
    model = {"name": "weekly_split_v1"}
    if klass == "season" and blocked:
        model["availability"] = {
            "applied": True, "vocab_version": 1, "unavailable": 1,
            "season_ending": 1 if out_for_season else 0, "min_weeks_rule": 4,
            "season_points_removed": avail["season_points_lost"]}
    weekly = {"model": model,
              "players": [{"gsis_id": "espn-1", "availability": avail, "weeks": weeks}]}
    projections = {"players": [{"gsis_id": "espn-1", "name": "A.J. Hurt",
                                "team": "SF", "proj_points": 100.0}]}
    injuries = {"injuries": [{"team": "SF", "player": "AJ Hurt",
                              "status": "Injured Reserve" if klass == "season"
                              else "Questionable",
                              "availability": "IR" if klass == "season"
                              else "QUESTIONABLE"}]}
    return weekly, projections, injuries


def _selftest():
    def ok(w, p, i, why):
        check_weekly_availability(w, p, i)  # must not raise

    def red(w, p, i, why):
        try:
            check_weekly_availability(w, p, i)
        except ValidationError:
            return
        raise AssertionError("check_weekly_availability did NOT catch: " + why)

    # Healthy baselines pass: a season-class block with the rule floor, a week-class
    # ding that blocks nothing, and a full season-ending absence.
    ok(*_fixture(blocked=4, weeks_out=4), why="rule-floor IR")
    ok(*_fixture(blocked=0, klass="week"), why="questionable, nothing blocked")
    ok(*_fixture(blocked=17, out_for_season=True), why="out for the year")

    # F2 — the defect this release exists to kill: an unavailable player whose weeks
    # were renormalized back up to the full season total.
    w, p, i = _fixture(blocked=4, weeks_out=4)
    for wk in w["players"][0]["weeks"]:
        if not wk["bye"] and wk["pts"]:
            wk["pts"] = round(100.0 / 13, 2)
    red(w, p, i, "blocked weeks renormalized away (season total never dropped)")

    # Rule 2 — out_for_season while still scoring.
    w, p, i = _fixture(blocked=17, out_for_season=True)
    w["players"][0]["weeks"][0]["pts"] = 5.0
    red(w, p, i, "out_for_season with a scoring week")

    # Rule 3 — the duration statement and its applied consequence disagree.
    w, p, i = _fixture(blocked=4, weeks_out=6)
    red(w, p, i, "weeks_out 6 but only 4 weeks blocked")

    # Rule 4 — an IR badge no feed backs, and one the feed contradicts.
    w, p, i = _fixture(blocked=4, weeks_out=4)
    red(w, p, {"injuries": []}, "availability flag with no source row")
    red(w, p, None, "availability flag with no injuries feed at all")
    w, p, i = _fixture(blocked=4, weeks_out=4)
    i["injuries"][0]["availability"] = "QUESTIONABLE"
    red(w, p, i, "flagged IR while the report says QUESTIONABLE")
    w, p, i = _fixture(blocked=4, weeks_out=4)
    i["injuries"][0]["player"] = "Someone Else"
    red(w, p, i, "join on the wrong player")

    # Rule 5 — the headline must equal what happened.
    w, p, i = _fixture(blocked=4, weeks_out=4)
    w["model"]["availability"]["season_points_removed"] = 0.0
    red(w, p, i, "model claims 0.0 points removed while a player lost 23.53")
    w, p, i = _fixture(blocked=4, weeks_out=4)
    del w["model"]["availability"]
    red(w, p, i, "season-class player with no model.availability summary")

    # A week-class ding may shape, never block.
    w, p, i = _fixture(blocked=4, weeks_out=4, klass="week")
    i["injuries"][0]["availability"] = "QUESTIONABLE"
    red(w, p, i, "week-class status zeroing weeks")

    # A blocked week with no story at all.
    w, p, i = _fixture(blocked=4, weeks_out=4)
    del w["players"][0]["availability"]
    red(w, p, i, "avail:false week with no availability block")

    # FLAG-ONLY: a suspension of unannounced length blocks nothing and claims
    # nothing. build_weekly emits exactly {status, class} here, so the validator
    # must accept it — and must still red the moment it blocks a week or half-
    # states a duration.
    w, p, i = _fixture(blocked=0, weeks_out=None)
    w["players"][0]["availability"] = {"status": "SUSPENDED", "class": "season"}
    w["model"].pop("availability", None)
    i["injuries"][0]["availability"] = "SUSPENDED"
    i["injuries"][0]["status"] = "Suspension"
    ok(w, p, i, why="season-class flag that blocked nothing")
    w["players"][0]["availability"]["weeks_out"] = 3
    red(w, p, i, "a duration stated while nothing was blocked")

    # The join must survive punctuation ("A.J." vs "AJ") — it did above, in every
    # passing case; assert the negative so a no-op _norm_name cannot hide.
    assert _norm_name("A.J. Brown") == _norm_name("AJ  brown") == "aj brown"

    print("selftest OK: availability cross-file invariant catches renormalized "
          "blocked weeks, duration/consequence drift, orphan flags and a dishonest "
          "model summary")


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------

def _load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main():
    failures = []

    # 1) Per-file schema validation.
    for schema_name, data_name in SCHEMA_TO_DATA.items():
        schema_path = os.path.join(CONTRACTS, schema_name)
        data_path = os.path.join(DATA, data_name)
        if data_name in OPTIONAL_DATA and not os.path.exists(data_path):
            print("skip  %-28s (runner-built, not present yet)" % data_name)
            continue
        try:
            schema = _load(schema_path)
        except (OSError, ValueError) as exc:
            failures.append("cannot load schema %s: %s" % (schema_name, exc))
            continue
        try:
            data = _load(data_path)
        except (OSError, ValueError) as exc:
            failures.append("cannot load data %s: %s" % (data_name, exc))
            continue
        try:
            validate_against_schema(data, schema, data_name)
            print("ok    %-28s vs %s" % (data_name, schema_name))
        except ValidationError as exc:
            failures.append(str(exc))

    # 1b) Snapshot files. Two families live under data/snapshots/, each with its
    # own shape — route each to the RIGHT schema (a single blanket schema fails the
    # gameday cron, which archives game_predictions copies alongside the locks):
    #   * point-in-time LOCKS (e.g. 2026_wk01_games_open.json) -> snapshot.schema.json
    #     (an array of locked prediction rows the harness grades against FINAL).
    #   * archived game_predictions.<ts>.json -> game_predictions.schema.json
    #     (byte copies of data/game_predictions.json, a dict — NOT the lock array).
    snap_dir = os.path.join(DATA, "snapshots")
    _schema_cache = {}
    if os.path.isdir(snap_dir):
        snap_files = [f for f in sorted(os.listdir(snap_dir)) if f.endswith(".json")]
        if snap_files:
            try:
                for f in snap_files:
                    schema_name = snapshot_schema_for(f)
                    if schema_name not in _schema_cache:
                        _schema_cache[schema_name] = _load(os.path.join(CONTRACTS, schema_name))
                    data = _load(os.path.join(snap_dir, f))
                    validate_against_schema(data, _schema_cache[schema_name], "snapshots/" + f)
                    print("ok    snapshots/%-30s vs %s" % (f, schema_name))
            except (OSError, ValueError, ValidationError) as exc:
                failures.append(str(exc))
        else:
            print("ok    no snapshot files to validate (data/snapshots/ empty)")

    # 2) Cross-file invariants.
    try:
        check_meta_weights(_load(os.path.join(DATA, "meta.json")))
        print("ok    meta.json signal-registry invariant (32 signals @ 0.0)")
    except (OSError, ValueError, ValidationError) as exc:
        failures.append(str(exc))
    try:
        check_pipeline_health(_load(os.path.join(DATA, "pipeline_status.json")))
        print("ok    pipeline_status.json health honesty invariant")
    except (OSError, ValueError, ValidationError) as exc:
        failures.append(str(exc))
    try:
        inj_path = os.path.join(DATA, "injuries.json")
        check_weekly_availability(
            _load(os.path.join(DATA, "player_weekly.json")),
            _load(os.path.join(DATA, "player_projections.json")),
            _load(inj_path) if os.path.exists(inj_path) else None,
        )
        print("ok    player_weekly.json availability cross-file invariant")
    except (OSError, ValueError, ValidationError) as exc:
        failures.append(str(exc))

    if failures:
        print("\nVALIDATION FAILED (%d):" % len(failures), file=sys.stderr)
        for f in failures:
            print("  * %s" % f, file=sys.stderr)
        return 1
    print("\nAll data contracts valid.")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
        sys.exit(0)
    sys.exit(main())
