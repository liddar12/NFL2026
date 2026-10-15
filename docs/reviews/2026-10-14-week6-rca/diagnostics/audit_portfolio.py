"""Read-only enumeration of shared-game risk in one saved Week-card generation."""
import collections
import datetime as dt
import itertools
import json
import math
from pathlib import Path
import subprocess
import sys

ROOT = Path(sys.argv[1]).resolve()
AUDIT_BASELINE = 'fb8830ae35f1e11d3f589b435e303b719886e3e7'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == AUDIT_BASELINE, 'Use an isolated checkout at the pinned audit baseline.'
REVIEW = json.loads((ROOT / 'data/review.json').read_text())

def load_at(rev, path):
    return json.loads(subprocess.check_output(['git','show',rev+':'+path],cwd=ROOT,text=True))

def evaluate(rev, week):
    doc=load_at(rev,'data/parlays.json')
    cards=[c for c in doc['parlays'] if c['scope']=='week']
    assert len(cards)==18
    probabilities={}
    picks=[]
    for card in cards:
        selections=[]
        for leg in card['legs']:
            assert leg['market']=='moneyline'
            selection=leg['selection']
            p=float(leg['model_prob'])
            if selection in probabilities:
                assert probabilities[selection]==p, 'Mixed probability vintages'
            probabilities[selection]=p
            selections.append(selection)
        assert len(selections)==len(set(selections))
        picks.append(selections)
    names=sorted(probabilities)
    index={name:i for i,name in enumerate(names)}
    masks=[sum(1<<index[name] for name in nameset) for nameset in picks]
    distribution=collections.defaultdict(float)
    joint=[]
    for nameset in picks:
        joint.append(math.prod(probabilities[name] for name in nameset))
    for mask in range(1<<len(names)):
        p=math.prod(probabilities[name] if mask&(1<<i) else 1-probabilities[name]
                    for i,name in enumerate(names))
        wins=sum((mask&cardmask)==cardmask for cardmask in masks)
        distribution[wins]+=p
    assert math.isclose(sum(distribution.values()),1,abs_tol=1e-10)
    expectation=sum(n*p for n,p in distribution.items())
    assert math.isclose(expectation,sum(joint),abs_tol=1e-10)
    variance=sum((n-expectation)**2*p for n,p in distribution.items())
    independent_card_zero=math.prod(1-p for p in joint)
    observed=None
    if str(week) in REVIEW['weeks']:
        finals={}
        for game in REVIEW['weeks'][str(week)]['games']:
            if game.get('final'):
                finals[game['home']+' ML']=game['final']['winner']==game['home']
                finals[game['away']+' ML']=game['final']['winner']==game['away']
        if all(name in finals for name in names):
            actual=sum(all(finals[name] for name in nameset) for nameset in picks)
            observed={'all_hit_original_game_outcomes':actual,
                      'p_wins_at_most_observed_under_saved_model':sum(p for n,p in distribution.items() if n<=actual),
                      'losing_selections':[name for name in names if not finals[name]]}
    exposures=collections.Counter(name for nameset in picks for name in nameset)
    return {'week':week,'revision':rev,'generated_utc':doc.get('updated_utc'),
            'cards':len(cards),'unique_game_selections':len(names),
            'assumptions':['Saved favorite probabilities from a single generation; cross-game outcomes independent as in shipped Week model.',
                           'Shared game outcome reused across all cards; original game winners, no retrospective administrative exclusions.',
                           'Model-implied risk, not externally validated true probabilities or a causal accuracy test.'],
            'probabilities':probabilities,'exposures':dict(exposures.most_common()),
            'expected_wins':expectation,'sd_wins':math.sqrt(variance),
            'p_zero_winners_shared_games':distribution[0],
            'p_zero_if_incorrectly_independent_cards':independent_card_zero,
            'p_at_least_15_winners':sum(p for n,p in distribution.items() if n>=15),
            'distribution':dict(sorted(distribution.items())),'observed':observed}

print(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
 'cohorts':[evaluate('be5e4643da7a152d3c9bf2ae4988b6a7c31a763d',5),evaluate('fb8830ae',6)]},indent=2))
