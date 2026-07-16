# NFL2026 Backlog — and the Prediction-Platform Framework

This directory is two things at once:

1. **The Gate-3 backlog for NFL2026** — epics → user stories → tasks, each with acceptance
   criteria and ≥90% QA coverage.
2. **A reusable framework.** The backlog is split into a **Platform layer** (domain-agnostic
   epics — the actual framework) and an **NFL Adapter layer** (this season's instantiation). A
   future project — NBA, MLB, an F1 revival, or a Kalshi/Polymarket markets adapter — lifts the
   Platform epics wholesale and re-authors only the Adapter epics. See
   [the reuse playbook](#reuse-playbook-standing-up-a-new-adapter).

It is also a **design history**: every epic and story carries an honest status tag, so this doubles
as the record of what the initial build actually delivered vs. what is planned. The dated decision
log lives in [`DECISIONS.md`](./DECISIONS.md).

## Status legend
`✅ Done` · `🟡 Partial` (skeleton/scaffold exists, not yet fed by real data) · `⬜ Planned`

> **Branch note:** this backlog is based on `main`. The **design system + wired views** (epics P7 and
> N5) were built and CI-verified in **PR #1**, now **merged to `main`** — so those files are present on
> `main`. The P7/N5 epics carry a banner; some story statuses drafted pre-merge still read ⬜/🟡 and
> should be read as ✅ delivered. Everything else reflects the current `main` tree.

## The two layers

### Platform (P#) — the framework, reusable across domains
| Epic | Status | What it is |
|---|---|---|
| [P1 · Evaluation Harness](./epics/P1-evaluation-harness.md) | 🟡 | Point-in-time snapshots, event-level metrics (log-loss/Brier/MAE/calibration), split-conformal safe sets. The platform's #1 asset. |
| [P2 · Weight Optimizer & NEVER REGRESS](./epics/P2-optimizer-never-regress.md) | 🟡 | Walk-forward leak-safe fitting, shrinkage, margin-gated (0.0015) adoption; signals enter at weight 0. |
| [P3 · Multi-Model Ensemble](./epics/P3-ensemble.md) | 🟡 | In-house + market + fitted hybrid + refit-on-cron stacker; full-probability-vector blending, never point-pick averaging. |
| [P4 · Signal Registry & Contribution](./epics/P4-signal-registry.md) | 🟡 | Named signals that enter at 0.0 and earn weight only via the optimizer; wire end-to-end or don't build it. |
| [P5 · Data Pipeline & Feed Health](./epics/P5-pipeline-feed-health.md) | 🟡 | Scrapers → compute → versioned JSON; loud row-count/staleness assertions; honest `pipeline_status.json`. |
| [P6 · JSON Contract & Frontend Data Layer](./epics/P6-json-contract-data-layer.md) | ✅ | Schema-validated JSON contract decoupling model iteration from the frontend; one client-side reader. |
| [P7 · PWA Shell & Design System](./epics/P7-pwa-design-system.md) | ✅ | Vanilla-JS no-build installable PWA; tokenized, theme-swappable design system; WCAG-AA enforced by test. |
| [P8 · Backtest Honesty & Governance](./epics/P8-backtest-honesty.md) | 🟡 | Estimate-vs-measured enforced by tests; baseline gates; regression gate on exit codes; prototype quarantine. |
| [P9 · Deploy & Ops](./epics/P9-deploy-ops.md) | 🟡 | Netlify/Vercel deploy, GitHub-Actions crons, race-safe merges, rollback-before-deploy, verify-on-prod. |
| [P10 · LLM-as-Signal (empirically gated)](./epics/P10-llm-signal.md) | ⬜ | Unstructured context (coaching/off-field) → numeric signal, quarantined, promoted only on proven lift. |

### NFL Adapter (N#) — this season's instantiation
| Epic | Status | Instantiates | What it is |
|---|---|---|---|
| [N1 · NFL Data Sources](./epics/N1-nfl-data-sources.md) | 🟡 | P5, P6 | nflverse (gsis_id canonical) + ESPN + Odds API/Kalshi + Open-Meteo; free-tier budgeted; guarded imports. |
| [N2 · Player Projection Engine](./epics/N2-player-projection.md) | 🟡 | P3, P4 | Baseline × position age curve × signals → points + conformal interval; OL/DL, targets, matchups, weather. |
| [N3 · Game Model & Weekly Winners](./epics/N3-game-model.md) | 🟡 | P3 | Elo + market + composite → full win-prob vector; weekly winners ranked by model vs implied. |
| [N4 · Parlay Builder](./epics/N4-parlay-builder.md) | 🟡 | P3 | ≥3 parlays per game & per week; correlation-aware same-game legs; EV + conformal tier. |
| [N5 · NFL UI (Slate / Players / Parlays / Live)](./epics/N5-nfl-ui.md) | 🟡 | P7 | The three wired views; team identity tints (AA-safe); honest estimate/day-zero/degraded states. |
| [N6 · Live Scores Edge](./epics/N6-live-scores.md) | ⬜ | P5, P9 | Vercel `/api/nfl` (ESPN), STATUS-gating (only FINAL counts), RENAMES kept in sync. |

## Conventions

- **IDs are stable and unique.** Story `P1-S2`, its criteria `P1-S2-AC1…`, its tasks `P1-S2-T1…`.
  The [QA matrix](./QA_COVERAGE.md) references these.
- **Every acceptance criterion is objectively verifiable** — Given/When/Then, with numbers
  (log-loss margins, coverage %, contrast ratios, row-count/staleness thresholds, ≥3 parlays/game).
- **QA coverage standard: ≥90%** of each story's acceptance criteria map to at least one named
  automated test. Genuinely manual-only ACs (e.g. a deploy rollback drill) are flagged as such and
  excluded from the denominator; the automatable remainder still clears 90%.
- **Test types:** `unit` (node:test) · `data` (`validate_data.py`) · `smoke` (bash) · `e2e-web` /
  `e2e-pwa` (Playwright) · `contrast` (WCAG-AA) · `backtest` (leak-safe) · `manual`.
- **Traceability:** every story names the real files it touches, so the backlog maps onto the code.

## Reuse playbook: standing up a new adapter

The framework thesis (from `docs/PLATFORM_THESIS.md`): **the evaluation harness is the product;
models are plug-ins.** To start `NBA2027` (or a markets adapter):

1. **Fork the Platform epics unchanged.** P1–P10 are domain-agnostic. Their code
   (`scripts/harness`, `scripts/optimize`, the JSON-contract + data-layer, the PWA shell/design
   system, the regression gate, the honesty tests) is the framework — copy it.
2. **Re-skin, don't rebuild, the UI (P7).** Swap the design tokens in `app/theme.css` and the
   brand; the shell, router, contract reader, AA test, and web/PWA test harness carry over.
3. **Author only the Adapter epics (N#).** For each new sport/market, write the equivalents of
   N1 (data sources + canonical entity key), N2/N3/N4 (the domain models), N5 (domain views), N6
   (live source + status-gating rules). Keep the JSON contract shape; change only its contents.
4. **Register domain signals at weight 0** (P4) and let the optimizer (P2) earn them in — never
   hand-set. Archive point-in-time snapshots from day one (P1) — the single biggest regret if skipped.
5. **Keep the gates.** Regression on exit codes, estimate-vs-measured honesty, NEVER REGRESS,
   baseline-beat, feed-health, rollback-before-deploy. These are the framework's guardrails.

## Related design docs
- [`DECISIONS.md`](./DECISIONS.md) — dated decision log (Gate 1 architecture, Gate 2 design, invariants).
- [`QA_COVERAGE.md`](./QA_COVERAGE.md) — the aggregate acceptance-criteria → test coverage matrix.
- `../PLATFORM_THESIS.md` · `../ARCHITECTURE.md` · `../EVALUATION_HARNESS.md` · `../SIGNAL_REGISTRY.md` · `../ROADMAP.md`
