/* tests/web/r71_review.spec.mjs — R71 post-game review in the browser (project `web`).
 *
 * data/review.json is produced by the runner (finals + stats), so the browser
 * proof routes a FIXTURE built from the COMMITTED game_predictions.json and
 * parlays.json (same ids the views paint) — exactly the way r51_parlay.spec
 * stamps R51 fields onto the committed document:
 *   - slate: game[0] graded WON (pick = home), game[1] graded LOST (pick =
 *     away), the rest ungraded -> filled circle on the winner's picked team,
 *     hollow ring on the loser's, no circle pre-final; the week strip; tapping
 *     a graded card reveals the measured why, and the AI NARRATIVE line only
 *     where a narrative is on file;
 *   - parlays: ✓ / ✗ / – per leg, HIT / MISS / PENDING per parlay, summary line;
 *   - ABSENT (404): nothing renders and no page error.
 * The pwa project's testMatch covers tests/pwa/ only, so this spec runs under
 * `web`; the same markup is what the installed app paints.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const GP = JSON.parse(readFileSync(new URL('../../data/game_predictions.json', import.meta.url), 'utf8'));
const PARLAYS = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const WEEK = Number(GP.week);

function fixture() {
  const [g0, g1, ...rest] = GP.games;
  const why = (picked, res) => ({
    source: 'measured', summary: `${res.toUpperCase()}: picked ${picked}`,
    reasons: [{ factor: 'confidence', points: null, text: `picked ${picked} at 60% (lock t, model elo_prior)` },
      { factor: 'margin', points: null, text: 'final 24-17 (home margin +7)' }],
  });
  const games = [
    { game_id: g0.game_id, home: g0.home, away: g0.away, kickoff_utc: g0.kickoff_utc,
      picked: g0.home, pick_prob: 0.6, final: { home_score: 24, away_score: 17, winner: g0.home },
      status: 'STATUS_FINAL', final_source: 'espn_final', result: 'won', brier: 0.16,
      why: why(g0.home, 'won'),
      narrative: { text: 'Restated: the pick won by 7.', source: 'ai_narrative', generated_utc: 't', why_hash: 'x' } },
    { game_id: g1.game_id, home: g1.home, away: g1.away, kickoff_utc: g1.kickoff_utc,
      picked: g1.away, pick_prob: 0.55, final: { home_score: 20, away_score: 10, winner: g1.home },
      status: 'STATUS_FINAL', final_source: 'espn_final', result: 'lost', brier: 0.3025,
      why: why(g1.away, 'lost') },
    ...rest.map((g) => ({ game_id: g.game_id, home: g.home, away: g.away, kickoff_utc: g.kickoff_utc,
      picked: g.home, pick_prob: 0.5, final: null, status: 'STATUS_SCHEDULED', final_source: null,
      result: null, brier: null, why: { source: 'measured', summary: 'not final', reasons: [] } })),
  ];
  const parlays = PARLAYS.parlays.map((p, i) => {
    const legs = p.legs.map((l, li) => ({ selection: l.selection, market: l.market, game_id: p.game_id || null,
      result: i === 0 ? 'hit' : (i === 1 ? (li === 0 ? 'hit' : 'miss') : 'pending'), actual: null, why: 'fixture' }));
    return { parlay_id: p.parlay_id, scope: p.scope, game_id: p.game_id || null,
      result: i === 0 ? 'hit' : (i === 1 ? 'miss' : 'pending'), legs };
  });
  const legs = parlays.flatMap((p) => p.legs);
  return {
    season: GP.season, generated_utc: 't',
    weeks: { [String(WEEK)]: { games, parlays, players: [],
      summary: { picks: { n: 2, won: 1, pct: 0.5, brier: 0.2313 },
        parlays: { n: parlays.length, hit: 1, miss: 1, pending: parlays.length - 2,
          legs_n: legs.length, legs_hit: legs.filter((l) => l.result === 'hit').length },
        players: { n: 0, over: 0, under: 0, met: 0, dnp: 0, band_coverage: null } } } },
    sources: {}, notes: [],
  };
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });

async function routeReview(page, doc) {
  await page.route('**/data/review.json', (r) => (doc == null
    ? json(r, 'Not Found', 404) : json(r, JSON.stringify(doc))));
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.describe('R71 — post-game review on #/ and #/parlays', () => {
  test('slate: won = filled circle on the picked team, lost = hollow ring, pre-final = nothing; strip; tap reveals the measured why', async ({ page }) => {
    const errors = collectErrors(page);
    const doc = fixture();
    await routeReview(page, doc);
    await page.goto('/#/');
    await page.waitForSelector('.card.game', { timeout: 15000 });
    await page.waitForSelector('.rv-strip', { timeout: 15000 });
    await expect(page.locator('.rv-strip')).toHaveText(`WK ${WEEK} REVIEW: 1/2 picks, Brier 0.23`);
    // The strip sits ABOVE the list, never as its first child: the slate's first
    // list child stays a day header (web.spec D1/Rel12 contract).
    await expect(page.locator('#slate-list > .rv-strip')).toHaveCount(0);
    await expect(page.locator('#slate-list + *, .rv-strip + #slate-list')).toHaveCount(1);
    const firstClass = await page.locator('#slate-list > *').first().getAttribute('class');
    expect(firstClass).toContain('slate-day');

    const [g0, g1, g2] = doc.weeks[String(WEEK)].games;
    const won = page.locator(`.card.game[data-game-id="${g0.game_id}"]`);
    const lost = page.locator(`.card.game[data-game-id="${g1.game_id}"]`);
    const pending = page.locator(`.card.game[data-game-id="${g2.game_id}"]`);
    await expect(won.locator('.team--home .rv-dot--won')).toHaveCount(1);
    await expect(won.locator('.team--away .rv-dot')).toHaveCount(0);
    await expect(lost.locator('.team--away .rv-dot--lost')).toHaveCount(1);
    await expect(lost.locator('.team--home .rv-dot')).toHaveCount(0);
    await expect(pending.locator('.rv-dot')).toHaveCount(0);
    await expect(page.locator('.card.game .rv-dot')).toHaveCount(2);
    // the filled circle is painted, the ring is hollow
    const bg = await won.locator('.rv-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
    const bgLost = await lost.locator('.rv-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgLost).toBe('rgba(0, 0, 0, 0)');

    // tap-to-reveal: hidden until tapped, AI NARRATIVE labeled only where on file.
    // R90/F20: the control is a real BUTTON inside the card (the article no
    // longer claims aria-expanded), so the tap targets .rv-why-btn.
    await expect(won.locator('.rv-why')).toBeHidden();
    await expect(won.locator('.rv-why-btn')).toHaveAttribute('aria-expanded', 'false');
    await won.locator('.rv-why-btn').click();
    await expect(won.locator('.rv-why')).toBeVisible();
    await expect(won.locator('.rv-why-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(won.locator('.rv-why-head')).toHaveText('WHY · MEASURED');
    await expect(won.locator('.rv-reason')).toHaveCount(2);
    await expect(won.locator('.rv-narr-label')).toHaveText('AI NARRATIVE');
    await expect(won.locator('.rv-narr-text')).toHaveText('Restated: the pick won by 7.');
    await lost.locator('.rv-why-btn').click();
    await expect(lost.locator('.rv-why')).toBeVisible();
    await expect(lost.locator('.rv-narr')).toHaveCount(0);
    await won.locator('.rv-why-btn').click();
    await expect(won.locator('.rv-why')).toBeHidden();
    await expect(pending.locator('.rv-why')).toHaveCount(0);
    await expect(pending.locator('.rv-why-btn')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('slate: switching weeks and back keeps exactly one strip and one circle per graded card', async ({ page }) => {
    await routeReview(page, fixture());
    await page.goto('/#/');
    await page.waitForSelector('.rv-strip', { timeout: 15000 });
    const other = WEEK === 18 ? 17 : WEEK + 1;
    await page.click(`.wk-chip[data-wk="${other}"]`);
    await page.waitForTimeout(600);
    await expect(page.locator('.rv-strip')).toHaveCount(0);
    await page.click(`.wk-chip[data-wk="${WEEK}"]`);
    await page.waitForSelector('.rv-strip', { timeout: 15000 });
    await expect(page.locator('.rv-strip')).toHaveCount(1);
    await expect(page.locator('.card.game .rv-dot')).toHaveCount(2);
  });

  test('ABSENT (404): no strip, no circles, no page error', async ({ page }) => {
    const errors = collectErrors(page);
    await routeReview(page, null);
    await page.goto('/#/');
    await page.waitForSelector('.card.game', { timeout: 15000 });
    await page.waitForTimeout(800);
    await expect(page.locator('.rv-strip')).toHaveCount(0);
    await expect(page.locator('.rv-dot')).toHaveCount(0);
    await expect(page.locator('.rv-why')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('parlays: ✓ / ✗ / – per leg, HIT / MISS / PENDING per parlay, summary line', async ({ page }) => {
    const errors = collectErrors(page);
    const doc = fixture();
    await routeReview(page, doc);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.waitForSelector('.rv-strip--parlay', { timeout: 15000 });
    const rv = doc.weeks[String(WEEK)].parlays;
    const s = doc.weeks[String(WEEK)].summary.parlays;
    await expect(page.locator('.rv-strip--parlay')).toContainText(`WK ${WEEK} PARLAYS: 1/${s.n} hit · legs ${s.legs_hit}/${s.legs_n}`);
    // the first two parlays are GAME-scope in the committed doc (scope tab default)
    const hit = rv.find((p) => p.result === 'hit');
    const miss = rv.find((p) => p.result === 'miss');
    const hitCard = page.locator(`.card.parlay[data-parlay-id="${hit.parlay_id}"]`);
    const missCard = page.locator(`.card.parlay[data-parlay-id="${miss.parlay_id}"]`);
    await expect(hitCard.locator('.rv-pchip')).toHaveText('HIT');
    await expect(hitCard.locator('.rv-leg--hit')).toHaveCount(hit.legs.length);
    await expect(missCard.locator('.rv-pchip')).toHaveText('MISS');
    await expect(missCard.locator('.legs > .leg').first().locator('.rv-leg')).toHaveText('✓');
    await expect(missCard.locator('.legs > .leg').nth(1).locator('.rv-leg')).toHaveText('✗');
    const pendingCard = page.locator('.card.parlay[data-rv-result="pending"]').first();
    await expect(pendingCard.locator('.rv-pchip')).toHaveText('PENDING');
    await expect(pendingCard.locator('.rv-leg').first()).toHaveText('–');
    // the leg-count selector still sees one node per leg (marks live INSIDE .leg)
    const counts = await hitCard.locator('.legs > *').count();
    expect(counts).toBe(hit.legs.length);
    expect(errors).toEqual([]);
  });
});
