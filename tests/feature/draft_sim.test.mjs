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
  createDraft, onTheClock, takeOpponentPick, takeMyPick, takeOpponentPickAt,
  undoLastPick, picksUntilMyNext, survivalProbabilities, startersTotal,
  scoreVsRoom,
  ROOM_TYPES, ROOM_LABELS, normalizeRoomType, leagueSeasonPoints, needsStarterSeat,
  aiPlusContext, aiPlusOpponentPick,
} from '../../app/draft-sim.js';
import { DEFAULT_PROFILE, cloneProfile } from '../../app/league.js';
import { scoringAdjust, rosterGeometry } from '../../app/team-logic.js';

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

test('rosterShape: defaults reproduce the R47 15-slot shape (K and DEF seated)', () => {
  const s = rosterShape(null);
  assert.deepEqual(s.config, DEFAULT_ROSTER);
  assert.deepEqual(s.starters, ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'K1', 'DEF1']);
  assert.equal(s.bench.length, 6);
  assert.equal(s.size, 15);
  assert.deepEqual(s.starterDemand, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  // The pre-R47 classic shape is still one explicit config away.
  const classic = rosterShape({ k: 0, def: 0 });
  assert.deepEqual(classic.starters, ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);
  assert.equal(classic.size, 13);
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
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4, k: 0, def: 0 }, // 11 rounds (offence-only board)
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

/* ---- R19-B4: the room's caps and starter set come from the SHAPE ------------ */

test('opponentNeeds: a 2-QB room drafts a THIRD QB; a 1-QB room still stops at two', () => {
  const twoQb = rosterShape({ qb: 2 });
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', twoQb), true,
    'a lineup that must start two QBs needs a bye/injury backup');
  assert.equal(opponentNeeds({ QB: 3 }, 'QB', twoQb), false, 'and stops at three');
  assert.equal(opponentNeeds({ QB: 2 }, 'QB', rosterShape(null)), false,
    'the 1-QB room is unchanged');
});

test('a full 2-QB draft leaves opponents with three QBs; the 1-QB draft never does', () => {
  const rows = board60();
  const run = (qb) => {
    const draft = createDraft({
      leagueSize: 4, mySlot: 2, roomType: 'adp',
      rosterConfig: { qb, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
      boardRows: rows, adjPointsById: adjMap(rows), seed: 7,
    });
    while (!draft.done) {
      if (onTheClock(draft) === draft.mySlot - 1) {
        let pick = -1;
        for (let i = 0; i < draft.board.length; i += 1) {
          if (!draft.taken.has(i)) { pick = i; break; }
        }
        takeMyPick(draft, pick);
      } else {
        takeOpponentPick(draft);
      }
    }
    return draft.rosters
      .filter((_, i) => i !== draft.mySlot - 1)
      .map((r) => r.counts.QB || 0);
  };
  const two = run(2);
  const one = run(1);
  assert.equal(Math.max(...two), 3, `a 2-QB room reaches three QBs (got ${two})`);
  assert.equal(Math.max(...one), 2, `a 1-QB room caps at two (got ${one})`);
});

test('startersTotal: slot-driven fill reproduces the old fixed-then-FLEX arithmetic', () => {
  const players = [
    { position: 'QB', gsis_id: 'q1' }, { position: 'QB', gsis_id: 'q2' },
    { position: 'RB', gsis_id: 'r1' }, { position: 'RB', gsis_id: 'r2' },
    { position: 'RB', gsis_id: 'r3' }, { position: 'WR', gsis_id: 'w1' },
    { position: 'WR', gsis_id: 'w2' }, { position: 'WR', gsis_id: 'w3' },
    { position: 'TE', gsis_id: 't1' }, { position: 'TE', gsis_id: 't2' },
    { position: 'WR', gsis_id: null },
  ];
  const pts = new Map([['q1', 300], ['q2', 280], ['r1', 250], ['r2', 240], ['r3', 230],
    ['w1', 220], ['w2', 210], ['w3', 205], ['t1', 150], ['t2', 140]]);
  const adjOf = (p) => (p.gsis_id && pts.has(p.gsis_id) ? pts.get(p.gsis_id) : 0);
  // The pre-R19-B4 implementation, written out.
  const oldTotal = (shape) => {
    const sorted = players.slice().sort((a, b) => adjOf(b) - adjOf(a));
    const used = new Set();
    let total = 0;
    const fill = (pos, n) => {
      let left = n;
      for (const p of sorted) {
        if (left === 0) break;
        if (used.has(p) || p.position !== pos) continue;
        used.add(p); total += adjOf(p); left -= 1;
      }
    };
    fill('QB', shape.starterDemand.QB); fill('RB', shape.starterDemand.RB);
    fill('WR', shape.starterDemand.WR); fill('TE', shape.starterDemand.TE);
    let flexLeft = shape.config.flex;
    for (const p of sorted) {
      if (flexLeft === 0) break;
      if (used.has(p) || !['RB', 'WR', 'TE'].includes(p.position)) continue;
      used.add(p); total += adjOf(p); flexLeft -= 1;
    }
    return Math.round(total * 10) / 10;
  };
  for (const cfg of [null, { flex: 0 }, { flex: 2 }, { qb: 2 }, { rb: 3, te: 2, flex: 2 }]) {
    const shape = rosterShape(cfg);
    assert.equal(startersTotal(players, shape, adjOf), oldTotal(shape),
      `shape ${JSON.stringify(cfg)} must score identically`);
  }
});

test('takeOpponentPickAt records the OBSERVED live pick for the team on the clock', () => {
  const rows = board60();
  const draft = createDraft({
    leagueSize: 4, mySlot: 3, roomType: 'adp',
    boardRows: rows, adjPointsById: adjMap(rows), seed: 5,
  });
  // Teams 1 and 2 pick before me; record team 1 taking board #7 (not the model's choice).
  const rec = takeOpponentPickAt(draft, 7);
  assert.equal(rec.team, 1);
  assert.equal(rec.name, 'P8');
  assert.ok(draft.taken.has(7));
  // Cannot record onto my own turn or an already-taken player.
  takeOpponentPickAt(draft, 0);                 // team 2 takes board #1
  assert.equal(takeOpponentPickAt(draft, 5), null, 'my turn: manual entry refused');
  assert.equal(draft.rosters[2].players.length, 0, 'my roster untouched');
});

test('undoLastPick restores the snake draft exactly', () => {
  const rows = board60();
  const draft = createDraft({
    leagueSize: 4, mySlot: 3, roomType: 'adp',
    boardRows: rows, adjPointsById: adjMap(rows), seed: 9,
  });
  takeOpponentPickAt(draft, 3);
  const snap = JSON.stringify({ pick: draft.pick, taken: [...draft.taken],
    r: draft.rosters.map((r) => r.players.length) });
  takeOpponentPickAt(draft, 8);
  undoLastPick(draft);
  const now = JSON.stringify({ pick: draft.pick, taken: [...draft.taken],
    r: draft.rosters.map((r) => r.players.length) });
  assert.equal(now, snap);
});

/* ---- R23-E1: the AI+ room (drafts to the SAVED LeagueProfile) --------------
 *
 * The acceptance criterion is DIVERGENCE: an AI+ room must draft differently
 * from the SHARK room when the league is a superflex league or scores a TE
 * premium, and identically-shaped rooms ('adp' / 'shark') must not move at all.
 */

/** A 160-row board (40 per position) — deep enough for a full 8-team draft. */
function board160() {
  const rows = [];
  const positions = ['RB', 'WR', 'QB', 'TE'];
  for (let i = 0; i < 160; i += 1) {
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

/** Points mirror ADP order (best ADP = most points), all positive. */
function adjMap160(rows) {
  return new Map(rows.map((r, i) => [String(r.gsis_id), 400 - i * 2]));
}

/**
 * Prior-season receptions: pass-catchers catch, QBs do not, and volume falls
 * with the board — an elite TE catches ~70, a streamer ~5. That SPREAD is what
 * a per-reception premium acts on; a flat bonus to every TE alike would (
 * correctly) cancel out of value-over-replacement and change no decision.
 */
const REC_BY_POS = { WR: 80, TE: 70, RB: 40, QB: 0 };
function recMap160(rows) {
  return new Map(rows.map((r, i) => [
    String(r.gsis_id), Math.round(REC_BY_POS[r.position] * (1 - i / 170)),
  ]));
}

/** A superflex league: the FLEX seat becomes a SUPER_FLEX. */
function superflexProfile() {
  const p = cloneProfile(DEFAULT_PROFILE);
  p.name = 'Superflex';
  p.shape.roster_positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
  p.shape.flex_eligibility = { SUPER_FLEX: ['QB', 'WR', 'RB', 'TE'] };
  return p;
}

/** A TE-premium league: Sleeper's per-TE-reception bonus, nothing else moved. */
function tePremiumProfile(bonus = 1) {
  const p = cloneProfile(DEFAULT_PROFILE);
  p.name = 'TE premium';
  p.scoring.bonus_rec_te = bonus;
  return p;
}

/** Run a full 8-team draft; I always take the best remaining board row. */
function runRoom(roomType, extra = {}) {
  const rows = board160();
  const draft = createDraft({
    leagueSize: 8,
    mySlot: 2,
    roomType,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4, k: 0, def: 0 }, // 11 rounds (offence-only board)
    boardRows: rows,
    adjPointsById: adjMap160(rows),
    seed: 11,
    ...extra,
  });
  while (!draft.done) {
    if (onTheClock(draft) === draft.mySlot - 1) {
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

/** The AI+ inputs a wired-up view supplies (PPR totals + prior receptions). */
function aiInputs(profile) {
  const rows = board160();
  return {
    profile,
    pprPointsById: adjMap160(rows),
    receptionsById: recMap160(rows),
  };
}

/** Total players at `pos` drafted by everyone EXCEPT me. */
function oppCount(draft, pos) {
  return draft.rosters
    .filter((_, i) => i !== draft.mySlot - 1)
    .reduce((n, r) => n + (r.counts[pos] || 0), 0);
}

/** The round (1-based) each opponent pick at `pos` happened in. */
function oppRoundsFor(draft, pos) {
  return draft.log
    .filter((l) => l.position === pos && l.team !== draft.mySlot)
    .map((l) => Math.ceil(l.pick / draft.leagueSize));
}

test('normalizeRoomType: AI+ spellings collapse; adp/shark/unknown pass through', () => {
  assert.deepEqual(ROOM_TYPES, ['adp', 'shark', 'aiplus']);
  assert.equal(ROOM_LABELS.aiplus, 'AI+');
  ['aiplus', 'AI+', 'ai', 'AI-PLUS'].forEach((t) => {
    assert.equal(normalizeRoomType(t), 'aiplus', `${t} is the AI+ room`);
  });
  assert.equal(normalizeRoomType('adp'), 'adp');
  assert.equal(normalizeRoomType('shark'), 'shark');
  // An unknown token has always fallen through to the ADP model UNCHANGED.
  assert.equal(normalizeRoomType('mystery'), 'mystery');
});

test('the ADP and SHARK rooms are byte-for-byte unchanged by the AI+ inputs', () => {
  for (const room of ['adp', 'shark']) {
    const plain = runRoom(room);
    const withAi = runRoom(room, aiInputs(superflexProfile()));
    assert.deepEqual(withAi.log, plain.log,
      `${room} room must ignore the profile entirely`);
    assert.equal(withAi.ai, null, `${room} room builds no AI+ context`);
  }
});

test('the AI+ room works with NO saved profile and is deterministic per seed', () => {
  const a = runRoom('aiplus');                       // profile omitted -> DEFAULT
  const b = runRoom('aiplus');
  assert.equal(a.log.length, a.totalPicks);
  assert.deepEqual(a.log, b.log, 'same seed, same draft');
  for (const r of a.rosters) assert.equal(r.players.length, a.rounds);
  const names = a.log.map((l) => l.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate players');
  // Explicit null profile is the same thing as no profile at all.
  assert.deepEqual(runRoom('aiplus', { profile: null }).log, a.log);
});

test('leagueSeasonPoints: EXACT under the league table, room points when unfeedable', () => {
  const te = { name: 'T', position: 'TE', gsis_id: 'x1' };
  const wr = { name: 'W', position: 'WR', gsis_id: 'x2' };
  const ppr = new Map([['x1', 200], ['x2', 200]]);
  const rec = new Map([['x1', 60], ['x2', 60]]);
  const roomPts = () => -999;   // an unmistakable fallback marker

  // Full PPR: the projection IS the league number; no receptions required.
  const std = cloneProfile(DEFAULT_PROFILE);
  assert.equal(leagueSeasonPoints(te, std, roomPts, ppr, null), 200);

  // Half / standard reproduce scoringAdjust() exactly.
  const half = cloneProfile(DEFAULT_PROFILE); half.scoring.rec = 0.5;
  const none = cloneProfile(DEFAULT_PROFILE); none.scoring.rec = 0;
  assert.equal(leagueSeasonPoints(te, half, roomPts, ppr, rec),
    scoringAdjust(200, 60, 'half'));
  assert.equal(leagueSeasonPoints(te, none, roomPts, ppr, rec),
    scoringAdjust(200, 60, 'std'));

  // TE premium: per TE reception, TEs only.
  const tep = tePremiumProfile(0.5);
  assert.equal(leagueSeasonPoints(te, tep, roomPts, ppr, rec), 230);
  assert.equal(leagueSeasonPoints(wr, tep, roomPts, ppr, rec), 200);

  // No PPR total, or a table that needs receptions we do not have -> the room's
  // own number, never a fabricated one.
  assert.equal(leagueSeasonPoints({ position: 'TE', gsis_id: 'nope' }, tep, roomPts, ppr, rec),
    -999);
  assert.equal(leagueSeasonPoints(te, half, roomPts, ppr, null), -999);
  assert.equal(leagueSeasonPoints({ position: 'TE', gsis_id: null }, std, roomPts, ppr, rec),
    -999);
});

test('needsStarterSeat: fixed demand first, then the flex seat', () => {
  const geo = rosterGeometry(DEFAULT_PROFILE);            // QB RB RB WR WR TE FLEX
  assert.equal(needsStarterSeat({}, 'RB', geo), true);
  assert.equal(needsStarterSeat({ QB: 1 }, 'QB', geo), false, 'QB1 filled, no flex');
  // RB2 filled but the FLEX is still open -> an RB still fills a starting seat.
  assert.equal(needsStarterSeat({ RB: 2, WR: 2, TE: 1 }, 'RB', geo), true);
  // Surplus now covers the one FLEX slot.
  assert.equal(needsStarterSeat({ RB: 3, WR: 2, TE: 1 }, 'RB', geo), false);
  // A SUPER_FLEX makes the QB a flex-eligible starter again.
  const sfGeo = rosterGeometry(superflexProfile());
  assert.equal(needsStarterSeat({ QB: 1 }, 'QB', sfGeo), true);
  assert.equal(needsStarterSeat({ QB: 2 }, 'QB', sfGeo), false);
});

test('AI+ under a SUPERFLEX profile chases quarterbacks; SHARK does not', () => {
  const shark = runRoom('shark');
  const sf = runRoom('aiplus', aiInputs(superflexProfile()));
  const base = runRoom('aiplus', aiInputs(null));

  assert.notDeepEqual(sf.log, shark.log, 'the superflex room must not mirror SHARK');
  assert.ok(oppCount(sf, 'QB') > oppCount(shark, 'QB'),
    `superflex AI+ (${oppCount(sf, 'QB')} QBs) must out-draft SHARK `
    + `(${oppCount(shark, 'QB')} QBs)`);
  // Same room type, same seed, same board: only the PROFILE differs.
  assert.ok(oppCount(sf, 'QB') > oppCount(base, 'QB'),
    `the profile alone must move QB volume (${oppCount(sf, 'QB')} vs ${oppCount(base, 'QB')})`);
  assert.notDeepEqual(sf.log, base.log);
  // The SUPER_FLEX seat legitimises a third QB the one-QB caps forbid.
  const most = Math.max(...sf.rosters.map((r) => r.counts.QB || 0));
  assert.ok(most >= 3, `a superflex roster carries three QBs (max was ${most})`);
});

/* R23-E1 REGRESSION: the replacement baseline is a BASELINE.
 *
 * aiReplacementLevels() used to rank the REMAINING board on every pick against
 * a FIXED index (round(demand x teams) - 1). Drafting a position therefore
 * removed players from its own ranking, slid the index onto a worse row, and
 * LOWERED that position's replacement level — which RAISED the VOR of the next
 * player at that position. In a 12-team superflex (QB demand ~1.92, index 22)
 * that closed a runaway loop: QB replacement collapsed onto the unprojected
 * tail of the board and the room took 18 of its first 24 picks at QB, down to
 * backups with ADP 170+, before a single RB3 left the board.
 *
 * Correct VOR moves the other way. The baseline is now pinned ONCE to the full
 * board, the way app/auction.js fairDollars() has always priced. */
function superflex12(rows) {
  const p = cloneProfile(DEFAULT_PROFILE);
  p.name = 'Superflex 12';
  p.shape.teams = 12;
  p.shape.roster_positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
  p.shape.flex_eligibility = { FLEX: ['WR', 'RB', 'TE'], SUPER_FLEX: ['QB', 'WR', 'RB', 'TE'] };
  return {
    profile: p,
    pprPointsById: adjMap160(rows),
    receptionsById: recMap160(rows),
  };
}

test('AI+ replacement levels are pinned to the full board, not the remaining one', () => {
  const rows = board160();
  // No board handed to the context: nothing is pinned until the first pick.
  const ctx = aiPlusContext({ ...superflex12(rows), leagueSize: 12 });
  assert.equal(ctx.replacement, null, 'the baseline starts unpinned');

  const shape = rosterShape(null);
  aiPlusOpponentPick(rows, {}, shape, ctx, 0, mulberry32(3));
  const before = ctx.replacement;
  assert.ok(before && Number.isFinite(before.QB) && before.QB > 0,
    'the first pick pins a baseline off the board it was given');

  // Strip the board down to the four worst players at every position — the
  // exact state the old per-pick ranking turned into "replacement is now zero".
  const thin = ['QB', 'RB', 'WR', 'TE'].flatMap(
    (pos) => rows.filter((r) => r.position === pos).slice(-4),
  );
  aiPlusOpponentPick(thin, {}, shape, ctx, 9, mulberry32(3));
  assert.equal(ctx.replacement, before, 'the baseline is not recomputed per pick');
  assert.ok(ctx.replacement.QB > 0,
    'and a drained board cannot drive a position\'s replacement level to zero');

  // Handing the context a board up front pins the same numbers, up front.
  const pinned = aiPlusContext({ ...superflex12(rows), leagueSize: 12, board: rows });
  assert.deepEqual(pinned.replacement, before);
});

/**
 * A board shaped like the real one, which board160() deliberately is not:
 * quarterbacks OUT-SCORE every other position (they do), each position has its
 * own curve and its own gap to replacement, the rows are ADP-ordered by a
 * market that prices a 1-QB world, and the tail of every position carries
 * players this app cannot project. Those four facts together are what make a
 * superflex league a QB league — and what the drifting baseline turned into a
 * QB-only league. Values are chosen so the top QB's VOR (176) leads the top RB
 * (150) and WR (135), the same ordering data/adp.json produces.
 */
const VOR_CURVE = { QB: [420, 8], RB: [300, 5], WR: [290, 4.5], TE: [210, 4] };
const VOR_UNPROJECTED = { QB: 6, RB: 4, WR: 4, TE: 4 };
function vorBoard() {
  const rows = [];
  const points = new Map();
  const marketOrder = ['RB', 'WR', 'RB', 'WR', 'TE', 'RB', 'WR', 'QB'];
  const seen = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let i = 0;
  while (rows.length < 160) {
    const pos = marketOrder[i % marketOrder.length];
    i += 1;
    if (seen[pos] >= 40) continue;
    const k = seen[pos];
    seen[pos] += 1;
    const id = `${pos}-${k + 1}`;
    rows.push({ name: `${pos}${k + 1}`, position: pos, team: 'KC', adp: rows.length + 1, gsis_id: id });
    // The last few at every position have no projection at all.
    if (k < 40 - VOR_UNPROJECTED[pos]) points.set(id, VOR_CURVE[pos][0] - VOR_CURVE[pos][1] * k);
  }
  return { rows, points };
}

test('AI+ in a 12-team superflex does not turn round 1 into a QB run', () => {
  const { rows, points } = vorBoard();
  const draft = createDraft({
    leagueSize: 12,
    mySlot: 5,
    roomType: 'aiplus',
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 2, bench: 6 },
    boardRows: rows,
    adjPointsById: points,
    seed: 20261205,
    profile: superflex12(rows).profile,
    pprPointsById: points,
    receptionsById: new Map(),
  });
  while (draft.log.length < 30 && !draft.done) {
    if (onTheClock(draft) === draft.mySlot - 1) {
      let pick = -1;
      for (let i = 0; i < draft.board.length; i += 1) {
        if (!draft.taken.has(i)) { pick = i; break; }
      }
      takeMyPick(draft, pick);
    } else {
      takeOpponentPick(draft);
    }
  }
  const opp = draft.log.filter((l) => l.team !== draft.mySlot);
  const early = opp.slice(0, 24);
  const qbs = early.filter((l) => l.position === 'QB').length;
  // Two full rounds of a 12-team room is 24 picks. With the drifting baseline
  // this fixture returned 24 of 24 at QB, down to QB27; with the baseline
  // pinned to the full board it returns 10, which is what a superflex room
  // actually looks like. A QB in more than 14 of 24 is the runaway, back.
  assert.ok(qbs > 0, 'a superflex room still values quarterbacks');
  assert.ok(qbs <= 14, `QBs in the first two rounds: ${qbs} (was 24 of 24 before the fix)`);
  // And nobody is reaching past the QB1x tier to get one.
  const deepest = Math.max(...early.filter((l) => l.position === 'QB')
    .map((l) => Number(l.name.slice(2))));
  assert.ok(deepest <= 16, `deepest QB taken in two rounds was QB${deepest}`);
  // The rest of the field is still coming off the board.
  const positions = early.map((l) => l.position);
  ['RB', 'WR'].forEach((pos) => assert.ok(positions.includes(pos),
    `${pos} must still come off the board in the first two rounds`));
});

test('AI+ never prices a position against an UNPROJECTED player', () => {
  // leagueSeasonPoints() honestly returns 0 for a player this app cannot
  // project. A 0 is a missing number, not a scouting opinion — if one became
  // the replacement level, every player at that position would be priced
  // against nothing and the position would swallow the draft.
  const rows = board160();
  const projected = adjMap160(rows);
  rows.filter((r) => r.position === 'QB').slice(-30).forEach((r) => {
    projected.delete(String(r.gsis_id)); // 30 of 40 QBs have no projection at all
  });
  const ctx = aiPlusContext({
    profile: superflex12(rows).profile,
    adjOf: (row) => (projected.has(String(row.gsis_id)) ? projected.get(String(row.gsis_id)) : 0),
    pprPointsById: projected,
    receptionsById: recMap160(rows),
    leagueSize: 12,
    board: rows,
  });
  assert.ok(ctx.replacement.QB > 0,
    `an unprojected backup must never be the QB baseline (got ${ctx.replacement.QB})`);
});

test('AI+ under a TE-PREMIUM scoring table pays for tight ends; SHARK does not', () => {
  const shark = runRoom('shark');
  const tep = runRoom('aiplus', aiInputs(tePremiumProfile(1)));
  const base = runRoom('aiplus', aiInputs(null));

  assert.notDeepEqual(tep.log, shark.log, 'the TE-premium room must not mirror SHARK');
  // The ONLY difference between these two AI+ rooms is one scoring key.
  assert.notDeepEqual(tep.log, base.log,
    'a TE-premium scoring table must change what the room drafts');

  const tepTe = oppRoundsFor(tep, 'TE');
  const baseTe = oppRoundsFor(base, 'TE');
  assert.ok(tepTe.length > 0 && baseTe.length > 0 && oppRoundsFor(shark, 'TE').length > 0);

  /* PAYING FOR TIGHT ENDS IS A TIMING EFFECT, NOT A HEADCOUNT EFFECT.
   *
   * A per-reception premium is worth MORE to a TE who catches 70 balls than to
   * one who catches 40, so it makes the TE curve STEEPER — and a steeper curve
   * lifts the replacement level too (round(demand x teams) - 1 into the ranked
   * board). Value over replacement therefore RISES for the starters worth
   * having and FALLS for the streamer tail: the elite tight end comes off the
   * board earlier and the room stops rostering a third one. That is the real
   * shape of a TE-premium league, and it is what a manager needs to see.
   *
   * This assertion used to read the other way — "more TEs clear the bar" —
   * because aiReplacementLevels() re-ranked the SHRINKING remaining board on
   * every pick, so drafting a TE LOWERED TE replacement and RAISED the next
   * TE's VOR. That feedback loop is fixed (the baseline is now pinned to the
   * full board once, like app/auction.js fairDollars); the headcount assertion
   * went with it. Timing is asserted across seeds because the opponent pick is
   * SAMPLED, so a single seed measures the sampler, not the scoring table. */
  assert.ok(Math.min(...tepTe) <= Math.min(...baseTe),
    'the first TE comes off the board no later');

  const teTiming = (profile) => {
    let firstPick = 0;
    let thirdPick = 0;
    let count = 0;
    const seeds = 25;
    for (let s = 1; s <= seeds; s += 1) {
      const d = runRoom('aiplus', { ...aiInputs(profile), seed: s });
      const picks = d.log.filter((l) => l.position === 'TE' && l.team !== d.mySlot)
        .map((l) => l.pick);
      firstPick += picks[0];
      thirdPick += picks[2];
      count += oppCount(d, 'TE');
    }
    return { first: firstPick / seeds, third: thirdPick / seeds, count: count / seeds };
  };
  const flat = teTiming(null);
  const half = teTiming(tePremiumProfile(0.5));
  const full = teTiming(tePremiumProfile(1));

  assert.ok(full.first < flat.first,
    `the premium pulls the first TE forward (${full.first} vs ${flat.first})`);
  assert.ok(full.third < half.third && half.third < flat.third,
    'and the effect is monotone in the one scoring key that changed '
    + `(3rd TE at ${full.third} / ${half.third} / ${flat.third})`);
  assert.ok(full.count < half.count && half.count < flat.count,
    'while the streamer tail shrinks — a steeper curve lifts TE replacement too '
    + `(${full.count} / ${half.count} / ${flat.count} TEs rostered)`);
});

test('aiPlusOpponentPick: profile-blind inputs still pick, and the pick is seeded', () => {
  const rows = board160();
  const ctx = aiPlusContext({
    profile: superflexProfile(),
    adjOf: (r) => adjMap160(rows).get(String(r.gsis_id)) || 0,
    pprPointsById: adjMap160(rows),
    receptionsById: recMap160(rows),
    leagueSize: 8,
  });
  const shape = rosterShape(null);
  const a = aiPlusOpponentPick(rows, {}, shape, ctx, 0, mulberry32(4));
  const b = aiPlusOpponentPick(rows, {}, shape, ctx, 0, mulberry32(4));
  assert.equal(a, b, 'same seed, same pick');
  // Imperfection is bounded: round-1 picks stay inside the candidate set.
  const seen = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    seen.add(aiPlusOpponentPick(rows, {}, shape, ctx, 0, mulberry32(seed)));
  }
  assert.ok(seen.size > 1, 'a room of perfect optimisers would only ever pick one player');
  assert.ok(seen.size <= 3, `round-1 candidate set is AI_TOP_K_BASE wide (got ${seen.size})`);
  // Saturated roster (every position capped out) still returns a legal index.
  const idx = aiPlusOpponentPick(rows, { QB: 9, RB: 9, WR: 9, TE: 9 }, shape, ctx, 10,
    mulberry32(1));
  assert.ok(idx >= 0 && idx < rows.length);
});

test('survivalProbabilities simulates the AI+ room with the draft context', () => {
  const rows = board160();
  const draft = createDraft({
    leagueSize: 8, mySlot: 1, roomType: 'aiplus',
    boardRows: rows, adjPointsById: adjMap160(rows), seed: 3,
    ...aiInputs(superflexProfile()),
  });
  takeMyPick(draft, 0);
  const surv = survivalProbabilities(
    [1, 120], draft.board, draft.rosters, draft.shape, draft.roomType, draft.adjOf,
    draft.pick, 14, 8, 0, 99, 60, draft.ai);
  assert.ok(surv.get(1) < surv.get(120),
    `board #2 (${surv.get(1)}) survives less than #121 (${surv.get(120)})`);
  // Omitting the context must not throw — the default profile stands in.
  const noCtx = survivalProbabilities(
    [1, 120], draft.board, draft.rosters, draft.shape, draft.roomType, draft.adjOf,
    draft.pick, 14, 8, 0, 99, 20);
  assert.equal(noCtx.size, 2);
});
