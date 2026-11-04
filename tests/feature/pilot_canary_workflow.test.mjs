import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../../.github/workflows/selflearning-canary.yml', import.meta.url), 'utf8');
const PIN = 'aacb19c73122f257449e977df40f2a2733991b2f';
const NAMES = [
  'Checkout exact NFL test tree', 'Checkout pinned public engine', 'Setup Python', 'Setup Node',
  'Refuse missing or drifting engine before tests', 'Run all focused integration tests without skips',
  'Exercise real bounded Linux CLI', 'Retain test evidence only',
];
function steps(text) {
  const positions = [...text.matchAll(/^      - name: (.+)$/gm)];
  return Object.fromEntries(positions.map((match, i) => [match[1], text.slice(match.index, positions[i + 1]?.index)]));
}
function run(step) {
  const match = /^        run: \|\n((?:          .*\n|\n)*)/m.exec(step);
  assert.ok(match, 'missing literal test command');
  return match[1].replace(/^          /gm, '').trimEnd();
}
const TEST_COMMAND = [
  'set -o pipefail',
  'node --test --test-concurrency=1 --test-reporter=tap \\',
  '  tests/feature/pilot_capture_cli.test.mjs \\',
  '  tests/feature/pilot_capture_contracts.test.mjs \\',
  '  tests/feature/pilot_feedback_runner.test.mjs \\',
  '  tests/feature/pilot_inactive_confirmation.test.mjs \\',
  '  | tee "$RUNNER_TEMP/pilot-focused.tap"',
  'node --input-type=module - "$RUNNER_TEMP/pilot-focused.tap" <<\'JS\'',
  "import assert from 'node:assert/strict';",
  "import {readFileSync} from 'node:fs';",
  "const tap = readFileSync(process.argv[2], 'utf8');",
  "for (const [name, expected] of [['tests', 53], ['pass', 53], ['fail', 0], ['cancelled', 0], ['skipped', 0]]) {",
  "  const values = [...tap.matchAll(new RegExp('^# ' + name + ' ([0-9]+)$', 'gm'))];",
  "  assert.equal(values.length, 1, 'missing or ambiguous TAP total: ' + name);",
  "  assert.equal(Number(values[0][1]), expected, 'unaccepted TAP total: ' + name);",
  '}',
  'JS',
].join('\n');

function inspect(text) {
  assert.match(text, /^name: selflearning-canary$/m);
  const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:\n'));
  assert.equal(triggers.trim(), 'on:\n  pull_request:\n    branches: [main]\n  workflow_dispatch: {}');
  assert.equal(text.match(/^permissions:\n(?:  .*\n)+/m)?.[0], 'permissions:\n  contents: read\n');
  assert.deepEqual([...text.matchAll(/^  ([\w-]+):$/gm)].map(row => row[1]).filter(name => !['pull_request'].includes(name)), ['linux-canary']);
  assert.match(text, /^    if: github.event_name == 'workflow_dispatch' \|\| \(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository\)$/m);
  assert.match(text, /^    runs-on: ubuntu-latest$/m);
  assert.match(text, /^    timeout-minutes: 15$/m);
  assert.match(text, /^        working-directory: nfl$/m);
  assert.match(text, /^        shell: bash$/m);
  assert.match(text, /^      SELFLEARN_CHECKOUT: \$\{\{ github.workspace \}\}\/selflearning$/m);
  assert.match(text, new RegExp('^      EXPECTED_ENGINE_COMMIT: ' + PIN + '$', 'm'));
  assert.doesNotMatch(text, /continue-on-error|pull_request_target|\bsecrets:|\benvironment:|\bcontainer:|\bservices:|\bwrite\b|npm (?:i|ci|install)\b|pip install|curl\b|wget\b/);
  const all = steps(text);
  assert.deepEqual(Object.keys(all), NAMES);
  assert.match(all[NAMES[0]], /^          ref: \$\{\{ github.sha \}\}$/m);
  assert.match(all[NAMES[0]], /^          path: nfl$/m);
  assert.match(all[NAMES[1]], /^          repository: liddar12\/SelfLearning$/m);
  assert.match(all[NAMES[1]], new RegExp('^          ref: ' + PIN + '$', 'm'));
  assert.match(all[NAMES[1]], /^          path: selflearning$/m);
  for (const name of NAMES.slice(0, 2)) assert.match(all[name], /^          persist-credentials: false$/m);
  assert.deepEqual([...text.matchAll(/^        uses: (.+)$/gm)].map(row => row[1]), [
    'actions/checkout@v4', 'actions/checkout@v4', 'actions/setup-python@v5', 'actions/setup-node@v4', 'actions/upload-artifact@v4',
  ]);
  assert.match(all['Setup Python'], /^          python-version: '3.11'$/m);
  assert.match(all['Setup Node'], /^          node-version: '22'$/m);
  assert.equal(run(all[NAMES[4]]), [
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    'test "$(git -C "$SELFLEARN_CHECKOUT" rev-parse HEAD)" = "$EXPECTED_ENGINE_COMMIT"',
    'test -f "$SELFLEARN_CHECKOUT/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py"',
  ].join('\n'));
  assert.equal(run(all[NAMES[5]]), TEST_COMMAND);
  assert.equal(run(all[NAMES[6]]), [
    'python3 -I -S -B tests/pilot_linux_canary.py \\',
    '  --engine-checkout "$SELFLEARN_CHECKOUT" \\',
    '  --expected-nfl-sha "$GITHUB_SHA" \\',
    '  --output "$RUNNER_TEMP/pilot-linux-canary.json"',
  ].join('\n'));
  assert.match(all[NAMES[7]], /^        if: always\(\)$/m);
  assert.match(all[NAMES[7]], /path: \|\n            \$\{\{ runner.temp \}\}\/pilot-focused.tap\n            \$\{\{ runner.temp \}\}\/pilot-linux-canary.json\n/);
  assert.match(all[NAMES[7]], /^          if-no-files-found: error$/m);
  assert.match(all[NAMES[7]], /^          retention-days: 7$/m);
  assert.equal([...text.matchAll(/^        if:/gm)].length, 1, 'only evidence upload may override step success conditions');
  return all;
}

test('Linux canary is isolated, read-only, pinned and incapable of invoking a production publisher', () => {
  inspect(source);
});

test('canary contract catches floating pins, missing limits, skipped tests and production commands', () => {
  const mutations = [
    ['contents: read', 'contents: write'],
    ['timeout-minutes: 15', 'timeout-minutes: 360'],
    ['persist-credentials: false', 'persist-credentials: true'],
    ['ref: ' + PIN, 'ref: main'],
    ['ref: ${{ github.sha }}', 'ref: main'],
    ["['skipped', 0]", "['skipped', 11]"],
    ['python3 -I -S -B tests/pilot_linux_canary.py', 'python3 scripts/build_predictions.py'],
    ['--output "$RUNNER_TEMP/pilot-linux-canary.json"', '--output data/learning_feedback.json'],
    ['if-no-files-found: error', 'if-no-files-found: ignore'],
    ['uses: actions/setup-node@v4', 'uses: actions/setup-node@v4\n        continue-on-error: true'],
  ];
  for (const [before, after] of mutations) {
    const mutated = source.replace(before, after);
    assert.notEqual(mutated, source, before);
    assert.throws(() => inspect(mutated), before);
  }
});

test('TAP acceptance requires every expected test, no skip, no failure, and unambiguous totals', () => {
  const body = run(inspect(source)[NAMES[5]]).split("<<'JS'\n")[1].replace(/\nJS$/, '');
  const directory = mkdtempSync(join(tmpdir(), 'pilot-canary-tap-'));
  try {
    const path = join(directory, 'focused.tap');
    const good = '# tests 53\n# pass 53\n# fail 0\n# cancelled 0\n# skipped 0\n';
    function accepted(text) {
      writeFileSync(path, text);
      return spawnSync(process.execPath, ['--input-type=module', '-', path], {
        input: body, encoding: 'utf8', timeout: 5000,
      }).status === 0;
    }
    assert.equal(accepted(good), true);
    for (const changed of [
      good.replace('# skipped 0', '# skipped 11'), good.replace('# fail 0', '# fail 1'),
      good.replace('# pass 53', '# pass 52'), good.replace('# tests 53', '# tests 52'),
      good.replace('# cancelled 0', '# cancelled 1'), good + '# pass 53\n', '',
    ]) assert.equal(accepted(changed), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
