import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
function py(source) {
  return JSON.parse(execFileSync('python3',['-'],{cwd:ROOT,encoding:'utf8',input:source,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:90000}).trim().split('\n').pop());
}

test('local parity CLI is default-off without input, subprocess or data-file access',()=>{
  const result=py(`
import io,json
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import check_learning_parity as p
out=io.StringIO()
with patch.object(p.Path,'open',side_effect=AssertionError('must_not_open')),patch.object(p.subprocess,'Popen',side_effect=AssertionError('must_not_spawn')),patch.dict(p.os.environ,{},clear=True),redirect_stdout(out):
 code=p.main([])
print(json.dumps({'code':code,'result':json.loads(out.getvalue())}))
`);
  assert.equal(result.code,0);assert.deepEqual(result.result,{version:1,status:'disabled',parity:false});
});

test('missing explicit inputs and malformed bundle JSON never reveal supplied/private content',()=>{
  const result=py(`
import io,json,pathlib,tempfile
from contextlib import redirect_stdout
from scripts import check_learning_parity as p
results=[]
with tempfile.TemporaryDirectory() as tmp:
 path=pathlib.Path(tmp)/'bundle.json'
 for text in ('{"SECRET":1,"SECRET":2}','{"SECRET":NaN}','{"SECRET":1}'):
  path.write_text(text);out=io.StringIO()
  with redirect_stdout(out):code=p.main(['--bundle',str(path),'--engine-checkout',tmp,'--expected-input-id','not-a-pin'])
  results.append({'code':code,'text':out.getvalue()})
 out=io.StringIO()
 with redirect_stdout(out):code=p.main(['--now-utc','2026-10-01T00:00:00Z'])
 results.append({'code':code,'text':out.getvalue()})
print(json.dumps(results))
`);
  assert.equal(result.length,4);
  for(const row of result){assert.equal(row.code,2);assert.ok(!row.text.includes('SECRET'));assert.equal(JSON.parse(row.text).parity,false);}
});

test('bridge refuses partial/tampered diagnostic identities and invalid transport results',()=>{
  const result=py(`
import io,json,pathlib,tempfile
from unittest.mock import patch
from scripts import check_learning_parity as p
value={'namespace':p.NAMESPACE,'analysis':{'snapshot':{k:[] for k in p.PROJECTION_KEYS}}}
pin=p.fingerprint(value);results=[]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);(root/'tools').mkdir();(root/'tools/nfl_review_parity.py').write_text('# test-only trusted-path placeholder')
 path=root/'bundle.json';path.write_text(json.dumps(value))
 for response in ([],{}, {'version':True}, {'version':1,'parity':True}):
  with patch.object(p,'_run',return_value=(0,response)):
   try:p.check(path,engine_checkout=root,expected_input_id=pin,now_utc='2026-10-16T00:00:00Z')
   except (ValueError,KeyError):results.append('held')
 with patch.object(p,'MAX_INPUT',1):
  try:p.check(path,engine_checkout=root,expected_input_id=pin,now_utc='2026-10-16T00:00:00Z')
  except ValueError:results.append('oversized')
print(json.dumps(results))
`);
  assert.deepEqual(result,['held','held','held','held','oversized']);
});

test('actual optional engine bridge checks raw producer identities and never changes legacy review',t=>{
  if(!ENGINE||!existsSync(ENGINE+'/tools/nfl_review_parity.py')){
    t.skip('Explicit SELFLEARN_CHECKOUT required for actual cross-repository acceptance; no engine parity was executed');return;
  }
  const result=py(`
import copy,importlib.util,io,json,pathlib,sys,tempfile
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import check_learning_parity as p,build_review
engine=pathlib.Path(${JSON.stringify(ENGINE)}).resolve()
sys.path.insert(0,str(engine));sys.path.insert(0,str(engine/'packages/selflearn-core'))
spec=importlib.util.spec_from_file_location('parity_fixture',engine/'packages/selflearn-core/tests/test_nfl_review_parity.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
values=f.actual_fixture(pathlib.Path.cwd());value=values[1]
baseline=build_review.build(build_review._fixture_inputs(),'2026-10-01T00:00:00Z')
before=copy.deepcopy(baseline)
with tempfile.TemporaryDirectory() as tmp:
 path=pathlib.Path(tmp)/'bundle.json';path.write_text(json.dumps(value));pin=p.fingerprint(value)
 good=p.check(path,engine_checkout=engine,expected_input_id=pin,now_utc=f.stamp())
 output=io.StringIO()
 with redirect_stdout(output):code=p.main(['--bundle',str(path),'--engine-checkout',str(engine),'--expected-input-id',pin,'--now-utc',f.stamp()])
 held_path=pathlib.Path(tmp)/'void.json';held_path.write_text(json.dumps(values[-1]))
 void=p.check(held_path,engine_checkout=engine,expected_input_id=p.fingerprint(values[-1]),now_utc=f.stamp())
 for attribute,limit in [('MAX_OUTPUT',1),('TIMEOUT',0)]:
  with patch.object(p,attribute,limit):
   try:p.check(path,engine_checkout=engine,expected_input_id=pin,now_utc=f.stamp())
   except ValueError:pass
   else:raise AssertionError(attribute)
 snapshot=value['analysis']['snapshot'];record=snapshot['observation_records'].pop();path.write_text(json.dumps(value))
 try:p.check(path,engine_checkout=engine,expected_input_id=p.fingerprint(value),now_utc=f.stamp())
 except ValueError:held=True
 else:held=False
print(json.dumps({'good':good,'code':code,'held':held,'void':void,'legacy_unchanged':baseline==before,'cli_parity':json.loads(output.getvalue())['parity']}))
`);
  assert.equal(result.code,0);assert.equal(result.cli_parity,true);assert.equal(result.good.parity,true);
  assert.equal(result.good.coverage.graded_contracts,2);assert.equal(result.good.coverage.supplied_observations,8);
  assert.equal(result.good.coverage.supplied_revisions,4);assert.equal(result.good.namespace_authenticated,false);
  assert.equal(result.good.completeness_authenticated,false);assert.equal(result.good.live_review_replaced,false);
  assert.equal(result.held,true);assert.equal(result.legacy_unchanged,true);
  assert.equal(result.void.parity,false);assert.equal(result.void.coverage.graded_contracts,0);
});
