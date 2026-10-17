"""Replay the exact committed MY application, original reads and actual outputs.

This composes bounded Git materialization, current period authority, append-only
history and real downstream producer replay. It is NOT the still separate
upstream eligibility/confirmed-inactives gate, owner authentication or release
authorization. No code from a supplied commit is executed and no source, index,
remote, model approval or publisher behavior is changed.
"""
import hashlib
from pathlib import Path
import tempfile

from scripts import generation_capture_runtime as runtime
from scripts import generation_semantic_gate as gate
from scripts import learning_history_guard as history
from scripts import period_calibrator as period
from scripts import period_commit_replay as committed
from scripts import period_my_generation as my
from scripts import period_source_eligibility as source_eligibility

ROOT = Path(__file__).resolve().parent.parent
LINK_KEYS = {'version', 'kind', 'application_id', 'pool_id', 'owner_head_event_id',
    'runtime_binding', 'downstream_replay', 'recorded_utc', 'MY_card_semantics_verified',
    'owner_authenticated', 'publication_authorized', 'production_authorized',
    'public_serving_verified', 'period_generation_id'}
FALSE_FLAGS = ('MY_card_semantics_verified', 'owner_authenticated',
    'publication_authorized', 'production_authorized', 'public_serving_verified')


class Snapshot(committed.Snapshot):
    # Include all producer/browser dependencies. Materialization keeps the same
    # regular-mode, exact blob, file/count/total/deadline bounds as application
    # replay. Data files are not reduced to the subset mentioned in the link.
    prefixes = tuple(sorted(set(committed.Snapshot.prefixes) | {'app/'} | runtime.EXTRA_FIXED))


def _base_document(view, base, path):
    """Read a small exact-base pointer, never the current working counterpart."""
    raw = view.git(['ls-tree', '-r', '-l', '-z', base, '--', path], 2048)
    if not raw:
        return None
    row, = raw.rstrip(b'\0').split(b'\0')
    metadata, name = row.split(b'\t', 1)
    mode, kind, oid, size = metadata.split()
    period.need(name.decode() == path and mode in (b'100644', b'100755') and kind == b'blob'
        and size.isdigit() and 0 < int(size) <= 4096, 'period_MY_base_pointer_invalid')
    body = view.git(['cat-file', 'blob', oid.decode()], int(size))
    period.need(len(body) == int(size) and hashlib.sha1(
        b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest() == oid.decode(),
        'period_MY_base_pointer_invalid')
    return gate._json(body)


def _retained_authority(view, base, control, application):
    """Mutable pointers must advance their actual base chains, never fork/rewind.

    Keeping immutable files alone does not establish that a new pointer still
    descends from them. This check covers the configured namespace; other
    namespaces are not implicitly authenticated by it.
    """
    chain = control.journal.read_owner_intents(period.NS)
    name = control.journal._head_path(period.NS).relative_to(control.data.parent).as_posix()
    old = _base_document(view, base, name)
    if old is not None:
        period.need(set(old) == set(control.journal._head(period.NS))
            and type(old.get('version')) is int and old['version'] == 1
            and old.get('kind') == 'selflearn.file_owner_head.v1'
            and old.get('authority_id') == control.authority_id and old.get('namespace') == period.NS
            and old.get('pointer_id') == period.lr.fingerprint({k: v for k, v in old.items() if k != 'pointer_id'})
            and type(old.get('head_sequence')) is int and 1 <= old['head_sequence'] <= len(chain['events'])
            and chain['events'][old['head_sequence'] - 1]['event_id'] == old.get('head_event_id'),
            'period_MY_owner_history_not_descendant')
    old = _base_document(view, base, 'data/learning_control/current.json')
    if old is not None:
        control._pointer(old)
        cursor = application
        for _ in range(256):
            if cursor['application_id'] == old['application_id']:
                break
            parent = cursor['previous_application_id']
            period.need(parent is not None, 'period_MY_application_history_not_descendant')
            previous = control._application(parent)
            period.need(previous['pool_id'] == cursor['previous_pool_id'], 'period_MY_application_history_not_descendant')
            cursor = previous
        else:
            period.need(False, 'period_MY_application_history_limit')
    return chain


def _final_time(control, application, capture, checked):
    """Reapply existing period deadlines after the downstream replay, not before."""
    final = period.stamp(checked)
    created = period.stamp(application['forecast_created_utc'])
    period.need(0 <= (final - created).total_seconds() <= 900, 'period_return_verification_deadline')
    if application['expires_utc'] is not None:
        period.need(final < period.stamp(application['expires_utc']), 'period_return_approval_expired')
    for name in ('player_weekly', 'player_projections', 'game_predictions', 'schedule'):
        document = gate._document(capture['inputs'][name]['raw_utf8'], name)
        stamp = period.stamp(document.get('generated_utc') or document.get('updated_utc'))
        period.need(0 <= (final - stamp).total_seconds() <= 12 * 3600, 'period_return_source_stale')
    schedule = gate._json(capture['inputs']['schedule']['raw_utf8'])
    games = {game['game_id']: game for game in schedule['games']}
    period.need(all(final < period.stamp(games[gid]['kickoff_utc'])
        for gid in application['eligible_game_ids']), 'period_return_event_started')
    if application['action'] != 'revoke':
        package = control.journal.get_object(application['evidence_object_id'])['payload']
        fit = period.stamp(package['evaluation']['report']['candidate']['fit_as_of_utc'])
        period.need(fit <= final and (final - fit).total_seconds() <= 7 * 86400, 'period_return_candidate_stale')


def check_committed(*, checkout, expected_head, base_head, period_generation_id,
        engine_checkout, engine_commit, authority_id, actor_ref, clock=period.files.now):
    """Read/replay one selected committed generation; never accept an uploaded PASS.

    The publisher must supply a freshly fetched base and pin/recheck HEAD on
    every attempt. A successful result proves this narrower replay, NOT that
    sources are complete/current, an owner is authenticated, or a site is live.
    """
    period.model.digest(period_generation_id)
    retained = history.check_history(checkout, expected_head, base_head)
    with tempfile.TemporaryDirectory(prefix='nfl-period-MY-tree-') as temporary:
        view = Snapshot(checkout, expected_head, temporary)
        names = runtime._extra_paths(ROOT)
        selected = {p for p in view.tree if runtime._extra_path(p)}
        period.need(set(names) == selected, 'period_MY_committed_code_inventory_changed')
        sources = runtime._code(ROOT, names)
        view.materialize()
        root = Path(temporary)
        period.need(all((root / name).read_bytes() == raw for name, raw in sources.items()),
            'period_MY_committed_runtime_or_browser_changed')
        # PeriodCalibrator reads the configured trusted exclusions, not a
        # callback supplied by the commit. Bind that policy file explicitly.
        exclusions = runtime._read(ROOT / 'config/excluded_games.json')
        period.need(view.copy('config/excluded_games.json').read_bytes() == exclusions,
            'period_MY_committed_exclusions_changed')
        control = period.PeriodCalibrator(data_dir=root / 'data', engine_checkout=engine_checkout,
            engine_commit=engine_commit, authority_id=authority_id, actor_ref=actor_ref, clock=clock)
        _, application, pool = control.current()
        period.need(application is not None, 'period_return_application_missing')
        link = view.document('data/learning_control/generations/' + period_generation_id[7:] + '.json')
        period.need(type(link) is dict and set(link) == LINK_KEYS and type(link['version']) is int
            and link['version'] == 2 and link['kind'] == 'nfl.period_MY_generation.v2'
            and all(link[key] is False for key in FALSE_FLAGS)
            and link['period_generation_id'] == period_generation_id
            and period.lr.fingerprint({k: v for k, v in link.items() if k != 'period_generation_id'})
                == period_generation_id, 'period_MY_committed_link_invalid')
        period.need(link['application_id'] == application['application_id']
            and link['pool_id'] == application['pool_id'] == period.lr.fingerprint(pool)
            and link['owner_head_event_id'] == application['owner_head_event_id'],
            'period_MY_committed_application_mismatch')
        binding, loader = runtime._runtime_binding(link['runtime_binding'])
        capture = loader['capture']
        period.need(capture['season'] == pool['season'] and capture['week'] == pool['week']
            and binding['binding']['generated_utc_claim'] == application['forecast_created_utc']
            and period.stamp(binding['binding']['bound_utc_claim']) <= period.stamp(link['recorded_utc'])
            <= period.stamp(clock()), 'period_MY_committed_clock_or_period_mismatch')
        session = runtime.GenerationCapture(root, loader, clock=clock)
        session.last_binding = binding
        my._unchanged(session)
        chain = _retained_authority(view, base_head, control, application)
        _final_time(control, application, capture, clock())
        graph = gate.sem._graph(binding['binding']['graph'])
        for row in graph['generations']:
            doc = row['request']['payload']; gen = doc['generations'][0]
            path = 'data/snapshots/learning_journal/%d_wk%02d/%s.json' % (
                gen['season'], gen['week'], gen['generation_id'][7:])
            gate._same(view.document(path), doc, 'period_MY_committed_journal_changed')
        for row in graph['source_objects']:
            gate._same(view.document('data/snapshots/learning_sources/' + row['object_id'][7:] + '.json'),
                row['payload'], 'period_MY_committed_source_changed')
        downstream = my.replay_binding(binding)
        gate._same(link['downstream_replay'], downstream, 'period_MY_committed_downstream_report_changed')
        # Reject cheap byte/history/link faults before spending work on a real
        # frozen refit. Success still requires that full independent replay.
        replay = control.reverify()
        period.need(replay['application_id'] == application['application_id'], 'period_MY_committed_application_mismatch')
        checked = clock()
        _final_time(control, application, capture, checked)
        # This diagnostic is attached, not promoted into the narrower replay's
        # success. Undefined QB/inactive freshness and missing original source
        # facts still prevent a final semantic publication PASS.
        eligibility = source_eligibility.verify(capture, pool, checked_utc=checked)
        # Exact Git blobs are immutable, but the selected HEAD and trusted local
        # executing sources/engine must still be the same at the final boundary.
        period.need(runtime._extra_paths(ROOT) == names and runtime._code(ROOT, names) == sources
            and runtime._read(ROOT / 'config/excluded_games.json') == exclusions,
            'period_MY_trusted_runtime_changed')
        period.need(control.engine_identity() == control.engine_code
            and period.files.git(control.engine_checkout, 'rev-parse', 'HEAD') == engine_commit,
            'period_MY_trusted_engine_changed')
        period.need(chain['head_event_id'] == application['owner_head_event_id'], 'period_MY_owner_changed')
        period.need(view.git(['rev-parse', 'HEAD'], 128).strip().decode() == expected_head,
            'period_MY_committed_head_changed')
        return period.sealed({'version': 2, 'kind': 'nfl.period_committed_MY_replay.v2',
            'status': 'committed_application_originals_offers_journal_archive_replayed',
            'head': expected_head, 'base_head': base_head, 'period_generation_id': period_generation_id,
            'checked_utc': checked,
            'application_id': application['application_id'], 'owner_head_event_id': chain['head_event_id'],
            'downstream_replay_id': downstream['downstream_replay_id'],
            'history_retention': retained, 'files': len(view.files), 'bytes': view.total,
            'source_eligibility_report': eligibility,
            'committed_data_tree_verified': True, 'original_bytes_and_outputs_verified': True,
            'configured_owner_chain_verified': True, 'upstream_eligibility_verified': False,
            'MY_card_semantics_verified': False, 'whole_release_pass': False,
            'source_writes': False, 'temporary_files_written': True, 'network_used': False,
            'owner_authenticated': False, 'publication_authorized': False,
            'public_serving_verified': False, 'production_authorized': False}, 'committed_MY_replay_id')
