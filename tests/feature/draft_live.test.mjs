/* tests/feature/draft_live.test.mjs — R33: the LIVE Sleeper draft companion.
 *
 * Everything hard about the companion is pure by design (app/draft-live.js
 * header), so node can drive every honesty rule without a DOM or a network:
 * the pick diffing that makes reloads safe, the clock check that PAUSES
 * rather than filing picks under the wrong team, the SIM-room refusal that
 * protects the live-only learning, and the no-fabricated-price rule on
 * auction sales. The controller itself runs here too, with injected fetch and
 * timers — the view supplies only rendering and the routing into the room's
 * own take/sell functions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePicks, freshPicks, draftSlotMaps, slotOfPick, detectMySlot,
  armRefusal, pickDraftRecord, boardIdxByName, planPickActions,
  createCompanion, statusLine, leagueDraftsEndpoint, picksEndpoint,
} from '../../app/draft-live.js';

/* ---- fixtures shaped like Sleeper's real payloads ------------------------ */

const rawPick = (no, pid, extra = {}) => ({
  pick_no: no,
  round: Math.ceil(no / 4),
  player_id: pid,
  roster_id: extra.roster_id ?? null,
  draft_slot: extra.draft_slot ?? null,
  picked_by: extra.picked_by ?? null,
  metadata: {
    first_name: extra.first || 'P',
    last_name: extra.last || String(pid),
    position: extra.position || 'RB',
    ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
  },
});

const RECORD = {
  draft_id: 'd1',
  type: 'snake',
  status: 'drafting',
  settings: { teams: 4, rounds: 13 },
  slot_to_roster_id: { 1: 11, 2: 12, 3: 13, 4: 14 },
  draft_order: { u1: 1, u2: 2, u3: 3, u4: 4 },
};

test('normalizePicks keeps valid rows, reports invalid ones, reads the auction amount', () => {
  const out = normalizePicks([
    rawPick(1, '4046', { amount: '47' }),
    { pick_no: 2 },                       // no player_id — reported, not dropped silently
    'garbage',
    rawPick(3, '9999'),
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.picks.length, 2);
  assert.equal(out.picks[0].amount, 47, 'an auction pick carries its real winning bid');
  assert.equal(out.picks[1].amount, null, 'no amount is NULL, never $1 — the price is evidence');
  assert.equal(out.picks[0].name, 'P 4046', 'the pick keeps its own name for unmatched display');
  assert.equal(out.invalid.length, 2);
  assert.equal(normalizePicks({ not: 'a list' }).ok, false);
});

test('freshPicks: high-water mark + dedupe + sort make reloads and overlaps safe', () => {
  const picks = normalizePicks([rawPick(3, 'c'), rawPick(1, 'a'), rawPick(2, 'b'),
    rawPick(2, 'b')]).picks;
  const fresh = freshPicks(picks, 1);
  assert.deepEqual(fresh.map((p) => p.pick_no), [2, 3],
    'everything at or below the mark is already accounted for; duplicates collapse; order is by pick_no');
});

test('slotOfPick: draft_slot is authoritative, roster_id then picked_by are fallbacks', () => {
  const maps = draftSlotMaps(RECORD);
  assert.equal(slotOfPick({ draft_slot: 3 }, maps), 3);
  assert.equal(slotOfPick({ roster_id: 12 }, maps), 2);
  assert.equal(slotOfPick({ picked_by: 'u4' }, maps), 4);
  assert.equal(slotOfPick({}, maps), null, 'no mapping is NULL, never a guess');
});

test('detectMySlot is offered from hints, never fabricated', () => {
  assert.equal(detectMySlot(RECORD, { rosterId: 13 }), 3);
  assert.equal(detectMySlot(RECORD, { userId: 'u2' }), 2);
  assert.equal(detectMySlot(RECORD, {}), null);
});

test('armRefusal: SIM rooms are refused — sim picks would poison live-only learning', () => {
  assert.match(armRefusal({ room: { play: 'sim', leagueSize: 4 }, mode: 'snake', leagueId: 'x' }),
    /SIM room/);
  assert.match(armRefusal({}), /LIVE draft room first/);
  assert.match(armRefusal({ room: { play: 'live', leagueSize: 4 }, mode: 'snake' }),
    /league id/);
  assert.match(
    armRefusal({ room: { play: 'live', leagueSize: 4 }, mode: 'auction', leagueId: 'x', record: RECORD }),
    /this room is an\s+auction/,
    'a snake draft must not feed an auction room');
  assert.match(
    armRefusal({ room: { play: 'live', leagueSize: 12 }, mode: 'snake', leagueId: 'x', record: RECORD }),
    /4 teams; this room is set to 12/);
  assert.equal(
    armRefusal({ room: { play: 'live', leagueSize: 4 }, mode: 'snake', leagueId: 'x', record: RECORD }),
    null, 'a matching LIVE room arms');
});

test('pickDraftRecord follows the running draft, or the most recent when all are done', () => {
  assert.equal(pickDraftRecord([{ draft_id: 'new', status: 'complete' },
    { draft_id: 'live', status: 'drafting' }]).draft_id, 'live');
  assert.equal(pickDraftRecord([{ draft_id: 'newest', status: 'complete' },
    { draft_id: 'older', status: 'complete' }]).draft_id, 'newest');
  assert.equal(pickDraftRecord([]), null);
});

test('boardIdxByName: unique-name fallback refuses to guess', () => {
  const board = [
    { name: 'Mike Evans', position: 'WR' },
    { name: 'Michael Carter', position: 'RB' },
    { name: 'Michael Carter', position: 'DB' },
    { name: 'Steel City DST', position: 'DST' },
  ];
  assert.equal(boardIdxByName(board, 'Mike Evans', 'WR'), 0);
  assert.equal(boardIdxByName(board, 'Michael Carter', null), null,
    'two candidates — the fallback must refuse rather than guess');
  assert.equal(boardIdxByName(board, 'Michael Carter', 'RB'), 1,
    'a position disambiguates');
  assert.equal(boardIdxByName(board, 'Steel City DST', 'DEF'), 3,
    'DEF and DST are one position in two spellings');
});

/* ---- planPickActions: the room-action planner ---------------------------- */

const mkMatch = (entries) => new Map(Object.entries(entries)
  .map(([id, bi]) => [id, { boardIdx: bi, code: 'id', message: null }]));

function snakeCtx(overrides = {}) {
  return {
    mode: 'snake', mySlot: 1, leagueSize: 4, roomPick: 0,
    matchOf: mkMatch({ a: 0, b: 1, c: 2 }),
    slotOf: () => null, isTaken: () => false,
    ...overrides,
  };
}

test('snake planning: my pick and opponent picks route by the simulated clock', () => {
  const picks = normalizePicks([rawPick(1, 'a'), rawPick(2, 'b'), rawPick(3, 'c')]).picks;
  const { actions, blocked } = planPickActions(picks, snakeCtx());
  assert.equal(blocked, null);
  assert.deepEqual(actions.map((a) => a.type), ['my-pick', 'opponent-pick', 'opponent-pick'],
    'slot 1 is mine; picks 2 and 3 belong to the room');
});

test('snake planning PAUSES on a clock mismatch instead of mis-filing the pick', () => {
  const picks = normalizePicks([rawPick(1, 'a', { draft_slot: 3 })]).picks;
  const maps = draftSlotMaps(RECORD);
  const { actions, blocked } = planPickActions(picks,
    snakeCtx({ slotOf: (p) => slotOfPick(p, maps) }));
  assert.equal(actions.length, 0);
  assert.match(blocked.reason, /out of step/,
    'Sleeper says slot 3, the room clock says slot 1 — filing it anyway would corrupt the transcript');
});

test('snake planning blocks at an unmatched pick — the clock cannot skip it', () => {
  const picks = normalizePicks([rawPick(1, 'zz'), rawPick(2, 'b')]).picks;
  const { actions, blocked } = planPickActions(picks, snakeCtx());
  assert.equal(actions[0].type, 'unmatched');
  assert.ok(blocked, 'later picks must not be applied past a hole in the clock');
});

test('a board row already taken reconciles as already — a pre-arm manual tap is never doubled', () => {
  const picks = normalizePicks([rawPick(1, 'a')]).picks;
  const { actions } = planPickActions(picks, snakeCtx({ isTaken: (bi) => bi === 0 }));
  assert.equal(actions[0].type, 'already');
});

test('auction planning: real sale, missing price, unmappable buyer — each honest, none blocking', () => {
  const picks = normalizePicks([
    rawPick(1, 'a', { draft_slot: 2, amount: '35' }),
    rawPick(2, 'b', { draft_slot: 3 }),               // no amount
    rawPick(3, 'c', { amount: '10' }),                 // no slot -> no buyer
  ]).picks;
  const maps = draftSlotMaps(RECORD);
  const { actions, blocked } = planPickActions(picks, {
    mode: 'auction', mySlot: 1, leagueSize: 4,
    matchOf: mkMatch({ a: 0, b: 1, c: 2 }),
    slotOf: (p) => slotOfPick(p, maps),
    isTaken: () => false, canBuy: () => true,
  });
  assert.equal(blocked, null, 'auctions have no clock; problems are surfaced and stepped over');
  assert.deepEqual(actions.map((a) => a.type), ['sale', 'needs-price', 'needs-buyer']);
  assert.equal(actions[0].amount, 35);
  assert.equal(actions[0].buyerIdx, 1, 'slot 2 is team index 1 — the REAL buyer, not mine');
});

/* ---- the controller, with injected fetch and timers ---------------------- */

const jsonRes = (payload) => ({ status: 200, text: async () => JSON.stringify(payload) });

function fetchStub(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [match, responder] of routes) {
      if (url.includes(match)) return responder(url);
    }
    return { status: 404, text: async () => 'null' };
  };
  impl.calls = calls;
  return impl;
}

function roomStub() {
  const applied = [];
  const taken = new Set();
  const room = {
    mode: 'snake', mySlot: 1, leagueSize: 4, roomPick: 0,
    board: [
      { gsis_id: 'g1', name: 'P a', position: 'RB' },
      { gsis_id: 'g2', name: 'P b', position: 'RB' },
    ],
    isTaken: (bi) => taken.has(bi),
    canBuy: () => true,
    slotHints: { rosterId: 11 },
    isDone: () => false,
  };
  return { room, applied, taken };
}

/** A Sleeper player index shaped like buildSleeperPlayerIndex() entries —
 * the crosswalk iterates fantasy_positions, so the fixture must carry it. */
const INDEX = new Map([
  ['a', { name: 'P a', position: 'RB', fantasy_positions: ['RB'], team: 'SF' }],
  ['b', { name: 'P b', position: 'RB', fantasy_positions: ['RB'], team: 'DAL' }],
]);

test('createCompanion arms, polls, applies through the view callback, advances the mark', async () => {
  const { room, applied, taken } = roomStub();
  const fetchImpl = fetchStub([
    ['/drafts', () => jsonRes([RECORD])],
    ['/picks', () => jsonRes([rawPick(1, 'a'), rawPick(2, 'b', { draft_slot: 2 })])],
  ]);
  const changes = [];
  const c = createCompanion({
    leagueId: 'L1',
    getRoom: () => room,
    apply: (action) => {
      applied.push(action);
      // the view routes into the room; the room consumes the board row
      taken.add(action.boardIdx);
      if (action.type !== 'sale') room.roomPick += 1;
      return { ok: true };
    },
    onChange: (comp, n) => changes.push(n),
    getIndex: () => INDEX,
    buildIndex: () => ({ ok: false }),
    fetchImpl,
    setTimer: () => 1, clearTimer: () => {},
    now: () => 1000,
  });
  await c.arm();
  assert.equal(c.state.armed, true);
  assert.deepEqual(applied.map((a) => a.type), ['my-pick', 'opponent-pick']);
  assert.equal(c.state.highWater, 2, 'both picks accounted for');
  assert.equal(c.state.detectedSlot, 1, 'offered from the roster hint, not forced');
  // The same payload again is a no-op — the reload-safety rule.
  await c.tick();
  assert.equal(applied.length, 2, 're-processing the same picks applies nothing');
});

test('createCompanion refuses a SIM room and keeps polling through a fetch error', async () => {
  const { room } = roomStub();
  let failPicks = false;
  const fetchImpl = fetchStub([
    ['/drafts', () => jsonRes([RECORD])],
    ['/picks', () => (failPicks
      ? { status: 500, text: async () => 'boom' }
      : jsonRes([]))],
  ]);
  const c = createCompanion({
    leagueId: 'L1',
    getRoom: () => room,
    apply: () => ({ ok: true }),
    onChange: () => {},
    getIndex: () => INDEX,
    fetchImpl,
    setTimer: () => 1, clearTimer: () => {},
    now: () => 1000,
  });
  await c.arm();
  assert.equal(c.state.armed, true);
  failPicks = true;
  await c.tick();
  assert.equal(c.state.status, 'retrying', 'a poll failure is RETRYING, never a silent freeze');
  assert.equal(c.state.armed, true, 'and the companion keeps trying');
  assert.match(statusLine(c.state, 2000), /RETRYING — last sync/);
});

test('acknowledge moves the feed past a pick the manager resolved by hand', async () => {
  const { room } = roomStub();
  const fetchImpl = fetchStub([
    ['/drafts', () => jsonRes([RECORD])],
    ['/picks', () => jsonRes([rawPick(1, 'unknown-id')])],
  ]);
  const c = createCompanion({
    leagueId: 'L1', getRoom: () => room, apply: () => ({ ok: true }),
    onChange: () => {}, getIndex: () => INDEX, fetchImpl,
    setTimer: () => 1, clearTimer: () => {}, now: () => 1000,
  });
  await c.arm();
  assert.ok(c.state.blocked, 'an unmatched snake pick pauses the feed');
  c.acknowledge(1);
  assert.equal(c.state.blocked, null);
  assert.equal(c.state.highWater, 1, 'the hand-resolved pick is accounted for');
});

test('the endpoints are the public Sleeper API, no auth anywhere', () => {
  assert.match(leagueDraftsEndpoint('123'), /api\.sleeper\.app\/v1\/league\/123\/drafts$/);
  assert.match(picksEndpoint('d9'), /api\.sleeper\.app\/v1\/draft\/d9\/picks$/);
});
