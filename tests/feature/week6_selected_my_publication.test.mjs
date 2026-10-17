import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
function py(input, timeout = 60000) {
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', input,
    timeout, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('actual selected incumbent producer passes exact final-tree publication without an engine or model approval', () => {
  const result = py(String.raw`
import contextlib,copy,datetime as dt,io,json,os,pathlib,shutil,subprocess,tempfile
from scripts import run_my_generation as R,run_parlay_feedback as F,learning_receipts as L,my_freshness as M
from scripts import generation_capture_runtime as C,selected_my_publication_gate as G
from tests.fixtures import period_eligibility as fixture
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def refuse(fn):
 try:fn()
 except Exception as error:return str(error)
 raise AssertionError('invalid selected baseline publication accepted')
with tempfile.TemporaryDirectory()as tmp:
 area=pathlib.Path(tmp);root=area/'checkout';root.mkdir();data=root/'data';data.mkdir();origin=area/'local-origin'
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,p)
 start=L.instant(F.now());shift=start-L.instant(fixture.CAPTURE)
 def moved(value):
  if isinstance(value,dict):return {k:moved(v)for k,v in value.items()}
  if isinstance(value,list):return [moved(v)for v in value]
  when=L.instant(value)if isinstance(value,str)and 'T'in value else None
  return (when+shift).isoformat().replace('+00:00','Z')if when is not None else value
 docs=moved(fixture.make(qb=True,window=True)['docs'])
 # Every scheduled game starts95min from the initial source clock. The real
 # refresh is provisional now and must fail exactly at the5min recheck later.
 future={g['game_id']for g in docs['schedule']['games']if g['status']=='STATUS_SCHEDULED'}
 for name in('schedule','game_predictions'):
  for game in docs[name]['games']:
   if game['game_id']in future:
    game['kickoff_utc']=(start+dt.timedelta(minutes=95)).isoformat().replace('+00:00','Z')
 for name,relative in C._input_paths(2026,6).items():
  if docs[name]is None:continue
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True)
  p.write_text(json.dumps(docs[name],ensure_ascii=True,indent=2)+'\n')
 F.git(root,'init','-b','main');F.git(root,'config','user.name','Synthetic Test');F.git(root,'config','user.email','synthetic@example.invalid')
 F.git(root,'config','gc.auto','0');F.git(root,'config','maintenance.auto','false')
 def commit(message):
  F.git(root,'add','.');F.git(root,'-c','commit.gpgsign=false','commit','-m',message);return F.git(root,'rev-parse','HEAD')
 base=commit('synthetic baseline sources and no model authority')
 subprocess.run(['git','init','--bare',str(origin)],check=True,capture_output=True,timeout=10)
 F.git(root,'remote','add','origin',str(origin));F.git(root,'push','origin','HEAD:main')
 private=area/'private';missing_engine=area/'ENGINE_MUST_NOT_BE_INSTALLED'
 with contextlib.redirect_stdout(io.StringIO()):
  generated=R.run(data_dir=data,engine_checkout=missing_engine,engine_commit='b'*40,
   authority_id=L.fingerprint('synthetic baseline authority'),actor_ref='synthetic-operator',
   capture_dir=private,generation_sha=base,freshness_profile=M.PROFILE)
 assert generated['route']=='incumbent_no_owner_intent'and generated['engine_used']is False
 binding=C.read_artifact(private/generated['binding_artifact_name'],checkout=root)
 assert all(value is False for value in binding['claims'].values())
 assert not(data/'learning_control').exists()and not missing_engine.exists()
 head=commit('actual selected incumbent pool, offers, journal and archive')
 def check(h=None,value=binding,*,clock=F.now):return G.check_selected(value,checkout=root,
  expected_head=F.git(root,'rev-parse','HEAD')if h is None else h,base_head=base,clock=clock)
 proof=check();assert proof['consumer_check_pass']and proof['new_generation']and proof['engine_used']is False
 # Committed evidence, not repaired/mutable worktree data, supplies the gate.
 injury=data/'injuries.json';raw=injury.read_bytes();injury.write_bytes(b'broken uncommitted witness')
 assert check()['consumer_check_pass'];injury.write_bytes(raw)
 rejected=[]
 def changed(path,body,reason):
  old=path.read_bytes();path.write_bytes(body(old));bad=commit('synthetic invalid final tree');path.write_bytes(old)
  error=refuse(lambda:check(h=bad));assert reason in error,(reason,error)
  commit('restore synthetic final tree');rejected.append(error)
 changed(injury,lambda raw:raw+b' ', 'selected_MY_committed_input_changed')
 browser=next((root/'app').rglob('*.js'))
 changed(browser,lambda raw:raw+b'\n// unapproved runtime', 'selected_MY_committed_runtime_changed')
 archive=data/'my_cards/2026_wk06.json'
 changed(archive,lambda raw:raw+b' ', 'selected_MY_committed_output_changed')
 target=binding['binding']['target_generation_id']
 journal=data/'snapshots/learning_journal/2026_wk06'/(target[7:]+'.json')
 old=journal.read_bytes();journal.unlink();bad=commit('missing actual journal');journal.write_bytes(old)
 assert 'selected_MY_committed_journal_or_source_missing'in refuse(lambda:check(h=bad));rejected.append('missing_journal')
 commit('restore actual journal')
 control=data/'learning_control/unknown.json';control.parent.mkdir();control.write_text('{}');bad=commit('forbidden model-control scope')
 assert 'selected_MY_baseline_control_records_present'in refuse(lambda:check(h=bad));rejected.append('forbidden_control')
 control.unlink();control.parent.rmdir();commit('restore no-control baseline')
 # Preserve old v1 claims; no caller-resealed true authority flag may be used.
 forged=copy.deepcopy(binding);forged['claims']['publication_authorized']=True
 forged=C._sealed({k:v for k,v in forged.items()if k!='runtime_binding_id'},'runtime_binding_id')
 assert 'changed_capture_authority_claim'in refuse(lambda:check(value=forged));rejected.append('forged_authority_claim')
 pool=json.loads((data/'leg_pool.json').read_bytes());due=min(g['check_due_utc']for g in pool['freshness_policy']['games']if g['state']=='provisional')
 at_due=lambda:due
 assert 'selected_MY_serving_freshness_held'in refuse(lambda:check(clock=at_due));rejected.append('exact90min_boundary')
 final=F.git(root,'rev-parse','HEAD')
 # Actual publisher creates one more commit and replays the exact final SHA.
 (data/'pipeline_stages.json').write_text('{"synthetic_selected_baseline":true}')
 args=['bash',str(F.ROOT/'scripts/publish_data.sh'),'--selected-MY-binding',str(private/generated['binding_artifact_name']),
  'synthetic selected incumbent publication']
 run=subprocess.run(args,cwd=root,capture_output=True,text=True,timeout=60,
  env={**os.environ,'PUBLISH_VALIDATE_CMD':'true','PUBLISH_BACKOFF_S':'0','PUBLISH_ATTEMPTS':'1'})
 assert run.returncode==0,run.stdout+run.stderr
 published=F.git(origin,'rev-parse','refs/heads/main');assert published==F.git(root,'rev-parse','HEAD')and published!=final
 rows=[json.loads(line)for line in run.stdout.splitlines()if line.startswith('{')]
 selected=[r for r in rows if r.get('kind')=='nfl.selected_incumbent_MY_publication.v1'][-1]
 assert selected['head']==published and selected['base_head']==base and selected['consumer_check_pass']
 assert selected['supported_MY_yardage_consumer_semantics_verified']
 assert all(selected[k]is False for k in G.FLAGS),selected
 assert not missing_engine.exists()and not(data/'learning_control').exists()
 print(json.dumps({'publisher_exit':run.returncode,'exact_final_sha_verified':True,
  'engine_used':selected['engine_used'],'model_approval_recorded':selected['model_approval_recorded'],
  'negative_cases':len(rejected),'v1_claims_unchanged':True,'local_fixture_only':True}))
`, 120000);
  assert.deepEqual(result, { publisher_exit: 0, exact_final_sha_verified: true, engine_used: false,
    model_approval_recorded: false, negative_cases: 7, v1_claims_unchanged: true, local_fixture_only: true });
});

test('default selected-state guard permits unchanged settlement and forbids stripping or temporary source changes', () => {
  const r = py(String.raw`
import json,os,pathlib,subprocess,tempfile
from scripts import selected_my_publication_gate as G
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def git(root,*args):return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True,timeout=10).stdout.strip()
def write(root,path,value):
 p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value));return p
def commit(root):
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-m','synthetic selected-state fixture');return git(root,'rev-parse','HEAD')
def refused(fn):
 try:fn()
 except Exception as error:return str(error)
 raise AssertionError('changed selected consumer accepted')
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);git(root,'init','-b','main');git(root,'config','user.name','Synthetic');git(root,'config','user.email','synthetic@example.invalid')
 p=write(root,'data/leg_pool.json',{'synthetic':True});legacy=commit(root)
 write(root,'data/review.json',{});head=commit(root)
 answer=G.unchanged_or_not_applicable(checkout=root,expected_head=head,base_head=legacy)
 assert answer['not_applicable']and answer['consumer_check_pass']is False
 write(root,'data/leg_pool.json',{'freshness_policy':{'synthetic':True}});base=commit(root)
 write(root,'data/review.json',{'new':True});head=commit(root)
 answer=G.unchanged_or_not_applicable(checkout=root,expected_head=head,base_head=base)
 assert answer['consumer_check_pass']and answer['consumer_unchanged_proven']
 write(root,'data/leg_pool.json',{'policy_stripped':True});head=commit(root)
 stripped=refused(lambda:G.unchanged_or_not_applicable(checkout=root,expected_head=head,base_head=base))
 write(root,'data/leg_pool.json',{'freshness_policy':{'synthetic':True}});head=commit(root)
 temporary=refused(lambda:G.unchanged_or_not_applicable(checkout=root,expected_head=head,base_head=base))
 print(json.dumps({'stripped':stripped,'temporary':temporary,'publication_authorized':answer['publication_authorized']}))
`);
  assert.deepEqual(r, { stripped: 'selected_MY_original_binding_required',
    temporary: 'period_publication_unpublished_consumer_change', publication_authorized: false });
});

test('writer mode is a fixed trusted keyword and publication modes cannot be mixed', () => {
  const r = py(String.raw`
import json
from scripts.period_my_generation import replay_binding
try:replay_binding(None,pool_writer='uploaded-writer')
except ValueError as error:print(json.dumps(str(error)))
`);
  assert.equal(r, 'period_MY_unknown_pool_writer');
  for (const other of ['--generation-binding', '--no-new-generation']) {
    const args = ['scripts/publish_data.sh', '--selected-MY-binding', '/private/tmp/not-an-actual-binding', other];
    if (other === '--generation-binding') args.push('/private/tmp/other-binding');
    args.push('synthetic');
    const run = spawnSync('bash', args, { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 2, run.stdout + run.stderr);
  }
});
