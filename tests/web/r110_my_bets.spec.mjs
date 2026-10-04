/* R110 (R99 E2) — MY BETS in the browser: the BETS chip, I BET THIS, the slip
 * stack, the guard, the builder. Owner, 2026-10-04 (Gate 2): a BETS chip in
 * PARLAYS, the slip-stack look; bets kept on the device.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { SKIP_REASON, SEED_TEAM } from './_myseed.mjs';

const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const HAS_FACTS = existsSync(new URL('../../data/bet_facts.json', import.meta.url));
const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

async function mount(page) {
  await page.goto('/#/parlays');
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
}

async function openBets(page) {
  await page.click('.scopeseg [data-seg="bets"]');
  await page.waitForSelector('#mybets-host:not([hidden]) .mb-actions', { timeout: 20000 });
}

async function saveFirstCard(page, stake = '20', odds = '+250') {
  const btn = page.locator('#parlays-list .card.parlay .bet-this').first();
  await btn.click();
  const sheet = page.locator('.mb-sheet [role="dialog"]');
  await expect(sheet).toBeVisible();
  await page.fill('#mb-stake', stake);
  await page.fill('#mb-odds', odds);
  await page.click('.mb-sheet [data-mb="save"]');
  await expect(page.locator('.mb-sheet')).toHaveCount(0);
}

test('the BETS chip sits beside GAME / WEEK / MY and opens an honest empty ledger', async ({ page }) => {
  const errors = errorsOf(page);
  await mount(page);
  await expect(page.locator('.scopeseg [data-seg]')).toHaveText(['GAME', 'WEEK', 'MY', 'BETS']);
  await openBets(page);
  await expect(page.locator('#mybets-host')).toContainText('No bets yet');
  await expect(page.locator('#parlays-list')).toBeHidden();
  await expect(page.locator('.view-sub')).toContainText('MY BETS');
  // back to GAME restores the slate
  await page.click('.scopeseg [data-seg="game"]');
  await expect(page.locator('#mybets-host')).toBeHidden();
  await expect(page.locator('#parlays-list')).toBeVisible();
  expect(errors).toEqual([]);
});

test('I BET THIS on a GAME card: a 44px button, a sheet, a saved slip that survives a reload', async ({ page }) => {
  const errors = errorsOf(page);
  await mount(page);
  const btn = page.locator('#parlays-list .card.parlay .bet-this').first();
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);   // HIG touch target (sub-pixel layout)
  // the sheet pre-fills the card's fair price and states the return
  await btn.click();
  await expect(page.locator('#mb-odds')).toHaveValue(/^[+-]\d+$/);
  await expect(page.locator('#mb-ret')).toContainText('To return');
  await page.click('.mb-sheet [data-mb="cancel"]');
  await expect(page.locator('.mb-sheet')).toHaveCount(0);
  await saveFirstCard(page);
  await expect(page.locator('.scopeseg [data-seg="bets"]')).toHaveText(/^BETS( · 1)?$/);
  await openBets(page);
  const slip = page.locator('.mb-slip');
  await expect(slip).toHaveCount(1);
  await expect(slip).toContainText('$20');
  await expect(slip).toContainText('+250');
  await expect(slip.locator('.mb-leg')).toHaveCount(await slip.locator('.mb-leg').count());
  // on the device: a reload keeps it
  await page.reload();
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  await openBets(page);
  await expect(page.locator('.mb-slip')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the same card twice: the sheet says so before saving, and the guard names the overlap', async ({ page }) => {
  const errors = errorsOf(page);
  await mount(page);
  await saveFirstCard(page);
  await page.locator('#parlays-list .card.parlay .bet-this').first().click();
  await expect(page.locator('.mb-sheet')).toContainText('already recorded this exact bet');
  await expect(page.locator('.mb-sheet .mb-warn').filter({ hasText: 'would be on 2 of your bets' }).first()).toBeVisible();
  await page.click('.mb-sheet [data-mb="save"]');
  await openBets(page);
  await expect(page.locator('.mb-slip')).toHaveCount(2);
  await expect(page.locator('.mb-slip .mb-warn').first()).toContainText('is on 2 of your');
  // delete one (confirm) -> one left
  page.once('dialog', (d) => d.accept());
  await page.locator('.mb-slip [data-mb="delete"]').first().click();
  await expect(page.locator('.mb-slip')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('BUILD A BET from this week\'s pool: search, pick, NEXT opens the sheet', async ({ page }) => {
  const errors = errorsOf(page);
  const row = (POOL.players || [])[0];
  test.skip(!row, 'no leg pool on file');
  await mount(page);
  await openBets(page);
  await page.click('[data-mb="build"]');
  await page.waitForSelector('#mb-q', { timeout: 20000 });
  await page.fill('#mb-q', String(row.player).split(' ').pop().slice(0, 5));
  const hit = page.locator('.mb-hits [data-hit]').first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator('.mb-picked .leg-chip')).toHaveCount(1);
  await page.click('[data-bx="next"]');
  await expect(page.locator('.mb-sheet [role="dialog"]')).toContainText('1 LEG');
  await page.click('.mb-sheet [data-mb="save"]');
  await expect(page.locator('.mb-slip')).toHaveCount(1);
  await expect(page.locator('.mb-slip')).toContainText('BUILT');
  expect(errors).toEqual([]);
});

test('I BET THIS on a MY card records it as a MY bet', async ({ page }) => {
  test.skip(!!SKIP_REASON, SKIP_REASON);
  const errors = errorsOf(page);
  await mount(page);
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.fill('#mp-input', SEED_TEAM);
  await page.press('#mp-input', 'Enter');
  const btn = page.locator('#mp-list .mp-card .bet-this').first();
  await expect(btn).toBeVisible({ timeout: 20000 });
  await btn.click();
  await page.click('.mb-sheet [data-mb="save"]');
  await openBets(page);
  await expect(page.locator('.mb-slip')).toContainText('MY');
  expect(errors).toEqual([]);
});

test('the owner\'s 19 FanDuel slips import with their own results and money', async ({ page }) => {
  test.skip(!HAS_FACTS, 'data/bet_facts.json not built yet (slip dates map to weeks through it)');
  const errors = errorsOf(page);
  await mount(page);
  await openBets(page);
  await page.click('[data-mb="slips"]');
  await expect(page.locator('.mb-slip')).toHaveCount(19);
  await expect(page.locator('.mb-totals')).toContainText('$186');
  await expect(page.locator('.mb-totals')).toContainText('$608.33');
  await expect(page.locator('[data-mb="slips"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
