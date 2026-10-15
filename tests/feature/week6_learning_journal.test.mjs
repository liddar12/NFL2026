import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy, json, math, pathlib, tempfile
from scripts import learning_journal as journal, learning_receipts as lr, build_my_cards as cards
T0='2026-10-15T14:00:00Z'
NOW='2026-10-15T14:01:00Z'
KICK='2026-10-16T00:15:00Z'
def fixture(created=T0):
    pool=cards._fixture_pool(created); pool['week']=6; pool['base_model_version']='fixture-base'
    for player in pool['players']:
        for rung in player['rungs']:
            z=(player['mu']-rung['line'])/30
            calibration={'a':math.log(rung['model_prob']/(1-rung['model_prob'])),'b':0,'c':0}
            features={'market':player['market'],'line':rung['line'],'mu':player['mu'],
                      'sd':30,'z':z,'p_team':player['p_team'],'calibration':calibration,
                      'correlation_tags':['game:'+player['game_id']]}
            context={'season':2026,'week':6,'base_model_version':'fixture-base',
                     'forecast_created_utc':created,'source_snapshot_id':lr.fingerprint({'created':created}),
                     'source_timestamps':{'fixture':created},'generation_sha':'fixture'}
            base=lr.base_probability(calibration,z,player['p_team'])
            receipt=lr.make_receipt({**player,**rung},base,None,context,features=features)
            rung.update(model_prob=receipt['served_prob'],learning_receipt=receipt)
    schedule={'season':2026,'games':[{'game_id':gid,'week':6,'status':'STATUS_SCHEDULED',
              'kickoff_utc':KICK} for gid in ('G1','G2')]}
    return pool,schedule
def records(pool,schedule):
    offered,_=cards.offered_cards(pool,schedule['games'],None,pool['generated_utc'])
    return [cards.card_record(d,s,r,c,cards.kickoff_index(schedule['games'])) for d,s,r,c in offered]
def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value))
def reseal(receipt):
    receipt['receipt_id']=lr.fingerprint({k:v for k,v in receipt.items() if k!='receipt_id'})
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('an already-recorded display generation still journals receipts first; replay changes neither history nor time', () => {
  const r = py(`
pool,schedule=fixture(); modern=records(pool,schedule)
legacy=copy.deepcopy(modern)
for card in legacy:
    for leg in card['legs']:
        for key in ('learning_receipt','season','direction','comparison_operator'):leg.pop(key,None)
archive=cards.append(None,legacy,2026,6,T0,NOW)
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); output=root/'my_cards'; snapshots=root/'snapshots'
    path=output/'2026_wk06.json'; write(path,archive); before=path.read_bytes()
    write(root/'pool.json',pool); write(root/'schedule.json',schedule)
    args=dict(pool_path=str(root/'pool.json'),schedule_path=str(root/'schedule.json'),
              calibration_path=str(root/'missing-calibration.json'),out_dir=str(output),snapshot_dir=str(snapshots))
    _,changed=cards.run(**args,now=NOW)
    files=sorted(snapshots.rglob('*.json')); saved={str(p):p.read_bytes() for p in files}
    envelope=json.loads(next((snapshots/'learning_journal').rglob('*.json')).read_text())
    _,changed2=cards.run(**args,now='2026-10-17T14:00:00Z')
    all_rungs=sum(len(p['rungs']) for p in pool['players'])
    print(json.dumps({'display_unchanged':path.read_bytes()==before,'changed':changed,'changed2':changed2,
      'immutable_replay':all(p.read_bytes()==saved[str(p)] for p in files),
      'all_rungs':all_rungs,'receipts':len(envelope['receipts']),
      'offered_cards':len(envelope['generations'][0]['offered_cards']),'display_cards':len(archive['cards']),
      'generation':envelope['generations'][0],
      'recorded_times':sorted({r['recorded_utc'] for r in envelope['receipts']}),
      'receipt_equal':all(r['learning_receipt']['receipt_id']==r['receipt_id'] for r in envelope['receipts'])}))
`);
  assert.equal(r.display_unchanged, true);
  assert.equal(r.changed, false);
  assert.equal(r.changed2, false);
  assert.equal(r.immutable_replay, true);
  assert.equal(r.receipts, r.all_rungs);
  assert.ok(r.receipts > 0);
  assert.equal(r.offered_cards, r.display_cards);
  assert.deepEqual(r.recorded_times, ['2026-10-15T14:01:00Z']);
  assert.equal(r.receipt_equal, true);
  assert.equal(r.generation.publication_status, 'generated_unverified');
  assert.equal(r.generation.population, 'eligible_pool_prop_rungs_before_display_dedupe');
  assert.match(r.generation.selection_policy_version, /^sha256:[a-f0-9]{64}$/);
  assert.match(r.generation.joint_model_version, /^sha256:[a-f0-9]{64}$/);
});

test('new forecasts survive the same display IDs, source snapshots dedupe, and old bases stay immutable', () => {
  const r = py(`
pool,schedule=fixture(); first=records(pool,schedule)
later,_=fixture('2026-10-15T15:00:00Z'); second=records(later,schedule)
archive=cards.append(None,first,2026,6,T0,NOW)
updated=cards.append(archive,second,2026,6,later['generated_utc'],'2026-10-15T15:01:00Z')
with tempfile.TemporaryDirectory() as tmp:
    a,_=journal.record(pool,schedule,None,first,NOW,tmp)
    b,_=journal.record(later,schedule,None,second,'2026-10-15T15:01:00Z',tmp)
    source_files=list((pathlib.Path(tmp)/'learning_sources').glob('*.json'))
    hashes_ok=all(lr.fingerprint(json.loads(p.read_text()))=='sha256:'+p.stem for p in source_files)
    print(json.dumps({'same_ids':[c['card_id'] for c in first]==[c['card_id'] for c in second],
     'cards_unchanged':updated['cards']==archive['cards'],'added':updated['runs'][-1]['cards_added'],
     'distinct_receipts':not ({r['receipt_id'] for r in a['receipts']} & {r['receipt_id'] for r in b['receipts']}),
     'generations':len(list((pathlib.Path(tmp)/'learning_journal').rglob('*.json'))),
     'source_files':len(source_files),'hashes_ok':hashes_ok,
     'first_source':a['generations'][0]['source_snapshots'],
     'second_source':b['generations'][0]['source_snapshots'],
     'policies_same':all(a['generations'][0][k]==b['generations'][0][k] for k in ('selection_policy_version','joint_model_version'))}))
`);
  assert.equal(r.same_ids, true);
  assert.equal(r.cards_unchanged, true);
  assert.equal(r.added, 0);
  assert.equal(r.distinct_receipts, true);
  assert.equal(r.generations, 2);
  assert.equal(r.source_files, 4, 'two pools plus one schedule and one calibration snapshot');
  assert.equal(r.hashes_ok, true);
  assert.equal(r.first_source.schedule, r.second_source.schedule);
  assert.notEqual(r.first_source.leg_pool, r.second_source.leg_pool);
  assert.equal(r.policies_same, true);
});

test('missing, late, malformed, wrong-period, unavailable and invented-public receipts are quarantined', () => {
  const r = py(`
results={}
for kind in ('legacy','late','before_creation','hash','identity','future_source','pool_time','base','game_week',
             'kickoff','status','conflicting_schedule','eligibility','publication'):
    pool,schedule=fixture(); pool['players']=pool['players'][:1]; pool['players'][0]['rungs']=pool['players'][0]['rungs'][:1]
    rung=pool['players'][0]['rungs'][0]; receipt=rung['learning_receipt']; recorded=NOW
    if kind=='legacy':del rung['learning_receipt']
    if kind=='late':recorded=KICK
    if kind=='before_creation':recorded='2026-10-15T13:59:59Z'
    if kind=='hash':receipt['base_prob']=.9
    if kind=='identity':pool['players'][0]['gsis_id']='wrong'
    if kind=='future_source':receipt['source_timestamps']['fixture']=NOW; reseal(receipt)
    if kind=='pool_time':pool['generated_utc']='2026-10-15T14:00:01Z'
    if kind=='base':pool['base_model_version']='another'
    if kind=='game_week':schedule['games'][0]['week']=5
    if kind=='kickoff':schedule['games'][0]['kickoff_utc']=None
    if kind=='status':schedule['games'][0]['status']='STATUS_FINAL'
    if kind=='conflicting_schedule':schedule['games'].append({**schedule['games'][0],'kickoff_utc':'2026-10-17T00:15:00Z'})
    if kind=='eligibility':receipt['input_context']={'eligibility':{'eligible':False}}; reseal(receipt)
    if kind=='publication':receipt['publication_status']='published'; reseal(receipt)
    doc,_=journal.capture(pool,schedule,None,[],recorded)
    results[kind]={'n':len(doc['receipts']),'audit':doc['generations'][0]['audit']}
print(json.dumps(results))
`);
  for (const [name, row] of Object.entries(r)) {
    assert.equal(row.n, 0, name);
    assert.equal(row.audit.quarantined_records, 1, name);
    assert.equal(Object.keys(row.audit.quarantine_reasons).length, 1, name);
  }
});

test('journal never repairs historical bases or overwrites a tampered immutable snapshot', () => {
  const r = py(`
pool,schedule=fixture()
for p in pool['players']:
    for rung in p['rungs']:del rung['learning_receipt']
doc,_=journal.capture(pool,schedule,None,records(pool,schedule),NOW)
pool,schedule=fixture()
with tempfile.TemporaryDirectory() as tmp:
    journal.record(pool,schedule,None,records(pool,schedule),NOW,tmp)
    source=next((pathlib.Path(tmp)/'learning_sources').glob('*.json'))
    source.write_text('{}'); rejected=False
    try:journal.record(pool,schedule,None,records(pool,schedule),NOW,tmp)
    except ValueError:rejected=True
    print(json.dumps({'legacy_receipts':len(doc['receipts']),
      'legacy_audit':doc['generations'][0]['audit'],'rejected':rejected,'not_repaired':source.read_text()=='{}'}))
`);
  assert.equal(r.legacy_receipts, 0);
  assert.ok(r.legacy_audit.quarantine_reasons.missing_or_unsupported_receipt > 0);
  assert.equal(r.rejected, true);
  assert.equal(r.not_repaired, true);
});

test('capture detaches source payloads and keeps duplicate receipt copies as one forecast', () => {
  const r = py(`
pool,schedule=fixture(); pool['players']=[pool['players'][0]]
pool['players'][0]['rungs']=[pool['players'][0]['rungs'][0]]
pool['players'].append(copy.deepcopy(pool['players'][0]))
doc,sources=journal.capture(pool,schedule,None,[],NOW)
frozen=copy.deepcopy(doc); source_copy=copy.deepcopy(sources)
pool['players'][0]['rungs'][0]['learning_receipt']['base_prob']=.99
schedule['games'][0]['kickoff_utc']='2027-01-01T00:00:00Z'
print(json.dumps({'n':len(doc['receipts']),'candidates':doc['generations'][0]['audit']['candidate_rungs'],
 'detached':doc==frozen and sources==source_copy,
 'source_hashes':all(lr.fingerprint(v)==k for k,v in sources.items())}))
`);
  assert.equal(r.n, 1);
  assert.equal(r.candidates, 2);
  assert.equal(r.detached, true);
  assert.equal(r.source_hashes, true);
});

test('new captures require known source timestamps and quarantine malformed siblings independently', () => {
  const r = py(`
results={}
for kind,timestamps in (('empty',{}),('null',{'fixture':None})):
    pool,schedule=fixture(); pool['players']=[pool['players'][0]]
    pool['players'][0]['rungs']=[pool['players'][0]['rungs'][0]]
    source=pool['players'][0]['rungs'][0]['learning_receipt']
    source['source_timestamps']=timestamps; reseal(source)
    leg={**pool['players'][0],**pool['players'][0]['rungs'][0]}
    legacy_problem=lr.receipt_problem(source,leg,2026,6)
    doc,_=journal.capture(pool,schedule,None,[],NOW)
    results[kind]={'n':len(doc['receipts']),'audit':doc['generations'][0]['audit'],
                   'historical_verifier_unchanged':legacy_problem is None}
pool,schedule=fixture(); expected=sum(len(p['rungs']) for p in pool['players'])
pool['players'].append(None); pool['players'].append({'rungs':None})
pool['players'][0]['rungs'].append(None)
doc,_=journal.capture(pool,schedule,None,[],NOW)
results['siblings']={'n':len(doc['receipts']),'expected':expected,'audit':doc['generations'][0]['audit']}
print(json.dumps(results))
`);
  assert.equal(r.empty.n, 0);
  assert.equal(r.empty.audit.quarantine_reasons.missing_source_timestamps, 1);
  assert.equal(r.null.n, 0);
  assert.equal(r.null.audit.quarantine_reasons.invalid_timestamp, 1);
  assert.equal(r.empty.historical_verifier_unchanged, true);
  assert.equal(r.null.historical_verifier_unchanged, true);
  assert.equal(r.siblings.n, r.siblings.expected);
  assert.equal(r.siblings.audit.quarantine_reasons.invalid_pool_player, 2);
  assert.equal(r.siblings.audit.quarantine_reasons.invalid_pool_rung, 1);
  assert.equal(r.siblings.audit.quarantined_records, 3);
});

test('publisher retains distinct journal generations and refuses conflicting immutable envelopes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'week6-journal-publish-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (cwd, path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), JSON.stringify(value)); };
  const publish = (cwd) => spawnSync('bash', [join(ROOT, 'scripts/publish_data.sh'), 'test data journal'], {
    cwd, encoding: 'utf8', env: { ...process.env, PUBLISH_VALIDATE_CMD: 'true', PUBLISH_BACKOFF_S: '0', PUBLISH_ATTEMPTS: '1' },
  });
  try {
    const remote = join(temp, 'remote.git'), seed = join(temp, 'seed');
    git(temp, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    mkdirSync(seed); git(seed, 'init', '--quiet', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
    put(seed, 'data/base.json', {}); git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'base');
    git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '--quiet', 'origin', 'main');
    const clone = (name) => { const path = join(temp, name); git(temp, 'clone', '--quiet', remote, path); return path; };
    const a = clone('a'), b = clone('b');
    const first = 'data/snapshots/learning_journal/2026_wk06/first.json';
    const second = 'data/snapshots/learning_journal/2026_wk06/second.json';
    put(a, first, { captured: 'a' }); put(b, second, { captured: 'b' });
    for (const checkout of [a, b]) { const r = publish(checkout); assert.equal(r.status, 0, r.stdout + r.stderr); }
    assert.deepEqual(JSON.parse(git(temp, '--git-dir=' + remote, 'show', 'main:' + first)), { captured: 'a' });
    assert.deepEqual(JSON.parse(git(temp, '--git-dir=' + remote, 'show', 'main:' + second)), { captured: 'b' });
    const c = clone('c'), d = clone('d');
    const clash = 'data/snapshots/learning_journal/2026_wk06/same-generation.json';
    put(c, clash, { captured: 'first' }); put(d, clash, { captured: 'conflicting' });
    const cResult = publish(c); assert.equal(cResult.status, 0, cResult.stdout + cResult.stderr);
    const dResult = publish(d); assert.notEqual(dResult.status, 0);
    assert.match(dResult.stdout + dResult.stderr, /conflict on the snapshot/);
    assert.deepEqual(JSON.parse(git(temp, '--git-dir=' + remote, 'show', 'main:' + clash)), { captured: 'first' });
    assert.deepEqual(JSON.parse(readFileSync(join(d, clash), 'utf8')), { captured: 'conflicting' }, 'failed writer retains its generation');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
