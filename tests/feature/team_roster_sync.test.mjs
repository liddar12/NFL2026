/* tests/feature/team_roster_sync.test.mjs — R20-B4.
 *
 * The Team page's SLEEPER ROSTER SYNC is DOM code; the load-bearing part is not.
 *
 * DIVISION OF LABOUR (and the reason this file is short): app/sleeper.js owns
 * reading Sleeper and crosswalking its player ids onto this app's — that layer
 * has its own tests. app/views/team.js owns the one thing sleeper.js has no
 * business knowing: which SLOT a resolved player takes in the user's league.
 * This file locks that seam.
 *
 * What must never break:
 *   1. SLOT VOCABULARY. Every slot a synced roster writes comes from
 *      rosterSlots(profile) — the same ids the Lineup page reads. Writing
 *      legacy ids here was a P1 bug last release, so a SUPERFLEX league must
 *      get SUPER_FLEX and never a stand-in FLEX.
 *   2. NOTHING IS SILENTLY DROPPED. A crosswalked player with no legal slot
 *      lands in `unplaced` with a reason; a Sleeper id sleeper.js could not
 *      match is surfaced by unmatchedRosterPlayers() with sleeper.js's own
 *      reason. Only Sleeper's "0" empty-slot marker is filtered, because it is
 *      not a player.
 *   3. THE OVERWRITE IS VISIBLE BEFORE IT HAPPENS. planRosterSync() returns
 *      `dropped` — every player on the roster now who would not be there
 *      afterwards — so the UI can name the losses before the confirm.
 *   4. MARKET PRICES STAY OUT. Nothing in the roster path reads adp,
 *      auction_value or odds, and the board's value cell never touches a
 *      projection or an engine call.
 *   5. MANUAL SYNC ONLY. No interval timer anywhere in this view.
 *
 * PURE node:test — no DOM, no network, no dependencies. Sleeper is exercised
 * through its real crosswalk, driven by fixture objects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ROSTER_SYNC_MODE,
  SLEEPER_PLAYER_INDEX_URL,
  orderedRosterPlayers,
  planRosterSync,
  rosterPlanLines,
  unmatchedRosterPlayers,
} from '../../app/views/team.js';
import { buildSleeperPlayerIndex, crosswalkRoster } from '../../app/sleeper.js';
import { DEFAULT_PROFILE, normalizeProfile, rosterSlots } from '../../app/league.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const TEAM_SRC = readFileSync(resolve(REPO_ROOT, 'app/views/team.js'), 'utf8');

/* ---- fixtures -------------------------------------------------------------- */

/** A pool row shaped exactly like data/player_projections.json carries them. */
function poolRow(espnId, name, position, team) {
  return {
    gsis_id: `espn-${espnId}`, name, team, position, proj_points: 100, low: 80, high: 120,
  };
}

const POOL_ROWS = [
  poolRow('1', 'Josh Allen', 'QB', 'BUF'),
  poolRow('2', 'Jalen Hurts', 'QB', 'PHI'),
  poolRow('3', 'Lamar Jackson', 'QB', 'BAL'),
  poolRow('4', 'Bijan Robinson', 'RB', 'ATL'),
  poolRow('5', 'Saquon Barkley', 'RB', 'PHI'),
  poolRow('6', 'De\'Von Achane', 'RB', 'MIA'),
  poolRow('7', 'Ja\'Marr Chase', 'WR', 'CIN'),
  poolRow('8', 'Justin Jefferson', 'WR', 'MIN'),
  poolRow('9', 'DK Metcalf', 'WR', 'PIT'),
  poolRow('10', 'Brock Bowers', 'TE', 'LV'),
];

const POOL_BY_ID = new Map(POOL_ROWS.map((p) => [String(p.gsis_id), p]));

/** A Sleeper /players/nfl dump entry. */
function dumpRow(id, first, last, position, team, espnId) {
  return {
    player_id: String(id),
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    position,
    team,
    fantasy_positions: [position],
    espn_id: espnId == null ? null : String(espnId),
  };
}

const DUMP = {
  4984: dumpRow(4984, 'Josh', 'Allen', 'QB', 'BUF', 1),
  6904: dumpRow(6904, 'Jalen', 'Hurts', 'QB', 'PHI', 2),
  4881: dumpRow(4881, 'Lamar', 'Jackson', 'QB', 'BAL', 3),
  9509: dumpRow(9509, 'Bijan', 'Robinson', 'RB', 'ATL', 4),
  4034: dumpRow(4034, 'Saquon', 'Barkley', 'RB', 'PHI', 5),
  6794: dumpRow(6794, 'Justin', 'Jefferson', 'WR', 'MIN', 8),
  // No espn_id — resolves through sleeper.js's name route.
  11111: dumpRow(11111, 'D.K.', 'Metcalf', 'WR', 'PIT', null),
  22222: dumpRow(22222, 'Brock', 'Bowers', 'TE', 'LV', null),
  // A kicker: real, understood, and not in this page's projection pool.
  33333: dumpRow(33333, 'Brandon', 'Aubrey', 'K', 'DAL', 99999),
  // An individual defender: a position this app does not roster at all.
  44444: dumpRow(44444, 'Micah', 'Parsons', 'LB', 'DAL', 88888),
};

const INDEX = buildSleeperPlayerIndex(DUMP).index;

/** Crosswalk one Sleeper team against the pool, then seat it. */
function planFor(playerIds, starterIds, profile, currentSlots, pool = POOL_BY_ID) {
  const appPlayers = [...pool.values()];
  const cross = crosswalkRoster(
    { roster_id: 1, label: 'Mine', players: playerIds, starters: starterIds },
    appPlayers,
    { index: INDEX },
  );
  const plan = planRosterSync({
    resolved: orderedRosterPlayers(cross),
    currentSlots,
    profile,
    playersById: pool,
  });
  return { cross, plan, missed: unmatchedRosterPlayers(cross) };
}

/* ==========================================================================
 * 1. Manual-only policy
 * ======================================================================== */

test('the roster sync is MANUAL: no interval timer anywhere in the view', () => {
  assert.equal(ROSTER_SYNC_MODE, 'manual');
  // A CALL, not the word — the module docstring names setInterval to forbid it.
  assert.ok(!/\bsetInterval\s*\(/.test(TEAM_SRC),
    'the Team view must never poll — the only timers are the finder debounce and '
    + 'the fetch abort');
  const timers = TEAM_SRC.match(/setTimeout\(/g) || [];
  assert.ok(timers.length <= 3, `unexpected timer count: ${timers.length}`);
});

test('this view fetches exactly one Sleeper document itself: the player dump', () => {
  assert.equal(SLEEPER_PLAYER_INDEX_URL, 'https://api.sleeper.app/v1/players/nfl');
  // /rosters and /users go through app/sleeper.js, which owns Sleeper.
  assert.ok(TEAM_SRC.includes('importSleeperTeams('));
  assert.ok(!/\/rosters['"`]|\/users['"`]/.test(TEAM_SRC),
    'the view must not hand-build Sleeper roster/user URLs — sleeper.js owns them');
  const gets = TEAM_SRC.match(/sleeperGetJson\(/g) || [];
  assert.equal(gets.length, 2, 'one definition + one call site (the player dump)');
});

/* ==========================================================================
 * 2. Seating order: Sleeper's starters take the starting slots
 * ======================================================================== */

test('starters come first, de-duplicated against the full roster list', () => {
  const cross = crosswalkRoster(
    { players: ['9509', '4984', '6794'], starters: ['6794', '0', '4984'] },
    [...POOL_BY_ID.values()],
    { index: INDEX },
  );
  const ordered = orderedRosterPlayers(cross);
  assert.deepEqual(ordered.map((r) => r.name),
    ['Justin Jefferson', 'Josh Allen', 'Bijan Robinson']);
  assert.deepEqual(ordered.map((r) => r.starter), [true, true, false]);
  // Every row carries the app's own player id, ready to write into a slot.
  ordered.forEach((r) => assert.ok(POOL_BY_ID.has(r.player_id)));
});

test('orderedRosterPlayers never throws on a shape it did not expect', () => {
  assert.deepEqual(orderedRosterPlayers(null), []);
  assert.deepEqual(orderedRosterPlayers({ starters: 3, players: 'nope' }), []);
});

test('Sleeper\'s starters are seated in starting slots; the rest hit the bench', () => {
  // Two RBs, but only Bijan is a Sleeper starter — he must get RB1.
  const { plan } = planFor(['4034', '9509'], ['9509'], DEFAULT_PROFILE, {});
  const bySlot = Object.fromEntries(plan.assigned.map((a) => [a.slot, a.name]));
  assert.equal(bySlot.RB1, 'Bijan Robinson');
  assert.equal(bySlot.RB2, 'Saquon Barkley');
});

/* ==========================================================================
 * 3. Slot vocabulary — the P1 lock
 * ======================================================================== */

test('every seated slot is a slot rosterSlots(profile) actually has', () => {
  const { plan } = planFor(['4984', '9509', '4034', '6794', '11111', '22222'], ['4984'],
    DEFAULT_PROFILE, {});
  const legal = new Set(rosterSlots(DEFAULT_PROFILE).all);
  assert.ok(plan.assigned.length > 0);
  plan.assigned.forEach((a) => assert.ok(legal.has(a.slot), `illegal slot ${a.slot}`));
  assert.deepEqual(Object.keys(plan.slots), rosterSlots(DEFAULT_PROFILE).all);
});

test('a SUPERFLEX league seats the second QB in SUPER_FLEX, never a stand-in FLEX', () => {
  const profile = normalizeProfile({
    ...DEFAULT_PROFILE,
    shape: {
      ...DEFAULT_PROFILE.shape,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN'],
    },
  });
  assert.ok(rosterSlots(profile).all.includes('SUPER_FLEX'));
  const { plan } = planFor(['4984', '6904'], ['4984', '6904'], profile, {});
  const bySlot = Object.fromEntries(plan.assigned.map((a) => [a.slot, a.name]));
  assert.equal(bySlot.QB1, 'Josh Allen');
  assert.equal(bySlot.SUPER_FLEX, 'Jalen Hurts');
});

/* ==========================================================================
 * 4. Nothing silently dropped
 * ======================================================================== */

test('a position cap leaves the extra player UNPLACED with the reason', () => {
  // The default profile caps QB at 2; a third QB has no legal slot.
  const { plan } = planFor(['4984', '6904', '4881'], [], DEFAULT_PROFILE, {});
  assert.equal(plan.assigned.length, 2);
  assert.equal(plan.unplaced.length, 1);
  assert.equal(plan.unplaced[0].name, 'Lamar Jackson');
  assert.match(plan.unplaced[0].reason, /caps QB/);
});

test('more players than slots leaves the overflow UNPLACED, never truncated', () => {
  const tiny = normalizeProfile({
    ...DEFAULT_PROFILE,
    shape: { ...DEFAULT_PROFILE.shape, roster_positions: ['QB', 'RB'] },
  });
  const { plan } = planFor(['4984', '9509', '4034'], [], tiny, {});
  assert.equal(plan.assigned.length, 2);
  assert.equal(plan.unplaced.length, 1);
  assert.equal(plan.unplaced[0].name, 'Saquon Barkley');
  assert.match(plan.unplaced[0].reason, /did not fit/);
});

test('a kicker and an IDP are surfaced by name with sleeper.js\'s own reason', () => {
  const { plan, missed } = planFor(['4984', '33333', '44444'], [], DEFAULT_PROFILE, {});
  assert.equal(plan.assigned.length, 1);
  assert.equal(missed.length, 2);
  const byName = Object.fromEntries(missed.map((m) => [m.sleeper_name, m]));
  assert.ok(byName['Brandon Aubrey'].message.length > 20);
  assert.equal(byName['Micah Parsons'].code, 'unsupported_position');
  missed.forEach((m) => assert.ok(m.sleeper_id));
});

test('Sleeper\'s "0" empty-slot marker is filtered — it is not a missing player', () => {
  const { missed } = planFor(['4984'], ['4984', '0', '0'], DEFAULT_PROFILE, {});
  assert.equal(missed.length, 0);
  // ...but the raw crosswalk did report them, so nothing was hidden upstream.
  const { cross } = planFor(['4984'], ['4984', '0', '0'], DEFAULT_PROFILE, {});
  assert.ok(cross.unresolved.some((u) => u.code === 'empty_slot'));
});

test('every crosswalked player is seated, unplaced, or reported — never vanished', () => {
  const ids = ['4984', '6904', '4881', '9509', '4034', '6794', '11111', '22222',
    '33333', '44444', '99999999'];
  const { plan, cross, missed } = planFor(ids, [], DEFAULT_PROFILE, {});
  const resolved = orderedRosterPlayers(cross).length;
  assert.equal(plan.assigned.length + plan.unplaced.length, resolved);
  assert.equal(resolved + missed.length, ids.length);
});

/* ==========================================================================
 * 5. The overwrite is visible before it happens
 * ======================================================================== */

test('the plan names every player the overwrite would remove', () => {
  const current = { QB1: 'espn-3', RB1: 'espn-6', WR1: 'espn-8' };
  const { plan } = planFor(['4984', '6794'], ['4984', '6794'], DEFAULT_PROFILE, current);
  assert.equal(plan.before_count, 3);
  assert.deepEqual(plan.dropped.map((d) => d.name).sort(),
    ['De\'Von Achane', 'Lamar Jackson']);
  assert.deepEqual(plan.added.map((a) => a.name), ['Josh Allen']);
  assert.deepEqual(plan.kept.map((k) => k.name), ['Justin Jefferson']);
  assert.equal(plan.after_count, 2);
});

test('a kept player who changes slot is reported as moved, with where he came from', () => {
  const current = { BN1: 'espn-1' };            // Josh Allen parked on the bench
  const { plan } = planFor(['4984'], ['4984'], DEFAULT_PROFILE, current);
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.added.length, 0);
  assert.deepEqual(plan.moved.map((m) => [m.name, m.from, m.slot]),
    [['Josh Allen', 'BN1', 'QB1']]);
});

test('an empty Sleeper roster plans an empty roster and says everything goes', () => {
  const current = { QB1: 'espn-1', RB1: 'espn-4' };
  const { plan } = planFor([], [], DEFAULT_PROFILE, current);
  assert.equal(plan.after_count, 0);
  assert.equal(plan.dropped.length, 2);
  Object.values(plan.slots).forEach((v) => assert.equal(v, null));
});

test('planRosterSync never throws on hostile input', () => {
  const plan = planRosterSync();
  assert.deepEqual(Object.keys(plan.slots), rosterSlots(DEFAULT_PROFILE).all);
  assert.equal(plan.after_count, 0);
  assert.deepEqual(planRosterSync({ resolved: 'nope', currentSlots: 7 }).dropped, []);
});

test('the summary lines state the removals and the unmatched, or say there are none', () => {
  const current = { QB1: 'espn-3' };
  const dirty = planFor(['4984', '33333'], ['4984'], DEFAULT_PROFILE, current);
  const lines = rosterPlanLines(dirty.plan, dirty.missed).join(' ');
  assert.match(lines, /1 player\(s\) currently on your roster are NOT on this Sleeper team/);
  assert.match(lines, /1 Sleeper player\(s\) could not be matched/);

  const clean = planFor(['4984'], ['4984'], DEFAULT_PROFILE, {});
  const cleanLines = rosterPlanLines(clean.plan, clean.missed).join(' ');
  assert.match(cleanLines, /Every player on that Sleeper roster was matched and seated/);
  assert.equal(rosterPlanLines(null, []).length, 0);
});

/* ==========================================================================
 * 6. Policy: no market data in the roster path, none in the engines
 * ======================================================================== */

test('the roster path ignores market fields entirely', () => {
  const polluted = new Map([...POOL_BY_ID.entries()]
    .map(([id, p]) => [id, { ...p, adp: 3.2, auction_value: 61.81 }]));
  const clean = planFor(['4984', '9509'], ['4984'], DEFAULT_PROFILE, {});
  const dirty = planFor(['4984', '9509'], ['4984'], DEFAULT_PROFILE, {}, polluted);
  assert.deepEqual(dirty.plan.slots, clean.plan.slots);
  assert.deepEqual(dirty.plan.assigned.map((a) => [a.slot, a.player_id]),
    clean.plan.assigned.map((a) => [a.slot, a.player_id]));
});

test('the market value cell never appears on a line that calls an engine', () => {
  // MARKET PRICES ARE DISPLAY ONLY. The auction value is read in exactly one
  // place (the display cell) and passed to nothing that produces a number.
  const engines = [
    'recommend(', 'recommendV2(', 'bestPickNow(', 'scoringAdjust(', 'weeklyPoints(',
    'teamWeeklyTotals(', 'neediestOpenSlot(', 'saveProfile(', 'profileFromCfg(',
    'createDraft(', 'createAuction(', 'planRosterSync(', 'crosswalkRoster(',
  ];
  TEAM_SRC.split('\n').forEach((line, i) => {
    if (!/mktValueById|mktBudget|auction_value/.test(line)) return;
    engines.forEach((name) => {
      assert.ok(!line.includes(name),
        `line ${i + 1} feeds a market price into ${name}: ${line.trim()}`);
    });
  });
  // And the display cell carries the app's one DISPLAY-ONLY badge, verbatim.
  assert.ok(TEAM_SRC.includes('MARKET · DISPLAY ONLY'));
  assert.ok(TEAM_SRC.includes('class="ms-badge"'));
});

test('the roster sync writes the roster key and nothing else', () => {
  // saveRoster() owns nfl2026.team.v1. The sync path must not reach for the
  // league profile, the scoring key or the taken board.
  const applyBlock = TEAM_SRC.slice(
    TEAM_SRC.indexOf("if (act === 'roster-apply')"),
    TEAM_SRC.indexOf("if (act === 'draft-start')"),
  );
  assert.ok(applyBlock.length > 200, 'roster-apply handler not found');
  assert.ok(applyBlock.includes('saveRoster(roster)'));
  assert.ok(!/saveProfile|saveTaken|localStorage\.setItem/.test(applyBlock));
  // And it cannot write without an armed confirm when the roster is not empty.
  assert.ok(applyBlock.includes('filledNow > 0 && !rosterArmed'));
});
