#!/usr/bin/env python3
"""Freeze the ESPN scoreboard and nflverse inputs shared by one grading generation."""

import argparse
from contextlib import contextmanager
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
from http.client import HTTPException
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts import grading_final_scores as scoreboards  # noqa: E402
from scripts.scrape.scoreboard_evidence import SCOREBOARD_LIMIT  # noqa: E402

MANIFEST = "manifest.json"
SCHEDULE = "schedule_full.json"
PRIOR_REVIEW = "prior_review.json"
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024
TIMEOUT_SECONDS = 15
RETRY_DELAYS = (1, 2)
_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
_SOURCE_SPECS = (
    ("stats_player", "stats_player_week", {
        "season", "week", "game_id", "team", "opponent_team", "player_id", "position",
        "passing_yards", "rushing_yards", "receiving_yards", "rushing_tds", "receiving_tds",
    }),
    ("snap_counts", "snap_counts", {
        "season", "week", "game_id", "team", "opponent", "player", "pfr_player_id", "offense_snaps",
    }),
    ("rosters", "roster", {"season", "gsis_id", "pfr_id"}),
)
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class CaptureError(RuntimeError):
    """The grading input capture could not be published or trusted."""


class CaptureMissing(CaptureError):
    """A required capture directory, member or file is missing."""


class CaptureTampered(CaptureError):
    """Capture membership, metadata, paths or bytes failed verification."""


class CaptureUnpublished(CaptureError):
    """The cache lacks a completed publication marker."""


class SourceUnknown(CaptureError):
    """The captured source returned HTTP 404 for this generation."""


def _sources(season, weeks=()):
    if type(season) is not int or not 2000 <= season <= 2100:
        raise CaptureError("capture season must be an integer from 2000 to 2100")
    sources = {name: (spec["source_url"], None)
               for name, spec in scoreboards.scoreboard_sources(season, weeks).items()}
    for release, prefix, columns in _SOURCE_SPECS:
        name = f"{prefix}_{season}.csv"
        sources[name] = (f"{_RELEASE_BASE}/{release}/{name}", columns)
    return sources


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _instant(value):
    if not isinstance(value, str) or "T" not in value or not value.endswith("Z"):
        raise ValueError("expected an ISO-8601 UTC timestamp")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def _directory_path(path):
    path = Path(path)
    if ".." in path.parts:
        raise CaptureTampered(f"{path}: unsafe grading capture path")
    path = Path.cwd() / path
    # macOS exposes these system temp paths through root-owned aliases.
    if sys.platform == "darwin" and path.parts[1:2] in (("tmp",), ("var",)):
        path = Path("/private").joinpath(*path.parts[1:])
    return path


@contextmanager
def _open_directory(path, *, create=False):
    path = _directory_path(path)
    data_dir = Path(__file__).resolve().parents[1] / "data"
    if create and (path == data_dir or data_dir in path.parents):
        raise CaptureError(f"{path}: grading captures must be outside the repository data directory")
    directory = os.open(path.anchor, _DIRECTORY_FLAGS)
    try:
        for index, part in enumerate(path.parts[1:], start=1):
            if create and index == len(path.parts) - 1:
                try:
                    os.mkdir(part, 0o700, dir_fd=directory)
                except FileExistsError:
                    pass
            child = os.open(part, _DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory
    except FileNotFoundError as exc:
        raise CaptureMissing(f"{path}: capture directory or file missing ({exc.filename})") from exc
    except OSError as exc:
        raise CaptureTampered(f"{path}: cannot access grading capture safely ({exc})") from exc
    finally:
        os.close(directory)


def _read_file(directory, name, limit):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError as exc:
        raise CaptureMissing(f"{name}: missing from grading capture") from exc
    except OSError as exc:
        raise CaptureTampered(f"{name}: cannot open capture member safely ({exc})") from exc
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise CaptureTampered(f"{name}: unsafe capture file or size")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise CaptureTampered(f"{name}: capture file exceeds size limit")
    return raw


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate manifest key {key!r}")
        result[key] = value
    return result


def _verify(directory):
    members = set(os.listdir(directory))
    if MANIFEST not in members:
        raise CaptureUnpublished("grading capture is unpublished (missing manifest.json)")
    raw_manifest = _read_file(directory, MANIFEST, MAX_MANIFEST_BYTES)
    try:
        manifest = json.loads(raw_manifest.decode("utf-8"), object_pairs_hook=_unique_pairs)
        fields = {"version", "season", "published_utc", "sources"}
        version = manifest["version"]
        if version == 2:
            fields.update({"started_utc", "scoreboard_weeks", "scoreboard_inputs"})
        if (set(manifest) != fields or type(version) is not int or version not in (1, 2)
                or type(manifest["season"]) is not int):
            raise ValueError("invalid manifest version or fields")
        season = manifest["season"]
        weeks = manifest.get("scoreboard_weeks", [])
        if (not isinstance(weeks, list) or any(type(week) is not int or not 1 <= week <= 18 for week in weeks)
                or weeks != sorted(set(weeks))):
            raise ValueError("invalid scoreboard weeks")
        specs = _sources(season, weeks)
        entries = manifest["sources"]
        if not isinstance(entries, dict) or set(entries) != set(specs):
            raise ValueError("source membership does not match the captured season")
        published_at = _instant(manifest["published_utc"])
        input_entries = manifest.get("scoreboard_inputs", {})
        if version == 2 and (
                _instant(manifest["started_utc"]) > published_at
                or not isinstance(input_entries, dict)
                or set(input_entries) not in ({SCHEDULE}, {SCHEDULE, PRIOR_REVIEW})):
            raise ValueError("invalid scoreboard input metadata")
        expected = {MANIFEST}
        for name, source in input_entries.items():
            if set(source) != {"sha256", "bytes"} or not _valid_digest(source):
                raise ValueError(f"{name}: invalid local scoreboard input metadata")
            expected.add(name)
        for name, source in entries.items():
            if (set(source) != {"status", "http_status", "source_url", "source_utc", "sha256", "bytes"}
                    or source["source_url"] != specs[name][0]
                    or _instant(source["source_utc"]) > published_at
                    or (version == 2 and _instant(source["source_utc"]) < _instant(manifest["started_utc"]))
                    or type(source["http_status"]) is not int):
                raise ValueError(f"{name}: invalid source metadata")
            if source["status"] == "unknown":
                if source["http_status"] != 404 or source["sha256"] is not None or source["bytes"] is not None:
                    raise ValueError(f"{name}: invalid unknown-source metadata")
                continue
            limit = SCOREBOARD_LIMIT if specs[name][1] is None else MAX_SOURCE_BYTES
            if source["status"] != "captured" or source["http_status"] != 200 or not _valid_digest(source, limit):
                raise ValueError(f"{name}: invalid captured-source metadata")
            expected.add(name)
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError, CaptureError) as exc:
        raise CaptureTampered(f"{MANIFEST}: invalid grading capture ({exc})") from exc

    missing = expected - members
    if missing:
        raise CaptureMissing(f"{', '.join(sorted(missing))}: missing from grading capture")
    extra = members - expected
    if extra:
        raise CaptureTampered(f"{', '.join(sorted(extra))}: unexpected grading capture members")
    contents = {}
    for name in sorted(expected - {MANIFEST}):
        limit = SCOREBOARD_LIMIT if name in specs and specs[name][1] is None else MAX_SOURCE_BYTES
        raw = _read_file(directory, name, limit)
        source = input_entries[name] if name in input_entries else entries[name]
        if len(raw) != source["bytes"] or hashlib.sha256(raw).hexdigest() != source["sha256"]:
            raise CaptureTampered(f"{name}: grading capture SHA256 or byte count mismatch")
        contents[name] = raw
    return manifest, contents


def _valid_digest(source, limit=MAX_SOURCE_BYTES):
    return (type(source["bytes"]) is int and 0 < source["bytes"] <= limit
            and isinstance(source["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", source["sha256"]))


def _digest(raw):
    return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


def _csv_rows(raw, name, season, columns):
    """Check the release structure even when no consumer needs its rows yet."""
    try:
        if not raw or b"\x00" in raw:
            raise ValueError("empty or binary body")
        text = io.StringIO(raw.decode("utf-8-sig"), newline="")
        reader = csv.DictReader(text, strict=True)
        header = reader.fieldnames
        if not header or len(header) != len(set(header)):
            raise ValueError("invalid CSV header")
        missing = columns.difference(header)
        if missing:
            raise ValueError("missing required CSV columns: " + ", ".join(sorted(missing)))
        if name.startswith("stats_player_week_") and not {"player_display_name", "player_name"}.intersection(header):
            raise ValueError("missing required CSV column: player_display_name or player_name")
        found = False
        for row in reader:
            if None in row or None in row.values() or row["season"] != str(season):
                raise ValueError(f"invalid row or season on line {reader.line_num}")
            found = True
            yield row
        if not found:
            raise ValueError("CSV contained no data rows")
    except (ValueError, csv.Error) as exc:
        raise CaptureError(f"{name}: invalid grading source CSV ({exc})") from exc


def _verified_capture(cache_dir):
    with _open_directory(cache_dir) as directory:
        try:
            fcntl.flock(directory, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise CaptureUnpublished("grading capture is still being published") from exc
        return _verify(directory)


def read_rows(cache_dir, name):
    """Return verified rows for one member without consulting the network."""
    if not isinstance(name, str) or "/" in name or "\\" in name or name in ("", ".", ".."):
        raise CaptureTampered(f"{name!r}: unsafe grading capture member name")
    manifest, contents = _verified_capture(cache_dir)
    season = manifest["season"]
    specs = _sources(season)
    if name not in specs:
        raise CaptureMissing(f"{name}: not a member of this grading capture")
    source = manifest["sources"][name]
    if source["status"] == "unknown":
        raise SourceUnknown(f"{name}: captured HTTP 404 at {source['source_utc']}")
    try:
        return list(_csv_rows(contents[name], name, season, specs[name][1]))
    except CaptureError as exc:
        raise CaptureTampered(str(exc)) from exc


def _scoreboard_snapshot(contents, season, started_utc):
    schedule = json.loads(contents[SCHEDULE], object_pairs_hook=_unique_pairs)
    previous = json.loads(contents[PRIOR_REVIEW], object_pairs_hook=_unique_pairs) if PRIOR_REVIEW in contents else None
    return schedule, scoreboards.fixture_snapshot(schedule, previous, season, started_utc)


def read_final_scores(cache_dir, season=None, *, allow_legacy=False):
    """Return the frozen schedule, verified FINAL rows, and source coverage."""
    manifest, contents = _verified_capture(cache_dir)
    if season is not None and manifest["season"] != season:
        raise CaptureTampered(f"capture belongs to season {manifest['season']}, expected {season}")
    if manifest["version"] != 2:
        if allow_legacy:
            return None
        raise CaptureMissing("grading capture has no ESPN scoreboard (version 2 required)")
    try:
        return _final_scores(manifest, contents)
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError) as exc:
        raise CaptureTampered(f"invalid captured scoreboard: {exc}") from exc


def _final_scores(manifest, contents):
    season = manifest["season"]
    schedule, snapshot = _scoreboard_snapshot(contents, season, manifest["started_utc"])
    weeks = manifest["scoreboard_weeks"]
    if snapshot["weeks"] != weeks:
        raise ValueError("scoreboard weeks differ from captured schedule")
    scores, statuses, coverage, retained = scoreboards.derive_finals(
        snapshot, scoreboards.scoreboard_sources(season, weeks), manifest["sources"], contents)
    capture_id = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    label = "ESPN grading capture %s (manifest identity %s, %d observed FINAL, %d verified prior review FINAL retained)" % (
        manifest["published_utc"], capture_id, len(scores) - retained, retained)
    label += "; captured schedule updated %s" % (schedule.get("updated_utc") or "unknown")
    unknown = [f"wk {r['week']}: HTTP {r['http_status']}, {r['unknown_games']} unknown"
               for r in coverage if r["unknown_games"] or r["http_status"] != 200]
    if unknown:
        label += "; coverage " + ", ".join(unknown)
    ids = {g["game_id"] for g in scores}
    incomplete = {r["week"] for gid, r in snapshot["fixtures"].items() if gid not in ids}
    complete_weeks = [week for week in weeks if week not in incomplete]
    return {"season": season, "schedule": schedule, "games": scores, "statuses": statuses,
            "coverage": coverage, "source": label, "retained": retained,
            "schedule_sha256": manifest["scoreboard_inputs"][SCHEDULE]["sha256"],
            "capture_id": capture_id,
            "complete_weeks": complete_weeks}


def http_fetch(url, *, timeout, max_bytes):
    """Fetch a fixed release URL with an inactivity timeout and a body limit."""
    request = Request(url, headers={
        "Accept": "application/json" if scoreboards.is_scoreboard_url(url) else "text/csv",
        "Accept-Encoding": "identity",
        "User-Agent": "NFL2026-grading-capture/1",
    })
    deadline = time.monotonic() + timeout
    try:
        with urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return response.status, b""
            length = response.headers.get("Content-Length")
            try:
                length = int(length) if length is not None else None
            except ValueError as exc:
                raise OSError("invalid grading source Content-Length") from exc
            if length is not None and not 0 <= length <= max_bytes:
                raise CaptureError(f"{url}: source exceeds the capture byte limit")
            data = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError("grading source fetch deadline exceeded")
                block = response.read1(min(65536, max_bytes + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > max_bytes:
                    raise CaptureError(f"{url}: source exceeds the capture byte limit")
            if length is not None and len(data) != length:
                raise OSError("truncated grading source response")
            return response.status, bytes(data)
    except HTTPError as exc:
        exc.close()
        return exc.code, b""


def _fetch(name, url, transport, sleep, max_bytes=MAX_SOURCE_BYTES):
    for delay in (0, *RETRY_DELAYS):
        if delay:
            sleep(delay)
        try:
            status, raw = transport(url, timeout=TIMEOUT_SECONDS, max_bytes=max_bytes)
        except (OSError, HTTPException) as exc:
            failure = str(exc)
            continue
        if status in (200, 404):
            if status == 200 and (not isinstance(raw, bytes) or not 0 < len(raw) <= max_bytes):
                raise CaptureError(f"{name}: invalid grading source body or size")
            return status, raw
        failure = f"HTTP {status}"
        if status not in (408, 429) and not 500 <= status < 600:
            break
    raise CaptureError(f"{name}: {url} could not be captured ({failure})")


def _write_new(directory, name, raw):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def _read_input(path, *, optional=False):
    try:
        with open(path, "rb") as stream:
            raw = stream.read(MAX_SOURCE_BYTES + 1)
        if not 0 < len(raw) <= MAX_SOURCE_BYTES:
            raise CaptureError(f"{path}: local scoreboard input has an invalid size")
        return raw
    except FileNotFoundError as exc:
        if optional:
            return None
        raise CaptureMissing(f"{path}: required scoreboard input is missing") from exc


def capture(season, output, *, schedule_path=None, prior_review_path=None, transport=http_fetch, sleep=time.sleep):
    """Publish a new snapshot or verify and reuse the existing generation."""
    specs = _sources(season)
    with _open_directory(output, create=True) as directory:
        fcntl.flock(directory, fcntl.LOCK_EX)
        members = set(os.listdir(directory))
        if MANIFEST in members:
            manifest, contents = _verify(directory)
            if manifest["season"] != season:
                raise CaptureTampered(f"{output}: grading capture belongs to season {manifest['season']}")
            if schedule_path is not None and manifest["version"] != 2:
                raise CaptureMissing("grading capture has no ESPN scoreboard (version 2 required)")
            if manifest["version"] == 2:
                try:
                    _final_scores(manifest, contents)
                except (ValueError, KeyError, TypeError, AttributeError, RecursionError) as exc:
                    raise CaptureTampered(f"invalid captured scoreboard: {exc}") from exc
            return manifest
        if members:
            raise CaptureUnpublished(f"{output}: refusing to resume a partial grading capture")

        contents = {}
        version = 2 if schedule_path is not None else 1
        started_utc = _utc_now()
        weeks, inputs = [], {}
        if version == 2:
            contents[SCHEDULE] = _read_input(schedule_path)
            if prior_review_path is not None:
                prior_raw = _read_input(prior_review_path, optional=True)
                if prior_raw is not None:
                    contents[PRIOR_REVIEW] = prior_raw
            try:
                _, snapshot = _scoreboard_snapshot(contents, season, started_utc)
            except (ValueError, TypeError, AttributeError, RecursionError) as exc:
                raise CaptureError(f"invalid scoreboard fixture input: {exc}") from exc
            weeks = snapshot["weeks"]
            specs = _sources(season, weeks)
            inputs = {name: _digest(raw) for name, raw in contents.items()}

        sources = {}
        for name, (url, columns) in specs.items():
            limit = MAX_SOURCE_BYTES if columns is not None else SCOREBOARD_LIMIT
            status, raw = _fetch(name, url, transport, sleep, limit)
            observed_at = _utc_now()
            record = {"source_url": url, "source_utc": observed_at, "http_status": status}
            if status == 200:
                if columns is not None:
                    for _ in _csv_rows(raw, name, season, columns):
                        pass
                contents[name] = raw
                record.update(status="captured", **_digest(raw))
            else:
                record.update(status="unknown", sha256=None, bytes=None)
            sources[name] = record

        manifest = {"version": version, "season": season, "published_utc": _utc_now(), "sources": sources}
        if version == 2:
            manifest.update(started_utc=started_utc, scoreboard_weeks=weeks, scoreboard_inputs=inputs)
            try:
                _final_scores(manifest, contents)
            except (ValueError, TypeError, AttributeError, RecursionError) as exc:
                raise CaptureError(f"invalid captured scoreboard: {exc}") from exc
        for name, raw in contents.items():
            _write_new(directory, name, raw)
        os.fsync(directory)
        manifest["published_utc"] = _utc_now()
        marker = f".manifest-{uuid4().hex}.tmp"
        published = False
        try:
            try:
                raw_manifest = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
                _write_new(directory, marker, raw_manifest)
                os.link(marker, MANIFEST, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                published = True
            finally:
                try:
                    os.unlink(marker, dir_fd=directory)
                except FileNotFoundError:
                    pass
            os.fsync(directory)
        except BaseException:
            if published:
                os.unlink(MANIFEST, dir_fd=directory)
            raise
        return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--output", required=True, help="directory for this immutable grading generation")
    parser.add_argument("--schedule", help="freeze this schedule and capture its ESPN regular-season scoreboards")
    parser.add_argument("--prior-review", help="freeze verified same-fixture FINAL history from this review")
    args = parser.parse_args(argv)
    if args.prior_review and not args.schedule:
        parser.error("--prior-review requires --schedule")
    try:
        manifest = capture(args.season, args.output, schedule_path=args.schedule, prior_review_path=args.prior_review)
    except CaptureError as exc:
        print(f"grading input capture failed: {exc}", file=sys.stderr)
        return 1
    for name, source in manifest["sources"].items():
        print(f"{name} {source['status']} HTTP {source['http_status']}")
    print(f"grading input capture published at {Path(args.output) / MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
