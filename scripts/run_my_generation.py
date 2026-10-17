#!/usr/bin/env python3
"""Opt-in MY generation under existing intent; never prepare or approve a model.

No intent keeps the existing legacy calibration policy, while explicitly applying
the selected MY freshness policy. Existing intent must survive the actual period
consumer's checks; its failure never becomes an unlabeled incumbent fallback.
Outputs are local generation/capture identities, not publication permission.
"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FLAGS = {'model_approval_recorded': False, 'owner_authenticated': False,
    'publication_authorized': False, 'production_authorized': False,
    'public_serving_verified': False, 'accuracy_improvement_verified': False}


def _owner_heads(data):
    from scripts import period_calibrator as period
    return period.files.export._delivery_path(data, 'learning_control', 'owner', 'heads')


def _period_claim(pool):
    """Match the UI's known-period markers, not ordinary legacy coefficients."""
    from scripts import learning_receipts
    if 'calibration_return' in pool or str(pool.get('live_adjustment_status') or '').startswith('period return v2:'):
        return True
    players = pool.get('players')
    for player in players if type(players) is list else []:
        if type(player) is not dict or player.get('market') not in learning_receipts.PROP_MARKETS:
            continue
        rungs = player.get('rungs')
        for rung in rungs if type(rungs) is list else []:
            receipt = rung.get('learning_receipt') if type(rung) is dict else None
            context = receipt.get('input_context') if type(receipt) is dict else None
            if type(context) is dict and 'calibration_return' in context:
                return True
    return False


def _no_intent(data):
    """Missing configured intent must not hide a prior or foreign application."""
    from scripts import period_calibrator as period
    path = lambda name: period.files.export._delivery_path(data, 'learning_control', name)
    period.need(not path('current.json').exists()
        and not path('pending.json').exists(), 'MY_generation_orphan_application')
    heads = _owner_heads(data)
    period.need(not heads.exists() or not any(heads.iterdir()), 'MY_generation_unmatched_owner_scope')
    current = data / 'leg_pool.json'
    if current.exists():
        pool = period.files.read_json(current)
        period.need(type(pool) is dict and not _period_claim(pool),
            'MY_generation_orphan_application')


def _legacy(control, *, generation_sha, capture_dir):
    """Actual existing pool equation + MY writer, with original-byte capture."""
    from scripts import build_leg_pool as pool_builder, build_my_cards as my
    from scripts import generation_capture_runtime as runtime, period_calibrator as period
    from scripts import selected_legacy_bootstrap as bootstrap
    _no_intent(control.data)
    session = runtime.begin(control.data.parent, generation_sha=generation_sha, clock=control.clock)
    runtime.persist(session.loader, capture_dir, checkout=session.checkout)
    session = bootstrap.select_referenced(session)
    inputs = pool_builder.load_inputs(session, freshness_profile=control.freshness_profile)
    pool = pool_builder.build(inputs)
    period.need(pool['calibration_adopted'] is True, 'MY_generation_base_gate_held')
    _no_intent(control.data)
    # Same writer encoding as build_leg_pool.main, not a separate pricing path.
    raw = (json.dumps(pool, ensure_ascii=True, indent=2) + '\n').encode('utf-8')
    output = runtime._relative(session.checkout, 'data/leg_pool.json')
    with output.open('wb') as stream:
        stream.write(raw)
    runtime.persist(session.record_pool_bytes(raw), capture_dir, checkout=session.checkout)
    archive, changed = my.run(pool_path=str(output),
        schedule_path=str(control.data / 'schedule_full.json'),
        calibration_path=str(control.data / 'parlay_backtest.json'),
        out_dir=str(control.data / 'my_cards'), snapshot_dir=str(control.data / 'snapshots'),
        capture_runtime=session, capture_out_dir=capture_dir)
    period.need(archive is not None and session.last_binding is not None, 'MY_generation_binding_missing')
    _no_intent(control.data)
    return {'archive_changed': changed, 'archive_cards': len(archive['cards']),
        'period_generation_id': None, 'application_id': None, 'owner_head_event_id': None}, bootstrap.wrap(session.last_binding, session)


def run(*, data_dir, engine_checkout, engine_commit, authority_id, actor_ref,
        capture_dir, generation_sha, freshness_profile, clock=None):
    """Explicit configured invocation; no candidate construction or approval."""
    from scripts import generation_capture_runtime as runtime, period_calibrator as period
    from scripts import period_my_generation as period_my, my_freshness
    period.need(freshness_profile == my_freshness.PROFILE, 'MY_generation_selected_profile_required')
    period.need(type(generation_sha) is str and re.fullmatch(r'[0-9a-f]{40}', generation_sha),
        'MY_generation_exact_source_commit_required')
    period.need(type(engine_commit) is str and re.fullmatch(r'[0-9a-f]{40}', engine_commit),
        'MY_generation_exact_engine_commit_required')
    period.model.digest(authority_id);period.model.text(actor_ref)
    data = period.files.selected(data_dir);checkout = data.parent
    period.need(data == checkout / 'data', 'MY_generation_checkout_data_required')
    period.need(runtime.head_identity(checkout) == generation_sha, 'MY_generation_source_commit_mismatch')
    private = runtime._output_root(capture_dir, checkout)
    engine_path = period.files.selected(engine_checkout)
    runtime._output_root(private, engine_path)
    selected_clock = period.files.now if clock is None else clock
    period.need(callable(selected_clock), 'MY_generation_clock_required')
    heads = _owner_heads(data)
    engine_used = heads.exists() and any(heads.iterdir())
    action = None
    if engine_used:
        control = period.PeriodCalibrator(data_dir=data, engine_checkout=engine_path,
            engine_commit=engine_commit, authority_id=authority_id, actor_ref=actor_ref,
            freshness_profile=freshness_profile, clock=selected_clock)
        head = control.journal.read_owner_intents(period.NS)
        period.need(head['events'] and head['head_event_id'] is not None, 'MY_generation_unmatched_owner_scope')
        action = head['events'][-1]['command']['action']
        result = period_my.generate(control, generation_sha=generation_sha, capture_dir=private)
        identity = result['period_generation_id'];period.model.digest(identity)
        link = period.files.read_json(control.path('generations', identity[7:] + '.json'))
        period.need(link['period_generation_id'] == identity
            and period.lr.fingerprint({k: v for k, v in link.items() if k != 'period_generation_id'}) == identity
            and link['application_id'] == result['application_id']
            and link['owner_head_event_id'] == head['head_event_id'], 'MY_generation_link_changed')
        period.need(control.journal.read_owner_intents(period.NS)['head_event_id'] == head['head_event_id'],
            'MY_generation_owner_changed')
        binding = link['runtime_binding']
        result = {key: result[key] for key in ('archive_changed', 'archive_cards',
            'period_generation_id', 'application_id')}
        result['owner_head_event_id'] = head['head_event_id']
        route = 'existing_explicit_owner_intent'
    else:
        # No journal or shared-code constructor/import is necessary just to
        # retain the legacy policy. A disabled measurement pilot can still refresh
        # eligible MY props under the selected source-only freshness policy.
        control = SimpleNamespace(data=data, freshness_profile=freshness_profile, clock=selected_clock)
        result, binding = _legacy(control, generation_sha=generation_sha, capture_dir=private)
        route = 'incumbent_no_owner_intent'
    if engine_used:
        period.need(control.engine_identity() == control.engine_code
            and period.files.git(control.engine_checkout, 'rev-parse', 'HEAD') == engine_commit,
            'MY_generation_engine_changed')
    period.need(runtime.head_identity(checkout) == generation_sha, 'MY_generation_source_commit_mismatch')
    from scripts import selected_legacy_bootstrap as bootstrap
    inner_binding, _ = bootstrap.unwrap(binding)
    # Reuse the original immutable artifact. Return only its basename, never a
    # caller path, token or private evidence body in the workflow JSON protocol.
    binding_path = runtime.persist(binding, private, checkout=checkout)
    if route == 'incumbent_no_owner_intent':
        _no_intent(data)
    else:
        period.need(control.journal.read_owner_intents(period.NS)['head_event_id'] == head['head_event_id'],
            'MY_generation_owner_changed')
    return {'version': 1, 'kind': 'nfl.MY_generation_run.v1',
        'status': 'local_MY_generated_not_published', 'route': route,
        'generation_sha': generation_sha,
        'engine_used': bool(engine_used), 'engine_commit_verified': bool(engine_used),
        'freshness_profile': freshness_profile, 'owner_intent_action': action,
        'runtime_binding_id': inner_binding['runtime_binding_id'],
        'target_generation_id': inner_binding['binding']['target_generation_id'],
        'binding_artifact_name': binding_path.name, **result, **FLAGS}


def main(argv=None, *, clock=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    for name in ('data-dir', 'engine-checkout', 'engine-commit', 'authority-id',
                 'actor-ref', 'capture-dir', 'generation-sha', 'freshness-profile'):
        parser.add_argument('--' + name)
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({'version': 1, 'status': 'disabled_dry_run',
            'writes': False, 'network_used': False, **FLAGS}, sort_keys=True))
        return 0
    try:
        options = {key: value for key, value in vars(args).items() if key != 'execute'}
        if any(value is None for value in options.values()):
            raise ValueError('MY_generation_explicit_configuration_required')
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = run(**options, clock=clock)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    except Exception:
        print(json.dumps({'version': 1, 'status': 'local_MY_generation_refused',
            'success_acknowledged': False, 'local_writes_may_have_occurred': True,
            **FLAGS}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
