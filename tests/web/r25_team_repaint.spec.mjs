/* tests/web/r25_team_repaint.spec.mjs — R25-F1: what the Team view's repaint
 * work was allowed to change, and what it was NOT.
 *
 * Three performance fixes landed in app/views/team.js. Each is only safe
 * because it is OUTPUT-NEUTRAL, and "output-neutral" is exactly the kind of
 * claim that rots silently. These tests are the lock.
 *
 *  1. MOUNT TEARDOWN. This view delegates ten listeners onto #view — the ONE
 *     permanent element app/main.js hands every route, never replaced between
 *     navigations. With no teardown, every superseded mount's handlers stayed
 *     live and kept repainting from a dead closure on every click aimed at the
 *     CURRENT mount: measured +10 live listeners and +0.13 MiB per Team visit,
 *     and a finder sort repaint growing linearly at ~5.4 ms per prior mount
 *     (5.3 ms after one mount, 71.7 ms after twelve). test 1 pins the listener
 *     count flat across repeat visits; test 2 pins that one click still does
 *     exactly one thing.
 *  2. PER-PAINT SLOT MEMO in paintCands. firstEligibleOpenSlot() and
 *     positionAtCap() are pure in (position, roster.slots, savedProfile,
 *     playersById) and only `position` varies across rows, so they are now
 *     resolved once per position per paint instead of once per row. test 3
 *     drives the two answers that memo must keep getting right: which slot an
 *     ADD lands in, and when a position reads FULL.
 *  3. IDEMPOTENT DRAFT-SETUP WRITE. paintAll() repaints all five panels on
 *     every ADD/REMOVE, but the draft setup card reads no roster state, so it
 *     rebuilt 8.4 kB of identical HTML. It is now skipped when the markup is
 *     character-for-character identical. test 4 pins that a roster change does
 *     NOT disturb the card and a draft-config change still DOES repaint it.
 */

import { test, expect } from '@playwright/test';

/** Count live listeners on the shared #view element via CDP. */
async function viewListeners(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  const { result } = await cdp.send('Runtime.evaluate', { expression: "document.getElementById('view')" });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await cdp.detach();
  return listeners.length;
}

const gotoTeam = async (page) => {
  await page.goto('/#/team');
  await expect(page.locator('#t-cands .cand').first()).toBeVisible();
};

/* ==========================================================================
   1. The mount teardown
   ========================================================================== */

test('repeat Team visits do not accumulate listeners on the shared #view', async ({ page }) => {
  await gotoTeam(page);
  const afterFirst = await viewListeners(page);
  expect(afterFirst).toBeGreaterThan(0); // the view really does delegate on #view

  for (let i = 0; i < 6; i += 1) {
    await page.goto('/#/');
    await expect(page.locator('#view .tab-slate, #view').first()).toBeVisible();
    await gotoTeam(page);
  }
  // Flat, not 7x. Before the teardown this was afterFirst + 60.
  expect(await viewListeners(page)).toBe(afterFirst);
});

test('after several Team visits one finder click still performs exactly one repaint', async ({ page }) => {
  await gotoTeam(page);
  for (let i = 0; i < 4; i += 1) {
    await page.goto('/#/');
    await gotoTeam(page);
  }
  // A superseded mount's handler would repaint #t-cands a second time from its
  // own stale closure. Count the childList mutations one click produces.
  const mutations = await page.evaluate(async () => {
    const box = document.getElementById('t-cands');
    let n = 0;
    const obs = new MutationObserver((recs) => { for (const r of recs) if (r.type === 'childList') n += 1; });
    obs.observe(box, { childList: true });
    document.querySelector('button[data-fsort="trend"]').click();
    await new Promise((r) => setTimeout(r, 100));
    obs.disconnect();
    return n;
  });
  expect(mutations).toBe(1);
});

/* ==========================================================================
   2. The per-paint slot memo still answers per position
   ========================================================================== */

test('the memoised slot lookup seats each ADD in its own first eligible open slot', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('nfl2026.team.v1'));
  await gotoTeam(page);

  // Seat one QB and two RBs. The default profile has QB1, RB1, RB2 — a memo
  // keyed on position that failed to re-resolve after each ADD would put the
  // second RB back in RB1, or refuse it entirely.
  const seat = async (pos) => {
    await page.click(`button[data-fpos="${pos}"]`);
    await page.locator('#t-cands .cand-add:not([disabled])').first().click();
  };
  await seat('QB');
  await seat('RB');
  await seat('RB');

  const filled = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#t-roster .slot').forEach((s) => {
      const p = s.querySelector('.slot-player .sp-name');
      if (p) out[s.dataset.slot] = p.textContent.trim();
    });
    return out;
  });
  expect(Object.keys(filled).sort()).toEqual(['QB1', 'RB1', 'RB2']);
  expect(filled.RB1).not.toBe(filled.RB2);

  // POSITION CAP. The default profile caps QB at 2 (QB1 + a bench seat is fine,
  // a third is not). Seat QBs until the finder says so, then hold it to that.
  await page.click('button[data-fpos="QB"]');
  for (let i = 0; i < 8; i += 1) {
    const add = page.locator('#t-cands .cand-add:not([disabled])').first();
    if (await add.count() === 0) break;
    await add.click();
    await page.click('button[data-fpos="QB"]');
  }
  const capState = await page.evaluate(() => {
    // .cand--more is the "+ N more — refine search" hint; it carries no button.
    const rows = [...document.querySelectorAll('#t-cands .cand:not(.cand--more)')];
    const labels = new Set(rows.map((r) => r.querySelector('.cand-add')?.textContent.trim()));
    return {
      rows: rows.length,
      labels: [...labels],
      allDisabled: rows.every((r) => r.querySelector('.cand-add')?.disabled === true),
    };
  });
  expect(capState.rows).toBeGreaterThan(0);
  // Every remaining QB row reports the SAME verdict — the memo must not hand
  // one row "ADD" and the next "QB FULL" for the same position and roster.
  expect(capState.labels).toHaveLength(1);
  if (capState.labels[0] === 'QB FULL') expect(capState.allDisabled).toBe(true);
});

/* ==========================================================================
   3. The idempotent draft-setup write
   ========================================================================== */

test('seating a player leaves the draft setup card alone; changing the draft config repaints it', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('nfl2026.team.v1'));
  await gotoTeam(page);
  await expect(page.locator('#t-draft .ds-start')).toBeVisible();

  const before = await page.evaluate(() => document.getElementById('t-draft').innerHTML);
  const startBtn = await page.evaluateHandle(() => document.querySelector('#t-draft .ds-start'));

  await page.locator('#t-cands .cand-add:not([disabled])').first().click();
  await expect(page.locator('#t-roster .slot-player')).toHaveCount(1);

  // Byte-identical markup AND the very same node — an ADD changes no draft state.
  expect(await page.evaluate(() => document.getElementById('t-draft').innerHTML)).toBe(before);
  expect(await page.evaluate((b) => b === document.querySelector('#t-draft .ds-start'), startBtn)).toBe(true);

  // A real draft-config change must still repaint the card.
  await expect(page.locator('#t-draft .ds-start')).toContainText('13 ROUNDS'); // 7 starters + 6 bench
  await page.selectOption('#t-draft select[data-dcfg="bench"]', '8');
  await expect(page.locator('#t-draft .ds-start')).toContainText('15 ROUNDS'); // 7 starters + 8 bench
  expect(await page.evaluate(() => document.getElementById('t-draft').innerHTML)).not.toBe(before);
});
