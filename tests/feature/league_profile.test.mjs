/* tests/feature/league_profile.test.mjs — unit locks for app/league.js.
 *
 * PURE node:test against the PURE module app/league.js — no DOM, no fetch, no
 * dependencies, so it runs inside the FAST gate (`node --test tests/feature/*.mjs`).
 *
 * The load-bearing lock is the FIRST block: DEFAULT_PROFILE must reproduce the
 * frozen constants in app/team-logic.js byte-for-byte. Both modules are
 * imported and deep-compared, so if either drifts the gate goes red — an
 * unconfigured user can never silently get a different roster.
 *
 * Everything else is synthetic (no real player names, no data/ reads).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STARTER_SLOTS,
  BENCH_SLOTS,
  SLOT_ORDER,
  POSITION_CAPS,
  slotEligible,
} from '../../app/team-logic.js';

import {
  LEAGUE_KEY,
  PROFILE_VERSION,
  POSITIONS,
  BENCH_TOKEN,
  FLEX_ELIGIBILITY,
  FLEX_TOKENS,
  ROSTER_TOKENS,
  SCORING_FIELDS,
  LEAGUE_BOUNDS,
  DEFAULT_PROFILE,
  sleeperToken,
  isAppOnlySlot,
  cloneProfile,
  normalizeProfile,
  validateProfile,
  hasBlockingErrors,
  rosterSlots,
  slotToken,
  slotEligiblePositions,
  rosterPositionsInPlay,
  slotAccepts,
  firstOpenSlot,
  positionCap,
  rosterSize,
  isDefaultProfile,
  applyScoring,
  scoringBreakdown,
  scoringMode,
  loadProfile,
  saveProfile,
  clearProfile,
} from '../../app/league.js';

/* ---- Fake storage --------------------------------------------------------- */

/** A localStorage stand-in. `mode` can make getItem/setItem/removeItem throw. */
function mkStorage(initial, mode) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(k) {
      if (mode === 'throw-get') throw new Error('storage blocked');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (mode === 'throw-set') throw new Error('quota exceeded');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (mode === 'throw-remove') throw new Error('storage blocked');
      map.delete(k);
    },
    _map: map,
  };
}

/* ==========================================================================
 * 1. DEFAULT reproduces today's behaviour byte-for-byte
 * ======================================================================== */

test('DEFAULT roster slots equal team-logic STARTER_SLOTS / BENCH_SLOTS / SLOT_ORDER', () => {
  const slots = rosterSlots(DEFAULT_PROFILE);
  assert.deepEqual(slots.starters, [...STARTER_SLOTS]);
  assert.deepEqual(slots.bench, [...BENCH_SLOTS]);
  assert.deepEqual(slots.all, [...SLOT_ORDER]);
  assert.equal(slots.all.length, 13);
});

test('DEFAULT position caps equal team-logic POSITION_CAPS', () => {
  assert.deepEqual(DEFAULT_PROFILE.shape.position_caps, { ...POSITION_CAPS });
  assert.equal(positionCap('QB', DEFAULT_PROFILE), 2);
  assert.equal(positionCap('K', DEFAULT_PROFILE), 1);
  assert.equal(positionCap('RB', DEFAULT_PROFILE), null, 'RB is uncapped');
  assert.equal(positionCap('wr', DEFAULT_PROFILE), null, 'case-insensitive lookup');
});

test('DEFAULT slot eligibility matches team-logic slotEligible for every slot', () => {
  const probes = [...POSITIONS, 'ZZ', ''];
  SLOT_ORDER.forEach((slot) => {
    probes.forEach((pos) => {
      assert.equal(
        slotAccepts(pos, slot, DEFAULT_PROFILE),
        slotEligible(pos, slot),
        `${pos} -> ${slot}`,
      );
    });
  });
});

test('DEFAULT is PPR, 7 starters + 6 bench, 13 draft rounds, no keepers', () => {
  assert.equal(scoringMode(DEFAULT_PROFILE), 'ppr');
  assert.equal(DEFAULT_PROFILE.scoring.rec, 1);
  assert.equal(DEFAULT_PROFILE.shape.starters, 7);
  assert.equal(DEFAULT_PROFILE.shape.bench, 6);
  assert.equal(rosterSize(DEFAULT_PROFILE), 13);
  assert.equal(DEFAULT_PROFILE.shape.teams, 12);
  assert.equal(DEFAULT_PROFILE.shape.draft_rounds, 13);
  assert.equal(DEFAULT_PROFILE.shape.keepers_enabled, false);
  assert.equal(DEFAULT_PROFILE.shape.max_keepers, 0);
  assert.equal(DEFAULT_PROFILE.shape.playoff_week_start, 15);
  assert.equal(DEFAULT_PROFILE.version, PROFILE_VERSION);
});

test('DEFAULT_PROFILE is deep-frozen and validates clean', () => {
  assert.equal(Object.isFrozen(DEFAULT_PROFILE), true);
  assert.equal(Object.isFrozen(DEFAULT_PROFILE.shape), true);
  assert.equal(Object.isFrozen(DEFAULT_PROFILE.shape.roster_positions), true);
  assert.deepEqual(validateProfile(DEFAULT_PROFILE), []);
  assert.equal(isDefaultProfile(DEFAULT_PROFILE), true);
  assert.equal(isDefaultProfile(normalizeProfile(null)), true);
});

test('LEAGUE_KEY is the documented storage key', () => {
  assert.equal(LEAGUE_KEY, 'nfl2026.league.v1');
});

/* ==========================================================================
 * 2. Normalisation — total, never throws
 * ======================================================================== */

test('normalizeProfile falls back to DEFAULT for every junk input', () => {
  [undefined, null, 0, 1, '', 'nope', true, false, NaN, [], [1, 2], () => {}].forEach((junk) => {
    const p = normalizeProfile(junk);
    assert.equal(isDefaultProfile(p), true, `junk: ${String(junk)}`);
  });
});

test('normalizeProfile returns a fresh mutable copy, never DEFAULT itself', () => {
  const p = normalizeProfile(null);
  assert.notEqual(p, DEFAULT_PROFILE);
  assert.equal(Object.isFrozen(p), false);
  p.shape.teams = 10;
  assert.equal(DEFAULT_PROFILE.shape.teams, 12, 'DEFAULT untouched');
});

test('normalizeProfile is idempotent', () => {
  const raw = {
    name: '  Dynasty  ',
    scoring: { rec: 0.5, rush_yd: 0.1, weird_key: 3 },
    shape: {
      teams: 14,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN'],
      draft_rounds: 15,
      keepers_enabled: true,
      max_keepers: 3,
      playoff_week_start: 14,
      position_caps: { qb: 3, K: 1 },
    },
  };
  const once = normalizeProfile(raw);
  const twice = normalizeProfile(once);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once), 'key order stable too');
});

test('normalizeProfile builds a 9-starter league with K and DEF (the reported gap)', () => {
  const p = normalizeProfile({
    shape: {
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    },
  });
  assert.equal(p.shape.starters, 9);
  assert.equal(p.shape.bench, 6);
  const slots = rosterSlots(p);
  assert.deepEqual(slots.starters,
    ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'K1', 'DEF1']);
  assert.equal(slots.all.length, 15);
  assert.equal(slotAccepts('K', 'K1', p), true);
  assert.equal(slotAccepts('DEF', 'DEF1', p), true);
  assert.equal(slotAccepts('K', 'FLEX', p), false);
  assert.equal(slotAccepts('K', 'BN1', p), true, 'bench takes anything the roster starts');
  assert.deepEqual(rosterPositionsInPlay(p).sort(),
    ['DEF', 'K', 'QB', 'RB', 'TE', 'WR']);
});

test('normalizeProfile numbers repeated flex slots and keeps a lone flex bare', () => {
  const one = normalizeProfile({ shape: { roster_positions: ['QB', 'FLEX', 'BN'] } });
  assert.deepEqual(rosterSlots(one).starters, ['QB1', 'FLEX']);

  const two = normalizeProfile({ shape: { roster_positions: ['QB', 'FLEX', 'FLEX', 'BN'] } });
  assert.deepEqual(rosterSlots(two).starters, ['QB1', 'FLEX1', 'FLEX2']);

  const mixed = normalizeProfile({
    shape: { roster_positions: ['QB', 'SUPER_FLEX', 'WRRB_FLEX', 'BN'] },
  });
  assert.deepEqual(rosterSlots(mixed).starters, ['QB1', 'SUPER_FLEX', 'WRRB_FLEX']);
});

test('normalizeProfile moves bench to the end and reports derived starters/bench', () => {
  const p = normalizeProfile({
    shape: {
      roster_positions: ['BN', 'QB', 'BN', 'RB', 'BN'],
      starters: 99, // lying scalars are ignored: roster_positions wins
      bench: 0,
    },
  });
  assert.deepEqual(p.shape.roster_positions, ['QB', 'RB', 'BN', 'BN', 'BN']);
  assert.equal(p.shape.starters, 2);
  assert.equal(p.shape.bench, 3);
});

test('normalizeProfile drops unknown roster tokens, and falls back when none survive', () => {
  const partial = normalizeProfile({
    shape: { roster_positions: ['QB', 'PUNTER', 'RB', 'HC', 'BN'] },
  });
  assert.deepEqual(partial.shape.roster_positions, ['QB', 'RB', 'BN']);

  const allJunk = normalizeProfile({ shape: { roster_positions: ['PUNTER', 'HC'] } });
  assert.deepEqual(allJunk.shape.roster_positions, [...DEFAULT_PROFILE.shape.roster_positions]);

  const benchOnly = normalizeProfile({ shape: { roster_positions: ['BN', 'BN'] } });
  assert.deepEqual(benchOnly.shape.roster_positions,
    [...DEFAULT_PROFILE.shape.roster_positions], 'a roster with no starters is unusable');

  const empty = normalizeProfile({ shape: { roster_positions: [] } });
  assert.equal(empty.shape.starters, 7);

  const tooBig = normalizeProfile({
    shape: { roster_positions: new Array(200).fill('RB') },
  });
  assert.equal(tooBig.shape.starters, 7, 'absurd roster rejected, default kept');
});

test('normalizeProfile lowercases/uppercases tokens defensively', () => {
  const p = normalizeProfile({ shape: { roster_positions: ['qb', ' rb ', 'super_flex', 'bn'] } });
  assert.deepEqual(p.shape.roster_positions, ['QB', 'RB', 'SUPER_FLEX', 'BN']);
});

test('normalizeProfile clamps every scalar to LEAGUE_BOUNDS', () => {
  const hi = normalizeProfile({
    shape: {
      teams: 999, draft_rounds: 999, playoff_week_start: 99,
      keepers_enabled: true, max_keepers: 999,
    },
  });
  assert.equal(hi.shape.teams, LEAGUE_BOUNDS.teams[1]);
  assert.equal(hi.shape.draft_rounds, LEAGUE_BOUNDS.draft_rounds[1]);
  assert.equal(hi.shape.playoff_week_start, LEAGUE_BOUNDS.playoff_week_start[1]);

  const lo = normalizeProfile({
    shape: { teams: -5, draft_rounds: 0, playoff_week_start: 0 },
  });
  assert.equal(lo.shape.teams, LEAGUE_BOUNDS.teams[0]);
  assert.equal(lo.shape.draft_rounds, LEAGUE_BOUNDS.draft_rounds[0]);
  assert.equal(lo.shape.playoff_week_start, LEAGUE_BOUNDS.playoff_week_start[0]);

  const junk = normalizeProfile({
    shape: { teams: 'twelve', draft_rounds: null, playoff_week_start: {} },
  });
  assert.equal(junk.shape.teams, 12);
  assert.equal(junk.shape.playoff_week_start, 15);
  assert.equal(junk.shape.draft_rounds, 13, 'unset draft_rounds tracks roster size');
});

test('normalizeProfile derives draft_rounds from roster size when unset', () => {
  const p = normalizeProfile({
    shape: { roster_positions: ['QB', 'RB', 'WR', 'BN', 'BN'] },
  });
  assert.equal(p.shape.draft_rounds, 5);
});

test('normalizeProfile keeps keepers coherent', () => {
  const off = normalizeProfile({ shape: { keepers_enabled: false, max_keepers: 4 } });
  assert.equal(off.shape.max_keepers, 0, 'keepers off means zero keepers');

  const truthy = normalizeProfile({ shape: { keepers_enabled: 'yes', max_keepers: 4 } });
  assert.equal(truthy.shape.keepers_enabled, false, 'only literal true enables keepers');

  const on = normalizeProfile({ shape: { keepers_enabled: true, max_keepers: 3 } });
  assert.equal(on.shape.max_keepers, 3);

  const overRounds = normalizeProfile({
    shape: {
      keepers_enabled: true,
      max_keepers: 30,
      draft_rounds: 4,
      roster_positions: ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'],
    },
  });
  assert.equal(overRounds.shape.max_keepers, 4, 'a keeper costs a pick');

  const overRoster = normalizeProfile({
    shape: {
      keepers_enabled: true,
      max_keepers: 30,
      draft_rounds: 40,
      roster_positions: ['QB', 'RB', 'BN'],
    },
  });
  assert.equal(overRoster.shape.max_keepers, 3, 'a keeper occupies a roster slot');

  const negative = normalizeProfile({ shape: { keepers_enabled: true, max_keepers: -2 } });
  assert.equal(negative.shape.max_keepers, 0);
});

test('normalizeProfile sanitises position caps', () => {
  const p = normalizeProfile({
    shape: { position_caps: { qb: 3, TE: -4, K: null, def: '2', '': 5, WR: 'x' } },
  });
  assert.deepEqual(p.shape.position_caps, { QB: 3, TE: 0, DEF: 2 });
  assert.equal(positionCap('K', p), null, 'explicit null means uncapped');
  assert.equal(positionCap('WR', p), null, 'unparseable cap dropped, not guessed');

  const notAnObject = normalizeProfile({ shape: { position_caps: ['QB', 2] } });
  assert.deepEqual(notAnObject.shape.position_caps, { ...POSITION_CAPS });
});

test('normalizeProfile trims and caps the league name', () => {
  assert.equal(normalizeProfile({ name: '  The Yard  ' }).name, 'The Yard');
  assert.equal(normalizeProfile({ name: '   ' }).name, DEFAULT_PROFILE.name);
  assert.equal(normalizeProfile({ name: 42 }).name, DEFAULT_PROFILE.name);
  assert.equal(normalizeProfile({ name: 'x'.repeat(200) }).name.length,
    LEAGUE_BOUNDS.name_length);
});

test('normalizeProfile replaces the scoring table wholesale (never merges)', () => {
  const p = normalizeProfile({ scoring: { rec: 0.5, rec_yd: 0.1 } });
  assert.deepEqual(Object.keys(p.scoring), ['rec', 'rec_yd']);
  assert.equal(p.scoring.fum_lost, undefined, 'unlisted stats are worth 0, not the default');
});

test('normalizeProfile keeps finite scoring values only, and orders them', () => {
  const p = normalizeProfile({
    scoring: {
      zzz_custom: 2, rec_td: 6, rec: '0.5', pass_yd: NaN, rush_td: null, aaa_custom: 1,
    },
  });
  assert.deepEqual(Object.keys(p.scoring), ['rec', 'rec_td', 'aaa_custom', 'zzz_custom'],
    'known keys in display order, then unknown keys A-Z');
  assert.equal(p.scoring.rec, 0.5, 'numeric strings coerce');

  const unusable = normalizeProfile({ scoring: { rec: 'lots' } });
  assert.deepEqual(unusable.scoring, { ...DEFAULT_PROFILE.scoring },
    'a scoring table with nothing usable keeps the default');

  const notAnObject = normalizeProfile({ scoring: [1, 2, 3] });
  assert.deepEqual(notAnObject.scoring, { ...DEFAULT_PROFILE.scoring });
});

test('normalizeProfile never lets null / "" / booleans coerce into a value', () => {
  // Number(null) === 0, Number('') === 0, Number(true) === 1 — none of those is
  // a value the user typed, so none may survive coercion.
  const p = normalizeProfile({
    scoring: { rec: null, rec_yd: '', rec_td: true, rush_td: [], pass_td: 4 },
    shape: {
      teams: null, draft_rounds: '', playoff_week_start: true,
      position_caps: { QB: null, RB: '', WR: true, TE: 1 },
    },
  });
  assert.deepEqual(p.scoring, { pass_td: 4 });
  assert.equal(p.shape.teams, 12);
  assert.equal(p.shape.draft_rounds, 13);
  assert.equal(p.shape.playoff_week_start, 15);
  assert.deepEqual(p.shape.position_caps, { TE: 1 });
});

test('applyScoring never lets null / "" / booleans coerce into a stat', () => {
  assert.equal(applyScoring({ rec: null }, EXACT), 0);
  assert.equal(applyScoring({ rec: '' }, EXACT), 0);
  assert.equal(applyScoring({ rec: true }, EXACT), 0);
  assert.equal(applyScoring({ rec: [] }, EXACT), 0);
  assert.equal(applyScoring({ rec: '3' }, EXACT), 3, 'a numeric string is a value');
});

/* ==========================================================================
 * 3. FLEX eligibility as data
 * ======================================================================== */

test('FLEX_ELIGIBILITY carries the Sleeper tokens exactly', () => {
  assert.deepEqual([...FLEX_ELIGIBILITY.WRRB_FLEX.positions], ['WR', 'RB']);
  assert.deepEqual([...FLEX_ELIGIBILITY.REC_FLEX.positions], ['WR', 'TE']);
  assert.deepEqual([...FLEX_ELIGIBILITY.FLEX.positions], ['WR', 'RB', 'TE']);
  assert.deepEqual([...FLEX_ELIGIBILITY.SUPER_FLEX.positions], ['QB', 'WR', 'RB', 'TE']);
  assert.deepEqual([...FLEX_ELIGIBILITY.RB_TE_FLEX.positions], ['RB', 'TE']);

  assert.equal(sleeperToken('WRRB_FLEX'), 'WRRB_FLEX');
  assert.equal(sleeperToken('REC_FLEX'), 'REC_FLEX');
  assert.equal(sleeperToken('FLEX'), 'FLEX');
  assert.equal(sleeperToken('SUPER_FLEX'), 'SUPER_FLEX');
  assert.equal(sleeperToken('QB'), 'QB');
  assert.equal(sleeperToken('BN'), 'BN');
  assert.equal(sleeperToken('nope'), null);
  assert.equal(sleeperToken(null), null);
});

test('RB_TE_FLEX is app-only: no Sleeper token, and never rewritten to FLEX', () => {
  assert.equal(FLEX_ELIGIBILITY.RB_TE_FLEX.sleeper_token, null);
  assert.equal(FLEX_ELIGIBILITY.RB_TE_FLEX.app_only, true);
  assert.equal(sleeperToken('RB_TE_FLEX'), null);
  assert.equal(isAppOnlySlot('RB_TE_FLEX'), true);
  assert.equal(isAppOnlySlot('FLEX'), false);
  assert.equal(isAppOnlySlot('QB'), false);

  const p = normalizeProfile({ shape: { roster_positions: ['QB', 'RB_TE_FLEX', 'BN'] } });
  assert.deepEqual(p.shape.roster_positions, ['QB', 'RB_TE_FLEX', 'BN']);
  assert.deepEqual(rosterSlots(p).starters, ['QB1', 'RB_TE_FLEX']);
  assert.deepEqual(p.shape.flex_eligibility, { RB_TE_FLEX: ['RB', 'TE'] });
  assert.equal(slotAccepts('WR', 'RB_TE_FLEX', p), false, 'RB,TE only — not the FLEX set');
  assert.equal(slotAccepts('TE', 'RB_TE_FLEX', p), true);
});

test('flex eligibility is overridable per league and sanitised', () => {
  const p = normalizeProfile({
    shape: {
      roster_positions: ['QB', 'FLEX', 'BN'],
      flex_eligibility: { FLEX: ['te', 'PUNTER', 'QB', 'TE'] },
    },
  });
  assert.deepEqual(p.shape.flex_eligibility.FLEX, ['TE', 'QB'],
    'uppercased, junk dropped, de-duped, order preserved');
  assert.equal(slotAccepts('QB', 'FLEX', p), true);
  assert.equal(slotAccepts('RB', 'FLEX', p), false);

  const bad = normalizeProfile({
    shape: {
      roster_positions: ['QB', 'FLEX', 'BN'],
      flex_eligibility: { FLEX: ['PUNTER'] },
    },
  });
  assert.deepEqual(bad.shape.flex_eligibility.FLEX, ['WR', 'RB', 'TE'],
    'an unusable override falls back to the documented eligibility');

  const empty = normalizeProfile({
    shape: { roster_positions: ['QB', 'FLEX', 'BN'], flex_eligibility: { FLEX: [] } },
  });
  assert.deepEqual(empty.shape.flex_eligibility.FLEX, ['WR', 'RB', 'TE']);

  const notAnObject = normalizeProfile({
    shape: { roster_positions: ['QB', 'FLEX', 'BN'], flex_eligibility: 'FLEX' },
  });
  assert.deepEqual(notAnObject.shape.flex_eligibility.FLEX, ['WR', 'RB', 'TE']);
});

test('flex_eligibility only carries tokens the roster actually uses', () => {
  const p = normalizeProfile({
    shape: {
      roster_positions: ['QB', 'SUPER_FLEX', 'BN'],
      flex_eligibility: { FLEX: ['WR'], SUPER_FLEX: ['QB', 'WR'] },
    },
  });
  assert.deepEqual(Object.keys(p.shape.flex_eligibility), ['SUPER_FLEX']);
  assert.deepEqual(p.shape.flex_eligibility.SUPER_FLEX, ['QB', 'WR']);
});

test('token catalogues are consistent', () => {
  assert.deepEqual(FLEX_TOKENS,
    ['WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPER_FLEX', 'RB_TE_FLEX']);
  FLEX_TOKENS.forEach((t) => assert.ok(ROSTER_TOKENS.includes(t)));
  POSITIONS.forEach((t) => assert.ok(ROSTER_TOKENS.includes(t)));
  assert.ok(ROSTER_TOKENS.includes(BENCH_TOKEN));
});

/* ==========================================================================
 * 4. Slot helpers
 * ======================================================================== */

test('slotToken maps slot IDs back to their roster token', () => {
  const p = normalizeProfile({
    shape: { roster_positions: ['QB', 'RB', 'RB', 'FLEX', 'FLEX', 'BN', 'BN'] },
  });
  assert.equal(slotToken('QB1', p), 'QB');
  assert.equal(slotToken('RB2', p), 'RB');
  assert.equal(slotToken('FLEX1', p), 'FLEX');
  assert.equal(slotToken('BN2', p), 'BN');
  assert.equal(slotToken('BN9', p), null);
  assert.equal(slotToken('WR1', p), null, 'this league starts no WR slot');
  assert.equal(slotToken('', p), null);
  assert.equal(slotToken(null, p), null);
  assert.deepEqual(slotEligiblePositions('nope', p), []);
});

test('firstOpenSlot scans starters before bench', () => {
  const p = DEFAULT_PROFILE;
  const slots = Object.fromEntries(rosterSlots(p).all.map((s) => [s, null]));
  assert.equal(firstOpenSlot('RB', slots, p), 'RB1');
  slots.RB1 = 'a';
  assert.equal(firstOpenSlot('RB', slots, p), 'RB2');
  slots.RB2 = 'b';
  assert.equal(firstOpenSlot('RB', slots, p), 'FLEX');
  slots.FLEX = 'c';
  assert.equal(firstOpenSlot('RB', slots, p), 'BN1');
  assert.equal(firstOpenSlot('K', slots, p), null, 'no K slot, no K bench in this league');
  assert.equal(firstOpenSlot('RB', {}, p), 'RB1', 'an empty slot map is fine');
  assert.equal(firstOpenSlot('RB', null, p), 'RB1');
});

test('cloneProfile deep-copies', () => {
  const a = normalizeProfile(null);
  const b = cloneProfile(a);
  b.shape.roster_positions.push('BN');
  assert.equal(a.shape.roster_positions.length, 13);
  assert.equal(b.shape.roster_positions.length, 14);
});

/* ==========================================================================
 * 5. Validation — actionable errors, not booleans
 * ======================================================================== */

/** Codes present in the error list. */
const codes = (errors) => errors.map((e) => e.code);

test('validateProfile returns [] for a clean hand-written profile', () => {
  const errors = validateProfile({
    name: 'The Yard',
    scoring: { rec: 0.5, rec_yd: 0.1, rec_td: 6 },
    shape: {
      teams: 10,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
      starters: 9,
      bench: 2,
      flex_eligibility: { FLEX: ['WR', 'RB', 'TE'] },
      position_caps: { QB: 2, K: 1, DEF: 1 },
      draft_rounds: 11,
      keepers_enabled: true,
      max_keepers: 2,
      playoff_week_start: 15,
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(hasBlockingErrors(errors), false);
});

test('validateProfile rejects a non-object outright', () => {
  [null, undefined, 3, 'x', [], true].forEach((junk) => {
    const errors = validateProfile(junk);
    assert.equal(errors.length, 1, String(junk));
    assert.equal(errors[0].code, 'not_an_object');
    assert.equal(errors[0].severity, 'error');
    assert.ok(errors[0].message.length > 10, 'message is a sentence, not a boolean');
  });
});

test('validateProfile errors carry path, code, message, value and severity', () => {
  const errors = validateProfile({ scoring: { rec: 'one' }, shape: {} });
  const e = errors.find((x) => x.code === 'scoring_value_not_a_number');
  assert.ok(e);
  assert.equal(e.path, 'scoring.rec');
  assert.equal(e.value, 'one');
  assert.equal(e.severity, 'error');
  assert.match(e.message, /must be a number/);
});

test('validateProfile flags a hand-edited invalid profile, field by field', () => {
  const errors = validateProfile({
    name: 42,
    scoring: { rec: 'one', mystery_stat: 3 },
    shape: {
      teams: 99,
      roster_positions: ['QB', 'PUNTER', 'BN'],
      starters: 5,
      bench: 9,
      flex_eligibility: { NOPE_FLEX: ['WR'], FLEX: ['PUNTER'] },
      position_caps: { QB: -1, PUNTER: 2 },
      draft_rounds: 0,
      keepers_enabled: 'yes',
      max_keepers: 99,
      playoff_week_start: 40,
    },
  });
  const c = codes(errors);
  [
    'name_not_a_string',
    'scoring_value_not_a_number',
    'unknown_stat_key',
    'out_of_range',
    'unknown_roster_token',
    'starters_mismatch',
    'bench_mismatch',
    'unknown_flex_token',
    'unknown_flex_position',
    'unknown_cap_position',
    'cap_out_of_range',
    'keepers_enabled_not_a_boolean',
  ].forEach((code) => assert.ok(c.includes(code), `missing ${code}: got ${c.join(', ')}`));
  assert.equal(hasBlockingErrors(errors), true);

  // ...and normalize still produces something usable from the same junk.
  const p = normalizeProfile({
    name: 42,
    scoring: { rec: 'one', mystery_stat: 3 },
    shape: { roster_positions: ['QB', 'PUNTER', 'BN'] },
  });
  assert.deepEqual(p.shape.roster_positions, ['QB', 'BN']);
  assert.deepEqual(p.scoring, { mystery_stat: 3 });
});

test('validateProfile warns (does not block) on soft problems', () => {
  const errors = validateProfile({ shape: { teams: 12 } });
  const c = codes(errors);
  assert.ok(c.includes('scoring_missing'));
  assert.ok(c.includes('roster_positions_missing'));
  assert.equal(hasBlockingErrors(errors), false, 'missing sections default, they do not block');

  const unknownKey = validateProfile({ scoring: { rec: 1, mystery_stat: 2 }, shape: {} });
  const warn = unknownKey.find((e) => e.code === 'unknown_stat_key');
  assert.equal(warn.severity, 'warning');
  assert.match(warn.message, /no projection feeds it/);

  const longName = validateProfile({ name: 'x'.repeat(200), scoring: { rec: 1 }, shape: {} });
  assert.equal(longName.find((e) => e.code === 'name_too_long').severity, 'warning');

  assert.equal(hasBlockingErrors([]), false);
  assert.equal(hasBlockingErrors(null), false);
});

test('validateProfile rejects wrong-typed sections', () => {
  assert.ok(codes(validateProfile({ scoring: [1], shape: {} })).includes('scoring_not_an_object'));
  assert.ok(codes(validateProfile({ shape: [] })).includes('shape_not_an_object'));
  assert.ok(codes(validateProfile({ shape: 'big' })).includes('shape_not_an_object'));
  assert.ok(codes(validateProfile({ scoring: { rec: 1 } })).includes('shape_missing'));
  assert.ok(codes(validateProfile({ shape: { roster_positions: 'QB,RB' } }))
    .includes('roster_positions_not_an_array'));
  assert.ok(codes(validateProfile({ shape: { flex_eligibility: [] } }))
    .includes('flex_eligibility_not_an_object'));
  assert.ok(codes(validateProfile({ shape: { position_caps: [] } }))
    .includes('position_caps_not_an_object'));
  assert.ok(codes(validateProfile({ shape: { flex_eligibility: { FLEX: [] } } }))
    .includes('flex_positions_empty'));
});

test('validateProfile catches unusable rosters', () => {
  assert.ok(codes(validateProfile({ shape: { roster_positions: [] } }))
    .includes('roster_positions_empty'));
  assert.ok(codes(validateProfile({ shape: { roster_positions: ['BN', 'BN'] } }))
    .includes('no_starters'));
  assert.ok(codes(validateProfile({ shape: { roster_positions: new Array(99).fill('RB') } }))
    .includes('roster_too_large'));
});

test('validateProfile catches keeper incoherence', () => {
  const on = validateProfile({
    shape: { keepers_enabled: true, max_keepers: 0, draft_rounds: 12 },
  });
  assert.ok(codes(on).includes('keepers_enabled_without_keepers'));

  const offWithMax = validateProfile({ shape: { keepers_enabled: false, max_keepers: 3 } });
  const w = offWithMax.find((e) => e.code === 'keepers_disabled_with_max');
  assert.equal(w.severity, 'warning');

  const overRounds = validateProfile({
    shape: { keepers_enabled: true, max_keepers: 10, draft_rounds: 5 },
  });
  assert.ok(codes(overRounds).includes('keepers_exceed_draft_rounds'));

  const overRoster = validateProfile({
    shape: {
      keepers_enabled: true,
      max_keepers: 6,
      draft_rounds: 20,
      roster_positions: ['QB', 'RB', 'BN'],
    },
  });
  assert.ok(codes(overRoster).includes('keepers_exceed_roster'));
});

test('validateProfile allows a null (uncapped) position cap', () => {
  const errors = validateProfile({ shape: { position_caps: { QB: null } } });
  assert.equal(codes(errors).filter((c) => c.startsWith('cap_')).length, 0);
});

/* ==========================================================================
 * 6. Scoring applicator — EXACT arithmetic
 * ======================================================================== */

/** A tiny synthetic scoring table with exactly-representable values. */
const EXACT = normalizeProfile({
  scoring: { rec: 1, rec_yd: 0.5, rec_td: 6, fum_lost: -2 },
  shape: { roster_positions: ['WR', 'BN'] },
});
const EXACT_HALF = normalizeProfile({
  scoring: { rec: 0.5, rec_yd: 0.5, rec_td: 6, fum_lost: -2 },
  shape: { roster_positions: ['WR', 'BN'] },
});
const EXACT_STD = normalizeProfile({
  scoring: { rec: 0, rec_yd: 0.5, rec_td: 6, fum_lost: -2 },
  shape: { roster_positions: ['WR', 'BN'] },
});

test('applyScoring sums stat x points-per-unit exactly', () => {
  const stats = { rec: 10, rec_yd: 1000, rec_td: 2, fum_lost: 1 };
  // Same order as the scoring table: rec, rec_yd, rec_td, fum_lost.
  const expected = 10 * 1 + 1000 * 0.5 + 2 * 6 + 1 * -2;
  assert.equal(applyScoring(stats, EXACT), expected);
  assert.equal(applyScoring(stats, EXACT), 520);
});

test('applyScoring is per-stat arithmetic, NOT a scale factor on a PPR total', () => {
  const zeroRec = { rec: 0, rec_yd: 1000, rec_td: 2 };
  assert.equal(
    applyScoring(zeroRec, EXACT),
    applyScoring(zeroRec, EXACT_STD),
    'a player with no receptions scores identically in PPR and standard; '
    + 'a scale factor would move him',
  );

  const tenRec = { rec: 10, rec_yd: 1000, rec_td: 2 };
  assert.equal(applyScoring(tenRec, EXACT), 522);
  assert.equal(applyScoring(tenRec, EXACT_HALF), 517);
  assert.equal(applyScoring(tenRec, EXACT_STD), 512);
  assert.equal(applyScoring(tenRec, EXACT) - applyScoring(tenRec, EXACT_STD), 10,
    'the whole difference is exactly the reception points');
});

test('applyScoring ignores stats the profile does not score and vice versa', () => {
  assert.equal(applyScoring({ pass_yd: 5000 }, EXACT), 0, 'unscored stat contributes nothing');
  assert.equal(applyScoring({}, EXACT), 0, 'a missing stat is missing, not zero-scored');
  assert.equal(applyScoring({ rec: 3 }, EXACT), 3);
});

test('applyScoring never throws on junk', () => {
  [null, undefined, 5, 'x', [], true].forEach((junk) => {
    assert.equal(applyScoring(junk, EXACT), 0, String(junk));
  });
  assert.equal(applyScoring({ rec: 'x', rec_yd: 10 }, EXACT), 5, 'non-finite stat skipped');
  assert.equal(applyScoring({ rec: NaN }, EXACT), 0);
  assert.equal(applyScoring({ rec: Infinity }, EXACT), 0);
  assert.equal(applyScoring({ rec: 2 }, null), 2, 'junk profile falls back to DEFAULT (PPR)');
  assert.equal(applyScoring({ rec: 2 }, 'nope'), 2);
});

test('applyScoring honours a custom (non-Sleeper) stat key', () => {
  const p = normalizeProfile({ scoring: { rec: 1, first_down: 0.5 } });
  assert.equal(applyScoring({ rec: 4, first_down: 6 }, p), 7);
});

test('applyScoring under DEFAULT scores a full stat line', () => {
  const line = {
    pass_yd: 0, rush_yd: 100, rush_td: 1, rec: 5, rec_yd: 50, rec_td: 1, fum_lost: 1,
  };
  const expected = 100 * 0.1 + 1 * 6 + 5 * 1 + 50 * 0.1 + 1 * 6 + 1 * -2;
  assert.ok(Math.abs(applyScoring(line, DEFAULT_PROFILE) - expected) < 1e-9);
});

test('scoringBreakdown explains the total, biggest contribution first', () => {
  const stats = { rec: 10, rec_yd: 1000, rec_td: 2, fum_lost: 1 };
  const rows = scoringBreakdown(stats, EXACT);
  assert.deepEqual(rows.map((r) => r.key), ['rec_yd', 'rec_td', 'rec', 'fum_lost']);
  assert.deepEqual(rows[0], { key: 'rec_yd', stat: 1000, points_per: 0.5, points: 500 });
  assert.equal(rows.reduce((a, r) => a + r.points, 0), applyScoring(stats, EXACT));
  assert.deepEqual(scoringBreakdown(null, EXACT), []);
  assert.deepEqual(scoringBreakdown({ pass_yd: 1 }, EXACT), []);
});

test('scoringMode reads the reception value alone', () => {
  assert.equal(scoringMode(EXACT), 'ppr');
  assert.equal(scoringMode(EXACT_HALF), 'half');
  assert.equal(scoringMode(EXACT_STD), 'std');
  assert.equal(scoringMode(normalizeProfile({ scoring: { rec: 0.25 } })), 'custom');
  assert.equal(scoringMode(normalizeProfile({ scoring: { rec_yd: 0.1 } })), 'std',
    'no reception scoring is standard scoring');
  assert.equal(scoringMode(null), 'ppr', 'the default profile is PPR');
});

test('SCORING_FIELDS covers every DEFAULT scoring key', () => {
  const known = new Set(SCORING_FIELDS.map((f) => f.key));
  Object.keys(DEFAULT_PROFILE.scoring).forEach((k) => {
    assert.ok(known.has(k), `DEFAULT scores "${k}" but SCORING_FIELDS does not list it`);
  });
  SCORING_FIELDS.forEach((f) => {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length > 0);
    assert.ok(['passing', 'rushing', 'receiving', 'misc', 'kicking', 'defense'].includes(f.group));
  });
  assert.equal(new Set(SCORING_FIELDS.map((f) => f.key)).size, SCORING_FIELDS.length,
    'no duplicate stat keys');
});

/* ==========================================================================
 * 7. Persistence — corrupt / hostile / absent storage
 * ======================================================================== */

test('saveProfile then loadProfile round-trips', () => {
  const store = mkStorage();
  const p = normalizeProfile({
    name: 'The Yard',
    scoring: { rec: 0.5, rec_yd: 0.1 },
    shape: {
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
      teams: 10,
      keepers_enabled: true,
      max_keepers: 2,
    },
  });
  assert.equal(saveProfile(p, store), true);
  assert.deepEqual(loadProfile(store), p);
  assert.ok(store._map.has(LEAGUE_KEY));
});

test('saveProfile normalises before writing (junk never reaches storage)', () => {
  const store = mkStorage();
  saveProfile({ shape: { teams: 999, roster_positions: ['QB', 'PUNTER', 'BN'] } }, store);
  const written = JSON.parse(store._map.get(LEAGUE_KEY));
  assert.equal(written.shape.teams, LEAGUE_BOUNDS.teams[1]);
  assert.deepEqual(written.shape.roster_positions, ['QB', 'BN']);
  assert.equal(written.version, PROFILE_VERSION);
});

test('loadProfile falls back to DEFAULT for corrupt storage', () => {
  const cases = [
    '{"scoring":',          // truncated JSON
    'not json at all',
    'null',
    '3',
    '"a string"',
    '[]',
    '[{"shape":{}}]',
    '{}',
    '{"shape":null}',
    '{"scoring":"ppr","shape":"standard"}',
  ];
  cases.forEach((raw) => {
    const store = mkStorage({ [LEAGUE_KEY]: raw });
    assert.equal(isDefaultProfile(loadProfile(store)), true, `corrupt: ${raw}`);
  });
});

test('loadProfile survives a partially corrupt stored profile', () => {
  const store = mkStorage({
    [LEAGUE_KEY]: JSON.stringify({
      scoring: { rec: 0.5, junk: 'x' },
      shape: { teams: 'ten', roster_positions: ['QB', 'RB', 'BN'], max_keepers: 'lots' },
    }),
  });
  const p = loadProfile(store);
  assert.deepEqual(p.scoring, { rec: 0.5 });
  assert.equal(p.shape.teams, 12, 'unparseable teams keeps the default');
  assert.deepEqual(p.shape.roster_positions, ['QB', 'RB', 'BN']);
  assert.equal(p.shape.max_keepers, 0);
});

test('loadProfile survives a throwing / absent storage', () => {
  assert.equal(isDefaultProfile(loadProfile(mkStorage({}, 'throw-get'))), true);
  assert.equal(isDefaultProfile(loadProfile(null)), true);
  assert.equal(isDefaultProfile(loadProfile({})), true, 'storage without getItem');
  assert.equal(isDefaultProfile(loadProfile(mkStorage())), true, 'empty storage');
});

test('saveProfile returns false when storage is blocked, and never throws', () => {
  assert.equal(saveProfile(DEFAULT_PROFILE, mkStorage({}, 'throw-set')), false);
  assert.equal(saveProfile(DEFAULT_PROFILE, null), false);
  assert.equal(saveProfile(DEFAULT_PROFILE, {}), false);
});

test('clearProfile forgets the profile and never throws', () => {
  const store = mkStorage();
  saveProfile(normalizeProfile({ shape: { teams: 8 } }), store);
  assert.equal(loadProfile(store).shape.teams, 8);
  assert.equal(clearProfile(store), true);
  assert.equal(isDefaultProfile(loadProfile(store)), true);
  assert.equal(clearProfile(mkStorage({}, 'throw-remove')), false);
  assert.equal(clearProfile(null), false);
});

test('loadProfile with no argument uses ambient storage and does not throw under node', () => {
  // node has no globalThis.localStorage in the versions this gate runs on; if a
  // future runtime adds one, the call must still return a usable profile.
  const p = loadProfile();
  assert.equal(p.version, PROFILE_VERSION);
  assert.equal(Array.isArray(p.shape.roster_positions), true);
  assert.equal(typeof saveProfile(DEFAULT_PROFILE), 'boolean');
  assert.equal(typeof clearProfile(), 'boolean');
});
