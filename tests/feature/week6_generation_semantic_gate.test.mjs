import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SOURCE=ROOT+'scripts/generation_semantic_gate.py';
const hash=createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered=new Set();
const FIXTURE=String.raw`
import copy,datetime as dt,json,pathlib,socket
from unittest.mock import patch
from scripts import generation_semantic_gate as G,build_leg_pool as P,build_my_cards as M
from scripts import build_weekly as W,availability as A,learning_journal as J,learning_receipts as R
from scripts.models import parlay_builder as B
SOURCE='2026-09-01T11:00:00Z';WEEKLY='2026-09-01T11:30:00Z';CAPTURE='2026-09-01T12:00:00Z'
GENERATED='2026-09-01T12:01:00Z';BOUND='2026-09-01T12:02:00Z';CHECKED='2026-09-01T12:03:00Z';KICK='2026-09-02T00:15:00Z'
def reseal(value,key):value[key]=G.fingerprint({k:v for k,v in value.items()if k!=key});return value
def originals(*,unknown=False,q=False,qb=False):
 players=[];injuries=[]
 for n,team in enumerate(('SEA','LAR','DAL','PHI'),1):
  players.append({'gsis_id':'espn-'+str(n),'name':'Player '+str(n),'team':team,'position':'QB'if qb and n==1 else'WR','proj_points':100.})
  injuries.append({'team':team,'player':'Player '+str(n),'status':'Questionable'if q and n==1 else'Active','athlete_id':str(n)})
 injury=A.enrich_document({'season':2026,'week':6,'updated_utc':SOURCE,'source':'espn','injuries':injuries})
 for n,row in enumerate(injury['injuries'],1):row['athlete_id']=str(n)
 injury.update(season=2026,week=6,source_updated_utc=SOURCE,received_utc=SOURCE,quarantine=[{'athlete_id':'1','status':'SYNTHETIC_UNKNOWN','reason':'unmapped_status'}]if unknown else[])
 games=[{'game_id':'G'+str(i+1),'season':2026,'week':6,'home':h,'away':a,'kickoff_utc':KICK,'status':'STATUS_SCHEDULED','probs':{'home':.6}}for i,(h,a)in enumerate((('SEA','LAR'),('DAL','PHI')))]
 components={p['gsis_id']:{'components':{'rec_yd':80.,'pass_yd':220.},'base_applied_pts':100.}for p in players}
 weekly=W.build_weekly_document(players,games,{t:1500. for t in('SEA','LAR','DAL','PHI')},{},2026,WEEKLY,
  injuries=[],first_week=6,components_by_id=components,factors=W.build_factors(2026),this_week=6,injury_document=injury)
 calibration={p:{'a':0.,'b':1.,'c':0.}for p in('QB','RB','WR')}
 bt={'season':2026,'updated_utc':WEEKLY,'model':'synthetic-pool-model-not-performance-evidence','calibration':calibration,
  'support':{p:[-5.,5.]for p in calibration},'residual_sd':{p:50. for p in calibration},'ladder':{p:[19.5,59.5,99.5]for p in calibration},'verdict':{'adopt':True}}
 return {'player_weekly':weekly,'player_projections':{'season':2026,'updated_utc':WEEKLY,'players':players},
  'game_predictions':{'season':2026,'updated_utc':WEEKLY,'games':games},'pool_backtest':bt,
  'parlays':{'season':2026,'week':6,'parlays':[]},'atd_week':None,'atd_backtest':None,'excluded_games':{'games':[]},
  'schedule':{'season':2026,'games':copy.deepcopy(games)},'parlay_calibration':None,'injuries':injury,
  'depth_chart':None,'inactives':None,'previous_my_cards':None}
def input_bytes(docs):return{k:G.encoded(v)for k,v in docs.items()}
def code_bytes():return{k:pathlib.Path(k).read_bytes()for k in G.CODE_NAMES}
def produce(docs,capture,raw,code,*,previous_graph=None):
 inputs={k:copy.deepcopy(docs[k])for k in('player_weekly','player_projections','game_predictions','pool_backtest','parlays','atd_week','atd_backtest')}
 inputs.update(excluded_games={str(g['game_id'])for g in docs['excluded_games']['games']},generated_utc=GENERATED,generation_sha=capture['generation_sha_claim'])
 pool=P.build(inputs)
 records=[M.card_record(dial,seed,rank,card,M.kickoff_index(docs['schedule']['games']))for dial,seed,rank,card in M.offered_cards(pool,docs['schedule']['games'],B._correlation_table(docs['parlay_calibration']),GENERATED)[0]]
 doc,snapshots=J.capture(pool,docs['schedule'],docs['parlay_calibration'],records,BOUND)
 archive=M.append(docs['previous_my_cards'],records,2026,6,GENERATED,BOUND)
 graph={'version':1,'source_objects':[{'version':1,'kind':'source_snapshot','object_id':oid,'payload':value}for oid,value in snapshots.items()],
  'generations':[{'request':{'version':1,'kind':'generation','object_id':doc['envelope_id'],'payload':doc},'expected_receipt_ids':sorted(doc['generations'][0]['receipt_ids'])}]}
 if previous_graph:
  known={s['object_id']for s in graph['source_objects']};graph['source_objects'] += [s for s in previous_graph['source_objects']if s['object_id']not in known];graph['generations']+=previous_graph['generations']
 outputs={'data/leg_pool.json':G.encoded(pool),'data/my_cards/2026_wk06.json':G.encoded(archive)}
 binding=G.bind_generation(capture,graph,outputs,target_generation_id=doc['generations'][0]['generation_id'],generated_utc=GENERATED,bound_utc=BOUND)
 return {'docs':docs,'input':raw,'code':code,'capture':capture,'graph':graph,'pool':pool,'archive':archive,'outputs':outputs,'binding':binding}
def fixture(**kwargs):
 docs=originals(**kwargs);raw=input_bytes(docs);code=code_bytes()
 # The capture precedes actual production. No after-the-fact file read is
 # represented as the original producer inputs in this fixture.
 capture=G.capture_inputs(raw,code,season=2026,week=6,captured_utc=CAPTURE,generation_sha='synthetic-code-revision-claim',policy=G.POLICY)
 return produce(docs,capture,raw,code)
def verify(f,**kw):return G.verify_generation(f['binding'],current_input_bytes={k:v for k,v in f['input'].items()if k in G.CURRENT_INPUT_NAMES},current_code_bytes=f['code'],current_output_bytes=f['outputs'],checked_utc=kw.pop('checked_utc',CHECKED),**kw)
def refreshed(f):
 f['input']=input_bytes(f['docs']);f['capture']=G.capture_inputs(f['input'],f['code'],season=2026,week=6,captured_utc=CAPTURE,generation_sha='synthetic-code-revision-claim',policy=G.POLICY)
 return produce(f['docs'],f['capture'],f['input'],f['code'])
`;
function py(body){
 const wrapped=`import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/generation_semantic_gate.py').resolve());LINES=set()\ndef trace(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(FIXTURE+body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
 const lines=execFileSync('python3',['-'],{cwd:ROOT,input:wrapped,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim().split('\n');
 JSON.parse(lines.pop()).__trace__.forEach(n=>covered.add(n));return JSON.parse(lines.pop());
}

test('original capture precedes actual pool/MY/journal production and verifies exact code, policy and output identity without IO',()=>{
 const result=py(String.raw`
f=fixture();before=G.encoded([f['docs'],f['capture'],f['binding'],f['archive']])
with patch('builtins.open',side_effect=AssertionError('IO')),patch('os.environ.get',side_effect=AssertionError('env')),patch('socket.create_connection',side_effect=AssertionError('network')):
 result=verify(f)
actual_runtime=J.policy_versions(f['docs']['parlay_calibration'])
assert f['capture']['runtime']['base_model_version']==R.base_version(f['docs']['pool_backtest']['calibration'],f['docs']['pool_backtest']['residual_sd'])
assert all(f['capture']['runtime'][k]==v for k,v in actual_runtime.items())
assert before==G.encoded([f['docs'],f['capture'],f['binding'],f['archive']])
print(json.dumps({'report':result,'no_positive_flags':all(result[k]is False for k in G.FLAGS),'sparse':all('this_week'not in r for r in f['docs']['player_weekly']['players'])}))
`);
 assert.equal(result.report.status,'supported_MY_prop_consumer_generation_pass');assert.equal(result.report.supported_consumer_pass,true);
 assert.equal(result.no_positive_flags,true);assert.equal(result.sparse,true);assert.equal(result.report.coverage.supported_players,4);
 assert.ok(result.report.coverage.target_archive_legs>0);assert.ok(result.report.unsupported.some(x=>x.includes('joint')));
});

test('a source-local unknown is withheld while unrelated eligible players survive, and Q stays in the pool without inventing archive labels',()=>{
 const r=py(String.raw`
rows=[]
for args in ({'unknown':True},{'q':True}):
 f=fixture(**args);result=verify(f)
 rows.append({'status':result['status'],'coverage':result['coverage'],'ids':[p['gsis_id']for p in f['pool']['players']],
  'q':[p.get('availability')for p in f['pool']['players']if p['gsis_id']=='espn-1'],
  'archive_has_q':any('availability'in l for c in f['archive']['cards']for l in c['legs'])})
print(json.dumps(rows))
`);
 assert.ok(r.every(x=>x.status==='supported_MY_prop_consumer_generation_pass'));
 assert.deepEqual(r[0].ids,['espn-2','espn-3','espn-4']);assert.equal(r[0].coverage.row_quarantined_players,1);
 assert.equal(r[0].coverage.withheld_not_playable_players,1);assert.deepEqual(r[1].q,['QUESTIONABLE']);assert.equal(r[1].archive_has_q,false);
});

test('existing compatible correction is applied exactly once and a mismatched base cannot authorize that layer',()=>{
 const r=py(String.raw`
rows=[]
for matching in(True,False):
 f=fixture();bt=f['docs']['pool_backtest'];base=R.base_version(bt['calibration'],bt['residual_sd'])
 bt['live_2026']={'applied':True,'receipt_policy':R.POLICY,'base_model_version':base if matching else G.fingerprint('wrong'),'adjustment':{'a':.2,'b':.9}}
 f=refreshed(f);result=verify(f);receipt=f['pool']['players'][0]['rungs'][0]['learning_receipt']
 rows.append({'status':result['status'],'matching':matching,'calibrator':receipt['calibrator'],
  'once':receipt['served_prob']==R.serve_probability(receipt['base_prob'],receipt['calibrator']),
  'not_twice':receipt['served_prob']!=R.serve_probability(receipt['served_prob'],receipt['calibrator'])if matching else True,
  'adoption':result['model_adoption']})
print(json.dumps(rows))
`);
 assert.ok(r.every(x=>x.status==='supported_MY_prop_consumer_generation_pass'&&x.once&&x.not_twice&&!x.adoption));
 assert.deepEqual(r[0].calibrator,{a:.2,b:.9});assert.equal(r[1].calibrator,null);
});

test('later display dedupe preserves original receipt vintage while the separate new pool binding remains exact',()=>{
 const r=py(String.raw`
first=fixture();old=G.encoded([first['capture'],first['archive'],first['graph']]);oldids={l['learning_receipt']['receipt_id']for c in first['archive']['cards']for l in c['legs']if l.get('learning_receipt')}
CAPTURE='2026-09-01T12:10:00Z';GENERATED='2026-09-01T12:11:00Z';BOUND='2026-09-01T12:12:00Z';CHECKED='2026-09-01T12:13:00Z'
docs=originals();docs['previous_my_cards']=first['archive'];raw=input_bytes(docs);code=code_bytes()
capture=G.capture_inputs(raw,code,season=2026,week=6,captured_utc=CAPTURE,generation_sha='synthetic-code-revision-claim',policy=G.POLICY)
second=produce(docs,capture,raw,code,previous_graph=first['graph']);result=verify(second,checked_utc=CHECKED)
newids={r['learning_receipt']['receipt_id']for p in second['pool']['players']for r in p['rungs']}
shown={l['learning_receipt']['receipt_id']for c in second['archive']['cards']for l in c['legs']if l.get('learning_receipt')}
held=[]
for mode in('prior_card','prior_run','wrong_prior_period'):
 bad=copy.deepcopy(second)
 if mode=='wrong_prior_period':
  bad['binding']['capture']['inputs']['previous_my_cards']['raw_utf8']=G.encoded({**first['archive'],'week':5}).decode()
  raw_previous=bad['binding']['capture']['inputs']['previous_my_cards']['raw_utf8'].encode()
  bad['binding']['capture']['inputs']['previous_my_cards'].update(raw_sha256='sha256:'+G.hashlib.sha256(raw_previous).hexdigest(),content_id=G.fingerprint(json.loads(raw_previous)))
  reseal(bad['binding']['capture'],'capture_id')
 else:
  changed=json.loads(bad['outputs']['data/my_cards/2026_wk06.json'])
  if mode=='prior_card':changed['cards'][0]['first_seen_utc']='2026-09-01T12:12:00Z'
  else:changed['runs'][0]['cards_seen']+=1
  bad['outputs']['data/my_cards/2026_wk06.json']=G.encoded(changed)
  bad['binding']['outputs']=G._freeze_bytes(bad['outputs'],G._paths(capture),documents=True)
 reseal(bad['binding'],'binding_id');held.append(not verify(bad,checked_utc=CHECKED)['supported_consumer_pass'])
print(json.dumps({'status':result['status'],'coverage':result['coverage'],'all_old':shown<=oldids,'new_disjoint':not bool(newids&oldids),
 'old_unchanged':old==G.encoded([first['capture'],first['archive'],first['graph']]),'public':result['public_serving_verified'],'held':held}))
`);
 assert.equal(r.status,'supported_MY_prop_consumer_generation_pass');assert.equal(r.all_old,true);assert.equal(r.new_disjoint,true);
 assert.equal(r.coverage.target_archive_legs,0);assert.ok(r.coverage.retained_archive_legs>0);assert.equal(r.old_unchanged,true);assert.equal(r.public,false);
 assert.deepEqual(r.held,[true,true,true]);
});

test('final byte/code changes and resealed capture/version tampering cannot reuse an earlier generation pass',()=>{
 const r=py(String.raw`
f=fixture();rows=[]
for mode in('input_raw','code','output','capture_hash','capture_version','binding_kind','binding_version','runtime','policy','graph','target','outputs_shape'):
 a=copy.deepcopy(f);kw={}
 if mode=='input_raw':a['input']['player_weekly']+=b'\n'
 elif mode=='code':a['code']['scripts/models/my_cards.py']+=b'\n# changed after rebase\n'
 elif mode=='output':a['outputs']['data/leg_pool.json']+=b'\n'
 elif mode=='capture_hash':a['binding']['capture']['capture_id']='sha256:'+'f'*64
 elif mode=='capture_version':a['binding']['capture']['version']=True;reseal(a['binding']['capture'],'capture_id')
 elif mode=='binding_kind':a['binding']['kind']='untrusted'
 elif mode=='binding_version':a['binding']['version']=True
 elif mode=='runtime':a['binding']['capture']['runtime']['base_model_version']='sha256:'+'e'*64;reseal(a['binding']['capture'],'capture_id')
 elif mode=='policy':a['binding']['capture']['policy']['injury_max_age_hours']=24.;reseal(a['binding']['capture'],'capture_id')
 elif mode=='graph':a['binding']['graph']['source_objects'][0]['payload']={'tampered':True}
 elif mode=='target':a['binding']['target_generation_id']='sha256:'+'c'*64
 else:a['binding']['outputs']['data/foreign.json']=a['binding']['outputs']['data/leg_pool.json']
 reseal(a['binding'],'binding_id');result=verify(a);rows.append({'mode':mode,'pass':result['supported_consumer_pass'],'reason':result['reason_codes']})
print(json.dumps(rows))
`);
 assert.equal(r.length,12);assert.ok(r.every(x=>x.pass===false&&x.reason.length===1));
});

test('invalid capture chronology, original clocks, late publication and undefined source policies remain held',()=>{
 const r=py(String.raw`
f=fixture();rows=[]
for mode in('before_bound','late','stale_final','future_source','missing_provider','wrong_injury_week','wrong_source_week','qb','inactives_window','missing_original'):
 a=copy.deepcopy(f);when=CHECKED
 if mode=='before_bound':when=CAPTURE
 elif mode=='late':when=KICK
 elif mode=='stale_final':when='2026-09-01T23:00:00Z'
 elif mode=='qb':a=fixture(qb=True)
 elif mode=='inactives_window':when='2026-09-01T22:00:00Z'
 elif mode=='missing_original':a['input'].pop('depth_chart')
 else:
  if mode=='future_source':a['docs']['injuries']['received_utc']='2026-09-01T12:00:01Z'
  elif mode=='missing_provider':a['docs']['injuries']['source_updated_utc']=None
  elif mode=='wrong_injury_week':a['docs']['injuries']['week']=5
  else:a['docs']['parlays']['week']=5
  # Resupply the changed bytes as a NEW claim, never mutate the original capture.
  try:a=refreshed(a)
  except (ValueError,KeyError):rows.append({'mode':mode,'held':True});continue
 result=verify(a,checked_utc=when);rows.append({'mode':mode,'held':not result['supported_consumer_pass'],'reason':result['reason_codes']})
print(json.dumps(rows))
`);
 assert.equal(r.length,10);assert.ok(r.every(x=>x.held));
 assert.ok(r.find(x=>x.mode==='qb').reason.includes('undefined_depth_freshness_policy'));
 assert.ok(r.find(x=>x.mode==='inactives_window').reason.includes('undefined_inactive_freshness_or_applicability'));
});

test('independent feature and once-only arithmetic rejects coordinated pool/receipt or candidate-accounting corruption',()=>{
 const r=py(String.raw`
f=fixture();rows=[]
for mode in('served_twice','mu','sd','p_team','coordinated_feature','omit_player','extra_player','counter','duplicate_weekly','wrong_team','wrong_game','unadopted'):
 a=copy.deepcopy(f)
 if mode in('duplicate_weekly','wrong_team','wrong_game','unadopted'):
  if mode=='duplicate_weekly':a['docs']['player_weekly']['players'].append(copy.deepcopy(a['docs']['player_weekly']['players'][0]))
  elif mode=='wrong_team':a['docs']['game_predictions']['games'][0]['home']='WRONG'
  elif mode=='wrong_game':a['docs']['game_predictions']['games'][0]['kickoff_utc']='2026-09-02T01:15:00Z'
  else:a['docs']['pool_backtest']['verdict']['adopt']=False
  a=refreshed(a)
 else:
  # Reseal ALL local envelopes after a coordinated forged pool. No stale hash
  # alone may be the only reason the semantic corruption is detected.
  pool=a['pool'];player=pool['players'][0];rung=player['rungs'][0];receipt=rung['learning_receipt']
  if mode=='served_twice':rung['model_prob']=R.serve_probability(receipt['served_prob'],{'a':1.,'b':1.})
  elif mode=='mu':receipt['features']['mu']+=20
  elif mode=='sd':receipt['features']['sd']*=2
  elif mode=='p_team':receipt['features']['p_team']=.1
  elif mode=='coordinated_feature':
   player['mu']+=20
   for candidate_rung in player['rungs']:
    source=candidate_rung['learning_receipt'];features=source['features'];features['mu']+=20;features['z']=(features['mu']-features['line'])/features['sd']
    source['base_prob']=R.base_probability(features['calibration'],features['z'],features['p_team']);source['served_prob']=R.serve_probability(source['base_prob'],source['calibrator'])
    candidate_rung['model_prob']=source['served_prob'];reseal(source,'receipt_id')
  elif mode=='omit_player':pool['players'].pop()
  elif mode=='extra_player':pool['players'].append(copy.deepcopy(player))
  else:pool['counts']['not_playable']+=1
  reseal(receipt,'receipt_id')
  records=[M.card_record(d,s,n,c,M.kickoff_index(a['docs']['schedule']['games']))for d,s,n,c in M.offered_cards(pool,a['docs']['schedule']['games'],B._correlation_table(None),GENERATED)[0]]
  doc,snapshots=J.capture(pool,a['docs']['schedule'],None,records,BOUND)
  if mode=='coordinated_feature':assert doc['generations'][0]['audit']['quarantined_records']==0
  archive=M.append(None,records,2026,6,GENERATED,BOUND)
  graph={'version':1,'source_objects':[{'version':1,'kind':'source_snapshot','object_id':oid,'payload':v}for oid,v in snapshots.items()],
   'generations':[{'request':{'version':1,'kind':'generation','object_id':doc['envelope_id'],'payload':doc},'expected_receipt_ids':sorted(doc['generations'][0]['receipt_ids'])}]}
  a['outputs']={'data/leg_pool.json':G.encoded(pool),'data/my_cards/2026_wk06.json':G.encoded(archive)}
  a['binding']=G.bind_generation(a['capture'],graph,a['outputs'],target_generation_id=doc['generations'][0]['generation_id'],generated_utc=GENERATED,bound_utc=BOUND)
 result=verify(a);rows.append({'mode':mode,'pass':result['supported_consumer_pass'],'reason':result['reason_codes']})
print(json.dumps(rows))
`);
 assert.equal(r.length,12);assert.ok(r.every(x=>!x.pass&&x.reason.length));
});

test('original producer duplicates or an empty supported universe cannot become a complete population PASS',()=>{
 const r=py(String.raw`
rows=[]
for mode in('duplicate_rung','all_unknown','malformed_code','unsupported_code_profile','decorated_base','changed_policy'):
 f=fixture()
 if mode in('duplicate_rung','all_unknown'):
  if mode=='duplicate_rung':f['docs']['pool_backtest']['ladder']['WR'].append(19.5)
  else:
   f['docs']['injuries']['quarantine']=[{'athlete_id':str(n),'status':'UNKNOWN','reason':'unmapped_status'}for n in range(1,5)]
   # Recompute the weekly consumer using the same genuine existing producer.
   players=f['docs']['player_projections']['players'];games=f['docs']['game_predictions']['games']
   f['docs']['player_weekly']=W.build_weekly_document(players,games,{t:1500. for t in('SEA','LAR','DAL','PHI')},{},2026,WEEKLY,
    injuries=[],first_week=6,components_by_id={p['gsis_id']:{'components':{'rec_yd':80.},'base_applied_pts':100.}for p in players},
    factors=W.build_factors(2026),this_week=6,injury_document=f['docs']['injuries'])
  f=refreshed(f);result=verify(f);assert not result['supported_consumer_pass'];rows.append(result['reason_codes'][0])
 else:
  code=copy.deepcopy(f['code'])
  if mode=='malformed_code':code['scripts/models/parlay_builder.py']=b'def PRIVATE_TOKEN_SECRET(:pass'
  elif mode=='unsupported_code_profile':code['scripts/models/parlay_builder.py']=code['scripts/models/parlay_builder.py'].replace(b'def _sigmoid(',b'def _unknown_sigmoid(')
  elif mode=='decorated_base':code['scripts/learning_receipts.py']=code['scripts/learning_receipts.py'].replace(b'def base_probability(',b'@untrusted\ndef base_probability(')
  else:code['scripts/build_weekly.py']=code['scripts/build_weekly.py'].replace(b'INJURY_MAX_AGE_HOURS = 12.0',b'INJURY_MAX_AGE_HOURS = 24.0')
  try:G.capture_inputs(f['input'],code,season=2026,week=6,captured_utc=CAPTURE,generation_sha='claim',policy=G.POLICY)
  except G.GateError as exc:
   assert 'PRIVATE_TOKEN_SECRET'not in str(exc);rows.append(str(exc))
  else:raise AssertionError(mode)
print(json.dumps(rows))
`);
 assert.equal(r.length,6);assert.ok(r.includes('duplicate_or_invalid_original_prop_contract'));
 assert.ok(r.every(x=>typeof x==='string'&&x.length>0));
});

test('present identity, period and raw injury contradictions hold; documented names and omitted metadata remain compatible',()=>{
 const r=py(String.raw`
held=[];original=fixture()
for mode in('team','position','name','projection_bool_position','projection_bool_team','projection_empty_position','opp','home','numeric_home','numeric_bye','numeric_avail','float_season','float_week','raw_status','status_counts','unknown_status','consistent_unknown','vocab'):
 f=copy.deepcopy(original);weekly=f['docs']['player_weekly']['players'][0];current_week=next(w for w in weekly['weeks']if w['wk']==6)
 if mode in('team','position','name'):weekly[mode]={'team':'DAL','position':'RB','name':'Other Player'}[mode]
 elif mode=='projection_bool_position':f['docs']['player_projections']['players'][0]['position']=True
 elif mode=='projection_bool_team':f['docs']['player_projections']['players'][0]['team']=True
 elif mode=='projection_empty_position':f['docs']['player_projections']['players'][0]['position']=''
 elif mode=='opp':current_week['opp']='WRONG'
 elif mode=='home':current_week['home']=not current_week['home']
 elif mode.startswith('numeric_'):current_week[mode.removeprefix('numeric_')]=0
 elif mode=='float_season':f['docs']['player_weekly']['season']=2026.
 elif mode=='float_week':current_week['wk']=6.
 elif mode=='raw_status':f['docs']['injuries']['injuries'][0]['status']='Out'
 elif mode=='status_counts':f['docs']['injuries']['counts']={'OUT':4}
 elif mode=='unknown_status':f['docs']['injuries']['injuries'][0]['status']='SYNTHETIC_UNMAPPED'
 elif mode=='consistent_unknown':
  row=f['docs']['injuries']['injuries'][0];row['status']='SYNTHETIC_UNMAPPED';row.update(A.enrich(row));f['docs']['injuries']['counts']=A.counts(f['docs']['injuries']['injuries'])
 else:f['docs']['injuries']['vocab_version']=True
 try:f=refreshed(f);result=verify(f)
 except G.GateError:held.append(True);continue
 held.append(not result['supported_consumer_pass'])
f=fixture();f['docs']['player_projections']['players'][0]['name']='Marquise Brown'
f['docs']['player_weekly']['players'][0].update(name='Hollywood Brown',team='sea',position='wr')
# Both displayed names refer to the already exact same GSIS. This is never a
# name-only join or an initial/surname guess; the existing explicit rename is used.
f['docs']['injuries']['injuries'][0]['player']='Marquise Brown';f=refreshed(f)
positive=verify(f)
unsupported=copy.deepcopy(original);unsupported['docs']['player_projections']['players'][0]['position']='TE';unsupported=refreshed(unsupported);unsupported_report=verify(unsupported)
print(json.dumps({'held':held,'alias':positive['status'],'unsupported':{'status':unsupported_report['status'],'coverage':unsupported_report['coverage']},'flags':{k:positive[k]for k in G.FLAGS}}))
`);
 assert.equal(r.held.length,18);assert.ok(r.held.every(Boolean));assert.equal(r.alias,'supported_MY_prop_consumer_generation_pass');
 assert.equal(r.unsupported.status,'supported_MY_prop_consumer_generation_pass');assert.equal(r.unsupported.coverage.unsupported_position_players,1);
 assert.equal(r.unsupported.coverage.supported_players,3);
 assert.ok(Object.values(r.flags).every(x=>x===false));
});

test('known source IDs outrank failed name fallback without inventing a crosswalk or medical zeros',()=>{
 const r=py(String.raw`
rows=[]
for mode in('OUT_lost_name','RETIRED_lost_name','Q_lost_name','correct_OUT','ambiguous_id','bad_id','long_id','padded_id','explicit_crosswalk','unmapped_no_guess'):
 f=fixture();injury=f['docs']['injuries'];original=injury['injuries'][0]
 if mode in('OUT_lost_name','RETIRED_lost_name','Q_lost_name','correct_OUT'):
  original['status']='Reserve-Ret'if mode=='RETIRED_lost_name'else'Questionable'if mode=='Q_lost_name'else'Out'
  original.update(A.enrich(original));injury['counts']=A.counts(injury['injuries'])
 if mode.endswith('lost_name'):f['docs']['player_projections']['players'][0]['name']='Unrelated Receiver'
 elif mode=='ambiguous_id':f['docs']['player_projections']['players'][0]['espn_id']='2'
 elif mode=='bad_id':original['athlete_id']=True
 elif mode=='long_id':original['athlete_id']='1'*33
 elif mode=='padded_id':original['athlete_id']='01'
 elif mode in('explicit_crosswalk','unmapped_no_guess'):
  f['docs']['player_projections']['players'][0]['gsis_id']='00-explicit-only';f['docs']['player_weekly']['players'][0]['gsis_id']='00-explicit-only'
  if mode=='explicit_crosswalk':f['docs']['player_projections']['players'][0]['espn_id']='1'
 if mode=='correct_OUT':
  players=f['docs']['player_projections']['players'];games=f['docs']['game_predictions']['games']
  f['docs']['player_weekly']=W.build_weekly_document(players,games,{t:1500. for t in('SEA','LAR','DAL','PHI')},{},2026,WEEKLY,
   injuries=[],first_week=6,components_by_id={p['gsis_id']:{'components':{'rec_yd':80.},'base_applied_pts':100.}for p in players},
   factors=W.build_factors(2026),this_week=6,injury_document=injury)
 f=refreshed(f);result=verify(f);rows.append({'mode':mode,'pass':result['supported_consumer_pass'],'reason':result['reason_codes'],
  'ids':[p['gsis_id']for p in f['pool']['players']],'medical':result['provider_authenticated']})
print(json.dumps(rows))
`);
 for(const row of r)assert.equal(row.pass,['correct_OUT','explicit_crosswalk','unmapped_no_guess'].includes(row.mode),JSON.stringify(row));
 assert.deepEqual(r.find(x=>x.mode==='correct_OUT').ids,['espn-2','espn-3','espn-4']);assert.ok(r.every(x=>x.medical===false));
});

test('strict work bounds and malformed JSON are static refusals, not partial positive gate results',()=>{
 const r=py(String.raw`
f=fixture();held=[]
for value in(None,[],{},True,{'SECRET':float('inf')}, {'x':object()}):
 result=G.verify_generation(value,current_input_bytes=f['input'],current_code_bytes=f['code'],current_output_bytes=f['outputs'],checked_utc=CHECKED)
 assert not result['supported_consumer_pass']and 'SECRET'not in json.dumps(result);held.append(result['status'])
for raw in(b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":1e999}',b'not-json'):
 try:G._json(raw)
 except (ValueError,TypeError):held.append('invalid')
 else:raise AssertionError('malformed source accepted')
for mutate in(lambda a:a.pop('injuries'),lambda a:a.update(injuries='not-bytes'),lambda a:a.update(injuries=b'')):
 raw=copy.deepcopy(f['input']);mutate(raw)
 try:G.capture_inputs(raw,f['code'],season=2026,week=6,captured_utc=CAPTURE,generation_sha='claim',policy=G.POLICY)
 except (ValueError,TypeError):held.append('capture')
 else:raise AssertionError('bad capture accepted')
with patch.object(G,'MAX_BYTES',1):
 result=verify(f);assert not result['supported_consumer_pass'];held.append('bounded')
with patch.object(G,'MAX_FILE',1):
 result=verify(f);assert not result['supported_consumer_pass'];held.append('bounded')
for args in((True,6,CAPTURE,'claim'),(2026,True,CAPTURE,'claim'),(2026,6,'naive','claim'),(2026,6,CAPTURE,'')):
 try:G.capture_inputs(f['input'],f['code'],season=args[0],week=args[1],captured_utc=args[2],generation_sha=args[3],policy=G.POLICY)
 except ValueError:held.append('argument')
 else:raise AssertionError('bad argument')
print(json.dumps({'held':len(held),'source_unchanged':f['code']['scripts/generation_semantic_gate.py']==pathlib.Path('scripts/generation_semantic_gate.py').read_bytes()}))
`);
 assert.equal(r.held,19);assert.equal(r.source_unchanged,true);
});

after(()=>{
 assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),hash,'source remains frozen during tests');
 const eligible=JSON.parse(execFileSync('python3',['-c',`import dis,json,pathlib,types\np=pathlib.Path('scripts/generation_semantic_gate.py');c=compile(p.read_text(),str(p),'exec');lines=set()\ndef walk(c):\n lines.update(n for _,n in dis.findlinestarts(c) if n>0)\n for v in c.co_consts:\n  if isinstance(v,types.CodeType):walk(v)\nwalk(c);print(json.dumps(sorted(lines)))`],{cwd:ROOT,encoding:'utf8'}));
 const denominator=new Set(eligible),executed=[...covered].filter(n=>denominator.has(n));
 const missing=[...denominator].filter(n=>!covered.has(n));
 console.log(JSON.stringify({source:'scripts/generation_semantic_gate.py',sha256:hash,covered:executed.length,total:denominator.size,percent:100*executed.length/denominator.size,missing,
  scope:'explicit synthetic original-input capture and actual producer local mechanics only; no hook or deployment authority'}));
 assert.ok(executed.length/denominator.size>=.9,'at least90% measured executable-line coverage');
});
