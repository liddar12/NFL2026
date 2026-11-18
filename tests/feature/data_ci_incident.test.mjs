import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const execute = String.raw`
import contextlib
import io
import json
import sys

from scripts.data_ci_incident import ApiError, report

class FakeApi:
    def __init__(self, fixture):
        self.fixture = fixture
        self.issue = fixture.get("issue")
        self.comments = fixture.get("comments", [])
        self.requested = []
        self.writes = []
        self.heads = iter(fixture["heads"])

    def items(self, path, **params):
        self.requested.append(path)
        if path == "issues":
            assert params["state"] == "open"
            yield {"title": title, "number": 6, "pull_request": {}}
            if self.issue and self.issue["state"] == "open":
                yield self.issue
        elif path == "issues/7/comments":
            yield from self.comments
        else:
            raise AssertionError(path)

    def request(self, path, method="GET", payload=None, *, log=False):
        self.requested.append(path)
        if method == "GET":
            if path == "git/ref/heads/main":
                return {"object": {"sha": next(self.heads, self.fixture["head"])}}
            if path == "issues/7":
                return self.issue
            if path in self.fixture["evidence"]:
                return self.fixture["evidence"][path]
            if log or path.startswith(("check-runs/", "actions/runs/")):
                raise ApiError("fixture evidence unavailable")
            raise AssertionError(path)

        self.writes.append([method, path, payload])
        if self.fixture.get("fail") == [method, path]:
            raise ApiError("fixture write failed")
        if path == "issues":
            assert self.issue is None
            self.issue = {"number": 7, "state": "open", **payload}
        elif path == "issues/7/comments":
            self.comments.append({"user": {"login": "github-actions[bot]"}, **payload})
        elif path == "issues/7":
            self.issue.update(payload)
        else:
            raise AssertionError(path)

title = "[data-ci] main is red on pipeline data"
fixture = json.load(sys.stdin)
api = FakeApi(fixture)
description = io.StringIO()
with contextlib.redirect_stdout(description):
    try:
        status = report(api, fixture["env"])
    except ApiError as error:
        assert str(error) == "fixture write failed"
        status = 1
print(json.dumps({
    "status": status, "output": description.getvalue(), "issue": api.issue,
    "comments": api.comments, "requested": api.requested, "writes": api.writes
}))
`;

const title = '[data-ci] main is red on pipeline data';
const sha = letter => letter.repeat(40);
const testResult = (assertion, value = 5) => [
  'GATE STEP 3: feature tests (incl. AA contrast)',
  `2026-11-18T17:00:00.322839Z not ok 9 - ${assertion}`,
  '  ---',
  "  failureType: 'testCodeFailure'",
  "  error: 'unexpected value'",
  `  actual: ${value}`,
  '  ...',
  'GATE STEP 3 FAIL: feature tests (incl. AA contrast)',
  'GATE RESULT: FAIL (red — do NOT deploy)',
].join('\n');

function job(run, attempt, {name = 'gate', step = 'Run regression gate', id = 13, number = 9} = {}) {
  return {
    name, run_id: run, run_attempt: attempt, id, status: 'completed', conclusion: 'failure',
    check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${id}`,
    steps: [{name: step, number, conclusion: 'failure'}],
  };
}

function run(previous = {}, options = {}) {
  const {
    runId = 30, attempt = 2, tested = sha('a'), head = tested, gate = 'failure',
    browser = 'success', resolution = 'success', simulate = false,
    jobs = [job(runId, attempt)], logs = {[13]: testResult('first failed assertion')},
    annotations = {}, fail = null, heads = [], issue = previous.issue, comments = previous.comments,
  } = options;
  const evidence = {
    [`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`]: {
      total_count: jobs.length, jobs,
    },
    ...Object.fromEntries(Object.entries(logs).map(([id, log]) => [`actions/jobs/${id}/steps/9/logs`, log])),
    ...Object.fromEntries(Object.entries(annotations).map(([id, entries]) =>
      [`check-runs/${id}/annotations?per_page=100`, entries])),
  };
  const env = {
    GH_REPO: 'owner/repo', DATA_CI_TITLE: title, RESOLUTION: resolution, SHA: tested,
    GATE: gate, E2E: browser, GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: String(attempt),
    SOURCE: 'daily-pipeline', SOURCE_URL: 'https://github.com/owner/repo/actions/runs/2',
    RUN_URL: `https://github.com/owner/repo/actions/runs/${runId}`, SIMULATE_RED: String(simulate),
  };
  const result = spawnSync('python3', ['-c', execute], {
    cwd: root, input: JSON.stringify({env, head, heads, evidence, issue, comments, fail}), encoding: 'utf8',
    timeout: 15000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const writes = result => result.writes.map(([method, path]) => `${method} ${path}`);

test('same concrete failure refreshes exact-SHA evidence without another issue comment', () => {
  const first = run();
  assert.equal(first.status, 1);
  assert.equal(first.issue.title, title);
  assert.deepEqual(writes(first), ['POST issues']);
  assert.ok(first.requested.includes('actions/runs/30/attempts/2/jobs?per_page=100'));
  assert.match(first.issue.body, /feature test \(`[0-9a-f]{12}`\)/);
  assert.match(first.issue.body, /runs\/30\/attempts\/2/);
  assert.doesNotMatch(first.issue.body, /first failed assertion|unexpected value/);

  first.issue.body += '\n\nMaintainer triage remains verbatim.';
  const repeat = run(first, {runId: 31, tested: sha('b')});
  assert.equal(repeat.status, 1);
  assert.deepEqual(writes(repeat), ['PATCH issues/7']);
  assert.equal(repeat.comments.length, 0);
  assert.match(repeat.issue.body.split('### Latest Data CI failure')[1], new RegExp(sha('b')));
  assert.ok(repeat.issue.body.endsWith('\n\nMaintainer triage remains verbatim.'));
  assert.deepEqual(writes(run(repeat, {runId: 31, tested: sha('b')})), []);
  assert.deepEqual(writes(run(repeat)), []);
});

test('distinct assertions and changed assertion evidence each add a visible comment', () => {
  const first = run();
  const changed = run(first, {runId: 31, logs: {13: testResult('another failed assertion')}});
  assert.deepEqual(writes(changed), ['POST issues/7/comments', 'PATCH issues/7']);
  assert.match(changed.comments[0].body, /runs\/31\/attempts\/2/);
  const valueChanged = run(changed, {
    runId: 32, logs: {13: testResult('another failed assertion', 9)},
  });
  assert.deepEqual(writes(valueChanged), ['POST issues/7/comments', 'PATCH issues/7']);
  assert.equal(valueChanged.comments.length, 2);
});

test('the same browser test with a different assertion yields a visible update', () => {
  const title = '[pwa] › pwa/install.spec.mjs:22:3 › renders the installed app';
  const browserRun = (runId, received) => ({
    runId, gate: 'success', browser: 'failure',
    jobs: [job(runId, 2, {name: 'e2e', step: 'Run browser E2E (web + pwa)'})],
    logs: {13: [
      `  1) ${title} ────`, '', '    Error: expect(locator).toHaveText(expected) failed',
      '    Expected: "Loaded"', `    Received: "${received}"`, '', '  1 failed', `    ${title}`, '',
    ].join('\n')},
  });
  const first = run({}, browserRun(30, 'Loading'));
  assert.match(first.issue.body, /browser test \(`/);
  const repeat = run(first, browserRun(31, 'Loading'));
  assert.deepEqual(writes(repeat), ['PATCH issues/7']);
  const changed = run(repeat, browserRun(32, 'Offline'));
  assert.deepEqual(writes(changed), ['POST issues/7/comments', 'PATCH issues/7']);
  assert.doesNotMatch(changed.comments[0].body, /Offline|install\.spec/);
});

test('failed step names and specific check annotations distinguish setup failures', () => {
  const setup = (runId, message) => ({
    runId, jobs: [job(runId, 2, {step: 'Setup Python'})], logs: {},
    annotations: {13: [{annotation_level: 'failure', message, title: 'Setup Python'}]},
  });
  const first = run({}, setup(30, 'The specified Python version is unavailable'));
  assert.match(first.issue.body, /Setup Python/);
  assert.match(first.issue.body, /GitHub check annotation/);
  const repeat = run(first, setup(31, 'The specified Python version is unavailable'));
  assert.deepEqual(writes(repeat), ['PATCH issues/7']);
  const changed = run(repeat, setup(32, 'The Python distribution checksum failed'));
  assert.deepEqual(writes(changed), ['POST issues/7/comments', 'PATCH issues/7']);

  const generic = run(changed, setup(33, 'Process completed with exit code 1.'));
  assert.match(generic.comments.at(-1).body, /insufficient to identify a repeat failure/);
  assert.deepEqual(writes(run(generic, setup(34, 'Process completed with exit code 1.'))),
    ['POST issues/7/comments', 'PATCH issues/7']);
});

test('unavailable, incomplete, masked and stale-attempt evidence cannot hide a failure', () => {
  let previous = run();
  for (const [index, options] of [
    {logs: {}},
    {logs: {13: testResult('***')}},
    {logs: {13: testResult('first failed assertion').replace('GATE RESULT:', 'GATE STEP 4: backtest\nGATE STEP 4 FAIL: backtest\nGATE RESULT:')}},
    {jobs: [job(33, 1)]},
  ].entries()) {
    previous = run(previous, {runId: 31 + index, ...options});
    assert.deepEqual(writes(previous), ['POST issues/7/comments', 'PATCH issues/7']);
    assert.match(previous.comments.at(-1).body, /insufficient to identify a repeat failure/);
    if (options.jobs) assert.ok(!previous.requested.includes('actions/jobs/13/steps/9/logs'));
  }
});

test('green recovery is current-main-only and survives a partial write without duplicate comments', () => {
  const red = run();
  const partial = run(red, {gate: 'success', attempt: 3, fail: ['PATCH', 'issues/7']});
  assert.equal(partial.issue.state, 'open');
  assert.equal(partial.comments.length, 1);
  assert.match(partial.comments[0].body, new RegExp(sha('a')));
  assert.ok(!partial.requested.some(path => path.startsWith('actions/')));
  const recovered = run(partial, {gate: 'success', attempt: 3});
  assert.equal(recovered.status, 0);
  assert.equal(recovered.issue.state, 'closed');
  assert.equal(recovered.comments.length, 1);
  assert.deepEqual(writes(recovered), ['PATCH issues/7']);
  assert.deepEqual(writes(run(recovered, {gate: 'success', attempt: 3})), []);
});

test('a red comment written before a failed summary patch is not repeated on retry', () => {
  const issue = {number: 7, state: 'open', title, body: 'Existing maintainer notes.'};
  const partial = run({}, {issue, fail: ['PATCH', 'issues/7']});
  assert.equal(partial.comments.length, 1);
  assert.equal(partial.issue.body, issue.body);
  const retry = run(partial);
  assert.deepEqual(writes(retry), ['PATCH issues/7']);
  assert.ok(retry.issue.body.startsWith(issue.body));
});

test('no-op, cancellation, unresolved and historical reports leave issues untouched', () => {
  const first = run();
  for (const [options, status, requested] of [
    [{tested: '', gate: 'skipped', browser: 'skipped'}, 0, []],
    [{tested: '', resolution: 'failure', gate: 'skipped', browser: 'skipped'}, 1, []],
    [{gate: 'cancelled'}, 0, []],
    [{head: sha('b')}, 1, ['git/ref/heads/main']],
    [{gate: 'success', head: sha('b')}, 0, ['git/ref/heads/main']],
  ]) {
    const result = run(first, options);
    assert.equal(result.status, status);
    assert.deepEqual(result.requested, requested);
    assert.deepEqual(result.writes, []);
    if (options.head) assert.match(result.output, new RegExp(sha('a')));
  }
});

test('main advancing while a result is being reported leaves the issue untouched', () => {
  const initial = run();
  for (const options of [{}, {gate: 'success'}, {logs: {13: testResult('new assertion')}}]) {
    const result = run(initial, {runId: 31, heads: [sha('a'), sha('b')], head: sha('b'), ...options});
    assert.deepEqual(writes(result), []);
    assert.match(result.output, /Historical Data CI/);
  }
});

test('maintainer text added inside the managed section survives a new failure', () => {
  const first = run();
  first.issue.body = first.issue.body.replace('<!-- /data-ci-summary -->',
    'Maintainer note.\n<!-- /data-ci-summary -->');
  const second = run(first, {runId: 31});
  assert.deepEqual(writes(second), ['POST issues/7/comments']);
  assert.equal(second.issue.body, first.issue.body);
});

test('manual red simulation has distinct evidence from an actual failure', () => {
  const simulated = run({}, {simulate: true, browser: 'failure'});
  assert.match(simulated.issue.body, /manual simulation/);
  assert.equal(simulated.status, 1);
  assert.ok(!simulated.requested.some(path => path.startsWith('actions/')));
  assert.deepEqual(writes(run(simulated, {runId: 31, simulate: true, browser: 'failure'})),
    ['PATCH issues/7']);
  assert.deepEqual(writes(run(simulated, {runId: 31})),
    ['POST issues/7/comments', 'PATCH issues/7']);
});

test('the HTTP adapter fetches a signed log redirect without forwarding its API token', () => {
  const result = spawnSync('python3', ['-c', String.raw`
from io import BytesIO
from urllib.error import HTTPError

from scripts.data_ci_incident import GitHub

class FakeOpener:
    def open(self, request, *, timeout):
        if request.full_url.startswith("https://api.github.test/"):
            assert request.get_header("Authorization") == "Bearer fake-api-token"
            assert request.full_url.endswith("/actions/jobs/13/steps/9/logs")
            raise HTTPError(request.full_url, 302, "redirect", {
                "Location": "https://logs.github.test/job.log?signed=dummy"
            }, BytesIO())
        assert request.full_url == "https://logs.github.test/job.log?signed=dummy"
        assert request.get_header("Authorization") is None
        return BytesIO(b"log fixture")

api = GitHub({"GITHUB_API_URL": "https://api.github.test", "GH_REPO": "owner/repo", "GH_TOKEN": "fake-api-token"})
api.opener = FakeOpener()
assert api.request("actions/jobs/13/steps/9/logs", log=True) == "log fixture"
`], {cwd: root, encoding: 'utf8', timeout: 15000});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
});
