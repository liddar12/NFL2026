"""Build an actual local MY archive bound to an approved period application.

The original v1 loader/binding contracts and false authority flags are retained
verbatim inside a separate v2 link. This records real producer inputs/outputs,
not the still-unfinished final semantic gate or permission to publish.
"""
from scripts import build_my_cards as my
from scripts import generation_capture_runtime as runtime
from scripts import generation_semantic_gate as gate
from scripts import period_calibrator as period


def _unchanged(session):
    """Compare actual final files to original reads, except overwritten archive.

    Eligibility files are validation witnesses, NOT captured original HTTP bytes
    or the original reads of the earlier weekly producer.
    """
    capture = session.loader['capture']
    paths = runtime._input_paths(capture['season'], capture['week'])
    for name in gate.CURRENT_INPUT_NAMES:
        raw = runtime._read(runtime._relative(session.checkout, paths[name]))
        absent = session.loader['read_observations'][name]['state'] == 'absent_optional'
        period.need((raw is None) == absent and (b'null' if raw is None else raw)
            == capture['inputs'][name]['raw_utf8'].encode(), 'period_MY_original_input_changed')
    names = runtime._extra_paths(session.checkout)
    period.need(names == set(session.loader['extra_code']), 'period_MY_code_inventory_changed')
    expected = runtime._thaw_raw(session.loader['extra_code'], allow_empty=True)
    period.need(runtime._code(session.checkout, names) == expected, 'period_MY_runtime_code_changed')
    code = {name: row['raw_utf8'].encode() for name, row in capture['code'].items()}
    period.need(runtime._code(session.checkout, gate.CODE_NAMES) == code, 'period_MY_runtime_code_changed')
    outputs = session.last_binding['binding']['outputs']
    for name, entry in outputs.items():
        period.need(runtime._read(runtime._relative(session.checkout, name)) == entry['raw_utf8'].encode(),
            'period_MY_output_changed_after_writer')


def generate(control, *, generation_sha, capture_dir):
    """Explicit local generation; no automatic owner approval, push or network.

    Capture files remain in a separately configured private directory, including
    failures. The complete source/binding is also retained with the v2 link on
    success, so final-tree checking cannot depend on that scratch path.
    """
    period.need(type(control) is period.PeriodCalibrator, 'period_MY_configured_operator_required')
    checkout = control.data.parent
    period.need(control.data == checkout / 'data', 'period_MY_checkout_data_required')
    capture_dir = runtime._output_root(capture_dir, checkout)
    runtime._output_root(capture_dir, control.engine_checkout)
    session = runtime.begin(checkout, generation_sha=generation_sha, clock=control.clock)
    runtime.persist(session.loader, capture_dir, checkout=checkout)
    pool, application = control.apply_and_save(capture_runtime=session, capture_out_dir=capture_dir)
    period.need(session.last_checkpoint is not None, 'period_MY_writer_checkpoint_missing')
    # The actual MY producer consumes the captured pool/schedule/calibration and
    # original archive preimage, records the receipt journal BEFORE display
    # dedupe, and passes its exact archive writer buffer to the original loader.
    archive, changed = my.run(pool_path=str(control.data / 'leg_pool.json'),
        schedule_path=str(control.data / 'schedule_full.json'),
        calibration_path=str(control.data / 'parlay_backtest.json'),
        out_dir=str(control.data / 'my_cards'), snapshot_dir=str(control.data / 'snapshots'),
        capture_runtime=session, capture_out_dir=capture_dir)
    period.need(archive is not None and session.last_binding is not None, 'period_MY_binding_missing')
    _unchanged(session)
    replay = control.reverify()
    period.need(replay['application_id'] == application['application_id'], 'period_MY_application_changed')
    binding = session.last_binding
    period.need(binding['binding']['generated_utc_claim'] == application['forecast_created_utc']
        and gate.fingerprint(gate._json(session.pool_bytes)) == application['pool_id'],
        'period_MY_application_pool_mismatch')
    value = period.sealed({'version': 2, 'kind': 'nfl.period_MY_generation.v2',
        'application_id': application['application_id'], 'pool_id': application['pool_id'],
        'owner_head_event_id': application['owner_head_event_id'],
        'runtime_binding': binding, 'recorded_utc': control.clock(),
        'MY_card_semantics_verified': False, 'owner_authenticated': False,
        'publication_authorized': False, 'production_authorized': False,
        'public_serving_verified': False}, 'period_generation_id')
    # Do one last source/current/owner check just before the immutable link.
    with control.journal.lock(period.NS):
        _unchanged(session)
        period.need(control.current()[1]['application_id'] == application['application_id']
            and control.journal.read_owner_intents(period.NS)['head_event_id'] == application['owner_head_event_id'],
            'period_MY_owner_or_current_changed')
        control._immutable('generations', value, value['period_generation_id'])
    return {'status': 'local_MY_generation_bound_not_publication_verified',
        'period_generation_id': value['period_generation_id'], 'application_id': application['application_id'],
        'pool_id': application['pool_id'], 'runtime_binding_id': binding['runtime_binding_id'],
        'target_generation_id': binding['binding']['target_generation_id'], 'archive_changed': changed,
        'archive_cards': len(archive['cards']), 'MY_card_semantics_verified': False,
        'owner_authenticated': False, 'publication_authorized': False,
        'production_authorized': False, 'public_serving_verified': False}
