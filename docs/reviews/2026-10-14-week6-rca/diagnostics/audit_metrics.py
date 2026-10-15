#!/usr/bin/env python3
"""Read-only audit of committed NFL2026 predictions. Outputs only this directory."""
import collections
import datetime as dt
import hashlib
import json
import math
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
AUDIT_BASELINE = 'fb8830ae35f1e11d3f589b435e303b719886e3e7'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == AUDIT_BASELINE, 'Use an isolated checkout at the pinned audit baseline.'
sys.path.insert(0, str(ROOT))
from scripts.build_parlay_archive import card_id, earliest_kickoff, ledger_game_index, week_kickoffs

def read(p):
    return json.loads((ROOT / p).read_text())

def moment(x):
    return dt.datetime.fromisoformat(x.replace('Z', '+00:00'))

def div(a, b):
    return round(a / b, 6) if b else None

def stat(cards):
    buckets = collections.Counter(x['bucket'] for x in cards)
    legs = [l for c in cards for l in c['legs']]
    binary = [l for l in legs if l['result'] in ('hit', 'miss')]
    unique = {(l.get('game_id'), l['market'], l['selection']): l for l in binary}
    return dict(n=len(cards), buckets=dict(buckets), hit_rate_all=div(buckets['all_hit'], len(cards)),
                hit_rate_no_push=div(buckets['all_hit'], len(cards)-buckets['push']-buckets['pending']),
                legs=dict(collections.Counter(l['result'] for l in legs)),
                leg_occurrence_rate=div(sum(l['result']=='hit' for l in binary),len(binary)),
                unique_legs=len(unique),unique_leg_hit_rate=div(sum(l['result']=='hit' for l in unique.values()),len(unique)))

review = read('data/review.json')
ledger = read('data/estimates/parlays_2026.json')
leg_scores = read('data/parlay_leg_scores.json')
schedule = read('data/schedule_full.json')['games']
games = {str(g['game_id']): g for g in schedule}
archives = {w: read(f'data/parlays/2026_wk{w:02d}.json') for w in range(1,6)}
led_idx = {(r['week'],r['market'],r['selection']):r for r in ledger['legs']}
outcomes = {(r['week'],r['game_id'],r['market'],r['selection']):r for r in leg_scores['resolved']}

def missing_game(week, leg):
    row = led_idx.get((week, leg['market'],leg['selection']), {})
    return row.get('game_id')

def concentration(cards):
    exposures = collections.defaultdict(lambda:dict(cards=set(), misses=set(), hits=set(), p=[]))
    game_exp = collections.defaultdict(lambda:dict(cards=set(), loses=set()))
    for c in cards:
        for l in c['legs']:
            key = (str(l.get('game_id')), l['market'], l['selection'])
            row = exposures[key]
            row['cards'].add(c['card_id'])
            if l['result']=='miss': row['misses'].add(c['card_id'])
            if l['result']=='hit': row['hits'].add(c['card_id'])
            game_exp[key[0]]['cards'].add(c['card_id'])
            if l['result']=='miss': game_exp[key[0]]['loses'].add(c['card_id'])
    result = []
    for key,x in exposures.items():
        result.append(dict(game_id=key[0],market=key[1],selection=key[2],cards=len(x['cards']),misses=len(x['misses']),hits=len(x['hits'])))
    game_result = []
    for gid,x in game_exp.items():
        g=games.get(gid,{})
        game_result.append(dict(game_id=gid,matchup=f"{g.get('away')} @ {g.get('home')}",cards=len(x['cards']),cards_with_loss=len(x['loses'])))
    return dict(legs=sorted(result,key=lambda r:(-r['misses'],-r['cards'])),games=sorted(game_result,key=lambda r:-r['cards_with_loss']))

result = dict(head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(), generated=review['generated_utc'], weekly={}, my={}, concentration={})
for week in range(1,6):
    rv=review['weeks'][str(week)]
    cards=rv['parlays']
    wk=dict(all=stat(cards),by_scope={scope:stat([c for c in cards if c['scope']==scope]) for scope in ['week','game']},game_picks=rv['summary']['picks'])
    legs=[l for l in leg_scores['resolved'] if l['week']==week]
    wk['locked_legs']=dict(n=len(legs),hit=sum(l['hit'] for l in legs),hit_rate=div(sum(l['hit'] for l in legs),len(legs)),mean_model=div(sum(l['model_prob'] for l in legs),len(legs)),by_market={})
    for market in sorted({l['market'] for l in legs}):
        ls=[l for l in legs if l['market']==market]
        wk['locked_legs']['by_market'][market]=dict(n=len(ls),hit=sum(l['hit'] for l in ls),mean_model=div(sum(l['model_prob'] for l in ls),len(ls)))
    wk['archive']=dict(n=len(archives[week]['parlays']),first_history=archives[week]['history'][0],last_history=archives[week]['history'][-1])
    wk['expected_wins_descriptive_only']={}
    for scope in ['game','week']:
        selected=[c for c in cards if c['scope']==scope and all(l['result'] in ('hit','miss') for l in c['legs'])]
        arc={c['card_id']:c for c in archives[week]['parlays']}
        ps=[max(0,min(1,(1+arc[c['card_id']]['model_ev'])*math.prod(l['implied_prob'] for l in arc[c['card_id']]['legs']))) for c in selected]
        wk['expected_wins_descriptive_only'][scope]=dict(n=len(selected),hit=sum(c['bucket']=='all_hit' for c in selected),expected=round(sum(ps),4),mean_model=div(sum(ps),len(ps)),note='Inferred from rounded archived EV and leg implied prices; provenance checked separately. Every card with any void or pending leg excluded; remaining sample is conditional on absence of voids.')
    result['weekly'][week]=wk
    if week==5:
        result['concentration']={s:concentration([c for c in cards if c['scope']==s]) for s in ['week','game']}

my=read('data/my_card_scores.json')
for week in range(2,6):
    recorded=read(f'data/my_cards/2026_wk{week:02d}.json')['cards']
    ars={c['card_id']:c for c in recorded}
    cards=[c for c in my['cards'] if c['week']==week]
    for c in cards:
        source=ars[c['card_id']]
        for l,sl in zip(c['legs'],source['legs']):
            assert l['selection']==sl['selection']
            l['game_id']=str(sl['game_id'])
    unique={tuple(sorted((l['game_id'],l['market'],l['selection']) for l in c['legs'])):c for c in cards}
    clean=[c for c in cards if all(l['result'] in ('hit','miss') for l in c['legs'])]
    result['my'][week]=dict(all=stat(cards),unique_combinations=stat(list(unique.values())),expected_clean=round(sum(c['model'] for c in clean),4),n_clean=len(clean),hit_clean=sum(c['bucket']=='all_hit' for c in clean),unique_games=len({l['game_id'] for c in cards for l in c['legs']}),by_dial={})
    for dial in ['safe','even','longshot']:
        chosen=[c for c in cards if c['dial']==dial]
        clean=[c for c in chosen if all(l['result'] in ('hit','miss') for l in c['legs'])]
        result['my'][week]['by_dial'][dial]=dict(stats=stat(chosen),expected_clean=round(sum(c['model'] for c in clean),4),n_clean=len(clean),hit_clean=sum(c['bucket']=='all_hit' for c in clean))
    if week==5:
        result['my'][week]['concentration']=concentration(cards)
        result['my'][week]['safe_concentration']=concentration([c for c in cards if c['dial']=='safe'])

out=pathlib.Path(__file__).resolve().parent.parent/'evidence'/'metrics.json'
out.write_text(json.dumps(result,indent=2)+'\n')
print(out)
for w,x in result['weekly'].items():
    print('WEEK',w,json.dumps({k:x[k] for k in ['by_scope','locked_legs','expected_wins_descriptive_only']}))
print('WEEK5_CONCENTRATION',json.dumps(result['concentration']))
print('MY_SUMMARY',json.dumps({w:{k:v for k,v in x.items() if 'concentration' not in k} for w,x in result['my'].items()}))
print('MY_WEEK5_TOP_MISSED',json.dumps(result['my'][5]['concentration']['legs'][:15]))
print('MY_WEEK5_SAFE_TOP_MISSED',json.dumps(result['my'][5]['safe_concentration']['legs'][:15]))
