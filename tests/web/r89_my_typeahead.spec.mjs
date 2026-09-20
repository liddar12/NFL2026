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
 * R91, 2026-09-20: the thumb pick came back, from the other side. Our overlay
 * is absolutely positioned over #mp-seeds, and commit() runs on pointerdown and
 * repaints SYNCHRONOUSLY — so the finger that picked a row was still down when
 * the seed chip (a [data-drop] REMOVE button) rendered into the row's own
 * pixels. The tap's trailing click then deleted the seed it had just made, and
 * on row 1 it flipped the risk dial EVEN->SAFE and persisted it. The seed box
 * read as dead again, which is the very symptom this file exists to prevent.
 * The app eats that one ghost click now (app/views/myparlays.js, R91), and the
 * tap test below aims at the printed NAME rather than the row's centre: the
 * centre only lands on the chip for long names, so it could have gone green on
 * a kinder pool with the bug still in.
 *
 * NOTHING HERE IS HARD-CODED TO A TEAM. DET at BUF is final today and will not
 * be next week; the final game, the player on it and the pool's week are all
 * derived from the committed data (see _myseed.mjs for the same discipline and
 * the 17 red tests that bought it).
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_PLAYER, SEED_ROWS, SKIP_REASON } from './_myseed.mjs';

/* The MY tests need a game that has not kicked off; between the last game of a
 * week and the next week's pool there is none, and MY correctly offers nothing.
 * The reason names that condition, so a skipped run reads as a finished slate
 * rather than a broken suite. It is '' whenever any game is upcoming. */
test.skip(() => Boolean(SKIP_REASON), SKIP_REASON || 'the slate is live');


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

test('R89 — tapping a row on the phone adds that seed and nothing else', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  const row = page.locator('#mp-suggest li').first();
  const name = (await row.locator('.mp-opt-nm').textContent()).trim();
  // the row itself has to be thumb-sized, not a 20px line of text
  const box = await row.boundingBox();
  expect(box.height, `a suggestion row is ${box.height}px tall`).toBeGreaterThanOrEqual(44);

  // R91 — TAP THE PRINTED NAME, NOT THE ROW'S GEOMETRIC CENTRE. commit() runs
  // on pointerdown and repaints under the still-pressed finger, so the tap's
  // trailing click landed on whatever the repaint slid there — the [data-drop]
  // chip that removes the seed just added. Whether the row's CENTRE is poisoned
  // depends only on the chip's rendered width, i.e. the length of the seed's
  // name (2026-09-20: Patrick Mahomes' chip reached x218 and died, Rashee
  // Rice's stopped at x174 and lived), so a centre tap is a coin flip that
  // could go green on a kinder pool with the bug still in. The name is where a
  // thumb actually lands (x74-90) and it killed 4 of 4 seeds tried, short names
  // included. Tap there: it is width-independent and cannot be masked by a
  // future change to SEED_ROWS.
  await row.locator('.mp-opt-nm').tap();
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
  await expect(page.locator('#mp-seeds .leg-chip')).toContainText(name);
  await expect(page.locator('#mp-suggest li')).toHaveCount(0);
  await expect(page.locator('#mp-input')).toHaveValue('');
  // ...and the same tap must not have actuated the risk dial, which slides up
  // under the finger once the list closes. Tapping row 1 flipped EVEN->SAFE and
  // writeDial PERSISTED it — a sticky preference change nobody asked for.
  await expect(page.locator('.mp-dial [data-dial="even"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mp-dial .leg-chip--active')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('R89 — tapping the second row seeds it without touching the risk dial', async ({ page }) => {
  // R91's second victim, and the reason the guard is on the gesture rather than
  // on the chip: once the list closes, .mp-dial — not #mp-seeds — is what the
  // repaint puts under a finger that was aiming at row 1.
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, LIVE_PLAYER.player.slice(0, 1).toLowerCase());
  const rows = page.locator('#mp-suggest li');
  test.skip(await rows.count() < 2, 'the derived seed query reaches only one row today');
  const row = rows.nth(1);
  const name = (await row.locator('.mp-opt-nm').textContent()).trim();

  await row.locator('.mp-opt-nm').tap();
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
  await expect(page.locator('#mp-seeds .leg-chip')).toContainText(name);
  await expect(page.locator('.mp-dial [data-dial="even"]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

/* ==========================================================================
   (g) THE GHOST-CLICK GUARD ENDS WITH THE GESTURE, NOT WITH A CLOCK
   ==========================================================================
   The guard that eats the tap's trailing click was first written with a 700ms
   timeout. A timer is wrong in both directions and neither direction had a
   test, so both are locked here:
     - a press held LONGER than the timeout outlives the guard, and the ghost
       click lands on the [data-drop] chip after all: the seed the tap just
       created is destroyed, which is the original bug wearing a stopwatch;
     - a press that never becomes a click (a drag, a scroll, a cancel) leaves
       the guard armed, and it eats the viewer's NEXT, legitimate tap.
   The guard is therefore disarmed by the next gesture. These two tests fail on
   a timer-based guard and pass on a gesture-based one. */

test('R89 — a SLOW tap still keeps its seed: the guard outlives any press', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  const row = page.locator('#mp-suggest li').first();
  const name = (await row.locator('.mp-opt-nm').textContent()).trim();

  // Press, hold well past any plausible timeout, then let the trailing click
  // land exactly where the repaint put the remove button: on the new chip.
  await row.locator('.mp-opt-nm').dispatchEvent('pointerdown');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);
  await page.waitForTimeout(1200);
  await page.locator('#mp-seeds .leg-chip').first().dispatchEvent('click');

  await expect(page.locator('#mp-seeds .leg-chip'),
    'a press held 1.2s still belongs to one gesture; its trailing click is still the ghost')
    .toHaveCount(1);
  await expect(page.locator('#mp-seeds .leg-chip')).toContainText(name);
  expect(errors).toEqual([]);
});

test('R89 — a press that never becomes a click does not eat the NEXT tap', async ({ page }) => {
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  const row = page.locator('#mp-suggest li').first();

  // Arm the guard, then abandon the gesture: no click ever follows.
  await row.locator('.mp-opt-nm').dispatchEvent('pointerdown');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);

  // The viewer's next real tap is a separate gesture and must actuate. The dial
  // is the control the ghost click was observed to flip, so it is the right
  // control to prove is reachable again.
  await page.locator('.mp-dial [data-dial="safe"]').tap();
  await expect(page.locator('.mp-dial [data-dial="safe"]'),
    'the abandoned press must not leave a guard armed over a later, real tap')
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mp-dial [data-dial="even"]')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

/* ==========================================================================
   (e) ESCAPE, THE NO-MATCH ROW, AND THE LAYOUT
   ========================================================================== */

test('R89 — the chip still removes its seed on a later, real tap', async ({ page }) => {
  // The R91 guard eats the ONE click that trails the pick. It is armed on the
  // pointerdown that commits and disarmed by the first click it sees, so the
  // NEXT tap — a deliberate one, on the chip's own remove button — must still
  // get through. A guard that outlived its gesture would leave the seed
  // undeletable, which is a worse bug than the one it fixes.
  const errors = watch(page);
  await openMy(page, PHONE);
  await typeSeed(page, surnameOf(LIVE_PLAYER.player));
  await page.locator('#mp-suggest li').first().locator('.mp-opt-nm').tap();
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(1);

  await page.locator('#mp-seeds [data-drop]').tap();
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
  // R90 — the row opens with R89's sentence and is REPLACED by the reason once
  // the weekly/projection join lands; for a name on file nowhere, that reason.
  await expect(page.locator('#mp-suggest li'))
    .toHaveText('Nobody Whatsoever: no player or team by that name', { timeout: 20000 });
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
