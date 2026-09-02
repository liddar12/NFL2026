/* tests/web/r52_grade_race.spec.mjs — R52 (project `web`).
 *
 * The owner's intermittent defect: on GRADE, LOAD LEAGUE sometimes painted the
 * league header and NO cards; a refresh and a second press worked. The R48
 * spec never saw it because its Sleeper mocks answer instantly and the two-
 * pass LOAD (sync -> remount -> autoload) had no window to race in.
 *
 * This spec reuses the R48 routes and P.T.I. fixtures but DELAYS them the way
 * the network does — the 5 MB player dump last (1500 ms), rosters at 800 ms,
 * each matchups week at a random 100–600 ms — on a FRESH profile, so the
 * league sync CHANGES the saved profile on the first press (the exact path
 * that used to remount). It proves:
 *   1. one press, no reload: 10 cards + standings, the LEAGUE chip shows the
 *      league, the button was pressed once;
 *   2. a double-press paints exactly one set of cards and one standings table;
 *   3. navigating away 200 ms after LOAD and back paints nothing into the
 *      other view and GRADE renders cleanly on return.
 * Run with --repeat-each 3: a race that passes once is not proven.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const LEAGUE_ID = '1367481303166914560';
const readFix = (name) => readFileSync(new URL(`../fixtures/sleeper_pti/${name}`, import.meta.url), 'utf8');

const LEAGUE = readFix('league.json');
const ROSTERS = readFix('rosters.json');
const USERS = readFix('users.json');
const PLAYER_INDEX = readFix('player_index_trimmed.json');
const MATCHUPS = {};
for (let w = 1; w <= 14; w++) MATCHUPS[w] = readFix(`matchups_${w}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Mock every Sleeper endpoint the loader touches, with real-world delays.
 *  Returns a counter of dump reads so a test can prove the memo. */
async function mockSlowSleeper(page) {
  const hits = { dump: 0, rosters: 0, league: 0 };
  const json = async (route, body, delay, status = 200) => {
    if (delay) await sleep(delay);
    await route.fulfill({ status, contentType: 'application/json', body });
  };
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}`, (r) => { hits.league += 1; return json(r, LEAGUE, 150); });
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`, (r) => { hits.rosters += 1; return json(r, ROSTERS, 800); });
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/users`, (r) => json(r, USERS, 200));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/*`, (r) => {
    const wk = Number(r.request().url().split('/').pop());
    return json(r, MATCHUPS[wk] || '[]', jitter(100, 600));
  });
  await page.route('**/api.sleeper.app/v1/players/nfl', (r) => { hits.dump += 1; return json(r, PLAYER_INDEX, 1500); });
  await page.route('**/api.sleeper.app/v1/draft/**', (r) => json(r, 'null', 100, 404));
  await page.route('**/data/sleeper_projections.json', (r) => json(r, 'null', 0, 404));
  return hits;
}

test.describe('R52 — GRADE LOAD is one pass and survives the network race', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nfl2026.unlock.v1', '1');
        // A FRESH profile: the first LOAD's sync CHANGES the saved league —
        // the exact path that used to remount mid-load.
        localStorage.removeItem('nfl2026.league.v1');
        localStorage.removeItem('nfl2026.league_id.v1');
        localStorage.removeItem('nfl2026.scoring.v1');
      } catch (_) { /* ignore */ }
    });
  });

  test('one press on a fresh profile: 10 cards + standings, the LEAGUE chip, no reload, no second press',
    async ({ page }) => {
      const hits = await mockSlowSleeper(page);
      await page.goto('/#/grade');
      await page.waitForSelector('#gr-league-id', { timeout: 15000 });
      // A marker that a reload would erase.
      await page.evaluate(() => { window.__r52_no_reload = true; });
      await page.locator('#gr-league-id').fill(LEAGUE_ID);
      await page.locator('#gr-load').click();

      // The button rests while the load runs and nothing else is pressed.
      await expect(page.locator('#gr-load')).toBeDisabled();
      // The dump progress line is the loading state, not user-facing debug.
      await expect(page.locator('#gr-league-out')).toContainText("Reading Sleeper's player list", { timeout: 10000 });

      await expect(page.locator('.gr-card--team')).toHaveCount(10, { timeout: 30000 });
      await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 30000 });
      await expect(page.locator('#gr-league-out')).toContainText('PROJECTED FINAL STANDINGS');
      await expect(page.locator('#gr-load')).toBeEnabled();

      // No reload happened, the chip shows the synced league, and the form is
      // still the one we typed into (no remount): the id is still in the box.
      expect(await page.evaluate(() => window.__r52_no_reload === true)).toBe(true);
      await expect(page.locator('#league-chip')).toContainText('LEAGUE: P.T.I.');
      await expect(page.locator('#league-chip')).toContainText('SLEEPER');
      await expect(page.locator('#gr-league-id')).toHaveValue(LEAGUE_ID);
      // The league payload was read for the sim and once more by the settings
      // sync (importFromSleeper) — never a third time; rosters and the dump once.
      expect(hits.dump).toBe(1);
      expect(hits.rosters).toBe(1);
      expect(hits.league).toBeLessThanOrEqual(2);

      // The card says what its number is; the season starters are folded.
      const first = page.locator('.gr-card--team').first();
      await expect(first).toContainText('WEEKLY-OPTIMAL TOTAL');
      await expect(first.locator('details.gr-weeks summary')).toContainText('starters, bench and SUBs');
      await expect(first.locator('details.gr-season summary')).toContainText('not the standings number');
      await first.locator('details.gr-weeks summary').click();
      const wk1 = first.locator('.gr-week').first();
      await expect(wk1).toContainText('STARTERS');
      await expect(wk1).toContainText('BENCH');
      expect(await wk1.locator('.gr-slot--bench').count()).toBeGreaterThan(0);
      // No error state anywhere and no NaN/undefined in the panel.
      await expect(page.locator('#gr-league-out .state')).toHaveCount(0);
      expect(await page.locator('#gr-league-out').innerText()).not.toMatch(/NaN|undefined/);
    });

  test('a double-press paints exactly one set of cards and one standings table', async ({ page }) => {
    const hits = await mockSlowSleeper(page);
    await page.goto('/#/grade');
    await page.waitForSelector('#gr-league-id', { timeout: 15000 });
    await page.locator('#gr-league-id').fill(LEAGUE_ID);
    await page.locator('#gr-load').dblclick();

    await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 30000 });
    await expect(page.locator('.gr-card--team')).toHaveCount(10);
    await expect(page.locator('.gr-card--standings')).toHaveCount(1);
    await expect(page.locator('.gr-standings')).toHaveCount(1);
    expect(await page.locator('#gr-league-out > .gr-note').count()).toBe(1);
    // The standings card stays the LAST thing in the panel.
    const lastClass = await page.locator('#gr-league-out > *').last().getAttribute('class');
    expect(lastClass).toContain('gr-card--standings');
    expect(hits.dump).toBe(1);
    // Wait past any straggler and re-assert: still one of everything.
    await page.waitForTimeout(1500);
    await expect(page.locator('.gr-card--team')).toHaveCount(10);
    await expect(page.locator('.gr-standings')).toHaveCount(1);
    await expect(page.locator('#gr-load')).toBeEnabled();
  });

  test('navigating away 200 ms after LOAD paints nothing into PLAYERS; GRADE renders cleanly on return',
    async ({ page }) => {
      await mockSlowSleeper(page);
      await page.goto('/#/grade');
      await page.waitForSelector('#gr-league-id', { timeout: 15000 });
      await page.locator('#gr-league-id').fill(LEAGUE_ID);
      await page.locator('#gr-load').click();
      await page.waitForTimeout(200);
      await page.goto('/#/players');
      await page.waitForSelector('.card.player', { timeout: 15000 });

      // Give the abandoned load more than enough time to finish its fetches
      // (dump 1500 ms + matchups) and try to paint.
      await page.waitForTimeout(4000);
      await expect(page.locator('#view .gr-card--team')).toHaveCount(0);
      await expect(page.locator('#view .gr-standings')).toHaveCount(0);
      await expect(page.locator('#view #gr-league-out')).toHaveCount(0);
      expect(await page.locator('.card.player').count()).toBeGreaterThan(0);

      // Back to GRADE: a clean mount — the form, the remembered id, no cards
      // painted by the abandoned load, no error state.
      await page.goto('/#/grade');
      await page.waitForSelector('#gr-league-id', { timeout: 15000 });
      await expect(page.locator('#gr-league-id')).toHaveValue(LEAGUE_ID);
      await expect(page.locator('#gr-load')).toBeEnabled();
      await page.waitForTimeout(1000);
      await expect(page.locator('#gr-league-out .gr-card--team')).toHaveCount(0);
      await expect(page.locator('#view .state:not(.state--loading)')).toHaveCount(0);
      // ...and a fresh press works first time.
      await page.locator('#gr-load').click();
      await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 30000 });
      await expect(page.locator('.gr-card--team')).toHaveCount(10);
    });
});
