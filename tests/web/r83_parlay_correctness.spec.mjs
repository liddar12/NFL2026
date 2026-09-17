import { test, expect } from '@playwright/test';

const player = (id, name, team, game, p) => ({
  gsis_id: id, player: name, team, position: 'WR', market: 'wr_rec_yds',
  game_id: game, side: 'home', mu: 70, pricing: 'pool_calibrated',
  rungs: [{ line: 39.5, z: 0, selection: `${name} 40+ rec yds`, model_prob: p }],
});
const pool = (side) => ({
  season: 2026, week: 2,
  players: [player('a', 'Alpha One', 'AAA', 'g1', 0.8),
    player('b', 'Beta Two', 'BBB', 'g2', 0.7)],
  game_legs: [{ market: 'moneyline', selection: 'AAA ML', team: 'AAA',
    game_id: 'g1', model_prob: 0.6, implied_prob: 0.62,
    ...(side ? { side } : {}) }],
});

for (const side of [null, 'home']) {
  test(`R83: mixed cards retain correlation with ${side ? 'new' : 'legacy'} pool identity`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/data/leg_pool.json', (route) => route.fulfill({ json: pool(side) }));
    await page.route('**/data/parlay_backtest.json', (route) => route.fulfill({
      json: { correlations: { pairs: [], default_rho: 0.1 } },
    }));
    await page.goto('/#/parlays');
    await page.click('.scopeseg [data-seg="my"]');
    await page.fill('#mp-input', 'Alpha One');
    await page.press('#mp-input', 'Enter');
    const card = page.locator('.mp-card').filter({ hasText: '3 LEG · MIXED GAMES' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.leg-nm')).toHaveCount(3);
    await expect(card).toContainText('AAA ML');
    // Independent oracle: (.8*.6 + .1*sqrt(.8*.2*.6*.4)) * .7 = .349717…
    // R82 multiplied all three marginals, displaying 34 instead of 35.
    await expect(card.locator('.ev')).toHaveText('35CONVICTION');
    await expect(page.locator('#myparlays-host [role="status"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('R83: unverifiable game identity is visibly withheld instead of guessing a side', async ({ page }) => {
  const input = pool(null);
  input.game_legs[0].game_id = 'different-event';
  await page.route('**/data/leg_pool.json', (route) => route.fulfill({ json: input }));
  await page.goto('/#/parlays');
  await page.click('.scopeseg [data-seg="my"]');
  await expect(page.locator('#myparlays-host [role="status"]'))
    .toContainText('1 game leg(s) unavailable');
  await page.fill('#mp-input', 'Alpha One');
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('.mp-card')).toHaveCount(1);
  await expect(page.locator('.mp-card')).not.toContainText('AAA ML');
});
