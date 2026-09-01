/* tests/feature/r34_reset_theme.test.mjs — R34: the two-button reset, the
 * saved-not-applied league stash, always-HIG, the mandatory sale capture, and
 * per-team names.
 *
 * PURE node:test, no browser. Where R34 factored a pure helper (the reset key
 * list, the stash, the auction-teams record, the name precedence, the sale
 * validation), BEHAVIOUR is tested through it over a fake storage; where the
 * change is view wiring (team.js's onAction) or static contract (index.html),
 * source-level pins stand in — the same split every suite here uses.
 *
 * Also carries the R34 RCA lock for "auction vs snake score changes": the
 * investigation found NO score divergence by draft format — the one
 * format-gated list consumer is an affordability FILTER (team-logic
 * affordableOnly via recommend/bestPickNow opts.budget) that drops rows and
 * never rescores one. That property is asserted as behaviour below, so a
 * future format-dependent rescore fails a test instead of a user's trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  AUCTION_TEAMS_VERSION, RESET_ALL_KEYS, TEAM_NAME_MAX,
  auctionTeamName, loadAuctionTeams, normalizeAuctionTeams,
  restartSessionStorage, saveAuctionTeams, validateSoldEntry, wipeAllAppStorage,
} from '../../app/views/team.js';
import {
  DEFAULT_PROFILE, LEAGUE_KEY, LEAGUE_STASH_KEY,
  clearStashedProfile, loadProfile, loadStashedProfile, normalizeProfile,
  stashProfile,
} from '../../app/league.js';
import { MOCKS_KEY, MOCKS_KEY_V1 } from '../../app/mocks.js';
import { recommend } from '../../app/team-logic.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
/** JS source with comments stripped — prose about a claim never trips a pin. */
const prose = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const html = (rel) => read(rel).replace(/<!--[\s\S]*?-->/g, ' ');

const TEAM = 'app/views/team.js';

/** Minimal Storage double (the app injects storage into every pure helper). */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

/** The source of one `act === '<name>'` branch of team.js's onAction. */
function actBranch(src, name, nextName) {
  const start = src.indexOf(`act === '${name}'`);
  const end = src.indexOf(`act === '${nextName}'`);
  assert.ok(start >= 0 && end > start, `could not slice the ${name} branch`);
  return src.slice(start, end);
}

/* A non-default profile shaped like the owner's real imported league. */
const OMILIA = {
  version: 1,
  name: 'Omilia-US',
  scoring: { rec: 0.5, pass_yd: 0.04, rush_yd: 0.1 },
  shape: {
    teams: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN'],
    position_caps: { QB: 2, K: 1, DEF: 1 },
  },
};

/* ==========================================================================
   1 · RESET ALL — the enumerated key list and the wipe
   ========================================================================== */

test('RESET_ALL_KEYS enumerates every nfl2026.* data key, and only ours', () => {
  const expected = [
    'nfl2026.team.v1', 'nfl2026.scoring.v1', 'nfl2026.ai.v1', 'nfl2026.taken.v1',
    'nfl2026.league.v1', 'nfl2026.leaguestash.v1', 'nfl2026.auctionteams.v1',
    'nfl2026.mockhistory.v2', 'nfl2026.mocklocks.v1', 'nfl2026.theme.v1',
    'nfl2026.league_id.v1',                          // R47: the remembered Sleeper league id
    'nfl2026.myroster.v1',                           // R48: which Sleeper roster is mine, per league
  ];
  assert.deepEqual([...RESET_ALL_KEYS].sort(), expected.sort(),
    'the wipe list must name exactly the app\'s data keys — a new nfl2026.* '
    + 'key must be added here deliberately, and a wildcard must never replace '
    + 'the enumeration');
  for (const k of RESET_ALL_KEYS) {
    assert.match(k, /^nfl2026\./, `non-app key in the wipe list: ${k}`);
  }
  // The gate unlock is ACCESS, not data — wiping it would log the owner out
  // mid-session, which is not part of the owner's wipe list.
  assert.ok(!RESET_ALL_KEYS.includes('nfl2026.unlock.v1'),
    'RESET ALL must not re-lock the password gate');
});

test('wipeAllAppStorage removes exactly the listed keys, nothing else', () => {
  const store = fakeStorage({
    'nfl2026.team.v1': '{"slots":{}}',
    'nfl2026.league.v1': JSON.stringify(OMILIA),
    'nfl2026.leaguestash.v1': '{"version":1,"profile":{}}',
    'nfl2026.mockhistory.v2': '[]',
    'nfl2026.mocklocks.v1': '[]',
    'nfl2026.auctionteams.v1': '{"version":1}',
    'nfl2026.scoring.v1': 'half',
    'nfl2026.ai.v1': 'on',
    'nfl2026.taken.v1': '["00-1"]',
    'nfl2026.theme.v1': 'hig',
    // Must survive: the gate unlock, and a DIFFERENT SITE's key on shared
    // storage — the reason a prefix wildcard was rejected.
    'nfl2026.unlock.v1': '1',
    'othersite.pref': 'keep-me',
  });
  assert.equal(wipeAllAppStorage(store), true);
  assert.deepEqual(store.keys().sort(), ['nfl2026.unlock.v1', 'othersite.pref'],
    'the wipe must clear all app data keys and touch nothing else');
});

/* ==========================================================================
   2 · RESTART SESSION — keep/clear contract + the stash round trip
   ========================================================================== */

test('restartSessionStorage: clears the session, keeps the KEEP list', () => {
  const store = fakeStorage({
    [LEAGUE_KEY]: JSON.stringify(OMILIA),          // applied import (Omilia-US)
    'nfl2026.scoring.v1': 'half',                  // its scoring mode
    'nfl2026.team.v1': '{"slots":{"QB1":"00-1"}}',
    'nfl2026.taken.v1': '["00-2"]',
    [MOCKS_KEY]: '[{"version":2,"kind":"snake"}]', // draft history — KEPT
    [MOCKS_KEY_V1]: '[]',                          // legacy history — KEPT
    'nfl2026.auctionteams.v1': JSON.stringify({    // budgets + names — KEPT
      version: 1, budgets: [185, 200], names: ['Hawks', ''],
    }),
    'nfl2026.ai.v1': 'on',                         // not in RESTART's clear list
  });
  const { stashed, kept } = restartSessionStorage(store);
  // R47 (owner's pick "one sync = whole session"): RESTART keeps the league
  // APPLIED — it is no longer parked as a stash; only RESET ALL clears it.
  assert.equal(stashed, false, 'nothing is stashed — the league stays applied');
  assert.equal(kept, true, 'a non-default applied profile is reported as kept');

  // CLEARED: roster and TAKEN board.
  assert.equal(store.getItem('nfl2026.team.v1'), null);
  assert.equal(store.getItem('nfl2026.taken.v1'), null);

  // KEPT: the applied league (and its scoring mode), history, budgets+names.
  assert.deepEqual(loadProfile(store), normalizeProfile(OMILIA),
    'the ACTIVE profile survives a restart');
  assert.equal(store.getItem('nfl2026.scoring.v1'), 'half',
    'the scoring toggle stays on the league\'s rec mode');
  assert.equal(store.getItem(MOCKS_KEY), '[{"version":2,"kind":"snake"}]');
  assert.equal(store.getItem(MOCKS_KEY_V1), '[]');
  const teams = loadAuctionTeams(store);
  assert.deepEqual(teams.budgets, [185, 200]);
  assert.deepEqual(teams.names, ['Hawks', '']);
  assert.equal(loadStashedProfile(store), null, 'no stash is written by a restart');
});

test('restartSessionStorage: with the default profile the toggle returns to PPR', () => {
  const store = fakeStorage({
    'nfl2026.scoring.v1': 'std',
    'nfl2026.team.v1': '{"slots":{"QB1":"00-1"}}',
  });
  const { stashed, kept } = restartSessionStorage(store);
  assert.equal(stashed, false);
  assert.equal(kept, false);
  assert.equal(store.getItem('nfl2026.scoring.v1'), 'ppr');
  assert.equal(store.getItem('nfl2026.team.v1'), null);
});

test('restartSessionStorage: a default profile stashes nothing and does not clobber an existing stash', () => {
  const store = fakeStorage();
  stashProfile(OMILIA, store);              // parked by an earlier restart
  const { stashed } = restartSessionStorage(store);   // nothing applied now
  assert.equal(stashed, false);
  assert.equal(loadStashedProfile(store).name, 'Omilia-US',
    'restarting an already-default session must not overwrite the parked league '
    + 'with the default');
});

test('the stash round-trips, and absent/corrupt reads as NO stash (never default)', () => {
  const store = fakeStorage();
  assert.equal(loadStashedProfile(store), null, 'absent = no stash, not a default');
  stashProfile(OMILIA, store);
  assert.deepEqual(loadStashedProfile(store), normalizeProfile(OMILIA));
  // Corrupt shapes read as no stash — the RE-APPLY control must not render.
  store.setItem(LEAGUE_STASH_KEY, 'not json');
  assert.equal(loadStashedProfile(store), null);
  store.setItem(LEAGUE_STASH_KEY, '{"version":1,"profile":{"name":"x"}}');
  assert.equal(loadStashedProfile(store), null,
    'a wrapper with neither scoring nor shape inside is corrupt, not a league');
  // A bare (unwrapped) profile is accepted defensively.
  store.setItem(LEAGUE_STASH_KEY, JSON.stringify(OMILIA));
  assert.equal(loadStashedProfile(store).name, 'Omilia-US');
  clearStashedProfile(store);
  assert.equal(loadStashedProfile(store), null);
});

test('storage migration: the pre-R34 single-profile shape still loads unchanged', () => {
  // Before R34, nfl2026.league.v1 held a bare profile object and WAS the
  // applied profile. The stash is a SIBLING key precisely so this keeps
  // working: a returning user's stored profile must load exactly as before,
  // with or without a stash beside it.
  const store = fakeStorage({ [LEAGUE_KEY]: JSON.stringify(OMILIA) });
  const before = loadProfile(store);
  stashProfile(DEFAULT_PROFILE, store);     // a stash appearing changes nothing
  assert.deepEqual(loadProfile(store), before);
  assert.deepEqual(before, normalizeProfile(OMILIA));
});

/* ==========================================================================
   3 · The view wiring — two buttons, two-tap, honest language
   ========================================================================== */

test('the toolbar carries BOTH buttons with the owner\'s exact language', () => {
  const src = read(TEAM);
  assert.ok(src.includes('data-act="restart-session"'), 'RESTART SESSION button');
  assert.ok(src.includes('data-act="reset-all"'), 'RESET ALL button');
  // The titles SAY what each button does — owner's spec, pinned verbatim.
  assert.ok(src.includes('Clears the board, rosters and scoring back to standard PPR.'),
    'RESTART SESSION title must state what it clears');
  assert.ok(src.includes('RE-APPLY brings it back in one tap.'),
    'RESTART SESSION title must state that the synced league survives');
  assert.ok(src.includes('Erases everything: league sync, budgets, team names, draft history'),
    'RESET ALL title must enumerate what it erases');
  assert.ok(src.includes('Cannot be undone.'), 'RESET ALL title must say it is final');
  // The old single-button copy is retired (dead-claims idiom): the title
  // described a reset that did NOT revert scoring or the league profile.
  assert.ok(!prose(TEAM).includes('Clear the roster, the TAKEN board, and any draft in progress'),
    'the pre-R34 RESET title is retired — its claim understated what reset '
    + 'needed to do (it left the imported scoring applied)');
});

test('both buttons are two-tap, and each branch does its half', () => {
  const src = prose(TEAM);
  const restart = actBranch(src, 'restart-session', 'reset-all');
  assert.match(restart, /restartArmed = true/, 'first tap arms RESTART');
  assert.match(restart, /companion\.stop\(/, 'RESTART stops the companion (R30c/R33)');
  assert.match(restart, /restartSessionStorage\(\)/, 'RESTART runs the pure storage half');
  assert.match(restart, /mountTeam\(el\)/,
    'RESTART re-mounts — the structural form of the R30c state-clear lesson: '
    + 'rosterApplied, the OURS price memo and every derived cache are rebuilt '
    + 'from cleared storage instead of hand-cleared one by one');

  const wipe = actBranch(src, 'reset-all', 'league-reapply');
  assert.match(wipe, /wipeArmed = true/, 'first tap arms RESET ALL');
  assert.match(wipe, /companion\.stop\(/, 'RESET ALL stops the companion');
  assert.match(wipe, /wipeAllAppStorage\(\)/, 'RESET ALL wipes the enumerated keys');
  assert.match(wipe, /mountTeam\(el\)/, 'RESET ALL re-mounts');

  // Arming one disarms the other; any other action disarms both.
  assert.match(src, /act !== 'restart-session' && restartArmed/,
    'any other action must disarm a pending RESTART');
  assert.match(src, /act !== 'reset-all' && wipeArmed/,
    'any other action must disarm a pending RESET ALL');
});

test('the RE-APPLY strip exists, is one tap, and hides once applied', () => {
  const src = prose(TEAM);
  assert.match(src, /data-act="league-reapply"/, 'the RE-APPLY control');
  assert.match(src, /SAVED, NOT APPLIED/, 'the strip names the stash state plainly');
  const reapply = actBranch(src, 'league-reapply', 'league-save');
  assert.match(reapply, /loadStashedProfile\(\)/, 'RE-APPLY reads the stash');
  assert.match(reapply, /saveProfile\(parked\)/, 'RE-APPLY writes it back as ACTIVE');
  assert.doesNotMatch(reapply, /fetch|Sleeper/i, 'RE-APPLY performs no re-download');
});

/* ==========================================================================
   4 · Always-HIG index.html contract
   ========================================================================== */

test('index.html: every boot stamps data-theme="hig", with no storage read', () => {
  const shell = html('index.html');
  assert.ok(
    shell.includes('<script>document.documentElement.setAttribute(\'data-theme\', \'hig\');</script>'),
    'the pre-paint inline script must set the attribute UNCONDITIONALLY — '
    + 'one statement, nothing that can fail the boot');
  assert.ok(!shell.includes('localStorage'),
    'index.html must not read (or write) storage for the theme choice');
  assert.ok(!shell.includes('theme-switch'),
    'the R31 #theme-switch button and its wiring are gone');
  // Load order: theme.css (base) BEFORE theme-hig.css (override layer).
  const base = shell.indexOf('/app/theme.css');
  const hig = shell.indexOf('/app/theme-hig.css');
  assert.ok(base > -1 && hig > base,
    'theme.css must load before theme-hig.css — HIG is an override layer, '
    + 'never a merged stylesheet');
});

test('the dead switcher styles are gone; the wk chip idiom stays', () => {
  const hig = read('app/theme-hig.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!hig.includes('#theme-switch'),
    'theme-hig.css must not style a control that no longer exists');
  assert.ok(hig.includes('[data-theme="hig"] .wk'),
    'the week chip keeps its HIG capsule restyle');
});

test('red styling hooks for RESET ALL exist in BOTH stylesheets', () => {
  const base = read('app/theme.css');
  const hig = read('app/theme-hig.css');
  assert.match(base, /\.reset-btn--all\s*\{[^}]*var\(--accent-txt\)/,
    'theme.css: RESET ALL wears the accent red at rest');
  assert.match(hig, /\[data-theme="hig"\] \.reset-btn--all\s*\{[^}]*var\(--accent-txt\)/,
    'theme-hig.css restyles chips, so it needs its own red treatment');
  // RESTART arms in the brand tone, NOT red (owner spec).
  assert.match(base, /\.reset-btn--session\.reset-btn--armed\s*\{[^}]*var\(--brand-txt\)/,
    'theme.css: armed RESTART is brand-toned, not red');
  assert.match(hig, /\[data-theme="hig"\] \.reset-btn--session\.reset-btn--armed/,
    'theme-hig.css: armed RESTART override');
});

/* ==========================================================================
   5 · The mandatory sale capture (TAKE = buyer + typed price)
   ========================================================================== */

test('validateSoldEntry: blank price refused, missing buyer refused, both set OK', () => {
  // Missing buyer — whatever the price says.
  let v = validateSoldEntry({ buyerValue: '', priceValue: '47' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /buyer/i);
  // Blank price — refused, and the refusal states the honesty rule.
  v = validateSoldEntry({ buyerValue: '2', priceValue: '' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /blank price is not \$0/i,
    'a blank must never be recorded as $0');
  assert.match(v.reason, /estimate is a hint/i,
    'a blank must never be silently replaced by the estimate');
  // Whitespace is blank; junk is refused; negatives are refused.
  assert.equal(validateSoldEntry({ buyerValue: '2', priceValue: '  ' }).ok, false);
  assert.equal(validateSoldEntry({ buyerValue: '2', priceValue: 'abc' }).ok, false);
  assert.equal(validateSoldEntry({ buyerValue: '2', priceValue: '-4' }).ok, false);
  // Both set: the TYPED value is the recorded value (rounded to whole dollars).
  v = validateSoldEntry({ buyerValue: '2', priceValue: '47' });
  assert.deepEqual(v, { ok: true, teamIdx: 2, price: 47 });
  v = validateSoldEntry({ buyerValue: '0', priceValue: '46.6' });
  assert.deepEqual(v, { ok: true, teamIdx: 0, price: 47 });
  // $0 TYPED is a legal recorded fact ($0/$1 dump rows) — only BLANK is not.
  assert.deepEqual(validateSoldEntry({ buyerValue: '1', priceValue: '0' }),
    { ok: true, teamIdx: 1, price: 0 });
});

test('the auc-sold branch routes through the validator and sells at the typed price', () => {
  const src = prose(TEAM);
  const branch = actBranch(src, 'auc-sold', 'taken');
  assert.match(branch, /validateSoldEntry\(/,
    'the handler must use the SAME validation the test above exercises');
  assert.match(branch, /sellTo\(auction, v\.teamIdx, price, auction\.block\.boardIdx\)/,
    'the sale must be recorded against the validated buyer at the typed '
    + '(legality-clamped) price');
  assert.ok(!/dataset\.price/.test(branch),
    'the old seed-fallback (data-price) must be gone from the record path — '
    + 'a blank is refused, never replaced by our estimate');
  // The rendered field starts EMPTY, estimate as placeholder only.
  const render = read(TEAM);
  assert.match(render, /value="\$\{soldTyped == null \? '' : soldTyped\}"/,
    'the price input renders empty until the manager types');
  assert.match(render, /placeholder="\$\{soldBase\}\?"/,
    'the estimate appears as placeholder text, never as a value');
  // The buyer select opens on an explicit no-buyer placeholder.
  assert.match(render, /— pick buyer —/,
    'the buyer select must not silently preselect a team');
});

/* ==========================================================================
   6 · Per-team names — precedence, persistence, migration
   ========================================================================== */

test('name precedence: typed > sleeper > default, index-keyed, duplicates fine', () => {
  const sleeperTeams = [
    { team_name: 'Gridiron Geeks', display_name: 'alice' },
    { team_name: null, display_name: 'bob' },
    { team_name: null, display_name: null },
  ];
  const ctx = { typedNames: ['', 'My Rival', ''], sleeperTeams, leagueSize: 3 };
  assert.deepEqual(auctionTeamName(0, ctx), { name: 'Gridiron Geeks', source: 'sleeper' });
  assert.deepEqual(auctionTeamName(1, ctx), { name: 'My Rival', source: 'typed' },
    'a typed name outranks the synced one');
  assert.deepEqual(auctionTeamName(2, ctx), { name: 'T3', source: 'default' },
    'no typed name, no sleeper name -> the T{n} default');
  // display_name backs up team_name (the fields importSleeperTeams carries).
  assert.deepEqual(
    auctionTeamName(1, { typedNames: null, sleeperTeams, leagueSize: 3 }),
    { name: 'bob', source: 'sleeper' });
  // Sleeper names only map when the synced league matches the room size —
  // seat i of a 12-team room does not correspond to anything in a 3-team sync.
  assert.deepEqual(
    auctionTeamName(0, { typedNames: null, sleeperTeams, leagueSize: 12 }),
    { name: 'T1', source: 'default' });
  // Duplicate typed names stay resolvable BY INDEX — nothing keys by name.
  const dup = { typedNames: ['Hawks', 'Hawks'], sleeperTeams: null, leagueSize: 2 };
  assert.equal(auctionTeamName(0, dup).name, 'Hawks');
  assert.equal(auctionTeamName(1, dup).name, 'Hawks');
  // Overlong typed names are capped, not rejected.
  const long = { typedNames: ['x'.repeat(99)], sleeperTeams: null, leagueSize: 1 };
  assert.equal(auctionTeamName(0, long).name.length, TEAM_NAME_MAX);
});

test('auction-teams record: versioned round trip + legacy/corrupt tolerance', () => {
  const store = fakeStorage();
  // Nothing stored: an empty record, never a throw.
  assert.deepEqual(loadAuctionTeams(store),
    { version: AUCTION_TEAMS_VERSION, budgets: null, names: null });
  // Round trip.
  saveAuctionTeams({ budgets: [185, 200, null], names: [' Hawks ', '', 'B'] }, store);
  const rec = loadAuctionTeams(store);
  assert.equal(rec.version, AUCTION_TEAMS_VERSION);
  assert.deepEqual(rec.budgets, [185, 200, null],
    'null budget entries survive: "not stated" is not $0 (normalizeTeamBudgets '
    + 'resolves them to the league default at use)');
  assert.deepEqual(rec.names, ['Hawks', '', 'B'], 'names are trimmed; blank = not typed');
  // MIGRATION: a bare array (an unversioned budgets-only write) still loads.
  store.setItem('nfl2026.auctionteams.v1', JSON.stringify([100, 150]));
  assert.deepEqual(loadAuctionTeams(store).budgets, [100, 150]);
  assert.equal(loadAuctionTeams(store).names, null);
  // Corrupt: degrade to the empty record, never a wipe of the session.
  store.setItem('nfl2026.auctionteams.v1', '}{');
  assert.deepEqual(loadAuctionTeams(store),
    { version: AUCTION_TEAMS_VERSION, budgets: null, names: null });
  // All-blank names normalise to none typed.
  assert.equal(normalizeAuctionTeams({ names: ['', ' ', ''] }).names, null);
});

test('names thread as DISPLAY into every auction surface, never into the engine', () => {
  const src = read(TEAM);
  // The view maps index -> name through one helper …
  for (const surface of [
    /auc-tname">\$\{esc\(seatLabel\(i, auction\.mySlot\)\)\}/,   // ROOM ledger
    /option value="\$\{i\}"[^>]*>\$\{esc\(seatLabel\(i, auction\.mySlot\)\)\}/, // buyer dropdown
    /\$\{esc\(seatLabel\(t\.team - 1, auction\.mySlot\)\)\}\(\$\{dollar\(t\.estWill\)\}\)/, // threats
    /MY BUILD/,                                                   // my build header
    /seatLabel\(action\.buyerIdx, auction\.mySlot\)/,             // companion refusal
  ]) {
    assert.match(src, surface, `name threading missing on surface ${surface}`);
  }
  // … and the engine stays name-blind: app/auction.js never mentions names.
  const engine = read('app/auction.js');
  assert.ok(!/teamNames|team_name|display_name|seatLabel/.test(engine),
    'the auction engine must stay pure and index-based — names are view-only');
});

/* ==========================================================================
   7 · R34 RCA — scores are draft-format-independent; money only FILTERS
   ========================================================================== */

test('RCA: the auction budget constraint filters rows, it never rescores one', () => {
  // A pool the fit engine can rank with zero weekly data.
  const pool = [
    { gsis_id: '00-1', name: 'A RB', position: 'RB', team: 'KC', proj_points: 300 },
    { gsis_id: '00-2', name: 'B RB', position: 'RB', team: 'BUF', proj_points: 250 },
    { gsis_id: '00-3', name: 'C RB', position: 'RB', team: 'DAL', proj_points: 200 },
    { gsis_id: '00-4', name: 'D RB', position: 'RB', team: 'SF', proj_points: 150 },
  ];
  const roster = { slots: {} };
  const weekly = new Map();
  const snake = recommend(roster, pool, weekly, 'ppr', 'RB1', {});
  // Auction: a $20 cap prices out the two expensive players.
  const priceById = new Map([['00-1', 60], ['00-2', 35], ['00-3', 12], ['00-4', 3]]);
  const auction = recommend(roster, pool, weekly, 'ppr', 'RB1',
    { budget: { cap: 20, priceById } });
  assert.ok(snake.length >= 3 && auction.length >= 1, 'both runs produce rankings');
  const snakeById = new Map(snake.map((r) => [String(r.player.gsis_id), r]));
  for (const row of auction) {
    const twin = snakeById.get(String(row.player.gsis_id));
    assert.ok(twin, 'the auction list is a SUBSET of the snake list, never a re-rank');
    assert.equal(row.score, twin.score,
      `player ${row.player.gsis_id}: fit score must be identical with and `
      + 'without the budget — money may remove a row, never rescore it');
  }
  assert.ok(!auction.some((r) => String(r.player.gsis_id) === '00-1'),
    'the unaffordable player is filtered, which is the ONLY format-linked change');
});

test('RCA: no scoring surface reads the draft format (source lock)', () => {
  /* Every draftCfg.mode consumer in the view must be a display/settings site.
   * adjById (finder SZN, slot chips, STARTERS SEASON TOTAL, board order) is
   * built from the SCORING mode before draftCfg is consulted; if a new
   * draftCfg.mode read appears inside a scoring computation, this count moves
   * and the reviewer must re-verify mode-independence (see the R34 RCA
   * comment at the adjById construction). */
  const src = prose(TEAM);
  const reads = src.match(/draftCfg\.mode/g) || [];
  assert.ok(reads.length <= 12,
    `draftCfg.mode is read ${reads.length} times — audit any new read: scores `
    + 'must stay draft-format-independent');
  // The one behavioural gate stays an auction-room-only FILTER input.
  assert.match(src, /if \(!auction \|\| draftCfg\.mode !== 'auction'\) return null;/,
    'recoBudget must stay null outside an open auction room');
});
