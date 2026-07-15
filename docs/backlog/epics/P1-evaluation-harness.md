# P1 · Evaluation Harness

**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter (NBA/MLB/Kalshi) reuses this epic wholesale — the metrics, honesty contract, snapshot schema, and conformal layer are domain-agnostic. It re-authors only the *event producer* (what a "row" is: game vs player-week vs contract) and the RENAMES/normalization feeding `actual`. The validation unit — the event — never changes.

## Goal
Stand up the platform's #1 asset before any model is trusted: a point-in-time prediction archive plus the scoring layer that turns predictions into measured, comparable numbers. Every prediction is snapshotted with an information cutoff before its event resolves, then scored on resolution with proper metrics (log-loss, Brier, MAE, rank-correlation, calibration). Split-conformal safe sets are the user-facing honesty layer — a set of plausible outcomes with a coverage guarantee, not a false point estimate. The validation unit is the event, never the season.

## Why it matters / risk if skipped
Without a leak-safe archive you cannot prove a model is good — you can only claim it. The postmortems are explicit: frozen analytics and unwired signals ("a signal that doesn't reach the model does not exist") let unvalidated numbers masquerade as results. If snapshots are taken after kickoff, or if an estimate is allowed to carry a score, the entire leaderboard becomes fiction and every downstream gate (P8 baselines, NEVER REGRESS) is scoring noise. The harness is the measuring instrument; if it lies, nothing above it is real.

## User stories

### P1-S1 — Point-in-time snapshot archive   ·  Status: 🟡   ·  Est: M
**As** the Operator **I want** every prediction frozen with an explicit information cutoff before its event starts **so that** no post-event information can leak into the recorded number and the archive is a durable, auditable record from day one.
**Acceptance criteria** (Given/When/Then):
- P1-S1-AC1 — Given a call to `make_row(...)`, When the row is constructed, Then it is `resolved:false`, carries no `actual`/`brier`/`log_loss`, and defaults `estimate:true` unless the caller explicitly asserts `estimate=false`.
- P1-S1-AC2 — Given a row with `as_of_utc` later than the event kickoff, When it is validated, Then it is rejected: `as_of_utc` (information cutoff) must be `<= locked_utc <= kickoff`.
- P1-S1-AC3 — Given any file written to `data/snapshots/`, When `validate_data.py` runs, Then it validates against `data/contracts/snapshot.schema.json` (and an empty dir is a pass, not an error).
- P1-S1-AC4 — Given a resolved measurable row, When `resolve()` runs, Then `probs` must be present (brier/log-loss are only defined over a probability vector) or resolution raises.
**Tasks:**
- [ ] P1-S1-T1 — Confirm `make_row`/`resolve` defaults and the `estimate=true` default hold.
- [ ] P1-S1-T2 — Add the `as_of_utc <= locked_utc <= kickoff` ordering check in `snapshot.py`.
- [ ] P1-S1-T3 — Wire `data/snapshots/*.json` into `validate_data.py`'s snapshot-schema loop (already scaffolded at lines ~252–267).
- [ ] P1-S1-T4 — Emit the first real snapshot file from `game_predictions.json` (all day-zero estimates).
- [ ] P1-S1-T5 — Assert `resolve()` requires `probs` for measurable rows.
**QA coverage** (5 automatable ACs targeted; 4 ACs listed):
- P1-S1-AC1 → `tests/feature/backtest_honesty.test.mjs::every honest snapshot shape passes` (unit) — Done
- P1-S1-AC2 → `tests/feature/snapshot.test.mjs::as_of ordering rejected` (unit) — Planned
- P1-S1-AC3 → `scripts/validate_data.py::snapshot schema loop` (data) + `tests/smoke.sh` — Done
- P1-S1-AC4 → `tests/feature/snapshot.test.mjs::resolve requires probs` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test) | data(validate_data) | smoke(bash).
**Traceability:** `scripts/harness/snapshot.py`, `data/contracts/snapshot.schema.json`, `data/snapshots/`, `scripts/validate_data.py`, `tests/feature/backtest_honesty.test.mjs`.

### P1-S2 — Event-level scoring metrics   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** proper, dependency-free scoring metrics computed per event **so that** two models can be compared on the same held-out events with numbers that agree to the bit across Python and Node.
**Acceptance criteria** (Given/When/Then):
- P1-S2-AC1 — Given `probs=[0.7,0.3]`, `true=0`, When scored, Then `log_loss == -ln(0.7)` and `brier == 0.18` exactly.
- P1-S2-AC2 — Given a realized outcome with predicted probability 0, When log-loss is computed, Then the result is finite (probabilities clamped to `[EPS, 1-EPS]`, `EPS=1e-15`) — never `-inf`.
- P1-S2-AC3 — Given `pred=[10,20,30]`, `actual=[12,18,33]`, When MAE is computed, Then it equals `7/3`; identical sequences give `0`.
- P1-S2-AC4 — Given predicted vs actual sequences, When rank-correlation is computed, Then it matches Pearson-on-ranks; and calibration_bins(n_bins=10) returns per-bin (mean_pred, observed_freq, count) summing to the input count.
- P1-S2-AC5 — Given aggregation over events, When `multiclass_log_loss(rows)` is called, Then the unit is the mean over events (the caller controls the unit; never season-level implicit rollup).
**Tasks:**
- [ ] P1-S2-T1 — Keep `metrics.py` formulas simple/pure so the Node mirror re-implements identical arithmetic.
- [ ] P1-S2-T2 — Lock exact constants (`-ln(0.7)`, `0.18`, `7/3`, `EPS`) in the Node test.
- [ ] P1-S2-T3 — Verify calibration_bins edge behavior (empty bins, all-in-one-bin).
- [ ] P1-S2-T4 — Verify `_ranks` handles ties (average ranks) before `_pearson`.
- [ ] P1-S2-T5 — Assert `y_true_idx` out-of-range raises `IndexError`.
**QA coverage** (5 ACs):
- P1-S2-AC1 → `tests/feature/metrics.test.mjs::brier ... equals exactly 0.18` + `::log_loss ... equals -ln(0.7)` (unit) — Done
- P1-S2-AC2 → `tests/feature/metrics.test.mjs::log_loss ... confident-correct ~0` (unit) — Done
- P1-S2-AC3 → `tests/feature/metrics.test.mjs::mae ... equals 7/3` + `::mae is 0 for identical` (unit) — Done
- P1-S2-AC4 → `tests/feature/metrics.test.mjs::rank_corr/calibration_bins` (unit) — Planned
- P1-S2-AC5 → `tests/feature/metrics.test.mjs::multiclass_log_loss mean over events` (unit) — Planned
  Coverage: 5/5 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/harness/metrics.py`, `tests/feature/metrics.test.mjs`.

### P1-S3 — Split-conformal safe sets (85% / 70%)   ·  Status: 🟡   ·  Est: M
**As** the Analyst **I want** a set of plausible outcomes with a coverage guarantee instead of a single false point pick **so that** the UI communicates genuine uncertainty — a wider set means we are less sure.
**Acceptance criteria** (Given/When/Then):
- P1-S3-AC1 — Given calibration nonconformity scores (`1 - p_true`) and coverage `c`, When `calibrate` runs, Then the threshold is the `k`-th smallest score with `k = ceil((n+1)*c)` (finite-sample +1 correction).
- P1-S3-AC2 — Given `k > n` (too few calibration points), When calibrating, Then the threshold is `1.0` (all-inclusive), never a falsely tight set.
- P1-S3-AC3 — Given a fixed eval set at target `0.8`, When empirical coverage is measured, Then observed coverage `>= 0.8`.
- P1-S3-AC4 — Given two coverages, When both thresholds are computed, Then the higher target yields a threshold at least as inclusive (monotonicity), and the platform exposes exactly `(0.85, 0.70)` via `safe_sets_85_70`.
- P1-S3-AC5 — Given a probability vector and a threshold, When `safe_set` runs, Then it includes every class with `p_k >= 1 - threshold`.
**Tasks:**
- [ ] P1-S3-T1 — Keep LAC scheme deterministic (sorting only), stdlib-only.
- [ ] P1-S3-T2 — Expose `COVERAGES = (0.85, 0.70)` and `safe_sets_85_70` as the only public entry the UI calls.
- [ ] P1-S3-T3 — Feed conformal from resolved snapshot rows (real calibration set) rather than fixtures.
- [ ] P1-S3-T4 — Guard `0 < coverage < 1` and raise otherwise.
**QA coverage** (5 ACs):
- P1-S3-AC1 → `tests/feature/conformal.test.mjs::calibrate at coverage 0.8 ... 9th smallest` (unit) — Done
- P1-S3-AC2 → `tests/feature/conformal.test.mjs::too-few calibration points fall back` (unit) — Done
- P1-S3-AC3 → `tests/feature/conformal.test.mjs::empirical coverage meets the 0.8 target` (unit) — Done
- P1-S3-AC4 → `tests/feature/conformal.test.mjs::higher target coverage ... more inclusive` (unit) — Done
- P1-S3-AC5 → `tests/feature/conformal.test.mjs::safe_set membership` (unit) — Planned
  Coverage: 5/5 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/harness/conformal.py`, `tests/feature/conformal.test.mjs`.

### P1-S4 — Estimate-vs-measured honesty contract   ·  Status: 🟡   ·  Est: S
**As** the Analyst **I want** the harness to structurally forbid an estimate from carrying a measured score **so that** the frontend can never dress an unvalidated guess up as a backtested result. (Enforcement escalates in P8; the contract is produced correctly here.)
**Acceptance criteria** (Given/When/Then):
- P1-S4-AC1 — Given `estimate=true`, When validated, Then `brier`/`log_loss` must be absent or null; presence raises `HonestyError`.
- P1-S4-AC2 — Given `estimate=false & resolved=true`, When validated, Then both `brier` and `log_loss` must be present non-null; a missing score raises (a measured row without receipts is a silent regression).
- P1-S4-AC3 — Given `estimate=false & resolved=false`, When validated, Then scores must be absent/null (attaching them early is a leak) and the row is allowed unscored.
**Tasks:**
- [ ] P1-S4-T1 — Keep `honesty.validate` boolean-returning (usable in assert/filter) and raising on violation.
- [ ] P1-S4-T2 — Treat absent and explicit-null identically as "no score".
- [ ] P1-S4-T3 — Mirror the exact contract in the Node test (both languages lock it).
**QA coverage** (3 ACs):
- P1-S4-AC1 → `tests/feature/backtest_honesty.test.mjs::dishonest rows are rejected` (bad_est_scored) — Done
- P1-S4-AC2 → `tests/feature/backtest_honesty.test.mjs::every measured+resolved row carries brier and log_loss` (unit) — Done
- P1-S4-AC3 → `tests/feature/backtest_honesty.test.mjs::dishonest rows are rejected` (bad_leak) — Done
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/harness/honesty.py`, `tests/feature/backtest_honesty.test.mjs`.

### P1-S5 — Contracts & data validation for snapshots   ·  Status: 🟡   ·  Est: S
**As** the Operator **I want** every snapshot and prediction file validated against a JSON schema in the regression gate **so that** a malformed or dishonest row fails the gate on exit code before it can deploy.
**Acceptance criteria** (Given/When/Then):
- P1-S5-AC1 — Given `data/snapshots/*.json`, When `validate_data.py` runs, Then each file validates against `snapshot.schema.json` and the script exits non-zero on any violation.
- P1-S5-AC2 — Given the committed `data/game_predictions.json`, When the honesty test runs, Then every game is `estimate:true` and carries no `brier`/`log_loss` (day-zero estimates only).
- P1-S5-AC3 — Given the gate is invoked, When results are evaluated, Then pass/fail is decided on EXIT CODES only (never by grepping ANSI-colored summaries).
**Tasks:**
- [ ] P1-S5-T1 — Keep the snapshot-schema loop in `validate_data.py` (~lines 252–267) and cover the empty-dir pass.
- [ ] P1-S5-T2 — Ensure `game_predictions.schema.json` requires the `estimate` field.
- [ ] P1-S5-T3 — Keep `run_gate.sh` gating on exit codes in order (validate → smoke → feature).
**QA coverage** (3 ACs):
- P1-S5-AC1 → `scripts/validate_data.py` (data) via `tests/run_gate.sh` step 1 — Done
- P1-S5-AC2 → `tests/feature/backtest_honesty.test.mjs::committed game_predictions.json are estimates` (unit) — Done
- P1-S5-AC3 → `tests/run_gate.sh` exit-code semantics (smoke) — Done
  Coverage: 3/3 = 100%. Test types: data(validate_data) | unit(node:test) | smoke(bash).
**Traceability:** `scripts/validate_data.py`, `data/contracts/snapshot.schema.json`, `data/contracts/game_predictions.schema.json`, `tests/run_gate.sh`, `data/snapshots/`.
