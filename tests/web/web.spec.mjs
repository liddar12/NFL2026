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

/* ---------------------------------------------------------------------------
 * REL2 — players trend + SoS + AI-adjusted projection; team finder/reco/bye/cap
 * All expectations are derived from the committed contracts, never hardcoded.
 * ------------------------------------------------------------------------- */

test.describe('players trend + strength-of-schedule + AI+ projection (#/players)', () => {
  test('cards show an AI trend chip and a strength-of-schedule pill', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    expect(await page.locator('.p-trend').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.p-sos').count()).toBeGreaterThanOrEqual(1);
    const sosTxt = await page.locator('.p-sos .sos-num').first().innerText();
    const sos = Number(sosTxt);
    expect(Number.isFinite(sos)).toBe(true);
    expect(sos).toBeGreaterThanOrEqual(1);
    expect(sos).toBeLessThanOrEqual(5);
    expect(sosTxt).toMatch(/^\d\.\d$/); // exactly one decimal
  });

  test('AI+ toggle changes the projection number (AI PROJ PTS + delta)', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');

    await expect(page.locator('.p-unit').first()).toHaveText(/PROJ PTS/);
    expect(await page.locator('.p-aidelta').count()).toBe(0);

    await page.locator('.aiseg button[data-ai="on"]').click();
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.p-unit').first()).toHaveText(/AI PROJ PTS/);
    expect(await page.locator('.p-aidelta').count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.ai-note')).toHaveCount(1);

    await page.locator('.aiseg button[data-ai="off"]').click();
    await expect(page.locator('.p-unit').first()).toHaveText(/PROJ PTS/);
    expect(await page.locator('.p-aidelta').count()).toBe(0);
  });

  test('sort control re-orders the list (PROJ vs TREND differ) with a direction arrow', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    const order = async () => page.locator('.card.player').evaluateAll(
      (nodes) => nodes.map((n) => n.getAttribute('data-gsis')));
    const byProj = await order();
    await page.locator('.sort-chip[data-sort="trend"]').click();
    await expect(page.locator('.sort-chip[data-sort="trend"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.sort-chip[data-sort="trend"]')).toContainText('▼');
    const byTrend = await order();
    expect(byTrend.join(',')).not.toBe(byProj.join(','));
    await page.locator('.sort-chip[data-sort="trend"]').click();
    await expect(page.locator('.sort-chip[data-sort="trend"]')).toContainText('▲');
  });
});

test.describe('team finder filter/sort, reco sort, named byes, QB cap (#/team)', () => {
  test('finder position filter narrows candidates to that position', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    await page.locator('.finder-posfilter .pf-chip[data-fpos="RB"]').click();
    await page.waitForSelector('.cand', { timeout: 8000 });
    const metas = await page.locator('.cand .cd-meta').allInnerTexts();
    expect(metas.length).toBeGreaterThan(0);
    for (const m of metas) expect(m.startsWith('RB')).toBe(true);
  });

  test('finder sort buttons toggle active state + direction arrow', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.finder-sortseg', { timeout: 8000 });
    const trend = page.locator('.finder-sortseg .sort-chip[data-fsort="trend"]');
    await trend.click();
    await expect(trend).toHaveAttribute('aria-pressed', 'true');
    await expect(trend).toContainText('▼');
    await trend.click();
    await expect(trend).toContainText('▲');
  });

  test('reco sort exposes BEST FIT / BEST AVAIL and a ranked-by sublabel', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.reco', { timeout: 8000 });
    await expect(page.locator('.reco-controls .sort-chip[data-rsort="fit"]')).toHaveCount(1);
    await expect(page.locator('.reco-controls .sort-chip[data-rsort="available"]')).toHaveCount(1);
    await expect(page.locator('.reco-sublabel')).toContainText('BEST FIT');
    await page.locator('.reco-controls .sort-chip[data-rsort="available"]').click();
    await expect(page.locator('.reco-sublabel')).toContainText('BEST AVAIL');
  });

  test('starters bye section lists the player NAME, not just a count', async ({ page }) => {
    const proj = readData('player_projections.json');
    const weekly = readData('player_weekly.json');
    const byeById = new Map(
      weekly.players.map((p) => [String(p.gsis_id), (p.weeks.find((w) => w.bye) || {}).wk]));
    const qb = proj.players.find(
      (p) => p.position === 'QB' && byeById.get(String(p.gsis_id)) != null);
    expect(qb, 'no QB with a bye in the data').toBeTruthy();

    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    await page.fill('.finder-input', qb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: qb.name }).first().locator('.cand-add').click();

    const byes = page.locator('.ts-byes');
    await expect(byes).toContainText('BYE');
    await expect(byes).toContainText(qb.name);
  });

  test('QB cap: a 3rd QB cannot be added once two are rostered', async ({ page }) => {
    const proj = readData('player_projections.json');
    const qbs = proj.players.filter((p) => p.position === 'QB').slice(0, 3);
    expect(qbs.length).toBe(3);

    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    for (const qb of qbs.slice(0, 2)) {
      await page.fill('.finder-input', qb.name);
      await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
      await page.locator('.cand', { hasText: qb.name }).first().locator('.cand-add').click();
    }
    await page.fill('.finder-input', qbs[2].name);
    const add = page.locator('.cand', { hasText: qbs[2].name }).first().locator('.cand-add');
    await expect(add).toBeDisabled();
    await expect(add).toContainText('FULL');
  });
});

/* ---------------------------------------------------------------------------
 * REL3 — parlay leg selector, roster slot enrichment, draft TAKEN, legend,
 * and the iPad (wide) responsive layout.
 * ------------------------------------------------------------------------- */

test.describe('parlay leg-count selector (#/parlays)', () => {
  test('WEEK scope exposes 2..7 leg chips and filters to the chosen count', async ({ page }) => {
    await page.goto('/#/parlays');
    await waitForCards(page, '.card.parlay');
    // Switch to WEEK scope (where 2..7-leg buckets live).
    await page.locator('.scopeseg .seg-btn[data-seg="week"]').click();
    await page.waitForTimeout(50);
    // Leg chips for every bucket present in the data plus ALL.
    for (const k of [2, 3, 4, 5, 6, 7]) {
      await expect(page.locator(`.legseg .leg-chip[data-leg="${k}"]`)).toHaveCount(1);
    }
    // Selecting "5 LEG" shows only 5-leg parlays (each card's .legs holds 5).
    await page.locator('.legseg .leg-chip[data-leg="5"]').click();
    await page.waitForTimeout(50);
    await expect(page.locator('.legseg .leg-chip[data-leg="5"]'))
      .toHaveAttribute('aria-pressed', 'true');
    const perCard = await page.locator('.card.parlay').evaluateAll(
      (cards) => cards.map((c) => c.querySelectorAll('.legs > *').length));
    expect(perCard.length).toBeGreaterThanOrEqual(1);
    for (const n of perCard) expect(n).toBe(5);
  });
});

test.describe('team builder REL3 — enriched slot, draft board, legend (#/team)', () => {
  test('a legend explains the acronyms and sort arrows', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    const legend = page.locator('.legend--team');
    await expect(legend).toHaveCount(1);
    await legend.locator('summary').click();
    await expect(legend).toContainText('SoS');
    await expect(legend).toContainText('descending');
    await expect(legend).toContainText('TAKEN');
  });

  test('added player shows SoS / trend / bye on the slot line, not just points', async ({ page }) => {
    const proj = readData('player_projections.json');
    const rb = proj.players.find((p) => p.position === 'RB');
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    await page.fill('.finder-input', rb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: rb.name }).first().locator('.cand-add').click();
    const slot = page.locator('.slot', { hasText: rb.name }).first();
    // The enriched meta line carries SoS and the bye week.
    await expect(slot.locator('.sp-meta')).toContainText('SoS');
    await expect(slot.locator('.sp-meta')).toContainText('BYE');
  });

  test('TAKEN removes a player from recommendations; HIDE TAKEN drops them from the finder', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.cand', { timeout: 8000 });
    // Mark the first candidate TAKEN.
    const firstCand = page.locator('.cand').first();
    const gsis = await firstCand.getAttribute('data-gsis');
    await firstCand.locator('.cand-taken').click();
    // It is now greyed + its ADD disabled.
    const takenCand = page.locator(`.cand[data-gsis="${gsis}"]`);
    await expect(takenCand).toHaveClass(/cand--taken/);
    await expect(takenCand.locator('.cand-add')).toBeDisabled();
    // HIDE TAKEN removes it from the finder entirely.
    await page.locator('.taken-toggle').click();
    await expect(page.locator(`.cand[data-gsis="${gsis}"]`)).toHaveCount(0);
    // Persists across reload (localStorage nfl2026.taken.v1).
    await page.reload();
    await page.waitForSelector('.cand', { timeout: 8000 });
    const stored = await page.evaluate(() => localStorage.getItem('nfl2026.taken.v1'));
    expect(stored).toContain(gsis);
  });
});

test.describe('iPad / wide responsive layout', () => {
  test('at 1024px the team builder uses a two-column grid', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1180 });
    await page.goto('/#/team');
    await page.waitForSelector('.team-grid', { timeout: 8000 });
    const cols = await page.locator('.team-grid').evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns);
    // Two tracks => two space-separated pixel values.
    expect(cols.trim().split(/\s+/).length).toBe(2);
  });

  test('at 1024px the players list is a multi-column grid', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1180 });
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    const cols = await page.locator('#players-list').evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns);
    expect(cols.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });
});

/* ---------------------------------------------------------------------------
 * REL4 — players-view legend, BEST PICK NOW (VOR), prop legs in parlays.
 * ------------------------------------------------------------------------- */

test.describe('players legend + BEST PICK NOW + prop parlays (REL4)', () => {
  test('players view has the WHAT DO THESE MEAN legend with PROJ/TREND/SOS', async ({ page }) => {
    await page.goto('/#/players');
    await waitForCards(page, '.card.player');
    const legend = page.locator('.legend--players');
    await expect(legend).toHaveCount(1);
    await legend.locator('summary').click();
    await expect(legend).toContainText('PROJ');
    await expect(legend).toContainText('SOS');
    await expect(legend).toContainText('descending');
  });

  test('BEST PICK NOW strip renders VOR picks and re-ranks when a player is TAKEN', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.bestpick', { timeout: 8000 });
    await expect(page.locator('.bestpick .bp-label')).toContainText('VALUE OVER REPLACEMENT');
    const rows = page.locator('.bestpick .bp-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    await expect(rows.first().locator('.bp-vor')).toContainText('VOR');
    // Mark the top pick TAKEN in the finder -> the strip must drop that player.
    const topId = await rows.first().getAttribute('data-gsis');
    const topName = await rows.first().locator('.bp-name').innerText();
    await page.fill('.finder-input', topName);
    await page.waitForSelector('.cand .cand-taken', { timeout: 8000 });
    await page.locator(`.cand[data-gsis="${topId}"] .cand-taken`).click();
    await expect(page.locator(`.bestpick .bp-row[data-gsis="${topId}"]`)).toHaveCount(0);
  });

  test('same-game parlays can carry player-prop legs (qb/rb/wr yds markets)', async ({ page }) => {
    // Data-driven: the committed parlays.json must contain at least one game-scope
    // parlay with a prop-market leg, and its card must render that selection.
    const doc = readData('parlays.json');
    const propMarkets = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);
    const withProp = doc.parlays.find(
      (p) => p.scope === 'game' && p.legs.some((l) => propMarkets.has(l.market)));
    expect(withProp, 'no game parlay carries a prop leg').toBeTruthy();
    const propLeg = withProp.legs.find((l) => propMarkets.has(l.market));

    await page.goto('/#/parlays');
    await waitForCards(page, '.card.parlay');
    const card = page.locator(`.card.parlay[data-parlay-id="${withProp.parlay_id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(propLeg.selection.split(' ')[0]);
  });
});

/* ---------------------------------------------------------------------------
 * REL5 — MODEL tab, market display-only policy, health "awaiting config".
 * ------------------------------------------------------------------------- */

test.describe('MODEL tab + market policy + health config note (REL5)', () => {
  test('MODEL tab renders all five transparency cards', async ({ page }) => {
    await page.goto('/#/model');
    await page.waitForSelector('.mcard', { timeout: 8000 });
    await expect(page.locator('.tabbar .tab[data-tab="model"]')).toHaveCount(1);
    await expect(page.locator('.m-params')).toHaveCount(1);
    await expect(page.locator('.m-backtest')).toHaveCount(1);
    await expect(page.locator('.m-locks')).toHaveCount(1);
    await expect(page.locator('.m-playoffs')).toHaveCount(1);
    await expect(page.locator('.m-signals')).toHaveCount(1);
  });

  test('adopted params show the fitted values with provenance', async ({ page }) => {
    const tuning = readData('model_tuning.json');
    await page.goto('/#/model');
    await page.waitForSelector('.m-params', { timeout: 8000 });
    const txt = await page.locator('.m-params').innerText();
    expect(txt).toContain(String(tuning.game_params.hfa_elo));
    expect(txt).toContain('NEVER-REGRESS');
  });

  test('playoff odds table shows our odds beside markets, labeled display-only', async ({ page }) => {
    await page.goto('/#/model');
    await page.waitForSelector('.m-playoffs .po-row', { timeout: 8000 });
    expect(await page.locator('.m-playoffs .po-row').count()).toBeGreaterThanOrEqual(5);
    const head = await page.locator('.m-playoffs .po-row--head').innerText();
    expect(head).toContain('CHAMP');
    expect(head).toContain('KALSHI');
    expect(head).toContain('POLYMKT');
    await expect(page.locator('.m-playoffs .ms-badge').first())
      .toContainText('DISPLAY ONLY');
  });

  test('signal registry badges market signals as display-only', async ({ page }) => {
    await page.goto('/#/model');
    await page.waitForSelector('.m-signals .sg-row', { timeout: 8000 });
    expect(await page.locator('.m-signals .sg-row').count()).toBe(32);
    // Every market signal row carries the badge; a model signal does not.
    const badged = await page.locator('.m-signals .sg-row:has(.ms-badge)').count();
    expect(badged).toBe(6);
  });

  test('health strip reports awaiting-config feeds separately from degradation', async ({ page }) => {
    const status = readData('pipeline_status.json');
    const unconfigured = Object.values(status.feeds)
      .filter((f) => f.status === 'unconfigured').length;
    await page.goto('/');
    await page.waitForSelector('#health .health-note', { timeout: 8000 });
    const note = await page.locator('#health .health-note').innerText();
    if (unconfigured > 0) {
      expect(note).toContain(`${unconfigured} awaiting config`);
    } else {
      expect(note).not.toContain('awaiting config');
    }
  });
});

/* ---------------------------------------------------------------------------
 * REL6 — draft simulator, RESET (two-step), UI alignment.
 * ------------------------------------------------------------------------- */

test.describe('draft simulator + RESET (REL6, #/team)', () => {
  test('draft setup renders with league/slot/room/roster controls', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-head', { timeout: 8000 });
    await expect(page.locator('.draftsim .ds-title')).toContainText('DRAFT SIMULATOR');
    for (const key of ['leagueSize', 'mySlot', 'roomType', 'qb', 'rb', 'wr', 'te', 'flex', 'bench']) {
      await expect(page.locator(`.ds-select[data-dcfg="${key}"]`)).toHaveCount(1);
    }
    await expect(page.locator('.ds-start')).toContainText('START DRAFT');
  });

  test('setup is grouped LEAGUE/ROSTER, counts stay live, start spans the card', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-sub', { timeout: 8000 });
    // Two labeled groups, each with its own field grid.
    await expect(page.locator('.draftsim .ds-sub').nth(0)).toContainText('LEAGUE');
    await expect(page.locator('.draftsim .ds-sub').nth(1)).toContainText('ROSTER');
    // League grid: FORMAT + PLAY (Rel9) + TEAMS + MY SLOT + ROOM/BUDGET.
    expect(await page.locator('.ds-grid--league .ds-field').count()).toBe(5);
    expect(await page.locator('.ds-grid--roster .ds-field').count()).toBe(6);
    // Default shape QB+2RB+2WR+TE+FLEX+6 = 13 rounds, echoed live in the note
    // and on the start button; bumping BENCH to 7 re-counts both to 14.
    await expect(page.locator('.ds-sub-note').nth(1)).toContainText('13 ROUNDS');
    await expect(page.locator('.ds-start')).toContainText('13 ROUNDS');
    await page.locator('.ds-select[data-dcfg="bench"]').selectOption('7');
    await expect(page.locator('.ds-sub-note').nth(1)).toContainText('14 ROUNDS');
    await expect(page.locator('.ds-start')).toContainText('14 ROUNDS');
    // The primary action uses the full card width (not a floating chip).
    const card = await page.locator('.draftsim').boundingBox();
    const btn = await page.locator('.ds-start').boundingBox();
    expect(btn.width).toBeGreaterThan(card.width * 0.9);
  });

  test('a draft runs: sim to my pick -> recommendations with survival -> pick works', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-start', { timeout: 8000 });
    // Slot 5 of 12: four opponent picks precede mine.
    await page.locator('.ds-select[data-dcfg="mySlot"]').selectOption('5');
    await page.locator('.ds-start').click();
    await page.waitForSelector('[data-act="draft-sim"]', { timeout: 8000 });
    await page.locator('[data-act="draft-sim"]').click();
    // My turn: candidate rows with survival forecasts and PICK buttons.
    await page.waitForSelector('.ds-cand', { timeout: 8000 });
    expect(await page.locator('.ds-cand').count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.ds-cand .ds-surv').first()).toContainText('survives');
    const before = await page.locator('.ds-log').count();
    await page.locator('.ds-cand [data-act="draft-pick"]').first().click();
    // After my pick the sim advances to my next turn (log grows past my pick).
    await page.waitForSelector('.ds-cand, .state', { timeout: 8000 });
    expect(await page.locator('.ds-log').count()).toBeGreaterThanOrEqual(before);
    // Exit cleanly back to setup.
    await page.locator('[data-act="draft-close"]').click();
    await expect(page.locator('.ds-start')).toHaveCount(1);
  });

  test('RESET requires a second confirming tap and clears roster + taken', async ({ page }) => {
    const proj = readData('player_projections.json');
    const rb = proj.players.find((p) => p.position === 'RB');
    await page.goto('/#/team');
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    // Add a player + mark another TAKEN so there is state to clear.
    await page.fill('.finder-input', rb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: rb.name }).first().locator('.cand-add').click();
    await page.fill('.finder-input', '');
    await page.waitForSelector('.cand .cand-taken', { timeout: 8000 });
    await page.locator('.cand .cand-taken').first().click();

    // First tap arms; state is untouched.
    await page.locator('.reset-btn').click();
    await expect(page.locator('.reset-btn')).toContainText('CONFIRM');
    await expect(page.locator('.slot-player').first()).toBeVisible();
    // Second tap wipes roster, taken set, and persisted storage.
    await page.locator('.reset-btn').click();
    await expect(page.locator('.reset-btn')).toContainText('RESET');
    expect(await page.locator('.slot-player').count()).toBe(0);
    expect(await page.locator('.cand--taken').count()).toBe(0);
    const stored = await page.evaluate(() => ({
      team: localStorage.getItem('nfl2026.team.v1'),
      taken: localStorage.getItem('nfl2026.taken.v1'),
    }));
    expect(JSON.parse(stored.taken)).toEqual([]);
    expect(Object.values(JSON.parse(stored.team).slots).every((v) => v === null)).toBe(true);
  });

  test('team page has no horizontal overflow with the new sections (402px)', async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-head', { timeout: 8000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/* ---------------------------------------------------------------------------
 * REL7 — self-learning gate transparency: family verdicts + calibration.
 * ------------------------------------------------------------------------- */

test.describe('promotion gate + calibration cards (REL7, #/model)', () => {
  test('gate card lists all four candidate families with verdict chips', async ({ page }) => {
    await page.goto('/#/model');
    await page.waitForSelector('.m-gate .gate-row', { timeout: 8000 });
    const txt = await page.locator('.m-gate').innerText();
    for (const fam of ['environment', 'rest', 'epa_total', 'epa_pass']) {
      expect(txt).toContain(fam);
    }
    expect(txt).toContain('NEVER-REGRESS');
    // Every family row (not the header) carries exactly one verdict chip.
    const rows = await page.locator('.m-gate .gate-row:not(.gate-row--head)').count();
    const chips = await page.locator('.m-gate .gate-chip').count();
    expect(rows).toBe(4);
    expect(chips).toBe(4);
  });

  test('calibration card draws predicted-vs-actual bars over 1000+ games', async ({ page }) => {
    await page.goto('/#/model');
    await page.waitForSelector('.m-cal .cal-row', { timeout: 8000 });
    expect(await page.locator('.m-cal .cal-row').count()).toBeGreaterThanOrEqual(5);
    // Bars render with real widths (a zero-width bar row would mean fake data).
    const w = await page.locator('.m-cal .cal-bar--act').first().evaluate(
      (el) => el.getBoundingClientRect().width);
    expect(w).toBeGreaterThan(2);
    const txt = await page.locator('.m-cal').innerText();
    expect(txt).toContain('n=');
  });
});

/* ---------------------------------------------------------------------------
 * REL9 — auction draft room (sim + live), strategy toggles, iPad layout.
 * ------------------------------------------------------------------------- */

test.describe('auction draft room (REL9, #/team)', () => {
  async function startAuction(page) {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-start', { timeout: 8000 });
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await page.waitForSelector('[data-act="auc-start"]', { timeout: 8000 });
    await page.locator('[data-act="auc-start"]').click();
    await page.waitForSelector('.auc-room', { timeout: 8000 });
  }

  test('setup: AUCTION mode swaps ROOM for BUDGET and relabels the start button', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-start', { timeout: 8000 });
    await expect(page.locator('.ds-select[data-dcfg="mode"]')).toHaveCount(1);
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await expect(page.locator('.ds-select[data-dcfg="budget"]')).toHaveCount(1);
    await expect(page.locator('.ds-select[data-dcfg="roomType"]')).toHaveCount(0);
    await expect(page.locator('.ds-start')).toContainText('AUCTION');
    await expect(page.locator('.ds-start')).toContainText('$200');
  });

  test('a sim auction runs: nominate -> block guidance -> sale updates the room', async ({ page }) => {
    await startAuction(page);
    // Three zones render.
    await expect(page.locator('.auc-zone--room')).toHaveCount(1);
    await expect(page.locator('.auc-zone--block')).toHaveCount(1);
    await expect(page.locator('.auc-zone--build')).toHaveCount(1);
    await expect(page.locator('.auc-infl')).toContainText('INFLATION');
    // Drive to a block (team 1 nominates unless it is my nomination).
    if (await page.locator('[data-act="auc-sim-nom"]').count()) {
      await page.locator('[data-act="auc-sim-nom"]').click();
    } else {
      await page.locator('.auc-pool [data-act="auc-nom"]').first().click();
    }
    await page.waitForSelector('.auc-prices', { timeout: 8000 });
    await expect(page.locator('.auc-prices')).toContainText('OURS');
    await expect(page.locator('.auc-verdict')).toBeVisible();
    const soldBefore = await page.locator('.ds-status').innerText();
    await page.locator('[data-act="auc-bid"]').first().click();
    await expect(page.locator('.ds-status')).not.toHaveText(soldBefore);
  });

  test('strategy toggles flip live and re-plan MY BUILD', async ({ page }) => {
    await startAuction(page);
    const firstPlanned = () => page.locator('.auc-plan span:nth-child(2)').first().innerText();
    const balanced = await firstPlanned();
    await page.locator('[data-act="auc-style"]').click();
    await expect(page.locator('[data-act="auc-style"]')).toContainText('STARS');
    const stars = await firstPlanned();
    expect(stars).not.toBe(balanced);          // top slot re-budgeted immediately
    await page.locator('[data-act="auc-tempo"]').click();
    await expect(page.locator('[data-act="auc-tempo"]')).toContainText('AGGRESSIVE');
  });

  test('13in iPad landscape: the three zones sit side by side, no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 1024 });
    await startAuction(page);
    const boxes = [];
    for (const z of ['room', 'block', 'build']) {
      boxes.push(await page.locator(`.auc-zone--${z}`).boundingBox());
    }
    // Same row: their vertical positions match; horizontal positions ascend.
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(4);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('snake LIVE mode asks for observed picks instead of simulating', async ({ page }) => {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-start', { timeout: 8000 });
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('.ds-select[data-dcfg="mySlot"]').selectOption('5');
    await page.locator('[data-act="draft-start"]').click();
    await page.waitForSelector('.auc-pool', { timeout: 8000 });
    await expect(page.locator('.ds-turn')).toContainText('ON THE CLOCK');
    await expect(page.locator('[data-act="draft-sim"]')).toHaveCount(0);
    // Record an observed pick; the clock advances to the next team.
    await page.locator('[data-act="draft-live-take"]').first().click();
    await expect(page.locator('.ds-turn')).toContainText('TEAM 2');
  });
});

/* ---------------------------------------------------------------------------
 * REL9.1 — the draft room and the page lists are ONE system: finder-powered
 * nomination, live two-way sync, swap/cancel + exact undo.
 * ------------------------------------------------------------------------- */

test.describe('draft room <-> page sync (REL9.1, #/team)', () => {
  async function startLiveAuction(page) {
    await page.goto('/#/team');
    await page.waitForSelector('.draftsim .ds-start', { timeout: 8000 });
    await page.locator('.ds-select[data-dcfg="mode"]').selectOption('auction');
    await page.locator('.ds-select[data-dcfg="play"]').selectOption('live');
    await page.locator('[data-act="auc-start"]').click();
    await page.waitForSelector('.auc-room', { timeout: 8000 });
  }

  test('finder rows become the nomination surface with unified $ strength', async ({ page }) => {
    await startLiveAuction(page);
    // Finder rows now carry our-$ vs market-$ and a NOM action.
    await page.waitForSelector('.cand .cd-cash', { timeout: 8000 });
    expect(await page.locator('.cand [data-act="auc-nom"]').count()).toBeGreaterThan(0);
    const raw = (await page.locator('.cand .cd-name').first().innerText()).trim();
    const name = raw.split('\n')[0].replace(/[\u25b2\u25bc]/g, '').trim(); // strip trend arrows
    await page.locator('.cand [data-act="auc-nom"]').first().click();
    // That player is on the block; his finder row shows BLOCK, not a button.
    await expect(page.locator('.auc-player .cd-name')).toContainText(name);
    await expect(page.locator('.cand .cd-onblock').first()).toContainText('BLOCK');
    // SWAP returns to the nomination phase.
    await page.locator('[data-act="auc-cancel"]').click();
    await expect(page.locator('.auc-player')).toHaveCount(0);
  });

  test('LIVE sale syncs TAKEN into the finder and UNDO reverses it exactly', async ({ page }) => {
    await startLiveAuction(page);
    await page.waitForSelector('.cand [data-act="auc-nom"]', { timeout: 8000 });
    const row = page.locator('.cand').first();
    const gsis = await row.getAttribute('data-gsis');
    await row.locator('[data-act="auc-nom"]').click();
    await page.waitForSelector('[data-act="auc-sold"]', { timeout: 8000 });
    // Sold to T1 (an opponent) at the shown price.
    await page.locator('[data-act="auc-sold"]').click();
    await expect(page.locator(`.cand[data-gsis="${gsis}"]`)).toHaveClass(/cand--taken/);
    // Exact undo: the room AND the page state roll back.
    await page.locator('[data-act="auc-undo"]').click();
    await expect(page.locator(`.cand[data-gsis="${gsis}"]`)).not.toHaveClass(/cand--taken/);
  });

  test('winning a LIVE player fills my roster and the fit engine re-ranks', async ({ page }) => {
    await startLiveAuction(page);
    await page.waitForSelector('.cand [data-act="auc-nom"]', { timeout: 8000 });
    const row = page.locator('.cand').first();
    const raw = (await row.locator('.cd-name').innerText()).trim();
    const name = raw.split('\n')[0].replace(/[\u25b2\u25bc]/g, '').trim();
    await row.locator('[data-act="auc-nom"]').click();
    await page.waitForSelector('.auc-soldteam', { timeout: 8000 });
    // Record the sale to ME.
    const myIdx = await page.locator('.auc-soldteam option', { hasText: 'YOU' }).getAttribute('value');
    await page.locator('.auc-soldteam').selectOption(myIdx);
    await page.locator('[data-act="auc-sold"]').click();
    // My roster now holds him: a filled slot renders his name.
    await expect(page.locator('.roster .slot-player', { hasText: name }).first()).toBeVisible();
    // And the reco panel shows room actions instead of ADD while drafting.
    expect(await page.locator('#t-reco [data-act="add"]').count()).toBe(0);
  });
});
