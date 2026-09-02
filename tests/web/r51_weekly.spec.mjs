/* tests/web/r51_weekly.spec.mjs — R51 (project `web`).
 *
 * weekly_split_v2 changes the NUMBERS in data/player_weekly.json, not its
 * shape. The two surfaces that read a player's WEEK (not his season) are the
 * Lineup optimizer (#/lineup) and the Grade tab's weekly-optimal engine
 * (#/grade). This spec proves both still render their weekly numbers from the
 * committed data: every points cell is a finite number (or the honest em dash
 * for an unvaluable row), never blank, never "NaN", and the totals are sums of
 * those cells. It is deliberately agnostic to the model version so it stays
 * green across the v1 -> v2 regeneration.
 *
 * #/grade is driven through the Sleeper loader with Sleeper MOCKED at the
 * network layer (the R48 P.T.I. fixtures) — nothing leaves the box.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));
const readFix = (name) =>
  readFileSync(new URL(`../fixtures/sleeper_pti/${name}`, import.meta.url), 'utf8');

const NUMBER_OR_DASH = /^(\d+\.\d\*?|—)$/;

/** First `n` committed projection ids for a position (the shipped pool). */
function idsFor(pos, n) {
  return readData('player_projections.json').players
    .filter((p) => String(p.position).toUpperCase() === pos)
    .slice(0, n)
    .map((p) => p.gsis_id);
}

test.describe('R51 — weekly numbers still render from the committed weekly split', () => {
  test('#/lineup: every starter and bench cell is a number (or an honest dash), totals are finite',
    async ({ page }) => {
      const [qb] = idsFor('QB', 1);
      const [rb1, rb2, rb3] = idsFor('RB', 3);
      const [wr1, wr2] = idsFor('WR', 2);
      const [te] = idsFor('TE', 1);
      const slots = { QB1: qb, RB1: rb1, RB2: rb2, WR1: wr1, WR2: wr2, TE1: te, FLEX: rb3 };
      await page.addInitScript((s) => {
        localStorage.setItem('nfl2026.unlock.v1', '1');
        localStorage.removeItem('nfl2026.league.v1');       // the default 7-starter league
        localStorage.setItem('nfl2026.team.v1', JSON.stringify({ slots: s }));
      }, slots);

      await page.goto('/#/lineup');
      await page.waitForSelector('.lu-card', { timeout: 15000 });

      const total = page.locator('.lu-total').first();
      await expect(total).toHaveText(/^\d+\.\d pts/);

      const cells = await page.locator('.lu-card .lu-row .lu-pts').allInnerTexts();
      expect(cells.length).toBeGreaterThanOrEqual(7);
      const numeric = cells.map((t) => t.trim().split('\n')[0]);
      for (const c of numeric) expect(c).toMatch(NUMBER_OR_DASH);
      expect(numeric.filter((c) => c !== '—').length).toBeGreaterThanOrEqual(7);
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/NaN|undefined/);
    });

  test('#/grade: the weekly-optimal lineups render numeric week cells and a finite season total',
    async ({ page }) => {
      const LEAGUE_ID = '1367481303166914560';
      const json = (route, body, status = 200) => route.fulfill({
        status, contentType: 'application/json', body,
      });
      await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}`, (r) => json(r, readFix('league.json')));
      await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`, (r) => json(r, readFix('rosters.json')));
      await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/users`, (r) => json(r, readFix('users.json')));
      await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/*`, (r) => {
        const wk = Number(r.request().url().split('/').pop());
        json(r, (wk >= 1 && wk <= 14) ? readFix(`matchups_${wk}.json`) : '[]');
      });
      await page.route('**/api.sleeper.app/v1/players/nfl', (r) => json(r, readFix('player_index_trimmed.json')));
      await page.route('**/api.sleeper.app/v1/draft/**', (r) => json(r, 'null', 404));
      await page.route('**/data/sleeper_projections.json', (r) => json(r, 'null', 404));
      await page.addInitScript(() => {
        localStorage.setItem('nfl2026.unlock.v1', '1');
        localStorage.removeItem('nfl2026.league.v1');
        localStorage.removeItem('nfl2026.league_id.v1');
        localStorage.removeItem('nfl2026.scoring.v1');
      });

      await page.goto('/#/grade');
      await page.waitForSelector('#gr-league-id', { timeout: 15000 });
      await page.locator('#gr-league-id').fill(LEAGUE_ID);
      await page.locator('#gr-load').click();
      await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 60000 });

      const first = page.locator('.gr-card--team').first();
      await expect(first.locator('.gr-total')).toHaveText(/^\d+\.\d projected season pts/);
      await first.locator('details.gr-weeks summary').click();
      await expect(first.locator('.gr-week').first()).toBeVisible();

      const cells = await first.locator('.gr-week .gr-pts').allInnerTexts();
      expect(cells.length).toBeGreaterThanOrEqual(9);
      for (const c of cells) expect(c.trim()).toMatch(NUMBER_OR_DASH);
      expect(cells.filter((c) => c.trim() !== '—').length).toBeGreaterThanOrEqual(5);
      const body = await page.locator('#gr-league-out').innerText();
      expect(body).not.toMatch(/NaN|undefined/);
    });
});
