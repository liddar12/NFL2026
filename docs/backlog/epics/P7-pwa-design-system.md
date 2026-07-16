# P7 · PWA Shell & Design System
**Layer:** Platform   ·   **Status:** ✅ delivered in PR #1 (merged to `main` in PR #1)   ·   **Instantiates:** —

> **Branch note:** this backlog branch is based on `main`; the design-system and view code was **built, CI-verified, and MERGED to `main` in PR #1.** Design-system/view stories below still marked ⬜/🟡 predate the merge — treat PR #1's delivered items as ✅ (now on `main`).

**Reuse:** A future adapter (NBA/MLB/markets) reuses the entire shell — hash router, pure-cache-purger `sw.js`, standalone manifest scaffold, safe-area handling, the tokenized design system, and the automated WCAG-AA contrast gate — verbatim. It re-authors ONLY the token *values* (one theme file) and the brand assets (icons, name, theme-color). Nothing in this epic is NFL-specific; the current instance happens to render as *Broadcast Gameday · dark-only · J5L · iPhone 16 Pro*, but that identity lives entirely in swappable tokens.

## Goal
Ship a vanilla-JS, no-build installable PWA shell and a tokenized design system that any prediction adapter can re-skin by editing one token layer. The shell must be installable standalone on iPhone with correct safe-area handling, route without a framework, never serve stale code, and prove — by an automated test, not by eye — that every foreground/background pairing meets WCAG-AA. Visual identity (color, type, brand) is data (tokens), not code, so the platform thesis "the next adapter reuses the core untouched" holds at the presentation layer too.

## Why it matters / risk if skipped
The presentation layer is where a framework leaks its domain assumptions and where reuse quietly dies: hard-coded hex values, one-off components, and a caching service worker that serves day-old JS after a deploy (the exact wc2026 postmortem this shell's pure-purger `sw.js` exists to prevent). Contrast "looked fine on my monitor" is how a dark theme ships unreadable meters; only a machine check enforced in the gate keeps AA true across every token pairing. If tokens are not extracted, the second adapter forks the CSS and the "platform" becomes two codebases.

## User stories

### P7-S1 — Installable standalone PWA (manifest + safe-area)   ·  Status: 🟡   ·  Est: M
**As** an Analyst **I want** to install NFL2026 to my iPhone home screen and run it fullscreen **so that** it behaves like a native app with no browser chrome eating the score meters.
**Acceptance criteria:**
- P7-S1-AC1 — Given `manifest.webmanifest`, When validated, Then `display` = `standalone`, `orientation` = `portrait`, `start_url` = `/`, `scope` = `/`, and both 192 and 512 icons are declared `purpose: "any maskable"`.
- P7-S1-AC2 — Given the app is launched from the home screen, When `window.matchMedia('(display-mode: standalone)')` is queried, Then it matches (fullscreen, no browser UI).
- P7-S1-AC3 — Given an iPhone 16 Pro viewport (`viewport-fit=cover`), When the main content renders, Then bottom padding includes `env(safe-area-inset-bottom)` and no content sits under the home indicator (top/bottom insets respected).
- P7-S1-AC4 — Given `<meta name="theme-color">`, When compared to the manifest `theme_color`, Then both equal the same token value (currently `#0b0f14`).
**Tasks:**
- [ ] P7-S1-T1 — Keep `manifest.webmanifest` fields under the token layer (name/short_name/colors sourced from brand tokens).
- [ ] P7-S1-T2 — Emit real 192/512 maskable PNGs into `icons/` (currently missing) and reference from manifest + `apple-touch-icon`.
- [ ] P7-S1-T3 — Apply `env(safe-area-inset-*)` to the app frame (top and bottom), keep `viewport-fit=cover` in `index.html`.
- [ ] P7-S1-T4 — Add a PWA e2e that asserts standalone display-mode and inset padding on the iPhone 16 Pro device profile.
**QA coverage:**
- P7-S1-AC1 → `scripts/validate_data.py::manifest_check` (data) — Planned
- P7-S1-AC2 → `tests/pwa/install.spec.mjs::standalone-display-mode` (e2e-pwa) — Planned
- P7-S1-AC3 → `tests/pwa/safe_area.spec.mjs::bottom-inset-applied` (e2e-pwa) — Planned
- P7-S1-AC4 → `tests/web/theme_color.spec.mjs::meta-matches-manifest` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Test types: data | e2e-pwa | e2e-web.
**Traceability:** `manifest.webmanifest`, `index.html`, `icons/*` (new — dir empty today), `tests/pwa/*.spec.mjs` (new), `tests/web/*.spec.mjs` (new).

### P7-S2 — Frameworkless hash router   ·  Status: ✅   ·  Est: S
**As** an Analyst **I want** deep-linkable routes (`#/`, `#/players`, `#/games`, `#/parlays`) without a framework **so that** the app stays a no-build vanilla-JS shell any adapter can lift.
**Acceptance criteria:**
- P7-S2-AC1 — Given a route hash, When it changes, Then the `#view` region re-renders to the matching view and unknown hashes fall back to Home (no blank screen).
- P7-S2-AC2 — Given a module script (deferred), When the app boots, Then bootstrap runs exactly once whether `DOMContentLoaded` has fired or not (idempotent `boot()` guard).
- P7-S2-AC3 — Given the live region, When a route renders, Then `#view` carries `aria-live="polite"` so route changes are announced.
**Tasks:**
- [ ] P7-S2-T1 — Keep the `ROUTES` map + `renderRoute()` in `app/main.js`; extract to a router module when views land.
- [ ] P7-S2-T2 — Preserve the once-only boot guard on both `DOMContentLoaded` and already-parsed paths.
- [ ] P7-S2-T3 — Add an e2e that navigates each hash and asserts the correct view header + fallback-to-Home on a bad hash.
**QA coverage:**
- P7-S2-AC1 → `tests/web/router.spec.mjs::route-and-fallback` (e2e-web) — Planned
- P7-S2-AC2 → `tests/feature/router.test.mjs::boot-runs-once` (unit) — Planned
- P7-S2-AC3 → `tests/web/router.spec.mjs::view-is-live-region` (e2e-web) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test) | e2e-web.
**Traceability:** `app/main.js`, `index.html`.

### P7-S3 — Pure cache-purger service worker   ·  Status: ✅   ·  Est: S
**As** an Operator **I want** a service worker that caches NOTHING and purges any prior caches **so that** a deploy never leaves users running day-old JS (the wc2026 stale-shell postmortem).
**Acceptance criteria:**
- P7-S3-AC1 — Given `sw.js`, When inspected, Then it registers NO `fetch` handler (every request hits the network).
- P7-S3-AC2 — Given a prior install that cached files, When the new SW activates, Then it deletes every cache keyed `nfl26-*` and calls `clients.claim()`.
- P7-S3-AC3 — Given SW registration, When it fails, Then first paint is unaffected (registration is best-effort, `.catch` only warns).
- P7-S3-AC4 — Given freshness is header-controlled, When `_headers` is read, Then app code uses short max-age + stale-while-revalidate and `/data/*` is `must-revalidate` (SW does not manage freshness).
**Tasks:**
- [ ] P7-S3-T1 — Keep `sw.js` fetch-handler-free; retain `skipWaiting()` + activate-time purge.
- [ ] P7-S3-T2 — Keep the `GET_VERSION` message probe for active-SW confirmation.
- [ ] P7-S3-T3 — Add a smoke assertion that `sw.js` contains no `addEventListener('fetch'`.
**QA coverage:**
- P7-S3-AC1 → `tests/smoke.sh::sw-has-no-fetch-handler` (smoke) — Planned
- P7-S3-AC2 → `tests/pwa/sw_purge.spec.mjs::activate-deletes-caches` (e2e-pwa) — Planned
- P7-S3-AC3 → `tests/pwa/sw_purge.spec.mjs::registration-nonblocking` (e2e-pwa) — Planned
- P7-S3-AC4 → `tests/smoke.sh::headers-freshness-policy` (smoke) — Planned
- Coverage: 4/4 = 100%. Test types: smoke(bash) | e2e-pwa.
**Traceability:** `sw.js`, `_headers`, `index.html`.

### P7-S4 — Tokenized design system (dark theme)   ·  Status: ⬜   ·  Est: L
**As** a Modeler **I want** all color, type, spacing, and radius expressed as CSS custom-property tokens in one theme file **so that** a new adapter re-skins by editing tokens, not components.
**Acceptance criteria:**
- P7-S4-AC1 — Given `app/theme.css`, When audited, Then every color/type/space/radius used by views resolves to a `--token` (no raw hex or px literals in view CSS/JS; the provisional inline `<style>` in `index.html` is removed).
- P7-S4-AC2 — Given the dark-only instance, When rendered, Then `:root { color-scheme: dark }` holds and no light-mode fork exists; a re-skin swaps token values only.
- P7-S4-AC3 — Given the design system, When a component (card, meter, nav, pill/tier badge) is rendered, Then it is built from shared token-driven primitives in `app/render.js` (no per-view one-off styling).
- P7-S4-AC4 — Given a token contract, When linted, Then a documented required token set (bg, surface, text, muted, accent, positive/negative, border) is present so an adapter knows exactly what to supply.
**Tasks:**
- [ ] P7-S4-T1 — Author `app/theme.css` as the single token layer (Broadcast Gameday values for this instance).
- [ ] P7-S4-T2 — Build `app/render.js` primitives (card, meter, pill, nav) consuming tokens only.
- [ ] P7-S4-T3 — Remove provisional inline `<style>` from `index.html`; link `app/theme.css`.
- [ ] P7-S4-T4 — Add a lint/test asserting no raw hex/px in view layer and presence of the required token set.
**QA coverage:**
- P7-S4-AC1 → `tests/feature/tokens.test.mjs::no-raw-hex-in-views` (unit) — Planned
- P7-S4-AC2 → `tests/web/theme.spec.mjs::dark-color-scheme` (e2e-web) — Planned
- P7-S4-AC3 → `tests/feature/tokens.test.mjs::primitives-from-tokens` (unit) — Planned
- P7-S4-AC4 → `tests/feature/tokens.test.mjs::required-token-set-present` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | e2e-web.
**Traceability:** `app/theme.css` (new), `app/render.js` (new), `index.html`.

### P7-S5 — WCAG-AA contrast enforced by automated test   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** the gate to fail if any token pairing drops below AA **so that** a dark theme can never ship unreadable meters or muted text.
**Acceptance criteria:**
- P7-S5-AC1 — Given every foreground/background token pairing used in the UI, When contrast is computed, Then normal text ≥ 4.5:1.
- P7-S5-AC2 — Given large text (≥ 24px, or ≥ 18.66px bold) and UI graphics/meters/borders, When contrast is computed, Then ratio ≥ 3:1.
- P7-S5-AC3 — Given a token change that regresses any pairing below its threshold, When the gate runs, Then `tests/feature/contrast_aa.test.mjs` exits non-zero (gate is on exit code, not colored summary).
- P7-S5-AC4 — Given a team-identity tint used as background (N5), When paired with its text token, Then it is included in the pairing set and checked at the appropriate threshold.
**Tasks:**
- [ ] P7-S5-T1 — Implement WCAG relative-luminance + contrast-ratio math (no external dep) in the test.
- [ ] P7-S5-T2 — Enumerate the pairing set from `app/theme.css` tokens (text-on-surface, muted-on-surface, accent-on-bg, tint pairings).
- [ ] P7-S5-T3 — Threshold-map each pairing (text 4.5 / large+graphics 3.0) and assert.
- [ ] P7-S5-T4 — Wire `tests/feature/contrast_aa.test.mjs` into `tests/run_gate.sh`.
**QA coverage:**
- P7-S5-AC1 → `tests/feature/contrast_aa.test.mjs::text-min-4_5` (contrast) — Planned
- P7-S5-AC2 → `tests/feature/contrast_aa.test.mjs::large-and-graphics-min-3` (contrast) — Planned
- P7-S5-AC3 → `tests/run_gate.sh` exit-code gate on the above (contrast) — Planned
- P7-S5-AC4 → `tests/feature/contrast_aa.test.mjs::team-tints-checked` (contrast) — Planned
- Coverage: 4/4 = 100%. Test types: contrast(AA) | gate(exit-code).
**Traceability:** `tests/feature/contrast_aa.test.mjs` (new), `app/theme.css` (new), `tests/run_gate.sh`.

### P7-S6 — Re-skin seam: token extraction for a future adapter   ·  Status: ⬜   ·  Est: M
**As** a Modeler standing up the next adapter **I want** a documented, tested procedure to re-skin by swapping only tokens + brand assets **so that** the platform stays one codebase across sports/markets.
**Acceptance criteria:**
- P7-S6-AC1 — Given a second token set (a throwaway "verify" theme), When its values replace `app/theme.css`, Then the app renders with the new identity and NO view/router/SW code changes are required.
- P7-S6-AC2 — Given the re-skin, When the contrast gate runs on the new token set, Then AA is re-verified automatically (P7-S5 runs against whatever tokens are present).
- P7-S6-AC3 — Given brand assets, When an adapter swaps `icons/*`, manifest name/colors, and `theme-color`, Then no other file references the old brand (grep-clean).
- P7-S6-AC4 — Given the seam, When documented, Then `docs/backlog/` (or design doc) lists the exact swap surface: theme.css tokens, icons/, manifest fields, meta theme-color.
**Tasks:**
- [ ] P7-S6-T1 — Document the re-skin swap surface (tokens, icons, manifest, theme-color) as the adapter checklist.
- [ ] P7-S6-T2 — Add a test that loads an alternate token file and asserts render + AA pass with zero code diff.
- [ ] P7-S6-T3 — Add a grep guard that brand strings/colors appear only in the token/manifest/icons surface.
**QA coverage:**
- P7-S6-AC1 → `tests/web/reskin.spec.mjs::alt-tokens-render` (e2e-web) — Planned
- P7-S6-AC2 → `tests/feature/contrast_aa.test.mjs` run against alt tokens (contrast) — Planned
- P7-S6-AC3 → `tests/smoke.sh::brand-confined-to-token-surface` (smoke) — Planned
- P7-S6-AC4 → design-doc review (manual) — Planned
- Coverage: automatable 3/4 = 75% automated; 4/4 including the doc-review AC. Test types: e2e-web | contrast | smoke | manual.
**Traceability:** `app/theme.css` (new), `icons/*` (new), `manifest.webmanifest`, `index.html`, `docs/backlog/*`.
