# NFL2026 Backlog — QA Coverage Matrix

The Gate-3 standard: **≥90% of every story's acceptance criteria map to at least one named automated
test.** Genuinely manual-only ACs (deploy/rollback drills, a live third-party API call, a doc review)
are flagged in their story and excluded from the denominator; the automatable remainder still clears
90%. Each epic file carries its own per-story `QA coverage` block with the exact AC→test mapping — this
page is the rollup.

## Aggregate

- **16 epics · 87 user stories.**
- **82 stories at 100%** automated AC coverage.
- **5 stories at 67–75% raw**, each carrying exactly **one genuinely-manual AC** (see below). Excluding
  those manual-only ACs per the Gate-3 rule, their automatable coverage is **100%** — so **all 87
  stories meet the ≥90% standard**.

### The 5 stories with a manual AC
| Story | Raw | The manual AC |
|---|---|---|
| P2-S6 | 75% | Deploy/adoption rollback drill (ops). |
| P3-S5 | 75% | Stacker refit promoted to prod — deploy confirmation (ops). |
| P5-S2 | 67% | Removing `\|\| true` masking in live workflows — verified on a real cron run. |
| P7-S6 | 75% | Re-skin/token-extraction doc review (framework-reuse doc). |
| N6-S1 | 75% | Live ESPN edge call against a real game window (third-party, game-day). |

## Per-epic rollup

| Epic | Stories | Story-level automated AC coverage | Dominant test types | Enforced by |
|---|---|---|---|---|
| P1 · Evaluation Harness | 5 | 100% | unit · backtest · data | gate 3 (`node --test`), gate 1 (`validate_data`) |
| P2 · Optimizer & NEVER REGRESS | 6 | 5×100%, 1×75%¹ | unit (`never_regress`) · backtest | gate 3 |
| P3 · Multi-Model Ensemble | 5 | 4×100%, 1×75%¹ | unit · backtest | gate 3 |
| P4 · Signal Registry | 5 | 100% | unit (`signal_registry`) · data | gate 3, gate 1 |
| P5 · Pipeline & Feed Health | 6 | 5×100%, 1×67%¹ | unit · data · smoke | gate 1–3 |
| P6 · JSON Contract & Data Layer | 5 | 100% | data · unit · e2e | gate 1, gate 4 |
| P7 · PWA Shell & Design System | 6 | 5×100%, 1×75%¹ | contrast · e2e-web · e2e-pwa · unit | gate 3–4 |
| P8 · Backtest Honesty & Governance | 5 | 100% | unit (`backtest_honesty`) · smoke · data | gate 1–3 |
| P9 · Deploy & Ops | 6 | 100%² | smoke · data · manual | gate 1–4 |
| P10 · LLM-as-Signal | 5 | 100%² | unit · backtest · manual | gate 3 (proto) |
| N1 · NFL Data Sources | 6 | 100%² | unit · data · manual (free-tier) | gate 1–3 |
| N2 · Player Projection Engine | 6 | 100% | unit · backtest | gate 3 |
| N3 · Game Model & Weekly Winners | 6 | 100% | unit · backtest | gate 3 |
| N4 · Parlay Builder | 4 | 100% | unit (`parlay_rules`) | gate 3 |
| N5 · NFL UI | 6 | 100% | e2e-web · e2e-pwa · contrast · unit | gate 3–4 |
| N6 · Live Scores Edge | 5 | 4×100%, 1×75%¹ | unit · manual | gate 3 |

¹ the one manual AC in that story (table above). ² automatable ACs at 100%; some ops ACs are manual by
nature and excluded per the rule.

## Regression-gate → test-type mapping

The gate runs in order and gates on **exit codes** (`tests/run_gate.sh`):

| Gate step | Command | Covers |
|---|---|---|
| 1 | `python3 scripts/validate_data.py` | `data` — every `data/*.json` valid vs its schema; cross-file honesty invariants |
| 2 | `bash tests/smoke.sh` | `smoke` — files exist, JSON parses, core invariants |
| 3 | `node --test tests/feature/*.mjs` | `unit` + `contrast` + `backtest` — metrics, conformal, honesty, never-regress, signal registry, parlay rules, WCAG-AA |
| 4 | `npx playwright test` (web + pwa projects) | `e2e-web` + `e2e-pwa` — the browser and standalone-PWA experiences, independently |

`manual` ACs (deploy/rollback drills, live third-party calls, doc reviews) are **not** gated — they are
runbook items, flagged in-story and tracked here, and are the only ACs excluded from the ≥90% math.

## How to verify a claim
Open the epic file, find the story ID (e.g. `N4-S3`), read its `QA coverage` block — it names the test
file and case for each AC and marks it Done or Planned. `Done` tests are already green in the gate
(41 unit + 11 e2e as of PR #1); `Planned` tests are authored alongside the feature they cover.
