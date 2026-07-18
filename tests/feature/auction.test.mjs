/* tests/feature/auction.test.mjs — the auction engine's pure core, locked.
 *
 * Money conservation (pools sum exactly to the room's budget), VOR ordering,
 * inflation math, nomination classification (BAIT/TARGET), tendency learning,
 * bid caps, determinism, and a full simulated auction that never overdraws a
 * budget and fills every roster.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUDGET, MIN_BID, maxBid, marketDollars, fairDollars, inflation,
  classifyNomination, tendencyUpdate, planBudget, createAuction, myTeam,
  onTheNomination, autoNominate, nominate, resolveBids, sellTo, undoLastSale,
  liveInflation, myGuidance, nominationAdvice, scoreAuction,
} from '../../app/auction.js';
import { rosterShape } from '../../app/draft-sim.js';

/* ---- fixtures --------------------------------------------------------------- */

function board(n = 80) {
  const positions = ['RB', 'WR', 'QB', 'TE'];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      name: `P${i + 1}`, position: positions[i % 4], team: 'KC',
      adp: i + 1, gsis_id: `id-${i + 1}`,
    });
  }
  return rows;
}

const adjMap = (rows) => new Map(rows.map((r, i) => [String(r.gsis_id), 320 - i * 3.5]));

function newAuction(overrides = {}) {
  const rows = board();
  return createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 }, // 11 slots
    boardRows: rows, adjPointsById: adjMap(rows), seed: 11, ...overrides,
  });
}

/* ---- money math ------------------------------------------------------------- */

test('maxBid always reserves $1 per remaining open slot', () => {
  assert.equal(maxBid(200, 13), 188);
  assert.equal(maxBid(5, 5), 1);
  assert.equal(maxBid(1, 1), 1);
  assert.equal(maxBid(0, 3), 0);
});

test('marketDollars: the draftable pool absorbs EXACTLY the room budget', () => {
  const rows = board(300);
  const m = marketDollars(rows, 12, DEFAULT_BUDGET, 13);
  const poolN = 12 * 13;
  let sum = 0;
  for (let i = 0; i < poolN; i += 1) sum += m.get(`id-${i + 1}`);
  assert.equal(sum, 12 * DEFAULT_BUDGET, 'every dollar lands in the pool');
  // Monotone non-increasing over ADP rank; everyone past the pool is $1.
  for (let i = 1; i < poolN; i += 1) {
    assert.ok(m.get(`id-${i + 1}`) <= m.get(`id-${i}`) || i === 1,
      `rank ${i + 1} costs more than rank ${i}`);
  }
  assert.equal(m.get('id-200'), MIN_BID);
  // Top pick lands in the classic 25-35% of budget band.
  assert.ok(m.get('id-1') > 0.2 * DEFAULT_BUDGET && m.get('id-1') < 0.4 * DEFAULT_BUDGET);
});

test('fairDollars: better players cost more, floor is $1, budget-scaled', () => {
  const rows = board();
  const shape = rosterShape({ qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 });
  const adj = adjMap(rows);
  const f = fairDollars(rows, (r) => adj.get(String(r.gsis_id)) || 0, 4, 200, shape);
  assert.ok(f.get('id-1') > f.get('id-5'), 'higher points, higher price');
  assert.equal(f.get('id-80'), MIN_BID, 'replacement-level players cost $1');
  const f300 = fairDollars(rows, (r) => adj.get(String(r.gsis_id)) || 0, 4, 300, shape);
  assert.ok(f300.get('id-1') > f.get('id-1'), 'bigger budget, bigger prices');
});

test('inflation: money chasing value', () => {
  assert.equal(inflation(800, 800), 1);
  assert.ok(inflation(900, 800) > 1);
  assert.ok(inflation(500, 800) < 1);
  assert.equal(inflation(500, 0), 1, 'empty pool degrades to neutral');
});

/* ---- strategy math ---------------------------------------------------------- */

test('classifyNomination: BAIT when market overprices, TARGET when we do', () => {
  assert.equal(classifyNomination(20, 35), 'BAIT');
  assert.equal(classifyNomination(35, 20), 'TARGET');
  assert.equal(classifyNomination(30, 31), 'NEUTRAL');
  assert.equal(classifyNomination(2, 4), 'NEUTRAL', 'small-dollar noise ignored');
});

test('tendencyUpdate: EW-learns overpay ratio, clamped', () => {
  const t1 = tendencyUpdate(null, 30, 20);          // paid 1.5x market
  assert.ok(t1 > 1 && t1 < 1.5);
  let t = 1;
  for (let i = 0; i < 20; i += 1) t = tendencyUpdate(t, 40, 20);
  assert.ok(t <= 1.6, `clamped at 1.6 (got ${t})`);
  let u = 1;
  for (let i = 0; i < 20; i += 1) u = tendencyUpdate(u, 10, 20);
  assert.ok(u >= 0.6, `clamped at 0.6 (got ${u})`);
});

test('planBudget: stars front-loads, balanced spreads, both sum exactly', () => {
  const shape = rosterShape(null); // 7 starters + 6 bench
  const stars = planBudget(shape, 200, 'stars');
  const bal = planBudget(shape, 200, 'balanced');
  const sum = (p) => p.slots.reduce((s, r) => s + r.planned, 0) + p.benchDollars;
  assert.equal(sum(stars), 200);
  assert.equal(sum(bal), 200);
  assert.ok(stars.slots[0].planned > bal.slots[0].planned, 'stars spends up top');
  assert.ok(stars.slots[6].planned < bal.slots[6].planned, 'stars starves the tail');
});

/* ---- room simulation --------------------------------------------------------- */

test('a full simulated auction fills every roster and never overdraws', () => {
  const a = newAuction();
  let guard = 0;
  while (!a.done && guard < 500) {
    guard += 1;
    const idx = autoNominate(a);
    if (idx < 0) break;
    nominate(a, idx);
    const g = myGuidance(a, idx);
    const { winnerIdx, price } = resolveBids(a, g.bidTo);
    sellTo(a, winnerIdx, price, idx);
  }
  assert.ok(a.done, 'auction reaches completion');
  for (const t of a.teams) {
    assert.ok(t.budget >= 0, 'no negative budgets');
    assert.equal(t.players.length, a.shape.size, 'roster filled to size');
  }
  // Money conservation: total spent = total budgets minus what remains.
  const spent = a.log.reduce((s, l) => s + l.price, 0);
  const remaining = a.teams.reduce((s, t) => s + t.budget, 0);
  assert.equal(spent + remaining, 4 * 200);
});

test('auctions are deterministic for a fixed seed', () => {
  const run = () => {
    const a = newAuction();
    while (!a.done) {
      const idx = autoNominate(a);
      if (idx < 0) break;
      nominate(a, idx);
      const { winnerIdx, price } = resolveBids(a, myGuidance(a, idx).bidTo);
      sellTo(a, winnerIdx, price, idx);
    }
    return a.log;
  };
  assert.deepEqual(run(), run());
});

test('sellTo learns room tendencies from observed overpays (not from me)', () => {
  const a = newAuction();
  nominate(a, 0);
  const key = String(a.board[0].gsis_id);
  const market = a.market.get(key);
  sellTo(a, 0, Math.round(market * 1.5), 0);       // team 1 overpays 1.5x
  assert.ok(a.teams[0].tendencies[a.board[0].position] > 1,
    'observed overpay raises that team\'s positional tendency');
  nominate(a, 1);
  sellTo(a, a.mySlot - 1, 10, 1);                  // my own buy
  assert.equal(Object.keys(myTeam(a).tendencies).length, 0,
    'my own buys never update my tendency profile');
});

test('nomination rotates and inflation moves after rich sales', () => {
  const a = newAuction();
  assert.equal(onTheNomination(a), 0);
  const before = liveInflation(a);
  nominate(a, 0);
  sellTo(a, 0, 150, 0);                            // huge overpay drains money
  assert.equal(onTheNomination(a), 1, 'nomination passed to the next team');
  assert.ok(liveInflation(a) < before,
    'money left the room faster than value: deflation for everyone left');
});

test('myGuidance: caps at max bid, flags threats, classifies the block', () => {
  const a = newAuction();
  const g = myGuidance(a, 0, { tempo: 'aggressive' });
  assert.ok(g.bidTo <= g.cap, 'never advised past the legal max bid');
  assert.ok(g.fair >= MIN_BID && g.market >= MIN_BID);
  assert.ok(['BAIT', 'TARGET', 'NEUTRAL'].includes(g.class));
  for (const t of g.threats) {
    assert.ok(t.maxBid >= g.bidTo, 'a threat can actually outbid the advice');
  }
});

test('nominationAdvice: bait and target lists are disjoint and well-ordered', () => {
  const a = newAuction();
  const adv = nominationAdvice(a, {}, 5);
  const baitIds = new Set(adv.bait.map((b) => b.boardIdx));
  for (const t of adv.targets) assert.ok(!baitIds.has(t.boardIdx));
  for (const b of adv.bait) assert.ok(b.market > b.fair, 'bait = market over ours');
  for (const t of adv.targets) assert.ok(t.fair > t.market, 'target = ours over market');
});

test('scoreAuction reports margin, spend, and efficiency', () => {
  const a = newAuction();
  while (!a.done) {
    const idx = autoNominate(a);
    if (idx < 0) break;
    nominate(a, idx);
    const { winnerIdx, price } = resolveBids(a, myGuidance(a, idx).bidTo);
    sellTo(a, winnerIdx, price, idx);
  }
  const s = scoreAuction(a);
  assert.ok(Number.isFinite(s.mine) && Number.isFinite(s.roomAvg));
  assert.ok(s.spent >= 0 && s.spent <= 200);
  assert.ok(s.rank >= 1 && s.rank <= 4);
});

test('undoLastSale reverses a sale EXACTLY - budget, roster, tendency, inflation', () => {
  const a = newAuction();
  const snapshot = () => JSON.stringify({
    budgets: a.teams.map((t) => t.budget),
    rosters: a.teams.map((t) => t.players.length),
    tendencies: a.teams.map((t) => t.tendencies),
    remainingFair: a.remainingFair,
    nomIdx: a.nomIdx,
    taken: [...a.taken].sort(),
  });
  const before = snapshot();
  nominate(a, 0);
  const key = String(a.board[0].gsis_id);
  sellTo(a, 0, Math.round(a.market.get(key) * 1.4), 0);   // overpay -> tendency moved
  assert.notEqual(snapshot(), before, 'sale changed the room');
  const undone = undoLastSale(a);
  assert.equal(undone.boardIdx, 0);
  assert.equal(snapshot(), before, 'undo restored the room byte-for-byte');
  assert.equal(undoLastSale(a), null, 'nothing left to undo');
});

/* ---- Rel9.2 bug-hunt regressions: money can never be minted ------------------ */

test('sellTo clamps an over-budget LIVE entry - conservation is inviolable', () => {
  const a = newAuction();
  nominate(a, 0);
  sellTo(a, 0, 250, 0);                     // recorded above the $200 budget
  assert.equal(a.teams[0].budget, 0, 'buyer drained, never negative');
  assert.equal(a.log[0].price, 200, 'logged price is the clamped price');
  const spent = a.log.reduce((s, l) => s + l.price, 0);
  const remaining = a.teams.reduce((s, t) => s + t.budget, 0);
  assert.equal(spent + remaining, 4 * 200, 'no phantom dollars minted');
  // And undo still restores exactly (uses the clamped price).
  undoLastSale(a);
  assert.equal(a.teams[0].budget, 200);
});

test('resolveBids no-bidder fallback never sells to a team that cannot pay', () => {
  const a = newAuction();
  a.teams[0].budget = 0;                    // nominating team is broke
  nominate(a, 50);                          // deep player nobody wants
  const r = resolveBids(a, 0);
  if (r.price > 0) {
    assert.ok(a.teams[r.winnerIdx].budget >= r.price,
      'fallback winner can afford the minimum bid');
  }
  // Fully drained room: resolves at $0, still no phantom money.
  const b = newAuction();
  b.teams.forEach((t) => { t.budget = 0; });
  nominate(b, 50);
  const rb = resolveBids(b, 0);
  sellTo(b, rb.winnerIdx, rb.price, 50);
  const spent = b.log.reduce((s, l) => s + l.price, 0);
  const remaining = b.teams.reduce((s, t) => s + t.budget, 0);
  assert.equal(spent + remaining, 0, 'drained room stays at zero dollars');
});

test('nominationAdvice never classifies unprojected players (unknown != bait)', () => {
  const rows = board(40).concat([{ name: 'Famous Rookie', position: 'RB', adp: 5.5, gsis_id: null }])
    .sort((x, y) => x.adp - y.adp);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
    boardRows: rows, adjPointsById: adjMap(rows), seed: 3,
  });
  const adv = nominationAdvice(a, {}, 10);
  for (const list of [adv.bait, adv.targets]) {
    assert.ok(!list.some((x) => x.name === 'Famous Rookie'),
      'players without projections stay out of the advisor');
  }
});
