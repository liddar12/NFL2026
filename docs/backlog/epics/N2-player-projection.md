# N2 · Player Projection Engine
**Layer:** NFL Adapter   ·   **Status:** 🟡   ·   **Instantiates:** P3 (Multi-Model Ensemble), P4 (Signal Registry & Contribution)
**Reuse:** A future adapter keeps the platform seams intact — the `baseline × ∏ signals → point + conformal interval` identity, the weight-0 "signals start neutral" gate, `signals_used` honesty, and MAE/rank-corr evaluation via the harness. It re-authors this file's NFL specifics: the per-position age curves (RB cliff ≠ QB cliff), the OL-vs-DL composite, target/touch competition, and the roster of named signals.

## Goal
Produce one honest projection per player — `proj_points` with a conformal `low`/`high` band — matching `data/contracts/player_projections.schema.json`. The point estimate is a recency-weighted prior baseline scaled multiplicatively by position-specific age curves and a roster of contextual signals; each signal is *computed but neutral until it earns weight*. Evaluation is by MAE and rank correlation against resolved actuals, never by eyeball. Harness-first: the metric harness and conformal interval exist before any signal is trusted with influence.

## Why it matters / risk if skipped
The projection is the product's core claim. Two postmortems govern it. First, unwired signals: "a signal that doesn't reach the model does not exist" — a signal computed but never given weight, or given weight without out-of-sample proof, is theater. The weight-0 gate makes day-zero honest (`signals_used == []`) and forces each signal to earn influence against walk-forward evidence. Second, estimate-vs-measured honesty: the `low`/`high` band is an *estimate* of spread until enough resolved player-weeks let the conformal machinery replace it with a calibrated interval — it must never be presented as measured coverage.

## User stories

### N2-S1 — Projection identity: baseline × signals → point + interval   ·  Status: 🟡   ·  Est: L
**As** the Modeler **I want** `proj_points = baseline(prior_perf) × ∏ applied(signal)` with a labelled `low`/`high` band **so that** every projection is a transparent, decomposable product rather than a black box.
**Acceptance criteria** (Given/When/Then):
- N2-S1-AC1 — Given all signals at weight 0 (day zero), When a player is projected, Then `applied(signal) == 1.0` for every signal, `proj_points` collapses to the pure prior-perf baseline, and `signals_used == []`.
- N2-S1-AC2 — Given a signal with fitted weight `w` and raw adjustment `adj`, When applied, Then influence is `applied = 1 + w·(adj − 1)` (weight gates influence) and only non-zero-weight signals that moved the projection appear in `signals_used`.
- N2-S1-AC3 — Given any projection record, When validated, Then it matches `player_projections.schema.json` (`gsis_id, name, team, position, proj_points, low, high, signals_used`) with `low ≤ proj_points ≤ high`.
- N2-S1-AC4 — Given the band, When surfaced, Then it is labelled an estimate of spread (widened by position volatility + player uncertainty), never as measured conformal coverage until the harness certifies it.
**Tasks:**
- [ ] N2-S1-T1 — Implement the multiplicative identity over the signal set.
- [ ] N2-S1-T2 — `applied = 1 + w·(adj−1)` weight gate reading `data/meta.json`.
- [ ] N2-S1-T3 — `signals_used` filter (non-zero weight AND moved the number).
- [ ] N2-S1-T4 — Placeholder spread band widened by position volatility + uncertainty.
- [ ] N2-S1-T5 — Schema-validate every emitted record.
**QA coverage:**
- N2-S1-AC1 → `tests/feature/player_projection.test.mjs::day_zero_neutral` (unit) — Planned
- N2-S1-AC2 → `tests/feature/player_projection.test.mjs::weight_gates_influence` (unit) — Planned
- N2-S1-AC3 → `scripts/validate_data.py::player_projection_contract` (data) — Planned
- N2-S1-AC4 → `tests/feature/player_projection.test.mjs::band_labelled_estimate` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/models/player_projection.py`, `data/contracts/player_projections.schema.json`, `data/meta.json`, `scripts/validate_data.py`.

### N2-S2 — Position-specific age curves   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** distinct QB/RB/WR/TE age curves **so that** an RB's early cliff and a QB's long plateau are modelled, not averaged into one wrong curve.
**Acceptance criteria** (Given/When/Then):
- N2-S2-AC1 — Given a piecewise-linear curve with knots `ramp_start .. peak_start .. peak_end .. decline`, When evaluated inside the prime plateau, Then `age_multiplier == 1.0`; below `ramp_start` it returns a hard rookie floor; above `peak_end` it declines at `decline_per_yr` clamped to a floor.
- N2-S2-AC2 — Given RB vs QB at age 30, When compared, Then the RB multiplier is materially lower than the QB multiplier (RB cliff earlier and steeper) — asserted numerically, not by inspection.
- N2-S2-AC3 — Given ages sweeping the full range for each position, When evaluated, Then the curve is continuous (no discontinuities at knots) and monotone non-increasing past `peak_end`.
**Tasks:**
- [ ] N2-S2-T1 — Four-knot curve config per position (QB/RB/WR/TE).
- [ ] N2-S2-T2 — Piecewise-linear evaluator with rookie floor + decline clamp.
- [ ] N2-S2-T3 — Encode RB-earlier-cliff / QB-longer-plateau knot values.
- [ ] N2-S2-T4 — Continuity + monotonic-decline assertions.
**QA coverage:**
- N2-S2-AC1 → `tests/feature/aging_curve.test.mjs::plateau_is_one` (unit) — Planned
- N2-S2-AC2 → `tests/feature/aging_curve.test.mjs::rb_cliff_below_qb` (unit) — Planned
- N2-S2-AC3 → `tests/feature/aging_curve.test.mjs::continuous_monotone` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/aging.py`, `scripts/models/player_projection.py`.

### N2-S3 — OL-composite-vs-DL signal (mass + continuity)   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** an O-line-vs-D-line adjustment weighing combined mass/strength and continuity **so that** OL-dependent production (RB rushing above all) is scaled by the blocking matchup, not credited entirely to the ball-carrier.
**Acceptance criteria** (Given/When/Then):
- N2-S3-AC1 — Given a heavier/stronger O-line facing weaker D-lines, When adjusted, Then `ol_dl_adjustment > 1.0`; the reverse matchup yields `< 1.0`; a neutral matchup ≈ 1.0.
- N2-S3-AC2 — Given two lines equal in talent but one with far more games started together as a unit, When compared, Then the higher-continuity unit gets the larger adjustment (continuity term rewards games-as-a-unit).
- N2-S3-AC3 — Given position, When applying the signal, Then RB rushing receives the largest share, QB clean-pocket/sack-avoidance a smaller share, and non-dependent production is unaffected.
**Tasks:**
- [ ] N2-S3-T1 — OL mass/strength composite vs DL faced.
- [ ] N2-S3-T2 — Continuity term = games the current starting five has played together.
- [ ] N2-S3-T3 — Position-weighted application (RB > QB > others).
- [ ] N2-S3-T4 — Bounds/clamp so an extreme matchup can't explode the product.
**QA coverage:**
- N2-S3-AC1 → `tests/feature/ol_dl_signal.test.mjs::matchup_direction` (unit) — Planned
- N2-S3-AC2 → `tests/feature/ol_dl_signal.test.mjs::continuity_rewarded` (unit) — Planned
- N2-S3-AC3 → `tests/feature/ol_dl_signal.test.mjs::rb_share_largest` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/ol_dl.py`, `scripts/models/player_projection.py`.

### N2-S4 — Target / touch competition signal   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** a signal for teammates who take targets/touches off a player **so that** a crowded backfield or receiver room correctly deflates opportunity-dependent production.
**Acceptance criteria** (Given/When/Then):
- N2-S4-AC1 — Given a new teammate who commands targets/touches at a player's position, When adjusted, Then the player's opportunity-dependent projection decreases (`adj < 1.0`), scaled by the competitor's expected share.
- N2-S4-AC2 — Given a teammate departure/injury that frees targets, When adjusted, Then the remaining player's projection increases (`adj > 1.0`).
- N2-S4-AC3 — Given total team opportunity is finite, When shares are computed, Then allocated shares across teammates at a position sum to ≤ 1.0 (no manufactured volume).
**Tasks:**
- [ ] N2-S4-T1 — Opportunity-share model from depth chart + snap/target history.
- [ ] N2-S4-T2 — Competitor-driven deflation/inflation of the focal player.
- [ ] N2-S4-T3 — Conservation assertion: shares sum to ≤ 1.0 per team-position.
**QA coverage:**
- N2-S4-AC1 → `tests/feature/targets_signal.test.mjs::competitor_deflates` (unit) — Planned
- N2-S4-AC2 → `tests/feature/targets_signal.test.mjs::departure_inflates` (unit) — Planned
- N2-S4-AC3 → `tests/feature/targets_signal.test.mjs::shares_conserve` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/targets.py`, `scripts/models/player_projection.py`.

### N2-S5 — Context signal suite (registered at weight 0)   ·  Status: 🟡   ·  Est: L
**As** the Modeler **I want** the remaining named context signals registered and computed **so that** each can be handed weight later only against out-of-sample proof.
Signals in scope: injury status/history, QB accuracy delta, coordinator/HC changes, scheme fit, supporting-cast delta, 1-on-1 matchup, schedule strength, home/away, indoor/outdoor, weather, rest, off-field.
**Acceptance criteria** (Given/When/Then):
- N2-S5-AC1 — Given each signal, When registered in `scripts/signals/registry.py`, Then it enters at weight 0.0 and is listed in `data/meta.json`.
- N2-S5-AC2 — Given weather + indoor/outdoor, When the game is indoors, Then the weather signal returns a neutral adjustment (1.0) regardless of forecast.
- N2-S5-AC3 — Given any registered signal at weight 0, When a player is projected, Then it is computed but does not move `proj_points` (neutral influence) and does not appear in `signals_used`.
**Tasks:**
- [ ] N2-S5-T1 — Register all listed signals at weight 0.0.
- [ ] N2-S5-T2 — Implement each raw `adj` around 1.0 (injury, QB accuracy, coordinator/HC, scheme fit, supporting cast, 1-on-1, SoS, home/away, indoor/outdoor, weather, rest, off-field).
- [ ] N2-S5-T3 — Indoor→neutral wiring for weather.
- [ ] N2-S5-T4 — Assert weight-0 neutrality across the full suite.
**QA coverage:**
- N2-S5-AC1 → `tests/feature/signal_registry.test.mjs::signals_enter_at_zero` (unit) — Planned
- N2-S5-AC2 → `tests/feature/weather_roof.test.mjs::indoor_is_neutral` (unit) — Planned
- N2-S5-AC3 → `tests/feature/player_projection.test.mjs::day_zero_neutral` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/registry.py`, `scripts/signals/weather.py`, `data/meta.json`, `scripts/models/player_projection.py`.

### N2-S6 — Evaluation: MAE + rank correlation vs actuals   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** projections scored by MAE and rank correlation on resolved player-weeks **so that** signals earn weight against measured accuracy, never by eyeball.
**Acceptance criteria** (Given/When/Then):
- N2-S6-AC1 — Given resolved actuals, When evaluated, Then the harness emits MAE and rank-correlation (Spearman) per position and overall from `scripts/harness/metrics.py`.
- N2-S6-AC2 — Given a walk-forward split, When evaluating, Then scoring is leak-safe (only data available before each target week feeds that week's projection) — no lookahead.
- N2-S6-AC3 — Given a proposed weight change from the optimizer, When it does not improve out-of-sample MAE by at least the NEVER-REGRESS margin (0.0015), Then it is rejected.
**Tasks:**
- [ ] N2-S6-T1 — Wire projections into `scripts/harness/metrics.py` (MAE + Spearman).
- [ ] N2-S6-T2 — Leak-safe walk-forward snapshot feed (`scripts/harness/snapshot.py`).
- [ ] N2-S6-T3 — Gate weight changes on the 0.0015 NEVER-REGRESS margin.
**QA coverage:**
- N2-S6-AC1 → `tests/feature/metrics.test.mjs::mae_and_rankcorr` (unit) — Planned
- N2-S6-AC2 → `tests/feature/backtest_honesty.test.mjs::no_lookahead` (backtest) — Planned
- N2-S6-AC3 → `tests/feature/never_regress.test.mjs::margin_0_0015` (backtest) — Done
- Coverage: 3/3 = 100%. Test types: unit(node:test), backtest(leak-safe).
**Traceability:** `scripts/models/player_projection.py`, `scripts/harness/metrics.py`, `scripts/harness/snapshot.py`, `scripts/optimize/never_regress.py`.
