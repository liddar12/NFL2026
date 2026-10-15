import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const run = code => JSON.parse(execFileSync('python3', ['-'], {cwd, encoding:'utf8',
  input: setup + code, env:{...process.env, PYTHONPATH:cwd}, stdio:['pipe','pipe','pipe']}));
const setup = `
import json, copy
from scripts import availability as av, build_weekly as bw, build_predictions as bp
from scripts.scrape import espn
from scripts.models.parlay_builder import playable_this_week
from scripts.validate_data import check_weekly_availability, check_no_unplayable_legs, validate_against_schema, ValidationError
NOW='2026-10-14T15:00:00Z'
PROJ=[{'gsis_id':'espn-1','name':'Runner One','team':'SF','position':'RB','proj_points':170.0},
      {'gsis_id':'espn-2','name':'Receiver Two','team':'SEA','position':'WR','proj_points':170.0}]
SCHED=[{'week':w,'home':'SF','away':'SEA'} for w in range(1,19) if w!=7]
def report(status='Out', timestamp='2026-10-14T14:00:00Z', week=6, quarantine=None):
    d=av.enrich_document({'updated_utc':timestamp,'source':'espn','injuries':[
      {'team':'SF','player':'Runner One','status':status,'detail':None}]})
    d.update(received_utc=timestamp,source_updated_utc=timestamp,week=week,quarantine=quarantine or [])
    return d
def build(d, skip=(), week=6):
    return bw.build_weekly_document(PROJ,SCHED,{'SF':1500,'SEA':1500},{},2026,NOW,
      factors=bw.build_factors(2026), first_week=week,this_week=week,
      injury_document=d,gate_skip_teams=skip)
def schema(d,name):
    with open('data/contracts/'+name+'.schema.json') as f: s=json.load(f)
    validate_against_schema(d,s,name)
def row(p,w=6): return next(r for r in p['weeks'] if r['wk']==w)
def emit(x): print(json.dumps(x))
`;

test('Week6: one unknown source status quarantines one of 800 rows and preserves IDs/raw spelling',()=>{
 const o=run(`
items=[{'status':'Active','athlete':{'id':str(i),'displayName':'Player '+str(i)}} for i in range(799)]
items.append({'status':'New designation','athlete':{'displayName':'Unknown Player','links':[{'href':'https://www.espn.com/nfl/player/_/id/999/unknown'}]}})
espn._get_json=lambda *a,**kw:{'timestamp':NOW,'injuries':[{'displayName':'San Francisco 49ers','injuries':items}]}
d=espn.fetch_injuries(carry_positions=True,quarantine_unknown=True,return_document=True)
try:
 espn.fetch_injuries(quarantine_unknown=True)
except ValueError: refused_loss_of_evidence=True
else: refused_loss_of_evidence=False
emit({'valid':len(d['injuries']),'q':d['quarantine'],'source':d['source_updated_utc'],
      'refused_loss_of_evidence':refused_loss_of_evidence})`);
 assert.equal(o.valid,799);assert.equal(o.q.length,1);assert.equal(o.q[0].athlete_id,'999');
 assert.equal(o.q[0].status,'New designation');assert.equal(o.q[0].reason,'unmapped_status');
 assert.equal(o.refused_loss_of_evidence,true);
});

test('Week6: production slate shape refuses pregame OUT and final-week avail:false props',()=>{
 const o=run(`
from scripts.models.parlay_builder import build_props_by_game
p={'game_id':'G','home':'SF','away':'SEA','week':6,'kickoff_utc':NOW,'roof':'outdoor',
   'probs':{'home':.6,'away':.4},'model':'elo','estimate':True}
games=bp.week_game_rows([p],6)
pregame=build(report('Out'));check_weekly_availability(pregame,{'players':PROJ},report('Out'))
final=build(report('Active'),skip=('SF',))
# A historical zero remains authoritative after this_week gating stops at FINAL.
row(final['players'][0]).update(pts=0.0,avail=False)
def offer_ids(doc, slate):
 for player in doc['players']:
  player['league_components']={'rush_yd':1200.0,'rec_yd':1100.0}
 return [leg['gsis_id'] for leg in build_props_by_game(slate,doc,{'players':PROJ},calibration_path='/nonexistent.json')['G']]
legacy=[{k:v for k,v in games[0].items() if k!='week'}]
emit({'pregame':offer_ids(pregame,games),'final':offer_ids(final,games),
 'legacy_final':offer_ids(final,legacy),'final_gate':final['players'][0].get('this_week'),
 'pregame_points':row(pregame['players'][0])['pts']})`);
 assert.equal(o.pregame_points,0);assert.equal(o.final_gate,null);
 assert.equal(o.pregame.includes('espn-1'),false);assert.equal(o.final.includes('espn-1'),false);
 assert.ok(o.pregame.includes('espn-2'));assert.ok(o.final.includes('espn-2'));
 assert.ok(o.legacy_final.includes('espn-1'),'missing week reproduced the old final-week eligibility bypass');
});

test('Week6: Reserve-Ret is explicitly nonplayable without inventing IR duration',()=>{
 const o=run(`
d=report('Reserve-Ret'); d['injuries'][0]['detail']='He was on injured reserve for four weeks before retiring.'
d=av.enrich_document(d)|{k:v for k,v in d.items() if k not in ('injuries','counts','vocab_version')}
b=build(d);check_weekly_availability(b,{'players':PROJ},d);schema(b,'player_weekly');schema(d,'injuries')
p=b['players'][0];emit({'code':av.normalize_status('Reserve-Ret'),'view':p['availability'],'tw':p['this_week'],
 'duration':bw.blocked_week_count(bw.unavailability(PROJ,d['injuries'])['espn-1']), 'later':row(p,8)['pts']})`);
 assert.equal(o.code,'RETIRED');assert.equal(o.tw.playable,false);assert.deepEqual(o.duration,[0,null]);
 assert.deepEqual(o.view,{status:'RETIRED',class:'season'});assert.ok(o.later>0);
});

test('Week6: stale/wrong-week reports withhold offers without converting unknown participation to zero',()=>{
 const o=run(`
ans=[]
for d in [report(timestamp='2026-10-11T20:10:35Z',week=5),report(week=5),report(timestamp='2026-10-13T13:00:00Z')]:
 b=build(d);check_weekly_availability(b,{'players':PROJ},d);schema(b,'player_weekly')
 p=b['players'][0];ans.append({'pts':row(p)['pts'],'availability':p.get('availability'),
  'eligibility':p['eligibility'],'offers':playable_this_week(p,6),'oldweek':playable_this_week(p,5),
  'meta':b['model']['injury_source']})
emit(ans)`);
 for(const p of o){assert.ok(p.pts>0);assert.equal(p.availability,null);assert.equal(p.offers,false);assert.equal(p.oldweek,true);}
 assert.equal(o[0].eligibility.detail,'wrong_week');assert.equal(o[1].eligibility.detail,'wrong_week');
 assert.equal(o[2].eligibility.detail,'stale_report');assert.equal(o[2].meta.age_hours,26);
});

test('Week6: quarantine affects only matching player; FINAL and bye eligibility stay untouched',()=>{
 const o=run(`
q={'team':'ARI','player':'Prior Team Alias','athlete_id':'1','status':'Mystery','reason':'unmapped_status'}
d=report('Active',quarantine=[q]);b=build(d);check_weekly_availability(b,{'players':PROJ},d)
fin=build(report(timestamp='2026-10-11T20:10:35Z',week=5),skip=('SF',));bye=build(d,week=7)
other=build(report('Active',quarantine=[q|{'athlete_id':'999','team':'SF','player':'Runner One'}]))
emit({'one':b['players'][0],'two':b['players'][1].get('eligibility'),
 'fin':fin['players'][0],'bye':bye['players'][0].get('eligibility'),
 'other_id':other['players'][0].get('eligibility')})`);
 assert.equal(o.one.eligibility.detail,'quarantined_status');assert.ok(o.one.weeks.find(w=>w.wk===6).pts>0);
 assert.equal(o.two,null);assert.equal(o.fin.eligibility,undefined);assert.equal(o.fin.this_week,undefined);assert.equal(o.bye,null);
 assert.equal(o.other_id,null,'canonical ID prevents a same-name collision');
});

test('Week6: source health preserves actual last-success and age; quarantine is degraded',()=>{
 const o=run(`
d=report(timestamp='2026-10-11T15:00:00Z',week=5)
stale=bp.injury_feed_record(d,NOW,6,failure='source parser failed')
fresh=bp.injury_feed_record(report(quarantine=[{'team':'SF','player':'Runner One','athlete_id':'1','status':'Mystery','reason':'unmapped_status'}]),NOW,6)
unidentified=bp.injury_feed_record(report(quarantine=[{'reason':'unmapped_status'}]),NOW,6)
emit({'stale':stale,'fresh':fresh,'unidentified':unidentified})`);
 assert.equal(o.stale.age_hours,72);assert.equal(o.stale.last_success_utc,'2026-10-11T15:00:00Z');
 assert.equal(o.stale.rows,1);assert.equal(o.stale.status,'stale');assert.equal(o.fresh.status,'degraded');
 assert.equal(o.unidentified.status,'degraded');assert.match(o.unidentified.note,/unidentified_quarantine/);
});

test('Week6: actual slate caller retains week and validator rejects forged source/offer evidence',()=>{
 const o=run(`
p={'game_id':'G','home':'SF','away':'SEA','week':6,'kickoff_utc':NOW,'roof':'outdoor',
   'probs':{'home':.6,'away':.4},'model':'elo','estimate':True}
games=bp.week_game_rows([p,dict(p,week=5)],6)
schema({'season':2026,'week':6,'updated_utc':NOW,'games':games},'game_predictions')
d=report(timestamp='2026-10-11T15:00:00Z',week=5);b=build(d)
fail=[]
for mode in ('remove_refusal','lie_fresh','offer'):
 x=copy.deepcopy(b)
 try:
  if mode=='remove_refusal': x['players'][0].pop('eligibility');check_weekly_availability(x,{'players':PROJ},d)
  elif mode=='lie_fresh': x['model']['injury_source']['verified']=True;check_weekly_availability(x,{'players':PROJ},d)
  else: check_no_unplayable_legs(x,{'week':6,'parlays':[{'legs':[{'market':'rb_rush_yds','gsis_id':'espn-1','selection':'Runner One 60+'}]}]})
 except ValidationError: fail.append(mode)
emit({'games':games,'fail':fail})`);
 assert.equal(o.games.length,1);assert.equal(o.games[0].week,6);
 assert.deepEqual(o.fail,['remove_refusal','lie_fresh','offer']);
});

test('Week6: malformed/future timestamps and unidentifiable quarantine refuse recommendations',()=>{
 const o=run(`
docs=[report(timestamp='not-a-time'), report()|{'source_updated_utc':None}, report(timestamp='2026-10-15T15:00:00Z'),
      report(quarantine=[{'team':None,'player':None,'athlete_id':None,'status':'Mystery','reason':'unmapped_status'}])]
out=[]
for d in docs:
 b=build(d);check_weekly_availability(b,{'players':PROJ},d);schema(b,'player_weekly')
 out.append({'reason':b['model']['injury_source']['reason'],
             'refused':all(p.get('eligibility',{}).get('eligible') is False for p in b['players']),
             'positive':all(row(p)['pts']>0 for p in b['players'])})
emit(out)`);
 assert.deepEqual(o.map(x=>x.reason),['missing_timestamp','missing_timestamp','future_timestamp','unidentified_quarantine']);
 for(const x of o){assert.equal(x.refused,true);assert.equal(x.positive,true);}
});

test('Week6 review: team-only quarantine is local; valid other-team OUT remains authoritative',()=>{
 const o=run(`
d=report(quarantine=[{'team':'SF','player':None,'athlete_id':None,'status':'Mystery'}])
d['injuries'].append(av.enrich({'team':'SEA','player':'Receiver Two','status':'Out'}))
b=build(d);check_weekly_availability(b,{'players':PROJ},d);schema(b,'player_weekly')
emit({'verified':b['model']['injury_source']['verified'],'one':b['players'][0],
 'two':b['players'][1], 'health':bp.injury_feed_record(d,NOW,6)['status']})`);
 assert.equal(o.verified,true);assert.equal(o.health,'degraded');
 assert.equal(o.one.eligibility.detail,'quarantined_team');assert.equal(o.one.availability,undefined);
 assert.ok(o.one.weeks.find(w=>w.wk===6).pts>0);
 assert.equal(o.two.eligibility,undefined);assert.equal(o.two.this_week.status,'OUT');
 assert.equal(o.two.weeks.find(w=>w.wk===6).pts,0);
});

test('Week6 review: no-ID mover and ambiguous names cannot bypass quarantine; IDs win',()=>{
 const o=run(`
q={'team':'OLD','player':'Runner One','athlete_id':None,'status':'Mystery'}
d=report('Active',quarantine=[q]);b=build(d);check_weekly_availability(b,{'players':PROJ},d)
PROJ[1]['name']='Runner One'
amb=build(d);check_weekly_availability(amb,{'players':PROJ},d)
exact=build(report('Active',quarantine=[q|{'team':'SF'}]))
ids=build(report('Active',quarantine=[q|{'athlete_id':'2','team':'SF'}]))
emit({'mover':b['players'][0].get('eligibility'),
 'amb':[p.get('eligibility') for p in amb['players']],
 'exact':[p.get('eligibility') for p in exact['players']],
 'ids':[p.get('eligibility') for p in ids['players']]})`);
 assert.equal(o.mover.detail,'quarantined_status');
 assert.deepEqual(o.amb.map(p=>p.detail),['ambiguous_quarantine','ambiguous_quarantine']);
 assert.equal(o.exact[0].detail,'quarantined_status');assert.equal(o.exact[1],null);
 assert.equal(o.ids[0],null);assert.equal(o.ids[1].detail,'quarantined_status');
});

test('Week6 review: duplicate valid IR cannot medical-zero an ID-quarantined player in either producer pass',()=>{
 const o=run(`
q={'team':'OLD','player':'Old Name','athlete_id':'1','status':'Mystery'}
d=report('Injured Reserve',quarantine=[q]);d['injuries'].append(av.enrich(
 {'team':'SEA','player':'Receiver Two','status':'Injured Reserve'}))
b=build(d);check_weekly_availability(b,{'players':PROJ},d)
records=[dict(p,injury_status='ACTIVE') for p in PROJ]
before=copy.deepcopy(records[0]);counts=bp._apply_injury_report(records,d,NOW,6)
# Historical/fantasy facts already present are preserved, not guessed away.
historical=[dict(PROJ[0],injury_status='OUT',absence_weeks=2,absence_confidence='explicit')]
prior=copy.deepcopy(historical);bp._apply_injury_report(historical,d,NOW,6)
fail=[]
for mode in ('medical_zero','remove_refusal','blanket_refusal'):
 x=copy.deepcopy(b)
 if mode=='medical_zero': x['players'][0]['availability']={'status':'IR','class':'season'}
 elif mode=='remove_refusal': x['players'][0].pop('eligibility')
 else: x['players'][1]['eligibility']=copy.deepcopy(x['players'][0]['eligibility'])
 try: check_weekly_availability(x,{'players':PROJ},d)
 except ValidationError: fail.append(mode)
emit({'p':b['players'][0],'other':b['players'][1],'untouched':before==records[0],
 'other_record':records[1],'counts':counts,'history_preserved':prior==historical,'fail':fail})`);
 assert.equal(o.p.eligibility.detail,'quarantined_status');assert.equal(o.p.availability,undefined);
 assert.equal(o.p.this_week,undefined);assert.ok(o.p.weeks.find(w=>w.wk===6).pts>0);
 assert.equal(o.other.this_week.status,'IR');assert.equal(o.untouched,true);
 assert.equal(o.other_record.injury_status,'IR');assert.equal(o.other_record.absence_weeks,4);
 assert.deepEqual(o.counts,[1,1]);assert.equal(o.history_preserved,true);
 assert.deepEqual(o.fail,['medical_zero','remove_refusal','blanket_refusal']);
});

test('Week6 review: actual second-pass team scope preserves namesake guards and known independent inactive',()=>{
 const o=run(`
d=report('Out',quarantine=[{'team':'SF','player':None,'athlete_id':None,'status':'Mystery'}])
records=[dict(p,injury_status='ACTIVE') for p in PROJ]
d['injuries'].append(av.enrich({'team':'SEA','player':'Receiver Two','status':'Injured Reserve'}))
bp._apply_injury_report(records,d,NOW,6)
inactive={'week':6,'games':[{'game_id':'G','inactive':{'SF':[{'espn_id':'1'}]}}]}
b=bw.build_weekly_document(PROJ,SCHED,{'SF':1500,'SEA':1500},{},2026,NOW,
 factors=bw.build_factors(2026),first_week=6,this_week=6,injury_document=d,inactives=inactive)
check_weekly_availability(b,{'players':PROJ},d,inactives=inactive)
# Filtering a quarantined namesake must not make a remaining mover name unique.
names=[dict(PROJ[0],injury_status='ACTIVE'),dict(PROJ[1],name='Runner One',injury_status='ACTIVE')]
nd=report('Active',quarantine=[{'athlete_id':'1','status':'Mystery'}])
nd['injuries']=[av.enrich({'team':'OLD','player':'Runner One','status':'Out'})]
bp._apply_injury_report(names,nd,NOW,6)
emit({'records':records,'gate':b['players'][0]['this_week'],'names':names})`);
 assert.equal(o.records[0].injury_status,'ACTIVE');assert.equal(o.records[0].absence_weeks,undefined);
 assert.equal(o.records[1].injury_status,'IR');assert.equal(o.records[1].absence_weeks,4);
 assert.equal(o.gate.reason,'inactive');assert.equal(o.gate.playable,false);
 assert.deepEqual(o.names.map(p=>p.injury_status),['ACTIVE','ACTIVE']);
});

test('Week6 review: pregame report must be younger than 12h (10h control; 12h and 13h refused)',()=>{
 const o=run(`
out=[]
for ts in ('2026-10-14T05:00:00Z','2026-10-14T03:00:00Z','2026-10-14T02:00:00Z'):
 d=report(timestamp=ts);b=build(d);check_weekly_availability(b,{'players':PROJ},d)
 out.append({'state':b['model']['injury_source'],'p':b['players'][0]})
emit(out)`);
 assert.equal(o[0].state.verified,true);assert.equal(o[0].p.this_week.status,'OUT');
 for(const x of o.slice(1)){assert.equal(x.state.reason,'stale_report');assert.equal(x.state.max_age_hours,12);
  assert.equal(x.p.eligibility.detail,'stale_report');assert.ok(x.p.weeks.find(w=>w.wk===6).pts>0);}
});

test('Week6 review: quarantined QB duplicate does not return through the depth injury index',()=>{
 const o=run(`
PROJ[0]['position']='QB'
PROJ.append(dict(PROJ[0],gsis_id='espn-3',name='Backup Three'))
depth={'updated_utc':NOW,'teams':{'SF':{'QB':[
 {'espn_id':'1','name':'Runner One','rank':1},{'espn_id':'3','name':'Backup Three','rank':2}]}}}
q={'athlete_id':'1','team':'OLD','player':'Old Alias','status':'Mystery'}
d=report('Out',quarantine=[q])
scope,trusted=av.quarantine_inputs(PROJ,d)
b=bw.build_weekly_document(PROJ,SCHED,{'SF':1500,'SEA':1500},{},2026,NOW,
 factors=bw.build_factors(2026),first_week=6,this_week=6,injury_document=d,depth_chart=depth)
check_weekly_availability(b,{'players':PROJ},d,depth_chart=depth)
# A different canonical ID is never removed simply because a display name agrees.
different=copy.deepcopy(d);different['injuries'][0]['athlete_id']='999'
_,different_rows=av.quarantine_inputs(PROJ,different)
emit({'trusted':trusted,'starter':b['players'][0],'backup':b['players'][2],
 'different_ids':[r.get('athlete_id') for r in different_rows]})`);
 assert.deepEqual(o.trusted,[]);assert.equal(o.starter.eligibility.detail,'quarantined_status');
 assert.equal(o.starter.availability,undefined);assert.equal(o.starter.this_week,undefined);
 assert.ok(o.starter.weeks.find(w=>w.wk===6).pts>0);
 assert.equal(o.backup.this_week.reason,'depth');assert.equal(o.backup.this_week.playable,false);
 assert.deepEqual(o.different_ids,['999']);
});
