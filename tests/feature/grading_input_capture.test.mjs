import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = String.raw`
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from unittest.mock import patch
from scripts import capture_grading_inputs as C

STATS, SNAPS, ROSTER = "stats_player_week_2026.csv", "snap_counts_2026.csv", "roster_2026.csv"
BODIES = {
    STATS: (b"season,week,game_id,team,opponent_team,player_id,passing_yards,rushing_yards,"
            b"receiving_yards,rushing_tds,receiving_tds\n2026,11,2026_11_BUF_KC,BUF,KC,p1,200,10,0,0,0\n"),
    SNAPS: (b"season,week,game_id,team,opponent,pfr_player_id,offense_snaps\n"
            b"2026,11,2026_11_BUF_KC,BUF,KC,r1,12\n"),
    ROSTER: b"season,gsis_id,pfr_id\n2026,p1,r1\n",
}

def rejected(error, fragment, function, *args, **kwargs):
    try:
        function(*args, **kwargs)
    except error as exc:
        assert fragment in str(exc), str(exc)
    else:
        raise AssertionError(f"expected {error.__name__}: {fragment}")

def fixture(url, *, timeout, max_bytes):
    name = url.rsplit("/", 1)[-1]
    assert timeout == C.TIMEOUT_SECONDS and timeout > 0
    assert max_bytes == C.MAX_SOURCE_BYTES and max_bytes > 0
    return 200, BODIES[name]

def no_network(*args, **kwargs):
    raise AssertionError("an existing generation must never fetch")
`;

function run(body) {
  const code = `${fixtures}\nwith tempfile.TemporaryDirectory() as temp:\n    root = Path(temp)\n`
    + body.trim().split('\n').map((line) => `    ${line}`).join('\n');
  assert.doesNotThrow(() => execFileSync('python3', ['-'], {
    cwd: repo,
    input: code,
    encoding: 'utf8',
  }));
}

test('one complete capture records hashes and replays a frozen HTTP 404 without refetching', () => {
  run(String.raw`
cache = root / "capture"
calls = []

def transport(url, **kwargs):
    name = url.rsplit("/", 1)[-1]
    calls.append(name)
    rejected(C.CaptureUnpublished, "published", C.read_rows, cache, STATS)
    assert not (cache / C.MANIFEST).exists()
    return (404, b"not published") if name == SNAPS else fixture(url, **kwargs)

manifest = C.capture(2026, cache, transport=transport)
assert calls == [STATS, SNAPS, ROSTER]
marker = cache / C.MANIFEST
marker_before = marker.read_bytes()
assert json.loads(marker_before) == manifest
assert set(manifest["sources"]) == set(BODIES)
assert set(p.name for p in cache.iterdir()) == {C.MANIFEST, STATS, ROSTER}
for name, body in BODIES.items():
    src = manifest["sources"][name]
    assert src["source_url"].endswith("/" + name)
    assert src["source_utc"].endswith("Z") and src["source_utc"] <= manifest["published_utc"]
    if name == SNAPS:
        assert (src["status"], src["http_status"], src["sha256"], src["bytes"]) == ("unknown", 404, None, None)
    else:
        assert (src["status"], src["http_status"], src["sha256"], src["bytes"]) == (
            "captured", 200, hashlib.sha256(body).hexdigest(), len(body))
        assert (cache / name).read_bytes() == body
assert C.read_rows(cache, STATS)[0]["passing_yards"] == "200"
assert C.read_rows(cache, ROSTER) == [{"season": "2026", "gsis_id": "p1", "pfr_id": "r1"}]
rejected(C.SourceUnknown, "HTTP 404", C.read_rows, cache, SNAPS)
assert C.capture(2026, cache, transport=no_network) == manifest
assert marker.read_bytes() == marker_before
rejected(C.SourceUnknown, SNAPS, C.read_rows, cache, SNAPS)
rejected(C.CaptureTampered, "2026", C.capture, 2025, cache, transport=no_network)
`);
});

test('outages, invalid bodies and partial directories cannot publish a capture', () => {
  run(String.raw`
cache = root / "capture"
calls, waits = [], []

def outage(url, **kwargs):
    name = url.rsplit("/", 1)[-1]
    calls.append(name)
    if name == SNAPS:
        return 504, b"gateway timeout"
    return fixture(url, **kwargs)

rejected(C.CaptureError, "HTTP 504", C.capture, 2026, cache, transport=outage, sleep=waits.append)
assert calls == [STATS, SNAPS, SNAPS, SNAPS] and waits == [1, 2]
assert not list(cache.iterdir())
rejected(C.CaptureUnpublished, "manifest.json", C.read_rows, cache, STATS)

for bad in (b"<html>error</html>", BODIES[STATS].splitlines()[0], BODIES[STATS][:-10],
            BODIES[STATS].replace(b"2026,11,", b"2025,11,")):
    rejected(C.CaptureError, "invalid grading source CSV", C.capture, 2026, cache,
             transport=lambda *args, **kwargs: (200, bad))
    assert not list(cache.iterdir())

partial = cache / STATS
partial.write_bytes(b"existing unrelated bytes")
rejected(C.CaptureUnpublished, "partial", C.capture, 2026, cache, transport=no_network)
assert partial.read_bytes() == b"existing unrelated bytes"
assert not (cache / C.MANIFEST).exists()
rejected(C.CaptureMissing, "directory or file missing", C.read_rows, root / "missing", STATS)

complete = root / "good"
C.capture(2026, complete, transport=fixture)
assert C.read_rows(complete, SNAPS)[0]["offense_snaps"] == "12"

write_failed = root / "write_failed"
write_new = C._write_new

def interrupted(directory, name, raw):
    if name == SNAPS:
        raise OSError("injected write failure")
    return write_new(directory, name, raw)

with patch.object(C, "_write_new", interrupted):
    rejected(C.CaptureTampered, "injected write failure", C.capture, 2026, write_failed, transport=fixture)
assert (write_failed / STATS).is_file()
assert not (write_failed / C.MANIFEST).exists()
rejected(C.CaptureUnpublished, "manifest.json", C.read_rows, write_failed, STATS)

sync_failed = root / "sync_failed"
fsync = os.fsync

def interrupted_sync(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode) and C.MANIFEST in os.listdir(fd):
        raise OSError("injected final sync failure")
    return fsync(fd)

with patch.object(C.os, "fsync", interrupted_sync):
    rejected(C.CaptureTampered, "injected final sync failure", C.capture, 2026, sync_failed, transport=fixture)
assert not (sync_failed / C.MANIFEST).exists()
rejected(C.CaptureUnpublished, "manifest.json", C.read_rows, sync_failed, STATS)
`);
});

test('read and capture refuse tampered bytes, membership and unsafe paths', () => {
  run(String.raw`
canonical_root = root.resolve()
seed = canonical_root / "capture"
C.capture(2026, seed, transport=fixture)

def checkout(label):
    return shutil.copytree(seed, canonical_root / label)

bad = checkout("bad_bytes")
(bad / SNAPS).write_bytes(BODIES[SNAPS].replace(b",12\n", b",13\n"))
rejected(C.CaptureTampered, SNAPS, C.read_rows, bad, STATS)
rejected(C.CaptureTampered, "SHA256", C.capture, 2026, bad, transport=no_network)
assert (bad / SNAPS).read_bytes().endswith(b",13\n")

missing = checkout("missing_member")
(missing / SNAPS).unlink()
rejected(C.CaptureMissing, SNAPS, C.read_rows, missing, STATS)

extra = checkout("extra_file")
(extra / "other.csv").write_bytes(BODIES[STATS])
rejected(C.CaptureTampered, "other.csv", C.read_rows, extra, STATS)

for label in ("missing_entry", "changed_url"):
    invalid = checkout(label)
    marker = invalid / C.MANIFEST
    manifest = json.loads(marker.read_bytes())
    if label == "missing_entry":
        del manifest["sources"][SNAPS]
    else:
        manifest["sources"][SNAPS]["source_url"] = manifest["sources"][ROSTER]["source_url"]
    marker.write_text(json.dumps(manifest))
    rejected(C.CaptureTampered, C.MANIFEST, C.read_rows, invalid, STATS)

linked = checkout("linked_member")
(linked / STATS).unlink()
(linked / STATS).symlink_to(seed / STATS)
rejected(C.CaptureTampered, STATS, C.read_rows, linked, STATS)

alias = canonical_root / "alias"
alias.symlink_to(seed, target_is_directory=True)
rejected(C.CaptureTampered, "safely", C.capture, 2026, alias, transport=no_network)
rejected(C.CaptureTampered, "safely", C.capture, 2026, alias / "nested", transport=no_network)
rejected(C.CaptureTampered, "unsafe", C.read_rows, seed, "../" + STATS)
rejected(C.CaptureMissing, "not a member", C.read_rows, seed, "unknown_2026.csv")
`);
});

test('HTTP transport limits response bytes and rejects a truncated advertised body', () => {
  run(String.raw`
class Response(io.BytesIO):
    status = 200

    def __init__(self, body, length=None):
        super().__init__(body)
        self.headers = {} if length is None else {"Content-Length": str(length)}

def check(response, function, *args):
    def open_response(request, *, timeout):
        assert request.full_url == "https://example.invalid/release.csv"
        assert timeout == 1
        assert request.get_header("Accept-encoding") == "identity"
        return response

    with patch.object(C, "urlopen", open_response):
        function(*args, C.http_fetch, "https://example.invalid/release.csv", timeout=1, max_bytes=4)
    assert response.closed

def exact(fetch, url, **kwargs):
    assert fetch(url, **kwargs) == (200, b"1234")

check(Response(b"1234", 4), exact)
check(Response(b"12345"), rejected, C.CaptureError, "byte limit")
check(Response(b"123", 4), rejected, OSError, "truncated")
`);
});
