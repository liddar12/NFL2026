/* tests/web/r98_waiver_freshness.spec.mjs — R98: LINEUP keeps the league's
 * rosters current by itself, and says so when it cannot.
 *
 * Owner (2026-09-24): "In Sleeper, teams and waivers are updated multiple times a
 * day, they should be re-synced automatically 4 times per day." Driven through
 * the REAL TEAM sync (the r49 fixtures stand in for api.sleeper.app, and the
 * compact index is cut from the same fixture dump exactly as the runner cuts it):
 *   - rosters read moments ago: no refresh, no warning, no request;
 *   - rosters seven hours old: LINEUP re-reads them itself — one /rosters GET,
 *     a new timestamp, the compact index and never the 14.7 MB dump;
 *   - when the refresh cannot run, the failure is said, and the list carries a
 *     warning ABOVE it with its age and the manual fix;
 *   - a record of unknown age is never presented as fresh;
 *   - when the viewer's Sleeper roster differs from the one seated here, LINEUP
 *     names who, and changes nothing itself.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIX = new URL('../fixtures/sleeper_pti/', import.meta.url);
const file = (n) => readFileSync(new URL(n, FIX), 'utf8');
const STATE = readFileSync(new URL('../fixtures/sleeper_proj/state.json', import.meta.url), 'utf8');
const LEAGUE_ID = '1367481303166914560';
const KEYS = ['nfl2026.league.v1', 'nfl2026.team.v1', 'nfl2026.league_id.v1', 'nfl2026.myroster.v1',
  'nfl2026.scoring.v1', 'nfl2026.leaguerosters.v1', 'nfl2026.nflweek.v1'];
const ROSTERS = 'nfl2026.leaguerosters.v1';

const POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'FB']);
const DUMP = JSON.parse(file('player_index_trimmed.json'));
const COMPACT = JSON.stringify({ players: Object.fromEntries(Object.entries(DUMP).filter(([, p]) => p && p.team
  && [p.position, ...(p.fantasy_positions || [])].some((x) => POS.has(x)))) });

async function mockSleeper(page, { index = true } = {}) {
  const seen = { rosters: 0, dump: 0, index: 0 };
  await page.route('**/data/sleeper_index.json', async (route) => {
    seen.index += 1;
    if (!index) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: COMPACT });
  });
  await page.route(/api\.sleeper\.app/, async (route) => {
    if (/\/rosters$/.test(route.request().url())) seen.rosters += 1;
    if (/\/players\/nfl$/.test(route.request().url())) seen.dump += 1;
    const u = route.request().url();
    let body = '[]';
    if (/\/league\/\d+$/.test(u)) body = file('league.json');
    else if (/\/rosters$/.test(u)) body = file('rosters.json');
    else if (/\/users$/.test(u)) body = file('users.json');
    else if (/\/players\/nfl$/.test(u)) body = file('player_index_trimmed.json');
    else if (/\/state\/nfl$/.test(u)) body = STATE;
    else if (/\/matchups\/(\d+)$/.test(u)) {
      const w = Number(u.match(/\/matchups\/(\d+)$/)[1]);
      body = w <= 14 ? file(`matchups_${w}.json`) : '[]';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  return seen;
}

/** One real TEAM sync, seated, exactly as r49 does it. */
async function syncOnTeam(page) {
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 15000 });
  await page.locator('#t-draft input[data-lin="sleeperId"]').fill(LEAGUE_ID);
  await page.locator('[data-act="sleeper-sync"]').click();
  const banner = page.locator('#t-syncbar .sync-bar');
  await expect(banner).toContainText('ONE STEP LEFT — PICK YOUR TEAM', { timeout: 30000 });
  await page.locator('#t-syncbar select[data-rcfg="team"]').selectOption('3');
  await expect(banner).toContainText('SEATED FROM SLEEPER', { timeout: 15000 });
}

/** Rewrite the saved record's timestamp (null removes it). */
const setAt = (page, iso) => page.evaluate(([k, at]) => {
  const rec = JSON.parse(localStorage.getItem(k));
  if (at === null) delete rec.at; else rec.at = at;
  localStorage.setItem(k, JSON.stringify(rec));
}, [ROSTERS, iso]);

async function openWaivers(page) {
  await page.goto('/#/lineup');
  await page.waitForSelector('#ww-card', { timeout: 15000 });
  return page.locator('#ww-card');
}

const clearOnce = (page) => page.addInitScript((keys) => {
  // clear once per test, not on every navigation, so a synced record survives
  if (!sessionStorage.getItem('r98-cleared')) {
    for (const k of keys) localStorage.removeItem(k);
    localStorage.removeItem('nfl2026.leaguesync.attempt.v1');
    sessionStorage.setItem('r98-cleared', '1');
  }
}, KEYS);

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const savedAt = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).at, ROSTERS);

test('R98: rosters read moments ago — no refresh, no warning, no request', async ({ page }) => {
  await clearOnce(page);
  const seen = await mockSleeper(page);
  await syncOnTeam(page);
  const before = seen.rosters;
  const card = await openWaivers(page);
  await expect(card).toContainText('WAIVER WIRE');
  await expect(card.locator('.ww-stale')).toHaveCount(0);
  await expect(page.locator('#lineup-sync .lu-sync')).toHaveCount(0);
  expect(seen.rosters - before, 'a fresh read is not re-read').toBe(0);
  // Just seated from Sleeper: the roster here IS Sleeper's, so nothing to name.
  await expect(page.locator('#lineup-sync .lu-rosterdiff')).toHaveCount(0);
});

test('R98: rosters seven hours old are re-read by LINEUP itself', async ({ page }) => {
  await clearOnce(page);
  const seen = await mockSleeper(page);
  await syncOnTeam(page);
  const dumpReads = seen.dump;
  await setAt(page, hoursAgo(7));
  const before = seen.rosters;
  const card = await openWaivers(page);
  await expect.poll(async () => Date.now() - Date.parse(await savedAt(page)), { timeout: 15000 })
    .toBeLessThan(5 * 60 * 1000);
  expect(seen.rosters - before, 'exactly one /rosters read').toBe(1);
  expect(seen.index, 'the compact index translated the ids').toBeGreaterThanOrEqual(1);
  expect(seen.dump - dumpReads, 'the 14.7 MB dump is never fetched by the automatic path').toBe(0);
  await expect(card.locator('.ww-stale')).toHaveCount(0);
  await expect(page.locator('#ww-card .ww-stale')).toHaveCount(0);
  await expect(page.locator('#lineup-sync .lu-sync--err')).toHaveCount(0);
  expect(await page.locator('#ww-card .lu-row[data-wwid]').count()).toBeGreaterThan(0);
});

test('R98: when the refresh cannot run it says so, and the list is flagged ABOVE it', async ({ page }) => {
  await clearOnce(page);
  await mockSleeper(page, { index: false });
  await syncOnTeam(page);
  await setAt(page, hoursAgo(72.1));
  const card = await openWaivers(page);
  await expect(page.locator('#lineup-sync .lu-sync--err')).toContainText('Automatic roster refresh failed');
  const stale = card.locator('.ww-stale');
  await expect(stale).toContainText('Rosters last read 3 days ago');
  await expect(stale).toContainText('still shows here as available');
  await expect(stale.locator('a[href="#/team"]')).toHaveCount(1);
  await expect(stale).toHaveAttribute('role', 'status');
  const above = await card.evaluate((c) => {
    const s = c.querySelector('.ww-stale');
    const r = c.querySelector('.ww-ctl');
    return !!(s && r && (s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(above, 'the warning sits above the controls and the list').toBe(true);
  expect(await card.locator('.lu-row[data-wwid]').count(), 'stale is a caveat, not a refusal')
    .toBeGreaterThan(0);
});

test('R98: hours, not days, inside two days', async ({ page }) => {
  await clearOnce(page);
  await mockSleeper(page, { index: false });
  await syncOnTeam(page);
  await setAt(page, hoursAgo(30));
  const card = await openWaivers(page);
  await expect(card.locator('.ww-stale')).toContainText('Rosters last read 30 hours ago');
});

test('R98: a record with no readable timestamp is never presented as fresh', async ({ page }) => {
  await clearOnce(page);
  await mockSleeper(page, { index: false });
  await syncOnTeam(page);
  await setAt(page, null);
  const card = await openWaivers(page);
  await expect(card.locator('.ww-stale')).toContainText('Rosters last read at an unknown time');
});

test('R98: a Sleeper roster that differs from the one seated here is NAMED, never applied', async ({ page }) => {
  await clearOnce(page);
  await mockSleeper(page);
  await syncOnTeam(page);
  // Take one seated player off this device's roster: Sleeper still has him.
  const removed = await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('nfl2026.team.v1'));
    const slot = Object.keys(t.slots).find((k) => t.slots[k] && String(t.slots[k]).startsWith('espn-'));
    const id = t.slots[slot];
    t.slots[slot] = null;
    localStorage.setItem('nfl2026.team.v1', JSON.stringify(t));
    return id;
  });
  const teamBefore = await page.evaluate(() => localStorage.getItem('nfl2026.team.v1'));
  await openWaivers(page);
  const diff = page.locator('#lineup-sync .lu-rosterdiff');
  await expect(diff).toContainText('Your Sleeper roster has changed');
  await expect(diff).toContainText('On Sleeper, not here:');
  await expect(diff.locator('a[href="#/team"]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('nfl2026.team.v1')), 'nothing was re-seated')
    .toBe(teamBefore);
  expect(removed).toBeTruthy();
});
