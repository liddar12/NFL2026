# NFL2026 modernization blueprint

**Prepared:** 8 September 2026. **Scope:** personal application with a reusable platform foundation. **Status:** proposed implementation architecture; a separate interactive design prototype is implemented. This package does not claim that the production fixes or shared services have shipped.

The priority is a dependable Sleeper companion. The architecture extends the existing vanilla JavaScript PWA, Netlify hosting, Python data pipelines and independent models. SelfLearning becomes the shared prediction record, evaluation and proposal engine through a read-only sports adapter first.

## Package

- [Solution architecture](01-solution-architecture.md): responsibilities, deployment boundaries, decisions and target service levels.
- [Technical architecture](02-technical-architecture.md): modules, contracts, storage, APIs, jobs, promotion and release mechanics.
- [Experience and UI specification](03-experience-design.md): navigation, screen behavior, states, tokens, accessibility and migration of existing features.
- [Implementation roadmap](04-roadmap.md): release sequence, estimates, dependencies, acceptance criteria and QA mapping.
- [Validation and handoff](05-validation-and-handoff.md): executed design checks and remaining production release gates.
- `contracts/`: proposed JSON schemas and illustrative records, validated as design examples, not deployed API contracts.
- SelfLearning companion: `docs/modernization-2026/sports-integration.md` in `liddar12/SelfLearning`.

The [private interactive prototype](https://nfl2026-next-design.j5lagenticst-8464.chatgpt.site) is an isolated, portable static site: HTML, CSS and ES modules. Its six screens demonstrate My League, Players, NFL, Research, Learning and league settings. All numbers and interactions are explicitly examples. It makes no live Sleeper, sportsbook or AI requests.

## Evidence baseline

The preceding review inspected NFL2026 at `e2721c7bca2301e7c2c6173a3b36a2c1c48f29e4` and SelfLearning at `49ece24573ca0d9870fcdbc8cd3c774d082593e9`, plus `https://nfl2026.netlify.app/`. Production's exact deploy SHA was not exposed. Findings F1-F10 below retain the identifiers in that review.

Five nonbrowser NFL gates passed, including 1,490 feature tests. The current browser suite was blocked by missing Chromium and failed downloads; historical CI passed 236 browser tests on September 3. SelfLearning had 102 passing core/shared-package tests and two power-backtest collection errors. These historical results are not a release certificate for future changes.

## Decisions made in this blueprint

1. Make My League the default destination after onboarding; preserve every existing route during migration.
2. Keep the no-bundler PWA and existing hosting boundaries. The prototype hosting is a design-review surface, not a hosting migration.
3. Repair scoring, market identity, confidence labels and locked history before expanding model complexity.
4. Require a verified combined payout before actionable parlay EV. Markets remain outside model features.
5. Start SelfLearning integration with replayable, read-only imports and score parity.
6. Recommend Supabase Postgres for the shared hosted record, using SQLite for local replay. Provisioning and migration are future work.
7. Let agents propose bounded experiments; keep model promotion explicit and auditable.
8. Use WC2026 as the next adapter candidate after NFL parity. Financial execution remains a separate system and is not enabled by this plan.

Architecture and design are supplied together because the user requested both and the implementation roadmap. Production rollout still requires a concrete green release candidate, rollback plan and the repository's deployment approval. This document is not authorization to apply a production migration or merge to main.
