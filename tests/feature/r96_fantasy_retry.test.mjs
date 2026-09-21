/* R96 — the FANTASY endpoints get the transport retry the scoreboard already had.
 *
 * daily-pipeline run 160 (2026-09-21 22:03Z) died on ONE
 * `[Errno 104] Connection reset by peer` inside fetch_current_pro_teams, two
 * hours before kickoff, and nothing that evening was built until it was
 * re-dispatched by hand. R86b had already learned this exact lesson on the
 * scoreboard path — run 129, one TLS alert, nothing built that day — and gave
 * espn._get_json bounded retries. But the two fantasy pages reached the network
 * directly, so that fix never covered them: _kona_market_page called
 * urllib.request.urlopen with no retry at all, and _kona_page retried nothing
 * either.
 *
 * Both now go through _kona_fetch, which imports espn.py's constants rather
 * than restating them, so the attempt count cannot drift between the two paths.
 * A TRANSPORT failure is a blip and is retried; a non-200 is the feed's answer
 * and is NOT (the silent-404 lesson); the final failure raises loudly rather
 * than returning a thin page that would read as a shrinking player pool.
 *
 * `requests` must never be a gate dependency, so each case injects a stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PRELUDE = `
import json, sys, types
class RequestException(Exception): pass
class HTTPResponse:
    def __init__(self, status, body): self.status_code = status; self._body = body
    def json(self): return self._body
calls = []
sleeps = []
def make_get(script):
    def get(url, headers=None, params=None, timeout=None):
        calls.append(url)
        step = script[min(len(calls) - 1, len(script) - 1)]
        # run 160's own error, by name and errno
        if step == "reset": raise ConnectionResetError(104, "Connection reset by peer")
        if step == "500": return HTTPResponse(500, None)
        return HTTPResponse(200, {"players": [{"id": 1}]})
    return get
fake = types.ModuleType("requests")
fake.exceptions = types.SimpleNamespace(RequestException=RequestException)
sys.modules["requests"] = fake
sys.path.insert(0, ".")
from scripts.scrape import espn_players as ep
FILT = {"players": {"limit": 1, "offset": 0}}
`;

function run(script, body) {
  const py = `${PRELUDE}\nfake.get = make_get(${JSON.stringify(script)})\n${body}`;
  const r = spawnSync('python3', ['-c', py], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('R96: two connection resets then a 200 — the page comes back, with linear backoff', () => {
  const out = run(['reset', 'reset', '200'], `
out = ep._kona_fetch(2026, FILT, _sleep=sleeps.append)
print(json.dumps({"out": out, "calls": len(calls), "sleeps": sleeps}))`);
  assert.deepEqual(out.out, { players: [{ id: 1 }] });
  assert.equal(out.calls, 3, 'it retried rather than dying on the first reset');
  assert.deepEqual(out.sleeps, [2, 4], 'the same linear backoff the scoreboard path uses');
});

test('R96: three resets raise loudly, naming the url, the count and the error class', () => {
  const out = run(['reset', 'reset', 'reset'], `
try:
    ep._kona_fetch(2026, FILT, _sleep=sleeps.append)
    print(json.dumps({"raised": None}))
except ep.FeedError as exc:
    print(json.dumps({"raised": str(exc), "calls": len(calls), "sleeps": sleeps}))`);
  assert.equal(out.calls, 3);
  assert.deepEqual(out.sleeps, [2, 4]);
  assert.match(out.raised, /failed 3 times at the transport layer/);
  assert.match(out.raised, /ConnectionResetError/);
  assert.match(out.raised, /lm-api-reads\.fantasy\.espn\.com|fantasy/);
});

test("R96: a non-200 is the feed's answer — one call, no sleep, the loud non-200 error", () => {
  const out = run(['500', '200'], `
try:
    ep._kona_fetch(2026, FILT, _sleep=sleeps.append)
    print(json.dumps({"raised": None}))
except ep.FeedError as exc:
    print(json.dumps({"raised": str(exc), "calls": len(calls), "sleeps": sleeps}))`);
  assert.equal(out.calls, 1, 'a 500 must NOT be retried — it is an answer, not a blip');
  assert.deepEqual(out.sleeps, []);
  assert.match(out.raised, /HTTP 500/);
});

test('R96: BOTH fantasy pages go through the retry, and neither restates the policy', () => {
  const out = run(['reset', '200'], `
seen = []
ep._kona_fetch = (lambda orig: (lambda *a, **k: (seen.append(a[0]), orig(*a, **k))[1]))(ep._kona_fetch)
a = ep._kona_page(2026, 0)
b = ep._kona_market_page(2026, 0)
print(json.dumps({"seen": seen, "a": a, "b": b}))`);
  assert.deepEqual(out.seen, [2026, 2026],
    'both _kona_page and _kona_market_page route through _kona_fetch');

  // The constants live in espn.py and are imported, never restated here: a
  // change to the attempt count must apply to both paths or neither.
  const src = readFileSync(join(ROOT, 'scripts/scrape/espn_players.py'), 'utf8');
  assert.match(src, /from \.espn import \([\s\S]{0,120}_TRANSPORT_ATTEMPTS/,
    'the attempt count is imported from espn.py');
  assert.doesNotMatch(src, /^_TRANSPORT_ATTEMPTS\s*=/m,
    'espn_players must not define its own attempt count');
  assert.doesNotMatch(src, /^_TRANSPORT_BACKOFF_S\s*=/m,
    'espn_players must not define its own backoff');
});

test('R96: no fantasy call site reaches the network without the retry', () => {
  const src = readFileSync(join(ROOT, 'scripts/scrape/espn_players.py'), 'utf8');
  // _kona_once is the ONE place allowed to open a socket for the fantasy API.
  const opens = [...src.matchAll(/urllib\.request\.urlopen/g)].length;
  assert.equal(opens, 1, 'exactly one urlopen, inside _kona_once');
  const once = src.slice(src.indexOf('def _kona_once'), src.indexOf('def _kona_fetch'));
  assert.match(once, /urllib\.request\.urlopen/, 'and that one is inside _kona_once');
});
