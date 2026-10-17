import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy, datetime as dt, hashlib, io, json, os, pathlib, tempfile
from contextlib import redirect_stdout
from unittest.mock import patch
from scripts import capture_outcome_evidence as C
STATS=(b'\\xef\\xbb\\xbfseason,week,season_type,position,team,player_display_name,passing_yards,rushing_yards,receiving_yards\\r\\n'
       b'2026,6,REG,WR,SEA,Fixture Receiver,,,NA\\r\\n'
       b'2026,6,REG,WR,SEA,Negative Receiver,,,-7\\r\\n'
       b'2026,6,REG,QB,SEA,Fixture Quarterback,0,,\\r\\n')
SNAPS=(b'season,week,game_type,team,player,offense_snaps\\n'
       b'2026,6,REG,SEA,Fixture Receiver,40\\n'
       b'2026,6,REG,LAR,Other Receiver,52\\n')
def event(gid='g1',status='STATUS_FINAL',hs='24',away='17'):
    return {'id':gid,'date':'2026-10-18T20:25:00Z','status':{'type':{'name':status}},
        'competitions':[{'competitors':[
            {'homeAway':'home','team':{'abbreviation':'SEA'},'score':hs},
            {'homeAway':'away','team':{'abbreviation':'LAR'},'score':away}]}]}
def scoreboard(events=None,week=6):
    return json.dumps({'season':{'year':2026},'week':{'number':week},
                      'events':[event()] if events is None else events}).encode()
class Clock:
    def __init__(self):self.n=0
    def __call__(self):
        stamp=dt.datetime(2026,10,19,2,tzinfo=dt.timezone.utc)+dt.timedelta(seconds=self.n)
        self.n+=1
        return stamp.isoformat().replace('+00:00','Z')
class Fetcher:
    def __init__(self,overrides=None):self.calls=[];self.overrides=overrides or {}
    def __call__(self,spec):
        self.calls.append(copy.deepcopy(spec))
        raw=self.overrides.get(spec['profile'])
        if raw is None:raw=STATS if spec['profile']==C.STATS_PROFILE else SNAPS if spec['profile']==C.SNAPS_PROFILE else scoreboard([event('g'+str(spec['week']))],week=spec['week'])
        return 200,{'ETag':'fixture-etag','Last-Modified':'Fri, 01 Jan 2021 00:00:00 GMT'},raw
def bundle(fetcher=None,weeks=None):
    return C.capture(2026,weeks or [6],fetcher=fetcher or Fetcher(),clock=Clock(),sleep=lambda _:None)
def error(fn):
    try:fn()
    except C.CaptureError as exc:return str(exc)
    return None
def reseal(b):
    b['manifest']['capture_id']=C._fingerprint({k:v for k,v in b['manifest'].items() if k!='capture_id'})
    return b
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('default CLI plans only code-owned profiles: no network, credentials or writes', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    out=pathlib.Path(tmp)/'not-created'; stream=io.StringIO()
    with patch.object(C,'http_fetcher',side_effect=AssertionError('network must not run')),redirect_stdout(stream):
        code=C.main(['--season','2026','--week','6','--out-dir',str(out)])
    print(json.dumps({'code':code,'output':json.loads(stream.getvalue()),'written':out.exists()}))
`);
  assert.equal(r.code, 0);
  assert.equal(r.output.mode, 'dry_run');
  assert.equal(r.output.network_used, false);
  assert.equal(r.output.writes, false);
  assert.equal(r.written, false);
  assert.deepEqual(r.output.sources.map((s) => s.profile),
    ['espn_scoreboard_v1', 'nflverse_stats_player_v1', 'nflverse_snap_counts_v1']);
});

test('capture observes scoreboards before stats/snaps, preserves exact raw bytes and unknown clocks', () => {
  const r = py(`
fetch=Fetcher(); b=bundle(fetch,weeks=[6,5]); obs=[C.source_observation(b,s['profile'],s['week']) for s in b['manifest']['sources']]
print(json.dumps({'profiles':[s['profile'] for s in fetch.calls],'weeks':b['manifest']['weeks'],
 'raw_exact':b['raw_objects'][obs[2]['raw_sha256']]==STATS,
 'digest':'sha256:'+hashlib.sha256(STATS).hexdigest(), 'raw_digest':obs[2]['raw_sha256'],
 'times':[o['observed_utc'] for o in obs], 'upstream':[o['upstream_updated_utc'] for o in obs],
 'classes':[o['evidence_class'] for o in obs],
 'stats':C.csv_rows(b,C.STATS_PROFILE),'games':C.scoreboard_rows(b),
 'http':obs[2]['http'],'publication':b['manifest']['publication_status']}))
`);
  assert.deepEqual(r.profiles, ['espn_scoreboard_v1', 'espn_scoreboard_v1', 'nflverse_stats_player_v1', 'nflverse_snap_counts_v1']);
  assert.deepEqual(r.weeks, [5, 6]);
  assert.equal(r.raw_exact, true);
  assert.equal(r.digest, r.raw_digest);
  assert.deepEqual(r.times, [...r.times].sort());
  assert.deepEqual(r.upstream, [null, null, null, null]);
  assert.ok(r.classes.every((v) => v === 'observed_source_snapshot'));
  assert.equal(r.stats[0].receiving_yards, 'NA');
  assert.equal(r.stats[1].receiving_yards, '-7');
  assert.equal(r.stats[2].passing_yards, '0');
  assert.ok(r.games.every((g) => g.final_utc === null && g.upstream_updated_utc === null));
  assert.equal(r.http.last_modified, 'Fri, 01 Jan 2021 00:00:00 GMT', 'HTTP metadata is retained, not promoted to source issue time');
  assert.equal(r.publication, 'source_capture_not_public_forecast_evidence');
});

test('immutable save/replay preserves first observations and raw-byte encodings without re-fetch', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    b=bundle(); path=C.save_capture(b,tmp); before={str(p):p.read_bytes() for p in pathlib.Path(tmp).rglob('*') if p.is_file()}
    with patch.object(C,'http_fetcher',side_effect=AssertionError('replay cannot fetch')):
        loaded=C.load_capture(path); same=C.save_capture(loaded,tmp)
        stream=io.StringIO()
        with redirect_stdout(stream):code=C.main(['--capture',str(path)])
    print(json.dumps({'exact':loaded==b,'same':same==path,'bytes_unchanged':before=={str(p):p.read_bytes() for p in pathlib.Path(tmp).rglob('*') if p.is_file()},
                      'code':code,'cli':json.loads(stream.getvalue())}))
`);
  assert.equal(r.exact, true);
  assert.equal(r.same, true);
  assert.equal(r.bytes_unchanged, true);
  assert.equal(r.code, 0);
  assert.equal(r.cli.mode, 'verified_replay');
  assert.equal(r.cli.network_used, false);
  assert.equal(r.cli.writes, false);
});

test('FINAL and OT normalize only complete integer scores; live/stub scores never become results', () => {
  const r = py(`
events=[event('regular'),event('ot','STATUS_FINAL_OVERTIME','27','24'),
        event('live','STATUS_IN_PROGRESS','31','0'),event('stub','STATUS_SCHEDULED','0','0'),
        event('fraction','STATUS_FINAL',1.5,'0'),event('boolean','STATUS_FINAL',True,'0'),
        event('nan','STATUS_FINAL','NaN','0'),event('negative','STATUS_FINAL','-1','0')]
b=bundle(Fetcher({C.SCOREBOARD_PROFILE:scoreboard(events)})); rows=C.scoreboard_rows(b)
print(json.dumps({'rows':rows,'audit':C.source_observation(b,C.SCOREBOARD_PROFILE,6)['audit']}))
`);
  assert.deepEqual(r.rows.map((g) => g.game_id), ['live', 'ot', 'regular', 'stub']);
  assert.equal(r.rows.find((g) => g.game_id === 'ot').home_score, 27);
  for (const row of r.rows.filter((g) => !g.final)) {
    assert.equal(Object.hasOwn(row, 'home_score'), false);
    assert.equal(Object.hasOwn(row, 'away_score'), false);
  }
  assert.equal(r.audit.final_games, 2);
  assert.equal(r.audit.invalid_final_scores, 4);
});

test('conflicting duplicate game identities quarantine every copy; exact duplicates are audited', () => {
  const r = py(`
events=[event('conflict'),event('conflict',hs='30'),event('same'),event('same'),event('good')]
b=bundle(Fetcher({C.SCOREBOARD_PROFILE:scoreboard(events)}))
print(json.dumps({'ids':[g['game_id'] for g in C.scoreboard_rows(b)],
 'audit':C.source_observation(b,C.SCOREBOARD_PROFILE,6)['audit'],
 'raw_events':len(json.loads(b['raw_objects'][C.source_observation(b,C.SCOREBOARD_PROFILE,6)['raw_sha256']])['events'])}))
`);
  assert.deepEqual(r.ids, ['good', 'same']);
  assert.equal(r.audit.duplicate_events, 2);
  assert.equal(r.audit.conflicting_game_ids, 1);
  assert.equal(r.raw_events, 5, 'quarantine does not rewrite source evidence');
});

test('cross-week repeated game IDs are withheld globally, including single-week helper reads', () => {
  const r = py(`
base=Fetcher()
def fetch(spec):
    if spec['profile']!=C.SCOREBOARD_PROFILE:return base(spec)
    return 200,{},scoreboard([event('shared'),event('good'+str(spec['week']))],week=spec['week'])
b=bundle(fetch,weeks=[5,6])
with tempfile.TemporaryDirectory() as tmp:
    loaded=C.load_capture(C.save_capture(b,tmp))
    print(json.dumps({'ids':[g['game_id'] for g in C.scoreboard_rows(loaded)],
      'week6':[g['game_id'] for g in C.scoreboard_rows(loaded,6)],'audit':loaded['manifest']['audit']}))
`);
  assert.deepEqual(r.ids, ['good5', 'good6']);
  assert.deepEqual(r.week6, ['good6']);
  assert.deepEqual(r.audit.cross_week_conflicting_game_ids, ['shared']);
  assert.deepEqual(r.audit.quarantined_game_ids, ['shared']);
});

test('contradictory nested completion, season/week and REG metadata cannot create FINAL evidence', () => {
  const r = py(`
events=[event('valid')]
for kind in ('competition_status','completed_false','competition_completed_false','event_week','event_season','event_postseason'):
    item=event(kind)
    if kind=='competition_status':item['competitions'][0]['status']={'type':{'name':'STATUS_IN_PROGRESS'}}
    elif kind=='completed_false':item['status']['type']['completed']=False
    elif kind=='competition_completed_false':item['competitions'][0]['status']={'type':{'name':'STATUS_FINAL','completed':False}}
    elif kind=='event_week':item['week']={'number':5}
    elif kind=='event_season':item['season']={'year':2025}
    elif kind=='event_postseason':item['season']={'year':2026,'type':3}
    events.append(item)
b=bundle(Fetcher({C.SCOREBOARD_PROFILE:scoreboard(events)}))
post=json.loads(scoreboard());post['season']['type']=3
print(json.dumps({'ids':[g['game_id'] for g in C.scoreboard_rows(b)],'audit':b['manifest']['audit'],
 'postseason_source':error(lambda:bundle(Fetcher({C.SCOREBOARD_PROFILE:json.dumps(post).encode()})))}))
`);
  assert.deepEqual(r.ids, ['valid']);
  assert.equal(r.audit.quarantined_game_ids.length, 6);
  assert.equal(r.postseason_source, 'scoreboard_season_type_mismatch');
});

test('CSV duplicates and missing/negative cells remain raw; malformed schemas fail capture', () => {
  const r = py(`
duplicate=STATS+STATS.splitlines(keepends=True)[1]
b=bundle(Fetcher({C.STATS_PROFILE:duplicate}))
results={}
for label,raw in {'duplicate_header':b'season,season,week\\n2026,2026,6\\n',
                  'missing_column':b'season,week,position\\n2026,6,WR\\n',
                  'short_row':STATS+b'2026,6\\n','bad_encoding':b'\\xff',
                  'wrong_season':STATS.replace(b'2026,6',b'2025,6'),
                  'empty_rows':STATS.splitlines(keepends=True)[0]}.items():
    results[label]=error(lambda:bundle(Fetcher({C.STATS_PROFILE:raw})))
print(json.dumps({'audit':C.source_observation(b,C.STATS_PROFILE)['audit'],
                  'raw_rows':len(C.csv_rows(b,C.STATS_PROFILE)),'errors':results}))
`);
  assert.equal(r.audit.duplicate_rows, 1);
  assert.equal(r.raw_rows, 4);
  assert.ok(Object.values(r.errors).every(Boolean));
});

test('full-season CSV capture preserves postseason rows without treating them as requested REG games', () => {
  const r = py(`
raw=STATS+b'2026,19,POST,WR,SEA,Postseason Receiver,,,80\\r\\n'
b=bundle(Fetcher({C.STATS_PROFILE:raw}))
print(json.dumps({'weeks':[r['week'] for r in C.csv_rows(b,C.STATS_PROFILE)],
 'capture_weeks':b['manifest']['weeks'],'audit':C.source_observation(b,C.STATS_PROFILE)['audit']}))
`);
  assert.deepEqual(r.weeks, ['6', '6', '6', '19']);
  assert.deepEqual(r.capture_weeks, [6]);
  assert.equal(r.audit.outside_regular_week_rows, 1);
});

test('malformed, duplicate-key, empty or wrong-period scoreboard is not a complete successful capture', () => {
  const r = py(`
bad=[b'not-json',b'{}',scoreboard([]),scoreboard(week=5),b'{"events":[],"events":[{}]}',
     b'{"events":[NaN]}',b'{"events":[1e999]}']
print(json.dumps([error(lambda raw=raw:bundle(Fetcher({C.SCOREBOARD_PROFILE:raw}))) for raw in bad]))
`);
  assert.ok(r.every(Boolean));
});

test('only bounded transient transport/429/5xx failures retry; no incomplete manifest is returned', () => {
  const r = py(`
class Retry:
    def __init__(self,failures):self.failures=iter(failures);self.calls=0;self.good=Fetcher()
    def __call__(self,spec):
        self.calls+=1
        try:failure=next(self.failures)
        except StopIteration:return self.good(spec)
        if isinstance(failure,Exception):raise failure
        return failure,{},b''
wire=Retry([OSError('sensitive socket'),429]); sleeps=[]
b=C.capture(2026,[6],fetcher=wire,clock=Clock(),sleep=sleeps.append)
permanent=Retry([404]); exhausted=Retry([503,503,503]); unexpected=Retry([RuntimeError('sensitive source text')])
print(json.dumps({'calls':wire.calls,'sleeps':sleeps,'complete':b['manifest']['capture_id'].startswith('sha256:'),
 'permanent':error(lambda:bundle(permanent)),'permanent_calls':permanent.calls,
 'exhausted':error(lambda:bundle(exhausted)),'exhausted_calls':exhausted.calls,
 'unexpected':error(lambda:bundle(unexpected))}))
`);
  assert.equal(r.calls, 5);
  assert.deepEqual(r.sleeps, [1, 2]);
  assert.equal(r.complete, true);
  assert.equal(r.permanent, 'source_http_unavailable');
  assert.equal(r.permanent_calls, 1);
  assert.equal(r.exhausted, 'source_transport_exhausted');
  assert.equal(r.exhausted_calls, 3);
  assert.equal(r.unexpected, 'source_transport_failure');
});

test('source and total raw-byte budgets fail before producing a complete capture', () => {
  const r = py(`
with patch.object(C,'CSV_LIMIT',len(STATS)-1):source_error=error(bundle)
total=len(STATS)+len(SNAPS)+len(scoreboard([event('g6')]))
with patch.object(C,'CAPTURE_LIMIT',total-1):total_error=error(bundle)
print(json.dumps({'source':source_error,'total':total_error}))
`);
  assert.equal(r.source, 'source_body_too_large');
  assert.equal(r.total, 'capture_body_too_large');
});

test('regressing or naive observation clocks and missing explicit periods are refused', () => {
  const r = py(`
values=iter(['2026-10-19T02:00:00Z','2026-10-19T02:00:01Z','2026-10-19T01:59:00Z'])
bad_clock=error(lambda:C.capture(2026,[6],fetcher=Fetcher(),clock=lambda:next(values)))
invalid=[]
for season,weeks in [(True,[6]),(2026,[]),(2026,[True]),(2026,[0]),(2026,[19]),(2026,[6,6])]:
    invalid.append(error(lambda:C.fetch_plan(season,weeks)))
print(json.dumps({'regressed':bad_clock,'naive':error(lambda:C.capture(2026,[6],fetcher=Fetcher(),clock=lambda:'2026-10-19T02:00:00')),
                  'invalid':invalid}))
`);
  assert.equal(r.regressed, 'observation_clock_regressed');
  assert.equal(r.naive, 'invalid_observation_clock');
  assert.ok(r.invalid.every(Boolean));
});

test('content-addressed raw bytes, observation metadata, source profiles and manifest filenames are verified', () => {
  const r = py(`
results={}
for label in ('raw','observation','profile','filename','missing'):
    with tempfile.TemporaryDirectory() as tmp:
        b=bundle(); path=C.save_capture(b,tmp); source=b['manifest']['sources'][0]; oid=source['observation_id']; obs=b['observations'][oid]
        rawpath=pathlib.Path(tmp)/'objects'/(obs['raw_sha256'].split(':')[1]+'.bin')
        obspath=pathlib.Path(tmp)/'observations'/(oid.split(':')[1]+'.json')
        if label=='raw':rawpath.write_bytes(rawpath.read_bytes()+b' ')
        elif label=='observation':
            value=json.loads(obspath.read_bytes());value['observed_utc']='2026-10-19T03:00:00Z';obspath.write_text(json.dumps(value))
        elif label=='profile':
            value=json.loads(path.read_bytes());value['sources'][0]['profile']='https://attacker.invalid';path.write_text(json.dumps(value))
        elif label=='filename':
            wrong=path.parent/('0'*64+'.json');path.rename(wrong);path=wrong
        elif label=='missing':rawpath.unlink()
        results[label]=error(lambda:C.load_capture(path))
print(json.dumps(results))
`);
  assert.ok(Object.values(r).every(Boolean));
});

test('forged source URL, boolean/float identity types, extra objects and clocks cannot be resealed into valid captures', () => {
  const r = py(`
results={}
for kind in ('url','float_season','float_week','invented_upstream','extra_raw','missing_source'):
    b=bundle(); source=b['manifest']['sources'][0]; oid=source['observation_id']; obs=b['observations'][oid]
    if kind=='url':obs['source_url']='http://127.0.0.1/private'
    elif kind=='float_season':obs['season']=2026.0
    elif kind=='float_week':source['week']=6.0
    elif kind=='invented_upstream':obs['upstream_updated_utc']=obs['observed_utc']
    elif kind=='extra_raw':b['raw_objects'][C._raw_hash(b'extra')]=b'extra'
    elif kind=='missing_source':b['manifest']['sources'].pop()
    if kind in ('url','float_season','invented_upstream'):
        changed=C._fingerprint(obs);b['observations'][changed]=b['observations'].pop(oid);source['observation_id']=changed
    reseal(b)
    with tempfile.TemporaryDirectory() as tmp:results[kind]=error(lambda:C.save_capture(b,tmp))
print(json.dumps(results))
`);
  assert.ok(Object.values(r).every(Boolean));
});

test('output cannot overlap sports data or follow content-path symlinks; immutable conflicts fail closed', () => {
  const r = py(`
b=bundle(); output_errors=[error(lambda:C.save_capture(b,C._ROOT/'data'/'capture-forbidden')),
                          error(lambda:C.save_capture(b,C._ROOT))]
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); actual=root/'other';actual.mkdir();(root/'objects').symlink_to(actual,target_is_directory=True)
    symlink_error=error(lambda:C.save_capture(b,root))
with tempfile.TemporaryDirectory() as tmp:
    path=C.save_capture(b,tmp);path.write_bytes(b'corrupt')
    conflict_error=error(lambda:C.save_capture(b,tmp))
print(json.dumps({'outputs':output_errors,'symlink':symlink_error,'conflict':conflict_error}))
`);
  assert.ok(r.outputs.every(Boolean));
  assert.equal(r.symlink, 'capture_path_symlink');
  assert.equal(r.conflict, 'immutable_capture_conflict');
});

test('public fetcher uses 30-second timeout, bounded reads and no credential headers', () => {
  const r = py(`
seen={}
class Response:
    status=200;headers={'Content-Type':'text/csv'}
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,maximum):seen['maximum']=maximum;return STATS
class Opener:
    def open(self,request,timeout):
        seen.update(url=request.full_url,timeout=timeout,headers=dict(request.header_items()))
        return Response()
with patch.object(C.urllib.request,'build_opener',return_value=Opener()):
    status,headers,raw=C.http_fetcher(C.source_spec(C.STATS_PROFILE,2026))
print(json.dumps({'seen':seen,'status':status,'exact':raw==STATS,
 'forged':error(lambda:C.http_fetcher({**C.source_spec(C.STATS_PROFILE,2026),'source_url':'http://127.0.0.1/secrets'}))}))
`);
  assert.equal(r.seen.timeout, 30);
  assert.equal(r.seen.maximum, 16 * 1024 * 1024 + 1);
  assert.ok(Object.keys(r.seen.headers).every((h) => !['authorization', 'apikey', 'cookie'].includes(h.toLowerCase())));
  assert.equal(r.status, 200);
  assert.equal(r.exact, true);
  assert.equal(r.forged, 'source_spec_mismatch');
});

test('only fixed GitHub release asset redirects are permitted; ESPN and private redirects are refused', () => {
  const r = py(`
request=C.urllib.request.Request(C.source_spec(C.STATS_PROFILE,2026)['source_url'])
allowed=C._ProfileRedirect(C.STATS_PROFILE).redirect_request(request,None,302,'',{},'https://release-assets.githubusercontent.com/example/asset.csv?public=signed')
errors=[]
for profile,url in [(C.SCOREBOARD_PROFILE,'https://site.api.espn.com/elsewhere'),
                    (C.STATS_PROFILE,'http://release-assets.githubusercontent.com/asset'),
                    (C.STATS_PROFILE,'https://127.0.0.1/asset'),
                    (C.STATS_PROFILE,'https://github.com.attacker.invalid/asset'),
                    (C.STATS_PROFILE,'https://user:password@github.com/asset')]:
    errors.append(error(lambda:C._ProfileRedirect(profile).redirect_request(request,None,302,'',{},url)))
redirect=C._ProfileRedirect(C.STATS_PROFILE)
for _ in range(3):redirect.redirect_request(request,None,302,'',{},'https://objects.githubusercontent.com/asset')
errors.append(error(lambda:redirect.redirect_request(request,None,302,'',{},'https://objects.githubusercontent.com/asset')))
print(json.dumps({'allowed':allowed.full_url.startswith('https://release-assets.githubusercontent.com/'),'errors':errors}))
`);
  assert.equal(r.allowed, true);
  assert.ok(r.errors.every(Boolean));
});
