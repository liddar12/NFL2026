/* tests/feature/r24b_layout.test.mjs — R24-B carried findings, locked.
 *
 * Six deferred findings against app/views/lineup.js and app/views/compare.js,
 * every one of them re-reproduced before it was touched. This file locks the
 * STRUCTURE of each fix in the dependency-free fast gate; tests/web/
 * r24b_layout.spec.mjs measures the same six in a real browser (client rects,
 * request log, touch-target box), because a layout bug is ultimately a geometry
 * claim and a source assertion alone would let it come back through CSS.
 *
 * The findings, and what a regression would look like:
 *   1. .lu-move is a THREE-COLUMN GRID and the net-gain row's three child nodes
 *      were laid out as three CELLS — "Switching to the optimal   +8.8 pts
 *      this week." with "lineup adds" wrapped underneath. Regression: the
 *      sentence goes back to being loose children of .lu-move.
 *   2. The lineup card head's title was an ANONYMOUS text flex item beside
 *      .lu-total, so the container broke it mid-phrase at 402px ("OPTIMAL
 *      LINEUP · WEEK" / "1" orphaned beside the total). Regression: the title
 *      stops being its own element, or loses white-space:nowrap.
 *   3. Every Lineup mount awaited the ~59KB K/DST contract, including the
 *      default 7-starter league that has no K/DEF slot and cannot even bench a
 *      kicker. Regression: the fetch goes back to unconditional.
 *   4. Both Compare finders had ONE shared placeholder and no accessible name.
 *      Regression: the <label for> disappears or both sides say the same thing.
 *   5. The Compare "change" control was a ~54x18 target against the project's
 *      44px minimum. Regression: the pill goes back to being the button.
 *   6. The Compare centre rail was a separate column offset by a fixed
 *      padding-top, drifting ~10px per metric row. Regression: the rail stops
 *      sharing the metric grid, or the row count stops being read off the
 *      rendered column.
 *
 * NOT re-litigated here (see the release notes): the winner glyph already emits
 * both orientations (R21-B3) and .cmp-name is already 19px/800 large text — both
 * were re-checked against the shipped source and did NOT reproduce.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { colHtml } from '../../app/views/compare.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LINEUP = readFileSync(join(REPO_ROOT, 'app/views/lineup.js'), 'utf8');
const COMPARE = readFileSync(join(REPO_ROOT, 'app/views/compare.js'), 'utf8');
const CSS = readFileSync(join(REPO_ROOT, 'app/theme.css'), 'utf8');

/** A metrics object of the shape mountCompare's metricsFor() builds. */
const metrics = (over = {}) => ({
  id: 'X', name: 'Test Player', pos: 'WR', team: 'KC', projected: true,
  proj: 14.2, avail: null, ros: 120.5, sos: 3.1, psos: null, bye: 9,
  trend: null, trendVal: 0.8, ...over,
});

/* ==========================================================================
   1. THE NET-GAIN SENTENCE IS ONE GRID ITEM
   ========================================================================== */

test('the START/SIT net-gain sentence is a single element, not three grid cells', () => {
  // The whole sentence — lead-in, the <b> gain, and the trailing clause — lives
  // inside one wrapper, so .lu-move's three columns see ONE item. The source is
  // a concatenation, so the region is read from the row's opening tag to the
  // wrapper's close and then stripped of the JS quoting between the parts.
  const region = /<div class="lu-move lu-move--net">([\s\S]*?)this week\.<\/span><\/div>/.exec(LINEUP);
  assert.ok(region, 'the net-gain row must still exist in lineup.js');
  const inner = region[1].replace(/'\s*\n?\s*\+\s*[`']/g, '');
  assert.match(inner, /^<span class="lu-move-net-txt">/,
    'the sentence must open ONE wrapper element immediately inside the row');
  assert.match(inner, /lu-move-gain/,
    'the +N pts <b> must sit inside that wrapper, not beside it as a second cell');
  assert.ok(!inner.slice(1).includes('</span>'),
    `nothing may close the wrapper early:\n${inner}`);
});

test('.lu-move--net is block flow, so the sentence wraps as prose', () => {
  assert.match(CSS, /\.lu-move--net\s*\{[^}]*display:\s*block/,
    '.lu-move--net must escape the 3-column .lu-move grid');
  // ...and the grid the START/SIT rows need is untouched.
  assert.match(CSS, /\.lu-move\s*\{[^}]*grid-template-columns:\s*1fr auto auto/,
    '.lu-move itself must keep its three columns');
});

/* ==========================================================================
   2. THE CARD HEAD TITLE IS ITS OWN FLEX ITEM
   ========================================================================== */

test('the lineup card head title is one element, never an anonymous text item', () => {
  assert.match(LINEUP, /<div class="m-head"><span class="lu-title">OPTIMAL LINEUP · WEEK \$\{wk\}<\/span>/,
    'the title must be wrapped so the flex container cannot break it mid-phrase');
  // The total is still the second item and still carries the coverage line.
  assert.match(LINEUP, /<span class="lu-total">/);
  assert.match(LINEUP, /<span class="lu-cover"/);
});

test('.lu-title never wraps, and the head lets the TOTAL move instead', () => {
  assert.match(CSS, /\.lu-title\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(CSS, /\.lu-card \.m-head\s*\{[^}]*flex-wrap:\s*wrap/,
    'when the phrase and the number cannot share a line, the number must wrap whole');
  assert.match(CSS, /\.lu-card \.m-head \.lu-total\s*\{[^}]*margin-left:\s*auto/,
    'a wrapped total must stay on the right, where it has always been');
});

/* ==========================================================================
   3. THE K/DST CONTRACT IS FETCHED ONLY WHEN IT CAN BE USED
   ========================================================================== */

test('getKdstProjections is behind the league/roster test, not unconditional', () => {
  assert.match(LINEUP, /wantsKdst \? getKdstProjections\(\) : Promise\.resolve\(null\)/,
    'the blocking fetch must be conditional');
  assert.ok(!/getPlayerProjections\(\), getPlayerWeekly\(\), getGamePredictions\(\),\s*getKdstProjections\(\)/
    .test(LINEUP), 'the unconditional fetch must be gone');
  // The condition reads the LEAGUE (positions actually in play) and the SAVED
  // roster's slot keys — the profile alone would drop a stale kicker.
  assert.match(LINEUP, /rosterPositionsInPlay\(profile\)/);
  assert.match(LINEUP, /Object\.keys\(slots\)\.some\(\(k\) => KDST_TOKEN\.test/);
  assert.match(LINEUP, /const KDST_TOKEN = \/\^\(K\|DEF\|DST\)\\d\*\$\//);
});

test('an id that resolves through NEITHER feed still asks for the contract', () => {
  // The one case the cheap test cannot see: a K parked on a BENCH slot under a
  // league that has since dropped the position. Dropping him unseen would be the
  // phantom-row bug in reverse, so the fetch happens lazily rather than never.
  assert.match(LINEUP, /if \(!wantsKdst && slots\) \{[\s\S]*?!byId\.has\(id\)[\s\S]*?getKdstProjections\(\)/,
    'the fallback fetch must run when a roster id resolves through neither feed');
  assert.match(LINEUP, /const kdst = shapeKdst\(kdstDoc, profile\);/,
    'shapeKdst must read the possibly-late document, not the settled result directly');
});

/* ==========================================================================
   4. THE FINDERS HAVE REAL, DISTINCT ACCESSIBLE NAMES
   ========================================================================== */

test('each Compare finder is labelled, and the two labels differ', () => {
  const a = colHtml('a', null);
  const b = colHtml('b', null);
  for (const [side, html] of [['a', a], ['b', b]]) {
    const input = new RegExp(`<input class="cmp-find" id="cmp-find-${side}"`);
    assert.match(html, input, `side ${side} input must carry a stable id`);
    assert.match(html, new RegExp(`<label class="cmp-find-lbl" for="cmp-find-${side}">`),
      `side ${side} must have a <label for> pointing at its own input`);
  }
  const nameOf = (html) => /<label class="cmp-find-lbl" for="[^"]*">([^<]*)<\/label>/.exec(html)[1];
  assert.equal(nameOf(a), 'FIRST PLAYER');
  assert.equal(nameOf(b), 'SECOND PLAYER');
  assert.notEqual(nameOf(a), nameOf(b),
    'two identically named search boxes are the bug this fixes');
  // The placeholder may stay as a hint, but it is no longer the only name.
  assert.match(a, /placeholder="Search player…"/);
});

/* ==========================================================================
   5. THE "change" CONTROL IS A 44px TARGET
   ========================================================================== */

test('the swap control wraps its pill so the BUTTON is the target', () => {
  const html = colHtml('a', metrics());
  assert.match(html, /<button type="button" class="cmp-swap" data-side="a" data-act="cmp-clear"><span class="cmp-swap-pill">change<\/span><\/button>/,
    'the pill must be an inner span of the button');
  assert.match(CSS, /\.cmp-swap\s*\{[^}]*min-height:\s*44px/,
    'the button must meet the 44px minimum touch target');
  assert.match(CSS, /\.cmp-swap-pill\s*\{[^}]*border-radius:\s*999px/,
    'the pill keeps the look the button used to carry');
  // The click delegation still resolves from the inner span upward.
  assert.match(COMPARE, /e\.target\.closest\('\[data-act="cmp-clear"\]'\)/);
});

/* ==========================================================================
   6. THE CENTRE RAIL SHARES THE ROWS IT ANNOTATES
   ========================================================================== */

test('the rail is aligned by shared grid rows, not a fixed padding-top', () => {
  assert.match(COMPARE, /cmp-grid--aligned/,
    'the view must opt the grid into row alignment when both sides are chosen');
  assert.match(COMPARE, /--cmp-rows:\$\{metricRows\}/,
    'the row count must be written into the grid');
  assert.match(COMPARE, /colA\.match\(\/class="cmp-metric\/g\)/,
    'the row count must be READ OFF the rendered column, never hardcoded');
  assert.match(CSS, /\.cmp-grid--aligned[\s\S]{0,400}grid-template-rows:\s*auto repeat\(var\(--cmp-rows/,
    'the shared grid must size its rows from that count');
  assert.match(CSS, /\.cmp-grid--aligned > \.cmp-mid \{[\s\S]{0,200}grid-template-rows:\s*subgrid/,
    'the rail must be a subgrid of the metric rows');
  assert.match(CSS, /\.cmp-grid--aligned > \.cmp-mid \{[\s\S]{0,200}padding-top:\s*0/,
    'the fixed 62px offset must be gone in the aligned layout');
  // Half-applying is worse than not applying: a browser with no subgrid would
  // drop the offset without gaining the shared rows, so the whole block is
  // guarded and such a browser keeps exactly the layout it has today.
  assert.match(CSS, /@supports \(grid-template-rows: subgrid\) \{[\s\S]{0,120}\.cmp-grid--aligned \{/,
    'the aligned rules must sit behind an @supports subgrid guard');
  // Phone layout untouched: EVERY aligned rule sits inside the >=561px media
  // query. Brace-matched rather than pattern-guessed, because "it appears after
  // an @media line" would also be true of a rule that fell out of the block.
  const first = CSS.indexOf('.cmp-grid--aligned {');
  const open = CSS.lastIndexOf('@media (min-width: 561px) {', first);
  assert.ok(open !== -1 && open < first, 'the aligned rules must follow a >=561px @media opener');
  let depth = 0; let end = -1;
  for (let i = CSS.indexOf('{', open); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > first, 'the >=561px media block must not close before the aligned rules');
  const outside = CSS.slice(end).includes('.cmp-grid--aligned');
  assert.ok(!outside, 'no .cmp-grid--aligned rule may sit outside the >=561px media query');
});

test('the rail emits exactly one chip per metric row it must line up with', () => {
  // The count the view writes into --cmp-rows is the count of rows it rendered,
  // so this is the invariant that makes the CSS correct for any future row.
  const html = colHtml('a', metrics());
  const rows = (html.match(/class="cmp-metric/g) || []).length;
  assert.equal(rows, 7, 'AVAIL, PROJ, RoS, TREND, SoS, PLAYOFF SoS, BYE');
  // midHtml's chip count is locked against this in compare_view.test.mjs; here we
  // only prove the number the view measures is the number of metric rows.
  assert.equal((colHtml('b', metrics()).match(/class="cmp-metric/g) || []).length, rows,
    'both columns must render the same rows or no alignment is possible');
});
