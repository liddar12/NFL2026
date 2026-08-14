/* tests/web/r24d_layout.spec.mjs — R24-D layout findings, measured.
 *
 * Three CSS defects that only a real browser can settle, each measured against
 * the broken build first:
 *
 *  1. THE UNSTYLED VIEW HEADER (highest reach in the release). Every view emits
 *     <header class="view-head"><h1 class="view-title">…</h1>
 *     <span class="view-sub">…</span></header> and app/theme.css defined NO rule
 *     for any of those three classes, so the primary title of EVERY screen fell
 *     back to the UA default h1: 32px, weight 700, upright, no tracking — the
 *     one piece of type in the app not wearing the broadcast lockup.
 *  2. THE CLIPPED SIXTH TAB. Six flex tabs kept min-width:auto in a bar that can
 *     neither wrap nor scroll, so at an iPhone SE's 320px the row measured 376px
 *     and MODEL was cut in half.
 *  3. THE BROKEN GRID RHYTHM. .lp-grid (FLEX / KEEPERS / MAX KEEPERS) collapsed
 *     to one column at <=480px while the .ds-grid LEAGUE and ROSTER grids
 *     directly above it stayed 3-across at every width, so a 402px iPhone showed
 *     three full-width tiles stacked under two 3-up grids — the opposite of what
 *     that block's own comment claimed.
 *
 * The 402pt reference device must be untouched by (2): the tab widths asserted
 * below are the pre-fix widths.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const ROUTES = [
  ['#/', 'WEEK'],
  ['#/players', 'PLAYER PROJECTIONS'],
  ['#/parlays', 'PARLAYS'],
  ['#/team', 'TEAM BUILDER'],
  ['#/lineup', 'WEEKLY LINEUP'],
];

/* ==========================================================================
   1. THE VIEW HEADER WEARS THE BROADCAST LOCKUP
   ========================================================================== */

for (const [route, text] of ROUTES) {
  test(`the view header is in the type system on ${route}`, async ({ page }) => {
    await page.goto(`/${route}`);
    const title = page.locator('.view-title').first();
    await expect(title).toBeVisible({ timeout: 15000 });
    await expect(title).toContainText(text);

    const t = await title.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        family: cs.fontFamily,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight),
        style: cs.fontStyle,
        transform: cs.textTransform,
        tracking: parseFloat(cs.letterSpacing),
      };
    });
    // The .wordmark / .p-name idiom: sans, 800, italic, uppercase, tight.
    expect(t.family).toMatch(/-apple-system|system-ui|sans-serif/);
    expect(t.weight).toBe(800);
    expect(t.style).toBe('italic');
    expect(t.transform).toBe('uppercase');
    expect(t.tracking).toBeLessThan(0);
    // Not the UA default h1 (32px / 700 / normal / none / normal tracking).
    expect(t.size).toBe(26);

    const sub = page.locator('.view-sub').first();
    if (await sub.count()) {
      const s = await sub.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          family: cs.fontFamily, size: parseFloat(cs.fontSize),
          transform: cs.textTransform, tracking: parseFloat(cs.letterSpacing),
        };
      });
      expect(s.family).toMatch(/mono|Menlo|SF Mono/i);
      expect(s.size).toBe(11);
      expect(s.transform).toBe('uppercase');
      expect(s.tracking).toBeGreaterThan(0);
    }
  });
}

test('the title sits above its eyebrow, and the header never overflows', async ({ page }) => {
  await page.goto('/#/lineup');
  await expect(page.locator('.view-title').first()).toBeVisible({ timeout: 15000 });
  const geom = await page.evaluate(() => {
    const t = document.querySelector('.view-title').getBoundingClientRect();
    const s = document.querySelector('.view-sub').getBoundingClientRect();
    return {
      stacked: s.top >= t.bottom - 1,
      widest: Math.max(t.right, s.right),
      docScroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  });
  expect(geom.stacked).toBe(true);
  expect(geom.widest).toBeLessThanOrEqual(geom.viewport);
  expect(geom.docScroll).toBe(geom.viewport);
});

/* ==========================================================================
   2. ALL SIX TABS FIT, DOWN TO 320px
   ========================================================================== */

for (const width of [320, 375, 402]) {
  test(`every tab is fully on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#/');
    await expect(page.locator('.tabbar')).toBeVisible({ timeout: 15000 });

    const bar = await page.evaluate(() => {
      const el = document.querySelector('.tabbar');
      const r = el.getBoundingClientRect();
      return {
        width: r.width,
        scrollWidth: el.scrollWidth,
        tabs: [...el.querySelectorAll('.tab')].map((t) => {
          const tr = t.getBoundingClientRect();
          return {
            label: t.textContent.trim(),
            left: tr.left, right: tr.right, height: Math.round(tr.height),
            // scrollWidth > clientWidth means the LABEL itself is spilling out
            // of its own tab, i.e. it would overlap its neighbour.
            spills: t.scrollWidth > t.clientWidth,
          };
        }),
      };
    });

    expect(bar.tabs.length).toBe(6);
    // Before the fix: 376px of content in a 320px bar.
    expect(bar.scrollWidth).toBeLessThanOrEqual(Math.ceil(bar.width));
    for (const t of bar.tabs) {
      expect(t.left, `${t.label} starts off-screen`).toBeGreaterThanOrEqual(-0.5);
      expect(t.right, `${t.label} is clipped at ${width}px`).toBeLessThanOrEqual(bar.width + 0.5);
      expect(t.spills, `${t.label} overflows its own tab`).toBe(false);
      // The narrow-width shrink must not cost tap target: 36px at every width.
      expect(t.height, `${t.label} lost hit height`).toBe(36);
    }
  });
}

test('the narrow-width tab fix is scoped to <=400px and leaves 402pt alone', async ({ page }) => {
  // WHAT THIS LOCKS: the R24-D fix is a `@media (max-width: 400px)` block that
  // shrinks the tab's font-size, letter-spacing and padding and drops
  // min-width. The claim worth testing is that it does NOT reach the 402pt
  // reference device.
  //
  // It deliberately does NOT assert rendered pixel widths. The first cut of
  // this test pinned [63, 74, 74, 63, 63, 63] and went red on CI at
  // [64, 74, 74, 64, 64, 64] — a one-pixel sub-pixel rounding difference
  // between two Chromium builds, not a layout change. Comparing computed
  // styles ACROSS WIDTHS IN THE SAME BROWSER measures the actual claim and
  // cannot drift on device rounding.
  const props = () => page.evaluate(() => {
    const t = document.querySelector('.tabbar .tab');
    const c = getComputedStyle(t);
    return {
      fontSize: c.fontSize,
      letterSpacing: c.letterSpacing,
      padding: c.padding,
      minWidth: c.minWidth,
    };
  });

  await page.goto('/#/');
  await expect(page.locator('.tabbar')).toBeVisible({ timeout: 15000 });

  await page.setViewportSize({ width: 402, height: 874 });
  const at402 = await props();
  await page.setViewportSize({ width: 600, height: 874 });
  const at600 = await props();
  await page.setViewportSize({ width: 320, height: 700 });
  const at320 = await props();

  // 402pt sits on the wide side of the breakpoint: identical to a comfortably
  // wide viewport, so the reference device is untouched by the fix.
  expect(at402).toEqual(at600);
  // ...and the fix genuinely engages below it, or this would be locking nothing.
  expect(at320).not.toEqual(at402);
  expect(at320.fontSize).toBe('10px');
});

/* ==========================================================================
   3. THE SETTINGS GRIDS KEEP ONE RHYTHM
   ========================================================================== */

test('.lp-grid stays 3-up on the phone, exactly like the .ds-grid above it', async ({ page }) => {
  await page.goto('/#/team');
  await page.waitForSelector('.lp-grid .lp-field', { timeout: 20000 });

  const geom = await page.evaluate(() => {
    const cols = (sel) => {
      const tops = [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().top));
      const firstRow = tops.filter((t) => t === tops[0]).length;
      return { count: tops.length, perRow: firstRow };
    };
    const lp = [...document.querySelectorAll('.lp-grid .lp-field')]
      .map((e) => Math.round(e.getBoundingClientRect().width));
    const ds = [...document.querySelectorAll('.ds-grid .ds-field')]
      .map((e) => Math.round(e.getBoundingClientRect().width));
    return {
      lp: cols('.lp-grid .lp-field'),
      lpWidths: lp,
      dsWidths: ds,
      docScroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  });

  // Three controls, all three on ONE row (they were three stacked rows).
  expect(geom.lp.count).toBe(3);
  expect(geom.lp.perRow).toBe(3);
  // And the tile width matches the LEAGUE/ROSTER tiles directly above.
  expect(new Set(geom.lpWidths).size).toBe(1);
  expect(geom.lpWidths[0]).toBe(geom.dsWidths[0]);
  // Nothing spilled sideways to buy that.
  expect(geom.docScroll).toBe(geom.viewport);
});

/* ==========================================================================
   4. THE .lu-tag COMMENT NOW MATCHES THE MEASUREMENT

   theme.css claimed "the badges reuse .lu-bye's geometry so a row with one does
   not change height". That is true on iPad and false on a phone. The comment
   was corrected in R24-D; this locks the numbers it now states, so the next
   person to touch .lu-tag or .lu-name finds out when the claim goes stale
   again.
   ========================================================================== */

const KDEF_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

/** A K/DEF roster: seven ordinary starters plus a badged K and DEF. */
function kdefSeed() {
  const kdst = readData('kdst_projections.json');
  const ps = readData('player_projections.json').players;
  const pick = (pos, n) => ps.filter((p) => String(p.position).toUpperCase() === pos)
    .slice(0, n).map((p) => String(p.gsis_id));
  const [qb] = pick('QB', 1);
  const rb = pick('RB', 3);
  const wr = pick('WR', 2);
  const [te] = pick('TE', 1);
  return {
    profile: { version: 1, name: 'K/DEF League', shape: { teams: 12, roster_positions: [...KDEF_ROSTER] } },
    slots: {
      QB1: qb, RB1: rb[0], RB2: rb[1], WR1: wr[0], WR2: wr[1], TE1: te, FLEX: rb[2],
      K1: kdst.kickers[0].player_id, DEF1: kdst.defenses[0].player_id,
    },
  };
}

for (const [label, width, badgedHeight] of [['iPhone', 402, 60], ['iPad', 1024, 42]]) {
  test(`a badged K/DEF lineup row measures ${badgedHeight}px on ${label}`, async ({ page }) => {
    const { profile, slots } = kdefSeed();
    await page.addInitScript((s) => {
      localStorage.setItem('nfl2026.league.v1', s.profile);
      localStorage.setItem('nfl2026.team.v1', s.slots);
    }, { profile: JSON.stringify(profile), slots: JSON.stringify({ slots }) });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/lineup');
    await page.waitForSelector('.lu-card .lu-row', { timeout: 20000 });

    const rows = await page.evaluate(() => [...document.querySelectorAll('.lu-row')].map((r) => ({
      slot: (r.querySelector('.lu-slot') || {}).textContent || '',
      height: Math.round(r.getBoundingClientRect().height),
      badged: !!r.querySelector('.lu-tag'),
      nameWidth: Math.round((r.querySelector('.lu-name') || r).getBoundingClientRect().width),
    })));

    const badged = rows.filter((r) => r.badged);
    const plain = rows.filter((r) => !r.badged);
    expect(badged.length).toBe(2);                       // K and DEF, nothing else
    expect(badged.every((r) => /^(K|DEF)$/.test(r.slot.trim()))).toBe(true);
    for (const r of plain) expect(r.height).toBe(42);
    for (const r of badged) expect(r.height).toBe(badgedHeight);
    if (width === 402) expect(badged[0].nameWidth).toBe(240);
  });
}
