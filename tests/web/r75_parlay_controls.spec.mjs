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

// Independent oracle: use the original card's comparison prices, never the legacy -110 money.
for (const [week, block] of Object.entries(REVIEW.weeks)) {
  // The review carries a block for the current PIPELINE week too (games only, no
  // parlays yet, no archive file) — the oracle only has cards to check where the
  // archive index has a week (2026-09-18: week 3 appeared, wk03.json did not).
  const archived = (INDEX.weeks || []).some((w) => Number(w.week) === Number(week));
  if (Number(week) !== CUR && !archived) continue;
  const cards = Number(week) === CUR ? PARLAYS.parlays
    : read(`../../data/parlays/${PARLAYS.season}_wk${String(week).padStart(2, '0')}.json`).parlays;
  // R93 — join the oracle the way app/review.js joins: card_id first, parlay_id
  // only as the pre-R93 fallback. A re-run re-ids a card ("401872933-g1" ->
  // "401872933-g1~e9d2a3") and BOTH forms sit in the archive, so a parlay_id
  // lookup silently returns the superseded card and prices the wrong legs — the
  // week-2 archive made that a $414.64 disagreement with the page.
  const byCard = new Map(cards.filter((c) => c.card_id).map((c) => [String(c.card_id), c]));
  for (const row of block.parlays) {
    const card = (row.card_id && byCard.get(String(row.card_id)))
      || cards.find((p) => p.parlay_id === row.parlay_id);
    const settled = row.bucket !== 'pending';
    const decimal = card.legs.reduce((d, leg) => {
      const result = row.legs.find((l) => l.market === leg.market && l.selection === leg.selection)?.result;
      return d * (result === 'void' ? 1 : 1 / leg.implied_prob);
    }, 1);
    row.money = { kind: settled ? 'settled' : 'potential', net_fair:
      settled && row.legs.some((l) => l.result === 'miss') ? -100 : Math.round(10000 * (decimal - 1)) / 100 };
  }
  for (const scope of ['game', 'week']) {
    const rows = block.parlays.filter((p) => p.scope === scope && p.money.kind === 'settled');
    block.summary.parlays.stake_100[scope].net_fair = rows.reduce((s, p) => s + p.money.net_fair, 0);
  }
}

const moneyRows = (week) => Object.fromEntries(
  ((REVIEW.weeks?.[String(week)]?.parlays) || []).map((p) => [String(p.parlay_id), p]));
const footer = (week, scope) => REVIEW.weeks?.[String(week)]?.summary?.parlays?.stake_100?.[scope];

const tiersPresent = (parlays, scope) => TIER_ORDER.filter((t) => parlays
  .some((p) => (p.scope === 'week' ? 'week' : 'game') === scope
    && String(p.confidence_tier).toLowerCase() === t));

/** Every painted card as {id, tier, pay, kind}. */
const cards = (page) => page.locator('.card.parlay').evaluateAll((els) => els.map((e) => ({
  id: e.dataset.parlayId,
  tier: (e.querySelector('.tier')?.textContent || '').trim().toLowerCase().replace(/^sim /, ''),
  pay: e.dataset.rvPay === undefined ? null : Number(e.dataset.rvPay),
  kind: e.dataset.rvPayKind || null,
  payText: (e.querySelector('.pay')?.textContent || '').trim(),
})));

const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

/** Mount the view and wait until app/review.js has stamped the money. */
async function mount(page) {
  await page.goto('/#/parlays');
  await page.waitForSelector('.card.parlay', { timeout: 20000 });
  // R90 — the tier and sort chips live inside the collapsed FILTERS panel; this
  // file drives them, so it opens the panel the way a viewer would.
  await page.waitForSelector('#parlay-filters', { timeout: 20000 });
  await page.evaluate(() => { const d = document.querySelector('#parlay-filters'); if (d) d.open = true; });
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
      expect(c.payText).toContain(row.money.kind === 'settled' ? '$100 SIM NET · GRADED' : '$100 SIM NET · IF HIT');
    }
    // the legend says what the figures are, and that they are display only
    await expect(page.locator('.legend')).toContainText('$100 SIM NET');
    await expect(page.locator('.legend')).toContainText('never a model input');
    expect(errors).toEqual([]);
  });

  /* G03 (R87-R91 review) — the review row reaches its card by IDENTITY (card_id)
   * first and by the rank-derived parlay_id only as the fallback for a review
   * document written before its rows carried card_id. Three documents for the
   * same closed week must paint the same money: the committed one, one with
   * every card_id stripped (the fallback), and one whose rows carry only the
   * archive's card_id under a parlay_id no card has (identity alone). */
  test('G03: the $100 figure joins by card_id, and still by parlay_id for a pre-R93 review document', async ({ browser }) => {
    test.skip(!PAST, 'no closed week in the archive yet');
    const base = JSON.parse(JSON.stringify(REVIEW));
    const rows = base.weeks[String(PAST)].parlays;
    // The row's OWN card_id is the identity under test. It used to be re-derived
    // from the archive by parlay_id, which stopped being a function the week a
    // re-run put both "401872933-g1" and "401872933-g1~e9d2a3" in the same file:
    // that lookup then handed back the SUPERSEDED card's id and the join landed
    // nowhere. Keep the committed card_id, destroy only the rank id.
    const identity = JSON.parse(JSON.stringify(base));
    identity.weeks[String(PAST)].parlays.forEach((r, i) => {
      r.parlay_id = `no-such-rank-${i}`;
    });
    expect(identity.weeks[String(PAST)].parlays.every((r) => r.card_id)).toBe(true);
    // One fresh context per document: a second goto to the same hash URL does
    // not remount the view, so each document gets its own page and storage.
    const errors = [];
    const paid = async (doc, wk) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.on('pageerror', (x) => errors.push(String(x)));
      try {
        await page.route('**/data/review.json', (r) => r.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify(doc) }));
        await mount(page);
        await page.click(`.pw-wkbar .wk-chip[data-wk="${wk}"]`);
        await page.waitForSelector('.view-sub .pw-archived', { timeout: 20000 });
        await page.waitForFunction(() => !!document.querySelector('.card.parlay[data-rv-pay]'), null,
          { timeout: 20000 });
        return await page.locator('.card.parlay[data-rv-pay]').evaluateAll(
          (els) => els.map((e) => [e.dataset.parlayId, e.dataset.rvPay]).sort());
      } finally {
        await ctx.close();
      }
    };
    const committed = await paid(base, PAST);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.length).toBe(rows.filter((r) => r.money && r.scope === 'game').length);
    // card_id is the join even when parlay_id is nonsense — on the newest closed
    // week, whose archive carries the R93 re-issued ids.
    expect(await paid(identity, PAST)).toEqual(committed);

    /* THE FALLBACK HALF STANDS ON A PRE-R93 WEEK (2026-09-23).
     *
     * A re-run re-issues a card's id ("401872933-g1" -> "401872933-g1~e9d2a3")
     * and BOTH forms live in the archive; 103 of week 2's 182 cards are in the
     * new form. A review document with no card_id on it is by definition one
     * written before that existed, and it can only name the OLD ids — so asking
     * the parlay_id fallback to find a re-issued card is asking it to do the one
     * thing card_id was added to do, and it reddened this file the week the
     * first re-issue landed. The fallback is therefore exercised on the newest
     * closed week whose archive is entirely pre-R93 ids, which is what such a
     * document would have been written against. DERIVED, so it follows the
     * archive rather than naming week 1. */
    const preR93 = (INDEX.weeks || []).filter((w) => w.closed && Number(w.week) !== CUR)
      .map((w) => Number(w.week)).sort((a, b) => b - a)
      .find((wk) => read(`../../data/parlays/${PARLAYS.season}_wk${String(wk).padStart(2, '0')}.json`)
        .parlays.every((c) => !String(c.parlay_id).includes('~')));
    expect(preR93, 'the archive carries a closed week in the pre-R93 id form').toBeTruthy();
    const preBase = JSON.parse(JSON.stringify(REVIEW));
    const preStripped = JSON.parse(JSON.stringify(preBase));
    preStripped.weeks[String(preR93)].parlays.forEach((r) => { delete r.card_id; });
    const preCommitted = await paid(preBase, preR93);
    expect(preCommitted.length).toBeGreaterThan(0);
    expect(await paid(preStripped, preR93)).toEqual(preCommitted);
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
      expect(shown.every((c) => c.payText.includes('$100 SIM NET · GRADED'))).toBe(true);
      // the P&L line below is the same money
      await expect(page.locator('#parlay-pnl .rv-pnl-line')).toContainText(`WEEK ${PAST}`);
    }
    expect(errors).toEqual([]);
  });
});
