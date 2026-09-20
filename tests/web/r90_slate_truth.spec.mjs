/* tests/web/r90_slate_truth.spec.mjs — R90 in the browser (project `web`).
 *
 * F13 — HISTORICAL TRUTH. A closed week is derived from the COMMITTED feeds (a
 * week whose every schedule_full game is FINAL and whose review.json block
 * carries rows), so this spec proves the real artifact, not a fixture: every
 * probability the slate renders on that week equals its LOCKED pick_prob to the
 * card's own rounding, the final score is on the card, and the number
 * build_predictions recomputed from today's ratings appears only inside the
 * provenance line. The committed flipped-favourite game (locked 62.67% vs
 * recomputed 48.67%) is asserted by name: the emphasis must follow the LOCK,
 * which is what the won/lost dot grades. A game with no review row (fixture via
 * page.route) says "no pregame forecast on file" instead of borrowing a number.
 *
 * G04 — the same truth on the CURRENT week, per card: the week's FINAL game
 * renders data-rv-prob="locked", .rv-final and .rv-prov, and a STATUS_SCHEDULED
 * card on that same week renders none of them.
 *
 * F20 — KEYBOARD AND SEMANTICS. The week bar is a group of aria-pressed
 * buttons (Enter activates, Left/Right move focus and select) and the review
 * expansion is a real button with aria-expanded / aria-controls that Enter
 * opens and Escape closes, focus never leaving it.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const GP = read('../../data/game_predictions.json');
const SCHEDULE = read('../../data/schedule_full.json');
const REVIEW = read('../../data/review.json');
const CURRENT = Number(GP.week);

/** The first CLOSED week: every schedule_full game FINAL, review rows on file. */
function closedWeek() {
  const byWeek = new Map();
  for (const g of SCHEDULE.games || []) {
    const w = Number(g.week);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(g);
  }
  for (const w of [...byWeek.keys()].sort((a, b) => a - b)) {
    if (w === CURRENT) continue; // the pipeline's own week keeps today's forecast
    const games = byWeek.get(w);
    if (!games.length || !games.every((g) => /^STATUS_FINAL/.test(String(g.status || '')))) continue;
    const blk = REVIEW.weeks[String(w)];
    if (blk && Array.isArray(blk.games) && blk.games.length) return w;
  }
  return null;
}

const WEEK = closedWeek();
const ROWS = WEEK == null ? [] : REVIEW.weeks[String(WEEK)].games;
const SCHED = new Map((SCHEDULE.games || [])
  .filter((g) => Number(g.week) === WEEK).map((g) => [String(g.game_id), g]));

/** The locked pair, rounded exactly the way renderGameCard rounds each side. */
function lockedPct(row) {
  const home = row.picked === row.home ? row.pick_prob : 1 - row.pick_prob;
  return { home: Math.round(home * 100), away: Math.round((1 - home) * 100) };
}
/** The number the card WOULD have shown: today's recomputation, picked side. */
function recomputedPct(row) {
  const s = SCHED.get(String(row.game_id));
  if (!s || !s.probs) return null;
  return Math.round((row.picked === row.home ? s.probs.home : s.probs.away) * 100);
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // Resource 404s are the optional-feed story, not a script error.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** Keyboard-only: press Tab until the focused element matches `selector`. */
async function tabTo(page, selector, max = 80) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(
      (sel) => !!(document.activeElement && document.activeElement.matches(sel)), selector);
    if (hit) return true;
  }
  return false;
}
const focusedAttr = (page, attr) => page.evaluate(
  (a) => (document.activeElement ? document.activeElement.getAttribute(a) : null), attr);

async function openClosedWeek(page) {
  await page.goto('/#/');
  await page.waitForSelector('.card.game', { timeout: 15000 });
  await page.locator(`.wk-chip[data-wk="${WEEK}"]`).click();
  // Wait on an id only this week paints — both weeks carry 16 cards, so a
  // count would pass before the repaint ever happened.
  await page.waitForSelector(`.card.game[data-game-id="${ROWS[0].game_id}"]`, { timeout: 15000 });
}

test.describe('R90 — F13 historical truth on a closed week', () => {
  test('the committed data gives us a closed week that is not the pipeline\'s week', () => {
    expect(WEEK, 'no week in schedule_full is entirely FINAL with review rows on file').not.toBeNull();
    expect(WEEK).not.toBe(CURRENT);
    expect(ROWS.length).toBeGreaterThan(0);
  });

  test('every rendered probability is the LOCK; the final score is shown; the recomputation is named separately', async ({ page }) => {
    const errors = collectErrors(page);
    await openClosedWeek(page);
    await page.waitForFunction(
      (n) => document.querySelectorAll('.card.game .prob[data-rv-prob="locked"]').length === n,
      ROWS.length, { timeout: 15000 });

    let flipped = 0;
    for (const row of ROWS) {
      const card = page.locator(`.card.game[data-game-id="${row.game_id}"]`);
      const pct = lockedPct(row);
      // 1. the heads ARE the lock, to the card's own rounding
      await expect(card.locator('.ph--home')).toHaveText(`${row.home} ${pct.home}%`);
      await expect(card.locator('.ph--away')).toHaveText(`${row.away} ${pct.away}%`);
      await expect(card.locator('.ph--fav')).toHaveCount(1);
      await expect(card.locator('.ph--fav')).toHaveText(
        pct.home >= pct.away ? `${row.home} ${pct.home}%` : `${row.away} ${pct.away}%`);
      // 2. the final score is on the card
      await expect(card.locator('.rv-final')).toHaveText(
        `FINAL · ${row.home} ${row.final.home_score}–${row.away} ${row.final.away_score}`);
      // 3. the recomputation is a second, NAMED figure — never a head
      const rec = recomputedPct(row);
      const prov = card.locator('.rv-prov');
      await expect(prov).toContainText('LOCKED ');
      await expect(prov).toContainText(`recomputed with today's model: ${rec}%`);
      await expect(prov).toHaveAttribute('data-rv-recomputed', String(rec));
      if (rec !== (row.picked === row.home ? pct.home : pct.away)) flipped += 1;
    }
    // The fault was real on the committed data: at least one card's recomputed
    // number differs from its lock, and the head shows the LOCK anyway.
    expect(flipped).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('the flipped-favourite game shows the LOCKED favourite, and the dot grades the same pick', async ({ page }) => {
    const row = ROWS.find((g) => recomputedPct(g) != null
      && (recomputedPct(g) < 50) !== (Math.round(g.pick_prob * 100) < 50));
    test.skip(!row, 'no committed game where the recomputation flips the favourite');
    await openClosedWeek(page);
    const card = page.locator(`.card.game[data-game-id="${row.game_id}"]`);
    await expect(card.locator('.prob')).toHaveAttribute('data-rv-prob', 'locked');
    // The emphasized side is the PICKED side — the one the receipt grades.
    const pct = lockedPct(row);
    const pickedPct = row.picked === row.home ? pct.home : pct.away;
    await expect(card.locator('.ph--fav')).toHaveText(`${row.picked} ${pickedPct}%`);
    await expect(card.locator(`.ph--${row.picked === row.home ? 'home' : 'away'}`))
      .toHaveAttribute('data-rv-recomputed', String(recomputedPct(row)));
    await expect(card.locator('.rv-dot')).toHaveAttribute('aria-label', `${row.picked} pick ${row.result}`);
    // the track tells the same story as the heads
    await expect(card.locator('.track')).toHaveAttribute(
      'aria-label', `Locked pregame win probability: ${row.home} ${pct.home}%, ${row.away} ${pct.away}%`);
  });

  test('a past game with no review row says so, and shows no number at all', async ({ page }) => {
    const errors = collectErrors(page);
    const dropped = ROWS[0];
    const doc = JSON.parse(JSON.stringify(REVIEW));
    doc.weeks[String(WEEK)].games = doc.weeks[String(WEEK)].games
      .filter((g) => String(g.game_id) !== String(dropped.game_id));
    await page.route('**/data/review.json', (r) => json(r, JSON.stringify(doc)));
    await openClosedWeek(page);

    const card = page.locator(`.card.game[data-game-id="${dropped.game_id}"]`);
    await expect(card.locator('.ph--none')).toHaveText('no pregame forecast on file');
    await expect(card.locator('.prob')).toHaveAttribute('data-rv-prob', 'none');
    // Today's recomputed number is gone from the card entirely — heads and dot.
    await expect(card.locator('.prob-heads')).not.toContainText('%');
    await expect(card.locator('.rv-final')).toHaveCount(0);
    await expect(card.locator('.rv-dot')).toHaveCount(0);
    // Its neighbours, which DO have locks, are untouched.
    const kept = ROWS[1];
    const keptPct = lockedPct(kept);
    await expect(page.locator(`.card.game[data-game-id="${kept.game_id}"] .ph--home`))
      .toHaveText(`${kept.home} ${keptPct.home}%`);
    expect(errors).toEqual([]);
  });

  /* G04 (R87-R91 review) — the same truth on the CURRENT week, decided PER CARD.
   * The assertion that stood here was "the current week is untouched — no lock
   * repaint, no provenance line", which is exactly the defect: a FINAL game on
   * the pipeline's own week got the graded dot and the why button while its head
   * kept today's recomputation. Committed DET @ BUF graded a 65% lock and printed
   * 69%, and 15 more week-2 games go FINAL under the same rule. */

  test('G04: a FINAL game on the CURRENT week shows its LOCK; an unplayed game on the same week does not', async ({ page }) => {
    const errors = collectErrors(page);
    const blk = REVIEW.weeks[String(CURRENT)] || { games: [] };
    // SCHED above is the closed week's index; this test needs the current one.
    const schedOf = (id) => (SCHEDULE.games || []).find((x) => String(x.game_id) === String(id));
    const statusOf = (id) => String((schedOf(id) || {}).status || '');
    const todayPct = (row) => {
      const s = schedOf(row.game_id);
      return Math.round((row.picked === row.home ? s.probs.home : s.probs.away) * 100);
    };
    const finalRow = blk.games.find((g) => /^STATUS_FINAL/.test(statusOf(g.game_id))
      && g.pick_prob != null);
    const openRow = blk.games.find((g) => statusOf(g.game_id) === 'STATUS_SCHEDULED');
    expect(finalRow, 'the committed current week carries a FINAL game').toBeTruthy();
    expect(openRow, 'the committed current week carries an unplayed game').toBeTruthy();

    await page.goto('/#/');
    await page.waitForSelector('.card.game', { timeout: 15000 });
    const done = page.locator(`.card.game[data-game-id="${finalRow.game_id}"]`);
    await done.locator('.prob[data-rv-prob="locked"]').waitFor({ timeout: 15000 });

    // 1. the head is the LOCK the won/lost dot grades — not today's recomputation
    const pct = lockedPct(finalRow);
    await expect(done.locator('.ph--home')).toHaveText(`${finalRow.home} ${pct.home}%`);
    await expect(done.locator('.ph--away')).toHaveText(`${finalRow.away} ${pct.away}%`);
    await expect(done.locator('.rv-final')).toHaveText(
      `FINAL \u00b7 ${finalRow.home} ${finalRow.final.home_score}\u2013${finalRow.away} ${finalRow.final.away_score}`);
    // 2. the recomputation is a second, NAMED figure
    const rec = todayPct(finalRow);
    await expect(done.locator('.rv-prov')).toContainText('LOCKED ');
    await expect(done.locator('.rv-prov')).toContainText(`recomputed with today's model: ${rec}%`);
    // 3. the review's own case: 65%, not 69%
    const pickedPct = finalRow.picked === finalRow.home ? pct.home : pct.away;
    expect(pickedPct).toBe(Math.round(finalRow.pick_prob * 100));
    if (String(finalRow.game_id) === '401872932') {
      expect(pickedPct).toBe(65);
      expect(rec).toBe(69);
      await expect(done.locator('.ph--fav')).toHaveText(`${finalRow.picked} 65%`);
    }

    // 4. an unplayed game on the SAME week keeps today's forecast: none of it
    const open = page.locator(`.card.game[data-game-id="${openRow.game_id}"]`);
    await expect(open.locator('.prob[data-rv-prob]')).toHaveCount(0);
    await expect(open.locator('.rv-final')).toHaveCount(0);
    await expect(open.locator('.rv-prov')).toHaveCount(0);
    await expect(open.locator('.ph--none')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('R90 — F20 keyboard and semantics', () => {
  test('the week bar is a group of pressed buttons, driven from the keyboard alone', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/#/');
    await page.waitForSelector('.card.game', { timeout: 15000 });
    await expect(page.locator('.wkbar')).toHaveAttribute('role', 'group');
    await expect(page.locator('.wkbar')).toHaveAttribute('aria-label', 'Week');
    await expect(page.locator('.wkbar [role="tab"]')).toHaveCount(0);
    await expect(page.locator(`.wk-chip[data-wk="${CURRENT}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.wk-chip[aria-pressed="true"]')).toHaveCount(1);

    // Tab reaches the rail; Enter activates the focused chip (native button).
    expect(await tabTo(page, '.wk-chip')).toBe(true);
    const first = Number(await focusedAttr(page, 'data-wk'));
    expect(first).toBe(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('.wk-chip[data-wk="1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.view-title')).toHaveText('WEEK 1 SLATE');

    // ArrowRight moves focus AND selects the next week.
    await page.keyboard.press('ArrowRight');
    expect(Number(await focusedAttr(page, 'data-wk'))).toBe(2);
    await expect(page.locator('.wk-chip[data-wk="2"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.wk-chip[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.view-title')).toHaveText('WEEK 2 SLATE');
    // ArrowLeft comes back the same way.
    await page.keyboard.press('ArrowLeft');
    expect(Number(await focusedAttr(page, 'data-wk'))).toBe(1);
    await expect(page.locator('.wk-chip[data-wk="1"]')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('a graded card expands from its own button: Enter opens, Escape closes, focus never moves', async ({ page }) => {
    const errors = collectErrors(page);
    await openClosedWeek(page);
    await page.waitForSelector('.rv-why-btn', { timeout: 15000 });

    // The article is not the control any more, and each button names its game.
    await expect(page.locator('.card.game[aria-expanded]')).toHaveCount(0);
    const firstBtn = page.locator('.rv-why-btn').first();
    const card = page.locator('.card.game').filter({ has: page.locator('.rv-why-btn') }).first();
    const gameId = await card.getAttribute('data-game-id');
    const row = ROWS.find((g) => String(g.game_id) === String(gameId));
    await expect(firstBtn).toHaveAttribute('aria-label', `Why this result: ${row.away} at ${row.home}`);

    expect(await tabTo(page, '.rv-why-btn')).toBe(true);
    const controls = await focusedAttr(page, 'aria-controls');
    expect(controls).toBeTruthy();
    const panel = page.locator(`#${controls}`);
    await expect(panel).toBeHidden();

    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    expect(await focusedAttr(page, 'aria-expanded')).toBe('true');
    expect(await focusedAttr(page, 'aria-controls')).toBe(controls); // focus never left

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(await focusedAttr(page, 'aria-expanded')).toBe('false');
    expect(await focusedAttr(page, 'aria-controls')).toBe(controls);

    // Enter toggles it shut again too, from the same button.
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(panel).toBeHidden();
    expect(await focusedAttr(page, 'aria-controls')).toBe(controls);

    // A native button, so Enter/Space and the app's existing button:focus-visible
    // ring come free — nothing here reimplements either.
    expect(await firstBtn.evaluate((el) => el.tagName)).toBe('BUTTON');
    await expect(firstBtn).toHaveAttribute('type', 'button');
    expect(errors).toEqual([]);
  });
});
