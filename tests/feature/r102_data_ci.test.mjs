/* tests/feature/r102_data_ci.test.mjs — R102: CI runs against the data the
 * pipeline ships.
 *
 * Every pipeline publish commits to main with [skip actions] (and a GITHUB_TOKEN
 * push starts no workflow anyway), so ci.yml never saw a data commit and main went
 * red from data several times, each found on the NEXT human push.
 * .github/workflows/data-ci.yml runs when a pipeline RUN completes. Locked here:
 *   - it is triggered by the completion of all three pipelines, by their exact
 *     workflow names (a rename would silently disconnect it), and by dispatch;
 *   - it checks out main as it stands (the data commit included), not the
 *     triggering run's head;
 *   - it runs exactly ci.yml's gate (tests/run_gate.sh) and browser E2E;
 *   - it is not itself triggered by a push (so [skip actions] cannot skip it);
 *   - red opens or updates ONE titled issue and exits non-zero, green closes it,
 *     and a superseded (cancelled) check reports nothing;
 *   - permissions are the minimum: contents read, issues write.
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
  const on = WF.slice(WF.indexOf('\non:'), WF.indexOf('\nconcurrency:'));
  assert.doesNotMatch(on, /\n  push:|\n  pull_request:/, 'never push-triggered: [skip actions] cannot skip it');
});

test('R102: data-ci tests main as it stands and runs exactly the CI gate + browser E2E', () => {
  const checkouts = WF.match(/uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref: main/g) || [];
  assert.equal(checkouts.length, 2, 'both jobs check out main (the data commit), not the triggering head');
  assert.match(WF, /run: bash tests\/run_gate\.sh/);
  assert.match(WF, /run: npm run test:e2e/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /run: bash tests\/run_gate\.sh/, 'the same gate command as ci.yml');
  assert.match(ci, /run: npm run test:e2e/, 'the same browser command as ci.yml');
});

test('R102: red opens or updates one issue and fails; green closes it; superseded reports nothing', () => {
  assert.match(WF, /DATA_CI_TITLE: "\[data-ci\] main is red on pipeline data"/);
  assert.match(WF, /needs: \[gate, e2e\]\s*\n\s*if: \$\{\{ always\(\) \}\}/, 'the report runs whatever the jobs did');
  const run = WF.slice(WF.indexOf('set -euo pipefail'));
  const cancel = run.indexOf('"cancelled"');
  const green = run.indexOf('gh issue close');
  const update = run.indexOf('gh issue comment');
  const create = run.indexOf('gh issue create --title "$DATA_CI_TITLE"');
  assert.ok(cancel > 0 && cancel < green, 'a cancelled check exits before touching any issue');
  assert.ok(green > 0 && update > green && create > update, 'close on green; comment else create on red');
  assert.match(run.slice(create), /exit 1/, 'red stays red in the Actions list');
  assert.match(WF, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n/, 'least privilege');
});
