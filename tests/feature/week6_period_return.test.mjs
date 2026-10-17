import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;

test('real frozen forecasts/raw outcomes/gated fit/owner journal change only future MY props through the actual producer',t=>{
 if(!ENGINE||!existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/store/file_owner_intents.py')){
  t.skip('Explicit SELFLEARN_CHECKOUT with the file owner port is required');return;
 }
 const r=spawnSync('python3',['-B','-'],{cwd:ROOT,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},input:String.raw`
import copy,json,os,pathlib,tempfile
from scripts import build_leg_pool as B,run_parlay_feedback as F,learning_receipts as L
from scripts.period_calibrator import PeriodCalibrator
from tests.fixtures import period_return as fixture
engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=F.git(engine,'rev-parse','HEAD')
with tempfile.TemporaryDirectory()as tmp:
 data=pathlib.Path(tmp)/'data';records=fixture.training(data,engine,pin)
 initial,schedule,_,_=fixture.inputs(6,'2026-10-16T18:00:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,initial,schedule);old=B.build(initial);fixture.write(data/'leg_pool.json',old)
 now=['2026-10-16T19:00:00Z']
 control=PeriodCalibrator(data_dir=data,engine_checkout=engine,engine_commit=pin,
  authority_id=L.fingerprint('synthetic-local-operator-authority'),actor_ref='configured-fixture-operator',clock=lambda:now[0])
 oid=control.prepare(season=2026,week=6)
 ack=control.record_intent(oid,action='approve',expires_utc='2026-10-21T00:00:00Z',
  reason='Synthetic local mechanics only; not an actual owner approval or accuracy claim',acknowledge_retrospective=True)
 current,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,current,schedule);now[0]='2026-10-16T20:00:01Z'
 baseline=B.build(current);pool,application=control.apply_and_save(current)
 assert pool['game_legs']==baseline['game_legs']and pool['atd_legs']==baseline['atd_legs']
 assert pool['counts']['period_return_not_future']==2
 assert len(pool['players'])==22
 originals={p['gsis_id']:p for p in baseline['players']};changed=0
 for player in pool['players']:
  for rung in player['rungs']:
   receipt=rung['learning_receipt'];prior=originals[player['gsis_id']]['rungs'][0]['learning_receipt']
   assert receipt['base_prob']==prior['base_prob']and receipt['base_model_version']==prior['base_model_version']
   assert receipt['served_prob']==L.serve_probability(receipt['base_prob'],pool['live_adjustment'])
   assert receipt['input_context']['calibration_return']['owner_head_event_id']==ack['event_id']
   assert receipt['input_context']['calibration_return']['application_context_id']==application['application_context_id']
   assert L.receipt_problem(receipt,{**player,**rung},2026,6)is None
   changed+=receipt['served_prob']!=prior['served_prob']
 assert changed>0 and control.current()[0]==application['current_id']
 assert not control.path('pending.json').exists()
 assert json.loads(control.path('pools',L.fingerprint(old)[7:]+'.json').read_text())==old
 # The same exact fixed candidate can return on another fresh generation.
 retained={p:p.read_bytes()for folder in('applications','pools')for p in control.path(folder).glob('*.json')}
 next_inputs,next_schedule,_,_=fixture.inputs(6,'2026-10-16T20:30:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,next_inputs,next_schedule);now[0]='2026-10-16T20:30:01Z'
 repeated,second=control.apply_and_save(next_inputs)
 assert second['artifact_id']==application['artifact_id']and second['owner_head_event_id']==ack['event_id']
 assert second['previous_application_id']==application['application_id']
 assert all(p.read_bytes()==raw for p,raw in retained.items())
 # Both real new forecast journals enter the shared feedback state BEFORE
 # any later outcome corrections. Ungraded future legs do not become labels.
 from scripts import learning_journal as J
 J.record(pool,schedule,None,[],'2026-10-16T20:01:00Z',str(data/'snapshots'))
 J.record(repeated,next_schedule,None,[],'2026-10-16T20:31:00Z',str(data/'snapshots'))
 F.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[],engine_checkout=engine,engine_commit=pin,
  observed_utc='2026-10-16T20:32:00Z',evaluation_clock=lambda:'2026-10-16T20:32:01Z')
 original_files={p:p.read_bytes()for p in(data/'snapshots').rglob('*')if p.is_file()}
 # Actual raw corrections, not supplied labels or a fabricated PASS report,
 # create a distinct, independently gated candidate B through the real fitter.
 week,_,old_schedule,actuals,snaps=records[-1];corrected=copy.deepcopy(actuals)
 for row in corrected[:1]:
  key={'QB':'passing_yards','RB':'rushing_yards','WR':'receiving_yards'}[row['position']]
  row[key]='20'if row[key]=='80'else'80'
 bundle=fixture.outcomes(week,old_schedule,corrected,snaps,'2026-10-16T21:00:00Z')
 from scripts import capture_outcome_evidence as C
 saved=C.save_capture(bundle,pathlib.Path(tmp)/'corrected-raw')
 F.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[saved],engine_checkout=engine,engine_commit=pin,
  observed_utc='2026-10-16T22:00:00Z',evaluation_clock=lambda:'2026-10-16T22:00:01Z')
 now[0]='2026-10-16T22:30:00Z';oid_b=control.prepare(season=2026,week=6)
 b=control.record_intent(oid_b,action='approve',expires_utc='2026-10-21T00:00:00Z',
  reason='Synthetic second candidate; explicit separate local approval',acknowledge_retrospective=True)
 fresh,fs,_,_=fixture.inputs(6,'2026-10-16T23:00:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,fresh,fs);now[0]='2026-10-16T23:00:01Z'
 pool_b,app_b=control.apply_and_save(fresh)
 assert app_b['artifact_id']!=application['artifact_id']and app_b['owner_head_event_id']==b['event_id']
 assert app_b['previous_application_id']==second['application_id']
 assert all(p.read_bytes()==raw for p,raw in original_files.items())
 # An explicit rollback may select only a previously applied, still-valid A.
 now[0]='2026-10-16T23:10:00Z'
 rollback=control.record_intent(oid,action='rollback',expires_utc='2026-10-21T00:00:00Z',
  reason='Synthetic tested rollback to the exact earlier artifact',acknowledge_retrospective=True)
 fresh,fs,_,_=fixture.inputs(6,'2026-10-16T23:20:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,fresh,fs);now[0]='2026-10-16T23:20:01Z'
 restored,app_a=control.apply_and_save(fresh)
 assert app_a['artifact_id']==application['artifact_id']and app_a['owner_head_event_id']==rollback['event_id']
 assert app_a['previous_application_id']==app_b['application_id']
 assert all(p.read_bytes()==raw for p,raw in retained.items())
 # Failure after either mutable file is written must be visible and recover
 # to the acknowledged old pool, without deleting its immutable history.
 from scripts.period_calibrator import PeriodReturnError,NS
 for at in(2,3):
  before=data.joinpath('leg_pool.json').read_bytes();prior=control.path('current.json').read_bytes()
  real=control._replace;calls=[0]
  def fail(path,value):
   real(path,value);calls[0]+=1
   if calls[0]==at:raise OSError('synthetic post-rename fault')
  control._replace=fail
  try:control.apply_and_save(fresh);raise AssertionError('fault was not reached')
  except OSError:pass
  finally:control._replace=real
  assert control.path('pending.json').exists()
  try:control.current();raise AssertionError('incomplete generation accepted')
  except PeriodReturnError as e:assert str(e)=='period_return_local_transaction_incomplete'
  with control.journal.lock(NS):control._recover()
  assert json.loads(data.joinpath('leg_pool.json').read_text())==json.loads(before)
  assert json.loads(control.path('current.json').read_text())==json.loads(prior)
  assert not control.path('pending.json').exists()
 # A second feedback cycle with no new labels is idempotent about outcomes,
 # while adding the actual returned pool's pre-kickoff forecast journal.
 J.record(restored,fs,None,[],'2026-10-16T23:21:00Z',str(data/'snapshots'))
 F.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[saved],engine_checkout=engine,engine_commit=pin,
  observed_utc='2026-10-16T23:25:00Z',evaluation_clock=lambda:'2026-10-16T23:25:01Z')
 assert all(p.read_bytes()==raw for p,raw in original_files.items())
 # Revocation does not need any old raw capture or an available fitter.
 now[0]='2026-10-16T23:30:00Z';outcomes=data/'snapshots/learning_outcomes'
 outcomes.rename(pathlib.Path(tmp)/'temporarily-unavailable-raw')
 fixture.write(control.path('pending.json'),{'synthetic_broken_transaction':True})
 revoke=control.record_intent(oid,action='revoke',reason='Synthetic stop while raw history is unavailable')
 control.path('pending.json').rename(pathlib.Path(tmp)/'invalid-transaction-for-operator-repair')
 latest=control.journal.read_owner_intents(NS);first=latest['events'][0]['command'];count=len(latest['events'])
 retry=control.journal.append_owner_intent(first)
 assert retry['event_id']==ack['event_id']and len(control.journal.read_owner_intents(NS)['events'])==count
 fresh,fs,_,_=fixture.inputs(6,'2026-10-16T23:40:00Z',n=24,tag='future',past=True)
 fixture.write_inputs(data,fresh,fs);now[0]='2026-10-16T23:40:01Z'
 reset,stop=control.apply_and_save(fresh);base=B.build(fresh)
 assert stop['artifact_id']is None and stop['action']=='revoke'and stop['owner_head_event_id']==revoke['event_id']
 assert reset['live_adjustment']==base['live_adjustment']
 baseline={p['gsis_id']:p for p in base['players']}
 assert all(r['model_prob']==baseline[p['gsis_id']]['rungs'][i]['model_prob']
  for p in reset['players']for i,r in enumerate(p['rungs']))
 print(json.dumps({'changed_future_rungs':changed,'held_past_players':pool['counts']['period_return_not_future'],
  'applied_artifact':application['artifact_id'],'separate_candidate_b':True,'rollback':True,'revocation_without_raw':True,
  'recovery_fault_points':2,'public_serving_verified':False,'actual_owner_authenticated':False}))
`});
 assert.equal(r.status,0,r.stderr+r.stdout);
 const result=JSON.parse(r.stdout.trim().split('\n').pop());
 assert.ok(result.changed_future_rungs>0);assert.equal(result.held_past_players,2);
 assert.equal(result.public_serving_verified,false);assert.equal(result.actual_owner_authenticated,false);
});

test('actual local Git publisher cannot release local-only v2 control records, even if hidden after commit',()=>{
 const r=spawnSync('python3',['-B','-'],{cwd:ROOT,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},input:String.raw`
import json,os,pathlib,shutil,subprocess,sys,tempfile
root_code=pathlib.Path.cwd()
def git(root,*args):
 result=subprocess.run(['git','-C',str(root),*args],text=True,capture_output=True,check=True,timeout=10)
 return result.stdout.strip()
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);origin=root/'origin.git';work=root/'work'
 os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
 git(root,'init','--bare',str(origin));git(root,'clone',str(origin),str(work))
 git(work,'config','user.email','synthetic@example.invalid');git(work,'config','user.name','Synthetic Fixture')
 git(work,'config','gc.auto','0');git(work,'config','maintenance.auto','false')
 (work/'README').write_text('synthetic local-only release guard\n');git(work,'add','README')
 git(work,'-c','commit.gpgsign=false','commit','-m','initial');git(work,'branch','-M','main');git(work,'push','origin','main')
 before=git(origin,'rev-parse','refs/heads/main');control=work/'data/learning_control';control.mkdir(parents=True)
 (control/'synthetic-marker.json').write_text('{}\n')
 fake=root/'fake-bin';fake.mkdir();wrapper=fake/'git';real=shutil.which('git')
 wrapper.write_text('#!'+sys.executable+'\nimport os,sys,subprocess,pathlib\nreal='+repr(real)+'\n'
  'if len(sys.argv)>1 and sys.argv[1]=="fetch":\n code=subprocess.run([real,*sys.argv[1:]]).returncode\n'
  ' path=pathlib.Path.cwd()/"data/learning_control"\n if code==0 and path.exists():path.rename(path.with_name("hidden-local-control"))\n sys.exit(code)\n'
  'os.execv(real,[real,*sys.argv[1:]])\n');wrapper.chmod(0o700)
 env={**os.environ,'PATH':str(fake)+os.pathsep+os.environ['PATH'],'PUBLISH_VALIDATE_CMD':'true',
  'PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0'}
 result=subprocess.run(['bash',str(root_code/'scripts/publish_data.sh'),'data: synthetic control refusal'],
  cwd=work,env=env,capture_output=True,text=True,timeout=20)
 print(json.dumps({'exit':result.returncode,'remote_unchanged':git(origin,'rev-parse','refs/heads/main')==before,
  'working_control_hidden':not control.exists(),'committed_control':git(work,'cat-file','-t','HEAD:data/learning_control')=='tree',
  'v2_gate_reason':'unfinished exact-tree publication gate'in(result.stdout+result.stderr)}))
`});
 assert.equal(r.status,0,r.stderr+r.stdout);
 assert.deepEqual(JSON.parse(r.stdout.trim()),{exit:1,remote_unchanged:true,working_control_hidden:true,
  committed_control:true,v2_gate_reason:true});
});

test('period consumer refuses missing authority, changed evidence, clocks, sources, base, and JSON capability claims',t=>{
 if(!ENGINE||!existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/store/file_owner_intents.py')){
  t.skip('Explicit SELFLEARN_CHECKOUT with the file owner port is required');return;
 }
 const r=spawnSync('python3',['-B','-'],{cwd:ROOT,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},input:String.raw`
import copy,json,os,pathlib,shutil,tempfile
from scripts import build_leg_pool as B,run_parlay_feedback as F,learning_receipts as L
from scripts.period_calibrator import PeriodCalibrator,PeriodReturnError
from tests.fixtures import period_return as fixture
engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=F.git(engine,'rev-parse','HEAD')
authority=L.fingerprint('synthetic-negative-fixture-authority');now=['2026-10-16T19:00:00Z']
def configured(data):return PeriodCalibrator(data_dir=data,engine_checkout=engine,engine_commit=pin,
 authority_id=authority,actor_ref='configured-fixture-operator',clock=lambda:now[0])
def refused(call,expected):
 try:call()
 except(ValueError,FileNotFoundError)as e:
  assert expected in str(e),(expected,str(e));return
 raise AssertionError('unexpected period return acceptance: '+expected)
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);seed=root/'seed';fixture.training(seed,engine,pin)
 initial,schedule,_,_=fixture.inputs(6,'2026-10-16T18:00:00Z',n=24,tag='negative',past=True)
 fixture.write_inputs(seed,initial,schedule);fixture.write(seed/'leg_pool.json',B.build(initial))
 control=configured(seed);oid=control.prepare(season=2026,week=6)
 refused(lambda:control.record_intent(oid,action='approve',expires_utc='2026-10-20T00:00:00Z',reason='No risk acknowledgment'),
  'period_return_risk_ack_required')
 control.record_intent(oid,action='approve',expires_utc='2026-10-20T00:00:00Z',reason='Synthetic rejection fixture',
  acknowledge_retrospective=True)
 cases=0
 def case(label,mutate,expected):
  global cases
  data=root/label;shutil.copytree(seed,data);control=configured(data)
  value,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=24,tag='negative',past=True)
  now[0]='2026-10-16T20:00:01Z';mutate(control,value,schedule)
  fixture.write_inputs(data,value,schedule);before=(data/'leg_pool.json').read_bytes()
  refused(lambda:control.apply_and_save(value),expected)
  assert(data/'leg_pool.json').read_bytes()==before
  assert not control.path('pending.json').exists()and not control.path('current.json').exists()
  cases+=1
 case('missing-authority',lambda c,v,s:c.path('owner').rename(c.path('unavailable-owner')),'period_return_no_owner_intent')
 case('base-held',lambda c,v,s:v['pool_backtest']['verdict'].update(adopt=False),'period_return_base_gate_held')
 case('boolean-gate',lambda c,v,s:v['pool_backtest']['verdict'].update(adopt=1),'period_return_base_gate_held')
 case('wrong-period',lambda c,v,s:v['parlays'].update(week=7),'period_return_wrong_period')
 case('boolean-week',lambda c,v,s:v['parlays'].update(week=True),'invalid')
 case('wrong-base',lambda c,v,s:v['pool_backtest']['calibration']['QB'].update(a=.1),'period_return_base_changed')
 case('stale-feed',lambda c,v,s:v['player_weekly'].update(generated_utc='2026-10-15T00:00:00Z'),'period_return_source_stale')
 case('future-feed',lambda c,v,s:v['player_weekly'].update(generated_utc='2026-10-16T21:00:00Z'),'period_return_source_stale')
 case('stale-schedule',lambda c,v,s:s.update(updated_utc='2026-10-15T00:00:00Z'),'period_return_schedule_stale')
 def no_cutoffs(c,v,s):
  for game in s['games']:game.pop('kickoff_utc',None)
 case('unknown-cutoffs',no_cutoffs,'period_return_no_future_games')
 case('contradictory-matchup',lambda c,v,s:s['games'][0].update(home='NYJ'),'period_return_schedule_game_mismatch')
 case('engine-drift',lambda c,v,s:setattr(c,'engine_identity',lambda:L.fingerprint('other-code')),'period_return_engine_changed')
 def too_old(c,v,s):now[0]='2026-10-16T21:00:00Z'
 case('stale-generation',too_old,'period_return_generation_clock_stale')
 def future_creation(c,v,s):v['generated_utc']='2026-10-16T21:00:00Z'
 case('future-generation',future_creation,'period_return_generation_clock_stale')
 def before_approval(c,v,s):
  v['generated_utc']='2026-10-16T18:30:00Z';now[0]='2026-10-16T18:30:01Z'
 case('forecast-before-intent',before_approval,'owner_snapshot_before_event')
 def expired(c,v,s):
  v['generated_utc']='2026-10-20T00:00:00Z';now[0]='2026-10-20T00:00:01Z'
 case('expired-approval',expired,'period_return_approval_expired')
 def lost_raw(c,v,s):(c.data/'snapshots/learning_outcomes').rename(c.data/'unavailable-raw')
 case('missing-raw',lost_raw,'missing_or_invalid_capture_object')
 def corrupt_pool(c,v,s):
  old=F.read_json(c.data/'leg_pool.json');old['players'][0]['rungs'][0]['model_prob']=.1234;fixture.write(c.data/'leg_pool.json',old)
 case('unverified-incumbent',corrupt_pool,'period_return_current_receipts_unverified')
 # Even a self-consistently rehashed candidate/report/package cannot substitute
 # for independently rerunning the real fitter over its frozen raw evidence.
 data=root/'forged-report';shutil.copytree(seed,data);control=configured(data);now[0]='2026-10-16T20:00:01Z'
 forged=copy.deepcopy(control.journal.get_object(oid)['payload']);report=forged['evaluation']['report']
 candidate=report['candidate'];candidate['coefficients']['a']=round(candidate['coefficients']['a']+.1,6)
 candidate['candidate_id']=L.fingerprint({k:v for k,v in candidate.items()if k!='candidate_id'})
 report['report_id']=L.fingerprint({k:v for k,v in report.items()if k!='report_id'})
 forged['evaluation']['evaluation_id']=L.fingerprint({k:v for k,v in forged['evaluation'].items()if k!='evaluation_id'})
 fake_id=control._save_object(forged)
 refused(lambda:control.record_intent(fake_id,action='approve',expires_utc='2026-10-20T00:00:00Z',
  reason='Forged report must fail',acknowledge_retrospective=True),'period_return_evaluation_mismatch');cases+=1
 # The public producer does not accept an uploaded dict as configured authority.
 refused(lambda:B.build(initial,calibration_return={'approved':True,'candidate_id':candidate['candidate_id']}),
  'period_return_configured_capability_required');cases+=1
 # A caller cannot replace the actual repository source with a different body.
 value,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=24,tag='negative',past=True)
 fixture.write_inputs(data,value,schedule);value['player_weekly']['players'][0]['league_components']['pass_yd']=99
 refused(lambda:control.apply_and_save(value),'period_return_inputs_do_not_match_repository');cases+=1
 print(json.dumps({'refused_cases':cases,'public_serving_verified':False}))
`});
 assert.equal(r.status,0,r.stderr+r.stdout);
 const result=JSON.parse(r.stdout.trim().split('\n').pop());assert.ok(result.refused_cases>=20);
});
