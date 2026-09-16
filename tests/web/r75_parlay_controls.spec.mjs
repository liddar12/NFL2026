/* tests/web/r75_parlay_controls.spec.mjs — R75 PARLAYS tier filter, sort control
 * and the per-card $100 figure, in the browser (project `web`).
 *
 * Unlike the r71/r72/r73 specs this one routes NOTHING: it drives the view over
 * the COMMITTED data/parlays.json, data/parlays/*, data/review.json exactly as
 * production serves them, and derives every expectation from those same files.
 * That is deliberate. The money invariant this file exists to protect — the
 * settled cards of a scope summing to that scope's footer — is only worth
 * anything against real prices and real outcomes; a fixture would let the two
 * agree on numbers the pipeline never produces. Deriving (never hardcoding) the
 * expectations is what keeps it from going red, or silently toothless, as the
 * season moves: the in-season drift the red-main repair was about.
 *
 * Proves: tier chips offer only the tiers present and filter to one; the sort
 * control re-orders by MODEL EV and by the $100 figure (and the $100 chip stays
 * hidden until the money is readable); every card carries a figure that equals
 * the builder's to the cent; a quote and a result are labelled differently; and
 * on a graded week the visible settled cards sum to the P&L line below them.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const PARLAYS = read('../../data/parlays.json');
const INDEX = read('../../data/parlays/index.json');
const REVIEW = read('../../data/review.json');

const CUR = Number(PARLAYS.week);
const TIER_ORDER = ['high', 'medium', 'low'];
// the newest CLOSED week in the archive — the one with graded parlays to sum
const PAST = (INDEX.weeks || []).filter((w) => w.closed && Number(w.week) !== CUR)
  .map((w) => Number(w.week)).sort((a, b) => b - a)[0];

const moneyRows = (week) => Object.fromEntries(
  ((REVIEW.weeks?.[String(week)]?.parlays) || []).map((p) => [String(p.parlay_id), p]));
const footer = (week, scope) => REVIEW.weeks?.[String(week)]?.summary?.parlays?.stake_100?.[scope];

const tiersPresent = (parlays, scope) => TIER_ORDER.filter((t) => parlays
  .some((p) => (p.scope === 'week' ? 'week' : 'game') === scope
    && String(p.confidence_tier).toLowerCase() === t));

/** Every painted card as {id, tier, pay, kind}. */
const cards = (page) => page.locator('.card.parlay').evaluateAll((els) => els.map((e) => ({
  id: e.dataset.parlayId,
  tier: (e.querySelector('.tier')?.textContent || '').trim().toLowerCase(),
  pay: e.dataset.rvPay === undefined ? null : Number(e.dataset.rvPay),
  kind: e.dataset.rvPayKind || null,
  payText: (e.querySelector('.pay')?.textContent || '').trim(),
})));

const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

/** Mount the view and wait until app/review.js has stamped the money. */
async function mount(page) {
  await page.goto('/#/parlays');
  await page.waitForSelector('.card.parlay', { timeout: 20000 });
  await page.waitForSelector('#sort-controls [data-sort="pay"]', { timeout: 20000 });
}

test.describe('R75 — PARLAYS tier filter, sort and the $100 figure', () => {
  test('tier chips offer only the tiers present and filter to one', async ({ page }) => {
    const errors = errorsOf(page);
    await mount(page);
    const expected = tiersPresent(PARLAYS.parlays, 'game'); // GAME is the default scope
    expect(expected.length).toBeGreaterThan(0);
    const chips = await page.locator('#tier-controls .leg-chip').evaluateAll(
      (els) => els.map((e) => e.dataset.tier));
    expect(chips).toEqual(['all', ...expected]);
    for (const absent of TIER_ORDER.filter((t) => !expected.includes(t))) {
      expect(chips).not.toContain(absent);   // never an empty bucket
    }
    // filtering to a tier leaves only that tier on screen, and fewer cards
    const before = (await cards(page)).length;
    const pick = expected[expected.length - 1];   // the tier with the most cards
    await page.click(`#tier-controls [data-tier="${pick}"]`);
    const after = await cards(page);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.tier === pick)).toBe(true);
    const all = PARLAYS.parlays.filter((p) => p.scope !== 'week');
    expect(after.length).toBe(all.filter((p) =>
      String(p.confidence_tier).toLowerCase() === pick).length);
    if (expected.length > 1) expect(after.length).toBeLessThan(before);
    // ALL puts them back
    await page.click('#tier-controls [data-tier="all"]');
    expect((await cards(page)).length).toBe(before);
    expect(errors).toEqual([]);
  });

  test('the sort control orders by MODEL EV and by the $100 figure', async ({ page }) => {
    const errors = errorsOf(page);
    await mount(page);
    const evById = Object.fromEntries(PARLAYS.parlays.map((p) => [p.parlay_id, p.model_ev]));

    // SLATE is the default: the document's own order, untouched. Enabling a
    // sort must not silently reorder the page for someone who never asked.
    await expect(page.locator('#sort-controls [data-sort="slate"]')).toHaveAttribute('aria-pressed', 'true');
    const feedOrder = PARLAYS.parlays.filter((p) => p.scope !== 'week').map((p) => p.parlay_id);
    expect((await cards(page)).map((c) => c.id)).toEqual(feedOrder);

    // MODEL EV sorts, and the feed was NOT already in that order
    await page.click('#sort-controls [data-sort="ev"]');
    const evs = (await cards(page)).map((c) => evById[c.id]);
    expect(evs.length).toBeGreaterThan(1);
    for (let i = 1; i < evs.length; i += 1) expect(evs[i]).toBeLessThanOrEqual(evs[i - 1]);
    expect((await cards(page)).map((c) => c.id)).not.toEqual(feedOrder);

    // $100 sorts the number the cards actually show
    await page.click('#sort-controls [data-sort="pay"]');
    const byPay = await cards(page);
    expect(byPay.every((c) => c.pay !== null)).toBe(true);
    for (let i = 1; i < byPay.length; i += 1) {
      expect(byPay[i].pay).toBeLessThanOrEqual(byPay[i - 1].pay);
    }
    // ... and it is a DIFFERENT order from EV, or the chip would be decoration
    expect(byPay.map((c) => c.id)).not.toEqual((await (async () => {
      await page.click('#sort-controls [data-sort="ev"]');
      return (await cards(page)).map((c) => c.id);
    })()));

    // LEGS ascends
    await page.click('#sort-controls [data-sort="legs"]');
    const legCounts = await page.locator('.card.parlay').evaluateAll(
      (els) => els.map((e) => e.querySelectorAll('.legs > .leg').length));
    for (let i = 1; i < legCounts.length; i += 1) {
      expect(legCounts[i]).toBeGreaterThanOrEqual(legCounts[i - 1]);
    }
    expect(errors).toEqual([]);
  });

  test('every card quotes the builder\'s money, to the cent, labelled for what it is', async ({ page }) => {
    const errors = errorsOf(page);
    await mount(page);
    const rows = moneyRows(CUR);
    expect(Object.keys(rows).length).toBeGreaterThan(0);
    for (const c of await cards(page)) {
      const row = rows[c.id];
      expect(row, `no review row for ${c.id}`).toBeTruthy();
      expect(c.pay).toBeCloseTo(row.money.net_fair, 2);   // the card never re-prices
      expect(c.kind).toBe(row.money.kind);
      expect(c.payText).toContain(row.money.kind === 'settled' ? '$100 RETURNED' : '$100 PAYS');
    }
    // the legend says what the figures are, and that they are display only
    await expect(page.locator('.legend')).toContainText('$100 PAYS');
    await expect(page.locator('.legend')).toContainText('never a model input');
    expect(errors).toEqual([]);
  });

  test('on a graded week the visible settled cards sum to the P&L line below them', async ({ page }) => {
    test.skip(!PAST, 'no closed week in the archive yet');
    const errors = errorsOf(page);
    await mount(page);
    await page.click(`.pw-wkbar .wk-chip[data-wk="${PAST}"]`);
    await page.waitForSelector('.view-sub .pw-archived', { timeout: 20000 });
    await page.waitForFunction(() => !!document.querySelector('.card.parlay[data-rv-pay]'), null,
      { timeout: 20000 });

    for (const scope of ['game', 'week']) {
      await page.click(`.scopeseg [data-seg="${scope}"]`);
      await page.waitForFunction(
        (s) => document.querySelector(`.card.parlay[data-scope="${s}"]`) !== null, scope,
        { timeout: 20000 });
      const f = footer(PAST, scope);
      if (!f || !f.graded) continue;
      const shown = (await cards(page)).filter((c) => c.kind === 'settled');
      expect(shown.length).toBe(f.graded);
      const sum = shown.reduce((t, c) => t + c.pay, 0);
      // per-card figures are rounded to the cent; never off by a dollar
      expect(Math.abs(sum - f.net_fair)).toBeLessThanOrEqual(0.01 * shown.length);
      // and a settled card reads as a result, never as a quote
      expect(shown.every((c) => c.payText.includes('$100 RETURNED'))).toBe(true);
      // the P&L line below is the same money
      await expect(page.locator('#parlay-pnl .rv-pnl-line')).toContainText(`WEEK ${PAST}`);
    }
    expect(errors).toEqual([]);
  });
});
