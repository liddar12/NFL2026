# P5 · Data Pipeline & Feed Health
**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter (NBA/MLB/Kalshi) reuses the whole shape — scrapers → per-signal compute → model builders → versioned JSON in `data/`, the loud row-count/staleness assertions, and `pipeline_status.py`'s worst-of health roll-up — and only re-authors the concrete feed list in `FEED_SPECS` and the per-sport scrapers under `scripts/scrape/`.

## Goal
Guarantee that the durable data record under `data/` is only ever overwritten by a feed that provably pulled real, fresh, complete rows. Every feed asserts a minimum row count and a maximum age and fails LOUDLY; a run that cannot prove it pulled good data aborts rather than committing an empty or stale file. `pipeline_status.json` gives one honest, machine-checkable health view — it is allowed to say "degraded" — so a human sees red instead of trusting a silent zero. This is the substrate the evaluation harness and models sit on: garbage or frozen inputs make every downstream metric a lie.

## Why it matters / risk if skipped
The silent-zero-output-scraper postmortem (inherited from wc2026): a scraper 404'd, returned `[]`, and the pipeline happily wrote a 0-row file over good data — leaderboards and projections silently emptied and nobody noticed for a day. Second failure mode is frozen analytics: a stuck upstream mirror serves last week's snap counts, every row parses, schema passes, and the model quietly trains on dead data. Both are invisible to schema validation alone. This epic makes both impossible to commit silently: zero rows is always `down`, staleness past a per-feed bound is `stale`/`down`, and an upstream signal that does not move game-to-game is caught before it reaches a weight.

## User stories

### P5-S1 — Loud row-count + staleness assertions on every scraper   ·  Status: 🟡   ·  Est: M
**As** an Operator **I want** every feed to refuse to return a short or stale pull **so that** a bad upstream aborts the run instead of overwriting good data with an empty/old file.
**Acceptance criteria** (Given/When/Then):
- P5-S1-AC1 — Given a fetcher whose upstream returns fewer than its `min_rows` (e.g. nflverse rosters < 1500), When it runs, Then it raises `FeedError` and writes nothing (no partial file on disk).
- P5-S1-AC2 — Given a fetcher whose newest dated row is older than `max_age_days`, When it runs, Then it raises `FeedError` naming the newest date and the bound (frozen-mirror guard).
- P5-S1-AC3 — Given a feed with rows but no parseable date field, When freshness is checked, Then it is treated as a failure (`FeedError`), never as "fresh by default".
- P5-S1-AC4 — Given the heavy dep `nfl_data_py` is absent, When the module is imported (as the gate does), Then import succeeds and the error only surfaces on an actual fetch call (in-function guarded import).
**Tasks:**
- [ ] P5-S1-T1 — Keep `_assert_rows` / `_assert_fresh` as the single choke point every fetcher calls; no fetcher returns records without both.
- [ ] P5-S1-T2 — Audit `scripts/scrape/{nflverse,espn,odds,weather_fetch}.py` so each fetcher passes an explicit `min_rows`/`max_age_days` matching that feed's cadence.
- [ ] P5-S1-T3 — Ensure every heavy import stays inside the function (zero-dep gate rule).
- [ ] P5-S1-T4 — Unit-test the short-pull, stale-pull, and no-date paths with pinned `as_of`.
- [ ] P5-S1-T5 — Assert no file is written on the failure path (raise before any write).
**QA coverage:**
- P5-S1-AC1 → `tests/feature/pipeline_scrape.test.mjs::short_pull_raises` (unit, shells to python) — Planned
- P5-S1-AC2 → `tests/feature/pipeline_scrape.test.mjs::stale_pull_raises` (unit) — Planned
- P5-S1-AC3 → `tests/feature/pipeline_scrape.test.mjs::no_date_raises` (unit) — Planned
- P5-S1-AC4 → `tests/smoke.sh::imports` (smoke — module imports with no pip) — Done
  Coverage: 4/4 = 100%. Test types: unit(node:test→python), smoke(bash).
**Traceability:** `scripts/scrape/nflverse.py`, `scripts/scrape/espn.py`, `scripts/scrape/odds.py`, `scripts/scrape/weather_fetch.py`.

### P5-S2 — No continue-on-error may mask a zero write   ·  Status: 🟡   ·  Est: S
**As** an Operator **I want** the pipeline job to abort on a feed failure **so that** `|| true` can never turn a 0-row scrape into a green commit.
**Acceptance criteria** (Given/When/Then):
- P5-S2-AC1 — Given a scraper step in `daily.yml`/`gameday.yml`, When it exits non-zero, Then the job fails and does not reach the commit step (no `continue-on-error: true`, no unconditional `|| true` on a real scraper).
- P5-S2-AC2 — Given the current scaffold uses `python -m scripts.scrape.*_cli || true` placeholders, When those CLIs are wired at Gate 2, Then the `|| true` is removed as part of the same change (tracked here, not forgotten).
- P5-S2-AC3 — Given `pipeline_status.py` reports overall `health == "down"`, When it runs in a cron, Then it exits non-zero (exit 2) so the job surfaces red.
**Tasks:**
- [ ] P5-S2-T1 — Grep both workflows for `continue-on-error` and `|| true`; document each surviving instance as a known Gate-2 placeholder with a removal owner.
- [ ] P5-S2-T2 — On real-CLI wiring, delete the placeholder `|| true` and let a 0-row scrape fail the job.
- [ ] P5-S2-T3 — Keep `main()`'s `return 2 if health == "down"` contract and cover it in a test.
**QA coverage:**
- P5-S2-AC1 → `tests/feature/workflow_guards.test.mjs::no_masking_true` (unit — parse yml, assert no masking on scraper steps) — Planned
- P5-S2-AC2 → manual (Gate-2 wiring review) — Planned (counts toward story: 2 of 3 ACs automatable)
- P5-S2-AC3 → `tests/feature/pipeline_status.test.mjs::down_exits_2` (unit, shells to python) — Planned
  Coverage: 2/3 automatable ACs covered = 67% automatable; 3/3 addressed. Test types: unit(node:test), manual.

> Note: this story's automatable ACs (AC1, AC3) are both covered; AC2 is a manual wiring gate by nature. Story-level automatable coverage = 2/2 = 100%.
**Traceability:** `.github/workflows/daily.yml`, `.github/workflows/gameday.yml`, `scripts/pipeline_status.py`.

### P5-S3 — `pipeline_status.json` tracks per-feed rows/age/last_success/status   ·  Status: 🟡   ·  Est: M
**As** an Operator **I want** one file that records, per feed, `rows`, `age_hours`, `last_success_utc`, and a `status` in {ok, stale, degraded, down} **so that** feed health is inspectable at a glance and by tests.
**Acceptance criteria** (Given/When/Then):
- P5-S3-AC1 — Given observations `{feed: {rows, last_success_utc}}` and an `as_of`, When `compute_status` runs, Then each feed's `status` follows the exact decision order: never-succeeded-or-0-rows → `down`; age > `down_hours` → `down`; rows < `min_rows` → `degraded`; age > `stale_hours` → `stale`; else `ok`.
- P5-S3-AC2 — Given a feed with `rows == 0` but a recent `last_success_utc`, When scored, Then status is `down` (silent-zero is the cardinal sin — never `ok`).
- P5-S3-AC3 — Given no observations file at all, When `main()` runs, Then every known feed is emitted `down`/0 rows (an empty monitor is a failure, not a clean bill of health).
- P5-S3-AC4 — Given the written file, When validated against `data/contracts/pipeline_status.schema.json`, Then it passes (required keys, `rows>=0`, `status` enum, `additionalProperties:false`).
**Tasks:**
- [ ] P5-S3-T1 — Keep `evaluate_feed`/`compute_status`/`write_status` deterministic with injectable `as_of` (no wall-clock in scored logic).
- [ ] P5-S3-T2 — Emit canonical JSON (ensure_ascii, indent=2, sort_keys, trailing newline) for minimal diffs.
- [ ] P5-S3-T3 — Reconcile `FEED_SPECS` keys (`nflverse_weekly`, `espn_scores`, …) with the feed names actually written to `data/pipeline_status.json` (`nflverse`, `injuries`, `polymarket`) so specs apply to real feeds — see P5-S4.
- [ ] P5-S3-T4 — Cover the boundary rows/age cases with pinned-clock unit tests.
**QA coverage:**
- P5-S3-AC1 → `tests/feature/pipeline_status.test.mjs::decision_order` (unit, pinned as_of) — Planned
- P5-S3-AC2 → `tests/feature/pipeline_status.test.mjs::zero_rows_is_down` (unit) — Planned
- P5-S3-AC3 → `tests/feature/pipeline_status.test.mjs::empty_monitor_all_down` (unit) — Planned
- P5-S3-AC4 → `scripts/validate_data.py` (data — schema check of pipeline_status.json) — Done
  Coverage: 4/4 = 100%. Test types: unit(node:test→python), data(validate_data).
**Traceability:** `scripts/pipeline_status.py`, `data/pipeline_status.json`, `data/contracts/pipeline_status.schema.json`.

### P5-S4 — Honest overall health = worst feed (may report "degraded")   ·  Status: ✅   ·  Est: S
**As** an Analyst **I want** the top-level `health` to equal the worst feed's status **so that** the pipeline can never claim "ok" while a feed is broken.
**Acceptance criteria** (Given/When/Then):
- P5-S4-AC1 — Given feeds with mixed statuses, When health is rolled up, Then `health` equals the worst-of via severity ok<stale<degraded<down.
- P5-S4-AC2 — Given a committed `pipeline_status.json` whose `health` does not equal its worst feed, When `validate_data.py` runs, Then it exits 1 with a "dishonest health" message (`check_pipeline_health`).
- P5-S4-AC3 — Given the shipped example file, When inspected, Then `health` is honestly `degraded` (not `ok`) and at least one feed is non-ok (smoke enforces this).
**Tasks:**
- [ ] P5-S4-T1 — Keep the severity map single-sourced across `pipeline_status.py` and `validate_data.py`.
- [ ] P5-S4-T2 — Keep the honesty invariant in the gate so a dishonest hand-edit fails CI.
**QA coverage:**
- P5-S4-AC1 → `tests/feature/pipeline_status.test.mjs::health_is_worst_of` (unit) — Planned
- P5-S4-AC2 → `scripts/validate_data.py::check_pipeline_health` exercised by `tests/feature/validate_data.test.mjs::dishonest_health_fails` (data/unit) — Planned
- P5-S4-AC3 → `tests/smoke.sh` (smoke — asserts health != "ok" and a non-ok feed exists) — Done
  Coverage: 3/3 = 100%. Test types: unit(node:test), data(validate_data), smoke(bash).
**Traceability:** `scripts/pipeline_status.py`, `scripts/validate_data.py`, `data/pipeline_status.json`, `tests/smoke.sh`.

### P5-S5 — Frozen-analytics guard: every upstream signal must move game-to-game   ·  Status: ⬜   ·  Est: M
**As** a Modeler **I want** a check that each upstream signal actually varies across games/weeks **so that** a stuck feed serving constant values can't masquerade as a live signal.
**Acceptance criteria** (Given/When/Then):
- P5-S5-AC1 — Given a signal's values across the current slate, When variance is computed, Then a signal that is constant (zero variance) across all games is flagged as `frozen` unless it is explicitly declared constant.
- P5-S5-AC2 — Given two consecutive pipeline snapshots, When compared, Then a feed whose entire payload is byte-identical to the prior run despite an advanced `as_of` is flagged (stuck-mirror detection beyond staleness).
- P5-S5-AC3 — Given a flagged frozen signal, When the pipeline reports, Then the owning feed's status is at worst `degraded` and the flag is surfaced (not silently `ok`).
**Tasks:**
- [ ] P5-S5-T1 — Add a `frozen_guard` pass (stdlib) computing per-signal variance across the slate.
- [ ] P5-S5-T2 — Maintain an allow-list of legitimately-constant signals (e.g. dome team roof) to avoid false positives.
- [ ] P5-S5-T3 — Snapshot-diff consecutive runs to catch identical payloads with a moved clock.
- [ ] P5-S5-T4 — Wire the flag into feed status roll-up (frozen → degraded).
**QA coverage:**
- P5-S5-AC1 → `tests/feature/frozen_guard.test.mjs::constant_signal_flagged` (unit) — Planned
- P5-S5-AC2 → `tests/feature/frozen_guard.test.mjs::identical_payload_flagged` (unit) — Planned
- P5-S5-AC3 → `tests/feature/frozen_guard.test.mjs::frozen_degrades_feed` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** new (`scripts/pipeline/frozen_guard.py`), consumes `data/snapshots/*`, feeds `scripts/pipeline_status.py`.

### P5-S6 — Deterministic, canonical, minimal-diff pipeline writes   ·  Status: 🟡   ·  Est: S
**As** an Operator **I want** every pipeline write to be deterministic and byte-stable **so that** git diffs reflect real data change, not formatting churn, and race-safe merges stay clean.
**Acceptance criteria** (Given/When/Then):
- P5-S6-AC1 — Given identical inputs and a pinned `as_of`, When the pipeline runs twice, Then all `data/*.json` outputs are byte-identical.
- P5-S6-AC2 — Given any pipeline write, When inspected, Then it uses `ensure_ascii=True`, `indent=2`, `sort_keys=True`, and a trailing newline (matches on-disk convention).
- P5-S6-AC3 — Given a re-run with no data change, When committed, Then `git diff --cached` is empty (the workflow's "no changes to commit" path is hit).
**Tasks:**
- [ ] P5-S6-T1 — Route every writer through a shared canonical-JSON dump helper.
- [ ] P5-S6-T2 — Ban wall-clock reads in scored logic; thread `as_of` everywhere.
- [ ] P5-S6-T3 — Add a determinism test that runs a builder twice and diffs bytes.
**QA coverage:**
- P5-S6-AC1 → `tests/feature/determinism.test.mjs::pipeline_byte_stable` (unit) — Planned
- P5-S6-AC2 → `tests/smoke.sh::parses` + `scripts/validate_data.py` (smoke/data — all JSON parses & validates) — Done
- P5-S6-AC3 → `tests/feature/determinism.test.mjs::no_change_empty_diff` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test), smoke(bash), data(validate_data).
**Traceability:** `scripts/pipeline_status.py` (`write_status`), `scripts/build_all.py`, `data/*.json`.

## Epic QA roll-up
Stories: 6. Automatable-AC coverage across the epic ≥ 90% (every story maps ≥90% of its automatable ACs to a named test; the single manual AC, P5-S2-AC2, is a Gate-2 wiring review by nature). New test files introduced by this epic: `tests/feature/{pipeline_status,pipeline_scrape,workflow_guards,frozen_guard,determinism,validate_data}.test.mjs`.
