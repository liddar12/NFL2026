import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = `
import ast,copy,hashlib,json
from scripts.models import parlay_builder as pb
from scripts.validate_data import validate_against_schema
NOW='2026-10-15T12:00:00Z'
def games(n):
    return [{"game_id":"probe%d"%i,"home":h,"away":a,"probs":{"home":.7,"away":.3}}
            for i,(h,a) in enumerate([("KC","DEN"),("BUF","MIA"),("SEA","NE")][:n])]
def props(gs):
    return {g["game_id"]:[{"market":m,"selection":"P%d %s"%(i,m),"model_prob":.6,
            "_corr_tag":m,"_side":"home"} for i,m in enumerate(("qb_pass_yds","rb_rush_yds","wr_rec_yds"))] for g in gs}
def doc(gs,ps=None,markets=None):
    return pb.build_parlays_document(gs,2026,6,NOW,props_by_game=ps,markets_by_game=markets)
`;
function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {cwd:ROOT,encoding:'utf8',
    env:{...process.env,PYTHONPATH:ROOT},input:SETUP+'\n'+body}).trim().split('\n').pop());
}

test('zero-prop games retain first distinct bets and report exact shortfall; normal R126 choices unchanged', () => {
  const r=py(`
gs=games(3); ps=props(gs)
normal=doc(gs,ps)
expected=[c for g in gs for c in pb.build_game_parlays(g,props=ps[g["game_id"]])]
empty=doc(gs,{g["game_id"]:[] for g in gs})
market={"probe0":{"spread":{"home_point":-7.5,"home_cover_prob":.5,"away_cover_prob":.5,
                            "home_selection":"KC -7.5","away_selection":"DEN +7.5"}}}
spread=doc(gs,{g["game_id"]:[] for g in gs},market)
for d in (normal,empty,spread): validate_against_schema(d,json.load(open('data/contracts/parlays.schema.json')),'probe')
print(json.dumps({"normal_unchanged":[c for c in normal['parlays'] if c['scope']=='game']==expected,
 "normal_coverage":normal['candidate_coverage'],"empty":empty,"spread":spread}))
`);
  assert.equal(r.normal_unchanged,true);
  assert.deepEqual(r.normal_coverage.game_shortfalls,[]);
  assert.equal(r.normal_coverage.week_shortfall,null);
  assert.deepEqual(r.empty.parlays.filter(c=>c.scope==='game').map(c=>c.parlay_id),['probe0-g1','probe1-g1','probe2-g1']);
  for(const s of r.empty.candidate_coverage.game_shortfalls) {
    assert.equal(s.distinct_cards,1); assert.equal(s.duplicates_removed,2);
    assert.equal(s.shortfall,2); assert.equal(s.candidate_prop_count,0);
    assert.equal(s.reason,'no_eligible_prop_candidates');
  }
  assert.deepEqual(r.spread.parlays.filter(c=>c.game_id==='probe0').map(c=>c.parlay_id),['probe0-g1','probe0-g2']);
  assert.equal(r.spread.candidate_coverage.game_shortfalls[0].shortfall,1);
});

test('semantic guard rejects forged/missing/stale receipts and three renamed copies, not merely low counts', () => {
  const r=py(`
gs=games(3); good=doc(gs,{g['game_id']:[] for g in gs}); results={}
for kind in ('missing','count','generation','extra','duplicate','bool_count','prop_evidence'):
    d=copy.deepcopy(good)
    if kind=='missing': del d['candidate_coverage']
    if kind=='count': d['candidate_coverage']['game_shortfalls'][0]['distinct_cards']=2
    if kind=='generation': d['candidate_coverage']['generated_utc']='2026-10-14T12:00:00Z'
    if kind=='extra': d['candidate_coverage']['game_shortfalls'].append({**d['candidate_coverage']['game_shortfalls'][0],'game_id':'unknown'})
    if kind=='duplicate':
        d['parlays'] += [{**d['parlays'][0],'parlay_id':'different1'},{**d['parlays'][0],'parlay_id':'different2'}]
        d['candidate_coverage']['game_shortfalls']=d['candidate_coverage']['game_shortfalls'][1:]
    if kind=='bool_count': d['candidate_coverage']['game_shortfalls'][0]['distinct_cards']=True
    results[kind]=pb.parlay_coverage_problems(d,[g['game_id'] for g in gs],props(gs) if kind=='prop_evidence' else None)
print(json.dumps(results))
`);
  for(const [kind,errors] of Object.entries(r)) assert.ok(errors.length>0,kind);
  assert.match(r.duplicate.join(' '),/duplicate actual bets/);
  assert.match(r.prop_evidence.join(' '),/despite supplied eligible prop/);
});

test('tiny 0/1/2-game slates never manufacture repeated week cards', () => {
  const r=py(`
out=[]
for n in (0,1,2):
    d=doc(games(n),{})
    out.append({'n':n,'game':sum(c['scope']=='game' for c in d['parlays']),
      'week':sum(c['scope']=='week' for c in d['parlays']),'coverage':d['candidate_coverage'],
      'errors':pb.parlay_coverage_problems(d,[g['game_id'] for g in games(n)])})
print(json.dumps(out))
`);
  assert.deepEqual(r.map(x=>[x.game,x.week]),[[0,0],[1,0],[2,1]]);
  for(const row of r) {
    assert.deepEqual(row.errors,[]);
    assert.equal(row.coverage.week_shortfall.slate_games,row.n);
    assert.equal(row.coverage.week_shortfall.shortfall,3-row.week);
  }
});

test('actual-bet key distinguishes players and opposite predicates but ignores rank/order and numeric spelling', () => {
  const r=py(`
leg={'market':'wr_rec_yds','selection':'T. Johnson 60+','gsis_id':'one','line':60,'side':'home','direction':'over','comparison_operator':'gte'}
base={'scope':'game','game_id':'g','parlay_id':'a','legs':[leg]}
def key(**changes): return pb.parlay_bet_key({**base,'legs':[{**leg,**changes}]})
print(json.dumps({'numeric':key()==key(line=60.0),'player':key()!=key(gsis_id='two'),
 'direction':key()!=key(direction='under'),'operator':key()!=key(comparison_operator='gt'),
 'rank':pb.parlay_bet_key(base)==pb.parlay_bet_key({**base,'parlay_id':'b'}),
 'order':pb.parlay_bet_key({**base,'legs':[leg,{**leg,'gsis_id':'two'}]})==pb.parlay_bet_key({**base,'legs':[{**leg,'gsis_id':'two'},leg]})}))
`);
  for(const [k,v] of Object.entries(r)) assert.equal(v,true,k);
});

test('offline caller uses guarded document; engine failure refuses scaffold; archive omits live-only coverage without rewriting frozen cards', () => {
  const r=py(`
from scripts import build_all as ba, build_parlay_archive as archive
gdoc={'week':6,'games':games(3)}
d=ba.build_parlays(gdoc,NOW)
saved=ba._try_import; ba._try_import=lambda name:None
try: ba.build_parlays(gdoc,NOW); refused=False
except RuntimeError: refused=True
finally: ba._try_import=saved
first,_=archive.archive_doc(d,None,False,NOW)
first['parlays'][0]['frozen_utc']=NOW
frozen=copy.deepcopy(first['parlays'][0])
changed=copy.deepcopy(d); changed['updated_utc']='2026-10-15T13:00:00Z'; changed['parlays'][0]['model_ev']=99
later,_=archive.archive_doc(changed,first,False,changed['updated_utc'])
validate_against_schema(first,json.load(open('data/contracts/parlays_archive.schema.json')),'archive')
print(json.dumps({'coverage':d['candidate_coverage'],'refused':refused,'archive_coverage':'candidate_coverage' in first,
 'frozen_preserved':any(c==frozen for c in later['parlays'])}))
`);
  assert.ok(r.coverage.game_shortfalls.length>0);
  assert.equal(r.coverage.game_shortfalls[0].reason,'prop_inputs_not_supplied');
  assert.equal(r.refused,true);
  assert.equal(r.archive_coverage,false);
  assert.equal(r.frozen_preserved,true);
});

test('protected R126 ranking functions remain byte-identical to approved main', () => {
  const r=py(`
source=open('scripts/models/parlay_builder.py').read(); lines=source.splitlines(keepends=True)
out={n.name:hashlib.sha256(''.join(lines[n.lineno-1:n.end_lineno]).encode()).hexdigest()
 for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name in ('build_game_parlays','_rank_game_pairs')}
print(json.dumps(out))
`);
  assert.deepEqual(r,{
    build_game_parlays:'f2a9340ec02717f6c441b4fbdaf448b1caaa293acf5470f120b117632cb2eceb',
    _rank_game_pairs:'f855d30206f56285915a48879f060dc4ee517644d61f1ab5dde28d0250dfeb91',
  });
});
