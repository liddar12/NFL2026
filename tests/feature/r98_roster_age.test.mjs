/* tests/feature/r98_roster_age.test.mjs — R98: rosterAgeHours, pure.
 * The LINEUP staleness warning is only as honest as this number. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterAgeHours, ROSTERS_STALE_HOURS } from '../../app/league-rosters.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

test('R98: age in hours from the record timestamp', () => {
  assert.equal(rosterAgeHours({ at: '2026-09-24T09:00:00Z' }, NOW), 3);
  assert.equal(rosterAgeHours({ at: '2026-09-21T12:00:00Z' }, NOW), 72);
});

test('R98: an unreadable or missing timestamp is null — never "fresh"', () => {
  for (const rec of [null, undefined, {}, { at: '' }, { at: 'yesterday' }, { at: 12 }]) {
    assert.equal(rosterAgeHours(rec, NOW), null, JSON.stringify(rec));
  }
});

test('R98: a clock behind the record reads as 0, not negative', () => {
  assert.equal(rosterAgeHours({ at: '2026-09-24T13:00:00Z' }, NOW), 0);
});

test('R98: the threshold is a day — Sleeper free agency moves daily', () => {
  assert.equal(ROSTERS_STALE_HOURS, 24);
});

import {
  saveLeagueRosters, loadLeagueRosters, setMyRosterId, LEAGUE_ROSTERS_KEY,
} from '../../app/league-rosters.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('R98: a stored record with NO timestamp reads as unknown age, not as fresh', () => {
  // The defect: normalizeLeagueRosters stamped the clock on every READ, so a
  // record of unknown age came back looking seconds old.
  const store = fakeStorage({ [LEAGUE_ROSTERS_KEY]: JSON.stringify({
    league_id: 'L1', teams: [{ roster_id: 1, app_ids: ['a'] }] }) });
  const rec = loadLeagueRosters('L1', store);
  assert.equal(rec.at, null);
  assert.equal(rosterAgeHours(rec, NOW), null);
});

test('R98: a WRITE stamps the time; marking my seat does not refresh the age', () => {
  const store = fakeStorage();
  assert.equal(saveLeagueRosters({ league_id: 'L1', teams: [{ roster_id: 1, app_ids: ['a'] }] }, store), true);
  assert.match(loadLeagueRosters('L1', store).at, /^\d{4}-\d{2}-\d{2}T/);
  const old = '2026-09-20T00:00:00.000Z';
  saveLeagueRosters({ league_id: 'L1', at: old, teams: [{ roster_id: 1, app_ids: ['a'] }] }, store);
  assert.equal(setMyRosterId('L1', 1, store), true);
  const rec = loadLeagueRosters('L1', store);
  assert.equal(rec.my_roster_id, 1);
  assert.equal(rec.at, old, 'a seat is not a re-read of the league');
});
