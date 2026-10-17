import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarizeConcentration,renderConcentrationRisk,paintConcentrationRisk} from '../../app/portfolio-risk.js';
import {buildCards,poolLegs,dialLegs,DIALS} from '../../app/views/myparlays.js';
import {correlationTable} from '../../app/parlay-math.js';

const games=[{game_id:'g1',home:'A',away:'B',week:6},{game_id:'g2',home:'C',away:'D',week:6}];
const prop=(extra={})=>({game_id:'g1',gsis_id:'p1',market:'wr_rec_yds',selection:'Alpha 40+ rec yds',line:39.5,...extra});
const card=(...legs)=>({legs});
const source=(name)=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');

test('one repeated prop has a measured card blast radius, not a guessed joint probability',()=>{
 const cards=[card(prop(),prop()),card(prop()),card(prop({gsis_id:'p2',selection:'Beta 40+ rec yds'}))];
 const before=structuredClone(cards),r=summarizeConcentration(cards,games,6);
 assert.equal(r.selections[0].cards,2,'one card cannot count the same leg twice');
 assert.equal(r.games[0].cards,3,'two legs from one game count one card');
 assert.equal(r.unverifiedGames,0);assert.equal(r.unverifiedSelections,0);
 const html=renderConcentrationRisk(r);
 assert.match(html,/2\/3 share one selection/);assert.match(html,/One loss.*defeats 2 of these 3 shown cards/);
 assert.match(html,/A shared game is not necessarily a shared selection/);
 assert.match(html,/Counts overlap; do not add/);assert.match(html,/No joint win probability/);
 assert.match(html,/ranking and prices are unchanged/);assert.deepEqual(cards,before);
 assert.equal(r.pZeroWinners,undefined);assert.equal(r.expectedWinners,undefined);
});

test('different players, markets, lines and events never collapse by abbreviated label',()=>{
 for(const change of [{gsis_id:'p2'},{market:'rb_rush_yds'},{line:49.5},{game_id:'g2'}]){
  const r=summarizeConcentration([card(prop()),card(prop(change))],games,6);
  assert.equal(r.selections.length,2);assert.ok(r.selections.every(row=>row.cards===1));
  assert.ok(!renderConcentrationRisk(r).includes('One loss'));
 }
 const spread={game_id:'g1',market:'spread',selection:'A cover',line:3};
 const r=summarizeConcentration([card(spread),card({...spread,line:7})],games,6);
 assert.equal(r.selections.length,2);
});

test('missing player, malformed line and conflicting player IDs leave selection exposure unverified',()=>{
 for(const change of [{gsis_id:null},{line:null},{line:true},{line:NaN},{owner:'another-player'},
  {gsis_id:'team:A'},{market:'unmodeled'}]){
  const r=summarizeConcentration([card(prop(change)),card(prop(change))],games,6);
  assert.equal(r.selections.length,0);assert.equal(r.unverifiedSelections,2);
  assert.equal(r.games[0].cards,2);assert.ok(!renderConcentrationRisk(r).includes('One loss'));
  assert.match(renderConcentrationRisk(r),/exposure may be understated/);
 }
});

test('unknown events, contradictory card/event identity and conflicting schedules never invent shared games',()=>{
 const cases=[[[card(prop({game_id:null})),card(prop({game_id:null}))],games],
  [[{game_id:'g2',legs:[prop()]},{game_id:'g2',legs:[prop()]}],games],
  [[card(prop()),card(prop())],[...games,{game_id:'g1',home:'X',away:'Y',week:6}]],
  [[card(prop()),card(prop())],games.map(g=>({...g,week:5}))]];
 for(const [cards,schedule]of cases){
  const r=summarizeConcentration(cards,schedule,6);
  assert.deepEqual(r.games,[]);assert.deepEqual(r.selections,[]);assert.equal(r.unverifiedGames,2);
  assert.match(renderConcentrationRisk(r),/identity incomplete/);
  assert.ok(!renderConcentrationRisk(r).includes('One loss'));
 }
});

test('moneyline event inference requires one matching game and a consistent selected team',()=>{
 const ml={market:'moneyline',selection:'A ML'};
 let r=summarizeConcentration([card(ml),card(ml)],games,6);
 assert.equal(r.games[0].cards,2);assert.equal(r.selections[0].cards,2);
 r=summarizeConcentration([card(ml),card(ml)],[...games,{game_id:'g3',home:'A',away:'Z',week:6}],6);
 assert.equal(r.games.length,0);assert.equal(r.unverifiedGames,2);
 r=summarizeConcentration([{game_id:'g1',legs:[ml]},{game_id:'g1',legs:[ml]}],games,6);
 assert.equal(r.selections[0].cards,2);
 r=summarizeConcentration([card({...ml,game_id:'g2'}),card({...ml,game_id:'g2'})],games,6);
 assert.equal(r.games.length,0);assert.equal(r.unverifiedGames,2);
});

test('opposing selections share a game but never acquire a false common-loss claim',()=>{
 const r=summarizeConcentration([card({market:'moneyline',game_id:'g1',selection:'A ML'}),
  card({market:'moneyline',game_id:'g1',selection:'B ML'})],games,6);
 assert.equal(r.games[0].cards,2);assert.ok(r.selections.every(row=>row.cards===1));
 const html=renderConcentrationRisk(r);
 assert.match(html,/2\/2 share one game/);assert.ok(!html.includes('One loss'));
 assert.match(html,/not necessarily a shared selection or one common losing result/);
});

test('actual MY builder output has exact seed exposure without changing cards, ranking or prices',()=>{
 const schedule=Array.from({length:7},(_,i)=>({game_id:'g'+i,home:'A'+i,away:'B'+i,week:6}));
 const pool={players:schedule.map((g,i)=>({gsis_id:'p'+i,player:'Alpha '+i,team:g.home,side:'home',
  game_id:g.game_id,position:'WR',market:'wr_rec_yds',mu:60,p_team:.6,
  rungs:[{line:39.5,z:.1,selection:'Alpha '+i+' 40+ rec yds',model_prob:.55-i*.005}]})),game_legs:[]};
 const legs=dialLegs(poolLegs(pool),DIALS.even),seeds=[{kind:'player',id:'p0',name:'Alpha 0'}],table=correlationTable(null);
 const cards=buildCards(legs,seeds,table),before=structuredClone(cards);
 assert.equal(cards.length,10);
 const summary=summarizeConcentration(cards,schedule,6);
 assert.equal(summary.unverifiedSelections,0);assert.equal(summary.unverifiedGames,0);
 assert.equal(summary.selections[0].cards,cards.length);
 assert.match(summary.selections[0].label,/Alpha 0/);
 for(const row of summary.selections){
  const [id,market,owner,line,selection]=JSON.parse(row.key);
  const expected=cards.filter(c=>c.legs.some(l=>l.game_id===id&&l.market===market&&l.owner===owner&&l.line===line&&l.selection===selection)).length;
  assert.equal(row.cards,expected);
 }
 assert.deepEqual(cards,before);assert.deepEqual(buildCards(legs,seeds,table),before);
});

test('empty, singleton and disjoint card sets do not manufacture an exposure warning',()=>{
 for(const cards of [[],[card(prop())],[card(prop()),card(prop({game_id:'g2',gsis_id:'p2'}))]]){
  assert.equal(renderConcentrationRisk(summarizeConcentration(cards,games,6)),'');
 }
});

test('original labels are escaped and longest three rows are bounded without hiding the largest count',()=>{
 const legs=Array.from({length:5},(_,i)=>prop({gsis_id:'p'+i,selection:'<img src=x onerror=alert(1)> '+i}));
 const html=renderConcentrationRisk(summarizeConcentration([card(...legs),card(...legs)],games,6));
 assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);
 assert.equal((html.match(/<li>/g)||[]).length,4,'three selections plus one game');
 assert.match(html,/2\/2 share one selection/);
});

test('repaint clears old warning on missing seeds/cards, then reflects only the new shown set',()=>{
 const host={innerHTML:'old private warning',hidden:false};
 paintConcentrationRisk(host,[card(prop()),card(prop())],games,6);
 assert.equal(host.hidden,false);assert.match(host.innerHTML,/2\/2/);
 paintConcentrationRisk(host,[],games,6);assert.equal(host.innerHTML,'');assert.equal(host.hidden,true);
 paintConcentrationRisk(host,[card(prop({game_id:'g2',gsis_id:'p2',selection:'New'})),card(prop({game_id:'g2',gsis_id:'p2',selection:'New'}))],games,6);
 assert.match(host.innerHTML,/New/);assert.ok(!host.innerHTML.includes('Alpha'));
 assert.doesNotThrow(()=>paintConcentrationRisk(null,[],games,6));
 const my=source('app/views/myparlays.js');
 assert.match(my,/paintConcentrationRisk\(risk, \[\]\)/);
 assert.match(my,/state\.shown = \[\]/);
 assert.match(my,/paintConcentrationRisk\(risk, cards, state\.games/);
 const slate=source('app/views/parlays.js');
 assert.match(slate,/active === 'game'[\s\S]{0,100}renderConcentrationRisk\(summarizeConcentration\(shown/);
});

test('Game cards use original event identity and each event is counted once per shown card',()=>{
 const doc=JSON.parse(source('data/parlays.json')),schedule=JSON.parse(source('data/schedule_full.json'));
 const cards=doc.parlays.filter(c=>c.scope==='game'),before=structuredClone(cards);
 const r=summarizeConcentration(cards,schedule.games,doc.week);
 assert.ok(cards.length>0);assert.ok(r.games.length>0);
 for(const row of r.games)assert.equal(row.cards,cards.filter(c=>String(c.game_id)===row.key).length);
 assert.deepEqual(cards,before);
 const css=source('app/theme.css');
 assert.match(css,/\.portfolio-concentration\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
 assert.match(css,/\.card-list > \.portfolio-concentration\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});
