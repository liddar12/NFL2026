/* tests/web/r76_myparlays.spec.mjs — MY PARLAYS in the browser (project `web`).
 *
 * Drives the real view over the COMMITTED leg pool, routing nothing: the point
 * is that what production serves actually builds cards for a real player.
 *
 * Proves: MY is a third mode in the PARLAYS scope control, not a route; neither
 * the view nor the ~294 KB pool is fetched until the chip is tapped; typing a
 * player produces cards that all contain him; the slate's own chrome hides while
 * MY is open and comes back when it closes; and every card states its conviction,
 * its EV and its $100 figure with the no-book-price caveat where one applies.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_PLAYER, SKIP_REASON } from './_myseed.mjs';

/* The MY tests need a game that has not kicked off; between the last game of a
 * week and the next week's pool there is none, and MY correctly offers nothing.
 * The reason names that condition, so a skipped run reads as a finished slate
 * rather than a broken suite. It is '' whenever any game is upcoming. */
test.skip(() => Boolean(SKIP_REASON), SKIP_REASON || 'the slate is live');


const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
// A pooled player whose game is still upcoming (see _myseed.mjs): the first
// pool row was a Thursday player and went dark every Friday.
const SEED = SEED_PLAYER;

const dataRequests = (page) => {
  const got = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/data/') || u.includes('myparlays.js')) got.push(u.split('/').pop().split('?')[0]);
  });
  return got;
};
const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

test.describe('R76 — MY PARLAYS', () => {
  test('MY is a mode in PARLAYS; neither the view nor the pool loads until it is tapped', async ({ page }) => {
    const got = dataRequests(page);
    const errors = errorsOf(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 20000 });
    await page.waitForTimeout(600);

    // the chip exists alongside GAME / WEEK — and no new route was needed
    await expect(page.locator('.scopeseg [data-seg="my"]')).toHaveCount(1);
    expect(page.url()).toContain('#/parlays');
    // ...and nothing of MY has been fetched yet
    expect(got.filter((f) => f === 'leg_pool.json')).toEqual([]);
    expect(got.filter((f) => f === 'myparlays.js')).toEqual([]);

    await page.click('.scopeseg [data-seg="my"]');
    await page.waitForSelector('#mp-input', { timeout: 20000 });
    expect(got.filter((f) => f === 'leg_pool.json').length).toBe(1);
    expect(errors).toEqual([]);
  });

  test('typing a player builds cards that all contain him', async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 20000 });
    await page.click('.scopeseg [data-seg="my"]');
    await page.waitForSelector('#mp-input', { timeout: 20000 });

    // before a seed, the view asks for one rather than guessing
    await expect(page.locator('#mp-list .state')).toContainText('Type a player or a team');

    await page.fill('#mp-input', SEED.player);
    await page.press('#mp-input', 'Enter');
    await page.waitForSelector('.mp-card', { timeout: 20000 });

    // the seed shows as a removable chip
    await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
    await expect(page.locator('#mp-seeds .leg-chip')).toContainText(SEED.player);

    const cards = page.locator('.mp-card');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(10);

    // EVERY card contains a leg belonging to the seed
    const selections = POOL.players.find((p) => p.gsis_id === SEED.gsis_id)
      .rungs.map((r) => r.selection);
    for (let i = 0; i < n; i += 1) {
      const text = await cards.nth(i).innerText();
      expect(selections.some((s) => text.includes(s)),
        `card ${i} has no leg for ${SEED.player}`).toBe(true);
    }

    // every card states conviction, EV and the $100 figure
    await expect(cards.first().locator('.ev .k')).toHaveText('CONVICTION');
    await expect(cards.first().locator('.pay .k')).toHaveText('$100 SIM NET');
    await expect(cards.first().locator('.legcount')).toContainText('EV');
    // and a prop leg says its price is not a book price
    await expect(page.locator('.mp-card .im').first()).toContainText('IMPL');
    expect(errors).toEqual([]);
  });

  test('the slate chrome hides while MY is open and returns when it closes', async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });

    await page.click('.scopeseg [data-seg="my"]');
    await page.waitForSelector('#mp-input', { timeout: 20000 });
    for (const sel of ['#parlays-list', '#leg-controls', '#sort-controls']) {
      await expect(page.locator(sel)).toBeHidden();
    }

    await page.click('.scopeseg [data-seg="game"]');
    await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
    await expect(page.locator('#myparlays-host')).toBeHidden();
    // R90 — #leg-controls now sits inside the FILTERS panel, which is shut by
    // default; the panel itself is the slate chrome that must come back.
    await expect(page.locator('#parlay-filters')).toBeVisible();
    // and going back does not refetch the pool or lose the seeds
    await page.click('.scopeseg [data-seg="my"]');
    await expect(page.locator('#mp-input')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a name the pool cannot price is refused, not invented', async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 20000 });
    await page.click('.scopeseg [data-seg="my"]');
    await page.waitForSelector('#mp-input', { timeout: 20000 });
    await page.fill('#mp-input', 'Nobody Whatsoever');
    await page.press('#mp-input', 'Enter');
    await page.waitForTimeout(300);
    // no seed chip, no cards, no fabricated anything
    await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
    await expect(page.locator('.mp-card')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
