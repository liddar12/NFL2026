/* tests/feature/r49_waivers.test.mjs — R49 LINEUP WAIVERS (owner's pick:
 * BEST FIT and BEST AVAILABLE "pulling from available players on sleeper
 * based on that week and the remaining weeks").
 *
 * Locks: the pure engine (app/waivers.js), the two storage records
 * (app/league-rosters.js), the Sleeper state fetcher, RESET ALL's key list,
 * and the source pins that TEAM's sync writes the records and LINEUP reads
 * the week from them. Absent is never 0; nothing here is a market.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { freeAgents, bestAvailable, bestFit, rosterIdsOf } from '../../app/waivers.js';
import { bestLineup } from '../../app/lineup.js';
import { normalizeProfile } from '../../app/league.js';
import {
  LEAGUE_ROSTERS_KEY, NFL_WEEK_KEY, normalizeLeagueRosters, saveLeagueRosters,
  loadLeagueRosters, setMyRosterId, freeAgentIds, saveNflWeek, loadNflWeek, defaultLineupWeek,
} from '../../app/league-rosters.js';
import { RESET_ALL_KEYS } from '../../app/views/team.js';
import { fetchSleeperState, stateEndpoint } from '../../app/sleeper.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEAM_SRC = readFileSync(join(ROOT, 'app/views/team.js'), 'utf8');
const LINEUP_SRC = readFileSync(join(ROOT, 'app/views/lineup.js'), 'utf8');
const BUDGET_SRC = readFileSync(join(ROOT, 'tests/perf/budget.spec.mjs'), 'utf8');
const STATE_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/sleeper_proj/state.json'), 'utf8'));

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** The pre-R47 seven-starter league: QB RB RB WR WR TE FLEX + bench. */
const SEVEN = normalizeProfile({
  shape: { roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN'] },
});

/* ---- freeAgents ---------------------------------------------------------- */

test('R49: freeAgents excludes every rostered id and keeps the rest (id or gsis_id)', () => {
  const pool = [{ id: 'a' }, { gsis_id: 'b' }, { id: 'c' }, { id: '' }, { name: 'no id' }];
  const out = freeAgents(pool, ['b', 'zzz']);
  assert.deepEqual(out.map((r) => r.id || r.gsis_id), ['a', 'c']);
  assert.deepEqual(freeAgents(pool, null).map((r) => r.id || r.gsis_id), ['a', 'b', 'c']);
  assert.deepEqual(freeAgents(null, ['a']), []);
  assert.deepEqual(rosterIdsOf({ QB1: 'q', RB1: null, BN1: 'q', BN2: 'r' }), ['q', 'r']);
});

/* ---- bestAvailable ------------------------------------------------------- */

test('R49: bestAvailable ranks THIS WEEK and REST OF SEASON separately, byes at 0, absent as null', () => {
  // Weekly points per id: a bye is a hard 0 that week, not a missing number.
  const table = {
    rbA: { 5: 0, ros: 120 },   // on bye in week 5 — worthless THIS week, best ROS
    rbB: { 5: 12, ros: 60 },
    rbC: { 5: 9, ros: 80 },
    wrX: { 5: 7, ros: 50 },
    dstD: { 5: 6, ros: 40 },
    rbN: { 5: null, ros: null }, // no weekly feed at all: NEVER printed as 0
  };
  const fas = [
    { id: 'rbA', name: 'A', team: 'AAA', position: 'RB', bye: 5 },
    { id: 'rbB', name: 'B', team: 'BBB', position: 'rb' },
    { id: 'rbC', name: 'C', team: 'CCC', position: 'RB' },
    { id: 'wrX', name: 'X', team: 'XXX', position: 'WR' },
    { id: 'dstD', name: 'D', team: 'DDD', position: 'DST' },
    { id: 'rbN', name: 'N', team: 'NNN', position: 'RB' },
  ];
  const out = bestAvailable({
    freeAgents: fas,
    week: 5,
    weekPointsOf: (r, wk) => table[r.id][wk],
    rosPointsOf: (r) => table[r.id].ros,
    positions: ['RB', 'WR', 'DEF', 'DST'],
    limit: 2,
  });
  assert.deepEqual(out.positions, ['RB', 'WR', 'DEF'], 'DST folds into DEF, once');
  assert.deepEqual(out.week.RB.map((r) => r.id), ['rbB', 'rbC'], 'this week: the bye RB is worth 0');
  assert.deepEqual(out.ros.RB.map((r) => r.id), ['rbA', 'rbC'], 'rest of season: the bye RB leads');
  assert.equal(out.week.RB[0].week_pts, 12);
  assert.equal(out.week.RB[0].ros_pts, 60);
  assert.equal(out.ros.RB[0].bye, 5);
  assert.deepEqual(out.week.DEF.map((r) => r.id), ['dstD']);
  assert.deepEqual(out.week.WR.map((r) => r.id), ['wrX']);
  // The unpriced RB ranks after every priced one and carries null, not 0.
  const all = bestAvailable({
    freeAgents: fas, week: 5, positions: ['RB'], limit: 10,
    weekPointsOf: (r, wk) => table[r.id][wk], rosPointsOf: (r) => table[r.id].ros,
  });
  assert.equal(all.week.RB[all.week.RB.length - 1].id, 'rbN');
  assert.equal(all.week.RB[all.week.RB.length - 1].week_pts, null);
  assert.equal(all.ros.RB[all.ros.RB.length - 1].ros_pts, null);
  // Ties break on id ascending, deterministically.
  const tie = bestAvailable({
    freeAgents: [{ id: 'z', position: 'RB' }, { id: 'a', position: 'RB' }], week: 1,
    positions: ['RB'], weekPointsOf: () => 5, rosPointsOf: () => 5,
  });
  assert.deepEqual(tie.week.RB.map((r) => r.id), ['a', 'z']);
});

/* ---- bestFit ------------------------------------------------------------- */

const ROSTER = {
  qb1: { pos: 'QB', pts: 20 }, rb1: { pos: 'RB', pts: 18 }, rb2: { pos: 'RB', pts: 14 },
  wr1: { pos: 'WR', pts: 16 }, wr2: { pos: 'WR', pts: 10 }, te1: { pos: 'TE', pts: 8 },
  rb3: { pos: 'RB', pts: 6 },                 // FLEX this week
  wrBn: { pos: 'WR', pts: 1 },                // bench: never starts
};
const CANDS = {
  rbX: { pos: 'RB', pts: 15 },                // raises FLEX 6 -> 14 and RB2 14 -> 15
  wrLow: { pos: 'WR', pts: 3 },               // beats nobody
  teY: { pos: 'TE', pts: 9 },                 // 8 -> 9
  rbZ: { pos: 'RB', pts: 15 },                // an exact tie with rbX
};
const ALL = { ...ROSTER, ...CANDS };
const rowsFor = (ids, wk) => ids.map((id) => ({ id, pos: ALL[id].pos, pts: ALL[id].pts * (wk === 2 ? 0.5 : 1) }));

test('R49: bestFit gain is bestLineup(with) minus bestLineup(without), sorted, rounded, tie on id', () => {
  const mine = Object.keys(ROSTER);
  const fit = bestFit({
    roster: mine, freeAgents: Object.keys(CANDS).map((id) => ({ id })), week: 1, profile: SEVEN,
    feeds: [], rowsFor, lastWeek: 2,
  });
  const base = bestLineup(rowsFor(mine, 1), SEVEN).total;
  assert.equal(fit.base.week, base);
  for (const f of fit.week) {
    const withC = bestLineup(rowsFor([...mine, f.candidate], 1), SEVEN).total;
    assert.equal(f.gain, Math.round((withC - base) * 10) / 10, `${f.candidate} gain is the lineup delta`);
    assert.ok(f.gain > 0, 'only players who RAISE the lineup are listed');
  }
  assert.deepEqual(fit.week.map((f) => f.candidate), ['rbX', 'rbZ', 'teY'], 'gain desc, tie -> id asc');
  assert.equal(fit.week[0].gain, 9, '18+15+14 vs 18+14+6');
  assert.ok(!fit.week.some((f) => f.candidate === 'wrLow'), 'a player who beats nobody is not a fit');
  assert.equal(fit.note.week, null);
  // ROS = the sum of the weekly gains over weeks 1..2 (week 2 is half points).
  const rosGain = (id) => [1, 2].reduce((s, wk) => s
    + bestLineup(rowsFor([...mine, id], wk), SEVEN).total - bestLineup(rowsFor(mine, wk), SEVEN).total, 0);
  for (const f of fit.ros) assert.equal(f.gain, Math.round(rosGain(f.candidate) * 10) / 10);
  assert.equal(fit.ros[0].gain, 13.5);
});

test('R49: the drop is never an optimal-lineup starter while a bench player exists, and its cost is named', () => {
  const mine = Object.keys(ROSTER);
  const fit = bestFit({
    roster: mine, freeAgents: [{ id: 'rbX' }], week: 1, profile: SEVEN, feeds: [], rowsFor, lastWeek: 2,
  });
  const optimal = bestLineup(rowsFor(mine, 1), SEVEN);
  const starters = new Set(optimal.slotIds.map((s) => optimal.slots[s]).filter(Boolean));
  for (const h of ['week', 'ros']) {
    assert.equal(fit[h][0].drop, 'wrBn', `${h}: the bench WR goes`);
    assert.ok(!starters.has(fit[h][0].drop));
    assert.equal(fit[h][0].drop_cost, 0);
  }
  // With NO bench, the least-cost STARTER is proposed and the cost is real:
  // the TE (8) leaves an empty TE slot; every other removal costs more.
  const seven = mine.filter((id) => id !== 'wrBn' && id !== 'rb3');
  const tight = bestFit({
    roster: seven, freeAgents: [{ id: 'rbX' }], week: 1, profile: SEVEN, feeds: [], rowsFor, lastWeek: 1,
  });
  assert.equal(tight.week[0].drop, 'te1');
  assert.equal(tight.week[0].drop_cost, 8);
});

test('R49: when nothing raises the lineup the note says so honestly, and no market input exists', () => {
  const mine = Object.keys(ROSTER);
  const fit = bestFit({
    roster: mine, freeAgents: [{ id: 'wrLow' }], week: 1, profile: SEVEN, feeds: [], rowsFor, lastWeek: 2,
  });
  assert.deepEqual(fit.week, []);
  assert.equal(fit.note.week, 'Your best lineup already beats every free agent this week');
  assert.equal(fit.note.ros, 'Your best lineup already beats every free agent over the rest of the season');
  const src = readFileSync(join(ROOT, 'app/waivers.js'), 'utf8');
  for (const word of ['price', 'adp', 'ownership', 'market']) {
    assert.ok(!new RegExp(`\\b${word}\\s*[:=(]`).test(src), `no ${word} input in app/waivers.js`);
  }
  assert.ok(!/import .*market/.test(src));
});

/* ---- league-rosters memory ---------------------------------------------- */

test('R49: the league-rosters record round-trips, reads null when absent, corrupt or another league', () => {
  const store = fakeStorage();
  assert.equal(LEAGUE_ROSTERS_KEY, 'nfl2026.leaguerosters.v1');
  assert.equal(loadLeagueRosters('1367481303166914560', store), null, 'absent is null');
  assert.equal(freeAgentIds(['a', 'b'], '1367481303166914560', store), null, 'no rosters -> no free-agent claim');
  const ok = saveLeagueRosters({
    league_id: '1367481303166914560',
    teams: [
      { roster_id: 1, label: 'Alpha', app_ids: ['a', 'b', 'b'] },
      { roster_id: '4', label: 'Mine', app_ids: ['c', 'espn-1'] },
      'garbage',
    ],
    rostered_app_ids: ['stale', 'union'],   // recomputed, never trusted
  }, store);
  assert.equal(ok, true);
  const rec = loadLeagueRosters('1367481303166914560', store);
  assert.equal(rec.version, 1);
  assert.equal(rec.league_id, '1367481303166914560');
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rec.teams.map((t) => t.roster_id), [1, 4]);
  assert.deepEqual(rec.teams[0].app_ids, ['a', 'b'], 'ids de-duplicated');
  assert.deepEqual(rec.rostered_app_ids, ['a', 'b', 'c', 'espn-1']);
  assert.equal(rec.my_roster_id, null, 'unknown until a seat — never 0');
  assert.deepEqual(freeAgentIds(['a', 'x', 'espn-1', 'y'], '1367481303166914560', store), ['x', 'y']);
  // A different league reads as null (and a null id reads whatever is stored).
  assert.equal(loadLeagueRosters('999', store), null);
  assert.equal(loadLeagueRosters(null, store).league_id, '1367481303166914560');
  assert.equal(freeAgentIds(['x'], '999', store), null);
  // my_roster_id is set after a seat, for THIS league only.
  assert.equal(setMyRosterId('999', 2, store), false);
  assert.equal(setMyRosterId('1367481303166914560', 4, store), true);
  assert.equal(loadLeagueRosters('1367481303166914560', store).my_roster_id, 4);
  // Corrupt / hostile reads are null, never a throw.
  assert.equal(loadLeagueRosters('1', fakeStorage({ [LEAGUE_ROSTERS_KEY]: '{not json' })), null);
  assert.equal(loadLeagueRosters('1', fakeStorage({ [LEAGUE_ROSTERS_KEY]: '[1,2]' })), null);
  assert.equal(loadLeagueRosters('1', fakeStorage({ [LEAGUE_ROSTERS_KEY]: '{"league_id":"1"}' })), null);
  assert.equal(normalizeLeagueRosters({ teams: [] }), null, 'no league id -> no record');
  assert.equal(saveLeagueRosters({ league_id: '1' }, store), false, 'no teams -> refused');
  assert.equal(loadLeagueRosters('1', { getItem() { throw new Error('blocked'); } }), null);
});

test('R49: the NFL-week record round-trips and only a regular-season week 1..18 becomes the default', () => {
  const store = fakeStorage();
  assert.equal(NFL_WEEK_KEY, 'nfl2026.nflweek.v1');
  assert.equal(loadNflWeek(store), null);
  assert.equal(saveNflWeek(STATE_FIXTURE, store), true);
  const rec = loadNflWeek(store);
  assert.equal(rec.week, 1);
  assert.equal(rec.season_type, 'regular');
  assert.equal(rec.season, '2026');
  assert.match(rec.at, /^\d{4}-/);
  assert.equal(defaultLineupWeek(rec), 1);
  assert.equal(defaultLineupWeek({ week: 7, season_type: 'regular' }), 7);
  assert.equal(defaultLineupWeek({ week: 18, season_type: 'regular' }), 18);
  assert.equal(defaultLineupWeek({ week: 19, season_type: 'regular' }), null, 'past the selector');
  assert.equal(defaultLineupWeek({ week: 0, season_type: 'regular' }), null);
  assert.equal(defaultLineupWeek({ week: 3, season_type: 'pre' }), null, 'preseason keeps the old default');
  assert.equal(defaultLineupWeek({ week: 1, season_type: 'post' }), null);
  assert.equal(defaultLineupWeek(null), null);
  assert.equal(saveNflWeek({ season_type: 'regular' }, store), false, 'no week -> nothing written');
  assert.equal(loadNflWeek(fakeStorage({ [NFL_WEEK_KEY]: '{"week":"x"}' })), null);
  assert.equal(loadNflWeek(fakeStorage({ [NFL_WEEK_KEY]: 'nope' })), null);
});

test('R49: RESET ALL wipes both new keys', () => {
  assert.ok(RESET_ALL_KEYS.includes(LEAGUE_ROSTERS_KEY));
  assert.ok(RESET_ALL_KEYS.includes(NFL_WEEK_KEY));
});

/* ---- Sleeper state fetcher ---------------------------------------------- */

test('R49: fetchSleeperState reads /v1/state/nfl with the shared result shape and never throws', async () => {
  assert.equal(stateEndpoint(), 'https://api.sleeper.app/v1/state/nfl');
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { status: 200, text: async () => JSON.stringify(STATE_FIXTURE) };
  };
  const res = await fetchSleeperState({ fetch });
  assert.equal(res.ok, true);
  assert.equal(res.payload.week, 1);
  assert.equal(res.payload.season_type, 'regular');
  assert.deepEqual(calls, ['https://api.sleeper.app/v1/state/nfl']);
  const down = await fetchSleeperState({ fetch: async () => ({ status: 503, text: async () => '' }) });
  assert.equal(down.ok, false);
  assert.equal(down.payload, null);
  assert.equal(down.error.code, 'http_error');
  const thrown = await fetchSleeperState({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(thrown.ok, false);
});

/* ---- source pins --------------------------------------------------------- */

test('R49: runRosterSync saves every roster and the NFL week; a seat marks my_roster_id', () => {
  const sync = TEAM_SRC.slice(
    TEAM_SRC.indexOf('async function runRosterSync()'),
    TEAM_SRC.indexOf('function scrollToSyncBar()'),
  );
  assert.ok(sync.includes('rosterTeams = teamsRes.teams;'));
  assert.match(sync, /saveLeagueRosters\(\{/, 'every roster is saved once');
  assert.match(sync, /rosterTeams\.map\(\(t\) => \(\{/, '...for EVERY team');
  assert.match(sync, /crosswalkRoster\(t, seatable, \{ index: sleeperIndex \}\)/, 'same pool, same index as mine');
  assert.match(sync, /await fetchSleeperState\(/, 'the week is read during the sync');
  assert.match(sync, /if \(stateRes\.ok\) saveNflWeek\(stateRes\.payload\);/, 'failure is silent');
  assert.ok(sync.indexOf('saveLeagueRosters({') < sync.indexOf('if (applyRosterPlan({ auto: true })) return;'),
    'saved BEFORE the auto-seat can return');
  assert.equal((TEAM_SRC.match(/setMyRosterId\(/g) || []).length, 2, 'both seat points: applyRosterPlan + the picker');
  assert.match(TEAM_SRC, /saveMyRoster\(leagueId, team\.roster_id\);\n\s+if \(team && leagueId\) setMyRosterId\(leagueId, team\.roster_id\)/);
});

test('R49: LINEUP defaults the WK selector from storage and labels it; the no-sync copy is exact', () => {
  assert.match(LINEUP_SRC, /const sleeperWk = defaultLineupWeek\(loadNflWeek\(\), WEEKS\);/);
  assert.match(LINEUP_SRC, /if \(wkFromSleeper\) currentWk = sleeperWk;/);
  assert.match(LINEUP_SRC, /current week per Sleeper/);
  assert.ok(LINEUP_SRC.includes('Sync your Sleeper league on <a href="#/team">TEAM</a> to see who is unrostered'));
  assert.match(LINEUP_SRC, /WAIVER WIRE · \$\{esc\(leagueName\)\} · WK \$\{wk\} · /);
  assert.match(LINEUP_SRC, /<span class="est">ESTIMATE<\/span>/);
  // The card is after START/SIT and before BENCH.
  const a = LINEUP_SRC.indexOf("'<div class=\"m-head\">START / SIT MOVES</div>'");
  const b = LINEUP_SRC.lastIndexOf('+ renderWaivers(wk)');
  const c = LINEUP_SRC.indexOf("'<div class=\"m-head\">BENCH</div>'");
  assert.ok(a > 0 && a < b && b < c);
  // No new contract fetch: the only data loads are the ones this view always made.
  const mount = LINEUP_SRC.slice(LINEUP_SRC.indexOf('export default async function mountLineup'));
  assert.equal((mount.match(/Promise\.allSettled\(/g) || []).length, 1);
  assert.ok(!/getSleeperProjections|fetch\(/.test(mount), 'the waiver wire fetches nothing');
  // Both new modules are lazy-only in the perf budget.
  assert.match(BUDGET_SRC, /'app\/waivers\.js', \/\/.*R49/);
  assert.match(BUDGET_SRC, /'app\/league-rosters\.js', \/\/.*R49/);
  assert.match(BUDGET_SRC, /\{ hash: '#\/lineup', name: 'lineup', contracts: 6 \}/, 'lineup cold contracts unchanged');
});
