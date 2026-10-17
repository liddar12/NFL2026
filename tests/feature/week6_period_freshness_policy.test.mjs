import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
function py(body) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 45000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: `import copy,json\nfrom scripts import period_freshness_policy as P\nfrom tests.fixtures import period_eligibility as F\n` + body }).trim().split('\n').at(-1));
}

test('freshness proposals require a named profile and never read env, write, select serving, or approve a release', () => {
  const r = py(String.raw`
from unittest.mock import patch
f=F.make(window=True);before=P.gate.encoded(f);rows=[]
with patch('builtins.open',side_effect=AssertionError('IO')),patch('os.environ.get',side_effect=AssertionError('env')):
 for profile in(None,'unknown',{'mode':'approve'}):
  rows.append(P.assess(f['capture'],f['pool'],profile=profile,checked_utc=F.CHECKED))
 assert P.gate.encoded(f)==before
print(json.dumps(rows))
`);
  assert.ok(r.every(x => !x.shadow_policy_pass && x.reason_codes[0] === 'freshness_policy_profile_not_selected'));
  for (const row of r) {
    assert.equal(row.shadow_only, true);
    for (const key of ['profile_selected_for_serving', 'owner_approved', 'inactive_confirmation_verified',
      'upstream_eligibility_verified', 'MY_card_semantics_verified', 'publication_authorized',
      'production_authorized', 'public_serving_verified', 'source_writes', 'network_used']) assert.equal(row[key], false, key);
  }
});

test('provisional shadow assessment has an exclusive 90-minute checkpoint, while strict mode remains held', () => {
  const r = py(String.raw`
f=F.make(window=True);rows=[]
for profile,clock in(('provisional_before_90m_v1',F.CHECKED),('wait_for_confirmed_inactives_v1',F.CHECKED),
 ('provisional_before_90m_v1','2026-10-16T20:29:59Z'),('provisional_before_90m_v1','2026-10-16T20:30:00Z')):
 rows.append(P.assess(f['capture'],f['pool'],profile=profile,checked_utc=clock))
print(json.dumps(rows))
`);
  assert.deepEqual(r.map(x => x.shadow_policy_pass), [true, false, true, false]);
  assert.equal(r[0].next_check_utc, '2026-10-16T20:30:00Z');
  assert.equal(r[1].next_check_utc, '2026-10-16T20:30:00Z');
  assert.ok(r[3].reason_codes.includes('inactive_confirmation_not_bound'));
  assert.ok(r.every(x => x.games.every(g => g.inactive_check_due_utc === '2026-10-16T20:30:00Z')));
  assert.ok(r.every(x => !x.publication_authorized));
});

test('freshness proposals hold only affected QB identities for missing/stale/unknown team depth, without changing weekly points', () => {
  const r = py(String.raw`
rows=[]
def case(label,change):
 f=F.make(qb=True,window=True);d=f['docs'];change(d)
 d['player_weekly']=F.weekly(d);f=F.refresh(d);before=P.gate.encoded(f)
 report=P.assess(f['capture'],f['pool'],profile='provisional_before_90m_v1',checked_utc=F.CHECKED)
 assert before==P.gate.encoded(f)
 rows.append({'case':label,'report':report})
case('fresh',lambda d:None)
case('missing',lambda d:d.update(depth_chart=None))
def old_fetch(d):
 d['depth_chart']['updated_utc']='2026-10-16T08:02:00Z';d['depth_chart']['teams']['SEA']['snapshot']='2026-10-16T07:00:00Z'
case('fetch-exactly12h',old_fetch)
case('snapshot-exactly7d',lambda d:d['depth_chart']['teams']['SEA'].update(snapshot='2026-10-09T20:02:00Z'))
case('date-only-is-unknown',lambda d:d['depth_chart']['teams']['SEA'].update(snapshot='2026-10-16'))
print(json.dumps(rows))
`);
  assert.equal(r[0].report.shadow_policy_pass, true, JSON.stringify(r[0]));
  assert.ok(r.slice(1).every(x => !x.report.shadow_policy_pass), JSON.stringify(r));
  assert.deepEqual(r[1].report.blocked_player_ids, ['espn-1', 'espn-7']);
  assert.deepEqual(r[2].report.blocked_player_ids, ['espn-1']);
  assert.ok(r[2].report.reason_codes.includes('depth_fetch_stale'));
  assert.ok(r[3].report.reason_codes.includes('depth_team_snapshot_stale'));
  assert.ok(r[4].report.reason_codes.includes('depth_team_snapshot_clock_unknown_or_future'));
  assert.ok(r.every(x => !x.report.blocked_player_ids.includes('espn-2') && !x.report.publication_authorized));
});

test('fresh zero and nonzero inactive rows are observations, never official posting or completeness', () => {
  const r = py(String.raw`
rows=[]
for empty in(False,True):
 f=F.make(inactive=True,window=True);d=f['docs'];doc=d['inactives']
 doc['updated_utc']='2026-10-16T19:55:00Z';doc['games'][0]['fetched_utc']='2026-10-16T19:55:00Z'
 # Uploaded flags cannot create a posting/completeness witness.
 doc.update(official_complete=True,posted=True)
 if empty:doc['games'][0]['inactive']={'SEA':[],'LAR':[]}
 d['player_weekly']=F.weekly(d,updated_utc='2026-10-16T19:58:00Z');f=F.refresh(d)
 for profile in('provisional_before_90m_v1','wait_for_confirmed_inactives_v1'):
  report=P.assess(f['capture'],f['pool'],profile=profile,checked_utc=F.CHECKED)
  game=next(g for g in report['games']if g['game_id']=='SOURCE-G1')
  rows.append({'empty':empty,'profile':profile,'report':report,'observation':game['inactive_observation']})
print(json.dumps(rows))
`);
  assert.deepEqual(r.map(x => x.report.shadow_policy_pass), [true, false, true, false]);
  assert.deepEqual(r.map(x => x.observation.players_observed), [1, 1, 0, 0]);
  assert.ok(r.every(x => x.observation.state === 'provider_rows_observed_confirmation_unknown'));
  assert.ok(r.every(x => !x.observation.confirmation_verified && !x.report.inactive_confirmation_verified));
});

test('later witness fetches cannot support an earlier weekly gate even if all JSON relationships reproduce', () => {
  const r = py(String.raw`
rows=[]
for kind in('injuries','depth_chart','inactives'):
 f=F.make(qb=True,inactive=True,window=True);d=f['docs']
 if kind=='injuries':d[kind]['received_utc']='2026-10-16T19:31:00Z'
 else:d[kind]['updated_utc']='2026-10-16T19:31:00Z'
 # Deliberately reproduce the old earlier-clock producer against its later
 # witness: agreement alone must not erase the contradictory fetch chronology.
 d['player_weekly']=F.weekly(d);f=F.refresh(d)
 fact=P.sources.verify(f['capture'],f['pool'],checked_utc=F.CHECKED)
 report=P.assess(f['capture'],f['pool'],profile='provisional_before_90m_v1',checked_utc=F.CHECKED)
 rows.append({'facts':fact,'shadow':report})
print(json.dumps(rows))
`);
  assert.ok(r.every(x => !x.facts.frozen_weekly_eligibility_replayed));
  assert.ok(r.every(x => x.facts.reason_codes[0] === 'period_sources_witness_fetched_after_weekly'));
  assert.ok(r.every(x => !x.shadow.shadow_policy_pass && !x.shadow.publication_authorized));
});
