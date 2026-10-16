"""Offline-first immutable candidate ESPN FINAL-roster capture, NOT live intake.

The core roster body/page profile is inferred from existing repository field
usage, not verified against a retained raw provider response. Consequently this
module deliberately has NO HTTP implementation or --fetch flag. An explicitly
supplied application fetcher may perform caller-owned I/O. Bytes, local callback
observation clocks, provider issue clocks and actual finish clocks stay distinct.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import capture_outcome_evidence as outcomes, export_learning as ex
from scripts.export_outcome_capture import _selected_path
from scripts.scrape.renames import normalize_team

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
PROFILE_STATUS = "repository_inferred_unverified"
SCOREBOARD = "espn_scoreboard_v1"
COMPETITION = "espn_core_competition_candidate_v1"
TEAM = "espn_core_team_candidate_v1"
ROSTER = "espn_core_game_roster_candidate_v1"
MAX_BODY, MAX_TOTAL, MAX_PAGES, MAX_ENTRIES = 1024 * 1024, 64 * 1024 * 1024, 8, 800
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
OBS_KEYS = {"version", "kind", "spec", "raw_sha256", "raw_bytes", "fetch_started_utc", "observed_utc",
            "provider_issued_utc", "source_authority_authenticated", "observation_id"}
MANIFEST_KEYS = {"version", "kind", "season", "week", "game_id", "started_utc", "completed_utc", "sources", "audit",
                 "profile_status", "source_authority_authenticated", "provider_coverage", "capture_id"}


class ParticipationError(ValueError):
    """Static diagnostic only; never provider bodies, URLs or callback text."""


def need(value, reason="invalid_participation_capture"):
    if not value:
        raise ParticipationError(reason)


def encoded(value):
    return ex.encoded(value)


def raw_hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return raw_hash(encoded(value))


def seal(value, key):
    return {**value, key: fingerprint(value)}


def _id(value):
    need(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,14}", value), "invalid_exact_espn_id")
    return value


def _integer(value, low, high):
    need(type(value) is int and low <= value <= high)
    return value


def instant(value):
    try:
        need(type(value) is str)
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        need(stamp.tzinfo is not None and stamp.utcoffset() is not None)
        return stamp.astimezone(dt.timezone.utc)
    except (ValueError, TypeError, OverflowError):
        raise ParticipationError("invalid_participation_clock") from None


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _stamp(clock):
    try:value = clock()
    except Exception:raise ParticipationError("participation_clock_unavailable") from None
    return instant(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _json(raw):
    need(type(raw) is bytes and len(raw) <= 4 * MAX_BODY)
    try:
        value = ex._json(raw)
        pending = [(value, 0)];count = 0
        while pending:
            node, depth = pending.pop();count += 1
            need(depth <= 24 and count <= 100000, "participation_work_limit")
            if type(node) in (dict, list):
                need(count + len(pending) + len(node) <= 100000, "participation_work_limit")
                pending.extend((v, depth + 1) for v in (node.values()if type(node)is dict else node))
        return value
    except (ValueError, TypeError, RecursionError):
        raise ParticipationError("invalid_participation_json") from None


def _metadata(value):
    pending = [(value, 0)];nodes = 0;used = 0
    while pending:
        node, depth = pending.pop();nodes += 1
        need(nodes <= 20000 and depth <= 16, "participation_work_limit")
        if type(node) is dict:
            need(nodes + len(pending) + 2 * len(node) <= 20000, "participation_work_limit")
            need(all(type(k) is str and len(k) <= 200 for k in node));used += 2 + max(0, len(node)-1) + len(node)
            pending.extend((k, depth + 1) for k in node)
            pending.extend((v, depth + 1) for v in node.values())
        elif type(node) is list:
            need(nodes + len(pending) + len(node) <= 20000, "participation_work_limit")
            used += 2 + max(0, len(node)-1);pending.extend((v, depth + 1) for v in node)
        else:
            need(type(node) in (str, int, float, bool) or node is None)
            need(not (type(node) is str and len(node) > 4096 or type(node) is int and node.bit_length() > 64
                      or type(node) is float and not math.isfinite(node)), "participation_work_limit")
            used += len(encoded(node))
        need(used <= MAX_BODY, "participation_work_limit")


def source_spec(profile, season, week, game_id, team_id=None, page=None):
    _integer(season, 2000, 2100);_integer(week, 1, 18);_id(game_id)
    need(profile in {SCOREBOARD, COMPETITION, TEAM, ROSTER})
    if profile == SCOREBOARD:
        need(team_id is None and page is None)
        url = outcomes.source_spec(SCOREBOARD, season, week)["source_url"]
    elif profile == COMPETITION:
        need(team_id is None and page is None)
        url = CORE + "/events/%s/competitions/%s" % (game_id, game_id)
    elif profile == TEAM:
        _id(team_id);need(page is None);url = CORE + "/teams/" + team_id
    else:
        _id(team_id);_integer(page, 1, MAX_PAGES)
        url = CORE + "/events/%s/competitions/%s/competitors/%s/roster?limit=100&page=%s" % (game_id, game_id, team_id, page)
    return {"profile": profile, "season": season, "week": week, "game_id": game_id, "team_id": team_id,
            "page": page, "source_url": url, "maximum_bytes": 4 * MAX_BODY if profile == SCOREBOARD else MAX_BODY}


def _ref(value, expected):
    """Validate a repository-used reference; NEVER follow its supplied URL."""
    need(type(value) is dict and type(value.get("$ref")) is str, "unsupported_core_body_profile")
    parsed = urllib.parse.urlsplit(value["$ref"])
    base = urllib.parse.urlsplit(expected)
    need(parsed.scheme == "https" and parsed.netloc == base.netloc and parsed.path == base.path
         and not parsed.fragment and all(k in {"lang", "region"} and v == {"lang": "en", "region": "us"}[k]
              for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)), "unexpected_core_reference")


def _collect(season, week, game_id, take):
    raw, score_obs = take(source_spec(SCOREBOARD, season, week, game_id))
    _json(raw)  # Apply receiver work bounds before invoking the existing parser.
    rows, _ = outcomes._scoreboard(raw, outcomes.source_spec(SCOREBOARD, season, week), score_obs["observed_utc"])
    mine = [row for row in rows if row["game_id"] == game_id]
    need(len(mine) == 1 and mine[0]["final"], "explicit_final_game_required")
    game = mine[0]
    raw, _ = take(source_spec(COMPETITION, season, week, game_id));comp = _json(raw)
    need(type(comp) is dict and comp.get("id") == game_id, "competition_identity_mismatch")
    for name, field, expected in (("season", "year", season), ("week", "number", week)):
        if name in comp:
            need(type(comp[name]) is dict and type(comp[name].get(field)) is int and comp[name][field] == expected,
                 "competition_period_mismatch")
    if "season" in comp and "type" in comp["season"]:
        need(type(comp["season"]["type"]) is int and comp["season"]["type"] == 2, "competition_period_mismatch")
    if "status" in comp:
        status = comp["status"]
        need(type(status) is dict and type(status.get("type")) is dict
             and status["type"].get("name") in outcomes.FINAL_STATUSES
             and ("completed" not in status["type"] or status["type"]["completed"] is True), "contradictory_final_status")
    competitors = comp.get("competitors")
    need(type(competitors) is list and len(competitors) == 2, "unsupported_core_body_profile")
    sides = {};all_rows = [];bad_teams = set();bad_ids = set();counts = {"rows": 0, "duplicate_ids": 0, "malformed_rows": 0}
    for entry in competitors:
        need(type(entry) is dict and entry.get("homeAway") in ("home", "away") and entry["homeAway"] not in sides,
             "competition_identity_mismatch")
        tid = _id(entry.get("id"));side = entry["homeAway"]
        _ref(entry.get("team"), CORE + "/teams/" + tid)
        _ref(entry.get("roster"), CORE + "/events/%s/competitions/%s/competitors/%s/roster" % (game_id, game_id, tid))
        sides[side] = tid
        raw, _ = take(source_spec(TEAM, season, week, game_id, tid));team = _json(raw)
        need(type(team) is dict and team.get("id") == tid and normalize_team(team.get("abbreviation")) == game[side],
             "team_identity_mismatch")
        expected = None;page = 1
        while True:
            raw, observation = take(source_spec(ROSTER, season, week, game_id, tid, page));doc = _json(raw)
            need(type(doc) is dict and type(doc.get("entries")) is list, "unsupported_roster_page_profile")
            for field, value in (("eventId", game_id), ("competitionId", game_id), ("teamId", tid)):
                if field in doc:need(type(doc[field]) is str and doc[field] == value, "roster_identity_mismatch")
            if "$ref" in doc:
                _ref(doc, CORE + "/events/%s/competitions/%s/competitors/%s/roster" % (game_id, game_id, tid))
            for field, key, value in (("season", "year", season), ("week", "number", week)):
                if field in doc:need(type(doc[field]) is dict and type(doc[field].get(key)) is int and doc[field][key] == value,
                                      "roster_period_mismatch")
            if "season" in doc and "type" in doc["season"]:
                need(type(doc["season"]["type"]) is int and doc["season"]["type"] == 2, "roster_period_mismatch")
            count = _integer(doc.get("count"), 0, MAX_ENTRIES);size = _integer(doc.get("pageSize"), 1, 100)
            pages = _integer(doc.get("pageCount"), 1, MAX_PAGES)
            need(doc.get("pageIndex") == page and type(doc.get("pageIndex")) is int
                 and pages == max(1, math.ceil(count / size)) and (expected is None or expected == (count, size, pages))
                 and len(doc["entries"]) == min(size, max(0, count - (page - 1) * size)), "incomplete_roster_pages")
            expected = (count, size, pages)
            for row in doc["entries"]:
                counts["rows"] += 1
                if type(row) is not dict:
                    bad_teams.add(game[side]);counts["malformed_rows"] += 1;continue
                pid = row.get("playerId")
                if type(pid) is int and 0 < pid < 10 ** 15:pid = str(pid)
                if type(pid) is not str or not re.fullmatch(r"[1-9][0-9]{0,14}", pid):
                    bad_teams.add(game[side]);counts["malformed_rows"] += 1;continue
                flag = row.get("didNotPlay")
                if "didNotPlay" in row and type(flag) is not bool:
                    bad_ids.add(pid);counts["malformed_rows"] += 1
                all_rows.append({"espn_id": pid, "team": game[side], "did_not_play": flag if type(flag) is bool else None,
                                 "observation_id": observation["observation_id"], "observed_utc": observation["observed_utc"]})
            if page == pages:break
            page += 1
    need(set(sides) == {"home", "away"} and len(set(sides.values())) == 2, "competition_identity_mismatch")
    seen = set()
    for row in all_rows:
        if row["espn_id"] in seen:bad_ids.add(row["espn_id"]);counts["duplicate_ids"] += 1
        seen.add(row["espn_id"])
    audit = {**counts, "quarantined_ids": sorted(bad_ids), "quarantined_teams": sorted(bad_teams),
             "page_inventory": "declared_pages_checked_not_provider_completeness", "provider_coverage": "unknown"}
    return {"game": game, "score_observation_id": score_obs["observation_id"], "score_observed_utc": score_obs["observed_utc"],
            "rows": all_rows, "audit": audit}


def capture(season, week, game_id, *, fetcher, clock=_now):
    """Capture code-owned profiles via trusted injected transport; no HTTP here."""
    source_spec(SCOREBOARD, season, week, game_id);need(callable(fetcher) and callable(clock))
    started = _stamp(clock);previous = instant(started);sources = [];observations = {};objects = {};total = 0
    def take(spec):
        nonlocal previous, total
        began = _stamp(clock);need(instant(began) >= previous, "participation_clock_regressed")
        try:response = fetcher(dict(spec))
        except Exception:raise ParticipationError("participation_transport_failed") from None
        need(type(response) is tuple and len(response) == 3, "invalid_participation_transport")
        status, _, raw = response
        need(type(status) is int and status == 200 and type(raw) is bytes and len(raw) <= spec["maximum_bytes"], "participation_source_unavailable")
        observed = _stamp(clock);need(instant(observed) >= instant(began), "participation_clock_regressed")
        previous = instant(observed);total += len(raw);need(total <= MAX_TOTAL, "participation_capture_too_large")
        rid = raw_hash(raw)
        obs = seal({"version": 1, "kind": "nfl.final_participation_observation.v1", "spec": spec, "raw_sha256": rid,
                    "raw_bytes": len(raw), "fetch_started_utc": began, "observed_utc": observed, "provider_issued_utc": None,
                    "source_authority_authenticated": False}, "observation_id")
        sources.append(obs["observation_id"]);observations[obs["observation_id"]] = obs;objects[rid] = raw
        return raw, obs
    derived = _collect(season, week, game_id, take);completed = _stamp(clock)
    need(instant(completed) >= previous, "participation_clock_regressed")
    manifest = seal({"version": 1, "kind": "nfl.final_participation_capture.v1", "season": season, "week": week,
        "game_id": game_id, "started_utc": started, "completed_utc": completed, "sources": sources, "audit": derived["audit"],
        "profile_status": PROFILE_STATUS, "source_authority_authenticated": False, "provider_coverage": "unknown"}, "capture_id")
    bundle = {"manifest": manifest, "observations": observations, "raw_objects": objects};verify_capture(bundle);return bundle


def _verified(bundle):
    try:
        need(type(bundle) is dict and all(type(k) is str for k in bundle)
             and set(bundle) == {"manifest", "observations", "raw_objects"})
        manifest, observations, objects = (bundle[k] for k in ("manifest", "observations", "raw_objects"))
        _metadata(manifest);_metadata(observations)
        need(type(objects) is dict and len(objects) <= 4 + 2 * MAX_PAGES
             and all(type(k) is str and HASH.fullmatch(k) and type(v) is bytes and len(v) <= 4 * MAX_BODY for k,v in objects.items())
             and sum(len(v) for v in objects.values()) <= MAX_TOTAL, "participation_work_limit")
        need(type(manifest) is dict and set(manifest) == MANIFEST_KEYS and type(manifest["version"]) is int
             and manifest["version"] == 1 and manifest["kind"] == "nfl.final_participation_capture.v1"
             and manifest["profile_status"] == PROFILE_STATUS and manifest["source_authority_authenticated"] is False
             and manifest["provider_coverage"] == "unknown" and manifest["capture_id"] == fingerprint({k:v for k,v in manifest.items()if k!="capture_id"}))
        need(type(manifest["sources"]) is list and 6 <= len(manifest["sources"]) <= 4 + 2 * MAX_PAGES
             and len(set(manifest["sources"])) == len(manifest["sources"]))
        need(type(observations) is dict and type(objects) is dict and set(observations) == set(manifest["sources"]))
        previous = instant(manifest["started_utc"]);end = instant(manifest["completed_utc"]);index = 0;used = set();total = 0
        def take(spec):
            nonlocal previous, index, total
            oid = manifest["sources"][index];index += 1;obs = observations[oid]
            need(type(obs) is dict and set(obs) == OBS_KEYS and type(obs["version"]) is int and obs["version"] == 1
                 and obs["kind"] == "nfl.final_participation_observation.v1" and obs["provider_issued_utc"] is None
                 and obs["source_authority_authenticated"] is False and encoded(obs["spec"]) == encoded(spec)
                 and obs["observation_id"] == oid == fingerprint({k:v for k,v in obs.items()if k!="observation_id"}))
            began, observed = instant(obs["fetch_started_utc"]), instant(obs["observed_utc"])
            need(previous <= began <= observed <= end, "participation_clock_regressed");previous = observed
            rid = obs["raw_sha256"];raw = objects[rid]
            need(type(raw) is bytes and type(obs["raw_bytes"]) is int and len(raw) == obs["raw_bytes"] <= spec["maximum_bytes"]
                 and raw_hash(raw) == rid, "participation_raw_hash_mismatch")
            used.add(rid);total += len(raw);need(total <= MAX_TOTAL, "participation_capture_too_large")
            return raw, obs
        derived = _collect(manifest["season"], manifest["week"], manifest["game_id"], take)
        need(index == len(manifest["sources"]) and used == set(objects) and encoded(derived["audit"]) == encoded(manifest["audit"]))
        return derived
    except ParticipationError:raise
    except Exception:raise ParticipationError("invalid_participation_capture") from None


def verify_capture(bundle):
    _verified(bundle)


def explicit_dnp(bundle, espn_id, team):
    """A strict true is direct negative evidence, never a complete inventory."""
    derived = _verified(bundle);_id(espn_id);need(type(team) is str and normalize_team(team) == team)
    rows = [r for r in derived["rows"] if r["espn_id"] == espn_id and r["team"] == team]
    audit = derived["audit"]
    reason = ("identity_quarantined" if espn_id in audit["quarantined_ids"] or team in audit["quarantined_teams"]
              else "explicit_dnp" if len(rows) == 1 and rows[0]["did_not_play"] is True else "participation_unknown")
    return {"explicit_dnp": True if reason == "explicit_dnp" else None, "reason": reason, "game": derived["game"],
            "score_observation_id": derived["score_observation_id"], "score_observed_utc": derived["score_observed_utc"],
            "roster_observation_id": rows[0]["observation_id"] if len(rows) == 1 else None,
            "roster_observed_utc": rows[0]["observed_utc"] if len(rows) == 1 else None,
            "capture_id": bundle["manifest"]["capture_id"], "profile_status": PROFILE_STATUS,
            "source_authority_authenticated": False, "provider_issued_utc": None, "game_finish_utc": None,
            "provider_coverage": "unknown", "played_inferred": False}


def _output(out_dir):
    root = _selected_path(out_dir)
    need(not root.is_relative_to(ROOT / "data") and not (ROOT / "data").is_relative_to(root), "participation_output_overlaps_data")
    return root


def _read(path, maximum):
    need(not path.is_symlink() and path.is_file() and path.stat().st_size <= maximum, "invalid_participation_file")
    raw = path.read_bytes();need(len(raw) <= maximum);return raw


def _write_raw(root, path, raw):
    path = ex._delivery_path(root, *path.relative_to(root).parts);path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():need(_read(path, len(raw)) == raw, "immutable_participation_conflict");return
    handle = tempfile.NamedTemporaryFile(prefix=".participation-", dir=path.parent, delete=False)
    temporary = Path(handle.name)
    try:
        with handle:handle.write(raw);handle.flush();os.fsync(handle.fileno())
        try:os.link(temporary, path)
        except FileExistsError:need(_read(path, len(raw)) == raw, "immutable_participation_conflict")
        directory = os.open(path.parent, os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:temporary.unlink()


def save_capture(bundle, out_dir):
    verify_capture(bundle);root = _output(out_dir)
    for rid, raw in bundle["raw_objects"].items():
        _write_raw(root, ex._delivery_path(root, "objects", rid[7:] + ".bin"), raw)
    for oid, obs in bundle["observations"].items():
        ex._immutable(ex._delivery_path(root, "observations", oid[7:] + ".json"), obs, root=root)
    manifest = bundle["manifest"];path = ex._delivery_path(root, "captures", manifest["capture_id"][7:] + ".json")
    ex._immutable(path, manifest, root=root);return path


def load_capture(path):
    path = Path(path);root = _selected_path(path.parent.parent)
    manifest = _json(_read(ex._delivery_path(root, path.parent.name, path.name), MAX_BODY))
    _metadata(manifest)
    need(type(manifest) is dict and type(manifest.get("sources")) is list and len(manifest["sources"]) <= 4 + 2 * MAX_PAGES)
    need(path.parent.name == "captures" and type(manifest.get("capture_id")) is str
         and HASH.fullmatch(manifest["capture_id"]) and path.name == manifest["capture_id"][7:] + ".json", "capture_filename_mismatch")
    observations = {};objects = {};total = 0
    for oid in manifest["sources"]:
        need(type(oid) is str and HASH.fullmatch(oid))
        obs = _json(_read(ex._delivery_path(root, "observations", oid[7:] + ".json"), MAX_BODY))
        _metadata(obs)
        rid = obs.get("raw_sha256");need(type(rid) is str and HASH.fullmatch(rid))
        spec = obs.get("spec");need(type(spec) is dict)
        maximum = source_spec(spec.get("profile"), spec.get("season"), spec.get("week"), spec.get("game_id"), spec.get("team_id"), spec.get("page"))["maximum_bytes"]
        raw = _read(ex._delivery_path(root, "objects", rid[7:] + ".bin"), maximum)
        total += len(raw);need(total <= MAX_TOTAL, "participation_capture_too_large")
        objects[rid] = raw;observations[oid] = obs
    bundle = {"manifest": manifest, "observations": observations, "raw_objects": objects};verify_capture(bundle);return bundle


def main(argv=None):
    parser = ex._SafeParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True);parser.add_argument("--week", type=int, required=True)
    parser.add_argument("--game-id", required=True);args = parser.parse_args(argv)
    try:
        plan = [source_spec(p, args.season, args.week, args.game_id) for p in (SCOREBOARD, COMPETITION)]
        print(encoded({"version": 1, "mode": "dry_run", "initial_sources": plan, "profile_status": PROFILE_STATUS,
                       "network_implemented": False, "network_used": False, "writes": False,
                       "source_authority_authenticated": False, "next_sources": "code_derived_team_and_all_roster_pages"}).decode())
        return 0
    except Exception:
        print('{"version":1,"status":"held_unknown","reason":"participation_plan_refused"}', file=sys.stderr);return 1


if __name__ == "__main__":
    sys.exit(main())
