/* tests/feature/kdst_seating.test.mjs — R21: the Team page's player pool is the
 * pool it can SEAT, not just the offensive projections.
 *
 * tests/web/kdst_seating.spec.mjs drives the browser half of this (the finder
 * chips, the ADD button, the persisted roster). This file locks the half a
 * browser cannot reach in the sandbox: the Sleeper ROSTER SYNC crosswalk, which
 * needs a live api.sleeper.app fetch to exercise on screen but is pure code.
 *
 * THE DEFECT: app/views/team.js handed crosswalkRoster() the offence-only
 * `players` array, so a kicker and a team defence on the user's real Sleeper
 * roster came back UNRESOLVED — reported to the user under "not in this app's
 * player pool" — and planRosterSync therefore left K1 and DEF1 null. app/
 * sleeper.js has documented all along that a kicker's gsis id and a 'DST-DEN'
 * id ARE this app's ids and that it carries a `team_def` match method; the pool
 * simply never contained them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { crosswalkRoster, buildSleeperPlayerIndex } from '../../app/sleeper.js';
import { planRosterSync, orderedRosterPlayers, unmatchedRosterPlayers } from '../../app/views/team.js';
import { normalizeProfile, rosterSlots } from '../../app/league.js';
import { shapeKdst } from '../../app/kdst.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(join(REPO_ROOT, 'data', p), 'utf8'));
const TEAM_SRC = readFileSync(join(REPO_ROOT, 'app/views/team.js'), 'utf8');

const KDEF_PROFILE = normalizeProfile({
  shape: {
    teams: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
});

/** The pool app/views/team.js builds for a K/DEF league: offence + K/DST. */
function seatablePool(profile) {
  const proj = load('player_projections.json').players;
  const idx = shapeKdst(load('kdst_projections.json'), profile);
  const rows = [];
  for (const [pos, token] of [['K', 'K'], ['DEF', 'DEF']]) {
    for (const e of idx.byPosition[pos]) {
      if (e.unscored) continue;
      rows.push({
        gsis_id: e.id, name: e.name, team: e.team, position: token,
        proj_points: e.seasonPoints, kdst: e,
      });
    }
  }
  return { offence: proj, seatable: proj.concat(rows), kdstRows: rows };
}

/** A minimal Sleeper player dump carrying one real kicker, by gsis id. */
function sleeperDump(kicker) {
  return {
    9001: {
      player_id: '9001',
      full_name: kicker.name,
      position: 'K',
      fantasy_positions: ['K'],
      team: kicker.team,
      gsis_id: kicker.player_id,
    },
  };
}

test('the committed contract really does carry K and DEF ids this app can seat', () => {
  const { kdstRows } = seatablePool(KDEF_PROFILE);
  assert.ok(kdstRows.filter((r) => r.position === 'K').length >= 32);
  assert.equal(kdstRows.filter((r) => r.position === 'DEF').length, 32);
  // The pool would be worthless if the ids did not match the contract's own.
  const doc = load('kdst_projections.json');
  const ids = new Set(kdstRows.map((r) => r.gsis_id));
  assert.ok(doc.defenses.every((d) => ids.has(d.player_id)));
});

test('a team defence resolves off the bare team abbreviation — but only with the K/DST pool', () => {
  const { offence, seatable } = seatablePool(KDEF_PROFILE);
  const team = { roster_id: 1, label: 'Me', starters: ['DEN'], players: ['DEN'], reserve: [] };

  // BEFORE: the offence-only pool has no defence to match, and sleeper.js says
  // so honestly — which is exactly why the slot could never be filled.
  const before = crosswalkRoster(team, offence, {});
  assert.equal(before.starters.resolved.length, 0);
  assert.equal(unmatchedRosterPlayers(before).length, 1);
  assert.match(unmatchedRosterPlayers(before)[0].message, /no team defence for DEN/);

  // AFTER: the seatable pool resolves it by the `team_def` method, no Sleeper
  // player dump required (both sides identify a defence by its abbreviation).
  const after = crosswalkRoster(team, seatable, {});
  assert.equal(after.unresolved.length, 0);
  assert.equal(after.starters.resolved.length, 1);
  assert.equal(after.starters.resolved[0].method, 'team_def');
  assert.equal(after.starters.resolved[0].player_id, 'DST-DEN');
  assert.equal(after.starters.resolved[0].position, 'DEF');
});

test('a kicker resolves by gsis id, and planRosterSync seats him in K1', () => {
  const doc = load('kdst_projections.json');
  const kicker = doc.kickers[0];
  const { offence, seatable } = seatablePool(KDEF_PROFILE);
  const index = buildSleeperPlayerIndex(sleeperDump(kicker)).index;
  const team = { roster_id: 1, label: 'Me', starters: ['9001', 'DEN'], players: ['9001', 'DEN'], reserve: [] };

  const before = crosswalkRoster(team, offence, { index });
  assert.equal(before.starters.resolved.length, 0, 'the offence-only pool seats neither');

  const cross = crosswalkRoster(team, seatable, { index });
  assert.deepEqual(cross.unresolved, []);
  const methods = cross.starters.resolved.map((r) => r.method).sort();
  assert.deepEqual(methods, ['gsis_id', 'team_def']);

  const pool = new Map(seatable.map((p) => [String(p.gsis_id), p]));
  const plan = planRosterSync({
    resolved: orderedRosterPlayers(cross),
    currentSlots: {},
    profile: KDEF_PROFILE,
    playersById: pool,
  });
  assert.equal(plan.slots.K1, kicker.player_id, 'the kicker takes the K slot');
  assert.equal(plan.slots.DEF1, 'DST-DEN', 'the defence takes the DEF slot');
  assert.deepEqual(plan.unplaced, []);
  assert.equal(plan.after_count, 2);
  // Named in the diff the confirm step shows, not silently seated.
  assert.deepEqual(plan.added.map((r) => r.slot).sort(), ['DEF1', 'K1']);
  assert.deepEqual(plan.added.map((r) => r.position).sort(), ['DEF', 'K']);
});

test('the position cap governs K/DST exactly as it governs QB', () => {
  // The derived cap for this shape is 2 (one startable K slot + one stash), so
  // a second kicker legally takes a bench spot and a THIRD is over the cap. The
  // point is that seating did not invent a parallel rule: a kicker is capped,
  // reported and diffed by the same code path every other position uses.
  const doc = load('kdst_projections.json');
  const { seatable } = seatablePool(KDEF_PROFILE);
  const pool = new Map(seatable.map((p) => [String(p.gsis_id), p]));
  const kickers = doc.kickers.slice(0, 3).map((k, i) => ({
    player_id: k.player_id, name: k.name, position: 'K', starter: i === 0,
  }));
  const plan = planRosterSync({
    resolved: kickers,
    currentSlots: {},
    profile: KDEF_PROFILE,
    playersById: pool,
  });
  assert.equal(plan.slots.K1, kickers[0].player_id, 'the first kicker starts');
  assert.equal(plan.slots.BN1, kickers[1].player_id, 'the second is stashed on the bench');
  assert.equal(plan.unplaced.length, 1, 'the third is reported, never dropped in silence');
  assert.equal(plan.unplaced[0].player_id, kickers[2].player_id);
  assert.match(plan.unplaced[0].reason, /caps K/);
});

test('a league with NO K/DEF slot is handed the offence-only pool, unchanged', () => {
  // The gate is the profile's own geometry: rosterPositionsInPlay() names no
  // K/DEF for a default league, so `kdstRows` is empty and `seatable` IS
  // `players` — the same array object, not a copy with extras.
  assert.match(TEAM_SRC, /const seatable = kdstRows\.length \? players\.concat\(kdstRows\) : players;/);
  assert.match(TEAM_SRC, /rosterPositionsInPlay\(savedProfile\)\.filter\(isKdstPosition\)/);
  // ...and the crosswalk reads that pool rather than the raw projections.
  assert.match(TEAM_SRC, /crosswalkRoster\(rosterTeams\[rosterTeamIdx\], seatable,/);
  // R47: the DEFAULT league seats K1/DEF1, so the gate fires for it; a league
  // whose roster names no K/DEF token is the one handed the offence-only pool.
  const dflt = normalizeProfile(null);
  assert.deepEqual(rosterSlots(dflt).all.filter((s) => /^(K|DEF|DST)\d*$/.test(s)), ['K1', 'DEF1']);
  const seven = normalizeProfile({ shape: { roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'] } });
  assert.deepEqual(rosterSlots(seven).all.filter((s) => /^(K|DEF|DST)\d*$/.test(s)), [],
    'a league with no K/DEF token fields no K/DEF slot, so nothing above can fire for it');
});
