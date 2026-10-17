import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = ROOT + 'scripts/export_outcome_capture.py';
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import base64,copy,hashlib,http.client,io,json,os,pathlib,runpy,sys,tempfile,threading,urllib.error
from contextlib import redirect_stdout,redirect_stderr
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from scripts import export_outcome_capture as O, export_learning as ex, capture_outcome_evidence as C
f=runpy.run_path('tests/fixtures/week6_outcomes.py')
TOKEN='synthetic-outcome-only-not-owner-or-generation'
def fixture(root,large=False):
 bundle=f['bundle'](stats_rows=[f['stats_row']()]*33000) if large else f['bundle']()
 path=C.save_capture(bundle,root/'capture-authority');return O.plan(path,O.ORIGIN),bundle,path
def group(tag='a',held=False):
 scope=[2026,'G1','espn-fixture-'+tag,'wr_rec_yds','home']
 value={'scope':scope,'receipt_ids':sorted(ex.fingerprint('generic-'+tag+str(n))for n in range(2)),
  'source_receipt_ids':sorted(ex.fingerprint('source-'+tag+str(n))for n in range(2)),
  'generation_object_ids':[ex.fingerprint('generation-'+tag)]}
 return {'group_id':ex.fingerprint(scope),**value,'membership_id':ex.fingerprint({'binding_policy':O.POLICY,**value}),
  'status':'withheld'if held else'accepted','reason_codes':['missing_measurement']if held else[],
  'observation_ids':[]if held else sorted(ex.fingerprint('obs-'+tag+str(n))for n in range(2)),
  'revision_ids':[]if held else ['revision-'+tag+'0','revision-'+tag+'1']}
def result(request,groups=None):
 groups=[group()]if groups is None else groups
 n=sum(len(g['observation_ids'])for g in groups);r=sum(len(g['revision_ids'])for g in groups)
 status='no_supported_membership'if not groups else'accepted'if all(g['status']=='accepted'for g in groups)else'partial'if any(g['status']=='accepted'for g in groups)else'withheld'
 return {'version':1,'kind':'nfl.capture_delivery_result.v1','delivery_id':request['delivery_id'],'request_id':ex.fingerprint(request),
  'capture_id':request['capture_id'],'membership_id':ex.fingerprint({'binding_policy':O.POLICY,'groups':[g['membership_id']for g in groups]}),
  'status':status,'groups':groups,'added_observations':n,'added_revisions':r,'input_watermark':'10','watermark':str(10+n+r),
  'delivery_seq':'1','recorded_utc':'2026-09-03T14:00:00Z','durable':True,'scope':'observations_and_group_results','source_authentication':'not_performed'}
class Server:
 def __init__(self):self.calls=[];self.original=None;self.lose=False;self.groups=None;self.lock=threading.Lock()
 def __call__(self,method,route,body):
  with self.lock:
   self.calls.append((method,route,body))
   if method=='GET':return (404,b'')if self.original is None else(200,ex.encoded(self.original))
   q=ex._json(body)
   if route==O.CHUNK_ROUTE:
    raw=base64.b64decode(q['data'],validate=True);assert O._raw_hash(raw)==q['chunk_id']and len(raw)==q['raw_bytes']
    return 200,ex.encoded({'version':1,'kind':'selflearn.evidence_stage.v1','scope':'uploaded_only','bucket':'private-fixture',
     'key':'private/not-a-fetch-url','chunk_id':q['chunk_id'],'raw_bytes':q['raw_bytes'],'learning_accepted':False,'durable_ack':False})
   assert route==O.DELIVERY_ROUTE
   if self.original is None:self.original=result(q,self.groups)
   if self.lose:self.lose=False;raise TimeoutError('private-lost-reply-detail')
   return 200,ex.encoded({'version':1,'status':'recorded_or_recovered','attempts':1,'result':self.original,'scope':'internal_delivery_results_only'})
def send(value,root,server,**kw):return O.send(value,root,TOKEN,transport=server,sleep=lambda _:None,**kw)
def error(fn):
 try:fn()
 except Exception as e:return str(e)if isinstance(e,O.OutcomeExportError)else type(e).__name__
 return None
`;
function py(body) {
  const wrapper = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/export_outcome_capture.py').resolve());LINES=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return traced\nsys.settrace(traced)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, input: wrapper, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 20 * 1024 * 1024 }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('verified dry-run reads no outcome credential, sends nothing, writes nothing and preserves raw observations', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);before={str(x):x.read_bytes()for x in(root/'capture-authority').rglob('*')if x.is_file()}
 get=os.environ.get
 def env(key,*args):
  assert not key.startswith('SELFLEARN');return get(key,*args)
 stream=io.StringIO()
 with mock.patch.object(os.environ,'get',side_effect=env),mock.patch.object(O,'http_transport',side_effect=AssertionError('no network')),redirect_stdout(stream):
  code=O.main(['--capture',str(path),'--base-url',O.ORIGIN,'--out-dir',str(root/'unused')])
 print(json.dumps({'code':code,'report':json.loads(stream.getvalue()),'written':(root/'unused').exists(),
  'unchanged':before=={str(x):x.read_bytes()for x in(root/'capture-authority').rglob('*')if x.is_file()},
  'exact_manifest':p['request']['envelope']['manifest']==b['manifest'],'no_fragmentation':p['fragmentation_allowed']is False}))
`);
  assert.equal(out.code, 0); assert.equal(out.report.mode, 'dry_run'); assert.equal(out.report.network_used, false);
  assert.equal(out.report.learning_ack, false); assert.equal(out.written, false);
  assert.equal(out.unchanged, true); assert.equal(out.exact_manifest, true); assert.equal(out.no_fragmentation, true);
});

test('canonical1MiB raw chunks keep each body below3MiB; pointers and staged-only ACKs cannot imply learning', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root,large=True);server=Server();r=send(p,root/'delivery',server)
 bodies=[body for method,route,body in server.calls if route==O.CHUNK_ROUTE]
 reconstructed={}
 for pointer in p['request']['raw_pointers']:
  byid={ex._json(body)['chunk_id']:base64.b64decode(ex._json(body)['data'])for body in bodies}
  raw=b''.join(byid[x['chunk_id']]for x in pointer['chunks']);reconstructed[pointer['object_id']]=raw
 staged=[ex._json(x.read_bytes())for x in(root/'delivery').rglob('staging/*.json')]
 print(json.dumps({'status':r['status'],'learning_ack':r['learning_ack'],'bytes':p['raw_bytes'],'max_body':max(map(len,bodies)),
  'full_chunk':any(ex._json(body)['raw_bytes']==O.CHUNK_BYTES for body in bodies),'raw_exact':reconstructed==b['raw_objects'],
  'staging':staged,'sources':len(p['request']['raw_pointers']),'delivery_posts':sum(route==O.DELIVERY_ROUTE and method=='POST'for method,route,body in server.calls)}))
`);
  assert.equal(out.status, 'original_result'); assert.equal(out.learning_ack, true);
  assert.ok(out.bytes > 1024 * 1024); assert.ok(out.max_body < 3 * 1024 * 1024); assert.equal(out.full_chunk, true);
  assert.equal(out.raw_exact, true); assert.equal(out.sources, 3); assert.equal(out.delivery_posts, 1);
  assert.ok(out.staging.every(ack => ack.learning_accepted === false && ack.durable_ack === false && !('bucket' in ack) && !('key' in ack)));
});

test('lost commit reply recovers exact original ledger result; replay never reinterprets a newer membership', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server();server.lose=True
 first=send(p,root/'delivery',server);original=copy.deepcopy(first['result']);n=len(server.calls)
 server.groups=[group(),group('new')]
 second=send(p,root/'delivery',server)
 prepared=O.prepare(p,root/'prepared-only')
 print(json.dumps({'first':first,'second_same':second['result']==original,'replay_methods':[x[0]for x in server.calls[n:]],
  'posts':sum(method=='POST'and route==O.DELIVERY_ROUTE for method,route,body in server.calls),'prepared':prepared}))
`);
  assert.equal(out.first.status, 'original_result'); assert.equal(out.first.current_membership_reverified, false);
  assert.equal(out.second_same, true); assert.deepEqual(out.replay_methods, ['GET']); assert.equal(out.posts, 1);
  assert.equal(out.prepared.network_used, false); assert.equal(out.prepared.learning_ack, false);
});

test('durable withheld/empty/partial results remain explicit holds, not whole-capture learning success', () => {
  const out = py(`
reports=[];codes=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root)
 for index,groups in enumerate(([],[group(held=True)],[group(),group('b',True)])):
  server=Server();server.groups=groups;reports.append(send(p,root/str(index),server));stream=io.StringIO()
  with mock.patch.object(O,'http_transport',return_value=server),mock.patch.dict(os.environ,{'SELFLEARN_NFL_OUTCOME_INGEST_TOKEN':TOKEN}),redirect_stdout(stream):
   codes.append(O.main(['--capture',str(path),'--base-url',O.ORIGIN,'--send','--out-dir',str(root/str(index))]))
 print(json.dumps({'reports':reports,'codes':codes}))
`);
  assert.deepEqual(out.codes, [3, 3, 3]);
  assert.ok(out.reports.every(r => r.status === 'original_result' && r.durable_result_ack && !r.complete_success && !r.current_membership_reverified));
  assert.deepEqual(out.reports.map(r => r.learning_ack), [false, false, true]);
  assert.deepEqual(out.reports.map(r => r.accepted_groups), [0, 0, 1]);
});

test('quota503/413, missing chunks and malformed staging responses leave immutable pending, never commit or ACK', () => {
  const out = py(`
reports={}
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root)
 for kind in('quota503','quota413','staging_true','bad_chunk','big_response','bad_json','bad_status','redirect','callback_secret'):
  server=Server()
  def transport(method,route,body):
   if method=='GET':return 404,b''
   assert route==O.CHUNK_ROUTE
   if kind=='quota503':return 503,b'SECRET-quota'
   if kind=='callback_secret':raise O.OutcomeExportError(TOKEN)
   if kind=='quota413':return 413,b'SECRET-budget'
   if kind=='big_response':return 200,b'x'*(O.BODY_BYTES+1)
   if kind=='bad_json':return 200,b'{"x":1,"x":2}'
   if kind=='bad_status':return True,b''
   if kind=='redirect':return 302,b'SECRET-location'
   status,raw=server(method,route,body);ack=ex._json(raw)
   if kind=='staging_true':ack['durable_ack']=True
   if kind=='bad_chunk':ack['chunk_id']=ex.fingerprint('wrong')
   return status,ex.encoded(ack)
  report=send(p,root/kind,transport,attempts=2);reports[kind]=report
 print(json.dumps({'reports':reports,'pending_files':all(list((root/k).rglob('outbox/*.json'))for k in reports),
  'no_results':not list(root.rglob('results/*.json')),'redacted':'SECRET'not in json.dumps(reports)and TOKEN not in ''.join(x.read_text()for x in root.rglob('*.json'))}))
`);
  assert.ok(Object.values(out.reports).every(r => r.status === 'pending' && r.learning_ack === false));
  assert.equal(out.pending_files, true); assert.equal(out.no_results, true); assert.equal(out.redacted, true);
});

test('whole capture refusal is never fragmented; bounded retry reuses the exact presend request and queries original first', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server();seen=[]
 def refused(method,route,body):
  if route==O.DELIVERY_ROUTE:seen.append(body);return 413,b'unsupported whole membership'
  return server(method,route,body)
 held=send(p,root/'held',refused);server=Server();posts=[]
 def retry(method,route,body):
  if method=='POST'and route==O.DELIVERY_ROUTE:
   posts.append(body)
   if len(posts)==1:return 429,b''
  return server(method,route,body)
 recovered=send(p,root/'retry',retry,attempts=2)
 exhausted=send(p,root/'exhausted',lambda method,route,body:(404,b'')if method=='GET'else(500,b''),attempts=1)
 print(json.dumps({'held':held,'held_posts':len(seen),'request_exact':seen[0]==ex.encoded(p['request']),
  'recovered':recovered['status'],'same_retry':posts[0]==posts[1],'exhausted':exhausted}))
`);
  assert.equal(out.held.status, 'pending'); assert.equal(out.held.learning_ack, false); assert.equal(out.held_posts, 1);
  assert.equal(out.request_exact, true); assert.equal(out.recovered, 'original_result'); assert.equal(out.same_retry, true);
  assert.equal(out.exhausted.status, 'pending');
});

test('unexpected transport/protocol/factory exceptions are redacted without retry; cancellation still propagates', () => {
  const out = py(`
reports=[];cli=[];attempts=[];cancellation=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root)
 failures=[Exception('SYNTHETIC-SECRET'),RuntimeError('SYNTHETIC-SECRET'),http.client.BadStatusLine('SYNTHETIC-SECRET'),http.client.IncompleteRead(b'SYNTHETIC-SECRET')]
 for index,failure in enumerate(failures):
  calls=[]
  def broken(*args):calls.append(1);raise failure
  reports.append(send(p,root/str(index),broken,attempts=3));attempts.append(len(calls));stream=io.StringIO();err=io.StringIO()
  with mock.patch.dict(os.environ,{'SELFLEARN_NFL_OUTCOME_INGEST_TOKEN':TOKEN}),mock.patch.object(O,'http_transport',side_effect=failure),redirect_stdout(stream),redirect_stderr(err):
   code=O.main(['--capture',str(path),'--base-url',O.ORIGIN,'--send','--out-dir',str(root/('cli'+str(index)))])
  cli.append({'code':code,'output':stream.getvalue()+err.getvalue()})
 stream=io.StringIO()
 with mock.patch.object(O,'plan',side_effect=Exception('SYNTHETIC-SECRET')),redirect_stderr(stream):
  guard=O.main(['--capture',str(path),'--base-url',O.ORIGIN])
 for cancel in(KeyboardInterrupt(),SystemExit(7)):
  def cancelled(*args):raise cancel
  try:send(p,root/'cancel',cancelled)
  except BaseException as error:cancellation.append(type(error).__name__)
 audit=''.join(x.read_text()for x in root.rglob('failures/*.json'))
 print(json.dumps({'reports':reports,'cli':cli,'attempts':attempts,'guard':guard,'guard_output':stream.getvalue(),
  'cancellations':cancellation,'redacted':'SYNTHETIC-SECRET'not in json.dumps(reports+cli)and'SYNTHETIC-SECRET'not in audit,
  'audits':len(list(root.rglob('failures/*.json')))}))
`);
  assert.ok(out.reports.every(r => r.status === 'pending' && !r.learning_ack && r.reason === 'outcome_transport_failed'));
  assert.deepEqual(out.attempts, [1, 1, 1, 1]); assert.ok(out.cli.every(r => r.code === 1));
  assert.equal(out.guard, 1); assert.ok(!out.guard_output.includes('SYNTHETIC-SECRET'));
  assert.deepEqual(out.cancellations, ['KeyboardInterrupt', 'SystemExit']); assert.equal(out.redacted, true); assert.equal(out.audits, 8);
});

test('malformed delivery wrappers and malformed GET originals cannot manufacture an acknowledged result', () => {
  const out = py(`
reports={}
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root)
 for kind in('get_wrong','version','missing','wrong_status','wrong_scope','bad_attempts','result_identity'):
  server=Server()
  def transport(method,route,body):
   if kind=='get_wrong'and method=='GET':return 200,ex.encoded({'durable':True})
   status,raw=server(method,route,body)
   if route==O.DELIVERY_ROUTE and method=='POST':
    wrapper=ex._json(raw)
    if kind=='version':wrapper['version']=True
    if kind=='missing':wrapper.pop('attempts')
    if kind=='wrong_status':wrapper['status']='staged'
    if kind=='wrong_scope':wrapper['scope']='learning_complete'
    if kind=='bad_attempts':wrapper['attempts']=True
    if kind=='result_identity':wrapper['result']['delivery_id']=ex.fingerprint('foreign')
    raw=ex.encoded(wrapper)
   return status,raw
  reports[kind]=send(p,root/kind,transport)
 print(json.dumps({'all_pending':all(r['status']=='pending'and r['learning_ack']is False for r in reports.values()),'results':len(list(root.rglob('results/*.json')))}))
`);
  assert.equal(out.all_pending, true); assert.equal(out.results, 0);
});

test('durable original result validates exact IDs, typed whole-group closure, status, bounds and immutable membership', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 p,b,path=fixture(pathlib.Path(tmp));request=p['request'];good=result(request);errors={}
 for kind in('version','keys','durable','scope','sourceauth','identity','digest','time','early','groups','groupkeys','scopebool','scopeperiod','market','side','groupid','emptyids','boolids','unsortedids','mapping','memberhash','reasons','reasonshape','status','proofclosure','heldwrites','too_many_revs','duplicates','membership','overallstatus','countbool','countlarge','seq','seqzero','regress','unchanged'):
  v=copy.deepcopy(good);g=v['groups'][0]
  if kind=='version':v['version']=True
  if kind=='keys':v['extra']='SECRET'
  if kind=='durable':v['durable']=False
  if kind=='scope':v['scope']='staged'
  if kind=='sourceauth':v['source_authentication']='verified'
  if kind=='identity':v['request_id']=ex.fingerprint('different')
  if kind=='digest':v['capture_id']='not-hash'
  if kind=='time':v['recorded_utc']='SECRET'
  if kind=='early':v['recorded_utc']='2026-01-01T00:00:00Z'
  if kind=='groups':v['groups']={}
  if kind=='groupkeys':g.pop('reason_codes')
  if kind=='scopebool':g['scope'][0]=True
  if kind=='scopeperiod':g['scope'][0]=2025
  if kind=='market':g['scope'][3]='unknown'
  if kind=='side':g['scope'][4]='none'
  if kind=='groupid':g['group_id']=ex.fingerprint('other')
  if kind=='emptyids':g['receipt_ids']=[]
  if kind=='boolids':g['receipt_ids']=[True]
  if kind=='unsortedids':g['receipt_ids'].reverse()
  if kind=='mapping':g['source_receipt_ids'].pop()
  if kind=='memberhash':g['membership_id']=ex.fingerprint('other')
  if kind=='reasons':g['reason_codes']=['reason']
  if kind=='reasonshape':g['reason_codes']=[True]
  if kind=='status':g['status']='unknown'
  if kind=='proofclosure':g['observation_ids'].pop()
  if kind=='heldwrites':g['status']='withheld';g['reason_codes']=['reason']
  if kind=='too_many_revs':g['revision_ids'].append('revision-z')
  if kind=='duplicates':v['groups'].append(copy.deepcopy(g))
  if kind=='membership':v['membership_id']=ex.fingerprint('other')
  if kind=='overallstatus':v['status']='partial'
  if kind=='countbool':v['added_observations']=True
  if kind=='countlarge':v['added_revisions']=99
  if kind=='seq':v['watermark']='01'
  if kind=='seqzero':v['delivery_seq']='0'
  if kind=='regress':v['watermark']='9'
  if kind=='unchanged':v['watermark']=v['input_watermark']
  errors[kind]=error(lambda:O._result(v,request))
 valid=[]
 for groups in([], [group(held=True)],[group(),group('b',True)]):valid.append(O._result(result(request,groups),request)['status'])
 print(json.dumps({'all_rejected':all(errors.values()),'valid':valid,'errors':errors}))
`);
  assert.equal(out.all_rejected, true); assert.deepEqual(out.valid, ['no_supported_membership', 'withheld', 'partial']);
});

test('root/ancestor/nested/file symlinks and authority overlap cannot redirect writes; changed capture/plan cannot send', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);target=root/'untouched';target.mkdir();selected=root/'selected';selected.symlink_to(target,target_is_directory=True)
 errors=[error(lambda:O.prepare(p,selected)),error(lambda:O.prepare(p,selected/'nested')),
  error(lambda:O.prepare(p,path.parent.parent)),error(lambda:O.prepare(p,root)),error(lambda:O.prepare(p,O._ROOT)),error(lambda:O.prepare(p,O._ROOT/'data'/'forbidden'))]
 dest=root/'nested';sub=dest/p['request']['destination_id'][7:];sub.parent.mkdir();sub.symlink_to(target,target_is_directory=True)
 errors.append(error(lambda:O.prepare(p,dest)))
 bad=copy.deepcopy(p);bad['raw_bytes']+=1;errors.append(error(lambda:O.prepare(bad,root/'bad')))
 errors.append(error(lambda:O.plan(selected/'not-a-capture',O.ORIGIN)))
 raw=next((path.parent.parent/'objects').glob('*.bin'));raw.write_bytes(b'tampered')
 errors.append(error(lambda:O.prepare(p,root/'changed')))
 errors.extend([error(lambda:O._validated(None)),error(lambda:O._validated({}))])
 print(json.dumps({'errors':errors,'target_empty':not list(target.iterdir()),'no_new_authority':not(root/'changed').exists()}))
`);
  assert.ok(out.errors.every(Boolean)); assert.equal(out.target_empty, true); assert.equal(out.no_new_authority, true);
});

test('concurrent duplicate sends preserve one exact original result; contradictory stored ACK makes a sticky failure', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server();output=root/'delivery'
 with ThreadPoolExecutor(max_workers=2)as pool:reports=list(pool.map(lambda _:send(p,output,server),range(2)))
 same=all(r['status']=='original_result'and r['result']==reports[0]['result']for r in reports)
 original=next(output.rglob('results/original.json'));v=ex._json(original.read_bytes());v['delivery_seq']='2';original.write_bytes(ex.encoded(v))
 failure=send(p,output,server);again=error(lambda:send(p,output,server))
 print(json.dumps({'same':same,'failure':failure,'again':again,'sticky':bool(list(output.rglob('failures/conflict.json')))}))
`);
  assert.equal(out.same, true); assert.equal(out.failure.learning_ack, false); assert.equal(out.sticky, true);
  assert.equal(out.again, 'known_outcome_result_conflict');
});

test('HTTPS transport fixes origin/routes, refuses redirects, uses only bearer header and bounds reads/timeouts', () => {
  const out = py(`
calls=[]
class Response:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def geturl(self):return O.ORIGIN+O.CHUNK_ROUTE
 def read(self,n):calls.append(('read',n));return b'{}'
class Opener:
 def open(self,request,timeout):calls.append((request.method,request.full_url,request.headers,timeout));return Response()
with mock.patch.object(O.urllib.request,'build_opener',return_value=Opener()):r=O.http_transport(O.ORIGIN,TOKEN)('POST',O.CHUNK_ROUTE,b'{}')
class BadResponse(Response):
 def geturl(self):return 'https://evil.invalid'
get_route=O.DELIVERY_ROUTE+'/sha256%3A'+'a'*64
with mock.patch.object(Opener,'open',return_value=BadResponse()),mock.patch.object(O.urllib.request,'build_opener',return_value=Opener()):redirect=error(lambda:O.http_transport(O.ORIGIN,TOKEN)('GET',get_route,None))
http_error=urllib.error.HTTPError(O.ORIGIN,503,'SECRET',{},io.BytesIO(b'SECRET'))
with mock.patch.object(Opener,'open',side_effect=http_error),mock.patch.object(O.urllib.request,'build_opener',return_value=Opener()):failure=O.http_transport(O.ORIGIN,TOKEN)('GET',get_route,None)
invalid=[error(lambda value=value:O._origin(value))for value in('http://bad','https://u:p@self-learning-beige.vercel.app','https://other.invalid','https://self-learning-beige.vercel.app?token=SECRET')]
opened=[];route_errors=[]
with mock.patch.object(Opener,'open',side_effect=lambda *args,**kw:opened.append(args)),mock.patch.object(O.urllib.request,'build_opener',return_value=Opener()):
 transport=O.http_transport(O.ORIGIN,TOKEN)
 for method,route,body in [('GET','@evil.invalid/collector',None),('GET','https://evil.invalid/collector',None),('GET','//evil.invalid/collector',None),
  ('POST','/arbitrary',b'{}'),('DELETE',O.CHUNK_ROUTE,b'{}'),('GET',O.CHUNK_ROUTE,None),('POST',get_route,b'{}'),
  ('GET',get_route+'?token=SECRET',None),('GET',get_route+'#fragment',None),('GET',get_route.replace('%3A',':'),None),
  ('POST',O.CHUNK_ROUTE,b''),('POST',O.CHUNK_ROUTE,b'x'*(O.BODY_BYTES+1)),('GET',get_route,b'{}')]:
  route_errors.append(error(lambda:transport(method,route,body)))
assert calls[0][2]['Authorization']=='Bearer '+TOKEN
print(json.dumps({'status':r[0],'call':[calls[0][0],calls[0][1],calls[0][3]],'read':calls[1],'redirect':redirect,'http_error':[failure[0],failure[1].decode()],'invalid':invalid,
 'route_errors':route_errors,'malicious_open_calls':len(opened)}))
`);
  assert.equal(out.status, 200); assert.equal(out.call[0], 'POST'); assert.equal(out.call[2], 20);
  assert.equal(out.read[1], 3 * 1024 * 1024 + 1); assert.equal(out.redirect, 'outcome_redirect_rejected');
  assert.deepEqual(out.http_error, [503, '']); assert.ok(out.invalid.every(Boolean));
  assert.ok(out.route_errors.every(Boolean)); assert.equal(out.malicious_open_calls, 0);
  assert.ok(!out.call[1].includes('synthetic-outcome'));
});

test('explicit CLI prepare/send use only outcome credential; invalid origin precedes credential lookup and logs are redacted', () => {
  const out = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);base=['--capture',str(path),'--base-url',O.ORIGIN];codes=[];streams=[];keys=[];server=Server()
 for extra in([ '--prepare','--out-dir',str(root/'prepared')],[ '--send','--out-dir',str(root/'sent')],['--send']):
  stream=io.StringIO();err=io.StringIO()
  def env(key,*args):keys.append(key);return TOKEN
  with mock.patch.object(os.environ,'get',side_effect=env),mock.patch.object(O,'http_transport',return_value=server),redirect_stdout(stream),redirect_stderr(err):codes.append(O.main(base+extra))
  streams.append(stream.getvalue()+err.getvalue())
 stream=io.StringIO();get=os.environ.get
 def denied(key,*args):
  assert not key.startswith('SELFLEARN');return get(key,*args)
 with mock.patch.object(os.environ,'get',side_effect=denied),redirect_stderr(stream):
  code=O.main(['--capture',str(path),'--base-url','https://unapproved.invalid','--send','--out-dir',str(root/'bad')])
 invalid=[]
 before_calls=len(server.calls)
 for token,attempts in((None,3),('short',3),('bad\\nsecret',3),(TOKEN,True),(TOKEN,0),(TOKEN,6)):
  invalid.append(error(lambda:send(p,root/'invalid',server,attempts=attempts)if token==TOKEN else O.send(p,root/'invalid',token,transport=server)))
 direct=error(lambda:O._exchange(lambda *a:(503,b''),'GET','/',None,0,lambda _:None))
 print(json.dumps({'codes':codes,'keys':keys,'bad_origin_code':code,'redacted':all(TOKEN not in s for s in streams+[stream.getvalue()]),
  'bad_outbox':(root/'bad').exists(),'invalid':invalid,'invalid_no_writes':not(root/'invalid').exists(),'invalid_no_http':len(server.calls)==before_calls,'zero_attempts':direct}))
`);
  assert.deepEqual(out.codes, [0, 0, 1]); assert.ok(out.keys.includes('SELFLEARN_NFL_OUTCOME_INGEST_TOKEN'));
  assert.ok(!out.keys.includes('SELFLEARN_NFL_INGEST_TOKEN') && !out.keys.includes('SELFLEARN_OPERATOR_TOKEN'));
  assert.equal(out.bad_origin_code, 1); assert.equal(out.bad_outbox, false); assert.equal(out.redacted, true);
  assert.equal(out.invalid_no_writes, true); assert.equal(out.invalid_no_http, true);
  assert.ok(out.invalid.every(Boolean)); assert.equal(out.zero_attempts, 'invalid_outcome_retry_configuration');
});

test('actual engine chunk/request/result wire parity (explicit opt-in checkout)', { skip: !process.env.SELFLEARNING_CHECKOUT && 'SELFLEARNING_CHECKOUT not configured; no crossrepo claim' }, () => {
  const out = py(`
sys.path.insert(0,str(pathlib.Path(os.environ['SELFLEARNING_CHECKOUT'])/'packages/selflearn-core'))
from selflearn_core import evidence_chunks as E
from selflearn_core.adapters import nfl_capture_delivery_journal as D
with tempfile.TemporaryDirectory()as tmp:
 p,b,path=fixture(pathlib.Path(tmp));request=p['request']
 expected=D.make_capture_delivery_request(request['envelope'],request['raw_pointers'],destination_id=request['destination_id'],producer_id=request['producer_id'])
 pointers=[]
 for raw in b['raw_objects'].values():
  dtos=[];pointer=E.chunk_stream(io.BytesIO(raw),dtos.append);pointers.append(pointer)
  assert all(E.encode_chunk_request(dto)==O._body(O._chunk(E.verify_chunk(dto)))for dto in dtos)
 server_result=result(request);assert D._result(server_result,request=request)==O._result(server_result,request)
 print(json.dumps({'request_exact':ex.encoded(expected)==ex.encoded(request),'pointers_exact':sorted(pointers,key=lambda x:x['object_id'])==request['raw_pointers'],'result_exact':True}))
`);
  assert.equal(out.request_exact, true); assert.equal(out.pointers_exact, true); assert.equal(out.result_exact, true);
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), sourceHash);
  const executable = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1])if n>0)))', SOURCE], { encoding: 'utf8' }));
  const denominator = new Set([...executable, ...covered]); const percent = 100 * covered.size / denominator.size;
  console.log(`Outcome exporter source sha256: ${sourceHash}`);
  console.log(`Outcome exporter actual executable-line coverage: ${covered.size}/${denominator.size} (${percent.toFixed(4)}%); no exclusions`);
  assert.ok(percent >= 90, `Outcome exporter coverage below90; missing: ${[...denominator].filter(n => !covered.has(n)).join(',')}`);
});
