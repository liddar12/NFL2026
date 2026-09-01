/* tests/web/team_roster_sync.spec.mjs — R20-B4 (project `web`).
 *
 * Two features, one page:
 *   1. SLEEPER ROSTER SYNC — pull the owner's real Sleeper roster into the Team
 *      roster. Sleeper is MOCKED at the network layer (page.route), so this
 *      suite proves the whole flow — read, pick the team, preview, confirm —
 *      without ever leaving the box, and without depending on Sleeper being up.
 *   2. MARKET AUCTION VALUE on the draft board — OURS (our VOR dollars) beside
 *      AUC (ESPN's average winning bid) with the over/under flag, carrying the
 *      app's DISPLAY-ONLY badge.
 *
 * The load-bearing assertion is the third test: a hand-built roster is never
 * replaced without the losses being named first and a second, deliberate tap.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const PROJ = readData('player_projections.json');

/** The first N pool players at a position (the app's own contract, not a guess). */
const byPos = (pos, n) => PROJ.players.filter((p) => p.position === pos).slice(0, n);

const QBS = byPos('QB', 2);
const RBS = byPos('RB', 2);
const WRS = byPos('WR', 2);
const TES = byPos('TE', 1);

/** app id 'espn-1234' -> Sleeper's espn_id '1234'. */
const espnId = (p) => String(p.gsis_id).replace(/^espn-/, '');

/** A Sleeper /players/nfl entry that resolves to a real pool player. */
function idxEntry(sleeperId, player) {
  const bits = String(player.name).split(' ');
  return {
    player_id: String(sleeperId),
    first_name: bits[0],
    last_name: bits.slice(1).join(' '),
    full_name: player.name,
    position: player.position,
    team: player.team,
    fantasy_positions: [player.position],
    espn_id: espnId(player),
  };
}

const ROSTER_PLAYERS = [...QBS.slice(0, 1), ...RBS, ...WRS, ...TES];

/** sleeper id -> index entry, plus one kicker this app deliberately cannot use. */
const PLAYER_INDEX = (() => {
  const out = {};
  ROSTER_PLAYERS.forEach((p, i) => { out[String(9000 + i)] = idxEntry(9000 + i, p); });
  out['9900'] = {
    player_id: '9900',
    first_name: 'Kicker',
    last_name: 'Mcunmatchable',
    full_name: 'Kicker Mcunmatchable',
    position: 'K',
    team: 'DAL',
    fantasy_positions: ['K'],
    espn_id: '99999999',
  };
  return out;
})();

const MY_SLEEPER_IDS = ROSTER_PLAYERS.map((_, i) => String(9000 + i));
const MY_STARTERS = MY_SLEEPER_IDS.slice(0, 4);

const ROSTERS = [
  { roster_id: 1, owner_id: 'u1', players: [...MY_SLEEPER_IDS, '9900'], starters: MY_STARTERS },
  { roster_id: 2, owner_id: 'u2', players: [], starters: [] },
];
const USERS = [
  { user_id: 'u1', display_name: 'liddar', metadata: { team_name: 'Gridiron Degenerates' } },
  { user_id: 'u2', display_name: 'shark', metadata: {} },
];

const LEAGUE_ID = '1051234567890123456';

/** Mock every Sleeper endpoint this flow touches. Nothing leaves the box. */
async function mockSleeper(page) {
  const json = (route, body) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api.sleeper.app/v1/league/*/rosters', (r) => json(r, ROSTERS));
  await page.route('**/api.sleeper.app/v1/league/*/users', (r) => json(r, USERS));
  await page.route('**/api.sleeper.app/v1/players/nfl', (r) => json(r, PLAYER_INDEX));
}

/** Open #/team and wait for the roster grid + the league panel to paint. */
async function openTeam(page) {
  await page.goto('/#/team');
  await page.waitForSelector('.roster .slot', { timeout: 10000 });
  await page.waitForSelector('[data-act="roster-sync"]', { timeout: 10000 });
}

/** Type the league id into the Sleeper field the roster sync reads. */
async function enterLeagueId(page) {
  await page.locator('[data-lin="sleeperId"]').fill(LEAGUE_ID);
}

/** Run a sync and select roster 1 (mine). */
async function syncAndPickMyTeam(page) {
  await enterLeagueId(page);
  await page.locator('[data-act="roster-sync"]').click();
  await page.waitForSelector('select[data-rcfg="team"]', { timeout: 20000 });
  await page.locator('select[data-rcfg="team"]').selectOption('0');
  await page.waitForSelector('.lp-report--roster', { timeout: 10000 });
}

test.describe('R20-B4 — Sleeper roster sync', () => {
  test.beforeEach(async ({ page }) => {
    await mockSleeper(page);
    await page.addInitScript(() => localStorage.removeItem('nfl2026.team.v1'));
  });

  test('the sync action is manual, needs a league id, and says so', async ({ page }) => {
    await openTeam(page);
    const btn = page.locator('[data-act="roster-sync"]');
    await expect(btn).toHaveText(/SYNC ROSTER/);
    // The panel states the manual-only policy before anything is pressed.
    await expect(page.locator('.draftsim')).toContainText('MANUAL SYNC ONLY');
    // Pressing it with no league id explains what is missing; nothing is written.
    await btn.click();
    await expect(page.locator('.lp-status--err')).toContainText('Sleeper league id');
    const stored = await page.evaluate(() => localStorage.getItem('nfl2026.team.v1'));
    expect(stored).toBeNull();
  });

  test('an empty roster fills from Sleeper and names what it could not match',
    async ({ page }) => {
      await openTeam(page);
      await syncAndPickMyTeam(page);

      // The picker offers the league's teams by their Sleeper names.
      await expect(page.locator('select[data-rcfg="team"]'))
        .toContainText('Gridiron Degenerates');

      // The preview names the kicker this app has no projection for.
      const report = page.locator('.lp-report--roster');
      await expect(report).toContainText('NOT IN THIS APP\'S PLAYER POOL');
      await expect(report).toContainText('Kicker Mcunmatchable');
      // The REASON is app/sleeper.js's to word (it owns the crosswalk); what
      // this view guarantees is that a reason is shown at all, never a bare name.
      const missRow = report.locator('.lp-unres--miss li').first();
      const missText = (await missRow.innerText()).split('—').slice(1).join('—').trim();
      expect(missText.length).toBeGreaterThan(20);

      // R48 — nothing could be overwritten (the roster was empty), so picking
      // the team seated it on the spot: no confirm tap, the report says what
      // it DID, and no apply button is left to press.
      await expect(report).toContainText('WHAT THIS DID');
      await expect(page.locator('#t-draft')).toContainText('roster seated from Sleeper');
      expect(await page.locator('[data-act="roster-apply"]').count()).toBe(0);

      // The real roster now holds the Sleeper players, in profile slot ids.
      await page.waitForSelector('.roster .slot-player', { timeout: 10000 });
      const seated = await page.locator('.roster .slot-player .sp-name').allInnerTexts();
      expect(seated.length).toBe(ROSTER_PLAYERS.length);
      for (const p of ROSTER_PLAYERS) {
        expect(seated.join(' | ')).toContain(p.name);
      }
      // Sleeper's starters were seated in starting slots, not the bench.
      const qbSlot = page.locator('.roster .slot[data-slot="QB1"]');
      await expect(qbSlot).toContainText(QBS[0].name);

      // It persisted under the app's own slot vocabulary.
      const stored = await page.evaluate(
        () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'));
      expect(stored.slots.QB1).toBe(QBS[0].gsis_id);
    });

  test('an existing roster is never replaced without naming the losses and a second tap',
    async ({ page }) => {
      // A hand-built roster with a player who is NOT on the Sleeper team.
      const doomed = PROJ.players.filter(
        (p) => p.position === 'RB' && !ROSTER_PLAYERS.some((r) => r.gsis_id === p.gsis_id))[0];
      await page.addInitScript((r) => localStorage.setItem('nfl2026.team.v1', r),
        JSON.stringify({ slots: { RB1: doomed.gsis_id } }));

      await openTeam(page);
      await syncAndPickMyTeam(page);

      const report = page.locator('.lp-report--roster');
      // The losses are named BEFORE anything can be pressed.
      await expect(report).toContainText('WILL BE REMOVED FROM YOUR ROSTER');
      await expect(report.locator('.lp-unres--drop')).toContainText(doomed.name);

      // First tap ARMS only — the roster on disk is untouched.
      const apply = report.locator('[data-act="roster-apply"]');
      await expect(apply).toHaveText(/REPLACE MY ROSTER/);
      await apply.click();
      await expect(page.locator('[data-act="roster-apply"]')).toHaveText(/TAP AGAIN/);
      let stored = await page.evaluate(
        () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'));
      expect(stored.slots.RB1).toBe(doomed.gsis_id);

      // Any other action disarms it — an accidental double-tap elsewhere is safe.
      await page.locator('[data-act="taken-filter"]').click();
      await expect(page.locator('[data-act="roster-apply"]')).toHaveText(/REPLACE MY ROSTER/);

      // Arm again, then confirm. Only now does the roster change.
      await page.locator('[data-act="roster-apply"]').click();
      await expect(page.locator('[data-act="roster-apply"]')).toHaveText(/TAP AGAIN/);
      await page.locator('[data-act="roster-apply"]').click();
      await page.waitForSelector('.roster .slot-player', { timeout: 10000 });
      stored = await page.evaluate(
        () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'));
      expect(Object.values(stored.slots)).not.toContain(doomed.gsis_id);
      expect(stored.slots.QB1).toBe(QBS[0].gsis_id);
    });

  test('a Sleeper failure changes nothing and says what happened', async ({ page }) => {
    await page.route('**/api.sleeper.app/v1/league/*/rosters',
      (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
    await page.addInitScript((r) => localStorage.setItem('nfl2026.team.v1', r),
      JSON.stringify({ slots: { QB1: QBS[0].gsis_id } }));
    await openTeam(page);
    await enterLeagueId(page);
    await page.locator('[data-act="roster-sync"]').click();
    await expect(page.locator('.lp-status--err')).toContainText('HTTP 500', { timeout: 20000 });
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'));
    expect(stored.slots.QB1).toBe(QBS[0].gsis_id);
  });
});

test.describe('R20-B4 — market auction value on the draft board', () => {
  test('finder rows carry OURS vs AUC with an over/under flag and the policy badge',
    async ({ page }) => {
      await page.goto('/#/team');
      await page.waitForSelector('.cand', { timeout: 10000 });

      // The column key carries the app's one DISPLAY-ONLY badge, verbatim.
      const legend = page.locator('.finder .cd-vallegend');
      await expect(legend.locator('.ms-badge')).toHaveText('MARKET · DISPLAY ONLY');
      await expect(legend).toContainText('ESPN');

      // Rows priced by both sides show both prices and one flag.
      const valued = page.locator('.cand .cd-val');
      expect(await valued.count()).toBeGreaterThan(0);
      const first = valued.first();
      await expect(first).toContainText('OURS');
      await expect(first).toContainText('AUC');
      expect(await page.locator('.cand .cv-flag').count()).toBeGreaterThan(0);
      // The flag is a WORD, never colour alone.
      const flags = await page.locator('.cand .cv-flag').allInnerTexts();
      for (const f of flags) expect(['OVER', 'UNDER', 'FAIR']).toContain(f.trim());
    });

  test('the BEST PICK NOW strip carries the same cell and badge', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.bestpick .bp-row', { timeout: 10000 });
    await expect(page.locator('.bestpick .ms-badge').first())
      .toHaveText('MARKET · DISPLAY ONLY');
    expect(await page.locator('.bestpick .bp-row .cd-val').count()).toBeGreaterThan(0);
  });

  test('the value cell adds no horizontal overflow at 402pt', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.cand .cd-val', { timeout: 10000 });
    const over = await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });

  test('the market price moves no number the app produces', async ({ page }) => {
    // The projected points column is our own math. Compare a row's PTS to the
    // contract's projection — a market price leaking into it would show up here.
    await page.goto('/#/team');
    await page.waitForSelector('.cand .cd-pts', { timeout: 10000 });
    const row = page.locator('.cand').first();
    const id = await row.getAttribute('data-gsis');
    const shown = Number((await row.locator('.cd-pts').innerText()).trim());
    const proj = PROJ.players.find((p) => String(p.gsis_id) === id);
    expect(proj).toBeTruthy();
    // Default scoring mode is PPR, which is the projection as published.
    expect(Math.abs(shown - proj.proj_points)).toBeLessThanOrEqual(0.05);
  });
});
