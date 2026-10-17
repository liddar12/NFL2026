import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = ROOT + 'scripts/prop_feature_shadow.py';
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import copy,datetime as dt,json,pathlib,tempfile
from unittest import mock
from scripts import prop_feature_shadow as S,build_leg_pool as P,learning_journal as J,export_learning as E,capture_outcome_evidence as C
POSITIONS=('QB','RB','WR');FIELD={'QB':'passing_yards','RB':'rushing_yards','WR':'receiving_yards'}
YARDS={'QB':250,'RB':100,'WR':100};COMP={'QB':'pass_yd','RB':'rush_yd','WR':'rec_yd'}
HEAD=('season','week','season_type','position','team','opponent_team','player_id','player_display_name','passing_yards','rushing_yards','receiving_yards')
def stamp(day):return '2026-08-%02dT12:00:00Z'%day
def kickoff(week,year=2026):
 return('2025-09-%02dT00:00:00Z'%min(week,28))if year==2025 else('2026-08-%02dT00:00:00Z'%(week if week<6 else 16 if week==6 else 23 if week==7 else 28))
def raw_capture(year,weeks,observed,extra_target=False,missing=False,crosswalk=False,void=False,pending=False,zero=False,scale=1):
 rows=[];snaps=[]
 for wk in list(weeks)+([max(weeks)+1]if extra_target else[]):
  for team,opp in(('SEA','LAR'),('LAR','SEA')):
   for pos in POSITIONS:
    value=YARDS[pos]*scale
    if extra_target and wk==max(weeks)+1:value=999999
    row={k:''for k in HEAD};row.update(season=str(year),week=str(wk),season_type='REG',position=pos,team=team,opponent_team=opp,
     player_id='00-'+team+'-'+pos,player_display_name=('Alpha 'if team=='SEA'else'Other ')+pos)
    row[FIELD[pos]]=''if missing and team=='SEA'and pos=='WR'else str(0 if zero else value)
    if crosswalk and team=='SEA'and pos=='WR':row['player_id']='00-different-WR'
    if not(void and team=='SEA'and pos=='WR'):rows.append(row)
    snaps.append({'season':str(year),'week':str(wk),'game_type':'REG','team':team,'player':'Different WR'if void and team=='SEA'and pos=='WR'else row['player_display_name'],'offense_snaps':'50'})
 def csv(headers,values):
  import io,csv
  out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=headers);w.writeheader();w.writerows(values);return out.getvalue().encode()
 stats=csv(HEAD,rows);snap=csv(('season','week','game_type','team','player','offense_snaps'),snaps)
 def fetch(spec):
  if spec['profile']==C.STATS_PROFILE:return 200,{},stats
  if spec['profile']==C.SNAPS_PROFILE:return 200,{},snap
  event={'id':'G'+str(spec['week']),'date':kickoff(spec['week'],year),'status':{'type':{'name':'STATUS_IN_PROGRESS'if pending else'STATUS_FINAL'}},
   'competitions':[{'competitors':[{'homeAway':'home','score':'24','team':{'abbreviation':'SEA'}},{'homeAway':'away','score':'17','team':{'abbreviation':'LAR'}}]}]}
  return 200,{},json.dumps({'season':{'year':year},'week':{'number':spec['week']},'events':[event]}).encode()
 clock=[dt.datetime.fromisoformat(observed.replace('Z','+00:00'))]
 def now():clock[0]+=dt.timedelta(seconds=1);return clock[0].isoformat().replace('+00:00','Z')
 return C.capture(year,list(weeks),fetcher=fetch,clock=now)
def forecast(root,week=6,created=None):
 created=created or stamp(11 if week==6 else 18);source=(dt.datetime.fromisoformat(created.replace('Z','+00:00'))-dt.timedelta(hours=1)).isoformat().replace('+00:00','Z')
 gp={'game_id':'G'+str(week),'week':week,'home':'SEA','away':'LAR','probs':{'home':.6,'away':.4}}
 players=[{'gsis_id':'00-SEA-'+p,'name':'Alpha '+p,'team':'SEA','position':p}for p in POSITIONS]
 weekly=[]
 for p in POSITIONS:
  weekly.append({'gsis_id':'00-SEA-'+p,'league_components':{COMP[p]:(210 if p=='QB'else 70)*18},
   'weeks':[{'wk':n,'pts':1,'opp':'LAR','home':True,'bye':False}for n in range(1,19)],
   'this_week':{'wk':week,'playable':True},'eligibility':{'week':week,'eligible':True}})
 bt={'updated_utc':source,'calibration':{p:{'a':0.,'b':1.,'c':0.}for p in POSITIONS},'support':{p:[-10,10]for p in POSITIONS},
  'residual_sd':{'QB':40.,'RB':30.,'WR':30.},'ladder':{p:[224.5 if p=='QB'else 59.5]for p in POSITIONS},'verdict':{'adopt':True}}
 inputs={'player_weekly':{'updated_utc':source,'players':weekly},'player_projections':{'updated_utc':source,'players':players},
  'game_predictions':{'updated_utc':source,'games':[gp]},'pool_backtest':bt,'parlays':{'season':2026,'week':week},'generated_utc':created,'excluded_games':[]}
 pool=P.build(inputs);schedule={'season':2026,'games':[{'game_id':'G'+str(n),'week':n,'home':'SEA','away':'LAR','kickoff_utc':kickoff(n),'status':'STATUS_SCHEDULED'}for n in range(1,19)]}
 recorded=(dt.datetime.fromisoformat(created.replace('Z','+00:00'))+dt.timedelta(minutes=1)).isoformat().replace('+00:00','Z')
 J.record(pool,schedule,None,[],recorded,str(root));return E.plan(root),inputs,pool
def training(week=6,**kwargs):return[raw_capture(2025,range(1,19),stamp(10)),raw_capture(2026,range(1,week),stamp(10 if week==6 else 17),**kwargs)]
def collect(plan,caps,week=6,recorded=None):return S.collect(plan,caps,season=2026,week=week,recorded_utc=recorded or stamp(11 if week==6 else 18).replace('12:00','12:02'),experiment_started_utc=stamp(1))
def evaluate(docs,plan,caps,training_caps,**kw):return S.evaluate(docs,plan,caps,training_captures=training_caps,as_of_utc=stamp(25),bootstrap_replicates=200,**kw)
def recapture(bundle,rows_change=None,game_change=None):
 import csv,io
 raw={}
 for ref in bundle['manifest']['sources']:
  obs=bundle['observations'][ref['observation_id']];data=bundle['raw_objects'][obs['raw_sha256']]
  if ref['profile']==C.STATS_PROFILE and rows_change:
   rows=rows_change(list(csv.DictReader(io.StringIO(data.decode()))));out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=HEAD);writer.writeheader();writer.writerows(rows);data=out.getvalue().encode()
  if ref['profile']==C.SCOREBOARD_PROFILE and game_change:data=json.dumps(game_change(json.loads(data),ref['week'])).encode()
  raw[(ref['profile'],ref['week'])]=data
 clock=[dt.datetime.fromisoformat(bundle['manifest']['started_utc'].replace('Z','+00:00'))]
 def now():clock[0]+=dt.timedelta(seconds=1);return clock[0].isoformat().replace('+00:00','Z')
 return C.capture(bundle['manifest']['season'],bundle['manifest']['weeks'],fetcher=lambda spec:(200,{},raw[(spec['profile'],spec['week'])]),clock=now)
def error(fn):
 try:fn()
 except Exception:return True
 return False
`;
function py(body) {
  const code=`import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/prop_feature_shadow.py').resolve());LINES=set()\ndef trace(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(FIXTURE+body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines=execFileSync('python3',['-'],{cwd:ROOT,input:code,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim().split('\n');
  for(const line of JSON.parse(lines.pop()).__trace__)covered.add(line);
  return JSON.parse(lines.pop());
}

test('actual pool producer and original pregame journal yield frozen feature twins without changing serving bytes',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,inputs,pool=forecast(pathlib.Path(tmp));caps=training();before=E.encoded({'plan':plan,'inputs':inputs,'pool':pool})
 with mock.patch.object(S.reference.PropCorpus,'_build_rows',side_effect=AssertionError('target rows forbidden')),mock.patch.object(S.reference,'fit_logistic',side_effect=AssertionError('no fitting')):
  doc=collect(plan,caps)
 print(json.dumps({'n':len(doc['rows']),'ready':all(r['status']=='ready'for r in doc['rows']),'unchanged':before==E.encoded({'plan':plan,'inputs':inputs,'pool':pool}),
  'mu':[(r['position'],r['shadow']['blend_mu'],r['shadow']['dvp_multiplier'])for r in doc['rows']],
  'weight':doc['candidate_weight'],'active':doc['activation'],'same':doc==collect(plan,caps),'source_status':doc['source_authentication']}))
`);
  assert.equal(r.n,3);assert.equal(r.ready,true);assert.equal(r.unchanged,true);assert.equal(r.same,true);assert.equal(r.weight,0);assert.equal(r.active,false);
  for(const [pos,mu,dvp]of r.mu){assert.equal(mu,pos==='QB'?250:100);assert.equal(dvp,1);}assert.equal(r.source_status,'not_performed');
});

test('target/future stat mutations cannot choose features, coefficients or an offered population',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));a=collect(plan,training());b=collect(plan,training(extra_target=True))
 print(json.dumps({'same':all(E._same_json(x['shadow']['features'],y['shadow']['features'])and x['shadow']['served_prob']==y['shadow']['served_prob']for x,y in zip(a['rows'],b['rows'])),
  'receipts':[r['source_receipt_id']for r in a['rows']]==[r['source_receipt_id']for r in b['rows']],'pins_differ':a['training_capture_ids']!=b['training_capture_ids']}))
`);
  assert.equal(r.same,true);assert.equal(r.receipts,true);assert.equal(r.pins_differ,true);
});

test('missing prior windows, raw IDs, finite values and late clocks hold explicitly rather than synthesize mu',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));cases=[]
 variants=[[],training()[1:],training(missing=True),[raw_capture(2025,range(1,19),stamp(10),crosswalk=True),training(crosswalk=True)[1]],[raw_capture(2025,range(1,18),stamp(10)),training()[1]],
  [training()[0],raw_capture(2026,range(1,6),stamp(12))],[training()[0],raw_capture(2026,range(1,6),stamp(10),pending=True)]]
 for caps in variants:
  doc=collect(plan,caps);cases.append({'reasons':sorted({x for r in doc['rows']for x in r['reason_codes']}),'held':sum(r['status']=='withheld'for r in doc['rows'])})
 late=collect(plan,training(),recorded=stamp(20));lateeval=evaluate([late],plan,[],training())
 print(json.dumps({'cases':cases,'late':lateeval['exclusions'],'late_n':lateeval['metrics']['n']}))
`);
  assert.ok(r.cases.every(c=>c.held>0&&c.reasons.length));assert.ok(r.cases.some(c=>c.reasons.includes('missing_exact_training_gsis_crosswalk')));
  assert.ok(r.cases.some(c=>c.reasons.includes('missing_training_measurement')));assert.ok(r.cases.some(c=>c.reasons.includes('training_source_after_forecast')));
  assert.equal(r.late_n,0);assert.equal(r.late.shadow_withheld,3);
});

test('raw tamper is refused and missing fixed profiles or invalid collection periods never become ready',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();bad=copy.deepcopy(caps);oid=next(iter(bad[0]['raw_objects']));bad[0]['raw_objects'][oid]+=b'tamper'
 failures=[error(lambda:collect(plan,bad)),error(lambda:S.collect(plan,caps,season=True,week=6,recorded_utc=stamp(11),experiment_started_utc=stamp(1))),
  error(lambda:S.collect(plan,caps,season=2026,week=0,recorded_utc=stamp(11),experiment_started_utc=stamp(1))),
  error(lambda:S.collect(plan,caps,season=2026,week=6,recorded_utc=stamp(11),experiment_started_utc=stamp(12)))]
 print(json.dumps({'failures':all(failures)}))
`);assert.equal(r.failures,true);
});

test('finite raw cells cannot overflow derived features into saturated or manufactured probabilities',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));docs=[]
 for scale in(1e305,1000):
  caps=[raw_capture(2025,range(1,19),stamp(10),scale=scale),raw_capture(2026,range(1,6),stamp(10),scale=scale)]
  docs.append(collect(plan,caps))
 print(json.dumps({'held':all(r['status']=='withheld'and r['shadow']is None for d in docs for r in d['rows']),
  'reasons':sorted({x for d in docs for r in d['rows']for x in r['reason_codes']})}))
`);assert.equal(r.held,true);assert.ok(r.reasons.includes('nonfinite_training_feature'));assert.ok(r.reasons.includes('shadow_probability_saturated'));
});

test('same-generation conflicting original capture clocks cannot overwrite lineage; exact copies remain harmless',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();duplicate=copy.deepcopy(plan);duplicate['generations']*=2
 good=collect(duplicate,caps);bad=copy.deepcopy(plan);copydoc=copy.deepcopy(plan['generations'][0]);doc=copydoc['request']['payload']
 doc['generations'][0]['recorded_utc']='2026-08-11T12:01:30Z'
 for row in doc['receipts']:row['recorded_utc']='2026-08-11T12:01:30Z'
 doc['envelope_id']=E.fingerprint({k:v for k,v in doc.items()if k!='envelope_id'});copydoc['request']['object_id']=doc['envelope_id'];bad['generations'].append(copydoc)
 print(json.dumps({'copies':len(good['rows']),'pins':len(good['generation_object_ids']),'rejected':error(lambda:collect(bad,caps))}))
`);assert.equal(r.copies,3);assert.equal(r.pins,1);assert.equal(r.rejected,true);
});

test('two synthetic future weeks pair the same original receipts and raw outcomes; statistical success never activates',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p6,_,_=forecast(root/'w6',6);p7,_,_=forecast(root/'w7',7);t6=training(6);t7=training(7);d6=collect(p6,t6,6);d7=collect(p7,t7,7)
 plan={'version':1,'source_objects':p6['source_objects']+p7['source_objects'],'generations':p6['generations']+p7['generations']}
 caps=[raw_capture(2026,[6,7],stamp(24))];r=evaluate([d6,d7],plan,caps,t6+t7,practical_margin=.0015);unreviewed=evaluate([d6,d7],plan,caps,t6+t7)
 print(json.dumps({'n':r['metrics']['n'],'positions':{p:x['n']for p,x in r['per_position'].items()},'weeks':r['graded_weeks'],'high':r['paired_interval']['high'],
  'delta':r['metrics']['log_loss_difference'],'held':r['promotion_held'],'active':r['activation'],'reasons':r['hold_reasons'],'unreviewed':unreviewed['hold_reasons'],
  'policy':r['outcome_policy'],'pins':len(r['outcome_pins']),'same':r==evaluate([d6,d7],plan,caps,t6+t7,practical_margin=.0015),
  'completeness':r['training_completeness_verified'],'row_completeness':all(x['shadow']['training_completeness_verified']is False for d in(d6,d7)for x in d['rows']),
  'scope':r['evaluation_scope']}))
`);
  assert.equal(r.n,6);assert.deepEqual(r.positions,{QB:2,RB:2,WR:2});assert.deepEqual(r.weeks,[[2026,6],[2026,7]]);assert.ok(r.high<0&&r.delta<0);
  assert.equal(r.held,true);assert.equal(r.active,false);assert.ok(r.reasons.includes('owner_approval_required'));assert.ok(r.unreviewed.includes('practical_margin_policy_unreviewed'));
  assert.equal(r.pins,1);assert.equal(r.same,true);assert.match(r.policy,/not_revision_selector/);
  assert.equal(r.completeness,false);assert.equal(r.row_completeness,true);assert.ok(r.reasons.includes('prior_game_inventory_not_independently_pinned'));assert.match(r.scope,/exploratory/);
});

test('original current-game inventory cannot shrink with a valid replacement event and missing expected-game stats',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training()
 def replace(doc,week):
  if week==1:doc['events'][0]['id']='G-UNEXPECTED'
  return doc
 changed=recapture(caps[1],lambda rows:[r for r in rows if r['week']!='1'],replace)
 doc=collect(plan,[caps[0],changed])
 print(json.dumps({'ready':sum(r['status']=='ready'for r in doc['rows']),'reasons':sorted({x for r in doc['rows']for x in r['reason_codes']}),
  'quarantine':changed['manifest']['audit']['quarantined_game_ids']}))
`);assert.equal(r.ready,0);assert.deepEqual(r.quarantine,[]);assert.deepEqual(r.reasons,['incomplete_current_training_game_inventory']);
});

test('unknown opponent REG rows remain unknown DvP even when a valid neighbor fills its position sheet',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training()
 def changed(rows):
  out=[]
  for row in rows:
   if row['team']=='LAR'and row['position']=='WR':
    other=dict(row);other.update(player_id='00-unknown-neighbor',player_display_name='Neighbor WR');out.append(other);row=dict(row);row['season_type']=''
   out.append(row)
  return out
 doc=collect(plan,[caps[0],recapture(caps[1],changed)])
 print(json.dumps({'wr':[r['reason_codes']for r in doc['rows']if r['position']=='WR'],'others':all(r['status']=='ready'for r in doc['rows']if r['position']!='WR')}))
`);assert.deepEqual(r.wr,[['malformed_recognized_training_history']]);assert.equal(r.others,true);
});

test('VOID is excluded, pending stays unknown and current outcome changes cannot rewrite frozen twins',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();doc=collect(plan,caps);before=E.encoded(doc)
 void=evaluate([doc],plan,[raw_capture(2026,[6],stamp(24),void=True)],caps)
 pending=evaluate([doc],plan,[raw_capture(2026,[6],stamp(24),pending=True)],caps)
 zero=evaluate([doc],plan,[raw_capture(2026,[6],stamp(24),zero=True)],caps)
 print(json.dumps({'void':void['exclusions'],'void_n':void['metrics']['n'],'pending':pending['exclusions'],'pending_n':pending['metrics']['n'],
  'zero_n':zero['metrics']['n'],'zero_worse':zero['metrics']['log_loss_difference']>0,'unchanged':before==E.encoded(doc),'holds':zero['hold_reasons']}))
`);
  assert.equal(r.void.void_not_zero,1);assert.equal(r.void_n,2);assert.equal(r.pending_n,0);assert.equal(r.pending.pending_or_unjoined_outcome,3);
  assert.equal(r.zero_n,3);assert.equal(r.zero_worse,true);assert.equal(r.unchanged,true);assert.ok(r.holds.includes('position_missing_or_worse'));
});

test('first forecast selection happens before outcome join and never substitutes a later available twin',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);first,_,_=forecast(root/'first');later,_,_=forecast(root/'later',created='2026-08-11T13:00:00Z');caps=training()
 doc=collect(later,caps,recorded='2026-08-11T13:02:00Z');combined={'version':1,'source_objects':first['source_objects']+later['source_objects'],'generations':first['generations']+later['generations']}
 r=evaluate([doc],combined,[raw_capture(2026,[6],stamp(24))],caps)
 dfirst=collect(first,caps);both=evaluate([dfirst,doc],combined,[raw_capture(2026,[6],stamp(24))],caps)
 print(json.dumps({'n':r['metrics']['n'],'reason':r['exclusions'],'both_n':both['metrics']['n'],'first_ids':sorted(x['source_receipt_id']for x in dfirst['rows'])==sorted(both['selected_receipt_ids'])}))
`);
  assert.equal(r.n,0);assert.equal(r.reason.missing_first_forecast_shadow,3);assert.equal(r.both_n,3);assert.equal(r.first_ids,true);
});

test('as-of membership excludes only validated future originals, including a new contract and later same-contract copies',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);first,_,_=forecast(root/'first');caps=training();doc=collect(first,caps)
 _,inputs,_=forecast(root/'unused',created='2026-08-13T12:00:00Z')
 for player in inputs['player_projections']['players']:
  if player['position']=='WR':player.update(gsis_id='00-NEW-WR',name='Future WR')
 for player in inputs['player_weekly']['players']:
  if player['gsis_id']=='00-SEA-WR':player['gsis_id']='00-NEW-WR'
 pool=P.build(inputs);schedule={'season':2026,'games':[{'game_id':'G'+str(n),'week':n,'home':'SEA','away':'LAR','kickoff_utc':kickoff(n),'status':'STATUS_SCHEDULED'}for n in range(1,19)]}
 J.record(pool,schedule,None,[],'2026-08-13T12:01:00Z',str(root/'future'));future=E.plan(root/'future')
 combined={'version':1,'source_objects':first['source_objects']+future['source_objects'],'generations':first['generations']+future['generations']}
 valid,rejected,_,_=S.outcomes._entries(combined,2026,{6})
 r=S.evaluate([doc],combined,[],training_captures=caps,as_of_utc='2026-08-12T12:00:00Z',bootstrap_replicates=200)
 # Same-clock inclusion is deliberate: this synthetic twin is recorded exactly
 # when the original forecast is created, not after the evaluation cutoff.
 at_cutoff=collect(first,caps,recorded=doc['rows'][0]['forecast_created_utc'])
 boundary=S.evaluate([at_cutoff],first,[],training_captures=caps,as_of_utc=at_cutoff['recorded_utc'],bootstrap_replicates=200)
 print(json.dumps({'valid_n':len(valid),'rejected':rejected,'selected':sorted(r['selected_receipt_ids']),
  'first':sorted(row['source_receipt_id']for row in doc['rows']),'boundary':sorted(boundary['selected_receipt_ids']),
  'exclusions':r['exclusions'],'n':r['metrics']['n']}))
`);
  assert.equal(r.valid_n,6);assert.deepEqual(r.rejected,[]);assert.deepEqual(r.selected,r.first);assert.deepEqual(r.boundary,r.first);
  assert.equal(r.n,0);assert.deepEqual(r.exclusions,{pending_or_unjoined_outcome:3});
});

test('aggregate shadow bytes and processed rows are bounded before any raw verification or replay',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();doc=collect(plan,caps);codes=[]
 for cap,value,docs in [('MAX_ROWS',5,[doc,doc]),('MAX_BYTES',len(E.encoded(plan))+len(E.encoded(doc))-1,[doc]),('MAX_BYTES',len(E.encoded(plan))-1,[])]:
  with mock.patch.object(S,cap,value),mock.patch.object(S,'collect',side_effect=AssertionError('replay must not run')),mock.patch.object(S,'_captures',side_effect=AssertionError('raw parse must not run')):
   try:S.evaluate(docs,plan,[],training_captures=caps,as_of_utc=stamp(25),bootstrap_replicates=200)
   except S.ShadowError as exc:codes.append(str(exc))
 with mock.patch.object(S,'collect',wraps=S.collect)as replay:
  duplicate=evaluate([doc,doc],plan,[raw_capture(2026,[6],stamp(24))],caps);replays=replay.call_count
 print(json.dumps({'codes':codes,'duplicate_n':duplicate['metrics']['n'],'duplicate_selected':len(duplicate['selected_receipt_ids']),
  'duplicate_pins':len(duplicate['shadow_ids']),'replays':replays}))
`);
  assert.deepEqual(r.codes,['shadow_evaluation_work_limit','shadow_evaluation_work_limit','shadow_evaluation_work_limit']);
  assert.equal(r.duplicate_n,3);assert.equal(r.duplicate_selected,3);assert.equal(r.duplicate_pins,1);assert.equal(r.replays,1);
});

test('resealed counterfeit features, missing original training bytes, overlapping label captures and malformed policies are refused',()=>{
  const r=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();doc=collect(plan,caps);out=[raw_capture(2026,[6],stamp(24))];failures=[]
 for kind in('prob','mu','weight','original','version','keys'):
  bad=copy.deepcopy(doc)
  if kind=='prob':bad['rows'][0]['shadow']['served_prob']=.99
  if kind=='mu':bad['rows'][0]['shadow']['blend_mu']=999
  if kind=='weight':bad['candidate_weight']=1
  if kind=='original':bad['rows'][0]['incumbent']['served_prob']=.99
  if kind=='version':bad['version']=True
  if kind=='keys':bad['extra']='untrusted'
  for row in bad['rows']:row['row_id']=S.receipts.fingerprint({k:v for k,v in row.items()if k!='row_id'})
  bad['shadow_id']=S.receipts.fingerprint({k:v for k,v in bad.items()if k!='shadow_id'})
  failures.append(error(lambda:evaluate([bad],plan,out,caps)))
 failures.extend([error(lambda:evaluate([doc],plan,out,[])),error(lambda:evaluate([doc],plan,out+out,caps)),error(lambda:evaluate([doc],plan,out,caps,practical_margin=True)),
  error(lambda:S.evaluate([doc],plan,out,training_captures=caps,as_of_utc=stamp(20),bootstrap_replicates=200)),
  error(lambda:S.evaluate([doc],plan,[],training_captures=caps,as_of_utc='2026-08-01T00:00:00Z',bootstrap_replicates=200)),
  error(lambda:S.evaluate([doc],plan,out,training_captures=caps,as_of_utc=stamp(25),bootstrap_replicates=True))])
 print(json.dumps({'all':all(failures),'n':len(failures)}))
`);assert.equal(r.all,true);assert.equal(r.n,12);
});

after(()=>{
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),sourceHash);
  const executable=JSON.parse(execFileSync('python3',['-c',`import json,trace;print(json.dumps(sorted(x for x in trace._find_executable_linenos(${JSON.stringify(SOURCE)})if x>0)))`],{encoding:'utf8'}));
  const all=new Set([...executable,...covered]);console.log(JSON.stringify({source:'scripts/prop_feature_shadow.py',sha256:sourceHash,covered:covered.size,total:all.size,percent:100*covered.size/all.size,missing:[...all].filter(x=>!covered.has(x)).sort((a,b)=>a-b),scope:'synthetic-prospective-logic-not-two-real-graded-weeks'}));
});
