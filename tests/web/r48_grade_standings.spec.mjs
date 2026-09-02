/* tests/web/r48_grade_standings.spec.mjs — R48-C (project `web`).
 *
 * The GRADE tab's Sleeper loader, end to end on the REAL P.T.I. payloads
 * (tests/fixtures/sleeper_pti), with Sleeper MOCKED at the network layer
 * (page.route) so nothing leaves the box. Proves the whole flow — league
 * sync, rosters, the 14-week schedule, the player dump crosswalk — lands on:
 *   - one card per team (10), each with a weekly-lineups disclosure;
 *   - the PROJECTED FINAL STANDINGS table with 10 rows;
 *   - the two "most likely" lines (regular season, champion);
 *   - the honest engine label and the no-K note (P.T.I. fields no K slot).
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

/** Mock every Sleeper endpoint the loader touches. Nothing leaves the box. */
async function mockSleeper(page) {
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: 'application/json', body,
  });
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}`, (r) => json(r, LEAGUE));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`, (r) => json(r, ROSTERS));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/users`, (r) => json(r, USERS));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/*`, (r) => {
    const wk = Number(r.request().url().split('/').pop());
    json(r, MATCHUPS[wk] || '[]');
  });
  await page.route('**/api.sleeper.app/v1/players/nfl', (r) => json(r, PLAYER_INDEX));
  // The draft record is best-effort in importFromSleeper; the fixture has none.
  await page.route('**/api.sleeper.app/v1/draft/**', (r) => json(r, 'null', 404));
  // R49 — pin the pre-Sleeper-estimate state (no projection file), so the
  // exact column list below stays the R48 table whatever data/ carries.
  await page.route('**/data/sleeper_projections.json', (r) => json(r, 'null', 404));
}

test.describe('R48-C — GRADE: weekly-optimal lineups and projected final standings', () => {
  test.beforeEach(async ({ page }) => {
    await mockSleeper(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nfl2026.unlock.v1', '1');
        // A clean league state so the loader's own sync path runs.
        localStorage.removeItem('nfl2026.league.v1');
        localStorage.removeItem('nfl2026.league_id.v1');
        localStorage.removeItem('nfl2026.scoring.v1');
      } catch (_) { /* ignore */ }
    });
  });

  test('LOAD LEAGUE renders 10 team cards, the standings table and the two most-likely lines',
    async ({ page }) => {
      await page.goto('/#/grade');
      await page.waitForSelector('#gr-league-id', { timeout: 15000 });
      await page.locator('#gr-league-id').fill(LEAGUE_ID);
      await page.locator('#gr-load').click();

      // The league sync may remount the view once (settings saved) and then
      // continue the load on its own; the standings are the last thing painted.
      const rows = page.locator('.gr-standings tbody tr');
      await expect(rows).toHaveCount(10, { timeout: 60000 });

      await expect(page.locator('.gr-card--team')).toHaveCount(10);
      await expect(page.locator('#gr-league-out')).toContainText('PROJECTED FINAL STANDINGS');

      const likely = page.locator('.gr-likely');
      await expect(likely).toHaveCount(2);
      await expect(likely.nth(0)).toHaveText(/Most likely regular-season winner: .+ \(\d+%\)/);
      await expect(likely.nth(1)).toHaveText(/Most likely champion: .+ \(\d+%\)/);

      // Every card carries the weekly-lineups disclosure and the new headline number.
      const first = page.locator('.gr-card--team').first();
      await expect(first.locator('details.gr-weeks summary')).toBeVisible();
      await expect(first).toContainText('projected season pts from weekly optimal lineups');
      // R48b (owner RCA "cards without player names"): the starters are ON the card.
      await expect(first).toContainText('SEASON-OPTIMAL STARTERS');
      expect(await first.locator('.gr-slot').count()).toBeGreaterThanOrEqual(9);
      // ...and the standings card is the LAST child of the output.
      const lastClass = await page.locator('#gr-league-out > *').last().getAttribute('class');
      expect(lastClass).toContain('gr-card--standings');
      await first.locator('details.gr-weeks summary').click();
      await expect(first.locator('.gr-week').first()).toBeVisible();
      await expect(first.locator('.gr-week').first()).toContainText('WK 1');

      // Standings columns: rank, team, W-L, PF, PA, playoff %, reg #1 %, title %.
      const head = await page.locator('.gr-standings thead th').allInnerTexts();
      expect(head.map((h) => h.trim())).toEqual(['#', 'TEAM', 'W-L', 'PF', 'PA', 'PLAYOFF', 'REG #1', 'TITLE']);
      const cells = await rows.first().locator('td').allInnerTexts();
      expect(cells[0].trim()).toBe('1');
      expect(cells[2]).toMatch(/^\d+(\.\d)?-\d+(\.\d)?$/);
      expect(cells[5]).toMatch(/^\d+%$/);

      // Honesty labels: the engine note, and P.T.I. fields no K slot.
      const notes = page.locator('#gr-league-out .gr-assumptions');
      await expect(notes).toContainText('self-learning signals are at weight 0');
      await expect(notes).toContainText('This league fields no K slot, so no kicker is graded.');
      await expect(notes).toContainText('ESTIMATE');
    });

  test('the standings table adds no horizontal overflow at 402pt', async ({ page }) => {
    await page.goto('/#/grade');
    await page.waitForSelector('#gr-league-id', { timeout: 15000 });
    await page.locator('#gr-league-id').fill(LEAGUE_ID);
    await page.locator('#gr-load').click();
    await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 60000 });
    const over = await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });
});
