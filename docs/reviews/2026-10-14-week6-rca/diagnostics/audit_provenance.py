#!/usr/bin/env python3
"""Reconstruct first committed card combinations and fixed pregame Week slates."""
import concurrent.futures
import collections
import datetime as dt
import json
import pathlib
import subprocess
import sys

ROOT=pathlib.Path(sys.argv[1]).resolve()
AUDIT_BASELINE = 'fb8830ae35f1e11d3f589b435e303b719886e3e7'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == AUDIT_BASELINE, 'Use an isolated checkout at the pinned audit baseline.'
sys.path.insert(0,str(ROOT))
from scripts.build_parlay_archive import card_id, earliest_kickoff, ledger_game_index, week_kickoffs
from scripts.build_review import parlay_bucket
from scripts.resolve_my_cards import grade_game

def read(path): return json.loads((ROOT/path).read_text())
def moment(x): return dt.datetime.fromisoformat(x.replace('Z','+00:00'))
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT,text=True)

review=read('data/review.json')
schedule=read('data/schedule_full.json')['games']
ledger=read('data/estimates/parlays_2026.json')
arcs={w:read(f'data/parlays/2026_wk{w:02d}.json') for w in range(1,6)}
contexts={w:(*week_kickoffs(schedule,w),ledger_game_index(ledger,w)) for w in range(1,7)}
jobs=[]
paths=['data/parlays.json']+[f'data/parlays/2026_wk{w:02d}.json' for w in range(1,6)]
for path in paths:
    for line in git('log','--format=%H %cI','--',path).splitlines():
        sha,stamp=line.split(' ')
        jobs.append((sha,stamp,path))

def get_doc(job):
    sha,stamp,path=job
    try: doc=json.loads(git('show',sha+':'+path))
    except (subprocess.CalledProcessError,ValueError): return None
    if doc.get('week') not in range(1,7): return None
    return dict(sha=sha,stamp=stamp,path=path,doc=doc)

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    documents=[d for d in pool.map(get_doc,jobs) if d]
documents.sort(key=lambda d:moment(d['stamp']))
first={}
price_first={}
for d in documents:
    w=d['doc']['week']
    for c in d['doc'].get('parlays',[]):
        key=(w,card_id(c))
        first.setdefault(key,dict(sha=d['sha'],committed=d['stamp'],document_updated=d['doc'].get('updated_utc'),path=d['path']))
        pricekey=key+(json.dumps(sorted((l.get('market'),l.get('selection'),l.get('model_prob'),l.get('implied_prob')) for l in c['legs']),sort_keys=True),)
        price_first.setdefault(pricekey,dict(sha=d['sha'],committed=d['stamp'],document_updated=d['doc'].get('updated_utc'),path=d['path']))

result=dict(baseline=git('rev-parse','HEAD').strip(),method='First Git committer timestamp for identical market+selection combinations; proves committed availability only, not Netlify serving. Exact archived price vector checked separately. Current FINAL outcomes and explicit current exclusions used for grading.',archive_provenance={},baseline_slates={})
for w,arc in arcs.items():
    details=[]
    rv={c['card_id']:c for c in review['weeks'][str(w)]['parlays']}
    for c in arc['parlays']:
        cid=card_id(c)
        f=first.get((w,cid))
        pricekey=(w,cid,json.dumps(sorted((l.get('market'),l.get('selection'),l.get('model_prob'),l.get('implied_prob')) for l in c['legs']),sort_keys=True))
        pf=price_first.get(pricekey)
        ko=earliest_kickoff(c,*contexts[w])
        before=bool(f and ko and moment(f['committed'])<ko)
        price_before=bool(pf and ko and moment(pf['committed'])<ko)
        details.append(dict(card_id=cid,parlay_id=c['parlay_id'],scope=c['scope'],first=f,exact_price_first=pf,earliest_kickoff=str(ko),identity_committed_pregame=before,archive_prices_committed_pregame=price_before,bucket=rv.get(cid,{}).get('bucket'),selections=[l['selection'] for l in c['legs']]))
    result['archive_provenance'][w]=dict(by_scope={},cards=details)
    for scope in ['week','game']:
        ss=[r for r in details if r['scope']==scope]
        preg=[r for r in ss if r['identity_committed_pregame']]
        pgprice=[r for r in ss if r['archive_prices_committed_pregame']]
        result['archive_provenance'][w]['by_scope'][scope]=dict(n=len(ss),identity_pregame=len(preg),identity_pregame_buckets=dict(collections.Counter(r['bucket'] for r in preg)),exact_prices_pregame=len(pgprice),exact_prices_pregame_buckets=dict(collections.Counter(r['bucket'] for r in pgprice)))

for w in range(1,6):
    gs=[g for g in schedule if g['week']==w]
    first_ko=min(moment(g['kickoff_utc']) for g in gs)
    sundays=[moment(g['kickoff_utc']) for g in gs if moment(g['kickoff_utc']).weekday()==6]
    sunday=max(set(sundays),key=sundays.count)
    result['baseline_slates'][w]={}
    final_index={g['game_id']:{**g['final'],'home':g['home'],'away':g['away'],'status':'STATUS_FINAL'} for g in review['weeks'][str(w)]['games'] if g.get('final')}
    excluded={str(g['game_id']) for g in read('config/excluded_games.json')['games'] if g['week']==w}
    for label,cutoff in [('before_first_game',first_ko),('before_sunday_main_window',sunday)]:
        ds=[d for d in documents if d['path']=='data/parlays.json' and d['doc']['week']==w and moment(d['stamp'])<cutoff]
        if not ds: continue
        d=max(ds,key=lambda d:moment(d['stamp']))
        cards=[]
        for c in d['doc']['parlays']:
            if c['scope']!='week': continue
            rs=[]
            original_rs=[]
            for l in c['legs']:
                gid=contexts[w][2].get((l['market'],l['selection'])) or contexts[w][1].get(l['selection'].split(' ')[0])
                g=next((g for g in gs if str(g['game_id'])==str(gid)),{})
                team=l['selection'].split(' ')[0]
                side=l.get('side') or ('home' if g.get('home')==team else 'away' if g.get('away')==team else None)
                graded=grade_game({**l,'game_id':gid,'team':team,'side':side},final_index)
                original_rs.append(graded[0])
                rs.append('void' if gid in excluded else graded[0])
            ko=earliest_kickoff(c,*contexts[w])
            cards.append(dict(card_id=card_id(c),parlay_id=c['parlay_id'],bucket_current_exclusions=parlay_bucket(rs),bucket_without_owner_exclusions=parlay_bucket(original_rs),available_at_snapshot=ko is not None and moment(d['stamp'])<ko,selections=[l['selection'] for l in c['legs']]))
        result['baseline_slates'][w][label]=dict(cutoff=str(cutoff),sha=d['sha'],committed=d['stamp'],updated=d['doc']['updated_utc'],cards=cards,buckets=dict(collections.Counter(c['bucket_current_exclusions'] for c in cards)),without_exclusions=dict(collections.Counter(c['bucket_without_owner_exclusions'] for c in cards)),still_available=sum(c['available_at_snapshot'] for c in cards))

out=pathlib.Path(__file__).resolve().parent.parent/'evidence'/'provenance.json'
out.write_text(json.dumps(result,indent=2)+'\n')
print(out)
for w,row in result['archive_provenance'].items(): print('PROVENANCE',w,json.dumps(row['by_scope']))
for w,row in result['baseline_slates'].items():
    print('BASELINES',w,json.dumps({k:{key:val for key,val in v.items() if key!='cards'} for k,v in row.items()}))
