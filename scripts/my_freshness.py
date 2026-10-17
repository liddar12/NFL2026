"""Owner-selected, provisional MY-yardage freshness policy.

Pure consumer checks, not official inactive confirmation or model approval.
The October 17 owner choice permits provisional props BEFORE the exclusive
90-minute checkpoint. A saved pool cannot clear that checkpoint by aging or
by carrying a provider's empty/nonempty inactive array. A future confirmed-list
adapter will require a separately versioned policy. Moneyline/ATD are untouched.
"""
import copy
import datetime as dt

from scripts import availability, learning_receipts as receipts
from scripts import build_weekly as weekly
from scripts.period_freshness_policy import PROFILES, _depth
from scripts.scrape.espn import FINAL_STATUSES

PROFILE = 'provisional_before_90m_v1'
PARAMETERS = {**PROFILES[PROFILE], 'source_max_seconds': 12 * 3600}
POLICY_ID = receipts.fingerprint({'profile': PROFILE, **PARAMETERS})
SOURCE_NAMES = ('schedule', 'injuries', 'depth_chart', 'inactives',
    'player_weekly', 'player_projections', 'game_predictions')


def _need(value, reason):
    if not value:
        raise ValueError(reason)


def _time(value):
    stamp = receipts.instant(value) if type(value) is str else None
    _need(stamp is not None, 'MY_freshness_clock_unknown')
    return stamp


def _clock(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def _unique(rows, key):
    _need(type(rows) is list and len(rows) <= 2000, 'MY_freshness_rows_unknown')
    result = {}
    for row in rows:
        _need(type(row) is dict and type(row.get(key)) is str and row[key]
            and row[key] not in result, 'MY_freshness_identity_ambiguous')
        result[row[key]] = row
    return result


def metadata(pool, sources):
    """Deterministic policy over all week games, not just surviving players.

    That makes applying twice identical and permits independent verification
    after excluded players have actually been removed from the offered pool.
    Unknown global sources hold yardage; a bad team QB witness holds only QBs.
    """
    generated = _time(pool['generated_utc'])
    season, week = pool['season'], pool['week']
    _need(type(season) is int and type(week) is int and 1 <= week <= 18,
        'MY_freshness_period_unknown')
    _need(type(sources) is dict and set(sources) == set(SOURCE_NAMES), 'MY_freshness_sources_unknown')
    schedule = sources['schedule']
    _need(type(schedule) is dict and schedule.get('season') == season, 'MY_freshness_schedule_unknown')
    games = _unique(schedule.get('games'), 'game_id')
    games = {gid: g for gid, g in games.items() if g.get('week') == week}
    _need(games, 'MY_freshness_week_games_missing')
    roster = _unique((sources['player_projections'] or {}).get('players'), 'gsis_id')
    deadlines, global_held = [], False
    for name in ('schedule', 'player_weekly', 'player_projections', 'game_predictions'):
        doc = sources[name]
        try:
            _need(type(doc) is dict and doc.get('season') == season, 'MY_freshness_source_period_unknown')
            if name == 'game_predictions':
                _need(doc.get('week') == week, 'MY_freshness_source_period_unknown')
            if name == 'player_weekly':
                _need(((doc.get('model') or {}).get('this_week') or {}).get('wk') == week,
                    'MY_freshness_source_period_unknown')
            issued = _time(doc.get('updated_utc') or doc.get('generated_utc'))
            _need(issued <= generated, 'MY_freshness_source_future')
            deadlines.append(issued + dt.timedelta(seconds=PARAMETERS['source_max_seconds']))
        except (ValueError, KeyError, TypeError):
            global_held = True
    injury = sources['injuries']
    blocked = set()
    try:
        _need(type(injury) is dict and injury.get('season') == season and injury.get('week') == week
            and injury.get('vocab_version') == availability.VOCAB_VERSION, 'MY_freshness_injury_period_unknown')
        _need(weekly.injury_source_state(injury, pool['generated_utc'], week)['verified'],
            'MY_freshness_injury_source_unverified')
        for key in ('source_updated_utc', 'received_utc'):
            issued = _time(injury.get(key))
            _need(issued <= generated, 'MY_freshness_source_future')
            deadlines.append(issued + dt.timedelta(seconds=PARAMETERS['source_max_seconds']))
        scoped, trusted = availability.quarantine_inputs(list(roster.values()), injury)
        resolved = availability.resolve_report(list(roster.values()), trusted)
        blocked.update(scoped['players']); blocked.update(resolved['refusals'])
        unavailable = weekly.unavailability(list(roster.values()), trusted, resolved=resolved)
        final = {t for g in games.values() if g.get('status') in FINAL_STATUSES
            for t in (g.get('home'), g.get('away'))}
        decisions, _ = weekly.this_week_gate(list(roster.values()), unavailable, trusted,
            sources['depth_chart'], week, weekly.team_schedule(list(games.values())), final,
            inactives=sources['inactives'])
        blocked.update(pid for pid, decision in decisions.items() if decision.get('playable') is False)
    except (ValueError, KeyError, TypeError, AttributeError):
        global_held = True
    expires = min(deadlines) if deadlines else generated
    global_held = global_held or expires <= generated
    output = []
    for gid, game in sorted(games.items()):
        kickoff = _time(game.get('kickoff_utc'))
        checkpoint = kickoff - dt.timedelta(seconds=PARAMETERS['inactive_recheck_seconds_before_kickoff'])
        members = {pid: p for pid, p in roster.items() if p.get('team') in (game.get('home'), game.get('away'))}
        held = global_held or game.get('status') != 'STATUS_SCHEDULED' or generated >= checkpoint
        player_limits = {}
        local_blocked = set(members) if held else blocked.intersection(members)
        for pid, player in members.items():
            if player.get('position') != 'QB':
                continue
            reason, limits = _depth(sources['depth_chart'], player, player, season,
                generated, generated, PARAMETERS)
            if reason:
                local_blocked.add(pid)
            else:
                player_limits[pid] = _clock(min(limits))
        output.append({'game_id': gid, 'check_due_utc': _clock(checkpoint),
            'source_expires_utc': _clock(expires), 'state': 'held' if held else 'provisional',
            'blocked_player_ids': sorted(local_blocked), 'player_source_expires': player_limits})
    return {'version': 1, 'profile': PROFILE, 'policy_id': POLICY_ID,
        'generated_utc': pool['generated_utc'], 'games': output}


def _allowed(player, index, checked):
    row = index.get(player.get('game_id'))
    if row is None or row['state'] != 'provisional' or checked >= min(
            _time(row['check_due_utc']), _time(row['source_expires_utc'])):
        return False
    pid = player.get('gsis_id')
    if pid in row['blocked_player_ids']:
        return False
    limit = row['player_source_expires'].get(pid)
    return limit is None or checked < _time(limit)


def apply(pool, sources):
    """Filter only MY yardage; never change probabilities or source objects."""
    doc = copy.deepcopy(pool)
    policy = metadata(doc, sources)
    checked = _time(doc['generated_utc'])
    index = {row['game_id']: row for row in policy['games']}
    doc['players'] = [p for p in doc['players'] if _allowed(p, index, checked)]
    doc['freshness_policy'] = policy
    doc['counts']['players_with_a_leg'] = len(doc['players'])
    doc['counts']['prop_legs'] = sum(len(p['rungs']) for p in doc['players'])
    return doc


def verify(pool, sources, *, checked_utc):
    """Recompute registered metadata and reject any now-held offered player."""
    report = {'version': 1, 'profile': PROFILE, 'policy_id': POLICY_ID,
        'consumer_policy_pass': False, 'reason_codes': [], 'owner_authenticated': False,
        'provider_completeness_verified': False, 'inactive_confirmation_verified': False,
        'publication_authorized': False, 'public_serving_verified': False}
    try:
        expected = metadata(pool, sources)
        _need(receipts.fingerprint(expected) == receipts.fingerprint(pool.get('freshness_policy')),
            'MY_freshness_saved_policy_mismatch')
        checked = _time(checked_utc)
        _need(checked >= _time(pool['generated_utc']), 'MY_freshness_check_before_generation')
        index = {row['game_id']: row for row in expected['games']}
        _need(all(_allowed(p, index, checked) for p in pool['players']), 'MY_freshness_offered_player_held')
        report['consumer_policy_pass'] = True
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        report['reason_codes'] = ['MY_freshness_consumer_policy_held']
    return report
