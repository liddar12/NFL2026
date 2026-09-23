/* tests/web/r90_parlays_ux.spec.mjs — R90 F18/F19/F20 in the browser (`web`).
 *
 * F18 was a MEASUREMENT: at 402x874 the first curated parlay card started at
 * 1,217 px, 465 px of it an always-open glossary, and the opening viewport
 * showed no bet at all. So the acceptance here is a measurement too — the top
 * of the first .card.parlay against the top of the bottom navigation, which is
 * the real edge of the first screen. Everything else this file asserts is the
 * cost of that: no control may have been REMOVED to buy the space back.
 *
 * Like r75 this routes nothing for the layout tests: it drives the COMMITTED
 * data/parlays.json, data/review.json and data/leg_pool.json exactly as
 * production serves them, and derives every expectation from those same files.
 * The one routed test is the ungraded week, which the committed feed has no
 * example of at the current week and which cannot be faked by a fixture number.
 *
 * R95 — the measurement went red on the first week that was BOTH current and
 * mostly graded: the outcome buckets and the P&L line only exist once a week
 * HAS grades, so the R90 number was measured on a layout those two blocks were
 * not in. They now share one collapsed <details id="parlay-retro">. The 24 px
 * floor below stays exactly as it was — it is a real regression tripwire — but
 * the promise it stands for is now also locked directly, against the committed
 * review document rather than against a remembered pixel count.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const POOL = read('../../data/leg_pool.json');
const REVIEW = read('../../data/review.json');
const PARLAYS = read('../../data/parlays.json');
const PARLAY_INDEX = read('../../data/parlays/index.json');
const WEEKLY = read('../../data/player_weekly.json');
const PROJ = read('../../data/player_projections.json');

const PHONE = { width: 402, height: 874 };
const DESKTOP = { width: 1280, height: 900 };

/* A committed player the pool does NOT price and the weekly feed marks not
 * playable — derived, never hardcoded, so this stays true as the season moves.
 * Falls back to a TE (an excluded position) if a week ever has no such player. */
const POOLED = new Set(POOL.players.map((p) => String(p.gsis_id)));
const NOT_PLAYABLE = (() => {
  const byId = new Map(PROJ.players.map((p) => [String(p.gsis_id), p]));
  for (const row of WEEKLY.players) {
    if (!row.this_week || row.this_week.playable !== false) continue;
    if (POOLED.has(String(row.gsis_id))) continue;
    const id = byId.get(String(row.gsis_id));
    if (id && id.name) return { name: id.name, team: id.team, position: id.position, kind: 'weekly' };
  }
  const te = PROJ.players.find((p) => p.position === 'TE' && !POOLED.has(String(p.gsis_id)));
  return te ? { name: te.name, team: te.team, position: te.position, kind: 'position' } : null;
})();

const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

async function mount(page) {
  await page.goto('/#/parlays');
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
}

/* Mount, then stand on a week that HAS grades.
 *
 * Between the Monday night game and Thursday's kickoff the current week is the
 * one the pipeline has rolled to and not one of its games has been played, so
 * the RETROSPECTIVE panel is correctly absent — the sibling test above locks
 * exactly that. Reading the graded chrome off the CURRENT week therefore reds
 * every Tuesday and Wednesday of the season on data that is entirely right.
 * The week chip is the product's own way to stand on a closed week, so these
 * tests use it, and the week is DERIVED: the newest one the committed index
 * carries with grades on it, which from week 1 on is never empty. */
async function selectWeek(page, week) {
  if (String(week) === String(PARLAYS.week)) return;
  await page.click(`.pw-wkbar .wk-chip[data-wk="${week}"]`);
  await page.waitForSelector(`.pw-wkbar .wk-chip[data-wk="${week}"][aria-pressed="true"]`,
    { timeout: 20000 });
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
}

async function mountGraded(page) {
  await mount(page);
  await selectWeek(page, GRADED_WEEK);
}

/** The measurement F18 is about: first card's top vs the bottom nav's top. */
const firstCardTop = (page) => page.evaluate(() => {
  const card = document.querySelector('#parlays-list .card.parlay');
  const bar = document.querySelector('.tabbar');
  return {
    cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
    innerHeight: window.innerHeight,
  };
});

/* ==========================================================================
   F18 · a real bet is on the first screen
   ========================================================================== */

test('F18: at 402x874 the first parlay card starts above the bottom navigation', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize(PHONE);
  await mount(page);
  const m = await firstCardTop(page);
  expect(m.cardTop, 'a card must be painted').not.toBeNull();
  expect(m.barTop, 'the bottom navigation must be painted').not.toBeNull();
  // The whole of F18 in one line: the measured 1,217 px was ~400 px below the
  // bar; a card must now START inside the opening viewport.
  expect(m.cardTop).toBeLessThan(m.barTop);
  // ...and enough of it to read, not a one-pixel sliver of its top border.
  // Measured 84px in the sandbox (733 vs 817) and 49px on the CI runner, whose
  // fallback fonts set every line taller; the floor is one readable header
  // line, not a number that depends on which fonts the machine happens to have.
  expect(m.barTop - m.cardTop).toBeGreaterThan(24);
  expect(errors).toEqual([]);
});

test('F18: the glossary is collapsed by default and still says everything it said', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mount(page);
  const legend = page.locator('.legend--parlays');
  await expect(legend).toHaveCount(1);
  expect(await legend.evaluate((d) => d.open)).toBe(false);
  // Closed is not deleted: every term is still in the document for a reader
  // and for a screen reader.
  for (const term of ['LEG', 'MODEL', 'IMPL', 'SIM EV', 'TIER', '$100 SIM NET']) {
    await expect(legend).toContainText(term);
  }
  await legend.locator('summary').click();
  expect(await legend.evaluate((d) => d.open)).toBe(true);
  await expect(legend.locator('.legend-body')).toBeVisible();
});

test('F18: every consolidated control is still reachable, and the shut summary says what is on', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize(PHONE);
  await mount(page);
  const panel = page.locator('#parlay-filters');
  await expect(panel).toHaveCount(1);
  expect(await panel.evaluate((d) => d.open)).toBe(false);
  await expect(panel.locator('.pf-sum-t')).toHaveText('FILTERS · ALL');
  await expect(panel.locator('.pf-sum-n')).toBeHidden();
  // nothing inside is reachable until it is opened — that is the 3 rows it buys
  await expect(page.locator('#leg-controls')).toBeHidden();

  await panel.locator('summary').click();
  await expect(page.locator('#leg-controls .leg-chip').first()).toBeVisible();
  await expect(page.locator('#tier-controls .leg-chip').first()).toBeVisible();
  await expect(page.locator('#sort-controls .leg-chip').first()).toBeVisible();

  // WEEK scope, so the leg-count buckets are the interesting ones
  await page.click('.scopeseg [data-seg="week"]');
  await page.waitForSelector('#leg-controls .leg-chip[data-leg="3"]', { timeout: 10000 });
  await page.click('#leg-controls .leg-chip[data-leg="3"]');
  await expect(panel.locator('.pf-sum-t')).toHaveText('FILTERS · 3 LEGS');
  await expect(panel.locator('.pf-sum-n')).toHaveText('1');
  const legCounts = await page.locator('#parlays-list .card.parlay').evaluateAll(
    (els) => els.map((e) => e.querySelectorAll('.legs > .leg').length));
  expect(legCounts.length).toBeGreaterThan(0);
  for (const n of legCounts) expect(n).toBe(3);

  // a tier present in this scope (the chips never offer an empty bucket)
  const tier = await page.locator('#tier-controls .leg-chip').evaluateAll(
    (els) => els.map((e) => e.dataset.tier).filter((t) => t && t !== 'all'));
  expect(tier.length).toBeGreaterThan(0);
  await page.click(`#tier-controls [data-tier="${tier[tier.length - 1]}"]`);
  await expect(panel.locator('.pf-sum-t'))
    .toHaveText(`FILTERS · 3 LEGS · ${tier[tier.length - 1].toUpperCase()}`);
  await expect(panel.locator('.pf-sum-n')).toHaveText('2');

  await page.click('#sort-controls [data-sort="ev"]');
  await expect(panel.locator('.pf-sum-t'))
    .toContainText(`FILTERS · 3 LEGS · ${tier[tier.length - 1].toUpperCase()} · SIM EV`);
  await expect(panel.locator('.pf-sum-n')).toHaveText('3');

  // ...and the state survives the panel being shut again, which is the point
  await panel.locator('summary').click();
  expect(await panel.evaluate((d) => d.open)).toBe(false);
  await expect(panel.locator('.pf-sum-t')).toContainText('3 LEGS');
  expect(errors).toEqual([]);
});

test('F18: the FILTERS panel remembers itself per viewer, and defaults shut', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mount(page);
  await page.locator('#parlay-filters summary').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nfl2026.parlays.filters.v1')))
    .toBe('1');
  await page.reload();
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  expect(await page.locator('#parlay-filters').evaluate((d) => d.open)).toBe(true);
  await page.locator('#parlay-filters summary').click();
  // <details> fires `toggle` as a queued task, so the write is asserted before
  // the reload rather than raced against it.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nfl2026.parlays.filters.v1')))
    .toBe('0');
  await page.reload();
  await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
  expect(await page.locator('#parlay-filters').evaluate((d) => d.open)).toBe(false);
});

test('F18: every collapsed summary is a 44 px target and nothing overflows sideways', async ({ page }) => {
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    // #parlay-retro is one of the three rows under test and only exists on a
    // graded week — see selectWeek.
    await mountGraded(page);
    // HIG: the rows R90 introduced are full-width 44 px targets.
    for (const sel of ['#parlay-filters > summary', '.legend--parlays > summary',
      '#parlay-retro > summary']) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} at ${size.width}`).not.toBeNull();
      // Math.round: at deviceScaleFactor 3 a 44 px box lays out as 43.9607 CSS px
      // (132 device pixels). The target is 44, the snap is the renderer's.
      expect(Math.round(box.height), `${sel} height at ${size.width}`).toBeGreaterThanOrEqual(44);
    }
    // No horizontal page scroll at either width (the .wkbar is the only
    // horizontal scroller and it is its own overflow context).
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `horizontal overflow at ${size.width}`).toBeLessThanOrEqual(1);
    // and a card is still on the first screen on the desktop width too
    const m = await firstCardTop(page);
    expect(m.cardTop, `first card at ${size.width}`).toBeLessThan(m.barTop);
  }
});

test('F18: an ungraded week hides the outcome buckets and the P&L line entirely', async ({ page }) => {
  const errors = errorsOf(page);
  // Every parlay row pending, every bucket count pending, nothing staked: an
  // entirely upcoming week. Zero chips over a blank line would be a
  // measurement nobody made, so there must be no chips and no line.
  await page.route('**/data/review.json', async (route) => {
    const doc = await (await route.fetch()).json();
    for (const week of Object.values(doc.weeks)) {
      const rows = week.parlays || [];
      rows.forEach((row) => {
        row.result = 'pending';
        row.bucket = 'pending';
        (row.legs || []).forEach((l) => { l.result = 'pending'; });
      });
      const p = week.summary && week.summary.parlays;
      if (!p) continue;
      p.buckets = { all_hit: 0, push: 0, partial: 0, all_missed: 0, pending: rows.length };
      for (const scope of ['game', 'week']) {
        if (p.stake_100 && p.stake_100[scope]) {
          Object.assign(p.stake_100[scope], { graded: 0, hit: 0, push: 0, staked: 0, net_fair: 0 });
        }
      }
    }
    await route.fulfill({ json: doc });
  });
  await page.setViewportSize(PHONE);
  await mount(page);
  await page.waitForSelector('.rv-strip--parlay', { timeout: 20000 });
  await expect(page.locator('#parlay-buckets')).toBeHidden();
  await expect(page.locator('#parlay-pnl')).toBeHidden();
  // R95 — those two now live inside a collapsed <details>, which would hide
  // them on ANY week, so the rule is asserted where it is actually decided: the
  // panel itself carries `hidden` on an ungraded week and paints no surface.
  await expect(page.locator('#parlay-retro')).toBeHidden();
  expect(await page.locator('#parlay-retro').evaluate((d) => d.hidden)).toBe(true);
  // the cards themselves are untouched — hiding a tally is not hiding the bets
  expect(await page.locator('#parlays-list .card.parlay').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('F18: a graded week still shows both, so the rule is the data and not the layout', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountGraded(page);
  // R95 — the rule is still the data: on a graded week the RETROSPECTIVE panel
  // is painted (an ungraded week hides it outright), and both blocks are one
  // tap inside it. Nothing about what they say changed.
  const retro = page.locator('#parlay-retro');
  await expect(retro).toBeVisible();
  expect(await retro.evaluate((d) => d.open)).toBe(false);
  await retro.locator('summary').click();
  await page.waitForSelector('#parlay-buckets .rv-bucket', { timeout: 20000 });
  await expect(page.locator('#parlay-buckets')).toBeVisible();
  await expect(page.locator('#parlay-pnl .rv-pnl')).toBeVisible();
});

/* --------------------------------------------------------------------------
   R95 · the promise itself, not a remembered number.
   The 24 px floor above was measured on one machine's fonts and says so. These
   two lock what the owner actually asked for, read off the COMMITTED review
   document: on a week that has been graded — the state that broke F18, because
   the outcome buckets and the P&L line only exist once a week has grades — a
   real bet is legible on the opening screen, and nothing the collapse hid has
   become unreachable.
   -------------------------------------------------------------------------- */

const GRADED_BUCKETS = ['all_hit', 'push', 'partial', 'all_missed'];
const CUR_WEEK = String(PARLAYS.week);
const bucketsOf = (wk) => ((((REVIEW.weeks || {})[String(wk)] || {}).summary || {}).parlays || {})
  .buckets || {};
const gradedIn = (wk) => GRADED_BUCKETS.reduce((n, b) => n + (Number(bucketsOf(wk)[b]) || 0), 0);
/* The newest week at or before the current one that the committed index carries
 * AND the committed review has graded. Derived, never pinned: see selectWeek. */
const GRADED_WEEK = String((PARLAY_INDEX.weeks || []).map((w) => Number(w.week))
  .filter((w) => w <= Number(CUR_WEEK) && gradedIn(w) > 0)
  .sort((a, b) => b - a)[0] ?? CUR_WEEK);
const CUR_BUCKETS = bucketsOf(GRADED_WEEK);
const CUR_GRADED = gradedIn(GRADED_WEEK);

test('F18: on the committed graded week the first card is legible on the opening screen', async ({ page }) => {
  const errors = errorsOf(page);
  // Asserted, never skipped: if the current week carried no grades the graded
  // chrome would not render and this would be measuring a different layout than
  // the one F18 broke on. The committed feed IS in that state, and this line is
  // what says so out loud when a future week is not.
  expect(CUR_GRADED, `data/review.json week ${GRADED_WEEK} must have graded parlays`)
    .toBeGreaterThan(0);

  await page.setViewportSize(PHONE);
  await mountGraded(page);
  // the graded chrome really is on the page — this is the stack that broke F18
  await expect(page.locator('#parlay-retro')).toBeVisible();
  await expect(page.locator('.rv-strip--parlay')).toBeVisible();

  const m = await page.evaluate(() => {
    const card = document.querySelector('#parlays-list .card.parlay');
    const head = card && card.querySelector('.p-head');
    const bar = document.querySelector('.tabbar');
    return {
      headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : null,
      barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
      innerHeight: window.innerHeight,
    };
  });
  expect(m.headBottom, 'the first card must paint a header').not.toBeNull();
  expect(m.barTop, 'the bottom navigation must be painted').not.toBeNull();
  // The whole of the first bet's HEADER — which game, which tier, which result
  // — clears the bottom navigation. That is a box the page itself renders, so
  // it holds whatever the machine's fonts do to the line height; "a real bet is
  // on the first screen" is not satisfied by a visible top border.
  expect(m.headBottom).toBeLessThanOrEqual(m.barTop);
  await expect(page.locator('#parlays-list .card.parlay').first()).toBeInViewport();
  expect(errors).toEqual([]);
});

test('F18: the collapsed retrospective still carries every bucket count, and opens', async ({ page }) => {
  const errors = errorsOf(page);
  expect(CUR_GRADED).toBeGreaterThan(0);
  await page.setViewportSize(PHONE);
  await mountGraded(page);
  const retro = page.locator('#parlay-retro');
  await expect(retro).toBeVisible();
  expect(await retro.evaluate((d) => d.open)).toBe(false);
  await expect(retro.locator('.pf-sum-t')).toHaveText('OUTCOMES & SIM NET · ALL');
  await expect(retro.locator('.pf-sum-n')).toBeHidden();

  // Closed is not deleted. Every count the committed review carries is still in
  // the document — for a reader and for a screen reader — and so is the P&L
  // line's own wording, which this change was not allowed to touch.
  await page.waitForSelector('#parlay-buckets .rv-bucket', { state: 'attached', timeout: 20000 });
  const counts = Object.entries(CUR_BUCKETS);
  expect(counts.length).toBeGreaterThan(0);
  for (const [b, n] of counts) {
    await expect(retro.locator(`.rv-bucket[data-bucket="${b}"] .rv-bucket-n`)).toHaveText(String(n));
  }
  await expect(retro).toContainText(`WEEK ${GRADED_WEEK}`);
  await expect(retro).toContainText('SIM NET');
  await expect(retro).toContainText('not actual betting returns');
  // ...and none of it is reachable until it is opened — that is the space it buys
  await expect(page.locator('#parlay-buckets')).toBeHidden();
  await expect(page.locator('#parlay-pnl')).toBeHidden();

  // A FILTER may be collapsed, but it may not become undiscoverable: opening it
  // filters the list, and the shut summary then names the bucket that is on.
  await retro.locator('summary').click();
  await expect(page.locator('.rv-bucket[data-bucket="all_hit"]')).toBeVisible();
  const cards = page.locator('#parlays-list .card.parlay');
  const before = await cards.count();
  expect(before).toBeGreaterThan(0);
  await page.click('.rv-bucket[data-bucket="all_hit"]');
  await expect(page.locator('.rv-bucket[data-bucket="all_hit"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parlays-list .card.parlay .rv-bchip:not(.rv-bchip--all_hit)')).toHaveCount(0);
  expect(await cards.count()).toBeLessThan(before);
  await retro.locator('summary').click();
  expect(await retro.evaluate((d) => d.open)).toBe(false);
  await expect(retro.locator('.pf-sum-t')).toHaveText('OUTCOMES & SIM NET · ALL HIT');
  await expect(retro.locator('.pf-sum-n')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('F18: the RETROSPECTIVE panel remembers itself per viewer, and defaults shut', async ({ page }) => {
  // A reload lands on the current week again, so the graded week is re-selected
  // after each one: the thing under test is the REMEMBERED open state, which
  // must survive a reload wherever the panel is painted.
  const reloadGraded = async () => {
    await page.reload();
    await page.waitForSelector('#parlays-list .card.parlay', { timeout: 20000 });
    await selectWeek(page, GRADED_WEEK);
  };
  await page.setViewportSize(PHONE);
  await mountGraded(page);
  await expect(page.locator('#parlay-retro')).toBeVisible();
  await page.locator('#parlay-retro summary').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nfl2026.parlays.retro.v1')))
    .toBe('1');
  await reloadGraded();
  await expect(page.locator('#parlay-retro')).toBeVisible();
  expect(await page.locator('#parlay-retro').evaluate((d) => d.open)).toBe(true);
  await page.locator('#parlay-retro summary').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nfl2026.parlays.retro.v1')))
    .toBe('0');
  await reloadGraded();
  await expect(page.locator('#parlay-retro')).toBeVisible();
  expect(await page.locator('#parlay-retro').evaluate((d) => d.open)).toBe(false);
});

/* ==========================================================================
   F20 · grouped buttons, not half a tab widget
   ========================================================================== */

test('F20: the week bar and the scope segment are groups of aria-pressed buttons', async ({ page }) => {
  await mount(page);
  for (const sel of ['.pw-wkbar', '.scopeseg']) {
    const bar = page.locator(sel);
    if (await bar.count() === 0) continue;   // no index -> no week chips
    await expect(bar).toHaveAttribute('role', 'group');
    await expect(bar).toHaveAttribute('aria-label', /.+/);
  }
  // not one tab role, and not one aria-selected, anywhere in the view
  expect(await page.locator('#view [role="tab"], #view [role="tablist"]').count()).toBe(0);
  expect(await page.locator('.pw-wkbar [aria-selected], .scopeseg [aria-selected]').count()).toBe(0);
  // exactly one pressed chip in each group
  await expect(page.locator('.scopeseg [aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('.scopeseg [data-seg="game"]')).toHaveAttribute('aria-pressed', 'true');
  if (await page.locator('.pw-wkbar .wk-chip').count()) {
    await expect(page.locator('.pw-wkbar [aria-pressed="true"]')).toHaveCount(1);
  }
});

test('F20: Left/Right move focus and selection inside the scope group', async ({ page }) => {
  const errors = errorsOf(page);
  await mount(page);
  await page.locator('.scopeseg [data-seg="game"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.scopeseg [data-seg="week"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.activeElement.dataset.seg)).toBe('week');
  await page.waitForFunction(
    () => !!document.querySelector('#parlays-list .card.parlay[data-scope="week"]'), null,
    { timeout: 10000 });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.scopeseg [data-seg="game"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.activeElement.dataset.seg)).toBe('game');
  expect(errors).toEqual([]);
});

test('F20: Left/Right move focus and selection inside the week group', async ({ page }) => {
  await mount(page);
  const chips = page.locator('.pw-wkbar .wk-chip');
  const n = await chips.count();
  test.skip(n < 2, 'the archive index lists only one week');
  await chips.first().focus();
  const firstWk = await chips.first().getAttribute('data-wk');
  await page.keyboard.press('ArrowRight');
  const nextWk = await chips.nth(1).getAttribute('data-wk');
  expect(await page.evaluate(() => document.activeElement.dataset.wk)).toBe(nextWk);
  await expect(page.locator(`.pw-wkbar [data-wk="${nextWk}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.pw-wkbar [data-wk="${firstWk}"]`)).toHaveAttribute('aria-pressed', 'false');
});

/* ==========================================================================
   F19 · MY accepts what it asks for, and a miss says why
   ========================================================================== */

async function openMy(page) {
  await mount(page);
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
}

test('F19: the comma-separated example the field prints adds one seed per part', async ({ page }) => {
  const errors = errorsOf(page);
  await openMy(page);
  const placeholder = await page.locator('#mp-input').getAttribute('placeholder');
  // the literal example, minus the "e.g. " lead-in — typed verbatim
  const typed = placeholder.replace(/^e\.g\.\s*/i, '');
  const parts = typed.split(',').map((s) => s.trim()).filter(Boolean);
  expect(parts.length).toBeGreaterThan(1);
  await page.fill('#mp-input', typed);
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(parts.length);
  // nothing is left behind in the box, because nothing failed to resolve
  await expect(page.locator('#mp-input')).toHaveValue('');
  await page.waitForSelector('#mp-list .mp-card, #mp-list .state', { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('F19: "J. Jefferson, KC" resolves both halves the same way', async ({ page }) => {
  const errors = errorsOf(page);
  await openMy(page);
  await page.fill('#mp-input', 'J. Jefferson, KC');
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(2);
  await expect(page.locator('#mp-seeds')).toContainText('Justin Jefferson');
  await expect(page.locator('#mp-seeds')).toContainText('KC');
  expect(errors).toEqual([]);
});

test('F19: a player the pool cannot price is named with the reason, and the text is kept', async ({ page }) => {
  const errors = errorsOf(page);
  test.skip(!NOT_PLAYABLE, 'no unpooled player on file this week');
  await openMy(page);
  await page.fill('#mp-input', NOT_PLAYABLE.name);
  const row = page.locator('.mp-opt--none');
  await expect(row).toHaveCount(1);
  // the reason arrives from the lazily loaded weekly/projection join
  await expect(row).toContainText('is not offered:', { timeout: 20000 });
  await expect(row).toContainText(NOT_PLAYABLE.name);
  await expect(row).toContainText(NOT_PLAYABLE.team);
  await expect(row).toContainText(NOT_PLAYABLE.position);
  await expect(row).toContainText(NOT_PLAYABLE.kind === 'weekly'
    ? 'not playable this week' : 'no calibrated market');
  // the typed text is never cleared out from under the viewer
  await expect(page.locator('#mp-input')).toHaveValue(NOT_PLAYABLE.name);
  await page.press('#mp-input', 'Enter');
  await expect(page.locator('#mp-input')).toHaveValue(NOT_PLAYABLE.name);
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F19: a name on file nowhere says exactly that, and invents nothing', async ({ page }) => {
  const errors = errorsOf(page);
  await openMy(page);
  await page.fill('#mp-input', 'Nobody Whatsoever');
  const row = page.locator('.mp-opt--none');
  await expect(row).toContainText('no player or team by that name', { timeout: 20000 });
  await expect(page.locator('#mp-seeds .leg-chip')).toHaveCount(0);
  await expect(page.locator('.mp-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F19: the MY legend states ANY seed, not all of them', async ({ page }) => {
  await openMy(page);
  await expect(page.locator('#mp-note'))
    .toContainText('Every card contains AT LEAST ONE of your seeds, not all of them');
});

test('F19: data/player_weekly.json is fetched only after a MY tap, never on a cold load', async ({ page }) => {
  const got = [];
  page.on('request', (r) => { if (r.url().includes('/data/')) got.push(r.url().split('/data/')[1].split('?')[0]); });
  await mount(page);
  await page.waitForTimeout(600);
  expect(got.filter((f) => f === 'player_weekly.json')).toEqual([]);
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.waitForTimeout(400);
  // still nothing: the join is paid for by a MISS, not by opening the tab
  expect(got.filter((f) => f === 'player_weekly.json')).toEqual([]);
  await page.fill('#mp-input', 'Nobody Whatsoever');
  await expect(page.locator('.mp-opt--none')).toContainText('no player or team by that name',
    { timeout: 20000 });
  expect(got.filter((f) => f === 'player_weekly.json').length).toBe(1);
});
