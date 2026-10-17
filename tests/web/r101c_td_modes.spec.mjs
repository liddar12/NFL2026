/* tests/web/r101c_td_modes.spec.mjs — R101c: the anytime-TD selector on WEEK and MY.
 *
 * Gate 2 layout B, iPhone first: TD pills (ANY / ALL TD / MAJORITY / 50%+) and a
 * − n + leg stepper (2–10). The WEEK cards come from data/atd_cards.json; this
 * spec builds that document from the COMMITTED leg pool with the real builder
 * (scripts/build_atd_cards.py) against a schedule whose games are all still to
 * come, and serves both through page.route — so the spec does not depend on the
 * day of the week it runs, and skips (saying why) only when the committed pool
 * offers no anytime-TD leg at all (the model not adopted).
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
const cardsDoc = atdLegs.length ? JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts import build_atd_cards as B
pool = json.load(open(${JSON.stringify(join(ROOT, 'data/leg_pool.json'))}))
sched = json.loads(sys.stdin.read())
print(json.dumps(B.build(pool, sched, {"adopted": True})))`], { input: JSON.stringify(openSched), encoding: 'utf8' })) : null;
const SEED = atdLegs.length ? atdLegs.slice().sort((a, b) => b.rungs[0].model_prob - a.rungs[0].model_prob)[0].team : '';

const PHONE = { width: 402, height: 874 };

async function open(page) {
  await page.setViewportSize(PHONE);
  await page.addInitScript(() => { try { localStorage.removeItem('nfl2026.parlays.td.v1'); } catch (_) {} });
  await page.route('**/data/atd_cards.json*', (r) => r.fulfill({ json: cardsDoc }));
  await page.route('**/data/schedule_full.json*', (r) => r.fulfill({ json: openSched }));
  await page.goto('/#/parlays');
  await page.waitForSelector('.scopeseg [data-seg="week"]', { timeout: 20000 });
}

async function tapTargets(page, sel) {
  return page.$$eval(sel, (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  }));
}

/* R133 (owner, 2026-10-17) — on WEEK and GAME the TD pills became the BET TYPE
 * chips (ALL / ANYTIME TD / PASSING / RUSHING / RECEIVING / MONEYLINE) over the
 * same − n + stepper; MY keeps its pills (the last test here). ANYTIME TD is the
 * old ALL TD: cards built live from the pool's anytime-TD legs, one per game.
 * The served schedule keeps every pool game still to come. */
async function openTypes(page) {
  await page.addInitScript(() => { try { localStorage.removeItem('nfl2026.parlays.types.v1'); } catch (_) {} });
  await open(page);
}

test('WEEK: bet-type chips replace the TD pills; ANYTIME TD cards at the chosen size; stepper bounds; 44 pt', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openTypes(page);
  // GAME (the default) carries the chips too; its published cards are all pairs,
  // so ALL has no stepper there.
  await expect(page.locator('#td-controls [data-type="atd"]')).toBeVisible();
  await expect(page.locator('#td-controls [data-td]')).toHaveCount(0);
  await expect(page.locator('#td-controls .td-step')).toHaveCount(0);
  await expect(page.locator('#parlays-list')).toBeVisible();
  await page.click('.scopeseg [data-seg="week"]');
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('ALL');
  await page.click('#td-controls [data-type="atd"]');
  await expect(page.locator('#td-controls [data-type="atd"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#td-controls [data-type="all"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#atd-list .type-card').first()).toBeVisible();
  await expect(page.locator('#parlays-list')).toBeHidden();
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('2');
  for (let i = 0; i < 2; i++) await page.click('#td-controls [data-step="1"]');
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('4');
  const legs4 = await page.$$eval('#atd-list .type-card', (cs) => cs.map((c) => [...c.querySelectorAll('.leg-nm')].map((n) => n.textContent)));
  expect(legs4.length).toBe(3);
  for (const legs of legs4) {
    expect(legs.length).toBe(4);
    for (const l of legs) expect(l).toMatch(/anytime TD$/);
  }
  await expect(page.locator('#atd-list .type-card').first()).toContainText('not recorded or graded');
  for (const [w, h] of await tapTargets(page, '#td-controls button')) expect(Math.min(w, h)).toBeGreaterThanOrEqual(44);
  for (let i = 0; i < 10; i++) {
    const plus = page.locator('#td-controls [data-step="1"]');
    if (await plus.isDisabled()) break;
    await plus.click();
  }
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('10');
  await expect(page.locator('#td-controls [data-step="1"]')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  // the type follows the viewer to GAME, where a card is a same-game pair
  await page.click('.scopeseg [data-seg="game"]');
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('2');
  await expect(page.locator('#td-controls .td-step-range')).toContainText('same-game limit');
  // ALL brings the published slate back
  await page.click('#td-controls [data-type="all"]');
  await expect(page.locator('#parlays-list')).toBeVisible();
  await expect(page.locator('#atd-list')).toBeHidden();
  expect(errors).toEqual([]);
});

test('WEEK: types combine; every leg is a chosen kind and carries its confidence tag', async ({ page }) => {
  await openTypes(page);
  await page.click('.scopeseg [data-seg="week"]');
  await page.click('#td-controls [data-type="rush"]');
  await page.click('#td-controls [data-type="rec"]');
  await page.click('#td-controls [data-step="1"]');
  await expect(page.locator('#td-controls .td-step-n')).toHaveText('3');
  await expect(page.locator('#atd-list .type-card .p-head').first()).toContainText('RUSHING + RECEIVING · 3 LEGS');
  const rows = await page.$$eval('#atd-list .type-card .leg', (ls) => ls.map((l) => ({
    nm: l.querySelector('.leg-nm').textContent,
    model: Number(l.querySelector('.mo b').textContent),
    tag: (l.querySelector('.conf') || {}).className || '',
  })));
  expect(rows.length).toBe(9);
  for (const r of rows) {
    expect(r.nm).toMatch(/(rush|rec) yds$/);
    const want = r.model >= 65 ? 'conf--high' : r.model >= 50 ? 'conf--medium' : 'conf--low';
    // the tag reads the unrounded chance, so a leg AT a line may round onto it
    if (![49, 50, 64, 65].includes(r.model)) expect(r.tag).toContain(want);
  }
  // unpicking both is ALL again: the published slate, with a tag on its legs too
  await page.click('#td-controls [data-type="rush"]');
  await page.click('#td-controls [data-type="rec"]');
  await expect(page.locator('#td-controls [data-type="all"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parlays-list')).toBeVisible();
  await expect(page.locator('#parlays-list .card.parlay .conf').first()).toBeVisible();
});

test('MY: ALL TD cards are all anytime TD at the chosen size; ANY carries no TD leg', async ({ page }) => {
  await open(page);
  await page.click('.scopeseg [data-seg="my"]');
  await page.waitForSelector('#mp-input', { timeout: 20000 });
  await page.fill('#mp-input', SEED);
  await page.press('#mp-input', 'Enter');
  await page.waitForSelector('.mp-card', { timeout: 20000 });
  const anyLegs = await page.$$eval('.mp-card .leg-nm', (ns) => ns.map((n) => n.textContent));
  expect(anyLegs.some((t) => /anytime TD$/.test(t))).toBe(false);
  await page.click('#mp-td [data-td="all_td"]');
  await page.click('#mp-td [data-step="-1"]');                    // 4 -> 3
  await expect(page.locator('#mp-td .td-step-n')).toHaveText('3');
  await expect(page.locator('.mp-dial').first()).toBeHidden();      // no dial in ALL TD
  const cards = await page.$$eval('.mp-card', (cs) => cs.map((c) => [...c.querySelectorAll('.leg-nm')].map((n) => n.textContent)));
  expect(cards.length).toBeGreaterThan(0);
  for (const legs of cards) {
    expect(legs.length).toBe(3);
    for (const l of legs) expect(l).toMatch(/anytime TD$/);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
});
