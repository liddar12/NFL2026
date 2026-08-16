/* tests/web/kdst_seating.spec.mjs — R21: a K/DEF league can actually field one.
 *
 * Four defects are locked here, all of them only visible in a real browser
 * because they live in the seam between the Team page's player pool, the
 * LeagueProfile's roster geometry and the Lineup card's claims:
 *
 *  1. SEATING (P1). R19-B5 gave a K/DEF league K and DEF slots and R20-B1 gave
 *     the Lineup view a K/DST feed, but nothing could put a kicker on the
 *     roster: the Team page's pool was data/player_projections.json, which is
 *     QB/RB/WR/TE by contract. Tapping K1 opened a finder with no kickers in it
 *     and no explanation. The slot existed and could never be filled.
 *  2. THE FABRICATED ZERO (P1). An unfillable starting slot printed "0.0" — a
 *     manager reads that as a projection of zero, not as "nobody is here" — and
 *     the START/SIT card still called the lineup "already optimal".
 *  3. THE UNQUALIFIED TOTAL (P2). "ALL 9 SLOTS PROJECTED" sat above a D/ST row
 *     whose own badge admitted the total omits scoring components this league
 *     pays for, with the qualification living only in prose below the fold.
 *  4. THE 30px CONTROL (P2). The roster-sync MY TEAM picker inherited the draft
 *     room's 30px density in a panel whose button is 44px.
 *
 * NOTHING here may fire for a league with no K/DEF slots — the last test is the
 * backward-compatibility lock, and it is the whole proof that the seating is
 * additive rather than a change to the default experience.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const KDEF_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

/** A league that fields a kicker and a defence. `scoring` overrides are merged. */
function kdefLeague(scoring) {
  const profile = {
    version: 1,
    name: 'K/DEF League',
    shape: { teams: 12, roster_positions: [...KDEF_ROSTER] },
  };
  if (scoring) profile.scoring = scoring;
  return profile;
}

/** Seed the profile (and optionally a roster) before the first document load. */
const seed = (page, profile, slots) => page.addInitScript((s) => {
  localStorage.setItem('nfl2026.league.v1', s.profile);
  if (s.slots) localStorage.setItem('nfl2026.team.v1', s.slots);
  else localStorage.removeItem('nfl2026.team.v1');
}, { profile: JSON.stringify(profile), slots: slots ? JSON.stringify({ slots }) : null });

/* ==========================================================================
   1. SEATING — the finder, the slot, and what gets persisted
   ========================================================================== */

test.describe('a K/DEF league can put a kicker and a defence on its roster', () => {
  test('the finder offers K and DEF chips, and the rows are real contract rows', async ({ page }) => {
    await seed(page, kdefLeague());
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 15000 });

    const chips = await page.locator('.finder-posfilter .pf-chip').allInnerTexts();
    expect(chips).toEqual(['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

    await page.locator('.pf-chip', { hasText: /^K$/ }).click();
    const rows = page.locator('#t-cands .cand');
    expect(await rows.count()).toBeGreaterThan(5);
    // Every row really is a kicker, and it is one the contract ships.
    const kickers = new Set(readData('kdst_projections.json').kickers.map((k) => k.name));
    const names = await rows.locator('.cd-name').allInnerTexts();
    for (const n of names) expect(kickers.has(n.trim())).toBe(true);
    // The number is a SEASON projection with no weekly split, and says so.
    await expect(rows.first()).toContainText('SEASON');
  });

  test('ADD seats him in K1 and the saved roster carries the contract id', async ({ page }) => {
    await seed(page, kdefLeague());
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 15000 });

    await page.locator('.slot[data-slot="K1"] .slot-empty').click();
    await page.locator('.pf-chip', { hasText: /^K$/ }).click();
    await page.locator('#t-cands .cand .cand-add').first().click();
    await page.locator('.pf-chip', { hasText: /^DEF$/ }).click();
    await page.locator('#t-cands .cand .cand-add').first().click();

    await expect(page.locator('.slot[data-slot="K1"] .slot-player')).toBeVisible();
    await expect(page.locator('.slot[data-slot="DEF1"] .slot-player')).toBeVisible();

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nfl2026.team.v1')));
    const doc = readData('kdst_projections.json');
    expect(doc.kickers.map((k) => k.player_id)).toContain(saved.slots.K1);
    expect(doc.defenses.map((d) => d.player_id)).toContain(saved.slots.DEF1);
  });

  test('tapping the K slot gets candidates, never "no eligible players left"', async ({ page }) => {
    await seed(page, kdefLeague());
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 15000 });
    await page.locator('.slot[data-slot="K1"] .slot-empty').click();

    const reco = page.locator('#t-reco');
    await expect(reco).toContainText('K1');
    await expect(reco).not.toContainText('No eligible players left');
    // The panel says WHY it is not a fit score — there is no weekly split.
    await expect(reco).toContainText('no weekly split');
    expect(await reco.locator('.reco-item').count()).toBeGreaterThan(0);
  });

  test('a seated K/DST reaches the Lineup card and fills its slot', async ({ page }) => {
    const doc = readData('kdst_projections.json');
    await seed(page, kdefLeague(), {
      K1: doc.kickers[0].player_id, DEF1: doc.defenses[0].player_id,
    });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });
    const card = page.locator('.lu-card').first();
    await expect(card).toContainText(doc.kickers[0].name);
    await expect(card).toContainText(doc.defenses[0].name);
  });
});

/* ==========================================================================
   2. AN EMPTY STARTING SLOT IS NOT A ZERO
   ========================================================================== */

test.describe('an unfillable starting slot never reads as a projection of zero', () => {
  test('the row prints an em dash and says it is out of the total', async ({ page }) => {
    const doc = readData('kdst_projections.json');
    // Only a kicker on the roster: eight starting slots have nobody.
    await seed(page, kdefLeague(), { K1: doc.kickers[0].player_id });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });

    const empties = page.locator('.lu-row--empty');
    expect(await empties.count()).toBeGreaterThan(0);
    for (const text of await empties.allInnerTexts()) {
      expect(text).not.toMatch(/\b0\.0\b/);
      expect(text).toContain('—');
      expect(text).toContain('NOT IN THE TOTAL');
    }
  });

  test('"already optimal" is qualified to the slots that actually hold somebody', async ({ page }) => {
    const doc = readData('kdst_projections.json');
    await seed(page, kdefLeague(), { K1: doc.kickers[0].player_id });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });

    const moves = page.locator('.lu-card').nth(1);
    const text = await moves.innerText();
    if (text.includes('already optimal')) {
      // It may claim optimality only over the FILLED slots, and it must name
      // the empty ones in the same card.
      expect(text).toMatch(/Your \d+ filled slots? (is|are) already optimal/);
      await expect(moves.locator('.lu-emptynote')).toHaveCount(1);
      await expect(moves.locator('.lu-emptynote')).toContainText('nothing on your roster can fill');
    }
    // The unqualified claim is the one thing that may never appear.
    expect(text).not.toMatch(/Your starting lineup is already optimal/);
  });

  test('the coverage line counts the empty slots', async ({ page }) => {
    const doc = readData('kdst_projections.json');
    await seed(page, kdefLeague(), { K1: doc.kickers[0].player_id });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-cover', { timeout: 15000 });
    await expect(page.locator('.lu-cover')).toContainText('EMPTY');
  });
});

/* ==========================================================================
   3. A PARTIAL TOTAL IS MARKED WHERE THE NUMBER IS
   ========================================================================== */

test('a PARTIAL D/ST total is qualified on the coverage line and on the number', async ({ page }) => {
  const doc = readData('kdst_projections.json');
  // Score the three components the builder declares it cannot model, so the
  // D/ST total really is incomplete under this league.
  const scoring = {};
  for (const u of doc.unmodelled_keys) scoring[u.key] = 2;
  scoring.sack = 1;
  scoring.int = 2;
  scoring.pts_allow_0 = 10;
  scoring.rec = 1;
  scoring.rec_yd = 0.1;
  scoring.rec_td = 6;
  scoring.rush_yd = 0.1;
  scoring.rush_td = 6;
  scoring.pass_yd = 0.04;
  scoring.pass_td = 4;
  scoring.xpm = 1;

  await seed(page, kdefLeague(scoring), {
    K1: doc.kickers[0].player_id, DEF1: doc.defenses[0].player_id,
  });
  await page.goto('/#/lineup');
  await page.waitForSelector('.lu-card', { timeout: 15000 });

  // The row admits it...
  await expect(page.locator('.lu-tag--warn', { hasText: 'PARTIAL' }).first()).toBeVisible();
  // ...the coverage line beside the card total admits it...
  await expect(page.locator('.lu-cover')).toContainText('PARTIAL');
  // ...and so does the number itself, in text and not by colour alone.
  const marked = page.locator('.lu-pts--partial');
  expect(await marked.count()).toBeGreaterThan(0);
  await expect(marked.first()).toContainText('*');
  // The disclosure block names the marker rather than leaving a mystery glyph.
  await expect(page.locator('.lu-partial-head')).toContainText('*');
});

/* ==========================================================================
   4. THE 44px MINIMUM TOUCH TARGET
   ========================================================================== */

for (const [label, size] of [['iPhone', { width: 402, height: 874 }],
  ['iPad', { width: 1024, height: 1366 }]]) {
  test(`the roster-sync MY TEAM picker is a 44px touch target on ${label}`, async ({ page }) => {
    await seed(page, kdefLeague());
    await page.setViewportSize(size);
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 15000 });
    // R34 — measure at rest: the always-on HIG theme's entrance animation
    // scales the fresh view from 0.995 for 240ms, and a mid-animation read
    // shaves a min-height:44px control to ~43.87. The target IS 44px.
    await page.evaluate(() => Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    ));
    // The real control only renders after a Sleeper fetch this sandbox cannot
    // make, so its exact markup is mounted into the live page and measured with
    // the real cascade — the same technique the panel's own markup produces.
    const h = await page.evaluate(() => {
      const host = document.querySelector('.team-col--build') || document.body;
      const wrap = document.createElement('div');
      wrap.className = 'lp-sync';
      wrap.innerHTML = '<label class="lp-field lp-field--grow">'
        + '<span class="ds-lbl">MY TEAM</span>'
        + '<select class="ds-select lp-rsel" data-rcfg="team"><option>Team</option></select>'
        + '</label>';
      host.appendChild(wrap);
      const r = wrap.querySelector('select').getBoundingClientRect();
      wrap.remove();
      return r.height;
    });
    expect(h).toBeGreaterThanOrEqual(44);
  });
}

/* ==========================================================================
   5. BACKWARD COMPATIBILITY — none of this exists without a K/DEF league
   ========================================================================== */

test('with NO league saved the Team page is exactly what it was', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('nfl2026.league.v1');
    localStorage.removeItem('nfl2026.team.v1');
  });
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });

  const chips = await page.locator('.finder-posfilter .pf-chip').allInnerTexts();
  expect(chips).toEqual(['ALL', 'QB', 'RB', 'WR', 'TE']);

  // A kicker's name finds nothing: this league does not field one, so offering
  // him would be offering a player who can never take a slot.
  const kicker = readData('kdst_projections.json').kickers[0].name.split(' ').pop();
  await page.fill('#t-find', kicker);
  await expect(page.locator('#t-cands')).toContainText('No players match');
});
