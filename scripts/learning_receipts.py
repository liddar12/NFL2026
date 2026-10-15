"""Immutable MY-prop probability lineage. Pure stdlib; never reconstruct legacy inputs.

Internal pre-event receipts support the learner. They do not establish public
availability: publication_status remains generated_unverified until a publisher
can supply separate evidence. The correction always consumes the pre-clamp base.
"""
import datetime as dt
import hashlib
import json
import math

POLICY = "base_receipt_v1"
PROP_MARKETS = frozenset(("qb_pass_yds", "rb_rush_yds", "wr_rec_yds"))


def fingerprint(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=True, allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def canonical_key(leg, season):
    """Abbreviated display names are deliberately absent from event identity."""
    if not isinstance(season, int) or isinstance(season, bool):
        return None
    gid = leg.get("game_id")
    pid = leg.get("player_id") or leg.get("gsis_id")
    market, line, side = leg.get("market"), leg.get("line"), leg.get("side")
    direction = leg.get("direction", "over")
    comparison = leg.get("comparison_operator", "gte")
    if (not gid or not pid or market not in PROP_MARKETS or not finite_number(line)
            or line <= 0 or side not in ("home", "away") or direction != "over" or comparison != "gte"):
        return None
    return (season, str(gid), str(pid), market, format(float(line), ".12g"), side, direction, comparison)


def instant(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def serve_probability(base_prob, adjustment=None):
    """Exactly the output evaluated and served: correction once, clamp, 4dp."""
    if not finite_number(base_prob) or not 0 < base_prob < 1:
        raise ValueError("base probability must be finite and strictly between zero and one")
    p = float(base_prob)
    if adjustment is not None:
        a, b = adjustment.get("a"), adjustment.get("b")
        if not finite_number(a) or not finite_number(b) or b <= 0:
            raise ValueError("calibrator must have finite coefficients and positive slope")
        q = min(max(p, 1e-4), 1.0 - 1e-4)
        z = a + b * math.log(q / (1 - q))
        p = 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))
    return round(min(max(p, .05), .95), 4)


def base_probability(coef, z, p_team):
    """Single pre-clamp base calculation, shared by serving and its receipt."""
    from scripts.models.parlay_builder import _sigmoid
    return _sigmoid(coef["a"] + coef["b"] * z + coef["c"] * (p_team - .5))


def base_version(calibration, residual_sd):
    # No generation time, week, outcomes or live correction in this identity.
    from scripts.models.parlay_builder import project_prop_yards, _week_row, _PROP_SEEDS, _sigmoid
    import inspect
    return fingerprint({"function": "pool_logistic_preclamp_v1",
                        "projection": inspect.getsource(project_prop_yards),
                        "projection_week_join": inspect.getsource(_week_row),
                        "components": {p: v[3] for p, v in _PROP_SEEDS.items()},
                        "base_formula": inspect.getsource(base_probability),
                        "sigmoid": inspect.getsource(_sigmoid),
                        "calibration": calibration, "residual_sd": residual_sd})


def make_receipt(leg, base_prob, adjustment, context, features=None, input_context=None):
    key = canonical_key(leg, context.get("season"))
    if key is None:
        raise ValueError("cannot issue learning receipt without canonical prop identity")
    correction = dict(adjustment) if adjustment is not None else None
    receipt = {"version": 1, "contract_id": fingerprint(list(key)),
               "season": key[0], "week": context["week"], "game_id": key[1],
               "player_id": key[2], "market": key[3], "line": float(leg["line"]),
               "side": key[5], "direction": key[6], "comparison_operator": key[7], "base_prob": base_prob,
               "served_prob": serve_probability(base_prob, correction),
               "base_model_version": context["base_model_version"],
               "calibrator_version": fingerprint(correction), "calibrator": correction,
               "forecast_created_utc": context["forecast_created_utc"],
               "source_snapshot_id": context["source_snapshot_id"],
               "source_timestamps": dict(context.get("source_timestamps", {})),
               "generation_sha": context.get("generation_sha"),
               "publication_status": "generated_unverified"}
    if features is not None:
        receipt["features"] = json.loads(json.dumps(features, allow_nan=False))
    if input_context is not None:
        receipt["input_context"] = json.loads(json.dumps(input_context, allow_nan=False))
    receipt["receipt_id"] = fingerprint(receipt)
    return receipt


def receipt_problem(receipt, leg, season, week):
    """Return a quarantine reason, or None. Never derive a missing base."""
    if not isinstance(receipt, dict) or type(receipt.get("version")) is not int or receipt.get("version") != 1:
        return "missing_or_unsupported_receipt"
    key = canonical_key(leg, season)
    if key is None or canonical_key(receipt, season) != key:
        return "identity_mismatch"
    if receipt.get("season") != season or receipt.get("week") != week:
        return "event_period_mismatch"
    if receipt.get("contract_id") != fingerprint(list(key)):
        return "contract_hash_mismatch"
    payload = {k: v for k, v in receipt.items() if k != "receipt_id"}
    try:
        if receipt.get("receipt_id") != fingerprint(payload):
            return "receipt_hash_mismatch"
        if receipt.get("calibrator_version") != fingerprint(receipt.get("calibrator")):
            return "calibrator_hash_mismatch"
        expected = serve_probability(receipt.get("base_prob"), receipt.get("calibrator"))
    except (ValueError, TypeError, AttributeError, OverflowError):
        return "invalid_probability_or_calibrator"
    if receipt.get("served_prob") != expected or leg.get("model_prob") != expected:
        return "serving_parity_mismatch"
    features = receipt.get("features")
    if not isinstance(features, dict):
        return "missing_frozen_features"
    if (features.get("market") != key[3] or not finite_number(features.get("line"))
            or features.get("line") != leg.get("line")
            or not all(finite_number(features.get(k)) for k in ("mu", "sd", "z", "p_team"))
            or features["sd"] <= 0 or not 0 <= features["p_team"] <= 1
            or not isinstance(features.get("correlation_tags"), list)
            or not all(isinstance(t, str) for t in features["correlation_tags"])):
        return "invalid_frozen_features"
    try:
        feature_z = (features["mu"] - features["line"]) / features["sd"]
        if (not math.isclose(features["z"], feature_z, rel_tol=1e-12, abs_tol=1e-12)
                or base_probability(features["calibration"], features["z"], features["p_team"]) != receipt["base_prob"]):
            return "base_feature_parity_mismatch"
    except (KeyError, TypeError, ValueError, OverflowError):
        return "invalid_frozen_features"
    if not receipt.get("base_model_version") or not receipt.get("source_snapshot_id"):
        return "missing_model_or_source_version"
    created = instant(receipt.get("forecast_created_utc"))
    if created is None:
        return "invalid_receipt_time"
    timestamps = receipt.get("source_timestamps")
    if not isinstance(timestamps, dict):
        return "invalid_source_timestamps"
    for timestamp in timestamps.values():
        if timestamp is not None and (instant(timestamp) is None or instant(timestamp) > created):
            return "source_after_prediction_or_invalid_time"
    return None
