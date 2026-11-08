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
  input: `import json, os, sys, types, tempfile, contextlib, io\nsys.path.insert(0, ".")\n${body}\n`,
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
import subprocess, shutil
out = {}
for script, path in (("resolve_estimates", "data/estimate_scores.json"),
                     ("resolve_parlay_legs", "data/parlay_leg_scores.json"),
                     ("resolve_my_cards", "data/my_card_scores.json")):
    d = tempfile.mkdtemp()
    shim = os.path.join(d, "requests.py")
    open(shim, "w").write(
        "class R:\\n    status_code = 504\\n    content = b''\\n"
        "def get(url, timeout=None):\\n    return R()\\n")
    before = open(path, "rb").read()
    env = dict(os.environ, PYTHONPATH=d + os.pathsep + os.getcwd())
    code = ("import sys; sys.argv = ['%s']; import scripts.resolve_estimates as e; "
            "e._RETRY_DELAYS = (); import scripts.%s as m; sys.exit(m.main())" % (script, script))
    p = subprocess.run([sys.executable, "-c", code], env=env,
                       capture_output=True, text=True, timeout=600)
    after = open(path, "rb").read()
    if after != before:
        open(path, "wb").write(before)   # never leave the checkout dirty
    out[script] = [p.returncode, after == before, "FeedUnavailable" in p.stderr]
print(json.dumps(out))`);
  for (const [script, [rc, same, loud]] of Object.entries(r)) {
    assert.notEqual(rc, 0, `${script} must fail the stage on an outage`);
    assert.ok(same, `${script} must not rewrite its document on an outage`);
    assert.ok(loud, `${script} must name the outage`);
  }
});

test('build_review (a required stage) catches FeedUnavailable instead of failing the publish', () => {
  const r = py(`
src = open("scripts/build_review.py").read()
i = src.index("rows, why = fetch_csv(season, None)")
print(json.dumps({"guarded": "except FeedUnavailable as exc:" in src[i:i + 400]
                  and "try:" in src[i - 80:i]}))`);
  assert.equal(r.guarded, true);
});
