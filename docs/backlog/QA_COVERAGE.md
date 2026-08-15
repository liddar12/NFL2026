# NFL2026 Backlog — QA Coverage Matrix

> **This page was rewritten on 2026-08-15 because the version before it was false.**
> It claimed *"82 of 87 stories at 100% automated AC coverage … all 87 stories meet the ≥90%
> standard."* That number was produced by counting every AC→test mapping written in the epic files,
> including the ones naming test files that were never authored. Re-derived from the filesystem,
> **18 of 309 acceptance criteria (6.1% of the automatable ones) are asserted by a test that exists,
> runs in the gate, and fails when the criterion is violated.** The R30 audit
> ([`../qa/R30_RCA_FINDINGS.md`](../qa/R30_RCA_FINDINGS.md), finding
> `qa-coverage-rollup-counts-tests-that-do-not-exist`) surfaced it; this page is the correction.
>
> Nothing about the product changed. What changed is that this page no longer says the gate is
> protecting things it is not protecting. The work to close the gap is scoped as real backlog in
> [`epics/QA-debt.md`](./epics/QA-debt.md).

## What "covered" now means

An acceptance criterion counts as covered only if **an assertion exists today that goes red when
that criterion is violated in production code or committed data.** Four verdicts:

| Verdict | Meaning |
|---|---|
| **REAL** | A test file exists, runs in `tests/run_gate.sh`, and contains an assertion that bites on this AC. |
| **MISSING** | No artifact named by the mapping exists on disk. Nothing runs at all. |
| **TOOTHLESS** | Every artifact named exists and runs, but no assertion in it bites this AC. |
| *MANUAL* | The mapping names no code artifact — a deploy drill, a policy review, a live third-party call. Excluded from the denominator, as before. |

TOOTHLESS is not one thing. The sub-shapes, counted below, are the difference between a green gate
and a gate that means something:

| Shape | n | What it looks like |
|---|---|---|
| `unwritten-case` | 89 | The named file exists (e.g. `never_regress.test.mjs`) but the named case was never written into it. The mapping's own `— Planned` marker usually admits this; the old rollup counted it as coverage anyway. |
| `reimplements-under-test` | 16 | The test re-implements the module in JavaScript and asserts its own copy. `metrics.test.mjs:3-6` says so in its header comment. Breaking `scripts/harness/metrics.py` leaves the gate green. |
| `self-referential` | 6 | The mapping names `tests/run_gate.sh` or `.github/workflows/ci.yml` as proof of a property *of that same file*. Editing the file edits the "test". |
| `asserts-own-fixtures` | 2 | The test iterates a `const` array declared 20 lines above and asserts the object literal written with a `brier` key has a `brier` key. Cannot fail under any production change. |
| `hardcoded-literal` | 2 | The test compares committed data against a literal pasted into the test file. Renaming the thing in the source of truth changes nothing (`signal_registry.test.mjs:16` vs `scripts/signals/registry.py`). |
| `validator-lacks-the-check` | 1 | `scripts/validate_data.py` is named, exists, and runs — but does not perform the check the AC describes (`check_pipeline_health` never reads `rows`). |
| `no-formatting-check` | 1 | P5-S6-AC2 pins canonical JSON writes to `smoke.sh` + `validate_data.py`; neither inspects formatting. |
| `stale-and-unasserted` | 1 | P5-S4-AC3 asserts a fact about the committed file that is no longer true, and nothing checks it either way. |

## Method (so the number is reproducible)

Measured on **2026-08-15** against the working tree, in three passes:

1. **Parse.** Every line in `epics/*.md` matching `- <STORY>-AC<n> → …` — **309 mappings across 87
   stories in 16 epics.** Extract every repo path token on the right-hand side (`tests/…`,
   `scripts/…`, `app/…`, `data/…`, `.github/…`, plus bare `sw.js` / `_headers`), stripping the
   `(unit)` / `(data/unit)` type annotations so they are not mistaken for paths.
2. **Existence.** `os.path.exists` on each artifact. A mapping with no surviving artifact is
   **MISSING**: **160 mappings, naming 59 distinct files that do not exist.**
3. **Bite.** For the 137 mappings whose file does exist, check whether the named `::case` appears in
   the file (under `_`/`-`/space normalisations — deliberately generous, because the docs use
   pseudo-identifiers like `at_least_three_per_game` for a test actually titled
   `">= 3 parlays scope='game' for EVERY game on the slate"`). Every mapping the doc marks `— Done`,
   plus every mapping whose case name did resolve, was then **read** and judged by hand. The rule was
   *when in doubt, call it REAL* — so 18 is a ceiling-biased count, not a pessimistic one.

The classification of all 309 mappings lives inline in the epic files: each mapping line now ends in
**[REAL]**, **[MISSING]**, **[TOOTHLESS · shape]** or **[MANUAL]**.

## Aggregate — measured

- **16 epics · 87 user stories · 309 acceptance criteria.**
- **REAL: 18.** **MISSING: 160.** **TOOTHLESS: 119.** **MANUAL: 12.**
- **True coverage: 18/297 automatable ACs = 6.1%** (18/309 = 5.8% including manual ACs).
- **249 of 309 ACs (81%) have no test written at all** — 160 where the file is absent, 89 where the
  file exists but the case was never added to it.
- **0 of 87 stories meet the ≥90% standard.** The highest are **P1-S5 and P6-S2 at 67%**. **62 of 87
  stories are at 0%.**
- Nine stories carry `Status: ✅`. **Seven have zero REAL coverage**: P5-S4, P6-S1, P7-S2, P7-S3,
  P8-S3, P9-S4, P9-S6. The other two — P6-S2 (2/3) and P8-S1 (1/4) — are partial.

### The sharpest instances

| Claim | Reality |
|---|---|
| N3 (Game Model) — 6 stories, every one "100%" | 16 of 20 ACs point at `tests/feature/game_model.test.mjs`, which does not exist. Nothing anywhere executes `scripts/models/game_model.py`. **True: 0/20.** |
| P3 (Ensemble) — "4×100%, 1×75%" | 16 of 18 ACs point at `tests/feature/ensemble.test.mjs`. Neither the test nor any ensemble module exists. **True: 0/18.** |
| N4 (Parlay Builder) — "100%", `parlay_rules` named as the enforcer | `parlay_rules.test.mjs` exists and genuinely asserts the ≥3-per-game / ≥3-per-week floors. It asserts **none** of the edge definition, the correlation adjustment, the correlation-adjusted EV, or the tier ordinal. **True: 2/14.** |
| P7-S3 + P9-S6 — both ✅ at "4/4 = 100%" | Nothing in the repo asserts `sw.js` has no `fetch` handler, and **no test reads `_headers` at all**. The one SW test (`tests/pwa/standalone.spec.mjs:363`) asserts `navigator.serviceWorker.ready` resolves — it would pass against a full precaching worker. This is the wc2026 stale-shell postmortem, unguarded. **True: 0/4 and 0/4.** |
| P1-S2/S3 — all Done | `metrics.test.mjs` and `conformal.test.mjs` re-implement `scripts/harness/{metrics,conformal}.py` in JS and score their own copies. The Python is never executed by any test. `conformal.py` is imported by no pipeline script at all (`scripts/build_all.py:395`). **True: 0/5 and 0/5.** |
| P4-S3-AC2 — "a renamed signal in `registry.py` fails the test until `meta.json` matches", Done | `signal_registry.test.mjs:16` compares `meta.json` against an `EXPECTED` list pasted into the test file and never reads `registry.py`. There is a *second* hardcoded mirror at `scripts/validate_data.py:118-130` (`EXPECTED_SIGNALS`). Renaming a signal reds nothing. **TOOTHLESS.** |
| P1-S4-AC2 / P8-S1-AC2 — the estimate-vs-measured rule, Done | Both name `backtest_honesty.test.mjs:74`, which filters the file's own `HONEST` literal and asserts the row written *with* `brier` has `brier`. The rule's real enforcer, `scripts/harness/honesty.py`, is imported by nothing outside its own package. **TOOTHLESS.** |
| P5-S6-AC2 — canonical JSON writes, Done | `smoke.sh` only `json.load()`s each file; `validate_data.py` has no byte-level check. Re-serialising with `ensure_ascii=True, indent=2` + trailing newline: **11 of 36 `data/*.json` already deviate** (35 of 36 if the AC's `sort_keys=True` is taken literally, which contradicts `CLAUDE.md:137`). **TOOTHLESS.** |
| P8-S5-AC1 — "a feed reporting zero rows fails the gate" | `check_pipeline_health` (`validate_data.py:689`) compares `health` against the per-feed statuses and never reads `rows`. `data/pipeline_status.json` ships `kalshi` and `espn_results_2026` at `rows: 0, status: "ok"` and the gate is green. **TOOTHLESS.** |
| P5-S4-AC3 — "`health` is honestly `degraded` (not `ok`) and at least one feed is non-ok" | Committed `data/pipeline_status.json` today: `health: "ok"`, all 18 feeds `ok`. The AC is now factually wrong about the file, and `smoke.sh` — named as the enforcer — asserts only that `health` *mirrors* the worst feed, never that it is `degraded`. **TOOTHLESS, and the AC text is stale.** |

## Per-epic rollup — measured

`True` is REAL ÷ (ACs − manual ACs).

| Epic | Stories | ACs | REAL | MISSING | TOOTHLESS | MANUAL | True | Previously claimed |
|---|---|---|---|---|---|---|---|---|
| P1 · Evaluation Harness | 5 | 20 | 3 | 2 | 15 | 0 | **15%** | 100% |
| P2 · Optimizer & NEVER REGRESS | 6 | 24 | 0 | 0 | 23 | 1 | **0%** | 5×100%, 1×75% |
| P3 · Multi-Model Ensemble | 5 | 18 | 0 | 16 | 1 | 1 | **0%** | 4×100%, 1×75% |
| P4 · Signal Registry | 5 | 17 | 3 | 4 | 10 | 0 | **18%** | 100% |
| P5 · Pipeline & Feed Health | 6 | 20 | 2 | 14 | 3 | 1 | **11%** | 5×100%, 1×67% |
| P6 · JSON Contract & Data Layer | 5 | 17 | 2 | 13 | 1 | 1 | **12%** | 100% |
| P7 · PWA Shell & Design System | 6 | 23 | 1 | 13 | 8 | 1 | **5%** | 5×100%, 1×75% |
| P8 · Backtest Honesty & Governance | 5 | 18 | 3 | 2 | 12 | 1 | **18%** | 100% |
| P9 · Deploy & Ops | 6 | 22 | 0 | 16 | 2 | 4 | **0%** | 100% |
| P10 · LLM-as-Signal | 5 | 19 | 0 | 11 | 7 | 1 | **0%** | 100% |
| N1 · NFL Data Sources | 6 | 18 | 0 | 14 | 4 | 0 | **0%** | 100% |
| N2 · Player Projection Engine | 6 | 19 | 0 | 14 | 5 | 0 | **0%** | 100% |
| N3 · Game Model & Weekly Winners | 6 | 20 | 0 | 16 | 4 | 0 | **0%** | 100% |
| N4 · Parlay Builder | 4 | 14 | 2 | 0 | 12 | 0 | **14%** | 100% |
| N5 · NFL UI | 6 | 22 | 2 | 13 | 7 | 0 | **9%** | 100% |
| N6 · Live Scores Edge | 5 | 18 | 0 | 12 | 5 | 1 | **0%** | 4×100%, 1×75% |
| **Total** | **87** | **309** | **18** | **160** | **119** | **12** | **6.1%** | *"all 87 stories ≥90%"* |

## Per-story — measured

`Declared` is the figure the story's own `Coverage:` line carried before this rewrite.

| Story | Status | Declared | REAL | MISSING | TOOTHLESS | MANUAL | True |
|---|---|---|---|---|---|---|---|
| P1-S1 | 🟡 | 4/4 = 100% | 1 | 2 | 1 | 0 | **1/4 = 25%** |
| P1-S2 | 🟡 | 5/5 = 100% | 0 | 0 | 5 | 0 | **0/5 = 0%** |
| P1-S3 | 🟡 | 5/5 = 100% | 0 | 0 | 5 | 0 | **0/5 = 0%** |
| P1-S4 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| P1-S5 | 🟡 | 3/3 = 100% | 2 | 0 | 1 | 0 | **2/3 = 67%** |
| P2-S1 | 🟡 | 4/4 = 100% | 0 | 0 | 4 | 0 | **0/4 = 0%** |
| P2-S2 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| P2-S3 | 🟡 | 4/4 = 100% | 0 | 0 | 4 | 0 | **0/4 = 0%** |
| P2-S4 | 🟡 | 5/5 = 100% | 0 | 0 | 5 | 0 | **0/5 = 0%** |
| P2-S5 | 🟡 | 4/4 = 100% | 0 | 0 | 4 | 0 | **0/4 = 0%** |
| P2-S6 | ⬜ | 3/4 = 75% | 0 | 0 | 3 | 1 | **0/3 = 0%** |
| P3-S1 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P3-S2 | 🟡 | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P3-S3 | 🟡 | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P3-S4 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P3-S5 | ⬜ | 3/4 = 75% | 0 | 2 | 1 | 1 | **0/3 = 0%** |
| P4-S1 | 🟡 | 4/4 = 100% | 1 | 0 | 3 | 0 | **1/4 = 25%** |
| P4-S2 | 🟡 | 3/3 = 100% | 1 | 0 | 2 | 0 | **1/3 = 33%** |
| P4-S3 | 🟡 | 3/3 = 100% | 1 | 0 | 2 | 0 | **1/3 = 33%** |
| P4-S4 | ⬜ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P4-S5 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| P5-S1 | 🟡 | 4/4 = 100% | 1 | 3 | 0 | 0 | **1/4 = 25%** |
| P5-S2 | 🟡 | 2/3 = 67% | 0 | 2 | 0 | 1 | **0/2 = 0%** |
| P5-S3 | 🟡 | 4/4 = 100% | 1 | 3 | 0 | 0 | **1/4 = 25%** |
| P5-S4 | ✅ | 3/3 = 100% | 0 | 1 | 2 | 0 | **0/3 = 0%** |
| P5-S5 | ⬜ | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P5-S6 | 🟡 | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| P6-S1 | ✅ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P6-S2 | ✅ | — | 2 | 1 | 0 | 1 | **2/3 = 67%** |
| P6-S3 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P6-S4 | ⬜ | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| P6-S5 | ⬜ | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P7-S1 | 🟡 | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| P7-S2 | ✅ | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P7-S3 | ✅ | 4/4 = 100% | 0 | 2 | 2 | 0 | **0/4 = 0%** |
| P7-S4 | ⬜ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P7-S5 | ⬜ | 4/4 = 100% | 1 | 0 | 3 | 0 | **1/4 = 25%** |
| P7-S6 | ⬜ | — | 0 | 1 | 2 | 1 | **0/3 = 0%** |
| P8-S1 | ✅ | 4/4 = 100% | 1 | 0 | 3 | 0 | **1/4 = 25%** |
| P8-S2 | 🟡 | 4/4 = 100% | 1 | 0 | 3 | 0 | **1/4 = 25%** |
| P8-S3 | ✅ | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| P8-S4 | ⬜ | 4/4 = 100% | 0 | 2 | 1 | 1 | **0/3 = 0%** |
| P8-S5 | 🟡 | 3/3 = 100% | 1 | 0 | 2 | 0 | **1/3 = 33%** |
| P9-S1 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P9-S2 | ⬜ | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| P9-S3 | 🟡 | — | 0 | 4 | 0 | 1 | **0/4 = 0%** |
| P9-S4 | ✅ | 2/2 = 100% | 0 | 0 | 2 | 1 | **0/2 = 0%** |
| P9-S5 | 🟡 | 2/2 = 100% | 0 | 2 | 0 | 2 | **0/2 = 0%** |
| P9-S6 | ✅ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P10-S1 | ⬜ | 4/4 = 100% | 0 | 2 | 2 | 0 | **0/4 = 0%** |
| P10-S2 | ⬜ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| P10-S3 | ⬜ | 4/4 = 100% | 0 | 2 | 2 | 0 | **0/4 = 0%** |
| P10-S4 | ⬜ | 3/3 = 100% | 0 | 1 | 2 | 0 | **0/3 = 0%** |
| P10-S5 | ⬜ | 3/4 = 100% | 0 | 2 | 1 | 1 | **0/3 = 0%** |
| N1-S1 | 🟡 | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| N1-S2 | 🟡 | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| N1-S3 | 🟡 | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| N1-S4 | 🟡 | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| N1-S5 | 🟡 | 2/2 = 100% | 0 | 2 | 0 | 0 | **0/2 = 0%** |
| N1-S6 | 🟡 | 2/2 = 100% | 0 | 1 | 1 | 0 | **0/2 = 0%** |
| N2-S1 | 🟡 | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| N2-S2 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N2-S3 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N2-S4 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N2-S5 | 🟡 | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| N2-S6 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| N3-S1 | 🟡 | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| N3-S2 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N3-S3 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N3-S4 | 🟡 | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| N3-S5 | 🟡 | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N3-S6 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| N4-S1 | 🟡 | 4/4 = 100% | 2 | 0 | 2 | 0 | **2/4 = 50%** |
| N4-S2 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| N4-S3 | 🟡 | 4/4 = 100% | 0 | 0 | 4 | 0 | **0/4 = 0%** |
| N4-S4 | 🟡 | 3/3 = 100% | 0 | 0 | 3 | 0 | **0/3 = 0%** |
| N5-S1 | 🟡 | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |
| N5-S2 | 🟡 | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| N5-S3 | 🟡 | 4/4 = 100% | 0 | 0 | 4 | 0 | **0/4 = 0%** |
| N5-S4 | 🟡 | 4/4 = 100% | 1 | 3 | 0 | 0 | **1/4 = 25%** |
| N5-S5 | ⬜ | 3/3 = 100% | 1 | 1 | 1 | 0 | **1/3 = 33%** |
| N5-S6 | ⬜ | 4/4 = 100% | 0 | 4 | 0 | 0 | **0/4 = 0%** |
| N6-S1 | ⬜ | — | 0 | 2 | 1 | 1 | **0/3 = 0%** |
| N6-S2 | ⬜ | 3/3 = 100% | 0 | 3 | 0 | 0 | **0/3 = 0%** |
| N6-S3 | ⬜ | 4/4 = 100% | 0 | 3 | 1 | 0 | **0/4 = 0%** |
| N6-S4 | ⬜ | 4/4 = 100% | 0 | 2 | 2 | 0 | **0/4 = 0%** |
| N6-S5 | ⬜ | 3/3 = 100% | 0 | 2 | 1 | 0 | **0/3 = 0%** |

## The 18 REAL mappings, in full

These are the acceptance criteria the gate actually protects. Everything else in this backlog is
unguarded until [`epics/QA-debt.md`](./epics/QA-debt.md) is worked.

| AC | Asserted by |
|---|---|
| N4-S1-AC1, N5-S4-AC3 | `tests/feature/parlay_rules.test.mjs:33` — derives the slate from `data/game_predictions.json` and counts `data/parlays.json`; also in `tests/smoke.sh` core invariants. |
| N4-S1-AC2 | `tests/feature/parlay_rules.test.mjs:57` — ≥3 week-scope parlays in committed data; also `smoke.sh`. |
| P1-S1-AC3, P1-S5-AC1 | `scripts/validate_data.py` `main()`:1237-1253 — walks `data/snapshots/`, routes each file through `snapshot_schema_for` + `validate_against_schema`, exits non-zero on violation. Gate step 1. |
| P1-S5-AC2, P8-S1-AC4 | `tests/feature/backtest_honesty.test.mjs:85` — reads the real `data/game_predictions.json`, asserts every game is `estimate:true` with no scores. |
| P4-S1-AC2, P4-S2-AC1 | `tests/feature/signal_registry.test.mjs:38` — reads the real `data/meta.json`, asserts all 32 signals present at exactly 0.0. |
| P4-S3-AC1 | `tests/feature/signal_registry.test.mjs:54` — `Object.keys(meta.weights).length === 32` against the real file. |
| P5-S1-AC4 | `tests/smoke.sh:35-56` — invokes 21 pipeline modules with `--selftest` and no pip install; a hard top-level `nfl_data_py` import would red it. |
| P5-S3-AC4 | `scripts/validate_data.py` — `pipeline_status.schema.json` is in `SCHEMA_MAP`; `_validate` implements required/enum/type/`additionalProperties`/minimum. |
| P6-S2-AC1 | `scripts/validate_data.py` exits 0 on a clean tree; `run_gate.sh` step 1 gates on that exit code. |
| P6-S2-AC4 | `validate_data.py:1257,1262` calls `check_meta_weights` + `check_pipeline_health`; either raising exits non-zero. **Note:** the mapping *also* names `tests/feature/validate_data.test.mjs`, which does not exist — this is the only REAL verdict resting on one of two named artifacts. The substance is asserted by the validator that runs; the second artifact is debt (QA-D7). |
| P8-S2-AC4 | **Misnamed but covered** — `signal_registry.test.mjs` has no `new signals enter at weight 0` case, but `smoke.sh` asserts *every* key in `meta.weights` is 0.0, so a new signal entering non-zero reds the gate. |
| P8-S5-AC3 | `tests/smoke.sh:59-64` parses every `data/**/*.json`; a half-written file from a raced merge fails there. (The race-safe merge *procedure* itself is unasserted — the story marks that half Planned.) |
| N5-S5-AC1, P7-S5-AC4 | **Misnamed but covered** — `tests/feature/contrast_aa.test.mjs:213` imports the real `TEAMS` from `app/teams.js` and asserts every tint clears 3.0:1 on `--surface`; `:286` asserts every tint is valid hex. |

## Regression-gate → test-type mapping

The gate runs in order and gates on **exit codes** (`tests/run_gate.sh`):

| Gate step | Command | Covers |
|---|---|---|
| 1 | `python3 scripts/validate_data.py` | `data` — every `data/*.json` valid vs its schema; cross-file honesty invariants |
| 2 | `bash tests/smoke.sh` | `smoke` — files exist, JSON parses, core invariants, 21 pipeline module selftests |
| 3 | `node --test tests/feature/*.mjs` | `unit` + `contrast` + `backtest` |
| 4 | `npx playwright test` (web + pwa projects) | `e2e-web` + `e2e-pwa` — **opt-in**: skipped, not failed, when `@playwright/test` is absent |

Two caveats a reader should carry:

- **Step 4 is skipped-not-failed on a clean box.** `run_gate.sh:66-74` prints a loud banner and
  `GATE RESULT: PASS (green)` anyway. That is a deliberate zero-dependency design, but it means a
  local green is not an E2E green. Not a coverage defect in itself — noted so nobody reads it as one.
- **The schema validator implements a subset.** `_validate` (`validate_data.py:181`) handles type/enum/minimum/
  maximum/required/properties/additionalProperties/items/minItems/maxItems. `minProperties`,
  `maxProperties`, `pattern`, `minLength`, `exclusiveMinimum`/`exclusiveMaximum` fall through
  silently, so those constraints in 12 contract files are decorative today (R30,
  `pipeline-contracts-unimplemented-schema-keywords`). Mappings leaning on `validate_data.py` are
  counted REAL only where the AC's own text names a keyword the validator does implement.

## Roadmap QA_CASES documents — checked, no correction needed

The same existence check was run over `../roadmap/*/QA_CASES.md`. Those documents are **test-first
specifications**, not coverage claims, and they say so: `phase0/QA_CASES.md:3` is
`Status: SPEC (test-first)` with `[BLOCKED-until-substrate]` tags; `rel19/QA_CASES.md:8` says
"Design-only artifact". They name five test paths that do not exist —
`tests/feature/{ros-value,ros-backtest-honesty,components_reconcile}.test.mjs`,
`tests/ux/ros.spec.mjs`, `tests/competition.test.mjs` — and `rel19` explicitly flags
`tests/competition.test.mjs` as absent in its own gate header. No false claim to correct there.

## How to verify a claim

Open the epic file, find the story ID (e.g. `N4-S3`), read its `QA coverage` block. Each mapping
line now ends in its measured verdict. Only **[REAL]** means the gate protects that criterion; every
other tag means it does not, and names why. The story's `Coverage (measured …)` line gives the
story's true fraction.

To re-derive the whole table after writing tests, re-run the three passes in **Method** above. The
verdicts in the epic files should be regenerated from the filesystem, not hand-edited — a
hand-maintained coverage number is exactly what produced the defect this page corrects.
