# P4 · Signal Registry & Contribution
**Layer:** Platform   ·   **Status:** 🟡   ·   **Instantiates:** —
**Reuse:** A future adapter (NBA, MLB, Kalshi) reuses the registry mechanism, the "enters at weight 0" discipline, the byte-for-byte name-mirror invariant, and the end-to-end wiring gate wholesale; it re-authors only the *contents* of `SIGNALS` (the sport's named factors) and the `data/meta.json` weights map that mirrors them.

## Goal
Make every factor the platform considers a **named, registered signal** with an explicit `{group, weight, description}` record, so the model has one auditable source of truth for what it looks at. Every signal enters at `weight = 0.0` and can earn weight only through the walk-forward optimizer (P5) — nothing is hand-weighted, "Dominance started at 0." The registry is the contract that lets the evaluation harness come first and models second: a factor is *named and computed* before it is ever *trusted*, and it is trusted only in proportion to measured out-of-sample lift. The registry is also the wiring ledger — a signal that is registered but never reaches the model is a bug the tests must catch.

## Why it matters / risk if skipped
Without a registry, weights become folklore: numbers hand-tuned in a notebook, no record of why a factor is in or out, no way to prove a new idea actually helped. Two postmortems drive this epic. (1) **Unwired signals** — "a signal that does not reach the model does not exist": we previously computed features that were never blended into a prediction, so effort produced zero measurable effect and nobody noticed for weeks; the rule now is *wire it end-to-end or don't build it*. (2) **Hand-weighted folklore** — factors given weight because they were plausible, not because they beat the baseline, silently degrading out-of-sample loss. The registry plus the weight-0 rule plus the name-mirror invariant make both classes of failure loud and testable.

## User stories

### P4-S1 — Registry as single source of truth   ·  Status: 🟡   ·  Est: M
**As** a Modeler **I want** every factor expressed as a named record in one registry **so that** there is exactly one auditable list of what the model may consider and how each factor is computed.
**Acceptance criteria** (Given/When/Then):
- P4-S1-AC1 — Given `scripts/signals/registry.py`, When `SIGNALS` is loaded, Then it is an insertion-ordered map of exactly 32 entries grouped player(19)/game(10)/market(3), each value a dict with keys exactly `{group, weight, description}` and no others.
- P4-S1-AC2 — Given any signal record, When it is read at scaffold time, Then `weight == 0.0` (float, not int, not string) and `group` is one of `{"player","game","market"}`.
- P4-S1-AC3 — Given the module, When imported twice, Then signal order is identical (deterministic, stdlib-only, no set/dict-ordering nondeterminism) and no two signals share a mutable weight cell.
- P4-S1-AC4 — Given a `description`, When inspected, Then it is a non-empty string naming *how the signal is computed* (source module or method), not a restatement of the name.
**Tasks** (implementation checklist):
- [ ] P4-S1-T1 — Freeze the `_s(group, description)` factory returning a fresh `{group, weight:0.0, description}` per call.
- [ ] P4-S1-T2 — Author all 32 records in player→game→market order with computation-bearing descriptions.
- [ ] P4-S1-T3 — Add a `groups()` / count helper for downstream consumers and tests.
- [ ] P4-S1-T4 — Assert stdlib-only imports (no third-party) so the registry loads in any environment.
**QA coverage** (≥90% of ACs map to a named test):
- P4-S1-AC1 → `tests/feature/signal_registry.test.mjs::count-and-groups` (unit) — Partial
- P4-S1-AC2 → `tests/feature/signal_registry.test.mjs::every registry signal is present at exactly 0.0` (unit) — Done
- P4-S1-AC3 → `tests/feature/signal_registry.test.mjs::deterministic-order` (unit) — Planned
- P4-S1-AC4 → `tests/feature/signal_registry.test.mjs::non-empty-description` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/registry.py`, `scripts/signals/__init__.py`, `tests/feature/signal_registry.test.mjs`.

### P4-S2 — Every signal enters at weight 0.0 ("Dominance started at 0")   ·  Status: 🟡   ·  Est: S
**As** a Modeler **I want** every new signal to enter the model at weight 0.0 **so that** no factor gets credit for being plausible — only for measurably improving out-of-sample loss.
**Acceptance criteria** (Given/When/Then):
- P4-S2-AC1 — Given the registry at scaffold time, When all 32 weights are read, Then every one is exactly `0.0` and none has been hand-edited to a nonzero value outside the optimizer.
- P4-S2-AC2 — Given a newly added signal record, When it is committed, Then its `weight` field is `0.0` and the only writer that may move it off 0.0 is `scripts/optimize/optimize_weights.py`.
- P4-S2-AC3 — Given `data/meta.json`, When validated, Then its `weights` map has all 32 values `== 0.0` on day zero, matching the registry.
**Tasks** (implementation checklist):
- [ ] P4-S2-T1 — Encode the day-zero constant `_ZERO = 0.0` and route every record through it.
- [ ] P4-S2-T2 — Add a test that fails if any registry weight is nonzero at scaffold time.
- [ ] P4-S2-T3 — Document the rule and the sole-writer constraint in `docs/SIGNAL_REGISTRY.md`.
- [ ] P4-S2-T4 — Add a `validate_data.py` assertion that every `meta.json` weight is a float in `[0,1]` (and all 0.0 pre-fit).
**QA coverage**:
- P4-S2-AC1 → `tests/feature/signal_registry.test.mjs::every registry signal is present at exactly 0.0` (unit) — Done
- P4-S2-AC2 → `tests/feature/signal_registry.test.mjs::registry-weights-all-zero` (unit) — Planned
- P4-S2-AC3 → `scripts/validate_data.py::meta_weights_zero_and_bounded` (data) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test) | data(validate_data).
**Traceability:** `scripts/signals/registry.py`, `data/meta.json`, `scripts/validate_data.py`, `docs/SIGNAL_REGISTRY.md`.

### P4-S3 — Names mirror byte-for-byte across code and data   ·  Status: 🟡   ·  Est: S
**As** the System **I want** the signal names in `registry.py` and `data/meta.json` to match byte-for-byte **so that** the optimizer, the frontend, and the harness never disagree about which factor is which.
**Acceptance criteria** (Given/When/Then):
- P4-S3-AC1 — Given the registry names and the `meta.json` weights keys, When compared as ordered sets, Then they are identical: same names, same count (32), no extras on either side.
- P4-S3-AC2 — Given a renamed or reordered signal in `registry.py`, When the test runs, Then it fails until `data/meta.json` is updated to match (missing-key AND unexpected-extra-key both caught).
- P4-S3-AC3 — Given a signal name, When it appears anywhere downstream (optimizer feature keys, frontend labels), Then it is the exact registry string — no aliasing, casing, or whitespace drift.
**Tasks** (implementation checklist):
- [ ] P4-S3-T1 — Keep the `EXPECTED` name list in `signal_registry.test.mjs` synced to `registry.py`.
- [ ] P4-S3-T2 — Assert missing-key failure AND no-unexpected-extra failure in the test.
- [ ] P4-S3-T3 — Add a generator/check helper so `meta.json` weights can be regenerated from the registry (mirror is derivable, not hand-maintained).
- [ ] P4-S3-T4 — Wire the mirror check into `tests/run_gate.sh` so a drift blocks the gate.
**QA coverage**:
- P4-S3-AC1 → `tests/feature/signal_registry.test.mjs::count matches (no missing, no extra)` (unit) — Done
- P4-S3-AC2 → `tests/feature/signal_registry.test.mjs::no unexpected signals leaked into the weights map` (unit) — Done
- P4-S3-AC3 → `tests/feature/signal_registry.test.mjs::names-are-exact-strings` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/registry.py`, `data/meta.json`, `tests/feature/signal_registry.test.mjs`, `tests/run_gate.sh`.

### P4-S4 — End-to-end wiring gate ("a signal that doesn't reach the model does not exist")   ·  Status: ⬜   ·  Est: M
**As** a Modeler **I want** a test that proves each registered signal is actually consumed by the prediction path **so that** we never again ship a computed-but-unwired feature that has zero effect.
**Acceptance criteria** (Given/When/Then):
- P4-S4-AC1 — Given every registered signal name, When the wiring check runs, Then each name is referenced by at least one consumer in the predict path (`scripts/optimize/optimize_weights.py::_predict_probs` feature keys or its documented feature-builder), or is explicitly listed in a `NOT_YET_WIRED` allowlist with a reason.
- P4-S4-AC2 — Given a signal on the `NOT_YET_WIRED` allowlist, When the optimizer runs, Then that signal's weight remains 0.0 (it cannot earn weight while unwired) and the allowlist entry is surfaced in `pipeline_status.json`.
- P4-S4-AC3 — Given a signal removed from the registry, When the wiring check runs, Then any dangling downstream reference to it fails the check (no orphan consumers).
- P4-S4-AC4 — Given the postmortem invariant, When a new signal is added without a consumer and without an allowlist entry, Then the gate is red.
**Tasks** (implementation checklist):
- [ ] P4-S4-T1 — Define the canonical predict-path feature-key surface the check reads.
- [ ] P4-S4-T2 — Implement the wiring check (registry names ⊆ consumed ∪ NOT_YET_WIRED; consumed ⊆ registry).
- [ ] P4-S4-T3 — Add the `NOT_YET_WIRED` allowlist with mandatory reason strings and mirror it into `pipeline_status.json`.
- [ ] P4-S4-T4 — Enforce weight-stays-0 for allowlisted signals in the optimizer path.
- [ ] P4-S4-T5 — Add the check to `tests/run_gate.sh`.
**QA coverage**:
- P4-S4-AC1 → `tests/feature/signal_wiring.test.mjs::every-signal-consumed-or-allowlisted` (unit) — Planned
- P4-S4-AC2 → `tests/feature/signal_wiring.test.mjs::unwired-stays-zero` (unit) — Planned
- P4-S4-AC3 → `tests/feature/signal_wiring.test.mjs::no-orphan-consumers` (unit) — Planned
- P4-S4-AC4 → `tests/feature/signal_wiring.test.mjs::new-unwired-signal-fails-gate` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** new `tests/feature/signal_wiring.test.mjs`, new `scripts/signals/wiring.py` (or check helper), `scripts/optimize/optimize_weights.py`, `scripts/pipeline_status.py`, `data/pipeline_status.json`, `tests/run_gate.sh`.

### P4-S5 — Groups, contribution, and human-readable registry doc   ·  Status: 🟡   ·  Est: S
**As** an Analyst **I want** signals grouped (player/game/market) with markets treated as first-class models and a synced human-readable doc **so that** I can read what the platform considers and how much each group contributes.
**Acceptance criteria** (Given/When/Then):
- P4-S5-AC1 — Given the three groups, When enumerated, Then `player`, `game`, and `market` are the only groups and `market` signals are documented as models-in-their-own-right (baseline the complex models must beat), not mere benchmarks.
- P4-S5-AC2 — Given `docs/SIGNAL_REGISTRY.md`, When compared to `registry.py`, Then every signal name in the doc's tables exists in the registry and vice versa (doc is not stale).
- P4-S5-AC3 — Given the fitted weights (post-P5), When contribution is reported, Then each group's summed weight is derivable from `meta.json` and the "if nothing beats the market, the market is the model" rule holds (a group with all-zero weights contributes nothing).
**Tasks** (implementation checklist):
- [ ] P4-S5-T1 — Keep the doc's three tables generated from / checked against the registry.
- [ ] P4-S5-T2 — Add a doc-freshness test (names in doc ↔ names in registry).
- [ ] P4-S5-T3 — Add a `group_contribution(meta)` helper summing weights per group.
- [ ] P4-S5-T4 — Document the markets-as-models framing and the day-zero all-0 state.
**QA coverage**:
- P4-S5-AC1 → `tests/feature/signal_registry.test.mjs::groups-are-the-three` (unit) — Planned
- P4-S5-AC2 → `tests/feature/signal_registry.test.mjs::doc-matches-registry` (unit) — Planned
- P4-S5-AC3 → `tests/feature/signal_registry.test.mjs::group-contribution-sums` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/signals/registry.py`, `docs/SIGNAL_REGISTRY.md`, `data/meta.json`, `tests/feature/signal_registry.test.mjs`.
