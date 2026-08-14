/* tests/feature/compare_view.test.mjs — R21-B3 COMPARE view, locked.
 *
 * app/views/compare.js exports pure render helpers (no DOM at import time), the
 * same pattern app/views/model.js and app/views/players.js use, so the FAST gate
 * can prove this markup with no browser:
 *   colHtml(side, m)     one player column (metric rows, in order)
 *   midHtml(A, B)        the centre edge rail (one chip per row, same order)
 *   playoffRow(report)   the fantasy-playoff SoS row ('no playoff-window data'
 *                        in words when the report is null)
 *   playoffEdge(a, b)    that row's centre chip
 *   winGlyph(aWins)      the winner arrow, in BOTH orientations
 *
 * What this file exists to prevent:
 *   1. a NULL playoff reading rendering as an em dash (reads as zero) or a
 *      mid-scale 3.0 (reads as "average schedule"),
 *   2. the centre rail declaring a playoff winner when one side has no window
 *      data at all,
 *   3. the rail drifting out of order with the rows it labels,
 *   4. AVAILABILITY losing its REL17 position above PROJ PTS,
 *   5. the winner arrow pointing sideways on the phone layout, where the two
 *      players are stacked vertically,
 *   6. the player name going back to a small tinted size that fails WCAG AA.
 *
 * The playoff numbers themselves are NOT re-derived here — tests/feature/
 * playoff_sos.test.mjs owns that. This file feeds real playoffSos() reports in
 * and asserts what the view does with them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  colHtml, midHtml, playoffRow, playoffEdge, winGlyph,
} from '../../app/views/compare.js';
import { playoffSos, playoffSosLabel } from '../../app/playoffs.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(join(REPO_ROOT, 'app/views/compare.js'), 'utf8');
const CSS = readFileSync(join(REPO_ROOT, 'app/theme.css'), 'utf8');

/* ---- fixtures --------------------------------------------------------------
 * Synthetic Elo + weeks so the assertions are arithmetic, not data-dependent. */
const RATINGS = { A: 1600, B: 1400, C: 1500, D: 1550, E: 1300 };
const STRENGTH = { season: 2026, ratings: RATINGS };
const P14 = { shape: { playoff_week_start: 14 } };

/** wk1..wk18, all C (1500) except overrides ('bye' or a team code). */
function weeks(overrides = {}) {
  const out = [];
  for (let wk = 1; wk <= 18; wk += 1) {
    const o = overrides[wk];
    if (o === 'bye') out.push({ wk, opp: null, home: false, bye: true, pts: 0 });
    else out.push({ wk, opp: o || 'C', home: wk % 2 === 0, bye: false, pts: 10 });
  }
  return out;
}

const HARD = playoffSos(weeks({ 14: 'A', 15: 'A', 16: 'A', 17: 'A' }), STRENGTH, P14);
const EASY = playoffSos(weeks({ 14: 'E', 15: 'E', 16: 'E', 17: 'E' }), STRENGTH, P14);
const WITH_BYE = playoffSos(weeks({ 14: 'A', 15: 'bye', 16: 'B', 17: 'C' }), STRENGTH, P14);

/** A metrics object of the shape mountCompare's metricsFor() builds. */
function metrics(over = {}) {
  return {
    id: 'X', name: 'Test Player', pos: 'WR', team: 'KC', projected: true,
    proj: 14.2, avail: null, ros: 120.5, sos: 3.1, psos: HARD, bye: 9,
    trend: null, trendVal: 0.8, ...over,
  };
}

/** Metric labels, in DOM order, out of a rendered column. */
function rowLabels(html) {
  return [...html.matchAll(/<span class="cmp-lbl">([^<]*)<\/span>/g)].map((m) => m[1]);
}

/** Edge-chip labels, in DOM order, out of a rendered centre rail. */
function edgeLabels(html) {
  return [...html.matchAll(/<div class="cmp-edge[^"]*">([A-Za-z]+)/g)].map((m) => m[1]);
}

/* ==========================================================================
   1. The fixtures are real reports (guards against testing against null)
   ========================================================================== */

test('fixtures produce real playoffSos reports over weeks 14-17', () => {
  for (const [name, r] of [['HARD', HARD], ['EASY', EASY], ['WITH_BYE', WITH_BYE]]) {
    assert.ok(r, `${name} fixture is null — the test would prove nothing`);
    assert.deepEqual(r.window, { start: 14, end: 17, weeks: 4 }, `${name} window`);
  }
  // Hard slate really is harder than the player's own season average, easy easier.
  assert.ok(HARD.elo_diff > 0, 'HARD should be above the player season average');
  assert.ok(EASY.elo_diff < 0, 'EASY should be below the player season average');
  assert.ok(HARD.rating > EASY.rating, 'rating must order hard above easy');
  assert.equal(WITH_BYE.byes, 1);
  assert.equal(WITH_BYE.games, 3);
});

/* ==========================================================================
   2. The row — a null reading says so IN WORDS
   ========================================================================== */

test('playoffRow(null) says "no playoff-window data" — not a dash, not a 3.0', () => {
  const html = playoffRow(null);
  assert.match(html, /no playoff-window data/);
  // An em dash reads as zero and a mid-scale number reads as "average schedule".
  // Neither may appear where there is no reading.
  assert.ok(!html.includes('—'), `null row must not use an em dash:\n${html}`);
  assert.ok(!/\d/.test(html.replace(/[^>]*style="[^"]*"/g, '')),
    `null row must not print any number:\n${html}`);
  // Still rendered, so both columns and the centre rail stay row-aligned.
  assert.match(html, /class="cmp-metric cmp-metric--posos"/);
  assert.match(html, /<span class="cmp-lbl">PLAYOFF SoS<\/span>/);
});

test('playoffRow prints the rating, the band word and the league window', () => {
  const html = playoffRow(HARD);
  assert.match(html, new RegExp(`>${HARD.rating.toFixed(1)} `), `rating missing:\n${html}`);
  assert.match(html, new RegExp(playoffSosLabel(HARD.rating)));
  assert.equal(HARD.label, playoffSosLabel(HARD.rating));
  // The window comes from the PROFILE, so the row must print the profile's weeks
  // (14-17 here), never a hardcoded default.
  assert.match(html, /W14-17/);
  const dflt = playoffSos(weeks({ 15: 'A', 16: 'A', 17: 'A' }), STRENGTH, undefined);
  assert.match(playoffRow(dflt), /W15-17/, 'default profile window must be 15-17');
});

test('a bye inside the window is its own clause, not folded into the number', () => {
  const html = playoffRow(WITH_BYE);
  assert.match(html, /1 bye/);
  // ...and a window with no bye never claims one.
  assert.ok(!playoffRow(HARD).includes('bye'), 'no-bye window must not mention a bye');
});

test('the row title restates the measurement and the display-only policy', () => {
  const html = playoffRow(HARD);
  const title = /title="([^"]*)"/.exec(html);
  assert.ok(title, 'the row must carry an explanatory title');
  assert.match(title[1], /Weeks 14-17/);
  assert.match(title[1], /25 Elo per point/);
  // playoffs.js is a LENS. The row must not imply the number moves a projection.
  assert.match(title[1], /never applied to a projection/);
});

/* ==========================================================================
   3. The centre chip — never a winner over an absence
   ========================================================================== */

test('playoffEdge names the EASIER side (lower ABSOLUTE difficulty wins)', () => {
  const aEasier = playoffEdge(EASY, HARD);
  assert.match(aEasier, /cmp-win--a/);
  assert.match(aEasier, /easier/);
  const bEasier = playoffEdge(HARD, EASY);
  assert.match(bEasier, /cmp-win--b/);
  // Magnitude is the difference of the two ABSOLUTE readings — the one ruler
  // both players share — not of the self-relative headline numbers.
  const mag = Math.abs(Math.round((HARD.abs_rating - EASY.abs_rating) * 10) / 10);
  assert.match(aEasier, new RegExp(`${mag} easier`));
});

test('playoffEdge compares abs_rating, not the self-relative rating (R21 fix)', () => {
  // THE DEFECT, REPRODUCED. `rating` is measured against each player's OWN
  // season average (app/playoffs.js says so in its own docstring), so two
  // ratings are two different rulers and their difference is not a comparison
  // of two playoff schedules. Build the case where the rulers disagree:
  //
  //   A: an easy season (E = 1300) into a MEAN playoff window (C = 1500).
  //      Against his own season the window is much harder -> high `rating`;
  //      the window itself is dead average -> abs_rating 3.0.
  //   B: a hard season (A = 1600) into that SAME mean window: low `rating`,
  //      identical abs_rating.
  //
  // Same weeks, same opponents, same difficulty: the honest verdict is "even".
  const win = { 14: 'C', 15: 'C', 16: 'C', 17: 'C' };
  const easySeason = weeks(win);
  const hardSeason = weeks(win);
  for (const w of easySeason) if (w.wk < 14) w.opp = 'E';
  for (const w of hardSeason) if (w.wk < 14) w.opp = 'A';
  const a = playoffSos(easySeason, STRENGTH, P14);
  const b = playoffSos(hardSeason, STRENGTH, P14);

  assert.equal(a.abs_rating, b.abs_rating, 'identical windows must be identically hard');
  assert.ok(a.rating !== b.rating,
    'the fixture must actually make the two self-relative ratings differ');

  const html = playoffEdge(a, b);
  assert.match(html, /cmp-edge--even/,
    'two identical playoff windows must be EVEN — the old code crowned a winner here');
  assert.ok(!html.includes('cmp-win'),
    `identical windows must crown nobody:\n${html}`);
  // The chip says which reading it compared, so the verdict is auditable...
  assert.match(html, /ABSOLUTE playoff-window difficulty/);
  // ...and that reading is printed on the row itself.
  assert.match(playoffRow(a), new RegExp(`ABS ${a.abs_rating.toFixed(1)}`));
});

test('a REVERSED pair: the rail follows the absolute slate, not the lens', () => {
  // A faces the league's HARDEST opponents but they are no worse than his own
  // brutal season; B faces weak opponents that are still worse than his soft
  // season. `rating` crowns A; the opponents themselves crown B.
  const aWeeks = weeks({ 14: 'A', 15: 'A', 16: 'A', 17: 'A' });
  for (const w of aWeeks) if (w.wk < 14) w.opp = 'A';    // season 1600, window 1600
  const bWeeks = weeks({ 14: 'B', 15: 'B', 16: 'B', 17: 'B' });
  for (const w of bWeeks) if (w.wk < 14) w.opp = 'E';    // season 1300, window 1400
  const a = playoffSos(aWeeks, STRENGTH, P14);
  const b = playoffSos(bWeeks, STRENGTH, P14);

  assert.ok(a.rating < b.rating, 'the LENS would crown A');
  assert.ok(a.abs_rating > b.abs_rating, 'the ABSOLUTE slate is harder for A');
  assert.ok(a.playoff_elo > b.playoff_elo, 'A really does face the stronger opponents');

  const html = playoffEdge(a, b);
  assert.match(html, /cmp-win--b/,
    'the winner must be the player who actually faces the weaker playoff slate');
});

test('equal playoff schedules are "even", not a coin-flip winner', () => {
  const html = playoffEdge(HARD, HARD);
  assert.match(html, /cmp-edge--even/);
  assert.ok(!html.includes('cmp-win'), `an even chip must crown nobody:\n${html}`);
});

test('a missing report on EITHER side declares no winner', () => {
  for (const [a, b, why] of [
    [null, null, 'no window data'],
    [HARD, null, 'one side only'],
    [null, HARD, 'one side only'],
  ]) {
    const html = playoffEdge(a, b);
    assert.match(html, /cmp-edge--na/);
    assert.match(html, new RegExp(why));
    assert.ok(!html.includes('cmp-win'),
      `an absence must not produce a winner (${why}):\n${html}`);
    assert.ok(!html.includes('easier'), `an absence must not claim "easier":\n${html}`);
  }
});

/* ==========================================================================
   4. Ordering: rail chips line up with the rows they label
   ========================================================================== */

test('AVAILABILITY is still the FIRST metric row, above PROJ PTS (REL17)', () => {
  const labels = rowLabels(colHtml('a', metrics()));
  assert.equal(labels[0], 'AVAILABILITY');
  assert.equal(labels[1], 'PROJ PTS');
});

test('PLAYOFF SoS sits after the season SoS row and before BYE', () => {
  const labels = rowLabels(colHtml('a', metrics()));
  assert.deepEqual(labels, [
    'AVAILABILITY', 'PROJ PTS', 'RoS VALUE', 'TREND', 'SoS', 'PLAYOFF SoS', 'BYE',
  ]);
});

test('the centre rail has one chip per metric row, in the same order', () => {
  const A = metrics({ psos: EASY });
  const B = metrics({ id: 'Y', psos: HARD, proj: 11.0, sos: 2.2, bye: 11 });
  const rail = edgeLabels(midHtml(A, B));
  const rows = rowLabels(colHtml('a', A));
  assert.equal(rail.length, rows.length,
    `rail has ${rail.length} chips for ${rows.length} rows — they will mislabel`);
  assert.deepEqual(rail, ['AVAIL', 'PROJ', 'RoS', 'TREND', 'SoS', 'PLAYOFF', 'BYE']);
});

test('the column renders the playoff row for an unprojected K exactly like any other', () => {
  // K/DEF have no projection feed (R19-B5) but they DO have a schedule, so the
  // playoff row is a real reading there, not another "not projected yet".
  const html = colHtml('a', metrics({ pos: 'K', projected: false, proj: null, ros: null }));
  assert.match(html, /not projected yet/);
  assert.match(html, /W14-17/);
  assert.ok(!/PLAYOFF SoS<\/span><span class="cmp-v">[^<]*not projected/.test(html));
});

/* ==========================================================================
   5. The winner glyph matches the layout it is rendered into
   ========================================================================== */

test('winGlyph emits BOTH orientations so CSS can pick one', () => {
  const a = winGlyph(true);
  assert.match(a, /class="cmp-arrow--wide">◀</);
  assert.match(a, /class="cmp-arrow--tall">▲</);
  const b = winGlyph(false);
  assert.match(b, /class="cmp-arrow--wide">▶</);
  assert.match(b, /class="cmp-arrow--tall">▼</);
});

test('every winner chip in the view goes through winGlyph', () => {
  // A bare arrow anywhere else is a chip that will point sideways on a phone.
  // Cut winGlyph's OWN definition out (top-level fn: ends at a column-0 "}")
  // and assert no arrow glyph survives anywhere else in the module.
  const start = SRC.indexOf('export function winGlyph');
  assert.ok(start > -1, 'winGlyph is no longer exported from compare.js');
  const endRel = SRC.slice(start).indexOf('\n}\n');
  assert.ok(endRel > -1, 'could not find the end of winGlyph()');
  const rest = (SRC.slice(0, start) + SRC.slice(start + endRel + 3))
    // Comments legitimately NAME the glyphs when explaining the fix.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/[◀▶▲▼]/.test(rest),
    'a winner arrow is emitted outside winGlyph() — it will point the wrong way '
    + 'in one of the two layouts');
  // And the surviving chunk really did still contain the chip builders.
  assert.match(rest, /cmp-win--/);
});

test('theme.css hides exactly one glyph orientation per breakpoint', () => {
  assert.match(CSS, /\.cmp-arrow--tall\s*\{\s*display:\s*none/,
    'the vertical glyph must be hidden in the side-by-side (default) layout');
  const phone = /@media \(max-width: 560px\) \{[\s\S]*?\n\}/g;
  const blocks = CSS.match(phone) || [];
  const swap = blocks.find((b) => b.includes('.cmp-arrow--wide'));
  assert.ok(swap, 'no <=560px block swaps the glyph orientation');
  assert.match(swap, /\.cmp-arrow--wide\s*\{\s*display:\s*none/);
  assert.match(swap, /\.cmp-arrow--tall\s*\{\s*display:\s*inline/);
  // The breakpoint must be the SAME one that stacks the grid, or the glyph
  // flips at a width where the layout has not.
  const stack = blocks.find((b) => /\.cmp-grid\s*\{\s*grid-template-columns:\s*1fr/.test(b));
  assert.ok(stack, 'the 560px block that stacks .cmp-grid moved — re-pin the glyph swap');
});

/* ==========================================================================
   6. The player name stays WCAG-AA legible at its team tint
   ========================================================================== */

test('.cmp-name is large-text sized so a 3:1 team tint clears AA', () => {
  const rule = /\.cmp-name\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, '.cmp-name rule missing from app/theme.css');
  const size = /font-size:\s*([\d.]+)px/.exec(rule[1]);
  const weight = /font-weight:\s*(\d+)/.exec(rule[1]);
  assert.ok(size && weight, `.cmp-name must pin size and weight: ${rule[1]}`);
  // WCAG "large text" = >=18.66px bold (or >=24px). Team tints are audited at
  // 3.0:1 on --surface in contrast_aa.test.mjs, which is the LARGE-text
  // threshold — at 16px the same tint would need 4.5:1 and fail.
  assert.ok(Number(weight[1]) >= 700, `.cmp-name must be bold, got ${weight[1]}`);
  assert.ok(Number(size[1]) >= 18.66,
    `.cmp-name is ${size[1]}px: a team tint at that size needs 4.5:1, not 3:1`);
  // And the tint is still applied there (the fix must not have been a de-tint).
  assert.match(SRC, /class="cmp-name" style="color:\$\{teamTint\(m\.team\)\}"/);
});

/* ==========================================================================
   7. The window is the LEAGUE's — no hardcoded weeks in the view
   ========================================================================== */

test('compare.js reads the window from the profile, never a literal 14-17', () => {
  assert.match(SRC, /loadProfile\(\)/);
  assert.match(SRC, /playoffSos\(w, teamStrength, profile\)/);
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/playoff_week_start/.test(code),
    'the view must not reach past app/playoffs.js into the profile shape');
  assert.ok(!/\b(14|15|17)\b\s*(?:,|\)|;)/.test(code.replace(/W\$\{[^}]*\}/g, '')),
    'a week number is hardcoded in compare.js — the window belongs to the league');
});
