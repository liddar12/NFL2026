import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../scripts/prepublication_semantics.py', import.meta.url));
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
const FIXTURE = `
import copy,datetime,hashlib,json,math,os,pathlib,runpy,tempfile,urllib.request
from unittest import mock
from scripts import prepublication_semantics as sem, export_learning as ex, learning_receipts as lr
from scripts import learning_journal as journal, build_my_cards as cards
f=runpy.run_path('tests/fixtures/week6_publication.py')
NOW='2026-09-01T13:00:00Z'
def expected(doc,raw):
 gen=doc['generations'][0];receipt=doc['receipts'][0]['learning_receipt']
 return {'version':1,'season':2026,'week':6,'target_generation_id':gen['generation_id'],'target_envelope_id':doc['envelope_id'],
  'source_snapshots':gen['source_snapshots'],'output_sha256':'sha256:'+hashlib.sha256(raw).hexdigest(),
  'base_model_version':receipt['base_model_version'],'selection_policy_version':gen['selection_policy_version'],
  'joint_model_version':gen['joint_model_version'],'code_revision_claim':receipt['generation_sha']}
def fixture(root):
 s,p,doc,a=f['generation'](root);raw=p.read_bytes();return ex.plan(s),raw,expected(doc,raw),doc,s,p
def verify(graph,raw,expectation,**kwargs):return sem.verify_candidate(graph,raw,expectation,checked_utc=kwargs.pop('checked_utc',NOW),**kwargs)
def sources(graph):return {x['object_id']:x['payload'] for x in graph['source_objects']}
def report_ok(report):return report['report_id']==ex.fingerprint({k:v for k,v in report.items() if k!='report_id'})
def reseal_doc(graph,index=0):
 item=graph['generations'][index];doc=item['request']['payload'];gen=doc['generations'][0]
 gen['generation_id']=ex.fingerprint({k:gen[k] for k in ex.MANIFEST_KEYS})
 for row in doc['receipts']:row['generation_id']=gen['generation_id']
 doc['envelope_id']=ex.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'});item['request']['object_id']=doc['envelope_id']
 return doc
def produce(pool,schedule,calibration):
 offered,_=cards.offered_cards(pool,schedule['games'],calibration,pool['generated_utc'])
 records=[cards.card_record(d,s,r,c,cards.kickoff_index(schedule['games'])) for d,s,r,c in offered]
 doc,payloads=journal.capture(pool,schedule,calibration,records,'2026-09-01T12:01:00Z')
 graph={'version':1,'source_objects':[ex._request('source_snapshot',key,value) for key,value in payloads.items()],
  'generations':[{'request':ex._request('generation',doc['envelope_id'],doc),'expected_receipt_ids':doc['generations'][0]['receipt_ids']}]}
 archive=cards.append(None,records,2026,6,pool['generated_utc'],'2026-09-01T12:01:00Z');raw=ex.encoded(archive)
 return graph,raw,expected(doc,raw),doc
def bundle_fixture(root,bad=False,metadata=True,period=6,clock_mismatch=False,row_mode=None):
 graph,raw,e,doc,s,p=fixture(root);src=sources(graph);refs=doc['generations'][0]['source_snapshots']
 pool=copy.deepcopy(src[refs['leg_pool']]);schedule=copy.deepcopy(src[refs['schedule']]);calibration=src[refs['parlay_calibration']]
 pool['counts']={'not_playable':0}
 rows=[{'gsis_id':x['gsis_id'],'weeks':[{'wk':6,'avail':True}], 'this_week':{'playable':True}} for x in pool['players']]
 if bad:rows[0]['this_week']['playable']=False
 if row_mode in ('all_missing','one_missing','unknown_and_bad'):
  for row in (rows if row_mode=='all_missing' else rows[:1]):row.pop('this_week');row.pop('weeks')
 if row_mode=='one_absent':rows.pop(0)
 if row_mode=='unknown_and_bad':rows[1]['this_week']['playable']=False
 if row_mode=='conflicting_week':rows[0]['weeks'].append({'wk':6,'avail':False})
 weekly={'updated_utc':f['CREATED'],'players':rows}
 if metadata:weekly['model']={'this_week':{'wk':period}}
 docs={'player_weekly':weekly,'player_projections':{'updated_utc':f['CREATED'],'players':[]},
  'game_predictions':{'updated_utc':f['CREATED'],'games':schedule['games']},'pool_backtest':{'generated_utc':f['CREATED']}}
 bundle={'version':1,'documents':docs};digest=ex.fingerprint(docs);clocks={name:x.get('generated_utc') or x.get('updated_utc') for name,x in docs.items()}
 for player in pool['players']:
  for rung in player['rungs']:
   receipt=rung['learning_receipt'];receipt['source_snapshot_id']=digest;receipt['source_timestamps']={**clocks}
   if clock_mismatch:receipt['source_timestamps']['player_weekly']='2026-09-01T11:00:00Z'
   receipt['receipt_id']=ex.fingerprint({k:v for k,v in receipt.items() if k!='receipt_id'})
 return (*produce(pool,schedule,calibration),bundle)
`;

function py(body) {
  const wrapper = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/prepublication_semantics.py').resolve());LINES=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return traced\nsys.settrace(traced)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8', input: wrapper,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 32 * 1024 * 1024,
  }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('actual MY producer graph yields sealed scoped checks, never whole-release readiness or proven code/freshness', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 graph,raw,e,doc,s,p=fixture(pathlib.Path(tmp));before=copy.deepcopy((graph,e));files={str(x):x.read_bytes() for x in pathlib.Path(tmp).rglob('*.json')}
 with mock.patch('builtins.open',side_effect=AssertionError('no file I/O')),mock.patch.object(pathlib.Path,'read_bytes',side_effect=AssertionError('no file I/O')),mock.patch.object(urllib.request,'urlopen',side_effect=AssertionError('no network')),mock.patch.object(os,'getenv',side_effect=AssertionError('no environment')):
  report=verify(graph,raw,e);again=verify(graph,raw,e)
 print(json.dumps({'report':report,'same':report==again,'sealed':report_ok(report),'unchanged':before==(graph,e) and files=={str(x):x.read_bytes() for x in pathlib.Path(tmp).rglob('*.json')}}))
`);
  assert.equal(out.report.status, 'incomplete'); assert.equal(out.report.consumer_checks_passed, true);
  assert.equal(out.report.release_ready, false); assert.equal(out.report.writes, false); assert.equal(out.report.network_used, false);
  assert.ok(out.report.coverage.target_prop_legs > 0); assert.ok(out.report.coverage.unsupported_locations > 0);
  assert.ok(out.report.checks.filter(c => ['raw_provider_freshness', 'base_model_training_and_code_execution_authority'].includes(c.name)).every(c => c.status === 'unknown'));
  assert.match(out.report.checks.find(c => c.name === 'expected_model_policy_code_identity').authority, /caller-claim equality.*not proven/);
  assert.equal(out.same, true); assert.equal(out.sealed, true); assert.equal(out.unchanged, true);
});

test('exact output bytes and expected target/source/model/policy/code mismatches fail closed without leaking rejected values', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 g,b,e,d,s,p=fixture(pathlib.Path(tmp))
 for kind in ('bytes','target','envelope','sources','model','selection','joint','code','bool','clock','started'):
  expected=copy.deepcopy(e);raw=b;kwargs={}
  if kind=='bytes':raw=b+b' '
  if kind=='target':expected['target_generation_id']=ex.fingerprint('wrong')
  if kind=='envelope':expected['target_envelope_id']=ex.fingerprint('wrong')
  if kind=='sources':expected['source_snapshots']['schedule']=ex.fingerprint('wrong')
  if kind=='model':expected['base_model_version']='private-sentinel-model'
  if kind=='selection':expected['selection_policy_version']=ex.fingerprint('wrong')
  if kind=='joint':expected['joint_model_version']=ex.fingerprint('wrong')
  if kind=='code':expected['code_revision_claim']='private-sentinel-code'
  if kind=='bool':expected['version']=True
  if kind=='clock':kwargs['checked_utc']='private-sentinel-clock'
  if kind=='started':kwargs['checked_utc']=f['KICKOFF']
  results[kind]=verify(g,raw,expected,**kwargs)
print(json.dumps({'states':{k:x['status'] for k,x in results.items()},'sealed':all(report_ok(x) for x in results.values()),
 'no_partial':all(not x['membership'] and not x['consumer_checks_passed'] and not x['release_ready'] for x in results.values()),
 'redacted':'private-sentinel' not in json.dumps(results)}))
`);
  assert.ok(Object.values(out.states).every(v => v === 'failed')); assert.equal(out.no_partial, true); assert.equal(out.sealed, true); assert.equal(out.redacted, true);
});

test('graph/partition/version/content tampering rejects even resealed unsupported semantics and canonical true/1 ambiguity', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 original,raw,e,d,s,p=fixture(pathlib.Path(tmp))
 for kind in ('graph_version','request_version','kind','source_hash','envelope_hash','generation_version','generation_hash','partition','row_reference','source_missing','receipts_duplicate','extra_request'):
  g=copy.deepcopy(original);doc=g['generations'][0]['request']['payload'];gen=doc['generations'][0]
  if kind=='graph_version':g['version']=True
  if kind=='request_version':g['source_objects'][0]['version']=True
  if kind=='kind':g['source_objects'][0]['kind']='private-sentinel'
  if kind=='source_hash':g['source_objects'][0]['payload']={'private-sentinel':True}
  if kind=='envelope_hash':doc['private-sentinel']=True
  if kind=='generation_version':gen['version']=True;reseal_doc(g)
  if kind=='generation_hash':gen['joint_model_version']=ex.fingerprint('changed')
  if kind=='partition':g['generations'][0]['expected_receipt_ids']=[]
  if kind=='row_reference':doc['receipts'][0]['generation_id']=ex.fingerprint('wrong');doc['envelope_id']=ex.fingerprint({k:v for k,v in doc.items() if k!='envelope_id'});g['generations'][0]['request']['object_id']=doc['envelope_id']
  if kind=='source_missing':g['source_objects']=[]
  if kind=='receipts_duplicate':doc['receipts'].append(copy.deepcopy(doc['receipts'][0]));reseal_doc(g)
  if kind=='extra_request':g['source_objects'][0]['private-sentinel']=True
  results[kind]=verify(g,raw,e)
 print(json.dumps({'failed':all(x['status']=='failed' for x in results.values()),'redacted':'private-sentinel' not in json.dumps(results)}))
`);
  assert.equal(out.failed, true); assert.equal(out.redacted, true);
});

test('original once-calibrated probabilities, feature bases, card identity and known durable membership cannot be silently changed', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 g,b,e,d,s,p=fixture(pathlib.Path(tmp));original=json.loads(b)
 for kind in ('served_twice','base_changed','feature_changed','unknown_receipt','missing_mapping','duplicate_card','bad_leg','n_legs','wrong_period'):
  output=copy.deepcopy(original);expected=copy.deepcopy(e);graph=copy.deepcopy(g)
  leg=next(l for c in output['cards'] for l in c['legs'] if l['market'] in lr.PROP_MARKETS);receipt=leg['learning_receipt']
  if kind=='served_twice':leg['model_prob']=lr.serve_probability(receipt['served_prob'],{'a':.5,'b':1})
  if kind=='base_changed':receipt['base_prob']=.8
  if kind=='feature_changed':receipt['features']['mu']+=1
  if kind=='unknown_receipt':
   receipt['generation_sha']='new-unknown-vintage';receipt['receipt_id']=ex.fingerprint({k:v for k,v in receipt.items() if k!='receipt_id'})
  if kind=='missing_mapping':output['cards'][0]['card_id']='not-original-card'
  if kind=='duplicate_card':output['cards'].append(copy.deepcopy(output['cards'][0]))
  if kind=='bad_leg':output['cards'][0]['legs'][0]=True
  if kind=='n_legs':output['cards'][0]['n_legs']=True
  if kind=='wrong_period':output['week']=5
  raw=ex.encoded(output);expected['output_sha256']='sha256:'+hashlib.sha256(raw).hexdigest();results[kind]=verify(graph,raw,expected)
 print(json.dumps({k:x['status'] for k,x in results.items()}))
`);
  assert.ok(Object.values(out).every(v => v === 'failed'));
});

test('retained dedup display vintages preserve old lineage and cannot inherit newer generation eligibility/model/policy', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,old,archive=f['generation'](root)
 s,p,new,updated=f['generation'](root,created='2026-09-01T12:30:00Z',previous=archive)
 g=ex.plan(s);raw=p.read_bytes();e=expected(new,raw);report=verify(g,raw,e)
 print(json.dumps({'report':report,'old_generation':old['generations'][0]['generation_id'],'new_generation':new['generations'][0]['generation_id']}))
`);
  assert.equal(out.report.status, 'incomplete'); assert.equal(out.report.consumer_checks_passed, false);
  assert.equal(out.report.coverage.target_prop_legs, 0); assert.ok(out.report.coverage.retained_vintage_prop_legs > 0);
  assert.ok(out.report.membership.every(m => m.generation_id === out.old_generation && m.lineage_class === 'retained_older_display_vintage'));
  assert.notEqual(out.old_generation, out.new_generation); assert.equal(out.report.release_ready, false);
});

test('optional frozen upstream bundle must bind exact producer content/clocks; legacy metadata and raw provider authority stay unknown', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 for label,bad,metadata in [('bound',False,True),('bad_eligibility',True,True),('legacy_metadata',False,False)]:
  root=pathlib.Path(tmp)/label;root.mkdir();g,b,e,d,bundle=bundle_fixture(root,bad,metadata)
  results[label]=verify(g,b,e,frozen_inputs=bundle)
  if label=='bound':
   wrong=copy.deepcopy(bundle);wrong['documents']['player_weekly']['private-sentinel']='changed';results['wrong_content']=verify(g,b,e,frozen_inputs=wrong)
   malformed=copy.deepcopy(bundle);malformed['version']=True;results['malformed']=verify(g,b,e,frozen_inputs=malformed)
 for label,kwargs in [('missing_period',{'period':None}),('wrong_period',{'period':5}),('bool_period',{'period':True}),('clock_mismatch',{'clock_mismatch':True})]:
  root=pathlib.Path(tmp)/label;root.mkdir();g,b,e,d,bundle=bundle_fixture(root,**kwargs);results[label]=verify(g,b,e,frozen_inputs=bundle)
print(json.dumps({'reports':results,'redacted':'private-sentinel' not in json.dumps(results)}))
`);
  assert.equal(out.reports.bound.consumer_checks_passed, true); assert.equal(out.reports.bound.status, 'incomplete');
  assert.equal(out.reports.bound.checks.find(c => c.name === 'upstream_consumer_eligibility').status, 'pass');
  assert.equal(out.reports.bound.checks.find(c => c.name === 'raw_provider_freshness').status, 'unknown');
  assert.equal(out.reports.legacy_metadata.checks.find(c => c.name === 'upstream_consumer_eligibility').status, 'unknown');
  assert.equal(out.reports.missing_period.checks.find(c => c.name === 'upstream_consumer_eligibility').status, 'unknown');
  assert.ok(['bad_eligibility', 'wrong_content', 'malformed', 'wrong_period', 'bool_period', 'clock_mismatch'].every(k => out.reports[k].status === 'failed'));
  assert.equal(out.redacted, true);
});

test('newer/non-target and ambiguous lineage are not mislabeled older or silently promoted; future output evidence fails', () => {
  const out = py(`
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);s,p,old,a=f['generation'](root);original=ex.plan(s);oldraw=p.read_bytes()
 s,p,new,a=f['generation'](root,created='2026-09-01T12:30:00Z');g=ex.plan(s);raw=p.read_bytes();e=expected(old,raw)
 newer=verify(g,raw,e);future=verify(g,raw,e,checked_utc='2026-09-01T12:15:00Z')
 ambiguous=copy.deepcopy(original);entry=copy.deepcopy(ambiguous['generations'][0]);entry['request']['payload']['generations'][0]['joint_model_version']=ex.fingerprint('other-unverified-policy')
 ambiguous['generations'].append(entry);reseal_doc(ambiguous,1);amb=verify(ambiguous,oldraw,expected(old,oldraw))
 print(json.dumps({'newer':newer,'future':future,'ambiguous':amb}))
`);
  assert.equal(out.newer.status, 'incomplete'); assert.equal(out.newer.coverage.retained_vintage_prop_legs, 0);
  assert.ok(out.newer.coverage.other_non_target_vintage_prop_legs > 0);
  assert.ok(out.newer.membership.every(m => m.lineage_class === 'non_target_newer_or_unordered_vintage'));
  assert.equal(out.future.status, 'failed'); assert.equal(out.ambiguous.status, 'incomplete');
  assert.equal(out.ambiguous.consumer_checks_passed, false); assert.ok(out.ambiguous.unsupported.some(x => x.reason === 'ambiguous_generation_membership'));
});

test('missing per-player eligibility stays row-local unknown and cannot hide a known refusal in another row', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 for mode in ('all_missing','one_missing','one_absent','unknown_and_bad','conflicting_week'):
  root=pathlib.Path(tmp)/mode;root.mkdir();g,b,e,d,bundle=bundle_fixture(root,row_mode=mode);results[mode]=verify(g,b,e,frozen_inputs=bundle)
 empty_bundle={'version':1,'documents':{key:{} for key in sem.UPSTREAM_NAMES}}
 results['empty_target']=sem._upstream(empty_bundle,{'week':6,'receipts':[]},{'players':[]},{'cards':[]},[])
print(json.dumps(results))
`);
  for (const mode of ['all_missing', 'one_missing', 'one_absent']) {
    assert.equal(out[mode].status, 'incomplete'); assert.equal(out[mode].release_ready, false);
    assert.equal(out[mode].checks.find(c => c.name === 'upstream_consumer_eligibility').status, 'unknown');
    assert.ok(out[mode].upstream_eligibility_coverage.unknown_players > 0);
  }
  assert.ok(out.one_missing.upstream_eligibility_coverage.known_metadata_players > 0);
  assert.equal(out.unknown_and_bad.status, 'failed'); assert.equal(out.conflicting_week.status, 'failed');
  assert.equal(out.empty_target[1], 'unknown');
});

test('unsupported families/missing receipts are explicit incomplete coverage; duplicate copies are stable but conflicting lineage fails', () => {
  const out = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
 g,b,e,d,s,p=fixture(pathlib.Path(tmp));normal=verify(g,b,e)
 duplicate=copy.deepcopy(g);duplicate['generations']*=2;duplicate['source_objects']*=2;duplicate['snapshot_dir']='private-ignored-path'
 results['duplicate']=verify(duplicate,b,e)
 conflict=copy.deepcopy(g);other=copy.deepcopy(conflict['generations'][0]);other['request']['payload']['generations'][0]['recorded_utc']='2026-09-01T12:02:00Z'
 for row in other['request']['payload']['receipts']:row['recorded_utc']='2026-09-01T12:02:00Z'
 conflict['generations'].append(other);reseal_doc(conflict,1);results['conflict']=verify(conflict,b,e)
 for label in ('family','missing_receipts','empty_cards'):
  output=json.loads(b)
  if label=='family':output={'season':2026,'week':6,'parlays':[]}
  if label=='missing_receipts':
   for card in output['cards']:
    for leg in card['legs']:leg.pop('learning_receipt',None)
  if label=='empty_cards':output['cards']=[]
  raw=ex.encoded(output);claim=copy.deepcopy(e);claim['output_sha256']='sha256:'+hashlib.sha256(raw).hexdigest();results[label]=verify(g,raw,claim)
 print(json.dumps({'results':results,'duplicate_stable':results['duplicate']==normal}))
`);
  assert.equal(out.duplicate_stable, true); assert.equal(out.results.conflict.status, 'failed');
  assert.ok(['family', 'missing_receipts', 'empty_cards'].every(k => out.results[k].status === 'incomplete' && !out.results[k].consumer_checks_passed && !out.results[k].release_ready));
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), sourceHash);
  const executable = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1]) if n>0)))', SOURCE], { encoding: 'utf8' }));
  const denominator = new Set([...executable, ...covered]);
  const percent = 100 * covered.size / denominator.size;
  console.log(`Prepublication semantics measured source sha256: ${sourceHash}`);
  console.log(`Prepublication semantics executable-line coverage: ${covered.size}/${denominator.size} (${percent.toFixed(4)}%)`);
  assert.ok(percent >= 90, `Prepublication coverage below90; missing: ${[...denominator].filter(n => !covered.has(n)).join(',')}`);
});
