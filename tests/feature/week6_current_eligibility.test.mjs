// Current-main acceptance projection: exact provider IDs and original Week6
// gate fields, not complete provider coverage or a new prediction replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));
const setup=String.raw`
import copy,hashlib,json,pathlib
from scripts import availability as av,build_weekly as bw
from scripts.models.parlay_builder import playable_this_week
root=pathlib.Path.cwd()
f=json.loads((root/'tests/fixtures/week6_eligibility_20261016.json').read_text())
players=f['players'];doc=f['injuries'];week=f['week'];now=f['observed_utc']
def emit(value):print(json.dumps(value,allow_nan=False))
`;
function run(source){
  const p=spawnSync('python3',['-'],{cwd:root,input:setup+source,encoding:'utf8',
    timeout:20000,maxBuffer:2*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(p.status,0,p.stderr+p.stdout);
  return JSON.parse(p.stdout);
}

test('pinned current-main source matches local eligibility consumers, without declaring provider completeness',()=>{
  const o=run(String.raw`
codes={}
for name,expected in f['source_code_blobs'].items():
 raw=(root/name).read_bytes()
 codes[name]=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==expected
state=bw.injury_source_state(doc,now,week)
emit({'codes':codes,'state':state,'rows':len(doc['injuries']),'players':len(players),
 'vocab':doc['vocab_version'],'limitations':f['limitations']})
`);
  assert.equal(Object.keys(o.codes).length,4);
  assert.ok(Object.values(o.codes).every(Boolean),'Changed eligibility code requires a fresh current-input comparison');
  assert.equal(o.rows,800);assert.equal(o.players,300);assert.equal(o.vocab,2);
  assert.equal(o.state.verified,true);assert.equal(o.state.reason,null);
  assert.ok(o.state.age_hours>=0&&o.state.age_hours<12);
  assert.ok(o.limitations.some(s=>s.includes('not proof of provider completeness')));
});

test('actual Week6 roster withholds exactly33 players:19 exact-ID status decisions and14 depth decisions',()=>{
  const o=run(String.raw`
held=[p for p in players if not playable_this_week(p,week)]
feed={str(p['athlete_id']):p for p in doc['injuries']}
status=[p for p in held if p.get('this_week',{}).get('reason')=='status']
counts={}
for p in status:
 code=p['this_week']['status'];counts[code]=counts.get(code,0)+1
 assert feed[p['gsis_id'].removeprefix('espn-')]['availability']==code
 assert av.normalize_status(feed[p['gsis_id'].removeprefix('espn-')]['status'])==code
assert sorted(p['gsis_id']for p in held)==f['expected']['held_player_ids']
emit({'held':len(held),'status':len(status),'counts':counts,
 'depth':sum(p.get('this_week',{}).get('reason')=='depth'for p in held),
 'undocumented':[p['gsis_id']for p in held if p.get('this_week',{}).get('reason')not in('status','depth')]})
`);
  assert.equal(o.held,33);assert.equal(o.status,19);assert.equal(o.depth,14);
  assert.deepEqual(o.counts,{OUT:4,DOUBTFUL:5,IR:10});assert.deepEqual(o.undocumented,[]);
});

test('an injected identifiable unknown status on the actual300-player roster gates only that player',()=>{
  const o=run(String.raw`
before=copy.deepcopy(players)
target=next(p for p in players if playable_this_week(p,week))
fault=copy.deepcopy(doc)
fault['quarantine']=[{'athlete_id':target['gsis_id'].removeprefix('espn-'),
 'status':'SYNTHETIC_UNMAPPED_DESIGNATION','reason':'unmapped_status'}]
state=bw.injury_source_state(fault,now,week)
scope=av.quarantine_scope(players,fault['quarantine'])
decisions={p['gsis_id']:bw.injury_eligibility(p,fault,state,week,scope=scope)for p in players}
blocked={pid:v for pid,v in decisions.items()if v is not None}
emit({'verified':state['verified'],'blocked':blocked,'target':target['gsis_id'],
 'unchanged':players==before,'source_eligibility_unaffected':len(decisions)-len(blocked),
 'original_held':sum(not playable_this_week(p,week)for p in players),
 'combined_held':sum(not playable_this_week(p,week)or decisions[p['gsis_id']]is not None for p in players)})
`);
  assert.equal(o.verified,true);assert.deepEqual(Object.keys(o.blocked),[o.target]);
  assert.equal(o.blocked[o.target].eligible,false);assert.equal(o.blocked[o.target].detail,'quarantined_status');
  assert.equal(o.source_eligibility_unaffected,299);assert.equal(o.unchanged,true);
  assert.equal(o.original_held,33);assert.equal(o.combined_held,34);
});

test('missing provider timestamp or wrong report week is explicit source uncertainty, never a fabricated medical zero',()=>{
  const o=run(String.raw`
before=copy.deepcopy(players);reports=[]
for name in ('missing_provider_time','wrong_week'):
 fault=copy.deepcopy(doc)
 if name=='missing_provider_time':fault['source_updated_utc']=None
 else:fault['week']=5
 state=bw.injury_source_state(fault,now,week)
 decisions=[bw.injury_eligibility(p,fault,state,week)for p in players]
 assert all(d['eligible']is False and d['reason']=='source_unverified'for d in decisions)
 reports.append({'name':name,'reason':state['reason'],'held':len(decisions)})
emit({'reports':reports,'unchanged':players==before})
`);
  assert.deepEqual(o.reports,[{name:'missing_provider_time',reason:'missing_timestamp',held:300},
    {name:'wrong_week',reason:'wrong_week',held:300}]);assert.equal(o.unchanged,true);
});
