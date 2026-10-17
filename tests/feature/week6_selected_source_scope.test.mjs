import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);

test('selected source facts use the independent future schedule without requiring imaginary bye/final weekly gates', () => {
  const out = JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 90000,
    maxBuffer: 2 * 1024 * 1024, input: String.raw`
import copy,json
from scripts import availability as A,period_source_eligibility as E,my_freshness as M
from tests.fixtures import period_eligibility as F
docs=copy.deepcopy(F.make()['docs'])
bye={'gsis_id':'espn-8','name':'Synthetic Bye Player','team':'MIN','position':'WR','proj_points':100.}
docs['player_projections']['players'].append(bye)
injuries=docs['injuries']
for number,row in enumerate(injuries['injuries'],1):
 row['athlete_id']=str(number)
 if number in (1,5):row['status']='Out'
injuries['injuries'].append({'team':'MIN','player':bye['name'],'athlete_id':'8','status':'Out'})
raw_injuries=copy.deepcopy(injuries['injuries'])
injuries.update(A.enrich_document(injuries))
for row,raw in zip(injuries['injuries'],raw_injuries):row['athlete_id']=raw['athlete_id']
docs['player_weekly']=F.weekly(docs)
f=F.refresh(docs)
sources={k:docs[k] for k in M.SOURCE_NAMES}
pool=M.apply(f['pool'],sources)
rows={r['gsis_id']:r for r in docs['player_weekly']['players']}
roster={p['gsis_id']:p for p in docs['player_projections']['players']}
assert rows['espn-8'].get('this_week') is None and rows['espn-5'].get('this_week') is None
assert rows['espn-1']['this_week']['playable'] is False
selected=E.verify(f['capture'],pool,checked_utc=F.CHECKED,selected_profile=M.PROFILE)
assert selected['frozen_weekly_eligibility_replayed'] is True,selected
assert selected['weekly_negative_scope']=='scheduled_future'
assert selected['upstream_eligibility_verified'] is False and selected['publication_authorized'] is False
legacy=E.verify(f['capture'],pool,checked_utc=F.CHECKED)
assert legacy['frozen_weekly_eligibility_replayed'] is False and legacy['weekly_negative_scope']=='all_roster'
assert legacy['reason_codes']==['explicit_injury_id_negative_not_refused'],legacy
rejected=[]
def reject(name,changed,expected):
 result=E.verify(changed['capture'],changed['pool'],checked_utc=F.CHECKED,selected_profile=M.PROFILE)
 assert result['frozen_weekly_eligibility_replayed'] is False,(name,result)
 assert expected in result['reason_codes'],(name,result)
 rejected.append(name)
# Dropping a future OUT from the pool cannot excuse its missing weekly refusal.
bad=copy.deepcopy(docs);row=next(r for r in bad['player_weekly']['players']if r['gsis_id']=='espn-1')
row.pop('this_week');next(w for w in row['weeks']if w['wk']==6)['avail']=True
changed=F.refresh(bad);changed['pool']=M.apply(changed['pool'],{k:bad[k]for k in M.SOURCE_NAMES})
changed['pool']['players']=[p for p in changed['pool']['players']if p['gsis_id']!='espn-1']
reject('future-out-missing-refusal',changed,'explicit_injury_id_negative_not_refused')
# No ordinary player, even a healthy finished/bye player, can be offered by
# manufacturing a current pool row. All roster/schedule checks still apply.
for pid in ('espn-5','espn-8'):
 changed=copy.deepcopy(f);changed['pool']=copy.deepcopy(pool)
 changed['pool']['players'].append({'gsis_id':pid,'team':roster[pid]['team'],'position':'WR','game_id':'SOURCE-G1','rungs':[]})
 reject('nonactionable-negative-offered-'+pid,changed,'explicit_injury_id_negative_not_refused')
changed=copy.deepcopy(f);changed['pool']=copy.deepcopy(pool)
changed['pool']['players'].append({'gsis_id':'espn-6','team':'BUF','position':'WR','game_id':'SOURCE-G3','rungs':[]})
reject('healthy-finished-player-offered',changed,'period_sources_offered_player_not_eligible_future')
bad=copy.deepcopy(docs)
row=next(r for r in bad['injuries']['injuries']if r['athlete_id']=='8')
row.update(A.enrich({**row,'status':'Active'}))
bad['injuries']['counts']=A.counts(bad['injuries']['injuries'])
bad['player_weekly']=F.weekly(bad);changed=F.refresh(bad)
changed['pool']=M.apply(changed['pool'],{k:bad[k]for k in M.SOURCE_NAMES})
changed['pool']['players'].append({'gsis_id':'espn-8','team':'MIN','position':'WR','game_id':'SOURCE-G1','rungs':[]})
reject('healthy-bye-player-offered',changed,'period_sources_offered_player_not_eligible_future')
bad=copy.deepcopy(docs);bad['player_projections']['players'][0]['espn_id']='2'
changed=F.refresh(bad);changed['pool']=copy.deepcopy(pool)
reject('nonoffered-explicit-id-conflict',changed,'ambiguous_explicit_projection_identity')
bad=copy.deepcopy(docs);bad['player_weekly']['players'][0]['weeks'][5]['opp']='NYJ'
changed=F.refresh(bad);changed['pool']=copy.deepcopy(pool)
reject('contradictory-matchup',changed,'period_sources_player_matchup_mismatch')
bad=copy.deepcopy(docs);bad['player_weekly']['players'][0]['weeks']=[w for w in bad['player_weekly']['players'][0]['weeks']if w['wk']!=6]
changed=F.refresh(bad);changed['pool']=copy.deepcopy(pool)
reject('future-target-row-missing',changed,'period_sources_target_player_week_missing')
unknown=E.verify(f['capture'],pool,checked_utc=F.CHECKED,selected_profile='caller-invented-profile')
assert unknown['frozen_weekly_eligibility_replayed'] is False
assert unknown['reason_codes']==['period_sources_selected_profile_invalid'],unknown
plain=copy.deepcopy(pool);plain.pop('freshness_policy')
missing=E.verify(f['capture'],plain,checked_utc=F.CHECKED,selected_profile=M.PROFILE)
assert missing['reason_codes']==['period_sources_selected_profile_invalid'],missing
print(json.dumps({'selected':True,'legacy_strict':True,'refused':rejected,'invalid_profiles_refused':2}))
` }).trim().split('\n').at(-1));
  assert.equal(out.selected, true);
  assert.equal(out.legacy_strict, true);
  assert.equal(out.refused.length, 8);
  assert.equal(out.invalid_profiles_refused, 2);
});
