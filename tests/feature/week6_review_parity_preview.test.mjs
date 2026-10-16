import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
function py(source) {
  return JSON.parse(execFileSync('python3',['-'],{cwd:ROOT,encoding:'utf8',input:source,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:95000}).trim().split('\n').pop());
}

test('local review preview is default-off and incomplete arguments never open files, env or children',()=>{
  const result=py(`
import io,json
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import build_review_parity as p
results=[]
with patch.object(p.Path,'open',side_effect=AssertionError('read')),patch.object(p.subprocess,'Popen',side_effect=AssertionError('spawn')),patch.dict(p.os.environ,{},clear=True):
 for args in ([],['--now-utc','SECRET'],['--bundle','SECRET'],['--unknown-SECRET']):
  out=io.StringIO()
  with redirect_stdout(out):code=p.main(args)
  results.append({'code':code,'response':json.loads(out.getvalue())})
print(json.dumps(results))
`);
  assert.equal(result[0].code,0);assert.equal(result[0].response.status,'disabled');
  for(const row of result.slice(1)){assert.equal(row.code,2);assert.equal(row.response.parity,false);assert.ok(!JSON.stringify(row).includes('SECRET'));}
});

test('preview output denies authority paths, existing files, hardlinks, symlinks and redirected parents',()=>{
  const result=py(`
import json,os,pathlib,tempfile
from unittest.mock import patch
from scripts import build_review_parity as p
results=[]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve();engine=root/'engine';engine.mkdir();bundle=root/'bundle.json';bundle.write_text('{}')
 cfg={'engine_checkout':str(engine),'bundle':str(bundle)}
 source=root/'source.json';source.write_text('SOURCE');existing=root/'existing.json';existing.write_text('ORIGINAL')
 hard=root/'hard.json';os.link(source,hard);link=root/'link.json';link.symlink_to(source)
 target=root/'outside';target.mkdir();redirect=root/'redirect';redirect.symlink_to(target,target_is_directory=True)
 for path in (existing,hard,link,redirect/'preview.json',bundle,engine/'preview.json',p.ROOT/'preview.json',root/'data'/'preview.json',pathlib.Path('relative.json'),root/'bad.txt'):
  try:p._output_path(str(path),cfg)
  except (ValueError,OSError):results.append('held')
  else:raise AssertionError(str(path))
 output=p._output_path(str(root/'new.json'),cfg);p.publish_new(output,b'NEW\\n')
 assert output.read_bytes()==b'NEW\\n' and output.stat().st_nlink==1 and output.stat().st_mode&0o777==0o600
 try:p.publish_new(output,b'REPLACE')
 except ValueError:pass
 else:raise AssertionError('existing overwrite')
 occupied=root/'.review-parity-collision.tmp';occupied.write_text('DO NOT REMOVE')
 with patch.object(p.secrets,'token_hex',return_value='collision'):
  try:p.publish_new(root/'collision.json',b'bad')
  except FileExistsError:pass
  else:raise AssertionError('collision')
 assert occupied.read_text()=='DO NOT REMOVE' and not(root/'collision.json').exists()
 real_unlink=p.os.unlink;attempts=[]
 def fail_once(name,**kw):
  attempts.append(name)
  if len(attempts)==1:raise OSError('synthetic temporary cleanup fault')
  return real_unlink(name,**kw)
 with patch.object(p.os,'unlink',side_effect=fail_once):
  try:p.publish_new(root/'aborted.json',b'not published')
  except OSError:pass
  else:raise AssertionError('cleanup fault')
 assert not(root/'aborted.json').exists()
 assert source.read_text()=='SOURCE' and existing.read_text()=='ORIGINAL' and output.read_bytes()==b'NEW\\n'
print(json.dumps({'held':len(results),'exclusive':True}))
`);
  assert.equal(result.held,10);assert.equal(result.exclusive,true);
});

test('invalid worker configuration, explicit clocks and trusted tool paths fail without executing selected code',()=>{
  const result=py(`
import io,json,pathlib,tempfile,types
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import build_review_parity as p
held=[]
for args in (['--worker-stdin','--bundle','SECRET'],):
 with redirect_stdout(io.StringIO()):assert p.main(args)==2
for raw in (b'{"SECRET":1,"SECRET":2}',b'{"SECRET":NaN}',b'[]'):
 source=io.TextIOWrapper(io.BytesIO(raw),encoding='utf8')
 with patch('sys.stdin',source),redirect_stdout(io.StringIO()):assert p.main(['--worker-stdin'])==2
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve();bundle=root/'bundle.json';bundle.write_text('{}');engine=root/'engine';(engine/'tools').mkdir(parents=True)
 for tool in ('nfl_review_parity.py','nfl_review_attachment.py'):(engine/'tools'/tool).write_text('# trusted-path fixture only')
 (engine/'packages/selflearn-core/selflearn_core').mkdir(parents=True)
 cfg=p._configuration(str(bundle),p.fingerprint({}),str(engine),'2026-10-01T00:00:00Z')
 for args in ((str(bundle),'bad',str(engine),'2026-10-01T00:00:00Z'),(str(bundle),p.fingerprint({}),str(engine),'naive'),(str(bundle),p.fingerprint({}),str(engine),'2026-10-01T00:00:00')):
  try:p._configuration(*args)
  except ValueError:held.append('held')
  else:raise AssertionError('configuration')
 with patch.object(p,'MAX_BUNDLE',1):
  try:p._configuration(str(bundle),p.fingerprint({}),str(engine),'2026-10-01T00:00:00Z')
  except ValueError:held.append('size')
  else:raise AssertionError('size')
 real_stat=p.Path.stat
 def large_stat(path,*args,**kwargs):
  actual=real_stat(path,*args,**kwargs)
  return types.SimpleNamespace(st_mode=actual.st_mode,st_size=128*1024*1024+1) if path==bundle else actual
 with patch.object(p.Path,'stat',large_stat):
  try:p._configuration(str(bundle),p.fingerprint({}),str(engine),'2026-10-01T00:00:00Z')
  except ValueError:held.append('128MiBpreflight')
  else:raise AssertionError('128MiBpreflight')
 from scripts import check_learning_parity as original_checker
 class VirtualOversized:
  def __len__(self):return 128*1024*1024+1
 class VirtualStream:
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def read(self,n):
   assert n==128*1024*1024+1;return VirtualOversized()
 with patch.object(original_checker.Path,'open',return_value=VirtualStream()),patch.object(original_checker,'_run',side_effect=AssertionError('oversizedmustnotspawn')):
  try:original_checker.check(bundle,engine_checkout=engine,expected_input_id=p.fingerprint({}),now_utc='2026-10-01T00:00:00Z')
  except ValueError:held.append('actualboundedread')
  else:raise AssertionError('actualboundedread')
 outside=root/'outside.py';outside.write_text('# never executed');tool=engine/'tools/nfl_review_attachment.py';tool.unlink();tool.symlink_to(outside)
 try:p._tool(engine,'nfl_review_attachment.py')
 except ValueError:held.append('redirect')
 else:raise AssertionError('tool redirect')
 for config in ([],{}, {**cfg,'version':True},{**cfg,'version':1.0},{**cfg,'extra':'SECRET'}):
  try:p.build_preview(config)
  except ValueError:held.append('shape')
  else:raise AssertionError('worker shape')
 with patch.object(p,'MAX_CONFIG',1),patch('sys.stdin',io.TextIOWrapper(io.BytesIO(b'{}'),encoding='utf8')),redirect_stdout(io.StringIO()):assert p.main(['--worker-stdin'])==2
print(json.dumps(held))
`);
  assert.equal(result.length,12);
});

test('bounded child pipes reject malformed output, byte growth, nonzero exit and deadlines; cancellation cleans owned group',()=>{
  const result=py(`
import json,os,sys
from unittest.mock import patch
from scripts import build_review_parity as p
results=[];env={'PYTHONDONTWRITEBYTECODE':'1'}
for script,opts in (("print('not-json')",{}),("print('x'*100)",{'maximum_output':10}),('raise SystemExit(2)',{}),('import time;time.sleep(5)',{'timeout':.03})):
 try:p._run_json([sys.executable,'-c',script],b'',cwd=p.ROOT,env=env,timeout=opts.pop('timeout',2),owned_group=True,**opts)
 except (ValueError,OSError):results.append('held')
 else:raise AssertionError(script)
real=p.subprocess.Popen;children=[]
def spawn(*a,**kw):
 child=real(*a,**kw);children.append(child);return child
with patch.object(p.subprocess,'Popen',side_effect=spawn),patch.object(p.time,'monotonic',side_effect=[0,KeyboardInterrupt()]):
 try:p._run_json([sys.executable,'-c','import time;time.sleep(5)'],b'',cwd=p.ROOT,env=env,timeout=2,owned_group=True)
 except KeyboardInterrupt:results.append('cancelled')
 else:raise AssertionError('cancel swallowed')
assert children and all(child.poll() is not None for child in children)
print(json.dumps(results))
`);
  assert.deepEqual(result,['held','held','held','held','cancelled']);
});

test('actual raw producer diagnostics pass through both real child tools; VOID remains a held preview and legacy fields unchanged',t=>{
  if(!ENGINE||!existsSync(ENGINE+'/tools/nfl_review_attachment.py')){
    t.skip('Explicit SELFLEARN_CHECKOUT required; no real cross-repository preview executed');return;
  }
  const result=py(`
import copy,datetime,importlib.util,io,json,pathlib,sys,tempfile
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import build_review_parity as p,build_review
engine=pathlib.Path(${JSON.stringify(ENGINE)}).resolve();sys.path[:0]=[str(engine),str(engine/'packages/selflearn-core')]
spec=importlib.util.spec_from_file_location('real_fixture',engine/'packages/selflearn-core/tests/test_nfl_review_parity.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
values=f.actual_fixture(pathlib.Path.cwd());results=[]
inputs=build_review._fixture_inputs();inputs.setdefault('predictions',{})['week']=6
inputs['schedule']['games'].append({'game_id':'G1','week':6,'home':'SEA','away':'LAR','kickoff_utc':'2026-09-02T00:15:00Z'})
def offline(*,offline):
 assert offline is True;return copy.deepcopy(inputs)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve()
 for index in (1,4):
  value=values[index]
  value['analysis']['as_of_utc']=(datetime.datetime.fromisoformat(value['snapshot_exported_utc'])-datetime.timedelta(microseconds=1)).isoformat()
  bundle=root/('bundle'+str(index)+'.json');bundle.write_text(json.dumps(value));now=value['analysis']['as_of_utc']
  cfg=p._configuration(str(bundle),p.fingerprint(value),str(engine),now)
  before=build_review.build(copy.deepcopy(inputs),now)
  preview=p.build_preview(cfg,load_inputs=offline)
  assert p.fingerprint({k:v for k,v in preview.items() if k!='engine_parity'})==p.fingerprint(before)
  assert preview['engine_parity']['live_learning'] is False and preview['engine_parity']['diagnostic']['namespace_authenticated'] is False
  assert p.instant(now)<p.instant(value['snapshot_exported_utc'])<p.instant(preview['engine_parity']['verification_utc'])
  assert preview['engine_parity']['verification_clock_authenticated'] is False
  # The fixed worker stdin entry has no output path and cannot publish. Its
  # pipeline result below was obtained through the real children above.
  source=io.TextIOWrapper(io.BytesIO(p.encoded(cfg)),encoding='utf8');sink=io.TextIOWrapper(io.BytesIO(),encoding='utf8')
  with patch('sys.stdin',source),patch('sys.stdout',sink),patch.object(p,'build_preview',return_value=preview):
   assert p.main(['--worker-stdin'])==(0 if index==1 else 3);sink.flush()
  assert json.loads(sink.buffer.getvalue())==preview
  # Only the supervisor publishes. This explicit fake process boundary uses
  # the already real-child-verified result to test exclusive CLI publication.
  output=root/('preview'+str(index)+'.json');out=io.StringIO();code=0 if index==1 else 3
  args=['--bundle',str(bundle),'--expected-input-id',p.fingerprint(value),'--engine-checkout',str(engine),'--now-utc',now,'--out',str(output)]
  with patch.object(p,'_run_json',return_value=(code,preview)),redirect_stdout(out):actual=p.main(args)
  assert actual==code and json.loads(output.read_text())==preview
  results.append({'code':code,'parity':preview['engine_parity']['diagnostic']['parity'],'graded':preview['engine_parity']['diagnostic']['coverage']['graded_contracts']})
  bad=copy.deepcopy(preview);bad['learning']['graded_locks_total']=999
  absent=root/('invalid'+str(index)+'.json');args[-1]=str(absent)
  with patch.object(p,'_run_json',return_value=(0,bad)),redirect_stdout(io.StringIO()):assert p.main(args)==2
  assert not absent.exists()
  for fault in (ValueError('SECRET'),KeyboardInterrupt()):
   with patch.object(p,'_run_json',side_effect=fault),redirect_stdout(io.StringIO()):assert p.main(args) in (2,130)
   assert not absent.exists()
  future={**cfg,'now_utc':'2099-01-01T00:00:00Z'}
  try:p.build_preview(future,load_inputs=lambda **kw:(_ for _ in ()).throw(AssertionError('futurecutmustnotload')))
  except ValueError:pass
  else:raise AssertionError('futurecut')
print(json.dumps(results))
`);
  assert.deepEqual(result,[{code:0,parity:true,graded:2},{code:3,parity:false,graded:0}]);
});
