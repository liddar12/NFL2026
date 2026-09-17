/* tests/web/r73_parlay_history.spec.mjs — R73 parlay history in the browser (project `web`).
 *
 * Same fixture-serving pattern as r71/r72: the contracts are routed to
 * documents built from the COMMITTED parlays.json (so every id the view paints
 * exists and every leg annotation still has something to annotate):
 *   - /data/parlays.json         the committed document re-keyed to WEEK+1 (the
 *                                CURRENT week: the earliest not entirely FINAL);
 *   - /data/parlays/index.json   the fixture index shape (tests/fixtures/r73)
 *                                listing WEEK (closed, archived) and WEEK+1,
 *                                with a STALE current_week (= WEEK) on purpose;
 *   - /data/parlays/2026_wkNN    the committed document as the WEEK archive,
 *                                its ids suffixed "-a" so an archived card is
 *                                provably the archive's, not the current list's;
 *   - /data/review.json          buckets + results + stake_100 for both weeks.
 * Proves: the default week is parlays.json's (never the index's current_week);
 * chips come from the index; tapping a past week fetches its archive ONCE and
 * paints the archived cards with the R71 marks, the R72 bucket chips and the
 * $100 flat-stake P&L line; scope / leg-count / bucket filters work on the
 * past week; no index -> no chips; a missing archive -> a .state message.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PARLAYS = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const INDEX_FX = JSON.parse(readFileSync(new URL('../fixtures/r73/index.json', import.meta.url), 'utf8'));
const ARCHIVE_FX = JSON.parse(readFileSync(new URL('../fixtures/r73/2026_wk01.json', import.meta.url), 'utf8'));
const WEEK = Number(PARLAYS.week);      // the archived (past) week
const CUR = WEEK + 1;                   // the current week (parlays.json's)
const SEASON = Number(PARLAYS.season);
const pad2 = (w) => String(w).padStart(2, '0');
const ARCHIVE_PATH = `data/parlays/${SEASON}_wk${pad2(WEEK)}.json`;
const BUCKETS = ['all_hit', 'push', 'partial', 'all_missed', 'pending'];
const RESULT_OF = { all_hit: 'hit', push: 'void', partial: 'miss', all_missed: 'miss', pending: 'pending' };

/** The committed document as the CURRENT week (WEEK+1). */
function currentDoc() {
  const doc = JSON.parse(JSON.stringify(PARLAYS));
  doc.week = CUR;
  return doc;
}

/** The committed document as WEEK's archive: ids suffixed, R73 fields added. */
function archiveDoc() {
  const doc = JSON.parse(JSON.stringify(PARLAYS));
  doc.week = WEEK;
  doc.parlays.forEach((p) => { p.parlay_id = `${p.parlay_id}-a`; });
  doc.archived_utc = ARCHIVE_FX.archived_utc;
  doc.closed = true;
  doc.history = ARCHIVE_FX.history;
  return doc;
}

/** The fixture index shape, re-keyed onto the committed season / weeks. */
function indexDoc() {
  const counts = (doc) => ({
    n_parlays: doc.parlays.length,
    n_week_scope: doc.parlays.filter((p) => p.scope === 'week').length,
    n_game_scope: doc.parlays.filter((p) => p.scope !== 'week').length,
  });
  return {
    ...INDEX_FX,
    season: SEASON,
    current_week: WEEK, // STALE on purpose — parlays.json says CUR and must win
    weeks: [
      { ...INDEX_FX.weeks[0], week: WEEK, path: ARCHIVE_PATH, closed: true, ...counts(PARLAYS) },
      { ...INDEX_FX.weeks[1], week: CUR, path: `data/parlays/${SEASON}_wk${pad2(CUR)}.json`, closed: false,
        archived_utc: null, ...counts(PARLAYS) },
    ],
  };
}

/** Review rows for one week's parlays: buckets cycle per scope; results follow. */
function reviewRows(parlays) {
  const counters = { game: 0, week: 0 };
  return parlays.map((p) => {
    const scope = p.scope === 'week' ? 'week' : 'game';
    const bucket = BUCKETS[counters[scope] % BUCKETS.length];
    counters[scope] += 1;
    const legRes = (li) => {
      if (bucket === 'all_hit') return 'hit';
      if (bucket === 'all_missed') return 'miss';
      if (bucket === 'push') return li === 0 ? 'hit' : 'void';
      if (bucket === 'partial') return li === 0 ? 'hit' : 'miss';
      return li === 0 ? 'hit' : 'pending';
    };
    const legs = p.legs.map((l, li) => ({ selection: l.selection, market: l.market, game_id: p.game_id || null,
      result: legRes(li), actual: null, why: 'fixture' }));
    return { parlay_id: p.parlay_id, scope, game_id: p.game_id || null, result: RESULT_OF[bucket], bucket, legs };
  });
}

/** A week block's summary.parlays from its rows + the stake_100 figures given. */
function summaryParlays(rows, stake) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((p) => p.bucket === b).length]));
  const legs = rows.flatMap((p) => p.legs);
  return {
    n: rows.length, hit: buckets.all_hit, miss: buckets.partial + buckets.all_missed, pending: buckets.pending,
    legs_n: legs.length, legs_hit: legs.filter((l) => l.result === 'hit').length, buckets,
    stake_100: stake,
  };
}

const STAKE_PAST = {
  week: { n: 18, graded: 18, hit: 16, push: 0, staked: 1800, net_fair: 11564, net_vig2: 10200, assumed_price_legs: 0,
    note: '$100 flat on every graded parlay; pending excluded' },
  game: { n: 48, graded: 40, hit: 12, push: 1, staked: 4000, net_fair: -820, net_vig2: -1250, assumed_price_legs: 7,
    note: '$100 flat on every graded parlay; pending excluded; 7 prop legs priced at -110 (no book price)' },
};
const STAKE_CUR = {
  week: { n: 18, graded: 3, hit: 1, push: 0, staked: 300, net_fair: 95, net_vig2: 60, assumed_price_legs: 0, note: '' },
  game: { n: 48, graded: 4, hit: 2, push: 0, staked: 400, net_fair: 310, net_vig2: 280, assumed_price_legs: 1, note: '' },
};
const STAKE_NONE = {
  week: { n: 18, graded: 0, hit: 0, push: 0, staked: 0, net_fair: 0, net_vig2: 0, assumed_price_legs: 0, note: 'no FINAL yet' },
  game: { n: 48, graded: 0, hit: 0, push: 0, staked: 0, net_fair: 0, net_vig2: 0, assumed_price_legs: 0, note: 'no FINAL yet' },
};

function reviewDoc({ curStake = STAKE_CUR } = {}) {
  const pastRows = reviewRows(archiveDoc().parlays);
  const curRows = reviewRows(currentDoc().parlays);
  if (curStake === STAKE_NONE) curRows.forEach((r) => {
    r.result = r.bucket = 'pending';
    r.legs.forEach((l) => { l.result = 'pending'; });
  });
  const empty = { picks: { n: 16, won: 0, pct: null, brier: null, right: 0, wrong: 0, tbd: 16 },
    learning: { graded_locks: 0, refit: null, note: 'no FINAL yet' },
    players: { n: 0, over: 0, under: 0, met: 0, dnp: 0, band_coverage: null } };
  return {
    season: SEASON, generated_utc: 't', sources: {}, notes: [],
    learning: { graded_locks_total: 16, refit: null, consumed_all: false, note: 'below the minimum' },
    players_season: {},
    weeks: {
      [String(WEEK)]: { games: [], players: [], parlays: pastRows,
        summary: { ...empty, parlays: summaryParlays(pastRows, STAKE_PAST) } },
      [String(CUR)]: { games: [], players: [], parlays: curRows,
        summary: { ...empty, parlays: summaryParlays(curRows, curStake) } },
    },
  };
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });
const notFound = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });

/** Route every R73 contract; `opts` drops the index or the archive (404). */
async function routeAll(page, { index = true, archive = true, review = reviewDoc() } = {}) {
  await page.route('**/data/parlays.json', (r) => json(r, JSON.stringify(currentDoc())));
  await page.route('**/data/parlays/index.json', (r) => (index ? json(r, JSON.stringify(indexDoc())) : notFound(r)));
  await page.route(`**/${ARCHIVE_PATH}`, (r) => (archive ? json(r, JSON.stringify(archiveDoc())) : notFound(r)));
  await page.route('**/data/review.json', (r) => json(r, JSON.stringify(review)));
}
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
function collectData(page) {
  const got = [];
  page.on('request', (r) => { const u = r.url(); if (u.includes('/data/')) got.push(u.split('/data/')[1].split('?')[0]); });
  return got;
}
const cardIds = (page) => page.locator('.card.parlay').evaluateAll((els) => els.map((e) => e.dataset.parlayId));

// Assert the rendered total against the actual simulated cards, not stale fixture totals.
async function expectSimulationTotal(page) {
  const net = await page.locator('.card.parlay[data-rv-pay-kind="settled"]').evaluateAll(
    (cards) => cards.reduce((n, c) => n + Number(c.dataset.rvPay), 0));
  const rounded = Math.round(net);
  const formatted = `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
  await expect(page.locator('#parlay-pnl .rv-pnl-line')).toContainText(`SIM NET ${formatted}`);
  await expect(page.locator('#parlay-pnl .rv-pnl-line')).toContainText('not actual betting returns');
}

test.describe('R73 — PARLAYS week chips + history', () => {
  test('default week is parlays.json\'s (stale index ignored); chips from the index; archive never fetched cold', async ({ page }) => {
    const errors = collectErrors(page);
    const got = collectData(page);
    await routeAll(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    // chips: one per index week, the CURRENT one selected — not index.current_week
    await expect(page.locator('.pw-wkbar .wk-chip')).toHaveCount(2);
    await expect(page.locator(`.pw-wkbar .wk-chip[data-wk="${CUR}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`)).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`)).toHaveClass(/pw-wk--closed/);
    await expect(page.locator('.view-sub')).toContainText(`WEEK ${CUR} · SIM EV`);
    await expect(page.locator('.view-sub .pw-archived')).toHaveCount(0);
    // the current list is parlays.json's (no "-a" ids)
    const ids = await cardIds(page);
    expect(ids.length).toBe(PARLAYS.parlays.filter((p) => p.scope !== 'week').length);
    expect(ids.every((id) => !id.endsWith('-a'))).toBe(true);
    // the P&L line renders for the current week too once it has graded parlays
    await page.waitForSelector('#parlay-pnl .rv-pnl', { timeout: 15000 });
    await expectSimulationTotal(page);
    await expect(page.locator('#parlay-pnl .rv-pnl-note')).toContainText('assumed or unverified comparison prices');
    // under the bucket card, above the list
    expect(await page.evaluate(() => {
      const b = document.querySelector('#parlay-buckets');
      const p = document.querySelector('#parlay-pnl');
      const l = document.querySelector('#parlays-list');
      const after = (x, y) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
      return after(b, p) && after(p, l) && b.parentElement === p.parentElement;
    })).toBe(true);
    // the legend labels the money display-only
    await expect(page.locator('.legend')).toContainText('Display only — never a model input');
    // requests: the index joined the mount, the archive did NOT
    await page.waitForTimeout(500);
    expect(got.filter((f) => f === 'parlays/index.json').length).toBe(1);
    expect(got.filter((f) => /^parlays\/\d{4}_wk\d{2}\.json$/.test(f))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('tapping a past week fetches its archive once and paints the archived cards, marks, buckets and P&L; filters work there', async ({ page }) => {
    const errors = collectErrors(page);
    const got = collectData(page);
    const review = reviewDoc();
    const pastRows = review.weeks[String(WEEK)].parlays;
    const counts = review.weeks[String(WEEK)].summary.parlays.buckets;
    await routeAll(page, { review });
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.waitForSelector('#parlay-buckets .rv-bucket', { timeout: 15000 });

    await page.click(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`);
    await expect(page.locator(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.view-sub')).toContainText(`WEEK ${WEEK} · SIM EV`);
    await expect(page.locator('.view-sub .pw-archived')).toHaveText('ARCHIVED');
    await page.waitForSelector('.card.parlay[data-parlay-id$="-a"]', { timeout: 15000 });
    // every painted card is the archive's
    const gameRows = pastRows.filter((p) => p.scope === 'game');
    const ids = await cardIds(page);
    expect(ids.length).toBe(gameRows.length);
    expect(ids.every((id) => id.endsWith('-a'))).toBe(true);
    // R71 marks + R72 bucket chips on the archived cards, keyed by the past week
    await page.waitForSelector('.card.parlay .rv-leg', { timeout: 15000 });
    await expect(page.locator('.card.parlay .rv-leg').first()).toHaveText('✓');
    await expect(page.locator(`.rv-strip--parlay[data-week="${WEEK}"]`)).toHaveCount(1);
    for (const p of gameRows.slice(0, 5)) {
      const c = page.locator(`.card.parlay[data-parlay-id="${p.parlay_id}"]`);
      await expect(c.locator('.rv-bchip')).toHaveText(p.bucket.replace('_', ' ').toUpperCase());
      await expect(c.locator('.rv-pchip')).toHaveText(RESULT_OF[p.bucket].toUpperCase());
    }
    // the bucket card for the past week and its P&L line (GAME scope: a loss, a push, assumed legs)
    await expect(page.locator(`#parlay-buckets .rv-buckets[data-week="${WEEK}"]`)).toHaveCount(1);
    for (const b of BUCKETS) {
      await expect(page.locator(`.rv-bucket[data-bucket="${b}"] .rv-bucket-n`)).toHaveText(String(counts[b]));
    }
    await expect(page.locator(`#parlay-pnl .rv-pnl[data-week="${WEEK}"][data-scope="game"]`)).toHaveCount(1);
    await expectSimulationTotal(page);
    await expect(page.locator('#parlay-pnl .rv-pnl-note')).toContainText('assumed or unverified comparison prices');
    // the R51 leg annotations still ride the archived cards
    await expect(page.locator('.card.parlay .leg-noedge').first()).toHaveText('NO EDGE');

    // bucket filter on the past week
    await page.click('.rv-bucket[data-bucket="all_hit"]');
    const gameAllHit = gameRows.filter((p) => p.bucket === 'all_hit').length;
    await expect(page.locator('.card.parlay')).toHaveCount(gameAllHit);
    await expect(page.locator('.card.parlay .rv-bchip:not(.rv-bchip--all_hit)')).toHaveCount(0);
    await page.click('.rv-bucket[data-bucket="all_hit"]');
    await expect(page.locator('.card.parlay')).toHaveCount(gameRows.length);

    // WEEK scope on the past week: the P&L line follows the scope; leg-count chips filter
    await page.click('.seg-btn[data-seg="week"]');
    await expect(page.locator('#parlay-pnl .rv-pnl[data-scope="week"]')).toHaveCount(1);
    await expectSimulationTotal(page);
    await expect(page.locator('#parlay-pnl .rv-pnl-note')).toContainText('assumed or unverified comparison prices');
    const weekRows = pastRows.filter((p) => p.scope === 'week');
    await expect(page.locator('.card.parlay')).toHaveCount(weekRows.length);
    await page.waitForSelector('.leg-chip[data-leg="3"]', { timeout: 5000 });
    await page.click('.leg-chip[data-leg="3"]');
    const legsOf = new Map(archiveDoc().parlays.map((p) => [p.parlay_id, p.legs.length]));
    const three = weekRows.filter((p) => legsOf.get(p.parlay_id) === 3);
    await expect(page.locator('.card.parlay')).toHaveCount(three.length);
    await page.click('.rv-bucket[data-bucket="partial"]');
    const expected = three.filter((p) => p.bucket === 'partial');
    await expect(page.locator('.card.parlay')).toHaveCount(expected.length);
    if (expected.length) await expect(page.locator('.card.parlay .rv-bchip').first()).toHaveText('PARTIAL');
    else await expect(page.locator('#parlays-list .state')).toContainText('No parlays in that bucket');

    // back to the current week: no refetch, the current ids, filters reset, current P&L
    await page.click(`.pw-wkbar .wk-chip[data-wk="${CUR}"]`);
    await expect(page.locator('.view-sub')).toContainText(`WEEK ${CUR} · SIM EV`);
    await expect(page.locator('.view-sub .pw-archived')).toHaveCount(0);
    await page.waitForSelector('.card.parlay:not([data-parlay-id$="-a"])', { timeout: 15000 });
    const back = await cardIds(page);
    expect(back.every((id) => !id.endsWith('-a'))).toBe(true);
    await expect(page.locator('.leg-chip[data-leg="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.rv-bucket[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.locator(`#parlay-pnl .rv-pnl[data-week="${CUR}"][data-scope="week"]`)).toHaveCount(1);
    // and the past week again is served from the promise cache
    await page.click(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`);
    await page.waitForSelector('.card.parlay[data-parlay-id$="-a"]', { timeout: 15000 });
    await page.waitForTimeout(300);
    expect(got.filter((f) => f === ARCHIVE_PATH.replace(/^data\//, '')).length).toBe(1);
    expect(got.filter((f) => f === 'parlays.json').length).toBe(1);
    expect(got.filter((f) => f === 'parlays/index.json').length).toBe(1);
    expect(errors).toEqual([]);
  });

  test('no index (404): the current week alone, no chips, no P&L when nothing is graded, no page error', async ({ page }) => {
    const errors = collectErrors(page);
    await routeAll(page, { index: false, review: reviewDoc({ curStake: STAKE_NONE }) });
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.waitForSelector('#parlay-buckets .rv-bucket', { timeout: 15000 });
    await expect(page.locator('.pw-wkbar')).toHaveCount(0);
    await expect(page.locator('.wk-chip')).toHaveCount(0);
    await expect(page.locator('.view-sub')).toContainText(`WEEK ${CUR} · SIM EV`);
    await expect(page.locator('#parlay-pnl .rv-pnl')).toHaveCount(0);
    expect((await cardIds(page)).length).toBe(PARLAYS.parlays.filter((p) => p.scope !== 'week').length);
    expect(errors).toEqual([]);
  });

  test('missing archive (404): a .state message names the week, the chrome stays, the current week comes back', async ({ page }) => {
    const errors = collectErrors(page);
    await routeAll(page, { archive: false });
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.click(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`);
    await page.waitForSelector('#parlays-list .state:not(.state--loading)', { timeout: 15000 });
    await expect(page.locator('#parlays-list .state')).toContainText(`Week ${WEEK} is not archived`);
    await expect(page.locator('.card.parlay')).toHaveCount(0);
    await expect(page.locator('.view-sub')).toContainText(`WEEK ${WEEK} · SIM EV`);
    await expect(page.locator('.scopeseg')).toHaveCount(1);
    await expect(page.locator('.pw-wkbar .wk-chip')).toHaveCount(2);
    await page.click(`.pw-wkbar .wk-chip[data-wk="${CUR}"]`);
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await expect(page.locator('#parlays-list .state')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
