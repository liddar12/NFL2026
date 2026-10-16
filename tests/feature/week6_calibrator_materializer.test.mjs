import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SOURCE=ROOT+'scripts/materialize_calibrator.py';
const sourceHash=createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const protectedNames=['scripts/build_leg_pool.py','scripts/learning_receipts.py','scripts/backtest_leg_pool.py'];
const protectedHashes=protectedNames.map(name=>createHash('sha256').update(readFileSync(ROOT+name)).digest('hex'));
const covered=new Set();
// Synthetic report and owner-intent CLAIM fixtures, never real approval,
// operational evidence, a fit, an authenticated owner or an active model.
const FIXTURE=String.raw`
import copy,datetime as dt,json,pathlib,tempfile
from unittest import mock
from scripts import materialize_calibrator as M,learning_receipts as R
HASH=R.fingerprint
CAL={p:{'a':0.,'b':1.,'c':0.}for p in('QB','RB','WR')};SD={'QB':40.,'RB':30.,'WR':30.}
BASE=R.base_version(CAL,SD)
NFL_CODE=HASH('synthetic-nfl-code-pin');ENGINE_CODE=HASH('synthetic-engine-code-pin')
NOW='2026-09-26T12:00:00Z'
def timeplus(value,seconds):return(R.instant(value)+dt.timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')
def seal(value,field):return{**value,field:HASH(value)}
def reseal(value,field):value[field]=HASH({k:v for k,v in value.items()if k!=field});return value
def candidate(coef=None,cutoff='2026-09-25T00:00:00Z',population='eligible_pool',extra_row=None):
 rows=[]
 for n in range(120):
  event='nfl:2026:game:synthetic-'+str(n)
  row={'receipt_id':HASH(['receipt',n]),'source_receipt_id':HASH(['source',n]),'contract_id':HASH(['contract',n]),
   'event_id':event,'correlation_group':event,'season':2026,'week':1+n%3,'position':('QB','RB','WR')[n%3],
   'base_prob':.6,'served_prob':.6,'hit':bool(n%2),'forecast_created_utc':'2026-08-01T12:00:00Z',
   'first_seen_utc':'2026-08-01T12:01:00Z','event_start_utc':'2026-08-02T00:00:00Z',
   'resolved_utc':'2026-08-02T04:00:00Z','outcome_recorded_utc':'2026-08-02T04:01:00Z',
   'base_model_version':BASE,'revision_id':'synthetic-rev-'+str(n),'revision_hash':HASH(['revision',n])}
  if population=='offered_my':row['offering']={'object_id':HASH(['genobject',n]),'generation_id':HASH(['gen',n]),
   'captured_utc':'2026-08-01T12:01:00Z','recorded_utc':'2026-08-01T12:02:00Z','card_ids':['synthetic-card-'+str(n)]}
  rows.append(row)
 if extra_row is not None:rows[0]=copy.deepcopy(extra_row)
 rows.sort(key=lambda r:r['contract_id'])
 training={'population':population,'membership_policy':'committed_generations_v1','cutoff_utc':cutoff,'n':len(rows),
  'fit_rule':'ridge_newton_logit_base_v1','ridge':.001,'dataset_id':HASH(rows),'rows':rows}
 return seal({'version':1,'kind':M.KIND,'task':M.TASK,'state':'shadow','automatic_promotion':False,
  'evidence_status':'retrospective_reconstruction','receipt_policy':R.POLICY,'base_model_version':BASE,
  'transform':copy.deepcopy(M.TRANSFORM),'coefficients':coef or{'a':.2,'b':.9},'fit_as_of_utc':cutoff,'training':training},'candidate_id')
def report(c):
 metrics={'n':6,'incumbent_log_loss':.7,'candidate_log_loss':.6,'base_log_loss':.75,'delta_log_loss':-.1}
 value={'version':1,'kind':'nfl.my_props.walk_forward.v1','evaluation_kind':M.EVALUATION_KIND,'population':c['training']['population'],
  'as_of_utc':c['fit_as_of_utc'],'cohort_n':c['training']['n'],'cohort_id':c['training']['dataset_id'],
  'membership_policy':c['training']['membership_policy'],'candidate':c,'automatic_promotion':False,'public_serving_verified':False,
  'shared_shadow_numeric_gate':{'passed':True,'failures':[],'min_legs':100,'min_training_contracts_per_fold':100,'min_held_out_week_folds':2,
   'status':'proposed_shared_fitter_and_stricter_numeric_policy_not_current_nfl_R100_parity'},
  'proposed_shared_return_gate':{'passed':True,'failures':[],'additional_margin':.0015,'status':'proposed_policy_not_production_authorization'},
  'current_nfl_rules_reference':{'baseline':'synthetic-reference-not-production','parity_executed':False},
  'metrics':metrics,'per_position':{p:{'n':2,'delta_log_loss':-.1}for p in('QB','RB','WR')},
  'paired_game_interval':{'low':-.2,'high':-.01,'groups':2},'folds':[{'status':'scored','candidate_log_loss':.6,'base_log_loss':.75,'incumbent_log_loss':.7}for _ in range(2)],
  'fixture_scope':'synthetic-gate-claims-not-measured-performance'}
 return seal(value,'report_id')
def context(created='2026-09-26T13:00:00Z',kickoff='2026-09-27T00:00:00Z',week=4):
 return seal({'version':1,'kind':'nfl.future_generation_context.v1','season':2026,'week':week,'forecast_created_utc':created,
  'first_kickoff_utc':kickoff,'base_model_version':BASE,'source_snapshot_id':HASH(['synthetic-inputs',created]),
  'nfl_code_id':NFL_CODE,'engine_code_id':ENGINE_CODE},'context_id')
def policy(r):
 return seal({'version':1,'kind':'nfl.calibrator_materializer_policy.v1','base_model_version':BASE,
  'nfl_code_id':NFL_CODE,'engine_code_id':ENGINE_CODE,'evaluation_policy_id':M.evaluation_policy_id(r),
  'max_candidate_age_seconds':30*86400,'max_authority_age_seconds':600},'policy_id')
def event(query,ctx,*,history=(),now=NOW,action='approve'):
 return seal({'version':1,'kind':'selflearn.owner_calibrator_intent.v1','sequence':len(history)+1,
  'previous_event_id':history[-1]['event_id']if history else None,'action':action,'season':ctx['season'],'weeks':[ctx['week']],
  'markets':['qb_pass_yds','rb_rush_yds','wr_rec_yds'],'target_candidate_id':query['candidate_id'],'target_artifact_id':query['artifact_id'],
  'evaluation_report_id':query['evaluation_report_id'],'policy_id':query['policy_id'],'generation_context_id':ctx['context_id'],
  'expected_previous_current_id':query['current_id'],'evidence_status_acknowledged':'retrospective_reconstruction',
  'reason':'synthetic_local_mechanics_only','actor_ref':'fixture_not_authenticated_owner','recorded_utc':timeplus(now,-2),
  'effective_from_utc':timeplus(now,-1),'expires_utc':ctx['first_kickoff_utc']},'event_id')
def snapshot(events,now=NOW):
 return seal({'version':1,'kind':'selflearn.owner_intent_snapshot_claim.v1','namespace':dict(M.NAMESPACE),'complete':True,
  'events':list(events),'head_sequence':len(events),'head_event_id':events[-1]['event_id'],
  'observed_utc':now,'expires_utc':timeplus(now,300)},'snapshot_id')
class FakeAuthority:
 def __init__(self,ctx,*,history=(),now=NOW,action='approve',mutate=None):
  self.context=ctx;self.history=history;self.now=now;self.action=action;self.mutate=mutate;self.calls=[];self.value=None
 def __call__(self,query):
  self.calls.append(copy.deepcopy(query));events=list(self.history)+[event(query,self.context,history=self.history,now=self.now,action=self.action)]
  value=snapshot(events,self.now)
  if self.mutate:self.mutate(value)
  self.value=copy.deepcopy(value);return value
def setup():
 c=candidate();r=report(c);ctx=context();p=policy(r);current=M.current_pin(BASE)
 return c,r,ctx,current,p
def run(values,authority=None,**kwargs):return M.materialize(*values,authority_reader=authority,now_utc=kwargs.pop('now_utc',NOW),**kwargs)
def source_receipt(draft,ctx,*,game='synthetic-new',player='00-synthetic-new'):
 leg={'game_id':game,'gsis_id':player,'market':'wr_rec_yds','line':59.5,'side':'home'}
 features={'market':leg['market'],'line':59.5,'mu':65.5,'sd':30.,'z':.2,'p_team':.5,'calibration':CAL['WR'],'correlation_tags':['game:'+game]}
 base=R.base_probability(features['calibration'],features['z'],features['p_team'])
 context={'season':2026,'week':ctx['week'],'forecast_created_utc':ctx['forecast_created_utc'],'base_model_version':BASE,
  'source_snapshot_id':ctx['source_snapshot_id'],'source_timestamps':{'fixture':timeplus(ctx['forecast_created_utc'],-3600)},'generation_sha':'synthetic-only'}
 return R.make_receipt(leg,base,None if draft is None else draft['coefficients'],context,features=features,
  input_context={'scope':'synthetic-not-active','materialization_id':None if draft is None else draft['materialization_id']})
`;
function py(body){
 const code=`import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/materialize_calibrator.py').resolve());LINES=set()\ndef trace(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(FIXTURE+body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
 const lines=execFileSync('python3',['-'],{cwd:ROOT,input:code,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim().split('\n');
 JSON.parse(lines.pop()).__trace__.forEach(line=>covered.add(line));return JSON.parse(lines.pop());
}

test('default missing authority and unavailable callbacks hold; JSON cannot authorize or select a URL',()=>{
 const r=py(String.raw`
values=setup();before=M.encoded(values);calls=[]
def unavailable(query):calls.append(query);raise RuntimeError('PRIVATE_DIAGNOSTIC')
out=[run(values),run(values,unavailable),run(values,{'verified':True,'url':'https://evil.invalid'})]
print(json.dumps({'out':out,'unchanged':before==M.encoded(values),'calls':len(calls)}))
`);
 assert.deepEqual(r.out.map(x=>x.status),['held','held','held']);assert.ok(r.out.every(x=>x.draft===null&&x.serving_changed===false&&x.release_authorized===false));
 assert.deepEqual(r.out[0].reason_codes,['owner_authority_unavailable']);assert.equal(r.unchanged,true);assert.equal(r.calls,1);
 assert.ok(!JSON.stringify(r).includes('PRIVATE_DIAGNOSTIC'));
});

test('only a detached non-active draft is materialized from explicit callback claims and exact compatible pins',()=>{
 const r=py(String.raw`
values=setup();authority=FakeAuthority(values[2]);before=M.encoded(values)
with mock.patch('builtins.open',side_effect=AssertionError('no IO')),mock.patch('socket.create_connection',side_effect=AssertionError('no network')):
 result=run(values,authority)
draft=result['draft'];same=result==run(values,FakeAuthority(values[2]))
print(json.dumps({'result':result,'same':same,'unchanged':before==M.encoded(values),'calls':len(authority.calls),
 'artifact_matches':draft['artifact_id']==M.artifact_id(values[0]),'hash_matches':draft['materialization_id']==HASH({k:v for k,v in draft.items()if k!='materialization_id'})}))
`);
 assert.equal(r.result.status,'materialized_draft');assert.equal(r.result.draft.status,'not_active');assert.equal(r.result.draft.candidate_evidence_status,'retrospective_reconstruction');
 assert.equal(r.result.authority_basis,'supplied_claim_from_trusted_callback');assert.equal(r.result.draft.evaluation_basis,'hash_bound_supplied_report_not_reexecuted');
 for(const key of ['owner_authorization_verified','release_authorized','serving_changed','model_adoption','working_learning_loop'])assert.equal(r.result[key],false);
 assert.equal(r.same,true);assert.equal(r.unchanged,true);assert.equal(r.artifact_matches,true);assert.equal(r.hash_matches,true);assert.equal(r.calls,1);
});

test('two synthetic feedback cycles and explicit compatible rollback use actual NFL transform once without rewriting old records',()=>{
 const r=py(String.raw`
a=setup();authA=FakeAuthority(a[2]);dA=run(a,authA)['draft'];sourceA=source_receipt(dA,a[2]);revisionA={'source_receipt_id':sourceA['receipt_id'],'actual':80.,'hit':True,'recorded_utc':'2026-09-27T04:00:00Z','fixture_not_authoritative':True}
oldA=M.encoded([sourceA,revisionA,a[1],dA]);row=copy.deepcopy(a[0]['training']['rows'][0])
row.update(receipt_id=HASH(['generic',sourceA['receipt_id']]),source_receipt_id=sourceA['receipt_id'],contract_id=sourceA['contract_id'],
 event_id='nfl:2026:game:'+sourceA['game_id'],correlation_group='nfl:2026:game:'+sourceA['game_id'],position='WR',week=sourceA['week'],
 base_prob=sourceA['base_prob'],served_prob=sourceA['served_prob'],hit=True,forecast_created_utc=sourceA['forecast_created_utc'],
 first_seen_utc=timeplus(sourceA['forecast_created_utc'],60),event_start_utc=a[2]['first_kickoff_utc'],resolved_utc='2026-09-27T03:59:00Z',outcome_recorded_utc=revisionA['recorded_utc'])
cB=candidate({'a':.4,'b':.85},'2026-09-30T00:00:00Z',extra_row=row);rB=report(cB);ctxB=context('2026-10-01T13:00:00Z','2026-10-02T00:00:00Z',5)
currentA=M.current_pin(BASE,dA['coefficients'],artifact=dA['artifact_id'],materialization=dA['materialization_id']);pB=policy(rB);b=(cB,rB,ctxB,currentA,pB)
authB=FakeAuthority(ctxB,history=authA.value['events'],now='2026-10-01T12:00:00Z');dB=run(b,authB,prior_materializations=[dA],issued_receipts=[sourceA],now_utc=authB.now)['draft']
sourceB=source_receipt(dB,ctxB,game='synthetic-next',player='00-synthetic-next');revisionB={'source_receipt_id':sourceB['receipt_id'],'actual':40.,'hit':False,'recorded_utc':'2026-10-02T04:00:00Z','fixture_not_authoritative':True}
oldB=M.encoded([sourceB,revisionB,rB,dB]);ctxC=context('2026-10-04T13:00:00Z','2026-10-05T00:00:00Z',6)
currentB=M.current_pin(BASE,dB['coefficients'],artifact=dB['artifact_id'],materialization=dB['materialization_id']);rollback=(a[0],a[1],ctxC,currentB,a[4])
authC=FakeAuthority(ctxC,history=authB.value['events'],now='2026-10-04T12:00:00Z',action='rollback')
result=run(rollback,authC,prior_materializations=[dA,dB],issued_receipts=[sourceA,sourceB],now_utc=authC.now);dC=result['draft'];sourceC=source_receipt(dC,ctxC,game='synthetic-rollback')
print(json.dumps({'result':result,'oldA_same':oldA==M.encoded([sourceA,revisionA,a[1],dA]),'oldB_same':oldB==M.encoded([sourceB,revisionB,rB,dB]),
 'same_A_coeffs':dC['coefficients']==dA['coefficients'],'different_B':dB['coefficients']!=dA['coefficients'],
 'once':all(s['served_prob']==R.serve_probability(s['base_prob'],d['coefficients'])for s,d in((sourceA,dA),(sourceB,dB),(sourceC,dC))),
 'not_twice':sourceA['served_prob']!=R.serve_probability(sourceA['served_prob'],dA['coefficients']),
 'original_receipts_valid':all(R.receipt_problem(s,{**s,'model_prob':s['served_prob']},2026,s['week'])is None for s in(sourceA,sourceB,sourceC)),
 'versions':[s['calibrator_version']for s in(sourceA,sourceB,sourceC)]}))
`);
 assert.equal(r.result.status,'materialized_draft');assert.equal(r.result.draft.rollback_from_artifact_id!==null,true);
 assert.equal(r.oldA_same,true);assert.equal(r.oldB_same,true);assert.equal(r.same_A_coeffs,true);assert.equal(r.different_B,true);
 assert.equal(r.once,true);assert.equal(r.not_twice,true);assert.equal(r.original_receipts_valid,true);assert.equal(r.versions[0],r.versions[2]);assert.notEqual(r.versions[0],r.versions[1]);
 assert.equal(r.result.model_adoption,false);
});

test('full candidate schema, immutable-base stage, numeric types and original retrospective evidence cannot be forged',()=>{
 const r=py(String.raw`
changes=[lambda c:c.update(version=True),lambda c:c.update(kind='generic.platt.v1'),lambda c:c.update(state='active'),
 lambda c:c.update(evidence_status='prospective'),lambda c:c.update(created_utc=NOW),lambda c:c.update(automatic_promotion=True),
 lambda c:c['transform'].update(input_stage='served_prob'),lambda c:c['transform'].update(output_decimals=True),
 lambda c:c['coefficients'].update(b=0),lambda c:c['coefficients'].update(a=True),lambda c:c['coefficients'].update(a=.1234567),
 lambda c:c['training'].update(n=True),lambda c:c['training'].update(ridge=0),lambda c:c['training'].update(fit_rule='legacy_fit'),
 lambda c:c['training']['rows'][0].update(hit=1),lambda c:c['training']['rows'][0].update(base_prob=1),
 lambda c:c['training']['rows'][0].update(position='TE'),lambda c:c['training']['rows'][0].update(resolved_utc='2099-01-01T00:00:00Z'),
 lambda c:c['training']['rows'][0].update(contract_id='not-a-hash'),lambda c:c['training']['rows'][0].update(market_probability=.9),
 lambda c:c['training']['rows'].__setitem__(0,copy.deepcopy(c['training']['rows'][1]))]
results=[]
for change in changes:
 values=list(setup());change(values[0])
 values[0]['training']['dataset_id']=HASH(values[0]['training']['rows']);reseal(values[0],'candidate_id');values[1]=report(values[0]);values[4]=policy(values[1])
 authority=FakeAuthority(values[2]);result=run(values,authority);results.append({'status':result['status'],'calls':len(authority.calls)})
print(json.dumps(results))
`);
 assert.ok(r.length>=20);assert.ok(r.every(x=>x.status==='held'&&x.calls===0));
});

test('evaluation policy, subgroup, interval and declared gates hold independently of an approval-shaped callback',()=>{
 const r=py(String.raw`
changes=[lambda r:r.update(report_id=HASH('wrong')),lambda r:r.update(kind='generic.report'),lambda r:r.update(automatic_promotion=True),
 lambda r:r.update(public_serving_verified=True),lambda r:r.update(evaluation_kind='fixed_prospective_artifact'),
 lambda r:r['shared_shadow_numeric_gate'].update(passed=False),lambda r:r['proposed_shared_return_gate'].update(failures=['held']),
 lambda r:r['proposed_shared_return_gate'].update(additional_margin=.0001),lambda r:r['metrics'].update(candidate_log_loss=.8),
 lambda r:r['metrics'].update(delta_log_loss=-.001),lambda r:r['per_position']['WR'].update(delta_log_loss=.01),
 lambda r:r['per_position']['RB'].update(n=0),lambda r:r['paired_game_interval'].update(high=0),
 lambda r:r['folds'].pop(),lambda r:r['folds'][0].update(status='held'),lambda r:r['folds'][0].update(candidate_log_loss=.8)]
results=[]
for change in changes:
 values=list(setup());change(values[1]);
 if values[1]['report_id']!=HASH('wrong'):reseal(values[1],'report_id')
 values[4]=policy(values[1]);authority=FakeAuthority(values[2]);result=run(values,authority)
 results.append({'status':result['status'],'calls':len(authority.calls)})
print(json.dumps(results))
`);assert.ok(r.every(x=>x.status==='held'&&x.calls===0));
});

test('absolute log losses are nonnegative in every claimed scope while legitimate negative deltas and zero loss remain valid',()=>{
 const r=py(String.raw`
results=[]
for scope in('metrics','fold','position'):
 for key in('incumbent_log_loss','candidate_log_loss','base_log_loss'):
  values=list(setup())
  if scope=='metrics':target=values[1]['metrics']
  elif scope=='fold':target=values[1]['folds'][0]
  else:target=values[1]['per_position']['WR']
  target[key]=-.1
  if scope=='metrics':target['delta_log_loss']=target['candidate_log_loss']-target['incumbent_log_loss']
  reseal(values[1],'report_id');values[4]=policy(values[1]);authority=FakeAuthority(values[2]);result=run(values,authority)
  results.append({'status':result['status'],'calls':len(authority.calls)})
values=list(setup());values[1]['metrics'].update(candidate_log_loss=0.,delta_log_loss=-.7)
for row in values[1]['per_position'].values():row.update(candidate_log_loss=0.,incumbent_log_loss=.7,base_log_loss=.75)
for fold in values[1]['folds']:fold['candidate_log_loss']=0.
reseal(values[1],'report_id');values[4]=policy(values[1]);positive=run(values,FakeAuthority(values[2]))
print(json.dumps({'negative':results,'zero':positive['status'],'active':positive['model_adoption']}))
`);
 assert.equal(r.negative.length,9);assert.ok(r.negative.every(x=>x.status==='held'&&x.calls===0));
 assert.equal(r.zero,'materialized_draft');assert.equal(r.active,false);
});

test('complete owner-intent sequences permit equal recorded clocks but cannot regress them',()=>{
 const r=py(String.raw`
rows=[]
for mode in('equal','regressed'):
 values=setup()
 def mutate(s):
  first=s['events'][0];second=copy.deepcopy(first);second.update(sequence=2,previous_event_id=first['event_id'])
  if mode=='regressed':second['recorded_utc']=timeplus(first['recorded_utc'],-1)
  reseal(second,'event_id');s.update(events=[first,second],head_sequence=2,head_event_id=second['event_id']);reseal(s,'snapshot_id')
 result=run(values,FakeAuthority(values[2],mutate=mutate));rows.append({'status':result['status'],'active':result['model_adoption']})
print(json.dumps(rows))
`);
 assert.deepEqual(r.map(x=>x.status),['materialized_draft','held']);assert.ok(r.every(x=>x.active===false));
});

test('stale, incompatible, previously issued and code/context pins fail before asking any authority',()=>{
 const r=py(String.raw`
results=[]
for mode in('old_candidate','wrong_base','wrong_code','wrong_policy','past_generation','bad_current','issued','invalid_receipt','unknown_current'):
 values=list(setup());kwargs={};now=NOW
 if mode=='old_candidate':values[4]['max_candidate_age_seconds']=1;reseal(values[4],'policy_id')
 if mode=='wrong_base':values[2]['base_model_version']=HASH('other');reseal(values[2],'context_id')
 if mode=='wrong_code':values[2]['nfl_code_id']=HASH('other');reseal(values[2],'context_id')
 if mode=='wrong_policy':values[4]['evaluation_policy_id']=HASH('other');reseal(values[4],'policy_id')
 if mode=='past_generation':now='2026-09-26T14:00:00Z'
 if mode=='bad_current':values[3]['calibrator_version']=HASH('wrong')
 if mode=='issued':kwargs['issued_receipts']=[source_receipt(None,values[2])]
 if mode=='invalid_receipt':kwargs['issued_receipts']=[{}]
 if mode=='unknown_current':values[3]=M.current_pin(BASE,{'a':.2,'b':.9},artifact=HASH('a'),materialization=HASH('m'))
 authority=FakeAuthority(values[2]);result=run(values,authority,now_utc=now,**kwargs);results.append({'status':result['status'],'calls':len(authority.calls)})
print(json.dumps(results))
`);assert.ok(r.every(x=>x.status==='held'&&x.calls===0));
});

test('incomplete, stale, revoked, wrong-parent and ineffective owner-head claims never become active authorization',()=>{
 const r=py(String.raw`
changes=[lambda s:s.update(complete=False),lambda s:s.update(head_sequence=2),lambda s:s.update(head_event_id=HASH('wrong')),
 lambda s:s.update(observed_utc=timeplus(NOW,-601)),lambda s:s.update(observed_utc=timeplus(NOW,1)),lambda s:s.update(expires_utc=timeplus(NOW,-1)),
 lambda s:s['events'][0].update(previous_event_id=HASH('missing')),lambda s:s['events'][0].update(sequence=True),
 lambda s:s['events'][0].update(action='revoke'),lambda s:s['events'][0].update(action='rollback'),
 lambda s:s['events'][0].update(generation_context_id=HASH('wrong')),lambda s:s['events'][0].update(expected_previous_current_id=HASH('wrong')),
 lambda s:s['events'][0].update(evidence_status_acknowledged='prospective'),lambda s:s['events'][0].update(effective_from_utc='2026-09-26T14:00:00Z'),
 lambda s:s['events'][0].update(expires_utc='2026-09-26T12:30:00Z'),lambda s:s.update(extra_verified=True),
 lambda s:s['events'][0].update(recorded_utc='2026-09-01T00:00:00Z')]
results=[]
for change in changes:
 values=setup()
 def altered(s):
  change(s)
  for e in s['events']:reseal(e,'event_id')
  if s.get('head_event_id')!=HASH('wrong'):s['head_event_id']=s['events'][-1]['event_id']
  reseal(s,'snapshot_id')
 result=run(values,FakeAuthority(values[2],mutate=altered));results.append(result)
print(json.dumps(results))
`);assert.ok(r.every(x=>x.status==='held'&&x.draft===null&&x.owner_authorization_verified===false));
});

test('later revocation, omitted known approval prefix and malformed report metadata cannot be hidden by resealing',()=>{
 const r=py(String.raw`
values=setup();authority=FakeAuthority(values[2]);draft=run(values,authority)['draft'];history=authority.value['events'];current=M.current_pin(BASE,draft['coefficients'],artifact=draft['artifact_id'],materialization=draft['materialization_id'])
later=list(values);later[3]=current;known=[draft]
revoked=run(later,FakeAuthority(values[2],history=history,action='revoke'),prior_materializations=known)
missing=run(later,FakeAuthority(values[2]),prior_materializations=known)
bad=list(setup());bad[1]['metrics']={'PRIVATE':None};reseal(bad[1],'report_id');out=run(bad,FakeAuthority(bad[2]))
print(json.dumps({'revoked':revoked,'missing':missing,'bad':out}))
`);
 assert.deepEqual(r.revoked.reason_codes,['artifact_revoked']);assert.deepEqual(r.missing.reason_codes,['incomplete_owner_head']);
 assert.equal(r.bad.status,'held');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});

test('offered population lineage is explicit; tampered previous materializations and unknown rollback are held',()=>{
 const r=py(String.raw`
c=candidate(population='offered_my');r=report(c);ctx=context();values=(c,r,ctx,M.current_pin(BASE),policy(r));good=run(values,FakeAuthority(ctx))
bad=copy.deepcopy(c);bad['training']['rows'][0]['offering']['recorded_utc']='2099-01-01T00:00:00Z';bad['training']['dataset_id']=HASH(bad['training']['rows']);reseal(bad,'candidate_id');br=report(bad)
held=run((bad,br,ctx,M.current_pin(BASE),policy(br)),FakeAuthority(ctx))
a=setup();auth=FakeAuthority(a[2]);draft=run(a,auth)['draft'];old=copy.deepcopy(draft);old['coefficients']['a']=.4
badprior=run(a,FakeAuthority(a[2]),prior_materializations=[old]);rollback=run(a,FakeAuthority(a[2],action='rollback'))
claim=M.current_pin(BASE,{'a':.2,'b':.9});claim['adjustment']['a']=.7
print(json.dumps({'good':good['status'],'held':held['status'],'badprior':badprior['status'],'rollback':rollback['status'],
 'draft_unchanged':draft['coefficients']['a']==.2,'current_detached':a[3]['adjustment']is None}))
`);assert.equal(r.good,'materialized_draft');assert.equal(r.held,'held');assert.equal(r.badprior,'held');assert.equal(r.rollback,'held');assert.equal(r.draft_unchanged,true);assert.equal(r.current_detached,true);
});

test('bounded plain-JSON work, callback exception redaction and cancellation are explicit',()=>{
 const r=py(String.raw`
results=[]
for constant,value in(('MAX_BYTES',1),('MAX_ROWS',100),('MAX_EVENTS',0),('MAX_PRIOR',0)):
 values=setup();authority=FakeAuthority(values[2]);kwargs={'prior_materializations':[{}]}if constant=='MAX_PRIOR'else{}
 with mock.patch.object(M,constant,value):results.append(run(values,authority,**kwargs)['status'])
for bad in(float('nan'),object(),{1:'non-string-key'}):
 values=list(setup());values[2]['untrusted']=bad;results.append(run(values,FakeAuthority(values[2]))['status'])
for error in(KeyboardInterrupt(),SystemExit()):
 def cancelled(query):raise error
 try:run(setup(),cancelled);results.append('swallowed')
 except(KeyboardInterrupt,SystemExit):results.append('cancelled')
current={'a':.2,'b':.9};claim=M.current_pin(BASE,current);claim['adjustment']['a']=.7
print(json.dumps({'results':results,'detached':current['a']==.2}))
`);assert.deepEqual(r.results,['held','held','held','held','held','held','held','cancelled','cancelled']);assert.equal(r.detached,true);
});

after(()=>{
 assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),sourceHash);
 protectedNames.forEach((name,i)=>assert.equal(createHash('sha256').update(readFileSync(ROOT+name)).digest('hex'),protectedHashes[i]));
 const executable=JSON.parse(execFileSync('python3',['-c',`import json,trace;print(json.dumps(sorted(x for x in trace._find_executable_linenos(${JSON.stringify(SOURCE)})if x>0)))`],{encoding:'utf8'}));
 const all=new Set([...executable,...covered]);console.log(JSON.stringify({source:'scripts/materialize_calibrator.py',sha256:sourceHash,covered:covered.size,total:all.size,
  percent:100*covered.size/all.size,missing:[...all].filter(x=>!covered.has(x)).sort((a,b)=>a-b),scope:'synthetic-authority-claims-only-no-owner-authentication-or-model-adoption'}));
});
