import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
function py(body) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 45000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: `import copy,json\nfrom scripts import period_source_eligibility as E\nfrom tests.fixtures import period_eligibility as F\n` + body }).trim().split('\n').at(-1));
}

test('actual weekly gate and real weekly-row shape replay without IO, pricing, or release claims', () => {
  const r = py(String.raw`
from unittest.mock import patch
f=F.make();before=E.gate.encoded(f)
with patch('builtins.open',side_effect=AssertionError('IO')),patch('socket.create_connection',side_effect=AssertionError('network')):
 report=E.verify(f['capture'],f['pool'],checked_utc=F.CHECKED)
assert before==E.gate.encoded(f)
assert all('status'not in row for row in f['docs']['game_predictions']['games'])
assert report['capture_id']==f['capture']['capture_id']and report['pool_id']==E.gate.fingerprint(f['pool'])
assert report['checked_utc_claim']==F.CHECKED
assert report['eligibility_report_id']==E.gate.fingerprint({k:v for k,v in report.items()if k!='eligibility_report_id'})
print(json.dumps(report))
`);
  assert.equal(r.frozen_weekly_eligibility_replayed, true, JSON.stringify(r));
  assert.equal(r.coverage.offered_players, 4);
  assert.equal(r.coverage.finished_teams_preserved, 2);
  assert.deepEqual(r.reason_codes, []);
  for (const key of ['upstream_eligibility_verified', 'MY_card_semantics_verified', 'whole_release_pass',
    'owner_authenticated', 'provider_authenticated', 'provider_completeness_verified',
    'earlier_weekly_producer_reads_verified', 'weekly_points_lost_rederived', 'publication_authorized', 'production_authorized',
    'public_serving_verified', 'source_writes', 'network_used']) assert.equal(r[key], false, key);
});

test('row quarantine, QUESTIONABLE, RETIRED, QB depth and posted inactives use the actual gate without inventing freshness', () => {
  const r = py(String.raw`
result=[]
for options in({'unknown':True},{'questionable':True},{'retired':True},{'qb':True},{'inactive':True,'window':True}):
 f=F.make(**options);report=E.verify(f['capture'],f['pool'],checked_utc=F.CHECKED)
 result.append({'options':options,'report':report,'offered':[p['gsis_id']for p in f['pool']['players']]})
print(json.dumps(result))
`);
  assert.ok(r.every(x => x.report.frozen_weekly_eligibility_replayed), JSON.stringify(r));
  assert.ok(!r[0].offered.includes('espn-1') && r[0].offered.includes('espn-2'));
  assert.equal(r[0].report.coverage.row_quarantined_players, 1);
  assert.ok(r[1].offered.includes('espn-1'));
  assert.ok(!r[2].offered.includes('espn-1'));
  assert.ok(!r[3].offered.includes('espn-7'));
  assert.deepEqual(r[3].report.reason_codes, ['undefined_depth_freshness_policy']);
  assert.ok(!r[4].offered.includes('espn-1'));
  assert.deepEqual(r[4].report.reason_codes, ['undefined_inactive_freshness_or_applicability']);
  assert.ok(r.every(x => !x.report.upstream_eligibility_verified && !x.report.publication_authorized));
});

test('an omitted QB exclusion that agrees with its own counts is independently refused', () => {
  const r = py(String.raw`
from scripts import validate_data
f=F.make(qb=True);docs=f['docs'];docs['player_weekly']=F.weekly(docs,omit_depth=True)
# Existing validation sees self-consistent zero gates, despite a real QB2.
validate_data.check_weekly_availability(docs['player_weekly'],docs['player_projections'],
 docs['injuries'],docs['depth_chart'],docs['inactives'])
f=F.refresh(docs);report=E.verify(f['capture'],f['pool'],checked_utc=F.CHECKED)
print(json.dumps({'old_relationship_check_passed':True,'report':report}))
`);
  assert.equal(r.old_relationship_check_passed, true);
  assert.equal(r.report.frozen_weekly_eligibility_replayed, false);
  assert.deepEqual(r.report.reason_codes, ['period_sources_gate_summary_not_reproduced']);
});

test('changed frozen clocks, periods, identities and finished-game offers cannot claim source consistency', () => {
  const r = py(String.raw`
f=F.make();results=[]
def case(name,mutate,expected):
 docs=copy.deepcopy(f['docs']);mutate(docs);changed=F.refresh(docs)
 report=E.verify(changed['capture'],changed['pool'],checked_utc=F.CHECKED)
 assert report['frozen_weekly_eligibility_replayed']is False,(name,report)
 assert expected in report['reason_codes'],(name,expected,report)
 results.append(name)
case('wrong-week',lambda d:d['game_predictions'].update(week=5),'period_sources_week_mismatch')
case('wrong-season',lambda d:d['player_projections'].update(season=2025),'period_sources_season_mismatch')
case('future-source',lambda d:d['player_projections'].update(updated_utc='2026-10-16T20:00:01Z'),'period_sources_read_chronology_invalid')
case('old-source',lambda d:d['player_projections'].update(updated_utc='2026-10-16T08:01:59Z'),'period_sources_consumer_stale')
case('both-clocks-use-consumed-generated',lambda d:d['player_projections'].update(generated_utc='2026-10-16T08:01:59Z'),'period_sources_consumer_stale')
case('unknown-provider-clock',lambda d:d['injuries'].update(source_updated_utc=None),'period_sources_injury_source_unverified')
case('retired-vocabulary',lambda d:d['injuries'].update(vocab_version=1),'period_sources_injury_period_or_vocabulary_invalid')
case('prediction-status-null',lambda d:d['game_predictions']['games'][0].update(status=None),'period_sources_prediction_game_mismatch')
case('player-mismatch',lambda d:d['player_weekly']['players'][0]['weeks'][5].update(opp='NYJ'),'period_sources_player_matchup_mismatch')
case('missing-schedule-status',lambda d:d['schedule']['games'][0].update(status=None),'period_sources_schedule_status_missing')
case('missing-player-team',lambda d:d['player_projections']['players'][0].update(team=None),'period_sources_player_identity_invalid')
bad=copy.deepcopy(f['pool']);old=F.B.build({**{k:f['docs'][k]for k in F.Bnames},'excluded_games':set(),
 'generated_utc':F.GENERATED,'generation_sha':'synthetic-source-diagnostic'})
bad['players']=old['players'];report=E.verify(f['capture'],bad,checked_utc=F.CHECKED)
assert report['reason_codes']==['period_sources_offered_player_not_eligible_future'];results.append('finished-offer')
print(json.dumps({'refused':results}))
`);
  assert.equal(r.refused.length, 12);
});

test('overtime FINAL follows the real producer; points_lost is shaped but its earlier numeric derivation stays unverified', () => {
  const r = py(String.raw`
f=F.make();docs=f['docs'];docs['schedule']['games'][-1]['status']='STATUS_FINAL_OVERTIME'
docs['player_weekly']=F.weekly(docs);f=F.refresh(docs)
report=E.verify(f['capture'],f['pool'],checked_utc=F.CHECKED)
assert report['frozen_weekly_eligibility_replayed']and report['coverage']['finished_teams_preserved']==2,report
assert report['weekly_points_lost_rederived']is False
f=F.make(qb=True);refused=[]
for value in(True,-1,'100',None):
 docs=copy.deepcopy(f['docs']);next(p for p in docs['player_weekly']['players']if p['gsis_id']=='espn-7')['this_week']['points_lost']=value
 changed=F.refresh(docs);bad=E.verify(changed['capture'],changed['pool'],checked_utc=F.CHECKED)
 assert bad['reason_codes']==['period_sources_gate_points_lost_invalid'],bad
 refused.append(value)
print(json.dumps({'overtime_final_preserved':True,'invalid_loss_claims_refused':len(refused)}))
`);
  assert.equal(r.overtime_final_preserved, true);
  assert.equal(r.invalid_loss_claims_refused, 4);
});
