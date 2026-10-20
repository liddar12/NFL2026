import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
const FIXTURE=String.raw`
import copy,importlib.util,io,json,os,pathlib,shutil,subprocess,sys,tempfile
from contextlib import redirect_stdout,redirect_stderr
from unittest.mock import patch
from scripts import run_parlay_feedback as I
from scripts import learning_history_guard as G
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
 engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.ENGINE_COMMIT
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

test('isolated stdlib import and dry run never load shared engine or write workspace files',()=>{
 const result=spawnSync('python3',['-I','-S','-B','scripts/run_parlay_feedback.py'],{
  cwd:ROOT,encoding:'utf8',env:{...process.env,SELFLEARN_CHECKOUT:'/missing/engine'},timeout:10000});
 assert.equal(result.status,0,result.stderr);
 const row=JSON.parse(result.stdout);
 assert.equal(row.status,'disabled_dry_run');assert.equal(row.learning_enabled,false);
 assert.equal(row.production_authorized,false);assert.equal(row.writes,false);
 assert.equal(row.settlement_support,'unresolved_push_and_official_void');
});

test('settlement inputs are explicitly refused before engine, limits, state or grading',()=>{
 const r=py(String.raw`
rows=[]
with tempfile.TemporaryDirectory()as tmp:
 data=pathlib.Path(tmp)/'private';out=io.StringIO()
 with patch.object(I,'engine',side_effect=AssertionError('engine')),patch.object(I,'limits',side_effect=AssertionError('limits')),redirect_stderr(out):
  code=I.main(['--execute','--data-dir',str(data),'--settlement','PRIVATE_SOURCE'])
 for reason in('push','official_void'):
  with patch.object(I,'engine',side_effect=AssertionError('engine')):
   try:I.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[],engine_checkout=tmp,
    engine_commit=I.ENGINE_COMMIT,observed_utc=f.T0,settlements=[{'reason':reason}])
   except I.FeedbackError as error:rows.append(str(error))
 print(json.dumps({'code':code,'output':out.getvalue(),'reasons':rows,'absent':not data.exists()}))
`);
 assert.equal(r.code,2);assert.equal(r.absent,true);assert.ok(!r.output.includes('PRIVATE'));
 assert.deepEqual(r.reasons,['feedback_settlement_unsupported','feedback_settlement_unsupported']);
 const error=JSON.parse(r.output);assert.equal(error.error,'feedback_settlement_unsupported');
 assert.equal(error.outcome_basis,'threshold_observations_not_sportsbook_settlement');
});

test('execution requires an explicit workspace outside the production data tree',()=>{
 const r=py(String.raw`
checks=[]
for data in(I.ROOT,I.ROOT/'data',I.ROOT/'data/subdir',I.ROOT/'scripts',I.ROOT/'app',I.ROOT.parent,pathlib.Path('/')):
 checks.append(refused(lambda:I.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[],
  engine_checkout='/missing/engine',engine_commit=I.ENGINE_COMMIT,observed_utc=f.T0)))
for args in(['--execute'],['--execute','--data-dir',str(I.ROOT/'data'),'--engine-checkout','/missing/engine']):
 out=io.StringIO()
 with patch.object(I,'limits',side_effect=AssertionError('limits')),redirect_stderr(out):code=I.main(args)
 checks.append(code==2)
print(json.dumps(checks))
`);
 assert.deepEqual(r,[true,true,true,true,true,true,true,true,true]);
});

test('cached foreign engine packages and submodules are refused before loading code',()=>{
 const r=py(String.raw`
import types
checks=[]
with tempfile.TemporaryDirectory()as tmp:
 package=pathlib.Path(tmp)/'packages/selflearn-core'
 for name in('selflearn_core','selflearn_core.adapters.nfl_file_feedback','selflearn_core.learning_jobs'):
  module=types.SimpleNamespace(__file__='/foreign/engine.py',__spec__=types.SimpleNamespace(origin='/foreign/engine.py'))
  with patch.dict(sys.modules,{name:module}):checks.append(refused(lambda:I.import_identity(package)))
print(json.dumps(checks))
`);
 assert.deepEqual(r,[true,true,true]);
});

test('CLI resource policy refuses unsupported or ineffective memory bounds and preserves stricter ceilings',()=>{
 const r=py(String.raw`
import types
checks=[]
with patch.object(I.sys,'platform','darwin'):checks.append(refused(I.limits))
fake=types.SimpleNamespace(RLIM_INFINITY=-1,RLIMIT_CPU=0,RLIMIT_CORE=4,RLIMIT_FSIZE=1,RLIMIT_AS=9)
fake.getrlimit=lambda key:(-1,-1);fake.setrlimit=lambda key,value:None
with patch.dict(sys.modules,resource=fake),patch.object(I.sys,'platform','linux'):checks.append(refused(I.limits))
values={0:(-1,120),4:(-1,-1),1:(-1,-1),9:(-1,I.CLI_MEMORY_BYTES//2)}
fake.getrlimit=lambda key:values[key]
def setlimit(key,value):values[key]=value
fake.setrlimit=setlimit
with patch.dict(sys.modules,resource=fake),patch.object(I.sys,'platform','linux'):result=I.limits()
print(json.dumps({'refused':checks,'cpu':values[0],'memory':values[9],'result':result}))
`);
 assert.deepEqual(r.refused,[true,true]);assert.deepEqual(r.cpu,[120,120]);
 assert.deepEqual(r.memory,[1024**3,1024**3]);assert.equal(r.result.controller_limits_applied,true);
});

test('complete state ancestry retains every revision, record and original import clock',()=>{
 const r=py(String.raw`
histories=('source_object_ids','source_imports','receipts','receipt_imports','generation_records','observation_records','revisions','capture_records')
def seal(value):
 value={k:v for k,v in value.items()if k!='state_id'};return {**value,'state_id':I.export.fingerprint(value)}
with tempfile.TemporaryDirectory()as tmp:
 artifacts=pathlib.Path(tmp);states=[]
 for index in range(3):
  row={'sequence':index+1,'previous_state_id':states[-1]['state_id']if states else None,'updated_utc':'2026-09-04T15:00:00Z'}
  row.update({key:[{'id':number,'first_imported_utc':f.T0}for number in range(index+1)]for key in histories})
  row=seal(row);states.append(row);I.save(artifacts,'states',row['state_id'],row)
 complete=len(I.validate_state_history(artifacts,states[-1]))==3
 grandparent=I.artifact(artifacts,'states',states[0]['state_id']);raw=grandparent.read_bytes();grandparent.unlink()
 missing=refused(lambda:I.validate_state_history(artifacts,states[-1]));grandparent.write_bytes(raw+b'broken')
 tampered=refused(lambda:I.validate_state_history(artifacts,states[-1]));grandparent.write_bytes(raw)
 removed=[]
 for key in histories:
  row=copy.deepcopy(states[-1]);row[key]=row[key][1:];removed.append(refused(lambda:I.validate_state_history(artifacts,seal(row))))
 row=copy.deepcopy(states[-1]);row['receipt_imports'][0]['first_imported_utc']='2026-09-01T11:00:00Z'
 clock=refused(lambda:I.validate_state_history(artifacts,seal(row)))
 with patch.object(I,'MAX_STATE_HISTORY',2):bounded=refused(lambda:I.validate_state_history(artifacts,states[-1]))
 print(json.dumps({'complete':complete,'missing':missing,'tampered':tampered,'removed':removed,'clock':clock,'bounded':bounded}))
`);
 assert.equal(r.complete,true);assert.equal(r.missing,true);assert.equal(r.tampered,true);
 assert.ok(r.removed.every(Boolean));assert.equal(r.clock,true);assert.equal(r.bounded,true);
});

test('append-only guard reads committed Git bytes and rejects deleted, rewritten or mode-changed evidence',()=>{
 const r=py(String.raw`
def git(root,*args):return subprocess.run(['git','-C',str(root),*args],check=True,text=True,capture_output=True,timeout=10).stdout.strip()
def commit(root):
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-m','synthetic local fixture');return git(root,'rev-parse','HEAD')
def write(root,name,raw=b'{"synthetic":true}\n'):
 path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);return path
checks=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);git(root,'init','-b','main');git(root,'config','user.name','Synthetic Fixture');git(root,'config','user.email','fixture@example.invalid');git(root,'config','core.filemode','true')
 paths=['data/snapshots/'+family+'/a.json'for family in('learning_journal','learning_sources','learning_outcomes','learning_feedback')]
 for path in paths:write(root,path)
 write(root,'data/learning_feedback.json');base=commit(root)
 for path in paths:write(root,path.replace('a.json','b.json'))
 write(root,'data/learning_feedback.json',b'{}');head=commit(root)
 before=(root/'.git/index').read_bytes();result=G.check_history(root,head,base)
 unchanged=(root/'.git/index').read_bytes()==before
 for name in paths:
  original=(root/name).read_bytes()
  for mutation in('replace','whitespace','mode','delete'):
   path=root/name
   if mutation=='delete':path.unlink()
   elif mutation=='mode':path.chmod(0o755)
   else:path.write_bytes(b'{}'if mutation=='replace'else b'{ "synthetic": true }\n')
   changed=commit(root);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(original);path.chmod(0o644)
   checks.append(refused(lambda:G.check_history(root,changed,base)))
  commit(root)
 print(json.dumps({'result':result,'unchanged':unchanged,'refused':checks,
  'bad_head':refused(lambda:G.check_history(root,'main',base)),'bounded':refused(lambda:G._git(root,['rev-parse','HEAD'],limit=1)),
  'deadline':refused(lambda:G._git(root,['rev-parse','HEAD'],seconds=-1))}))
`);
 assert.equal(r.result.retained_immutable_files,4);assert.equal(r.result.new_immutable_files,4);
 assert.equal(r.result.source_writes,false);assert.equal(r.unchanged,true);
 assert.equal(r.refused.length,16);assert.ok(r.refused.every(Boolean));
 assert.equal(r.bad_head,true);assert.equal(r.bounded,true);assert.equal(r.deadline,true);
});

test('history metadata bounds reject malformed framing, symlinks, duplicate paths and excess bytes',()=>{
 const r=py(String.raw`
raw=b'100644 blob '+b'1'*40+b' 4\tdata/snapshots/learning_sources/a.json\0'
cases=[raw[:-1],raw+raw,raw.replace(b'100644',b'120000'),raw.replace(b' 4\t',b' -1\t'),raw.replace(b'sources/a',b'sources/../a')]
checks=[refused(lambda value=value:G._tree(value))for value in cases]
for key in('MAX_FILES','MAX_FILE','MAX_TOTAL'):
 with patch.object(G,key,0):checks.append(refused(lambda:G._tree(raw)))
print(json.dumps({'checks':checks,'runtime_imported':'scripts.generation_capture_runtime'in sys.modules}))
`);
 assert.ok(r.checks.every(Boolean));assert.equal(r.runtime_imported,false);
});

test('parlay feedback defaults off without credentials, source reads, limits, engine imports or subprocesses',()=>{
 const r=py(String.raw`
out=io.StringIO()
with patch.object(I,'run',side_effect=AssertionError('run')),patch.object(I,'limits',side_effect=AssertionError('limits')),patch.object(I,'git',side_effect=AssertionError('spawn')),patch.object(I.Path,'open',side_effect=AssertionError('file')),patch.dict(os.environ,{},clear=True),redirect_stdout(out):
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

test('late imports remain visible and explicit settlement refusal preserves the exact existing state',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));result=run(data,snapshots,[captured]);before=(data/'learning_feedback.json').read_bytes();saved=state(data)
 rows=[]
 for reason in('push','official_void'):
  rows.append(refused(lambda:I.run(data_dir=data,snapshot_dir=snapshots,captures=[captured],
   engine_checkout=os.environ['SELFLEARN_CHECKOUT'],engine_commit=I.ENGINE_COMMIT,observed_utc='2026-09-05T15:00:00Z',
   settlements=[{'reason':reason,'source':'synthetic fixture'}])))
 print(json.dumps({'late':result['late_imported_receipts'],'prospective':result['first_imported_before_kickoff'],
  'cohort':result['cohort_n'],'refused':rows,'pointer_kept':before==(data/'learning_feedback.json').read_bytes(),
  'state_kept':saved==state(data),'basis':result['outcome_basis'],'support':result['settlement_support']}))
`);
 assert.equal(r.late,4);assert.equal(r.prospective,0);assert.equal(r.cohort,2);
 assert.deepEqual(r.refused,[true,true]);assert.equal(r.pointer_kept,true);assert.equal(r.state_kept,true);
 assert.equal(r.basis,'threshold_observations_not_sportsbook_settlement');assert.equal(r.support,'unresolved_push_and_official_void');
});

test('missing or rewound completion pointers cannot silently reset imported history',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[],'2026-09-01T15:00:00Z','2026-09-01T15:00:01Z');pointer=data/'learning_feedback.json';first=pointer.read_bytes()
 run(data,snapshots,[captured]);latest=pointer.read_bytes();pointer.write_bytes(first)
 rewound=refused(lambda:run(data,snapshots,[captured]));rewound_kept=pointer.read_bytes()==first
 pointer.unlink();missing=refused(lambda:run(data,snapshots,[captured]));missing_kept=not pointer.exists()
 pointer.write_bytes(latest);restored=I.validate_records(data)
 print(json.dumps([rewound,rewound_kept,missing,missing_kept,restored]))
`);
 assert.deepEqual(r,[true,true,true,true,true]);
});

test('exact engine import refuses dirty runtime and ignored executable source without changing checkout',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
engine=os.environ['SELFLEARN_CHECKOUT'];call=I.git;checks=[]
for dirty in('tracked','ignored'):
 def altered(root,*args):
  if args[0]=='status'and dirty=='tracked':return ' M packages/selflearn-core/selflearn_core/types.py'
  if args[0]=='ls-files'and dirty=='ignored':return 'packages/selflearn-core/selflearn_core/ignored.py'
  return call(root,*args)
 with patch.object(I,'git',side_effect=altered):checks.append(refused(lambda:I.engine(engine,I.ENGINE_COMMIT)))
core,identity,code=I.engine(engine,I.ENGINE_COMMIT)
print(json.dumps({'refused':checks,'valid':code==identity(),'profile':core.PARTITION_PROFILE}))
`);
 assert.deepEqual(r.refused,[true,true]);assert.equal(r.valid,true);assert.equal(r.profile,'partitioned_repository_history_v2');
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
 print(json.dumps({'platform':sys.platform,'code':result.returncode,'result':json.loads(result.stdout)if result.returncode==0 else None,'error':result.stderr,
  'pointer_exists':(data/'learning_feedback.json').exists()}))
`);
 if(r.platform!=='linux'){
  assert.equal(r.code,2,'an unsupported memory ceiling must refuse, not silently run unbounded');
  assert.equal(JSON.parse(r.error).status,'failed_no_success_ack');
  assert.equal(JSON.parse(r.error).error,'feedback_memory_limit_unavailable');assert.equal(r.pointer_exists,false);return;
 }
 assert.equal(r.code,0,r.error);assert.equal(r.result.cohort_n,2);assert.equal(r.result.late_imported_receipts,4);
 assert.equal(r.result.first_imported_before_kickoff,0);assert.equal(r.result.model_adoption,false);
 assert.equal(r.result.resource_usage.controller_limits_applied,true);
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
