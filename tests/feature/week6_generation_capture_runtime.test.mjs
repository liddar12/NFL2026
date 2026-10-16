import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SOURCE=ROOT+'scripts/generation_capture_runtime.py';
const pin=createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
// Reuse only the explicitly synthetic input-generator definitions, not another
// test's assertions/execution. Production consumers are the real Python code.
const fixture=readFileSync(ROOT+'tests/feature/week6_generation_semantic_gate.test.mjs','utf8').split('const FIXTURE=String.raw`')[1].split('`;\nfunction py')[0];
const covered=new Set();
const HELPERS=String.raw`
import contextlib,io,os,shutil,subprocess,tempfile,sys,stat
from scripts import generation_capture_runtime as C
ROOT=pathlib.Path.cwd()
# Synthetic repos must not inherit background maintenance/hooks from the
# operator's global Git configuration. The failed cleanup left info/refs and
# objects/info/packs after all framing assertions had succeeded.
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def cmd(root,*args,check=True):
 p=subprocess.run(args,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if check:assert p.returncode==0,(args,p.stderr.decode())
 return p
def git(root,*args):return cmd(root,'git',*args).stdout.decode().strip()
def save(path,raw):path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
def workspace(parent,*,optional_absent=False):
 global SOURCE,WEEKLY,CAPTURE,GENERATED,BOUND,CHECKED,KICK
 now=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=30)
 stamp=lambda n:(now+dt.timedelta(seconds=n)).isoformat(timespec='microseconds').replace('+00:00','Z')
 SOURCE,WEEKLY,CAPTURE,GENERATED,BOUND,CHECKED,KICK=[stamp(n)for n in(-1800,-1200,0,1,2,3,172800)]
 root=parent/'checkout';root.mkdir();shutil.copytree(ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(ROOT/'app',root/'app')
 for name in C.EXTRA_FIXED-{C.RUNTIME_PATH}:save(root/name,(ROOT/name).read_bytes())
 docs=originals()
 for name,relative in C._input_paths(2026,6).items():
  if optional_absent and name in C.OPTIONAL:continue
  save(root/relative,G.encoded(docs[name]))
 git(root,'init','-q');git(root,'config','user.email','synthetic@example.invalid');git(root,'config','user.name','Synthetic Fixture')
 git(root,'config','gc.auto','0');git(root,'config','maintenance.auto','false');git(root,'config','core.fsmonitor','false')
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','synthetic original inputs')
 return root,docs
def generated(parent,*,commit=True,previous=False):
 root,docs=workspace(parent,optional_absent=True);out=parent/'private-captures'
 session=C.begin(root,generation_sha=C.head_identity(root),clock=lambda:CAPTURE)
 loader_path=C.persist(session.loader,out,checkout=root)
 session.clock=lambda:GENERATED
 inputs=P.load_inputs(session);assert inputs['player_weekly']is session.documents['player_weekly']
 pool=P.build(inputs);raw=(json.dumps(pool,ensure_ascii=True,indent=2)+'\n').encode();save(root/'data/leg_pool.json',raw)
 checkpoint=C.persist(session.record_pool_bytes(raw),out,checkout=root)
 session=C.resume(checkpoint,checkout=root,clock=lambda:BOUND)
 with contextlib.redirect_stdout(io.StringIO()):
  archive,added=M.run(root/'data/leg_pool.json',root/'data/schedule_full.json',root/'data/parlay_backtest.json',root/'data/my_cards',
   capture_runtime=session,capture_out_dir=out)
 artifacts=[json.loads(p.read_bytes())for p in out.glob('*.json')]
 binding=next(v for v in artifacts if v.get('kind')=='nfl.generation_runtime_binding.v1')
 path=next(p for p in out.glob('*.json')if json.loads(p.read_bytes()).get('kind')==binding['kind'])
 if commit:git(root,'add','data');git(root,'-c','commit.gpgsign=false','commit','-qm','synthetic generated outputs')
 return root,out,session,binding,path,archive
def rejected(call):
 try:call()
 except C.CaptureError as error:return str(error)
 raise AssertionError('expected hold')
`;
function py(body,{trace=true,timeout=45000}={}){
 const input=`import pathlib,sys,json\nTARGET=str(pathlib.Path('scripts/generation_capture_runtime.py').resolve());LINES=set()\ndef trace(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return trace\n${trace?'sys.settrace(trace)':''}\nexec(${JSON.stringify(fixture+HELPERS+body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
 const rows=execFileSync('python3',['-B','-'],{cwd:ROOT,input,encoding:'utf8',timeout,maxBuffer:4*1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim().split('\n');
 JSON.parse(rows.pop()).__trace__.forEach(n=>covered.add(n));return JSON.parse(rows.pop());
}

test('actual opt-in loader→pool→MY writer→journal binds exact bytes and final HEAD, without full-release or original-provider claims',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,out,session,binding,path,archive=generated(pathlib.Path(tmp))
 report=C.verify_head(binding,checkout=root,clock=lambda:CHECKED,expected_head=C.head_identity(root))
 same=C.persist(binding,out,checkout=root).samefile(path)
 print(json.dumps({'pass':report['supported_consumer_pass'],'players':report['semantic_report']['coverage']['supported_players'],
  'claims':report['claims'],'same':same,'private':stat.S_IMODE(path.stat().st_mode)==0o600,
  'missing':session.loader['read_observations']['inactives'],'stage_inputs':sorted(binding['my_stage_reads']['inputs']),
  'duration':session.loader['extra_code']['scripts/injury_duration.py']['raw_sha256']==C._hash((root/'scripts/injury_duration.py').read_bytes()),
  'python':sorted(p for p in session.loader['extra_code']if p.startswith('scripts/')and p.endswith('.py')),
  'expected_python':sorted(p.relative_to(root).as_posix()for p in(root/'scripts').rglob('*.py'))}))
`);
 assert.equal(r.pass,true);assert.equal(r.players,4);assert.equal(r.same,true);assert.equal(r.private,true);
 assert.ok(Object.values(r.claims).every(v=>v===false));assert.equal(r.missing.state,'absent_optional');assert.equal(r.missing.raw_sha256,null);
 assert.deepEqual(r.stage_inputs,['parlay_calibration','previous_my_cards','schedule']);
 assert.equal(r.duration,true);assert.deepEqual(r.python,r.expected_python);
});

test('missing optional is not JSON null; malformed optional, required absence, same-parser mutation and repeated stages hold',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 parent=pathlib.Path(tmp);root,docs=workspace(parent,optional_absent=True)
 session=C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE)
 nullpath=root/'data/atd_week.json';save(nullpath,b'null')
 other=C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE)
 assert session.loader['capture']['inputs']['atd_week']==other.loader['capture']['inputs']['atd_week']
 assert session.loader['loader_id']!=other.loader['loader_id']
 save(nullpath,b'{bad');bad=rejected(lambda:C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE))
 nullpath.unlink();(root/'data/player_weekly.json').unlink();missing=rejected(lambda:C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE))
 session.documents['player_weekly']['players'][0]['gsis_id']='mutated'
 mutation=rejected(session.pool_inputs);order=rejected(session.my_inputs)
 print(json.dumps({'nullstate':other.loader['read_observations']['atd_week']['state'],'bad':bad,'missing':missing,'mutation':mutation,'order':order}))
`);
 assert.equal(r.nullstate,'present_json_null');assert.equal(r.missing,'required_capture_input_absent');
 assert.equal(r.mutation,'consumed_capture_documents_mutated');assert.equal(r.order,'capture_MY_stage_order_invalid');assert.ok(r.bad);
});

test('between-stage bytes/presence/output changes never become new original reads or blind rebinding',()=>{
 const r=py(String.raw`
held=[]
for mode in('pool','schedule','calibration_presence','preimage','second_stage','generated_clock'):
 with tempfile.TemporaryDirectory()as tmp:
  root,docs=workspace(pathlib.Path(tmp),optional_absent=True)
  s=C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE);s.clock=lambda:GENERATED;pool=P.build(P.load_inputs(s));raw=G.encoded(pool)
  save(root/'data/leg_pool.json',raw);s.record_pool_bytes(raw);s.clock=lambda:BOUND
  if mode=='pool':save(root/'data/leg_pool.json',raw+b'\n')
  elif mode=='schedule':save(root/'data/schedule_full.json',(root/'data/schedule_full.json').read_bytes()+b'\n')
  elif mode=='calibration_presence':save(root/'data/parlay_backtest.json',b'null')
  elif mode=='preimage':save(root/'data/my_cards/2026_wk06.json',b'null')
  elif mode=='second_stage':s.my_inputs()
  else:
   changed={**pool,'generated_utc':BOUND};held.append(rejected(lambda:s.record_pool_bytes(G.encoded(changed))));continue
  held.append(rejected(s.my_inputs))
print(json.dumps(held))
`,{timeout:90000});
 assert.equal(r.length,6);assert.ok(r.every(x=>x));assert.ok(r.includes('capture_generated_clock_changed'));
});

test('private immutable artifacts reject root/ancestor/below-root symlinks, source paths, tampering and readonly cancellation',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 parent=pathlib.Path(tmp);root,docs=workspace(parent,optional_absent=True);out=parent/'private';value={'version':1,'synthetic':True}
 path=C.persist(value,out,checkout=root);assert C.read_artifact(path,checkout=root)==value
 bad=[]
 for dest in(root/'data/private',parent,):bad.append(rejected(lambda:C.persist(value,dest,checkout=root)))
 actual=parent/'untouched';actual.mkdir();linked=parent/'linked';linked.symlink_to(actual,target_is_directory=True)
 for dest in(linked,linked/'nested'):bad.append(rejected(lambda:C.persist(value,dest,checkout=root)))
 target=parent/'other.json';target.write_bytes(b'untouched');alias=out/('f'*64+'.json');alias.symlink_to(target)
 bad.append(rejected(lambda:C.read_artifact(alias,checkout=root)))
 path.write_bytes(b'{"changed":true}');bad.append(rejected(lambda:C.read_artifact(path,checkout=root)))
 before=list(actual.iterdir())
 try:C.begin(root,generation_sha='synthetic',clock=lambda:(_ for _ in()).throw(KeyboardInterrupt()))
 except KeyboardInterrupt:cancel=True
 else:cancel=False
 print(json.dumps({'holds':bad,'target':target.read_text(),'untouched':not before,'cancel':cancel}))
`);
 assert.equal(r.holds.length,6);assert.ok(r.holds.every(Boolean));assert.equal(r.target,'untouched');assert.equal(r.untouched,true);assert.equal(r.cancel,true);
});

test('final committed source/output/browser and transitive Python dependency differences hold, as does spoofed evidence',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,out,s,binding,path,archive=generated(pathlib.Path(tmp));base=C.head_identity(root);results=[]
 for relative in('data/player_weekly.json','data/leg_pool.json','app/views/myparlays.js','app/NEW.js',
                 'scripts/injury_duration.py','scripts/NEW.py'):
  old=(root/relative).read_bytes()if(root/relative).exists()else None;save(root/relative,(old or b'')+b'\n')
  git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','synthetic changed dependency')
  try:
   result=C.verify_head(binding,checkout=root,clock=lambda:CHECKED);held=not result['supported_consumer_pass']
  except C.CaptureError:held=True
  results.append(held);git(root,'revert','--no-edit','HEAD')
 for mode in('version','claims','loader_hash','MY_read_clock','MY_read_hash','binding_capture'):
  value=copy.deepcopy(binding)
  if mode=='version':value['version']=True
  elif mode=='claims':value['claims']['whole_release_pass']=True
  elif mode=='loader_hash':value['loader']['loader_id']='sha256:'+'f'*64
  elif mode=='MY_read_clock':value['my_stage_reads']['read_completed_utc_claim']=KICK
  elif mode=='MY_read_hash':value['my_stage_reads']['inputs']['schedule']['raw_sha256']='sha256:'+'f'*64
  else:value['binding']['capture']['generation_sha_claim']='changed'
  reseal(value,'runtime_binding_id');results.append(bool(rejected(lambda:C.verify_head(value,checkout=root,clock=lambda:CHECKED))))
 results.append(bool(rejected(lambda:C.verify_head(binding,checkout=root,clock=lambda:CHECKED,expected_head=base))))
 print(json.dumps(results))
`,{timeout:90000});
 assert.equal(r.length,13);assert.ok(r.every(Boolean));
});

test('Python inventory binds empty modules and omissions while rejecting unsafe paths, symlinks and the exact unchanged file cap',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,docs=workspace(pathlib.Path(tmp),optional_absent=True)
 empty=root/'scripts/empty_module.py';save(empty,b'');git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','empty module')
 s=C.begin(root,generation_sha=C.head_identity(root),clock=lambda:CAPTURE)
 root=s.checkout
 assert s.loader['extra_code']['scripts/empty_module.py']=={'raw_utf8':'','raw_sha256':C._hash(b'')}
 assert C._loader(s.loader)[0]['loader_id']==s.loader['loader_id']
 assert 'scripts/injury_duration.py'in s.loader['extra_code']
 holds=[]
 for path in('scripts/../outside.py','scripts//double.py','scripts/./dot.py','/scripts/absolute.py','scripts/tool.txt'):
  value=copy.deepcopy(s.loader);value['extra_code'][path]={'raw_utf8':'x','raw_sha256':C._hash(b'x')};reseal(value,'loader_id')
  holds.append(rejected(lambda:C._loader(value)))
 save(root/'outside.py',b'untouched');(root/'scripts/linked.py').symlink_to(root/'outside.py')
 holds.append(rejected(lambda:C.begin(root,generation_sha='synthetic',clock=lambda:CAPTURE)))
 (root/'scripts/linked.py').unlink()
 original=C.os.walk
 extra=1024-len(C.EXTRA_FIXED)
 def inventory(directory,followlinks=False):
  if pathlib.Path(directory).name=='scripts':yield str(directory),[],['file%d.py'%n for n in range(extra)]
 C.os.walk=inventory
 try:
  assert len(C._extra_paths(root))==1024
  def too_many(directory,followlinks=False):
   if pathlib.Path(directory).name=='scripts':yield str(directory),[],['file%d.py'%n for n in range(extra+1)]
  C.os.walk=too_many;cap=rejected(lambda:C._extra_paths(root))
 finally:C.os.walk=original
 # Final HEAD, not uploaded inventory, is authoritative: a rehashed omission
 # cannot remove even an otherwise-unused helper from the pinned tree.
 s.clock=lambda:GENERATED;pool=P.build(P.load_inputs(s));raw=G.encoded(pool);save(root/'data/leg_pool.json',raw)
 s.record_pool_bytes(raw);s.clock=lambda:BOUND
 with contextlib.redirect_stdout(io.StringIO()):
  M.run(root/'data/leg_pool.json',root/'data/schedule_full.json',root/'data/parlay_backtest.json',root/'data/my_cards',capture_runtime=s,capture_out_dir=pathlib.Path(tmp)/'private')
 binding=next(json.loads(p.read_bytes())for p in(pathlib.Path(tmp)/'private').glob('*.json')if json.loads(p.read_bytes()).get('kind')=='nfl.generation_runtime_binding.v1')
 git(root,'add','data');git(root,'-c','commit.gpgsign=false','commit','-qm','synthetic generation')
 assert C.verify_head(binding,checkout=root,clock=lambda:CHECKED)['supported_consumer_pass']is True
 # Same blob bytes with a symlink Git mode must not pass as a regular source.
 oid=git(root,'rev-parse','HEAD:scripts/empty_module.py')
 git(root,'update-index','--cacheinfo','120000,'+oid+',scripts/empty_module.py')
 git(root,'-c','commit.gpgsign=false','commit','-qm','same bytes but symlink mode')
 mode=rejected(lambda:C.verify_head(binding,checkout=root,clock=lambda:CHECKED))
 git(root,'update-index','--cacheinfo','100644,'+oid+',scripts/empty_module.py')
 git(root,'-c','commit.gpgsign=false','commit','-qm','restore regular source mode')
 del binding['loader']['extra_code']['scripts/injury_duration.py'];reseal(binding['loader'],'loader_id');reseal(binding,'runtime_binding_id')
 omitted=rejected(lambda:C.verify_head(binding,checkout=root,clock=lambda:CHECKED))
 print(json.dumps({'holds':holds,'cap':cap,'omitted':omitted,'mode':mode,'empty':empty.read_bytes()==b''}))
`);
 assert.deepEqual(r.holds.slice(0,5),Array(5).fill('invalid_capture_code_inventory'));
 assert.equal(r.holds[5],'capture_symlink_rejected');assert.equal(r.cap,'capture_code_inventory_limit');
 assert.equal(r.omitted,'capture_dependency_inventory_changed');assert.equal(r.empty,true);
 assert.equal(r.mode,'capture_head_not_regular_file');
});

test('bounded batch Git reads preserve exact binary/empty/quoted-path bytes and refuse inconsistent framing or duplicate tree rows',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,docs=workspace(pathlib.Path(tmp),optional_absent=True);root=C._checkout(root)
 unusual='scripts/tab\tnewline\nname_é.py';save(root/unusual,b"VALUE = 'unchanged'\n")
 save(root/'scripts/empty.py',b'');save(root/'data/binary.dat',b'\x00\xff\n\x00')
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','framing controls')
 head=C.head_identity(root);tree=C._head_tree(root,head)
 names={p for p in tree if C._extra_path(p)}|{'data/binary.dat'}
 original=C._git;calls=[]
 def counted(root,args,**kw):
  if args[0]=='show':calls.append(args)
  return original(root,args,**kw)
 C._git=counted
 try:blobs=C._head_blobs(root,head,tree,names)
 finally:C._git=original
 assert all(blobs[p]==(root/p).read_bytes()for p in names)
 assert len(calls)<len(names)and all(len(a[3:])<=32 and sum(len(x.encode())for x in a[3:])<=8192 for a in calls)
 def truncated(root,args,**kw):return b'x'if args[0]=='show'else original(root,args,**kw)
 C._git=truncated
 try:short=rejected(lambda:C._head_blobs(root,head,tree,{'scripts/injury_duration.py'}))
 finally:C._git=original
 row=b'100644 blob '+b'f'*40+b' 0\tsame.py\x00'
 def duplicate(root,args,**kw):return row+row
 C._git=duplicate
 try:duplicate_reason=rejected(lambda:C._head_tree(root,head))
 finally:C._git=original
 print(json.dumps({'files':len(names),'calls':len(calls),'binary':blobs['data/binary.dat']==b'\x00\xff\n\x00',
  'empty':blobs['scripts/empty.py']==b'','unusual':unusual in blobs,'short':short,'duplicate':duplicate_reason}))
`);
 assert.ok(r.files>100);assert.ok(r.calls<10);assert.equal(r.binary,true);assert.equal(r.empty,true);assert.equal(r.unusual,true);
 assert.equal(r.short,'capture_git_blob_size_mismatch');assert.equal(r.duplicate,'invalid_capture_git_tree');
});

test('scores-only N/A checks every unpublished commit from the fetched base, never a caller claim or old generation PASS',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,docs=workspace(pathlib.Path(tmp),optional_absent=True)
 base=C.head_identity(root)
 save(root/'data/review.json',b'{}');git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','scores-only synthetic')
 report=C.verify_no_generation(checkout=root,base_head=base,expected_head=C.head_identity(root))
 save(root/'app/views/myparlays.js',(root/'app/views/myparlays.js').read_bytes()+b'\n');git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','browser changes selection')
 changed=rejected(lambda:C.verify_no_generation(checkout=root,base_head=base))
 print(json.dumps({'report':report,'changed':changed}))
`);
 assert.equal(r.report.status,'not_applicable_no_new_generation_scores_only');assert.equal(r.report.supported_consumer_pass,false);
 assert.equal(r.report.no_new_generation_proven_by_fixed_diff,true);assert.equal(r.changed,'capture_no_generation_changed_dependency');
 assert.equal(r.report.checked_commit_count,1);assert.match(r.report.base_head,/^[0-9a-f]{40}$/);
});

test('scores-only N/A refuses an earlier unpublished forecast commit hidden behind a final scores commit',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,docs=workspace(pathlib.Path(tmp),optional_absent=True)
 base=git(root,'rev-parse','HEAD')
 save(root/'data/player_weekly.json',(root/'data/player_weekly.json').read_bytes()+b'\n')
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','unpublished forecast dependency')
 save(root/'data/review.json',b'{}');git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','last commit scores only')
 try:C.verify_no_generation(checkout=root,base_head=base);held=False
 except C.CaptureError:held=True
 print(json.dumps({'held':held,'base':base,'head':C.head_identity(root)}))
`);
 assert.equal(r.held,true,'The complete to-be-pushed range, not just HEAD parent, must be scores-only');
 assert.notEqual(r.base,r.head);
});

test('scores-only base, ancestry, range limits and CLI refusals remain explicit and fail closed',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,docs=workspace(pathlib.Path(tmp),optional_absent=True);base=C.head_identity(root)
 holds=[]
 for bad in(None,'HEAD','',base,'f'*40):
  holds.append(rejected(lambda:C.verify_no_generation(checkout=root,base_head=bad)))
 for n in range(2):
  save(root/'data/review.json',str(n).encode());git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','scores '+str(n))
 report=C.verify_no_generation(checkout=root,base_head=base)
 assert report['checked_commit_count']==2
 buf=io.StringIO()
 with contextlib.redirect_stdout(buf):
  good=C.main(['no-new-generation','--checkout',str(root),'--expected-head',C.head_identity(root),'--base-head',base])
 assert json.loads(buf.getvalue())['base_head']==base
 buf=io.StringIO()
 with contextlib.redirect_stdout(buf):
  missing=C.main(['no-new-generation','--checkout',str(root),'--expected-head',C.head_identity(root)])
 missing_result=json.loads(buf.getvalue())
 # Use the real interpreter of commit-range output, but a bounded synthetic
 # oversized reply. This is a work-limit test, not a native Git history proof.
 original=C._git
 def too_many(root,args,**kw):
  if args[:2]==['rev-list','--parents']:return b'\n'.join([b'a b']*65)
  return original(root,args,**kw)
 C._git=too_many
 try:large=rejected(lambda:C.verify_no_generation(checkout=root,base_head=base))
 finally:C._git=original
 print(json.dumps({'holds':holds,'count':report['checked_commit_count'],'cli':good,'missing':missing,
  'missing_reasons':missing_result['reason_codes'],'large':large}))
`);
 assert.equal(r.holds.length,5);assert.ok(r.holds.every(x=>x==='capture_no_generation_invalid_base'));
 assert.equal(r.count,2);assert.equal(r.cli,0);assert.equal(r.missing,2);
 assert.deepEqual(r.missing_reasons,['capture_no_generation_invalid_base']);
 assert.equal(r.large,'capture_no_generation_commit_limit');
});

test('real verify-head CLI returns a bounded diagnostic and refuses content tampering without treating an old PASS as authority',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,out,s,binding,path,archive=generated(pathlib.Path(tmp));head=C.head_identity(root);buf=io.StringIO()
 with contextlib.redirect_stdout(buf):
  good=C.main(['verify-head','--checkout',str(root),'--binding',str(path),'--expected-head',head])
 result=json.loads(buf.getvalue());assert result['supported_consumer_pass']is True
 path.write_bytes(b'{"secret-provider-diagnostic":"DO-NOT-EXPOSE"}')
 buf=io.StringIO()
 with contextlib.redirect_stdout(buf):
  bad=C.main(['verify-head','--checkout',str(root),'--binding',str(path),'--expected-head',head])
 assert 'DO-NOT-EXPOSE'not in buf.getvalue()
 print(json.dumps({'good':good,'bad':bad,'reason':json.loads(buf.getvalue())['reason_codes'],'claims':result['claims']}))
`);
 assert.equal(r.good,0);assert.equal(r.bad,2);assert.deepEqual(r.reason,['capture_artifact_hash_mismatch']);
 assert.ok(Object.values(r.claims).every(x=>x===false));
});

test('a second actual generation preserves first-seen MY receipt bytes and resolves retained lineage only from immutable old journal evidence',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root,out,first,oldbinding,path,previous=generated(pathlib.Path(tmp));old=G.encoded(previous['cards'])
 original_capture=CAPTURE;shift=lambda value:(R.instant(value)+dt.timedelta(seconds=10)).isoformat().replace('+00:00','Z')
 CAPTURE,GENERATED,BOUND,CHECKED=[shift(x)for x in(CAPTURE,GENERATED,BOUND,CHECKED)]
 second=C.begin(root,generation_sha=C.head_identity(root),clock=lambda:CAPTURE);second.clock=lambda:GENERATED
 pool=P.build(P.load_inputs(second));raw=(json.dumps(pool,ensure_ascii=True,indent=2)+'\n').encode();save(root/'data/leg_pool.json',raw);second.record_pool_bytes(raw);second.clock=lambda:BOUND
 with contextlib.redirect_stdout(io.StringIO()):
  archive,added=M.run(root/'data/leg_pool.json',root/'data/schedule_full.json',root/'data/parlay_backtest.json',root/'data/my_cards',capture_runtime=second,capture_out_dir=out)
 binding=next(json.loads(p.read_bytes())for p in out.glob('*.json')if json.loads(p.read_bytes()).get('kind')=='nfl.generation_runtime_binding.v1'and json.loads(p.read_bytes()).get('binding',{}).get('capture',{}).get('captured_utc_claim')==CAPTURE)
 git(root,'add','data');git(root,'-c','commit.gpgsign=false','commit','-qm','second synthetic generation')
 report=C.verify_head(binding,checkout=root,clock=lambda:CHECKED)
 target=next(e['request']['payload']for e in binding['binding']['graph']['generations']if e['request']['payload']['envelope_id']==binding['binding']['target_envelope_id'])
 snapshots=root/'data/snapshots';sources={x['object_id']:x['payload']for x in binding['binding']['graph']['source_objects']}
 oldpool=oldbinding['binding']['graph']['generations'][0]['request']['payload']['generations'][0]['source_snapshots']['leg_pool']
 (snapshots/'learning_sources'/(oldpool.split(':')[1]+'.json')).unlink()
 missing=rejected(lambda:second.journal_graph(target,pool,second.documents['schedule'],second.documents['parlay_calibration'],archive,snapshots))
 print(json.dumps({'pass':report['supported_consumer_pass'],'old':old==G.encoded(archive['cards']),'generations':len(binding['binding']['graph']['generations']),
  'coverage':report['semantic_report']['coverage'],'missing':missing}))
`,{timeout:90000});
 assert.equal(r.pass,true);assert.equal(r.old,true);assert.equal(r.generations,2);assert.ok(r.coverage.retained_archive_legs>0);
 assert.equal(r.coverage.target_archive_legs,0);assert.equal(r.missing,'capture_journal_history_absent');
});

test('publisher checks the fixed final-HEAD CLI before each retry and refuses changed/rebased data with zero push on HOLD',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 parent=pathlib.Path(tmp);root,out,s,binding,path,archive=generated(parent,commit=False)
 # No remote or HTTP: a command wrapper intercepts fetch/push only and delegates
 # all read-only/object/commit operations to real local git.
 realgit=shutil.which('git');bin=parent/'bin';bin.mkdir();calls=parent/'calls';remote=git(root,'rev-parse','HEAD')
 wrapper='#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\np='+repr(str(calls))+'\n'
 wrapper+='if a and a[0]=="fetch":\n open(p,"a").write("fetch\\n");sys.exit(0)\n'
 wrapper+='if a and a[0]=="push":\n n=sum(x.startswith("push")for x in open(p).read().splitlines());open(p,"a").write("push "+a[-1]+"\\n");sys.exit(1 if n==0 else 0)\n'
 wrapper+='os.execv('+repr(realgit)+',["git"]+a)\n';save(bin/'git',wrapper.encode());(bin/'git').chmod(0o700)
 (root/'.git/FETCH_HEAD').write_text(remote+'\t\tbranch main of synthetic-local\n')
 env={**os.environ,'PATH':str(bin)+os.pathsep+os.environ['PATH'],'PUBLISH_ATTEMPTS':'2','PUBLISH_BACKOFF_S':'0','PUBLISH_VALIDATE_CMD':'true'}
 good=subprocess.run(['bash',str(root/'scripts/publish_data.sh'),'--generation-binding',str(path),'synthetic publish'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 pushed=[x for x in calls.read_text().splitlines()if x.startswith('push')]
 assert good.returncode==0,(good.stdout,good.stderr)
 assert len(pushed)==2 and all('HEAD:main'not in x for x in pushed)
 # Changed final tree: actual final-HEAD verifier refuses BEFORE any push.
 calls.write_text('');save(root/'data/leg_pool.json',(root/'data/leg_pool.json').read_bytes()+b'\n')
 held=subprocess.run(['bash',str(root/'scripts/publish_data.sh'),'--generation-binding',str(path),'synthetic changed pool'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 print(json.dumps({'first':good.returncode,'pushes':len(pushed),'preflights':good.stdout.decode().count('nfl.final_HEAD_consumer_preflight.v1'),
  'hold':held.returncode,'held_pushes':sum(x.startswith('push')for x in calls.read_text().splitlines()),'remote_network':False}))
`,{trace:false,timeout:90000});
 assert.equal(r.first,0);assert.equal(r.pushes,2);assert.equal(r.preflights,2);assert.notEqual(r.hold,0);assert.equal(r.held_pushes,0);
 assert.equal(r.remote_network,false);
});

test('publisher scores-only mode binds the fetched remote base and refuses earlier unpublished forecast dependencies before any push',()=>{
 const rows=py(String.raw`
results=[]
for earlier_forecast in(False,True):
 with tempfile.TemporaryDirectory()as tmp:
  parent=pathlib.Path(tmp);root,docs=workspace(parent,optional_absent=True)
  remote=C.head_identity(root);realgit=shutil.which('git');bin=parent/'bin';bin.mkdir();calls=parent/'calls'
  wrapper='#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\np='+repr(str(calls))+'\n'
  wrapper+='if a and a[0]=="fetch":\n open(p,"a").write("fetch\\n");sys.exit(0)\n'
  wrapper+='if a and a[0]=="push":\n open(p,"a").write("push "+a[-1]+"\\n");sys.exit(0)\n'
  wrapper+='os.execv('+repr(realgit)+',["git"]+a)\n'
  save(bin/'git',wrapper.encode());(bin/'git').chmod(0o700)
  (root/'.git/FETCH_HEAD').write_text(remote+'\t\tbranch main of synthetic-local\n')
  if earlier_forecast:
   save(root/'data/player_weekly.json',(root/'data/player_weekly.json').read_bytes()+b'\n')
   git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-qm','earlier unverified forecast')
  save(root/'data/review.json',b'{}')
  env={**os.environ,'PATH':str(bin)+os.pathsep+os.environ['PATH'],'PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0','PUBLISH_VALIDATE_CMD':'true'}
  result=subprocess.run(['bash',str(root/'scripts/publish_data.sh'),'--no-new-generation','synthetic scores refresh'],
   cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
  results.append({'earlier':earlier_forecast,'exit':result.returncode,
   'pushes':sum(line.startswith('push')for line in calls.read_text().splitlines()),
   'diagnostic':'nfl.generation_semantic_not_applicable.v1'in result.stdout.decode()})
print(json.dumps(results))
`,{trace:false,timeout:90000});
 assert.equal(rows[0].exit,0);assert.equal(rows[0].pushes,1);assert.equal(rows[0].diagnostic,true);
 assert.notEqual(rows[1].exit,0);assert.equal(rows[1].pushes,0);
});

test('archive-only and combined-runtime budgets are exact and cannot relax other document/graph limits',()=>{
 const r=py(String.raw`
small={k:None for k in G.INPUT_NAMES};small['pool_backtest']={'calibration':{},'residual_sd':{}}
def nodes(v):
 stack=[v];n=0
 while stack:
  x=stack.pop();n+=1
  if type(x)is dict:stack.extend(x.keys());stack.extend(x.values())
  elif type(x)is list:stack.extend(x)
 return n
base=nodes(small);small['player_weekly']=[None]*400000
small['previous_my_cards']=[None]*(G.RUNTIME_DOCUMENT_NODES-nodes(small))
assert nodes(small)==G.RUNTIME_DOCUMENT_NODES
G.runtime_binding(code_bytes(),small)
small['previous_my_cards'].append(None)
try:G.runtime_binding(code_bytes(),small)
except G.GateError:over=True
else:over=False
archive=b'['+b','.join([b'null']*(G.ARCHIVE_DOCUMENT_NODES-1))+b']'
assert len(G._document(archive,'previous_my_cards'))==G.ARCHIVE_DOCUMENT_NODES-1
assert len(G._document(archive,'data/my_cards/2026_wk06.json'))==G.ARCHIVE_DOCUMENT_NODES-1
held=[]
for name,raw in(('player_weekly',archive),('data/leg_pool.json',archive),('previous_my_cards',archive[:-1]+b',null]')):
 try:G._document(raw,name)
 except G.GateError:held.append(True)
 else:held.append(False)
assert len(G._json(b'['+b','.join([b'null']*(G.MAX_JSON_NODES-1))+b']'))==G.MAX_JSON_NODES-1
try:G._plain([None]*G.MAX_JSON_NODES)
except G.GateError:held.append(True)
else:held.append(False)
print(json.dumps({'aggregate_over':over,'holds':held,'default':G.MAX_JSON_NODES,'archive':G.ARCHIVE_DOCUMENT_NODES}))
`,{trace:false,timeout:90000});
 assert.equal(r.aggregate_over,true);assert.deepEqual(r.holds,[true,true,true,true]);assert.equal(r.default,500000);assert.equal(r.archive,750000);
});

after(()=>{
 assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),pin,'runtime source changed during test');
 const result=JSON.parse(execFileSync('python3',['-B','-c','import ast,json,pathlib; t=ast.parse(pathlib.Path("scripts/generation_capture_runtime.py").read_text()); print(json.dumps(sorted({n.lineno for n in ast.walk(t) if isinstance(n,ast.stmt)})))'],{cwd:ROOT,encoding:'utf8'}));
 const hits=result.filter(x=>covered.has(x));console.log(JSON.stringify({source:SOURCE,sha256:pin,covered:hits.length,total:result.length,percent:100*hits.length/result.length,missing:result.filter(x=>!covered.has(x))}));
});
