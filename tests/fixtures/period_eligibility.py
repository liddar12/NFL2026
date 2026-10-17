"""Actual weekly-gate producer fixtures; not period adoption or accuracy proof.

The pool is a normal real pool restricted to future games for this pure source
diagnostic. It is NOT presented as an approved period application; that separate
actual producer/fitter/owner path has its own integration tests.
"""
import copy
from pathlib import Path

from scripts import availability as A, build_leg_pool as B, build_weekly as W
from scripts import build_predictions as P, generation_semantic_gate as G

SOURCE = '2026-10-16T19:00:00Z'
WEEKLY = '2026-10-16T19:30:00Z'
CAPTURE = '2026-10-16T20:00:00Z'
GENERATED = '2026-10-16T20:01:00Z'
CHECKED = '2026-10-16T20:02:00Z'


def weekly(docs, *, omit_depth=False):
    players = docs['player_projections']['players']
    components = {p['gsis_id']: {'components': {'rec_yd': 80., 'pass_yd': 220.},
        'base_applied_pts': 100.} for p in players}
    return W.build_weekly_document(players, docs['schedule']['games'],
        {team: 1500. for team in ('SEA', 'LAR', 'DAL', 'PHI', 'KC', 'BUF')}, {}, 2026, WEEKLY,
        injuries=[], first_week=6, components_by_id=components, factors=W.build_factors(2026),
        this_week=6, injury_document=docs['injuries'],
        depth_chart=None if omit_depth else docs['depth_chart'], inactives=docs['inactives'],
        gate_skip_teams=('BUF', 'KC'))


def refresh(docs):
    inputs = {name: copy.deepcopy(docs[name]) for name in Bnames}
    inputs.update(excluded_games=set(), generated_utc=GENERATED, generation_sha='synthetic-source-diagnostic')
    pool = B.build(inputs)
    future = {g['game_id'] for g in docs['schedule']['games'] if g['status'] == 'STATUS_SCHEDULED'}
    pool['players'] = [p for p in pool['players'] if p['game_id'] in future]
    capture = G.capture_inputs({k: G.encoded(v) for k, v in docs.items()},
        {name: Path(name).read_bytes() for name in G.CODE_NAMES}, season=2026, week=6,
        captured_utc=CAPTURE, generation_sha='synthetic-source-diagnostic', policy=G.POLICY)
    return {'docs': docs, 'pool': pool, 'capture': capture}


Bnames = ('player_weekly', 'player_projections', 'game_predictions', 'pool_backtest',
    'parlays', 'atd_week', 'atd_backtest')


def make(*, unknown=False, questionable=False, retired=False, qb=False, inactive=False, window=False):
    players = [{'gsis_id': 'espn-' + str(n), 'name': 'Synthetic Source Player ' + str(n),
        'team': team, 'position': 'QB' if qb and n == 1 else 'WR', 'proj_points': 100.}
        for n, team in enumerate(('SEA', 'LAR', 'DAL', 'PHI', 'KC', 'BUF'), 1)]
    if qb:
        players.append({'gsis_id': 'espn-7', 'name': 'Synthetic Source QB Two',
            'team': 'SEA', 'position': 'QB', 'proj_points': 100.})
    raw = [{'team': p['team'], 'player': p['name'], 'athlete_id': p['gsis_id'][5:],
        'status': 'Reserve-Ret' if retired and n == 0 else 'Questionable' if questionable and n == 0 else 'Active'}
        for n, p in enumerate(players)]
    injury = A.enrich_document({'updated_utc': SOURCE, 'source': 'synthetic-espn-shape', 'injuries': raw})
    injury.update(season=2026, week=6, source_updated_utc=SOURCE, received_utc=SOURCE,
        quarantine=[{'athlete_id': '1', 'status': 'SYNTHETIC_UNKNOWN', 'reason': 'unmapped_status'}] if unknown else [])
    games = [{'game_id': 'SOURCE-G' + str(i), 'season': 2026, 'week': 6, 'home': home, 'away': away,
        'status': 'STATUS_FINAL' if i == 3 else 'STATUS_SCHEDULED',
        'kickoff_utc': '2026-10-15T00:15:00Z' if i == 3 else '2026-10-16T22:00:00Z' if window
            else '2026-10-18T17:00:00Z',
        'roof': 'outdoor', 'model': 'synthetic-prior', 'estimate': True, 'probs': {'home': .6, 'away': .4}}
        for i, (home, away) in enumerate((('SEA', 'LAR'), ('DAL', 'PHI'), ('KC', 'BUF')), 1)]
    calibration = {pos: {'a': 0., 'b': 1., 'c': 0.} for pos in ('QB', 'RB', 'WR')}
    depth = {'season': 2026, 'updated_utc': SOURCE, 'teams': {'SEA': {'snapshot': SOURCE, 'QB': [
        {'rank': 1, 'name': players[0]['name'], 'gsis_id': 'espn-1', 'espn_id': '1'},
        {'rank': 2, 'name': players[-1]['name'], 'gsis_id': 'espn-7', 'espn_id': '7'}]}}} if qb else None
    inactives = {'season': 2026, 'week': 6, 'updated_utc': SOURCE, 'games': [{**games[0],
        'fetched_utc': SOURCE, 'inactive': {'SEA': [{'espn_id': '1', 'name': players[0]['name']}], 'LAR': []}}],
        'failed': []} if inactive else None
    docs = {'player_projections': {'season': 2026, 'updated_utc': WEEKLY, 'players': players},
        'game_predictions': {'season': 2026, 'week': 6, 'updated_utc': WEEKLY, 'games': P.week_game_rows(games, 6)},
        'pool_backtest': {'season': 2026, 'updated_utc': WEEKLY, 'model': 'synthetic-source-pool',
            'calibration': calibration, 'support': {p: [-5., 5.] for p in calibration},
            'residual_sd': {p: 50. for p in calibration}, 'ladder': {p: [19.5, 59.5, 99.5] for p in calibration},
            'verdict': {'adopt': True}},
        'parlays': {'season': 2026, 'week': 6, 'parlays': []}, 'atd_week': None, 'atd_backtest': None,
        'excluded_games': {'games': []}, 'schedule': {'season': 2026, 'updated_utc': SOURCE, 'games': games},
        'parlay_calibration': None, 'injuries': injury, 'depth_chart': depth, 'inactives': inactives,
        'previous_my_cards': None}
    docs['player_weekly'] = weekly(docs)
    return refresh(docs)
