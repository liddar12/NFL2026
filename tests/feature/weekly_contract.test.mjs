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
 *   - non-bye pts sum to the player's AVAILABILITY-ADJUSTED season projection
 *     within 0.1 — proj_points * playable_non_bye / non_bye (the tilt
 *     redistributes across the weeks he can play, never inflates); a player with
 *     no long-term absence keeps the original proj_points target exactly,
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

test('non-bye weekly points sum to the AVAILABILITY-ADJUSTED season projection', () => {
  // The tilt REDISTRIBUTES points across the weeks a player can play; it must never
  // inflate or leak. Rel17 changes WHICH weeks those are, not that law.
  //
  // A player with no long-term absence keeps the original assertion verbatim. A
  // player whose weeks were blocked (IR / PUP / NFI / suspension / a parsed
  // duration) is pinned to a target that is a function of the games he can play —
  // and, critically, is asserted to have ACTUALLY DROPPED. The pre-Rel17 form of
  // this test asserted that a player who will not take a snap in 2026 still carries
  // 100% of his season points, which is the F2 defect written down as a lock.
  weekly.players.forEach((p, i) => {
    const season = proj.players[i].proj_points;
    const sum = p.weeks.reduce((a, w) => a + (w.bye ? 0 : w.pts), 0);
    const nonBye = p.weeks.filter((w) => !w.bye).length;
    const blocked = p.weeks.filter((w) => !w.bye && w.avail === false).length;
    const a = p.availability || null;

    if (!a || a.class !== 'season') {
      // Healthy or week-shaped only: the original law, character for character.
      assert.equal(blocked, 0,
        `${p.gsis_id}: weeks blocked without a season-class availability block`);
      assert.ok(
        Math.abs(sum - season) <= 0.1,
        `${p.gsis_id}: weekly sum ${sum.toFixed(2)} != season ${season} (>0.1 off)`,
      );
      return;
    }
    if (a.out_for_season) {
      assert.equal(sum, 0, `${p.gsis_id}: out for season must carry 0 points`);
      return;
    }
    // R49 games-normalized baseline: when the projection row states that its
    // season number ALREADY excludes the blocked games (prior_ppg x projected
    // games with absence_weeks > 0), the playable weeks renormalize to the FULL
    // number — subtracting the absence again would double-count it.
    const row = proj.players[i];
    const inTotal = row.baseline_rule === 'prior_ppg_x_projected_games'
      && Number(row.absence_weeks) > 0;
    if (inTotal) {
      assert.ok(blocked > 0, `${p.gsis_id}: absence stated in the total but no week blocked`);
      assert.ok(
        Math.abs(sum - season) <= 0.1,
        `${p.gsis_id}: weekly sum ${sum.toFixed(2)} != season ${season} whose total ` +
        `already excludes ${row.absence_weeks} absent games (${nonBye - blocked}/${nonBye} playable)`,
      );
      return;
    }
    const avail = nonBye - blocked;
    assert.ok(
      Math.abs(sum - season * (avail / nonBye)) <= 0.1,
      `${p.gsis_id}: weekly sum ${sum.toFixed(2)} != availability-adjusted target ` +
      `${(season * (avail / nonBye)).toFixed(2)} (${avail}/${nonBye} weeks playable)`,
    );
    // The reduction REALLY happened — this test cannot silently pass on a no-op,
    // which is the exact failure mode that let F1/F2 ship.
    assert.ok(sum < season - 0.1,
      `${p.gsis_id}: flagged unavailable but the season total did not drop`);
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
