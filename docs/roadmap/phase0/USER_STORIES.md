# Phase 0 — Rest-of-Season (RoS) Value: Epics, User Stories & Tasks

Owner: Product Analyst · Status: BACKLOG (Gate 3) · Derived from
[`SOLUTION_DESIGN.md`](./SOLUTION_DESIGN.md) (the single source of truth; supersedes
ARCHITECTURE / TECH / UX where they disagree).

Scope: the rest-of-season value engine (`app/ros.js`), its data contract
(`data/ros_value.json`), the app surface (route `#/ros`, view, chip), the
self-learning never-regress feedback loop (`scripts/optimize_ros.py`), and the
season-rank backtest — all as **spec-to-implement**.

## Load-bearing precondition (read first)

The NFL2026 substrate named in the brief is **absent from this checkout** (this is
the WC26 soccer tree). No RoS code and no backtest can run until it is provisioned.
Epic 0 owns that blocker; every downstream story that consumes NFL data carries a
`BLOCKED-BY: E0` marker and its acceptance criteria are verified against **fixtures**
until real data lands. Stories that are pure-logic, schema, or scaffolding (engine
math with injected data, schema shape, route wiring, CSS) are **buildable now**
against fixtures and are marked `BUILDABLE-NOW`.

Legend for acceptance criteria: each AC is written to be mechanically checkable
(a test asserts it). Coverage target ≥90% QA-able per story is met by making every
AC map to a named test file in the regression gate.

---

## EPIC 0 — Substrate provisioning & guardrails (the blocker)

**Goal:** unblock the RoS work by provisioning the NFL data surface (or explicit
fixtures) and locking a honesty guardrail so no story silently ships fabricated data.

### US-0.1 — Provision NFL input data (or fixtures)
As the tech lead, I want the NFL input files present (or fixtures standing in for
them) so the engine, contract, and backtest have real inputs to consume.

Acceptance criteria:
- AC1: `data/player_projections.json`, `data/player_weekly.json`,
  `data/team_strength.json`, `data/player_usage_history.json`,
  `data/injury_history.json`, `data/player_history.json` each exist and parse as JSON.
- AC2: When any file is absent, the build step **loud-skips** with a non-zero exit
  and a named-file message — never a silent empty output (asserted by a
  missing-file test).
- AC3: If real data is unavailable, committed fixtures under `data/fixtures/`
  (or `tests/fixtures/`) supply the same shapes and are labeled `source:"fixture"`.
- AC4: A manifest test enumerates the six required paths and fails listing exactly
  which are missing.

Tasks:
- T1: Add `data/fixtures/` with minimal valid fixtures for each of the six inputs.
- T2: Write `tests/feature/substrate-manifest.test.mjs` enumerating required paths.
- T3: Reconcile brief paths against the real NFL2026 repo; document deltas in `SOLUTION_DESIGN.md §0`.

### US-0.2 — Honest-data guardrail (loud-skip contract)
As the data owner, I want a single enforced rule that null core values require a
reason and empty feeds fail in strict mode, so honesty is not left to convention.

Acceptance criteria:
- AC1: `scripts/validate_data.py` gains `check_ros_value()` invoked in the main gate.
- AC2: Any null core value (`ros_points`/`floor`/`ceil`/`ros_vor`/`ros_value`) without
  a non-empty `reason` is a HARD error (exit non-zero).
- AC3: Empty `players` map is warn-only by default, HARD error under `--strict`
  (the cron gate), mirroring existing `check_feed_emptiness`.
- AC4: Market / odds / price fields anywhere in `ros_value.json` are a HARD error
  (structurally excluded by rule, not just by omission).

Tasks:
- T1: Implement `check_ros_value()` reading the schema.
- T2: Wire `--strict` propagation from the cron entrypoint.
- T3: Add negative fixtures (null-without-reason, empty players, stray price field).

---

## EPIC 1 — RoS pure engine (`app/ros.js`)

**Goal:** a DOM-free, fetch-free, deterministic engine that computes rest-of-season
value from injected data, mirroring the `app/lib/win-prob.js` pure idiom, with
pre-tuning weights = 0 so output equals raw remaining-projection sums exactly.

### US-1.1 — Remaining-weeks resolution
As a consumer of the engine, I want `weeksRemaining(playerId, inputs)` to return the
list of upcoming playable weeks (bye excluded) so all downstream math sums the right set.

Acceptance criteria:
- AC1: Returns an ascending `number[]` of weeks `>= inputs.fromWeek`, bye week excluded.
- AC2: `fromWeek` outside `1..18` throws (fail-loud, not clamp).
- AC3: A player with no remaining weeks returns `[]` (not null, not error).
- AC4: Deterministic — same inputs return an equal array across repeated calls.

Tasks: T1 implement; T2 unit tests for bye exclusion, boundary weeks, empty tail.

### US-1.2 — Per-player RoS projection with floor/median/ceil
As a consumer, I want `rosProject(playerId, inputs)` to return summed remaining points
with a per-week breakdown and range, or a null+reason when data is missing.

Acceptance criteria:
- AC1: Returns `{ rosPoints, perWeek:[{week,pts,floor,ceil}], byeWeek, gamesLeft, reason? }`.
- AC2: With no weekly row for the player, `rosPoints` is `null` **and** `reason` is a
  non-empty string — never a fabricated 0.
- AC3: When all non-null, `floor <= rosPoints <= ceil` holds.
- AC4: `gamesLeft === weeksRemaining(...).length` and `byeWeek` matches the weekly data.
- AC5: Per-week `adj = base_wk * (1 + SOS_W*(m_wk-1)) * (1 - AVAIL_W*(1-a_wk))`; with
  pre-tuning `SOS_W = AVAIL_W = 0`, `rosPoints` equals the raw sum of remaining base
  projections **exactly** (regression-locked equality, not approximate).

Tasks: T1 implement math; T2 null-safety path; T3 zero-weight equality regression test.

### US-1.3 — Replacement level & VOR
As a consumer, I want `replacementLevel(position, inputs)` and `rosVOR(playerId, inputs)`
so value is expressed above a positional baseline, not as raw points.

Acceptance criteria:
- AC1: `replacementLevel` returns a finite number per position `{QB,RB,WR,TE}`.
- AC2: `rosVOR = rosPoints - replacementLevel(pos)`, or `null` (with reason) when
  `rosPoints` is null.
- AC3: Replacement baseline is deterministic and position-stratified (QB baseline never
  leaks into RB math).
- AC4: Changing `fromWeek` recomputes replacement from remaining weeks only.

Tasks: T1 implement; T2 stratification test; T3 null-propagation test.

### US-1.4 — Position-stratified deterministic ranking
As a view, I want `rankByRos(playerIds, inputs)` to return stable ordered rows
stratified by position so the UI can render ladders without re-sorting nondeterministically.

Acceptance criteria:
- AC1: Output is grouped/ordered by position then by descending value.
- AC2: Ties break by a stable key (player_id) so order is deterministic across runs.
- AC3: Null-value players sort to a designated bucket (bottom, tagged), never interleaved
  as if zero.
- AC4: Output length equals input length (no silent drops).

Tasks: T1 implement stable sort; T2 tie-break test; T3 null-bucket test.

### US-1.5 — Range and self-test
As the tech lead, I want `rosRange(playerId, inputs)` and `__selftest()` so the engine
proves its own determinism and null-safety with no I/O.

Acceptance criteria:
- AC1: `rosRange` returns `{floor, ceil}` with `floor <= ceil` when non-null.
- AC2: `__selftest()` recomputes a fixed input vector and returns `true`, or throws on
  any determinism / null-safety violation — performs **no** fetch/DOM/file I/O.
- AC3: `ros.js` has **no** top-level DOM or fetch reference (import-time purity asserted).
- AC4: No market/price parameter exists anywhere in the module surface (grep-asserted).

Tasks: T1 implement; T2 purity/no-I/O test; T3 price-field-absence test.

---

## EPIC 2 — Authoritative data contract (`data/ros_value.json`)

**Goal:** one schema-validated feed shape (players-as-map, `__meta__`,
null-requires-reason) that satisfies every UX consumer and rides the same validation
rail as the other derived feeds.

### US-2.1 — Schema definition
As the data owner, I want `data/contracts/ros_value.schema.json` defining the one true
shape so builder and validator cannot diverge.

Acceptance criteria:
- AC1: `__meta__` requires `generated_at` (ISO-8601), `from_week` (int 1..18),
  `params_version`, `source`.
- AC2: `players` is a **map** keyed by `player_id` → `{pos, team, games_left, bye_week,
  ros_points, floor, ceil, ros_vor, ros_value, sos_factor_mean, avail_prob_mean,
  confidence, reason}`.
- AC3: `replacement_by_pos` requires keys `{QB,RB,WR,TE}`.
- AC4: Schema **forbids** any market/odds/price property (`additionalProperties:false`
  at the player level, or an explicit deny-test).

Tasks: T1 author schema; T2 schema self-validation test.

### US-2.2 — Contract invariants enforced
As the data owner, I want the invariants hard-enforced in `validate_data.py` so bad
feeds fail the gate.

Acceptance criteria:
- AC1: `floor <= ros_points <= ceil` when all three non-null.
- AC2: Any null core value ⇒ non-empty `reason` (else HARD error).
- AC3: `from_week` in `1..18` else HARD error.
- AC4: Empty `players` warn-only default, HARD under `--strict`.
- AC5: `check_ros_value()` gates on **exit code**, not on grepping colored output.

Tasks: T1 implement invariants; T2 positive+negative fixtures; T3 exit-code gate test.

### US-2.3 — Client-side what-if purity
As a power user, I want the engine able to recompute values in the browser from the
same injected inputs (compute-live / cache-durable pattern) so a what-if never needs
a server round-trip.

Acceptance criteria:
- AC1: `renderRosView` can be handed engine-computed data OR the loaded
  `ros_value.json` and render identically for equal inputs.
- AC2: No network fetch is required to recompute once inputs are in memory.
- AC3: Recomputed client values match the committed feed within a locked tolerance
  for the same params_version.

Tasks: T1 wire injected-recompute path; T2 parity test feed-vs-recompute.

---

## EPIC 3 — Offline builder (`scripts/build_ros_value.py`)

**Goal:** the stdlib-only producer that writes `data/ros_value.json` plus a locked
snapshot, honoring on-disk encoding and atomic writes. `BLOCKED-BY: E0`.

### US-3.1 — Build the feed
As the pipeline, I want `build_ros_value.py` to produce a schema-valid feed from the
NFL inputs so the app has data to load.

Acceptance criteria:
- AC1: Output validates against `ros_value.schema.json`.
- AC2: `from_week` = first unplayed week, computed (not hardcoded).
- AC3: Written `ensure_ascii=True`, atomic `tmp + os.replace`.
- AC4: `params_version` = sha of `model_tuning game_params.ros`.
- AC5: Players with missing weekly rows are emitted with null core + reason, not dropped.

Tasks: T1 implement builder; T2 golden-fixture output test; T3 atomicity/encoding test.

### US-3.2 — Locked pre-kickoff snapshot
As the self-learning loop, I want the builder to also write a locked snapshot at build
week W (prior-week data only) so a graded lock can be scored later.

Acceptance criteria:
- AC1: Snapshot captures inputs-as-of-W and the produced ranking, immutable after write.
- AC2: Snapshot filename/key encodes week W and params_version.
- AC3: No season-W-and-later signal leaks into a week-W snapshot (as-of purity test).

Tasks: T1 implement snapshot write; T2 leakage test; T3 immutability test.

---

## EPIC 4 — App surface (route `#/ros`, view, chip)

**Goal:** an isolated, collision-safe route rendering the RoS ladder with a chip strip,
thumb-first at 402px and two-up at 1032px (13" iPad primary), using only existing
tokens and idioms. UI skips loud — never a fabricated zero.

### US-4.1 — Route wiring (additive, collision-safe)
As a user, I want to navigate to `#/ros` so I can see rest-of-season values.

Acceptance criteria:
- AC1: `app/main.js` gains exactly two **additive** lines (render switch + route-normalize
  switch) — a new `case`, no reordering of existing cases.
- AC2: No existing route or e2e-locked test changes behavior (full gate still green).
- AC3: `#/ros` renders `renderRosView(root, data, params)`; unknown routes are unaffected.

Tasks: T1 add cases; T2 run full gate to confirm no regression; T3 route-load smoke.

### US-4.2 — RoS view (`app/views/ros-view.js`)
As a user, I want a ranked, filterable RoS view so I can compare players by rest-of-season
value.

Acceptance criteria:
- AC1: `renderRosView(root, data, params)` renders one row per player with median value,
  `ros_vor`, floor/ceil, `games_left`, `bye_week`.
- AC2: Re-renders on `data:live-refresh` without duplicating DOM.
- AC3: Position filter uses a native `select` at 402px and a segmented control at ≥1024px
  (existing `.filter-bar` idiom).
- AC4: Layout: single-column 6-col compact grid at 402px; two-up `grid 1fr 1fr`
  (`max-width:980px`) at 1032px — via existing breakpoints only.
- AC5: Uses only existing CSS tokens (`--surface`, `--border`, `--text`, `--good`,
  `--warn`, `--bad`, `--primary`, …) — no new colors/fonts/build.

Tasks: T1 implement view; T2 responsive layout; T3 live-refresh idempotency test.

### US-4.3 — Skip-loud rendering (honest UI)
As a user, I want excluded players shown as excluded-with-reason, never as a fake zero,
so I trust the numbers.

Acceptance criteria:
- AC1: `ros_points:null` renders greyed with the `reason` surfaced, `aria-label`
  = `excluded: <reason>`.
- AC2: An exclusion-count footer shows how many players were skipped.
- AC3: Value is never color-only — a triangle glyph + numeric sign carry direction
  (AA / color-blind safe).
- AC4: No excluded player is rendered with a numeric value in the value column.

Tasks: T1 implement greyed row; T2 footer count; T3 non-color-only assertion test.

### US-4.4 — RoS chip / strip (`app/components/ros-chip.js`)
As a user, I want a compact chip and horizontal strip so RoS value is embeddable
(e.g. later on team-detail) and scannable on a phone.

Acceptance criteria:
- AC1: `ros-chip.js` exports a chip renderer + a strip renderer reusing `.mover-chip` /
  `.movers-strip` idioms.
- AC2: Strip is horizontally scrollable at 402px, wrapped at ≥1024px.
- AC3: A null-value player's chip shows the reason, never a zero.

Tasks: T1 implement chip+strip; T2 scroll/wrap responsive test.

### US-4.5 — UX regression spec (`tests/ux/ros.spec.mjs`)
As QA, I want a Playwright spec locking the RoS surface so future edits can't silently
break it.

Acceptance criteria:
- AC1: Asserts rows render at 402px.
- AC2: Asserts two-up layout at 1032px.
- AC3: Asserts a skipped player shows its reason (not a zero).
- AC4: Runs under the existing `tests/playwright.config.mjs` and is green in the gate.

Tasks: T1 author spec; T2 wire into gate; T3 viewport matrix.

---

## EPIC 5 — Self-learning never-regress loop (`scripts/optimize_ros.py`)

**Goal:** adopt schedule/availability weights only when they beat the incumbent by a
margin, grounded in the real `optimize_weights.py` idiom, with the maximize-ρ sign flip
made explicit. `BLOCKED-BY: E0`.

### US-5.1 — Never-regress gate with sign flip
As the model owner, I want `optimize_ros.py` to adopt a candidate only when it improves
rank correlation by a margin so RoS can only improve or stay flat.

Acceptance criteria:
- AC1: Adopt rule is `new_rho > cur_rho + ROS_MARGIN` (maximize direction) — **not** the
  minimize form copied from log-loss.
- AC2: A candidate that ties or regresses ρ leaves the stored param **unchanged**.
- AC3: A before/after ledger is written atomically (`_write_atomic` idiom).
- AC4: A test feeds a deliberately worse candidate and asserts non-adoption (guards the
  sign-flip trap).

Tasks: T1 implement optimizer; T2 sign-flip non-adoption test; T3 ledger atomicity test.

### US-5.2 — Independent family gating
As the model owner, I want `ros_sos` and `ros_avail` gated independently on disjoint
params so one can adopt while the other is rejected.

Acceptance criteria:
- AC1: `ros_sos` owns `SOS_W` + `sos_factor` Elo scale; candidate = with schedule
  adjustment vs incumbent raw sums.
- AC2: `ros_avail` owns `AVAIL_W` + availability decay + teammate cascade; candidate =
  with availability discount vs without.
- AC3: The two families never write each other's params (disjoint-write test).
- AC4: Pre-tuning weights = 0 so the engine ships identical to raw sums; each earns
  weight only by beating incumbent by margin.

Tasks: T1 register two families; T2 disjoint-write test; T3 zero-default inert test.

### US-5.3 — Adopted params persisted & versioned
As the pipeline, I want adopted params written to `model_tuning.json game_params.ros`
so the builder picks them up and `params_version` changes.

Acceptance criteria:
- AC1: On adoption, `game_params.ros` updates and the before/after ledger records both
  values.
- AC2: On rejection, the number is unchanged and the ledger records "rejected".
- AC3: `build_ros_value.py` reads the updated params on next run (integration test).

Tasks: T1 persist params; T2 rejection-no-change test; T3 builder-picks-up integration.

---

## EPIC 6 — Season-rank backtest (`scripts/ros_backtest.py`)

**Goal:** the honest, walk-forward season rank-correlation backtest using only real data
on disk, labeled measured-vs-estimate, enforced by an honesty test. `BLOCKED-BY: E0`.

### US-6.1 — Walk-forward season rank-correlation
As the model owner, I want a backtest that projects each target season from prior-season
data only and scores the ranking, so improvement claims are grounded.

Acceptance criteria:
- AC1: For each target season S in `{2022,2023,2024,2025}`, inputs are built from seasons
  `<= S-1` **only** — no season-S signal enters (leakage test).
- AC2: Within-position rankings (QB/RB/WR/TE) scored vs season-S actual totals with
  Spearman ρ (primary) + NDCG@k (k = QB12/RB24/WR36/TE12).
- AC3: Baseline to beat = prior-season finish, must be beaten by `ROS_MARGIN`.
- AC4: Reports per-season + pooled ρ/NDCG with n and bootstrap CI.

Tasks: T1 implement walk-forward; T2 leakage test; T3 baseline+CI reporting.

### US-6.2 — Honest measured-vs-estimate output
As QA, I want the backtest output labeled so no estimate is ever presented as measured.

Acceptance criteria:
- AC1: `data/ros_backtest.json` has `__meta__.method='season_rank_correlation'`,
  `granularity='season'`.
- AC2: `measured:true` only on rows computed from real `player_history.json`; else
  `measured:false`.
- AC3: `tests/feature/ros-backtest-honesty.test.mjs` fails if any estimate row is
  labeled measured (mirrors existing `backtest-honesty.test.mjs`).
- AC4: Weekly-granularity (Design B) numbers are **not** emitted unless
  `data/fixtures/` per-player weekly actuals are confirmed present (skip-loud on partial
  coverage).

Tasks: T1 label rows; T2 honesty test; T3 weekly-contingency guard.

---

## Cross-cutting: regression gate coverage

Every story's ACs map to one of the four gate stages (gate on **exit codes**):
`python3 scripts/validate_data.py` (E0, E2, E3, E6) · `bash tests/smoke.sh` (E4 route load)
· `node --test tests/feature/*.mjs tests/competition.test.mjs` (E1, E5, E6 honesty)
· `npx playwright test` (E4 UX). No story is "done" until its named test is green in the
gate and, for `BLOCKED-BY: E0` stories, against fixtures with the blocker documented.
