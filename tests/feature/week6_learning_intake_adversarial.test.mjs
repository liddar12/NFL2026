// Independent composition regressions: only the existing explicit fixture
// GENERATORS are reused, never the author's test bodies/assertions. Both real
// senders run. The remote ledger/namespace is a wire-memory fake, NOT SQL,
// hosted, provider-authenticated or current-membership coverage evidence.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const sources=['scripts/run_learning_intake.py','scripts/export_capture_application.py'];
const pins=sources.map(name=>createHash('sha256').update(readFileSync(ROOT+name)).digest('hex'));
const intake=readFileSync(ROOT+'tests/feature/week6_learning_intake.test.mjs','utf8')
  .match(/const FIXTURE=String.raw`([\s\S]*?)`;/)?.[1];
const application=readFileSync(ROOT+'tests/feature/week6_capture_application_export.test.mjs','utf8')
  .match(/const FIXTURE = `([\s\S]*?)`;/)?.[1];
assert.ok(intake&&application,'Explicit existing local fixture generators are required');
function py(body){
  const setup=`left={};right={}\nexec(${JSON.stringify(intake)},left)\nexec(${JSON.stringify(application)},right)\n`;
  const result=spawnSync('python3',['-'],{cwd:ROOT,input:setup+String.raw`
import json,pathlib,tempfile
from unittest.mock import patch
from contextlib import redirect_stdout
I=left['I']
def send(value,root,forecasts,outcomes,**kw):
 return I.send(value,root/'delivery',left['TOKEN'],left['OUTCOME'],forecast_transport=forecasts,outcome_transport=outcomes,sleep=lambda _:None,**kw)
`+body,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('real child sender validates full pinned reports and lost replies before source-free GET-only resume',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();server=right['Server']()
 server.lose_register=server.lose_step=True
 first=send(value,root,forecasts,server);before=len(server.calls);forecast_before=len(forecasts.calls)
 (root/'authority').rename(root/'unavailable')
 with patch.object(I.forecast,'plan',side_effect=AssertionError('must not reopen forecasts')),patch.object(I.outcome.O,'_validated',side_effect=AssertionError('must not reopen raw')):
  second=I.resume(root/'delivery',value['run_id'],left['TOKEN'],left['OUTCOME'],forecast_transport=forecasts,outcome_transport=server,sleep=lambda _:None)
 print(json.dumps({'first':first,'second':second,'get_only':all(method=='GET'for method,_,_ in server.calls[before:]),
  'no_new_forecasts':len(forecasts.calls)==forecast_before,'safe':'SECRET'not in left['saved'](root),
  'register_posts':sum(m=='POST'and p==I.outcome.BASE for m,p,b in server.calls),
  'step_posts':sum(m=='POST'and'/steps/'in p for m,p,b in server.calls)}))
`);
  assert.equal(result.first.status,'intake_complete');assert.equal(result.second.status,'intake_complete');
  assert.equal(result.first.steps_issued,2);assert.equal(result.second.steps_issued,0);
  assert.deepEqual(result.first.capture_results,result.second.capture_results);
  assert.equal(result.get_only,true);assert.equal(result.no_new_forecasts,true);assert.equal(result.safe,true);
  assert.equal(result.register_posts,1);assert.equal(result.step_posts,2);
  assert.equal(result.second.current_membership_reverified,false);assert.equal(result.second.current_outcome_coverage_verified,false);
  assert.equal(result.second.working_learning_loop,false);assert.equal(result.second.model_adoption,false);
});

test('a malformed real-child terminal report is pending without fresh raw staging or a whole-run ACK',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();server=right['Server']()
 server.register(value['capture_plans'][0]['request'])
 for batch in server.app['seal']['batches']:server.commit(batch['step_id'])
 def mutate(page):
  if page['view']=='terminal':page['records'][0]['version']=True
 server.mutate=mutate
 with patch.object(I.outcome.O,'_validated',side_effect=AssertionError('no raw for existing original')):
  report=send(value,root,forecasts,server)
 print(json.dumps({'report':report,'post_count':sum(m=='POST'for m,p,b in server.calls),
  'terminal_files':len(list((root/'delivery').rglob('terminal/original.json')))}))
`);
  assert.equal(result.report.status,'pending_outcomes');assert.equal(result.report.intake_complete,false);
  assert.equal(result.post_count,0);assert.equal(result.terminal_files,0);
});

test('a rejected forecast response cannot persist a credential disguised as a syntactically valid rejection reason',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();forecasts.reject=True
 server=right['Server']();secret='s'*40
 def channel(route,body):
  status,raw=forecasts(route,body);ack=json.loads(raw)
  if route==I.forecast.GENERATION_ROUTE:ack['rejections'][0]['reason']=secret
  return status,I.forecast.encoded(ack)
 report=I.send(value,root/'delivery',secret,left['OUTCOME'],forecast_transport=channel,outcome_transport=server,attempts=1,sleep=lambda _:None)
 print(json.dumps({'report':report,'outcome_calls':len(server.calls),'secret_persisted':secret in left['saved'](root)}))
`);
  assert.equal(result.report.status,'pending_forecasts');assert.equal(result.report.intake_complete,false);
  assert.equal(result.outcome_calls,0);assert.equal(result.secret_persisted,false);
});

test('a zero-rejection forecast ACK cannot persist a credential disguised as a hash-shaped generic receipt ID',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();server=right['Server']();secret='sha256:'+'a'*64
 def channel(route,body):
  status,raw=forecasts(route,body);ack=json.loads(raw)
  if route==I.forecast.GENERATION_ROUTE:ack['receipts'][0]['receipt_id']=secret
  return status,I.forecast.encoded(ack)
 report=I.send(value,root/'delivery',secret,left['OUTCOME'],forecast_transport=channel,outcome_transport=server,attempts=1,sleep=lambda _:None)
 print(json.dumps({'report':report,'outcome_calls':len(server.calls),'secret_persisted':secret in left['saved'](root)}))
`);
  assert.equal(result.report.status,'pending_forecasts');assert.equal(result.report.intake_complete,false);
  assert.equal(result.outcome_calls,0);assert.equal(result.secret_persisted,false);
});

test('a validly rehashed real-child outcome revision cannot echo a credential into step or terminal records',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();server=right['Server'](sizes=(2,))
 secret='outcome_echo_'+'q'*40;original=server.commit
 def commit(step_id,cause=None):
  result=original(step_id,cause)
  result['groups'][0]['revision_ids'][0]=secret;result['groups'][0]['revision_ids'].sort()
  right['hashit'](result,'batch_result_id')
  if server.app['terminal']is not None:server.app['terminal']=right['terminal'](server.app)
  server.record();return result
 server.commit=commit
 report=I.send(value,root/'delivery',left['TOKEN'],secret,forecast_transport=forecasts,outcome_transport=server,sleep=lambda _:None)
 print(json.dumps({'report':report,'secret_persisted':secret in left['saved'](root),
  'terminal_files':len(list((root/'delivery').rglob('terminal/original.json'))),
  'step_ack_files':len(list((root/'delivery').rglob('steps/*/original.json')))}))
`);
  assert.equal(result.report.status,'pending_outcomes');assert.equal(result.report.intake_complete,false);
  assert.equal(result.secret_persisted,false);assert.equal(result.terminal_files,0);assert.equal(result.step_ack_files,0);
});

test('ordinary failures are sanitized through both real senders and BaseException cancellation is not converted to an ACK',()=>{
  const results=py(String.raw`
results=[]
for phase in ('forecast','outcome'):
 for error in (I.forecast.ExportError('PRIVATE_CALLBACK_TEXT'),RuntimeError('PRIVATE_CALLBACK_TEXT'),KeyboardInterrupt(),SystemExit()):
  with tempfile.TemporaryDirectory()as tmp:
   root=pathlib.Path(tmp);value,_,_=left['inputs'](root);forecasts=left['Server']();server=right['Server']()
   def failure(*args):raise error
   try:
    report=send(value,root,failure if phase=='forecast'else forecasts,failure if phase=='outcome'else server)
    cancelled=False
   except (KeyboardInterrupt,SystemExit):report=None;cancelled=True
   results.append({'phase':phase,'cancelled':cancelled,'report':report,'safe':'PRIVATE_CALLBACK_TEXT'not in left['saved'](root)})
print(json.dumps(results))
`);
  for(let i=0;i<results.length;i++){
    const row=results[i];assert.equal(row.safe,true);
    if(i%4>=2)assert.equal(row.cancelled,true);
    else{assert.equal(row.cancelled,false);assert.equal(row.report.status,'pending_'+(row.phase==='forecast'?'forecasts':'outcomes'));assert.equal(row.report.intake_complete,false);}
  }
});

test('the shared deadline stops a late real-child GET without retries, staging or processing another capture',()=>{
  const result=py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,_,_=left['inputs'](root,2);forecasts=left['Server']();server=right['Server']();clock=[0]
 def channel(method,path,body):
  reply=server(method,path,body);clock[0]=2;return reply
 report=send(value,root,forecasts,channel,max_run_seconds=1,monotonic=lambda:clock[0],attempts=5)
 print(json.dumps({'report':report,'outcome_calls':len(server.calls),'methods':[m for m,p,b in server.calls]}))
`);
  assert.equal(result.report.status,'pending_outcomes');assert.equal(result.report.reason,'intake_command_budget');
  assert.equal(result.report.intake_complete,false);assert.equal(result.outcome_calls,1);assert.deepEqual(result.methods,['GET']);
});

test('default CLI planning reads no application credentials/config and touches no network factory or immutable output writer',()=>{
  const result=py(String.raw`
class ForbiddenEnvironment(dict):
 # stdlib argparse/gettext consult locale and terminal-size configuration.
 # These aren't application credentials/config and are explicitly audited.
 allowed={'LANGUAGE','LC_ALL','LC_MESSAGES','LANG','COLUMNS','LINES'}
 reads=[]
 def get(self,key,default=None):
  assert key in self.allowed,'application environment read';self.reads.append(key);return default
 def __getitem__(self,key):
  assert key in self.allowed,'application environment read';self.reads.append(key);raise KeyError(key)
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);value,snapshots,captures=left['inputs'](root);stdout=left['io'].StringIO();env=ForbiddenEnvironment()
 with patch.object(I.os,'environ',env),patch.object(I.urllib.request,'build_opener',side_effect=AssertionError('no opener')),patch.object(I.forecast,'_immutable',side_effect=AssertionError('no write')),redirect_stdout(stdout):
  code=I.main(['--snapshots',str(snapshots),'--capture',str(captures[0])])
 print(json.dumps({'code':code,'report':json.loads(stdout.getvalue()),'has_output':(root/'delivery').exists(),
  'environment_reads':env.reads,'allowed':sorted(env.allowed)}))
`);
  assert.equal(result.code,0);assert.equal(result.report.status,'dry_run');assert.equal(result.report.writes,false);
  assert.equal(result.report.network_used,false);assert.equal(result.has_output,false);
  assert.ok(result.environment_reads.every(name=>result.allowed.includes(name)));
});

after(()=>{
  sources.forEach((name,i)=>assert.equal(createHash('sha256').update(readFileSync(ROOT+name)).digest('hex'),pins[i]));
});
