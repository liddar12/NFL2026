import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gradeLeg } from '../../app/bets.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy, json, pathlib, tempfile
from scripts import resolve_parlay_legs as RL, resolve_my_cards as RM, build_bet_facts as BF
from scripts.validate_data import validate_against_schema, check_bet_facts
MARKETS={'QB':('qb_pass_yds','passing_yards','pass'),
         'RB':('rb_rush_yds','rushing_yards','rush'),
         'WR':('wr_rec_yds','receiving_yards','rec')}
def row(pos='WR',value='NA',name='Fixture Receiver'):
    out={'season':'2026','week':'6','season_type':'REG','position':pos,'team':'SEA',
         'player_display_name':name,'passing_yards':'','rushing_yards':'','receiving_yards':'',
         'rushing_tds':'','receiving_tds':''}
    out[MARKETS[pos][1]]=value
    return out
def leg(pos='WR',name='Fixture Receiver'):
    market,_,label=MARKETS[pos]
    return {'season':2026,'week':6,'game_id':'g1','gsis_id':'espn-fixture','market':market,
            'position':pos,'player':name,'team':'SEA','home':'SEA','away':'LAR','side':'home',
            'selection':'F. Receiver 40+ '+label+' yds','line':39.5,'locked':True,
            'p_team':.6,'model_prob':.7}
def snaps(team='SEA'):
    return {6:{'teams':{team},'rows':[{'norm':'fixture receiver','team':team,'snaps':40.0}]}}
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: FIXTURE + body,
  }).trim().split('\n').pop());
}

test('required yardage NA, missing, malformed and nonfinite remain pending in both graders', () => {
  const result = py(`
values=[None,'','NA','bad','NaN','Infinity','-inf',float('nan'),float('inf'),True,[],{}]
results=[]
for pos in MARKETS:
    for value in values:
        raw=row(pos,value); index=RL.index_stats([raw]); item=leg(pos)
        resolved,unknown,weeks=RL.resolve_props({'legs':[item]},[raw])
        results.append({'pos':pos,'unknown':index[6][0]['yards'][pos] is None,
                        'grade':RM.grade_prop(item,6,index,snaps()),
                        'resolved':resolved,'reason':[u['reason'] for u in unknown], 'weeks':weeks})
print(json.dumps(results,allow_nan=False))
`);
  assert.equal(result.length, 36);
  for (const row of result) {
    assert.equal(row.unknown, true, row.pos);
    assert.deepEqual(row.grade, ['pending', null, 'missing_stat_value']);
    assert.deepEqual(row.resolved, []);
    assert.deepEqual(row.reason, ['missing_stat_value']);
    assert.deepEqual(row.weeks, [6], 'an invalid cell is still a published row, not no_stat_line');
  }
});

test('numeric zero, negative yardage, exact line and positive actuals are preserved', () => {
  const result = py(`
results=[]
for pos in MARKETS:
    for value in ('0','-7.5','39.5','40',0,-7.5,40.0):
        raw=row(pos,value); item=leg(pos)
        resolved,unknown,_=RL.resolve_props({'legs':[item]},[raw])
        results.append({'value':float(value),'grade':RM.grade_prop(item,6,RL.index_stats([raw])),
                        'actual':resolved[0]['actual'],'hit':resolved[0]['hit'],'unknown':unknown})
print(json.dumps(results,allow_nan=False))
`);
  assert.equal(result.length, 21);
  for (const row of result) {
    const hit = row.value >= 39.5;
    assert.deepEqual(row.grade, [hit ? 'hit' : 'miss', row.value, null]);
    assert.equal(row.actual, row.value);
    assert.equal(row.hit, hit);
    assert.deepEqual(row.unknown, []);
  }
});

test('R106 absent-row participation fallback remains evidence-based, not a missing-cell repair', () => {
  const result = py(`
other=row('QB','250','Other Quarterback'); index=RL.index_stats([other]); item=leg()
sheet=snaps(); absent={6:{'teams':{'SEA'},'rows':[{'norm':'other quarterback','team':'SEA','snaps':50.0}]}}
bad=RL.index_stats([row()])
print(json.dumps({'played':RM.grade_prop(item,6,index,sheet),
 'dnp':RM.grade_prop(item,6,index,absent),'no_snaps':RM.grade_prop(item,6,index),
 'other_team':RM.grade_prop(item,6,index,snaps('LAR')),
 'week_absent':RM.grade_prop(item,6,{},sheet),
 'bad_cell_with_snaps':RM.grade_prop(item,6,bad,sheet)}))
`);
  assert.deepEqual(result.played, ['miss', 0, null]);
  assert.deepEqual(result.dnp, ['void', null, 'did_not_play']);
  assert.deepEqual(result.no_snaps, ['pending', null, 'no_stat_line']);
  assert.deepEqual(result.other_team, ['pending', null, 'no_stat_line']);
  assert.deepEqual(result.week_absent, ['pending', null, 'week_not_published']);
  assert.deepEqual(result.bad_cell_with_snaps, ['pending', null, 'missing_stat_value']);
});

test('one invalid measurement does not abort a valid neighboring leg or fabricate a zero', () => {
  const result = py(`
good=leg(name='Other Receiver'); good['selection']='O. Receiver 40+ rec yds'
resolved,unknown,_=RL.resolve_props({'legs':[leg(),good]},[row(),row(value='72',name='Other Receiver')])
print(json.dumps({'resolved':resolved,'unknown':unknown},allow_nan=False))
`);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].actual, 72);
  assert.equal(result.resolved[0].hit, true);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].reason, 'missing_stat_value');
});

test('MY BETS facts schema and browser keep unknown measurement pending; known zero and negatives settle', () => {
  const result = py(`
raw=[row(value='NA',name='Unknown Receiver'),row(value='0',name='Zero Receiver'),
     row(value='-5',name='Negative Receiver'),row(value='70',name='Positive Receiver')]
idents={str(i):{'name':r['player_display_name'],'team':'SEA','position':'WR'} for i,r in enumerate(raw)}
games=[{'game_id':'g1','week':6,'home':'SEA','away':'LAR','kickoff_utc':'2026-10-18T20:25:00Z'}]
doc=BF.build(games,{'g1':{'home_score':24,'away_score':17}},idents,
             RL.index_stats(raw),RL.index_td(raw),snaps(),[],2026,'2026-10-19T02:00:00Z','fixture')
validate_against_schema(doc,json.load(open('data/contracts/bet_facts.schema.json')),'facts')
check_bet_facts(doc)
print(json.dumps({'facts':doc,'legs':[dict(leg(name=r['player_display_name']),gsis_id=str(i))
                                   for i,r in enumerate(raw)]},allow_nan=False))
`);
  const players = result.facts.weeks['6'].players;
  assert.equal(players['0'].y, null);
  assert.equal(players['0'].td, 0, 'blank TD components retain the existing stat-row convention');
  assert.deepEqual(players['1'].y, [0, 0, 0]);
  assert.deepEqual(players['2'].y, [0, 0, -5]);
  assert.deepEqual(players['3'].y, [0, 0, 70]);
  assert.deepEqual(result.legs.map((leg) => gradeLeg(leg, result.facts).result),
    ['pending', 'miss', 'miss', 'hit']);
});

test('finals index independently requires explicit FINAL or FINAL_OVERTIME and complete integer scores', () => {
  const result = py(`
rows=[]
for i,status in enumerate((None,'FINAL','STATUS_SCHEDULED','STATUS_IN_PROGRESS','STATUS_POSTPONED',
                           'STATUS_FINAL','STATUS_FINAL_OVERTIME')):
    rows.append({'game_id':str(i),'status':status,'final':True,'home_score':'24','away_score':17})
for i,status in enumerate(([],{},True,1)):
    rows.append({'game_id':'status'+str(i),'status':status,'home_score':24,'away_score':17})
for i,value in enumerate((None,True,-1,1.5,'NaN','Infinity',[],{})):
    rows.append({'game_id':'bad'+str(i),'status':'STATUS_FINAL','home_score':value,'away_score':0})
rows.extend([None,{}, {'game_id':'missing_status','home_score':24,'away_score':17},
             {'game_id':'zero','status':'STATUS_FINAL','home_score':0,'away_score':0}])
print(json.dumps(RL.finals_index(rows),allow_nan=False))
`);
  assert.deepEqual(result, {
    5: { home_score: 24, away_score: 17 },
    6: { home_score: 24, away_score: 17 },
    zero: { home_score: 0, away_score: 0 },
  });
});

test('--finals file route and injected ESPN fetch cannot grade live or status-less score rows', () => {
  const result = py(`
rows=[{'game_id':'live','status':'STATUS_IN_PROGRESS','home_score':7,'away_score':0},
      {'game_id':'missing','home_score':24,'away_score':17},
      {'game_id':'done','status':'STATUS_FINAL','home_score':24,'away_score':17},
      {'game_id':'ot','status':'STATUS_FINAL_OVERTIME','home_score':27,'away_score':24}]
with tempfile.TemporaryDirectory() as tmp:
    path=pathlib.Path(tmp)/'finals.json'; path.write_text(json.dumps({'games':rows}))
    file_finals,_=RL.load_finals(str(path),offline=True)
    path.write_text(json.dumps(rows))
    array_finals,_=RL.load_finals(str(path),offline=True)
fetched,notes=RL.fetch_finals_espn(2026,[6],fetch=lambda wk:rows)
leg_live={**leg(),'game_id':'live','market':'moneyline','selection':'SEA ML'}
leg_done={**leg(),'game_id':'done','market':'moneyline','selection':'SEA ML'}
resolved,unknown=RL.resolve_games({'legs':[leg_live,leg_done]},file_finals)
print(json.dumps({'file':file_finals,'array':array_finals,'fetched':fetched,'notes':notes,
 'my_live':RM.grade_game(leg_live,file_finals),'my_done':RM.grade_game(leg_done,file_finals),
 'resolved_ids':[r['game_id'] for r in resolved],'unknown':unknown}))
`);
  const expected = { done: { home_score: 24, away_score: 17 }, ot: { home_score: 27, away_score: 24 } };
  assert.deepEqual(result.file, expected);
  assert.deepEqual(result.array, expected);
  assert.deepEqual(result.fetched, expected);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.my_live, ['pending', null, 'no_final']);
  assert.deepEqual(result.my_done, ['hit', { home_score: 24, away_score: 17 }, null]);
  assert.deepEqual(result.resolved_ids, ['done']);
  assert.deepEqual(result.unknown, []);
});

test('existing intended FINAL inline fixtures retain every asserted outcome', () => {
  for (const script of ['scripts/resolve_parlay_legs.py', 'scripts/resolve_my_cards.py', 'scripts/build_bet_facts.py']) {
    execFileSync('python3', [script, '--selftest'], { cwd: ROOT, stdio: 'pipe' });
  }
});
