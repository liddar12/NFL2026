/* tests/web/r70_lines.spec.mjs — R70 (project `web`): the LINE REPORT chips.
 *
 * data/line_report.json is STUBBED at the network layer (page.route) so the
 * spec is exact and independent of whatever the live pipeline last wrote:
 *   - LINEUP: with a report for the week on screen, every offence starter row
 *     whose team / opponent the stub lists shows "OL: n out" / "vs DL: n out"
 *     (names in the title) and the legend says the chips change no number;
 *     with a 404 there is no chip and no legend — no placeholder either.
 *   - GRADE: the Sleeper loader (P.T.I. fixtures, Sleeper mocked) opens the
 *     first team's week fold and the starter rows carry the chip; 404 -> none.
 *   - PLAYERS: with AI+ persisted on, the card headline carries the chip after
 *     the BASE line (the r51-pinned .p-unit order intact) and the legend is
 *     its own element beside the AI+ note; 404 -> nothing.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));
const readFix = (name) =>
  readFileSync(new URL(`../fixtures/sleeper_pti/${name}`, import.meta.url), 'utf8');

const PROJ = readData('player_projections.json');
const WEEKLY = readData('player_weekly.json');
const WEEK = Number(readData('game_predictions.json').week) || 1;

/** First `n` committed projection ids for a position (the shipped pool). */
function idsFor(pos, n) {
  return PROJ.players.filter((p) => String(p.position).toUpperCase() === pos).slice(0, n)
    .map((p) => p.gsis_id);
}
const teamOf = (id) => String((PROJ.players.find((p) => p.gsis_id === id) || {}).team || '').toUpperCase();
const oppOf = (id, wk) => {
  const w = WEEKLY.players.find((p) => String(p.gsis_id) === String(id));
  const row = w && w.weeks.find((x) => Number(x.wk) === wk);
  return row && row.opp ? String(row.opp).toUpperCase() : null;
};

/** A stub report: every NFL team in the pool gets "OL: 1 out"; `outDl` teams
 *  also get a DL-front starter out. */
function stubReport(week, outDl = []) {
  const teams = {};
  for (const t of new Set(PROJ.players.map((p) => String(p.team || '').toUpperCase()).filter(Boolean))) {
    teams[t] = {
      ol: { starters: 5, names: [`${t} Tackle`, `${t} Guard`], out: [`${t} Tackle`], doubtful: [], questionable: [] },
      dl: { starters: 4, names: [`${t} End`], out: outDl.includes(t) ? [`${t} End`] : [], doubtful: [], questionable: [] },
    };
  }
  return {
    season: 2026, week, generated_utc: '2026-09-10T00:00:00Z', available: true, reason: null,
    source: 'stub', snapshot: '2026-09-10', positions: { ol: ['LT'], dl: ['LDE'] }, teams,
    counts: { teams: Object.keys(teams).length, ol_starters: 0, dl_starters: 0, ol_out: 0, dl_out: 0,
      ol_doubtful: 0, dl_doubtful: 0, ol_questionable: 0, dl_questionable: 0, starters_matched: 0 },
  };
}

async function stubLineReport(page, doc) {
  await page.route('**/data/line_report.json', (r) => (doc
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
    : r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })));
}

const NO_CHIP = async (page) => {
  expect(await page.locator('.line-chip').count()).toBe(0);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/LINE REPORT/);
};

test.describe('R70 — LINE REPORT chips', () => {
  const slots = (() => {
    const [qb] = idsFor('QB', 1);
    const [rb1, rb2, rb3] = idsFor('RB', 3);
    const [wr1, wr2] = idsFor('WR', 2);
    const [te] = idsFor('TE', 1);
    return { QB1: qb, RB1: rb1, RB2: rb2, WR1: wr1, WR2: wr2, TE1: te, FLEX: rb3 };
  })();

  test('#/lineup: chips on starter rows with the names on title, and the legend; none on a 404', async ({ page }) => {
    const qbTeam = teamOf(slots.QB1);
    const qbOpp = oppOf(slots.QB1, WEEK);
    await stubLineReport(page, stubReport(WEEK, qbOpp ? [qbOpp] : []));
    await page.addInitScript((s) => {
      localStorage.setItem('nfl2026.unlock.v1', '1');
      localStorage.removeItem('nfl2026.league.v1');
      localStorage.removeItem('nfl2026.nflweek.v1');
      localStorage.setItem('nfl2026.team.v1', JSON.stringify({ slots: s }));
    }, slots);
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });
    await expect(page.locator('.lu-wkbar .wk-chip--active')).toHaveText(`WK ${WEEK}`);

    const chips = page.locator('.lu-card .lu-row .line-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(7);
    const texts = await chips.allInnerTexts();
    for (const t of texts) expect(t).toMatch(/^(OL: 1 out|vs DL: 1 out)$/);
    expect(texts.filter((t) => t === 'OL: 1 out').length).toBeGreaterThanOrEqual(7);
    const own = page.locator('.lu-card .lu-row .line-chip--out', { hasText: 'OL: 1 out' }).first();
    await expect(own).toHaveAttribute('title', /^Own offensive line out: [A-Z]{2,3} Tackle$/);
    if (qbOpp) {
      const qbRow = page.locator('.lu-card .lu-row', { hasText: 'vs DL: 1 out' }).first();
      await expect(qbRow.locator('.line-chip', { hasText: 'vs DL' }))
        .toHaveAttribute('title', `Opposing defensive front out: ${qbOpp} End`);
      await expect(qbRow).toContainText(qbTeam);
    }
    await expect(page.locator('.lu-linenote')).toHaveCount(1);
    await expect(page.locator('.lu-linenote')).toContainText('change no number');
    // Another week: the report is for WEEK only -> no chip, no legend.
    const other = WEEK === 1 ? 2 : 1;
    await page.locator(`.lu-wkbar .wk-chip[data-wk="${other}"]`).click();
    await expect(page.locator('.lu-wkbar .wk-chip--active')).toHaveText(`WK ${other}`);
    expect(await page.locator('.lu-card .line-chip').count()).toBe(0);
    await expect(page.locator('.lu-linenote')).toHaveCount(0);
  });

  test('#/lineup: a 404 renders no chip and no legend', async ({ page }) => {
    await stubLineReport(page, null);
    await page.addInitScript((s) => {
      localStorage.setItem('nfl2026.unlock.v1', '1');
      localStorage.removeItem('nfl2026.league.v1');
      localStorage.setItem('nfl2026.team.v1', JSON.stringify({ slots: s }));
    }, slots);
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card', { timeout: 15000 });
    await expect(page.locator('.lu-total').first()).toHaveText(/^\d+\.\d pts/);
    await NO_CHIP(page);
    await expect(page.locator('.lu-linenote')).toHaveCount(0);
  });

  test('#/grade: the week fold carries the chip with a report and nothing on a 404', async ({ page }) => {
    const LEAGUE_ID = '1367481303166914560';
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });
    await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}`, (r) => json(r, readFix('league.json')));
    await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`, (r) => json(r, readFix('rosters.json')));
    await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/users`, (r) => json(r, readFix('users.json')));
    await page.route(`**/api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/*`, (r) => {
      const wk = Number(r.request().url().split('/').pop());
      json(r, (wk >= 1 && wk <= 14) ? readFix(`matchups_${wk}.json`) : '[]');
    });
    await page.route('**/api.sleeper.app/v1/players/nfl', (r) => json(r, readFix('player_index_trimmed.json')));
    await page.route('**/api.sleeper.app/v1/draft/**', (r) => json(r, 'null', 404));
    await page.route('**/data/sleeper_projections.json', (r) => json(r, 'null', 404));
    // The fold shows every week; the report is for WEEK 1 of the league's
    // schedule so the first fold is the one that carries chips.
    let serve = stubReport(1);
    await page.route('**/data/line_report.json', (r) => (serve
      ? json(r, JSON.stringify(serve)) : json(r, 'not found', 404)));
    await page.addInitScript(() => {
      localStorage.setItem('nfl2026.unlock.v1', '1');
      localStorage.removeItem('nfl2026.league.v1');
      localStorage.removeItem('nfl2026.league_id.v1');
      localStorage.removeItem('nfl2026.scoring.v1');
    });

    await page.goto('/#/grade');
    await page.waitForSelector('#gr-league-id', { timeout: 15000 });
    await page.locator('#gr-league-id').fill(LEAGUE_ID);
    await page.locator('#gr-load').click();
    await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 60000 });
    const first = page.locator('.gr-card--team').first();
    await first.locator('details.gr-weeks summary').click();
    const wk1 = first.locator('.gr-week').first();
    await expect(wk1).toBeVisible();
    await expect(wk1.locator('.gr-week-head')).toContainText('WK 1');
    const chips = wk1.locator('.gr-slot .line-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
    for (const t of await chips.allInnerTexts()) expect(t).toMatch(/^(OL: 1 out|vs DL: 1 out)$/);
    // Week 2 fold: the report is not for it -> no chip.
    expect(await first.locator('.gr-week').nth(1).locator('.line-chip').count()).toBe(0);
    await expect(page.locator('#gr-league-out .gr-assumptions')).toContainText('LINE REPORT chips');

    // 404 on a FRESH DOCUMENT: app/data.js caches the resolved contract for the
    // life of the page, so a hash-only navigation would reuse the report above.
    serve = null;
    await page.reload();
    await page.waitForSelector('#gr-league-id', { timeout: 15000 });
    await page.locator('#gr-league-id').fill(LEAGUE_ID);
    await page.locator('#gr-load').click();
    await expect(page.locator('.gr-standings tbody tr')).toHaveCount(10, { timeout: 60000 });
    await page.locator('.gr-card--team').first().locator('details.gr-weeks summary').click();
    await NO_CHIP(page);
  });

  test('#/players: AI+ on -> chip after the BASE line and a legend beside the note; 404 -> nothing', async ({ page }) => {
    await stubLineReport(page, stubReport(WEEK));
    await page.addInitScript(() => {
      localStorage.setItem('nfl2026.unlock.v1', '1');
      localStorage.removeItem('nfl2026.league.v1');
      localStorage.removeItem('nfl2026.nflweek.v1');
      localStorage.setItem('nfl2026.ai.v1', 'on');
    });
    await page.goto('/#/players');
    await page.waitForSelector('.card.player', { timeout: 15000 });
    const first = page.locator('.card.player').first();
    await expect(first.locator('.p-unit').nth(0)).toHaveText(new RegExp(`^WK ${WEEK} · `));
    await expect(first.locator('.p-unit').nth(1)).toHaveText(/^BASE \d+\.\d · SEASON$/);
    const chip = first.locator('.p-line .line-chip').first();
    await expect(chip).toHaveText('OL: 1 out');
    expect(await page.locator('.card.player .p-line .line-chip').count()).toBeGreaterThanOrEqual(10);
    await expect(page.locator('.ai-note')).toHaveCount(1);
    await expect(page.locator('.line-legend')).toHaveCount(1);
    await expect(page.locator('.line-legend')).toContainText('change no number');
    // BASE hides the chips and the legend (they belong to the AI+ view).
    await page.locator('.aiseg button[data-ai="off"]').click();
    expect(await page.locator('.p-line').count()).toBe(0);
    await expect(page.locator('.line-legend')).toHaveCount(0);
  });

  test('#/players: AI+ on with a 404 renders the note alone — no chip, no legend', async ({ page }) => {
    await stubLineReport(page, null);
    await page.addInitScript(() => {
      localStorage.setItem('nfl2026.unlock.v1', '1');
      localStorage.removeItem('nfl2026.league.v1');
      localStorage.setItem('nfl2026.ai.v1', 'on');
    });
    await page.goto('/#/players');
    await page.waitForSelector('.card.player', { timeout: 15000 });
    await expect(page.locator('.ai-note')).toHaveCount(1);
    await expect(page.locator('.line-legend')).toHaveCount(0);
    expect(await page.locator('.p-line').count()).toBe(0);
    await NO_CHIP(page);
  });
});
