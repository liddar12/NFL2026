// ID-join correctness and a frozen same-input consumer comparison; no refit,
// whole-pipeline replay, provider authentication, ticket or production claim.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const cwd=fileURLToPath(new URL('../..',import.meta.url));
const files=['scripts/availability.py','scripts/build_weekly.py','scripts/build_predictions.py','scripts/validate_data.py'];
const hashes=files.map(p=>createHash('sha256').update(readFileSync(cwd+p)).digest('hex'));
const covered=files.map(()=>new Set());
const setup=String.raw`
import copy,hashlib,importlib.util,json,pathlib
from unittest.mock import patch
import scripts
from scripts import availability as av,build_weekly as bw,build_predictions as bp
from scripts.models.parlay_builder import playable_this_week
from scripts.validate_data import check_weekly_availability,ValidationError
ROOT=pathlib.Path.cwd();BASE=ROOT/'tests/fixtures/week6_eligibility_baseline_0d49'
NOW='2026-10-16T12:00:00Z';STAMP='2026-10-16T11:00:00Z'
PROJ=[{'gsis_id':'espn-123','name':'Current Display','team':'SF','position':'RB','proj_points':170.0},
 {'gsis_id':'espn-456','name':'Independent Neighbor','team':'SEA','position':'WR','proj_points':170.0}]
SCHED=[{'week':w,'home':'SF','away':'SEA'}for w in range(1,19)if w!=7]
def report(rows,quarantine=None):
 return {'updated_utc':STAMP,'received_utc':STAMP,'source_updated_utc':STAMP,'source':'espn',
  'vocab_version':av.VOCAB_VERSION,'season':2026,'week':6,'quarantine':quarantine or [],
  'injuries':[{**r,**av.enrich(r)}for r in rows]}
def raw(status='Out',**kw):
 return {'athlete_id':'123','team':'SF','player':'Former Display','status':status,'detail':None,**kw}
def build(doc,*,proj=None,skip=(),module=bw):
 return module.build_weekly_document(PROJ if proj is None else proj,SCHED,{'SF':1500,'SEA':1500},{},2026,NOW,
  factors=module.build_factors(2026),first_week=6,this_week=6,injury_document=doc,gate_skip_teams=skip)
def week(player,w=6):return next(v for v in player['weeks']if v['wk']==w)
def validate(doc,proj,inj):check_weekly_availability(doc,{'players':proj},inj)
def load_frozen(name,path):
 spec=importlib.util.spec_from_file_location(name,BASE/path);value=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(value);return value
def old_modules():
 old_av=load_frozen('frozen_identity_av','scripts/availability.py')
 with patch.object(scripts,'availability',old_av):old_bw=load_frozen('frozen_identity_bw','scripts/build_weekly.py')
 return old_av,old_bw
def emit(value):print(json.dumps(value,allow_nan=False))
`;
function run(source){
 const code=`import pathlib,sys,json\nTARGETS=[str(pathlib.Path(p).resolve())for p in ${JSON.stringify(files)}];COVER=[set()for _ in TARGETS]\ndef trace(frame,event,arg):\n if frame.f_code.co_filename not in TARGETS:return None\n if event=='line':COVER[TARGETS.index(frame.f_code.co_filename)].add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(setup+source)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':[sorted(v)for v in COVER]}))\n`;
 const p=spawnSync('python3',['-'],{cwd,input:code,encoding:'utf8',timeout:30000,
  maxBuffer:4*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(p.status,0,p.stderr+p.stdout);
 const lines=p.stdout.trim().split('\n');
 JSON.parse(lines.pop()).__trace__.forEach((rows,i)=>rows.forEach(line=>covered[i].add(line)));
 return JSON.parse(lines.pop());
}

after(()=>{
 files.forEach((p,i)=>assert.equal(createHash('sha256').update(readFileSync(cwd+p)).digest('hex'),hashes[i]));
 const code=String.raw`import ast,difflib,json,pathlib,trace
paths=`+JSON.stringify(files)+String.raw`
seen=`+JSON.stringify(covered.map(v=>[...v]))+String.raw`
result={}
for path,lines in zip(paths,seen):
 current=pathlib.Path(path);old=pathlib.Path('tests/fixtures/week6_eligibility_baseline_0d49')/path
 a=old.read_text().splitlines();b=current.read_text().splitlines();added=set()
 for tag,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
  if tag in('insert','replace'):added.update(range(k+1,l+1))
 executable=set(trace._find_executable_linenos(str(current.resolve())))
 target=added&executable;hit=target&set(lines)
 result[path]={'covered':len(hit),'total':len(target),'percent':round(100*len(hit)/len(target),4)if target else None,'missing_lines':sorted(target-hit)}
print(json.dumps(result,sort_keys=True))
`;
 const p=spawnSync('python3',['-'],{cwd,input:code,encoding:'utf8',timeout:10000});
 assert.equal(p.status,0,p.stderr+p.stdout);
 console.log('identity_changed_executable_line_coverage='+p.stdout.trim());
});

test('exact ID and team bind renamed OUT/IR/Q/RETIRED without changing the neighbor',()=>{
 const o=run(String.raw`
out=[]
for status in ('Out','Injured Reserve','Questionable','Reserve-Ret'):
 d=report([raw(status)]);b=build(d);validate(b,PROJ,d);p=b['players'][0]
 out.append({'status':status,'availability':p.get('availability'),'gate':p.get('this_week'),
  'playable':playable_this_week(p,6),'pts':week(p)['pts'],'prior':week(p,5)['pts'],
  'neighbor':playable_this_week(b['players'][1],6)})
emit(out)
`);
 for(const p of o){assert.ok(p.prior>0);assert.equal(p.neighbor,true);}
 assert.deepEqual(o.map(p=>p.availability.status),['OUT','IR','QUESTIONABLE','RETIRED']);
 assert.deepEqual(o.map(p=>p.playable),[false,false,true,false]);
 assert.equal(o[2].gate,null);assert.ok(o[2].pts>0);
});

test('an explicit other ID never supplies a same-name medical status',()=>{
 const o=run(String.raw`
d=report([raw(athlete_id='999',player='Current Display')]);b=build(d);validate(b,PROJ,d)
emit({'p':b['players'][0],'multipliers':bw.injury_multipliers(PROJ,d['injuries'])})
`);
 assert.equal(o.p.availability,undefined);assert.equal(o.p.this_week,undefined);
 assert.equal(o.p.eligibility,undefined);assert.ok(o.p.weeks.find(w=>w.wk===6).pts>0);
 assert.deepEqual(o.multipliers,{});
});

test('identity contradictions refuse only the affected current offer, never manufacture a medical zero',()=>{
 const o=run(String.raw`
cases=[raw(team='DAL'),raw(espn_id='999'),raw(espn_id=True),raw(espn_id='broken')]
out=[]
for r in cases:
 d=report([r]);b=build(d);validate(b,PROJ,d);p=b['players'][0]
 out.append({'refusal':p.get('eligibility'),'availability':p.get('availability'),
  'tw':p.get('this_week'),'pts':week(p)['pts'],'neighbor':b['players'][1].get('eligibility')})
emit(out)
`);
 assert.deepEqual(o.map(p=>p.refusal.detail),['injury_identity_team_conflict',
  'conflicting_injury_identity','conflicting_injury_identity','conflicting_injury_identity']);
 for(const p of o){assert.equal(p.availability,null);assert.equal(p.tw,null);assert.ok(p.pts>0);assert.equal(p.neighbor,null);}
});

test('legacy ID-absent mover fallback remains guarded; explicit namesakes stay distinct',()=>{
 const o=run(String.raw`
p=copy.deepcopy(PROJ);p[0]['gsis_id']='legacy-gsis'
d=report([raw(team='DAL',player='Current Display')]);b=build(d,proj=p);validate(b,p,d)
other=report([raw(athlete_id='999',player='Current Display'),raw(athlete_id='123',status='Active',player='Current Display')])
c=build(other);validate(c,PROJ,other)
emit({'legacy':b['players'][0]['this_week'],'exact':c['players'][0].get('availability'),
 'views':av.resolve_report(PROJ,other['injuries'])['views']['espn-123']['availability']})
`);
 assert.equal(o.legacy.status,'OUT');assert.equal(o.exact,null);assert.equal(o.views,'ACTIVE');
});

test('second projection pass shares ID binding and preserves quarantined fantasy inputs',()=>{
 const o=run(String.raw`
records=[dict(p,injury_status='ACTIVE',absence_weeks=0)for p in PROJ]
d=report([raw('Injured Reserve')]);counts=bp._apply_injury_report(records,d,NOW,6)
held=[dict(p,injury_status='QUESTIONABLE',absence_weeks=2)for p in PROJ]
fault=report([raw('Injured Reserve',team='DAL')]);refused=bp._apply_injury_report(held,fault,NOW,6)
emit({'counts':counts,'known':records,'refused':refused,'held':held})
`);
 assert.deepEqual(o.counts,[1,1]);assert.equal(o.known[0].injury_status,'IR');assert.equal(o.known[0].absence_weeks,4);
 assert.deepEqual(o.refused,[0,0]);assert.equal(o.held[0].injury_status,'QUESTIONABLE');assert.equal(o.held[0].absence_weeks,2);
});

test('R103 FINAL and historical weeks remain unchanged, including unknown identity refusal',()=>{
 const o=run(String.raw`
d=report([raw('Injured Reserve')]);b=build(d,skip=('SF',));validate(b,PROJ,d)
f=report([raw(team='DAL')]);c=build(f,skip=('SF',));validate(c,PROJ,f)
emit({'prior':week(b['players'][0],5),'final':week(b['players'][0]),
 'next':week(b['players'][0],8),'tw':b['players'][0].get('this_week'),
 'unknown_final':c['players'][0].get('eligibility')})
`);
 assert.ok(o.prior.pts>0);assert.ok(o.final.pts>0);assert.equal(o.next.pts,0);
 assert.equal(o.tw,null);assert.equal(o.unknown_final,null);
});

test('independent validator rejects the real old name-only omission and a forged wrong-ID badge',()=>{
 const o=run(String.raw`
_,old=old_modules();d=report([raw()]);stale=build(d,module=old)
reasons=[]
for b,doc in ((stale,d),(build(report([raw(player='Current Display')])),report([raw(athlete_id='999',player='Current Display')]))):
 try:validate(b,PROJ,doc)
 except ValidationError:reasons.append('rejected')
 else:reasons.append('accepted')
emit(reasons)
`);
 assert.deepEqual(o,['rejected','rejected']);
});

test('mixed ACTIVE and OUT cannot hide a sitter; legacy duration-first canonical winner remains a no-op',()=>{
 const o=run(String.raw`
d=report([raw('Active'),raw('Out')]);good=build(d);validate(good,PROJ,d)
healthy=build(report([raw('Active')]));healthy['model']['injury_source']=copy.deepcopy(good['model']['injury_source'])
try:validate(healthy,PROJ,d)
except ValidationError:rejected=True
else:rejected=False
odd=report([raw('Active'),raw('Out')])
# Legacy canonical fields are a trusted-file contract, not a claim that an
# ACTIVE provider sentence would be parsed into this unusual duration.
odd['injuries'][0].update(weeks_out=4,confidence='explicit',evidence='legacy canonical duration')
b=build(odd);validate(b,PROJ,odd)
emit({'rejected':rejected,'winner':good['players'][0]['availability']['status'],
 'odd':b['players'][0].get('availability'),'audit':{k:sorted(v)for k,v in __import__('scripts.validate_data',fromlist=['_injury_identity_audit'])._injury_identity_audit(PROJ,odd['injuries'])[0].items()}})
`);
 assert.equal(o.rejected,true);assert.equal(o.winner,'OUT');assert.equal(o.odd,null);
 assert.deepEqual(o.audit['espn-123'],['ACTIVE']);
});

test('full identity scopes retain quarantine, duplicate guards and nonprojected depth context without zeroing unknowns',()=>{
 const o=run(String.raw`
out=[]
for change in ({'espn_id':'999'},{'gsis_id':'espn-123','athlete_id':True}):
 p=copy.deepcopy(PROJ);p[0].update(change);d=report([raw('Injured Reserve')]);b=build(d,proj=p);validate(b,p,d)
 out.append(b['players'][0]['eligibility']['detail']);assert week(b['players'][0])['pts']>0
p=copy.deepcopy(PROJ);p[1].update(name='Current Display',team='SF',athlete_id='123')
d=report([raw()]);b=build(d,proj=p);validate(b,p,d)
assert all(v['eligibility']['eligible']is False for v in b['players'])
q=[{'athlete_id':'123','team':'SF','player':'Former Display','status':'New designation'}]
d=report([raw('Injured Reserve',athlete_id=None,player='Current Display'),raw('Out',athlete_id='456',team='SEA',player='Independent Neighbor')],q)
b=build(d);validate(b,PROJ,d);assert b['players'][0]['eligibility']['detail']=='quarantined_status'
assert b['players'][0].get('availability')is None and b['players'][1]['this_week']['status']=='OUT'
legacy=[dict(PROJ[0])];row=raw('Injured Reserve',athlete_id=None,player='Current Display')
inj=report([row])['injuries'];n=bp._stamp_absence(legacy,av.index_report(inj),av.index_report_by_name(inj))
backup={'gsis_id':'espn-777','name':'Backup','team':'SF','position':'QB','proj_points':170.0}
depth={'updated_utc':NOW,'teams':{'SF':{'QB':[{'name':'Unprojected Starter','espn_id':'123','rank':1},{'name':'Backup','espn_id':'777','rank':2}]}}}
d=report([raw()]);c=bw.build_weekly_document([backup],SCHED,{}, {},2026,NOW,first_week=6,this_week=6,depth_chart=depth,injury_document=d,factors=bw.build_factors(2026))
check_weekly_availability(c,{'players':[backup]},d,depth_chart=depth)
emit({'projection_refusals':out,'legacy_absent':n,'depth':c['players'][0]['this_week']})
`);
 assert.deepEqual(o.projection_refusals,['conflicting_injury_identity','conflicting_injury_identity']);
 assert.equal(o.legacy_absent,1);assert.equal(o.depth.reason,'depth_promoted');assert.equal(o.depth.playable,true);
});

test('all original blobs and four historical code pins remain exact; candidate source pins are separate',()=>{
 const o=run(String.raw`
m=json.loads((BASE/'manifest.json').read_text())
for path,pin in m['files'].items():
 data=(BASE/path).read_bytes()
 assert len(data)==pin['raw_bytes']
 assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==pin['git_blob_sha1']
 assert hashlib.sha256(data).hexdigest()==pin['raw_sha256']
c=json.loads((BASE/'candidate_audit.json').read_text())
for path,digest in c['candidate_source_sha256'].items():assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==digest
emit({'verified':len(m['files']),'commit':m['commit'],'candidate':c})
`);
 assert.equal(o.verified,20);assert.equal(o.commit,'0d49a94868142b4e6e888b927363d42270ed23c0');
 assert.equal(Object.keys(o.candidate.candidate_source_sha256).length,4);
 assert.equal(o.candidate.full_pipeline_replayed,false);assert.equal(o.candidate.provider_completeness_verified,false);
});
