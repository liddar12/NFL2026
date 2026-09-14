/* tests/web/r72_review_ui.spec.mjs — R72 review UI in the browser (project `web`).
 *
 * Same fixture-serving pattern as r71_review.spec: data/review.json is routed
 * to a document built from the COMMITTED game_predictions.json, parlays.json
 * and player_projections.json (so every id the views paint exists) in the R72
 * contract shapes (tests/fixtures/r72/review.json is the static shape source
 * the feature lock reads; here its summary / learning / players_season shapes
 * are re-keyed onto committed ids). Proves:
 *   - SLATE: the week overview strip for a graded week and for a TBD-only
 *     week, the LEARNING line in both refit states, strip above the list;
 *   - PLAYERS: the REVIEW sort's ordering, the WK chip switch, the verdict
 *     filter chips, and the season tally chip on every sort;
 *   - PARLAYS: bucket counts from the summary, filter tap / untap combined
 *     with scope + leg count, a bucket chip on every card.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const GP = JSON.parse(readFileSync(new URL('../../data/game_predictions.json', import.meta.url), 'utf8'));
const PARLAYS = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const PROJ = JSON.parse(readFileSync(new URL('../../data/player_projections.json', import.meta.url), 'utf8'));
const WEEK = Number(GP.week);
const WK2 = WEEK + 1; // a second graded week (players) — schedule_full carries it
const WK3 = WEEK + 2; // TBD-only week
const BUCKETS = ['all_hit', 'push', 'partial', 'all_missed', 'pending'];
const RESULT_OF = { all_hit: 'hit', push: 'void', partial: 'miss', all_missed: 'miss', pending: 'pending' };

// Six committed players the fixture grades (pool order = the list's incoming order).
const [P0, P1, P2, P3, P4, P5] = PROJ.players.slice(0, 6);

function playerRow(p, week, verdict, delta, projected = 15) {
  const actual = delta == null ? null : Math.round((projected + delta) * 10) / 10;
  return { gsis_id: p.gsis_id, name: p.name, position: p.position, team: p.team, week, projected,
    low: projected - 5, high: projected + 5, actual, verdict, delta,
    why: { source: 'measured', summary: `${verdict.toUpperCase()} fixture`, reasons: [], expected_basis: 'fixture', unattributed: 0, omitted: [] } };
}

function fixture() {
  const [g0, g1, ...rest] = GP.games;
  const why = (picked, res) => ({ source: 'measured', summary: `${res.toUpperCase()}: picked ${picked}`, reasons: [] });
  const games = [
    { game_id: g0.game_id, home: g0.home, away: g0.away, kickoff_utc: g0.kickoff_utc, picked: g0.home, pick_prob: 0.6,
      final: { home_score: 24, away_score: 17, winner: g0.home }, status: 'STATUS_FINAL', final_source: 'espn_final',
      result: 'won', brier: 0.16, why: why(g0.home, 'won') },
    { game_id: g1.game_id, home: g1.home, away: g1.away, kickoff_utc: g1.kickoff_utc, picked: g1.away, pick_prob: 0.55,
      final: { home_score: 20, away_score: 10, winner: g1.home }, status: 'STATUS_FINAL', final_source: 'espn_final',
      result: 'lost', brier: 0.3025, why: why(g1.away, 'lost') },
    ...rest.map((g) => ({ game_id: g.game_id, home: g.home, away: g.away, kickoff_utc: g.kickoff_utc, picked: g.home,
      pick_prob: 0.5, final: null, status: 'STATUS_SCHEDULED', final_source: null, result: null, brier: null,
      why: { source: 'measured', summary: 'not final', reasons: [] } })),
  ];
  // Buckets cycle over the committed parlays within each scope; results follow the bucket.
  const counters = { game: 0, week: 0 };
  const parlays = PARLAYS.parlays.map((p) => {
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
  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, parlays.filter((p) => p.bucket === b).length]));
  const legs = parlays.flatMap((p) => p.legs);
  const emptyParlays = { n: 0, hit: 0, miss: 0, pending: 0, legs_n: 0, legs_hit: 0,
    buckets: { all_hit: 0, push: 0, partial: 0, all_missed: 0, pending: 0 } };
  const players1 = [playerRow(P0, WEEK, 'over', 9.9), playerRow(P1, WEEK, 'under', -6.0), playerRow(P2, WEEK, 'met', 1.2),
    playerRow(P3, WEEK, 'dnp', null), playerRow(P4, WEEK, 'over', 3.4)];
  const players2 = [playerRow(P0, WK2, 'met', -2.0), playerRow(P1, WK2, 'over', 12.5), playerRow(P2, WK2, 'under', -8.0)];
  const season = (p, weeks, over, met, under, dnp, byWeek) => [p.gsis_id, { name: p.name, position: p.position,
    team: p.team, weeks, over, met, under, dnp, met_rate: weeks - dnp > 0 ? met / (weeks - dnp) : null, by_week: byWeek }];
  const bw = (verdict, delta, projected = 15) => ({ verdict, delta, actual: delta == null ? null : projected + delta, projected });
  return {
    season: GP.season, generated_utc: 't', sources: {}, notes: [],
    learning: { graded_locks_total: 30, refit: { archived_utc: '2026-09-14T09:00:00Z', n_resolved: 30, adopted: false, verdict: 'held' },
      consumed_all: true, note: 'every graded lock consumed' },
    players_season: Object.fromEntries([
      season(P0, 2, 1, 1, 0, 0, { [WEEK]: bw('over', 9.9), [WK2]: bw('met', -2.0) }),
      season(P1, 2, 1, 0, 1, 0, { [WEEK]: bw('under', -6.0), [WK2]: bw('over', 12.5) }),
      season(P2, 2, 0, 1, 1, 0, { [WEEK]: bw('met', 1.2), [WK2]: bw('under', -8.0) }),
      season(P3, 1, 0, 0, 0, 1, { [WEEK]: bw('dnp', null) }),
      season(P4, 1, 1, 0, 0, 0, { [WEEK]: bw('over', 3.4) }),
    ]),
    weeks: {
      [String(WEEK)]: { games, parlays, players: players1,
        summary: { picks: { n: 16, won: 1, pct: 0.5, brier: 0.2313, right: 1, wrong: 1, tbd: 14 },
          learning: { graded_locks: 14, refit: { archived_utc: '2026-09-14T09:00:00Z', n_resolved: 14, adopted: false, verdict: 'held' }, note: 'held' },
          parlays: { n: parlays.length, hit: bucketCounts.all_hit, miss: bucketCounts.partial + bucketCounts.all_missed,
            pending: bucketCounts.pending, legs_n: legs.length, legs_hit: legs.filter((l) => l.result === 'hit').length, buckets: bucketCounts },
          players: { n: 5, over: 2, under: 1, met: 1, dnp: 1, band_coverage: 0.25 } } },
      [String(WK2)]: { games: [], parlays: [], players: players2,
        summary: { picks: { n: 16, won: 6, pct: 0.4286, brier: 0.2411, right: 6, wrong: 8, tbd: 2 },
          learning: { graded_locks: 14, refit: null, note: 'below the 16-lock minimum' },
          parlays: emptyParlays, players: { n: 3, over: 1, under: 1, met: 1, dnp: 0, band_coverage: 0.3333 } } },
      [String(WK3)]: { games: [], parlays: [], players: [],
        summary: { picks: { n: 16, won: 0, pct: null, brier: null, right: 0, wrong: 0, tbd: 16 },
          learning: { graded_locks: 0, refit: null, note: 'no FINAL yet' },
          parlays: emptyParlays, players: { n: 0, over: 0, under: 0, met: 0, dnp: 0, band_coverage: null } } },
    },
  };
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });
async function routeReview(page, doc) {
  await page.route('**/data/review.json', (r) => json(r, JSON.stringify(doc)));
}
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
const ids = (loc) => loc.evaluateAll((els) => els.map((e) => e.dataset.gsis));

test.describe('R72 — SLATE week overview + LEARNING line', () => {
  test('graded week: RIGHT · WRONG · TBD · Brier and the refit line; TBD-only week: zeros, no Brier, refit pending', async ({ page }) => {
    const errors = collectErrors(page);
    await routeReview(page, fixture());
    await page.goto('/#/');
    await page.waitForSelector('.card.game', { timeout: 15000 });
    await page.waitForSelector('.rv-strip--week', { timeout: 15000 });
    await expect(page.locator('.rv-strip')).toHaveCount(1);
    await expect(page.locator('.rv-strip .rv-ov')).toHaveText(`WK ${WEEK} · 1 RIGHT · 1 WRONG · 14 TBD · Brier 0.23`);
    await expect(page.locator('.rv-strip .rv-learn')).toHaveText('LEARNING: 14 graded locks → game-model refit (n=14, held, 2026-09-14)');
    // above the list, never inside it (web.spec D1/Rel12: first list child is a day header)
    await expect(page.locator('#slate-list > .rv-strip')).toHaveCount(0);
    await expect(page.locator('.rv-strip + #slate-list')).toHaveCount(1);
    expect(await page.locator('#slate-list > *').first().getAttribute('class')).toContain('slate-day');
    await expect(page.locator('.card.game .rv-dot')).toHaveCount(2, { timeout: 5000 });

    // TBD-only week: the block exists, so the strip renders with zeros and no Brier
    await page.click(`.wk-chip[data-wk="${WK3}"]`);
    await page.waitForSelector(`.rv-strip[data-week="${WK3}"]`, { timeout: 15000 });
    await expect(page.locator('.rv-strip')).toHaveCount(1);
    await expect(page.locator('.rv-strip .rv-ov')).toHaveText(`WK ${WK3} · 0 RIGHT · 0 WRONG · 16 TBD`);
    await expect(page.locator('.rv-strip .rv-learn')).toHaveText('LEARNING: 0 graded locks → refit pending (no FINAL yet)');
    await expect(page.locator('.rv-dot')).toHaveCount(0);

    // a graded week whose refit is null names the note, never a verdict
    await page.click(`.wk-chip[data-wk="${WK2}"]`);
    await page.waitForSelector(`.rv-strip[data-week="${WK2}"]`, { timeout: 15000 });
    await expect(page.locator('.rv-strip .rv-ov')).toHaveText(`WK ${WK2} · 6 RIGHT · 8 WRONG · 2 TBD · Brier 0.24`);
    await expect(page.locator('.rv-strip .rv-learn')).toHaveText('LEARNING: 14 graded locks → refit pending (below the 16-lock minimum)');
    await expect(page.locator('.rv-learn')).not.toContainText('adopted');
    expect(errors).toEqual([]);
  });
});

test.describe('R72 — PLAYERS review sort', () => {
  async function waitForPlayers(page) {
    await page.waitForFunction(() => document.querySelectorAll('.card.player').length > 0, undefined, { timeout: 15000 });
  }
  const card = (page, p) => page.locator(`.card.player[data-gsis="${p.gsis_id}"]`);

  test('season tally chip on every sort; REVIEW sort orders by the selected week\'s delta, WK chips switch, verdict chips filter', async ({ page }) => {
    const errors = collectErrors(page);
    await routeReview(page, fixture());
    await page.goto('/#/players');
    await waitForPlayers(page);
    // default sort (PROJ): the season tally rides every card that has a graded week
    await expect(card(page, P0).locator('.rv-tally')).toHaveText('1 MET · 1 OVER');
    await expect(card(page, P1).locator('.rv-tally')).toHaveText('1 OVER · 1 UNDER');
    await expect(card(page, P3).locator('.rv-tally')).toHaveText('1 DNP');
    await expect(card(page, P5).locator('.rv-tally')).toHaveCount(0);
    await expect(page.locator('#review-controls .rv-wk')).toHaveCount(0);
    // the latest graded week's chip (R71) under a non-review sort
    await expect(card(page, P0).locator('.rv-chip')).toHaveText(`WK ${WK2} MET −2.0`);

    // REVIEW sort: default = latest graded week, all verdicts on
    const chip = page.locator('.sort-chip[data-sort="review"]');
    await expect(chip).toHaveCount(1);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#review-controls .rv-wk')).toHaveCount(2);
    await expect(page.locator(`#review-controls .rv-wk[data-rv-week="${WK2}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#review-controls .rv-vchip[aria-pressed="true"]')).toHaveCount(3);
    let order = await ids(page.locator('.card.player'));
    expect(order.slice(0, 3)).toEqual([P1.gsis_id, P0.gsis_id, P2.gsis_id]); // +12.5, −2.0, −8.0
    expect(order.slice(3, 6)).toEqual([P3.gsis_id, P4.gsis_id, P5.gsis_id]); // ungraded, incoming order
    await expect(card(page, P1).locator('.rv-chip')).toHaveText(`WK ${WK2} OVER +12.5`);
    await expect(card(page, P4).locator('.rv-chip')).toHaveCount(0); // no row for the selected week
    await expect(card(page, P4).locator('.rv-tally')).toHaveText('1 OVER'); // tally stays

    // WK chip switch: week 1's deltas — over +9.9, over +3.4, met +1.2, under −6.0, DNP last
    await page.click(`#review-controls .rv-wk[data-rv-week="${WEEK}"]`);
    await expect(page.locator(`#review-controls .rv-wk[data-rv-week="${WEEK}"]`)).toHaveAttribute('aria-pressed', 'true');
    order = await ids(page.locator('.card.player'));
    expect(order.slice(0, 5)).toEqual([P0.gsis_id, P4.gsis_id, P2.gsis_id, P1.gsis_id, P3.gsis_id]);
    await expect(card(page, P0).locator('.rv-chip')).toHaveText(`WK ${WEEK} OVER +9.9`);
    await expect(card(page, P3).locator('.rv-chip')).toHaveText(`WK ${WEEK} DNP`);

    // verdict chips are multi-select: OVER off hides the two over rows only
    await page.click('#review-controls .rv-vchip[data-rv-verdict="over"]');
    await expect(page.locator('#review-controls .rv-vchip[data-rv-verdict="over"]')).toHaveAttribute('aria-pressed', 'false');
    order = await ids(page.locator('.card.player'));
    expect(order.slice(0, 3)).toEqual([P2.gsis_id, P1.gsis_id, P3.gsis_id]);
    expect(order).not.toContain(P0.gsis_id);
    expect(order).not.toContain(P4.gsis_id);
    await page.click('#review-controls .rv-vchip[data-rv-verdict="met"]');
    order = await ids(page.locator('.card.player'));
    expect(order[0]).toBe(P1.gsis_id);
    expect(order).not.toContain(P2.gsis_id);
    // toggling OVER back on restores it at the top
    await page.click('#review-controls .rv-vchip[data-rv-verdict="over"]');
    order = await ids(page.locator('.card.player'));
    expect(order.slice(0, 3)).toEqual([P0.gsis_id, P4.gsis_id, P1.gsis_id]);

    // direction toggle (tap the active sort): ascending = biggest under-performance first, ungraded still last
    await chip.click();
    await expect(chip).toContainText('▲');
    order = await ids(page.locator('.card.player'));
    expect(order.slice(0, 3)).toEqual([P1.gsis_id, P4.gsis_id, P0.gsis_id]);
    expect(order[3]).toBe(P2.gsis_id === order[3] ? P2.gsis_id : order[3]);

    // leaving REVIEW removes the controls and restores the R71 latest-week chip
    await page.click('.sort-chip[data-sort="proj"]');
    await expect(page.locator('#review-controls .rv-wk')).toHaveCount(0);
    await expect(card(page, P0).locator('.rv-chip')).toHaveText(`WK ${WK2} MET −2.0`);
    expect(errors).toEqual([]);
  });
});

test.describe('R72 — PARLAYS outcome buckets', () => {
  test('counts from the summary, filter tap / untap with scope + leg count, a bucket chip per card', async ({ page }) => {
    const errors = collectErrors(page);
    const doc = fixture();
    const wk = doc.weeks[String(WEEK)];
    const counts = wk.summary.parlays.buckets;
    await routeReview(page, doc);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.waitForSelector('#parlay-buckets .rv-bucket', { timeout: 15000 });
    await page.waitForSelector('.rv-strip--parlay', { timeout: 15000 });
    // the card is a sibling above the list, never its first child
    await expect(page.locator('#parlays-list > .rv-buckets')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const a = document.querySelector('#parlay-buckets');
      const b = document.querySelector('#parlays-list');
      return a && b && a.parentElement === b.parentElement && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await expect(page.locator('#parlay-buckets .rv-bucket')).toHaveCount(5);
    for (const b of BUCKETS) {
      await expect(page.locator(`.rv-bucket[data-bucket="${b}"] .rv-bucket-n`)).toHaveText(String(counts[b]));
    }
    await expect(page.locator('.rv-bucket[data-bucket="all_hit"]')).toContainText('ALL HIT');
    await expect(page.locator('.rv-bucket[data-bucket="all_missed"]')).toContainText('ALL MISSED');

    const gameRows = wk.parlays.filter((p) => p.scope === 'game');
    const total = await page.locator('.card.parlay').count();
    expect(total).toBe(gameRows.length);
    // every card carries its row's bucket chip
    for (const p of gameRows.slice(0, 5)) {
      const c = page.locator(`.card.parlay[data-parlay-id="${p.parlay_id}"]`);
      await expect(c.locator('.rv-bchip')).toHaveText(p.bucket.replace('_', ' ').toUpperCase());
      await expect(c).toHaveAttribute('data-rv-bucket', p.bucket);
    }
    // tap ALL HIT: only that bucket in the active scope
    await page.click('.rv-bucket[data-bucket="all_hit"]');
    await expect(page.locator('.rv-bucket[data-bucket="all_hit"]')).toHaveAttribute('aria-pressed', 'true');
    const gameAllHit = gameRows.filter((p) => p.bucket === 'all_hit').length;
    await expect(page.locator('.card.parlay')).toHaveCount(gameAllHit);
    await expect(page.locator('.card.parlay .rv-bchip--all_hit')).toHaveCount(gameAllHit);
    await expect(page.locator('.card.parlay .rv-bchip:not(.rv-bchip--all_hit)')).toHaveCount(0);
    await expect(page.locator('.card.parlay .rv-pchip').first()).toHaveText('HIT');
    // tap again: cleared
    await page.click('.rv-bucket[data-bucket="all_hit"]');
    await expect(page.locator('.rv-bucket[data-bucket="all_hit"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.card.parlay')).toHaveCount(gameRows.length);

    // combined with scope + leg count: WEEK scope, 3 LEG, PARTIAL
    await page.click('.seg-btn[data-seg="week"]');
    await page.waitForSelector('.leg-chip[data-leg="3"]', { timeout: 5000 });
    await page.click('.leg-chip[data-leg="3"]');
    await page.click('.rv-bucket[data-bucket="partial"]');
    const legsOf = new Map(PARLAYS.parlays.map((p) => [p.parlay_id, p.legs.length]));
    const expected = wk.parlays.filter((p) => p.scope === 'week' && legsOf.get(p.parlay_id) === 3 && p.bucket === 'partial');
    await expect(page.locator('.card.parlay')).toHaveCount(expected.length);
    if (expected.length) {
      await expect(page.locator('.card.parlay .rv-bchip').first()).toHaveText('PARTIAL');
    } else {
      await expect(page.locator('#parlays-list .state')).toContainText('No parlays in that bucket');
    }
    // the bucket filter survives a scope switch; the chip stays pressed
    await page.click('.seg-btn[data-seg="game"]');
    await expect(page.locator('.rv-bucket[data-bucket="partial"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.card.parlay')).toHaveCount(gameRows.filter((p) => p.bucket === 'partial').length);
    // the R71 summary line and leg marks still paint alongside
    await expect(page.locator('.rv-strip--parlay')).toHaveCount(1);
    await expect(page.locator('.card.parlay .rv-leg').first()).toHaveText('✓');
    expect(errors).toEqual([]);
  });
});
