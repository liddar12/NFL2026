# N4 · Parlay Builder
**Layer:** NFL Adapter   ·   **Status:** 🟡   ·   **Instantiates:** P3 (Multi-Model Ensemble)
**Reuse:** A future adapter keeps the platform seams — edge = model_prob − implied_prob, the correlation-aware EV that never naively multiplies correlated legs, confidence tiering as a conformal proxy, and the "no fabricated positive edge without a real beatable line" honesty rule. It re-authors this file's NFL specifics: what counts as a same-game correlated pair (QB pass yards ↔ his WR receiving yards via shared game script) and the per-game/per-week volume targets.

## Goal
Emit at least three parlays per game AND at least three per week, each matching `data/contracts/parlays.schema.json` (`parlay_id, scope, game_id?, legs, model_ev, confidence_tier, correlation_note`). Parlays are assembled from edges — model probability exceeding market-implied probability. Same-game legs are treated as correlated (a shared game-script factor), so combined probability and EV use a correlation adjustment, never the naive independence product. Every parlay carries a model EV, a confidence tier, and an explicit correlation note.

## Why it matters / risk if skipped
Naive multiplication is the trap. A QB throwing for a big day and his WR going over receiving yards are not independent — they rise and fall together on a shared game script. Multiplying leg probabilities as if independent overstates negatively-correlated combos and understates positively-correlated ones; sportsbooks price or block same-game parlays for exactly this reason. A parlay builder that ignores correlation ships EV numbers that are confidently wrong. The second guardrail is price honesty: without a real, beatable line we derive implied probability from the model plus a standard hold — which yields a slightly negative single-leg edge — so we never manufacture a positive edge from thin air.

## User stories

### N4-S1 — Volume: ≥3 parlays per game AND ≥3 per week   ·  Status: 🟡   ·  Est: M
**As** the Analyst **I want** at least three same-game parlays for every game and at least three cross-game parlays for the week **so that** there is always a slate of options, ranked by edge.
**Acceptance criteria** (Given/When/Then):
- N4-S1-AC1 — Given a game with enough leg candidates, When the builder runs, Then it emits ≥3 parlays scoped to that game (`scope="game"`, `game_id` set).
- N4-S1-AC2 — Given a week's slate, When the builder runs, Then it emits ≥3 week-scoped parlays (`scope="week"`, no `game_id`).
- N4-S1-AC3 — Given a game with too few viable legs to form 3 parlays, When the builder runs, Then it emits what it can and records the shortfall in `pipeline_status` (never pads with junk legs to hit the count).
- N4-S1-AC4 — Given every emitted parlay, When validated, Then it matches `parlays.schema.json` with ≥2 legs each.
**Tasks:**
- [ ] N4-S1-T1 — Per-game parlay generation targeting ≥3.
- [ ] N4-S1-T2 — Per-week (cross-game) parlay generation targeting ≥3.
- [ ] N4-S1-T3 — Shortfall handling + status note (no junk-leg padding).
- [ ] N4-S1-T4 — Schema-validate all emitted parlays.
**QA coverage:**
- N4-S1-AC1 → `tests/feature/parlay_rules.test.mjs::at_least_three_per_game` (unit) — Done
- N4-S1-AC2 → `tests/feature/parlay_rules.test.mjs::at_least_three_per_week` (unit) — Done
- N4-S1-AC3 → `tests/feature/parlay_rules.test.mjs::shortfall_noted_not_padded` (unit) — Planned
- N4-S1-AC4 → `scripts/validate_data.py::parlays_contract` (data) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/models/parlay_builder.py`, `data/contracts/parlays.schema.json`, `data/parlays.json`, `tests/feature/parlay_rules.test.mjs`, `data/pipeline_status.json`.

### N4-S2 — Edge-driven leg selection   ·  Status: 🟡   ·  Est: M
**As** the Analyst **I want** legs chosen by model-vs-implied edge **so that** parlays are built from genuine advantages, not arbitrary popular props.
**Acceptance criteria** (Given/When/Then):
- N4-S2-AC1 — Given a leg with `model_prob` and book `implied_prob`, When its edge is computed, Then `edge = model_prob − implied_prob` and only legs above a stated edge threshold are eligible.
- N4-S2-AC2 — Given no real book line for a leg, When implied probability is derived from the model plus a standard hold, Then the single-leg edge is slightly negative (vig paid) and the builder does NOT present it as a positive edge.
- N4-S2-AC3 — Given a leg carries a real, beatable `implied_prob`, When selected, Then a genuine positive edge can appear and is recorded on the parlay.
**Tasks:**
- [ ] N4-S2-T1 — Edge = model_prob − implied_prob per leg.
- [ ] N4-S2-T2 — Eligibility threshold on edge.
- [ ] N4-S2-T3 — Hold-derived implied prob for no-line legs (negative edge, honest).
**QA coverage:**
- N4-S2-AC1 → `tests/feature/parlay_rules.test.mjs::edge_definition` (unit) — Planned
- N4-S2-AC2 → `tests/feature/parlay_rules.test.mjs::no_line_negative_edge` (unit) — Planned
- N4-S2-AC3 → `tests/feature/parlay_rules.test.mjs::real_line_positive_edge` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/parlay_builder.py`, `scripts/scrape/odds.py`.

### N4-S3 — Correlation-aware same-game EV   ·  Status: 🟡   ·  Est: L
**As** the Modeler **I want** same-game combined probability computed with a correlation adjustment **so that** EV reflects the shared game-script dependence between legs instead of a false independence product.
**Acceptance criteria** (Given/When/Then):
- N4-S3-AC1 — Given a positively-correlated same-game pair (QB pass yards ↔ his WR receiving yards), When combined, Then the correlation-adjusted probability is HIGHER than the naive product `p1·p2`, and the difference from the naive product is asserted numerically.
- N4-S3-AC2 — Given a negatively-correlated same-game pair, When combined, Then the adjusted probability is LOWER than the naive product.
- N4-S3-AC3 — Given a cross-game ("week") parlay, When combined, Then legs are treated as independent (ρ=0), the product is used, and the correlation note says "independent legs".
- N4-S3-AC4 — Given `model_ev`, When reported for a same-game parlay, Then it is computed from the correlation-adjusted probability (a correlation haircut vs the naive product), never the bare product.
**Tasks:**
- [ ] N4-S3-T1 — Pairwise correlation model (Gaussian-copula-lite) keyed on shared game-script.
- [ ] N4-S3-T2 — Adjusted combined probability for same-game legs.
- [ ] N4-S3-T3 — Independence (ρ=0) path for cross-game legs.
- [ ] N4-S3-T4 — `model_ev` from adjusted probability; assert ≠ naive product for correlated legs.
**QA coverage:**
- N4-S3-AC1 → `tests/feature/parlay_rules.test.mjs::positive_corr_above_product` (unit) — Planned
- N4-S3-AC2 → `tests/feature/parlay_rules.test.mjs::negative_corr_below_product` (unit) — Planned
- N4-S3-AC3 → `tests/feature/parlay_rules.test.mjs::cross_game_independent` (unit) — Planned
- N4-S3-AC4 → `tests/feature/parlay_rules.test.mjs::ev_uses_haircut_not_product` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/models/parlay_builder.py`, `tests/feature/parlay_rules.test.mjs`.

### N4-S4 — Confidence tier + correlation note per parlay   ·  Status: 🟡   ·  Est: S
**As** the Analyst **I want** each parlay tagged with a confidence tier and an explicit correlation note **so that** I can read its risk and dependence at a glance without re-deriving it.
**Acceptance criteria** (Given/When/Then):
- N4-S4-AC1 — Given a large edge on few legs, When tiered, Then `confidence_tier = "high"`; a thin edge or many legs yields "low" — a monotone, documented ordinal (a conformal-coverage proxy, not a probability).
- N4-S4-AC2 — Given a same-game parlay, When emitted, Then `correlation_note` is non-trivial and names the shared-game-script dependence; a week parlay's note explicitly says "independent legs".
- N4-S4-AC3 — Given the tier, When surfaced, Then it is labelled a heuristic ordinal until the harness certifies calibrated conformal tiers (estimate-vs-measured honesty).
**Tasks:**
- [ ] N4-S4-T1 — Tiering heuristic on (edge magnitude, leg count).
- [ ] N4-S4-T2 — Non-trivial correlation note for same-game; "independent legs" for week.
- [ ] N4-S4-T3 — Label tier as heuristic pending conformal certification.
**QA coverage:**
- N4-S4-AC1 → `tests/feature/parlay_rules.test.mjs::tier_monotone` (unit) — Planned
- N4-S4-AC2 → `tests/feature/parlay_rules.test.mjs::correlation_note_present` (unit) — Planned
- N4-S4-AC3 → `scripts/validate_data.py::parlays_contract` (data) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `scripts/models/parlay_builder.py`, `scripts/harness/conformal.py`, `data/contracts/parlays.schema.json`.
