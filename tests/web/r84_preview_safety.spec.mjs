import { test, expect } from '@playwright/test';

test('R84: navigating away from a stalled required feed does not wait for it', async ({ page }) => {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  await page.route('**/data/game_predictions.json', async (route) => {
    await paused;
    await route.continue().catch(() => {});
  });
  await page.goto('/#/');
  await expect(page.locator('#view')).toContainText('Loading slate');
  await page.locator('.tab[data-tab="parlays"]').click();
  await expect(page.locator('.card.parlay').first()).toBeVisible({ timeout: 4000 });
  release();
  await expect(page.locator('.view-title')).toHaveText('PARLAYS');
});

test('R84: a stale review with the same card ID cannot grade different legs', async ({ page }) => {
  await page.route('**/data/review.json', async (route) => {
    const response = await route.fetch();
    const doc = await response.json();
    Object.values(doc.weeks).forEach((week) => week.parlays.forEach((row) => {
      row.legs.forEach((leg) => { leg.selection = 'WRONG RECEIPT'; leg.result = 'hit'; });
      row.result = 'hit'; row.bucket = 'all_hit';
    }));
    await route.fulfill({ json: doc });
  });
  await page.goto('/#/parlays');
  await expect(page.locator('.card.parlay').first()).toBeVisible();
  await expect(page.locator('.rv-strip--parlay')).toBeVisible();
  await expect(page.locator('.card.parlay .rv-pchip')).toHaveCount(0);
  await expect(page.locator('.card.parlay .rv-leg')).toHaveCount(0);
  await expect(page.locator('.card.parlay .pay').first()).toContainText('SIM NET · IF HIT');
  await expect(page.locator('#parlay-pnl')).toContainText('unavailable');
});

test('R84: MY drops legs when kickoff arrives while the page remains open', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-17T20:00:00Z') });
  await page.route('**/data/schedule_full.json', (route) => route.fulfill({ json: {
    season: 2026, games: [{ game_id: 'g1', home: 'AAA', away: 'BBB', week: 2,
      status: 'STATUS_SCHEDULED', kickoff_utc: '2026-09-17T20:01:00Z' }],
  } }));
  await page.route('**/data/leg_pool.json', (route) => route.fulfill({ json: {
    season: 2026, week: 2, players: ['One', 'Two'].map((name, i) => ({
      gsis_id: name, player: name, team: 'AAA', position: 'WR', market: 'wr_rec_yds',
      game_id: 'g1', side: 'home', mu: 70, pricing: 'pool_calibrated',
      rungs: [{ line: 39.5, z: 0, selection: `${name} 40+ rec yds`, model_prob: .7 - i * .1 }],
    })), game_legs: [],
  } }));
  await page.goto('/#/parlays');
  await page.click('[data-seg="my"]');
  await page.fill('#mp-input', 'One');
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('.mp-card')).toHaveCount(1);
  await page.clock.fastForward(61000);
  await expect(page.locator('.mp-card')).toHaveCount(0);
  // R89 — the fixed "No upcoming card is available" sentence is gone: the empty
  // state now names the game and what it is doing. g1 is still STATUS_SCHEDULED
  // in this fixture but kicked off 60s ago, so it reads "in progress".
  await expect(page.locator('#mp-list')).toContainText('BBB @ AAA is in progress');
  await expect(page.locator('#mp-list'))
    .toContainText('cards are built only for games that have not kicked off');
});
