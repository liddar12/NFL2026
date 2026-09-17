/* tests/web/r78_model_lock.spec.mjs — R78: the MODEL tab's passphrase gate, and
 * the PLAYOFF ODDS "as of" stamp, on the SHIPPED artifact.
 *
 * WHAT THE GATE IS. Obscurity, not security. This is a static site with no
 * server: /data/playoff_odds.json and every other feed stay world-readable, and
 * anyone can set the unlock key from devtools. The gate hides the VIEW so the
 * MODEL section is the owner's, and nothing more is claimed for it.
 *
 * WHAT THIS SPEC LOCKS. The part of the gate that can actually regress:
 *   1. locked  → the lock card paints, the dashboard does not, and the mount
 *                issues ZERO requests for the model's own contracts (a gate
 *                that renders after the fetch has already served the data).
 *   2. wrong   → "Wrong passphrase.", still locked, input refocused.
 *   3. unlocked→ the dashboard paints and the PLAYOFF ODDS card carries its
 *                "as of <stamp>" line, built from the committed artifact.
 *   4. phone   → the lock card fits 390px with no horizontal scroll.
 *
 * The passphrase itself is never written here (or anywhere in the repo) — only
 * its SHA-256 digest, which is also exactly what the unlocked browser stores.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const MODEL_LOCK_KEY = 'nfl2026.model.unlock.v1';
const MODEL_PASS_SHA256 = '4fed76b87cf8b056da33b210b23e8f4f93e9c955d56faf7e3ae3bbb57704f50b';

/** Contracts that ONLY the MODEL view fetches — the network proof of the gate. */
const MODEL_ONLY_CONTRACTS = ['playoff_odds.json', 'model_tuning.json'];

const odds = JSON.parse(
  readFileSync(new URL('../../data/playoff_odds.json', import.meta.url), 'utf8'),
);

/** Force the LOCKED state: the suite's shared storageState carries the
 * front-of-site unlock, never this key, but clearing it is what makes the
 * intent of these three tests explicit. */
const forceLocked = (page) => page.addInitScript((k) => {
  try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
}, MODEL_LOCK_KEY);

const forceUnlocked = (page) => page.addInitScript(([k, v]) => {
  try { localStorage.setItem(k, v); } catch (_) { /* ignore */ }
}, [MODEL_LOCK_KEY, MODEL_PASS_SHA256]);

/** Record every /data/ request the page makes, from before the first navigation. */
function watchData(page) {
  const seen = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/data/')) seen.push(u.split('/data/')[1].split('?')[0]);
  });
  return seen;
}

test.describe('R78 — MODEL tab passphrase gate (obscurity, not security)', () => {
  test('LOCKED: the lock card paints, the dashboard does not, and no model contract is fetched',
    async ({ page }) => {
      const seen = watchData(page);
      await forceLocked(page);
      await page.goto('/#/model');

      await expect(page.locator('.mcard.m-lock')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('.m-lock .mp-input')).toBeVisible();
      await expect(page.locator('.m-lock .mp-btn')).toHaveText('UNLOCK');
      await expect(page.locator('.m-lock')).toContainText('This section is for the owner.');
      // The header still identifies the tab — the view is hidden, not broken.
      await expect(page.locator('.view-title')).toHaveText('MODEL');

      // The dashboard is absent, not merely hidden.
      await expect(page.locator('.mcard.m-playoffs')).toHaveCount(0);
      await expect(page.locator('.mcard.m-params')).toHaveCount(0);
      await expect(page.locator('.m-asof')).toHaveCount(0);

      // Give any stray fetch time to appear before asserting it did not.
      await page.waitForTimeout(1500);
      for (const f of MODEL_ONLY_CONTRACTS) {
        expect(seen, `a locked #/model requested ${f} — the gate must return `
          + 'BEFORE the view fetches anything').not.toContain(f);
      }
    });

  test('WRONG PASSPHRASE: the card says so, stays locked, and refocuses the input',
    async ({ page }) => {
      const seen = watchData(page);
      await forceLocked(page);
      await page.goto('/#/model');
      await expect(page.locator('.mcard.m-lock')).toHaveCount(1, { timeout: 15000 });

      await page.locator('.m-lock .mp-input').fill('not-the-passphrase');
      await page.locator('.m-lock .mp-btn').click();

      await expect(page.locator('.m-lock .m-lock-msg')).toHaveText('Wrong passphrase.',
        { timeout: 10000 });
      await expect(page.locator('.m-lock .m-lock-msg')).toHaveAttribute('role', 'alert');
      // Still locked: one lock card, no dashboard, still nothing fetched.
      await expect(page.locator('.mcard.m-lock')).toHaveCount(1);
      await expect(page.locator('.mcard.m-playoffs')).toHaveCount(0);
      for (const f of MODEL_ONLY_CONTRACTS) expect(seen).not.toContain(f);

      // The next attempt can be typed straight away.
      await expect(page.locator('.m-lock .mp-input')).toBeFocused();
      // A wrong entry never persists anything.
      const stored = await page.evaluate((k) => localStorage.getItem(k), MODEL_LOCK_KEY);
      expect(stored).toBeNull();
    });

  test('UNLOCKED: the dashboard renders and PLAYOFF ODDS carries its as-of stamp',
    async ({ page }) => {
      await forceUnlocked(page);
      await page.goto('/#/model');

      await expect(page.locator('.mcard.m-playoffs')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('.mcard.m-lock')).toHaveCount(0);

      const asof = page.locator('.mcard.m-playoffs .m-asof');
      await expect(asof).toHaveCount(1);
      const txt = (await asof.innerText()).replace(/\s+/g, ' ').trim();
      expect(txt).toMatch(/^as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · refreshed on every pipeline run \([\d,]+ simulated seasons\)$/);
      // The stamp is the committed artifact's, not a render-time clock.
      if (odds.updated_utc) {
        const iso = new Date(Date.parse(odds.updated_utc)).toISOString();
        expect(txt).toContain(`as of ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);
      }
      // The honesty copy and the display-only badge survive the addition.
      await expect(page.locator('.mcard.m-playoffs .m-explain')).toContainText('no market input');
      await expect(page.locator('.mcard.m-playoffs .ms-badge').first())
        .toContainText('MARKET · DISPLAY ONLY');
    });

  test('the lock card fits a 390px phone with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await forceLocked(page);
    await page.goto('/#/model');
    await expect(page.locator('.mcard.m-lock')).toHaveCount(1, { timeout: 15000 });
    await page.waitForTimeout(300);

    const over = await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    expect(over, `the lock card overflows horizontally by ${over}px`).toBeLessThanOrEqual(1);

    // Both controls stay inside the viewport and clear the 44px touch target.
    for (const sel of ['.m-lock .mp-input', '.m-lock .mp-btn']) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} has a box`).not.toBeNull();
      expect(box.height, `${sel} is at least 44px tall`).toBeGreaterThanOrEqual(43.5);
      expect(box.x, `${sel} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${sel} ends inside the viewport`).toBeLessThanOrEqual(390.5);
    }
  });
});
