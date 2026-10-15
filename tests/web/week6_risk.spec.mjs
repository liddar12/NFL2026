import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const week = doc.parlays.filter((c) => c.scope === 'week');
const exposure = new Map();
for (const c of week) {
  for (const selection of new Set(c.legs.map((l) => l.selection))) {
    exposure.set(selection, (exposure.get(selection) || 0) + 1);
  }
}
const max = Math.max(...exposure.values());

test('Week shared-risk warning follows shown cards and does not leak into other modes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/#/parlays');
  await expect(page.locator('#parlays-list .card.parlay').first()).toBeVisible();
  await expect(page.locator('#portfolio-risk')).toBeHidden();
  await page.locator('.scopeseg [data-seg="week"]').click();
  await expect(page.locator('#portfolio-risk summary')).toContainText(`${max}/${week.length}`);
  await page.locator('#portfolio-risk summary').click();
  await expect(page.locator('#portfolio-risk')).toContainText('selection has not been diversified');
  await expect(page.locator('#portfolio-risk')).toContainText('Assumes independent games, not independent cards');
  await page.locator('#parlay-filters summary').click();
  await page.locator('#leg-controls [data-leg="2"]').click();
  const short = week.filter((c) => c.legs.length === 2).length;
  await expect(page.locator('#parlays-list .card.parlay')).toHaveCount(short);
  await expect(page.locator('#portfolio-risk summary')).toContainText(`/${short} share one game`);
  const bounds = await page.locator('#portfolio-risk').boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.locator('.scopeseg [data-seg="my"]').click();
  await expect(page.locator('#portfolio-risk')).toBeHidden();
  await page.locator('.scopeseg [data-seg="game"]').click();
  await expect(page.locator('#portfolio-risk')).toBeHidden();
  expect(errors).toEqual([]);
});
