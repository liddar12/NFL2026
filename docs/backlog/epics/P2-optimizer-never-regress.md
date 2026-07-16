# P2 · Weight Optimizer & NEVER REGRESS
**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter (NBA/MLB/markets) reuses the entire fitting loop, the leak-safe walk-forward harness, and the NEVER REGRESS gate unchanged; it re-authors only the signal set it feeds in and the sport's event granularity (game/prop) — the optimizer never knows the sport.

## Goal
Fit signal weights against real, already-happened events in a strictly leak-safe walk-forward, optimizing log-loss (probability quality), and adopt new weights only when they beat the incumbent by a hard margin. The harness comes first: no weight is trusted that wasn't earned on out-of-sample, as-of-kickoff information. New signals join the model at weight 0 and earn weight only through the fit — never by hand. This is the mechanism that lets the platform absorb 32+ signals without any of them silently degrading the model.

## Why it matters / risk if skipped
Without leak-safety, a weight set "learns" from the outcome it is predicting and looks brilliant in backtest, then collapses live — the classic frozen-analytics/overfit postmortem. Without the NEVER REGRESS gate, every refit is a coin-flip that can quietly ship a worse model on noise; small samples especially will hand large weights to lucky signals. "A signal that doesn't reach the model does not exist" — but a signal that reaches it *unearned* is worse: it dilutes the ones that work. This epic is the honesty enforcement for the model layer.

## User stories

### P2-S1 — Leak-safe walk-forward fit   ·  Status: 🟡   ·  Est: L
**As** a Modeler **I want** every event scored using only information available as-of its kickoff **so that** fitted weights reflect real predictive power, not hindsight.
**Acceptance criteria** (Given/When/Then):
- P2-S1-AC1 — Given a fold cut at kickoff time T, When features for event E (kickoff T) are assembled, Then every input row used has an as-of/observed timestamp `< T`; any row at or after T is excluded and the exclusion is counted.
- P2-S1-AC2 — Given the full season ordered by kickoff, When the walk-forward runs, Then each event is predicted only from a model fit on events with kickoff strictly earlier (expanding/rolling window), and no event contributes to its own training fold.
- P2-S1-AC3 — Given a deliberately planted future-leak row (outcome injected pre-kickoff), When the leak-safety assertion runs, Then the fit fails loudly (non-zero exit) rather than silently consuming it.
- P2-S1-AC4 — Given a completed walk-forward, When results are emitted, Then out-of-sample log-loss and accuracy are reported per fold and in aggregate, with fold boundaries (timestamps, event counts) recorded in `data/model_tuning.json`.
**Tasks:**
- [ ] P2-S1-T1 — Implement expanding-window walk-forward splitter keyed on `kickoff_utc` in `scripts/optimize/optimize_weights.py`.
- [ ] P2-S1-T2 — Enforce as-of filtering: every feature carries an observed-at timestamp; assert `observed_at < kickoff` at assembly.
- [ ] P2-S1-T3 — Add a leak-canary fixture (planted post-kickoff row) and make the assertion fatal.
- [ ] P2-S1-T4 — Persist per-fold and aggregate log-loss + accuracy and fold metadata to `data/model_tuning.json`.
- [ ] P2-S1-T5 — Unit-test splitter determinism and boundary correctness (event on the boundary belongs to the future, never the train fold).
**QA coverage:**
- P2-S1-AC1 → `tests/feature/never_regress.test.mjs::asof_filter_excludes_future_rows` (unit) — Planned
- P2-S1-AC2 → `tests/feature/never_regress.test.mjs::walkforward_no_self_training` (unit) — Planned
- P2-S1-AC3 → `tests/feature/never_regress.test.mjs::leak_canary_fails_loud` (backtest) — Planned
- P2-S1-AC4 → `scripts/validate_data.py::model_tuning_schema` (data) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test), backtest(leak-safe), data(validate_data).
**Traceability:** `scripts/optimize/optimize_weights.py`, `data/model_tuning.json`, `data/contracts/model_tuning.schema.json` (new/extend), `tests/feature/never_regress.test.mjs`.

### P2-S2 — Log-loss objective; accuracy reported, never optimized   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** the optimizer to minimize log-loss **so that** the model is calibrated probabilistically, with accuracy tracked only as a readout.
**Acceptance criteria** (Given/When/Then):
- P2-S2-AC1 — Given a candidate weight vector, When the objective is evaluated, Then the returned scalar is mean log-loss over the leak-safe out-of-sample set (lower is better); accuracy is computed but never enters the objective.
- P2-S2-AC2 — Given two weight vectors A and B where B has higher accuracy but higher (worse) log-loss, When the optimizer chooses, Then it selects A — proving accuracy cannot override the objective.
- P2-S2-AC3 — Given predicted probabilities, When log-loss is computed, Then probabilities are clipped to `[eps, 1-eps]` (eps documented) so no single event returns infinite loss.
**Tasks:**
- [ ] P2-S2-T1 — Implement `log_loss(y, p)` with documented eps-clipping in `scripts/optimize/optimize_weights.py`.
- [ ] P2-S2-T2 — Wire the optimizer's objective to log-loss only; compute accuracy as a side-metric.
- [ ] P2-S2-T3 — Emit both metrics to `data/model_tuning.json` labeled objective vs readout.
- [ ] P2-S2-T4 — Unit-test the A-vs-B case (accuracy-up/log-loss-worse must lose).
**QA coverage:**
- P2-S2-AC1 → `tests/feature/never_regress.test.mjs::objective_is_logloss` (unit) — Planned
- P2-S2-AC2 → `tests/feature/never_regress.test.mjs::accuracy_never_overrides_logloss` (unit) — Planned
- P2-S2-AC3 → `tests/feature/never_regress.test.mjs::logloss_eps_clip_finite` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/optimize/optimize_weights.py`, `data/model_tuning.json`.

### P2-S3 — Shrinkage toward current weights on small samples   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** fitted weights pulled toward the incumbent when the sample is thin **so that** early-season noise doesn't hand large weight to lucky signals.
**Acceptance criteria** (Given/When/Then):
- P2-S3-AC1 — Given N out-of-sample events, When weights are fit, Then the result is a shrinkage blend `w = α·w_fit + (1-α)·w_current` where α increases monotonically with N (documented schedule).
- P2-S3-AC2 — Given N below a floor (documented, e.g. very small), When the fit runs, Then α≈0 and the incumbent weights are effectively retained.
- P2-S3-AC3 — Given N large, When the fit runs, Then α→1 and shrinkage vanishes (the fit dominates).
- P2-S3-AC4 — Given the current weights are read for shrinkage, When the optimizer loads them, Then it reads from `data/meta.json` (the live weights), not a hardcoded constant.
**Tasks:**
- [ ] P2-S3-T1 — Implement the α(N) schedule with documented knots in `scripts/optimize/optimize_weights.py`.
- [ ] P2-S3-T2 — Load incumbent weights from `data/meta.json`; blend fit result toward them.
- [ ] P2-S3-T3 — Unit-test the three regimes (N below floor → α≈0; mid; large → α≈1) and monotonicity.
- [ ] P2-S3-T4 — Record α, N, w_fit, w_current, w_blended in `data/model_tuning.json` for auditability.
**QA coverage:**
- P2-S3-AC1 → `tests/feature/never_regress.test.mjs::shrinkage_alpha_monotonic_in_n` (unit) — Planned
- P2-S3-AC2 → `tests/feature/never_regress.test.mjs::shrinkage_small_sample_holds_incumbent` (unit) — Planned
- P2-S3-AC3 → `tests/feature/never_regress.test.mjs::shrinkage_large_sample_frees_fit` (unit) — Planned
- P2-S3-AC4 → `tests/feature/never_regress.test.mjs::shrinkage_reads_meta_weights` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/optimize/optimize_weights.py`, `data/meta.json`, `data/model_tuning.json`.

### P2-S4 — NEVER REGRESS adoption gate (margin 0.0015)   ·  Status: 🟡   ·  Est: L
**As** an Operator **I want** new weights adopted only if they beat the incumbent by a hard margin on the same leak-safe set **so that** refits never ship a worse or noise-equal model.
**Acceptance criteria** (Given/When/Then):
- P2-S4-AC1 — Given candidate weights and incumbent weights, When both are scored on the identical leak-safe out-of-sample set, Then adoption requires `logloss_current − logloss_candidate ≥ 0.0015`; otherwise the incumbent is retained.
- P2-S4-AC2 — Given a candidate that improves by less than 0.0015 (including exactly at the boundary minus epsilon), When the gate runs, Then it is rejected and `data/meta.json` weights are left byte-identical.
- P2-S4-AC3 — Given a candidate that improves by ≥ 0.0015, When the gate runs, Then the weights are written to `data/meta.json` and the decision (before/after log-loss, delta, verdict) is logged to `data/model_tuning.json`.
- P2-S4-AC4 — Given candidate and incumbent, When compared, Then both are scored on the *same* event set and window (no comparing across different folds/samples) — asserted, not assumed.
- P2-S4-AC5 — Given the gate rejects, When the process exits, Then it exits 0 (a non-adoption is a normal outcome, not a failure) but clearly reports "REGRESS-BLOCKED: retained incumbent".
**Tasks:**
- [ ] P2-S4-T1 — Implement the gate in `scripts/optimize/never_regress.py`: compare candidate vs incumbent log-loss on a shared set.
- [ ] P2-S4-T2 — Encode the 0.0015 threshold as a single named constant; assert same-set comparison.
- [ ] P2-S4-T3 — On pass, atomically write `data/meta.json` weights; on fail, no-write.
- [ ] P2-S4-T4 — Log verdict + deltas to `data/model_tuning.json`.
- [ ] P2-S4-T5 — Unit-test the three boundary cases: below margin (reject), at margin (adopt), above margin (adopt); and a regression (candidate worse → reject).
**QA coverage:**
- P2-S4-AC1 → `tests/feature/never_regress.test.mjs::gate_requires_0_0015_margin` (unit) — Planned
- P2-S4-AC2 → `tests/feature/never_regress.test.mjs::gate_rejects_below_margin_no_write` (unit) — Planned
- P2-S4-AC3 → `tests/feature/never_regress.test.mjs::gate_adopts_at_and_above_margin_writes` (unit) — Planned
- P2-S4-AC4 → `tests/feature/never_regress.test.mjs::gate_asserts_same_set` (unit) — Planned
- P2-S4-AC5 → `tests/smoke.sh::never_regress_block_exits_zero` (smoke) — Planned
  Coverage: 5/5 = 100%. Test types: unit(node:test), smoke(bash).
**Traceability:** `scripts/optimize/never_regress.py`, `data/meta.json`, `data/model_tuning.json`, `tests/feature/never_regress.test.mjs`, `tests/smoke.sh`.

### P2-S5 — New signals enter at weight 0; earn weight only via the fit   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** any newly registered signal to start at weight 0 and gain weight only through the optimizer **so that** no signal can influence predictions until it demonstrably improves them.
**Acceptance criteria** (Given/When/Then):
- P2-S5-AC1 — Given a signal newly added to `scripts/signals/registry.py`, When it first appears, Then its weight in `data/meta.json` is exactly 0.0 and it contributes nothing to any prediction.
- P2-S5-AC2 — Given a weight-0 signal that the walk-forward finds predictive, When the fit runs and the NEVER REGRESS gate passes, Then its weight rises from 0 solely as an output of the fit — never set by hand.
- P2-S5-AC3 — Given a weight-0 signal that the fit finds unhelpful, When the fit runs, Then its weight stays at (or returns toward) 0 and the model is unchanged.
- P2-S5-AC4 — Given the registry currently declares 32 signals, When weights are inspected before any real fit, Then all are 0.0 (no hand-tuned nonzero weights exist in the repo).
**Tasks:**
- [ ] P2-S5-T1 — Enforce weight-0 default for any signal id not already present in `data/meta.json` weights.
- [ ] P2-S5-T2 — Assert no code path sets a signal weight except the optimizer's fit output.
- [ ] P2-S5-T3 — Unit-test: add a synthetic signal → weight 0; run predictive fixture → weight rises via fit; run noise fixture → weight stays 0.
- [ ] P2-S5-T4 — Data-test that all 32 registry signals map to 0.0 weights in the current `data/meta.json`.
**QA coverage:**
- P2-S5-AC1 → `tests/feature/never_regress.test.mjs::new_signal_defaults_zero` (unit) — Planned
- P2-S5-AC2 → `tests/feature/never_regress.test.mjs::predictive_signal_earns_weight_via_fit` (unit) — Planned
- P2-S5-AC3 → `tests/feature/never_regress.test.mjs::noise_signal_stays_zero` (unit) — Planned
- P2-S5-AC4 → `scripts/validate_data.py::all_registry_signals_zero_weight` (data) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/signals/registry.py`, `data/meta.json`, `scripts/optimize/optimize_weights.py`, `tests/feature/never_regress.test.mjs`.

### P2-S6 — Refit orchestration & reproducibility   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** the fit → gate → write sequence to run deterministically on a cron with a stated rollback **so that** weight changes are auditable and reversible.
**Acceptance criteria** (Given/When/Then):
- P2-S6-AC1 — Given the same input snapshot and seed, When `optimize_weights.py` runs twice, Then it produces byte-identical `data/model_tuning.json` (deterministic; seed recorded).
- P2-S6-AC2 — Given a scheduled refit, When it completes, Then it runs `optimize_weights.py` → `never_regress.py` in that order, and only the gate may touch `data/meta.json` weights.
- P2-S6-AC3 — Given a bad adoption slipped through, When rolling back, Then reverting the single `data/meta.json` commit restores the prior weights (rollback is one `git revert`), and this one-liner is stated in the run log before write.
- P2-S6-AC4 — Given concurrent cron pushes, When the refit commits, Then the merge is race-safe (`git pull --ff-only` then push; on data conflict prefer freshly generated files).
**Tasks:**
- [ ] P2-S6-T1 — Seed and record RNG state; assert twice-run determinism in a smoke test.
- [ ] P2-S6-T2 — Wire the ordered refit into the daily/gameday cron (`.github/workflows/*.yml`) behind the gate.
- [ ] P2-S6-T3 — Emit the rollback one-liner and before/after weights to the run log prior to any write.
- [ ] P2-S6-T4 — Make the commit step race-safe per repo convention.
**QA coverage:**
- P2-S6-AC1 → `tests/smoke.sh::optimize_deterministic_rerun` (smoke) — Planned
- P2-S6-AC2 → `tests/smoke.sh::refit_order_gate_guards_meta` (smoke) — Planned
- P2-S6-AC3 → manual (rollback drill) — documented; one `git revert`, verified by re-reading `data/meta.json`
- P2-S6-AC4 → `tests/smoke.sh::refit_commit_race_safe` (smoke) — Planned
  Coverage: 3/4 automatable = 75% automated; AC3 is manual-only (rollback drill). Automatable ACs covered: 3/3 = 100%. Test types: smoke(bash), manual.
**Traceability:** `scripts/optimize/optimize_weights.py`, `scripts/optimize/never_regress.py`, `data/meta.json`, `data/model_tuning.json`, `.github/workflows/daily.yml`, `.github/workflows/gameday.yml`, `tests/smoke.sh`.
