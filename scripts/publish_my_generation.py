#!/usr/bin/env python3
"""Dispatch an exact local MY capture to the real publisher's semantic gate.

A generation JSON result is routing metadata, never publication permission.
The publisher rechecks the final committed tree on every push/rebase retry.
Owner/engine pins come from the trusted invocation, not this result document.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import run_my_generation as generation
from scripts import pilot_config

KEYS = {'version', 'kind', 'status', 'route', 'generation_sha', 'engine_used', 'engine_commit_verified',
    'freshness_profile', 'owner_intent_action', 'runtime_binding_id', 'target_generation_id',
    'binding_artifact_name', 'period_generation_id', 'application_id', 'owner_head_event_id',
    'archive_changed', 'archive_cards', *generation.FLAGS}


def _hash(value):
    pilot_config.need(type(value) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', value))


def read_result(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno());pilot_config.need(stat.S_ISREG(info.st_mode) and info.st_size <= 16384)
        raw = stream.read(16385)
    pilot_config.need(len(raw) <= 16384)
    result = json.loads(raw, object_pairs_hook=pilot_config._unique)
    pilot_config.need(type(result) is dict and set(result) == KEYS)
    # Every accepted field is scalar. Exact keys/types bound both depth and node
    # count; no nested body or caller-provided list reaches subprocess argv.
    pilot_config.need(type(result['version']) is int and result['version'] == 1
        and result['kind'] == 'nfl.MY_generation_run.v1' and result['status'] == 'local_MY_generated_not_published')
    pilot_config.need(type(result['generation_sha']) is str and re.fullmatch(r'[0-9a-f]{40}', result['generation_sha']))
    pilot_config.need(result['freshness_profile'] == pilot_config.PROFILE)
    pilot_config.need(all(result[key] is False for key in generation.FLAGS))
    pilot_config.need(type(result['archive_changed']) is bool and type(result['archive_cards']) is int
        and 0 <= result['archive_cards'] <= 1000000)
    for key in ('runtime_binding_id', 'target_generation_id'):
        _hash(result[key])
    pilot_config.need(type(result['binding_artifact_name']) is str
        and re.fullmatch(r'[0-9a-f]{64}\.json', result['binding_artifact_name']))
    if result['route'] == 'incumbent_no_owner_intent':
        pilot_config.need(result['engine_used'] is False and result['engine_commit_verified'] is False
            and result['owner_intent_action'] is None
            and all(result[key] is None for key in ('period_generation_id', 'application_id', 'owner_head_event_id')))
    else:
        pilot_config.need(result['route'] == 'existing_explicit_owner_intent' and result['engine_used'] is True
            and result['engine_commit_verified'] is True and result['owner_intent_action'] in ('approve', 'rollback', 'revoke'))
        for key in ('period_generation_id', 'application_id', 'owner_head_event_id'):
            _hash(result[key])
    return result


def command(*, result_path, capture_dir, engine_checkout, engine_commit, authority_id, actor_ref, message):
    from scripts import generation_capture_runtime as runtime
    result = read_result(result_path)
    pilot_config.need(runtime.head_identity(ROOT) == result['generation_sha'])
    pilot_config.need(type(engine_commit) is str and re.fullmatch(r'[0-9a-f]{40}', engine_commit))
    _hash(authority_id)
    pilot_config.need(type(actor_ref) is str and re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?', actor_ref))
    pilot_config.need(type(message) is str and 1 <= len(message) <= 200 and '\n' not in message and '\r' not in message)
    private = runtime._output_root(capture_dir, ROOT)
    runtime._output_root(private, engine_checkout)
    if result['route'] == 'incumbent_no_owner_intent':
        flags = ['--selected-MY-binding', str(private / result['binding_artifact_name'])]
    else:
        flags = ['--period-generation-id', result['period_generation_id'],
            '--period-engine-checkout', str(Path(engine_checkout).absolute()),
            '--period-engine-commit', engine_commit, '--period-authority-id', authority_id,
            '--period-actor-ref', actor_ref]
    return ['bash', str(ROOT / 'scripts/publish_data.sh'), *flags, message]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    for name in ('result-path', 'capture-dir', 'engine-checkout', 'engine-commit', 'authority-id', 'actor-ref', 'message'):
        parser.add_argument('--' + name)
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({'version': 1, 'status': 'disabled_dry_run', 'writes': False, 'publication_authorized': False}))
        return 0
    try:
        options = {key: value for key, value in vars(args).items() if key != 'execute'}
        pilot_config.need(all(value is not None for value in options.values()))
        return subprocess.run(command(**options), cwd=ROOT, check=False).returncode
    except Exception:
        print(json.dumps({'version': 1, 'status': 'MY_publication_dispatch_refused',
            'publication_authorized': False}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
