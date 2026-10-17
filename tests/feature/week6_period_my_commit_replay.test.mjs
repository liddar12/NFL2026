import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url);
const ENGINE = process.env.SELFLEARN_CHECKOUT;
test('exact committed MY replay checks original bytes, actual journal/archive, current authority and retained base', (t) => {
  if (!ENGINE || !existsSync(`${ENGINE}/packages/selflearn-core/selflearn_core/store/file_owner_intents.py`)) {
    t.skip('Explicit SELFLEARN_CHECKOUT is required for actual producer/shared-kernel replay'); return;
  }
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 180000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: String.raw`
import contextlib,copy,io,json,os,pathlib,shutil,tempfile
from scripts import availability as A,build_leg_pool as B,run_parlay_feedback as F,learning_receipts as L
from scripts import period_my_generation as MY,period_my_commit_replay as G,generation_capture_runtime as C
from scripts.period_calibrator import PeriodCalibrator
from tests.fixtures import period_return as fixture
engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=F.git(engine,'rev-parse','HEAD')
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp)/'checkout';root.mkdir();data=root/'data'
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,target)
 cfg=root/'config/excluded_games.json';cfg.parent.mkdir(parents=True);shutil.copyfile(F.ROOT/'config/excluded_games.json',cfg)
 fixture.training(data,engine,pin)
 current,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=24,tag='MY-commit',past=True)
 fixture.write_inputs(data,current,schedule);fixture.write(data/'leg_pool.json',B.build(current))
 fixture.write(data/'injuries.json',A.enrich_document({'season':2026,'week':6,'source':'espn',
  'updated_utc':'2026-10-16T19:30:00Z','source_updated_utc':'2026-10-16T19:30:00Z',
  'received_utc':'2026-10-16T19:30:00Z','injuries':[
   {'team':p['team'],'player':p['name'],'status':'Active'}for p in current['player_projections']['players']]}))
 now=['2026-10-16T20:01:00Z'];control=PeriodCalibrator(data_dir=data,engine_checkout=engine,engine_commit=pin,
  authority_id=L.fingerprint('synthetic-MY-commit-authority'),actor_ref='synthetic-MY-commit-operator',clock=lambda:now[0])
 oid=control.prepare(season=2026,week=6);control.record_intent(oid,action='approve',
  expires_utc='2026-10-16T20:05:00Z',reason='Synthetic exact-tree test, not actual owner approval',acknowledge_retrospective=True)
 F.git(root,'init');F.git(root,'config','user.email','synthetic@example.invalid')
 F.git(root,'config','user.name','Synthetic Fixture');F.git(root,'config','gc.auto','0')
 F.git(root,'config','maintenance.auto','false')
 def commit(message):
  F.git(root,'add','.');F.git(root,'-c','commit.gpgsign=false','commit','-m',message);return F.git(root,'rev-parse','HEAD')
 base=commit('synthetic base with owner intent, before MY generation')
 now[0]='2026-10-16T20:02:00Z'
 with contextlib.redirect_stdout(io.StringIO()):result=MY.generate(control,generation_sha=base,
  capture_dir=pathlib.Path(tmp)/'private-originals')
 head=commit('actual approved local MY generation')
 def check(head,*,base=base,gid=result['period_generation_id']):
  return G.check_committed(checkout=root,expected_head=head,base_head=base,period_generation_id=gid,
   engine_checkout=engine,engine_commit=pin,authority_id=control.authority_id,actor_ref=control.actor_ref,clock=lambda:now[0])
 # Corrupt unrelated worktree reads before the positive check: only the exact
 # committed data/browser tree may be materialized. Never repair or overwrite it.
 working=data/'player_weekly.json';original=working.read_bytes();working.write_bytes(b'{broken worktree')
 browser=next((root/'app').rglob('*.js'));browser_original=browser.read_bytes();browser.write_bytes(b'broken worktree browser')
 proof=check(head)
 assert proof['committed_data_tree_verified']and proof['original_bytes_and_outputs_verified']
 assert proof['configured_owner_chain_verified']and proof['head']==head and proof['base_head']==base
 assert proof['period_generation_id']==result['period_generation_id']
 for flag in('upstream_eligibility_verified','MY_card_semantics_verified','whole_release_pass',
  'owner_authenticated','publication_authorized','public_serving_verified','production_authorized','source_writes','network_used'):
  assert proof[flag]is False,(flag,proof)
 assert working.read_bytes()==b'{broken worktree'and browser.read_bytes()==b'broken worktree browser'
 working.write_bytes(original);browser.write_bytes(browser_original)
 from scripts import period_operator as O
 out=io.StringIO()
 args=['--data-dir',str(data),'--engine-checkout',str(engine),'--engine-commit',pin,
  '--authority-id',control.authority_id,'--actor-ref',control.actor_ref,'replay-my-commit',
  '--expected-head',head,'--base-head',base,'--period-generation-id',result['period_generation_id']]
 with contextlib.redirect_stdout(out):code=O.main(args,clock=lambda:now[0])
 assert code==0;cli=json.loads(out.getvalue())
 assert cli['operation']=='replay-my-commit'and cli['details']['head']==head
 assert cli['publication_authorized']is False and cli['details']['upstream_eligibility_verified']is False
 refused=0
 # The real fitter/downstream work must not outlive the authorization checked
 # at entry. Change the injected operator clock only after actual MY replay.
 from unittest.mock import patch
 real_replay=G.my.replay_binding
 def late_finish(binding):
  answer=real_replay(binding);now[0]='2026-10-16T20:05:00Z';return answer
 with patch.object(G.my,'replay_binding',side_effect=late_finish):
  try:check(head);raise AssertionError('authorization expiring during replay accepted')
  except ValueError as e:assert 'period_return_approval_expired'in str(e)
 now[0]='2026-10-16T20:02:00Z';refused+=1
 def case(label,path,changed,reason,*,gid=result['period_generation_id']):
  global refused
  raw=path.read_bytes();path.write_bytes(changed(raw));bad=commit(label);path.write_bytes(raw)
  try:check(bad,gid=gid);raise AssertionError('bad committed tree accepted: '+label)
  except ValueError as e:assert reason in str(e),(label,reason,str(e))
  commit('restore '+label);refused+=1
 archive=data/'my_cards/2026_wk06.json'
 case('changed committed card output',archive,lambda raw:raw+b' ', 'period_MY_output_changed_after_writer')
 case('changed committed injury witness',data/'injuries.json',lambda raw:raw+b' ', 'period_MY_original_input_changed')
 case('changed committed browser',browser,lambda raw:raw+b'\n// synthetic change', 'period_MY_committed_runtime_or_browser_changed')
 case('changed committed exclusions',cfg,lambda raw:raw+b' ', 'period_MY_committed_exclusions_changed')
 # The graph must exist in the actual committed journal, not only in the
 # self-consistent runtime link. An uncommitted repair cannot supply the file.
 link=control.path('generations',result['period_generation_id'][7:]+'.json');value=json.loads(link.read_bytes())
 target=value['runtime_binding']['binding']['target_generation_id']
 journal=data/'snapshots/learning_journal/2026_wk06'/(target[7:]+'.json');raw=journal.read_bytes();journal.unlink()
 bad=commit('missing actual committed journal');journal.write_bytes(raw)
 try:check(bad);raise AssertionError('only embedded journal accepted')
 except ValueError as e:assert 'feedback_committed_file_missing'in str(e)
 commit('restore actual journal');refused+=1
 forged=copy.deepcopy(value);forged['MY_card_semantics_verified']=True
 forged=G.period.sealed({k:v for k,v in forged.items()if k!='period_generation_id'},'period_generation_id')
 forged_path=control.path('generations',forged['period_generation_id'][7:]+'.json');fixture.write(forged_path,forged)
 bad=commit('rehashed forged semantic claim')
 try:check(bad,gid=forged['period_generation_id']);raise AssertionError('forged PASS accepted')
 except ValueError as e:assert 'period_MY_committed_link_invalid'in str(e)
 forged_path.unlink();commit('remove forged semantic claim');refused+=1
 # Publish history now includes the first real MY generation. Another actual
 # refresh has zero new display keys and must descend from this exact base.
 first=F.git(root,'rev-parse','HEAD');now[0]='2026-10-16T20:02:30Z'
 with contextlib.redirect_stdout(io.StringIO()):repeat=MY.generate(control,generation_sha=first,
  capture_dir=pathlib.Path(tmp)/'private-originals')
 second=commit('second actual MY generation retaining all old cards')
 newer=check(second,base=first,gid=repeat['period_generation_id'])
 assert newer['history_retention']['retained_immutable_files']>0
 assert newer['application_id']!=proof['application_id']
 try:check(second,base=first);raise AssertionError('obsolete MY link accepted for new application')
 except ValueError as e:assert 'period_MY_committed_application_mismatch'in str(e)
 refused+=1
 # A pointer rewind can leave every immutable file intact. Base-chain
 # membership must still reject it, even though the older app replays honestly.
 pointer=control.path('current.json');current_pointer=pointer.read_bytes()
 original_pointer=G.runtime._git(root,['show',first+':data/learning_control/current.json'],limit=4096)
 second_pool=(data/'leg_pool.json').read_bytes();second_archive=archive.read_bytes()
 pointer.write_bytes(original_pointer)
 old_pool=G.runtime._git(root,['show',first+':data/leg_pool.json'],limit=G.gate.MAX_FILE)
 old_archive=G.runtime._git(root,['show',first+':data/my_cards/2026_wk06.json'],limit=G.gate.MAX_FILE)
 (data/'leg_pool.json').write_bytes(old_pool);archive.write_bytes(old_archive)
 rewind=commit('pointer rewind retaining all immutable files')
 try:check(rewind,base=second);raise AssertionError('current pointer rewind accepted')
 except ValueError as e:assert 'period_MY_application_history_not_descendant'in str(e)
 pointer.write_bytes(current_pointer);(data/'leg_pool.json').write_bytes(second_pool);archive.write_bytes(second_archive)
 commit('restore newest current application');refused+=1
 # Retaining immutable event files is not enough either: the mutable owner
 # head may not rewind below the exact fetched base's acknowledged intent.
 owner=control.journal._head_path({'domain':'nfl','task':'nfl.parlay_leg','producer_id':'nfl2026'})
 old_owner=owner.read_bytes();now[0]='2026-10-16T20:03:00Z'
 control.record_intent(oid,action='approve',expires_utc='2026-10-16T20:05:00Z',
  reason='Synthetic separately renewed intent for base-chain test',acknowledge_retrospective=True)
 now[0]='2026-10-16T20:03:30Z'
 with contextlib.redirect_stdout(io.StringIO()):renewed=MY.generate(control,generation_sha=second,
  capture_dir=pathlib.Path(tmp)/'private-originals')
 third=commit('new owner intent and acknowledged MY application')
 owner.write_bytes(old_owner);pointer.write_bytes(current_pointer)
 (data/'leg_pool.json').write_bytes(second_pool);archive.write_bytes(second_archive)
 rewound_owner=commit('rewound owner head preserving all immutable events')
 try:check(rewound_owner,base=third,gid=repeat['period_generation_id']);raise AssertionError('owner rewind accepted')
 except ValueError as e:assert 'period_MY_owner_history_not_descendant'in str(e)
 refused+=1
 print(json.dumps({'exact_tree_replayed':True,'worktree_repairs_ignored':True,'retained_refresh_replayed':True,
  'actual_operator_CLI_verified':True,
  'refused_cases':refused,'MY_card_semantics_verified':proof['MY_card_semantics_verified'],
  'production_authorized':proof['production_authorized']}))
` });
  assert.equal(r.status, 0, `${r.error?.code || ''}\n${r.stderr}\n${r.stdout}`);
  const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(result.exact_tree_replayed, true);
  assert.equal(result.worktree_repairs_ignored, true);
  assert.equal(result.retained_refresh_replayed, true);
  assert.equal(result.actual_operator_CLI_verified, true);
  assert.equal(result.refused_cases, 10);
  assert.equal(result.MY_card_semantics_verified, false);
  assert.equal(result.production_authorized, false);
});

test('committed MY replay rechecks expiry, source age, candidate age and kickoff after downstream work', () => {
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: String.raw`
import copy,json
from scripts import period_my_commit_replay as G
class Journal:
 def get_object(self,oid):return {'payload':{'evaluation':{'report':{'candidate':{'fit_as_of_utc':fit[0]}}}}}
class Control:journal=Journal()
fit=['2026-10-16T18:00:00Z']
app={'forecast_created_utc':'2026-10-16T20:00:00Z','expires_utc':'2026-10-16T20:10:00Z',
 'action':'approve','evidence_object_id':'synthetic','eligible_game_ids':['future']}
source={'updated_utc':'2026-10-16T19:30:00Z'}
capture={'inputs':{n:{'raw_utf8':json.dumps(source)}for n in('player_weekly','player_projections','game_predictions')}}
capture['inputs']['schedule']={'raw_utf8':json.dumps({**source,'games':[{'game_id':'future','kickoff_utc':'2026-10-16T20:14:00Z'}]})}
G._final_time(Control(),app,capture,'2026-10-16T20:02:00Z')
cases=0
def held(a,c,checked,reason):
 global cases
 try:G._final_time(Control(),a,c,checked);raise AssertionError('final clock accepted')
 except ValueError as e:assert reason in str(e),(reason,str(e))
 cases+=1
held(app,capture,'2026-10-16T20:10:00Z','period_return_approval_expired')
noexpiry={**app,'expires_utc':None}
held(noexpiry,capture,'2026-10-16T20:15:01Z','period_return_verification_deadline')
held(noexpiry,capture,'2026-10-16T20:14:00Z','period_return_event_started')
held(app,capture,'2026-10-16T19:59:59Z','period_return_verification_deadline')
for clock in('2026-10-16T08:01:59Z','2026-10-16T20:02:01Z'):
 bad=copy.deepcopy(capture);bad['inputs']['player_weekly']['raw_utf8']=json.dumps({'updated_utc':clock})
 held(app,bad,'2026-10-16T20:02:00Z','period_return_source_stale')
for stamp in('2026-10-09T20:01:59Z','2026-10-16T20:02:01Z'):
 fit[0]=stamp;held(app,capture,'2026-10-16T20:02:00Z','period_return_candidate_stale')
print(json.dumps({'refused_cases':cases}))
` });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(JSON.parse(r.stdout.trim()).refused_cases, 8);
});
