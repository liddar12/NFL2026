# N3 · Game Model & Weekly Winners
**Layer:** NFL Adapter   ·   **Status:** 🟡   ·   **Instantiates:** P3 (Multi-Model Ensemble)
**Reuse:** A future adapter keeps the platform blender contract — combine full probability VECTORS, take element-wise MAX on directional disagreement, never average point picks; uniform start weights refit by the optimizer; log-loss/Brier evaluation via the harness. It re-authors this file's NFL specifics: the two-way (no-draw) outcome space, the Elo scale + home-field constant, the market ingestion, and the situational adjustments (rest, travel, weather, injury).

## Goal
Emit a full two-way win-probability vector `{home, away}` (sums to 1) per game, matching `data/contracts/game_predictions.schema.json`, by blending an Elo source, a market-implied source, and the J5L composite. Adjust for home-field, rest differential, travel, weather and injury impact. Rank weekly winners by model probability versus market-implied probability so the biggest model-vs-market edges surface first. The blend obeys the cardinal invariant: full-vector blend when sources agree on the favorite, element-wise max when they disagree — never a manufactured coin flip.

## Why it matters / risk if skipped
The blend invariant is inherited from wc2026 and is the difference between honest and dishonest aggregation. If Elo says home 0.60 and the market says away 0.60, averaging lands near 0.50/0.50 — throwing away strong, opposing evidence and inventing a coin flip neither model believes. Taking the max preserves the strongest directional signal. Skip this and the model produces confident mush on exactly the games where the edge is largest. The weekly-winners ranking is only trustworthy if the underlying vectors are blended honestly and evaluated by log-loss, not by how often the favorite won.

## User stories

### N3-S1 — Full-vector blend with max-on-disagreement   ·  Status: 🟡   ·  Est: L
**As** the Modeler **I want** the Elo/market/J5L vectors blended by the agree→weighted-average, disagree→element-wise-max rule **so that** opposing strong evidence is preserved rather than averaged into a coin flip.
**Acceptance criteria** (Given/When/Then):
- N3-S1-AC1 — Given sources that agree on the favorite, When blended, Then `final = normalize(Σ w_i · vec_i)` (full-vector weighted average).
- N3-S1-AC2 — Given sources that disagree on the favorite (e.g. Elo home 0.60, market away 0.60), When blended, Then `final = normalize(elementwise_max_i vec_i)` and the result is NOT a ~0.50/0.50 average.
- N3-S1-AC3 — Given any emitted prediction, When validated, Then the vector is two-way `{home, away}`, both in (0,1), summing to 1.0 within 1e-9, matching `game_predictions.schema.json`.
- N3-S1-AC4 — Given no source has been hand-tuned, When blending starts, Then weights are uniform across whatever sources are present and only the optimizer may refit them.
**Tasks:**
- [ ] N3-S1-T1 — Favorite-agreement detector across source vectors.
- [ ] N3-S1-T2 — Agree path: normalized weighted-vector average.
- [ ] N3-S1-T3 — Disagree path: element-wise max + renormalize.
- [ ] N3-S1-T4 — Uniform start weights across present sources.
- [ ] N3-S1-T5 — Schema-validate two-way sum-to-1 output.
**QA coverage:**
- N3-S1-AC1 → `tests/feature/game_model.test.mjs::agree_weighted_average` (unit) — Planned
- N3-S1-AC2 → `tests/feature/game_model.test.mjs::disagree_takes_max` (unit) — Planned
- N3-S1-AC3 → `scripts/validate_data.py::game_prediction_contract` (data) — Planned
- N3-S1-AC4 → `tests/feature/game_model.test.mjs::uniform_start_weights` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/models/game_model.py`, `data/contracts/game_predictions.schema.json`, `data/game_predictions.json`, `scripts/validate_data.py`.

### N3-S2 — Elo source (scale + home-field)   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** a standard-scale Elo source vector **so that** the blend has a self-contained baseline that needs no external feed.
**Acceptance criteria** (Given/When/Then):
- N3-S2-AC1 — Given two teams with equal Elo on a neutral field, When predicted, Then the vector is 0.50/0.50 within 1e-9.
- N3-S2-AC2 — Given a home team, When home-field is applied (~65 Elo points ≈ the long-run NFL edge), Then the home win probability rises by the logistic 400-point-scale amount, not a hard-coded bump.
- N3-S2-AC3 — Given a FINAL result, When Elo updates, Then only STATUS-gated final games move ratings (in-progress/scheduled never update Elo).
**Tasks:**
- [ ] N3-S2-T1 — 400-point logistic Elo expectation.
- [ ] N3-S2-T2 — Home-field as an Elo-point offset (~65).
- [ ] N3-S2-T3 — STATUS-gated rating updates (finals only).
**QA coverage:**
- N3-S2-AC1 → `tests/feature/game_model.test.mjs::equal_elo_neutral_half` (unit) — Planned
- N3-S2-AC2 → `tests/feature/game_model.test.mjs::home_field_logistic` (unit) — Planned
- N3-S2-AC3 → `tests/feature/game_model.test.mjs::finals_only_update_elo` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`.

### N3-S3 — Market source ingestion   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** market-implied probabilities ingested as a first-class blend source **so that** the sharpest available signal usually carries the most weight.
**Acceptance criteria** (Given/When/Then):
- N3-S3-AC1 — Given raw two-way prices from N1, When converted, Then the market source vector is vig-removed and sums to 1.0 within 1e-6.
- N3-S3-AC2 — Given both The Odds API and Kalshi for one game, When present, Then each contributes as a distinct source the optimizer can weight independently.
- N3-S3-AC3 — Given no market line yet (pre-feed), When blending, Then the game model degrades gracefully to the remaining sources and records absence in `pipeline_status`.
**Tasks:**
- [ ] N3-S3-T1 — Consume N1 implied probabilities as a source vector.
- [ ] N3-S3-T2 — Keep Odds-API and Kalshi as separate weightable sources.
- [ ] N3-S3-T3 — Graceful degrade + status note when market absent.
**QA coverage:**
- N3-S3-AC1 → `tests/feature/game_model.test.mjs::market_vig_removed` (unit) — Planned
- N3-S3-AC2 → `tests/feature/game_model.test.mjs::two_market_sources` (unit) — Planned
- N3-S3-AC3 → `tests/feature/game_model.test.mjs::degrade_without_market` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`, `scripts/scrape/odds.py`, `data/pipeline_status.json`.

### N3-S4 — Situational adjustments (home-field, rest, travel, weather, injury)   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** rest differential, travel, weather and injury impact folded into the pre-blend vectors **so that** context beyond raw ratings is represented.
**Acceptance criteria** (Given/When/Then):
- N3-S4-AC1 — Given a rest-day differential (e.g. off a bye vs a short week), When applied, Then the rested team's win probability increases monotonically with the rest gap.
- N3-S4-AC2 — Given travel distance / time-zone shift, When applied, Then the traveling team is penalized proportionally and a neutral-site game applies no home-field.
- N3-S4-AC3 — Given an indoor venue, When weather is applied, Then the weather adjustment is neutral (roof state from `teams.json`); outdoor high-wind games shift toward the run-favored/lower-scoring side.
- N3-S4-AC4 — Given a key injury (e.g. starting QB out), When applied, Then injury impact shifts the vector against that team, bounded so a single input can't invert a large rating gap.
**Tasks:**
- [ ] N3-S4-T1 — Rest-differential adjustment monotone in the gap.
- [ ] N3-S4-T2 — Travel/time-zone penalty; neutral-site suppresses home-field.
- [ ] N3-S4-T3 — Weather adjustment gated by roof (indoor → neutral).
- [ ] N3-S4-T4 — Injury-impact adjustment with bounds/clamp.
**QA coverage:**
- N3-S4-AC1 → `tests/feature/game_model.test.mjs::rest_monotone` (unit) — Planned
- N3-S4-AC2 → `tests/feature/game_model.test.mjs::travel_penalty_neutral_site` (unit) — Planned
- N3-S4-AC3 → `tests/feature/game_model.test.mjs::weather_roof_gated` (unit) — Planned
- N3-S4-AC4 → `tests/feature/game_model.test.mjs::injury_bounded` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`, `scripts/signals/weather.py`, `data/fixtures/teams.json`.

### N3-S5 — Weekly winners ranked by model-vs-market edge   ·  Status: 🟡   ·  Est: M
**As** the Analyst **I want** each week's games ranked by model probability minus market-implied probability **so that** the biggest edges (not just the biggest favorites) surface first.
**Acceptance criteria** (Given/When/Then):
- N3-S5-AC1 — Given a week's predictions and market lines, When ranked, Then games sort by `model_prob − implied_prob` (edge) descending, and the emitted list carries both numbers per game.
- N3-S5-AC2 — Given a game with no market line, When ranked, Then it is flagged "no-line" and excluded from edge ranking (never assigned a fabricated edge).
- N3-S5-AC3 — Given the emitted picks, When surfaced, Then each is the full-vector pick (favorite + probability), never a point-spread average.
**Tasks:**
- [ ] N3-S5-T1 — Edge = model_prob − implied_prob per game.
- [ ] N3-S5-T2 — Descending edge sort; carry both probabilities.
- [ ] N3-S5-T3 — Exclude / flag no-line games from ranking.
**QA coverage:**
- N3-S5-AC1 → `tests/feature/game_model.test.mjs::rank_by_edge` (unit) — Planned
- N3-S5-AC2 → `tests/feature/game_model.test.mjs::no_line_excluded` (unit) — Planned
- N3-S5-AC3 → `tests/feature/game_model.test.mjs::full_vector_pick` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/game_model.py`, `data/game_predictions.json`.

### N3-S6 — Evaluation: log-loss / Brier, leak-safe   ·  Status: 🟡   ·  Est: M
**As** the Modeler **I want** the game model scored by log-loss and Brier on resolved games **so that** blend weights earn their place against measured calibration, not narrative.
**Acceptance criteria** (Given/When/Then):
- N3-S6-AC1 — Given resolved FINAL games, When evaluated, Then the harness emits log-loss and Brier vs actual outcomes.
- N3-S6-AC2 — Given a walk-forward split, When evaluating, Then only pre-kickoff data feeds each game's prediction (leak-safe, no lookahead).
- N3-S6-AC3 — Given an optimizer weight proposal, When it fails to beat the current out-of-sample log-loss by the NEVER-REGRESS margin (0.0015), Then it is rejected.
**Tasks:**
- [ ] N3-S6-T1 — Log-loss + Brier in `scripts/harness/metrics.py` for two-way vectors.
- [ ] N3-S6-T2 — Leak-safe walk-forward feed via `scripts/harness/snapshot.py`.
- [ ] N3-S6-T3 — NEVER-REGRESS 0.0015 gate on blend-weight refits.
**QA coverage:**
- N3-S6-AC1 → `tests/feature/metrics.test.mjs::logloss_brier` (unit) — Planned
- N3-S6-AC2 → `tests/feature/backtest_honesty.test.mjs::no_lookahead` (backtest) — Planned
- N3-S6-AC3 → `tests/feature/never_regress.test.mjs::margin_0_0015` (backtest) — Done
- Coverage: 3/3 = 100%. Test types: unit(node:test), backtest(leak-safe).
**Traceability:** `scripts/models/game_model.py`, `scripts/harness/metrics.py`, `scripts/harness/snapshot.py`, `scripts/optimize/never_regress.py`.
