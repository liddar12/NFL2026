/* tests/feature/r102_data_ci.test.mjs — R102: CI runs against the data the
 * pipeline ships.
 *
 * Every pipeline publish commits to main with [skip actions] (and a GITHUB_TOKEN
 * push starts no workflow anyway), so ci.yml never saw a data commit and main went
 * red from data several times, each found on the NEXT human push.
 * .github/workflows/data-ci.yml runs when a pipeline RUN completes. Locked here:
 *   - it is triggered by the completion of all three pipelines, by their exact
 *     workflow names (a rename would silently disconnect it), and by dispatch;
 *   - it checks both jobs against the exact published SHA, after resolving the
 *     matching run-attempt receipt or the dispatch SHA;
 *   - it runs exactly ci.yml's gate (tests/run_gate.sh) and browser E2E;
 *   - it is not itself triggered by a push (so [skip actions] cannot skip it);
 *   - red opens or updates ONE titled issue and exits non-zero, green closes it,
 *     and a superseded (cancelled) check reports nothing;
 *   - only the report job can write issues. Actions and Checks are read-only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const WF = read('.github/workflows/data-ci.yml');
const nameOf = (p) => /^name:\s*(\S+)\s*$/m.exec(read(p))[1];

test('R102: data-ci fires when each pipeline finishes, by its exact workflow name', () => {
  const m = /workflow_run:\s*\n\s*workflows:\s*\[([^\]]+)\]\s*\n\s*types:\s*\[completed\]/.exec(WF);
  assert.ok(m, 'on.workflow_run with types [completed]');
  const listed = m[1].split(',').map((s) => s.trim());
  for (const p of ['.github/workflows/daily.yml', '.github/workflows/gameday.yml',
    '.github/workflows/backtest.yml']) {
    assert.ok(listed.includes(nameOf(p)), `${p} (name: ${nameOf(p)}) triggers data-ci`);
  }
  assert.match(WF, /\n  workflow_dispatch:/);
  const on = WF.slice(WF.indexOf('\non:'), WF.indexOf('\npermissions:'));
  assert.doesNotMatch(on, /\n  push:|\n  pull_request:/, 'never push-triggered: [skip actions] cannot skip it');
});

test('R102: data-ci runs exactly the CI gate and browser E2E on the same resolved SHA', () => {
  for (const name of ['gate', 'e2e']) {
    const job = WF.split(`\n  ${name}:\n`)[1].split(/\n  \w+:\n/)[0];
    assert.match(job, /needs: resolve/);
    assert.match(job, /TEST_SHA: \$\{\{ needs.resolve.outputs.sha \}\}/);
    assert.match(job, /ref: \$\{\{ env.TEST_SHA \}\}/);
    assert.match(job, /test "\$\(git rev-parse HEAD\)" = "\$TEST_SHA"/);
  }
  assert.match(WF, /run: bash tests\/run_gate\.sh/);
  assert.match(WF, /run: npm run test:e2e/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /run: bash tests\/run_gate\.sh/, 'the same gate command as ci.yml');
  assert.match(ci, /run: npm run test:e2e/, 'the same browser command as ci.yml');
});

test('R102: the report runs on terminal job outcomes with the exact candidate and serialized issue writes', () => {
  assert.match(WF, /DATA_CI_TITLE: "\[data-ci\] main is red on pipeline data"/);
  const report = WF.slice(WF.indexOf('  report:'));
  assert.match(report, /needs: \[resolve, gate, e2e\]\s*\n\s*if: \$\{\{ always\(\) && needs.resolve.result != 'skipped' \}\}/);
  assert.match(report, /group: data-ci-issue\s*\n\s*queue: max\s*\n\s*cancel-in-progress: false/);
  assert.match(report, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n\s*actions: read\s*\n\s*checks: read\s*\n/);
  assert.doesNotMatch(WF.slice(0, WF.indexOf('  report:')), /issues: write/);
  assert.match(report, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(report, /SHA: \$\{\{ needs.resolve.outputs.sha \}\}/);
  assert.match(report, /run: python3 scripts\/data_ci_incident\.py/);
});
