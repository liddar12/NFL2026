/* tests/web/r27_draft_room.spec.mjs — R27 on the surfaces a manager touches.
 *
 * The engine rules are locked in tests/feature/r27_auction.test.mjs. What is
 * locked HERE is that they are reachable: a budget you can type, a per-team
 * editor that changes the room's money, an observed price you can enter rather
 * than step to, and a kicker that is actually on the board.
 *
 * These are the four things that were wrong on 2026-08-14, stated as the
 * manager experiences them.
 */

import { test, expect } from '@playwright/test';

const KDEF_PROFILE = {
  version: 1,
  name: 'K/DEF League',
  shape: {
    teams: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    position_caps: { QB: 2, K: 1, DEF: 1 },
  },
};

/** Open the Team page with the draft simulator in auction mode. */
async function auctionSetup(page, { profile = null, live = false } = {}) {
  if (profile) {
    await page.addInitScript((p) => {
      localStorage.setItem('nfl2026.league.v1', JSON.stringify(p));
    }, profile);
  }
  await page.goto('/#/team');
  await page.waitForSelector('.ds-head', { timeout: 20000 });
  await page.selectOption('select[data-dcfg="mode"]', 'auction');
  if (live) await page.selectOption('select[data-dcfg="play"]', 'live');
  await page.waitForSelector('.tb-panel');
}

test.describe('R27 — the draft room knows what money is in it', () => {
  test('BUDGET is typed, not picked from three blessed values', async ({ page }) => {
    await auctionSetup(page);
    const box = page.locator('input[data-dnum="budget"]');
    await expect(box).toHaveCount(1);
    // The defect: a <select> of $100/$200/$300 could not express a $150 league.
    await box.fill('150');
    await box.dispatchEvent('change');
    await expect(page.locator('.ds-sub-note').first()).toContainText('$150');
    // The old choices survive as suggestions, so the common cases stay one tap.
    await expect(page.locator('#ds-budget-choices option')).toHaveCount(3);
  });

  test('the league default cascades while the room is level', async ({ page }) => {
    await auctionSetup(page);
    await page.locator('input[data-dnum="budget"]').fill('150');
    await page.locator('input[data-dnum="budget"]').dispatchEvent('change');
    await expect(page.locator('.tb-panel .lp-summary')).toContainText('LEVEL');
    await expect(page.locator('input[data-tbudget="0"]')).toHaveValue('150');
    await expect(page.locator('input[data-tbudget="11"]')).toHaveValue('150');
  });

  test('one uneven team changes the money in the room, and says so', async ({ page }) => {
    await auctionSetup(page);
    await page.locator('.tb-panel .lp-summary').click();
    const t3 = page.locator('input[data-tbudget="2"]');
    await t3.fill('185');
    await t3.dispatchEvent('change');
    // 11 x 200 + 185. The header must not keep advertising "$200 BUDGET" when
    // that is only one team's number.
    await expect(page.locator('.ds-sub-note').first()).toContainText('2385');
    await expect(page.locator('.ds-sub-note').first()).toContainText('UNEVEN');
    await expect(page.locator('.tb-panel .lp-summary')).toContainText('UNEVEN');
    // ...and it is recoverable in one tap.
    await page.locator('[data-act="tb-level"]').click();
    await expect(page.locator('.tb-panel .lp-summary')).toContainText('LEVEL');
  });

  test('a blank team box means "not stated", never "no money"', async ({ page }) => {
    await auctionSetup(page);
    await page.locator('.tb-panel .lp-summary').click();
    const t1 = page.locator('input[data-tbudget="0"]');
    await t1.fill('');
    await t1.dispatchEvent('change');
    await expect(t1).toHaveValue('200');
  });

  test('an observed sale price is TYPED, and it is the number recorded', async ({ page }) => {
    await auctionSetup(page, { live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('.auc-poolchip');
    await page.locator('.auc-poolchip').first().click();
    await page.waitForSelector('.auc-soldrow');

    const price = page.locator('input.auc-soldprice');
    await expect(price).toHaveCount(1);
    // T3 (index 2) pays $47 — a number no stepper would reach quickly from our
    // own valuation, which is exactly why it has to be typeable.
    await page.selectOption('.auc-soldteam', '2');
    await price.fill('47');
    await price.dispatchEvent('change');
    await page.click('[data-act="auc-sold"]');

    const zones = page.locator('.auc-zone');
    await expect(zones.filter({ hasText: 'T3' }).first()).toContainText('$153');
  });

  test('the LIVE row action reads TOOK — it records, it does not bid', async ({ page }) => {
    await auctionSetup(page, { live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('#t-cands');
    const btn = page.locator('#t-cands [data-act="auc-nom"]').first();
    await expect(btn).toHaveText('TOOK');
  });

  test('a K/DEF league can actually draft a kicker', async ({ page }) => {
    await auctionSetup(page, { profile: KDEF_PROFILE, live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('#t-cands');

    // The finder offers the positions the league seats...
    await expect(page.locator('[data-fpos="K"]')).toHaveCount(1);
    await expect(page.locator('[data-fpos="DEF"]')).toHaveCount(1);

    await page.locator('[data-fpos="K"]').click();
    const rows = page.locator('#t-cands [data-act="auc-nom"]');
    await expect(rows.first()).toBeVisible();
    // ...and every kicker is draftable, which is the defect: the room's board
    // was adp.json, which has no kickers on it at all.
    expect(await rows.count()).toBeGreaterThan(0);

    await rows.first().click();
    const block = page.locator('.auc-zone--block');
    await expect(block).toContainText('K');
    // The $1 tier, as chosen: a kicker's replacement is the kicker behind him.
    await expect(block).toContainText('OURS $1');
    // And no invented ADP for a player who has none.
    await expect(block).not.toContainText('ADP undefined');
  });

  test('the RECO panel states the ceiling it is applying', async ({ page }) => {
    await auctionSetup(page, { live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('.reco-sublabel');
    // A filter the manager cannot see is a filter they cannot trust.
    await expect(page.locator('.reco-sublabel')).toContainText('max bid');
  });
});
