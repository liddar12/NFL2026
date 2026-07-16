/* tests/feature/weekly_contract.test.mjs — locks data/player_weekly.json (Agent E).
 *
 * Runs against the COMMITTED data files (like real_data.test.mjs), so the gate
 * catches a weekly-pipeline regression before deploy. Node built-ins only.
 *
 * Contract (build contract v3, weekly_split_v1):
 *   - players EXACTLY mirror player_projections.json (same ids, same order),
 *   - every weeks array is length 18 (wk 1..18, in order, pts at 2dp),
 *   - a bye row is a zero-week: pts 0, opp null, bye true — and byes/opponents
 *     agree with schedule_full.json (bye == the team has NO game that week),
 *   - non-bye pts sum to the player's season projection within 0.1 (the tilt
 *     redistributes, never inflates),
 *   - model meta is honest: estimate === true, with the optimizer-refit
 *     coefficients (tilt_coef, home_coef) recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const weekly = read('../../data/player_weekly.json');
const proj = read('../../data/player_projections.json');
const sched = read('../../data/schedule_full.json');

test('model meta is honest: ESTIMATE labeled, refit coefficients recorded', () => {
  assert.equal(weekly.model.estimate, true,
    'weekly numbers are unmeasured priors — model.estimate MUST be true');
  assert.equal(typeof weekly.model.tilt_coef, 'number',
    'tilt_coef (the P2 optimizer-refit parameter) must be recorded in meta');
  assert.equal(typeof weekly.model.home_coef, 'number',
    'home_coef must be recorded in meta');
  assert.ok(weekly.model.name, 'model.name missing');
  assert.equal(weekly.season, proj.season, 'weekly/projections season mismatch');
  assert.ok(weekly.updated_utc, 'updated_utc missing');
});

test('players EXACTLY mirror player_projections.json (same ids, same order)', () => {
  assert.deepEqual(
    weekly.players.map((p) => p.gsis_id),
    proj.players.map((p) => p.gsis_id),
    'player_weekly ids/order drifted from player_projections — joins by index break',
  );
});

test('every weeks array is length 18, wk 1..18 in order, well-typed at 2dp', () => {
  for (const p of weekly.players) {
    assert.equal(p.weeks.length, 18, `${p.gsis_id}: weeks length ${p.weeks.length}`);
    assert.equal(typeof p.receptions_prior, 'number', `${p.gsis_id}: receptions_prior`);
    assert.ok(p.receptions_prior >= 0, `${p.gsis_id}: negative receptions_prior`);
    p.weeks.forEach((w, i) => {
      assert.equal(w.wk, i + 1, `${p.gsis_id}: weeks out of order at index ${i}`);
      assert.equal(typeof w.home, 'boolean', `${p.gsis_id} wk${w.wk}: home not bool`);
      assert.equal(typeof w.bye, 'boolean', `${p.gsis_id} wk${w.wk}: bye not bool`);
      assert.equal(typeof w.pts, 'number', `${p.gsis_id} wk${w.wk}: pts not number`);
      assert.ok(w.pts >= 0, `${p.gsis_id} wk${w.wk}: negative pts`);
      // pts are written at 2dp (float-representation tolerance only).
      assert.ok(
        Math.abs(w.pts * 100 - Math.round(w.pts * 100)) < 1e-6,
        `${p.gsis_id} wk${w.wk}: pts ${w.pts} not 2dp`,
      );
    });
  }
});

test('bye rows are zero-weeks (pts 0, opp null, bye true) — exactly one per player', () => {
  // 18-week season, 17 games: every team has EXACTLY one bye.
  for (const p of weekly.players) {
    const byes = p.weeks.filter((w) => w.bye);
    assert.equal(byes.length, 1, `${p.gsis_id}: ${byes.length} bye weeks`);
    for (const w of byes) {
      assert.equal(w.pts, 0, `${p.gsis_id} wk${w.wk}: bye must carry pts 0`);
      assert.equal(w.opp, null, `${p.gsis_id} wk${w.wk}: bye must carry opp null`);
    }
    for (const w of p.weeks) {
      if (!w.bye) assert.ok(w.opp, `${p.gsis_id} wk${w.wk}: non-bye missing opp`);
    }
  }
});

test('non-bye weekly points sum to the season projection within 0.1', () => {
  // The tilt REDISTRIBUTES points across weeks; it must never inflate or leak.
  weekly.players.forEach((p, i) => {
    const season = proj.players[i].proj_points;
    const sum = p.weeks.reduce((a, w) => a + (w.bye ? 0 : w.pts), 0);
    assert.ok(
      Math.abs(sum - season) <= 0.1,
      `${p.gsis_id}: weekly sum ${sum.toFixed(2)} != season ${season} (>0.1 off)`,
    );
  });
});

test('byes and opponents agree with schedule_full (bye == no game that week)', () => {
  // week -> team -> {opp, home} straight from the schedule contract.
  const byWeek = new Map();
  for (const g of sched.games) {
    const wk = Number(g.week);
    if (!byWeek.has(wk)) byWeek.set(wk, new Map());
    byWeek.get(wk).set(g.home, { opp: g.away, home: true });
    byWeek.get(wk).set(g.away, { opp: g.home, home: false });
  }
  const teamById = new Map(proj.players.map((p) => [p.gsis_id, p.team]));
  for (const p of weekly.players) {
    const team = teamById.get(p.gsis_id);
    for (const w of p.weeks) {
      const game = byWeek.get(w.wk) ? byWeek.get(w.wk).get(team) : undefined;
      if (w.bye) {
        assert.equal(game, undefined,
          `${p.gsis_id} wk${w.wk}: marked bye but ${team} has a scheduled game`);
      } else {
        assert.ok(game, `${p.gsis_id} wk${w.wk}: no scheduled game for ${team}`);
        assert.equal(w.opp, game.opp, `${p.gsis_id} wk${w.wk}: opp drifted`);
        assert.equal(w.home, game.home, `${p.gsis_id} wk${w.wk}: home flag drifted`);
      }
    }
  }
});
