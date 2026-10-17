import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy,json,pathlib,tempfile,runpy
from unittest.mock import patch
from scripts import build_learning_outcomes as O,capture_outcome_evidence as C,learning_receipts as lr
f=runpy.run_path('tests/fixtures/week6_outcomes.py')
def outcome(plan,evidence):
    try:
        doc=O.build(plan,evidence)
        return {'accepted':len(doc['observed_legs']),'rejected':len(doc['rejections']),
                'actual':[x['actual'] for x in doc['observed_legs']],'raised':False,'doc':doc}
    except ValueError:
        return {'accepted':0,'rejected':0,'raised':True}
def reseal_doc(item):
    doc=item['request']['payload']
    doc['envelope_id']=lr.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'})
    item['request']['object_id']=doc['envelope_id']
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('valid but changed raw stats/score JSON and changed observation/manifest cannot bypass capture hashes', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    for mode in ('valid_stat_bytes','valid_score_json','observation_clock','manifest_clock'):
        b=f['bundle']()
        profile=C.STATS_PROFILE if mode=='valid_stat_bytes' else C.SCOREBOARD_PROFILE
        obs=C.source_observation(b,profile,None if profile==C.STATS_PROFILE else 6)
        if mode=='valid_stat_bytes':b['raw_objects'][obs['raw_sha256']]=b['raw_objects'][obs['raw_sha256']].replace(b',80\\r\\n',b',0\\r\\n')
        elif mode=='valid_score_json':
            parsed=json.loads(b['raw_objects'][obs['raw_sha256']]);parsed['events'][0]['competitions'][0]['competitors'][0]['score']='31'
            b['raw_objects'][obs['raw_sha256']]=json.dumps(parsed).encode()
        elif mode=='observation_clock':b['observations'][obs['observation_id']]['observed_utc']='2026-09-03T12:00:02Z'
        else:b['manifest']['completed_utc']='2026-09-03T12:00:30Z'
        results[mode]=outcome(plan,b)
print(json.dumps(results))
`);
  for (const [mode, result] of Object.entries(r)) {
    assert.equal(result.raised, true, mode);
    assert.equal(result.accepted, 0, mode);
  }
});

test('plausible unverified stat aliases cannot be relabeled no-stat-row and repaired to zero', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    for name in ('Alfred One','A. One'):
        results[name]=outcome(plan,f['bundle'](stats_rows=[f['stats_row']('80',player_display_name=name)]))
print(json.dumps(results))
`);
  for (const result of Object.values(r)) {
    assert.equal(result.accepted, 0, 'positive snaps do not prove zero if a plausible stat alias exists');
    assert.ok(result.raised || result.rejected === 2);
  }
});

test('recognizable stat rows with unknown team/position cannot become false zero outcomes', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    for label,change in [('empty_position',{'position':''}),('other_position',{'position':'TE'}),('empty_team',{'team':''})]:
        results[label]=outcome(plan,f['bundle'](stats_rows=[f['stats_row']('80',**change)]))
print(json.dumps(results))
`);
  for (const result of Object.values(r)) {
    assert.equal(result.accepted, 0);
    assert.ok(result.raised || result.rejected === 2);
  }
});

test('boolean document version, missing compact identity and wrong generation membership fail closed', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    for mode in ('bool_version','float_version','empty_compact_leg','wrong_generation'):
        changed=copy.deepcopy(plan);item=changed['generations'][0];doc=item['request']['payload']
        if mode=='bool_version':doc['version']=True
        elif mode=='float_version':doc['version']=1.0
        elif mode=='empty_compact_leg':doc['receipts'][0]['leg']={}
        else:doc['receipts'][0]['generation_id']='sha256:'+'0'*64
        reseal_doc(item);results[mode]=outcome(changed,f['bundle']())
print(json.dumps(results))
`);
  for (const [mode, result] of Object.entries(r)) {
    if (mode.endsWith('version')) assert.equal(result.raised, true, mode);
    else assert.ok(result.raised || result.rejected >= 1, mode);
    assert.ok(result.accepted < 2, mode);
  }
});

test('generation/source/row order and exact replay do not multiply forecast vintages', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);f['generation'](root,'2026-09-01T13:00:00Z');plan=f['plan'](root)
    original=O.build(plan,f['bundle']()); reordered=copy.deepcopy(plan)
    reordered['source_objects'].reverse();reordered['generations'].reverse()
    for item in reordered['generations']:
        item['request']['payload']['receipts'].reverse();reseal_doc(item)
    reordered['generations']+=copy.deepcopy(reordered['generations'])
    observed=O.build(reordered,f['bundle']())
    print(json.dumps({'same_legs':original['observed_legs']==observed['observed_legs'],
                      'same_sources':original['source_receipts']==observed['source_receipts'],
                      'unique':len({x['source_receipt_id'] for x in observed['observed_legs']}),
                      'n':len(observed['observed_legs'])}))
`);
  assert.equal(r.same_legs, true);
  assert.equal(r.same_sources, true);
  assert.equal(r.unique, 4);
  assert.equal(r.n, 4);
});

test('unrelated season CSV changes do not change the target measurement or target raw-row digest', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    first=f['bundle'](stats_rows=[f['stats_row']('80'),f['stats_row']('10',player_display_name='Other Receiver')])
    second=f['bundle'](stats_rows=[f['stats_row']('80'),f['stats_row']('200',player_display_name='Other Receiver')],
                       observed='2026-09-03T13:00:00Z')
    a=O.build(plan,first)['observed_legs'];b=O.build(plan,second)['observed_legs']
    print(json.dumps({'same_receipts':[x['source_receipt_id'] for x in a]==[x['source_receipt_id'] for x in b],
     'same_actual':[x['actual'] for x in a]==[x['actual'] for x in b],
     'same_row_digest':[x['source_row_sha256'] for x in a]==[x['source_row_sha256'] for x in b],
     'new_observation':[x['observation_id'] for x in a]!=[x['observation_id'] for x in b]}))
`);
  assert.equal(r.same_receipts, true);
  assert.equal(r.same_actual, true);
  assert.equal(r.same_row_digest, true);
  assert.equal(r.new_observation, true);
});

test('owner-exclusion policy is not a source of learning labels or population deletion', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root);evidence=f['bundle']()
    before=O.build(plan,evidence)
    with patch('scripts.excluded_games.excluded_ids',side_effect=AssertionError('owner exclusion must not grade learning labels')):
        after=O.build(plan,evidence)
    print(json.dumps({'unchanged':before==after,'legs':len(after['observed_legs'])}))
`);
  assert.equal(r.unchanged, true);
  assert.equal(r.legs, 2);
});

test('recognizable snap identities cannot disappear behind unknown team or REG metadata and become DNP', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    other=f['stats_row']('80',player_display_name='Other Receiver',player_id='00-other')
    neighbor=f['snap_row'](player='Sheet Neighbor')
    cases={
      'unknown_team_exact':f['snap_row'](team=''),
      'unknown_team_alias':f['snap_row'](team='',player='Alfred One'),
      'blank_reg_exact':f['snap_row'](game_type=''),
      'unknown_reg_alias':f['snap_row'](game_type='UNKNOWN',player='Alfred One'),
    }
    for name,target in cases.items():
        results[name]=outcome(plan,f['bundle'](stats_rows=[other],snap_rows=[target,neighbor]))
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(r)) {
    assert.equal(result.accepted, 0, `${name}: filtering an unverified identity does not prove absence`);
    assert.ok(result.raised || result.rejected === 2, name);
  }
});

test('fractional snap counts and duplicate neighbor identities do not certify a complete participation sheet', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    other=f['stats_row']('80',player_display_name='Other Receiver',player_id='00-other')
    neighbor=f['snap_row'](player='Sheet Neighbor')
    cases={
      'fractional_target':[f['snap_row'](offense_snaps='1.5'),neighbor],
      'fractional_neighbor':[f['snap_row'](player='Sheet Neighbor',offense_snaps='1.5')],
      'conflicting_duplicate_neighbor':[neighbor,f['snap_row'](player='Sheet Neighbor',offense_snaps='51')],
      'identical_duplicate_neighbor':[neighbor,neighbor],
    }
    for name,snaps in cases.items():results[name]=outcome(plan,f['bundle'](stats_rows=[other],snap_rows=snaps))
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(r)) {
    assert.equal(result.accepted, 0, `${name}: invalid counts/ambiguous identities cannot invent zero or DNP`);
    assert.ok(result.raised || result.rejected === 2, name);
  }
});

test('strict participation checks preserve known measured stats and explicit POST/other-week exclusions', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    other=f['stats_row']('80',player_display_name='Other Receiver',player_id='00-other')
    neighbor=f['snap_row'](player='Sheet Neighbor')
    for name,target in [('POST',f['snap_row'](game_type='POST')),('other_week',f['snap_row'](week='7'))]:
        results[name]=outcome(plan,f['bundle'](stats_rows=[other],snap_rows=[target,neighbor]))
    results['known_positive']=outcome(plan,f['bundle'](stats_rows=[other],snap_rows=[f['snap_row'](),neighbor]))
    for name,snaps in {
      'measured_unknown_snap_team':[f['snap_row'](team=''),neighbor],
      'measured_unknown_snap_period':[f['snap_row'](game_type=''),neighbor],
      'measured_fractional_snaps':[f['snap_row'](offense_snaps='1.5'),neighbor],
      'measured_duplicate_neighbors':[neighbor,neighbor],
    }.items():results[name]=outcome(plan,f['bundle'](stats_rows=[f['stats_row']('80')],snap_rows=snaps))
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(r)) {
    assert.equal(result.accepted, 2, name);
    assert.equal(result.rejected, 0, name);
    for (const leg of result.doc.observed_legs) {
      if (name.startsWith('measured_')) {
        assert.equal(leg.actual, 80, name);
        assert.equal(leg.participation_basis, 'stat_row', name);
      } else if (name === 'known_positive') {
        assert.equal(leg.actual, 0, name);
        assert.equal(leg.played, true, name);
      } else {
        assert.equal(leg.actual, null, name);
        assert.equal(leg.played, false, `${name}: explicitly unrelated rows are not uncertain target evidence`);
      }
    }
  }
});

test('unlocatable snap/stat identities cannot certify absence or false zero; known measured rows remain usable', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);f['generation'](root);plan=f['plan'](root)
    other=f['stats_row']('80',player_display_name='Other Receiver',player_id='00-other')
    neighbor=f['snap_row'](player='Sheet Neighbor')
    unknown_snap=f['snap_row'](player='',team='')
    unknown_stat=f['stats_row']('80',player_display_name='',team='')
    results['unknown_snap']=outcome(plan,f['bundle'](stats_rows=[other],snap_rows=[neighbor,unknown_snap]))
    results['unknown_stat']=outcome(plan,f['bundle'](stats_rows=[other,unknown_stat],snap_rows=[f['snap_row'](),neighbor]))
    results['unknown_stat_position']=outcome(plan,f['bundle'](
      stats_rows=[other,{**unknown_stat,'position':''}],snap_rows=[f['snap_row'](),neighbor]))
    for position in ('TE','QB'):
        results['unknown_stat_position_'+position]=outcome(plan,f['bundle'](
          stats_rows=[other,{**unknown_stat,'position':position}],snap_rows=[f['snap_row'](),neighbor]))
        results['unnamed_target_team_'+position]=outcome(plan,f['bundle'](
          stats_rows=[other,{**unknown_stat,'team':'SEA','position':position}],
          snap_rows=[f['snap_row'](),neighbor]))
    results['measured_with_unknown_snap']=outcome(plan,f['bundle'](
      stats_rows=[f['stats_row']('80')],snap_rows=[neighbor,unknown_snap]))
    results['measured_with_unknown_stat']=outcome(plan,f['bundle'](
      stats_rows=[f['stats_row']('80'),unknown_stat],snap_rows=[f['snap_row'](),neighbor]))
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(r)) {
    if (name.startsWith('measured_')) {
      assert.equal(result.accepted, 2, name);
      assert.equal(result.rejected, 0, name);
      assert.deepEqual(result.actual, [80, 80], name);
      assert.ok(result.doc.observed_legs.every(leg => leg.participation_basis === 'stat_row'), name);
    } else {
      assert.equal(result.accepted, 0, `${name}: unlocatable evidence remains unknown`);
      assert.ok(result.raised || result.rejected === 2, name);
    }
  }
});
