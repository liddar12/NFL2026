"""Replay frozen weekly eligibility facts for MY, without inventing freshness.

The original weekly producer's earlier reads/provider responses are NOT attested
by these later witnesses. This checks source consistency and the actual gate
decisions, including omitted depth/status/inactive blocks. Undefined depth and
in-window inactive freshness remain explicit policy holds, not new defaults or
permission to publish. It does not price a rung or apply any calibrator.
"""
import math

from scripts import availability
from scripts import build_leg_pool as pool_builder
from scripts import build_weekly as weekly_builder
from scripts import generation_semantic_gate as gate
from scripts import validate_data
from scripts.scrape.renames import canonical_player_name, normalize_team
from scripts.scrape.espn import FINAL_STATUSES


def _source_clock(doc, capture, checked):
    stamp = gate._time(doc.get('generated_utc') or doc.get('updated_utc'))
    gate.need(stamp <= gate._time(capture['captured_utc_claim']) <= checked,
        'period_sources_read_chronology_invalid')
    gate.need(0 <= (checked - stamp).total_seconds() <= 12 * 3600,
        'period_sources_consumer_stale')


def _facts(capture, pool, checked_utc):
    capture, docs = gate._capture(capture)
    pool = gate._plain(pool)
    checked = gate._time(checked_utc)
    season, week = capture['season'], capture['week']
    generated = gate._time(pool.get('generated_utc'))
    gate.need((pool.get('season'), pool.get('week')) == (season, week)
        and gate._time(capture['captured_utc_claim']) <= generated <= checked,
        'period_sources_pool_period_or_clock_invalid')
    for name in ('player_weekly', 'player_projections', 'game_predictions', 'schedule', 'parlays'):
        gate.need(type(docs[name]) is dict and type(docs[name].get('season')) is int
            and docs[name]['season'] == season, 'period_sources_season_mismatch')
    weekly, projections = docs['player_weekly'], docs['player_projections']
    meta = (weekly.get('model') or {}).get('this_week')
    gate.need(type(meta) is dict and type(meta.get('wk')) is int and meta['wk'] == week
        and type(docs['game_predictions'].get('week')) is int and docs['game_predictions']['week'] == week
        and type(docs['parlays'].get('week')) is int and docs['parlays']['week'] == week,
        'period_sources_week_mismatch')
    for name in ('player_weekly', 'player_projections', 'game_predictions', 'schedule'):
        _source_clock(docs[name], capture, checked)
    rows = gate._unique(weekly.get('players'), 'gsis_id', 'period_sources_ambiguous_weekly_player')
    roster = gate._unique(projections.get('players'), 'gsis_id', 'period_sources_ambiguous_projection_player')
    gate.need(set(rows) == set(roster), 'period_sources_weekly_roster_mismatch')
    games = gate._unique(docs['game_predictions'].get('games'), 'game_id', 'period_sources_ambiguous_prediction_game')
    schedule = gate._unique(docs['schedule'].get('games'), 'game_id', 'period_sources_ambiguous_schedule_game')
    for gid, game in schedule.items():
        gate.need(type(gid) is str and 0 < len(gid) <= 200 and type(game.get('week')) is int
            and 1 <= game['week'] <= 18 and type(game.get('home')) is str and bool(game['home'])
            and type(game.get('away')) is str and bool(game['away'])
            and normalize_team(game['home']) == game['home']
            and normalize_team(game['away']) == game['away'] and game['home'] != game['away'],
            'period_sources_schedule_identity_invalid')
        gate.need(type(game.get('status')) is str and bool(game['status'].strip()),
            'period_sources_schedule_status_missing')
    team_games = {}
    for gid, game in games.items():
        gate.need(gid in schedule and game.get('week') == week, 'period_sources_prediction_game_mismatch')
        actual = schedule[gid]
        gate.need(all(gate.encoded(game.get(k)) == gate.encoded(actual.get(k))
            for k in ('week', 'home', 'away', 'kickoff_utc')) and
            ('status' not in game or gate.encoded(game['status']) == gate.encoded(actual.get('status'))),
            'period_sources_prediction_game_mismatch')
        gate._time(actual.get('kickoff_utc'))
        for team in (game['home'], game['away']):
            gate.need(team not in team_games, 'period_sources_ambiguous_team_game')
            team_games[team] = actual
    current = {gid: g for gid, g in schedule.items() if g['week'] == week}
    gate.need(set(games) == set(current), 'period_sources_incomplete_week_games')
    for pid, projection in roster.items():
        gate.need(type(pid) is str and 0 < len(pid) <= 128
            and type(projection.get('team')) is str and bool(projection['team'])
            and normalize_team(projection['team']) == projection['team']
            and type(projection.get('position')) is str and bool(projection['position'])
            and type(projection.get('name')) is str and bool(projection['name'].strip()),
            'period_sources_player_identity_invalid')
        row = rows[pid]
        for key in ('team', 'position', 'name', 'player'):
            if key not in row:
                continue
            if key in ('name', 'player'):
                expected = availability.norm_name(canonical_player_name(projection['name']))
                actual = availability.norm_name(canonical_player_name(row[key]))
            else:
                expected, actual = projection[key], row[key]
            gate.need(type(row[key]) is str and bool(row[key].strip()) and expected == actual,
                'period_sources_contradictory_weekly_identity')
        weeks = gate._unique(row.get('weeks'), 'wk', 'period_sources_ambiguous_player_week')
        gate.need(all(type(w) is int and 1 <= w <= 18 for w in weeks) and week in weeks,
            'period_sources_target_player_week_missing')
        event = team_games.get(projection['team']);target = weeks[week]
        if event is None:
            gate.need(target.get('bye') is True, 'period_sources_unexplained_player_bye')
        else:
            home = event['home'] == projection['team']
            gate.need(target.get('bye') is not True and type(target.get('home')) is bool
                and target['home'] is home and target.get('opp') == event['away' if home else 'home'],
                'period_sources_player_matchup_mismatch')
    injury = docs['injuries']
    gate.need(type(injury) is dict and type(injury.get('season')) is int and injury['season'] == season
        and type(injury.get('week')) is int and injury['week'] == week
        and type(injury.get('vocab_version')) is int and injury['vocab_version'] == availability.VOCAB_VERSION,
        'period_sources_injury_period_or_vocabulary_invalid')
    gate.need(type(injury.get('injuries')) is list and len(injury['injuries']) <= gate.MAX_ROWS,
        'period_sources_injury_rows_invalid')
    for row in injury['injuries']:
        try:
            enriched = availability.enrich(row)
        except (ValueError, TypeError, AttributeError):
            raise gate.GateError('period_sources_unquarantined_status') from None
        gate._same({k: row.get(k) for k in enriched}, enriched, 'period_sources_canonical_status_changed')
    gate._same(injury.get('counts'), availability.counts(injury['injuries']), 'period_sources_status_counts_changed')
    for when in (capture['captured_utc_claim'], pool['generated_utc'], checked_utc):
        state = weekly_builder.injury_source_state(injury, when, week)
        gate.need(state['verified'], 'period_sources_injury_source_unverified')
    gate.need(all(gate._time(injury.get(k)) <= gate._time(capture['captured_utc_claim'])
        for k in ('source_updated_utc', 'received_utc')), 'period_sources_injury_evidence_after_capture')
    gate.need(type((weekly.get('model') or {}).get('injury_source')) is dict,
        'period_sources_weekly_source_receipt_missing')
    offered = gate._unique(pool.get('players'), 'gsis_id', 'period_sources_ambiguous_offered_player')
    gate.need(set(offered) <= set(roster), 'period_sources_offered_player_unknown')
    gate._explicit_source_identity(roster, rows, injury, pool, week)
    try:
        validate_data.check_weekly_availability(weekly, projections, injury, docs['depth_chart'], docs['inactives'])
        validate_data.check_no_unplayable_legs(weekly, {'week': week, 'parlays': []}, pool)
    except validate_data.ValidationError:
        raise gate.GateError('period_sources_weekly_availability_invalid') from None
    scope, trusted = availability.quarantine_inputs(list(roster.values()), injury)
    resolved = availability.resolve_report(list(roster.values()), trusted)
    scope['players'].update(resolved['refusals'])
    unavail = weekly_builder.unavailability(list(roster.values()), trusted, resolved=resolved)
    for pid in scope['players']:
        unavail.pop(pid, None)
    final = {team for g in current.values() if g.get('status') in FINAL_STATUSES
        for team in (g['home'], g['away'])}
    expected, summary = weekly_builder.this_week_gate(list(roster.values()), unavail, trusted,
        docs['depth_chart'], week, weekly_builder.team_schedule(list(schedule.values())),
        final, inactives=docs['inactives'])
    gate._same(meta, summary, 'period_sources_gate_summary_not_reproduced')
    for pid, row in rows.items():
        actual, decision = row.get('this_week'), expected.get(pid)
        if decision is None:
            gate.need(actual is None, 'period_sources_gate_decision_not_reproduced')
            continue
        # The weekly writer adds points_lost after the eligibility decision,
        # using earlier Elo/factor reads this witness does not capture. Validate
        # its shape, NOT its unobserved numeric derivation or an exact price.
        loss = decision['playable'] is False
        gate.need(type(actual) is dict and set(actual) == set(decision) | ({'points_lost'} if loss else set()),
            'period_sources_gate_decision_not_reproduced')
        if loss:
            value = actual['points_lost']
            gate.need(type(value) in (int, float) and math.isfinite(value) and value >= 0,
                'period_sources_gate_points_lost_invalid')
        gate._same({k: v for k, v in actual.items() if k != 'points_lost'}, decision,
            'period_sources_gate_decision_not_reproduced')
    for pid, player in offered.items():
        original = roster[pid];event = team_games.get(original['team'])
        gate.need(all(player.get(k) == original.get(k) for k in ('team', 'position'))
            and event is not None and str(player.get('game_id')) == event['game_id']
            and event.get('status') == 'STATUS_SCHEDULED'
            and checked < gate._time(event['kickoff_utc']) and pool_builder.playable_this_week(rows[pid], week),
            'period_sources_offered_player_not_eligible_future')
    future = [g for g in current.values() if g.get('status') == 'STATUS_SCHEDULED'
        and checked < gate._time(g['kickoff_utc'])]
    qb = sum(p['position'] == 'QB' and p['team'] in team_games
        and team_games[p['team']] in future for p in roster.values())
    window = sum((gate._time(g['kickoff_utc']) - checked).total_seconds() <= 3 * 3600 for g in future)
    holds = (['undefined_depth_freshness_policy'] if qb else []) + (
        ['undefined_inactive_freshness_or_applicability'] if window else [])
    return {'supported_projected_players': len(roster), 'offered_players': len(offered),
        'replayed_gate_decisions': len(expected), 'row_quarantined_players': len(scope['players']),
        'finished_teams_preserved': len(final), 'future_QB_players': qb,
        'future_games_in_inactive_window': window}, holds


def verify(capture, pool, *, checked_utc):
    """Pure diagnostic; success on facts cannot remove an undefined policy hold."""
    report = {'version': 2, 'kind': 'nfl.period_frozen_source_eligibility.v2', 'status': 'held',
        'capture_id': None, 'pool_id': None, 'checked_utc_claim': None,
        'frozen_weekly_eligibility_replayed': False, 'upstream_eligibility_verified': False,
        'MY_card_semantics_verified': False, 'whole_release_pass': False, 'owner_authenticated': False,
        'provider_authenticated': False, 'provider_completeness_verified': False,
        'earlier_weekly_producer_reads_verified': False, 'publication_authorized': False,
        'weekly_points_lost_rederived': False,
        'production_authorized': False, 'public_serving_verified': False,
        'source_writes': False, 'network_used': False, 'coverage': {}, 'reason_codes': []}
    try:
        coverage, holds = _facts(capture, pool, checked_utc)
        report.update(status='frozen_weekly_eligibility_replayed_policy_held' if holds
            else 'frozen_weekly_eligibility_replayed_not_release', frozen_weekly_eligibility_replayed=True,
            capture_id=capture['capture_id'], pool_id=gate.fingerprint(pool), checked_utc_claim=checked_utc,
            coverage=coverage, reason_codes=holds)
    except gate.GateError as error:
        report['reason_codes'] = [str(error)]
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        report['reason_codes'] = ['period_sources_malformed_or_unavailable']
    return gate._seal(report, 'eligibility_report_id')
