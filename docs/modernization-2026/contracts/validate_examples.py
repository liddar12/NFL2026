"""Design-only schema and semantic probes; no network, database or app writes."""
import copy
import json
import math
from datetime import datetime
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
SCHEMAS = {name: json.loads((ROOT / f'{name}.schema.json').read_text())
           for name in ('forecast', 'quote', 'outcome')}
for schema in SCHEMAS.values():
    Draft202012Validator.check_schema(schema)
VALIDATORS = {name: Draft202012Validator(schema, format_checker=FormatChecker())
              for name, schema in SCHEMAS.items()}


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def validate(kind, record):
    VALIDATORS[kind].validate(record)
    if kind == 'forecast':
        if not stamp(record['source_max_as_of']) <= stamp(record['issued_at']):
            raise ValueError('source data is newer than issue time')
        if record['evidence_class'] == 'verified_pre_event' and not stamp(record['issued_at']) < stamp(record['lock_deadline']):
            raise ValueError('verified pre-event forecast issued after lock')
        p = record['prediction']
        if p['kind'] == 'categorical':
            if not math.isclose(sum(p['probabilities'].values()), 1, abs_tol=1e-9):
                raise ValueError('probabilities do not sum to one')
            expected = {'home', 'away', 'tie'} if p['conditioning'] == 'unconditional_three_way' else {'home', 'away'}
            if record['task'] == 'nfl.game_result' and set(p['probabilities']) != expected:
                raise ValueError('game-result classes are not exhaustive for the conditioning')
        elif p['interval'] is not None and p['interval']['lower'] > p['interval']['upper']:
            raise ValueError('inverted interval')
        if record['task'] == 'nfl.player_week_points' and p['kind'] != 'points':
            raise ValueError('points task has wrong prediction shape')
    elif kind == 'quote':
        if stamp(record['quoted_at']) >= stamp(record['expires_at']):
            raise ValueError('quote expires before issue')
        keys = [s['selection_id'] for s in record['selections']]
        if len(set(keys)) != len(keys):
            raise ValueError('duplicate selection')
        if any(s['event_id'] != record['event_id'] for s in record['selections']):
            raise ValueError('single-game quote contains another event')
    return record


def validate_outcome(record, forecast, previous=None):
    validate('outcome', record)
    if record['prediction_id'] != forecast['record_id'] or record['project_id'] != forecast['project_id']:
        raise ValueError('orphan or cross-project outcome')
    if stamp(record['source_observed_at']) > stamp(record['resolved_at']):
        raise ValueError('resolution predates source observation')
    if stamp(record['resolved_at']) < stamp(forecast['lock_deadline']):
        raise ValueError('final result predates the forecast lock')
    expected_revision = 1 if previous is None else previous['revision'] + 1
    expected_previous = None if previous is None else previous['revision']
    if record['revision'] != expected_revision or record['supersedes_revision'] != expected_previous:
        raise ValueError('broken revision chain')
    if previous is not None and (previous['prediction_id'] != record['prediction_id'] or not record['correction_reason']):
        raise ValueError('correction has no matching predecessor/reason')
    result = record['result']
    if record['status'] == 'void':
        if result is not None:
            raise ValueError('void outcome must not fabricate a scored result')
    elif result is None:
        raise ValueError('final outcome needs a result')
    elif forecast['prediction']['kind'] == 'points' and result['kind'] != 'points':
        raise ValueError('points result has wrong shape')
    elif forecast['prediction']['kind'] == 'categorical':
        if result['kind'] != 'class' or result['value'] not in forecast['prediction']['probabilities']:
            raise ValueError('outcome outside forecast classes; apply conditional-task settlement policy')


def fixture(name):
    return json.loads((ROOT / 'examples' / f'{name}.json').read_text())


class ContractDesignTests(unittest.TestCase):
    def test_all_examples(self):
        for name, kind in [('points-forecast','forecast'), ('game-forecast','forecast'), ('combined-quote','quote'), ('final-outcome','outcome'), ('corrected-outcome','outcome')]:
            validate(kind, fixture(name))
        validate_outcome(fixture('final-outcome'), fixture('points-forecast'))
        validate_outcome(fixture('corrected-outcome'), fixture('points-forecast'), fixture('final-outcome'))

    def test_examples_remain_fixtures(self):
        for path in (ROOT / 'examples').glob('*.json'):
            self.assertTrue(json.loads(path.read_text())['fixture'])

    def test_probability_sum(self):
        r=fixture('game-forecast'); r['prediction']['probabilities']['home']=0.9
        with self.assertRaises(ValueError): validate('forecast',r)

    def test_missing_tie(self):
        r=fixture('game-forecast'); r['prediction']['probabilities']={'home':0.6,'away':0.4}
        with self.assertRaises(ValueError): validate('forecast',r)

    def test_late_verified_record(self):
        r=fixture('points-forecast'); r['evidence_class']='verified_pre_event'; r['issued_at']='2026-10-12T00:00:00Z'
        with self.assertRaises(ValueError): validate('forecast',r)

    def test_future_source(self):
        r=fixture('points-forecast'); r['source_max_as_of']='2026-10-12T00:00:00Z'
        with self.assertRaises(ValueError): validate('forecast',r)

    def test_missing_model_version(self):
        r=fixture('points-forecast'); del r['model_version']
        self.assertTrue(list(VALIDATORS['forecast'].iter_errors(r)))

    def test_no_synthetic_quote(self):
        r=fixture('combined-quote'); r['combined_decimal_odds']=None
        self.assertTrue(list(VALIDATORS['quote'].iter_errors(r)))

    def test_expiry_order(self):
        r=fixture('combined-quote'); r['expires_at']=r['quoted_at']
        with self.assertRaises(ValueError): validate('quote',r)

    def test_duplicate_leg(self):
        r=fixture('combined-quote'); r['selections'][1]=copy.deepcopy(r['selections'][0])
        with self.assertRaises(ValueError): validate('quote',r)

    def test_different_game(self):
        r=fixture('combined-quote'); r['selections'][1]['event_id']='fixture-other-game'
        with self.assertRaises(ValueError): validate('quote',r)

    def test_orphan_outcome(self):
        r=fixture('final-outcome'); r['prediction_id']='fixture-unknown'
        with self.assertRaises(ValueError): validate_outcome(r,fixture('points-forecast'))

    def test_revision_gap(self):
        r=fixture('corrected-outcome'); r['revision']=3
        with self.assertRaises(ValueError): validate_outcome(r,fixture('points-forecast'),fixture('final-outcome'))

    def test_intermediate_not_final(self):
        r=fixture('final-outcome'); r['status']='live'
        self.assertTrue(list(VALIDATORS['outcome'].iter_errors(r)))

    def test_void_has_no_points(self):
        r=fixture('final-outcome'); r['status']='void'
        with self.assertRaises(ValueError): validate_outcome(r,fixture('points-forecast'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
