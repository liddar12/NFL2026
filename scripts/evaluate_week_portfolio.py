"""Read-only comparison of offered Week cards and a constrained shadow set.

No data files, selection defaults, archives or production settings are changed.
Prints JSON to stdout. This is model-implied risk, not a retrospective claim of
increased prediction accuracy. Usage: python3 scripts/evaluate_week_portfolio.py
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.models.portfolio import portfolio_risk, select_constrained


def compare_week_portfolios(game_doc, parlay_doc, excluded_ids=(), max_event_share=.5):
    if (game_doc['season'], game_doc['week']) != (parlay_doc['season'], parlay_doc['week']):
        raise ValueError('Game and parlay generations have different season/week')
    if game_doc['updated_utc'] != parlay_doc['updated_utc']:
        raise ValueError('Game and parlay generations have different timestamps')
    asof = dt.datetime.fromisoformat(parlay_doc['updated_utc'].replace('Z', '+00:00'))
    if asof.tzinfo is None:
        raise ValueError('Decision cutoff must include a timezone')
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
        kickoff = dt.datetime.fromisoformat(game['kickoff_utc'].replace('Z', '+00:00'))
        if kickoff.tzinfo is None:
            raise ValueError('Kickoff must include a timezone')
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--max-event-share', type=float, default=.5)
    args = parser.parse_args()
    read = lambda path: json.loads((args.repo / path).read_text())
    result = compare_week_portfolios(read('data/game_predictions.json'), read('data/parlays.json'),
                                    [g['game_id'] for g in read('config/excluded_games.json')['games']],
                                    args.max_event_share)
    print(json.dumps(result, indent=2, ensure_ascii=True))


if __name__ == '__main__':
    main()
