/* tests/feature/r82_myparlays_layout.test.mjs — the MY PARLAYS card layout.
 *
 * R82 fixed three faults that were each invisible to every test in the gate,
 * because each of them is a LAYOUT fault and the suite had no reader of the one
 * declaration that caused it. What was wrong, measured in a real browser:
 *
 *   1. THE SELECTION NAME WAS UNREADABLE. renderCard emitted `<div class="leg">`
 *      without `leg--annot`. `.leg-prov` (the why-line) is `flex-basis:100%` by
 *      design and only reaches its own line when the parent wraps; without the
 *      wrap it stayed on the name's flex line and, being shrinkable, took it.
 *      Measured: `.leg-nm` clientWidth 62px against a 155px name at 1280px
 *      ("J. Gibb…"), and 54px at 402px, where the name broke one word per line —
 *      5 lines for "J. Gibbs 20+ rush yds", a 106px-tall leg.
 *   2. RAGGED ROWS. `.card-list` is `align-items:start`, so a 2-leg card beside
 *      a 3-leg one left their bottoms 58px apart at 1280px and no footer on a
 *      row lined up with its neighbours.
 *   3. THE FOOT WRAPPED. `minmax(300px,1fr)` put four columns on the 1320px
 *      canvas (318px each) and the EV cell wrapped to a second line.
 *
 * Plus the header: MY mode kept the slate's "WEEK n · MODEL EV" subtitle and the
 * R71 review banner, both of which describe the published slate that none of the
 * MY cards are on.
 *
 * WHAT THIS FILE LOCKS is the half that is checkable without a browser: the
 * markup renderCard emits, the exact subtitle strings, and the CSS declarations
 * the fix consists of (read as text, the way r24b_layout.test.mjs reads them).
 * The geometry itself — widths, line counts, row bottoms, a foot that does not
 * wrap — is measured in tests/web/r82_myparlays_layout.spec.mjs, which is where
 * a layout claim can actually be proved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { renderCard } from '../../app/views/myparlays.js';
import { mySubText } from '../../app/views/parlays.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(ROOT, 'app/theme.css'), 'utf8');
const HIG = readFileSync(join(ROOT, 'app/theme-hig.css'), 'utf8');

/** A card of the shape buildCards produces, with a long prop selection — the
 *  case that actually broke. Two props and a moneyline so both why-line shapes
 *  (projection-vs-line and book-price-vs-ours) are rendered. */
const CARD = {
  tier: 'medium',
  sameGame: false,
  model: 0.31,
  ev: -0.092,
  payout: 322,
  assumed: 2,
  legs: [
    {
      selection: 'J. Smith-Njigba 60+ receiving yards',
      market: 'wr_rec_yds', model_prob: 0.58, implied_prob: 0.62, priced: false,
      mu: 71.4, line: 59.5, availability: 'QUESTIONABLE',
    },
    {
      selection: 'J. Gibbs 20+ rush yds',
      market: 'rb_rush_yds', model_prob: 0.77, implied_prob: 0.81, priced: false,
      mu: 39.8, line: 19.5,
    },
    {
      selection: 'DET ML',
      market: 'moneyline', model_prob: 0.69, implied_prob: 0.66, priced: true,
    },
  ],
};

/** Every `class="leg …"` attribute renderCard emitted, in order. */
function legClassAttrs(html) {
  return [...html.matchAll(/class="(leg(?:\s[^"]*)?)"/g)].map((m) => m[1]);
}

/* ==========================================================================
   1. EVERY MY LEG CARRIES THE WRAP CLASS
   ========================================================================== */

test('renderCard puts leg--annot on every leg, so the why-line gets its own line', () => {
  const html = renderCard(CARD, 0);
  const attrs = legClassAttrs(html);

  assert.equal(attrs.length, CARD.legs.length,
    `expected one .leg per leg, got ${attrs.length} for ${CARD.legs.length} legs`);
  for (const [i, cls] of attrs.entries()) {
    assert.ok(cls.split(/\s+/).includes('leg--annot'),
      `leg ${i} rendered class="${cls}" — without leg--annot the parent never `
      + 'wraps, .leg-prov (flex-basis:100%) stays on the name\'s flex line and '
      + 'squeezes .leg-nm to a fraction of the name (measured 62px of 155px at '
      + '1280px, 54px at 402px). R82.');
  }
});

test('every leg still renders its name, odds and why-line, in that order', () => {
  const html = renderCard(CARD, 0);
  // The wrap only works because .leg-prov is the LAST child of .leg: it reaches
  // its own line by being pushed there, so an order change silently undoes R82.
  const order = [...html.matchAll(/class="(leg-nm|leg-od|leg-prov)"/g)].map((m) => m[1]);
  assert.deepEqual(order, [
    'leg-nm', 'leg-od', 'leg-prov',
    'leg-nm', 'leg-od', 'leg-prov',
    'leg-nm', 'leg-od', 'leg-prov',
  ], 'the why-line must stay the last child of .leg');
  // and the long name is emitted whole — nothing truncates it in the markup
  assert.ok(html.includes('J. Smith-Njigba 60+ receiving yards'),
    'the full selection must reach the DOM; any shortening is the CSS\'s job, '
    + 'and R82 removed the ellipsis on MY cards precisely so it does not happen');
});

/* ==========================================================================
   2. THE MY-MODE SUBTITLE
   ========================================================================== */

test('mySubText is exactly "MY PARLAYS · POOL WK n"', () => {
  assert.equal(mySubText(2), 'MY PARLAYS · POOL WK 2');
  assert.equal(mySubText(14), 'MY PARLAYS · POOL WK 14');
});

test('mySubText never claims MODEL EV, a WEEK, or an ARCHIVED state', () => {
  const s = mySubText(2);
  // MY cards are ranked by conviction, not EV — the slate line said otherwise.
  assert.ok(!s.includes('MODEL EV'), `MY subtitle must not claim MODEL EV: ${s}`);
  // "WEEK n" is the slate's published week; MY cards were never on a slate.
  assert.ok(!/\bWEEK\b/.test(s), `MY subtitle must not read as the slate week: ${s}`);
  // The pool is only ever built for the current week, so no pill can apply.
  assert.ok(!s.includes('ARCHIVED'), `MY subtitle must carry no ARCHIVED pill: ${s}`);
  assert.ok(!/[<>]/.test(s),
    'mySubText is written with textContent, so it must contain no markup');
});

test('a missing week degrades to the label, never to "null" or "undefined"', () => {
  for (const v of [null, undefined]) {
    const s = mySubText(v);
    assert.ok(s.startsWith('MY PARLAYS · POOL WK'), `got ${s}`);
    assert.ok(!/null|undefined|NaN/.test(s),
      `an unknown week must not be printed as a value: ${s}`);
  }
});

/* ==========================================================================
   3. THE MY-MODE CHROME: THE REVIEW BANNER IS HIDDEN WITH THE REST
   ========================================================================== */

test('the R71 review strip is in the list of chrome MY mode hides', () => {
  const src = readFileSync(join(ROOT, 'app/views/parlays.js'), 'utf8');
  const m = src.match(/const myChrome = \[([\s\S]*?)\];/);
  assert.ok(m, 'myChrome list not found in app/views/parlays.js');
  assert.ok(m[1].includes("'.rv-strip--parlay'"),
    'MY mode must hide .rv-strip--parlay. The R71 banner ("WK n PARLAYS: 0/66 '
    + 'hit · …") is a SIBLING of #parlays-list, not a child, so hiding the list '
    + 'left it on screen grading a slate the MY cards are not on. R82.');
  // the selector the banner is actually rendered with, so a rename reds here
  const review = readFileSync(join(ROOT, 'app/review.js'), 'utf8');
  assert.ok(review.includes('rv-strip rv-strip--parlay'),
    'app/review.js no longer renders .rv-strip--parlay — update myChrome');
});

test('leaving MY mode restores the slate subtitle through the same archived test', () => {
  const src = readFileSync(join(ROOT, 'app/views/parlays.js'), 'utf8');
  assert.ok(/function archivedFor\(week\)/.test(src),
    'archivedFor is what makes the restored subtitle EXACT rather than a second '
    + 'copy of the ARCHIVED condition that can drift from syncWeekChrome\'s');
  assert.ok(/exitMyMode[\s\S]*?subText\(selWeek, archivedFor\(selWeek\)\)/.test(src),
    'exitMyMode must restore subText(week, archived) with the SAME archived '
    + 'test selectWeek uses, so the ARCHIVED pill comes back as it left');
  assert.ok(/syncWeekChrome\(week, archivedFor\(week\)\)/.test(src),
    'selectWeek must read the archived state through archivedFor too, or the '
    + 'two paths can disagree about the same week');
});

/* ==========================================================================
   4. THE CSS THE FIX CONSISTS OF
   ========================================================================== */

/** The body of the FIRST rule whose selector list matches `selector`. */
function ruleBody(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

test('MY leg names wrap instead of ellipsizing, at every width', () => {
  const body = ruleBody(CSS, '.mp-card .leg-nm');
  assert.ok(body, '.mp-card .leg-nm rule missing from app/theme.css');
  assert.match(body, /white-space:\s*normal/,
    'a MY leg name must wrap: the line and its units are IN the name, so an '
    + 'ellipsis eats the number the card exists to state');
  assert.match(body, /overflow:\s*visible/,
    'overflow must be visible too — .leg-nm sets overflow:hidden with '
    + 'text-overflow:ellipsis, and leaving it hidden clips the wrapped line');
});

test('the SLATE keeps its own ellipsized leg name — R82 is scoped to MY', () => {
  // The base rule is deliberately untouched: the slate's legs are short game
  // legs in a denser list, and nothing in R82 was measured against them.
  const base = ruleBody(CSS, '\n.leg-nm {');
  assert.ok(base, 'base .leg-nm rule missing from app/theme.css');
  assert.match(base, /white-space:\s*nowrap/,
    'the base .leg-nm must still be nowrap; R82 overrides it only under .mp-card');
  assert.match(base, /text-overflow:\s*ellipsis/);
});

test('the MY grid uses a 360px minimum column at BOTH desktop breakpoints', () => {
  const rules = [...CSS.matchAll(/#mp-list\.card-list\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 2,
    `expected two #mp-list.card-list rules (the 820px and 1200px breakpoints), `
    + `found ${rules.length}`);
  for (const [i, body] of rules.entries()) {
    assert.match(body, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(360px,\s*1fr\)\)/,
      `#mp-list.card-list rule ${i} must pin a 360px minimum column. At the `
      + 'inherited 300px the 1320px canvas fits FOUR 318px columns and the '
      + '.p-foot EV cell wraps to a second line (measured: .legcount 15.9px -> '
      + '31.9px at 1440px and 1100px). 360px gives 3-up at 1320px, 2-up at '
      + '~800-1100px, and a foot that fits. R82.');
    assert.ok(!/minmax\(3[02]0px/.test(body),
      `#mp-list.card-list rule ${i} still carries the old 300/320px minimum`);
  }
  // both must sit inside a min-width media query, not leak to the phone
  for (const w of ['820px', '1200px']) {
    const at = CSS.indexOf(`@media (min-width: ${w})`);
    assert.ok(at >= 0, `@media (min-width: ${w}) block missing`);
  }
});

test('the SLATE grid keeps its own 320/300px columns', () => {
  assert.match(CSS, /\.card-list\s*\{[^}]*minmax\(320px,\s*1fr\)/,
    'the shared .card-list must still be 320px at 820px — R82 widened #mp-list only');
  assert.match(CSS, /\.card-list\s*\{\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(300px,\s*1fr\)\)/,
    'the shared .card-list must still be 300px at 1200px');
});

test('MY cards stretch to their row and anchor the foot to the card bottom', () => {
  const grid = [...CSS.matchAll(/#mp-list\.card-list\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(grid.some((b) => /align-items:\s*stretch/.test(b)),
    'the MY grid must override .card-list\'s align-items:start, or cards in a '
    + 'row keep their own heights and no two footers line up (measured 58px '
    + 'apart at 1280px, 95px at 1440px). R82.');
  const foot = ruleBody(CSS, '.mp-card .p-foot');
  assert.ok(foot, '.mp-card .p-foot rule missing from app/theme.css');
  assert.match(foot, /margin-top:\s*auto/,
    'stretching the card is only half of it: the foot must be pushed to the '
    + 'card bottom, or a stretched card just grows empty space under its legs. '
    + '.parlay is already display:flex/column, so an auto margin is the whole '
    + 'mechanism — and it carries the optional .corr note down with it.');
});

test('the EV cell is pinned to one line so the foot can never wrap again', () => {
  const body = ruleBody(CSS, '.mp-card .legcount');
  assert.ok(body, '.mp-card .legcount rule missing from app/theme.css');
  assert.match(body, /white-space:\s*nowrap/,
    '"-9.2% EV" must stay on one line: .p-foot is a baseline flex row and a '
    + 'wrapped EV cell is what made the foot 43.9px instead of 31.9px');
});

test('theme-hig.css does not override the declarations R82 relies on', () => {
  // The HIG sheet restyles .leg, .leg-nm, .card-list and .p-foot, so the fix is
  // only real if it touches NONE of the properties R82 sets. If that ever
  // changes, the two sheets have to be kept in sync and this test says so.
  const guards = [
    [/\[data-theme="hig"\][^{]*\.leg-nm\s*\{[^}]*white-space/, '.leg-nm white-space'],
    [/\[data-theme="hig"\][^{]*\.leg\s*\{[^}]*flex-wrap/, '.leg flex-wrap'],
    [/\[data-theme="hig"\][^{]*\.card-list\s*\{[^}]*grid-template-columns/, '.card-list columns'],
    [/\[data-theme="hig"\][^{]*\.card-list\s*\{[^}]*align-items/, '.card-list align-items'],
    [/\[data-theme="hig"\][^{]*\.p-foot\s*\{[^}]*margin-top/, '.p-foot margin-top'],
  ];
  for (const [re, what] of guards) {
    assert.ok(!re.test(HIG),
      `app/theme-hig.css now sets ${what}; it would beat or fight the R82 rule `
      + 'in app/theme.css — mirror the R82 block there or re-scope it');
  }
});
