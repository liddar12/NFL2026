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

test('independent default-off preview performs no configuration, wall-clock, file, or child work',()=>{
  assert.deepEqual(py(`
import io,json
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import build_review_parity as p
with patch.object(p,'_configuration',side_effect=AssertionError('configuration')),patch.object(p,'datetime') as clock,patch.object(p.os,'open',side_effect=AssertionError('write')),patch.object(p.Path,'open',side_effect=AssertionError('read')),patch.object(p.subprocess,'Popen',side_effect=AssertionError('child')):
 clock.now.side_effect=AssertionError('clock')
 sink=io.StringIO()
 with redirect_stdout(sink):code=p.main([])
 result=json.loads(sink.getvalue())
 assert not clock.now.called
print(json.dumps({'code':code,'result':result}))
`),{code:0,result:{version:1,status:'disabled',parity:false}});
});

test('owned process groups cannot survive an exited worker through held pipes or successful detached pipes',()=>{
  const result=py(`
import json,os,pathlib,signal,sys,tempfile,time
from unittest.mock import patch
from scripts import build_review_parity as p
results=[]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve()
 for mode in ('held_stdout','closed_stdout'):
  marker=root/(mode+'.pid');effect=root/(mode+'.effect');arm=root/(mode+'.arm')
  # Side effects are armed only AFTER the supervisor returns. A fixed sleep
  # from process birth confounds cleanup with Python startup under gate load.
  grandchild="import pathlib,time\\narm=pathlib.Path(%r)\\nwhile not arm.exists():time.sleep(.01)\\npathlib.Path(%r).write_text('escaped')\\ntime.sleep(20)"%(str(arm),str(effect))
  kwargs='' if mode=='held_stdout' else ',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL'
  script="import subprocess,sys,pathlib; c=subprocess.Popen([sys.executable,'-c',%r],stdin=subprocess.DEVNULL%s);pathlib.Path(%r).write_text(str(c.pid));print('{}',flush=True)"%(grandchild,kwargs,str(marker))
  original=p.subprocess.Popen;leaders=[];pid=None
  def spawn(*args,**kwargs):
   assert kwargs['start_new_session']is True
   return leaders[0]
  try:
   # Prepare the exact exited-leader/live-descendant boundary before starting
   # the supervisor's unchanged150ms held-pipe budget. This is a real process,
   # not a fake poll/wait object; the factory still verifies group ownership.
   leaders.append(original([sys.executable,'-c',script],cwd=p.ROOT,env={'PYTHONDONTWRITEBYTECODE':'1'},
    stdin=p.subprocess.PIPE,stdout=p.subprocess.PIPE,stderr=p.subprocess.DEVNULL,start_new_session=True))
   ready=time.monotonic()+5
   while(not marker.exists()or leaders[0].poll()is None)and time.monotonic()<ready:time.sleep(.01)
   assert marker.exists()and leaders[0].poll()is not None,'fixture must reach exited leader before cleanup is evaluated'
   pid=int(marker.read_text())
   with patch.object(p.subprocess,'Popen',side_effect=spawn):
    try:code,value=p._run_json([sys.executable,'-c',script],b'',cwd=p.ROOT,env={'PYTHONDONTWRITEBYTECODE':'1'},timeout=.15 if mode=='held_stdout' else 2,owned_group=True)
    except ValueError as exc:
     assert mode=='held_stdout' and str(exc)=='preview_process_deadline'
    else:assert mode=='closed_stdout' and (code,value)==(0,{})
   assert marker.exists() and len(leaders)==1 and leaders[0].poll() is not None
   arm.write_text('check cleanup now')
   time.sleep(.45)
   assert not effect.exists(),mode+' descendant executed after supervisor completion'
   results.append(mode)
  finally:
   # This test owns exactly this process tree. Always clean a failed probe.
   if pid is None and marker.exists():pid=int(marker.read_text())
   if pid is not None:
    try:
     assert os.getpgid(pid)==leaders[0].pid
     os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
   if leaders:
    try:os.killpg(leaders[0].pid,signal.SIGKILL)
    except ProcessLookupError:pass
print(json.dumps(results))
`);
  assert.deepEqual(result,['held_stdout','closed_stdout']);
});

test('output publication repeats nofollow authority after preflight and never overwrites occupied names',()=>{
  assert.deepEqual(py(`
import json,os,pathlib,tempfile
from scripts import build_review_parity as p
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve();parent=root/'selected';parent.mkdir();redirect=root/'redirect-target';redirect.mkdir()
 cfg={'engine_checkout':str(root/'engine'),'bundle':str(root/'input.json')}
 selected=p._output_path(str(parent/'preview.json'),cfg)
 parent.rename(root/'old-parent');parent.symlink_to(redirect,target_is_directory=True)
 try:p.publish_new(selected,b'never redirected')
 except OSError:pass
 else:raise AssertionError('directory swap redirected a write')
 assert not list(redirect.iterdir()) and not list((root/'old-parent').iterdir())
 parent.unlink();parent.mkdir();selected=p._output_path(str(parent/'preview.json'),cfg)
 original=root/'original.json';original.write_bytes(b'IMMUTABLE');os.link(original,selected)
 try:p.publish_new(selected,b'overwrite')
 except ValueError:pass
 else:raise AssertionError('hardlink overwritten')
 assert selected.read_bytes()==original.read_bytes()==b'IMMUTABLE'
 assert sorted(x.name for x in parent.iterdir())==['preview.json']
print(json.dumps({'redirect_empty':True,'original_unchanged':True}))
`),{redirect_empty:true,original_unchanged:true});
});

test('the deadline still includes real worker startup and kills a late-starting owned group',()=>{
  const result=py(`
import json,pathlib,signal,os,sys,tempfile,time
from unittest.mock import patch
from scripts import build_review_parity as p
with tempfile.TemporaryDirectory()as tmp:
 effect=pathlib.Path(tmp)/'late.effect';leaders=[];original=p.subprocess.Popen
 script="import pathlib,time;time.sleep(.5);pathlib.Path(%r).write_text('escaped');time.sleep(20)"%str(effect)
 def slow_start(*args,**kwargs):
  time.sleep(.2)
  process=original(*args,**kwargs);leaders.append(process);return process
 try:
  with patch.object(p.subprocess,'Popen',side_effect=slow_start):
   try:p._run_json([sys.executable,'-c',script],b'',cwd=p.ROOT,env={'PYTHONDONTWRITEBYTECODE':'1'},timeout=.05,owned_group=True)
   except ValueError as exc:assert str(exc)=='preview_process_deadline'
   else:raise AssertionError('startup must not reset the work deadline')
  assert len(leaders)==1 and leaders[0].poll()is not None
  time.sleep(.65);assert not effect.exists(),'late-starting worker survived its expired budget'
 finally:
  if leaders:
   try:os.killpg(leaders[0].pid,signal.SIGKILL)
   except ProcessLookupError:pass
print(json.dumps({'deadline_held':True,'side_effect':False}))
`);
  assert.deepEqual(result,{deadline_held:true,side_effect:false});
});

test('bounded actual child responses reject duplicate JSON, overgrowth and cancellation without publication',()=>{
  assert.deepEqual(py(`
import json,sys
from unittest.mock import patch
from scripts import build_review_parity as p
codes=[]
for script,cap in (("print('{\\\"key\\\":1,\\\"key\\\":2}')",64),("print('x'*65)",64),("print('NaN')",64)):
 try:p._run_json([sys.executable,'-c',script],b'',cwd=p.ROOT,env={},timeout=2,maximum_output=cap,owned_group=True)
 except ValueError:codes.append('held')
 else:raise AssertionError('invalid bytes accepted')
original=p.subprocess.Popen;children=[]
def spawn(*args,**kwargs):
 process=original(*args,**kwargs);children.append(process);return process
with patch.object(p.subprocess,'Popen',side_effect=spawn),patch.object(p.time,'monotonic',side_effect=[0,SystemExit(71)]):
 try:p._run_json([sys.executable,'-c','import time;time.sleep(20)'],b'',cwd=p.ROOT,env={},timeout=2,owned_group=True)
 except SystemExit as exc:assert exc.code==71;codes.append('cancelled')
 else:raise AssertionError('cancellation swallowed')
assert children and all(child.poll() is not None for child in children)
print(json.dumps(codes))
`),['held','held','held','cancelled']);
});

test('independent real raw evaluator/helper chain preserves legacy bytes and distinct historical verification clocks',()=>{
  assert.ok(ENGINE&&existsSync(ENGINE+'/tools/nfl_review_attachment.py'),'Explicit SELFLEARN_CHECKOUT is required for actual cross-repository verification');
  const result=py(`
import copy,datetime,importlib.util,io,json,pathlib,sys,tempfile
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import build_review_parity as p,build_review
engine=pathlib.Path(${JSON.stringify(ENGINE)}).resolve();sys.path[:0]=[str(engine),str(engine/'packages/selflearn-core')]
spec=importlib.util.spec_from_file_location('independent_real_fixture',engine/'packages/selflearn-core/tests/test_nfl_review_parity.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
values=fixture.actual_fixture(pathlib.Path.cwd())
inputs=build_review._fixture_inputs();inputs.setdefault('predictions',{})['week']=6
inputs['schedule']['games'].append({'game_id':'G1','week':6,'home':'SEA','away':'LAR','kickoff_utc':'2026-09-02T00:15:00Z'})
def offline(*,offline):
 assert offline is True;return copy.deepcopy(inputs)
results=[]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp).resolve()
 for index in (1,4):
  value=copy.deepcopy(values[index]);cut=(datetime.datetime.fromisoformat(value['snapshot_exported_utc'])-datetime.timedelta(microseconds=1)).isoformat();value['analysis']['as_of_utc']=cut
  bundle=root/('supplied'+str(index)+'.json');bundle.write_bytes(p.encoded(value));raw=bundle.read_bytes()
  cfg=p._configuration(str(bundle),p.fingerprint(value),str(engine),cut)
  legacy=build_review.build(copy.deepcopy(inputs),cut);legacy_bytes=p.encoded(legacy)
  attached=p.build_preview(cfg,load_inputs=offline);block=attached['engine_parity']
  assert p.encoded({k:v for k,v in attached.items() if k!='engine_parity'})==legacy_bytes
  assert bundle.read_bytes()==raw and set(attached)==set(legacy)|{'engine_parity'}
  assert p.instant(cut)<p.instant(value['snapshot_exported_utc'])<=p.instant(block['verification_utc'])
  assert block['verification_clock_authenticated'] is False
  assert all(block[k] is False for k in ('live_learning','namespace_authenticated','completeness_authenticated','model_adoption','live_review_replaced','accuracy_improvement_claimed'))
  # This is real raw evidence and real child execution, not SQL/source authentication.
  assert block['diagnostic']['namespace_authenticated'] is False and block['source_authentication']=='not_performed'
  # Explicit fake supervisor boundary tests only that invalid return metadata cannot publish.
  for fault in ('clock','original_review','exit'):
   bad=copy.deepcopy(attached);code=0 if block['diagnostic']['parity'] else 3
   if fault=='clock':
    bad['engine_parity']['verification_utc']='2099-01-01T00:00:00Z'
    b=bad['engine_parity'];b['attachment_id']=p.fingerprint({k:v for k,v in b.items() if k!='attachment_id'})
   elif fault=='original_review':bad['independent_tamper']=True
   else:code=3 if code==0 else 0
   out=root/('refused'+str(index)+fault+'.json');args=['--bundle',str(bundle),'--expected-input-id',p.fingerprint(value),'--engine-checkout',str(engine),'--now-utc',cut,'--out',str(out)]
   with patch.object(p,'_run_json',return_value=(code,bad)),redirect_stdout(io.StringIO()):assert p.main(args)==2
   assert not out.exists()
  results.append({'parity':block['diagnostic']['parity'],'graded':block['diagnostic']['coverage']['graded_contracts']})
 assert sorted(x.name for x in root.iterdir())==['supplied1.json','supplied4.json']
print(json.dumps(results))
`);
  assert.deepEqual(result,[{parity:true,graded:2},{parity:false,graded:0}]);
});
