/* tests/web/r51_ai_plus.spec.mjs — R51 PLAYERS AI+ = THIS WEEK, in a real browser.
 *
 * The unit suite (tests/feature/r51_ai_plus.test.mjs) proves the arithmetic
 * and the markup; this proves the toggle actually does it on #/players with
 * the committed data at phone width: AI+ ON swaps the headline for "WK n ·
 * MATCHUP" this-week points (a different number from the season PROJ), shows
 * RoS and BASE, and BASE restores the season numbers exactly.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const weeklyDoc = JSON.parse(
  readFileSync(new URL('../../data/player_weekly.json', import.meta.url), 'utf8'),
);

async function waitForPlayers(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('.card.player').length > 0,
    undefined, { timeout: 8000 },
  );
}

/** [{ id, num, unit }] for the first `n` cards. */
const heads = (page, n) => page.locator('.card.player').evaluateAll((cards, k) => cards.slice(0, k).map((c) => ({
  id: c.getAttribute('data-gsis'),
  num: c.querySelector('.p-num').textContent.trim(),
  unit: c.querySelector('.p-unit').textContent.trim(),
})), n);

test.describe('PLAYERS AI+ = this week (R51)', () => {
  test('AI+ shows WK n this-week points + RoS + BASE; BASE restores the season numbers', async ({ page }) => {
    await page.goto('/#/players');
    await waitForPlayers(page);

    const base = await heads(page, 8);
    expect(base.length).toBe(8);
    for (const h of base) expect(h.unit).toBe('PROJ PTS');
    expect(await page.locator('.p-ros').count()).toBe(0);
    expect(await page.locator('.ai-note').count()).toBe(0);
    await expect(page.locator('.sort-chip[data-sort="proj"]')).toHaveText(/^PROJ/);

    await page.locator('.aiseg button[data-ai="on"]').click();
    await expect(page.locator('.aiseg button[data-ai="on"]')).toHaveAttribute('aria-pressed', 'true');

    const ai = await heads(page, 8);
    // Every visible headline is a week label; the first card is a real matchup number.
    for (const h of ai) expect(h.unit).toMatch(/^WK \d+ · (MATCHUP|BYE|NO WEEKLY ROW)$/);
    expect(ai[0].unit).toMatch(/^WK \d+ · MATCHUP$/);
    expect(ai[0].num).toMatch(/^\d+\.\d$/);
    // The headline numbers changed vs BASE (a week is not a season).
    const baseNums = base.map((h) => h.num);
    const aiNums = ai.map((h) => h.num);
    expect(aiNums).not.toEqual(baseNums);
    for (const h of ai) {
      if (h.unit.endsWith('MATCHUP')) {
        expect(Number(h.num)).toBeGreaterThan(0);
        expect(Number(h.num)).toBeLessThan(60); // a week, not a season total
      }
      if (h.unit.endsWith('NO WEEKLY ROW')) expect(h.num).toBe('—');
    }
    // Sorted by this week's points, descending.
    const wkNums = ai.filter((h) => h.unit.endsWith('MATCHUP')).map((h) => Number(h.num));
    for (let i = 1; i < wkNums.length; i += 1) expect(wkNums[i]).toBeLessThanOrEqual(wkNums[i - 1] + 1e-6);

    // BASE (season) stays visible on the card, RoS rides every card, the
    // PROJ chip names the week, and the note says what AI+ is — with factors
    // listed only when the shipped doc is the measured weekly_split_v2.
    const first = page.locator('.card.player').first();
    await expect(first.locator('.p-unit').nth(1)).toHaveText(/^BASE \d+\.\d · SEASON$/);
    expect(await page.locator('.p-ros').count()).toBeGreaterThanOrEqual(8);
    await expect(page.locator('.sort-chip[data-sort="proj"]')).toHaveText(/^WK \d+/);
    await expect(page.locator('.ai-note')).toHaveCount(1);
    const note = await page.locator('.ai-note').innerText();
    expect(note).toMatch(/^AI\+ · THIS WEEK — matchup-adjusted weekly points/);
    const v2 = weeklyDoc.model && weeklyDoc.model.name === 'weekly_split_v2';
    expect(/DvP/.test(note)).toBe(v2);
    // The interval under the headline is still the season band (two ends).
    expect(await first.locator('.iv-ends span').count()).toBe(2);
    // Nothing may read as "AI PROJ PTS" or carry a trajectory delta.
    expect(await page.locator('.p-aidelta').count()).toBe(0);
    expect(await page.locator('.p-unit', { hasText: 'AI PROJ' }).count()).toBe(0);

    await page.locator('.aiseg button[data-ai="off"]').click();
    await expect(page.locator('.aiseg button[data-ai="off"]')).toHaveAttribute('aria-pressed', 'true');
    const back = await heads(page, 8);
    expect(back).toEqual(base);
    expect(await page.locator('.p-ros').count()).toBe(0);
    expect(await page.locator('.ai-note').count()).toBe(0);
    await expect(page.locator('.sort-chip[data-sort="proj"]')).toHaveText(/^PROJ/);
  });

  test('the AI+ choice persists across a reload (shared nfl2026.ai.v1)', async ({ page }) => {
    await page.goto('/#/players');
    await waitForPlayers(page);
    await page.locator('.aiseg button[data-ai="on"]').click();
    await expect(page.locator('.p-unit').first()).toHaveText(/^WK \d+ ·/);
    await page.reload();
    await waitForPlayers(page);
    await expect(page.locator('.aiseg button[data-ai="on"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.p-unit').first()).toHaveText(/^WK \d+ ·/);
    await expect(page.locator('.ai-note')).toHaveCount(1);
  });
});
