import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = String.raw`
import copy,datetime as dt,importlib.util,io,json,pathlib,sys,tempfile,types
from contextlib import redirect_stdout,redirect_stderr
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('canary',pathlib.Path('tests/pilot_linux_canary.py'))
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
def refused(fn):
 try:fn()
 except (ValueError,RuntimeError,OSError,KeyError,TypeError):return True
 return False
def summary(revisions=4,changed=True):
 return {'version':1,'kind':'nfl.repository_feedback_summary.v1','status':'local_repository_persisted_not_deployed',
  'receipts':4,'outcome_revisions':revisions,'cohort_n':2,'late_imported_receipts':4,'first_imported_before_kickoff':0,
  'state_changed':changed,'writes':True,'network_used':False,**{key:False for key in C.FALSE_FLAGS},
  'outcome_basis':'threshold_observations_not_sportsbook_settlement','settlement_support':'unresolved_push_and_official_void',
  'candidate_gate':{'passed':False},'resource_usage':{'platform':'linux','controller_limits_applied':True,
   'memory_enforcement':'linux_rlimit_as','address_space_limit_bytes':2*1024**3,'cpu_limit_seconds':180,
   'regular_file_limit_bytes':128*1024**2+1,'wall_clock_limit_seconds':300}}
def states():
 first={'state_id':'synthetic-initial','previous_state_id':None,'sequence':1,
  'receipts':[{'receipt_id':str(i)}for i in range(4)],'receipt_imports':[{'receipt_id':str(i),'first_imported_utc':'2026-10-20T12:00:00Z'}for i in range(4)],
  'source_imports':[{'object_id':'source','first_imported_utc':'2026-10-20T12:00:00Z'}],
  'generation_records':[{'synthetic':True}],'source_object_ids':['source'],
  'revisions':[{'revision_id':'revision-'+str(i),'supersedes':None,'resolution':{'receipt_id':str(i),'hit':True}}for i in range(4)]}
 corrected=copy.deepcopy(first);corrected.update(state_id='synthetic-corrected',previous_state_id=first['state_id'],sequence=2)
 corrected['revisions'] += [{'revision_id':'corrected-'+str(i),'supersedes':'revision-'+str(i),'resolution':{'receipt_id':str(i),'hit':False}}for i in range(4)]
 return first,copy.deepcopy(first),corrected
`;

function py(body) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-'], {
    cwd: ROOT, encoding: 'utf8', input: SETUP + body, timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('synthetic unit result fixtures validate the Linux limits and three expected phases', () => {
  const r = py(String.raw`
for revisions,changed in((4,True),(4,False),(8,True)):C.validate_summary(summary(revisions,changed),revisions,changed)
C.validate_history(*states())
print(json.dumps({'unit_validation_passed':True,'actual_linux_execution':False,'stdlib_only':True}))
`);
  assert.deepEqual(r, { unit_validation_passed: true, actual_linux_execution: false, stdlib_only: true });
});

test('result validation refuses missing, excessive or merely declared resource ceilings and authority flags', () => {
  const r = py(String.raw`
checks=[]
for key,value in(('platform','darwin'),('controller_limits_applied',False),('memory_enforcement','rss_only'),
 ('address_space_limit_bytes',2*1024**3+1),('address_space_limit_bytes',True),('cpu_limit_seconds',181),
 ('regular_file_limit_bytes',128*1024**2+2),('wall_clock_limit_seconds',301),('wall_clock_limit_seconds',True)):
 row=summary();row['resource_usage'][key]=value;checks.append(refused(lambda:C.validate_summary(row,4,True)))
for key,value in(('resource_usage',None),('late_imported_receipts',0),('first_imported_before_kickoff',4),
 ('receipts',True),('outcome_revisions',8),('network_used',True),('writes',False),('settlement_support','complete'),
 ('outcome_basis','sportsbook_settlement'),('candidate_gate',{'passed':True}),('state_changed',False)):
 row=summary();row[key]=value;checks.append(refused(lambda:C.validate_summary(row,4,True)))
for key in C.FALSE_FLAGS:
 row=summary();row[key]=True;checks.append(refused(lambda:C.validate_summary(row,4,True)))
print(json.dumps(checks))
`);
  assert.equal(r.length, 28);
  assert.ok(r.every(Boolean));
});

test('history validation requires retry identity, append-only corrections and unchanged first imports', () => {
  const r = py(String.raw`
checks=[]
for mutation in('retry','prefix','parent','sequence','clock','hit','receipt','supersedes','duplicate'):
 first,repeated,corrected=states()
 if mutation=='retry':repeated['sequence']=2
 elif mutation=='prefix':corrected['revisions'][0]['resolution']['hit']=False
 elif mutation=='parent':corrected['previous_state_id']='wrong'
 elif mutation=='sequence':corrected['sequence']=5
 elif mutation=='clock':corrected['receipt_imports'][0]['first_imported_utc']='2026-09-01T00:00:00Z'
 elif mutation=='hit':corrected['revisions'][4]['resolution']['hit']=True
 elif mutation=='receipt':corrected['revisions'][4]['resolution']['receipt_id']='wrong'
 elif mutation=='supersedes':corrected['revisions'][4]['supersedes']='unknown'
 else:corrected['revisions'][5]['supersedes']='revision-0'
 checks.append(refused(lambda:C.validate_history(first,repeated,corrected)))
print(json.dumps(checks))
`);
  assert.equal(r.length, 9);
  assert.ok(r.every(Boolean));
});

test('non-Linux execution refuses before temp files, helper imports or child CLI, with sanitized output', () => {
  const r = py(String.raw`
out=io.StringIO()
with patch.object(C.sys,'platform','darwin'),patch.object(C.tempfile,'TemporaryDirectory',side_effect=AssertionError('must not write')),patch.object(C.subprocess,'run',side_effect=AssertionError('must not execute')),patch.object(C.importlib.util,'spec_from_file_location',side_effect=AssertionError('must not import fixture')),redirect_stderr(out):
 code=C.main(['--engine-checkout','PRIVATE_ENGINE','--expected-nfl-sha','a'*40,'--output','PRIVATE_OUTPUT'])
print(json.dumps({'code':code,'output':out.getvalue(),'helper_imported':'scripts.run_parlay_feedback'in sys.modules}))
`);
  assert.equal(r.code, 2);
  assert.equal(r.helper_imported, false);
  assert.ok(!r.output.includes('PRIVATE'));
  const row = JSON.parse(r.output);
  assert.equal(row.error, 'pilot_linux_canary_linux_required');
  assert.equal(row.synthetic_linux_canary_passed, false);
});

test('required arguments fail without a misleading successful or skipped canary', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', 'tests/pilot_linux_canary.py'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2);
  const row = JSON.parse(result.stderr);
  assert.equal(row.status, 'refused');
  assert.equal(row.error, 'pilot_linux_canary_arguments_required');
  assert.equal(row.synthetic_linux_canary_passed, false);
});

test('evidence output rejects source overlap, broad ancestors, engine overlap and symlinks', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as temporary:
 root=pathlib.Path(temporary).resolve();engine=root/'engine';engine.mkdir()
 paths=[C.ROOT,C.ROOT/'data/evidence.json',C.ROOT.parent,engine,engine/'evidence.json',pathlib.Path('/')]
 checks=[refused(lambda path=path:C.outside_checkouts(path,engine))for path in paths]
 link=root/'link';link.symlink_to(C.ROOT);checks.append(refused(lambda:C.outside_checkouts(link/'evidence.json',engine)))
 valid=C.outside_checkouts(root/'evidence.json',engine)==root/'evidence.json'
 print(json.dumps({'refused':checks,'valid':valid}))
`);
  assert.equal(r.refused.length, 7);
  assert.ok(r.refused.every(Boolean));
  assert.equal(r.valid, true);
});

test('CLI command unit test requires isolated stdlib Python, exact pin and timeout without an injected clock', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as temporary:
 root=pathlib.Path(temporary).resolve();started=dt.datetime(2026,10,20,12,tzinfo=dt.timezone.utc);ended=started+dt.timedelta(seconds=2)
 first=summary();first.update(state_id='state',evaluation_id='evaluation');calls=[]
 def fake(command,**kwargs):
  calls.append({'command':command,'timeout':kwargs['timeout']});kwargs['stdout'].write(json.dumps(first).encode());return types.SimpleNamespace(returncode=0)
 feedback=types.SimpleNamespace(previous=lambda *a:({'evaluation_id':'evaluation'},{'state_id':'state'}),
  artifact=lambda *a:root/'evaluation.json',read_json=lambda *a:{'evaluation_id':'evaluation','as_of_utc':'2026-10-20T12:00:01Z'})
 with patch.object(C.subprocess,'run',side_effect=fake),patch.object(C,'utc_now',side_effect=(started,ended)):
  result=C.run_cli(feedback,root,root/'synthetic-engine',root/'synthetic-capture.json')
 print(json.dumps({'calls':calls,'same':result[0]==first,'actual_linux_execution':False}))
`);
  const { command, timeout } = r.calls[0];
  assert.deepEqual(command.slice(1, 4), ['-I', '-S', '-B']);
  assert.ok(command.includes('--execute'));
  assert.equal(command.at(-1), 'aacb19c73122f257449e977df40f2a2733991b2f');
  assert.ok(!command.some(value => /as.of|observed.utc|fake.clock/.test(value)));
  assert.equal(timeout, 330);
  assert.equal(r.same, true);
  assert.equal(r.actual_linux_execution, false);
});

test('unexpected failures sanitize library diagnostics and private paths', () => {
  const r = py(String.raw`
rows=[]
for error in(OSError('PRIVATE_PATH_OR_TOKEN'),C.CanaryError('PRIVATE_PATH_OR_TOKEN')):
 out=io.StringIO()
 with patch.object(C,'run',side_effect=error),redirect_stderr(out):
  code=C.main(['--engine-checkout','PRIVATE_ENGINE','--expected-nfl-sha','a'*40,'--output','PRIVATE_OUTPUT'])
 rows.append({'code':code,'output':out.getvalue()})
print(json.dumps(rows))
`);
  for (const row of r) {
    assert.equal(row.code, 2);
    assert.ok(!row.output.includes('PRIVATE'));
    assert.equal(JSON.parse(row.output).error, 'pilot_linux_canary_failed');
  }
});
