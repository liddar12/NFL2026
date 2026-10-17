import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
function py(input,timeout=60000){
 const result=spawnSync('python3',['-B','-'],{cwd:ROOT,input,encoding:'utf8',timeout,
  maxBuffer:4*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr+result.stdout);
 return JSON.parse(result.stdout.trim().split('\n').pop());
}
const UNIT=String.raw`
import contextlib,copy,io,json,pathlib,tempfile
from unittest.mock import patch
from scripts import run_my_generation as R,period_calibrator as P,generation_capture_runtime as C,period_my_generation as M
PIN='a'*40;ENGINEPIN='b'*40;PROFILE='provisional_before_90m_v1'
OID=P.lr.fingerprint('synthetic-owner');APP=P.lr.fingerprint('synthetic-application')
BIND={'runtime_binding_id':P.lr.fingerprint('synthetic-binding'),'binding':{'target_generation_id':P.lr.fingerprint('synthetic-generation')}}
class Journal:
 def __init__(self):self.head={'head_event_id':None,'events':[]}
 def read_owner_intents(self,_):return copy.deepcopy(self.head)
class Control:
 def __init__(self,root):
  self.data=root/'checkout/data';self.data.mkdir(parents=True)
  self.engine_checkout=root/'engine';self.engine_commit=ENGINEPIN;self.engine_code='engine-code'
  self.engine_identity=lambda:self.engine_code;self.freshness_profile=PROFILE;self.clock=lambda:'2026-10-17T12:00:00Z';self.journal=Journal()
 def path(self,*parts):return self.data.joinpath('learning_control',*parts)
 def prepare(self,*a,**kw):raise AssertionError('must not prepare a model')
 def record_intent(self,*a,**kw):raise AssertionError('must not approve a model')
def options(control,root):return dict(data_dir=str(control.data),engine_checkout=str(control.engine_checkout),
 engine_commit=ENGINEPIN,authority_id=OID,actor_ref='synthetic-operator',capture_dir=str(root/'private'),
 generation_sha=PIN,freshness_profile=PROFILE)
def main_args(opts):return ['--execute',*[value for key,item in opts.items()for value in('--'+key.replace('_','-'),str(item))]]
def legacy_result():return {'archive_changed':True,'archive_cards':7,'period_generation_id':None,'application_id':None,'owner_head_event_id':None},copy.deepcopy(BIND)
def existing_head(control):
 path=control.path('owner','heads','synthetic.json');path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}')
`;

test('generation bridge defaults off and requires explicit execution/configuration without loading a consumer',()=>{
 const r=py(String.raw`
import contextlib,io,json
from unittest.mock import patch
from scripts import run_my_generation as R
out=io.StringIO()
with patch.object(R,'run',side_effect=AssertionError('must not run')),contextlib.redirect_stdout(out):code=R.main([])
error=io.StringIO()
with contextlib.redirect_stderr(error):missing=R.main(['--execute'])
print(json.dumps({'code':code,'result':json.loads(out.getvalue()),'missing':missing,'error':json.loads(error.getvalue())}))
`);
 assert.equal(r.code,0);assert.equal(r.result.status,'disabled_dry_run');assert.equal(r.result.writes,false);
 assert.equal(r.missing,2);assert.equal(r.error.success_acknowledged,false);assert.equal(r.error.model_approval_recorded,false);
});

test('no owner intent preserves incumbent route with an explicitly selected freshness policy and no approval call',()=>{
 const r=py(UNIT+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);control=Control(root);opts=options(control,root)
 with patch.object(P,'PeriodCalibrator',side_effect=AssertionError('no shared constructor'))as constructor,patch.object(C,'head_identity',return_value=PIN),\
   patch.object(R,'_legacy',return_value=legacy_result())as legacy,patch.object(M,'generate',side_effect=AssertionError('no candidate'))as approved,\
   patch.object(P.files,'git',return_value=ENGINEPIN),patch.object(C,'persist',return_value=root/'private/binding.json'):
  value=R.run(**opts)
 assert legacy.call_count==1 and approved.call_count==0
 assert constructor.call_count==0
 assert not control.path().exists()
 print(json.dumps(value))
`);
 assert.equal(r.route,'incumbent_no_owner_intent');assert.equal(r.period_generation_id,null);
 assert.equal(r.owner_intent_action,null);assert.equal(r.binding_artifact_name,'binding.json');
 assert.equal(r.freshness_profile,'provisional_before_90m_v1');
 assert.equal(r.engine_used,false);assert.equal(r.engine_commit_verified,false);
 for(const flag of ['model_approval_recorded','owner_authenticated','publication_authorized','production_authorized','public_serving_verified','accuracy_improvement_verified'])assert.equal(r[flag],false);
});

test('an existing explicit intent uses the actual period generation entry, never a new candidate or legacy fallback',()=>{
 const r=py(UNIT+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);control=Control(root);opts=options(control,root)
 existing_head(control)
 control.journal.head={'head_event_id':OID,'events':[{'command':{'action':'approve'}}]}
 link=P.sealed({'application_id':APP,'owner_head_event_id':OID,'runtime_binding':BIND},'period_generation_id')
 result={'archive_changed':True,'archive_cards':7,'period_generation_id':link['period_generation_id'],'application_id':APP}
 with patch.object(P,'PeriodCalibrator',return_value=control),patch.object(C,'head_identity',return_value=PIN),\
   patch.object(R,'_legacy',side_effect=AssertionError('no fallback'))as legacy,patch.object(M,'generate',return_value=result)as approved,\
   patch.object(P.files,'read_json',return_value=link),patch.object(P.files,'git',return_value=ENGINEPIN),\
   patch.object(C,'persist',return_value=root/'private/binding.json'):
  value=R.run(**opts)
 assert approved.call_count==1 and legacy.call_count==0
 assert approved.call_args.kwargs['generation_sha']==PIN
 print(json.dumps(value))
`);
 assert.equal(r.route,'existing_explicit_owner_intent');assert.equal(r.owner_intent_action,'approve');
 assert.ok(r.period_generation_id.startsWith('sha256:'));assert.equal(r.owner_head_event_id,'sha256:'+r.owner_head_event_id.slice(7));
 assert.equal(r.model_approval_recorded,false);assert.equal(r.publication_authorized,false);
});

test('expired/invalid existing intent and unpinned or unselected configuration refuse without legacy fallback or private diagnostics',()=>{
 const r=py(UNIT+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);control=Control(root);opts=options(control,root)
 existing_head(control)
 control.journal.head={'head_event_id':OID,'events':[{'command':{'action':'approve'}}]};rows=[]
 with patch.object(P,'PeriodCalibrator',return_value=control),patch.object(C,'head_identity',return_value=PIN),\
   patch.object(R,'_legacy',side_effect=AssertionError('no fallback'))as legacy,\
   patch.object(M,'generate',side_effect=P.PeriodReturnError('PRIVATE expired intent')):
  for changed in({}, {'freshness_profile':'PRIVATE_PROFILE'}, {'generation_sha':'main'}, {'generation_sha':'c'*40}):
   out,err=io.StringIO(),io.StringIO()
   with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):code=R.main(main_args({**opts,**changed}))
   rows.append({'code':code,'stdout':out.getvalue(),'error':err.getvalue()})
 assert legacy.call_count==0
 print(json.dumps(rows))
`);
 for(const row of r){assert.equal(row.code,2);assert.equal(row.stdout,'');assert.ok(!row.error.includes('PRIVATE'));
  assert.equal(JSON.parse(row.error).success_acknowledged,false);}
});

test('no-intent cannot hide orphan/current/foreign authority, or a new owner event arriving during generation',()=>{
 const r=py(UNIT+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);rows=[]
 for fault in('current','pending','foreign','pool_claim','pool_null','pool_status','pool_rung','owner_arrives'):
  local=root/fault;local.mkdir();control=Control(local);opts=options(control,local)
  if fault in('current','pending'):
   path=control.path(fault+'.json');path.parent.mkdir(parents=True);path.write_text('{}')
  elif fault=='foreign':
   path=control.path('owner','heads','foreign.json');path.parent.mkdir(parents=True);path.write_text('{}')
  elif fault=='pool_claim':(control.data/'leg_pool.json').write_text(json.dumps({'calibration_return':{'version':2}}))
  elif fault=='pool_null':(control.data/'leg_pool.json').write_text(json.dumps({'calibration_return':None}))
  elif fault=='pool_status':(control.data/'leg_pool.json').write_text(json.dumps({'live_adjustment_status':'period return v2: approve'}))
  elif fault=='pool_rung':(control.data/'leg_pool.json').write_text(json.dumps({'players':[{'market':'wr_rec_yds',
    'rungs':[{'learning_receipt':{'input_context':{'calibration_return':None}}}]}]}))
  def candidate_arrives(*args,**kwargs):
   existing_head(control);return legacy_result()
  out,err=io.StringIO(),io.StringIO()
  with patch.object(P,'PeriodCalibrator',return_value=control),patch.object(C,'head_identity',return_value=PIN),\
    patch.object(C,'begin',side_effect=AssertionError('must hold before producing'))as begin,\
    patch.object(P.files,'git',return_value=ENGINEPIN),patch.object(C,'persist',return_value=local/'private/binding.json'),\
    contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
   if fault=='owner_arrives':
    with patch.object(R,'_legacy',side_effect=candidate_arrives):code=R.main(main_args(opts))
   else:code=R.main(main_args(opts))
  assert begin.call_count==0,'an orphan claim must fail before original reads, writes or model operations'
  rows.append(code)
 print(json.dumps(rows))
`);
 assert.deepEqual(r,[2,2,2,2,2,2,2,2]);
});

test('ordinary legacy calibration text/coefficients are not mistaken for an owner-controlled period return',()=>{
 const r=py(UNIT+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 data=(pathlib.Path(tmp)/'data').resolve();data.mkdir();rows=[]
 for pool in({'live_adjustment_status':'applied: validated base receipts','live_adjustment':{'a':.3,'b':1.1}},
             {'live_adjustment_status':'held: legacy or mismatched base decision','live_adjustment':None},
             {'players':[{'market':'wr_rec_yds','rungs':[{'learning_receipt':{'input_context':{'availability':'QUESTIONABLE'}}}]}]}):
  (data/'leg_pool.json').write_text(json.dumps(pool));R._no_intent(data);rows.append(True)
 print(json.dumps(rows))
`);
 assert.deepEqual(r,[true,true,true]);
});

test('actual no-intent CLI builds fresh incumbent MY receipts and captures without creating authority or fitting a new model',t=>{
 const r=py(String.raw`
import contextlib,copy,io,json,os,pathlib,shutil,tempfile
from unittest.mock import patch
from scripts import run_my_generation as R,run_parlay_feedback as F,build_leg_pool as B
from scripts import generation_capture_runtime as C,period_calibrator as P,my_freshness as S
from tests.fixtures import period_eligibility as fixture
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
with tempfile.TemporaryDirectory()as tmp:
 engine=pathlib.Path(tmp)/'not-installed-engine';pin='b'*40
 root=pathlib.Path(tmp)/'checkout';root.mkdir();data=root/'data';data.mkdir()
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  path=root/relative;path.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,path)
 docs=fixture.make(qb=True)['docs']
 for name,relative in C._input_paths(2026,6).items():
  value=docs[name]
  if value is None:continue
  path=root/relative;path.parent.mkdir(parents=True,exist_ok=True)
  path.write_text(json.dumps(value,ensure_ascii=True,indent=2)+'\n')
 F.git(root,'init');F.git(root,'config','user.name','Synthetic Test');F.git(root,'config','user.email','synthetic@example.invalid')
 F.git(root,'add','.');F.git(root,'-c','commit.gpgsign=false','commit','-m','synthetic no-intent source')
 source=C.head_identity(root);private=pathlib.Path(tmp)/'private';authority=P.lr.fingerprint('synthetic-no-intent')
 args=['--execute','--data-dir',str(data),'--engine-checkout',str(engine),'--engine-commit',pin,
  '--authority-id',authority,'--actor-ref','synthetic-operator','--capture-dir',str(private),
  '--generation-sha',source,'--freshness-profile',S.PROFILE]
 results=[]
 with patch.object(P,'PeriodCalibrator',side_effect=AssertionError('no shared constructor')),\
   patch.object(F,'engine',side_effect=AssertionError('no shared engine import')):
  for now in(fixture.CAPTURE,'2026-10-16T20:00:30Z'):
   out,err=io.StringIO(),io.StringIO()
   with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):code=R.main(args,clock=lambda:now)
   assert code==0,(err.getvalue(),out.getvalue());result=json.loads(out.getvalue());results.append(result)
   binding=json.loads((private/result['binding_artifact_name']).read_bytes())
   assert binding['runtime_binding_id']==result['runtime_binding_id']
   assert binding['binding']['target_generation_id']==result['target_generation_id']
   assert all(binding['claims'][key]is False for key in C.CLAIMS)
   assert not(data/'learning_control').exists()
 pool=json.loads((data/'leg_pool.json').read_bytes());archive=json.loads((data/'my_cards/2026_wk06.json').read_bytes())
 assert pool['freshness_policy']['profile']==S.PROFILE and pool.get('calibration_return')is None
 assert pool['live_adjustment']is None and pool['players']
 assert 'espn-7'not in {p['gsis_id']for p in pool['players']}
 assert archive['cards']and len(archive['runs'])==2
 assert len(list((data/'snapshots/learning_journal/2026_wk06').glob('*.json')))==2
 assert results[0]['route']==results[1]['route']=='incumbent_no_owner_intent'
 assert results[0]['runtime_binding_id']!=results[1]['runtime_binding_id']
 print(json.dumps({'results':results,'fresh_players':len(pool['players']),'cards':len(archive['cards'])}))
`,120000);
 assert.equal(r.results.length,2);assert.ok(r.fresh_players>0&&r.cards>0);
 for(const result of r.results){assert.equal(result.model_approval_recorded,false);assert.equal(result.public_serving_verified,false);}
});
