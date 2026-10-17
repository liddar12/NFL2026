import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url);
function py(body) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8',
    timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    input: `import copy,json\nfrom scripts import my_freshness as M\nfrom tests.fixtures import period_eligibility as F\nf=F.make(qb=True,window=True)\ns={k:f['docs'][k]for k in M.SOURCE_NAMES}\n` + body }).trim().split('\n').at(-1));
}

test('selected policy filters the real pool without repricing and verifies deterministically', () => {
  const r = py(String.raw`
before=copy.deepcopy(f['pool']);sources=copy.deepcopy(s)
p=M.apply(f['pool'],s)
assert before==f['pool']and sources==s
assert M.apply(p,s)==p
original={x['gsis_id']:x for x in before['players']}
assert all(x==original[x['gsis_id']]for x in p['players'])
assert p['game_legs']==before['game_legs']and p['atd_legs']==before['atd_legs']
print(json.dumps({'ids':[x['gsis_id']for x in p['players']],'policy':p['freshness_policy'],
 'check':M.verify(p,s,checked_utc=F.CHECKED)}))
`);
  assert.ok(r.ids.includes('espn-1') && r.ids.includes('espn-2'));
  assert.equal(r.policy.profile, 'provisional_before_90m_v1');
  assert.equal(r.check.consumer_policy_pass, true);
  assert.equal(r.check.inactive_confirmation_verified, false);
  assert.equal(r.check.publication_authorized, false);
});

test('selected policy ends exactly at90minutes and rejects an earlier saved pool after cutoff', () => {
  const r = py(String.raw`
p=M.apply(f['pool'],s);rows=[]
for clock in('2026-10-16T20:29:59Z','2026-10-16T20:30:00Z'):
 q=copy.deepcopy(f['pool']);q['generated_utc']=clock
 rows.append({'check':M.verify(p,s,checked_utc=clock),'built':M.apply(q,s)})
print(json.dumps(rows))
`);
  assert.equal(r[0].check.consumer_policy_pass, true);
  assert.equal(r[1].check.consumer_policy_pass, false);
  assert.ok(r[0].built.players.length > 0);
  assert.deepEqual(r[1].built.players, []);
});

test('bad QB depth withholds only affected QBs, with per-player deadlines on healthy sources', () => {
  const r = py(String.raw`
fresh=M.apply(f['pool'],s)
s['depth_chart']['teams']['SEA']['snapshot']='2026-10-16'
bad=M.apply(f['pool'],s)
print(json.dumps({'fresh':fresh,'bad':bad}))
`);
  const game = r.fresh.freshness_policy.games.find(g => g.game_id === 'SOURCE-G1');
  assert.ok(game.player_source_expires['espn-1']);
  assert.equal(game.state, 'provisional');
  assert.ok(!r.bad.players.some(p => p.gsis_id === 'espn-1'));
  assert.ok(r.bad.players.some(p => p.gsis_id === 'espn-2'));
  assert.ok(r.bad.players.some(p => p.gsis_id === 'espn-3'));
});

test('fresh empty/nonempty inactive arrays and uploaded complete flags never clear the checkpoint', () => {
  const r = py(String.raw`
rows=[]
for empty in(False,True):
 d=F.make(qb=True,inactive=True,window=True)['docs']
 source={k:d[k]for k in M.SOURCE_NAMES}
 source['inactives'].update(posted=True,official_complete=True)
 if empty:source['inactives']['games'][0]['inactive']={'SEA':[],'LAR':[]}
 p=copy.deepcopy(f['pool']);p['generated_utc']='2026-10-16T20:30:00Z'
 rows.append(M.apply(p,source))
print(json.dumps(rows))
`);
  assert.ok(r.every(p => p.players.length === 0 && p.freshness_policy.games.every(g => g.state === 'held')));
});

test('stale or wrong-period sources cannot offer props, and metadata cannot be forged', () => {
  const r = py(String.raw`
p=M.apply(f['pool'],s);rows=[]
for name in('injuries','player_weekly','game_predictions'):
 source=copy.deepcopy(s)
 if name=='injuries':source[name]['received_utc']='2026-10-15T19:00:00Z'
 elif name=='game_predictions':source[name]['week']=5
 else:source[name]['updated_utc']='2026-10-16T20:02:00Z'
 rows.append(M.apply(f['pool'],source)['players'])
q=copy.deepcopy(p);q['freshness_policy']['games'][0]['check_due_utc']='2026-10-20T00:00:00Z'
print(json.dumps({'held':rows,'forged':M.verify(q,s,checked_utc=F.CHECKED)}))
`);
  assert.ok(r.held.every(x => x.length === 0));
  assert.equal(r.forged.consumer_policy_pass, false);
});

test('actual selected period producer retains original source bytes and replays the policy-bound pool', (t) => {
  const engine = process.env.SELFLEARN_CHECKOUT;
  if (!engine || !existsSync(`${engine}/packages/selflearn-core/selflearn_core/store/file_owner_intents.py`)) {
    t.skip('Explicit shared engine checkout required'); return;
  }
  const r = JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8',
    timeout: 120000, maxBuffer: 3 * 1024 * 1024, input: String.raw`
import contextlib,io,json,os,pathlib,shutil,tempfile
from scripts import build_leg_pool as B,run_parlay_feedback as F,learning_receipts as L,my_freshness as M
from scripts import generation_capture_runtime as C,period_operator as O
from scripts.period_calibrator import PeriodCalibrator
from tests.fixtures import period_return as fixture
from tests.fixtures.period_eligibility import complete_period_current
engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=F.git(engine,'rev-parse','HEAD')
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp)/'checkout';root.mkdir();data=root/'data'
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,target)
 cfg=root/'config/excluded_games.json';cfg.parent.mkdir(parents=True);shutil.copyfile(F.ROOT/'config/excluded_games.json',cfg)
 fixture.training(data,engine,pin)
 current,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=24,tag='selected-freshness',past=True)
 witness,depth=complete_period_current(current,schedule)
 fixture.write_inputs(data,current,schedule);fixture.write(data/'leg_pool.json',B.build(current))
 fixture.write(data/'injuries.json',witness);fixture.write(data/'depth_chart.json',depth)
 now=['2026-10-16T20:01:00Z']
 control=PeriodCalibrator(data_dir=data,engine_checkout=engine,engine_commit=pin,
  authority_id=L.fingerprint('synthetic-selected-authority'),actor_ref='synthetic-operator',
  clock=lambda:now[0],freshness_profile=M.PROFILE)
 oid=control.prepare(season=2026,week=6)
 control.record_intent(oid,action='approve',expires_utc='2026-10-20T00:00:00Z',
  reason='Synthetic mechanics only',acknowledge_retrospective=True)
 now[0]='2026-10-16T20:02:00Z'
 args=['--data-dir',str(data),'--engine-checkout',str(engine),'--engine-commit',pin,
  '--authority-id',control.authority_id,'--actor-ref',control.actor_ref,'--freshness-profile',M.PROFILE,
  'apply-my','--generation-sha','synthetic-selected-code','--capture-dir',str(pathlib.Path(tmp)/'private')]
 out=io.StringIO()
 with contextlib.redirect_stdout(out):code=O.main(args,clock=lambda:now[0])
 assert code==0,out.getvalue()
 _,app,pool=control.current();original=control._inputs(app['input_capture_id'])
 assert {'injuries','depth_chart','inactives'}<=set(original['files'])
 assert original['files']['inactives']['state']=='absent_optional'
 assert 'my_freshness_sources'in original['inputs']
 assert control.reverify()['application_id']==app['application_id']
 link=json.loads(control.path('generations',json.loads(out.getvalue())['period_generation_id'][7:]+'.json').read_bytes())
 capture=link['runtime_binding']['loader']['capture']
 assert original['files']['injuries']['raw_utf8']==capture['inputs']['injuries']['raw_utf8']
 assert pool['players'] and all(g['state']=='provisional'for g in pool['freshness_policy']['games']if g['game_id']in {p['game_id']for p in pool['players']})
 report=M.verify(pool,original['inputs']['my_freshness_sources'],checked_utc=now[0])
 assert report['consumer_policy_pass'],report
 print(json.dumps({'players':len(pool['players']),'replayed':True,'policy':pool['freshness_policy']['profile']}))
` }));
  assert.ok(r.players > 0);
  assert.equal(r.replayed, true);
});
