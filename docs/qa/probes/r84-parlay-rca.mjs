// Read-only diagnostic. Writes no application data; emits evidence to stdout.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCards, poolLegs, upcomingLegs } from '../../../app/views/myparlays.js';
import { correlationTable } from '../../../app/parlay-math.js';
const root = new URL('../../../', import.meta.url).pathname;
const read = n => JSON.parse(readFileSync(`${root}/data/${n}.json`, 'utf8'));
const pool = read('leg_pool'), calib = read('parlay_backtest'), schedule = read('schedule_full');
const at = '2026-09-17T20:43:50Z';
const cards = buildCards(upcomingLegs(poolLegs(pool), schedule.games, Date.parse(at)),
  [{ kind: 'team', id: 'team:DET', name: 'DET' }], correlationTable(calib));
const money = cards.map(c => ({ n: c.legs.length, model: c.model, implied: c.implied,
  ev: c.ev, net: c.payout, gross: c.payout + 100, legs: c.legs.map(l => ({
    selection: l.selection, model: l.model_prob, implied: l.implied_prob, price_source: l.price_source,
  })) }));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, headless: true });
const geometry = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('nfl2026.unlock.v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  for (const scope of ['game', 'week', 'my']) {
    await page.goto('http://127.0.0.1:4321/#/parlays');
    await page.waitForSelector('#parlays-list .card.parlay');
    await page.locator(`.scopeseg [data-seg="${scope}"]`).click();
    if (scope === 'week') await page.locator('[data-leg="5"]').click();
    if (scope === 'my') {
      await page.locator('#mp-input').fill('DET');
      await page.locator('#mp-input').press('Enter');
    }
    const selector = scope === 'my' ? '#mp-list .mp-card' : '#parlays-list .card.parlay';
    await page.waitForSelector(selector);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 402, 820, 1100, 1280, 1440, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const row = await page.evaluate(selector => {
        const cards = [...document.querySelectorAll(selector)];
        const measures = cards.map(c => {
          const box = c.getBoundingClientRect(), pay = c.querySelector('.pay').getBoundingClientRect();
          return { width: box.width, overhang: Math.max(0, pay.right - box.right),
            footerText: c.querySelector('.p-foot').innerText };
        });
        return { documentWidth: document.documentElement.scrollWidth, count: cards.length,
          overflowing: measures.filter(c => c.overhang > 1).length,
          maxOverhang: Math.max(...measures.map(c => c.overhang)), first: measures[0] };
      }, selector);
      geometry.push({ scope, width, ...row });
    }
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), moneyAsOf: at,
  poolGenerated: pool.generated_utc, poolSha256: createHash('sha256').update(readFileSync(`${root}/data/leg_pool.json`)).digest('hex'),
  money, geometry, pageErrors: errors }, null, 2));
