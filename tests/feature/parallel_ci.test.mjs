import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = new URL('../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
const runner = readFileSync(new URL('tests/run_gate.sh', root), 'utf8');
const commands = [
  'python3 scripts/validate_data.py', 'bash tests/smoke.sh',
  'node --test tests/feature/probe.mjs',
  ...['weekly', 'parlay', 'kdst', 'leg_pool'].map(name => `python3 scripts/backtest_${name}.py --gate`),
  'npx playwright test --config tests/playwright.config.mjs',
];

function jobs(text) {
  const source = text.slice(text.search(/^jobs:$/m));
  const starts = [...source.matchAll(/^  ([\w-]+):$/gm)];
  return Object.fromEntries(starts.map((match, i) =>
    [match[1], source.slice(match.index, starts[i + 1]?.index ?? source.length)]));
}

function inspect(text) {
  const {regression, gate, e2e, ...extra} = jobs(text);
  assert.deepEqual(extra, {});
  assert.ok(regression && gate && e2e);
  assert.match(regression, /^      fail-fast: false$/m);
  assert.match(regression, /^        partition: \[core, features\]$/m);
  assert.doesNotMatch(regression, /^    needs:|^\s+if:|continue-on-error|exclude:|include:|max-parallel:/m);
  assert.match(regression, /^          ref: \$\{\{ github.sha \}\}$/m);
  assert.match(regression, /^        run: bash tests\/run_gate.sh --partition "\$\{\{ matrix.partition \}\}"$/m);
  assert.match(regression, /python-version: "3.11"/);
  assert.match(regression, /node-version: "22"/);
  assert.doesNotMatch(regression + gate, /npm (?:i|ci|install)\b|pip install|playwright install/);
  assert.match(gate, /^    needs: \[regression\]$/m);
  assert.match(gate, /^    if: always\(\)$/m);
  assert.doesNotMatch(gate, /^    name:|^        if:|continue-on-error/m);
  assert.match(gate, /^          REGRESSION_RESULT: \$\{\{ needs.regression.result \}\}$/m);
  assert.doesNotMatch(e2e, /^    needs:/m);
  for (const command of ['npm i', 'npx playwright install --with-deps chromium', 'npm run test:e2e']) {
    assert.ok(e2e.includes('run: ' + command + '\n'));
  }
  return gate;
}

function aggregator(text, status) {
  const gate = inspect(text);
  const match = /^        run: \|\n((?:          .*\n)*)/m.exec(gate);
  assert.ok(match);
  return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', match[1].replace(/^          /gm, '')], {
    encoding: 'utf8', timeout: 5000, env: {...process.env, REGRESSION_RESULT: status},
  }).status;
}

function verifyResults(text) {
  for (const status of ['success', 'failure', 'cancelled', 'skipped', 'unknown', '']) {
    assert.equal(aggregator(text, status), status === 'success' ? 0 : 1, status);
  }
}

test('parallel workers retain both partitions and required gate rejects every non-success result', () => {
  inspect(workflow);
  verifyResults(workflow);
});

test('workflow mutants cannot omit partitions, detach the gate, skip workers or swallow failures', () => {
  const mutations = [
    ['partition: [core, features]', 'partition: [core]'],
    ['partition: [core, features]', 'partition: [features]'],
    ['needs: [regression]', 'needs: [e2e]'],
    ['if: always()', 'if: success()'],
    ['fail-fast: false', 'fail-fast: true'],
    ['  regression:\n', '  regression:\n    if: false\n'],
    ['  gate:\n', '  gate:\n    continue-on-error: true\n'],
    ['--partition "${{ matrix.partition }}"', '--partition core'],
    ['ref: ${{ github.sha }}', 'ref: main'],
  ];
  for (const [before, after] of mutations) {
    const changed = workflow.replace(before, after);
    assert.notEqual(changed, workflow);
    assert.throws(() => inspect(changed), before);
  }
  assert.throws(() => verifyResults(workflow.replace('            exit 1', '            exit 0')));
  assert.throws(() => verifyResults(workflow.replace('"$REGRESSION_RESULT" != success', '"$REGRESSION_RESULT" = success')));
});

test('real runner dispatch is exhaustive, disjoint, ordered, explicit and propagates each failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-parallel-ci-'));
  try {
    const bin = join(directory, 'bin'), log = join(directory, 'commands.log');
    mkdirSync(bin);
    mkdirSync(join(directory, 'tests/feature'), {recursive: true});
    mkdirSync(join(directory, 'node_modules/@playwright/test'), {recursive: true});
    writeFileSync(join(directory, 'tests/run_gate.sh'), runner);
    writeFileSync(join(directory, 'tests/feature/probe.mjs'), '');
    const stub = '#!/bin/bash\ncommand="${0##*/} $*"\nprintf "%s\\n" "$command" >> "$COMMAND_LOG"\nif [ "$command" = "$FAIL_COMMAND" ]; then exit 7; fi\n';
    for (const tool of ['python3', 'bash', 'node', 'npx']) writeFileSync(join(bin, tool), stub, {mode: 0o755});
    function run(args = [], failure = '') {
      writeFileSync(log, '');
      const result = spawnSync('/bin/bash', [join(directory, 'tests/run_gate.sh'), ...args], {
        encoding: 'utf8', timeout: 5000,
        env: {...process.env, PATH: bin + ':' + process.env.PATH, COMMAND_LOG: log, FAIL_COMMAND: failure},
      });
      return {...result, commands: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)};
    }
    const all = run(), core = run(['--partition', 'core']), features = run(['--partition', 'features']);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(all.commands, commands, 'default preserves every original command and order');
    assert.deepEqual(run(['--partition', 'all']).commands, commands);
    assert.deepEqual(core.commands, commands.filter((_, i) => i !== 2));
    assert.deepEqual(features.commands, [commands[2]]);
    for (const result of [core, features]) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /GATE PARTITION .* RESULT: PASS \(partial checks only\)/);
      assert.doesNotMatch(result.stdout, /GATE RESULT: PASS/);
    }
    for (const args of [['--partition'], ['--partition', 'unknown'], ['--partition', ''], ['--other', 'core'], ['--partition', 'core', '--partition', 'features']]) {
      const result = run(args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.deepEqual(result.commands, [], 'invalid arguments reject before any check');
    }
    for (const command of commands) {
      for (const args of [[], ['--partition', command === commands[2] ? 'features' : 'core']]) {
        const result = run(args, command);
        assert.equal(result.status, 1, command);
        assert.doesNotMatch(result.stdout, /RESULT: PASS/);
      }
    }
    rmSync(join(directory, 'node_modules'), {recursive: true});
    const clean = run();
    assert.equal(clean.status, 0);
    assert.deepEqual(clean.commands, commands.slice(0, -1));
    assert.match(clean.stdout, /SKIPPED — @playwright\/test not installed/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
