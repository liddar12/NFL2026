/* tests/web/r51_model.spec.mjs — R51 (project `web`): the MODEL tab's WEEKLY
 * SPLIT GATE and PARLAY GATE cards, end to end, in all three states the owner
 * policy names:
 *   - ABSENT (404): NOTHING renders — no card, no placeholder shell, no error,
 *     and every other MODEL card is untouched;
 *   - PRESENT with a verdict (the committed sample docs routed in): both cards
 *     render the record's numbers, the verdict chips, the MEASUREMENT ONLY
 *     badge, and sit after CALIBRATION and before SEASON LOCKS;
 *   - PRESENT without a verdict: the card renders an AWAITING state and none
 *     of the record's numbers as if judged.
 * A final test drives the COMMITTED data unrouted and asserts whichever of the
 * first two states the deploy is actually in — so it passes on a clone before
 * the runner has produced the files and after it has.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readFix = (name) => readFileSync(new URL(`../fixtures/r51/${name}`, import.meta.url), 'utf8');
const WEEKLY = readFix('weekly_backtest.sample.json');
const PARLAY = readFix('parlay_backtest.sample.json');

const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body,
});

async function routeBacktests(page, { weekly, parlay }) {
  await page.route('**/data/weekly_backtest.json', (r) => (weekly == null
    ? json(r, 'Not Found', 404) : json(r, weekly)));
  await page.route('**/data/parlay_backtest.json', (r) => (parlay == null
    ? json(r, 'Not Found', 404) : json(r, parlay)));
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openModel(page) {
  await page.goto('/#/model');
  await page.waitForSelector('.m-cal', { timeout: 15000 });
  await expect(page.locator('.m-locks')).toHaveCount(1);
}

/** Card order inside #view, by the extra class each card carries. */
const cardOrder = (page) => page.evaluate(() => [...document.querySelectorAll('#view .mcard')]
  .map((el) => [...el.classList].find((c) => c.startsWith('m-') && c !== 'mcard')));

test.describe('R51 — WEEKLY SPLIT GATE + PARLAY GATE on #/model', () => {
  test('ABSENT (404): nothing renders, no shell, no error; the other cards are intact', async ({ page }) => {
    const errors = collectErrors(page);
    await routeBacktests(page, { weekly: null, parlay: null });
    await openModel(page);
    await page.waitForTimeout(500);
    await expect(page.locator('.m-weekly-gate')).toHaveCount(0);
    await expect(page.locator('.m-parlay-gate')).toHaveCount(0);
    // No orphaned shell either: no header naming the card without a body.
    await expect(page.locator('#view .m-head', { hasText: 'WEEKLY SPLIT GATE' })).toHaveCount(0);
    await expect(page.locator('#view .m-head', { hasText: 'PARLAY GATE' })).toHaveCount(0);
    for (const cls of ['.m-fresh', '.m-params', '.m-backtest', '.m-gate', '.m-mkt', '.m-cal', '.m-locks', '.m-playoffs', '.m-signals']) {
      await expect(page.locator(cls)).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });

  test('PRESENT with verdicts: both cards render the record, chips, badge, and sit after CALIBRATION before SEASON LOCKS', async ({ page }) => {
    const errors = collectErrors(page);
    await routeBacktests(page, { weekly: WEEKLY, parlay: PARLAY });
    await openModel(page);
    const weekly = page.locator('.m-weekly-gate');
    const parlay = page.locator('.m-parlay-gate');
    await expect(weekly).toHaveCount(1);
    await expect(parlay).toHaveCount(1);
    // No .state message inside either card — a rendered record, not a placeholder.
    await expect(weekly.locator('.state')).toHaveCount(0);
    await expect(parlay.locator('.state')).toHaveCount(0);

    // Order: … CALIBRATION → WEEKLY SPLIT GATE → PARLAY GATE → SEASON LOCKS …
    const order = await cardOrder(page);
    const i = (c) => order.indexOf(c);
    expect(i('m-cal')).toBeGreaterThan(-1);
    expect(i('m-weekly-gate')).toBe(i('m-cal') + 1);
    expect(i('m-parlay-gate')).toBe(i('m-weekly-gate') + 1);
    expect(i('m-locks')).toBe(i('m-parlay-gate') + 1);

    // WEEKLY SPLIT GATE — header, MEASURED stamp, ADOPTED chip, the numbers.
    await expect(weekly.locator('.m-head')).toContainText('WEEKLY SPLIT GATE');
    await expect(weekly.locator('.m-head .ms-badge')).toHaveText('MEASURED');
    await expect(weekly.locator('.gate-chip--adopted')).toHaveText('ADOPTED');
    const wt = (await weekly.innerText()).replace(/\s+/g, ' ');
    expect(wt).toContain('weekly_split_v2 vs weekly_split_v1');
    expect(wt).toContain('6.211');
    expect(wt).toContain('6.035');
    expect(wt).toContain('−0.176 ▲');
    expect(wt).toContain('77.7%');
    expect(wt).toContain('BOOTSTRAP ΔMAE 2025');
    expect(wt).toContain('B=400');
    expect(wt).toContain('NEVER-REGRESS RULE');
    await expect(weekly.locator('table.pf-tbl')).toHaveCount(2);

    // PARLAY GATE — badge on the moneyline row, NO EDGE on spread, ADOPTED on props.
    await expect(parlay.locator('.m-head')).toContainText('PARLAY GATE');
    const badge = parlay.locator('.gate-row .ms-badge', { hasText: 'MEASUREMENT ONLY' });
    await expect(badge).toHaveCount(1);
    await expect(badge).toBeVisible();
    await expect(parlay.locator('.gate-chip--nopath')).toHaveText('NO EDGE');
    await expect(parlay.locator('.gate-chip--adopted')).toHaveText('ADOPTED');
    const pt = (await parlay.innerText()).replace(/\s+/g, ' ');
    expect(pt).toContain('0.6362');
    expect(pt).toContain('0.6081');
    expect(pt).toContain('0.7196');
    expect(pt).toContain('0.6931');
    expect(pt).toContain('45.7%');
    expect(pt).toContain('0.6912 → 0.6778');
    expect(pt).toContain('65.6% (221)');
    expect(pt).toContain('0.71');
    await expect(parlay.locator('table.pf-tbl')).toHaveCount(2);
    // The chips are legible, not collapsed.
    const box = await parlay.locator('.gate-chip--nopath').boundingBox();
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(10);
    expect(errors).toEqual([]);
  });

  test('PRESENT without a verdict: AWAITING state, none of the numbers shown as judged', async ({ page }) => {
    const errors = collectErrors(page);
    const w = JSON.parse(WEEKLY);
    delete w.verdict;
    const p = JSON.parse(PARLAY);
    delete p.props.verdict;
    await routeBacktests(page, { weekly: JSON.stringify(w), parlay: JSON.stringify(p) });
    await openModel(page);
    for (const sel of ['.m-weekly-gate', '.m-parlay-gate']) {
      const card = page.locator(sel);
      await expect(card).toHaveCount(1);
      await expect(card.locator('.gate-chip--skipped')).toHaveText('AWAITING');
      await expect(card.locator('.state')).toHaveCount(1);
      await expect(card.locator('.state')).toContainText('AWAITING VERDICT');
      await expect(card.locator('.gate-chip--adopted')).toHaveCount(0);
      await expect(card.locator('table.pf-tbl')).toHaveCount(0);
    }
    const wt = await page.locator('.m-weekly-gate').innerText();
    expect(wt).not.toContain('6.211');
    const pt = await page.locator('.m-parlay-gate').innerText();
    expect(pt).not.toContain('0.6362');
    expect(pt).not.toContain('MEASUREMENT ONLY');
    expect(errors).toEqual([]);
  });

  test('COMMITTED data, unrouted: the deploy is in exactly one of the two honest states', async ({ page }) => {
    const errors = collectErrors(page);
    const status = {};
    page.on('response', (res) => {
      const m = res.url().match(/\/data\/(weekly_backtest|parlay_backtest)\.json$/);
      if (m) status[m[1]] = res.status();
    });
    await openModel(page);
    await page.waitForTimeout(500);
    expect(Object.keys(status).sort()).toEqual(['parlay_backtest', 'weekly_backtest']);
    for (const [name, cls] of [['weekly_backtest', '.m-weekly-gate'], ['parlay_backtest', '.m-parlay-gate']]) {
      const card = page.locator(cls);
      if (status[name] === 200) {
        await expect(card, `${name} is committed, so its card renders`).toHaveCount(1);
        // Either a full record (no .state) or an honest AWAITING — never an empty shell.
        const states = await card.locator('.state').count();
        if (states) await expect(card.locator('.gate-chip--skipped')).toHaveText('AWAITING');
        else expect((await card.innerText()).length).toBeGreaterThan(200);
      } else {
        await expect(card, `${name} is absent (${status[name]}), so nothing renders`).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });
});
