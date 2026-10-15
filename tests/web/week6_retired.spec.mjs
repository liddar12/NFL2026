import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8'));

test('Players AI+ explains a retired fixture as nonplayable when the weekly headline renders', async ({ page }) => {
  const projections = read('player_projections');
  const target = projections.players[0];
  projections.players = [target];
  const weekly = read('player_weekly');
  const row = weekly.players.find((p) => p.gsis_id === target.gsis_id);
  const week = read('game_predictions').week;
  // A synthetic status fixture, not a claim about the selected real player.
  row.availability = { status: 'RETIRED', class: 'season' };
  row.this_week = { wk: week, playable: false, reason: 'status', status: 'RETIRED' };
  Object.assign(row.weeks.find((w) => w.wk === week), { pts: 0, avail: false, bye: false });
  weekly.players = [row];
  for (const [name, document] of [['player_projections', projections], ['player_weekly', weekly]]) {
    await page.route(`**/data/${name}.json*`, (route) => route.fulfill({ json: document }));
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/#/players');
  const card = page.locator(`.card.player[data-gsis="${target.gsis_id}"]`);
  await expect(card).toBeVisible();
  await page.locator('.aiseg [data-ai="on"]').click();
  await expect(card.locator('.p-proj .p-num')).toHaveText('0.0');
  const label = card.locator('.p-proj .p-unit').first();
  await expect(label).toHaveText(`WK ${week} · RETIRED`);
  await expect(label).toHaveAttribute('title', 'Not playable this week — retired');
  expect(errors).toEqual([]);
});
