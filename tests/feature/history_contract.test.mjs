/* tests/feature/history_contract.test.mjs — data locks for data/player_history.json
 * (Agent E, Build 4 contract).
 *
 * The 5-year (2021-2025) player history that feeds Fit Engine v2 trajectories.
 * Locks (from the build contract, section 1):
 *   - season_range is [2021, 2025] and every season row stays inside it;
 *   - history entries exist for >= 250 of the ids in player_projections.json
 *     (the current 300), and >= 250 of them carry >= 2 observed seasons;
 *   - trajectory.source is ONLY "measured" | "ai_estimated" — a committed file
 *     may never ship "pending" (that state exists only mid-build, before
 *     scripts/ai_estimates.py lands);
 *   - "measured" requires seasons_observed >= 3 and numeric slope/residual;
 *   - seasons_observed always equals the seasons actually listed.
 *
 * Node built-ins only (fast gate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const history = readData('player_history.json');
const projections = readData('player_projections.json');

const SEASON_LO = 2021;
const SEASON_HI = 2025;
const MIN_PRESENT = 250;
const SOURCES = new Set(['measured', 'ai_estimated']);

test('season_range is exactly [2021, 2025] and updated_utc is stamped', () => {
  assert.deepEqual(history.season_range, [SEASON_LO, SEASON_HI]);
  assert.match(String(history.updated_utc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test(`history entries exist for >= ${MIN_PRESENT} projected ids; >= ${MIN_PRESENT} carry >= 2 seasons`, () => {
  const ids = projections.players.map((p) => p.gsis_id);
  assert.ok(ids.length >= MIN_PRESENT, `projection pool too small: ${ids.length}`);

  const present = ids.filter((id) => history.players[id]);
  assert.ok(
    present.length >= MIN_PRESENT,
    `only ${present.length}/${ids.length} projected ids have a history entry (< ${MIN_PRESENT})`,
  );

  const twoPlus = present.filter((id) => history.players[id].seasons.length >= 2);
  assert.ok(
    twoPlus.length >= MIN_PRESENT,
    `only ${twoPlus.length} projected ids carry >= 2 observed seasons (< ${MIN_PRESENT})`,
  );
});

test('every season row is within 2021-2025 with sane numeric stats, ascending by yr', () => {
  for (const [gid, rec] of Object.entries(history.players)) {
    assert.ok(Array.isArray(rec.seasons), `${gid}: seasons must be an array`);
    let prevYr = -Infinity;
    for (const s of rec.seasons) {
      assert.ok(
        Number.isInteger(s.yr) && s.yr >= SEASON_LO && s.yr <= SEASON_HI,
        `${gid}: season yr ${s.yr} outside [${SEASON_LO}, ${SEASON_HI}]`,
      );
      assert.ok(s.yr > prevYr, `${gid}: seasons not strictly ascending at ${s.yr}`);
      prevYr = s.yr;
      assert.ok(Number.isFinite(s.pts) && s.pts > 0, `${gid} ${s.yr}: pts ${s.pts}`);
      assert.ok(Number.isFinite(s.receptions) && s.receptions >= 0, `${gid} ${s.yr}: receptions`);
      assert.ok(Number.isFinite(s.targets) && s.targets >= 0, `${gid} ${s.yr}: targets`);
      if ('games' in s) {
        assert.ok(Number.isFinite(s.games) && s.games >= 0, `${gid} ${s.yr}: games`);
      }
    }
  }
});

test('trajectory: source in {measured, ai_estimated} only — never "pending" in a committed file', () => {
  for (const [gid, rec] of Object.entries(history.players)) {
    const t = rec.trajectory;
    assert.ok(t && typeof t === 'object', `${gid}: trajectory missing`);
    assert.ok(
      SOURCES.has(t.source),
      `${gid}: trajectory.source ${JSON.stringify(t.source)} not in {measured, ai_estimated}`,
    );
  }
});

test('measured trajectories require seasons_observed >= 3 and numeric slope/residual', () => {
  let measured = 0;
  for (const [gid, rec] of Object.entries(history.players)) {
    const t = rec.trajectory;
    assert.equal(
      t.seasons_observed,
      rec.seasons.length,
      `${gid}: seasons_observed ${t.seasons_observed} != seasons listed ${rec.seasons.length}`,
    );
    if (t.source === 'measured') {
      measured += 1;
      assert.ok(
        t.seasons_observed >= 3,
        `${gid}: measured trajectory with only ${t.seasons_observed} seasons`,
      );
      assert.ok(
        Number.isFinite(t.slope_pts_per_yr),
        `${gid}: measured slope_pts_per_yr must be numeric`,
      );
      assert.ok(
        t.curve_residual_per_yr === null || Number.isFinite(t.curve_residual_per_yr),
        `${gid}: measured curve_residual_per_yr must be numeric or null`,
      );
    } else {
      // ai_estimated is only for thin history (< 3 observed seasons).
      assert.ok(
        t.seasons_observed < 3,
        `${gid}: ai_estimated trajectory despite ${t.seasons_observed} observed seasons`,
      );
    }
  }
  assert.ok(measured > 0, 'at least one measured trajectory expected in real data');
});
