"""Require append-only learning evidence relative to the fetched publication base.

Compares bounded committed Git trees, not repaired worktree files. This does NOT
authenticate approvals, validate a forecast, authorize publication or merge owner
heads. Those remain separate gates. No checkout, index or source writes occur.
"""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SHA = re.compile(r'[0-9a-f]{40}\Z')
PREFIXES = ('data/learning_feedback.json', 'data/learning_control/',
    'data/snapshots/learning_journal/', 'data/snapshots/learning_sources/',
    'data/snapshots/learning_outcomes/', 'data/snapshots/learning_feedback/')
MAX_METADATA, MAX_FILES, MAX_FILE, MAX_TOTAL, SECONDS = 1024 * 1024, 20000, 128 * 1024 * 1024, 1024 ** 3, 120


def need(value, reason):
    if not value:
        raise ValueError(reason)


def _git(root, args, *, limit=MAX_METADATA, seconds=30):
    """Read local Git with bounded stdout and deadline, without #175 imports.

    Stdout is streamed rather than captured without a bound. Fixed callers use
    no fetch, checkout, hooks, text conversion, replacement objects or writes.
    """
    deadline = time.monotonic() + seconds
    environment = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0',
        'GIT_NO_LAZY_FETCH': '1', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
    for key in tuple(environment):
        if key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
                   'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES') or key.startswith('GIT_CONFIG_'):
            environment.pop(key)
    environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    process = subprocess.Popen(['git', '--no-replace-objects', *args], cwd=root, env=environment,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    result = bytearray()
    selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            need(remaining > 0, 'learning_history_git_deadline')
            for key, _mask in selector.select(min(remaining, 0.1)):
                raw = os.read(key.fd, min(65536, limit + 1 - len(result)))
                if raw:
                    result.extend(raw)
                else:
                    selector.unregister(key.fileobj)
                need(len(result) <= limit, 'learning_history_git_output_limit')
        need(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0,
            'learning_history_git_unavailable')
        return bytes(result)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def _mutable(path):
    return path in ('data/learning_feedback.json', 'data/learning_control/current.json') or bool(
        re.fullmatch(r'data/learning_control/owner/heads/[0-9a-f]{64}\.json', path))


def _tree(raw):
    need(not raw or raw.endswith(b'\0'), 'learning_history_tree_framing')
    rows, total = {}, 0
    for row in raw.split(b'\0'):
        if not row:
            continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, oid, size = metadata.split()
        path = name.decode('utf-8')
        need(path not in rows and len(rows) < MAX_FILES and len(path) <= 512
             and all(p not in ('', '.', '..') for p in path.split('/'))
             and any(path == p or p.endswith('/') and path.startswith(p) for p in PREFIXES),
             'learning_history_path_or_count')
        need(kind == b'blob' and mode in (b'100644', b'100755') and SHA.fullmatch(oid.decode('ascii'))
             and size.isdigit() and 0 <= int(size) <= MAX_FILE, 'learning_history_nonregular_or_oversized')
        total += int(size)
        need(total <= MAX_TOTAL, 'learning_history_total_bytes')
        rows[path] = (mode, oid, int(size))
    return rows


def check_history(checkout, expected_head, base_head):
    """No retained evidence may change, disappear or change regular-file mode.

    Mutable pointers may advance but not disappear. Their authority/lineage is
    NOT established by this function. Period-return publication remains held.
    """
    need(type(expected_head) is str and SHA.fullmatch(expected_head)
         and type(base_head) is str and SHA.fullmatch(base_head), 'learning_history_exact_heads_required')
    root, deadline = Path(checkout).resolve(), time.monotonic() + SECONDS
    def git(args, maximum):
        remaining = deadline - time.monotonic()
        need(remaining > 0, 'learning_history_deadline')
        return _git(root, args, limit=maximum, seconds=min(30, remaining))
    need(git(['rev-parse', 'HEAD'], 128).strip().decode() == expected_head, 'learning_history_head_changed')
    git(['merge-base', '--is-ancestor', base_head, expected_head], 128)
    trees = [_tree(git(['ls-tree', '-r', '-l', '-z', head, '--', *PREFIXES], MAX_METADATA))
             for head in (base_head, expected_head)]
    before, after = trees
    need('data/learning_control/pending.json' not in after, 'learning_history_unacknowledged_transaction')
    retained = new = 0
    for path, original in before.items():
        if path == 'data/learning_control/pending.json':
            continue  # It is recovery state, never a publishable immutable event.
        if _mutable(path):
            need(path in after, 'learning_history_pointer_removed')
        else:
            need(after.get(path) == original, 'learning_history_removed_or_changed')
            retained += 1
    for path in after:
        if path not in before and not _mutable(path):
            new += 1
    need(git(['rev-parse', 'HEAD'], 128).strip().decode() == expected_head, 'learning_history_head_changed')
    return {'version': 1, 'kind': 'nfl.learning_history_retention.v1', 'status': 'retained_history_unchanged',
        'head': expected_head, 'base_head': base_head, 'retained_immutable_files': retained,
        'new_immutable_files': new, 'mutable_pointers': sum(_mutable(p) for p in after),
        'source_writes': False, 'network_used': False, 'owner_authenticated': False,
        'whole_release_pass': False, 'production_authorized': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('checkout', 'expected-head', 'base-head'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    try:
        result = check_history(args.checkout, args.expected_head, args.base_head)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'version': 1, 'status': 'learning_history_refused', 'source_writes': False,
            'whole_release_pass': False, 'production_authorized': False}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
