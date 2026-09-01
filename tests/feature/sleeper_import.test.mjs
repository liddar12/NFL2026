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
  CROSSWALK_CODES,
  CROSSWALK_METHODS,
  IGNORED_SETTING_KEYS,
  IMPORT_TIERS,
  SCORING_ALIASES,
  SLEEPER_API_BASE,
  SLEEPER_EMPTY_SLOT,
  SLEEPER_LEAGUE_TYPES,
  SLEEPER_SLOT_MAP,
  SLEEPER_TEAM_ALIASES,
  SLEEPER_TIMEOUT_MS,
  SLEEPER_WEEK_RANGE,
  SYNC_MODE,
  UNSUPPORTED_PLAYER_POSITIONS,
  UNSUPPORTED_SLOT_TOKENS,
  buildSleeperPlayerIndex,
  crosswalkPlayerIds,
  crosswalkRoster,
  fetchSleeperLeague,
  fetchSleeperMatchups,
  fetchSleeperRosters,
  fetchSleeperUsers,
  findTeam,
  importFromPastedJson,
  importFromSleeper,
  importPprDefault,
  importSleeperTeams,
  joinRosters,
  leagueEndpoint,
  leagueUsersEndpoint,
  mapLeagueUsers,
  mapMatchups,
  mapRosterPositions,
  mapRosters,
  mapScoring,
  mapSettings,
  matchupForRoster,
  matchupPairs,
  matchupsEndpoint,
  normalizePlayerName,
  ownerChoices,
  parseLeagueId,
  parseWeek,
  rostersEndpoint,
  sleeperToProfile,
  summarizeImport,
  unresolvedItems,
} from '../../app/sleeper.js';
import { TEAMS } from '../../app/teams.js';

/* ---- Fixture ------------------------------------------------------------- */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/sleeper_league.json', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../../app/sleeper.js', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const SOURCE_TEXT = readFileSync(SOURCE_PATH, 'utf8');

/** Fresh deep copy — no test may contaminate another. */
function fixture() {
  return JSON.parse(FIXTURE_TEXT);
}

/* Roster / user / matchup / player-dump fixtures.
 *
 * Shapes are copied from real api.sleeper.app responses. The PLAYER IDENTITIES
 * are real and come out of this repo's own data/: names, teams, positions and
 * the espn-/gsis ids in tests/fixtures/sleeper_app_players.json are lifted from
 * data/player_projections.json and data/kdst_projections.json. Sleeper's own
 * player_id values are the one synthetic part — Sleeper's real ids are not
 * derivable from anything in this repo — so no test below asserts a match
 * THROUGH a Sleeper id: every match is asserted through espn_id, gsis_id, the
 * team abbreviation, or the player's name.
 *
 * The fixtures carry the mess on purpose: an open team with no manager, a team
 * whose manager is missing from the user list, a manager with no team, an IDP
 * filling the league's DL slot, a roster id the player dump has never heard of,
 * a real NFL player this app has no projection for, and two players whose dump
 * entry has no espn_id at all.
 */
const readFixture = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'),
);
const ROSTERS_RAW = readFixture('sleeper_rosters.json');
const USERS_RAW = readFixture('sleeper_users.json');
const MATCHUPS_RAW = readFixture('sleeper_matchups_week1.json');
const PLAYERS_DUMP = readFixture('sleeper_players_nfl.json');
const APP_PLAYERS = readFixture('sleeper_app_players.json');

const rostersFixture = () => JSON.parse(JSON.stringify(ROSTERS_RAW));
const usersFixture = () => JSON.parse(JSON.stringify(USERS_RAW));
const matchupsFixture = () => JSON.parse(JSON.stringify(MATCHUPS_RAW));
const playersDump = () => JSON.parse(JSON.stringify(PLAYERS_DUMP));
const appPlayers = () => JSON.parse(JSON.stringify(APP_PLAYERS));

/** The joined league, built once the way the UI will build it. */
function joinedTeams() {
  const rosters = mapRosters(rostersFixture());
  const users = mapLeagueUsers(usersFixture());
  return joinRosters(rosters.rosters, users.users);
}

const LEAGUE_ID = '1051234567890123456';

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
  /* R28 — THE MESSAGE NOW NAMES THE PROJECTION IT MEANS.
   *
   * It used to say a carried rule "adds nothing to a projected total", full
   * stop. True of the QB/RB/WR/TE path; FLATLY FALSE for K and D/ST, which
   * app/kdst.js scores from the league's own table. Measured on a real import,
   * those rules move a defence between -17.85 and +16.18 points and reorder 29
   * of 32 — while the app told its owner they did nothing at all.
   *
   * An unowned key still says "adds nothing", correctly scoped. */
  assert.match(find('scoring_carried', 'idp_sack').message,
    /adds nothing to a QB\/RB\/WR\/TE projected total/);
  assert.equal(find('scoring_carried', 'idp_sack').owner, null);
});

test('a carried K or D/ST rule is reported as APPLIED, not as doing nothing (R28)', () => {
  const fx = fixture();
  fx.scoring_settings = {
    ...(fx.scoring_settings || {}), fgm_50_59: 5, yds_allow_450_499: -5,
  };
  const items = unresolvedItems(sleeperToProfile(fx, { now: T0 }).report);
  const find = (key) => items.find((i) => i.kind === 'scoring_carried' && i.key === key);

  const k = find('fgm_50_59');
  assert.ok(k, 'a carried kicker rule must still be reported');
  assert.equal(k.owner, 'K');
  assert.match(k.message, /IS applied to your kicker projections/);
  assert.doesNotMatch(k.message, /adds nothing/);

  const d = find('yds_allow_450_499');
  assert.ok(d, 'a carried defence rule must still be reported');
  assert.equal(d.owner, 'DEF');
  assert.match(d.message, /IS applied to your defence projections/);
  assert.doesNotMatch(d.message, /adds nothing/);
  // The honest caveat survives: an unsuppliable component reads PARTIAL, not 0.
  assert.match(d.message, /PARTIAL/);
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
  // scoring rule is not the same as APPLYING it. R44 made component-fed rules
  // real — a 6-point-passing-TD league now sees 6-point numbers through the
  // league delta — but rules with no component behind them (40+-yard play
  // bonuses, pick-six thrown) still add nothing, and the summary must state
  // that boundary rather than implying the entire table is live.
  assert.match(text, /every rule a verified component feeds/);
  assert.match(text, /adds nothing yet/,
    'the unpriced remainder must stay named — silence here is the old overclaim');
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

/* ==========================================================================
 * 12. Roster / user / matchup fixtures — they must stay representative
 * ======================================================================== */

test('roster fixture is a full 12-team league with real roster geometry', () => {
  const raw = rostersFixture();
  assert.equal(raw.length, 12);
  assert.equal(raw[0].roster_id, 1);
  assert.equal(raw[0].league_id, LEAGUE_ID);
  assert.equal(raw[0].starters.length, 12); // 11 mappable + the league's DL slot
  assert.equal(raw[0].players.length, 18);
  assert.deepEqual(raw[0].taxi, null, 'Sleeper ships null, not [], for an empty list');
  assert.equal(raw[0].reserve.length, 1);
});

test('roster fixture carries both orphan cases and the user fixture the third', () => {
  const raw = rostersFixture();
  assert.equal(raw[3].owner_id, null, 'an open team has no manager');
  assert.equal(raw[11].owner_id, '8642000000000000099');
  const users = usersFixture();
  assert.equal(users.length, 13);
  assert.equal(users.some((u) => u.user_id === '8642000000000000099'), false,
    'roster 12 must point at a manager the user list does not have');
  assert.equal(users[12].display_name, 'formermanager');
});

test('matchup fixture is one line per team, paired two to a matchup_id', () => {
  const raw = matchupsFixture();
  assert.equal(raw.length, 12);
  assert.equal(new Set(raw.map((m) => m.matchup_id)).size, 6);
  assert.equal(raw[0].starters.length, raw[0].starters_points.length);
});

test('player dump fixture keys team defences by abbreviation, as Sleeper does', () => {
  const dump = playersDump();
  assert.equal(Object.keys(dump).length, 229);
  assert.equal(dump.DEN.position, 'DEF');
  assert.equal(dump.DEN.player_id, 'DEN');
  assert.equal(dump['4035'].full_name, 'Josh Sweat');
  assert.deepEqual(dump['4035'].fantasy_positions, ['DL']);
});

test('app player fixture uses BOTH id field names this repo actually ships', () => {
  const rows = appPlayers();
  assert.equal(rows.length, 216);
  assert.ok(rows.some((r) => typeof r.gsis_id === 'string' && r.gsis_id.startsWith('espn-')));
  assert.ok(rows.some((r) => typeof r.player_id === 'string' && r.player_id.startsWith('00-')));
  assert.ok(rows.some((r) => typeof r.player_id === 'string' && r.player_id.startsWith('DST-')));
});

/* ==========================================================================
 * 13. Endpoints + week parsing
 * ======================================================================== */

test('the three new endpoints are the documented Sleeper URLs', () => {
  assert.equal(rostersEndpoint(LEAGUE_ID), `${SLEEPER_API_BASE}/league/${LEAGUE_ID}/rosters`);
  assert.equal(leagueUsersEndpoint(LEAGUE_ID), `${SLEEPER_API_BASE}/league/${LEAGUE_ID}/users`);
  assert.equal(matchupsEndpoint(LEAGUE_ID, 4), `${SLEEPER_API_BASE}/league/${LEAGUE_ID}/matchups/4`);
});

test('endpoint builders escape rather than inject', () => {
  assert.equal(matchupsEndpoint('a/b', '../x'),
    'https://api.sleeper.app/v1/league/a%2Fb/matchups/..%2Fx');
});

test('parseWeek takes whole weeks in range and refuses everything else', () => {
  assert.equal(parseWeek(1), 1);
  assert.equal(parseWeek('18'), 18);
  assert.equal(parseWeek(22), 22);
  [0, -1, 23, 1.5, 'week 1', '', null, undefined, {}, [], NaN, Infinity].forEach((v) => {
    assert.equal(parseWeek(v), null, `should refuse ${JSON.stringify(v)}`);
  });
  assert.deepEqual(SLEEPER_WEEK_RANGE, [1, 22]);
});

/* ==========================================================================
 * 14. The three new fetches — same discipline, injected, never the network
 * ======================================================================== */

const LEAGUE_URL = `${SLEEPER_API_BASE}/league/${LEAGUE_ID}`;
const NEW_FETCHERS = [
  ['rosters', (f, o) => fetchSleeperRosters(LEAGUE_ID, o), `${LEAGUE_URL}/rosters`],
  ['users', (f, o) => fetchSleeperUsers(LEAGUE_ID, o), `${LEAGUE_URL}/users`],
  ['matchups', (f, o) => fetchSleeperMatchups(LEAGUE_ID, 1, o), `${LEAGUE_URL}/matchups/1`],
];

NEW_FETCHERS.forEach(([name, call, expectedUrl]) => {
  test(`fetchSleeper ${name} issues the same SIMPLE uncredentialed GET as the league read`, async () => {
    const fetchImpl = recordingFetch(fakeResponse({ body: '[]' }));
    const r = await call(fetchImpl, { fetch: fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, expectedUrl);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.mode, 'cors');
    assert.equal(init.cache, 'no-store');
    assert.equal(Object.prototype.hasOwnProperty.call(init, 'headers'), false,
      'any author header would make this a preflighted request');
    assert.ok(init.signal, 'a hung fetch must be abortable');
  });

  test(`fetchSleeper ${name} reports 404 as a missing resource, not a crash`, async () => {
    const r = await call(null, { fetch: async () => fakeResponse({ status: 404, body: '' }) });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_found');
    assert.equal(r.status, 404);
  });

  test(`fetchSleeper ${name} treats a literal null body as missing`, async () => {
    const r = await call(null, { fetch: async () => fakeResponse({ status: 200, body: 'null' }) });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_found');
  });

  test(`fetchSleeper ${name} aborts a hung fetch on the timeout`, async () => {
    const hanging = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
    const started = Date.now();
    const r = await call(null, { fetch: hanging, timeoutMs: 20 });
    assert.equal(r.error.code, 'timeout');
    assert.ok(Date.now() - started < 2000);
  });

  test(`fetchSleeper ${name} never reaches the network with a bad league id`, async () => {
    const fetchImpl = recordingFetch(fakeResponse({ body: '[]' }));
    const bad = name === 'rosters' ? fetchSleeperRosters('nope', { fetch: fetchImpl })
      : (name === 'users' ? fetchSleeperUsers('nope', { fetch: fetchImpl })
        : fetchSleeperMatchups('nope', 1, { fetch: fetchImpl }));
    const r = await bad;
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_league_id');
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a roster failure talks about roster JSON, not league JSON', async () => {
  const r = await fetchSleeperRosters(LEAGUE_ID, {
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.equal(r.error.code, 'network');
  assert.match(r.error.message, /paste the roster JSON/);
  assert.equal(/paste the league JSON/.test(r.error.message), false);
});

test('a bad week never reaches the network', async () => {
  const fetchImpl = recordingFetch(fakeResponse({ body: '[]' }));
  const r = await fetchSleeperMatchups(LEAGUE_ID, 0, { fetch: fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_week');
  assert.equal(r.url, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('the league read still reports 404 exactly as it always did', async () => {
  // The three new endpoints share the league read's fetch core; this is the
  // lock that sharing it did not reword the league's own errors.
  const r = await fetchSleeperLeague(LEAGUE_ID, {
    fetch: async () => fakeResponse({ status: 404, body: '' }),
  });
  assert.equal(r.error.message, `Sleeper has no league ${LEAGUE_ID}. Check the id in your league URL.`);
  assert.equal(r.error.detail, LEAGUE_ID);
});

/* ==========================================================================
 * 15. mapRosters
 * ======================================================================== */

test('mapRosters reads all 12 teams', () => {
  const r = mapRosters(rostersFixture());
  assert.equal(r.ok, true);
  assert.equal(r.rosters.length, 12);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.rosters.map((x) => x.roster_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('mapRosters keeps player ids as STRINGS — an 18-digit id is not a number', () => {
  const r = mapRosters(rostersFixture());
  r.rosters.forEach((roster) => {
    roster.players.forEach((p) => assert.equal(typeof p, 'string'));
    roster.starters.forEach((p) => assert.equal(typeof p, 'string'));
  });
});

test('mapRosters turns Sleeper nulls into absence, never into a claim', () => {
  const r = mapRosters(rostersFixture());
  assert.deepEqual(r.rosters[0].taxi, []);
  assert.deepEqual(r.rosters[0].keepers, []);
  assert.deepEqual(r.rosters[0].co_owner_ids, []);
  assert.equal(r.rosters[3].owner_id, null);
});

test('mapRosters reads the record and rebuilds Sleeper split-decimal points', () => {
  const r = mapRosters(rostersFixture());
  const first = r.rosters[0];
  assert.equal(first.record.wins, 9);
  assert.equal(first.record.losses, 0);
  assert.equal(first.record.streak, '1W');
  assert.equal(first.points_for, 1180.08);
  assert.equal(first.points_against, 1150.42);
  assert.deepEqual(first.points_raw,
    { fpts: 1180, fpts_decimal: 8, fpts_against: 1150, fpts_against_decimal: 42 });
});

test('mapRosters counts empty starting slots instead of pretending "0" is a player', () => {
  const r = mapRosters([{ roster_id: 1, starters: ['1000', '0', '0'], players: ['1000'] }]);
  assert.equal(r.rosters[0].empty_starter_slots, 2);
  assert.deepEqual(r.rosters[0].starters, ['1000', '0', '0'],
    'slot order must survive — the UI lines these up with roster_positions');
});

test('mapRosters reports a roster it cannot identify rather than renumbering it', () => {
  const r = mapRosters([{ roster_id: 1, players: [] }, { players: [] }, 'nope']);
  assert.equal(r.rosters.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.match(r.invalid[0].reason, /No roster_id/);
  assert.match(r.invalid[1].reason, /Not an object/);
});

test('mapRosters reports a player id it cannot use rather than dropping it silently', () => {
  const r = mapRosters([{ roster_id: 1, players: ['1000', null, {}, 4034], starters: [] }]);
  assert.deepEqual(r.rosters[0].players, ['1000', '4034']);
  assert.deepEqual(r.rosters[0].dropped_ids.map((d) => d.index), [1, 2]);
});

test('mapRosters on a non-array is an error, not a throw', () => {
  [null, undefined, 'x', 3, {}].forEach((v) => {
    const r = mapRosters(v);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_rosters');
    assert.deepEqual(r.rosters, []);
  });
});

test('mapRosters on an empty array says so', () => {
  const r = mapRosters([]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_rosters');
});

/* ==========================================================================
 * 16. mapLeagueUsers
 * ======================================================================== */

test('mapLeagueUsers reads every manager and their team name', () => {
  const r = mapLeagueUsers(usersFixture());
  assert.equal(r.ok, true);
  assert.equal(r.users.length, 13);
  assert.equal(r.users[0].display_name, 'manager01');
  assert.equal(r.users[0].team_name, 'Brady Bunch');
  assert.equal(r.users[0].is_owner, true);
  assert.equal(r.users[0].is_bot, false);
});

test('a manager who never named their team gets null, not a made-up name', () => {
  const r = mapLeagueUsers(usersFixture());
  const former = r.users.find((u) => u.display_name === 'formermanager');
  assert.equal(former.team_name, null);
});

test('mapLeagueUsers reports a user it cannot key', () => {
  const r = mapLeagueUsers([{ user_id: '1', display_name: 'a' }, { display_name: 'b' }, 7]);
  assert.equal(r.users.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.match(r.invalid[0].reason, /No user_id/);
});

test('mapLeagueUsers on a non-array is an error, not a throw', () => {
  [null, undefined, 'x', 3, {}].forEach((v) => {
    const r = mapLeagueUsers(v);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_users');
  });
});

/* ==========================================================================
 * 17. joinRosters — identifying whose team is whose
 * ======================================================================== */

test('joinRosters labels every team with something a human can point at', () => {
  const joined = joinedTeams();
  assert.equal(joined.teams.length, 12);
  assert.deepEqual(joined.teams.map((t) => t.roster_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(joined.teams[0].label, 'Brady Bunch');
  assert.equal(joined.teams[0].display_name, 'manager01');
  assert.equal(joined.teams[0].owner_known, true);
});

test('an unmatched roster keeps its number and is REPORTED, never given a name', () => {
  const joined = joinedTeams();
  const open = joined.teams.find((t) => t.roster_id === 4);
  const missing = joined.teams.find((t) => t.roster_id === 12);
  assert.equal(open.label, 'Roster 4');
  assert.equal(open.owner_known, false);
  assert.equal(missing.label, 'Roster 12');
  assert.equal(missing.owner_known, false);
  assert.deepEqual(joined.orphan_rosters.map((o) => o.roster_id), [4, 12]);
  assert.match(joined.orphan_rosters[0].reason, /no manager/);
  assert.match(joined.orphan_rosters[1].reason, /not in the league user list/);
});

test('a manager with no roster is reported too — the join loses nobody', () => {
  const joined = joinedTeams();
  assert.deepEqual(joined.users_without_roster.map((u) => u.display_name),
    ['manager04', 'manager12', 'formermanager']);
});

test('joinRosters carries the roster contents through untouched', () => {
  const joined = joinedTeams();
  const raw = rostersFixture()[0];
  assert.deepEqual(joined.teams[0].players, raw.players);
  assert.deepEqual(joined.teams[0].starters, raw.starters);
  assert.deepEqual(joined.teams[0].reserve, raw.reserve);
});

test('joinRosters is total', () => {
  [null, undefined, 'x', 3, {}].forEach((v) => {
    const r = joinRosters(v, v);
    assert.deepEqual(r.teams, []);
    assert.deepEqual(r.orphan_rosters, []);
    assert.deepEqual(r.users_without_roster, []);
  });
});

test('ownerChoices is the picker the UI must show', () => {
  const choices = ownerChoices(joinedTeams().teams);
  assert.equal(choices.length, 12);
  assert.deepEqual(choices[0], {
    roster_id: 1,
    label: 'Brady Bunch',
    display_name: 'manager01',
    team_name: 'Brady Bunch',
    owner_known: true,
  });
  assert.equal(ownerChoices(null).length, 0);
});

test('findTeam matches a team name, a handle or a roster number EXACTLY', () => {
  const { teams } = joinedTeams();
  assert.equal(findTeam(teams, 'Brady Bunch').team.roster_id, 1);
  assert.equal(findTeam(teams, '  brady bunch ').team.roster_id, 1);
  assert.equal(findTeam(teams, 'manager02').team.roster_id, 2);
  assert.equal(findTeam(teams, '7').team.roster_id, 7);
});

test('findTeam refuses a near miss instead of picking the closest team', () => {
  const { teams } = joinedTeams();
  const r = findTeam(teams, 'Brady');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_match');
  assert.equal(r.team, null);
  assert.ok(r.error.detail.includes('Brady Bunch'), 'the choices are offered instead');
});

test('findTeam refuses an ambiguous name rather than flipping a coin', () => {
  const teams = [
    { roster_id: 1, label: 'Twins', display_name: 'Twins', team_name: 'Twins', owner_known: true },
    { roster_id: 2, label: 'Twins', display_name: 'other', team_name: 'Twins', owner_known: true },
  ];
  const r = findTeam(teams, 'twins');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous');
  assert.equal(r.matches.length, 2);
  assert.equal(r.team, null);
});

test('findTeam is total', () => {
  [null, undefined, 3, {}, []].forEach((v) => {
    const r = findTeam(v, v);
    assert.equal(r.ok, false);
    assert.ok(r.error.code);
  });
});

/* ==========================================================================
 * 18. mapMatchups — the starters actually played
 * ======================================================================== */

test('mapMatchups reads one line per team and echoes the week', () => {
  const r = mapMatchups(matchupsFixture(), 1);
  assert.equal(r.ok, true);
  assert.equal(r.week, 1);
  assert.equal(r.matchups.length, 12);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.warnings, []);
});

test('starter points are paired POSITIONALLY with the slot-ordered starters', () => {
  const raw = matchupsFixture();
  const r = mapMatchups(raw, 1);
  const line = r.matchups[0];
  assert.equal(line.starter_rows.length, raw[0].starters.length);
  line.starter_rows.forEach((row, i) => {
    assert.equal(row.slot, i);
    assert.equal(row.sleeper_id, raw[0].starters[i]);
    assert.equal(row.points, raw[0].starters_points[i]);
    assert.equal(row.empty, false);
  });
});

test('a length mismatch is reported and NOTHING is shifted onto the wrong player', () => {
  const r = mapMatchups([{
    roster_id: 1, matchup_id: 1, starters: ['a', 'b', 'c'], starters_points: [1, 2], players: [],
  }], 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'starters_points_length');
  const rows = r.matchups[0].starter_rows;
  assert.deepEqual(rows.map((x) => [x.sleeper_id, x.points]), [['a', 1], ['b', 2], ['c', null]]);
});

test('an empty starting slot is marked empty, never scored as a player', () => {
  const r = mapMatchups([{
    roster_id: 1, starters: ['1000', SLEEPER_EMPTY_SLOT], starters_points: [12.4, 0], players: [],
  }], 1);
  assert.equal(r.matchups[0].starter_rows[1].empty, true);
  assert.equal(r.matchups[0].starter_rows[0].empty, false);
  assert.equal(SLEEPER_EMPTY_SLOT, '0');
});

test('players_points keeps only numbers, and keys stay strings', () => {
  const r = mapMatchups([{
    roster_id: 1, starters: [], players: ['1000'], players_points: { 1000: 12.4, bad: null, x: 'y' },
  }], 1);
  assert.deepEqual(r.matchups[0].players_points, { 1000: 12.4 });
});

test('matchupForRoster finds one team\'s line', () => {
  const r = mapMatchups(matchupsFixture(), 1);
  assert.equal(matchupForRoster(r.matchups, 7).roster_id, 7);
  assert.equal(matchupForRoster(r.matchups, 99), null);
  assert.equal(matchupForRoster(r.matchups, 'x'), null);
  assert.equal(matchupForRoster(null, 1), null);
});

test('matchupPairs groups the week head-to-head', () => {
  const pairs = matchupPairs(mapMatchups(matchupsFixture(), 1).matchups);
  assert.equal(pairs.length, 6);
  pairs.forEach((p) => {
    assert.equal(p.kind, 'head_to_head');
    assert.equal(p.roster_ids.length, 2);
  });
});

test('a bye, an unscheduled team and an impossible group are named, not hidden', () => {
  const pairs = matchupPairs([
    { roster_id: 1, matchup_id: 1, points: 1 },
    { roster_id: 2, matchup_id: 2, points: 2 },
    { roster_id: 3, matchup_id: 3, points: 3 },
    { roster_id: 4, matchup_id: 3, points: 4 },
    { roster_id: 5, matchup_id: 3, points: 5 },
    { roster_id: 6, matchup_id: null, points: 6 },
  ]);
  const kinds = {};
  pairs.forEach((p) => { kinds[p.kind] = (kinds[p.kind] || 0) + 1; });
  assert.deepEqual(kinds, { bye: 2, unexpected: 1, unscheduled: 1 });
  assert.equal(pairs[pairs.length - 1].matchup_id, null, 'the unscheduled group sorts last');
});

test('mapMatchups on a non-array is an error; on [] it says the week is unplayed', () => {
  [null, undefined, 'x', 3, {}].forEach((v) => {
    assert.equal(mapMatchups(v, 1).error.code, 'not_matchups');
  });
  const empty = mapMatchups([], 1);
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'no_matchups');
  assert.match(empty.error.message, /has not been played/);
});

test('mapMatchups reports a bad week as a null week rather than inventing one', () => {
  assert.equal(mapMatchups(matchupsFixture(), 99).week, null);
  assert.equal(mapMatchups(matchupsFixture(), 99).ok, true, 'the payload is still readable');
});

/* ==========================================================================
 * 19. Player crosswalk — vocabulary
 * ======================================================================== */

test('normalizePlayerName reduces a name to what two sources can agree on', () => {
  assert.equal(normalizePlayerName('Amon-Ra St. Brown'), 'amon ra st brown');
  assert.equal(normalizePlayerName("Ka'imi Fairbairn"), 'kaimi fairbairn');
  assert.equal(normalizePlayerName('Ka’imi Fairbairn'), 'kaimi fairbairn');
  assert.equal(normalizePlayerName('Kenneth Walker III'), 'kenneth walker');
  assert.equal(normalizePlayerName('Odell Beckham Jr.'), 'odell beckham');
  assert.equal(normalizePlayerName('  Josh   Allen  '), 'josh allen');
  assert.equal(normalizePlayerName('José Ramírez'), 'jose ramirez');
});

test('normalizePlayerName never reduces a name to nothing but a suffix', () => {
  assert.equal(normalizePlayerName('Jr'), 'jr');
  assert.equal(normalizePlayerName(''), '');
  [null, undefined, 3, {}, []].forEach((v) => assert.equal(typeof normalizePlayerName(v), 'string'));
});

test('every team alias points at a real app team and is not already one', () => {
  Object.keys(SLEEPER_TEAM_ALIASES).forEach((from) => {
    assert.equal(from in TEAMS, false, `${from} is already an app team abbreviation`);
    assert.ok(TEAMS[SLEEPER_TEAM_ALIASES[from]], `${from} points at a team that does not exist`);
  });
});

test('CROSSWALK_METHODS and CROSSWALK_CODES are frozen and exhaustive', () => {
  assert.ok(Object.isFrozen(CROSSWALK_METHODS));
  assert.ok(Object.isFrozen(CROSSWALK_CODES));
  const index = buildSleeperPlayerIndex(playersDump());
  const league = joinedTeams();
  league.teams.forEach((t) => {
    const cw = crosswalkRoster(t, appPlayers(), { index: index.index });
    cw.players.resolved.forEach((r) => assert.ok(CROSSWALK_METHODS.includes(r.method), r.method));
    cw.unresolved.forEach((u) => assert.ok(CROSSWALK_CODES.includes(u.code), u.code));
  });
});

test('unsupported player positions are stated as reasons, not as codes', () => {
  Object.keys(UNSUPPORTED_PLAYER_POSITIONS).forEach((pos) => {
    assert.equal(typeof UNSUPPORTED_PLAYER_POSITIONS[pos], 'string');
    assert.ok(UNSUPPORTED_PLAYER_POSITIONS[pos].length > 3);
  });
  assert.ok(Object.isFrozen(UNSUPPORTED_PLAYER_POSITIONS));
});

/* ==========================================================================
 * 20. buildSleeperPlayerIndex
 * ======================================================================== */

test('buildSleeperPlayerIndex reads the whole dump', () => {
  const r = buildSleeperPlayerIndex(playersDump());
  assert.equal(r.ok, true);
  assert.equal(r.count, 229);
  assert.deepEqual(r.skipped, []);
});

test('the index normalises the fields the crosswalk depends on', () => {
  const { index } = buildSleeperPlayerIndex(playersDump());
  const def = index.get('DEN');
  assert.equal(def.position, 'DEF');
  assert.equal(def.team, 'DEN');
  const idp = index.get('4035');
  assert.equal(idp.name, 'Josh Sweat');
  assert.equal(idp.position, 'DE');
  const withEspn = [...index.values()].find((v) => v.espn_id);
  assert.equal(typeof withEspn.espn_id, 'string', 'espn_id is compared as a string');
});

test('the index reports entries it cannot use instead of dropping them', () => {
  const r = buildSleeperPlayerIndex({ 1: { player_id: '1', position: 'QB' }, 2: 'nope', 3: null });
  assert.equal(r.count, 1);
  assert.deepEqual(r.skipped.map((s) => s.key), ['2', '3']);
});

test('buildSleeperPlayerIndex on a non-object is an error, not a throw', () => {
  [null, undefined, 'x', 3, []].forEach((v) => {
    const r = buildSleeperPlayerIndex(v);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_a_player_dump');
    assert.equal(r.index.size, 0);
  });
});

/* ==========================================================================
 * 21. crosswalkPlayerIds — resolved and unresolved, never a guess
 * ======================================================================== */

const INDEX = buildSleeperPlayerIndex(PLAYERS_DUMP).index;

test('the crosswalk accounts for EVERY input id — nothing is dropped', () => {
  const league = joinedTeams();
  let input = 0;
  let resolved = 0;
  let unresolved = 0;
  league.teams.forEach((t) => {
    const cw = crosswalkPlayerIds(t.players, appPlayers(), { index: INDEX });
    assert.equal(cw.counts.input, cw.counts.resolved + cw.counts.unresolved);
    input += cw.counts.input;
    resolved += cw.counts.resolved;
    unresolved += cw.counts.unresolved;
  });
  assert.equal(input, 216);
  assert.equal(resolved, 202);
  assert.equal(unresolved, 14);
});

test('roster 1 resolves through all four id paths the fixture exercises', () => {
  const team = joinedTeams().teams[0];
  const cw = crosswalkPlayerIds(team.starters, appPlayers(), { index: INDEX });
  assert.equal(cw.counts.input, 12);
  assert.deepEqual(cw.counts.by_method,
    { espn_id: 7, name_team_position: 2, gsis_id: 1, team_def: 1 });
  assert.deepEqual(cw.counts.by_code, { unsupported_position: 1 });
});

test('a resolved row names a player this app really has, with that app id', () => {
  const rows = appPlayers();
  const byId = new Map(rows.map((r) => [r.gsis_id || r.player_id, r]));
  const team = joinedTeams().teams[0];
  const cw = crosswalkPlayerIds(team.players, rows, { index: INDEX });
  cw.resolved.forEach((r) => {
    const app = byId.get(r.player_id);
    assert.ok(app, `${r.player_id} is not an app player`);
    // A team defence is matched by ABBREVIATION, and the two sources spell the
    // unit differently ("Denver Broncos" vs "Denver Broncos Defense"), so the
    // name equality check applies to the player paths only.
    if (r.method === 'team_def') {
      assert.equal(app.team, r.team);
      return;
    }
    assert.equal(normalizePlayerName(app.name), normalizePlayerName(r.sleeper_name));
  });
});

test('espn_id is the strongest path: Sleeper espn_id -> this app\'s espn-<id>', () => {
  const cw = crosswalkPlayerIds(['1000'], appPlayers(), { index: INDEX });
  assert.equal(cw.resolved[0].method, 'espn_id');
  assert.equal(cw.resolved[0].player_id, 'espn-3918298');
  assert.equal(cw.resolved[0].name, 'Josh Allen');
});

test('a kicker resolves on gsis_id, which IS this app\'s kicker id', () => {
  const cw = crosswalkPlayerIds(['1063'], appPlayers(), { index: INDEX });
  assert.equal(cw.resolved[0].method, 'gsis_id');
  assert.equal(cw.resolved[0].player_id, '00-0032726');
});

test('a team defence resolves from the bare abbreviation, with no player list at all', () => {
  const withIndex = crosswalkPlayerIds(['DEN'], appPlayers(), { index: INDEX });
  const without = crosswalkPlayerIds(['DEN'], appPlayers(), {});
  assert.equal(withIndex.resolved[0].player_id, 'DST-DEN');
  assert.equal(without.resolved[0].player_id, 'DST-DEN');
  assert.equal(without.resolved[0].method, 'team_def');
});

test('a historical team abbreviation is a rename, not a guess', () => {
  const app = [{ player_id: 'DST-LV', name: 'Raiders Defense', team: 'LV', position: 'DEF' }];
  const cw = crosswalkPlayerIds(['OAK'], app, {});
  assert.equal(cw.resolved[0].player_id, 'DST-LV');
  assert.equal(cw.resolved[0].method, 'team_def');
});

test('a dump entry with no espn_id still resolves on name + team + position', () => {
  const cw = crosswalkPlayerIds(['1021'], appPlayers(), { index: INDEX });
  assert.equal(cw.resolved[0].method, 'name_team_position');
  assert.equal(cw.resolved[0].player_id, 'espn-4426515');
  assert.equal(INDEX.get('1021').espn_id, null, 'this one has no id to match on');
});

test('a player who changed team resolves on name + position, when it is unique', () => {
  const app = [{ gsis_id: 'espn-1', name: 'Sam Darnold', team: 'MIN', position: 'QB' }];
  const index = buildSleeperPlayerIndex({
    99: { player_id: '99', full_name: 'Sam Darnold', position: 'QB', team: 'SEA' },
  }).index;
  const cw = crosswalkPlayerIds(['99'], app, { index });
  assert.equal(cw.resolved[0].method, 'name_position');
  assert.equal(cw.resolved[0].player_id, 'espn-1');
  assert.equal(cw.resolved[0].team, 'MIN', 'the APP row wins — it is what the app will project');
});

test('two players with one name are AMBIGUOUS and neither is picked', () => {
  const app = [
    { gsis_id: 'espn-1', name: 'John Smith', team: 'SF', position: 'WR' },
    { gsis_id: 'espn-2', name: 'John Smith', team: 'KC', position: 'WR' },
  ];
  const index = buildSleeperPlayerIndex({
    99: { player_id: '99', full_name: 'John Smith', position: 'WR', team: 'DEN' },
  }).index;
  const cw = crosswalkPlayerIds(['99'], app, { index });
  assert.equal(cw.resolved.length, 0);
  assert.equal(cw.unresolved[0].code, 'ambiguous');
  assert.deepEqual(cw.unresolved[0].candidates, ['espn-1', 'espn-2']);
  assert.match(cw.unresolved[0].message, /Nothing was matched/);
});

test('two players with one name on the SAME team are ambiguous too', () => {
  const app = [
    { gsis_id: 'espn-1', name: 'John Smith', team: 'SF', position: 'WR' },
    { gsis_id: 'espn-2', name: 'John Smith', team: 'SF', position: 'WR' },
  ];
  const index = buildSleeperPlayerIndex({
    99: { player_id: '99', full_name: 'John Smith', position: 'WR', team: 'SF' },
  }).index;
  const cw = crosswalkPlayerIds(['99'], app, { index });
  assert.equal(cw.unresolved[0].code, 'ambiguous');
  assert.equal(cw.unresolved[0].candidates.length, 2);
});

test('a suffix collision costs a report, never a wrong player', () => {
  // "Odell Beckham Jr." and "Odell Beckham" normalise to the same key on
  // purpose; two app rows sharing it must therefore refuse to match.
  const app = [
    { gsis_id: 'espn-1', name: 'Odell Beckham Jr.', team: 'BAL', position: 'WR' },
    { gsis_id: 'espn-2', name: 'Odell Beckham', team: 'BAL', position: 'WR' },
  ];
  const index = buildSleeperPlayerIndex({
    99: { player_id: '99', full_name: 'Odell Beckham', position: 'WR', team: 'BAL' },
  }).index;
  assert.equal(crosswalkPlayerIds(['99'], app, { index }).unresolved[0].code, 'ambiguous');
});

test('an individual defender is unresolvable and says exactly why', () => {
  const cw = crosswalkPlayerIds(['4035'], appPlayers(), { index: INDEX });
  assert.equal(cw.resolved.length, 0);
  assert.equal(cw.unresolved[0].code, 'unsupported_position');
  assert.equal(cw.unresolved[0].sleeper_name, 'Josh Sweat');
  assert.match(cw.unresolved[0].message, /projects offence and team defence only/);
});

test('a real player this app has no projection for is reported, not dropped', () => {
  const cw = crosswalkPlayerIds(['4042'], appPlayers(), { index: INDEX });
  assert.equal(cw.unresolved[0].code, 'no_app_match');
  assert.equal(cw.unresolved[0].sleeper_name, 'Carson Beck');
  assert.match(cw.unresolved[0].message, /no projection can be shown/);
});

test('an id the player list has never heard of is reported as exactly that', () => {
  const cw = crosswalkPlayerIds(['9999999'], appPlayers(), { index: INDEX });
  assert.equal(cw.unresolved[0].code, 'unknown_sleeper_id');
  assert.match(cw.unresolved[0].message, /older than the roster/);
});

test('with NO player list nothing but a team defence resolves, and it says why', () => {
  const team = joinedTeams().teams[0];
  const cw = crosswalkPlayerIds(team.starters, appPlayers(), {});
  assert.equal(cw.counts.resolved, 1);
  assert.deepEqual(cw.counts.by_method, { team_def: 1 });
  assert.equal(cw.counts.by_code.no_player_index, 11);
  assert.match(cw.unresolved[0].message, /players\/nfl/);
});

test('the crosswalk takes a raw dump as readily as a built index', () => {
  const fromDump = crosswalkPlayerIds(['1000'], appPlayers(), { index: playersDump() });
  const fromIndex = crosswalkPlayerIds(['1000'], appPlayers(), { index: INDEX });
  assert.deepEqual(fromDump.resolved, fromIndex.resolved);
});

test('an empty starting slot is not a failed match — it is an empty slot', () => {
  const cw = crosswalkPlayerIds(['0'], appPlayers(), { index: INDEX });
  assert.equal(cw.unresolved[0].code, 'empty_slot');
  assert.match(cw.unresolved[0].message, /started nobody/);
});

test('a junk id is reported, never looked up', () => {
  const cw = crosswalkPlayerIds([null, '', '   ', {}, []], appPlayers(), { index: INDEX });
  assert.equal(cw.counts.input, 5);
  assert.equal(cw.counts.by_code.bad_id, 5);
});

test('crosswalkPlayerIds is total', () => {
  [null, undefined, 'x', 3, {}].forEach((v) => {
    const cw = crosswalkPlayerIds(v, v, v);
    assert.deepEqual(cw.resolved, []);
    assert.deepEqual(cw.unresolved, []);
    assert.equal(cw.counts.input, 0);
  });
});

test('the crosswalk never reads a Sleeper id as a number', () => {
  // 917214231462133760 does not survive float64; a crosswalk that stringified a
  // parsed number would resolve a DIFFERENT player.
  const index = buildSleeperPlayerIndex({
    917214231462133760: {
      player_id: '917214231462133760', full_name: 'A B', position: 'WR', team: 'SF',
    },
  }).index;
  assert.ok(index.has('917214231462133760'));
  const cw = crosswalkPlayerIds(['917214231462133760'],
    [{ gsis_id: 'espn-9', name: 'A B', team: 'SF', position: 'WR' }], { index });
  assert.equal(cw.resolved[0].sleeper_id, '917214231462133760');
});

/* ==========================================================================
 * 22. crosswalkRoster
 * ======================================================================== */

test('crosswalkRoster splits starters, bench and reserve and merges the misses', () => {
  const team = joinedTeams().teams[0];
  const cw = crosswalkRoster(team, appPlayers(), { index: INDEX });
  assert.equal(cw.roster_id, 1);
  assert.equal(cw.label, 'Brady Bunch');
  assert.equal(cw.starters.counts.input, 12);
  assert.equal(cw.players.counts.input, 18);
  assert.equal(cw.reserve.counts.input, 1);
  assert.equal(cw.fully_resolved, false);
  assert.deepEqual(cw.unresolved.map((u) => u.code),
    ['unsupported_position', 'unknown_sleeper_id', 'no_app_match']);
});

test('crosswalkRoster de-duplicates the misses a starter and the roster share', () => {
  const team = joinedTeams().teams[0];
  const cw = crosswalkRoster(team, appPlayers(), { index: INDEX });
  const ids = cw.unresolved.map((u) => `${u.code}|${u.sleeper_id}`);
  assert.equal(new Set(ids).size, ids.length);
});

test('a fully understood roster says so', () => {
  const team = { roster_id: 9, label: 'x', starters: ['DEN'], players: ['DEN'], reserve: [] };
  const cw = crosswalkRoster(team, appPlayers(), {});
  assert.equal(cw.fully_resolved, true);
  assert.deepEqual(cw.unresolved, []);
});

test('crosswalkRoster is total', () => {
  [null, undefined, 'x', 3, []].forEach((v) => {
    const cw = crosswalkRoster(v, appPlayers(), {});
    assert.equal(cw.starters.counts.input, 0);
    assert.deepEqual(cw.unresolved, []);
  });
});

/* ==========================================================================
 * 23. importSleeperTeams — one manual sync, two reads
 * ======================================================================== */

/** Routes an injected fetch by URL suffix. Still zero network. */
function routingFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error(`unrouted ${url}`);
    return routes[key];
  };
  fn.calls = calls;
  return fn;
}

test('importSleeperTeams reads rosters then users and joins them', async () => {
  const fetchImpl = routingFetch({
    '/rosters': fakeResponse({ body: JSON.stringify(ROSTERS_RAW) }),
    '/users': fakeResponse({ body: JSON.stringify(USERS_RAW) }),
  });
  const r = await importSleeperTeams(LEAGUE_ID, { fetch: fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.teams.length, 12);
  assert.equal(r.teams[0].label, 'Brady Bunch');
  assert.equal(r.orphan_rosters.length, 2);
  assert.equal(r.users_without_roster.length, 3);
  assert.equal(fetchImpl.calls.length, 2, 'exactly two GETs per manual sync');
});

test('importSleeperTeams still returns teams when the manager read fails', async () => {
  const fetchImpl = routingFetch({
    '/rosters': fakeResponse({ body: JSON.stringify(ROSTERS_RAW) }),
    '/users': fakeResponse({ status: 500, body: '' }),
  });
  const r = await importSleeperTeams(LEAGUE_ID, { fetch: fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.teams.length, 12);
  assert.equal(r.teams[0].label, 'Roster 1', 'unnamed rather than wrongly named');
  assert.equal(r.users_error.code, 'http_error');
  assert.equal(r.orphan_rosters.length, 12);
});

test('importSleeperTeams fails when the rosters cannot be read', async () => {
  const r = await importSleeperTeams(LEAGUE_ID, {
    fetch: async () => fakeResponse({ status: 404, body: '' }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.teams, []);
  assert.equal(r.error.code, 'not_found');
});

test('importSleeperTeams never reaches the network with a bad id', async () => {
  const fetchImpl = routingFetch({});
  const r = await importSleeperTeams('nope', { fetch: fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_league_id');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a position the caller\'s player set does not cover is its own report', () => {
  // data/player_projections.json is offence-only. Crosswalking a kicker against
  // it alone must not say "unsupported" — the app models kickers, the pool just
  // has none. The fix is to pass the kicker rows in, and the message says so.
  const offenceOnly = appPlayers().filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.position));
  const cw = crosswalkPlayerIds(['1063'], offenceOnly, { index: INDEX });
  assert.equal(cw.unresolved[0].code, 'position_not_projected');
  // The message carries BOTH facts, because a reader needs both: this player is
  // not in the set, AND the reason is that no K is in the set at all.
  assert.match(cw.unresolved[0].message, /not in this app's player set/);
  assert.match(cw.unresolved[0].message, /K is not a position this app projects/);
  // With the kicker rows present the same id resolves, which is the proof that
  // the message named the real cause.
  assert.equal(crosswalkPlayerIds(['1063'], appPlayers(), { index: INDEX }).resolved.length, 1);
});

test('a missing player and a missing POSITION are never the same report', () => {
  const rows = appPlayers();
  const beck = crosswalkPlayerIds(['4042'], rows, { index: INDEX });
  assert.equal(beck.unresolved[0].code, 'no_app_match', 'the pool has QBs; this QB is not in it');
  const idp = crosswalkPlayerIds(['4035'], rows, { index: INDEX });
  assert.equal(idp.unresolved[0].code, 'unsupported_position', 'this one can never be modelled');
});
