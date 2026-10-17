import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const covered=new Set();let sourceHash;
const FIXTURE=String.raw`
import atexit,copy,hashlib,importlib.util,io,json,os,pathlib,sys,tempfile,urllib.parse
from contextlib import redirect_stdout,redirect_stderr
from unittest.mock import patch
hits=set();target_file=str(pathlib.Path('scripts/run_learning_intake.py').resolve())
def trace(frame,event,arg):
 if event=='line' and frame.f_code.co_filename==target_file:hits.add(frame.f_lineno)
 return trace
sys.settrace(trace)
from scripts import run_learning_intake as I
spec=importlib.util.spec_from_file_location('fixture',pathlib.Path('tests/fixtures/week6_outcomes.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
TOKEN='forecast-fixture-credential-'+'f'*32
OUTCOME='outcome-fixture-credential-'+'o'*32
def coverage():
 sys.settrace(None)
 print('INTAKE_COVERAGE '+json.dumps({'sha256':hashlib.sha256(pathlib.Path(I.__file__).read_bytes()).hexdigest(),'lines':sorted(hits)}),file=sys.stderr)
atexit.register(coverage)
def inputs(root,count=1):
 snapshots=root/'authority'/'forecasts';f.generation(snapshots)
 captures=[f.capture.save_capture(f.bundle(observed=f'2026-09-{3+i:02d}T12:00:00Z'),root/'authority'/f'capture{i}') for i in range(count)]
 return I.plan(snapshots,captures),snapshots,captures
class Server:
 # Real legacy exporter protocol; memory fake, NOT durable SQL evidence.
 def __init__(self):self.calls=[];self.objects={};self.reject=False;self.lose=False
 def __call__(self,route,body):
  request=json.loads(body);self.calls.append((route,request));oid=request['object_id']
  if route==I.forecast.OBJECT_ROUTE:
   status='duplicate' if oid in self.objects else 'recorded';self.objects[oid]=request
   ack={'version':1,'object_id':oid,'durable':True,'status':status}
  else:
   doc=self.objects[oid]['payload']['generations'][0]
   ack={'version':1,'object_id':oid,'durable':True,'receipts':[{'source_receipt_id':rid,'receipt_id':I.forecast.fingerprint({'generic':rid}),'status':'recorded'} for rid in doc['receipt_ids']],'rejections':[]}
   if self.reject:
    row=ack['receipts'].pop();ack['rejections']=[{'source_receipt_id':row['source_receipt_id'],'reason':'invalid_timestamp'}]
   if self.lose:self.lose=False;raise OSError('SECRET_LOST_REPLY')
  return 200,I.forecast.encoded(ack)
def terminal(value,success=True):
 return {'version':2,'status':'terminal_original','application_id':value['request']['application_id'],
  'durable_result_ack':True,'processing_complete':success,'complete_success':success,'learning_accepted':success}
class Outcomes:
 # Explicit composition fake: child v2 protocol is tested in its own suite.
 def __init__(self,steps=0,success=True,pending=False):self.calls=[];self.steps=steps;self.success=success;self.pending=pending
 def __call__(self,value,outdir,token,**kw):
  self.calls.append({'application':value['request']['application_id'],'max_steps':kw['max_steps']})
  for n in range(self.steps):
   aid=value['request']['application_id'];sid=I.outcome.step_id(aid,n)
   path=I.outcome.BASE+'/'+urllib.parse.quote(aid,safe='')+'/steps/'+urllib.parse.quote(sid,safe='')
   try:kw['transport']('POST',path,b'{}')
   except I.outcome.ApplicationBudgetExceeded:return {'status':'pending','learning_accepted':False,'complete_success':False}
  return {'status':'pending','learning_accepted':False,'complete_success':False} if self.pending else terminal(value,self.success)
def run(value,root,server,child,**kw):
 with patch.object(I.outcome,'send',side_effect=child):
  return I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=server,outcome_transport=lambda *a:(200,b'{}'),sleep=lambda _:None,**kw)
def flags(result):return all(result.get(k) is False for k in I.FLAGS)
def saved(root):return ''.join(p.read_text() for p in (root/'delivery').rglob('*.json'))
def refused(fn):
 try:fn()
 except (ValueError,RuntimeError,OSError,TypeError,KeyError):return True
 return False
`;
function py(body){
  const result=spawnSync('python3',['-'],{cwd:ROOT,encoding:'utf8',input:FIXTURE+body,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30000,maxBuffer:8*1024*1024});
  for(const line of result.stderr.split('\n'))if(line.startsWith('INTAKE_COVERAGE ')){
    const record=JSON.parse(line.slice(16));assert.ok(!sourceHash||sourceHash===record.sha256);sourceHash=record.sha256;
    record.lines.forEach(line=>covered.add(line));
  }
  assert.equal(result.status,0,result.stderr+result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('default dry run and explicit preparation read no credentials or network and never change source data',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root);before={str(p):p.read_bytes() for p in (root/'authority').rglob('*') if p.is_file()}
 args=['--snapshots',str(snapshots),'--capture',str(captures[0])];out=io.StringIO();getenv=I.os.environ.get
 def guard(name,*args):
  if name in ('SELFLEARN_NFL_INGEST_TOKEN','SELFLEARN_NFL_OUTCOME_INGEST_TOKEN','SELFLEARN_OPERATOR_TOKEN'):raise AssertionError('credential read')
  return getenv(name,*args)
 with patch.object(I.os.environ,'get',side_effect=guard),patch.object(I.urllib.request,'build_opener',side_effect=AssertionError('network')),redirect_stdout(out):code=I.main(args)
 dry=json.loads(out.getvalue());none=not (root/'delivery').exists();out=io.StringIO()
 with patch.object(I.os.environ,'get',side_effect=guard),redirect_stdout(out):prepared=I.main(args+['--prepare','--out-dir',str(root/'delivery')])
 again=I.prepare(value,root/'delivery')
 print(json.dumps({'code':code,'dry':dry,'none':none,'prepared':prepared,'again':again,
  'unchanged':before=={str(p):p.read_bytes() for p in (root/'authority').rglob('*') if p.is_file()},'files':len(list((root/'delivery').rglob('*.json')))}))
`);
 assert.equal(r.code,0);assert.equal(r.dry.status,'dry_run');assert.equal(r.dry.writes,false);assert.equal(r.dry.network_used,false);
 assert.equal(r.none,true);assert.equal(r.prepared,0);assert.equal(r.again.status,'prepared_only');assert.equal(r.unchanged,true);assert.ok(r.files>=2);
});

test('real forecast ACKs precede every outcome; exact cached proof permits source-free resume and never means learning',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root,2);server=Server();child=Outcomes()
 first=run(value,root,server,child);count=len(server.calls);(root/'authority').rename(root/'unavailable-authority')
 with patch.object(I.forecast,'plan',side_effect=AssertionError('no source reopen')),patch.object(I.outcome.O,'_validated',side_effect=AssertionError('no raw reopen')),patch.object(I.outcome,'send',side_effect=child):
  second=I.resume(root/'delivery',value['run_id'],TOKEN,OUTCOME,forecast_transport=lambda *a:(_ for _ in ()).throw(AssertionError('cached forecasts')),outcome_transport=lambda *a:(200,b'{}'))
 print(json.dumps({'first':first,'second':second,'calls':count,'after':len(server.calls),'children':len(child.calls),'flags':flags(first) and flags(second),'secret_absent':TOKEN not in saved(root) and OUTCOME not in saved(root)}))
`);
 assert.equal(r.first.intake_complete,true);assert.equal(r.second.intake_complete,true);assert.equal(r.first.forecast_complete,true);
 assert.equal(r.calls,5);assert.equal(r.after,5);assert.equal(r.children,4);assert.equal(r.flags,true);assert.equal(r.secret_absent,true);
});

test('newly ACKed forecast vintages do not reinterpret or reapply an old immutable capture result',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root);server=Server();aid=value['capture_plans'][0]['request']['application_id']
 original={**terminal(value['capture_plans'][0]),'current_membership_reverified':False,'original_member_count':2};applications=[]
 def original_child(captured,*args,**kwargs):applications.append(captured['request']['application_id']);return copy.deepcopy(original)
 with patch.object(I.outcome,'send',side_effect=original_child):first=I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=server,outcome_transport=lambda *a:(200,b'{}'))
 f.generation(snapshots,'2026-09-01T13:00:00Z');new=I.plan(snapshots,captures)
 with patch.object(I.outcome,'send',side_effect=original_child):second=I.send(new,root/'delivery',TOKEN,OUTCOME,forecast_transport=server,outcome_transport=lambda *a:(200,b'{}'))
 truth=I.summary(new,'intake_complete',True,current_membership_reverified=True,current_outcome_coverage_verified=True,working_learning_loop=True)
 print(json.dumps({'first':first,'second':second,'same_original':second['capture_results'][0]==original,'applications':applications,
  'aid':aid,'new_run':new['run_id']!=value['run_id'],'receipts':I.forecast_plan_valid(new['forecast_plan'])[0]['receipt_copies'],'truth':flags(truth)}))
`);
 assert.equal(r.new_run,true);assert.equal(r.receipts,4);assert.deepEqual(r.applications,[r.aid,r.aid]);assert.equal(r.same_original,true);
 assert.equal(r.first.intake_complete,true);assert.equal(r.second.intake_complete,true);
 assert.equal(r.second.current_membership_reverified,false);assert.equal(r.second.current_outcome_coverage_verified,false);assert.equal(r.second.working_learning_loop,false);assert.equal(r.truth,true);
});

test('a forged ok summary, partial rejection or malformed ACK can never open outcome staging',()=>{
 const r=py(String.raw`
results=[]
for mode in ('forged_ok','rejection','bad_ack','transport'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);value,_,_=inputs(root);server=Server();child=Outcomes();server.reject=mode=='rejection'
  if mode=='forged_ok':
   with patch.object(I.forecast,'send',return_value={'ok':True,'failures':[],'objects_acked':4,'generations_acked':1,'receipts_acked':2,'receipts_rejected':0}):result=run(value,root,server,child)
  else:
   def channel(route,body):
    if mode=='transport':raise OSError('SECRET')
    status,raw=server(route,body);ack=json.loads(raw)
    if mode=='bad_ack' and route==I.forecast.GENERATION_ROUTE:ack['receipts'].pop()
    return status,I.forecast.encoded(ack)
   result=run(value,root,channel,child,attempts=1)
  results.append({'result':result,'children':len(child.calls),'safe':'SECRET' not in saved(root)})
print(json.dumps(results))
`);
 for(const row of r){assert.equal(row.result.status,'pending_forecasts');assert.equal(row.children,0);assert.equal(row.result.intake_complete,false);assert.equal(row.safe,true);}
});

test('lost forecast finalize reply recovers original ACKs using stable content IDs',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,_,_=inputs(root);server=Server();server.lose=True;child=Outcomes()
 first=run(value,root,server,child,attempts=1);before=len(child.calls);second=run(value,root,server,child,attempts=1)
 finals=[v['object_id'] for route,v in server.calls if route==I.forecast.GENERATION_ROUTE]
 print(json.dumps({'first':first,'second':second,'before':before,'finals':finals,'safe':'SECRET' not in saved(root)}))
`);
 assert.equal(r.first.status,'pending_forecasts');assert.equal(r.before,0);assert.equal(r.second.intake_complete,true);assert.equal(r.finals.length,2);assert.equal(r.finals[0],r.finals[1]);assert.equal(r.safe,true);
});

test('missing or corrupted original cached ACKs cannot reuse a forecast-complete marker',()=>{
 const r=py(String.raw`
results=[]
for mode in ('missing','corrupt','conflict'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);value,_,_=inputs(root);server=Server();child=Outcomes();run(value,root,server,child);child.calls.clear()
  _,target=I.paths(value,root/'delivery');ack=next((target/'forecasts').rglob('acks/*.json'))
  if mode=='missing':ack.unlink()
  elif mode=='corrupt':ack.write_text('{}')
  else:
   rec=json.loads(ack.read_text());failure={'operation':rec['operation'],'reason':'immutable_delivery_conflict'}
   path=ack.parent.parent/'failures'/(I.forecast.fingerprint(failure)[7:]+'.json');path.parent.mkdir();path.write_text(json.dumps(failure))
  result=run(value,root,server,child)
  results.append({'status':result['status'],'children':len(child.calls)})
print(json.dumps(results))
`);
 for(const row of r){assert.equal(row.status,'pending_forecasts');assert.equal(row.children,0);}
});

test('one shared step allowance spans all captures while GET-only original recovery remains available',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,_,_=inputs(root,2);server=Server();child=Outcomes(steps=1)
 first=run(value,root,server,child,max_steps=1);calls=copy.deepcopy(child.calls)
 recovered=Outcomes(steps=0);second=run(value,root,server,recovered,max_steps=1)
 print(json.dumps({'first':first,'second':second,'calls':calls,'flags':flags(first) and flags(second)}))
`);
 assert.equal(r.first.status,'pending_outcomes');assert.equal(r.first.steps_issued,1);assert.equal(r.first.capture_results.length,2);
 assert.deepEqual(r.calls.map(c=>c.max_steps),[1,1]);assert.equal(r.second.intake_complete,true);assert.equal(r.second.steps_issued,0);assert.equal(r.flags,true);
});

test('an exhausted step allowance permits original GET recovery but cannot stage another capture',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,_,_=inputs(root,2);server=Server();calls=[];attempts=[]
 def child(captured,outdir,token,**kw):
  calls.append(captured['request']['application_id'])
  if len(calls)==1:
   path=I.outcome.BASE+'/'+urllib.parse.quote(calls[-1],safe='')+'/steps/'+urllib.parse.quote(I.outcome.step_id(calls[-1],0),safe='')
   kw['transport']('POST',path,b'{}');return terminal(captured)
  try:kw['transport']('POST',I.outcome.O.CHUNK_ROUTE,I.outcome.O._body(I.outcome.O._chunk(b'local-test-bytes')))
  except I.outcome.ApplicationBudgetExceeded:return {'status':'pending','learning_accepted':False,'complete_success':False}
  raise AssertionError('No new chunk may reach transport')
 def channel(method,path,body):attempts.append((method,path));return 200,b'{}'
 with patch.object(I.outcome,'send',side_effect=child):result=I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=server,outcome_transport=channel,max_steps=1)
 print(json.dumps({'result':result,'calls':len(calls),'transports':len(attempts)}))
`);
 assert.equal(r.result.status,'pending_outcomes');assert.equal(r.result.steps_issued,1);assert.equal(r.calls,2);assert.equal(r.transports,1);
});

test('pending or durable incomplete outcomes stop the ordered run without staging a later capture',()=>{
 const r=py(String.raw`
results=[]
for mode in ('pending','incomplete','invalid'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);value,_,_=inputs(root,2);server=Server();child=Outcomes(pending=mode=='pending',success=mode!='incomplete')
  if mode=='invalid':
   with patch.object(I.outcome,'send',return_value={'status':'not_original'}):result=I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=server,outcome_transport=lambda *a:(200,b'{}'))
  else:result=run(value,root,server,child)
  results.append({'result':result,'children':len(child.calls),'flags':flags(result)})
print(json.dumps(results))
`);
 assert.deepEqual(r.map(v=>v.result.status),['pending_outcomes','terminal_incomplete','pending_outcomes']);
 assert.equal(r[0].children,1);assert.equal(r[1].children,1);assert.ok(r.every(v=>!v.result.intake_complete&&v.flags));
});

test('global command deadline bypasses legacy retries and no late forecast reply becomes a gate',()=>{
 const r=py(String.raw`
results=[]
for mode in ('late','sleep','already_expired'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);value,_,_=inputs(root);server=Server();child=Outcomes();clock=[0]
  def monotonic():
   if mode=='already_expired':clock[0]+=2
   return clock[0]
  def channel(route,body):
   if mode=='sleep':return 503,b''
   result=server(route,body);clock[0]=2;return result
  def sleep(seconds):clock[0]=2
  with patch.object(I.outcome,'send',side_effect=child):result=I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=channel,outcome_transport=lambda *a:(200,b'{}'),sleep=sleep,monotonic=monotonic,max_run_seconds=1)
  results.append({'result':result,'calls':len(server.calls),'children':len(child.calls)})
print(json.dumps(results))
`);
 for(const row of r){assert.equal(row.result.status,'pending_forecasts');assert.equal(row.result.reason,'intake_command_budget');assert.equal(row.children,0);assert.ok(row.calls<=1);}
});

test('source tamper, duplicate captures, unsupported periods, output overlaps and symlinks fail closed',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root);results=[]
 results.append(refused(lambda:I.plan(snapshots,captures*2)))
 results.append(refused(lambda:I.plan(snapshots,captures,'https://evil.invalid')))
 for path in (snapshots,root/'authority',I._ROOT,I._ROOT/'data'/'out',root):results.append(refused(lambda:I.prepare(value,path)))
 link=root/'redirect';link.symlink_to(root/'authority',target_is_directory=True);results.append(refused(lambda:I.prepare(value,link/'output')))
 link2=root/'source-link';link2.symlink_to(snapshots,target_is_directory=True);results.append(refused(lambda:I.plan(link2,captures)))
 changed=copy.deepcopy(value);changed['forecast_plan']['source_objects'][0]['payload']={};results.append(refused(lambda:I.validate_plan(changed)))
 changed=copy.deepcopy(value);changed['capture_plans'][0]['request']['capture_request']['envelope']['manifest']['weeks']=[5];results.append(refused(lambda:I.validate_plan(changed)))
 source=next((snapshots/'learning_sources').glob('*.json'));source.write_text('{}');results.append(refused(lambda:I.prepare(value,root/'delivery')))
 print(json.dumps(results))
`);
 assert.ok(r.every(Boolean));assert.ok(r.length>=10);
});

test('canonical-but-wrong forecast period, exact population ceilings and bounded record reads are enforced',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root);results=[]
 changed=copy.deepcopy(value);p=changed['forecast_plan'];entry=p['generations'][0];doc=entry['request']['payload'];g=doc['generations'][0]
 doc['week']=g['week']=5;g['generation_id']=I.forecast.fingerprint({k:g[k] for k in I.forecast.MANIFEST_KEYS})
 for row in doc['receipts']:row['generation_id']=g['generation_id']
 doc['envelope_id']=I.forecast.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'});entry['request']['object_id']=doc['envelope_id']
 changed['forecast_plan_id']=I.forecast.fingerprint(p);changed['run_id']=I.forecast.fingerprint({k:v for k,v in changed.items() if k!='run_id'})
 try:I.validate_plan(changed)
 except I.IntakeError as e:results.append(str(e)=='intake_forecast_period_missing')
 else:results.append(False)
 results.append(refused(lambda:I.plan(snapshots,[captures[0]]*17)))
 for field,count in [('source_objects',1025),('generations',257)]:
  p=copy.deepcopy(value['forecast_plan']);p[field]=[p[field][0]]*count;results.append(refused(lambda:I.forecast_plan_valid(p)))
 p=copy.deepcopy(value['forecast_plan']);p['generations']=[];results.append(refused(lambda:I.forecast_plan_valid(p)))
 path=root/'record.json';results.append(refused(lambda:I.bounded_read(path,10)))
 for text,limit in [('{bad',10),('{}',1)]:path.write_text(text);results.append(refused(lambda:I.bounded_read(path,limit)))
 path.write_text('{}');results.append(I.bounded_read(path,2)=={})
 print(json.dumps(results))
`);
 assert.equal(r.length,9);assert.ok(r.every(Boolean));
});

test('strict metadata/resource/credential guards and immutable run conflict never initiate HTTP',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,_,_=inputs(root);results=[]
 for key,replacement in [('version',True),('extra',1),('run_id','wrong'),('capture_plans',[]),('forecast_plan_id','wrong')]:
  changed=copy.deepcopy(value);changed[key]=replacement;results.append(refused(lambda:I.validate_plan(changed)))
 for tokens in ((None,OUTCOME),(TOKEN,TOKEN),(TOKEN,'short'),('has space'+'x'*32,OUTCOME)):
  results.append(refused(lambda:I.send(value,root/'delivery',*tokens)))
 for kw in ({'attempts':True},{'max_steps':0},{'max_steps':2001},{'max_run_seconds':float('nan')},{'max_run_seconds':301}):results.append(refused(lambda:I.send(value,root/'delivery',TOKEN,OUTCOME,**kw)))
 with patch.object(I,'MAX_PLAN_BYTES',1):results.append(refused(lambda:I.validate_plan(value)))
 with patch.object(I,'MAX_CAPTURES',0):results.append(refused(lambda:I.plan(value['forecast_plan']['snapshot_dir'],['not-opened'])))
 I.prepare(value,root/'delivery');_,target=I.paths(value,root/'delivery');(target/'run.json').write_text('{}');results.append(refused(lambda:I.prepare(value,root/'delivery')))
 print(json.dumps(results))
`);
 assert.ok(r.every(Boolean));
});

test('ordinary injected exceptions including legacy ExportError never leak into reports or outboxes; cancellation propagates',()=>{
 const r=py(String.raw`
results=[]
for error in (RuntimeError('SECRET_CALLBACK'),I.forecast.ExportError('SECRET_CALLBACK'),KeyboardInterrupt(),SystemExit()):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);value,_,_=inputs(root);child=Outcomes()
  def channel(*args):raise error
  try:result=run(value,root,channel,child)
  except (KeyboardInterrupt,SystemExit):result={'cancelled':True}
  results.append({'result':result,'safe':'SECRET_CALLBACK' not in saved(root),'children':len(child.calls)})
print(json.dumps(results))
`);
 assert.equal(r[0].result.status,'pending_forecasts');assert.equal(r[1].result.status,'pending_forecasts');
 assert.equal(r[2].result.cancelled,true);assert.equal(r[3].result.cancelled,true);assert.ok(r.every(v=>v.safe&&v.children===0));
});

test('fixed forecast transport validates before credentials and bounds actual reads, retries, redirects and deadline',()=>{
 const r=py(String.raw`
class Response:
 status=200
 def __init__(self,raw=b'{}',url=None,late=None):self.raw=raw;self.url=url or I.ORIGIN+I.forecast.GENERATION_ROUTE;self.late=late
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def geturl(self):return self.url
 def read1(self,n):
  value,self.raw=self.raw[:n],self.raw[n:]
  if self.late:self.late()
  return value
class Opener:
 def __init__(self,response):self.response=response;self.calls=[]
 def open(self,request,timeout):
  self.calls.append((request.full_url,request.headers['Authorization'],timeout))
  if isinstance(self.response,Exception):raise self.response
  return self.response
body=I.forecast.encoded({'version':1,'object_id':I.forecast.fingerprint('operation')});results=[]
for response in (Response(),Response(url='https://evil.invalid'),Response(raw=b'x'*(I.forecast.MAX_BODY_BYTES+1)),I.urllib.error.HTTPError('https://safe.invalid',503,'SECRET',{},io.BytesIO(b''))):
 opener=Opener(response)
 with patch.object(I.urllib.request,'build_opener',return_value=opener):
  channel=I.forecast_http_transport(TOKEN,10,lambda:0)
  for path,data in [('https://evil.invalid',body),(I.forecast.GENERATION_ROUTE,None),(I.forecast.GENERATION_ROUTE,b'{}'),(I.forecast.OBJECT_ROUTE,body)]:results.append(refused(lambda:channel(path,data)))
  try:status,raw=channel(I.forecast.GENERATION_ROUTE,body);results.append(status in (200,503))
  except ValueError:results.append(True)
 results.append(len(opener.calls)==1 and opener.calls[0][0]==I.ORIGIN+I.forecast.GENERATION_ROUTE and opener.calls[0][2]==10)
clock=[0];opener=Opener(Response(late=lambda:clock.__setitem__(0,2)))
with patch.object(I.urllib.request,'build_opener',return_value=opener):
 channel=I.forecast_http_transport(TOKEN,1,lambda:clock[0]);results.append(refused(lambda:channel(I.forecast.GENERATION_ROUTE,body)))
 clock[0]=2;results.append(refused(lambda:channel(I.forecast.GENERATION_ROUTE,body)));results.append(len(opener.calls)==1)
print(json.dumps(results))
`);
 assert.ok(r.every(Boolean));
});

test('CLI explicit send/resume paths are sanitized and return pending or terminal-incomplete exit codes',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=inputs(root);args=['--snapshots',str(snapshots),'--capture',str(captures[0]),'--out-dir',str(root/'delivery'),'--send'];results=[]
 for status,code in [('pending_forecasts',1),('terminal_incomplete',3),('intake_complete',0)]:
  report=I.summary(value,status,status=='intake_complete');out=io.StringIO()
  with patch.dict(I.os.environ,{'SELFLEARN_NFL_INGEST_TOKEN':TOKEN,'SELFLEARN_NFL_OUTCOME_INGEST_TOKEN':OUTCOME}),patch.object(I,'send',return_value=report),redirect_stdout(out):actual=I.main(args)
  results.append(actual==code and flags(json.loads(out.getvalue())))
 out=io.StringIO()
 with patch.object(I,'resume',return_value=I.summary(value,'intake_complete',True)),redirect_stdout(out):results.append(I.main(['--send','--resume',value['run_id'],'--out-dir',str(root/'delivery')])==0)
 for bad in ([],['--resume',value['run_id']],args+['--base-url','https://evil.invalid']):
  err=io.StringIO()
  with redirect_stderr(err):results.append(I.main(bad)==1 and 'SECRET' not in err.getvalue())
 err=io.StringIO()
 try:
  with redirect_stderr(err):I.main(['--SECRET_ARGUMENT'])
 except SystemExit as e:results.append(e.code==2 and 'SECRET_ARGUMENT' not in err.getvalue())
 results.append(refused(lambda:I.resume(root/'delivery','wrong',TOKEN,OUTCOME)))
 print(json.dumps(results))
`);
 assert.ok(r.every(Boolean));
});

after(()=>{
 const inventory=spawnSync('python3',['-'],{cwd:ROOT,encoding:'utf8',input:String.raw`
import dis,hashlib,json,pathlib,types
p=pathlib.Path('scripts/run_learning_intake.py');code=compile(p.read_bytes(),str(p.resolve()),'exec');lines=set()
def visit(c):
 lines.update(line for _,line in dis.findlinestarts(c) if line>0)
 for value in c.co_consts:
  if isinstance(value,types.CodeType):visit(value)
visit(code)
print(json.dumps({'lines':sorted(lines),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
`});
 assert.equal(inventory.status,0,inventory.stderr);const executable=JSON.parse(inventory.stdout);assert.equal(sourceHash,executable.sha256);
 const hit=executable.lines.filter(line=>covered.has(line));
 console.log(JSON.stringify({kind:'actual_executable_line_trace',file:'scripts/run_learning_intake.py',sha256:sourceHash,
   covered:hit.length,total:executable.lines.length,percent:100*hit.length/executable.lines.length,
   uncovered:executable.lines.filter(line=>!covered.has(line)),scope:'local_composition_fakes_no_SQL_or_remote_sends'}));
});
