"""Proposed MY freshness policies, evaluated in shadow only.

No profile is selected by default. These bounded, versioned proposals let an
operator inspect the pending Sunday choice without adopting it. Existing v1
and period-v2 serving/publication behavior is unchanged. An empty or merely
nonempty ESPN inactive array cannot establish official posting/completeness.
"""
import datetime as dt

from scripts import build_weekly as weekly
from scripts import generation_semantic_gate as gate
from scripts import period_source_eligibility as sources

PROFILES = {
    'provisional_before_90m_v1': {
        'version': 1, 'mode': 'provisional_before_recheck',
        'depth_fetch_max_seconds': 12 * 3600,
        'depth_team_snapshot_max_seconds': 7 * 86400,
        'inactive_recheck_seconds_before_kickoff': 90 * 60,
        'inactive_observation_max_seconds': 15 * 60},
    'wait_for_confirmed_inactives_v1': {
        'version': 1, 'mode': 'wait_for_confirmation',
        'depth_fetch_max_seconds': 12 * 3600,
        'depth_team_snapshot_max_seconds': 7 * 86400,
        'inactive_recheck_seconds_before_kickoff': 90 * 60,
        'inactive_observation_max_seconds': 15 * 60},
}


def _stamp(value):
    return gate.lr.instant(value) if type(value) is str else None


def _clock(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def _depth(doc, player, projection, season, captured, checked, policy):
    """A team-local source refusal, never an invented medical zero."""
    if type(doc) is not dict or doc.get('season') != season:
        return 'depth_document_unknown', []
    fetched = _stamp(doc.get('updated_utc'))
    if fetched is None or not fetched <= captured <= checked:
        return 'depth_fetch_clock_unknown_or_future', []
    if (checked - fetched).total_seconds() >= policy['depth_fetch_max_seconds']:
        return 'depth_fetch_stale', []
    team = (doc.get('teams') or {}).get(player['team'])
    if type(team) is not dict:
        return 'depth_team_unknown', []
    issued = _stamp(team.get('snapshot'))
    if issued is None or issued > fetched:
        return 'depth_team_snapshot_clock_unknown_or_future', []
    if (checked - issued).total_seconds() >= policy['depth_team_snapshot_max_seconds']:
        return 'depth_team_snapshot_stale', []
    chart = team.get('QB')
    if type(chart) is not list or not chart or len(chart) > 32:
        return 'depth_QB_chart_unknown', []
    ids = weekly._proj_ids(projection)
    matching = [r for r in chart if type(r) is dict and ids.intersection(weekly._depth_row_ids(r))]
    if len(matching) != 1:
        return 'depth_QB_explicit_identity_unknown_or_ambiguous', []
    if type(matching[0].get('rank')) is not int or not 1 <= matching[0]['rank'] <= 32:
        return 'depth_QB_rank_unknown', []
    return None, [fetched + dt.timedelta(seconds=policy['depth_fetch_max_seconds']),
        issued + dt.timedelta(seconds=policy['depth_team_snapshot_max_seconds'])]


def _inactive_observation(doc, game, season, week, captured, checked, policy):
    """Observation only, with no 'posted' inference from zero/nonzero rows."""
    result = {'state': 'not_captured', 'players_observed': None, 'confirmation_verified': False}
    if doc is None:
        return result
    if type(doc) is not dict or doc.get('season') != season or doc.get('week') != week:
        return {**result, 'state': 'wrong_or_unknown_period'}
    rows = [r for r in doc.get('games') or [] if type(r) is dict and r.get('game_id') == game['game_id']]
    if len(rows) != 1:
        return {**result, 'state': 'game_missing_or_ambiguous'}
    row, = rows
    if any(row.get(k) != game.get(k) for k in ('home', 'away', 'kickoff_utc')):
        return {**result, 'state': 'game_identity_conflict'}
    fetched = _stamp(row.get('fetched_utc'))
    issued = _stamp(doc.get('updated_utc'))
    if fetched is None or issued is None or not fetched <= issued <= captured <= checked:
        return {**result, 'state': 'clock_unknown_or_future'}
    if (checked - fetched).total_seconds() >= policy['inactive_observation_max_seconds']:
        return {**result, 'state': 'observation_stale'}
    teams = row.get('inactive')
    if type(teams) is not dict or set(teams) != {game['home'], game['away']} or not all(
            type(players) is list for players in teams.values()):
        return {**result, 'state': 'team_membership_unknown'}
    return {**result, 'state': 'provider_rows_observed_confirmation_unknown',
        'players_observed': sum(map(len, teams.values()))}


def assess(capture, pool, *, profile=None, checked_utc):
    """Read-only proposed policy assessment, never an approval capability.

    QB source ages are explicit proposals, not fitted/validated thresholds.
    A final consumer must pin a reviewed selection in its approved code/scope,
    enforce its next-check boundary in producers/UI, and bind complete posted
    evidence. This shadow API cannot clear the current publication hold.
    """
    report = {'version': 1, 'kind': 'nfl.proposed_MY_freshness_policy.v1', 'status': 'held',
        'profile': None, 'policy_id': None, 'capture_id': None, 'pool_id': None,
        'proposed_parameters': None,
        'checked_utc_claim': None, 'shadow_policy_pass': False, 'games': [],
        'factual_source_report_id': None, 'factual_source_reason_codes': [],
        'next_check_utc': None, 'blocked_player_ids': [], 'reason_codes': [],
        'shadow_only': True, 'profile_selected_for_serving': False, 'owner_approved': False,
        'inactive_confirmation_verified': False, 'upstream_eligibility_verified': False,
        'MY_card_semantics_verified': False, 'publication_authorized': False,
        'production_authorized': False, 'public_serving_verified': False,
        'source_writes': False, 'network_used': False}
    try:
        # Clone once; no caller-owned mutable object can change the later read.
        capture, pool = gate._plain(capture), gate._plain(pool)
        factual = sources.verify(capture, pool, checked_utc=checked_utc)
        report.update(factual_source_report_id=factual['eligibility_report_id'],
            factual_source_reason_codes=factual['reason_codes'])
        gate.need(factual['frozen_weekly_eligibility_replayed'], 'freshness_policy_source_facts_held')
        gate.need(type(profile) is str and profile in PROFILES, 'freshness_policy_profile_not_selected')
        policy = gate._plain(PROFILES[profile])
        original, docs = gate._capture(capture)
        captured, checked = gate._time(original['captured_utc_claim']), gate._time(checked_utc)
        report.update(profile=profile, proposed_parameters=policy,
            policy_id=gate.fingerprint({'profile': profile, **policy}),
            capture_id=original['capture_id'], pool_id=gate.fingerprint(pool), checked_utc_claim=checked_utc)
        players = pool['players']
        gate.need(players and len(players) <= 2000, 'freshness_policy_supported_population_missing_or_oversized')
        roster = {p['gsis_id']: p for p in docs['player_projections']['players']}
        schedule = {g['game_id']: g for g in docs['schedule']['games']}
        by_game = {}
        for player in players:
            by_game.setdefault(player['game_id'], []).append(player)
        blocked, checkpoints, reasons = set(), [], set()
        for gid, members in sorted(by_game.items()):
            game = schedule[gid];kickoff = gate._time(game['kickoff_utc'])
            checkpoint = kickoff - dt.timedelta(seconds=policy['inactive_recheck_seconds_before_kickoff'])
            game_reasons, bad_qbs, clocks = set(), [], []
            for player in members:
                if player['position'] != 'QB':
                    continue
                reason, limits = _depth(docs['depth_chart'], player, roster[player['gsis_id']],
                    original['season'], captured, checked, policy)
                if reason:
                    bad_qbs.append(player['gsis_id']);blocked.add(player['gsis_id']);game_reasons.add(reason)
                    clocks.append(checked)
                else:
                    clocks.extend(limits)
            observed = _inactive_observation(docs['inactives'], game, original['season'], original['week'],
                captured, checked, policy)
            provisional = policy['mode'] == 'provisional_before_recheck' and checked < checkpoint
            if provisional:
                state = 'provisional_before_inactive_recheck'
                clocks.append(checkpoint)
            else:
                state = 'held_inactive_confirmation_unbound'
                game_reasons.add('inactive_confirmation_not_bound')
                blocked.update(p['gsis_id'] for p in members)
                clocks.append(checkpoint if checked < checkpoint else checked)
            if bad_qbs:
                state = 'held_QB_source_for_affected_players'
            reasons.update(game_reasons);checkpoints.extend(clocks)
            report['games'].append({'game_id': gid, 'state': state,
                'provisional': provisional, 'inactive_check_due_utc': _clock(checkpoint),
                'affected_QB_player_ids': sorted(bad_qbs), 'inactive_observation': observed,
                'reason_codes': sorted(game_reasons)})
        for name in ('player_weekly', 'player_projections', 'game_predictions', 'schedule'):
            doc = docs[name];stamp = gate._time(doc.get('generated_utc') or doc.get('updated_utc'))
            checkpoints.append(stamp + dt.timedelta(hours=12))
        injury = docs['injuries']
        checkpoints.extend(gate._time(injury[k]) + dt.timedelta(hours=12)
            for k in ('source_updated_utc', 'received_utc'))
        deadline = min(checkpoints) if checkpoints else None
        if not blocked and deadline is not None and deadline <= checked:
            blocked.update(p['gsis_id'] for p in players)
            reasons.add('freshness_policy_recheck_due')
        report.update(status='shadow_provisional_policy_pass_not_adopted' if not blocked
            else 'shadow_policy_held_not_adopted', shadow_policy_pass=not blocked,
            blocked_player_ids=sorted(blocked), reason_codes=sorted(reasons),
            next_check_utc=_clock(deadline) if deadline is not None else None)
    except gate.GateError as error:
        report['reason_codes'] = [str(error)]
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        report['reason_codes'] = ['freshness_policy_malformed_or_unavailable']
    return gate._seal(report, 'freshness_assessment_id')
