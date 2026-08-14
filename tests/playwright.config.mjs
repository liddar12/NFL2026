/* tests/playwright.config.mjs — browser E2E config (Agent D).
 *
 * INDEPENDENT web vs PWA proof (explicit user requirement): two projects drive
 * the SAME static build but assert different things —
 *   - `web`  proves the in-BROWSER experience (display-mode: browser, no PWA
 *            chrome, no safe-area insets → still no overlap).
 *   - `pwa`  proves the INSTALLED experience (display-mode: standalone emulated
 *            via CDP, Dynamic-Island / home-indicator safe areas respected,
 *            dark-only, service worker registered, content renders from data).
 *
 * NOT part of the dependency-free FAST gate: Playwright is a dev-only / CI
 * (opt-in) step. tests/run_gate.sh skips it loudly when @playwright/test is
 * absent so a clean box still runs the fast gate with zero installs.
 *
 * Device: iPhone 16 Pro — CSS viewport 402 x 874 pt, devicePixelRatio 3.
 */

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve paths from THIS file's location, never a hardcoded absolute — the repo
// lives at different paths locally (/home/user/nfl2026) vs CI
// (/home/runner/work/NFL2026/NFL2026). A hardcoded cwd makes the webServer spawn
// fail with ENOENT on any machine but the author's.
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, '..');

// iPhone 16 Pro metrics, shared by both projects (the contract's reference).
const IPHONE_16_PRO = {
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  baseURL: 'http://127.0.0.1:4321',
};

export default defineConfig({
  testDir: TESTS_DIR,

  // Serve the repo root statically so absolute /data, /app, /manifest paths
  // resolve exactly as they do in production. reuseExistingServer lets a dev
  // keep `npm run serve` running across test runs.
  webServer: {
    command: 'python3 -m http.server 4321',
    cwd: REPO_ROOT,
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: true,
    timeout: 30000,
  },

  // Point at the pre-installed full Chromium when integration exports PW_CHROMIUM
  // (headless_shell can't emulate everything we need); otherwise use Playwright's
  // own bundled browser.
  use: {
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM || undefined,
    },
    // Pre-seed the front-of-site password gate as unlocked so the suite drives
    // the app itself, not the entry screen. (The gate's own behavior is covered
    // by a dedicated spec that clears this state.)
    storageState: resolve(TESTS_DIR, 'gate-unlocked.storage.json'),
  },

  projects: [
    {
      name: 'web',
      testMatch: /web\/.*\.spec\.mjs/,
      use: { ...IPHONE_16_PRO },
    },
    {
      name: 'pwa',
      testMatch: /pwa\/.*\.spec\.mjs/,
      use: { ...IPHONE_16_PRO },
    },
    // `perf` — the R25 PERFORMANCE BUDGET (tests/perf/budget.spec.mjs). Counts,
    // not milliseconds: boot-graph size, contracts per route, duplicate fetches,
    // DOM nodes, leaked listeners. See that file's header for exactly what it
    // does and does not catch.
    //
    // Two deliberate differences from web/pwa:
    //   - iPad 1024x1366, because the Team page is iPad-first and that is the
    //     viewport the RCA measured. Every budget in the file is a count, and
    //     counts are viewport-independent, so one viewport is enough.
    //   - `dependencies` makes it run AFTER the other two projects rather than
    //     alongside them. The budget's single timing-shaped assertion is a ratio
    //     against a calibration workload; running it while other workers hammer
    //     the same CPU adds noise for no benefit. The count assertions are
    //     immune to contention either way.
    //
    // testMatch names budget.spec.mjs specifically: the rest of tests/perf/ is
    // the RCA's measurement harness (mount-cost.mjs, profile.mjs, micro.mjs,
    // ...), which is run by hand and stays out of the gate.
    {
      name: 'perf',
      testMatch: /perf\/budget\.spec\.mjs/,
      dependencies: ['web', 'pwa'],
      use: {
        viewport: { width: 1024, height: 1366 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        baseURL: 'http://127.0.0.1:4321',
      },
    },
  ],
});
