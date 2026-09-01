/* tests/web/r48_team_sync.spec.mjs — R48-A: one press on TEAM syncs the
 * league settings, reads the rosters, asks once which team is mine, seats it
 * (bench included), and LINEUP follows. Real P.T.I. payloads (tests/fixtures/
 * sleeper_pti) stand in for api.sleeper.app.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIX = new URL('../fixtures/sleeper_pti/', import.meta.url);
const file = (n) => readFileSync(new URL(n, FIX), 'utf8');
const LEAGUE_ID = '1367481303166914560';

async function mockSleeper(page) {
  await page.route(/api\.sleeper\.app/, async (route) => {
    const u = route.request().url();
    let body = '[]';
    if (/\/league\/\d+$/.test(u)) body = file('league.json');
    else if (/\/rosters$/.test(u)) body = file('rosters.json');
    else if (/\/users$/.test(u)) body = file('users.json');
    else if (/\/players\/nfl$/.test(u)) body = file('player_index_trimmed.json');
    else if (/\/matchups\/(\d+)$/.test(u)) {
      const w = Number(u.match(/\/matchups\/(\d+)$/)[1]);
      body = w <= 14 ? file(`matchups_${w}.json`) : '[]';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['nfl2026.league.v1', 'nfl2026.team.v1', 'nfl2026.league_id.v1',
      'nfl2026.myroster.v1', 'nfl2026.scoring.v1']) localStorage.removeItem(k);
  });
  await mockSleeper(page);
});

test('one press: settings saved, rosters read, pick once, roster seated, LINEUP follows', async ({ page }) => {
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  await page.locator('[data-act="sleeper-sync"]').click();

  // Settings landed and the view remounted WITH the id still in the field.
  await expect(page.locator('#league-chip')).toContainText('P.T.I.', { timeout: 15000 });
  await expect(page.locator('#t-draft input[data-lin="sleeperId"]')).toHaveValue(LEAGUE_ID);
  // The roster read ran on its own: ten teams to pick from — IN THE BANNER
  // above the roster grid (R48b: the next step sits beside what it fills).
  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toBeVisible({ timeout: 30000 });
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM');
  expect(await page.locator('#t-syncbar select[data-rcfg="team"] option').count()).toBe(11);
  await expect(page.locator('#t-draft')).toContainText('PICK YOUR TEAM');
  expect(await page.locator('.roster .slot-player').count()).toBe(0);

  // Picking seats the team on the spot (empty roster -> nothing can be dropped),
  // and the banner turns into the RESULT, right above the roster it filled.
  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expect(banner).toContainText('SEATED FROM SLEEPER', { timeout: 15000 });
  await expect(banner).toContainText('12 of 14');
  await expect(page.locator('#t-draft')).toContainText('roster seated from Sleeper', { timeout: 15000 });
  const seated = await page.locator('.roster .slot-player').count();
  expect(seated).toBeGreaterThanOrEqual(12);     // 14 rostered, 2 have no projection
  expect(await page.locator('.roster .slot').count()).toBe(14); // 9 starters + 5 bench
  await expect(page.locator('#t-draft')).toContainText('could not be matched');
  // The pick is remembered for THIS league.
  const remembered = await page.evaluate(() => localStorage.getItem('nfl2026.myroster.v1'));
  expect(JSON.parse(remembered)).toEqual({ [LEAGUE_ID]: 4 });
  // R48-D: this league fields no K slot, and the roster says so.
  await expect(page.locator('.roster-note')).toContainText('fields no K slot');

  // LINEUP reads the seated roster: nine starter rows, no K, the note.
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-card', { timeout: 15000 });
  expect(await page.locator('.lu-card').first().locator('.lu-row').count()).toBe(9);
  await expect(page.locator('.lu-card').first()).toContainText('fields no K slot');
  await expect(page.locator('.lu-card').first()).not.toContainText('K1');
});

test('the second press needs no pick and drops nobody', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('nfl2026.myroster.v1', JSON.stringify({ [id]: 4 }));
  }, LEAGUE_ID);
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  await page.locator('[data-act="sleeper-sync"]').click();
  await expect(page.locator('#t-draft')).toContainText('roster seated from Sleeper', { timeout: 40000 });
  await expect(page.locator('#t-draft')).toContainText('0 removed');
  expect(await page.locator('.roster .slot-player').count()).toBeGreaterThanOrEqual(12);
  expect(await page.locator('[data-act="roster-apply"]').count()).toBe(0);
  await expect(page.locator('select[data-rcfg="team"]')).toHaveValue('3');
});

test('a hand-seated player is never dropped without the deliberate confirm', async ({ page }) => {
  const proj = JSON.parse(readFileSync(new URL('../../data/player_projections.json', import.meta.url), 'utf8'));
  const stranger = proj.players.find((p) => p.position === 'QB');
  await page.addInitScript(({ id, qb }) => {
    localStorage.setItem('nfl2026.myroster.v1', JSON.stringify({ [id]: 4 }));
    localStorage.setItem('nfl2026.team.v1', JSON.stringify({ slots: { QB1: qb } }));
  }, { id: LEAGUE_ID, qb: String(stranger.gsis_id) });
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot-player', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  await page.locator('[data-act="sleeper-sync"]').click();
  await expect(page.locator('#t-draft')).toContainText('remembered as your team', { timeout: 40000 });
  // The plan would remove the hand-seated QB, so it waits for the confirm.
  await expect(page.locator('#t-draft')).toContainText('removes players seated now');
  await expect(page.locator('[data-act="roster-apply"]')).toBeVisible();
  expect(await page.locator('.roster .slot-player').count()).toBe(1);
});
