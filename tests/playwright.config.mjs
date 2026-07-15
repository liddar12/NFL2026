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

// iPhone 16 Pro metrics, shared by both projects (the contract's reference).
const IPHONE_16_PRO = {
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  baseURL: 'http://127.0.0.1:4321',
};

export default defineConfig({
  testDir: '/home/user/nfl2026/tests',

  // Serve the repo root statically so absolute /data, /app, /manifest paths
  // resolve exactly as they do in production. reuseExistingServer lets a dev
  // keep `npm run serve` running across test runs.
  webServer: {
    command: 'python3 -m http.server 4321',
    cwd: '/home/user/nfl2026',
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
  ],
});
