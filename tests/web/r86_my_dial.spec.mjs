/* tests/web/r86_my_dial.spec.mjs — the MY PARLAYS risk dial and list, measured.
 *
 * R86 has two halves and both are only provable in a real browser.
 *
 * THE DIAL. Before R86 every rung of every player competed for a conviction
 * ranking, and because a ladder is a set of nested events (clearing 60 clears
 * 20) the answer was always the ladder floor: 1,280 of 1,280 prop legs across
 * all 32 team seeds sat at the player's lowest line, and the best 2-leg DET card
 * read "J. Gibbs 20+ rush yds · J. Cook III 30+ rush yds — 82% CONVICTION,
 * +$10 $100 SIM NET". One rung per player now reaches the search, chosen by a
 * dial the viewer sets, so the three settings have to produce three different
 * sets of legs on screen and the choice has to survive a reload.
 *
 * THE LAYOUT, measured at 1395x704 dark before the fix:
 *   RC-L1  83px of void between the last leg and the footer inside the SHORTER
 *          card of every mixed row (5 of 10 cards) — R82 stretches the row and
 *          anchors .p-foot, and a 2-leg card beside a 3-leg one pays for it.
 *   RC-L2  0px between the seed chips and the legend, and 0px between the legend
 *          and the grid: #myparlays-host is one .view child and the .view gap
 *          never reached its own children.
 *   RC-L3  three columns at 1395px split the five leg-count PAIRS the list is
 *          built as, which is what made every row a mixed row.
 * AFTER: void 12px on all ten cards at 402, 1280 and 1395; a 12px gap between
 * every pair of host children; two columns; five "N LEGS" eyebrows.
 *
 * TEN CARDS IS THE FULL-SLATE NUMBER, NOT A CONSTANT. R83 caps a card at two
 * legs from one game, so a 6-leg card needs three unplayed games, and late on
 * 2026-09-20 — two of week 2's sixteen games left — MY correctly built 6 cards
 * under 3 eyebrows and these seven assertions went red with no code change.
 * The counts now come from _myseed.mjs, derived from the same committed
 * schedule the seed is: on a full slate they are still exactly ten and five.
 */

import { test, expect } from '@playwright/test';
import {
  SEED_TEAM as SEED, EXPECTED_CARDS, EXPECTED_BANDS, EXPECTED_BAND_TEXT, UPCOMING_GAMES,
  SKIP_REASON,
} from './_myseed.mjs';

/* The MY tests need a game that has not kicked off; between the last game of a
 * week and the next week's pool there is none, and MY correctly offers nothing.
 * The reason names that condition, so a skipped run reads as a finished slate
 * rather than a broken suite. It is '' whenever any game is upcoming. */
test.skip(() => Boolean(SKIP_REASON), SKIP_REASON || 'the slate is live');


// The seed and the list's shape are both derived (a team whose game is still
// upcoming; the card and band counts that slate can build), never hard-coded: a
// fixed team goes dark the moment its game kicks off, and a fixed ten goes wrong
// the moment the slate runs below three unplayed games. See _myseed.mjs.
const PHONE = { width: 402, height: 874 };
const SIZES = [
  ['iPhone 402x874', PHONE],
  ['desktop 1280x900', { width: 1280, height: 900 }],
  ['desktop 1395x704', { width: 1395, height: 704 }],
];
/** Every width at or above the two-column breakpoint. */
const isWide = (size) => size.width >= 820;

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

/** Open PARLAYS, switch to MY and seed it with the derived upcoming team. */
async function openMy(page, size) {
  await page.setViewportSize(size);
  await page.goto('/#/parlays');
  await page.waitForSelector('.scopeseg [data-seg="my"]', { timeout: 20000 });
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.fill('#mp-input', SEED);
  await page.press('#mp-input', 'Enter');
  await page.waitForSelector('.mp-card', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
}

/** Everything R86 claims about the painted list, read in one pass. */
const geometry = (page) => page.evaluate(() => {
  const host = document.querySelector('#myparlays-host');
  const cards = [...document.querySelectorAll('.mp-card')];
  const rows = new Map();
  for (const c of cards) {
    const key = Math.round(c.getBoundingClientRect().top);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(c.getBoundingClientRect().bottom);
  }
  const children = [...host.children].filter((n) => n.getBoundingClientRect().height > 0);
  const gaps = [];
  for (let i = 1; i < children.length; i += 1) {
    const a = children[i - 1].getBoundingClientRect();
    const b = children[i].getBoundingClientRect();
    gaps.push({
      from: children[i - 1].id || children[i - 1].className,
      to: children[i].id || children[i].className,
      gap: b.top - a.bottom,
    });
  }
  return {
    cards: cards.length,
    bands: document.querySelectorAll('#mp-list .mp-band').length,
    bandText: [...document.querySelectorAll('#mp-list .mp-band')].map((n) => n.textContent.trim()),
    columns: getComputedStyle(document.querySelector('#mp-list')).gridTemplateColumns,
    gaps,
    voids: cards.map((c, i) => ({
      i,
      void: c.querySelector('.p-foot').getBoundingClientRect().top
        - c.querySelector('.legs').getBoundingClientRect().bottom,
    })),
    rowSpreads: [...rows.values()].map((b) => ({ n: b.length, spread: Math.max(...b) - Math.min(...b) })),
    names: [...document.querySelectorAll('.mp-card .leg-nm')].map((n) => ({
      text: n.textContent.trim(),
      clientWidth: n.clientWidth,
      scrollWidth: n.scrollWidth,
      lines: n.getBoundingClientRect().height
        / (parseFloat(getComputedStyle(n).lineHeight) || parseFloat(getComputedStyle(n).fontSize) * 1.2),
    })),
    selections: [...document.querySelectorAll('.mp-card .leg-nm')].map((n) => n.textContent.trim()).join(' | '),
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
});

/* ==========================================================================
   1. THE DIAL IS ON SCREEN, DEFAULTS TO EVEN, AND CHANGES THE CARDS
   ========================================================================== */

for (const [label, size] of SIZES) {
  test(`R86 — ${label}: the dial defaults to EVEN and each setting picks different lines`, async ({ page }) => {
    const errors = watch(page);
    await openMy(page, size);

    // the chip row sits between the seeds and the legend, and is a real group
    const dial = page.locator('.mp-dial');
    await expect(dial).toHaveAttribute('role', 'group');
    await expect(dial).toHaveAttribute('aria-label', 'Risk dial');
    await expect(dial.locator('button')).toHaveCount(3);
    await expect(dial.locator('[data-dial="safe"]')).toHaveText('SAFE');
    await expect(dial.locator('[data-dial="even"]')).toHaveText('EVEN');
    await expect(dial.locator('[data-dial="longshot"]')).toHaveText('LONGSHOT');
    await expect(dial.locator('[data-dial="even"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(dial.locator('[data-dial="safe"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(dial.locator('[data-dial="longshot"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.mp-dial .leg-chip--active')).toHaveCount(1);

    const even = await geometry(page);
    expect(even.cards,
      `the ${SEED} seed must build ${EXPECTED_CARDS} cards on a ${UPCOMING_GAMES}-game slate`)
      .toBe(EXPECTED_CARDS);

    await page.click('.mp-dial [data-dial="longshot"]');
    await expect(dial.locator('[data-dial="longshot"]')).toHaveAttribute('aria-pressed', 'true');
    const longshot = await geometry(page);
    expect(longshot.cards).toBe(EXPECTED_CARDS);
    expect(longshot.selections,
      'LONGSHOT painted exactly the same legs as EVEN — the dial is not reaching '
      + 'the search, which is the whole of R86')
      .not.toBe(even.selections);

    await page.click('.mp-dial [data-dial="safe"]');
    await expect(dial.locator('[data-dial="safe"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(dial.locator('[data-dial="longshot"]')).toHaveAttribute('aria-pressed', 'false');
    const safe = await geometry(page);
    expect(safe.cards).toBe(EXPECTED_CARDS);
    expect(safe.selections, 'SAFE and LONGSHOT painted the same legs').not.toBe(longshot.selections);
    expect(safe.selections, 'SAFE and EVEN painted the same legs').not.toBe(even.selections);

    expect(errors).toEqual([]);
  });
}

test('R86 — the chosen dial survives a reload (it is the viewer\'s, not the session\'s)', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await page.click('.mp-dial [data-dial="longshot"]');
  await expect(page.locator('.mp-dial [data-dial="longshot"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('nfl2026.myparlays.dial.v1')))
    .toBe('longshot');

  await page.reload();
  await page.waitForSelector('.scopeseg [data-seg="my"]', { timeout: 20000 });
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await expect(page.locator('.mp-dial [data-dial="longshot"]'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mp-dial [data-dial="even"]')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

/* ==========================================================================
   2. THE LAYOUT: RHYTHM, BANDS, TWO COLUMNS, NO VOID
   ========================================================================== */

for (const [label, size] of SIZES) {
  test(`R86 — ${label}: 12px rhythm, one eyebrow per leg-count band, and no void under any card`, async ({ page }) => {
    const errors = watch(page);
    await openMy(page, size);
    const g = await geometry(page);

    // RC-L2 — every consecutive pair of host children sits 12px apart. With a
    // seed typed the chain is input -> seed chips -> dial -> legend -> grid;
    // before R86 the last two gaps were 0px and the first was 8px.
    expect(g.gaps.length, `the MY host has ${g.gaps.length + 1} visible children`)
      .toBeGreaterThanOrEqual(4);
    for (const { from, to, gap } of g.gaps) {
      expect(Math.abs(gap - 12),
        `${from} -> ${to} is ${gap.toFixed(1)}px apart, not the 12px host rhythm`)
        .toBeLessThanOrEqual(1);
    }

    // the band eyebrows: one per leg-count pair, five for ten cards on a full slate
    expect(g.cards).toBe(EXPECTED_CARDS);
    expect(g.bands,
      `expected ${EXPECTED_BANDS} leg-count eyebrows, got ${g.bandText.join(' / ')}`)
      .toBe(EXPECTED_BANDS);
    expect(g.bandText).toEqual(EXPECTED_BAND_TEXT);

    // RC-L1 — the void. 83px on 5 of 10 cards at 1395px before R86.
    for (const v of g.voids) {
      expect(v.void, `card ${v.i} has ${v.void.toFixed(1)}px between its last leg and its footer`)
        .toBeLessThanOrEqual(12.5);
    }

    // RC-L3 — exactly two columns on desktop, one leg-count band per row, and
    // the two cards of a row still end level (R82's property, now free).
    const tracks = g.columns.split(' ').filter(Boolean);
    if (isWide(size)) {
      expect(tracks.length, `expected a 2-up MY grid at ${size.width}px, got "${g.columns}"`).toBe(2);
      expect(g.rowSpreads.some((r) => r.n > 1),
        'no row holds two cards — an equal-bottoms claim would prove nothing').toBe(true);
      for (const r of g.rowSpreads) {
        expect(r.spread, `${r.n} cards on one row end ${r.spread.toFixed(2)}px apart`)
          .toBeLessThanOrEqual(1);
      }
    } else {
      expect(tracks.length, `the phone list must stay a single column, got "${g.columns}"`)
        .toBeLessThanOrEqual(1);
    }

    // R82 stays true: nothing clipped, nothing stacked word by word.
    for (const n of g.names) {
      expect(n.scrollWidth,
        `"${n.text}" is clipped: clientWidth ${n.clientWidth} < scrollWidth ${n.scrollWidth}`)
        .toBeLessThanOrEqual(n.clientWidth);
      expect(n.lines, `"${n.text}" is ${n.lines.toFixed(1)} lines tall`).toBeLessThanOrEqual(2.05);
    }

    expect(g.docScrollWidth, `the page scrolls sideways at ${size.width}px`).toBe(g.innerWidth);
    expect(errors).toEqual([]);
  });
}

test('R86 — the void and the row bottoms hold at every dial, not just the default', async ({ page }) => {
  // The dial changes which legs are on the card, so it changes their heights; a
  // layout that only holds at EVEN holds by accident.
  //
  // THE BOUND HERE IS 18px, NOT 12px, AND THE 6px IS MEASURED AND NAMED. R86
  // makes a row one leg-count band, so the void of RC-L1 (83px, a 2-leg card
  // stretched beside a 3-leg one) is gone: at EVEN it is 12px on all ten cards
  // at 402, 1280 and 1395. What is left is content variance INSIDE a band, and
  // on this pool exactly one thing produces it — R77's QUESTIONABLE chip. A leg
  // carrying it is 68.2px tall against 62.8px (.leg-od 22.2px against 14.2px,
  // the chip's 2px padding and 1px border), so at SAFE the 4/5/6-leg card with
  // J. Burrow Q is 5.4px taller than its partner and the partner inherits that
  // 5.4px as void: 17.4px measured. Equalising it would mean either reserving
  // the chip's height on every MY leg (+8px per leg, +48px on a 6-leg card) or
  // restyling an R77 chip that R86 has no business touching. Raise this bound
  // only with a new measurement and a written reason.
  const errors = watch(page);
  await openMy(page, { width: 1395, height: 704 });
  for (const which of ['safe', 'longshot', 'even']) {
    await page.click(`.mp-dial [data-dial="${which}"]`);
    await page.evaluate(() => document.fonts.ready);
    const g = await geometry(page);
    expect(g.bands, `${which}: expected ${EXPECTED_BANDS} band eyebrows`).toBe(EXPECTED_BANDS);
    for (const v of g.voids) {
      expect(v.void, `${which}: card ${v.i} has ${v.void.toFixed(1)}px of void`).toBeLessThanOrEqual(18);
    }
    for (const r of g.rowSpreads) {
      expect(r.spread, `${which}: a row's card bottoms disagree by ${r.spread.toFixed(2)}px`)
        .toBeLessThanOrEqual(1);
    }
    expect(g.docScrollWidth).toBe(g.innerWidth);
  }
  expect(errors).toEqual([]);
});
