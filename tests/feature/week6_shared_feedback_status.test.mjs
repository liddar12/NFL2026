import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {feedbackEvaluationStamp,learningLoopsCard} from '../../app/views/model.js';
import {createHash} from 'node:crypto';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ENGINE=process.env.SELFLEARN_CHECKOUT;
const SOURCE=ROOT+'scripts/shared_feedback_status.py';
const PIN=createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const hits=new Set();
const FIXTURE=String.raw`
import copy,importlib.util,json,os,pathlib,tempfile
from unittest.mock import patch
from scripts import shared_feedback_status as S,build_learning_loops as B,run_parlay_feedback as I,validate_data as V
spec=importlib.util.spec_from_file_location('fixture',pathlib.Path('tests/fixtures/week6_outcomes.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
def setup(root):
 data=root/'data';snapshots=data/'snapshots';f.generation(snapshots);f.generation(snapshots,'2026-09-01T13:00:00Z')
 captured=f.capture.save_capture(f.bundle(),root/'external');return data,snapshots,captured
def run(data,snapshots,captures,observed='2026-09-04T15:00:00Z',evaluated='2026-09-04T15:00:01Z'):
 engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=I.git(engine,'rev-parse','HEAD')
 return I.run(data_dir=data,snapshot_dir=snapshots,captures=captures,engine_checkout=engine,engine_commit=pin,
  observed_utc=observed,evaluation_clock=lambda:evaluated)
def row(data):
 doc,_=B.build(B.load_sources(data),None,'2026-09-08T00:00:00Z')
 schema=json.loads(pathlib.Path('data/contracts/learning_loops.schema.json').read_text());V.validate_against_schema(doc,schema,'learning_loops.json')
 return next(r for r in doc['loops']if r['id']=='shared_nfl_feedback')
def stage(data,status):
 path=data/'pipeline_stages.json';path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps({'workflows':{'daily':{'stages':[{'name':S.STAGE,'status':status}]}}}))
`;
function py(source){
 const trace=`import sys,pathlib,json,hashlib,atexit\nTARGET=str(pathlib.Path('scripts/shared_feedback_status.py').resolve());HITS=set()\ndef traced(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':HITS.add(frame.f_lineno)\n return traced\ndef coverage():\n sys.settrace(None)\n print('SHARED_STATUS_COVERAGE '+json.dumps({'sha256':hashlib.sha256(pathlib.Path(TARGET).read_bytes()).hexdigest(),'lines':sorted(HITS)}),file=sys.stderr)\natexit.register(coverage);sys.settrace(traced)\n`;
 const r=spawnSync('python3',['-B','-'],{cwd:ROOT,input:trace+FIXTURE+source,encoding:'utf8',
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:60000,maxBuffer:8*1024*1024});
 for(const line of r.stderr.split('\n'))if(line.startsWith('SHARED_STATUS_COVERAGE ')){
  const row=JSON.parse(line.slice(23));assert.equal(row.sha256,PIN);row.lines.forEach(n=>hits.add(n));
 }
 assert.equal(r.status,0,r.stderr+r.stdout);return JSON.parse(r.stdout.trim().split('\n').pop());
}
function requireEngine(t){
 if(!ENGINE||!existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py')){
  t.skip('Explicit SELFLEARN_CHECKOUT required for actual producer/shared-evaluation MODEL record');return false;
 }
 return true;
}

test('missing shared feedback is explicit and schema-valid without importing engine or inventing metrics',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data=pathlib.Path(tmp)/'data';stage(data,'skipped')
 with patch.object(I,'engine',side_effect=AssertionError('engine')):value=row(data)
 print(json.dumps(value))
`);
 assert.equal(r.state,'absent');assert.equal(r.last_run_utc,null);assert.equal(r.effective.state,'unknown');
 assert.match(r.why,/No saved shared feedback record/);assert.match(r.why,/SKIPPED/);
 assert.equal(r.live,undefined);
});

test('latest actual R88 daily or gameday attempt wins; a new unfinished run cannot reuse an old success',()=>{
 const r=py(String.raw`
from scripts import stage_status as T
with tempfile.TemporaryDirectory() as tmp:
 data=pathlib.Path(tmp);path=data/'pipeline_stages.json';rows=[]
 def inspect(doc):
  path.write_text(json.dumps(doc));return S.stage_status(data)
 def completed(doc,workflow,status,start,finish):
  doc=T.begin(doc,workflow,'synthetic-'+workflow,now=start)
  return T.record(doc,workflow,S.STAGE,0 if status=='ok'else 2,start,finish,
   continue_on_error=True,now=finish)
 a='2026-10-17T12:00:00Z';b='2026-10-17T12:01:00Z';c='2026-10-17T13:00:00Z';d='2026-10-17T13:01:00Z'
 doc=completed(None,'daily','ok',a,b)
 doc=completed(doc,'gameday','failed',c,d);rows.append(inspect(doc))
 value=S.derive({'status':'absent','stage':rows[-1]})
 assert 'FAILED'in value['why']and value['last_run_utc']is None and 'live'not in value
 doc=completed(doc,'daily','ok','2026-10-17T14:00:00Z','2026-10-17T14:01:00Z');rows.append(inspect(doc))
 doc=T.begin(doc,'gameday','synthetic-new',now='2026-10-17T15:00:00Z');rows.append(inspect(doc))
 doc=T.skip(doc,'gameday',S.STAGE,'Disabled; no shared evaluation ran',now='2026-10-17T15:02:00Z')
 doc=T.record(doc,'gameday','Learning loops record (MODEL tab)',0,'2026-10-17T15:03:00Z','2026-10-17T15:04:00Z',now='2026-10-17T15:04:00Z')
 rows.append(inspect(doc))
 doc={'workflows':{'daily':{'stages':[]},'backtest':{'stages':[]}}};rows.append(inspect(doc))
 print(json.dumps(rows))
`);
 assert.deepEqual(r,['failed','ok','not_recorded','skipped','not_recorded']);
});

test('unorderable, contradictory or malformed attempt clocks fail closed instead of choosing a success',()=>{
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data=pathlib.Path(tmp);path=data/'pipeline_stages.json';rows=[]
 def inspect(doc):
  path.write_text(json.dumps(doc));return S.stage_status(data)
 def block(status='ok',start='2026-10-17T12:00:00Z',end='2026-10-17T12:01:00Z'):
  return {'run_started_utc':start,'run_finished_utc':end,'stages':[{'name':S.STAGE,'status':status,'started_utc':start,'finished_utc':end}]}
 base={'workflows':{'daily':block(),'gameday':block('failed')}}
 rows.append(inspect(base))
 same=copy.deepcopy(base);same['workflows']['gameday']['stages'][0]['status']='ok';rows.append(inspect(same))
 legacy={'stages':[{'name':S.STAGE,'status':'failed'}]}
 rows.append(inspect({'workflows':{'daily':legacy}}))
 rows.append(inspect({'workflows':{'daily':legacy,'gameday':block()}}))
 faults=[]
 for fault in ('workflow_type','block_type','rows_type','duplicate','bad_status','naive','run_reversed','stage_reversed','stage_before_run','end_before_run','end_after_run','unfinished'):
  doc={'workflows':{'daily':block()}};b=doc['workflows']['daily'];row=b['stages'][0]
  if fault=='workflow_type':doc['workflows']=[]
  elif fault=='block_type':doc['workflows']['daily']=None
  elif fault=='rows_type':b['stages']={}
  elif fault=='duplicate':b['stages'].append(copy.deepcopy(row))
  elif fault=='bad_status':row['status']='OWNER_APPROVED'
  elif fault=='naive':row['finished_utc']='2026-10-17T12:01:00'
  elif fault=='run_reversed':b['run_finished_utc']='2026-10-17T11:00:00Z'
  elif fault=='stage_reversed':row['started_utc']='2026-10-17T12:02:00Z'
  elif fault=='stage_before_run':row['started_utc']='2026-10-17T11:59:00Z'
  elif fault=='end_before_run':row['started_utc']=None;row['finished_utc']='2026-10-17T11:59:00Z'
  elif fault=='end_after_run':row['finished_utc']='2026-10-17T12:02:00Z'
  elif fault=='unfinished':row['finished_utc']=None
  faults.append(inspect(doc))
 rows.append(inspect({'workflows':{'backtest':{'stages':[]}}}))
 print(json.dumps({'ordered':rows,'faults':faults}))
`);
 assert.deepEqual(r.ordered,['unreadable','ok','failed','unreadable','not_recorded']);
 assert.deepEqual(r.faults,Array(12).fill('unreadable'));
});

test('actual feedback shows canonical versus vintage counts, held-out absence, corrections and saved timestamps',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[],'2026-09-01T15:00:00Z','2026-09-01T15:00:01Z');warm=row(data)
 run(data,snapshots,[captured]);stage(data,'ok');graded=row(data)
 correction=f.capture.save_capture(f.bundle(value='0',observed='2026-09-05T12:00:00Z'),pathlib.Path(tmp)/'correction')
 run(data,snapshots,[correction],'2026-09-06T15:00:00Z','2026-09-06T15:00:01Z');corrected=row(data)
 print(json.dumps({'warm':warm,'graded':graded,'corrected':corrected}))
`);
 assert.match(r.warm.live,/4 receipt vintages; 0 unique graded legs; 0 held-out comparison legs/);
 assert.match(r.graded.live,/4 receipt vintages; 2 unique graded legs; 0 held-out comparison legs/);
 assert.match(r.graded.live,/Brier incumbent\/candidate unavailable\/unavailable/);
 assert.match(r.corrected.live,/4 appended per-receipt correction revisions \(not additional samples\)/);
 assert.match(r.corrected.live,/2 unique graded legs/);
 assert.equal(r.graded.state,'measuring');assert.match(r.graded.why,/HOLD:/);
 assert.equal(r.graded.effective.state,'measure_only');assert.match(r.graded.why,/public offering time unverified/);
 assert.equal(r.graded.last_run_utc,'2026-09-04T15:00:01Z');
 const html=learningLoopsCard({loops:[r.graded],transitions:[]},Date.parse('2026-09-04T16:00:01Z'));
 assert.match(html,/saved record: 4 receipt vintages/);assert.ok(!html.includes('live: 4 receipt vintages'));
 assert.match(html,/1h ago/);assert.match(html,/CDT/);assert.match(html,/MEASURE ONLY/);
});

test('failed/skipped/unreadable attempts preserve old evaluation time and never become fresh success or adoption',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[captured]);rows=[]
 for status in ('failed','skipped','OWNER_APPROVED'):
  stage(data,status);rows.append(row(data))
 print(json.dumps(rows))
`);
 assert.match(r[0].why,/FAILED; saved results are not a fresh success/);
 assert.match(r[1].why,/SKIPPED or disabled/);assert.match(r[2].why,/could not be verified/);
 for(const row of r){assert.equal(row.last_run_utc,'2026-09-04T15:00:01Z');assert.equal(row.state,'measuring');assert.equal(row.effective.state,'measure_only');}
});

test('missing raw evidence or a malformed report withholds all status metrics rather than displaying zero',t=>{
 if(!requireEngine(t))return;
 const r=py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
 data,snapshots,captured=setup(pathlib.Path(tmp));run(data,snapshots,[captured]);stage(data,'failed')
 path=next((data/'snapshots/learning_outcomes/objects').glob('*.bin'));park=path.with_suffix('.park');path.rename(park)
 missing=row(data);park.rename(path)
 root=data/'snapshots/learning_feedback';p,state=I.previous(data,root);good=I.read_json(I.artifact(root,'evaluations',p['evaluation_id']));rows=[]
 for change in ('hash','bool_count','nonfinite','inconsistent_gate'):
  bad=copy.deepcopy(good)
  if change=='hash':bad['report']['report_id']='sha256:'+'0'*64
  elif change=='bool_count':bad['report']['metrics']['n']=True
  elif change=='nonfinite':bad['report']['metrics']['candidate_brier']=float('nan')
  else:bad['report']['proposed_shared_return_gate']['passed']=True
  if change!='hash':bad['report']['report_id']=I.export.fingerprint({k:v for k,v in bad['report'].items()if k!='report_id'})if change!='nonfinite'else bad['report']['report_id']
  read=I.read_json
  def response(path):return bad if '/evaluations/'in str(path)else read(path)
  with patch.object(I,'validate_records',return_value=True),patch.object(I,'previous',return_value=(p,state)),patch.object(I,'read_json',side_effect=response):rows.append(S.derive(S.load(data)))
 print(json.dumps({'missing':missing,'rows':rows}))
`);
 for(const row of [r.missing,...r.rows]){assert.equal(row.state,'absent');assert.match(row.why,/integrity could not be verified/);assert.equal(row.live,undefined);assert.equal(row.last_run_utc,null);}
});

test('a synthetic passed numeric gate stays shadow and cannot authorize model adoption',()=>{
 const r=py(String.raw`
# UI-only synthetic pass, not measured accuracy or owner authority.
value={'status':'saved_shadow','stage':'ok','evaluation_utc':'2026-10-16T12:00:00Z','state_id':'sha256:'+'1'*64,
 'receipt_vintages':500,'corrections':3,'latest_forecast_utc':None,
 'report':{'cohort_n':120,'metrics':{'n':100,'incumbent_brier':.2,'candidate_brier':.19,'incumbent_log_loss':.5,'candidate_log_loss':.49},
 'proposed_shared_return_gate':{'passed':True,'failures':[]},'excluded':{}}}
print(json.dumps(S.derive(value)))
`);
 assert.equal(r.state,'measuring');assert.equal(r.effective.state,'measure_only');
 assert.match(r.why,/Numeric gate passed; candidate remains shadow and requires explicit approval/);
 assert.match(r.why,/not proof of future accuracy/);assert.ok(!JSON.stringify(r).includes('"adopted"'));
});

test('saved evaluation clock rejects missing/naive/future evidence and renders Chicago DST with actual age',()=>{
 const now=Date.parse('2026-10-16T18:00:00Z');
 for(const input of [null,0,true,'not-a-time','2026-10-16T18:00:00'])assert.match(feedbackEvaluationStamp(input,now),/no verified/);
 assert.match(feedbackEvaluationStamp('2026-10-16T19:00:00Z',now),/future timestamp; age unverified/);
 assert.ok(!feedbackEvaluationStamp('2026-10-16T19:00:00Z',now).includes('0m ago'));
 assert.match(feedbackEvaluationStamp('2026-10-16T17:00:00Z',now),/CDT.*1h ago/);
 assert.match(feedbackEvaluationStamp('2026-12-16T17:00:00Z',Date.parse('2026-12-16T18:00:00Z')),/CST.*1h ago/);
 const original=Intl.DateTimeFormat;
 try {
  Intl.DateTimeFormat=function(){throw new RangeError('timezone unavailable');};
  assert.match(feedbackEvaluationStamp('2026-10-16T17:00:00Z',now),/local timezone unavailable.*1h ago/);
 } finally {Intl.DateTimeFormat=original;}
 const row={id:'shared_nfl_feedback',group:'measure',state:'measuring',name:'<script>',why:'<img src=x>',live:'<svg>',last_run_utc:'bad'};
 const html=learningLoopsCard({loops:[row]},now);
 assert.ok(!html.includes('<script>')&&!html.includes('<img src=x>')&&!html.includes('<svg>'));
 assert.match(html,/no verified evaluation timestamp/);
});

after(()=>{
 assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'),PIN);
 const r=spawnSync('python3',['-c','import json,sys,trace;print(json.dumps(sorted(n for n in trace._find_executable_linenos(sys.argv[1])if n>0)))',SOURCE],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const all=new Set([...JSON.parse(r.stdout),...hits]);
 console.log(JSON.stringify({source:'scripts/shared_feedback_status.py',sha256:PIN,covered:hits.size,total:all.size,
  percent:100*hits.size/all.size,missing:[...all].filter(n=>!hits.has(n)).sort((a,b)=>a-b),scope:'saved feedback and UI mechanics; no browser, serving activation or accuracy evidence'}));
 if(ENGINE&&existsSync(ENGINE+'/packages/selflearn-core/selflearn_core/adapters/nfl_file_feedback.py'))assert.ok(100*hits.size/all.size>=90,'Complete saved-feedback status must exceed 90% line coverage');
});
