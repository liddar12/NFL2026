/* tests/web/web.spec.mjs — project `web` (Agent D).
 *
 * Proves the WEB (in-browser) UI works INDEPENDENTLY of the installed PWA. No
 * standalone emulation, no injected safe-area insets: this is what a visitor sees
 * in mobile Safari before installing. Asserts:
 *   1. the app shell renders (topbar / tabbar / view present),
 *   2. each route (#/, #/players, #/parlays) paints its cards,
 *   3. it runs under display-mode: browser (NOT dependent on standalone),
 *   4. with NO safe-area insets the topbar / tabbar / view do not overlap.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** Read a committed data contract — the tests derive expectations from the
 * SAME JSON the app serves, so they never hardcode player names or counts. */
const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

/** Poll until the view has painted at least one card of the given selector. */
async function waitForCards(page, selector) {
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    selector,
    { timeout: 8000 },
  );
}

/** Navigate to a hash route and wait for the router to settle it. */
async function goRoute(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForFunction(
    (h) => window.location.hash === h || (h === '#/' && window.location.hash === ''),
    hash,
    { timeout: 8000 },
  );
}

test.describe('web (in-browser) experience', () => {
  test('app shell renders and reports display-mode: browser', async ({ page }) => {
    await page.goto('/');

    // Shell landmarks from the contract markup exist.
    await expect(page.locator('.app')).toHaveCount(1);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect(page.locator('.view')).toHaveCount(1);

    // A plain browser tab is display-mode: browser, NOT standalone. The UI must
    // not require standalone to function.
    const isBrowser = await page.evaluate(
      () => window.matchMedia('(display-mode: browser)').matches,
    );
    expect(isBrowser).toBe(true);
    const isStandalone = await page.evaluate(
      () => window.matchMedia('(display-mode: standalone)').matches,
    );
    expect(isStandalone).toBe(false);
  });

  test('slate route paints game cards with a win-prob track', async ({ page }) => {
    await page.goto('/');
    await goRoute(page, '#/');
    await waitForCards(page, '.card.game');
    expect(await page.locator('.card.game').count()).toBeGreaterThanOrEqual(1);
    // Every game card carries the probability track (the core viz).
    expect(await page.locator('.card.game .track').count()).toBeGreaterThanOrEqual(1);
  });

  test('players route paints player cards', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    expect(await page.locator('.card.player').count()).toBeGreaterThanOrEqual(1);
  });

  test('parlays route paints parlay cards', async ({ page }) => {
    await page.goto('/#/parlays');
    await waitForCards(page, '.card.parlay');
    expect(await page.locator('.card.parlay').count()).toBeGreaterThanOrEqual(1);
  });

  test('with NO safe-area insets, shell regions do not overlap', async ({ page }) => {
    // The default browser environment has zero safe-area insets. The topbar,
    // scrolling view, and fixed tabbar must still tile without collisions.
    await page.goto('/');
    await waitForCards(page, '.card');

    const boxes = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        topbar: rect('.topbar'),
        tabbar: rect('.tabbar'),
        view: rect('.view'),
      };
    });

    expect(boxes.topbar, 'topbar missing').not.toBeNull();
    expect(boxes.tabbar, 'tabbar missing').not.toBeNull();
    expect(boxes.view, 'view missing').not.toBeNull();

    // Topbar sits above the scrolling view (allow a 1px rounding fudge).
    expect(boxes.view.top).toBeGreaterThanOrEqual(boxes.topbar.bottom - 1);
    // The fixed tabbar is anchored to the bottom, below the topbar.
    expect(boxes.tabbar.top).toBeGreaterThanOrEqual(boxes.topbar.bottom - 1);
  });
});

/* ---------------------------------------------------------------------------
 * Build 3 — week selector, weekly strips, scoring toggle, team builder
 * (Agent E). Expected values are derived from the committed data contracts at
 * runtime, never hardcoded.
 * ------------------------------------------------------------------------- */

test.describe('week selector (slate)', () => {
  test('clicking a week chip re-renders the slate to that week', async ({ page }) => {
    // Derive per-week game counts from the schedule contract; pick the week
    // with the FEWEST games (a bye week) so the count provably differs from
    // the default week's full slate.
    const sched = readData('schedule_full.json');
    const preds = readData('game_predictions.json');
    const defaultWeek = Number(preds.week);
    const perWeek = new Map();
    for (const g of sched.games) {
      perWeek.set(Number(g.week), (perWeek.get(Number(g.week)) || 0) + 1);
    }
    let target = null;
    for (const [wk, n] of perWeek) {
      if (wk === defaultWeek) continue;
      if (target === null || n < perWeek.get(target)) target = wk;
    }
    expect(target).not.toBeNull();
    expect(perWeek.get(target)).not.toBe(perWeek.get(defaultWeek));

    await page.goto('/#/');
    await waitForCards(page, '.card.game');

    // Default paint: the pipeline's current week, its chip active.
    await expect(page.locator('.wk-chip--active')).toHaveAttribute(
      'data-wk', String(defaultWeek),
    );
    expect(await page.locator('.card.game').count()).toBe(perWeek.get(defaultWeek));

    // Switch weeks: the active chip moves and the slate repaints to the bye
    // week's (smaller) game count.
    await page.locator(`.wk-chip[data-wk="${target}"]`).click();
    await expect(page.locator('.wk-chip--active')).toHaveAttribute(
      'data-wk', String(target),
    );
    await page.waitForFunction(
      (n) => document.querySelectorAll('.card.game').length === n,
      perWeek.get(target),
      { timeout: 8000 },
    );
    const shown = await page.locator('.card.game').count();
    expect(shown).toBe(perWeek.get(target));
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).not.toBe(perWeek.get(defaultWeek));
  });
});

test.describe('players weekly strip + scoring toggle', () => {
  test('expanding a player card shows 18 week cells including a BYE', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');

    const card = page.locator('.card.player').first();
    const btn = card.locator('.p-expand');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');

    const strip = card.locator('.wkstrip');
    await expect(strip).toBeVisible();
    // 18 regular-season cells, exactly one of them the player's bye.
    await expect(strip.locator('.wkcell')).toHaveCount(18);
    expect(await strip.locator('.wkcell--bye').count()).toBeGreaterThanOrEqual(1);
  });

  test('scoring toggle to STD lowers a receiving WR\'s displayed season points', async ({ page }) => {
    // Pick (at runtime) a WR with a real receptions prior, so std < ppr.
    const proj = readData('player_projections.json');
    const weekly = readData('player_weekly.json');
    const recById = new Map(
      weekly.players.map((p) => [p.gsis_id, Number(p.receptions_prior) || 0]),
    );
    const wr = proj.players.find(
      (p) => p.position === 'WR' && recById.get(p.gsis_id) > 0,
    );
    expect(wr, 'no WR with a receptions prior in the data').toBeTruthy();

    await page.goto('/#/players');
    await waitForCards(page, '.card.player');

    const num = page.locator(`.card.player[data-gsis="${wr.gsis_id}"] .p-num`);
    const pprShown = parseFloat(await num.textContent());
    expect(pprShown).toBeCloseTo(wr.proj_points, 0); // display rounds to 1dp

    await page.locator('.scoreseg button[data-scoring="std"]').click();
    await expect(
      page.locator('.scoreseg button[data-scoring="std"]'),
    ).toHaveClass(/scoreseg--active/);

    const stdShown = parseFloat(await num.textContent());
    expect(stdShown).toBeLessThan(pprShown);
    // EXACT conversion: std = ppr − receptions (to display rounding).
    expect(stdShown).toBeCloseTo(wr.proj_points - recById.get(wr.gsis_id), 0);
  });
});

test.describe('team builder (#/team)', () => {
  test('add QB + same-team WR -> "Stacks with" reason; roster persists', async ({ page }) => {
    // Runtime pair pick: the highest-projected WR whose team also fields a
    // projected QB (the WR is top-5 at his position, so he MUST appear in the
    // WR recommendations, carrying the stack reason once his QB is rostered).
    const proj = readData('player_projections.json');
    const qbByTeam = new Map();
    for (const p of proj.players) {
      if (p.position === 'QB' && !qbByTeam.has(p.team)) qbByTeam.set(p.team, p);
    }
    const wr = proj.players.find(
      (p) => p.position === 'WR' && qbByTeam.has(p.team),
    );
    expect(wr, 'no QB+WR same-team pair in the data').toBeTruthy();
    const qb = qbByTeam.get(wr.team);

    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    // The contract roster: QB,RB,RB,WR,WR,TE,FLEX + 6 bench = 13 slots.
    expect(await page.locator('.roster .slot').count()).toBe(13);

    // Add the QB via the finder — he fills QB1.
    await page.fill('.finder-input', qb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: qb.name }).first()
      .locator('.cand-add').click();
    await expect(page.locator('.slot[data-slot="QB1"] .slot-player'))
      .toContainText(qb.name);

    // Select the WR1 slot (the empty slot's ADD button is the pick control):
    // the reco panel retargets to WR1 and the rostered QB's same-team WR —
    // the top projected WR — must carry the plain-language stack reason.
    await page.locator('.slot[data-slot="WR1"] .slot-empty').click();
    await expect(page.locator('.reco .reco-slot')).toContainText('WR1');
    await expect(
      page.locator('.reco-why', { hasText: 'Stacks with' }).first(),
    ).toBeVisible();

    // Add the same-team WR via the finder.
    await page.fill('.finder-input', wr.name);
    await page.locator('.cand', { hasText: wr.name }).first()
      .locator('.cand-add').click();
    await expect(page.locator('.roster .slot-player')).toHaveCount(2);

    // Persistence: reload -> the roster re-renders from localStorage.
    await page.reload();
    await page.waitForSelector('.roster .slot-player', { timeout: 8000 });
    expect(await page.locator('.roster .slot-player').count()).toBe(2);
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'),
    );
    expect(stored && stored.slots && stored.slots.QB1).toBe(qb.gsis_id);
    expect(Object.values(stored.slots)).toContain(wr.gsis_id);
  });
});

/* ---------------------------------------------------------------------------
 * Build 4 — Fit Engine v2 AI+ toggle (Agent E). Contract: default OFF (= the
 * v1 experience byte-for-byte), ON re-ranks the reco panel via fitScoreV2 and
 * chips AI-ESTIMATED reasons with an inline "AI EST" pill; the choice persists
 * in nfl2026.ai.v1. Expected players are derived from the committed contracts
 * at runtime, never hardcoded.
 * ------------------------------------------------------------------------- */

test.describe('fit engine AI+ toggle (#/team)', () => {
  test('defaults to BASE with no AI chips anywhere', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });

    // ai_insights.json is committed, so the toggle renders — BASE active.
    await expect(page.locator('.aiseg')).toHaveCount(1);
    await expect(page.locator('.aiseg button[data-ai="off"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'false');

    // OFF is the v1 experience: no AI head marker, no provenance chips.
    await expect(page.locator('.reco .reco-slot')).not.toContainText('AI+');
    expect(await page.locator('.prov-ai').count()).toBe(0);
  });

  test('AI+ re-ranks with provenance chips ONLY on AI-estimated reasons; persists', async ({ page }) => {
    // Same runtime pair pick as the stack test: rostering the QB guarantees
    // the same-team top WR carries the stack-synergy reason under AI+ — and
    // stack synergy is ai_estimated BY DEFINITION this build (no measured
    // stack data), so at least one "AI EST" chip must render.
    const proj = readData('player_projections.json');
    const qbByTeam = new Map();
    for (const p of proj.players) {
      if (p.position === 'QB' && !qbByTeam.has(p.team)) qbByTeam.set(p.team, p);
    }
    const wr = proj.players.find(
      (p) => p.position === 'WR' && qbByTeam.has(p.team),
    );
    expect(wr, 'no QB+WR same-team pair in the data').toBeTruthy();
    const qb = qbByTeam.get(wr.team);

    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });

    await page.fill('.finder-input', qb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: qb.name }).first()
      .locator('.cand-add').click();
    await page.locator('.slot[data-slot="WR1"] .slot-empty').click();
    await expect(page.locator('.reco .reco-slot')).toContainText('WR1');

    // Capture the BASE reco panel (no chips, no AI+ marker) before flipping.
    const baseText = await page.locator('.reco').innerText();
    expect(baseText).not.toContain('AI EST');
    expect(await page.locator('.reco .prov-ai').count()).toBe(0);

    // Flip AI+ ON: pills swap, the reco head names the mode, panel re-renders.
    await page.locator('.aiseg button[data-ai="on"]').click();
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.aiseg button[data-ai="off"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.reco .reco-slot')).toContainText('AI+');

    // The reasons/ranking actually changed (fitScoreV2 added its terms).
    const aiText = await page.locator('.reco').innerText();
    expect(aiText).not.toBe(baseText);

    // At least one AI EST chip (the ai_estimated stack-synergy reason), and
    // chips appear ONLY on reason lines that say "(AI estimate" — measured
    // reasons are never chipped; every estimated line IS chipped.
    expect(await page.locator('.reco .prov-ai').count()).toBeGreaterThanOrEqual(1);
    const lines = await page.locator('.reco .reco-why').evaluateAll(
      (nodes) => nodes.map((n) => ({
        text: n.textContent,
        chipped: n.querySelector('.prov-ai') !== null,
      })),
    );
    for (const line of lines) {
      expect(
        line.chipped,
        `chip/provenance mismatch on: ${line.text}`,
      ).toBe(line.text.includes('AI estimate'));
    }

    // Persists: nfl2026.ai.v1 survives a reload and AI+ stays active.
    await page.reload();
    await page.waitForSelector('.aiseg', { timeout: 8000 });
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.reco .reco-slot')).toContainText('AI+');
    const stored = await page.evaluate(() => localStorage.getItem('nfl2026.ai.v1'));
    expect(stored).toBe('on');

    // Flipping back to BASE restores the v1 panel: no marker, no chips.
    await page.locator('.aiseg button[data-ai="off"]').click();
    await expect(page.locator('.reco .reco-slot')).not.toContainText('AI+');
    expect(await page.locator('.reco .prov-ai').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('nfl2026.ai.v1'))).toBe('off');

    // The toggle + chips add no horizontal overflow at 402pt.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
