/* tests/web/r49_sleeper_display.spec.mjs — R49 (project `web`).
 *
 * Sleeper's estimate beside OURS, end to end, with Sleeper's league endpoints
 * MOCKED at the network layer (the real P.T.I. payloads under
 * tests/fixtures/sleeper_pti) and /data/sleeper_projections.json routed to
 * the committed contract fixture (tests/fixtures/sleeper_proj). Nothing
 * leaves the box. Proves:
 *   - GRADE: the SLEEPER PF column appears with numbers, every team card
 *     carries "SLEEPER <n> · n/N projected", the weekly headers carry the
 *     week's Sleeper sum, and the method note says comparison-only;
 *   - PLAYERS: the first card shows the SLEEPER row (lazily, after paint);
 *   - 404 (the runner has not produced the file): NOTHING Sleeper-related
 *     renders and no error state appears — a normal state, not a failure.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const LEAGUE_ID = '1367481303166914560';
const readFix = (dir, name) => readFileSync(new URL(`../fixtures/${dir}/${name}`, import.meta.url), 'utf8');

const LEAGUE = readFix('sleeper_pti', 'league.json');
const ROSTERS = readFix('sleeper_pti', 'rosters.json');
const USERS = readFix('sleeper_pti', 'users.json');
const PLAYER_INDEX = readFix('sleeper_pti', 'player_index_trimmed.json');
const MATCHUPS = {};
for (let w = 1; w <= 14; w++) MATCHUPS[w] = readFix('sleeper_pti', `matchups_${w}.json`);
const SLEEPER_PROJ = readFix('sleeper_proj', 'sleeper_projections.json');

const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body,
});

/** Mock every Sleeper endpoint the GRADE loader touches. */
async function mockSleeperLeague(page) {
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}`, (r) => json(r, LEAGUE));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`, (r) => json(r, ROSTERS));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/users`, (r) => json(r, USERS));
  await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/*`, (r) => {
    const wk = Number(r.request().url().split('/').pop());
    json(r, MATCHUPS[wk] || '[]');
  });
  await page.route('**/api.sleeper.app/v1/players/nfl', (r) => json(r, PLAYER_INDEX));
  await page.route('**/api.sleeper.app/v1/draft/**', (r) => json(r, 'null', 404));
}

/** The projection contract: the fixture, or a 404 (the runner has not produced it). */
async function mockProjections(page, present) {
  await page.route('**/data/sleeper_projections.json', (r) => (present
    ? json(r, SLEEPER_PROJ)
    : json(r, 'Not Found', 404)));
}

async function loadLeague(page) {
  await page.goto('/#/grade');
  await page.waitForSelector('#gr-league-id', { timeout: 15000 });
  await page.locator('#gr-league-id').fill(LEAGUE_ID);
  await page.locator('#gr-load').click();
  await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 60000 });
}

test.describe('R49 — Sleeper\'s estimate beside OURS (display-only)', () => {
  test.beforeEach(async ({ page }) => {
    await mockSleeperLeague(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nfl2026.unlock.v1', '1');
        localStorage.removeItem('nfl2026.league.v1');
        localStorage.removeItem('nfl2026.league_id.v1');
        localStorage.removeItem('nfl2026.scoring.v1');
      } catch (_) { /* ignore */ }
    });
  });

  test('GRADE: SLEEPER PF column, per-card season cell with coverage, weekly header sums, the note; then PLAYERS shows the SLEEPER row',
    async ({ page }) => {
      await mockProjections(page, true);
      await loadLeague(page);

      // The standings gain the SLEEPER PF column (appended after TITLE) with numbers.
      const th = page.locator('.gr-standings thead th.gr-est-th');
      await expect(th).toHaveCount(1, { timeout: 15000 });
      await expect(th).toHaveText('SLEEPER PF');
      const head = await page.locator('.gr-standings thead th').allInnerTexts();
      expect(head.map((h) => h.trim())).toEqual(['#', 'TEAM', 'W-L', 'PF', 'PA', 'PLAYOFF', 'REG #1', 'TITLE', 'SLEEPER PF']);
      const pfCells = page.locator('.gr-standings tbody td.gr-est-pf');
      await expect(pfCells).toHaveCount(10);
      const texts = await pfCells.allInnerTexts();
      for (const t of texts) expect(t.trim()).toMatch(/^\d+\.\d( \(\d+\/\d+\))?$/);
      // parseFloat: a cell may carry the "(n/N)" coverage suffix, which Number() rejects.
      expect(texts.some((t) => parseFloat(t) > 0)).toBe(true);

      // Every team card: "SLEEPER <n> <delta> · n/N projected" beside OURS.
      const cards = page.locator('.gr-card--team');
      await expect(cards).toHaveCount(10);
      const seasonCells = page.locator('.gr-card--team .gr-est-sl');
      await expect(seasonCells.first()).toBeVisible();
      for (let i = 0; i < 10; i++) {
        const txt = (await seasonCells.nth(i).innerText()).trim();
        expect(txt).toMatch(/SLEEPER (\d+\.\d|—)/);
        expect(txt).toMatch(/\d+\/\d+ projected/);
      }
      const first = cards.first();
      await expect(first.locator('.gr-est')).toContainText('OURS');
      await expect(first.locator('.gr-est')).toContainText('SLEEPER');

      // The weekly lineups disclosure: each week's header carries the Sleeper sum.
      await first.locator('details.gr-weeks summary').click();
      const wk1 = first.locator('.gr-week').first();
      await expect(wk1).toContainText('WK 1');
      await expect(wk1.locator('.gr-est-wk')).toBeVisible();
      await expect(wk1.locator('.gr-est-wk')).toHaveText(/SLEEPER (\d+\.\d|—) · \d+\/\d+/);

      // The method note says what the numbers are and are not.
      const notes = page.locator('#gr-league-out .gr-assumptions');
      await expect(notes).toContainText("Sleeper's numbers are Sleeper's own projections priced under this league's scoring");
      await expect(notes).toContainText('shown for comparison, never an input');
      // No error state anywhere on the page.
      await expect(page.locator('#gr-league-out .state')).toHaveCount(0);

      // PLAYERS: the first card grows the SLEEPER row after the (lazy) fetch lands.
      await page.goto('/#/players');
      await page.waitForSelector('.card.player', { timeout: 15000 });
      const card = page.locator('.card.player').first();
      await expect(card.locator('.p-est').first()).toBeVisible({ timeout: 15000 });
      await expect(card.locator('.p-est').first()).toContainText('OURS');
      await expect(card.locator('.p-est').first()).toContainText('SLEEPER');
      const line = (await card.locator('.p-est').first().innerText()).replace(/\s+/g, ' ');
      expect(line).toMatch(/OURS \d+\.\d/);
      expect(line).toMatch(/SLEEPER (\d+\.\d|—)/);
      // The week line names the week and both engines.
      await expect(card.locator('.p-est--wk')).toHaveText(/WK \d+ · OURS (\d+\.\d|—)( · SCENARIO (\d+\.\d|—))? · SLEEPER (\d+\.\d|—)/);
    });

  test('404 (no projection file yet): nothing Sleeper-related renders and no error state appears', async ({ page }) => {
    await mockProjections(page, false);
    await loadLeague(page);

    const head = await page.locator('.gr-standings thead th').allInnerTexts();
    expect(head.map((h) => h.trim())).toEqual(['#', 'TEAM', 'W-L', 'PF', 'PA', 'PLAYOFF', 'REG #1', 'TITLE']);
    await expect(page.locator('.gr-est-th')).toHaveCount(0);
    await expect(page.locator('.gr-est-pf')).toHaveCount(0);
    // The card's OURS line is there; its Sleeper cell stays hidden and empty.
    const first = page.locator('.gr-card--team').first();
    await expect(first.locator('.gr-est')).toContainText('OURS');
    await expect(first.locator('.gr-est')).not.toContainText('SLEEPER');
    await expect(first.locator('.gr-est-sl')).toBeHidden();
    await expect(first.locator('.gr-est-sl')).toHaveText('');
    await first.locator('details.gr-weeks summary').click();
    await expect(first.locator('.gr-week').first().locator('.gr-est-wk')).toBeHidden();
    await expect(page.locator('#gr-league-out .state')).toHaveCount(0);
    await expect(page.locator('#gr-league-out')).toContainText('PROJECTED FINAL STANDINGS');

    // PLAYERS: the cards render fully; no SLEEPER cell, no error state.
    await page.goto('/#/players');
    await page.waitForSelector('.card.player', { timeout: 15000 });
    await page.waitForTimeout(2500); // past the idle fetch window
    expect(await page.locator('.card.player').count()).toBeGreaterThan(0);
    await expect(page.locator('.card.player .pe-sl')).toHaveCount(0);
    await expect(page.locator('#view .state:not(.state--loading)')).toHaveCount(0);
    await expect(page.locator('.card.player').first()).toContainText('PROJ PTS');
  });
});
