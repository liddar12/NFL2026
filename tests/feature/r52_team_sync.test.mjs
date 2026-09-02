/* tests/feature/r52_team_sync.test.mjs — R52 (owner's RCA, desktop Safari,
 * intermittent): SYNC NOW sometimes seated the roster and sometimes left the
 * tab showing the league header only; a refresh and a second press worked.
 *
 * Root cause: SYNC NOW saved the profile, set a module flag
 * (pendingAutoRoster) and called mountTeam(el) DIRECTLY, bypassing the
 * router's navSeq guard. Two async mounts of one element could be alive at
 * once; whichever reached the flag first consumed it, and the roster result
 * painted into DOM the other mount had replaced. It also re-fetched Sleeper's
 * ~5 MB player dump on every press.
 *
 * What this pins:
 *   1. no pendingAutoRoster, no remount at the SYNC NOW site — the saved
 *      profile is adopted in place and the roster read follows in the SAME
 *      mount;
 *   2. the mount-sequence guard exists and is asked at every await boundary
 *      that writes DOM on the sync / roster paint path;
 *   3. the two resets are the ONLY remounts and go through remount();
 *      RE-APPLY and SAVE are in-place repaints;
 *   4. the player dump goes through app/sleeper.js loadSleeperPlayerIndex
 *      (memoized for the session) with a progress line, and this view fetches
 *      nothing itself;
 *   5. the in-place derivation equals a fresh mount's derivation for the
 *      P.T.I. fixture profile — same function, same inputs, same output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { deriveLeagueState, SLEEPER_PLAYER_INDEX_URL } from '../../app/views/team.js';
import { PLAYER_INDEX_URL, sleeperToProfile } from '../../app/sleeper.js';
import {
  loadProfile, normalizeProfile, saveProfile, scoringMode, rosterPositionsInPlay,
} from '../../app/league.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const TEAM_SRC = src('app/views/team.js');

/** JS source with comments stripped — prose about a claim never trips a pin. */
const code = TEAM_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const slice = (from, to) => {
  const a = TEAM_SRC.indexOf(from);
  const b = TEAM_SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `could not slice ${from} .. ${to}`);
  return TEAM_SRC.slice(a, b);
};

/* ---- 1. single pass ------------------------------------------------------ */

test('R52: the remount hand-off is gone — no flag, no direct mount at the SYNC NOW site', () => {
  assert.ok(!TEAM_SRC.includes('pendingAutoRoster'), 'pendingAutoRoster is deleted, not just unused');
  const sync = slice("act === 'sleeper-sync'", "act === 'sleeper-paste'");
  assert.doesNotMatch(sync, /mountTeam\(el\)/, 'SYNC NOW must not mount the view it is running in');
  assert.doesNotMatch(sync, /remount\(\)/, 'nor go through the remount helper');
  assert.match(sync, /saveProfile\(importProfile\)/);
  assert.match(sync, /saveLeagueId\(idText\)/);
  assert.match(sync, /new Event\('nfl2026:league'\)/, 'the LEAGUE chip event dispatch stays');
  // Save, adopt in place, paint, then the roster read — in that order, one mount.
  const iSave = sync.indexOf('saveProfile(importProfile)');
  const iAdopt = sync.indexOf('adoptSavedProfile(importProfile, wrote);');
  const iPaint = sync.indexOf('paintAll();', iAdopt);
  const iRoster = sync.indexOf('Promise.resolve(runRosterSync())', iPaint);
  assert.ok(iSave >= 0 && iAdopt > iSave && iPaint > iAdopt && iRoster > iPaint,
    'save -> adoptSavedProfile -> paintAll -> runRosterSync, in one handler');
  // The mount tail starts nothing: a fresh mount never continues a press it did not receive.
  const tail = TEAM_SRC.slice(TEAM_SRC.lastIndexOf('  paintAll();'));
  assert.doesNotMatch(tail, /runRosterSync/);
  assert.doesNotMatch(tail, /pendingAutoRoster/);
});

test('R52: adoptSavedProfile remakes everything a fresh mount derives from the profile', () => {
  const fn = slice('function adoptSavedProfile(profile, wrote) {', '  /* ---- events');
  // What a fresh mount reads back, or the in-memory profile when storage refused.
  assert.match(fn, /savedProfile = wrote \? loadProfile\(\) : normalizeProfile\(profile\);/);
  assert.match(fn, /stagedProfile = cloneProfile\(savedProfile\);/);
  assert.match(fn, /const remapped = cfgFromProfile\(savedProfile\);/);
  assert.match(fn, /Object\.assign\(draftCfg, remapped\.cfg\);/);
  assert.match(fn, /mode = loadScoring\(\);/, 'the scoring mode is re-read (SYNC NOW may have locked it)');
  assert.match(fn, /applyLeagueState\(\);/, 'the derived maps and roster are rebuilt');
  assert.match(fn, /\.view-sub/, 'the header names the re-read scoring mode');
  // ONE derivation path: the mount's applyLeagueState is the only caller of
  // deriveLeagueState, and it runs at mount AND from adoptSavedProfile.
  assert.equal((code.match(/= deriveLeagueState\(\{/g) || []).length, 1, 'exactly one call site');
  assert.equal((code.match(/applyLeagueState\(\);/g) || []).length, 2, 'mount + adoptSavedProfile');
  assert.match(fn, /_ourDollars = null;|applyLeagueState\(\);/);
  const apply = slice('function applyLeagueState() {', '  applyLeagueState();');
  assert.match(apply, /_ourDollars = null;/, 'the OURS price memo is dropped with the profile (R30c)');
  assert.match(TEAM_SRC, /let mode = loadScoring\(\);/, 'mode is reassignable');
});

/* ---- 2. the mount guard --------------------------------------------------- */

test('R52: a module-level mount sequence, captured per mount, asked at every DOM-writing await', () => {
  assert.match(TEAM_SRC, /^let mountSeq = 0;/m);
  const mount = slice('export default async function mountTeam(el) {', "el.innerHTML = '<div class=\"state state--loading\">");
  assert.match(mount, /const seq = \+\+mountSeq;/);
  assert.match(mount, /seq === mountSeq && el\.isConnected/, 'the guard reads seq and connectedness');
  assert.match(mount, /console\.debug\(/, 'one debug line per bail');
  assert.equal((code.match(/console\.debug\(/g) || []).length, 1, 'exactly one debug line (inside stale())');
  // The feeds await (paints the shell or an error state).
  assert.match(TEAM_SRC, /getKdstProjections\(\),\n\s*\]\);\n\s*if \(stale\('feeds'\)\) return;/);
  // runRosterSync: rosters, the player list (and its progress ticks), the NFL week.
  const run = slice('async function runRosterSync()', 'function scrollToSyncBar()');
  assert.match(run, /const teamsRes = await importSleeperTeams\(leagueId\);\n\s*if \(stale\('rosters'\)\) return;/);
  assert.match(run, /await loadSleeperPlayerIndex\(\{[\s\S]*?\}\);\n\s*if \(stale\('player list'\)\) return;/);
  assert.match(run, /onProgress: \(\{ bytes \}\) => \{\n\s*if \(stale\('player list progress'\)\) return;/);
  assert.match(run, /if \(stale\('nfl week'\)\) return;/);
  // The SYNC NOW continuation and every roster-sync failure handler.
  const sync = slice("act === 'sleeper-sync'", "act === 'sleeper-paste'");
  assert.match(sync, /\.then\(\(res\) => \{\n\s*(\/\/.*\n\s*)*if \(stale\('SYNC NOW'\)\) return;/);
  assert.match(sync, /if \(stale\('SYNC NOW failure'\)\) return;/);
  assert.equal((sync.match(/if \(stale\('roster sync failure'\)\) return;/g) || []).length, 1);
  const rs = slice("act === 'roster-sync'", "act === 'roster-apply'");
  assert.match(rs, /if \(stale\('roster sync failure'\)\) return;/);
  // The deferred scroll after a seat.
  assert.match(TEAM_SRC, /setTimeout\(\(\) => \{ if \(!stale\('scroll'\)\) scrollToSyncBar\(\); \}, 0\);/);
  // The shell anchor: another view taking #view disconnects it.
  assert.match(TEAM_SRC, /shell = el\.querySelector\('#t-syncbar'\);/);
});

/* ---- 3. the remaining remounts -------------------------------------------- */

test('R52: the two resets are the only remounts and go through remount(); RE-APPLY and SAVE repaint in place', () => {
  assert.equal((code.match(/mountTeam\(el\)\)/g) || []).length, 1, 'one mountTeam(el) call in the file');
  assert.equal((code.match(/mountTeam\(el\)/g) || []).length, 2, 'that call plus the definition, nothing else');
  const helper = slice('function remount() {', 'function adoptSavedProfile(');
  assert.match(helper, /mountSeq \+= 1;\n\s*return Promise\.resolve\(mountTeam\(el\)\)/, 'bump first, then mount');
  const restart = slice("act === 'restart-session'", "act === 'reset-all'");
  const wipe = slice("act === 'reset-all'", "act === 'league-reapply'");
  const reapply = slice("act === 'league-reapply'", "act === 'league-save'");
  const save = slice("act === 'league-save'", "act === 'sleeper-sync'");
  assert.match(restart, /restartSessionStorage\(\)[\s\S]*remount\(\);/);
  assert.match(wipe, /wipeAllAppStorage\(\)[\s\S]*remount\(\);/);
  for (const [name, branch] of [['RE-APPLY', reapply], ['SAVE', save]]) {
    assert.doesNotMatch(branch, /remount\(\)|mountTeam\(el\)/, `${name} does not remount`);
    assert.match(branch, /adoptSavedProfile\(\w+, wrote\);/, `${name} adopts the saved profile in place`);
    assert.match(branch, /paintAll\(\);/, `${name} repaints everything the profile feeds`);
    assert.doesNotMatch(branch, /leagueFlash =/, `${name} reports through leagueStatus, not the remount flash`);
  }
  assert.equal((code.match(/remount\(\);/g) || []).length, 2, 'RESTART + RESET ALL');
});

/* ---- 4. the player dump ---------------------------------------------------- */

test('R52: the player dump is read through app/sleeper.js once per session, with a progress line', () => {
  assert.ok(!TEAM_SRC.includes('sleeperGetJson'), 'the view has no fetch helper of its own any more');
  assert.ok(!TEAM_SRC.includes('SLEEPER_INDEX_TIMEOUT_MS'), 'its abort ceiling went with it');
  assert.equal(SLEEPER_PLAYER_INDEX_URL, PLAYER_INDEX_URL, 'the pinned URL is the loader\'s own');
  assert.ok(!/fetch\(/.test(code.replace(/fetchSleeperState/g, '')), 'no fetch() call anywhere in the view');
  const run = slice('async function runRosterSync()', 'function scrollToSyncBar()');
  assert.equal((run.match(/loadSleeperPlayerIndex\(\{/g) || []).length, 1);
  assert.match(run, /sleeperIndex = idxRes\.index;/, 'the mount keeps the built index for buildRosterPlan/companion');
  assert.match(run, /idxRes\.cached\n?\s*\? 'Sleeper\\'s player list: cached from earlier this session\.'/);
  assert.match(run, /Reading Sleeper's player list… \$\{mb\(bytes\)\}/, 'progress shows the MB so far');
  assert.match(run, /idxRes\.error && idxRes\.error\.message/, 'the loader\'s failure is shown verbatim');
  const bar = slice('function syncBarHtml()', 'function paintSyncBar()');
  assert.match(bar, /sync-bar-prog/, 'the banner carries the progress line while busy');
  assert.match(TEAM_SRC, /const mb = \(bytes\) => `\$\{\(Number\(bytes\) \/ 1048576\)\.toFixed\(1\)\} MB`;/);
  // Copy: the boundary is the page load now, and the old TEAM-tab boundary is gone.
  assert.ok(TEAM_SRC.includes('kept while you stay on this '));
  assert.ok(TEAM_SRC.includes('page — any tab, until you reload — so a later sync does not re-download it.'));
  assert.ok(!TEAM_SRC.includes('leaving the tab drops'));
});

/* ---- 5. in-place derivation == fresh mount's ------------------------------ */

const readJson = (rel) => JSON.parse(src(rel));

function ptiProfile() {
  const res = sleeperToProfile(readJson('tests/fixtures/sleeper_pti/league.json'), { source: 'fixture', now: 0 });
  assert.equal(res.ok, true, 'the P.T.I. fixture must import as a profile');
  return normalizeProfile(res.profile);
}

function feeds() {
  const players = readJson('data/player_projections.json').players;
  const weeklyBase = new Map();
  readJson('data/player_weekly.json').players.forEach((w) => weeklyBase.set(String(w.gsis_id), w));
  const kdstDoc = readJson('data/kdst_projections.json');
  return { players, weeklyBase, kdstDoc };
}

/** Everything deriveLeagueState returns, in a comparable (JSON) shape. */
function snapshot(d) {
  const mapObj = (m) => Object.fromEntries([...m.entries()]);
  return {
    weekly: mapObj(d.weeklyById),
    kdstSeatTokens: d.kdstSeatTokens,
    kdstRows: d.kdstRows.map((r) => ({ ...r, kdst: undefined })),
    seatable: d.seatable.map((p) => String(p.gsis_id)),
    playersById: [...d.playersById.keys()],
    adjById: mapObj(d.adjById),
    scaledById: mapObj(d.scaledById),
    sortedPlayers: d.sortedPlayers.map((p) => String(p.gsis_id)),
    sortedKdst: d.sortedKdst.map((p) => String(p.gsis_id)),
    kdstChips: d.kdstChips,
    kdstUnresolvedSlots: [...d.kdstUnresolvedSlots],
    roster: d.roster,
  };
}

test('R52: the in-place derivation equals a fresh mount\'s derivation for the P.T.I. profile', () => {
  const imported = ptiProfile();
  const mode = scoringMode(imported) === 'custom' ? 'ppr' : scoringMode(imported);
  const { players, weeklyBase, kdstDoc } = feeds();

  // A fresh mount: the profile SYNC NOW wrote, read back through loadProfile.
  const store = fakeStorage();
  assert.equal(saveProfile(imported, store), true);
  const fresh = deriveLeagueState({ savedProfile: loadProfile(store), players, weeklyBase, kdstDoc, mode });
  // In place, storage refused: the in-memory profile drives the page.
  const inPlace = deriveLeagueState({ savedProfile: normalizeProfile(imported), players, weeklyBase, kdstDoc, mode });
  assert.deepEqual(snapshot(inPlace), snapshot(fresh));

  // And it is a real derivation of THIS league, not a pass-through: P.T.I.
  // fields a DEF slot, so the seatable pool grows by its defences and the
  // finder gets a DEF chip; the offence maps are priced under the league.
  assert.ok(rosterPositionsInPlay(imported).includes('DEF'));
  assert.deepEqual(fresh.kdstChips, ['DEF']);
  assert.ok(fresh.kdstRows.length >= 30, `defences shaped: ${fresh.kdstRows.length}`);
  assert.equal(fresh.seatable.length, players.length + fresh.kdstRows.length);
  assert.equal(fresh.playersById.size, fresh.seatable.length);
  assert.equal(fresh.adjById.size, fresh.seatable.length);
  assert.equal(fresh.sortedPlayers.length, players.length, 'the best-available order is offence only');
  assert.equal(fresh.kdstUnresolvedSlots.size, 0, 'the K/DST feed is up, so no slot is retained blind');
  // The same inputs under the DEFAULT profile (which fields K AND DEF) derive
  // something different — the profile is genuinely an input, so adopting it
  // in place matters.
  const dflt = deriveLeagueState({ savedProfile: loadProfile(fakeStorage()), players, weeklyBase, kdstDoc, mode });
  assert.deepEqual(dflt.kdstChips, ['K', 'DEF']);
  assert.ok(dflt.seatable.length > fresh.seatable.length, 'kickers seat under the default, not under P.T.I.');
  assert.notDeepEqual(snapshot(dflt).adjById, snapshot(fresh).adjById);
  // The unstamped weekly map is untouched by the derivation (it is re-stamped
  // from the base on every adoption, never stamped twice).
  assert.ok(![...weeklyBase.values()].some((e) => e && e.extra_pts != null));
});
