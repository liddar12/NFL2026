"""Exact selected-incumbent MY consumer checks, without adopting a model.

The original v1 loader/binding and false authority claims remain unchanged.
This separate gate replays the actual incumbent pool equation with the selected
source policy, original journal/offers and first-sight archive. It never imports
the shared engine, creates owner intent, proves earlier upstream reads or
authorizes a deployment. No period-return control may enter this baseline path.
"""
import argparse
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import build_leg_pool
from scripts import generation_capture_runtime as runtime
from scripts import generation_semantic_gate as gate
from scripts import learning_history_guard as history
from scripts import my_freshness
from scripts import period_my_generation as downstream
from scripts import period_publication_gate as publication
from scripts import period_source_eligibility as source_facts
from scripts import selected_legacy_bootstrap as bootstrap

FLAGS = {**publication.FLAGS, 'model_approval_recorded': False,
    'model_adoption': False, 'engine_used': False}


def _head(root, expected):
    publication._head(root, expected)


def _no_control(root, tracked):
    gate.need(not any(p == 'data/learning_control' or p.startswith('data/learning_control/') for p in tracked)
        and not (root / 'data/learning_control').exists() and not (root / 'data/learning_control').is_symlink(),
        'selected_MY_baseline_control_records_present')


def _pool_at(root, head):
    tracked = runtime._head_tree(root, head)
    path = 'data/leg_pool.json'
    if path not in tracked:
        return None
    return gate._json(runtime._head_blobs(root, head, tracked, {path})[path])


def _selected(pool):
    return type(pool) is dict and 'freshness_policy' in pool


def unchanged_or_not_applicable(*, checkout, expected_head, base_head, clock=runtime._utc):
    """Default-path protection for an already published selected incumbent.

    Ordinary legacy trees retain their existing gates. A selected incumbent may
    only be settled with every consumer/source/authority byte unchanged; an
    unpinned new pool cannot remove the policy and masquerade as a legacy tree.
    """
    root = Path(checkout).resolve()
    gate.need(publication.SHA.fullmatch(expected_head or '') and publication.SHA.fullmatch(base_head or '')
        and expected_head != base_head, 'selected_MY_exact_distinct_heads_required')
    _head(root, expected_head)
    before, after = _pool_at(root, base_head), _pool_at(root, expected_head)
    if not (_selected(before) or _selected(after)):
        _head(root, expected_head)
        return gate._seal({'version': 1, 'kind': 'nfl.selected_incumbent_MY_publication.v1',
            'status': 'not_applicable_legacy_pool_without_selected_policy', 'head': expected_head,
            'base_head': base_head, 'consumer_check_pass': False, 'not_applicable': True,
            'new_generation': False, 'checked_utc': clock(), **FLAGS}, 'publication_check_id')
    _no_control(root, runtime._head_tree(root, expected_head))
    retained = history.check_history(root, expected_head, base_head)
    unchanged = publication._unchanged_consumer(root, expected_head, base_head, require_control=False)
    gate.need(unchanged is not None, 'selected_MY_original_binding_required')
    _head(root, expected_head)
    return gate._seal({'version': 1, 'kind': 'nfl.selected_incumbent_MY_publication.v1',
        'status': 'unchanged_selected_incumbent_MY_settlement_only', 'head': expected_head,
        'base_head': base_head, 'consumer_check_pass': True, 'not_applicable': False,
        'new_generation': False, 'consumer_unchanged_proven': True,
        'supported_MY_yardage_consumer_semantics_verified': False,
        'historical_generation_revalidated': False, 'history_retention': retained,
        'settlement': unchanged, 'checked_utc': clock(), **FLAGS}, 'publication_check_id')


def _final_time(pool, docs, offered_games, checked):
    final, generated = gate._time(checked), gate._time(pool['generated_utc'])
    gate.need(0 <= (final - generated).total_seconds() <= 900, 'selected_MY_verification_deadline')
    games = {g['game_id']: g for g in docs['schedule']['games']}
    gate.need(all(gid in games and games[gid].get('status') == 'STATUS_SCHEDULED'
        and final < gate._time(games[gid].get('kickoff_utc')) for gid in offered_games),
        'selected_MY_offered_event_started')


def check_selected(value, *, checkout, expected_head, base_head, clock=runtime._utc):
    """Recompute one exact final Git tree from a trusted private original binding."""
    root = runtime._checkout(checkout)
    gate.need(publication.SHA.fullmatch(expected_head or '') and publication.SHA.fullmatch(base_head or '')
        and expected_head != base_head, 'selected_MY_exact_distinct_heads_required')
    _head(root, expected_head)
    retained = history.check_history(root, expected_head, base_head)
    value, legacy_proof, retained_unknown = bootstrap.verify(value, checkout=root,
        expected_head=expected_head, base_head=base_head)
    value, loader = runtime._runtime_binding(value)
    capture, docs = gate._capture(loader['capture'])
    tracked = runtime._head_tree(root, expected_head)
    _no_control(root, tracked)
    names = runtime._extra_paths(ROOT)
    selected = {p for p in tracked if runtime._extra_path(p)} | set(runtime.EXTRA_FIXED)
    gate.need(selected == names == set(loader['extra_code']), 'selected_MY_dependency_inventory_changed')
    trusted = runtime._code(ROOT, names)
    gate._same(runtime._freeze_raw(trusted), loader['extra_code'], 'selected_MY_trusted_runtime_changed')
    paths = runtime._input_paths(capture['season'], capture['week'])
    wanted = names | gate.CODE_NAMES | set(gate._paths(capture)) | {paths[k] for k in gate.CURRENT_INPUT_NAMES}
    blobs = runtime._head_blobs(root, expected_head, tracked, wanted.intersection(tracked))
    for path, raw in trusted.items():
        gate.need(blobs.get(path) == raw, 'selected_MY_committed_runtime_changed')
    for name in gate.CURRENT_INPUT_NAMES:
        raw = blobs.get(paths[name])
        absent = loader['read_observations'][name]['state'] == 'absent_optional'
        gate.need((raw is None) == absent and (b'null' if raw is None else raw)
            == capture['inputs'][name]['raw_utf8'].encode(), 'selected_MY_committed_input_changed')
    for path, entry in value['binding']['outputs'].items():
        gate.need(blobs.get(path) == entry['raw_utf8'].encode(), 'selected_MY_committed_output_changed')
    graph = gate.sem._graph(value['binding']['graph'])
    graph_documents = {}
    for row in graph['generations']:
        document = row['request']['payload'];generation = document['generations'][0]
        path = 'data/snapshots/learning_journal/%d_wk%02d/%s.json' % (
            generation['season'], generation['week'], generation['generation_id'][7:])
        gate.need(path not in graph_documents or graph_documents[path] == document,
            'selected_MY_ambiguous_journal_path')
        graph_documents[path] = document
    for row in graph['source_objects']:
        graph_documents['data/snapshots/learning_sources/' + row['object_id'][7:] + '.json'] = row['payload']
    gate.need(set(graph_documents) <= set(tracked), 'selected_MY_committed_journal_or_source_missing')
    graph_raw = runtime._head_blobs(root, expected_head, tracked, set(graph_documents))
    for path, document in graph_documents.items():
        gate._same(gate._json(graph_raw[path]), document, 'selected_MY_committed_journal_or_source_changed')
    pool = gate._json(blobs['data/leg_pool.json'])
    gate.need(pool.get('calibration_return') is None and type(pool.get('freshness_policy')) is dict
        and pool['freshness_policy'].get('profile') == my_freshness.PROFILE,
        'selected_MY_baseline_selected_policy_required')
    gate.need((pool.get('season'), pool.get('week')) == (capture['season'], capture['week'])
        and value['binding']['generated_utc_claim'] == pool.get('generated_utc'),
        'selected_MY_pool_period_or_clock_changed')
    gate.need(gate._time(value['binding']['bound_utc_claim']) <= gate._time(clock()),
        'selected_MY_check_before_binding')
    claim = capture['generation_sha_claim']
    gate.need(type(claim) is str and re.fullmatch(r'[0-9a-f]{40}', claim), 'selected_MY_exact_source_commit_required')
    runtime._git(root, ['merge-base', '--is-ancestor', claim, expected_head], limit=128)
    # Pure, actual incumbent producer with the same selected sources. The trusted
    # session's generated clock is the original pool clock, not the replay clock.
    session = runtime.GenerationCapture(root, loader, clock=lambda: pool['generated_utc'])
    session.generated_utc = pool['generated_utc']
    inputs = session.pool_inputs(freshness_profile=my_freshness.PROFILE)
    gate.need(type(inputs.get('pool_backtest')) is dict
        and (inputs['pool_backtest'].get('verdict') or {}).get('adopt') is True,
        'selected_MY_incumbent_base_gate_held')
    rebuilt = build_leg_pool.build(inputs)
    gate._same(rebuilt, pool, 'selected_MY_incumbent_pool_not_reproduced')
    result = downstream.replay_binding(value, pool_writer='legacy_pretty', retained_unknown=retained_unknown)
    # Check the full current offered card population, not retained first-sight
    # archive rows, which may intentionally be older display vintages.
    offered, _ = downstream.my.offered_cards(pool, docs['schedule']['games'],
        downstream.my._correlation_table(docs['parlay_calibration']), pool['generated_utc'])
    offered_games = {str(leg.get('game_id')) for _, _, _, card in offered for leg in card['legs']}
    checked = clock()
    _final_time(pool, docs, offered_games, checked)
    facts = source_facts.verify(capture, pool, checked_utc=checked)
    gate.need(facts['frozen_weekly_eligibility_replayed'] is True
        and set(facts['reason_codes']) <= {'undefined_depth_freshness_policy',
            'undefined_inactive_freshness_or_applicability'}, 'selected_MY_frozen_eligibility_held')
    policy = my_freshness.verify(pool, {k: docs[k] for k in my_freshness.SOURCE_NAMES}, checked_utc=checked)
    gate.need(policy.get('consumer_policy_pass') is True, 'selected_MY_serving_freshness_held')
    final_checked = clock()
    _final_time(pool, docs, offered_games, final_checked)
    if final_checked != checked:
        policy = my_freshness.verify(pool, {k: docs[k] for k in my_freshness.SOURCE_NAMES}, checked_utc=final_checked)
        gate.need(policy.get('consumer_policy_pass') is True, 'selected_MY_serving_freshness_held')
    gate.need(runtime._extra_paths(ROOT) == names and runtime._code(ROOT, names) == trusted,
        'selected_MY_trusted_runtime_changed')
    _no_control(root, runtime._head_tree(root, expected_head))
    _head(root, expected_head)
    return gate._seal({'version': 1, 'kind': 'nfl.selected_incumbent_MY_publication.v1',
        'status': 'selected_incumbent_MY_consumer_replayed', 'head': expected_head, 'base_head': base_head,
        'consumer_check_pass': True, 'not_applicable': False, 'new_generation': True,
        'supported_MY_yardage_consumer_semantics_verified': True,
        'runtime_binding_id': value['runtime_binding_id'], 'capture_id': capture['capture_id'],
        'downstream_replay_id': result['downstream_replay_id'], 'source_eligibility_report': facts,
        'retained_legacy_scope': None if legacy_proof is None else {
            'bootstrap_proof_id': legacy_proof['bootstrap_proof_id'],
            'unverified_receipt_ids': len(legacy_proof['unverified_receipt_ids']),
            'unverified_locations': len(legacy_proof['unverified_locations']),
            'legacy_history_verified': False, 'legacy_training_eligible': False},
        'selected_freshness_policy': policy, 'history_retention': retained,
        'checked_utc': final_checked, **FLAGS}, 'publication_check_id')


def main(argv=None, *, clock=runtime._utc):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ('checkout', 'expected-head', 'base-head'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--binding')
    args = parser.parse_args(argv)
    try:
        options = {'checkout': args.checkout, 'expected_head': args.expected_head,
            'base_head': args.base_head, 'clock': clock}
        result = (check_selected(bootstrap.read_artifact(args.binding, checkout=args.checkout), **options)
            if args.binding is not None else unchanged_or_not_applicable(**options))
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'version': 1, 'status': 'selected_MY_publication_refused',
            'consumer_check_pass': False, **FLAGS}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
