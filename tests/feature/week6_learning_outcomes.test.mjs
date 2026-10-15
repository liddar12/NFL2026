import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy,json,pathlib,tempfile,runpy,subprocess,sys
from scripts import build_learning_outcomes as outcomes, capture_outcome_evidence as capture, learning_receipts as lr
f=runpy.run_path('tests/fixtures/week6_outcomes.py')
`;
function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('exact frozen receipt vintages produce observed outcomes, not invented finish/update clocks', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); a,_,_=f['generation'](root); b,_,_=f['generation'](root,'2026-09-01T13:00:00Z')
 p=f['plan'](root); evidence=f['bundle'](); before=copy.deepcopy(p)
 doc=outcomes.build(p,evidence); legs=doc['observed_legs']
 print(json.dumps({'doc':doc,'sources':len(a['receipts'])+len(b['receipts']),
  'unchanged':p==before,'hash_ok':doc['outcome_id']==lr.fingerprint({k:v for k,v in doc.items() if k!='outcome_id'})}))
`);
  assert.equal(r.unchanged, true); assert.equal(r.hash_ok, true);
  assert.equal(r.sources, 4); assert.equal(r.doc.observed_legs.length, 4);
  assert.equal(r.doc.source_receipts.length, 4); assert.deepEqual(r.doc.rejections, []);
  for (const leg of r.doc.observed_legs) {
    assert.equal(leg.actual, 80); assert.equal(leg.result, 'hit');
    assert.equal(leg.team, 'SEA'); assert.equal(leg.player_id, 'espn-fixture-1');
    assert.equal(leg.participation_basis, 'stat_row');
    assert.equal(leg.identity_join_policy, 'frozen_pool_exact_name_team_position_v1');
    assert.equal(leg.evidence_quality, 'observed_source_snapshot');
    assert.ok(!('source_revision_id' in leg));
  }
  assert.equal(r.doc.game_observations.G1.final_utc, null);
  assert.equal(r.doc.game_observations.G1.source_updated_utc, null);
  assert.equal(r.doc.summary.writes, false); assert.equal(r.doc.summary.network_used, false);
});

test('genuine zero/negative yardage and thresholds remain measurable; malformed cells never become zero', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); f['generation'](root); p=f['plan'](root)
 for value in ('0','-5','39.5','40','59.5','NA','','NaN','Infinity','bad'):
  doc=outcomes.build(p,f['bundle'](value=value))
  doc['observed_legs'].sort(key=lambda x:x['line'])
  results[value]={'actual':[x['actual'] for x in doc['observed_legs']],
                  'results':[x['result'] for x in doc['observed_legs']],
                  'reasons':doc['summary']['exclusion_reasons']}
print(json.dumps(results))
`);
  for (const value of ['0', '-5', '39.5', '40', '59.5']) {
    assert.deepEqual(r[value].actual, [Number(value), Number(value)]);
    assert.deepEqual(r[value].reasons, {});
  }
  assert.deepEqual(r['39.5'].results, ['hit', 'miss']);
  for (const value of ['NA', '', 'NaN', 'Infinity', 'bad']) {
    assert.deepEqual(r[value].actual, []); assert.equal(r[value].reasons.missing_stat_value, 2);
  }
});

test('live, absent or mismatched FINAL evidence cannot grade props', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); f['generation'](root); p=f['plan'](root)
 for status in ('STATUS_IN_PROGRESS','STATUS_SCHEDULED','STATUS_FINAL','STATUS_FINAL_OVERTIME'):
  doc=outcomes.build(p,f['bundle'](status=status)); results[status]=len(doc['observed_legs'])
 wrong=f['bundle'](game_extra={'date':'2026-09-02T01:00:00Z'})
 doc=outcomes.build(p,wrong); results['wrong_kickoff']=doc['summary']['exclusion_reasons']
print(json.dumps(results))
`);
  assert.equal(r.STATUS_IN_PROGRESS, 0); assert.equal(r.STATUS_SCHEDULED, 0);
  assert.equal(r.STATUS_FINAL, 2); assert.equal(r.STATUS_FINAL_OVERTIME, 2);
  assert.equal(r.wrong_kickoff.observed_game_frozen_identity_mismatch, 2);
});

test('R106 positive snaps and inferred absence are explicit; unknown or zero-offense evidence stays unresolved', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); f['generation'](root); p=f['plan'](root)
 for mode in ('played','absent','zero','bad','other_team','alias'):
  snap=f['snap_row']()
  if mode=='absent':snap['player']='Other Receiver'
  elif mode=='zero':snap['offense_snaps']='0'
  elif mode=='bad':snap['offense_snaps']='NA'
  elif mode=='other_team':snap['team']='LAR'
  elif mode=='alias':snap['player']='Alfred One'
  evidence=f['bundle'](stats_rows=[f['stats_row']('20',player_display_name='Other Receiver')],snap_rows=[snap])
  doc=outcomes.build(p,evidence); results[mode]={'legs':doc['observed_legs'],'why':doc['summary']['exclusion_reasons']}
print(json.dumps(results))
`);
  assert.equal(r.played.legs.length, 2);
  assert.ok(r.played.legs.every(x => x.actual === 0 && x.result === 'miss' && x.played));
  assert.ok(r.played.legs.every(x => x.participation_basis === 'r106_positive_offensive_snaps_no_stat_row'));
  assert.equal(r.absent.legs.length, 2);
  assert.ok(r.absent.legs.every(x => x.actual === null && x.result === 'void' && !x.played));
  assert.ok(r.absent.legs.every(x => x.participation_basis === 'r106_team_snap_absence_inference'));
  for (const mode of ['zero', 'bad', 'other_team', 'alias']) assert.deepEqual(r[mode].legs, []);
});

test('stats identity cannot attach a namesake from the other team or a second conflicting row', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); f['generation'](root); p=f['plan'](root)
 rival=f['stats_row']('250',team='LAR')
 good=outcomes.build(p,f['bundle'](stats_rows=[rival,f['stats_row']('55')]))
 bad=outcomes.build(p,f['bundle'](stats_rows=[f['stats_row']('55'),f['stats_row']('20')]))
 print(json.dumps({'actuals':[x['actual'] for x in good['observed_legs']],
 'bad':bad['summary']['exclusion_reasons'],'bad_legs':bad['observed_legs']}))
`);
  assert.deepEqual(r.actuals, [55, 55]); assert.deepEqual(r.bad_legs, []);
  assert.equal(r.bad.ambiguous_stat_identity, 2);
});

test('tampered raw capture bytes or frozen source bodies fail before outcomes are emitted', () => {
  const r = py(`
errors=[]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); f['generation'](root); p=f['plan'](root)
 for mode in ('raw','source','version'):
  plan=copy.deepcopy(p); evidence=f['bundle']()
  if mode=='raw':evidence['raw_objects'][next(iter(evidence['raw_objects']))]=b'changed'
  elif mode=='source':plan['source_objects'][0]['payload']={'changed':True}
  else:plan['version']=True
  try:outcomes.build(plan,evidence)
  except ValueError:errors.append(mode)
print(json.dumps(errors))
`);
  assert.deepEqual(r, ['raw', 'source', 'version']);
});

test('CLI replays verified capture without fetching, credentials or generated-data writes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); snapshots=root/'snapshots'; f['generation'](snapshots)
 path=capture.save_capture(f['bundle'](),root/'evidence'); before={str(x):x.read_bytes() for x in root.rglob('*') if x.is_file()}
 run=subprocess.run([sys.executable,'scripts/build_learning_outcomes.py','--snapshots',str(snapshots),
  '--evidence-capture',str(path)],capture_output=True,text=True)
 doc=json.loads(run.stdout)
 print(json.dumps({'code':run.returncode,'legs':len(doc['observed_legs']),
  'unchanged':before=={str(x):x.read_bytes() for x in root.rglob('*') if x.is_file()},'summary':doc['summary']}))
`);
  assert.equal(r.code, 0); assert.equal(r.legs, 2); assert.equal(r.unchanged, true);
  assert.equal(r.summary.network_used, false); assert.equal(r.summary.writes, false);
});
