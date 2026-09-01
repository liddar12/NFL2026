/* tests/feature/r48_league_tab.test.mjs — R48-B: the LEAGUE tab and the sync
 * log (app/synclog.js, app/views/league.js).
 *
 * WHAT THIS LOCKS
 *   - scoringDiff against the REAL P.T.I. Sleeper payload (tests/fixtures/
 *     sleeper_pti/league.json): a changed key (pass_int -2 vs -1) appears, an
 *     unchanged key (rec 1) does not, a league-only key (bonus_rec_te 0.5)
 *     appears with standard === null, a baseline key the league zeroes
 *     (fgm_40_49 0 vs 4) appears, and a D/ST key (pts_allow_0 15 vs 10)
 *     appears. Absent is null, never 0.
 *   - shapeDiff on P.T.I.: "10 teams vs 12", "2 FLEX vs 1", "no K slot
 *     (standard seats one)", "5 bench vs 6".
 *   - recordSync/loadSyncLog round trip, newest first, capped at 20, corrupt
 *     storage reads as [], a throwing storage never throws.
 *   - the route, tab and lazy mount are wired and the view listens for the
 *     'nfl2026:league' event TEAM/GRADE dispatch after a sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_PROFILE, DEFAULT_SCORING, normalizeProfile, isDefaultProfile,
} from '../../app/league.js';
import { sleeperToProfile } from '../../app/sleeper.js';
import {
  SYNC_LOG_KEY, SYNC_LOG_CAP, recordSync, loadSyncLog, clearSyncLog,
  scoringDiff, shapeDiff, scoringLabel,
} from '../../app/synclog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The real P.T.I. league payload, mapped exactly as a Sleeper sync maps it. */
const PTI_PAYLOAD = JSON.parse(src('tests/fixtures/sleeper_pti/league.json'));
const PTI = (() => {
  const res = sleeperToProfile(PTI_PAYLOAD, { source: 'fixture', now: 0 });
  assert.equal(res.ok, true, 'the P.T.I. fixture must import as a profile');
  return normalizeProfile(res.profile);
})();

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

const row = (rows, key) => rows.find((r) => r.key === key);

/* ------------------------------------------------------------ scoringDiff */

test('R48: scoringDiff on P.T.I. — changed, unchanged, league-only, zeroed and D/ST keys', () => {
  const rows = scoringDiff(PTI);
  assert.ok(rows.length > 0, 'P.T.I. departs from standard PPR');

  // A key both tables carry at different values.
  const passInt = row(rows, 'pass_int');
  assert.ok(passInt, 'pass_int differs (-2 vs -1)');
  assert.equal(passInt.league, -2);
  assert.equal(passInt.standard, -1);
  assert.equal(passInt.delta, -1);
  assert.equal(passInt.label, 'Interception thrown');

  // A key both tables carry at the SAME value must not appear.
  assert.equal(PTI.scoring.rec, 1, 'P.T.I. is full PPR');
  assert.equal(row(rows, 'rec'), undefined, 'rec 1 vs 1 is not a difference');
  assert.equal(row(rows, 'sack'), undefined, 'sack 1 vs 1 is not a difference');
  assert.equal(row(rows, 'pass_yd'), undefined);

  // A key only the league carries: standard is NULL ("not scored"), never 0.
  const te = row(rows, 'bonus_rec_te');
  assert.ok(te, 'bonus_rec_te is a league-only key');
  assert.equal(te.league, 0.5);
  assert.equal(te.standard, null);
  assert.equal(te.delta, 0.5);
  assert.equal(te.label, 'TE reception bonus');

  // A baseline key the league ZEROES (Sleeper keeps explicit zeros for
  // mapped keys): 0 vs 4 is a real difference and reads as 0, not absent.
  const fg = row(rows, 'fgm_40_49');
  assert.ok(fg, 'fgm_40_49 0 vs 4 appears');
  assert.equal(fg.league, 0);
  assert.equal(fg.standard, 4);
  assert.equal(fg.delta, -4);

  // D/ST keys, labelled with their unit.
  const shutout = row(rows, 'pts_allow_0');
  assert.ok(shutout, 'pts_allow_0 15 vs 10 appears');
  assert.equal(shutout.league, 15);
  assert.equal(shutout.standard, 10);
  assert.equal(shutout.label, 'D/ST: 0 points allowed');
  const safe = row(rows, 'safe');
  assert.ok(safe && safe.league === 4 && safe.standard === 2, 'safe 4 vs 2 appears');

  // Every row is a genuine difference, carries the documented shape, and the
  // absent side is null — never a fabricated 0.
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['delta', 'key', 'label', 'league', 'standard']);
    assert.notEqual(r.league === null ? 0 : r.league, r.standard === null ? 0 : r.standard, r.key);
    if (r.standard === null) {
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SCORING, r.key), false, r.key);
    }
    if (r.league === null) {
      assert.equal(Object.prototype.hasOwnProperty.call(PTI.scoring, r.key), false, r.key);
    }
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.length > 0);
  }
});

test('R48: scoringDiff is sorted by |delta| desc, then key A-Z, and is [] for the default', () => {
  const rows = scoringDiff(PTI);
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    const da = Math.abs(a.delta);
    const db = Math.abs(b.delta);
    assert.ok(da > db || (da === db && a.key < b.key), `${a.key} before ${b.key}`);
  }
  assert.deepEqual(scoringDiff(DEFAULT_PROFILE), []);
  assert.deepEqual(scoringDiff(null), [], 'no profile = default = no difference');
});

test('R48: scoringDiff — a baseline key the league LACKS is league:null; absent-vs-0 is no difference', () => {
  // A hand-typed partial table: only four keys stated.
  const partial = normalizeProfile({
    name: 'Partial', scoring: { rec: 0.5, pass_td: 4, rush_td: 6, rec_td: 6 },
  });
  const rows = scoringDiff(partial);
  const rec = row(rows, 'rec');
  assert.ok(rec && rec.league === 0.5 && rec.standard === 1);
  const passYd = row(rows, 'pass_yd');
  assert.ok(passYd, 'pass_yd is not in the partial table');
  assert.equal(passYd.league, null, 'absent is null, not 0');
  assert.equal(passYd.standard, 0.04);
  // pts_allow_21_27 is 0 in standard PPR: absent vs 0 awards the same nothing.
  assert.equal(row(rows, 'pts_allow_21_27'), undefined);
  // A custom baseline map is honoured.
  const vsHalf = scoringDiff(partial, { rec: 0.5, pass_td: 4, rush_td: 6, rec_td: 6 });
  assert.deepEqual(vsHalf, []);
});

test('R48: scoringLabel — known keys read as prose, unknown keys fall back to the raw key', () => {
  assert.equal(scoringLabel('pass_yd'), 'Passing yard');
  assert.equal(scoringLabel('rec'), 'Reception');
  assert.equal(scoringLabel('bonus_rec_te'), 'TE reception bonus');
  assert.equal(scoringLabel('pts_allow_0'), 'D/ST: 0 points allowed');
  assert.equal(scoringLabel('sack'), 'D/ST: sack');
  assert.equal(scoringLabel('some_future_sleeper_key'), 'some_future_sleeper_key');
});

/* -------------------------------------------------------------- shapeDiff */

test('R48: shapeDiff on P.T.I. — 10 teams, 2 FLEX, no K, 5 bench', () => {
  const d = shapeDiff(PTI);
  assert.deepEqual(d.league, {
    starters: 9, bench: 5, teams: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN'],
  });
  assert.deepEqual(d.standard, {
    starters: DEFAULT_PROFILE.shape.starters,
    bench: DEFAULT_PROFILE.shape.bench,
    teams: DEFAULT_PROFILE.shape.teams,
    roster_positions: [...DEFAULT_PROFILE.shape.roster_positions],
  });
  assert.deepEqual(d.lines, [
    '10 teams vs 12',
    '2 FLEX vs 1',
    'no K slot (standard seats one)',
    '5 bench vs 6',
  ]);
  // P.T.I. seats nine (2 FLEX + DEF), same as the default: no starters line.
  assert.equal(d.lines.some((l) => /starters/.test(l)), false);
});

test('R48: shapeDiff — the default shape has no lines; a league-only slot and a starter-count change are named', () => {
  assert.deepEqual(shapeDiff(DEFAULT_PROFILE).lines, []);
  assert.deepEqual(shapeDiff(null).lines, []);
  const sf = normalizeProfile({
    shape: {
      teams: 12,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    },
  });
  const d = shapeDiff(sf);
  assert.deepEqual(d.lines, ['10 starters vs 9', '1 SUPER_FLEX slot (standard seats none)']);
});

/* --------------------------------------------------------------- the log */

test('R48: recordSync / loadSyncLog round trip through a fake storage, newest first', () => {
  const store = fakeStorage();
  assert.deepEqual(loadSyncLog(store), [], 'absent reads as []');

  const first = recordSync({
    kind: 'settings', at: '2026-09-01T12:00:00.000Z',
    league_id: '1367481303166914560', league_name: 'P.T.I.',
    changes: ['pass_int: -1 -> -2', 'bonus_rec_te: not scored -> 0.5'],
    details: { keys_changed: 2 },
  }, store);
  assert.equal(first.length, 1);
  assert.equal(store.keys().includes(SYNC_LOG_KEY), true);

  const second = recordSync({
    kind: 'roster', at: '2026-09-01T12:05:00.000Z',
    league_id: '1367481303166914560', league_name: 'P.T.I.',
    changes: ['RB1: Bijan Robinson'],
  }, store);
  assert.equal(second.length, 2);
  assert.equal(second[0].kind, 'roster', 'newest first');
  assert.equal(second[1].kind, 'settings');

  const loaded = loadSyncLog(store);
  assert.deepEqual(loaded, second, 'what was returned is what was stored');
  assert.deepEqual(loaded[1], {
    kind: 'settings', at: '2026-09-01T12:00:00.000Z',
    league_id: '1367481303166914560', league_name: 'P.T.I.',
    changes: ['pass_int: -1 -> -2', 'bonus_rec_te: not scored -> 0.5'],
    details: { keys_changed: 2 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(loaded[0], 'details'), false,
    'no details given = no details key, not an invented {}');

  // `at` defaults to now only when the caller passes none.
  const before = Date.now();
  const stamped = recordSync({ kind: 'settings', changes: [] }, store)[0];
  assert.ok(Number.isFinite(Date.parse(stamped.at)));
  assert.ok(Date.parse(stamped.at) >= before - 1000);
  assert.equal(stamped.league_id, null);
  assert.equal(stamped.league_name, null);
  assert.deepEqual(stamped.changes, []);

  clearSyncLog(store);
  assert.deepEqual(loadSyncLog(store), []);
  assert.equal(store.keys().includes(SYNC_LOG_KEY), false);
});

test('R48: the log keeps the newest 20 entries only', () => {
  assert.equal(SYNC_LOG_CAP, 20);
  const store = fakeStorage();
  for (let i = 0; i < 25; i += 1) {
    recordSync({
      kind: i % 2 ? 'roster' : 'settings',
      at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      league_name: `sync ${i}`, changes: [`change ${i}`],
    }, store);
  }
  const log = loadSyncLog(store);
  assert.equal(log.length, 20);
  assert.equal(log[0].league_name, 'sync 24', 'newest first');
  assert.equal(log[19].league_name, 'sync 5', 'the five oldest fell off');
});

test('R48: corrupt, hostile or throwing storage reads as [] and never throws', () => {
  assert.deepEqual(loadSyncLog(fakeStorage({ [SYNC_LOG_KEY]: '{not json' })), []);
  assert.deepEqual(loadSyncLog(fakeStorage({ [SYNC_LOG_KEY]: '{"a":1}' })), [], 'a non-array');
  assert.deepEqual(loadSyncLog(fakeStorage({ [SYNC_LOG_KEY]: '"text"' })), []);
  // Unreadable ENTRIES are dropped; readable ones survive.
  const mixed = fakeStorage({
    [SYNC_LOG_KEY]: JSON.stringify([
      null, 42, 'x', { kind: 'settings' }, { at: 'not a date', kind: 'roster' },
      { kind: 'roster', at: '2026-09-01T00:00:00.000Z', changes: ['ok', 7, null, '  '] },
    ]),
  });
  const kept = loadSyncLog(mixed);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].changes, ['ok'], 'non-string change lines are dropped');
  // A throwing storage.
  const bomb = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(loadSyncLog(bomb), []);
  const list = recordSync({ kind: 'settings', at: '2026-09-01T00:00:00.000Z', changes: ['x'] }, bomb);
  assert.equal(list.length, 1, 'the in-memory list is still returned when the write is blocked');
  assert.equal(clearSyncLog(bomb), false);
  // No storage at all.
  assert.deepEqual(loadSyncLog(null), []);
  assert.equal(recordSync({ kind: 'roster', at: '2026-09-01T00:00:00.000Z' }, null).length, 1);
  // A non-object entry records nothing but still returns the list.
  const store = fakeStorage();
  assert.deepEqual(recordSync('nope', store), []);
  assert.deepEqual(recordSync(null, store), []);
});

/* ------------------------------------------------------------- the wiring */

test('R48: the LEAGUE route, tab and lazy mount are wired (and stay off the boot path)', () => {
  const main = src('app/main.js');
  assert.match(main, /'#\/league': \{ mount: mountLeague, tab: 'league', name: 'League' \}/);
  assert.match(main, /import\('\.\/views\/league\.js'\)/, 'league must be a LAZY import');
  assert.doesNotMatch(main, /^import[^\n]*['"]\.\/views\/league\.js['"]/m,
    'no static edge from main.js to the league view');
  assert.doesNotMatch(main, /^import[^\n]*['"]\.\/synclog\.js['"]/m,
    'no static edge from main.js to the sync log');

  const html = src('index.html');
  assert.match(html, /href="#\/league" data-tab="league">League</);
  // Placed right after TEAM.
  assert.match(html, /data-tab="team">Team<\/a>\s*<a class="tab" href="#\/league" data-tab="league">League</);

  const budget = src('tests/perf/budget.spec.mjs');
  assert.match(budget, /'app\/views\/league\.js'/, 'league view is lazy-only in the budget');
  assert.match(budget, /'app\/synclog\.js'/, 'synclog is lazy-only in the budget');
  assert.match(budget, /'#\/league' is deliberately NOT listed/, 'the ROUTES list says why league is absent');
});

test('R48: the view repaints on the nfl2026:league event, tears its listener down per mount, and fetches nothing', () => {
  const view = src('app/views/league.js');
  assert.match(view, /'nfl2026:league'/, 'listens for the sync event TEAM/GRADE dispatch');
  assert.match(view, /TEARDOWN_KEY/, 'per-mount AbortController teardown (the team.js pattern)');
  assert.match(view, /new AbortController\(\)/);
  assert.match(view, /opts\.signal = teardown\.signal/);
  assert.doesNotMatch(view, /fetch\(|from '\.\.\/data\.js'|getPlayerProjections|getPlayerWeekly/,
    'the LEAGUE tab reads storage only — no data contract');
  assert.match(view, /import \{[^}]*loadSyncLog[^}]*\} from '\.\.\/synclog\.js'/);
  assert.match(view, /scoringDiff|shapeDiff/);
  // The copy the page commits to.
  assert.match(view, /Scoring matches standard PPR on every key\./);
  assert.match(view, /No sync recorded yet on this device\./);
  assert.match(view, /RESET ALL on TEAM clears the league and this log\./);
  assert.match(view, /SCORING · WHAT DIFFERS FROM STANDARD PPR/);
  assert.match(view, /ROSTER · WHAT DIFFERS/);
  assert.match(view, /LAST SYNC/);
  assert.match(view, /not in table/);
  assert.match(view, /not scored/);
});

test('R48: DEFAULT_SCORING is exported unchanged — it IS the default profile\'s table', () => {
  assert.deepEqual({ ...DEFAULT_SCORING }, { ...DEFAULT_PROFILE.scoring });
  assert.equal(Object.isFrozen(DEFAULT_SCORING), true);
  assert.equal(isDefaultProfile(normalizeProfile({ scoring: { ...DEFAULT_SCORING } })), true);
});
