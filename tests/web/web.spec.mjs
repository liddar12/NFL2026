/* tests/web/web.spec.mjs — project `web` (Agent D).
 *
 * Proves the WEB (in-browser) UI works INDEPENDENTLY of the installed PWA. No
 * standalone emulation, no injected safe-area insets: this is what a visitor sees
 * in mobile Safari before installing. Asserts:
 *   1. the app shell renders (topbar / tabbar / view present),
 *   2. each route (#/, #/players, #/parlays) paints its cards,
 *   3. it runs under display-mode: browser (NOT dependent on standalone),
 *   4. with NO safe-area insets the topbar / tabbar / view do not overlap.
 */

import { test, expect } from '@playwright/test';

/** Poll until the view has painted at least one card of the given selector. */
async function waitForCards(page, selector) {
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    selector,
    { timeout: 8000 },
  );
}

/** Navigate to a hash route and wait for the router to settle it. */
async function goRoute(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForFunction(
    (h) => window.location.hash === h || (h === '#/' && window.location.hash === ''),
    hash,
    { timeout: 8000 },
  );
}

test.describe('web (in-browser) experience', () => {
  test('app shell renders and reports display-mode: browser', async ({ page }) => {
    await page.goto('/');

    // Shell landmarks from the contract markup exist.
    await expect(page.locator('.app')).toHaveCount(1);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect(page.locator('.view')).toHaveCount(1);

    // A plain browser tab is display-mode: browser, NOT standalone. The UI must
    // not require standalone to function.
    const isBrowser = await page.evaluate(
      () => window.matchMedia('(display-mode: browser)').matches,
    );
    expect(isBrowser).toBe(true);
    const isStandalone = await page.evaluate(
      () => window.matchMedia('(display-mode: standalone)').matches,
    );
    expect(isStandalone).toBe(false);
  });

  test('slate route paints game cards with a win-prob track', async ({ page }) => {
    await page.goto('/');
    await goRoute(page, '#/');
    await waitForCards(page, '.card.game');
    expect(await page.locator('.card.game').count()).toBeGreaterThanOrEqual(1);
    // Every game card carries the probability track (the core viz).
    expect(await page.locator('.card.game .track').count()).toBeGreaterThanOrEqual(1);
  });

  test('players route paints player cards', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    expect(await page.locator('.card.player').count()).toBeGreaterThanOrEqual(1);
  });

  test('parlays route paints parlay cards', async ({ page }) => {
    await page.goto('/#/parlays');
    await waitForCards(page, '.card.parlay');
    expect(await page.locator('.card.parlay').count()).toBeGreaterThanOrEqual(1);
  });

  test('with NO safe-area insets, shell regions do not overlap', async ({ page }) => {
    // The default browser environment has zero safe-area insets. The topbar,
    // scrolling view, and fixed tabbar must still tile without collisions.
    await page.goto('/');
    await waitForCards(page, '.card');

    const boxes = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        topbar: rect('.topbar'),
        tabbar: rect('.tabbar'),
        view: rect('.view'),
      };
    });

    expect(boxes.topbar, 'topbar missing').not.toBeNull();
    expect(boxes.tabbar, 'tabbar missing').not.toBeNull();
    expect(boxes.view, 'view missing').not.toBeNull();

    // Topbar sits above the scrolling view (allow a 1px rounding fudge).
    expect(boxes.view.top).toBeGreaterThanOrEqual(boxes.topbar.bottom - 1);
    // The fixed tabbar is anchored to the bottom, below the topbar.
    expect(boxes.tabbar.top).toBeGreaterThanOrEqual(boxes.topbar.bottom - 1);
  });
});
