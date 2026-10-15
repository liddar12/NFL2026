import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy, json, math, pathlib, tempfile, subprocess, sys, os
from scripts import learning_journal as journal, learning_receipts as lr, build_my_cards as cards
from scripts import export_learning as ex
T0='2026-10-15T14:00:00Z'; NOW='2026-10-15T14:01:00Z'; KICK='2026-10-16T00:15:00Z'
TOKEN='secret-NFL-only-token-do-not-log'
def fixture(root):
    pool=cards._fixture_pool(T0); pool['week']=6; pool['base_model_version']='fixture-base'
    pool['players']=pool['players'][:1]; pool['players'][0]['rungs']=pool['players'][0]['rungs'][:2]
    for player in pool['players']:
        for rung in player['rungs']:
            z=(player['mu']-rung['line'])/30
            calibration={'a':math.log(rung['model_prob']/(1-rung['model_prob'])),'b':0,'c':0}
            features={'market':player['market'],'line':rung['line'],'mu':player['mu'],
                      'sd':30,'z':z,'p_team':player['p_team'],'calibration':calibration,
                      'correlation_tags':['game:'+player['game_id']]}
            context={'season':2026,'week':6,'base_model_version':'fixture-base',
                     'forecast_created_utc':T0,'source_snapshot_id':lr.fingerprint({'created':T0}),
                     'source_timestamps':{'fixture':T0},'generation_sha':'fixture'}
            receipt=lr.make_receipt({**player,**rung},lr.base_probability(calibration,z,player['p_team']),
                                    None,context,features=features)
            rung.update(model_prob=receipt['served_prob'],learning_receipt=receipt)
    schedule={'season':2026,'games':[{'game_id':'G1','week':6,'status':'STATUS_SCHEDULED','kickoff_utc':KICK}]}
    snapshots=root/'snapshots'; doc,_=journal.record(pool,schedule,None,[],NOW,str(snapshots))
    return snapshots,doc
class Server:
    def __init__(self):self.calls=[];self.objects={};self.fail_once=False;self.committed=set()
    def __call__(self,route,body):
        request=json.loads(body); oid=request['object_id']; self.calls.append((route,request))
        if route==ex.OBJECT_ROUTE:
            status='duplicate' if oid in self.objects else 'recorded'
            if request['kind']=='generation':
                assert all(d in self.objects for d in request['payload']['generations'][0]['source_snapshots'].values())
            self.objects[oid]=request
            response={'version':1,'object_id':oid,'durable':True,'status':status}
        else:
            generation=self.objects[oid]['payload']['generations'][0]
            response={'version':1,'object_id':oid,'durable':True,'receipts':[
                {'source_receipt_id':rid,'receipt_id':ex.fingerprint({'generic':rid}),
                 'status':'duplicate' if rid in self.committed else 'recorded'} for rid in generation['receipt_ids']],
                'rejections':[]}
            self.committed.update(generation['receipt_ids'])
        return 200,ex.encoded(response)
def send(plan,out,server,**kw):
    return ex.send(plan,'https://fixture.invalid',out,TOKEN,transport=server,sleep=lambda _:None,**kw)
def error(fn):
    try:fn()
    except ex.ExportError as exc:return str(exc)
    return None
`;
function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('dry-run is default: exact producer graph, no network, credentials or writes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); before={str(p):p.read_bytes() for p in root.rglob('*.json')}
    output=root/'delivery'; env={**os.environ,'SELFLEARN_NFL_INGEST_TOKEN':TOKEN}
    run=subprocess.run([sys.executable,'scripts/export_learning.py','--snapshots',str(snapshots),
         '--base-url','http://not-allowed.invalid?token='+TOKEN,'--out-dir',str(output)],capture_output=True,text=True,env=env)
    plan=ex.plan(snapshots)
    print(json.dumps({'code':run.returncode,'summary':json.loads(run.stdout),'no_output':not output.exists(),
      'unchanged':before=={str(p):p.read_bytes() for p in root.rglob('*.json')},'secret_absent':TOKEN not in run.stdout+run.stderr,
      'sources':len(plan['source_objects']),'generation_id':plan['generations'][0]['request']['object_id'],
      'expected':doc['envelope_id'],'receipts':len(doc['receipts'])}))
`);
  assert.equal(r.code, 0); assert.equal(r.summary.mode, 'dry_run');
  assert.equal(r.summary.network_used, false); assert.equal(r.summary.writes, false);
  assert.equal(r.no_output, true); assert.equal(r.unchanged, true); assert.equal(r.secret_absent, true);
  assert.equal(r.sources, 3); assert.equal(r.generation_id, r.expected); assert.equal(r.receipts, 2);
});

test('sources precede generation; exact ACKs are durable and replay is network-free', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'
    first=send(plan,output,server); count=len(server.calls)
    frozen={str(p):p.read_bytes() for p in output.rglob('*.json')}
    second=send(plan,output,server)
    # A different destination must never reuse another server's ACKs.
    other=Server(); third=ex.send(plan,'https://other.invalid',output,TOKEN,transport=other,sleep=lambda _:None)
    print(json.dumps({'first':first,'second':second,'calls':count,'replay_calls':len(server.calls)-count,
      'immutable':all(p.read_bytes()==frozen[str(p)] for p in output.rglob('*.json') if str(p) in frozen),
      'other_calls':len(other.calls),'other_ok':third['ok'],
      'order':[q.get('kind','finalize') for _,q in server.calls]}))
`);
  assert.equal(r.first.ok, true); assert.equal(r.first.objects_acked, 4);
  assert.equal(r.first.generations_acked, 1); assert.equal(r.first.receipts_acked, 2);
  assert.equal(r.calls, 5); assert.equal(r.replay_calls, 0); assert.equal(r.second.cached_acks, 5);
  assert.equal(r.immutable, true); assert.equal(r.other_calls, 5); assert.equal(r.other_ok, true);
  assert.deepEqual(r.order, ['source_snapshot', 'source_snapshot', 'source_snapshot', 'generation', 'finalize']);
});

test('crash after server commit preserves outbox and stable IDs recover without duplicate observations', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'
    crashed=[]
    def crash(route,body):
        response=server(route,body)
        if route==ex.GENERATION_ROUTE and not crashed:
            crashed.append(True); raise KeyboardInterrupt()
        return response
    try:send(plan,output,crash)
    except KeyboardInterrupt:pass
    files_before=len(list(output.rglob('acks/*.json'))); result=send(plan,output,server)
    calls=[q['object_id'] for route,q in server.calls if route==ex.GENERATION_ROUTE]
    finalize_acks=[json.loads(p.read_text())['ack'] for p in output.rglob('acks/*.json')
                   if json.loads(p.read_text())['operation']['phase']=='generation']
    print(json.dumps({'result':result,'acked_before':files_before,'same_id':len(calls)==2 and calls[0]==calls[1],
      'committed':len(server.committed),'statuses':[r['status'] for r in finalize_acks[0]['receipts']],
      'outbox':len(list(output.rglob('outbox/*.json')))}))
`);
  assert.equal(r.acked_before, 4); assert.equal(r.result.ok, true); assert.equal(r.same_id, true);
  assert.equal(r.committed, 2); assert.deepEqual(r.statuses, ['duplicate', 'duplicate']); assert.equal(r.outbox, 5);
});

test('source, manifest, filename and receipt-reference tampering fail before any send', () => {
  const r = py(`
results={}
for kind in ('source','envelope','manifest','filename','references','missing_source'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); file=next((snapshots/'learning_journal').rglob('*.json'))
        if kind=='source':next((snapshots/'learning_sources').glob('*.json')).write_text('{}')
        if kind=='envelope':doc['week']=5
        if kind=='manifest':doc['generations'][0]['selection_policy_version']='changed'
        if kind=='filename':file.rename(file.with_name('f'*64+'.json'))
        if kind=='references':doc['generations'][0]['receipt_ids']=[]
        if kind=='missing_source':next((snapshots/'learning_sources').glob('*.json')).unlink()
        if kind in ('envelope','manifest','references'):
            if kind!='envelope':doc['envelope_id']=ex.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'})
            file.write_text(json.dumps(doc))
        results[kind]=error(lambda:ex.plan(snapshots))
print(json.dumps(results))
`);
  assert.equal(r.source, 'source_hash_mismatch'); assert.equal(r.envelope, 'envelope_hash_mismatch');
  assert.equal(r.manifest, 'generation_hash_or_filename_mismatch');
  assert.equal(r.filename, 'generation_hash_or_filename_mismatch');
  assert.equal(r.references, 'invalid_receipt_references'); assert.equal(r.missing_source, 'missing_or_unreadable_object');
});

test('missing, mismatched, non-durable and duplicate ACK IDs never mark a generation complete', () => {
  const r = py(`
results={}
for kind in ('missing','wrong_object','not_durable','duplicate','unknown','missing_source_id','duplicate_generic','empty_response'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'
        def bad(route,body):
            status,raw=server(route,body); ack=json.loads(raw)
            if route==ex.GENERATION_ROUTE:
                if kind=='missing':ack['receipts'].pop()
                if kind=='wrong_object':ack['object_id']=ex.fingerprint('wrong')
                if kind=='not_durable':ack['durable']=1
                if kind=='duplicate':ack['receipts'][1]=copy.deepcopy(ack['receipts'][0])
                if kind=='unknown':ack['receipts'][0]['source_receipt_id']=ex.fingerprint('unknown')
                if kind=='missing_source_id':del ack['receipts'][0]['source_receipt_id']
                if kind=='duplicate_generic':ack['receipts'][1]['receipt_id']=ack['receipts'][0]['receipt_id']
                if kind=='empty_response':return 200,b''
            return status,ex.encoded(ack)
        result=send(plan,output,bad)
        results[kind]={'result':result,'acks':len(list(output.rglob('acks/*.json'))),'failures':len(list(output.rglob('failures/*.json')))}
print(json.dumps(results))
`);
  for (const row of Object.values(r)) {
    assert.equal(row.result.ok, false); assert.equal(row.result.generations_acked, 0);
    assert.equal(row.acks, 4); assert.equal(row.failures, 1);
  }
  assert.equal(r.missing.result.failures[0].reason, 'missing_receipt_ack');
});

test('partial server rejection is durable and remains non-successful on replay', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'
    def partial(route,body):
        status,raw=server(route,body); ack=json.loads(raw)
        if route==ex.GENERATION_ROUTE:
            rejected=ack['receipts'].pop(); ack['rejections']=[{'source_receipt_id':rejected['source_receipt_id'],'reason':'invalid_timestamp'}]
        return status,ex.encoded(ack)
    first=send(plan,output,partial); calls=len(server.calls); second=send(plan,output,partial)
    reasons=[json.loads(p.read_text())['ack'].get('rejections') for p in output.rglob('acks/*.json')]
    print(json.dumps({'first':first,'second':second,'calls_after_replay':len(server.calls)-calls,
                     'reason_saved':any(r and r[0]['reason']=='invalid_timestamp' for r in reasons)}))
`);
  assert.equal(r.first.ok, false); assert.equal(r.first.receipts_acked, 1); assert.equal(r.first.receipts_rejected, 1);
  assert.equal(r.second.ok, false); assert.equal(r.calls_after_replay, 0); assert.equal(r.reason_saved, true);
});

test('only transport/429/5xx retry; redirects, conflicts and auth failures never leak credentials', () => {
  const r = py(`
results={}
for kind in ('transport','429','503','302','409','401'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'; tries={}
        def faulty(route,body):
            key=(route,json.loads(body)['object_id']); tries[key]=tries.get(key,0)+1
            if kind=='transport' and tries[key]==1:raise OSError(TOKEN)
            if kind in ('429','503') and tries[key]==1:return int(kind),TOKEN.encode()
            if kind in ('302','409','401'):return int(kind),TOKEN.encode()
            return server(route,body)
        result=send(plan,output,faulty)
        saved=''.join(p.read_text() for p in output.rglob('*.json'))
        results[kind]={'ok':result['ok'],'max_tries':max(tries.values()),'secret_absent':TOKEN not in saved+json.dumps(result),
          'failure':result['failures'][0]['reason'] if result['failures'] else None,'acks':len(list(output.rglob('acks/*.json')))}
# The actual urllib redirect handler rejects before a second request is built.
redirect=error(lambda:ex._NoRedirect().redirect_request(None,None,302,'redirect',{},'https://evil.invalid'))
print(json.dumps({'results':results,'redirect':redirect}))
`);
  for (const key of ['transport', '429', '503']) {
    assert.equal(r.results[key].ok, true); assert.equal(r.results[key].max_tries, 2);
  }
  for (const key of ['302', '409', '401']) {
    assert.equal(r.results[key].ok, false); assert.equal(r.results[key].max_tries, 1); assert.equal(r.results[key].acks, 0);
  }
  for (const row of Object.values(r.results)) assert.equal(row.secret_absent, true);
  assert.equal(r.redirect, 'redirect_rejected');
});

test('retry budget, explicit send configuration, payload limit and immutable conflicts fail closed', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); output=root/'delivery'; calls=[]
    def unavailable(route,body):calls.append(route); return 503,b''
    exhausted=send(plan,output,unavailable,attempts=2)
    invalid_urls=[error(lambda u=u:ex.base_url(u)) for u in ('http://x.invalid','https://user:pass@x.invalid',
                   'https://x.invalid?token='+TOKEN,'https://x.invalid/#fragment')]
    missing_token=error(lambda:ex.send(plan,'https://x.invalid',root/'empty',None,transport=Server()))
    overlap=error(lambda:send(plan,snapshots/'delivery',Server()))
    huge=error(lambda:ex._request('source_snapshot',ex.fingerprint('big'),{'data':'x'*ex.MAX_BODY_BYTES}))
    server=Server(); successful=root/'good'; send(plan,successful,server)
    stored=next(successful.rglob('outbox/*.json')); before=stored.read_bytes(); stored.write_text('{}')
    conflict=send(plan,successful,server)
    print(json.dumps({'exhausted':exhausted,'calls':len(calls),'urls':invalid_urls,'token':missing_token,
      'overlap':overlap,'huge':huge,'conflict':conflict,'not_replaced':stored.read_text()=='{}',
      'snapshots_preserved':len(list((snapshots/'learning_journal').rglob('*.json')))==1}))
`);
  assert.equal(r.exhausted.ok, false); assert.equal(r.calls, 6, 'three sources, two bounded attempts each');
  assert.ok(r.urls.every(reason => reason === 'invalid_https_base_url'));
  assert.equal(r.token, 'missing_or_invalid_ingest_token'); assert.equal(r.overlap, 'delivery_directory_overlaps_sports_data');
  assert.equal(r.huge, 'object_body_exceeds_3_mib'); assert.equal(r.conflict.ok, false);
  assert.equal(r.not_replaced, true); assert.equal(r.snapshots_preserved, true);
});

test('CLI explicit-send errors are nonzero and do not print the token', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root)
    run=subprocess.run([sys.executable,'scripts/export_learning.py','--snapshots',str(snapshots),'--send',
        '--base-url','https://fixture.invalid?token='+TOKEN,'--out-dir',str(root/'delivery')],
        capture_output=True,text=True,env={**os.environ,'SELFLEARN_NFL_INGEST_TOKEN':TOKEN})
    invalid_arg=subprocess.run([sys.executable,'scripts/export_learning.py','--token',TOKEN],capture_output=True,text=True)
    print(json.dumps({'code':run.returncode,'secret_absent':TOKEN not in run.stdout+run.stderr+invalid_arg.stdout+invalid_arg.stderr,
                     'invalid_arg_code':invalid_arg.returncode,
                     'reason':json.loads(run.stderr)['reason'],'no_output':not (root/'delivery').exists()}))
`);
  assert.equal(r.code, 1); assert.equal(r.secret_absent, true); assert.equal(r.reason, 'invalid_https_base_url');
  assert.equal(r.no_output, true); assert.equal(r.invalid_arg_code, 2);
});

test('tampered plans and oversized producer graphs preserve the existing delivery outbox', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); output=root/'delivery'
    server=Server(); send(plan,output,server)
    before={str(p):p.read_bytes() for p in output.rglob('*.json')}
    changed=copy.deepcopy(plan); changed['generations'][0]['expected_receipt_ids']=[]
    mutation=error(lambda:send(changed,output,server))
    # Validly hashed but too large source; no existing local data is replaced.
    pool_path=snapshots/'learning_sources'/(doc['generations'][0]['source_snapshots']['leg_pool'].split(':')[1]+'.json')
    pool=json.loads(pool_path.read_text()); pool['oversized_fixture']='x'*ex.MAX_BODY_BYTES
    schedule_path=snapshots/'learning_sources'/(doc['generations'][0]['source_snapshots']['schedule'].split(':')[1]+'.json')
    journal.record(pool,json.loads(schedule_path.read_text()),None,[],NOW,str(snapshots))
    oversize=error(lambda:ex.plan(snapshots))
    print(json.dumps({'mutation':mutation,'oversize':oversize,'calls':len(server.calls),
      'outbox_unchanged':before=={str(p):p.read_bytes() for p in output.rglob('*.json')},
      'generations_retained':len(list((snapshots/'learning_journal').rglob('*.json')))}))
`);
  assert.equal(r.mutation, 'plan_changed_since_validation'); assert.equal(r.oversize, 'object_body_exceeds_3_mib');
  assert.equal(r.calls, 5); assert.equal(r.outbox_unchanged, true); assert.equal(r.generations_retained, 2);
});

test('control bytes, malformed hostnames and overflowing JSON fail with safe machine codes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server(); output=root/'delivery'
    tokens=[error(lambda token=token:ex.send(plan,'https://fixture.invalid',output,token,transport=server))
            for token in ('secret'+chr(0)+'value','secret'+chr(31)+'value','secret'+chr(127)+'value','nonascii-'+chr(233))]
    urls=[error(lambda url=url:ex.base_url(url)) for url in
          ('https://bad'+chr(0)+'.invalid','https://x.invalid:0','https://-bad.invalid',
           'https://bad..invalid','https://bad.invalid..','https://[fe80::1%25en0]')]
    overflow=error(lambda:ex._json(b'{"n":1e999}'))
    duplicate=error(lambda:ex._json(b'{"n":1,"n":2}'))
    nested=error(lambda:ex._json(('['*2000+'0'+']'*2000).encode()))
    at_limit=ex._json(('['*ex.MAX_JSON_DEPTH+'0'+']'*ex.MAX_JSON_DEPTH).encode())
    over_limit=error(lambda:ex._json(('['*(ex.MAX_JSON_DEPTH+1)+'0'+']'*(ex.MAX_JSON_DEPTH+1)).encode()))
    quoted=ex._json(ex.encoded({'quoted':'['*1000+'\\"'+']'*1000}))
    print(json.dumps({'tokens':tokens,'urls':urls,'overflow':overflow,'duplicate':duplicate,'nested':nested,
      'at_limit':isinstance(at_limit,list),'over_limit':over_limit,'quoted':len(quoted['quoted'])>2000,
      'no_output':not output.exists(),'calls':len(server.calls),
      'canonical':ex.base_url('https://EXAMPLE.invalid:443/'),'ipv6':ex.base_url('https://[::1]:8443')}))
`);
  assert.ok(r.tokens.every(code => code === 'missing_or_invalid_ingest_token'));
  assert.ok(r.urls.every(code => code === 'invalid_https_base_url'));
  for (const key of ['overflow', 'duplicate', 'nested']) assert.equal(r[key], 'invalid_json');
  assert.equal(r.at_limit, true); assert.equal(r.over_limit, 'invalid_json'); assert.equal(r.quoted, true);
  assert.equal(r.no_output, true); assert.equal(r.calls, 0);
  assert.equal(r.canonical, 'https://example.invalid'); assert.equal(r.ipv6, 'https://[::1]:8443');
});

test('delivery directory and cached ACK symlinks cannot redirect writes or bypass receipt validation', () => {
  const r = py(`
results={}
for kind in ('target','outbox','acks','failures','ack_file','outbox_file'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); server=Server()
        output=root/'delivery'; output.mkdir(); outside=root/'outside'; outside.mkdir()
        sentinel=outside/'sentinel.json'; sentinel.write_text('{"untouched":true}')
        target=output/ex.fingerprint({'base_url':'https://fixture.invalid'}).split(':')[1]
        if kind=='target':target.symlink_to(outside,target_is_directory=True)
        else:
            target.mkdir()
            if kind in ('outbox','acks','failures'):(target/kind).symlink_to(outside,target_is_directory=True)
            else:
                request=plan['source_objects'][0]
                operation={'version':1,'destination_id':ex.fingerprint({'base_url':'https://fixture.invalid'}),
                  'phase':'object','object_id':request['object_id'],'kind':request['kind']}
                subdir='acks' if kind=='ack_file' else 'outbox'; (target/subdir).mkdir()
                (target/subdir/(ex.fingerprint(operation).split(':')[1]+'.json')).symlink_to(sentinel)
        before={str(p):p.read_bytes() for p in outside.rglob('*') if p.is_file()}
        try:
            result=send(plan,output,server)
            reason=result['failures'][0]['reason'] if result['failures'] else None
        except ex.ExportError as exc:reason=str(exc)
        results[kind]={'reason':reason,'calls':len(server.calls),
          'outside_unchanged':before=={str(p):p.read_bytes() for p in outside.rglob('*') if p.is_file()}}
print(json.dumps(results))
`);
  for (const row of Object.values(r)) {
    assert.equal(row.reason, 'delivery_symlink_rejected'); assert.equal(row.outside_unchanged, true);
    assert.equal(row.calls, 0);
  }
});

test('remote diagnostics are discarded, invalid JSON is not retried, and invalid HTTP statuses fail closed', () => {
  const r = py(`
results={}
for kind in ('diagnostics','overflow','duplicate_key','bool_status'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); output=root/'delivery'; server=Server(); calls=[]
        def response(route,body):
            calls.append(route)
            status,raw=server(route,body)
            if kind=='overflow':return 200,b'{"n":1e999}'
            if kind=='duplicate_key':return 200,b'{"durable":true,"durable":false}'
            if kind=='bool_status':return True,raw
            ack=json.loads(raw); ack['diagnostics']={'authorization':TOKEN}; return status,ex.encoded(ack)
        result=send(plan,output,response)
        saved=''.join(p.read_text() for p in output.rglob('*.json'))
        results[kind]={'ok':result['ok'],'calls':len(calls),'secret_absent':TOKEN not in saved+json.dumps(result),
          'reason':result['failures'][0]['reason'] if result['failures'] else None}
print(json.dumps(results))
`);
  assert.equal(r.diagnostics.ok, true); assert.equal(r.diagnostics.calls, 5);
  for (const key of ['overflow', 'duplicate_key', 'bool_status']) {
    assert.equal(r[key].ok, false); assert.equal(r[key].calls, 3, 'one attempt for each independent source');
  }
  assert.equal(r.overflow.reason, 'invalid_json'); assert.equal(r.duplicate_key.reason, 'invalid_json');
  assert.equal(r.bool_status.reason, 'invalid_http_status');
  for (const row of Object.values(r)) assert.equal(row.secret_absent, true);
});

test('default CLI cannot read credentials or construct a network transport', () => {
  const r = py(`
import contextlib, io
from unittest.mock import patch
original_environment=ex.os.environ
class ForbiddenEnvironment:
    def get(self,key,*args):
        if key.startswith(('SELFLEARN','SUPABASE','VERCEL')):raise AssertionError('dry run read credentials')
        return original_environment.get(key,*args)
    def __getitem__(self,key):
        if key.startswith(('SELFLEARN','SUPABASE','VERCEL')):raise AssertionError('dry run read credentials')
        return original_environment[key]
def forbidden_transport(*args):raise AssertionError('dry run built a transport')
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); snapshots,doc=fixture(root)
    before={str(p):p.read_bytes() for p in root.rglob('*.json')}; stream=io.StringIO()
    with patch.object(ex.os,'environ',ForbiddenEnvironment()), patch.object(ex,'http_transport',forbidden_transport), contextlib.redirect_stdout(stream):
        code=ex.main(['--snapshots',str(snapshots),'--base-url','not-even-a-url','--out-dir',str(root/'unused')])
    print(json.dumps({'code':code,'summary':json.loads(stream.getvalue()),
      'unchanged':before=={str(p):p.read_bytes() for p in root.rglob('*.json')},'no_output':not (root/'unused').exists()}))
`);
  assert.equal(r.code, 0); assert.equal(r.summary.mode, 'dry_run');
  assert.equal(r.unchanged, true); assert.equal(r.no_output, true);
});

test('benign concurrent ACK status/order differences recover; contradictory durable mappings remain failed on replay', () => {
  const r = py(`
results={}
for kind in ('equivalent','conflicting'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); output=root/'delivery'; server=Server()
        destination_id=ex.fingerprint({'base_url':'https://fixture.invalid'}); raced=[]
        def concurrent(route,body):
            status,raw=server(route,body)
            if route==ex.GENERATION_ROUTE and not raced:
                raced.append(True); ack=json.loads(raw)
                operation={'version':1,'destination_id':destination_id,'phase':'generation','object_id':ack['object_id']}
                rival=copy.deepcopy(ack); rival['receipts'].reverse()
                for row in rival['receipts']:row['status']='duplicate'
                if kind=='conflicting':rival['receipts'][0]['receipt_id']=ex.fingerprint('different-mapping')
                path=output.resolve()/destination_id.split(':')[1]/'acks'/(ex.fingerprint(operation).split(':')[1]+'.json')
                ex._immutable(path,{'operation':operation,'ack':rival},root=output.resolve())
            return status,raw
        first=send(plan,output,concurrent); calls=len(server.calls)
        before={str(p):p.read_bytes() for p in output.rglob('*.json')}
        second=send(plan,output,concurrent)
        results[kind]={'first':first,'second':second,'replay_calls':len(server.calls)-calls,
          'unchanged':before=={str(p):p.read_bytes() for p in output.rglob('*.json')},'committed':len(server.committed)}
print(json.dumps(results))
`);
  assert.equal(r.equivalent.first.ok, true); assert.equal(r.equivalent.second.ok, true);
  assert.equal(r.equivalent.first.generations_acked, 1); assert.equal(r.equivalent.committed, 2);
  assert.equal(r.conflicting.first.ok, false); assert.equal(r.conflicting.second.ok, false);
  assert.equal(r.conflicting.second.generations_acked, 0);
  assert.equal(r.conflicting.second.failures[0].reason, 'immutable_delivery_conflict');
  for (const row of Object.values(r)) { assert.equal(row.replay_calls, 0); assert.equal(row.unchanged, true); }
});

test('canonical JSON integrity distinguishes booleans and floats from integer versions', () => {
  const r = py(`
results={}
for kind in ('boolean_plan','float_plan','boolean_outbox','boolean_ack_operation'):
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp); snapshots,doc=fixture(root); plan=ex.plan(snapshots); output=root/'delivery'; server=Server()
        if kind.endswith('_plan'):
            changed=copy.deepcopy(plan); changed['version']=True if kind=='boolean_plan' else 1.0
            reason=error(lambda:send(changed,output,server)); result=None
        else:
            send(plan,output,server)
            subdir='outbox' if kind=='boolean_outbox' else 'acks'
            stored=next(output.rglob(subdir+'/*.json')); content=json.loads(stored.read_text())
            content['operation']['version']=True; stored.write_text(json.dumps(content)); before=stored.read_bytes()
            result=send(plan,output,server); reason=result['failures'][0]['reason']
        results[kind]={'reason':reason,'calls':len(server.calls),
          'preserved':True if kind.endswith('_plan') else stored.read_bytes()==before}
print(json.dumps(results))
`);
  for (const key of ['boolean_plan', 'float_plan']) {
    assert.equal(r[key].reason, 'plan_changed_since_validation'); assert.equal(r[key].calls, 0);
  }
  for (const key of ['boolean_outbox', 'boolean_ack_operation']) {
    assert.equal(r[key].reason, 'immutable_delivery_conflict'); assert.equal(r[key].calls, 5);
    assert.equal(r[key].preserved, true);
  }
});
