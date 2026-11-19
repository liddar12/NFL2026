"""Pure validation for raw ESPN regular-season scoreboard responses."""

import datetime as dt
import json
import math
import re
from urllib.parse import urlencode

from scripts.scrape.espn import FINAL_STATUSES, _SCOREBOARD_URL
from scripts.scrape.renames import normalize_team


SCOREBOARD_LIMIT = 4 * 1024 * 1024
MAX_DEPTH = 24


def regular_week_url(season, week):
    return _SCOREBOARD_URL + "?" + urlencode({"seasontype": 2, "dates": season, "week": week})


class CaptureError(ValueError):
    """Bounded machine code; never an exception containing an input URL/body."""


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def instant(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc)
    except (AttributeError, ValueError, TypeError, OverflowError):
        raise CaptureError("invalid_observation_clock") from None


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise CaptureError("duplicate_json_key")
        out[key] = value
    return out


def decode_json(raw):
    try:
        text = raw.decode("utf-8")
        value = json.loads(text, object_pairs_hook=_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(CaptureError("nonfinite_json")))
        pending = [(value, 0)]
        while pending:
            node, depth = pending.pop()
            if depth > MAX_DEPTH:
                raise CaptureError("json_depth_exceeded")
            if isinstance(node, float) and not math.isfinite(node):
                raise CaptureError("nonfinite_json")
            if isinstance(node, dict):
                pending.extend((v, depth + 1) for v in node.values())
            elif isinstance(node, list):
                pending.extend((v, depth + 1) for v in node)
        return value
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise CaptureError("invalid_json_source") from None


def _score(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return int(value) if math.isfinite(value) and value >= 0 and value.is_integer() else None


def parse(raw, spec, observed, *, allow_empty=False):
    """Retain raw events; normalize only unambiguous identities and FINAL scores."""
    doc = decode_json(raw)
    if (not isinstance(doc, dict) or not isinstance(doc.get("events"), list)
            or not (0 if allow_empty else 1) <= len(doc["events"]) <= 32):
        raise CaptureError("empty_or_invalid_scoreboard")
    for name, field, expected in (("season", "year", spec["season"]), ("week", "number", spec["week"])):
        metadata = doc.get(name)
        if metadata is not None and (not isinstance(metadata, dict)
                or type(metadata.get(field)) is not int or metadata[field] != expected):
            raise CaptureError("scoreboard_period_mismatch")
    season_type = (doc.get("season") or {}).get("type")
    if season_type is not None and (type(season_type) is not int or season_type != 2):
        raise CaptureError("scoreboard_season_type_mismatch")
    rows, originals, conflicts, malformed = {}, {}, set(), set()
    audit = {"events": len(doc["events"]), "normalized_games": 0, "final_games": 0,
             "nonfinal_games": 0, "malformed_events": 0, "duplicate_events": 0,
             "conflicting_game_ids": 0, "invalid_final_scores": 0}
    for event in doc["events"]:
        gid = None
        try:
            if (not isinstance(event, dict) or not isinstance(event.get("id"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}", event["id"])):
                raise ValueError()
            gid = event["id"]
            if gid in originals:
                audit["duplicate_events"] += 1
                if encoded(originals[gid]) != encoded(event):
                    conflicts.add(gid)
                continue
            originals[gid] = event
            status = event["status"]["type"]["name"]
            if not isinstance(status, str) or not status.startswith("STATUS_"):
                raise ValueError()
            kickoff = event["date"]
            instant(kickoff)
            competitions = event["competitions"]
            if not isinstance(competitions, list) or len(competitions) != 1:
                raise ValueError()
            competition = competitions[0]
            if (("id" in competition and competition["id"] != gid)
                    or ("date" in competition and instant(competition["date"]) != instant(kickoff))):
                raise ValueError()
            competition_status = competition.get("status")
            for status_doc in (event["status"], competition_status):
                if status_doc is None:
                    continue
                if not isinstance(status_doc, dict) or not isinstance(status_doc.get("type"), dict):
                    raise ValueError()
                other_type = status_doc["type"]
                if "name" in other_type and other_type["name"] != status:
                    raise ValueError()
                if "completed" in other_type and (
                        type(other_type["completed"]) is not bool
                        or other_type["completed"] != (status in FINAL_STATUSES)):
                    raise ValueError()
                if ("state" in other_type and status in FINAL_STATUSES
                        and other_type["state"] != "post"):
                    raise ValueError()
            for metadata, field, expected in ((event.get("season"), "year", spec["season"]),
                                               (event.get("week"), "number", spec["week"])):
                if metadata is not None and (not isinstance(metadata, dict)
                        or type(metadata.get(field)) is not int or metadata[field] != expected):
                    raise ValueError()
            event_season_type = (event.get("season") or {}).get("type")
            if event_season_type is not None and (type(event_season_type) is not int or event_season_type != 2):
                raise ValueError()
            competitors = competition["competitors"]
            if not isinstance(competitors, list) or len(competitors) != 2:
                raise ValueError()
            sides = {c["homeAway"]: c for c in competitors}
            if set(sides) != {"home", "away"}:
                raise ValueError()
            teams = {side: normalize_team(c["team"]["abbreviation"]) for side, c in sides.items()}
            if any(team is None for team in teams.values()) or teams["home"] == teams["away"]:
                raise ValueError()
            row = {"season": spec["season"], "week": spec["week"], "game_id": gid,
                   "status": status, "kickoff_utc": kickoff, **teams,
                   "final": status in FINAL_STATUSES, "final_utc": None,
                   "upstream_updated_utc": None}
            if status in FINAL_STATUSES:
                hs, away = _score(sides["home"].get("score")), _score(sides["away"].get("score"))
                if hs is None or away is None or instant(kickoff) > instant(observed):
                    audit["invalid_final_scores"] += 1
                    raise ValueError()
                row.update(home_score=hs, away_score=away)
            rows[gid] = row
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            audit["malformed_events"] += 1
            if gid is not None:
                malformed.add(gid)
    for gid in conflicts:
        rows.pop(gid, None)
    audit["conflicting_game_ids"] = len(conflicts)
    audit["quarantined_game_ids"] = sorted(conflicts | malformed)
    audit["normalized_games"] = len(rows)
    audit["final_games"] = sum(row["final"] for row in rows.values())
    audit["nonfinal_games"] = len(rows) - audit["final_games"]
    return [rows[gid] for gid in sorted(rows)], audit
