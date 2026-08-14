/* tests/feature/sleeper_import.test.mjs — unit locks for app/sleeper.js.
 *
 * NEVER TOUCHES THE NETWORK. Every fetch in here is injected. The league
 * payload is a COMMITTED fixture (tests/fixtures/sleeper_league.json) shaped
 * like a real Sleeper response — 145 scoring keys, 52 settings, a SUPER_FLEX,
 * a K, a DEF, an IDP DL slot and an IR slot — so the mapping is locked against
 * something with the messiness of the real thing rather than a toy.
 *
 * The load-bearing locks are the HONESTY ones: the four scoring buckets must
 * partition the input exactly (no key may vanish), an unsupported roster slot
 * must be reported rather than folded into the bench, and unresolvedItems()
 * must surface every single thing that did not make it into the profile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROFILE,
  POSITIONS,
  ROSTER_TOKENS,
  SCORING_FIELDS,
  hasBlockingErrors,
  normalizeProfile,
  rosterSlots,
  validateProfile,
} from '../../app/league.js';

import {
  IGNORED_SETTING_KEYS,
  IMPORT_TIERS,
  SCORING_ALIASES,
  SLEEPER_API_BASE,
  SLEEPER_LEAGUE_TYPES,
  SLEEPER_SLOT_MAP,
  SLEEPER_TIMEOUT_MS,
  SYNC_MODE,
  UNSUPPORTED_SLOT_TOKENS,
  fetchSleeperLeague,
  importFromPastedJson,
  importFromSleeper,
  importPprDefault,
  leagueEndpoint,
  mapRosterPositions,
  mapScoring,
  mapSettings,
  parseLeagueId,
  sleeperToProfile,
  summarizeImport,
  unresolvedItems,
} from '../../app/sleeper.js';

/* ---- Fixture ------------------------------------------------------------- */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/sleeper_league.json', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../../app/sleeper.js', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const SOURCE_TEXT = readFileSync(SOURCE_PATH, 'utf8');

/** Fresh deep copy — no test may contaminate another. */
function fixture() {
  return JSON.parse(FIXTURE_TEXT);
}

const APP_SCORING_KEYS = SCORING_FIELDS.map((f) => f.key);

/* Injected clock so synced_at is deterministic. */
const T0 = Date.UTC(2026, 7, 13, 12, 0, 0);
const T0_ISO = '2026-08-13T12:00:00.000Z';

/* ---- Fake fetch helpers (no network, ever) ------------------------------- */

function fakeResponse({ status = 200, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

/** Records every call so the request shape can be asserted. */
function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  fn.calls = calls;
  return fn;
}

/* ==========================================================================
 * 1. Fixture contract — the fixture itself must stay representative
 * ======================================================================== */

test('fixture parses and is a Sleeper league payload', () => {
  const fx = fixture();
  assert.equal(typeof fx, 'object');
  assert.equal(fx.league_id, '1051234567890123456');
  assert.equal(fx.sport, 'nfl');
  assert.ok(Array.isArray(fx.roster_positions));
  assert.equal(typeof fx.scoring_settings, 'object');
  assert.equal(typeof fx.settings, 'object');
});

test('fixture is real-league sized: 145 scoring keys, 52 settings, 19 roster slots', () => {
  const fx = fixture();
  assert.equal(Object.keys(fx.scoring_settings).length, 145);
  assert.equal(Object.keys(fx.settings).length, 52);
  assert.equal(fx.roster_positions.length, 19);
});

test('fixture carries every stat key this app computes', () => {
  const fx = fixture();
  const missing = APP_SCORING_KEYS.filter((k) => !(k in fx.scoring_settings));
  assert.deepEqual(missing, []);
});

test('fixture exercises the hard cases: SUPER_FLEX, IDP slot, IR slot, keeper league', () => {
  const fx = fixture();
  assert.ok(fx.roster_positions.includes('SUPER_FLEX'));
  assert.ok(fx.roster_positions.includes('DL'));
  assert.ok(fx.roster_positions.includes('IR'));
  assert.equal(fx.settings.type, 1);
  assert.equal(fx.settings.max_keepers, 3);
});

/* ==========================================================================
 * 2. Policy constants — manual sync only, no invented equivalences
 * ======================================================================== */

test('SYNC_MODE is manual', () => {
  assert.equal(SYNC_MODE, 'manual');
});

test('the module contains no polling primitive of any kind', () => {
  // The one setTimeout in the file is the fetch abort timer; nothing else.
  assert.equal(/setInterval\s*\(/.test(SOURCE_TEXT), false, 'setInterval found');
  assert.equal(/setImmediate\s*\(/.test(SOURCE_TEXT), false, 'setImmediate found');
  assert.equal(/requestAnimationFrame\s*\(/.test(SOURCE_TEXT), false, 'rAF found');
  assert.equal(/visibilitychange/.test(SOURCE_TEXT), false, 'visibilitychange refresh found');
  const timeouts = SOURCE_TEXT.match(/setTimeout\s*\(/g) || [];
  assert.equal(timeouts.length, 1, 'exactly one setTimeout (the abort timer) is allowed');
});

test('the abort timer is never unref\'d — an unref\'d timer is no timeout at all', () => {
  // Regression: unref() let the event loop drain before the abort could fire,
  // so a hung fetch was never actually cancelled.
  assert.equal(/\.unref\s*\(/.test(SOURCE_TEXT), false);
});

test('the module never reads market data', () => {
  const banned = /\b(adp|auction_value|kalshi|polymarket|moneyline|vegas)\b/i;
  // Allow the word inside no context at all — there should be zero hits.
  assert.equal(banned.test(SOURCE_TEXT), false);
});

test('SCORING_ALIASES is deliberately empty and frozen', () => {
  assert.deepEqual(Object.keys(SCORING_ALIASES), []);
  assert.ok(Object.isFrozen(SCORING_ALIASES));
});

test('every SLEEPER_SLOT_MAP target is a token app/league.js accepts', () => {
  Object.values(SLEEPER_SLOT_MAP).forEach((token) => {
    assert.ok(ROSTER_TOKENS.includes(token), `${token} is not a league.js roster token`);
  });
});

test('the four mappable Sleeper flex tokens are all present', () => {
  ['FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX'].forEach((t) => {
    assert.equal(SLEEPER_SLOT_MAP[t], t);
  });
});

test('RB_TE_FLEX is app-only and can never be produced by an import', () => {
  assert.equal('RB_TE_FLEX' in SLEEPER_SLOT_MAP, false);
  assert.equal(Object.values(SLEEPER_SLOT_MAP).includes('RB_TE_FLEX'), false);
});

test('unsupported slot tokens do not overlap the mappable ones', () => {
  Object.keys(UNSUPPORTED_SLOT_TOKENS).forEach((token) => {
    assert.equal(token in SLEEPER_SLOT_MAP, false, `${token} is in both maps`);
    assert.equal(typeof UNSUPPORTED_SLOT_TOKENS[token], 'string');
    assert.ok(UNSUPPORTED_SLOT_TOKENS[token].length > 10, 'reason must be a real sentence');
  });
});

test('IMPORT_TIERS ships all three routes in order', () => {
  assert.deepEqual(IMPORT_TIERS.map((t) => t.id), ['api', 'paste', 'default']);
  assert.deepEqual(IMPORT_TIERS.map((t) => t.needs_network), [true, false, false]);
  assert.ok(Object.isFrozen(IMPORT_TIERS));
});

test('IGNORED_SETTING_KEYS has no duplicates', () => {
  assert.equal(new Set(IGNORED_SETTING_KEYS).size, IGNORED_SETTING_KEYS.length);
});

test('SLEEPER_LEAGUE_TYPES covers redraft/keeper/dynasty', () => {
  assert.equal(SLEEPER_LEAGUE_TYPES[0], 'redraft');
  assert.equal(SLEEPER_LEAGUE_TYPES[1], 'keeper');
  assert.equal(SLEEPER_LEAGUE_TYPES[2], 'dynasty');
});

/* ==========================================================================
 * 3. parseLeagueId / leagueEndpoint
 * ======================================================================== */

test('parseLeagueId accepts a bare id', () => {
  assert.equal(parseLeagueId('1051234567890123456'), '1051234567890123456');
  assert.equal(parseLeagueId('  1051234567890123456  '), '1051234567890123456');
});

test('parseLeagueId accepts a safe integer id', () => {
  assert.equal(parseLeagueId(1234567890), '1234567890');
});

test('parseLeagueId REFUSES a number too big to survive float64', () => {
  // 917214231462133760 round-trips through Number as ...133800 — a different
  // league. Refusing is the only honest answer; the caller must pass a string.
  assert.equal(parseLeagueId(917214231462133760), null);
  assert.equal(parseLeagueId('917214231462133760'), '917214231462133760');
  assert.equal(Number.isSafeInteger(917214231462133760), false);
});

test('parseLeagueId accepts a sleeper.com league URL', () => {
  assert.equal(
    parseLeagueId('https://sleeper.com/leagues/1051234567890123456/team'),
    '1051234567890123456',
  );
  assert.equal(
    parseLeagueId('https://sleeper.app/leagues/1051234567890123456'),
    '1051234567890123456',
  );
});

test('parseLeagueId accepts the API URL itself', () => {
  assert.equal(
    parseLeagueId('https://api.sleeper.app/v1/league/1051234567890123456'),
    '1051234567890123456',
  );
});

test('parseLeagueId accepts a league_id query parameter', () => {
  assert.equal(
    parseLeagueId('https://example.test/x?league_id=1051234567890123456&tab=1'),
    '1051234567890123456',
  );
});

test('parseLeagueId refuses to guess', () => {
  [null, undefined, '', '   ', {}, [], true, 'my league', '12345', 'abc123456789',
    'https://sleeper.com/leagues/', -5, 1.5, NaN].forEach((v) => {
    assert.equal(parseLeagueId(v), null, `should not parse ${JSON.stringify(v)}`);
  });
});

test('leagueEndpoint builds the documented URL', () => {
  assert.equal(
    leagueEndpoint('1051234567890123456'),
    'https://api.sleeper.app/v1/league/1051234567890123456',
  );
  assert.equal(SLEEPER_API_BASE, 'https://api.sleeper.app/v1');
});

test('leagueEndpoint escapes anything odd rather than injecting it', () => {
  assert.equal(leagueEndpoint('a/b?c'), 'https://api.sleeper.app/v1/league/a%2Fb%3Fc');
});

/* ==========================================================================
 * 4. mapScoring — the four buckets must PARTITION the input
 * ======================================================================== */

test('mapScoring buckets the fixture: 35 mapped, 41 carried, 69 zeroed, 0 invalid', () => {
  const r = mapScoring(fixture().scoring_settings);
  assert.equal(r.total_keys, 145);
  assert.equal(r.mapped.length, 35);
  assert.equal(r.carried.length, 41);
  assert.equal(r.dropped_zero.length, 69);
  assert.equal(r.invalid.length, 0);
});

test('mapScoring loses nothing: the buckets partition every input key exactly once', () => {
  const settings = fixture().scoring_settings;
  const r = mapScoring(settings);
  const seen = [
    ...r.mapped.map((m) => m.source),
    ...r.carried.map((c) => c.source),
    ...r.dropped_zero,
    ...r.invalid.map((i) => i.key),
  ];
  assert.equal(seen.length, Object.keys(settings).length);
  assert.deepEqual(seen.slice().sort(), Object.keys(settings).sort());
});

test('mapScoring maps every app stat key with its exact league value', () => {
  const settings = fixture().scoring_settings;
  const r = mapScoring(settings);
  assert.deepEqual(r.mapped.map((m) => m.key).sort(), APP_SCORING_KEYS.slice().sort());
  r.mapped.forEach((m) => assert.equal(r.scoring[m.key], settings[m.key]));
  assert.equal(r.scoring.pass_yd, 0.04);
  assert.equal(r.scoring.pass_int, -2);
  assert.equal(r.scoring.rec, 1);
  assert.equal(r.scoring.pts_allow_35p, -4);
});

test('a KNOWN stat worth zero is kept — "this league scores 0 for X" is information', () => {
  const r = mapScoring(fixture().scoring_settings);
  assert.equal(r.scoring.pts_allow_21_27, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(r.scoring, 'pts_allow_21_27'));
  assert.equal(r.dropped_zero.includes('pts_allow_21_27'), false);
});

test('an UNKNOWN stat worth points is carried into the table and flagged', () => {
  const r = mapScoring(fixture().scoring_settings);
  assert.equal(r.scoring.idp_sack, 4);
  assert.equal(r.scoring.bonus_rec_te, 0.5);
  assert.equal(r.scoring.rec_fd, 0.5);
  const carriedKeys = r.carried.map((c) => c.key);
  ['idp_sack', 'bonus_rec_te', 'rec_fd', 'yds_allow_550p'].forEach((k) => {
    assert.ok(carriedKeys.includes(k), `${k} should be carried`);
  });
});

test('an UNKNOWN stat worth zero is omitted but named', () => {
  const r = mapScoring(fixture().scoring_settings);
  assert.equal('bonus_fd_qb' in r.scoring, false);
  assert.equal('pass_att' in r.scoring, false);
  assert.ok(r.dropped_zero.includes('bonus_fd_qb'));
  assert.ok(r.dropped_zero.includes('pass_att'));
});

test('mapScoring never coerces a non-number into a value the user did not set', () => {
  const r = mapScoring({ rec: 'one', rec_yd: null, rec_td: true, pass_td: [], fum_lost: {} });
  assert.deepEqual(r.invalid.map((i) => i.key).sort(),
    ['fum_lost', 'pass_td', 'rec', 'rec_td', 'rec_yd']);
  assert.equal(r.usable, false);
  assert.equal(r.scoring, null);
});

test('mapScoring accepts a numeric string, because Sleeper has shipped them', () => {
  const r = mapScoring({ rec: '1.5', sack: '2' });
  assert.equal(r.scoring.rec, 1.5);
  assert.equal(r.scoring.sack, 2);
  assert.equal(r.invalid.length, 0);
});

test('mapScoring on a non-object is unusable, not a throw', () => {
  [null, undefined, 'x', 42, []].forEach((v) => {
    const r = mapScoring(v);
    assert.equal(r.usable, false);
    assert.equal(r.scoring, null);
    assert.equal(r.total_keys, 0);
  });
});

/* ==========================================================================
 * 5. mapRosterPositions
 * ======================================================================== */

test('mapRosterPositions maps the fixture roster and drops the IDP slot loudly', () => {
  const r = mapRosterPositions(fixture().roster_positions);
  assert.equal(r.usable, true);
  assert.equal(r.starters, 11);
  assert.equal(r.bench, 6);
  assert.equal(r.reserve_slots, 1);
  assert.equal(r.taxi_slots, 0);
  assert.deepEqual(r.unsupported.map((u) => [u.token, u.count]), [['DL', 1]]);
  assert.match(r.unsupported[0].reason, /team DEF only/);
});

test('mapRosterPositions puts every BN at the end', () => {
  const r = mapRosterPositions(['QB', 'BN', 'RB', 'BN', 'WR']);
  assert.deepEqual(r.roster_positions, ['QB', 'RB', 'WR', 'BN', 'BN']);
  assert.equal(r.starters, 3);
  assert.equal(r.bench, 2);
});

test('mapRosterPositions is case-insensitive', () => {
  const r = mapRosterPositions(['qb', 'rb', 'super_flex', ' bn ']);
  assert.deepEqual(r.roster_positions, ['QB', 'RB', 'SUPER_FLEX', 'BN']);
});

test('IR and TAXI are counted out, never folded into the bench', () => {
  const r = mapRosterPositions(['QB', 'BN', 'IR', 'IR', 'TAXI']);
  assert.deepEqual(r.roster_positions, ['QB', 'BN']);
  assert.equal(r.bench, 1);
  assert.equal(r.reserve_slots, 2);
  assert.equal(r.taxi_slots, 1);
  assert.deepEqual(r.unsupported, []);
});

test('an unrecognised token is reported, never passed through', () => {
  const r = mapRosterPositions(['QB', 'ZORP', 'ZORP', '']);
  assert.deepEqual(r.roster_positions, ['QB']);
  const tokens = r.unsupported.map((u) => `${u.token}x${u.count}`);
  assert.deepEqual(tokens, ['ZORPx2', '(blank)x1']);
  assert.match(r.unsupported[0].reason, /Unrecognised/);
});

test('a roster with no importable starter is unusable', () => {
  const r = mapRosterPositions(['DL', 'LB', 'DB', 'BN']);
  assert.equal(r.usable, false);
  assert.equal(r.starters, 0);
});

test('mapRosterPositions on a non-array is unusable, not a throw', () => {
  [null, undefined, 'QB', {}, 7].forEach((v) => {
    const r = mapRosterPositions(v);
    assert.equal(r.usable, false);
    assert.equal(r.roster_positions, null);
  });
});

/* ==========================================================================
 * 6. mapSettings
 * ======================================================================== */

test('mapSettings reads the fixture scalars', () => {
  const fx = fixture();
  const r = mapSettings(fx.settings, { total_rosters: fx.total_rosters });
  assert.equal(r.shape.teams, 12);
  assert.equal(r.shape.draft_rounds, 15);
  assert.equal(r.shape.playoff_week_start, 15);
  assert.equal(r.shape.keepers_enabled, true);
  assert.equal(r.shape.max_keepers, 3);
  assert.equal(r.reserve_slots, 1);
  assert.equal(r.taxi_slots, 0);
  assert.equal(r.league_type_label, 'keeper');
});

test('mapSettings maps position_limit_* onto caps and reports the ones it cannot', () => {
  const fx = fixture();
  const r = mapSettings(fx.settings, {});
  assert.deepEqual(r.position_caps, { QB: 3, TE: 4, K: 2, DEF: 3 });
  assert.deepEqual(r.caps_unmapped.map((c) => c.key), ['position_limit_dl']);
  assert.match(r.caps_unmapped[0].reason, /not a position this app rosters/);
});

test('every mapped cap position is a real app position', () => {
  const r = mapSettings(fixture().settings, {});
  Object.keys(r.position_caps).forEach((p) => assert.ok(POSITIONS.includes(p)));
});

test('a negative position_limit means UNCAPPED, not a cap of -1', () => {
  const r = mapSettings({ position_limit_qb: -1, position_limit_rb: 5 }, {});
  assert.deepEqual(r.position_caps, { RB: 5 });
  assert.ok(r.notes.some((n) => n.code === 'position_limit_uncapped'));
});

test('no position limits removes the app default caps and says so', () => {
  const r = mapSettings({ num_teams: 10 }, {});
  assert.deepEqual(r.position_caps, {});
  const n = r.notes.find((x) => x.code === 'no_position_limits');
  assert.ok(n);
  assert.match(n.message, /five QBs/);
  assert.deepEqual(n.detail, DEFAULT_PROFILE.shape.position_caps);
});

test('team count falls back to total_rosters and reports the fallback', () => {
  const r = mapSettings({ draft_rounds: 12 }, { total_rosters: 14 });
  assert.equal(r.shape.teams, 14);
  assert.ok(r.notes.some((n) => n.code === 'teams_from_total_rosters'));
});

test('a payload with no league size sets nothing and warns', () => {
  const r = mapSettings({}, {});
  assert.equal('teams' in r.shape, false);
  assert.ok(r.notes.some((n) => n.code === 'teams_missing'));
});

test('missing draft_rounds is reported, not invented', () => {
  const r = mapSettings({ num_teams: 12 }, {});
  assert.equal('draft_rounds' in r.shape, false);
  assert.ok(r.notes.some((n) => n.code === 'draft_rounds_missing'));
});

test('playoff_week_start 0 means auto and is not written as week 0', () => {
  const r = mapSettings({ playoff_week_start: 0 }, {});
  assert.equal('playoff_week_start' in r.shape, false);
  assert.ok(r.notes.some((n) => n.code === 'playoff_week_auto'));
});

test('a redraft league with Sleeper max_keepers 1 does NOT get keepers', () => {
  const r = mapSettings({ type: 0, max_keepers: 1 }, {});
  assert.equal(r.shape.keepers_enabled, false);
  assert.equal(r.shape.max_keepers, 0);
  assert.equal(r.league_type_label, 'redraft');
});

test('a dynasty league gets keepers', () => {
  const r = mapSettings({ type: 2, max_keepers: 20 }, {});
  assert.equal(r.shape.keepers_enabled, true);
  assert.equal(r.shape.max_keepers, 20);
  assert.equal(r.league_type_label, 'dynasty');
});

test('with no "type" the keeper toggle is INFERRED and always says so', () => {
  const inferredOff = mapSettings({ max_keepers: 1 }, {});
  assert.equal(inferredOff.shape.keepers_enabled, false);
  assert.ok(inferredOff.notes.some((n) => n.code === 'keepers_inferred_from_max'));

  const inferredOn = mapSettings({ max_keepers: 4 }, {});
  assert.equal(inferredOn.shape.keepers_enabled, true);
  assert.equal(inferredOn.shape.max_keepers, 4);
  assert.ok(inferredOn.notes.some((n) => n.code === 'keepers_inferred_from_max'));
});

test('the keeper reading is reported on every import', () => {
  const r = mapSettings(fixture().settings, {});
  const n = r.notes.find((x) => x.code === 'keepers_read');
  assert.ok(n);
  assert.deepEqual(n.detail, { type: 1, type_label: 'keeper', max_keepers: 3 });
});

test('known-but-unused settings are "ignored"; genuinely new ones are "unmapped"', () => {
  const r = mapSettings({ waiver_type: 2, trade_deadline: 11, brand_new_2027: 9 }, {});
  assert.deepEqual(r.ignored.sort(), ['trade_deadline', 'waiver_type']);
  assert.deepEqual(r.unmapped, [{ key: 'brand_new_2027', value: 9 }]);
});

test('the fixture leaves nothing genuinely unrecognised', () => {
  const r = mapSettings(fixture().settings, {});
  assert.deepEqual(r.unmapped, []);
  assert.equal(r.ignored.length, 40);
});

test('mapSettings on a non-object still returns a usable result', () => {
  [null, undefined, 'x', 3, []].forEach((v) => {
    const r = mapSettings(v, null);
    assert.equal(typeof r.shape, 'object');
    assert.deepEqual(r.unmapped, []);
  });
});

/* ==========================================================================
 * 7. sleeperToProfile
 * ======================================================================== */

test('the fixture imports into the exact expected profile shape', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.profile.name, 'Gridiron Degenerates');
  assert.deepEqual(r.profile.shape.roster_positions, [
    'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
  ]);
  assert.equal(r.profile.shape.starters, 11);
  assert.equal(r.profile.shape.bench, 6);
  assert.equal(r.profile.shape.teams, 12);
  assert.equal(r.profile.shape.draft_rounds, 15);
  assert.equal(r.profile.shape.playoff_week_start, 15);
  assert.equal(r.profile.shape.keepers_enabled, true);
  assert.equal(r.profile.shape.max_keepers, 3);
  assert.deepEqual(r.profile.shape.position_caps, { QB: 3, TE: 4, K: 2, DEF: 3 });
});

test('flex eligibility is derived from the tokens actually used', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  assert.deepEqual(r.profile.shape.flex_eligibility, {
    FLEX: ['WR', 'RB', 'TE'],
    SUPER_FLEX: ['QB', 'WR', 'RB', 'TE'],
  });
});

test('the imported profile produces the roster slots the app will draft into', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  const slots = rosterSlots(r.profile);
  assert.deepEqual(slots.starters, [
    'QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'WR3', 'TE1', 'FLEX', 'SUPER_FLEX', 'K1', 'DEF1',
  ]);
  assert.equal(slots.bench.length, 6);
});

test('the imported scoring table is the league table, not the PPR default', () => {
  const fx = fixture();
  const r = sleeperToProfile(fx, { now: T0 });
  assert.equal(r.profile.scoring.pass_int, -2); // default is -1
  assert.equal(r.profile.scoring.rush_fd, 0.5); // not an app stat, carried anyway
  assert.equal(r.profile.scoring.idp_int, 6);
  assert.equal(Object.keys(r.profile.scoring).length, 76);
  APP_SCORING_KEYS.forEach((k) => {
    assert.equal(r.profile.scoring[k], fx.scoring_settings[k], `scoring.${k}`);
  });
});

test('the imported profile passes app/league.js validation with no blocking errors', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  assert.equal(hasBlockingErrors(r.report.validation), false);
  assert.equal(hasBlockingErrors(validateProfile(r.profile)), false);
});

test('the imported profile is already normalised (normalizeProfile is a no-op on it)', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  assert.deepEqual(normalizeProfile(r.profile), r.profile);
});

test('report.league carries the league identity verbatim', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  assert.deepEqual(r.report.league, {
    id: '1051234567890123456',
    name: 'Gridiron Degenerates',
    season: '2026',
    season_type: 'regular',
    sport: 'nfl',
    status: 'in_season',
    type: 1,
    type_label: 'keeper',
    previous_league_id: '917214231462133760',
  });
  assert.equal(r.report.source, 'api');
  assert.equal(r.report.synced_at, T0_ISO);
});

test('dropping the IDP slot and excluding IR are both reported', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  const codes = r.report.notes.map((n) => n.code);
  assert.ok(codes.includes('slots_dropped'));
  assert.ok(codes.includes('reserve_slots_excluded'));
  assert.ok(codes.includes('scoring_carried'));
});

test('a settings/roster disagreement about IR count is surfaced', () => {
  const fx = fixture();
  fx.settings.reserve_slots = 3; // roster_positions only has one IR
  const r = sleeperToProfile(fx, { now: T0 });
  const n = r.report.notes.find((x) => x.code === 'reserve_slots_disagree');
  assert.ok(n);
  assert.deepEqual(n.detail, { settings: 3, roster_positions: 1 });
});

test('a league with no name falls back to the default name', () => {
  const fx = fixture();
  delete fx.name;
  const r = sleeperToProfile(fx, { now: T0 });
  assert.equal(r.profile.name, DEFAULT_PROFILE.name);
  assert.equal(r.report.league.name, null);
});

test('an unusable scoring table falls back to PPR and says so loudly', () => {
  const fx = fixture();
  fx.scoring_settings = { rec: 'one', pass_td: null };
  const r = sleeperToProfile(fx, { now: T0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.profile.scoring, DEFAULT_PROFILE.scoring);
  const codes = r.report.notes.map((n) => n.code);
  assert.ok(codes.includes('scoring_unusable'));
  assert.ok(codes.includes('scoring_invalid'));
});

test('an all-IDP roster fails rather than importing a fake one', () => {
  const fx = fixture();
  fx.roster_positions = ['DL', 'LB', 'DB', 'BN', 'BN'];
  const r = sleeperToProfile(fx, { now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.profile, null);
  assert.equal(r.error.code, 'no_supported_slots');
  assert.deepEqual(r.error.detail, ['DL', 'LB', 'DB']);
  assert.ok(r.report, 'a failed import still reports what it saw');
});

test('non-league JSON is rejected with an actionable message', () => {
  [null, undefined, 42, 'text', [], { players: [] }, { roster_positions: ['QB'] },
    { scoring_settings: { rec: 1 } }].forEach((v) => {
    const r = sleeperToProfile(v, { now: T0 });
    assert.equal(r.ok, false, `should reject ${JSON.stringify(v)}`);
    assert.equal(r.error.code, 'not_a_league');
    assert.equal(r.profile, null);
  });
});

test('sleeperToProfile never throws on hostile input', () => {
  const hostile = [
    { roster_positions: [{}, [], null, 7], scoring_settings: { a: Infinity } },
    { roster_positions: ['QB'], scoring_settings: {}, settings: 'nope' },
    { roster_positions: ['QB'], scoring_settings: { rec: 1 }, settings: { type: 'x' } },
    { roster_positions: ['QB'], scoring_settings: { rec: 1 }, name: 12345 },
    { roster_positions: new Array(200).fill('QB'), scoring_settings: { rec: 1 } },
    { roster_positions: ['QB'], scoring_settings: { rec: 1 }, total_rosters: 'many' },
  ];
  hostile.forEach((p, i) => {
    const r = sleeperToProfile(p, { now: T0 });
    assert.equal(typeof r.ok, 'boolean', `case ${i}`);
    if (r.ok) assert.equal(hasBlockingErrors(validateProfile(r.profile)), false, `case ${i}`);
  });
});

test('an oversized roster is clamped by league.js rather than accepted', () => {
  const fx = fixture();
  fx.roster_positions = new Array(60).fill('WR');
  const r = sleeperToProfile(fx, { now: T0 });
  assert.equal(r.ok, true);
  // league.js refuses a roster over LEAGUE_BOUNDS.roster_size[1] and keeps the default.
  assert.deepEqual(r.profile.shape.roster_positions, DEFAULT_PROFILE.shape.roster_positions);
  assert.ok(r.report.validation.some((e) => e.code === 'roster_too_large'));
});

/* ==========================================================================
 * 8. Tier 2 — pasted JSON
 * ======================================================================== */

test('tier 2 accepts a pasted JSON string', () => {
  const r = importFromPastedJson(FIXTURE_TEXT, { now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'paste');
  assert.equal(r.report.source, 'paste');
  assert.equal(r.profile.shape.starters, 11);
  assert.equal(r.next_tier, null);
});

test('tier 2 accepts an already-parsed object', () => {
  const r = importFromPastedJson(fixture(), { now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.profile.name, 'Gridiron Degenerates');
});

test('tier 2 tolerates surrounding whitespace', () => {
  const r = importFromPastedJson(`\n\n  ${FIXTURE_TEXT}  \n`, { now: T0 });
  assert.equal(r.ok, true);
});

test('tier 2 reports an empty paste and points at tier 3', () => {
  ['', '   ', '\n'].forEach((v) => {
    const r = importFromPastedJson(v, { now: T0 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'empty_paste');
    assert.equal(r.next_tier.id, 'default');
  });
});

test('tier 2 reports malformed JSON', () => {
  const r = importFromPastedJson('{ "league_id": ', { now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_json');
  assert.match(r.error.message, /valid JSON/);
});

test('tier 2 rejects a pasted "null" as not-a-league', () => {
  const r = importFromPastedJson('null', { now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_a_league');
});

/* ==========================================================================
 * 9. Tier 3 — PPR default
 * ======================================================================== */

test('tier 3 returns exactly the app default profile', () => {
  const r = importPprDefault({ now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'default');
  assert.deepEqual(r.profile, DEFAULT_PROFILE);
});

test('tier 3 hands back a MUTABLE copy — the frozen default is never exposed', () => {
  const r = importPprDefault({ now: T0 });
  assert.equal(Object.isFrozen(r.profile), false);
  r.profile.shape.teams = 8;
  assert.equal(DEFAULT_PROFILE.shape.teams, 12);
});

test('tier 3 says plainly that nothing was imported', () => {
  const r = importPprDefault({ now: T0 });
  assert.equal(r.report.source, 'default');
  assert.equal(r.report.synced_at, T0_ISO);
  const n = r.report.notes.find((x) => x.code === 'ppr_default');
  assert.ok(n);
  assert.match(n.message, /not your league/);
  assert.deepEqual(unresolvedItems(r.report), []);
});

/* ==========================================================================
 * 10. Tier 1 — fetch (injected; never the network)
 * ======================================================================== */

test('fetchSleeperLeague issues a SIMPLE, uncredentialed, aborted-on-timeout GET', async () => {
  const fetchImpl = recordingFetch(fakeResponse({ body: FIXTURE_TEXT }));
  const r = await fetchSleeperLeague('1051234567890123456', { fetch: fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(fetchImpl.calls.length, 1);

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.sleeper.app/v1/league/1051234567890123456');
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit', 'ACAO * + allow-credentials is illegal when credentialed');
  assert.equal(init.mode, 'cors');
  assert.equal(init.cache, 'no-store');
  assert.equal(
    Object.prototype.hasOwnProperty.call(init, 'headers'), false,
    'any author header would make this a preflighted request',
  );
  assert.ok(init.signal, 'a hung fetch must be abortable');
});

test('fetchSleeperLeague accepts a league URL, not just an id', async () => {
  const fetchImpl = recordingFetch(fakeResponse({ body: FIXTURE_TEXT }));
  await fetchSleeperLeague('https://sleeper.com/leagues/1051234567890123456/team',
    { fetch: fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'https://api.sleeper.app/v1/league/1051234567890123456');
});

test('a bad league id never reaches the network', async () => {
  const fetchImpl = recordingFetch(fakeResponse({ body: '{}' }));
  const r = await fetchSleeperLeague('not-a-league', { fetch: fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_league_id');
  assert.equal(fetchImpl.calls.length, 0);
});

test('HTTP 404 is reported as a missing league', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 404, body: '' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
  assert.equal(r.status, 404);
});

test('HTTP 200 with a literal null body is also a missing league', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 200, body: 'null' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('HTTP 429 is reported as rate limiting', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 429, body: '' }),
  });
  assert.equal(r.error.code, 'rate_limited');
});

test('any other non-2xx is reported with its status', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 503, body: 'nope' }),
  });
  assert.equal(r.error.code, 'http_error');
  assert.equal(r.error.detail, 503);
});

test('a non-JSON body is reported as bad JSON, with a snippet', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 200, body: '<html>cloudflare</html>' }),
  });
  assert.equal(r.error.code, 'bad_json');
  assert.match(r.error.detail, /cloudflare/);
});

test('a rejected fetch is reported as a network failure, not a crash', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'network');
  assert.match(r.error.detail, /Failed to fetch/);
});

test('a response object that is not a response is reported, not destructured blindly', async () => {
  const r = await fetchSleeperLeague('1051234567890123456', { fetch: async () => null });
  assert.equal(r.error.code, 'bad_response');
});

test('a hung fetch is aborted by the timeout and reported as a timeout', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const started = Date.now();
  const r = await fetchSleeperLeague('1051234567890123456', { fetch: hanging, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
  assert.ok(Date.now() - started < 2000, 'the timeout must actually fire');
});

test('the default timeout is 12 seconds', () => {
  assert.equal(SLEEPER_TIMEOUT_MS, 12000);
});

test('an externally aborted import reports cancellation, not a timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      return;
    }
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  const r = await fetchSleeperLeague('1051234567890123456', {
    fetch: hanging, signal: controller.signal,
  });
  assert.equal(r.error.code, 'aborted');
});

test('no fetch in the environment points the user at tier 2', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const r = await fetchSleeperLeague('1051234567890123456', {});
    assert.equal(r.error.code, 'no_fetch');
    assert.match(r.error.message, /Paste league JSON/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('importFromSleeper fetches then maps', async () => {
  const r = await importFromSleeper('1051234567890123456', {
    fetch: async () => fakeResponse({ body: FIXTURE_TEXT }),
    now: T0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'api');
  assert.equal(r.report.source, 'api');
  assert.equal(r.profile.shape.starters, 11);
  assert.equal(r.next_tier, null);
});

test('a failed tier-1 import hands the user tier 2', async () => {
  const r = await importFromSleeper('1051234567890123456', {
    fetch: async () => fakeResponse({ status: 404, body: '' }),
    now: T0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.profile, null);
  assert.equal(r.next_tier.id, 'paste');
});

/* ==========================================================================
 * 11. Surfacing — nothing is silently dropped
 * ======================================================================== */

test('unresolvedItems surfaces every unmapped thing from the fixture', () => {
  const r = sleeperToProfile(fixture(), { now: T0 });
  const items = unresolvedItems(r.report);
  const byKind = {};
  items.forEach((i) => { byKind[i.kind] = (byKind[i.kind] || 0) + 1; });
  assert.deepEqual(byKind, {
    scoring_carried: 41,
    scoring_zero: 69,
    roster_slot: 1,
    position_limit: 1,
  });
  assert.equal(items.length, 112);
  items.forEach((i) => {
    assert.equal(typeof i.message, 'string');
    assert.ok(i.message.length > 0);
    assert.ok(i.key !== undefined);
  });
});

test('unresolvedItems names the specific things a user would ask about', () => {
  const items = unresolvedItems(sleeperToProfile(fixture(), { now: T0 }).report);
  const find = (kind, key) => items.find((i) => i.kind === kind && i.key === key);
  assert.ok(find('roster_slot', 'DL'));
  assert.ok(find('position_limit', 'position_limit_dl'));
  assert.ok(find('scoring_carried', 'idp_sack'));
  assert.ok(find('scoring_carried', 'bonus_rec_te'));
  assert.ok(find('scoring_zero', 'bonus_fd_qb'));
  assert.match(find('scoring_carried', 'idp_sack').message, /adds nothing to a projected total/);
});

test('a genuinely unknown setting surfaces as an item', () => {
  const fx = fixture();
  fx.settings.brand_new_2027 = { a: 1 };
  const items = unresolvedItems(sleeperToProfile(fx, { now: T0 }).report);
  const item = items.find((i) => i.kind === 'setting');
  assert.ok(item);
  assert.equal(item.key, 'brand_new_2027');
});

test('unresolvedItems is total', () => {
  [null, undefined, 'x', 3, [], {}].forEach((v) => {
    assert.deepEqual(unresolvedItems(v), []);
  });
});

test('summarizeImport describes a successful import without overclaiming', () => {
  const lines = summarizeImport(sleeperToProfile(fixture(), { now: T0 }));
  const text = lines.join('\n');
  assert.match(text, /Gridiron Degenerates \(2026\): 11 starters, 6 bench\./);
  assert.match(text, /35 scoring rule\(s\) recognised/);
  assert.match(text, /112 item\(s\) could not be applied/);
  assert.equal(/Every value in the payload was understood/.test(text), false);
  // The whole point of this test is the word "overclaiming". RECOGNISING a
  // scoring rule is not the same as APPLYING it: at this release only the
  // reception value reaches a projection, so a 6-point-passing-TD league still
  // sees 4-point numbers. The summary must say so rather than implying the
  // entire scoring table is already live.
  assert.match(text, /only the reception value currently changes a projection/);
  assert.equal(/scoring rule\(s\) mapped to this app/.test(text), false);
});

test('summarizeImport claims a clean import only when there is nothing left over', () => {
  const clean = {
    league_id: '111111111111111111',
    name: 'Clean',
    season: '2026',
    total_rosters: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
    scoring_settings: DEFAULT_PROFILE.scoring,
    settings: { num_teams: 10, draft_rounds: 9, playoff_week_start: 15, type: 0, max_keepers: 1 },
  };
  const result = sleeperToProfile(clean, { now: T0 });
  assert.equal(unresolvedItems(result.report).length, 0);
  assert.match(summarizeImport(result).join('\n'), /Every value in the payload was understood/);
});

test('summarizeImport on a failure leads with the error and the next tier', () => {
  const failed = importFromPastedJson('{{{', { now: T0 });
  const lines = summarizeImport(failed);
  assert.match(lines[0], /valid JSON/);
  assert.match(lines[1], /Start from standard PPR/);
});

test('summarizeImport is total', () => {
  [null, undefined, 'x', 3, [], {}].forEach((v) => {
    const lines = summarizeImport(v);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length > 0);
  });
});
