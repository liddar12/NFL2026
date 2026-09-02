/* tests/feature/r51_ai_plus.test.mjs — R51 PLAYERS AI+ = THIS WEEK, locked.
 *
 * What AI+ used to do: multiply the season projection by a 5-year trajectory
 * tilt (ai_insights trajectory_adj, clamped ±25%). Measured offline against
 * 2025 actuals it made the number WORSE (rank corr −0.016, MAE +4.2 points on
 * ~54), so the owner retired it. AI+ ON now means: this week's league-priced
 * points in the headline ("WK n · MATCHUP"), the rest-of-season sum beside
 * it, the season PROJ kept as BASE — the same weeklyPoints() split GRADE and
 * LINEUP price from — and the list sorted by this week's number.
 *
 * Locks (node built-ins only; source-text pins follow the pattern of
 * tests/feature/players_view.test.mjs / r49_sleeper_display.test.mjs):
 *   1. the trajectory multiplier is GONE from the view (no aiRatio, no
 *      1 + clamped ±0.25 math, no "re-ranks by 5-yr trajectory" copy);
 *   2. "this week" is the week league-rosters remembers (Sleeper's regular-
 *      season week via defaultLineupWeek(loadNflWeek())), lazily imported;
 *   3. RoS equals the sum of the remaining priced weeks of the same split;
 *   4. a player without weekly rows renders "—" (never 0) and sorts LAST;
 *   5. the legend / note wording switches on player_weekly.json model.name;
 *   6. the toggle exists only when the weekly layer does; the shared key stays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  projSeason, rosValue, weekValue, aiPlusCopy, withWeekHeadline, AI_PLUS_MEASURED_MODEL,
} from '../../app/views/players.js';
import { renderPlayerCard } from '../../app/render.js';
import { withLeagueExtras } from '../../app/team-logic.js';
import { DEFAULT_PROFILE } from '../../app/league.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(join(REPO_ROOT, 'data', p), 'utf8'));
const SRC = readFileSync(join(REPO_ROOT, 'app/views/players.js'), 'utf8');

const projections = load('player_projections.json');
const weeklyDoc = load('player_weekly.json');
const weeklyById = new Map(weeklyDoc.players.map((w) => [String(w.gsis_id), w]));
const priced = withLeagueExtras(weeklyById, DEFAULT_PROFILE);
const projById = new Map(projections.players.map((p) => [String(p.gsis_id), p]));

/** The body of a top-level or mount-scoped function, by name (source slice). */
const body = (name) => {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  return SRC.slice(start, SRC.indexOf('\n  }\n', start));
};

/* ---- 1. the trajectory multiplier is retired ----------------------------- */
test('R51: the ±25% trajectory multiplier is gone from the PLAYERS view', () => {
  assert.doesNotMatch(SRC, /aiRatio/, 'aiRatio() must be deleted, not just unused');
  assert.doesNotMatch(SRC, /1 \+ clamped/, 'no 1 + clamped multiplier');
  assert.doesNotMatch(SRC, /Math\.max\(-0\.25/, 'no ±0.25 clamp');
  assert.doesNotMatch(SRC, /0\.25/, 'no trajectory bound anywhere in the view');
  assert.doesNotMatch(SRC, /re-ranks by 5-yr trajectory/, 'the old legend/note copy is gone');
  assert.doesNotMatch(SRC, /1±25%|±25%/, 'no ±25% claim');
  assert.doesNotMatch(SRC, /aiDelta/, 'the AI delta is dropped: nothing multiplies, so there is no delta to show');
  // model() no longer scales anything by an AI ratio; the season interval stays a season quantity.
  const m = body('model');
  assert.doesNotMatch(m, /aiOn|trajectory|aiInsights/, 'model() is AI-agnostic');
  assert.match(m, /low: Number\(p\.low\) \* scoreRatio,/);
  assert.match(m, /high: Number\(p\.high\) \* scoreRatio,/);
  // The WEEKS strip scales by the scoring ratio only.
  assert.match(SRC, /renderWeekStrip\(w\.weeks, scoreRatio\)/);
  // TREND stays: information only.
  assert.match(SRC, /function trajFor\(id\)/);
  assert.match(SRC, /const trend = trendLabel\(trajFor\(id\)\);/);
  assert.match(SRC, /<b>TREND<\/b> 5-yr trajectory/);
});

/* ---- 2. this week comes from league-rosters, lazily ----------------------- */
test('R51: "this week" is the week league-rosters remembers, via a LAZY import', () => {
  assert.match(SRC, /import\('\.\.\/league-rosters\.js'\)/, 'dynamic import in the mount');
  assert.doesNotMatch(SRC, /^import[^;]*league-rosters/m,
    'no static edge — players.js is on the boot graph and league-rosters is LAZY_ONLY (tests/perf/budget.spec.mjs)');
  assert.match(SRC, /const \{ loadNflWeek, defaultLineupWeek \} = rostersRes\.value;/);
  assert.match(SRC, /const sleeperWk = defaultLineupWeek\(loadNflWeek\(\), 18\);/, 'the SAME rule LINEUP applies');
  assert.match(SRC, /if \(sleeperWk != null\) currentWk = sleeperWk;/);
  assert.match(SRC, /let currentWk = 1;/, 'unknown week defaults to 1');
  // The headline, the sort key and RoS all read ONE week (currentWk).
  assert.match(SRC, /weekValue\(_projById\.get\(id\), weeklyPriced\.get\(id\), scoring, currentWk\)/);
  assert.match(SRC, /rosValue\(_projById\.get\(id\), weeklyPriced\.get\(id\), scoring, currentWk\)/);
  assert.match(SRC, /withWeekHeadline\(card, currentWk, weekOf\(id\), m\.player\.proj_points\)/);
  assert.match(SRC, /const weekSortLabel = `WK \$\{currentWk\}`;/);
});

/* ---- 3. RoS == the sum of the remaining priced weeks ---------------------- */
test('R51: RoS equals the sum of the remaining non-bye priced weeks of the same split', () => {
  let checked = 0;
  for (const [id, w] of priced) {
    const p = projById.get(id);
    if (!p || checked >= 60) continue;
    for (const mode of ['ppr', 'half', 'std']) {
      for (const wk of [1, 7, 15]) {
        const ros = rosValue(p, w, mode, wk);
        assert.ok(ros, `${id}: RoS must exist for a player with weekly rows`);
        let sum = 0;
        let games = 0;
        for (const row of w.weeks) {
          if (Number(row.wk) < wk) continue;
          const wv = weekValue(p, w, mode, row.wk);
          assert.ok(wv, `${id} wk${row.wk}: a scheduled week has a value`);
          if (row.bye) {
            assert.equal(wv.bye, true);
            assert.equal(wv.points, 0, 'a bye is a real 0');
            continue;
          }
          sum += wv.points;
          games += 1;
        }
        // rosPoints rounds the raw remaining sum to 0.1 before the scoring
        // ratio; the priced weeks are exact — so the two agree within 0.1.
        assert.ok(Math.abs(ros.points - sum) < 0.1 + 1e-9,
          `${id} ${mode} wk${wk}: RoS ${ros.points} vs Σ weeks ${sum}`);
        assert.equal(ros.gamesLeft, games);
        // And every week is the season number's share, never a re-split.
        const season = projSeason(p, w, mode);
        const all = w.weeks.reduce((a, row) => a + (row.bye ? 0 : weekValue(p, w, mode, row.wk).points), 0);
        assert.ok(Math.abs(all - season) < 0.05 * Math.max(1, season) + 1e-6,
          `${id} ${mode}: the 18 priced weeks sum to the season number (${all} vs ${season})`);
      }
    }
    checked += 1;
  }
  assert.ok(checked >= 30, `only ${checked} players checked`);
});

/* ---- 4. absent renders as absent and sorts last ---------------------------- */
test('R51: a player with no weekly row is "—" under AI+ (never 0) and sorts last', () => {
  const p = { gsis_id: 'x1', name: 'No Rows', team: 'ZZZ', position: 'RB', proj_points: 120, low: 90, high: 150 };
  assert.equal(weekValue(p, undefined, 'ppr', 3), null);
  assert.equal(weekValue(p, { weeks: [] }, 'ppr', 3), null, 'no row for the week');
  const card = renderPlayerCard(p, {});
  const html = withWeekHeadline(card, 3, null, 120);
  assert.match(html, /<div class="p-num pv-none">—<\/div>/);
  assert.match(html, /<div class="p-unit">WK 3 · NO WEEKLY ROW<\/div>/);
  assert.match(html, /<div class="p-unit">BASE 120\.0 · SEASON<\/div>/);
  assert.doesNotMatch(html, /p-num[^>]*>0\.0</, 'absent is never rendered as 0.0');
  // The season interval is untouched (a season quantity, labelled as such).
  assert.match(html, /<span>90\.0<\/span><span>150\.0<\/span>/);
  assert.match(html, /80% conformal range/);
  // Sorting: the AI+ sort key is this week's points, null when absent, and the
  // comparator puts null LAST in either direction (tests lock the code path).
  const sv = body('sortVal');
  assert.match(sv, /if \(aiOn\) \{\s*const wv = weekOf\(id\);\s*return wv \? wv\.points : null;\s*\}/);
  assert.match(SRC, /const an = a\.sv == null;\s*const bn = b\.sv == null;\s*if \(an \|\| bn\) return \(an - bn\) \|\| tie;/);
  // Ties break on the season number under AI+.
  assert.match(SRC, /tb: byWeek \? model\(p\)\.player\.proj_points : 0,/);
  assert.match(SRC, /const d = \(b\.sv - a\.sv\) \|\| \(b\.tb - a\.tb\);/);
});

test('R51: the AI+ headline is this week\'s points, labelled WK n · MATCHUP, with BASE and RoS', () => {
  const [w] = weeklyDoc.players;
  const id = String(w.gsis_id);
  const p = projById.get(id);
  assert.ok(p, 'first weekly row has a projection');
  const pw = priced.get(id);
  const game = w.weeks.find((r) => !r.bye);
  const bye = w.weeks.find((r) => r.bye);
  const wv = weekValue(p, pw, 'ppr', game.wk);
  assert.ok(wv && wv.points > 0);
  assert.equal(wv.opp, String(game.opp));
  const season = projSeason(p, pw, 'ppr');
  const html = withWeekHeadline(renderPlayerCard({ ...p, proj_points: season }, {
    weekly: true, ros: rosValue(p, pw, 'ppr', game.wk),
  }), game.wk, wv, season);
  assert.match(html, new RegExp(`<div class="p-num">${wv.points.toFixed(1)}</div>`));
  assert.match(html, new RegExp(`<div class="p-unit"[^>]*>WK ${game.wk} · MATCHUP</div>`));
  assert.match(html, new RegExp(`<div class="p-unit">BASE ${season.toFixed(1)} · SEASON</div>`));
  assert.match(html, /RoS [\d.]+ · \d+g/);
  assert.doesNotMatch(html, /PROJ PTS|AI PROJ PTS/);
  if (bye) {
    const bv = weekValue(p, pw, 'ppr', bye.wk);
    const bh = withWeekHeadline(renderPlayerCard(p, {}), bye.wk, bv, season);
    assert.match(bh, /<div class="p-num">0\.0<\/div>/);
    assert.match(bh, new RegExp(`WK ${bye.wk} · BYE`));
  }
  // Unknown card markup passes through untouched.
  assert.equal(withWeekHeadline('<div>x</div>', 1, wv, season), '<div>x</div>');
});

/* ---- 5. the copy switches on model.name ------------------------------------ */
test('R51: the AI+ wording lists factors ONLY for the measured weekly_split_v2 doc', () => {
  assert.equal(AI_PLUS_MEASURED_MODEL, 'weekly_split_v2');
  const v2 = aiPlusCopy('weekly_split_v2');
  assert.match(v2, /^AI\+ · THIS WEEK — matchup-adjusted weekly points from the same split GRADE and LINEUP use \(opponent DvP, weather, venue; Elo for QB\)\. Measured vs last season's split: MAE −2\.3%, rank corr \+5\.7%\. ESTIMATE\.$/);
  for (const other of ['weekly_split_v1', null, undefined, '', 'weekly_split_v3']) {
    const c = aiPlusCopy(other);
    assert.equal(c, 'AI+ · THIS WEEK — matchup-adjusted weekly points (weekly split), the same split GRADE and LINEUP use. ESTIMATE.');
    assert.doesNotMatch(c, /DvP|weather|venue|Elo|MAE|rank corr/, `${other}: no factor or measurement claimed`);
  }
  // The view reads the SHIPPED doc's model.name — never a hardcoded branch.
  assert.match(SRC, /const weeklyModelName = weekly && weekly\.model && weekly\.model\.name != null\s*\? String\(weekly\.model\.name\) : null;/);
  assert.match(SRC, /const aiCopy = hasWeekly \? aiPlusCopy\(weeklyModelName\) : null;/);
  assert.match(SRC, /<b>AI\+<\/b> \$\{esc\(opts\.aiCopy\)\}/, 'legend carries the same copy');
  assert.match(SRC, /<div class="ai-note">\$\{esc\(aiCopy\)\}<\/div>/, 'the note carries the same copy');
  // The committed doc today routes to whichever branch its name earns.
  const shipped = weeklyDoc.model && weeklyDoc.model.name;
  const expectFactors = shipped === 'weekly_split_v2';
  assert.equal(/DvP/.test(aiPlusCopy(shipped)), expectFactors);
});

/* ---- 6. toggle gating + shared key ---------------------------------------- */
test('R51: the toggle exists only with the weekly layer; the shared preference key is unchanged', () => {
  assert.match(SRC, /const AI_KEY = 'nfl2026\.ai\.v1';/);
  assert.match(SRC, /let aiOn = hasWeekly \? loadAiPref\(\) : false;/);
  assert.match(SRC, /\(hasWeekly \? aiSegRow\(aiOn\) : ''\)/);
  assert.doesNotMatch(SRC, /hasAi \? aiSegRow/, 'ai_insights no longer gates the toggle');
  assert.doesNotMatch(SRC, /const hasAi\b/, 'the dead gate is removed, not left behind');
  // Under AI+ every card carries RoS (half of what AI+ means) and the PROJ
  // chip says what it sorts by.
  assert.match(SRC, /const ros = \(aiOn \|\| sortKey === 'ros'\) \? rosOf\(id\) : null;/);
  assert.match(SRC, /const label = s\.key === 'proj' && weekLabel \? weekLabel : s\.label;/);
  assert.match(SRC, /sortRow\(sortKey, sortDir, aiOn \? weekSortLabel : null\)/);
});
