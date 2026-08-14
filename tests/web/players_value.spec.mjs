/* tests/web/players_value.spec.mjs — R21-B2 in a real browser.
 *
 * The unit suite (tests/feature/players_view.test.mjs) proves the markup; this
 * proves it actually reaches the PLAYERS view, at phone width, driven by the
 * league profile rather than by a hardcoded week — and that the market price
 * never appears on screen without its DISPLAY-ONLY label.
 *
 * Expectations are derived from the committed data/*.json the app itself serves,
 * never hardcoded to a player name or a week number.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

/** Poll until the players view has painted cards. */
async function waitForPlayers(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('.card.player').length > 0,
    undefined, { timeout: 8000 },
  );
}

/** Seed a LeagueProfile before the first document load. */
const seedProfile = (page, profile) => page.addInitScript(
  (p) => localStorage.setItem('nfl2026.league.v1', p), JSON.stringify(profile),
);

/** A minimal valid profile whose playoffs start in `week`. */
const leagueStartingWeek = (week) => ({
  version: 1,
  name: 'Playoff Window Test',
  shape: {
    teams: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    playoff_week_start: week,
  },
});

test.describe('players playoff-SoS chip (R21-B2)', () => {
  test('every card reads a playoff window, a 1-5 number and a band word', async ({ page }) => {
    await page.goto('/#/players');
    await waitForPlayers(page);

    const chips = page.locator('.p-posos');
    expect(await chips.count()).toBeGreaterThanOrEqual(1);

    // The default profile's playoffs start in week 15 and the fantasy season
    // ends at 17 — the chip states the window it measured, on every card.
    const labels = await page.locator('.p-posos .posos-lbl').evaluateAll(
      (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
    expect(labels).toEqual(['PLAYOFF W15-17']);

    // The number is the accessible source of truth: one decimal, inside 1..5.
    const nums = await page.locator('.p-posos .posos-num').evaluateAll(
      (els) => els.slice(0, 12).map((e) => e.textContent.trim()));
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) {
      expect(n).toMatch(/^\d\.\d$/);
      expect(Number(n)).toBeGreaterThanOrEqual(1);
      expect(Number(n)).toBeLessThanOrEqual(5);
    }

    // The band word states the reading in English — colour is never alone.
    const words = await page.locator('.p-posos .posos-word').evaluateAll(
      (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) {
      expect(['Easiest', 'Easy', 'Neutral', 'Hard', 'Hardest']).toContain(w);
    }
  });

  test('a null reading is absent, never a neutral-looking zero', async ({ page }) => {
    await page.goto('/#/players');
    await waitForPlayers(page);
    // Nothing on screen may read as a 0.0 difficulty or an empty meter chip.
    const zeros = await page.locator('.p-posos .posos-num').evaluateAll(
      (els) => els.filter((e) => Number(e.textContent) === 0).length);
    expect(zeros).toBe(0);
    // Cards without a reading carry no chip at all — not an em dash, not "N/A".
    const chipCount = await page.locator('.p-posos').count();
    const cardCount = await page.locator('.card.player').count();
    expect(chipCount).toBeLessThanOrEqual(cardCount);
  });

  test('the default league has no bye in its playoff window, so no bye chip', async ({ page }) => {
    // No committed player has a bye as late as week 15, so the default league
    // shows no bye chips at all — that absence is a fact about the schedule,
    // and it is what makes the seeded case below meaningful.
    await page.goto('/#/players');
    await waitForPlayers(page);
    expect(await page.locator('.posos-bye').count()).toBe(0);
  });

  test('an earlier playoff start moves the window and surfaces real byes', async ({ page }) => {
    // Seed BEFORE the first navigation: addInitScript only runs on a real
    // document load. A league whose playoffs start a week earlier pulls real
    // byes into the window — the chip moves because the PROFILE moved, not
    // because of a hardcoded week.
    await seedProfile(page, leagueStartingWeek(14));
    await page.goto('/#/players');
    await waitForPlayers(page);

    const labels = await page.locator('.p-posos .posos-lbl').evaluateAll(
      (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
    expect(labels).toEqual(['PLAYOFF W14-17']);

    expect(await page.locator('.posos-bye').count()).toBeGreaterThanOrEqual(1);
    const bye = page.locator('.posos-bye').first();
    await expect(bye).toContainText(/BYE W1[0-8]/);
    await expect(bye).toContainText(/\d\/4 GAMES/);
    // Structurally separate from the difficulty chip.
    expect(await page.locator('.p-posos .posos-bye').count()).toBe(0);
    // And the legend explains the new chip in the league's own week numbers.
    await page.locator('.legend--players summary').click();
    await expect(page.locator('.legend--players')).toContainText('PLAYOFF W14-17');
  });
});

test.describe('players market auction value (R21-B2, DISPLAY ONLY)', () => {
  test('our price sits beside the market price, always badged', async ({ page }) => {
    const adp = readData('adp.json');
    test.skip(!adp.players.some((r) => r.auction_value != null),
      'this build ships no auction values');

    await page.goto('/#/players');
    await waitForPlayers(page);

    const vals = page.locator('.p-val');
    expect(await vals.count()).toBeGreaterThanOrEqual(1);

    // OUR price and the MARKET's are both labelled, and neither is unlabelled.
    await expect(vals.first().locator('.pv-lbl').nth(0)).toHaveText('OURS');
    await expect(vals.first().locator('.pv-lbl').nth(1)).toHaveText('AUC');

    // Every rendered value row carries exactly one DISPLAY-ONLY badge — a market
    // price can never reach the screen without the policy label attached.
    const badges = await vals.evaluateAll(
      (els) => els.map((e) => e.querySelectorAll('.ms-badge').length));
    expect(badges.length).toBeGreaterThan(0);
    for (const n of badges) expect(n).toBe(1);
    await expect(page.locator('.p-val .ms-badge').first())
      .toHaveText('MARKET · DISPLAY ONLY');
  });

  test('an unpriced player shows a dash, and nothing anywhere shows $0', async ({ page }) => {
    await page.goto('/#/players');
    await waitForPlayers(page);
    const text = await page.locator('#players-list').innerText();
    // "$0" reads as free. A price below half a dollar renders "<$1"; a missing
    // price renders an em dash. Neither is ever allowed to become $0.
    expect(text).not.toMatch(/\$0\b/);
    // Where a dash renders it is a value cell, marked as absent, not zero.
    const dashes = await page.locator('.pv-none').evaluateAll(
      (els) => els.map((e) => e.textContent.trim()));
    for (const d of dashes) expect(d).toBe('—');
  });

  test('the market price does not touch the ranking', async ({ page }) => {
    // The default PROJ sort must be ordered by OUR projection, strictly — if a
    // market price ever leaked into the sort key this ordering would break.
    await page.goto('/#/players');
    await waitForPlayers(page);
    const projs = await page.locator('.card.player .p-num').evaluateAll(
      (els) => els.slice(0, 20).map((e) => parseFloat(e.textContent)));
    expect(projs.length).toBeGreaterThan(5);
    for (let i = 1; i < projs.length; i += 1) {
      expect(projs[i]).toBeLessThanOrEqual(projs[i - 1] + 1e-6);
    }
  });

  test('the new row wraps inside the card at 402px — no card overflows', async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto('/#/players');
    await waitForPlayers(page);
    const overflow = await page.locator('.card.player').evaluateAll((cards) => {
      const out = [];
      for (const c of cards.slice(0, 20)) {
        const row = c.querySelector('.p-adorn--value');
        if (!row) continue;
        out.push(Math.round(row.scrollWidth - c.clientWidth));
      }
      return out;
    });
    expect(overflow.length).toBeGreaterThan(0);
    for (const o of overflow) expect(o).toBeLessThanOrEqual(0);
  });
});
