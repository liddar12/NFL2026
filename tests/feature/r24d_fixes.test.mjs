/* tests/feature/r24d_fixes.test.mjs — R24-D carried findings, locked.
 *
 * Three engine defects, each reproduced before it was fixed:
 *
 *  1. draftShapeGeometry() hardcoded teams:12, and replacementLevel()'s
 *     shape-aware path reads geometry.teams. A draft-sim rosterShape therefore
 *     priced EVERY league as a 12-team league while the module claimed league
 *     size moves VOR. The geometry now carries the honest count (rosterShape is
 *     built from a config that states leagueSize) or null, and replacementLevel
 *     REFUSES a shape with no count rather than assuming twelve.
 *
 *  2. derivedCaps() raised every cap to startableDemand + 1, including caps a
 *     league explicitly stated. A Sleeper league that caps QB at 1 got a third
 *     QB in a SUPER_FLEX room — the app overruling the league it models. An
 *     explicit cap is now a hard ceiling; the app's own fallback set still gets
 *     the bye/injury bump it was given in R19.
 *
 *  3. sellTo() clamped a recorded price to the buyer's WHOLE remaining budget
 *     instead of maxBid(), so a direct engine call could leave a team at $0
 *     with a dozen open slots — a room no legal auction reaches, which then
 *     skews liveInflation and every threat list.
 *
 * BACKWARD COMPATIBILITY is asserted alongside each one: the no-shape path, the
 * default cap set and a within-budget sale are all byte-for-byte unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rosterGeometry, replacementLevel, vorScore, POSITION_CAPS,
} from '../../app/team-logic.js';
import { rosterShape } from '../../app/draft-sim.js';
import {
  createAuction, nominate, sellTo, undoLastSale, maxBid, MIN_BID,
} from '../../app/auction.js';

const WEEKS = 18;

function mkPlayer(id, position, proj) {
  return { gsis_id: id, name: id, team: 'KC', position, proj_points: proj, signals_used: [] };
}

function ladder(pos, n, top, step) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(mkPlayer(`${pos}-${i + 1}`, pos, top - i * step));
  return out;
}

function weeklyMap(pool) {
  const m = new Map(pool.map((p) => {
    const weeks = [];
    for (let wk = 1; wk <= WEEKS; wk += 1) {
      weeks.push({ wk, opp: 'OPP', home: wk % 2 === 0, bye: false, pts: p.proj_points / WEEKS });
    }
    return [String(p.gsis_id), { gsis_id: p.gsis_id, receptions_prior: 0, weeks }];
  }));
  const o = Object.fromEntries(m);
  Object.defineProperty(o, 'get', { value: (k) => m.get(String(k)) });
  Object.defineProperty(o, 'has', { value: (k) => m.has(String(k)) });
  return o;
}

const deepPool = () => [
  ...ladder('QB', 40, 320, 4), ...ladder('RB', 60, 330, 4),
  ...ladder('WR', 60, 300, 4), ...ladder('TE', 30, 220, 4),
];

/* ==========================================================================
   1. A DRAFT SHAPE NEVER SILENTLY BECOMES A 12-TEAM LEAGUE
   ========================================================================== */

test('rosterGeometry(): a bare rosterShape has NO team count, not a fabricated 12', () => {
  assert.equal(rosterGeometry(rosterShape(null)).teams, null,
    'a roster is not a league — it cannot claim a team count it was never given');
  assert.equal(rosterGeometry(rosterShape({ qb: 2 })).teams, null);
  // The legacy (no-shape) geometry keeps its documented 12 — that IS the frozen
  // default, and the whole no-shape path is byte-for-byte unchanged.
  assert.equal(rosterGeometry(null).teams, 12);
});

test('rosterGeometry(): a rosterShape built from a draft config carries ITS league size', () => {
  for (const n of [8, 10, 12, 14, 16]) {
    assert.equal(rosterGeometry(rosterShape({ leagueSize: n, bench: 6 })).teams, n);
  }
  // Junk is not a count.
  assert.equal(rosterGeometry(rosterShape({ leagueSize: 0 })).teams, null);
  assert.equal(rosterGeometry(rosterShape({ leagueSize: 'twelve' })).teams, null);
});

test('replacementLevel(): a shape with no league size THROWS instead of assuming 12', () => {
  const pool = deepPool();
  const weekly = weeklyMap(pool);
  const shape = rosterShape(null);
  assert.throws(
    () => replacementLevel(pool, weekly, 'std', 'RB', shape),
    /no league size/,
    'the old code answered as if this were a 12-team league, and said nothing',
  );
  // vorScore rides the same path, so it refuses too rather than returning a
  // number nobody can interpret.
  assert.throws(() => vorScore(pool[40], pool, weekly, 'std', shape), /no league size/);
  // The no-shape path is untouched: still a number, still no throw.
  assert.equal(typeof replacementLevel(pool, weekly, 'std', 'RB'), 'number');
});

test('replacementLevel(): with a stated league size, size actually moves the number', () => {
  const pool = deepPool();
  const weekly = weeklyMap(pool);
  const at = (n) => replacementLevel(pool, weekly, 'std', 'RB',
    rosterShape({ leagueSize: n, bench: 6 }));
  const eight = at(8);
  const twelve = at(12);
  const sixteen = at(16);
  assert.ok(eight > twelve && twelve > sixteen,
    `deeper leagues have a lower replacement level (got ${eight}/${twelve}/${sixteen})`);
  // This is the exact defect: before R24-D all three were identical.
  assert.notEqual(eight, sixteen);
});

/* ==========================================================================
   2. AN EXPLICIT LEAGUE CAP IS A HARD CEILING
   ========================================================================== */

const SUPERFLEX = ['QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

test('caps: a league that states position_caps gets EXACTLY what it stated', () => {
  const stated = rosterGeometry({
    shape: { teams: 12, roster_positions: [...SUPERFLEX], position_caps: { QB: 1, TE: 4 } },
  });
  assert.equal(stated.caps.QB, 1,
    'the league caps QB at 1 — a two-QB starting requirement does not overrule it');
  assert.equal(stated.caps.TE, 4, 'and a cap above the derived one is kept as stated');
  // Sleeper's real shape: caps that differ from the fallback set are the
  // league's rules, all of them, not just the ones that happen to be lower.
  const sleeper = rosterGeometry({
    shape: {
      teams: 10,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
      position_caps: { QB: 3, TE: 4, K: 2, DEF: 3 },
    },
  });
  assert.deepEqual(sleeper.caps, { QB: 3, TE: 4, K: 2, DEF: 3 });
});

test('caps: the app\'s OWN fallback set still gets the R19 bye/injury bump', () => {
  // No position_caps stated -> normalizeProfile fills POSITION_CAPS, which is a
  // default and not a league rule, so a 2-QB league may still carry a third QB.
  const derived = rosterGeometry({ shape: { teams: 12, roster_positions: [...SUPERFLEX] } });
  assert.equal(derived.caps.QB, 3);
  // Same for the draft-sim path, whose base caps are POSITION_CAPS directly.
  assert.equal(rosterGeometry(rosterShape({ qb: 2 })).caps.QB, 3);
  // And the frozen no-shape geometry gets the same bump for the K and DEF it
  // now starts (R47): a starter plus one bye/injury backup each.
  assert.deepEqual(rosterGeometry(null).caps, { ...POSITION_CAPS, K: 2, DEF: 2 });
});

test('caps: a league restating the default set keeps the default behaviour', () => {
  // Deliberate and documented: the normalised profile records no provenance, so
  // a cap set that is value-for-value the fallback is read as the fallback.
  const same = rosterGeometry({
    shape: {
      teams: 12,
      roster_positions: [...SUPERFLEX],
      position_caps: { ...POSITION_CAPS },
    },
  });
  assert.equal(same.caps.QB, 3);
});

/* ==========================================================================
   3. sellTo() CLAMPS TO THE LEGAL MAX BID, NOT THE WHOLE BUDGET
   ========================================================================== */

function room() {
  const rows = [];
  for (let i = 0; i < 80; i += 1) {
    rows.push({
      name: `P${i + 1}`, position: ['RB', 'WR', 'QB', 'TE'][i % 4], team: 'KC',
      adp: i + 1, gsis_id: `id-${i + 1}`,
    });
  }
  return createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4, k: 0, def: 0 }, // 11 slots (R47 seats K/DEF by default; this room is offence-only)
    boardRows: rows,
    adjPointsById: new Map(rows.map((r, i) => [String(r.gsis_id), 320 - i * 3.5])),
    seed: 11,
  });
}

test('sellTo: a wild LIVE price clamps to maxBid, never to the whole budget', () => {
  const a = room();
  nominate(a, 0);
  assert.equal(a.shape.size, 11);
  sellTo(a, 0, 99999, 0);
  const team = a.teams[0];
  // Before R24-D this recorded 200 and left the team at $0 with 10 open slots.
  assert.equal(a.log[0].price, maxBid(200, 11), 'logged price is the LEGAL cap ($190)');
  assert.equal(team.budget, 200 - maxBid(200, 11));
  assert.equal(team.players.length, 1);
  const open = a.shape.size - team.players.length;
  assert.equal(open, 10);
  assert.ok(team.budget >= open * MIN_BID,
    `a team must still afford $1 per open slot (had $${team.budget} for ${open})`);
  assert.ok(maxBid(team.budget, open) >= MIN_BID, 'and can still make a legal bid');
});

test('sellTo: the clamp is reversible and mints no dollars', () => {
  const a = room();
  nominate(a, 0);
  sellTo(a, 0, 99999, 0);
  const spent = a.log.reduce((s, l) => s + l.price, 0);
  const remaining = a.teams.reduce((s, t) => s + t.budget, 0);
  assert.equal(spent + remaining, 4 * 200, 'no phantom dollars');
  undoLastSale(a);
  assert.equal(a.teams[0].budget, 200, 'undo restores the clamped price exactly');
  assert.equal(a.teams[0].players.length, 0);
});

test('sellTo: a legal price is recorded untouched', () => {
  const a = room();
  nominate(a, 0);
  sellTo(a, 0, 55, 0);
  assert.equal(a.log[0].price, 55, 'within maxBid -> byte-for-byte what was entered');
  assert.equal(a.teams[0].budget, 145);
});

test('sellTo: the clamp tightens as the roster fills', () => {
  const a = room();
  // Fill nine of eleven slots at $1 each.
  for (let i = 0; i < 9; i += 1) {
    nominate(a, i);
    sellTo(a, 0, MIN_BID, i);
  }
  const team = a.teams[0];
  assert.equal(team.players.length, 9);
  assert.equal(team.budget, 191);
  nominate(a, 9);
  sellTo(a, 0, 500, 9);
  // Two slots open at the time of sale -> $1 reserved for the last one.
  assert.equal(a.log[9].price, 190);
  assert.equal(team.budget, 1, 'the final slot is still affordable');
});
