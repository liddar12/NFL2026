/* tests/feature/environment_model.test.mjs — data locks for data/environment_model.json
 * (Agent E, Build 4 contract).
 *
 * The MEASURED 2021-2025 environment history: venue HFA, cold-weather splits,
 * turf/grass splits, international designated-home bias. Locks (contract §2):
 *   - all 32 stadiums, surface in {grass, turf}, roof in {dome, open, retractable};
 *   - EVERY split carries its sample size n, and low_n === (n < 8) wherever the
 *     flag is present (a thin split is reported, but it must say so);
 *   - international: n >= 15 across the 5 seasons, designated_home_win_pct in
 *     [0, 1], each listed game internally consistent;
 *   - params are RECORDED, never applied (applied === false) — game probs are
 *     unchanged by this file existing.
 *
 * Node built-ins only (fast gate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const env = JSON.parse(
  readFileSync(new URL('../../data/environment_model.json', import.meta.url), 'utf8'),
);

const LOW_N = 8;
const SURFACES = new Set(['grass', 'turf']);
const ROOFS = new Set(['dome', 'open', 'retractable']);

/** Assert a split object carries a sane n and an honest low_n flag. */
function assertSplit(label, split) {
  assert.ok(split && typeof split === 'object', `${label}: split missing`);
  assert.ok(
    Number.isInteger(split.n) && split.n >= 0,
    `${label}: n must be a non-negative integer, got ${JSON.stringify(split.n)}`,
  );
  assert.equal(
    split.low_n,
    split.n < LOW_N,
    `${label}: low_n must be ${split.n < LOW_N} for n=${split.n}`,
  );
}

test('season_range [2021, 2025] and a real game sample', () => {
  assert.deepEqual(env.season_range, [2021, 2025]);
  // 5 seasons x ~272 games — anything materially short means a partial window.
  assert.ok(env.games_analyzed >= 1300, `games_analyzed ${env.games_analyzed} < 1300`);
});

test('all 32 stadiums with surface/roof enums and coordinates', () => {
  const abbrs = Object.keys(env.stadiums);
  assert.equal(abbrs.length, 32, `expected 32 stadiums, got ${abbrs.length}`);
  for (const [ab, st] of Object.entries(env.stadiums)) {
    assert.ok(SURFACES.has(st.surface), `${ab}: surface ${JSON.stringify(st.surface)}`);
    assert.ok(ROOFS.has(st.roof), `${ab}: roof ${JSON.stringify(st.roof)}`);
    assert.ok(Number.isFinite(st.lat) && Math.abs(st.lat) <= 90, `${ab}: lat`);
    assert.ok(Number.isFinite(st.lon) && Math.abs(st.lon) <= 180, `${ab}: lon`);
    assert.equal(typeof st.cold_region, 'boolean', `${ab}: cold_region must be boolean`);
  }
  // DEN altitude is the contract's named example of the optional field.
  assert.ok(
    Number.isFinite(env.stadiums.DEN.altitude_ft) && env.stadiums.DEN.altitude_ft > 5000,
    'DEN must carry its mile-high altitude_ft',
  );
});

test('venue_hfa: every team split carries n + honest low_n, win pct in [0,1]', () => {
  const teams = Object.keys(env.venue_hfa);
  assert.equal(teams.length, 32, `venue_hfa must cover 32 teams, got ${teams.length}`);
  for (const [ab, v] of Object.entries(env.venue_hfa)) {
    assertSplit(`venue_hfa.${ab}`, v);
    assert.ok(
      v.home_win_pct >= 0 && v.home_win_pct <= 1,
      `venue_hfa.${ab}: home_win_pct ${v.home_win_pct}`,
    );
    assert.ok(Number.isFinite(v.avg_home_margin), `venue_hfa.${ab}: avg_home_margin`);
  }
});

test('cold splits: threshold 32F; per-team + dome-teams-outdoor-cold carry n, deltas consistent', () => {
  assert.equal(env.cold.threshold_f, 32);
  const perTeam = Object.entries(env.cold.per_team);
  assert.ok(perTeam.length > 0, 'at least one team must have a cold sample over 5 seasons');
  for (const [ab, c] of perTeam) {
    assertSplit(`cold.per_team.${ab}`, c);
    assert.ok(c.cold_games >= 1, `cold.per_team.${ab}: listed without a cold appearance`);
    for (const k of ['cold_win_pct', 'base_win_pct']) {
      assert.ok(c[k] >= 0 && c[k] <= 1, `cold.per_team.${ab}.${k} = ${c[k]}`);
    }
    assert.ok(
      Math.abs(c.delta - (c.cold_win_pct - c.base_win_pct)) < 1e-3,
      `cold.per_team.${ab}: delta ${c.delta} != cold - base`,
    );
  }
  const dome = env.cold.dome_teams_outdoor_cold;
  assertSplit('cold.dome_teams_outdoor_cold', dome);
  assert.ok(dome.win_pct >= 0 && dome.win_pct <= 1);
  assert.ok(dome.expected_pct >= 0 && dome.expected_pct <= 1);
  assert.ok(
    Math.abs(dome.delta - (dome.win_pct - dome.expected_pct)) < 1e-3,
    'dome delta must equal win_pct - expected_pct',
  );
});

test('surface splits: 32 per-team home splits + both aggregate surfaces, all with n', () => {
  const perTeam = Object.entries(env.surface.per_team_home);
  assert.equal(perTeam.length, 32);
  for (const [ab, s] of perTeam) {
    assertSplit(`surface.per_team_home.${ab}`, s);
    assert.ok(SURFACES.has(s.surface), `surface.per_team_home.${ab}: surface enum`);
    assert.ok(s.home_win_pct >= 0 && s.home_win_pct <= 1);
  }
  for (const surf of ['grass', 'turf']) {
    const agg = env.surface.by_surface[surf];
    assertSplit(`surface.by_surface.${surf}`, agg);
    assert.ok(agg.home_win_pct >= 0 && agg.home_win_pct <= 1);
  }
});

test('international: n >= 15 across 5 seasons, pct in [0,1], each game internally consistent', () => {
  const intl = env.international;
  assertSplit('international', intl);
  assert.ok(intl.n >= 15, `international n ${intl.n} < 15 across 2021-2025`);
  assert.equal(intl.games.length, intl.n, 'international n must equal the games listed');
  assert.ok(
    intl.designated_home_win_pct >= 0 && intl.designated_home_win_pct <= 1,
    `designated_home_win_pct ${intl.designated_home_win_pct}`,
  );
  for (const g of intl.games) {
    assert.ok(g.yr >= 2021 && g.yr <= 2025, `intl game yr ${g.yr}`);
    assert.notEqual(g.country, 'USA', 'an international game cannot be in the USA');
    assert.ok(g.home && g.away && g.home !== g.away, 'intl game teams');
    assert.equal(
      g.designated_home_won,
      g.home_score > g.away_score,
      `intl ${g.yr} ${g.away}@${g.home}: designated_home_won inconsistent with the score`,
    );
  }
});

test('params are RECORDED, never applied — game probs unchanged by this file', () => {
  assert.equal(env.params.applied, false, 'params.applied must be false (record, do not apply)');
  assert.equal(env.params.cold_team_coefs_registered, true);
  assert.ok(
    Number.isFinite(env.params.intl_hfa_elo_delta),
    'intl_hfa_elo_delta must be a recorded number',
  );
  // Document-level honesty: not yet a validated predictor.
  assert.equal(env.estimate, true);
});
