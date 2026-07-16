# P10 · LLM-as-Signal (empirically gated)
**Layer:** Platform   ·   **Status:** ⬜ Planned   ·   **Instantiates:** —
**Reuse:** A future adapter reuses the entire quarantine → encode → backtest → promote pipeline and the "LLM output is just another signal at weight 0" contract wholesale; it re-authors only the *prompt templates* and which registered signals the encoder targets (here: coaching/coordinator/scheme/off-field factors). The gate, the honesty rules, and the promotion criterion are domain-agnostic.

## Goal
Turn unstructured qualitative inputs the box score can't see — coordinator/head-coach changes, scheme changes, off-field issues (suspensions, holdouts, conduct) — into a **numeric signal** by encoding them with an LLM, and subject that signal to exactly the same discipline as every other factor: it enters the registry at `weight = 0.0` and is promoted *only* when it demonstrates out-of-sample lift on played events (beats the current weight vector on held-out log-loss by the NEVER-REGRESS margin, 0.0015). This is the "develop my AI's predictive ability" module built with backtest honesty: the LLM is a feature extractor, not an oracle, and its numbers are trusted only in proportion to measured performance on resolved games.

## Why it matters / risk if skipped
The temptation with an LLM is to let a fluent narrative override the model — to hand-weight "this team looks better on paper." That is the hand-weighted-folklore failure with a persuasive voice. Two postmortems govern the design. (1) **Unwired signals** — "a signal that does not reach the model does not exist": an LLM feature that is computed but never blended, or blended at a hand-picked weight, is either useless or dishonest; the encoder must emit into a *registered* signal that flows through the optimizer. (2) **Estimate-vs-measured honesty**: an LLM guess is an *estimate* and may never carry measured scores; only resolved, non-estimate predictions show receipts. If skipped, we either ignore real, predictive qualitative information or — worse — let an unbacktested LLM silently degrade the model. The whole module is quarantined and commits nothing to the product until it clears the gate.

## User stories

### P10-S1 — Quarantine the prototype (commits nothing to the product)   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** the LLM signal developed entirely inside `scripts/proto/` and `data/proto/` **so that** an experimental, non-deterministic component cannot touch the shipping model, the regression gate, or `data/*.json` until it has earned promotion.
**Acceptance criteria** (Given/When/Then):
- P10-S1-AC1 — Given the prototype, When it runs, Then it reads and writes only under `scripts/proto/` and `data/proto/` and never modifies `data/meta.json`, `data/*.json` product files, or any `scripts/models/*` / `scripts/optimize/*` path.
- P10-S1-AC2 — Given the regression gate (`tests/run_gate.sh`), When it runs, Then no proto module is imported by product code and gate green does not depend on any live LLM call (network-free).
- P10-S1-AC3 — Given `data/proto/` outputs, When `validate_data.py` runs over `data/`, Then proto artifacts are excluded from product contracts (they are experiment logs, not product data).
- P10-S1-AC4 — Given a promotion has NOT occurred, When the product builds, Then the LLM-targeted registry signals remain at weight 0.0 and the product output is byte-identical to a build with the prototype absent.
**Tasks** (implementation checklist):
- [ ] P10-S1-T1 — Create `scripts/proto/llm_signal/` (encoder, prompt templates, backtest driver) and `data/proto/` (inputs, encoded outputs, backtest logs).
- [ ] P10-S1-T2 — Add an import-boundary test: no product module imports `scripts.proto.*`.
- [ ] P10-S1-T3 — Exclude `data/proto/` from `validate_data.py`'s product-contract scan.
- [ ] P10-S1-T4 — Prove product-output invariance with and without the proto tree present.
**QA coverage**:
- P10-S1-AC1 → `tests/feature/llm_signal_quarantine.test.mjs::writes-only-under-proto` (unit) — Planned
- P10-S1-AC2 → `tests/feature/llm_signal_quarantine.test.mjs::gate-is-network-free` (unit) + `tests/run_gate.sh` (smoke) — Planned
- P10-S1-AC3 → `scripts/validate_data.py::proto_excluded` (data) — Planned
- P10-S1-AC4 → `tests/feature/llm_signal_quarantine.test.mjs::product-output-invariant` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test) | data(validate_data) | smoke(bash).
**Traceability:** new `scripts/proto/llm_signal/`, new `data/proto/`, `scripts/validate_data.py`, `tests/run_gate.sh`, new `tests/feature/llm_signal_quarantine.test.mjs`.

### P10-S2 — Encode unstructured inputs into a deterministic numeric signal   ·  Status: ⬜   ·  Est: L
**As** a Modeler **I want** the LLM to convert qualitative inputs into a bounded, reproducible numeric value per event **so that** coaching/scheme/off-field information becomes a feature the optimizer can weigh, with the math locked by tests.
**Acceptance criteria** (Given/When/Then):
- P10-S2-AC1 — Given a qualitative input record (e.g. "new OC installs a faster passing scheme"; "WR suspended 3 games"), When the encoder runs, Then it emits a numeric value in a fixed bounded range (e.g. `[-1.0, 1.0]`) with a `direction` and a `confidence`, targeting a named registry signal (`coordinator_change`, `head_coach_change`, `scheme_fit`, `qb_coaching`, or `off_field`).
- P10-S2-AC2 — Given the LLM raw text output, When it is post-processed, Then parsing is total: malformed/empty/refusal responses map to a neutral `0.0` with `confidence=0` (never a crash, never a silent nonzero guess), and the transform (clamp, sign, scale) is pure and unit-tested independent of any live LLM call.
- P10-S2-AC3 — Given the same input and a cached/fixture LLM response, When the encoder runs twice, Then the numeric output is identical (deterministic given the model response; the math is not re-randomized).
- P10-S2-AC4 — Given an off-field input, When encoded, Then availability-risk semantics match the `off_field` signal's definition (suspensions/holdouts/conduct not captured by injury status) and do not double-count `injury_status`.
**Tasks** (implementation checklist):
- [ ] P10-S2-T1 — Define the encoder I/O schema (input record → `{signal, value, direction, confidence, rationale}`) as a `data/proto/*.schema.json` contract.
- [ ] P10-S2-T2 — Author prompt templates per target signal; keep raw LLM responses cached in `data/proto/` for replay.
- [ ] P10-S2-T3 — Implement the pure post-processor (clamp to range, map to signal, neutral-on-failure) with no network dependency.
- [ ] P10-S2-T4 — Unit-test the math on fixtures: bounds, neutral-on-malformed, determinism, off_field-vs-injury separation.
- [ ] P10-S2-T5 — Record token/cost and model id per call into the backtest log for reproducibility.
**QA coverage**:
- P10-S2-AC1 → `tests/feature/llm_signal_encode.test.mjs::emits-bounded-value-for-named-signal` (unit) — Planned
- P10-S2-AC2 → `tests/feature/llm_signal_encode.test.mjs::neutral-on-malformed` (unit) — Planned
- P10-S2-AC3 → `tests/feature/llm_signal_encode.test.mjs::deterministic-given-response` (unit) — Planned
- P10-S2-AC4 → `tests/feature/llm_signal_encode.test.mjs::off-field-not-double-counting-injury` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test) | data(schema contract). Note: the live-LLM call itself is manual/non-deterministic and is exercised via cached fixtures; the automatable math is 100% covered.
**Traceability:** new `scripts/proto/llm_signal/encoder.py`, new `data/proto/llm_inputs.json` + cached responses, new `data/proto/llm_signal.schema.json`, new `tests/feature/llm_signal_encode.test.mjs`; targets registry signals in `scripts/signals/registry.py`.

### P10-S3 — Enters at weight 0; promoted only on measured lift   ·  Status: ⬜   ·  Est: L
**As** a Modeler **I want** the LLM signal held at weight 0.0 until it beats the baseline on held-out log-loss **so that** the model gains from the LLM only when the LLM demonstrably helps — never because it sounds convincing.
**Acceptance criteria** (Given/When/Then):
- P10-S3-AC1 — Given the LLM-targeted signals, When the product model is built pre-promotion, Then their weights are exactly 0.0 in `data/meta.json` (the encoder producing values does NOT imply weight).
- P10-S3-AC2 — Given a leak-safe walk-forward backtest over played (resolved, non-estimate) events, When the optimizer evaluates adding the LLM signal, Then it is adopted only if candidate held-out log-loss `< incumbent − 0.0015` (NEVER REGRESS margin); otherwise the incumbent weight vector is kept and the signal stays at 0.0.
- P10-S3-AC3 — Given the backtest, When each LLM feature value is computed for an event, Then it uses only information available at `as_of_utc <= kickoff` (no post-hoc narrative, no result leakage); a value that could only be known after kickoff fails the leak check.
- P10-S3-AC4 — Given a promotion decision, When recorded, Then it logs incumbent loss, candidate loss, the margin cleared, and the fold count — a promotion with an unstated or sub-margin delta is rejected.
**Tasks** (implementation checklist):
- [ ] P10-S3-T1 — Build the walk-forward backtest driver in `scripts/proto/` that snapshots LLM feature values at `as_of_utc` and resolves against final results.
- [ ] P10-S3-T2 — Route candidate evaluation through the existing `scripts/optimize/never_regress.py` margin rule (0.0015) — reuse, do not reimplement.
- [ ] P10-S3-T3 — Enforce the leak check (feature `as_of_utc <= kickoff`) via `scripts/harness/snapshot.py` semantics.
- [ ] P10-S3-T4 — Emit a promotion report (incumbent vs candidate loss, margin, folds) to `data/proto/`.
- [ ] P10-S3-T5 — Assert weights stay 0.0 in the product until a report shows a passing gate.
**QA coverage**:
- P10-S3-AC1 → `tests/feature/signal_registry.test.mjs::every registry signal is present at exactly 0.0` (unit) + `tests/feature/llm_signal_promote.test.mjs::zero-until-promoted` (unit) — Planned
- P10-S3-AC2 → `tests/feature/llm_signal_promote.test.mjs::adopt-only-above-margin` (unit, backtest) reusing `scripts/optimize/never_regress.py` — Planned
- P10-S3-AC3 → `tests/feature/llm_signal_promote.test.mjs::leak-safe-as-of` (unit, backtest) — Planned
- P10-S3-AC4 → `tests/feature/llm_signal_promote.test.mjs::promotion-report-states-margin` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test) | backtest(leak-safe). 
**Traceability:** new `scripts/proto/llm_signal/backtest.py`, `scripts/optimize/never_regress.py`, `scripts/optimize/optimize_weights.py`, `scripts/harness/snapshot.py`, `scripts/harness/metrics.py`, `data/meta.json`, new `tests/feature/llm_signal_promote.test.mjs`.

### P10-S4 — Estimate-vs-measured honesty for LLM outputs   ·  Status: ⬜   ·  Est: M
**As** the System **I want** every LLM-derived prediction flagged as an estimate until its event resolves **so that** a fluent guess can never masquerade as a measured result.
**Acceptance criteria** (Given/When/Then):
- P10-S4-AC1 — Given an LLM-derived snapshot row for an unresolved event, When validated, Then `estimate == true` and `brier`/`log_loss` are absent or null (an estimate may never carry measured scores).
- P10-S4-AC2 — Given an LLM-influenced prediction whose event has resolved, When validated, Then `estimate == false & resolved == true` implies `brier` and `log_loss` are both present non-null numbers (a finished prediction shows receipts).
- P10-S4-AC3 — Given only FINAL results, When the backtest scores LLM lift, Then live/in-progress/scheduled-stub events are excluded — STATUS-gating: only resolved finals count toward measured performance.
**Tasks** (implementation checklist):
- [ ] P10-S4-T1 — Emit LLM backtest rows through `scripts/harness/honesty.py::validate` (reuse the estimate-vs-measured contract).
- [ ] P10-S4-T2 — Tag every pre-resolution LLM row `estimate=true` with no scores; attach scores only on resolve.
- [ ] P10-S4-T3 — STATUS-gate the resolution step so only finals feed measured lift.
- [ ] P10-S4-T4 — Add honesty assertions to the proto backtest test.
**QA coverage**:
- P10-S4-AC1 → `tests/feature/backtest_honesty.test.mjs::estimate-has-no-scores` (unit) — Planned
- P10-S4-AC2 → `tests/feature/backtest_honesty.test.mjs::resolved-shows-receipts` (unit) — Planned
- P10-S4-AC3 → `tests/feature/llm_signal_promote.test.mjs::final-only-scoring` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test) | backtest(leak-safe).
**Traceability:** `scripts/harness/honesty.py`, `scripts/harness/snapshot.py`, `tests/feature/backtest_honesty.test.mjs`, new `tests/feature/llm_signal_promote.test.mjs`.

### P10-S5 — Manual-dispatch workflow; nothing ships without passing the gate   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** the LLM signal run only via a manual-dispatch workflow that commits nothing to the product unless the gate passes **so that** cost, non-determinism, and promotion stay under explicit human control.
**Acceptance criteria** (Given/When/Then):
- P10-S5-AC1 — Given the workflow, When triggered, Then it is `workflow_dispatch`-only (no `schedule:` trigger — LLM cost/non-determinism is not on a cron) and runs the encode→backtest→report pipeline into `data/proto/` only.
- P10-S5-AC2 — Given a run whose promotion report does NOT clear the 0.0015 margin, When the workflow finishes, Then it commits nothing to product paths (`data/meta.json`, `data/*.json`) and exits success with a "not promoted" report artifact.
- P10-S5-AC3 — Given a run that DOES clear the margin, When promotion is proposed, Then the product weight change is applied only on an explicit confirmed step (race-safe merge to main: `git pull --ff-only` then push; prefer freshly generated files on data conflict) with the rollback stated (one-line `git revert` of the weight commit) before deploy.
- P10-S5-AC4 — Given any run, When it completes, Then the regression gate (`tests/run_gate.sh`) is still 100% green and does not depend on the LLM having run.
**Tasks** (implementation checklist):
- [ ] P10-S5-T1 — Add `.github/workflows/llm_signal.yml` as `workflow_dispatch`-only writing to `data/proto/`.
- [ ] P10-S5-T2 — Gate any product commit on a passing promotion report; default to commit-nothing.
- [ ] P10-S5-T3 — Implement the confirmed promotion step with race-safe merge and a stated one-line rollback.
- [ ] P10-S5-T4 — Store cost/model-id/token usage as a run artifact.
- [ ] P10-S5-T5 — Verify gate stays green with the workflow never having run.
**QA coverage**:
- P10-S5-AC1 → `tests/feature/llm_signal_workflow.test.mjs::dispatch-only-no-schedule` (unit, YAML lint) — Planned
- P10-S5-AC2 → `tests/feature/llm_signal_workflow.test.mjs::no-promotion-commits-nothing` (unit) — Planned
- P10-S5-AC3 → manual — confirmed promotion + deploy is a human handoff (race-safe merge, rollback stated); the *decision logic* (margin cleared → propose) is unit-tested via `llm_signal_promote.test.mjs::adopt-only-above-margin`.
- P10-S5-AC4 → `tests/run_gate.sh` (smoke) — Planned
  Coverage: 3/4 automatable ACs covered = 100% of automatable (AC3's ship step is manual-only by design; its decision logic is covered). Test types: unit(node:test) | smoke(bash) | manual.
**Traceability:** new `.github/workflows/llm_signal.yml`, `scripts/proto/llm_signal/`, `data/proto/`, `data/meta.json`, `tests/run_gate.sh`, new `tests/feature/llm_signal_workflow.test.mjs`, new `tests/feature/llm_signal_promote.test.mjs`.
