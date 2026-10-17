import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {assertMyGenerationDependency, GENERATION_SOURCES, workflowSteps} from './r101_workflow_dependency_helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = path => readFileSync(join(ROOT, path), 'utf8');
const sources = Object.fromEntries(GENERATION_SOURCES.map(path => [path, read(path)]));
const workflow = read('.github/workflows/daily.yml');
const ordering = {before: ['scripts/build_atd_week.py'],
  after: ['scripts/build_atd_cards.py', 'scripts/validate_data.py']};
const check = (text = workflow, code = sources) => assertMyGenerationDependency(text, code, ordering);

function mutate(path, before, after) {
  assert.ok(sources[path].includes(before), `mutation must modify actual source: ${before}`);
  return {...sources, [path]: sources[path].replace(before, after)};
}

function swapSteps(firstCommand, secondCommand) {
  const rows = workflowSteps(workflow);
  const first = rows.findIndex(row => row.body.includes(' -- python3') && row.body.includes(firstCommand));
  const second = rows.findIndex(row => row.body.includes(' -- python3') && row.body.includes(secondCommand));
  assert.ok(first >= 0 && second >= 0 && first !== second);
  const parts = rows.map(row => row.body);
  [parts[first], parts[second]] = [parts[second], parts[first]];
  return workflow.slice(0, rows[0].index) + parts.join('');
}

test('R101 dependency proof follows both actual producer routes, not a standalone CLI literal', () => {
  const generation = check();
  assert.match(generation.body, /scripts\/run_my_generation\.py --execute/);
  assert.ok(!workflow.includes('python3 scripts/build_leg_pool.py'));
});

test('R101 dependency proof rejects ATD pricing after actual pool generation', () => {
  assert.throws(() => check(swapSteps('scripts/build_atd_week.py', 'scripts/run_my_generation.py')),
    /build_atd_week\.py must precede actual pool generation/);
});

test('R101c dependency proof rejects ATD cards before actual pool generation', () => {
  assert.throws(() => check(swapSteps('scripts/build_atd_cards.py', 'scripts/run_my_generation.py')),
    /must precede actual pool generation|build_atd_cards\.py must follow its actual producer/);
});

test('R101c dependency proof rejects validation before the new ATD cards', () => {
  const rows = workflowSteps(workflow);
  const card = rows.find(row => /^        run: .*scripts\/build_atd_cards\.py$/m.test(row.body));
  const validation = rows.find(row => /^        run: .*scripts\/validate_data\.py$/m.test(row.body));
  assert.ok(card && validation);
  // Swap original positions; sequential textual replacements could undo a swap.
  const parts = rows.map(row => row === card ? validation.body : row === validation ? card.body : row.body);
  assert.throws(() => check(workflow.slice(0, rows[0].index) + parts.join('')),
    /validate_data\.py must follow its actual producer/);
});

test('R101 dependency proof refuses a comment-only bridge command', () => {
  const changed = workflow.replaceAll('scripts/run_my_generation.py', 'scripts/not_the_generator.py')
    + '\n      # python3 -I -S -B scripts/run_my_generation.py --execute\n';
  assert.throws(() => check(changed), /one actual workflow command required/);
});

test('R101 dependency proof refuses generation continue-on-error or detached execution', () => {
  const name = '      - name: MY PARLAYS generation (selected freshness, existing intent only)';
  assert.ok(workflow.includes(name));
  assert.throws(() => check(workflow.replace(name, name + '\n        continue-on-error: true')),
    /failed pool\/MY generation must stop/);
  const detached = workflow.replace(/^        run: .*scripts\/run_my_generation\.py[^\n]*$/m, '$& &');
  assert.notEqual(detached, workflow);
  assert.throws(() => check(detached), /never run detached or swallow its failure/);
});

test('R101 dependency proof rejects a missing or dead legacy pool producer', () => {
  for (const replacement of ['pool = pool_builder.no_build(inputs)', 'if False:\n        pool = pool_builder.build(inputs)']) {
    assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
      'pool = pool_builder.build(inputs)', replacement)), /unique reachable call required: pool_builder.build/);
  }
});

test('R101 dependency proof requires adoption before any legacy pool write', () => {
  assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
    "period.need(pool['calibration_adopted'] is True,", 'period.need(True,')),
    /calibration adoption must fail closed before the pool writer/);
});

test('R101 dependency proof requires legacy MY to consume the captured pool', () => {
  assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
    'archive, changed = my.run(', 'archive, changed = my.not_the_writer(')), /unique reachable call required: my.run/);
  assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
    'capture_runtime=session, capture_out_dir=capture_dir)', 'capture_runtime=None, capture_out_dir=capture_dir)')),
    /legacy MY writer must consume the same capture/);
});

test('R101 dependency proof rejects a missing existing-intent generation route', () => {
  assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
    'result = period_my.generate(', 'result = period_my.not_the_generator(')),
    /existing intent must select the actual period generation route/);
});

test('R101 dependency proof rejects an existing-intent failure fallback', () => {
  assert.throws(() => check(workflow, mutate('scripts/run_my_generation.py',
    '    action = None\n', '    action = None\n    try:\n        pass\n    except Exception:\n        return _legacy(control, generation_sha=generation_sha, capture_dir=private)\n')),
    /failed existing intent must not become a legacy fallback/);
});

test('R101c dependency proof follows the period pool producer and original MY writer', () => {
  assert.throws(() => check(workflow, mutate('scripts/period_my_generation.py',
    'pool, application = control.apply_and_save(', 'pool, application = control.not_the_pool_writer(')),
    /unique reachable call required: control.apply_and_save/);
  assert.throws(() => check(workflow, mutate('scripts/period_my_generation.py',
    'archive, changed = my.run(', 'archive, changed = my.not_the_writer(')),
    /unique reachable call required: my.run/);
});

test('R101 dependency proof requires period build, adoption and actual pool write', () => {
  assert.throws(() => check(workflow, mutate('scripts/period_calibrator.py',
    'doc=build_leg_pool.build(', 'doc=build_leg_pool.not_the_producer(')),
    /unique reachable call required: build_leg_pool.build/);
  assert.throws(() => check(workflow, mutate('scripts/period_calibrator.py',
    "need(doc['calibration_adopted']is True,", 'need(True,')),
    /calibration adoption must fail closed before the pool writer/);
  assert.throws(() => check(workflow, mutate('scripts/period_calibrator.py',
    "pool_raw=self._replace(self.data/'leg_pool.json',doc)", "pool_raw=self.not_the_writer(self.data/'leg_pool.json',doc)")),
    /period pool must be built before it is written/);
});
