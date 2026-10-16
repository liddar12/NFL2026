// Independent mechanics-only checks. Owner/evaluation data below are explicit
// synthetic claims, never authenticated approval, measured fit, or activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = readFileSync(root + 'tests/feature/week6_calibrator_materializer.test.mjs', 'utf8')
  .match(/const FIXTURE=String\.raw`([\s\S]*?)`;/)?.[1];
assert.ok(fixture, 'fixture definitions exist; author test bodies are not reused');
function py(body) {
  const p = spawnSync('python3', ['-'], { cwd: root, input: fixture + body, encoding: 'utf8',
    timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return JSON.parse(p.stdout.trim());
}

test('a linked complete owner-intent claim cannot backdate a later rollback before the known previous event', () => {
  const r = py(String.raw`
a=setup();authA=FakeAuthority(a[2]);dA=run(a,authA)['draft']
cB=candidate({'a':.4,'b':.85},'2026-09-30T00:00:00Z');rB=report(cB);ctxB=context('2026-10-01T13:00:00Z','2026-10-02T00:00:00Z',5)
currentA=M.current_pin(BASE,dA['coefficients'],artifact=dA['artifact_id'],materialization=dA['materialization_id'])
authB=FakeAuthority(ctxB,history=authA.value['events'],now='2026-10-01T12:00:00Z')
dB=run((cB,rB,ctxB,currentA,policy(rB)),authB,prior_materializations=[dA],now_utc=authB.now)['draft']
ctxC=context('2026-10-04T13:00:00Z','2026-10-05T00:00:00Z',6)
currentB=M.current_pin(BASE,dB['coefficients'],artifact=dB['artifact_id'],materialization=dB['materialization_id'])
values=(a[0],a[1],ctxC,currentB,a[4]);before=M.encoded([dA,dB,values]);rows=[]
for mode in('ordered','backdated'):
 def mutate(s):
  if mode=='backdated':
   s['events'][-1]['recorded_utc']='2026-09-26T12:00:01Z'
   reseal(s['events'][-1],'event_id');s['head_event_id']=s['events'][-1]['event_id'];reseal(s,'snapshot_id')
 authority=FakeAuthority(ctxC,history=authB.value['events'],now='2026-10-04T12:00:00Z',action='rollback',mutate=mutate)
 result=run(values,authority,prior_materializations=[dA,dB],now_utc=authority.now)
 rows.append({'mode':mode,'status':result['status'],'draft':result['draft']is not None,
  'times':[e['recorded_utc']for e in authority.value['events']],'release':result['release_authorized']})
print(json.dumps({'rows':rows,'unchanged':before==M.encoded([dA,dB,values])}))
`);
  assert.equal(r.rows[0].status, 'materialized_draft', 'ordered synthetic rollback remains mechanically supported');
  assert.equal(r.rows[1].status, 'held'); assert.equal(r.rows[1].draft, false);
  assert.ok(r.rows[1].times[2] < r.rows[1].times[1], 'plant actually regresses the later event clock');
  assert.equal(r.unchanged, true); assert.ok(r.rows.every(x => x.release === false));
});

test('negative absolute log losses cannot satisfy a report gate merely by preserving a favorable delta', () => {
  const r = py(String.raw`
rows=[]
for target in('summary','fold'):
 values=list(setup());metrics=values[1]['metrics']if target=='summary'else values[1]['folds'][0]
 metrics.update(incumbent_log_loss=-.2,candidate_log_loss=-.3,base_log_loss=-.1)
 if target=='summary':metrics['delta_log_loss']=-.1
 reseal(values[1],'report_id');values[4]=policy(values[1]);authority=FakeAuthority(values[2]);result=run(values,authority)
 rows.append({'target':target,'status':result['status'],'draft':result['draft']is not None,'callbacks':len(authority.calls)})
print(json.dumps(rows))
`);
  assert.ok(r.every(x => x.status === 'held' && x.draft === false && x.callbacks === 0));
});

test('unknown actions, reordered complete heads and expired clearance remain held even after consistent resealing', () => {
  const r = py(String.raw`
rows=[]
for mode in('unknown_action','reordered_head','expired_clearance'):
 values=setup()
 def mutate(s):
  if mode=='unknown_action':s['events'][0]['action']='silently_activate'
  elif mode=='expired_clearance':s['events'][0]['expires_utc']='2026-09-26T12:30:00Z'
  else:
   old=copy.deepcopy(s['events'][0]);old['recorded_utc']=timeplus(NOW,-3);reseal(old,'event_id')
   later=copy.deepcopy(s['events'][0]);later.update(sequence=2,previous_event_id=old['event_id']);reseal(later,'event_id')
   s.update(events=[later,old],head_sequence=2)
  for e in s['events']:reseal(e,'event_id')
  s['head_event_id']=s['events'][-1]['event_id'];reseal(s,'snapshot_id')
 result=run(values,FakeAuthority(values[2],mutate=mutate));rows.append(result)
print(json.dumps({'states':[r['status']for r in rows],'release':any(r['release_authorized']for r in rows)}))
`);
  assert.deepEqual(r.states, ['held', 'held', 'held']); assert.equal(r.release, false);
});

test('drafts and query arguments are detached; callback failures are static and cancellation is not approval', () => {
  const r = py(String.raw`
values=setup();before=M.encoded(values);authority=FakeAuthority(values[2])
def mutable_query(query):
 snapshot=authority(query);query['namespace']['domain']='mutated';query['candidate_id']=HASH('changed');return snapshot
result=run(values,mutable_query);result['draft']['coefficients']['a']=100;result['draft']['transform']['input_clip'][0]=.2
held=[];cancelled=[]
for exc in(M.MaterializationError('PRIVATE_TOKEN_DIAGNOSTIC'),RuntimeError('PRIVATE_TOKEN_DIAGNOSTIC')):
 def failed(query):raise exc
 held.append(run(values,failed))
for exc in(KeyboardInterrupt(),SystemExit(7)):
 def failed(query):raise exc
 try:run(values,failed);cancelled.append('swallowed')
 except BaseException as e:cancelled.append(type(e).__name__)
print(json.dumps({'status':result['status'],'unchanged':before==M.encoded(values),'global_clip':M.TRANSFORM['input_clip'][0],
 'held':held,'cancelled':cancelled,'diagnostic_leaked':'PRIVATE_TOKEN_DIAGNOSTIC'in json.dumps(held),
 'flags':{k:result[k]for k in M.FLAGS}}))
`);
  assert.equal(r.status, 'materialized_draft'); assert.equal(r.unchanged, true); assert.equal(r.global_clip, 0.0001);
  assert.ok(r.held.every(x => x.status === 'held' && x.draft === null)); assert.equal(r.diagnostic_leaked, false);
  assert.deepEqual(r.cancelled, ['KeyboardInterrupt', 'SystemExit']); assert.ok(Object.values(r.flags).every(v => v === false));
});
