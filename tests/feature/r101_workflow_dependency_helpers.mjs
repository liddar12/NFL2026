/* Static dependency proof, not an assertion that a model is approved or live. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

export const GENERATION_SOURCES = [
  'scripts/run_my_generation.py',
  'scripts/period_my_generation.py',
  'scripts/period_calibrator.py',
];

// Read Python syntax instead of matching comments or an unused command name.
// Critical producer calls must be in sequential statements (including a with
// body), not merely present in a dead conditional, nested function or fallback.
const PYTHON_DEPENDENCY = String.raw`
import ast, json, sys
sources = json.load(sys.stdin)
def need(value, reason):
    if not value: raise ValueError(reason)
def function(tree, name):
    found = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name]
    need(len(found) == 1, 'unique actual producer function required: ' + name)
    return found[0]
def statements(body):
    for row in body:
        if isinstance(row, ast.With):
            yield from statements(row.body)
        elif isinstance(row, (ast.Expr, ast.Assign, ast.AnnAssign, ast.Return)):
            yield row
def calls(body):
    return sorted([n for row in statements(body) for n in ast.walk(row) if isinstance(n, ast.Call)],
        key=lambda n: (n.lineno, n.col_offset))
def named(rows, name):
    selected = [n for n in rows if ast.unparse(n.func) == name]
    need(len(selected) == 1, 'unique reachable call required: ' + name)
    return selected[0]
def order(rows, *names):
    selected = [named(rows, name) for name in names]
    need(all(a.lineno < b.lineno for a, b in zip(selected, selected[1:])),
        'producer dependency order changed: ' + ' -> '.join(names))
    return selected
def imported(tree, module, alias):
    need(any(isinstance(n, ast.ImportFrom) and n.module == 'scripts'
        and any(a.name == module and (a.asname or a.name) == alias for a in n.names)
        for n in ast.walk(tree)), 'actual producer import missing: ' + module)
def adopted(rows, document, after, before):
    selected = [n for n in rows if ast.unparse(n.func) in ('need', 'period.need') and n.args
        and isinstance(n.args[0], ast.Compare)
        and ast.unparse(n.args[0]) == document + "['calibration_adopted'] is True"]
    need(len(selected) == 1 and after.lineno < selected[0].lineno < before.lineno,
        'calibration adoption must fail closed before the pool writer')
try:
    bridge, period, calibrator = [ast.parse(sources[name]) for name in (
        'scripts/run_my_generation.py', 'scripts/period_my_generation.py', 'scripts/period_calibrator.py')]
    for module, alias in [('build_leg_pool', 'pool_builder'), ('build_my_cards', 'my'),
        ('period_my_generation', 'period_my'), ('period_calibrator', 'period')]:
        imported(bridge, module, alias)
    legacy = function(bridge, '_legacy'); legacy_calls = calls(legacy.body)
    load, build, write, capture, my = order(legacy_calls,
        'pool_builder.load_inputs', 'pool_builder.build', 'stream.write', 'session.record_pool_bytes', 'my.run')
    adopted(legacy_calls, 'pool', build, write)
    need(ast.unparse(build.args[0]) == 'inputs', 'legacy pool must use actual loaded inputs')
    need(any(k.arg == 'capture_runtime' and ast.unparse(k.value) == 'session' for k in my.keywords),
        'legacy MY writer must consume the same capture')
    no_intent = [n for n in legacy_calls if ast.unparse(n.func) == '_no_intent']
    need(no_intent and no_intent[0].lineno < load.lineno and no_intent[-1].lineno > my.lineno,
        'legacy route must remain bounded by no-intent checks')
    run = function(bridge, 'run')
    dispatch = [n for n in run.body if isinstance(n, ast.If) and ast.unparse(n.test) == 'engine_used'
        and any(isinstance(c, ast.Call) and ast.unparse(c.func) == 'period_my.generate' for c in ast.walk(n))]
    need(len(dispatch) == 1, 'existing intent must select the actual period generation route')
    dispatch = dispatch[0]
    order(calls(dispatch.body), 'period.PeriodCalibrator', 'period_my.generate')
    named(calls(dispatch.orelse), '_legacy')
    need(not any(isinstance(n, ast.Try) for n in ast.walk(run)),
        'failed existing intent must not become a legacy fallback')
    imported(period, 'build_my_cards', 'my')
    period_calls = calls(function(period, 'generate').body)
    apply, my = order(period_calls, 'control.apply_and_save', 'my.run')
    need(any(k.arg == 'capture_runtime' and ast.unparse(k.value) == 'session' for k in my.keywords),
        'period MY writer must consume the same capture')
    imported(calibrator, 'build_leg_pool', 'build_leg_pool')
    apply_calls = calls(function(calibrator, 'apply_and_save').body)
    build = named(apply_calls, 'build_leg_pool.build')
    writers = [n for n in apply_calls if ast.unparse(n.func) == 'self._replace' and n.args
        and ast.unparse(n.args[0]) == "self.data / 'leg_pool.json'"]
    need(len(writers) == 1 and build.lineno < writers[0].lineno, 'period pool must be built before it is written')
    adopted(apply_calls, 'doc', build, writers[0])
    need(any(k.arg == 'calibration_return' and ast.unparse(k.value) == 'self' for k in build.keywords),
        'period pool must use the configured verified calibrator')
    print(json.dumps({'ok': True}))
except Exception as error:
    print(json.dumps({'ok': False, 'reason': str(error)}))
`;

export function workflowSteps(text) {
  const starts = [...text.matchAll(/^      - name: (.+)$/gm)];
  return starts.map((match, index) => ({name: match[1], index: match.index,
    body: text.slice(match.index, starts[index + 1]?.index ?? text.length)}));
}

export function assertMyGenerationDependency(workflow, sources, {before = [], after = []} = {}) {
  const steps = workflowSteps(workflow);
  const commandStep = command => {
    const found = steps.filter(step => [...step.body.matchAll(/^        run: (.+)$/gm)]
      .some(match => match[1].includes(command)));
    assert.equal(found.length, 1, `one actual workflow command required: ${command}`);
    return found[0];
  };
  const generation = commandStep('scripts/run_my_generation.py');
  assert.match(generation.body, /-- python3 -I -S -B scripts\/run_my_generation\.py --execute/);
  assert.match(generation.body, /--data-dir data/);
  assert.match(generation.body, /--generation-sha "\$GITHUB_SHA"/);
  assert.match(generation.body, /--freshness-profile "\$MY_FRESHNESS_PROFILE"/);
  assert.doesNotMatch(generation.body, /^        continue-on-error: true/m,
    'a failed pool/MY generation must stop the workflow');
  const run = /^        run: (.+)$/m.exec(generation.body)[1];
  assert.ok(!run.includes('||') && !run.includes('&') && !run.includes('--continue-on-error'),
    'the actual generator must finish successfully, never run detached or swallow its failure');
  for (const command of before) {
    assert.ok(commandStep(command).index < generation.index, `${command} must precede actual pool generation`);
  }
  let predecessor = generation;
  for (const command of after) {
    const consumer = commandStep(command);
    assert.ok(consumer.index > predecessor.index, `${command} must follow its actual producer`);
    predecessor = consumer;
  }
  const proof = JSON.parse(execFileSync('python3', ['-I', '-S', '-B', '-c', PYTHON_DEPENDENCY], {
    input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000,
  }));
  assert.equal(proof.ok, true, proof.reason);
  return generation;
}
