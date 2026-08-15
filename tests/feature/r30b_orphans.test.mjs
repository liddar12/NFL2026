/* tests/feature/r30b_orphans.test.mjs — pins for the three R30b workstreams
 * whose agents were cut off before writing their own tests.
 *
 * WHY THIS FILE HAS THIS SHAPE. The R30b fix pass ran as seven concurrent
 * agents; a usage-limit outage terminated three of them (sleeper, team,
 * auction) after their code edits but before their test files. Code without a
 * pin is how R27's "the simulator does not draft them" text and R28's silent
 * no-op both reached the owner, so the headline behaviour of each orphaned
 * workstream is pinned here instead of shipping unasserted. The sleeper
 * draft-record wiring itself was finished by hand afterwards — the agent had
 * written the header comment DESCRIBING the fetch and died before the fetch,
 * which is precisely the claim-without-mechanism this repo forbids.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { mapSettings, sleeperToProfile } from '../../app/sleeper.js';
import {
  createAuction, myGuidance, nominate, liveInflation, sellTo,
} from '../../app/auction.js';
import { canonicalizeBoardPositions, fillStarters, rosterShape } from '../../app/draft-sim.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
/** Source with comments stripped, so prose ABOUT a retired claim never trips. */
const prose = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ==========================================================================
   1. SLEEPER — the draft record is authoritative for rounds and enforcement
   ========================================================================== */

/* The owner's real league, reduced to the two objects that disagree. */
const STALE_LEAGUE_SETTINGS = { draft_rounds: 3, position_limit_qb: 2 };
const REAL_DRAFT = { settings: { rounds: 13, enforce_position_limits: 1 } };

test('draft record rounds beat the league object\'s stale copy', () => {
  const withDraft = mapSettings(STALE_LEAGUE_SETTINGS, { draft: REAL_DRAFT });
  assert.equal(withDraft.shape.draft_rounds, 13,
    'the league object says 3 on the owner\'s real league while the draft '
    + 'record and the 13-slot roster both say 13 — the record must win');
  assert.ok(withDraft.notes.some((n) => n.code === 'draft_rounds_stale_copy'),
    'a disagreement between the two sources is reported, not papered over');
});

test('without a draft record the league value is used AND flagged unverified', () => {
  const pasteTier = mapSettings(STALE_LEAGUE_SETTINGS, {});
  assert.equal(pasteTier.shape.draft_rounds, 3,
    'the paste tier has only the league object; its value applies');
  assert.ok(pasteTier.notes.some((n) => n.code === 'draft_rounds_unverified'),
    'the report must say this number could not be verified against the draft '
    + 'record — silence here is how the owner was told a 13-slot league '
    + 'drafts 3 rounds');
});

test('cap enforcement is READ, not assumed', () => {
  const on = mapSettings(STALE_LEAGUE_SETTINGS, { draft: REAL_DRAFT });
  assert.equal(on.caps_enforced, true);

  const off = mapSettings(STALE_LEAGUE_SETTINGS,
    { draft: { settings: { rounds: 13, enforce_position_limits: 0 } } });
  assert.equal(off.caps_enforced, false);
  assert.ok(off.notes.some((n) => n.code === 'position_limits_not_enforced'),
    'limits listed with enforcement off must be reported as advisory');

  const unknown = mapSettings(STALE_LEAGUE_SETTINGS, {});
  assert.equal(unknown.caps_enforced, null,
    'no draft record means UNKNOWN, not a guess either way');
  assert.ok(unknown.notes.some((n) => n.code === 'position_limits_enforcement_unverified'));
});

test('the advisory stamp reaches the profile when enforcement is off', () => {
  const league = {
    name: 'Enforcement Off',
    total_rosters: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN'],
    scoring_settings: { rec: 1 },
    settings: { position_limit_qb: 2, draft_rounds: 8 },
  };
  const off = sleeperToProfile(league,
    { now: 0, draft: { settings: { rounds: 8, enforce_position_limits: 0 } } });
  assert.equal(off.profile.shape.position_caps_source, 'sleeper-advisory',
    'flag off: team-logic must give these caps the hand-typed treatment, '
    + 'not the hard-limit treatment');
  const on = sleeperToProfile(league,
    { now: 0, draft: { settings: { rounds: 8, enforce_position_limits: 1 } } });
  assert.equal(on.profile.shape.position_caps_source, 'sleeper');
});

/* ==========================================================================
   2. AUCTION — no negative dollars, no verdicts about unpriced players
   ========================================================================== */

function board(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({ gsis_id: `p${i + 1}`, name: `P${i + 1}`, position: 'RB', adp: i + 1 });
  }
  return rows;
}
const pts = (rows) => new Map(rows.map((r, i) => [String(r.gsis_id), 300 - i]));

test('the minimum league budget never prints a negative dollar', () => {
  // BUDGET_BOUNDS floor is $10; before R30b the block showed "OURS $-1" there
  // and MY BUILD planned "-$2" for QB1.
  const rows = board(40);
  const a = createAuction({
    leagueSize: 12, mySlot: 1, budget: 10, rosterConfig: { bench: 4 },
    boardRows: rows, adjPointsById: pts(rows), seed: 1,
  });
  for (const [id, v] of a.fair) {
    assert.ok(v >= 1, `fair dollars for ${id} is ${v} — a published price is never below $1`);
  }
  for (const [id, v] of a.market) {
    assert.ok(v >= 1, `market dollars for ${id} is ${v}`);
  }
  nominate(a, 0);
  const g = myGuidance(a, 0, {});
  assert.ok(g.fair === null || g.fair >= 1, `block OURS is ${g.fair}`);
  assert.ok(g.adjusted === null || g.adjusted >= 1, `block adjusted is ${g.adjusted}`);
});

test('an unprojected player gets honesty, not a LET THEM SPEND verdict', () => {
  const rows = board(20);
  rows.push({ gsis_id: null, name: 'Ghost Player', position: 'RB', adp: 21, auction_value: 30 });
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, rosterConfig: { bench: 4 },
    boardRows: rows, adjPointsById: pts(rows.slice(0, 20)), seed: 1,
  });
  nominate(a, a.board.length - 1); // the ghost
  const g = myGuidance(a, a.board.length - 1, {});
  assert.equal(g.fair, null, 'no projection means NO fair price — not $1');
  assert.equal(g.class, null, 'and no BAIT/TARGET classification built on a fabricated dollar');
  assert.equal(g.unpriced, true);
  assert.match(String(g.reason || ''), /no projection/i,
    'the block must say WHY there is no advice');
});

test('a fresh room reads neutral, not "bargains ahead"', () => {
  const rows = board(30);
  const a = createAuction({
    leagueSize: 4, mySlot: 1, budget: 200, rosterConfig: { bench: 4 },
    boardRows: rows, adjPointsById: pts(rows), seed: 1,
  });
  assert.equal(liveInflation(a), 1,
    'before any sale the inflation ratio is exactly 1 — the pre-R30b room '
    + 'reported scarcity before a single dollar was spent');
  nominate(a, 0);
  sellTo(a, 1, 40, 0);
  assert.notEqual(liveInflation(a), 1, 'after a real sale it must move again');
});

test('a DST-spelled defence seats and scores like a DEF-spelled one', () => {
  const dstRows = [
    { gsis_id: 'd1', name: 'Steelers D/ST', position: 'DST', proj_points: 120 },
    { gsis_id: 'q1', name: 'QB One', position: 'QB', proj_points: 300 },
  ];
  const folded = canonicalizeBoardPositions(dstRows);
  assert.equal(folded[0].position, 'DEF', 'the engine speaks one spelling');
  assert.equal(folded[1], dstRows[1], 'rows needing no fold keep identity');
  const shape = rosterShape({ qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4, def: 1 });
  const adjOf = (p) => Number(p.proj_points) || 0;
  const { total, empty } = fillStarters(folded, shape, adjOf);
  assert.ok(!empty.includes('DEF1'),
    'the folded defence must SEAT — before R30b he could be bought but never '
    + 'seated, and 130 points silently vanished from the sheet');
  assert.equal(total, 420);
});

/* ==========================================================================
   3. TEAM VIEW — the retired sentences stay retired
   ========================================================================== */

test('team.js no longer promises an editor that does not exist', () => {
  const src = prose('app/views/team.js');
  assert.ok(!src.includes('Every value is editable'),
    'the paste-failure recovery text claimed "Every value is editable" — there '
    + 'is no scoring editor anywhere in the app');
});

test('team.js no longer says the AI+ room prices SUPERFLEX as WR/RB/TE', () => {
  const src = prose('app/views/team.js');
  assert.ok(!/opponent model drafts every FLEX as WR\/RB\/TE/.test(src),
    'false since R23: the AI+ room reads SUPER_FLEX in full');
  assert.ok(!/tuned to raise your weekly ceiling and playoff odds/.test(src),
    'no tuning mechanism and no fantasy playoff-odds mechanism exists');
});
