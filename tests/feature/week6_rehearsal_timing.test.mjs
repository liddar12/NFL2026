import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/rehearsal_timing.py');
const setup = String.raw`
import ast, contextlib, copy, datetime as dt, importlib.util, io, json, pathlib, subprocess, sys, types
path = pathlib.Path('scripts/rehearsal_timing.py')
spec = importlib.util.spec_from_file_location('rehearsal', path)
rehearsal = importlib.util.module_from_spec(spec); spec.loader.exec_module(rehearsal)
BASE = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
def clocks(jump=0):
    walls = iter([BASE + dt.timedelta(seconds=value) for value in (0, .125, 3.25+jump, 4.375+jump)])
    monos = iter([100, 100.125, 103.25, 104.375])
    return rehearsal.RehearsalTiming(wall_clock=lambda: next(walls), monotonic_clock=lambda: next(monos))
def report():
    return {'kind': 'isolated_current_main_cached_component_rehearsal_v1',
        'started_utc': 'legacy-start', 'completed_utc': 'legacy-end',
        'weekly': {'generated_utc': 'unchanged-history-clock'}, 'frozen_clock': False,
        'steps': [{'name': 'legacy-command', 'seconds': 1.234, 'exit': 2, 'completed_utc': 'legacy-step'}]}
def stderr_document(text):
    assert text.startswith('REHEARSAL_TIMING=')
    return json.loads(text.split('=', 1)[1])
`;
function python(body) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-'], {
    cwd: ROOT, encoding: 'utf8', input: setup + body, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, (result.error?.message ?? '') + result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('rehearsal timing retains raw forward/backward clock differences and every legacy field', () => {
  const result = python(String.raw`
cases = []
for jump in (0, 3600, -60):
    timing = clocks(jump); legacy = report(); before = copy.deepcopy(legacy); saved = []
    def operation(observer):
        observer.attach(legacy, lambda: saved.append(copy.deepcopy(legacy)))
        with observer.phase('synthetic-hashing'):
            pass
        return 2
    assert timing.run(operation) == 2
    assert {key:value for key,value in legacy.items() if key != 'timing'} == before
    assert saved[-1] == legacy
    doc = legacy['timing']; phase = doc['phases'][0]; whole = doc['whole_run']
    assert whole['returncode'] == 2 and whole['outcome'] == 'returned'
    assert phase['outcome'] == 'completed'
    assert phase['monotonic_started_seconds'] == 100.125
    assert phase['monotonic_completed_seconds'] == 103.25
    assert phase['monotonic_seconds'] == 3.125
    assert phase['wall_seconds'] == 3.125 + jump
    assert phase['wall_minus_monotonic_seconds'] == jump
    assert whole['monotonic_seconds'] == 4.375
    assert whole['wall_seconds'] == 4.375 + jump
    assert whole['wall_minus_monotonic_seconds'] == jump
    assert phase['started_utc'] == '2026-01-01T00:00:00.125000Z'
    assert doc['phase_monotonic_seconds_sum'] == 3.125
    assert doc['whole_minus_phase_monotonic_seconds'] == 1.25
    assert doc['clock_sources'] == {'wall':'injected', 'monotonic':'injected'}
    cases.append({'jump':jump, 'wall_seconds':whole['wall_seconds'], 'monotonic_seconds':whole['monotonic_seconds']})
print(json.dumps({'cases':cases, 'legacy_unchanged':True, 'returncode':2}))
`);
  assert.deepEqual(result, {cases: [
    {jump: 0, wall_seconds: 4.375, monotonic_seconds: 4.375},
    {jump: 3600, wall_seconds: 3604.375, monotonic_seconds: 4.375},
    {jump: -60, wall_seconds: -55.625, monotonic_seconds: 4.375},
  ], legacy_unchanged: true, returncode: 2});
});

test('rehearsal timing rethrows original exceptions and reports observer persistence failures separately', () => {
  const result = python(String.raw`
errors = [ValueError('original failure'), subprocess.TimeoutExpired(['fixture-command'], 300),
          SystemExit(7), KeyboardInterrupt()]
for error in errors:
    timing = clocks(-60); legacy = report(); saved = []
    def operation(observer):
        observer.attach(legacy, lambda: saved.append(copy.deepcopy(legacy)))
        with observer.phase('synthetic-failure', kind='command'):
            raise error
    try: timing.run(operation)
    except BaseException as caught: assert caught is error
    else: raise AssertionError('original exception swallowed')
    doc = saved[-1]['timing']
    expected = type(error).__module__ + '.' + type(error).__qualname__
    for row in (doc['whole_run'], doc['phases'][0]):
        assert row['outcome'] == 'raised' and row['exception_type'] == expected
        assert 'returncode' not in row
        assert row['wall_minus_monotonic_seconds'] == -60
    if isinstance(error, SystemExit): assert error.code == 7
    if isinstance(error, subprocess.TimeoutExpired): assert error.timeout == 300
for fail_operation in (False, True):
    timing = clocks(); legacy = report(); original = ValueError('keep this exception'); captured = io.StringIO()
    def writer(): raise OSError('observer persistence failed')
    def operation(observer):
        observer.attach(legacy, writer)
        with observer.phase('synthetic-work'):
            if fail_operation: raise original
        return 2
    with contextlib.redirect_stderr(captured):
        if fail_operation:
            try: timing.run(operation)
            except ValueError as caught: assert caught is original
            else: raise AssertionError('observer replaced the failure')
        else: assert timing.run(operation) == 2
    doc = stderr_document(captured.getvalue())
    assert doc['persistence_error_type'] == 'builtins.OSError'
    assert doc['whole_run']['outcome'] == ('raised' if fail_operation else 'returned')
class UnavailableStderr(io.StringIO):
    def write(self, text): raise OSError('stderr unavailable')
for original in (None, ValueError('original operation failure')):
    timing = clocks(); legacy = report()
    def operation(observer):
        observer.attach(legacy, writer)
        with observer.phase('synthetic-work'):
            if original is not None: raise original
        return 2
    with contextlib.redirect_stderr(UnavailableStderr()):
        try: returned = timing.run(operation)
        except ValueError as caught: assert caught is original
        else: assert original is None and returned == 2
    assert timing.document['persistence_error_type'] == 'builtins.OSError'
    assert timing.document['stderr_error_type'] == 'builtins.OSError'
    assert timing.document['whole_run']['outcome'] == ('returned' if original is None else 'raised')
print(json.dumps({'original_exceptions_preserved':len(errors), 'observer_failure_cases':2, 'stderr_failure_cases':2}))
`);
  assert.deepEqual(result, {original_exceptions_preserved: 4, observer_failure_cases: 2, stderr_failure_cases: 2});
});

test('failed observer clock reads remain unavailable without changing original returns or exceptions', () => {
  const result = python(String.raw`
cases = 0
for failed_clock in ('wall', 'monotonic'):
    for failed_index in range(4):
        for original in (None, ValueError('original'), subprocess.TimeoutExpired(['fixture'], 300), KeyboardInterrupt()):
            counts = {'wall':0, 'monotonic':0}; saved = []; legacy = report()
            def read(clock):
                index = counts[clock]; counts[clock] += 1
                if clock == failed_clock and index == failed_index:
                    raise RuntimeError('observer clock unavailable')
                return BASE + dt.timedelta(seconds=index) if clock == 'wall' else 100 + index
            timing = rehearsal.RehearsalTiming(wall_clock=lambda:read('wall'), monotonic_clock=lambda:read('monotonic'))
            def operation(observer):
                observer.attach(legacy, lambda:saved.append(copy.deepcopy(legacy)))
                with observer.phase('bounded-fixture'):
                    if original is not None: raise original
                return 2
            try: returned = timing.run(operation)
            except BaseException as caught: assert original is not None and caught is original
            else: assert original is None and returned == 2
            doc = saved[-1]['timing']; phase = doc['phases'][0]; whole = doc['whole_run']
            affected = whole if failed_index in (0, 3) else phase
            stage = 'start' if failed_index in (0, 1) else 'end'
            assert affected['measurement_errors'] == [{'stage':stage+':'+failed_clock, 'exception_type':'builtins.RuntimeError'}]
            assert affected[failed_clock+'_seconds'] is None
            assert affected['wall_minus_monotonic_seconds'] is None
            assert affected[('started_utc' if stage == 'start' else 'completed_utc') if failed_clock == 'wall'
                else ('monotonic_started_seconds' if stage == 'start' else 'monotonic_completed_seconds')] is None
            incomplete_phase = failed_clock == 'monotonic' and failed_index in (1, 2)
            assert doc['phase_monotonic_timing_complete'] is not incomplete_phase
            assert doc['phase_monotonic_seconds_sum'] == (None if incomplete_phase else 1)
            assert doc['whole_minus_phase_monotonic_seconds'] == (None if failed_clock == 'monotonic' else 2)
            assert whole['outcome'] == ('returned' if original is None else 'raised')
            assert ('returncode' in whole) is (original is None)
            cases += 1
for wall_value, mono_value in ((BASE.replace(tzinfo=None), 1), (BASE, float('nan'))):
    timing = rehearsal.RehearsalTiming(wall_clock=lambda:wall_value, monotonic_clock=lambda:mono_value)
    legacy = report()
    def operation(observer):
        observer.attach(legacy, lambda:None)
        return 2
    assert timing.run(operation) == 2
    assert len(timing.document['whole_run']['measurement_errors']) == 2
    assert timing.document['whole_run']['wall_minus_monotonic_seconds'] is None
print(json.dumps({'clock_failure_cases':cases, 'invalid_clock_cases':2, 'original_outcomes_preserved':True}))
`);
  assert.deepEqual(result, {clock_failure_cases: 32, invalid_clock_cases: 2, original_outcomes_preserved: true});
});

test('partial final observer writes cannot damage a valid legacy report or change the original outcome', () => {
  const result = python(String.raw`
cases = 0
for mode in ('partial-write', 'replace'):
    for original in (None, ValueError('original operation failure')):
        with rehearsal.tempfile.TemporaryDirectory(prefix='rehearsal-timing-test-') as directory:
            destination = pathlib.Path(directory) / 'report.json'; legacy = report()
            before = json.dumps(legacy, sort_keys=True) + '\n'; destination.write_text(before)
            timing = clocks(); captured = io.StringIO()
            dump, replace = rehearsal.json.dump, rehearsal.os.replace
            def partial_write(report, stream, **kwargs):
                stream.write('{"partial":')
                raise OSError('synthetic disk write failure')
            def failed_replace(*args): raise OSError('synthetic replace failure')
            def operation(observer):
                observer.attach(legacy, lambda:rehearsal.write_timing_report(destination, legacy))
                with observer.phase('bounded-fixture'):
                    if original is not None: raise original
                return 2
            try:
                if mode == 'partial-write': rehearsal.json.dump = partial_write
                else: rehearsal.os.replace = failed_replace
                with contextlib.redirect_stderr(captured):
                    try: returned = timing.run(operation)
                    except ValueError as caught: assert caught is original
                    else: assert original is None and returned == 2
            finally:
                rehearsal.json.dump, rehearsal.os.replace = dump, replace
            assert destination.read_text() == before
            assert list(pathlib.Path(directory).iterdir()) == [destination]
            doc = stderr_document(captured.getvalue())
            assert doc['persistence_error_type'] == 'builtins.OSError'
            assert doc['whole_run']['outcome'] == ('returned' if original is None else 'raised')
            assert doc == timing.document
            cases += 1
with rehearsal.tempfile.TemporaryDirectory(prefix='rehearsal-timing-test-') as directory:
    destination = pathlib.Path(directory) / 'report.json'; legacy = report(); timing = clocks()
    destination.write_text(json.dumps(legacy))
    def operation(observer):
        observer.attach(legacy, lambda:rehearsal.write_timing_report(destination, legacy))
        with observer.phase('bounded-fixture'): pass
        return 2
    assert timing.run(operation) == 2
    assert json.loads(destination.read_text()) == legacy
    assert list(pathlib.Path(directory).iterdir()) == [destination]
print(json.dumps({'failed_persistence_cases':cases, 'legacy_report_bytes_preserved':True, 'successful_atomic_write':True}))
`);
  assert.deepEqual(result, {failed_persistence_cases: 4, legacy_report_bytes_preserved: true, successful_atomic_write: true});
});

test('command wrapper preserves exits, maps timeout/start failure, and omits command metadata', () => {
  const result = python(String.raw`
cases = 0
original_run = rehearsal.subprocess.run
try:
    for child_result, expected in ((0, 0), (9, 9), (-15, 143),
                                  (subprocess.TimeoutExpired(['secret-argument'], 300), 124),
                                  (OSError('secret-error'), 127)):
        calls = []; saved = []; timing = clocks(); legacy = report()
        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            if isinstance(child_result, Exception): raise child_result
            return types.SimpleNamespace(returncode=child_result)
        rehearsal.subprocess.run = fake_run
        def operation(observer):
            observer.attach(legacy, lambda:saved.append(copy.deepcopy(legacy)))
            return rehearsal.run_command(observer, ['fixture-command', 'secret-argument'])
        assert timing.run(operation) == expected
        assert calls == [(['fixture-command', 'secret-argument'], {'timeout':300})]
        doc = saved[-1]['timing']; phase = doc['phases'][0]
        assert doc['whole_run']['returncode'] == expected
        assert phase['name'] == 'command' and phase['outcome'] == 'completed'
        if isinstance(child_result, int): assert phase['returncode'] == child_result
        else: assert phase['status'] == ('timeout' if expected == 124 else 'start_failed')
        serialized = json.dumps(doc)
        assert 'secret' not in serialized and 'fixture-command' not in serialized
        cases += 1
finally:
    rehearsal.subprocess.run = original_run
print(json.dumps({'command_cases':cases, 'command_timeout':300, 'argv_omitted':True}))
`);
  assert.deepEqual(result, {command_cases: 5, command_timeout: 300, argv_omitted: true});
});

test('real standalone CLI records whole invocation and child phase without exposing argv, environment or streams', () => {
  const area = mkdtempSync(join(tmpdir(), 'nfl-standalone-rehearsal-'));
  const secret = 'timing-test-private-sentinel';
  const child = ['python3', '-I', '-S', '-B', '-c',
    'import sys; print("child output"); print("child diagnostic", file=sys.stderr); sys.exit(7)', secret];
  function run(report, command = child) {
    return spawnSync('python3', ['-I', '-S', '-B', SCRIPT, '--report', report, '--', ...command], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: {...process.env, REHEARSAL_TEST_PRIVATE: secret},
    });
  }
  try {
    const report = join(area, 'report.json');
    const result = run(report);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'child output\n');
    assert.equal(result.stderr, 'child diagnostic\n');
    const raw = readFileSync(report, 'utf8');
    const document = JSON.parse(raw).timing;
    assert.equal(document.whole_run.returncode, 7);
    assert.equal(document.whole_run.outcome, 'returned');
    assert.equal(document.phases.length, 1);
    assert.equal(document.phases[0].name, 'command');
    assert.equal(document.phases[0].returncode, 7);
    assert.ok(document.whole_run.started_utc.endsWith('Z'));
    assert.ok(document.whole_run.completed_utc.endsWith('Z'));
    assert.ok(document.whole_run.monotonic_seconds >= document.phases[0].monotonic_seconds);
    assert.ok(document.whole_minus_phase_monotonic_seconds >= 0);
    assert.equal(document.clock_sources.wall, 'system_utc');
    for (const omitted of [secret, 'child output', 'child diagnostic', 'sys.exit', 'REHEARSAL_TEST_PRIVATE']) {
      assert.ok(!raw.includes(omitted), omitted);
    }
    const failedWriter = run(join(area, 'missing', 'report.json'));
    assert.equal(failedWriter.status, 7, failedWriter.stderr);
    assert.ok(failedWriter.stderr.includes('REHEARSAL_TIMING='));
    assert.ok(failedWriter.stderr.includes('builtins.FileNotFoundError'));
    assert.ok(!failedWriter.stderr.includes(secret));
    const signaled = run(report, ['python3', '-I', '-S', '-B', '-c',
      'import os,signal; os.kill(os.getpid(),signal.SIGTERM)']);
    assert.equal(signaled.status, 143, signaled.stderr);
    const signalDoc = JSON.parse(readFileSync(report, 'utf8')).timing;
    assert.equal(signalDoc.phases[0].returncode, -15);
    assert.equal(signalDoc.whole_run.returncode, 143);
    const missing = run(report, [join(area, 'nonexistent-command'), secret]);
    assert.equal(missing.status, 127, missing.stderr);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).timing.phases[0].status, 'start_failed');
    assert.ok(!readFileSync(report, 'utf8').includes(secret));
    const rejected = run(join(ROOT, 'data', 'timing-should-not-exist.json'));
    assert.equal(rejected.status, 2);
    assert.ok(rejected.stderr.includes('outside the repository data directory'));
    assert.deepEqual(readdirSync(area), ['report.json']);
  } finally {
    rmSync(area, {recursive: true, force: true});
  }
});
