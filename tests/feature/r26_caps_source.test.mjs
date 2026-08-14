/* tests/feature/r26_caps_source.test.mjs — R26: an ENFORCED cap is honoured.
 *
 * THE FINDING (filed against R24, left open through R25, decided by the owner
 * on 2026-08-14). derivedCaps() raised an explicit position cap to
 * startableDemand + 1. For a league imported from Sleeper that is wrong in a
 * way the user only discovers at the draft: Sleeper's position_limit_* is a
 * field DISTINCT from the starting lineup and Sleeper ENFORCES it, so a league
 * with position_limit_qb = 2 will not let you roster a third QB no matter how
 * many it starts — while the app was happily recommending one.
 *
 * THE DISAGREEMENT, AND WHY BOTH SIDES WERE RIGHT. The team-logic owner
 * declined the change with a real argument: a league that starts two QBs and
 * caps QB at two is describing its starting requirement, not banning a backup,
 * and reading it as a ban is REL15 #4 all over again. That argument is correct
 * for a HAND-TYPED cap and wrong for an IMPORTED one. It was never one
 * question. Provenance decides which reading applies:
 *
 *   position_caps_source === 'sleeper'  -> enforced. Honour it exactly.
 *   anything else, or absent            -> ambiguous. Keep the +1 allowance.
 *
 * The second branch is every profile saved before R26, so nothing that worked
 * yesterday changes. What changes is only the case where the app can PROVE the
 * cap is a roster ban.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rosterGeometry, POSITION_CAPS } from '../../app/team-logic.js';
import { normalizeProfile, DEFAULT_PROFILE } from '../../app/league.js';
import { sleeperToProfile } from '../../app/sleeper.js';

const TWO_QB = ['QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

const geom = (position_caps, source, roster_positions = TWO_QB) => rosterGeometry({
  shape: {
    teams: 12,
    roster_positions: [...roster_positions],
    ...(position_caps ? { position_caps } : {}),
    ...(source ? { position_caps_source: source } : {}),
  },
});

/* ==========================================================================
   1. THE FIX ITSELF — the same numbers, read two ways
   ========================================================================== */

test('an IMPORTED cap at the startable demand is honoured exactly, not raised', () => {
  assert.equal(geom({ QB: 2 }, 'sleeper').caps.QB, 2,
    'Sleeper enforces position_limit_qb=2 at the roster; recommending a third QB '
    + 'is advice the league will refuse');
});

test('the SAME cap with no provenance keeps the bye/injury allowance (REL15 #4)', () => {
  assert.equal(geom({ QB: 2 }, null).caps.QB, 3,
    'a hand-typed "QB: 2" in a 2-QB league most likely states the starting '
    + 'requirement, so depth is still offered');
});

test('the two readings differ ONLY in provenance — identical shape otherwise', () => {
  const enforced = geom({ QB: 2 }, 'sleeper');
  const ambiguous = geom({ QB: 2 }, null);
  assert.notEqual(enforced.caps.QB, ambiguous.caps.QB);
  // Everything else about the geometry must be untouched: this is a cap rule,
  // not a roster-shape change. Guards against the fix quietly moving slots.
  // starters/bench/all are slot-id LISTS, not counts — compare by value.
  assert.deepEqual(enforced.all, ambiguous.all);
  assert.deepEqual(enforced.demand, ambiguous.demand);
  assert.deepEqual(enforced.starters, ambiguous.starters);
  assert.deepEqual(enforced.bench, ambiguous.bench);
});

/* ==========================================================================
   2. THE BRANCHES THAT MUST NOT MOVE
   ========================================================================== */

test('an imported cap BELOW the starting demand is still the league rule', () => {
  // Unchanged from R24: this branch never raised, and provenance does not make
  // it raise. Asserted so the fix cannot accidentally invert it.
  const SUPERFLEX = ['QB', 'SUPER_FLEX', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
  assert.equal(geom({ QB: 1 }, 'sleeper', SUPERFLEX).caps.QB, 1);
  assert.equal(geom({ QB: 1 }, null, SUPERFLEX).caps.QB, 1);
});

test('an imported cap ABOVE the starting demand is kept as stated, either way', () => {
  assert.equal(geom({ QB: 5 }, 'sleeper').caps.QB, 5);
  assert.equal(geom({ QB: 5 }, null).caps.QB, 5);
});

test('non-QB positions follow the same rule — this is not a QB special case', () => {
  // TE starts 1 + is FLEX-eligible, so startableDemand(TE) is 2.
  assert.equal(geom({ TE: 2 }, 'sleeper').caps.TE, 2, 'enforced: honoured');
  assert.equal(geom({ TE: 2 }, null).caps.TE, 3, 'ambiguous: allowance kept');
});

test('the app-default cap set is never treated as enforced, whatever the mark says', () => {
  // A profile carrying the app's own defaults has not stated anything about its
  // league, so the mark must not turn the DEFAULTS into a ban. Otherwise a
  // league that sets no limits at all would inherit {QB:2} as a hard ceiling.
  assert.equal(geom({ ...POSITION_CAPS }, 'sleeper').caps.QB, 3);
  assert.equal(rosterGeometry(null).caps.QB, POSITION_CAPS.QB);
});

/* ==========================================================================
   3. PROVENANCE IS ONLY EVER SET BY A REAL IMPORT
   ========================================================================== */

test('normalizeProfile accepts only the literal "sleeper" as authority', () => {
  const shape = { teams: 12, roster_positions: [...TWO_QB], position_caps: { QB: 2 } };
  assert.equal(
    normalizeProfile({ shape: { ...shape, position_caps_source: 'sleeper' } })
      .shape.position_caps_source, 'sleeper');
  assert.equal(
    normalizeProfile({ shape: { ...shape, position_caps_source: 'SLEEPER' } })
      .shape.position_caps_source, 'sleeper', 'case-insensitive');
  // Anything else is DROPPED rather than kept — an unrecognised value must land
  // on the lenient reading, never silently tighten a roster.
  for (const bogus of ['espn', 'manual', 'yahoo', '', 'true', 1, {}, null]) {
    assert.equal(
      normalizeProfile({ shape: { ...shape, position_caps_source: bogus } })
        .shape.position_caps_source, undefined, `"${String(bogus)}" must not carry authority`);
  }
});

test('a profile saved before R26 has no mark, so it keeps its old behaviour', () => {
  // The compatibility guarantee stated in the header, asserted rather than
  // assumed: an R19-era saved profile is exactly the ambiguous case.
  const legacy = normalizeProfile({
    version: DEFAULT_PROFILE.version,
    shape: { teams: 12, roster_positions: [...TWO_QB], position_caps: { QB: 2 } },
  });
  assert.equal(legacy.shape.position_caps_source, undefined);
  assert.equal(rosterGeometry(legacy).caps.QB, 3);
});

test('a real Sleeper import marks its caps, so the importer and the rule agree', () => {
  // End to end: the importer is the only producer of the mark, and what it
  // produces must actually reach derivedCaps as enforced. Without this the fix
  // could be correct in team-logic and never fire for a single real user.
  const res = sleeperToProfile({
    name: 'Test League',
    total_rosters: 12,
    roster_positions: [...TWO_QB],
    settings: { position_limit_qb: 2, playoff_week_start: 15, type: 0 },
    scoring_settings: { rec: 1 },
  }, { source: 'league_id', now: 0 });
  assert.equal(res.ok, true, 'the fixture must import cleanly');
  assert.equal(res.profile.shape.position_caps_source, 'sleeper');
  assert.equal(res.profile.shape.position_caps.QB, 2);
  assert.equal(rosterGeometry(res.profile).caps.QB, 2,
    'the imported enforced cap must survive all the way to the roster rule');
});
