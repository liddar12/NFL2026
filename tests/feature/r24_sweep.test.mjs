/* tests/feature/r24_sweep.test.mjs — R24 QA sweep, locked.
 *
 * Two engine findings raised against the R24 working tree, each re-verified
 * before it was touched. Both concern changes that rode in on a bug-fix release
 * without a ticket; these tests pin the behaviour that was actually agreed.
 *
 *  1. derivedCaps() and REL15 #4. R24-D made an EXPLICIT position_caps set a
 *     hard ceiling that is never raised to startableDemand + 1. Every Sleeper
 *     import writes position_caps from the league's real position_limit_*
 *     settings (app/sleeper.js), so a 2-QB league importing a QB limit of 2
 *     stopped being offered a bye/injury backup — which is REL15 #4 verbatim,
 *     the bug R19 fixed, reintroduced for every imported league instead of for
 *     the frozen default. The rule this file locks splits the two cases the
 *     R24-D change ran together:
 *       cap <  startableDemand  -> the league capped BELOW what it starts, on
 *                                  purpose. Left as stated (the R24-D gain).
 *       cap >= startableDemand  -> the cap describes a startable requirement,
 *                                  not a ban on depth. Raised to demand + 1,
 *                                  exactly as the app-default set is, which is
 *                                  byte-for-byte the pre-R24 behaviour.
 *
 *  2. replacementLevel() and the exported-API throw. R24-D turned a silent
 *     "assume 12 teams" into a TypeError when the shape carries no league size.
 *     The throw is right — HONEST DATA: skip loudly rather than price an 8- and
 *     a 16-team draft identically while claiming league size moves VOR — but it
 *     converts a bad input into an uncaught exception on an EXPORTED function,
 *     so the guarantee that keeps it from taking down a view is that no live
 *     call site can construct a shape without a count. That guarantee was
 *     unasserted; it is asserted here, so a future view that reaches for
 *     rosterShape(null) fails in this suite rather than in a user's browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { rosterGeometry, replacementLevel, POSITION_CAPS } from '../../app/team-logic.js';
import { rosterShape } from '../../app/draft-sim.js';

/* ==========================================================================
   1. AN EXPLICIT CAP AT THE STARTABLE DEMAND STILL ALLOWS A BACKUP
   ========================================================================== */

// A 2-QB league: two QB starting slots and a stated position_caps {QB: 2}.
//
// R26 NOTE — READ BEFORE CHANGING THESE EXPECTATIONS. The shapes below carry NO
// position_caps_source, so every case in this section is the HAND-BUILT /
// UNKNOWN-PROVENANCE one, where "QB: 2" is ambiguous between "I start two" and
// "I may roster two" and the app resolves it in the user's favour. When this
// file was written that was the only case and the fixture was described as a
// Sleeper import; it is not one, because a real import now marks its source.
// The genuinely-imported case asserts the OPPOSITE value and lives in
// tests/feature/r26_caps_source.test.mjs.
const TWO_QB = ['QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

// A SUPER_FLEX league that deliberately limits QB below its starting demand.
const SUPERFLEX = ['QB', 'SUPER_FLEX', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

const geom = (roster_positions, position_caps, teams = 12) =>
  rosterGeometry({ shape: { teams, roster_positions: [...roster_positions], ...(position_caps ? { position_caps } : {}) } });

test('REL15 #4: a HAND-BUILT 2-QB league whose stated QB cap EQUALS its starting demand still gets a backup', () => {
  const g = geom(TWO_QB, { QB: 2 });
  assert.equal(g.caps.QB, 3,
    'a league that STARTS two QBs and caps QB at two is describing its starting '
    + 'requirement, not banning a bye/injury backup — REL15 #4');
});

test('caps: a stated cap ABOVE the startable demand is kept exactly as stated', () => {
  // Raising is Math.max(base, demand + 1), so a generous cap is never lowered.
  assert.equal(geom(TWO_QB, { QB: 5 }).caps.QB, 5);
  assert.equal(geom(TWO_QB, { TE: 4 }).caps.TE, 4, 'TE starts 1 + FLEX = 2, cap 4 stands');
});

test('caps: a stated cap BELOW the startable demand is the league rule, and is NOT raised', () => {
  // The R24-D gain, kept: a SUPER_FLEX league that limits QB to 1 starts at most
  // one QB in the flex and the app does not overrule it.
  const g = geom(SUPERFLEX, { QB: 1 });
  assert.equal(g.caps.QB, 1,
    'an explicit cap below the starting demand is a deliberate league rule');
});

test('caps: the boundary is >=, checked either side of it', () => {
  // startableDemand(QB) on TWO_QB is 2 (FLEX is not QB-eligible).
  assert.equal(geom(TWO_QB, { QB: 1 }).caps.QB, 1, 'below demand: stated');
  assert.equal(geom(TWO_QB, { QB: 2 }).caps.QB, 3, 'at demand: raised to demand + 1');
  assert.equal(geom(TWO_QB, { QB: 3 }).caps.QB, 3, 'above demand: stated (already demand + 1)');
});

test('BACKWARD COMPATIBILITY: the app-default paths are byte-for-byte unchanged', () => {
  // No LeagueProfile saved -> no shape at all -> the frozen caps, with the R19
  // bump for the K and DEF the default league starts since R47.
  assert.deepEqual(rosterGeometry(null).caps, { ...POSITION_CAPS, K: 2, DEF: 2 });
  // A profile that states no caps -> normalizeProfile fills POSITION_CAPS, and
  // the default set is raised as R19 intended.
  assert.equal(geom(TWO_QB, null).caps.QB, 3);
  // A league that restates the fallback set value-for-value is read as the
  // fallback (documented in capsAreAppDefault) and behaves identically.
  assert.equal(geom(TWO_QB, { ...POSITION_CAPS }).caps.QB, 3);
  // The draft-sim path, whose base caps are POSITION_CAPS directly.
  assert.equal(rosterGeometry(rosterShape({ qb: 2 })).caps.QB, 3);
});

test('caps: non-QB positions follow the same rule, so this is not a QB special case', () => {
  // K starts 1, no flex accepts it. A stated K cap of 1 equals the demand and is
  // raised to 2 (a kicker on bye is the same problem as a QB on bye); a stated
  // cap of 0 is below the demand and is left at 0.
  const roster = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'];
  assert.equal(geom(roster, { K: 1 }).caps.K, 2);
  assert.equal(geom(roster, { K: 0 }).caps.K, 0, 'a league that rosters no kicker rosters no kicker');
});

/* ==========================================================================
   2. THE replacementLevel() THROW CANNOT REACH A VIEW
   ========================================================================== */

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('replacementLevel(): every shape a live view builds carries a league size', () => {
  // The exported function throws on a shape with no count (locked in
  // r24d_fixes.test.mjs). That is only safe while no view can hand it one, so
  // enumerate the rosterShape() call sites in app/ and require each to pass a
  // config, never a bare null/undefined. A new `rosterShape(null)` in a view is
  // what this catches.
  const VIEW_FILES = ['app/views/team.js', 'app/views/players.js', 'app/views/lineup.js',
    'app/views/compare.js'];
  for (const f of VIEW_FILES) {
    const src = read(f);
    const calls = [...src.matchAll(/rosterShape\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
    for (const arg of calls) {
      assert.ok(arg && !/^(null|undefined|\{\s*\})$/.test(arg),
        `${f}: rosterShape(${arg}) builds a shape with no league size, and the `
        + 'VOR path throws on one — pass a config that states leagueSize');
    }
  }
});

test('replacementLevel(): cfgFromProfile always states a league size, for every profile shape', () => {
  // players.js prices through rosterShape(cfgFromProfile(profile).cfg), so
  // cfgFromProfile is the guarantee. It clamps p.shape.teams into LEAGUE_BOUNDS,
  // which means even a profile with a junk or absent team count comes back with
  // a finite one — assert that rather than trusting the clamp to stay.
  const src = read('app/views/team.js');
  assert.match(src, /cfg\.leagueSize\s*=\s*clampCount\(/,
    'cfgFromProfile must always set a clamped leagueSize, never pass one through');
});

test('replacementLevel(): a shape WITH a league size answers, and league size moves the answer', () => {
  // The other half of the guarantee: the throw is not masking a broken path.
  const pool = [];
  for (let i = 0; i < 120; i += 1) {
    pool.push({ gsis_id: `p${i}`, position: 'RB', proj_points: 300 - i * 2 });
  }
  const weekly = new Map(pool.map((p) => [p.gsis_id, { receptions_prior: 0 }]));
  const at = (n) => replacementLevel(pool, weekly, 'std', 'RB',
    rosterShape({ leagueSize: n, bench: 6 }));
  const eight = at(8);
  const sixteen = at(16);
  assert.ok(Number.isFinite(eight) && Number.isFinite(sixteen));
  assert.notEqual(eight, sixteen, 'league size moves replacement level, as documented');
});
