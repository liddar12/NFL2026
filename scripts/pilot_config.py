#!/usr/bin/env python3
"""Resolve reviewed, nonsecret NFL pilot configuration before engine checkout.

Lean pilot (checkpoint 1): adapted from PR #175's reader. Keys narrowed to
{version, enabled, engine_commit, freshness_profile, serving_mode}; #175's
authority_id/actor_ref belong to its owner-authority stack, which stays on
#175. serving_mode is pinned to "shadow": nothing this pilot computes may
change a served document until the owner approves a rollout.

This chooses code/settings, never a model or owner intent. Repository variables
override the enabled/engine pair only when BOTH are explicitly configured.
No credentials or hosted service are read. GHA output contains validated fixed
fields only; malformed configuration never falls back to an implicit default.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parent.parent
KEYS = {'version', 'enabled', 'engine_commit', 'freshness_profile', 'serving_mode'}
PROFILE = 'confirmed_inactives_v1'
SERVING_MODES = {'shadow'}
OVERRIDES = ('SELFLEARN_NFL_PILOT_ENABLED', 'SELFLEARN_NFL_ENGINE_COMMIT')
OUTPUT_KEYS = ('enabled', 'engine_commit', 'freshness_profile', 'serving_mode', 'configuration_source')


def need(value):
    if not value:
        raise ValueError('pilot_configuration_refused')


def _unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value);value[key] = item
    return value


def read_config(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno());need(stat.S_ISREG(info.st_mode) and info.st_size <= 16384)
        raw = stream.read(16385)
    need(len(raw) <= 16384)
    value = json.loads(raw, object_pairs_hook=_unique)
    need(type(value) is dict and set(value) == KEYS)
    need(type(value['version']) is int and value['version'] == 1 and type(value['enabled']) is bool)
    need(type(value['engine_commit']) is str and re.fullmatch(r'[0-9a-f]{40}', value['engine_commit']))
    need(value['freshness_profile'] == PROFILE)
    need(value['serving_mode'] in SERVING_MODES)
    return value


def resolve(path, environment):
    config = read_config(path)
    enabled, commit = (environment.get(name) for name in OVERRIDES)
    supplied = [value not in (None, '') for value in (enabled, commit)]
    need(supplied[0] == supplied[1])
    source = 'repository_config'
    if all(supplied):
        need(enabled in ('0', '1') and type(commit) is str and re.fullmatch(r'[0-9a-f]{40}', commit))
        config.update(enabled=enabled == '1', engine_commit=commit)
        source = 'repository_variables'
    return {'enabled': '1' if config['enabled'] else '0',
        **{name: config[name] for name in ('engine_commit', 'freshness_profile', 'serving_mode')},
        'configuration_source': source}


def write_outputs(path, values, environment):
    """Append only to the explicitly selected GitHub-provided output file."""
    expected = environment.get('GITHUB_OUTPUT')
    need(type(expected) is str and expected and Path(path).absolute() == Path(expected).absolute())
    need(set(values) == set(OUTPUT_KEYS))
    raw = ''.join(name + '=' + values[name] + '\n' for name in OUTPUT_KEYS).encode('ascii')
    need(len(raw) <= 4096 and all('\n' not in values[name] and '\r' not in values[name] for name in OUTPUT_KEYS))
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'ab') as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024)
        stream.write(raw);stream.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'config/selflearning_pilot.json'))
    parser.add_argument('--github-output')
    args = parser.parse_args(argv)
    try:
        values = resolve(args.config, os.environ)
        if args.github_output is not None:
            write_outputs(args.github_output, values, os.environ)
        print(json.dumps({'version': 1, 'kind': 'nfl.pilot_configuration.v1', **values,
            'model_approval_recorded': False, 'production_authorized': False}, sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'version': 1, 'status': 'pilot_configuration_refused',
            'model_approval_recorded': False, 'production_authorized': False}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
