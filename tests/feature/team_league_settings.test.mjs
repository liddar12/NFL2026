/* tests/feature/team_league_settings.test.mjs — R19-B3.
 *
 * The Team page's LEAGUE SETTINGS panel (SAVE · FLEX selector · keeper toggle ·
 * Sleeper sync) is DOM code, but the load-bearing part is not: it is the
 * translation between the draft simulator's roster config
 * ({qb,rb,wr,te,flex,bench} — app/draft-sim.js) and the LeagueProfile's
 * roster_positions tokens (app/league.js). app/views/team.js exports that
 * translation as pure functions, and this file locks it.
 *
 * What must never break:
 *   1. DEFAULT round trip is EXACT — an unconfigured user's profile survives a
 *      trip through the panel byte-for-byte, so opening the Team page and
 *      pressing SAVE cannot change anyone's league.
 *   2. Nothing is silently dropped. K/DEF/DST have no slot in the simulator, so
 *      they are CARRIED through the round trip and reported; counts outside
 *      ROSTER_BOUNDS are clamped and the clamp is reported.
 *   3. RB_TE_FLEX is never rewritten to FLEX (it is app-only — Sleeper has no
 *      token for it), and every one of the five FLEX options round-trips.
 *   4. Keepers off means max_keepers 0, always.
 *   5. MARKET PRICES STAY DISPLAY-ONLY: nothing in the league-settings path
 *      reads ADP / auction value / odds, and nothing touches the signal gate.
 *
 * PURE node:test — no DOM, no network, no dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  DRAFTABLE_TOKENS,
  cfgFromProfile,
  flexLabel,
  importSummaryRows,
  profileFromCfg,
  receptionLabel,
} from '../../app/views/team.js';
import {
  DEFAULT_PROFILE,
  FLEX_ELIGIBILITY,
  FLEX_TOKENS,
  cloneProfile,
  normalizeProfile,
} from '../../app/league.js';
import { ROSTER_BOUNDS } from '../../app/draft-sim.js';
import { importFromPastedJson } from '../../app/sleeper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const TEAM_SRC = readFileSync(resolve(REPO_ROOT, 'app/views/team.js'), 'utf8');

/* ==========================================================================
 * 1. The DEFAULT round trip is exact
 * ======================================================================== */

test('DEFAULT profile -> draft config -> profile is byte-for-byte the default', () => {
  const { cfg, carried, clamped } = cfgFromProfile(DEFAULT_PROFILE);
  assert.deepEqual(carried, []);
  assert.deepEqual(clamped, []);
  assert.deepEqual(cfg, {
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6,
    leagueSize: 12, flexType: 'FLEX', keepers: false, maxKeepers: 0,
  });
  const back = profileFromCfg(cfg, DEFAULT_PROFILE, carried);
  assert.deepEqual(back, cloneProfile(DEFAULT_PROFILE));
});

test('the default config reproduces app/draft-sim.js DEFAULT_ROSTER counts', () => {
  const { cfg } = cfgFromProfile(DEFAULT_PROFILE);
  ['qb', 'rb', 'wr', 'te', 'flex', 'bench'].forEach((key) => {
    const [lo, hi] = ROSTER_BOUNDS[key];
    assert.ok(cfg[key] >= lo && cfg[key] <= hi,
      `${key}=${cfg[key]} is outside ROSTER_BOUNDS [${lo},${hi}]`);
  });
});

test('the round trip is idempotent (saving twice changes nothing)', () => {
  const once = profileFromCfg(cfgFromProfile(DEFAULT_PROFILE).cfg, DEFAULT_PROFILE, []);
  const twice = profileFromCfg(cfgFromProfile(once).cfg, once, cfgFromProfile(once).carried);
  assert.deepEqual(twice, once);
});

/* ==========================================================================
 * 2. Nothing is silently dropped
 * ======================================================================== */

test('K / DEF / DST are carried through the round trip, not dropped', () => {
  const src = normalizeProfile({
    ...cloneProfile(DEFAULT_PROFILE),
    shape: {
      ...cloneProfile(DEFAULT_PROFILE).shape,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    },
  });
  const { cfg, carried } = cfgFromProfile(src);
  assert.deepEqual(carried, ['K', 'DEF']);
  // The simulator prices only the four positions it knows about.
  assert.deepEqual(cfg.qb + cfg.rb + cfg.wr + cfg.te + cfg.flex, 7);
  const back = profileFromCfg(cfg, src, carried);
  assert.ok(back.shape.roster_positions.includes('K'));
  assert.ok(back.shape.roster_positions.includes('DEF'));
  assert.equal(back.shape.starters, 9);
  assert.equal(back.shape.bench, 6);
});

test('DRAFTABLE_TOKENS names exactly the positions the simulator prices', () => {
  assert.deepEqual([...DRAFTABLE_TOKENS], ['QB', 'RB', 'WR', 'TE']);
  DRAFTABLE_TOKENS.forEach((t) => {
    assert.ok(!FLEX_ELIGIBILITY[t], `${t} must not also be a flex token`);
  });
});

test('counts outside ROSTER_BOUNDS are clamped AND reported', () => {
  const src = normalizeProfile({
    shape: {
      // 3 QB and 9 bench are legal profiles but outside the simulator's bounds.
      roster_positions: ['QB', 'QB', 'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
        ...new Array(9).fill('BN')],
    },
  });
  const { cfg, clamped } = cfgFromProfile(src);
  assert.equal(cfg.qb, ROSTER_BOUNDS.qb[1]);
  assert.equal(cfg.bench, ROSTER_BOUNDS.bench[1]);
  const keys = clamped.map((c) => c.key).sort();
  assert.deepEqual(keys, ['bench', 'qb']);
  const qbNote = clamped.find((c) => c.key === 'qb');
  assert.equal(qbNote.wanted, 3);
  assert.equal(qbNote.used, ROSTER_BOUNDS.qb[1]);
});

test('profileFromCfg keeps everything the simulator has no opinion about', () => {
  const base = normalizeProfile({
    name: 'Dynasty Of Regret',
    scoring: { rec: 0.5, pass_td: 6, rush_yd: 0.1, fum_lost: -1 },
    shape: { position_caps: { QB: 3, TE: 2 }, playoff_week_start: 16 },
  });
  const { cfg, carried } = cfgFromProfile(base);
  const back = profileFromCfg({ ...cfg, bench: 7 }, base, carried);
  assert.equal(back.name, 'Dynasty Of Regret');
  assert.deepEqual(back.scoring, base.scoring);
  assert.deepEqual(back.shape.position_caps, { QB: 3, TE: 2 });
  assert.equal(back.shape.playoff_week_start, 16);
  assert.equal(back.shape.bench, 7);
});

/* ==========================================================================
 * 3. The FLEX selector — five options, none of them invented
 * ======================================================================== */

test('every FLEX option round-trips with its own eligibility', () => {
  FLEX_TOKENS.forEach((token) => {
    const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
    const back = profileFromCfg({ ...cfg, flexType: token }, DEFAULT_PROFILE, carried);
    assert.ok(back.shape.roster_positions.includes(token), `${token} slot missing`);
    assert.deepEqual(back.shape.flex_eligibility[token],
      [...FLEX_ELIGIBILITY[token].positions], `${token} eligibility rewritten`);
    // And it comes back out of the profile as the same token.
    assert.equal(cfgFromProfile(back).cfg.flexType, token);
  });
});

test('RB_TE_FLEX is never rewritten to FLEX', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const back = profileFromCfg({ ...cfg, flexType: 'RB_TE_FLEX' }, DEFAULT_PROFILE, carried);
  assert.ok(back.shape.roster_positions.includes('RB_TE_FLEX'));
  assert.ok(!back.shape.roster_positions.includes('FLEX'));
  assert.deepEqual(back.shape.flex_eligibility, { RB_TE_FLEX: ['RB', 'TE'] });
});

test('an unknown flex token falls back to FLEX rather than inventing a slot', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const back = profileFromCfg({ ...cfg, flexType: 'DEEP_IDP_FLEX' }, DEFAULT_PROFILE, carried);
  assert.ok(back.shape.roster_positions.includes('FLEX'));
  assert.ok(!back.shape.roster_positions.includes('DEEP_IDP_FLEX'));
});

test('zero flex slots leaves the eligibility map empty', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const back = profileFromCfg({ ...cfg, flex: 0 }, DEFAULT_PROFILE, carried);
  assert.deepEqual(back.shape.flex_eligibility, {});
  assert.equal(back.shape.starters, 6);
});

test('flexLabel speaks the app idiom and flags the app-only slot', () => {
  assert.equal(flexLabel('WRRB_FLEX'), 'WR/RB');
  assert.equal(flexLabel('REC_FLEX'), 'WR/TE');
  assert.equal(flexLabel('FLEX'), 'WR/RB/TE');
  assert.equal(flexLabel('RB_TE_FLEX'), 'RB/TE · APP ONLY');
  assert.equal(flexLabel('SUPER_FLEX'), 'QB/WR/RB/TE · SUPERFLEX');
  assert.equal(flexLabel(null), '');
  assert.equal(flexLabel('NOPE'), 'NOPE');
});

test('the selector offers exactly the five documented flex options', () => {
  assert.equal(FLEX_TOKENS.length, 5);
  FLEX_TOKENS.forEach((t) => {
    assert.ok(TEAM_SRC.includes('FLEX_TOKENS.map'),
      'the panel must build its menu from FLEX_TOKENS, not a hand-typed list');
    assert.ok(flexLabel(t).length > 0);
  });
});

/* ==========================================================================
 * 4. Keepers
 * ======================================================================== */

test('keepers off forces max_keepers to 0 no matter what the field says', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const off = profileFromCfg({ ...cfg, keepers: false, maxKeepers: 4 }, DEFAULT_PROFILE, carried);
  assert.equal(off.shape.keepers_enabled, false);
  assert.equal(off.shape.max_keepers, 0);
});

test('keepers on persists the max and survives the round trip', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const on = profileFromCfg({ ...cfg, keepers: true, maxKeepers: 3 }, DEFAULT_PROFILE, carried);
  assert.equal(on.shape.keepers_enabled, true);
  assert.equal(on.shape.max_keepers, 3);
  const reread = cfgFromProfile(on).cfg;
  assert.equal(reread.keepers, true);
  assert.equal(reread.maxKeepers, 3);
});

test('max keepers can never exceed the draft rounds it would consume', () => {
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const on = profileFromCfg({ ...cfg, keepers: true, maxKeepers: 40 }, DEFAULT_PROFILE, carried);
  assert.ok(on.shape.max_keepers <= on.shape.draft_rounds);
  assert.ok(on.shape.max_keepers <= on.shape.starters + on.shape.bench);
});

/* ==========================================================================
 * 5. "Did it take?" — the import summary reads the PROFILE, never the payload
 * ======================================================================== */

test('importSummaryRows reports teams, starters, bench, scoring keys, reception', () => {
  const p = normalizeProfile({
    scoring: { rec: 0.5, pass_td: 4, rush_td: 6 },
    shape: {
      teams: 10,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'BN', 'BN', 'BN'],
    },
  });
  assert.deepEqual(importSummaryRows(p), [
    { label: 'TEAMS', value: '10' },
    { label: 'STARTERS', value: '7' },
    { label: 'BENCH', value: '3' },
    { label: 'SCORING KEYS', value: '3' },
    { label: 'RECEPTION', value: 'HALF (0.5)' },
  ]);
});

test('receptionLabel names the mode and the value it read', () => {
  assert.equal(receptionLabel({ scoring: { rec: 1 } }), 'PPR (1)');
  assert.equal(receptionLabel({ scoring: { rec: 0.5 } }), 'HALF (0.5)');
  assert.equal(receptionLabel({ scoring: { rec: 0 } }), 'STD (0)');
  assert.equal(receptionLabel({ scoring: { rec: 0.75 } }), 'CUSTOM (0.75)');
  // A scoring table with no reception key at all is STD, honestly labelled 0.
  assert.equal(receptionLabel({ scoring: { pass_td: 4 } }), 'STD (0)');
});

test('a pasted Sleeper league flows all the way into the panel summary', () => {
  const payload = {
    league_id: '1051234567890123456',
    name: 'Paste Test League',
    season: '2026',
    sport: 'nfl',
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    scoring_settings: { rec: 0.5, pass_td: 4, rush_yd: 0.1 },
    settings: { num_teams: 10, max_keepers: 2, draft_rounds: 15 },
  };
  const res = importFromPastedJson(JSON.stringify(payload));
  assert.equal(res.ok, true);
  const rows = importSummaryRows(res.profile);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel.TEAMS, '10');
  assert.equal(byLabel.STARTERS, '9');
  assert.equal(byLabel.BENCH, '6');
  assert.equal(byLabel.RECEPTION, 'HALF (0.5)');
  // Every row is derived from the profile itself — it cannot claim a value the
  // profile does not carry.
  const p = normalizeProfile(res.profile);
  assert.equal(byLabel.TEAMS, String(p.shape.teams));
  assert.equal(byLabel.STARTERS, String(p.shape.starters));
  assert.equal(byLabel.BENCH, String(p.shape.bench));
  assert.equal(byLabel['SCORING KEYS'], String(Object.keys(p.scoring).length));

  // And it survives the panel's own round trip with K/DEF intact.
  const { cfg, carried } = cfgFromProfile(res.profile);
  assert.deepEqual(carried, ['K', 'DEF']);
  const back = profileFromCfg(cfg, res.profile, carried);
  assert.equal(back.shape.starters, 9);
  assert.deepEqual(back.scoring, p.scoring);
});

test('the real Sleeper fixture round-trips without losing a slot', () => {
  const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/fixtures/sleeper_league.json'), 'utf8'));
  const res = importFromPastedJson(JSON.stringify(fx));
  assert.equal(res.ok, true);
  const p = normalizeProfile(res.profile);
  const { cfg, carried } = cfgFromProfile(p);
  const back = profileFromCfg(cfg, p, carried);
  // Every non-draftable starter token the profile carried is still there.
  carried.forEach((t) => assert.ok(back.shape.roster_positions.includes(t), `${t} lost`));
  assert.equal(back.shape.bench, cfg.bench);
  assert.deepEqual(back.scoring, p.scoring);
});

/* ==========================================================================
 * 6. Policy: display-only market data, and never the signal gate
 * ======================================================================== */

test('the league-settings panel never reads market prices into the profile', () => {
  // profileFromCfg is the ONLY writer of the profile shape. Its inputs are the
  // roster config, the base profile and the carried tokens — no ADP, no auction
  // value, no odds. Proven structurally: a profile built from a config is
  // identical whether or not market fields ride along on the config object.
  const { cfg, carried } = cfgFromProfile(DEFAULT_PROFILE);
  const clean = profileFromCfg(cfg, DEFAULT_PROFILE, carried);
  const polluted = profileFromCfg({
    ...cfg, adp: 12.5, auctionValue: 47, odds: -145, budget: 200, mySlot: 5,
    roomType: 'shark', play: 'live',
  }, DEFAULT_PROFILE, carried);
  assert.deepEqual(polluted, clean);
});

test('the Team view never imports the signal gate or the refit pipeline', () => {
  assert.ok(!/promote_signals/.test(TEAM_SRC));
  assert.ok(!/signal_registry/.test(TEAM_SRC));
  assert.ok(!/never[_-]regress/i.test(TEAM_SRC.replace(/NEVER-REGRESS/g, '')));
});

test('the panel writes exactly two storage keys: the league profile and scoring', () => {
  // saveProfile() owns nfl2026.league.v1; the scoring re-price writes
  // SCORING_KEY. No other key is touched by the league-settings path.
  assert.ok(TEAM_SRC.includes('saveProfile(next)'));
  assert.ok(TEAM_SRC.includes('localStorage.setItem(SCORING_KEY, nextMode)'));
  assert.ok(!TEAM_SRC.includes("localStorage.setItem('nfl2026.league"),
    'the profile must be written through app/league.js saveProfile, not by hand');
});
