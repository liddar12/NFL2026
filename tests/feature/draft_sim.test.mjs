/* tests/feature/draft_sim.test.mjs — the draft simulator's pure core, locked.
 *
 * app/draft-sim.js is pure + seeded, so node drives it directly: snake order,
 * roster-shape bounds, ADP-room behavior (near-ADP, need-aware, deterministic),
 * shark-room greed, survival lookahead sanity, beat-the-room scoring, and the
 * never-fabricate rule (unprojected players score 0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rosterShape, DEFAULT_ROSTER, ROSTER_BOUNDS, mulberry32, snakeTeam,
  myPickNumbers, opponentNeeds, adpOpponentPick, sharkOpponentPick,
  createDraft, onTheClock, takeOpponentPick, takeMyPick, picksUntilMyNext,
  survivalProbabilities, startersTotal, scoreVsRoom,
} from '../../app/draft-sim.js';

/* ---- fixtures --------------------------------------------------------------- */

/** A synthetic ADP board: 60 players, points descending with ADP. */
function board60() {
  const rows = [];
  const positions = ['RB', 'WR', 'QB', 'TE'];
  for (let i = 0; i < 60; i += 1) {
    rows.push({
      name: `P${i + 1}`,
      position: positions[i % 4],
      team: 'KC',
      adp: i + 1,
      gsis_id: `id-${i + 1}`,
    });
  }
  return rows;
}

function adjMap(rows) {
  // Points mirror ADP order: best ADP = most points (clean for assertions).
  return new Map(rows.map((r, i) => [String(r.gsis_id), 300 - i * 4]));
}

/* ---- roster shape ------------------------------------------------------------ */

test('rosterShape: defaults reproduce the classic 13-slot shape', () => {
  const s = rosterShape(null);
  assert.deepEqual(s.config, DEFAULT_ROSTER);
  assert.deepEqual(s.starters, ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);
  assert.equal(s.bench.length, 6);
  assert.equal(s.size, 13);
  assert.deepEqual(s.starterDemand, { QB: 1, RB: 2, WR: 2, TE: 1 });
});

test('rosterShape: values clamp to documented bounds', () => {
  const s = rosterShape({ qb: 9, rb: 0, wr: 3, te: 2, flex: 2, bench: 99 });
  assert.equal(s.config.qb, ROSTER_BOUNDS.qb[1]);       // 2 max
  assert.equal(s.config.rb, ROSTER_BOUNDS.rb[0]);       // 2 min
  assert.equal(s.config.wr, 3);
  assert.equal(s.config.bench, ROSTER_BOUNDS.bench[1]); // 8 max
  assert.ok(s.starters.includes('FLEX1') && s.starters.includes('FLEX2'));
});

/* ---- snake order ------------------------------------------------------------- */

test('snakeTeam: serpentine order reverses every round', () => {
  // 4-team league: picks 0..7 -> teams 0,1,2,3,3,2,1,0
  const order = [];
  for (let p = 0; p < 8; p += 1) order.push(snakeTeam(p, 4));
  assert.deepEqual(order, [0, 1, 2, 3, 3, 2, 1, 0]);
});

test('myPickNumbers: slot 1 of 12 picks 1st and 24th overall', () => {
  const picks = myPickNumbers(1, 12, 2);
  assert.deepEqual(picks, [0, 23]);
});

/* ---- opponent models --------------------------------------------------------- */

test('opponentNeeds: caps respected (no 3rd QB) and demand-aware', () => {
  const shape = rosterShape(null);
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', shape), false, 'QB cap 2');
  assert.equal(opponentNeeds({ QB: 1 }, 'QB', shape), true);
  assert.equal(opponentNeeds({ RB: 4 }, 'RB', shape), false, 'RB want = 2+flex+backup');
  assert.equal(opponentNeeds({ RB: 3 }, 'RB', shape), true);
});

test('adpOpponentPick is deterministic for a fixed seed and stays near the top early', () => {
  const rows = board60();
  const shape = rosterShape(null);
  const a = adpOpponentPick(rows, {}, shape, 0, mulberry32(42));
  const b = adpOpponentPick(rows, {}, shape, 0, mulberry32(42));
  assert.equal(a, b, 'same seed, same pick');
  // Round 0 noise is small: 50 seeded draws never reach deep into the board.
  for (let seed = 0; seed < 50; seed += 1) {
    const i = adpOpponentPick(rows, {}, shape, 0, mulberry32(seed));
    assert.ok(i <= 12, `round-1 pick ${i} strays too far from ADP`);
  }
});

test('sharkOpponentPick takes the most points among needed positions', () => {
  const rows = board60();
  const adj = adjMap(rows);
  const adjOf = (r) => adj.get(String(r.gsis_id)) || 0;
  const shape = rosterShape(null);
  assert.equal(sharkOpponentPick(rows, {}, shape, adjOf), 0, 'clean board: top points');
  // QB saturated: the best non-QB is taken instead.
  const i = sharkOpponentPick(rows, { QB: 2 }, shape, adjOf);
  assert.notEqual(rows[i].position, 'QB');
});

/* ---- full draft flow --------------------------------------------------------- */

function runFullDraft(roomType) {
  const rows = board60();
  const draft = createDraft({
    leagueSize: 4, mySlot: 2, roomType,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 }, // 11 rounds
    boardRows: rows, adjPointsById: adjMap(rows), seed: 7,
  });
  while (!draft.done) {
    if (onTheClock(draft) === draft.mySlot - 1) {
      // I always take the best available projected player I still need.
      let pick = -1;
      for (let i = 0; i < draft.board.length; i += 1) {
        if (!draft.taken.has(i)) { pick = i; break; }
      }
      takeMyPick(draft, pick);
    } else {
      takeOpponentPick(draft);
    }
  }
  return draft;
}

test('a full 4-team ADP draft completes with every roster filled to size', () => {
  const draft = runFullDraft('adp');
  assert.equal(draft.log.length, draft.totalPicks);
  for (const r of draft.rosters) assert.equal(r.players.length, draft.rounds);
  // No duplicate players anywhere.
  const names = draft.log.map((l) => l.name);
  assert.equal(new Set(names).size, names.length);
});

test('drafts are deterministic: identical seeds produce identical logs', () => {
  const a = runFullDraft('adp');
  const b = runFullDraft('adp');
  assert.deepEqual(a.log, b.log);
});

test('picksUntilMyNext counts opponent picks between my turns', () => {
  const rows = board60();
  const draft = createDraft({
    leagueSize: 4, mySlot: 1, roomType: 'adp',
    boardRows: rows, adjPointsById: adjMap(rows), seed: 1,
  });
  // At pick 0 it IS my turn: 0 until mine.
  assert.equal(picksUntilMyNext(draft), 0);
});

test('survivalProbabilities: a top pick is less likely to survive than a deep one', () => {
  const rows = board60();
  const adj = adjMap(rows);
  const draft = createDraft({
    leagueSize: 12, mySlot: 1, roomType: 'adp',
    boardRows: rows, adjPointsById: adj, seed: 3,
  });
  takeMyPick(draft, 0); // my first pick; 22 opponent picks until my next
  const surv = survivalProbabilities(
    [1, 50], draft.board, draft.rosters, draft.shape, 'adp', draft.adjOf,
    draft.pick, 22, 12, 0, 99, 100);
  assert.ok(surv.get(1) < surv.get(50),
    `board #2 (${surv.get(1)}) should survive less than #51 (${surv.get(50)})`);
  assert.ok(surv.get(1) < 0.2, 'a top-2 ADP player rarely survives 22 picks');
});

/* ---- scoring ----------------------------------------------------------------- */

test('startersTotal: fills demand greedily, FLEX takes best leftover, unprojected = 0', () => {
  const shape = rosterShape(null);
  const players = [
    { name: 'q', position: 'QB', gsis_id: 'q1' },
    { name: 'r1', position: 'RB', gsis_id: 'r1' },
    { name: 'r2', position: 'RB', gsis_id: 'r2' },
    { name: 'r3', position: 'RB', gsis_id: 'r3' },   // best leftover -> FLEX
    { name: 'w1', position: 'WR', gsis_id: 'w1' },
    { name: 'w2', position: 'WR', gsis_id: 'w2' },
    { name: 't1', position: 'TE', gsis_id: 't1' },
    { name: 'ghost', position: 'WR', gsis_id: null }, // unprojected: 0, never picked
  ];
  const pts = new Map([['q1', 300], ['r1', 250], ['r2', 240], ['r3', 230],
                       ['w1', 220], ['w2', 210], ['t1', 150]]);
  const adjOf = (p) => (p.gsis_id && pts.has(p.gsis_id) ? pts.get(p.gsis_id) : 0);
  // QB+2RB+2WR+TE+FLEX(r3) = 300+250+240+220+210+150+230 = 1600
  assert.equal(startersTotal(players, shape, adjOf), 1600);
});

test('scoreVsRoom: margin and rank are exact', () => {
  const shape = rosterShape({ qb: 1, rb: 2, wr: 2, te: 1, flex: 0, bench: 4 });
  const mk = (pts) => [
    { position: 'QB', gsis_id: `q${pts}` }, { position: 'RB', gsis_id: `r${pts}` },
    { position: 'RB', gsis_id: `s${pts}` }, { position: 'WR', gsis_id: `w${pts}` },
    { position: 'WR', gsis_id: `x${pts}` }, { position: 'TE', gsis_id: `t${pts}` },
  ];
  const adjOf = (p) => Number(String(p.gsis_id).slice(1));
  const sheet = scoreVsRoom(mk(100), [mk(90), mk(110)], shape, adjOf);
  assert.equal(sheet.mine, 600);
  assert.equal(sheet.roomAvg, 600);       // (540 + 660) / 2
  assert.equal(sheet.margin, 0);
  assert.equal(sheet.rank, 2);            // one room team (110s) beats me
  assert.equal(sheet.teams, 3);
});
