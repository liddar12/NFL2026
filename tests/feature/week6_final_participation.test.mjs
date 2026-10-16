import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['scripts/capture_final_participation.py', 'scripts/shadow_participation_guard.py'];
const hashes = FILES.map(name => createHash('sha256').update(readFileSync(ROOT + name)).digest('hex'));
const covered = FILES.map(() => new Set());
// Candidate wire fixtures are not retained provider payloads, source
// authentication, complete roster inventory, or empirical performance evidence.
const FIXTURE = String.raw`
import copy,datetime as dt,io,json,os,pathlib,runpy,sys,tempfile
from unittest import mock
from contextlib import redirect_stdout,redirect_stderr
from scripts import capture_final_participation as P,shadow_participation_guard as G,capture_outcome_evidence as C
F=runpy.run_path('tests/fixtures/week6_outcomes.py')
OBS='2026-10-12T12:00:00Z';KICK='2026-10-11T17:00:00Z';NEXT='2026-10-18T17:00:00Z';GID='401800005';TARGET='401800006'
def event(gid=GID,week=5,status='STATUS_FINAL',kick=KICK):
 return {'id':gid,'date':kick,'season':{'year':2026,'type':2},'week':{'number':week},'status':{'type':{'name':status,'completed':status in C.FINAL_STATUSES}},
  'competitions':[{'competitors':[{'homeAway':'home','score':'24','team':{'abbreviation':'SEA'}},{'homeAway':'away','score':'17','team':{'abbreviation':'LAR'}}]}]}
def clock():
 ticks=[P.instant(OBS)]
 def tick():ticks[0]+=dt.timedelta(seconds=1);return ticks[0].isoformat().replace('+00:00','Z')
 return tick
class Provider:
 def __init__(self,*,home=None,away=None,size=1):
  self.home=[{'playerId':'123','didNotPlay':True},{'playerId':'124','didNotPlay':False}]if home is None else home
  self.away=[{'playerId':'200','didNotPlay':True}]if away is None else away
  self.size=size;self.calls=[];self.mutate=None
 def __call__(self,spec):
  self.calls.append(copy.deepcopy(spec));profile=spec['profile'];tid=spec['team_id'];gid=spec['game_id']
  if profile==P.SCOREBOARD:value={'season':{'year':2026,'type':2},'week':{'number':5},'events':[event()]}
  elif profile==P.COMPETITION:
   value={'id':gid,'season':{'year':2026,'type':2},'week':{'number':5},'competitors':[
    {'id':t,'homeAway':s,'team':{'$ref':P.CORE+'/teams/'+t},'roster':{'$ref':P.CORE+'/events/'+gid+'/competitions/'+gid+'/competitors/'+t+'/roster'}}
     for s,t in(('home','26'),('away','14'))]}
  elif profile==P.TEAM:value={'id':tid,'abbreviation':'SEA'if tid=='26'else'LAR'}
  else:
   rows=self.home if tid=='26'else self.away;n=spec['page'];size=self.size
   value={'count':len(rows),'pageSize':size,'pageCount':max(1,(len(rows)+size-1)//size),'pageIndex':n,'entries':copy.deepcopy(rows[(n-1)*size:n*size])}
  if self.mutate:self.mutate(spec,value)
  return 200,{},P.encoded(value)
def capture(provider=None):return P.capture(2026,5,GID,fetcher=provider or Provider(),clock=clock())
def context(**changes):
 d={'version':1,'kind':'nfl.participation_decision_context.v1','season':2026,'week':6,'espn_id':'123','team':'SEA',
    'decision_utc':'2026-10-15T12:00:00Z','target_game_id':TARGET,'kickoff_utc':NEXT,**changes}
 return P.seal(d,'context_id')
def history(*,newer=False,no_final=False):
 pages={5:{'season':{'year':2026,'type':2},'week':{'number':5},'events':[event(status='STATUS_SCHEDULED'if no_final else'STATUS_FINAL')]},
        6:{'season':{'year':2026,'type':2},'week':{'number':6},'events':[event(TARGET,6,'STATUS_SCHEDULED',NEXT)]}}
 if newer:pages[5]['events'].append(event('401800055',5,'STATUS_FINAL','2026-10-12T00:00:00Z'))
 def fetch(spec):
  raw=P.encoded(pages[spec['week']])if spec['profile']==C.SCOREBOARD_PROFILE else F['csv_bytes'](
   F['STATS_HEADERS'],[F['stats_row']()])if spec['profile']==C.STATS_PROFILE else F['csv_bytes'](F['SNAPS_HEADERS'],[F['snap_row']()])
  return 200,{},raw
 return C.capture(2026,[5,6],fetcher=fetch,clock=clock())
def error(fn):
 try:fn()
 except Exception as e:return str(e)
 return None
`;
function py(body) {
  const code = `import pathlib,sys,json\nTARGETS=[str(pathlib.Path(n).resolve())for n in ${JSON.stringify(FILES)}];COVER=[set()for _ in TARGETS]\ndef trace(frame,event,arg):\n if frame.f_code.co_filename not in TARGETS:return None\n if event=='line':COVER[TARGETS.index(frame.f_code.co_filename)].add(frame.f_lineno)\n return trace\nsys.settrace(trace)\nexec(${JSON.stringify(FIXTURE + body)})\nsys.settrace(None)\nprint(json.dumps({'__trace__':[sorted(v)for v in COVER]}))\n`;
  const lines = execFileSync('python3', ['-'], { cwd: ROOT, input: code, encoding: 'utf8',
    timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n');
  JSON.parse(lines.pop()).__trace__.forEach((rows, i) => rows.forEach(line => covered[i].add(line)));
  return JSON.parse(lines.pop());
}

test('default CLI is token-free/no-network/no-write and advertises the unverified profile without a fetch mode', () => {
  const r = py(String.raw`
get=os.environ.get;output=io.StringIO();failure=io.StringIO()
def env(key,*a):assert not key.startswith('SELFLEARN');return get(key,*a)
with mock.patch.object(os.environ,'get',side_effect=env),mock.patch('socket.create_connection',side_effect=AssertionError('no network')),redirect_stdout(output):
 code=P.main(['--season','2026','--week','5','--game-id',GID])
try:
 with redirect_stderr(failure):P.main(['--season','2026','--week','5','--game-id',GID,'--fetch','PRIVATE_TOKEN'])
except SystemExit as e:fetch_code=e.code
print(json.dumps({'code':code,'plan':json.loads(output.getvalue()),'fetch_code':fetch_code,'redacted':'PRIVATE_TOKEN'not in failure.getvalue()}))
`);
  assert.equal(r.code, 0); assert.equal(r.plan.mode, 'dry_run'); assert.equal(r.plan.network_implemented, false);
  assert.equal(r.plan.network_used, false); assert.equal(r.plan.writes, false); assert.equal(r.plan.source_authority_authenticated, false);
  assert.equal(r.plan.profile_status, 'repository_inferred_unverified'); assert.equal(r.fetch_code, 2); assert.equal(r.redacted, true);
});

test('strict true exact-ID FINAL evidence preserves raw bytes and distinct observation clocks without asserting participation coverage', () => {
  const r = py(String.raw`
s=Provider();b=capture(s);d=P.explicit_dnp(b,'123','SEA');raw={P.raw_hash(P.encoded(v)):P.encoded(v)for v in[]}
obs=list(b['observations'].values())
print(json.dumps({'d':d,'raw_match':all(P.raw_hash(v)==k for k,v in b['raw_objects'].items()),'calls':len(s.calls),
 'pages':[(q['team_id'],q['page'])for q in s.calls if q['profile']==P.ROSTER],
 'clocks_ordered':all(P.instant(a['observed_utc'])<=P.instant(z['fetch_started_utc'])for a,z in zip(obs,obs[1:])),
 'upstream_unknown':all(o['provider_issued_utc']is None for o in obs),'audit':b['manifest']['audit']}))
`);
  assert.equal(r.d.explicit_dnp, true); assert.equal(r.d.played_inferred, false);
  assert.equal(r.d.provider_issued_utc, null); assert.equal(r.d.game_finish_utc, null); assert.equal(r.d.provider_coverage, 'unknown');
  assert.equal(r.raw_match, true); assert.equal(r.clocks_ordered, true); assert.equal(r.upstream_unknown, true);
  assert.deepEqual(r.pages, [['26', 1], ['26', 2], ['14', 1]]); assert.equal(r.audit.rows, 3);
});

test('false flags, absence, strings, numeric truthiness and unlocatable neighbors never become played or direct DNP', () => {
  const r = py(String.raw`
rows=[]
for roster in ([{'playerId':'123','didNotPlay':False}],[{'playerId':'124','didNotPlay':True}],
 [{'playerId':'123','didNotPlay':1}],[{'playerId':'123','didNotPlay':'true'}],[{'playerId':'123'}],
 [{'playerId':'123','didNotPlay':True},{'didNotPlay':False}]):
 b=capture(Provider(home=roster));rows.append(P.explicit_dnp(b,'123','SEA'))
print(json.dumps(rows))
`);
  assert.ok(r.every(row => row.explicit_dnp === null && row.played_inferred === false));
});

test('all declared pages and cross-team duplicate IDs are checked; invalid pages cannot publish a successful capture', () => {
  const r = py(String.raw`
errors=[]
for mode in('missing_page','count_changed','typed_page','wrong_index'):
 s=Provider()
 def mutate(q,v):
  if q['profile']==P.ROSTER and q['team_id']=='26':
   if mode=='missing_page'and q['page']==2:v['entries']=[]
   if mode=='count_changed'and q['page']==2:v['count']=3
   if mode=='typed_page':v['pageCount']=True
   if mode=='wrong_index':v['pageIndex']=2
 s.mutate=mutate;errors.append(error(lambda:capture(s)))
b=capture(Provider(away=[{'playerId':'123','didNotPlay':False},{'playerId':'201','didNotPlay':True}]))
same=capture(Provider(home=[{'playerId':'123','didNotPlay':True},{'playerId':'123','didNotPlay':True}]))
print(json.dumps({'errors':errors,'conflict':P.explicit_dnp(b,'123','SEA')['explicit_dnp'],
 'neighbor':P.explicit_dnp(b,'201','LAR')['explicit_dnp'],'duplicate':P.explicit_dnp(same,'123','SEA')['explicit_dnp']}))
`);
  assert.ok(r.errors.every(Boolean)); assert.equal(r.conflict, null); assert.equal(r.duplicate, null); assert.equal(r.neighbor, true);
});

test('FINAL_OT is supported but live, POST, period, team, event and arbitrary reference contradictions fail closed', () => {
  const r = py(String.raw`
rows={}
for mode in('ot','live','post','week','game','team','ref','competition_live','competition_post','roster_event','roster_team','roster_post','roster_ref'):
 s=Provider()
 def mutate(q,v):
  if q['profile']==P.SCOREBOARD:
   e=v['events'][0]
   if mode=='ot':e['status']['type']['name']='STATUS_FINAL_OVERTIME'
   if mode=='live':e['status']['type'].update(name='STATUS_IN_PROGRESS',completed=False)
   if mode=='post':v['season']['type']=3
   if mode=='week':v['week']['number']=4
  if q['profile']==P.COMPETITION:
   if mode=='game':v['id']='401999999'
   if mode=='ref':v['competitors'][0]['roster']['$ref']='https://evil.invalid/roster'
   if mode=='competition_live':v['status']={'type':{'name':'STATUS_IN_PROGRESS'}}
   if mode=='competition_post':v['season']['type']=3
  if q['profile']==P.TEAM and mode=='team':v['abbreviation']='BUF'
  if q['profile']==P.ROSTER:
   if mode=='roster_event':v['eventId']='401999999'
   if mode=='roster_team':v['teamId']='99'
   if mode=='roster_post':v['season']={'year':2026,'type':3}
   if mode=='roster_ref':v['$ref']='https://evil.invalid/roster'
 s.mutate=mutate
 try:b=capture(s);rows[mode]=P.explicit_dnp(b,'123','SEA')['explicit_dnp']
 except Exception:rows[mode]='held'
print(json.dumps(rows))
`);
  assert.equal(r.ot, true); assert.ok(Object.entries(r).filter(([key]) => key !== 'ot').every(([, value]) => value === 'held'));
});

test('saved captures are immutable exact-byte graphs; retries do not restamp and tamper or path escapes cannot redirect authority', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);b=capture();path=P.save_capture(b,root/'out');before={str(x):x.read_bytes()for x in(root/'out').rglob('*')if x.is_file()}
 loaded=P.load_capture(path);again=P.save_capture(loaded,root/'out')
 immutable=all(x.read_bytes()==before[str(x)]for x in(root/'out').rglob('*')if x.is_file())
 oid=next(iter(b['raw_objects']));damaged=copy.deepcopy(b);damaged['raw_objects'][oid]+=b' '
 errors=[error(lambda:P.verify_capture(damaged)),error(lambda:P.save_capture(b,P.ROOT/'data'/'not-created'))]
 target=root/'target';target.mkdir();(root/'link').symlink_to(target,target_is_directory=True)
 errors.append(error(lambda:P.save_capture(b,root/'link'/'child')))
 raw=next((root/'out'/'objects').glob('*.bin'));raw.write_bytes(b'changed')
 errors.append(error(lambda:P.load_capture(path)));errors.append(error(lambda:P.save_capture(b,root/'out')))
 print(json.dumps({'exact':loaded==b,'same_path':path==again,'immutable':immutable,'errors':errors,'no_link_write':not(target/'child').exists()}))
`);
  assert.equal(r.exact, true); assert.equal(r.same_path, true); assert.equal(r.immutable, true); assert.ok(r.errors.every(Boolean)); assert.equal(r.no_link_write, true);
});

test('callback/clock errors are static, bounded sources and canonical metadata are enforced, cancellation remains visible', () => {
  const r = py(String.raw`
errors=[];cancelled=[]
for mode in('transport','clock','oversize','status_bool','shape','regressed_clock'):
 def fetch(spec):
  if mode=='transport':raise RuntimeError('PRIVATE_TOKEN')
  if mode=='oversize':return 200,{},b'x'*(spec['maximum_bytes']+1)
  if mode=='status_bool':return True,{},b'{}'
  if mode=='shape':return [200,{},b'{}']
  return Provider()(spec)
 tick=clock()
 def now():
  if mode=='clock':raise RuntimeError('PRIVATE_TOKEN')
  if mode=='regressed_clock':return('2026-10-12T12:00:00Z'if not hasattr(now,'called')else'2026-10-11T12:00:00Z')
  return tick()
 if mode=='regressed_clock':
  ticklist=iter(['2026-10-12T12:00:00Z','2026-10-11T12:00:00Z']);now=lambda:next(ticklist)
 errors.append(error(lambda:P.capture(2026,5,GID,fetcher=fetch,clock=now)))
for exc in(KeyboardInterrupt(),SystemExit(7)):
 def cancelled_fetch(q):raise exc
 try:P.capture(2026,5,GID,fetcher=cancelled_fetch,clock=clock())
 except BaseException as e:cancelled.append(type(e).__name__)
b=capture()
for mode in('metadata_bool','metadata_huge','extra_object','missing_source'):
 d=copy.deepcopy(b)
 if mode=='metadata_bool':d['manifest']['version']=True;d['manifest']=P.seal({k:v for k,v in d['manifest'].items()if k!='capture_id'},'capture_id')
 if mode=='metadata_huge':d['manifest']['audit']['x']='x'*5000
 if mode=='extra_object':d['raw_objects'][P.raw_hash(b'extra')]=b'extra'
 if mode=='missing_source':d['manifest']['sources'].pop()
 errors.append(error(lambda:P.verify_capture(d)))
print(json.dumps({'errors':errors,'cancelled':cancelled,'redacted':'PRIVATE_TOKEN'not in json.dumps(errors)}))
`);
  assert.ok(r.errors.every(Boolean)); assert.equal(r.redacted, true); assert.deepEqual(r.cancelled, ['KeyboardInterrupt', 'SystemExit']);
});

test('a direct diagnostic never becomes a withholding signal, medical zero, clearance or complete historical inventory', () => {
  const r = py(String.raw`
b=capture();h=history();ctx=context();before=P.encoded(ctx);raw_before=dict(b['raw_objects'])
out=[G.evaluate(h,[b],ctx,clearance=c)for c in(None,{'status':'Active'},{'verified':True,'cleared_to_play':True})]
print(json.dumps({'out':out,'unchanged':P.encoded(ctx)==before and b['raw_objects']==raw_before}))
`);
  assert.ok(r.out.every(row => row.status === 'held_unknown' && row.shadow_signal === null && row.direct_dnp_observed === true));
  assert.ok(r.out.every(row => row.weight === 0 && !row.serving_changed && !row.eligibility_changed && !row.projection_changed && !row.medical_inference));
  assert.ok(r.out.every(row => !row.previous_game_inventory_verified && !row.clearance_authority_verified && row.clearance_status === 'unsupported_unknown'));
  assert.equal(r.unchanged, true);
});

test('the guard cannot skip a newer known FINAL, invent a bye/POST DNP, use another team or observe beyond its decision cutoff', () => {
  const r = py(String.raw`
b=capture();rows=[]
for mode in('newer','no_final','wrong_team','late_capture','target_changed','bad_version','duplicate','no_roster'):
 h=history(newer=mode=='newer',no_final=mode=='no_final');ctx=context(team='BUF')if mode=='wrong_team'else context()
 bundles=[b,b]if mode=='duplicate'else[]if mode=='no_roster'else[b]
 if mode=='late_capture':ctx=context(decision_utc='2026-10-12T12:00:10Z')
 if mode=='target_changed':ctx=context(target_game_id='401999999')
 if mode=='bad_version':ctx=context(version=True)
 rows.append({'mode':mode,'result':G.evaluate(h,bundles,ctx)})
print(json.dumps(rows))
`);
  assert.ok(r.every(row => row.result.status === 'held_unknown' && row.result.shadow_signal === null && row.result.direct_dnp_observed === null));
  assert.equal(r.find(row => row.mode === 'newer').result.reason, 'latest_known_final_roster_missing');
  assert.equal(r.find(row => row.mode === 'newer').result.known_final_game_id, '401800055');
  assert.equal(r.find(row => row.mode === 'no_final').result.reason, 'no_prior_known_final');
});

test('bounded plain context/metadata checks precede normalization, hashing and raw-history parsing', () => {
  const r = py(String.raw`
rows=[];h=history();b=capture()
class ForeignDict(dict):
 def __iter__(self):raise AssertionError('PRIVATE_CALLBACK')
for mode in('huge_team','custom_context','custom_value','oversize_metadata','deep_metadata','byte_budget'):
 ctx=context();history_value=copy.deepcopy(h)
 if mode=='huge_team':ctx['team']='x'*5000
 if mode=='custom_context':ctx=ForeignDict(ctx)
 if mode=='custom_value':ctx['team']=ForeignDict()
 if mode=='oversize_metadata':history_value['manifest']['audit']={'x'+str(i):'y'*4096 for i in range(300)}
 if mode=='deep_metadata':
  nested=None
  for _ in range(18):nested={'next':nested}
  history_value['manifest']['audit']=nested
 with mock.patch.object(C,'verify_capture',side_effect=AssertionError('not yet parse'))as verify:
  if mode in('huge_team','custom_context','custom_value'):
   with mock.patch.object(G,'normalize_team',side_effect=AssertionError('not yet normalize'))as normalize,mock.patch.object(P,'fingerprint',side_effect=AssertionError('not yet hash'))as hashed:
    out=G.evaluate(history_value,[b],ctx);extra={'normalize':normalize.call_count,'hash':hashed.call_count}
  elif mode=='byte_budget':
   with mock.patch.object(P,'MAX_TOTAL',1):out=G.evaluate(history_value,[b],ctx);extra={}
  else:out=G.evaluate(history_value,[b],ctx);extra={}
  rows.append({'mode':mode,'status':out['status'],'verify':verify.call_count,**extra})
print(json.dumps(rows))
`);
  assert.ok(r.every(row => row.status === 'held_unknown' && row.verify === 0));
  assert.ok(r.filter(row => 'normalize' in row).every(row => row.normalize === 0 && row.hash === 0));
});

after(() => {
  FILES.forEach((name, i) => {
    assert.equal(createHash('sha256').update(readFileSync(ROOT + name)).digest('hex'), hashes[i]);
    const executable = JSON.parse(execFileSync('python3', ['-c', `import json,trace;print(json.dumps(sorted(x for x in trace._find_executable_linenos(${JSON.stringify(ROOT + name)})if x>0)))`], { encoding: 'utf8' }));
    const total = new Set([...executable, ...covered[i]]).size;
    console.log(JSON.stringify({ source: name, sha256: hashes[i], covered: covered[i].size, total,
      percent: 100 * covered[i].size / total, scope: 'candidate-profile-synthetic-mechanics-not-provider-wire-or-empirical-replay' }));
  });
});
