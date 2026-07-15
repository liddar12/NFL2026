# N6 · Live Scores Edge
**Layer:** NFL Adapter   ·   **Status:** ⬜   ·   **Instantiates:** P5 (Pipeline & Feed Health), P9 (Deploy & Edge Runtime)
**Reuse:** A future adapter re-authors the edge handler's *source* (ESPN scoreboard for a given league), the `RENAMES` map, and the scrapers. It reuses verbatim: the STATUS-gating rule (only FINAL settles), the "edge for real-time, git pipeline for the durable record" split, the direct-source fallback pattern, and the discipline that the same normalization map is mirrored across app + edge + scrapers. The reusable seam is the contract: the edge returns display-only live state; only the durable `data/actual_results` record settles points/standings.

## Goal
Deliver real-time NFL scores through a Vercel edge function `/api/nfl` (ESPN source, direct-ESPN fallback on error) that the app polls, while the git pipeline (`data/actual_results`) remains the durable, authoritative record for scoring and standings. The edge is for latency; the pipeline is for truth. STATUS-gating is the invariant that keeps the two honest: only FINAL games settle anything; everything else is display-only.

## Why it matters / risk if skipped
Real-time is where a prediction app most easily lies: a half-time score shown as a result advances standings that then unwind, and a 0-0 pre-kick stub scored as a real 0-0 corrupts the record. GitHub `schedule:` crons are heavily throttled (a `*/15` cron fires only every few hours) — relying on cron cadence for "live" is the frozen-analytics postmortem waiting to happen, so real-time MUST come from the edge, not the cron. And a normalization map that drifts out of sync between the app, the edge, and the scrapers silently drops teams from results — the same class of silent zero-output failure the pipeline health checks exist to catch.

## User stories

### N6-S1 — `/api/nfl` edge function (ESPN source)   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** a Vercel edge function that returns current NFL scores from ESPN **so that** the app has a low-latency real-time source independent of the throttled crons.
**Acceptance criteria:**
- N6-S1-AC1 — Given `live-api/api/nfl.js`, When called, Then it returns normalized JSON per game: teams (canonical names), score, and a `status` field mapped to the STATUS enum.
- N6-S1-AC2 — Given the edge runtime, When deployed, Then it runs as a Vercel Edge Function on the `live-api` project and is reachable at the documented prod URL (verified by curl post-deploy, not assumed).
- N6-S1-AC3 — Given a cold response, When served, Then a short cache/`stale-while-revalidate` header keeps polling cheap without serving stale-as-final data.
- N6-S1-AC4 — Given the deploy, When shipped, Then the rollback is one command (`vercel rollback` / redeploy prior) and is stated before deploy (Gate 4).
**Tasks:**
- [ ] N6-S1-T1 — Author `live-api/api/nfl.js` fetching the ESPN NFL scoreboard, normalizing to the contract.
- [ ] N6-S1-T2 — Map ESPN status strings → STATUS enum (see N6-S3).
- [ ] N6-S1-T3 — Set cache headers; add a `curl` smoke against the prod endpoint.
- [ ] N6-S1-T4 — Document redeploy + rollback commands in the epic/runbook.
**QA coverage:**
- N6-S1-AC1 → `tests/feature/live_edge.test.mjs::normalized-shape` (unit, fixture ESPN payload) — Planned
- N6-S1-AC2 → `tests/smoke.sh::api-nfl-reachable` (smoke, curl prod) — Planned
- N6-S1-AC3 → `tests/feature/live_edge.test.mjs::cache-headers` (unit) — Planned
- N6-S1-AC4 → deploy runbook review (manual) — Planned
- Coverage: automatable 3/4 = 75% automated; 4/4 incl. manual runbook AC. Test types: unit(node:test) | smoke(bash) | manual.
**Traceability:** `live-api/api/nfl.js` (new), `tests/feature/live_edge.test.mjs` (new), `tests/smoke.sh`.

### N6-S2 — Direct-ESPN fallback on edge error   ·  Status: ⬜   ·  Est: S
**As** an Analyst **I want** the client to fall back to ESPN directly when `/api/nfl` errors **so that** a live view degrades to a source rather than to nothing.
**Acceptance criteria:**
- N6-S2-AC1 — Given `/api/nfl` returns non-200 or times out, When the poller runs, Then `app/live-scores.js` fetches ESPN directly using the SAME normalization + STATUS mapping.
- N6-S2-AC2 — Given both edge and direct-ESPN fail, When the poller resolves, Then the view shows the last durable `data/actual_results` value with `DATA · DEGRADED` (never a frozen "live" number).
- N6-S2-AC3 — Given the poller cadence, When active, Then it backs off on repeated errors (no tight retry loop hammering ESPN).
**Tasks:**
- [ ] N6-S2-T1 — Implement `app/live-scores.js` (fetch edge → fallback ESPN) sharing the RENAMES + STATUS map.
- [ ] N6-S2-T2 — Implement `app/live-poller.js` with interval + exponential backoff on error.
- [ ] N6-S2-T3 — Degrade path to durable record + `DATA · DEGRADED` badge.
- [ ] N6-S2-T4 — Unit tests for fallback selection + backoff.
**QA coverage:**
- N6-S2-AC1 → `tests/feature/live_fallback.test.mjs::edge-error-uses-espn` (unit) — Planned
- N6-S2-AC2 → `tests/feature/live_fallback.test.mjs::both-fail-uses-durable` (unit) — Planned
- N6-S2-AC3 → `tests/feature/live_fallback.test.mjs::backoff-on-repeated-error` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `app/live-scores.js` (new), `app/live-poller.js` (new), `data/actual_results` (new, durable record).

### N6-S3 — STATUS-gating (only FINAL settles)   ·  Status: ⬜   ·  Est: M
**As** a Modeler **I want** only FINAL games to award points/advance standings **so that** live and pre-kick states can never corrupt the durable record.
**Acceptance criteria:**
- N6-S3-AC1 — Given a game with `STATUS_FINAL` (or equivalent terminal status), When scored, Then it settles points/standings from the durable record.
- N6-S3-AC2 — Given an in-progress status (e.g. `STATUS_IN_PROGRESS`/`STATUS_HALFTIME`) or a `STATUS_SCHEDULED` 0-0 stub, When processed, Then it is DISPLAY-ONLY and awards nothing / advances nothing.
- N6-S3-AC3 — Given a live score that later flips (lead change, correction), When it is not yet FINAL, Then no standings mutation occurs until the FINAL record lands.
- N6-S3-AC4 — Given the same STATUS logic is needed in the app, the edge, and the scorer, When implemented, Then a single shared gate function is the only place that classifies FINAL vs display-only (no divergent copies).
**Tasks:**
- [ ] N6-S3-T1 — Define the terminal-status set and a shared `isFinal(status)` gate.
- [ ] N6-S3-T2 — Route all scoring/standings mutations through the gate; block on non-FINAL.
- [ ] N6-S3-T3 — Treat 0-0 `STATUS_SCHEDULED` explicitly as display-only stub.
- [ ] N6-S3-T4 — Unit-test the enum coverage incl. lead-change-before-final and 0-0 stub.
**QA coverage:**
- N6-S3-AC1 → `tests/feature/status_gate.test.mjs::final-settles` (unit) — Planned
- N6-S3-AC2 → `tests/feature/status_gate.test.mjs::live-and-scheduled-display-only` (unit) — Planned
- N6-S3-AC3 → `tests/feature/status_gate.test.mjs::no-mutation-before-final` (unit) — Planned
- N6-S3-AC4 → `tests/smoke.sh::single-status-gate-source` (smoke, grep for duplicate classifiers) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | smoke(bash).
**Traceability:** shared status gate (new, referenced by `app/live-scores.js`, `live-api/api/nfl.js`, scorer), `tests/feature/status_gate.test.mjs` (new).

### N6-S4 — Durable git-pipeline record is authoritative   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** `data/actual_results` (committed by the cron pipeline) to be the source of truth for scoring **so that** the edge's latency never becomes the system of record.
**Acceptance criteria:**
- N6-S4-AC1 — Given scoring/standings, When computed, Then they read from the durable `data/actual_results` record, never from a live edge response.
- N6-S4-AC2 — Given cron pushes that may race (concurrent commits), When merging to main, Then merges are race-safe (`git pull --ff-only`, prefer freshly generated files on data conflict).
- N6-S4-AC3 — Given the durable record, When validated, Then only FINAL rows exist in it (validate_data asserts no in-progress/0-0 stub is persisted as a result).
- N6-S4-AC4 — Given feed health, When the pipeline runs, Then a staleness/row-count assertion flags a silent zero-output run (no results committed when games were FINAL).
**Tasks:**
- [ ] N6-S4-T1 — Define `data/actual_results` contract + schema; wire into `scripts/validate_data.py`.
- [ ] N6-S4-T2 — Scorer reads durable record only; add a guard that rejects edge payloads as a scoring source.
- [ ] N6-S4-T3 — Race-safe merge procedure in the cron workflow.
- [ ] N6-S4-T4 — Staleness/row-count feed-health assertion in `scripts/pipeline_status.py`.
**QA coverage:**
- N6-S4-AC1 → `tests/feature/scoring_source.test.mjs::reads-durable-not-edge` (unit) — Planned
- N6-S4-AC2 → `tests/smoke.sh::race-safe-merge-procedure` (smoke) — Planned
- N6-S4-AC3 → `scripts/validate_data.py::actual_results_final_only` (data) — Planned
- N6-S4-AC4 → `tests/feature/feed_health.test.mjs::zero-output-flagged` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | data(validate_data) | smoke(bash).
**Traceability:** `data/actual_results` (new), `scripts/validate_data.py`, `scripts/pipeline_status.py`, `.github/workflows/*.yml`.

### N6-S5 — Team-name normalization (RENAMES kept in sync)   ·  Status: ⬜   ·  Est: S
**As** a Modeler **I want** the ESPN↔nflverse `RENAMES` map identical across app, edge, and scrapers **so that** a naming drift never silently drops a team from results.
**Acceptance criteria:**
- N6-S5-AC1 — Given the canonical `RENAMES` map, When applied, Then every ESPN team name normalizes to the nflverse canonical key used by the durable record and projections.
- N6-S5-AC2 — Given the three mirrors (`app/live-scores.js`, `live-api/api/nfl.js`, `scripts/scrape/renames.py`), When compared, Then they are byte-equivalent in mapping content (a test fails if any drifts).
- N6-S5-AC3 — Given an unmapped ESPN name, When encountered, Then it is flagged (logged/asserted) rather than silently passed through, so a new/renamed team surfaces loudly.
**Tasks:**
- [ ] N6-S5-T1 — Author the canonical map in `scripts/scrape/renames.py`; mirror in app + edge.
- [ ] N6-S5-T2 — Add a sync test that loads all three and asserts equal key/value sets.
- [ ] N6-S5-T3 — Add an "unmapped name" assertion in validate_data / feed health.
**QA coverage:**
- N6-S5-AC1 → `tests/feature/renames.test.mjs::normalizes-espn-to-canonical` (unit) — Planned
- N6-S5-AC2 → `tests/feature/renames.test.mjs::three-mirrors-in-sync` (unit) — Planned
- N6-S5-AC3 → `scripts/validate_data.py::unmapped_team_flagged` (data) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test) | data(validate_data).
**Traceability:** `scripts/scrape/renames.py` (new), `app/live-scores.js` (new), `live-api/api/nfl.js` (new).
