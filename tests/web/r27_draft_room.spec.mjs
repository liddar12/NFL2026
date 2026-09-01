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

  /* R34 — typing is now MANDATORY, so the R27 assertion ("typed wins over the
   * seed") upgrades to the blank-required contract: the field opens EMPTY with
   * our estimate as placeholder only, the buyer select opens on a no-buyer
   * placeholder, and RECORD SALE stays disabled until BOTH are set. The
   * recorded number is still exactly what was typed. */
  test('a sale requires a SELECTED buyer and a TYPED price, and records the typed number', async ({ page }) => {
    await auctionSetup(page, { live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('.auc-poolchip');
    await page.locator('.auc-poolchip').first().click();
    await page.waitForSelector('.auc-soldrow');

    const price = page.locator('input.auc-soldprice');
    const record = page.locator('[data-act="auc-sold"]');
    await expect(price).toHaveCount(1);
    // The price is NOT prefilled with our estimate — the estimate is a
    // placeholder hint, and a blank submit is impossible (button disabled).
    await expect(price).toHaveValue('');
    expect(await price.getAttribute('placeholder')).toMatch(/^\d+\?$/);
    await expect(page.locator('.auc-soldteam')).toHaveValue('');
    await expect(record).toBeDisabled();
    // A buyer alone is not enough…
    await page.selectOption('.auc-soldteam', '2');
    await expect(record).toBeDisabled();
    // …a typed price completes the capture. T3 (index 2) pays $47 — a number
    // no stepper would reach quickly from our valuation.
    await price.fill('47');
    await expect(record).toBeEnabled();
    await record.click();

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

  /* ------------------------------------------------------------------------
     Caught by the owner reviewing the PR #38 preview, not by the suite. Both
     are the same failure of nerve: the release changed the behaviour and left
     the places that DESCRIBE the behaviour saying the old thing. A user who
     reads "the draft simulator does not draft them" stops looking for the
     kicker that is now right there, so the app being wrong out loud is worse
     than the gap it replaced.
     ------------------------------------------------------------------------ */
  test('a league that seats K/DEF is never told they are not drafted', async ({ page }) => {
    await page.addInitScript((p) => {
      localStorage.setItem('nfl2026.league.v1', JSON.stringify(p));
    }, KDEF_PROFILE);
    await page.goto('/#/team');
    await page.waitForSelector('.ds-head', { timeout: 20000 });
    await expect(page.locator('.draftsim')).not.toContainText('does not draft them');
  });

  test('the roster summary counts the K and DEF seats the room will actually run', async ({ page }) => {
    // Omilia-US: 9 starters + 4 bench. The summary used to hand-roll
    // qb+rb+wr+te+flex and report "7 STARTERS ... 11 ROUNDS" while the room it
    // launched ran 13 — the card describing a league the app was not simulating.
    await page.addInitScript((p) => {
      localStorage.setItem('nfl2026.league.v1', JSON.stringify(p));
    }, {
      version: 1,
      name: 'Omilia-US',
      shape: {
        teams: 10,
        roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
          'BN', 'BN', 'BN', 'BN'],
        position_caps: { QB: 2, K: 1, DEF: 1 },
      },
      scoring: { rec: 1 },
    });
    await page.goto('/#/team');
    await page.waitForSelector('.ds-head', { timeout: 20000 });
    await expect(page.locator('.draftsim')).toContainText('9 STARTERS + 4 BENCH · 13 ROUNDS');
  });

  test('the card never claims a limit it no longer has', async ({ page }) => {
    // "the 13-slot roster panel on this page is still fixed" stopped being true
    // when R19 built the panel from the profile's own slots, and R27 made it
    // visibly false — a K/DEF league renders K and DEF slots. A stale
    // confession is still the app stating something untrue.
    await page.addInitScript((p) => {
      localStorage.setItem('nfl2026.league.v1', JSON.stringify(p));
    }, KDEF_PROFILE);
    await page.goto('/#/team');
    await page.waitForSelector('.ds-head', { timeout: 20000 });
    await expect(page.locator('.draftsim')).not.toContainText('13-slot roster panel');
    // R28 — and the sentence that REPLACED it went stale within one release:
    // it said a K/DEF league had to arrive by Sleeper import, which stopped
    // being true the moment the K and DEF counters shipped. Both dead claims
    // are asserted absent, and the one limit that is still real is asserted
    // present. This is the pattern the stale-text audit generalises.
    await expect(page.locator('.draftsim')).not.toContainText('has to come in through the Sleeper');
    // R30b — the third generation of this sentence. "a SUPERFLEX league is
    // priced as if" blamed EVERY room, which stopped being true at R23: the
    // AI+ room reads the saved flex slots in full. The sentence now names the
    // rooms the limit is real for (ADP/SHARK/auction) and says the AI+ room is
    // exempt — so this spec asserts the scoped claim and the exemption, and
    // asserts the over-broad generation is gone.
    await expect(page.locator('.draftsim')).not.toContainText('SUPERFLEX league is priced as if');
    await expect(page.locator('.draftsim')).toContainText('they treat a SUPERFLEX league as if');
    await expect(page.locator('.draftsim')).toContainText('AI+ room reads your saved flex slots in full');
  });

  test('K and DEF can be set by hand, not only by import (R28)', async ({ page }) => {
    // The RCA finding: the app supported K/DEF end to end EXCEPT the one
    // control that lets a hand-built league say it has them.
    await page.goto('/#/team');
    await page.waitForSelector('.ds-head', { timeout: 20000 });
    await expect(page.locator('select[data-dcfg="k"]')).toHaveCount(1);
    await expect(page.locator('select[data-dcfg="def"]')).toHaveCount(1);
    // Default league seats neither, and the roster summary agrees.
    await expect(page.locator('.draftsim')).toContainText('9 STARTERS'); // R47: K + DEF seated by default
    await page.selectOption('select[data-dcfg="k"]', '1');
    await page.selectOption('select[data-dcfg="def"]', '1');
    // Two more starters, two more rounds — the room will run them.
    await expect(page.locator('.draftsim')).toContainText('9 STARTERS');
  });

  test('the RECO panel states the ceiling it is applying', async ({ page }) => {
    await auctionSetup(page, { live: true });
    await page.click('[data-act="auc-start"]');
    await page.waitForSelector('.reco-sublabel');
    // A filter the manager cannot see is a filter they cannot trust.
    await expect(page.locator('.reco-sublabel')).toContainText('max bid');
  });
});
