/* tests/web/team_live_room.spec.mjs — R23-B2: the LIVE room's SURFACE.
 *
 * Three of these four defects were real in the VIEW while the ENGINE was
 * already correct, which is exactly the class of bug a unit test cannot see.
 * Each block below locks one of them in a real browser.
 *
 *  1. THE BUYER PICKER CANNOT OFFER A TEAM THAT CANNOT BUY. app/auction.js
 *     exports canBuy()/buyerOptions() and sellTo() returns null for a full
 *     roster — but the <select class="auc-soldteam"> was built from every team
 *     and the handler dropped sellTo's return, so RECORD SALE on a full team
 *     was a silent no-op. Now the option is not there, and if a sale is
 *     refused anyway the block zone says why.
 *
 *  2. EVERY UNTAKEN PLAYER IS TAPPABLE IN A LIVE SNAKE DRAFT. The tap list was
 *     the 15 lowest-ADP untaken rows with no search, so an off-consensus pick
 *     — a superflex QB, a deep reach — could not be recorded at all. That is
 *     the tail roomCalibration() exists to measure, so the sample was censored
 *     on exactly the observations that matter, and the manager's only way to
 *     continue was to tap the WRONG player and fabricate evidence.
 *
 *  3. THE CALIBRATION CHIP NEVER CONTRADICTS THE SCREEN, AND NEVER SAYS
 *     "HERE" ABOUT A ROOM THAT IS NOT ON SCREEN. expectedGoneBy() clamps to
 *     pick 1, so a reaching room claimed several players on the board went at
 *     pick 1. And "here" meant the manager's real room while the room being
 *     drafted was the practice sampler.
 *
 * (The fourth finding — the stale SELF-LEARNING HOOK comment in
 * app/draft-sim.js — is a source claim, locked by tests/feature/mocks.test.mjs
 * rather than by a browser.)
 */

import { test, expect } from '@playwright/test';

const LEAGUE_KEY = 'nfl2026.league.v1';
const HIST_V1 = 'nfl2026.mocklocks.v1';
const HIST_V2 = 'nfl2026.mockhistory.v2';

const seed = (page, entries = {}) => page.addInitScript((s) => {
  for (const k of [s.LEAGUE_KEY, s.HIST_V1, s.HIST_V2, 'nfl2026.team.v1',
    'nfl2026.taken.v1']) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(s.entries)) localStorage.setItem(k, v);
}, { LEAGUE_KEY, HIST_V1, HIST_V2, entries });

const gotoTeam = async (page) => {
  await page.goto('/#/team');
  await page.waitForSelector('.draftsim .ds-start', { timeout: 15000 });
};

/** A LIVE snake record whose room takes players `drift` picks LATER than
 * consensus (positive drift = "he falls to you"), with enough observed picks
 * to clear MIN_CALIBRATION_PICKS. */
function liveRecord(picks = 36, drift = 5) {
  const observed = [];
  for (let i = 0; i < picks; i += 1) {
    const pick = i + 1;
    observed.push({
      pick,
      team: (i % 12) + 1,
      name: `Opp ${pick}`,
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

/* The smallest legal room, so a LIVE auction can fill a roster in few taps:
 * 8 teams x (1QB + 2RB + 2WR + 1TE + 0 FLEX + 4 BN) = 10 slots per team. */
const smallRoom = async (page) => {
  await page.locator('.ds-select[data-dcfg="leagueSize"]').selectOption('8');
  await page.locator('.ds-select[data-dcfg="flex"]').selectOption('0');
  await page.locator('.ds-select[data-dcfg="bench"]').selectOption('4');
};

/* ==========================================================================
   1. The LIVE auction buyer picker
   ========================================================================== */

test.describe('R23-B2 · a LIVE sale can only be recorded against a team that can buy', () => {
  test('a full roster is not an option in the picker, and RECORD SALE is not a no-op', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await smallRoom(page);
    await page.locator('[data-act="auc-start"]').click();
    await page.waitForSelector('.auc-zone', { timeout: 15000 });

    // Fill T1 (index 0) by recording ten $1 sales to it. Ten is the roster
    // size, so the tenth is its last legal purchase.
    for (let i = 0; i < 10; i += 1) {
      await page.locator('[data-act="auc-nom"]').first().click();
      await page.waitForSelector('.auc-soldrow', { timeout: 15000 });
      expect(await page.locator('.auc-soldteam option').count(),
        `every team can still buy before T1's purchase #${i + 1}`).toBe(8);
      await page.locator('.auc-soldteam').selectOption('0');
      // $1 apiece, so the ROSTER is what runs out, not the budget. (Set the
      // displayed price directly rather than tapping − eighty times; the
      // stepper itself is covered by the auction spec.)
      await page.evaluate(() => {
        const p = document.querySelector('.auc-soldprice');
        p.dataset.price = '1';
        p.textContent = '$1';
      });
      await page.locator('[data-act="auc-sold"]').click();
      await page.waitForSelector('.auc-pool', { timeout: 15000 });
    }

    // THE LOCK: T1 has all ten slots, so the picker no longer offers it.
    await page.locator('[data-act="auc-nom"]').first().click();
    await page.waitForSelector('.auc-soldrow', { timeout: 15000 });
    const values = await page.locator('.auc-soldteam option')
      .evaluateAll((os) => os.map((o) => o.value));
    expect(values).not.toContain('0');
    expect(values.length).toBe(7);

    // And a sale to a team that CAN buy still works from the same block:
    // the SOLD counter in the header advances.
    const sold = async () => Number((await page.locator('.ds-status').innerText()).split('/')[0]);
    const before = await sold();
    await page.locator('.auc-soldteam').selectOption('1');
    await page.locator('[data-act="auc-sold"]').click();
    await page.waitForSelector('.auc-pool', { timeout: 15000 });
    expect(await sold()).toBe(before + 1);
  });

  test('a refused sale says why instead of repainting an unchanged block', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await smallRoom(page);
    await page.locator('[data-act="auc-start"]').click();
    await page.locator('[data-act="auc-nom"]').first().click();
    await page.waitForSelector('.auc-soldrow', { timeout: 15000 });

    // Force the refusal path the picker now prevents: hand T2 a full roster
    // behind the picker's back, then submit the stale option that is still in
    // the DOM. sellTo() returns null; the surface must SAY so.
    await page.evaluate(() => {
      const opt = document.createElement('option');
      opt.value = '99';                     // a team index that does not exist
      opt.textContent = 'GHOST';
      const sel = document.querySelector('.auc-soldteam');
      sel.appendChild(opt);
      sel.value = '99';
    });
    await page.locator('[data-act="auc-sold"]').click();

    const refusal = page.locator('.auc-refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('cannot be recorded');
    // Nothing moved: the same player is still on the block.
    await expect(page.locator('.auc-zone--block')).toBeVisible();

    // The next action clears the notice — it is a response, not a banner.
    await page.locator('[data-act="auc-cancel"]').click();
    await expect(page.locator('.auc-refusal')).toHaveCount(0);
  });
});

/* ==========================================================================
   2. The LIVE snake tap list reaches the whole board
   ========================================================================== */

test.describe('R23-B2 · a LIVE snake draft can record any pick the room actually makes', () => {
  test('a filter spans the whole board, so an off-consensus pick is tappable', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('.ds-start').click();
    await page.waitForSelector('[data-act="draft-live-take"]', { timeout: 15000 });

    // The old surface offered exactly 15 rows and no input at all.
    // The finder list further down the page has its own TOOK buttons, so the
    // tap list is always addressed through its own container.
    const chips = page.locator('.auc-pool--live [data-act="draft-live-take"]');
    const find = page.locator('.ds-livefind');
    await expect(find).toHaveCount(1);
    expect(await chips.count()).toBeGreaterThan(15);
    // 44px touch targets, per the project's own rule.
    expect((await find.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await chips.first().boundingBox()).height).toBeGreaterThanOrEqual(44);

    // A player far outside the top of the consensus board — the reach this
    // room's calibration exists to measure. Read his name off the board
    // itself so the test never invents a player (HONEST DATA).
    const deep = await page.evaluate(async () => {
      const doc = await (await fetch('/data/adp.json')).json();
      const rows = doc.players || doc;
      return rows[120].name;
    });

    await find.fill(deep);
    await expect(chips.first()).toContainText(deep, { timeout: 15000 });
    expect(await chips.count()).toBeLessThan(15);

    // Tapping it records THAT player as the opponent's pick — the whole point.
    await chips.first().click();
    await expect(page.locator('.ds-log').first()).toContainText(deep);
    // And the filter resets, so the next opponent starts from the full board.
    await expect(page.locator('.ds-livefind')).toHaveValue('');
    expect(await chips.count()).toBeGreaterThan(15);
  });

  test('a filter that matches nothing untaken says so rather than showing chalk', async ({ page }) => {
    await seed(page);
    await gotoTeam(page);
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('.ds-start').click();
    await page.waitForSelector('[data-act="draft-live-take"]', { timeout: 15000 });

    await page.locator('.ds-livefind').fill('zzzzzznotaplayer');
    await expect(page.locator('.auc-pool--live')).toContainText('no untaken player matches');
    expect(await page.locator('.auc-pool--live [data-act="draft-live-take"]').count()).toBe(0);
  });
});

/* ==========================================================================
   3. The calibration chip never contradicts the board
   ========================================================================== */

test.describe('R23-B2 · "gone ~N" is bounded by the pick on screen and names the right room', () => {
  test('a reaching room never claims a player on the board went at pick 1', async ({ page }) => {
    // drift -5: the room takes players FIVE PICKS EARLIER than consensus, so
    // expectedGoneBy clamps the top of the board onto pick 1. Those players
    // are visibly still available, so no chip may claim them.
    await seed(page, { [HIST_V2]: JSON.stringify([liveRecord(36, -5)]) });
    await gotoTeam(page);
    await page.locator('.ds-start').click();
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });

    const shown = await page.locator('.ds-status').innerText();   // "PICK 5/156"
    const curPick = Number(shown.match(/PICK (\d+)/)[1]);
    const chips = await page.locator('.ds-cand .ds-gone').allInnerTexts();
    for (const c of chips) {
      const n = Number(c.match(/~([\d.]+)/)[1]);
      expect(n).toBeGreaterThan(curPick);
    }
  });

  test('a SIM room says "your room", and only a LIVE room says "here"', async ({ page }) => {
    // drift +5: the room takes players LATER than consensus, so the predicted
    // pick is ahead of the board and the chip is admissible in both modes.
    await seed(page, { [HIST_V2]: JSON.stringify([liveRecord(36, 5)]) });
    await gotoTeam(page);

    // SIM: these opponents are the practice sampler, not the measured room.
    await page.locator('.ds-start').click();
    await page.locator('[data-act="draft-sim"]').click();
    await page.waitForSelector('.ds-cand', { timeout: 15000 });
    const simChips = page.locator('.ds-cand .ds-gone');
    expect(await simChips.count()).toBeGreaterThan(0);
    for (const t of await simChips.allInnerTexts()) {
      expect(t).toMatch(/your room: ~[\d.]+/);
      expect(t).not.toContain('here');
    }
    await expect(simChips.first()).toHaveAttribute('title', /practice sampler/);

    // LIVE: the room on screen IS the measured room, so "here" is true.
    await page.locator('[data-act="draft-close"]').click();
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('.ds-start').click();
    // mySlot defaults to 5, so four opponents pick before the reco panel shows.
    for (let i = 0; i < 4; i += 1) {
      await page.locator('[data-act="draft-live-take"]').first().click();
    }
    await page.waitForSelector('.ds-cand', { timeout: 15000 });
    const liveChips = page.locator('.ds-cand .ds-gone');
    expect(await liveChips.count()).toBeGreaterThan(0);
    for (const t of await liveChips.allInnerTexts()) expect(t).toMatch(/gone ~[\d.]+ here/);
    await expect(liveChips.first()).not.toHaveAttribute('title', /practice sampler/);
  });
});
