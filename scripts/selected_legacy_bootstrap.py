"""Selected-only bridge for unchanged pre-journal MY archive vintages.

No old journal is invented. The original archive is anchored to source Git;
known journal/source bytes must survive. Only missing-authority locations in
exact retained cards can remain explicitly unverified. Ordinary v1 capture and
its semantic gate remain strict. This module never imports the shared engine.
"""
import hashlib
import json
from pathlib import Path

from scripts import generation_capture_runtime as runtime
from scripts import generation_semantic_gate as gate
from scripts import learning_receipts as receipts

KIND = 'nfl.selected_retained_prejournal_binding.v1'
PROOF_KIND = 'nfl.selected_retained_prejournal_proof.v1'
FLAGS = {'legacy_history_verified': False, 'legacy_training_eligible': False,
    'owner_authenticated': False, 'publication_authorized': False, 'production_authorized': False}


def _hash(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def _inventory(root, head, season, week):
    tree = runtime._head_tree(root, head)
    prefix = 'data/snapshots/learning_journal/%d_wk%02d/' % (season, week)
    names = {p for p in tree if p.startswith(prefix)}
    gate.need(len(names) <= 64, 'bootstrap_known_journal_limit')
    bodies = runtime._head_blobs(root, head, tree, names)
    documents, source_names = {}, set()
    for path, raw in bodies.items():
        doc = gate._json(raw)
        generation, = doc['generations']
        gate.need(path == prefix + generation['generation_id'][7:] + '.json'
            and generation['season'] == season and generation['week'] == week,
            'bootstrap_known_journal_identity')
        documents[path] = doc
        source_names.update('data/snapshots/learning_sources/' + oid[7:] + '.json'
            for oid in generation['source_snapshots'].values())
    gate.need(len(source_names) <= 256 and source_names <= set(tree), 'bootstrap_known_source_missing')
    source_bodies = runtime._head_blobs(root, head, tree, source_names)
    sources = {p: gate._json(raw) for p, raw in source_bodies.items()}
    graph = gate.sem._graph({'version': 1,
        'source_objects': [{'version': 1, 'kind': 'source_snapshot', 'object_id': receipts.fingerprint(doc),
            'payload': doc} for doc in sources.values()],
        'generations': [{'request': {'version': 1, 'kind': 'generation', 'object_id': doc['envelope_id'], 'payload': doc},
            'expected_receipt_ids': sorted(doc['generations'][0]['receipt_ids'])} for doc in documents.values()]})
    for path, doc in sources.items():
        gate.need(path.endswith(receipts.fingerprint(doc)[7:] + '.json'), 'bootstrap_known_source_identity')
    return graph, {**bodies, **source_bodies}


def _locations(archive, known):
    result = []
    for card in (archive or {}).get('cards') or []:
        for index, leg in enumerate(card.get('legs') or []):
            receipt = leg.get('learning_receipt')
            if leg.get('market') not in receipts.PROP_MARKETS or type(receipt) is not dict:
                continue
            rid = receipt.get('receipt_id')
            gate.need(type(rid) is str and runtime.HASH.fullmatch(rid), 'bootstrap_invalid_legacy_receipt_id')
            if rid not in known:
                result.append({'card_id': card['card_id'], 'leg_index': index, 'receipt_id': rid})
    gate.need(len(result) <= 20000, 'bootstrap_legacy_location_limit')
    return result


def prepare(root, loader, *, committed_head=None):
    """Bind original preimage and every known source-HEAD journal/source byte."""
    capture, docs = gate._capture(loader['capture'])
    source = capture['generation_sha_claim']
    gate.need(type(source) is str and len(source) == 40 and all(c in '0123456789abcdef' for c in source),
        'bootstrap_exact_source_head_required')
    path = 'data/my_cards/%d_wk%02d.json' % (capture['season'], capture['week'])
    tree = runtime._head_tree(root, source)
    original = runtime._head_blobs(root, source, tree, {path})[path] if path in tree else None
    expected = capture['inputs']['previous_my_cards']['raw_utf8'].encode()
    absent = loader['read_observations']['previous_my_cards']['state'] == 'absent_optional'
    gate.need((original is None) == absent and (b'null' if original is None else original) == expected,
        'bootstrap_archive_not_exact_source_preimage')
    graph, bodies = _inventory(root, source, capture['season'], capture['week'])
    if committed_head is None:
        gate.need(all((root / p).exists() for p in bodies), 'bootstrap_known_history_removed')
        current = {p: runtime._read(runtime._relative(root, p)) for p in bodies}
    else:
        final_tree = runtime._head_tree(root, committed_head)
        gate.need(set(bodies) <= set(final_tree), 'bootstrap_known_history_removed')
        current = runtime._head_blobs(root, committed_head, final_tree, set(bodies))
    gate.need(current == bodies, 'bootstrap_known_history_changed')
    known = {r for entry in graph['generations'] for r in entry['expected_receipt_ids']}
    locations = _locations(docs['previous_my_cards'], known)
    proof = gate._seal({'version': 1, 'kind': PROOF_KIND, 'source_head': source,
        'season': capture['season'], 'week': capture['week'], 'archive_path': path,
        'previous_archive_raw_sha256': None if original is None else _hash(original),
        'known_source_inventory': {p: _hash(raw) for p, raw in sorted(bodies.items())},
        'unverified_locations': locations, 'unverified_receipt_ids': sorted({r['receipt_id'] for r in locations}),
        **FLAGS}, 'bootstrap_proof_id')
    return proof, graph


class SelectedCapture:
    """Trusted Python adapter only; no mode flag is read from incoming JSON."""
    def __init__(self, session, proof, known_graph):
        self.session, self.proof, self.known_graph = session, proof, known_graph

    def __getattr__(self, name):
        return getattr(self.session, name)

    def journal_graph(self, journal, pool, schedule, calibration, archive, snapshot_dir):
        current = set(journal['generations'][0]['receipt_ids'])
        gate.need(not current.intersection(self.proof['unverified_receipt_ids']), 'bootstrap_current_receipt_marked_legacy')
        sources = {row['object_id']: row['payload'] for row in self.known_graph['source_objects']}
        sources.update({receipts.fingerprint(doc): doc for doc in (pool, schedule, calibration)})
        generations = {row['request']['object_id']: row for row in self.known_graph['generations']}
        generations[journal['envelope_id']] = {'request': {'version': 1, 'kind': 'generation',
            'object_id': journal['envelope_id'], 'payload': journal}, 'expected_receipt_ids': sorted(current)}
        return gate.sem._graph({'version': 1,
            'source_objects': [{'version': 1, 'kind': 'source_snapshot', 'object_id': oid, 'payload': doc}
                for oid, doc in sorted(sources.items())], 'generations': list(generations.values())})


def select(session):
    """Use the bootstrap only for a committed source preimage with unknown rows.

    A locally accumulated, already journaled first run can use the existing
    strict path unchanged. Missing committed known evidence never becomes a
    bootstrap exemption.
    """
    capture = session.loader['capture']
    source_tree = runtime._head_tree(session.checkout, capture['generation_sha_claim'])
    path = 'data/my_cards/%d_wk%02d.json' % (capture['season'], capture['week'])
    if path not in source_tree:
        return session
    proof, graph = prepare(session.checkout, session.loader)
    return SelectedCapture(session, proof, graph) if proof['unverified_locations'] else session


def wrap(binding, adapter):
    if type(adapter) is not SelectedCapture:
        return binding
    return gate._seal({'version': 1, 'kind': KIND, 'runtime_binding': binding,
        'legacy_preimage': adapter.proof, **FLAGS}, 'selected_binding_id')


def unwrap(value):
    if type(value) is dict and value.get('kind') == KIND:
        gate.need(set(value) == {'version', 'kind', 'runtime_binding', 'legacy_preimage', 'selected_binding_id'} | set(FLAGS)
            and type(value['version']) is int and value['version'] == 1
            and all(value[k] is False for k in FLAGS), 'bootstrap_invalid_wrapper')
        gate._hashed(value, 'selected_binding_id')
        return value['runtime_binding'], value['legacy_preimage']
    return value, None


def verify(value, *, checkout, expected_head, base_head):
    binding, supplied = unwrap(value)
    if supplied is None:
        return binding, None, None
    binding, loader = runtime._runtime_binding(binding)
    proof, _ = prepare(checkout, loader, committed_head=expected_head)
    gate._same(supplied, proof, 'bootstrap_proof_not_reproduced')
    capture, docs = gate._capture(loader['capture'])
    target = next(row['request']['payload'] for row in binding['binding']['graph']['generations']
        if row['request']['payload']['generations'][0]['generation_id'] == binding['binding']['target_generation_id'])
    gate.need(not set(proof['unverified_receipt_ids']).intersection(target['generations'][0]['receipt_ids']),
        'bootstrap_current_receipt_marked_legacy')
    base_graph, _ = _inventory(checkout, base_head, capture['season'], capture['week'])
    base_known = {rid for row in base_graph['generations'] for rid in row['expected_receipt_ids']}
    gate.need(not base_known.intersection(proof['unverified_receipt_ids']), 'bootstrap_legacy_became_known_regenerate')
    tree = runtime._head_tree(checkout, base_head);path = proof['archive_path']
    gate.need(path in tree, 'bootstrap_retained_cards_not_in_publication_base')
    archive = gate._document(runtime._head_blobs(checkout, base_head, tree, {path})[path], path)
    previous = {c['card_id']: c for c in docs['previous_my_cards']['cards']}
    base_cards = {c['card_id']: c for c in archive['cards']}
    ids = {r['card_id'] for r in proof['unverified_locations']}
    gate.need(all(cid in base_cards and gate.encoded(previous[cid]) == gate.encoded(base_cards[cid]) for cid in ids),
        'bootstrap_retained_card_not_exact_publication_base')
    return binding, proof, {'cards': {cid: previous[cid] for cid in ids},
        'locations': {(r['card_id'], r['leg_index'], r['receipt_id']) for r in proof['unverified_locations']}}


def read_artifact(path, *, checkout):
    # Separate wrapper reader; no changes to the original v1 artifact contract.
    return runtime.read_artifact(path, checkout=checkout)
