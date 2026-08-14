/* tests/feature/auction.test.mjs — the auction engine's pure core, locked.
 *
 * Money conservation (pools sum exactly to the room's budget), VOR ordering,
 * inflation math, nomination classification (BAIT/TARGET), tendency learning,
 * bid caps, determinism, and a full simulated auction that never overdraws a
 * budget and fills every roster.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_BUDGET, MIN_BID, MARKET_DECAY, maxBid, marketDollars, fairDollars,
  inflation, classifyNomination, tendencyUpdate, planBudget, createAuction,
  myTeam, onTheNomination, autoNominate, nominate, resolveBids, sellTo,
  undoLastSale, liveInflation, myGuidance, nominationAdvice, scoreAuction,
  canBuy, buyerOptions,
} from '../../app/auction.js';
import { rosterShape } from '../../app/draft-sim.js';
import { positionDemand } from '../../app/team-logic.js';

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

/* ---- R19-B4: shape-driven demand, shared with the fit engine ---------------- */

test('fairDollars: shape-derived demand is byte-identical to the old flex-spread literal', () => {
  // The old arithmetic, written out: fixed starters + flexCount x {RB .45, WR .45,
  // TE .10}, replacement = round(demand x teams) - 1. positionDemand() must
  // reproduce it exactly for every shape the draft room can build, or every
  // fair price in the room shifts.
  const flexShare = { RB: 0.45, WR: 0.45, TE: 0.10 };
  const configs = [null, { qb: 2 }, { flex: 0 }, { flex: 2 }, { rb: 3, te: 2, flex: 2 },
    { qb: 2, rb: 3, wr: 3, te: 2, flex: 2, bench: 8 }];
  for (const cfg of configs) {
    const s = rosterShape(cfg);
    const demand = positionDemand(s);
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const old = (s.starterDemand[pos] || 0) + (s.config.flex || 0) * (flexShare[pos] || 0);
      assert.ok(Object.is(old, demand[pos] || 0),
        `${JSON.stringify(cfg)} ${pos}: ${old} !== ${demand[pos]}`);
      for (const teams of [4, 8, 10, 12, 14, 32]) {
        assert.equal(Math.max(0, Math.round((demand[pos] || 0) * teams) - 1),
          Math.max(0, Math.round(old * teams) - 1), 'replacement rank unchanged');
      }
    }
  }
});

test('fairDollars: a 2-QB league prices quarterbacks above a 1-QB league', () => {
  const rows = board();
  const adj = adjMap(rows);
  const adjOf = (r) => adj.get(String(r.gsis_id)) || 0;
  const one = fairDollars(rows, adjOf, 4, 200, rosterShape({ bench: 4 }));
  const two = fairDollars(rows, adjOf, 4, 200, rosterShape({ qb: 2, bench: 4 }));
  const topQb = rows.find((r) => r.position === 'QB').gsis_id;
  assert.ok(two.get(topQb) > one.get(topQb),
    'two starting QBs push the QB replacement level down, so QBs cost more');
});

test('fairDollars: accepts a LeagueProfile shape (superflex demands more QB)', () => {
  const rows = board();
  const adj = adjMap(rows);
  const adjOf = (r) => adj.get(String(r.gsis_id)) || 0;
  const classic = {
    shape: {
      teams: 4,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN'],
    },
  };
  const superflex = {
    shape: {
      teams: 4,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'BN', 'BN', 'BN', 'BN'],
    },
  };
  const a = fairDollars(rows, adjOf, 4, 200, classic);
  const b = fairDollars(rows, adjOf, 4, 200, superflex);
  const topQb = rows.find((r) => r.position === 'QB').gsis_id;
  assert.ok(b.get(topQb) > a.get(topQb), 'a superflex slot is mostly a QB slot');
  assert.equal(positionDemand(superflex).QB, 1.9);
});

test('teamNeedsPos: a 2-QB room still wants a third QB; a 1-QB room does not', () => {
  const rows = board();
  const qbIdx = rows.findIndex((r) => r.position === 'QB');
  const mk = (qb) => createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
    boardRows: rows, adjPointsById: adjMap(rows), seed: 11,
  });
  const two = mk(2);
  const one = mk(1);
  const qbs = rows.filter((r) => r.position === 'QB').slice(1, 3);
  for (const a of [two, one]) myTeam(a).players.push(...qbs);
  assert.equal(myGuidance(two, qbIdx).needIt, true);
  assert.equal(myGuidance(two, qbIdx).bidTo > 0, true, 'and will actually bid');
  assert.equal(myGuidance(one, qbIdx).needIt, false);
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

/* ---- R23-E2: the ROOM bids from the market; OUR advice never does ----------
 *
 * data/adp.json carries ESPN's average winning bid (`auction_value`). It is the
 * opponent model: what the room will pay. The tests below lock BOTH halves of
 * the policy — that the published price really does drive the room, and that it
 * never reaches a number this app presents as its own valuation.
 */

/** A board whose rows carry a published auction price. priceOf(i) -> $ | null
 * (null = ESPN does not price him). */
function pricedBoard(n = 80, priceOf = (i) => 100 * Math.exp(-0.05 * i)) {
  return board(n).map((r, i) => {
    const v = priceOf(i);
    return v == null ? r : { ...r, auction_value: v };
  });
}

const K = (r) => String(r.gsis_id || `name:${r.name}`);

test('marketDollars: published auction values ARE the curve when the board has them', () => {
  // Row 5 is the market darling; row 1 is the market fade. ADP order is
  // untouched, so if the room prices row 5 higher the PRICE is what drove it.
  const rows = pricedBoard(60, (i) => (i === 5 ? 90 : (i === 1 ? 4 : 40 - i * 0.5)));
  const m = marketDollars(rows, 4, 200, 11);
  assert.ok(m.get('id-6') > m.get('id-2'),
    'the room pays for the player the room prices up, not the better ADP');
  assert.ok(m.get('id-6') > m.get('id-1'), 'and beats the ADP #1 too');
  const poolN = Math.min(rows.length, 4 * 11);
  let sum = 0;
  for (let i = 0; i < poolN; i += 1) sum += m.get(K(rows[i]));
  assert.equal(sum, 4 * 200, 'the draftable pool still absorbs exactly the room budget');
  for (const v of m.values()) assert.ok(v >= MIN_BID, 'nobody is ever free');
});

test('marketDollars: the published curve is invariant to ESPN\'s denomination', () => {
  // Only RELATIVE market prices are modelled, so republishing the same board on
  // a $400 budget must not move a single dollar in our room.
  const base = pricedBoard(60, (i) => 50 - i * 0.6);
  const doubled = base.map((r) => ({ ...r, auction_value: r.auction_value * 2 }));
  const a = marketDollars(base, 4, 200, 11);
  const b = marketDollars(doubled, 4, 200, 11);
  for (const [k, v] of a) assert.equal(b.get(k), v, `${k} moved on a pure rescale`);
});

test('marketDollars: no published price anywhere -> the ADP decay curve, unchanged', () => {
  // The pre-R23 fallback, recomputed here from first principles so a change to
  // the published-price path can never silently redefine the fallback.
  const rows = board(300);
  const m = marketDollars(rows, 12, DEFAULT_BUDGET, 13);
  const poolN = 12 * 13;
  const w = [];
  for (let i = 0; i < poolN; i += 1) w.push(Math.exp(-MARKET_DECAY * i));
  const wSum = w.reduce((x, y) => x + y, 0);
  const spread = 12 * DEFAULT_BUDGET - poolN * MIN_BID;
  let allocated = 0;
  const expect = [];
  for (let i = 0; i < poolN; i += 1) {
    const v = MIN_BID + Math.round(spread * (w[i] / wSum));
    expect.push(v);
    allocated += v;
  }
  expect[0] += 12 * DEFAULT_BUDGET - allocated;
  for (let i = 0; i < poolN; i += 1) {
    assert.equal(m.get(`id-${i + 1}`), expect[i], `decay rank ${i + 1} moved`);
  }
  assert.equal(m.get('id-200'), MIN_BID);
});

test('marketDollars: an UNPRICED player is not a $0 bargain', () => {
  // ESPN prices 205 of 211. The 6 it does not price are priced like the players
  // they are drafted among - never free, never a steal, never the top of the board.
  const rows = pricedBoard(60, (i) => (i === 10 ? null : 60 - i * 0.8));
  const m = marketDollars(rows, 4, 200, 11);
  const mine = m.get('id-11');
  const above = m.get('id-10');
  const below = m.get('id-12');
  assert.ok(mine > MIN_BID, 'an unpriced mid-board player never lands at the $1 floor');
  assert.ok(mine <= above && mine >= below,
    `unpriced price ${mine} must sit between its neighbours ${below}-${above}`);
  assert.ok(mine < m.get('id-1'), 'and never inherits the top of the board');
  // Money conservation survives the substitution.
  let sum = 0;
  for (let i = 0; i < 44; i += 1) sum += m.get(K(rows[i]));
  assert.equal(sum, 4 * 200);
  // Unpriced at the very top of the board: takes the nearest price below it.
  const topless = marketDollars(pricedBoard(60, (i) => (i === 0 ? null : 60 - i * 0.8)),
    4, 200, 11);
  assert.ok(topless.get('id-1') > MIN_BID && topless.get('id-1') >= topless.get('id-3'),
    'an unpriced #1 overall is priced like the players around him, not at $1');
});

test('POLICY: auction_value never reaches maxBid, the advised bid, or OUR dollars', () => {
  // Three boards, same players and same projections, three DIFFERENT market
  // curves: none published, a steep one, a flat one. Everything the app calls
  // its own opinion of worth must be byte-identical across all three; only the
  // room's prices may move.
  const flat = (i) => 20 + (i % 3);
  const steep = (i) => 200 * Math.exp(-0.12 * i) + 1;
  const mk = (rows) => createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
    boardRows: rows, adjPointsById: adjMap(rows), seed: 11,
  });
  const rooms = [mk(board()), mk(pricedBoard(80, steep)), mk(pricedBoard(80, flat))];
  const [plain, sharp, dull] = rooms;
  assert.equal(plain.marketSource, 'adp');
  assert.equal(sharp.marketSource, 'auction');

  // 1. The market really did change - otherwise this test proves nothing.
  const marketOf = (a) => a.board.map((r) => a.market.get(K(r)));
  assert.notDeepEqual(marketOf(sharp), marketOf(plain), 'published prices must reach the room');
  assert.notDeepEqual(marketOf(sharp), marketOf(dull), 'the room follows the curve it is given');

  // 2. OUR dollars are identical - fairDollars never sees a price.
  const fairOf = (a) => a.board.map((r) => a.fair.get(K(r)));
  assert.deepEqual(fairOf(sharp), fairOf(plain), 'VOR dollars moved with the market');
  assert.deepEqual(fairOf(dull), fairOf(plain), 'VOR dollars moved with the market');

  // 3. Our advice is identical: fair, inflation-adjusted, bid-to, and the legal cap.
  const adviceOf = (a) => a.board.map((_, i) => {
    const g = myGuidance(a, i, { tempo: 'aggressive' });
    return [g.fair, g.adjusted, g.bidTo, g.cap, g.needIt];
  });
  assert.deepEqual(adviceOf(sharp), adviceOf(plain), 'the advised bid moved with the market');
  assert.deepEqual(adviceOf(dull), adviceOf(plain), 'the advised bid moved with the market');
  assert.deepEqual(planBudget(sharp.shape, 200, 'stars'), planBudget(plain.shape, 200, 'stars'));

  // 4. Still identical AFTER the rooms have actually BID against each curve.
  //
  //    This step used to hand-feed the SAME prices to all three rooms
  //    (`sellTo(a, i % 4, 20 + i, i)`), so the modelled room never bid and the
  //    only thing the assertion could see was arithmetic on identical inputs.
  //    Drive it properly — autoNominate picks the room's own target, resolveBids
  //    prices it from the opponent model — and the real boundary shows up:
  //    `fair` is invariant, while `adjusted`/`bidTo`/`cap` respond to what the
  //    room SPENT, through inflation and my own remaining budget. That is the
  //    intended mechanism (see app/auction.js myGuidance), so it is asserted as
  //    a split, not suppressed.
  for (const a of rooms) {
    for (let i = 0; i < 12; i += 1) {
      const idx = autoNominate(a);
      if (idx < 0) break;
      nominate(a, idx);
      const { winnerIdx, price } = resolveBids(a, 0); // I never bid: the ROOM prices it
      sellTo(a, winnerIdx, price, idx);
    }
  }
  // The rooms really did buy differently — otherwise this step proves nothing.
  const salesOf = (a) => a.log.map((s) => `${s.name}@${s.price}`);
  assert.notDeepEqual(salesOf(sharp), salesOf(dull),
    'the curves must produce different sales, or nothing below is being tested');

  // OUR OPINION OF WORTH is untouched by any of it.
  assert.deepEqual(fairOf(sharp), fairOf(plain), 'fairDollars moved with the market');
  assert.deepEqual(fairOf(dull), fairOf(plain), 'fairDollars moved with the market');
  const guidanceFairOf = (a) => a.board.map((_, i) => myGuidance(a, i, { tempo: 'aggressive' }).fair);
  assert.deepEqual(guidanceFairOf(sharp), guidanceFairOf(plain),
    'myGuidance().fair must be fairDollars, dollar for dollar, on any board');
  assert.deepEqual(guidanceFairOf(dull), guidanceFairOf(plain),
    'myGuidance().fair must be fairDollars, dollar for dollar, on any board');

  // THE LIVE NUMBERS are allowed to move, and must: a room that spent more has
  // less money chasing the same remaining value. If these ever went invariant,
  // inflation would have stopped reading the room.
  assert.notEqual(liveInflation(sharp), liveInflation(dull),
    'inflation must respond to what the room actually spent');
  const bidToOf = (a) => a.board.map((_, i) => myGuidance(a, i, { tempo: 'aggressive' }).bidTo);
  assert.notDeepEqual(bidToOf(sharp), bidToOf(dull),
    'the advised bid tracks the price of a seat in THIS room');

  // The opponent model has learned different things from each curve.
  assert.notDeepEqual(sharp.teams.map((t) => t.tendencies),
    dull.teams.map((t) => t.tendencies), 'the opponent model DOES move with the market');
});

test('POLICY: auction_value is read in exactly one place in the engine', () => {
  // The behavioural test above proves today's wiring is clean. This one fails
  // the moment a new line of code reads the published price at all, so any
  // future use has to be looked at on purpose instead of arriving by accident.
  const src = readFileSync(new URL('../../app/auction.js', import.meta.url), 'utf8');
  const hits = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('auction_value'))
    .filter(([, l]) => !/^\s*(\*|\/\/|\/\*)/.test(l));
  assert.deepEqual(hits.map(([, l]) => l.trim()),
    ['const v = Number(row && row.auction_value);'],
    'auction_value must be read only by publishedPrice() - the opponent model\'s door');
});

test('the room pays up for a name it loves, and our advice says let him go', () => {
  // The actionable signal: the room's price and ours disagree, and myGuidance
  // reports the gap instead of splitting the difference.
  const rows = pricedBoard(80, (i) => (i === 30 ? 400 : 40 - i * 0.4));
  const a = createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
    boardRows: rows, adjPointsById: adjMap(rows), seed: 11,
  });
  const g = myGuidance(a, 30);
  assert.ok(g.market > g.fair, 'the room prices the darling above our value');
  assert.equal(g.gap, g.fair - g.market, 'the gap is reported, not averaged in');
  assert.ok(g.gap < 0);
  assert.equal(g.class, 'BAIT');
  assert.equal(g.marketSource, 'auction');
  const adv = nominationAdvice(a, {}, 5);
  assert.equal(adv.suggestion.boardIdx, 30, 'and he is the nomination to bait the room with');
  // And the room actually bids that price up - the opponent model is live.
  nominate(a, 30);
  const { price } = resolveBids(a, 0);
  assert.ok(price > myGuidance(a, 30).adjusted,
    'opponents outbid our own number for a player the market loves');
});

/* ---- R23-E2 bug fixes: a full roster can neither buy nor be sold to -------- */

test('maxBid: a team with no open slot has NO legal bid', () => {
  assert.equal(maxBid(200, 0), 0, 'a full roster cannot bid its whole budget');
  assert.equal(maxBid(200, -1), 0);
  // Unchanged for every open-slot count that actually exists.
  assert.equal(maxBid(200, 13), 188);
  assert.equal(maxBid(200, 1), 200);
});

test('sellTo REFUSES a sale to a team that is already full', () => {
  const a = newAuction();
  const victim = 0;
  a.teams[victim].players = a.board.slice(0, a.shape.size).map((r) => r);
  const snap = {
    roster: a.teams[victim].players.length,
    budget: a.teams[victim].budget,
    taken: a.taken.size,
    log: a.log.length,
    nomIdx: a.nomIdx,
    remainingFair: a.remainingFair,
  };
  nominate(a, 40);
  assert.equal(sellTo(a, victim, 25, 40), null, 'the sale is refused, not clamped');
  assert.equal(a.teams[victim].players.length, snap.roster, 'roster never passes shape.size');
  assert.equal(a.teams[victim].budget, snap.budget, 'no money moved');
  assert.equal(a.taken.size, snap.taken, 'the player is still on the board');
  assert.equal(a.log.length, snap.log, 'nothing logged');
  assert.equal(a.nomIdx, snap.nomIdx, 'the nomination did not advance');
  assert.equal(a.remainingFair, snap.remainingFair);
  // A real buyer still works on the very same block.
  assert.ok(sellTo(a, 1, 25, 40), 'a team with room can still buy him');
  assert.equal(a.teams[1].players.length, 1);
  // And a nonexistent team index is refused rather than crashing.
  nominate(a, 41);
  assert.equal(sellTo(a, 99, 5, 41), null);
});

test('buyerOptions omits full teams so the picker cannot offer one', () => {
  const a = newAuction();
  assert.deepEqual(buyerOptions(a), [0, 1, 2, 3], 'everyone can buy at the start');
  a.teams[2].players = a.board.slice(0, a.shape.size).map((r) => r);
  assert.equal(canBuy(a, 2), false);
  assert.deepEqual(buyerOptions(a), [0, 1, 3]);
  assert.equal(canBuy(a, 99), false, 'a team that does not exist cannot buy');
});

test('myGuidance drops a full team from the threat list', () => {
  const a = newAuction();
  a.teams[0].players = a.board.slice(20, 20 + a.shape.size).map((r) => r);
  const g = myGuidance(a, 0);
  assert.ok(g.bidTo > 0, 'precondition: we would bid on this player');
  assert.ok(!g.threats.some((t) => t.team === 1),
    'a roster with no open slot is not a credible threat');
});
