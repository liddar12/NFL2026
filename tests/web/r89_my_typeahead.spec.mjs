/* tests/web/r89_my_typeahead.spec.mjs — the MY PARLAYS seed search, under a thumb.
 *
 * The bug this proves fixed was only ever visible in a browser. The seed box was
 * a native <datalist>: it accepted an EXACT option name and nothing else, so
 * "goff", "aaron jones" and "j allen" each added nothing and cleared the field,
 * and on iPhone Safari the native suggestion popup is unreliable enough that the
 * search read as dead. The list is ours now, so every claim below is about real
 * DOM: rows appear as you type, the keyboard walks them, a thumb picks one, and
 * a row whose game is already final says so BEFORE you spend a tap on it.
 *
 * NOTHING HERE IS HARD-CODED TO A TEAM. DET at BUF is final today and will not
 * be next week; the final game, the player on it and the pool's week are all
 * derived from the committed data (see _myseed.mjs for the same discipline and
 * the 17 red tests that bought it).
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_PLAYER, SEED_ROWS } from './_myseed.mjs';

const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const SCHEDULE = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));
const WEEK = Number(POOL.week);

const PHONE = { width: 402, height: 874 };
const SIZES = [['iPhone 402x874', PHONE], ['desktop 1280x900', { width: 1280, height: 900 }]];

/** The view's own normalisation, restated: this test may not import the module. */
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
/** The last token of a name that is not a suffix — what a person actually types. */
function surnameOf(name) {
  const tokens = norm(name).split(' ').filter((t) => !SUFFIX.has(t));
  return tokens[tokens.length - 1] || '';
}
/** Every seedable name: the pooled players plus the team abbreviations. */
const ALL_NAMES = [...new Set([...POOL.players.map((r) => r.player),
  ...POOL.players.map((r) => r.team)])];
/** How many options a query could possibly reach (token-prefix OR substring). */
const reach = (q) => ALL_NAMES.filter((name) => {
  const full = norm(name);
  return full.split(' ').some((t) => t.startsWith(q)) || full.includes(q);
});
/** A pool row whose surname alone can only mean him — so "first row" is provable. */
function unambiguous(rows) {
  return rows.find((r) => reach(surnameOf(r.player)).length === 1) || null;
}

/* The finished game of the pool week, and a player on it. Today that is
 * DET at BUF with 17 pooled players; the test asks the data, not the calendar. */
const FINAL_GAME = SCHEDULE.games.find((g) => Number(g.week) === WEEK && g.status === 'STATUS_FINAL');
const FINAL_ROWS = FINAL_GAME
  ? POOL.players.filter((r) => r.team === FINAL_GAME.home || r.team === FINAL_GAME.away) : [];
const FINAL_PLAYER = unambiguous(FINAL_ROWS) || FINAL_ROWS[0] || null;
/* A player whose game has NOT kicked off (the derived upcoming seed). */
const LIVE_PLAYER = unambiguous(SEED_ROWS) || SEED_PLAYER;

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

/** Open PARLAYS and switch to MY. No seed: typing one is what is under test. */
async function openMy(page, size) {
  await page.setViewportSize(size);
  await page.goto('/#/parlays');
  await page.waitForSelector('.scopeseg [data-seg="my"]', { timeout: 20000 });
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
}

/** Type like a person: one key at a time, into the real input. */
async function typeSeed(page, text) {
  await page.locator('#mp-input').click();
  await page.locator('#mp-input').pressSequentially(text, { delay: 15 });
  await expect(page.locator('#mp-suggest li').first()).toBeVisible({ timeout: 5000 });
}

/* ==========================================================================
   (a) A PARTIAL NAME FINDS THE PLAYER, AND A FINISHED GAME SAYS SO FIRST
   ========================================================================== */

for (const [label, size] of SIZES) {
  test(`R89 — ${label}: a surname finds a player whose game is over, and the empty state says which game`, async ({ page }) => {
    test.skip(!FINAL_PLAYER, `no week-${WEEK} game is final in data/schedule_full.json yet`);
    const errors = watch(page);
    await openMy(page, size);

    const query = surnameOf(FINAL_PLAYER.player);
    await typeSeed(page, query);

    // the row is his, and it carries the reason it will build nothing
    const row = page.locator('#mp-suggest li').first();
    await expect(row).toContainText(FINAL_PLAYER.player);
    await expect(row).toHaveAttribute('role', 'option');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(row.locator('.est')).toHaveText('GAME FINAL');
    await expect(page.locator('#mp-input')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#mp-input')).toHaveAttribute('aria-activedescendant', 'mp-opt-0');

    // Enter takes the best match — the datalist took nothing at all
    await page.press('#mp-input', 'Enter');
    await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
    await expect(page.locator('#mp-seeds .leg-chip')).toContainText(FINAL_PLAYER.player);
    await expect(page.locator('#mp-input')).toHaveValue('');
    await expect(page.locator('#mp-suggest li')).toHaveCount(0);

    // and the empty state names the game, its state, and when cards return
    const state = page.locator('#mp-list .state');
    await expect(state).toContainText(`${FINAL_GAME.away} @ ${FINAL_GAME.home} is final`);
    await expect(state).toContainText(`week ${WEEK + 1} pool`);
    await expect(state).toContainText(FINAL_PLAYER.player);
    await expect(page.locator('.mp-card')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

/* ==========================================================================
   (b) A SURNAME ALONE BUILDS THE CARDS
   ========================================================================== */

for (const [label, size] of SIZES) {
  test(`R89 — ${label}: a lower-case surname is enough to build a card`, async ({ page }) => {
    const errors = watch(page);
    await openMy(page, size);
    await typeSeed(page, surnameOf(LIVE_PLAYER.player));

    await expect(page.locator('#mp-suggest li').first()).toContainText(LIVE_PLAYER.player);
    // his game has not kicked off, so no row of his is flagged
    await expect(page.locator('#mp-suggest li').first().locator('.est')).toHaveCount(0);
    await page.press('#mp-input', 'Enter');
    await expect(page.locator('#mp-seeds .leg-chip')).toContainText(LIVE_PLAYER.player);
    await page.waitForSelector('.mp-card', { timeout: 20000 });
    expect(await page.locator('.mp-card').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

/* ==========================================================================
   (c) THE KEYBOARD WALKS THE LIST
   ========================================================================== */

test('R89 — ArrowDown twice then Enter picks the THIRD row, not the first', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  // a one-letter query nobody would call precise: it is here to fill the list
  await typeSeed(page, LIVE_PLAYER.player.slice(0, 1).toLowerCase());
  const rows = page.locator('#mp-suggest li');
  expect(await rows.count(), 'the list needs three rows to prove the third is picked')
    .toBeGreaterThanOrEqual(3);
  const third = (await rows.nth(2).locator('.mp-opt-nm').textContent()).trim();

  await page.press('#mp-input', 'ArrowDown');
  await page.press('#mp-input', 'ArrowDown');
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#mp-input')).toHaveAttribute('aria-activedescendant', 'mp-opt-2');
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
  await expect(page.locator('#mp-seeds .leg-chip')).toContainText(third);

  // and the walk wraps rather than dead-ending at the last row
  await typeSeed(page, LIVE_PLAYER.player.slice(0, 1).toLowerCase());
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) await page.press('#mp-input', 'ArrowDown');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.press('#mp-input', 'ArrowUp');
  await expect(rows.nth(n - 1)).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

/* ==========================================================================
   (d) A THUMB PICKS A ROW — the tap the native popup kept losing
   ========================================================================== */

test('R89 — tapping a row on the phone adds that seed', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  const row = page.locator('#mp-suggest li').first();
  const name = (await row.locator('.mp-opt-nm').textContent()).trim();
  // the row itself has to be thumb-sized, not a 20px line of text
  const box = await row.boundingBox();
  expect(box.height, `a suggestion row is ${box.height}px tall`).toBeGreaterThanOrEqual(44);

  await row.tap();
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
  await expect(page.locator('#mp-seeds .leg-chip')).toContainText(name);
  await expect(page.locator('#mp-suggest li')).toHaveCount(0);
  await expect(page.locator('#mp-input')).toHaveValue('');
  expect(errors).toEqual([]);
});

/* ==========================================================================
   (e) ESCAPE, THE NO-MATCH ROW, AND THE LAYOUT
   ========================================================================== */

test('R89 — Escape closes the list and keeps what was typed', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  const query = surnameOf(LIVE_PLAYER.player);
  await typeSeed(page, query);
  await page.press('#mp-input', 'Escape');
  await expect(page.locator('#mp-suggest li')).toHaveCount(0);
  await expect(page.locator('#mp-suggest')).toBeHidden();
  await expect(page.locator('#mp-input')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#mp-input')).toHaveValue(query);
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('R89 — a name nothing answers says so, and adds nothing', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await page.locator('#mp-input').click();
  await page.locator('#mp-input').pressSequentially('Nobody Whatsoever', { delay: 5 });
  await expect(page.locator('#mp-suggest li')).toHaveCount(1);
  await expect(page.locator('#mp-suggest li')).toHaveText('No player or team matches');
  await expect(page.locator('#mp-suggest li')).not.toHaveAttribute('data-seed', /.*/);
  await page.press('#mp-input', 'Enter');
  // the typed text stays where it can be corrected; nothing is invented
  await expect(page.locator('#mp-input')).toHaveValue('Nobody Whatsoever');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
  await expect(page.locator('.mp-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('R89 — at 402px the open list overlays the cards and the page never scrolls sideways', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  // build a list first, so there is something for the suggestions to cover
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  await page.press('#mp-input', 'Enter');
  await page.waitForSelector('.mp-card', { timeout: 20000 });
  const listTop = await page.locator('#mp-list').evaluate((n) => n.getBoundingClientRect().top);

  await typeSeed(page, LIVE_PLAYER.player.slice(0, 1).toLowerCase());
  const geo = await page.evaluate(() => {
    const ul = document.querySelector('#mp-suggest');
    const input = document.querySelector('#mp-input');
    const r = ul.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      left: r.left, right: r.right, top: r.top, height: r.height,
      inputLeft: i.left, inputRight: i.right, inputBottom: i.bottom,
      listTop: document.querySelector('#mp-list').getBoundingClientRect().top,
      overflowY: getComputedStyle(ul).overflowY,
    };
  });
  expect(geo.docScrollWidth, 'the page scrolls sideways with the list open').toBeLessThanOrEqual(402);
  expect(geo.docScrollWidth).toBe(geo.innerWidth);
  expect(Math.round(geo.left)).toBe(Math.round(geo.inputLeft));
  expect(Math.round(geo.right)).toBe(Math.round(geo.inputRight));
  expect(geo.top, 'the list must hang directly off the input').toBeGreaterThanOrEqual(geo.inputBottom);
  expect(geo.height, 'the list may not own more than 40vh of an 874px phone').toBeLessThanOrEqual(0.4 * 874 + 2);
  expect(geo.overflowY).toBe('auto');
  // the cards did not move: the list is an overlay, not another row
  expect(Math.abs(geo.listTop - listTop), 'the card grid moved when the list opened')
    .toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
