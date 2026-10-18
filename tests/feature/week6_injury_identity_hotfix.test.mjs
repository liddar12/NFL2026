// Public-source regression cases: no private Git objects or candidate hash pins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// An explicit alternate checkout supports an unchanged before/after experiment.
const ROOT = process.env.NFL_INJURY_TEST_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const SETUP = String.raw`
import copy,json
from scripts import availability as A,build_weekly as W,build_predictions as P,validate_data as V
from scripts.models.parlay_builder import playable_this_week
NOW='2026-10-18T14:30:00Z'
def player(pid='espn-3126486',name='Deebo Samuel',team='SF',position='WR'):
 return {'gsis_id':pid,'name':name,'team':team,'position':position,'proj_points':170.0}
def injury(pid='3126486',name='Deebo Samuel Sr.',team='SF',status='Out',**extra):
 row={'athlete_id':pid,'player':name,'team':team,'status':status,**extra}
 return {**row,**A.enrich(row)}
def document(rows):
 return {'season':2026,'week':6,'updated_utc':NOW,'source_updated_utc':NOW,
  'received_utc':NOW,'source':'espn','vocab_version':A.VOCAB_VERSION,
  'injuries':rows,'counts':A.counts(rows),'quarantine':[]}
GAMES=[{'game_id':'g'+str(w),'week':w,'home':'SF','away':'DAL',
 'kickoff_utc':date,'status':'STATUS_FINAL' if w==5 else 'STATUS_SCHEDULED'}
 for w,date in ((5,'2026-10-11T20:25:00Z'),(6,'2026-10-18T20:25:00Z'),(7,'2026-10-25T20:25:00Z'))]
def weekly(players,doc,skip=(),depth=None):
 return W.build_weekly_document(players,GAMES,{}, {},2026,NOW,first_week=6,this_week=6,
  factors=W.build_factors(2026,None,None,None),depth_chart=depth,
  injury_document=doc,gate_skip_teams=skip)
def row(doc,pid='espn-3126486'):
 return next(p for p in doc['players'] if p['gsis_id']==pid)
def emit(value):print(json.dumps(value,sort_keys=True))
`;
function py(body) {
  const result = spawnSync('python3', ['-B', '-'], {cwd: ROOT, input: SETUP + '\n' + body,
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('same ESPN identity survives a changed display name in weekly and projection consumers', () => {
  const r = py(String.raw`
players=[player(),player('espn-2',name='Deebo Samuel')]
doc=document([injury()]);w=weekly(players,doc);V.check_weekly_availability(w,{'players':players},doc)
records=copy.deepcopy(players);P._apply_injury_report(records,doc,NOW,6)
target=row(w);peer=row(w,'espn-2')
emit({'target_playable':playable_this_week(target,6),'peer_playable':playable_this_week(peer,6),
 'status':target.get('availability',{}).get('status'),
 'points':next(x['pts'] for x in target['weeks'] if x['wk']==6),
 'projection_status':records[0].get('injury_status'),'peer_status':records[1].get('injury_status')})
`);
  assert.deepEqual(r, {target_playable:false, peer_playable:true, status:'OUT', points:0,
    projection_status:'OUT', peer_status:null});
});

test('a same-name report for a different explicit ESPN ID cannot block a player', () => {
  const r = py(String.raw`
p=player();doc=document([injury('2',name=p['name'])]);w=weekly([p],doc)
V.check_weekly_availability(w,{'players':[p]},doc)
record=copy.deepcopy(p);P._apply_injury_report([record],doc,NOW,6)
emit({'playable':playable_this_week(row(w),6),'badge':row(w).get('availability'),
 'projection_status':record.get('injury_status')})
`);
  assert.deepEqual(r,{playable:true,badge:null,projection_status:null});
});

test('conflicting ID/team evidence withholds only affected players without inventing medical zeros', () => {
  const result = py(String.raw`
players=[player(),player('espn-2','Neighbor'),player('espn-3','Healthy')];answers=[]
for rows,affected in (([injury(team='DAL')],{'espn-3126486'}),
 ([injury(espn_id='2')],{'espn-3126486','espn-2'}),
 ([injury(espn_id=True)],{'espn-3126486'}),
 ([injury(status='UNMAPPED_TEST')],{'espn-3126486'})):
 doc=document(rows);w=weekly(players,doc);V.check_weekly_availability(w,{'players':players},doc)
 for pid in affected:
  target=row(w,pid)
  assert not playable_this_week(target,6)
  assert target['eligibility']['reason']=='source_unverified'
  assert 'availability' not in target
  assert all(x.get('avail') is not False for x in target['weeks'])
 assert playable_this_week(row(w,'espn-3'),6)
 answers.append(sorted(affected))
emit(answers)
`);
  assert.equal(result.length,4);
});

test('independent validator catches omitted same-ID OUT and mixed weaker-status masking', () => {
  const r = py(String.raw`
answers=[];p=player()
for weaker,stronger in (('Active','Out'),('Questionable','Out'),('Active','Injured Reserve'),('Active','Reserve-Ret')):
 doc=document([injury(status=weaker),injury(status=stronger)])
 good=weekly([p],doc);V.check_weekly_availability(good,{'players':[p]},doc)
 forged=weekly([p],document([injury(status=weaker)]))
 forged['model']['injury_source']=copy.deepcopy(good['model']['injury_source'])
 try:V.check_weekly_availability(forged,{'players':[p]},doc)
 except V.ValidationError:rejected=True
 else:rejected=False
 answers.append({'weaker':weaker,'stronger':stronger,'rejected':rejected})
emit(answers)
`);
  for (const result of r) assert.equal(result.rejected,true,JSON.stringify(result));
});

test('QUESTIONABLE stays playable and guarded legacy no-ID mover fallback remains supported', () => {
  const r = py(String.raw`
p=player();doc=document([injury(status='Questionable')]);w=weekly([p],doc)
legacy=player('legacy-1','Legacy Player',team='TB');raw=injury(None,'Legacy Player','SF','Injured Reserve')
record=copy.deepcopy(legacy);doc2=document([raw]);P._apply_injury_report([record],doc2,NOW,6)
legacy_view=W.unavailability([legacy],doc2['injuries'])
emit({'questionable_playable':playable_this_week(row(w),6),
 'questionable_status':row(w).get('availability',{}).get('status'),
 'legacy_status':record.get('injury_status'),'legacy_absence':record.get('absence_weeks'),
 'weekly_legacy_status':legacy_view.get('legacy-1',{}).get('status')})
`);
  assert.equal(r.questionable_playable,true);assert.equal(r.questionable_status,'QUESTIONABLE');
  assert.equal(r.legacy_status,'IR');assert.ok(r.legacy_absence>=4);assert.equal(r.weekly_legacy_status,'IR');
});

test('a nonprojected starter uses scoped identity; ambiguity cannot promote a backup QB', () => {
  const r = py(String.raw`
backup=player('espn-2','Backup Quarterback',position='QB')
depth={'updated_utc':NOW,'teams':{'SF':{'QB':[
 {'name':'Starter Display','espn_id':'3126486','rank':1},
 {'name':'Backup Quarterback','espn_id':'2','rank':2}]}}}
known=weekly([backup],document([injury()]),depth=depth)
unknown=weekly([backup],document([injury(team='DAL')]),depth=depth)
emit({'known':row(known,'espn-2')['this_week'],'unknown':row(unknown,'espn-2')['this_week']})
`);
  assert.equal(r.known.playable,true);assert.equal(r.known.reason,'depth_promoted');
  assert.equal(r.unknown.playable,false);assert.equal(r.unknown.reason,'depth');
});

test('current injury and identity uncertainty cannot zero FINAL or past weeks', () => {
  const r = py(String.raw`
answers=[]
for raw in (injury(status='Injured Reserve'),injury(team='DAL')):
 doc=document([raw]);w=weekly([player()],doc,skip=('SF','DAL'));p=row(w)
 V.check_weekly_availability(w,{'players':[player()]},doc)
 values={x['wk']:x for x in p['weeks']}
 assert values[5]['pts']>0 and values[6]['pts']>0
 assert 'this_week' not in p and 'eligibility' not in p
 answers.append(values[7]['pts'])
emit(answers)
`);
  assert.equal(r[0],0);assert.ok(r[1]>0);
});
