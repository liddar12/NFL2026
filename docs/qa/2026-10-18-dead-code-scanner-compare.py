import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import types

# Frozen reproduction harness: documentation lives outside the scanned corpus.
parser = argparse.ArgumentParser(description='Reproduce the 2026-10-18 matched scanner comparison; no data writes.')
parser.add_argument('--root', default=str(pathlib.Path(__file__).resolve().parents[2]))
parser.add_argument('--check-only', action='store_true', help='Verify exact source/workload fingerprints without running inventories')
args = parser.parse_args()
ROOT = pathlib.Path(args.root).resolve()
# This public main ancestor has byte-identical scanner source to the measured
# private b56fd8dd baseline, so reproduction survives a later squash merge.
BASE = '9a537b9fdf5776d280f22549b1cb4aceb0b45458'
PATH = ROOT / 'scripts/audit_dead_code.py'
old_source = subprocess.check_output(['git', 'show', BASE + ':scripts/audit_dead_code.py'], cwd=ROOT)
new_source = PATH.read_bytes()
assert hashlib.sha256(old_source).hexdigest() == '04cd883aaca1ca89676e56717278accd94800bc8720ab96ffa30719d85249e84'
assert hashlib.sha256(new_source).hexdigest() == '3bb591dd086c99b86f308367e45c2348c1ca0a63b84b0a22a3a2cfa384315165'

def load(name, source):
    module = types.ModuleType(name)
    module.__file__ = str(PATH)
    exec(compile(source, str(PATH), 'exec'), module.__dict__)
    assert module.ROOT == str(ROOT)
    return module

old = load('r52_original_scanner', old_source)
new = load('r52_optimized_scanner', new_source)

def fingerprint(scanner):
    files = sorted(set(scanner.walk(
        ('app', 'scripts', 'tests', '.github/workflows', 'netlify.toml', '_headers', 'index.html', 'sw.js'),
        ('.js', '.mjs', '.py', '.yml', '.yaml', '.sh', '.toml', '.html', '_headers'))))
    rows = []
    for filename in files:
        raw = pathlib.Path(filename).read_bytes()
        rows.append([str(pathlib.Path(filename).relative_to(ROOT)), len(raw), hashlib.sha256(raw).hexdigest()])
    feeds = sorted(path.name for path in (ROOT / 'data').iterdir() if path.name.endswith('.json'))
    payload = json.dumps({'files': rows, 'feeds': feeds}, separators=(',', ':'), sort_keys=True).encode()
    return {'sha256': hashlib.sha256(payload).hexdigest(), 'files': len(rows),
            'bytes': sum(row[1] for row in rows), 'top_level_feed_names': len(feeds)}

before = fingerprint(new)
assert before['sha256'] == '17201127dc8428335575e6cc3fb22d7c9863d5e34faffd6b522a0ee946d76a70', 'workload differs from recorded measurement'
print(json.dumps({'phase': 'start', 'base': BASE, 'workload': before,
                  'old_source_sha256': hashlib.sha256(old_source).hexdigest(),
                  'new_source_sha256': hashlib.sha256(new_source).hexdigest()}), flush=True)

if args.check_only:
    print(json.dumps({'phase': 'check_only', 'source_and_workload_match': True}), flush=True)
    sys.exit(0)

def measure(label, scanner):
    outputs, timings = {}, {}
    start, cpu = time.monotonic(), time.process_time()
    for key, inventory in [('js', scanner.js_inventory), ('python', scanner.py_inventory), ('data', scanner.data_inventory)]:
        stage, stage_cpu = time.monotonic(), time.process_time()
        outputs[key] = inventory()
        timings[key] = {'wall_seconds': round(time.monotonic() - stage, 6),
                        'cpu_seconds': round(time.process_time() - stage_cpu, 6)}
        print(json.dumps({'phase': label + '_' + key, **timings[key]}), flush=True)
    timings['total'] = {'wall_seconds': round(time.monotonic() - start, 6),
                        'cpu_seconds': round(time.process_time() - cpu, 6)}
    assert outputs['js']['modules'] > 20 and outputs['python']['defs'] > 200 and outputs['data']['feeds'] > 10
    return outputs, timings

old_output, old_timings = measure('old', old)
assert fingerprint(new) == before, 'workload changed during original scan'
new_output, new_timings = measure('new', new)
assert fingerprint(new) == before, 'workload changed during optimized scan'
assert new_output == old_output, 'complete inventory differs'
canonical = json.dumps(old_output, sort_keys=True, separators=(',', ':')).encode()
print(json.dumps({'phase': 'complete', 'equal': True, 'workload_unchanged': True,
    'result_sha256': hashlib.sha256(canonical).hexdigest(), 'result_bytes': len(canonical),
    'old': old_timings, 'new': new_timings,
    'total_speedup': old_timings['total']['wall_seconds'] / new_timings['total']['wall_seconds'],
    'python_speedup': old_timings['python']['wall_seconds'] / new_timings['python']['wall_seconds'],
    'counts': {'js_modules': old_output['js']['modules'],
               'python_defs': old_output['python']['defs'],
               'python_unreferenced': len(old_output['python']['unreferenced']),
               'python_file_private': len(old_output['python']['file_private']),
               'data_feeds': old_output['data']['feeds']}}, sort_keys=True), flush=True)
