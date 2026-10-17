"""Build an actual local MY archive bound to an approved period application.

The original v1 loader/binding contracts and false authority flags are retained
verbatim inside a separate v2 link. This records real producer inputs/outputs,
not the still-unfinished final semantic gate or permission to publish.
"""
from scripts import build_my_cards as my
from scripts import generation_capture_runtime as runtime
from scripts import generation_semantic_gate as gate
from scripts import period_calibrator as period
from scripts import learning_journal as journal


def replay_binding(value, *, pool_writer='period_canonical'):
    """Replay actual offers, journal population and first-sight archive append.

    Runs the trusted local producer over the explicit original inputs. Source
    code/owner/current/eligibility/freshness authority are SEPARATE checks, not
    inferred from this result. No sporting files are discovered or written;
    existing producer policy stamping introspects its trusted local code.
    """
    period.need(pool_writer in ('period_canonical', 'legacy_pretty'), 'period_MY_unknown_pool_writer')
    value, loader = runtime._runtime_binding(value)
    bound = value['binding'];capture, docs = gate._capture(loader['capture'])
    outputs = gate._thaw(bound['outputs'], gate._paths(capture), documents=True)
    expected = gate.bind_generation(capture, bound['graph'], outputs,
        target_generation_id=bound['target_generation_id'], generated_utc=bound['generated_utc_claim'],
        bound_utc=bound['bound_utc_claim'])
    gate._same(bound, expected, 'period_MY_generation_binding_changed')
    pool = gate._json(outputs['data/leg_pool.json'])
    path = 'data/my_cards/%d_wk%02d.json' % (capture['season'], capture['week'])
    archive = gate._document(outputs[path], path)
    period.need(pool.get('season') == capture['season'] and pool.get('week') == capture['week']
        and pool.get('generated_utc') == bound['generated_utc_claim'], 'period_MY_pool_period_mismatch')
    period.need(type(pool.get('players')) is list and len(pool['players']) <= 2000
        and sum(len(p.get('rungs') or []) for p in pool['players']) <= gate.MAX_ROWS,
        'period_MY_candidate_work_limit')
    teams = [s for s in my.seed_options(pool) if s.get('kind') == my.SEED_KIND]
    period.need(len(teams) <= 32, 'period_MY_seed_work_limit')
    games, calibration = docs['schedule']['games'], docs['parlay_calibration']
    offered, n_seeds = my.offered_cards(pool, games, my._correlation_table(calibration), pool['generated_utc'])
    records = [my.card_record(dial, seed, rank, card, my.kickoff_index(games)) for dial, seed, rank, card in offered]
    period.need(len(records) <= 960, 'period_MY_card_work_limit')
    graph = gate.sem._graph(bound['graph'])
    targets = [e['request']['payload'] for e in graph['generations']
        if e['request']['payload']['generations'][0]['generation_id'] == bound['target_generation_id']]
    period.need(len(targets) == 1, 'period_MY_target_missing_or_ambiguous')
    target = targets[0];generation = target['generations'][0]
    # A genuine retry may recover the original earlier journal acknowledgement;
    # it must not restamp that existing envelope with the new read's clock.
    recorded = generation['recorded_utc']
    rebuilt, snapshots = journal.capture(pool, docs['schedule'], calibration, records, recorded)
    gate._same(target, rebuilt, 'period_MY_offers_population_or_membership_changed')
    sources = {s['object_id']: s['payload'] for s in graph['source_objects']}
    for identity, original in snapshots.items():
        gate._same(sources.get(identity), original, 'period_MY_frozen_source_changed')
    previous = docs['previous_my_cards'];as_of = pool['generated_utc']
    already = previous is not None and any(r.get('pool_generated_utc') == as_of for r in previous.get('runs') or [])
    if already:
        expected_archive = previous
        expected_raw = capture['inputs']['previous_my_cards']['raw_utf8'].encode()
    else:
        expected_archive = my.append(previous, records, capture['season'], capture['week'], as_of,
            value['my_stage_reads']['read_completed_utc_claim'])
        expected_raw = (my.json.dumps(expected_archive, ensure_ascii=True, indent=2, sort_keys=False) + '\n').encode()
    gate._same(archive, expected_archive, 'period_MY_archive_math_or_first_sight_changed')
    period.need(outputs[path] == expected_raw, 'period_MY_archive_writer_bytes_changed')
    pool_raw = (period.files.export.encoded(pool) if pool_writer == 'period_canonical'
        else my.json.dumps(pool, ensure_ascii=True, indent=2).encode()) + b'\n'
    period.need(outputs['data/leg_pool.json'] == pool_raw,
        'period_MY_pool_writer_bytes_changed')
    authority = gate.sem.publication._authority(graph, capture['season'], capture['week'])
    members, unsupported = gate.sem._membership(archive, authority, bound['target_generation_id'],
        capture['season'], capture['week'], gate._time(recorded), gate._time(bound['bound_utc_claim']))
    previous_ids = {c['card_id'] for c in (previous or {}).get('cards') or []}
    return period.sealed({'version': 2, 'kind': 'nfl.period_MY_downstream_replay.v2',
        'status': 'as_generated_offers_journal_and_archive_replayed',
        'target_generation_id': bound['target_generation_id'], 'target_envelope_id': target['envelope_id'],
        'supported_current_receipts': len(target['receipts']), 'team_seeds': n_seeds,
        'current_offered_cards': len(records), 'new_archive_cards': len(archive['cards']) - len(previous_ids),
        'retained_archive_cards': len(previous_ids), 'already_recorded_pool': already,
        'target_archive_prop_legs': sum(m['lineage_class'] == 'target_generation' for m in members),
        'retained_archive_prop_legs': sum(m['lineage_class'] == 'retained_older_display_vintage' for m in members),
        'unsupported_archive_locations': len(unsupported),
        'upstream_eligibility_verified': False, 'current_owner_authority_verified': False,
        'MY_card_semantics_verified': False, 'publication_authorized': False}, 'downstream_replay_id')


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
    downstream = replay_binding(binding)
    period.need(binding['binding']['generated_utc_claim'] == application['forecast_created_utc']
        and gate.fingerprint(gate._json(session.pool_bytes)) == application['pool_id'],
        'period_MY_application_pool_mismatch')
    value = period.sealed({'version': 2, 'kind': 'nfl.period_MY_generation.v2',
        'application_id': application['application_id'], 'pool_id': application['pool_id'],
        'owner_head_event_id': application['owner_head_event_id'],
        'runtime_binding': binding, 'downstream_replay': downstream, 'recorded_utc': control.clock(),
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
        'downstream_replay_id': downstream['downstream_replay_id'],
        'owner_authenticated': False, 'publication_authorized': False,
        'production_authorized': False, 'public_serving_verified': False}
