# P9 · Deploy & Ops
**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter reuses the whole topology — static PWA on Netlify (push-to-main auto-deploy), a separate edge live-API on Vercel, GitHub Actions crons committing JSON to `main` with race-safe merges, an exit-code-gated regression run before any deploy, a stated rollback, and post-deploy prod verification. An adapter re-authors only the concrete endpoint URLs, the live-API handler, and the feed-specific cron cadence; the deploy discipline is domain-agnostic.

## Goal
Ship the PWA and its live-score API safely and repeatably: a green gate is the precondition for every deploy, a one-line rollback is stated before shipping, and prod is verified after (curl the deployed file/endpoint — never assume). Two independent deploy surfaces stay decoupled (static site on Netlify, edge API on Vercel) so one can ship without the other, and concurrent crons commit data to `main` without clobbering each other. Freshness is controlled by HTTP headers, not a caching service worker, so a deploy reaches every open tab within minutes.

## Why it matters / risk if skipped
A deploy with a red gate ships a known-broken build; a deploy with no rollback plan turns a bad ship into an outage; a deploy nobody verified on prod is a guess. The wc2026 stale-service-worker bug is the standing warning: a caching SW served day-old JS after a deploy, so here the SW is a pure cache-purger and `_headers` is the only freshness control. Race-unsafe cron pushes are the data-loss analogue: two crons pushing to `main` concurrently can drop a commit unless every push fast-forwards and retries. This epic encodes all of that as checkable ops rules.

## User stories

### P9-S1 — PWA auto-deploys from main via Netlify (no bundler)   ·  Status: 🟡   ·  Est: S
**As** an Operator **I want** a push to `main` to auto-deploy the static PWA **so that** shipping is `git push`, with no build pipeline to break.
**Acceptance criteria** (Given/When/Then):
- P9-S1-AC1 — Given `netlify.toml`, When Netlify builds, Then the build command is exactly `node scripts/write-runtime-config.mjs` and `publish = "."` (no bundler/framework step).
- P9-S1-AC2 — Given an empty build environment, When `write-runtime-config.mjs` runs, Then it emits `app/runtime-config.js` with safe defaults (`env=dev`, empty `liveApi`) and exits 0 — a no-secret, no-network, clean-box build.
- P9-S1-AC3 — Given deep links to real static paths (`/app/*`, `/data/*`, `/icons/*`), When requested, Then they are served as-is (status 200, not rewritten to `index.html`); everything else falls through to the shell.
**Tasks:**
- [ ] P9-S1-T1 — Keep the Netlify redirect order: specific passthroughs first, `/*` → `/index.html` last.
- [ ] P9-S1-T2 — Keep `write-runtime-config.mjs` Node-builtins-only and secret-free.
- [ ] P9-S1-T3 — Smoke-check the generated `runtime-config.js` shape in the gate.
**QA coverage:**
- P9-S1-AC1 → `tests/feature/deploy_config.test.mjs::netlify_build_and_publish` (unit — parse netlify.toml) — Planned
- P9-S1-AC2 → `tests/feature/deploy_config.test.mjs::runtime_config_empty_env` (unit — run script with empty env) — Planned
- P9-S1-AC3 → `tests/feature/deploy_config.test.mjs::redirects_order` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `netlify.toml`, `scripts/write-runtime-config.mjs`, `app/runtime-config.js`.

### P9-S2 — Live API deploys separately to Vercel edge   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** the live-score API to deploy independently on Vercel **so that** the real-time endpoint can ship without a site deploy and vice versa.
**Acceptance criteria** (Given/When/Then):
- P9-S2-AC1 — Given the live-API project, When redeployed via the Vercel CLI (`--prod --yes --scope <team>`), Then it publishes only the edge function and Netlify ignores that directory (the two surfaces are decoupled).
- P9-S2-AC2 — Given the deployed `/api/nfl` endpoint, When curled, Then it returns JSON with STATUS-GATING applied: only FINAL games surface as results; live/halftime/scheduled stubs are display-only and never scored.
- P9-S2-AC3 — Given the edge endpoint errors, When the client polls, Then it falls back to direct-source with the same team-name normalization (RENAMES mirrored client + edge + scraper).
**Tasks:**
- [ ] P9-S2-T1 — Author the edge handler and its own deploy path; exclude it from the Netlify build.
- [ ] P9-S2-T2 — Enforce STATUS-gating in the handler (FINAL-only scoring).
- [ ] P9-S2-T3 — Mirror the RENAMES map across client/edge/scraper and test the three stay in sync.
**QA coverage:**
- P9-S2-AC1 → `tests/feature/deploy_config.test.mjs::live_api_excluded_from_netlify` (unit) — Planned
- P9-S2-AC2 → `tests/feature/live_status_gate.test.mjs::final_only_scores` (unit) — Planned
- P9-S2-AC3 → `tests/feature/live_renames.test.mjs::renames_in_sync` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** new (`live-api/api/nfl.js`), `scripts/scrape/renames.py`, `app/data.js`.

### P9-S3 — GitHub Actions crons commit JSON to main, race-safe   ·  Status: 🟡   ·  Est: M
**As** an Operator **I want** the daily and gameday crons to commit `data/` to `main` without clobbering each other **so that** concurrent pushes never drop a commit.
**Acceptance criteria** (Given/When/Then):
- P9-S3-AC1 — Given a cron regenerated data, When it commits, Then it runs `git pull --ff-only origin main` then `git push`, retrying up to 5 times, and exits non-zero only if all retries fail (`::error::could not push`).
- P9-S3-AC2 — Given a data conflict between two crons, When merging, Then the freshly generated files this run produced are preferred (the run just produced them).
- P9-S3-AC3 — Given a run that produced no data change, When committing, Then `git diff --cached --quiet` short-circuits to "No changes to commit" and exits 0 (no empty commit).
- P9-S3-AC4 — Given cron cadence is heavily throttled (a scheduled job may fire hours late), When designing real-time behavior, Then nothing real-time depends on cron timing (scores come from the edge endpoint); crons carry only the durable record.
- P9-S3-AC5 — Given both workflows commit data, When they run, Then each uses `[skip ci]` and its own `concurrency` group (`data-pipeline`, `gameday`) so a data commit doesn't trigger the gate and same-group runs serialize.
**Tasks:**
- [ ] P9-S3-T1 — Keep the `pull --ff-only` + retry-loop push in both `daily.yml` and `gameday.yml`.
- [ ] P9-S3-T2 — Keep `fetch-depth: 0` so fast-forward has full history.
- [ ] P9-S3-T3 — Keep `[skip ci]` on data commits and distinct concurrency groups.
- [ ] P9-S3-T4 — Run `pipeline_status.py` + `validate_data.py` before every commit so no invalid/`down` data lands.
**QA coverage:**
- P9-S3-AC1 → `tests/feature/cron_racesafe.test.mjs::ff_only_retry_loop` (unit — parse yml, assert steps) — Planned
- P9-S3-AC2 → manual (conflict-resolution policy review) — Planned (documented policy)
- P9-S3-AC3 → `tests/feature/cron_racesafe.test.mjs::no_empty_commit` (unit) — Planned
- P9-S3-AC4 → `tests/feature/cron_racesafe.test.mjs::no_realtime_on_cron` (unit — assert scores not sourced from daily cron) — Planned
- P9-S3-AC5 → `tests/feature/cron_racesafe.test.mjs::skip_ci_and_concurrency` (unit) — Planned
  Coverage: 4/5 automatable covered; AC2 manual-by-nature = 4/4 automatable = 100%. Test types: unit(node:test), manual.
**Traceability:** `.github/workflows/daily.yml`, `.github/workflows/gameday.yml`, `scripts/validate_data.py`, `scripts/pipeline_status.py`.

### P9-S4 — Regression 100% green before any deploy   ·  Status: ✅   ·  Est: S
**As** an Operator **I want** the full regression gate to pass before any deploy **so that** a red build never ships.
**Acceptance criteria** (Given/When/Then):
- P9-S4-AC1 — Given the gate, When run, Then it executes in order — `validate_data.py` → `smoke.sh` → `node --test tests/feature/*.mjs` — and fails fast on the first non-zero exit (gated on EXIT CODES, never on grepping colored summaries).
- P9-S4-AC2 — Given CI on push/PR to `main`, When it runs `bash tests/run_gate.sh`, Then the job fails iff the gate returns non-zero, and installs NO external packages (zero-dep invariant).
- P9-S4-AC3 — Given a deploy is requested, When the gate is not green, Then the deploy is blocked (precondition), and this is stated as policy in `docs/`.
**Tasks:**
- [ ] P9-S4-T1 — Keep `run_gate.sh` as the single source of truth for the gate order; CI calls only it.
- [ ] P9-S4-T2 — Keep the gate stdlib-only (no pip/npm install in `ci.yml`).
- [ ] P9-S4-T3 — Document "never deploy red" as a hard precondition.
**QA coverage:**
- P9-S4-AC1 → `tests/run_gate.sh` exit-code ordering, exercised on every CI run (smoke/meta) — Done
- P9-S4-AC2 → `.github/workflows/ci.yml` runs `bash tests/run_gate.sh`, no install steps — Done
- P9-S4-AC3 → manual (deploy-precondition policy) — Planned (documented policy)
  Coverage: 2/2 automatable = 100% (AC1/AC2 Done); AC3 policy-manual. Test types: smoke(bash), meta(CI), manual.
**Traceability:** `tests/run_gate.sh`, `tests/smoke.sh`, `tests/feature/*.mjs`, `scripts/validate_data.py`, `.github/workflows/ci.yml`.

### P9-S5 — Rollback stated before deploy; verify on prod after   ·  Status: 🟡   ·  Est: S
**As** an Operator **I want** every deploy to name its one-line rollback up front and be verified on prod after **so that** a bad ship reverts in one command and no deploy is assumed.
**Acceptance criteria** (Given/When/Then):
- P9-S5-AC1 — Given a PWA deploy, When it ships, Then the rollback is a single command stated beforehand: `git revert <sha> && git push origin main` (Netlify auto-redeploys the reverted shell).
- P9-S5-AC2 — Given a live-API deploy, When it ships, Then the rollback is a single Vercel CLI command stated beforehand (redeploy the prior promoted deployment / `vercel rollback`).
- P9-S5-AC3 — Given a completed PWA deploy, When verified, Then a curl of the deployed file/endpoint on the prod domain returns the expected content (e.g. `curl -sf https://<prod>/data/pipeline_status.json` parses and shows the new `generated_utc`); a deploy is not "done" until this passes.
- P9-S5-AC4 — Given an outward-facing or hard-to-reverse action, When about to run it, Then it is confirmed in chat first (Gate 4 rule).
**Tasks:**
- [ ] P9-S5-T1 — Add a deploy checklist to `docs/`: state rollback → confirm gate green → deploy → curl prod → report.
- [ ] P9-S5-T2 — Provide a `scripts/verify_prod.sh` that curls the prod shell, `/data/*.json`, and the live endpoint and exits non-zero on mismatch.
- [ ] P9-S5-T3 — Record the exact rollback one-liner per surface in the checklist.
**QA coverage:**
- P9-S5-AC1 → `docs/` deploy checklist + `tests/feature/deploy_config.test.mjs::rollback_documented` (unit — assert checklist present) — Planned
- P9-S5-AC2 → `docs/` deploy checklist (manual — Vercel rollback) — Planned (documented policy)
- P9-S5-AC3 → `scripts/verify_prod.sh` (smoke — post-deploy prod curl; manual/CD-triggered) — Planned
- P9-S5-AC4 → manual (chat confirmation gate) — Planned (policy)
  Coverage: 2/2 automatable covered (AC1 test, AC3 script); AC2/AC4 policy-manual by nature = 100% automatable. Test types: unit(node:test), smoke(bash), manual.
**Traceability:** new (`scripts/verify_prod.sh`, `docs/DEPLOY_CHECKLIST.md`), `netlify.toml`.

### P9-S6 — Freshness by headers, not a caching service worker   ·  Status: ✅   ·  Est: S
**As** an Analyst **I want** a deploy to reach open tabs within minutes without a stale-SW bug **so that** users never run day-old JS or score off stale data.
**Acceptance criteria** (Given/When/Then):
- P9-S6-AC1 — Given `sw.js`, When it activates, Then it installs NO `fetch` handler and deletes every `nfl26-*` cache (pure cache-purger — the wc2026 stale-shell bug cannot recur).
- P9-S6-AC2 — Given `_headers`, When serving `/app/*`, Then `Cache-Control: public, max-age=120, stale-while-revalidate=600` (short fresh, background-revalidate) so a deploy propagates in minutes.
- P9-S6-AC3 — Given `_headers`, When serving `/data/*`, Then `max-age=0, stale-while-revalidate=120` so the client never scores/displays stale results; `/index.html` and `/sw.js` are `max-age=0, must-revalidate`.
- P9-S6-AC4 — Given `_headers`, When serving the site, Then baseline security headers are present (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`).
**Tasks:**
- [ ] P9-S6-T1 — Keep `sw.js` handler-free and purge-only; never reintroduce a caching SW.
- [ ] P9-S6-T2 — Keep the `_headers` freshness matrix as specified; assert it in the gate.
- [ ] P9-S6-T3 — Assert security headers exist.
**QA coverage:**
- P9-S6-AC1 → `tests/feature/sw_purge.test.mjs::no_fetch_handler_purges_caches` (unit — parse sw.js) — Planned
- P9-S6-AC2 → `tests/feature/headers.test.mjs::app_freshness` (unit — parse _headers) — Planned
- P9-S6-AC3 → `tests/feature/headers.test.mjs::data_and_shell_freshness` (unit) — Planned
- P9-S6-AC4 → `tests/feature/headers.test.mjs::security_headers` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `sw.js`, `_headers`.

## Epic QA roll-up
Stories: 6 (S4/S6 ✅, S1/S3/S5 🟡, S2 ⬜). Every story maps ≥90% of its automatable ACs to a named test; the manual ACs (conflict-resolution policy, deploy-precondition policy, Vercel rollback command, chat-confirm gate) are policy/ops by nature and excluded from the automatable denominator. New test files: `tests/feature/{deploy_config,cron_racesafe,sw_purge,headers,live_status_gate,live_renames}.test.mjs`; new scripts: `scripts/verify_prod.sh`; new doc: `docs/DEPLOY_CHECKLIST.md`.
