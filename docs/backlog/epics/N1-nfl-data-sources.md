# N1 · NFL Data Sources
**Layer:** NFL Adapter   ·   **Status:** 🟡   ·   **Instantiates:** P5 (Data Pipeline & Feed Health), P6 (JSON Contract & Frontend Data Layer)
**Reuse:** A future adapter (NBA/MLB/markets) keeps the P5/P6 contracts — guarded fetchers, `FeedError` on zero-row/stale, a single `RENAMES` source-of-truth mirrored across layers, a `RequestBudget` gate for metered APIs, and ESPN-authoritative schedule reconciliation. It re-authors only *this* file: which upstreams exist (nflverse vs a league stats API), the canonical key (`gsis_id` here), the venue/roof table, and the specific name-normalization pairs.

## Goal
Stand up the NFL data supply so every downstream model is fed real, fresh, correctly-keyed truth instead of fixtures. nflverse (`nfl_data_py`) is the canonical player record keyed on `gsis_id`; ESPN supplies schedule, live scores and injuries; The Odds API + Kalshi supply market-implied probabilities; Open-Meteo + a stadium roof table supply weather. The harness-first thesis holds: a source only counts once its rows are contract-valid, non-zero, non-stale, and reconciled — a feed that returns an empty file is treated as an outage, not as "no data".

## Why it matters / risk if skipped
Every model in N2/N3/N4 is only as honest as its inputs. The wc2026 postmortems are explicit here: silent zero-output scrapers wrote empty files that masked upstream 404s and quietly zeroed downstream scores; a drifting name-normalization map silently attached results to the wrong entity. If N1 is skipped or done loosely the whole platform produces confident, wrong numbers — the worst failure mode. Row-count and staleness assertions, a mirrored `RENAMES`, and a request budget are the guardrails that turn a silent-wrong pipeline into a loud-fail one.

## User stories

### N1-S1 — nflverse canonical player feed (gsis_id)   ·  Status: 🟡   ·  Est: L
**As** the System/Automation actor **I want** weekly stats, rosters, depth charts, snap counts and contracts pulled from nflverse and keyed on `gsis_id` **so that** every player-side model joins on one stable canonical key instead of fragile name matching.
**Acceptance criteria** (Given/When/Then):
- N1-S1-AC1 — Given a clean box with no `nfl_data_py` installed, When `scripts/scrape/nflverse.py` is imported, Then import succeeds (the heavy dep is imported inside each fetcher, never at module top-level) and only calling a fetcher raises `FeedError` with an actionable install line.
- N1-S1-AC2 — Given a fetcher returns 0 rows for a season/week, When it completes, Then it raises `FeedError` (row-count assertion) rather than writing an empty file — the silent-scraper lesson.
- N1-S1-AC3 — Given a returned frame whose newest row is older than the caller-supplied staleness bound, When validated, Then it raises `FeedError` (staleness assertion) so a stuck mirror cannot serve last month's snap counts.
- N1-S1-AC4 — Given any fetcher return value, When inspected, Then it is a plain `list[dict]` records payload (never a DataFrame) and every record carries a non-null `gsis_id`.
**Tasks:**
- [ ] N1-S1-T1 — Wrap `import nfl_data_py` in a guarded `_require_nfl_data_py()` helper raising `FeedError`.
- [ ] N1-S1-T2 — Implement weekly-stats, rosters, depth-charts, snap-counts, contracts fetchers returning records.
- [ ] N1-S1-T3 — Add row-count assertion (0 rows → `FeedError`) to every fetcher.
- [ ] N1-S1-T4 — Add staleness assertion against a caller-supplied max-age bound.
- [ ] N1-S1-T5 — Assert `gsis_id` present + non-null on every record; drop/raise otherwise.
- [ ] N1-S1-T6 — DataFrame→records reduction so no pandas type escapes the module.
**QA coverage:**
- N1-S1-AC1 → `tests/feature/nflverse_feed.test.mjs::imports_without_dep` (unit) — Planned
- N1-S1-AC2 → `tests/feature/nflverse_feed.test.mjs::zero_rows_raises` (unit) — Planned
- N1-S1-AC3 → `tests/feature/nflverse_feed.test.mjs::stale_frame_raises` (unit) — Planned
- N1-S1-AC4 → `scripts/validate_data.py::players_have_gsis_id` (data) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/scrape/nflverse.py`, `data/contracts/player_projections.schema.json`, `scripts/validate_data.py`.

### N1-S2 — ESPN schedule / scores / injuries with STATUS-gating   ·  Status: 🟡   ·  Est: M
**As** the System/Automation actor **I want** ESPN's public JSON for schedule, live scores and injuries **so that** the game/live layer has kickoff times, in-flight scores, and injury status without an API key.
**Acceptance criteria** (Given/When/Then):
- N1-S2-AC1 — Given an ESPN game payload, When ingested, Then only `STATUS_FINAL` / `STATUS_FINAL_OVERTIME` records are eligible to become actual results; every other status (in-progress, halftime, scheduled, postponed, 0-0 `STATUS_SCHEDULED` stubs) is flagged display-only and can never award points or advance standings.
- N1-S2-AC2 — Given `requests` is absent on the gate box, When `scripts/scrape/espn.py` is imported, Then import succeeds (requests imported inside each function, guarded).
- N1-S2-AC3 — Given an injuries pull, When written, Then each row carries a `gsis_id` (or is reconciled to one via `renames.py`) so injury status joins the canonical player feed.
**Tasks:**
- [ ] N1-S2-T1 — Schedule fetcher → `kickoff_utc` per game.
- [ ] N1-S2-T2 — Scores fetcher with an explicit FINAL-status allowlist constant.
- [ ] N1-S2-T3 — Injuries fetcher normalized to `gsis_id`.
- [ ] N1-S2-T4 — Tag non-final records `display_only=true`; assert they never enter the results path.
- [ ] N1-S2-T5 — Guarded in-function `requests` import.
**QA coverage:**
- N1-S2-AC1 → `tests/feature/espn_status_gating.test.mjs::only_final_scores` (unit) — Planned
- N1-S2-AC2 → `tests/feature/espn_status_gating.test.mjs::imports_without_requests` (unit) — Planned
- N1-S2-AC3 → `scripts/validate_data.py::injuries_keyed_on_gsis` (data) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/scrape/espn.py`, `scripts/scrape/renames.py`, `scripts/validate_data.py`.

### N1-S3 — Betting markets (The Odds API + Kalshi) under a request budget   ·  Status: 🟡   ·  Est: M
**As** the Operator **I want** market prices turned into clean implied probabilities under an enforced free-tier budget **so that** markets act as a first-class model input without silently blowing the monthly quota.
**Acceptance criteria** (Given/When/Then):
- N1-S3-AC1 — Given a `RequestBudget` with a per-day and per-minute cap, When a call would exceed either cap, Then the call is refused loudly (raises) before the HTTP request fires — never a silent degrade.
- N1-S3-AC2 — Given raw two-way American/decimal odds, When converted, Then the emitted implied probabilities are vig-adjusted and the two sides sum to 1.0 within 1e-6.
- N1-S3-AC3 — Given a successful call, When it returns, Then the budget is decremented and the remaining count is observable (for `pipeline_status`).
- N1-S3-AC4 — Given Kalshi and The Odds API for the same game, When both present, Then each is tagged by source so the game model can weight them independently.
**Tasks:**
- [ ] N1-S3-T1 — `RequestBudget` gate (calls/day, calls/min) threaded through every fetcher.
- [ ] N1-S3-T2 — Odds→implied-probability conversion with vig removal, normalized to sum 1.
- [ ] N1-S3-T3 — Kalshi fetcher (also budgeted) → implied probabilities.
- [ ] N1-S3-T4 — Source-tag each price; expose remaining budget to `pipeline_status.py`.
- [ ] N1-S3-T5 — Guarded in-function `requests` import.
**QA coverage:**
- N1-S3-AC1 → `tests/feature/odds_budget.test.mjs::refuses_over_cap` (unit) — Planned
- N1-S3-AC2 → `tests/feature/odds_budget.test.mjs::vig_removed_sums_to_one` (unit) — Planned
- N1-S3-AC3 → `tests/feature/odds_budget.test.mjs::decrements_budget` (unit) — Planned
- N1-S3-AC4 → `tests/feature/odds_budget.test.mjs::source_tagged` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/scrape/odds.py`, `scripts/pipeline_status.py`, `data/pipeline_status.json`.

### N1-S4 — Weather + stadium roof metadata   ·  Status: 🟡   ·  Est: S
**As** the Modeler **I want** Open-Meteo forecasts joined to a stadium roof table **so that** the weather signal fires only for outdoor / open-retractable games and is neutral indoors.
**Acceptance criteria** (Given/When/Then):
- N1-S4-AC1 — Given a team playing in a fixed-roof (indoor) venue, When weather is resolved, Then the weather signal is neutral (no wind/temp/precip effect) — roof state comes from `data/fixtures/teams.json`, not from the fetcher.
- N1-S4-AC2 — Given a coordinate + target kickoff hour, When Open-Meteo is queried, Then the keyless request returns wind/temp/precip reduced to plain numbers and the reduction function is pure (importable anywhere, no network).
- N1-S4-AC3 — Given every team in `teams.json`, When validated, Then each has a `roof` value in the known enum (`open`/`dome`/`retractable`) and a lat/lon.
**Tasks:**
- [ ] N1-S4-T1 — Open-Meteo fetch for (lat, lon, hour); guarded `requests` import.
- [ ] N1-S4-T2 — Pure forecast→number reduction split from the network call.
- [ ] N1-S4-T3 — `roof_for_team` lookup against `teams.json`; indoor → neutral.
- [ ] N1-S4-T4 — Validate `roof` enum + coordinates for all 32 teams.
**QA coverage:**
- N1-S4-AC1 → `tests/feature/weather_roof.test.mjs::indoor_is_neutral` (unit) — Planned
- N1-S4-AC2 → `tests/feature/weather_roof.test.mjs::pure_reduction` (unit) — Planned
- N1-S4-AC3 → `scripts/validate_data.py::teams_roof_enum` (data) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/scrape/weather_fetch.py`, `scripts/signals/weather.py`, `data/fixtures/teams.json`, `scripts/validate_data.py`.

### N1-S5 — Name normalization: single source, mirrored across layers   ·  Status: 🟡   ·  Est: S
**As** the System/Automation actor **I want** one `RENAMES` map in Python byte-mirrored into the JS layer **so that** ESPN and nflverse spellings never drift apart and attach results to the wrong entity.
**Acceptance criteria** (Given/When/Then):
- N1-S5-AC1 — Given `scripts/scrape/renames.py` as the single Python source of truth, When the JS `RENAMES` in `app/live-scores.js` is diffed against it, Then the two are byte-equivalent (a failing diff blocks the gate).
- N1-S5-AC2 — Given an ESPN team abbreviation or player-name-with-suffix, When normalized, Then it maps to the canonical nflverse form and the mapping is idempotent (applying twice == once).
**Tasks:**
- [ ] N1-S5-T1 — Author `RENAMES` team + player pairs in `renames.py`.
- [ ] N1-S5-T2 — Mirror identical `RENAMES` object into `app/live-scores.js`.
- [ ] N1-S5-T3 — Cross-layer diff test that fails on drift.
- [ ] N1-S5-T4 — Idempotence assertion on the normalizer.
**QA coverage:**
- N1-S5-AC1 → `tests/feature/renames_sync.test.mjs::py_js_byte_equivalent` (unit) — Planned
- N1-S5-AC2 → `tests/feature/renames_sync.test.mjs::normalize_idempotent` (unit) — Planned
- Coverage: 2/2 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/scrape/renames.py`, `app/live-scores.js`.

### N1-S6 — Schedule reconciliation (ESPN-authoritative kickoff_utc)   ·  Status: 🟡   ·  Est: M
**As** the System/Automation actor **I want** cron-committed kickoff times reconciled against ESPN **so that** date drift in the schedule can't misfile a game to the wrong day/week.
**Acceptance criteria** (Given/When/Then):
- N1-S6-AC1 — Given a stored `kickoff_utc` that disagrees with ESPN for the same game id, When reconciliation runs, Then ESPN wins and the corrected `kickoff_utc` is written with a minimal diff (no cosmetic churn to unrelated rows).
- N1-S6-AC2 — Given reconciliation runs on cron alongside other committers, When it pushes, Then the merge is race-safe (`git pull --ff-only`, merge, push; prefer freshly generated files on data conflict).
**Tasks:**
- [ ] N1-S6-T1 — Reconciler comparing stored vs ESPN `kickoff_utc` by game id.
- [ ] N1-S6-T2 — ESPN-authoritative overwrite with minimal-diff writer.
- [ ] N1-S6-T3 — Race-safe push sequence in the cron wrapper.
**QA coverage:**
- N1-S6-AC1 → `tests/feature/schedule_reconcile.test.mjs::espn_wins_on_drift` (unit) — Planned
- N1-S6-AC2 → `tests/smoke.sh::race_safe_merge` (smoke) — Planned
- Coverage: 2/2 = 100%. Test types: unit(node:test), smoke(bash).
**Traceability:** `scripts/scrape/espn.py`, `.github/workflows/daily.yml`, `.github/workflows/gameday.yml`.
