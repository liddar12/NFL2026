import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Reuse only producer/exact-wire fixture definitions, not their tests. These
// memory servers are not SQL, hosted, or provider-authentication evidence.
const fixture = (name) => {
  const found = readFileSync(ROOT + `tests/feature/${name}`, 'utf8').match(/const FIXTURE = `([\s\S]*?)`;/);
  assert.ok(found, `fixture definition exists: ${name}`);
  return found[1];
};
const fixtures = {
  forecast: fixture('week6_learning_export.test.mjs'),
  v1: fixture('week6_outcome_export.test.mjs'),
  v2: fixture('week6_capture_application_export.test.mjs'),
};
function py(kind, body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: fixtures[kind] + '\n' + body,
  }).trim().split('\n').pop());
}

test('forecast refuses retained credential-shaped rejection reasons and generic receipt IDs before saving ACKs', () => {
  const r = py('forecast', `
rows=[]
for kind,secret in(('rejection','s'*40),('receipt_id','sha256:'+'a'*64)):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);snapshots,doc=fixture(root);p=ex.plan(snapshots);server=Server();out=root/'delivery'
  def echoed(route,body):
   status,raw=server(route,body);ack=json.loads(raw)
   if route==ex.GENERATION_ROUTE:
    if kind=='rejection':
     rejected=ack['receipts'].pop();ack['rejections']=[{'source_receipt_id':rejected['source_receipt_id'],'reason':secret}]
    else:ack['receipts'][0]['receipt_id']=secret
   return status,ex.encoded(ack)
  report=ex.send(p,'https://fixture.invalid',out,secret,transport=echoed,sleep=lambda _:None)
  saved=''.join(x.read_text()for x in out.rglob('*.json'))
  rows.append({'report':report,'secret_saved':secret in saved,'acks':len(list(out.rglob('acks/*.json'))),
    'generation_ack':any(ex._read(x)['operation']['phase']=='generation'for x in out.rglob('acks/*.json'))})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.report.ok, false); assert.equal(row.report.generations_acked, 0);
    assert.equal(row.report.failures[0].reason, 'credential_echo_refused');
    assert.equal(row.acks, 4); assert.equal(row.generation_ack, false); assert.equal(row.secret_saved, false);
  }
});

test('forecast still discards unused diagnostics and preserves non-secret durable partial rejections', () => {
  const r = py('forecast', `
rows=[]
for kind in('diagnostic','partial'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);snapshots,doc=fixture(root);p=ex.plan(snapshots);server=Server();out=root/'delivery'
  def response(route,body):
   status,raw=server(route,body);ack=json.loads(raw)
   ack['diagnostics']={'Authorization':TOKEN,'nested':[TOKEN]}
   if route==ex.GENERATION_ROUTE and kind=='partial':
    rejected=ack['receipts'].pop();ack['rejections']=[{'source_receipt_id':rejected['source_receipt_id'],'reason':'invalid_timestamp'}]
   return status,ex.encoded(ack)
  first=send(p,out,response);n=len(server.calls);second=send(p,out,response)
  rows.append({'first':first,'second':second,'replay_calls':len(server.calls)-n,
   'secret_saved':TOKEN in ''.join(x.read_text()for x in out.rglob('*.json')),
   'acks':len(list(out.rglob('acks/*.json')))})
print(json.dumps(rows))
`);
  assert.equal(r[0].first.ok, true); assert.equal(r[0].second.ok, true);
  assert.equal(r[1].first.ok, false); assert.equal(r[1].first.receipts_rejected, 1);
  assert.equal(r[1].second.receipts_rejected, 1);
  for (const row of r) { assert.equal(row.acks, 5); assert.equal(row.replay_calls, 0); assert.equal(row.secret_saved, false); }
});

test('forecast refuses already-corrupt cached credential echoes without sending or propagating them', () => {
  const r = py('forecast', `
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);snapshots,doc=fixture(root);p=ex.plan(snapshots);server=Server();out=root/'delivery';secret='sha256:'+'a'*64
 first=ex.send(p,'https://fixture.invalid',out,secret,transport=server,sleep=lambda _:None)
 ack_path=next(x for x in out.rglob('acks/*.json')if ex._read(x)['operation']['phase']=='generation')
 damaged=ex._read(ack_path);damaged['ack']['receipts'][0]['receipt_id']=secret;ack_path.write_bytes(ex.encoded(damaged))
 before={str(x):x.read_bytes()for x in out.rglob('*.json')};n=len(server.calls)
 second=ex.send(p,'https://fixture.invalid',out,secret,transport=server,sleep=lambda _:None)
 fresh=[x.read_text()for x in out.rglob('*.json')if str(x)not in before]
 print(json.dumps({'first_ok':first['ok'],'report':second,'calls':len(server.calls)-n,
  'old_file_preserved':ack_path.read_bytes()==before[str(ack_path)],'secret_propagated':secret in ''.join(fresh)+json.dumps(second)}))
`);
  assert.equal(r.first_ok, true); assert.equal(r.report.ok, false); assert.equal(r.calls, 0);
  assert.equal(r.report.failures[0].reason, 'credential_echo_refused');
  assert.equal(r.old_file_preserved, true); assert.equal(r.secret_propagated, false);
});

test('forecast sanitizes arbitrary callback and CLI exception text while cancellation remains visible', () => {
  const r = py('forecast', `
import io
from contextlib import redirect_stderr
from unittest import mock
reports=[];cancelled=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);snapshots,doc=fixture(root);p=ex.plan(snapshots)
 for i,exc in enumerate((ex.ExportError(TOKEN),RuntimeError(TOKEN),OSError(TOKEN))):
  def broken(*args):raise exc
  reports.append(ex.send(p,'https://fixture.invalid',root/str(i),TOKEN,transport=broken,attempts=1,sleep=lambda _:None))
 for exc in(KeyboardInterrupt(),SystemExit(7),ex.ExportAborted()):
  def broken(*args):raise exc
  try:ex.send(p,'https://fixture.invalid',root/'cancel',TOKEN,transport=broken,sleep=lambda _:None)
  except BaseException as e:cancelled.append(type(e).__name__)
 stream=io.StringIO()
 with mock.patch.object(ex,'plan',side_effect=RuntimeError(TOKEN)),redirect_stderr(stream):code=ex.main(['--snapshots',str(snapshots)])
 alias='generation_hash_or_filename_mismatch';plan_stream=io.StringIO()
 with mock.patch.dict(os.environ,{'SELFLEARN_NFL_INGEST_TOKEN':alias}),mock.patch.object(ex,'plan',side_effect=ex.ExportError(alias)),redirect_stderr(plan_stream):
  plan_code=ex.main(['--snapshots',str(snapshots),'--send','--base-url','https://fixture.invalid','--out-dir',str(root/'cli')])
 sleep_alias='delivery_directory_overlaps_sports_data'
 def failed_sleep(seconds):raise ex.ExportError(sleep_alias)
 sleep_report=ex.send(p,'https://fixture.invalid',root/'sleep_alias',sleep_alias,
  transport=lambda *args:(503,b''),attempts=2,sleep=failed_sleep)
 saved=''.join(x.read_text()for x in root.rglob('delivery/*.json'))+''.join(x.read_text()for x in root.rglob('failures/*.json'))
 print(json.dumps({'reports':reports,'cancelled':cancelled,'code':code,'cli':stream.getvalue(),
  'plan_code':plan_code,'plan_cli':plan_stream.getvalue(),'alias_echoed':alias in plan_stream.getvalue(),
  'sleep_report':sleep_report,'sleep_alias_echoed':sleep_alias in saved+json.dumps(sleep_report),
  'secret_saved':TOKEN in saved+json.dumps(reports)+stream.getvalue()}))
`);
  assert.ok(r.reports.every(row => !row.ok && row.generations_acked === 0));
  assert.deepEqual(r.reports.map(row => row.failures[0].reason), ['export_failed', 'transport_failed', 'transport_retry_exhausted']);
  assert.deepEqual(r.cancelled, ['KeyboardInterrupt', 'SystemExit', 'ExportAborted']);
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.cli).reason, 'export_failed'); assert.equal(r.secret_saved, false);
  assert.equal(r.plan_code, 1); assert.equal(JSON.parse(r.plan_cli).reason, 'export_failed'); assert.equal(r.alias_echoed, false);
  assert.equal(r.sleep_report.ok, false); assert.equal(r.sleep_report.failures[0].reason, 'export_failed'); assert.equal(r.sleep_alias_echoed, false);
});

test('v1 opaque revision IDs and withheld reason echoes are refused on original GET before result persistence', () => {
  const r = py('v1', `
rows=[];secret='outcome_echo_'+'q'*40
for kind in('revision','reason'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server();g=group(held=kind=='reason')
  if kind=='revision':g['revision_ids'][0]=secret;g['revision_ids'].sort()
  else:g['reason_codes']=[secret]
  server.original=result(p['request'],[g]);out=root/'delivery'
  report=O.send(p,out,secret,transport=server,sleep=lambda _:None)
  rows.append({'report':report,'secret_saved':secret in ''.join(x.read_text()for x in out.rglob('*.json')),
   'results':len(list(out.rglob('results/*.json'))),'methods':[x[0]for x in server.calls]})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.report.status, 'pending'); assert.equal(row.report.learning_ack, false);
    assert.equal(row.secret_saved, false); assert.equal(row.results, 0); assert.deepEqual(row.methods, ['GET']);
  }
});

test('v2 refuses correctly rehashed credential echoes in GET originals and successful one-batch replies', () => {
  const r = py('v2', `
rows=[];secret='outcome_echo_'+'q'*40
for mode in('original','post'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server(sizes=(2,));out=root/'delivery';original_commit=server.commit;validated=[]
  def echoed(sid,cause=None):
   value=original_commit(sid,cause);value['groups'][0]['revision_ids'][0]=secret;value['groups'][0]['revision_ids'].sort()
   hashit(value,'batch_result_id');server.app['terminal']=terminal(server.app);server.record()
   A.report_valid(server.app,p['request']);validated.append(True)
   return value
  server.commit=echoed
  if mode=='original':
   server.register(p['request']);server.commit(server.app['batches'][0]['assignment']['step_id'])
  report=A.send(p,out,secret,transport=server,sleep=lambda _:None)
  rows.append({'report':report,'protocol_valid':bool(validated),'secret_saved':secret in ''.join(x.read_text()for x in out.rglob('*.json')),
   'step_acks':len(list(out.rglob('steps/*/original.json'))),'terminals':len(list(out.rglob('terminal/original.json'))),
   'get_only':all(x[0]=='GET'for x in server.calls)})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.protocol_valid, true); assert.equal(row.report.status, 'pending'); assert.equal(row.report.learning_accepted, false);
    assert.equal(row.secret_saved, false); assert.equal(row.step_acks, 0); assert.equal(row.terminals, 0);
  }
  assert.equal(r[0].get_only, true); assert.equal(r[1].get_only, false);
});

test('successful outcomes and lost-reply original recovery retain exact immutable identities', () => {
  const first = py('v1', `
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server();server.lose=True;out=root/'delivery'
 initial=send(p,out,server);n=len(server.calls);again=send(p,out,server)
 print(json.dumps({'status':initial['status'],'same':initial['result']==again['result'],
  'id':initial['result']['delivery_id'],'expected':p['request']['delivery_id'],'get_only':all(x[0]=='GET'for x in server.calls[n:]),
  'source_authentication':initial['result']['source_authentication']}))
`);
  const second = py('v2', `
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);server=Server(sizes=(2,));server.lose_register=server.lose_step=True;out=root/'delivery'
 initial=send(p,out,server);n=len(server.calls);again=send(p,out,server)
 print(json.dumps({'status':initial['status'],'same':initial['result']==again['result'],
  'id':initial['result']['application_id'],'expected':p['request']['application_id'],'get_only':all(x[0]=='GET'for x in server.calls[n:]),
  'source_authentication':initial['result']['source_authentication']}))
`);
  for (const [row, status] of [[first, 'original_result'], [second, 'terminal_original']]) {
    assert.equal(row.status, status); assert.equal(row.same, true); assert.equal(row.id, row.expected);
    assert.equal(row.get_only, true); assert.equal(row.source_authentication, 'not_performed');
  }
});

test('literal credential collisions with existing plan identities are refused before any outbox writes', () => {
  const rows = [];
  for (const [kind, prepare] of [
    ['forecast', "snapshots,doc=fixture(root);p=ex.plan(snapshots);secret=p['source_objects'][0]['object_id'];call=lambda:ex.send(p,'https://fixture.invalid',out,secret,transport=Server())"],
    ['v1', "p,b,path=fixture(root);secret=p['request']['capture_id'];call=lambda:O.send(p,out,secret,transport=Server())"],
    ['v2', "p,b,path=fixture(root);secret=p['request']['application_id'];call=lambda:A.send(p,out,secret,transport=Server())"],
  ]) {
    rows.push(py(kind, `
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);out=root/'delivery';${prepare}
 caught=None
 try:call()
 except Exception as e:caught=str(e)
 print(json.dumps({'caught':caught,'output_exists':out.exists()}))
`));
  }
  assert.ok(rows.every(row => row.caught === 'credential_echo_refused' && row.output_exists === false));
});

test('shared transport scan is bounded, strict-success-only and preserves cancellation', () => {
  const r = py('forecast', `
secret='s'*40;rejected=[];passed=[];cancelled=[]
for value in({secret:'field'}, {'nested':[{'key':secret}]}, {'nested':['prefix'+secret+'suffix']}):
 try:ex._credential_guarded_transport(lambda:(200,ex.encoded(value)),(secret,))()
 except ex.ExportError as e:rejected.append(str(e))
for status,raw in((404,ex.encoded({'x':secret})),(True,ex.encoded({'x':secret})),(200,b'{bad-json'),(200,b'x'*(ex.MAX_BODY_BYTES+1))):
 passed.append(ex._credential_guarded_transport(lambda:(status,raw),(secret,))()==(status,raw))
for exc in(KeyboardInterrupt(),SystemExit(7)):
 def broken():raise exc
 try:ex._credential_guarded_transport(broken,(secret,))()
 except BaseException as e:cancelled.append(type(e).__name__)
print(json.dumps({'rejected':rejected,'passed':passed,'cancelled':cancelled}))
`);
  assert.deepEqual(r.rejected, ['credential_echo_refused', 'credential_echo_refused', 'credential_echo_refused']);
  assert.deepEqual(r.passed, [true, true, true, true]); assert.deepEqual(r.cancelled, ['KeyboardInterrupt', 'SystemExit']);
});
