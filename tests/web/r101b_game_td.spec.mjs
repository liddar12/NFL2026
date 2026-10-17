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

/* R133 (owner, 2026-10-17) — GAME's TD pills became the BET TYPE chips, and
 * GAME is ONE game picked from a dropdown at 2-7 legs. Two legs are priced by
 * the same-game correlation model; three or more are an ESTIMATE that chains
 * the measured pair correlations (no backtest has validated them), and say so. */
async function openTypes(page) {
  // a fresh start per test; a reload marked 'keep' keeps the viewer's saved choice
  await page.addInitScript(() => {
    try { if (!sessionStorage.getItem('keep-types')) localStorage.removeItem('nfl2026.parlays.types.v1'); } catch (_) {}
  });
  await open(page);
}

test('GAME: pick a game; ANYTIME TD cards are that game\'s TD legs; 44 pt; no sideways scroll', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openTypes(page);
  await page.click('#td-controls [data-type="atd"]');
  await expect(page.locator('#game-pick')).toBeVisible();
  await expect(page.locator('#atd-list .type-card').first()).toBeVisible();
  await expect(page.locator('#parlays-list')).toBeHidden();
  const options = await page.$$eval('#game-pick option', (os) => os.map((o) => [o.value, o.textContent]));
  expect(options.length).toBeGreaterThan(1);
  const second = options[1];
  await page.selectOption('#game-pick', second[0]);
  await expect(page.locator('#atd-list .type-card .p-head').first()).toContainText(second[1]);
  const cards = await page.$$eval('#atd-list .type-card', (cs) => cs.map((c) => ({
    head: c.querySelector('.p-head').textContent,
    legs: [...c.querySelectorAll('.leg-nm')].map((n) => n.textContent),
  })));
  for (const c of cards) {
    expect(c.head.split(' · ')[0]).toBe(second[1]);
    expect(c.legs.length).toBe(2);
    for (const l of c.legs) expect(l).toMatch(/anytime TD$/);
  }
  for (const [w, h] of await tapTargets(page, '#td-controls button, #game-pick')) expect(Math.min(w, h)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  expect(errors).toEqual([]);
});

test('GAME: up to 7 legs from one game; three or more are labelled an estimate', async ({ page }) => {
  await openTypes(page);
  await page.click('#td-controls [data-type="all"]');
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('2');
  await expect(page.locator('#atd-list .type-card .ev .k').first()).toHaveText('MODEL HIT');
  for (let i = 0; i < 10; i++) {
    const plus = page.locator('#td-controls [data-step="1"]');
    if (await plus.isDisabled()) break;
    await plus.click();
  }
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('7');
  await expect(page.locator('#td-controls .td-step-range')).toHaveText('2 – 7');
  const first = page.locator('#atd-list .type-card').first();
  await expect(first.locator('.leg')).toHaveCount(7);
  await expect(first.locator('.ev .k')).toHaveText('EST. MODEL HIT');
  await expect(first).toContainText('ESTIMATED by chaining the measured pair correlations');
});

test('GAME: a kind one game cannot fill is an honest empty state, and PUBLISHED brings the slate back', async ({ page }) => {
  await openTypes(page);
  // a game offers at most one moneyline leg per card (the pool carries the pick's
  // side), so MONEYLINE alone can never fill a 2-leg same-game card
  await page.click('#td-controls [data-type="ml"]');
  await expect(page.locator('#atd-list .state')).toContainText(/This game has [01] legs? of these kinds|No card of this size can be built from this game/);
  await page.click('#td-controls [data-type="published"]');
  await expect(page.locator('#parlays-list')).toBeVisible();
  await expect(page.locator('#atd-list')).toBeHidden();
});

test('RC-02: WEEK at 8, 9 and 10 legs switches to GAME at the displayed 7, and every card has 7 — reload too', async ({ page }) => {
  await openTypes(page);
  await page.click('.scopeseg [data-seg="week"]');
  await page.click('#td-controls [data-type="all"]');
  for (const want of ['8', '9', '10']) {
    while ((await page.locator('#td-controls .td-step-n').textContent()).trim() !== want) {
      await page.click('#td-controls [data-step="1"]');
    }
    await page.click('.scopeseg [data-seg="game"]');
    await expect(page.locator('#td-controls .td-step-n')).toHaveText('7');
    await page.waitForSelector('#atd-list .type-card');
    const sizes = await page.$$eval('#atd-list .type-card', (cs) => cs.map((c) => c.querySelectorAll('.leg').length));
    expect(sizes.length).toBeGreaterThan(0);
    for (const n of sizes) expect(n).toBe(7);
    await expect(page.locator('#atd-list .type-card .p-head').first()).toContainText('7 LEGS');
    await page.click('.scopeseg [data-seg="week"]');
  }
  // the saved preference is 10; a reload straight onto GAME must still build 7
  await page.click('.scopeseg [data-seg="game"]');
  await page.evaluate(() => sessionStorage.setItem('keep-types', '1'));
  await page.reload();
  await page.waitForSelector('#td-controls [data-type="all"][aria-pressed="true"]', { timeout: 20000 });
  await page.waitForSelector('#atd-list .type-card', { timeout: 20000 });
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('7');
  const after = await page.$$eval('#atd-list .type-card', (cs) => cs.map((c) => c.querySelectorAll('.leg').length));
  for (const n of after) expect(n).toBe(7);
});

function tapTargets(page, sel) {
  return page.$$eval(sel, (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  }));
}
