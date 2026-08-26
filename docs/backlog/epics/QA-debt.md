# QA-DEBT · Close the coverage the backlog already claimed
**Layer:** Platform + Adapter (cross-cutting)   ·   **Status:** 🟡 — D1/D2/D3 (all of P0) closed 2026-08-25; D4–D10 open   ·   **Instantiates:** —
**Reuse:** Every story here is a *shape* a future adapter will need too: drive the Python from the gate rather than mirroring it in JS, read the source of truth rather than a pasted literal, assert the deploy-surface files (`sw.js`, `_headers`) rather than describing them in prose. The specific file names are NFL2026's; the failure modes are the framework's.

> **QA reality (measured 2026-08-15):** this epic exists *because* the measurement happened. It has no QA coverage of its own — it **is** the QA coverage. Progress is measured by re-running the method in [`../QA_COVERAGE.md`](../QA_COVERAGE.md) and watching the REAL count rise from **18/297**.

## Goal
Make the regression gate protect what [`../QA_COVERAGE.md`](../QA_COVERAGE.md) says it protects. On 2026-08-15 the backlog's 309 acceptance criteria resolved to **18 REAL · 160 MISSING · 119 TOOTHLESS · 12 manual** — a true automated coverage of **6.1%** against a claimed *"all 87 stories ≥90%"*. The documentation has now been corrected to say so. This epic is the other half: the work that makes the claim true rather than the disclaimer permanent.

## Why it matters / risk if skipped
The docs are honest now, which is strictly better than before — but an honest 6% is still 6%. The concrete exposure, in the order it will bite:

- **Seven stories carry `Status: ✅` with zero asserted ACs** (P5-S4, P6-S1, P7-S2, P7-S3, P8-S3, P9-S4, P9-S6). "Shipped and covered" was the basis for treating those surfaces as safe to change. They are not.
- **The wc2026 stale-shell postmortem is unguarded.** `sw.js` is a correct pure-purger and `_headers` is a correct freshness matrix — today. Eight acceptance criteria across two ✅ stories stand between a future caching `fetch` handler (or a relaxed `/data/*` TTL) and users scoring off day-old projections behind a fresh-looking timestamp. **Zero of the eight are asserted, and no test in the repo reads `_headers` at all.**
- **Three Python modules named as enforcers are enforced by JavaScript copies of themselves.** `scripts/harness/{metrics,conformal,honesty}.py` are never executed by any test; `metrics.test.mjs:3-6` states this in its own header. Breaking `brier()` ships a wrong accuracy number to the MODEL screen under a green gate. `honesty.py` is imported by nothing outside its own package — the estimate-vs-measured rule, the thing the platform's credibility rests on, is enforced by a hand-maintained JS mirror.
- **Two hardcoded mirrors of the signal registry can drift silently** (`signal_registry.test.mjs:16` and `scripts/validate_data.py:118-130`). Renaming or reordering a signal in `registry.py` reds nothing.
- **Four acceptance criteria are self-referential**, naming `tests/run_gate.sh` or `.github/workflows/ci.yml` as proof of a property of that same file. Editing the file edits its own "test".

Ordering principle below: **biggest honesty gap first** — a story that claimed 100% and has nothing outranks a story that is honestly unbuilt. P3 and N3 are the two largest MISSING blocks (16 mappings each) but they sit at `Status: 🟡` against modules that do not exist; their tests belong with the feature, not ahead of it, so they land in P2 priority.

## Priorities
`P0` shipped code, zero coverage, known regression class · `P1` shipped code, coverage exists but does not bite · `P2` test debt for unbuilt modules — write alongside the feature.

## User stories

### QA-D1 — `sw.js` stays a pure cache-purger, provably   ·  Priority: P0   ·  Est: S
**As** an Operator **I want** the gate to fail the moment `sw.js` grows a caching `fetch` handler **so that** the wc2026 stale-shell bug cannot be reintroduced by a well-meaning offline-support commit.
**Closes:** P7-S3-AC1, P7-S3-AC2, P7-S3-AC3, P9-S6-AC1 — 4 ACs across two `Status: ✅` stories, currently 0 asserted.
**Acceptance criteria** (Given/When/Then):
- QA-D1-AC1 — Given `sw.js`, When the check runs, Then it fails if the source matches `addEventListener('fetch'` (or `onfetch`), and the failure message names the wc2026 postmortem.
- QA-D1-AC2 — Given `sw.js`, When the check runs, Then it asserts the activate path deletes caches prefixed `nfl26-` and calls `clients.claim()`; removing either reds the gate.
- QA-D1-AC3 — Given the check is added to the fast gate (`smoke.sh` or a `node --test` feature file), When run on a clean box, Then it needs no npm install and no browser.
- QA-D1-AC4 — Given `tests/pwa/standalone.spec.mjs:363` ("service worker registers (cache-purger)"), When reviewed, Then it is either renamed to what it actually asserts (`navigator.serviceWorker.ready` resolves) or extended to probe the active SW for a fetch handler — the current title claims a check it does not perform.
**Tasks:** *(closed 2026-08-25 — `tests/feature/qa_debt_p0.test.mjs`, mutation-checked: an added fetch handler reds the gate)*
- [x] QA-D1-T1 — stdlib source check on `sw.js` in the fast gate. *(node --test feature file: node builtins only, no browser — AC3 satisfied)*
- [x] QA-D1-T2 — Assert the `nfl26-` purge + `clients.claim()` remain.
- [x] QA-D1-T3 — Rename or extend the misleading pwa spec title. *(renamed to what it asserts: readiness; the purger property is pinned at source by qa_debt_p0)*
**Traceability:** `sw.js`, `tests/smoke.sh`, `tests/pwa/standalone.spec.mjs`, `docs/backlog/epics/P7-pwa-design-system.md`, `docs/backlog/epics/P9-deploy-ops.md`.

### QA-D2 — `_headers` freshness matrix is pinned by a test   ·  Priority: P0   ·  Est: S
**As** an Operator **I want** the four freshness blocks and the security headers asserted **so that** relaxing `/data/*` from `max-age=0` to a long TTL fails CI instead of silently serving last week's projections.
**Closes:** P7-S3-AC4, P9-S6-AC2, P9-S6-AC3, P9-S6-AC4 — 4 ACs, currently 0 asserted. **`grep -rl "_headers" tests/` returns nothing: no test in this repo reads the file.**
**Acceptance criteria** (Given/When/Then):
- QA-D2-AC1 — Given `_headers`, When parsed, Then `/app/*` and `/manifest.webmanifest` are `public, max-age=120, stale-while-revalidate=600`; changing either number reds the gate.
- QA-D2-AC2 — Given `_headers`, When parsed, Then `/data/*` is `public, max-age=0, stale-while-revalidate=120`, and `/index.html` and `/sw.js` are `public, max-age=0, must-revalidate`.
- QA-D2-AC3 — Given `_headers`, When parsed, Then the `/*` block carries all four security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`).
- QA-D2-AC4 — Given P7-S3-AC4 and P9-S6-AC3 currently pin **contradictory** policies for `/data/*` (`must-revalidate` vs `stale-while-revalidate=120`), When this story lands, Then one of them is rewritten so both agree with the shipped file, and the test pins the agreed text.
**Tasks:** *(closed 2026-08-25 — `tests/feature/qa_debt_p0.test.mjs`, mutation-checked: a changed TTL reds the gate)*
- [x] QA-D2-T1 — stdlib `_headers` parser + per-block assertions in the fast gate. *(every block pinned byte-for-byte, immutable art included)*
- [x] QA-D2-T2 — Reconcile P7-S3-AC4 with P9-S6-AC3; delete the loser's wording. *(P7-S3-AC4 was the loser — rewritten to match the shipped file and P9-S6-AC3)*
- [x] QA-D2-T3 — Assert the four security headers. *(exact values, not presence)*
**Traceability:** `_headers`, `tests/smoke.sh`, `docs/backlog/epics/P7-pwa-design-system.md`, `docs/backlog/epics/P9-deploy-ops.md`.

### QA-D3 — The data-reader boundary is enforced, not described   ·  Priority: P0   ·  Est: M
**As** an Analyst **I want** the "one reader, no raw fetches" rule checked mechanically **so that** the contract-change-touches-one-file property survives the next view someone adds.
**Closes:** P6-S1-AC1..AC4 (`Status: ✅`, 0 asserted, `tests/feature/data_reader.test.mjs` absent) and N5-S1-AC1 (same rule from the UI side).
**Acceptance criteria** (Given/When/Then):
- QA-D3-AC1 — Given every file under `app/views/`, When scanned, Then none contains a direct `fetch('/data/` (or template-literal equivalent); a new view that fetches raw JSON reds the gate.
- QA-D3-AC2 — Given two callers request the same contract on one tick with a stubbed fetch, When both resolve, Then exactly one network call was issued (promise de-duplication).
- QA-D3-AC3 — Given a stubbed non-2xx response, When the getter runs, Then it throws naming the path + HTTP status **and** the cache entry is evicted, so a second call retries rather than replaying a cached rejection.
- QA-D3-AC4 — Given `getAll()` with one failing feed, When it settles, Then the good contracts still resolve and the bad one is `{__error}` — one bad feed never blanks the others.
**Tasks:** *(closed 2026-08-25 — NO new test code was needed: `tests/feature/data_contract.test.mjs` (R25-F2) already asserted all four ACs, and more besides. The 08-15 measurement keyed on the never-authored `data_reader.test.mjs` filename and counted the properties MISSING. The fix was re-pointing the P6-S1 and N5-S1 mappings at the cases that bite.)*
- [x] QA-D3-T1 — Source-scan assertion over `app/views/*`. *(exists, stronger: `fetch()` anywhere in `app/` outside data.js/kdst.js fails)*
- [x] QA-D3-T2 — Fetch-stub tests for de-dupe, evict-on-error, and `getAll` isolation. *(all present, plus the superseded-request identity-guard race)*
**Traceability:** `app/data.js`, `app/views/*`, `docs/backlog/epics/P6-json-contract-data-layer.md`, `docs/backlog/epics/N5-nfl-ui.md`.

### QA-D4 — The harness Python is executed by the gate, not mirrored in JS   ·  Priority: P1   ·  Est: M
**As** the Modeler **I want** `scripts/harness/{metrics,conformal,honesty}.py` driven directly **so that** breaking the module that produces the numbers turns the gate red instead of leaving a JavaScript copy of the old behaviour green.
**Closes / repairs:** P1-S2-AC1..AC5, P1-S3-AC1..AC5, P1-S4-AC1..AC3, P8-S1-AC1..AC3 — **16 ACs, several marked `— Done`, all TOOTHLESS by re-implementation.** `tests/feature/never_regress.test.mjs` already shows the pattern: it shells to `python3` and drives `scripts.promote_signals` for real.
**Acceptance criteria** (Given/When/Then):
- QA-D4-AC1 — Given `scripts/harness/metrics.py`, When the gate runs, Then it asserts against the **Python** that `brier(0,[0.7,0.3]) == 0.18`, `log_loss(0,[0.7,0.3]) == -ln(0.7)` and `mae([10,20,30],[12,18,33]) == 7/3`; changing `diff*diff` to `abs(diff)` in `metrics.py` reds the gate.
- QA-D4-AC2 — Given the JS mirrors in `metrics.test.mjs` / `conformal.test.mjs` are kept, When the gate runs, Then JS and Python outputs are asserted **equal** on the same inputs, so the two genuinely cannot diverge.
- QA-D4-AC3 — Given `scripts/harness/honesty.py`, When the gate runs, Then `honesty.validate` itself accepts each `HONEST` fixture and raises on each `DISHONEST` fixture — the rule is enforced by the module the stories name in Traceability, not by `validateRow` in the test file.
- QA-D4-AC4 — Given `tests/feature/backtest_honesty.test.mjs:68` and `:74`, When reviewed, Then the two tautological cases (which filter the file's own `HONEST` literal and assert the literal has the keys it was written with) are deleted or replaced by assertions against real data; **no AC may map to a case that cannot fail.**
- QA-D4-AC5 — Given `scripts/harness/conformal.py` is imported by no pipeline script (`scripts/build_all.py:395`), When P1-S3 is next reviewed, Then it is marked untested-in-production until the module is wired, rather than carrying conformal ACs as Done.
**Tasks:**
- [ ] QA-D4-T1 — `python3 -` drive-through for `metrics.py` with pinned constants.
- [ ] QA-D4-T2 — Same for `conformal.calibrate` / `safe_set`.
- [ ] QA-D4-T3 — Same for `honesty.validate` over both fixture sets, plus every row of `data/snapshots/2026_wk01_games_open.json` (the one committed lock array) — which is what P8-S5-AC2 asks for and nothing currently does.
- [ ] QA-D4-T4 — Delete or rewrite the two tautological honesty cases; correct the AC→case names.
**Traceability:** `scripts/harness/metrics.py`, `scripts/harness/conformal.py`, `scripts/harness/honesty.py`, `tests/feature/{metrics,conformal,backtest_honesty}.test.mjs`, `data/snapshots/`.

### QA-D5 — One source of truth for the signal registry   ·  Priority: P1   ·  Est: S
**As** the Modeler **I want** the registry read from `registry.py` instead of pasted into two other files **so that** a rename or reorder cannot leave `meta.json`, the optimizer's feature keys and the MODEL screen's weights table disagreeing with nothing turning red.
**Closes / repairs:** P4-S1-AC1, P4-S3-AC2 (marked `— Done`), P4-S5-AC2, plus the second mirror in the validator.
**Acceptance criteria** (Given/When/Then):
- QA-D5-AC1 — Given `scripts/signals/registry.py`, When the gate runs, Then the expected signal list is **read from it** (e.g. `python3 -c "from scripts.signals.registry import SIGNALS; ..."`) and deep-compared against `Object.keys(data/meta.json .weights)` — the hardcoded `EXPECTED` at `signal_registry.test.mjs:16` is deleted, not merely supplemented.
- QA-D5-AC2 — Given a signal is **renamed** in `registry.py` only, When the gate runs, Then it fails. Given a signal is **reordered** only, When the gate runs, Then it also fails — today `:38` (`name in meta.weights`) and `:49` (`EXPECTED.includes()`) are both order-insensitive despite the "in group order" comment at `:15`.
- QA-D5-AC3 — Given `scripts/validate_data.py:118-130` carries a second hardcoded `EXPECTED_SIGNALS`, When this story lands, Then it too is sourced from `scripts.signals.registry.SIGNALS`; **both** mirrors go, or the drift is only half-guarded.
- QA-D5-AC4 — Given `docs/SIGNAL_REGISTRY.md`, When the gate runs, Then its name table is compared against the registry, so P4-S5-AC2 ("the doc is not stale") becomes a real check instead of a mapping to a `doc-matches-registry` case that does not exist.
- QA-D5-AC5 — Given the registry, When inspected, Then the 19/10/3 player/game/market grouping and the exact `{group, weight, description}` key-set are asserted from the source — P4-S1-AC1's stated content, currently asserted nowhere.
**Tasks:**
- [ ] QA-D5-T1 — Read `SIGNALS` from Python; deep-compare set **and** order.
- [ ] QA-D5-T2 — Remove both hardcoded mirrors.
- [ ] QA-D5-T3 — Compare `docs/SIGNAL_REGISTRY.md` against the registry.
**Traceability:** `scripts/signals/registry.py`, `scripts/validate_data.py`, `tests/feature/signal_registry.test.mjs`, `data/meta.json`, `docs/SIGNAL_REGISTRY.md`.

### QA-D6 — NEVER-REGRESS is asserted against the Python that runs   ·  Priority: P1   ·  Est: S
**As** an Operator **I want** the adoption gate's fixed-margin rule driven from `scripts/optimize/never_regress.py` **so that** loosening the margin in production code fails, rather than passing against the JS mirror at `never_regress.test.mjs:66`.
**Closes / repairs:** P2-S4-AC1..AC5, P8-S2-AC2, P8-S2-AC3, N2-S6-AC3, N3-S6-AC3 — the last three marked `— Done`.
**Acceptance criteria** (Given/When/Then):
- QA-D6-AC1 — Given `should_adopt` in `scripts/optimize/never_regress.py`, When the gate runs, Then the adopt / sub-margin / exact-tie / worse / strict-boundary / negative-margin cases are asserted against the **Python**, using the `py()` drive-through this file already has for `scripts.promote_signals`.
- QA-D6-AC2 — Given the JS `shouldAdopt` mirror is retained for readability, When the gate runs, Then it is asserted equal to the Python on the same grid.
- QA-D6-AC3 — Given the default margin constant, When changed in `never_regress.py`, Then the gate reds — the value must be read from the module, never re-typed in the test.
**Tasks:**
- [ ] QA-D6-T1 — Extend the existing `py()` helper to `scripts.optimize.never_regress`.
- [ ] QA-D6-T2 — Read the margin constant from the module; assert JS/Python parity.
**Traceability:** `scripts/optimize/never_regress.py`, `tests/feature/never_regress.test.mjs`, `docs/backlog/epics/P2-optimizer-never-regress.md`.

### QA-D7 — Feed health tells the truth about zero rows   ·  Priority: P1   ·  Est: S
**As** an Analyst **I want** a feed that delivered nothing to be unable to report `ok` **so that** the health panel — whose entire job is this — stops counting an empty feed among the healthy ones.
**Closes / repairs:** P8-S5-AC1 (validator lacks the check), P5-S4-AC3 (stale AC, unasserted), P5-S4-AC2.
**Acceptance criteria** (Given/When/Then):
- QA-D7-AC1 — Given a feed with `rows: 0` while events were seen, When `validate_data.check_pipeline_health` runs, Then it is a validation error unless the feed is on an explicit allowlist (`espn_results_2026` before kickoff is the one documented legitimate case, `scripts/build_predictions.py:112`). Today `check_pipeline_health` (`validate_data.py:689`) never reads `rows`, and `data/pipeline_status.json` ships `kalshi` and `espn_results_2026` at `rows: 0, status: "ok"` with a green gate.
- QA-D7-AC2 — Given a `pipeline_status.json` whose `health` is rosier than its worst configured feed, When `validate_data.py` runs, Then it exits 1 naming the offending feed — asserted by a test that constructs such a document, not only by the fact that the committed file happens to be consistent.
- QA-D7-AC3 — Given P5-S4-AC3's text ("`health` is honestly `degraded` … at least one feed is non-ok"), When this story lands, Then the AC is rewritten to state an invariant rather than a snapshot of a file that has since changed (committed `health` is `ok`, all 18 feeds `ok`, as of 2026-08-15).
- QA-D7-AC4 — Given a staleness threshold per feed, When a feed's `updated_utc` is past it, Then the gate fails — the other half of P8-S5-AC1, also unimplemented.
**Tasks:**
- [ ] QA-D7-T1 — Add the `rows == 0` rule + allowlist to `check_pipeline_health`.
- [ ] QA-D7-T2 — Downgrade a zero-row source at the writer (`scripts/build_markets.py:167`) so status and reality agree at the source.
- [ ] QA-D7-T3 — Fixture-driven test for the dishonest-health and zero-row cases.
- [ ] QA-D7-T4 — Rewrite P5-S4-AC3.
**Traceability:** `scripts/validate_data.py`, `scripts/build_markets.py`, `scripts/build_predictions.py`, `data/pipeline_status.json`, `data/contracts/pipeline_status.schema.json`.

### QA-D8 — Retire the self-referential acceptance criteria   ·  Priority: P1   ·  Est: S
**As** the Owner **I want** no acceptance criterion to cite the file it describes as its own proof **so that** the coverage matrix never again counts a file as testing itself.
**Closes / repairs:** P1-S5-AC3, P8-S3-AC1, P8-S3-AC2, P8-S3-AC3, P9-S4-AC1, P9-S4-AC2 — 6 ACs across two `Status: ✅` stories.
**Acceptance criteria** (Given/When/Then):
- QA-D8-AC1 — Given `tests/run_gate.sh`, When the gate runs, Then a test asserts the four steps appear in order and that each step's pass/fail is taken from its **exit code** (no `grep` of output) — parsed from the script, so an edit that reintroduces output-grepping reds the gate.
- QA-D8-AC2 — Given `.github/workflows/ci.yml`, When the gate runs, Then a test asserts it invokes `bash tests/run_gate.sh` and contains no dependency-install step before the fast gate — the property P8-S3-AC3 and P9-S4-AC2 assert in prose.
- QA-D8-AC3 — Given step 4 skips loudly when `@playwright/test` is absent and still prints `GATE RESULT: PASS (green)` (`run_gate.sh:66-81`), When this story lands, Then that behaviour is either asserted as intended **or** changed — but it is stated explicitly in P9-S4, because "the gate was green" currently means something different locally than in CI.
- QA-D8-AC4 — Given any remaining AC whose only named artifact is the artifact under test, When the matrix is regenerated, Then zero mappings classify as `self-referential`.
**Tasks:**
- [ ] QA-D8-T1 — Parse and assert `run_gate.sh` step order + exit-code semantics.
- [ ] QA-D8-T2 — Parse and assert `ci.yml`.
- [ ] QA-D8-T3 — State the skip-not-fail semantics in P9-S4.
**Traceability:** `tests/run_gate.sh`, `.github/workflows/ci.yml`, `docs/backlog/epics/P8-backtest-honesty.md`, `docs/backlog/epics/P9-deploy-ops.md`.

### QA-D9 — Settle and enforce the canonical JSON write convention   ·  Priority: P1   ·  Est: S
**As** an Operator **I want** one stated on-disk JSON convention with a byte-level check **so that** cron commits stay minimal-diff and a data-conflict merge stays a merge instead of a manual reconstruction.
**Closes / repairs:** P5-S6-AC2 (marked `— Done` against two checks that inspect no formatting).
**Acceptance criteria** (Given/When/Then):
- QA-D9-AC1 — Given the AC currently specifies `sort_keys=True`, When the convention is settled, Then it matches `CLAUDE.md:137` (`ensure_ascii=True`, `indent=2`, trailing newline; **no** `sort_keys`) — measured: with `sort_keys=True`, **35 of 36 `data/*.json` deviate** (only `dvp_positional_history.json` happens to match), so the AC as written has never been true.
- QA-D9-AC2 — Given the settled convention, When each `data/**/*.json` is re-serialised and byte-compared, Then the gate fails on any deviation outside an explicit, named allowlist. Measured on 2026-08-15: **11 of 36 files deviate** (`epa_history`, `game_context`, `injury_history`, `market_baseline`, `player_usage`, `player_usage_history`, `player_usage_weekly`, `preseason_form`, `ros_backtest`, `weather_forecast`, `weather_history`) — these are the large compact feeds and are the allowlist candidates.
- QA-D9-AC3 — Given the allowlist, When a file is added to it, Then the reason is recorded inline (size, write path) — an allowlist without reasons becomes the next silent exemption.
**Tasks:**
- [ ] QA-D9-T1 — Fix the AC text to match `CLAUDE.md`.
- [ ] QA-D9-T2 — Re-serialise-and-diff check in `smoke.sh` with a reasoned allowlist.
**Traceability:** `tests/smoke.sh`, `scripts/validate_data.py`, `data/*.json`, `CLAUDE.md`.

### QA-D10 — Test debt for unbuilt modules, written with the feature   ·  Priority: P2   ·  Est: L
**As** the PM **I want** the remaining MISSING mappings tracked as feature-adjacent debt **so that** nobody re-reads them as coverage and nobody writes tests for modules that do not exist yet.
**Scope:** the balance of the 160 MISSING mappings, after QA-D1..D9. These sit against `Status: 🟡`/`⬜` stories — honestly unbuilt — so the epic's status is not the lie; only the old rollup was. Largest blocks, by mappings blocked:

| Missing test file | Mappings | Stories | Module it would cover |
|---|---|---|---|
| `tests/feature/game_model.test.mjs` | 16 | N3-S1..S5 | `scripts/models/game_model.py` — nothing executes it today |
| `tests/feature/ensemble.test.mjs` | 16 | P3-S1..S5 | no ensemble module exists either |
| `tests/feature/data_reader.test.mjs` | 8 | P6-S1, P6-S4, N5-S1 | **covered by QA-D3 — `app/data.js` does exist** |
| `tests/feature/status_gate.test.mjs` | 5 | N5-S6, N6-S3 | shared FINAL-vs-display gate |
| `tests/feature/llm_signal_promote.test.mjs` | 5 | P10-S3, P10-S4 | LLM signal promotion |
| `tests/feature/pipeline_status.test.mjs` | 5 | P5-S2, P5-S3, P5-S4 | partly covered by QA-D7 |
| `tests/feature/deploy_config.test.mjs` | 5 | P9-S1, P9-S2, P9-S5 | Netlify/Vercel config |
| `tests/feature/{odds_budget,player_projection,llm_signal_encode,signal_wiring,contract_catalogue,cron_racesafe}.test.mjs` | 4 each | various | — |
| 45 further files | 1–3 each | various | — |

**Acceptance criteria** (Given/When/Then):
- QA-D10-AC1 — Given any story in this table, When its module is built, Then its named test file is authored **in the same change** and the story's `Coverage (measured …)` line is regenerated, not hand-edited.
- QA-D10-AC2 — Given a mapping in this table, When the coverage matrix is regenerated before the module exists, Then it still classifies MISSING — no story may be marked Done-with-coverage on the strength of a planned test.
- QA-D10-AC3 — Given `tests/feature/parlay_rules.test.mjs` exists but asserts none of N4's edge / correlation / EV / tier maths (12 TOOTHLESS ACs against `scripts/models/parlay_builder.py`, which does exist), When that module is next touched, Then those cases land with it — this is the one large TOOTHLESS block whose code is already shipped.
- QA-D10-AC4 — Given the `data/contracts/parlays.schema.json` description calls `confidence_tier` conformal-derived while `parlay_builder.py:30-35` honestly calls it an ordinal heuristic, When N4 is next touched, Then the contract description is corrected to match the code.
**Tasks:**
- [ ] QA-D10-T1 — Keep this table regenerated from the measurement, never hand-maintained.
- [ ] QA-D10-T2 — Land N4's parlay-maths cases against the existing `parlay_builder.py`.
- [ ] QA-D10-T3 — Correct the `parlays.schema.json` tier description.
**Traceability:** `docs/backlog/QA_COVERAGE.md`, `docs/qa/R30_RCA_FINDINGS.md`, `scripts/models/parlay_builder.py`, `data/contracts/parlays.schema.json`.

## Definition of done for this epic
The coverage matrix is regenerated by the method in [`../QA_COVERAGE.md`](../QA_COVERAGE.md) — not edited by hand — and:

1. **No story carrying `Status: ✅` has a REAL count of 0.** (Today: seven do.)
2. **Zero mappings classify `self-referential`, `asserts-own-fixtures` or `hardcoded-literal`.** (Today: 10.)
3. **Zero mappings classify `reimplements-under-test` where the mirrored module is the one the story names in Traceability.** (Today: 16.)
4. Every remaining non-REAL mapping is `unwritten-case` or `MISSING` against a module that genuinely does not exist yet, and its story's status says so.
