/* tests/pwa/standalone.spec.mjs — project `pwa` (Agent D).
 *
 * Proves the INSTALLED (standalone) PWA experience, independently of the plain
 * web spec. Each test runs in a REAL app-mode window so the app boots believing
 * it is an installed app on the iPhone 16 Pro home screen. Assertions (contract):
 *   1. matchMedia('(display-mode: standalone)') === true.
 *   2. <meta name=theme-color> === #0D1117; manifest resolves to valid JSON with
 *      display "standalone" and a dark theme_color.
 *   3. Safe-area respected: under 59px top / 34px bottom insets the topbar clears
 *      the Dynamic Island, the tabbar clears the home indicator, and nothing
 *      overlaps the top inset band.
 *   4. Dark-only: color-scheme is dark, body ~= #0D1117, no [data-theme] toggle.
 *   5. Content renders from data (slate / players / parlays).
 *   6. Service worker registers (the pure cache-purger).
 *
 * HOW STANDALONE IS EMULATED — invariant, read before editing:
 * CDP `Emulation.setEmulatedMedia({features:[{name:'display-mode',...}]})` is NOT
 * honored by `matchMedia` in headless Chromium (color-scheme is, display-mode is
 * silently ignored), so we cannot fake it that way. Instead we run in a GENUINE
 * app-mode window via Chromium's `--app=<url>` flag — that window really IS
 * `display-mode: standalone` and stays standalone across goto / reload / hash nav.
 * The Playwright test-runner worker neutralizes `--app` when IT launches the
 * browser (the startup window comes up as about:blank), so we launch Chromium as
 * our OWN child process and attach over CDP (connectOverCDP). Hard-won details:
 *   - A CDP-attached context has NO baseURL, so navigations MUST be absolute
 *     (use `url(path)` below), not relative "/".
 *   - iPhone metrics are applied with `setViewportSize` after attach (passing a
 *     viewport at launch would spawn a separate non-app page and lose app mode).
 *   - We read the debugging port from the profile's DevToolsActivePort file
 *     (launched with `--remote-debugging-port=0`, so every worker gets a free
 *     port and cannot collide).
 */

import { test as base, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_ORIGIN = 'http://127.0.0.1:4321';
const url = (path = '/') => APP_ORIGIN + path;
// iPhone 16 Pro CSS viewport (pt). deviceScaleFactor is irrelevant to CSS-px
// layout geometry, so width/height are all the safe-area checks need.
const IPHONE_16_PRO = { width: 402, height: 874 };

/** Poll `pred` until it returns truthy (or throw on timeout). */
async function waitFor(pred, { timeout = 15000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Override the built-in `page` fixture: it becomes a real standalone app window.
const test = base.extend({
  page: async ({}, use) => {
    // Integration exports PW_CHROMIUM to the pre-installed full Chromium; fall
    // back to Playwright's resolved chromium binary otherwise.
    const chromePath = process.env.PW_CHROMIUM || chromium.executablePath();
    const userDataDir = mkdtempSync(join(tmpdir(), 'nfl2026-pwa-'));
    // --app opens the URL as a standalone app window (display-mode: standalone).
    // --no-sandbox is required as root in CI/containers. Port 0 => a free port,
    // reported back via the DevToolsActivePort file.
    const child = spawn(chromePath, [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--app=${APP_ORIGIN}/`,
    ], { stdio: 'ignore' });

    let browser;
    try {
      const portFile = join(userDataDir, 'DevToolsActivePort');
      const port = await waitFor(() => {
        if (!existsSync(portFile)) return null;
        const line = readFileSync(portFile, 'utf8').split('\n')[0].trim();
        return line || null;
      });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      // The app window is the browser's sole page; wait for it to attach + load.
      const page = await waitFor(() => {
        const p = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((pg) => pg.url().startsWith(APP_ORIGIN));
        return p || null;
      });
      // Apply iPhone 16 Pro metrics without disturbing app mode.
      await page.setViewportSize(IPHONE_16_PRO);
      await use(page);
    } finally {
      if (browser) await browser.close().catch(() => {});
      child.kill('SIGKILL');
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
});

/** Poll until >= 1 node matches `selector`. */
async function waitForCards(page, selector) {
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    selector,
    { timeout: 8000 },
  );
}

/** Parse "rgb(r, g, b)" / "rgba(...)" -> [r,g,b]. */
function rgbTriplet(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(',').slice(0, 3).map((n) => parseInt(n.trim(), 10));
}

test.describe('installed (standalone) PWA experience', () => {
  test('reports display-mode: standalone', async ({ page }) => {
    await page.goto(url('/'));
    const standalone = await page.evaluate(
      () => window.matchMedia('(display-mode: standalone)').matches,
    );
    expect(standalone).toBe(true);
  });

  test('theme-color meta and manifest are dark + standalone', async ({ page }) => {
    await page.goto(url('/'));

    // theme-color drives the iOS status-bar / task-switcher tint — must be --bg.
    const themeColor = await page.evaluate(
      () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    );
    expect(themeColor).toBe('#0D1117');

    // The manifest link must resolve to valid JSON declaring a standalone, dark app.
    const manifestHref = await page.evaluate(
      () => document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    );
    expect(manifestHref, 'manifest link present').toBeTruthy();

    const manifest = await page.evaluate(async (href) => {
      const res = await fetch(href);
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      return res.json(); // throws if not valid JSON
    }, manifestHref);

    expect(manifest.display).toBe('standalone');
    // Dark theme_color: the locked --bg. (Also guards against a light manifest.)
    expect(manifest.theme_color).toBe('#0D1117');
    expect(manifest.background_color).toBe('#0D1117');
  });

  test('safe-area insets are respected (Dynamic Island + home indicator)', async ({ page }) => {
    await page.goto(url('/'));
    await waitForCards(page, '.card');

    // Emulate the iPhone 16 Pro standalone insets (top 59 / bottom 34). CSS custom
    // properties recalc live, so the shell reflows immediately — we deliberately
    // do NOT reload (a reload would drop this injected tag; the vars apply live).
    await page.addStyleTag({
      content: ':root{--safe-top:59px;--safe-bottom:34px;}',
    });
    // Let the layout settle after the variable change.
    await page.waitForTimeout(100);

    const geom = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const tabbar = document.querySelector('.tabbar');
      const view = document.querySelector('.view');
      const wordmark = document.querySelector('.topbar .wordmark') ||
        document.querySelector('.wordmark');
      const cs = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
      return {
        topbarBottom: topbar.getBoundingClientRect().bottom,
        // "content top": where the topbar's actual content begins (below the inset pad).
        contentTop: wordmark.getBoundingClientRect().top,
        tabbarPadBottom: cs(tabbar, 'paddingBottom'),
        viewTop: view.getBoundingClientRect().top,
      };
    });

    // Topbar content clears the ~59px Dynamic Island region (base pad + inset).
    expect(geom.contentTop).toBeGreaterThanOrEqual(50);
    // Tabbar bottom padding clears the ~34px home indicator (base pad + inset).
    expect(geom.tabbarPadBottom).toBeGreaterThanOrEqual(30);
    // Nothing overlaps the top inset: the scrolling view starts below the topbar.
    expect(geom.viewTop).toBeGreaterThanOrEqual(geom.topbarBottom - 1);
  });

  test('is dark-only with no theme toggle', async ({ page }) => {
    await page.goto(url('/'));

    const colorScheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(colorScheme).toContain('dark');

    // Body background is the locked --bg (#0D1117 = rgb(13,17,23)), within tol.
    const bodyBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    const [r, g, b] = rgbTriplet(bodyBg) || [];
    expect(Math.abs(r - 13)).toBeLessThanOrEqual(4);
    expect(Math.abs(g - 17)).toBeLessThanOrEqual(4);
    expect(Math.abs(b - 23)).toBeLessThanOrEqual(4);

    // Dark-ONLY: no theme-toggle hook anywhere.
    const hasToggle = await page.evaluate(
      () =>
        document.documentElement.hasAttribute('data-theme') ||
        document.querySelector('[data-theme]') !== null,
    );
    expect(hasToggle).toBe(false);
  });

  test('content renders from data (slate / players / parlays)', async ({ page }) => {
    // Slate: >= 1 game card, each with a win-prob track.
    await page.goto(url('/#/'));
    await waitForCards(page, '.card.game');
    expect(await page.locator('.card.game').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.card.game .track').count()).toBeGreaterThanOrEqual(1);

    // Players: >= 1 player card, and the REL2 adornments render standalone too
    // (trend chip + strength-of-schedule pill) — the installed PWA is not a
    // lesser experience than the web build.
    await page.goto(url('/#/players'));
    await waitForCards(page, '.card.player');
    expect(await page.locator('.card.player').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.p-trend').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.p-sos').count()).toBeGreaterThanOrEqual(1);

    // Parlays: GAME scope >= 3, WEEK scope >= 3. Toggle the segmented control so
    // each scope's cards are in the DOM before counting.
    await page.goto(url('/#/parlays'));
    await waitForCards(page, '.card.parlay');

    const seg = page.locator('.scopeseg');
    await expect(seg).toHaveCount(1);

    // GAME scope.
    await seg.getByText(/game/i).first().click();
    await page.waitForTimeout(50);
    expect(
      await page.locator('.card.parlay[data-scope="game"]').count(),
    ).toBeGreaterThanOrEqual(3);

    // WEEK scope.
    await seg.getByText(/week/i).first().click();
    await page.waitForTimeout(50);
    expect(
      await page.locator('.card.parlay[data-scope="week"]').count(),
    ).toBeGreaterThanOrEqual(3);
  });

  test('TEAM tab renders standalone and the roster persists across reload', async ({ page }) => {
    await page.goto(url('/#/team'));
    await page.waitForSelector('.roster .slot', { timeout: 8000 });
    // Contract roster: QB,RB,RB,WR,WR,TE,FLEX + 6 bench = 13 slots.
    expect(await page.locator('.roster .slot').count()).toBe(13);
    // REL2 finder + reco controls render inside the standalone window.
    expect(await page.locator('.finder-posfilter .pf-chip').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.finder-sortseg .sort-chip').count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.reco-controls .sort-chip[data-rsort="available"]')).toHaveCount(1);
    // Still a genuine app-mode window on the team route.
    const standalone = await page.evaluate(
      () => window.matchMedia('(display-mode: standalone)').matches,
    );
    expect(standalone).toBe(true);

    // Runtime player pick (no hardcoded names): the top projected QB, fetched
    // from the same contract the app renders from.
    const qb = await page.evaluate(async () => {
      const res = await fetch('/data/player_projections.json');
      const d = await res.json();
      return d.players.find((p) => p.position === 'QB');
    });
    expect(qb, 'no QB in player_projections').toBeTruthy();

    await page.fill('.finder-input', qb.name);
    await page.waitForSelector('.cand .cand-add', { timeout: 8000 });
    await page.locator('.cand', { hasText: qb.name }).first()
      .locator('.cand-add').click();
    await expect(page.locator('.slot[data-slot="QB1"] .slot-player'))
      .toContainText(qb.name);

    // Reload INSIDE the app window (stays standalone — see fixture header):
    // the roster must re-render from localStorage nfl2026.team.v1.
    await page.reload();
    await page.waitForSelector('.roster .slot-player', { timeout: 8000 });
    await expect(page.locator('.slot[data-slot="QB1"] .slot-player'))
      .toContainText(qb.name);
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('nfl2026.team.v1') || 'null'),
    );
    expect(stored && stored.slots && stored.slots.QB1).toBe(qb.gsis_id);
  });

  test('AI+ toggle works standalone: chips only when ON, choice persists', async ({ page }) => {
    await page.goto(url('/#/team'));
    await page.waitForSelector('.aiseg', { timeout: 8000 });

    // Default OFF (BASE) — the v1 experience, no provenance chips anywhere.
    await expect(page.locator('.aiseg button[data-ai="off"]'))
      .toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.prov-ai').count()).toBe(0);

    // Flip ON inside the standalone window: the reco head names the mode and
    // any chip that renders sits ONLY on a reason that says "(AI estimate".
    await page.locator('.aiseg button[data-ai="on"]').click();
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.reco .reco-slot')).toContainText('AI+');
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

    // Persists across reload INSIDE the app window (stays standalone).
    await page.reload();
    await page.waitForSelector('.aiseg', { timeout: 8000 });
    await expect(page.locator('.aiseg button[data-ai="on"]'))
      .toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('nfl2026.ai.v1'));
    expect(stored).toBe('on');
    const standalone = await page.evaluate(
      () => window.matchMedia('(display-mode: standalone)').matches,
    );
    expect(standalone).toBe(true);
  });

  test('service worker registers (cache-purger)', async ({ page }) => {
    await page.goto(url('/'));
    // navigator.serviceWorker.ready resolves once the SW is active.
    const ready = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((r) => setTimeout(() => r('timeout'), 8000)),
      ]);
      return reg === true;
    });
    expect(ready).toBe(true);
  });
});
