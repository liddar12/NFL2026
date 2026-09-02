/* tests/web/r52_team_race.spec.mjs — R52: SYNC NOW is ONE pass in ONE mount.
 *
 * Owner's RCA (desktop Safari, intermittent): SYNC NOW sometimes seated the
 * roster and sometimes left the tab showing the league header only; a
 * refresh and a second press worked. The press used to save the profile, set
 * a module flag and mount the view again directly, so two async mounts of
 * #view could be alive at once — whichever reached the flag first took the
 * roster step, and its result painted into DOM the other mount had replaced.
 *
 * This spec re-creates the timing the race needed: Sleeper's responses are
 * DELAYED (players/nfl 1500 ms, rosters 800 ms, users 400 ms) so every await
 * boundary on the sync path is crossed while other things can happen.
 *   1. one press on FRESH keys -> the picker -> pick -> roster seated, with no
 *      reload and no second press (r48's assertions, under the delays);
 *   2. two quick presses -> one picker, one seated roster, one banner;
 *   3. navigate to #/players 200 ms after the press and come back -> nothing
 *      painted into the PLAYERS view, and TEAM renders cleanly.
 * Run with --repeat-each 3: a race passes sometimes; a fix passes every time.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIX = new URL('../fixtures/sleeper_pti/', import.meta.url);
const file = (n) => readFileSync(new URL(n, FIX), 'utf8');
const LEAGUE_ID = '1367481303166914560';
const DELAY = { players: 1500, rosters: 800, users: 400 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** r48's Sleeper mock, with the R52 delays on the three roster-path documents. */
async function mockSleeper(page) {
  await page.route(/api\.sleeper\.app/, async (route) => {
    const u = route.request().url();
    let body = '[]';
    let wait = 0;
    if (/\/league\/\d+$/.test(u)) body = file('league.json');
    else if (/\/rosters$/.test(u)) { body = file('rosters.json'); wait = DELAY.rosters; }
    else if (/\/users$/.test(u)) { body = file('users.json'); wait = DELAY.users; }
    else if (/\/players\/nfl$/.test(u)) { body = file('player_index_trimmed.json'); wait = DELAY.players; }
    else if (/\/matchups\/(\d+)$/.test(u)) {
      const w = Number(u.match(/\/matchups\/(\d+)$/)[1]);
      body = w <= 14 ? file(`matchups_${w}.json`) : '[]';
    }
    if (wait) await sleep(wait);
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

const FRESH_KEYS = ['nfl2026.league.v1', 'nfl2026.team.v1', 'nfl2026.league_id.v1',
  'nfl2026.myroster.v1', 'nfl2026.scoring.v1', 'nfl2026.leaguerosters.v1', 'nfl2026.synclog.v1'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((keys) => {
    for (const k of keys) localStorage.removeItem(k);
  }, FRESH_KEYS);
  await mockSleeper(page);
});

async function openTeam(page) {
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  // A reload would wipe this; the seated roster must arrive with it intact.
  await page.evaluate(() => { window.__r52NoReload = true; });
}

/** r48's seated-roster assertions, verbatim in substance. */
async function expectSeated(page, banner) {
  await expect(banner).toContainText('SEATED FROM SLEEPER', { timeout: 15000 });
  await expect(banner).toContainText('12 of 14');
  await expect(page.locator('#t-draft')).toContainText('roster seated from Sleeper', { timeout: 15000 });
  expect(await page.locator('.roster .slot-player').count()).toBeGreaterThanOrEqual(12);
  expect(await page.locator('.roster .slot').count()).toBe(14);
  await expect(page.locator('#t-draft')).toContainText('could not be matched');
  const remembered = await page.evaluate(() => localStorage.getItem('nfl2026.myroster.v1'));
  expect(JSON.parse(remembered)).toEqual({ [LEAGUE_ID]: 4 });
  expect(await page.evaluate(() => window.__r52NoReload === true)).toBe(true);
}

test('one press under delays: settings, picker, pick, seated — no reload, no second press', async ({ page }) => {
  await openTeam(page);
  await page.locator('[data-act="sleeper-sync"]').click();

  // Settings landed IN PLACE: the chip re-prices, the id stays in its field,
  // and the status line is the sync's own (no remount, no flash hand-off).
  await expect(page.locator('#league-chip')).toContainText('P.T.I.', { timeout: 15000 });
  await expect(page.locator('#t-draft input[data-lin="sleeperId"]')).toHaveValue(LEAGUE_ID);
  await expect(page.locator('#t-draft')).toContainText('Synced and SAVED P.T.I.');
  await expect(page.locator('#t-draft')).toContainText('Reading the rosters next');
  // The player list is read through the loader with a progress line in the
  // banner while its (delayed) body streams.
  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner.locator('.sync-bar-prog')).toContainText('Reading Sleeper\'s player list', { timeout: 15000 });
  // Then the picker, in the same banner, from the same mount.
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM', { timeout: 30000 });
  expect(await page.locator('#t-syncbar select[data-rcfg="team"] option').count()).toBe(11);
  await expect(page.locator('#t-draft')).toContainText('PICK YOUR TEAM');
  await expect(page.locator('#t-draft')).toContainText('Sleeper\'s player list:');
  expect(await page.locator('.roster .slot-player').count()).toBe(0);

  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expectSeated(page, banner);
  expect(await page.locator('#t-syncbar').count()).toBe(1);
  expect(await page.locator('#t-syncbar .sync-bar').count()).toBe(1);
});

test('two quick presses: one picker, one seated roster, one banner', async ({ page }) => {
  await openTeam(page);
  const btn = page.locator('[data-act="sleeper-sync"]');
  await btn.click();
  // The second press lands while the first is in flight (the button is
  // disabled by then, so dispatch the click the way a double-tap would).
  await btn.dispatchEvent('click');
  await btn.dispatchEvent('click');

  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM', { timeout: 30000 });
  expect(await page.locator('#t-syncbar').count()).toBe(1);
  expect(await page.locator('#t-syncbar .sync-bar').count()).toBe(1);
  expect(await page.locator('#t-syncbar select[data-rcfg="team"]').count()).toBe(1);
  expect(await page.locator('#t-draft').count()).toBe(1);

  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expectSeated(page, banner);
  // Give any second pass every chance to show itself before counting.
  await sleep(DELAY.players + 500);
  expect(await page.locator('#t-syncbar .sync-bar').count()).toBe(1);
  expect(await page.locator('#t-syncbar .sync-bar:has-text("SEATED FROM SLEEPER")').count()).toBe(1);
  expect(await page.locator('#t-draft .lp-status:has-text("roster seated from Sleeper")').count()).toBe(1);
  expect(await page.locator('#t-draft .lp-status:has-text("Synced and SAVED")').count()).toBe(1);
  expect(await page.locator('.roster').count()).toBe(1);
});

test('navigate away 200 ms after the press and back: nothing lands in PLAYERS, TEAM renders cleanly', async ({ page }) => {
  const debug = [];
  page.on('console', (m) => { if (m.type() === 'debug') debug.push(m.text()); });
  await openTeam(page);
  await page.locator('[data-act="sleeper-sync"]').click();
  await sleep(200);

  await page.goto('/#/players');
  await page.waitForSelector('.card.player', { timeout: 15000 });
  // Outlast every delayed document the abandoned press was still waiting on.
  await sleep(DELAY.rosters + DELAY.players + 700);
  // PLAYERS is still PLAYERS: no TEAM markup was painted into #view.
  expect(await page.locator('#view #t-syncbar').count()).toBe(0);
  expect(await page.locator('#view .sync-bar').count()).toBe(0);
  expect(await page.locator('#view .roster').count()).toBe(0);
  expect(await page.locator('#view #t-draft').count()).toBe(0);
  expect(await page.locator('#view .view-title').first().innerText()).not.toContain('TEAM BUILDER');
  expect(await page.locator('.card.player').count()).toBeGreaterThan(0);
  expect(debug.some((t) => /team: mount #\d+ superseded at/.test(t))).toBe(true);

  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  // One shell, one banner slot (empty: this mount received no press), the
  // settings the press saved before the user left, nothing half-painted.
  expect(await page.locator('#view .view-title').count()).toBe(1);
  expect(await page.locator('#t-syncbar').count()).toBe(1);
  expect(await page.locator('#t-syncbar .sync-bar').count()).toBe(0);
  expect(await page.locator('.roster').count()).toBe(1);
  expect(await page.locator('.roster .slot-player').count()).toBe(0);
  await expect(page.locator('#league-chip')).toContainText('P.T.I.');
  await expect(page.locator('#t-draft input[data-lin="sleeperId"]')).toHaveValue(LEAGUE_ID);
  await expect(page.locator('#t-draft')).toContainText('SAVED · P.T.I.');
  // And the SAME mount can run the whole press now, cleanly.
  await page.evaluate(() => { window.__r52NoReload = true; });
  await page.locator('[data-act="sleeper-sync"]').click();
  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM', { timeout: 30000 });
  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expectSeated(page, banner);
});
