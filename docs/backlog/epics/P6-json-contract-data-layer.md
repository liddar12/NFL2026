# P6 · JSON Contract & Frontend Data Layer
**Layer:** Platform   ·   **Status:** ✅   ·   **Instantiates:** —
**Reuse:** A future adapter reuses this wholesale — the versioned `data/*.json` contract, the stdlib draft-07-subset validator (`scripts/validate_data.py`), and the single client-side reader (`app/data.js`). An adapter re-authors only the schemas under `data/contracts/*.schema.json` and the concrete file list; the decoupling pattern (pipeline writes JSON, frontend reads JSON, neither imports the other) is domain-agnostic.

## Goal
Make the versioned JSON files under `data/` the ONLY interface between the model pipeline and any frontend, and make that interface schema-validated on every commit. Model iteration (new signals, refit weights, new snapshot format) must be able to ship without a frontend release, and a frontend redesign must be able to ship without touching the pipeline — because both sides only ever agree on the JSON contract. Exactly one client-side reader (`app/data.js`) is the path from JSON to UI, so a contract change lands in one file.

## Why it matters / risk if skipped
If pages fetch raw JSON ad hoc, a schema change means hunting every `fetch()` in ~140 modules and a contract drift ships silently to users. If the contract is not validated in the gate, the pipeline can write a shape the frontend can't read (or vice versa) and the break only shows in production. The unwired-signal postmortem applies at the contract boundary too: a field the pipeline emits but no reader surfaces "does not exist" to the user; a field the reader expects but the pipeline stops emitting is a silent blank. Schema validation on both directions, plus a single reader, keeps the two halves honestly in lockstep.

## User stories

### P6-S1 — Single client-side reader is the only path to data   ·  Status: ✅   ·  Est: S
**As** an Analyst **I want** every UI surface to read data through one module **so that** a contract change touches exactly one file and no page fetches raw JSON on its own.
**Acceptance criteria** (Given/When/Then):
- P6-S1-AC1 — Given any view under `app/views/*`, When it needs contract data, Then it imports a getter from `app/data.js` and never calls `fetch('/data/...')` directly.
- P6-S1-AC2 — Given two callers request the same contract on one tick, When they call the getter, Then a single network request is issued (promise-cached, de-duped).
- P6-S1-AC3 — Given a fetch returns non-2xx, When the getter runs, Then it throws with the path + HTTP status and evicts the cache entry so a later call retries (no cached rejected promise).
- P6-S1-AC4 — Given `getAll()` runs with one bad feed, When it settles, Then good contracts still resolve and the bad one is returned as `{__error}` (one bad feed never blanks the others).
**Tasks:**
- [ ] P6-S1-T1 — Keep one getter per contract; export names document the available contracts.
- [ ] P6-S1-T2 — Guard against direct `/data/*` fetches outside `app/data.js` with a lint/grep check in the gate.
- [ ] P6-S1-T3 — Keep the promise-cache + evict-on-failure semantics; cover both.
**QA coverage:**
- P6-S1-AC1 → `tests/feature/data_reader.test.mjs::no_raw_fetch_outside_reader` (unit — grep app/ for `/data/`) — Planned
- P6-S1-AC2 → `tests/feature/data_reader.test.mjs::dedupes_concurrent` (unit, fetch stub) — Planned
- P6-S1-AC3 → `tests/feature/data_reader.test.mjs::evicts_on_error` (unit) — Planned
- P6-S1-AC4 → `tests/feature/data_reader.test.mjs::getAll_isolates_failures` (unit) — Planned
  Coverage: 4/4 = 100%. Test types: unit(node:test).
**Traceability:** `app/data.js`, `app/views/*`, `app/main.js`.

### P6-S2 — Every contract is schema-validated in the gate   ·  Status: ✅   ·  Est: M
**As** an Operator **I want** each `data/*.json` validated against its schema on every commit **so that** a shape break fails CI instead of shipping.
**Acceptance criteria** (Given/When/Then):
- P6-S2-AC1 — Given all contracts valid, When `python3 scripts/validate_data.py` runs, Then it prints per-file `ok` lines and exits 0.
- P6-S2-AC2 — Given any contract violates its schema (wrong type, missing required, out-of-range, extra prop under `additionalProperties:false`), When the validator runs, Then it exits 1 and prints one line per error.
- P6-S2-AC3 — Given the validator implements only the draft-07 subset the contracts use (type, required, properties, additionalProperties bool|subschema, items, enum, minimum, maximum, minItems, maxItems), When a contract uses a keyword outside that subset, Then that is caught in review (documented scope), not silently ignored as passing.
- P6-S2-AC4 — Given the cross-file invariants (meta weights = 32 signals @ 0.0; pipeline health honesty), When the validator runs, Then both are asserted and either passes both or exits 1.
**Tasks:**
- [ ] P6-S2-T1 — Keep the validator stdlib-only (zero-dep gate invariant).
- [ ] P6-S2-T2 — Keep `SCHEMA_TO_DATA` complete: every committed contract file has a schema mapping.
- [ ] P6-S2-T3 — Validate any `data/snapshots/*.json` against `snapshot.schema.json` when present; skip cleanly when empty.
**QA coverage:**
- P6-S2-AC1 → `scripts/validate_data.py` exit 0 on clean tree, run by `tests/run_gate.sh` (data) — Done
- P6-S2-AC2 → `tests/feature/validate_data.test.mjs::bad_shape_exits_1` (unit, feeds a broken fixture) — Planned
- P6-S2-AC3 → manual (validator-scope review) — Planned (documented-scope AC)
- P6-S2-AC4 → `scripts/validate_data.py::{check_meta_weights,check_pipeline_health}` via `tests/feature/validate_data.test.mjs` (data/unit) — Planned
  Coverage: 3/4 automatable covered now (AC1 Done, AC2/AC4 Planned), AC3 manual-by-nature = 3/3 automatable = 100%. Test types: data(validate_data), unit(node:test), manual.
**Traceability:** `scripts/validate_data.py`, `data/contracts/*.schema.json`, `data/*.json`, `tests/run_gate.sh`.

### P6-S3 — Contract catalogue is complete and one-to-one   ·  Status: 🟡   ·  Est: S
**As** a Modeler **I want** every emitted `data/*.json` to have exactly one schema and vice versa **so that** no file ships unvalidated and no schema goes stale.
**Acceptance criteria** (Given/When/Then):
- P6-S3-AC1 — Given the set of committed `data/*.json` contract files, When compared to `data/contracts/*.schema.json` via `SCHEMA_TO_DATA`, Then every contract file maps to a schema (no unmapped contract ships).
- P6-S3-AC2 — Given a schema with no corresponding data file, When the catalogue is checked, Then it is flagged (dead schema).
- P6-S3-AC3 — Given `app/data.js` `PATHS`, When compared to the contract catalogue, Then every reader path corresponds to a validated contract (reader and validator agree on the file set).
**Tasks:**
- [ ] P6-S3-T1 — Add a catalogue-consistency check: `SCHEMA_TO_DATA` keys ↔ `data/contracts/`, values ↔ `data/`, cross-checked against `app/data.js` `PATHS`.
- [ ] P6-S3-T2 — Fail the gate if a contract file has no schema or a reader path has no contract.
**QA coverage:**
- P6-S3-AC1 → `tests/feature/contract_catalogue.test.mjs::every_data_file_has_schema` (unit) — Planned
- P6-S3-AC2 → `tests/feature/contract_catalogue.test.mjs::no_dead_schema` (unit) — Planned
- P6-S3-AC3 → `tests/feature/contract_catalogue.test.mjs::reader_paths_match_contracts` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** `scripts/validate_data.py` (`SCHEMA_TO_DATA`), `data/contracts/*.schema.json`, `data/*.json`, `app/data.js`.

### P6-S4 — Schema versioning on the contract   ·  Status: ⬜   ·  Est: M
**As** a Modeler **I want** each contract to carry an explicit schema version **so that** a frontend can detect a contract it is too old to read instead of silently mis-parsing.
**Acceptance criteria** (Given/When/Then):
- P6-S4-AC1 — Given a contract file, When written, Then it carries a `schema_version` (integer, monotonic) and its schema requires that field.
- P6-S4-AC2 — Given the reader reads a contract whose `schema_version` is greater than the max it supports, When it loads, Then it surfaces a clear "frontend too old — refresh" state rather than rendering partial/wrong data.
- P6-S4-AC3 — Given the reader supports a version range, When it reads a supported older version, Then it reads it without error (backward compatible within the declared range).
**Tasks:**
- [ ] P6-S4-T1 — Add `schema_version` to every contract + its schema (`required`, `minimum: 1`).
- [ ] P6-S4-T2 — Add `SUPPORTED_SCHEMA` bounds to `app/data.js` and a version check in `loadJson`.
- [ ] P6-S4-T3 — Add a user-visible "refresh to update" state for an unsupported-newer version.
- [ ] P6-S4-T4 — Extend `validate_data.py` to assert `schema_version` presence + monotonicity vs the committed baseline.
**QA coverage:**
- P6-S4-AC1 → `scripts/validate_data.py` (data — required schema_version) + `tests/feature/contract_catalogue.test.mjs::has_schema_version` (unit) — Planned
- P6-S4-AC2 → `tests/feature/data_reader.test.mjs::rejects_newer_version` (unit) — Planned
- P6-S4-AC3 → `tests/feature/data_reader.test.mjs::reads_supported_range` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test), data(validate_data).
**Traceability:** `data/*.json`, `data/contracts/*.schema.json`, `scripts/validate_data.py`, `app/data.js`.

### P6-S5 — Contract evolution: additive-by-default with a breaking-change gate   ·  Status: ⬜   ·  Est: M
**As** a Modeler **I want** contract changes to be additive by default and any breaking change to require a version bump **so that** model iteration ships without breaking a deployed frontend.
**Acceptance criteria** (Given/When/Then):
- P6-S5-AC1 — Given a new optional field is added to a contract, When validated against the prior schema, Then old readers still parse (additive change requires no version bump; `additionalProperties` policy is explicit per contract).
- P6-S5-AC2 — Given a required field is removed/renamed or a type/enum narrows, When the schema diff is checked in CI, Then it is classified breaking and the gate requires a `schema_version` bump in the same PR.
- P6-S5-AC3 — Given a breaking change without a version bump, When the gate runs, Then it exits non-zero with the offending field named.
**Tasks:**
- [ ] P6-S5-T1 — Add a schema-diff step comparing the PR's schemas against `main` and classifying additive vs breaking.
- [ ] P6-S5-T2 — Require a `schema_version` increment when a breaking change is detected; fail otherwise.
- [ ] P6-S5-T3 — Document the additive-by-default policy in `docs/` so adapters inherit it.
**QA coverage:**
- P6-S5-AC1 → `tests/feature/schema_evolution.test.mjs::additive_no_bump` (unit) — Planned
- P6-S5-AC2 → `tests/feature/schema_evolution.test.mjs::breaking_requires_bump` (unit) — Planned
- P6-S5-AC3 → `tests/feature/schema_evolution.test.mjs::breaking_without_bump_fails` (unit) — Planned
  Coverage: 3/3 = 100%. Test types: unit(node:test).
**Traceability:** new (`scripts/schema_diff.py`), `data/contracts/*.schema.json`, `tests/run_gate.sh`.

## Epic QA roll-up
Stories: 5 (S1–S2 ✅ shipped, S3 🟡, S4–S5 ⬜ evolution). Every story maps ≥90% of its automatable ACs to a named test; the two manual/documented-scope ACs (validator subset, additive policy review) are called out and excluded from the automatable denominator. New test files: `tests/feature/{data_reader,validate_data,contract_catalogue,schema_evolution}.test.mjs`.
