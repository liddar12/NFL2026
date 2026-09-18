/* tests/web/r82_myparlays_layout.spec.mjs — the MY PARLAYS card, measured.
 *
 * R82 fixed three layout faults on the MY list. Every one of them was a real
 * browser's geometry and nothing else, so this is where they are locked; the
 * markup and the CSS text are locked in tests/feature/r82_myparlays_layout.test.mjs.
 *
 * WHAT WAS WRONG (measured on the committed leg pool, seed "DET", before the fix):
 *
 *   1. THE NAME. renderCard's legs never carried `leg--annot`, so `.leg-prov`
 *      (flex-basis:100%) never wrapped to its own line and instead shared — and
 *      took — the name's flex line.
 *        desktop 1280: .leg-nm clientWidth 62px vs scrollWidth 155px  -> "J. Gibb…"
 *                      40 of 40 names clipped.
 *        phone   402: .leg-nm clientWidth 54px, "J. Gibbs 20+ rush yds" broken
 *                      across 5 lines, the leg 106px tall.
 *      AFTER: clientWidth 155px == scrollWidth at both, one line, leg 63px.
 *
 *   2. RAGGED ROWS. `.card-list` is align-items:start, so a 2-leg card beside a
 *      3-leg one ended 58px higher at 1280px (95px at 1440px) and no two footers
 *      on a row lined up. AFTER: 0px, every width.
 *
 *   3. THE FOOT WRAPPED. minmax(300px,1fr) fits FOUR 318px columns on the 1320px
 *      canvas; the `.p-foot` EV cell then wrapped — .legcount 15.9px -> 31.9px,
 *      the foot 31.9px -> 43.9px — at 1440px and again at 1100px. AFTER: 15.9px
 *      at every width, because the MY grid's minimum column is 360px.
 *
 * Plus the header, which was describing the wrong thing: MY mode kept the slate's
 * "WEEK n · MODEL EV" line and the R71 review banner ("WK n PARLAYS: 0/66 hit ·
 * legs 0/177 · 66 pending") over ten cards that are on no slate and are ranked by
 * conviction rather than EV.
 *
 * The thresholds below are deliberately loose (2 line-heights, 20px, 1px) — they
 * are there to catch the FAULT, which was off by 3 lines and 58px, not to pin a
 * font metric that a theme change may legitimately move.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_TEAM as SEED } from './_myseed.mjs';

const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const POOL_WEEK = Number(POOL.week);
// SEED is derived in _myseed.mjs (a team whose game is still upcoming); the
// measurements in the header comment were taken with "DET" before its game.

const PHONE = { width: 402, height: 874 };
const DESKTOP = { width: 1280, height: 900 };

const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

/** Open PARLAYS, note the slate header, switch to MY and seed it with `SEED`. */
async function openMyWithSeed(page, size) {
  await page.setViewportSize(size);
  await page.goto('/#/parlays');
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  // let the lazy review module land, so the banner we assert on actually exists
  await page.waitForSelector('.rv-strip--parlay', { timeout: 20000 });
  const before = {
    sub: (await page.locator('.view-sub').innerText()).trim(),
    strips: await page.locator('.rv-strip--parlay').count(),
  };

  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.fill('#mp-input', SEED);
  await page.press('#mp-input', 'Enter');
  await page.waitForSelector('.mp-card', { timeout: 20000 });
  return before;
}

/** Per-leg geometry for every leg of every painted MY card. */
const legGeometry = (page) => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.mp-card .leg').forEach((leg, i) => {
    const nm = leg.querySelector('.leg-nm');
    const prov = leg.querySelector('.leg-prov');
    if (!nm) return;
    const nb = nm.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(nm).lineHeight)
      || parseFloat(getComputedStyle(nm).fontSize) * 1.2;
    out.push({
      i,
      text: nm.textContent.trim(),
      clientWidth: nm.clientWidth,
      scrollWidth: nm.scrollWidth,
      height: nb.height,
      lineHeight: lh,
      nameBottom: nb.bottom,
      provTop: prov ? prov.getBoundingClientRect().top : null,
    });
  });
  return out;
});

/** Card bottoms grouped by the row they sit on, plus the EV cell heights. */
const gridGeometry = (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.mp-card')];
  const top = (c) => Math.round(c.getBoundingClientRect().top);
  const minTop = Math.min(...cards.map(top));
  const firstRow = cards.filter((c) => top(c) === minTop);
  return {
    cards: cards.length,
    firstRowCards: firstRow.length,
    firstRowBottoms: firstRow.map((c) => c.getBoundingClientRect().bottom),
    legcountHeights: cards
      .map((c) => c.querySelector('.p-foot .legcount'))
      .filter(Boolean)
      .map((n) => n.getBoundingClientRect().height),
    columns: getComputedStyle(document.querySelector('#mp-list')).gridTemplateColumns,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
});

/* ==========================================================================
   1. THE SELECTION NAME IS READABLE — both viewports
   ========================================================================== */

for (const [label, size] of [['iPhone 402x874', PHONE], ['desktop 1280x900', DESKTOP]]) {
  test(`R82 — ${label}: every MY leg name is whole, on one or two lines, above its why-line`, async ({ page }) => {
    const errors = errorsOf(page);
    await openMyWithSeed(page, size);

    const legs = await legGeometry(page);
    expect(legs.length, 'no MY legs were painted — the fixture seed built no cards')
      .toBeGreaterThan(0);

    for (const l of legs) {
      // (a) NOTHING IS CLIPPED. Before R82 this was 62 vs 155 at 1280px on
      //     every one of the 40 names; the ellipsis ate the line and the units,
      //     which on a prop leg is the entire bet.
      expect(l.scrollWidth,
        `"${l.text}" is clipped: clientWidth ${l.clientWidth} < scrollWidth ${l.scrollWidth}`)
        .toBeLessThanOrEqual(l.clientWidth);

      // (b) NOTHING IS STACKED ONE WORD PER LINE. At 402px the squeezed name
      //     wrapped to 5 lines and the leg stood 106px tall. Two line-heights is
      //     the generous bound: a long name legitimately taking a second line is
      //     fine, five is the fault.
      expect(l.height,
        `"${l.text}" is ${(l.height / l.lineHeight).toFixed(1)} lines tall `
        + `(${l.height}px at a ${l.lineHeight}px line-height) — the name is being `
        + 'broken word by word, which is what a squeezed .leg-nm looks like')
        .toBeLessThanOrEqual(l.lineHeight * 2 + 1);

      // (c) THE WHY-LINE SITS UNDERNEATH, not as a third inline column.
      expect(l.provTop, `leg "${l.text}" has no .leg-prov`).not.toBeNull();
      expect(l.provTop,
        `the why-line for "${l.text}" starts at y=${l.provTop}, above the name's `
        + `bottom edge y=${l.nameBottom} — it is still sharing the name's row`)
        .toBeGreaterThanOrEqual(l.nameBottom - 1);
    }

    // and the page never scrolls sideways at either width
    const g = await gridGeometry(page);
    expect(g.docScrollWidth).toBe(g.innerWidth);
    expect(errors).toEqual([]);
  });
}

/* ==========================================================================
   2. EQUAL-HEIGHT ROWS AND AN UNWRAPPED FOOT — desktop
   ========================================================================== */

test('R82 — desktop: cards on a row end at the same bottom and the EV cell stays on one line', async ({ page }) => {
  const errors = errorsOf(page);
  await openMyWithSeed(page, DESKTOP);

  const g = await gridGeometry(page);
  expect(g.columns.split(' ').filter(Boolean).length,
    `expected a multi-column MY grid at 1280px, got "${g.columns}"`)
    .toBeGreaterThan(1);
  expect(g.firstRowCards,
    'the first grid row holds one card — nothing to align, so this test proves nothing')
    .toBeGreaterThan(1);

  // Before R82 these were 58px apart: .card-list is align-items:start, so a
  // 2-leg card beside a 3-leg card simply stopped where its content stopped.
  const lo = Math.min(...g.firstRowBottoms);
  const hi = Math.max(...g.firstRowBottoms);
  expect(hi - lo,
    `cards on the first row end at ${g.firstRowBottoms.map((b) => b.toFixed(1)).join(', ')} `
    + '— their footers do not line up')
    .toBeLessThanOrEqual(1);

  // Before R82 the EV cell wrapped whenever the column got narrow (measured
  // 31.9px against a 15.9px line at 1440px and 1100px).
  for (const h of g.legcountHeights) {
    expect(h, `a .p-foot EV cell is ${h}px tall — it has wrapped to a second line`)
      .toBeLessThanOrEqual(20);
  }
  expect(errors).toEqual([]);
});

test('R82 — the MY grid never gets narrow enough to wrap the foot, at any desktop width', async ({ page }) => {
  // Root cause 3 only bites where the 1320px canvas fits four 300px columns, so
  // 1280px alone would not have caught it. 1100px and 1440px are the two widths
  // that measured a wrapped foot before the fix.
  const errors = errorsOf(page);
  await openMyWithSeed(page, DESKTOP);

  for (const width of [820, 900, 1100, 1280, 1440, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const g = await gridGeometry(page);
    const cols = g.columns.split(' ').filter(Boolean).length;
    for (const h of g.legcountHeights) {
      expect(h, `at ${width}px the MY grid is ${cols}-up ("${g.columns}") and a `
        + `.p-foot EV cell is ${h}px tall — the foot has wrapped again`)
        .toBeLessThanOrEqual(20);
    }
    const lo = Math.min(...g.firstRowBottoms);
    const hi = Math.max(...g.firstRowBottoms);
    expect(hi - lo, `at ${width}px the first row's card bottoms disagree`).toBeLessThanOrEqual(1);
    expect(g.docScrollWidth, `at ${width}px the page scrolls sideways`).toBe(g.innerWidth);
  }
  expect(errors).toEqual([]);
});

/* ==========================================================================
   3. THE HEADER AND THE REVIEW BANNER DESCRIBE WHAT IS ON SCREEN
   ========================================================================== */

for (const [label, size] of [['iPhone 402x874', PHONE], ['desktop 1280x900', DESKTOP]]) {
  test(`R82 — ${label}: MY retitles the header, hides the review banner, and puts both back`, async ({ page }) => {
    const errors = errorsOf(page);
    const before = await openMyWithSeed(page, size);

    // the committed review document does produce this banner for the slate week;
    // if it ever stops, this test would pass while proving nothing, so say so.
    expect(before.strips,
      'no .rv-strip--parlay on the slate — the committed data/review.json no '
      + 'longer renders the R71 banner, so this test is not exercising it')
      .toBe(1);
    expect(before.sub).toContain('SIM EV');

    // IN MY MODE: the pool's week, and no banner grading a slate these cards
    // are not on.
    await expect(page.locator('.view-sub')).toHaveText(`MY PARLAYS · POOL WK ${POOL_WEEK}`);
    await expect(page.locator('.rv-strip--parlay')).toBeHidden();

    // BACK ON GAME: the slate line returns exactly as it left, banner included.
    await page.click('.scopeseg [data-seg="game"]');
    await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
    await expect(page.locator('.view-sub')).toHaveText(before.sub);
    await expect(page.locator('.rv-strip--parlay')).toBeVisible();

    // and MY still retitles on a second visit (the view is mounted once)
    await page.click('.scopeseg [data-seg="my"]');
    await expect(page.locator('.view-sub')).toHaveText(`MY PARLAYS · POOL WK ${POOL_WEEK}`);
    await expect(page.locator('.rv-strip--parlay')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('R82 — the banner stays hidden even when MY is opened before the review module lands', async ({ page }) => {
  // applyParlayReview REPLACES the strip node, so a MY entry that beat the lazy
  // import used to set `hidden` on a node that was then thrown away and the
  // banner came back on top of the MY cards.
  const errors = errorsOf(page);
  await page.setViewportSize(DESKTOP);
  await page.goto('/#/parlays');
  // tap MY as early as the chip exists — do NOT wait for .rv-strip--parlay here
  await page.waitForSelector('.scopeseg [data-seg="my"]', { timeout: 20000 });
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.fill('#mp-input', SEED);
  await page.press('#mp-input', 'Enter');
  await page.waitForSelector('.mp-card', { timeout: 20000 });
  // give the review import every chance to land and re-insert its strip
  await page.waitForTimeout(1500);

  const strip = page.locator('.rv-strip--parlay');
  if (await strip.count()) await expect(strip).toBeHidden();
  await expect(page.locator('.view-sub')).toHaveText(`MY PARLAYS · POOL WK ${POOL_WEEK}`);
  expect(errors).toEqual([]);
});
