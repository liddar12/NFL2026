import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const setup = String.raw`
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from scripts.capture_grading_inputs import (
    CaptureError, CaptureMissing, CaptureTampered, CaptureUnpublished,
    MANIFEST, capture,
)
from scripts.player_outcomes import load_context
from scripts.resolve_estimates import fetch_csv
from scripts.resolve_my_cards import _snaps

ENV = "NFL_GRADING_CAPTURE_DIR"
STATS, SNAPS, ROSTER = "stats_player_week_2026.csv", "snap_counts_2026.csv", "roster_2026.csv"
SOURCES = {
    STATS: (b"season,week,game_id,team,opponent_team,player_id,position,player_display_name,"
            b"passing_yards,rushing_yards,receiving_yards,rushing_tds,receiving_tds\n"
            b"2026,11,2026_11_BUF_KC,KC,BUF,p1,QB,Test Player,200,10,0,0,0\n"),
    SNAPS: (b"season,week,game_id,team,opponent,player,pfr_player_id,offense_snaps\n"
            b"2026,11,2026_11_BUF_KC,KC,BUF,Test Player,r1,12\n"),
    ROSTER: b"season,gsis_id,pfr_id,espn_id\n2026,p1,r1,101\n",
}

def transport(url, **options):
    return 200, SOURCES[url.rsplit("/", 1)[-1]]

def no_network(*args, **kwargs):
    raise AssertionError("grading capture consumers must not use the network")

sys.modules["requests"] = SimpleNamespace(get=no_network)
os.environ.pop(ENV, None)

def run_loaders(path=None):
    return fetch_csv(2026, path), _snaps(2026, path, None, False), load_context(data, 2026, {}, path)

def expect_all(error, fragment, path=None):
    loaders = (lambda: fetch_csv(2026, path),
               lambda: _snaps(2026, path, None, False),
               lambda: load_context(data, 2026, {}, path))
    for loader in loaders:
        try:
            loader()
        except error as exc:
            assert fragment in str(exc), str(exc)
        else:
            raise AssertionError(f"{loader} did not raise {error.__name__}")
`;

function run(body) {
  const code = `${setup}\nwith tempfile.TemporaryDirectory() as tmp:\n    root = Path(tmp)\n`
    + '    data = root / "data"\n    data.mkdir()\n'
    + '    (data / "schedule_full.json").write_text(json.dumps({"games": []}))\n'
    + body.trim().split('\n').map((line) => `    ${line}`).join('\n');
  execFileSync('python3', ['-'], { cwd: repo, input: code, encoding: 'utf8' });
}

test('stats, snap and roster loaders share a verified capture via cache path or environment', () => {
  run(String.raw`
cache = root / "capture"
capture(2026, cache, transport=transport)
stats, snaps, context = run_loaders(cache)
assert stats[0][0]["passing_yards"] == "200" and stats[1] is None
assert snaps[11]["rows"][0]["snaps"] == 12
assert context["ids"] == {"espn": {"espn-101": {"p1"}}, "pfr": {"r1": {"p1"}}}

os.environ[ENV] = str(cache)
assert run_loaders() == run_loaders(cache)
expect_all(CaptureError, "conflicts", root / "other")
os.environ[ENV] = ""
expect_all(CaptureError, "is empty")
`);
});

test('frozen HTTP 404 leaves stats, participation and the roster crosswalk unknown', () => {
  run(String.raw`
cache = root / "capture"
capture(2026, cache, transport=lambda *args, **kwargs: (404, b""))
os.environ[ENV] = str(cache)
stats, snaps, context = run_loaders()
assert stats[0] is None and f"{STATS}: captured HTTP 404" in stats[1]
assert snaps is None
assert context["ids"] == {"espn": {}, "pfr": {}}
assert not any((cache / name).exists() for name in SOURCES)
`);
});

test('required missing, unpublished and tampered generations fail closed in every loader', () => {
  run(String.raw`
cache = root / "capture"
os.environ[ENV] = str(cache)
expect_all(CaptureMissing, "capture")
cache.mkdir()
(cache / STATS).write_bytes(SOURCES[STATS])
expect_all(CaptureUnpublished, MANIFEST)
(cache / STATS).unlink()
capture(2026, cache, transport=transport)
original = (cache / MANIFEST).read_bytes()
(cache / SNAPS).write_bytes(b"changed after capture")
expect_all(CaptureTampered, SNAPS)

os.environ.pop(ENV)
expect_all(CaptureTampered, SNAPS, cache)
(cache / SNAPS).write_bytes(SOURCES[SNAPS])
(cache / MANIFEST).write_bytes(b"{invalid json")
expect_all(CaptureTampered, MANIFEST, cache)
(cache / MANIFEST).write_bytes(original)
(cache / MANIFEST).unlink()
os.environ[ENV] = str(cache)
expect_all(CaptureUnpublished, MANIFEST)
`);
});

test('legacy loose caches and the retained receipt format still supply raw CSVs', () => {
  run(String.raw`
legacy = root / "legacy"
legacy.mkdir()
for name, raw in SOURCES.items():
    (legacy / name).write_bytes(raw)
rows, snaps, context = run_loaders(legacy)
assert rows[0][0]["player_id"] == "p1" and rows[1] is None
assert snaps[11]["rows"][0]["pfr_player_id"] == "r1"
assert context["ids"]["pfr"] == {"r1": {"p1"}}
receipts = [{"name": name, "url": "https://example.invalid/" + name, "sha256": "historical",
             "fetched_utc": "2026-11-18T00:00:00Z", "bytes": len(raw), "rows": 1}
            for name, raw in SOURCES.items()]
(legacy / MANIFEST).write_text(json.dumps({"version": 1, "sources": receipts}))
assert run_loaders(legacy) == (rows, snaps, context)
`);
});

test('workflow capture helper exports the verified generation path and refuses tampered bytes', () => {
  run(String.raw`
scripts = root / "scripts"
scripts.mkdir()
for name in ("capture_grading_inputs.sh", "capture_grading_inputs.py"):
    shutil.copyfile(Path.cwd() / "scripts" / name, scripts / name)
(data / "schedule_full.json").write_text(json.dumps({"season": 2026, "games": []}))

runner = root / "runner temp"
runner.mkdir()
env_file = runner / "actions environment"
env_file.write_text("EXISTING=value\n")
cache = runner / "grading-inputs-123456-2"
capture(2026, cache, transport=transport)
marker = cache / MANIFEST
manifest_before = marker.read_bytes()

network_attempt = root / "network_called"
(root / "sitecustomize.py").write_text(
    "from pathlib import Path\n"
    "import urllib.request\n"
    "def reject_network(*args, **kwargs):\n"
    f"    Path({str(network_attempt)!r}).touch()\n"
    "    raise AssertionError('grading capture helper unexpectedly fetched')\n"
    "urllib.request.urlopen = reject_network\n"
)
env = dict(os.environ, RUNNER_TEMP=str(runner), GITHUB_ENV=str(env_file),
           GITHUB_RUN_ID="123456", GITHUB_RUN_ATTEMPT="2", PYTHONPATH=str(root))
command = ["bash", "scripts/capture_grading_inputs.sh"]

done = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
assert done.returncode == 0, done.stderr
assert str(marker) in done.stdout, done.stdout
assignment = f"{ENV}={cache}\n"
assert env_file.read_text() == "EXISTING=value\n" + assignment
assert marker.read_bytes() == manifest_before
assert all((cache / name).read_bytes() == raw for name, raw in SOURCES.items())
assert not network_attempt.exists()

tampered = SOURCES[SNAPS].replace(b",12\n", b",99\n")
(cache / SNAPS).write_bytes(tampered)
refused = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
assert refused.returncode != 0, refused.stdout
assert SNAPS in refused.stderr and "SHA256" in refused.stderr, refused.stderr
assert env_file.read_text() == "EXISTING=value\n" + assignment * 2
assert marker.read_bytes() == manifest_before
assert (cache / SNAPS).read_bytes() == tampered
assert not network_attempt.exists()
`);
});
