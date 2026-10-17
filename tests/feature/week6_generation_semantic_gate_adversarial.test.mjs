// Independent semantic negatives over the genuine local producer fixture.
// Only code in this trusted checkout is executed. No uploaded code is imported.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SOURCE=ROOT+'scripts/generation_semantic_gate.py';
const sourceHash=()=>createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
const PIN=sourceHash();
const author=readFileSync(ROOT+'tests/feature/week6_generation_semantic_gate.test.mjs','utf8');
const start='const FIXTURE=String.raw`',end='\n`;\nfunction py';
assert.equal(author.split(start).length,2,'one trusted local fixture');
const FIXTURE=author.split(start)[1].split(end)[0];
assert.ok(FIXTURE.includes('def fixture(')&&FIXTURE.includes('def refreshed('));

function py(body){
 const output=execFileSync('python3',['-'],{cwd:ROOT,input:FIXTURE+'\n'+body,encoding:'utf8',
  timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim();
 return JSON.parse(output.split('\n').pop());
}

test('weekly metadata cannot contradict the same frozen projection identity; sparse and cosmetic identities remain valid',()=>{
 const rows=py(String.raw`
rows=[]
for mode in('baseline','matching','cosmetic_name','team','position','name'):
 f=fixture();weekly=f['docs']['player_weekly']['players'][0];projection=f['docs']['player_projections']['players'][0]
 if mode=='matching':weekly.update({k:projection[k]for k in('team','position','name')})
 elif mode=='cosmetic_name':weekly['name']='  PLAYER 1.  '
 elif mode=='team':weekly['team']='DAL'
 elif mode=='position':weekly['position']='RB'
 elif mode=='name':weekly['name']='Unrelated Receiver'
 f=refreshed(f);result=verify(f)
 rows.append({'mode':mode,'pass':result['supported_consumer_pass'],'reason':result['reason_codes'],'flags':all(result[k]is False for k in G.FLAGS)})
print(json.dumps(rows))
`);
 for(const row of rows){
  assert.equal(row.pass,['baseline','matching','cosmetic_name'].includes(row.mode),JSON.stringify(row));
  assert.equal(row.flags,true);
 }
});

test('raw Out, RETIRED or unknown status cannot self-authenticate as enriched ACTIVE; legitimate row quarantine keeps neighbors',()=>{
 const rows=py(String.raw`
rows=[]
for raw_status in('Out','Reserve-Ret','SYNTHETIC_UNKNOWN'):
 f=fixture();f['docs']['injuries']['injuries'][0]['status']=raw_status
 # Keep the original ACTIVE enrichment while producing all outputs anew. An
 # exact graph/hash or recomputation cannot make this contradiction healthy.
 f=refreshed(f);r=verify(f)
 rows.append({'status':raw_status,'pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
controls=[]
for args in({'q':True},{'unknown':True}):
 f=fixture(**args);r=verify(f);controls.append({'pass':r['supported_consumer_pass'],'players':len(f['pool']['players'])})
print(json.dumps({'negative':rows,'controls':controls}))
`);
 for(const row of rows.negative) assert.equal(row.pass,false,JSON.stringify(row));
 assert.deepEqual(rows.controls.map(r=>[r.pass,r.players]),[[true,4],[true,3]]);
});

test('current weekly matchup, week and flag types must agree with the original frozen team schedule',()=>{
 const rows=py(String.raw`
rows=[]
for mode in('opponent','home_side','float_week','integer_home','integer_bye','missing_opponent','missing_home'):
 f=fixture();row=next(w for w in f['docs']['player_weekly']['players'][0]['weeks']if w['wk']==6)
 if mode=='opponent':row['opp']='DAL'
 elif mode=='home_side':row['home']=False
 elif mode=='float_week':row['wk']=6.0
 elif mode=='integer_home':row['home']=1
 elif mode=='integer_bye':row['bye']=0
 elif mode=='missing_opponent':row.pop('opp')
 else:row.pop('home')
 f=refreshed(f);r=verify(f);rows.append({'mode':mode,'pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
print(json.dumps(rows))
`);
 for(const row of rows) assert.equal(row.pass,false,JSON.stringify(row));
});

test('source period identities are actual integers, never bool or equivalent floating point values',()=>{
 const rows=py(String.raw`
rows=[]
for source in('player_weekly','player_projections','game_predictions','schedule','parlays','injuries'):
 f=fixture();f['docs'][source]['season']=2026.0
 try:f=refreshed(f);r=verify(f)
 except G.GateError:r={'supported_consumer_pass':False,'reason_codes':['capture_refused']}
 except ValueError as exc:
  # Some consumers already choose their output season from this header and
  # the existing journal rejects it BEFORE a bound graph can be produced.
  # Count that exact safe refusal; do not turn arbitrary fixture bugs green.
  assert str(exc)=='learning journal requires an explicit season and week'
  r={'supported_consumer_pass':False,'reason_codes':['existing_producer_refused_period']}
 rows.append({'mode':source+'.season','pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
for source in('parlays','injuries'):
 f=fixture();f['docs'][source]['week']=6.0
 try:f=refreshed(f);r=verify(f)
 except G.GateError:r={'supported_consumer_pass':False,'reason_codes':['capture_refused']}
 except ValueError as exc:
  assert str(exc)=='learning journal requires an explicit season and week'
  r={'supported_consumer_pass':False,'reason_codes':['existing_producer_refused_period']}
 rows.append({'mode':source+'.week','pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
print(json.dumps(rows))
`);
 for(const row of rows) assert.equal(row.pass,false,JSON.stringify(row));
});

test('frozen player and game identifiers cannot be coerced from booleans or numbers into apparently valid string identities',()=>{
 const rows=py(String.raw`
rows=[]
for kind in('player','game'):
 for identifier in(True,123):
  f=fixture()
  if kind=='player':
   f['docs']['player_weekly']['players'][0]['gsis_id']=identifier;f['docs']['player_projections']['players'][0]['gsis_id']=identifier
  else:
   f['docs']['game_predictions']['games'][0]['game_id']=identifier;f['docs']['schedule']['games'][0]['game_id']=identifier
  f=refreshed(f);r=verify(f);rows.append({'kind':kind,'identifier':identifier,'pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
f=fixture();f['docs']['game_predictions']['games'][0]['game_id']='123';f['docs']['schedule']['games'][0]['game_id']='123'
f=refreshed(f);positive=verify(f)
print(json.dumps({'negative':rows,'string_identity':positive['supported_consumer_pass']}))
`);
 for(const row of rows.negative) assert.equal(row.pass,false,JSON.stringify(row));
 assert.equal(rows.string_identity,true,'a genuinely supplied string identity remains valid');
});

test('explicit ESPN identity cannot lose a correctly canonical Out/RETIRED status through a projection display-name change',()=>{
 const rows=py(String.raw`
rows=[]
for status in('Out','Reserve-Ret'):
 f=fixture();injury=f['docs']['injuries'];raw=dict(injury['injuries'][0]);raw['status']=status
 injury['injuries'][0]={**raw,**A.enrich(raw)};injury['counts']=A.counts(injury['injuries'])
 assert injury['injuries'][0]['athlete_id']=='1'
 assert f['docs']['player_projections']['players'][0]['gsis_id']=='espn-1'
 f['docs']['player_projections']['players'][0]['name']='Unrelated Receiver'
 # Both explicit IDs still name the same athlete. A name-only legacy lookup
 # cannot make the known blocked source medical status disappear.
 f=refreshed(f);r=verify(f);rows.append({'status':status,'pass':r['supported_consumer_pass'],'reason':r['reason_codes']})
f=fixture();injury=f['docs']['injuries'];raw=dict(injury['injuries'][0]);raw['status']='Out'
injury['injuries'][0]={**raw,**A.enrich(raw)};injury['counts']=A.counts(injury['injuries'])
players=f['docs']['player_projections']['players'];games=f['docs']['game_predictions']['games']
f['docs']['player_weekly']=W.build_weekly_document(players,games,{t:1500. for t in('SEA','LAR','DAL','PHI')},{},2026,WEEKLY,
 injuries=[],first_week=6,components_by_id={p['gsis_id']:{'components':{'rec_yd':80.,'pass_yd':220.},'base_applied_pts':100.}for p in players},
 factors=W.build_factors(2026),this_week=6,injury_document=injury)
f=refreshed(f);r=verify(f)
print(json.dumps({'negative':rows,'properly_withheld':{'pass':r['supported_consumer_pass'],'players':[p['gsis_id']for p in f['pool']['players']]}}))
`);
 for(const row of rows.negative) assert.equal(row.pass,false,JSON.stringify(row));
 assert.equal(rows.properly_withheld.pass,true,'a properly gated Out player does not invalidate healthy neighbors');
 assert.equal(rows.properly_withheld.players.length,3);
 assert.ok(!rows.properly_withheld.players.includes('espn-1'));
});

after(()=>assert.equal(sourceHash(),PIN,'author source remains frozen during independent tests'));
