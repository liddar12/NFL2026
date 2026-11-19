/* FEED OUTAGE KEEPS THE GRADED RECORD (RCA 2026-11-08).
 *
 * The nflverse release answered HTTP 504 for stats_player_week_2026.csv during the
 * Sunday-morning daily. fetch_csv reported every non-200 as "no 2026 weekly stats
 * published yet", so each resolver rewrote its document with nothing resolved and
 * the publish wiped the season's record (estimate_scores 2407 rows -> 0, MY cards
 * graded 23385 -> 7609, review players_season 281 -> 0) and data-ci went red.
 *
 * Locked here:
 *   - only HTTP 404 means "not published yet" (a skip);
 *   - a 5xx or a transport fault is retried, then raises FeedUnavailable;
 *   - a resolver run during an outage exits non-zero and leaves its document
 *     byte-identical (its continue-on-error stage then keeps yesterday's file);
 *   - build_review (a required stage) survives the outage and notes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  input: `
import json, os, sys, tempfile, types
sys.path.insert(0, ".")
os.environ.pop("NFL_GRADING_CAPTURE_DIR", None)
${body}
`,
}).trim().split('\n').pop());

const FAKE = `
from scripts import resolve_estimates as re_
re_._RETRY_DELAYS = ()
calls = []
class Resp:
    def __init__(self, code, body=b""):
        self.status_code, self.content = code, body
def install(answers):
    seq = list(answers)
    def get(url, timeout=None):
        calls.append(url)
        a = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(a, Exception):
            raise a
        return a
    sys.modules["requests"] = types.SimpleNamespace(get=get)
`;

test('only a 404 is "not published"; a 5xx or a transport fault raises FeedUnavailable', () => {
  const r = py(`${FAKE}
out = {}
install([Resp(404)])
rows, why = re_.fetch_csv(2026)
out["404"] = [rows, why]
for name, ans in (("504", Resp(504)), ("500", Resp(500)), ("timeout", TimeoutError("t"))):
    install([ans])
    try:
        re_.fetch_csv(2026); out[name] = "returned"
    except re_.FeedUnavailable as exc:
        out[name] = str(exc)
re_._RETRY_DELAYS = (0, 0)
calls.clear()
install([Resp(504), Resp(200, b"player_id,week\\nx,1\\n")])
rows, why = re_.fetch_csv(2026)
out["retry"] = [len(rows), why, len(calls)]
print(json.dumps(out))`);
  assert.equal(r['404'][0], null);
  assert.match(r['404'][1], /HTTP 404 \(no 2026 weekly stats published yet\)/);
  assert.match(r['504'], /HTTP 504 after 1 attempt\(s\); the last good document is kept/);
  assert.match(r['500'], /HTTP 500/);
  assert.match(r['timeout'], /failed: TimeoutError/);
  // a transient failure that clears on retry reads the rows
  assert.deepEqual(r.retry, [1, null, 2]);
});

test('a resolver run during an outage exits non-zero and leaves its document untouched', () => {
  const r = py(`${FAKE}
from pathlib import Path
import subprocess

out = {}
with tempfile.TemporaryDirectory() as temp:
    directory = Path(temp)
    (directory / "requests.py").write_text(
        "class R:\\n    status_code = 504\\n    content = b''\\n"
        "def get(url, timeout=None):\\n    return R()\\n")
    env = dict(os.environ, PYTHONPATH=temp + os.pathsep + os.getcwd())
    for script, filename in (("resolve_estimates", "estimate_scores.json"),
                             ("resolve_parlay_legs", "parlay_leg_scores.json"),
                             ("resolve_my_cards", "my_card_scores.json")):
        output = directory / filename
        # Use a stable prior document even when a generator is writing the checkout.
        with output.open("wb") as stream:
            subprocess.run(["git", "show", "HEAD:data/" + filename], stdout=stream, check=True)
        before = output.read_bytes()
        code = ("import sys; from functools import partial; "
                "import scripts.resolve_estimates as e; e._RETRY_DELAYS = (); "
                "import scripts.%s as m; " % script)
        if script == "resolve_estimates":
            # This CLI has no --out. Redirect both destinations in its run entry point.
            code += ("m.run = partial(m.run, out_path=sys.argv[1], meta_path=sys.argv[2]); "
                     "sys.exit(m.main([]))")
            args = [str(output), str(directory / "meta.json")]
        else:
            code += "sys.exit(m.main(sys.argv[1:]))"
            args = ["--out", str(output)]
        p = subprocess.run([sys.executable, "-c", code, *args], env=env,
                           capture_output=True, text=True, timeout=600)
        same = output.is_file() and output.read_bytes() == before
        out[script] = [p.returncode, same, "FeedUnavailable" in p.stderr]
print(json.dumps(out))`);
  for (const [script, [rc, same, loud]] of Object.entries(r)) {
    assert.notEqual(rc, 0, `${script} must fail the stage on an outage`);
    assert.ok(same, `${script} must not rewrite its document on an outage`);
    assert.ok(loud, `${script} must name the outage`);
  }
});

test('build_review (a required stage) catches FeedUnavailable instead of failing the publish', () => {
  const r = py(`
from pathlib import Path
from unittest.mock import patch
from scripts import build_review as review, resolve_estimates as estimates

with tempfile.TemporaryDirectory() as root:
    data = Path(root, "data")
    data.mkdir()
    (data / "schedule_full.json").write_text(json.dumps({"season": 2026, "games": []}))
    cache = str(Path(root, "cache"))
    with patch.object(estimates, "fetch_csv", side_effect=estimates.FeedUnavailable("stats HTTP 504")) as fetch:
        with patch("scripts.resolve_my_cards._snaps", return_value=None):
            inputs = review.load_inputs(root=root, cache_dir=cache)
    fetch.assert_called_once_with(2026, cache)
    doc = review.build(inputs, "2026-11-08T17:00:00Z")
    print(json.dumps({"stats": inputs["stats_rows"], "source": inputs["sources"]["stats"],
                      "notes": doc["notes"]}))`);
  assert.deepEqual(r.stats, []);
  assert.equal(r.source, null);
  assert.ok(r.notes.some(note => note.includes('stats HTTP 504')));
});
