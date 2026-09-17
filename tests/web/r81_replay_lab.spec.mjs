/* tests/web/r81_replay_lab.spec.mjs — R81 (project `web`): the REPLAY LAB card
 * on #/model, on the SHIPPED artifact.
 *
 * The card reports a measurement bench and must never look like a promotion:
 *   1. COMMITTED data — the card renders after the PARLAY GATE, one row per
 *      variant with n, the log-loss delta, the CI, a verdict chip and the best
 *      selection rule's ROI, and it says in words that nothing on it changes a
 *      shipped number. The ADOPTED / RETAINED vocabulary of the gate cards above
 *      must NOT appear on it.
 *   2. ABSENT file (routed to 404) — the honest NOT PRESENT line, and the page
 *      still paints the rest of the dashboard.
 *   3. 0 WEEKS REPLAYED (routed) — the honest state line, no table of nulls.
 *   4. phone width — no horizontal overflow.
 *
 * #/model is passphrase-gated (R78): every test seeds the unlock digest, exactly
 * as tests/web/r78_model_lock.spec.mjs documents. The passphrase itself is never
 * written here — only its SHA-256 digest.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const MODEL_LOCK_KEY = 'nfl2026.model.unlock.v1';
const MODEL_PASS_SHA256 = '4fed76b87cf8b056da33b210b23e8f4f93e9c955d56faf7e3ae3bbb57704f50b';

const LAB = JSON.parse(
  readFileSync(new URL('../../data/replay_lab.json', import.meta.url), 'utf8'),
);

const unlockModel = (page) => page.addInitScript(([k, v]) => {
  try { localStorage.setItem(k, v); } catch (_) { /* the lock card would fail loudly */ }
}, [MODEL_LOCK_KEY, MODEL_PASS_SHA256]);

const flat = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ').trim();

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openModel(page) {
  await unlockModel(page);
  await page.goto('/#/model');
  await expect(page.locator('.mcard.m-replay-lab')).toHaveCount(1, { timeout: 15000 });
}

test.describe('R81 — REPLAY LAB card on #/model', () => {
  test('COMMITTED: one row per variant, with n, delta, CI, verdict and the best rule ROI',
    async ({ page }) => {
      const errors = collectErrors(page);
      await openModel(page);

      const card = page.locator('.mcard.m-replay-lab');
      await expect(card.locator('.m-head')).toContainText('REPLAY LAB · CANDIDATES vs SHIPPED');
      // it REPORTS what happened, so it wears MEASURED — never ESTIMATE.
      await expect(card.locator('.m-head .ms-badge')).toContainText('MEASURED');
      await expect(card.locator('.m-head .est')).toHaveCount(0);

      // the honesty sentence is the point of the card
      await expect(card.locator('.m-explain'))
        .toContainText('Nothing on this card changes a shipped number');

      // it sits AFTER the parlay gate card in the document
      const order = await page.evaluate(() => [...document.querySelectorAll('.mcard')]
        .map((el) => [...el.classList].find((c) => c.startsWith('m-')) || ''));
      if (order.includes('m-parlay-gate')) {
        expect(order.indexOf('m-replay-lab')).toBeGreaterThan(order.indexOf('m-parlay-gate'));
      }

      const weeks = Array.isArray(LAB.weeks_replayed) ? LAB.weeks_replayed : [];
      const names = Object.keys(LAB.variants || {});
      expect(names.length).toBeGreaterThan(1);

      if (weeks.length === 0) {
        // the committed record has nothing measured — then the card must SAY so
        await expect(card.locator('.state')).toContainText('0 WEEKS REPLAYED');
        await expect(card.locator('table.pf-tbl')).toHaveCount(0);
      } else {
        const rows = card.locator('table.pf-tbl tbody tr');
        await expect(rows).toHaveCount(names.length);
        const text = await flat(card.locator('table.pf-tbl'));
        for (const n of names) expect(text).toContain(n);
        // the baseline row is labelled as one, and carries no CI to compare
        const first = await flat(rows.first());
        expect(first).toContain(LAB.baseline);
        expect(first).toContain('BASELINE');
        // every candidate carries one of the three measurement verdicts
        for (const [name, v] of Object.entries(LAB.variants)) {
          if (name === LAB.baseline) continue;
          const row = card.locator('table.pf-tbl tbody tr', { hasText: name }).first();
          const t = await flat(row);
          expect(t, `${name} row: ${t}`).toMatch(/BETTER|WORSE|SAME|—/);
          expect(t).toContain(String(v.legs.pooled.n));
        }
        // the best selection rule's ROI at $100 is on the row
        const best = Object.entries(LAB.variants.shipped.parlays.rules)
          .filter(([, r]) => r.n > 0 && r.roi_fair != null)
          .sort((a, b) => b[1].roi_fair - a[1].roi_fair)[0];
        if (best) expect(text).toContain(best[0]);
        // and the leg accounting is shown, unresolved reasons included
        await expect(card.locator('.gate-bench')).toContainText('resolved');
      }

      // a measurement bench must not borrow the promotion vocabulary
      const all = await flat(card);
      expect(all).not.toContain('ADOPTED');
      expect(all).not.toContain('RETAINED');

      expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
    });

  test('ABSENT: a 404 paints the honest NOT PRESENT line and the dashboard still renders',
    async ({ page }) => {
      const errors = collectErrors(page);
      await page.route('**/data/replay_lab.json', (r) => r.fulfill({
        status: 404, contentType: 'application/json', body: '{}',
      }));
      await openModel(page);

      const card = page.locator('.mcard.m-replay-lab');
      await expect(card.locator('.state')).toContainText('NOT PRESENT');
      await expect(card.locator('.state')).toContainText('data/replay_lab.json');
      await expect(card.locator('table.pf-tbl')).toHaveCount(0);
      // no invented numbers anywhere on the card
      const all = await flat(card);
      expect(all).not.toMatch(/\b0\.0000\b/);
      // the rest of the dashboard is unaffected — one missing optional feed
      // never takes the view down.
      await expect(page.locator('.mcard.m-playoffs')).toHaveCount(1);
      await expect(page.locator('.mcard.m-cal')).toHaveCount(1);

      expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
    });

  test('0 WEEKS REPLAYED: the honest state line, not a table of nulls', async ({ page }) => {
    const errors = collectErrors(page);
    const empty = { ...LAB, weeks_replayed: [], legs: { ...LAB.legs, resolved: 0 } };
    await page.route('**/data/replay_lab.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(empty),
    }));
    await openModel(page);

    const card = page.locator('.mcard.m-replay-lab');
    await expect(card.locator('.state')).toContainText('0 WEEKS REPLAYED');
    await expect(card.locator('.state')).toContainText('nothing is claimed');
    await expect(card.locator('table.pf-tbl')).toHaveCount(0);
    // the provenance stamp still says when the record was written
    await expect(card.locator('.mp-src')).toContainText('baseline');

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('the card fits the phone with no horizontal overflow', async ({ page }) => {
    await openModel(page);
    await page.waitForTimeout(300);
    const over = await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    expect(over, `#/model overflows horizontally by ${over}px`).toBeLessThanOrEqual(1);
  });
});
