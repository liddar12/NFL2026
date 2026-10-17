import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { poolLearningStatus, renderPoolLearning, learningCardRefusal } from '../../app/pool-learning-status.js';

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

test('unknown or misbound offered identities are row-local refusals, never a verification PASS', () => {
  const r = py(String.raw`
rows=[]
for field,value in(('gsis_id','unknown-id'),('team','DAL'),('position','RB'),('market','rb_rush_yds'),
                    ('game_id','SOURCE-G2'),('side','away')):
 original=copy.deepcopy(f['pool']);original['players'][0][field]=value
 selected=M.apply(original,s)
 forged=copy.deepcopy(M.apply(f['pool'],s));forged['players'][0][field]=value
 rows.append({'field':field,'ids':[p['gsis_id']for p in selected['players']],
              'verify':M.verify(forged,s,checked_utc=F.CHECKED)['consumer_policy_pass']})
# Moving both team and game must not bypass the source-roster binding either.
original=copy.deepcopy(f['pool']);original['players'][0].update(team='DAL',game_id='SOURCE-G2')
selected=M.apply(original,s)
rows.append({'field':'team+game','ids':[p['gsis_id']for p in selected['players']],
 'verify':M.verify({**selected,'players':original['players']},s,checked_utc=F.CHECKED)['consumer_policy_pass']})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.verify, false, row.field);
    assert.ok(!row.ids.includes('espn-1') && !row.ids.includes('unknown-id'), row.field);
    assert.ok(row.ids.includes('espn-2') && row.ids.includes('espn-3'), row.field);
  }
});

test('duplicated/malformed source player identity withholds that row without erasing unrelated players', () => {
  const r = py(String.raw`
rows=[]
for mode in('duplicate','missing_team','nonobject'):
 source=copy.deepcopy(s)
 if mode=='duplicate':source['player_projections']['players'].append(copy.deepcopy(source['player_projections']['players'][0]))
 elif mode=='missing_team':source['player_projections']['players'][0].pop('team')
 else:source['player_projections']['players'].append('malformed-row')
 selected=M.apply(f['pool'],source)
 rows.append({'mode':mode,'ids':[p['gsis_id']for p in selected['players']]})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.ok(row.ids.includes('espn-2') && row.ids.includes('espn-3'), row.mode);
    assert.equal(row.ids.includes('espn-1'), row.mode === 'nonobject', row.mode);
  }
});

test('bad team depth shape/rank holds only affected QBs, and malformed global teams never crashes or holds WRs', () => {
  const r = py(String.raw`
d=copy.deepcopy(f['docs']);p3=d['player_projections']['players'][2];p3['position']='QB'
d['depth_chart']['teams']['DAL']={'snapshot':F.SOURCE,'QB':[{'name':p3['name'],'rank':1,'gsis_id':'espn-3','espn_id':'3'}]}
d['player_weekly']=F.weekly(d);f=F.refresh(d);s={k:f['docs'][k]for k in M.SOURCE_NAMES}
rows=[]
for mode in('bad_rank','bad_row','bad_QB','bad_team','bad_teams','bad_document','bad_season'):
 source=copy.deepcopy(s)
 if mode=='bad_rank':source['depth_chart']['teams']['SEA']['QB'][0]['rank']='bad'
 elif mode=='bad_row':source['depth_chart']['teams']['SEA']['QB'][0]='bad'
 elif mode=='bad_QB':source['depth_chart']['teams']['SEA']['QB']='bad'
 elif mode=='bad_team':source['depth_chart']['teams']['SEA']='bad'
 elif mode=='bad_teams':source['depth_chart']['teams']='bad'
 elif mode=='bad_document':source['depth_chart']='bad'
 else:source['depth_chart']['season']=2025
 selected=M.apply(f['pool'],source)
 rows.append({'mode':mode,'ids':[p['gsis_id']for p in selected['players']],
              'states':{g['game_id']:g['state']for g in selected['freshness_policy']['games']},
              'verify':M.verify(selected,source,checked_utc=F.CHECKED)['consumer_policy_pass']})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.ok(!row.ids.includes('espn-1'), row.mode);
    assert.ok(row.ids.includes('espn-2') && row.ids.includes('espn-4'), row.mode);
    assert.equal(row.ids.includes('espn-3'), !['bad_teams', 'bad_document', 'bad_season'].includes(row.mode), row.mode);
    assert.equal(row.states['SOURCE-G1'], 'provisional', row.mode);
    assert.equal(row.states['SOURCE-G2'], 'provisional', row.mode);
    assert.equal(row.verify, true, row.mode);
  }
});

test('only fresh current-season/week exact-game inactive negatives are consumed, never confirmation', () => {
  const r = py(String.raw`
base=copy.deepcopy(s)
game=copy.deepcopy(base['schedule']['games'][0])
game.update(fetched_utc='2026-10-16T20:00:00Z',inactive={'SEA':[],'LAR':[{'espn_id':'2'}]})
base['inactives']={'season':2026,'week':6,'updated_utc':'2026-10-16T20:00:00Z','games':[game]}
rows=[]
for mode in('fresh','wrong_season','wrong_week','wrong_game','wrong_team','wrong_kickoff','future_fetch',
            'future_document','fetch_after_document','stale','missing_fetch','missing_updated','duplicate_game',
            'bad_games','bad_row','bad_inactive','bad_players','bad_player'):
 source=copy.deepcopy(base);doc=source['inactives'];row=doc['games'][0]
 if mode=='wrong_season':doc['season']=2025
 elif mode=='wrong_week':doc['week']=5
 elif mode=='wrong_game':row['game_id']='OLD-GAME'
 elif mode=='wrong_team':row['home']='DAL'
 elif mode=='wrong_kickoff':row['kickoff_utc']='2026-10-18T17:00:00Z'
 elif mode=='future_fetch':row['fetched_utc']='2026-10-16T20:02:00Z'
 elif mode=='future_document':doc['updated_utc']='2026-10-16T20:02:00Z'
 elif mode=='fetch_after_document':doc['updated_utc']='2026-10-16T19:59:00Z'
 elif mode=='stale':row['fetched_utc']='2026-10-16T19:46:00Z'
 elif mode=='missing_fetch':row.pop('fetched_utc')
 elif mode=='missing_updated':doc.pop('updated_utc')
 elif mode=='duplicate_game':doc['games'].append(copy.deepcopy(row))
 elif mode=='bad_games':doc['games']='bad'
 elif mode=='bad_row':doc['games'][0]='bad'
 elif mode=='bad_inactive':row['inactive']='bad'
 elif mode=='bad_players':row['inactive']['LAR']='bad'
 elif mode=='bad_player':row['inactive']['LAR'][0]='bad'
 selected=M.apply(f['pool'],source)
 report=M.verify(selected,source,checked_utc=F.CHECKED)
 rows.append({'mode':mode,'ids':[p['gsis_id']for p in selected['players']],
              'verify':report['consumer_policy_pass'],'confirmation':report['inactive_confirmation_verified']})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.ids.includes('espn-2'), row.mode !== 'fresh', row.mode);
    assert.ok(row.ids.includes('espn-1') && row.ids.includes('espn-3'), row.mode);
    assert.equal(row.verify, true, row.mode);
    assert.equal(row.confirmation, false, row.mode);
  }
});

test('current RETIRED/OUT negatives and an unknown-status row remain scoped and enforced', () => {
  const r = py(String.raw`
from scripts import availability as A
rows=[]
for mode in('Out','Reserve-Ret','quarantine'):
 source=copy.deepcopy(s)
 if mode=='quarantine':source['injuries']['quarantine']=[{'athlete_id':'2','status':'UNKNOWN','reason':'unmapped_status'}]
 else:
  report=source['injuries'];raw=copy.deepcopy(report['injuries'])
  target=next(row for row in raw if row.get('player')=='Synthetic Source Player 2');target['status']=mode
  source['injuries']={**report,**A.enrich_document({**report,'injuries':raw})}
 selected=M.apply(f['pool'],source)
 rows.append({'mode':mode,'ids':[p['gsis_id']for p in selected['players']]})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.ok(!row.ids.includes('espn-2'), row.mode);
    assert.ok(row.ids.includes('espn-1') && row.ids.includes('espn-3'), row.mode);
  }
});

test('UI admits confirmed-list integration is pending and refresh alone cannot clear the90minute hold', () => {
  const p = py("print(json.dumps(M.apply(f['pool'],s)))");
  const status = poolLearningStatus(p, Date.parse('2026-10-16T20:30:00Z'));
  assert.match(renderPoolLearning(status), /confirmed-inactive adapter is still pending/);
  assert.match(renderPoolLearning(status), /refresh alone cannot reactivate/);
  assert.match(learningCardRefusal(p, [{ market: 'wr_rec_yds', game_id: 'SOURCE-G1', gsis_id: 'espn-2' }],
    Date.parse('2026-10-16T20:30:00Z')), /refresh alone cannot reactivate/);
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
