/* tests/feature/r48_team_sync.test.mjs — R48-A (owner's pick: "One press does
 * it all"). RCA: the R47 remount after SYNC NOW reset the mount-local league
 * id to '' so SYNC ROSTER refused with "enter your league id first"; nothing
 * loaded. Now SYNC NOW saves the league, remounts, and carries straight on
 * into the roster read; the one thing a login would have told us (which
 * roster is mine) is asked once and remembered per league.
 * R52 moved the hand-off pin: the remount is gone (see r52_team_sync.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MY_ROSTER_KEY, loadMyRosterMap, rememberedRosterId, saveMyRoster, RESET_ALL_KEYS,
} from '../../app/views/team.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEAM_SRC = readFileSync(join(ROOT, 'app/views/team.js'), 'utf8');
const LINEUP_SRC = readFileSync(join(ROOT, 'app/views/lineup.js'), 'utf8');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('R48: the league id field is seeded from the remembered league, so a remount cannot blank it', () => {
  assert.match(TEAM_SRC, /let sleeperId = loadLeagueId\(\) \|\| '';/);
  assert.match(TEAM_SRC, /value="\$\{esc\(sleeperId\)\}"/, 'the input renders the seeded id');
});

test('R48 (moved by R52): SYNC NOW continues into the roster read in the SAME mount (one press)', () => {
  /* R52 — the R48 hand-off (a module flag consumed by a remount) is what
   * raced: two async mounts of one element, whichever reached the flag first
   * took it, the other painted over it. The one-press contract is unchanged;
   * it is now kept without a remount — see tests/feature/r52_team_sync.test.mjs. */
  const sync = TEAM_SRC.slice(TEAM_SRC.indexOf("act === 'sleeper-sync'"), TEAM_SRC.indexOf("act === 'sleeper-paste'"));
  assert.doesNotMatch(sync, /pendingAutoRoster/, 'the remount hand-off flag is gone');
  assert.doesNotMatch(sync, /mountTeam\(el\)/, 'SYNC NOW no longer re-mounts the view');
  assert.match(sync, /adoptSavedProfile\(importProfile, wrote\);/, 'the saved profile is adopted in place');
  assert.match(sync, /Promise\.resolve\(runRosterSync\(\)\)/, 'and the roster read follows in the same mount');
  const tail = TEAM_SRC.slice(TEAM_SRC.lastIndexOf('  paintAll();'));
  assert.doesNotMatch(tail, /runRosterSync\(\)/, 'the mount tail no longer starts a roster read');
});

test('R48: the remembered roster round-trips per league and is wiped by RESET ALL', () => {
  const store = fakeStorage();
  assert.equal(MY_ROSTER_KEY, 'nfl2026.myroster.v1');
  assert.deepEqual(loadMyRosterMap(store), {});
  assert.equal(rememberedRosterId('1367481303166914560', store), null, 'absent is null, never 0');
  assert.equal(saveMyRoster('1367481303166914560', 4, store), true);
  assert.equal(saveMyRoster('1393691504228184064', '2', store), true);
  assert.equal(rememberedRosterId('1367481303166914560', store), 4);
  assert.equal(rememberedRosterId('1393691504228184064', store), 2);
  // Quoted keys: a 19-digit numeric literal would lose precision as an object key.
  assert.deepEqual(loadMyRosterMap(store), { '1367481303166914560': 4, '1393691504228184064': 2 });
  saveMyRoster('1367481303166914560', null, store);
  assert.equal(rememberedRosterId('1367481303166914560', store), null);
  // Corrupt storage reads as nothing remembered.
  const bad = fakeStorage({ [MY_ROSTER_KEY]: '[1,2' });
  assert.deepEqual(loadMyRosterMap(bad), {});
  assert.equal(saveMyRoster('', 4, store), false, 'no league id, nothing written');
  assert.ok(RESET_ALL_KEYS.includes(MY_ROSTER_KEY));
  assert.ok(RESET_ALL_KEYS.includes('nfl2026.synclog.v1'), 'RESET ALL clears the LEAGUE tab log too');
});

test('R48-B wiring: both syncs write the LEAGUE tab log', () => {
  const sync = TEAM_SRC.slice(TEAM_SRC.indexOf("act === 'sleeper-sync'"), TEAM_SRC.indexOf("act === 'sleeper-paste'"));
  assert.match(sync, /recordSync\(\{\s*kind: 'settings'/);
  assert.match(sync, /scoring key\(s\) differ from standard PPR/);
  const start = TEAM_SRC.indexOf('function applyRosterPlan(');
  const block = TEAM_SRC.slice(start, TEAM_SRC.indexOf('/** Fold an ImportResult into the panel', start));
  assert.match(block, /recordSync\(\{\s*kind: 'roster'/);
});

test('R48: the roster read selects a remembered team and seats it when nobody would be dropped', () => {
  const run = TEAM_SRC.slice(TEAM_SRC.indexOf('async function runRosterSync()'), TEAM_SRC.indexOf('function rosterFilledCount()'));
  assert.match(run, /const remembered = rememberedRosterId\(leagueId\);/);
  assert.match(run, /rosterTeams\.findIndex\(\(t\) => Number\(t\.roster_id\) === remembered\)/);
  assert.match(run, /rosterFilledCount\(\) === 0 \|\| rosterPlan\.dropped\.length === 0/);
  assert.match(run, /applyRosterPlan\(\{ auto: true \}\)/);
  assert.match(run, /PICK YOUR TEAM \(banner above the roster\)/);
  assert.match(run, /scrollToSyncBar\(\);/, 'the next step is brought on screen');
  assert.match(TEAM_SRC, /id="t-syncbar"/, 'the banner slot sits above the roster grid');
  assert.match(TEAM_SRC, /ONE STEP LEFT — PICK YOUR TEAM\./);
  assert.match(TEAM_SRC, /SEATED FROM SLEEPER/);
  // The picker remembers the choice and seats on the spot under the same rule.
  const picker = TEAM_SRC.slice(TEAM_SRC.indexOf("sel.dataset.rcfg !== 'team'"), TEAM_SRC.indexOf('// League-profile selects'));
  assert.match(picker, /saveMyRoster\(pickedLeague, picked\.roster_id\)/);
  assert.match(picker, /rosterFilledCount\(\) === 0 \|\| rosterPlan\.dropped\.length === 0/);
});

test('R48: the auto path never removes a seated player; the manual confirm still can', () => {
  const start = TEAM_SRC.indexOf('function applyRosterPlan(');
  const block = TEAM_SRC.slice(start, TEAM_SRC.indexOf('/** Fold an ImportResult into the panel', start));
  assert.match(block, /!\(auto && rosterPlan\.dropped\.length === 0\)/);
  assert.match(block, /if \(auto\) \{ paintDraft\(\); return false; \}/);
  assert.match(block, /rosterArmed = true;/, 'the deliberate second tap survives for the manual path');
  assert.match(block, /saveMyRoster\(leagueId, team\.roster_id\)/);
  assert.match(block, /LINEUP and GRADE now read this roster/);
});

test('R48-D: TEAM and LINEUP say when a league fields no K slot', () => {
  assert.match(TEAM_SRC, /rosterPositionsInPlay\(savedProfile\)\.includes\('K'\)/);
  assert.match(TEAM_SRC, /This league fields no K slot — no kicker is /);
  assert.match(LINEUP_SRC, /rosterPositionsInPlay\(profile\)\.includes\('K'\)/);
  assert.match(LINEUP_SRC, /This league fields no K slot — no kicker is seated or /);
});
