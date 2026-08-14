/* tests/web/compare_playoff.spec.mjs — R21-B3 in a real browser.
 *
 * tests/feature/compare_view.test.mjs proves the markup; this proves it reaches
 * the COMPARE view over the committed data, that the window follows the saved
 * LeagueProfile rather than a constant, and — the part only a browser can show —
 * that the winner glyph points the way the LAYOUT actually stacks: sideways at
 * desktop width, vertically on the 402px phone the app is designed for.
 *
 * Player ids are derived from data/player_projections.json, never hardcoded.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

/** Two ids that both have weekly rows, so both sides get a real reading. */
function twoPlayers() {
  const proj = readData('player_projections.json').players;
  const weekly = readData('player_weekly.json').players;
  const rated = new Set(weekly
    .filter((w) => Array.isArray(w.weeks) && w.weeks.some((x) => x && x.opp && !x.bye))
    .map((w) => String(w.gsis_id)));
  const ids = proj
    .filter((p) => rated.has(String(p.gsis_id)))
    .map((p) => String(p.gsis_id));
  expect(ids.length).toBeGreaterThanOrEqual(2);
  return { a: ids[0], b: ids[1] };
}

/** Seed a LeagueProfile before the first document load. */
const seedProfile = (page, profile) => page.addInitScript(
  (p) => localStorage.setItem('nfl2026.league.v1', p), JSON.stringify(profile),
);

const leagueStartingWeek = (week) => ({
  version: 1,
  name: 'Compare Window Test',
  shape: {
    teams: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    playoff_week_start: week,
  },
});

test.describe('compare: fantasy-playoff SoS row (R21-B3)', () => {
  test('both columns carry a PLAYOFF SoS row and the rail carries its chip', async ({ page }) => {
    const { a, b } = twoPlayers();
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-grid', { timeout: 8000 });

    // One row per column, always — the rail stays aligned even when a side has
    // no reading.
    await expect(page.locator('.cmp-metric--posos')).toHaveCount(2);
    const labels = await page.locator('.cmp-col').first().locator('.cmp-lbl')
      .evaluateAll((els) => els.map((e) => e.textContent.trim()));
    // REL17 ordering is untouched, and PLAYOFF SoS sits beside the season SoS.
    expect(labels[0]).toBe('AVAILABILITY');
    expect(labels.indexOf('PLAYOFF SoS')).toBe(labels.indexOf('SoS') + 1);
    expect(labels.indexOf('PLAYOFF SoS')).toBeLessThan(labels.indexOf('BYE'));

    // Exactly one centre chip per metric row.
    const rail = page.locator('.cmp-mid .cmp-edge');
    expect(await rail.count()).toBe(labels.length);
    await expect(page.locator('.cmp-mid')).toContainText('PLAYOFF');
  });

  test('with NO league saved the window is the profile default, 15-17', async ({ page }) => {
    const { a, b } = twoPlayers();
    await page.addInitScript(() => localStorage.removeItem('nfl2026.league.v1'));
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-metric--posos', { timeout: 8000 });
    const text = await page.locator('.cmp-metric--posos').first().innerText();
    expect(text).toMatch(/W15-17|no playoff-window data/);
  });

  test('a league whose playoffs start in week 14 widens the window on screen', async ({ page }) => {
    const { a, b } = twoPlayers();
    await seedProfile(page, leagueStartingWeek(14));
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-metric--posos', { timeout: 8000 });
    const text = await page.locator('.cmp-metric--posos').first().innerText();
    expect(text).toMatch(/W14-17|no playoff-window data/);
    expect(text).not.toContain('W15-17');
  });

  test('the reading is a 1-5 number with a band word, never a bare 0', async ({ page }) => {
    const { a, b } = twoPlayers();
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-metric--posos', { timeout: 8000 });
    const cells = await page.locator('.cmp-metric--posos .cmp-v')
      .evaluateAll((els) => els.map((e) => e.textContent.trim()));
    for (const cell of cells) {
      if (cell.startsWith('no playoff-window data')) continue;
      const num = /^(\d\.\d)/.exec(cell);
      expect(num, `unreadable playoff cell: ${cell}`).not.toBeNull();
      expect(Number(num[1])).toBeGreaterThanOrEqual(1);
      expect(Number(num[1])).toBeLessThanOrEqual(5);
      expect(cell).toMatch(/Easiest|Easy|Neutral|Hard|Hardest/);
    }
  });

  test('a player with no window reading gets words, and the rail crowns nobody', async ({ page }) => {
    const { a, b } = twoPlayers();
    // Strip every opponent from one player's schedule: app/playoffs.js returns
    // null, and neither the row nor the rail may invent a reading from that.
    await page.route('**/player_weekly.json', async (route) => {
      const res = await route.fetch();
      const doc = await res.json();
      for (const p of doc.players) {
        if (String(p.gsis_id) !== String(b)) continue;
        for (const w of p.weeks || []) { w.opp = null; w.bye = false; }
      }
      await route.fulfill({ response: res, json: doc });
    });
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-metric--posos', { timeout: 8000 });

    const cols = await page.locator('.cmp-metric--posos')
      .evaluateAll((els) => els.map((e) => e.textContent));
    expect(cols.some((t) => t.includes('no playoff-window data'))).toBe(true);

    const chip = page.locator('.cmp-mid .cmp-edge', { hasText: 'PLAYOFF' });
    await expect(chip).toHaveCount(1);
    expect(await chip.getAttribute('class')).toContain('cmp-edge--na');
    expect(await chip.innerHTML()).not.toContain('cmp-win');
    await expect(chip).toContainText(/no window data|one side only/);
  });
});

test.describe('compare: winner glyph matches the layout (R21-B3)', () => {
  test('the phone layout stacks the players, so the arrow points up/down', async ({ page }) => {
    const { a, b } = twoPlayers();
    // The suite's device is the iPhone 16 Pro (402px) — below the 560px stack.
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-grid', { timeout: 8000 });

    // Prove the layout really is stacked before asserting the glyph that suits it.
    const stacked = await page.locator('.cmp-grid').evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length === 1);
    expect(stacked).toBe(true);

    const wins = page.locator('.cmp-win');
    expect(await wins.count()).toBeGreaterThanOrEqual(1);
    // innerText excludes display:none, so this is what a user actually sees.
    const seen = await wins.first().innerText();
    expect(seen).toMatch(/[▲▼]/);
    expect(seen).not.toMatch(/[◀▶]/);
  });

  test('the side-by-side layout keeps the left/right arrow', async ({ page }) => {
    const { a, b } = twoPlayers();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/#/compare?a=${a}&b=${b}`);
    await page.waitForSelector('.cmp-grid', { timeout: 8000 });

    const columns = await page.locator('.cmp-grid').evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(3);

    const seen = await page.locator('.cmp-win').first().innerText();
    expect(seen).toMatch(/[◀▶]/);
    expect(seen).not.toMatch(/[▲▼]/);
  });
});
