#!/usr/bin/env python3
"""Test-only Linux CLI acceptance with synthetic historical fixture evidence.

This does not fetch outcomes, publish sports data, authenticate a provider or
enable learning. Historical fixture forecasts are deliberately imported late;
the actual CLI clock is never overridden. Successful execution requires Linux,
an explicit NFL commit and the exact clean shared-engine checkout.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
ENGINE_COMMIT = 'aacb19c73122f257449e977df40f2a2733991b2f'
SHA = re.compile(r'[0-9a-f]{40}\Z')
CLI_TIMEOUT_SECONDS = 330
MAX_OUTPUT_BYTES = 1024 * 1024
REFUSAL_REASONS = frozenset((
    'pilot_linux_canary_actual_clock_invalid',
    'pilot_linux_canary_arguments_required',
    'pilot_linux_canary_boundary_invalid',
    'pilot_linux_canary_cli_failed',
    'pilot_linux_canary_cli_output_limit',
    'pilot_linux_canary_clock_invalid',
    'pilot_linux_canary_counts_invalid',
    'pilot_linux_canary_engine_head_mismatch',
    'pilot_linux_canary_engine_identity_changed',
    'pilot_linux_canary_engine_tree_dirty',
    'pilot_linux_canary_exact_nfl_commit_required',
    'pilot_linux_canary_failed',
    'pilot_linux_canary_fixture_not_historical',
    'pilot_linux_canary_import_history_changed',
    'pilot_linux_canary_limits_invalid',
    'pilot_linux_canary_linux_required',
    'pilot_linux_canary_nfl_head_mismatch',
    'pilot_linux_canary_nfl_tracked_tree_dirty',
    'pilot_linux_canary_output_refused',
    'pilot_linux_canary_retry_changed_history',
    'pilot_linux_canary_revision_history_invalid',
    'pilot_linux_canary_summary_invalid',
    'pilot_linux_canary_superseding_revision_invalid',
))
FALSE_FLAGS = ('model_adoption', 'public_serving_verified', 'working_live_loop',
    'provider_authenticated', 'accuracy_improvement_verified', 'hosted_ack',
    'production_authorized', 'learning_enabled')


class CanaryError(ValueError):
    pass


def need(value, reason):
    if not value:
        raise CanaryError(reason)


def instant(value):
    need(type(value) is str and value.endswith('Z'), 'pilot_linux_canary_clock_invalid')
    return dt.datetime.fromisoformat(value[:-1] + '+00:00')


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def outside_checkouts(path, engine):
    """Reject any overlap, including an ancestor or a symlink into source."""
    path = Path(path).absolute()
    need(not any(part.is_symlink() for part in (path, *path.parents)),
        'pilot_linux_canary_output_refused')
    path = path.resolve()
    need(all(not path.is_relative_to(root) and not root.is_relative_to(path)
        for root in (ROOT, engine)), 'pilot_linux_canary_output_refused')
    return path


def validate_summary(row, revisions, changed):
    """Validate observed Linux CLI evidence; a unit fixture is not execution."""
    need(type(row) is dict and row.get('version') == 1
        and row.get('kind') == 'nfl.repository_feedback_summary.v1'
        and row.get('status') == 'local_repository_persisted_not_deployed',
        'pilot_linux_canary_summary_invalid')
    for key, value in (('receipts', 4), ('outcome_revisions', revisions), ('cohort_n', 2),
                       ('late_imported_receipts', 4), ('first_imported_before_kickoff', 0)):
        need(type(row.get(key)) is int and row[key] == value, 'pilot_linux_canary_counts_invalid')
    need(row.get('state_changed') is changed and row.get('writes') is True
        and row.get('network_used') is False and all(row.get(key) is False for key in FALSE_FLAGS),
        'pilot_linux_canary_boundary_invalid')
    need(row.get('outcome_basis') == 'threshold_observations_not_sportsbook_settlement'
        and row.get('settlement_support') == 'unresolved_push_and_official_void'
        and type(row.get('candidate_gate')) is dict and row['candidate_gate'].get('passed') is False,
        'pilot_linux_canary_boundary_invalid')
    usage = row.get('resource_usage')
    need(type(usage) is dict and usage.get('platform') == 'linux'
        and usage.get('controller_limits_applied') is True
        and usage.get('memory_enforcement') == 'linux_rlimit_as',
        'pilot_linux_canary_limits_invalid')
    for key, ceiling in (('address_space_limit_bytes', 2 * 1024 ** 3), ('cpu_limit_seconds', 180),
                         ('regular_file_limit_bytes', 128 * 1024 ** 2 + 1)):
        need(type(usage.get(key)) is int and 0 < usage[key] <= ceiling,
            'pilot_linux_canary_limits_invalid')
    need(type(usage.get('wall_clock_limit_seconds')) is int and usage['wall_clock_limit_seconds'] == 300,
        'pilot_linux_canary_limits_invalid')


def validate_history(initial, repeated, corrected):
    need(initial == repeated, 'pilot_linux_canary_retry_changed_history')
    need(len(initial['receipts']) == 4 and len(initial['revisions']) == 4
        and len(corrected['revisions']) == 8 and corrected['revisions'][:4] == initial['revisions'],
        'pilot_linux_canary_revision_history_invalid')
    need(corrected['previous_state_id'] == initial['state_id']
        and corrected['sequence'] == initial['sequence'] + 1,
        'pilot_linux_canary_revision_history_invalid')
    for key in ('receipts', 'receipt_imports', 'source_imports', 'generation_records', 'source_object_ids'):
        need(initial[key] == corrected[key], 'pilot_linux_canary_import_history_changed')
    old = {row['revision_id']: row for row in initial['revisions']}
    need(len(old) == 4 and all(row['resolution']['hit'] is True for row in old.values()),
        'pilot_linux_canary_revision_history_invalid')
    superseded = set()
    for row in corrected['revisions'][4:]:
        previous = old.get(row['supersedes'])
        need(previous is not None and row['supersedes'] not in superseded
            and previous['resolution']['receipt_id'] == row['resolution']['receipt_id']
            and row['resolution']['hit'] is False, 'pilot_linux_canary_superseding_revision_invalid')
        superseded.add(row['supersedes'])


def run_cli(feedback, workspace, engine, capture_path):
    command = [sys.executable, '-I', '-S', '-B', str(ROOT / 'scripts/run_parlay_feedback.py'),
        '--execute', '--data-dir', str(workspace), '--capture', str(capture_path),
        '--engine-checkout', str(engine), '--engine-commit', ENGINE_COMMIT]
    started = utc_now()
    # File sinks avoid unbounded in-memory capture. The real child also applies
    # RLIMIT_FSIZE; both diagnostic streams are read only under this small cap.
    with tempfile.TemporaryFile(dir=workspace) as out, tempfile.TemporaryFile(dir=workspace) as err:
        result = subprocess.run(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
            timeout=CLI_TIMEOUT_SECONDS, check=False, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        need(out.tell() <= MAX_OUTPUT_BYTES and err.tell() <= MAX_OUTPUT_BYTES,
            'pilot_linux_canary_cli_output_limit')
        need(result.returncode == 0, 'pilot_linux_canary_cli_failed')
        out.seek(0)
        summary = json.loads(out.read(MAX_OUTPUT_BYTES))
    ended = utc_now()
    artifacts = workspace / 'snapshots/learning_feedback'
    pointer, state = feedback.previous(workspace, artifacts)
    report = feedback.read_json(feedback.artifact(artifacts, 'evaluations', pointer['evaluation_id']))
    need(summary['state_id'] == state['state_id'] and summary['evaluation_id'] == report['evaluation_id']
        and started <= instant(report['as_of_utc']) <= ended,
        'pilot_linux_canary_actual_clock_invalid')
    return summary, state, started, ended


def run(*, engine_checkout, expected_nfl_sha, output):
    # This must precede imports of repository helpers, temporary files and CLI.
    need(sys.platform == 'linux', 'pilot_linux_canary_linux_required')
    need(type(expected_nfl_sha) is str and SHA.fullmatch(expected_nfl_sha),
        'pilot_linux_canary_exact_nfl_commit_required')
    engine = Path(engine_checkout).resolve()
    output = outside_checkouts(output, engine)
    outside_checkouts(output.parent, engine)
    need(output.parent.is_dir() and not output.exists(), 'pilot_linux_canary_output_refused')
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from scripts.learning_history_guard import _git
    from scripts import run_parlay_feedback as feedback

    def git(root, *args):
        return _git(root, list(args), limit=MAX_OUTPUT_BYTES, seconds=20)

    def integrity():
        need(git(ROOT, 'rev-parse', 'HEAD').strip().decode('ascii') == expected_nfl_sha,
            'pilot_linux_canary_nfl_head_mismatch')
        need(not git(ROOT, 'status', '--porcelain', '--untracked-files=no'),
            'pilot_linux_canary_nfl_tracked_tree_dirty')
        need(git(engine, 'rev-parse', 'HEAD').strip().decode('ascii') == ENGINE_COMMIT,
            'pilot_linux_canary_engine_head_mismatch')
        need(not git(engine, 'status', '--porcelain', '--untracked-files=all'),
            'pilot_linux_canary_engine_tree_dirty')
        git(ROOT, 'diff', '--exit-code', expected_nfl_sha, '--', 'data', 'app', '.github', 'index.html')

    integrity()
    _, identity, engine_code_id = feedback.engine(engine, ENGINE_COMMIT)
    spec = importlib.util.spec_from_file_location('pilot_linux_synthetic_fixture', ROOT / 'tests/fixtures/week6_outcomes.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    need(utc_now() > instant('2026-09-06T00:00:00Z'), 'pilot_linux_canary_fixture_not_historical')
    try:
        with tempfile.TemporaryDirectory(prefix='nfl-cp2-linux-canary-', dir=output.parent) as temporary:
            workspace = outside_checkouts(temporary, engine)
            snapshots = workspace / 'snapshots'
            fixture.generation(snapshots)
            fixture.generation(snapshots, '2026-09-01T13:00:00Z')
            captured = fixture.capture.save_capture(fixture.bundle(), snapshots / 'outcome_evidence')
            initial, first_state, first_start, first_end = run_cli(feedback, workspace, engine, captured)
            validate_summary(initial, 4, True)
            need(first_start <= instant(first_state['updated_utc']) <= first_end
                and all(first_start <= instant(row['first_imported_utc']) <= first_end
                    for row in first_state['receipt_imports']), 'pilot_linux_canary_actual_clock_invalid')
            repeated, repeat_state, _, _ = run_cli(feedback, workspace, engine, captured)
            validate_summary(repeated, 4, False)
            correction = fixture.capture.save_capture(fixture.bundle(value='0', observed='2026-09-05T12:00:00Z'),
                snapshots / 'outcome_evidence')
            corrected, corrected_state, correction_start, correction_end = run_cli(feedback, workspace, engine, correction)
            validate_summary(corrected, 8, True)
            need(correction_start <= instant(corrected_state['updated_utc']) <= correction_end,
                'pilot_linux_canary_actual_clock_invalid')
            validate_history(first_state, repeat_state, corrected_state)
            need(identity() == engine_code_id, 'pilot_linux_canary_engine_identity_changed')
            integrity()
            evidence = {'version': 1, 'kind': 'nfl.pilot_linux_cli_canary.v1', 'status': 'passed',
                'evidence_basis': 'synthetic_fixture_only_actual_linux_cli_and_actual_utc',
                'nfl_commit': expected_nfl_sha, 'engine_commit': ENGINE_COMMIT, 'engine_code_id': engine_code_id,
                'platform': sys.platform, 'recorded_utc': utc_now().isoformat().replace('+00:00', 'Z'),
                'cli_timeout_seconds': CLI_TIMEOUT_SECONDS,
                'initial': initial, 'repeat': repeated, 'correction': corrected,
                'retry_state_and_revisions_unchanged': True, 'correction_supersedes_retained_revisions': True,
                'first_import_clocks_preserved': True, 'tracked_data_app_workflows_unchanged': True,
                'nfl_tracked_tree_clean': True, 'engine_tree_clean': True,
                'workspace_disjoint_and_temporary': True, 'network_used': False, **{key: False for key in FALSE_FLAGS}}
    finally:
        integrity()
    raw = json.dumps(evidence, sort_keys=True, allow_nan=False).encode('utf-8') + b'\n'
    need(len(raw) <= MAX_OUTPUT_BYTES, 'pilot_linux_canary_cli_output_limit')
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return evidence


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise CanaryError('pilot_linux_canary_arguments_required')


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--engine-checkout', required=True)
        parser.add_argument('--expected-nfl-sha', required=True)
        parser.add_argument('--output', required=True)
        args = parser.parse_args(argv)
        evidence = run(engine_checkout=args.engine_checkout, expected_nfl_sha=args.expected_nfl_sha, output=args.output)
        print(json.dumps(evidence, sort_keys=True, allow_nan=False))
        return 0
    except Exception as error:
        reason = str(error) if type(error) is CanaryError and str(error) in REFUSAL_REASONS else 'pilot_linux_canary_failed'
        # Every CanaryError is an internal static reason; library/CLI details,
        # operator paths and raw fixture bodies never enter refusal evidence.
        print(json.dumps({'version': 1, 'kind': 'nfl.pilot_linux_cli_canary.v1', 'status': 'refused',
            'error': reason, 'synthetic_linux_canary_passed': False,
            'network_used': False, **{key: False for key in FALSE_FLAGS}}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
