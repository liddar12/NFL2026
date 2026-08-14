/* tests/web/r24_model_nopath.spec.mjs — the MODEL tab's NO PATH verdict, on the
 * SHIPPED artifact.
 *
 * THE DEFECT THIS LOCKS. app/views/model.js renders the NO PATH chip only when
 * a family row carries `appliable === false`, and the explanatory note only when
 * at least one row does. The distinction was code-complete and invisible: the
 * newest signal_promotion entry in data/model_tuning.json was a pre-R18 record
 * whose families all carried `appliable: null`, so #/model rendered ZERO NO PATH
 * chips and a reader could not tell a family that CANNOT receive weight
 * (coach_quality, coach_regime, dvp_mismatch, scheme_matchup — measured every
 * week, but nothing in the prediction pipeline reads them) from one that simply
 * did not win. Nothing went red, because no spec had ever asserted the string
 * "NO PATH" and the archive assertions in never_regress.test.mjs short-circuited
 * on the missing `significance` block.
 *
 * So this spec drives the REAL committed artifact, not a fixture: it derives the
 * expected families from data/model_tuning.json and asserts the rendered page
 * agrees. If the artifact goes stale again, or the chip logic regresses, one of
 * these fails. The unit half of the same guard lives in never_regress.test.mjs
 * ("the archived promotion entry records how its threshold was earned"), which
 * now requires a boolean `appliable` on every family of the shipped entry.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const tuning = JSON.parse(
  readFileSync(new URL('../../data/model_tuning.json', import.meta.url), 'utf8'),
);

/** The entry the MODEL tab renders: app/views/model.js latestPromotion(). */
const entry = (tuning.history || []).find(
  (h) => h && h.kind === 'signal_promotion' && Array.isArray(h.families),
);

const noPath = (entry.families || [])
  .filter((f) => f.appliable === false).map((f) => f.family);
const canApply = (entry.families || [])
  .filter((f) => f.appliable === true).map((f) => f.family);

test('the shipped artifact actually carries the distinction the chip renders', () => {
  // Guards the spec below against passing vacuously on a stale artifact.
  expect(noPath.length, 'artifact has at least one non-appliable family').toBeGreaterThan(0);
  expect(canApply.length, 'artifact has at least one appliable family').toBeGreaterThan(0);
});

test('a non-appliable family renders NO PATH, and an appliable one never does',
  async ({ page }) => {
    await page.goto('/#/model');
    // .gate-row--head is the column header, not a family.
    const rows = page.locator('.gate-row:not(.gate-row--head)');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    await expect(rows).toHaveCount(entry.families.length);

    // Exactly one chip per family row — the whole point of the verdict is that
    // it does not borrow RETAINED, which would read as "measured, kept at
    // weight 0 for now" when the truth is "cannot receive weight at all".
    const n = await rows.count();
    for (let i = 0; i < n; i += 1) {
      await expect(rows.nth(i).locator('.gate-chip')).toHaveCount(1);
    }

    for (const fam of noPath) {
      const row = rows.filter({ has: page.getByText(fam, { exact: true }) }).first();
      await expect(row, `${fam} has a row`).toHaveCount(1);
      const chip = row.locator('.gate-chip--nopath');
      await expect(chip, `${fam} is marked NO PATH`).toHaveCount(1);
      await expect(chip).toHaveText('NO PATH');
      // The chip explains itself on long-press / hover rather than leaving the
      // reader to guess what "no path" means.
      expect((await chip.getAttribute('title') || '').length).toBeGreaterThan(10);
    }

    for (const fam of canApply) {
      const row = rows.filter({ has: page.getByText(fam, { exact: true }) }).first();
      await expect(row.locator('.gate-chip--nopath'),
        `${fam} can earn weight, so it must NOT be marked NO PATH`).toHaveCount(0);
    }
  });

test('the NO PATH note appears and names every non-appliable family',
  async ({ page }) => {
    await page.goto('/#/model');
    await expect(page.locator('.gate-row').first()).toBeVisible({ timeout: 15000 });
    const note = page.locator('.gate-note');
    await expect(note).toHaveCount(1);
    const text = await note.innerText();
    for (const fam of noPath) {
      expect(text, `the note names ${fam}`).toContain(fam);
    }
  });

test('the NO PATH chip is legible — it is a distinct verdict, not a RETAINED twin',
  async ({ page }) => {
    await page.goto('/#/model');
    await expect(page.locator('.gate-row').first()).toBeVisible({ timeout: 15000 });
    const nopath = page.locator('.gate-chip--nopath').first();
    await expect(nopath).toBeVisible();

    // All the chips share a background and, today, an ink: `--warn-txt` is not
    // defined anywhere in theme.css, so gate-chip--nopath and gate-chip--skipped
    // both fall back to var(--muted) — the same colour as a plain RETAINED chip.
    // The distinction that actually survives is the DASHED border, which is
    // exactly what theme.css says it is for ("Dashed so it can never be mistaken
    // for a slightly weaker RETAINED"). Assert the axis that does the work, not
    // one that happens to be inert.
    const plain = page.locator('.gate-chip:not([class*="--"])').first();
    expect(await plain.count(), 'a RETAINED chip is on screen to contrast with')
      .toBeGreaterThan(0);
    const border = (l) => l.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(await border(nopath), 'NO PATH is dashed').toBe('dashed');
    expect(await border(plain), 'RETAINED is not dashed').not.toBe('dashed');
    // And the label itself is a different word, not a shade of the same one.
    await expect(plain).not.toHaveText('NO PATH');
    // 44px touch targets are for controls; a chip is a label, so this only
    // checks it is not collapsed to nothing.
    const box = await nopath.boundingBox();
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(10);
  });
