import { test, expect } from '@playwright/test';
import { SEED_TEAM, SKIP_REASON } from './_myseed.mjs';

/* The MY tests need a game that has not kicked off; between the last game of a
 * week and the next week's pool there is none, and MY correctly offers nothing.
 * The reason names that condition, so a skipped run reads as a finished slate
 * rather than a broken suite. It is '' whenever any game is upcoming. */
test.skip(() => Boolean(SKIP_REASON), SKIP_REASON || 'the slate is live');


// Incident contract: text must fit the CARD'S padded content box. A hidden
// document scrollbar is not evidence of containment (R84's false negative).
async function footerFaults(page, selector) {
  return page.locator(selector).evaluateAll(cards => cards.flatMap((card, index) => {
    const b = card.getBoundingClientRect(), css = getComputedStyle(card);
    const left = b.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const right = b.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
    const foot = card.querySelector('.p-foot'), faults = [];
    const check = (r, text) => {
      if (r.width && (r.left < left - 1 || r.right > right + 1)) faults.push({ index, text, left, right, actualLeft: r.left, actualRight: r.right });
    };
    for (const el of foot.querySelectorAll('*')) check(el.getBoundingClientRect(), el.className);
    const walker = document.createTreeWalker(foot, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const r of range.getClientRects()) check(r, walker.currentNode.textContent);
    }
    const children = [...foot.children].map(el => el.getBoundingClientRect());
    children.forEach((a, i) => children.slice(i + 1).forEach(b => {
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) faults.push({ index, overlap: true });
    }));
    return faults;
  }));
}

for (const mode of ['game', 'week', 'my']) {
  test(`R85: ${mode} complete footers fit at mobile and grid breakpoints`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.clock.setFixedTime(new Date('2026-09-17T20:43:50Z'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#/parlays');
    await page.waitForSelector('#parlays-list .card.parlay');
    await page.waitForSelector('.rv-strip--parlay');
    await page.click(`[data-seg="${mode}"]`);
    // R90 — the leg-count chips are inside the collapsed FILTERS panel.
    if (mode === 'week') {
      await page.evaluate(() => { const d = document.querySelector('#parlay-filters'); if (d) d.open = true; });
      await page.click('[data-leg="5"]');
    }
    if (mode === 'my') {
      await page.fill('#mp-input', SEED_TEAM);
      await page.press('#mp-input', 'Enter');
    }
    const selector = mode === 'my' ? '#mp-list .mp-card' : '#parlays-list .card.parlay';
    await page.waitForSelector(selector);
    if (mode === 'my') {
      await expect(page.locator('#mp-note')).toContainText('never by payout');
      await expect(page.locator('.mp-card .ev').first()).toContainText('%');
    }
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 375, 402, 820, 1100, 1280, 1440, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => footerFaults(page, selector), { message: `${mode} at ${width}px`, timeout: 1500 }).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test('R85: graded, unavailable and large money labels remain contained at double text size', async ({ page }) => {
  await page.goto('/#/parlays');
  await page.waitForSelector('#parlays-list .card.parlay');
  await page.waitForSelector('.rv-strip--parlay');
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.evaluate(async () => {
    const { renderPay } = await import('/app/review.js');
    const { renderParlayCard } = await import('/app/render.js');
    // Initial-render unavailable path, before any review receipt exists.
    document.querySelector('#parlays-list').insertAdjacentHTML('beforeend', renderParlayCard({
      parlay_id: 'unavailable-test', model_ev: 0, legs: [{ market: 'moneyline', selection: 'AAA ML', model_prob: .6, implied_prob: null }],
    }));
    const cards = [...document.querySelectorAll('#parlays-list .card.parlay')].slice(0, 3);
    for (const [i, card] of cards.entries()) {
      card.querySelector('.pay').outerHTML = renderPay({ kind: 'settled', net_fair: [1234567.89, -100, 0][i] });
      for (const el of card.querySelectorAll('.p-foot, .p-foot *')) el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * 2}px`;
    }
  });
  await expect(page.locator('[data-parlay-id="unavailable-test"] .pay-detail')).toContainText('unavailable');
  expect(await footerFaults(page, '#parlays-list .card.parlay')).toEqual([]);
});
