"""Offline malformed-row regressions. No provider requests or artifact writes."""
import copy
import json
from pathlib import Path
import runpy
import unittest

from scripts import weather_corpus as corpus
from scripts import weather_source_contract as weather
from scripts import build_weekly as weekly
from scripts import build_weather_history as history
from scripts import backtest_weather as shadow
from scripts import validate_data as validator

F = runpy.run_path(str(Path(__file__).with_name('weather_source_contract_cases.py')))
GB, NE = '2026|6|GB|DAL', '2026|6|NE|NYJ'


def pair():
    return [F['game'](), F['game']('NE', 'NYJ', 'g-2')]


def factors(document):
    return weekly.build_factors(2026, forecast_doc=document,
        forecast_context={'schedule_games': pair(), 'updated_utc': F['STAMP']})


def deep():
    value = []
    for _ in range(600):
        value = [value]
    return value


class WeatherRowHardeningTests(unittest.TestCase):
    def test_parseable_huge_integer_is_rejected_without_float_overflow(self):
        huge = json.loads('1' + '0' * 400)
        for field in ('wind_kph', 'temp_c', 'precip_mm'):
            self.assertFalse(weather.number(huge, field))
            self.assertFalse(weather.number(-huge, field))

    def test_huge_wind_holds_only_bad_game_not_other_home(self):
        bad = F['hourly']()
        bad['wind_speed_10m'][1] = 10 ** 400
        document, stats = F['produce'](pair(), lambda home: bad if home == 'GB' else F['hourly']())
        self.assertEqual(set(document['games']), {NE})
        self.assertEqual(document['refusals'][GB], 'weather_forecast_hour_unavailable')
        self.assertEqual(stats['forecast'], 1)
        self.assertEqual(set(factors(document)['forecast']), {NE})

    def test_huge_rain_remains_unknown_with_healthy_wind_and_other_game(self):
        bad = F['hourly']()
        bad['precipitation'][1] = 10 ** 400
        document, _ = F['produce'](pair(), lambda home: bad if home == 'GB' else F['hourly']())
        self.assertEqual(set(document['games']), {GB, NE})
        self.assertIsNone(document['games'][GB]['precip_mm'])
        self.assertFalse(document['games'][GB]['game_window']['complete'])
        self.assertEqual(document['games'][NE]['precip_mm'], 0.0)

    def test_history_parser_huge_numeric_never_crashes_or_invents_rain(self):
        for field in ('wind_speed_10m', 'temperature_2m', 'precipitation'):
            bad = F['hourly']()
            bad[field][1] = 10 ** 400
            result = history.pick_hour(bad, '2026-10-18T17:00Z')
            if field == 'precipitation':
                self.assertIsNone(result['precip_mm'])
            else:
                self.assertIsNone(result)
        self.assertEqual(history.pick_hour(F['hourly'](), '2026-10-18T17:00Z'),
            {'wind_kph': 35.0, 'temp_c': 15.0, 'precip_mm': 0.0})

    def test_deep_bad_row_is_withheld_before_detached_weekly_snapshot(self):
        document, _ = F['produce'](pair())
        document['games'][GB]['game_window'] = deep()
        result = factors(document)
        self.assertEqual(set(result['forecast']), {NE})
        self.assertEqual(result['weather_source_report']['games'][GB],
            'weather_saved_game_binding_changed')
        self.assertEqual(result['_forecast_document']['games'][GB],
            {'invalid_weather_snapshot': True})

    def test_bounded_row_failure_never_falls_through_to_climatology(self):
        document, _ = F['produce'](pair())
        document['games'][GB]['game_window'] = [None] * (weather.SNAPSHOT_MAX_NODES + 1)
        # Presence, not validity, decides forecast-before-climate priority.
        document['climatology'][GB] = copy.deepcopy(document['games'][NE])
        result = factors(document)
        self.assertEqual(set(result['forecast']), {NE})
        self.assertIn(GB, result['weather_source_report']['games'])

    def test_valid_snapshot_is_detached_and_preserves_legacy_values(self):
        document, _ = F['produce'](pair())
        saved = weather.snapshot_document(document)
        self.assertEqual(saved, document)
        document['games'][GB]['game_window']['hours'][0]['wind_kph'] = 1
        self.assertEqual(saved['games'][GB]['game_window']['hours'][0]['wind_kph'], 35.0)
        legacy = {'generated_utc': F['STAMP'], 'source': 'fixture',
            'games': {GB: {'wind_kph': 35.0, 'temp_c': 15.0}}, 'climatology': {},
            'sources': {'counts': {'forecast': 1}}}
        archived = weekly.build_factors(2026, forecast_doc=legacy)
        self.assertEqual(archived['_forecast_document'], legacy)
        self.assertEqual(archived['forecast'], legacy['games'])
        self.assertEqual(factors(legacy)['forecast'], {})
        multi_season = {'games': {str(i): {'wind_kph': 35.0, 'temp_c': 15.0}
            for i in range(893)}}
        self.assertEqual(weekly.build_factors(2026,
            forecast_doc=multi_season)['forecast'], multi_season['games'])

    def test_invalid_root_metadata_holds_instead_of_crashing_or_upgrading(self):
        document, _ = F['produce'](pair())
        for change in ({'sources': {'nested': deep()}}, {'games': []},
                {'profile': 'unknown_profile'}, {'version': 999}, {'extra': 'not admitted'}):
            with self.subTest(keys=tuple(change)):
                bad = {**document, **change}
                self.assertEqual(factors(bad)['forecast'], {})
                self.assertEqual(factors(bad)['weather_source_report']['status'], 'held')

    def test_unknown_rain_is_explicitly_excluded_not_dry_or_unjoined(self):
        original, meta, context = corpus._fixture()
        baseline = corpus.venue_verified(corpus.load_corpus(original, meta))
        key = next(iter(baseline['rows']))
        document = copy.deepcopy(original)
        document['games'][key]['precip_mm'] = None
        loaded = corpus.load_corpus(document, meta)
        checked = corpus.venue_verified(loaded)
        self.assertEqual(loaded['rows_joined'], 9)
        self.assertEqual(loaded['unknown_weather'], {key: ('precip_mm',)})
        self.assertNotIn(key, loaded['unjoined'])
        self.assertNotIn(key, checked['rows'])
        self.assertEqual(checked['rows_kept'], baseline['rows_kept'] - 1)
        audit = corpus.roof_audit(checked['rows'].keys(), context_doc=context)
        report = corpus.corpus_filter_report(checked, audit)
        self.assertEqual(report['rows_unknown_weather'], 1)
        self.assertEqual(report['rows_read'] - report['rows_unjoined'], report['rows_joined'])
        self.assertEqual(report['rows_joined'] - report['rows_unknown_weather']
            - report['dropped_relocations'], report['rows_kept'])
        self.assertIn('never imputed dry', report['rule'])
        expected = {k: r for k, r in baseline['rows'].items() if k != key}
        self.assertEqual(corpus.condition_counts(checked['rows']), corpus.condition_counts(expected))
        # Exercise the actual downstream team/control row assembler without
        # fitting a coefficient, reading outcomes or activating any candidate.
        epa = {(row['season'], row['week'], team): {'dropbacks': 30, 'pass_epa': 3.0}
            for row in baseline['rows'].values() for team in (row['home'], row['away'])}
        downstream = shadow.team_game_rows(checked['rows'], epa, {}, 'synthetic')
        self.assertEqual(len(downstream), 2 * checked['rows_kept'])
        self.assertNotIn(key, {row['game_key'] for row in downstream})
        schema = json.loads(Path('data/contracts/weather_backtest.schema.json').read_text())
        errors = []
        validator._validate(report, schema['properties']['corpus_filter'], 'corpus_filter', errors)
        self.assertEqual(errors, [])

    def test_invalid_weather_is_row_local_and_real_zero_is_retained(self):
        original, meta, _ = corpus._fixture()
        known = corpus.load_corpus(original, meta)
        key = next(iter(known['rows']))
        for field, value in (('precip_mm', None), ('precip_mm', True),
                ('precip_mm', '0'), ('precip_mm', float('nan')), ('precip_mm', -1),
                ('precip_mm', 10 ** 400), ('temp_c', None), ('wind_kph', 10 ** 400)):
            with self.subTest(field=field, kind=type(value).__name__):
                document = copy.deepcopy(original)
                document['games'][key][field] = value
                result = corpus.load_corpus(document, meta)
                self.assertEqual(set(result['rows']), set(known['rows']) - {key})
                self.assertEqual(result['unknown_weather'], {key: (field,)})
        document = copy.deepcopy(original)
        document['games'][key]['precip_mm'] = 0
        self.assertEqual(corpus.load_corpus(document, meta)['rows'][key]['precip_mm'], 0.0)

    def test_known_history_report_is_unchanged_and_reader_does_not_mutate_inputs(self):
        original, meta, context = corpus._fixture()
        before = copy.deepcopy(original)
        loaded = corpus.load_corpus(original, meta)
        checked = corpus.venue_verified(loaded)
        report = corpus.corpus_filter_report(checked,
            corpus.roof_audit(checked['rows'].keys(), context_doc=context))
        self.assertEqual(original, before)
        self.assertEqual(loaded['unknown_weather'], {})
        self.assertNotIn('rows_unknown_weather', report)
        self.assertEqual((report['rows_read'], report['rows_joined'],
            report['dropped_relocations'], report['rows_kept']), (10, 9, 1, 8))


if __name__ == '__main__':
    unittest.main()
