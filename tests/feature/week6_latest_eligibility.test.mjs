// Newest read-only remote-main sample; older raw/source evidence is preserved.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SOURCES=['scripts/availability.py','scripts/build_predictions.py','scripts/build_weekly.py','scripts/validate_data.py'];
const pins=SOURCES.map(p=>createHash('sha256').update(readFileSync(ROOT+p)).digest('hex'));
after(()=>SOURCES.forEach((p,i)=>assert.equal(createHash('sha256').update(readFileSync(ROOT+p)).digest('hex'),pins[i])));
const SETUP=String.raw`
import copy,hashlib,importlib.util,json,pathlib
from scripts import availability as A,build_weekly as W,validate_data as V
from scripts.models.parlay_builder import playable_this_week
ROOT=pathlib.Path.cwd();BASE=ROOT/'tests/fixtures/week6_eligibility_baseline_45b3';OLD=BASE.parent/'week6_eligibility_baseline_0d49'
def source(path):
 p=BASE/path
 return json.loads((p if p.is_file()else OLD/path).read_bytes())
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,OLD/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
LA=module('historical_availability','scripts/availability.py');LW=module('historical_weekly','scripts/build_weekly.py');LW.availability=LA
inj=source('data/injuries.json');projections=source('data/player_projections.json');actual=source('data/player_weekly.json');schedule=source('data/schedule_full.json')['games']
wp={p['gsis_id']:p for p in actual['players']}
pr={p['gsis_id']:p for p in projections['players']}
common=dict(updated_utc=actual['updated_utc'],first_week=6,this_week=6,depth_chart=source('data/depth_chart.json'),inactives=None,
 injury_document=inj,gate_skip_teams=actual['model']['this_week'].get('skipped_final_teams',[]))
def replay(m,document=None):
 factors=m.build_factors(2026,source('data/dvp_positional_history.json'),source('data/environment_model.json'),source('data/weather_forecast.json'))
 kw=copy.deepcopy(common)
 if document is not None:kw['injury_document']=document
 # These are the already rounded/scaled intermediates retained in the original
 # weekly output, NOT the missing original fantasy producer inputs. Both sides
 # share them and the same neutral Elo; this is not a point-exact pipeline replay.
 kw['completions_by_id']={k:p.get('completions_prior',0)for k,p in wp.items()}
 kw['components_by_id']={k:{'components':copy.deepcopy(p['league_components']),
  'base_applied_pts':p['base_applied_pts'],'bonus_games':copy.deepcopy(p.get('bonus_games',{}))}
  for k,p in wp.items()if p.get('league_components')and p.get('base_applied_pts')is not None}
 return m.build_weekly_document(copy.deepcopy(projections['players']),copy.deepcopy(schedule),{},
  {k:p.get('receptions_prior',0)for k,p in wp.items()},season=2026,factors=factors,**kw)
def held(document):return{p['gsis_id']for p in document['players']if not playable_this_week(p,6)}
def emit(value):print(json.dumps(value,allow_nan=False))
`;
function py(body){
 const p=spawnSync('python3',['-B','-'],{cwd:ROOT,input:SETUP+'\n'+body,encoding:'utf8',timeout:45000,maxBuffer:3*1024*1024});
 assert.equal(p.status,0,p.stderr+p.stdout);return JSON.parse(p.stdout.trim().split('\n').at(-1));
}

test('latest thirteen raw files are byte-exact at45b3; reused factor/runtime authority is explicit and obsolete TNF inactives stay absent',()=>{
 const r=py(String.raw`
manifest=source('manifest.json');comparison=source('remote_comparison.json')
assert manifest['commit']==comparison['head']=='45b3cac4a0356b7e91b11121265ae1b84067fe93'
assert comparison['total_commits']==4 and comparison['runtime_code_or_workflow_changed']is False
assert len(comparison['changed_files'])==56
for path,pin in manifest['files'].items():
 raw=(BASE/path).read_bytes()
 assert len(raw)==pin['raw_bytes']
 assert hashlib.sha256(raw).hexdigest()==pin['raw_sha256']
 assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==pin['git_blob_sha1']
assert any(p=={'path':'data/inactives.json','status':'removed'}for p in comparison['changed_files'])
assert manifest['inactives']['state']=='absent_in_exact_commit'and common['inactives']is None
oldmanifest=json.loads((OLD/'manifest.json').read_bytes())
for path in manifest['reused_data_files']:
 raw=(OLD/path).read_bytes();assert hashlib.sha256(raw).hexdigest()==oldmanifest['files'][path]['raw_sha256']
emit({'files':len(manifest['files']),'players':len(wp),'injuries':len(inj['injuries']),'actual_held':len(held(actual)),
 'provider_authenticated':manifest['limits']['provider_authenticated'],'original_point_exact':manifest['limits']['original_point_exact_pipeline_reproduction']})
`);
 assert.deepEqual(r,{files:13,players:300,injuries:800,actual_held:32,provider_authenticated:false,original_point_exact:false});
});

test('full latest300-player same-input replay32→33 adds only the missed same-ID OUT and removes no prior refusal',()=>{
 const r=py(String.raw`
before,after=replay(LW),replay(W);oldp={p['gsis_id']:p for p in before['players']};newp={p['gsis_id']:p for p in after['players']}
V.check_weekly_availability(after,projections,inj,depth_chart=common['depth_chart'],inactives=None)
added=sorted(held(after)-held(before));removed=sorted(held(before)-held(after))
assert held(before)==held(actual)
assert added==['espn-3126486']and not removed
p=newp['espn-3126486'];assert p['this_week']['status']=='OUT'and p['this_week']['reason']=='status'
emit({'before':len(held(before)),'after':len(held(after)),'added':added,'removed':removed,
 'status':p['this_week']['status'],'skipped_final':common['gate_skip_teams']})
`);
 assert.deepEqual(r,{before:32,after:33,added:['espn-3126486'],removed:[],status:'OUT',skipped_final:['DEN','SEA']});
});

test('latest row-local unknown source quarantine affects only its target without recreating a medical zero',()=>{
 const r=py(String.raw`
before=replay(W);by={p['gsis_id']:p for p in before['players']}
pid=next(p['gsis_id']for p in before['players']if playable_this_week(p,6)
 and p['gsis_id'].startswith('espn-')and pr[p['gsis_id']]['team']not in common['gate_skip_teams'])
original=next(p for p in projections['players']if p['gsis_id']==pid)
document=copy.deepcopy(inj);document.setdefault('quarantine',[]).append({'athlete_id':pid[5:],'team':original['team'],
 'player':original['name'],'status':'SYNTHETIC-UNKNOWN-FOR-TEST','reason':'unmapped_status'})
after=replay(W,document);updated={p['gsis_id']:p for p in after['players']}
V.check_weekly_availability(after,projections,document,depth_chart=common['depth_chart'],inactives=None)
assert held(after)-held(before)=={pid}and not held(before)-held(after)
assert updated[pid]['eligibility']['reason']=='source_unverified'
assert all(updated[k]==by[k]for k in by if k!=pid)
assert updated[pid].get('availability')is None
assert all(row.get('avail')is not False for row in updated[pid]['weeks'])
emit({'added':1,'other_rows_changed':0,'held':len(held(after))})
`);
 assert.deepEqual(r,{added:1,other_rows_changed:0,held:34});
});

test('actual pool producer on the common latest frozen inputs removes the seven bad receiving rungs and ATD leg without changing other prices',()=>{
 const r=py(String.raw`
from scripts import build_leg_pool as P
def pool(weekly):
 inputs={key:source(path)for key,path in {'player_projections':'data/player_projections.json','game_predictions':'data/game_predictions.json',
  'pool_backtest':'data/leg_pool_backtest.json','parlays':'data/parlays.json','atd_week':'data/atd_week.json','atd_backtest':'data/atd_backtest.json'}.items()}
 inputs.update(player_weekly=weekly,excluded_games={r['game_id']for r in source('config/excluded_games.json')['games']},
  generated_utc='2026-10-16T14:48:03Z',generation_sha='controlled_common_runtime_not_original_execution_claim')
 return P.build(inputs)
before,after=pool(replay(LW)),pool(replay(W));oldp={p['gsis_id']:p for p in before['players']};newp={p['gsis_id']:p for p in after['players']}
assert set(oldp)-set(newp)=={'espn-3126486'}and not set(newp)-set(oldp)
def numeric(player):
 return {'identity':{k:v for k,v in player.items()if k!='rungs'},
  'rungs':[{k:r[k]for k in r if k!='learning_receipt'}for r in player['rungs']],
  'receipt_values':[{k:r['learning_receipt'][k]for k in('base_prob','served_prob','base_model_version','calibrator_version','features','input_context')}for r in player['rungs']]}
assert all(numeric(oldp[k])==numeric(newp[k])for k in newp)
assert before['game_legs']==after['game_legs']
olda={p['gsis_id']:p for p in before['atd_legs']};newa={p['gsis_id']:p for p in after['atd_legs']}
assert set(olda)-set(newa)=={'espn-3126486'}and not set(newa)-set(olda)
assert all(olda[k]==newa[k]for k in newa)
assert before['base_model_version']==after['base_model_version']and before['live_adjustment']==after['live_adjustment']
emit({'removed_rungs':len(oldp['espn-3126486']['rungs']),'prop_leg_delta':before['counts']['prop_legs']-after['counts']['prop_legs'],
 'removed_atd':len(olda)-len(newa),'other_numeric_changes':0,'game_legs_changed':False,'coefficients_changed':False})
`);
 assert.deepEqual(r,{removed_rungs:7,prop_leg_delta:7,removed_atd:1,other_numeric_changes:0,game_legs_changed:false,coefficients_changed:false});
});
