import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const setup = String.raw`
import hashlib, importlib.util, json, pathlib, re, tempfile, textwrap
ROOT = pathlib.Path.cwd()
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
scanner = load('scanner', 'scripts/audit_dead_code.py')
reference = load('reference', 'tests/fixtures/dead_code_inventory_reference.py')
def put(root, path, content):
    target = root / path; target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')
def hashes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}
`;
function python(body) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-'], {
    cwd: ROOT, encoding: 'utf8', input: setup + body,
    timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, (result.error?.message ?? '') + result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('R52 optimized Python inventory preserves classifications, scope, Unicode boundaries and line identities', () => {
  const result = python(String.raw`
with tempfile.TemporaryDirectory(prefix='nfl-r52-parity-') as area:
    root = pathlib.Path(area); scanner.ROOT = str(root)
    module = textwrap.dedent('''\
    def unreferenced(): pass
    def local_only(): pass
    local_only()
    # local_only
    "local_only"
    def external_comment(): pass
    def external_string(): pass
    def invalid_source_reference(): pass
    def word_boundary(): pass
    def café(): pass
    def combining_boundary(): pass
    def Kelvin(): pass
    async def async_dead(): pass
    class DeadClass: pass
    class Outer:
        def nested_method(self): pass
    def duplicate(): pass
    def duplicate(): pass
    def across_files(): pass
    def seen_mjs(): pass
    def seen_yml(): pass
    def seen_yaml(): pass
    def seen_sh(): pass
    def seen_nested(): pass
    def excluded_consumers(): pass
    def main(): pass
    def run(): pass
    def build(): pass
    def cli(): pass
    def selftest(): pass
    def __dunder__(): pass
    def test_helper(): pass
    ''')
    put(root, 'scripts/a.py', module)
    put(root, 'scripts/b.py', 'def across_files(): pass\n')
    put(root, 'scripts/nested/consumer.py', '# seen_nested\n')
    put(root, 'scripts/invalid.py', 'def broken(\n# invalid_source_reference\n')
    put(root, 'tests/comment.py', '# external_comment\n')
    put(root, 'tests/consumer.mjs', 'const text = "external_string"; seen_mjs\n')
    put(root, 'tests/boundaries.mjs', 'preword_boundary word_boundary_more word_boundary2 '
        '2word_boundary αword_boundary word_boundaryβ _word_boundary word_boundary_ '
        'café_extra Xcafé caféβ combining_boundary\u0301\n')
    put(root, '.github/workflows/consumer.yml', 'run: seen_yml\n')
    put(root, '.github/workflows/consumer.yaml', 'run: seen_yaml\n')
    put(root, 'tests/consumer.sh', '# seen_sh\n')
    for folder in ('node_modules', '__pycache__', '.claude', 'worktrees'):
        put(root, 'scripts/' + folder + '/ignored.py',
            'def ignored_definition(): pass\n# excluded_consumers\n')
        put(root, 'tests/' + folder + '/ignored.mjs', 'excluded_consumers\n')
    for extension in ('js', 'txt', 'json'):
        put(root, 'tests/ignored.' + extension, 'excluded_consumers\n')
    before = hashes(root)
    old, new = reference.legacy_py_inventory(scanner), scanner.py_inventory()
    assert new == old, (old, new)
    by_name = {row['name']: row for row in new['unreferenced']}
    assert set(by_name) == {'unreferenced', 'word_boundary', 'café', 'Kelvin',
                           'async_dead', 'DeadClass', 'Outer', 'excluded_consumers'}, by_name
    assert new['file_private'] == [
        {'file': 'scripts/a.py', 'name': 'duplicate', 'line': 18, 'private_use_only': 1},
        {'file': 'scripts/a.py', 'name': 'local_only', 'line': 2, 'private_use_only': 3},
    ], new['file_private']
    assert by_name['async_dead']['line'] == 13 and by_name['Kelvin']['line'] == 12
    # 27 unique top-level names in a.py (the duplicate replaces its earlier
    # line), plus the same-named definition in b.py; nested methods are excluded.
    assert new['defs'] == 28, new['defs']
    assert hashes(root) == before
    # Punctuation creates the same boundaries as the old regular expression.
    put(root, 'tests/punctuation.mjs', '(word_boundary), café!\n')
    before = hashes(root)
    punctuated = scanner.py_inventory()
    assert punctuated == reference.legacy_py_inventory(scanner)
    assert not {'word_boundary', 'café'} & {row['name'] for row in punctuated['unreferenced']}
    assert hashes(root) == before
    print(json.dumps({'parity_cases': 2, 'definitions': new['defs'], 'data_unchanged': True}))
`);
  assert.deepEqual(result, {parity_cases: 2, definitions: 28, data_unchanged: true});
});

test('R52 short-circuits external references and retains exact internal occurrence counts', () => {
  const result = python(String.raw`
with tempfile.TemporaryDirectory(prefix='nfl-r52-work-') as area:
    root = pathlib.Path(area); scanner.ROOT = str(root)
    put(root, 'scripts/defs.py', 'def live(): pass\ndef private(): pass\nprivate()\nprivate()\n')
    put(root, 'tests/first.mjs', 'live\n')
    for index in range(20): put(root, 'tests/rest%02d.mjs' % index, 'padding ' * 100)
    original_walk, original_re = scanner.walk, scanner.re
    scanner.walk = lambda dirs, exts: iter(sorted(original_walk(dirs, exts)))
    calls = []
    class Pattern:
        def __init__(self, pattern): self.pattern = re.compile(pattern); self.name = pattern
        def search(self, text):
            calls.append((self.name, 'search', len(text))); return self.pattern.search(text)
        def findall(self, text):
            calls.append((self.name, 'findall', len(text))); return self.pattern.findall(text)
    class Regex:
        escape = staticmethod(re.escape)
        compile = Pattern
    old = reference.legacy_py_inventory(scanner)
    scanner.re = Regex
    try: new = scanner.py_inventory()
    finally: scanner.re = original_re
    assert new == old
    live_calls = [kind for pattern, kind, _ in calls if pattern == r'\blive\b']
    private_calls = [kind for pattern, kind, _ in calls if pattern == r'\bprivate\b']
    assert live_calls == ['search'], live_calls
    assert private_calls == ['search'] * 21 + ['findall'], private_calls
    assert new['file_private'] == [
        {'file': 'scripts/defs.py', 'name': 'private', 'line': 2, 'private_use_only': 2}]
    # Eager loading still refuses a later unreadable consumer even when every
    # definition would already have an external reference in an earlier file.
    original_read = scanner.read
    def broken_read(path):
        if path.endswith('rest19.mjs'): raise OSError('synthetic unreadable consumer')
        return original_read(path)
    scanner.read = broken_read
    for inventory in (lambda: reference.legacy_py_inventory(scanner), scanner.py_inventory):
        try: inventory()
        except OSError as error: assert str(error) == 'synthetic unreadable consumer'
        else: raise AssertionError('consumer read error was hidden')
    print(json.dumps({'live_searches': len(live_calls), 'live_occurrence_counts': 0,
                      'private_occurrence_counts': private_calls.count('findall'), 'read_errors_preserved': True}))
`);
  assert.deepEqual(result, {live_searches: 1, live_occurrence_counts: 0,
    private_occurrence_counts: 1, read_errors_preserved: true});
});
