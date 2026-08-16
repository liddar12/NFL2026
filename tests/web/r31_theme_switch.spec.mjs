/* tests/web/r31_theme_switch.spec.mjs — R34: Apple HIG is the ONLY theme.
 *
 * HISTORY: R31 shipped HIG as an opt-in switch (this spec used to lock the
 * Broadcast default, the flip, the persistence and the no-flash boot). R34
 * retires the switch by owner decision — HIG is the one theme — so the
 * contract this file locks is now:
 *
 *   1. EVERY route boots with data-theme="hig" on <html>. No route, no stored
 *      value and no storage failure produces the unthemed (Broadcast) DOM.
 *   2. THERE IS NO #theme-switch in the DOM — the control and its wiring are
 *      gone, not merely hidden.
 *   3. NO FLASH: the attribute is stamped by the inline <head> script, so it
 *      is already present at domcontentloaded, before the deferred module
 *      entry point runs. Nothing about the stamp depends on storage.
 *   4. STORAGE IS IGNORED: a stale nfl2026.theme.v1 = "broadcast" (a real
 *      value on devices that used the R31 switch) changes nothing, and a
 *      throwing localStorage (Safari private mode) cannot break the boot or
 *      the theme.
 *   5. The HIG stylesheet actually TAKES EFFECT (computed style only the HIG
 *      sheet produces), so the attribute is not stamped onto dead CSS.
 *
 * The scoping invariant (every theme-hig.css rule under [data-theme="hig"])
 * still holds and stays tested in tests/feature/contrast_aa_hig.test.mjs.
 */

import { test, expect } from '@playwright/test';

const KEY = 'nfl2026.theme.v1';

/** The computed background of .topbar — the HIG sheet's translucent material,
 * where the base Broadcast sheet paints an opaque --surface bar. */
const topbarBg = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor);

test.describe('R34 — Apple HIG is the only theme', () => {
  test('every route boots with data-theme="hig", and the HIG sheet wins', async ({ page }) => {
    for (const route of ['/#/', '/#/players', '/#/team']) {
      await page.goto(route);
      await expect(page.locator('.topbar')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');
    }
    // Proof the stylesheet is live, not just the attribute: the topbar is a
    // translucent HIG material (rgba), never the opaque Broadcast bar.
    expect(await topbarBg(page)).toMatch(/^rgba\(/);
  });

  test('there is no theme switch in the DOM', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('#theme-switch')).toHaveCount(0);
    // The week chip (the other `wk` element) survives the switcher's removal.
    await expect(page.locator('#week-chip')).toBeVisible();
  });

  test('the theme is applied before first paint, independent of storage', async ({ page }) => {
    // A device that used the R31 switch may still carry "broadcast" — it must
    // be ignored (no storage read in the boot path at all).
    await page.addInitScript((k) => { localStorage.setItem(k, 'broadcast'); }, KEY);
    // domcontentloaded fires before the deferred module entry point has
    // finished; the attribute must already be there, or a cold load paints one
    // frame of the wrong theme.
    await page.goto('/#/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('hig');
  });

  test('a blocked localStorage (private mode) cannot break the boot or the theme', async ({ page }) => {
    // Make every localStorage access throw, the way Safari private mode does.
    await page.addInitScript(() => {
      const boom = () => { throw new Error('SecurityError: storage is disabled'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { return { getItem: boom, setItem: boom, removeItem: boom }; },
      });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/#/');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
