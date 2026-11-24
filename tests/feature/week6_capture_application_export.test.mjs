import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = ROOT + 'scripts/export_capture_application.py';
const sourceHash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const covered = new Set();
// Exact wire fixtures, explicitly not SQL, hosted or provider-authentication proof.
const FIXTURE = `
import base64,copy,http.client,io,json,os,pathlib,runpy,tempfile,threading,urllib.error,urllib.parse
from contextlib import redirect_stdout,redirect_stderr
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from scripts import export_capture_application as A, export_outcome_capture as O,export_learning as ex,capture_outcome_evidence as C
f=runpy.run_path('tests/fixtures/week6_outcomes.py')
TOKEN='synthetic-outcome-only-not-owner-or-generation'
def fixture(root,large=False,include_roster=False):
 b=f['bundle'](stats_rows=[f['stats_row']()]*33000 if large else None,include_roster=include_roster)
 path=C.save_capture(b,root/'capture-authority');return A.plan(path,A.ORIGIN),b,path
def hashit(v,k):v[k]=ex.fingerprint({n:x for n,x in v.items()if n!=k});return v
def sealed(request,sizes=(2,2),held=(),void=False,game_id='G1'):
 old=request['capture_request'];env=old['envelope'];groups=[];game_scope=request.get('game_scope')
 byprofile={v['profile']:(k,v)for k,v in env['observations'].items()}
 def component(profile,name):
  oid,obs=byprofile[profile];return {'source':name,'observation_id':oid,'observed_utc':obs['observed_utc']}
 for i,size in enumerate(sizes):
  scope=[2026,game_id,'fixture-player-'+str(i),'wr_rec_yds','home']
  mem={'scope':scope,'receipt_ids':sorted(ex.fingerprint('r'+str(i)+'-'+str(n))for n in range(size)),
   'source_receipt_ids':sorted(ex.fingerprint('s'+str(i)+'-'+str(n))for n in range(size)),
   'generation_object_ids':[ex.fingerprint('generation'+str(i))]}
  sources={'espn.scoreboard':component(C.SCOREBOARD_PROFILE,'espn.scoreboard')}
  sources['nflverse.snap_counts'if void else'nflverse.stats_player']=component(C.SNAPS_PROFILE if void else C.STATS_PROFILE,'nflverse.snap_counts'if void else'nflverse.stats_player')
  if C.ROSTERS_PROFILE in byprofile:
   sources['nflverse.rosters']=component(C.ROSTERS_PROFILE,'nflverse.rosters')
  fact={'week':6,'actual':None if void else 80.0,'played':not void,'status':'VOID'if void else'FINAL',
   'reason':'did_not_play'if void else None,'participation_basis':'r106_team_snap_absence_inference'if void else'stat_row',
   'game':{'season':2026,'week':6,'game_id':game_id,'kickoff_utc':f['KICKOFF'],'home':'SEA','away':'LAR','state':'FINAL'},'source_observations':sources}
  h=i in held or size>500
  groups.append({'group_id':ex.fingerprint(scope),**mem,'membership_id':ex.fingerprint({'binding_policy':A.BINDING,**mem}),
   'status':'withheld'if h else'planned','reason_codes':['missing_measurement']if h else[],
   'batch_ordinal':None,'fact':None if h else fact,'fact_id':None if h else ex.fingerprint(fact)})
 groups.sort(key=lambda g:g['group_id']);batches=[]
 for g in groups:
  if g['status']=='planned':
   n=len(batches);g['batch_ordinal']=n;batches.append({'ordinal':n,'step_id':A.step_id(request['application_id'],n),'group_ids':[g['group_id']],'member_count':len(g['receipt_ids'])})
 members={'binding_policy':A.BINDING,'groups':[g['membership_id']for g in groups]}
 if game_scope is not None:members['game_scope_id']=ex.fingerprint(game_scope)
 seal={'version':2,'kind':'nfl.capture_application_seal.v2','application_id':request['application_id'],'request_id':ex.fingerprint(request),
  'capture_intent_id':A.capture_intent_id(request),'capture_id':old['capture_id'],'execution_policy':A.POLICY,'binding_policy':A.BINDING,
  'season':2026,'weeks':[6],'source_watermark':'10','membership_id':ex.fingerprint(members),
  'source_vector_id':A.vector(env,game_scope),'limits':{'members':500,'observations':500,'revisions':500,'rpc_bytes':8388608},'groups':groups,'batches':batches}
 if game_scope is not None:seal['game_scope']=game_scope
 return hashit(seal,'seal_id')
def held_result(g,reasons=None):
 return {k:copy.deepcopy(g[k])for k in('group_id','scope','receipt_ids','source_receipt_ids','generation_object_ids','membership_id')}|{
  'status':'withheld','reason_codes':g['reason_codes']if reasons is None else reasons,'observation_ids':[],'revision_ids':[]}
def registration(seal):
 v={'version':2,'kind':'nfl.capture_application_registration.v2',**{k:seal[k]for k in A.IDENTITIES},'status':'registered',
  'group_count':len(seal['groups']),'member_count':sum(len(g['receipt_ids'])for g in seal['groups']),'batch_count':len(seal['batches']),
  'next_step_id':seal['batches'][0]['step_id']if seal['batches']else None,'source_watermark':seal['source_watermark'],'application_seq':'1',
  'recorded_utc':'2026-09-03T15:00:00Z','scope':'sealed_application_only','durable':True,'learning_accepted':False,'source_authentication':'not_performed'}
 return hashit(v,'registration_id')
def terminal(app,cause=None):
 s,groups,batches=app['seal'],app['groups'],app['batches'];count={k:0 for k in A.COUNTS}
 count.update(groups=len(groups),members=sum(len(g['sealed_group']['receipt_ids'])for g in groups),batches=len(batches),committed_batches=sum(b['result']is not None and b['result']['status']=='committed'for b in batches))
 for row in groups:
  g=row['sealed_group'];p='accepted'if row['result']['status']=='accepted'else'withheld';count[p+'_groups']+=1;count[p+'_members']+=len(g['receipt_ids'])
  if row['execution_state']=='not_applied':count['not_applied_groups']+=1;count['not_applied_members']+=len(g['receipt_ids'])
 state='incomplete_membership_changed'if cause=='membership'else'incomplete_integrity_or_capacity'if cause else'no_supported_membership'if not groups else'accepted'if count['accepted_groups']==len(groups)else'partial'if count['accepted_groups']else'withheld'
 reasons=['application_membership_changed']if cause=='membership'else['source_integrity_failed']if cause else[]
 seq=max([1]+[int(b['result']['application_seq'])for b in batches if b['result']is not None])+1
 v={'version':2,'kind':'nfl.capture_application_result.v2',**{k:s[k]for k in A.IDENTITIES},'status':state,'reason_codes':reasons,
  'current_membership_id':ex.fingerprint('changed-membership')if cause=='membership'else s['membership_id'],'group_report_id':ex.fingerprint(groups),'counts':count,
  'registered_watermark':s['source_watermark'],'watermark':str(max([10]+[int(b['result']['watermark'])for b in batches if b['result']is not None])),
  'application_seq':str(seq),'recorded_utc':'2026-09-03T15:01:00Z','processing_complete':state in A.NORMAL,'complete_success':state=='accepted',
  'learning_accepted':bool(count['accepted_groups']),'durable':True,'scope':'application_group_results','source_authentication':'not_performed'}
 return hashit(v,'terminal_result_id')
class Server:
 def __init__(self,**kwargs):
  self.kwargs=kwargs;self.app=None;self.calls=[];self.history={};self.lose_register=self.lose_step=False;self.lock=threading.Lock();self.mutate=None
 def record(self):
  a=self.app;s=a['seal'];t=a['terminal'];done=[b for b in a['batches']if b['result']is not None];fence=t['application_seq']if t else str(len(done)+1)
  a['ledger_watermark']=fence
  a['status']={'version':2,'kind':'nfl.capture_application_status.v2','application_id':s['application_id'],'registration_id':a['registration']['registration_id'],
   'seal_id':s['seal_id'],'membership_id':s['membership_id'],'status':'terminal'if t else'active','batch_count':len(a['batches']),
   'committed_batches':sum(b['result']['status']=='committed'for b in done),'next_step_id':None if t else next(b['assignment']['step_id']for b in a['batches']if b['result']is None),
   'terminal_result_id':None if not t else t['terminal_result_id'],'ledger_watermark':fence,'scope':'pinned_application_progress','durable_ack':False,'execution_ready':t is None,'source_authentication':'not_performed'}
  self.history[fence]=copy.deepcopy(a)
 def register(self,q):
  s=sealed(q,**self.kwargs);self.app={'request':q,'seal':s,'registration':registration(s),
   'groups':[{'sealed_group':g,'execution_state':'initial_withheld'if g['status']=='withheld'else'pending','result':held_result(g)if g['status']=='withheld'else None}for g in s['groups']],
   'batches':[{'assignment':b,'result':None}for b in s['batches']],'terminal':None}
  if not s['batches']:self.app['terminal']=terminal(self.app)
  self.record()
 def commit(self,sid,cause=None):
  a=self.app;s=a['seal'];slot=next(b for b in a['batches']if b['assignment']['step_id']==sid)
  if slot['result']is not None:return slot['result']
  groups=[]
  for gid in slot['assignment']['group_ids']:
   g=next(g for g in s['groups']if g['group_id']==gid);r=held_result(g,['application_membership_changed']if cause else[])
   if not cause:r.update(status='accepted',observation_ids=sorted(ex.fingerprint('obs-'+rid)for rid in g['receipt_ids']),revision_ids=sorted('rev-'+rid for rid in g['receipt_ids']))
   groups.append(r)
  low=max([10]+[int(b['result']['watermark'])for b in a['batches']if b['result']is not None]);n=0 if cause else sum(len(g['receipt_ids'])for g in groups)
  v={'version':2,'kind':'nfl.capture_application_batch_result.v2','application_id':s['application_id'],'step_id':sid,'ordinal':slot['assignment']['ordinal'],
   'seal_id':s['seal_id'],'membership_id':s['membership_id'],'status':'not_applied'if cause else'committed','groups':groups,'added_observations':n,'added_revisions':n,
   'input_watermark':str(low),'watermark':str(low+2*n),'application_seq':str(slot['assignment']['ordinal']+2),'recorded_utc':'2026-09-03T15:00:30Z',
   'durable':True,'scope':'observations_and_batch_results','source_authentication':'not_performed'}
  slot['result']=hashit(v,'batch_result_id')
  for row in a['groups']:
   match=next((g for g in groups if g['group_id']==row['sealed_group']['group_id']),None)
   if match:row.update(execution_state='not_applied'if cause else'committed',result=match)
   elif cause and row['execution_state']=='pending':row.update(execution_state='not_applied',result=held_result(row['sealed_group'],['application_membership_changed']))
  if cause or all(b['result']is not None for b in a['batches']):a['terminal']=terminal(a,cause)
  self.record();return slot['result']
 def __call__(self,method,path,body):
  with self.lock:
   self.calls.append((method,path,body));parsed=urllib.parse.urlsplit(path)
   if method=='GET':
    if self.app is None:return 404,b''
    options=dict(urllib.parse.parse_qsl(parsed.query));view=options.get('view','batch');fence=options.get('ledger_watermark',self.app['ledger_watermark']);a=self.history[fence];s=a['seal']
    if view=='registration':rows=[{'request':a['request'],'seal_header':{k:v for k,v in s.items()if k not in('groups','batches')},'registration':a['registration']}]
    elif view in('groups','batches'):rows=a[view]
    elif view=='batch':rows=[b['result']for b in a['batches']if urllib.parse.unquote(parsed.path.rsplit('/',1)[1])==b['assignment']['step_id']and b['result']is not None]
    else:rows=[]if a[view]is None else[a[view]]
    after=options.get('after');cursor=lambda row:row['sealed_group']['group_id']if view=='groups'else str(row['assignment']['ordinal'])
    start=next(i+1 for i,r in enumerate(rows)if cursor(r)==after)if after is not None else 0
    selected=rows[start:start+1];next_after=cursor(selected[-1])if view in('groups','batches')and start+len(selected)<len(rows)else None
    page={'version':2,'kind':'nfl.capture_application_page.v2','found':True,'application_id':s['application_id'],'view':view,'ledger_watermark':fence,
     'registration_id':a['registration']['registration_id'],'seal_id':s['seal_id'],'records':copy.deepcopy(selected),'total_records':len(rows),'next_after':next_after}
    if self.mutate:self.mutate(page)
    return 200,ex.encoded(page)
   q=ex._json(body)
   if path==O.CHUNK_ROUTE:
    raw=base64.b64decode(q['data'],validate=True);assert O._raw_hash(raw)==q['chunk_id']
    return 200,ex.encoded({'version':1,'kind':'selflearn.evidence_stage.v1','scope':'uploaded_only','bucket':'fake-private','key':'fake-key',
     'chunk_id':q['chunk_id'],'raw_bytes':q['raw_bytes'],'learning_accepted':False,'durable_ack':False})
   if path==A.BASE:
    if self.app is None:self.register(q)
    if self.lose_register:self.lose_register=False;raise TimeoutError('SECRET lost register')
    return 200,ex.encoded({'version':2,'registration':self.app['registration'],'scope':'registration_only','learning_accepted':False})
   assert q=={}
   result=self.commit(urllib.parse.unquote(parsed.path.rsplit('/',1)[1]))
   if self.lose_step:self.lose_step=False;raise TimeoutError('SECRET lost step')
   return 200,ex.encoded({'version':2,'result':result,'scope':'batch_only'})
def send(p,root,server,**kw):return A.send(p,root,TOKEN,transport=server,sleep=lambda _:None,**kw)
def error(fn):
 try:fn()
 except Exception:return True
 return False
`;

function py(body) {
  const code = `import sys,json,pathlib\nTARGET=str(pathlib.Path('scripts/export_capture_application.py').resolve());LINES=set()\ndef trace(frame,event,arg):\n if frame.f_code.co_filename!=TARGET:return None\n if event=='line':LINES.add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':sorted(LINES)}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, input: code, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n');
  for (const line of JSON.parse(lines.pop()).__trace__) covered.add(line);
  return JSON.parse(lines.pop());
}

test('default dry-run and explicit prepare preserve v1 IDs and raw clocks without credentials or network', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);get=os.environ.get;stdout=io.StringIO()
 def env(key,*args):assert not key.startswith('SELFLEARN');return get(key,*args)
 with mock.patch.object(os.environ,'get',side_effect=env),mock.patch.object(A,'http_transport',side_effect=AssertionError('no HTTP')),redirect_stdout(stdout):
  code=A.main(['--capture',str(path),'--base-url',A.ORIGIN]);prepared=A.prepare(p,root/'prepared')
 print(json.dumps({'code':code,'dry':json.loads(stdout.getvalue()),'prepared':prepared,'v1':p['request']['capture_request']==O.plan(path,O.ORIGIN)['request'],
  'manifest':p['request']['capture_request']['envelope']['manifest']==b['manifest'],'files':len(list((root/'prepared').rglob('*.json')))}))
`);
  assert.equal(r.code, 0); assert.equal(r.dry.network_used, false); assert.equal(r.dry.writes, false);
  assert.equal(r.prepared.learning_accepted, false); assert.equal(r.prepared.scope, 'prepared_only');
  assert.equal(r.v1, true); assert.equal(r.manifest, true); assert.equal(r.files, 1);
});

test('complete pinned server assignments drive bounded empty commands and immutable terminal cohort', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root,large=True);s=Server();r=send(p,root/'out',s,max_steps=2)
 posts=[(route,body)for method,route,body in s.calls if method=='POST'];staged=[ex._read(x)for x in(root/'out').rglob('staging/*.json')]
 print(json.dumps({'r':r,'step_bodies':[body.decode()for route,body in posts if'/steps/'in route],
  'max':max(len(body)for route,body in posts),'registration':len(list((root/'out').rglob('registration/original.json'))),
  'steps':len(list((root/'out').rglob('steps/*/original.json'))),'terminal':len(list((root/'out').rglob('terminal/original.json'))),
  'staged':all(x['learning_accepted']is False and x['durable_ack']is False for x in staged),'raw_bytes':p['capture_plan']['raw_bytes']}))
`);
  assert.equal(r.r.status, 'terminal_original'); assert.equal(r.r.complete_success, true); assert.equal(r.r.current_membership_reverified, false);
  assert.deepEqual(r.step_bodies, ['{}', '{}']); assert.ok(r.max < 3 * 1024 * 1024); assert.ok(r.raw_bytes > 1024 * 1024);
  assert.equal(r.registration, 1); assert.equal(r.steps, 2); assert.equal(r.terminal, 1); assert.equal(r.staged, true);
});

test('lost register and step replies recover original IDs; explicit resume works with missing raw bytes', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root,include_roster=True);s=Server();s.lose_register=s.lose_step=True
 first=send(p,root/'out',s);original=copy.deepcopy(first);n=len(s.calls)
 roster=C.source_observation(b,C.ROSTERS_PROFILE)
 staged=sum(m=='POST' and route==O.CHUNK_ROUTE and ex._json(body)['chunk_id']==roster['raw_sha256'] for m,route,body in s.calls)
 for raw in(path.parent.parent/'objects').glob('*.bin'):raw.unlink()
 with mock.patch.object(O,'_validated',side_effect=AssertionError('no raw reopen')):
  second=A.resume(root/'out',p['request']['application_id'],A.ORIGIN,TOKEN,transport=s,sleep=lambda _:None)
 print(json.dumps({'first':first['status'],'same':second==original,'replay_get_only':all(m=='GET'for m,_,_ in s.calls[n:]),
  'register_posts':sum(m=='POST'and route==A.BASE for m,route,_ in s.calls),'roster_staged':staged,
  'step_ids':[route.rsplit('/',1)[1]for m,route,_ in s.calls if m=='POST'and'/steps/'in route]}))
`);
  assert.equal(r.first, 'terminal_original'); assert.equal(r.same, true); assert.equal(r.replay_get_only, true);
  assert.equal(r.register_posts, 1); assert.equal(new Set(r.step_ids).size, 2); assert.equal(r.step_ids.length, 2);
  assert.equal(r.roster_staged, 1);
});

test('fresh runner resumes the registered outcome from IDs and rejects a mismatched request', () => {
  const r = py(`
import shutil
from scripts import run_scheduled_outcomes as scheduled
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);p,_,path=fixture(root,include_roster=True);s=Server()
 first=send(p,root/'out',s,max_steps=1)
 assert first['status']=='pending'
 pointer=scheduled.capture_pointer(p, '101', '2')
 assert set(pointer)=={'version','application_id','request_id','run_id','run_attempt'}
 shutil.rmtree(root/'out');shutil.rmtree(path.parent.parent)
 aid=pointer['application_id'];rid=pointer['request_id'];n=len(s.calls)
 wrong=error(lambda:A.resume_registered(aid,ex.fingerprint('different request'),TOKEN,transport=s))
 assert all(m=='GET' for m,_,_ in s.calls[n:])
 n=len(s.calls);s.lose_step=True
 final=A.resume_registered(aid,rid,TOKEN,transport=s,sleep=lambda _:None)
 changes=[(m,path) for m,path,_ in s.calls[n:] if m=='POST'];n=len(s.calls)
 replay=A.resume_registered(aid,rid,TOKEN,transport=s)
 missing=error(lambda:A.resume_registered(aid,rid,TOKEN,transport=Server()))
 schedule={'season':2026,'games':[{'status':'STATUS_FINAL','week':6,'kickoff_utc':'2026-09-02T00:00Z'},
  {'status':'STATUS_SCHEDULED','week':7,'kickoff_utc':'2026-09-03T00:00:00Z'},
  {'status':'STATUS_FINAL','week':1,'kickoff_utc':'2026-08-01T00:00:00Z'}]}
 period=scheduled.recent_period(schedule,C._instant('2026-09-05T00:00:00Z'))
 print(json.dumps({'wrong':wrong,'final':final['complete_success'],'same':final==replay,'writes':changes,
  'replay_read_only':all(m=='GET' for m,_,_ in s.calls[n:]),'missing':missing,'period':period}))
`);
  assert.equal(r.wrong, true); assert.equal(r.final, true); assert.equal(r.same, true);
  assert.equal(r.writes.length, 1); assert.match(r.writes[0][1], /\/steps\//);
  assert.equal(r.replay_read_only, true); assert.equal(r.missing, true);
  assert.deepEqual(r.period, [2026, [6]]);
});

test('scheduled recovery reports missing registration and redacts unrecognized diagnostics', () => {
  const r = py(`
from scripts import run_scheduled_outcomes as scheduled
with tempfile.TemporaryDirectory() as tmp:
 root = pathlib.Path(tmp)
 plan, _, _ = fixture(root)
 pointer = scheduled.capture_pointer(plan, '101', '2')
 folder = root/'selflearning-outcome-pointer'
 folder.mkdir()
 (folder/'pointer.json').write_text(json.dumps(pointer))
 env = {'RUNNER_TEMP': tmp, 'NFL_SELFLEARN_OUTCOME_MODE': 'record',
        'GITHUB_REPOSITORY': 'liddar12/NFL2026', 'GITHUB_REF': 'refs/heads/main',
        'OUTCOME_SOURCE_RUN_ID': '101', 'OUTCOME_SOURCE_RUN_ATTEMPT': '2',
        scheduled.TOKEN: TOKEN}
 server = Server()
 resume = A.resume_registered
 results = []
 with mock.patch.object(scheduled.handoff.forecast.capture, 'disabled_config'):
  for side_effect in (lambda *args: resume(*args, transport=server), A.ApplicationExportError(TOKEN)):
   with mock.patch.object(A, 'resume_registered', side_effect=side_effect), redirect_stdout(io.StringIO()) as stream:
    exit_code = scheduled.run('recover', env=env)
   content = stream.getvalue()
   assert TOKEN not in content
   results.append([exit_code, json.loads(content)])
 print(json.dumps({'results': results, 'methods': [method for method, _, _ in server.calls]}))
`);
  assert.deepEqual(r.results, [
    [1, { status: 'pending', reason: 'application_original_registration_missing', adoption_approved: false }],
    [1, { status: 'pending', reason: 'application_protocol_refused', adoption_approved: false }],
  ]);
  assert.deepEqual(r.methods, ['GET']);
});

test('one scoped outcome application keeps legacy authority, distinct identities and pinned recovery', () => {
  const r = py(`
from scripts import run_scheduled_outcomes as scheduled
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);legacy,bundle,path=fixture(root,include_roster=True)
 schedule={'season':2026,'games':[{'game_id':'G1','week':6,'kickoff_utc':f['KICKOFF'],
                                  'status':'STATUS_FINAL','home':'SEA','away':'LAR'}]}
 now=C._instant('2026-09-05T00:00:00Z')
 scope,game=scheduled.recent_game(schedule,now,'G1')
 scheduled._verify_selected_final(bundle,scope,game)
 missing={**game,'game_id':'G2'}
 assert scheduled.automatic_selection([game,missing],bundle)==(['G1'],1)
 assert error(lambda:scheduled.automatic_selection([game,game],bundle))
 p=A.plan(path,A.ORIGIN,scope=scope)
 q=A.plan(path,A.ORIGIN,scope={**scope,'game_id':'G2'})
 assert p['capture_plan']==q['capture_plan']==legacy['capture_plan']
 request=p['request'];original=request['capture_request']
 assert request['application_id']==ex.fingerprint({'version':2,'kind':'nfl.capture_application.v2',
  'capture_intent_id':original['delivery_id'],'execution_policy':A.POLICY,'game_scope':scope})
 assert A.capture_intent_id(request)==ex.fingerprint({'capture_intent_id':original['delivery_id'],'game_scope':scope})
 assert len({x['request']['application_id'] for x in (p,q,legacy)})==3
 assert len({A.capture_intent_id(x['request']) for x in (p,q,legacy)})==3
 assert A.vector(original['envelope'],scope)!=A.vector(original['envelope'])
 bad=[{**request,'game_scope':None},{**request,'game_scope':{**scope,'game_id':'G2'}},
      {**request,'game_scope':{**scope,'season':2025}},{**request,'game_scope':{**scope,'week':7}}]
 assert all(error(lambda:A.route_valid('POST',A.BASE,ex.encoded(row))) for row in bad)
 assert error(lambda:A.seal_valid(sealed(request,game_id='G2',held=(0,1)),request))
 assert error(lambda:scheduled.recent_game(schedule,now,'../../elsewhere'))
 assert error(lambda:scheduled.recent_game(schedule,now,'G2'))
 assert error(lambda:scheduled._verify_selected_final(bundle,scope,{**game,'home':'LAR'}))
 pointer=scheduled.capture_pointer(p,'101','2')
 server=Server();timeouts=[]
 def channel(destination,token,**kwargs):
  timeouts.append((kwargs.get('timeout',50),kwargs.get('scoped',False)))
  return server
 malformed={**p,'request':{**p['request'],'game_scope':None}}
 with mock.patch.object(A,'http_transport',side_effect=channel):
  assert error(lambda:A.send(malformed,root/'malformed',TOKEN)) and not timeouts
  first=A.send(p,root/'out',TOKEN,max_steps=1)
 assert timeouts==[(135,True)]
 assert first['status']=='pending'
 offset=len(server.calls)
 timeouts.clear()
 with mock.patch.object(A,'http_transport',side_effect=channel):
  assert error(lambda:A.resume_registered(pointer['application_id'],pointer['request_id'],TOKEN,game_id='G2'))
 assert timeouts==[(50,False)]
 assert all(method=='GET' for method, _, _ in server.calls[offset:])
 timeouts.clear()
 with mock.patch.object(A,'http_transport',side_effect=channel):
  final=A.resume_registered(pointer['application_id'],pointer['request_id'],TOKEN,game_id='G1')
 assert timeouts==[(50,False),(135,True)]
 offset=len(server.calls)
 replay=A.resume_registered(pointer['application_id'],pointer['request_id'],TOKEN,transport=server,game_id='G1')
 assert replay==final and all(method=='GET' for method,_,_ in server.calls[offset:])
 sealed_scope=server.app['seal']['game_scope']
 server=Server();timeouts.clear()
 legacy_pointer=scheduled.capture_pointer(legacy,'101','2')
 with mock.patch.object(A,'http_transport',side_effect=channel):
  assert A.send(legacy,root/'legacy',TOKEN,max_steps=1)['status']=='pending'
  assert A.resume_registered(legacy_pointer['application_id'],legacy_pointer['request_id'],TOKEN)['status']=='terminal_original'
 assert timeouts==[(50,False),(50,False)]
 print(json.dumps({'scope':sealed_scope,'same_capture':True,
  'terminal':final['status'],'groups':final['result']['counts']['accepted_groups']}))
`);
  assert.deepEqual(r.scope, { policy: 'nfl.capture_game_scope_v1', season: 2026, week: 6, game_id: 'G1' });
  assert.equal(r.terminal, 'terminal_original');
  assert.equal(r.groups, 2);
});

test('scheduled game continues verified exact IDs within existing windows on progress or transient transport errors', () => {
  const r = py(`
from scripts import run_scheduled_outcomes as scheduled
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);legacy,_,path=fixture(root,include_roster=True)
 scope={'policy':A.GAME_SCOPE_POLICY,'season':2026,'week':6,'game_id':'G1'}
 plan=A.plan(path,A.ORIGIN,scope=scope)
 pointer=scheduled.capture_pointer(plan,'101','2');server=Server()
 original_send,original_resume=A.send,A.resume_registered
 retries=[]
 def first(*args, **kwargs):
  assert kwargs=={'max_run_seconds':285}
  return original_send(*args,**kwargs,max_steps=1,transport=server)
 def resume(aid,rid,token,**kwargs):
  assert (aid,rid)==(pointer['application_id'],pointer['request_id'])
  assert kwargs=={'game_id':'G1','max_run_seconds':285}
  retries.append(aid)
  if len(retries)==1:
   raise A.ApplicationExportError('application_http_exhausted')
  if len(retries)==2:
   raise A.ApplicationExportError('application_transport_exhausted')
  return original_resume(aid,rid,token,**kwargs,transport=server)
 with mock.patch.object(A,'send',side_effect=first), mock.patch.object(A,'resume_registered',side_effect=resume), redirect_stdout(io.StringIO()) as progress:
  terminal=scheduled.deliver_scoped(plan,pointer,root/'out',TOKEN)
 assert terminal['status']=='terminal_original' and terminal['complete_success']
 logs=[json.loads(row)for row in progress.getvalue().splitlines()]
 assert len(retries)==3 and [row['continuation']for row in logs]==[1,2,3]
 assert all(row['application_id']==pointer['application_id'] and row['adoption_approved'] is False for row in logs)
 registrations=[route for method,route,_ in server.calls if method=='POST'and route==A.BASE]
 steps=[route for method,route,_ in server.calls if method=='POST'and '/steps/' in route]
 assert len(registrations)==1 and len(steps)==len(set(steps))==2

 with mock.patch.object(A,'resume_registered') as no_retry:
  for reason,out_dir in (('application_http_refused',root/'out'),('application_pending_budget',root/'not_registered'),
                         ('application_http_exhausted',root/'not_registered'),('application_transport_exhausted',root/'not_registered')):
   pending={'status':'pending','reason':reason}
   with mock.patch.object(A,'send',return_value=pending):
    assert scheduled.deliver_scoped(plan,pointer,out_dir,TOKEN)==pending
  no_retry.assert_not_called()
 pending={'status':'pending','reason':'application_pending_step_limit'}
 for stop,expected,expected_count in (
   (A.ApplicationBudgetExceeded('application_pending_budget'),{'status':'pending','reason':'application_pending_budget'},3),
   (A.ApplicationExportError('application_http_exhausted'),{'status':'pending','reason':'application_http_exhausted'},3),
   (A.ApplicationExportError('application_transport_exhausted'),{'status':'pending','reason':'application_transport_exhausted'},3),
   (A.ApplicationExportError('application_http_refused'),{'status':'pending','reason':'application_http_refused'},2),
   (A.ApplicationExportError('application_protocol_refused'),{'status':'pending','reason':'application_protocol_refused'},2),
   (terminal,terminal,2)):
  allowed=[A.ApplicationBudgetExceeded('application_pending_budget'),stop,stop]
  with mock.patch.object(A,'send',return_value=pending), mock.patch.object(A,'resume_registered',side_effect=allowed) as still_pending, redirect_stdout(io.StringIO()):
   assert scheduled.deliver_scoped(plan,pointer,root/'out',TOKEN)==expected
   assert still_pending.call_count==expected_count
 for reason in ('application_http_exhausted','application_transport_exhausted'):
  pending={'status':'pending','reason':reason}
  with mock.patch.object(A,'send',return_value=pending) as initial,mock.patch.object(A,'resume_registered',return_value=terminal) as resumed,redirect_stdout(io.StringIO()):
   assert scheduled.deliver_scoped(plan,pointer,root/'out',TOKEN)==terminal
   initial.assert_called_once()
   resumed.assert_called_once_with(pointer['application_id'],pointer['request_id'],TOKEN,game_id='G1',max_run_seconds=285)
  with mock.patch.object(A,'send',return_value=pending),mock.patch.object(A,'resume_registered') as invalid_resume:
   changed={**pointer,'request_id':ex.fingerprint('wrong request')}
   assert error(lambda:scheduled.deliver_scoped(plan,changed,root/'out',TOKEN))
   invalid_resume.assert_not_called()
 with mock.patch.object(A,'resume_registered',side_effect=[
  A.ApplicationExportError('application_http_exhausted'),A.ApplicationExportError('application_transport_exhausted'),terminal]) as historical,redirect_stdout(io.StringIO()):
  assert scheduled.continue_registered(pointer,'G1',TOKEN,{'status':'pending','reason':'saved_registered_application'},4,expected_scope=scope)==terminal
  assert historical.call_args_list==[mock.call(pointer['application_id'],pointer['request_id'],TOKEN,
   game_id='G1',max_run_seconds=285,expected_scope=scope)]*3
 print(json.dumps({'registered':len(registrations),'steps':len(steps),'continuations':len(retries)}))
`);
  assert.deepEqual(r, { registered: 1, steps: 2, continuations: 3 });
});

test('v2 metadata rejects resealed roster members outside the ordered capture plan', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
 p,_,_=fixture(pathlib.Path(tmp),include_roster=True)
 original=p['request']['capture_request']
 rejected=[]
 for replacement in (lambda rows: rows[:-2]+rows[-2:][::-1], lambda rows: rows[:-1]+[rows[-2]]):
  invalid=copy.deepcopy(original)
  manifest=invalid['envelope']['manifest']
  manifest['sources']=replacement(manifest['sources'])
  hashit(manifest,'capture_id')
  invalid['capture_id']=manifest['capture_id']
  identity={key:invalid[key] for key in ('version','destination_id','producer_id','capture_id','binding_policy')}
  invalid['delivery_id']=ex.fingerprint({**identity,'kind':'nfl.capture_delivery.v1'})
  rejected.append(error(lambda: A.metadata(invalid,A.ORIGIN)))
 print(json.dumps(rejected))
`);
  assert.deepEqual(r, [true, true]);
});

test('actual engine validates producer roster requests and returns seals the sender can verify', {
  skip: !process.env.SELFLEARNING_CHECKOUT && 'SELFLEARNING_CHECKOUT not configured; no crossrepo claim',
}, () => {
  const r = py(`
import sys
checkout=pathlib.Path(os.environ['SELFLEARNING_CHECKOUT'])/'packages/selflearn-core'
sys.path[:0]=[str(checkout),str(checkout/'tests')]
from selflearn_core.adapters import nfl_capture_application_v2 as V, nfl_capture_application_contracts as contracts
from selflearn_core.adapters.nfl import adapt_prospective
import test_nfl_capture_application_contracts as engine_fixture
from test_nfl_capture_delivery_job import MemoryDeliveryJournal,PROCESSING
from test_nfl_capture_evidence import stream

with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)
 forecast=root/'forecasts'
 doc,_,_=f['bound_generation'](forecast)
 adapted=adapt_prospective(journal_docs=[doc])
 assert adapted['rejections']==[]
 receipts=adapted['receipts']
 journal=MemoryDeliveryJournal(vintages=0)
 journal.snapshot['receipts']=receipts
 ack={'version':1,'object_id':doc['envelope_id'],'durable':True,'rejections':[],
      'receipts':[{'source_receipt_id':row['source_receipt_id'],'receipt_id':row['receipt_id'],'status':'recorded'} for row in receipts]}
 journal.snapshot['generation_records']=[{'object_id':doc['envelope_id'],'payload':doc,'ack':ack,'recorded_utc':f['RECORDED']}]
 journal.objects={row['object_id']:{**row,'received_utc':f['RECORDED']} for row in f['plan'](forecast)['source_objects']}

 absent_stats=[f['bound_stats_row']('20',player_index=2,player_display_name='Home Other')]
 absent_snaps=[f['bound_snap_row'](player_index=2,player='Home Other'),
               f['bound_snap_row'](player_index=1,player='Away Starter',team='LAR',opponent='SEA')]
 options=({}, {'stats_rows':absent_stats}, {'stats_rows':absent_stats,'snap_rows':absent_snaps}, {'include_roster':False})
 facts=[]
 terminal_statuses=[]
 rejected=[]
 for option in options:
  bundle=f['bound_bundle'](**option)
  request=A.plan(C.save_capture(bundle,root/'capture'),A.ORIGIN)['request']
  assert V.validate_request(request)==request
  raw=bundle['raw_objects']
  ctx=V.bind_context(journal,request,lambda oid:stream(raw[oid]),clock=lambda:PROCESSING)
  seal=V.prepare_seal(ctx)
  assert contracts.validate_seal(seal,request)==seal
  A.seal_valid(seal,request)
  reg=engine_fixture.registration(seal)
  groups,batches=engine_fixture.report(ctx,seal)
  term=engine_fixture.terminal(seal,groups,batches)
  contracts.validate_registration(reg,seal)
  contracts.validate_terminal(term,seal,groups,batches)
  remote=Server()
  remote.app={'request':request,'seal':seal,'registration':reg,'groups':groups,'batches':batches,'terminal':term}
  remote.record()
  terminal_statuses.append(A.report_valid(remote.app,request)['terminal']['status'])
  group=seal['groups'][0]
  if group['fact'] is None:
   facts.append([group['status'],None])
   continue
  fact=group['fact']
  facts.append([fact['status'],fact['actual']])
  sources=fact['source_observations']
  assert 'nflverse.rosters' in sources
  invalid_sources=[{key:row for key,row in sources.items() if key!='nflverse.rosters'},
                   {**sources,'nflverse.rosters':{**sources['espn.scoreboard'],'source':'nflverse.rosters'}}]
  if fact['status']=='VOID':
   invalid_sources.append({key:row for key,row in sources.items() if key!='nflverse.snap_counts'})
  for source_set in invalid_sources:
   broken=copy.deepcopy(seal)
   sealed_group=broken['groups'][0]
   sealed_group['fact']['source_observations']=source_set
   sealed_group['fact_id']=ex.fingerprint(sealed_group['fact'])
   hashit(broken,'seal_id')
   rejected.append([error(lambda: validate(broken,request)) for validate in (A.seal_valid,contracts.validate_seal)])
 assert journal.delivery_writes==[]
 print(json.dumps({'facts':facts,'terminal_statuses':terminal_statuses,'rejected':rejected}))
`);
  assert.deepEqual(r.facts, [['FINAL', 80], ['FINAL', 0], ['VOID', null], ['withheld', null]]);
  assert.deepEqual(r.terminal_statuses, ['accepted', 'accepted', 'accepted', 'withheld']);
  assert.deepEqual(r.rejected, Array.from({ length: 7 }, () => [true, true]));
});

test('max-step and monotonic deadlines retain resumable pending without fabricating a whole ACK', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);s=Server();one=send(p,root/'out',s,max_steps=1);two=send(p,root/'out',s,max_steps=1)
 ticks=iter([0,2]);slow=send(p,root/'budget',Server(),max_run_seconds=1,monotonic=lambda:next(ticks))
 print(json.dumps({'one':one,'two':two['status'],'slow':slow,'first_steps':len(list((root/'out').rglob('steps/*/command.json')))}))
`);
  assert.equal(r.one.status, 'pending'); assert.equal(r.one.reason, 'application_pending_step_limit'); assert.equal(r.one.learning_accepted, false);
  assert.equal(r.two, 'terminal_original'); assert.equal(r.slow.reason, 'application_pending_budget'); assert.equal(r.first_steps, 2);
});

test('empty withheld partial oversized and VOID populations retain distinct terminal semantics', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);reports=[]
 for i,kw in enumerate(({'sizes':()},{'held':(0,1)},{'held':(0,)},{'sizes':(501,2)},{'void':True})):
  reports.append(send(p,root/str(i),Server(**kw)))
 print(json.dumps({'status':[r['result']['status']for r in reports],'success':[r['complete_success']for r in reports],
  'learn':[r['learning_accepted']for r in reports],'oversized':reports[3]['result']['counts']['withheld_members']}))
`);
  assert.deepEqual(r.status, ['no_supported_membership', 'withheld', 'partial', 'partial', 'accepted']);
  assert.deepEqual(r.success, [false, false, false, false, true]); assert.deepEqual(r.learn, [false, false, true, true, true]); assert.equal(r.oversized, 501);
});

test('stopped applications preserve their committed prefix but never become complete cohort success', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);out=[];forged=[]
 for index,cause in enumerate(('membership','integrity')):
  s=Server();s.register(p['request']);s.commit(s.app['batches'][0]['assignment']['step_id'])
  if cause=='membership':s.commit(s.app['batches'][1]['assignment']['step_id'],cause='membership')
  else:
   for row in s.app['groups']:
    if row['execution_state']=='pending':row.update(execution_state='not_applied',result=held_result(row['sealed_group'],['source_integrity_failed']))
   s.app['terminal']=terminal(s.app,cause);s.record()
  with mock.patch.object(O,'_validated',side_effect=AssertionError('original before raw')):out.append(send(p,root/str(index),s))
  v=copy.deepcopy(s.app);v['terminal']['status']='accepted';v['terminal']['reason_codes']=[];hashit(v['terminal'],'terminal_result_id')
  forged.append(error(lambda:A.report_valid(v,p['request'])))
 print(json.dumps({'states':[x['result']['status']for x in out],'complete':[x['processing_complete']for x in out],
  'success':[x['complete_success']for x in out],'learning':[x['learning_accepted']for x in out],
  'accepted':[x['result']['counts']['accepted_members']for x in out],'forged':all(forged)}))
`);
  assert.deepEqual(r.states, ['incomplete_membership_changed', 'incomplete_integrity_or_capacity']);
  assert.deepEqual(r.complete, [false, false]); assert.deepEqual(r.success, [false, false]); assert.deepEqual(r.learning, [true, true]);
  assert.deepEqual(r.accepted, [2, 2]); assert.equal(r.forged, true);
});

test('mixed fence partial pages malformed wrappers and changed immutable originals never ACK', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);out=[]
 for i,kind in enumerate(('version','missing','fence','total','cursor','subset','wrong_request','registration_wrapper','step_wrapper','reply_original')):
  s=Server();s.register(p['request'])
  if kind=='wrong_request':s.history['1']['request']['capture_request']['producer_id']='wrong'
  def mutate(page):
   if kind=='version':page['version']=True
   if kind=='missing':page.pop('seal_id')
   if kind=='fence'and page['view']=='groups':page['ledger_watermark']='99'
   if kind=='total'and page['view']=='groups':page['total_records']=1
   if kind=='cursor'and page['view']=='groups':page['next_after']=ex.fingerprint('wrong')
   if kind=='subset'and page['view']=='groups':page['next_after']=None
  s.mutate=mutate
  def transport(m,route,body):
   if kind=='registration_wrapper'and m=='GET'and s.app is not None and len(s.calls)==0:s.app=None
   status,raw=s(m,route,body)
   if m=='POST'and route==A.BASE and kind=='registration_wrapper':v=ex._json(raw);v['learning_accepted']=True;return 200,ex.encoded(v)
   if m=='POST'and'/steps/'in route and kind in('step_wrapper','reply_original'):
    v=ex._json(raw)
    if kind=='step_wrapper':v['scope']='learning_complete'
    else:v['result']['recorded_utc']='2026-09-03T15:00:31Z';hashit(v['result'],'batch_result_id')
    return 200,ex.encoded(v)
   return status,raw
  out.append(send(p,root/str(i),transport))
 print(json.dumps({'pending':all(r['status']=='pending'and r['learning_accepted']is False for r in out),'n':len(out)}))
`);
  assert.equal(r.pending, true); assert.equal(r.n, 10);
});

test('unexpected callbacks are redacted without retry and BaseException cancellation remains visible', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);reports=[];counts=[];cancel=[]
 for i,exc in enumerate((Exception('SECRET'),RuntimeError('SECRET'),http.client.BadStatusLine('SECRET'),http.client.IncompleteRead(b'SECRET'),A.ApplicationExportError('SECRET'))):
  calls=[]
  def broken(*args):calls.append(1);raise exc
  reports.append(send(p,root/str(i),broken));counts.append(len(calls))
 for exc in(KeyboardInterrupt(),SystemExit(7)):
  def broken(*args):raise exc
  try:send(p,root/'cancel',broken)
  except BaseException as e:cancel.append(type(e).__name__)
 audit=''.join(x.read_text()for x in root.rglob('*.json'))
 print(json.dumps({'reports':reports,'counts':counts,'cancel':cancel,'redacted':'SECRET'not in audit and TOKEN not in audit}))
`);
  assert.ok(r.reports.every(x => x.status === 'pending' && x.reason === 'application_transport_failed'));
  assert.deepEqual(r.counts, [1, 1, 1, 1, 1]); assert.deepEqual(r.cancel, ['KeyboardInterrupt', 'SystemExit']); assert.equal(r.redacted, true);
});

test('transport allowlists exact routes queries methods and bodies before attaching credentials', () => {
  const r = py(`
calls=[]
class Opener:
 def open(self,*args,**kw):calls.append(args);raise RuntimeError('SECRET')
with mock.patch.object(A.urllib.request,'build_opener',return_value=Opener()):
 transport=A.http_transport(A.ORIGIN,TOKEN);aid=ex.fingerprint('a');sid=ex.fingerprint('s');path=A.BASE+'/'+urllib.parse.quote(aid,safe='')
 bad=[('GET','@evil.invalid/collector',None),('POST','https://evil.invalid',b'{}'),('POST',path,b'{}'),('DELETE',A.BASE,b'{}'),
  ('POST',path+'/steps/'+urllib.parse.quote(sid,safe=''),b'{"proof":1}'),('GET',path+'?view=status&limit=1',None),
  ('GET',path+'?limit=1&view=status&view=status',None),('GET',path+'?limit=1&view=status#SECRET',None),
  ('GET',path+'?limit=1&view=status&extra=x',None),('GET',path+'?after=0&limit=1&view=status',None),
  ('GET',path+'?ledger_watermark=00&limit=1&view=status',None),('GET',path+'?limit=100&view=status',None),
  ('GET',path+'?limit=1&view=status',b'{}'),('POST',O.CHUNK_ROUTE,b'x'*(O.BODY_BYTES+1))]
 rejected=[error(lambda:A.route_valid(*args))for args in bad]
 for args in bad:assert error(lambda:transport(*args))
 before=len(calls)
 allowed=[('GET',A.route(aid,'status'),None),('GET',path+'/steps/'+urllib.parse.quote(sid,safe=''),None),('POST',path+'/steps/'+urllib.parse.quote(sid,safe=''),b'{}')]
 for args in allowed:assert error(lambda:transport(*args))
 print(json.dumps({'rejected':all(rejected),'before':before,'allowed':len(calls),'credentials_fixed':all(x[0].full_url.startswith(A.ORIGIN+'/api/')for x in calls)}))
`);
  assert.equal(r.rejected, true); assert.equal(r.before, 0); assert.equal(r.allowed, 3); assert.equal(r.credentials_fixed, true);
});

test('v2 HTTP caps legacy and scoped socket timeouts at their respective limits or remaining time', () => {
  const r = py(`
aid=ex.fingerprint('a');route=A.route(aid,'status');now=[0.0];calls=[];reads=[]
class Response:
 status=200
 def __init__(self,raw=b'{}',late=False):self.raw=raw;self.late=late
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def geturl(self):return A.ORIGIN+route
 def read1(self,n):
  reads.append(n);part,self.raw=self.raw[:n],self.raw[n:]
  if self.late:now[0]=100.0
  return part
class Opener:
 response=Response()
 def open(self,req,timeout):calls.append(timeout);return self.response
opener=Opener()
with mock.patch.object(A.urllib.request,'build_opener',return_value=opener)as builder:
 t=A.http_transport(A.ORIGIN,TOKEN,deadline=240,monotonic=lambda:now[0]);status,raw=t('GET',route,None)
 now[0]=238;opener.response=Response(b'x'*70000);status,large=t('GET',route,None)
 now[0]=20.16;opener.response=Response();status,again=t('GET',route,None)
 scoped=A.http_transport(A.ORIGIN,TOKEN,timeout=135,deadline=285,monotonic=lambda:now[0],scoped=True)
 scoped('GET',route,None)
 now[0]=284;scoped('GET',route,None)
 invalid=[error(lambda:A.http_transport(A.ORIGIN,TOKEN,timeout=x))for x in(True,0,-1,51,float('nan'),'50')]
 invalid.extend(error(lambda:A.http_transport(A.ORIGIN,TOKEN,timeout=136,scoped=x))for x in(True,False,'true'))
 invalid.extend(error(lambda:A.http_transport(A.ORIGIN,TOKEN,deadline=x))for x in(True,float('nan'),'secret'))
 now[0]=241
 with mock.patch.object(A.urllib.request,'Request',side_effect=AssertionError('must not attach credentials')):
  expired=error(lambda:t('GET',route,None))
 now[0]=0;opener.response=Response(late=True)
 late=error(lambda:A.http_transport(A.ORIGIN,TOKEN,deadline=2,monotonic=lambda:now[0])('GET',route,None))
 handlers=builder.call_args.args
 print(json.dumps({'timeouts':calls,'raw':raw.decode(),'large':len(large),'max_read':max(reads),'invalid':all(invalid),'expired':expired,'late':late,
  'proxy_off':any(isinstance(h,urllib.request.ProxyHandler)and h.proxies=={}for h in handlers),'redirect_off':any(isinstance(h,ex._NoRedirect)for h in handlers)}))
`);
  assert.deepEqual(r.timeouts, [50, 2, 50, 135, 1, 2]); assert.equal(r.raw, '{}'); assert.equal(r.large, 70000); assert.ok(r.max_read <= 65536);
  assert.equal(r.invalid, true); assert.equal(r.expired, true); assert.equal(r.late, true); assert.equal(r.proxy_off, true); assert.equal(r.redirect_off, true);
});

test('late terminal replies and retry sleeps leave pending for exact original recovery; cancellation is not swallowed', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);s=Server();s.register(p['request'])
 for batch in list(s.app['batches']):s.commit(batch['assignment']['step_id'])
 now=[0.0]
 def late(m,route,body):
  reply=s(m,route,body)
  if 'view=terminal'in route:now[0]=2.0
  return reply
 pending=send(p,root/'out',late,max_run_seconds=1,monotonic=lambda:now[0]);terminal_files=len(list((root/'out').rglob('terminal/original.json')))
 now[0]=0
 with mock.patch.object(O,'_validated',side_effect=AssertionError('no raw recovery')):recovered=send(p,root/'out',s,max_run_seconds=1,monotonic=lambda:now[0])
 retries=[]
 def unavailable(*args):retries.append(1);return 503,b''
 def sleep(_):now[0]=2
 now[0]=0
 held=A.send(p,root/'sleep',TOKEN,transport=unavailable,sleep=sleep,max_run_seconds=1,monotonic=lambda:now[0])
 cancelled=[];aid=p['request']['application_id'];route=A.route(aid,'status')
 class Response:
  status=200
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def geturl(self):return A.ORIGIN+route
  def read1(self,n):raise KeyboardInterrupt()
 class Opener:
  def open(self,*args,**kwargs):return Response()
 with mock.patch.object(A.urllib.request,'build_opener',return_value=Opener()):
  try:A.http_transport(A.ORIGIN,TOKEN)('GET',route,None)
  except BaseException as exc:cancelled.append(type(exc).__name__)
 print(json.dumps({'pending':pending,'terminal_files':terminal_files,'recovered':recovered['status'],'sleep':held,'retries':len(retries),'cancelled':cancelled}))
`);
  assert.equal(r.pending.reason, 'application_pending_budget'); assert.equal(r.pending.complete_success, false); assert.equal(r.terminal_files, 0);
  assert.equal(r.recovered, 'terminal_original'); assert.equal(r.sleep.reason, 'application_pending_budget'); assert.equal(r.retries, 1);
  assert.deepEqual(r.cancelled, ['KeyboardInterrupt']);
});

test('network retry quota refusal overlong JSON and wrong staging remain pending without new cohort commands', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);out=[]
 for i,kind in enumerate(('503','413','redirect','quota','json','big','bool','stage')):
  s=Server()
  def transport(m,route,body):
   if m=='GET':return 404,b''
   if kind=='503':return 503,b'SECRET'
   if kind=='413':return 413,b'SECRET'
   if kind=='redirect':return 302,b'SECRET'
   if kind=='quota':return 429,b'SECRET'
   if kind=='json':return 200,b'{"x":1,"x":2}'
   if kind=='big':return 200,b'x'*(O.BODY_BYTES+1)
   if kind=='bool':return True,b''
   status,raw=s(m,route,body);ack=ex._json(raw);ack['learning_accepted']=True;return status,ex.encoded(ack)
  out.append(send(p,root/str(i),transport,attempts=2))
 print(json.dumps({'pending':all(x['status']=='pending'for x in out),'terminals':len(list(root.rglob('terminal/*.json')))}))
`);
  assert.equal(r.pending, true); assert.equal(r.terminals, 0);
});

test('path authority and plan tampering fail before HTTP or writes and contradictory originals stay sticky', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);untouched=root/'untouched';untouched.mkdir();link=root/'link';link.symlink_to(untouched,target_is_directory=True)
 rejected=[error(lambda:A.prepare(p,d))for d in(link,link/'sub',path.parent.parent,root,A._ROOT,A._ROOT/'data'/'x')]
 v=copy.deepcopy(p);v['request']['application_id']=ex.fingerprint('wrong');rejected.append(error(lambda:A.send(v,root/'bad',TOKEN)))
 s=Server();r=send(p,root/'out',s);stored=next((root/'out').rglob('registration/original.json'));v=ex._read(stored);v['recorded_utc']='2026-09-03T16:00:00Z';hashit(v,'registration_id');stored.write_bytes(ex.encoded(v))
 conflict=send(p,root/'out',s);n=len(s.calls);again=error(lambda:send(p,root/'out',s))
 print(json.dumps({'rejected':all(rejected),'untouched':not list(untouched.iterdir()),'conflict':conflict['status'],'sticky':again,'no_http':len(s.calls)==n}))
`);
  assert.equal(r.rejected, true); assert.equal(r.untouched, true); assert.equal(r.conflict, 'pending'); assert.equal(r.sticky, true); assert.equal(r.no_http, true);
});

test('strict report validators reject typed and resealed semantic attacks instead of trusting hashes', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);s=Server();send(p,root/'out',s);good=copy.deepcopy(s.app);rejected=[]
 changes=[lambda v:v['seal'].update(version=True),lambda v:v['seal'].update(source_vector_id=ex.fingerprint('wrong')),
  lambda v:v['seal']['limits'].update(members=True),lambda v:v['seal']['groups'][0].update(fact_id=ex.fingerprint('wrong')),
  lambda v:v['seal']['groups'][0]['fact'].update(actual=True),lambda v:v['seal']['groups'][0]['fact']['game'].update(away='SEA'),
  lambda v:v['seal']['batches'][0].update(member_count=1),lambda v:v['registration'].update(learning_accepted=True),
  lambda v:v['batches'][0]['result'].update(added_observations=True),lambda v:v['batches'][0]['result'].update(input_watermark='0'),
  lambda v:v['groups'][0].update(execution_state='pending'),lambda v:v['status'].update(durable_ack=True),
  lambda v:v['status'].update(committed_batches=True),lambda v:v['status'].update(ledger_watermark='999'),
  lambda v:v['terminal'].update(processing_complete=False),lambda v:v['terminal'].update(application_seq='1'),
  lambda v:v['terminal']['counts'].update(groups=True),lambda v:v['terminal'].update(group_report_id=ex.fingerprint('subset')),
  lambda v:v['terminal'].update(reason_codes=['source_integrity_failed']),lambda v:v['batches'][1]['result']['groups'][0].update(observation_ids=v['batches'][0]['result']['groups'][0]['observation_ids'])]
 for change in changes:
  v=copy.deepcopy(good);change(v);rejected.append(error(lambda:A.report_valid(v,p['request'])))
 print(json.dumps({'all':all(rejected),'n':len(rejected)}))
`);
  assert.equal(r.all, true); assert.equal(r.n, 20);
});

test('CLI sanitizes unexpected failures; invalid origin token options never invoke HTTP', () => {
  const r = py(`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);p,b,path=fixture(root);out=[];calls=[]
 for token in('', 'short','x'*8193,'x'*32+chr(10)):
  out.append(error(lambda:A.send(p,root/'invalid',token,transport=lambda *a:calls.append(a))))
 for kw in({'attempts':True},{'max_steps':0},{'max_run_seconds':True},{'max_run_seconds':301}):out.append(error(lambda:send(p,root/'invalid',Server(),**kw)))
 stream=io.StringIO()
 with mock.patch.object(A,'plan',side_effect=Exception('SECRET')),redirect_stderr(stream):code=A.main(['--capture',str(path),'--base-url',A.ORIGIN])
 original_get=os.environ.get
 def no_credentials(key,*args):assert not key.startswith('SELFLEARN');return original_get(key,*args)
 with mock.patch.object(os.environ,'get',side_effect=no_credentials),redirect_stderr(io.StringIO()):bad=A.main(['--capture',str(path),'--base-url','https://evil.invalid','--send','--out-dir',str(root/'bad')])
 print(json.dumps({'all':all(out),'calls':calls,'code':code,'bad':bad,'redacted':'SECRET'not in stream.getvalue(),'written':(root/'invalid').exists()}))
`);
  assert.equal(r.all, true); assert.deepEqual(r.calls, []); assert.equal(r.code, 1); assert.equal(r.bad, 1); assert.equal(r.redacted, true); assert.equal(r.written, false);
});

test('trusted Actions history verifies scoped artifact provenance and archive digest without following authenticated redirects', () => {
  const r = py(`
import hashlib,zipfile
from datetime import datetime,timezone
from scripts import outcome_recovery_history as H
game='G1';rid=123;repo={'id':H.REPOSITORY_ID}
run={'id':rid,'path':'.github/workflows/'+H.WORKFLOW,'status':'completed','event':'workflow_run',
 'head_branch':'main','repository':repo,'head_repository':repo,'head_sha':'a'*40,'run_attempt':2}
source={'id':rid,'head_branch':'main','repository_id':H.REPOSITORY_ID,'head_repository_id':H.REPOSITORY_ID,'head_sha':'a'*40}
pointer={'version':1,'run_id':str(rid),'run_attempt':'2','application_id':ex.fingerprint('app'),'request_id':ex.fingerprint('req')}
archive=io.BytesIO()
with zipfile.ZipFile(archive,'w') as z:z.writestr('pointer.json',ex.encoded(pointer))
raw=archive.getvalue();digest='sha256:'+hashlib.sha256(raw).hexdigest()
row={'id':7,'name':f'selflearning-outcome-{rid}-2-game-{game}','size_in_bytes':len(raw),'digest':digest,'workflow_run':source,'expired':False}
def api(route):
 if '/workflows/' in route:
  assert 'status=completed' in route and 'branch=main' in route
  return {'total_count':1,'workflow_runs':[run]}
 assert route==f'/runs/{rid}/artifacts?per_page=100'
 return {'total_count':2,'artifacts':[row,{**row,'id':8,'name':f'selflearning-outcome-{rid}-1-game-{game}'}]}
def find():return H.pointer_candidates(api,[game],datetime(2026,9,3,tzinfo=timezone.utc),'124')
assert [x[2]for x in find()[game]]==['2','1']
run['event']='workflow_dispatch'
assert [x[2]for x in find()[game]]==['2','1']
assert H._read_pointer_archive(raw,digest,len(raw))==pointer
assert error(lambda:H._read_pointer_archive(raw+b'x',digest,len(raw)+1))
assert error(lambda:H._read_pointer_archive(raw,digest,len(raw)+1))
history=H.GitHubHistory('synthetic-read-only-github-token')
requests=[]
class Payload:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,n):return raw
def open_url(req,timeout):
 requests.append(req)
 if len(requests)==1:
  raise urllib.error.HTTPError(req.full_url,302,'redirect',{'Location':'https://productionresultssa4.blob.core.windows.net/archive?signature=demo'},io.BytesIO())
 return Payload()
with mock.patch.object(history.opener,'open',side_effect=open_url):
 assert history.download(find()[game][0])==pointer
assert len(requests)==2 and requests[0].has_header('Authorization') and not requests[1].has_header('Authorization')
run['head_repository']={'id':1}
assert error(find)
run['head_repository']=repo;source['head_sha']='b'*40
assert error(find)
source['head_sha']='a'*40
run['run_attempt']=1
assert error(find)
print(json.dumps({'auth_bound':True,'archive_bound':True,'fork_refused':True}))
`);
  assert.deepEqual(r, { auth_bound: true, archive_bound: true, fork_refused: true });
});

test('automatic workflow resumes oldest useful registered progress without recapture and replays terminal read-only', () => {
  const r = py(`
from datetime import timedelta
from scripts import run_scheduled_outcomes as S
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);_,_,path=fixture(root,include_roster=True)
 kickoff=C._instant(f['KICKOFF']);now=kickoff+timedelta(days=1)
 game={'game_id':'G1','week':6,'home':'SEA','away':'LAR','status':'STATUS_FINAL','kickoff_utc':f['KICKOFF']}
 schedule={'season':2026,'games':[game]}
 scope,_=S.recent_game(schedule,now,'G1')
 plan=A.plan(path,A.ORIGIN,scope=scope)
 older=S.capture_pointer(plan,'701','1')
 newer={**S.capture_pointer(plan,'702','1'),'application_id':ex.fingerprint('new preregistered app'),'request_id':ex.fingerprint('new preregistered request')}
 ignored={**newer,'run_id':'703','application_id':ex.fingerprint('never registered')}
 artifacts=[(3,'703','1','unused',1),(2,'702','1','unused',1),(1,'701','1','unused',1)]
 source=mock.Mock()
 source.download.side_effect=lambda locator:{'701':older,'702':newer,'703':ignored}[locator[1]]
 s=Server();assert send(plan,root/'old-issued-outbox',s,max_steps=1)['status']=='pending'
 def progress(aid,rid,scope,token,*,deadline):
  assert token==TOKEN
  if aid==newer['application_id']:return ('active',0)
  if aid==ignored['application_id']:return None
  return A_READ(aid,rid,scope,token,transport=s)
 A_READ=A.registered_progress
 assert A_READ(older['application_id'],older['request_id'],scope,TOKEN,transport=s)==('active',1)
 assert error(lambda:A_READ(older['application_id'],older['request_id'],{**scope,'week':7},TOKEN,transport=s))
 assert error(lambda:A_READ(older['application_id'],newer['request_id'],scope,TOKEN,transport=s))
 assert A_READ(ignored['application_id'],ignored['request_id'],scope,TOKEN,transport=Server()) is None
 output=root/'selected';env={'NFL_SELFLEARN_OUTCOME_MODE':'record','NFL_SELFLEARN_OUTCOME_AUTOMATIC_GAMES':'true',
  'GITHUB_REPOSITORY':'liddar12/NFL2026','GITHUB_REF':'refs/heads/main','RUNNER_TEMP':str(root),
  'OUTCOME_GITHUB_TOKEN':'synthetic',S.TOKEN:TOKEN,'GITHUB_RUN_ID':'704','GITHUB_RUN_ATTEMPT':'1','GITHUB_OUTPUT':str(output)}
 with mock.patch.object(S.history,'GitHubHistory',return_value=source),mock.patch.object(S.history,'pointer_candidates',return_value={'G1':artifacts}),mock.patch.object(A,'registered_progress',side_effect=progress),mock.patch.object(C,'capture',side_effect=AssertionError('unexpected fresh capture')) as raw,redirect_stdout(io.StringIO()):
  assert S.select_scoped(schedule,now,env,root)==0
  assert S.select_scoped(schedule,now,{**env,'OUTCOME_PROBE_GAME_ID':'G1'},root)==0
  raw.assert_not_called()
 matrices=[json.loads(line.split('=',1)[1])for line in output.read_text().splitlines()if line.startswith('entries=')]
 assert matrices==[[{'mode':'resume','game_id':'G1',**older}]]*2
 n=len(s.calls)
 class FixedClock(S.datetime):
  @classmethod
  def now(cls,tz):return now
 resume_env={**env,'OUTCOME_GAME_ID':'G1','OUTCOME_SOURCE_RUN_ID':'701','OUTCOME_SOURCE_RUN_ATTEMPT':'1',
   'OUTCOME_APPLICATION_ID':older['application_id'],'OUTCOME_REQUEST_ID':older['request_id']}
 with mock.patch.object(S,'datetime',FixedClock),mock.patch.object(S.handoff.forecast.capture,'read_input',return_value=schedule),mock.patch.object(A,'http_transport',return_value=s),mock.patch.object(C,'capture',side_effect=AssertionError('unexpected capture')) as raw,redirect_stdout(io.StringIO()) as emitted:
  assert S.run('recover-auto',env=resume_env)==0
  writes=[p for m,p,_ in s.calls[n:]if m=='POST'];n=len(s.calls)
  assert len(writes)==1 and '/steps/' in writes[0]
  assert S.run('recover-auto',env=resume_env)==0
  assert all(m=='GET'for m,_,_ in s.calls[n:])
  raw.assert_not_called()
  assert all(json.loads(row)['adoption_approved'] is False for row in emitted.getvalue().splitlines())
 assert A_READ(older['application_id'],older['request_id'],scope,TOKEN,transport=s)==('processed',2)
 def has_terminal(aid,rid,scope):
  if aid==newer['application_id']:return 'active',10
  if aid==ignored['application_id']:return None
  return A_READ(aid,rid,scope,TOKEN,transport=s)
 assert S.recoverable_application(scope,artifacts,source.download,has_terminal)=={'mode':'resume','game_id':'G1',**older}
 print(json.dumps({'resume_exact':True,'replay_read_only':True,'raw_capture_calls':0}))
`);
  assert.deepEqual(r, { resume_exact: true, replay_read_only: true, raw_capture_calls: 0 });
});

test('automatic outcome recovery holds failed authority and an empty isolated probe without recapturing', () => {
  const r = py(`
from datetime import timedelta
from scripts import run_scheduled_outcomes as S
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);kickoff=C._instant(f['KICKOFF']);now=kickoff+timedelta(days=1)
 schedule={'season':2026,'games':[{'game_id':'G1','week':6,'home':'SEA','away':'LAR','status':'STATUS_FINAL','kickoff_utc':f['KICKOFF']}]}
 source=mock.Mock();source.download.side_effect=ValueError('untrusted artifact bytes')
 output=root/'selected';env={'OUTCOME_GITHUB_TOKEN':'synthetic',S.TOKEN:TOKEN,'GITHUB_RUN_ID':'704','GITHUB_OUTPUT':str(output)}
 with mock.patch.object(S.history,'GitHubHistory',return_value=source),mock.patch.object(S.history,'pointer_candidates',side_effect=[{'G1':[(1,'703','1','invalid',1)]},{'G1':[]}]),mock.patch.object(C,'capture',side_effect=AssertionError('unexpected fresh capture')) as raw,redirect_stdout(io.StringIO()) as log:
  assert S.select_scoped(schedule,now,env,root)==0
  assert S.select_scoped(schedule,now,{**env,'OUTCOME_PROBE_GAME_ID':'G1'},root)==0
  assert output.read_text().count('recovery_held_count=1')==2
  assert output.read_text().count('fresh_count=0')==2
  raw.assert_not_called()
  assert 'untrusted artifact bytes' not in log.getvalue()
 print(json.dumps({'held':True}))
`);
  assert.equal(r.held, true);
});

after(() => {
  assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), sourceHash);
  const executable = JSON.parse(execFileSync('python3', ['-c', `import json,trace;print(json.dumps(sorted(x for x in trace._find_executable_linenos(${JSON.stringify(SOURCE)}) if x>0)))`], { encoding: 'utf8' }));
  const all = new Set([...executable, ...covered]);
  console.log(JSON.stringify({ source: 'scripts/export_capture_application.py', sha256: sourceHash, covered: covered.size,
    total: all.size, percent: 100 * covered.size / all.size, missing: [...all].filter(x => !covered.has(x)).sort((a,b) => a-b), scope: 'synthetic-exact-wire-not-SQL-or-hosted' }));
});
