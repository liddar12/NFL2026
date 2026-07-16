# P3 · Multi-Model Ensemble
**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter reuses the ensemble contract wholesale — the model interface (each model returns a full probability vector), the market-as-first-class-model treatment, the fitted hybrid blend, and the refit-on-cron stacker. It re-authors only the in-house model internals and which market venue it ingests (Kalshi/Polymarket/sportsbook); the blend, disagreement rule, and metrics are sport-agnostic.

## Goal
Combine several models — one or more in-house models, plus the market itself ingested as a first-class model (not merely a benchmark) — into a fitted hybrid whose blend weights are learned and refit on a cron. Models are combined by blending full probability vectors and adopting the argmax on directional disagreement; point picks are never averaged. In practice the market typically earns the largest single weight, and the ensemble's job is to know exactly when and how much to deviate from it.

## Why it matters / risk if skipped
Averaging point picks is the classic ensemble bug: two models that pick opposite sides average to a mushy ~50% that is worse than either, and it silently discards the confidence signal. Treating the market as "just a benchmark" throws away the single best-calibrated model available; treating it as a model — and letting the fit hand it the weight it deserves — is how the ensemble stays honest and rarely loses to the line. If blend weights are hand-set rather than fit, the ensemble inherits the same unearned-weight failure the platform exists to prevent (a model that doesn't earn its weight shouldn't have it).

## User stories

### P3-S1 — Every model returns a full probability vector   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** each model to expose a full, normalized probability vector over outcomes **so that** the ensemble blends distributions, not collapsed picks.
**Acceptance criteria** (Given/When/Then):
- P3-S1-AC1 — Given any registered model, When it predicts an event, Then it returns a probability vector over all outcomes that sums to 1 (±1e-6) with every entry in `[0,1]` — never a bare pick or a single scalar.
- P3-S1-AC2 — Given a model that internally has only a pick, When it is adapted to the interface, Then it must emit a calibrated vector (documented mapping); a degenerate one-hot is rejected by contract test.
- P3-S1-AC3 — Given the model registry, When conformance is checked, Then every model passes the vector contract (sum-to-1, bounded, correct dimensionality for the event type).
**Tasks:**
- [ ] P3-S1-T1 — Define the model interface (`predict(event) → prob_vector`) in `scripts/models/game_model.py`.
- [ ] P3-S1-T2 — Add a contract check: sum-to-1, bounds, dimensionality.
- [ ] P3-S1-T3 — Unit-test rejection of scalar/one-hot degenerate outputs.
**QA coverage:**
- P3-S1-AC1 → `tests/feature/ensemble.test.mjs::model_returns_normalized_vector` (unit) — Planned
- P3-S1-AC2 → `tests/feature/ensemble.test.mjs::pick_only_model_must_emit_vector` (unit) — Planned
- P3-S1-AC3 → `tests/feature/ensemble.test.mjs::all_models_pass_vector_contract` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`, `scripts/harness/metrics.py`, `tests/feature/ensemble.test.mjs`.

### P3-S2 — Market ingested as a first-class model   ·  Status: 🟡   ·  Est: L
**As** a Modeler **I want** market prices (Kalshi/Polymarket/odds) converted to a de-vigged probability vector and registered as a model **so that** the fit can weight the market like any other model — including giving it the largest weight when earned.
**Acceptance criteria** (Given/When/Then):
- P3-S2-AC1 — Given raw market prices/odds as-of kickoff, When ingested, Then they are de-vigged into a normalized probability vector (sum-to-1 ±1e-6) and registered under a model id in the ensemble.
- P3-S2-AC2 — Given the ensemble fit, When blend weights are learned, Then the market model is eligible for any weight in `[0,1]` and is *not* pinned as a fixed benchmark; its weight is an output of the fit.
- P3-S2-AC3 — Given a typical fitted result, When weights are inspected, Then the market model commonly holds the largest single weight — and this is reported, not asserted as a hard floor (the fit decides).
- P3-S2-AC4 — Given market prices are as-of kickoff, When used in a leak-safe walk-forward (P2), Then only pre-kickoff quotes are consumed (no post-kickoff line movement leaks in).
**Tasks:**
- [ ] P3-S2-T1 — Implement odds/price → de-vigged probability conversion.
- [ ] P3-S2-T2 — Register the market as a model id in the ensemble registry alongside in-house models.
- [ ] P3-S2-T3 — Enforce as-of-kickoff quote selection for leak-safety (ties into P2-S1).
- [ ] P3-S2-T4 — Report per-model fitted weights (including market) to `data/meta.json`.
**QA coverage:**
- P3-S2-AC1 → `tests/feature/ensemble.test.mjs::market_devig_normalized` (unit) — Planned
- P3-S2-AC2 → `tests/feature/ensemble.test.mjs::market_weight_is_fit_output_not_pinned` (unit) — Planned
- P3-S2-AC3 → `tests/feature/ensemble.test.mjs::market_typically_largest_weight_reported` (unit) — Planned
- P3-S2-AC4 → `tests/feature/ensemble.test.mjs::market_quote_asof_kickoff_no_leak` (backtest) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test), backtest(leak-safe).
**Traceability:** `scripts/models/game_model.py`, `scripts/harness/metrics.py`, `data/meta.json`.

### P3-S3 — Fitted hybrid blend of full vectors   ·  Status: 🟡   ·  Est: L
**As** a Modeler **I want** the ensemble to combine models by weighted-blending their full probability vectors **so that** confidence is preserved and the output stays calibrated.
**Acceptance criteria** (Given/When/Then):
- P3-S3-AC1 — Given per-model vectors and fitted blend weights, When the ensemble predicts, Then output = normalized weighted sum of the *full vectors* (`Σ wᵢ·pᵢ`, renormalized), and the code path contains no averaging of collapsed picks.
- P3-S3-AC2 — Given blend weights, When they are applied, Then they are non-negative and sum to 1 (a proper mixture); weights come from the fit, never hand-set.
- P3-S3-AC3 — Given the blended vector, When compared to inputs, Then it remains a valid probability vector (sum-to-1 ±1e-6, bounded) — verified per event.
- P3-S3-AC4 — Given only pre-kickoff information, When blend weights are fit, Then fitting uses the P2 leak-safe walk-forward and log-loss objective (no separate, laxer path).
**Tasks:**
- [ ] P3-S3-T1 — Implement full-vector weighted blend + renormalization in `scripts/models/game_model.py`.
- [ ] P3-S3-T2 — Constrain blend weights to the simplex (non-negative, sum-to-1).
- [ ] P3-S3-T3 — Fit blend weights via the P2 optimizer (log-loss, leak-safe) — reuse, don't fork.
- [ ] P3-S3-T4 — Unit-test that no code path collapses to picks before blending.
**QA coverage:**
- P3-S3-AC1 → `tests/feature/ensemble.test.mjs::blend_is_full_vector_weighted_sum` (unit) — Planned
- P3-S3-AC2 → `tests/feature/ensemble.test.mjs::blend_weights_on_simplex_from_fit` (unit) — Planned
- P3-S3-AC3 → `tests/feature/ensemble.test.mjs::blend_output_valid_prob_vector` (unit) — Planned
- P3-S3-AC4 → `tests/feature/ensemble.test.mjs::blend_fit_uses_leaksafe_logloss` (backtest) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test), backtest(leak-safe).
**Traceability:** `scripts/models/game_model.py`, `scripts/harness/metrics.py`, `data/meta.json`.

### P3-S4 — Directional disagreement → take the max, never average   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** the ensemble to take the argmax (higher-conviction side) on directional disagreement rather than average opposing picks **so that** the output is never a mushy, worse-than-either 50%.
**Acceptance criteria** (Given/When/Then):
- P3-S4-AC1 — Given two models that pick opposite sides, When the ensemble resolves the direction, Then it adopts the argmax of the blended full vector (the higher-conviction directional call) and never returns the mean of the two point picks.
- P3-S4-AC2 — Given a case where naive pick-averaging would output ~0.50 / a coin-flip, When the ensemble runs, Then its output conviction is strictly off 0.50 (it commits to a side) and matches the blended-vector argmax.
- P3-S4-AC3 — Given agreement (models pick the same side), When the ensemble resolves, Then the blended vector and its argmax agree with both models (no spurious flip).
**Tasks:**
- [ ] P3-S4-T1 — Implement directional resolution as argmax over the blended vector.
- [ ] P3-S4-T2 — Add an explicit "never average point picks" guard/assertion in the disagreement path.
- [ ] P3-S4-T3 — Unit-test the opposite-pick case (no 50% mush) and the agreement case (no flip).
**QA coverage:**
- P3-S4-AC1 → `tests/feature/ensemble.test.mjs::disagreement_takes_argmax_not_mean` (unit) — Planned
- P3-S4-AC2 → `tests/feature/ensemble.test.mjs::no_mushy_coinflip_on_disagreement` (unit) — Planned
- P3-S4-AC3 → `tests/feature/ensemble.test.mjs::agreement_no_spurious_flip` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`, `tests/feature/ensemble.test.mjs`.

### P3-S5 — Refit-on-cron stacker   ·  Status: ⬜   ·  Est: M
**As** an Operator **I want** blend weights refit on a cron and adopted only through the NEVER REGRESS gate **so that** the ensemble improves over the season without ever shipping a worse blend.
**Acceptance criteria** (Given/When/Then):
- P3-S5-AC1 — Given new finished events (STATUS_FINAL only), When the stacker refits on cron, Then it recomputes blend weights on the leak-safe set and routes the candidate through the P2 NEVER REGRESS gate (margin 0.0015) before any write to `data/meta.json`.
- P3-S5-AC2 — Given only FINAL events count, When the refit assembles training data, Then live/half/scheduled-stub records are excluded from the fit (status-gating).
- P3-S5-AC3 — Given a refit that fails the gate, When it completes, Then blend weights in `data/meta.json` are left byte-identical and the run reports "REGRESS-BLOCKED".
- P3-S5-AC4 — Given a deploy of new ensemble weights, When it ships, Then the rollback (one `git revert` of the `data/meta.json` commit) is stated in the run log before write.
**Tasks:**
- [ ] P3-S5-T1 — Implement the stacker refit and wire it into the cron behind the NEVER REGRESS gate.
- [ ] P3-S5-T2 — Enforce STATUS_FINAL-only training data (status-gating) at assembly.
- [ ] P3-S5-T3 — On gate-fail, no-write; report blocked. On pass, write weights + rollback line.
- [ ] P3-S5-T4 — Smoke-test the ordered refit → gate → conditional-write path.
**QA coverage:**
- P3-S5-AC1 → `tests/feature/ensemble.test.mjs::stacker_refit_routes_never_regress` (unit) — Planned
- P3-S5-AC2 → `tests/feature/ensemble.test.mjs::stacker_trains_on_final_only` (unit) — Planned
- P3-S5-AC3 → `tests/smoke.sh::stacker_block_no_write` (smoke) — Planned
- P3-S5-AC4 → manual (rollback drill) — documented; one `git revert`
  Coverage: 3/4 automatable = 75% automated; AC4 manual-only. Automatable ACs covered: 3/3 = 100%. Test types: unit(node:test), smoke(bash), manual.
**Traceability:** `scripts/models/game_model.py`, `scripts/harness/metrics.py`, `data/meta.json`, `.github/workflows/gameday.yml`, `tests/feature/ensemble.test.mjs`, `tests/smoke.sh`.
