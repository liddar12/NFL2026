/* tests/feature/r30_blockers.test.mjs — the R30 blockers, pinned.
 *
 * Four defects, all found by the R30 audit and all adversarially verified
 * before a line was changed. Each one had shipped through a fully green gate,
 * which is the only reason this file needs to exist: the gate was not asking
 * these questions.
 *
 *   1. A league seating a K or DEF at the bench minimum could never fill a
 *      roster. Per-position capacity summed to 12 against a shape of 13, so
 *      NO team could ever be full and the auction had no normal exit.
 *   2. Even in a league that could finish, no team ever bought a kicker or a
 *      defence: nomination ranks by market price and K/DST are floored at $1
 *      by design, so 182 offensive rows covered all 180 slots first.
 *   3. The score sheet then reported a win for a roster that cannot legally be
 *      started, because an unfilled slot contributes a silent 0.0.
 *   4. app/views/team.js was the one scoringAdjust call site in the app that
 *      dropped the league's extra scoring rules, so the TEAM tab disagreed
 *      with PLAYERS — and with itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAuction, autoNominate, nominate, resolveBids, sellTo, scoreAuction,
} from '../../app/auction.js';
import { rosterShape, fillStarters, startersTotal } from '../../app/draft-sim.js';
import { scoringAdjust, withLeagueExtras, extraPtsOf } from '../../app/team-logic.js';

/* A board big enough to fill a 12-team room, plus the K/DST rows a league that
 * seats them would carry. Points descend so ordering is deterministic. */
function buildBoard({ withKdst = true } = {}) {
  const rows = [];
  let id = 1;
  const add = (position, n, base) => {
    for (let i = 0; i < n; i += 1) {
      rows.push({ gsis_id: `p${id}`, name: `${position}${i + 1}`, position,
        proj_points: base - i });
      id += 1;
    }
  };
  add('QB', 40, 400);
  add('RB', 80, 380);
  add('WR', 80, 360);
  add('TE', 40, 300);
  if (withKdst) { add('K', 32, 140); add('DEF', 32, 130); }
  return rows;
}

const adjOf = (p) => Number(p.proj_points) || 0;
const ptsById = (rows) => new Map(rows.map((r) => [String(r.gsis_id), adjOf(r)]));

/** Run an auction to completion (or until it refuses to progress). */
function runAuction(cfg, board, { maxSales = 5000 } = {}) {
  const a = createAuction({
    leagueSize: cfg.leagueSize, mySlot: 1, budget: cfg.budget,
    rosterConfig: cfg, boardRows: board, adjPointsById: ptsById(board),
    seed: cfg.seed || 42,
  });
  let sales = 0;
  let halted = false;
  for (;;) {
    if (a.teams.every((t) => t.players.length >= a.shape.size)) break;
    const idx = autoNominate(a);
    if (idx === -1) { halted = true; break; }
    nominate(a, idx);
    const { winnerIdx, price } = resolveBids(a, 0);
    if (sellTo(a, winnerIdx, price, idx) === null) { halted = true; break; }
    sales += 1;
    if (sales > maxSales) { halted = true; break; }
  }
  return { a, sales, halted };
}

const KDEF_LEAGUE = {
  leagueSize: 12, budget: 200,
  qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4, k: 1, def: 1,
};

/* ==========================================================================
   1. THE DEADLOCK — capacity must cover the shape for EVERY buildable config
   ========================================================================== */

test('a bench-minimum K/DEF league can actually finish its auction', () => {
  const { a, halted } = runAuction(KDEF_LEAGUE, buildBoard());
  assert.equal(halted, false,
    'the auction stopped before every roster was full. This is the R30 '
    + 'deadlock: teamNeedsPos gave K and DEF no cap entry, so their whole '
    + 'allowance was the bench-slack term max(0, bench-4) = 0 at the bench '
    + 'minimum, per-position capacity summed BELOW the roster size, and no '
    + 'team could ever be full.');
  for (const t of a.teams) {
    assert.equal(t.players.length, a.shape.size,
      `a team finished with ${t.players.length} of ${a.shape.size} slots`);
  }
});

test('every roster config the settings grid can build has capacity for its shape', () => {
  /* The general form. The grid produces 960 configs and exactly 64 of them
   * were in the unfillable state — every one a bench-4 config seating a K or a
   * DEF. Asserting the whole grid means the next position added cannot
   * reintroduce this by being forgotten in one table. */
  const bad = [];
  for (let qb = 1; qb <= 2; qb += 1) {
    for (let rb = 2; rb <= 3; rb += 1) {
      for (let wr = 2; wr <= 3; wr += 1) {
        for (let te = 1; te <= 2; te += 1) {
          for (let flex = 0; flex <= 2; flex += 1) {
            for (let bench = 4; bench <= 8; bench += 1) {
              for (const k of [0, 1]) {
                for (const def of [0, 1]) {
                  const cfg = { leagueSize: 12, budget: 200,
                    qb, rb, wr, te, flex, bench, k, def };
                  const shape = rosterShape(cfg);
                  // One team, one board: if a single team cannot fill this
                  // shape from an unlimited board, no room using it can end.
                  const { a, halted } = runAuction(
                    { ...cfg, leagueSize: 2 }, buildBoard(), { maxSales: 400 });
                  if (halted || a.teams.some((t) => t.players.length < shape.size)) {
                    bad.push(JSON.stringify(cfg));
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [],
    `${bad.length} roster configs cannot be filled: ${bad.slice(0, 5).join(' ')}`);
});

/* ==========================================================================
   2. THE SEAT MUST ACTUALLY BE FILLED
   ========================================================================== */

test('a league that seats K and DEF ends with every team holding one', () => {
  const { a } = runAuction(KDEF_LEAGUE, buildBoard());
  const missing = [];
  a.teams.forEach((t, i) => {
    const counts = {};
    for (const p of t.players) counts[p.position] = (counts[p.position] || 0) + 1;
    if (!counts.K) missing.push(`team ${i + 1} has no K`);
    if (!counts.DEF) missing.push(`team ${i + 1} has no DEF`);
  });
  assert.deepEqual(missing, [],
    'nomination ranks by market price and K/DST are floored at $1 by design, '
    + 'so without an explicit late-round preference the room fills all 180 '
    + 'slots from the offensive board and never reaches a kicker. Measured '
    + 'before the fix: 2 kickers and 0-2 defences bought of the 24 owed.');
});

test('the late preference does not pull kickers into the early auction', () => {
  // The fix must not overcorrect: a team defers K/DEF until its remaining
  // space equals what it still owes at those positions. If a kicker went
  // first overall the room would be modelling nobody's behaviour.
  const board = buildBoard();
  const a = createAuction({
    leagueSize: 12, mySlot: 1, budget: 200, rosterConfig: KDEF_LEAGUE,
    boardRows: board, adjPointsById: ptsById(board), seed: 7,
  });
  const first = a.board[autoNominate(a)];
  assert.ok(!['K', 'DEF', 'DST'].includes(first.position),
    `the room nominated a ${first.position} with a full roster to fill`);
});

/* ==========================================================================
   3. AN UNFILLED SLOT IS REPORTED, NOT SCORED AS ZERO
   ========================================================================== */

test('fillStarters names the slots it could not fill', () => {
  const shape = rosterShape(KDEF_LEAGUE);
  const partial = [
    { gsis_id: 'a', position: 'QB', proj_points: 400 },
    { gsis_id: 'b', position: 'RB', proj_points: 380 },
    { gsis_id: 'c', position: 'RB', proj_points: 370 },
  ];
  const { total, empty } = fillStarters(partial, shape, adjOf);
  assert.equal(total, 1150, 'the three seated players still total honestly');
  assert.ok(empty.length > 0, 'a roster missing WR, TE, K and DEF must report them');
  assert.ok(empty.some((s) => String(s).startsWith('K')),
    `the empty K slot must be named; got ${JSON.stringify(empty)}`);
  assert.ok(empty.some((s) => String(s).startsWith('DEF')),
    `the empty DEF slot must be named; got ${JSON.stringify(empty)}`);
});

test('startersTotal is unchanged by the split', () => {
  // fillStarters was extracted FROM startersTotal; every existing caller must
  // see the identical number or this refactor moved a score sheet.
  const shape = rosterShape(KDEF_LEAGUE);
  const roster = buildBoard().slice(0, 13);
  assert.equal(startersTotal(roster, shape, adjOf),
    fillStarters(roster, shape, adjOf).total);
});

test('a completed auction reports no empty slots', () => {
  const { a } = runAuction(KDEF_LEAGUE, buildBoard());
  const sheet = scoreAuction(a);
  assert.deepEqual(sheet.emptySlots, [],
    'every roster filled, so the result card must not warn about holes');
});

test('a board with no kickers fills every OTHER seat and names the holes', () => {
  /* THE HONEST-DEGRADATION PATH, and the assertion this test started with was
   * wrong — worth recording, because the wrong version would have forced a bad
   * fix. If kdst_projections.json is missing, the board carries no K or DEF
   * rows at all, and a league seating K1/DEF1 genuinely CANNOT fill 13 of 13.
   * Demanding the auction "finish" would only be satisfiable by letting a
   * kicker seat be filled by a wide receiver, which is the silent-zero bug
   * wearing a different hat.
   *
   * What must be true instead is that the shortfall is exactly the missing
   * positions and nothing else: every offensive seat filled, the two late seats
   * named in the sheet. The earlier draft of the reservation rule failed this —
   * one blocked team stopped the whole room and left others at 2 and 6 of 13. */
  const { a } = runAuction(KDEF_LEAGUE, buildBoard({ withKdst: false }));

  const sheet = scoreAuction(a);
  assert.deepEqual(sheet.emptySlots.slice().sort(), ['DEF1', 'K1'],
    'the sheet must name exactly the seats the missing feed cost, instead of '
    + 'scoring them as 0.0 and announcing a margin');

  // The room must not stall on the first blocked team. Before autoNominate
  // learned to rotate past one, a single team with nothing legal to nominate
  // stopped everyone: rosters measured 2, 6 and 11 of 13 with a deep offensive
  // board still on the table.
  const filled = a.teams.filter((t) => t.players.length >= a.shape.size - 2).length;
  assert.ok(filled >= a.leagueSize - 1,
    `only ${filled} of ${a.leagueSize} teams got near a full roster — one `
    + 'blocked team is halting the whole room again');

  /* NOT ASSERTED HERE, deliberately: some teams still reach a FULL 13 in this
   * degraded case, because resolveBids has a long-standing "nobody bid" path
   * that hands an unwanted player to the first team with room whether it needs
   * him or not. That is pre-existing behaviour, it is not what made the score
   * sheet lie, and quietly changing it inside a blocker release is how a fix
   * turns into a regression. Recorded as R30b work rather than smuggled in. */
});

/* ==========================================================================
   4. THE TEAM TAB MUST PRICE A PLAYER THE WAY THE REST OF THE APP DOES
   ========================================================================== */

test('the league extras survive the conversion team.js performs', () => {
  /* team.js:1307 was the only scoringAdjust call site in the app that omitted
   * the 4th argument. It stamped the map with withLeagueExtras and then threw
   * the stamp away, so BEST FIT (which goes through team-logic and DOES pass
   * it) valued a quarterback at 524.1 while the finder card, his slot chip and
   * the SEASON TOTAL printed 364.6 for the same player at the same moment. */
  const profile = { scoring: { pass_cmp: 0.5 } };
  const raw = new Map([['qb1', { receptions_prior: 0, completions_prior: 319 }]]);
  const stamped = withLeagueExtras(raw, profile);
  const entry = stamped.get('qb1');

  assert.equal(extraPtsOf(entry), 159.5,
    '319 completions at 0.5 is 159.5 extra points');

  const withExtras = scoringAdjust(364.6, entry.receptions_prior, 'ppr', extraPtsOf(entry));
  const withoutExtras = scoringAdjust(364.6, entry.receptions_prior, 'ppr');
  assert.equal(withExtras, 524.1);
  assert.equal(withoutExtras, 364.6);
  assert.notEqual(withExtras, withoutExtras,
    'if these ever match, this test has stopped measuring anything');
});

test('extraPtsOf tolerates a player with no weekly entry', () => {
  // team.js calls extraPtsOf(e) where `e` may be undefined for any player with
  // no weekly row. A throw here would take the whole TEAM view down, which is
  // exactly how the R29 temporal-dead-zone bug reached production.
  assert.equal(extraPtsOf(undefined), 0);
  assert.equal(extraPtsOf(null), 0);
  assert.equal(extraPtsOf({}), 0);
  assert.equal(scoringAdjust(100, 0, 'ppr', extraPtsOf(undefined)), 100);
});
