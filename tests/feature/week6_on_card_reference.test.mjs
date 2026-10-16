import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../scripts/replay_on_card_reference.py', import.meta.url));
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import copy,contextlib,io,json,os,pathlib,runpy,subprocess,sys,tempfile
from unittest import mock
from scripts import replay_on_card_reference as r, export_learning as ex
def error(fn):
 try:fn()
 except r.Error as exc:return str(exc)
 return None
def git(root,*args,stamp='2026-09-24T12:00:00Z'):
 env={**os.environ,'GIT_AUTHOR_DATE':stamp,'GIT_COMMITTER_DATE':stamp}
 return subprocess.check_output(['git','-C',str(root),'-c','user.name=fixture','-c','user.email=fixture@invalid',*args],env=env,stderr=subprocess.DEVNULL).decode().strip()
def fixture(root,mode='hit',missing_cal=False,clock_tie=False):
 root.mkdir();git(root,'init','-q');data=root/'data';data.mkdir();code=root/'scripts/models/parlay_builder.py';code.parent.mkdir(parents=True)
 code.write_text('raise AssertionError("historical code must never execute")\\n')
 games=[];review={'season':2026,'weeks':{}};scores={'season':2026,'resolved':[],'unresolved':[]}
 for week,day in ((2,1),(3,8),(4,15),(5,22)):
  gid='g'+str(week);stamp=f'2026-09-{day:02d}T12:00:00Z';kick=f'2026-09-{day+1:02d}T00:15:00Z'
  legs=[]
  for market,selection,p,side in [('moneyline','SEA ML',.8,'home'),('qb_pass_yds','Q. One 225+ pass yds',.25,'home'),('wr_rec_yds','W. One 60+ rec yds',.25,'home'),('rb_rush_yds','R. One 60+ rush yds',.7,'away')]:
   leg={'market':market,'selection':selection,'model_prob':p,'implied_prob':p,'side':side}
   if market!='moneyline':leg['line']=224.5 if market=='qb_pass_yds' else 59.5
   legs.append(leg)
  cards=[{'scope':'game','game_id':gid,'parlay_id':gid+'-'+str(i),'legs':[legs[a],legs[b]]} for i,(a,b) in enumerate(((1,2),(0,3),(0,2)))]
  doc={'season':2026,'week':week,'updated_utc':stamp,'parlays':cards}
  cal={'generated_utc':stamp,'correlations':{'default_rho':0,'pairs':[{'key':'qb_pass_yds|wr_rec_yds','rho':.6},{'key':'moneyline|rb_rush_yds','rho':.3},{'key':'moneyline|wr_rec_yds','rho':.02}]}}
  (data/'parlays.json').write_bytes(ex.encoded(doc))
  if not missing_cal or week!=2:(data/'parlay_backtest.json').write_bytes(ex.encoded(cal))
  git(root,'add','.');git(root,'commit','-qm','synthetic snapshot',stamp=stamp)
  if clock_tie and week==2:
   doc['parlays'][0]['parlay_id']='tied-distinct';(data/'parlays.json').write_bytes(ex.encoded(doc));git(root,'add','.');git(root,'commit','-qm','ambiguous same clock',stamp=stamp)
  game={'game_id':gid,'week':week,'home':'SEA','away':'LAR','kickoff_utc':kick};games.append(game)
  rvlegs=[]
  for leg in legs:
   hit=mode!='loss' or leg['market'] in ('qb_pass_yds','wr_rec_yds')
   ref={'week':week,'game_id':gid,'market':leg['market'],'selection':leg['selection']}
   if leg['market']!='moneyline':
    if mode in ('void','pending') and leg['market']=='wr_rec_yds':scores['unresolved'].append({**ref,'reason':'no_stat_line' if mode=='void' else 'missing_stat_value'})
    elif mode!='fallback' or leg['market']!='qb_pass_yds':scores['resolved'].append({**ref,'hit':hit,'actual':300 if hit else 0,'line':leg['line']})
   rvlegs.append({**leg,'game_id':gid,'result':'miss' if mode=='void' and leg['market']=='wr_rec_yds' else 'hit' if hit else 'miss','actual':{'yards':300 if hit else 0}})
  final={'home_score':24 if mode!='loss' else 10,'away_score':17 if mode!='loss' else 24,'winner':'SEA' if mode!='loss' else 'LAR'}
  review['weeks'][str(week)]={'games':[{**game,'status':'STATUS_FINAL','final':final}],
   'parlays':[{'scope':'game','game_id':gid,'legs':rvlegs}]}
 (data/'schedule_full.json').write_bytes(ex.encoded({'season':2026,'games':games}))
 (data/'review.json').write_bytes(ex.encoded(review));(data/'parlay_leg_scores.json').write_bytes(ex.encoded(scores))
 git(root,'add','.');git(root,'commit','-qm','pinned retrospective outcome evidence')
 return git(root,'rev-parse','HEAD')
`;

function py(body) {
  const wrapper = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/replay_on_card_reference.py').resolve());LINES=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return traced\nsys.settrace(traced)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8', input: wrapper,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 32 * 1024 * 1024,
  }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('actual retained pre-kickoff Git reference independently reproduces the on-card claim without current data substitution', () => {
  const out = py(`
before={str(p):r.replay._raw_hash(p.read_bytes()) for p in pathlib.Path('data').glob('*.json')}
report=r.reconstruct();after={str(p):r.replay._raw_hash(p.read_bytes()) for p in pathlib.Path('data').glob('*.json')}
totals={name:{key:sum(w['policies'][name][key] for w in report['weeks']) for key in ('settlement_wins','settlement_graded_cards','full_contract_hits')} for name in ('as_built_git_snapshot','r74_control','r126')}
print(json.dumps({'totals':totals,'weeks':report['weeks'],'history':report['history'],'games':len(report['games']),
 'gate':r.gate_result(report),'unchanged':before==after,'limits':report['limits'],'exclusions':report['exclusions'],
 'aggregate_consistent':all(report['totals'][name][k]==v for name,row in totals.items() for k,v in row.items()),
 'claim_metric':report['historical_claim_metric']}))
`);
  assert.deepEqual(out.totals.as_built_git_snapshot, { settlement_wins: 59, settlement_graded_cards: 188, full_contract_hits: 48 });
  assert.deepEqual(out.totals.r74_control, out.totals.as_built_git_snapshot);
  assert.deepEqual(out.totals.r126, { settlement_wins: 72, settlement_graded_cards: 189, full_contract_hits: 61 });
  assert.deepEqual(out.weeks.map(w => w.policies.r126.settlement_wins), [20, 21, 16, 15]);
  assert.ok(out.weeks.every(w => !w.historical_acceptance_eligible)); assert.equal(out.games, 63);
  assert.equal(out.gate.passed, true); assert.equal(out.gate.historical_acceptance_eligible, false);
  assert.equal(out.unchanged, true); assert.deepEqual(out.exclusions, []);
  assert.equal(out.aggregate_consistent, true); assert.match(out.claim_metric, /reduced wins included.*not full_contract_hits/);
  assert.match(out.history.clock_basis, /mutable.*not independent/); assert.ok(out.limits.some(s => s.includes('not the complete candidate universe')));
});

test('synthetic local history pins each candidate/correlation tree and separate original outcome reference without executing old code', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)/'repo';reference=fixture(root);report=r.reconstruct(root,reference)
 # Poison working-tree documents: every historical read must still use Git blobs.
 for p in (root/'data').glob('*.json'):p.write_text('{}')
 replayed=r.reconstruct(root,reference)
 print(json.dumps({'same':report==replayed,'gate':r.gate_result(report),'weeks':report['weeks'],
  'historical_code_hashes':list({g['source']['historical_builder_sha256'] for g in report['games']}),
  'source_commits':list({g['source']['commit'] for g in report['games']}),'reference':reference,'history':report['history']}))
`);
  assert.equal(out.same, true); assert.equal(out.gate.passed, true); assert.equal(out.history.shallow, false);
  assert.equal(out.source_commits.length, 4); assert.ok(out.source_commits.every(c => c !== out.reference));
  assert.equal(out.historical_code_hashes.length, 1);
});

test('independent planted losing selections, pending outcomes and missing required weeks all fail the explicit on-card gate', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 for mode in ('hit','loss','pending'):
  root=pathlib.Path(tmp)/mode;ref=fixture(root,mode);report=r.reconstruct(root,ref);results[mode]=r.gate_result(report)
  if mode=='hit':
   missing=copy.deepcopy(report);missing['weeks'].pop();results['missing_week']=r.gate_result(missing)
   empty=copy.deepcopy(report);empty['weeks'][0]['expected_schedule_games']=0;results['empty_week']=r.gate_result(empty)
   incomplete=copy.deepcopy(report);incomplete['weeks'][0]['recovered_games']=0;results['incomplete']=r.gate_result(incomplete)
   corrupt=copy.deepcopy(report);corrupt['weeks'][0]['policies']['r126']['settlement_wins']=True;results['bool']=r.gate_result(corrupt)
 results['malformed']=r.gate_result({})
print(json.dumps(results))
`);
  assert.equal(out.hit.passed, true); assert.ok(Object.entries(out).filter(([k]) => k !== 'hit').every(([, v]) => !v.passed));
  assert.ok(out.loss.reasons.some(x => x.reason === 'r126_fewer_settlement_winners_than_same_union_r74'));
  assert.ok(out.pending.reasons.some(x => x.reason === 'required_outcome_coverage_incomplete'));
});

test('legacy ledger no-stat-line VOID overrides review miss; only absent ledger uses review fallback; metrics stay distinct', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 for mode in ('void','fallback'):
  root=pathlib.Path(tmp)/mode;ref=fixture(root,mode);report=r.reconstruct(root,ref);results[mode]=report['games'][0]
print(json.dumps(results))
`);
  const voidCards = out.void.policies.r126.cards;
  assert.ok(voidCards.some(c => c.legs.some(l => l.basis === 'legacy_ledger_VOID_precedence' && l.result === 'void')));
  assert.ok(out.void.policies.r126.settlement_wins > out.void.policies.r126.full_contract_hits);
  assert.ok(out.fallback.policies.r74_control.cards.some(c => c.legs.some(l => l.basis === 'legacy_review_fallback_no_ledger_row')));
});

test('ordered union rejects conflicting prices/aliases, preserves distinct contracts and faithfully keeps as-built multiplicity separate', () => {
  const out = py(`
a={'market':'moneyline','selection':'SEA ML','model_prob':.8,'implied_prob':.8,'side':'home'}
b={'market':'rb_rush_yds','selection':'RUNNER','model_prob':.7,'implied_prob':.7,'side':'away','gsis_id':'00-1','line':40}
cards=[{'legs':[b,a]},{'legs':[a,b]}];union=r._union(cards,'g')
conflict=json.loads(json.dumps(cards));conflict[1]['legs'][0]['model_prob']=.6
alias=json.loads(json.dumps(cards));alias[1]['legs'][0]['selection']='SEA  ML'
other=copy.deepcopy(b);other['line']=50
distinct=r._union([{'legs':[b,other,a]}],'g')
event={'game_id':'g','week':2,'home':'SEA','away':'LAR','kickoff_utc':'2026-09-02T00:15Z'}
fin={'week':2,'home':'SEA','away':'LAR','kickoff_utc':event['kickoff_utc'],'home_score':24,'away_score':17}
evidence=(fin,{}, {},{(2,'g',b['market'],b['selection']):[{'result':'hit','actual':300}]})
asbuilt=r._grade([c['legs'] for c in cards],event,evidence)
thin=r.replay.select_candidates({'game_id':'g','candidates':r._union([{'legs':[a]}],'g'),'correlations':{'pairs':[{'key':'moneyline|spread','rho':.7}],'default_rho':0}})
print(json.dumps({'order':[x['selection'] for x in union],'conflict':error(lambda:r._union(conflict,'g')),
 'alias':error(lambda:r._union(alias,'g')),'distinct':len(distinct),'as_built':asbuilt,'thin':len(thin['r126'])}))
`);
  assert.deepEqual(out.order, ['RUNNER', 'SEA ML']); assert.equal(out.conflict, 'conflicting_on_card_contract');
  assert.equal(out.alias, 'conflicting_on_card_contract'); assert.equal(out.distinct, 3);
  assert.equal(out.as_built.distinct_or_as_built_cards, 2); assert.equal(out.thin, 1);
});

test('missing historical correlation, equal-clock ambiguity and unsupported data remain exclusions, never current fallback', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 for label,kwargs in [('missing',{'missing_cal':True}),('tie',{'clock_tie':True})]:
  root=pathlib.Path(tmp)/label;ref=fixture(root,**kwargs);report=r.reconstruct(root,ref);results[label]={'exclusions':report['exclusions'],'gate':r.gate_result(report)}
 print(json.dumps(results))
`);
  assert.equal(out.missing.exclusions[0].reason, 'reference_blob_unavailable'); assert.equal(out.missing.gate.passed, false);
  assert.equal(out.tie.exclusions[0].reason, 'ambiguous_equal_clock_snapshot'); assert.equal(out.tie.gate.passed, false);
});

test('malformed sources, missing/non-FINAL evidence, push/tie and ledger contradictions are explicit, never fabricated zeroes', () => {
  const out = py(`
event={'game_id':'g','week':2,'home':'SEA','away':'LAR','kickoff_utc':'2026-09-02T00:15Z'}
fin={**event,'home_score':20,'away_score':17};a={'market':'moneyline','selection':'SEA ML','side':'home'}
prop={'market':'wr_rec_yds','selection':'W. One 60+ rec yds','side':'home','line':59.5};key=(2,'g',prop['market'],prop['selection'])
statuses={}
for label,leg,final in [('missing',a,None),('side',{**a,'side':'away'},fin),('selection',{**a,'selection':'unknown'},fin),('tie',a,{**fin,'home_score':17}),('push',{'market':'spread','selection':'SEA -3','side':'home'},fin)]:
 statuses[label]=r._leg_result(leg,event,final,{}, {},{})
statuses['no_evidence']=r._leg_result(prop,event,fin,{}, {},{})
statuses['contradiction']=r._leg_result(prop,event,fin,{key:[{'hit':True,'actual':70}]},{key:[{'reason':'no_stat_line'}]}, {})
statuses['different_contract']=r._leg_result(prop,event,fin,{key:[{'hit':True,'actual':70,'line':80}]},{}, {})
statuses['bad_fallback']=r._leg_result(prop,event,fin,{}, {},{key:[{'result':True}]})
statuses['ambiguous']=r._leg_result(prop,event,fin,{}, {},{key:[{'result':'hit'},{'result':'miss'}]})
errors={}
errors['request']=error(lambda:r.reconstruct(reference='--remote'))
errors['period']=error(lambda:r._outcomes({'season':2025},{'season':2026},{'season':2026},2026,[2]))
errors['row']=error(lambda:r._indexed([True],lambda x:None))
errors['leg']=error(lambda:r._union([{'legs':[a]}],'g'))
errors['empty']=error(lambda:r._union([{'legs':[]}],'g'))
base={'generated_utc':'2026-09-01T12:00Z','correlations':{'default_rho':0,'pairs':[{'key':'moneyline|spread','rho':.7}]}}
for label in ('future','empty','invalid','duplicate','cal_container','corr_container','row_container'):
 cal=copy.deepcopy(base)
 if label=='future':cal['generated_utc']='2027-01-01T00:00Z'
 if label=='empty':cal['correlations']['pairs']=[]
 if label=='invalid':cal['correlations']['pairs'][0]['key']='bad|tag'
 if label=='duplicate':cal['correlations']['pairs']*=2
 if label=='cal_container':cal=[]
 if label=='corr_container':cal['correlations']=True
 if label=='row_container':cal['correlations']['pairs']=[[]]
 errors[label]=error(lambda:r._correlations(cal,'2026-09-02T00:00Z'))
print(json.dumps({'statuses':statuses,'errors':errors}))
`);
  assert.equal(out.statuses.tie.result, 'void'); assert.equal(out.statuses.push.result, 'void');
  assert.ok(Object.entries(out.statuses).filter(([k]) => !['tie', 'push'].includes(k)).every(([, v]) => v.result === 'pending'));
  assert.ok(Object.values(out.errors).every(Boolean));
});

test('explicit ledger team/side/player/line and spread label/line contradictions cannot grade a different contract', () => {
  const out = py(`
event={'game_id':'g','week':2,'home':'SEA','away':'LAR','kickoff_utc':'2026-09-02T00:15Z'}
fin={**event,'home_score':20,'away_score':21}
prop={'market':'wr_rec_yds','selection':'W. One 60+ rec yds','side':'away','line':59.5,'gsis_id':'00-2'}
key=(2,'g',prop['market'],prop['selection']);base={'hit':True,'actual':70,'line':59.5}
states={}
for label,fields in [('legacy_missing_ids',{}),('wrong_team',{'team':'SEA'}),('wrong_side',{'side':'home'}),('wrong_player',{'gsis_id':'00-1'}),('wrong_hit',{'hit':False}),('line_bool',{'line':True})]:
 states[label]=r._leg_result(prop,event,fin,{key:[{**base,**fields}]},{},{})
states['spread_conflict']=r._leg_result({'market':'spread','selection':'SEA -3','side':'home','line':3},event,fin,{},{},{})
states['valid_spread']=r._leg_result({'market':'spread','selection':'SEA +3','side':'home','line':3},event,fin,{},{},{})
states['wrong_void_contract']=r._leg_result(prop,event,fin,{},{key:[{'reason':'no_stat_line','team':'SEA'}]},{})
states['wrong_fallback_contract']=r._leg_result(prop,event,fin,{},{},{key:[{'result':'hit','gsis_id':'00-1'}]})
print(json.dumps(states))
`);
  assert.equal(out.legacy_missing_ids.result, 'hit'); assert.equal(out.valid_spread.result, 'hit');
  assert.ok(Object.entries(out).filter(([k]) => !['legacy_missing_ids', 'valid_spread'].includes(k)).every(([, v]) => v.result === 'pending'));
});

test('CLI defaults read-only; explicit immutable output, failed-gate exit1 and safe failures/authority containment are exercised', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)/'repo';ref=fixture(root,'loss');target=pathlib.Path(tmp)/'reports/reference.json'
 def cli(args):
  output=io.StringIO();errors=io.StringIO()
  with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):code=r.main(args)
  return code,json.loads(output.getvalue() or errors.getvalue())
 plain=cli(['--repo',str(root),'--reference',ref]);first=cli(['--repo',str(root),'--reference',ref,'--out',str(target),'--gate'])
 before=target.read_bytes();again=cli(['--repo',str(root),'--reference',ref,'--out',str(target),'--gate'])
 inside=cli(['--repo',str(root),'--reference',ref,'--out',str(root/'forbidden.json')]);bad=cli(['--reference','bad'])
 output=io.StringIO()
 with contextlib.redirect_stdout(output),mock.patch.object(sys,'argv',['replay_on_card_reference.py','--repo',str(root),'--reference',ref]):
  try:runpy.run_path('scripts/replay_on_card_reference.py',run_name='__main__')
  except SystemExit as exc:entrypoint=exc.code
 print(json.dumps({'plain':plain[0],'failed_gate':first[0],'same':first==again,'immutable':before==target.read_bytes(),
  'inside':inside[0],'no_authority_write':not(root/'forbidden.json').exists(),'bad':bad[0],'entrypoint':entrypoint}))
`);
  assert.equal(out.plain, 0); assert.equal(out.failed_gate, 1); assert.equal(out.same, true); assert.equal(out.immutable, true);
  assert.equal(out.inside, 2); assert.equal(out.no_authority_write, true); assert.equal(out.bad, 2); assert.equal(out.entrypoint, 0);
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), sourceHash);
  const executable = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1]) if n>0)))', SOURCE], { encoding: 'utf8' }));
  const denominator = new Set([...executable, ...covered]);
  const percent = 100 * covered.size / denominator.size;
  console.log(`On-card reference measured source sha256: ${sourceHash}`);
  console.log(`On-card reference executable-line coverage: ${covered.size}/${denominator.size} (${percent.toFixed(4)}%)`);
  assert.ok(percent >= 90, `On-card reference coverage below90; missing: ${[...denominator].filter(n => !covered.has(n)).join(',')}`);
});
