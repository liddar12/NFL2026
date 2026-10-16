// Independent injury-identity checks. The published baseline is immutable;
// controlled replays share explicit inputs and are not a point-exact pipeline replay.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const REVIEWED={
 'scripts/availability.py':'c79089797329a145e3eda3e86296cc45e316f7aae0b1f6a6225747a3e792c3e7',
 'scripts/build_predictions.py':'1d9a40409a19dc2a9bacf3e2d351ab660267dc36e59016b59a4649ca317c823e',
 'scripts/build_weekly.py':'a5ceaa45a1df70c1ddb12a0aaae8ac012c5e10d0308375d4a5b8d788a03870bc',
 'scripts/validate_data.py':'095f21ec01fa418abb5db253868f27b3800143bbb770a7c2da1b9a351b6c1b41',
};
const hash=path=>createHash('sha256').update(readFileSync(ROOT+path)).digest('hex');
function checkPins(){
 for(const [path,pin]of Object.entries(REVIEWED))assert.equal(hash(path),pin,'Reviewed candidate source changed: '+path);
 const audit=JSON.parse(readFileSync(ROOT+'tests/fixtures/week6_eligibility_baseline_0d49/candidate_audit.json','utf8'));
 assert.deepEqual(audit.candidate_source_sha256,REVIEWED,'Audit must refer to this exact candidate');
 assert.equal(audit.full_pipeline_replayed,false);assert.equal(audit.candidate_pool_rebuilt,false);
 assert.equal(audit.original_point_exact_weekly_reproduction,false);
 assert.deepEqual(audit.controlled_same_input_comparison.removed_refusals,[]);
}
checkPins();
after(checkPins);
const SETUP=String.raw`
import copy,hashlib,importlib.util,json,pathlib
from scripts import availability as A,build_weekly as W,build_predictions as BP,validate_data as V
from scripts.models.parlay_builder import playable_this_week
ROOT=pathlib.Path.cwd();BASE=ROOT/'tests/fixtures/week6_eligibility_baseline_0d49'
NOW='2026-10-16T06:31:33Z'
def source(name):return json.loads((BASE/name).read_text())
def player(pid='espn-1',name='Old Display',team='SF',position='WR'):
 return {'gsis_id':pid,'name':name,'team':team,'position':position,'proj_points':170.0}
def injury(pid='1',name='Provider Display Sr.',team='SF',status='Out',**extra):
 raw={'athlete_id':pid,'player':name,'team':team,'status':status,**extra}
 return {**raw,**A.enrich(raw)}
def document(rows,quarantine=()):
 return {'season':2026,'week':6,'updated_utc':NOW,'source_updated_utc':NOW,
  'received_utc':NOW,'source':'espn','vocab_version':A.VOCAB_VERSION,
  'injuries':copy.deepcopy(rows),'counts':A.counts(rows),'quarantine':list(quarantine)}
GAMES=[{'game_id':'g'+str(w),'week':w,'home':'SF','away':'DAL',
 'kickoff_utc':date,'status':'FINAL'if w==5 else'PRE'}for w,date in
 ((5,'2026-10-11T20:25:00Z'),(6,'2026-10-18T20:25:00Z'),(7,'2026-10-25T20:25:00Z'))]
def weekly(players,doc,skip=()):
 return W.build_weekly_document(players,GAMES,{}, {},season=2026,updated_utc=NOW,
  first_week=6,this_week=6,factors=W.build_factors(2026),depth_chart=None,
  injury_document=doc,gate_skip_teams=skip)
def emit(value):print(json.dumps(value,allow_nan=False,sort_keys=True))
`;
function py(body){
 const p=spawnSync('python3',['-'],{cwd:ROOT,input:SETUP+'\n'+body,encoding:'utf8',
  timeout:40000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(p.status,0,p.stderr+p.stdout);
 return JSON.parse(p.stdout.trim().split('\n').at(-1));
}

test('all20 historical raw/code blobs remain exact; the old300/800 acceptance projection and33/19/14 record are preserved',()=>{
 const r=py(String.raw`
m=source('manifest.json');assert m['commit']=='0d49a94868142b4e6e888b927363d42270ed23c0'
assert hashlib.sha256((BASE/'manifest.json').read_bytes()).hexdigest()=='d254de8af507688f1dcf35cc90e55938155f24c3e5040711f766d71ff3d8d548'
for name,meta in m['files'].items():
 raw=(BASE/name).read_bytes()
 assert len(raw)==meta['raw_bytes']
 assert hashlib.sha256(raw).hexdigest()==meta['raw_sha256']
 assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==meta['git_blob_sha1']
f=json.loads((ROOT/m['original_acceptance_fixture']).read_text());w=source('data/player_weekly.json');i=source('data/injuries.json')
wp={p['gsis_id']:p for p in w['players']}
for p in f['players']:
 for key,value in p.items():
  assert value==([r for r in wp[p['gsis_id']]['weeks']if r['wk']==6]if key=='weeks'else wp[p['gsis_id']].get(key))
assert len(f['injuries']['injuries'])==len(i['injuries'])==800
for minimal,raw in zip(f['injuries']['injuries'],i['injuries']):
 assert all(raw.get(k)==v for k,v in minimal.items())
held=[p for p in w['players']if not playable_this_week(p,6)]
emit({'files':len(m['files']),'players':len(wp),'held':len(held),
 'status':sum(p.get('this_week',{}).get('reason')=='status'for p in held),
 'depth':sum(p.get('this_week',{}).get('reason')=='depth'for p in held),
 'full_pipeline_reproduction':m['limits']['full_pipeline_reproduction']})
`);
 assert.deepEqual(r,{files:20,players:300,held:33,status:19,depth:14,full_pipeline_reproduction:false});
});

test('same exact frozen inputs add only Deebo OUT to the controlled eligibility split; no prior refusal silently becomes playable',()=>{
 const r=py(String.raw`
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,BASE/path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
LA=module('frozen_availability','scripts/availability.py');LW=module('frozen_weekly','scripts/build_weekly.py');LW.availability=LA
pr=source('data/player_projections.json')['players'];original=source('data/player_weekly.json');inj=source('data/injuries.json');sched=source('data/schedule_full.json')['games'];depth=source('data/depth_chart.json');inactive=source('data/inactives.json')
wp={p['gsis_id']:p for p in original['players']};common=dict(updated_utc=original['updated_utc'],first_week=6,this_week=6,depth_chart=depth,inactives=inactive,injury_document=inj,gate_skip_teams=original['model']['this_week'].get('skipped_final_teams',[]))
def replay(mod):
 factors=mod.build_factors(2026,source('data/dvp_positional_history.json'),source('data/environment_model.json'),source('data/weather_forecast.json'))
 return mod.build_weekly_document(copy.deepcopy(pr),copy.deepcopy(sched),{},
  {k:p.get('receptions_prior',0)for k,p in wp.items()},season=2026,factors=factors,**copy.deepcopy(common))
old,new=replay(LW),replay(W);before={p['gsis_id']:p for p in old['players']};after={p['gsis_id']:p for p in new['players']}
reverse=[pid for pid in before if not playable_this_week(before[pid],6)and playable_this_week(after[pid],6)]
deltas=[{'id':pid,'before':playable_this_week(before[pid],6),'after':playable_this_week(after[pid],6),'reason':after[pid].get('this_week',{}).get('reason'),'status':after[pid].get('this_week',{}).get('status')}for pid in before if playable_this_week(before[pid],6)!=playable_this_week(after[pid],6)]
emit({'old_held':sum(not playable_this_week(p,6)for p in old['players']),
 'new_held':sum(not playable_this_week(p,6)for p in new['players']),
 'reverse':reverse,'deltas':deltas,'old_deebo':LA.lookup_report(LA.index_report(inj['injuries']),LA.index_report_by_name(inj['injuries']),'SF','Deebo Samuel'),'candidate_deebo':A.resolve_report(pr,inj['injuries'])['views']['espn-3126486']['availability']})
`);
 assert.equal(r.old_held,33);assert.equal(r.new_held,34);assert.deepEqual(r.reverse,[]);
 assert.deepEqual(r.deltas,[{id:'espn-3126486',before:true,after:false,reason:'status',status:'OUT'}]);
 assert.equal(r.old_deebo,null);assert.equal(r.candidate_deebo,'OUT');
});

test('explicit IDs defeat renamed displays without borrowing a same-name different person; QUESTIONABLE is labelled not zeroed',()=>{
 const r=py(String.raw`
p=player();neighbor=player('espn-2',name='Old Display');before=copy.deepcopy([p,neighbor]);out=[]
for status in('Out','Reserve-Ret','Questionable','Active'):
 doc=document([injury(status=status)]);result=weekly([p,neighbor],doc);rows={q['gsis_id']:q for q in result['players']}
 out.append({'status':status,'target':playable_this_week(rows['espn-1'],6),'neighbor':playable_this_week(rows['espn-2'],6),'code':rows['espn-1'].get('availability',{}).get('status'),'pts':next(w['pts']for w in rows['espn-1']['weeks']if w['wk']==6)})
named=A.resolve_report([p],[injury('2',name=p['name'])]);assert not named['views']and not named['refusals']
assert [p,neighbor]==before
emit(out)
`);
 for(const row of r){assert.equal(row.target,['Questionable','Active'].includes(row.status));assert.equal(row.neighbor,true);}
 assert.equal(r[0].code,'OUT');assert.equal(r[1].code,'RETIRED');assert.equal(r[2].code,'QUESTIONABLE');assert.ok(r[2].pts>0);
});

test('conflicting identity aliases with no matching display retain all identifiable refusal scopes, never medical zero',()=>{
 const r=py(String.raw`
players=[player(),player('espn-2','Other Display'),player('espn-3','Unaffected Display')];out=[]
for extra in({'espn_id':'2'},{'espn_id':True},{'espn_id':'not-an-id'}):
 doc=document([injury(**extra)]);resolved=A.resolve_report(players,doc['injuries']);w=weekly(players,doc);by={p['gsis_id']:p for p in w['players']}
 expected={'espn-1','espn-2'}if extra['espn_id']=='2'else{'espn-1'}
 assert expected<=set(resolved['refusals']),(extra,resolved)
 for pid in expected:
  assert not playable_this_week(by[pid],6)
  assert by[pid]['eligibility']['reason']=='source_unverified'
  assert 'availability'not in by[pid]
  assert all(row.get('avail')is not False for row in by[pid]['weeks'])
 assert playable_this_week(by['espn-3'],6)
 out.append({'refused':sorted(resolved['refusals']),'expected':sorted(expected)})
emit(out)
`);
 assert.equal(r.length,3);
});

test('same-ID team conflicts and unknown status remain local source uncertainty; no ID plus ambiguous name cannot become someone else’s OUT',()=>{
 const r=py(String.raw`
p=player();neighbor=player('espn-2','Other Display');out=[]
for rows in([injury(team='DAL')],[injury(),injury(team='DAL')],[injury(status='UNMAPPED_TEST')]):
 doc=document(rows);w=weekly([p,neighbor],doc);by={q['gsis_id']:q for q in w['players']}
 assert not playable_this_week(by[p['gsis_id']],6)
 assert by[p['gsis_id']]['eligibility']['reason']=='source_unverified'
 assert 'availability'not in by[p['gsis_id']]
 assert all(row.get('avail')is not False for row in by[p['gsis_id']]['weeks'])
 assert playable_this_week(by[neighbor['gsis_id']],6)
 out.append(by[p['gsis_id']]['eligibility']['detail'])
dup=player('espn-2',name=p['name']);raw=injury(None,name=p['name']);res=A.resolve_report([p,dup],[raw])
assert not res['views'];assert set(res['refusals'])=={'espn-1','espn-2'}
emit(out)
`);
 assert.equal(r.length,3);assert.ok(r.every(x=>typeof x==='string'&&x.length));
});

test('the prediction report second pass binds the same ID and same absence while uncertainty preserves original fantasy inputs',()=>{
 const r=py(String.raw`
out=[]
for status in('Injured Reserve','Questionable'):
 rec=player();rec['injury_status']=None;doc=document([injury(status=status)])
 counts=BP._apply_injury_report([rec],doc,NOW,6)
 out.append({'status':rec['injury_status'],'absence':rec['absence_weeks'],'counts':counts})
rec=player();rec['injury_status']='questionable';rec['absence_weeks']=2;before=copy.deepcopy(rec)
BP._apply_injury_report([rec],document([injury(team='DAL')]),NOW,6)
assert rec==before,(rec,before)
emit(out)
`);
 assert.equal(r[0].status,'IR');assert.ok(r[0].absence>=4);assert.equal(r[1].status,'QUESTIONABLE');assert.equal(r[1].absence,0);
});

test('an uncertain nonprojected depth-chart identity is not a known absence that promotes the backup quarterback',()=>{
 const r=py(String.raw`
backup=player('espn-2','Backup Quarterback',position='QB')
namesake=player('espn-1','Twin Starter',position='WR')
chart={'updated_utc':NOW,'teams':{'SF':{'QB':[{'name':'Twin Starter','rank':1},{'name':'Backup Quarterback','espn_id':'2','rank':2}]}}}
doc=document([injury('1',name='Twin Starter')])
w=W.build_weekly_document([backup,namesake],GAMES,{}, {},season=2026,updated_utc=NOW,
 first_week=6,this_week=6,factors=W.build_factors(2026),depth_chart=chart,injury_document=doc)
by={p['gsis_id']:p for p in w['players']}
emit({'backup':by['espn-2'].get('this_week'),'namesake':by['espn-1'].get('this_week')})
`);
 assert.equal(r.backup?.playable,false);assert.equal(r.backup?.reason,'depth');
 assert.equal(r.namesake?.reason,'status');assert.equal(r.namesake?.status,'OUT');
});

test('a new current injury cannot zero played/past weeks or turn FINAL identity uncertainty into a historical offer refusal',()=>{
 const r=py(String.raw`
out=[]
for rows in([injury(status='Injured Reserve')],[injury(team='DAL')]):
 doc=document(rows);w=weekly([player()],doc,skip=('SF','DAL'));p=w['players'][0];weeks={r['wk']:r for r in p['weeks']}
 assert weeks[5]['pts']>0 and weeks[5].get('avail')is not False
 assert weeks[6]['pts']>0 and weeks[6].get('avail')is not False
 assert 'this_week'not in p and'eligibility'not in p
 out.append({'past':weeks[5]['pts'],'final':weeks[6]['pts'],'future':weeks[7]['pts']})
emit(out)
`);
 assert.equal(r.length,2);assert.equal(r[0].future,0);assert.ok(r[1].future>0);
});

test('the independent validator rejects an otherwise healthy-looking same-ID OUT omission after all local counts are repaired',()=>{
 const r=py(String.raw`
p=player();doc=document([injury()]);w=weekly([p],doc);V.check_weekly_availability(w,{'players':[p]},doc)
bad=copy.deepcopy(w);target=bad['players'][0];target.pop('availability',None);target.pop('this_week',None)
for row in target['weeks']:
 if row['wk']==6:row.pop('avail',None);row['pts']=1.0
bad['model']['this_week']['by_reason']['status']=0;bad['model']['this_week']['gated']=0
try:V.check_weekly_availability(bad,{'players':[p]},doc)
except V.ValidationError as exc:emit({'rejected':True,'reason':str(exc)})
else:emit({'rejected':False})
`);
 assert.equal(r.rejected,true);assert.match(r.reason,/status|OUT|play|gated/i);
});

test('duplicate same-ID ACTIVE or QUESTIONABLE cannot hide a stronger canonical OUT/IR/RETIRED report',()=>{
 const rows=py(String.raw`
results=[]
for lower,stronger in(('Active','Out'),('Active','Injured Reserve'),('Active','Reserve-Ret'),('Questionable','Out')):
 p=player();doc=document([injury(status=lower),injury(status=stronger)])
 good=weekly([p],doc);V.check_weekly_availability(good,{'players':[p]},doc)
 assert not playable_this_week(good['players'][0],6)
 # This is genuine internally-consistent producer output for the weaker
 # source, not malformed point totals or a stale source metadata failure.
 forged=weekly([p],document([injury(status=lower)]))
 forged['model']['injury_source']=copy.deepcopy(good['model']['injury_source'])
 assert playable_this_week(forged['players'][0],6)
 try:V.check_weekly_availability(forged,{'players':[p]},doc)
 except V.ValidationError:rejected=True
 else:rejected=False
 results.append({'lower':lower,'stronger':stronger,'rejected':rejected})
emit(results)
`);
 assert.equal(rows.length,4);
 for(const row of rows)assert.equal(row.rejected,true,JSON.stringify(row));
});

test('a damaged pool identity retains its recognizable aliases when protecting a neighboring explicit identity',()=>{
 const r=py(String.raw`
damaged=player('espn-1','Damaged Identity');damaged['athlete_id']='2'
neighbor=player('espn-2','Neighbor Identity');independent=player('espn-3','Independent Identity')
players=[damaged,neighbor,independent];doc=document([injury('2',name='Provider Alias')])
resolved=A.resolve_report(players,doc['injuries'])
codes,refusals=V._injury_identity_audit(players,doc['injuries'])
assert resolved['refusals']==refusals,(resolved,refusals)
assert set(refusals)=={'espn-1','espn-2'}
w=weekly(players,doc);V.check_weekly_availability(w,{'players':players},doc)
by={p['gsis_id']:p for p in w['players']}
assert not playable_this_week(by['espn-1'],6)and not playable_this_week(by['espn-2'],6)
assert playable_this_week(by['espn-3'],6)
assert all('availability'not in by[pid]for pid in refusals)
emit({'codes':codes,'refusals':refusals})
`);
 assert.deepEqual(r.codes,{});assert.equal(r.refusals['espn-1'],'conflicting_injury_identity');
 assert.equal(r.refusals['espn-2'],'ambiguous_injury_identity');
});
