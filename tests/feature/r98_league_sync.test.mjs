/* tests/feature/r98_league_sync.test.mjs — R98: the league's rosters re-read
 * automatically, four times a day (owner, 2026-09-24).
 *
 * Driven on the real P.T.I. payloads (tests/fixtures/sleeper_pti) with a stubbed
 * fetch and an in-memory storage. Locked:
 *   1. the cadence: due when missing, of unknown age or older than 6 hours;
 *      fresh inside 6 hours; a failed attempt waits 30 minutes before the next;
 *   2. a due re-read writes the league record through saveLeagueRosters with a
 *      new timestamp, the viewer's roster id kept — and NEVER the viewer's own
 *      seated roster (nfl2026.team.v1 is not touched);
 *   3. it reads the COMPACT index (data/sleeper_index.json) — never Sleeper's
 *      14.7 MB dump — and resolves the same app ids TEAM's crosswalk does;
 *   4. an IR (reserve) player is rostered but kept out of the seatable app_ids;
 *   5. every failure (index missing, Sleeper down) writes nothing and says why;
 *   6. rosterChange names who is on Sleeper but not here, and the reverse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoSyncLeague, rosterAppIds } from '../../app/league-sync.js';
import {
  autoSyncDue, rosterChange, loadLeagueRosters, saveLeagueRosters, readSyncAttempt,
  AUTO_SYNC_EVERY_HOURS, AUTO_SYNC_RETRY_MINUTES, LEAGUE_ROSTERS_KEY,
} from '../../app/league-rosters.js';
import { buildSleeperPlayerIndex, crosswalkRoster } from '../../app/sleeper.js';
import { orderedRosterPlayers } from '../../app/views/team.js';

const FIX = new URL('../fixtures/sleeper_pti/', import.meta.url);
const fx = (n) => JSON.parse(readFileSync(new URL(n, FIX), 'utf8'));
const LEAGUE = '1367481303166914560';
const NOW = Date.parse('2026-09-24T12:00:00Z');
const H = 3600000;

/* The compact index exactly as the runner cuts it: seatable positions on a team. */
const POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'FB']);
const DUMP = fx('player_index_trimmed.json');
const COMPACT = Object.fromEntries(Object.entries(DUMP).filter(([, p]) => p && p.team
  && [p.position, ...(p.fantasy_positions || [])].some((x) => POS.has(x))));

const PROJ = JSON.parse(readFileSync(new URL('../../data/player_projections.json', import.meta.url), 'utf8')).players;
const SEATABLE = PROJ.map((p) => ({ gsis_id: p.gsis_id, name: p.name, team: p.team, position: p.position }));

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function stubFetch({ index = true, rosters = true, rostersBody = null } = {}) {
  const calls = [];
  // The compact index arrives through data.js (injected as loadIndex); only
  // Sleeper's API goes through fetch.
  const loadIndex = async () => {
    calls.push('/data/sleeper_index.json');
    if (!index) throw new Error('[data] /data/sleeper_index.json -> HTTP 404');
    return { players: COMPACT };
  };
  const f = async (url) => {
    calls.push(String(url));
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (/\/rosters$/.test(u)) {
      return rosters ? ok(rostersBody || fx('rosters.json')) : { ok: false, status: 503, json: async () => null, text: async () => '' };
    }
    if (/\/users$/.test(u)) return ok(fx('users.json'));
    return { ok: false, status: 404, json: async () => null, text: async () => '' };
  };
  return { f, loadIndex, calls };
}

test('R98: cadence — due when missing / unknown age / over 6 h; fresh inside 6 h', () => {
  assert.equal(AUTO_SYNC_EVERY_HOURS, 6, 'four times a day');
  assert.equal(autoSyncDue(null, null, LEAGUE, NOW), true, 'never read');
  assert.equal(autoSyncDue({ at: null }, null, LEAGUE, NOW), true, 'unknown age');
  assert.equal(autoSyncDue({ at: new Date(NOW - 5.9 * H).toISOString() }, null, LEAGUE, NOW), false);
  assert.equal(autoSyncDue({ at: new Date(NOW - 6.1 * H).toISOString() }, null, LEAGUE, NOW), true);
  assert.equal(autoSyncDue(null, null, '', NOW), false, 'no league applied, nothing to read');
});

test('R98: a failed attempt waits 30 minutes; an attempt for another league does not', () => {
  assert.equal(AUTO_SYNC_RETRY_MINUTES, 30);
  const recent = { league_id: LEAGUE, at: new Date(NOW - 10 * 60000).toISOString() };
  const old = { league_id: LEAGUE, at: new Date(NOW - 31 * 60000).toISOString() };
  assert.equal(autoSyncDue(null, recent, LEAGUE, NOW), false);
  assert.equal(autoSyncDue(null, old, LEAGUE, NOW), true);
  assert.equal(autoSyncDue(null, { ...recent, league_id: 'other' }, LEAGUE, NOW), true);
});

test('R98: a due re-read writes the league record — and never the seated roster', async () => {
  const s = store({ 'nfl2026.team.v1': '{"slots":{"QB":"espn-1"}}' });
  saveLeagueRosters({ league_id: LEAGUE, at: new Date(NOW - 7 * H).toISOString(),
    teams: [{ roster_id: 4, app_ids: ['stale-id'] }], my_roster_id: 4 }, s);
  const { f, loadIndex, calls } = stubFetch();
  const res = await autoSyncLeague({ leagueId: LEAGUE, seatable: SEATABLE, fetch: f, loadIndex, now: NOW, storage: s });
  assert.equal(res.ok, true, res.error);
  const rec = loadLeagueRosters(LEAGUE, s);
  assert.equal(rec.at, new Date(NOW).toISOString(), 'the new read is stamped');
  assert.equal(rec.teams.length, 10);
  assert.equal(rec.my_roster_id, 4, "the viewer's roster id survives the re-read");
  assert.ok(!rec.rostered_app_ids.includes('stale-id'), 'the old read is replaced, not merged');
  assert.ok(rec.rostered_app_ids.length > 100);
  assert.equal(s.m.get('nfl2026.team.v1'), '{"slots":{"QB":"espn-1"}}',
    'the roster seated here is NEVER changed behind the viewer\'s back');
  assert.ok(calls.includes('/data/sleeper_index.json'), 'the compact index is what translates ids');
  assert.ok(!calls.some((u) => /players\/nfl/.test(u)), 'Sleeper\'s 14.7 MB dump is never fetched');
});

test('R98: inside six hours nothing is fetched at all', async () => {
  const s = store();
  saveLeagueRosters({ league_id: LEAGUE, at: new Date(NOW - 2 * H).toISOString(),
    teams: [{ roster_id: 1, app_ids: ['a'] }] }, s);
  const { f, loadIndex, calls } = stubFetch();
  const res = await autoSyncLeague({ leagueId: LEAGUE, seatable: SEATABLE, fetch: f, loadIndex, now: NOW, storage: s });
  assert.equal(res.ran, false);
  assert.equal(calls.length, 0);
});

test('R98: the compact index resolves exactly what TEAM\'s crosswalk resolves from the full dump', () => {
  const full = buildSleeperPlayerIndex(DUMP).index;
  const compact = buildSleeperPlayerIndex(COMPACT).index;
  for (const r of fx('rosters.json')) {
    const t = { roster_id: r.roster_id, starters: r.starters, players: r.players, reserve: r.reserve };
    const viaTeam = orderedRosterPlayers(crosswalkRoster(t, SEATABLE, { index: full })).map((x) => x.player_id);
    const viaSync = rosterAppIds(crosswalkRoster(t, SEATABLE, { index: compact })).app_ids;
    assert.deepEqual(viaSync, viaTeam, `roster ${r.roster_id}: same ids, same order`);
  }
});

test('R98: an IR (reserve) player is rostered, but not in the seatable app_ids', async () => {
  const rosters = fx('rosters.json').map((r) => ({ ...r }));
  // A stash this app can resolve, picked by the crosswalk itself — not whatever
  // happens to be last (on this fixture that is a team defence, which a player
  // pool without K/DEF cannot resolve, and the test would prove nothing).
  const resolvable = crosswalkRoster({ players: rosters[0].players }, SEATABLE,
    { index: buildSleeperPlayerIndex(COMPACT).index }).players.resolved;
  const irId = resolvable[resolvable.length - 1].sleeper_id;
  rosters[0].players = rosters[0].players.filter((x) => x !== irId);
  rosters[0].reserve = [irId];
  const s = store();
  const { f, loadIndex } = stubFetch({ rostersBody: rosters });
  const res = await autoSyncLeague({ leagueId: LEAGUE, seatable: SEATABLE, fetch: f, loadIndex, now: NOW, storage: s });
  assert.equal(res.ok, true, res.error);
  const t0 = res.record.teams.find((t) => t.roster_id === rosters[0].roster_id);
  assert.equal((t0.reserve_app_ids || []).length, 1, 'the IR stash resolved');
  const irApp = t0.reserve_app_ids[0];
  assert.ok(!t0.app_ids.includes(irApp), 'an IR stash is not a seatable roster player');
  assert.ok(res.record.rostered_app_ids.includes(irApp), 'but nobody may pick him up');
});

test('R98: every failure writes nothing, says why, and is throttled', async () => {
  for (const [opts, why] of [[{ index: false }, /compact Sleeper player index/], [{ rosters: false }, /./]]) {
    const s = store();
    const { f, loadIndex } = stubFetch(opts);
    const res = await autoSyncLeague({ leagueId: LEAGUE, seatable: SEATABLE, fetch: f, loadIndex, now: NOW, storage: s });
    assert.equal(res.ran, true);
    assert.equal(res.ok, false);
    assert.match(res.error, why);
    assert.equal(s.m.has(LEAGUE_ROSTERS_KEY), false, 'no half-read league is ever saved');
    assert.equal(readSyncAttempt(s).league_id, LEAGUE, 'the attempt is recorded, so the next mount waits');
    const again = await autoSyncLeague({ leagueId: LEAGUE, seatable: SEATABLE, fetch: f, loadIndex, now: NOW + 60000, storage: s });
    assert.equal(again.ran, false, 'a minute later: not retried');
  }
});

test('R98: rosterChange names both directions, and nothing when they agree', () => {
  assert.deepEqual(rosterChange(['a', 'b', 'c'], ['b', 'c', 'd']), { added: ['d'], dropped: ['a'] });
  assert.deepEqual(rosterChange(['a', 'b'], ['b', 'a']), { added: [], dropped: [] });
});
