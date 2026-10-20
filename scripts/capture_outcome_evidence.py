#!/usr/bin/env python3
"""Capture one immutable NFL outcome-input vintage, without inventing clocks.

Default CLI operation prints a fetch plan: no network, credentials or writes.
Only --fetch --out-dir opts into public source retrieval and local persistence.
Scoreboards are observed FIRST, then the season statistics and snap-count CSVs.
Raw bytes remain untouched; FINAL status is not an exact game-finish timestamp.

Profiles and URLs are code-owned, never read from a supplied capture or client
JSON. The successful complete capture is published last. Existing captures can
be loaded/replayed without fetching or restamping their first observations.
This module does not grade, fit, publish, upload or activate anything.
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402
from scripts.scrape.renames import normalize_team  # noqa: E402

STATS_PROFILE = "nflverse_stats_player_v1"
SNAPS_PROFILE = "nflverse_snap_counts_v1"
SCOREBOARD_PROFILE = "espn_scoreboard_v1"
CSV_LIMIT = 16 * 1024 * 1024
SCOREBOARD_LIMIT = 4 * 1024 * 1024
CAPTURE_LIMIT = 64 * 1024 * 1024
MAX_DEPTH = 24
_HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CLOCK_POLICY = "producer observations only; upstream issue and exact game-finish times unknown"


class CaptureError(ValueError):
    """Bounded machine code; never an exception containing an input URL/body."""


def _encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _fingerprint(value):
    return _raw_hash(_encoded(value))


def _raw_hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _instant(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc)
    except (AttributeError, ValueError, TypeError, OverflowError):
        raise CaptureError("invalid_observation_clock") from None


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _stamp(clock):
    return _instant(clock()).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _period(season, weeks):
    if type(season) is not int or not 2000 <= season <= 2100:
        raise CaptureError("invalid_season")
    if not isinstance(weeks, (list, tuple)) or not weeks:
        raise CaptureError("explicit_weeks_required")
    if any(type(week) is not int or not 1 <= week <= 18 for week in weeks):
        raise CaptureError("invalid_week")
    if len(set(weeks)) != len(weeks):
        raise CaptureError("duplicate_week")
    return sorted(weeks)


def source_spec(profile, season, week=None):
    """Return a code-owned source URL. No caller-supplied URL is accepted."""
    _period(season, [1] if week is None else [week])
    if profile == STATS_PROFILE and week is None:
        url = ("https://github.com/nflverse/nflverse-data/releases/download/stats_player/"
               "stats_player_week_%d.csv" % season)
    elif profile == SNAPS_PROFILE and week is None:
        url = ("https://github.com/nflverse/nflverse-data/releases/download/snap_counts/"
               "snap_counts_%d.csv" % season)
    elif profile == SCOREBOARD_PROFILE and week is not None:
        url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?" + urllib.parse.urlencode(
            {"seasontype": 2, "dates": season, "week": week})
    else:
        raise CaptureError("unsupported_source_profile")
    return {"profile": profile, "season": season, "week": week, "source_url": url,
            "maximum_bytes": SCOREBOARD_LIMIT if profile == SCOREBOARD_PROFILE else CSV_LIMIT}


def fetch_plan(season, weeks):
    """FINAL observations must precede stat/participation observations."""
    weeks = _period(season, weeks)
    return ([source_spec(SCOREBOARD_PROFILE, season, week) for week in weeks]
            + [source_spec(STATS_PROFILE, season), source_spec(SNAPS_PROFILE, season)])


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise CaptureError("duplicate_json_key")
        out[key] = value
    return out


def _json(raw):
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


def _csv(raw, profile):
    try:
        text = raw.decode("utf-8-sig")
        parsed = csv.reader(io.StringIO(text, newline=""), strict=True)
        header = next(parsed)
        if not header or any(not h or "\x00" in h for h in header) or len(set(header)) != len(header):
            raise CaptureError("invalid_csv_header")
        required = ({"season", "week", "position", "passing_yards", "rushing_yards", "receiving_yards"}
                    if profile == STATS_PROFILE else {"season", "week", "team", "player", "offense_snaps"})
        if not required.issubset(header):
            raise CaptureError("missing_csv_columns")
        if profile == STATS_PROFILE and (not {"team", "recent_team"}.intersection(header)
                or not {"player_display_name", "player_name"}.intersection(header)):
            raise CaptureError("missing_csv_identity_columns")
        rows = []
        for cells in parsed:
            if not cells:
                continue
            if len(cells) != len(header) or any("\x00" in cell for cell in cells):
                raise CaptureError("malformed_csv_row")
            rows.append(dict(zip(header, cells)))
        return rows
    except (UnicodeError, csv.Error, StopIteration):
        raise CaptureError("invalid_csv_source") from None


def _score(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return int(value) if math.isfinite(value) and value >= 0 and value.is_integer() else None


def _scoreboard(raw, spec, observed):
    """Retain raw events; normalize only unambiguous identities and FINAL scores."""
    doc = _json(raw)
    if (not isinstance(doc, dict) or not isinstance(doc.get("events"), list)
            or not 1 <= len(doc["events"]) <= 32):
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
                if _encoded(originals[gid]) != _encoded(event):
                    conflicts.add(gid)
                continue
            originals[gid] = event
            status = event["status"]["type"]["name"]
            if not isinstance(status, str) or not status.startswith("STATUS_"):
                raise ValueError()
            kickoff = event["date"]
            _instant(kickoff)
            competitions = event["competitions"]
            if not isinstance(competitions, list) or len(competitions) != 1:
                raise ValueError()
            competition_status = competitions[0].get("status")
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
            for metadata, field, expected in ((event.get("season"), "year", spec["season"]),
                                               (event.get("week"), "number", spec["week"])):
                if metadata is not None and (not isinstance(metadata, dict)
                        or type(metadata.get(field)) is not int or metadata[field] != expected):
                    raise ValueError()
            event_season_type = (event.get("season") or {}).get("type")
            if event_season_type is not None and (type(event_season_type) is not int or event_season_type != 2):
                raise ValueError()
            competitors = competitions[0]["competitors"]
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
                if hs is None or away is None or _instant(kickoff) > _instant(observed):
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


def _audit(raw, spec, observed):
    if spec["profile"] == SCOREBOARD_PROFILE:
        return _scoreboard(raw, spec, observed)[1]
    rows = _csv(raw, spec["profile"])
    if not rows:
        raise CaptureError("empty_csv_source")
    seen, duplicates, outside_regular_weeks = set(), 0, 0
    for row in rows:
        try:
            if int(row["season"]) != spec["season"]:
                raise ValueError()
            outside_regular_weeks += int(not 1 <= int(row["week"]) <= 18)
        except (TypeError, ValueError, OverflowError):
            raise CaptureError("csv_period_mismatch") from None
        encoded = _encoded(row)
        duplicates += int(encoded in seen)
        seen.add(encoded)
    return {"rows": len(rows), "duplicate_rows": duplicates,
            "outside_regular_week_rows": outside_regular_weeks,
            "measurement_policy": "raw values retained; missing/negative cells are not coerced or graded"}


class _ProfileRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, profile):
        self.profile, self.count = profile, 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.count += 1
        parsed = urllib.parse.urlsplit(newurl)
        if (self.profile not in {STATS_PROFILE, SNAPS_PROFILE} or self.count > 3
                or parsed.scheme != "https" or parsed.hostname not in {
                    "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or parsed.fragment):
            raise CaptureError("source_redirect_rejected")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_fetcher(spec):
    """Public fixed-profile GET, bounded response; never reads auth credentials."""
    expected = source_spec(spec.get("profile"), spec.get("season"), spec.get("week"))
    if _encoded(spec) != _encoded(expected):
        raise CaptureError("source_spec_mismatch")
    opener = urllib.request.build_opener(_ProfileRedirect(spec["profile"]))
    request = urllib.request.Request(spec["source_url"], headers={
        "Accept": "application/json" if spec["profile"] == SCOREBOARD_PROFILE else "text/csv",
        "Accept-Encoding": "identity", "User-Agent": "NFL2026-outcome-capture/1"})
    try:
        with opener.open(request, timeout=30) as response:
            raw = response.read(spec["maximum_bytes"] + 1)
            if len(raw) > spec["maximum_bytes"]:
                raise CaptureError("source_body_too_large")
            return response.status, dict(response.headers.items()), raw
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, {}, b""


def _headers(headers):
    if not isinstance(headers, dict):
        raise CaptureError("invalid_source_headers")
    lowered = {str(key).lower(): value for key, value in headers.items()}
    out = {"status": 200}
    for key in ("etag", "last-modified", "content-type"):
        value = lowered.get(key)
        if isinstance(value, str) and len(value) <= 512 and not any(ord(c) < 32 for c in value):
            out[key.replace("-", "_")] = value
    return out


def capture(season, weeks, *, fetcher, clock=_now, attempts=3, sleep=time.sleep):
    """One complete capture; injected fetcher(spec) returns status, headers, bytes.

    A new explicit invocation creates new actual observations. To replay a saved
    capture, call load_capture: do not fetch and substitute today's clocks.
    Missing mandatory sources fail; no completed manifest is manufactured.
    """
    weeks = _period(season, weeks)
    if type(attempts) is not int or not 1 <= attempts <= 3 or not callable(fetcher):
        raise CaptureError("invalid_capture_transport")
    started = _stamp(clock)
    raw_objects, observations, sources, total, previous = {}, {}, [], 0, _instant(started)
    for spec in fetch_plan(season, weeks):
        for attempt in range(attempts):
            fetch_started = _stamp(clock)
            if _instant(fetch_started) < previous:
                raise CaptureError("observation_clock_regressed")
            retry = False
            try:
                status, headers, raw = fetcher(dict(spec))
                observed = _stamp(clock)
                if _instant(observed) < _instant(fetch_started):
                    raise CaptureError("observation_clock_regressed")
                previous = _instant(observed)
                if type(status) is not int:
                    raise CaptureError("invalid_source_status")
                retry = status == 429 or 500 <= status <= 599
                if not retry and status != 200:
                    raise CaptureError("source_http_unavailable")
            except (OSError, TimeoutError):
                retry = True
            except CaptureError:
                raise
            except Exception:
                raise CaptureError("source_transport_failure") from None
            if retry:
                if attempt + 1 == attempts:
                    raise CaptureError("source_transport_exhausted")
                sleep(attempt + 1)
                continue
            break
        if not isinstance(raw, bytes) or not raw:
            raise CaptureError("empty_or_invalid_source_body")
        if len(raw) > spec["maximum_bytes"]:
            raise CaptureError("source_body_too_large")
        total += len(raw)
        if total > CAPTURE_LIMIT:
            raise CaptureError("capture_body_too_large")
        audit = _audit(raw, spec, observed)
        raw_id = _raw_hash(raw)
        observation = {"version": 1, "kind": "nfl.outcome_source_observation.v1",
            "evidence_class": "observed_source_snapshot",
            "profile": spec["profile"], "season": season, "week": spec["week"],
            "source_url": spec["source_url"], "raw_sha256": raw_id, "raw_bytes": len(raw),
            "fetch_started_utc": fetch_started, "observed_utc": observed,
            "upstream_updated_utc": None, "http": _headers(headers), "audit": audit}
        observation_id = _fingerprint(observation)
        observations[observation_id] = observation
        raw_objects[raw_id] = raw
        sources.append({"profile": spec["profile"], "season": season,
                        "week": spec["week"], "observation_id": observation_id})
    completed = _stamp(clock)
    if _instant(completed) < previous:
        raise CaptureError("observation_clock_regressed")
    manifest = {"version": 1, "kind": "nfl.outcome_capture.v1", "season": season,
        "weeks": weeks, "started_utc": started, "completed_utc": completed, "sources": sources,
        "clock_policy": _CLOCK_POLICY,
        "publication_status": "source_capture_not_public_forecast_evidence"}
    _, manifest["audit"] = _combined_scoreboards({"manifest": manifest,
        "observations": observations, "raw_objects": raw_objects})
    manifest["capture_id"] = _fingerprint(manifest)
    return {"manifest": manifest, "observations": observations, "raw_objects": raw_objects}


def _verify(bundle):
    """Verify complete profile membership, clocks, raw bytes and immutable IDs."""
    try:
        if not isinstance(bundle, dict) or set(bundle) != {"manifest", "observations", "raw_objects"}:
            raise CaptureError("invalid_capture_bundle")
        manifest, observations, raw_objects = (bundle[k] for k in ("manifest", "observations", "raw_objects"))
        if (not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1
                or set(manifest) != {"version", "kind", "season", "weeks", "started_utc", "completed_utc",
                                     "sources", "clock_policy", "publication_status", "capture_id", "audit"}
                or manifest.get("kind") != "nfl.outcome_capture.v1"
                or manifest.get("clock_policy") != _CLOCK_POLICY
                or manifest.get("publication_status") != "source_capture_not_public_forecast_evidence"
                or manifest.get("capture_id") != _fingerprint({k: v for k, v in manifest.items() if k != "capture_id"})):
            raise CaptureError("invalid_capture_manifest")
        specs = fetch_plan(manifest["season"], manifest["weeks"])
        if manifest["weeks"] != sorted(manifest["weeks"]) or not isinstance(manifest.get("sources"), list):
            raise CaptureError("invalid_capture_membership")
        if len(manifest["sources"]) != len(specs):
            raise CaptureError("invalid_capture_membership")
        if not isinstance(observations, dict) or not isinstance(raw_objects, dict):
            raise CaptureError("invalid_capture_objects")
        expected_observations, expected_raw, total = set(), set(), 0
        previous, completed = _instant(manifest["started_utc"]), _instant(manifest["completed_utc"])
        for source, spec in zip(manifest["sources"], specs):
            oid = source["observation_id"]
            if _encoded(source) != _encoded({"profile": spec["profile"], "season": spec["season"],
                                            "week": spec["week"], "observation_id": oid}):
                raise CaptureError("source_spec_mismatch")
            obs = observations[oid]
            if not isinstance(oid, str) or not _HASH.fullmatch(oid) or _fingerprint(obs) != oid:
                raise CaptureError("source_observation_hash_mismatch")
            if (type(obs.get("version")) is not int or obs["version"] != 1
                    or set(obs) != {"version", "kind", "evidence_class", "profile", "season", "week", "source_url", "raw_sha256",
                                   "raw_bytes", "fetch_started_utc", "observed_utc", "upstream_updated_utc", "http", "audit"}
                    or obs.get("kind") != "nfl.outcome_source_observation.v1"
                    or obs.get("evidence_class") != "observed_source_snapshot"
                    or any(_encoded(obs.get(k)) != _encoded(spec[k]) for k in ("profile", "season", "week", "source_url"))
                    or obs.get("upstream_updated_utc") is not None
                    or not isinstance(obs.get("http"), dict)
                    or type(obs["http"].get("status")) is not int or obs["http"]["status"] != 200):
                raise CaptureError("invalid_source_observation")
            began, observed = _instant(obs["fetch_started_utc"]), _instant(obs["observed_utc"])
            if not previous <= began <= observed <= completed:
                raise CaptureError("observation_clock_regressed")
            previous = observed
            rid = obs["raw_sha256"]
            raw = raw_objects[rid]
            if (not isinstance(rid, str) or not _HASH.fullmatch(rid) or not isinstance(raw, bytes)
                    or not raw or _raw_hash(raw) != rid or type(obs.get("raw_bytes")) is not int
                    or len(raw) != obs["raw_bytes"] or len(raw) > spec["maximum_bytes"]):
                raise CaptureError("raw_source_hash_or_size_mismatch")
            if _encoded(_audit(raw, spec, obs["observed_utc"])) != _encoded(obs["audit"]):
                raise CaptureError("source_audit_mismatch")
            total += len(raw)
            expected_observations.add(oid)
            expected_raw.add(rid)
        if total > CAPTURE_LIMIT or set(observations) != expected_observations or set(raw_objects) != expected_raw:
            raise CaptureError("invalid_capture_objects")
        if _encoded(_combined_scoreboards(bundle)[1]) != _encoded(manifest["audit"]):
            raise CaptureError("capture_audit_mismatch")
        return bundle
    except (KeyError, TypeError, AttributeError, OverflowError, RecursionError):
        raise CaptureError("invalid_capture_bundle") from None


def verify_capture(bundle):
    """Validate an in-memory bundle before using helpers; no network or writes.

    Helpers operate on a verified bundle and do not repeatedly reparse its
    complete object graph. Call this again if a caller has mutated that graph.
    Content integrity still does not authenticate the provider or its clocks.
    """
    _verify(bundle)


def source_observation(bundle, profile, week=None):
    """Exact source metadata; returned copy cannot mutate the loaded evidence."""
    sources = bundle["manifest"]["sources"]
    matches = [row for row in sources if row["profile"] == profile and row["week"] == week]
    if len(matches) != 1:
        raise CaptureError("source_not_in_capture")
    oid = matches[0]["observation_id"]
    return {"observation_id": oid, **json.loads(_encoded(bundle["observations"][oid]))}


def csv_rows(bundle, profile):
    """All raw season rows, not filtered to capture weeks; callers scope grading."""
    if profile not in {STATS_PROFILE, SNAPS_PROFILE}:
        raise CaptureError("unsupported_csv_profile")
    obs = source_observation(bundle, profile)
    return _csv(bundle["raw_objects"][obs["raw_sha256"]], profile)


def _combined_scoreboards(bundle):
    out, withheld = [], set()
    for selected in bundle["manifest"]["weeks"]:
        obs = source_observation(bundle, SCOREBOARD_PROFILE, selected)
        withheld.update(obs["audit"]["quarantined_game_ids"])
        rows, _ = _scoreboard(bundle["raw_objects"][obs["raw_sha256"]],
            source_spec(SCOREBOARD_PROFILE, bundle["manifest"]["season"], selected), obs["observed_utc"])
        out.extend({**row, "source_observation_id": obs["observation_id"],
                    "raw_sha256": obs["raw_sha256"], "observed_utc": obs["observed_utc"]} for row in rows)
    seen, conflicts = set(), set()
    for row in out:
        gid = row["game_id"]
        if gid in seen:
            conflicts.add(gid)
        seen.add(gid)
    withheld.update(conflicts)
    valid = [row for row in out if row["game_id"] not in withheld]
    return valid, {"cross_week_conflicting_game_ids": sorted(conflicts),
                   "normalized_games": len(valid), "quarantined_game_ids": sorted(withheld)}


def scoreboard_rows(bundle, week=None):
    """Valid events with global cross-week conflicts withheld, even for one week.

    The immutable manifest audit names every cross-week conflicting game ID.
    Nonfinal rows carry no scores or finish clock. Source-level malformed and
    within-week duplicate counts remain in each observation's audit.
    """
    if week is not None and week not in bundle["manifest"]["weeks"]:
        raise CaptureError("source_not_in_capture")
    rows, _ = _combined_scoreboards(bundle)
    return rows if week is None else [row for row in rows if row["week"] == week]


def _inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _output_root(out_dir):
    root = Path(out_dir).resolve()
    if _inside(root, _ROOT / "data") or _inside(_ROOT / "data", root):
        raise CaptureError("capture_output_overlaps_sports_data")
    return root


def _safe_path(root, folder, digest, extension):
    if not isinstance(digest, str) or not _HASH.fullmatch(digest):
        raise CaptureError("invalid_content_id")
    path = root / folder / (digest.split(":")[1] + extension)
    for current in (root / folder, path):
        if current.is_symlink():
            raise CaptureError("capture_path_symlink")
    if not _inside(path.resolve(), root):
        raise CaptureError("capture_path_outside_root")
    return path


def _immutable(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != raw:
            raise CaptureError("immutable_capture_conflict")
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".capture-", delete=False) as file:
            temporary = Path(file.name)
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        try:
            os.link(str(temporary), str(path))
        except FileExistsError:
            if path.is_symlink() or path.read_bytes() != raw:
                raise CaptureError("immutable_capture_conflict")
        directory = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def save_capture(bundle, out_dir):
    """Publish exact objects/observations first, complete immutable manifest last."""
    _verify(bundle)
    root = _output_root(out_dir)
    for oid, raw in bundle["raw_objects"].items():
        _immutable(_safe_path(root, "objects", oid, ".bin"), raw)
    for oid, doc in bundle["observations"].items():
        _immutable(_safe_path(root, "observations", oid, ".json"), _encoded(doc) + b"\n")
    manifest = bundle["manifest"]
    path = _safe_path(root, "captures", manifest["capture_id"], ".json")
    _immutable(path, _encoded(manifest) + b"\n")
    return path


def load_capture(path):
    """Offline verified replay; no retrieval, timestamp inference or fallback."""
    supplied = Path(path)
    if supplied.is_symlink() or supplied.parent.name != "captures":
        raise CaptureError("invalid_capture_path")
    path = supplied.resolve()
    root = path.parent.parent
    try:
        if path.stat().st_size > 65536:
            raise CaptureError("capture_document_too_large")
        manifest = _json(path.read_bytes())
        if path != _safe_path(root, "captures", manifest["capture_id"], ".json"):
            raise CaptureError("capture_filename_mismatch")
        observations, raw_objects, total = {}, {}, 0
        for source in manifest["sources"]:
            oid = source["observation_id"]
            obs_path = _safe_path(root, "observations", oid, ".json")
            if obs_path.stat().st_size > 65536:
                raise CaptureError("observation_document_too_large")
            obs = _json(obs_path.read_bytes())
            observations[oid] = obs
            rid = obs["raw_sha256"]
            raw_path = _safe_path(root, "objects", rid, ".bin")
            size = raw_path.stat().st_size
            if size > max(CSV_LIMIT, SCOREBOARD_LIMIT):
                raise CaptureError("source_body_too_large")
            total += size
            if total > CAPTURE_LIMIT:
                raise CaptureError("capture_body_too_large")
            raw_objects[rid] = raw_path.read_bytes()
        return _verify({"manifest": manifest, "observations": observations, "raw_objects": raw_objects})
    except (OSError, KeyError, TypeError, AttributeError, RecursionError):
        raise CaptureError("missing_or_invalid_capture_object") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int)
    parser.add_argument("--week", action="append", type=int, dest="weeks")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--out-dir")
    parser.add_argument("--capture", help="verify/replay an existing captures/<hash>.json without network")
    args = parser.parse_args(argv)
    try:
        if args.capture:
            if args.fetch or args.out_dir or args.season is not None or args.weeks:
                raise CaptureError("capture_replay_cannot_refetch")
            bundle = load_capture(args.capture)
            result = {"mode": "verified_replay", "capture_id": bundle["manifest"]["capture_id"],
                      "season": bundle["manifest"]["season"], "weeks": bundle["manifest"]["weeks"],
                      "network_used": False, "writes": False}
        else:
            plan = fetch_plan(args.season, args.weeks)
            if not args.fetch:
                result = {"mode": "dry_run", "sources": plan, "network_used": False, "writes": False}
            else:
                if not args.out_dir:
                    raise CaptureError("explicit_capture_output_required")
                _output_root(args.out_dir)  # validate before any network request
                bundle = capture(args.season, args.weeks, fetcher=http_fetcher)
                path = save_capture(bundle, args.out_dir)
                result = {"mode": "captured", "capture_id": bundle["manifest"]["capture_id"],
                          "path": str(path), "network_used": True, "writes": True}
        print(json.dumps(result, sort_keys=True))
        return 0
    except (CaptureError, OSError) as exc:
        reason = str(exc) if isinstance(exc, CaptureError) else "capture_io_failure"
        print(json.dumps({"error": reason, "ok": False}, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
