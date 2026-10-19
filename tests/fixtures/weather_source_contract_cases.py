"""Synthetic adversarial source-contract cases; not provider HTTP evidence."""
import copy
import datetime as dt
import json
from pathlib import Path
import unittest
import types
from unittest.mock import patch

from scripts import build_weather_forecast as producer
from scripts import build_weather_history as history
from scripts import build_weekly as weekly
from scripts import promote_signals as game_model
from scripts import validate_data as validator
from scripts import weather_source_contract as weather
from scripts import backtest_weather as shadow
from scripts.scrape.stadiums import STADIUMS

NOW = dt.datetime(2026, 10, 18, 14, tzinfo=dt.timezone.utc)
STAMP = weather.clock(NOW)


def game(home='GB', away='DAL', gid='g-1'):
    return {'game_id': gid, 'week': 6, 'home': home, 'away': away,
        'kickoff_utc': '2026-10-18T17:00Z', 'status': 'STATUS_SCHEDULED',
        'venue': STADIUMS[home]['venue']}


def hourly():
    return {'time': ['2026-10-18T%02d:00' % h for h in range(16, 23)],
        'temperature_2m': [15.0] * 7, 'wind_speed_10m': [35.0] * 7,
        'precipitation': [0.0, 0.0, 0.0, 8.0, 12.0, 0.0, 0.0]}


def produce(games=None, fetch=None):
    games = games if games is not None else [game()]
    return producer.build_document({'season': 2026, 'games': games}, NOW,
        fetch or (lambda _: hourly()), profile=weather.PROFILE)


def view(document, games=None, checked=STAMP):
    return weather.live_view(document, 2026, [game()] if games is None else games, checked)


class SourceContractTests(unittest.TestCase):
    def test_ordinary_venue_and_exact_hour_are_bound(self):
        doc, stats = produce()
        self.assertTrue(weather.validate_document(doc))
        row = doc['games']['2026|6|GB|DAL']
        self.assertEqual(row['binding']['venue'], 'Lambeau Field')
        self.assertEqual(row['binding']['lat'], STADIUMS['GB']['lat'])
        self.assertEqual(row['binding']['game_id'], 'g-1')
        self.assertEqual(row['sample_utc'], '2026-10-18T17:00:00Z')
        self.assertEqual(len(view(doc)['games']), 1)
        self.assertEqual(stats['forecast'], 1)

    def test_wembley_never_fetches_jacksonville_or_uses_its_climate(self):
        calls = []
        london = game('JAX', 'HOU'); london['venue'] = 'Wembley Stadium'
        old = [dict(game('JAX', 'HOU'), kickoff_utc='2025-10-18T17:00Z')]
        hist = {'2025|6|JAX|HOU': {'temp_c': 1.0, 'wind_kph': 50.0, 'precip_mm': 5.0}}
        doc, _ = producer.build_document({'season': 2026, 'games': [london]}, NOW,
            lambda home: calls.append(home), hist, {2025: old}, profile=weather.PROFILE)
        self.assertEqual(calls, [])
        self.assertEqual(doc['games'], {})
        self.assertEqual(doc['climatology'], {})
        self.assertEqual(doc['refusals']['2026|6|JAX|HOU'], 'weather_actual_venue_unbound')
        self.assertIsNone(view(doc, [london])['roof_by_game']['2026|6|JAX|HOU'])

    def test_exact_reviewed_arrowhead_alias_preserves_actual_name_not_fuzzy(self):
        physical = []
        for name in ('GEHA Field at Arrowhead Stadium', 'Arrowhead Stadium'):
            current = dict(game('KC', 'LAC'), venue=name)
            doc, _ = produce([current])
            self.assertTrue(weather.validate_document(doc, schedule_games=[current], season=2026))
            row = doc['games']['2026|6|KC|LAC']
            self.assertEqual(row['binding']['venue'], name)
            physical.append((row['binding']['lat'], row['binding']['lon'],
                row['binding']['roof'], row['binding']['venue_profile']))
            self.assertEqual(len(view(doc, [current])['games']), 1)
        self.assertEqual(physical[0], physical[1])
        for change in ({'venue': 'New Arrowhead Stadium'}, {'venue': 'Arrowhead Field'},
                {'venue': 'Wembley Stadium'}, {'venue_city': 'London'},
                {'venue_country': 'GB'}, {'neutral_site': True}):
            with self.subTest(change=change):
                calls = []
                current = {**game('KC', 'LAC'), 'venue': 'Arrowhead Stadium', **change}
                doc, _ = produce([current], lambda home: calls.append(home))
                self.assertEqual(calls, [])
                self.assertEqual(doc['games'], {})

    def test_missing_neutral_wrong_city_or_country_never_fetch_home(self):
        for change in ({'venue': None}, {'venue': 'Unknown Field'}, {'neutral_site': True},
                {'neutralSite': True}, {'venue_city': 'London'}, {'venue_country': 'GB'}):
            with self.subTest(change=change):
                calls = []
                doc, _ = produce([{**game(), **change}], lambda home: calls.append(home))
                self.assertEqual(calls, [])
                self.assertEqual(doc['games'], {})

    def test_domes_not_fetched_retractables_are_not_open_wind(self):
        calls = []
        games = [game('LAR', 'ARI', 'sofi'), game('IND', 'TEN', 'indy')]
        doc, _ = produce(games, lambda home: calls.append(home) or hourly())
        self.assertEqual(calls, ['IND'])
        current = view(doc, games)
        self.assertEqual(current['games'], {})
        self.assertEqual(current['roof_by_game']['2026|6|LAR|ARI'], 'dome')
        self.assertEqual(current['roof_by_game']['2026|6|IND|TEN'], 'retractable')
        self.assertIsNone(game_model.wind_current(2026, games, STAMP, doc))

    def test_unknown_precipitation_never_becomes_dry(self):
        for value in (None, 'bad', False, float('nan'), -1):
            with self.subTest(value=str(value)):
                raw = hourly(); raw['precipitation'][1] = value
                doc, _ = produce(fetch=lambda _: raw)
                row = doc['games']['2026|6|GB|DAL']
                self.assertIsNone(row['precip_mm'])
                self.assertFalse(row['game_window']['complete'])
                self.assertIsNone(history.pick_hour(raw, '2026-10-18T17:00Z')['precip_mm'])
                self.assertEqual(len(view(doc)['games']), 1)
        self.assertEqual(history.pick_hour(hourly(), '2026-10-18T17:00Z')['precip_mm'], 0)

    def test_full_game_window_preserves_late_rain_without_new_coefficient(self):
        doc, _ = produce()
        row = doc['games']['2026|6|GB|DAL']
        self.assertEqual(row['precip_mm'], 0)
        window = row['game_window']
        self.assertEqual(window['starts_utc'], '2026-10-18T17:00:00Z')
        self.assertEqual(window['ends_utc'], '2026-10-18T20:00:00Z')
        self.assertEqual([x['precip_mm'] for x in window['hours']], [0, 0, 8, 12])
        self.assertTrue(window['complete'])
        self.assertEqual(weekly.WEATHER, {'pass_dome': 1.03, 'pass_outdoors': 0.97,
            'pass_cold_extra': 0.97, 'rb_wind': 0.95, 'cold_c': 0, 'wind_kph': 24})
        self.assertEqual(game_model.WIND_KPH, 30.0)

    def test_partial_hour_window_is_explicit_and_cannot_claim_complete(self):
        raw = hourly(); raw['precipitation'][4] = None
        doc, _ = produce(fetch=lambda _: raw)
        self.assertFalse(doc['games']['2026|6|GB|DAL']['game_window']['complete'])
        damaged = copy.deepcopy(doc)
        damaged['games']['2026|6|GB|DAL']['game_window']['complete'] = True
        self.assertFalse(weather.validate_document(damaged))
        self.assertEqual(view(damaged)['games'], {})

    def test_reschedule_venue_game_or_week_change_refuses_stored_row(self):
        doc, _ = produce()
        for change in ({'kickoff_utc': '2026-10-18T18:00Z'}, {'venue': 'Wembley Stadium'},
                {'game_id': 'different-game'}, {'week': 7}):
            with self.subTest(change=change):
                self.assertEqual(view(doc, [{**game(), **change}])['games'], {})

    def test_future_stale_unknown_version_and_legacy_fail_current_not_history(self):
        doc, _ = produce()
        for change, when in (({'version': 3}, STAMP), ({'profile': 'uploaded-complete'}, STAMP),
                ({'generated_utc': '2026-10-18T14:01:00Z'}, STAMP),
                ({}, '2026-10-19T02:00:00Z')):
            with self.subTest(change=change, when=when):
                self.assertEqual(view({**doc, **change}, checked=when)['games'], {})
        legacy, _ = producer.build_document({'season': 2026, 'games': [game()]}, NOW, lambda _: hourly())
        self.assertNotIn('version', legacy)
        self.assertNotIn('binding', legacy['games']['2026|6|GB|DAL'])
        self.assertEqual(view(legacy)['games'], {})
        legacy_factors = weekly.build_factors(2026, None, {'stadiums': STADIUMS}, legacy)
        self.assertEqual(legacy_factors['forecast']['2026|6|GB|DAL']['wind_kph'], 35)

    def test_only_damaged_row_is_withheld_and_publisher_refuses_it(self):
        games = [game(), game('NE', 'NYJ', 'g-2')]
        doc, _ = produce(games)
        doc['games']['2026|6|GB|DAL']['binding']['game_id'] = 'forged'
        self.assertFalse(weather.validate_document(doc, schedule_games=games, season=2026))
        current = view(doc, games)
        self.assertEqual(set(current['games']), {'2026|6|NE|NYJ'})
        with self.assertRaises(validator.ValidationError):
            validator.check_weather_forecast(doc, {'season': 2026, 'games': games})

    def test_missing_samples_or_duplicate_time_not_fabricated(self):
        for field, replacement in (('time', ['2026-10-18T17:00'] * 2),
                ('wind_speed_10m', [None] * 7), ('temperature_2m', [True] * 7)):
            raw = hourly(); raw[field] = replacement
            doc, _ = produce(fetch=lambda _: raw)
            self.assertEqual(doc['games'], {})

    def test_both_live_consumers_use_same_exact_bound_source(self):
        doc, _ = produce()
        self.assertEqual(game_model.wind_current(2026, [game()], STAMP, doc), {'2026|6|GB|DAL': 35.0})
        context = {'schedule_games': [game()], 'updated_utc': STAMP}
        factors = weekly.build_factors(2026, None, {'stadiums': STADIUMS}, doc,
            forecast_context=context)
        self.assertEqual(factors['forecast']['2026|6|GB|DAL']['wind_kph'], 35)
        for stamp in ('2026-10-18T13:59:59Z', '2026-10-19T02:00:00Z'):
            self.assertIsNone(game_model.wind_current(2026, [game()], stamp, doc))
            held = weekly.enforce_forecast_context(factors, 2026, [game()], stamp)
            self.assertEqual(held['forecast'], {})

    def test_prepared_legacy_factors_cannot_bypass_live_weekly_boundary(self):
        legacy, _ = producer.build_document({'season': 2026, 'games': [game()]}, NOW, lambda _: hourly())
        factors = weekly.build_factors(2026, None, {'stadiums': STADIUMS}, legacy)
        projection = [{'gsis_id': 'p1', 'name': 'Synthetic RB', 'team': 'GB',
            'position': 'RB', 'proj_points': 100.0}]
        doc = weekly.build_weekly_document(projection, [game()], {'GB': 1500, 'DAL': 1500},
            {}, 2026, STAMP, injuries=[], this_week=6, factors=factors)
        self.assertEqual(doc['model']['weather_source']['status'], 'held')
        self.assertIn('weather_registered_contract_required', doc['model']['weather_source']['reason_codes'])
        self.assertEqual(doc['players'][0]['weeks'][5]['pts'], 100)
        self.assertEqual(factors['forecast']['2026|6|GB|DAL']['wind_kph'], 35)

    def test_schema_and_real_publisher_semantics_accept_v2_null_reject_damage(self):
        raw = hourly(); raw['precipitation'][1] = None
        doc, _ = produce(fetch=lambda _: raw)
        schema = json.loads(Path('data/contracts/weather_forecast.schema.json').read_text())
        validator.validate_against_schema(doc, schema, 'weather_forecast.json')
        for mutate in (lambda x: x.pop('profile'),
                lambda x: x['games']['2026|6|GB|DAL'].pop('binding'),
                lambda x: x['games']['2026|6|GB|DAL']['binding'].update(lat=0)):
            damaged = copy.deepcopy(doc); mutate(damaged)
            with self.assertRaises(validator.ValidationError):
                validator.validate_against_schema(damaged, schema, 'weather_forecast.json')
        for section in ('games', 'climatology'):
            legacy, _ = producer.build_document({'season': 2026, 'games': [game()]}, NOW, lambda _: hourly())
            legacy[section] = ['not-a-row-map']
            with self.assertRaises(validator.ValidationError):
                validator.validate_against_schema(legacy, schema, 'weather_forecast.json')

    def test_network_response_is_bounded_and_origin_fixed(self):
        class Response:
            def __init__(self, url, value): self.url, self.value = url, value
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return self.url
            def read(self, size): return self.value[:size]
        for url, value in (('http://api.open-meteo.com/v1/forecast', b'{}'),
                ('https://other.example/forecast', b'{}'),
                ('https://api.open-meteo.com/v1/forecast', b'x' * (producer.MAX_RESPONSE_BYTES + 1))):
            with patch('urllib.request.build_opener', return_value=types.SimpleNamespace(
                    open=lambda *a, **k: Response(url, value))):
                self.assertIsNone(producer._network_fetch('GB'))
        response = json.dumps({'hourly': hourly(), 'hourly_units': {
            'temperature_2m': '°C', 'wind_speed_10m': 'km/h', 'precipitation': 'mm'},
            'utc_offset_seconds': 0}).encode()
        with patch('urllib.request.build_opener', return_value=types.SimpleNamespace(
                open=lambda *a, **k: Response('https://api.open-meteo.com/v1/forecast', response))):
            self.assertEqual(producer._network_fetch('GB'), hourly())

    def test_unknown_weather_is_not_a_dry_training_or_control_row(self):
        row = dict(game(), season=2025, temp_c=10.0, wind_kph=10.0, precip_mm=None)
        self.assertEqual(shadow.team_game_rows({'g': row}, {}, {}, 'synthetic'), [])
        self.assertEqual(shadow.player_week_rows({'g': row}, {'rows': {}}, 'synthetic'), [])

    def test_duplicate_game_ids_are_local_and_never_climate_fallback(self):
        games = [game(), game('NE', 'NYJ', 'g-1'), game('CLE', 'BAL', 'other')]
        doc, _ = produce(games)
        self.assertEqual(set(doc['games']), {'2026|6|CLE|BAL'})
        self.assertEqual(doc['climatology'], {})
        current = view(doc, games)
        self.assertEqual(set(current['games']), {'2026|6|CLE|BAL'})

    def test_explicit_missing_inputs_or_bad_clock_never_trigger_another_read(self):
        doc, _ = produce()
        with patch('builtins.open', side_effect=AssertionError('unexpected hidden IO')):
            self.assertIsNone(game_model.wind_current(2026, None, STAMP, doc))
            self.assertIsNone(game_model.wind_current(2026, [game()], STAMP, None))
            self.assertIsNone(game_model.wind_current(2026, [game()], '', doc))

    def test_selected_sample_cannot_disagree_with_same_hour_window(self):
        doc, _ = produce()
        for field in ('temp_c', 'wind_kph', 'precip_mm'):
            damaged = copy.deepcopy(doc)
            damaged['games']['2026|6|GB|DAL'][field] += 1
            self.assertFalse(weather.validate_document(damaged))
            self.assertEqual(view(damaged)['games'], {})

    def test_redirect_cannot_leave_reviewed_https_endpoint(self):
        import urllib.request
        for url in ('http://api.open-meteo.com/v1/forecast', 'https://other.example/data',
                'https://user:secret@api.open-meteo.com/v1/forecast',
                'https://api.open-meteo.com:444/v1/forecast', 'https://api.open-meteo.com/elsewhere'):
            with self.assertRaises(ValueError):
                producer._ForecastRedirects().redirect_request(
                    urllib.request.Request('https://api.open-meteo.com/v1/forecast'), None,
                    302, 'Found', {}, url)

    def test_unknown_capture_clock_is_not_replaced_with_a_fresh_claim(self):
        schedule = {'season': 2026, 'games': [game()]}
        for now, stamp in ((NOW.replace(tzinfo=None), None), (NOW, ''), (NOW, 'invalid')):
            with self.assertRaises(ValueError):
                producer.build_document(schedule, now, lambda _: hourly(),
                    generated_utc=stamp, profile=weather.PROFILE)


if __name__ == '__main__':
    unittest.main()
