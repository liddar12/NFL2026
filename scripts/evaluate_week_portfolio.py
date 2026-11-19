"""Read-only comparison of offered Week cards and a constrained shadow set.

No data files, selection defaults, archives or production settings are changed.
Prints JSON to stdout. This is model-implied risk, not a retrospective claim of
increased prediction accuracy. Usage: python3 scripts/evaluate_week_portfolio.py
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.models.portfolio import portfolio_risk, select_constrained
from scripts.models.parlay_builder import build_week_parlays_multi


def _instant(value):
    stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Decision and kickoff timestamps must include a timezone')
    return stamp


def compare_week_portfolios(game_doc, parlay_doc, excluded_ids=(), max_event_share=.5):
    if (game_doc['season'], game_doc['week']) != (parlay_doc['season'], parlay_doc['week']):
        raise ValueError('Game and parlay generations have different season/week')
    if game_doc['updated_utc'] != parlay_doc['updated_utc']:
        raise ValueError('Game and parlay generations have different timestamps')
    asof = _instant(parlay_doc['updated_utc'])
    games = {str(g['game_id']): g for g in game_doc['games']}
    team_games = {}
    for gid, game in games.items():
        for side in ('home', 'away'):
            team_games.setdefault(game[side], set()).add(gid)
    events, cards = [], []
    for i, card in enumerate(parlay_doc['parlays']):
        if card['scope'] != 'week':
            continue
        ids = []
        for leg in card['legs']:
            if leg['market'] != 'moneyline':
                raise ValueError('Exact Week portfolio comparison requires moneyline selections')
            team = leg['selection'].removesuffix(' ML')
            matches = team_games.get(team, set())
            if len(matches) != 1:
                raise ValueError('Selection cannot be mapped to one event')
            gid = next(iter(matches))
            events.append({'event_id': gid, 'selection': leg['selection'], 'probability': leg['model_prob']})
            ids.append(gid)
        cards.append({'card_id': str(card.get('card_id') or card.get('parlay_id') or i), 'event_ids': ids})
    active = portfolio_risk(events, cards)
    candidates = []
    excluded = set(map(str, excluded_ids))
    for gid, game in sorted(games.items()):
        kickoff = _instant(game['kickoff_utc'])
        if gid in excluded or kickoff <= asof:
            continue
        side = 'home' if game['probs']['home'] >= game['probs']['away'] else 'away'
        candidates.append({'event_id': gid, 'selection': game[side] + ' ML',
                           'probability': game['probs'][side]})
    proposal = select_constrained(candidates, max_event_share=max_event_share)
    return {'season': game_doc['season'], 'week': game_doc['week'],
            'decision_cutoff_utc': parlay_doc['updated_utc'],
            'state': 'shadow_only_not_served', 'active': active, 'candidate_events': candidates,
            'candidate': proposal,
            'caveat': 'Different portfolio, not a proven accuracy gain. Original cards remain unchanged; no market prices enter ranking.'}


def _grade_cards(cards, events, finals):
    result = Counter(dict.fromkeys(('full_hit', 'miss', 'unresolved'), 0))
    for card in cards:
        winners = [finals.get(gid) for gid in card['event_ids']]
        if None in winners:
            outcome = 'unresolved'
        elif any(f'{w} ML' != events[gid]['selection']
                 for gid, w in zip(card['event_ids'], winners)):
            outcome = 'miss'
        else:
            outcome = 'full_hit'
        result[outcome] += 1
    return dict(result)


def _final_winners(review, games):
    winners = {}
    for row in review.get('games', []):
        gid = str(row['game_id'])
        game = games.get(gid)
        final = row.get('final')
        if not game or row.get('status') != 'STATUS_FINAL' or not isinstance(final, dict):
            continue
        if (row['home'], row['away']) != (game['home'], game['away']):
            continue
        home, away = final.get('home_score'), final.get('away_score')
        if type(home) is not int or type(away) is not int or min(home, away) < 0 or home == away:
            continue
        winner = game['home'] if home > away else game['away']
        if final.get('winner') == winner:
            if gid in winners and winner != winners[gid]:
                raise ValueError(f'Conflicting final scores for game {gid}')
            winners[gid] = winner
    return winners


def _historical_snapshot_paths(directory):
    snapshots = {}
    for path in sorted(directory.glob('game_predictions.*.json')):
        capture_utc = dt.datetime.strptime(path.name.split('.')[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        raw = path.read_bytes()
        doc = json.loads(raw)
        generated = _instant(doc['updated_utc'])
        if doc['games'] and generated <= capture_utc < min(_instant(g['kickoff_utc']) for g in doc['games']):
            snapshots.setdefault((doc['season'], doc['week']), []).append((generated, capture_utc, path, raw, doc))
    return snapshots


def replay_week_portfolios(repo, first_week, last_week, max_event_share=.5):
    """Replay two current rules with the same retained pre-slate forecasts."""
    schedule = json.loads((repo / 'data/schedule_full.json').read_bytes())
    review_raw = (repo / 'data/review.json').read_bytes()
    review = json.loads(review_raw)
    exclusions = json.loads((repo / 'config/excluded_games.json').read_bytes())['games']
    season = schedule['season']
    if review['season'] != season:
        raise ValueError('Outcome review and schedule seasons differ')
    snapshots = _historical_snapshot_paths(repo / 'data/snapshots')
    weeks = []
    for week in range(first_week, last_week + 1):
        games = {str(g['game_id']): g for g in schedule['games'] if g['week'] == week}
        first_kickoff = min((_instant(g['kickoff_utc']) for g in games.values()), default=None)
        fixtures = {gid: (g['home'], g['away']) for gid, g in games.items()}
        selected = next((row for row in sorted(snapshots.get((season, week), []), reverse=True)
                         if first_kickoff and row[1] < first_kickoff and len(row[4]['games']) == len(fixtures)
                         and {str(g['game_id']): (g['home'], g['away']) for g in row[4]['games']} == fixtures), None)
        if not selected:
            weeks.append({'week': week, 'status': 'complete_pre_kickoff_snapshot_missing'})
            continue
        generated_utc, capture_utc, path, raw, forecast = selected
        excluded = {str(g['game_id']) for g in exclusions if g['season'] == season and g['week'] == week
                    and _instant(g['added_utc']) <= generated_utc}
        eligible_games = [g for g in forecast['games'] if str(g['game_id']) not in excluded]
        control = build_week_parlays_multi(eligible_games)
        comparison = compare_week_portfolios(
            forecast, {**forecast, 'parlays': control}, excluded, max_event_share,
        )
        candidate = comparison['candidate']
        evidence = {'week': week, 'snapshot': path.name,
                    'snapshot_sha256': hashlib.sha256(raw).hexdigest(),
                    'generated_utc': forecast['updated_utc'], 'captured_utc': capture_utc.isoformat(),
                    'excluded_as_of': sorted(excluded)}
        if not candidate['complete']:
            weeks.append({**evidence, 'status': candidate['reason']})
            continue
        event_map = {e['event_id']: e for e in comparison['candidate_events']}
        by_selection = {e['selection']: gid for gid, e in event_map.items()}
        control_cards = [{'event_ids': [by_selection[l['selection']] for l in c['legs']]} for c in control]
        if sorted(len(c['event_ids']) for c in control_cards) != sorted(
                len(c['event_ids']) for c in candidate['offered_cards']):
            raise ValueError('Control and candidate card counts differ by leg size')
        finals = _final_winners(review['weeks'].get(str(week), {}), games)
        weeks.append({**evidence, 'status': 'compared', 'control_risk': comparison['active'],
                      'candidate_risk': candidate['risk'],
                      'control_cards': control_cards, 'candidate_cards': candidate['offered_cards'],
                      'finals': finals,
                      'control_grades': _grade_cards(control_cards, event_map, finals),
                      'candidate_grades': _grade_cards(candidate['offered_cards'], event_map, finals)})
    complete_weeks = [w for w in weeks if w['status'] == 'compared'
                      and not (w['control_grades']['unresolved'] or w['candidate_grades']['unresolved'])]
    summary = {'paired_graded_weeks': [w['week'] for w in complete_weeks]}
    for policy in ('control', 'candidate'):
        grades = [w[f'{policy}_grades'] for w in complete_weeks]
        summary[policy] = {'full_hits': sum(g['full_hit'] for g in grades),
                           'graded_cards': sum(g['full_hit'] + g['miss'] for g in grades),
                           'zero_hit_weeks': [w['week'] for w in complete_weeks
                                              if w[f'{policy}_grades']['full_hit'] == 0]}
    return {'season': season, 'basis': 'retrospective_reconstructed_week_moneylines',
            'control': 'current_highest_probability_without_market_prices', 'max_event_share': max_event_share,
            'review_sha256': hashlib.sha256(review_raw).hexdigest(),
            'review_generated_utc': review['generated_utc'],
            'summary': summary, 'weeks': weeks, 'adoption_approved': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--max-event-share', type=float, default=.5)
    parser.add_argument('--replay', nargs=2, type=int, metavar=('FIRST_WEEK', 'LAST_WEEK'))
    args = parser.parse_args()
    if args.replay:
        first, last = args.replay
        if not 1 <= first <= last <= 18:
            parser.error('replay requires an ordered range of regular-season weeks')
        print(json.dumps(replay_week_portfolios(args.repo, first, last, args.max_event_share), indent=2))
        return
    read = lambda path: json.loads((args.repo / path).read_text())
    result = compare_week_portfolios(read('data/game_predictions.json'), read('data/parlays.json'),
                                    [g['game_id'] for g in read('config/excluded_games.json')['games']],
                                    args.max_event_share)
    print(json.dumps(result, indent=2, ensure_ascii=True))


if __name__ == '__main__':
    main()
