// Independent retained-error boundary, using only existing fixture generators.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));
const fixture=readFileSync(root+'tests/feature/week6_learning_export.test.mjs','utf8')
  .match(/const FIXTURE = `([\s\S]*?)`;/)?.[1];
const intakeFixture=readFileSync(root+'tests/feature/week6_learning_intake.test.mjs','utf8')
  .match(/const FIXTURE=String.raw`([\s\S]*?)`;/)?.[1];
assert.ok(fixture);
test('a valid credential equal to an allowlisted long error code is never persisted or printed',()=>{
  const p=spawnSync('python3',['-'],{cwd:root,encoding:'utf8',timeout:30000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},input:fixture+String.raw`
import io,os
from contextlib import redirect_stderr
from unittest.mock import patch
secret='delivery_directory_overlaps_sports_data'
assert len(secret)>=32
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);snapshots,_=fixture(root);p=ex.plan(snapshots);out=root/'delivery'
 def failed(*args):raise ex.ExportError(secret)
 report=ex.send(p,'https://fixture.invalid',out,secret,transport=failed,attempts=1,sleep=lambda _:None)
 stderr=io.StringIO()
 with patch.dict(os.environ,{'SELFLEARN_NFL_INGEST_TOKEN':secret}),patch.object(ex,'send',side_effect=ex.ExportError(secret)),redirect_stderr(stderr):
  code=ex.main(['--snapshots',str(snapshots),'--send','--base-url','https://fixture.invalid','--out-dir',str(root/'cli')])
 saved=''.join(f.read_text()for f in out.rglob('*.json'))
 print(json.dumps({'report':report,'code':code,'cli':stderr.getvalue(),
  'secret_saved':secret in saved,'secret_reported':secret in json.dumps(report)+stderr.getvalue()}))
`,maxBuffer:4*1024*1024});
  assert.equal(p.status,0,p.stderr+p.stdout);
  const o=JSON.parse(p.stdout.trim());
  assert.equal(o.secret_saved,false);assert.equal(o.secret_reported,false);
  assert.equal(o.report.ok,false);assert.equal(o.report.failures[0].reason,'export_failed');
  assert.equal(o.code,1);assert.equal(JSON.parse(o.cli).reason,'export_failed');
});

test('exporter error sanitization never swallows the intake shared-deadline control signal',()=>{
  assert.ok(intakeFixture);
  const p=spawnSync('python3',['-'],{cwd:root,encoding:'utf8',timeout:30000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},input:intakeFixture+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=inputs(root);server=Server();clock=[0];late=[]
 original=I.forecast._immutable
 def tracked(path,*args,**kwargs):
  if clock[0]>=1:late.append(str(path))
  return original(path,*args,**kwargs)
 def channel(route,body):
  response=server(route,body);clock[0]=2;return response
 with patch.object(I.forecast,'_immutable',side_effect=tracked):
  report=I.send(value,root/'delivery',TOKEN,OUTCOME,forecast_transport=channel,
   outcome_transport=lambda *args:(_ for _ in()).throw(AssertionError('no outcomes')),
   max_run_seconds=1,monotonic=lambda:clock[0],sleep=lambda _:None)
 print(json.dumps({'report':report,'late_protocol_writes':[p for p in late if '/attempts/'not in p],
  'status_writes':sum('/attempts/'in p for p in late),'calls':len(server.calls)}))
`,maxBuffer:4*1024*1024});
  assert.equal(p.status,0,p.stderr+p.stdout);
  const o=JSON.parse(p.stdout.trim());
  assert.equal(o.report.status,'pending_forecasts');assert.equal(o.report.reason,'intake_command_budget');
  assert.equal(o.calls,1);assert.deepEqual(o.late_protocol_writes,[]);assert.equal(o.status_writes,1);
});
