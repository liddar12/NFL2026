/* tests/web/r53_model.spec.mjs — R53/R54 (project `web`): the MODEL tab's
 * LEARNING RECORD and the LIVE 2026 rows on both gate cards, end to end.
 *
 *   - COMMITTED data, unrouted: LEARNING RECORD and both gate cards render;
 *     whichever honest state the deploy is in is asserted from the committed
 *     files themselves (0 resolved weeks -> the day-zero wording and the
 *     "no week resolved yet" line; >= 1 -> the series table and the LIVE row).
 *   - ROUTED weekly_backtest.json / parlay_backtest.json carrying a live_2026
 *     block: the LIVE 2026 row renders its numbers on both cards; weeks == 0
 *     renders the note and no row; the corpus verdict chips are untouched.
 *   - ROUTED meta.json with a resolved learning_record: the SERIES table, the
 *     marked best MAE and the LAST PROPOSAL verdict; no day-zero sentence.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readFix = (name) => readFileSync(new URL(`../fixtures/r51/${name}`, import.meta.url), 'utf8');
const readData = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
const WEEKLY = JSON.parse(readFix('weekly_backtest.sample.json'));
const PARLAY = JSON.parse(readFix('parlay_backtest.sample.json'));

const LIVE_WEEKLY = {
  season: 2026, weeks: 1, weeks_resolved: [1], rows: 40,
  ledger: 'data/estimates/2026.json', scores: 'data/estimate_scores.json',
  shipped: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 },
  gated: { mae: 6.487, rank_corr: 0.2333, topk: 0.8149 },
  candidate: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 },
  per_week: [{ week: 1, n: 40, shipped: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 },
    gated: { mae: 6.487, rank_corr: 0.2333, topk: 0.8149 }, candidate: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 } }],
  note: 'LIVE 2026: measured only — the never-regress verdict above stays on the corpus',
};
const LIVE_PARLAY = {
  weeks: 2, legs_resolved: 118,
  seed: { log_loss: 0.6912, hit_rate: 0.576 },
  calibrated: { log_loss: 0.6778, hit_rate: 0.601 },
  refit: { applied: true, fit_weeks: [1, 2], reason: 'calibrated clears never-regress on both weeks' },
  note: 'legs scored on FINAL 2026 games',
};

const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function routeBacktests(page, { weekly, parlay }) {
  if (weekly !== undefined) await page.route('**/data/weekly_backtest.json', (r) => json(r, weekly));
  if (parlay !== undefined) await page.route('**/data/parlay_backtest.json', (r) => json(r, parlay));
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/* R78 — the MODEL tab is passphrase-gated (obscurity, not security: the data
 * feeds stay public, only the VIEW hides). Any spec that drives #/model seeds
 * the unlock digest so it exercises the dashboard, not the lock card. The
 * gate's own behaviour is covered by tests/web/r78_model_lock.spec.mjs. */
const unlockModel = (page) => page.addInitScript(() => {
  try {
    localStorage.setItem('nfl2026.model.unlock.v1', '4fed76b87cf8b056da33b210b23e8f4f93e9c955d56faf7e3ae3bbb57704f50b');
  } catch (_) { /* storage blocked — the spec will show the lock card and fail loudly */ }
});

async function openModel(page) {
  await unlockModel(page);
  await page.goto('/#/model');
  await page.waitForSelector('.m-cal', { timeout: 15000 });
  await expect(page.locator('.m-locks')).toHaveCount(1);
}

const flat = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

test.describe('R53/R54 — LEARNING RECORD + LIVE 2026 rows on #/model', () => {
  test('COMMITTED data: LEARNING RECORD and both gate cards render in the honest state the files are in', async ({ page }) => {
    const errors = collectErrors(page);
    const status = {};
    page.on('response', (res) => {
      const m = res.url().match(/\/data\/(weekly_backtest|parlay_backtest)\.json$/);
      if (m) status[m[1]] = res.status();
    });
    await openModel(page);
    await page.waitForTimeout(500);

    // LEARNING RECORD, from the committed meta.learning_record
    const lr = readData('meta.json').learning_record;
    const learning = page.locator('.m-learning');
    await expect(learning).toHaveCount(1);
    await expect(learning.locator('.m-head')).toContainText('LEARNING RECORD');
    const lt = await flat(learning);
    expect(lt).toContain(`WEEKS RESOLVED ${lr.weeks_resolved}`);
    expect(lt).toContain(`PLAYERS SCORED ${lr.players_scored}`);
    if (lr.weeks_resolved === 0) {
      expect(lt).toContain('No 2026 week has resolved yet — nothing has been scored, so no signal has earned weight.');
      expect(lt).toContain('MAE (PPR) —');
      expect(lt).not.toContain('LAST PROPOSAL');
      await expect(learning.locator('table.pf-tbl')).toHaveCount(0);
    } else {
      expect(lt).not.toContain('No 2026 week has resolved yet');
      await expect(learning.locator('table.pf-tbl')).toHaveCount(1);
      expect(lt).toContain('LAST PROPOSAL');
    }

    // WEEKLY SPLIT GATE: the committed record and its live_2026 block
    expect(status.weekly_backtest).toBeDefined();
    if (status.weekly_backtest === 200) {
      const weekly = page.locator('.m-weekly-gate');
      await expect(weekly).toHaveCount(1);
      const wt = await flat(weekly);
      const live = readData('weekly_backtest.json').live_2026;
      if (!live) {
        expect(wt).not.toContain('LIVE 2026');
      } else if (live.weeks === 0) {
        expect(wt).toContain('LIVE 2026 · no week resolved yet');
        await expect(weekly.locator('.gate-row .gate-name', { hasText: 'LIVE 2026' })).toHaveCount(0);
      } else {
        await expect(weekly.locator('.gate-row .gate-name', { hasText: 'LIVE 2026' })).toHaveCount(1);
        expect(wt).toContain(`${live.weeks} week`);
      }
    }
    // PARLAY GATE: partition C's block may or may not be there yet
    expect(status.parlay_backtest).toBeDefined();
    if (status.parlay_backtest === 200) {
      const parlay = page.locator('.m-parlay-gate');
      await expect(parlay).toHaveCount(1);
      const pt = await flat(parlay);
      const live = readData('parlay_backtest.json').live_2026;
      if (!live) expect(pt).not.toContain('LIVE 2026');
      else if (live.weeks === 0) expect(pt).toContain('LIVE 2026 · no week resolved yet');
      else await expect(parlay.locator('.gate-row .gate-name', { hasText: 'LIVE 2026' })).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });

  test('ROUTED live_2026 blocks: the LIVE 2026 row renders on both gate cards; the corpus verdicts are untouched', async ({ page }) => {
    const errors = collectErrors(page);
    await routeBacktests(page, {
      weekly: { ...WEEKLY, live_2026: LIVE_WEEKLY },
      parlay: { ...PARLAY, live_2026: LIVE_PARLAY },
    });
    await openModel(page);

    const weekly = page.locator('.m-weekly-gate');
    await expect(weekly).toHaveCount(1);
    const liveRow = weekly.locator('.gate-row', { has: page.locator('.gate-name', { hasText: 'LIVE 2026' }) });
    await expect(liveRow).toHaveCount(1);
    await expect(liveRow).toBeVisible();
    const lrt = await flat(liveRow);
    expect(lrt).toContain('LIVE 2026 1 week · 40 rows MAE 5.941 · rank corr 0.220');
    const wt = await flat(weekly);
    expect(wt).toContain('SHIPPED MAE 5.941 · rank corr 0.220 · top-K 82.0%');
    expect(wt).toContain('GATED MAE 6.487 · rank corr 0.233 · top-K 81.5%');
    expect(wt).toContain('wk 1 n 40 MAE 5.941');
    expect(wt).toContain('never-regress verdict above stays on the corpus');
    await expect(weekly.locator('.gate-chip--adopted')).toHaveText('ADOPTED');
    // the row sits after the metric table and before the per-position table
    const order = await weekly.evaluate((el) => {
      const html = el.innerHTML;
      return [html.indexOf('Δ V2−V1'), html.indexOf('LIVE 2026'), html.indexOf('RANK CORR V1 → V2')];
    });
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
    // the row is legible on the phone: no horizontal overflow
    const box = await liveRow.boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);

    const parlay = page.locator('.m-parlay-gate');
    await expect(parlay).toHaveCount(1);
    const pRow = parlay.locator('.gate-row', { has: page.locator('.gate-name', { hasText: 'LIVE 2026' }) });
    await expect(pRow).toHaveCount(1);
    const prt = await flat(pRow);
    expect(prt).toContain('LIVE 2026 2 weeks · 118 legs seed LL 0.6912 → cal 0.6778 REFIT');
    await expect(pRow.locator('.gate-chip--adopted')).toHaveText('REFIT');
    const pt = await flat(parlay);
    expect(pt).toContain('HIT RATE seed 57.6% → calibrated 60.1% · fit weeks 1/2');
    expect(pt).toContain('calibrated clears never-regress on both weeks · legs scored on FINAL 2026 games');
    await expect(parlay.locator('.gate-chip--nopath')).toHaveText('NO EDGE');
    expect(errors).toEqual([]);
  });

  test('ROUTED weeks == 0: the honest note, no LIVE row, no number', async ({ page }) => {
    const errors = collectErrors(page);
    await routeBacktests(page, {
      weekly: { ...WEEKLY, live_2026: { weeks: 0, note: 'ledger has no locked (pre-kickoff) player-week yet' } },
      parlay: { ...PARLAY, live_2026: { weeks: 0, legs_resolved: 0, seed: null, calibrated: null, refit: null, note: 'no 2026 leg has resolved yet' } },
    });
    await openModel(page);
    for (const [sel, note] of [['.m-weekly-gate', 'ledger has no locked (pre-kickoff) player-week yet'],
      ['.m-parlay-gate', 'no 2026 leg has resolved yet']]) {
      const card = page.locator(sel);
      await expect(card).toHaveCount(1);
      await expect(card.locator('.gate-row .gate-name', { hasText: 'LIVE 2026' })).toHaveCount(0);
      const t = await flat(card);
      expect(t).toContain(`LIVE 2026 · no week resolved yet — ${note}`);
      expect(t).not.toContain('REFIT');
    }
    expect(errors).toEqual([]);
  });

  test('ROUTED resolved learning_record: series table, best marked, last proposal; no day-zero sentence', async ({ page }) => {
    const errors = collectErrors(page);
    const meta = readData('meta.json');
    meta.learning_record = {
      ...meta.learning_record,
      weeks_resolved: 1, players_scored: 40, mae_ppr: 5.941, bias_ppr: -1.941,
      candidate_mae_ppr: 5.941, candidate_bias_ppr: -1.941, gated_mae_ppr: 6.487, gated_bias_ppr: -1.923,
      band_coverage: 0.675, objective_ready: true, updated_utc: '2026-09-15T00:00:00Z',
      last_proposal: {
        generated_utc: '2026-09-16T00:00:00Z', verdict: 'refused', would_adopt: false, folds: 0, weeks_resolved: 1,
        candidate_mae: null, gated_mae: null,
        reason: 'walk-forward needs >= 2 resolved weeks for a held-out fold; nothing can be adopted on one week',
      },
    };
    await page.route('**/data/meta.json', (r) => json(r, meta));
    await openModel(page);
    const learning = page.locator('.m-learning');
    await expect(learning).toHaveCount(1);
    await expect(learning.locator('table.pf-tbl')).toHaveCount(1);
    const t = await flat(learning);
    expect(t).toContain('WEEKS RESOLVED 1');
    expect(t).toContain('PLAYERS SCORED 40');
    expect(t).toContain('MAE (PPR) 5.94');
    expect(t).toContain('BIAS (PPR) -1.94');
    expect(t).toContain('SHIPPED 5.941 ▲ −1.941');
    expect(t).toContain('GATED 6.487 −1.923');
    expect(t).toContain('BAND COVERAGE 67.5%');
    expect(t).toContain('LAST PROPOSAL REFUSED');
    expect(t).toContain('walk-forward needs >= 2 resolved weeks');
    expect(t).not.toContain('No 2026 week has resolved yet');
    await expect(learning.locator('.m-head .ms-badge')).toHaveText('MEASURED');
    expect(errors).toEqual([]);
  });
});
