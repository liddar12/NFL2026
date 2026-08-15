/* tests/web/r31_theme_switch.spec.mjs — the R31 alternative-theme switch.
 *
 * WHAT IS LOCKED HERE, and why each one is worth a test:
 *
 *   1. THE DEFAULT IS UNTOUCHED. The whole product promise of an opt-in theme
 *      is that someone who never touches it sees what they always saw. A fresh
 *      browser must carry NO data-theme attribute at all — not "hig", not
 *      "broadcast" — because the presence of the attribute is what activates
 *      app/theme-hig.css.
 *   2. THE SWITCH ACTUALLY SWITCHES. Not "the button exists": the attribute
 *      flips, the stylesheet takes effect (asserted on a computed style that
 *      only the HIG sheet produces), and the label names the live theme.
 *   3. IT PERSISTS ACROSS A RELOAD, and comes back to Broadcast when flipped
 *      off — a one-way switch would be a trap.
 *   4. IT DOES NOT PAINT THE WRONG THEME FIRST. The choice is applied by an
 *      inline <head> script, so <html> already carries the attribute before any
 *      module has run. The proof used here is that the attribute is present at
 *      "domcontentloaded", ahead of the deferred module entry point.
 *   5. IT SURVIVES A BLOCKED localStorage (Safari private mode throws on BOTH
 *      read and write). The theme is then session-only, but the app must boot
 *      and the button must still work rather than throwing on click.
 */

import { test, expect } from '@playwright/test';

const KEY = 'nfl2026.theme.v1';

/** The computed background of .topbar, which the two themes disagree about. */
const topbarBg = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor);

test.describe('R31 — the Apple HIG theme is opt-in and reversible', () => {
  test('a fresh browser gets the Broadcast theme, with no data-theme at all', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('.topbar')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')))
      .toBe(false);
    // theme.css's opaque --surface bar, not a translucent material.
    expect(await topbarBg(page)).toBe('rgb(22, 27, 34)');
    // The control names the theme you are on, so it is a readout as well as a switch.
    await expect(page.locator('#theme-switch')).toHaveText(/BROADCAST/);
    await expect(page.locator('#theme-switch')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the switch flips the theme, and the stylesheet actually takes effect', async ({ page }) => {
    await page.goto('/#/');
    await page.locator('#theme-switch').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');
    await expect(page.locator('#theme-switch')).toHaveText(/APPLE HIG/);
    await expect(page.locator('#theme-switch')).toHaveAttribute('aria-pressed', 'true');

    // A translucent material, not the opaque Broadcast bar. Asserting the
    // alpha channel is the cheapest proof that app/theme-hig.css is winning the
    // cascade, rather than merely being linked.
    expect(await topbarBg(page)).toMatch(/^rgba\(/);
    expect(await page.evaluate(() => localStorage.getItem('nfl2026.theme.v1'))).toBe('hig');
  });

  test('the choice survives a reload, and flips back', async ({ page }) => {
    await page.goto('/#/');
    await page.locator('#theme-switch').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');
    await expect(page.locator('#theme-switch')).toHaveText(/APPLE HIG/);

    await page.locator('#theme-switch').click();
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')))
      .toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('nfl2026.theme.v1'))).toBe('broadcast');

    await page.reload();
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')))
      .toBe(false);
  });

  test('the theme is applied before first paint, not after the modules boot', async ({ page }) => {
    await page.addInitScript((k) => { localStorage.setItem(k, 'hig'); }, KEY);
    // domcontentloaded fires before the deferred module entry point has
    // finished; the attribute must already be there, or the user sees one frame
    // of the wrong theme on every cold load.
    await page.goto('/#/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('hig');
  });

  test('a blocked localStorage (private mode) neither breaks boot nor the switch', async ({ page }) => {
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
    await expect(page.locator('#theme-switch')).toHaveText(/BROADCAST/);

    // With storage blocked, gate.js cannot read its unlock flag either, so the
    // password overlay is up and would swallow a real pointer click. The
    // behaviour under test is the HANDLER, so dispatch the event directly
    // rather than pretending the overlay is not there.
    await page.locator('#theme-switch').dispatchEvent('click');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hig');
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
