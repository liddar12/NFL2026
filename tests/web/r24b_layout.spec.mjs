/* tests/web/r24b_layout.spec.mjs — R24-B carried findings, measured.
 *
 * The fast-gate twin (tests/feature/r24b_layout.test.mjs) locks the STRUCTURE of
 * each fix. These are the GEOMETRY and NETWORK claims behind them, which only a
 * real browser can settle:
 *
 *   1. the START/SIT net-gain sentence renders as ONE line box, not as three
 *      cells of the .lu-move grid;
 *   2. the lineup card head title renders as ONE unbroken client rect at 402px,
 *      instead of breaking after "WEEK" and orphaning the week number;
 *   3. data/kdst_projections.json is NOT requested for a league that has no
 *      K/DEF slot, and IS requested for one that does;
 *   4/5. the two Compare finders have distinct accessible names, and the "change"
 *      control measures >=44px;
 *   6. every centre-rail chip is vertically centred on the metric row it
 *      annotates, at the wide layout where the rail exists.
 *
 * Every number here was measured against the broken build first: the rail drifted
 * from -34px at the top of the column to +26px at the bottom, the swap control
 * was 54x20, and the head split "OPTIMAL LINEUP · WEEK" from its "1".
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const KDEF_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
/** The pre-R47 offence-only league (no K, no DEF). */
const SEVEN_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

/** Ids out of the committed projections, by position. */
function pool() {
  const ps = readData('player_projections.json').players;
  const pick = (pos, n) => ps.filter((p) => String(p.position).toUpperCase() === pos)
    .slice(0, n).map((p) => String(p.gsis_id));
  return { qb: pick('QB', 2), rb: pick('RB', 5), wr: pick('WR', 6), te: pick('TE', 2) };
}

/**
 * A DEFAULT-profile roster whose starters are deliberately mis-set: the two best
 * WRs sit on the bench, so START/SIT really does have a positive net gain and the
 * net-gain sentence renders.
 */
function mixedRoster() {
  const { qb, rb, wr, te } = pool();
  return {
    QB1: qb[0], RB1: rb[0], RB2: rb[1], WR1: wr[4], WR2: wr[5], TE1: te[0], FLEX: rb[2],
    BN1: wr[0], BN2: wr[1], BN3: te[1], BN4: rb[3], BN5: wr[2], BN6: wr[3],
  };
}

const seed = (page, { profile, slots }) => page.addInitScript((s) => {
  if (s.profile) localStorage.setItem('nfl2026.league.v1', s.profile);
  else localStorage.removeItem('nfl2026.league.v1');
  if (s.slots) localStorage.setItem('nfl2026.team.v1', s.slots);
  else localStorage.removeItem('nfl2026.team.v1');
}, { profile: profile ? JSON.stringify(profile) : null, slots: slots ? JSON.stringify({ slots }) : null });

/* ==========================================================================
   1. THE NET-GAIN SENTENCE IS PROSE
   ========================================================================== */

test('the net-gain sentence renders as one sentence, not as grid cells', async ({ page }) => {
  await seed(page, { slots: mixedRoster() });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-card', { timeout: 15000 });

  const net = page.locator('.lu-move--net');
  await expect(net).toHaveCount(1);
  // Before the fix this read "Switching to the optimal lineup adds\n+8.8 pts\n
  // this week." — three grid cells, with "lineup adds" wrapped under the first.
  const txt = await net.innerText();
  expect(txt).not.toContain('\n');
  expect(txt).toMatch(/^Switching to the optimal lineup adds \+\d+\.\d pts this week\.$/);

  const shape = await net.evaluate((el) => {
    const gain = el.querySelector('.lu-move-gain').getBoundingClientRect();
    const wrap = el.firstElementChild.getBoundingClientRect();
    return {
      items: el.childNodes.length,
      display: getComputedStyle(el).display,
      // The gain must sit INSIDE the sentence's own box, not in a column of its own.
      gainInside: gain.left >= wrap.left - 1 && gain.right <= wrap.right + 1,
      // The sentence gets the row's full content width rather than the ~50% the
      // grid's first column gave it (171px of 340px when this was three cells).
      fills: wrap.width / (el.clientWidth
        - parseFloat(getComputedStyle(el).paddingLeft)
        - parseFloat(getComputedStyle(el).paddingRight)) >= 0.9,
    };
  });
  expect(shape.items).toBe(1);
  expect(shape.display).toBe('block');
  expect(shape.gainInside).toBe(true);
  expect(shape.fills).toBe(true);
});

/* ==========================================================================
   2. THE CARD HEAD TITLE IS NEVER BROKEN MID-PHRASE
   ========================================================================== */

for (const [label, profile] of [['a default league', null], ['a K/DEF league', {
  version: 1, name: 'K/DEF League', shape: { teams: 12, roster_positions: [...KDEF_ROSTER] },
}]]) {
  test(`the lineup card head keeps "OPTIMAL LINEUP · WEEK n" whole — ${label}`, async ({ page }) => {
    const doc = readData('kdst_projections.json');
    const slots = mixedRoster();
    if (profile) {
      slots.K1 = doc.kickers[0].player_id;
      slots.DEF1 = doc.defenses[0].player_id;
      slots.BN5 = null; slots.BN6 = null;
    }
    await seed(page, { profile, slots });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });

    const title = page.locator('.lu-card .lu-title').first();
    await expect(title).toHaveText(/^OPTIMAL LINEUP · WEEK \d+$/);
    // ONE client rect == one unbroken line. Two meant the phrase had been split,
    // which is exactly how the week number ended up orphaned beside the total.
    const rects = await title.evaluate((el) => el.getClientRects().length);
    expect(rects).toBe(1);

    // And the title never collides with the total: either they share a line with
    // clear space between them, or the total is on its own line below.
    const gap = await page.locator('.lu-card .m-head').first().evaluate((el) => {
      const t = el.querySelector('.lu-title').getBoundingClientRect();
      const n = el.querySelector('.lu-total').getBoundingClientRect();
      return { sameLine: n.top < t.bottom - 2, dx: n.left - t.right };
    });
    if (gap.sameLine) expect(gap.dx).toBeGreaterThanOrEqual(6);
  });
}

/* ==========================================================================
   3. THE 59KB K/DST CONTRACT IS NOT FETCHED WHEN IT CANNOT BE USED
   ========================================================================== */

test('a league with NO K/DEF slot never requests the K/DST contract', async ({ page }) => {
  // R47: the DEFAULT league seats K1/DEF1, so it DOES fetch the contract; the
  // league that never asks for it is one whose roster names no K/DEF token.
  const asked = [];
  page.on('request', (r) => { if (r.url().includes('kdst_projections.json')) asked.push(r.url()); });
  await seed(page, {
    profile: { version: 1, name: 'Offence Only', shape: { teams: 12, roster_positions: [...SEVEN_ROSTER] } },
    slots: mixedRoster(),
  });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-row', { timeout: 15000 });
  // The card is fully painted (7 starter rows) and the contract was never asked for.
  expect(await page.locator('.lu-card').first().locator('.lu-row').count()).toBe(7);
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
});

test('R47: a default-profile lineup requests the K/DST contract once and paints nine rows', async ({ page }) => {
  const asked = [];
  page.on('request', (r) => { if (r.url().includes('kdst_projections.json')) asked.push(r.url()); });
  await seed(page, { slots: mixedRoster() });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-row', { timeout: 15000 });
  expect(await page.locator('.lu-card').first().locator('.lu-row').count()).toBe(9);
  await page.waitForTimeout(500);
  expect(asked.length).toBe(1);
});

test('a K/DEF lineup still requests it, and still seats the kicker', async ({ page }) => {
  const doc = readData('kdst_projections.json');
  const asked = [];
  page.on('request', (r) => { if (r.url().includes('kdst_projections.json')) asked.push(r.url()); });
  const slots = mixedRoster();
  slots.K1 = doc.kickers[0].player_id;
  slots.DEF1 = doc.defenses[0].player_id;
  slots.BN5 = null; slots.BN6 = null;
  await seed(page, {
    profile: { version: 1, name: 'K/DEF League', shape: { teams: 12, roster_positions: [...KDEF_ROSTER] } },
    slots,
  });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-card', { timeout: 15000 });
  expect(await page.locator('.lu-card').first().locator('.lu-row').count()).toBe(9);
  await expect(page.locator('.lu-cover')).toContainText('9');
  expect(asked.length).toBeGreaterThan(0);
});

test('a K parked on a BENCH slot survives a league that dropped the position', async ({ page }) => {
  // The lazy second chance: the profile says no K, but the saved roster still
  // holds one under a BN key, so the id resolves through neither feed until the
  // contract is fetched. He must still appear rather than vanish.
  const doc = readData('kdst_projections.json');
  const slots = mixedRoster();
  slots.BN6 = doc.kickers[0].player_id;
  // R47: the default league seats a K, so "a league that dropped the position"
  // has to be spelled out — an offence-only roster.
  await seed(page, {
    profile: { version: 1, name: 'Offence Only', shape: { teams: 12, roster_positions: [...SEVEN_ROSTER] } },
    slots,
  });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-row--bench', { timeout: 15000 });
  const bench = await page.locator('.lu-card').last().innerText();
  expect(bench).toContain(doc.kickers[0].name);
});

/* ==========================================================================
   4/5. THE COMPARE FINDERS AND THE "change" CONTROL
   ========================================================================== */

test('each Compare finder has its own accessible name', async ({ page }) => {
  await page.goto('/#/compare');
  await page.waitForSelector('.cmp-find', { timeout: 15000 });
  // getByLabel resolves through the accessibility tree — a placeholder alone
  // would not satisfy it, which is precisely the finding.
  await expect(page.getByLabel('FIRST PLAYER')).toHaveAttribute('data-side', 'a');
  await expect(page.getByLabel('SECOND PLAYER')).toHaveAttribute('data-side', 'b');
});

test('the Compare "change" control meets the 44px minimum and still clears the side', async ({ page }) => {
  const { wr, rb } = pool();
  await page.goto(`/#/compare?a=${wr[0]}&b=${rb[0]}`);
  await page.waitForSelector('.cmp-swap', { timeout: 15000 });
  // R34 — measure at rest: the always-on HIG theme's entrance animation scales
  // the fresh view from 0.995 for 240ms, which shaved this min-height:44px
  // control to a measured 43.87 when the box was read mid-animation. The
  // target IS 44px; wait for the animation to finish before holding it to
  // the rule.
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => a.finished.catch(() => {})),
  ));
  const box = await page.locator('.cmp-swap').first().boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  // The delegation still works from the inner pill.
  await page.locator('.cmp-swap-pill').first().click();
  await page.waitForSelector('.cmp-find', { timeout: 8000 });
  expect(page.url()).not.toContain(`a=${wr[0]}`);
});

/* ==========================================================================
   6. THE CENTRE RAIL IS ON THE ROWS IT ANNOTATES
   ========================================================================== */

test('every rail chip is centred on its own metric row (wide layout)', async ({ page }) => {
  const { wr, rb } = pool();
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.goto(`/#/compare?a=${wr[0]}&b=${rb[0]}`);
  await page.waitForSelector('.cmp-grid--aligned', { timeout: 15000 });

  const rows = await page.evaluate(() => {
    const mets = [...document.querySelectorAll('.cmp-col[data-side="a"] .cmp-metric')];
    const chips = [...document.querySelectorAll('.cmp-mid > *')];
    return {
      metrics: mets.length,
      chips: chips.length,
      deltas: mets.map((m, i) => {
        const a = m.getBoundingClientRect();
        const b = chips[i].getBoundingClientRect();
        return Math.round((b.y + b.height / 2) - (a.y + a.height / 2));
      }),
      rowsVar: getComputedStyle(document.querySelector('.cmp-grid')).getPropertyValue('--cmp-rows').trim(),
    };
  });
  expect(rows.chips).toBe(rows.metrics);
  expect(rows.rowsVar).toBe(String(rows.metrics));
  // Was -34 at the top and +26 at the bottom, drifting ~10px per row.
  for (const d of rows.deltas) expect(Math.abs(d)).toBeLessThanOrEqual(2);
});

test('the phone layout is untouched — no shared grid, chips stay a wrapped row', async ({ page }) => {
  const { wr, rb } = pool();
  await page.goto(`/#/compare?a=${wr[0]}&b=${rb[0]}`);
  await page.waitForSelector('.cmp-grid', { timeout: 15000 });
  const shape = await page.evaluate(() => {
    const mid = document.querySelector('.cmp-mid');
    const cols = [...document.querySelectorAll('.cmp-col')];
    return {
      mid: getComputedStyle(mid).display,
      dir: getComputedStyle(mid).flexDirection,
      // A stacked layout: the rail sits BELOW column A and ABOVE column B.
      stacked: cols[0].getBoundingClientRect().bottom <= mid.getBoundingClientRect().top + 1
        && mid.getBoundingClientRect().bottom <= cols[1].getBoundingClientRect().top + 1,
    };
  });
  expect(shape.mid).toBe('flex');
  expect(shape.dir).toBe('row');
  expect(shape.stacked).toBe(true);
});
