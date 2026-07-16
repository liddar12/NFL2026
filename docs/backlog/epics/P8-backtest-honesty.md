# P8 · Backtest Honesty & Governance

**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter reuses this epic verbatim — the estimate-vs-measured flags, the baseline gates, the exit-code regression gate, and the prototype quarantine are the governance spine of the whole framework, independent of sport. An adapter re-authors only its concrete baselines (which market / which Elo) and the domain files a prototype is allowed to touch; the rules stay fixed.

## Goal
Make dishonesty structurally impossible and improvement provable. Every displayed number is either a flagged estimate or a measured result — never a guess wearing a measurement's clothes — and tests enforce the distinction from both languages. Every complexity increment must beat a dumb baseline (Elo or the market) on held-out log-loss or it is cut. The regression gate decides on exit codes, and unproven prototypes are quarantined off the product until they clear the gate.

## Why it matters / risk if skipped
This is where good intentions go to die quietly. The postmortems are the warning: silent zero-output scrapers, frozen analytics, unwired signals — each one shipped because nothing failed loudly. Without enforced honesty flags a frontend eventually shows an estimate as a backtest; without baseline gates the model accretes complexity that doesn't beat a coin-flip-plus-Elo; without a hard exit-code gate a red suite gets rationalized green and deployed. Governance is the difference between a measured platform and a confident-sounding fiction.

## User stories

### P8-S1 — Estimate-vs-measured flags enforced by tests   ·  Status: ✅   ·  Est: S
**As** the Analyst **I want** the honesty contract locked by tests in both Python and Node **so that** no code path — and no future refactor — can attach a measured score to an estimate or ship a measured row without its receipts.
**Acceptance criteria** (Given/When/Then):
- P8-S1-AC1 — Given `estimate=true` with a `brier`/`log_loss` present, When validated, Then it is rejected (`bad_est_scored`).
- P8-S1-AC2 — Given `estimate=false & resolved=true` missing a score, When validated, Then it is rejected (`bad_measured_unscored`) — measured rows MUST carry `brier` + `log_loss`.
- P8-S1-AC3 — Given `estimate=false & resolved=false` with a score attached, When validated, Then it is rejected as a leak (`bad_leak`).
- P8-S1-AC4 — Given the committed `data/game_predictions.json`, When the honesty test runs, Then every row is `estimate:true` with no scores (day-zero estimates).
**Tasks:**
- [ ] P8-S1-T1 — Keep `honesty.py` and `backtest_honesty.test.mjs` byte-for-byte equivalent in rule.
- [ ] P8-S1-T2 — Cover all three honest shapes and all three dishonest shapes in fixtures.
- [ ] P8-S1-T3 — Assert against the real committed data file, not only inline fixtures.
- [ ] P8-S1-T4 — Treat absent and null scores identically.
**QA coverage** (4 ACs):
- P8-S1-AC1 → `tests/feature/backtest_honesty.test.mjs::dishonest rows are rejected` (bad_est_scored) — Done
- P8-S1-AC2 → `tests/feature/backtest_honesty.test.mjs::every measured+resolved row carries brier and log_loss` — Done
- P8-S1-AC3 → `tests/feature/backtest_honesty.test.mjs::dishonest rows are rejected` (bad_leak) — Done
- P8-S1-AC4 → `tests/feature/backtest_honesty.test.mjs::committed game_predictions.json are estimates` — Done
  Coverage: 4/4 = 100%. Test types: unit(node:test) | data(validate_data).
**Traceability:** `tests/feature/backtest_honesty.test.mjs`, `scripts/harness/honesty.py`, `data/game_predictions.json`.

### P8-S2 — Baseline gates (beat Elo or the market)   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** every complexity increment measured against a dumb baseline on held-out log-loss **so that** complexity that doesn't earn its keep is cut, not shipped.
**Acceptance criteria** (Given/When/Then):
- P8-S2-AC1 — Given a candidate model and the Elo/market baselines, When compared on the SAME held-out events, Then the candidate is retained only if its mean log-loss beats at least one baseline; otherwise it is cut.
- P8-S2-AC2 — Given a candidate that is only microscopically better, When the NEVER REGRESS rule is applied, Then adoption requires `candidate_loss < current_loss - 0.0015`; ties and sub-margin gains keep the incumbent.
- P8-S2-AC3 — Given a negative `margin`, When `should_adopt` is called, Then it raises `ValueError` (a negative margin would admit regressions).
- P8-S2-AC4 — Given a new signal, When it enters the registry, Then it enters at weight 0 and earns weight only by clearing the baseline + NEVER REGRESS bar ("a signal that doesn't reach the model does not exist").
**Tasks:**
- [ ] P8-S2-T1 — Keep `should_adopt` pure/deterministic; default margin `0.0015`, strict `<`.
- [ ] P8-S2-T2 — Compute baselines (Elo, market-implied) on the identical held-out split as the candidate.
- [ ] P8-S2-T3 — Record the comparison (candidate vs each baseline) into `data/model_tuning.json`.
- [ ] P8-S2-T4 — Assert new signals register at weight 0.0 in the signal registry.
- [ ] P8-S2-T5 — Feed the gate real snapshot-resolved losses, not fixtures.
**QA coverage** (4 ACs):
- P8-S2-AC1 → `tests/feature/never_regress.test.mjs::beats a baseline` (backtest, leak-safe) — Planned
- P8-S2-AC2 → `tests/feature/never_regress.test.mjs::margin 0.0015 tie/sub-margin keeps current` (unit) — Done
- P8-S2-AC3 → `tests/feature/never_regress.test.mjs::negative margin raises` (unit) — Planned
- P8-S2-AC4 → `tests/feature/signal_registry.test.mjs::new signals enter at weight 0` (unit) — Done
  Coverage: 4/4 automatable = 100% (baseline-fit is fixture-fed until real snapshots land). Test types: unit(node:test) | backtest(leak-safe) | data(validate_data).
**Traceability:** `scripts/optimize/never_regress.py`, `scripts/optimize/optimize_weights.py`, `scripts/signals/registry.py`, `data/model_tuning.json`, `tests/feature/never_regress.test.mjs`, `tests/feature/signal_registry.test.mjs`.

### P8-S3 — Exit-code regression gate   ·  Status: ✅   ·  Est: S
**As** the Operator **I want** the gate to decide pass/fail on exit codes in a fixed order **so that** a red suite can never be rationalized green off a colored summary, and no deploy proceeds red.
**Acceptance criteria** (Given/When/Then):
- P8-S3-AC1 — Given the gate runs, When steps execute, Then they run in order — `validate_data.py` → `smoke.sh` → `node --test tests/feature/*.mjs` — and any non-zero step sets overall failure and exits 1.
- P8-S3-AC2 — Given a failing step, When the gate finishes, Then it prints `GATE RESULT: FAIL (red — do NOT deploy)` to stderr and exits non-zero; pass exits 0.
- P8-S3-AC3 — Given the scaffold has no UI yet, When the gate runs, Then it stays dependency-free (python3 stdlib + node built-ins only; Playwright appended only once a real UI exists).
**Tasks:**
- [ ] P8-S3-T1 — Keep `run_gate.sh` gating on exit codes, never on grepping ANSI summaries.
- [ ] P8-S3-T2 — Preserve step order and the aggregate `fail` flag.
- [ ] P8-S3-T3 — Append the Playwright step only when the frontend lands (documented TODO in the gate).
**QA coverage** (3 ACs):
- P8-S3-AC1 → `tests/run_gate.sh` step ordering + `tests/smoke.sh` (smoke) — Done
- P8-S3-AC2 → `tests/run_gate.sh` exit-code/stderr semantics (smoke) — Done
- P8-S3-AC3 → CI `.github/workflows/ci.yml` runs the gate with no npm install (smoke) — Done
  Coverage: 3/3 = 100%. Test types: smoke(bash) | data(validate_data) | unit(node:test).
**Traceability:** `tests/run_gate.sh`, `tests/smoke.sh`, `scripts/validate_data.py`, `.github/workflows/ci.yml`.

### P8-S4 — Prototype quarantine   ·  Status: ⬜   ·  Est: M
**As** the Modeler **I want** unproven work isolated in `scripts/proto/` and `data/proto/` with its math locked by tests but nothing reaching the product **so that** experiments can be developed safely without any path to the live UI until they pass the gate.
**Acceptance criteria** (Given/When/Then):
- P8-S4-AC1 — Given code under `scripts/proto/`, When the app or product data layer is scanned, Then no product module (`app/*`, `scripts/harness/*`, committed `data/*.json` outside `data/proto/`) imports or reads from `proto`.
- P8-S4-AC2 — Given a prototype's math, When its tests run, Then the exact numeric behavior is locked (same discipline as `metrics`/`conformal`), so a promotion later cannot silently change results.
- P8-S4-AC3 — Given a prototype is promoted, When it exits quarantine, Then it must first clear the baseline gate (P8-S2) and the full exit-code regression gate (P8-S3); promotion without a green gate is rejected in review.
- P8-S4-AC4 — Given `data/proto/*.json`, When `validate_data.py` runs, Then proto data is excluded from product contract validation and never shipped to Netlify publish.
**Tasks:**
- [ ] P8-S4-T1 — Create `scripts/proto/` and `data/proto/` with a README stating the quarantine rule.
- [ ] P8-S4-T2 — Add a boundary test asserting no product module imports `proto`.
- [ ] P8-S4-T3 — Lock any prototype's math with a dedicated `tests/feature/*` test.
- [ ] P8-S4-T4 — Exclude `data/proto/` from the Netlify publish and from product schema validation.
**QA coverage** (4 ACs):
- P8-S4-AC1 → `tests/feature/proto_boundary.test.mjs::no product import of proto` (unit) — Planned
- P8-S4-AC2 → `tests/feature/proto_math.test.mjs::locked constants` (unit) — Planned
- P8-S4-AC3 → `tests/run_gate.sh` + review checklist (smoke + manual) — Planned (manual gate step)
- P8-S4-AC4 → `scripts/validate_data.py::proto excluded` (data) — Planned
  Coverage: 4/4 = 100% (AC3 has a manual review component; its gate-green precondition is automated). Test types: unit(node:test) | data(validate_data) | smoke(bash) | manual.
**Traceability:** new — `scripts/proto/`, `data/proto/`, `tests/feature/proto_boundary.test.mjs`; touches `scripts/validate_data.py`, `tests/run_gate.sh`, `netlify.toml`.

### P8-S5 — Feed staleness & measured-row governance   ·  Status: 🟡   ·  Est: S
**As** the Operator **I want** the pipeline to fail loudly on stale or zero-output feeds and on measured rows missing scores **so that** the silent-scraper and frozen-analytics postmortems cannot repeat.
**Acceptance criteria** (Given/When/Then):
- P8-S5-AC1 — Given `data/pipeline_status.json`, When `validate_data.py` runs, Then a feed past its staleness threshold or reporting zero rows fails the gate (non-zero exit), not a silent pass.
- P8-S5-AC2 — Given any resolved measured snapshot row, When validated, Then it must carry both `brier` and `log_loss` (P8-S1-AC2 applied to real archived rows), else the gate fails.
- P8-S5-AC3 — Given crons committing JSON concurrently, When merged to main, Then merges are race-safe (`git pull --ff-only`, prefer freshly generated files on data conflict) — no lost or half-written data file passes validation.
**Tasks:**
- [ ] P8-S5-T1 — Enforce row-count > 0 and staleness thresholds against `pipeline_status.schema.json`.
- [ ] P8-S5-T2 — Run the honesty validator across every committed snapshot file, not just fixtures.
- [ ] P8-S5-T3 — Document the race-safe merge in the cron workflows and assert final files parse.
**QA coverage** (3 ACs):
- P8-S5-AC1 → `scripts/validate_data.py::pipeline staleness/row-count` (data) — Planned
- P8-S5-AC2 → `tests/feature/backtest_honesty.test.mjs` applied to `data/snapshots/*` (unit) — Planned
- P8-S5-AC3 → `tests/smoke.sh::committed data parses` (smoke) + cron workflow config — Done (smoke) / Planned (cron)
  Coverage: 3/3 = 100%. Test types: data(validate_data) | unit(node:test) | smoke(bash).
**Traceability:** `scripts/validate_data.py`, `scripts/pipeline_status.py`, `data/pipeline_status.json`, `data/contracts/pipeline_status.schema.json`, `tests/feature/backtest_honesty.test.mjs`, `.github/workflows/{daily,gameday}.yml`.
