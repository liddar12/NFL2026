/* tests/web/r101b_game_td.spec.mjs — R101b: the anytime-TD selector on GAME.
 *
 * GAME cards are same-game cards (scripts/build_atd_game_cards.py): every leg
 * from one game, priced by the pricer data/joint_backtest.json chose, offered
 * only at the sizes it validated. This spec builds the document from the
 * COMMITTED leg pool with the real builder, a schedule whose games are all still
 * to come and a fixed verdict (joint pricer; ALL TD 2-4, MAJORITY 3-5, 50%+ 2),
 * served through page.route — so it does not depend on the day it runs or on a
 * runner-written verdict. Skips (saying why) only when the committed pool offers
 * no anytime-TD leg at all (the model not adopted).
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pool = JSON.parse(readFileSync(join(ROOT, 'data/leg_pool.json'), 'utf8'));
const sched = JSON.parse(readFileSync(join(ROOT, 'data/schedule_full.json'), 'utf8'));
const atdLegs = pool.atd_legs || [];
test.skip(!atdLegs.length, 'the committed pool offers no anytime-TD leg (model not adopted)');

const poolGames = new Set([...atdLegs, ...(pool.players || [])].map((r) => String(r.game_id)));
const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16) + 'Z';
const openSched = { ...sched, games: sched.games.map((g) => (poolGames.has(String(g.game_id))
  ? { ...g, status: 'STATUS_SCHEDULED', kickoff_utc: future } : g)) };
const gameDoc = atdLegs.length ? JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts import build_atd_game_cards as G
from scripts.models import joint as J
pool = json.load(open(${JSON.stringify(join(ROOT, 'data/leg_pool.json'))}))
sched = json.loads(sys.stdin.read())
jb = {"pricer": "joint", "generated_utc": "t", "loadings": {t: [0.15, 0.2] for t in J.TYPES},
      "offered_sizes": {"all_td": [2, 3, 4], "majority_td": [3, 4, 5], "scorers_50": [2]}, "sizes": {}}
print(json.dumps(G.build(pool, sched, {"adopted": True}, jb)))`], { input: JSON.stringify(openSched), encoding: 'utf8' })) : null;
const label = new Map(openSched.games.map((g) => [String(g.game_id), `${g.away} @ ${g.home}`]));

const PHONE = { width: 402, height: 874 };

async function open(page, doc = gameDoc) {
  await page.setViewportSize(PHONE);
  await page.addInitScript(() => { try { localStorage.removeItem('nfl2026.parlays.td.v1'); } catch (_) {} });
  await page.route('**/data/atd_game_cards.json*', (r) => (doc ? r.fulfill({ json: doc }) : r.fulfill({ status: 404, body: '' })));
  await page.route('**/data/schedule_full.json*', (r) => r.fulfill({ json: openSched }));
  await page.goto('/#/parlays');
  await page.waitForSelector('.scopeseg [data-seg="game"]', { timeout: 20000 });
}

test('GAME: ALL TD cards are one game each, all TD, at the chosen size; 44 pt; no sideways scroll', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await open(page);
  await page.click('#td-controls [data-td="all_td"]');
  await page.click('#td-controls [data-step="-1"]');                  // 4 -> 3
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('3');
  await expect(page.locator('#atd-list .atd-card[data-scope="game"]').first()).toBeVisible();
  await expect(page.locator('#parlays-list')).toBeHidden();
  const cards = await page.$$eval('#atd-list .atd-card', (cs) => cs.map((c) => ({
    head: c.querySelector('.p-head .lbl').textContent,
    legs: [...c.querySelectorAll('.leg-nm')].map((n) => n.textContent),
    note: c.querySelector('.corr').textContent,
  })));
  const want = gameDoc.modes.all_td.cards['3'];
  expect(cards.length).toBe(want.length);
  cards.forEach((c, i) => {
    expect(c.legs.length).toBe(3);
    for (const l of c.legs) expect(l).toMatch(/anytime TD$/);
    expect(c.head.startsWith(label.get(String(want[i].legs[0].game_id)))).toBe(true);
    expect(c.note).toMatch(/same-game model/);
  });
  for (const r of await page.$$eval('#td-controls button', (els) => els.map((e) => e.getBoundingClientRect()))) {
    expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  expect(errors).toEqual([]);
});

test('GAME: a size the held-out test did not validate is not offered, and says so', async ({ page }) => {
  await open(page);
  await page.click('#td-controls [data-td="all_td"]');
  await page.click('#td-controls [data-step="1"]');                   // 4 -> 5
  await expect(page.locator('#atd-list .state')).toContainText('Not offered at 5 legs: not validated on held-out games');
  await page.click('#td-controls [data-td="majority_td"]');
  const rows = await page.$$eval('#atd-list .atd-card', (cs) => cs.map((c) => [...c.querySelectorAll('.leg-nm')].map((n) => /anytime TD$/.test(n.textContent))));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.length).toBe(5);
    expect(r.filter(Boolean).length * 2).toBeGreaterThan(r.length);
  }
});

test('GAME: no published game cards is an honest empty state, and ANY brings the slate back', async ({ page }) => {
  await open(page, null);
  await page.click('#td-controls [data-td="all_td"]');
  await expect(page.locator('#atd-list .state')).toContainText('No anytime-TD cards are published for this view yet.');
  await page.click('#td-controls [data-td="any"]');
  await expect(page.locator('#parlays-list')).toBeVisible();
  await expect(page.locator('#atd-list')).toBeHidden();
});
