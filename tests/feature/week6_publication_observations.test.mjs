import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../scripts/publication_observations.py', import.meta.url));
const initialHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import copy, datetime as dt, io, json, os, pathlib, runpy, subprocess, sys, tempfile, urllib.error
from unittest import mock
from scripts import publication_observations as pub, learning_receipts as lr, export_learning as ex
f=runpy.run_path('tests/fixtures/week6_publication.py')
def fixture(root):return f['generation'](root)
def error(fn):
    try:fn()
    except pub.PublicationError as exc:return str(exc)
    return None
def observe(proposal,snapshots,path,*,body=None,headers=None,status=200,times=None,fetcher=None,**kwargs):
    clock=iter(times or ['2026-09-01T13:00:00Z','2026-09-01T13:00:01Z'])
    return pub.observe(proposal,snapshot_dir=snapshots,my_cards_path=path,
      fetcher=fetcher or (lambda spec:(status,headers if headers is not None else {'content-type':'application/json'},
          path.read_bytes() if body is None else body)),clock=lambda:next(clock),**kwargs)
def save(path,value):path.write_text(json.dumps(value,allow_nan=False),encoding='utf-8')
def rewrite_generation(s,doc):
    original=next((s/'learning_journal').rglob('*.json'));generation=doc['generations'][0]
    generation['generation_id']=ex.fingerprint({k:generation[k] for k in ex.MANIFEST_KEYS})
    for row in doc['receipts']:row['generation_id']=generation['generation_id']
    doc['envelope_id']=ex.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'})
    target=original.with_name(generation['generation_id'].split(':')[1]+'.json')
    if target!=original:original.unlink()
    save(target,doc)
`;

function py(body) {
  const program = FIXTURE + body;
  const wrapper = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/publication_observations.py').resolve())\nLINES=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename != TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return traced\nsys.settrace(traced)\nexec(${JSON.stringify(program)})\nsys.settrace(None)\nprint(json.dumps({'__publication_trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8', input: wrapper,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 32 * 1024 * 1024,
  }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__publication_trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('PUB-01 default local plan uses actual producer graph, with no fetch, credentials or writes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,archive=fixture(root); before={str(x):x.read_bytes() for x in root.rglob('*.json')}
 out=root/'should-not-exist'
 run=subprocess.run([sys.executable,'scripts/publication_observations.py','--snapshots',str(s),
  '--my-cards',str(p),'--season','2026','--week','6','--out-dir',str(out)],capture_output=True,text=True,
  env={**os.environ,'SELFLEARN_OPERATOR_TOKEN':'private-sentinel-token'})
 plan=pub.plan(s,p,2026,6); known={row['receipt_id'] for row in doc['receipts']}
 print(json.dumps({'code':run.returncode,'result':json.loads(run.stdout),'unchanged':before=={str(x):x.read_bytes() for x in root.rglob('*.json')},
  'output_absent':not out.exists(),'no_secret':'private-sentinel-token' not in run.stdout+run.stderr,
  'members_known':all(m['source_receipt_id'] in known for m in plan['membership']),
  'members':len(plan['membership']),'unsupported':len(plan['unsupported']),
  'original_statuses':sorted({row['learning_receipt']['publication_status'] for row in doc['receipts']})}))
`);
  assert.equal(r.code, 0); assert.equal(r.result.mode, 'local_plan');
  assert.equal(r.result.network_used, false); assert.equal(r.result.writes, false);
  assert.equal(r.unchanged, true); assert.equal(r.output_absent, true); assert.equal(r.no_secret, true);
  assert.equal(r.members_known, true); assert.ok(r.members > 0); assert.ok(r.unsupported > 0);
  assert.deepEqual(r.original_statuses, ['generated_unverified']);
  assert.equal(r.result.plan.historical_first_publication_utc, null);
});

test('PUB-02 exact public bytes bind only supported actual served props, never a deployment or whole card', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,archive=fixture(root); plan=pub.plan(s,p,2026,6); calls=[]
 def fetch(spec):
  calls.append(spec);return 200,{'Content-Type':'application/json; charset=utf-8','Content-Length':str(len(p.read_bytes())),
    'x-nf-request-id':'region-request-not-a-deployment','X-Deploy-Sha':'untrusted-claimed-sha','Age':'25'},p.read_bytes()
 result=observe(plan,s,p,fetcher=fetch)['observation']
 print(json.dumps({'observation':result,'calls':calls,'no_pool_claim':len({m['source_receipt_id'] for m in result['membership']})<=len(doc['receipts'])}))
`);
  assert.equal(r.observation.evidence_class, 'content_observed_at_public_origin');
  assert.equal(r.observation.deployment_identity_verified, false); assert.equal(r.observation.deployment_id, null);
  assert.equal(r.observation.first_publication_utc, null); assert.equal(r.observation.original_receipt_status_changed, false);
  assert.equal(r.observation.observed_region, null); assert.equal(r.observation.http.response_cache_headers.age, '25');
  assert.equal(r.observation.status, 'content_observed'); assert.ok(r.observation.pre_event_receipt_ids.length > 0);
  assert.equal(r.no_pool_claim, true); assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://nfl2026.netlify.app/data/my_cards/2026_wk06.json');
  assert.equal(r.calls[0].timeout_seconds, 12); assert.equal(r.calls[0].maximum_bytes, 16 * 1024 * 1024);
});

test('display dedupe retains old receipt membership and never attests new-generation pool vintages', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,first,archive=fixture(root)
 s,p,later,updated=f['generation'](root,created='2026-09-01T12:30:00Z',previous=archive)
 plan=pub.plan(s,p,2026,6); old={r['receipt_id'] for r in first['receipts']}; new={r['receipt_id'] for r in later['receipts']}
 observed={m['source_receipt_id'] for m in plan['membership']}
 print(json.dumps({'same_cards':updated['cards']==archive['cards'],'old_only':observed<=old and not observed&new,
  'lineage_old_only':all(m['lineage']['generation_id']==first['generations'][0]['generation_id'] for m in plan['membership']),
  'observed':len(observed),'new_count':len(new)}))
`);
  assert.equal(r.same_cards, true); assert.equal(r.old_only, true); assert.equal(r.lineage_old_only, true);
  assert.ok(r.observed > 0); assert.ok(r.new_count > 0);
});

test('PUB-03 missing historical bases/leg IDs stay unsupported and never gain reconstructed first-seen time', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,archive=fixture(root)
 for c in archive['cards']:
  c['first_seen_utc']='2000-01-01T00:00:00Z'
  for leg in c['legs']:leg.pop('learning_receipt',None)
 save(p,archive);plan=pub.plan(s,p,2026,6);result=observe(plan,s,p)['observation']
 print(json.dumps({'plan':plan,'observation':result}))
`);
  assert.equal(r.plan.membership.length, 0); assert.ok(r.plan.unsupported.length > 0);
  assert.equal(r.observation.status, 'no_supported_publication_membership');
  assert.deepEqual(r.observation.pre_event_receipt_ids, []); assert.equal(r.observation.first_publication_utc, null);
});

test('late capture uses real fetch completion, not archive/server metadata, and cannot backdate eligibility', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);plan=pub.plan(s,p,2026,6)
 result=observe(plan,s,p,times=['2026-09-01T13:00:00Z','2026-09-02T00:15:00Z'],
  headers={'content-type':'application/json','date':'Tue, 01 Sep 2026 13:00:00 GMT'})['observation']
 errors=[error(lambda:observe(plan,s,p,times=times)) for times in (
  ['2026-09-01T13:00:00Z','2026-09-01T12:59:59Z'],['2026-09-01T11:00:00Z','2026-09-01T11:00:01Z'],
  ['not-a-clock','2026-09-01T13:00:00Z'],['2026-09-01T13:00:00','2026-09-01T13:00:01Z'])]
 print(json.dumps({'result':result,'errors':errors}))
`);
  assert.equal(r.result.status, 'late_content_observed'); assert.deepEqual(r.result.pre_event_receipt_ids, []);
  assert.equal(r.result.http.response_cache_headers.date, 'Tue, 01 Sep 2026 13:00:00 GMT');
  assert.ok(r.result.membership.every(m => m.observed_before_event === false));
  assert.deepEqual(r.errors, ['observation_clock_regressed', 'observation_before_generation_capture',
    'invalid_observation_clock', 'invalid_observation_clock']);
});

test('changed bytes/plan, partial fetch, status, compression, headers and claimed deploy identities fail closed', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);plan=pub.plan(s,p,2026,6); raw=p.read_bytes()
 cases={'changed_bytes':lambda:observe(plan,s,p,body=raw+b' '),
  'partial':lambda:observe(plan,s,p,headers={'content-type':'application/json','content-length':str(len(raw)+1)}),
  'html':lambda:observe(plan,s,p,headers={'content-type':'text/html'}),
  'gzip':lambda:observe(plan,s,p,headers={'content-type':'application/json','content-encoding':'gzip'}),
  'redirect':lambda:observe(plan,s,p,status=302),'status':lambda:observe(plan,s,p,status=206),
  'bool_status':lambda:observe(plan,s,p,status=True),'notbytes':lambda:observe(plan,s,p,body='private-response'),
  'large':lambda:observe(plan,s,p,body=b'x'*(pub.MAX_BYTES+1)),
  'badheaders':lambda:observe(plan,s,p,headers={'content-type':True}),
  'ambiguousheaders':lambda:observe(plan,s,p,headers={'content-type':'application/json','Content-Type':'text/html'}),
  'deploy':lambda:observe(plan,s,p,deployment_identity={'verified':True,'deployment_id':'claimed-id'}),
  'exception':lambda:observe(plan,s,p,fetcher=lambda spec:(_ for _ in ()).throw(RuntimeError('private-response')))}
 errors={k:error(fn) for k,fn in cases.items()}
 altered=copy.deepcopy(plan);altered['membership']=[];errors['plan']=error(lambda:observe(altered,s,p))
 def changed_during_fetch(spec):p.write_bytes(raw+b' ');return 200,{'content-type':'application/json'},raw
 errors['changed_during_fetch']=error(lambda:observe(plan,s,p,fetcher=changed_during_fetch))
 print(json.dumps({'errors':errors,'no_writes':not (root/'observations').exists()}))
`);
  assert.ok(Object.values(r.errors).every(Boolean)); assert.equal(r.no_writes, true);
  assert.ok(!JSON.stringify(r).includes('private-response'));
  assert.equal(r.errors.deploy, 'verified_deployment_identity_not_supported');
  assert.equal(r.errors.changed_during_fetch, 'publication_authority_changed_during_fetch');
});

test('wrong periods, conflicting card/leg IDs, probability and source tampering cannot produce partial success', () => {
  const r = py(`
results={}
for kind in ('period','duplicate_card','empty_legs','bad_n','bad_leg','prob','identity','sourcehash','offered','snapshot','missingfile'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);s,p,doc,a=fixture(root)
  leg=next(l for c in a['cards'] for l in c['legs'] if 'learning_receipt' in l)
  if kind=='period':a['week']=5
  if kind=='duplicate_card':a['cards'].append(copy.deepcopy(a['cards'][0]))
  if kind=='empty_legs':a['cards'][0]['legs']=[]
  if kind=='bad_n':a['cards'][0]['n_legs']=True
  if kind=='bad_leg':a['cards'][0]['legs'][0]=None
  if kind=='prob':leg['model_prob']=.1234
  if kind=='identity':leg['game_id']='wrong-game'
  if kind=='sourcehash':leg['learning_receipt']['base_prob']=.1234
  if kind=='offered':a['cards'][0]['card_id']='not-an-offered-card'
  if kind=='snapshot':next((s/'learning_sources').glob('*.json')).write_text('{}')
  save(p,a)
  if kind=='missingfile':p.unlink()
  results[kind]=error(lambda:pub.plan(s,p,2026,6))
print(json.dumps(results))
`);
  assert.ok(Object.values(r).every(Boolean));
});

test('HTTP transport has a fixed code-owned origin, rejects redirects and bounds response reads', () => {
  const r = py(`
class Response:
 status=200;headers={'content-type':'application/json'}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def geturl(self):return url
 def read(self,limit):limits.append(limit);return b'{}'
class Opener:
 def open(self,request,timeout):calls.append((request.full_url,timeout));return Response()
spec=pub.source_spec(2026,6);url=spec['url'];calls=[];limits=[]
with mock.patch.object(pub.urllib.request,'build_opener',return_value=Opener()):result=pub.http_fetcher(spec)
url='https://other.invalid/data/my_cards/2026_wk06.json'
with mock.patch.object(pub.urllib.request,'build_opener',return_value=Opener()):wrong=error(lambda:pub.http_fetcher(spec))
with mock.patch.object(pub.urllib.request,'build_opener',side_effect=RuntimeError('unexpected')):
 badspec=error(lambda:pub.http_fetcher({**spec,'url':'https://private.invalid/?secret=private'}))
class Failure:
 def open(self,*args,**kwargs):raise urllib.error.URLError('private-network-detail')
with mock.patch.object(pub.urllib.request,'build_opener',return_value=Failure()):failed=error(lambda:pub.http_fetcher(spec))
redirect=error(lambda:pub._NoRedirect().redirect_request(None,None,302,'secret',{},'https://private.invalid'))
periods=[error(lambda a=a,b=b:pub.source_spec(a,b)) for a,b in ((True,6),(2026,True),(1999,6),(2026,19))]
print(json.dumps({'status':result[0],'calls':calls,'limits':limits,'errors':[wrong,badspec,failed,redirect], 'periods':periods}))
`);
  assert.equal(r.status, 200); assert.equal(r.calls[0][0], 'https://nfl2026.netlify.app/data/my_cards/2026_wk06.json');
  assert.equal(r.calls[0][1], 12); assert.equal(r.limits[0], 16 * 1024 * 1024 + 1);
  assert.ok(r.errors.every(Boolean)); assert.ok(r.periods.every(Boolean)); assert.ok(!JSON.stringify(r).includes('private-network-detail'));
});

test('immutable local persistence/replay is race-safe and never rewrites receipts or sports data', () => {
  const r = py(`
import concurrent.futures
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);before={str(x):x.read_bytes() for x in s.rglob('*.json')}
 plan=pub.plan(s,p,2026,6);bundle=observe(plan,s,p);out=root/'observed'
 def write(_):return pub.persist(bundle,out,snapshot_dir=s,my_cards_path=p)
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(write,range(2)))
 frozen={str(x):x.read_bytes() for x in out.rglob('*.json')};again=write(0)
 bad=copy.deepcopy(bundle);bad['observation']['deployment_identity_verified']=True
 tamper=error(lambda:pub.persist(bad,out,snapshot_dir=s,my_cards_path=p))
 bad_http=copy.deepcopy(bundle);bad_http['observation']['http']['final_url']='https://other-region.invalid'
 wrong_region=error(lambda:pub.persist(bad_http,out,snapshot_dir=s,my_cards_path=p))
 overlap=error(lambda:pub.persist(bundle,s,snapshot_dir=s,my_cards_path=p))
 sports=error(lambda:pub.persist(bundle,pathlib.Path('data')/'forbidden-publication-test',snapshot_dir=s,my_cards_path=p))
 print(json.dumps({'same':results[0]==results[1]==again,'files':len(frozen),
  'immutable':frozen=={str(x):x.read_bytes() for x in out.rglob('*.json')},
  'sources_unchanged':before=={str(x):x.read_bytes() for x in s.rglob('*.json')},'errors':[tamper,wrong_region,overlap,sports]}))
`);
  assert.equal(r.same, true); assert.equal(r.files, 2); assert.equal(r.immutable, true); assert.equal(r.sources_unchanged, true);
  assert.ok(r.errors.every(Boolean));
});

test('corrupt existing records/raw objects, symlink escapes and missing output selection fail closed', () => {
  const r = py(`
results={}
for kind in ('raw','record','symlink','bad_bundle','missing_out'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);s,p,doc,a=fixture(root);proposal=pub.plan(s,p,2026,6);bundle=observe(proposal,s,p);out=root/'observed'
  if kind in ('raw','record'):
   saved=pub.persist(bundle,out,snapshot_dir=s,my_cards_path=p)
   target=next((out/'raw').glob('*.json')) if kind=='raw' else pathlib.Path(saved['record_path']);target.write_text('{}')
  if kind=='symlink':out.mkdir();(out/'raw').symlink_to(s,target_is_directory=True)
  if kind=='bad_bundle':bundle={}
  if kind=='missing_out':
   run=subprocess.run([sys.executable,'scripts/publication_observations.py','--snapshots',str(s),'--my-cards',str(p),
      '--season','2026','--week','6','--observe'],capture_output=True,text=True)
   results[kind]=json.loads(run.stderr)['reason'];continue
  results[kind]=error(lambda:pub.persist(bundle,out,snapshot_dir=s,my_cards_path=p))
print(json.dumps(results))
`);
  assert.ok(Object.values(r).every(Boolean)); assert.equal(r.missing_out, 'explicit_output_directory_required');
});

test('missing durable vintages and ambiguous generation matches stay unsupported without invented lineage', () => {
  const r = py(`
from scripts import learning_journal
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);empty=root/'empty';empty.mkdir()
 missing=pub.plan(empty,p,2026,6)
 graph=ex.plan(s);sources={e['object_id']:e['payload'] for e in graph['source_objects']};refs=doc['generations'][0]['source_snapshots']
 learning_journal.record(sources[refs['leg_pool']],sources[refs['schedule']],sources[refs['parlay_calibration']],
  list(reversed(a['cards'])),f['RECORDED'],str(s))
 ambiguous=pub.plan(s,p,2026,6);result=observe(ambiguous,s,p)['observation']
 print(json.dumps({'missing':missing,'ambiguous':ambiguous,'status':result['status']}))
`);
  assert.equal(r.missing.membership.length, 0);
  assert.ok(r.missing.unsupported.some(row => row.reason === 'no_matching_durable_receipt'));
  assert.equal(r.ambiguous.membership.length, 0);
  assert.ok(r.ambiguous.unsupported.some(row => row.reason === 'ambiguous_generation_membership'));
  assert.equal(r.status, 'no_supported_publication_membership');
});

test('operator CLI exit codes distinguish local plan, complete observation, invalid input and unsupported coverage', () => {
  const r = py(`
import contextlib
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root)
 base=['--snapshots',str(s),'--my-cards',str(p),'--season','2026','--week','6']
 def run(args):
  output=io.StringIO();errors=io.StringIO()
  with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):code=pub.main(args)
  return {'code':code,'value':json.loads(output.getvalue() or errors.getvalue())}
 planned=run(base);missing=run(base+['--observe'])
 with mock.patch.object(pub,'http_fetcher',side_effect=lambda spec:(200,{'content-type':'application/json'},p.read_bytes())):
  observed=run(base+['--observe','--out-dir',str(root/'observed')])
  for c in a['cards']:
   for leg in c['legs']:leg.pop('learning_receipt',None)
  save(p,a);unsupported=run(base+['--observe','--out-dir',str(root/'legacy-observed')])
 output=io.StringIO()
 with contextlib.redirect_stdout(output),mock.patch.object(sys,'argv',['publication_observations.py',*base]):
  try:runpy.run_path('scripts/publication_observations.py',run_name='__main__')
  except SystemExit as exc:entrypoint=exc.code
 print(json.dumps({'planned':planned,'missing':missing,'observed':observed,'unsupported':unsupported,'entrypoint':entrypoint}))
`);
  assert.equal(r.planned.code, 0); assert.equal(r.planned.value.writes, false);
  assert.equal(r.missing.code, 2); assert.equal(r.observed.code, 0); assert.equal(r.observed.value.writes, true);
  assert.equal(r.unsupported.code, 3); assert.equal(r.unsupported.value.status, 'no_supported_publication_membership');
  assert.equal(r.entrypoint, 0);
});

test('a generation has one immutable envelope; exact duplicate copies dedupe but conflicting capture lineage fails', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);before=pub.plan(s,p,2026,6)
 copy_path=s/'learning_journal'/'zz-copy'/'2026_wk06'/(doc['generations'][0]['generation_id'].split(':')[1]+'.json')
 copy_path.parent.mkdir(parents=True);save(copy_path,doc)
 exact=pub.plan(s,p,2026,6)
 conflict=copy.deepcopy(doc);conflict['generations'][0]['recorded_utc']='2026-09-01T12:02:00Z'
 for row in conflict['receipts']:row['recorded_utc']='2026-09-01T12:02:00Z'
 conflict['envelope_id']=ex.fingerprint({k:v for k,v in conflict.items() if k!='envelope_id'});save(copy_path,conflict)
 rejected=error(lambda:pub.plan(s,p,2026,6))
 print(json.dumps({'same_exact':ex._same_json(before,exact),'error':rejected}))
`);
  assert.equal(r.same_exact, true); assert.equal(r.error, 'conflicting_generation_envelopes');
});

test('generation schema, clocks, policies and frozen source periods are typed and coherent before use', () => {
  const r = py(`
results={}
for kind in ('version_bool','version_2','capture_disagrees','capture_invalid','pool_time','offered_shape','policy_type','population'):
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);s,p,doc,a=fixture(root);generation=doc['generations'][0]
  if kind=='version_bool':generation['version']=True
  if kind=='version_2':generation['version']=2
  if kind=='capture_disagrees':generation['recorded_utc']='2099-01-01T00:00:00Z'
  if kind=='capture_invalid':generation['recorded_utc']='not-a-clock'
  if kind=='pool_time':generation['pool_generated_utc']='2026-09-01T12:00:01Z'
  if kind=='offered_shape':generation['offered_cards']={}
  if kind=='policy_type':generation['selection_policy_version']=True
  if kind=='population':generation['population']='verified-public-pool'
  rewrite_generation(s,doc)
  results[kind]=error(lambda:pub.plan(s,p,2026,6))
print(json.dumps(results))
`);
  assert.ok(Object.values(r).every(Boolean));
  assert.equal(r.version_bool, 'unsupported_generation_contract'); assert.equal(r.version_2, 'unsupported_generation_contract');
  assert.equal(r.capture_disagrees, 'invalid_durable_source_receipt');
  assert.equal(r.pool_time, 'generation_frozen_source_mismatch');
});

test('selected output root and ancestor symlinks cannot redirect publication writes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,doc,a=fixture(root);bundle=observe(pub.plan(s,p,2026,6),s,p)
 unexpected=root/'unexpected-location';unexpected.mkdir();selected=root/'selected-output'
 selected.symlink_to(unexpected,target_is_directory=True)
 before={str(x):x.read_bytes() for x in s.rglob('*.json')}
 errors=[error(lambda out=out:pub.persist(bundle,out,snapshot_dir=s,my_cards_path=p))
  for out in (selected,selected/'nested')]
 print(json.dumps({'errors':errors,'no_redirected_files':not list(unexpected.rglob('*.json')),
  'authority_unchanged':before=={str(x):x.read_bytes() for x in s.rglob('*.json')}}))
`);
  assert.deepEqual(r.errors, ['publication_output_symlink_rejected', 'publication_output_symlink_rejected']);
  assert.equal(r.no_redirected_files, true); assert.equal(r.authority_unchanged, true);
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), initialHash, 'Measured source changed during tests');
  const enumerated = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1]) if n>0)))', SOURCE],
  { encoding: 'utf8' }));
  const denominator = new Set([...enumerated, ...covered]);
  const percent = 100 * covered.size / denominator.size;
  console.log(`publication observations measured source sha256: ${initialHash}`);
  console.log(`publication observations executable-line coverage: ${covered.size}/${denominator.size} (${percent.toFixed(4)}%)`);
  assert.ok(percent >= 90, `Publication critical coverage below 90%; missing lines: ${[...denominator].filter(n => !covered.has(n)).join(',')}`);
});
