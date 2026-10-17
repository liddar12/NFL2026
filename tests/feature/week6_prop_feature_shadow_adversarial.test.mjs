// Independent reviewer regressions. Reuse ONLY the original raw fixture
// generators; never import/run/filter the author suite or change its asserts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const generatorSource=readFileSync(ROOT+'tests/feature/week6_prop_feature_shadow.test.mjs','utf8');
const fixture=generatorSource.match(/const FIXTURE = `([\s\S]*?)`;/)?.[1];
assert.ok(fixture,'Existing explicit raw fixture-generator block is required');
const HELPERS=`
import csv,io
def recapture(bundle,rows_change=None,game_change=None):
 raw={}
 for ref in bundle['manifest']['sources']:
  obs=bundle['observations'][ref['observation_id']];data=bundle['raw_objects'][obs['raw_sha256']]
  if ref['profile']==C.STATS_PROFILE and rows_change:
   rows=rows_change(list(csv.DictReader(io.StringIO(data.decode()))));out=io.StringIO(newline='')
   writer=csv.DictWriter(out,fieldnames=HEAD);writer.writeheader();writer.writerows(rows);data=out.getvalue().encode()
  if ref['profile']==C.SCOREBOARD_PROFILE and game_change:data=json.dumps(game_change(json.loads(data),ref['week'])).encode()
  raw[(ref['profile'],ref['week'])]=data
 clock=[dt.datetime.fromisoformat(bundle['manifest']['started_utc'].replace('Z','+00:00'))]
 def now():
  clock[0]+=dt.timedelta(seconds=1);return clock[0].isoformat().replace('+00:00','Z')
 return C.capture(bundle['manifest']['season'],bundle['manifest']['weeks'],
  fetcher=lambda spec:(200,{},raw[(spec['profile'],spec['week'])]),clock=now)
def attempted_collection(plan,caps):
 try:return {'doc':collect(plan,caps),'refused':False}
 except S.ShadowError as exc:return {'doc':None,'refused':True,'reason':str(exc)}
def targeted_rows(rows,field,value):
 result=[]
 for row in rows:
  if row['team']=='SEA' and row['position']=='WR':
   other=dict(row);other.update(player_id='00-SEA-WR-neighbor',player_display_name='Neighbor WR');result.append(other)
   row=dict(row);row[field]=value
  result.append(row)
 return result
def invalid_first_wr(plan):
 first=copy.deepcopy(plan);refs={}
 for obj in first['source_objects']:
  pool=obj['payload']
  if not isinstance(pool,dict) or 'players' not in pool:continue
  for player in pool['players']:
   if player.get('position')=='WR':player['player']=''
  old=obj['object_id'];obj['object_id']=E.fingerprint(pool);refs[old]=obj['object_id']
 for item in first['generations']:
  doc=item['request']['payload'];gen=doc['generations'][0]
  gen['source_snapshots']={k:refs.get(v,v)for k,v in gen['source_snapshots'].items()}
  gen['generation_id']=E.fingerprint({k:gen[k]for k in E.MANIFEST_KEYS})
  for row in doc['receipts']:
   row['generation_id']=gen['generation_id']
   if row['learning_receipt']['market']=='wr_rec_yds':row['leg']['player']=''
  doc['envelope_id']=E.fingerprint({k:v for k,v in doc.items()if k!='envelope_id'})
  item['request']['object_id']=doc['envelope_id']
 return first
def invalid_first_clock(plan):
 first=copy.deepcopy(plan)
 for item in first['generations']:
  doc=item['request']['payload']
  for row in doc['receipts']:
   if row['learning_receipt']['market']=='wr_rec_yds':
    row['learning_receipt']['forecast_created_utc']='2026-08-11T14:00:00Z'
  doc['envelope_id']=E.fingerprint({k:v for k,v in doc.items()if k!='envelope_id'})
  item['request']['object_id']=doc['envelope_id']
 return first
`;
function py(body){
 return JSON.parse(execFileSync('python3',['-'],{cwd:ROOT,input:fixture+HELPERS+body,encoding:'utf8',
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30000,maxBuffer:8*1024*1024}).trim().split('\n').pop());
}

test('explicit quarantined preweek game cannot disappear from the training denominator',()=>{
 const result=py(`
def contradict(game,week):
 if week==1:game['events'][0]['competitions'][0]['status']={'type':{'name':'STATUS_IN_PROGRESS'}}
 return game
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training()
 missing=recapture(caps[1],lambda rows:[r for r in rows if r['week']!='1'],contradict)
 result=attempted_collection(plan,[caps[0],missing]);result['audit']=missing['manifest']['audit']
 print(json.dumps(result))
`);
 assert.deepEqual(result.audit.quarantined_game_ids,['G1']);
 assert.ok(result.refused||result.doc.rows.every(r=>r.status==='withheld'),
  'Known quarantined G1 plus missing stats is UNKNOWN, not a smaller verified FINAL denominator');
});

test('known target GSIS with unknown REG metadata or changed position cannot be erased before sheet validation',()=>{
 const results=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();results=[]
 for field,value in [('season_type',''),('position','TE')]:
  current=recapture(caps[1],lambda rows:targeted_rows(rows,field,value))
  result=attempted_collection(plan,[caps[0],current]);result['case']=field;results.append(result)
 print(json.dumps(results))
`);
 for(const result of results){
  assert.ok(result.refused||result.doc.rows.filter(r=>r.position==='WR').every(r=>r.status==='withheld'),
   `${result.case}: a valid teammate's WR row does not repair the target GSIS's unverified training row`);
 }
});

test('invalid earliest original authority or its corrupted clock cannot select a later valid forecast twin',()=>{
 const results=py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);original,_,_=forecast(root/'first')
 later,_,_=forecast(root/'later',created='2026-08-11T13:00:00Z');caps=training()
 twin=collect(later,caps,recorded='2026-08-11T13:02:00Z');results=[]
 for mutate in (invalid_first_wr,invalid_first_clock):
  first=mutate(original)
  combined={'version':1,'source_objects':first['source_objects']+later['source_objects'],'generations':first['generations']+later['generations']}
  _,rejected,_,_=S.outcomes._entries(combined,2026,{6})
  try:
   doc=evaluate([twin],combined,[raw_capture(2026,[6],stamp(24))],caps)
   result={'refused':False,'doc':doc,'rejected':rejected}
  except S.ShadowError as exc:result={'refused':True,'reason':str(exc),'rejected':rejected}
  result['case']=mutate.__name__;results.append(result)
 print(json.dumps(results))
`);
 for(const result of results){
  assert.equal(result.rejected.length,1,'The earlier original WR remains explicit rejected authority');
  assert.ok(result.refused||!result.doc.rows.some(r=>r.position==='WR'),
   `${result.case}: first-forecast order cannot be inferred from rejected/unhashed original authority`);
 }
});

test('evaluation cutoff cannot enumerate shadows recorded after that cutoff or before the experiment existed',()=>{
 const result=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();doc=collect(plan,caps)
 try:
  report=S.evaluate([doc],plan,[],training_captures=caps,as_of_utc='2026-08-01T00:00:00Z',bootstrap_replicates=200)
  result={'refused':False,'selected':len(report['selected_receipt_ids']),'n':report['metrics']['n']}
 except S.ShadowError as exc:result={'refused':True,'reason':str(exc)}
 print(json.dumps(result))
`);
 assert.ok(result.refused||result.selected===0,'No outcome rows does not authorize selecting future forecast/shadow membership');
});

test('valid future-only contracts in a broader original graph cannot enter an earlier as-of cohort',()=>{
 const result=py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);first,_,_=forecast(root/'first');caps=training();twin=collect(first,caps)
 _,future_inputs,_=forecast(root/'unused-future',created='2026-08-13T12:00:00Z')
 for player in future_inputs['player_projections']['players']:
  if player['position']=='WR':player.update(gsis_id='00-FUTURE-WR',name='Future WR')
 for player in future_inputs['player_weekly']['players']:
  if player['gsis_id']=='00-SEA-WR':player['gsis_id']='00-FUTURE-WR'
 pool=P.build(future_inputs)
 schedule={'season':2026,'games':[{'game_id':'G'+str(n),'week':n,'home':'SEA','away':'LAR',
  'kickoff_utc':kickoff(n),'status':'STATUS_SCHEDULED'}for n in range(1,19)]}
 J.record(pool,schedule,None,[],'2026-08-13T12:01:00Z',str(root/'future'))
 future=E.plan(root/'future')
 plan={'version':1,'source_objects':first['source_objects']+future['source_objects'],
  'generations':first['generations']+future['generations']}
 _,rejected,_,_=S.outcomes._entries(plan,2026,{6})
 report=S.evaluate([twin],plan,[],training_captures=caps,as_of_utc='2026-08-12T12:00:00Z',bootstrap_replicates=200)
 expected=sorted(row['source_receipt_id']for row in twin['rows'])
 print(json.dumps({'rejected':rejected,'selected':sorted(report['selected_receipt_ids']),'expected':expected,
  'n':report['metrics']['n'],'exclusions':report['exclusions']}))
`);
 assert.deepEqual(result.rejected,[],'Future contract is genuine original producer output, not malformed-source fallback');
 assert.deepEqual(result.selected,result.expected,'A future original without a shadow is not earlier missing-first cohort evidence');
 assert.equal(result.n,0);
});

test('independent controls preserve intact ready shadows and ignore explicit POST rather than guessing its period',()=>{
 const result=py(`
with tempfile.TemporaryDirectory()as tmp:
 plan,_,_=forecast(pathlib.Path(tmp));caps=training();before=E.encoded(plan)
 good=collect(plan,caps)
 post=collect(plan,[caps[0],recapture(caps[1],lambda rows:targeted_rows(rows,'season_type','POST'))])
 print(json.dumps({'ready':all(r['status']=='ready'for r in good['rows']),
  'post_ready':all(r['status']=='ready'for r in post['rows']),
  'unchanged':before==E.encoded(plan),'weight':good['candidate_weight'],'activation':good['activation']}))
`);
 assert.equal(result.ready,true);assert.equal(result.post_ready,true);assert.equal(result.unchanged,true);
 assert.equal(result.weight,0);assert.equal(result.activation,false);
});
