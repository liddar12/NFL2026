/* tests/web/r108_excluded.spec.mjs — R108 owner-excluded cards leave the PARLAYS
 * list, in the browser (project `web`).
 *
 * Same fixture-serving pattern as r73: the committed parlays.json is the CURRENT
 * week (WEEK+1, cards carry NO card_id — the client must derive it the archive
 * writer's way) and, re-keyed, the WEEK archive (cards STAMPED with card_id, ids
 * suffixed "-a"). review.json lists two of the game cards in each week's
 * `excluded_cards`, with the ids computed by scripts/build_parlay_archive.card_id
 * itself, so the browser is checked against the Python rule, not a copy of it.
 * Proves: both weeks paint every game card except the two listed; a week listing
 * none paints them all; nothing throws.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PARLAYS = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const WEEK = Number(PARLAYS.week);      // archived (past) week
const CUR = WEEK + 1;                   // current week (parlays.json's)
const SEASON = Number(PARLAYS.season);
const ARCHIVE_PATH = `data/parlays/${SEASON}_wk${String(WEEK).padStart(2, '0')}.json`;
const GAME = PARLAYS.parlays.filter((p) => p.scope !== 'week');
const HIDE = GAME.slice(0, 2);          // the two cards each week lists

// card_id by the archive writer's own function (Python), for every committed card.
const IDS = JSON.parse(execFileSync('python3', ['-c', [
  'import json, sys',
  'sys.path.insert(0, ".")',
  'from scripts.build_parlay_archive import card_id',
  'doc = json.load(open("data/parlays.json"))',
  'print(json.dumps([card_id(c) for c in doc["parlays"]]))',
].join('\n')], { cwd: ROOT, encoding: 'utf8' }));
const idOf = (p) => IDS[PARLAYS.parlays.indexOf(p)];

const currentDoc = () => ({ ...JSON.parse(JSON.stringify(PARLAYS)), week: CUR });
function archiveDoc() {
  const doc = JSON.parse(JSON.stringify(PARLAYS));
  doc.week = WEEK;
  doc.parlays.forEach((p, i) => { p.card_id = IDS[i]; p.parlay_id = `${p.parlay_id}-a`; });
  doc.closed = true;
  return doc;
}
const indexDoc = () => ({
  season: SEASON, current_week: CUR,
  weeks: [{ week: WEEK, path: ARCHIVE_PATH, closed: true },
    { week: CUR, path: `data/parlays/${SEASON}_wk${String(CUR).padStart(2, '0')}.json`, closed: false }],
});
const reviewDoc = (excluded) => ({
  season: SEASON, generated_utc: 't', sources: {}, notes: [], players_season: {},
  learning: { graded_locks_total: 0, refit: null, consumed_all: null, note: 'n' },
  weeks: Object.fromEntries([WEEK, CUR].map((w) => [String(w), {
    games: [], players: [], parlays: [],
    ...(excluded ? { excluded_cards: HIDE.map(idOf).sort() } : {}),
  }])),
});

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body });
async function routeAll(page, excluded = true) {
  await page.route('**/data/parlays.json', (r) => json(r, JSON.stringify(currentDoc())));
  await page.route('**/data/parlays/index.json', (r) => json(r, JSON.stringify(indexDoc())));
  await page.route(`**/${ARCHIVE_PATH}`, (r) => json(r, JSON.stringify(archiveDoc())));
  await page.route('**/data/review.json', (r) => json(r, JSON.stringify(reviewDoc(excluded))));
}
const cardIds = (page) => page.locator('.card.parlay').evaluateAll((els) => els.map((e) => e.dataset.parlayId));
const errorsOf = (page) => { const e = []; page.on('pageerror', (x) => e.push(String(x))); return e; };

test.describe('R108 — owner-excluded cards are not painted', () => {
  test.skip(GAME.length < 3, 'needs at least three committed game cards');

  test('current week (unstamped cards) and archived week (stamped) both drop exactly the listed cards', async ({ page }) => {
    const errors = errorsOf(page);
    await routeAll(page);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await expect(page.locator('.card.parlay')).toHaveCount(GAME.length - HIDE.length, { timeout: 15000 });
    const cur = await cardIds(page);
    for (const p of HIDE) expect(cur).not.toContain(p.parlay_id);
    expect(cur).toEqual(GAME.filter((p) => !HIDE.includes(p)).map((p) => p.parlay_id));

    await page.click(`.pw-wkbar .wk-chip[data-wk="${WEEK}"]`);
    await expect(page.locator('.card.parlay').first()).toHaveAttribute('data-parlay-id', /-a$/, { timeout: 15000 });
    await expect(page.locator('.card.parlay')).toHaveCount(GAME.length - HIDE.length, { timeout: 15000 });
    const past = await cardIds(page);
    for (const p of HIDE) expect(past).not.toContain(`${p.parlay_id}-a`);

    // back to the current week: still hidden, without waiting on a new review load
    await page.click(`.pw-wkbar .wk-chip[data-wk="${CUR}"]`);
    await expect(page.locator('.card.parlay')).toHaveCount(GAME.length - HIDE.length, { timeout: 15000 });
    expect(errors).toEqual([]);
  });

  test('a review listing no excluded cards paints every card', async ({ page }) => {
    const errors = errorsOf(page);
    await routeAll(page, false);
    await page.goto('/#/parlays');
    await page.waitForSelector('.card.parlay', { timeout: 15000 });
    await page.waitForTimeout(500);   // give a (wrong) hide the chance to land
    await expect(page.locator('.card.parlay')).toHaveCount(GAME.length);
    expect(errors).toEqual([]);
  });
});
