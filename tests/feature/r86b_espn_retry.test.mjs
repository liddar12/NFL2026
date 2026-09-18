/* R86b — ESPN transport retries (scripts/scrape/espn._get_json).
 *
 * daily-pipeline run 129 (2026-09-18 01:15Z) died at its FIRST step on one TLS
 * alert from ESPN's edge: `resolve_locks` made a single request, the handshake
 * failed, and nothing that day was built. A transport error is a blip, not the
 * feed's answer, so _get_json now retries it with a short linear backoff — and
 * still raises loudly on the final failure. A non-200 is NOT retried: that IS
 * the feed's answer, and the silent-404 lesson stands.
 *
 * `requests` must never be a gate dependency, so each case injects a stub
 * module into sys.modules before importing the scraper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PRELUDE = `
import json, sys, types
class RequestException(Exception): pass
class SSLError(RequestException): pass
class HTTPResponse:
    def __init__(self, status, body): self.status_code = status; self._body = body
    def json(self): return self._body
calls = []
sleeps = []
def make_get(script):
    def get(url, params=None, timeout=None):
        calls.append(url)
        step = script[min(len(calls) - 1, len(script) - 1)]
        if step == "ssl": raise SSLError("[SSL: TLSV1_ALERT_INTERNAL_ERROR] tlsv1 alert internal error")
        if step == "500": return HTTPResponse(500, None)
        return HTTPResponse(200, {"ok": True})
    return get
fake = types.ModuleType("requests")
fake.exceptions = types.SimpleNamespace(RequestException=RequestException)
sys.modules["requests"] = fake
sys.path.insert(0, ".")
from scripts.scrape import espn
`;

function run(script, body) {
  const py = `${PRELUDE}\nfake.get = make_get(${JSON.stringify(script)})\n${body}`;
  const r = spawnSync('python3', ['-c', py], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('two transport failures then a 200: the payload comes back after 3 calls with linear backoff', () => {
  const out = run(['ssl', 'ssl', '200'], `
out = espn._get_json("https://x/scoreboard", {"week": 2}, _sleep=sleeps.append)
print(json.dumps({"out": out, "calls": len(calls), "sleeps": sleeps}))`);
  assert.deepEqual(out, { out: { ok: true }, calls: 3, sleeps: [2, 4] });
});

test('three transport failures raise a loud FeedError naming the url and the attempt count', () => {
  const out = run(['ssl', 'ssl', 'ssl'], `
try:
    espn._get_json("https://x/scoreboard", {}, _sleep=sleeps.append)
    print(json.dumps({"raised": None}))
except espn.FeedError as exc:
    print(json.dumps({"raised": str(exc), "calls": len(calls), "sleeps": sleeps}))`);
  assert.equal(out.calls, 3);
  assert.deepEqual(out.sleeps, [2, 4]);
  assert.match(out.raised, /failed 3 times at the transport layer/);
  assert.match(out.raised, /https:\/\/x\/scoreboard/);
  assert.match(out.raised, /SSLError/);
});

test('a non-200 is the feed\'s answer: no retry, one call, the loud non-200 FeedError', () => {
  const out = run(['500', '200'], `
try:
    espn._get_json("https://x/scoreboard", {}, _sleep=sleeps.append)
    print(json.dumps({"raised": None}))
except espn.FeedError as exc:
    print(json.dumps({"raised": str(exc), "calls": len(calls), "sleeps": sleeps}))`);
  assert.equal(out.calls, 1);
  assert.deepEqual(out.sleeps, []);
  assert.match(out.raised, /HTTP 500/);
});

test('the attempt count and backoff are the documented constants', () => {
  const out = run(['200'], `print(json.dumps({"attempts": espn._TRANSPORT_ATTEMPTS, "backoff": espn._TRANSPORT_BACKOFF_S}))`);
  assert.deepEqual(out, { attempts: 3, backoff: 2 });
});
