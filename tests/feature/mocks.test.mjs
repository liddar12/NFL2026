/* tests/feature/mocks.test.mjs — locks for app/mocks.js (R23-E3).
 *
 * The bug this release closes: `nfl2026.mocklocks.v1` was WRITTEN and re-read
 * only to append to. Nothing consumed it, while the UI called every row a
 * "learning record". These tests lock the resolution:
 *
 *   1. HISTORY IS PRESERVED. Existing v1 rows migrate into v2 and are never
 *      dropped; the v1 key is never deleted.
 *   2. CALIBRATION IS REAL AND IS CONSUMED. LIVE drafts (a transcript of a
 *      real room, tapped in pick by pick) produce an ADP-drift model, and
 *      expectedGoneBy() turns it into a pick number a caller can show.
 *   3. THE CLAIM IS BOUNDED. SIM mocks never calibrate anything: in a sim the
 *      opponents ARE this app's own sampler, so fitting them would measure the
 *      model that produced them. roomCalibration() says so in words instead of
 *      inventing a number.
 *   4. NOTHING IN app/ CLAIMS THE OLD MECHANISM (the cross-file honesty scan
 *      at the bottom) and the module is actually imported by the UI.
 *
 * Pure node:test against the pure module — no DOM, no fetch, no data/ reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import {
  MOCKS_KEY,
  MOCKS_KEY_V1,
  HISTORY_VERSION,
  HISTORY_LIMIT,
  MIN_CALIBRATION_PICKS,
  MIN_POSITION_PICKS,
  normalizeRecord,
  recordDraft,
  recordAuction,
  loadHistory,
  saveHistory,
  migrateLegacy,
  appendMock,
  clearHistory,
  historySummary,
  liveRecords,
  roomCalibration,
  expectedGoneBy,
  noiseComparison,
  positionDrift,
} from '../../app/mocks.js';

import { ADP_NOISE_BASE, ADP_NOISE_PER_ROUND } from '../../app/draft-sim.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/* ---- test doubles ---------------------------------------------------------- */

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Storage that throws on every operation (private mode / quota / locked embed). */
const hostileStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

/* ---- fixtures -------------------------------------------------------------- */

const V1_SNAKE = {
  created_utc: '2026-08-01T00:00:00.000Z',
  league_size: 12,
  my_slot: 5,
  roster_config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 },
  result: { mine: 1200, roomAvg: 1150, margin: 50, rank: 2, teams: 12 },
  my_players: [{ gsis_id: '00-1', name: 'A Back', position: 'RB' }],
};

const V1_AUCTION = {
  created_utc: '2026-08-02T00:00:00.000Z',
  kind: 'auction',
  play: 'live',
  league_size: 12,
  budget: 200,
  roster_config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 },
  result: { mine: 1300, roomAvg: 1150, margin: 150, rank: 1, teams: 12, spent: 198 },
  my_players: [{ gsis_id: '00-2', name: 'B Wide', position: 'WR' }],
};

/**
 * A LIVE room transcript with hand-computable drift.
 *   picks  1..12  RB, adp = pick + 4  -> delta -4  (round 1)
 *   picks 13..24  WR, adp = pick - 2  -> delta +2  (round 2)
 *   picks 25..27  QB, deltas +8/+10/+12          (round 3)
 * sum(delta) = -48 + 24 + 30 = 6 over 27 picks -> room mean = 0.2222 -> 0.22
 */
function liveObserved() {
  const rows = [];
  for (let pick = 1; pick <= 12; pick += 1) {
    rows.push({ pick, team: 1, name: `RB${pick}`, position: 'RB', adp: pick + 4 });
  }
  for (let pick = 13; pick <= 24; pick += 1) {
    rows.push({ pick, team: 2, name: `WR${pick}`, position: 'WR', adp: pick - 2 });
  }
  [8, 10, 12].forEach((d, i) => {
    const pick = 25 + i;
    rows.push({ pick, team: 3, name: `QB${pick}`, position: 'QB', adp: pick - d });
  });
  return rows;
}

const LIVE_RECORD = normalizeRecord({
  version: HISTORY_VERSION,
  created_utc: '2026-08-30T00:00:00.000Z',
  kind: 'snake',
  play: 'live',
  room_type: 'adp',
  league_size: 12,
  my_slot: 5,
  roster_config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 },
  result: { mine: 1200, roomAvg: 1150, margin: 50, rank: 2, teams: 12 },
  my_players: [],
  observed: liveObserved(),
});

/* ==========================================================================
 * 1. Record normalisation + the v1 -> v2 migration
 * ======================================================================== */

test('a v1 snake row migrates to v2: ADP room, UNKNOWN play, no observed log', () => {
  const r = normalizeRecord(V1_SNAKE);
  assert.equal(r.version, HISTORY_VERSION);
  assert.equal(r.kind, 'snake');
  // v1 finishDraft only wrote ADP-room mocks, so that inference is safe...
  assert.equal(r.room_type, 'adp');
  // ...but it never stored the play mode, and unknown must never read as live.
  assert.equal(r.play, null);
  assert.deepEqual(r.observed, []);
  assert.equal(r.migrated_from, MOCKS_KEY_V1);
  assert.equal(r.league_size, 12);
  assert.equal(r.my_slot, 5);
  assert.deepEqual(r.my_players, [{ gsis_id: '00-1', name: 'A Back', position: 'RB' }]);
  assert.deepEqual(r.result, V1_SNAKE.result);
});

test('a v1 auction row keeps its recorded play mode and carries no pick log', () => {
  const r = normalizeRecord(V1_AUCTION);
  assert.equal(r.kind, 'auction');
  assert.equal(r.play, 'live');
  assert.equal(r.budget, 200);
  assert.deepEqual(r.observed, []); // auctions have no pick order to observe
  assert.equal(r.migrated_from, MOCKS_KEY_V1);
});

test('normalizeRecord never throws on hostile input', () => {
  for (const bad of [null, undefined, 0, 'x', [], { play: 'nonsense', observed: 'x' },
                     { my_players: [null, 3], result: 'no' }]) {
    const r = normalizeRecord(bad);
    assert.equal(r.version, HISTORY_VERSION);
    assert.ok(Array.isArray(r.my_players));
    assert.ok(Array.isArray(r.observed));
  }
});

test('a non-live record can never carry an observed room, even if handed one', () => {
  const r = normalizeRecord({
    version: HISTORY_VERSION, kind: 'snake', play: 'sim', observed: liveObserved(),
  });
  assert.deepEqual(r.observed, []);
});

/* ==========================================================================
 * 2. Persistence
 * ======================================================================== */

test('loadHistory migrates v1 rows when no v2 key exists, and drops nothing', () => {
  const store = fakeStorage({ [MOCKS_KEY_V1]: JSON.stringify([V1_SNAKE, V1_AUCTION]) });
  const rows = loadHistory(store);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'snake');
  assert.equal(rows[1].kind, 'auction');
  assert.ok(rows.every((r) => r.migrated_from === MOCKS_KEY_V1));
});

test('an existing v2 key is authoritative; v1 is ignored once v2 exists', () => {
  const store = fakeStorage({
    [MOCKS_KEY_V1]: JSON.stringify([V1_SNAKE]),
    [MOCKS_KEY]: JSON.stringify([]),
  });
  assert.deepEqual(loadHistory(store), []);
});

test('migrateLegacy is idempotent and never deletes the v1 key', () => {
  const store = fakeStorage({ [MOCKS_KEY_V1]: JSON.stringify([V1_SNAKE, V1_AUCTION]) });
  const first = migrateLegacy(store);
  assert.deepEqual(first, { migrated: 2, wrote: true });
  assert.equal(loadHistory(store).length, 2);
  // The old rows are still there: a rollback of this build loses nothing.
  assert.ok(store.getItem(MOCKS_KEY_V1));
  const second = migrateLegacy(store);
  assert.deepEqual(second, { migrated: 0, wrote: false });
  assert.equal(loadHistory(store).length, 2);
});

test('migrateLegacy is a no-op with nothing stored', () => {
  const store = fakeStorage();
  assert.deepEqual(migrateLegacy(store), { migrated: 0, wrote: false });
  assert.deepEqual(loadHistory(store), []);
});

test('appendMock migrates first, so the append can never orphan legacy rows', () => {
  const store = fakeStorage({ [MOCKS_KEY_V1]: JSON.stringify([V1_SNAKE]) });
  const rows = appendMock(LIVE_RECORD, store);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].migrated_from, MOCKS_KEY_V1);
  assert.equal(rows[1].play, 'live');
  assert.equal(JSON.parse(store.getItem(MOCKS_KEY)).length, 2);
});

test('history is capped at HISTORY_LIMIT, oldest first out', () => {
  const store = fakeStorage();
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    appendMock(normalizeRecord({ ...V1_SNAKE, created_utc: `t${i}` }), store);
  }
  const rows = loadHistory(store);
  assert.equal(rows.length, HISTORY_LIMIT);
  assert.equal(rows[0].created_utc, 't5');
  assert.equal(rows[rows.length - 1].created_utc, `t${HISTORY_LIMIT + 4}`);
});

test('corrupt, absent, hostile and missing storage all degrade to an empty history', () => {
  assert.deepEqual(loadHistory(fakeStorage({ [MOCKS_KEY]: '{not json' })), []);
  assert.deepEqual(loadHistory(fakeStorage({ [MOCKS_KEY]: '"a string"' })), []);
  assert.deepEqual(loadHistory(fakeStorage()), []);
  assert.deepEqual(loadHistory(hostileStorage), []);
  assert.deepEqual(loadHistory(null), []);
  assert.equal(saveHistory([LIVE_RECORD], hostileStorage), false);
  assert.equal(saveHistory([LIVE_RECORD], null), false);
  assert.equal(clearHistory(hostileStorage), false);
});

test('clearHistory wipes BOTH keys, so a wipe is not silently undone next load', () => {
  const store = fakeStorage({
    [MOCKS_KEY_V1]: JSON.stringify([V1_SNAKE]),
    [MOCKS_KEY]: JSON.stringify([LIVE_RECORD]),
  });
  assert.equal(clearHistory(store), true);
  assert.deepEqual(loadHistory(store), []);
});

/* ==========================================================================
 * 3. Building records from live engine state
 * ======================================================================== */

function fakeDraft(play) {
  return {
    leagueSize: 12,
    mySlot: 5,
    roomType: 'adp',
    play,
    shape: { config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 } },
    rosters: [
      {}, {}, {}, {},
      { players: [{ gsis_id: '00-9', name: 'Mine', position: 'RB' }] },
      {}, {}, {}, {}, {}, {}, {},
    ],
    log: [
      { pick: 1, team: 1, name: 'Opp One', position: 'RB', adp: 3 },
      { pick: 2, team: 2, name: 'Opp Two', position: 'WR', adp: 1 },
      { pick: 5, team: 5, name: 'Mine', position: 'RB', adp: 9 },
      { pick: 6, team: 6, name: 'Opp Six', position: 'TE', adp: 20 },
    ],
  };
}

test('recordDraft(LIVE) stores the OPPONENTS\' observed picks and excludes mine', () => {
  const rec = recordDraft(fakeDraft('live'), { margin: 12 }, '2026-09-01T00:00:00.000Z');
  assert.equal(rec.play, 'live');
  assert.equal(rec.kind, 'snake');
  assert.equal(rec.created_utc, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(rec.observed.map((o) => o.pick), [1, 2, 6]);
  assert.ok(rec.observed.every((o) => o.team !== 5));
  assert.deepEqual(rec.my_players, [{ gsis_id: '00-9', name: 'Mine', position: 'RB' }]);
});

test('recordDraft(SIM) stores NO observed room — a sim room is our own sampler', () => {
  const rec = recordDraft(fakeDraft('sim'), { margin: 12 }, '2026-09-01T00:00:00.000Z');
  assert.equal(rec.play, 'sim');
  assert.deepEqual(rec.observed, []);
});

test('recordDraft defaults an unknown play mode to sim (never to live)', () => {
  const rec = recordDraft(fakeDraft(undefined), {}, 'x');
  assert.equal(rec.play, 'sim');
  assert.deepEqual(rec.observed, []);
});

test('recordAuction captures the sheet as history and no pick log', () => {
  const rec = recordAuction(
    { leagueSize: 12, mySlot: 5, budget: 200, play: 'live', shape: { config: {} } },
    { margin: 40, spent: 197 },
    [{ gsis_id: '00-3', name: 'C Tight', position: 'TE' }],
    '2026-09-02T00:00:00.000Z',
  );
  assert.equal(rec.kind, 'auction');
  assert.equal(rec.play, 'live');
  assert.equal(rec.budget, 200);
  assert.deepEqual(rec.observed, []);
  assert.equal(rec.result.spent, 197);
});

/* ==========================================================================
 * 4. Calibration — the honesty boundary
 * ======================================================================== */

test('no history at all -> not ready, and the reason names the sim circularity', () => {
  const cal = roomCalibration([]);
  assert.equal(cal.ready, false);
  assert.equal(cal.drift, null);
  assert.equal(cal.drafts, 0);
  assert.equal(cal.picks, 0);
  assert.match(cal.reason, /SIM mocks are not evidence/i);
  assert.match(cal.reason, /own ADP sampler/i);
});

test('SIM history NEVER calibrates, however much of it there is', () => {
  const sims = [];
  for (let i = 0; i < 40; i += 1) {
    sims.push(recordDraft(fakeDraft('sim'), {}, `t${i}`));
  }
  assert.deepEqual(liveRecords(sims), []);
  const cal = roomCalibration(sims);
  assert.equal(cal.ready, false);
  assert.equal(cal.drafts, 0);
  assert.equal(expectedGoneBy(50, 'RB', cal), null);
  assert.deepEqual(noiseComparison(cal), []);
  assert.deepEqual(positionDrift(cal), []);
});

test('migrated v1 rows can never become calibration evidence (play unknown)', () => {
  const rows = [normalizeRecord(V1_SNAKE), normalizeRecord(V1_AUCTION)];
  assert.deepEqual(liveRecords(rows), []);
  assert.equal(roomCalibration(rows).ready, false);
});

test('a LIVE room under MIN_CALIBRATION_PICKS stays not-ready and says how short', () => {
  const short = normalizeRecord({
    ...LIVE_RECORD, observed: LIVE_RECORD.observed.slice(0, MIN_CALIBRATION_PICKS - 1),
  });
  const cal = roomCalibration([short]);
  assert.equal(cal.ready, false);
  assert.equal(cal.picks, MIN_CALIBRATION_PICKS - 1);
  assert.match(cal.reason, new RegExp(`${MIN_CALIBRATION_PICKS} needed`));
  assert.equal(expectedGoneBy(50, 'RB', cal), null);
});

test('a LIVE room computes room-wide, per-round and per-position drift exactly', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  assert.equal(cal.ready, true);
  assert.equal(cal.drafts, 1);
  assert.equal(cal.picks, 27);
  assert.equal(cal.drift.mean, 0.22);             // 6 / 27
  assert.ok(Math.abs(cal.drift.sd - 4.59) < 0.02);

  assert.deepEqual(cal.byRound.map((r) => [r.round, r.n, r.meanDelta, r.sd]), [
    [1, 12, -4, 0],
    [2, 12, 2, 0],
    [3, 3, 10, 2],
  ]);

  assert.deepEqual(cal.byPosition.RB, { n: 12, meanDelta: -4, sd: 0 });
  assert.deepEqual(cal.byPosition.WR, { n: 12, meanDelta: 2, sd: 0 });
  assert.deepEqual(cal.byPosition.QB, { n: 3, meanDelta: 10, sd: 2 });
});

test('observed picks with no consensus ADP are skipped, not guessed at', () => {
  const rec = normalizeRecord({
    ...LIVE_RECORD,
    observed: [...LIVE_RECORD.observed, { pick: 28, team: 4, position: 'TE', adp: null }],
  });
  assert.equal(roomCalibration([rec]).picks, 27);
});

test('two LIVE drafts pool into one calibration', () => {
  const cal = roomCalibration([LIVE_RECORD, LIVE_RECORD]);
  assert.equal(cal.drafts, 2);
  assert.equal(cal.picks, 54);
  assert.equal(cal.drift.mean, 0.22);       // same room, same mean
  assert.equal(cal.byPosition.RB.n, 24);
});

/* ==========================================================================
 * 5. THE CONSUMPTION PATH — expectedGoneBy / noiseComparison / positionDrift
 * ======================================================================== */

test('expectedGoneBy uses the POSITION drift once that position clears the floor', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  assert.ok(cal.byPosition.RB.n >= MIN_POSITION_PICKS);
  assert.equal(expectedGoneBy(50, 'RB', cal), 46);   // 50 + (-4): this room reaches on RB
  assert.equal(expectedGoneBy(50, 'wr', cal), 52);   // case-insensitive
});

test('a thin position falls back to the room-wide drift instead of over-fitting 3 picks', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  assert.ok(cal.byPosition.QB.n < MIN_POSITION_PICKS);
  assert.equal(expectedGoneBy(50, 'QB', cal), 50.2); // room-wide +0.22, NOT +10
});

test('an unseen position falls back to the room-wide drift', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  assert.equal(cal.byPosition.TE, undefined);
  assert.equal(expectedGoneBy(50, 'TE', cal), 50.2);
});

test('expectedGoneBy is null without a calibration, and never returns pick 0', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  assert.equal(expectedGoneBy(50, 'RB', null), null);
  assert.equal(expectedGoneBy(50, 'RB', { ready: false }), null);
  assert.equal(expectedGoneBy(null, 'RB', cal), null);
  assert.equal(expectedGoneBy('nope', 'RB', cal), null);
  assert.equal(expectedGoneBy(0.5, 'RB', cal), 1);   // clamped into the draft
});

test('noiseComparison compares the observed spread against the sim prior', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  const rows = noiseComparison(cal);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.modelSd, ADP_NOISE_BASE + ADP_NOISE_PER_ROUND * (r.round - 1));
  }
  assert.deepEqual(rows.map((r) => r.observedSd), [0, 0, 2]);
  assert.equal(rows[2].ratio, 0.44);                 // 2 / 4.5 — tighter than the sim
});

test('positionDrift ranks the positions this room takes earliest, floor-filtered', () => {
  const drift = positionDrift(roomCalibration([LIVE_RECORD]));
  assert.deepEqual(drift.map((d) => d.position), ['RB', 'WR']);   // QB has only 3 picks
  assert.equal(drift[0].picksEarly, 4);              // RB goes 4 picks early here
  assert.equal(drift[1].picksEarly, -2);             // WR falls 2 picks
});

/* ==========================================================================
 * 6. History summary (the review panel)
 * ======================================================================== */

test('historySummary counts what the panel header claims', () => {
  const s = historySummary([
    normalizeRecord(V1_SNAKE),
    normalizeRecord(V1_AUCTION),
    recordDraft(fakeDraft('sim'), {}, 't'),
    LIVE_RECORD,
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.snake, 3);
  assert.equal(s.auction, 1);
  assert.equal(s.live, 2);            // v1 auction (play stored) + the live snake
  assert.equal(s.sim, 1);
  assert.equal(s.unknown_play, 1);    // the migrated v1 snake row
  assert.equal(s.legacy, 2);
  assert.equal(s.observed_picks, 27);
});

/* ==========================================================================
 * 7. POLICY: market data models the ROOM, never a projection
 * ======================================================================== */

test('app/mocks.js imports no projection/scoring module — it cannot feed one', () => {
  const src = readFileSync(join(REPO_ROOT, 'app/mocks.js'), 'utf8');
  const imports = [...src.matchAll(/^import[^;]+from\s+'([^']+)';/gm)].map((m) => m[1]);
  // Only the two documented noise constants. team-logic / league / auction
  // (the scoring and value engines) must NOT appear here.
  assert.deepEqual(imports, ['./draft-sim.js']);
  for (const banned of ['team-logic', 'league.js', 'auction.js', 'ros.js', 'data.js']) {
    assert.ok(!src.includes(`from './${banned}`), `must not import ${banned}`);
  }
});

test('every calibration output is a PICK NUMBER, never points or dollars', () => {
  const cal = roomCalibration([LIVE_RECORD]);
  // The full public surface of derived numbers, asserted to be pick-scale.
  assert.ok(expectedGoneBy(50, 'RB', cal) < 400);       // draft picks, not points
  assert.equal(typeof cal.drift.mean, 'number');
  assert.ok(!('points' in cal) && !('value' in cal) && !('dollars' in cal));
  for (const row of positionDrift(cal)) {
    assert.deepEqual(Object.keys(row).sort(), ['meanDelta', 'n', 'picksEarly', 'position']);
  }
});

/* ==========================================================================
 * 8. CROSS-FILE HONESTY SCAN — no unwired claim survives anywhere in app/
 * ======================================================================== */

function appSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('app');
  return out;
}

test('nothing outside app/mocks.js touches the legacy mocklocks key', () => {
  const offenders = appSources()
    .filter((f) => f !== 'app/mocks.js')
    .filter((f) => readFileSync(join(REPO_ROOT, f), 'utf8').includes('mocklocks'));
  assert.deepEqual(offenders, [],
    'the legacy key is owned by app/mocks.js (MOCKS_KEY_V1) — read it through '
    + 'loadHistory()/migrateLegacy(), never inline');
});

test('no file in app/ still calls a stored mock a "learning record"', () => {
  // Narrow on purpose: the MOCK-draft claim only. app/views/model.js's
  // "self-learning cron" is the real weekly refit (data/model_tuning.json,
  // scripts/promote_signals.py) and stays. app/mocks.js is exempt — it is the
  // file that names the removed phrase in order to document its removal.
  const banned = [/learning record/i, /learning lock/i, /self-learning hook/i];
  const offenders = [];
  for (const f of appSources()) {
    if (f === 'app/mocks.js') continue;
    const src = readFileSync(join(REPO_ROOT, f), 'utf8');
    for (const re of banned) {
      // R49 — app/views/model.js renders meta.learning_record: the REAL record
      // the self-learning loop writes (weeks resolved, players scored, MAE and
      // bias on resolved 2026 weeks). The phrase is exact there — and only
      // there, and only that phrase. It must read the meta key, not a mock.
      if (f === 'app/views/model.js' && re.source === 'learning record') {
        assert.ok(/meta\.learning_record/.test(src), 'model.js names the record by its meta key');
        assert.ok(!/mock/i.test(src.slice(src.indexOf('learningCard'), src.indexOf('/* ---- mount'))),
          'the LEARNING RECORD card never mentions mocks');
        continue;
      }
      if (re.test(src)) offenders.push(`${f} :: ${re}`);
    }
  }
  assert.deepEqual(offenders, [],
    'mock drafts do not refit anything. They are HISTORY, plus (LIVE rooms only) '
    + 'opponent-model calibration via app/mocks.js roomCalibration(). Say that.');
});

test('app/mocks.js is actually imported by the UI — history that is read, not stored', () => {
  const importers = appSources()
    .filter((f) => f !== 'app/mocks.js')
    .filter((f) => /from '\.\.?\/(\.\.\/)?mocks\.js'/.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
  assert.ok(importers.length > 0,
    'app/mocks.js has no consumer. A stored-but-unread artifact is the exact bug '
    + 'R23-E3 exists to remove — app/views/team.js must import and render it.');
});
