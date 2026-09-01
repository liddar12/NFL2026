/* tests/web/r48_league_tab.spec.mjs — R48-B: the LEAGUE tab, in a browser.
 *
 * The fast-gate twin (tests/feature/r48_league_tab.test.mjs) locks the diff
 * engine and the wiring. These are the claims only a real page can settle:
 *
 *   1. seeded with a P.T.I.-shaped profile, a league id and one sync entry,
 *      #/league paints the header, the scoring diff rows (pass_int present,
 *      rec absent, bonus_rec_te as a league-only key), the four roster lines
 *      and the sync entry — and the LEAGUE tab is the active one;
 *   2. the page repaints on the 'nfl2026:league' event without a reload;
 *   3. with no league saved it paints the honest NO LEAGUE state and the two
 *      "matches" empty states, and requests NO /data/ contract;
 *   4. the eight-tab bar still fits the 402pt reference with League after Team.
 *
 * The seeded profile is shaped exactly as app/sleeper.js maps the real payload
 * (tests/fixtures/sleeper_pti/league.json): scoring_settings as the scoring
 * table, roster_positions + total_rosters as the shape.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const LEAGUE = JSON.parse(readFileSync(
  new URL('../fixtures/sleeper_pti/league.json', import.meta.url), 'utf8',
));

const PTI_PROFILE = {
  version: 1,
  name: LEAGUE.name,
  scoring: LEAGUE.scoring_settings,
  shape: { teams: LEAGUE.total_rosters, roster_positions: LEAGUE.roster_positions },
};

const SYNC_ENTRY = {
  kind: 'settings',
  at: '2026-09-01T12:00:00.000Z',
  league_id: LEAGUE.league_id,
  league_name: LEAGUE.name,
  changes: ['pass_int: -1 -> -2', 'bonus_rec_te: not scored -> 0.5'],
};

const seed = (page, { profile, id, log }) => page.addInitScript((s) => {
  if (s.profile) localStorage.setItem('nfl2026.league.v1', s.profile);
  else localStorage.removeItem('nfl2026.league.v1');
  if (s.id) localStorage.setItem('nfl2026.league_id.v1', s.id);
  else localStorage.removeItem('nfl2026.league_id.v1');
  if (s.log) localStorage.setItem('nfl2026.synclog.v1', s.log);
  else localStorage.removeItem('nfl2026.synclog.v1');
}, {
  profile: profile ? JSON.stringify(profile) : null,
  id: id || null,
  log: log ? JSON.stringify(log) : null,
});

/* ==========================================================================
   1. A SYNCED LEAGUE PAINTS ITS DIFFS AND ITS LOG
   ========================================================================== */

test('#/league paints the P.T.I. header, scoring diff, roster diff and sync log', async ({ page }) => {
  await seed(page, { profile: PTI_PROFILE, id: LEAGUE.league_id, log: [SYNC_ENTRY] });
  await page.goto('/#/league');
  await page.waitForSelector('.lgv', { timeout: 15000 });

  // The tab is active and announced.
  expect(await page.locator('.tabbar .tab--active').getAttribute('data-tab')).toBe('league');
  await expect(page.locator('#announce')).toHaveText('League view loaded');

  // Header: name, Sleeper id, teams, starters + bench, reception value.
  await expect(page.locator('.lgv-name')).toHaveText('P.T.I.');
  const meta = await page.locator('.lgv-meta').innerText();
  expect(meta).toContain(`Sleeper league ${LEAGUE.league_id}`);
  expect(meta).toContain('10 teams');
  expect(meta).toContain('9 starters + 5 bench');
  expect(meta).toContain('reception 1');

  // Scoring: a changed key appears with both values; an unchanged key does not;
  // a league-only key shows "not scored" on the standard side, never 0.
  const passInt = page.locator('.lgv-row[data-key="pass_int"]');
  await expect(passInt).toHaveCount(1);
  const passIntText = (await passInt.innerText()).replace(/\s+/g, ' ');
  expect(passIntText).toContain('Interception thrown');
  expect(passIntText).toMatch(/-2\s+-1$/);
  await expect(page.locator('.lgv-row[data-key="rec"]')).toHaveCount(0);
  await expect(page.locator('.lgv-row[data-key="sack"]')).toHaveCount(0);
  const te = page.locator('.lgv-row[data-key="bonus_rec_te"]');
  await expect(te).toHaveCount(1);
  expect((await te.innerText()).replace(/\s+/g, ' ')).toMatch(/TE reception bonus.*\+0\.5\s+not scored$/);
  await expect(te.locator('.lgv-absent')).toHaveText('not scored');
  // The biggest departure leads (sorted by |delta|).
  const firstKey = await page.locator('.lgv-row').first().getAttribute('data-key');
  expect(firstKey).toBe('yds_allow_0_100');
  await expect(page.locator('.lgv-row')).toHaveCount(46);

  // Roster: the four lines, plus both roster_positions strings.
  const lines = await page.locator('.lgv-card').nth(2).locator('.lgv-line').allInnerTexts();
  expect(lines).toEqual([
    '10 teams vs 12',
    '2 FLEX vs 1',
    'no K slot (standard seats one)',
    '5 bench vs 6',
  ]);
  const codes = await page.locator('.lgv-code').allInnerTexts();
  expect(codes[0]).toBe('QB RB RB WR WR TE FLEX FLEX DEF BN BN BN BN BN');
  expect(codes[1]).toBe('QB RB RB WR WR TE FLEX K DEF BN BN BN BN BN BN');

  // The sync log entry: kind, league, change lines.
  const sync = page.locator('.lgv-sync');
  await expect(sync).toHaveCount(1);
  expect(await sync.getAttribute('data-kind')).toBe('settings');
  await expect(sync.locator('.lgv-kind')).toHaveText('SETTINGS');
  await expect(sync.locator('.lgv-sync-league')).toContainText('P.T.I.');
  await expect(sync.locator('.lgv-sync-league')).toContainText(LEAGUE.league_id);
  expect(await sync.locator('.lgv-line').allInnerTexts()).toEqual(SYNC_ENTRY.changes);
  await expect(page.locator('.lgv-card').nth(3)).toContainText('RESET ALL on TEAM clears the league and this log.');

  // Nothing scrolls sideways on the phone.
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(402);
});

/* ==========================================================================
   2. REPAINT ON THE SYNC EVENT
   ========================================================================== */

test('the page repaints on nfl2026:league without a reload', async ({ page }) => {
  await seed(page, { profile: PTI_PROFILE, id: LEAGUE.league_id, log: [SYNC_ENTRY] });
  await page.goto('/#/league');
  await page.waitForSelector('.lgv-row', { timeout: 15000 });

  // A sync that clears the league and appends a roster entry, then the event
  // TEAM/GRADE dispatch — the page must follow storage, not its first paint.
  await page.evaluate((entry) => {
    localStorage.removeItem('nfl2026.league.v1');
    localStorage.removeItem('nfl2026.league_id.v1');
    const log = JSON.parse(localStorage.getItem('nfl2026.synclog.v1') || '[]');
    localStorage.setItem('nfl2026.synclog.v1', JSON.stringify([entry, ...log]));
    window.dispatchEvent(new Event('nfl2026:league'));
  }, { ...SYNC_ENTRY, kind: 'roster', at: '2026-09-01T12:05:00.000Z', changes: ['RB1: Bijan Robinson'] });

  await expect(page.locator('.lgv h2').first()).toHaveText('NO LEAGUE APPLIED');
  await expect(page.locator('.lgv-row')).toHaveCount(0);
  await expect(page.locator('.lgv-sync')).toHaveCount(2);
  await expect(page.locator('.lgv-sync').first().locator('.lgv-kind')).toHaveText('ROSTER');
  await expect(page.locator('.lgv-sync').nth(1).locator('.lgv-kind')).toHaveText('SETTINGS');
});

/* ==========================================================================
   3. NO LEAGUE = HONEST EMPTY STATES, AND NO CONTRACT FETCH
   ========================================================================== */

test('with nothing saved the page states NO LEAGUE, the two matches, and fetches no /data/ contract', async ({ page }) => {
  await seed(page, {});
  const dataRequests = [];
  page.on('request', (r) => { if (/\/data\/.*\.json/.test(r.url())) dataRequests.push(r.url()); });
  await page.goto('/#/league');
  await page.waitForSelector('.lgv', { timeout: 15000 });

  await expect(page.locator('.lgv h2').first()).toHaveText('NO LEAGUE APPLIED');
  await expect(page.locator('.lgv')).toContainText('Scoring matches standard PPR on every key.');
  await expect(page.locator('.lgv')).toContainText('Roster shape matches the default');
  await expect(page.locator('.lgv')).toContainText('No sync recorded yet on this device.');
  await expect(page.locator('.lgv-row')).toHaveCount(0);
  await expect(page.locator('.lgv-sync')).toHaveCount(0);

  // The shell fetches its own two chips (pipeline_status, game_predictions)
  // on boot — measured, exactly those two; the LEAGUE mount adds nothing.
  const shellOnly = new Set(['pipeline_status.json', 'game_predictions.json']);
  const extra = dataRequests.map((u) => u.split('/data/')[1]).filter((f) => !shellOnly.has(f));
  expect(extra, `LEAGUE fetched ${extra.join(', ')}`).toEqual([]);
});

/* ==========================================================================
   4. EIGHT TABS, LEAGUE AFTER TEAM, STILL ON SCREEN
   ========================================================================== */

test('the tab bar carries League right after Team and all eight fit the reference width', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.tabbar')).toBeVisible({ timeout: 15000 });
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.tabbar');
    return {
      width: el.getBoundingClientRect().width,
      scrollWidth: el.scrollWidth,
      tabs: [...el.querySelectorAll('.tab')].map((t) => ({
        tab: t.dataset.tab,
        right: t.getBoundingClientRect().right,
        spills: t.scrollWidth > t.clientWidth,
      })),
    };
  });
  expect(bar.tabs.map((t) => t.tab)).toEqual(
    ['slate', 'players', 'parlays', 'team', 'league', 'lineup', 'model', 'grade'],
  );
  expect(bar.scrollWidth).toBeLessThanOrEqual(Math.ceil(bar.width));
  for (const t of bar.tabs) {
    expect(t.right, `${t.tab} is clipped`).toBeLessThanOrEqual(bar.width + 0.5);
    expect(t.spills, `${t.tab} overflows its own tab`).toBe(false);
  }
  await page.click('.tab[data-tab="league"]');
  await page.waitForSelector('.lgv', { timeout: 15000 });
  expect(page.url()).toMatch(/#\/league$/);
});
