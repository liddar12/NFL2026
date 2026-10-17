import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../scripts/replay_r126.py', import.meta.url));
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import ast,copy,contextlib,io,itertools,json,math,os,pathlib,runpy,subprocess,sys,tempfile
from unittest import mock
from scripts import replay_r126 as r, export_learning as ex
def error(fn):
 try:fn()
 except r.ReplayError as exc:return str(exc)
 return None
def seal(payload):
 for leg in payload['candidates']:leg['candidate_id']=ex.fingerprint({k:v for k,v in leg.items() if k!='candidate_id'})
 payload['manifest_id']=ex.fingerprint({k:v for k,v in payload.items() if k!='manifest_id'})
 return payload
def fixture():
 legs=[]
 for market,selection,p,side in [('moneyline','HOME ML',.8,'home'),('spread','HOME -7.5',.5,'home'),
    ('qb_pass_yds','QB 225+',.25,'home'),('wr_rec_yds','WR 60+',.25,'home'),('rb_rush_yds','AWAY RB60+',.7,'away')]:
  legs.append({'market':market,'selection':selection,'model_prob':p,'implied_prob':p,'_side':side,'_corr_tag':market})
 payload=seal({'version':1,'season':2026,'week':2,'game_id':'synthetic-game','captured_utc':'2026-09-01T12:00:00Z',
  'kickoff_utc':'2026-09-02T00:15:00Z','population':'complete_builder_candidates','candidates':legs,
  'correlations':{'pairs':[{'key':'qb_pass_yds|wr_rec_yds','rho':.6},{'key':'moneyline|rb_rush_yds','rho':.3},
    {'key':'moneyline|wr_rec_yds','rho':.02}], 'default_rho':0},'correlation_available_utc':'2026-09-01T11:00:00Z',
  'code_version':r.runtime_versions()['ranking_runtime_sha256'],'policy_version':r.runtime_versions()['r126_builder_sha256']})
 outcomes=[{'week':2,'game_id':payload['game_id'],'candidate_id':leg['candidate_id'],'status':'FINAL',
  'hit':leg['market'] in ('moneyline','rb_rush_yds'),'available_utc':'2026-09-02T04:00:00Z','source_id':ex.fingerprint('synthetic-final')} for leg in legs]
 return {'version':1,'kind':'nfl.r126_replay_bundle.v1','captures':[{'payload':payload,'provenance':{'profile':'synthetic_fixture_v1'}}],'outcomes':outcomes}
def independent(payload):
 # Independent arithmetic/filter/sort oracle; no builder helpers are used.
 def values(a,b):
  key=frozenset((a['market'],b['market']));rules={frozenset(p['key'].split('|')):p['rho'] for p in payload['correlations']['pairs']}
  rho=rules.get(key,payload['correlations']['default_rho'])
  if a['_side']!=b['_side']:rho=-abs(rho)
  p,q=a['model_prob'],b['model_prob'];joint=max(0,p+q-1,min(p,q,p*q+rho*math.sqrt(p*(1-p)*q*(1-q))))
  return rho,joint,joint/(a['implied_prob']*b['implied_prob'])-1
 def pairs(pool,mode):
  out=[]
  for i,j in itertools.combinations(range(len(pool)),2):
   a,b=pool[i],pool[j]
   if a['market'] in ('moneyline','spread') and b['market'] in ('moneyline','spread') and a['_side']==b['_side']:continue
   rho,joint,ev=values(a,b);out.append(((-joint if mode=='joint' else -abs(rho)),-ev,i,j,[a,b]))
  return sorted(out,key=lambda x:x[:4])
 legs=payload['candidates'];nonspread=[x for x in legs if x['market']!='spread'];ranked=pairs(nonspread,'joint');pool=nonspread
 if len(ranked)<3 and len(nonspread)<len(legs):pool=legs;ranked=pairs(pool,'joint')
 def finish(rows,pool):
  raw=[x[-1] for x in rows[:3]];index=len(raw)
  while len(raw)<3 and pool:raw.append([pool[index%len(pool)]]);index+=1
  out=[];seen=set()
  for card in raw:
   contracts=[]
   for leg in card:
    player=leg.get('gsis_id');owner='player:'+str(player) if player else ' '.join(leg['selection'].split())
    line=leg.get('line');line=format(float(line),'.12g') if isinstance(line,(int,float)) else None
    contracts.append((str(payload['game_id']),leg['market'],owner,line,leg['_side'],'over' if player else None,'gte' if player else None))
   key=tuple(sorted(contracts,key=lambda x:json.dumps(x)))
   if key not in seen:seen.add(key);out.append([x['candidate_id'] for x in card])
  return out
 return {'r126':finish(ranked,pool),'r74_control':finish(pairs(legs,'rho'),legs)}
def ids(selected):return {name:[[leg['candidate_id'] for leg in card] for card in cards] for name,cards in selected.items()}
`;

function py(body) {
  const wrapper = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/replay_r126.py').resolve());LINES=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return traced\nsys.settrace(traced)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8', input: wrapper,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 32 * 1024 * 1024,
  }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('actual current archives/ledger/game snapshots are audited honestly, not promoted into full candidate history', () => {
  const out = py(`
before={str(p):r._raw_hash(p.read_bytes()) for p in pathlib.Path('data/parlays').glob('2026_wk0[2-5].json')}
with mock.patch.object(r,'_git',side_effect=AssertionError('default audit cannot query Git or fetch')):report=r.audit_sources('data')
print(json.dumps({'report':report,'unchanged':before=={str(p):r._raw_hash(p.read_bytes()) for p in pathlib.Path('data/parlays').glob('2026_wk0[2-5].json')}}))
`);
  assert.deepEqual(out.report.weeks.map(w => w.week), [2, 3, 4, 5]);
  assert.ok(out.report.weeks.every(w => w.historical_metrics === null && !w.historical_acceptance_eligible));
  assert.ok(out.report.weeks.every(w => w.source_evidence[0].sha256?.startsWith('sha256:')));
  assert.equal(out.report.prior_rca_claim.status, 'historical_claim_not_reverified'); assert.equal(out.unchanged, true);
});

test('frozen R126 and R74 selections match an independent probability oracle and preserve runtime/source identities', () => {
  const out = py(`
b=fixture();p=b['captures'][0]['payload'];selected=r.select_candidates(p);result=r.replay(b)
print(json.dumps({'selected':ids(selected),'oracle':independent(p),'result':result,'unchanged':b==fixture()}))
`);
  assert.deepEqual(out.selected, out.oracle); assert.notDeepEqual(out.selected.r126, out.selected.r74_control);
  assert.equal(out.unchanged, true); assert.equal(out.result.experiments.length, 1);
  assert.equal(out.result.experiments[0].provenance.input_class, 'synthetic_fixture');
  assert.equal(out.result.historical_acceptance_eligible, false);
  assert.match(out.result.metric_basis.settlement, /reduced wins included.*all-VOID/);
  assert.match(out.result.metric_basis.authority, /not a verified as-offered/);
  assert.equal(out.result.runtime.r74_reference_commit, 'bb6ae6ed94389f8435038ced244afae27bb7754f');
  assert.match(out.result.experiments[0].cohort_id, /^sha256:[a-f0-9]{64}$/);
});

test('actual protected R126 builder and distinct guard agree for normal, fallback and one/two-card thin universes', () => {
  const out = py(`
results=[]
for indices in ([0,1,2,3,4],[0,1,2],[0,1],[0]):
 b=fixture();p=b['captures'][0]['payload'];p['candidates']=[p['candidates'][i] for i in indices];seal(p)
 selected=r.select_candidates(p)
 with mock.patch.object(r.pb,'derive_candidate_legs',return_value=p['candidates']),mock.patch.object(r.pb,'load_calibration',return_value={'correlations':p['correlations']}):
  actual=r.pb._distinct_cards(r.pb.build_game_parlays({'game_id':p['game_id']}))
 actual_sels=[[x['selection'] for x in c['legs']] for c in actual]
 sels=[[x['selection'] for x in c] for c in selected['r126']]
 result=r.replay(b)['experiments'][0]
 results.append({'same':sels==actual_sels,'oracle':ids(selected)==independent(p),'coverage':result['candidate_coverage'],
  'graded':[v['settlement_graded_cards'] for v in result['policies'].values()]})
print(json.dumps(results))
`);
  assert.ok(out.every(r => r.same && r.oracle));
  assert.deepEqual(out.map(r => r.coverage.r126.distinct_cards), [3, 3, 2, 1]);
  assert.deepEqual(out.map(r => r.coverage.r126.shortfall), [0, 0, 1, 2]);
  assert.deepEqual(out.map(r => r.graded), [[3, 3], [3, 3], [2, 2], [1, 1]]);
});

test('shipped actual-contract identities govern aliases, GSIS, line and side rather than candidate metadata', () => {
  const out = py(`
results=[]
for kind in ('whitespace_alias','annotation_alias','different_line','different_player','different_side'):
 b=fixture();p=b['captures'][0]['payload'];a=copy.deepcopy(p['candidates'][0]);c=copy.deepcopy(a)
 if kind=='whitespace_alias':c['selection']='HOME  ML'
 if kind=='annotation_alias':c['price_source']='assumed'
 if kind in ('different_line','different_player','different_side'):
  a.update(market='rb_rush_yds',_corr_tag='rb_rush_yds',selection='SAME LABEL',gsis_id='00-0000001',line=40)
  c=copy.deepcopy(a)
  if kind=='different_line':c['line']=50
  if kind=='different_player':c['gsis_id']='00-0000002'
  if kind=='different_side':c['_side']='away'
 p['candidates']=[a,c,copy.deepcopy(p['candidates'][-1])];seal(p)
 b['outcomes']=[{'week':2,'game_id':p['game_id'],'candidate_id':leg['candidate_id'],'status':'FINAL','hit':True,
  'available_utc':'2026-09-02T04:00:00Z','source_id':ex.fingerprint('synthetic-final')} for leg in p['candidates']]
 selected=r.select_candidates(p)
 with mock.patch.object(r.pb,'derive_candidate_legs',return_value=p['candidates']),mock.patch.object(r.pb,'load_calibration',return_value={'correlations':p['correlations']}):
  actual=r.pb._distinct_cards(r.pb.build_game_parlays({'game_id':p['game_id']}))
 actual_keys=[r.pb.parlay_bet_key(card) for card in actual]
 selected_keys=[r.pb.parlay_bet_key(r.pb._make_parlay('fixture','game',card,game_id=p['game_id'])) for card in selected['r126']]
 results.append({'kind':kind,'error':error(lambda:r.replay(b)),'same':actual_keys==selected_keys,
  'oracle':independent(p)==ids(selected),'actual_count':len(actual)})
print(json.dumps(results))
`);
  assert.ok(out.every(r => r.same && r.oracle));
  assert.ok(out.slice(0, 2).every(r => r.error === 'duplicate_frozen_candidate' && r.actual_count === 2));
  assert.ok(out.slice(2).every(r => r.error === null && r.actual_count === 3));
});

test('outcomes never influence reselection; VOID/reduced wins and unresolved exclusions remain distinct', () => {
  const out = py(`
b=fixture();original=ids(r.select_candidates(b['captures'][0]['payload']));changed=copy.deepcopy(b)
for row in changed['outcomes']:row['hit']=not row['hit']
flipped=r.replay(changed)
void=copy.deepcopy(b)
for row in void['outcomes']:row.update(status='VOID',hit=None)
all_void=r.replay(void)['experiments'][0]['policies']
reduced=copy.deepcopy(b)
for row in reduced['outcomes']:
 row['hit']=True
 if row['candidate_id']==b['captures'][0]['payload']['candidates'][0]['candidate_id']:row.update(status='VOID',hit=None)
graded=r.replay(reduced)['experiments'][0]['policies']
pending=copy.deepcopy(b)
for row in pending['outcomes']:row.update(status='UNRESOLVED',hit=None)
excluded=r.replay(pending)
early=copy.deepcopy(b);early['outcomes'][0]['available_utc']='2026-09-01T13:00:00Z'
print(json.dumps({'same_selection':original=={name:[c['candidate_ids'] for c in rows['cards']] for name,rows in flipped['experiments'][0]['policies'].items()},
 'all_void':all_void,'reduced':graded,'excluded':excluded,'early':r.replay(early)['exclusions']}))
`);
  assert.equal(out.same_selection, true);
  assert.ok(Object.values(out.all_void).every(r => r.settlement_graded_cards === 0 && r.all_void === 3 && r.settlement_wins === 0 && r.distinct_selected_cards === 3));
  assert.ok(Object.values(out.reduced).every(r => r.settlement_wins === 3 && r.reduced_win > 0 && r.full_contract_hits < r.settlement_wins));
  assert.equal(out.excluded.experiments.length, 0); assert.equal(out.excluded.exclusions[0].reason, 'selected_outcome_unresolved');
  assert.equal(out.early[0].reason, 'outcome_before_event');
});

test('malformed, late, duplicate, unsupported and nonfinite candidate/correlation/bundle inputs fail closed', () => {
  const out = py(`
results={}
for kind in ('version','profile','population','late','corr_late','candidate_hash','prob_bool','prob_nan','side','line_bool','gsis_bool','duplicate_leg','no_corr','rho','corrkey','dup_corr','outcome_bool','dup_outcome','duplicate_game','wrong_hash','mixed_season'):
 b=fixture();p=b['captures'][0]['payload']
 if kind=='version':b['version']=True
 if kind=='profile':b['captures'][0]['provenance']={'profile':'verified','verified':True}
 if kind=='population':p['population']='archive_union'
 if kind=='late':p['captured_utc']=p['kickoff_utc']
 if kind=='corr_late':p['correlation_available_utc']='2026-09-01T13:00:00Z'
 if kind=='candidate_hash':p['candidates'][0]['candidate_id']='changed'
 if kind=='prob_bool':p['candidates'][0]['model_prob']=True
 if kind=='prob_nan':p['candidates'][0]['model_prob']=float('nan')
 if kind=='side':p['candidates'][0]['side']='away'
 if kind=='line_bool':p['candidates'][0]['line']=True
 if kind=='gsis_bool':p['candidates'][0]['gsis_id']=True
 if kind=='duplicate_leg':p['candidates'].append(copy.deepcopy(p['candidates'][0]))
 if kind=='no_corr':p['correlations']['pairs']=[]
 if kind=='rho':p['correlations']['pairs'][0]['rho']=True
 if kind=='corrkey':p['correlations']['pairs'][0]['key']='wrong|pair|unsupported'
 if kind=='dup_corr':p['correlations']['pairs'].append(copy.deepcopy(p['correlations']['pairs'][0]))
 if kind=='outcome_bool':b['outcomes'][0]['hit']=1
 if kind=='dup_outcome':b['outcomes'].append(copy.deepcopy(b['outcomes'][0]))
 if kind=='duplicate_game':b['captures'].append(copy.deepcopy(b['captures'][0]))
 if kind=='mixed_season':
  other=copy.deepcopy(b['captures'][0]);other['payload']['season']=2027;seal(other['payload']);b['captures'].append(other)
 if kind not in ('candidate_hash','prob_nan','wrong_hash'):p['manifest_id']=ex.fingerprint({k:v for k,v in p.items() if k!='manifest_id'})
 if kind=='wrong_hash':p['manifest_id']='changed'
 results[kind]=error(lambda:r.replay(b))
print(json.dumps(results))
`);
  assert.ok(Object.values(out).every(Boolean));
});

test('local Git verifies actual immutable payload/code/policy bytes but mutable clocks never qualify historical acceptance', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);subprocess.run(['git','init','-q',str(root)],check=True)
 b=fixture();p=b['captures'][0]['payload'];target=root/'capture.json';target.write_bytes(ex.encoded(p))
 code=root/'scripts/models/parlay_builder.py';code.parent.mkdir(parents=True);code.write_bytes(pathlib.Path(r.pb.__file__).read_bytes())
 env={**os.environ,'GIT_AUTHOR_DATE':'2026-09-01T12:01:00Z','GIT_COMMITTER_DATE':'2026-09-01T12:01:00Z'}
 subprocess.run(['git','-C',str(root),'add','.'],check=True)
 subprocess.run(['git','-C',str(root),'-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-qm','synthetic'],env=env,check=True)
 commit=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
 b['captures'][0]['provenance']={'profile':'local_git_complete_candidates_v1','commit':commit,'path':'capture.json'}
 result=r.replay(b,repo_dir=root)
 malformed=copy.deepcopy(b);malformed['captures'][0]['provenance']['path']='../private'
 mismatch=copy.deepcopy(b);mismatch['captures'][0]['payload']['policy_version']=ex.fingerprint('wrong');seal(mismatch['captures'][0]['payload'])
 errors=[error(lambda:r.replay(malformed,repo_dir=root)),error(lambda:r.replay(mismatch,repo_dir=root)),error(lambda:r.replay(b,repo_dir=root/'missing'))]
 print(json.dumps({'result':result,'errors':errors}))
`);
  const experiment = out.result.experiments[0];
  assert.equal(experiment.provenance.input_class, 'local_git_content_replay');
  assert.equal(experiment.historical_acceptance_eligible, false);
  assert.match(experiment.provenance.capture_clock_basis, /mutable.*not independent/);
  assert.ok(out.errors.every(Boolean));
});

test('CLI and immutable explicit reports are deterministic; default never writes and output symlinks/data paths are refused', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);bundle=root/'bundle.json';bundle.write_bytes(ex.encoded(fixture()));report=root/'reports/report.json'
 def cli(args):
  output=io.StringIO();errors=io.StringIO()
  with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):code=r.main(args)
  return code,json.loads(output.getvalue() or errors.getvalue())
 default=cli([]);first=cli(['--bundle',str(bundle),'--out',str(report)]);before=report.read_bytes()
 second=cli(['--bundle',str(bundle),'--out',str(report)])
 modified=copy.deepcopy(first[1]);modified['x']=True;modified['report_id']=ex.fingerprint({k:v for k,v in modified.items() if k!='report_id'})
 actual=root/'actual';actual.mkdir();link=root/'link';link.symlink_to(actual,target_is_directory=True)
 errors=[error(lambda:r.persist(modified,report)),error(lambda:r.persist(first[1],link/'report.json')),
  error(lambda:r.persist(first[1],pathlib.Path('data/forbidden-r126-report.json'))),error(lambda:r.persist({},root/'bad.json'))]
 bad=cli(['--bundle',str(root/'missing.json')]);output=io.StringIO()
 authority=root/'authority';authority.mkdir();inside=cli(['--data-dir',str(authority),'--out',str(authority/'audit.json')])
 with contextlib.redirect_stdout(output),mock.patch.object(sys,'argv',['replay_r126.py']):
  try:runpy.run_path('scripts/replay_r126.py',run_name='__main__')
  except SystemExit as exc:entrypoint=exc.code
 print(json.dumps({'default':default,'same':first==second,'immutable':before==report.read_bytes(),
  'errors':errors,'bad':bad,'entrypoint':entrypoint,'report_present':report.exists(),'escaped_empty':not list(actual.iterdir()),
  'custom_authority':inside,'custom_authority_unchanged':not list(authority.iterdir())}))
`);
  assert.equal(out.default[0], 0); assert.ok(out.default[1].weeks.every(w => w.historical_metrics === null));
  assert.equal(out.same, true); assert.equal(out.immutable, true); assert.equal(out.report_present, true);
  assert.equal(out.escaped_empty, true); assert.ok(out.errors.every(Boolean)); assert.equal(out.bad[0], 2); assert.equal(out.entrypoint, 0);
  assert.equal(out.custom_authority[0], 2); assert.equal(out.custom_authority_unchanged, true);
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), sourceHash);
  const executable = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1]) if n>0)))', SOURCE], { encoding: 'utf8' }));
  const denominator = new Set([...executable, ...covered]);
  const percent = 100 * covered.size / denominator.size;
  console.log(`R126 replay measured source sha256: ${sourceHash}`);
  console.log(`R126 replay executable-line coverage: ${covered.size}/${denominator.size} (${percent.toFixed(4)}%)`);
  assert.ok(percent >= 90, `Replay coverage below90; missing: ${[...denominator].filter(n => !covered.has(n)).join(',')}`);
});
