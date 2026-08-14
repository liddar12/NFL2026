/* tests/web/team_room_aiplus.spec.mjs — R23-S1: the AI+ room, its explainer,
 * the draft-history panel and the auction's market label.
 *
 * WHAT IS LOCKED HERE, and why each one needs a real browser:
 *
 *  1. THE THIRD ROOM IS PICKABLE AND EXPLAINED. AI+ joins ADP and SHARK in the
 *     ROOM select without moving the default, and each room carries one line
 *     saying who the opponents are. Before this, a manager choosing between
 *     three four-letter words had nothing to choose on.
 *  2. AI+ WITH NOTHING SAVED SAYS SO. app/draft-sim.js falls back to the
 *     DEFAULT profile, which is a standard 12-team full-PPR league. A manager
 *     who picks AI+ believes their league is being modelled; with nothing
 *     saved it is not, and the panel must say that rather than imply it.
 *  3. HISTORY IS HISTORY. A finished mock is recorded, the panel counts it,
 *     and the copy says a SIM room teaches nothing — the claim the old
 *     "learning record" line made and never had.
 *  4. THE MIGRATION IS REAL. Rows under the superseded storage key appear in
 *     the panel on mount, and the old key is never deleted.
 *  5. CALIBRATION IS CONSUMED, NOT JUST DISPLAYED. With enough LIVE evidence
 *     the draft room prints "gone ~N here" beside consensus ADP — a PICK
 *     NUMBER, never a point total.
 *  6. THE ROOM'S PRICE CARRIES THE ONE DISPLAY-ONLY BADGE. The auction block
 *     shows MARKET beside OURS with the app's existing badge, verbatim.
 */

import { test, expect } from '@playwright/test';

const LEAGUE_KEY = 'nfl2026.league.v1';
const HIST_V1 = 'nfl2026.mocklocks.v1';
const HIST_V2 = 'nfl2026.mockhistory.v2';

/** The exact badge string the app uses everywhere else (app/views/model.js). */
const BADGE = 'MARKET · DISPLAY ONLY';

/** Wipe every key this view reads, then optionally seed some. Runs pre-load. */
const seed = (page, entries = {}) => page.addInitScript((s) => {
  for (const k of [s.LEAGUE_KEY, s.HIST_V1, s.HIST_V2, 'nfl2026.team.v1',
    'nfl2026.taken.v1']) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(s.entries)) localStorage.setItem(k, v);
}, { LEAGUE_KEY, HIST_V1, HIST_V2, entries });

/** A saved profile that is NOT the default (half PPR, 10 teams). */
const HALF_PPR_LEAGUE = JSON.stringify({
  version: 1,
  name: 'Dynasty Half',
  scoring: { rec: 0.5 },
  shape: {
    teams: 10,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  },
});

/**
 * A LIVE snake record with enough observed opponent picks to clear
 * MIN_CALIBRATION_PICKS (24), every one of them taken 5 picks EARLIER than
 * consensus so the room reads unambiguously as a reaching room.
 */
function liveRecord(picks = 36, drift = -5) {
  const observed = [];
  for (let i = 0; i < picks; i += 1) {
    const pick = i + 1;
    observed.push({
      pick,
      team: (i % 12) + 1,
      name: `Opp ${pick}`,
      // Consensus said `pick - drift`; the room took him at `pick`.
      position: ['RB', 'WR', 'TE', 'QB'][i % 4],
      adp: pick - drift,
    });
  }
  return {
    version: 2,
    created_utc: '2026-08-01T00:00:00.000Z',
    kind: 'snake',
    play: 'live',
    room_type: 'adp',
    league_size: 12,
    my_slot: 5,
    roster_config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 },
    result: { mine: 1200, roomAvg: 1150, margin: 50, rank: 2, teams: 12 },
    my_players: [],
    observed,
  };
}

const gotoTeam = async (page) => {
  await page.goto('/#/team');
  await page.waitForSelector('.draftsim .ds-start', { timeout: 15000 });
};

/* ==========================================================================
   1. The ROOM selector and its explainer
   ========================================================================== */

test.describe('R23-S1 · the ROOM selector offers AI+ and says what each room is', () => {
  test('three rooms, ADP still the default, and the LEAGUE grid is unchanged', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);

    const room = page.locator('.ds-select[data-dcfg="roomType"]');
    await expect(room).toHaveCount(1);
    expect(await room.locator('option').allInnerTexts())
      .toEqual(['ADP', 'SHARK', 'AI+']);
    // The default a returning manager opens on has not moved.
    await expect(room).toHaveValue('adp');
    // The explainer is NOT a sixth field — the setup grid keeps its five.
    expect(await page.locator('.ds-grid--league .ds-field').count()).toBe(5);
  });

  test('every room carries one line, and the selected one is lit', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);

    const key = page.locator('.ds-roomkey');
    await expect(key).toHaveCount(1);
    expect(await key.locator('.ds-rk').count()).toBe(3);
    expect(await key.locator('.ds-rk-tag').allInnerTexts())
      .toEqual(['ADP', 'SHARK', 'AI+']);
    // Each line says WHO the opponents are, in three distinguishable ways.
    await expect(key.locator('.ds-rk').nth(0)).toContainText('consensus board');
    await expect(key.locator('.ds-rk').nth(1)).toContainText('stress test');
    await expect(key.locator('.ds-rk').nth(2)).toContainText('YOUR saved league');
    // Exactly one is lit, and it is the one the select is on.
    expect(await key.locator('.ds-rk--on').count()).toBe(1);
    await expect(key.locator('.ds-rk--on .ds-rk-tag')).toHaveText('ADP');

    await page.locator('.ds-select[data-dcfg="roomType"]').selectOption('aiplus');
    await expect(page.locator('.ds-roomkey .ds-rk--on .ds-rk-tag')).toHaveText('AI+');
  });

  test('the room key disappears in AUCTION mode, where there is no ROOM select', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await expect(page.locator('.ds-select[data-dcfg="roomType"]')).toHaveCount(0);
    await expect(page.locator('.ds-roomkey')).toHaveCount(0);
  });
});

/* ==========================================================================
   2. AI+ with no league saved — the honesty case
   ========================================================================== */

test.describe('R23-S1 · AI+ never implies it is modelling a league it does not have', () => {
  test('with nothing saved it names the fallback as a standard PPR room', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="roomType"]').selectOption('aiplus');

    const warn = page.locator('.ds-roomkey .ds-rk-warn').first();
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('NO LEAGUE PROFILE SAVED');
    await expect(warn).toContainText('full PPR');
    await expect(warn).toContainText('SAVE LEAGUE SETTINGS');
    // And the scope of what AI+ does model is stated, not implied.
    await expect(page.locator('.ds-roomkey')).toContainText('per-reception');
    await expect(page.locator('.ds-roomkey')).toContainText('not modelled');
  });

  test('with a real profile saved it names THAT league and drops the warning', async ({ page }) => {
    await seed(page, { [LEAGUE_KEY]: HALF_PPR_LEAGUE });
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="roomType"]').selectOption('aiplus');

    const key = page.locator('.ds-roomkey');
    await expect(key).toContainText('Dynasty Half');
    await expect(key).toContainText('10 TEAMS');
    await expect(key.locator('.ds-rk-warn')).toHaveCount(0);
  });

  test('an unsaved shape change is called out — AI+ reads the SAVED profile', async ({ page }) => {
    await seed(page, { [LEAGUE_KEY]: HALF_PPR_LEAGUE });
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="roomType"]').selectOption('aiplus');
    await expect(page.locator('.ds-roomkey .ds-rk-warn')).toHaveCount(0);

    await page.locator('.ds-select[data-dcfg="bench"]').selectOption('7');
    const warn = page.locator('.ds-roomkey .ds-rk-warn').first();
    await expect(warn).toContainText('UNSAVED');
    await expect(warn).toContainText('SAVE LEAGUE SETTINGS');
  });

  test('an AI+ draft actually runs and the room header says AI+', async ({ page }) => {
    await seed(page, { [LEAGUE_KEY]: HALF_PPR_LEAGUE });
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="roomType"]').selectOption('aiplus');
    await page.locator('.ds-start').click();

    await expect(page.locator('.draftsim .ds-title')).toContainText('AI+ ROOM');
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });
    // The survival lookahead still runs (it is handed the AI+ context).
    await expect(page.locator('.ds-cand .ds-surv').first()).toContainText('survives');
  });
});

/* ==========================================================================
   3. DRAFT HISTORY — counted, migrated, and honestly bounded
   ========================================================================== */

test.describe('R23-S1 · draft history says what it is and what it cannot claim', () => {
  test('empty state offers no number and claims no mechanism', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    const hist = page.locator('.ds-hist');
    await expect(hist).toContainText('Nothing recorded yet');
    await expect(hist).not.toContainText('learning record');
  });

  test('finishing a SIM mock records it and refuses to call it evidence', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    // Smallest legal room: 8 teams x (1QB+2RB+2WR+1TE+0FLEX+4BN) = 10 rounds.
    await page.locator('.ds-select[data-dcfg="leagueSize"]').selectOption('8');
    await page.locator('.ds-select[data-dcfg="flex"]').selectOption('0');
    await page.locator('.ds-select[data-dcfg="bench"]').selectOption('4');
    await page.locator('.ds-start').click();
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });
    for (let i = 0; i < 10; i += 1) {
      const pick = page.locator('.ds-cand [data-act="draft-pick"]').first();
      if (await pick.count() === 0) break;
      await pick.click();
      await page.waitForTimeout(60);
    }
    await expect(page.locator('.ds-score')).toBeVisible();
    // The result card no longer claims a refit; it says what a sim is worth.
    const card = page.locator('.draftsim');
    await expect(card).toContainText('DRAFT HISTORY');
    await expect(card).toContainText('SIM room teaches nothing');
    await expect(card).not.toContainText('NEVER-REGRESS');

    // The record landed under the current key, tagged sim, with no observed
    // room — a sim has no room to observe.
    const rows = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), HIST_V2);
    expect(rows.length).toBe(1);
    expect(rows[0].play).toBe('sim');
    expect(rows[0].kind).toBe('snake');
    expect(rows[0].observed).toEqual([]);

    // Back on the setup card the panel counts it and stays not-measured.
    await page.locator('[data-act="draft-close"]').click();
    const hist = page.locator('.ds-hist');
    await expect(hist).toContainText('1 sim');
    await expect(hist).toContainText('NOT MEASURED');
    await expect(hist).toContainText('SIM mocks are not evidence');
  });

  test('rows under the superseded key migrate in, and that key survives', async ({ page }) => {
    const legacy = JSON.stringify([
      { created_utc: '2026-07-01T00:00:00.000Z', league_size: 12, my_slot: 3,
        result: { margin: 12 }, my_players: [] },
      { created_utc: '2026-07-02T00:00:00.000Z', kind: 'auction', league_size: 12,
        budget: 200, result: { margin: -4 }, my_players: [] },
    ]);
    await seed(page, { [HIST_V1]: legacy });
    await gotoTeam(page);

    const hist = page.locator('.ds-hist');
    await expect(page.locator('.ds-sub', { hasText: 'DRAFT HISTORY' }))
      .toContainText('2 RECORDED');
    await expect(hist).toContainText('carried over');
    // A migrated snake row has no known play mode, so it can never calibrate.
    await expect(hist).toContainText('play mode unknown');
    await expect(hist).toContainText('NOT MEASURED');

    const state = await page.evaluate(([v1, v2]) => ({
      v1: JSON.parse(localStorage.getItem(v1) || 'null'),
      v2: JSON.parse(localStorage.getItem(v2) || 'null'),
    }), [HIST_V1, HIST_V2]);
    expect(Array.isArray(state.v2)).toBe(true);
    expect(state.v2.length).toBe(2);
    // The old copy is left exactly where it was — a rollback loses nothing.
    expect(Array.isArray(state.v1)).toBe(true);
    expect(state.v1.length).toBe(2);
  });

  test('CLEAR HISTORY needs a second tap and then wipes both keys', async ({ page }) => {
    await seed(page, { [HIST_V2]: JSON.stringify([liveRecord()]) });
    await gotoTeam(page);

    const btn = page.locator('[data-act="hist-clear"]');
    // Destructive control: a full 44px target, not the 32px draft-room chip.
    expect((await btn.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await btn.click();
    await expect(page.locator('[data-act="hist-clear"]')).toContainText('TAP AGAIN');
    await page.locator('[data-act="hist-clear"]').click();

    await expect(page.locator('.ds-hist')).toContainText('Nothing recorded yet');
    const left = await page.evaluate(([a, b]) => [
      localStorage.getItem(a), localStorage.getItem(b),
    ], [HIST_V1, HIST_V2]);
    expect(left).toEqual([null, null]);
  });
});

/* ==========================================================================
   4. Calibration is CONSUMED — a pick number in the draft room
   ========================================================================== */

test.describe('R23-S1 · LIVE-room calibration reaches the board as a pick number', () => {
  test('enough live evidence lights the panel with a measured drift', async ({ page }) => {
    await seed(page, { [HIST_V2]: JSON.stringify([liveRecord()]) });
    await gotoTeam(page);

    const hist = page.locator('.ds-hist');
    await expect(hist).toContainText('1 live');
    await expect(hist).not.toContainText('NOT MEASURED');
    const cal = page.locator('.ds-hcal--on');
    await expect(cal).toContainText('THIS ROOM REACHES');
    await expect(cal).toContainText('5.0 picks EARLIER');
    await expect(cal).toContainText('36 observed opponent picks');
    // The policy line is on the panel, not just in a comment.
    await expect(hist).toContainText('PICK NUMBER');
    await expect(hist).toContainText('feeds no projection');
  });

  // R23-B2: this test used to seed a room that reaches 5 picks EARLY and then
  // assert the chip in a SIM room. Both halves were defects and are now fixed
  // in app/views/team.js, so the test drives the honest case instead:
  //  - the seeded room takes players 5 picks LATER than consensus, so the
  //    predicted pick is still ahead of the pick on screen. (Reaching rooms
  //    clamp to pick 1, which for a player visibly still on the board is a
  //    claim the screen contradicts — the chip is suppressed there now, and
  //    tests/web/team_live_room.spec.mjs locks that suppression.)
  //  - a SIM room says "your room: ~N", never "here". The "here" wording is
  //    locked for LIVE in tests/web/team_live_room.spec.mjs.
  test('the draft room prints the calibrated pick number beside consensus ADP', async ({ page }) => {
    await seed(page, { [HIST_V2]: JSON.stringify([liveRecord(36, 5)]) });
    await gotoTeam(page);
    await page.locator('.ds-start').click();
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });

    // Every candidate whose consensus ADP actually moves in this room carries
    // it; a row whose predicted pick rounds back onto the current pick is the
    // only one allowed to omit it.
    expect(await page.locator('.ds-cand .ds-gone').count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.ds-cand .ds-gone').first())
      .toContainText(/your room: ~[\d.]+/);
    // It is a PICK NUMBER: the row's own points cell is a separate number and
    // is not what "gone" reports.
    const meta = await page.locator('.ds-cand .cd-meta').first().innerText();
    expect(meta).toMatch(/ADP \d+/);
    expect(meta).toMatch(/pts/);
  });

  test('with no live evidence the board shows consensus ADP alone', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-start').click();
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });
    expect(await page.locator('.ds-cand .ds-gone').count()).toBe(0);
  });
});

/* ==========================================================================
   5. The auction: the room's likely price beside OUR dollars
   ========================================================================== */

test.describe('R23-S1 · the auction block labels the room price display-only', () => {
  test('MARKET sits beside OURS and carries the app\'s one badge, verbatim', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('[data-act="auc-start"]').click();
    await page.waitForSelector('.auc-pool', { timeout: 15000 });
    await page.locator('[data-act="auc-nom"]').first().click();

    const prices = page.locator('.auc-prices');
    await expect(prices).toContainText('OURS $');
    await expect(prices).toContainText('INFL-ADJ $');
    await expect(prices).toContainText('MARKET $');
    await expect(prices.locator('.ms-badge')).toHaveText(BADGE);
    // And the room price says where it came from, since it is no longer
    // always the ADP-decay transform.
    await expect(page.locator('.auc-mktsrc')).toContainText('Room price');
    await expect(page.locator('.auc-mktsrc')).toContainText(/winning bid|ADP rank/);
  });
});
