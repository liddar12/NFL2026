"""Registered current-weather binding, not a new weather/precipitation model.

Legacy forecasts remain readable by archived backtests. Current consumers need
v2, an exact scheduled game/venue and a fresh document. A home abbreviation is
not a location: unmatched/neutral venues remain unknown, never Jacksonville
weather for Wembley. Saved bindings are consistency evidence, NOT authenticated
provider publication or an official roof-state confirmation.
"""
import datetime as dt
import math

from scripts.scrape.stadiums import STADIUMS

PROFILE = 'venue_bound_kickoff_weather_v2'
VERSION = 2
MAX_AGE_SECONDS = 12 * 3600
MAX_GAMES = 512
MAX_HOURLY = 4096
WINDOW_HOURS = 3
# Exact identity alias only, not fuzzy venue matching or permission to fall back
# to a team's home. The Chiefs identify both names as the same physical venue:
# https://www.chiefs.com/news/chiefs-unveil-vision-and-concepts-for-a-reimagined-arrowhead-stadium
REVIEWED_VENUE_ALIASES = {'KC': {'Arrowhead Stadium': 'GEHA Field at Arrowhead Stadium'}}
ROOT_KEYS = {'version', 'profile', 'generated_utc', 'source', 'games',
    'climatology', 'sources', 'refusals'}
ROW_KEYS = {'wind_kph', 'temp_c', 'precip_mm', 'source', 'fetched_utc',
    'binding', 'sample_utc', 'game_window'}
CLIMATE_KEYS = {'wind_kph', 'temp_c', 'source', 'n', 'month', 'rules', 'binding'}


def instant(value):
    if type(value) is not str or len(value) > 40:
        return None
    try:
        stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return stamp.astimezone(dt.timezone.utc) if stamp.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def clock(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def number(value, field):
    limits = {'temp_c': (-100, 70), 'wind_kph': (0, 400), 'precip_mm': (0, 1000)}
    lo, hi = limits[field]
    return type(value) in (int, float) and math.isfinite(value) and lo <= value <= hi


def key_for(season, game):
    return '%s|%s|%s|%s' % (season, game.get('week'), game.get('home'), game.get('away'))


def target(season, game):
    """(binding, refusal) using only an exactly reviewed ordinary home venue.

    Explicit neutral-site evidence takes precedence even if its name happens to
    match the home profile. No geographic/name fuzziness or inferred coordinates.
    The current schedule lacks neutral-site IDs/coordinates; unknowns need a
    future independently captured venue profile, not a guessed fallback here.
    """
    if type(game) is not dict or type(season) is not int:
        return None, 'weather_game_identity_unknown'
    if any(k in game and game[k] is not False for k in ('neutral_site', 'neutralSite')):
        return None, 'weather_neutral_venue_unbound'
    home, away, week = game.get('home'), game.get('away'), game.get('week')
    gid = game.get('game_id')
    if type(gid) is not str or not gid or len(gid) > 128 or type(week) is not int \
            or not 1 <= week <= 18 or type(home) is not str or type(away) is not str \
            or home not in STADIUMS or away not in STADIUMS or home == away \
            or instant(game.get('kickoff_utc')) is None:
        return None, 'weather_game_identity_unknown'
    venue = STADIUMS[home]
    actual_venue = game.get('venue')
    canonical_venue = REVIEWED_VENUE_ALIASES.get(home, {}).get(actual_venue) \
        if type(actual_venue) is str else None
    if actual_venue != venue['venue'] and canonical_venue != venue['venue']:
        return None, 'weather_actual_venue_unbound'
    if 'venue_city' in game and game['venue_city'] != venue['city']:
        return None, 'weather_venue_city_conflict'
    if 'venue_country' in game and game['venue_country'] not in (
            'US', 'USA', 'United States', 'United States of America'):
        return None, 'weather_venue_country_conflict'
    roof = venue.get('roof')
    if roof not in ('open', 'dome', 'retractable'):
        return None, 'weather_roof_unknown'
    # A fixed open field claimed to be closed is conflicting evidence. ESPN's
    # binary outdoor on the known SoFi canopy cannot override the reviewed dome.
    if roof == 'open' and game.get('roof') in ('indoor', 'dome', 'closed'):
        return None, 'weather_roof_conflict'
    return {'season': season, 'week': week, 'game_id': gid, 'home': home, 'away': away,
        'kickoff_utc': game['kickoff_utc'], 'venue': actual_venue,
        'venue_city': venue['city'], 'venue_country': 'US',
        'lat': venue['lat'], 'lon': venue['lon'], 'roof': roof,
        'venue_profile': 'reviewed_home_stadium_v1'}, None


def hour_sample(hourly, at):
    """One exact hourly row. Missing/malformed rain stays null, never 0."""
    if type(hourly) is not dict:
        return None
    times = hourly.get('time')
    want = at.strftime('%Y-%m-%dT%H:00')
    if type(times) is not list or len(times) > MAX_HOURLY or times.count(want) != 1:
        return None
    idx = times.index(want)
    sample = {'forecast_utc': clock(at.replace(minute=0, second=0, microsecond=0))}
    for key, source in (('temp_c', 'temperature_2m'), ('wind_kph', 'wind_speed_10m'),
            ('precip_mm', 'precipitation')):
        values = hourly.get(source)
        value = values[idx] if type(values) is list and idx < len(values) else None
        sample[key] = round(value, 2 if key == 'precip_mm' else 1) if number(value, key) else None
    return sample


def window(hourly, kickoff):
    """All hourly samples overlapping kickoff -> +3h, distinct from pricing.

    Open-Meteo precipitation is a previous-hour sum. Include the endpoints and
    their surrounding hours; do NOT call their sum a three-hour game rainfall
    total. This evidence has no coefficient and does not predict game duration.
    """
    end = kickoff + dt.timedelta(hours=WINDOW_HOURS)
    first = kickoff.replace(minute=0, second=0, microsecond=0)
    last = end.replace(minute=0, second=0, microsecond=0)
    if end != last:
        last += dt.timedelta(hours=1)
    times, at = [], first
    while at <= last:
        times.append(at)
        at += dt.timedelta(hours=1)
    rows = [hour_sample(hourly, stamp) or {'forecast_utc': clock(stamp),
        'temp_c': None, 'wind_kph': None, 'precip_mm': None} for stamp in times]
    return {'version': 1, 'starts_utc': clock(kickoff), 'ends_utc': clock(end),
        'precipitation_semantics': 'previous_hour_sum_not_exact_game_total',
        'hours': rows, 'complete': all(all(number(row[k], k)
            for k in ('temp_c', 'wind_kph', 'precip_mm')) for row in rows)}


def _window_valid(value, kickoff):
    if type(value) is not dict or set(value) != {'version', 'starts_utc', 'ends_utc',
            'precipitation_semantics', 'hours', 'complete'} or value['version'] != 1 \
            or value['precipitation_semantics'] != 'previous_hour_sum_not_exact_game_total' \
            or value['starts_utc'] != clock(kickoff) \
            or value['ends_utc'] != clock(kickoff + dt.timedelta(hours=WINDOW_HOURS)) \
            or type(value['complete']) is not bool or type(value['hours']) is not list:
        return False
    expected = window({}, kickoff)['hours']
    rows = value['hours']
    if len(rows) != len(expected):
        return False
    for row, want in zip(rows, expected):
        if type(row) is not dict or set(row) != set(want) or row['forecast_utc'] != want['forecast_utc'] \
                or not all(row[k] is None or number(row[k], k)
                    for k in ('temp_c', 'wind_kph', 'precip_mm')):
            return False
    return value['complete'] == all(all(number(row[k], k)
        for k in ('temp_c', 'wind_kph', 'precip_mm')) for row in rows)


def _row_valid(row, kind, binding):
    if type(row) is not dict or type(row.get('binding')) is not dict or row['binding'] != binding:
        return False
    if kind == 'forecast':
        kickoff = instant(binding['kickoff_utc'])
        return set(row) == ROW_KEYS and row['source'] == kind \
            and all(number(row[k], k) for k in ('temp_c', 'wind_kph')) \
            and (row['precip_mm'] is None or number(row['precip_mm'], 'precip_mm')) \
            and row['sample_utc'] == clock(kickoff.replace(minute=0, second=0, microsecond=0)) \
            and instant(row['fetched_utc']) is not None and _window_valid(row['game_window'], kickoff) \
            and all(row[k] == row['game_window']['hours'][0][k]
                for k in ('temp_c', 'wind_kph', 'precip_mm'))
    return set(row) == CLIMATE_KEYS and row['source'] == 'climatology' \
        and all(number(row[k], k) for k in ('temp_c', 'wind_kph')) \
        and type(row['n']) is int and row['n'] >= 4 \
        and row['month'] == instant(binding['kickoff_utc']).month \
        and type(row['rules']) is list and len(row['rules']) == len(set(row['rules'])) \
        and set(row['rules']) <= {'cold', 'wind'}


def row_valid(row, kind, binding):
    try:
        return _row_valid(row, kind, binding)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return False


def _header_valid(document):
    return type(document) is dict and set(document) == ROOT_KEYS \
        and type(document.get('version')) is int and document['version'] == VERSION \
        and document.get('profile') == PROFILE and instant(document.get('generated_utc')) is not None \
        and type(document.get('source')) is str and 0 < len(document['source']) <= 1000 \
        and type(document.get('sources')) is dict and type(document.get('refusals')) is dict \
        and len(document['refusals']) <= MAX_GAMES \
        and all(type(k) is str and len(k) <= 200 and type(v) is str
            and v.startswith('weather_') and len(v) <= 100 for k, v in document['refusals'].items()) \
        and all(type(document.get(k)) is dict and len(document[k]) <= MAX_GAMES
            for k in ('games', 'climatology'))


def validate_document(document, *, schedule_games=None, season=None):
    """Strict producer semantics; source consistency, not transport authentication.

    Legacy validation belongs to its legacy schema, not this registered path.
    Publisher validation rejects damaged v2; live consumers also refuse it.
    """
    if not _header_valid(document):
        return False
    if schedule_games is not None:
        if type(schedule_games) is not list or len(schedule_games) > MAX_GAMES or type(season) is not int:
            return False
        current, current_ids = {}, {}
        for game in schedule_games:
            if type(game) is not dict:
                continue
            key = key_for(season, game)
            gid = game.get('game_id')
            if type(gid) is str:
                current_ids[gid] = current_ids.get(gid, 0) + 1
            if key in current:
                current[key] = (None, 'weather_game_identity_ambiguous')
            else:
                current[key] = target(season, game)
    else:
        current = None
    generated = instant(document['generated_utc'])
    seen, seen_ids = set(), set()
    for name, kind in (('games', 'forecast'), ('climatology', 'climatology')):
        rows = document.get(name)
        if type(rows) is not dict or len(rows) > MAX_GAMES:
            return False
        for key, row in rows.items():
            binding = row.get('binding') if type(row) is dict else None
            if type(binding) is not dict:
                return False
            synthetic = {**binding, 'status': 'STATUS_SCHEDULED'}
            expected, reason = target(binding.get('season'), synthetic)
            if reason or expected != binding or key != key_for(binding['season'], binding) \
                    or key in seen or binding['game_id'] in seen_ids or not row_valid(row, kind, binding) \
                    or generated >= instant(binding['kickoff_utc']):
                return False
            if current is not None and (current.get(key) != (binding, None)
                    or current_ids.get(binding['game_id']) != 1):
                return False
            seen.add(key)
            seen_ids.add(binding['game_id'])
            if kind == 'forecast' and instant(row['fetched_utc']) != generated:
                return False
    return all(type(key) is str and len(key) <= 200 and type(reason) is str
        and reason.startswith('weather_') and len(reason) <= 100
        for key, reason in document['refusals'].items())


def live_view(document, season, schedule_games, checked_utc):
    """Verified current-game rows plus observable, bounded row-local refusals."""
    out = {'games': {}, 'climatology': {}, 'roof_by_game': {},
        'report': {'profile': PROFILE, 'status': 'held', 'reason_codes': [],
            'games': {}, 'provider_HTTP_verified': False}}
    report = out['report']
    if type(schedule_games) is not list or len(schedule_games) > MAX_GAMES:
        report['reason_codes'] = ['weather_schedule_unknown']
        return out
    checked = instant(checked_utc)
    generated = instant(document.get('generated_utc')) if type(document) is dict else None
    reason = None
    if checked is None or generated is None:
        reason = 'weather_clock_unknown'
    elif not _header_valid(document):
        reason = 'weather_registered_contract_required'
    elif generated > checked:
        reason = 'weather_source_future'
    elif (checked - generated).total_seconds() >= MAX_AGE_SECONDS:
        reason = 'weather_source_stale'
    counts, bindings, ids = {}, {}, {}
    for game in schedule_games:
        if type(game) is not dict:
            continue
        key = key_for(season, game)
        counts[key] = counts.get(key, 0) + 1
        gid = game.get('game_id')
        if type(gid) is str:
            ids[gid] = ids.get(gid, 0) + 1
        binding, problem = target(season, game)
        out['roof_by_game'][key] = binding['roof'] if binding is not None else None
        bindings[key] = (game, binding, problem)
    for key, (game, binding, problem) in bindings.items():
        problem = reason or problem
        if counts[key] != 1 or (binding is not None and ids.get(binding['game_id']) != 1):
            problem = 'weather_game_identity_ambiguous'
            out['roof_by_game'][key] = None
        if not problem and (game.get('status') != 'STATUS_SCHEDULED'
                or instant(game['kickoff_utc']) <= checked):
            problem = 'weather_game_not_upcoming'
        if not problem and binding['roof'] in ('dome', 'retractable'):
            problem = 'weather_roof_not_confirmed_open'
        if not problem:
            found = False
            for name, kind in (('games', 'forecast'), ('climatology', 'climatology')):
                row = document[name].get(key)
                if row is not None:
                    found = True
                    if not row_valid(row, kind, binding) or (kind == 'forecast'
                            and instant(row['fetched_utc']) != generated):
                        problem = 'weather_saved_game_binding_changed'
                    else:
                        out[name][key] = row
                    break
            if not found:
                problem = document['refusals'].get(key) or 'weather_game_source_missing'
        if problem:
            report['games'][key] = problem
    report['reason_codes'] = sorted(set(report['games'].values()) | ({reason} if reason else set()))
    report['status'] = 'current_bound_rows' if out['games'] or out['climatology'] else 'held'
    return out
