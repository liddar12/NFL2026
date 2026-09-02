/* tests/web/r49_waivers.spec.mjs — R49 LINEUP WAIVERS: after one TEAM sync the
 * league's rosters and Sleeper's current week are remembered, LINEUP opens on
 * that week, and the WAIVER WIRE card lists BEST FIT / BEST AVAILABLE from the
 * unrostered pool only. A fresh device gets the honest "sync first" sentence.
 * Real P.T.I. payloads (tests/fixtures/sleeper_pti) and the captured
 * /v1/state/nfl (tests/fixtures/sleeper_proj/state.json) stand in for
 * api.sleeper.app.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIX = new URL('../fixtures/sleeper_pti/', import.meta.url);
const file = (n) => readFileSync(new URL(n, FIX), 'utf8');
const STATE = readFileSync(new URL('../fixtures/sleeper_proj/state.json', import.meta.url), 'utf8');
const LEAGUE_ID = '1367481303166914560';
const KEYS = ['nfl2026.league.v1', 'nfl2026.team.v1', 'nfl2026.league_id.v1', 'nfl2026.myroster.v1',
  'nfl2026.scoring.v1', 'nfl2026.leaguerosters.v1', 'nfl2026.nflweek.v1'];

async function mockSleeper(page) {
  await page.route(/api\.sleeper\.app/, async (route) => {
    const u = route.request().url();
    let body = '[]';
    if (/\/league\/\d+$/.test(u)) body = file('league.json');
    else if (/\/rosters$/.test(u)) body = file('rosters.json');
    else if (/\/users$/.test(u)) body = file('users.json');
    else if (/\/players\/nfl$/.test(u)) body = file('player_index_trimmed.json');
    else if (/\/state\/nfl$/.test(u)) body = STATE;
    else if (/\/matchups\/(\d+)$/.test(u)) {
      const w = Number(u.match(/\/matchups\/(\d+)$/)[1]);
      body = w <= 14 ? file(`matchups_${w}.json`) : '[]';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((keys) => { for (const k of keys) localStorage.removeItem(k); }, KEYS);
  await mockSleeper(page);
});

test('sync on TEAM, then LINEUP opens on Sleeper\'s week with a waiver wire of unrostered players only', async ({ page }) => {
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  await page.locator('[data-act="sleeper-sync"]').click();
  await expect(page.locator('#league-chip')).toContainText('P.T.I.', { timeout: 15000 });
  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM', { timeout: 30000 });
  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expect(banner).toContainText('SEATED FROM SLEEPER', { timeout: 15000 });

  // The two records landed: every roster in app ids, mine marked; the week.
  const rosters = JSON.parse(await page.evaluate(() => localStorage.getItem('nfl2026.leaguerosters.v1')));
  expect(rosters.league_id).toBe(LEAGUE_ID);
  expect(rosters.teams.length).toBe(10);
  expect(rosters.my_roster_id).toBe(4);
  expect(rosters.rostered_app_ids.length).toBeGreaterThan(100);
  const week = JSON.parse(await page.evaluate(() => localStorage.getItem('nfl2026.nflweek.v1')));
  expect(week.week).toBe(1);
  expect(week.season_type).toBe('regular');

  // LINEUP: WK 1 by default, labelled as Sleeper's; the selector still offers 18.
  await page.goto('/#/lineup');
  await page.waitForSelector('#ww-card', { timeout: 15000 });
  await expect(page.locator('.lu-wkbar .wk-chip--active')).toHaveText('WK 1');
  expect(await page.locator('.lu-wkbar .wk-chip').count()).toBe(18);
  await expect(page.locator('.lu-wklabel')).toContainText('current week per Sleeper');

  const card = page.locator('#ww-card');
  await expect(card).toContainText('WAIVER WIRE');
  await expect(card).toContainText('P.T.I.');
  await expect(card).toContainText('ESTIMATE');
  await expect(card).not.toContainText('Sync your Sleeper league on TEAM');
  const taken = new Set(rosters.rostered_app_ids);
  const mine = Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('nfl2026.team.v1'))).slots)
    .filter(Boolean).map(String);
  mine.forEach((id) => taken.add(id));

  // BEST FIT (default) and BEST AVAILABLE, both horizons: rows exist and none
  // of them is a rostered player.
  for (const seg of ['fit', 'available']) {
    await card.locator(`[data-wseg="${seg}"]`).click();
    for (const hz of ['week', 'ros']) {
      await card.locator(`[data-whz="${hz}"]`).click();
      await expect(card.locator(`[data-wseg="${seg}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(card.locator(`[data-whz="${hz}"]`)).toHaveAttribute('aria-pressed', 'true');
      const ids = await card.locator('.lu-row[data-wwid]').evaluateAll((els) => els.map((e) => e.dataset.wwid));
      expect(ids.length, `${seg}/${hz} lists at least one unrostered player`).toBeGreaterThanOrEqual(1);
      for (const id of ids) expect(taken.has(id), `${id} is rostered but listed under ${seg}/${hz}`).toBe(false);
      if (seg === 'fit') {
        await expect(card.locator('.ww-fit').first()).toContainText('to your optimal lineup');
        await expect(card.locator('.ww-fit').first()).toContainText('drop');
      } else {
        await expect(card.locator('.ww-pos').first()).toContainText('TOP');
      }
    }
  }
  await expect(card).toContainText('no price, ADP or ownership input');
});

test('a fresh device without a sync is told to sync on TEAM — no fabricated list', async ({ page }) => {
  await page.goto('/#/lineup');
  await page.waitForSelector('#ww-card', { timeout: 15000 });
  await expect(page.locator('#ww-card')).toContainText('Sync your Sleeper league on TEAM to see who is unrostered');
  expect(await page.locator('#ww-card .lu-row').count()).toBe(0);
  expect(await page.locator('.lu-wklabel').count()).toBe(0);
  expect(await page.locator('.lu-wkbar .wk-chip').count()).toBe(18);
});

test('rosters saved for another league say so instead of pretending', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('nfl2026.league_id.v1', id);
    localStorage.setItem('nfl2026.leaguerosters.v1', JSON.stringify({
      version: 1, league_id: '999999999999999999', at: '2026-09-01T00:00:00.000Z',
      teams: [{ roster_id: 1, label: 'X', app_ids: [] }], rostered_app_ids: [], my_roster_id: null,
    }));
  }, LEAGUE_ID);
  await page.goto('/#/lineup');
  await page.waitForSelector('#ww-card', { timeout: 15000 });
  await expect(page.locator('#ww-card')).toContainText('are for league 999999999999999999');
  await expect(page.locator('#ww-card')).not.toContainText('to see who is unrostered');
  expect(await page.locator('#ww-card .lu-row').count()).toBe(0);
});
