/* tests/feature/r30b_parity.test.mjs — R30b CROSS-VIEW SCORING PARITY, locked.
 *
 * THE INVARIANT. For the same player, the same persisted scoring mode and the
 * same league profile, every surface prints ONE number:
 *
 *   PLAYERS  PROJ            projSeason()            (app/views/players.js)
 *   COMPARE  PROJ PTS        seasonMetrics().proj    (app/views/compare.js)
 *   TEAM     finder / SZN    scoringAdjust(proj, receptions_prior, mode,
 *                            extraPtsOf(e)) — the exact team.js:1307 call,
 *                            exercised through the same team-logic exports
 *   LINEUP   Σ weekly rows   leagueWeeks().weeks summed (app/views/lineup.js)
 *
 * and rest-of-season can never exceed the season total, because both are in
 * the same table (players.js rosValue, reused verbatim by COMPARE and mirrored
 * by LINEUP's ratio).
 *
 * WHY IT IS ASSERTED THIS WAY. R30 found three surfaces disagreeing about one
 * player: PLAYERS converted, COMPARE printed raw PPR under the same label, and
 * LINEUP hard-wired raw weekly PPR beside a league-scored K/DST row. The gate
 * was green because each view's tests asserted that view alone. This file
 * imports the views' OWN exported pure helpers — the functions the mounts
 * actually call — and diffs them against each other over the COMMITTED data
 * files, so a conversion taught to one surface and not another fails here by
 * construction.
 *
 * EXTRAS APPORTIONMENT (the R30b decision). `extra_pts` is a SEASON total.
 * LINEUP distributes it across the player's non-bye weeks proportionally to
 * each week's share of season points (byes get 0) — that is what scaling every
 * week by season_adj/season_ppr does — so the season identity must hold: the
 * weekly extras sum back to extra_pts. Asserted below against a QB with a real
 * completions_prior from the committed weekly feed.
 *
 * TOLERANCES. PROJ across surfaces is the SAME shared arithmetic and must agree
 * to double precision. LINEUP's season sum rides the weekly feed, whose non-bye
 * pts sum to proj_points within the feed's own 0.01-per-week rounding, so those
 * assertions use a 0.1-point band — "agree to rounding", never looser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { projSeason, rosValue } from '../../app/views/players.js';
import { seasonMetrics } from '../../app/views/compare.js';
import { leagueWeeks } from '../../app/views/lineup.js';
import {
  scoringAdjust, weeklyPoints, extraPtsOf, withLeagueExtras,
} from '../../app/team-logic.js';
import { rosPoints } from '../../app/ros.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(join(REPO_ROOT, 'data', p), 'utf8'));

/* ---- the committed contracts, exactly as the views fetch them ------------- */
const PROJ = load('player_projections.json');
const WEEKLY = load('player_weekly.json');
const weeklyRaw = new Map(WEEKLY.players.map((w) => [String(w.gsis_id), w]));

const MODES = ['ppr', 'half', 'std'];

/** Non-bye raw weekly sum — the feed's own season total. */
const rawSum = (w) => w.weeks.reduce((a, x) => a + (x.bye ? 0 : Number(x.pts) || 0), 0);

/* Deterministic picks from the committed pool, not hardcoded ids, so a daily
 * data refresh cannot orphan the test. "Healthy" (weekly sum == season total to
 * the feed's rounding) keeps the season-identity assertions about the
 * CONVERSION, not about an availability haircut some player happens to carry. */
const pool = PROJ.players.filter((p) => {
  const w = weeklyRaw.get(String(p.gsis_id));
  return w && Array.isArray(w.weeks) && Math.abs(rawSum(w) - Number(p.proj_points)) < 0.05;
});
const top = (pred) => pool
  .filter(pred)
  .sort((a, b) => Number(b.proj_points) - Number(a.proj_points))[0];

const wOf = (p) => weeklyRaw.get(String(p.gsis_id));
const QB = top((p) => String(p.position).toUpperCase() === 'QB'
  && Number(wOf(p).completions_prior) > 0);
const RB = top((p) => String(p.position).toUpperCase() === 'RB'
  && Number(wOf(p).receptions_prior) > 20);
const WR = top((p) => String(p.position).toUpperCase() === 'WR'
  && Number(wOf(p).receptions_prior) > 20);
const PLAYERS = [QB, RB, WR];

test('the committed pool supplies the three parity subjects', () => {
  for (const p of PLAYERS) {
    assert.ok(p, 'a healthy QB (with completions_prior), RB and WR must exist '
      + 'in the committed data — if this fails, the data contract changed, '
      + 'not the views');
  }
});

/* ==========================================================================
   1. PROJ parity: PLAYERS == COMPARE == TEAM, all three modes
   ========================================================================== */

test('PLAYERS PROJ, COMPARE PROJ PTS and TEAM\'s finder number are ONE number in every mode', () => {
  // The default league: no extra scoring rules. withLeagueExtras must hand the
  // identical map back (its own contract), exactly as every mount stamps it.
  const weeklyById = withLeagueExtras(weeklyRaw, { scoring: {} });
  for (const p of PLAYERS) {
    const w = weeklyById.get(String(p.gsis_id));
    for (const mode of MODES) {
      const players = projSeason(p, w, mode);
      const compare = seasonMetrics(p, w, mode, 1).proj;
      // TEAM builds adjById with exactly this call (app/views/team.js:1307,
      // via the same team-logic export) — the finder cell, the SZN slot chip
      // and the STARTERS SEASON TOTAL all read it.
      const team = scoringAdjust(p.proj_points, w ? w.receptions_prior : 0,
        mode, extraPtsOf(w));
      assert.ok(Math.abs(players - team) < 1e-9,
        `${p.name} ${mode}: PLAYERS ${players} != TEAM ${team}`);
      assert.ok(Math.abs(compare - team) < 1e-9,
        `${p.name} ${mode}: COMPARE ${compare} != TEAM ${team}`);
      // Modes genuinely differ for a player with receptions — the parity must
      // not be the degenerate "everything is PPR" equality this file replaced.
      if (mode !== 'ppr' && Number(w.receptions_prior) > 0) {
        assert.ok(players < projSeason(p, w, 'ppr'),
          `${p.name}: ${mode} must price below ppr for a pass-catcher`);
      }
    }
  }
});

/* ==========================================================================
   2. LINEUP's season-summed weeklies land on the same number
   ========================================================================== */

test('LINEUP\'s converted weekly rows sum back to the season PROJ (to feed rounding)', () => {
  const weeklyById = withLeagueExtras(weeklyRaw, { scoring: {} });
  for (const p of PLAYERS) {
    const w = weeklyById.get(String(p.gsis_id));
    for (const mode of MODES) {
      const season = projSeason(p, w, mode);
      const lw = leagueWeeks(p, w, mode);
      assert.equal(lw.weeks.length, w.weeks.length,
        `${p.name}: leagueWeeks must align 1:1 with the weekly feed`);
      const sum = lw.weeks.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - season) < 0.1,
        `${p.name} ${mode}: LINEUP season sum ${sum} != PROJ ${season}`);
      // Byes stay hard 0 — a zero-week, never a redistributed share.
      w.weeks.forEach((x, i) => {
        if (x.bye) assert.equal(lw.weeks[i], 0, `${p.name}: bye week must be 0`);
      });
    }
  }
});

/* ==========================================================================
   3. RoS: same table as the season, never above it, same on every surface
   ========================================================================== */

test('RoS is mode-converted, identical on PLAYERS/COMPARE/LINEUP, and never exceeds the season', () => {
  const weeklyById = withLeagueExtras(weeklyRaw, { scoring: {} });
  for (const p of PLAYERS) {
    const w = weeklyById.get(String(p.gsis_id));
    for (const mode of MODES) {
      const season = projSeason(p, w, mode);
      const players = rosValue(p, w, mode, 1).points;
      const compare = seasonMetrics(p, w, mode, 1).ros;
      // LINEUP's playerRow: rosPoints(weeks, wk) * leagueWeeks().ratio.
      const lineup = rosPoints(w.weeks, 1) * leagueWeeks(p, w, mode).ratio;
      assert.ok(Math.abs(players - compare) < 1e-9,
        `${p.name} ${mode}: PLAYERS RoS ${players} != COMPARE RoS ${compare}`);
      assert.ok(Math.abs(players - lineup) < 1e-9,
        `${p.name} ${mode}: PLAYERS RoS ${players} != LINEUP RoS ${lineup}`);
      // THE R30 HEADLINE BUG: remaining 17 games out-pointing the whole season
      // (Nacua STD: season 246.0, RoS chip 375.0). rosPoints rounds to 0.1 in
      // the PPR domain, hence the 0.06 band — nothing looser.
      assert.ok(players <= season + 0.06,
        `${p.name} ${mode}: RoS ${players} exceeds season total ${season}`);
    }
    // And the conversion is real: a pass-catcher's remaining value shrinks
    // when the table stops paying receptions.
    if (Number(w.receptions_prior) > 0) {
      assert.ok(rosValue(p, w, 'std', 1).points < rosValue(p, w, 'ppr', 1).points,
        `${p.name}: RoS must convert with the mode, not stay raw PPR`);
    }
  }
});

/* ==========================================================================
   4. League extras: a SEASON total, apportioned by season share, byes 0
   ========================================================================== */

test('extra_pts apportions across non-bye weeks by season share and sums back exactly', () => {
  // A pass_cmp league — the one extra rule the app prices (R29). Stamped the
  // way every view stamps it: through withLeagueExtras, never by hand.
  const stamped = withLeagueExtras(weeklyRaw, { scoring: { pass_cmp: 0.5 } });
  const w = stamped.get(String(QB.gsis_id));
  const extra = extraPtsOf(w);
  assert.ok(extra > 0, `${QB.name} must carry stamped extras under pass_cmp`);
  assert.ok(Math.abs(extra - Number(w.completions_prior) * 0.5) < 0.01,
    'extra_pts is completions x the league rate');

  const ppr = Number(QB.proj_points);
  const lw = leagueWeeks(QB, w, 'ppr');
  const raw = w.weeks.map((x) => (x.bye ? 0 : Number(x.pts) || 0));
  const deltas = lw.weeks.map((v, i) => v - raw[i]);

  // The season identity: the weekly extras sum back to the season extra_pts.
  const deltaSum = deltas.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(deltaSum - extra) < 0.1,
    `weekly extras sum ${deltaSum} != season extra_pts ${extra}`);

  // Proportionality: week i's share of the extra equals its share of the
  // season — and a bye gets exactly none of it.
  w.weeks.forEach((x, i) => {
    if (x.bye) {
      assert.equal(lw.weeks[i], 0, 'a bye week receives no apportioned extra');
    } else {
      assert.ok(Math.abs(deltas[i] - (raw[i] / ppr) * extra) < 1e-6,
        `week ${x.wk}: extra share must be proportional to season share`);
    }
  });

  // Parity holds WITH extras too: all four surfaces price the stamped entry
  // identically (this is the pass_cmp half of the R30 findings).
  for (const mode of MODES) {
    const team = scoringAdjust(QB.proj_points, w.receptions_prior, mode, extraPtsOf(w));
    assert.ok(Math.abs(projSeason(QB, w, mode) - team) < 1e-9, 'PLAYERS w/ extras');
    assert.ok(Math.abs(seasonMetrics(QB, w, mode, 1).proj - team) < 1e-9, 'COMPARE w/ extras');
    const sum = leagueWeeks(QB, w, mode).weeks.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - team) < 0.1, 'LINEUP w/ extras');
    // ...and TEAM's weekly grid (weeklyPoints with the 4-arg adj — the exact
    // team.js:1309 call) sums to the same season number.
    const grid = weeklyPoints(w, team, QB.proj_points).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(grid - team) < 0.1, 'TEAM weekly grid w/ extras');
  }
});
