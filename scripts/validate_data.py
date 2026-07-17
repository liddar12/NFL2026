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

Beyond per-file schema validation we assert two CROSS-FILE invariants that no
single schema can express:

  1. meta.json's `weights` map contains EVERY registry signal name, each at
     exactly 0.0 (the day-zero "started at 0" rule), and nothing extra.
  2. pipeline_status.json is HONEST: the overall `health` equals the worst
     per-feed status (ok < stale < degraded < down). You may not claim "ok"
     while a feed is broken — the silent-scraper-404 lesson, enforced.

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
    "parlays.schema.json": "parlays.json",
    "pipeline_status.schema.json": "pipeline_status.json",
    "meta.schema.json": "meta.json",
    "environment_model.schema.json": "environment_model.json",
    "ai_insights.schema.json": "ai_insights.json",
}

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

def check_meta_weights(meta):
    """Every registry signal present at exactly 0.0, and no unexpected extras."""
    weights = meta.get("weights", {})
    problems = []
    for name in EXPECTED_SIGNALS:
        if name not in weights:
            problems.append("missing signal '%s'" % name)
        elif weights[name] != 0.0:
            problems.append("signal '%s' is %r, expected 0.0 (day-zero rule)"
                            % (name, weights[name]))
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
    """Overall `health` must equal the worst feed status — honesty, not optics."""
    feeds = status.get("feeds", {})
    if not feeds:
        raise ValidationError("pipeline_status.json has no feeds")
    worst = max(_STATUS_SEVERITY[f["status"]] for f in feeds.values())
    worst_label = next(k for k, v in _STATUS_SEVERITY.items() if v == worst)
    health = status.get("health")
    if _STATUS_SEVERITY.get(health) != worst:
        raise ValidationError(
            "pipeline_status.json health %r is dishonest: worst feed status is %r; "
            "health must reflect the worst feed (you cannot report 'ok' while a "
            "feed is broken)" % (health, worst_label))


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

    if failures:
        print("\nVALIDATION FAILED (%d):" % len(failures), file=sys.stderr)
        for f in failures:
            print("  * %s" % f, file=sys.stderr)
        return 1
    print("\nAll data contracts valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
