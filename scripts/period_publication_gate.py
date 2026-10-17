"""Check a pinned MY consumer tree, separately from deployment authorization.

A new v2 generation requires the actual committed producer/refit replay, frozen
eligibility facts and the selected serving freshness policy. A later settlement
may retain that exact consumer state without re-applying an expired forecast's
creation deadline. It may not change any consumer/source/authority byte in any
unpublished commit. Neither path authenticates a provider or an owner, proves
unobserved weekly reads, activates a candidate, or certifies a whole release.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import generation_capture_runtime as runtime
from scripts import learning_history_guard as history
from scripts import period_calibrator as period
from scripts import period_my_commit_replay as replay

SHA = re.compile(r'[0-9a-f]{40}\Z')
MAX_COMMITS, MAX_METADATA, MAX_FILES = 64, 1024 * 1024, 20000
CONTROL = 'data/learning_control/'
FROZEN_PREFIXES = (CONTROL, 'data/my_cards/', 'data/snapshots/learning_journal/',
    'data/snapshots/learning_sources/')
FROZEN_PATHS = frozenset(runtime.INPUT_PATHS.values()) | {'data/leg_pool.json'}
FLAGS = {'whole_release_pass': False, 'publication_authorized': False,
    'production_authorized': False, 'owner_authenticated': False,
    'provider_authenticated': False, 'provider_completeness_verified': False,
    'earlier_weekly_producer_reads_verified': False, 'upstream_eligibility_verified': False,
    'MY_card_semantics_verified': False, 'public_serving_verified': False,
    'accuracy_improvement_verified': False, 'source_writes': False, 'network_used': False}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def _protected(path):
    return path in FROZEN_PATHS or runtime._extra_path(path) or path.startswith(FROZEN_PREFIXES)


def _tree(root, head):
    """Bounded exact Git identities; ignore no protected additions or modes."""
    raw = runtime._git(root, ['ls-tree', '-r', '-l', '-z', head], limit=MAX_METADATA)
    need(not raw or raw.endswith(b'\0'), 'period_publication_tree_framing')
    result, seen = {}, set()
    for row in raw.split(b'\0'):
        if not row:
            continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, oid, size = metadata.split()
        path = name.decode('utf-8')
        need(path not in seen and len(seen) < MAX_FILES and len(path) <= 512
            and all(part not in ('', '.', '..') for part in path.split('/')),
            'period_publication_path_or_count')
        seen.add(path)
        if not _protected(path):
            continue
        need(kind == b'blob' and mode in (b'100644', b'100755')
            and SHA.fullmatch(oid.decode('ascii')) and size.isdigit(),
            'period_publication_nonregular_consumer')
        result[path] = (mode, oid.decode('ascii'), int(size))
    return result


def _head(root, expected):
    need(runtime._git(root, ['rev-parse', 'HEAD'], limit=128).strip().decode() == expected,
        'period_publication_head_changed')


def _unchanged_consumer(root, expected_head, base_head):
    """Only a historical published consumer can qualify, never a new control."""
    original = _tree(root, base_head)
    final = _tree(root, expected_head)
    if not any(p.startswith(CONTROL) for p in original) or original != final:
        return None
    rows = runtime._git(root, ['rev-list', '--parents', base_head + '..' + expected_head],
        limit=16384).decode().splitlines()
    need(1 <= len(rows) <= MAX_COMMITS, 'period_publication_commit_limit')
    changed = set()
    for row in rows:
        ancestry = row.split()
        need(len(ancestry) == 2, 'period_publication_ambiguous_commit')
        need(_tree(root, ancestry[0]) == original,
            'period_publication_unpublished_consumer_change')
        names = runtime._git(root, ['diff', '--name-only', '-z', '--no-renames', ancestry[1], ancestry[0], '--'],
            limit=MAX_METADATA).split(b'\0')
        names = {p.decode('utf-8') for p in names if p}
        need(all(p.startswith('data/') for p in names), 'period_publication_nondata_settlement')
        changed.update(names)
    need(changed, 'period_publication_empty_settlement')
    _head(root, expected_head)
    return {'checked_commit_count': len(rows), 'unchanged_consumer_files': len(original),
        'changed_paths': sorted(changed)}


def _control_inventory(view, authority_id):
    """The configured namespace is not permission for a second owner head."""
    scope = period.lr.fingerprint({'authority_id': authority_id, 'namespace': period.NS})[7:]
    head_path = CONTROL + 'owner/heads/' + scope + '.json'
    heads = {p for p in view.tree if p.startswith(CONTROL + 'owner/heads/')}
    need(heads == {head_path}, 'period_publication_unconfigured_owner_scope')
    recognized = re.compile(r'data/learning_control/(?:(?:applications|pools|inputs|evidence|transactions|generations)/'
        r'[0-9a-f]{64}\.json|owner/(?:events|heads)/[0-9a-f]{64}\.json|current\.json)\Z')
    need(all(recognized.fullmatch(p) for p in view.tree if p.startswith(CONTROL)),
        'period_publication_unknown_control_record')
    head = view.document(head_path)
    cursor, events = head.get('head_event_id'), set()
    for _ in range(1024):
        if cursor is None:
            break
        period.model.digest(cursor)
        name = CONTROL + 'owner/events/' + cursor[7:] + '.json'
        need(name not in events, 'period_publication_owner_cycle')
        event = view.document(name)
        need(event.get('event_id') == cursor and event.get('authority_id') == authority_id
            and event.get('namespace') == period.NS, 'period_publication_owner_scope_changed')
        events.add(name)
        cursor = event.get('previous_event_id')
    else:
        need(False, 'period_publication_owner_history_limit')
    need({p for p in view.tree if p.startswith(CONTROL + 'owner/events/')} == events,
        'period_publication_unacknowledged_owner_event')


def check_publication(*, checkout, expected_head, base_head, period_generation_id=None,
        engine_checkout=None, engine_commit=None, authority_id=None, actor_ref=None,
        clock=period.files.now):
    """Technical consumer check; the caller still owns release authorization."""
    need(type(expected_head) is str and SHA.fullmatch(expected_head)
        and type(base_head) is str and SHA.fullmatch(base_head) and expected_head != base_head,
        'period_publication_exact_distinct_heads_required')
    root = Path(checkout).resolve()
    _head(root, expected_head)
    retained = history.check_history(root, expected_head, base_head)
    unchanged = _unchanged_consumer(root, expected_head, base_head)
    if unchanged is not None:
        return period.sealed({'version': 2, 'kind': 'nfl.period_MY_publication_check.v2',
            'status': 'unchanged_published_MY_consumer_settlement_only', 'head': expected_head,
            'base_head': base_head, 'consumer_check_pass': True, 'new_generation': False,
            'consumer_unchanged_proven': True, 'supported_MY_yardage_consumer_semantics_verified': False,
            'historical_generation_revalidated': False, 'history_retention': retained,
            'settlement': unchanged, 'checked_utc': clock(), **FLAGS}, 'publication_check_id')
    need(all(type(v) is str and bool(v) for v in (period_generation_id, engine_commit, authority_id, actor_ref))
        and engine_checkout is not None, 'period_publication_explicit_generation_pins_required')
    period.model.digest(period_generation_id)
    trusted_names = runtime._extra_paths(ROOT)
    trusted_sources = runtime._code(ROOT, trusted_names)
    proof = replay.check_committed(checkout=root, expected_head=expected_head, base_head=base_head,
        period_generation_id=period_generation_id, engine_checkout=engine_checkout,
        engine_commit=engine_commit, authority_id=authority_id, actor_ref=actor_ref, clock=clock)
    facts = proof['source_eligibility_report']
    need(facts['frozen_weekly_eligibility_replayed'] is True,
        'period_publication_frozen_eligibility_held')
    # The earlier producer's actual reads remain unobserved. Do not turn this
    # diagnostic's policy holds or false provider/auth flags into broad proof.
    with tempfile.TemporaryDirectory(prefix='nfl-period-publish-') as temporary:
        view = replay.Snapshot(root, expected_head, temporary)
        _control_inventory(view, authority_id)
        link = view.document(CONTROL + 'generations/' + period_generation_id[7:] + '.json')
        _, docs = replay.gate._capture(link['runtime_binding']['binding']['capture'])
        pool = view.document('data/leg_pool.json')
        from scripts import my_freshness
        checked = clock()
        policy = my_freshness.verify(pool, {k: docs[k] for k in (
            'schedule', 'injuries', 'depth_chart', 'inactives', 'player_weekly',
            'player_projections', 'game_predictions')}, checked_utc=checked)
        need(type(policy) is dict and policy.get('consumer_policy_pass') is True,
            'period_publication_selected_freshness_held')
        need(policy.get('profile') == my_freshness.PROFILE,
            'period_publication_unselected_freshness_profile')
        # Check again after the policy calculation, not just at the entry of a
        # potentially expensive actual refit/replay. Git blobs are immutable;
        # the selected HEAD and creation/approval/kickoff deadlines are not.
        final_checked = clock()
        if final_checked != checked:
            policy = my_freshness.verify(pool, {k: docs[k] for k in (
                'schedule', 'injuries', 'depth_chart', 'inactives', 'player_weekly',
                'player_projections', 'game_predictions')}, checked_utc=final_checked)
            need(type(policy) is dict and policy.get('consumer_policy_pass') is True
                and policy.get('profile') == my_freshness.PROFILE,
                'period_publication_selected_freshness_held')
        app = view.document(CONTROL + 'applications/' + proof['application_id'][7:] + '.json')
        final = period.stamp(final_checked)
        need(0 <= (final - period.stamp(app['forecast_created_utc'])).total_seconds() <= 900,
            'period_return_verification_deadline')
        if app['expires_utc'] is not None:
            need(final < period.stamp(app['expires_utc']), 'period_return_approval_expired')
        need(runtime._extra_paths(ROOT) == trusted_names
            and runtime._code(ROOT, trusted_names) == trusted_sources,
            'period_publication_trusted_runtime_changed')
        need(period.files.git(engine_checkout, 'rev-parse', 'HEAD') == engine_commit,
            'period_MY_trusted_engine_changed')
        _head(root, expected_head)
    return period.sealed({'version': 2, 'kind': 'nfl.period_MY_publication_check.v2',
        'status': 'supported_committed_MY_yardage_consumer_checked', 'head': expected_head,
        'base_head': base_head, 'period_generation_id': period_generation_id,
        'consumer_check_pass': True, 'new_generation': True, 'consumer_unchanged_proven': False,
        'supported_MY_yardage_consumer_semantics_verified': True,
        'configured_owner_chain_verified': True, 'historical_generation_revalidated': False,
        'committed_MY_replay_id': proof['committed_MY_replay_id'], 'selected_freshness_policy': policy,
        'history_retention': retained, 'checked_utc': final_checked, **FLAGS}, 'publication_check_id')


def main(argv=None, *, clock=period.files.now):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ('checkout', 'expected-head', 'base-head'):
        parser.add_argument('--' + name, required=True)
    for name in ('period-generation-id', 'engine-checkout', 'engine-commit', 'authority-id', 'actor-ref'):
        parser.add_argument('--' + name)
    args = parser.parse_args(argv)
    try:
        result = check_publication(**vars(args), clock=clock)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'version': 2, 'status': 'period_MY_publication_check_refused',
            'consumer_check_pass': False, **FLAGS}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
