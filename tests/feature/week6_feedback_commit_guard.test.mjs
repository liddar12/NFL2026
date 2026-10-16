import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
const SOURCE=ROOT+'scripts/feedback_commit_guard.py';
const PIN=createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const hits=new Set();
const FIXTURE=String.raw`
import copy,importlib.util,io,json,os,pathlib,subprocess,sys,tempfile
from contextlib import redirect_stdout,redirect_stderr
from unittest.mock import patch
from scripts import run_parlay_feedback as I,feedback_commit_guard as G
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
spec=importlib.util.spec_from_file_location('fixture',pathlib.Path('tests/fixtures/week6_outcomes.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
def refused(fn):
 try:fn()
 except (ValueError,RuntimeError,OSError,KeyError,TypeError):return True
 return False
def workspace(root):
 work=root/'work';work.mkdir();I.git(work,'init','-b','main');I.git(work,'config','user.email','fixture@example.invalid');I.git(work,'config','user.name','Synthetic Fixture')
 I.git(work,'config','gc.auto','0');I.git(work,'config','maintenance.auto','false');I.git(work,'config','core.fsmonitor','false')
 data=work/'data';snapshots=data/'snapshots';f.generation(snapshots);f.generation(snapshots,'2026-09-01T13:00:00Z')
 captured=f.capture.save_capture(f.bundle(),root/'external-capture');engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.git(engine,'rev-parse','HEAD')
 I.run(data_dir=data,snapshot_dir=snapshots,captures=[],engine_checkout=engine,engine_commit=pin,
  observed_utc='2026-09-01T15:00:00Z',evaluation_clock=lambda:'2026-09-01T15:00:01Z')
 I.run(data_dir=data,snapshot_dir=snapshots,captures=[captured],engine_checkout=engine,engine_commit=pin,
  observed_utc='2026-09-04T15:00:00Z',evaluation_clock=lambda:'2026-09-04T15:00:01Z')
 commit(work);return work,data
def commit(work):
 I.git(work,'add','.');I.git(work,'-c','commit.gpgsign=false','commit','-m','synthetic feedback tree');return I.git(work,'rev-parse','HEAD')
`;
function py(source){
 const trace=`import sys,pathlib,json,hashlib,atexit\nTARGET=str(pathlib.Path('scripts/feedback_commit_guard.py').resolve());HITS=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':HITS.add(frame.f_lineno)\n return traced\ndef coverage():\n sys.settrace(None)\n print('FEEDBACK_GIT_COVERAGE '+json.dumps({'sha256':hashlib.sha256(pathlib.Path(TARGET).read_bytes()).hexdigest(),'lines':sorted(HITS)}),file=sys.stderr)\natexit.register(coverage);sys.settrace(traced)\n`;
 const r=spawnSync('python3',['-B','-'],{cwd:ROOT,encoding:'utf8',input:trace+FIXTURE+source,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:60000,maxBuffer:8*1024*1024});
 for(const line of r.stderr.split('\n'))if(line.startsWith('FEEDBACK_GIT_COVERAGE ')){
  const row=JSON.parse(line.slice(22));assert.equal(row.sha256,PIN);row.lines.forEach(n=>hits.add(n));
 }
 assert.equal(r.status,0,r.stderr+r.stdout);return JSON.parse(r.stdout.trim().split('\n').pop());
}
function requireEngine(t){
 if(!ENGINE||!existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py')){
  t.skip('Explicit SELFLEARN_CHECKOUT required for original producer/pinned-Git feedback acceptance');return false;
 }
 return true;
}

test('pinned Git checker verifies original raw captures and ignores changed uncommitted worktree files',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 work,data=workspace(pathlib.Path(tmp));head=I.git(work,'rev-parse','HEAD');index=(work/'.git/index').read_bytes()
 pointer=data/'learning_feedback.json';pointer.write_text('uncommitted invalid JSON');before=pointer.read_bytes()
 owned=[];temporary=G.tempfile.TemporaryDirectory
 def allocated(*args,**kwargs):
  value=temporary(*args,**kwargs);owned.append(pathlib.Path(value.name));return value
 with patch.object(I,'engine',side_effect=AssertionError('engine load')),patch.object(G.tempfile,'TemporaryDirectory',side_effect=allocated):result=G.check_committed(work,head)
 print(json.dumps({'result':result,'same_head':I.git(work,'rev-parse','HEAD')==head,'same_index':index==(work/'.git/index').read_bytes(),
  'unchanged_worktree':pointer.read_bytes()==before,'temp_removed':bool(owned)and all(not path.exists()for path in owned)}))
`);
 assert.equal(r.result.status,'committed_records_valid');assert.equal(r.result.source_writes,false);
 assert.equal(r.result.temporary_files_written,true);assert.equal(r.result.engine_loaded,false);
 assert.equal(r.same_head,true);assert.equal(r.same_index,true);assert.equal(r.unchanged_worktree,true);
 assert.equal(r.temp_removed,true);
 assert.ok(r.result.files>=10&&r.result.bytes>0);
});

test('valid working-tree repairs cannot approve a commit missing a frozen source or raw capture',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
results=[]
for family in ('learning_sources','learning_outcomes/objects'):
 with tempfile.TemporaryDirectory() as tmp:
  work,data=workspace(pathlib.Path(tmp));path=next((data/'snapshots'/family).iterdir());park=path.with_suffix('.park');path.rename(park);head=commit(work)
  park.rename(path);worktree_valid=I.validate_records(data)
  held=refused(lambda:G.check_committed(work,head));results.append([worktree_valid,held,I.git(work,'rev-parse','HEAD')==head])
print(json.dumps(results))
`);
 assert.deepEqual(r,[[true,true,true],[true,true,true]]);
});

test('exact expected HEAD and regular committed objects are mandatory',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 work,data=workspace(pathlib.Path(tmp));head=I.git(work,'rev-parse','HEAD')
 wrong=[refused(lambda:G.check_committed(work,value))for value in ('HEAD','main','0'*40,True)]
 source=next((data/'snapshots/learning_sources').glob('*.json'));original=source.read_bytes();source.unlink();source.symlink_to('outside.json');head=commit(work)
 symlink=refused(lambda:G.check_committed(work,head))
 print(json.dumps({'wrong':wrong,'symlink':symlink}))
`);
 assert.deepEqual(r,{wrong:[true,true,true,true],symlink:true});
});

test('metadata framing, duplicate objects, blob size/content, total and time budgets fail closed',()=>{
 const r=py(String.raw`
head='1'*40;raw=b'null';oid=G.hashlib.sha1(b'blob 4\0'+raw).hexdigest();row=b'100644 blob '+oid.encode()+b' 4\tdata/learning_feedback.json\0';checks=[]
for tree in (row[:-1],row+row,row.replace(b' blob ',b' commit '),row.replace(b' 4\t',b' -1\t')):
 with tempfile.TemporaryDirectory() as tmp,patch.object(G.runtime,'_git',side_effect=[head.encode(),tree]):
  checks.append(refused(lambda:G._Snapshot(tmp,head,tmp)))
for changed in (b'NULL',b'nul',b'nullx'):
 with tempfile.TemporaryDirectory() as tmp,patch.object(G.runtime,'_git',side_effect=[head.encode(),row,changed]):
  view=G._Snapshot(tmp,head,tmp);checks.append(refused(lambda:view.copy('data/learning_feedback.json')))
with tempfile.TemporaryDirectory() as tmp,patch.object(G.runtime,'_git',side_effect=[head.encode(),row]):
 view=G._Snapshot(tmp,head,tmp)
 with patch.dict(G.PROFILE,maximum_total_bytes=3):checks.append(refused(lambda:view.copy('data/learning_feedback.json')))
 checks.append(refused(lambda:view.copy('data/learning_feedback.json',maximum=3)))
 view.deadline=-1;checks.append(refused(lambda:view.git(['rev-parse','HEAD'],128)))
print(json.dumps(checks))
`);
 assert.equal(r.length,10);assert.ok(r.every(Boolean));
});

test('isolated committed-check CLI returns static failures and actual positive data proof',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 work,data=workspace(pathlib.Path(tmp));head=I.git(work,'rev-parse','HEAD')
 command=[sys.executable,'-I','-S','-B',str(I.ROOT/'scripts/feedback_commit_guard.py'),'--checkout',str(work),'--expected-head']
 good=subprocess.run(command+[head],capture_output=True,text=True,timeout=30)
 bad=subprocess.run(command+['PRIVATE_INVALID_HEAD'],capture_output=True,text=True,timeout=30)
 out=io.StringIO();errors=io.StringIO()
 with redirect_stdout(out):direct=G.main(['--checkout',str(work),'--expected-head',head])
 with redirect_stderr(errors):denied=G.main(['--checkout',str(work),'--expected-head','PRIVATE_INVALID_HEAD'])
 assert direct==0 and denied==2 and json.loads(out.getvalue())['status']=='committed_records_valid'
 print(json.dumps({'good':good.returncode,'result':json.loads(good.stdout),'bad':bad.returncode,'error':bad.stderr}))
`);
 assert.equal(r.good,0);assert.equal(r.result.status,'committed_records_valid');assert.equal(r.bad,2);
 assert.ok(!r.error.includes('PRIVATE'));assert.equal(JSON.parse(r.error).model_adoption,false);
});

test('publisher keeps an existing semantic SHA pin and invokes fixed-commit feedback verification before push',()=>{
 const source=readFileSync(ROOT+'scripts/publish_data.sh','utf8');
 const at=source.indexOf('if git cat-file -e "${push_ref}:data/learning_feedback.json"');
 const end=source.indexOf('if git push origin "$push_ref:main"',at);
 const block=source.slice(at,end);
 assert.ok(at>=0&&end>at);
 assert.match(block,/git cat-file -e "\$\{push_ref\}:data\/learning_feedback\.json"/);
 assert.match(block,/if \[ "\$push_ref" = "HEAD" \]; then push_ref=/);
 assert.match(block,/feedback_commit_guard\.py" --checkout "\$PWD" --expected-head "\$push_ref"/);
 assert.ok(!block.includes('--check-records'));
 assert.ok((block.match(/git rev-parse HEAD/g)||[]).length>=3);
});

after(()=>{
 assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),PIN);
 const r=spawnSync('python3',['-c','import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1])if n>0)))',SOURCE],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const all=new Set([...JSON.parse(r.stdout),...hits]);
 console.log(JSON.stringify({source:'scripts/feedback_commit_guard.py',sha256:PIN,covered:hits.size,total:all.size,
  percent:100*hits.size/all.size,missing:[...all].filter(n=>!hits.has(n)).sort((a,b)=>a-b),scope:'local pinned Git fixtures; not served-site or provider authentication'}));
 if(ENGINE&&existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py'))assert.ok(100*hits.size/all.size>=90,'Complete committed-feedback checker must exceed 90% line coverage');
});
