/* tests/feature/r47_alignment.test.mjs — R47 (owner's picks: "First-class
 * everywhere", "One sync = whole session", "Audit every surface to
 * league-priced numbers").
 *
 * RCA: K and DEF were profile-gated by a default roster shape that seated
 * neither, PLAYERS never listed them, three Sleeper entry points shared one
 * persistence path (TEAM parked the import until SAVE; GRADE persisted
 * nothing), and the scoring toggle could drift from the league's rec value.
 * These pins lock the fixes so no surface can quietly regress to the old
 * "K/DEF only after a sync" behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_PROFILE, DEFAULT_ROSTER_POSITIONS, normalizeProfile, rosterSlots,
  rosterPositionsInPlay, saveProfile, loadProfile, isDefaultProfile,
  saveLeagueId, loadLeagueId, LEAGUE_ID_KEY, scoringMode, leagueChipText,
} from '../../app/league.js';
import {
  STARTER_SLOTS, SLOT_ORDER, STARTER_DEMAND, slotEligible, rosterGeometry,
  loadScoringMode, scoringLockedToLeague, positionDemand,
} from '../../app/team-logic.js';
import { LINEUP_SLOTS, OFFENSE_SLOTS, bestLineup, lineupGeometry } from '../../app/lineup.js';
import { rosterShape, DEFAULT_ROSTER } from '../../app/draft-sim.js';
import { renderScoreSeg } from '../../app/render.js';
import { RESET_ALL_KEYS, restartSessionStorage } from '../../app/views/team.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');
const PLAYERS_SRC = src('app/views/players.js');
const TEAM_SRC = src('app/views/team.js');
const GRADE_SRC = src('app/views/grade.js');
const LINEUP_SRC = src('app/views/lineup.js');
const COMPARE_SRC = src('app/views/compare.js');
const MAIN_SRC = src('app/main.js');
const INDEX_SRC = src('index.html');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

/** Run `fn` with globalThis.localStorage swapped for a fake, then restore. */
function withStorage(seed, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(seed), configurable: true, writable: true });
  try { return fn(globalThis.localStorage); } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
}

const HALF_LEAGUE = normalizeProfile({
  name: 'Omilia-US',
  scoring: { rec: 0.5, pass_td: 4, rush_td: 6, rec_td: 6 },
  shape: {
    teams: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
});

/* ---- 1. FIRST-CLASS EVERYWHERE: K and DEF are in the default geometry ------- */

test('R47: the DEFAULT roster seats one K and one DEF (9 starters, 15 slots, 15 rounds)', () => {
  assert.deepEqual([...DEFAULT_ROSTER_POSITIONS],
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
  assert.equal(DEFAULT_PROFILE.shape.starters, 9);
  assert.equal(DEFAULT_PROFILE.shape.draft_rounds, 15);
  assert.deepEqual(rosterSlots(DEFAULT_PROFILE).starters, [...STARTER_SLOTS]);
  assert.deepEqual(rosterPositionsInPlay(DEFAULT_PROFILE), ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
});

test('R47: every geometry engine agrees — team-logic, lineup, draft-sim, profile', () => {
  assert.deepEqual([...STARTER_SLOTS], [...OFFENSE_SLOTS, 'K1', 'DEF1']);
  assert.deepEqual([...LINEUP_SLOTS], [...STARTER_SLOTS]);
  assert.deepEqual(lineupGeometry().map((g) => g.slot), [...STARTER_SLOTS]);
  assert.deepEqual(rosterShape(null).starters, [...STARTER_SLOTS]);
  assert.equal(DEFAULT_ROSTER.k, 1);
  assert.equal(DEFAULT_ROSTER.def, 1);
  assert.deepEqual({ ...STARTER_DEMAND }, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  assert.deepEqual(positionDemand(DEFAULT_PROFILE), positionDemand(rosterShape(null)));
  const legacy = rosterGeometry(null);
  const dflt = rosterGeometry(DEFAULT_PROFILE);
  assert.deepEqual(legacy.starters, dflt.starters);
  assert.deepEqual(legacy.positions, dflt.positions);
  assert.deepEqual(legacy.demand, dflt.demand);
  assert.deepEqual(legacy.caps, dflt.caps);
  // The no-shape and DEFAULT-profile answers never disagree for K/DEF either.
  for (const slot of SLOT_ORDER) {
    for (const pos of ['K', 'DEF', 'DST']) {
      assert.equal(slotEligible(pos, slot), slotEligible(pos, slot, DEFAULT_PROFILE), `${pos}@${slot}`);
    }
  }
  assert.equal(slotEligible('K', 'K1'), true);
  assert.equal(slotEligible('DEF', 'DEF1'), true);
  assert.equal(slotEligible('K', 'BN1'), true);
  assert.equal(slotEligible('K', 'FLEX'), false);
  assert.equal(slotEligible('DEF', 'K1'), false);
});

test('R47: the default lineup fills K1/DEF1 from the kdst feed and never fabricates them', () => {
  const roster = [
    { id: 'qb', pos: 'QB', pts: 22 },
    { id: 'rbA', pos: 'RB', pts: 20 }, { id: 'rbB', pos: 'RB', pts: 15 }, { id: 'rbC', pos: 'RB', pts: 13 },
    { id: 'wrA', pos: 'WR', pts: 18 }, { id: 'wrB', pos: 'WR', pts: 11 },
    { id: 'te', pos: 'TE', pts: 7 },
    { id: 'kA', pos: 'K', pts: 9.5 }, { id: 'dA', pos: 'DEF', pts: 8.2 },
  ];
  const unfed = bestLineup(roster);
  assert.equal(unfed.slotCount, 9);
  assert.equal(unfed.projectedSlots, 7);
  assert.equal(unfed.slots.K1, null, 'no feed -> empty, not a 0');
  assert.equal(unfed.total, 22 + 20 + 15 + 18 + 11 + 7 + 13);
  const fed = bestLineup(roster, undefined, { feeds: ['K', 'DEF'] });
  assert.equal(fed.projectedSlots, 9);
  assert.equal(fed.slots.K1, 'kA');
  assert.equal(fed.slots.DEF1, 'dA');
  assert.equal(Math.round((fed.total - unfed.total) * 10) / 10, 17.7);
});

/* ---- 2. PLAYERS lists K and DEF, priced by the kdst contract ---------------- */

test('R47: PLAYERS has K and DEF chips and lazily seats kdst rows priced by the league', () => {
  assert.match(PLAYERS_SRC, /const POSITIONS = \['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'\];/);
  assert.match(PLAYERS_SRC, /async function ensureKdst\(\)/);
  assert.match(PLAYERS_SRC, /import\('\.\.\/kdst\.js'\)/, 'kdst is a lazy import (perf budget)');
  assert.match(PLAYERS_SRC, /shapeKdst\(/, 'rows are priced by the kdst contract, never an offence conversion');
  assert.match(PLAYERS_SRC, /proj_points: e\.seasonPoints/);
  assert.match(PLAYERS_SRC, /players\.concat\(kdstRows\)/, 'the pool is offence + kdst rows');
  assert.match(PLAYERS_SRC, /if \(\(active === 'K' \|\| active === 'DEF'\) && kdstState === 'idle'\) ensureKdst\(\);/);
});

/* ---- 3. ONE SYNC = WHOLE SESSION -------------------------------------------- */

test('R47: a TEAM Sleeper sync SAVES the profile, locks scoring, remembers the id, and announces it', () => {
  const start = TEAM_SRC.indexOf("act === 'sleeper-sync'");
  assert.ok(start > 0);
  const branch = TEAM_SRC.slice(start, start + 4000);
  assert.match(branch, /saveProfile\(importProfile\)/);
  assert.match(branch, /localStorage\.setItem\(SCORING_KEY, nextMode\)/);
  assert.match(branch, /saveLeagueId\(idText\)/);
  assert.match(branch, /new Event\('nfl2026:league'\)/);
});

test('R47: a GRADE Sleeper load runs the same sync (saves the profile even pre-draft)', () => {
  assert.match(GRADE_SRC, /async function syncLeagueSettings\(sleeper, idText\)/);
  const start = GRADE_SRC.indexOf('async function syncLeagueSettings');
  const fn = GRADE_SRC.slice(start, start + 1200);
  assert.match(fn, /importFromSleeper\(idText\)/);
  assert.match(fn, /saveProfile\(next\)/);
  assert.match(fn, /localStorage\.setItem\(SCORING_KEY, mode\)/);
  assert.match(fn, /saveLeagueId\(idText\)/);
  assert.match(fn, /new Event\('nfl2026:league'\)/);
  assert.match(GRADE_SRC, /const synced = await syncLeagueSettings\(sleeper, idText\);/);
  assert.match(GRADE_SRC, /loadLeagueId\(\)/, 'the id field prefills from the remembered league');
});

test('R47: league id round-trips through storage and is wiped by RESET ALL', () => {
  const store = fakeStorage();
  assert.equal(loadLeagueId(store), null, 'absent is null, never an empty string');
  saveLeagueId(' 1393691504228184064 ', store);
  assert.equal(loadLeagueId(store), '1393691504228184064');
  assert.equal(store.getItem(LEAGUE_ID_KEY), '1393691504228184064');
  assert.equal(LEAGUE_ID_KEY, 'nfl2026.league_id.v1');
  assert.ok(RESET_ALL_KEYS.includes(LEAGUE_ID_KEY), 'RESET ALL clears the remembered league id');
  assert.ok(RESET_ALL_KEYS.includes('nfl2026.league.v1'));
  assert.ok(RESET_ALL_KEYS.includes('nfl2026.scoring.v1'));
});

test('R47: RESTART SESSION keeps the synced league applied; only RESET ALL clears it', () => {
  const store = fakeStorage({ 'nfl2026.team.v1': '{}', 'nfl2026.taken.v1': '[]' });
  saveProfile(HALF_LEAGUE, store);
  saveLeagueId('1393691504228184064', store);
  const out = restartSessionStorage(store);
  assert.deepEqual(out, { stashed: false, kept: true });
  assert.deepEqual(loadProfile(store), HALF_LEAGUE);
  assert.equal(loadLeagueId(store), '1393691504228184064');
  assert.equal(store.getItem('nfl2026.scoring.v1'), 'half', 'toggle follows the league rec');
  assert.equal(store.getItem('nfl2026.team.v1'), null);
  assert.equal(store.getItem('nfl2026.taken.v1'), null);
});

/* ---- 4. SCORING IS LOCKED TO THE LEAGUE ON EVERY PAGE ----------------------- */

test('R47: loadScoringMode follows the saved league rec value and ignores a drifted toggle', () => {
  withStorage({ 'nfl2026.scoring.v1': 'std' }, (store) => {
    assert.equal(loadScoringMode(), 'std', 'no league -> the toggle');
    assert.equal(scoringLockedToLeague(), false);
    saveProfile(HALF_LEAGUE, store);
    assert.equal(scoringMode(HALF_LEAGUE), 'half');
    assert.equal(loadScoringMode(), 'half', 'the league wins over the stale toggle');
    assert.equal(scoringLockedToLeague(), true);
    // A custom rec value (0.75) cannot map to a mode -> the toggle stays live.
    saveProfile(normalizeProfile({ ...HALF_LEAGUE, scoring: { ...HALF_LEAGUE.scoring, rec: 0.75 } }), store);
    assert.equal(loadScoringMode(), 'std');
    assert.equal(scoringLockedToLeague(), false);
  });
});

test('R47: the scoring segment renders disabled and labelled when locked', () => {
  const free = renderScoreSeg('ppr');
  assert.doesNotMatch(free, /disabled/);
  assert.doesNotMatch(free, /LOCKED TO LEAGUE/);
  const locked = renderScoreSeg('half', true);
  assert.equal((locked.match(/disabled/g) || []).length, 3, 'all three buttons disabled');
  assert.match(locked, /LOCKED TO LEAGUE/);
  assert.match(locked, /scoreseg--locked/);
  assert.match(locked, /data-scoring="half"[^>]*class="scoreseg--active"/);
  assert.match(PLAYERS_SRC, /renderScoreSeg\(scoring, scoringLocked\)/);
});

/* ---- 5. EVERY SURFACE PRICES UNDER THE LEAGUE ------------------------------- */

test('R47: every projection surface stamps league extras and prices through scoringAdjust/projSeason', () => {
  for (const [name, s] of [['players', PLAYERS_SRC], ['team', TEAM_SRC], ['lineup', LINEUP_SRC],
    ['compare', COMPARE_SRC], ['grade', GRADE_SRC]]) {
    assert.match(s, /withLeagueExtras\(/, `${name} stamps league extras`);
    assert.ok(/scoringAdjust\(|projSeason\(/.test(s), `${name} prices through the league-aware path`);
    assert.match(s, /loadScoringMode\(\)|scoringLockedToLeague\(\)|loadProfile\(\)/, `${name} reads the saved league`);
  }
  assert.match(PLAYERS_SRC, /LEAGUE-PRICED projection/);
});

test('R47: the league chip states the session-wide truth on every page', () => {
  assert.match(INDEX_SRC, /id="league-chip"/);
  assert.match(MAIN_SRC, /function renderLeagueChip\(\)/);
  assert.match(MAIN_SRC, /leagueChipText\(profile, id\)/);
  assert.match(MAIN_SRC, /window\.addEventListener\('nfl2026:league', renderLeagueChip\);/);
  assert.match(MAIN_SRC, /hashchange/);
  assert.equal(leagueChipText(null), 'NO LEAGUE · STD PPR');
  assert.equal(leagueChipText(DEFAULT_PROFILE), 'NO LEAGUE · STD PPR');
  assert.equal(leagueChipText(HALF_LEAGUE, ''), 'LEAGUE: Omilia-US · SCORING APPLIED');
  assert.equal(leagueChipText(HALF_LEAGUE, '1393691504228184064'), 'LEAGUE: Omilia-US · SCORING APPLIED · SLEEPER');
  assert.equal(isDefaultProfile(HALF_LEAGUE), false);
});
