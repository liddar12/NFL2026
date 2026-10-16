import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
const FIXTURE=String.raw`
import copy,importlib.util,io,json,os,pathlib,shutil,subprocess,sys,tempfile
from contextlib import redirect_stdout,redirect_stderr
from unittest.mock import patch
from scripts import run_parlay_feedback as I
spec=importlib.util.spec_from_file_location('fixture',pathlib.Path('tests/fixtures/week6_outcomes.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
def refused(fn):
 try:fn()
 except (ValueError,RuntimeError,OSError,KeyError,TypeError):return True
 return False
def setup(root):
 data=root/'data';snapshots=data/'snapshots';f.generation(snapshots);f.generation(snapshots,'2026-09-01T13:00:00Z')
 captured=f.capture.save_capture(f.bundle(),snapshots/'outcome_evidence')
 return data,snapshots,captured
def run(data,snapshots,captures,observed='2026-09-04T15:00:00Z',evaluated='2026-09-04T15:00:01Z'):
 engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.git(engine,'rev-parse','HEAD')
 return I.run(data_dir=data,snapshot_dir=snapshots,captures=captures,engine_checkout=engine,engine_commit=pin,
  observed_utc=observed,evaluation_clock=lambda:evaluated)
def artifacts(data):return data/'snapshots/learning_feedback'
def state(data):
 p=I.read_json(data/'learning_feedback.json');return I.read_json(I.artifact(artifacts(data),'states',p['state_id']))
def evidence(snapshots):
 return {str(p):p.read_bytes()for p in snapshots.rglob('*')if p.is_file()and 'learning_feedback'not in p.parts}
`;
function py(source){
 const result=spawnSync('python3',['-'],{cwd:ROOT,encoding:'utf8',input:FIXTURE+source,
   env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:60000,maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.stderr+result.stdout);
 return JSON.parse(result.stdout.trim().split('\n').pop());
}
function requireEngine(t){
 if(!ENGINE||!existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py')){
  t.skip('Explicit SELFLEARN_CHECKOUT with pinned repository-feedback runtime required; no shared-engine acceptance executed');return false;
 }
 return true;
}

test('parlay feedback defaults off without credentials, source reads, limits, engine imports or subprocesses',()=>{
 const r=py(String.raw`
out=io.StringIO()
with patch.object(I,'run',side_effect=AssertionError('run')),patch.object(I,'limits',side_effect=AssertionError('limits')),patch.object(I.subprocess,'run',side_effect=AssertionError('spawn')),patch.object(I.Path,'open',side_effect=AssertionError('file')),patch.dict(os.environ,{},clear=True),redirect_stdout(out):
 code=I.main([])
print(json.dumps({'code':code,'result':json.loads(out.getvalue())}))
`);
 assert.equal(r.code,0);assert.equal(r.result.status,'disabled_dry_run');assert.equal(r.result.writes,false);
 assert.equal(r.result.network_used,false);assert.equal(r.result.model_adoption,false);
});

test('explicit CLI failures are static and never expose supplied paths or private diagnostics',()=>{
 const r=py(String.raw`
rows=[]
for args in (['--execute'],['--execute','--engine-checkout','PRIVATE_PATH','--engine-commit','PRIVATE_PIN']):
 out=io.StringIO()
 with patch.object(I,'limits'),patch.object(I,'run',side_effect=OSError('PRIVATE_DETAIL')),redirect_stderr(out):code=I.main(args)
 rows.append({'code':code,'output':out.getvalue()})
print(json.dumps(rows))
`);
 for(const row of r){assert.equal(row.code,2);assert.ok(!row.output.includes('PRIVATE'));assert.equal(JSON.parse(row.output).status,'failed_no_success_ack');}
});

test('bounded file reads, symlink refusal, local writer lock and pointer CAS fail closed',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);file=root/'ordinary.json';file.write_text('null');link=root/'link.json';link.symlink_to(file)
 checks=[refused(lambda:I.read_json(link))]
 with patch.object(I,'MAX_BYTES',1):checks.append(refused(lambda:I.read_json(file)))
 fifo=root/'fifo';os.mkfifo(fifo);checks.append(refused(lambda:I.read_json(fifo)))
 with I.lock(root):checks.append(refused(lambda:I.lock(root)))
 checks.append(refused(lambda:I.publish_pointer(root,{'next':1},{'not_current':1})))
 with patch.object(I,'MAX_BYTES',len(I.export.encoded(None))):checks.append(refused(lambda:I.save(root,'limit',I.export.fingerprint(None),None)))
 print(json.dumps(checks))
`);
 assert.deepEqual(r,[true,true,true,true,true,true]);
});

test('engine requires exact immutable commit, not a floating ref or wrong checkout',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 print(json.dumps([refused(lambda:I.engine(tmp,pin))for pin in ('main','PRIVATE',True,'0'*40)]))
`);
 assert.deepEqual(r,[true,true,true,true]);
});

test('actual producer → raw capture → shared evaluation persists complete cohorts and retry-safe corrections',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));before=evidence(snapshots)
 first=run(data,snapshots,[],'2026-09-01T15:00:00Z','2026-09-01T15:00:01Z');forecast=state(data)
 graded=run(data,snapshots,[captured]);a=state(data);pointer_before=I.read_json(data/'learning_feedback.json')
 repeated=run(data,snapshots,[captured]);same=I.read_json(data/'learning_feedback.json')==pointer_before
 correction=f.capture.save_capture(f.bundle(value='0',observed='2026-09-05T12:00:00Z'),snapshots/'outcome_evidence')
 corrected=run(data,snapshots,[correction],'2026-09-06T15:00:00Z','2026-09-06T15:00:01Z');b=state(data)
 old_retry=run(data,snapshots,[captured],'2026-09-07T15:00:00Z','2026-09-07T15:00:01Z');after=state(data)
 print(json.dumps({'first':first,'graded':graded,'repeated':repeated,'same_pointer':same,'corrected':corrected,
  'first_imports_preserved':a['receipt_imports']==forecast['receipt_imports'],'first_sources_preserved':a['source_imports']==forecast['source_imports'],
  'a_outcomes':[r['resolution']['hit']for r in a['revisions']],'b_outcomes':[r['resolution']['hit']for r in b['revisions']],
  'history_prefix':b['revisions'][:4]==a['revisions'],'old_retry_kept_state':after==b,
  'sources_unchanged':all(pathlib.Path(p).read_bytes()==raw for p,raw in before.items()),
  'state_files':len(list((artifacts(data)/'states').glob('*.json')))}))
`);
 assert.equal(r.first.receipts,4);assert.equal(r.first.outcome_revisions,0);assert.equal(r.first.first_imported_before_kickoff,4);
 assert.equal(r.graded.outcome_revisions,4);assert.equal(r.graded.cohort_n,2);assert.equal(r.graded.candidate_gate.passed,false);
 assert.equal(r.same_pointer,true);assert.equal(r.repeated.state_changed,false);
 assert.deepEqual(r.a_outcomes,[true,true,true,true]);assert.deepEqual(r.b_outcomes,[true,true,true,true,false,false,false,false]);
 assert.equal(r.history_prefix,true);assert.equal(r.old_retry_kept_state,true);assert.equal(r.first_imports_preserved,true);assert.equal(r.first_sources_preserved,true);
 assert.equal(r.sources_unchanged,true);assert.equal(r.state_files,3);
 for(const key of ['model_adoption','public_serving_verified','working_live_loop','accuracy_improvement_verified','hosted_ack'])assert.equal(r.graded[key],false);
});

test('failed report persistence never advances success pointer; complete retry recovers',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[],'2026-09-01T15:00:00Z','2026-09-01T15:00:01Z')
 original=(data/'learning_feedback.json').read_bytes();save=I.save
 def interrupt(root,folder,oid,value):
  if folder=='evaluations':raise OSError('PRIVATE_DISK_FULL')
  return save(root,folder,oid,value)
 with patch.object(I,'save',side_effect=interrupt):failed=refused(lambda:run(data,snapshots,[captured]))
 kept=(data/'learning_feedback.json').read_bytes()==original
 recovered=run(data,snapshots,[captured])
 print(json.dumps({'failed':failed,'kept':kept,'cohort':recovered['cohort_n'],'revisions':recovered['outcome_revisions']}))
`);
 assert.deepEqual(r,{failed:true,kept:true,cohort:2,revisions:4});
});

test('missing frozen history, tampered raw bytes and broken parent refuse without replacing latest',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[],'2026-09-01T15:00:00Z','2026-09-01T15:00:01Z')
 old=(data/'learning_feedback.json').read_bytes();journal=next((snapshots/'learning_journal').rglob('*.json'));park=journal.with_suffix('.park');journal.rename(park)
 missing=refused(lambda:run(data,snapshots,[captured]));park.rename(journal)
 bundle=f.capture.load_capture(captured);rid=next(iter(bundle['raw_objects']));rawpath=captured.parent.parent/'objects'/(rid[7:]+'.bin');original=rawpath.read_bytes();rawpath.write_bytes(b'tampered')
 raw=refused(lambda:run(data,snapshots,[captured]));rawpath.write_bytes(original)
 kept=(data/'learning_feedback.json').read_bytes()==old
 run(data,snapshots,[captured]);current=state(data);parent=I.artifact(artifacts(data),'states',current['previous_state_id']);parent.rename(parent.with_suffix('.park'))
 latest=(data/'learning_feedback.json').read_bytes();broken=refused(lambda:run(data,snapshots,[captured]))
 print(json.dumps([missing,raw,kept,broken,latest==(data/'learning_feedback.json').read_bytes()]))
`);
 assert.deepEqual(r,[true,true,true,true,true]);
});

test('changed shared source identity and backward evaluation clock refuse before persistence',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));loader=I.engine
 def changed(*args):
  core,identity,code=loader(*args);return core,lambda:'sha256:'+'0'*64,code
 with patch.object(I,'engine',side_effect=changed):code_changed=refused(lambda:run(data,snapshots,[captured]))
 clock=refused(lambda:run(data,snapshots,[captured],evaluated='2026-09-01T00:00:00Z'))
 print(json.dumps([code_changed,clock,not(data/'learning_feedback.json').exists()]))
`);
 assert.deepEqual(r,[true,true,true]);
});

test('isolated stdlib-only explicit CLI exercises real resource limits and late-import reporting',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.git(engine,'rev-parse','HEAD')
 result=subprocess.run([sys.executable,'-I','-S','-B','scripts/run_parlay_feedback.py','--execute','--data-dir',str(data),'--capture',str(captured),
  '--engine-checkout',str(engine),'--engine-commit',pin],capture_output=True,text=True,timeout=30)
 print(json.dumps({'code':result.returncode,'result':json.loads(result.stdout)if result.returncode==0 else None,'error':result.stderr}))
`);
 assert.equal(r.code,0,r.error);assert.equal(r.result.cohort_n,2);assert.equal(r.result.late_imported_receipts,4);
 assert.equal(r.result.first_imported_before_kickoff,0);assert.equal(r.result.model_adoption,false);
});

test('explicit fetch adapter selects all frozen periods and saves original raw evidence, without a second client',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));calls=[];original=f.bundle()
 def fake(season,weeks,*,fetcher):
  calls.append([season,weeks,fetcher is I.capture.http_fetcher]);return original
 with patch.object(I.capture,'capture',side_effect=fake):paths=I.fetch_captures(snapshots,data)
 verified=I.capture.load_capture(paths[0]);empty=pathlib.Path(tmp)/'empty';empty.mkdir()
 with patch.object(I.export,'plan',return_value={'source_objects':[],'generations':[]}):no_empty=refused(lambda:I.fetch_captures(empty,empty/'data'))
 with patch.object(I,'MAX_BYTES',1),patch.object(I.capture,'capture',side_effect=AssertionError('must not fetch oversize graph')):
  no_oversize=refused(lambda:I.fetch_captures(snapshots,data))
 bad=copy.deepcopy(original);bad['manifest']['weeks']=[7]
 with patch.object(I.capture,'capture',return_value=bad):wrong_period=refused(lambda:I.fetch_captures(snapshots,data))
 print(json.dumps({'calls':calls,'same':verified['manifest']==f.bundle()['manifest'],'count':len(paths),'no_empty':no_empty,
  'no_oversize':no_oversize,'wrong_period':wrong_period}))
`);
 assert.deepEqual(r,{calls:[[2026,[6],true]],same:true,count:1,no_empty:true,no_oversize:true,wrong_period:true});
});

test('data validator verifies durable pointer links without loading engine or refitting',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));absent=I.validate_records(data);run(data,snapshots,[captured])
 with patch.object(I,'engine',side_effect=AssertionError('must_not_load_engine')):valid=I.validate_records(data)
 current=state(data);path=I.artifact(artifacts(data),'states',current['state_id']);changed=copy.deepcopy(current);changed['sequence']+=1;path.write_text(json.dumps(changed))
 bad=refused(lambda:I.validate_records(data))
 print(json.dumps([absent,valid,bad]))
`);
 assert.deepEqual(r,[false,true,true]);
});

test('Actions pilot is opt-in, pins shared source, bounds runtime and uses existing stage record before publication',()=>{
 const source=readFileSync(ROOT+'.github/workflows/daily.yml','utf8');
 const start=source.indexOf('- name: Checkout pinned SelfLearning pilot engine');
 const end=source.indexOf('# R71 — post-game review',start);
 const pilot=source.slice(source.indexOf('- name: Shared parlay feedback pilot',start),end);
 const checkout=source.slice(start,source.indexOf('- name: Install pipeline dependencies',start));
 assert.ok(start>=0&&end>start);
 assert.match(pilot,/if: vars\.SELFLEARN_NFL_PILOT_ENABLED == '1'/);
 assert.match(checkout,/ref: \$\{\{ vars\.SELFLEARN_NFL_ENGINE_COMMIT \}\}/);
 assert.match(checkout,/persist-credentials: false/);
 assert.match(pilot,/timeout-minutes: 15/);
 assert.match(pilot,/stage\.sh --continue-on-error daily "Shared parlay feedback pilot"/);
 assert.match(pilot,/python3 -I -S -B scripts\/run_parlay_feedback\.py --execute --fetch-outcomes/);
 assert.match(pilot,/if: vars\.SELFLEARN_NFL_PILOT_ENABLED != '1'/);
 assert.ok(end<source.indexOf('- name: Commit data/'));
 assert.ok(!pilot.includes('SELFLEARN_OPERATOR_TOKEN')&&!pilot.includes('supabase'));
 assert.match(source,/run: python3 -I -S -B scripts\/run_parlay_feedback\.py --check-records/);
});

test('committed optional feedback files pass read-only integrity without installing or loading engine',()=>{
 const r=py(String.raw`
out=io.StringIO()
with patch.object(I,'engine',side_effect=AssertionError('engine import')),patch.object(I,'limits',side_effect=AssertionError('limits')),redirect_stdout(out):code=I.main(['--check-records'])
print(json.dumps({'code':code,'result':json.loads(out.getvalue())}))
`);
 assert.equal(r.code,0);assert.ok(['local_records_valid','no_feedback_record'].includes(r.result.status));
 assert.equal(r.result.writes,false);assert.equal(r.result.model_adoption,false);
});

test('publication checker requires original frozen source and generation files, not just valid state hashes',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[captured]);checks=[]
 for folder in ('learning_sources','learning_journal'):
  path=next((snapshots/folder).rglob('*.json'));park=path.with_suffix('.park');path.rename(park)
  checks.append(refused(lambda:I.validate_records(data)));park.rename(path)
 checks.append(I.validate_records(data));out=io.StringIO()
 with redirect_stderr(out):code=I.main(['--check-records','--execute','--data-dir',str(data)])
 print(json.dumps({'checks':checks,'mixed_mode':code,'static':json.loads(out.getvalue())['error']}))
`);
 assert.deepEqual(r,{checks:[true,true,true],mixed_mode:2,static:'parlay_feedback_refused'});
});

test('real local Git publisher refuses broken feedback and pushes a complete repaired tree only',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);origin=root/'origin.git';work=root/'work'
 os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
 I.git(root,'init','--bare',str(origin));I.git(root,'clone',str(origin),str(work))
 I.git(work,'config','user.email','synthetic@example.invalid');I.git(work,'config','user.name','Synthetic Fixture');I.git(work,'config','gc.auto','0')
 (work/'README').write_text('synthetic local publisher fixture\n');I.git(work,'add','README');I.git(work,'-c','commit.gpgsign=false','commit','-m','fixture initial');I.git(work,'branch','-M','main');I.git(work,'push','origin','main')
 before=I.git(origin,'rev-parse','refs/heads/main');data,snapshots,captured=setup(work);run(data,snapshots,[captured])
 saved_pointer=(data/'learning_feedback.json').read_bytes()
 source=next((snapshots/'learning_sources').glob('*.json'));park=source.with_suffix('.park');source.rename(park)
 env={**os.environ,'PUBLISH_VALIDATE_CMD':'true','PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0','GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_NOSYSTEM':'1'}
 # Simulate another local writer hiding the working-tree pointer AFTER the
 # data commit. Only the committed tree can decide whether a guard is needed.
 fake=root/'fake-bin';fake.mkdir();wrapper=fake/'git';real=shutil.which('git')
 wrapper.write_text('#!'+sys.executable+'\nimport os,sys,subprocess,pathlib\nreal='+repr(real)+'\n'
  'if len(sys.argv)>1 and sys.argv[1]=="fetch":\n code=subprocess.run([real,*sys.argv[1:]]).returncode\n'
  ' path=pathlib.Path.cwd()/"data/learning_feedback.json"\n if code==0 and path.is_file():path.unlink()\n sys.exit(code)\n'
  'os.execv(real,[real,*sys.argv[1:]])\n');wrapper.chmod(0o700)
 command=['bash',str(I.ROOT/'scripts/publish_data.sh'),'data: synthetic feedback fixture']
 bad=subprocess.run(command,cwd=work,env={**env,'PATH':str(fake)+os.pathsep+env['PATH']},text=True,capture_output=True,timeout=30)
 stopped=I.git(origin,'rev-parse','refs/heads/main')==before
 hidden=not(data/'learning_feedback.json').exists();(data/'learning_feedback.json').write_bytes(saved_pointer)
 park.rename(source)
 good=subprocess.run(command,cwd=work,env=env,text=True,capture_output=True,timeout=30)
 print(json.dumps({'bad':bad.returncode,'stopped':stopped,'pointer_hidden_after_commit':hidden,'good':good.returncode,
  'updated':I.git(origin,'rev-parse','refs/heads/main')==I.git(work,'rev-parse','HEAD'),'valid':I.validate_records(data),
  'message':bad.stderr if bad.returncode==0 or good.returncode else ''}))
`);
 assert.equal(r.bad,1);assert.equal(r.stopped,true);assert.equal(r.pointer_hidden_after_commit,true);
 assert.equal(r.good,0,r.message);assert.equal(r.updated,true);assert.equal(r.valid,true);
});

test('actual checkout-shaped fetch uses the narrow repository sink while standalone sports-data protection remains',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);data,snapshots,captured=setup(root);bundle=f.bundle();engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.git(engine,'rev-parse','HEAD')
 with patch.object(I.capture,'_ROOT',root.resolve()):
  standalone=refused(lambda:I.capture.save_capture(bundle,data/'snapshots/learning_outcomes'))
  out=io.StringIO()
  with patch.object(I,'limits'),patch.object(I.capture,'capture',return_value=bundle),redirect_stdout(out):
   code=I.main(['--execute','--fetch-outcomes','--data-dir',str(data),'--engine-checkout',str(engine),'--engine-commit',pin])
  result=json.loads(out.getvalue());valid=I.validate_records(data)
 print(json.dumps({'standalone_held':standalone,'code':code,'result':result,'valid':valid}))
`);
 assert.equal(r.standalone_held,true);assert.equal(r.code,0);assert.equal(r.valid,true);
 assert.equal(r.result.cohort_n,2);assert.equal(r.result.network_used,true);assert.equal(r.result.model_adoption,false);
});

test('raw outcomes remain reproducible in the repository after original external capture disappears',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));bundle=f.capture.load_capture(captured);run(data,snapshots,[captured]);canonical=data/'snapshots/learning_outcomes/captures'/(bundle['manifest']['capture_id'][7:]+'.json')
 original=captured.parent.parent;park=original.with_name('parked-external-capture');original.rename(park)
 mirrored=I.capture.load_capture(canonical);valid=I.validate_records(data)
 raw=next((canonical.parent.parent/'objects').glob('*.bin'));raw.rename(raw.with_suffix('.park'))
 missing=refused(lambda:I.validate_records(data));before=(data/'learning_feedback.json').read_bytes()
 refused_run=refused(lambda:run(data,snapshots,[]))
 print(json.dumps({'same':mirrored==bundle,'valid':valid,'missing':missing,'refused_run':refused_run,'kept':before==(data/'learning_feedback.json').read_bytes()}))
`);
 assert.deepEqual(r,{same:true,valid:true,missing:true,refused_run:true,kept:true});
});
